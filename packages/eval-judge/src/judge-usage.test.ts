/**
 * C35 — the judge wire now REPORTS the token usage the provider returns
 * (it was previously read off the stream and discarded), through the
 * optional `onUsage` sink threaded into `judge`, `judgeCategorical` and
 * every call `createJudgeGrader` makes.
 *
 * Driven over a stub ProviderAdapter — a real eval-judge stack, no network,
 * no `mock.module`.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { createJudgeGrader, judge } from "./judge";
import { loadRubric } from "./rubric";

type Served = { model: string };

function stubAdapter(opts: {
  usage: { input: number; output: number };
  verdict?: Record<string, unknown>;
  tool?: string;
  served?: Served[];
}): ProviderAdapter {
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
      opts.served?.push({ model: req.model });
      const tool = opts.tool ?? req.tools?.[0]?.name ?? "submit_score";
      const verdict = opts.verdict ?? {
        score: 4,
        rationale: "fine",
        criterion_scores: { quality: 4 },
      };
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: opts.usage.input, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: tool, input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: "tool_use",
          usage: { input: opts.usage.input, output: opts.usage.output },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
}

const RUBRIC = loadRubric({
  criteria: [
    {
      name: "quality",
      description: "is it good",
      anchors: { "1": "no", "2": "meh", "3": "ok", "4": "good", "5": "great" },
    },
  ],
  passing_score: 3,
});

const SAMPLE = { id: "s1", input: "question" };
const RUN = {
  agentOutput: "answer",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 5,
};

describe("judge onUsage (C35)", () => {
  test("reports the provider's usage with the model string the caller named", async () => {
    const seen: Array<{ model: string; input: number; output: number }> = [];
    await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "answer",
      adapter: stubAdapter({ usage: { input: 321, output: 45 } }),
      model: "openai/gpt-judge",
      onUsage: (u) => seen.push(u),
    });
    expect(seen).toEqual([{ model: "openai/gpt-judge", input: 321, output: 45 }]);
  });

  test("meters even when the judge's response fails validation — the tokens were spent", async () => {
    const seen: Array<{ model: string; input: number; output: number }> = [];
    await expect(
      judge({
        rubric: RUBRIC,
        sample: SAMPLE,
        agentOutput: "answer",
        // score 9 is out of the 1–5 schema range: the call throws AFTER the
        // usage has already been billed by the provider.
        adapter: stubAdapter({
          usage: { input: 10, output: 2 },
          verdict: { score: 9, rationale: "bad shape", criterion_scores: {} },
        }),
        onUsage: (u) => seen.push(u),
      }),
    ).rejects.toThrow(/invalid shape/);
    // The default judge model is reported when the caller named none.
    expect(seen).toEqual([{ model: "claude-sonnet-4-5", input: 10, output: 2 }]);
  });

  test("no sink = no behaviour change (the grader still returns its verdict)", async () => {
    const grader = createJudgeGrader(RUBRIC, {
      adapter: stubAdapter({ usage: { input: 1, output: 1 } }),
    });
    const grade = await grader(SAMPLE, RUN);
    expect(grade.passed).toBe(true);
    expect(grade.score).toBeCloseTo(0.75, 10);
  });

  test("createJudgeGrader meters every repeat call", async () => {
    const seen: Array<{ model: string }> = [];
    const grader = createJudgeGrader(RUBRIC, {
      adapter: stubAdapter({ usage: { input: 7, output: 3 } }),
      model: "judge-x",
      repeats: 3,
      onUsage: (u) => seen.push(u),
    });
    await grader(SAMPLE, RUN);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.model))).toEqual(new Set(["judge-x"]));
  });

  test("createJudgeGrader meters each PANELIST under its own model string", async () => {
    const seen: Array<{ model: string }> = [];
    const grader = createJudgeGrader(RUBRIC, {
      adapter: stubAdapter({ usage: { input: 2, output: 1 } }),
      judges: ["judge-a", "judge-b", "judge-c"],
      onUsage: (u) => seen.push(u),
    });
    await grader(SAMPLE, RUN);
    expect(seen.map((s) => s.model).sort()).toEqual(["judge-a", "judge-b", "judge-c"]);
  });
});
