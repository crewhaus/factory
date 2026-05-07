/**
 * T3 — single-turn `runChatLoop` round-trip emits the expected ordered
 * sequence of TraceEvents under one traceId.
 */
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent, TraceEventKind } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";

function makeOneTurnAdapter(
  toolUseId: string,
): import("@crewhaus/adapter-anthropic").ProviderAdapter {
  let i = 0;
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
      const isFirst = i === 0;
      i += 1;
      return (async function* () {
        yield {
          kind: "message_start",
          usage: { input: isFirst ? 100 : 150, output: 0 },
        } as const;
        if (isFirst) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: toolUseId, name: "noop", input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ x: 1 }) },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 100, output: 30 },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 150, output: 10 },
          } as const;
        }
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

describe("runChatLoop observability", () => {
  test("single turn with one tool call emits the expected event sequence", async () => {
    const noop = buildTool({
      name: "noop",
      description: "does nothing",
      inputSchema: z.object({ x: z.number() }),
      execute: async () => "ok",
    });
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeOneTurnAdapter("toolu_a"),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      tools: [noop],
      permissionMode: "default",
    });

    const kinds = seen.map((e) => e.kind);
    // Permissive ordering check: the spine of the run should appear in this order.
    const wantOrder: TraceEventKind[] = [
      "turn_start",
      "model_request",
      "model_response",
      "tool_call_start",
      "permission_decision",
      "tool_call_end",
      "model_request",
      "model_response",
      "turn_end",
    ];
    let cursor = 0;
    for (const target of wantOrder) {
      const idx = kinds.indexOf(target, cursor);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx + 1;
    }

    // All events share one traceId.
    const traceIds = new Set(seen.map((e) => e.traceId));
    expect(traceIds.size).toBe(1);

    // Tool span ids match for the start/end pair.
    const toolStart = seen.find((e) => e.kind === "tool_call_start" && e.toolUseId === "toolu_a");
    const toolEnd = seen.find((e) => e.kind === "tool_call_end" && e.toolUseId === "toolu_a");
    expect(toolStart?.spanId).toBeDefined();
    expect(toolEnd?.spanId).toBe(toolStart?.spanId);

    // The non-streaming path carries usage onto model_response.
    const response = seen.find(
      (e): e is Extract<TraceEvent, { kind: "model_response" }> => e.kind === "model_response",
    );
    expect(response?.usage.input).toBe(100);
    expect(response?.usage.output).toBe(30);
  });
});
