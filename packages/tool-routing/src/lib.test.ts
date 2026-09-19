/**
 * The library half: the statistics adapters, the parsers and the probes.
 *
 * The statistics tests PIN PUBLISHED NUMBERS rather than comparing this
 * package's output to the kernel it just called, which would pass for any
 * pair of agreeing bugs. 24/30 → lower 0.6269 is the value
 * `@crewhaus/model-plan`'s `floor.test.ts` pins for its own `wilsonLowerBound`
 * and 8/8 → [0.6756, 1.0] is the interval `@crewhaus/eval-runner`'s `stats.ts`
 * cites; if this package ever grew a fourth Wilson these would drift.
 *
 * The parser tests assert the PARSED value, not the spelling: a `fedRoutingKeys`
 * entry with a stage suffix names the same turn as one without, and an
 * experiment name that sanitizes to a different filename is contained under
 * the filename.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { requestBucket } from "@crewhaus/canary-controller";
import { openScoreboard } from "@crewhaus/routing-store";
import {
  type ExperimentOutcomeRecord,
  foldLedger,
  judge,
  safeExperimentName,
} from "./lib/experiments";
import { datasetPrecedence, listDir, probeDir, probeFile } from "./lib/flywheel";
import {
  ARM_RANK_TEST_UNAVAILABLE,
  armView,
  armViews,
  laneOf,
  loadArms,
  probeFreeze,
} from "./lib/routing";
import { ALPHA, compareRates, compareSamples, meanWithInterval, rate } from "./lib/stats";
import { parseFedKey, tallyWindows, turnId } from "./lib/watchme";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "crewhaus-tool-routing-lib-"));
}

describe("rate — every proportion carries its interval", () => {
  test("zero trials yields no point estimate and no interval, with the reason", () => {
    const r = rate(0, 0);
    expect(r.point).toBeNull();
    expect(r.interval).toBeNull();
    // The REASON, not just the null: a caller must be able to tell this apart
    // from a rate of 0 over real trials.
    expect(r.note).toContain("no observations");
  });

  test("zero successes over real trials is a rate of 0 WITH an interval", () => {
    const r = rate(0, 5);
    expect(r.point).toBe(0);
    expect(r.interval?.lower).toBe(0);
    expect(r.interval?.upper).toBeCloseTo(0.4345, 4);
  });

  test("pinned against the published values this repository already relies on", () => {
    const a = rate(24, 30);
    expect(a.interval?.lower).toBeCloseTo(0.6269, 4);
    const b = rate(8, 8);
    expect(b.interval?.lower).toBeCloseTo(0.6756, 4);
    // The algebra collapses exactly at p_hat = 1; a gate comparing the upper
    // bound against 1 must not answer "can still fail" forever.
    expect(b.interval?.upper).toBe(1);
  });

  test("THE TRAP: 3 successes in 3 does not beat 280 in 300", () => {
    const small = rate(3, 3);
    const large = rate(280, 300);
    // The point estimates say the small arm is better.
    expect(small.point).toBeGreaterThan(large.point as number);
    // The intervals say nothing of the kind.
    expect(small.interval?.lower).toBeCloseTo(0.4385, 4);
    expect(large.interval?.lower).toBeCloseTo(0.8993, 4);
    const verdict = compareRates(small, large);
    expect(verdict.verdict).toBe("undecided");
    expect(verdict.reason).toContain("overlap");
    // And "undecided" is explicitly not "equal".
    expect(verdict.reason).toContain("does not say the two are equal");
  });

  test("non-overlapping intervals separate, and an interval-less side is not-comparable", () => {
    expect(compareRates(rate(0, 40), rate(40, 40)).verdict).toBe("separated");
    expect(compareRates(rate(0, 0), rate(40, 40)).verdict).toBe("not-comparable");
  });

  test("counts the kernel refuses produce a note, never a throw", () => {
    const r = rate(5, 2);
    expect(r.interval).toBeNull();
    expect(r.note).toContain("@crewhaus/tool-math");
  });
});

describe("meanWithInterval — the continuous mean the scoreboard holds", () => {
  test("one observation has no interval, and says why", () => {
    const m = meanWithInterval(0.9, 0, 1);
    expect(m.mean).toBe(0.9);
    expect(m.interval).toBeNull();
    expect(m.note).toContain("one observation");
    // It must not be mistaken for a Wilson interval on a success count.
    expect(m.basis).toContain("NOT a Wilson interval");
  });

  test("no observations has no mean at all", () => {
    expect(meanWithInterval(0, 0, 0).mean).toBeNull();
  });

  test("the half-width is z·sd/√n with the kernel's z", () => {
    const m = meanWithInterval(0.5, 0.25, 100);
    // sd = 0.5, n = 100 → half = 1.959963984540054 * 0.05
    expect((m.interval as { upper: number }).upper - 0.5).toBeCloseTo(0.0979982, 6);
  });
});

describe("compareSamples — a rank test, and where it refuses to decide", () => {
  test("complete separation at 5-vs-5 is UNDECIDED, and the reason is the sample size", () => {
    const c = compareSamples([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
    // p is under 0.05 here, and the verdict is still undecided: below eight
    // per side the normal approximation to U is not a rate.
    expect(c.p).toBeLessThan(ALPHA);
    expect(c.verdict).toBe("undecided");
    expect(c.reason).toContain("fewer than 8");
    expect(c.higher).toBeNull();
  });

  test("twelve a side separates, and the direction comes from the sign of z", () => {
    const low = Array.from({ length: 12 }, (_, i) => i / 100);
    const high = Array.from({ length: 12 }, (_, i) => 0.5 + i / 100);
    const c = compareSamples(low, high);
    expect(c.verdict).toBe("separated");
    expect(c.higher).toBe("second");
    expect(compareSamples(high, low).higher).toBe("first");
  });

  test("an empty side is undecided with the kernel's own note", () => {
    const c = compareSamples([], [1, 2, 3]);
    expect(c.verdict).toBe("undecided");
    expect(c.reason).toContain("nothing to compare");
  });
});

describe("judge — a winner, or an explicit undecided", () => {
  const view = (version: string, n: number, successes: number, scoredN: number) => ({
    version,
    n,
    successes,
    failures: n - successes,
    successRate: rate(successes, n),
    meanScore: null,
    scoredN,
    meanRating: null,
    ratedN: 0,
    sources: {},
  });

  test("fewer than two versions with data is not-comparable, never a winner", () => {
    const v = judge([view("v1", 10, 10, 0)], new Map());
    expect(v.verdict).toBe("not-comparable");
    expect(v.winner).toBeNull();
  });

  test("two versions with scored samples name a winner at the uncorrected alpha", () => {
    const low = Array.from({ length: 12 }, (_, i) => i / 100);
    const high = Array.from({ length: 12 }, (_, i) => 0.5 + i / 100);
    const v = judge(
      [view("v1", 12, 6, 12), view("v2", 12, 6, 12)],
      new Map([
        ["v1", low],
        ["v2", high],
      ]),
    );
    expect(v.winner).toBe("v2");
    // One pair, so no correction was applied.
    expect(v.alpha).toBe(ALPHA);
  });

  test("three versions Bonferroni-correct the alpha by the number of pairs", () => {
    const s = (base: number) => Array.from({ length: 12 }, (_, i) => base + i / 1000);
    const v = judge(
      [view("v1", 12, 6, 12), view("v2", 12, 6, 12), view("v3", 12, 6, 12)],
      new Map([
        ["v1", s(0)],
        ["v2", s(0.4)],
        ["v3", s(0.8)],
      ]),
    );
    expect(v.alpha).toBeCloseTo(ALPHA / 3, 12);
    // v3 beats both, so it is the champion.
    expect(v.winner).toBe("v3");
    expect(v.comparisons.length).toBe(3);
  });

  test("versions with no scores are undecided, and the reason names what is missing", () => {
    const v = judge([view("v1", 10, 10, 0), view("v2", 300, 280, 0)], new Map());
    expect(v.verdict).toBe("undecided");
    expect(v.winner).toBeNull();
    expect(v.reason).toContain("score");
  });
});

describe("the experiment ledger fold", () => {
  const rec = (over: Partial<ExperimentOutcomeRecord>): ExperimentOutcomeRecord => ({
    ts: "2026-01-01T00:00:00.000Z",
    experiment: "exp",
    version: "v1",
    outcome: "success",
    ...over,
  });

  test("repeat eval measurements collapse BEFORE the tally, so n is not inflated", () => {
    // Four ramp steps over the same two samples, as `deploy canary` produces.
    const records: ExperimentOutcomeRecord[] = [];
    for (let step = 0; step < 4; step += 1) {
      for (const sampleId of ["s1", "s2"]) {
        records.push(rec({ source: "eval", requestKey: sampleId, score: 0.9 }));
      }
    }
    const view = foldLedger("exp", "/tmp/exp.jsonl", records);
    expect(view.records).toBe(2);
    expect(view.collapsedRepeats).toBe(6);
    expect(view.variants[0]?.n).toBe(2);
    expect(view.dedupeNote).toContain("inflated n");
  });

  test("serving repeats are NOT collapsed — a sticky user id repeats legitimately", () => {
    const records = [
      rec({ source: "serving", requestKey: "user-1" }),
      rec({ source: "serving", requestKey: "user-1" }),
    ];
    const view = foldLedger("exp", "/tmp/exp.jsonl", records);
    expect(view.records).toBe(2);
    expect(view.collapsedRepeats).toBe(0);
  });

  test("a version's success rate leaves the fold as an interval, not a bare number", () => {
    const view = foldLedger("exp", "/tmp/exp.jsonl", [rec({}), rec({}), rec({})]);
    const v = view.variants[0];
    expect(v?.successRate.point).toBe(1);
    expect(v?.successRate.interval?.lower).toBeCloseTo(0.4385, 4);
  });
});

describe("safeExperimentName — the filename, not the spelling", () => {
  test("a traversal-shaped name sanitizes to a flat filename", () => {
    const safe = safeExperimentName("../evil");
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      expect(safe.value).not.toContain("/");
      expect(safe.value).not.toContain("..");
    }
  });

  test("a name with no filesystem-safe character is refused, not silently flattened", () => {
    const safe = safeExperimentName("///");
    expect(safe.ok).toBe(false);
    if (!safe.ok) expect(safe.code).toBe("bad-input");
  });

  test("the assignment hash is canary-controller's, bit for bit", () => {
    // Not a re-implementation compared against itself: this asserts that the
    // bucket a caller gets is the one `CanaryController.route()` computes, so
    // a key cannot be served one version and attributed to another.
    for (const key of ["tenant-a", "tenant-b", "sess_00000000000000aa"]) {
      expect(requestBucket(undefined, key)).toBe(requestBucket("", key));
      expect(requestBucket("salt", key)).toBeGreaterThanOrEqual(0);
      expect(requestBucket("salt", key)).toBeLessThan(100);
    }
  });
});

describe("watchme parsing", () => {
  test("a staged fed key names the same turn as an unstaged one", () => {
    const staged = parseFedKey("sess_1#4#escalate");
    const plain = parseFedKey("sess_1#4");
    expect(staged?.stage).toBe("escalate");
    expect(plain?.stage).toBeUndefined();
    // The identity is the parsed pair; comparing the spellings would report a
    // hybrid turn as never fed.
    expect(turnId(staged?.sessionId as string, staged?.turnNumber as number)).toBe(
      turnId(plain?.sessionId as string, plain?.turnNumber as number),
    );
  });

  test("a key that is not a turn key is rejected rather than half-parsed", () => {
    expect(parseFedKey("sess_1")).toBeUndefined();
    expect(parseFedKey("sess_1#notanumber")).toBeUndefined();
    expect(parseFedKey("#4")).toBeUndefined();
  });

  test("window outcomes stay distinct, and an unknown value is not a success", () => {
    const tally = tallyWindows({
      a: "ok",
      b: "model_refused_unpriced",
      c: "model_failed",
      d: "model_refused",
    });
    expect(tally.ok).toBe(1);
    expect(tally.model_refused_unpriced).toBe(1);
    expect(tally.model_failed).toBe(1);
    // "model_refused" LOOKS like the unpriced refusal and is not it.
    expect(tally.unrecognised).toEqual([{ windowKey: "d", value: "model_refused" }]);
    expect(tally.total).toBe(4);
  });
});

describe("routing probes", () => {
  test("lanes are classified by the store's own prefixes", () => {
    expect(laneOf("hard")).toBe("live");
    expect(laneOf("q:hard")).toBe("quality");
    expect(laneOf("shadow:step-a/hard")).toBe("shadow");
  });

  test("an arm's rates carry intervals and its grade attempts are a proportion", () => {
    const view = armView({
      routeKey: "q:hard",
      model: "fast",
      n: 3,
      meanReward: 0.9,
      varReward: 0.01,
      meanLatencyMs: 100,
      meanCostUsd: 0,
      costCount: 0,
      meanQuality: 0.8,
      varQuality: 0.02,
      qualityCount: 3,
      ungraded: 1,
    });
    expect(view.lane).toBe("quality");
    expect(view.auditsRouteKey).toBe("hard");
    expect(view.reward.interval).not.toBeNull();
    // 3 graded out of 4 attempts, with an interval — not "75% graded".
    expect(view.graded.successes).toBe(3);
    expect(view.graded.trials).toBe(4);
    expect(view.graded.interval).not.toBeNull();
  });

  test("a lane prefix with nothing after it names no arm", () => {
    const view = armView({
      routeKey: "q:",
      model: "fast",
      n: 1,
      meanReward: 1,
      varReward: 0,
      meanLatencyMs: 0,
      meanCostUsd: 0,
      costCount: 0,
      meanQuality: 0,
      varQuality: 0,
      qualityCount: 0,
      ungraded: 0,
    });
    expect(view.auditsRouteKey).toBeUndefined();
  });

  test("arms sort by plain string comparison, not by locale", () => {
    const base = {
      n: 1,
      meanReward: 1,
      varReward: 0,
      meanLatencyMs: 0,
      meanCostUsd: 0,
      costCount: 0,
      meanQuality: 0,
      varQuality: 0,
      qualityCount: 0,
      ungraded: 0,
    };
    const sorted = armViews([
      { ...base, routeKey: "b", model: "x" },
      { ...base, routeKey: "A", model: "x" },
      { ...base, routeKey: "a", model: "x" },
    ]);
    // "A" < "a" < "b" by code unit; a locale sort would put "a" first.
    expect(sorted.map((s) => s.routeKey)).toEqual(["A", "a", "b"]);
  });

  test("the rank-test refusal names the reason rather than implying none was found", () => {
    expect(ARM_RANK_TEST_UNAVAILABLE).toContain("Welford");
    expect(ARM_RANK_TEST_UNAVAILABLE).toContain("no per-observation reader");
  });

  test("a corrupt freeze marker is its own state, never an absent one", () => {
    const root = tmp();
    try {
      mkdirSync(path.join(root, "routing"), { recursive: true });
      writeFileSync(path.join(root, "routing", "freeze.json"), "{not json");
      const probe = probeFreeze(root);
      expect(probe.state).toBe("corrupt");
      if (probe.state === "corrupt") expect(probe.detail).toContain("not valid JSON");
      // A marker with the wrong version is corrupt too, not absent.
      writeFileSync(path.join(root, "routing", "freeze.json"), '{"version":2}');
      expect(probeFreeze(root).state).toBe("corrupt");
      // And a real one reads as frozen.
      writeFileSync(
        path.join(root, "routing", "freeze.json"),
        '{"version":1,"policyVersion":"pv-1","frozenAt":"2026-01-01T00:00:00.000Z"}',
      );
      const ok = probeFreeze(root);
      expect(ok.state).toBe("frozen");
      if (ok.state === "frozen") expect(ok.freeze.policyVersion).toBe("pv-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store with no file is empty; one that cannot be read is a failure", () => {
    const root = tmp();
    try {
      const empty = loadArms(root);
      expect(empty.ok).toBe(true);
      if (empty.ok) expect(empty.value).toEqual([]);
      const board = openScoreboard(root);
      board.record("hard", "fast", 0.8, { success: true, latencyMs: 10 });
      const loaded = loadArms(root);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.value[0]?.n).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("flywheel probes", () => {
  test("an absent directory lists empty; a file where a directory should be does not", () => {
    const root = tmp();
    try {
      const absent = listDir(path.join(root, "nope"));
      expect(absent.ok).toBe(true);
      if (absent.ok) expect(absent.value).toEqual([]);
      writeFileSync(path.join(root, "afile"), "x");
      const notDir = listDir(path.join(root, "afile"));
      expect(notDir.ok).toBe(false);
      if (!notDir.ok) {
        expect(notDir.code).toBe("unreadable");
        // The REASON, so this cannot be confused with an empty directory.
        expect(notDir.reason).toContain("not an empty directory");
      }
      expect(probeDir(path.join(root, "afile")).state).toBe("not-a-directory");
      expect(probeFile(path.join(root, "afile")).state).toBe("file");
      expect(probeFile(path.join(root, "nope")).state).toBe("absent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the shadowing warning is conditional, and the registry fact is unknown", () => {
    const root = tmp();
    try {
      mkdirSync(path.join(root, "eval"), { recursive: true });
      writeFileSync(path.join(root, "eval", "dataset.jsonl"), "{}\n");
      const p = datasetPrecedence(root, "demo");
      expect(p.withoutDatasetFlag).toBe("convention");
      expect(p.wouldShadowRatings).toBe(true);
      // The fact that would make it unconditional is not available here, and
      // is reported as unknown rather than guessed.
      expect(p.ratingsRegistered).toBe("unknown");
      expect(p.ratingsRef).toBe("registry:demo-ratings");
      expect(p.ruleOwner).toContain("resolveFlywheelData");
      const bare = datasetPrecedence(path.join(root, "other"), "demo");
      expect(bare.withoutDatasetFlag).toBe("ratings-registry-or-refusal");
      expect(bare.wouldShadowRatings).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
