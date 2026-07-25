/**
 * A2 (runner half) — needs-review sample semantics end-to-end, driven by
 * plain compiled graders whose GradeResult carries the panel fields (no
 * judge network, no module mock — the flag's fold is judge-agnostic):
 *
 *   - a perGrader `needsReview` flag folds onto the sample's overall grade
 *     WITHOUT touching its verdict (pass stays pass, fail stays fail, the
 *     pass-rate denominator is unchanged);
 *   - flagged samples list in `needsReview`/`needsReviewSampleIds`,
 *     SEPARATELY from the abstained needs-human bucket, and never both;
 *   - flag-free runs keep the exact pre-A2 aggregate shape.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, GradeResult } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { runEval, sampleAbstained, sampleNeedsReview } from "./index";

const SPEC = `name: needs-review-test
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-needs-review-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

/**
 * A synthetic "panel judge" grader keyed on the sample id prefix:
 *   review-pass-* → passes but flags needsReview (2–1 style split);
 *   review-fail-* → fails and flags needsReview;
 *   abstain-*     → abstains (needs-human, not needs-review);
 *   everything else passes cleanly.
 */
function panelishGrader(name: string): CompiledGrader {
  return {
    name,
    weight: 1,
    grader: async (sample: Sample): Promise<GradeResult> => {
      if (sample.id.startsWith("review-pass")) {
        return {
          passed: true,
          score: 0.75,
          rationale:
            "judge=4 (panel of 3 [m1=3, m2=4, m3=5], votes 2/3 pass, entropy 0.92, need ≥4): split",
          needsReview: true,
          panel: {
            panelists: [
              { model: "m1", score: 3, passed: false },
              { model: "m2", score: 4, passed: true },
              { model: "m3", score: 5, passed: true },
            ],
            voteEntropy: 0.9182958340544896,
          },
        };
      }
      if (sample.id.startsWith("review-fail")) {
        return {
          passed: false,
          score: 0.25,
          rationale:
            "judge=2 (panel of 3 [m1=2, m2=2, m3=4], votes 1/3 pass, entropy 0.92, need ≥4): split",
          needsReview: true,
          panel: {
            panelists: [
              { model: "m1", score: 2, passed: false },
              { model: "m2", score: 2, passed: false },
              { model: "m3", score: 4, passed: true },
            ],
            voteEntropy: 0.9182958340544896,
          },
        };
      }
      if (sample.id.startsWith("abstain")) {
        return {
          passed: false,
          score: 0,
          rationale: "judge abstained: no evidence",
          abstained: true,
        };
      }
      return { passed: true, score: 1, rationale: "clean pass" };
    },
  };
}

const invoker = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.expected_output ?? "out",
  events: [],
});

describe("runEval — needs-review sample semantics (A2)", () => {
  test("flagged samples keep their verdicts and list separately from abstained", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "review-mix",
        samples: yieldSamples([
          { id: "ok-1", input: "a", expected_output: "a" },
          { id: "review-pass-1", input: "b", expected_output: "b" },
          { id: "review-fail-1", input: "c", expected_output: "c" },
          { id: "abstain-1", input: "d", expected_output: "d" },
        ]),
      },
      compiledGraders: [panelishGrader("panel")],
      opts: { invoker, outDir },
    });

    // The verdicts are REAL: pass rate = 2 passes / 3 graded (only the
    // abstained sample left the denominator — needs-review never does).
    expect(summary.aggregates.passRate).toBeCloseTo(2 / 3);

    // Separate buckets, both listed, disjoint.
    expect(summary.aggregates.needsHuman).toBe(1);
    expect(summary.aggregates.needsHumanSampleIds).toEqual(["abstain-1"]);
    expect(summary.aggregates.needsReview).toBe(2);
    expect(summary.aggregates.needsReviewSampleIds).toEqual(["review-pass-1", "review-fail-1"]);

    // The overall grade carries the fold; verdicts untouched.
    const reviewPass = summary.samples.find((s) => s.sampleId === "review-pass-1");
    expect(reviewPass?.grades.overall.needsReview).toBe(true);
    expect(reviewPass?.grades.overall.passed).toBe(true);
    expect(sampleNeedsReview(reviewPass as never)).toBe(true);
    expect(sampleAbstained(reviewPass as never)).toBe(false);
    const reviewFail = summary.samples.find((s) => s.sampleId === "review-fail-1");
    expect(reviewFail?.grades.overall.needsReview).toBe(true);
    expect(reviewFail?.grades.overall.passed).toBe(false);

    // An abstained sample is needs-human, never ALSO needs-review.
    const abstained = summary.samples.find((s) => s.sampleId === "abstain-1");
    expect(abstained?.grades.overall.abstained).toBe(true);
    expect(sampleNeedsReview(abstained as never)).toBe(false);

    // The panel evidence persists into grades.json (perGrader entry).
    const grades = JSON.parse(readFileSync(join(outDir, "review-pass-1", "grades.json"), "utf-8"));
    const entry = grades.perGrader.find((g: { name: string }) => g.name === "panel");
    expect(entry.needsReview).toBe(true);
    expect(entry.panel.voteEntropy).toBeCloseTo(0.918, 3);
    expect(entry.panel.panelists).toHaveLength(3);
    expect(grades.overall.needsReview).toBe(true);
  });

  test("abstain wins over the flag: an abstained sample never lists as needs-review", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    // Two graders on one sample: one abstains, one flags review (and passes).
    const flagging: CompiledGrader = {
      name: "flagging",
      weight: 1,
      grader: async () => ({
        passed: true,
        score: 1,
        rationale: "split but passing",
        needsReview: true,
      }),
    };
    const summary = await runEval({
      ir,
      dataset: {
        name: "abstain-and-flag",
        samples: yieldSamples([{ id: "abstain-flag-1", input: "a", expected_output: "a" }]),
      },
      compiledGraders: [panelishGrader("panel"), flagging],
      opts: { invoker, outDir },
    });
    const s = summary.samples[0];
    expect(s?.grades.overall.abstained).toBe(true);
    expect(s?.grades.overall.needsReview).toBeUndefined();
    expect(summary.aggregates.needsHuman).toBe(1);
    expect("needsReview" in summary.aggregates).toBe(false);
  });

  test("flag-free runs carry no needsReview fields (pre-A2 shape)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "clean",
        samples: yieldSamples([{ id: "ok-1", input: "a", expected_output: "a" }]),
      },
      compiledGraders: [panelishGrader("panel")],
      opts: { invoker, outDir },
    });
    expect("needsReview" in summary.aggregates).toBe(false);
    expect("needsReviewSampleIds" in summary.aggregates).toBe(false);
    expect("needsReview" in (summary.samples[0]?.grades.overall ?? {})).toBe(false);
  });
});
