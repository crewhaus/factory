/**
 * Item 7 — the runner's bounded noise auto-retry (`RunEvalOptions.retryErrors`,
 * default ON; `crewhaus eval --no-retry` opts out). A sample whose result is
 * an ERROR (the invoker failed — infra noise, not a graded failure) is retried
 * exactly once within the run; the retried outcome REPLACES the errored one
 * and is tagged `retried: true`. Aggregate honesty: retried samples appear
 * once in `samples`, so passRate's denominator counts each dataset sample
 * once (see the aggregate() doc comment).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-runner-retry-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const HELLO_SPEC = `name: hello-test
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

const GRADERS = parseGradersConfig(`
graders:
  - name: exact
    type: exact_match
`).compiled;

const SAMPLES: Sample[] = [
  { id: "flaky", input: "2+2?", expected_output: "4" },
  { id: "steady", input: "3+3?", expected_output: "6" },
];

/** Invoker that throws the first `failures` times for `flaky`, then answers
 *  correctly. `steady` always answers correctly. Counts every attempt. */
function flakyInvoker(failures: number, attempts: Map<string, number>): AgentInvoker {
  return async (req) => {
    const n = (attempts.get(req.sample.id) ?? 0) + 1;
    attempts.set(req.sample.id, n);
    if (req.sample.id === "flaky" && n <= failures) {
      throw new Error("ETIMEDOUT connecting to model provider");
    }
    return { agentOutput: req.sample.expected_output ?? "" };
  };
}

describe("eval-runner noise auto-retry (item 7)", () => {
  test("error → retry → pass: retried outcome replaces the error, tagged retried, passRate honest", async () => {
    const attempts = new Map<string, number>();
    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(HELLO_SPEC))),
      dataset: { name: "retry-fixture", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      // No retryErrors option — proves the retry is ON by default.
      opts: { outDir: join(newTempRoot(), "run"), invoker: flakyInvoker(1, attempts) },
    });

    expect(attempts.get("flaky")).toBe(2); // one retry, no more
    expect(attempts.get("steady")).toBe(1);
    const flaky = summary.samples.find((s) => s.sampleId === "flaky");
    expect(flaky?.error).toBeUndefined();
    expect(flaky?.retried).toBe(true);
    expect(flaky?.grades.overall.passed).toBe(true);
    const steady = summary.samples.find((s) => s.sampleId === "steady");
    expect(steady?.retried).toBeUndefined();
    // Aggregate honesty: 2 samples, 2 passes — the retried pass counts once
    // and the discarded first attempt counts nowhere.
    expect(summary.samples).toHaveLength(2);
    expect(summary.aggregates.passRate).toBe(1);
    expect(summary.aggregates.errorCount).toBe(0);
  });

  test("error → retry → error: exactly ONE retry, error kept, counted once in errorCount", async () => {
    const attempts = new Map<string, number>();
    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(HELLO_SPEC))),
      dataset: { name: "retry-fixture", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir: join(newTempRoot(), "run"),
        invoker: flakyInvoker(Number.POSITIVE_INFINITY, attempts),
      },
    });

    expect(attempts.get("flaky")).toBe(2); // bounded: never a third attempt
    const flaky = summary.samples.find((s) => s.sampleId === "flaky");
    expect(flaky?.retried).toBe(true);
    expect(flaky?.error).toContain("ETIMEDOUT");
    expect(flaky?.grades.overall.passed).toBe(false);
    // Aggregate honesty: denominator 2 (one entry per dataset sample), one
    // pass and one error → passRate 0.5, errorCount 1.
    expect(summary.samples).toHaveLength(2);
    expect(summary.aggregates.passRate).toBe(0.5);
    expect(summary.aggregates.errorCount).toBe(1);
  });

  test("retryErrors: false (--no-retry) keeps the first errored attempt untouched", async () => {
    const attempts = new Map<string, number>();
    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(HELLO_SPEC))),
      dataset: { name: "retry-fixture", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: {
        outDir: join(newTempRoot(), "run"),
        invoker: flakyInvoker(1, attempts),
        retryErrors: false,
      },
    });

    expect(attempts.get("flaky")).toBe(1);
    const flaky = summary.samples.find((s) => s.sampleId === "flaky");
    expect(flaky?.retried).toBeUndefined();
    expect(flaky?.error).toContain("ETIMEDOUT");
    expect(summary.aggregates.errorCount).toBe(1);
  });

  test("a graded FAILURE (no error) is never retried — retry is for infra noise only", async () => {
    const attempts = new Map<string, number>();
    const wrongInvoker: AgentInvoker = async (req) => {
      attempts.set(req.sample.id, (attempts.get(req.sample.id) ?? 0) + 1);
      return { agentOutput: "wrong answer" };
    };
    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(HELLO_SPEC))),
      dataset: { name: "retry-fixture", samples: yieldSamples(SAMPLES) },
      compiledGraders: GRADERS,
      opts: { outDir: join(newTempRoot(), "run"), invoker: wrongInvoker },
    });

    expect(attempts.get("flaky")).toBe(1);
    expect(attempts.get("steady")).toBe(1);
    expect(summary.aggregates.passRate).toBe(0);
    expect(summary.aggregates.errorCount).toBe(0);
    expect(summary.samples.every((s) => s.retried === undefined)).toBe(true);
  });
});
