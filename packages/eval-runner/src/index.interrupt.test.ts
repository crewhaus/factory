/**
 * Isolated test for the SIGINT mid-run interrupt path in `runEval`.
 *
 * Lives in its own file because it emits a process-level `SIGINT`: keeping it
 * apart from the rest of the suite ensures the emitted signal only interacts
 * with the handler `runEval` itself registers (and removes) for this run.
 *
 * The interrupt check sits *after* `sem.acquire()`: every sample callback's
 * synchronous prefix runs during `samples.map(...)`, before any SIGINT can
 * fire, so a pre-acquire check would never observe a mid-run interrupt. With
 * `concurrency: 1`, sample s0 holds the only slot while the rest queue; firing
 * SIGINT inside s0's invoker means each later sample is skipped as its turn
 * comes — exercising both the interrupt throw and the rejected→SampleResult
 * mapping.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

const SPEC = `name: interrupt-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
`;

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-interrupt-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

describe("runEval — SIGINT mid-run interrupt", () => {
  test("interrupts still-queued samples and maps them to failed results", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = Array.from({ length: 4 }).map((_, i) => ({
      id: `s${i}`,
      input: "x",
      expected_output: "y",
    }));

    let count = 0;
    const invoker: AgentInvoker = async ({ sample }) => {
      count += 1;
      // Fire SIGINT while the first sample holds the single concurrency slot;
      // the rest are queued and will observe `interrupted` as they dequeue.
      if (count === 1) process.emit("SIGINT" as NodeJS.Signals);
      return { agentOutput: sample.expected_output ?? "", events: [] };
    };

    const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
    const summary = await runEval({
      ir,
      dataset: { name: "interrupt", samples: yieldSamples(samples) },
      compiledGraders: compiled,
      opts: { invoker, outDir, concurrency: 1 },
    });

    // s0 completed; s1..s3 were interrupted before running.
    expect(summary.samples).toHaveLength(4);
    expect(summary.samples.find((s) => s.sampleId === "s0")?.grades.overall.passed).toBe(true);
    const interrupted = summary.samples.filter((s) => s.error?.includes("interrupted"));
    expect(interrupted.length).toBe(3);
    expect(summary.aggregates.errorCount).toBe(3);

    // The mapped failure carries the canonical placeholder fields.
    const s3 = summary.samples.find((s) => s.sampleId === "s3");
    expect(s3?.sessionId).toBe("(unset)");
    expect(s3?.latencyMs).toBe(0);
    expect(s3?.turns).toBe(0);
    expect(s3?.tokens).toEqual({ input: 0, output: 0 });
    expect(s3?.grades.overall.rationale).toBe("sample failed entirely");

    // results.json was still persisted despite the interrupt.
    const results = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(results.aggregates.errorCount).toBe(3);
  });
});
