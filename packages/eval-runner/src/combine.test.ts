import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
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
