/**
 * 0.6.0 §6.3 (PR 14) — `crewhaus route promote [--gate]`.
 *
 * Two claims, both safety-bearing:
 *   1. the fold is REFUSED unless a routed (`as-declared`) eval with a pinned
 *      seed and a warm frozen arm snapshot passed its baseline gate — and
 *      every way that can be false is refused with a reason that names it; and
 *   2. on success the lanes fold AND a `routing_promotion` audit record is
 *      appended carrying the run that authorized it, so the promotion and its
 *      evidence sit in one hash chain.
 *
 * `--gate` decides only whether a refusal EXITS non-zero, mirroring
 * `crewhaus eval --gate`; the refusal itself is unconditional.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedRun, RunIndexEntry } from "@crewhaus/eval-report";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { openScoreboard } from "@crewhaus/routing-store";
import { parseRouteArgs, runRouteCommand } from "./route";
import { type PromotionGate, resolveRoutePromotionGate, runRoutePromote } from "./route-promote";

// ---------------------------------------------------------------------------
// Fixtures: the smallest run summaries `gateRuns` will compare.
// ---------------------------------------------------------------------------

type RoutingManifest = NonNullable<EvalRunSummary["config"]["routing"]>;

const ROUTING: RoutingManifest = {
  mode: "as-declared",
  armsDigest: "digest-1",
  warmArms: true,
  learningSeed: "424242",
  policyVersion: "pool-abc",
};

function summary(runId: string, passed: boolean, routing: RoutingManifest = ROUTING) {
  const score = passed ? 1 : 0;
  return {
    runId,
    config: { datasetName: "smoke", specHash: "hash", routing },
    aggregates: {
      passRate: passed ? 1 : 0,
      meanScore: score,
      p50LatencyMs: 10,
      p95LatencyMs: 10,
    },
    samples: [
      {
        sampleId: "s1",
        passed,
        grades: { overall: { score, passed } },
        latencyMs: 10,
      },
    ],
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:01:00.000Z",
  } as unknown as EvalRunSummary;
}

const loaded = (s: EvalRunSummary): LoadedRun => ({ summary: s, perSample: {} });

function indexEntry(over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: "run_new",
    specName: "support",
    specHash: "hash",
    datasetName: "smoke",
    datasetHash: "d",
    passRate: 1,
    meanScore: 1,
    sampleCount: 1,
    routing: "as-declared",
    armsDigest: "digest-1",
    policyVersion: "pool-abc",
    ts: "2026-09-01T00:01:00.000Z",
    outDir: "/runs/new",
    ...over,
  } as RunIndexEntry;
}

/** A gate resolver wired to in-memory index/baseline/run readers. */
function gateWith(opts: {
  entries: RunIndexEntry[];
  baseline?: { runId: string; outDir: string };
  legacyPresent?: boolean;
  runs: Record<string, EvalRunSummary>;
}): Promise<PromotionGate> {
  return resolveRoutePromotionGate({
    evalsDir: "/evals",
    readIndex: () => opts.entries,
    resolveBaseline: () =>
      opts.baseline === undefined
        ? { legacyPresent: opts.legacyPresent ?? false }
        : {
            entry: {
              specName: "support",
              datasetName: "smoke",
              runId: opts.baseline.runId,
              outDir: opts.baseline.outDir,
              datasetHash: "d",
              ts: "2026-08-01T00:00:00.000Z",
            },
            legacyPresent: false,
          },
    loadRun: async (dir) => {
      const s = opts.runs[dir];
      if (s === undefined) throw new Error(`no run at ${dir}`);
      return loaded(s);
    },
  });
}

const PASSING = {
  entries: [indexEntry()],
  baseline: { runId: "run_base", outDir: "/runs/base" },
  runs: { "/runs/new": summary("run_new", true), "/runs/base": summary("run_base", true) },
};

// ---------------------------------------------------------------------------

describe("resolveRoutePromotionGate — every way a promotion is refused", () => {
  test("no routed run recorded at all", async () => {
    const g = await gateWith({ entries: [], runs: {} });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("no `routing: as-declared` eval run is recorded");
  });

  test("only `static` runs recorded — an unrouted eval says nothing about the policy", async () => {
    const g = await gateWith({ entries: [indexEntry({ routing: undefined })], runs: {} });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("no `routing: as-declared` eval run is recorded");
  });

  test("a budget-aborted (partial) run cannot authorize", async () => {
    const g = await gateWith({ ...PASSING, entries: [indexEntry({ partial: true })] });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("budget-aborted");
  });

  test("a cassette-replayed run cannot authorize", async () => {
    const g = await gateWith({ ...PASSING, entries: [indexEntry({ replayed: true })] });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("replayed recorded tool cassettes");
  });

  test("an unseeded routed run cannot authorize", async () => {
    const { learningSeed: _drop, ...unseeded } = ROUTING;
    const g = await gateWith({
      ...PASSING,
      runs: {
        ...PASSING.runs,
        "/runs/new": summary("run_new", true, unseeded as RoutingManifest),
      },
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("pinned no `model_pool.learning.seed`");
  });

  test("a COLD arm snapshot cannot authorize — every arm answers n=0", async () => {
    const g = await gateWith({
      ...PASSING,
      runs: {
        ...PASSING.runs,
        "/runs/new": summary("run_new", true, { ...ROUTING, warmArms: false }),
      },
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("COLD arm snapshot");
  });

  test("a routed lineage with only the legacy unrouted pin is refused (§6.1 — a run must not gate against itself)", async () => {
    const g = await gateWith({ ...PASSING, baseline: undefined, legacyPresent: true });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("no baseline of its own yet");
  });

  test("a lineage whose pinned baseline IS the newest run is refused", async () => {
    const g = await gateWith({ ...PASSING, baseline: { runId: "run_new", outDir: "/runs/new" } });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("cannot gate against itself");
  });

  test("a FAILING baseline gate is refused, and the gate's own reason is surfaced", async () => {
    const g = await gateWith({
      ...PASSING,
      runs: { "/runs/new": summary("run_new", false), "/runs/base": summary("run_base", true) },
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("FAILED its baseline gate");
  });

  test("two runs off DIFFERENT arm snapshots are two instruments — refused by the digest guard", async () => {
    const g = await gateWith({
      ...PASSING,
      runs: {
        "/runs/new": summary("run_new", true),
        "/runs/base": summary("run_base", true, { ...ROUTING, armsDigest: "digest-2" }),
      },
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain("armsDigest");
  });

  test("a passing routed run authorizes, and carries the evidence forward", async () => {
    const g = await gateWith(PASSING);
    expect(g.passed).toBe(true);
    expect(g).toMatchObject({
      specName: "support",
      datasetName: "smoke",
      candidateRunId: "run_new",
      baselineRunId: "run_base",
      routing: "as-declared",
      armsDigest: "digest-1",
      policyVersion: "pool-abc",
      learningSeed: "424242",
    });
    expect(g.warnings).toEqual([]);
  });

  test("a mid-run live-arms mutation is a WARNING, not a refusal", async () => {
    const g = await gateWith({
      ...PASSING,
      runs: {
        ...PASSING.runs,
        "/runs/new": summary("run_new", true, { ...ROUTING, armsMutated: true }),
      },
    });
    expect(g.passed).toBe(true);
    expect(g.warnings[0]).toContain("live arms.jsonl changed");
  });

  test("`--spec` restricts which run may authorize", async () => {
    const g = await resolveRoutePromotionGate({
      evalsDir: "/evals",
      specName: "other",
      readIndex: () => [indexEntry()],
      loadRun: async () => loaded(summary("run_new", true)),
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toContain('for spec "other"');
  });
});

// ---------------------------------------------------------------------------

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-route-promote-"));
  mkdirSync(join(root, "routing"), { recursive: true });
  const sb = openScoreboard(root, { now: () => 1 });
  sb.record("q:hard", "fast", 0.9, { success: true, latencyMs: 10, quality: 0.9 });
  sb.record("shadow:hard", "strong", 0.8, { success: true, latencyMs: 10, quality: 0.8 });
  return root;
}

const refusing = (reason: string) => async (): Promise<PromotionGate> => ({
  passed: false,
  reason,
  warnings: [],
});
const passing = async (): Promise<PromotionGate> => ({
  passed: true,
  reason: "routed run run_new passed its baseline gate against run_base",
  specName: "support",
  datasetName: "smoke",
  candidateRunId: "run_new",
  baselineRunId: "run_base",
  routing: "as-declared",
  armsDigest: "digest-1",
  learningSeed: "424242",
  warnings: [],
});

describe("runRoutePromote — refuse without a gate, fold + audit with one", () => {
  test("a refused promotion writes NOTHING and still reports what is waiting", async () => {
    const root = seededRoot();
    const out = await runRoutePromote({
      rootDir: root,
      gate: false,
      dryRun: false,
      json: false,
      resolveGate: refusing("no `routing: as-declared` eval run is recorded"),
      openAudit: async () => {
        throw new Error("must not open the audit log on a refusal");
      },
    });
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("REFUSED");
    expect(out.text).toContain("2 lane observation(s)");
    // The live arms are untouched — the whole point of the refusal.
    expect(openScoreboard(root).score("hard", "fast")).toBeUndefined();
    expect(openScoreboard(root).score("hard", "strong")).toBeUndefined();
  });

  test("--gate maps the same refusal to exit 1", async () => {
    const out = await runRoutePromote({
      rootDir: seededRoot(),
      gate: true,
      dryRun: false,
      json: false,
      resolveGate: refusing("routed run run_new FAILED its baseline gate"),
    });
    expect(out.exitCode).toBe(1);
    expect(out.text).toContain("FAILED its baseline gate");
  });

  test("a passing gate folds the lanes AND appends one routing_promotion audit record", async () => {
    const root = seededRoot();
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const out = await runRoutePromote({
      rootDir: root,
      gate: true,
      dryRun: false,
      json: false,
      resolveGate: passing,
      openAudit: async () => ({
        append: async (input) => {
          appended.push(input);
          return { seq: 7 };
        },
      }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.result?.lines).toBe(2);
    // The lanes are now live arms.
    const sb = openScoreboard(root);
    expect(sb.score("hard", "fast")?.n).toBe(1);
    expect(sb.score("hard", "strong")?.meanQuality).toBeCloseTo(0.8, 12);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.kind).toBe("routing_promotion");
    const payload = appended[0]?.payload as Record<string, unknown>;
    expect(payload["lines"]).toBe(2);
    expect(payload["dryRun"]).toBe(false);
    expect(payload["gate"]).toMatchObject({
      passed: true,
      specName: "support",
      candidateRunId: "run_new",
      baselineRunId: "run_base",
      armsDigest: "digest-1",
      learningSeed: "424242",
    });
    expect((payload["lanes"] as unknown[]).length).toBe(2);
    expect(out.text).toContain("routing_promotion record (seq 7)");
  });

  test("--dry-run under a passing gate folds nothing and appends nothing", async () => {
    const root = seededRoot();
    let opened = false;
    const out = await runRoutePromote({
      rootDir: root,
      gate: false,
      dryRun: true,
      json: false,
      resolveGate: passing,
      openAudit: async () => {
        opened = true;
        return { append: async () => ({ seq: 0 }) };
      },
    });
    expect(opened).toBe(false);
    expect(out.text).toContain("--dry-run");
    expect(openScoreboard(root).score("hard", "fast")).toBeUndefined();
  });

  test("nothing in the lanes: a passing gate promotes zero and writes no audit record", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-route-promote-empty-"));
    let opened = false;
    const out = await runRoutePromote({
      rootDir: root,
      gate: true,
      dryRun: false,
      json: false,
      resolveGate: passing,
      openAudit: async () => {
        opened = true;
        return { append: async () => ({ seq: 0 }) };
      },
    });
    expect(opened).toBe(false);
    expect(out.text).toContain("Nothing to promote");
    expect(out.exitCode).toBe(0);
  });

  test("--json emits the gate and the fold as one machine-readable object", async () => {
    const out = await runRoutePromote({
      rootDir: seededRoot(),
      gate: false,
      dryRun: true,
      json: true,
      resolveGate: passing,
    });
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(parsed["promoted"]).toBe(false);
    expect((parsed["gate"] as Record<string, unknown>)["passed"]).toBe(true);
    expect((parsed["result"] as Record<string, unknown>)["lines"]).toBe(2);
  });
});

describe("parseRouteArgs — the promote surface", () => {
  test("accepts the flags, and only where they belong", () => {
    expect(parseRouteArgs(["promote"])).toEqual({ sub: "promote", dir: ".crewhaus" });
    expect(
      parseRouteArgs([
        "promote",
        "--gate",
        "--dry-run",
        "--json",
        "--spec",
        "support",
        "--dir",
        "/tmp/x",
      ]),
    ).toEqual({
      sub: "promote",
      dir: "/tmp/x",
      gate: true,
      dryRun: true,
      json: true,
      spec: "support",
    });
    expect(() => parseRouteArgs(["status", "--gate"])).toThrow('unknown argument "--gate"');
    expect(() => parseRouteArgs(["promote", "--spec"])).toThrow("--spec requires a spec name");
  });

  test("runRouteCommand still serves the synchronous subcommands", async () => {
    const root = mkdtempSync(join(tmpdir(), "crewhaus-route-cmd-"));
    const out = await runRouteCommand(["status", "--dir", root]);
    expect(out.exitCode).toBe(0);
    expect(out.text).toContain("No routing data yet");
  });

  test("runRouteCommand routes `promote` through the async path", async () => {
    const root = seededRoot();
    // No evals dir exists under this root, so the gate refuses for the honest
    // reason — and the whole dispatch is exercised end to end.
    const out = await runRouteCommand(["promote", "--gate", "--dir", root]);
    expect(out.exitCode).toBe(1);
    expect(out.text).toContain("no `routing: as-declared` eval run is recorded");
  });
});
