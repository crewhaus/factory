/**
 * A1 — `eval-report diff --pairwise` CLI orchestration: the credential
 * gate's die-message (opt-in judging must fail loudly without judge
 * credentials, never silently skip) and the order-swapped judging loop
 * over two loaded runs, driven by an injected stub adapter (no network).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { DEFAULT_JUDGE_MODEL } from "@crewhaus/eval-judge";
import type { LoadedRun } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  judgeRunsPairwise,
  pairwiseCredentialError,
  resolvePairwiseJudgeModel,
} from "./eval-pairwise";

function makeSample(id: string, output: string, error?: string): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: output,
    grades: {
      overall: { passed: true, score: 1, rationale: "ok" },
      perGrader: [{ name: "exact", passed: true, score: 1, rationale: "" }],
    },
    ...(error !== undefined ? { error } : {}),
  };
}

function makeRun(runId: string, samples: SampleResult[]): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10, output: 20 },
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

function transcriptWith(input: string): LoadedRun["perSample"][string] {
  return {
    transcript: JSON.stringify({
      ts: 1,
      version: 1,
      kind: "user_message",
      payload: { content: input },
    }),
    events: "",
    grades: "",
    meta: "",
  };
}

/** Content-aware stub pairwise judge: prefers the response containing BETTER. */
function makeStubAdapter(seenUserTexts: string[]): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      seenUserTexts.push(userText);
      const aBlock = userText.slice(userText.indexOf("Response A"), userText.indexOf("Response B"));
      const bBlock = userText.slice(userText.indexOf("Response B"));
      const verdict = aBlock.includes("BETTER")
        ? { winner: "a", rationale: "A better" }
        : bBlock.includes("BETTER")
          ? { winner: "b", rationale: "B better" }
          : { winner: "tie", rationale: "even" };
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_pair", name: "submit_comparison", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("pairwiseCredentialError (A1)", () => {
  test("dies clearly when the judge model's credentials are absent", () => {
    const msg = pairwiseCredentialError(DEFAULT_JUDGE_MODEL, {});
    expect(msg).toBeDefined();
    expect(msg).toContain("--pairwise");
    expect(msg).toContain("judge credentials");
    expect(msg).toContain(DEFAULT_JUDGE_MODEL);
    expect(msg).toContain("--judge-model");
  });

  test("passes when the provider's env is visibly satisfied", () => {
    expect(
      pairwiseCredentialError(DEFAULT_JUDGE_MODEL, { ANTHROPIC_API_KEY: "test-key" }),
    ).toBeUndefined();
    expect(
      pairwiseCredentialError("openai/gpt-4o", { OPENAI_API_KEY: "test-key" }),
    ).toBeUndefined();
    // Cross-provider mismatch still dies.
    expect(pairwiseCredentialError("openai/gpt-4o", { ANTHROPIC_API_KEY: "k" })).toBeDefined();
  });
});

describe("resolvePairwiseJudgeModel (A1)", () => {
  test("flag wins; absent/empty falls back to the default judge", () => {
    expect(resolvePairwiseJudgeModel("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(resolvePairwiseJudgeModel(undefined)).toBe(DEFAULT_JUDGE_MODEL);
    expect(resolvePairwiseJudgeModel("")).toBe(DEFAULT_JUDGE_MODEL);
    expect(resolvePairwiseJudgeModel(true)).toBe(DEFAULT_JUDGE_MODEL);
  });
});

describe("judgeRunsPairwise (A1)", () => {
  test("judges shared samples in sorted order, skips errored sides, extracts inputs", async () => {
    const seen: string[] = [];
    const adapter = makeStubAdapter(seen);
    // Deliberately unsorted sample arrays; z-1 errored on the new side.
    const prev: LoadedRun = {
      summary: makeRun("run_prev", [
        makeSample("z-1", "old z"),
        makeSample("b-1", "BETTER answer b"),
        makeSample("a-1", "old a"),
      ]),
      perSample: { "a-1": transcriptWith("question A"), "b-1": transcriptWith("question B") },
    };
    const next: LoadedRun = {
      summary: makeRun("run_next", [
        makeSample("a-1", "BETTER answer a"),
        makeSample("b-1", "worse b"),
        makeSample("z-1", "crashed", "provider blew up"),
      ]),
      perSample: {},
    };

    const result = await judgeRunsPairwise(prev, next, { judgeModel: "stub-judge", adapter });

    // Deterministic ordering: sorted shared ids, errored z-1 skipped.
    expect(result.samples.map((s) => s.sampleId)).toEqual(["a-1", "b-1"]);
    expect(result.skippedErrored).toBe(1);
    expect(result.judgeModel).toBe("stub-judge");

    // a-1: NEW output is better in both orders → new win.
    const a1 = result.samples[0];
    expect(a1?.verdict).toBe("new");
    expect(a1?.agreed).toBe(true);
    // b-1: PREV output is better in both orders → prev win.
    const b1 = result.samples[1];
    expect(b1?.verdict).toBe("prev");
    expect(b1?.agreed).toBe(true);

    expect(result.newWins).toBe(1);
    expect(result.prevWins).toBe(1);
    expect(result.ties).toBe(0);
    expect(result.winRate).toBeCloseTo(0.5);
    expect(result.orderConsistency).toBe(1);

    // Two order-swapped calls per judged sample.
    expect(seen).toHaveLength(4);
    // The transcript-extracted input reached the judge prompts.
    expect(seen[0]).toContain("question A");
    expect(seen[2]).toContain("question B");
  });

  test("a missing transcript degrades to the explicit input-unavailable note", async () => {
    const seen: string[] = [];
    const adapter = makeStubAdapter(seen);
    const prev: LoadedRun = {
      summary: makeRun("run_prev", [makeSample("s1", "x")]),
      perSample: {},
    };
    const next: LoadedRun = {
      summary: makeRun("run_next", [makeSample("s1", "y")]),
      perSample: {},
    };
    const result = await judgeRunsPairwise(prev, next, { judgeModel: "stub-judge", adapter });
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.verdict).toBe("tie");
    expect(seen[0]).toContain("input unavailable");
    expect("skippedErrored" in result).toBe(false);
  });
});
