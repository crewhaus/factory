/**
 * 0.6.0 (design §6.2, §7.12, §8.1 — PR 2 "judge metering") over the LIVE
 * `runChatLoop`:
 *
 *  - the in-loop `evaluation:` grader receives the RUN bus on every
 *    `EvaluationTurn`, and a judge that publishes on it (role `"judge"`) is
 *    counted by the always-on budget meter — the spec's "judge calls are
 *    metered into the run budget" promise, made true;
 *  - `eval_graded` carries the attribution: the graded arm's wire `model`,
 *    the grader-reported `judgeModel` / `judgeCostUsdMicros`, and
 *    `reason: "judge_share_exhausted"` once auxiliary spend reaches
 *    `budget.judgeShare` × cap (default 0.3) — while the judge keeps judging
 *    under the total cap;
 *  - compaction side-calls publish `model_request`/`model_response` with
 *    `role: "compaction"`, so they are priced and metered too;
 *  - a caller-supplied `budgetMeter` spans several loops (the workflow
 *    shape's run-spanning cap): spend in loop 1 stops loop 2 at the cap.
 *
 * Scripted adapters, real bus, real cost-tracker pricing — no `mock.module`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createCostTracker } from "@crewhaus/cost-tracker";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { createRunContext } from "@crewhaus/run-context";
import type {
  EvalGradedEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { DEFAULT_JUDGE_SHARE, type EvaluationTurn, type RunEvaluation, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-judge-metering-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

/** Opus-4: $15/M input → 100_000 input tokens = 1_500_000 micros ($1.50). */
const OPUS = "claude-opus-4";

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

/**
 * A grader standing in for the compiled `judge({ …, bus })` closure: it
 * publishes ONE judge-attributed model_response on the turn's bus (what
 * eval-judge's metering seam does) sized by `judgeInputTokens`, reports the
 * judge's wire model + priced spend the way the emitted closure does, and
 * returns the scripted verdicts in order.
 */
function judgingGate(
  verdicts: ReadonlyArray<number>,
  judgeInputTokens: number,
  overrides?: Partial<Omit<RunEvaluation, "evaluate">>,
): { evaluation: RunEvaluation; turns: EvaluationTurn[] } {
  const turns: EvaluationTurn[] = [];
  let i = 0;
  const evaluation: RunEvaluation = {
    threshold: 0.7,
    onFail: "retry",
    maxRetries: 1,
    graderType: "llm_judge",
    ...overrides,
    evaluate: async (turn) => {
      turns.push(turn);
      const env = turn.bus.envelope();
      turn.bus.publish({
        ...env,
        kind: "model_request",
        model: OPUS,
        provider: "anthropic",
        messageCount: 1,
        toolCount: 1,
        streaming: false,
        role: "judge",
      });
      turn.bus.publish({
        ...turn.bus.envelope(),
        spanId: env.spanId,
        kind: "model_response",
        model: OPUS,
        provider: "anthropic",
        stopReason: "tool_use",
        usage: { input: judgeInputTokens, output: 0 },
        durationMs: 1,
        role: "judge",
      });
      const score = verdicts[Math.min(i, verdicts.length - 1)] ?? 1;
      i += 1;
      return {
        score,
        rationale: "scripted",
        judge: { model: OPUS, costUsdMicros: judgeInputTokens * 15 },
      };
    },
  };
  return { evaluation, turns };
}

async function runAndCatch(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

const graded = (events: TraceEvent[]): EvalGradedEvent[] =>
  events.filter((e): e is EvalGradedEvent => e.kind === "eval_graded");

describe("runChatLoop — judge spend on the run bus is metered into budget (0.6.0 §6.2)", () => {
  test("the evaluate fn receives the run bus; a judge publishing on it pushes the run over the cap so the retry is stopped", async () => {
    // Main turn: 1000 tokens of opus = 15_000 micros. Judge: 100_000 tokens =
    // 1_500_000 micros, over the $1 cap. Grade fails → on_fail retry → the
    // per-call gate before the retry's model call reads the judge's spend.
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "draft");
    const { evaluation, turns } = judgingGate([0], 100_000);
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
          model: OPUS,
          instructions: "test",
          _adapter: adapter,
          permissionMode: "bypass",
          budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
          evaluation,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
    }
    // The grader saw the RUN's bus, not a private one.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.bus).toBe(runContext.eventBus);
    // The judge's spend stopped the retry: one main call, then the classified stop.
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("crewhaus_budget");
    expect(caught.report.exitCode).toBe(EXIT_CODES.crewhaus_budget);
    expect(adapter.requests).toHaveLength(1);
    // The judge's events are on the run bus with the role.
    const judgeResponses = seen.filter(
      (e): e is ModelResponseEvent => e.kind === "model_response" && e.role === "judge",
    );
    expect(judgeResponses).toHaveLength(1);
    expect(judgeResponses[0]?.model).toBe(OPUS);
  });

  test("control: the same judge WITHOUT bus spend leaves the retry under the cap", async () => {
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "draft");
    const { evaluation } = judgingGate([0, 1], 0);
    const runContext = createRunContext();
    const caught = await runAndCatch(() =>
      runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: adapter,
        permissionMode: "bypass",
        budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
        evaluation,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        installSigintHandler: false,
        spinner: false,
        runContext,
      }),
    );
    expect(caught).toBeUndefined();
    // Original attempt + one retry both ran.
    expect(adapter.requests).toHaveLength(2);
  });
});

describe("runChatLoop — eval_graded attribution + judge_share_exhausted (0.6.0 §6.2, §8.1)", () => {
  test("eval_graded carries the graded arm's wire model, the judge model and its priced spend", async () => {
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "fine answer");
    const { evaluation } = judgingGate([1], 1000);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const caught = await runAndCatch(() =>
      runChatLoop({
        model: OPUS,
        instructions: "test",
        _adapter: adapter,
        permissionMode: "bypass",
        budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
        evaluation,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        installSigintHandler: false,
        spinner: false,
        runContext,
      }),
    );
    expect(caught).toBeUndefined();
    const g = graded(seen);
    expect(g).toHaveLength(1);
    expect(g[0]?.verdict).toBe("pass");
    expect(g[0]?.model).toBe(OPUS);
    expect(g[0]?.judgeModel).toBe(OPUS);
    expect(g[0]?.judgeCostUsdMicros).toBe(15_000);
    // 15_000 judge micros < 300_000 share (0.3 × $1): no signal.
    expect("reason" in (g[0] ?? {})).toBe(false);
  });

  test("once auxiliary spend reaches judge_share × cap the grade carries reason judge_share_exhausted, one [budget] notice prints, and judging continues under the total cap", async () => {
    // Cap $10, default share 0.3 → $3. Judge call = 100_000 opus tokens =
    // $1.50: grade 0 is under the share (1.5 < 3), grade 1 (retry) reaches
    // it (3.0 ≥ 3). Total spend stays well under $10, so nothing stops.
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "draft");
    const { evaluation } = judgingGate([0, 0], 100_000, { maxRetries: 1 });
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
          model: OPUS,
          instructions: "test",
          _adapter: adapter,
          permissionMode: "bypass",
          budget: { usdMicros: 10_000_000, onExceed: { kind: "stop" } },
          evaluation,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
    }
    expect(caught).toBeUndefined();
    expect(DEFAULT_JUDGE_SHARE).toBe(0.3);
    const g = graded(seen);
    expect(g).toHaveLength(2);
    expect("reason" in (g[0] ?? {})).toBe(false);
    expect(g[1]?.reason).toBe("judge_share_exhausted");
    // The judge still ran on the retry (the existing retry path judges under
    // the total cap) and the run completed: two main calls, two judge calls.
    expect(adapter.requests).toHaveLength(2);
    expect(
      seen.filter(
        (e): e is ModelResponseEvent => e.kind === "model_response" && e.role === "judge",
      ),
    ).toHaveLength(2);
    const notices = stderr
      .lines()
      .filter((l) => l.includes("[budget]") && l.includes("judge_share_exhausted"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("0.3 of the $10.0000 cap");
  });

  test("an explicit judgeShare lowers the bar", async () => {
    // Share 0.1 of $10 = $1: a single $1.50 judge call exhausts it on grade 0.
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "fine");
    const { evaluation } = judgingGate([1], 100_000);
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
        _adapter: adapter,
        permissionMode: "bypass",
        budget: { usdMicros: 10_000_000, onExceed: { kind: "stop" }, judgeShare: 0.1 },
        evaluation,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        installSigintHandler: false,
        spinner: false,
        runContext,
      });
    } finally {
      stderr.restore();
    }
    expect(graded(seen)[0]?.reason).toBe("judge_share_exhausted");
  });

  test("no budget ⇒ no share, no reason, but the bus and attribution still flow", async () => {
    const adapter = pricedAdapter("anthropic", { input: 1000, output: 0 }, "fine");
    const { evaluation, turns } = judgingGate([1], 100_000_000);
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    await runChatLoop({
      model: OPUS,
      instructions: "test",
      _adapter: adapter,
      permissionMode: "bypass",
      evaluation,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    expect(turns[0]?.bus).toBe(runContext.eventBus);
    const g = graded(seen);
    expect(g[0]?.judgeModel).toBe(OPUS);
    expect("reason" in (g[0] ?? {})).toBe(false);
  });
});

describe("runChatLoop — judge_share is read at every budget gate, once per meter (0.6.0 §6.2, §7.12)", () => {
  /** Publish one priced judge-role response on `runContext`'s bus — what a
   *  workflow `kind: judge` gate running BETWEEN steps does on the shared
   *  meter — without any `evaluation:` in play. */
  const spendAsJudge = (runContext: ReturnType<typeof createRunContext>, inputTokens: number) => {
    const bus = runContext.eventBus;
    const env = bus.envelope();
    bus.publish({
      ...env,
      kind: "model_request",
      model: OPUS,
      provider: "anthropic",
      messageCount: 1,
      toolCount: 1,
      streaming: false,
      role: "judge",
    });
    bus.publish({
      ...bus.envelope(),
      spanId: env.spanId,
      kind: "model_response",
      model: OPUS,
      provider: "anthropic",
      stopReason: "end_turn",
      usage: { input: inputTokens, output: 0 },
      durationMs: 1,
      role: "judge",
    });
  };

  test("a run WITHOUT evaluation: still prints the one [budget] notice from its per-call gate once auxiliary spend on the shared meter has crossed the share", async () => {
    // Cap $10, default share 0.3 → $3. Judge spend of $4.50 lands on the
    // shared meter before the step runs; the step's first per-call gate
    // reads it and raises the notice. Total 4.5 + 1.5 < 10, so nothing stops.
    const runContext = createRunContext();
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    spendAsJudge(runContext, 300_000);
    expect(meter.getRunCost(runContext.runId).byRole.judge).toBe(4_500_000);
    const adapter = pricedAdapter("anthropic", { input: 100_000, output: 0 }, "step");
    const stderr = captureStderr();
    let caught: unknown;
    try {
      caught = await runAndCatch(() =>
        runChatLoop({
          model: OPUS,
          instructions: "step",
          _adapter: adapter,
          permissionMode: "bypass",
          budget: { usdMicros: 10_000_000, onExceed: { kind: "stop" } },
          budgetMeter: meter,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
      meter.unsubscribe();
    }
    expect(caught).toBeUndefined();
    expect(adapter.requests).toHaveLength(1);
    const notices = stderr
      .lines()
      .filter((l) => l.includes("[budget]") && l.includes("judge_share_exhausted"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("$4.5000 ≥ judge_share $3.0000");
    expect(notices[0]).toContain("judging continues under the total cap");
  });

  test("the notice prints ONCE per shared meter across several loops (a workflow's steps), not once per loop", async () => {
    const runContext = createRunContext();
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    spendAsJudge(runContext, 300_000);
    const step1 = pricedAdapter("anthropic", { input: 1_000, output: 0 }, "one");
    const step2 = pricedAdapter("anthropic", { input: 1_000, output: 0 }, "two");
    const budget = { usdMicros: 10_000_000, onExceed: { kind: "stop" as const } };
    const stderr = captureStderr();
    try {
      for (const adapter of [step1, step2]) {
        const caught = await runAndCatch(() =>
          runChatLoop({
            model: OPUS,
            instructions: "step",
            _adapter: adapter,
            permissionMode: "bypass",
            budget,
            budgetMeter: meter,
            singleTurn: true,
            seedMessages: [{ role: "user", content: "go" }],
            installSigintHandler: false,
            spinner: false,
            runContext,
          }),
        );
        expect(caught).toBeUndefined();
      }
    } finally {
      stderr.restore();
      meter.unsubscribe();
    }
    expect(step1.requests).toHaveLength(1);
    expect(step2.requests).toHaveLength(1);
    const notices = stderr
      .lines()
      .filter((l) => l.includes("[budget]") && l.includes("judge_share_exhausted"));
    expect(notices).toHaveLength(1);
  });

  test("control: under the share the gate prints nothing and the run is unaffected", async () => {
    const runContext = createRunContext();
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    spendAsJudge(runContext, 100_000); // $1.50 < $3 share
    const adapter = pricedAdapter("anthropic", { input: 1_000, output: 0 }, "step");
    const stderr = captureStderr();
    let caught: unknown;
    try {
      caught = await runAndCatch(() =>
        runChatLoop({
          model: OPUS,
          instructions: "step",
          _adapter: adapter,
          permissionMode: "bypass",
          budget: { usdMicros: 10_000_000, onExceed: { kind: "stop" } },
          budgetMeter: meter,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
      meter.unsubscribe();
    }
    expect(caught).toBeUndefined();
    expect(stderr.lines().filter((l) => l.includes("judge_share_exhausted"))).toHaveLength(0);
  });
});

describe("runChatLoop — compaction side-calls carry role compaction (0.6.0 §6.2)", () => {
  test("the pre-turn autocompact summary publishes model_request/model_response with role compaction on the run bus", async () => {
    // Force the pre-turn autocompact: many mid-size messages against a tiny
    // contextLimit (snip keeps 24 messages, still over threshold).
    const seed: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      seed.push({ role: "user", content: `question ${i} ${"x".repeat(200)}` });
      seed.push({ role: "assistant", content: `answer ${i} ${"y".repeat(200)}` });
    }
    seed.push({ role: "user", content: "go" });
    const main = pricedAdapter("anthropic", { input: 10, output: 5 }, "done");
    const compaction = pricedAdapter(
      "anthropic",
      { input: 4000, output: 200 },
      "a compact summary",
    );
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => {
      seen.push(e);
    });
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    const result = await runChatLoop({
      model: OPUS,
      instructions: "test",
      _adapter: main,
      _compactionAdapter: compaction,
      compactionModel: "claude-haiku-4-5",
      permissionMode: "bypass",
      seedMessages: seed,
      contextLimit: 200,
      singleTurn: true,
      installSigintHandler: false,
      spinner: false,
      runContext,
    });
    expect(result).toBe("done");
    expect(compaction.requests.length).toBeGreaterThanOrEqual(1);
    const compactionReqs = seen.filter(
      (e): e is ModelRequestEvent => e.kind === "model_request" && e.role === "compaction",
    );
    const compactionRes = seen.filter(
      (e): e is ModelResponseEvent => e.kind === "model_response" && e.role === "compaction",
    );
    expect(compactionReqs).toHaveLength(compaction.requests.length);
    expect(compactionRes).toHaveLength(compaction.requests.length);
    expect(compactionRes[0]?.model).toBe("claude-haiku-4-5");
    expect(compactionRes[0]?.provider).toBe("anthropic");
    expect(compactionRes[0]?.usage).toEqual({ input: 4000, output: 200 });
    // A cost tracker on the run bus prices it under the compaction role.
    const summary = meter.getRunCost(runContext.runId);
    expect(summary.byRole.compaction).toBeGreaterThan(0);
    expect(summary.byRole.primary).toBeGreaterThan(0);
    meter.unsubscribe();
    // The main-turn calls stay unattributed (primary).
    const mainRes = seen.filter(
      (e): e is ModelResponseEvent => e.kind === "model_response" && e.role === undefined,
    );
    expect(mainRes).toHaveLength(main.requests.length);
  });
});

describe("runChatLoop — a caller-supplied budgetMeter spans loops (0.6.0 §7.12, workflow run cap)", () => {
  test("spend in loop 1 is read by loop 2's gate: the second step stops at the cap", async () => {
    // Each loop: one opus call of 100_000 tokens = $1.50. Cap $1: loop 1's
    // pre-call gate reads 0 and runs (spend 1.5); loop 2's gate reads 1.5 ≥ 1
    // through the SHARED meter and stops classified.
    const runContext = createRunContext();
    const meter = createCostTracker(runContext.eventBus, { suppressEvents: true });
    const step1 = pricedAdapter("anthropic", { input: 100_000, output: 0 }, "step one");
    const step2 = pricedAdapter("anthropic", { input: 100_000, output: 0 }, "step two");
    const budget = { usdMicros: 1_000_000, onExceed: { kind: "stop" as const } };
    const stderr = captureStderr();
    let first: unknown;
    let second: unknown;
    try {
      first = await runAndCatch(() =>
        runChatLoop({
          model: OPUS,
          instructions: "step 1",
          _adapter: step1,
          permissionMode: "bypass",
          budget,
          budgetMeter: meter,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
      second = await runAndCatch(() =>
        runChatLoop({
          model: OPUS,
          instructions: "step 2",
          _adapter: step2,
          permissionMode: "bypass",
          budget,
          budgetMeter: meter,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
    } finally {
      stderr.restore();
    }
    expect(first).toBeUndefined();
    expect(step1.requests).toHaveLength(1);
    expect(second).toBeInstanceOf(RunFailedError);
    if (!(second instanceof RunFailedError)) return;
    expect(second.report.class).toBe("crewhaus_budget");
    expect(step2.requests).toHaveLength(0);
    // The shared meter outlives both loops (the loop never unsubscribes it):
    // it still reads the run's spend afterwards.
    expect(meter.getRunCost(runContext.runId).totalUsdMicros).toBe(1_500_000);
    meter.unsubscribe();
  });

  test("control: per-loop meters (no budgetMeter) let the second loop run — the cap bounded each loop", async () => {
    const runContext = createRunContext();
    const step1 = pricedAdapter("anthropic", { input: 100_000, output: 0 }, "step one");
    const step2 = pricedAdapter("anthropic", { input: 100_000, output: 0 }, "step two");
    const budget = { usdMicros: 1_000_000, onExceed: { kind: "stop" as const } };
    for (const adapter of [step1, step2]) {
      const caught = await runAndCatch(() =>
        runChatLoop({
          model: OPUS,
          instructions: "step",
          _adapter: adapter,
          permissionMode: "bypass",
          budget,
          singleTurn: true,
          seedMessages: [{ role: "user", content: "go" }],
          installSigintHandler: false,
          spinner: false,
          runContext,
        }),
      );
      expect(caught).toBeUndefined();
    }
    expect(step1.requests).toHaveLength(1);
    expect(step2.requests).toHaveLength(1);
  });
});
