import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CHAT_TOOL_NAME,
  type CreateMcpServerOptions,
  type McpInvoke,
  type McpInvokeContext,
  McpServerError,
  type StdioMcpServer,
  createMcpServer,
} from "./index.js";

interface Recorder {
  readonly calls: Array<{ message: string; context: McpInvokeContext }>;
  readonly invoke: McpInvoke;
}

/** An `invoke` that records every call and echoes the message back. */
function recorder(
  reply: (message: string, context: McpInvokeContext) => string = (m) => `echo:${m}`,
): Recorder {
  const calls: Recorder["calls"] = [];
  const invoke: McpInvoke = async (message, context) => {
    calls.push({ message, context });
    return reply(message, context);
  };
  return { calls, invoke };
}

/** Build a stdio projection and narrow to {@link StdioMcpServer}. */
function makeStdio(opts: Omit<CreateMcpServerOptions, "transport">): StdioMcpServer {
  const handle = createMcpServer({ ...opts, transport: "stdio" });
  if (handle.transport !== "stdio") throw new Error("expected a stdio handle");
  return handle;
}

/** Connect a real SDK `Client` to a stdio handle over an in-memory transport pair. */
async function connectClient(handle: StdioMcpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Extract the first text block of a tool result. */
function firstText(result: CallToolResult): string | undefined {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : undefined;
}

describe("createMcpServer — tool registration", () => {
  test("chat mode registers exactly the chat tool", async () => {
    const { invoke } = recorder();
    const handle = makeStdio({ invoke });
    expect(handle.toolNames).toEqual([CHAT_TOOL_NAME]);

    const client = await connectClient(handle);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([CHAT_TOOL_NAME]);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test("the chat tool delegates to invoke and returns its text", async () => {
    const rec = recorder((m) => `handled:${m}`);
    const handle = makeStdio({ invoke: rec.invoke });
    const client = await connectClient(handle);
    try {
      const result = (await client.callTool({
        name: CHAT_TOOL_NAME,
        arguments: { message: "hello" },
      })) as CallToolResult;
      expect(firstText(result)).toBe("handled:hello");
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0]?.message).toBe("hello");
      // The chat tool carries no sub-agent in its context.
      expect(rec.calls[0]?.context).toEqual({ toolName: CHAT_TOOL_NAME });
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test("chatToolDescription / name / instructions are advertised", async () => {
    const { invoke } = recorder();
    const handle = makeStdio({
      invoke,
      name: "Concierge",
      instructions: "Talk to the Concierge.",
      chatToolDescription: "Ask the Concierge anything.",
    });
    const client = await connectClient(handle);
    try {
      const { tools } = await client.listTools();
      const chat = tools.find((t) => t.name === CHAT_TOOL_NAME);
      expect(chat?.description).toBe("Ask the Concierge anything.");
      expect(client.getInstructions()).toBe("Talk to the Concierge.");
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("createMcpServer — per-subagent projection", () => {
  const subAgents = [
    { name: "researcher", description: "Finds sources." },
    { name: "writer", description: "Drafts prose." },
  ];

  test("registers the chat tool plus one tool per sub-agent", async () => {
    const { invoke } = recorder();
    const handle = makeStdio({ invoke, tools: "per-subagent", subAgents });
    expect(handle.toolNames).toEqual([CHAT_TOOL_NAME, "researcher", "writer"]);

    const client = await connectClient(handle);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["chat", "researcher", "writer"]);
      expect(tools.find((t) => t.name === "researcher")?.description).toBe("Finds sources.");
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test("a sub-agent tool delegates with the sub-agent name in context", async () => {
    const rec = recorder((m, ctx) => `${ctx.subAgent ?? "root"}<-${m}`);
    const handle = makeStdio({ invoke: rec.invoke, tools: "per-subagent", subAgents });
    const client = await connectClient(handle);
    try {
      const result = (await client.callTool({
        name: "researcher",
        arguments: { message: "quantum" },
      })) as CallToolResult;
      expect(firstText(result)).toBe("researcher<-quantum");
      expect(rec.calls[0]?.context).toEqual({ toolName: "researcher", subAgent: "researcher" });

      // The chat tool still routes to the root agent (no sub-agent).
      await client.callTool({ name: CHAT_TOOL_NAME, arguments: { message: "hi" } });
      expect(rec.calls[1]?.context).toEqual({ toolName: CHAT_TOOL_NAME });
    } finally {
      await client.close();
      await handle.close();
    }
  });

  test("sub-agent tool names are sanitized and de-duplicated (incl. vs. chat)", async () => {
    const rec = recorder((_m, ctx) => `sub=${ctx.subAgent}`);
    const handle = makeStdio({
      invoke: rec.invoke,
      tools: "per-subagent",
      subAgents: [
        { name: "Code Reviewer", description: "a" }, // space -> underscore
        { name: "chat", description: "b" }, // collides with the reserved chat tool
        { name: "Code.Reviewer", description: "c" }, // collides with the first after sanitizing
      ],
    });
    expect(handle.toolNames).toEqual([
      CHAT_TOOL_NAME,
      "Code_Reviewer",
      "chat_2",
      "Code_Reviewer_2",
    ]);

    const client = await connectClient(handle);
    try {
      // The rewritten "chat_2" tool must still carry the ORIGINAL name "chat".
      const result = (await client.callTool({
        name: "chat_2",
        arguments: { message: "x" },
      })) as CallToolResult;
      expect(firstText(result)).toBe("sub=chat");
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("createMcpServer — error + delegation edge cases", () => {
  test("a throwing invoke becomes an isError tool result (transport survives)", async () => {
    const invoke: McpInvoke = async () => {
      throw new Error("boom");
    };
    const handle = makeStdio({ invoke });
    const client = await connectClient(handle);
    try {
      const result = (await client.callTool({
        name: CHAT_TOOL_NAME,
        arguments: { message: "x" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("boom");

      // The connection is still usable after a tool error.
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe("createMcpServer — configuration guards", () => {
  test("missing invoke throws McpServerError", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard with an invalid options object
      createMcpServer({ transport: "stdio" }),
    ).toThrow(McpServerError);
  });

  test("an unknown transport throws McpServerError", () => {
    expect(() =>
      createMcpServer({
        invoke: recorder().invoke,
        // @ts-expect-error — exercising the runtime guard
        transport: "grpc",
      }),
    ).toThrow(/unsupported MCP transport/);
  });

  test("per-subagent without sub-agents throws McpServerError", () => {
    expect(() =>
      createMcpServer({ invoke: recorder().invoke, transport: "stdio", tools: "per-subagent" }),
    ).toThrow(/per-subagent/);
    expect(() =>
      createMcpServer({
        invoke: recorder().invoke,
        transport: "stdio",
        tools: "per-subagent",
        subAgents: [],
      }),
    ).toThrow(McpServerError);
  });

  test("McpServerError carries the shared mcp error code", () => {
    const err = new McpServerError("nope");
    expect(err.code).toBe("mcp");
    expect(err.name).toBe("McpServerError");
  });
});

describe("createMcpServer — stdio transport binding", () => {
  test("listen() binds injected streams and connect() is single-use", async () => {
    const { invoke } = recorder();
    const handle = makeStdio({ invoke });
    await handle.listen({ stdin: new PassThrough(), stdout: new PassThrough() });
    expect(handle.toolNames).toContain(CHAT_TOOL_NAME);

    // A second connect must be refused.
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(handle.connect(serverTransport)).rejects.toThrow(/already connected/);

    await handle.close();
  });

  test("exposes the underlying SDK server", () => {
    const { invoke } = recorder();
    const handle = makeStdio({ invoke });
    expect(handle.server).toBeDefined();
    expect(typeof handle.server.connect).toBe("function");
  });
});
