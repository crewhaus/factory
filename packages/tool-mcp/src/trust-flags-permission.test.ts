/**
 * extension-path#16 (C173), end to end through the permission engine: an MCP
 * tool the spec flags destructive (`mcp_servers.<n>.tool_flags`), or whose
 * server says `destructiveHint: true`, is ASKED about in auto mode — which in
 * a headless single turn means it does not run — while an unflagged tool runs
 * as it did on 0.7.0. The flags are lowered and folded by 9396d8d3; this
 * proves what they change for a real call.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { McpError } from "@crewhaus/errors";
import type { McpHost, McpToolDefinition, McpToolFlagsConfig } from "@crewhaus/mcp-host";
import {
  BUILTIN_DEFAULT_RULES,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import { runChatLoop } from "@crewhaus/runtime-core";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer } from "./index.js";

function fakeHost(
  tools: ReadonlyArray<McpToolDefinition>,
  toolFlags: McpToolFlagsConfig | undefined,
  called: string[],
): McpHost {
  const client = {
    name: "gh",
    toolFlags,
    async connect() {},
    async listTools() {
      return tools;
    },
    async refreshTools() {
      return tools;
    },
    async callTool(name: string) {
      called.push(name);
      return { content: `${name} ran`, isError: false };
    },
    getState: () => ({ kind: "connected" }) as const,
  };
  return {
    getClient: (name: string) => {
      if (name !== "gh") throw new McpError(`unknown server "${name}"`);
      return client;
    },
    has: (name: string) => name === "gh",
  } as unknown as McpHost;
}

const schema = { type: "object", properties: {} };
const REMOTE: McpToolDefinition[] = [
  { name: "delete_repo", inputSchema: schema },
  { name: "drop_branch", inputSchema: schema, annotations: { destructiveHint: true } },
  { name: "list_repos", inputSchema: schema },
];
const SPEC_FLAGS: McpToolFlagsConfig = { perTool: { delete_repo: { destructive: true } } };

async function registered(called: string[] = []) {
  const catalog = new ToolCatalog();
  await registerMcpServer(fakeHost(REMOTE, SPEC_FLAGS, called), "gh", catalog);
  return catalog;
}

describe("an MCP tool flagged destructive is asked about in auto mode (C173)", () => {
  test("the engine's decision for each registered tool", async () => {
    const catalog = await registered();
    const rules = { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] };
    const decide = (name: string, mode: "auto" | "default" | "plan") => {
      const t = catalog.get(name);
      if (t === undefined) throw new Error(`${name} not registered`);
      return evaluateWithReason(
        { toolName: t.name, input: {}, readOnly: t.readOnly, destructive: t.destructive },
        mode,
        rules,
      ).decision;
    };
    expect(
      ["mcp__gh__delete_repo", "mcp__gh__drop_branch", "mcp__gh__list_repos"].map((n) => [
        n,
        decide(n, "auto"),
        decide(n, "default"),
        decide(n, "plan"),
      ]),
    ).toEqual([
      // spec tool_flags: destructive
      ["mcp__gh__delete_repo", "ask", "ask", "deny"],
      // the server's destructiveHint
      ["mcp__gh__drop_branch", "ask", "ask", "deny"],
      // unflagged: 0.7.0's behaviour, unchanged
      ["mcp__gh__list_repos", "allow", "ask", "deny"],
    ]);
  });

  test("an operator's alwaysAllow brings back 0.7.0's auto mode for a server's tools", async () => {
    // What the changelog tells an operator whose annotated server (most of
    // Playwright MCP's browser actions, for one) now asks in auto mode.
    const catalog = await registered();
    const rules = {
      ...emptyRuleSet,
      builtin: [...BUILTIN_DEFAULT_RULES],
      yaml: [{ type: "alwaysAllow" as const, pattern: "mcp__gh__*", source: "yaml" as const }],
    };
    const decisions = ["mcp__gh__delete_repo", "mcp__gh__drop_branch", "mcp__gh__list_repos"].map(
      (name) => {
        const t = catalog.get(name);
        if (t === undefined) throw new Error(`${name} not registered`);
        return evaluateWithReason(
          { toolName: t.name, input: {}, readOnly: t.readOnly, destructive: t.destructive },
          "auto",
          rules,
        ).decision;
      },
    );
    expect(decisions).toEqual(["allow", "allow", "allow"]);
  });

  test("end to end: in a headless auto-mode turn the flagged tools do not run; the plain one does", async () => {
    const called: string[] = [];
    const catalog = await registered(called);
    let turn = 0;
    const adapter: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      estimateTokens: () => 0,
      stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
        const first = turn === 0;
        turn += 1;
        return (async function* () {
          yield { kind: "message_start", usage: { input: 1, output: 0 } };
          if (first) {
            const names = ["mcp__gh__delete_repo", "mcp__gh__drop_branch", "mcp__gh__list_repos"];
            for (const [index, name] of names.entries()) {
              yield {
                kind: "content_block_start",
                index,
                block: { type: "tool_use", id: `tu_${index}`, name, input: {} },
              };
              yield {
                kind: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: "{}" },
              };
              yield { kind: "content_block_stop", index };
            }
            yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 1, output: 1 } };
          } else {
            yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            };
            yield { kind: "content_block_stop", index: 0 };
            yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
          }
          yield { kind: "message_stop" };
        })();
      },
    };
    const sessions = mkdtempSync(join(tmpdir(), "mcp-trust-flags-"));
    const before = process.env["CREWHAUS_SESSION_DIR"];
    process.env["CREWHAUS_SESSION_DIR"] = sessions;
    try {
      await runChatLoop({
        model: "claude-haiku-4-5",
        instructions: "test",
        _adapter: adapter,
        tools: catalog.list(),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        permissionMode: "auto",
        settingsDir: null,
        permissionRules: { ...emptyRuleSet, builtin: [...BUILTIN_DEFAULT_RULES] },
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
      });
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
      else process.env["CREWHAUS_SESSION_DIR"] = before;
      rmSync(sessions, { recursive: true, force: true });
    }
    expect(called).toEqual(["list_repos"]);
    expect(turn).toBe(2);
  }, 20_000);
});
