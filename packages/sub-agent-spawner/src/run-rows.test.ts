/**
 * Run rows through a real Task sub-agent: a park inside the sub-agent is the
 * top-level run's park, and a sub-agent's spend nobody could price is counted
 * as unpriced on the top-level run's terminal row, never as $0.
 *
 * Every row is checked against the control contract's `run` schema, and the
 * ledger's fold shows no anomaly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { SpawnSubAgentOptions, SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { run as runSchema } from "@crewhaus/control-contract/schemas";
import {
  type CursorPosition,
  foldStates,
  harnessLedger,
  readPage,
} from "@crewhaus/control-records";
import { isRunFailedError } from "@crewhaus/errors";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import { createTaskTool } from "@crewhaus/tool-task";
import { z } from "zod";
import { spawnSubAgent } from "./index.js";

type Row = Record<string, unknown>;

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sub-agent-run-rows-${prefix}-`));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every row in the run ledger at `root`, oldest first, schema- and fold-checked. */
function rowsAt(root: string): Row[] {
  const ledger = harnessLedger(
    root,
    { dir: join(".crewhaus", "run", "control", "runs") },
    { machine: "run" },
  );
  const rows: Row[] = [];
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 500, ...(before !== undefined ? { before } : {}) });
    expect(page.gaps).toEqual([]);
    for (const item of page.items) rows.push({ ...item.record });
    if (page.next === undefined) break;
    before = page.next;
  }
  rows.reverse();
  for (const row of rows) {
    const parsed = runSchema.safeParse(row);
    expect(parsed.success ? "valid" : JSON.stringify(parsed.error.issues)).toBe("valid");
  }
  const fold = foldStates(ledger);
  if (!fold.ok) throw new Error(`fold refused: ${fold.reason}`);
  expect(fold.anomalies).toEqual([]);
  return rows;
}

/** A model that plays `scripts` in order, one content list per call. */
function scripted(
  scripts: ReadonlyArray<Anthropic.ContentBlock[]>,
  usage: { input: number; output: number } = { input: 100, output: 10 },
): ProviderAdapter {
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
          if (block?.type === "text") {
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
          } else if (block?.type === "tool_use") {
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
            yield { kind: "content_block_stop", index: idx } as const;
          }
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage,
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const TASK_CALL = {
  type: "tool_use",
  id: "tu_task",
  name: "Task",
  input: { description: "work", prompt: "do it", subagent_type: "worker" },
} as Anthropic.ToolUseBlock;
const TEXT = (text: string) => ({ type: "text", text, citations: null }) as Anthropic.TextBlock;

describe("a Task sub-agent and the top-level run's rows", () => {
  test("a park inside the sub-agent: the top-level run is running, then waiting-for-approval with the child's approval, then nothing", async () => {
    const ledger = tempDir("ledger");
    const sessions = tempDir("sessions");
    const store = createPendingApprovalStore({ rootDir: join(tempDir("approvals"), "approvals") });
    const danger = buildTool({
      name: "Danger",
      description: "does something that needs a person",
      inputSchema: z.object({ what: z.string() }),
      readOnly: false,
      destructive: true,
      execute: async () => "should never run",
    });
    const worker: SubAgentDefinition = {
      name: "worker",
      description: "does the work",
      instructions: "Do the work.",
      tools: ["Danger"],
    };
    const subAgents = new Map([[worker.name, worker]]);
    const runContext = createRunContext();
    let thrown: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "delegate to the worker",
        runContext,
        _adapter: scripted([[TASK_CALL], [TEXT("never reached")]]),
        sessionRootDir: sessions,
        settingsDir: null,
        runLedgerDir: ledger,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        tools: [danger, createTaskTool({ subAgents })],
        permissionMode: "default",
        permissionRules: {
          ...emptyRuleSet,
          yaml: [{ type: "alwaysAllow", pattern: "Task", source: "yaml" }],
        },
        askMode: "pause",
        approvals: { store },
        installSigintHandler: false,
        stdout: () => {},
        subAgents,
        spawnSubAgent: (parent, opts: SpawnSubAgentOptions) =>
          spawnSubAgent(parent, {
            ...opts,
            _client: scripted([
              [
                {
                  type: "tool_use",
                  id: "tu_danger",
                  name: "Danger",
                  input: { what: "x" },
                } as Anthropic.ToolUseBlock,
              ],
            ]),
          }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(isRunFailedError(thrown) ? "classified" : String(thrown)).toBe("classified");
    if (!isRunFailedError(thrown)) return;
    expect(thrown.report.class).toBe("approval_pending");
    const parked = await store.list();
    expect(parked).toHaveLength(1);

    const rows = rowsAt(ledger);
    // The sub-agent writes no rows of its own: only the top-level run has any.
    expect(new Set(rows.map((r) => r["id"]))).toEqual(new Set([runContext.runId]));
    expect(rows.map((r) => r["state"])).toEqual(["running", "waiting-for-approval"]);
    expect(rows[1]?.["decision"]).toBe(parked[0]?.id);
  });

  test("a sub-agent whose spend could not be priced: the priced parent's cost counts it as unpriced", async () => {
    const ledger = tempDir("ledger");
    const sessions = tempDir("sessions");
    const worker: SubAgentDefinition = {
      name: "worker",
      description: "does the work",
      instructions: "Do the work.",
      tools: [],
      // A model the pricing table has no row for.
      model: "a-local-model",
    };
    const subAgents = new Map([[worker.name, worker]]);
    const runContext = createRunContext();
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "delegate to the worker",
      runContext,
      _adapter: scripted([[TASK_CALL], [TEXT("parent done")]]),
      sessionRootDir: sessions,
      settingsDir: null,
      runLedgerDir: ledger,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [createTaskTool({ subAgents })],
      permissionMode: "bypass",
      installSigintHandler: false,
      stdout: () => {},
      subAgents,
      spawnSubAgent: (parent, opts: SpawnSubAgentOptions) =>
        spawnSubAgent(parent, { ...opts, _client: scripted([[TEXT("child done")]]) }),
    });
    const rows = rowsAt(ledger);
    expect(rows.map((r) => r["state"])).toEqual(["running", "succeeded"]);
    const cost = rows[1]?.["cost"] as { usdMicros: number | null; unpriced: number };
    expect(cost.usdMicros ?? 0).toBeGreaterThan(0);
    expect(cost.unpriced).toBeGreaterThanOrEqual(1);
  });
});
