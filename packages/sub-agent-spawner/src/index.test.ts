import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ParentRunHandle, SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { type RuleSet, emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { spawnSubAgent } from "./index.js";

function newTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "sub-agent-spawner-"));
}

async function makeParent(rootDir: string): Promise<{
  parent: ParentRunHandle;
  parentLog: EventLog;
  abort: () => void;
}> {
  const ac = new AbortController();
  const runContext = createRunContext({ abortSignal: ac.signal });
  const eventLog = await openEventLog(runContext.sessionId, { rootDir });
  const rules: RuleSet = { ...emptyRuleSet };
  const parent: ParentRunHandle = {
    runContext,
    eventLog,
    permissionMode: "default",
    permissionRules: rules,
    tools: [] as ReadonlyArray<RegisteredTool>,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    sessionRootDir: rootDir,
  };
  return { parent, parentLog: eventLog, abort: () => ac.abort() };
}

/**
 * Section 17 — scripted ProviderAdapter that synthesises canonical
 * StreamEvents from pre-baked Anthropic content blocks.
 */
function makeScriptedClient(
  scripts: ReadonlyArray<Anthropic.ContentBlock[]>,
): import("@crewhaus/adapter-anthropic").ProviderAdapter {
  let i = 0;
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
    stream: () => {
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i++;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (let idx = 0; idx < content.length; idx++) {
          const block = content[idx];
          if (block === undefined) continue;
          if (block.type === "text") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          } else if (block.type === "tool_use") {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input ?? {}),
              },
            } as const;
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const DEF_NO_TOOLS: SubAgentDefinition = {
  name: "tester",
  description: "test agent",
  instructions: "Be brief.",
};

describe("spawnSubAgent", () => {
  test("runs a one-tool-call child and returns finalMessage + transcript + toolCalls", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);

      const echoTool = buildTool({
        name: "echo",
        description: "echo input",
        inputSchema: z.object({ msg: z.string() }),
        execute: async (input) => `echoed: ${input.msg}`,
      });

      const client = makeScriptedClient([
        // 1st model turn: invoke the tool.
        [
          {
            type: "tool_use",
            id: "tu_1",
            name: "echo",
            input: { msg: "hi" },
          } as Anthropic.ToolUseBlock,
        ],
        // 2nd model turn: text-only.
        [{ type: "text", text: "all done", citations: null } as Anthropic.TextBlock],
      ]);

      const result = await spawnSubAgent(parent, {
        def: DEF_NO_TOOLS,
        prompt: "please echo",
        permissionMode: "bypass",
        permissionRules: { ...emptyRuleSet },
        childTools: [echoTool],
        sessionRootDir: root,
        _client: client,
      });

      expect(result.finalMessage).toBe("all done");
      // transcript = [user(prompt), assistant(tool_use), user(tool_result), assistant(text)]
      expect(result.transcript).toHaveLength(4);
      expect(result.transcript[0]?.role).toBe("user");
      expect(result.transcript[3]?.role).toBe("assistant");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.name).toBe("echo");
      expect(result.toolCalls[0]?.input).toEqual({ msg: "hi" });

      // Parent's event log saw the boundary events.
      const parentEvents: { kind: string; payload: unknown }[] = [];
      const reReadParent = await openEventLog(parent.runContext.sessionId, { rootDir: root });
      for await (const ev of reReadParent.read()) {
        parentEvents.push({ kind: ev.kind, payload: ev.payload });
      }
      await reReadParent.close();
      const starts = parentEvents.filter((e) => e.kind === "sub_agent_start");
      const ends = parentEvents.filter((e) => e.kind === "sub_agent_end");
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      const startPayload = starts[0]?.payload as { childSessionId: string; name: string };
      const endPayload = ends[0]?.payload as {
        childSessionId: string;
        isError: boolean;
        toolCallCount: number;
      };
      expect(startPayload.name).toBe("tester");
      expect(startPayload.childSessionId).not.toBe(parent.runContext.sessionId);
      expect(endPayload.isError).toBe(false);
      expect(endPayload.toolCallCount).toBe(1);

      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawns 10 children in parallel, each with distinct sessionIds", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);

      const finals = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] as const;

      const results = await Promise.all(
        finals.map((letter) =>
          spawnSubAgent(parent, {
            def: { ...DEF_NO_TOOLS, name: `child-${letter}` },
            prompt: `task ${letter}`,
            permissionMode: "bypass",
            permissionRules: { ...emptyRuleSet },
            childTools: [],
            sessionRootDir: root,
            _client: makeScriptedClient([
              [{ type: "text", text: `done ${letter}`, citations: null } as Anthropic.TextBlock],
            ]),
          }),
        ),
      );

      expect(results).toHaveLength(10);
      const sessions = new Set<string>();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        expect(r?.finalMessage).toBe(`done ${finals[i]}`);
        expect(r?.toolCalls).toHaveLength(0);
      }
      // Pull childSessionIds from the parent's event log.
      const parentLogReread = await openEventLog(parent.runContext.sessionId, { rootDir: root });
      let starts = 0;
      let ends = 0;
      for await (const ev of parentLogReread.read()) {
        if (ev.kind === "sub_agent_start") {
          starts++;
          const p = ev.payload as { childSessionId: string };
          sessions.add(p.childSessionId);
        }
        if (ev.kind === "sub_agent_end") ends++;
      }
      await parentLogReread.close();
      expect(starts).toBe(10);
      expect(ends).toBe(10);
      expect(sessions.size).toBe(10);
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures runChatLoop errors as sub_agent_end with isError=true", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);

      // Stub that throws on `messages.stream` so the runtime's recovery path
      // exhausts and bubbles up. We force a fail with a non-recoverable error.
      const throwingClient = {
        messages: {
          stream: () => {
            throw Object.assign(new Error("boom"), { name: "InvalidRequestError" });
          },
        },
      } as unknown as Anthropic;

      const result = await spawnSubAgent(parent, {
        def: DEF_NO_TOOLS,
        prompt: "ignored",
        permissionMode: "bypass",
        permissionRules: { ...emptyRuleSet },
        childTools: [],
        sessionRootDir: root,
        _client: throwingClient,
      });

      expect(result.finalMessage.startsWith("[sub-agent error]")).toBe(true);

      const parentReread = await openEventLog(parent.runContext.sessionId, { rootDir: root });
      const ends: { isError: boolean; errorMessage?: string }[] = [];
      for await (const ev of parentReread.read()) {
        if (ev.kind === "sub_agent_end") {
          ends.push(ev.payload as { isError: boolean; errorMessage?: string });
        }
      }
      await parentReread.close();
      expect(ends).toHaveLength(1);
      expect(ends[0]?.isError).toBe(true);
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
