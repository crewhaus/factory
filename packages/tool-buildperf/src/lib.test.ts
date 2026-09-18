import { describe, expect, test } from "bun:test";
/**
 * The behaviour of the pure functions under `./lib`.
 *
 * The statistical expectations are pinned to numbers computed elsewhere —
 * `@crewhaus/tool-math`'s kernel pins them against R and against a
 * brute-force enumeration, and this file pins what THIS package does with
 * them. The two that matter most are the ones a naive implementation gets
 * wrong: five samples per side must not produce a significance call, and
 * three failures in five runs must not produce "60%".
 */
import { statsKernel } from "@crewhaus/tool-math";
import { BenchError, compareBenchmark, compareBenchmarks } from "./lib/bench";
import { FlakyError, applyMasks, detectFlaky, runsForLowerBound } from "./lib/flaky";
import {
  MAX_GLOB_LENGTH,
  SizeError,
  baselineBasisMismatch,
  comparabilityKey,
  compileGlob,
  compressedSize,
  compressionParameters,
  globMatch,
  joinKey,
  looksLikeHash,
  parametersMismatch,
} from "./lib/size";

// --- size -------------------------------------------------------------------

describe("compressionParameters", () => {
  test("gzip defaults to level 9, which is what a published gzip size means", () => {
    expect(compressionParameters("gzip")).toMatchObject({ algorithm: "gzip", level: 9 });
  });

  test("brotli defaults to quality 11", () => {
    expect(compressionParameters("brotli")).toMatchObject({ algorithm: "brotli", level: 11 });
  });

  test("none has no level at all, rather than a level of zero", () => {
    expect(compressionParameters("none").level).toBeNull();
  });

  test("a brotli quality passed to gzip is refused, not clamped", () => {
    expect(() => compressionParameters("gzip", 11)).toThrow(SizeError);
    expect(() => compressionParameters("gzip", 11)).toThrow(/brotli qualities/);
  });

  test("a level on none is refused, because it would be recorded and not used", () => {
    expect(() => compressionParameters("none", 9)).toThrow(/does not compress/);
  });

  test("the settings below the level are pinned, not left to the library default", () => {
    expect(compressionParameters("gzip").tuning).toMatchObject({ memLevel: 8, windowBits: 15 });
    expect(compressionParameters("brotli").tuning["lgwin"]).toBe(22);
  });
});

describe("comparability", () => {
  test("the key names every setting that moves the byte count", () => {
    expect(comparabilityKey(compressionParameters("gzip", 6))).toBe(
      "gzip/level=6/memLevel=8,strategy=0,windowBits=15",
    );
  });

  test("identical parameters compare", () => {
    expect(
      parametersMismatch(compressionParameters("gzip"), compressionParameters("gzip")),
    ).toBeNull();
  });

  test("a different level is refused and the reason says so", () => {
    const why = parametersMismatch(
      compressionParameters("gzip", 6),
      compressionParameters("gzip", 9),
    );
    expect(why).toContain("level 6");
    expect(why).toContain("level 9");
  });

  test("a different algorithm is refused", () => {
    expect(
      parametersMismatch(compressionParameters("gzip"), compressionParameters("brotli")),
    ).toContain("different measurements");
  });

  test("a difference below the level is refused too", () => {
    const tampered = { ...compressionParameters("gzip"), tuning: { memLevel: 9 } };
    expect(parametersMismatch(tampered, compressionParameters("gzip"))).toContain("memLevel");
  });
});

describe("compressedSize", () => {
  // This is the whole justification for refusing a cross-level comparison: the
  // gap between two levels is the same order as the regression being hunted.
  const payload = Buffer.from("export const value = 'hello world';\n".repeat(400));

  test("two gzip levels give different sizes for the same bytes", () => {
    const low = compressedSize(payload, compressionParameters("gzip", 1));
    const high = compressedSize(payload, compressionParameters("gzip", 9));
    expect(low).not.toBe(high);
  });

  test("compressing makes this payload smaller, under both algorithms", () => {
    expect(compressedSize(payload, compressionParameters("gzip"))).toBeLessThan(payload.byteLength);
    expect(compressedSize(payload, compressionParameters("brotli"))).toBeLessThan(
      payload.byteLength,
    );
  });

  test("none reports the raw length", () => {
    expect(compressedSize(payload, compressionParameters("none"))).toBe(payload.byteLength);
  });
});

describe("looksLikeHash", () => {
  test("recognises the shapes bundlers emit", () => {
    expect(looksLikeHash("4f2a1c")).toBe(true); // webpack [contenthash:6]
    expect(looksLikeHash("BXaGz2Qm")).toBe(true); // Vite base64url
    expect(looksLikeHash("a1b2c3d4e5f6")).toBe(true);
  });

  test("leaves real name segments alone", () => {
    for (const name of ["chunk", "min", "esm", "vendor", "index", "worker"]) {
      expect(looksLikeHash(name)).toBe(false);
    }
  });

  test("a mixed-alphabet segment under 8 characters is a name, not a hash", () => {
    expect(looksLikeHash("app2x")).toBe(false);
  });

  test("the known false positive is a word that is also hex", () => {
    // `decade` is six hex characters. Nothing distinguishes it from a short
    // contenthash, which is why every entry reports the key it joined on.
    expect(looksLikeHash("decade")).toBe(true);
  });
});

describe("joinKey", () => {
  test("exact joins on the path as written", () => {
    expect(joinKey("dist/app-BXaGz2Qm.js", "exact")).toEqual({
      key: "dist/app-BXaGz2Qm.js",
      normalized: false,
    });
  });

  test("auto strips a hyphen-separated hash", () => {
    expect(joinKey("dist/app-BXaGz2Qm.js", "auto").key).toBe("dist/app-[hash].js");
  });

  test("auto strips a dot-separated hash", () => {
    expect(joinKey("dist/app.4f2a1c.js", "auto").key).toBe("dist/app.[hash].js");
  });

  test("auto leaves a name that merely looks segmented", () => {
    expect(joinKey("dist/vendor-chunk.min.js", "auto")).toEqual({
      key: "dist/vendor-chunk.min.js",
      normalized: false,
    });
  });

  test("a filename that is only a hash keeps its identity", () => {
    // Blanking the stem would merge every hash-named file into one row.
    expect(joinKey("dist/4f2a1c.js", "auto").key).toBe("dist/4f2a1c.js");
  });

  test("the directory is never normalised, only the basename", () => {
    expect(joinKey("assets/4f2a1c/app.js", "auto").key).toBe("assets/4f2a1c/app.js");
  });

  test("custom applies the caller's own scheme", () => {
    expect(joinKey("dist/app~v17.js", "custom", /~v\d+/g).key).toBe("dist/app[hash].js");
  });

  test("custom without a pattern is a refusal, not a silent passthrough", () => {
    expect(() => joinKey("a.js", "custom")).toThrow(SizeError);
  });
});

describe("baselineBasisMismatch", () => {
  test("a gzip baseline whose entries carry no compressed size is a mismatch, not a fallback", () => {
    const why = baselineBasisMismatch("gzip", [{ path: "dist/app.js", bytes: 14_400 } as never]);
    expect(why).toContain("compressedBytes");
    expect(why).toContain("dist/app.js");
  });

  test("a compressed column under algorithm none is the same mistake mirrored", () => {
    expect(
      baselineBasisMismatch("none", [{ path: "dist/app.js", compressedBytes: 200 }]),
    ).toContain("different measurements");
  });

  test("the coherent cases pass", () => {
    expect(baselineBasisMismatch("gzip", [{ path: "a", compressedBytes: 1 }])).toBeNull();
    expect(baselineBasisMismatch("none", [{ path: "a", compressedBytes: null }])).toBeNull();
    expect(baselineBasisMismatch("none", [{ path: "a" }])).toBeNull();
    // An empty baseline has no column to disagree about.
    expect(baselineBasisMismatch("gzip", [])).toBeNull();
  });
});

describe("globMatch", () => {
  test("a single star stays inside one path segment", () => {
    expect(globMatch("*.js", "app.js")).toBe(true);
    expect(globMatch("*.js", "dist/app.js")).toBe(false);
  });

  test("a double star crosses segments and also matches zero of them", () => {
    expect(globMatch("**/*.js", "dist/nested/app.js")).toBe(true);
    expect(globMatch("**/*.js", "app.js")).toBe(true);
  });

  test("a trailing double star covers a whole tree", () => {
    expect(globMatch("dist/**", "dist/a/b/c.css")).toBe(true);
  });

  test("a question mark is exactly one character", () => {
    expect(globMatch("app.?s", "app.js")).toBe(true);
    expect(globMatch("app.?s", "app.mjs")).toBe(false);
  });

  test("a dot in the pattern is a dot, not a wildcard", () => {
    expect(globMatch("a.js", "axjs")).toBe(false);
  });

  test("a pattern built to make a backtracking matcher hang answers instead", () => {
    // `*a*a*a…*b` -> `[^/]*a[^/]*a…[^/]*b`. A regex engine tries every way of
    // dividing the a's between those wildcards before it can say no; 24 of
    // them against sixty a's does not return. The matcher memoises
    // (token, offset), so the search is bounded by tokens x length.
    const pattern = `${"*a".repeat(24)}*b`;
    expect(globMatch(pattern, "a".repeat(60))).toBe(false);
    expect(globMatch(pattern, `${"a".repeat(60)}b`)).toBe(true);
  }, 20_000); // pays for the adversarial match on a loaded runner

  test("a chain of ** segments does not explode either", () => {
    const pattern = `${"**/".repeat(30)}x.js`;
    expect(globMatch(pattern, `${"a/".repeat(60)}y.js`)).toBe(false);
    expect(globMatch(pattern, `${"a/".repeat(60)}x.js`)).toBe(true);
  }, 20_000); // same, for the segment-crossing wildcard

  test("a pattern longer than the cap is refused rather than compiled", () => {
    expect(() => globMatch("*".repeat(MAX_GLOB_LENGTH + 1), "a")).toThrow(SizeError);
  });

  test("a compiled matcher is reusable across paths", () => {
    const match = compileGlob("dist/**/*.js");
    expect(match("dist/a.js")).toBe(true);
    expect(match("dist/a/b/c.js")).toBe(true);
    expect(match("dist/a.css")).toBe(false);
    expect(match("src/a.js")).toBe(false);
  });
});

// --- bench ------------------------------------------------------------------

const series = (n: number, start: number, step = 1): number[] =>
  Array.from({ length: n }, (_, i) => start + i * step);

describe("compareBenchmark", () => {
  test("five samples a side cannot support a significance call, however clean the split", () => {
    // Complete separation, the strongest signal 5-vs-5 can produce. The
    // kernel's normal p is 0.0122 where the exact test says 0.0079 — 54% off —
    // so the verdict is "cannot tell" and the p is carried for ranking only.
    const result = compareBenchmark(
      { name: "parse", base: [100, 101, 102, 103, 104], head: [200, 201, 202, 203, 204] },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("cannot-tell");
    expect(result.test?.normalApproximationValid).toBe(false);
    expect(result.test?.p).toBeCloseTo(0.0122, 4);
    expect(result.why).toContain("8 per side");
  });

  test("a difference inside the declared noise floor is no detectable change, and is not tested", () => {
    const result = compareBenchmark(
      { name: "parse", base: series(30, 100, 0.01), head: series(30, 101, 0.01) },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("no-detectable-change");
    expect(result.test).toBeNull();
    expect(result.why).toContain("noise floor");
  });

  test("a real regression over enough samples is called", () => {
    const base = series(10, 100);
    const result = compareBenchmark(
      { name: "parse", base, head: base.map((v) => v * 1.3) },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("regression");
    expect(result.direction).toBe("slower");
    expect(result.changePercent).toBeCloseTo(30, 6);
    expect(result.test?.p).toBeLessThan(0.05);
  });

  test("the same evidence the other way round is an improvement", () => {
    const base = series(10, 130);
    const result = compareBenchmark(
      { name: "parse", base, head: base.map((v) => v * 0.7) },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("improvement");
    expect(result.direction).toBe("faster");
  });

  test("throughput inverts the direction: more ops per second is faster", () => {
    const base = series(10, 1_000);
    const result = compareBenchmark(
      { name: "ops", base, head: base.map((v) => v * 1.3) },
      { noiseFloorPercent: 2, lowerIsBetter: false },
    );
    expect(result.direction).toBe("faster");
    expect(result.verdict).toBe("improvement");
  });

  test("a difference above the floor that the test cannot confirm is reported as such", () => {
    const result = compareBenchmark(
      {
        name: "parse",
        base: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        head: [11, 12, 13, 14, 15, 16, 17, 18, 19, 40],
      },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("no-significant-difference");
    expect(result.test?.p).toBeCloseTo(0.4948, 4);
  });

  test("one outlier moves the mean by an order of magnitude and the median not at all", () => {
    // The GC-pause case. Comparing means here would report a 91% improvement
    // from a change that did nothing.
    const result = compareBenchmark(
      { name: "gc", base: [1, 1, 1, 1, 1, 1, 1, 1, 1, 100], head: series(10, 1, 0) },
      { noiseFloorPercent: 1 },
    );
    expect(result.base.mean).toBeCloseTo(10.9, 6);
    expect(result.base.median).toBe(1);
    expect(result.base.trimmedMean).toBe(1);
    expect(result.changePercent).toBe(0);
    expect(result.verdict).toBe("no-detectable-change");
  });

  test("an aggregate-only framework is compared to the floor and left untested", () => {
    const result = compareBenchmark(
      { name: "suite", baseAggregate: 100, headAggregate: 130 },
      { noiseFloorPercent: 2 },
    );
    expect(result.method).toBe("threshold");
    expect(result.verdict).toBe("not-tested");
    expect(result.test).toBeNull();
    expect(result.why).toContain("per-iteration samples");
  });

  test("an aggregate below the floor is still no detectable change", () => {
    const result = compareBenchmark(
      { name: "suite", baseAggregate: 100, headAggregate: 101 },
      { noiseFloorPercent: 2 },
    );
    expect(result.verdict).toBe("no-detectable-change");
  });

  test("a zero baseline has no percentage, and no percentage is invented", () => {
    const result = compareBenchmark(
      { name: "zero", base: series(10, 0, 0), head: series(10, 5, 0) },
      { noiseFloorPercent: 2 },
    );
    expect(result.changePercent).toBeNull();
    expect(result.verdict).toBe("cannot-tell");
    expect(result.why).toContain("base median is 0");
  });

  test("samples on one side and an aggregate on the other is refused", () => {
    expect(() =>
      compareBenchmark({ name: "x", base: [1, 2, 3], headAggregate: 4 }, { noiseFloorPercent: 1 }),
    ).toThrow(/one or the other/);
  });

  test("an aggregate on one side only is refused", () => {
    expect(() =>
      compareBenchmark({ name: "x", baseAggregate: 4 }, { noiseFloorPercent: 1 }),
    ).toThrow(BenchError);
  });

  test("a NaN sample is a broken measurement, not a slow one", () => {
    expect(() =>
      compareBenchmark(
        { name: "x", base: [1, Number.NaN], head: [1, 2] },
        { noiseFloorPercent: 1 },
      ),
    ).toThrow(/non-finite/);
  });
});

describe("compareBenchmarks", () => {
  test("a suite with an unjudgeable benchmark is inconclusive, not clean", () => {
    const report = compareBenchmarks(
      [
        { name: "fine", base: series(10, 100), head: series(10, 100) },
        { name: "fivers", base: [1, 2, 3, 4, 5], head: [10, 11, 12, 13, 14] },
      ],
      { noiseFloorPercent: 2 },
    );
    expect(report.summary["cannot-tell"]).toBe(1);
    expect(report.verdict).toBe("inconclusive");
  });

  test("one regression outranks everything else in the suite verdict", () => {
    const base = series(10, 100);
    const report = compareBenchmarks(
      [
        { name: "slower", base, head: base.map((v) => v * 1.3) },
        { name: "fivers", base: [1, 2, 3, 4, 5], head: [10, 11, 12, 13, 14] },
      ],
      { noiseFloorPercent: 2 },
    );
    expect(report.verdict).toBe("regression");
  });

  test("all quiet is clean", () => {
    const report = compareBenchmarks(
      [{ name: "fine", base: series(10, 100), head: series(10, 100) }],
      { noiseFloorPercent: 2 },
    );
    expect(report.verdict).toBe("clean");
  });

  test("two rows under one name are refused", () => {
    expect(() =>
      compareBenchmarks(
        [
          { name: "dup", base: [1], head: [1] },
          { name: "dup", base: [1], head: [1] },
        ],
        { noiseFloorPercent: 1 },
      ),
    ).toThrow(/appears twice/);
  });

  test("a negative noise floor is refused", () => {
    expect(() =>
      compareBenchmarks([{ name: "a", base: [1], head: [1] }], { noiseFloorPercent: -1 }),
    ).toThrow(/non-negative/);
  });

  test("an alpha outside (0,1) is refused", () => {
    expect(() =>
      compareBenchmarks([{ name: "a", base: [1], head: [1] }], {
        noiseFloorPercent: 1,
        alpha: 1,
      }),
    ).toThrow(/strictly between/);
  });
});

// --- flaky ------------------------------------------------------------------

const run = (
  id: string,
  tests: ReadonlyArray<[string, "pass" | "fail" | "error" | "skip", string?]>,
) => ({
  id,
  tests: tests.map(([testId, status, error]) => ({
    id: testId,
    status,
    ...(error === undefined ? {} : { error }),
  })),
});

const outcomes = (id: string, statuses: ReadonlyArray<"pass" | "fail">) =>
  statuses.map((status, i) => run(`r${i + 1}`, [[id, status]]));

describe("detectFlaky", () => {
  test("three failures in five runs is an interval, not 60%", () => {
    const report = detectFlaky(outcomes("t", ["fail", "fail", "fail", "pass", "pass"]));
    const t = report.tests[0];
    expect(t?.classification).toBe("flaky");
    expect(t?.failureRate.pointEstimate).toBeCloseTo(0.6, 10);
    expect(t?.failureRate.lower).toBeCloseTo(0.2307, 4);
    expect(t?.failureRate.upper).toBeCloseTo(0.8824, 4);
    expect(report.verdict).toBe("flaky");
  });

  test("failing every run is not a 100% failure rate either", () => {
    const report = detectFlaky(outcomes("t", ["fail", "fail", "fail", "fail", "fail"]));
    const t = report.tests[0];
    expect(t?.classification).toBe("failing-every-run");
    expect(t?.failureRate.lower).toBeCloseTo(0.5655, 4);
    expect(t?.why).toContain("not at 100%");
    expect(t?.recommendation).toBe("fix");
  });

  test("a single run cannot distinguish a flake from a deterministic failure", () => {
    const report = detectFlaky([run("r1", [["t", "fail"]])]);
    expect(report.verdict).toBe("inconclusive");
    expect(report.note).toContain("single run");
  });

  test("a skipped test is not a pass", () => {
    const report = detectFlaky([
      run("r1", [["t", "pass"]]),
      run("r2", [["t", "skip"]]),
      run("r3", [["t", "skip"]]),
    ]);
    const t = report.tests[0];
    expect(t?.runsObserved).toBe(1);
    expect(t?.skipped).toBe(2);
    expect(t?.classification).toBe("passing");
  });

  test("a test that only ever skipped is reported as never observed", () => {
    const report = detectFlaky([run("r1", [["t", "skip"]]), run("r2", [["t", "skip"]])]);
    expect(report.tests[0]?.classification).toBe("not-observed");
    expect(report.tests[0]?.failureRate.pointEstimate).toBeNull();
  });

  test("passing twice is not evidence of stability, and the interval says so", () => {
    const report = detectFlaky(outcomes("t", ["pass", "pass"]));
    expect(report.tests[0]?.failureRate.upper).toBeCloseTo(0.6576, 4);
    expect(report.tests[0]?.why).toContain("could still be as high as");
  });

  test("quarantine keys on the lower bound, so one failure in five is not enough", () => {
    const rare = detectFlaky(outcomes("t", ["fail", "pass", "pass", "pass", "pass"]));
    expect(rare.tests[0]?.recommendation).toBe("insufficient-evidence");
    const common = detectFlaky(outcomes("t", ["fail", "fail", "fail", "pass", "pass"]));
    expect(common.tests[0]?.recommendation).toBe("quarantine");
  });

  test("a higher confidence widens the interval rather than changing the estimate", () => {
    const report = detectFlaky(outcomes("t", ["fail", "fail", "fail", "pass", "pass"]), {
      z: statsKernel.TWO_SIDED_Z["0.99"],
    });
    expect(report.tests[0]?.failureRate.pointEstimate).toBeCloseTo(0.6, 10);
    expect(report.tests[0]?.failureRate.lower).toBeCloseTo(0.1687, 4);
  });

  test("an unvaried order makes order-dependence undecidable, and it says so", () => {
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run("r2", [
        ["a", "pass"],
        ["b", "pass"],
      ]),
    ]);
    expect(report.ordering.varied).toBe(false);
    const b = report.tests.find((t) => t.id === "b");
    expect(b?.order.decidable).toBe(false);
    expect(b?.order.note).toContain("indistinguishable");
  });

  test("a deterministic failure under an unvaried order is flagged as possibly ordered", () => {
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run("r2", [
        ["a", "pass"],
        ["b", "fail"],
      ]),
    ]);
    expect(report.tests.find((t) => t.id === "b")?.why).toContain("same order");
  });

  test("when order varies, the predecessor present in every failure is named", () => {
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["c", "pass"],
        ["b", "fail"],
      ]),
      run("r2", [
        ["c", "pass"],
        ["b", "pass"],
        ["a", "pass"],
      ]),
      run("r3", [
        ["a", "pass"],
        ["b", "fail"],
        ["c", "pass"],
      ]),
      run("r4", [
        ["b", "pass"],
        ["a", "pass"],
        ["c", "pass"],
      ]),
    ]);
    const b = report.tests.find((t) => t.id === "b");
    expect(b?.classification).toBe("flaky");
    expect(b?.order.decidable).toBe(true);
    // `c` preceded one failure and one pass; `a` preceded both failures and
    // neither pass, which is the whole signal.
    expect(b?.order.suspects).toEqual(["a"]);
    expect(b?.why).toContain("order-dependent");
  });

  test("varied order with no matching predecessor says the failures do not line up", () => {
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run("r2", [
        ["b", "pass"],
        ["a", "pass"],
      ]),
      run("r3", [
        ["a", "pass"],
        ["b", "pass"],
      ]),
    ]);
    const b = report.tests.find((t) => t.id === "b");
    expect(b?.order.suspects).toEqual([]);
    expect(b?.order.note).toContain("do not line up");
  });

  test("a suite that merely grew does not make one test's order decidable", () => {
    // The suite's sequence differs between the two runs, so the SUITE-level
    // flag says the order varied — but `c` ran after exactly `a` both times.
    // Taking the suite's flag for this test's reported "the failures do not
    // line up with a predecessor" about a comparison never available.
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["c", "pass"],
      ]),
      run("r2", [
        ["a", "pass"],
        ["c", "fail"],
        ["d", "pass"],
      ]),
    ]);
    expect(report.ordering.varied).toBe(true);
    const c = report.tests.find((t) => t.id === "c");
    expect(c?.order.decidable).toBe(false);
    expect(c?.order.note).toContain("exactly the same set of tests in every run");
  });

  test("a test whose own prefix really did vary stays decidable", () => {
    // The guard above must not swallow the case the analysis exists for.
    const report = detectFlaky([
      run("r1", [
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run("r2", [
        ["b", "pass"],
        ["a", "pass"],
      ]),
    ]);
    const b = report.tests.find((t) => t.id === "b");
    expect(b?.order.decidable).toBe(true);
    expect(b?.order.suspects).toEqual(["a"]);
  });

  test("seeds that never changed the order are reported as not having reached the suite", () => {
    const report = detectFlaky([
      {
        id: "r1",
        seed: "1",
        tests: [
          { id: "a", status: "pass" },
          { id: "b", status: "pass" },
        ],
      },
      {
        id: "r2",
        seed: "2",
        tests: [
          { id: "a", status: "pass" },
          { id: "b", status: "pass" },
        ],
      },
    ]);
    expect(report.ordering.seedsDeclared).toEqual(["1", "2"]);
    expect(report.ordering.note).toContain("never reached the suite");
  });

  test("two failures whose text differs only in a varying part are two groups without a mask", () => {
    const report = detectFlaky([
      run("r1", [["t", "fail", "timeout after 1200ms"]]),
      run("r2", [["t", "fail", "timeout after 3400ms"]]),
    ]);
    expect(report.tests[0]?.failureGroups).toHaveLength(2);
    expect(report.tests[0]?.sameFailureEveryTime).toBe(false);
  });

  test("a declared mask merges them, and reports how often it fired", () => {
    const report = detectFlaky(
      [
        run("r1", [["t", "fail", "timeout after 1200ms"]]),
        run("r2", [["t", "fail", "timeout after 3400ms"]]),
      ],
      { masks: [{ pattern: "\\d+ms", with: "<ms>" }] },
    );
    expect(report.tests[0]?.failureGroups).toHaveLength(1);
    expect(report.tests[0]?.sameFailureEveryTime).toBe(true);
    expect(report.masksApplied["\\d+ms"]).toBe(2);
  });

  test("a caller-supplied signature wins over the raw text", () => {
    const report = detectFlaky([
      { id: "r1", tests: [{ id: "t", status: "fail", error: "A", signature: "same" }] },
      { id: "r2", tests: [{ id: "t", status: "fail", error: "B", signature: "same" }] },
    ]);
    expect(report.tests[0]?.failureGroups).toHaveLength(1);
  });

  test("one group among failures that did not all say anything is not 'always the same way'", () => {
    // Two failures reported the same text and a third reported nothing. One
    // group came back, and `sameFailureEveryTime` read it as yes — an answer
    // about the two failures that spoke, presented as an answer about three.
    const report = detectFlaky([
      run("r1", [
        ["t", "fail", "boom A"],
        ["u", "pass"],
      ]),
      run("r2", [
        ["t", "fail", "boom A"],
        ["u", "pass"],
      ]),
      run("r3", [
        ["t", "fail"],
        ["u", "pass"],
      ]),
      run("r4", [
        ["t", "pass"],
        ["u", "pass"],
      ]),
    ]);
    const t = report.tests.find((x) => x.id === "t");
    expect(t?.failures).toBe(3);
    expect(t?.failureGroups).toHaveLength(1);
    expect(t?.sameFailureEveryTime).toBeNull();
  });

  test("every failure accounted for in one group still answers yes", () => {
    const report = detectFlaky([
      run("r1", [["t", "fail", "boom A"]]),
      run("r2", [["t", "fail", "boom A"]]),
    ]);
    expect(report.tests[0]?.sameFailureEveryTime).toBe(true);
  });

  test("a failure with no text at all is not a group of one", () => {
    const report = detectFlaky(outcomes("t", ["fail", "fail"]));
    expect(report.tests[0]?.failureGroups).toEqual([]);
    expect(report.tests[0]?.sameFailureEveryTime).toBeNull();
  });

  test("an error status counts as a failure", () => {
    const report = detectFlaky([run("r1", [["t", "error"]]), run("r2", [["t", "pass"]])]);
    expect(report.tests[0]?.failures).toBe(1);
    expect(report.tests[0]?.classification).toBe("flaky");
  });

  test("a test reported twice in one run is refused", () => {
    expect(() =>
      detectFlaky([
        run("r1", [
          ["t", "pass"],
          ["t", "fail"],
        ]),
      ]),
    ).toThrow(/appears twice/);
  });

  test("no runs at all is refused", () => {
    expect(() => detectFlaky([])).toThrow(FlakyError);
  });

  test("an out-of-range quarantine bound is refused", () => {
    expect(() => detectFlaky(outcomes("t", ["fail"]), { quarantineLowerBound: 2 })).toThrow(
      /probability/,
    );
  });

  test("absence from a run is distinguished from being skipped in it", () => {
    const report = detectFlaky([run("r1", [["t", "pass"]]), run("r2", [["other", "pass"]])]);
    const t = report.tests.find((r) => r.id === "t");
    expect(t?.absent).toBe(1);
    expect(t?.skipped).toBe(0);
  });
});

describe("applyMasks", () => {
  test("an invalid pattern is a refusal with the regex error in it", () => {
    expect(() => applyMasks("x", [{ pattern: "(" }], {})).toThrow(/not a valid regular expression/);
  });

  test("whitespace is collapsed so a wrapped message matches an unwrapped one", () => {
    expect(applyMasks("a\n  b", [], {})).toBe("a b");
  });

  test("a mask that matches nothing is not counted", () => {
    const counts: Record<string, number> = {};
    applyMasks("abc", [{ pattern: "\\d+" }], counts);
    expect(counts).toEqual({});
  });
});

describe("runsForLowerBound", () => {
  test("claiming a 90% failure rate takes 35 consecutive failures at 95% confidence", () => {
    expect(runsForLowerBound(0.9)).toBe(35);
  });

  test("a weaker confidence needs fewer runs", () => {
    expect(runsForLowerBound(0.9, statsKernel.TWO_SIDED_Z["0.80"])).toBe(15);
  });
});
