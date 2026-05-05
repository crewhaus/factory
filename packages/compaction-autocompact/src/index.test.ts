import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { RuntimeError } from "@crewhaus/errors";
import { autoCompact } from "./index";

type CreateArgs = {
  model: string;
  max_tokens: number;
  messages: Anthropic.MessageParam[];
};

function makeStubClient(response: Pick<Anthropic.Message, "content">): {
  client: Anthropic;
  lastArgs: () => CreateArgs | undefined;
  callCount: () => number;
} {
  let count = 0;
  let lastArgs: CreateArgs | undefined;
  const client = {
    messages: {
      create: async (args: CreateArgs) => {
        count++;
        lastArgs = args;
        return response as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return { client, lastArgs: () => lastArgs, callCount: () => count };
}

describe("autoCompact", () => {
  test("returns [user-marker, assistant-summary] tuple", async () => {
    const { client } = makeStubClient({
      content: [{ type: "text", text: "summary stub", citations: null }],
    });
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const result = await autoCompact(messages, client, "claude-opus-4-7");

    expect(result.length).toBe(2);
    expect(result[0]?.role).toBe("user");
    expect(typeof result[0]?.content).toBe("string");
    expect(result[0]?.content as string).toContain("Previous conversation summary");
    expect(result[1]).toEqual({ role: "assistant", content: "summary stub" });
  });

  test("forwards the model id to the client", async () => {
    const { client, lastArgs } = makeStubClient({
      content: [{ type: "text", text: "x", citations: null }],
    });
    await autoCompact([], client, "claude-opus-4-7");
    expect(lastArgs()?.model).toBe("claude-opus-4-7");
  });

  test("appends the summarization request after the original messages", async () => {
    const { client, lastArgs } = makeStubClient({
      content: [{ type: "text", text: "x", citations: null }],
    });
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    await autoCompact(messages, client, "m");
    const args = lastArgs();
    expect(args).toBeDefined();
    if (!args) throw new Error("unreachable");
    expect(args.messages.length).toBe(3);
    expect(args.messages[0]).toEqual({ role: "user", content: "first" });
    expect(args.messages[1]).toEqual({ role: "assistant", content: "second" });
    expect(args.messages[2]?.role).toBe("user");
    expect(args.messages[2]?.content as string).toContain("Summarize");
  });

  test("does not mutate the input messages", async () => {
    const { client } = makeStubClient({
      content: [{ type: "text", text: "x", citations: null }],
    });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "a" }];
    const before = messages.length;
    await autoCompact(messages, client, "m");
    expect(messages.length).toBe(before);
  });

  test("throws RuntimeError when the response has no text block", async () => {
    const { client } = makeStubClient({ content: [] });
    await expect(autoCompact([], client, "m")).rejects.toBeInstanceOf(RuntimeError);
  });

  test("uses the first text block when multiple are present", async () => {
    const { client } = makeStubClient({
      content: [
        { type: "text", text: "first text", citations: null },
        { type: "text", text: "second text", citations: null },
      ],
    });
    const result = await autoCompact([], client, "m");
    expect(result[1]).toEqual({ role: "assistant", content: "first text" });
  });
});
