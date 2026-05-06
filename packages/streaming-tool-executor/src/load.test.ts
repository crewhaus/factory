/**
 * T7 load test for streaming-tool-executor: 50 partial tool_use blocks
 * arrive on the stream, all running a fast read-only no-op tool. We
 * confirm completion under a time budget, no race-induced lost results,
 * and stable ordering of results vs. finalContent.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type Anthropic from "@anthropic-ai/sdk";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { type AnthropicLikeStream, executeStreaming } from "./index";

class FakeStream extends EventEmitter implements AnthropicLikeStream {
  private resolveFinal!: (msg: { content: Anthropic.ContentBlock[] }) => void;
  readonly finalPromise: Promise<{ content: Anthropic.ContentBlock[] }>;
  constructor() {
    super();
    this.finalPromise = new Promise((res) => {
      this.resolveFinal = res;
    });
  }
  finish(content: Anthropic.ContentBlock[]): void {
    this.resolveFinal({ content });
  }
  finalMessage(): Promise<{ content: Anthropic.ContentBlock[] }> {
    return this.finalPromise;
  }
}

const noop = buildTool({
  name: "Read",
  description: "noop read",
  inputSchema: z.object({ id: z.number() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => `r:${input.id}`,
});

describe("streaming-tool-executor — T7 load", () => {
  test("50 partial tool_use blocks complete under 1s and preserve order", async () => {
    const stream = new FakeStream();
    const blocks: Anthropic.ToolUseBlock[] = Array.from(
      { length: 50 },
      (_, i) =>
        ({
          type: "tool_use",
          id: `tu_${i}`,
          name: "Read",
          input: { id: i },
        }) as Anthropic.ToolUseBlock,
    );

    const start = Date.now();
    const promise = executeStreaming(stream, {
      toolByName: new Map([["Read", noop]]),
    });

    // Schedule 50 contentBlock emits via setImmediate to mimic realistic
    // mid-stream arrival. Then resolve finalMessage shortly after.
    let i = 0;
    const tick = () => {
      if (i < blocks.length) {
        const block = blocks[i];
        if (block !== undefined) stream.emit("contentBlock", block);
        i += 1;
        setImmediate(tick);
      } else {
        setImmediate(() => stream.finish(blocks));
      }
    };
    setImmediate(tick);

    const out = await promise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(out.toolResults.length).toBe(50);

    // Order matches finalContent block order.
    expect(out.toolResults.map((r) => r.tool_use_id)).toEqual(blocks.map((b) => b.id));
    // Each result is the expected content.
    for (let k = 0; k < 50; k++) {
      expect(out.toolResults[k]?.content).toBe(`r:${k}`);
      expect(out.toolResults[k]?.is_error).toBe(false);
    }
  });
});
