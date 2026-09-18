import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * `BundleSizeCheck` reads files, so containment is relative to
 * `process.cwd()` and each test runs inside a temporary directory; the escape
 * tests reach for a path outside it. The other two are pure and are driven
 * here only for the things the schema and the tool layer add on top of
 * `./lib`: the refusals, the caveats and the shape of the JSON.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILDPERF_TOOLS, benchmarkCompare, bundleSizeCheck, flakyTestDetect } from "./index";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

async function call<T = Record<string, unknown>>(
  tool: (typeof BUILDPERF_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  const out = await tool.execute(parsed.data, ctx);
  return JSON.parse(out as string) as T;
}

/** For the paths that answer with a sentence rather than JSON. */
async function callRaw(tool: (typeof BUILDPERF_TOOLS)[number], input: unknown): Promise<string> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return (await tool.execute(parsed.data, ctx)) as string;
}

/** Compressible, so a level change moves the number by more than a byte. */
const payload = (marker: string, repeats = 400): string =>
  `export const ${marker} = 'hello world';\n`.repeat(repeats);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-buildperf-"));
  process.chdir(workspace);
  mkdirSync("dist");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("package-wide contract", () => {
  test("every tool is exported in BUILDPERF_TOOLS", () => {
    expect(BUILDPERF_TOOLS.length).toBe(3);
  });

  test("names are unique and PascalCase", () => {
    const names = BUILDPERF_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of BUILDPERF_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, internal and non-destructive", () => {
    for (const t of BUILDPERF_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly, destructive: t.destructive }).toEqual({
        name: t.name,
        readOnly: true,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
    }
  });

  test("nothing here declares a network or process capability: it runs no build and no test", () => {
    for (const t of BUILDPERF_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });
});

describe("BundleSizeCheck — measurement", () => {
  type SizeReport = {
    parameters: { algorithm: string; level: number | null; comparabilityKey: string };
    entries: Array<{ path: string; key: string; bytes: number; compressedBytes: number | null }>;
    totals: { files: number; bytes: number; compressedBytes: number | null };
    budgets: { checked: number; violations: unknown[] };
    comparison: {
      status: string;
      why?: string;
      matched?: unknown[];
      added?: string[];
      removed?: string[];
    };
    warnings?: string[];
    verdict: string;
  };

  test("weighs each file raw and compressed, and records the parameters used", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, { files: ["dist/app.js"] });
    expect(report.parameters).toMatchObject({ algorithm: "gzip", level: 9 });
    expect(report.entries[0]?.bytes).toBeGreaterThan(0);
    expect(report.entries[0]?.compressedBytes).toBeLessThan(report.entries[0]?.bytes as number);
    expect(report.verdict).toBe("pass");
  });

  test("algorithm none reports raw bytes and no compressed size", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      algorithm: "none",
    });
    expect(report.entries[0]?.compressedBytes).toBeNull();
    expect(report.totals.compressedBytes).toBeNull();
  });

  test("a directory is walked, and extensions narrow it", async () => {
    writeFileSync("dist/app.js", payload("app"));
    writeFileSync("dist/app.css", "body{color:red}");
    mkdirSync("dist/nested");
    writeFileSync("dist/nested/lazy.js", payload("lazy"));
    const all = await call<SizeReport>(bundleSizeCheck, { directory: "dist" });
    expect(all.totals.files).toBe(3);
    const js = await call<SizeReport>(bundleSizeCheck, {
      directory: "dist",
      extensions: [".js"],
    });
    expect(js.entries.map((e) => e.path)).toEqual(["dist/app.js", "dist/nested/lazy.js"]);
  });

  test("a symlink inside the walked directory is counted, not silently dropped", async () => {
    // Weighing both a link and its target double-counts, so the walk skips
    // links — but a skipped file that nobody mentions makes the total quietly
    // wrong, which is the failure mode this package exists to avoid.
    writeFileSync("dist/app.js", payload("app"));
    symlinkSync(join(workspace, "dist", "app.js"), join(workspace, "dist", "alias.js"));
    const report = await call<SizeReport>(bundleSizeCheck, { directory: "dist" });
    expect(report.totals.files).toBe(1);
    expect(report.warnings?.join(" ")).toContain("dist/alias.js");
  });

  test("an empty match is said out loud rather than reported as a build of zero bytes", async () => {
    const out = await callRaw(bundleSizeCheck, { directory: "dist", extensions: [".wasm"] });
    expect(out).toContain("nothing to weigh");
  });

  test("the same path twice is refused", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const out = await callRaw(bundleSizeCheck, { files: ["dist/app.js", "dist/app.js"] });
    expect(out).toContain("twice");
  });

  test("a gzip level outside 0-9 is refused with the reason", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const out = await callRaw(bundleSizeCheck, { files: ["dist/app.js"], level: 11 });
    expect(out).toContain("brotli qualities");
  });

  test("a path outside the workspace is refused", async () => {
    await expect(callRaw(bundleSizeCheck, { files: ["../escape.js"] })).rejects.toThrow(
      /escapes the workspace root/,
    );
  });

  test("a symlink pointing out of the workspace is refused, not followed", async () => {
    writeFileSync(join(workspace, "..", "outside-buildperf.js"), payload("outside"));
    symlinkSync(join(workspace, "..", "outside-buildperf.js"), "dist/link.js");
    try {
      await expect(callRaw(bundleSizeCheck, { files: ["dist/link.js"] })).rejects.toThrow(
        /escapes the workspace root/,
      );
    } finally {
      rmSync(join(workspace, "..", "outside-buildperf.js"), { force: true });
    }
  });
});

describe("BundleSizeCheck — the refusal", () => {
  type SizeReport = {
    parameters: { algorithm: string; level: number | null };
    entries: Array<{ path: string; bytes: number; compressedBytes: number | null }>;
    comparison: { status: string; why?: string; matched?: Array<Record<string, unknown>> };
    verdict: string;
  };

  const baselineAt = (level: number) => ({
    parameters: {
      algorithm: "gzip" as const,
      level,
      tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
    },
    entries: [{ path: "dist/app.js", bytes: 14_400, compressedBytes: 200 }],
  });

  test("a baseline at another level is refused, and no percentage is printed", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const raw = await callRaw(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: baselineAt(6),
    });
    // The point of the whole tool: a mismatched baseline must not produce a
    // delta at all, not even a correctly-labelled one.
    expect(raw).not.toContain("deltaPercent");
    expect(raw).not.toContain("deltaBytes");
    const report = JSON.parse(raw) as SizeReport;
    expect(report.comparison.status).toBe("refused");
    expect(report.comparison.why).toContain("level 6");
    expect(report.verdict).toBe("indeterminate");
  });

  test("a refused comparison is indeterminate, never a pass", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { ...baselineAt(9), parameters: { algorithm: "brotli", level: 11 } },
    });
    expect(report.comparison.status).toBe("refused");
    expect(report.verdict).toBe("indeterminate");
  });

  test("a baseline that never declared its parameters is refused too", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { entries: [{ path: "dist/app.js", bytes: 100, compressedBytes: 50 }] },
    });
    expect(report.comparison.status).toBe("refused");
    expect(report.comparison.why).toContain("does not declare");
  });

  test("but a budget failure still fails, because a budget needs no baseline", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: baselineAt(6),
      budgets: [{ pattern: "dist/*.js", maxBytes: 10 }],
    });
    expect(report.comparison.status).toBe("refused");
    expect(report.verdict).toBe("fail");
  });

  test("matching parameters compare, and the report round-trips as the next baseline", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const first = await call<SizeReport>(bundleSizeCheck, { files: ["dist/app.js"] });
    const second = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { parameters: first.parameters, entries: first.entries },
    });
    expect(second.comparison.status).toBe("compared");
    expect(second.comparison.matched?.[0]).toMatchObject({ deltaBytes: 0, deltaPercent: 0 });
    expect(second.verdict).toBe("pass");
  });

  test("a growth beyond maxIncreasePercent fails", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const first = await call<SizeReport>(bundleSizeCheck, { files: ["dist/app.js"] });
    writeFileSync("dist/app.js", payload("app", 1_200));
    const second = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { parameters: first.parameters, entries: first.entries },
      maxIncreasePercent: 5,
    });
    expect(second.verdict).toBe("fail");
    expect(second.comparison.matched?.[0]?.["deltaBytes"] as number).toBeGreaterThan(0);
  });

  test("a baseline from another zlib build warns rather than refusing: the parameters still match", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const first = await call<SizeReport>(bundleSizeCheck, { files: ["dist/app.js"] });
    const second = await call<{ warnings?: string[]; comparison: { status: string } }>(
      bundleSizeCheck,
      {
        files: ["dist/app.js"],
        baseline: {
          parameters: first.parameters,
          entries: first.entries,
          runtime: { zlib: "1.2.11-from-another-machine" },
        },
      },
    );
    expect(second.comparison.status).toBe("compared");
    expect(second.warnings?.join(" ")).toContain("different zlib build");
  });

  test("a baseline file is read from the workspace, and a non-report is refused by name", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const first = await call<SizeReport>(bundleSizeCheck, { files: ["dist/app.js"] });
    writeFileSync("baseline.json", JSON.stringify(first));
    const ok = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baselineFile: "baseline.json",
    });
    expect(ok.comparison.status).toBe("compared");

    writeFileSync("junk.json", JSON.stringify({ hello: "world" }));
    const bad = await callRaw(bundleSizeCheck, {
      files: ["dist/app.js"],
      baselineFile: "junk.json",
    });
    expect(bad).toContain("is not a size report");

    writeFileSync("broken.json", "{not json");
    const broken = await callRaw(bundleSizeCheck, {
      files: ["dist/app.js"],
      baselineFile: "broken.json",
    });
    expect(broken).toContain("not valid JSON");
  });
});

describe("BundleSizeCheck — joining a hashed build", () => {
  type SizeReport = {
    entries: Array<{ path: string; key: string }>;
    join: { mode: string; ambiguous?: Array<{ key: string; paths: string[] }> };
    comparison: {
      status: string;
      matched?: unknown[];
      added?: string[];
      removed?: string[];
      baselineAmbiguousKeys?: string[];
    };
    warnings?: string[];
    verdict: string;
  };

  test("exact joins nothing when the hash changed, and says which flag fixes it", async () => {
    writeFileSync("dist/app-BXaGz2Qm.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app-BXaGz2Qm.js"],
      baseline: {
        parameters: {
          algorithm: "gzip",
          level: 9,
          tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
        },
        entries: [{ path: "dist/app-9zQaXb3K.js", bytes: 14_400, compressedBytes: 200 }],
      },
    });
    expect(report.comparison.matched).toEqual([]);
    expect(report.comparison.added).toEqual(["dist/app-BXaGz2Qm.js"]);
    expect(report.warnings?.join(" ")).toContain('join: "auto"');
  });

  test("auto joins the same pair on the normalised key", async () => {
    writeFileSync("dist/app-BXaGz2Qm.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app-BXaGz2Qm.js"],
      join: "auto",
      baseline: {
        parameters: {
          algorithm: "gzip",
          level: 9,
          tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
        },
        entries: [{ path: "dist/app-9zQaXb3K.js", bytes: 14_400, compressedBytes: 200 }],
      },
    });
    expect(report.entries[0]?.key).toBe("dist/app-[hash].js");
    expect(report.comparison.matched).toHaveLength(1);
    expect(report.comparison.added).toEqual([]);
  });

  test("two artifacts that normalise to one key are set aside, not paired arbitrarily", async () => {
    writeFileSync("dist/app-BXaGz2Qm.js", payload("app"));
    writeFileSync("dist/app-9zQaXb3K.js", payload("app2"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app-BXaGz2Qm.js", "dist/app-9zQaXb3K.js"],
      join: "auto",
      baseline: {
        parameters: {
          algorithm: "gzip",
          level: 9,
          tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
        },
        entries: [{ path: "dist/app-oldoldold.js", bytes: 14_400, compressedBytes: 200 }],
      },
    });
    expect(report.join.ambiguous?.[0]?.paths).toHaveLength(2);
    expect(report.comparison.matched).toEqual([]);
    expect(report.warnings?.join(" ")).toContain("more than one artifact");
  });

  test("a removed artifact is reported as removed, not as a 100% saving", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: {
        parameters: {
          algorithm: "gzip",
          level: 9,
          tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
        },
        entries: [
          { path: "dist/app.js", bytes: 14_400, compressedBytes: 200 },
          { path: "dist/legacy.js", bytes: 9_000, compressedBytes: 120 },
        ],
      },
    });
    expect(report.comparison.removed).toEqual(["dist/legacy.js"]);
  });

  test("two BASELINE rows that collapse onto one key are set aside as well", async () => {
    // The head-side check refuses an arbitrary pairing; the baseline side has
    // to refuse the same one, or the delta is measured against whichever row
    // the stored report happened to list first.
    writeFileSync("dist/app-BXaGz2Qm.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app-BXaGz2Qm.js"],
      join: "auto",
      baseline: {
        parameters: {
          algorithm: "gzip",
          level: 9,
          tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
        },
        entries: [
          { path: "dist/app-9zQaXb3K.js", bytes: 14_400, compressedBytes: 200 },
          { path: "dist/app-1aB2cD3e.js", bytes: 9_000, compressedBytes: 120 },
        ],
      },
    });
    expect(report.comparison.matched).toEqual([]);
    expect(report.comparison.baselineAmbiguousKeys).toEqual(["dist/app-[hash].js"]);
  });
});

describe("BundleSizeCheck — budgets", () => {
  type SizeReport = {
    budgets: { checked: number; violations: Array<Record<string, unknown>> };
    verdict: string;
  };

  test("an over-budget artifact fails with the overage in bytes", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      budgets: [{ pattern: "dist/**", maxBytes: 10 }],
    });
    expect(report.verdict).toBe("fail");
    expect(report.budgets.violations[0]?.["overBytes"] as number).toBeGreaterThan(0);
  });

  test("a budget that matches nothing is a violation, because it gated nothing", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      budgets: [{ pattern: "dist/main.js", maxBytes: 1_000_000 }],
    });
    expect(report.verdict).toBe("fail");
    expect(report.budgets.violations[0]?.["why"]).toContain("checked nothing");
  });

  test("a raw budget measures the uncompressed bytes", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      budgets: [{ pattern: "dist/app.js", maxBytes: 1_000, on: "raw" }],
    });
    expect(report.budgets.violations[0]?.["on"]).toBe("raw");
  });

  test("a compressed budget with algorithm none is refused rather than silently measured raw", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const out = await callRaw(bundleSizeCheck, {
      files: ["dist/app.js"],
      algorithm: "none",
      budgets: [{ pattern: "dist/app.js", maxBytes: 10, on: "compressed" }],
    });
    expect(out).toContain('algorithm "none"');
  });

  test("a total budget is checked against the sum", async () => {
    writeFileSync("dist/app.js", payload("app"));
    writeFileSync("dist/b.js", payload("b"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      directory: "dist",
      totalMaxBytes: 10,
    });
    expect(report.budgets.violations[0]?.["pattern"]).toBe("<total>");
  });
});

describe("BundleSizeCheck — the gates that must not pass vacuously", () => {
  type SizeReport = {
    budgets: { checked: number; violations: Array<Record<string, unknown>> };
    comparison: {
      status: string;
      why?: string;
      matched?: Array<Record<string, unknown>>;
      removed?: string[];
      baselineSetAside?: string[];
      total?: { baseline: number; current: number; deltaPercent: number | null };
    };
    verdict: string;
  };

  const GZIP_9 = {
    algorithm: "gzip" as const,
    level: 9,
    tuning: { memLevel: 8, strategy: 0, windowBits: 15 },
  };

  test("a build that renames every file still has its TOTAL gated, not a pass over an empty join", async () => {
    // The regression this pins: the growth gate walked only the MATCHED rows.
    // A content-hash build joins nothing under the default `exact` mode, so
    // the loop ran zero times and a bundle that grew several hundred percent
    // came back `pass` with no violations — a gate that reports clean because
    // it inspected nothing.
    writeFileSync("dist/app-aaaa11.js", payload("app", 3_000));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app-aaaa11.js"],
      baseline: {
        parameters: GZIP_9,
        entries: [{ path: "dist/app-bbbb22.js", bytes: 100, compressedBytes: 20 }],
      },
      maxIncreasePercent: 5,
    });
    expect(report.comparison.matched).toEqual([]);
    expect(report.comparison.total?.deltaPercent as number).toBeGreaterThan(5);
    expect(report.verdict).toBe("fail");
    expect(report.budgets.violations.map((v) => v["pattern"])).toContain("<total-regression>");
  });

  test("a new chunk that doubles the bundle is a growth violation even when every matched row is flat", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const first = await call<SizeReport & { parameters: unknown; entries: unknown[] }>(
      bundleSizeCheck,
      { files: ["dist/app.js"] },
    );
    writeFileSync("dist/new-chunk.js", payload("chunk", 4_000));
    const second = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js", "dist/new-chunk.js"],
      baseline: { parameters: first.parameters, entries: first.entries as never },
      maxIncreasePercent: 5,
    });
    // dist/app.js is byte-identical, so the per-entry gate sees 0%.
    expect(second.comparison.matched?.[0]?.["deltaPercent"]).toBe(0);
    expect(second.verdict).toBe("fail");
    expect(second.budgets.violations.map((v) => v["pattern"])).toContain("<total-regression>");
  });

  test("a growth limit declared with no baseline is a violation, not a pass", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      maxIncreasePercent: 5,
    });
    expect(report.comparison.status).toBe("no-baseline");
    expect(report.verdict).toBe("fail");
    expect(report.budgets.violations[0]?.["why"]).toContain("no baseline");
  });

  test("a growth limit is not tripped by a total sitting exactly ON it", async () => {
    // "grows by MORE than this": 100 -> 200 under a limit of 100% is exactly
    // at the threshold and must pass. `none` is used so the byte counts are
    // the file lengths and the ratio is exact rather than whatever gzip gave.
    writeFileSync("dist/app.js", "x".repeat(200));
    const at = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      algorithm: "none",
      baseline: {
        parameters: { algorithm: "none", level: null, tuning: {} },
        entries: [{ path: "dist/other.js", bytes: 100 }],
      },
      maxIncreasePercent: 100,
    });
    expect(at.comparison.total?.deltaPercent).toBe(100);
    expect(at.budgets.violations.map((v) => v["pattern"])).not.toContain("<total-regression>");

    const over = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      algorithm: "none",
      baseline: {
        parameters: { algorithm: "none", level: null, tuning: {} },
        entries: [{ path: "dist/other.js", bytes: 100 }],
      },
      maxIncreasePercent: 99.9,
    });
    expect(over.budgets.violations.map((v) => v["pattern"])).toContain("<total-regression>");
  });

  test("a baseline that declares gzip but stores no compressed sizes is REFUSED, not differenced against raw bytes", async () => {
    // The parameters matched, so the old code went ahead and took
    // `compressed ?? raw` on the baseline side against a gzip size on this
    // one — a ~-98% "improvement" with verdict `pass`, which also made the
    // growth gate structurally unable to fire.
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { parameters: GZIP_9, entries: [{ path: "dist/app.js", bytes: 14_400 }] },
      maxIncreasePercent: 5,
    });
    expect(report.comparison.status).toBe("refused");
    expect(report.comparison.why).toContain("compressedBytes");
    expect(report.verdict).toBe("indeterminate");
  });

  test("a refusal over the missing compressed column prints no delta at all", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const raw = await callRaw(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: { parameters: GZIP_9, entries: [{ path: "dist/app.js", bytes: 14_400 }] },
    });
    expect(raw).not.toContain("deltaPercent");
    expect(raw).not.toContain("deltaBytes");
  });

  test("the mirror image — a compressed column under algorithm none — is refused too", async () => {
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      algorithm: "none",
      baseline: {
        parameters: { algorithm: "none", level: null, tuning: {} },
        entries: [{ path: "dist/app.js", bytes: 14_400, compressedBytes: 200 }],
      },
    });
    expect(report.comparison.status).toBe("refused");
    expect(report.verdict).toBe("indeterminate");
  });

  test("a chunk split in two is not reported as removed", async () => {
    // Both head artifacts normalise onto the baseline row's key, so neither
    // can be its successor — but the baseline row was falling out the far end
    // as `removed`, and a reader acts on "removed": they go hunting for a
    // deleted chunk that was in fact split.
    writeFileSync("dist/chunk-1aB2cD3e.js", payload("a"));
    writeFileSync("dist/chunk-9zQaXb3K.js", payload("b"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/chunk-1aB2cD3e.js", "dist/chunk-9zQaXb3K.js"],
      join: "auto",
      baseline: {
        parameters: GZIP_9,
        entries: [{ path: "dist/chunk-0000ff11.js", bytes: 1, compressedBytes: 21 }],
      },
    });
    expect(report.comparison.removed).toEqual([]);
    expect(report.comparison.baselineSetAside).toEqual(["dist/chunk-0000ff11.js"]);
  });

  test("a genuinely deleted artifact is still reported as removed", async () => {
    // The guard above must not swallow the real case.
    writeFileSync("dist/app.js", payload("app"));
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: ["dist/app.js"],
      baseline: {
        parameters: GZIP_9,
        entries: [
          { path: "dist/app.js", bytes: 14_400, compressedBytes: 200 },
          { path: "dist/legacy.js", bytes: 9_000, compressedBytes: 120 },
        ],
      },
    });
    expect(report.comparison.removed).toEqual(["dist/legacy.js"]);
  });

  test("a budget pattern built to make a backtracking matcher hang answers immediately", async () => {
    // `*a*a*a…*b` compiles to `[^/]*a[^/]*a…[^/]*b`; a regex engine explores
    // every way of splitting the a's between those wildcards and does not
    // finish. The budget below is 49 characters and the path is 60.
    writeFileSync(`dist/${"a".repeat(56)}`, "x");
    const started = Date.now();
    const report = await call<SizeReport>(bundleSizeCheck, {
      files: [`dist/${"a".repeat(56)}`],
      budgets: [{ pattern: `dist/${"*a".repeat(24)}*b`, maxBytes: 1_000_000 }],
    });
    // Not a timing assertion on the work: the point is that `execute`
    // RETURNED. The vulnerable build never reaches this line.
    expect(report.budgets.violations[0]?.["why"]).toContain("checked nothing");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000); // pays for compressing the artifact plus the adversarial match
});

describe("BenchmarkCompare", () => {
  type BenchReport = {
    verdict: string;
    collection: string;
    caveats?: string[];
    unit?: string;
    benchmarks: Array<{ name: string; verdict: string; why: string; test: unknown }>;
  };

  const series = (n: number, start: number, step = 1): number[] =>
    Array.from({ length: n }, (_, i) => start + i * step);

  test("five runs a side is 'cannot tell', and the suite is inconclusive rather than clean", async () => {
    const report = await call<BenchReport>(benchmarkCompare, {
      benchmarks: [
        { name: "parse", base: [100, 101, 102, 103, 104], head: [200, 201, 202, 203, 204] },
      ],
      noiseFloorPercent: 2,
    });
    expect(report.benchmarks[0]?.verdict).toBe("cannot-tell");
    expect(report.verdict).toBe("inconclusive");
    expect(report.caveats?.join(" ")).toContain("fewer than 8 samples");
  });

  test("a sequential collection is called out as confounded with machine drift", async () => {
    const report = await call<BenchReport>(benchmarkCompare, {
      benchmarks: [{ name: "parse", base: series(10, 100), head: series(10, 100) }],
      noiseFloorPercent: 2,
      collection: "sequential",
    });
    expect(report.caveats?.join(" ")).toContain("thermal drift");
  });

  test("an interleaved collection carries no drift caveat", async () => {
    const report = await call<BenchReport>(benchmarkCompare, {
      benchmarks: [{ name: "parse", base: series(10, 100), head: series(10, 100) }],
      noiseFloorPercent: 2,
      collection: "interleaved",
    });
    expect(report.caveats).toBeUndefined();
    expect(report.verdict).toBe("clean");
  });

  test("the declared unit is echoed, because a number without one is not a measurement", async () => {
    const report = await call<BenchReport>(benchmarkCompare, {
      benchmarks: [{ name: "parse", base: series(10, 100), head: series(10, 100) }],
      noiseFloorPercent: 2,
      unit: "ns/op",
    });
    expect(report.unit).toBe("ns/op");
  });

  test("a structural problem in one benchmark comes back as a sentence, not a crash", async () => {
    const out = await callRaw(benchmarkCompare, {
      benchmarks: [{ name: "parse", base: [1, 2, 3], headAggregate: 4 }],
      noiseFloorPercent: 2,
    });
    expect(out).toContain("one or the other");
  });

  test("the noise floor is required — there is no default for it", () => {
    const parsed = benchmarkCompare.inputSchema.safeParse({
      benchmarks: [{ name: "parse", base: [1], head: [1] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a non-finite sample never reaches execute", () => {
    const parsed = benchmarkCompare.inputSchema.safeParse({
      benchmarks: [{ name: "parse", base: [Number.NaN], head: [1] }],
      noiseFloorPercent: 2,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("FlakyTestDetect", () => {
  type FlakyReport = {
    verdict: string;
    runs: number;
    runsForDeterminismClaim: number;
    ordering: { varied: boolean; note: string };
    tests: Array<{
      id: string;
      classification: string;
      recommendation: string;
      failureRate: { pointEstimate: number | null; lower: number | null; upper: number | null };
      order: { decidable: boolean; suspects: string[] };
    }>;
  };

  const runs = (statuses: ReadonlyArray<"pass" | "fail">) =>
    statuses.map((status, i) => ({ id: `r${i + 1}`, tests: [{ id: "t", status }] }));

  test("three of five comes back as an interval and a quarantine recommendation", async () => {
    const report = await call<FlakyReport>(flakyTestDetect, {
      runs: runs(["fail", "fail", "fail", "pass", "pass"]),
    });
    expect(report.tests[0]?.failureRate.lower).toBeCloseTo(0.2307, 4);
    expect(report.tests[0]?.recommendation).toBe("quarantine");
    expect(report.verdict).toBe("flaky");
  });

  test("the confidence level reaches the interval", async () => {
    const report = await call<FlakyReport>(flakyTestDetect, {
      runs: runs(["fail", "fail", "fail", "pass", "pass"]),
      confidence: "0.99",
    });
    expect(report.tests[0]?.failureRate.lower).toBeCloseTo(0.1687, 4);
    expect(report.runsForDeterminismClaim).toBeGreaterThan(35);
  });

  test("the quarantine floor is the caller's to set", async () => {
    const report = await call<FlakyReport>(flakyTestDetect, {
      runs: runs(["fail", "fail", "fail", "pass", "pass"]),
      quarantineLowerBound: 0.5,
    });
    expect(report.tests[0]?.recommendation).toBe("insufficient-evidence");
  });

  test("one run is inconclusive whatever it contains", async () => {
    const report = await call<FlakyReport>(flakyTestDetect, {
      runs: [{ id: "r1", tests: [{ id: "t", status: "fail" }] }],
    });
    expect(report.verdict).toBe("inconclusive");
  });

  test("an order-dependent failure names its suspect", async () => {
    const report = await call<FlakyReport>(flakyTestDetect, {
      runs: [
        {
          id: "r1",
          tests: [
            { id: "a", status: "pass" },
            { id: "b", status: "fail" },
          ],
        },
        {
          id: "r2",
          tests: [
            { id: "b", status: "pass" },
            { id: "a", status: "pass" },
          ],
        },
      ],
    });
    expect(report.ordering.varied).toBe(true);
    expect(report.tests.find((t) => t.id === "b")?.order.suspects).toEqual(["a"]);
  });

  test("masks are applied to failure text and their hit counts reported", async () => {
    const report = await call<{
      masksApplied: Record<string, number>;
      tests: Array<{ failureGroups: unknown[]; sameFailureEveryTime: boolean | null }>;
    }>(flakyTestDetect, {
      runs: [
        { id: "r1", tests: [{ id: "t", status: "fail", error: "closed port 51234" }] },
        { id: "r2", tests: [{ id: "t", status: "fail", error: "closed port 61111" }] },
      ],
      masks: [{ pattern: "port \\d+", with: "port <n>" }],
    });
    expect(report.masksApplied["port \\d+"]).toBe(2);
    expect(report.tests[0]?.failureGroups).toHaveLength(1);
    expect(report.tests[0]?.sameFailureEveryTime).toBe(true);
  });

  test("an unusable mask comes back as a sentence, not a crash", async () => {
    const out = await callRaw(flakyTestDetect, {
      runs: [{ id: "r1", tests: [{ id: "t", status: "fail", error: "x" }] }],
      masks: [{ pattern: "(" }],
    });
    expect(out).toContain("not a valid regular expression");
  });

  test("an unknown status never reaches execute", () => {
    const parsed = flakyTestDetect.inputSchema.safeParse({
      runs: [{ tests: [{ id: "t", status: "flaked" }] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("a run id is optional and is filled in positionally", async () => {
    const report = await call<{ tests: Array<{ failureGroups: Array<{ runs: string[] }> }> }>(
      flakyTestDetect,
      {
        runs: [
          { tests: [{ id: "t", status: "fail", error: "boom" }] },
          { tests: [{ id: "t", status: "pass" }] },
        ],
      },
    );
    expect(report.tests[0]?.failureGroups[0]?.runs).toEqual(["run-1"]);
  });
});
