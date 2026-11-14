/**
 * Run spans and verdicts: how a run's work nested, how long each piece took,
 * and what every check decided, written to the run's session log.
 *
 *  - Spans nest on the trace bus: the loop's run span → each turn → the
 *    turn's model calls and tool calls, as siblings → each tool call's checks.
 *    A turn's start and end share one span id; a retried model call is a
 *    sibling of the call it retries and names it (`retryOf`); compactions,
 *    the evaluation judge and provability passes are spans of their turn.
 *    Concurrent tool calls nest under their own spans: each call carries its
 *    span, never one bus-wide current span. The nesting happens whatever
 *    `CREWHAUS_RUN_STAMPS` says.
 *  - `span_closed`, one line per closed span, with its parent, kind, start,
 *    duration and how it ended (`ok`, `error`, `aborted`, `parked` on an
 *    approval, `denied` for a tool call a gate refused).
 *  - `verdict`, one line per gate firing, bound to the run, the check's span
 *    and either the tool call (its toolUseId, its ordinal in the run and the
 *    keyed action digest session-store's decision log uses for the same
 *    action) or the turn's answer. A tool call's verdicts are written when
 *    the call closes, after any approval replay changed what it runs, so
 *    every one names the action that ran.
 *  - Every line a loop writes carries the span it belongs to: its writer's,
 *    else the open turn's, else the loop's (`stampLines`).
 *
 * The lines are written when the loop records its run (`recordsRun` in
 * `./run-records`), best effort: a failed write never fails the run. They
 * hold ids, closed codes, rule ids and timings, never tool input or model
 * text: a judge's or a hook's own words are not copied.
 */
import { createHash } from "node:crypto";
import type { DigestKeyRead } from "@crewhaus/control-records";
import { type FailureClass, isRunFailedError } from "@crewhaus/errors";
import type {
  EventLog,
  SpanAttempt,
  SpanClosedPayload,
  SpanKind,
  SpanStatus,
  SpanTurn,
  VerdictGate,
  VerdictOutcomes,
  VerdictPayload,
  VerdictSubject,
} from "@crewhaus/event-log";
import type { HookResult } from "@crewhaus/hooks-engine";
import type { RunContext } from "@crewhaus/run-context";
import {
  DEFAULT_ROOT_DIR as SESSION_ROOT_DEFAULT,
  approvalsDigestKey,
  hashApprovalInput,
  inputDigestOf,
} from "@crewhaus/session-store";
import {
  type LoopDetection,
  nearToolCallSignature,
  toolCallSignature,
} from "@crewhaus/tool-loop-detection";
import {
  type TraceEventBus,
  type TraceEventEnvelope,
  isValidSpanId,
} from "@crewhaus/trace-event-bus";
import type { RecordEvent } from "./run-records";

// ---------------------------------------------------------------------------
// How a span ended
// ---------------------------------------------------------------------------

/**
 * Whether `err` is a provider or runtime abort. Name-matched rather than
 * `instanceof`: the provider adapters keep the SDK error names through their
 * normalisation layers, so this catches every provider's abort.
 */
export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && (name === "AbortError" || name === "APIUserAbortError");
}

const FAILURE_CLASSES: Readonly<Record<FailureClass, true>> = {
  billing: true,
  auth: true,
  rate_limit: true,
  crewhaus_budget: true,
  timeout: true,
  evaluation: true,
  approval_pending: true,
  provability: true,
  paused: true,
  disabled: true,
  input_blocked: true,
  mcp_boot: true,
  context_overflow: true,
  spec: true,
  config: true,
  tool: true,
  unknown: true,
};

/** A failure class fit for a record: one of the closed set, else nothing. */
function recordableClass(value: unknown): FailureClass | undefined {
  return typeof value === "string" && Object.hasOwn(FAILURE_CLASSES, value)
    ? (value as FailureClass)
    : undefined;
}

/** How a span that `err` ended closed: parked on an approval, aborted, or an error with its class. */
export function spanStatusOf(err: unknown): {
  readonly status: SpanStatus;
  readonly failureClass?: FailureClass;
} {
  if (isRunFailedError(err)) {
    const failureClass = recordableClass(err.report.class);
    const status: SpanStatus = failureClass === "approval_pending" ? "parked" : "error";
    return failureClass !== undefined ? { status, failureClass } : { status };
  }
  if (isAbortError(err)) return { status: "aborted" };
  return { status: "error" };
}

// ---------------------------------------------------------------------------
// The keyed action digest
// ---------------------------------------------------------------------------

/** Reads a session root's approvals digest key, creating nothing. */
export type ActionDigestKeyReader = (rootDir: string) => Promise<DigestKeyRead>;

/**
 * The keyed action digests of one session root: session-store's
 * `inputDigestOf(key, hashApprovalInput(toolName, input))`, the decision
 * log's `inputDigest` for the same action, so a verdict and an approval
 * decision join on one value.
 */
export type ActionDigests = {
  /**
   * A digester for one tool call. While the root has no key it reads the key
   * at most once for the call (a park in this loop creates it); a key once
   * present is kept. No key, an unreadable one or a digest that fails gives
   * `undefined`, never a plain hash: a short input's plain hash can be guessed.
   */
  forCall(): (toolName: string, input: unknown) => Promise<string | undefined>;
};

/**
 * The action digests for the session root a loop's approvals store keeps
 * (`rootDir`, else session-store's default). The key is read only through
 * session-store (`approvalsDigestKey`, injectable as `read`), lazily.
 */
export function actionDigests(
  rootDir: string | undefined,
  read: ActionDigestKeyReader = approvalsDigestKey,
): ActionDigests {
  const root = rootDir ?? SESSION_ROOT_DEFAULT;
  let key: CryptoKey | undefined;
  const readKey = async (): Promise<void> => {
    try {
      const answer = await read(root);
      if (answer.state === "present") key = answer.hmac;
    } catch {
      // An unreadable key is an absent one here: the digest is left out.
    }
  };
  return {
    forCall() {
      let tried = false;
      return async (toolName, input) => {
        if (key === undefined && !tried) {
          tried = true;
          await readKey();
        }
        if (key === undefined) return undefined;
        try {
          return await inputDigestOf(key, hashApprovalInput(toolName, input));
        } catch {
          return undefined;
        }
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Lines stamped with their span
// ---------------------------------------------------------------------------

/**
 * `log`, with every append stamped: the span the writer names when it is a
 * span id, else `defaultSpan()`. The event log writes it on a run-scoped
 * handle and leaves it out on an unscoped one.
 */
export function stampLines(log: EventLog, defaultSpan: () => string | undefined): EventLog {
  return {
    append: (event) => {
      const named = event.span !== undefined && isValidSpanId(event.span) ? event.span : undefined;
      const span = named ?? defaultSpan();
      return log.append(
        span !== undefined
          ? { kind: event.kind, payload: event.payload, span }
          : { kind: event.kind, payload: event.payload },
      );
    },
    read: (opts) => log.read(opts),
    close: () => log.close(),
  };
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/** One gate's decision, before the recorder binds it to what it judged. */
export type VerdictInit = {
  [G in VerdictGate]: {
    readonly gate: G;
    readonly outcome: VerdictOutcomes[G];
    readonly reason?: string;
    readonly rules?: readonly string[];
    readonly mode?: string;
    readonly judge?: VerdictPayload["judge"];
    readonly score?: VerdictPayload["score"];
    readonly hook?: VerdictPayload["hook"];
    readonly next?: "retry" | "escalate";
    readonly refs?: VerdictPayload["refs"];
  };
}[VerdictGate];

/** Where a hook fires: the span its `hook_fired` events nest under, and the tool call it fires for. */
export type HookAt = { readonly span: string; readonly toolUseId?: string };

/** An open tool call's span. */
export type ToolSpan = {
  /** The `tool_call_start` envelope; `tool_call_end` ends it. */
  readonly envelope: TraceEventEnvelope;
  readonly id: string;
  readonly toolUseId: string;
  /** The call's 1-based ordinal in the run. */
  readonly call: number;
  /** An approval replay changed what the call runs to `input` (the approved operative input). */
  replayed(input: unknown): void;
};

/** An open compaction, judge or provability span. */
export type ChildSpan = {
  readonly envelope: TraceEventEnvelope;
  readonly id: string;
  /** Close it, `ok` unless `err` (or a status) says otherwise. Never throws. */
  close(end?: { readonly status: SpanStatus } | { readonly err: unknown }): Promise<void>;
};

/** What a new model call carries about its attempt. */
export type ModelAttempt = { readonly retryOf?: string; readonly attempt?: SpanAttempt };

export type SpanRecorder = {
  /** Whether the loop writes `span_closed` and `verdict` lines. */
  readonly records: boolean;
  /** The loop's run span. */
  readonly loopSpan: string;
  /** The open turn's span, if a turn is open. */
  readonly turnSpan: string | undefined;
  /** The span a line belongs to when its writer names none: the open turn's, else the loop's. */
  lineSpan(): string;
  /** Where a hook fired in the open turn nests, if a turn is open. */
  turnAt(): HookAt | undefined;

  /** Open a turn: its `turn_start` envelope, under the loop span. */
  openTurn(): TraceEventEnvelope;
  /** Close the open turn (if any). */
  closeTurn(status: SpanStatus, failureClass?: FailureClass): Promise<void>;
  /** The loop is unwinding on `err`: the open turn closes as `err` says, and so will the loop. */
  thrown(err: unknown): Promise<void>;
  /** Close the loop's run span, as the loop ended. */
  closeLoop(): Promise<void>;
  /** The turn re-runs its answer: later model calls belong to the next attempt. */
  beginAttempt(cause: "eval" | "provability" | "escalation"): void;
  /** The turn's attempt index (0 for its first answer). */
  attemptIndex(): number;

  /** A model call opened under `envelope`: what it carries about its attempt. */
  openModel(envelope: TraceEventEnvelope): ModelAttempt;
  /** The call's ordinal in the run, as its manifest numbered it. */
  noteCall(span: string, call: number | undefined): void;
  /** Close a model call: `ok`, or as `err` ended it (a failed call is the next call's `retryOf`). */
  closeModel(span: string, err?: unknown): Promise<void>;

  /** Open a tool call's span under the open turn; `requested` is the operative input the model sent. */
  openTool(toolUseId: string, toolName: string, requested: unknown): ToolSpan;
  /** Close a tool call: write its verdicts, then its `span_closed`. Idempotent. */
  closeTool(
    tool: ToolSpan,
    end: { readonly isError: boolean } | { readonly err: unknown },
  ): Promise<void>;
  /** The call's action digest, for an audit record (computed once and shared with its verdicts). */
  toolDigest(tool: ToolSpan): Promise<string | undefined>;

  /** Open a compaction, judge or provability span under the open turn (else the loop). */
  openChild(kind: "compaction" | "judge" | "provability"): ChildSpan;

  /**
   * Record one verdict on `span`: queued on an open tool call's span (written
   * when the call closes), else written at once about the turn's answer.
   */
  verdict(span: string, init: VerdictInit): Promise<void>;
  /** One `hook` verdict per hook that fired at `at`. */
  hookVerdicts(at: HookAt, event: string, results: ReadonlyArray<HookResult>): Promise<void>;
  /** A loop-detector verdict, about the newest call the detection counted. */
  loopVerdict(detection: LoopDetection, outcome: VerdictOutcomes["loop"]): Promise<void>;
  /** Write a closed span someone else measured (a sub-agent's), on this run. */
  writeSpanClosed(payload: SpanClosedPayload, toolUseId?: string): Promise<void>;
};

type OpenSpan = {
  readonly id: string;
  readonly parent: string | undefined;
  readonly kind: SpanKind;
  readonly startedAt: string;
  readonly t0: number;
  readonly turn?: SpanTurn;
  attempt?: SpanAttempt;
  call?: number;
  toolUseId?: string;
};

type ToolDigests = {
  readonly actionDigest?: string;
  readonly requestedDigest?: string;
};

type ToolState = OpenSpan & {
  readonly toolUseId: string;
  readonly call: number;
  readonly toolName: string;
  readonly requested: unknown;
  acting: unknown;
  replayed: boolean;
  refused: boolean;
  closed: boolean;
  digester: (toolName: string, input: unknown) => Promise<string | undefined>;
  digests?: ToolDigests;
  readonly queued: VerdictInit[];
};

/** A closed tool call, kept for the loop detector's verdicts. */
type ClosedTool = {
  readonly span: string;
  readonly subject: Extract<VerdictSubject, { kind: "tool" }>;
  readonly exact: string;
  readonly near: string;
};

/** How many closed tool calls a loop keeps for its loop verdicts (the detector's window is smaller). */
const CLOSED_TOOLS_KEPT = 64;

/** The buses whose root span a loop already took: a later loop on the bus gets a span of its own. */
const claimedBuses = new WeakSet<TraceEventBus>();

/** Tool calls made per run, so a tool call's ordinal counts the run's calls, whichever loop made them. */
const toolCallsByRun = new WeakMap<RunContext, { n: number }>();

/** A verdict that refuses the call before it runs: the call closes `denied`. */
function refuses(v: VerdictInit): boolean {
  switch (v.gate) {
    case "permission":
      return v.outcome === "deny" || v.outcome === "ask:denied";
    case "justification":
      return v.outcome === "deny";
    case "egress":
      return v.outcome === "block";
    case "hook":
      return v.outcome === "deny" && v.hook?.event === "pre-tool";
    case "rate-limit":
      return true;
    case "approval":
      return v.outcome === "refused";
    default:
      return false;
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A verdict's fields after `on`, in a fixed order. */
function verdictTail(v: VerdictInit): Omit<VerdictPayload, "v" | "run" | "span" | "on"> {
  return {
    gate: v.gate,
    outcome: v.outcome,
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    ...(v.rules !== undefined && v.rules.length > 0 ? { rules: [...v.rules] } : {}),
    ...(v.mode !== undefined ? { mode: v.mode } : {}),
    ...(v.judge !== undefined ? { judge: v.judge } : {}),
    ...(v.score !== undefined ? { score: v.score } : {}),
    ...(v.hook !== undefined ? { hook: v.hook } : {}),
    ...(v.next !== undefined ? { next: v.next } : {}),
    ...(v.refs !== undefined ? { refs: v.refs } : {}),
  };
}

/**
 * The loop's span recorder. The first loop on a bus takes the bus's root span
 * as its run span; a later loop on the same bus (crew roles, workflow steps
 * that share a context) gets a span of its own under the root. Nothing is
 * written unless `records`; the nesting on the bus happens either way.
 */
export function createSpanRecorder(args: {
  readonly runContext: RunContext;
  readonly bus: TraceEventBus;
  readonly records: boolean;
  readonly write: RecordEvent;
  /** The turns the session already held when the loop started. */
  readonly sessionTurnBase: number;
  readonly digests: ActionDigests;
  /** Clock for `startedAt` (durations come from `performance.now()`). */
  readonly now?: () => Date;
}): SpanRecorder {
  const { runContext, bus, records, write } = args;
  const now = args.now ?? (() => new Date());
  const run = runContext.runId;

  const firstOnBus = !claimedBuses.has(bus);
  claimedBuses.add(bus);
  const loop: OpenSpan = firstOnBus
    ? {
        id: bus.rootSpanId,
        parent: bus.rootParentSpanId,
        kind: "run",
        startedAt: now().toISOString(),
        t0: performance.now(),
      }
    : {
        id: bus.envelope().spanId,
        parent: bus.rootSpanId,
        kind: "run",
        startedAt: now().toISOString(),
        t0: performance.now(),
      };
  let loopFailure: { readonly err: unknown } | undefined;
  let loopClosed = false;

  let turn: OpenSpan | undefined;
  let attempt = 0;
  let attemptCause: SpanAttempt["cause"];
  let pendingRetry: string | undefined;
  const models = new Map<string, OpenSpan>();
  const tools = new Map<string, ToolState>();
  const closedTools: ClosedTool[] = [];

  const turnNumbers = (): SpanTurn => ({
    run: runContext.turnNumber,
    session: args.sessionTurnBase + runContext.turnNumber,
  });

  const writeClosed = async (
    span: OpenSpan,
    status: SpanStatus,
    failureClass?: FailureClass,
  ): Promise<void> => {
    if (!records) return;
    const payload: SpanClosedPayload = {
      v: 1,
      run,
      span: span.id,
      ...(span.parent !== undefined ? { parent: span.parent } : {}),
      kind: span.kind,
      ...(span.toolUseId !== undefined ? { toolUseId: span.toolUseId } : {}),
      ...(span.call !== undefined ? { call: span.call } : {}),
      ...(span.turn !== undefined ? { turn: span.turn } : {}),
      ...(span.attempt !== undefined ? { attempt: span.attempt } : {}),
      startedAt: span.startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - span.t0)),
      status,
      ...(failureClass !== undefined ? { failureClass } : {}),
    };
    await write("span_closed", payload, span.id);
  };

  const writeVerdict = async (span: string, on: VerdictSubject, v: VerdictInit): Promise<void> => {
    if (!records) return;
    const payload: VerdictPayload = { v: 1, run, span, on, ...verdictTail(v) };
    await write("verdict", payload, span);
  };

  const answer = (): VerdictSubject => ({
    kind: "answer",
    turn: turn?.turn ?? turnNumbers(),
    attempt,
  });

  const open = (
    kind: SpanKind,
    parent: string | undefined,
  ): OpenSpan & { envelope: TraceEventEnvelope } => {
    const envelope = bus.envelope(undefined, { parentSpanId: parent });
    return {
      envelope,
      id: envelope.spanId,
      parent: envelope.parentSpanId,
      kind,
      startedAt: now().toISOString(),
      t0: performance.now(),
      ...(turn?.turn !== undefined ? { turn: turn.turn } : {}),
    };
  };

  const digestsOf = async (tool: ToolState, reread: boolean): Promise<ToolDigests> => {
    if (tool.digests !== undefined && (tool.digests.actionDigest !== undefined || !reread)) {
      return tool.digests;
    }
    // A park in this call may have made the key since the call's own read.
    const digester = tool.digests !== undefined ? args.digests.forCall() : tool.digester;
    try {
      const actionDigest = await digester(tool.toolName, tool.acting);
      const requestedDigest =
        actionDigest !== undefined && tool.replayed
          ? await digester(tool.toolName, tool.requested)
          : undefined;
      tool.digests = {
        ...(actionDigest !== undefined ? { actionDigest } : {}),
        ...(requestedDigest !== undefined ? { requestedDigest } : {}),
      };
    } catch {
      tool.digests = {};
    }
    return tool.digests;
  };

  const recorder: SpanRecorder = {
    records,
    loopSpan: loop.id,
    get turnSpan() {
      return turn?.id;
    },
    lineSpan() {
      return turn?.id ?? loop.id;
    },
    turnAt() {
      return turn !== undefined ? { span: turn.id } : undefined;
    },

    openTurn() {
      const envelope = bus.envelope(undefined, { parentSpanId: loop.id });
      turn = {
        id: envelope.spanId,
        parent: envelope.parentSpanId,
        kind: "turn",
        startedAt: now().toISOString(),
        t0: performance.now(),
        turn: turnNumbers(),
      };
      attempt = 0;
      attemptCause = undefined;
      pendingRetry = undefined;
      return envelope;
    },
    async closeTurn(status, failureClass) {
      const closing = turn;
      if (closing === undefined) return;
      turn = undefined;
      pendingRetry = undefined;
      try {
        await writeClosed(closing, status, failureClass);
      } catch {
        // `write` never throws; a payload that cannot be built is skipped.
      }
    },
    async thrown(err) {
      loopFailure = { err };
      if (turn === undefined) return;
      const { status, failureClass } = spanStatusOf(err);
      await recorder.closeTurn(status, failureClass);
    },
    async closeLoop() {
      if (loopClosed) return;
      loopClosed = true;
      const ended =
        loopFailure !== undefined ? spanStatusOf(loopFailure.err) : { status: "ok" as const };
      if (turn !== undefined) await recorder.closeTurn(ended.status, ended.failureClass);
      await writeClosed(loop, ended.status, ended.failureClass);
    },
    beginAttempt(cause) {
      attempt += 1;
      attemptCause = cause;
      pendingRetry = undefined;
    },
    attemptIndex() {
      return attempt;
    },

    openModel(envelope) {
      const retryOf = pendingRetry;
      pendingRetry = undefined;
      const spanAttempt: SpanAttempt | undefined =
        retryOf !== undefined
          ? { index: attempt, retryOf, cause: "recovery" }
          : attempt > 0
            ? { index: attempt, ...(attemptCause !== undefined ? { cause: attemptCause } : {}) }
            : undefined;
      models.set(envelope.spanId, {
        id: envelope.spanId,
        parent: envelope.parentSpanId,
        kind: "model",
        startedAt: now().toISOString(),
        t0: performance.now(),
        ...(turn?.turn !== undefined ? { turn: turn.turn } : {}),
        ...(spanAttempt !== undefined ? { attempt: spanAttempt } : {}),
      });
      return {
        ...(retryOf !== undefined ? { retryOf } : {}),
        ...(spanAttempt !== undefined ? { attempt: spanAttempt } : {}),
      };
    },
    noteCall(span, call) {
      const model = models.get(span);
      if (model !== undefined && call !== undefined) model.call = call;
    },
    async closeModel(span, err) {
      const model = models.get(span);
      if (model === undefined) return;
      models.delete(span);
      if (err === undefined) {
        await writeClosed(model, "ok");
        return;
      }
      const { status, failureClass } = spanStatusOf(err);
      // The next call this turn makes is recovery's retry of this one.
      if (status === "error") pendingRetry = span;
      await writeClosed(model, status, failureClass);
    },

    openTool(toolUseId, toolName, requested) {
      const counter = toolCallsByRun.get(runContext) ?? { n: 0 };
      toolCallsByRun.set(runContext, counter);
      counter.n += 1;
      const base = open("tool", turn?.id);
      const state: ToolState = {
        ...base,
        toolUseId,
        call: counter.n,
        toolName,
        requested,
        acting: requested,
        replayed: false,
        refused: false,
        closed: false,
        digester: args.digests.forCall(),
        queued: [],
      };
      tools.set(state.id, state);
      return {
        envelope: base.envelope,
        id: state.id,
        toolUseId,
        call: counter.n,
        replayed(input) {
          state.acting = input;
          state.replayed = true;
        },
      };
    },
    async closeTool(tool, end) {
      const state = tools.get(tool.id);
      if (state === undefined || state.closed) return;
      state.closed = true;
      tools.delete(tool.id);
      const ended =
        "err" in end
          ? spanStatusOf(end.err)
          : { status: (end.isError ? (state.refused ? "denied" : "error") : "ok") as SpanStatus };
      if (!records) return;
      const digests = await digestsOf(state, ended.status === "parked");
      const subject: Extract<VerdictSubject, { kind: "tool" }> = {
        kind: "tool",
        toolUseId: state.toolUseId,
        call: state.call,
        ...digests,
      };
      for (const v of state.queued) await writeVerdict(state.id, subject, v);
      await writeClosed(state, ended.status, ended.failureClass);
      closedTools.push({
        span: state.id,
        subject,
        exact: sha256(toolCallSignature(state.toolName, state.requested)),
        near: sha256(nearToolCallSignature(state.toolName, state.requested)),
      });
      if (closedTools.length > CLOSED_TOOLS_KEPT) closedTools.shift();
    },
    async toolDigest(tool) {
      const state = tools.get(tool.id);
      if (state === undefined) return undefined;
      return (await digestsOf(state, false)).actionDigest;
    },

    openChild(kind) {
      const span = open(kind, turn?.id ?? loop.id);
      let closed = false;
      return {
        envelope: span.envelope,
        id: span.id,
        async close(end) {
          if (closed) return;
          closed = true;
          const ended =
            end === undefined
              ? { status: "ok" as const }
              : "err" in end
                ? spanStatusOf(end.err)
                : { status: end.status };
          await writeClosed(span, ended.status, ended.failureClass);
        },
      };
    },

    async verdict(span, init) {
      const tool = tools.get(span);
      if (tool !== undefined && !tool.closed) {
        if (refuses(init)) tool.refused = true;
        if (records) tool.queued.push(init);
        return;
      }
      await writeVerdict(span, answer(), init);
    },
    async hookVerdicts(at, event, results) {
      for (const r of results) {
        // Read defensively: a result is the hook runner's, and a verdict never
        // changes what the hook decided.
        const matcher = r?.hook?.matcher;
        const durationMs = typeof r?.durationMs === "number" ? r.durationMs : 0;
        await recorder.verdict(at.span, {
          gate: "hook",
          outcome: r?.decision?.decision === "allow" ? "allow" : "deny",
          hook: {
            event,
            ...(typeof matcher === "string" && matcher !== "" ? { matcher } : {}),
            durationMs: Math.max(0, Math.round(durationMs)),
          },
        });
      }
    },
    async loopVerdict(detection, outcome) {
      if (!records) return;
      const wanted = sha256(detection.signature);
      for (let i = closedTools.length - 1; i >= 0; i -= 1) {
        const closed = closedTools[i] as ClosedTool;
        if ((detection.tier === "exact" ? closed.exact : closed.near) !== wanted) continue;
        await writeVerdict(closed.span, closed.subject, { gate: "loop", outcome });
        return;
      }
    },
    async writeSpanClosed(payload, toolUseId) {
      if (!records || !isValidSpanId(payload.span)) return;
      await write(
        "span_closed",
        {
          ...payload,
          run,
          ...(toolUseId !== undefined && payload.toolUseId === undefined ? { toolUseId } : {}),
        },
        payload.span,
      );
    },
  };
  return recorder;
}
