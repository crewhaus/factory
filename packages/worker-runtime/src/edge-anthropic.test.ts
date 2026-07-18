import { describe, expect, test } from "bun:test";
import { EFFORT_THINKING_BUDGET_TOKENS } from "@crewhaus/adapter-anthropic";
import { EDGE_EFFORT_THINKING_BUDGET_TOKENS, createEdgeAnthropicAdapter } from "./edge-anthropic";
import { runWorkerLoop } from "./loop";
import type { WorkerPlatform } from "./platform";

function sse(frames: Array<[string, unknown]>): string {
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const TEXT_STREAM = sse([
  [
    "message_start",
    { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi " } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  ],
  ["message_stop", { type: "message_stop" }],
]);

function fetchPlatform(fetchImpl: typeof fetch): WorkerPlatform {
  let n = 0;
  return { now: () => 1000, randomId: () => `id-${++n}`, fetch: fetchImpl };
}

describe("edge Anthropic adapter (over injected fetch)", () => {
  test("parses a real SSE text stream end to end", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const platform = fetchPlatform((async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body as string);
      return new Response(TEXT_STREAM, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch);

    const result = await runWorkerLoop({
      platform,
      model: "claude-sonnet-4-5",
      instructions: "sys",
      messages: [{ role: "user", content: "hey" }],
      apiKey: "sk-test",
    });

    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("hi there");
    expect(result.usage.input).toBe(12);
    expect(result.usage.output).toBe(7);
    expect(seenUrl).toContain("api.anthropic.com");
    expect((seenBody as { stream: boolean }).stream).toBe(true);
    expect((seenBody as { model: string }).model).toBe("claude-sonnet-4-5");
  });

  test("a non-2xx response becomes a classified auth failure", async () => {
    const platform = fetchPlatform(
      (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    );
    const result = await runWorkerLoop({
      platform,
      model: "m",
      instructions: "s",
      messages: [{ role: "user", content: "x" }],
      apiKey: "bad",
    });
    expect(result.stopReason).toBe("error");
    expect(result.failure?.class).toBe("auth");
    expect(result.failure?.exitCode).toBe(30);
  });

  test("thinking lifts max_tokens on the wire body", async () => {
    let body: Record<string, unknown> = {};
    const platform = fetchPlatform((async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(TEXT_STREAM, { status: 200 });
    }) as unknown as typeof fetch);
    await runWorkerLoop({
      platform,
      model: "m",
      instructions: "s",
      messages: [{ role: "user", content: "x" }],
      apiKey: "k",
      maxTokens: 4096,
      thinking: { budgetTokens: 10_000 },
    });
    expect(body["max_tokens"]).toBe(14_096);
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 10_000 });
  });

  test("estimateTokens is available on the built adapter", () => {
    const platform = fetchPlatform(
      (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    );
    const adapter = createEdgeAnthropicAdapter(platform, { apiKey: "k" });
    expect(adapter.estimateTokens([{ role: "user", content: "hello world" }])).toBeGreaterThan(0);
    expect(adapter.providerId).toBe("anthropic");
  });

  test("the local effort preset matches the Node adapter's table (no drift)", () => {
    expect(EDGE_EFFORT_THINKING_BUDGET_TOKENS).toEqual(EFFORT_THINKING_BUDGET_TOKENS);
  });
});
