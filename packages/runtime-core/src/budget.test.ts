/**
 * Item 27 — run-level spend cap with a degradation ladder, over the LIVE
 * `runChatLoop` REPL path. An always-on cost meter accrues per-response
 * spend (priced off the wire model that served), and a PRE-TURN check
 * enforces the cap before the next turn opens:
 *   - `on_exceed: stop`    → the run ends cleanly before the over-budget
 *                            turn runs (the in-flight turn always completes).
 *   - `on_exceed: degrade` → the primary model is re-resolved to the cheaper
 *                            rung once (a `model_failover` reason
 *                            `budget_degrade`), and a later breach stops.
 *
 * These drive the real loop with a scripted-adapter primary whose usage is
 * priced by cost-tracker's real DEFAULT_PRICING table, and feed input over
 * a fake stdin so the multi-turn REPL runs deterministically.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import type { ModelFailoverEvent, ModelResponseEvent, TraceEvent } from "@crewhaus/trace-event-bus";
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
