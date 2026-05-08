import { describe, expect, test } from "bun:test";
/**
 * T7 load test for streaming-tool-executor: 50 tool_use blocks arrive
 * on the stream, all running a fast read-only no-op tool. We confirm
 * completion under a time budget, no race-induced lost results, and
 * stable ordering of results vs. finalContent.
 *
 * Section 17 refactor: the test now feeds an AsyncIterable<StreamEvent>
 * instead of the old AnthropicLikeStream event emitter.
 */
import type { StreamEvent } from "@crewhaus/adapter-anthropic";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { executeStreaming } from "./index";

const noop = buildTool({
  name: "Read",
  description: "noop read",
  inputSchema: z.object({ id: z.number() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => `r:${input.id}`,
});

async function* fiftyToolUseStream(): AsyncIterable<StreamEvent> {
  yield { kind: "message_start" };
  for (let i = 0; i < 50; i++) {
    yield {
      kind: "content_block_start",
      index: i,
      block: { type: "tool_use", id: `tu_${i}`, name: "Read", input: {} },
    };
    yield {
      kind: "content_block_delta",
      index: i,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ id: i }) },
    };
    yield { kind: "content_block_stop", index: i };
    // Mimic realistic mid-stream arrival.
    await new Promise<void>((r) => setImmediate(r));
  }
  yield { kind: "message_delta", stopReason: "tool_use" };
  yield { kind: "message_stop" };
}

describe("streaming-tool-executor — T7 load", () => {
  test("50 tool_use blocks complete under 1s and preserve order", async () => {
    const start = Date.now();
    const out = await executeStreaming(fiftyToolUseStream(), {
      toolByName: new Map([["Read", noop]]),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(out.toolResults.length).toBe(50);

    // Order matches finalContent block order.
    const expectedIds = Array.from({ length: 50 }, (_, i) => `tu_${i}`);
    expect(out.toolResults.map((r) => r.tool_use_id)).toEqual(expectedIds);
  });
});
