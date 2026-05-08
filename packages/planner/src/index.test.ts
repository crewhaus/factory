import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { PlannerError, decompose } from "./index.js";

function scriptedAdapter(reply: string): ProviderAdapter {
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
    stream: () => {
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: reply },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

describe("decompose", () => {
  test("happy path: parses fenced JSON with the requested number of questions", async () => {
    const adapter = scriptedAdapter('```json\n{"subQuestions":["q1","q2","q3"]}\n```');
    const plan = await decompose("a goal", {
      model: "stub-model",
      _adapter: adapter,
      branchingFactor: 3,
    });
    expect(plan.subQuestions).toEqual(["q1", "q2", "q3"]);
    expect(plan.goal).toBe("a goal");
    expect(plan.branchingFactor).toBe(3);
    expect(plan.version).toBe(1);
  });

  test("permissive fallback: parses raw JSON without code fence", async () => {
    const adapter = scriptedAdapter(' some preamble {"subQuestions":["a","b"]} trailing ');
    const plan = await decompose("g", { model: "m", _adapter: adapter, branchingFactor: 2 });
    expect(plan.subQuestions).toEqual(["a", "b"]);
  });

  test("rejects empty goal", async () => {
    const adapter = scriptedAdapter('```json\n{"subQuestions":["a"]}\n```');
    await expect(decompose("   ", { model: "m", _adapter: adapter })).rejects.toThrow(/non-empty/);
  });

  test("rejects branching factor out of range", async () => {
    const adapter = scriptedAdapter('```json\n{"subQuestions":[]}\n```');
    await expect(
      decompose("g", { model: "m", _adapter: adapter, branchingFactor: 0 }),
    ).rejects.toThrow(/branchingFactor must be 1\.\.8/);
  });

  test("retries once on bad JSON, then throws PlannerError", async () => {
    const adapter = scriptedAdapter("not json at all");
    await expect(decompose("g", { model: "m", _adapter: adapter })).rejects.toThrow(PlannerError);
  });

  test("rejects when model returns wrong number of sub-questions", async () => {
    const adapter = scriptedAdapter('```json\n{"subQuestions":["a","b"]}\n```');
    await expect(
      decompose("g", { model: "m", _adapter: adapter, branchingFactor: 3 }),
    ).rejects.toThrow(/expected 3/);
  });

  test("rejects empty / non-string sub-questions", async () => {
    const adapter = scriptedAdapter('```json\n{"subQuestions":["a", "  ", "c"]}\n```');
    await expect(
      decompose("g", { model: "m", _adapter: adapter, branchingFactor: 3 }),
    ).rejects.toThrow(/non-string or empty/);
  });
});
