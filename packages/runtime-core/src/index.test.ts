import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { resolveAuth, runChatLoop } from "./index";

describe("resolveAuth", () => {
  test("returns mode=none when neither var is set", () => {
    expect(resolveAuth({})).toEqual({ mode: "none" });
  });

  test("recognizes an OAuth token by the sk-ant-oat prefix", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc" })).toEqual({
      mode: "oauth",
      token: "sk-ant-oat01-abc",
    });
  });

  test("treats a non-OAuth ANTHROPIC_AUTH_TOKEN as an API key", () => {
    expect(resolveAuth({ ANTHROPIC_AUTH_TOKEN: "sk-ant-api01-xyz" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-xyz",
    });
  });

  test("falls back to ANTHROPIC_API_KEY when AUTH_TOKEN is missing", () => {
    expect(resolveAuth({ ANTHROPIC_API_KEY: "sk-ant-api01-aaa" })).toEqual({
      mode: "api-key",
      token: "sk-ant-api01-aaa",
    });
  });

  test("AUTH_TOKEN takes precedence over API_KEY", () => {
    expect(
      resolveAuth({
        ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc",
        ANTHROPIC_API_KEY: "sk-ant-api01-xyz",
      }),
    ).toEqual({ mode: "oauth", token: "sk-ant-oat01-abc" });
  });

  test("ignores empty-string env values", () => {
    expect(
      resolveAuth({ ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-ant-api01-only" }),
    ).toEqual({ mode: "api-key", token: "sk-ant-api01-only" });
  });
});

/** Anthropic client stub that counts `messages.stream` calls. */
function makeStubClient(reply = "ok"): { client: Anthropic; calls: () => number } {
  let calls = 0;
  const client = {
    messages: {
      stream: () => {
        calls++;
        return {
          on: () => {},
          finalMessage: async () => ({ content: [{ type: "text", text: reply }] }),
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => calls };
}

describe("runChatLoop stdin EOF handling", () => {
  test("exits cleanly when the input stream is already at EOF", async () => {
    const input = new PassThrough();
    input.end();
    const { client, calls } = makeStubClient();

    await runChatLoop({ model: "test-model", instructions: "test", client, input });

    expect(calls()).toBe(0);
  });

  test("exits cleanly after consuming buffered input followed by EOF", async () => {
    const input = new PassThrough();
    input.write("hi\n");
    input.end();
    const { client, calls } = makeStubClient("hello back");

    await runChatLoop({ model: "test-model", instructions: "test", client, input });

    expect(calls()).toBe(1);
  });
});

/** Scripted Anthropic stub that cycles through pre-baked content blocks per call. */
function makeScriptedClient(scripts: ReadonlyArray<Anthropic.ContentBlock[]>): {
  client: Anthropic;
  callCount: () => number;
  capturedMessages: () => ReadonlyArray<ReadonlyArray<Anthropic.MessageParam>>;
  capturedTools: () => ReadonlyArray<Anthropic.Tool[] | undefined>;
} {
  const captures: Anthropic.MessageParam[][] = [];
  const tools: (Anthropic.Tool[] | undefined)[] = [];
  let i = 0;
  const client = {
    messages: {
      stream: (req: { messages: Anthropic.MessageParam[]; tools?: Anthropic.Tool[] }) => {
        // Capture a deep-ish copy so later mutations to the same array don't leak.
        captures.push(req.messages.map((m) => ({ ...m })));
        tools.push(req.tools);
        const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
        i++;
        return {
          on: () => {},
          finalMessage: async () => ({ content }),
        };
      },
    },
  } as unknown as Anthropic;
  return {
    client,
    callCount: () => i,
    capturedMessages: () => captures,
    capturedTools: () => tools,
  };
}

describe("runChatLoop tool execution", () => {
  test("executes a tool_use block and continues the conversation", async () => {
    const toolCalls: unknown[] = [];
    const echoTool = buildTool({
      name: "echo",
      description: "echoes the input",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => {
        toolCalls.push(input);
        return `echoed: ${input.msg}`;
      },
    });

    const { client, callCount, capturedMessages, capturedTools } = makeScriptedClient([
      // 1st model turn: ask for a tool.
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "echo",
          input: { msg: "hi" },
        } as Anthropic.ToolUseBlock,
      ],
      // 2nd model turn: text-only, terminates the inner loop.
      [{ type: "text", text: "done", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("please echo\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [echoTool],
    });

    // The model was called twice for one user input: once that requested the
    // tool, once after the tool result was injected.
    expect(callCount()).toBe(2);
    // The tool's execute spy was called exactly once with the validated input.
    expect(toolCalls).toEqual([{ msg: "hi" }]);

    // Tools advertised on every call (once advertised, stay advertised).
    expect(capturedTools()[0]).toBeDefined();
    expect(capturedTools()[0]?.[0]?.name).toBe("echo");

    // The 2nd request must include a tool_result block referencing tu_1.
    const secondCallMessages = capturedMessages()[1] ?? [];
    const userToolResult = secondCallMessages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => typeof b === "object" && b.type === "tool_result"),
    );
    expect(userToolResult).toBeDefined();
    const resultBlocks = userToolResult?.content as Anthropic.ToolResultBlockParam[];
    expect(resultBlocks[0]?.tool_use_id).toBe("tu_1");
    expect(resultBlocks[0]?.is_error).toBe(false);
    expect(resultBlocks[0]?.content).toBe("echoed: hi");
  });

  test("returns an is_error tool_result when the model names an unknown tool", async () => {
    const knownTool = buildTool({
      name: "known",
      description: "noop",
      inputSchema: z.object({}),
      execute: async () => "ok",
    });

    const { client, callCount, capturedMessages } = makeScriptedClient([
      [
        {
          type: "tool_use",
          id: "tu_x",
          name: "ghost",
          input: {},
        } as Anthropic.ToolUseBlock,
      ],
      [{ type: "text", text: "recovered", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("go\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [knownTool],
    });

    expect(callCount()).toBe(2);
    const secondCall = capturedMessages()[1] ?? [];
    const userMsg = secondCall[secondCall.length - 1];
    const blocks = (userMsg?.content ?? []) as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
    expect(blocks[0]?.content).toContain('unknown tool "ghost"');
  });

  test("does not advertise tools when the tools list is empty", async () => {
    const { client, capturedTools } = makeScriptedClient([
      [{ type: "text", text: "hi", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("hi\n");
    input.end();

    await runChatLoop({ model: "test-model", instructions: "test", client, input });

    expect(capturedTools()[0]).toBeUndefined();
  });
});
