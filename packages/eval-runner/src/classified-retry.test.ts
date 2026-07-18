/**
 * Loop contract 0.4 (Batch B, G54) — the spec's `failure_taxonomy` reaches
 * the eval runner: the run-level noise auto-retry is CLASSIFIED via
 * recovery-engine's matcher instead of blindly retrying every error. A
 * matched entry declaring `recovery: fail` is terminal (no retry burned on
 * an error the user declared unretryable), and any final matched error
 * carries `failureClass` for triage.
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

const SPEC = `name: taxonomy-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
failure_taxonomy:
  - class: quota_exhausted
    pattern: quota exceeded
    recovery: fail
    hint: top up the provider account
  - class: flaky_net
    pattern: /ECONNRESET/i
    recovery: retry
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-taxonomy-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

describe("runEval — failure_taxonomy classified retry (G54)", () => {
  test("a matched `recovery: fail` class is terminal — no blunt retry", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    expect(ir.failureTaxonomy).toHaveLength(2);
    let calls = 0;
    const invoker: AgentInvoker = async () => {
      calls += 1;
      throw new Error("provider said: quota exceeded for org");
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    // Exactly ONE invocation: the taxonomy declared the class terminal.
    expect(calls).toBe(1);
    const s = summary.samples[0];
    expect(s?.error).toMatch(/quota exceeded/);
    expect(s?.failureClass).toBe("quota_exhausted");
    expect(s?.retried).toBeUndefined();
    expect(summary.aggregates.errorCount).toBe(1);
  });

  test("a matched retry-shaped class still gets the bounded noise retry", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    let calls = 0;
    const invoker: AgentInvoker = async ({ sample }) => {
      calls += 1;
      if (calls === 1) throw new Error("read ECONNRESET");
      return { agentOutput: sample.expected_output ?? "", events: [] };
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax2",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(calls).toBe(2);
    const s = summary.samples[0];
    expect(s?.retried).toBe(true);
    expect(s?.error).toBeUndefined();
    // The retry recovered — no lingering failureClass on a passing result.
    expect(s?.failureClass).toBeUndefined();
    expect(s?.grades.overall.passed).toBe(true);
  });

  test("a persistent matched error keeps its class on the final result", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    let calls = 0;
    const invoker: AgentInvoker = async () => {
      calls += 1;
      throw new Error("read ECONNRESET");
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax3",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(calls).toBe(2);
    const s = summary.samples[0];
    expect(s?.retried).toBe(true);
    expect(s?.failureClass).toBe("flaky_net");
  });

  test("unmatched errors keep the pre-G54 blunt retry, without a class", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    let calls = 0;
    const invoker: AgentInvoker = async ({ sample }) => {
      calls += 1;
      if (calls === 1) throw new Error("some unclassified explosion");
      return { agentOutput: sample.expected_output ?? "", events: [] };
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax4",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(calls).toBe(2);
    expect(summary.samples[0]?.retried).toBe(true);
    expect(summary.samples[0]?.failureClass).toBeUndefined();
  });

  test("retryErrors: false still classifies the error for triage", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    let calls = 0;
    const invoker: AgentInvoker = async () => {
      calls += 1;
      throw new Error("read ECONNRESET");
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax5",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, retryErrors: false },
    });
    expect(calls).toBe(1);
    expect(summary.samples[0]?.failureClass).toBe("flaky_net");
    expect(summary.samples[0]?.retried).toBeUndefined();
  });

  test("no taxonomy in the spec: behavior identical to before (no class)", async () => {
    const outDir = newTempRoot();
    const bare = "name: no-tax\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: t\n";
    const ir = narrowToAgent(lower(parseSpec(bare)));
    let calls = 0;
    const invoker: AgentInvoker = async () => {
      calls += 1;
      throw new Error("provider said: quota exceeded for org");
    };
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "tax6",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect(calls).toBe(2);
    expect(summary.samples[0]?.failureClass).toBeUndefined();
    expect(summary.samples[0]?.retried).toBe(true);
  });
});
