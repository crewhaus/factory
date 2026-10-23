/**
 * 0.8.0 (design/0.8.0-provability-release.md §5.1, §5.3, §5.4) — the
 * provability gate over the LIVE `runChatLoop`, both `singleTurn` and REPL
 * paths:
 *
 *  - absent `provability` → the call sites run exactly what they ran before
 *    (no `provability_graded`, no footer, the same output);
 *  - one `provability_graded` trace event + event-log line per verification
 *    pass (`retryIndex` 0..N, `maxRetries`, `bundlePath`, `escalatedTo`),
 *    a `provability_evaluated` audit record when the sink is wired, and
 *    `onBundle` per pass;
 *  - `retry` re-runs the (evaluated) turn after a SYNTHETIC nudge composed
 *    from the bundle, capped at `maxRetries`; `halt` is the classified
 *    `run_failed` (class "provability", exit 37); `note` lets the answer
 *    stand; `escalate` re-runs on the pool's escalation rung, and without a
 *    pool warns once and behaves as `note`;
 *  - a verifier that THROWS fails open: `unverified`, the answer stands, a
 *    warning and an `error` event-log line;
 *  - only the standing pass is rendered; `footerTarget: "stream"` writes the
 *    footer after the answer, `"reply"` appends it to the returned text after
 *    a blank line, and neither puts it in the transcript;
 *  - ordering with `evaluation:` — an evaluation retry happens INSIDE a
 *    provability pass, and a provability retry re-runs the evaluated turn;
 *  - an aborted turn is never verified, and a verdict that settles after the
 *    abort is never acted on; a wall-clock limit that fires while the gate
 *    works is the classified `timeout` stop on the single-turn path (G10),
 *    and the named `TurnTimeout` line in the REPL; an escalation the abort
 *    stopped is recorded as `model_stage{skipped, cause: "aborted"}`, never
 *    as a dangling `escalatedTo`;
 *  - acceptance scenario A end to end with the REAL verifier: a citation of a
 *    page the run never fetched fails `grounded`, the nudge says so, the model
 *    fetches it, and the second answer passes.
 *
 * Scripted adapters, real bus, real event log — no `mock.module`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import { createLogger } from "@crewhaus/logging";
import {
  type ProofBundle,
  type ProofClaim,
  type ProofVerdict,
  type ProvabilityConfig,
  buildEvidenceIndex,
  bundleHash,
  evidenceFromMessages,
  renderBundleJson,
  renderFooter,
  renderNudge,
  verifyDocument,
} from "@crewhaus/provability";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type {
  ModelResponseEvent,
  ModelStageEvent,
  ProvabilityGradedEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { z } from "zod";
import {
  type JustificationAuditSink,
  type ProvabilityTurn,
  type RunEvaluation,
  type RunProvability,
  runChatLoop,
} from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-runtime-core-provability-"));
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
  thinking: false,
  web_search: false,
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
 * (the last repeats; usage 10 in / 5 out) and capturing every request, so a
 * test can assert what the model was shown on the re-run.
 */
function scriptedAdapter(
  scripts: ReadonlyArray<ReadonlyArray<ScriptBlock>>,
  providerId: ProviderId = "anthropic",
): ProviderAdapter & { readonly reqs: ProviderRequest[]; calls(): number } {
  const reqs: ProviderRequest[] = [];
  let i = 0;
  return {
    reqs,
    calls: () => i,
    providerId,
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
}

/** Adapter whose stream rejects (SDK-shaped AbortError) only once the request aborts. */
function hangingAdapter(): ProviderAdapter & { calls(): number } {
  let calls = 0;
  return {
    calls: () => calls,
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
}

/** An adapter whose stream throws `err` on its first `n` calls, then answers `reply`. */
function throwThenReplyAdapter(
  err: unknown,
  n: number,
  reply: string,
): ProviderAdapter & { readonly requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId: "anthropic",
    features: ADAPTER_FEATURES,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const idx = call;
      call += 1;
      return (async function* () {
        if (idx < n) throw err;
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

const text = (t: string): ScriptBlock => ({ type: "text", text: t });

// ---------------------------------------------------------------------------
// Bundles and the scripted gate.
// ---------------------------------------------------------------------------

const MET_CLAIM: ProofClaim = {
  index: 0,
  text: "The refund window is 14 days [1].",
  status: "met",
  best: "grounded",
  bindings: [
    {
      ref: "[1]",
      kind: "source",
      rung: "grounded",
      ok: true,
      origin: "https://acme.example/policy",
    },
  ],
};
const UNMET_CLAIM: ProofClaim = {
  index: 1,
  text: "Shipping is free worldwide [2].",
  status: "unmet",
  best: "cited",
  bindings: [
    {
      ref: "[2]",
      kind: "source",
      rung: "cited",
      ok: false,
      reason: "not_fetched",
      origin: "https://acme.example/shipping",
    },
  ],
};

/** A well-formed bundle at `grounded`: two claims, both met on a pass, one unmet on a fail. */
function bundleOf(
  verdict: ProofVerdict,
  over: Partial<Omit<ProofBundle, "bundleHash">> = {},
): ProofBundle {
  const failing = verdict === "fail";
  const core: Omit<ProofBundle, "bundleHash"> = {
    version: 1,
    level: "grounded",
    verdict,
    score: failing ? 0.5 : 1,
    threshold: 1,
    achieved: failing ? "cited" : "grounded",
    claims: failing
      ? [MET_CLAIM, UNMET_CLAIM]
      : [MET_CLAIM, { ...MET_CLAIM, index: 1, text: "Shipping is free worldwide [1]." }],
    claimCount: 2,
    met: failing ? 1 : 2,
    unmet: failing ? 1 : 0,
    assumptions: 0,
    sources: 1,
    judgeWaived: 0,
    retryIndex: 0,
    createdAt: "2026-10-22T12:00:00.000Z",
    ...over,
  };
  return { ...core, bundleHash: bundleHash(core) };
}

const PASS_FOOTER = "── provability · grounded ✓";
const FAIL_FOOTER = "── provability · grounded ✗";
const NUDGE_HEAD = "The provability gate did not accept your last answer.";

type Scripted = "pass" | "fail" | "throw" | ProofBundle | ((turn: ProvabilityTurn) => unknown);

type SeenTurn = Omit<ProvabilityTurn, "messages"> & {
  /** A SNAPSHOT (the runtime keeps mutating the live array). */
  readonly messages: Anthropic.MessageParam[];
  /** Texts of the messages `isSynthetic` flagged AT CALL TIME (copies lose the mark). */
  readonly synthetic: string[];
};

const messageText = (m: Anthropic.MessageParam): string =>
  typeof m.content === "string"
    ? m.content
    : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");

/**
 * Scripted provability gate: each verification consumes the next entry
 * (the last repeats). Real renderers by default (footer + nudge), so the
 * output and the nudge are what a compiled bundle would show.
 */
function provGate(
  verdicts: ReadonlyArray<Scripted>,
  overrides: Partial<Omit<RunProvability, "verify">> = {},
): {
  provability: RunProvability;
  turns: SeenTurn[];
  bundles: Array<{ bundle: ProofBundle; path: string | undefined }>;
  calls: () => number;
} {
  const turns: SeenTurn[] = [];
  const bundles: Array<{ bundle: ProofBundle; path: string | undefined }> = [];
  let i = 0;
  const provability: RunProvability = {
    level: "grounded",
    onFail: "retry",
    maxRetries: 1,
    threshold: 1,
    render: "footer",
    renderBundle: (bundle, path) => renderFooter(bundle, path !== undefined ? { path } : {}),
    nudge: renderNudge,
    onBundle: (bundle, path) => {
      bundles.push({ bundle, path });
    },
    ...overrides,
    verify: async (turn) => {
      turns.push({
        ...turn,
        messages: turn.messages.map((m) => ({ ...m })),
        synthetic: turn.messages.filter((m) => turn.isSynthetic?.(m) === true).map(messageText),
      });
      const v = verdicts[Math.min(i, verdicts.length - 1)] ?? "pass";
      i += 1;
      if (v === "throw") throw new Error("sandbox unreachable");
      if (v === "pass" || v === "fail") return bundleOf(v, { retryIndex: turn.retryIndex });
      if (typeof v === "function") return v(turn) as ProofBundle;
      return v;
    },
  };
  return { provability, turns, bundles, calls: () => i };
}

/** Scripted evaluation gate (every grade consumes the next score; the last repeats). */
function evalGate(scores: ReadonlyArray<number>, overrides: Partial<RunEvaluation> = {}) {
  let i = 0;
  const turns: Array<{ finalText: string; synthetic: string[] }> = [];
  const evaluation: RunEvaluation = {
    threshold: 0.7,
    onFail: "retry",
    maxRetries: 1,
    graderType: "llm_judge",
    ...overrides,
    evaluate: async (turn) => {
      turns.push({
        finalText: turn.finalText,
        synthetic: turn.messages.filter((m) => turn.isSynthetic?.(m) === true).map(messageText),
      });
      const score = scores[Math.min(i, scores.length - 1)] ?? 1;
      i += 1;
      return { score, rationale: "scripted" };
    },
  };
  return { evaluation, turns, calls: () => i };
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

/** Every line of every session JSONL under `rootDir` (the watch-me sibling excluded). */
function readSessionLines(rootDir: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(rootDir).filter(
    (f) => f.endsWith(".jsonl") && !f.endsWith(".events.jsonl"),
  )) {
    for (const line of readFileSync(join(rootDir, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

type Collected = {
  events: TraceEvent[];
  logged: LoggedLine[];
  caught: unknown;
  result?: string;
  stdout: string;
  warnings: string[];
  sessionId: string;
};

/** Single-turn harness capturing the bus, the session log, stdout, warnings and the throw. */
async function runSingle(
  opts: Omit<Parameters<typeof runChatLoop>[0], "model" | "instructions"> & {
    readonly model?: string;
  },
): Promise<Collected> {
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-run-"));
  const warnings: string[] = [];
  const runContext = createRunContext({
    logger: createLogger({ level: "warn", format: "json", sink: (l) => warnings.push(l) }),
  });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((ev) => {
    events.push(ev);
  });
  const chunks: string[] = [];
  let caught: unknown;
  let result: string | undefined;
  try {
    result = await runChatLoop({
      model: "test-model",
      instructions: "provability gate test",
      runContext,
      sessionRootDir: rootDir,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "what is the refund window?" }],
      permissionMode: "bypass",
      spinner: false,
      stdout: (s) => {
        chunks.push(s);
      },
      ...opts,
    });
  } catch (err) {
    caught = err;
  }
  const logged = readSessionLines(rootDir);
  rmSync(rootDir, { recursive: true, force: true });
  return {
    events,
    logged,
    caught,
    ...(result !== undefined ? { result } : {}),
    stdout: chunks.join(""),
    warnings,
    sessionId: runContext.sessionId,
  };
}

/** Interactive fake stdin: one line per completed turn, then EOF. */
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

/** REPL harness: `lines` typed at the prompt, everything captured. */
async function runRepl(
  lines: readonly string[],
  opts: Omit<Parameters<typeof runChatLoop>[0], "model" | "instructions"> & {
    readonly model?: string;
  },
): Promise<Collected> {
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-repl-"));
  const warnings: string[] = [];
  const runContext = createRunContext({
    logger: createLogger({ level: "warn", format: "json", sink: (l) => warnings.push(l) }),
  });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((ev) => {
    events.push(ev);
  });
  const chunks: string[] = [];
  let caught: unknown;
  let result: string | undefined;
  try {
    result = await runChatLoop({
      model: "test-model",
      instructions: "provability gate test",
      runContext,
      sessionRootDir: rootDir,
      input: interactiveStdin(runContext.eventBus, lines),
      installSigintHandler: false,
      spinner: false,
      stdout: (s) => {
        chunks.push(s);
      },
      ...opts,
    });
  } catch (err) {
    caught = err;
  }
  const logged = readSessionLines(rootDir);
  rmSync(rootDir, { recursive: true, force: true });
  return {
    events,
    logged,
    caught,
    ...(result !== undefined ? { result } : {}),
    stdout: chunks.join(""),
    warnings,
    sessionId: runContext.sessionId,
  };
}

const graded = (events: TraceEvent[]): ProvabilityGradedEvent[] =>
  events.filter((e): e is ProvabilityGradedEvent => e.kind === "provability_graded");
const gradedLines = (logged: LoggedLine[]): LoggedLine[] =>
  logged.filter((l) => l.kind === "provability_graded");
const lastUserText = (req: ProviderRequest | undefined): string => {
  const last = [...(req?.messages ?? [])].reverse().find((m) => m.role === "user");
  return last === undefined ? "" : messageText(last as Anthropic.MessageParam);
};
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
/**
 * The wall-clock limit every timer test arms: long enough that a scripted
 * turn (a few ms locally, ~20x that on a CI runner) completes inside it, so
 * the timer fires where the test puts the slow work — never earlier.
 */
const LIMIT_MS = 400;
/** Settles once `signal` aborts (never, without one). */
const whenAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
/**
 * A verification that IGNORES its signal — the real verifier takes none — so
 * its verdict settles only after the turn was aborted: deterministic, no sleep.
 */
const lateVerdict =
  (bundle: ProofBundle) =>
  (turn: ProvabilityTurn): Promise<ProofBundle> =>
    whenAborted(turn.signal).then(() => bundle);
/** A verification that settles only when the turn's signal aborts, then rejects (it honours the signal). */
const untilAborted = (turn: ProvabilityTurn): Promise<ProofBundle> =>
  new Promise<ProofBundle>((_, reject) => {
    const abort = (): void =>
      reject(Object.assign(new Error("verification aborted"), { name: "AbortError" }));
    if (turn.signal?.aborted === true) abort();
    else turn.signal?.addEventListener("abort", abort, { once: true });
  });

// ---------------------------------------------------------------------------
// Absent option.
// ---------------------------------------------------------------------------

describe("provability gate — absent", () => {
  test("no provability option: no provability_graded event or log line, no footer, the answer as before", async () => {
    const adapter = scriptedAdapter([[text("plain answer")]]);
    const run = await runSingle({ _adapter: adapter });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("plain answer");
    expect(adapter.calls()).toBe(1);
    expect(graded(run.events)).toHaveLength(0);
    expect(gradedLines(run.logged)).toHaveLength(0);
    expect(run.stdout).toBe("agent> plain answer\n");
    expect(run.stdout).not.toContain("provability");
  });
});

// ---------------------------------------------------------------------------
// singleTurn verdicts.
// ---------------------------------------------------------------------------

describe("provability gate — singleTurn verdicts", () => {
  test("pass: one provability_graded (retryIndex 0) and one event-log line; the verifier sees the completed turn", async () => {
    const adapter = scriptedAdapter([[text("The refund window is 14 days [1].")]]);
    const gate = provGate(["pass"]);
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("The refund window is 14 days [1].");
    expect(adapter.calls()).toBe(1);

    const events = graded(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "provability_graded",
      level: "grounded",
      verdict: "pass",
      score: 1,
      threshold: 1,
      achieved: "grounded",
      claims: 2,
      met: 2,
      unmet: 0,
      assumptions: 0,
      retryIndex: 0,
      maxRetries: 1,
      turnNumber: 1,
    });
    expect(events[0]?.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect("bundlePath" in (events[0] ?? {})).toBe(false);
    expect("escalatedTo" in (events[0] ?? {})).toBe(false);

    // The durable twin: the same summary minus the envelope, plus turnNumber.
    const lines = gradedLines(run.logged);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toEqual({
      level: "grounded",
      verdict: "pass",
      score: 1,
      threshold: 1,
      achieved: "grounded",
      claims: 2,
      met: 2,
      unmet: 0,
      assumptions: 0,
      retryIndex: 0,
      bundleHash: events[0]?.bundleHash,
      maxRetries: 1,
      turnNumber: 1,
    });

    // The verifier received the completed turn and where it sits.
    expect(gate.turns).toHaveLength(1);
    const turn = gate.turns[0];
    expect(turn?.finalText).toBe("The refund window is 14 days [1].");
    expect(turn?.messages[0]).toMatchObject({
      role: "user",
      content: "what is the refund window?",
    });
    expect(turn?.messages[turn.messages.length - 1]?.role).toBe("assistant");
    expect(turn?.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreate: 0 });
    expect(turn?.turnNumber).toBe(1);
    expect(turn?.retryIndex).toBe(0);
    expect(turn?.sessionId).toBe(run.sessionId);
    expect(turn?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof turn?.bus.publish).toBe("function");
    expect(turn?.synthetic).toEqual([]);
    expect(gate.bundles).toHaveLength(1);
  });

  test("fail → retry → pass: the re-run sees the synthetic nudge; the returned text is the retry's answer alone", async () => {
    const adapter = scriptedAdapter([[text("draft answer")], [text("better answer")]]);
    const gate = provGate(["fail", "pass"]);
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("better answer");
    expect(adapter.calls()).toBe(2);

    const events = graded(run.events);
    expect(events.map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["pass", 1],
    ]);
    // The second model call SAW the nudge as its last user message…
    const nudge = lastUserText(adapter.reqs[1]);
    expect(nudge).toContain(NUDGE_HEAD);
    expect(nudge).toContain("Shipping is free worldwide [2].");
    expect(nudge).toContain("ProvabilityPreflight");
    // …event-logged as SYNTHETIC, flagged synthetic to the second verification…
    const synthetic = run.logged.filter(
      (l) => l.kind === "user_message" && l.payload?.["synthetic"] === true,
    );
    expect(synthetic).toHaveLength(1);
    expect(String(synthetic[0]?.payload?.["content"])).toContain(NUDGE_HEAD);
    expect(gate.turns[1]?.synthetic).toEqual([nudge]);
    expect(gate.turns[1]?.retryIndex).toBe(1);
    // …and never part of what the run returns.
    expect(run.result).not.toContain(NUDGE_HEAD);
    // Only the STANDING pass is rendered: one ✓ footer, no ✗.
    expect(countOf(run.stdout, "── provability")).toBe(1);
    expect(run.stdout).toContain(PASS_FOOTER);
    expect(run.stdout).not.toContain(FAIL_FOOTER);
    expect(gate.bundles.map((b) => b.bundle.verdict)).toEqual(["fail", "pass"]);
  });

  test("retries exhausted: the last answer stands, one event per pass with an incrementing retryIndex, the ✗ footer once", async () => {
    const adapter = scriptedAdapter([[text("attempt")]]);
    const gate = provGate(["fail"], { maxRetries: 2 });
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeUndefined(); // exhausted retries do NOT fail the run
    expect(run.result).toBe("attempt");
    expect(adapter.calls()).toBe(3); // original + 2 retries, hard-capped
    const events = graded(run.events);
    expect(events.map((e) => [e.verdict, e.retryIndex, e.maxRetries])).toEqual([
      ["fail", 0, 2],
      ["fail", 1, 2],
      ["fail", 2, 2],
    ]);
    expect(gradedLines(run.logged).map((l) => l.payload?.["retryIndex"])).toEqual([0, 1, 2]);
    expect(countOf(run.stdout, "── provability")).toBe(1);
    expect(run.stdout).toContain(`${FAIL_FOOTER} · 1/2 claims · unmet: [2]`);
    expect(events.some((e) => e.kind === "provability_graded" && "escalatedTo" in e)).toBe(false);
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
  });

  test("maxRetries 0 verifies once and never re-runs; a non-finite cap reads as 0", async () => {
    for (const maxRetries of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const adapter = scriptedAdapter([[text("only")]]);
      const gate = provGate(["fail"], { maxRetries });
      const run = await runSingle({ _adapter: adapter, provability: gate.provability });
      expect(run.result).toBe("only");
      expect(adapter.calls()).toBe(1);
      expect(graded(run.events).map((e) => e.maxRetries)).toEqual([0]);
    }
  });

  test("halt: classified run_failed (class provability, exit 37) + RunFailedError, the ✗ footer written first", async () => {
    const adapter = scriptedAdapter([[text("bad answer")]]);
    const gate = provGate(["fail"], {
      onFail: "halt",
      footerTarget: "reply",
      persist: async (_b, at) => `.crewhaus/proofs/t/${at.sessionId}/turn-${at.turnNumber}.json`,
    });
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    const report = run.caught.report;
    expect(report.class).toBe("provability");
    expect(report.exitCode).toBe(37);
    expect(report.title).toBe("provability gate failed");
    expect(report.detail).toBe(
      `1/2 claims met the grounded floor (threshold 1); unmet: not_fetched; proof bundle: .crewhaus/proofs/t/${run.sessionId}/turn-1.json`,
    );
    expect(report.remediation).toBe(
      "cite the evidence each claim rests on, lower provability.threshold, or soften provability.on_fail to retry/note",
    );
    expect(adapter.calls()).toBe(1); // halt never re-runs the turn
    expect(graded(run.events)).toHaveLength(1);
    const runFailed = run.events.filter((e) => e.kind === "run_failed");
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ class: "provability", exitCode: 37 });
    const loggedFailure = run.logged.filter((l) => l.kind === "run_failed");
    expect(loggedFailure).toHaveLength(1);
    expect(loggedFailure[0]?.payload).toMatchObject({ class: "provability", exitCode: 37 });
    // A halted run returns no reply to carry the footer: it goes to the
    // output even under footerTarget "reply".
    expect(run.stdout).toContain(FAIL_FOOTER);
    expect(run.stdout.indexOf("bad answer")).toBeLessThan(run.stdout.indexOf(FAIL_FOOTER));
  });

  test("halt detail counts refused assumptions and tallies the unmet reasons", async () => {
    const refusedClaim: ProofClaim = {
      index: 2,
      text: "The fiscal year starts in April [A1].",
      status: "unmet",
      best: "none",
      bindings: [
        {
          ref: "[A1]",
          kind: "assumption",
          rung: "none",
          ok: false,
          reason: "assumption_forbidden",
        },
      ],
    };
    const bundle = bundleOf("fail", {
      claims: [MET_CLAIM, UNMET_CLAIM, { ...UNMET_CLAIM, index: 3 }, refusedClaim],
      claimCount: 4,
      met: 1,
      unmet: 3,
      assumptionsRefused: 1,
    });
    const gate = provGate([bundle], { onFail: "halt" });
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("x")]]),
      provability: gate.provability,
    });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.detail).toBe(
      "1/4 claims met the grounded floor (threshold 1); 1 declared assumption was refused; unmet: not_fetched ×2, assumption_forbidden",
    );
    expect(graded(run.events)[0]).toMatchObject({ verdict: "fail", assumptionsRefused: 1 });
  });

  test("note: the failing verdict is recorded, the ✗ footer is rendered and the answer stands", async () => {
    const adapter = scriptedAdapter([[text("meh")]]);
    const gate = provGate(["fail"], { onFail: "note" });
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("meh");
    expect(adapter.calls()).toBe(1);
    expect(graded(run.events).map((e) => [e.verdict, e.retryIndex])).toEqual([["fail", 0]]);
    expect(run.stdout).toContain(FAIL_FOOTER);
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
  });

  test("a verifier crash fails OPEN: unverified bundle, the answer stands, a warning and an error line — even under halt", async () => {
    const adapter = scriptedAdapter([[text("fine")]]);
    const gate = provGate(["throw"], { onFail: "halt" });
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("fine");
    expect(adapter.calls()).toBe(1);
    const events = graded(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verdict: "unverified",
      score: 0,
      achieved: "none",
      claims: 0,
      retryIndex: 0,
    });
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
    const errors = run.logged.filter(
      (l) =>
        l.kind === "error" &&
        String(l.payload?.["message"]).includes("provability verifier failed"),
    );
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.payload?.["message"])).toContain("sandbox unreachable");
    expect(run.warnings.some((w) => w.includes("verifier threw"))).toBe(true);
    // The footer says unverified, never ✓.
    expect(run.stdout).toContain("── provability · grounded ? unverified — sandbox unreachable");
    expect(run.stdout).not.toContain("✓");
    // The observer got the unverified bundle, error recorded.
    expect(gate.bundles[0]?.bundle).toMatchObject({
      verdict: "unverified",
      error: "sandbox unreachable",
    });
  });

  test("a verifier that returns no bundle is treated as a crash (unverified), never as a verdict", async () => {
    // Nothing, a verdict without claims, an unknown verdict, and PARTIAL
    // bundles — a bare `{ verdict, claims }`, a non-finite score, an unknown
    // level, no hash, a claim without bindings: none is a verdict to act on
    // (a halt on them would print `undefined/NaN claims` or crash on
    // `claim.bindings` rather than classify).
    const { bundleHash: _hash, ...unhashed } = bundleOf("fail");
    const returns: unknown[] = [
      undefined,
      { verdict: "fail" },
      { verdict: "maybe", claims: [] },
      { verdict: "fail", claims: [] },
      { ...bundleOf("fail"), score: Number.NaN },
      { ...bundleOf("fail"), met: "1" },
      { ...bundleOf("fail"), level: "certain" },
      { ...bundleOf("fail"), achieved: "best" },
      { ...bundleOf("fail"), assumptionsRefused: Number.POSITIVE_INFINITY },
      { ...bundleOf("fail"), spentUsdMicros: "42" },
      unhashed,
      { ...bundleOf("fail"), claims: [{ index: 0, text: "x", status: "unmet" }] },
      { ...bundleOf("fail"), claims: [{ ...UNMET_CLAIM, bindings: [null] }] },
    ];
    for (const returned of returns) {
      const gate = provGate([() => returned], { onFail: "halt" });
      const run = await runSingle({
        _adapter: scriptedAdapter([[text("fine")]]),
        provability: gate.provability,
      });
      expect(run.caught).toBeUndefined();
      expect(run.result).toBe("fine");
      expect(graded(run.events).map((e) => e.verdict)).toEqual(["unverified"]);
      // The line still carries every required summary field.
      expect(graded(run.events)[0]).toMatchObject({
        level: "grounded",
        score: 0,
        threshold: 1,
        achieved: "none",
        claims: 0,
        met: 0,
        unmet: 0,
        assumptions: 0,
      });
      expect(graded(run.events)[0]?.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(
        run.logged.some(
          (l) =>
            l.kind === "error" &&
            String(l.payload?.["message"]).includes("the verifier returned no proof bundle"),
        ),
      ).toBe(true);
    }
  });

  test("the gate's pass counter is authoritative for retryIndex, whatever the verifier stamps", async () => {
    const gate = provGate([bundleOf("fail"), bundleOf("pass")]); // both stamp retryIndex 0
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("a")], [text("b")]]),
      provability: gate.provability,
    });
    expect(graded(run.events).map((e) => e.retryIndex)).toEqual([0, 1]);
    expect(gradedLines(run.logged).map((l) => l.payload?.["retryIndex"])).toEqual([0, 1]);
  });

  test("a nudge composer that throws still retries, nudging with the score alone", async () => {
    const adapter = scriptedAdapter([[text("a")], [text("b")]]);
    const gate = provGate(["fail", "pass"], {
      nudge: () => {
        throw new Error("composer bug");
      },
    });
    const run = await runSingle({ _adapter: adapter, provability: gate.provability });
    expect(run.result).toBe("b");
    expect(adapter.calls()).toBe(2);
    expect(lastUserText(adapter.reqs[1])).toBe(
      "[provability failed: 1/2 claims met the grounded floor, threshold 1]\nCite the evidence each claim rests on, then give the corrected answer in full.",
    );
    expect(run.warnings.some((w) => w.includes("composing the retry nudge failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rendering beside the answer (§5.4).
// ---------------------------------------------------------------------------

describe("provability gate — the footer", () => {
  test('footerTarget "stream" (default): the footer is written after the answer, on its own line, and is not returned', async () => {
    const gate = provGate(["pass"]);
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
    });
    expect(run.result).toBe("ok");
    const footer = renderFooter(bundleOf("pass"));
    expect(run.stdout).toBe(`agent> ok\n${footer}\n`);
  });

  test('footerTarget "reply": the footer is appended to the returned text after a blank line — never to stdout, the transcript or the next request', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-reply-"));
    try {
      const gate = provGate(["pass"], { footerTarget: "reply" });
      const runContext = createRunContext();
      const chunks: string[] = [];
      const result = await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: scriptedAdapter([[text("ok")]]),
        runContext,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "first" }],
        spinner: false,
        stdout: (s) => {
          chunks.push(s);
        },
        provability: gate.provability,
      });
      const footer = renderFooter(bundleOf("pass"));
      expect(result).toBe(`ok\n\n${footer}`);
      expect(chunks.join("")).toBe("agent> ok\n");
      // The verifier saw the answer alone.
      expect(gate.turns[0]?.finalText).toBe("ok");
      // The transcript on disk holds the answer, not the footer…
      const lines = readSessionLines(rootDir);
      const assistant = lines.filter((l) => l.kind === "assistant_message");
      expect(assistant).toHaveLength(1);
      expect(JSON.stringify(assistant[0]?.payload)).not.toContain("provability");
      // …so the next turn of the same session never shows the model its footer.
      const next = scriptedAdapter([[text("second answer")]]);
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: next,
        sessionRootDir: rootDir,
        resume: { sessionId: runContext.sessionId },
        singleTurn: true,
        seedMessages: [{ role: "user", content: "second" }],
        spinner: false,
        stdout: () => {},
        provability: provGate(["pass"], { footerTarget: "reply" }).provability,
      });
      const shown = JSON.stringify(next.reqs[0]?.messages);
      expect(shown).toContain("ok");
      expect(shown).not.toContain("── provability");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('render "none" writes nothing and never calls the renderer; the trace line still fires', async () => {
    let renders = 0;
    const gate = provGate(["fail"], {
      onFail: "note",
      render: "none",
      renderBundle: () => {
        renders += 1;
        return "should never show";
      },
    });
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
    });
    expect(run.result).toBe("ok");
    expect(run.stdout).toBe("agent> ok\n");
    expect(renders).toBe(0);
    expect(graded(run.events)).toHaveLength(1);
  });

  test('render "json": the injected renderer\'s JSON follows the answer', async () => {
    const gate = provGate(["pass"], {
      render: "json",
      renderBundle: (bundle) => renderBundleJson(bundle),
    });
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
    });
    const json = run.stdout.slice("agent> ok\n".length);
    expect(JSON.parse(json)).toMatchObject({ version: 1, verdict: "pass", level: "grounded" });
  });

  test("no renderer, or a renderer that throws, leaves the answer without a footer (warned)", async () => {
    const { renderBundle: _drop, ...noRenderer } = provGate(["pass"]).provability;
    const bare = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: noRenderer,
    });
    expect(bare.stdout).toBe("agent> ok\n");

    const throwing = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: provGate(["pass"], {
        renderBundle: () => {
          throw new Error("renderer bug");
        },
      }).provability,
    });
    expect(throwing.result).toBe("ok");
    expect(throwing.stdout).toBe("agent> ok\n");
    expect(throwing.warnings.some((w) => w.includes("rendering the proof bundle failed"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence, audit, observers.
// ---------------------------------------------------------------------------

describe("provability gate — persist, audit, onBundle", () => {
  test("the persisted path rides the event, the event-log line, the footer and onBundle", async () => {
    const persisted: Array<{ sessionId?: string; turnNumber: number }> = [];
    const gate = provGate(["pass"], {
      persist: async (_bundle, at) => {
        persisted.push({ ...at });
        return `.crewhaus/proofs/support-bot/${at.sessionId}/turn-${at.turnNumber}.json`;
      },
    });
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
    });
    const path = `.crewhaus/proofs/support-bot/${run.sessionId}/turn-1.json`;
    expect(persisted).toEqual([{ sessionId: run.sessionId, turnNumber: 1 }]);
    expect(graded(run.events)[0]?.bundlePath).toBe(path);
    expect(gradedLines(run.logged)[0]?.payload?.["bundlePath"]).toBe(path);
    expect(run.stdout).toContain(
      `${PASS_FOOTER} · 2/2 claims · 1 source · 0 assumptions · ${path}`,
    );
    expect(gate.bundles[0]?.path).toBe(path);
  });

  test("persist throwing is never fatal: warned, no bundlePath, the verdict and the answer stand", async () => {
    const gate = provGate(["pass"], {
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("ok");
    const events = graded(run.events);
    expect(events).toHaveLength(1);
    expect("bundlePath" in (events[0] ?? {})).toBe(false);
    expect(run.warnings.some((w) => w.includes("persisting the proof bundle failed"))).toBe(true);
    expect(run.warnings.some((w) => w.includes("disk full"))).toBe(true);
  });

  test("the audit sink gets one provability_evaluated record per pass with the summary, turnNumber and sessionId", async () => {
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const sink: JustificationAuditSink = {
      async append(input) {
        appended.push(input);
        return input;
      },
    };
    const gate = provGate(["fail", "pass"]);
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("a")], [text("b")]]),
      provability: gate.provability,
      justificationAuditSink: sink,
    });
    expect(appended.map((r) => r.kind)).toEqual(["provability_evaluated", "provability_evaluated"]);
    const events = graded(run.events);
    expect(appended[0]?.payload).toEqual({
      level: "grounded",
      verdict: "fail",
      score: 0.5,
      threshold: 1,
      achieved: "cited",
      claims: 2,
      met: 1,
      unmet: 1,
      assumptions: 0,
      retryIndex: 0,
      bundleHash: events[0]?.bundleHash,
      turnNumber: 1,
      sessionId: run.sessionId,
    });
    expect(appended[1]?.payload).toMatchObject({ verdict: "pass", retryIndex: 1 });
  });

  test("the waiver judge's model and spend ride the event, the event-log line and the audit record", async () => {
    const appended: Array<{ kind: string; payload: unknown }> = [];
    const sink: JustificationAuditSink = {
      async append(input) {
        appended.push(input);
        return input;
      },
    };
    const gate = provGate([
      bundleOf("pass", { judgeModel: "claude-haiku-4-5", spentUsdMicros: 42 }),
    ]);
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: gate.provability,
      justificationAuditSink: sink,
    });
    expect(run.result).toBe("ok");
    const judge = { judgeModel: "claude-haiku-4-5", judgeCostUsdMicros: 42 };
    expect(graded(run.events)[0]).toMatchObject(judge);
    expect(gradedLines(run.logged)[0]?.payload).toMatchObject(judge);
    expect(appended[0]?.payload).toMatchObject(judge);
    // The bundle's own field name never leaks onto the summary surfaces.
    expect("spentUsdMicros" in (graded(run.events)[0] ?? {})).toBe(false);
  });

  test("on --resume, verify, persist and the audit record name the RESUMED session (the session whose log holds the evidence)", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-resume-"));
    try {
      const first = createRunContext();
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: scriptedAdapter([[text("first answer")]]),
        runContext: first,
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "first" }],
        spinner: false,
        stdout: () => {},
      });
      const resumedId = first.sessionId;
      const persistedAt: Array<string | undefined> = [];
      const appended: Array<{ kind: string; payload: unknown }> = [];
      const gate = provGate(["pass"], {
        persist: async (_bundle, at) => {
          persistedAt.push(at.sessionId);
          return undefined;
        },
      });
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: scriptedAdapter([[text("second answer")]]),
        sessionRootDir: rootDir,
        resume: { sessionId: resumedId },
        singleTurn: true,
        seedMessages: [{ role: "user", content: "second" }],
        spinner: false,
        stdout: () => {},
        justificationAuditSink: {
          async append(input) {
            appended.push(input);
            return input;
          },
        },
        provability: gate.provability,
      });
      expect(gate.turns[0]?.sessionId).toBe(resumedId);
      expect(persistedAt).toEqual([resumedId]);
      expect(appended[0]?.payload).toMatchObject({ sessionId: resumedId });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("an audit append failure is swallowed and warned; the run goes on", async () => {
    const sink: JustificationAuditSink = {
      async append() {
        throw new Error("audit disk full");
      },
    };
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: provGate(["pass"]).provability,
      justificationAuditSink: sink,
    });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("ok");
    expect(run.warnings.some((w) => w.includes("provability audit append failed"))).toBe(true);
  });

  test("an onBundle observer that throws is ignored (warned)", async () => {
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("ok")]]),
      provability: provGate(["pass"], {
        onBundle: () => {
          throw new Error("observer bug");
        },
      }).provability,
    });
    expect(run.result).toBe("ok");
    expect(run.warnings.some((w) => w.includes("onBundle observer threw"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ordering with `evaluation:`.
// ---------------------------------------------------------------------------

describe("provability gate — ordering with evaluation", () => {
  test("an evaluation retry happens INSIDE a provability pass: the gate verifies only the answer evaluation accepted", async () => {
    const adapter = scriptedAdapter([[text("draft")], [text("better")]]);
    const evaluation = evalGate([0.2, 0.9]);
    const gate = provGate(["pass"]);
    const run = await runSingle({
      _adapter: adapter,
      evaluation: evaluation.evaluation,
      provability: gate.provability,
    });
    expect(run.result).toBe("better");
    expect(adapter.calls()).toBe(2);
    const order = run.events
      .filter((e) => e.kind === "eval_graded" || e.kind === "provability_graded")
      .map((e) => (e.kind === "eval_graded" ? `eval:${e.verdict}` : `prov:${e.verdict}`));
    expect(order).toEqual(["eval:fail", "eval:pass", "prov:pass"]);
    expect(gate.turns.map((t) => t.finalText)).toEqual(["better"]);
  });

  test("a provability retry re-runs the EVALUATED turn: evaluation re-grades the new answer", async () => {
    const adapter = scriptedAdapter([[text("first")], [text("second")]]);
    const evaluation = evalGate([0.9]);
    const gate = provGate(["fail", "pass"]);
    const run = await runSingle({
      _adapter: adapter,
      evaluation: evaluation.evaluation,
      provability: gate.provability,
    });
    expect(run.result).toBe("second");
    const order = run.events
      .filter((e) => e.kind === "eval_graded" || e.kind === "provability_graded")
      .map((e) =>
        e.kind === "eval_graded"
          ? `eval:${e.verdict}:${e.retryIndex}`
          : e.kind === "provability_graded"
            ? `prov:${e.verdict}:${e.retryIndex}`
            : "",
      );
    expect(order).toEqual(["eval:pass:0", "prov:fail:0", "eval:pass:0", "prov:pass:1"]);
    // The evaluation of the re-run saw the provability nudge as synthetic.
    expect(evaluation.turns.map((t) => t.finalText)).toEqual(["first", "second"]);
    expect(evaluation.turns[1]?.synthetic).toHaveLength(1);
    expect(evaluation.turns[1]?.synthetic[0]).toContain(NUDGE_HEAD);
  });

  test("evaluation halting inside a pass is terminal before the gate ever verifies", async () => {
    const gate = provGate(["pass"]);
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("bad")]]),
      evaluation: evalGate([0.1], { onFail: "halt" }).evaluation,
      provability: gate.provability,
    });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("evaluation");
    expect(gate.calls()).toBe(0);
    expect(graded(run.events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// on_fail: escalate.
// ---------------------------------------------------------------------------

const CHEAP = "claude-haiku-4-5";
const STRONG = "claude-opus-4-1";
const POOL = {
  candidates: [
    { model: CHEAP, tags: ["cheap"], profile: "fast" },
    { model: STRONG, tags: ["strong"], profile: "strong" },
  ],
  policy: "static" as const,
};
const scoreboard = () =>
  openScoreboard(mkdtempSync(join(tmpdir(), "crewhaus-provability-sb-")), { now: () => 1 });

describe("provability gate — on_fail escalate", () => {
  for (const escalateTo of ["$strong", undefined]) {
    test(`with a pool (escalateTo ${escalateTo ?? "absent → the strongest"}): the failing pass names the rung, the turn re-runs there with the nudge, and is re-verified`, async () => {
      const cheap = scriptedAdapter([[text("cheap draft")]]);
      const strong = scriptedAdapter([[text("strong answer")]]);
      const gate = provGate(["fail", "pass"], {
        onFail: "escalate",
        ...(escalateTo !== undefined ? { escalateTo } : {}),
      });
      const run = await runSingle({
        model: CHEAP,
        _adapter: cheap,
        modelPool: POOL,
        _poolAdapters: new Map<string, ProviderAdapter>([
          [CHEAP, cheap],
          [STRONG, strong],
        ]),
        _scoreboard: scoreboard(),
        provability: gate.provability,
      });
      expect(run.caught).toBeUndefined();
      expect(run.result).toBe("strong answer");
      expect(cheap.calls()).toBe(1);
      expect(strong.calls()).toBe(1);
      const nudge = lastUserText(strong.reqs[0]);
      expect(nudge).toContain(NUDGE_HEAD);
      // The nudge is SYNTHETIC: flagged to the re-verification, and logged as a
      // synthetic user_message (without the line, a resumed transcript would
      // hold two adjacent assistant messages).
      expect(gate.turns[1]?.synthetic).toEqual([nudge]);
      const synthetic = run.logged.filter(
        (l) => l.kind === "user_message" && l.payload?.["synthetic"] === true,
      );
      expect(synthetic).toHaveLength(1);
      expect(synthetic[0]?.payload?.["content"]).toBe(nudge);

      const events = graded(run.events);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ verdict: "fail", retryIndex: 0, escalatedTo: STRONG });
      expect(events[1]).toMatchObject({ verdict: "pass", retryIndex: 1 });
      expect("escalatedTo" in (events[1] ?? {})).toBe(false);
      expect(gradedLines(run.logged)[0]?.payload?.["escalatedTo"]).toBe(STRONG);

      const stages = run.events.filter((e): e is ModelStageEvent => e.kind === "model_stage");
      expect(stages.map((s) => [s.stage, s.role, s.model, s.outcome])).toEqual([
        ["escalate", "escalation", STRONG, "started"],
        ["escalate", "escalation", STRONG, "done"],
      ]);
      const responses = run.events.filter(
        (e): e is ModelResponseEvent => e.kind === "model_response",
      );
      expect(responses.map((r) => r.model)).toEqual([CHEAP, STRONG]);
      expect(responses[1]?.role).toBe("escalation");
      // The escalated attempt is verified as the escalation stage, on its arm.
      expect(gate.turns.map((t) => [t.servedModel, t.stage])).toEqual([
        [CHEAP, undefined],
        [STRONG, "escalate"],
      ]);
    });
  }

  test("escalation counts against maxRetries: spent, the escalated answer stands with its ✗", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")]]);
    const strong = scriptedAdapter([[text("strong answer")]]);
    const gate = provGate(["fail"], { onFail: "escalate", maxRetries: 1 });
    const run = await runSingle({
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      provability: gate.provability,
    });
    expect(run.result).toBe("strong answer");
    expect(strong.calls()).toBe(1);
    const events = graded(run.events);
    expect(events.map((e) => [e.verdict, e.retryIndex, e.escalatedTo])).toEqual([
      ["fail", 0, STRONG],
      ["fail", 1, undefined],
    ]);
    expect(run.stdout).toContain(FAIL_FOOTER);
  });

  test("the escalation rung unavailable: the answer stands with its failing verdict (note semantics), stages started → failed, no run_failed", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")]]);
    // A bare Error classifies `unknown` → the recovery ladder fails at once.
    const strong = throwThenReplyAdapter(new Error("strong rung down"), 99, "never");
    const gate = provGate(["fail"], { onFail: "escalate" });
    const run = await runSingle({
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("cheap draft");
    expect(strong.requests).toHaveLength(1);
    expect(lastUserText(strong.requests[0])).toContain(NUDGE_HEAD);
    const events = graded(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verdict: "fail", escalatedTo: STRONG });
    const stages = run.events.filter((e): e is ModelStageEvent => e.kind === "model_stage");
    expect(stages.map((s) => s.outcome)).toEqual(["started", "failed"]);
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(0);
    expect(run.stdout).toContain(FAIL_FOOTER);
    expect(run.warnings.some((w) => w.includes("escalation rung unavailable"))).toBe(true);
  });

  test("a classified halt on the escalation rung (401) is terminal for the run, never swallowed as an unavailable rung", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")]]);
    const authErr = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const strong = throwThenReplyAdapter(authErr, 99, "never");
    const gate = provGate(["fail"], { onFail: "escalate" });
    const run = await runSingle({
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      provability: gate.provability,
    });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("auth");
    expect(run.result).toBeUndefined();
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(1);
    expect(run.warnings.some((w) => w.includes("escalation rung unavailable"))).toBe(false);
    expect(run.stdout).not.toContain("── provability");
  });

  test("the rung unavailable withdraws the nudge: the next REPL turn's request never carries it", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")]]);
    const strong = throwThenReplyAdapter(new Error("strong rung down"), 99, "never");
    const gate = provGate(["fail", "pass"], { onFail: "escalate" });
    const run = await runRepl(["first", "second"], {
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(cheap.calls()).toBe(2);
    const secondTurn = JSON.stringify(cheap.reqs[1]?.messages);
    expect(secondTurn).toContain("second");
    expect(secondTurn).not.toContain(NUDGE_HEAD);
  });

  test("without a pool: warned ONCE per run, note semantics (no re-run, the ✗ footer)", async () => {
    const adapter = scriptedAdapter([[text("answer")]]);
    const gate = provGate(["fail"], { onFail: "escalate" });
    const run = await runRepl(["one", "two"], {
      _adapter: adapter,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(adapter.calls()).toBe(2); // one per turn, never re-run
    expect(graded(run.events).map((e) => [e.verdict, e.retryIndex])).toEqual([
      ["fail", 0],
      ["fail", 0],
    ]);
    expect(graded(run.events).some((e) => e.escalatedTo !== undefined)).toBe(false);
    expect(
      run.warnings.filter((w) => w.includes("provability.on_fail: escalate needs a model_pool")),
    ).toHaveLength(1);
    expect(countOf(run.stdout, FAIL_FOOTER)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Aborts and the REPL path.
// ---------------------------------------------------------------------------

describe("provability gate — aborts and the REPL", () => {
  test("an aborted (timed-out) turn is never verified", async () => {
    const adapter = hangingAdapter();
    const gate = provGate(["pass"]);
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-timeout-"));
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((ev) => {
      events.push(ev);
    });
    const input = new PassThrough();
    input.write("hi\n");
    input.end();
    const result = await runChatLoop({
      model: "test-model",
      instructions: "t",
      _adapter: adapter,
      runContext,
      sessionRootDir: rootDir,
      input,
      turnTimeoutMs: 120,
      stdout: () => {},
      provability: gate.provability,
    });
    rmSync(rootDir, { recursive: true, force: true });
    expect(result).toBe(""); // the session survived the timed-out turn
    expect(adapter.calls()).toBe(1);
    expect(gate.calls()).toBe(0);
    expect(graded(events)).toHaveLength(0);
  });

  test("REPL: a turn aborted WHILE verifying is returned un-verified: no verdict line, no verifier-failure line, the named TurnTimeout recorded", async () => {
    const adapter = scriptedAdapter([[text("ok")]]);
    let verifyCalls = 0;
    const provability: RunProvability = {
      ...provGate(["pass"]).provability,
      verify: (turn) => {
        verifyCalls += 1;
        return new Promise<ProofBundle>((_, reject) => {
          const abort = (): void =>
            reject(Object.assign(new Error("verification aborted"), { name: "AbortError" }));
          if (turn.signal?.aborted === true) abort();
          else turn.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const run = await runRepl(["hi"], {
      _adapter: adapter,
      turnTimeoutMs: LIMIT_MS,
      provability,
    });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe("");
    expect(verifyCalls).toBe(1);
    expect(graded(run.events)).toHaveLength(0);
    expect(gradedLines(run.logged)).toHaveLength(0);
    expect(
      run.logged.some(
        (l) =>
          l.kind === "error" && String(l.payload?.["message"]).includes("provability verifier"),
      ),
    ).toBe(false);
    // The limit fired inside the gate, where no runOneTurn was running to
    // record it: the gate writes the same named line runOneTurn writes.
    const timeouts = run.logged.filter((l) => l.kind === "error");
    expect(timeouts.map((l) => l.payload)).toEqual([
      {
        name: "TurnTimeout",
        message: `turn aborted: the configured limits.turn_timeout_ms (${LIMIT_MS}ms) elapsed`,
      },
    ]);
    expect(run.stdout).not.toContain("── provability");
  });

  test("REPL: a failing verdict that settles AFTER the turn timer fired is never acted on — no nudge, no re-run, a clean next request", async () => {
    // The real verifier takes no signal: a slow one returns a full verdict
    // for a turn the timer already stopped.
    const adapter = scriptedAdapter([[text("draft")], [text("next")]]);
    const gate = provGate([lateVerdict(bundleOf("fail")), "pass"]);
    const run = await runRepl(["hi", "again"], {
      _adapter: adapter,
      turnTimeoutMs: LIMIT_MS,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(gate.calls()).toBe(2);
    expect(adapter.calls()).toBe(2); // one per turn: the late fail re-ran nothing
    expect(graded(run.events).map((e) => [e.verdict, e.turnNumber])).toEqual([["pass", 2]]);
    expect(
      run.logged.filter((l) => l.kind === "user_message" && l.payload?.["synthetic"] === true),
    ).toHaveLength(0);
    const second = JSON.stringify(adapter.reqs[1]?.messages);
    expect(second).toContain("again");
    expect(second).not.toContain(NUDGE_HEAD);
    expect(
      run.logged.filter((l) => l.kind === "error" && l.payload?.["name"] === "TurnTimeout"),
    ).toHaveLength(1);
    expect(run.stdout).toContain(`[turn timeout: ${LIMIT_MS}ms elapsed — aborting]`);
    expect(run.stdout).not.toContain(FAIL_FOOTER);
  });

  for (const limit of ["turnTimeoutMs", "deadlineMs"] as const) {
    test(`singleTurn: ${limit} firing WHILE verifying is the classified timeout stop — never a served un-verified answer, never a skipped halt`, async () => {
      let verifyCalls = 0;
      const provability: RunProvability = {
        ...provGate(["fail"], { onFail: "halt" }).provability,
        verify: (turn) => {
          verifyCalls += 1;
          return untilAborted(turn);
        },
      };
      const run = await runSingle({
        _adapter: scriptedAdapter([[text("answer")]]),
        ...(limit === "turnTimeoutMs" ? { turnTimeoutMs: LIMIT_MS } : { deadlineMs: LIMIT_MS }),
        provability,
      });
      expect(verifyCalls).toBe(1);
      expect(run.result).toBeUndefined();
      expect(run.caught).toBeInstanceOf(RunFailedError);
      if (!(run.caught instanceof RunFailedError)) return;
      expect(run.caught.report).toMatchObject({
        class: "timeout",
        title:
          limit === "turnTimeoutMs" ? "turn wall-clock limit exceeded" : "run deadline exceeded",
        exitCode: EXIT_CODES.timeout,
      });
      expect(graded(run.events)).toHaveLength(0);
      expect(gradedLines(run.logged)).toHaveLength(0);
      expect(
        run.logged.filter((l) => l.kind === "run_failed").map((l) => l.payload?.["class"]),
      ).toEqual(["timeout"]);
      expect(run.stdout).not.toContain("── provability");
    });
  }

  for (const verdict of ["fail", "pass"] as const) {
    test(`singleTurn: a ${verdict} verdict that settles AFTER the turn timer fired is discarded — the run is the timeout stop, not ${verdict === "fail" ? "a provability halt" : "a served answer"}`, async () => {
      const gate = provGate([lateVerdict(bundleOf(verdict))], { onFail: "halt" });
      const run = await runSingle({
        _adapter: scriptedAdapter([[text("answer")]]),
        turnTimeoutMs: LIMIT_MS,
        provability: gate.provability,
      });
      expect(gate.calls()).toBe(1);
      expect(run.result).toBeUndefined();
      expect(run.caught).toBeInstanceOf(RunFailedError);
      if (!(run.caught instanceof RunFailedError)) return;
      expect(run.caught.report.class).toBe("timeout");
      expect(run.caught.report.exitCode).toBe(EXIT_CODES.timeout);
      expect(graded(run.events)).toHaveLength(0);
      expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(1);
    });
  }

  test("REPL: a turn timer that fires while the pass is being RECORDED leaves the recorded verdict standing — never a re-run on the aborted signal", async () => {
    const adapter = scriptedAdapter([[text("draft")], [text("next")]]);
    // The verdict settles inside the window; persisting it outlasts it.
    let persists = 0;
    let firstSignal: AbortSignal | undefined;
    const gate = provGate(
      [
        (turn) => {
          firstSignal = turn.signal;
          return bundleOf("fail");
        },
        "pass",
      ],
      {
        persist: async () => {
          persists += 1;
          if (persists === 1) await whenAborted(firstSignal);
          return undefined;
        },
      },
    );
    const run = await runRepl(["hi", "again"], {
      _adapter: adapter,
      turnTimeoutMs: LIMIT_MS,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(adapter.calls()).toBe(2); // the failing verdict re-ran nothing
    expect(graded(run.events).map((e) => [e.verdict, e.turnNumber])).toEqual([
      ["fail", 1],
      ["pass", 2],
    ]);
    expect(
      run.logged.filter((l) => l.kind === "user_message" && l.payload?.["synthetic"] === true),
    ).toHaveLength(0);
    expect(JSON.stringify(adapter.reqs[1]?.messages)).not.toContain(NUDGE_HEAD);
    expect(
      run.logged.filter((l) => l.kind === "error" && l.payload?.["name"] === "TurnTimeout"),
    ).toHaveLength(1);
    // The recorded verdict is the standing one, so its ✗ is what is rendered.
    expect(countOf(run.stdout, FAIL_FOOTER)).toBe(1);
  });

  test("singleTurn: a turn timer that fires while the pass is being RECORDED is still the timeout stop, whatever the verdict", async () => {
    let signal: AbortSignal | undefined;
    const gate = provGate(
      [
        (turn) => {
          signal = turn.signal;
          return bundleOf("pass");
        },
      ],
      {
        persist: async () => {
          await whenAborted(signal);
          return undefined;
        },
      },
    );
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("answer")]]),
      turnTimeoutMs: LIMIT_MS,
      provability: gate.provability,
    });
    expect(run.result).toBeUndefined();
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("timeout");
    // The verdict settled inside the window, so it is on the record.
    expect(graded(run.events).map((e) => e.verdict)).toEqual(["pass"]);
    expect(run.stdout).not.toContain(PASS_FOOTER);
  });

  /**
   * The routing record must never name an escalation that did not run: every
   * `escalatedTo` is followed by that rung's `model_stage{escalate}` —
   * `started` when it ran, `skipped` (cause `aborted`) when the abort tree
   * stopped the turn first. Checked on the trace and on the durable lines.
   */
  const expectEscalationsAccountedFor = (run: Collected): void => {
    const announced = run.events.flatMap((e, i) =>
      e.kind === "provability_graded" && e.escalatedTo !== undefined
        ? [{ i, to: e.escalatedTo }]
        : [],
    );
    for (const { i, to } of announced) {
      const next = run.events
        .slice(i + 1)
        .find(
          (e): e is ModelStageEvent =>
            e.kind === "model_stage" && e.stage === "escalate" && e.model === to,
        );
      expect(next?.outcome === "started" || next?.outcome === "skipped").toBe(true);
    }
    const announcedLines = run.logged.flatMap((l, i) =>
      l.kind === "provability_graded" && l.payload?.["escalatedTo"] !== undefined
        ? [{ i, to: l.payload["escalatedTo"] }]
        : [],
    );
    expect(announcedLines).toHaveLength(announced.length);
    for (const { i, to } of announcedLines) {
      const next = run.logged
        .slice(i + 1)
        .find(
          (l) =>
            l.kind === "model_stage" &&
            l.payload?.["stage"] === "escalate" &&
            l.payload["model"] === to,
        );
      expect(
        next?.payload?.["outcome"] === "started" || next?.payload?.["outcome"] === "skipped",
      ).toBe(true);
    }
  };
  const skippedEscalations = (run: Collected) =>
    run.events
      .filter(
        (e): e is ModelStageEvent =>
          e.kind === "model_stage" && e.stage === "escalate" && e.outcome === "skipped",
      )
      .map((e) => [e.model, e.cause]);

  test("REPL escalate: a turn timer that fires while the failing pass is PERSISTED never announces the rung — the escalation is recorded as skipped (aborted)", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")], [text("next")]]);
    const strong = scriptedAdapter([[text("strong answer")]]);
    let firstSignal: AbortSignal | undefined;
    let persists = 0;
    const gate = provGate(
      [
        (turn) => {
          firstSignal = turn.signal;
          return bundleOf("fail");
        },
        "pass",
      ],
      {
        onFail: "escalate",
        persist: async () => {
          persists += 1;
          if (persists === 1) await whenAborted(firstSignal);
          return undefined;
        },
      },
    );
    const run = await runRepl(["hi", "again"], {
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      turnTimeoutMs: LIMIT_MS,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(strong.calls()).toBe(0);
    expect(cheap.calls()).toBe(2); // one per turn: the stopped turn re-ran nothing
    expect(graded(run.events).map((e) => [e.verdict, e.turnNumber, e.escalatedTo])).toEqual([
      ["fail", 1, undefined],
      ["pass", 2, undefined],
    ]);
    expect(gradedLines(run.logged).some((l) => l.payload?.["escalatedTo"] !== undefined)).toBe(
      false,
    );
    expect(skippedEscalations(run)).toEqual([[STRONG, "aborted"]]);
    expect(
      run.events.some(
        (e) => e.kind === "model_stage" && e.stage === "escalate" && e.outcome === "started",
      ),
    ).toBe(false);
    expect(
      run.logged.filter(
        (l) =>
          l.kind === "model_stage" &&
          l.payload?.["outcome"] === "skipped" &&
          l.payload["cause"] === "aborted",
      ),
    ).toHaveLength(1);
    expect(
      run.logged.filter((l) => l.kind === "user_message" && l.payload?.["synthetic"] === true),
    ).toHaveLength(0);
    expect(
      run.logged.filter((l) => l.kind === "error" && l.payload?.["name"] === "TurnTimeout"),
    ).toHaveLength(1);
    expect(JSON.stringify(cheap.reqs[1]?.messages)).not.toContain(NUDGE_HEAD);
    expectEscalationsAccountedFor(run);
  });

  test("REPL escalate: a turn timer that fires AFTER the rung was announced (during the audit append) records the escalation as skipped (aborted) — never a dangling escalatedTo", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")], [text("next")]]);
    const strong = scriptedAdapter([[text("strong answer")]]);
    let firstSignal: AbortSignal | undefined;
    let appends = 0;
    const sink: JustificationAuditSink = {
      async append(input) {
        appends += 1;
        if (appends === 1) await whenAborted(firstSignal);
        return input;
      },
    };
    const gate = provGate(
      [
        (turn) => {
          firstSignal = turn.signal;
          return bundleOf("fail");
        },
        "pass",
      ],
      { onFail: "escalate" },
    );
    const run = await runRepl(["hi", "again"], {
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      turnTimeoutMs: LIMIT_MS,
      justificationAuditSink: sink,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(strong.calls()).toBe(0);
    expect(cheap.calls()).toBe(2);
    // The announcement had already gone out when the timer fired…
    expect(graded(run.events).map((e) => [e.verdict, e.turnNumber, e.escalatedTo])).toEqual([
      ["fail", 1, STRONG],
      ["pass", 2, undefined],
    ]);
    // …so the skip that follows it is what keeps the record honest.
    expect(skippedEscalations(run)).toEqual([[STRONG, "aborted"]]);
    expect(
      run.logged.filter((l) => l.kind === "user_message" && l.payload?.["synthetic"] === true),
    ).toHaveLength(0);
    expectEscalationsAccountedFor(run);
  });

  test("singleTurn escalate: a turn timer that fires while the failing pass is PERSISTED is the timeout stop, the rung never announced and recorded as skipped", async () => {
    const cheap = scriptedAdapter([[text("cheap draft")]]);
    const strong = scriptedAdapter([[text("strong answer")]]);
    let signal: AbortSignal | undefined;
    const gate = provGate(
      [
        (turn) => {
          signal = turn.signal;
          return bundleOf("fail");
        },
      ],
      {
        onFail: "escalate",
        persist: async () => {
          await whenAborted(signal);
          return undefined;
        },
      },
    );
    const run = await runSingle({
      model: CHEAP,
      _adapter: cheap,
      modelPool: POOL,
      _poolAdapters: new Map<string, ProviderAdapter>([
        [CHEAP, cheap],
        [STRONG, strong],
      ]),
      _scoreboard: scoreboard(),
      turnTimeoutMs: LIMIT_MS,
      provability: gate.provability,
    });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("timeout");
    expect(strong.calls()).toBe(0);
    expect(graded(run.events).map((e) => [e.verdict, e.escalatedTo])).toEqual([
      ["fail", undefined],
    ]);
    expect(skippedEscalations(run)).toEqual([[STRONG, "aborted"]]);
    expectEscalationsAccountedFor(run);
  });

  test("singleTurn: an evaluation judge that overruns the turn timer is the timeout stop — the gate never verifies", async () => {
    // The judge passes the answer, but only after the turn's window closed:
    // the gate's first abort check classifies the stop instead of handing a
    // timed-out turn back as an un-verified success (which would also skip
    // the failing verifier's halt).
    const gate = provGate(["fail"], { onFail: "halt" });
    // The judge answers right after the timer's notice is printed.
    let timerFired: () => void = () => {};
    const fired = new Promise<void>((resolve) => {
      timerFired = resolve;
    });
    const evaluation: RunEvaluation = {
      ...evalGate([1]).evaluation,
      evaluate: async () => {
        await fired;
        return { score: 1, rationale: "slow but sure" };
      },
    };
    const run = await runSingle({
      _adapter: scriptedAdapter([[text("answer")]]),
      turnTimeoutMs: LIMIT_MS,
      evaluation,
      provability: gate.provability,
      stdout: (chunk) => {
        if (chunk.includes("[turn timeout:")) timerFired();
      },
    });
    expect(gate.calls()).toBe(0);
    expect(run.result).toBeUndefined();
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("timeout");
    expect(run.events.filter((e) => e.kind === "eval_graded")).toHaveLength(1);
    expect(graded(run.events)).toHaveLength(0);
  });

  test("REPL: a failing turn retries mid-session, the footer follows the standing answer, the session continues", async () => {
    const adapter = scriptedAdapter([[text("draft")], [text("better")], [text("next")]]);
    const gate = provGate(["fail", "pass"]);
    const run = await runRepl(["hi", "again"], {
      _adapter: adapter,
      provability: gate.provability,
    });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe(""); // clean REPL exit
    expect(adapter.calls()).toBe(3); // turn 1: original + retry; turn 2: one
    expect(graded(run.events).map((e) => [e.verdict, e.retryIndex, e.turnNumber])).toEqual([
      ["fail", 0, 1],
      ["pass", 1, 1],
      ["pass", 0, 2],
    ]);
    expect(run.events.filter((e) => e.kind === "turn_end")).toHaveLength(2);
    // The footer follows each standing answer, never the rejected draft.
    expect(run.stdout.indexOf("better")).toBeLessThan(run.stdout.indexOf(PASS_FOOTER));
    expect(countOf(run.stdout, PASS_FOOTER)).toBe(2);
    expect(run.stdout).not.toContain(FAIL_FOOTER);
    const synthetic = run.logged.filter(
      (l) => l.kind === "user_message" && l.payload?.["synthetic"] === true,
    );
    expect(synthetic).toHaveLength(1);
    // The footer never enters the LIVE transcript: turn 2's request carries
    // the standing answer, never the footer printed after it.
    const turn2 = JSON.stringify(adapter.reqs[2]?.messages);
    expect(turn2).toContain("better");
    expect(turn2).toContain("again");
    expect(turn2).not.toContain("── provability");
  });

  test('REPL: a "reply" footer has no reply to ride on, so it is written to the output — and never enters the transcript', async () => {
    const adapter = scriptedAdapter([[text("ok")], [text("next")]]);
    const gate = provGate(["fail"], { footerTarget: "reply", onFail: "note" });
    const run = await runRepl(["hi", "again"], {
      _adapter: adapter,
      provability: gate.provability,
    });
    expect(run.result).toBe("");
    expect(run.stdout).toContain(`ok\n${FAIL_FOOTER}`);
    const turn2 = JSON.stringify(adapter.reqs[1]?.messages);
    expect(turn2).toContain("ok");
    expect(turn2).toContain("again");
    expect(turn2).not.toContain("── provability");
    const assistant = run.logged.filter((l) => l.kind === "assistant_message");
    expect(assistant).toHaveLength(2);
    expect(JSON.stringify(assistant)).not.toContain("── provability");
  });

  test("REPL: halt is terminal", async () => {
    const run = await runRepl(["hi", "never reached"], {
      _adapter: scriptedAdapter([[text("nope")]]),
      provability: provGate(["fail"], { onFail: "halt" }).provability,
    });
    expect(run.caught).toBeInstanceOf(RunFailedError);
    if (!(run.caught instanceof RunFailedError)) return;
    expect(run.caught.report.class).toBe("provability");
    expect(run.caught.report.exitCode).toBe(37);
    expect(run.events.filter((e) => e.kind === "run_failed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Watch-me partition.
// ---------------------------------------------------------------------------

describe("provability gate — watch-me partition", () => {
  test("provability_graded is durable (session log) and never duplicated into the watch-me sibling", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-provability-watchme-"));
    const prior = process.env["CREWHAUS_WATCHME"];
    process.env["CREWHAUS_WATCHME"] = "1";
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: scriptedAdapter([[text("ok")]]),
        runContext: createRunContext(),
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
        spinner: false,
        stdout: () => {},
        provability: provGate(["pass"]).provability,
      });
      const files = readdirSync(rootDir);
      const sibling = files.filter((f) => f.endsWith(".events.jsonl"));
      expect(sibling).toHaveLength(1);
      const siblingKinds = readFileSync(join(rootDir, sibling[0] ?? ""), "utf-8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => (JSON.parse(l) as { kind: string }).kind);
      expect(siblingKinds).not.toContain("provability_graded");
      expect(gradedLines(readSessionLines(rootDir))).toHaveLength(1);
    } finally {
      process.env["CREWHAUS_WATCHME"] = prior;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance scenario A with the real verifier.
// ---------------------------------------------------------------------------

const GROUNDED: ProvabilityConfig = {
  level: "grounded",
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: [], replay: false, maxReplays: 20 },
  formal: { checkers: ["builtin"], forbid: [], timeoutMs: 30_000 },
};

describe("provability gate — acceptance scenario A (grounded, real verifier)", () => {
  test("a citation of a page never fetched fails; the nudge says so; the model fetches it and the second answer passes", async () => {
    const ANSWER = "The refund window is 14 days [1].\n\n[1]: https://acme.example/policy";
    const PAGE =
      "URL: https://acme.example/policy\nStatus: 200\nContent-Type: text/html\n\nThe refund window is 14 days from the date of purchase.";
    const webFetch = buildTool({
      name: "WebFetch",
      description: "fetch a page",
      inputSchema: z.object({ url: z.string() }).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => PAGE,
    });
    const adapter = scriptedAdapter([
      [text(ANSWER)],
      [
        {
          type: "tool_use",
          id: "toolu_fetch1",
          name: "WebFetch",
          input: { url: "https://acme.example/policy" },
        },
      ],
      [text(ANSWER)],
    ]);
    const provability: RunProvability = {
      level: "grounded",
      onFail: "retry",
      maxRetries: 1,
      threshold: 1,
      render: "footer",
      renderBundle: (bundle, path) => renderFooter(bundle, path !== undefined ? { path } : {}),
      nudge: renderNudge,
      verify: (turn) =>
        verifyDocument(turn.finalText, {
          config: GROUNDED,
          evidence: buildEvidenceIndex(evidenceFromMessages(turn.messages)),
          retryIndex: turn.retryIndex,
        }),
    };
    const run = await runSingle({ _adapter: adapter, tools: [webFetch], provability });
    expect(run.caught).toBeUndefined();
    expect(run.result).toBe(ANSWER);
    expect(adapter.calls()).toBe(3);
    const events = graded(run.events);
    expect(events.map((e) => [e.verdict, e.retryIndex, e.met, e.claims])).toEqual([
      ["fail", 0, 0, 1],
      ["pass", 1, 1, 1],
    ]);
    // The nudge named the unfetched source and why — no fetched content.
    const nudge = lastUserText(adapter.reqs[1]);
    expect(nudge).toContain("this run never fetched or read it");
    expect(nudge).toContain("https://acme.example/policy");
    expect(nudge).not.toContain("from the date of purchase");
    expect(run.stdout).toContain("── provability · grounded ✓ · 1/1 claim · 1 source");
  });
});
