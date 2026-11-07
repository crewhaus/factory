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
 *   - the held-out test cases cannot be used without the typed
 *     confirmation, and nothing from a request body can append a flag;
 *   - sentinel attribution is conditional on all four hashes matching;
 *   - an eval-sample annotation is never dropped, and the F-7 join state is
 *     reported honestly rather than faked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Glob } from "bun";
import { runCorpusEval } from "./__test__/eval-corpus";
import { evalArgv } from "./eval-inputs";
import { classifyCellError, datasetFilterMatches, describeCellCrash, wilson95 } from "./evals-ops";
import { makeFixtureHarness } from "./fixture";
import { SCAFFOLDED_WORKFLOWS, WORKFLOWS_DIR_SEGMENTS } from "./scaffolded-workflows";
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

/** One real run's artifacts, out of the real runner, for {@link labHarness} to
 *  copy: a fixture's own idea of `results.json` proves nothing about a reader. */
let corpusRoot = "";
const CORPUS_RUN = "run_000000000000aa01";
beforeAll(async () => {
  corpusRoot = mkdtempSync(join(tmpdir(), "hangar-evals-ops-"));
  await runCorpusEval(corpusRoot, { s1: "pass" }, { runId: CORPUS_RUN, specName: "lab" });
}, 20_000); // loads the whole eval runner
afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true });
});

const CONVENTIONAL_DATASET_LINE = '{"id":"a","input":"x"}\n';

/** A harness with matrix cells, a suite run, a sentinel baseline and a
 *  resumed + partial eval history. Its graders file is on disk; its dataset
 *  is not, so a test can say which it is holding. */
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
  });
  cpSync(
    join(corpusRoot, ".crewhaus", "evals", CORPUS_RUN),
    join(dir, ".crewhaus", "evals", CORPUS_RUN),
    {
      recursive: true,
    },
  );
  mkdirSync(join(dir, "eval"), { recursive: true });
  writeFileSync(
    join(dir, "eval", "graders.yaml"),
    "graders:\n  - name: m\n    type: exact_match\n",
  );
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
      "--graders",
      "eval/graders.yaml",
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

  test("the held-out test cases need the typed confirmation", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const refused = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", allowTestSplit: true }),
    });
    expect(refused.status).toBe(409);
    // The person at the form has a word to type, not a field to send.
    expect(String(refused.body["error"])).toBe(
      'Type "release" to confirm using the held-out test cases.',
    );

    const spent = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", allowTestSplit: true, releaseConfirm: true }),
    });
    expect(spent.status).toBe(200);
    expect(spent.body["argv"]).toContain("--allow-test-split");
    const warned = (spent.body["warnings"] as string[]).join(" ");
    expect(warned).toContain("is not recorded");
    expect(warned).toContain("Only crewhaus datasets release records a use.");
    expect(warned).not.toContain("burn");
  });

  test("warns when a conventional dataset file shadows the ratings registry", async () => {
    const t = boot();
    const dir = labHarness(t);
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect((body["warnings"] as string[]).join(" ")).toContain("lab-ratings");
    const fly = await t.api(`/api/h/${id}/evals/flywheel`);
    expect((fly.body["datasetPrecedence"] as { shadowing: boolean }).shadowing).toBe(true);
  });

  test("a launch with no paths uses the conventional files, and shows the real command", async () => {
    const t = boot();
    const dir = labHarness(t);
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(200);
    const command = "eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml";
    expect((body["argv"] as string[]).join(" ")).toBe(command);
    expect(body["verb"]).toBe(`crewhaus ${command}`);
  });

  test("missing files answer 409 naming them, dataset first, and queue nothing", async () => {
    const t = boot();
    const dir = labHarness(t);
    rmSync(join(dir, "eval", "graders.yaml"));
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(409);
    expect(body["error"]).toBe(
      "No test cases yet: add eval/dataset.jsonl. No checks yet: add eval/graders.yaml.",
    );
    const queue = (await t.api("/api/jobs")).body;
    expect(queue["pending"]).toEqual([]);
    expect(queue["running"]).toEqual([]);
  });

  test("an explicit dataset stands in for the file, but an unset graders still needs one", async () => {
    const t = boot();
    const dir = labHarness(t);
    const id = await register(t, dir);
    const named = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke" }),
    });
    expect(named.status).toBe(200);

    rmSync(join(dir, "eval", "graders.yaml"));
    const noGraders = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke" }),
    });
    expect(noGraders.status).toBe(409);
    expect(noGraders.body["error"]).toBe("No checks yet: add eval/graders.yaml.");
  });

  test("resume takes a run id and builds its path; anything else is a 400", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const ok = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", resume: CORPUS_RUN }),
    });
    expect(ok.status).toBe(200);
    const argv = ok.body["argv"] as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(`.crewhaus/evals/${CORPUS_RUN}`);

    for (const resume of [true, "not-a-run", "../run_000000000000aa01"]) {
      const refused = await t.api(`/api/h/${id}/evals/run`, {
        method: "POST",
        body: JSON.stringify({ dataset: "smoke", resume }),
      });
      expect(refused.status).toBe(400);
      expect(String(refused.body["error"])).toContain('"resume"');
    }
  });

  test("POST /jobs fills an eval's inputs the same way, or refuses the same way", async () => {
    const t = boot();
    const dir = labHarness(t);
    const id = await register(t, dir);
    const refused = await t.api(`/api/h/${id}/jobs`, {
      method: "POST",
      body: JSON.stringify({ kind: "eval" }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("No test cases yet: add eval/dataset.jsonl.");

    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const queued = await t.api(`/api/h/${id}/jobs`, {
      method: "POST",
      body: JSON.stringify({ kind: "eval" }),
    });
    expect(queued.status).toBe(202);
    expect((queued.body["job"] as { argv: string[] }).argv.join(" ")).toBe(
      "eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    );
  });

  test("the test-split warning names the one verb that records a use", () => {
    const { warnings } = evalArgv(
      { dataset: "smoke", graders: "g.yaml", allowTestSplit: true, releaseConfirm: true },
      {
        eval: { offered: false, shapeOk: true, note: "x", verb: null },
        optimize: { offered: false, shapeOk: true, note: "x", verb: null },
        flywheel: { offered: false, shapeOk: true, note: "x", verb: null },
        conventional: { dataset: false, graders: false },
      },
    );
    expect(warnings.join(" ")).toContain("datasets release");
    expect(warnings.join(" ")).toContain("is not recorded");
  });
});

describe("what each harness shape is offered", () => {
  const launchesOf = async (t: TestServer, id: string) =>
    (await t.api(`/api/h/${id}/evals/flywheel`)).body["launches"] as Record<
      string,
      { offered: boolean; shapeOk: boolean; note: string | null; verb: string | null }
    >;

  test("a workflow gets no eval and no flywheel, but can optimize", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wf"), {
      specName: "wf",
      target: "workflow",
    });
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
    const id = await register(t, dir);
    const launches = await launchesOf(t, id);
    expect(launches["eval"]).toEqual({
      offered: false,
      shapeOk: false,
      note: "Checks for this harness type run inside its compiled test bundle.",
      verb: "crewhaus compile crewhaus.yaml --with-eval-harness",
    });
    expect(launches["optimize"]?.offered).toBe(true);
    expect(launches["flywheel"]?.offered).toBe(false);

    // An explicit dataset can fill in for a file, never for a shape.
    const refused = await t.api(`/api/h/${id}/evals/run`, {
      method: "POST",
      body: JSON.stringify({ dataset: "smoke", graders: "eval/graders.yaml" }),
    });
    expect(refused.status).toBe(409);
    const advice = await t.api(`/api/h/${id}/evals/optimize`, {
      method: "POST",
      body: JSON.stringify({ fromAdvice: true }),
    });
    expect(advice.status).toBe(409);
    expect(String(advice.body["error"])).toContain("command-line");
  });

  test("a shape nothing optimizes says so, with no command to paste", async () => {
    const t = boot();
    const id = await register(
      t,
      makeFixtureHarness(join(t.harnessesRoot, "ch"), { specName: "ch", target: "channel" }),
    );
    const launches = await launchesOf(t, id);
    expect(launches["optimize"]).toEqual({
      offered: false,
      shapeOk: false,
      note: "Automatic prompt search isn't available for this harness type.",
      verb: null,
    });
    expect(launches["flywheel"]?.note).toBe(
      "The improvement loop runs on command-line harnesses only.",
    );
  });

  test("a spec nobody can read offers nothing", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "nospec"), { specName: "nospec" });
    const id = await register(t, dir);
    rmSync(join(dir, "crewhaus.yaml"));
    const launches = await launchesOf(t, id);
    for (const name of ["eval", "optimize", "flywheel"]) {
      expect(launches[name]).toEqual({
        offered: false,
        shapeOk: false,
        note: "The spec could not be read.",
        verb: null,
      });
    }
  });

  test("the evals read carries the eval offer, so an empty history can name its command", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "fresh"), { specName: "fresh" });
    const id = await register(t, dir);
    const empty = (await t.api(`/api/h/${id}/evals`)).body;
    expect(empty["launch"]).toMatchObject({
      offered: false,
      note: "No test cases yet: add eval/dataset.jsonl. No checks yet: add eval/graders.yaml.",
      verb: null,
    });
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
    const ready = (await t.api(`/api/h/${id}/evals`)).body;
    expect(ready["launch"]).toEqual({
      offered: true,
      shapeOk: true,
      note: null,
      verb: "crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    });
  });
});

describe("the optimizer launcher", () => {
  test("missing files answer 409; present ones travel with the mutator", async () => {
    const t = boot();
    const dir = labHarness(t);
    const id = await register(t, dir);
    const refused = await t.api(`/api/h/${id}/evals/optimize`, {
      method: "POST",
      body: JSON.stringify({ mutator: "rule-based" }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("No test cases yet: add eval/dataset.jsonl.");

    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const ok = await t.api(`/api/h/${id}/evals/optimize`, {
      method: "POST",
      body: JSON.stringify({ mutator: "rule-based" }),
    });
    expect(ok.status).toBe(200);
    expect((ok.body["argv"] as string[]).join(" ")).toBe(
      "optimize crewhaus.yaml --mutator rule-based --dataset eval/dataset.jsonl --graders eval/graders.yaml",
    );
  });

  test("applying saved suggestions needs no mutator, and sends none", async () => {
    const t = boot();
    const dir = labHarness(t);
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/evals/optimize`, {
      method: "POST",
      body: JSON.stringify({ fromAdvice: true, mutator: "claude" }),
    });
    expect(status).toBe(200);
    const argv = body["argv"] as string[];
    expect(argv).not.toContain("--mutator");
    expect(argv[argv.indexOf("--from-advice") + 1]).toBe("suggestions.json");
  });
});

describe("the sentinel launcher", () => {
  test("carries the inputs eval asks for before it reads --sentinel", async () => {
    const t = boot();
    const dir = labHarness(t);
    const id = await register(t, dir);
    const refused = await t.api(`/api/h/${id}/evals/sentinel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);

    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    const ok = await t.api(`/api/h/${id}/evals/sentinel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(200);
    const command =
      "eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml --sentinel --baseline eval/sentinel-baseline";
    expect((ok.body["argv"] as string[]).join(" ")).toBe(command);
    expect(ok.body["verb"]).toBe(`crewhaus ${command}`);
  });
});

describe("the flywheel launcher", () => {
  test("a ratings-driven harness runs with no dataset file, and no flag is added for it", async () => {
    const t = boot();
    const dir = labHarness(t);
    mkdirSync(join(dir, ".crewhaus", "datasets", "lab-ratings"), { recursive: true });
    const id = await register(t, dir);
    const launches = (await t.api(`/api/h/${id}/evals/flywheel`)).body["launches"] as Record<
      string,
      { offered: boolean; verb: string | null }
    >;
    expect(launches["flywheel"]).toMatchObject({ offered: true, verb: "crewhaus flywheel run" });
    expect(launches["eval"]?.offered).toBe(false);

    const { status, body } = await t.api(`/api/h/${id}/evals/flywheel`, {
      method: "POST",
      body: JSON.stringify({ iterations: 2 }),
    });
    expect(status).toBe(200);
    expect(body["argv"]).toEqual(["flywheel", "run", "--iterations", "2"]);
  });

  test("with neither a dataset file nor ratings it refuses, but scaffolding still runs", async () => {
    const t = boot();
    const id = await register(t, labHarness(t));
    const refused = await t.api(`/api/h/${id}/evals/flywheel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);
    expect(refused.body["error"]).toBe("No test cases yet: add eval/dataset.jsonl.");
    const init = await t.api(`/api/h/${id}/evals/flywheel`, {
      method: "POST",
      body: JSON.stringify({ action: "init" }),
    });
    expect(init.status).toBe(200);
    expect(init.body["argv"]).toEqual(["flywheel", "init"]);
  });
});

describe("optimizer run ids", () => {
  const OPT_ID = `opt_${Date.now().toString(16)}`;

  test("artifacts open for the id the CLI mints, and a run_ id no longer resolves", async () => {
    const t = boot();
    const dir = labHarness(t);
    writeJson(dir, [".crewhaus", "optimize", OPT_ID, "patch.json"], { patches: [] });
    const id = await register(t, dir);
    const ok = await t.api(`/api/h/${id}/evals/optimize/${OPT_ID}`);
    expect(ok.status).toBe(200);
    expect(ok.body["optRunId"]).toBe(OPT_ID);
    expect(ok.body["patch"]).toEqual({ patches: [] });
    const legacy = await t.api(`/api/h/${id}/evals/optimize/run_00000000000000aa`);
    expect(legacy.status).toBe(400);
  });

  test("the list shows no row the artifacts route would refuse", async () => {
    const t = boot();
    const dir = labHarness(t);
    writeJson(dir, [".crewhaus", "optimize", OPT_ID, "patch.json"], {});
    writeJson(dir, [".crewhaus", "optimize", "not-an-opt-id", "patch.json"], {});
    const id = await register(t, dir);
    const runs = (await t.api(`/api/h/${id}/evals/optimize`)).body["runs"] as Array<{
      optRunId: string;
    }>;
    expect(runs.map((r) => r.optRunId)).toEqual([OPT_ID]);
  });

  test("every place that mints an optimizer id is one this guard was checked against", () => {
    // A new id format, or a new minter, fails here before it fails a person.
    const minter = "opt_${";
    const root = join(import.meta.dir, "..", "..", "..");
    const sources = new Glob("{packages,apps}/*/src/**/*.ts");
    const hits: string[] = [];
    let scanned = 0;
    for (const raw of sources.scanSync({ cwd: root })) {
      // The scan answers in the platform's separator; the list below is not.
      const rel = raw.split(sep).join("/");
      if (rel.endsWith(".test.ts") || rel.includes("__test__")) continue;
      scanned += 1;
      if (readFileSync(join(root, rel), "utf8").includes(minter)) hits.push(rel);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits.sort()).toEqual([
      "apps/cli/src/index.ts",
      "packages/eval-optimizer-orchestrator/src/index.ts",
      "packages/prompt-optimizer/src/index.ts",
    ]);
  }, 20_000); // reads every package's source
});

describe("a read names only a command that can run on this harness", () => {
  const COMPILE = "crewhaus compile crewhaus.yaml --with-eval-harness";
  const seedInputs = (dir: string): void => {
    mkdirSync(join(dir, "eval"), { recursive: true });
    writeFileSync(join(dir, "eval", "dataset.jsonl"), CONVENTIONAL_DATASET_LINE);
    writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
  };
  type Read = { present: boolean; note: string | null; verb: string | null };
  const read = async (t: TestServer, id: string, path: string): Promise<Read> =>
    (await t.api(`/api/h/${id}/${path}`)).body as unknown as Read;
  /** Every read whose verb fills it, in its empty state. */
  const EVAL_READS = ["evals/trends", "evals/sentinel"];
  const OPTIMIZE_READS = ["evals/optimize", "evals/optimize/opt_abc123"];

  const harnessOf = async (t: TestServer, target: string, inputs: boolean): Promise<string> => {
    const dir = makeFixtureHarness(join(t.harnessesRoot, `h-${target}`), {
      specName: `h-${target}`,
      target,
    });
    if (inputs) seedInputs(dir);
    return register(t, dir);
  };

  for (const target of ["workflow", "voice", "channel", "chat"]) {
    test(`target ${target}: nothing says crewhaus eval, and the reason is what shows`, async () => {
      const t = boot();
      const id = await harnessOf(t, target, true);
      for (const path of EVAL_READS) {
        const body = await read(t, id, path);
        expect(body.present).toBe(false);
        expect(body.verb).toBe(COMPILE);
        expect(body.note).toBe("Checks for this harness type run inside its compiled test bundle.");
      }
    });
  }

  for (const target of ["voice", "channel", "chat"]) {
    test(`target ${target}: nothing says crewhaus optimize`, async () => {
      const t = boot();
      const id = await harnessOf(t, target, true);
      const empty = await read(t, id, "evals/optimize");
      expect(empty.verb).toBeNull();
      expect(empty.note).toBe("Automatic prompt search isn't available for this harness type.");
      const one = await read(t, id, "evals/optimize/opt_abc123");
      expect(one.verb).toBeNull();
      expect(one.note).toContain("opt_abc123");
    });
  }

  test("a workflow, which can optimize, names the command with its inputs", async () => {
    const t = boot();
    const id = await harnessOf(t, "workflow", true);
    for (const path of OPTIMIZE_READS) {
      expect((await read(t, id, path)).verb).toBe(
        "crewhaus optimize crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml",
      );
    }
  });

  test("a command-line harness with no inputs gets what to add, not a command that dies", async () => {
    const t = boot();
    const id = await harnessOf(t, "cli", false);
    const both = "No test cases yet: add eval/dataset.jsonl. No checks yet: add eval/graders.yaml.";
    for (const path of [...EVAL_READS, "evals/optimize"]) {
      const body = await read(t, id, path);
      expect(body.verb).toBeNull();
      expect(body.note).toBe(both);
    }
  });

  test("a command-line harness with its inputs gets the exact commands", async () => {
    const t = boot();
    const id = await harnessOf(t, "cli", true);
    const evalCommand =
      "crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml";
    const trends = await read(t, id, "evals/trends");
    expect(trends.verb).toBe(evalCommand);
    expect(trends.note).toBe("no eval runs recorded yet");
    const sentinel = await read(t, id, "evals/sentinel");
    expect(sentinel.verb).toBe(`${evalCommand} --seed 1 -o eval/sentinel-baseline`);
    expect(sentinel.note).toContain("no frozen sentinel baseline");
    const optimizer = await read(t, id, "evals/optimize");
    expect(optimizer.note).toBe("no optimizer runs recorded");
  });

  test("the same holds where the read has something to show", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wf-runs"), {
      specName: "wf-runs",
      target: "workflow",
      evalIndex: [
        {
          runId: "run_000000000000bb01",
          specName: "wf-runs",
          specHash: "s",
          datasetName: "smoke",
          datasetHash: "d",
          passRate: 1,
          meanScore: 1,
          sampleCount: 1,
          ts: iso(NOW - DAY),
          outDir: "/gone",
        },
      ],
    });
    writeJson(dir, ["eval", "sentinel-baseline", "run.json"], { runId: "run_x", config: {} });
    mkdirSync(join(dir, ".crewhaus", "optimize", "opt_abc123"), { recursive: true });
    const id = await register(t, dir);
    for (const path of EVAL_READS) {
      const body = await read(t, id, path);
      expect(body.present).toBe(true);
      expect(body.verb).toBe(COMPILE);
    }
    // No inputs on disk, so nothing here would run.
    for (const path of OPTIMIZE_READS) {
      const body = await read(t, id, path);
      expect(body.present).toBe(true);
      expect(body.verb).toBeNull();
    }
  });

  test("a filter that matched nothing keeps saying so, on a harness that cannot run evals", async () => {
    const t = boot();
    const id = await harnessOf(t, "workflow", true);
    const body = await read(t, id, "evals/trends?dataset=smoke");
    expect(body.note).toContain('dataset filter "smoke"');
    expect(body.verb).toBe(COMPILE);
  });

  test("the flywheel's read says crewhaus flywheel run only where it runs", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wf-fly"), {
      specName: "wf-fly",
      target: "workflow",
    });
    mkdirSync(join(dir, ".crewhaus", "flywheel"), { recursive: true });
    writeJson(dir, [".crewhaus", "flywheel", "state.json"], {});
    const id = await register(t, dir);
    const body = await read(t, id, "evals/flywheel");
    expect(body.present).toBe(true);
    expect(body.verb).toBeNull();
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
    const dir = labHarness(t);
    // A sample whose meta recorded no session, as an older run's may not.
    writeJson(dir, [".crewhaus", "evals", "run_000000000000aa01", "s1", "meta.json"], {
      latencyMs: 5,
    });
    const id = await register(t, dir);
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

describe("the flywheel's workflow listing", () => {
  /** Write one `.github/workflows` entry into a harness tree. */
  function writeWorkflow(dir: string, filename: string): void {
    const wf = join(dir, ...WORKFLOWS_DIR_SEGMENTS);
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, filename), `name: ${filename}\non: [workflow_dispatch]\n`);
  }

  // The regression this file exists for: the endpoint used to filter on
  // `/crewhaus-(flywheel|eval-gate|sentinel)/`, which matches ONE of the five
  // filenames anything actually writes. Every scaffolder gets its own case,
  // so adding a sixth workflow without teaching the endpoint fails here.
  for (const [concept, filename] of Object.entries(SCAFFOLDED_WORKFLOWS)) {
    test(`lists ${filename} (the ${concept} workflow)`, async () => {
      const t = boot();
      const dir = makeFixtureHarness(join(t.harnessesRoot, `wf-${concept}`), { specName: "wf" });
      writeWorkflow(dir, filename);
      const id = await register(t, dir);
      const { status, body } = await t.api(`/api/h/${id}/evals/flywheel`);
      expect(status).toBe(200);
      expect(body["workflows"]).toEqual([filename]);
      // A scaffolded harness is never reported as unscaffolded, even with no
      // `.crewhaus/flywheel` state dir: `init --sentinel` writes a workflow
      // and nothing else, and that used to land in the absent() branch.
      expect(`${filename}:${body["present"]}`).toBe(`${filename}:true`);
      expect(String(body["note"] ?? "")).not.toContain("no flywheel scaffolding");
    });
  }

  test("`init --ci --sentinel` reports BOTH workflows, not just a flywheel", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wf-both"), { specName: "wf" });
    writeWorkflow(dir, SCAFFOLDED_WORKFLOWS.evalGate);
    writeWorkflow(dir, SCAFFOLDED_WORKFLOWS.sentinel);
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/evals/flywheel`);
    expect([...(body["workflows"] as string[])].sort()).toEqual(
      [SCAFFOLDED_WORKFLOWS.evalGate, SCAFFOLDED_WORKFLOWS.sentinel].sort(),
    );
  });

  test("claims only what CrewHaus wrote — an exact basename, never a prefix", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "wf-foreign"), { specName: "wf" });
    writeWorkflow(dir, "ci.yml");
    // Someone else's file whose name STARTS with ours. A substring match
    // would adopt it and offer `flywheel run` over a workflow we do not own.
    writeWorkflow(dir, "crewhaus-eval-nightly.yml");
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/evals/flywheel`);
    expect(body["workflows"]).toEqual([]);
    expect(body["present"]).toBe(false);
    expect(String(body["note"])).toContain("no flywheel scaffolding");
  });

  /**
   * The drift guard, in the shape `cli-twins.test.ts` established: the CLI
   * source is READ, never imported (`apps/cli` depends on this package, not
   * the other way round). Each scaffolder constant must be DERIVED from
   * `SCAFFOLDED_WORKFLOWS` — re-hardcoding a filename in either file is how
   * the endpoint and the scaffolders came apart in the first place.
   */
  test("every CLI scaffolder derives its path from SCAFFOLDED_WORKFLOWS", () => {
    const cliSrc = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src");
    const sources: Record<string, string> = {
      "flywheel.ts": readFileSync(join(cliSrc, "flywheel.ts"), "utf8"),
      "ci-scaffold.ts": readFileSync(join(cliSrc, "ci-scaffold.ts"), "utf8"),
    };
    const derivations: ReadonlyArray<readonly [string, string, keyof typeof SCAFFOLDED_WORKFLOWS]> =
      [
        ["flywheel.ts", "FLYWHEEL_WORKFLOW_RELPATH", "flywheel"],
        ["flywheel.ts", "MODEL_PLAN_WORKFLOW_RELPATH", "modelPlan"],
        ["ci-scaffold.ts", "EVAL_CI_WORKFLOW_RELPATH", "evalGate"],
        ["ci-scaffold.ts", "SENTINEL_WORKFLOW_RELPATH", "sentinel"],
        ["ci-scaffold.ts", "DREAM_WORKFLOW_RELPATH", "dream"],
      ];
    for (const [file, constant, key] of derivations) {
      const decl = new RegExp(`export const ${constant} = join\\(([^;]*?)\\);`, "s");
      const match = decl.exec(sources[file] as string);
      expect(`${constant}:declared`).toBe(`${constant}:${match === null ? "missing" : "declared"}`);
      // Whitespace- and trailing-comma-insensitive: the formatter collapses
      // a short call onto one line, and that is not drift.
      const args = (match?.[1] ?? "").replace(/\s+/g, " ").trim().replace(/,$/, "").trim();
      expect(`${constant}:${args}`).toBe(
        `${constant}:...WORKFLOWS_DIR_SEGMENTS, SCAFFOLDED_WORKFLOWS.${key}`,
      );
    }
    // …and both files take the names from the leaf subpath, so importing
    // them never drags the Hangar server into the CLI's eager graph.
    for (const [file, text] of Object.entries(sources)) {
      expect(`${file}:imports`).toBe(
        `${file}:${text.includes('from "@crewhaus/hangar-server/scaffolded-workflows"') ? "imports" : "missing"}`,
      );
    }
  });
});
