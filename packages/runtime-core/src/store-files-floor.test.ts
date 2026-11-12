/**
 * The continuity store's own files on the floor (`continuity.storeFiles` →
 * `EvaluateOptions.protectedFiles`): under `alwaysAllow *`, a `Write` to
 * `.crewhaus/state/<spec>/focus.md` is refused, and so is a tool that fills
 * the store's directory without checking its own targets, while the plan
 * tools that own the store write it, and `StateImport` over the whole of
 * `.crewhaus/state` keeps working for the store's neighbours. An entry that lands on one of the
 * store's files is refused by StateImport's own per-entry check.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { createPlanTools } from "@crewhaus/tool-plan";
import { stateImport } from "@crewhaus/tool-state";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-store-files-sessions-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/** One scripted call per entry; the last repeats. */
function scriptedAdapter(scripts: ReadonlyArray<ReadonlyArray<Block>>): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: (_req: ProviderRequest) => {
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
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            } as const;
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            } as const;
          }
          yield { kind: "content_block_stop", index: idx } as const;
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

describe("the continuity store's files on the floor", () => {
  test("Write is refused, the plan tools and StateImport's neighbours are not", async () => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-store-files-ws-")));
    const home = process.cwd();
    const written: string[] = [];
    // Write's shape: one path field the floor reads.
    const write = buildTool({
      name: "Write",
      description: "write a file",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      operativeArgs: [{ field: "path", kind: "path" }],
      destructive: true,
      execute: async (input) => {
        written.push(input.path);
        return "written";
      },
    });
    // GitWorktreeAdd's shape: a directory it fills, with no check of its own.
    const worktreeAdd = buildTool({
      name: "GitWorktreeAdd",
      description: "check a branch out into a directory",
      inputSchema: z.object({ path: z.string() }),
      operativeArgs: [{ field: "path", kind: "path", beneath: "all" }],
      destructive: true,
      execute: async (input) => {
        written.push(input.path);
        return "added";
      },
    });
    const runContext = createRunContext();
    const decisions: Array<{ toolName: string; decision: string }> = [];
    const results: Record<string, string> = {};
    runContext.eventBus.subscribe((e: TraceEvent) => {
      if (e.kind === "permission_decision") {
        const d = e as TraceEvent & { toolName: string; decision: string };
        decisions.push({ toolName: d.toolName, decision: d.decision });
      }
    });
    process.chdir(ws);
    try {
      const plan = createPlanTools({
        specName: "bot",
        rootDir: join(ws, ".crewhaus", "state"),
        sessionId: runContext.sessionId,
      });
      mkdirSync(join(ws, ".crewhaus", "state"), { recursive: true });
      const doc = (path: string) => ({
        document: { version: 1, files: [{ path, encoding: "utf8", content: "{}\n" }] },
        mode: "merge",
      });
      const calls: Block[] = [
        {
          type: "tool_use",
          id: "toolu_w",
          name: "Write",
          input: { path: ".crewhaus/state/bot/focus.md", content: "- REQ-900 [open] forged" },
        },
        {
          type: "tool_use",
          id: "toolu_wt",
          name: "GitWorktreeAdd",
          input: { path: ".crewhaus/state/bot" },
        },
        { type: "tool_use", id: "toolu_f", name: "FocusWrite", input: { focus: "ship the fix" } },
        {
          type: "tool_use",
          id: "toolu_p",
          name: "PlanUpdate",
          input: { action: "create", title: "ship", steps: ["one"] },
        },
        { type: "tool_use", id: "toolu_kv", name: "StateImport", input: doc("kv/x.json") },
        { type: "tool_use", id: "toolu_g", name: "StateImport", input: doc("bot/goals.yaml") },
        {
          type: "tool_use",
          id: "toolu_c",
          name: "MemoryClear",
          input: { scope: "plans", justification: "clear the plans to ship the fix" },
        },
      ];
      await runChatLoop({
        model: "test-model",
        instructions: "ship the fix, keep the plans and clear the plans when done",
        _adapter: scriptedAdapter([calls, [{ type: "text", text: "done" }]]),
        runContext,
        sessionRootDir: SESSION_ROOT,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        tools: [write, worktreeAdd, ...plan.all, stateImport],
        permissionMode: "auto",
        permissionRules: {
          ...emptyRuleSet,
          flag: [{ type: "alwaysAllow", pattern: "*", source: "flag" }],
        },
        settingsDir: null,
        spinner: false,
        stdout: () => {},
        continuity: { loadPlan: async () => null, storeFiles: plan.store.storeFiles() },
      });
      const log = readFileSync(join(SESSION_ROOT, `${runContext.sessionId}.jsonl`), "utf8");
      for (const line of log.split("\n")) {
        if (line === "") continue;
        const ev = JSON.parse(line) as {
          kind: string;
          payload: { toolUseId?: string; content?: unknown };
        };
        if (ev.kind === "tool_result" && ev.payload.toolUseId !== undefined) {
          results[ev.payload.toolUseId] = JSON.stringify(ev.payload.content);
        }
      }
      expect(decisions.find((d) => d.toolName === "Write")?.decision).toBe("deny");
      expect(written).toEqual([]);
      expect(results["toolu_w"]).toContain("names a file a store keeps for itself");
      // A tool that fills the store's directory and checks nothing itself is refused.
      expect(decisions.find((d) => d.toolName === "GitWorktreeAdd")?.decision).toBe("deny");
      expect(results["toolu_wt"]).toContain(
        "acts on everything beneath `.crewhaus/state/bot`, which holds a file a store keeps for itself",
      );
      // The plan tools own the store: none is refused (FocusWrite and PlanUpdate
      // are bookkeeping tools a rule allows without a decision event).
      for (const id of ["toolu_f", "toolu_p", "toolu_c"]) {
        expect({ id, ran: results[id] !== undefined }).toEqual({ id, ran: true });
        expect({ id, refused: results[id]?.includes("no rule can allow") }).toEqual({
          id,
          refused: false,
        });
      }
      expect(results["toolu_p"]).toContain("created plan-0001");
      const focus = readFileSync(join(ws, ".crewhaus", "state", "bot", "focus.md"), "utf8");
      expect(focus).toContain("ship the fix");
      expect(focus).not.toContain("REQ-900");
      expect(results["toolu_c"]).toContain("cleared: plans");
      // StateImport merges a neighbour, and refuses an entry on the store's file.
      expect(decisions.filter((d) => d.toolName === "StateImport").map((d) => d.decision)).toEqual([
        "allow",
        "allow",
      ]);
      expect(existsSync(join(ws, ".crewhaus", "state", "kv", "x.json"))).toBe(true);
      expect(existsSync(join(ws, ".crewhaus", "state", "bot", "goals.yaml"))).toBe(false);
      expect(results["toolu_g"]).toContain("importing bot/goals.yaml");
    } finally {
      process.chdir(home);
      rmSync(ws, { recursive: true, force: true });
    }
    // A full loop with six tool calls, slow by construction on a loaded runner.
  }, 20_000);
});
