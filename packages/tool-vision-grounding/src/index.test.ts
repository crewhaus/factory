import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { Driver } from "@crewhaus/computer-use-driver";
import { createFindElementTool } from "./index.js";

function stubDriver(pngBytes: Uint8Array): Driver {
  return {
    backend: "chromium",
    async connect() {},
    async goto() {},
    async screenshot() {
      return pngBytes;
    },
    async click() {},
    async type() {},
    async key() {},
    async scroll() {},
    async getViewport() {
      return { width: 800, height: 600, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
}

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
    stream: () =>
      (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: reply },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn" };
        yield { kind: "message_stop" };
      })(),
  };
}

describe("createFindElementTool", () => {
  test("happy path: parses fenced JSON bbox + computes center coords (T3)", async () => {
    const adapter = scriptedAdapter(
      '```json\n{"bbox":{"x":100,"y":50,"width":80,"height":24},"confidence":"high"}\n```',
    );
    const driver = stubDriver(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });

    const r = await tool.execute({ description: "the Submit button" }, {});
    if (typeof r !== "string") throw new Error("expected string result");
    const parsed = JSON.parse(r);
    expect(parsed.bbox).toEqual({ x: 100, y: 50, width: 80, height: 24 });
    expect(parsed.centerX).toBe(140);
    expect(parsed.centerY).toBe(62);
    expect(parsed.confidence).toBe("high");
  });

  test("permissive fallback: parses raw JSON without code fence", async () => {
    const adapter = scriptedAdapter(
      'preamble {"bbox":{"x":1,"y":2,"width":3,"height":4},"confidence":"low"} trailing',
    );
    const driver = stubDriver(new Uint8Array());
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });
    const r = await tool.execute({ description: "x" }, {});
    if (typeof r !== "string") throw new Error("expected string result");
    expect(JSON.parse(r).bbox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  test("malformed JSON → retry then [FindElement error]", async () => {
    const adapter = scriptedAdapter("not json");
    const driver = stubDriver(new Uint8Array());
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });
    const r = await tool.execute({ description: "x" }, {});
    if (typeof r !== "string") throw new Error("expected string result");
    expect(r).toContain("[FindElement error]");
  });

  test("missing bbox numeric fields → error", async () => {
    const adapter = scriptedAdapter(
      '```json\n{"bbox":{"x":"oops","y":2,"width":3,"height":4}}\n```',
    );
    const driver = stubDriver(new Uint8Array());
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });
    const r = await tool.execute({ description: "x" }, {});
    if (typeof r !== "string") throw new Error("expected string result");
    expect(r).toContain("[FindElement error]");
  });

  test("flag profile: read-only, not destructive (vision-only — no UI mutation)", () => {
    const adapter = scriptedAdapter("{}");
    const driver = stubDriver(new Uint8Array());
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.name).toBe("FindElement");
  });

  test("invalid confidence value defaults to medium", async () => {
    const adapter = scriptedAdapter(
      '```json\n{"bbox":{"x":0,"y":0,"width":10,"height":10},"confidence":"unknown"}\n```',
    );
    const driver = stubDriver(new Uint8Array());
    const tool = createFindElementTool({ driver, model: "stub", _adapter: adapter });
    const r = await tool.execute({ description: "x" }, {});
    if (typeof r !== "string") throw new Error("expected string result");
    expect(JSON.parse(r).confidence).toBe("medium");
  });
});
