/**
 * B18 (runner half) — contamination-canary semantics end-to-end with a stub
 * invoker (no judge, no credentials):
 *
 *   - a `metadata.source: "canary"` sample leaves the pass-rate denominator
 *     and meanScore, and lands in the `canary`/`canarySampleIds` bucket;
 *   - the buckets stay disjoint (a canary never lists as needs_human);
 *   - slice stats exclude canaries the same way;
 *   - canary-free runs carry no canary fields (byte-identical shape).
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
import { runEval, sampleIsCanary } from "./index";

const SPEC = `name: canary-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-canary-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// The invoker echoes expected_output (passes exact_match); a canary has no
// gold, so it echoes nothing and fails the grader — the designed outcome.
const invoker = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.expected_output ?? "no idea",
  events: [],
});

const graders = () =>
  parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n").compiled;

const CANARY: Sample = {
  id: "canary_smoke_v1",
  input: "CREWHAUS-CANARY 0123456789abcdef0123456789abcdef — tripwire",
  metadata: { source: "canary" },
};

describe("runEval — canary sample semantics (B18)", () => {
  test("canary leaves the denominator and lands in the canary bucket", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "with-canary",
        samples: yieldSamples([
          { id: "ok-1", input: "a", expected_output: "a" },
          { id: "ok-2", input: "b", expected_output: "b" },
          CANARY,
        ]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir: newTempRoot() },
    });

    const canary = summary.samples.find((s) => s.sampleId === "canary_smoke_v1");
    expect(canary).toBeDefined();
    expect(sampleIsCanary(canary as never)).toBe(true);
    // The canary FAILED its grade (no gold) but the pass rate ignores it:
    // 2 passes / 2 graded, not 2/3.
    expect(canary?.grades.overall.passed).toBe(false);
    expect(summary.aggregates.passRate).toBe(1);
    // meanScore averages the graded samples only.
    expect(summary.aggregates.meanScore).toBe(1);
    // Listed separately — and NOT in the needs-human bucket.
    expect(summary.aggregates.canary).toBe(1);
    expect(summary.aggregates.canarySampleIds).toEqual(["canary_smoke_v1"]);
    expect(summary.aggregates.needsHuman).toBeUndefined();

    // B13 slices: the default `source` key groups the canary into its own
    // slice whose denominator is empty (0/0 → 0), leaving other groups
    // untouched.
    const sourceSlice = summary.slices?.["source"];
    expect(sourceSlice?.["canary"]?.sampleCount).toBe(1);
    expect(sourceSlice?.["canary"]?.passRate).toBe(0);
  });

  test("canary-free runs carry no canary fields (prior shape)", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "no-canary",
        samples: yieldSamples([{ id: "ok-1", input: "a", expected_output: "a" }]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir: newTempRoot() },
    });
    expect("canary" in summary.aggregates).toBe(false);
    expect("canarySampleIds" in summary.aggregates).toBe(false);
    expect(summary.aggregates.passRate).toBe(1);
  });

  test("an all-canary run has a 0/0 denominator, not a crash", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "only-canary", samples: yieldSamples([CANARY]) },
      compiledGraders: graders(),
      opts: { invoker, outDir: newTempRoot() },
    });
    expect(summary.aggregates.passRate).toBe(0);
    expect(summary.aggregates.canary).toBe(1);
  });
});
