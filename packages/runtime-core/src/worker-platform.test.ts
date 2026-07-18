import { describe, expect, test } from "bun:test";
import { runWorkerLoop } from "@crewhaus/worker-runtime";
import { createInMemoryKV, createNodeWorkerPlatform } from "./worker-platform";

// G12 — prove the NODE WorkerPlatform impl drives the SHARED worker-runtime
// core end to end (the same loop a cf-worker runs), and that runtime-core
// re-exports the contract. These do not touch `runChatLoop`.

function sse(frames: Array<[string, unknown]>): string {
  return frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
}

const TEXT_STREAM = sse([
  [
    "message_start",
    { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  ],
  ["message_stop", { type: "message_stop" }],
]);

describe("createNodeWorkerPlatform", () => {
  test("provides a live clock, unique ids, and a bound fetch", () => {
    const platform = createNodeWorkerPlatform();
    expect(platform.now()).toBeGreaterThan(1_700_000_000_000);
    expect(platform.randomId()).not.toBe(platform.randomId());
    expect(typeof platform.fetch).toBe("function");
  });

  test("drives the shared worker-runtime core end to end", async () => {
    let sawKey = "";
    const platform = createNodeWorkerPlatform({
      fetch: (async (_url: string, init: RequestInit) => {
        sawKey = (init.headers as Record<string, string>)["x-api-key"] ?? "";
        return new Response(TEXT_STREAM, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await runWorkerLoop({
      platform,
      model: "claude-sonnet-4-5",
      instructions: "ping",
      messages: [{ role: "user", content: "ping" }],
      apiKey: "sk-node",
    });
    expect(result.stopReason).toBe("done");
    expect(result.text).toBe("pong");
    expect(sawKey).toBe("sk-node");
  });
});

describe("createInMemoryKV", () => {
  test("get / put / delete round-trip", async () => {
    const kv = createInMemoryKV();
    expect(await kv.get("a")).toBeNull();
    await kv.put("a", "1");
    expect(await kv.get("a")).toBe("1");
    await kv.delete("a");
    expect(await kv.get("a")).toBeNull();
  });

  test("honours expirationTtl", async () => {
    const kv = createInMemoryKV();
    await kv.put("t", "v", { expirationTtl: -1 }); // already expired
    expect(await kv.get("t")).toBeNull();
  });
});
