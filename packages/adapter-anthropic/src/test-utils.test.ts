import { describe, expect, test } from "bun:test";
import { type ContractFixture, assertMatchesFixture } from "./test-utils.js";
import type { ProviderMessage } from "./types.js";

const FIXTURE: ContractFixture = {
  name: "text-and-tool",
  description: "a turn that emits text then a tool call",
  request: {
    system: "be helpful",
    messages: [{ role: "user", content: "read the file" }],
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
  },
  expected: {
    texts: ["Reading now"],
    toolCalls: [{ name: "Read", input: { path: "/tmp/x" } }],
    stopReason: "tool_use",
  },
};

describe("assertMatchesFixture", () => {
  test("passes when the message matches the fixture's expected shape", () => {
    const msg: ProviderMessage = {
      content: [
        { type: "text", text: "Reading now" },
        // id is provider-specific and intentionally ignored by the matcher.
        {
          type: "tool_use",
          id: "toolu_provider_specific",
          name: "Read",
          input: { path: "/tmp/x" },
        },
      ],
      stopReason: "tool_use",
      usage: { input: 1, output: 2 },
    };
    // Should not throw.
    expect(() => assertMatchesFixture(msg, FIXTURE)).not.toThrow();
  });

  test("ignores thinking blocks (only text + tool_use are compared)", () => {
    const fx: ContractFixture = {
      ...FIXTURE,
      expected: { texts: ["hi"], toolCalls: [], stopReason: "end_turn" },
    };
    const msg: ProviderMessage = {
      content: [
        { type: "thinking", thinking: "hmm", signature: "s" },
        { type: "text", text: "hi" },
      ],
      stopReason: "end_turn",
      usage: { input: 0, output: 0 },
    };
    expect(() => assertMatchesFixture(msg, fx)).not.toThrow();
  });

  test("throws when the text content diverges from the fixture", () => {
    const msg: ProviderMessage = {
      content: [{ type: "text", text: "WRONG" }],
      stopReason: "tool_use",
      usage: { input: 0, output: 0 },
    };
    expect(() => assertMatchesFixture(msg, FIXTURE)).toThrow();
  });
});
