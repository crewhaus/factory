import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@crewhaus/logging";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { replayMessageHistory, resolveAuth, runChatLoop } from "./index";

// Route session-store/event-log writes to a per-file tmpdir so tests do
// not pollute `.crewhaus/sessions/` in the repo. runtime-core honours
// CREWHAUS_SESSION_DIR when no explicit `sessionRootDir` is supplied.
const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

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
      permissionMode: "bypass",
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

  test("forwards tool.jsonSchema verbatim when present (over zodToJsonSchema)", async () => {
    const customJsonSchema = {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "what to echo" },
        flag: { type: "boolean", default: false },
      },
      required: ["message"],
      additionalProperties: false,
    };
    const mcpStyleTool = buildTool({
      name: "everything__echo",
      description: "remote echo",
      // The validator is permissive (mirrors how tool-mcp builds RegisteredTool).
      inputSchema: z.unknown(),
      jsonSchema: customJsonSchema,
      execute: async () => "ok",
    });

    const { client, capturedTools } = makeScriptedClient([
      [{ type: "text", text: "fine", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("hi\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [mcpStyleTool],
    });

    // The tool advertised on the first call must carry the exact JSON Schema
    // bytes from the MCP-style tool, not the zodToJsonSchema(z.unknown()) shape.
    expect(capturedTools()[0]?.[0]?.input_schema).toBe(
      customJsonSchema as unknown as Anthropic.Tool.InputSchema,
    );
  });
});

/**
 * Stub that scripts both `messages.stream` (for normal turns) and
 * `messages.create` (for autoCompact). Captures every call so tests
 * can assert ordering between the two surfaces.
 */
function makeFullClient(scripts: ReadonlyArray<Anthropic.ContentBlock[]>): {
  client: Anthropic;
  streamCount: () => number;
  createCount: () => number;
  capturedStreamMessages: () => ReadonlyArray<ReadonlyArray<Anthropic.MessageParam>>;
} {
  const captures: Anthropic.MessageParam[][] = [];
  let streamIdx = 0;
  let createCount = 0;
  const client = {
    messages: {
      stream: (req: { messages: Anthropic.MessageParam[] }) => {
        captures.push(req.messages.map((m) => ({ ...m })));
        const content = scripts[Math.min(streamIdx, scripts.length - 1)] ?? [];
        streamIdx++;
        return {
          on: () => {},
          finalMessage: async () => ({ content }),
        };
      },
      create: async () => {
        createCount++;
        return {
          content: [{ type: "text", text: "compacted summary", citations: null }],
        } as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
  return {
    client,
    streamCount: () => streamIdx,
    createCount: () => createCount,
    capturedStreamMessages: () => captures,
  };
}

describe("runChatLoop runContext", () => {
  test("runs without an explicit runContext (default factory fires)", async () => {
    const input = new PassThrough();
    input.end();
    const { client, calls } = makeStubClient();
    await runChatLoop({ model: "test-model", instructions: "test", client, input });
    expect(calls()).toBe(0);
  });

  test("turnNumber increments on each user input", async () => {
    const ctx = createRunContext();
    expect(ctx.turnNumber).toBe(0);

    const input = new PassThrough();
    input.write("hello\n");
    input.end();
    const { client } = makeStubClient("ack");

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      runContext: ctx,
    });

    expect(ctx.turnNumber).toBe(1);
  });

  test("logger receives turn-start debug records", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      format: "json",
      sink: (line) => {
        lines.push(line);
      },
    });
    const ctx = createRunContext({ logger });
    const input = new PassThrough();
    input.write("hi\n");
    input.end();
    const { client } = makeStubClient("ack");

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      runContext: ctx,
    });

    const turnStarts = lines.filter((l) => l.includes('"msg":"turn start"'));
    expect(turnStarts.length).toBe(1);
  });
});

describe("runChatLoop pre-turn compaction", () => {
  test("snips long history before calling the model", async () => {
    // Pre-load the runtime via a long initial user message — bigger
    // than 0.85 * 200 = 170 tokens at char/4 heuristic, so the budget
    // trips on turn 1 and snip fires.
    //
    // We use a small contextLimit + matching threshold so we don't
    // need to fabricate ~170k chars of input.
    const longUser = "a".repeat(800); // ~200 estimated tokens
    const input = new PassThrough();
    input.write(`${longUser}\n`);
    input.end();

    const { client, capturedStreamMessages } = makeFullClient([
      [{ type: "text", text: "ok", citations: null } as Anthropic.TextBlock],
    ]);

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      contextLimit: 200,
      compactionThreshold: 0.85,
      snipKeepHead: 0,
      snipKeepTail: 0,
    });

    // The model should still have been called, but the messages it saw
    // include the snip marker (the snipped path runs even though it
    // collapses to a single marker for keepHead/keepTail = 0/0).
    const sentToModel = capturedStreamMessages()[0] ?? [];
    const containsMarker = sentToModel.some(
      (m) => typeof m.content === "string" && m.content.includes("[Context compacted:"),
    );
    expect(containsMarker).toBe(true);
  });

  test("falls back to autocompact when snip alone does not free enough", async () => {
    // contextLimit = 100. After snip with keepHead=1/keepTail=1, we
    // keep both message ends (each big), so usage stays >85% and the
    // autocompact path triggers.
    const big = "x".repeat(800); // ~200 tokens estimate
    const input = new PassThrough();
    input.write(`${big}\n`);
    input.end();

    const { client, createCount, capturedStreamMessages } = makeFullClient([
      [{ type: "text", text: "ok", citations: null } as Anthropic.TextBlock],
    ]);

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      contextLimit: 100,
      compactionThreshold: 0.85,
      snipKeepHead: 1,
      snipKeepTail: 1,
    });

    expect(createCount()).toBe(1);
    const sentToModel = capturedStreamMessages()[0] ?? [];
    // After autocompact the history is the [marker, summary] pair.
    const hasMarker = sentToModel.some(
      (m) => typeof m.content === "string" && m.content.includes("Previous conversation summary"),
    );
    const hasSummary = sentToModel.some(
      (m) => typeof m.content === "string" && m.content.includes("compacted summary"),
    );
    expect(hasMarker).toBe(true);
    expect(hasSummary).toBe(true);
  });

  test("skips compaction entirely when budget is below threshold", async () => {
    const input = new PassThrough();
    input.write("hello\n"); // ~2 tokens
    input.end();

    const { client, createCount, capturedStreamMessages } = makeFullClient([
      [{ type: "text", text: "hi back", citations: null } as Anthropic.TextBlock],
    ]);

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      contextLimit: 200_000,
    });

    expect(createCount()).toBe(0);
    const sentToModel = capturedStreamMessages()[0] ?? [];
    const containsMarker = sentToModel.some(
      (m) => typeof m.content === "string" && m.content.includes("[Context compacted:"),
    );
    expect(containsMarker).toBe(false);
  });
});

describe("runChatLoop singleTurn mode", () => {
  test("returns the terminal assistant text and does not read stdin", async () => {
    const { client, callCount } = makeScriptedClient([
      [{ type: "text", text: "hello from step", citations: null } as Anthropic.TextBlock],
    ]);

    // PassThrough that we never end and never write to: if singleTurn read
    // from it the call would hang and time out the test.
    const input = new PassThrough();

    const result = await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
    });

    expect(result).toBe("hello from step");
    expect(callCount()).toBe(1);
    // Stream should not have been touched.
    expect(input.readableEnded).toBe(false);
  });

  test("executes tool_use blocks and returns the post-tool assistant text", async () => {
    const toolCalls: unknown[] = [];
    const echoTool = buildTool({
      name: "echo",
      description: "echoes",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => {
        toolCalls.push(input);
        return `echoed: ${input.msg}`;
      },
    });

    const { client, callCount } = makeScriptedClient([
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "echo",
          input: { msg: "hi" },
        } as Anthropic.ToolUseBlock,
      ],
      [{ type: "text", text: "after tool", citations: null } as Anthropic.TextBlock],
    ]);

    const result = await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "please echo" }],
      tools: [echoTool],
      permissionMode: "bypass",
    });

    expect(result).toBe("after tool");
    expect(callCount()).toBe(2);
    expect(toolCalls).toEqual([{ msg: "hi" }]);
  });

  test("returns empty string when terminal assistant has no text blocks", async () => {
    // Edge case: model returns only a tool_use, then on the follow-up returns
    // nothing text-like (e.g. another tool_use that we treat as text-Done by
    // simulating with an empty content array on the second turn). The state
    // machine would not actually allow that in production, so use a single
    // empty-text turn to model "no text content".
    const { client } = makeScriptedClient([
      [{ type: "text", text: "", citations: null } as Anthropic.TextBlock],
    ]);

    const result = await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "anything" }],
    });

    expect(result).toBe("");
  });

  test("permission policy denies a tool in default mode and writes a denial tool_result", async () => {
    const echoTool = buildTool({
      name: "echo",
      description: "echoes",
      inputSchema: z.object({ msg: z.string() }),
      execute: async (input) => `echoed: ${input.msg}`,
    });

    const { client, callCount, capturedMessages } = makeScriptedClient([
      [
        {
          type: "tool_use",
          id: "tu_d",
          name: "echo",
          input: { msg: "hi" },
        } as Anthropic.ToolUseBlock,
      ],
      [{ type: "text", text: "ack denied", citations: null } as Anthropic.TextBlock],
    ]);

    // single-turn: no rl, so any "ask" decision falls through to deny.
    // default mode + empty rule set → ask → deny in single-turn mode.
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      permissionMode: "default",
    });

    expect(callCount()).toBe(2);
    const secondCall = capturedMessages()[1] ?? [];
    const blocks = (secondCall[secondCall.length - 1]?.content ??
      []) as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
    expect(String(blocks[0]?.content)).toMatch(/tool denied/);
  });

  test("permission policy in plan mode denies any non-readOnly tool", async () => {
    const writeTool = buildTool({
      name: "write",
      description: "writes",
      inputSchema: z.object({ path: z.string() }),
      destructive: true,
      execute: async () => "wrote",
    });

    const { client, capturedMessages } = makeScriptedClient([
      [
        {
          type: "tool_use",
          id: "tu_w",
          name: "write",
          input: { path: "/tmp/x" },
        } as Anthropic.ToolUseBlock,
      ],
      [{ type: "text", text: "ok", citations: null } as Anthropic.TextBlock],
    ]);

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [writeTool],
      permissionMode: "plan",
    });

    const secondCall = capturedMessages()[1] ?? [];
    const blocks = (secondCall[secondCall.length - 1]?.content ??
      []) as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
    expect(String(blocks[0]?.content)).toMatch(/tool denied/);
  });

  test("recovery: 5xx from the stream triggers retry, then succeeds on the next attempt", async () => {
    let attempt = 0;
    const client = {
      messages: {
        stream: () => {
          attempt++;
          return {
            on: () => {},
            finalMessage: async () => {
              if (attempt === 1) {
                throw {
                  name: "APIError",
                  status: 503,
                  error: { type: "api_error", message: "service unavailable" },
                  message: "503 Service Unavailable",
                };
              }
              return {
                content: [{ type: "text", text: "ok after retry", citations: null }],
                stop_reason: "end_turn",
              };
            },
          };
        },
      },
    } as unknown as Anthropic;

    const result = await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      // Override the runContext to use a logger that captures lines so we
      // can assert the recovery.action log fires.
      permissionMode: "bypass",
    });

    expect(attempt).toBe(2); // first call failed, second succeeded
    expect(result).toBe("ok after retry");
  });

  test("throws RuntimeError when seedMessages is missing or does not end with role:user", async () => {
    const { client } = makeStubClient();

    await expect(
      runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        singleTurn: true,
        seedMessages: [],
      }),
    ).rejects.toThrow(/seedMessages.*role.*user/);

    await expect(
      runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        singleTurn: true,
        seedMessages: [{ role: "assistant", content: "wrong end" }],
      }),
    ).rejects.toThrow(/seedMessages.*role.*user/);

    await expect(
      runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        singleTurn: true,
      }),
    ).rejects.toThrow(/seedMessages.*role.*user/);
  });
});

// --- Section 8 integration: orchestrator, loop-detect, result-store, streaming ---

describe("runChatLoop — Section 8 orchestrator", () => {
  test("two read-only tool calls execute concurrently in one turn", async () => {
    const startedAt: number[] = [];
    const finishedAt: number[] = [];
    const slowRead = buildTool({
      name: "Read",
      description: "slow",
      inputSchema: z.object({ id: z.string() }),
      readOnly: true,
      concurrencySafe: true,
      execute: async (input) => {
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, 60));
        finishedAt.push(Date.now());
        return `read:${input.id}`;
      },
    });

    const { client, callCount } = makeScriptedClient([
      [
        {
          type: "tool_use",
          id: "tu_a",
          name: "Read",
          input: { id: "a" },
        } as Anthropic.ToolUseBlock,
        {
          type: "tool_use",
          id: "tu_b",
          name: "Read",
          input: { id: "b" },
        } as Anthropic.ToolUseBlock,
      ],
      [{ type: "text", text: "done", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("read both\n");
    input.end();

    const t0 = Date.now();
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [slowRead],
      permissionMode: "bypass",
    });
    const elapsed = Date.now() - t0;

    expect(callCount()).toBe(2);
    // Two 60ms tools running in parallel finish in ~60ms total, not 120ms.
    expect(elapsed).toBeLessThan(105);
    // Both starts come before either finish.
    expect(startedAt.length).toBe(2);
    expect(finishedAt.length).toBe(2);
    expect(Math.max(...startedAt)).toBeLessThan(Math.min(...finishedAt));
  });
});

describe("runChatLoop — Section 8 loop detection", () => {
  test("warns when the same tool call repeats >= threshold and stops re-warning", async () => {
    const dateTool = buildTool({
      name: "Bash",
      description: "bash",
      inputSchema: z.object({ command: z.string() }),
      destructive: true,
      execute: async (input) => `ran:${input.command}`,
    });

    // Three identical Bash calls in a row should trigger a loop warning.
    // Then a final text turn ends the loop.
    const sameCall = (id: string): Anthropic.ToolUseBlock =>
      ({
        type: "tool_use",
        id,
        name: "Bash",
        input: { command: "date" },
      }) as Anthropic.ToolUseBlock;
    const { client, capturedMessages } = makeScriptedClient([
      [sameCall("tu_1")],
      [sameCall("tu_2")],
      [sameCall("tu_3")],
      [{ type: "text", text: "stopping", citations: null } as Anthropic.TextBlock],
    ]);

    const input = new PassThrough();
    input.write("loop\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [dateTool],
      permissionMode: "bypass",
    });

    // The 4th call's request body should contain a `[runtime] possible loop`
    // user message somewhere in `messages`.
    const fourthCall = capturedMessages()[3] ?? [];
    const sawWarning = fourthCall.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("[runtime] possible loop detected"),
    );
    expect(sawWarning).toBe(true);
  });
});

describe("runChatLoop — Section 8 result store", () => {
  test("large tool output is persisted and replaced with a preview marker", async () => {
    const { mkdtempSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpRoot = mkdtempSync(join(tmpdir(), "crewhaus-runtime-store-"));
    const oldCwd = process.cwd();
    process.chdir(tmpRoot);

    try {
      // Tool that returns >10KB of multi-line output. Make 250 lines of
      // 50 chars each (≈12.7KB) so the first-100-lines preview is shorter
      // than the full payload.
      const bigPayload = Array.from(
        { length: 250 },
        (_, i) => `line ${i.toString().padEnd(50, " ")}`,
      ).join("\n");
      const bigTool = buildTool({
        name: "BigRead",
        description: "produces a large string",
        inputSchema: z.object({}),
        readOnly: true,
        execute: async () => bigPayload,
      });

      const { client, capturedMessages } = makeScriptedClient([
        [{ type: "tool_use", id: "tu_big", name: "BigRead", input: {} } as Anthropic.ToolUseBlock],
        [{ type: "text", text: "done", citations: null } as Anthropic.TextBlock],
      ]);

      const input = new PassThrough();
      input.write("go\n");
      input.end();

      await runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        input,
        tools: [bigTool],
        permissionMode: "bypass",
      });

      // The 2nd call's tool_result content must be a preview, not the full payload.
      const secondCall = capturedMessages()[1] ?? [];
      const userMsg = secondCall.find((m) => m.role === "user" && Array.isArray(m.content));
      const content = (userMsg?.content as Anthropic.ToolResultBlockParam[])[0]?.content;
      const preview = typeof content === "string" ? content : "";
      expect(preview.length).toBeLessThan(bigPayload.length);
      expect(preview).toContain("[truncated, full output at ");
      expect(preview).toContain(".crewhaus/tool-results/");

      // The corresponding file exists with the full payload on disk.
      const match = preview.match(/full output at (.+?)\]$/);
      expect(match).not.toBeNull();
      const fullPath = match?.[1] ?? "";
      expect(statSync(fullPath).size).toBe(bigPayload.length);
    } finally {
      process.chdir(oldCwd);
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("runChatLoop — Section 8 streaming flag", () => {
  test("streaming: true dispatches tools mid-stream and round-trips results", async () => {
    const events: { id: string; phase: "started" | "finished" }[] = [];
    const tool = buildTool({
      name: "Read",
      description: "fake",
      inputSchema: z.object({ id: z.string() }),
      readOnly: true,
      concurrencySafe: true,
      execute: async (input) => {
        events.push({ id: input.id, phase: "started" });
        events.push({ id: input.id, phase: "finished" });
        return `read:${input.id}`;
      },
    });

    // Streaming-aware fake client: returns a stream object that fires
    // contentBlock for each tool_use as the executor subscribes, then
    // resolves finalMessage with the same blocks.
    const blocks1 = [
      { type: "tool_use", id: "tu_1", name: "Read", input: { id: "1" } } as Anthropic.ToolUseBlock,
      { type: "tool_use", id: "tu_2", name: "Read", input: { id: "2" } } as Anthropic.ToolUseBlock,
    ];
    const blocks2 = [{ type: "text", text: "done", citations: null } as Anthropic.TextBlock];
    let streamIdx = 0;
    const captures: Anthropic.MessageParam[][] = [];
    const client = {
      messages: {
        stream: (req: { messages: Anthropic.MessageParam[] }) => {
          captures.push(req.messages.map((m) => ({ ...m })));
          const content =
            streamIdx === 0
              ? (blocks1 as Anthropic.ContentBlock[])
              : (blocks2 as Anthropic.ContentBlock[]);
          streamIdx++;
          const stream = {
            on: (event: string, handler: (arg?: unknown) => void) => {
              if (event === "contentBlock") {
                // Fire all blocks asynchronously to mimic real stream timing.
                queueMicrotask(() => {
                  for (const b of content) handler(b);
                });
              }
            },
            finalMessage: async () => {
              await new Promise((r) => setTimeout(r, 5));
              return { content };
            },
          };
          return stream;
        },
      },
    } as unknown as Anthropic;

    const input = new PassThrough();
    input.write("go\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      tools: [tool],
      streaming: true,
      permissionMode: "bypass",
    });

    // Both tools ran (executions captured).
    const startedIds = events.filter((e) => e.phase === "started").map((e) => e.id);
    expect(startedIds.sort()).toEqual(["1", "2"]);

    // The 2nd model call saw the assistant turn + tool_results in messages.
    const secondCall = captures[1] ?? [];
    const userMsg = secondCall.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg).toBeDefined();
    const trBlocks = (userMsg?.content as Anthropic.ToolResultBlockParam[]) ?? [];
    expect(trBlocks.map((b) => b.tool_use_id).sort()).toEqual(["tu_1", "tu_2"]);
  });
});

// ---------------------------------------------------------------------------
// Section 10 — runChatLoop --resume + persistence integration
// ---------------------------------------------------------------------------

describe("runChatLoop — Section 10 persistence", () => {
  test("session JSON is persisted with lastTurnIndex on REPL exit", async () => {
    const ctx = createRunContext();
    const { client } = makeScriptedClient([
      [{ type: "text", text: "ack", citations: null } as Anthropic.TextBlock],
    ]);
    const input = new PassThrough();
    input.write("hello\n");
    input.end();

    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      runContext: ctx,
      sessionName: "spec-name",
      sessionTarget: "cli",
    });

    // Session metadata file exists with the expected shape and the
    // turnNumber the loop incremented.
    const file = join(SHARED_SESSION_ROOT, `${ctx.sessionId}.json`);
    const { readFile } = await import("node:fs/promises");
    const json = JSON.parse(await readFile(file, "utf8"));
    expect(json.id).toBe(ctx.sessionId);
    expect(json.name).toBe("spec-name");
    expect(json.target).toBe("cli");
    expect(json.model).toBe("test-model");
    expect(json.lastTurnIndex).toBe(ctx.turnNumber);
    expect(json.lastTurnIndex).toBeGreaterThanOrEqual(1);
  });

  test("T4 replay: replayMessageHistory rebuilds an identical history from the JSONL", async () => {
    // Hand-craft a 4-message transcript via direct event-log appends so
    // the replay algorithm is exercised in isolation. tool_use /
    // tool_result events are interleaved as audit-only and must NOT
    // contribute to the reconstructed message history.
    const sessionId = "sess_aaaaaaaaaaaaaaaa";
    const { openEventLog } = await import("@crewhaus/event-log");
    const log = await openEventLog(sessionId, { rootDir: SHARED_SESSION_ROOT });
    await log.append({ kind: "user_message", payload: { content: "ping 1" } });
    await log.append({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "pong 1", citations: null }] },
    });
    await log.append({ kind: "tool_use", payload: { id: "tu_1", name: "noop", input: {} } });
    await log.append({
      kind: "tool_result",
      payload: { toolUseId: "tu_1", content: "ok", isError: false },
    });
    await log.append({ kind: "user_message", payload: { content: "ping 2" } });
    await log.append({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "pong 2", citations: null }] },
    });
    await log.append({ kind: "error", payload: { name: "Whatever", message: "transient" } });
    await log.close();

    const reopened = await openEventLog(sessionId, { rootDir: SHARED_SESSION_ROOT });
    const replayed = await replayMessageHistory(reopened);
    await reopened.close();

    expect(replayed.length).toBe(4);
    expect(replayed[0]).toEqual({ role: "user", content: "ping 1" });
    expect(replayed[1]?.role).toBe("assistant");
    expect((replayed[1]?.content as Anthropic.ContentBlock[])[0]?.type).toBe("text");
    expect(replayed[2]).toEqual({ role: "user", content: "ping 2" });
    expect(replayed[3]?.role).toBe("assistant");
  });

  test("--resume threads the prior transcript into the next model call", async () => {
    // Run A: one user→assistant turn, persisted to its session file.
    const ctxA = createRunContext();
    const recorded = makeScriptedClient([
      [{ type: "text", text: "answer-1", citations: null } as Anthropic.TextBlock],
    ]);
    const inputA = new PassThrough();
    inputA.write("first message\n");
    inputA.end();
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client: recorded.client,
      input: inputA,
      runContext: ctxA,
    });

    // Run B: resume the same session, send one more user message. The
    // model's first call must see [user1, assistant1, user2] — proving
    // event-log replay reconstructed history and the runtime threaded
    // it into messages BEFORE pushing the new user input.
    const sessionId = ctxA.sessionId;
    const resumed = makeScriptedClient([
      [{ type: "text", text: "answer-2", citations: null } as Anthropic.TextBlock],
    ]);
    const ctxB = createRunContext({ sessionId });
    const inputB = new PassThrough();
    inputB.write("second message\n");
    inputB.end();
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client: resumed.client,
      input: inputB,
      runContext: ctxB,
      resume: { sessionId },
    });

    const firstCall = resumed.capturedMessages()[0] ?? [];
    expect(firstCall.length).toBe(3);
    expect(firstCall[0]?.role).toBe("user");
    expect(firstCall[0]?.content).toBe("first message");
    expect(firstCall[1]?.role).toBe("assistant");
    expect(firstCall[2]?.role).toBe("user");
    expect(firstCall[2]?.content).toBe("second message");
  });

  test("--resume on a missing session throws RuntimeError", async () => {
    const { client } = makeScriptedClient([]);
    const input = new PassThrough();
    input.end();
    await expect(
      runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        input,
        resume: { sessionId: "sess_0000000000000000" },
      }),
    ).rejects.toThrow(/cannot --resume/);
  });

  test("rejects resume + seedMessages combo as mutually exclusive", async () => {
    const { client } = makeScriptedClient([]);
    await expect(
      runChatLoop({
        model: "test-model",
        instructions: "test",
        client,
        input: new PassThrough(),
        resume: { sessionId: "sess_0000000000000000" },
        seedMessages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  test("event log captures user_message + assistant_message events", async () => {
    const ctx = createRunContext();
    const { client } = makeScriptedClient([
      [{ type: "text", text: "thanks", citations: null } as Anthropic.TextBlock],
    ]);
    const input = new PassThrough();
    input.write("ping\n");
    input.end();
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      client,
      input,
      runContext: ctx,
    });

    const { openEventLog } = await import("@crewhaus/event-log");
    const log = await openEventLog(ctx.sessionId, { rootDir: SHARED_SESSION_ROOT });
    const all: Array<{ kind: string; payload: unknown }> = [];
    for await (const ev of log.read()) all.push({ kind: ev.kind, payload: ev.payload });
    await log.close();

    const kinds = all.map((e) => e.kind);
    expect(kinds).toContain("user_message");
    expect(kinds).toContain("assistant_message");
    expect(kinds.indexOf("user_message")).toBeLessThan(kinds.indexOf("assistant_message"));
  });
});
