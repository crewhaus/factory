import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { TokenBudget, estimateTokens } from "./index";

describe("estimateTokens", () => {
  test("empty array is 0 tokens", () => {
    expect(estimateTokens([])).toBe(0);
  });

  test("plain string content uses char-count / 4", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello world" }, // 11 chars → ceil(11/4) = 3
    ];
    expect(estimateTokens(messages)).toBe(3);
  });

  test("text content blocks sum across messages", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "abcd" }] }, // 4 → 1
      { role: "assistant", content: [{ type: "text", text: "efgh" }] }, // 4 → 1
    ];
    // total chars = 8, ceil(8/4) = 2
    expect(estimateTokens(messages)).toBe(2);
  });

  test("tool_use block counts input JSON + tool name", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash", // 4 chars
            input: { command: "ls" }, // JSON: {"command":"ls"} = 16 chars
          },
        ],
      },
    ];
    // chars = 4 + 16 = 20, ceil(20/4) = 5
    expect(estimateTokens(messages)).toBe(5);
  });

  test("tool_result with string content counts string length", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "exit code 0", // 11 chars
          },
        ],
      },
    ];
    expect(estimateTokens(messages)).toBe(3);
  });

  test("tool_result with text-block array sums inner text", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [{ type: "text", text: "abcdefgh" }], // 8 chars
          },
        ],
      },
    ];
    expect(estimateTokens(messages)).toBe(2);
  });

  test("image / document blocks are ignored", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "x".repeat(1000) },
          },
        ],
      },
    ];
    expect(estimateTokens(messages)).toBe(0);
  });
});

describe("TokenBudget", () => {
  test("rejects non-positive limit", () => {
    expect(() => new TokenBudget(0)).toThrow(RangeError);
    expect(() => new TokenBudget(-100)).toThrow(RangeError);
  });

  test("starts at 0 used", () => {
    const b = new TokenBudget(1000);
    expect(b.used).toBe(0);
    expect(b.limit).toBe(1000);
  });

  test("add accumulates input and output", () => {
    const b = new TokenBudget(1000);
    b.add(100, 50);
    expect(b.used).toBe(150);
    b.add(200, 0);
    expect(b.used).toBe(350);
  });

  test("isApproachingLimit returns false below threshold (default 0.85)", () => {
    const b = new TokenBudget(1000);
    b.add(800, 0); // 0.80 < 0.85
    expect(b.isApproachingLimit()).toBe(false);
  });

  test("isApproachingLimit returns true at exactly the threshold", () => {
    const b = new TokenBudget(1000);
    b.add(850, 0); // exactly 0.85
    expect(b.isApproachingLimit()).toBe(true);
  });

  test("isApproachingLimit returns true above the threshold", () => {
    const b = new TokenBudget(1000);
    b.add(900, 100); // 1.0
    expect(b.isApproachingLimit()).toBe(true);
  });

  test("custom threshold flips the boundary", () => {
    const b = new TokenBudget(1000);
    b.add(500, 0);
    expect(b.isApproachingLimit(0.5)).toBe(true);
    expect(b.isApproachingLimit(0.6)).toBe(false);
  });

  test("rejects threshold outside (0, 1]", () => {
    const b = new TokenBudget(1000);
    expect(() => b.isApproachingLimit(0)).toThrow(RangeError);
    expect(() => b.isApproachingLimit(1.5)).toThrow(RangeError);
    expect(() => b.isApproachingLimit(-0.1)).toThrow(RangeError);
  });
});
