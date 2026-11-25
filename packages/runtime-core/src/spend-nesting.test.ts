/**
 * A call made inside a tool never waits on the call running that tool, a sent
 * call is counted whatever happens to it, and a run's period ledger lives in
 * the harness directory it is given.
 *
 * No wall clock: a nested reserve that waited on its ancestor would never
 * resolve, so a regression fails by bun's per-test deadline, not by a timer
 * of ours.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import type { RuntimeBridge } from "@crewhaus/agent-context-isolation";
import { openBudgetLedger } from "@crewhaus/control-records/budget";
import type { SpendAdmission, SpendMeter } from "@crewhaus/cost-tracker/spend";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { initialRecoveryState, recover } from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { runChatLoop } from "./index";
import { openPeriodSpendMeter, spendMeterOf } from "./spend-wiring";

const ROOTS: string[] = [];
const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-nesting-${label}-`));
  ROOTS.push(dir);
  return dir;
};
const SESSIONS = tempDir("sessions");
let savedSessionDir: string | undefined;
beforeAll(() => {
  savedSessionDir = process.env["CREWHAUS_SESSION_DIR"];
  process.env["CREWHAUS_SESSION_DIR"] = SESSIONS;
});
afterAll(() => {
  if (savedSessionDir === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
  else process.env["CREWHAUS_SESSION_DIR"] = savedSessionDir;
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

/** Priced: a 64 000-token ceiling at $15/M is a $0.96 worst case, over a $0.50 cap. */
const SONNET = "claude-sonnet-4-6";
const USAGE = { input: 100, output: 10 };

type Step = "spawn" | "text" | "throw" | "rate-limited" | "late-throw";

/** A rate limit the built-in recovery retries at once (Retry-After 0). */
const rateLimited = (): Error =>
  Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 0 });

/** A scripted adapter: `spawn` asks for the `spawn` tool, `text` ends the turn, the rest fail mid-stream. */
function scripted(
  script: ReadonlyArray<Step>,
  providerId: ProviderId = "anthropic",
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId,
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = script[call] ?? "text";
      const id = `tu_${call}`;
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: USAGE.input, output: 0 } };
        if (step === "throw") throw new Error("the stream broke");
        if (step === "rate-limited") throw rateLimited();
        if (step === "spawn") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: "spawn", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "tool_use", usage: USAGE };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output: 10 } };
          if (step === "late-throw") throw new Error("the connection closed late");
        }
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** A meter that records every answer its reserves get. */
function recording(meter: SpendMeter, answers: SpendAdmission[]): SpendMeter {
  return {
    ...meter,
    reserve: async (...args: Parameters<SpendMeter["reserve"]>) => {
      const answer = await meter.reserve(...args);
      answers.push(answer);
      return answer;
    },
  };
}

/** A streaming parent near its cap whose one tool runs `inside` while the parent's call is still open. */
async function streamingParent(
  inside: (bridge: RuntimeBridge, parent: RunContext) => Promise<string>,
): Promise<{ parent: RunContext; caught: unknown }> {
  const parent = createRunContext();
  const spawn = buildTool({
    name: "spawn",
    description: "runs a nested loop",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async (_input, ctx) => inside(ctx?.bridge as RuntimeBridge, parent),
  });
  let caught: unknown;
  try {
    await runChatLoop({
      model: SONNET,
      instructions: "parent",
      _adapter: scripted(["spawn", "text"]),
      tools: [spawn],
      permissionMode: "bypass",
      streaming: true,
      maxTokens: 64_000,
      budget: { usdMicros: 500_000, onExceed: { kind: "stop" } },
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext: parent,
    });
  } catch (err) {
    caught = err;
  }
  return { parent, caught };
}

describe("a loop nested inside a streaming call's tool", () => {
  test("stops with the budget's exit code instead of waiting on the call running it", async () => {
    const answers: SpendAdmission[] = [];
    let nested: unknown;
    const { parent, caught } = await streamingParent(async (_bridge, parentCtx) => {
      const view = spendMeterOf(parentCtx);
      if (view === undefined) throw new Error("the parent has no spend meter");
      try {
        await runChatLoop({
          model: SONNET,
          instructions: "child",
          _adapter: scripted(["text"]),
          tools: [],
          maxTokens: 64_000,
          spendMeter: recording(view, answers),
          singleTurn: true,
          seedMessages: [{ role: "user", content: "help" }],
          installSigintHandler: false,
          spinner: false,
          stdout: () => {},
          runContext: createRunContext(),
          persistSession: false,
        });
      } catch (err) {
        nested = err;
      }
      return "stopped";
    });
    expect(caught).toBeUndefined();
    expect(nested).toBeInstanceOf(RunFailedError);
    const report = (nested as RunFailedError).report;
    expect(report.class).toBe("crewhaus_budget");
    expect(report.exitCode).toBe(EXIT_CODES.crewhaus_budget);
    expect(report.exitCode).toBe(33);
    expect(report.detail).toContain("counting the call still in progress");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.some((a) => !a.admit && a.on === "others")).toBe(false);
    expect(answers.every((a) => !a.admit && a.on === "spent" && a.inFlight === true)).toBe(true);
    expect(spendMeterOf(parent)?.snapshot().activeReservations).toBe(0);
  });

  test("the bridge's spend, what a sub-agent is handed, names the call in progress", async () => {
    let answer: SpendAdmission | undefined;
    const { caught } = await streamingParent(async (bridge) => {
      if (bridge.spend === undefined) throw new Error("the bridge carries no spend meter");
      answer = await bridge.spend.reserve("rsv_child", 1_000);
      // A sub-agent with a share spends through a child of the same view.
      const share = await bridge.spend.child({ capMicros: 10_000_000 }).reserve("rsv_share", 1);
      expect(share).toEqual({ admit: false, on: "spent", scope: "run", inFlight: true });
      return "ok";
    });
    expect(caught).toBeUndefined();
    expect(answer).toEqual({ admit: false, on: "spent", scope: "run", inFlight: true });
  });
});

/** Every ledger line of a harness's current periods. */
function ledgerLines(harness: string): Array<Record<string, unknown>> {
  const budget = join(harness, ".crewhaus", "run", "control", "budget");
  const out: Array<Record<string, unknown>> = [];
  if (!existsSync(budget)) return out;
  for (const period of readdirSync(budget)) {
    if (!period.startsWith("month-")) continue;
    for (const seg of readdirSync(join(budget, period))) {
      if (!seg.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(budget, period, seg), "utf8").split("\n")) {
        if (line !== "") out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

const PERIOD = { every: "month" as const, usdMicros: 100_000_000 };

async function periodRun(
  harness: string,
  adapter: ProviderAdapter,
  extra: Partial<Parameters<typeof runChatLoop>[0]> = {},
): Promise<{ caught: unknown }> {
  let caught: unknown;
  try {
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: adapter,
      tools: [],
      budget: { usdMicros: 50_000_000, onExceed: { kind: "stop" }, period: PERIOD },
      spendLedgerRoot: harness,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext: createRunContext(),
      persistSession: false,
      ...extra,
    });
  } catch (err) {
    caught = err;
  }
  return { caught };
}

describe("a call that was sent is counted", () => {
  test("a stream that breaks after it started settles at the reserved worst case, never a release", async () => {
    const harness = tempDir("broken");
    await periodRun(harness, scripted(["throw"]));
    const lines = ledgerLines(harness);
    const reserves = lines.filter((l) => l["op"] === "reserve");
    expect(reserves).toHaveLength(1);
    const id = reserves[0]?.["id"];
    expect(typeof id === "string" && id.startsWith("rsv_")).toBe(true);
    const settles = lines.filter((l) => l["op"] === "settle" && l["id"] === id);
    expect(settles).toHaveLength(1);
    expect(settles[0]?.["usdMicros"]).toBe(reserves[0]?.["usdMicros"]);
    expect(lines.filter((l) => l["op"] === "release")).toEqual([]);
  });

  test("a call that fails after its stream reported its usage settles at that usage", async () => {
    const harness = tempDir("reported");
    await periodRun(harness, scripted(["late-throw"]));
    const lines = ledgerLines(harness);
    const reserves = lines.filter((l) => l["op"] === "reserve");
    expect(reserves).toHaveLength(1);
    const settles = lines.filter((l) => l["op"] === "settle");
    expect(settles).toHaveLength(1);
    expect(settles[0]?.["id"]).toBe(reserves[0]?.["id"]);
    // 100 input tokens at $3/M and 10 output tokens at $15/M: 450 micros, not the worst case.
    expect(settles[0]?.["usdMicros"]).toBe(450);
    expect(lines.filter((l) => l["op"] === "release")).toEqual([]);
  });

  test("a tool's terminal verdict leaves the streaming call settled at its reported usage", async () => {
    const harness = tempDir("verdict");
    const spawn = buildTool({
      name: "spawn",
      description: "ends the run",
      inputSchema: z.object({}),
      readOnly: true,
      execute: async () => {
        throw new RunFailedError({
          class: "crewhaus_budget",
          title: "Budget",
          detail: "a nested run stopped",
          remediation: "raise the budget",
          exitCode: EXIT_CODES.crewhaus_budget,
        });
      },
    });
    const { caught } = await periodRun(harness, scripted(["spawn"]), {
      streaming: true,
      tools: [spawn],
      permissionMode: "bypass",
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    const settles = ledgerLines(harness).filter((l) => l["op"] === "settle");
    expect(settles.map((l) => l["usdMicros"])).toEqual([450]);
  });

  test("each attempt a recovery retry makes is counted on its own", async () => {
    // The built-in recovery retries this error at once.
    expect(recover(rateLimited(), initialRecoveryState)).toMatchObject({
      kind: "retry",
      delayMs: 0,
    });
    const harness = tempDir("retried");
    const { caught } = await periodRun(harness, scripted(["rate-limited", "text"]));
    expect(caught).toBeUndefined();
    const lines = ledgerLines(harness);
    expect(lines.filter((l) => l["op"] === "reserve")).toHaveLength(2);
    expect(lines.filter((l) => l["op"] === "settle")).toHaveLength(2);
    expect(lines.filter((l) => l["op"] === "release")).toEqual([]);
  });

  test("a reservation refused before the call is sent leaves no line", async () => {
    const harness = tempDir("refused");
    const tight = { every: "month" as const, usdMicros: 1_000 };
    await openBudgetLedger(harness, tight).settle({ id: "earlier", usdMicros: 1_000 });
    const adapter = scripted(["text"]);
    let caught: unknown;
    try {
      await runChatLoop({
        model: SONNET,
        instructions: "test",
        _adapter: adapter,
        tools: [],
        budget: { usdMicros: 50_000_000, onExceed: { kind: "stop" }, period: tight },
        spendLedgerRoot: harness,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        installSigintHandler: false,
        spinner: false,
        stdout: () => {},
        runContext: createRunContext(),
        persistSession: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    expect(adapter.requests).toHaveLength(0);
    expect(ledgerLines(harness).map((l) => l["id"])).toEqual(["earlier"]);
  });
});

describe("the period ledger's root", () => {
  test("a run given its harness directory writes its ledger there, wherever it was started", async () => {
    const harness = tempDir("root");
    const elsewhere = tempDir("cwd");
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      const { caught } = await periodRun(harness, scripted(["text"]));
      expect(caught).toBeUndefined();
    } finally {
      process.chdir(before);
    }
    const ops = ledgerLines(harness).map((l) => l["op"]);
    expect(ops).toEqual(["reserve", "settle"]);
    expect(existsSync(join(elsewhere, ".crewhaus", "run", "control", "budget"))).toBe(false);
  });

  test("a period meter records this process's start time on its holders", async () => {
    const harness = tempDir("holder");
    const meter = openPeriodSpendMeter({ period: PERIOD, root: harness, trigger: "eval" });
    expect(await meter.reserve("rsv_h", 10)).toEqual({ admit: true });
    const [line] = ledgerLines(harness);
    const holder = line?.["holder"] as { pid?: number; startedAt?: number } | undefined;
    expect(holder?.pid).toBe(process.pid);
    expect(typeof holder?.startedAt).toBe("number");
    const own = Date.now() - process.uptime() * 1000;
    expect(Math.abs((holder?.startedAt ?? 0) - own)).toBeLessThan(2_000);
  });
});
