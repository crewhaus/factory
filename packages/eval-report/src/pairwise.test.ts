/**
 * A1 — pairwise-diff bookkeeping: tally math (a tie must NEVER count as a
 * win), the stdout block, transcript input extraction, and diff.json
 * additivity (no --pairwise ⇒ byte-identical output).
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { diffReports } from "./diff";
import type { LoadedRun } from "./load";
import {
  type PairwiseSampleVerdict,
  extractSampleInput,
  formatPairwiseLines,
  summarizePairwise,
} from "./pairwise";

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function makeRunSummary(runId: string, samples: SampleResult[]): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((s, x) => s + x.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "<tmp>",
  };
}

function loadedRun(summary: EvalRunSummary, perSample: LoadedRun["perSample"] = {}): LoadedRun {
  return { summary, perSample };
}

const win = (
  sampleId: string,
  winner: "prev" | "new" | "tie",
  agreed = true,
): PairwiseSampleVerdict => ({
  sampleId,
  prevFirst: { winner: agreed ? winner : "prev", rationale: "r1" },
  newFirst: { winner: agreed ? winner : "new", rationale: "r2" },
  agreed,
  verdict: winner,
});

describe("summarizePairwise (A1)", () => {
  test("tallies consolidated verdicts; win-rate counts ties half", () => {
    const p = summarizePairwise("judge-m", [
      win("s1", "new"),
      win("s2", "new"),
      win("s3", "prev"),
      win("s4", "tie"),
    ]);
    expect(p.newWins).toBe(2);
    expect(p.prevWins).toBe(1);
    expect(p.ties).toBe(1);
    expect(p.winRate).toBeCloseTo((2 + 0.5) / 4); // 0.625
    expect(p.orderConsistency).toBe(1);
    expect("skippedErrored" in p).toBe(false);
  });

  test("a tie is NEVER counted a win — including order-disagreement ties", () => {
    // Both samples' orders disagreed (position bias): consolidated ties.
    const p = summarizePairwise("judge-m", [win("s1", "tie", false), win("s2", "tie", false)]);
    expect(p.newWins).toBe(0);
    expect(p.prevWins).toBe(0);
    expect(p.ties).toBe(2);
    expect(p.winRate).toBeCloseTo(0.5); // dead even, not a win for either side
    expect(p.orderConsistency).toBe(0);
  });

  test("zero judged samples read zero rates", () => {
    const p = summarizePairwise("judge-m", []);
    expect(p.winRate).toBe(0);
    expect(p.orderConsistency).toBe(0);
  });

  test("skippedErrored is recorded only when > 0", () => {
    expect("skippedErrored" in summarizePairwise("m", [], { skippedErrored: 0 })).toBe(false);
    expect(summarizePairwise("m", [], { skippedErrored: 2 }).skippedErrored).toBe(2);
  });
});

describe("formatPairwiseLines (A1)", () => {
  test("one summary line, plus the skip note when samples were skipped", () => {
    const p = summarizePairwise(
      "judge-m",
      [win("s1", "new"), win("s2", "prev"), win("s3", "tie", false)],
      { skippedErrored: 1 },
    );
    const lines = formatPairwiseLines(p);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("pairwise (judge judge-m)");
    expect(lines[0]).toContain("new wins 1");
    expect(lines[0]).toContain("prev wins 1");
    expect(lines[0]).toContain("ties 1");
    expect(lines[0]).toContain("win-rate 50.0%");
    expect(lines[0]).toContain("order-consistency 66.7%");
    expect(lines[1]).toContain("1 sample(s) skipped");
  });
});

describe("extractSampleInput (A1)", () => {
  const artifacts = (transcript: string): LoadedRun["perSample"][string] => ({
    transcript,
    events: "",
    grades: "",
    meta: "",
  });

  test("returns the first user_message's string content", () => {
    const transcript = [
      JSON.stringify({
        ts: 1,
        version: 1,
        kind: "user_message",
        payload: { content: "the question" },
      }),
      JSON.stringify({
        ts: 2,
        version: 1,
        kind: "assistant_message",
        payload: { content: "answer" },
      }),
    ].join("\n");
    const run = loadedRun(makeRunSummary("run_a", []), { s1: artifacts(transcript) });
    expect(extractSampleInput(run, "s1")).toBe("the question");
  });

  test("joins text blocks when content is an array (non-text blocks dropped)", () => {
    const transcript = JSON.stringify({
      ts: 1,
      version: 1,
      kind: "user_message",
      payload: {
        content: [
          { type: "text", text: "part one" },
          { type: "image", source: {} },
          { type: "text", text: "part two" },
        ],
      },
    });
    const run = loadedRun(makeRunSummary("run_a", []), { s1: artifacts(transcript) });
    expect(extractSampleInput(run, "s1")).toBe("part one\npart two");
  });

  test("resolves sanitized sample-directory names (id with slashes)", () => {
    const transcript = JSON.stringify({
      ts: 1,
      version: 1,
      kind: "user_message",
      payload: { content: "hi" },
    });
    const run = loadedRun(makeRunSummary("run_a", []), { a_b_c: artifacts(transcript) });
    expect(extractSampleInput(run, "a/b c")).toBe("hi");
  });

  test("tolerates missing/empty/torn transcripts", () => {
    const run = loadedRun(makeRunSummary("run_a", []), {
      empty: artifacts(""),
      torn: artifacts('{"kind": "user_mess'),
    });
    expect(extractSampleInput(run, "absent")).toBeUndefined();
    expect(extractSampleInput(run, "empty")).toBeUndefined();
    expect(extractSampleInput(run, "torn")).toBeUndefined();
  });
});

describe("diffReports — pairwise additivity (A1)", () => {
  const prev = loadedRun(
    makeRunSummary("run_prev", [makeSampleResult("s1", true, 1), makeSampleResult("s2", false, 0)]),
  );
  const next = loadedRun(
    makeRunSummary("run_next", [makeSampleResult("s1", true, 1), makeSampleResult("s2", true, 1)]),
  );

  test("without opts.pairwise, diff.json carries no pairwise key (byte-identical)", () => {
    const base = diffReports(prev, next);
    expect("pairwise" in base.diff).toBe(false);
    expect(JSON.parse(base.json)).not.toHaveProperty("pairwise");
    expect(base.html).not.toContain("Pairwise judging");
  });

  test("with opts.pairwise, the block lands in diff.json and the report — everything else unchanged", () => {
    const base = diffReports(prev, next);
    const pairwise = summarizePairwise("judge-m", [win("s1", "tie"), win("s2", "new", false)], {
      skippedErrored: 1,
    });
    const withPairwise = diffReports(prev, next, { pairwise });

    const parsed = JSON.parse(withPairwise.json);
    expect(parsed.pairwise).toEqual(JSON.parse(JSON.stringify(pairwise)));
    // The pre-existing diff fields are untouched by the additive block.
    const { pairwise: _p, ...rest } = parsed;
    expect(rest).toEqual(JSON.parse(base.json));

    expect(withPairwise.html).toContain("Pairwise judging (2)");
    expect(withPairwise.html).toContain("judge-m");
    expect(withPairwise.html).toContain("order-consistency");
    expect(withPairwise.html).toContain("1 sample(s) skipped");
  });
});
