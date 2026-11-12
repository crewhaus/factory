/**
 * Run rows: every top-level loop appends content-free lines to the harness's
 * run ledger when its run starts, parks and ends, and a supervisor's root run
 * is honoured only when the ledger says the supervisor queued it.
 *
 * Every row written here is checked against the control contract's `run`
 * schema, and the ledger's fold shows no anomaly unless a test says otherwise.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { createIsolatedContext } from "@crewhaus/agent-context-isolation";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  mintId,
  mintRunId,
} from "@crewhaus/control-contract";
import { run as runSchema } from "@crewhaus/control-contract/schemas";
import { append, foldStates, readPage } from "@crewhaus/control-records";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { collectTerminalState, createGraph } from "@crewhaus/graph-engine";
import type { LogFields, Logger } from "@crewhaus/logging";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { cancelRun, createRunContext, retainRun } from "@crewhaus/run-context";
import {
  type PendingApprovalStore,
  createPendingApprovalStore,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { buildTenant, withTenant } from "@crewhaus/tenancy";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { createMemoryEventLog } from "./ephemeral";
import { type RunChatLoopOptions, runChatLoop } from "./index";
import { RUN_LEDGER_DIR, _resetRunLedgerForTest, runLedgerAt } from "./run-ledger";

type Row = Record<string, unknown>;

const FEATURES = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
} as const;

/** A model that answers `text` once per call, with the usage given. */
function textAdapter(
  text = "done",
  usage: { input: number; output: number } = { input: 100, output: 10 },
  onStream?: (req: ProviderRequest) => void,
): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: FEATURES,
    estimateTokens: () => 0,
    stream: (req: ProviderRequest) => {
      onStream?.(req);
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield { kind: "message_delta", stopReason: "end_turn", usage } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

/** A model whose every reply is a call to `tool`, until the script says text. */
function toolAdapter(
  tool: string,
  usage: { input: number; output: number } = { input: 100, output: 10 },
  replies: ReadonlyArray<"tool" | "text"> = [],
): ProviderAdapter {
  let call = 0;
  return {
    providerId: "anthropic",
    features: FEATURES,
    estimateTokens: () => 0,
    stream: () => {
      const reply = replies[call] ?? "tool";
      call += 1;
      const id = `tu_${call}`;
      return (async function* () {
        yield { kind: "message_start" } as const;
        if (reply === "tool") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: tool, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ x: 1 }) },
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
          stopReason: reply === "tool" ? "tool_use" : "end_turn",
          usage,
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

/** A model that throws `err` on its first call. */
function throwingAdapter(err: unknown): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: FEATURES,
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        throw err;
        // biome-ignore lint/correctness/noUnreachable: keeps the function a generator
        yield undefined as never;
      })(),
  };
}

/** A logger that records every warning and debug line, whatever child it is asked for. */
function recordingLogger(): {
  logger: Logger;
  warns: Array<{ msg: string; fields?: LogFields }>;
} {
  const warns: Array<{ msg: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg, fields) => {
      warns.push({ msg, ...(fields !== undefined ? { fields } : {}) });
    },
    error: () => {},
    child: () => logger,
  };
  return { logger, warns };
}

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-run-ledger-${prefix}-`));
  roots.push(dir);
  return dir;
}

const ENV_KEYS = ["CREWHAUS_RUN_LEDGER", "CREWHAUS_RUN_ID", "CREWHAUS_EXECUTION_ID"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  _resetRunLedgerForTest();
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Every row in the ledger at `root`, oldest first: read whole, each checked
 * against the `run` schema, and the fold checked for anomalies.
 */
function rowsAt(root: string, { anomalies = 0 }: { readonly anomalies?: number } = {}): Row[] {
  const ledger = runLedgerAt(root);
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
  expect(fold.anomalies).toHaveLength(anomalies);
  return rows;
}

const rowsOf = (rows: readonly Row[], id: string): Row[] => rows.filter((r) => r["id"] === id);

type LoopArgs = Partial<RunChatLoopOptions> & { readonly ledger: string | null };

/** One single-turn loop into `ledger` (a harness root, or `null` for no rows). */
async function loop(args: LoopArgs): Promise<{ result?: string; caught?: unknown }> {
  const { ledger, ...rest } = args;
  try {
    const result = await runChatLoop({
      model: "test-model",
      instructions: "run rows test",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      sessionRootDir: tempDir("sessions"),
      runLedgerDir: ledger,
      _adapter: textAdapter(),
      ...rest,
    });
    return { result };
  } catch (caught) {
    return { caught };
  }
}

describe("a top-level loop", () => {
  test("writes running then succeeded, started by cli, resumable as its session, with the session's length before it", async () => {
    const ledger = tempDir("ledger");
    const sessions = tempDir("sessions");
    const first = createRunContext();
    const one = await loop({ ledger, sessionRootDir: sessions, runContext: first });
    expect(one.caught).toBeUndefined();
    // Resume the session the first loop wrote: its log has a known length now.
    const log = join(sessions, `${first.sessionId}.jsonl`);
    const seeded = statSync(log).size;
    expect(seeded).toBeGreaterThan(0);
    const second = createRunContext({ sessionId: first.sessionId });
    const two = await loop({
      ledger,
      sessionRootDir: sessions,
      runContext: second,
      resume: { sessionId: first.sessionId },
    });
    expect(two.caught).toBeUndefined();

    const rows = rowsAt(ledger);
    expect(rows.map((r) => [r["id"], r["state"]])).toEqual([
      [first.runId, "running"],
      [first.runId, "succeeded"],
      [second.runId, "running"],
      [second.runId, "succeeded"],
    ]);
    const [running1, , running2, ended2] = rows;
    expect(running1).toMatchObject({
      trigger: { kind: "cli" },
      session: first.sessionId,
      sessionAt: 0,
      resumeScope: `session:${first.sessionId}`,
    });
    expect(running2?.["sessionAt"]).toBe(seeded);
    expect(running2?.["resumeScope"]).toBe(`session:${first.sessionId}`);
    expect(ended2?.["trigger"]).toEqual({ kind: "cli" });
    for (const row of rows) {
      expect(String(row["id"])).toMatch(CANONICAL_RUN_ID_RE);
      expect("parent" in row).toBe(false);
      expect("execution" in row).toBe(false);
    }
    // Content-free: the model's words and the prompt are nowhere in the ledger.
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("run rows test");
    expect(raw).not.toContain('"done"');
  });

  test("a channel or managed loop names its own trigger", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    await loop({ ledger, runContext: ctx, sessionTarget: "channel" });
    expect(rowsOf(rowsAt(ledger), ctx.runId)[0]?.["trigger"]).toEqual({ kind: "channel" });
  });

  test("a park writes waiting-for-approval with the approval's id, then nothing", async () => {
    const ledger = tempDir("ledger");
    const store: PendingApprovalStore = createPendingApprovalStore({
      rootDir: join(tempDir("approvals"), "approvals"),
    });
    const ctx = createRunContext();
    const danger = buildTool({
      name: "danger",
      description: "must be approved",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
      execute: async () => "did it",
    });
    const { caught } = await loop({
      ledger,
      runContext: ctx,
      permissionMode: "default",
      tools: [danger],
      approvals: { store },
      _adapter: toolAdapter("danger", { input: 10, output: 5 }, ["tool", "text"]),
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("approval_pending");
    const pending = await store.get("danger", hashApprovalInput("danger", { x: 1 }));
    expect(pending?.runId).toMatch(CANONICAL_RUN_ID_RE);
    expect(pending?.runId).toBe(ctx.runId);
    const rows = rowsAt(ledger);
    expect(rows.map((r) => r["state"])).toEqual(["running", "waiting-for-approval"]);
    expect(rows[1]?.["decision"]).toBe(pending?.id);
  });

  test("a budget stop is failed crewhaus_budget, caused by the budget", async () => {
    const ledger = tempDir("ledger");
    const noop = buildTool({
      name: "noop",
      description: "does nothing",
      inputSchema: z.object({}).passthrough(),
      readOnly: true,
      execute: async () => "ok",
    });
    const ctx = createRunContext();
    const { caught } = await loop({
      ledger,
      runContext: ctx,
      model: "claude-sonnet-4-6",
      tools: [noop],
      budget: { usdMicros: 1000, onExceed: { kind: "stop" } },
      _adapter: toolAdapter("noop"),
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    const ended = rowsOf(rowsAt(ledger), ctx.runId).at(-1);
    expect(ended).toMatchObject({
      state: "failed",
      failureClass: "crewhaus_budget",
      cause: { kind: "budget", ref: "crewhaus_budget" },
    });
  });

  test("an auth failure is caused by the provider; an unclassified throw is failed unknown", async () => {
    const ledger = tempDir("ledger");
    const auth = Object.assign(new Error("401 invalid x-api-key"), {
      providerId: "anthropic",
      status: 401,
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const ctx = createRunContext();
    const one = await loop({ ledger, runContext: ctx, _adapter: throwingAdapter(auth) });
    expect(one.caught).toBeInstanceOf(RunFailedError);
    expect(rowsOf(rowsAt(ledger), ctx.runId).at(-1)).toMatchObject({
      state: "failed",
      failureClass: "auth",
      cause: { kind: "provider", ref: "auth" },
    });
    // An error the taxonomy cannot classify stops the run, but not as a RunFailedError.
    const other = createRunContext();
    const weird = Object.assign(new Error("something the taxonomy cannot classify"), {
      name: "WeirdError",
    });
    const two = await loop({ ledger, runContext: other, _adapter: throwingAdapter(weird) });
    expect(two.caught).toBeDefined();
    expect(two.caught).not.toBeInstanceOf(RunFailedError);
    const ended = rowsOf(rowsAt(ledger), other.runId).at(-1);
    expect(ended?.["state"]).toBe("failed");
    expect(ended?.["failureClass"]).toBe("unknown");
    expect("cause" in (ended ?? {})).toBe(false);
  });
});

describe("cancel", () => {
  test("cancelRun while the model streams ends the run cancelled", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => {
      streaming = resolve;
    });
    const adapter: ProviderAdapter = {
      providerId: "anthropic",
      features: FEATURES,
      estimateTokens: () => 0,
      stream: (req) =>
        (async function* () {
          yield { kind: "message_start" } as const;
          streaming();
          // Never resolves on its own: only the run's abort ends it.
          await new Promise<never>((_, reject) => {
            const signal = req.signal;
            if (signal === undefined) return;
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        })(),
    };
    const running = loop({ ledger, runContext: ctx, _adapter: adapter });
    await started;
    expect(cancelRun(ctx.runId)).toBe(true);
    await running;
    const rows = rowsOf(rowsAt(ledger), ctx.runId);
    expect(rows.map((r) => r["state"])).toEqual(["running", "cancelled"]);
  });

  test("a loop that returns normally after the cancel still records cancelled", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    // The model ignores the signal and finishes its answer; the cancel lands mid-answer.
    const adapter = textAdapter("done", { input: 1, output: 1 }, () => {
      cancelRun(ctx.runId);
    });
    const { result, caught } = await loop({ ledger, runContext: ctx, _adapter: adapter });
    expect(caught).toBeUndefined();
    expect(typeof result).toBe("string");
    expect(ctx.abortSignal.aborted).toBe(true);
    expect(rowsOf(rowsAt(ledger), ctx.runId).map((r) => r["state"])).toEqual([
      "running",
      "cancelled",
    ]);
  });
});

describe("when no rows are written", () => {
  test("ledger off, an in-memory session, runLedgerDir null, a sub-run and a tenant run create no ledger and return the same", async () => {
    const on = tempDir("on");
    const baseline = await loop({ ledger: on });
    expect(rowsAt(on)).toHaveLength(2);

    const cases: Array<[string, () => Promise<{ dir: string; result?: string }>]> = [
      [
        "CREWHAUS_RUN_LEDGER=0",
        async () => {
          const dir = tempDir("off");
          process.env["CREWHAUS_RUN_LEDGER"] = "0";
          try {
            return { dir, ...(await loop({ ledger: dir })) };
          } finally {
            Reflect.deleteProperty(process.env, "CREWHAUS_RUN_LEDGER");
          }
        },
      ],
      [
        "persistSession: false",
        async () => {
          const dir = tempDir("memory");
          return { dir, ...(await loop({ ledger: dir, persistSession: false })) };
        },
      ],
      [
        "runLedgerDir: null",
        async () => {
          const dir = tempDir("null");
          return { dir, ...(await loop({ ledger: null, settingsDir: dir })) };
        },
      ],
      [
        "a context with a parent",
        async () => {
          const dir = tempDir("child");
          const runContext = createRunContext({ parent: mintRunId() });
          return { dir, ...(await loop({ ledger: dir, runContext })) };
        },
      ],
      [
        "a tenant run",
        async () => {
          const dir = tempDir("tenant");
          const tenant = buildTenant("tenant-a", { tenantsRoot: tempDir("tenants") });
          const out = await withTenant(tenant, () =>
            loop({ ledger: dir, sessionRootDir: undefined }),
          );
          return { dir, ...out };
        },
      ],
    ];
    for (const [name, run] of cases) {
      const { dir, result } = await run();
      expect(`${name}: ${existsSync(join(dir, ".crewhaus"))}`).toBe(`${name}: false`);
      expect(`${name}: ${result}`).toBe(`${name}: ${baseline.result}`);
    }
  });

  test("a sub-agent's loop writes no rows, and its context names the parent's run", async () => {
    const ledger = tempDir("ledger");
    const parent = createRunContext();
    const child = await createIsolatedContext(
      {
        runContext: parent,
        eventLog: createMemoryEventLog(),
        permissionMode: "bypass",
        permissionRules: emptyRuleSet,
        tools: [],
        model: "test-model",
        maxTokens: 1024,
        sessionRootDir: tempDir("sessions"),
      },
      { name: "helper", instructions: "help", tools: [] },
    );
    try {
      expect(child.runContext.parent).toBe(parent.runId);
      expect(child.runContext.runId).toMatch(CANONICAL_RUN_ID_RE);
      const { caught } = await loop({ ledger, runContext: child.runContext });
      expect(caught).toBeUndefined();
    } finally {
      await child.close();
    }
    expect(existsSync(join(ledger, ".crewhaus"))).toBe(false);
  });
});

describe("cost", () => {
  test("a priced model costs more than nothing; an unpriced one has no figure and counts its misses", async () => {
    const ledger = tempDir("ledger");
    const priced = createRunContext();
    await loop({ ledger, runContext: priced, model: "claude-sonnet-4-6" });
    const unpriced = createRunContext();
    await loop({ ledger, runContext: unpriced, model: "test-model" });
    const rows = rowsAt(ledger);
    const pricedCost = rowsOf(rows, priced.runId).at(-1)?.["cost"] as {
      usdMicros: number | null;
      unpriced: number;
    };
    expect(pricedCost.unpriced).toBe(0);
    expect(pricedCost.usdMicros ?? 0).toBeGreaterThan(0);
    const unpricedCost = rowsOf(rows, unpriced.runId).at(-1)?.["cost"] as {
      usdMicros: number | null;
      unpriced: number;
    };
    expect(unpricedCost.usdMicros).toBeNull();
    expect(unpricedCost.unpriced).toBeGreaterThanOrEqual(1);
  });
});

/** A root the supervisor queued: its `queued` and `preparing` rows. */
function plantRoot(
  ledger: string,
  root: string,
  execution: string,
  extra: Record<string, unknown> = {},
): void {
  const at = new Date().toISOString();
  for (const state of ["queued", "preparing"]) {
    const written = append(runLedgerAt(ledger), {
      id: root,
      state,
      at,
      trigger: { kind: "cli" },
      execution,
      ...extra,
    });
    expect(written.ok).toBe(true);
  }
}

/** An execution id as the supervisor mints one: `run_` and 16 hex. */
const executionId = (): string => `run_${randomBytes(8).toString("hex")}`;

describe("a verified root", () => {
  test("two loops under a queued root: one root running row, and both loops name it", async () => {
    const ledger = tempDir("ledger");
    const root = mintRunId();
    const execution = executionId();
    plantRoot(ledger, root, execution, { trigger: { kind: "schedule", lane: "schedule" } });
    process.env["CREWHAUS_RUN_ID"] = root;
    process.env["CREWHAUS_EXECUTION_ID"] = execution;
    const a = createRunContext();
    const b = createRunContext();
    await loop({ ledger, runContext: a });
    await loop({ ledger, runContext: b });
    const rows = rowsAt(ledger);
    expect(rowsOf(rows, root).map((r) => r["state"])).toEqual(["queued", "preparing", "running"]);
    for (const ctx of [a, b]) {
      const running = rowsOf(rows, ctx.runId)[0];
      expect(running).toMatchObject({
        state: "running",
        parent: root,
        resumeScope: `run:${root}`,
        execution,
        trigger: { kind: "schedule", lane: "schedule" },
      });
      // The root is a row default only: the context itself names no parent.
      expect(ctx.parent).toBeUndefined();
    }
  });

  test("a root with a work item resumes as the work item", async () => {
    const ledger = tempDir("ledger");
    const root = mintRunId();
    const execution = executionId();
    const workItem = mintId("wi");
    plantRoot(ledger, root, execution, { workItem });
    process.env["CREWHAUS_RUN_ID"] = root;
    process.env["CREWHAUS_EXECUTION_ID"] = execution;
    const ctx = createRunContext();
    await loop({ ledger, runContext: ctx });
    expect(rowsOf(rowsAt(ledger), ctx.runId)[0]).toMatchObject({
      parent: root,
      resumeScope: `work:${workItem}`,
      workItem,
    });
  });

  const refused: Array<[string, (ledger: string) => { id: string; execution: string }]> = [
    ["no row for it", () => ({ id: mintRunId(), execution: executionId() })],
    [
      "another execution",
      (ledger) => {
        const id = mintRunId();
        plantRoot(ledger, id, executionId());
        return { id, execution: executionId() };
      },
    ],
    [
      "a root already running",
      (ledger) => {
        const id = mintRunId();
        const execution = executionId();
        plantRoot(ledger, id, execution);
        append(runLedgerAt(ledger), {
          id,
          state: "running",
          at: new Date().toISOString(),
          trigger: { kind: "cli" },
          execution,
        });
        return { id, execution };
      },
    ],
    [
      "a root already ended",
      (ledger) => {
        const id = mintRunId();
        const execution = executionId();
        plantRoot(ledger, id, execution);
        append(runLedgerAt(ledger), {
          id,
          state: "cancelled",
          at: new Date().toISOString(),
          trigger: { kind: "cli" },
          execution,
        });
        return { id, execution };
      },
    ],
    [
      "an id that is not canonical",
      (ledger) => {
        const execution = executionId();
        plantRoot(ledger, "run_0123abcd", execution);
        return { id: "run_0123abcd", execution };
      },
    ],
    [
      "a root pushed out of the newest 256 lines",
      (ledger) => {
        const id = mintRunId();
        const execution = executionId();
        plantRoot(ledger, id, execution);
        for (let i = 0; i < 256; i++) {
          append(runLedgerAt(ledger), {
            id: mintRunId(),
            state: "queued",
            at: new Date().toISOString(),
            trigger: { kind: "cli" },
          });
        }
        return { id, execution };
      },
    ],
  ];
  for (const [name, plant] of refused) {
    test(`not honoured: ${name}`, async () => {
      const ledger = tempDir("ledger");
      const { id, execution } = plant(ledger);
      process.env["CREWHAUS_RUN_ID"] = id;
      process.env["CREWHAUS_EXECUTION_ID"] = execution;
      const planted = existsSync(join(ledger, RUN_LEDGER_DIR));
      const before = planted
        ? readFileSync(join(ledger, RUN_LEDGER_DIR, segmentOf(ledger)))
        : Buffer.alloc(0);
      const { logger, warns } = recordingLogger();
      const ctx = createRunContext({ logger });
      const { caught } = await loop({ ledger, runContext: ctx });
      expect(caught).toBeUndefined();
      // The loop's own rows are appended after what was there, untouched.
      const after = readFileSync(join(ledger, RUN_LEDGER_DIR, segmentOf(ledger)));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);
      const rows = rowsAt(ledger);
      const running = rowsOf(rows, ctx.runId)[0];
      expect("parent" in (running ?? {})).toBe(false);
      expect(running?.["resumeScope"]).toBe(`session:${ctx.sessionId}`);
      expect(rowsOf(rows, id).filter((r) => r["state"] === "running").length).toBe(
        name === "a root already running" ? 1 : 0,
      );
      const refusals = warns.filter((w) => w.msg.includes("CREWHAUS_RUN_ID"));
      expect(refusals).toHaveLength(1);
      expect(JSON.stringify(refusals)).not.toContain(id);
    });
  }
});

/** The ledger's one segment file, by name. */
function segmentOf(ledger: string): string {
  const files = readdirSync(join(ledger, RUN_LEDGER_DIR)).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return files[0] as string;
}

describe("a shared context", () => {
  test("two loops inside one hold: one running row, one succeeded after the release", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    const release = retainRun(ctx);
    await loop({ ledger, runContext: ctx });
    await loop({ ledger, runContext: ctx });
    expect(rowsOf(rowsAt(ledger), ctx.runId).map((r) => r["state"])).toEqual(["running"]);
    release();
    expect(rowsOf(rowsAt(ledger), ctx.runId).map((r) => r["state"])).toEqual([
      "running",
      "succeeded",
    ]);
  });

  test("without a hold, the second loop on an ended run writes nothing", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    await loop({ ledger, runContext: ctx });
    await loop({ ledger, runContext: ctx });
    expect(rowsOf(rowsAt(ledger), ctx.runId).map((r) => r["state"])).toEqual([
      "running",
      "succeeded",
    ]);
  });
});

describe("a ledger that cannot be written", () => {
  test("the loop still succeeds, and one warning names the code", async () => {
    const ledger = tempDir("ledger");
    mkdirSync(join(ledger, ".crewhaus", "run", "control"), { recursive: true });
    writeFileSync(join(ledger, RUN_LEDGER_DIR), "not a directory\n");
    const { logger, warns } = recordingLogger();
    const first = await loop({ ledger, runContext: createRunContext({ logger }) });
    const second = await loop({ ledger, runContext: createRunContext({ logger }) });
    expect(first.caught).toBeUndefined();
    expect(second.caught).toBeUndefined();
    const failed = warns.filter((w) => w.msg.includes("run records could not be written"));
    expect(failed).toHaveLength(1);
    expect(typeof failed[0]?.fields?.["code"]).toBe("string");
  });
});

describe("a park the loop did not write itself", () => {
  test("a stop that escalates approval_pending with no park row is still a park: waiting-for-approval, then nothing", async () => {
    const ledger = tempDir("ledger");
    // A tool that rethrows a nested run's park, the way a sub-agent's is escalated.
    const escalates = buildTool({
      name: "escalates",
      description: "a nested run parked",
      inputSchema: z.object({}).passthrough(),
      readOnly: true,
      execute: async () => {
        throw new RunFailedError({
          class: "approval_pending",
          title: "awaiting tool approval",
          detail: "a nested run is parked",
          remediation: "grant or deny it, then rerun",
          exitCode: EXIT_CODES.approval_pending,
        });
      },
    });
    const ctx = createRunContext();
    const { caught } = await loop({
      ledger,
      runContext: ctx,
      tools: [escalates],
      _adapter: toolAdapter("escalates", { input: 10, output: 5 }, ["tool", "text"]),
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("approval_pending");
    const rows = rowsOf(rowsAt(ledger), ctx.runId);
    expect(rows.map((r) => r["state"])).toEqual(["running", "waiting-for-approval"]);
    // A park carries no cost: a resume goes on spending.
    expect("cost" in (rows[1] ?? {})).toBe(false);
  });

  test("a park recorded through a sub-run's context lands on the run it descends from", async () => {
    const ledger = tempDir("ledger");
    const store: PendingApprovalStore = createPendingApprovalStore({
      rootDir: join(tempDir("approvals"), "approvals"),
    });
    const parent = createRunContext();
    const danger = buildTool({
      name: "danger",
      description: "must be approved",
      inputSchema: z.object({ x: z.number() }).strict(),
      readOnly: false,
      destructive: false,
      concurrencySafe: false,
      execute: async () => "did it",
    });
    // A tool that runs a nested loop on a child context, which parks; the
    // tool rethrows the park, as the sub-agent spawner does.
    const nested = buildTool({
      name: "nested",
      description: "runs a nested loop",
      inputSchema: z.object({}).passthrough(),
      readOnly: true,
      execute: async () => {
        const child = createRunContext({ parent: parent.runId });
        const out = await loop({
          ledger,
          runContext: child,
          permissionMode: "default",
          tools: [danger],
          approvals: { store },
          _adapter: toolAdapter("danger", { input: 10, output: 5 }, ["tool", "text"]),
        });
        throw out.caught;
      },
    });
    const { caught } = await loop({
      ledger,
      runContext: parent,
      tools: [nested],
      _adapter: toolAdapter("nested", { input: 10, output: 5 }, ["tool", "text"]),
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    const pending = await store.get("danger", hashApprovalInput("danger", { x: 1 }));
    expect(pending?.id).toBeDefined();
    const rows = rowsAt(ledger);
    // Only the top-level run has rows: running, its park with the child's approval, nothing after.
    expect(new Set(rows.map((r) => r["id"]))).toEqual(new Set([parent.runId]));
    expect(rows.map((r) => r["state"])).toEqual(["running", "waiting-for-approval"]);
    expect(rows[1]?.["decision"]).toBe(pending?.id);
  });
});

describe("a holder's own end", () => {
  /** One clean loop on `ctx` inside a hold the test releases with `ended`. */
  async function heldLoop(
    ledger: string,
    ended: Parameters<ReturnType<typeof retainRun>>[0],
    loopArgs: Partial<RunChatLoopOptions> = {},
  ): Promise<Row[]> {
    const ctx = createRunContext();
    const release = retainRun(ctx);
    await loop({ ledger, runContext: ctx, ...loopArgs });
    release(ended);
    return rowsOf(rowsAt(ledger), ctx.runId);
  }

  test("a holder that failed after a clean loop fails the run: unknown for a plain error, the class for a classified stop", async () => {
    const ledger = tempDir("ledger");
    const plain = await heldLoop(ledger, { outcome: "failed", error: new Error("node failed") });
    expect(plain.map((r) => r["state"])).toEqual(["running", "failed"]);
    expect(plain[1]?.["failureClass"]).toBe("unknown");
    const budget = new RunFailedError({
      class: "crewhaus_budget",
      title: "budget",
      detail: "spent",
      remediation: "raise it",
      exitCode: EXIT_CODES.crewhaus_budget,
    });
    const classified = await heldLoop(ledger, { outcome: "failed", error: budget });
    expect(classified[1]).toMatchObject({
      state: "failed",
      failureClass: "crewhaus_budget",
      cause: { kind: "budget", ref: "crewhaus_budget" },
    });
  });

  test("a holder's pause is waiting-for-approval, never succeeded", async () => {
    const ledger = tempDir("ledger");
    const rows = await heldLoop(ledger, { outcome: "paused" });
    expect(rows.map((r) => r["state"])).toEqual(["running", "waiting-for-approval"]);
  });

  test("a holder that says it succeeded wins over a loop it recovered from", async () => {
    const ledger = tempDir("ledger");
    const auth = Object.assign(new Error("401 invalid x-api-key"), {
      providerId: "anthropic",
      status: 401,
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const rows = await heldLoop(
      ledger,
      { outcome: "succeeded" },
      { _adapter: throwingAdapter(auth) },
    );
    expect(rows.map((r) => r["state"])).toEqual(["running", "succeeded"]);
  });

  test("a graph whose node throws after a loop on its context records failed, not the loop's success", async () => {
    const ledger = tempDir("ledger");
    const runContext = createRunContext();
    const graph = createGraph<number, number>()
      .addNode("talk", async (ctx, s) => {
        const out = await loop({ ledger, runContext: ctx.runContext });
        if (out.caught !== undefined) throw out.caught;
        return s + 1;
      })
      .addNode("check", async () => {
        throw new Error("validation failed");
      })
      .addEdge("talk", "check")
      .setEntry("talk")
      .compile();
    await expect(collectTerminalState(graph.run(0, { runContext }))).rejects.toThrow(
      "validation failed",
    );
    const rows = rowsOf(rowsAt(ledger), runContext.runId);
    expect(rows.map((r) => r["state"])).toEqual(["running", "failed"]);
    expect(rows[1]?.["failureClass"]).toBe("unknown");
  });

  test("a graph that pauses for a person after a loop records waiting-for-approval", async () => {
    const ledger = tempDir("ledger");
    const runContext = createRunContext();
    const graph = createGraph<number, number>()
      .addNode("talk", async (ctx, s) => {
        await loop({ ledger, runContext: ctx.runContext });
        return s + 1;
      })
      .addNode("ask", async (ctx, s) => {
        await ctx.requestApproval("go ahead?");
        return s;
      })
      .addEdge("talk", "ask")
      .setEntry("talk")
      .compile();
    for await (const _ev of graph.run(0, { runContext })) {
      // drain to the pause
    }
    expect(rowsOf(rowsAt(ledger), runContext.runId).map((r) => r["state"])).toEqual([
      "running",
      "waiting-for-approval",
    ]);
  });
});

describe("a sub-agent's spend", () => {
  test("a priced parent with an unpriced sub-agent roll-up counts it as unpriced, not as $0", async () => {
    const ledger = tempDir("ledger");
    const ctx = createRunContext();
    let published = false;
    // The roll-up a sub-agent's spend reaches the parent's bus as, published mid-run.
    const adapter = textAdapter("done", { input: 100, output: 10 }, () => {
      if (published) return;
      published = true;
      ctx.eventBus.publish({
        ...ctx.eventBus.envelope(),
        kind: "cost_accrual",
        role: "subagent",
        summary: true,
        provider: "anthropic",
        modelId: "a-local-model",
        inputTokens: 50,
        outputTokens: 5,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        costUsdMicros: 0,
        unpriced: true,
      });
    });
    await loop({ ledger, runContext: ctx, model: "claude-sonnet-4-6", _adapter: adapter });
    expect(published).toBe(true);
    const cost = rowsOf(rowsAt(ledger), ctx.runId).at(-1)?.["cost"] as {
      usdMicros: number | null;
      unpriced: number;
    };
    // The parent's own call is priced, so there is a figure, and the roll-up is counted against it.
    expect(cost.usdMicros ?? 0).toBeGreaterThan(0);
    expect(cost.unpriced).toBeGreaterThanOrEqual(1);
  });
});

describe("a process that exits mid-run", () => {
  test("a REPL ended with Ctrl-C twice exits 130 and its run is succeeded, not left running", async () => {
    const ledger = tempDir("ledger");
    const sessions = tempDir("sessions");
    const script = join(tempDir("script"), "repl.ts");
    // The child imports this package by path: a temp directory resolves no workspace names.
    writeFileSync(
      script,
      `import { Readable } from "node:stream";
import { runChatLoop } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
let ready = false;
// An input that never sends a line: the REPL waits on it until the signals end it.
const input = new Readable({
  read() {
    if (ready) return;
    ready = true;
    process.stdout.write("READY\\n");
  },
});
const adapter = {
  providerId: "anthropic",
  features: { caching: "explicit", tool_use: true, vision: true, thinking: true, web_search: true },
  estimateTokens: () => 0,
  stream: () => (async function* () { yield { kind: "message_start" }; })(),
};
await runChatLoop({
  model: "test-model",
  instructions: "run rows exit test",
  input,
  installSigintHandler: true,
  permissionMode: "bypass",
  spinner: false,
  stdout: (chunk) => process.stdout.write(chunk),
  settingsDir: null,
  sessionRootDir: ${JSON.stringify(sessions)},
  runLedgerDir: ${JSON.stringify(ledger)},
  _adapter: adapter,
});
`,
    );
    const env = { ...process.env };
    for (const key of ENV_KEYS) Reflect.deleteProperty(env, key);
    const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errors = "";
    let gone = false;
    const waiters: Array<{ text: string; resolve: () => void; reject: (e: Error) => void }> = [];
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      for (const w of waiters.splice(0)) {
        if (out.includes(w.text)) w.resolve();
        else waiters.push(w);
      }
    });
    // Waiting on the child's own output, never on time: a child that ends first fails the wait.
    const seen = (text: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (out.includes(text)) resolve();
        else if (gone) reject(new Error(`the child ended before "${text}": ${errors}`));
        else waiters.push({ text, resolve, reject });
      });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => {
        gone = true;
        for (const w of waiters.splice(0)) {
          w.reject(new Error(`the child ended before "${w.text}": ${errors}`));
        }
        resolve(code);
      }),
    );
    await seen("READY");
    // The run is open: its running row is written, and nothing else yet.
    expect(rowsAt(ledger).map((r) => r["state"])).toEqual(["running"]);
    child.kill("SIGINT");
    await seen("turn aborted");
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    const rows = rowsAt(ledger);
    expect(rows.map((r) => r["state"])).toEqual(["running", "succeeded"]);
    expect(rows[1]?.["id"]).toBe(rows[0]?.["id"]);
    expect(rows[1]?.["cost"]).toBeDefined();
  }, 30_000); // a child bun process loads the whole runtime: slow by construction on CI
});
