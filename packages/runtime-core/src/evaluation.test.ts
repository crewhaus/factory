/**
 * Loop contract 0.4 (Batch B, G02) — the in-loop evaluation seam over the
 * LIVE `runChatLoop`, both `singleTurn` and REPL paths:
 *
 *  - the injected `evaluate` fires only at TURN COMPLETION (never on a
 *    tool-only intermediate iteration), receiving `{ finalText, messages,
 *    usage }` for exactly the attempt it grades;
 *  - one `eval_graded` trace event per grading pass (`retryIndex` 0..N)
 *    carrying score/threshold/verdict/graderType;
 *  - `on_fail: retry` re-runs the turn with the grader rationale appended
 *    as a synthetic corrective user message, hard-capped at `maxRetries`,
 *    with every re-run's REAL model calls metered into the run budget via
 *    the existing cost path;
 *  - `on_fail: halt` ends the run with the classified `run_failed`
 *    (class `"evaluation"`, exit 35) + `RunFailedError`;
 *  - `on_fail: note` records the failing verdict and moves on;
 *  - a grader crash fails OPEN (error event, turn stands), and an aborted
 *    (timed-out) turn is never graded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { RunFailedError } from "@crewhaus/errors";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type EvaluationTurn, type RunEvaluation, runChatLoop } from "./index";

// Route session-store/event-log writes to a per-file tmpdir so tests do
// not pollute `.crewhaus/sessions/` in the repo.
const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-evaluation-"));
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

type ScriptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/**
 * Scripted adapter cycling through pre-baked content-block arrays per call
 * (fixed usage 10 in / 5 out per response) and capturing every
 * ProviderRequest so tests can assert the corrective nudge reached the
 * model verbatim.
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

/** Adapter whose stream only rejects (SDK-shaped AbortError) once the
 *  request's signal aborts — how a hung provider behaves under a timer. */
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
          if (signal === undefined) return;
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        yield undefined as never;
      })();
    },
  };
  return { adapter, calls: () => calls };
}

/** Adapter with caller-chosen usage per response so cost-tracker's real
 *  DEFAULT_PRICING accrues a deterministic spend per model call. */
function pricedAdapter(
  providerId: ProviderId,
  usage: { input: number; output: number },
  text: string,
): ProviderAdapter {
  return {
    providerId,
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
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

const text = (t: string): ScriptBlock => ({ type: "text", text: t });
const echoUse = (id: string, msg = "hi"): ScriptBlock => ({
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

/**
 * Scripted evaluation gate: each grading call consumes the next entry
 * (`"throw"` crashes the grader; the last entry repeats). Stores a
 * SNAPSHOT of every `EvaluationTurn` it saw (messages copied, since the
 * runtime keeps mutating the live array).
 */
function evalGate(
  verdicts: ReadonlyArray<number | { score: number; rationale?: string } | "throw">,
  overrides?: Partial<Omit<RunEvaluation, "evaluate">>,
): { evaluation: RunEvaluation; turns: EvaluationTurn[]; calls: () => number } {
  const turns: EvaluationTurn[] = [];
  let i = 0;
  const evaluation: RunEvaluation = {
    threshold: 0.7,
    onFail: "retry",
    maxRetries: 1,
    graderType: "llm_judge",
    ...overrides,
    evaluate: async (turn) => {
      turns.push({ ...turn, messages: turn.messages.map((m) => ({ ...m })) });
      const v = verdicts[Math.min(i, verdicts.length - 1)] ?? 1;
      i += 1;
      if (v === "throw") throw new Error("judge model unreachable");
      return typeof v === "number" ? { score: v } : v;
    },
  };
  return { evaluation, turns, calls: () => i };
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
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-evaluation-run-"));
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
      instructions: "evaluation seam test",
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

/** Interactive fake stdin: writes one line per completed turn, then EOFs. */
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
    if (e.kind === "turn_end") setImmediate(writeNext);
  });
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

const evalEvents = (events: TraceEvent[]) => events.filter((e) => e.kind === "eval_graded");

// ---------------------------------------------------------------------------
// singleTurn path.
// ---------------------------------------------------------------------------

describe("G02 — in-loop evaluation (singleTurn)", () => {
  test("passing verdict: one eval_graded (retryIndex 0), no retry, answer returned", async () => {
    const { adapter, calls } = scriptedAdapter([[text("ok")]]);
    const gate = evalGate([0.9]);
    const { events, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("ok");
    expect(calls()).toBe(1);
    expect(gate.calls()).toBe(1);
    const graded = evalEvents(events);
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({
      kind: "eval_graded",
      score: 0.9,
      threshold: 0.7,
      verdict: "pass",
      graderType: "llm_judge",
      retryIndex: 0,
    });
  });

  test("evaluate receives finalText, the history, and the attempt's usage", async () => {
    const { adapter } = scriptedAdapter([[text("the answer")]]);
    const gate = evalGate([1]);
    await runSingleTurnCollecting({ _adapter: adapter, evaluation: gate.evaluation });
    expect(gate.turns).toHaveLength(1);
    const turn = gate.turns[0];
    if (turn === undefined) throw new Error("unreachable");
    expect(turn.finalText).toBe("the answer");
    // Seed user turn + terminal assistant turn are both visible.
    expect(turn.messages[0]).toMatchObject({ role: "user", content: "go" });
    expect(turn.messages[turn.messages.length - 1]?.role).toBe("assistant");
    // One model call at 10 in / 5 out.
    expect(turn.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreate: 0 });
  });

  test("tool-only iterations are never graded: evaluation fires once, at turn completion, with aggregated usage", async () => {
    const { adapter, calls } = scriptedAdapter([[echoUse("t1")], [text("final answer")]]);
    const gate = evalGate([1]);
    const { events, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      tools: [echoTool()],
      evaluation: gate.evaluation,
    });
    expect(result).toBe("final answer");
    expect(calls()).toBe(2); // tool iteration + final text
    expect(gate.calls()).toBe(1); // ONE grade despite two model calls
    expect(evalEvents(events)).toHaveLength(1);
    const turn = gate.turns[0];
    if (turn === undefined) throw new Error("unreachable");
    expect(turn.finalText).toBe("final answer");
    // Usage aggregated across BOTH main-turn model calls of the attempt.
    expect(turn.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheCreate: 0 });
  });

  test("on_fail retry: rationale becomes a synthetic corrective message and the re-run is re-graded", async () => {
    const { adapter, calls, reqs } = scriptedAdapter([[text("draft")], [text("better")]]);
    const gate = evalGate([{ score: 0.2, rationale: "too short" }, 0.9], { maxRetries: 2 });
    const { events, logged, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("better"); // the RETRY attempt's answer is what returns
    expect(calls()).toBe(2);
    expect(gate.calls()).toBe(2);
    const graded = evalEvents(events);
    expect(graded).toHaveLength(2);
    expect(graded[0]).toMatchObject({ verdict: "fail", retryIndex: 0, score: 0.2 });
    expect(graded[1]).toMatchObject({ verdict: "pass", retryIndex: 1, score: 0.9 });
    // The corrective nudge is event-logged as a SYNTHETIC user message…
    const synthetic = logged.filter(
      (l) =>
        l.kind === "user_message" &&
        l.payload?.["synthetic"] === true &&
        String(l.payload?.["content"]).includes("too short"),
    );
    expect(synthetic).toHaveLength(1);
    expect(String(synthetic[0]?.payload?.["content"])).toContain("[evaluation failed");
    // …and the retry's model call actually SAW it as the last user message.
    const retryReq = reqs[1];
    if (retryReq === undefined) throw new Error("unreachable");
    const lastUser = [...retryReq.messages].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content)).toContain("Grader feedback: too short");
    // The graded turn saw the corrective message in its history view.
    expect(
      gate.turns[1]?.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("too short"),
      ),
    ).toBe(true);
  });

  test("retry cap: maxRetries bounds re-runs; exhausted retries leave the last attempt standing", async () => {
    const { adapter, calls } = scriptedAdapter([[text("attempt")]]);
    const gate = evalGate([0], { maxRetries: 2 }); // every grade fails
    const { events, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined(); // exhausted retries do NOT fail the run
    expect(result).toBe("attempt");
    expect(calls()).toBe(3); // original + 2 retries, hard-capped
    expect(gate.calls()).toBe(3);
    const graded = evalEvents(events);
    expect(graded.map((e) => (e.kind === "eval_graded" ? e.retryIndex : -1))).toEqual([0, 1, 2]);
    expect(
      graded.every((e) => e.kind === "eval_graded" && e.verdict === "fail" && e.score === 0),
    ).toBe(true);
  });

  test("maxRetries 0 with on_fail retry grades once and never re-runs", async () => {
    const { adapter, calls } = scriptedAdapter([[text("only")]]);
    const gate = evalGate([0], { maxRetries: 0 });
    const { events, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("only");
    expect(calls()).toBe(1);
    expect(evalEvents(events)).toHaveLength(1);
  });

  test("on_fail halt: classified run_failed (class evaluation, exit 35) + RunFailedError", async () => {
    const { adapter, calls } = scriptedAdapter([[text("bad answer")]]);
    const gate = evalGate([{ score: 0.4, rationale: "misses the requirement" }], {
      onFail: "halt",
    });
    const { events, logged, caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("evaluation");
    expect(caught.report.exitCode).toBe(35);
    expect(caught.report.title).toBe("in-loop evaluation gate failed");
    expect(caught.report.detail).toContain("0.40");
    expect(caught.report.detail).toContain("0.7 threshold");
    expect(caught.report.detail).toContain("misses the requirement");
    expect(caught.report.remediation).toContain("evaluation.threshold");
    expect(calls()).toBe(1); // halt never re-runs the turn
    const graded = evalEvents(events);
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({ verdict: "fail", retryIndex: 0 });
    const runFailed = events.filter((e) => e.kind === "run_failed");
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ class: "evaluation", exitCode: 35 });
    expect(logged.filter((l) => l.kind === "run_failed")).toHaveLength(1);
  });

  test("on_fail note: the failing verdict is recorded and the run continues untouched", async () => {
    const { adapter, calls } = scriptedAdapter([[text("meh")]]);
    const gate = evalGate([0.1], { onFail: "note" });
    const { events, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("meh");
    expect(calls()).toBe(1); // no retry
    const graded = evalEvents(events);
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({ verdict: "fail", retryIndex: 0, score: 0.1 });
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
  });

  test("a grader crash fails OPEN: error event, no eval_graded, the turn stands", async () => {
    const { adapter, calls } = scriptedAdapter([[text("fine")]]);
    const gate = evalGate(["throw"], { onFail: "halt" }); // even halt cannot fire on a crash
    const { events, logged, caught, result } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    expect(result).toBe("fine");
    expect(calls()).toBe(1);
    expect(evalEvents(events)).toHaveLength(0);
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
    const errors = logged.filter(
      (l) =>
        l.kind === "error" && String(l.payload?.["message"]).includes("evaluation grader failed"),
    );
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.payload?.["message"])).toContain("judge model unreachable");
  });

  test("graderType stamps through verbatim and the event rides the run envelope", async () => {
    const { adapter } = scriptedAdapter([[text("has needle")]]);
    const gate = evalGate([1], { graderType: "contains", threshold: 1 });
    const { events } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    const graded = evalEvents(events);
    expect(graded).toHaveLength(1);
    const ev = graded[0];
    if (ev?.kind !== "eval_graded") throw new Error("unreachable");
    expect(ev.graderType).toBe("contains");
    expect(ev.threshold).toBe(1);
    expect(ev.score).toBe(1);
    expect(typeof ev.runId).toBe("string");
    expect(typeof ev.sessionId).toBe("string");
    expect(typeof ev.timestamp).toBe("string");
    expect(ev.turnNumber).toBe(1);
  });

  test("a non-finite score is treated as 0 (fail), never published as NaN", async () => {
    const { adapter } = scriptedAdapter([[text("x")]]);
    const gate = evalGate([Number.NaN], { onFail: "note" });
    const { events, caught } = await runSingleTurnCollecting({
      _adapter: adapter,
      evaluation: gate.evaluation,
    });
    expect(caught).toBeUndefined();
    const graded = evalEvents(events);
    expect(graded).toHaveLength(1);
    expect(graded[0]).toMatchObject({ score: 0, verdict: "fail" });
  });

  test("no evaluation option: zero eval_graded events, byte-identical run (regression pin)", async () => {
    const { adapter, calls } = scriptedAdapter([[text("plain")]]);
    const { events, caught, result } = await runSingleTurnCollecting({ _adapter: adapter });
    expect(caught).toBeUndefined();
    expect(result).toBe("plain");
    expect(calls()).toBe(1);
    expect(evalEvents(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// REPL path.
// ---------------------------------------------------------------------------

describe("G02 — in-loop evaluation (REPL)", () => {
  test("a failing turn retries mid-session, then the session continues", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-evaluation-repl-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const { adapter, calls } = scriptedAdapter([[text("draft")], [text("better")]]);
    const gate = evalGate([{ score: 0.3, rationale: "be specific" }, 0.9]);
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: rootDir,
      input: interactiveStdin(runContext.eventBus, ["hi"]),
      installSigintHandler: false,
      spinner: false,
      evaluation: gate.evaluation,
    });
    const logged = readSessionLines(rootDir);
    rmSync(rootDir, { recursive: true, force: true });
    expect(result).toBe(""); // clean REPL exit
    expect(calls()).toBe(2); // original + one evaluation retry
    const graded = evalEvents(events);
    expect(graded).toHaveLength(2);
    expect(graded[0]).toMatchObject({ verdict: "fail", retryIndex: 0 });
    expect(graded[1]).toMatchObject({ verdict: "pass", retryIndex: 1 });
    expect(events.filter((e) => e.kind === "turn_end")).toHaveLength(1); // still ONE user turn
    const synthetic = logged.filter(
      (l) =>
        l.kind === "user_message" &&
        l.payload?.["synthetic"] === true &&
        String(l.payload?.["content"]).includes("be specific"),
    );
    expect(synthetic).toHaveLength(1);
  });

  test("on_fail halt is terminal in REPL mode too", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-evaluation-repl-halt-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const { adapter } = scriptedAdapter([[text("nope")]]);
    const gate = evalGate([0], { onFail: "halt" });
    let caught: unknown;
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: adapter,
        runContext,
        sessionRootDir: rootDir,
        input: interactiveStdin(runContext.eventBus, ["hi", "never reached"]),
        installSigintHandler: false,
        spinner: false,
        evaluation: gate.evaluation,
      });
    } catch (err) {
      caught = err;
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
    expect(caught).toBeInstanceOf(RunFailedError);
    if (!(caught instanceof RunFailedError)) return;
    expect(caught.report.class).toBe("evaluation");
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(1);
  });

  test("every evaluation retry is metered into the run budget via the existing cost path", async () => {
    // claude-sonnet-4-6 pricing: 100 in + 10 out = 450 micros per response.
    // Cap 1000 micros. WITH an always-failing gate (maxRetries 2), turn 1
    // makes 3 model calls = 1350 micros ≥ 1000, so the pre-turn gate stops
    // the run before turn 2 — proof the retries accrued. The control run
    // (no evaluation) spends only 450 before turn 2, so both turns run.
    const run = async (evaluation: RunEvaluation | undefined) => {
      const runContext = createRunContext();
      const events: TraceEvent[] = [];
      runContext.eventBus.subscribe((e) => {
        events.push(e);
      });
      const stderr = captureStderr();
      try {
        await runChatLoop({
          model: "claude-sonnet-4-6",
          instructions: "t",
          _adapter: pricedAdapter("anthropic", { input: 100, output: 10 }, "ok"),
          budget: { usdMicros: 1000, onExceed: { kind: "stop" } },
          input: interactiveStdin(runContext.eventBus, ["one", "two"]),
          installSigintHandler: false,
          spinner: false,
          runContext,
          ...(evaluation !== undefined ? { evaluation } : {}),
        });
      } finally {
        stderr.restore();
      }
      return {
        responses: events.filter((e) => e.kind === "model_response").length,
        turns: events.filter((e) => e.kind === "turn_end").length,
        stderr: stderr.lines(),
      };
    };

    const gated = await run(evalGate([0], { maxRetries: 2 }).evaluation);
    expect(gated.responses).toBe(3); // 1 turn × (original + 2 retries)
    expect(gated.turns).toBe(1); // turn 2 was budget-gated
    expect(gated.stderr.some((l) => l.includes("[budget]") && l.includes("ending the run"))).toBe(
      true,
    );

    const control = await run(undefined);
    expect(control.responses).toBe(2); // both offered turns ran under the cap
    expect(control.turns).toBe(2);
  });

  test("an aborted (timed-out) turn is never graded", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-evaluation-repl-timeout-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const input = new PassThrough();
    input.write("hi\n");
    input.end();
    const { adapter, calls } = hangingAdapter();
    const gate = evalGate([1]);
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: rootDir,
      input,
      turnTimeoutMs: 120,
      evaluation: gate.evaluation,
    });
    rmSync(rootDir, { recursive: true, force: true });
    expect(result).toBe(""); // the session survived the timed-out turn
    expect(calls()).toBe(1);
    expect(gate.calls()).toBe(0); // the aborted turn never reached the grader
    expect(evalEvents(events)).toHaveLength(0);
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
  });
});
