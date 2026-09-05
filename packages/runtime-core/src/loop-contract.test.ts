/**
 * Loop contract 0.4 (Batch A) — runtime-core's four goals:
 *
 *  - G10 wall-clock stops: `deadlineMs` / `turnTimeoutMs` /
 *    `modelCallTimeoutMs` fire through the abort tree and end the run with
 *    a classified `run_failed` (class `"timeout"`, exit 34) where the stop
 *    is terminal — and mirror the SIGINT turn-abort semantics in REPL mode
 *    where it is not.
 *  - G27 loop-detection escalation ladder: warn (pre-0.4 behaviour) →
 *    justify (synthetic justification demand) → abort (ToolLoopLimit-style
 *    turn abort), plus `window`/`threshold` threading and the detector's
 *    near-duplicate tier.
 *  - G17 per-tool rate limits: `rateLimits` builds a token-bucket limiter
 *    at loop start; every configured tool acquires before dispatch.
 *  - G01 extended thinking: the `thinking` option lands on every MAIN-turn
 *    ProviderRequest (both fields for the effort form), never on the
 *    compaction side-call, with the max-tokens ceiling lifted when the
 *    budget crowds it out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { RunFailedError } from "@crewhaus/errors";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { buildTimeoutFailureReport, runChatLoop, timeoutAbortReason } from "./index";

// Route session-store/event-log writes to a per-file tmpdir so tests do
// not pollute `.crewhaus/sessions/` in the repo.
const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-loop-contract-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

const ADAPTER_FEATURES = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: true,
} as const;

/**
 * Adapter whose stream NEVER produces output; it only rejects (with the
 * SDK-shaped AbortError) once the request's `signal` aborts — exactly how a
 * hung provider call behaves under cancellation. This is what makes the
 * G10 timers observable end-to-end: the fired timer aborts the tree, the
 * signal reaches the stream, the loop sees the AbortError.
 */
function hangingAdapter(): { adapter: ProviderAdapter; calls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream: (req) => {
      calls++;
      const signal = req.signal;
      return (async function* () {
        await new Promise<never>((_, reject) => {
          const abort = (): void =>
            reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
          if (signal === undefined) return; // hang forever (no signal to honour)
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        yield undefined as never; // unreachable at runtime; keeps the function a generator
      })();
    },
  };
  return { adapter, calls: () => calls };
}

type ScriptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/**
 * Scripted adapter that cycles through pre-baked content-block arrays per
 * call (synthesising the canonical StreamEvent sequence) and CAPTURES every
 * ProviderRequest verbatim so tests can assert on `thinking` /
 * `reasoningEffort` / `maxTokens` / injected synthetic messages.
 */
function scriptedAdapter(scripts: ReadonlyArray<ReadonlyArray<ScriptBlock>>): {
  adapter: ProviderAdapter;
  calls: () => number;
  reqs: ProviderRequest[];
} {
  const reqs: ProviderRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream: (req) => {
      reqs.push(req);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const hasToolUse = content.some((b) => b.type === "tool_use");
      i++;
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
            yield { kind: "content_block_stop", index: idx } as const;
          }
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
  return { adapter, calls: () => i, reqs };
}

const text = (t: string): ScriptBlock => ({ type: "text", text: t });
const echoUse = (id: string, msg = "same"): ScriptBlock => ({
  type: "tool_use",
  id,
  name: "echo",
  input: { msg },
});

function echoTool() {
  return buildTool({
    name: "echo",
    description: "echo the message back",
    inputSchema: z.object({ msg: z.string() }).strict(),
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    execute: async (i) => i.msg,
  });
}

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readSessionLines(rootDir: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(rootDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(rootDir, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

/** Single-turn harness capturing the trace bus + session log + throw. */
async function runSingleTurnCollecting(
  opts: Omit<Parameters<typeof runChatLoop>[0], "model" | "instructions">,
): Promise<{ events: TraceEvent[]; logged: LoggedLine[]; caught: unknown; result?: string }> {
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-loop-contract-run-"));
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((ev) => {
    events.push(ev);
  });
  let caught: unknown;
  let result: string | undefined;
  try {
    result = await runChatLoop({
      model: "test-model",
      instructions: "loop contract test",
      runContext,
      sessionRootDir: rootDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      permissionMode: "bypass",
      ...opts,
    });
  } catch (err) {
    caught = err;
  }
  const logged = readSessionLines(rootDir);
  rmSync(rootDir, { recursive: true, force: true });
  return { events, logged, caught, ...(result !== undefined ? { result } : {}) };
}

// ---------------------------------------------------------------------------
// G10 — wall-clock stops.
// ---------------------------------------------------------------------------

describe("G10 — wall-clock stops (deadlineMs / turnTimeoutMs / modelCallTimeoutMs)", () => {
  test("modelCallTimeoutMs aborts a hung stream and halts with the classified timeout report", async () => {
    const { adapter, calls } = hangingAdapter();
    const { events, logged, caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      modelCallTimeoutMs: 120,
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("timeout");
    expect(caught.report.exitCode).toBe(34);
    expect(caught.report.title).toBe("model call wall-clock limit exceeded");
    expect(caught.report.detail).toContain("limits.model_call_timeout_ms (120ms)");
    expect(caught.report.remediation).toContain("limits.model_call_timeout_ms");
    expect(calls()).toBe(1);

    const runFailed = events.filter((ev) => ev.kind === "run_failed");
    expect(runFailed.length).toBe(1);
    if (runFailed[0]?.kind !== "run_failed") throw new Error("unreachable");
    expect(runFailed[0].class).toBe("timeout");
    expect(runFailed[0].exitCode).toBe(34);
    expect(logged.filter((l) => l.kind === "run_failed").length).toBe(1);
  });

  test("turnTimeoutMs bounds the whole turn and halts singleTurn runs with the turn report", async () => {
    const { adapter } = hangingAdapter();
    const { events, caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      turnTimeoutMs: 120,
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("timeout");
    expect(caught.report.title).toBe("turn wall-clock limit exceeded");
    expect(caught.report.detail).toContain("limits.turn_timeout_ms (120ms)");
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(1);
  });

  test("deadlineMs halts a singleTurn run with the run-deadline report", async () => {
    const { adapter } = hangingAdapter();
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      deadlineMs: 120,
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.title).toBe("run deadline exceeded");
    expect(caught.report.detail).toContain("limits.deadline_ms (120ms)");
    expect(caught.report.exitCode).toBe(34);
  });

  test("REPL: a deadline firing at an IDLE prompt interrupts the wait and halts classified", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-loop-contract-repl-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const input = new PassThrough(); // never sends a line — the run idles at `you> `
    const { adapter, calls } = scriptedAdapter([[text("unused")]]);
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        runContext,
        sessionRootDir: rootDir,
        input,
        deadlineMs: 150,
      });
    } catch (err) {
      caught = err;
    } finally {
      input.end();
      rmSync(rootDir, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("timeout");
    expect(caught.report.title).toBe("run deadline exceeded");
    expect(calls()).toBe(0); // fired while idle — no model call ever opened
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(1);
  });

  test("REPL: a turn timeout aborts the TURN like a first SIGINT — the session survives, no run_failed", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-loop-contract-repl-turn-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const input = new PassThrough();
    // Turn 1 hangs + times out; the already-seen EOF then ends the REPL at
    // the next prompt (lines written mid-turn would be dropped by readline,
    // so EOF — not an "exit" line — is how the session winds down here).
    input.write("hi\n");
    input.end();
    const { adapter, calls } = hangingAdapter();
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: rootDir,
      input,
      turnTimeoutMs: 120,
    });
    const logged = readSessionLines(rootDir);
    rmSync(rootDir, { recursive: true, force: true });

    expect(result).toBe(""); // clean REPL exit — the run did NOT fail
    expect(calls()).toBe(1);
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(0);
    const timeoutErrors = logged.filter(
      (l) => l.kind === "error" && l.payload?.["name"] === "TurnTimeout",
    );
    expect(timeoutErrors.length).toBe(1);
    expect(String(timeoutErrors[0]?.payload?.["message"])).toContain(
      "limits.turn_timeout_ms (120ms)",
    );
  });

  test("clean teardown: generous timers on a healthy run change nothing and leak nothing", async () => {
    const { adapter, calls, reqs } = scriptedAdapter([[text("ok")]]);
    const { events, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      deadlineMs: 60_000,
      turnTimeoutMs: 60_000,
      modelCallTimeoutMs: 60_000,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("ok");
    expect(calls()).toBe(1);
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(0);
    // No thinking configured → the request is byte-identical to pre-0.4.
    expect(reqs[0]?.thinking).toBeUndefined();
    expect(reqs[0]?.reasoningEffort).toBeUndefined();
  });

  test("timeoutAbortReason only recognises the branded reason; buildTimeoutFailureReport maps scopes", () => {
    const plain = new AbortController();
    plain.abort("user pressed ctrl-c");
    expect(timeoutAbortReason(plain.signal)).toBeUndefined();
    const live = new AbortController();
    expect(timeoutAbortReason(live.signal)).toBeUndefined();
    const branded = new AbortController();
    branded.abort({ crewhausTimeout: "turn", limitMs: 5000 });
    expect(timeoutAbortReason(branded.signal)).toEqual({ crewhausTimeout: "turn", limitMs: 5000 });

    const report = buildTimeoutFailureReport({ crewhausTimeout: "run", limitMs: 1000 });
    expect(report.class).toBe("timeout");
    expect(report.exitCode).toBe(34);
    expect(report.title).toBe("run deadline exceeded");
  });
});

// ---------------------------------------------------------------------------
// G27 — loop-detection escalation ladder + tuning.
// ---------------------------------------------------------------------------

/** Last string-content user message of a captured request's messages. */
function syntheticTexts(req: ProviderRequest | undefined): string[] {
  if (req === undefined) return [];
  return req.messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
}

describe("G27 — loop-detection escalation ladder", () => {
  test("justify: the second detection of a warned signature injects a justification demand", async () => {
    const { adapter, reqs, calls } = scriptedAdapter([
      [echoUse("t1")],
      [echoUse("t2")],
      [echoUse("t3")],
      [echoUse("t4")],
      [text("done")],
    ]);
    const { caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      loopDetection: { escalation: "justify" },
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("done");
    expect(calls()).toBe(5);
    // Call 4's request carries the one-time warning (detection tripped after
    // batch 3); call 5's carries the justification demand (repeat detection).
    expect(syntheticTexts(reqs[3]).some((t) => t.includes("possible loop detected"))).toBe(true);
    const demand = syntheticTexts(reqs[4]).find((t) => t.includes("MUST state"));
    expect(demand).toBeDefined();
    expect(demand).toContain('tool "echo"');
    expect(demand).toContain("justification");
    // The demand fires once per signature: no third synthetic message.
    expect(syntheticTexts(reqs[4]).filter((t) => t.startsWith("[runtime]")).length).toBe(2);
  });

  test("abort: the second detection aborts the turn ToolLoopLimit-style (no run_failed)", async () => {
    const { adapter, calls } = scriptedAdapter([
      [echoUse("t1")],
      [echoUse("t2")],
      [echoUse("t3")],
      [echoUse("t4")],
      [text("never reached")],
    ]);
    const { events, logged, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      loopDetection: { escalation: "abort" },
    });
    expect(caught).toBeUndefined();
    expect(result).toBe(""); // turn aborted after the 4th call's batch — no final text
    expect(calls()).toBe(4);
    const loopAborts = logged.filter(
      (l) => l.kind === "error" && l.payload?.["name"] === "ToolLoopAbort",
    );
    expect(loopAborts.length).toBe(1);
    expect(String(loopAborts[0]?.payload?.["message"])).toContain('tool "echo"');
    // Mirrors the maxToolIterations cap: a turn abort, not a terminal failure.
    expect(events.filter((ev) => ev.kind === "run_failed").length).toBe(0);
  });

  test("warn (default): repeat detections after the one-time warning stay quiet", async () => {
    const { adapter, reqs, calls } = scriptedAdapter([
      [echoUse("t1")],
      [echoUse("t2")],
      [echoUse("t3")],
      [echoUse("t4")],
      [text("done")],
    ]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
    });
    expect(caught).toBeUndefined();
    expect(calls()).toBe(5);
    // Exactly ONE synthetic loop message across the whole run (pre-0.4 dedup).
    expect(syntheticTexts(reqs[4]).filter((t) => t.startsWith("[runtime]")).length).toBe(1);
  });

  test("threshold threads: threshold 2 warns one batch earlier", async () => {
    const { adapter, reqs } = scriptedAdapter([[echoUse("t1")], [echoUse("t2")], [text("done")]]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      loopDetection: { threshold: 2 },
    });
    expect(caught).toBeUndefined();
    expect(syntheticTexts(reqs[2]).some((t) => t.includes("possible loop detected"))).toBe(true);
  });

  test("window threads: a 2-call window can never see 3 repeats — no warning", async () => {
    const { adapter, reqs, calls } = scriptedAdapter([
      [echoUse("t1")],
      [echoUse("t2")],
      [echoUse("t3")],
      [echoUse("t4")],
      [text("done")],
    ]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      loopDetection: { window: 2, threshold: 3 },
    });
    expect(caught).toBeUndefined();
    expect(calls()).toBe(5);
    for (const req of reqs) {
      expect(syntheticTexts(req).filter((t) => t.startsWith("[runtime]")).length).toBe(0);
    }
  });

  test("near-duplicate tier: number-churned inputs accumulate at reduced weight and warn", async () => {
    // Five same-tool calls whose msg differs only in a number: weighted
    // score 1 + 4×0.5 = 3 trips the default threshold on batch 5.
    const { adapter, reqs, calls } = scriptedAdapter([
      [echoUse("t1", "fetch page 1")],
      [echoUse("t2", "fetch page 2")],
      [echoUse("t3", "fetch page 3")],
      [echoUse("t4", "fetch page 4")],
      [echoUse("t5", "fetch page 5")],
      [text("done")],
    ]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
    });
    expect(caught).toBeUndefined();
    expect(calls()).toBe(6);
    const warning = syntheticTexts(reqs[5]).find((t) => t.includes("possible loop detected"));
    expect(warning).toBeDefined();
    expect(warning).toContain("near-identical inputs");
  });

  test("re-worded injected justifications do not hide a loop of identical operative calls (#386)", async () => {
    // A justification-gated tool: the runtime injects the field into the
    // advertised schema, and the model re-words it on every call. History
    // must record the OPERATIVE input, or the varying wording keeps the
    // signatures apart in both detector tiers and the loop is invisible.
    const gatedEcho = buildTool({
      name: "gecho",
      description: "echo the message back (justification-gated)",
      inputSchema: z.object({ msg: z.string() }).strict(),
      readOnly: true,
      concurrencySafe: true,
      requireJustification: true,
      execute: async (i) => i.msg,
    });
    const judge: import("@crewhaus/permission-engine").JustificationJudge = async () => ({
      allow: true,
      reason: "consistent with the session goal",
      judgeModel: "test-judge",
    });
    const gatedUse = (id: string, justification: string): ScriptBlock => ({
      type: "tool_use",
      id,
      name: "gecho",
      input: { msg: "same", justification },
    });
    const { adapter, reqs, calls } = scriptedAdapter([
      [gatedUse("t1", "echo the message the user asked for")],
      [gatedUse("t2", "repeating the echo to fulfil the request")],
      [gatedUse("t3", "the user's request still needs this echo")],
      [gatedUse("t4", "one more echo toward the stated goal")],
      [text("done")],
    ]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [gatedEcho],
      justificationJudge: judge,
    });
    expect(caught).toBeUndefined();
    expect(calls()).toBe(5);
    // Identical operative inputs trip the exact tier at the default
    // threshold 3 — the warning rides call 4's request.
    expect(syntheticTexts(reqs[3]).some((t) => t.includes("possible loop detected"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G17 — per-tool rate limits.
// ---------------------------------------------------------------------------

describe("G17 — per-tool rate limits (rateLimits option)", () => {
  const threeEchoesThenDone: ReadonlyArray<ReadonlyArray<ScriptBlock>> = [
    [echoUse("t1", "a"), echoUse("t2", "b"), echoUse("t3", "c")],
    [text("done")],
  ];

  test("a named bucket paces repeat calls at the configured rpm", async () => {
    const { adapter } = scriptedAdapter(threeEchoesThenDone);
    const t0 = performance.now();
    const { caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      // 600 rpm = 10 tokens/s refill; burst 1 → calls 2 and 3 each wait
      // ~100ms for a refill. Three calls therefore take >= ~200ms.
      rateLimits: { echo: { rpm: 600, burst: 1 } },
    });
    const elapsed = performance.now() - t0;
    expect(caught).toBeUndefined();
    expect(result).toBe("done");
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test("burst capacity admits an initial volley without pacing", async () => {
    const { adapter } = scriptedAdapter(threeEchoesThenDone);
    const t0 = performance.now();
    const { caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      rateLimits: { echo: { rpm: 600, burst: 3 } },
    });
    const elapsed = performance.now() - t0;
    expect(caught).toBeUndefined();
    expect(result).toBe("done");
    expect(elapsed).toBeLessThan(1500);
  });

  test("the '*' entry is the every-tool default bucket", async () => {
    const { adapter } = scriptedAdapter(threeEchoesThenDone);
    const t0 = performance.now();
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      rateLimits: { "*": { rpm: 600, burst: 1 } },
    });
    const elapsed = performance.now() - t0;
    expect(caught).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  test("tools without a named bucket or '*' default are not gated at all", async () => {
    const { adapter } = scriptedAdapter(threeEchoesThenDone);
    const t0 = performance.now();
    const { caught, result, logged } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      // A crippling limit — but on a DIFFERENT tool. echo must fly through
      // (the limiter is fail-closed, so this also proves the gate guard).
      rateLimits: { somethingElse: { rpm: 1, burst: 1 } },
    });
    const elapsed = performance.now() - t0;
    expect(caught).toBeUndefined();
    expect(result).toBe("done");
    expect(elapsed).toBeLessThan(1500);
    // No tool_result carried a rate-limit error.
    const errorResults = logged.filter(
      (l) => l.kind === "tool_result" && l.payload?.["isError"] === true,
    );
    expect(errorResults.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G01 — extended thinking on main-turn requests.
// ---------------------------------------------------------------------------

/**
 * 0.6.0 §4.4 (PR 9a) — the G01 pins rewritten PER CANDIDATE: under a
 * `model_pool`, the thinking fields and the thinking-aware ceiling are the
 * SERVING candidate's plan, not the run's boot constants. A candidate that
 * pins nothing inherits the run's `thinking`; one that pins its own
 * `thinking` / `maxTokens` gets its own budget, effort and lifted ceiling.
 * `policy: "static"` always serves the first declared candidate.
 */
describe("G01 per candidate — the serving plan's thinking lands on the request (0.6.0 §4.4)", () => {
  const OPUS = "claude-opus-4-8";
  const HAIKU = "claude-haiku-4-5";
  function pooled(
    first: {
      model: string;
      thinking?: { effort: "low" | "medium" | "high" } | { budgetTokens: number };
      maxTokens?: number;
    },
    runThinking?: { effort: "low" | "medium" | "high" },
  ) {
    const served = scriptedAdapter([[text("ok")]]);
    const other = scriptedAdapter([[text("other")]]);
    return {
      served,
      run: () =>
        runSingleTurnCollecting({
          _adapter: scriptedAdapter([[text("primary")]]).adapter,
          modelPool: {
            candidates: [
              {
                model: first.model,
                tags: ["a"],
                ...(first.thinking !== undefined ? { thinking: first.thinking } : {}),
                ...(first.maxTokens !== undefined ? { maxTokens: first.maxTokens } : {}),
              },
              { model: first.model === OPUS ? HAIKU : OPUS, tags: ["b"] },
            ],
            policy: "static",
          },
          _poolAdapters: new Map([
            [first.model, served.adapter],
            [first.model === OPUS ? HAIKU : OPUS, other.adapter],
          ]),
          settingsDir: null,
          ...(runThinking !== undefined ? { thinking: runThinking } : {}),
        }),
    };
  }

  test("a bare candidate inherits the run's thinking and the run's lifted ceiling", async () => {
    const { served, run } = pooled({ model: HAIKU }, { effort: "high" });
    const { caught } = await run();
    expect(caught).toBeUndefined();
    expect(served.reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 24576 });
    expect(served.reqs[0]?.reasoningEffort).toBe("high");
    expect(served.reqs[0]?.maxTokens).toBe(24576 + 8192);
  });

  test("a candidate pinning its own effort + max_tokens serves on ITS plan, not the run's", async () => {
    const { served, run } = pooled(
      { model: HAIKU, thinking: { effort: "low" }, maxTokens: 4096 },
      { effort: "high" },
    );
    const { caught } = await run();
    expect(caught).toBeUndefined();
    expect(served.reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(served.reqs[0]?.reasoningEffort).toBe("low");
    // 2048 < 4096: no lift, the candidate's declared ceiling.
    expect(served.reqs[0]?.maxTokens).toBe(4096);
  });

  test("a candidate budget that crowds out its max_tokens lifts ITS ceiling to budget + maxTokens", async () => {
    const { served, run } = pooled({
      model: OPUS,
      thinking: { budgetTokens: 6000 },
      maxTokens: 4096,
    });
    const { caught } = await run();
    expect(caught).toBeUndefined();
    expect(served.reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 6000 });
    expect(served.reqs[0]?.reasoningEffort).toBeUndefined();
    expect(served.reqs[0]?.maxTokens).toBe(6000 + 4096);
  });
});

describe("G01 — thinking option lands on every main-turn ProviderRequest", () => {
  test("budgetTokens form maps verbatim; no reasoningEffort; ceiling untouched when budget fits", async () => {
    const { adapter, reqs } = scriptedAdapter([[text("ok")]]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      thinking: { budgetTokens: 2048 },
    });
    expect(caught).toBeUndefined();
    expect(reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(reqs[0]?.reasoningEffort).toBeUndefined();
    expect(reqs[0]?.maxTokens).toBe(8192);
  });

  test("effort form sets BOTH fields: preset-converted thinking AND the pass-through effort", async () => {
    const { adapter, reqs } = scriptedAdapter([[text("ok")]]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      thinking: { effort: "low" },
    });
    expect(caught).toBeUndefined();
    expect(reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(reqs[0]?.reasoningEffort).toBe("low");
  });

  test("a budget that crowds out max_tokens lifts the per-request ceiling to budget + maxTokens", async () => {
    const { adapter, reqs } = scriptedAdapter([[text("ok")]]);
    const { caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      thinking: { effort: "high" }, // 24576 >= the 8192 default
    });
    expect(caught).toBeUndefined();
    expect(reqs[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 24576 });
    expect(reqs[0]?.reasoningEffort).toBe("high");
    expect(reqs[0]?.maxTokens).toBe(24576 + 8192);
  });

  test("thinking reaches EVERY main-turn call of a multi-cycle turn, but NEVER the compaction side-call", async () => {
    // Force the pre-turn autocompact: many mid-size messages against a tiny
    // contextLimit (snip keeps 24 messages, still over threshold).
    const seed: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 15; i++) {
      seed.push({ role: "user", content: `question ${i} ${"x".repeat(200)}` });
      seed.push({ role: "assistant", content: `answer ${i} ${"y".repeat(200)}` });
    }
    seed.push({ role: "user", content: "go" });
    const main = scriptedAdapter([[echoUse("t1", "one hop")], [text("done")]]);
    const compaction = scriptedAdapter([[text("a compact summary")]]);
    const { caught, result } = await runSingleTurnCollecting({
      _adapter: main.adapter,
      _compactionAdapter: compaction.adapter,
      tools: [echoTool()],
      seedMessages: seed,
      contextLimit: 200,
      thinking: { effort: "medium" },
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("done");
    // The compaction side-call ran and carried NO thinking fields.
    expect(compaction.calls()).toBeGreaterThanOrEqual(1);
    for (const req of compaction.reqs) {
      expect(req.thinking).toBeUndefined();
      expect(req.reasoningEffort).toBeUndefined();
    }
    // Both main-turn model calls (tool cycle + final) carried them.
    expect(main.calls()).toBe(2);
    for (const req of main.reqs) {
      expect(req.thinking).toEqual({ type: "enabled", budgetTokens: 8192 });
      expect(req.reasoningEffort).toBe("medium");
    }
  });
});
