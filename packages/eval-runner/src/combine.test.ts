import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { createRunContext } from "@crewhaus/run-context";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";
import { runSample } from "./run-sample";
import type { GraderEntry } from "./types";

/**
 * A4/A5 — the graders config's `combine:` policy governs how per-grader
 * results merge into `grades.overall`: `all` (default, the pre-policy
 * AND+mean), `any` (OR/max), `weighted` (Σ(w·s)/Σw gated on
 * `passing_threshold` ?? 0.5). Declaring `weight` or `passing_threshold`
 * without `combine: weighted` warns loudly at run start instead of being
 * silently ignored.
 */

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-combine-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: Sample = { id: "s1", input: "hi", expected_output: "ok" };

const HELLO_SPEC = `name: combine-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful, concise assistant.
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`test fixture must be target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const STUB_INVOKER: AgentInvoker = async () => ({ agentOutput: "the answer is ok", events: [] });

const yes: GraderEntry = {
  name: "yes",
  grader: async () => ({ passed: true, score: 1, rationale: "y" }),
};
const no: GraderEntry = {
  name: "no",
  grader: async () => ({ passed: false, score: 0, rationale: "n" }),
};

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { writes, restore: () => spy.mockRestore() };
}

describe("runSample — combine modes (A4/A5)", () => {
  test("no combine keeps the pre-policy semantics: AND of passed, mean score, ' & ' join", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [yes, no],
      outDir: newTempRoot(),
      model: "claude-test",
    });
    expect(result.grades.overall.passed).toBe(false);
    expect(result.grades.overall.score).toBe(0.5);
    expect(result.grades.overall.rationale).toContain(" & ");
  });

  test("combine: any passes when any grader passes; score = max; ' | ' join", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [yes, no],
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "any" },
    });
    expect(result.grades.overall.passed).toBe(true);
    expect(result.grades.overall.score).toBe(1);
    expect(result.grades.overall.rationale).toContain(" | ");
  });

  test("combine: any fails when no grader passes", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [no, no],
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "any" },
    });
    expect(result.grades.overall.passed).toBe(false);
    expect(result.grades.overall.score).toBe(0);
  });

  test("combine: weighted computes Σ(w·s)/Σw and gates on passingThreshold", async () => {
    const graders: GraderEntry[] = [
      { ...yes, weight: 3 },
      { ...no, weight: 1 },
    ];
    const below = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders,
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "weighted", passingThreshold: 0.8 },
    });
    expect(below.grades.overall.score).toBeCloseTo(0.75);
    expect(below.grades.overall.passed).toBe(false);
    expect(below.grades.overall.rationale).toContain("w=3");

    const above = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders,
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "weighted", passingThreshold: 0.7 },
    });
    expect(above.grades.overall.passed).toBe(true);
  });

  test("combine: weighted defaults the threshold to 0.5 and the weight to 1", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [yes, no],
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "weighted" },
    });
    expect(result.grades.overall.score).toBe(0.5);
    expect(result.grades.overall.passed).toBe(true); // exactly at the default cut
  });

  test("combine: weighted preserves grader-throw infra-noise semantics", async () => {
    const boom: GraderEntry = {
      name: "boom",
      weight: 1,
      grader: async () => {
        throw new Error("judge kaboom");
      },
    };
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [{ ...yes, weight: 1 }, boom],
      outDir: newTempRoot(),
      model: "claude-test",
      combine: { mode: "weighted", passingThreshold: 0.6 },
    });
    // The thrown grader still lands as a failed zero-score perGrader entry…
    const boomEntry = result.grades.perGrader.find((g) => g.name === "boom");
    expect(boomEntry?.passed).toBe(false);
    expect(boomEntry?.rationale).toContain("grader threw: judge kaboom");
    // …contributing 0 to the weighted score, and the structured evidence
    // survives for the noise retry/triage exactly as in `all` mode.
    expect(result.grades.overall.score).toBe(0.5);
    expect(result.grades.overall.passed).toBe(false);
    expect(result.graderError).toContain("judge kaboom");
  });

  test("an invoker error fails the sample in every combine mode", async () => {
    const failing: AgentInvoker = async () => {
      throw new Error("provider down");
    };
    for (const combine of [undefined, { mode: "any" as const }, { mode: "weighted" as const }]) {
      const result = await runSample({
        sample: SAMPLE,
        invoker: failing,
        graders: [yes],
        outDir: newTempRoot(),
        model: "claude-test",
        ...(combine !== undefined ? { combine } : {}),
      });
      expect(result.error).toBe("provider down");
      expect(result.grades.overall.passed).toBe(false);
      expect(result.grades.overall.rationale).toContain("agent invocation error: provider down");
    }
  });
});

describe("runEval — combine policy end-to-end (A4/A5)", () => {
  test("combine: weighted flows from graders.yaml through compiled entries to overall", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const { compiled } = parseGradersConfig(`
combine: weighted
passing_threshold: 0.6
graders:
  - name: gold
    type: expected_contains
    weight: 3
  - name: exact
    type: exact_match
    weight: 1
`);
    const summary = await runEval({
      ir,
      dataset: { name: "d", samples: yieldSamples([SAMPLE]) },
      compiledGraders: compiled,
      opts: { invoker: STUB_INVOKER, outDir },
    });
    // expected_contains passes ("the answer is ok" ⊇ "ok"), exact_match
    // fails → weighted score 3/4 clears the 0.6 cut where the pre-policy
    // AND would have failed the sample.
    const overall = summary.samples[0]?.grades.overall;
    expect(overall?.score).toBeCloseTo(0.75);
    expect(overall?.passed).toBe(true);
    expect(summary.aggregates.passRate).toBe(1);
  });

  test("no combine in the config reproduces the pre-policy results exactly", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const { compiled } = parseGradersConfig(`
graders:
  - name: gold
    type: expected_contains
  - name: exact
    type: exact_match
`);
    const summary = await runEval({
      ir,
      dataset: { name: "d", samples: yieldSamples([SAMPLE]) },
      compiledGraders: compiled,
      opts: { invoker: STUB_INVOKER, outDir },
    });
    const overall = summary.samples[0]?.grades.overall;
    expect(overall?.passed).toBe(false); // AND of graders, as before
    expect(overall?.score).toBe(0.5); // unweighted mean, as before
    expect(overall?.rationale).toContain(" & ");
  });

  test("warns loudly when weight is declared without combine: weighted", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const { compiled } = parseGradersConfig(`
graders:
  - name: heavy
    type: expected_contains
    weight: 3
`);
    const { writes, restore } = captureStderr();
    try {
      await runEval({
        ir,
        dataset: { name: "d", samples: yieldSamples([SAMPLE]) },
        compiledGraders: compiled,
        opts: { invoker: STUB_INVOKER, outDir },
      });
    } finally {
      restore();
    }
    const logged = writes.join("");
    expect(logged).toContain("graders.weight_ignored");
    expect(logged).toContain("heavy");
  });

  test("warns loudly when passing_threshold is declared without combine: weighted", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const { compiled } = parseGradersConfig(`
passing_threshold: 0.9
graders:
  - name: gold
    type: expected_contains
`);
    const { writes, restore } = captureStderr();
    try {
      await runEval({
        ir,
        dataset: { name: "d", samples: yieldSamples([SAMPLE]) },
        compiledGraders: compiled,
        opts: { invoker: STUB_INVOKER, outDir },
      });
    } finally {
      restore();
    }
    expect(writes.join("")).toContain("graders.passing_threshold_ignored");
  });

  test("emits no combination warnings under combine: weighted", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(HELLO_SPEC)));
    const { compiled } = parseGradersConfig(`
combine: weighted
passing_threshold: 0.5
graders:
  - name: heavy
    type: expected_contains
    weight: 3
`);
    const { writes, restore } = captureStderr();
    try {
      await runEval({
        ir,
        dataset: { name: "d", samples: yieldSamples([SAMPLE]) },
        compiledGraders: compiled,
        opts: { invoker: STUB_INVOKER, outDir },
      });
    } finally {
      restore();
    }
    const logged = writes.join("");
    expect(logged).not.toContain("graders.weight_ignored");
    expect(logged).not.toContain("graders.passing_threshold_ignored");
  });
});

// ---------------------------------------------------------------------------
// Result states: the three-valued combine
// ---------------------------------------------------------------------------

describe("runSample — a grade that is not a verdict (result states)", () => {
  type Status = "not_measured" | "skipped" | "observing";
  const stated = (
    name: string,
    status: Status,
    passed = false,
    role?: GraderEntry["role"],
  ): GraderEntry => ({
    name,
    grader: async () => ({
      passed,
      score: passed ? 1 : 0,
      rationale: `${name} ${status}`,
      status,
      ...(status === "not_measured" ? { statusReason: "no_proof_bundle" as const } : {}),
    }),
    ...(role !== undefined ? { role } : {}),
  });
  const role = (entry: GraderEntry, r: GraderEntry["role"]): GraderEntry => ({ ...entry, role: r });
  const overallOf = async (
    graders: GraderEntry[],
    combine?: Parameters<typeof runSample>[0]["combine"],
    invoker: AgentInvoker = STUB_INVOKER,
  ) =>
    (
      await runSample({
        sample: SAMPLE,
        invoker,
        graders,
        outDir: newTempRoot(),
        model: "claude-test",
        ...(combine !== undefined ? { combine } : {}),
      })
    ).grades.overall;
  const NOT_MEASURED = {
    passed: false,
    score: 0,
    status: "not_measured",
    statusReason: "no_proof_bundle",
  };

  test("with no status anywhere the overall grade is exactly the verdict combine", async () => {
    // The fixed set: an `all`, an `any` and a `weighted` combine over role-less,
    // requirement and report entries, deep-equal to the combine without states.
    const sets: Array<[GraderEntry[], Parameters<typeof runSample>[0]["combine"]]> = [
      [[yes, no], undefined],
      [[yes, no], { mode: "any" }],
      [[{ ...yes, weight: 3 }, no], { mode: "weighted", passingThreshold: 0.6 }],
      [[yes, role(no, "requirement"), role(no, "report")], undefined],
      [[role(yes, "requirement")], undefined],
    ];
    const expected = [
      { passed: false, score: 0.5, rationale: "[yes: ✓] y & [no: ✗] n" },
      { passed: true, score: 1, rationale: "[yes: ✓] y | [no: ✗] n" },
      { passed: true, score: 0.75, rationale: "[yes w=3 s=1.00] y + [no w=1 s=0.00] n" },
      { passed: false, score: 1, rationale: "[yes: ✓] y & [no: ✗] n" },
      { passed: true, score: 1, rationale: "[yes: ✓] y" },
    ];
    const got = await Promise.all(sets.map(([graders, combine]) => overallOf(graders, combine)));
    expect(got).toEqual(expected);
  });

  test("all: a measured fail beats not measured; not measured beats a pass", async () => {
    expect(await overallOf([no, stated("p", "not_measured")])).toMatchObject({
      passed: false,
      score: 0,
    });
    expect((await overallOf([no, stated("p", "not_measured")])).status).toBeUndefined();
    expect(await overallOf([yes, stated("p", "not_measured")])).toMatchObject(NOT_MEASURED);
  });

  test("any: a measured pass passes; else not measured; else fail", async () => {
    expect(await overallOf([yes, stated("p", "not_measured")], { mode: "any" })).toMatchObject({
      passed: true,
      score: 1,
    });
    expect(await overallOf([no, stated("p", "not_measured")], { mode: "any" })).toMatchObject(
      NOT_MEASURED,
    );
    const failed = await overallOf([no, no], { mode: "any" });
    expect(failed.passed).toBe(false);
    expect(failed.status).toBeUndefined();
  });

  test("weighted: any not-measured weighted entry makes the sample not measured", async () => {
    expect(
      await overallOf([{ ...yes, weight: 9 }, stated("p", "not_measured")], {
        mode: "weighted",
        passingThreshold: 0.1,
      }),
    ).toMatchObject(NOT_MEASURED);
  });

  test("requirements AND three ways beside the role-less policy; report entries are set aside", async () => {
    // A requirement that could not measure, beside a passing own grader.
    expect(
      await overallOf([yes, stated("req", "not_measured", false, "requirement")]),
    ).toMatchObject(NOT_MEASURED);
    // A measured failing requirement beats it.
    expect(
      await overallOf([
        yes,
        role(no, "requirement"),
        stated("req", "not_measured", false, "requirement"),
      ]),
    ).toMatchObject({ passed: false });
    // A not-measured REPORT entry changes nothing.
    const reported = await overallOf([yes, stated("cost", "not_measured", false, "report")]);
    expect(reported).toMatchObject({ passed: true, score: 1 });
    expect(reported.status).toBeUndefined();
  });

  test("skipped and observing entries are recorded and set aside", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [yes, stated("watch", "observing", false), stated("scope", "skipped")],
      outDir: newTempRoot(),
      model: "claude-test",
    });
    expect(result.grades.overall).toMatchObject({ passed: true, score: 1 });
    expect(result.grades.overall.status).toBeUndefined();
    expect(result.grades.perGrader.map((g) => [g.name, g.status])).toEqual([
      ["yes", undefined],
      ["watch", "observing"],
      ["scope", "skipped"],
    ]);
    // The rationale still lists every entry.
    expect(result.grades.overall.rationale).toContain("[watch: ✗]");
  });

  test("a sample every enforced grader skipped is skipped; one every enforced grader observed is observing", async () => {
    expect(
      await overallOf([stated("a", "skipped"), stated("b", "skipped", false, "requirement")]),
    ).toMatchObject({ passed: false, score: 0, status: "skipped", statusReason: "out_of_scope" });
    const observing = await overallOf([stated("a", "observing", true), stated("b", "observing")]);
    expect(observing).toMatchObject({ passed: false, score: 0, status: "observing" });
    expect(observing.statusReason).toBeUndefined();
  });

  test("an invoker error fails the sample ahead of every state", async () => {
    const result = await runSample({
      sample: SAMPLE,
      invoker: async () => {
        throw new Error("provider down");
      },
      graders: [stated("p", "not_measured"), stated("o", "observing")],
      outDir: newTempRoot(),
      model: "claude-test",
    });
    expect(result.error).toBeDefined();
    expect(result.grades.overall.passed).toBe(false);
    expect(result.grades.overall.status).toBeUndefined();
  });

  test("a status from the combine wins over abstention, and the sample publishes a skip verdict", async () => {
    const abstainingObserver: GraderEntry = {
      name: "judge",
      grader: async () => ({
        passed: false,
        score: 0,
        rationale: "unsure",
        abstained: true,
        status: "observing",
      }),
    };
    const runContext = createRunContext();
    const verdicts: string[] = [];
    runContext.eventBus.subscribe((e) => {
      if (e.kind === "test_verdict") verdicts.push(e.verdict);
    });
    const result = await runSample({
      sample: SAMPLE,
      invoker: STUB_INVOKER,
      graders: [abstainingObserver, stated("o", "observing", true)],
      outDir: newTempRoot(),
      model: "claude-test",
      runContext,
    });
    expect(result.grades.overall.status).toBe("observing");
    expect(result.grades.overall.abstained).toBeUndefined();
    expect(verdicts).toEqual(["skip"]);
  });

  test("abstention is read over the entries without a status", async () => {
    // An observing judge that abstained does not make a passing sample abstained.
    const abstainingObserver: GraderEntry = {
      name: "judge",
      grader: async () => ({
        passed: false,
        score: 0,
        rationale: "unsure",
        abstained: true,
        status: "observing",
      }),
    };
    const overall = await overallOf([abstainingObserver, yes]);
    expect(overall).toMatchObject({ passed: true, score: 1 });
    expect(overall.abstained).toBeUndefined();
  });
});
