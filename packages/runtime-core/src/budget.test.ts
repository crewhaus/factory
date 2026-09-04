/**
 * Item 27 — run-level spend cap with a degradation ladder, over the LIVE
 * `runChatLoop` REPL path. An always-on cost meter accrues per-response
 * spend (priced off the wire model that served), and a PRE-TURN check
 * enforces the cap before the next turn opens:
 *   - `on_exceed: stop`    → the run ends cleanly before the over-budget
 *                            turn runs (the in-flight turn always completes).
 *   - `on_exceed: degrade` → the primary model is re-resolved to the cheaper
 *                            rung once (a `model_failover` reason
 *                            `budget_degrade`); the rung serves the rest of
 *                            the turn it fired in, and the run stops at the
 *                            next turn boundary.
 *
 * These drive the real loop with a scripted-adapter primary whose usage is
 * priced by cost-tracker's real DEFAULT_PRICING table, and feed input over
 * a fake stdin so the multi-turn REPL runs deterministically.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { type Scoreboard, openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type {
  ModelFailoverEvent,
  ModelResponseEvent,
  ModelRouteEvent,
  RunFailedEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";

const SHARED_SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-budget-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SHARED_SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SHARED_SESSION_ROOT, { recursive: true, force: true });
});

/**
 * Scripted adapter that reports a fixed, sizeable usage per response so a
 * handful of turns crosses a small dollar cap deterministically. Records
 * every request so we can assert which model each turn hit.
 */
function pricedAdapter(
  providerId: ProviderId,
  usage: { input: number; output: number },
  text: string,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/**
 * Interactive fake stdin: writes ONE line at a time, advancing on each
 * `turn_end` event, then EOFs. Bun's readline over a pre-buffered+ended
 * stream delivers only the first line then closes, so a multi-turn REPL
 * test must feed input turn-by-turn — the bus's `turn_end` is the natural
 * pump. `maxTurns` caps how many lines we ever write so a run that fails to
 * self-terminate can't hang the test.
 */
function interactiveStdin(
  bus: { subscribe(fn: (e: TraceEvent) => void): () => void },
  lines: readonly string[],
): NodeJS.ReadableStream {
  const stream = new PassThrough();
  let i = 0;
  const writeNext = (): void => {
    if (i < lines.length) {
      stream.write(`${lines[i]}\n`);
      i += 1;
    } else {
      stream.end();
    }
  };
  bus.subscribe((e) => {
    // After each completed turn, feed the next line (or EOF). Deferred so the
    // loop is back at `rl.question` before the line arrives.
    if (e.kind === "turn_end") setImmediate(writeNext);
  });
  // Prime the first turn.
  setImmediate(writeNext);
  return stream;
}

function captureStderr(): { lines: () => string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines: () => chunks.join("").split("\n"),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("runChatLoop — run-level budget cap (item 27)", () => {
  test("on_exceed: stop ends the run before the over-budget turn", async () => {
    // claude-sonnet-4 pricing: input $3/M, output $15/M. 100 in + 10 out =
    // 300 + 150 = 450 micros/turn. Cap at 1000 micros → turn 1 (450) and
    // turn 2 (900) run; before turn 3 (would be 1350) spent=900 < 1000 so it
    // runs → 1350 ≥ 1000, so turn 4 is gated. We feed 5 turns; expect the
    // loop to stop before running all 5.
    const primary = pricedAdapter("anthropic", { input: 100, output: 10 }, "ok");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: "claude-sonnet-4-6",
        instructions: "test",
        _adapter: primary,
        budget: { usdMicros: 1000, onExceed: { kind: "stop" } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three", "four", "five"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    const responses = seen.filter((e) => e.kind === "model_response");
    // Fewer than the 5 offered turns ran — the cap gated the rest.
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.length).toBeLessThan(5);
    // The stop notice landed on stderr.
    expect(stderr.lines().some((l) => l.includes("[budget]") && l.includes("ending the run"))).toBe(
      true,
    );
  });

  test("on_exceed: degrade re-resolves to the cheaper model, then a later breach stops", async () => {
    // Primary claude-opus-4 (input $15/M, output $75/M): 100 in + 10 out =
    // 1500 + 750 = 2250 micros/turn. Cap 2000 → turn 1 runs (2250 ≥ 2000),
    // so before turn 2 we DEGRADE to the injected cheaper model. The
    // degraded model keeps accruing; a second breach on it stops the run.
    const primary = pricedAdapter("anthropic", { input: 100, output: 10 }, "opus");
    const degraded = pricedAdapter("anthropic", { input: 100, output: 10 }, "haiku");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: "claude-opus-4-1",
        instructions: "test",
        _adapter: primary,
        _budgetDegradeAdapter: degraded,
        budget: { usdMicros: 2000, onExceed: { kind: "degrade", model: "claude-haiku-4-5" } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three", "four"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    // A budget_degrade failover event fired from opus → haiku.
    const failovers = seen.filter((e): e is ModelFailoverEvent => e.kind === "model_failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      from: "claude-opus-4-1",
      to: "claude-haiku-4-5",
      reason: "budget_degrade",
    });
    // The degrade notice + a subsequent stop notice both landed.
    expect(stderr.lines().some((l) => l.includes("degrading claude-opus-4-1"))).toBe(true);
    // At least one response priced against the degraded model.
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses.some((r) => r.model === "claude-haiku-4-5")).toBe(true);
  });

  test("no budget option leaves the loop untouched (all offered turns run)", async () => {
    const primary = pricedAdapter("anthropic", { input: 100, output: 10 }, "ok");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test",
      _adapter: primary,
      input: interactiveStdin(runContext.eventBus, ["one", "two", "three"]),
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    const responses = seen.filter((e) => e.kind === "model_response");
    expect(responses.length).toBe(3);
    expect(seen.some((e) => e.kind === "model_failover")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §7.12 — budget composes with everything (PR 1: the substrate).
// ---------------------------------------------------------------------------

/**
 * Scripted adapter whose calls follow `script`: `"tool"` returns one
 * `tool_use` of `noop`, `"text"` returns a text block; past the end of the
 * script it keeps returning `tool_use` (a runaway tool loop). Usage is fixed
 * per call so spend is deterministic against the real DEFAULT_PRICING table.
 */
function scriptedToolLoopAdapter(
  providerId: ProviderId,
  usage: { input: number; output: number },
  script: ReadonlyArray<"tool" | "text">,
  opts: { readonly text?: string } = {},
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = script[call] ?? "tool";
      const id = `tu_${call}`;
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } };
        if (step === "tool") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: "noop", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "tool_use", usage };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: opts.text ?? "done" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
}

function noopTool(opts: { readonly delayMs?: number } = {}) {
  return buildTool({
    name: "noop",
    description: "does nothing",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => {
      if (opts.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      return "ok";
    },
  });
}

const HAIKU = "claude-haiku-4-5"; // 100 in + 10 out = 100 + 50 = 150 micros
const SONNET = "claude-sonnet-4-6"; // 100 in + 10 out = 300 + 150 = 450 micros
const OPUS = "claude-opus-4-1"; // 100 in + 10 out = 1500 + 750 = 2250 micros
const USAGE = { input: 100, output: 10 };

const TMP_DIRS: string[] = [];
function tmpScoreboard(): Scoreboard {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-budget-sb-"));
  TMP_DIRS.push(dir);
  return openScoreboard(dir, { now: () => 1_700_000_000_000 });
}
afterAll(() => {
  for (const d of TMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function runAndCatch(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("runChatLoop — per-model-call budget gate (0.6.0 §7.12, sanctioned change §14(2))", () => {
  test("singleTurn: a runaway tool loop is stopped at the cap with a classified crewhaus_budget failure", async () => {
    // Sonnet: 450 micros per model call. Cap 1000: call 1 (450) and call 2
    // (900) run; the gate before call 3 reads 900 < 1000 so it runs (1350);
    // the gate before call 4 trips. Without the gate this adapter would loop
    // to the 500-iteration default — `budget` never reached the singleTurn
    // path before 0.6.0.
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, []); // always tool_use
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    let caught: unknown;
    try {
      caught = await runAndCatch(() =>
        runChatLoop({
          model: SONNET,
          instructions: "test",
          _adapter: adapter,
          tools: [noopTool()],
          permissionMode: "bypass",
          budget: { usdMicros: 1000, onExceed: { kind: "stop" } },
          singleTurn: true,
          seedMessages: [{ role: "user", content: "loop forever" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("crewhaus_budget");
    expect(caught.report.exitCode).toBe(EXIT_CODES.crewhaus_budget);
    expect(caught.report.detail).toContain("model call 4");
    // Exactly three model calls were made — the fourth was gated.
    expect(seen.filter((e) => e.kind === "model_response")).toHaveLength(3);
    expect(adapter.requests).toHaveLength(3);
    // The classified stop is on the bus, once, with the budget class.
    const failed = seen.filter((e): e is RunFailedEvent => e.kind === "run_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.class).toBe("crewhaus_budget");
    expect(failed[0]?.exitCode).toBe(EXIT_CODES.crewhaus_budget);
    expect(stderr.lines().some((l) => l.includes("[budget]") && l.includes("ending the run"))).toBe(
      true,
    );
    // Severing semantics: the stop lands at a REQUEST boundary — every
    // tool_use the model issued has its tool_result committed, so the last
    // request the model saw ends with a complete tool_result user message.
    const lastReq = adapter.requests[adapter.requests.length - 1];
    const lastMsg = lastReq?.messages[lastReq.messages.length - 1];
    expect(lastMsg?.role).toBe("user");
    expect(Array.isArray(lastMsg?.content)).toBe(true);
    expect((lastMsg?.content as Array<{ type: string }>)[0]?.type).toBe("tool_result");
  });

  test("singleTurn: under the cap the same tool loop runs to completion (gate is inert)", async () => {
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "tool", "text"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: adapter,
      tools: [noopTool()],
      permissionMode: "bypass",
      budget: { usdMicros: 10_000, onExceed: { kind: "stop" } },
      singleTurn: true,
      seedMessages: [{ role: "user", content: "two tools then answer" }],
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    expect(text).toBe("done");
    expect(seen.filter((e) => e.kind === "model_response")).toHaveLength(3);
    expect(seen.some((e) => e.kind === "run_failed")).toBe(false);
  });

  test("singleTurn: no budget option leaves the tool loop untouched (control)", async () => {
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "tool", "tool", "text"]);
    const runContext = createRunContext();
    const text = await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: adapter,
      tools: [noopTool()],
      permissionMode: "bypass",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    expect(text).toBe("done");
    expect(adapter.requests).toHaveLength(4);
  });

  test("REPL: a breach MID-turn (tool iteration) ends the run with the classified failure, not a clean break", async () => {
    // Turn 1: tool, tool, text = 3 calls × 450 = 1350; cap 1200 → the gate
    // before call 3 (spent 900) passes… so use cap 1000: call 3 gate reads
    // 900 < 1000 and runs (1350). Make the turn need a 4th call instead.
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "tool", "tool", "text"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    let caught: unknown;
    try {
      caught = await runAndCatch(() =>
        runChatLoop({
          model: SONNET,
          instructions: "test",
          _adapter: adapter,
          tools: [noopTool()],
          permissionMode: "bypass",
          budget: { usdMicros: 1000, onExceed: { kind: "stop" } },
          input: interactiveStdin(runContext.eventBus, ["one", "two"]),
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    expect((caught as RunFailedError).report.class).toBe("crewhaus_budget");
    expect(seen.filter((e) => e.kind === "model_response")).toHaveLength(3);
    // The turn never completed (no turn_end) — the loop was severed at the
    // request boundary before its 4th model call.
    expect(seen.filter((e) => e.kind === "turn_end")).toHaveLength(0);
  });
});

describe("runChatLoop — degrade mid-turn: the rung serves the rest of the turn (0.6.0 §7.12)", () => {
  // Sonnet 450/call, haiku rung 150/call, cap 1000. Calls 1–3 on sonnet
  // (450, 900, 1350); the gate before call 4 reads 1350 ≥ 1000 and degrades.
  // The second breach is defined at a TURN boundary, not an accrual
  // boundary: every remaining call of the turn in which the degrade fired is
  // the rung's, however far past the cap it accrues. (Under the accrual
  // definition the rung's first priced response tripped the gate before
  // call 5 and severed the turn — degrade collapsed to one call, then the
  // classified stop, indistinguishable from `stop` on any tool-using turn.)
  test("singleTurn: a tool loop that degrades mid-turn finishes on the rung — turn_end published, no run_failed", async () => {
    const primary = scriptedToolLoopAdapter("anthropic", USAGE, []); // always tool_use
    const rung = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "text"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    let text: string;
    try {
      text = await runChatLoop({
        model: SONNET,
        instructions: "test",
        _adapter: primary,
        _budgetDegradeAdapter: rung,
        tools: [noopTool()],
        permissionMode: "bypass",
        budget: { usdMicros: 1000, onExceed: { kind: "degrade", model: HAIKU } },
        singleTurn: true,
        seedMessages: [{ role: "user", content: "loop until told to stop" }],
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    expect(text).toBe("done");
    // Three primary calls, then EVERY remaining call of the turn on the rung
    // (call 4 tool_use at 1500 ≥ cap, call 5 the text at 1650 ≥ cap).
    expect(primary.requests).toHaveLength(3);
    expect(rung.requests).toHaveLength(2);
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses.map((r) => r.model)).toEqual([SONNET, SONNET, SONNET, HAIKU, HAIKU]);
    const failovers = seen.filter((e): e is ModelFailoverEvent => e.kind === "model_failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: SONNET, to: HAIKU, reason: "budget_degrade" });
    // The turn completed: turn_end on the bus, no classified failure.
    expect(seen.filter((e) => e.kind === "turn_end")).toHaveLength(1);
    expect(seen.some((e) => e.kind === "run_failed")).toBe(false);
    const lines = stderr.lines();
    expect(lines.some((l) => l.includes(`degrading ${SONNET}`))).toBe(true);
    expect(lines.some((l) => l.includes("ending the run"))).toBe(false);
  });

  test("REPL: the degraded turn completes on the rung, then the pre-turn gate stops cleanly (no run_failed)", async () => {
    const primary = scriptedToolLoopAdapter("anthropic", USAGE, []); // always tool_use
    const rung = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "text"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: SONNET,
        instructions: "test",
        _adapter: primary,
        _budgetDegradeAdapter: rung,
        tools: [noopTool()],
        permissionMode: "bypass",
        budget: { usdMicros: 1000, onExceed: { kind: "degrade", model: HAIKU } },
        input: interactiveStdin(runContext.eventBus, ["one", "two"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    // Turn 1 ran to completion on the rung; the pre-turn gate for turn 2 read
    // the over-cap spend on the degraded rung and ended the run cleanly —
    // the pre-0.6.0 REPL contract ("the degraded turn completes, clean stop
    // before the next turn"), now also true when the degrade fires mid-turn.
    expect(primary.requests).toHaveLength(3);
    expect(rung.requests).toHaveLength(2);
    expect(seen.filter((e) => e.kind === "turn_end")).toHaveLength(1);
    expect(seen.some((e) => e.kind === "run_failed")).toBe(false);
    expect(runContext.turnNumber).toBe(1);
    const lines = stderr.lines();
    expect(lines.some((l) => l.includes("degraded model also reached the cap"))).toBe(true);
  });
});

describe("runChatLoop — budget.scope (0.6.0 §7.12)", () => {
  const SESSION_TEST_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-budget-scope-"));
  let savedCostTracking: string | undefined;
  beforeAll(() => {
    // The seam under test persists cost_accrual WITHOUT the env-attached
    // tracker; make sure the environment does not attach one (the tracker
    // attaches only on the exact strings "1" / "true").
    savedCostTracking = process.env["CREWHAUS_COST_TRACKING"];
    process.env["CREWHAUS_COST_TRACKING"] = undefined;
  });
  afterAll(() => {
    if (savedCostTracking !== undefined) process.env["CREWHAUS_COST_TRACKING"] = savedCostTracking;
    rmSync(SESSION_TEST_ROOT, { recursive: true, force: true });
  });

  const runOnce = async (
    scope: "run" | "session" | undefined,
    resume: { sessionId: string } | undefined,
    script: ReadonlyArray<"tool" | "text">,
  ) => {
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, script);
    const runContext = createRunContext(
      resume !== undefined ? { sessionId: resume.sessionId } : {},
    );
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    let caught: unknown;
    try {
      caught = await runAndCatch(() =>
        runChatLoop({
          model: SONNET,
          instructions: "test",
          _adapter: adapter,
          tools: [noopTool()],
          permissionMode: "bypass",
          // Cap 1500: run A (3 calls = 1350) completes under it.
          budget: {
            usdMicros: 1500,
            onExceed: { kind: "stop" },
            ...(scope !== undefined ? { scope } : {}),
          },
          singleTurn: true,
          seedMessages: [{ role: "user", content: "hi" }],
          sessionRootDir: SESSION_TEST_ROOT,
          installSigintHandler: false,
          spinner: false,
          runContext,
          ...(resume !== undefined ? { resume } : {}),
        }),
      );
    } finally {
      stderr.restore();
    }
    return {
      sessionId: runContext.sessionId,
      caught,
      responses: seen.filter((e) => e.kind === "model_response").length,
      accruals: seen.filter((e) => e.kind === "cost_accrual").length,
    };
  };

  const persistedAccruals = (sessionId: string): number[] =>
    readFileSync(join(SESSION_TEST_ROOT, `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind?: string; payload?: { costUsdMicros?: number } })
      .filter((e) => e.kind === "cost_accrual")
      .map((e) => e.payload?.costUsdMicros ?? -1);

  test("scope: session persists per-call spend and seeds the meter on resume, so the cap bounds the conversation", async () => {
    // Run A: tool, tool, text → 3 × 450 = 1350 < 1500, completes.
    const a = await runOnce("session", undefined, ["tool", "tool", "text"]);
    expect(a.caught).toBeUndefined();
    expect(a.responses).toBe(3);
    // The spend is ON DISK even though CREWHAUS_COST_TRACKING is unset.
    expect(persistedAccruals(a.sessionId)).toEqual([450, 450, 450]);
    // Run B resumes the session: the meter is seeded with 1350, so the first
    // call runs (1350 < 1500 → 1800) and the gate before the second trips.
    const b = await runOnce("session", { sessionId: a.sessionId }, ["tool", "text"]);
    expect(b.responses).toBe(1);
    expect(b.caught).toBeInstanceOf(RunFailedError);
    expect((b.caught as RunFailedError).report.class).toBe("crewhaus_budget");
    expect((b.caught as RunFailedError).report.detail).toContain("$0.0018");
  });

  test("scope: run (the default) meters this process only — a resumed run starts from zero", async () => {
    const a = await runOnce(undefined, undefined, ["tool", "tool", "text"]);
    expect(a.caught).toBeUndefined();
    expect(a.responses).toBe(3);
    // Nothing persisted, nothing published: byte-identical to 0.5.x.
    expect(a.accruals).toBe(0);
    expect(persistedAccruals(a.sessionId)).toEqual([]);
    const b = await runOnce("run", { sessionId: a.sessionId }, ["tool", "text"]);
    expect(b.caught).toBeUndefined();
    expect(b.responses).toBe(2);
  });
});

describe("runChatLoop — pool-aware degrade (0.6.0 §7.12, sanctioned change §14(4))", () => {
  const poolAdapters = (entries: ReadonlyArray<readonly [string, ProviderAdapter]>) =>
    new Map<string, ProviderAdapter>(entries);

  test("degrade to a model OUTSIDE the roster forces the pre-resolved extra rung: model_route policy forced / reason budget_degrade, and NO model_failover", async () => {
    // Pool: sonnet (cheap) + opus (strong), heuristic. Turn 1 is the first
    // turn → hard → opus: 2250 ≥ cap 2000 → before turn 2 the breach forces
    // the haiku rung (off-roster, injected). Haiku accrues 150 → 2400; the
    // gate before turn 3 stops the run (degraded rung also at the cap).
    const cheap = pricedAdapter("anthropic", USAGE, "sonnet");
    const strong = pricedAdapter("anthropic", USAGE, "opus");
    const rung = pricedAdapter("anthropic", USAGE, "haiku");
    const sb = tmpScoreboard();
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: strong,
        modelPool: {
          candidates: [
            { model: SONNET, tags: ["cheap"] },
            { model: OPUS, tags: ["strong"] },
          ],
          policy: "heuristic",
        },
        _poolAdapters: poolAdapters([
          [SONNET, cheap],
          [OPUS, strong],
        ]),
        _scoreboard: sb,
        _budgetDegradeAdapter: rung,
        budget: { usdMicros: 2000, onExceed: { kind: "degrade", model: HAIKU } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three", "four"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ model: OPUS, policy: "heuristic", routeKey: "hard" });
    expect(routes[1]).toMatchObject({
      model: HAIKU,
      policy: "forced",
      reason: "budget_degrade",
    });
    // The band is kept on the forced decision (turn 2 is a non-first,
    // tool-less turn → easy), so the rung's arm is keyed on difficulty.
    expect(routes[1]?.routeKey).toBe("easy");
    // No adapter swap happened, so no failover is claimed.
    expect(seen.filter((e) => e.kind === "model_failover")).toHaveLength(0);
    // The rung served exactly one call; the cheap roster member never did.
    expect(rung.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    expect(cheap.requests).toHaveLength(0);
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses.map((r) => r.model)).toEqual([OPUS, HAIKU]);
    // The rung's outcome landed on its own arm.
    expect(sb.score("easy", HAIKU)?.n).toBe(1);
    // Honest stderr: a restriction, not a "degrading X → Y" swap line.
    const lines = stderr.lines();
    expect(lines.some((l) => l.includes("restricting model_pool to claude-haiku-4-5"))).toBe(true);
    expect(lines.some((l) => l.includes("degrading claude-opus-4-1"))).toBe(false);
    expect(lines.some((l) => l.includes("degraded model also reached the cap"))).toBe(true);
  });

  test("degrade to a ROSTER member binds that candidate (no extra adapter resolution)", async () => {
    const cheap = pricedAdapter("anthropic", USAGE, "sonnet");
    const strong = pricedAdapter("anthropic", USAGE, "opus");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: strong,
        modelPool: {
          candidates: [
            { model: SONNET, tags: ["cheap"] },
            { model: OPUS, tags: ["strong"] },
          ],
          // static → always the first declared (sonnet) — except the FORCED
          // lane, which must outrank the policy after the breach.
          policy: "static",
        },
        _poolAdapters: poolAdapters([
          [SONNET, cheap],
          [OPUS, strong],
        ]),
        _scoreboard: tmpScoreboard(),
        // Cap 400: sonnet's first call (450) breaches → degrade to opus, the
        // roster member (a deliberately perverse rung, so the forced pick is
        // distinguishable from static's own choice).
        budget: { usdMicros: 400, onExceed: { kind: "degrade", model: OPUS } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes.map((r) => [r.model, r.policy])).toEqual([
      [SONNET, "static"],
      [OPUS, "forced"],
    ]);
    expect(routes[1]?.reason).toBe("budget_degrade");
    expect(strong.requests).toHaveLength(1);
    expect(cheap.requests).toHaveLength(1);
    expect(seen.filter((e) => e.kind === "model_failover")).toHaveLength(0);
  });

  test("the forced rung outranks the misroute-escalation latch (a rung failure never escalates past the cap)", async () => {
    // The rung fails once with a recoverable error, then recovers. Escalation
    // would re-route to the strong (expensive) candidate; the budget lane
    // must keep the rung.
    let rungDown = true;
    const cheap = pricedAdapter("anthropic", USAGE, "sonnet");
    const strong = pricedAdapter("anthropic", USAGE, "opus");
    const rungRequests: ProviderRequest[] = [];
    const rung: ProviderAdapter = {
      providerId: "anthropic",
      features: {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      },
      estimateTokens: () => 0,
      stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
        rungRequests.push(req);
        return (async function* () {
          if (rungDown) {
            rungDown = false;
            const err = new Error("rung outage") as Error & { error: { type: string } };
            err.error = { type: "max_output_tokens" };
            throw err;
          }
          yield { kind: "message_start", usage: { input: 100, output: 0 } };
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "haiku" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: USAGE };
          yield { kind: "message_stop" };
        })();
      },
    };
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: strong,
        modelPool: {
          candidates: [
            { model: SONNET, tags: ["cheap"] },
            { model: OPUS, tags: ["strong"] },
          ],
          policy: "heuristic",
        },
        _poolAdapters: poolAdapters([
          [SONNET, cheap],
          [OPUS, strong],
        ]),
        _scoreboard: tmpScoreboard(),
        _budgetDegradeAdapter: rung,
        budget: { usdMicros: 2000, onExceed: { kind: "degrade", model: HAIKU } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    const routes = seen.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    // turn 1 opus; turn 2: rung fails, recovery re-enters NeedModel → rung again.
    expect(routes.map((r) => r.model)).toEqual([OPUS, HAIKU, HAIKU]);
    expect(routes.slice(1).every((r) => r.policy === "forced")).toBe(true);
    expect(rungRequests).toHaveLength(2);
    expect(strong.requests).toHaveLength(1);
  });
});

describe("runChatLoop — degrade under model_tiers collapses both tiers to the rung (0.6.0 §7.12)", () => {
  test("the swap takes effect (tier router bypassed) so the single model_failover it publishes is true", async () => {
    const fast = pricedAdapter("anthropic", USAGE, "haiku");
    const dflt = pricedAdapter("anthropic", USAGE, "opus");
    const rung = pricedAdapter("anthropic", USAGE, "sonnet");
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const stderr = captureStderr();
    try {
      await runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: dflt,
        modelTiers: { fast: HAIKU, default: OPUS },
        _tierAdapters: new Map<string, ProviderAdapter>([
          [HAIKU, fast],
          [OPUS, dflt],
        ]),
        _budgetDegradeAdapter: rung,
        // Turn 1 (first turn → default/opus, 2250) breaches cap 2000 → the
        // rung serves turn 2 (would have been fast/haiku: non-first, no
        // tools); 2700 ≥ 2000 on the degraded model stops before turn 3.
        budget: { usdMicros: 2000, onExceed: { kind: "degrade", model: SONNET } },
        input: interactiveStdin(runContext.eventBus, ["one", "two", "three", "four"]),
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses.map((r) => r.model)).toEqual([OPUS, SONNET]);
    expect(fast.requests).toHaveLength(0);
    expect(rung.requests).toHaveLength(1);
    // Exactly one tier decision (turn 1); turn 2 was served by the rung
    // without a tier pick, so no second `model_tier_route` is claimed.
    expect(seen.filter((e) => e.kind === "model_tier_route")).toHaveLength(1);
    const failovers = seen.filter((e): e is ModelFailoverEvent => e.kind === "model_failover");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ from: OPUS, to: SONNET, reason: "budget_degrade" });
  });
});

describe("runChatLoop — streaming modelLatencyMs excludes runTool spans (0.6.0 §7.9)", () => {
  test("the pool reward's latency is the model's own time; wall time stays on model_response.durationMs", async () => {
    // Streaming pool turn: call 1 emits a tool_use whose tool sleeps; call 2
    // returns text. The observation recorded for call 1 must be shorter
    // than that call's wall duration (the tool span is excluded), while the
    // tool-free call 2 records its wall span unchanged.
    const observations: Array<{
      readonly model: string;
      readonly obs: { readonly latencyMs: number; readonly success: boolean };
    }> = [];
    const spy: Scoreboard = {
      path: "(spy)",
      score: () => undefined,
      record(_routeKey, model, _reward, obs) {
        observations.push({ model, obs: { latencyMs: obs.latencyMs, success: obs.success } });
      },
      snapshot: () => [],
      compact: () => undefined,
    };
    const adapter = scriptedToolLoopAdapter("anthropic", USAGE, ["tool", "text"]);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: adapter,
      modelPool: { candidates: [{ model: SONNET, tags: ["cheap", "strong"] }], policy: "static" },
      _poolAdapters: new Map<string, ProviderAdapter>([[SONNET, adapter]]),
      _scoreboard: spy,
      tools: [noopTool({ delayMs: 40 })],
      permissionMode: "bypass",
      streaming: true,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "use the tool" }],
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    const responses = seen.filter((e): e is ModelResponseEvent => e.kind === "model_response");
    expect(responses).toHaveLength(2);
    expect(observations).toHaveLength(2);
    expect(observations.every((o) => o.obs.success)).toBe(true);
    // Call 1 ran a tool mid-stream: its wall duration includes the tool
    // span, its recorded latency does not.
    const wall1 = responses[0]?.durationMs ?? 0;
    const lat1 = observations[0]?.obs.latencyMs ?? Number.NaN;
    expect(lat1).toBeGreaterThanOrEqual(0);
    expect(lat1).toBeLessThan(wall1);
    // Call 2 ran no tool: nothing is deducted (latency ≤ wall, same instrument).
    const wall2 = responses[1]?.durationMs ?? 0;
    const lat2 = observations[1]?.obs.latencyMs ?? Number.NaN;
    expect(lat2).toBeGreaterThanOrEqual(0);
    expect(lat2).toBeLessThanOrEqual(wall2 + 1);
  });
});
