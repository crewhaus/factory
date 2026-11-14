/**
 * A parked API job, parked by a real loop: runtime-core's `runChatLoop` under a root the
 * API queued, with a fake model, the real run ledger and the real file-backed approvals
 * store at the harness's session root. The loop runs under its own run id and names the
 * root as its parent, so its request is bound to that loop run. Cancelling the root
 * withdraws the request and closes both runs; resuming the root after a grant starts the
 * job again, whose loop spends the grant once and asks nothing again; an undecided park
 * is not resumed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandReceipt, mintId, mintRunId } from "@crewhaus/control-contract";
import { emptyRequest } from "@crewhaus/control-contract/schemas";
import { append, controlPaths, foldStates, runsLedger } from "@crewhaus/control-records";
import { type ApiRunInput, openApiRoot } from "@crewhaus/harness-supervisor";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import {
  createPendingApprovalStore,
  foldReadOnly,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import { type RunHome, type RunPlan, runAdapterFor, runRefOf } from "./runs";
import { type Rig, removeTempDirs, rig } from "./test-helpers";

const HRN = "hrn_0123456789abcdef";
const ENV_KEYS = ["CREWHAUS_RUN_ID", "CREWHAUS_EXECUTION_ID", "CREWHAUS_RUN_LEDGER"] as const;
const saved = new Map<string, string | undefined>();
const made: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  removeTempDirs();
});

type LoopOptions = Parameters<typeof runChatLoop>[0];
type Adapter = NonNullable<LoopOptions["_adapter"]>;
type TraceEvent = { readonly kind: string; readonly approvalId?: string };

/** A model that calls the asked tool once, then ends its turn. */
function model(): Adapter {
  let turn = 0;
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
      const first = turn === 0;
      turn += 1;
      return (async function* () {
        yield { kind: "message_start" } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: "publish", input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  } as unknown as Adapter;
}

/** A tool a person approves, counting each time it runs. */
function publishTool(ran: unknown[]) {
  return buildTool({
    name: "publish",
    description: "a call a person approves",
    inputSchema: emptyRequest,
    readOnly: false,
    destructive: false,
    concurrencySafe: true,
    execute: async (input) => {
      ran.push(input);
      return "published";
    },
  } as Parameters<typeof buildTool>[0]);
}

const executionId = (): string => `run_${randomBytes(8).toString("hex")}`;
const sessionRootOf = (r: Rig): string => resolveHarnessSessionRoot(r.harness, {}).root;
const storeOf = (r: Rig) => createPendingApprovalStore({ rootDir: sessionRootOf(r) });

/** One run of the job's process: a single-turn loop under the env the supervisor sets. */
async function job(r: Rig, ran: unknown[]): Promise<{ events: TraceEvent[]; caught: unknown }> {
  const events: TraceEvent[] = [];
  const ctx = createRunContext();
  ctx.eventBus.subscribe((event) => events.push(event as TraceEvent));
  const sessions = mkdtempSync(join(tmpdir(), "crewhaus-runs-park-sessions-"));
  made.push(sessions);
  let caught: unknown;
  try {
    await runChatLoop({
      model: "test-model",
      instructions: "runs park test",
      _adapter: model(),
      tools: [publishTool(ran)],
      sessionRootDir: sessions,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "publish it" }],
      permissionMode: "default",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      runLedgerDir: r.harness,
      approvals: { store: storeOf(r) },
      runContext: ctx,
    } as unknown as LoopOptions);
  } catch (err) {
    caught = err;
  }
  return { events, caught };
}

const at = (): string => new Date().toISOString();
const rowsOf = (r: Rig, id: string): Record<string, unknown>[] => {
  const fold = foldStates(runsLedger(r.harness));
  return fold.ok && fold.objects.get(id) !== undefined
    ? [fold.objects.get(id)?.record as Record<string, unknown>]
    : [];
};
const stateOf = (r: Rig, id: string): unknown => rowsOf(r, id)[0]?.["state"];

/** The loop run the job's park was recorded on: the root's child. */
function childOf(r: Rig, root: string): string {
  const fold = foldStates(runsLedger(r.harness));
  if (!fold.ok) throw new Error(fold.reason);
  const ids = [...fold.objects.keys()].filter((id) => id !== root);
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

/**
 * An API job on a cli harness, parked by its real loop: `queued` (by a command), held for
 * an execution as the supervisor holds it, the job's loop run until it parks, and the
 * root closed parked as the supervisor closes it when the process exits.
 */
async function parkedJob(r: Rig, ran: unknown[]): Promise<{ root: string; approval: string }> {
  const root = mintRunId();
  const execution = executionId();
  append(runsLedger(r.harness), {
    id: root,
    state: "queued",
    at: at(),
    trigger: { kind: "api" },
    by: "sys:reconcile",
    cmd: mintId("cmd"),
  });
  const inputs = join(r.harness, controlPaths(r.harness).inputsDir);
  mkdirSync(inputs, { recursive: true });
  writeFileSync(
    join(inputs, `${root}.json`),
    `${JSON.stringify({ v: 1, run: root, input: "publish it" })}\n`,
    { mode: 0o600 },
  );
  const held = await openApiRoot(r.harness, {
    id: root,
    execution,
    at: at(),
    holder: { pid: process.pid, host: hostname() },
  });
  expect(held).toEqual({ ok: true });
  process.env["CREWHAUS_RUN_ID"] = root;
  process.env["CREWHAUS_EXECUTION_ID"] = execution;
  const first = await job(r, ran);
  const asked = first.events.filter((e) => e.kind === "approval_requested");
  expect(asked).toHaveLength(1);
  append(runsLedger(r.harness), {
    id: root,
    state: "waiting-for-approval",
    at: at(),
    trigger: { kind: "api" },
    execution,
  });
  expect(ran).toEqual([]);
  return { root, approval: asked[0]?.approvalId as string };
}

async function submit<T>(
  r: Rig,
  kind: "runs.cancel" | "runs.resume",
  runId: string,
  plan: RunPlan<T>,
): Promise<{ receipt?: CommandReceipt; refusal?: string }> {
  if (!plan.ok) return { refusal: `${plan.refusal.code} ${plan.refusal.reason}` };
  const answer = await r.service.commands.submit<T>(
    { kind, target: runRefOf(HRN, runId), ledger: { harness: r.harness }, via: "cli" },
    plan.effect,
  );
  if (!answer.ok) throw new Error(answer.refusal.message);
  return { receipt: answer.receipt };
}

const request = (r: Rig, runId: string, home: RunHome = {}) => ({
  harnessDir: r.harness,
  harness: HRN,
  target: "cli",
  runId,
  home,
});

describe("a parked API job its own loop parked", () => {
  test("its request is bound to the loop run, which names the root as its parent", async () => {
    const r = rig();
    const { root, approval } = await parkedJob(r, []);
    const child = childOf(r, root);
    const record = foldReadOnly(sessionRootOf(r)).records.find((a) => a.id === approval);
    expect(record?.binding?.runId).toBe(child);
    expect(record?.binding?.resumeScope).toBe(`run:${root}`);
    expect(stateOf(r, child)).toBe("waiting-for-approval");
  });

  test("cancelled with no daemon: the request reads withdrawn naming the root, a later grant decides nothing, and neither run resumes", async () => {
    const r = rig();
    const ran: unknown[] = [];
    const { root, approval } = await parkedJob(r, ran);
    const child = childOf(r, root);
    const done = await submit(
      r,
      "runs.cancel",
      root,
      await runAdapterFor("cli").cancelRun(request(r, root)),
    );
    expect(done.receipt?.state).toBe("succeeded");
    const record = foldReadOnly(sessionRootOf(r)).records.find((a) => a.id === approval);
    expect(record?.supersededBy).toBe(root);
    expect(record?.supersededReason).toBe("run-cancelled");
    expect(await storeOf(r).resolve(approval, "grant", "sam")).toBeNull();
    expect(stateOf(r, root)).toBe("cancelled");
    expect(stateOf(r, child)).toBe("cancelled");
    const starts: ApiRunInput[] = [];
    const resumed = await runAdapterFor("cli").resumeRun(
      request(r, root, {
        startRunJob: async (_dir, apiRun) => {
          starts.push(apiRun);
          return { ok: true, runId: apiRun.runId, pid: 1 };
        },
      }),
    );
    expect(resumed.ok ? "" : resumed.refusal.reason).toBe("run_ended");
    expect(starts).toEqual([]);
    expect(ran).toEqual([]);
  });

  test("resumed: undecided it answers decision_pending; granted, the job runs again and spends the grant once, asking nothing again", async () => {
    const r = rig();
    const ran: unknown[] = [];
    const { root, approval } = await parkedJob(r, ran);
    const second: { events: TraceEvent[]; caught: unknown }[] = [];
    const home: RunHome = {
      // What the head's supervisor does for an API run: hold the root for a new
      // execution, then run the job's process under it.
      startRunJob: async (dir, apiRun) => {
        const execution = executionId();
        const held = await openApiRoot(dir, {
          id: apiRun.runId,
          execution,
          at: at(),
          holder: { pid: process.pid, host: hostname() },
        });
        if (!held.ok)
          return {
            ok: false,
            reason: "plan-failed",
            stage: "spawn",
            error: new Error(held.reason),
          };
        process.env["CREWHAUS_EXECUTION_ID"] = execution;
        second.push(await job(r, ran));
        return { ok: true, runId: apiRun.runId, pid: process.pid };
      },
    };
    const pending = await runAdapterFor("cli").resumeRun(request(r, root, home));
    expect(pending.ok ? "" : `${pending.refusal.code} ${pending.refusal.reason}`).toBe(
      "conflict decision_pending",
    );
    expect(second).toEqual([]);

    expect(await storeOf(r).resolve(approval, "grant", "sam")).not.toBeNull();
    const done = await submit(
      r,
      "runs.resume",
      root,
      await runAdapterFor("cli").resumeRun(request(r, root, home)),
    );
    expect(done.receipt?.state).toBe("succeeded");
    expect(second).toHaveLength(1);
    expect(second[0]?.caught).toBeUndefined();
    expect(ran).toEqual([{}]);
    expect(second[0]?.events.filter((e) => e.kind === "approval_requested")).toEqual([]);
    const record = foldReadOnly(sessionRootOf(r)).records.find((a) => a.id === approval);
    expect(record?.consumedAt).toBeDefined();
  });
});
