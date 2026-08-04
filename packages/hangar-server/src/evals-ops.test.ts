/**
 * The quality lab's rules, each pinned by the failure it prevents:
 *
 *   - a PARTIAL run must never move the trend line (it reads deflated
 *     because its aborted samples counted as errors);
 *   - a RESUMED run must be counted once, not N+1 times;
 *   - agent spend and judge spend must stay apart (the judge often costs
 *     more than the thing it is judging);
 *   - a billing-class matrix crash must NOT offer Retry — a real
 *     out-of-funds arrives as a 429 that no amount of retrying fixes;
 *   - a PARTIAL suite entry fails even when the suite file recorded a pass;
 *   - the locked test split cannot be spent without the release-flow
 *     confirmation, and nothing from a request body can append a flag;
 *   - sentinel attribution is conditional on all four hashes matching;
 *   - an eval-sample annotation is never dropped, and the F-7 join state is
 *     reported honestly rather than faked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCellError, datasetFilterMatches, describeCellCrash, wilson95 } from "./evals-ops";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (body["entry"] as { id: string }).id;
}

function writeJson(dir: string, relative: readonly string[], value: unknown): void {
  const path = join(dir, ...relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A harness with matrix cells, a suite run, a sentinel baseline and a
 *  resumed + partial eval history. */
function labHarness(t: TestServer): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "lab"), {
    specName: "lab",
    evalIndex: [
      // A resumed run: the SAME runId twice. Only the newer line counts.
      {
        runId: "run_000000000000aa01",
        specName: "lab",
        specHash: "spec-1",
        datasetName: "smoke",
        datasetHash: "data-1",
        gradersHash: "grade-1",
        judgeModel: "judge-1",
        passRate: 0.2,
        meanScore: 0.2,
        sampleCount: 2,
        agentCostUsd: 0.1,
        judgeCostUsd: 0.4,
        ts: iso(NOW - 3 * DAY),
        outDir: "/gone",
      },
      {
        runId: "run_000000000000aa01",
        specName: "lab",
        specHash: "spec-1",
        datasetName: "smoke",
        datasetHash: "data-1",
        gradersHash: "grade-1",
        judgeModel: "judge-1",
        passRate: 0.9,
        meanScore: 0.9,
        sampleCount: 10,
        agentCostUsd: 0.1,
        judgeCostUsd: 0.4,
        ts: iso(NOW - 2 * DAY),
        outDir: "/gone",
      },
      // A budget-aborted run on the regression UNION of the same dataset.
      {
        runId: "run_000000000000aa02",
        specName: "lab",
        specHash: "spec-1",
        datasetName: "smoke+regressions@v2",
        datasetHash: "data-1",
        gradersHash: "grade-1",
        judgeModel: "judge-1",
        passRate: 0.1,
        meanScore: 0.1,
        sampleCount: 3,
        partial: true,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
    ],
    evalRuns: [
      {
        runId: "run_000000000000aa01",
        results: { passRate: 0.9, sampleCount: 10 },
        samples: { s1: { grades: { pass: true }, meta: { latencyMs: 5 } } },
      },
    ],
  });
  // A matrix run whose one cell died on a quota exhaustion.
  writeJson(dir, [".crewhaus", "evals", "matrix_00ff00ff", "matrix.json"], {
    generatedAt: iso(NOW - DAY),
    datasetName: "smoke",
    rows: [
      {
        model: "vendor/fast",
        slug: "vendor-fast",
        outDir: "/gone",
        status: "ok",
        passRate: 0.8,
        meanScore: 0.7,
        sampleCount: 5,
        costPer1kSamplesUsd: 1.5,
      },
      {
        model: "vendor/slow",
        slug: "vendor-slow",
        outDir: "/gone",
        status: "error",
        error: "429 You exceeded your current quota, please check your plan and billing details.",
      },
    ],
    best: { passRate: ["vendor/fast"], meanScore: [], p95LatencyMs: [], costPer1kSamplesUsd: [] },
  });
  mkdirSync(join(dir, ".crewhaus", "evals", "matrix_00ff00ff", "vendor-fast"), { recursive: true });
  // A suite whose file claims a pass on an entry that ended early.
  writeJson(dir, [".crewhaus", "evals", "suite_fast_20260802T000000Z", "suite.json"], {
    startedAt: iso(NOW - DAY),
    passed: true,
    entries: [
      { name: "core", passed: true, aggregates: { passRate: 1, meanScore: 1 }, min_pass_rate: 0.9 },
      {
        name: "long-tail",
        passed: true,
        partial: true,
        aggregates: { passRate: 0.4, meanScore: 0.4 },
        min_pass_rate: 0.8,
        failures: [],
      },
    ],
  });
  // A frozen sentinel baseline whose instrument no longer matches the runs.
  writeJson(dir, ["eval", "sentinel-baseline", "run.json"], {
    runId: "run_000000000000bb01",
    startedAt: iso(NOW - 10 * DAY),
    config: {
      specHash: "spec-1",
      datasetHash: "data-1",
      gradersHash: "grade-OLD",
      judgeModel: "judge-1",
    },
  });
  return dir;
}

describe("pure eval rules", () => {
  test("a dataset filter matches its regression union, not just the exact name", () => {
    expect(datasetFilterMatches("smoke", "smoke")).toBe(true);
    expect(datasetFilterMatches("smoke", "smoke+regressions@v2")).toBe(true);
    // …but not a different dataset that merely starts with the same letters.
    expect(datasetFilterMatches("smoke", "smoketest")).toBe(false);
  });

  test("a quota-exhaustion 429 classifies as BILLING and is not retryable", () => {
    const quota = "429 You exceeded your current quota, please check your plan and billing details";
    expect(classifyCellError(quota)).toBe("billing");
    const crash = describeCellCrash(quota);
    expect(crash.retryable).toBe(false);
    expect(crash.remedy).toContain("credits");
    // A plain rate limit IS retryable — the two share a status code and
    // nothing else.
    expect(classifyCellError("429 rate limit exceeded, please slow down")).toBe("transient");
    expect(describeCellCrash("429 rate limit exceeded").retryable).toBe(true);
    // Auth/model errors are deterministic: retrying cannot change them.
    expect(classifyCellError("404 unknown model vendor/nope")).toBe("systemic");
    expect(describeCellCrash("401 invalid api key").retryable).toBe(false);
  });

  test("wilson95 brackets the point estimate and refuses an empty sample", () => {
    expect(wilson95(0, 0)).toBeUndefined();
    const ci = wilson95(8, 10) as [number, number];
    expect(ci[0]).toBeLessThan(0.8);
    expect(ci[1]).toBeGreaterThan(0.8);
    expect(ci[0]).toBeGreaterThanOrEqual(0);
    expect(ci[1]).toBeLessThanOrEqual(1);
  });
});

describe("trends", () => {
  test("collapse resumed runs, keep partials off the delta, and split judge spend", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/evals/trends`);
    expect(status).toBe(200);
    const series = body["series"] as Array<{
      datasetName: string;
      points: Array<{ runId: string; passRate: number; partial?: boolean }>;
      measuredCount: number;
      partialCount: number;
      deltaPp: number | null;
    }>;
    const smoke = series.find((s) => s.datasetName === "smoke") as (typeof series)[number];
    // The resumed run occupies two index lines and exactly one point, with
    // the NEWER figures — counting it twice would drag the average down with
    // a pass rate the run never finished at.
    expect(smoke.points.length).toBe(1);
    expect(smoke.points[0]?.passRate).toBe(0.9);

    const union = series.find(
      (s) => s.datasetName === "smoke+regressions@v2",
    ) as (typeof series)[number];
    expect(union.partialCount).toBe(1);
    expect(union.measuredCount).toBe(0);
    // One partial point is not a trend, and must never be read as a drop.
    expect(union.deltaPp).toBeNull();

    const spend = body["spend"] as { agentUsd: number; judgeUsd: number; judgeShare: number };
    expect(spend.agentUsd).toBeCloseTo(0.1, 6);
    expect(spend.judgeUsd).toBeCloseTo(0.4, 6);
    expect(spend.judgeShare).toBeCloseTo(0.8, 6);
  });

  test("a dataset filter keeps the regression-unioned run visible", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const { body } = await t.api(`/api/h/${id}/evals/trends?dataset=smoke`);
    const names = (body["series"] as Array<{ datasetName: string }>).map((s) => s.datasetName);
    expect(names).toContain("smoke");
    expect(names).toContain("smoke+regressions@v2");
  });
});

describe("matrix + suites", () => {
  test("matrix cells come from the out-dirs and carry a classified crash", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const { body } = await t.api(`/api/h/${id}/evals/matrix`);
    expect(body["present"]).toBe(true);
    const cells = body["cells"] as Array<{
      cell: string;
      status: string;
      crash: { kind: string; retryable: boolean } | null;
    }>;
    expect(cells.map((c) => c.cell).sort()).toEqual(["vendor-fast", "vendor-slow"]);
    const dead = cells.find((c) => c.cell === "vendor-slow") as (typeof cells)[number];
    expect(dead.crash?.kind).toBe("billing");
    expect(dead.crash?.retryable).toBe(false);
    expect(body["crashed"]).toBe(1);

    const cellRes = await t.api(`/api/h/${id}/evals/matrix/vendor-slow`);
    expect(cellRes.status).toBe(200);
    expect((cellRes.body["crash"] as { kind: string }).kind).toBe("billing");
  });

  test("a PARTIAL suite entry fails even when the suite file recorded a pass", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const { body } = await t.api(`/api/h/${id}/evals/suites`);
    const suites = body["suites"] as Array<{
      tier: string;
      passed: boolean;
      partialEntries: number;
      entries: Array<{ name: string; passed: boolean; partial: boolean; minPassRate: number }>;
    }>;
    expect(suites.length).toBe(1);
    const suite = suites[0] as (typeof suites)[number];
    expect(suite.tier).toBe("fast");
    expect(suite.entries.find((e) => e.name === "core")?.passed).toBe(true);
    const tail = suite.entries.find(
      (e) => e.name === "long-tail",
    ) as (typeof suite.entries)[number];
    expect(tail.partial).toBe(true);
    expect(tail.passed).toBe(false);
    expect(tail.minPassRate).toBe(0.8);
    // …and one failed entry sinks the tier verdict the file claimed.
    expect(suite.passed).toBe(false);
  });
});

describe("the launcher", () => {
  test("builds argv from a closed vocabulary and never lets a body append a flag", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const ok = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", repeats: 3, seed: 7, gate: true }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body["argv"]).toEqual([
      "eval",
      "crewhaus.yaml",
      "--dataset",
      "smoke",
      "--repeats",
      "3",
      "--seed",
      "7",
      "--gate",
    ]);

    const injected = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke --allow-test-split" }),
    });
    expect(injected.status).toBe(400);
  });

  test("the locked test split needs the release-flow confirmation", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const refused = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", allowTestSplit: true }),
    });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("releaseConfirm");

    const spent = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", allowTestSplit: true, releaseConfirm: true }),
    });
    expect(spent.status).toBe(200);
    expect(spent.body["argv"]).toContain("--allow-test-split");
    expect((spent.body["warnings"] as string[]).join(" ")).toContain("burn");
  });

  test("warns when a conventional dataset file shadows the ratings registry", async () => {
    const t = boot();
    const dir = labHarness(t);
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), '{"id":"a","input":"x"}\n');
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect((body["warnings"] as string[]).join(" ")).toContain("lab-ratings");
    const fly = await t.api(`/api/h/${id}/evals/flywheel`);
    expect((fly.body["datasetPrecedence"] as { shadowing: boolean }).shadowing).toBe(true);
  });
});

describe("the drift sentinel", () => {
  test("refuses to blame the provider when the measurement instrument moved", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const { body } = await t.api(`/api/h/${id}/evals/sentinel`);
    expect(body["present"]).toBe(true);
    const attribution = body["attribution"] as {
      comparable: boolean;
      providerDrift: boolean;
      mismatches: string[];
      reason: string;
    };
    expect(attribution.providerDrift).toBe(false);
    expect(attribution.mismatches.join(" ")).toContain("gradersHash");
    expect(attribution.reason).toContain("not attributable");
  });
});

describe("F-7 — the annotation → distill join", () => {
  test("records the annotation run-scoped and reports why distill cannot reach it", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const res = await t.api(`/api/h/${id}/evals/run_000000000000aa01/s1/annotate`, {
      method: "POST",
      body: JSON.stringify({ verdict: "fail", note: "missed the constraint" }),
    });
    expect(res.status).toBe(200);
    // No session id on the sample's meta ⇒ no valid FeedbackRecord exists to
    // write. The annotation is still kept, and the reason is stated.
    expect(res.body["feedbackRecord"]).toBeNull();
    const join = res.body["join"] as { state: string; upstreamFix: string };
    expect(join.state).toBe("no-session-id");
    expect(join.upstreamFix).toContain("F-7");

    const listed = await t.api(`/api/h/${id}/evals/annotations`);
    const summary = listed.body["join"] as { total: number; resolvable: number };
    expect(summary.total).toBe(1);
    expect(summary.resolvable).toBe(0);
    const rows = listed.body["annotations"] as Array<{ sampleId: string; verdict: string }>;
    expect(rows[0]?.sampleId).toBe("s1");
    expect(rows[0]?.verdict).toBe("fail");
    // The console says so out loud rather than showing an empty pipeline.
    expect(String(listed.body["note"])).toContain("cannot reach distill");
  });

  test("writes a real FeedbackRecord when the sample recorded a session id", async () => {
    const t = boot();
    const dir = labHarness(t);
    writeJson(dir, [".crewhaus", "evals", "run_000000000000aa01", "s1", "meta.json"], {
      sessionId: "sess_00000000000000ab",
      turnNumber: 2,
    });
    const id = await register(t, dir);
    const res = await t.api(`/api/h/${id}/evals/run_000000000000aa01/s1/annotate`, {
      method: "POST",
      body: JSON.stringify({ verdict: "pass" }),
    });
    const record = res.body["feedbackRecord"] as { sessionId: string; adjudication: boolean };
    expect(record.sessionId).toBe("sess_00000000000000ab");
    expect(record.adjudication).toBe(true);
    // …and the join STILL does not resolve, because the transcript lives
    // under the run dir rather than the sessions root. Saying so is the
    // point: a fabricated "joined" badge would be the bug.
    expect((res.body["join"] as { state: string }).state).toBe("recorded-not-joinable");
  });
});

describe("empty states", () => {
  test("every quiet screen names the verb that would create its data", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "bare"), { specName: "bare" });
    const id = await register(t, dir);
    for (const path of [
      "evals/matrix",
      "evals/suites",
      "evals/graders",
      "evals/redteam",
      "evals/coverage",
      "evals/sentinel",
      "evals/optimize",
      "evals/experiments",
      "evals/annotations",
      "evals/judge",
    ]) {
      const { status, body } = await t.api(`/api/h/${id}/${path}`);
      expect(`${path}:${status}`).toBe(`${path}:200`);
      expect(`${path}:${body["present"]}`).toBe(`${path}:false`);
      expect(`${path}:${typeof body["note"]}`).toBe(`${path}:string`);
    }
    // The voice panel is shape-gated: a cli harness gets an explicit "not
    // applicable", never an empty panel it cannot interpret.
    const voice = await t.api(`/api/h/${id}/evals/voice`);
    expect(voice.body["applicable"]).toBe(false);
  });
});
