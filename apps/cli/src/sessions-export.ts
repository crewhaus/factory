/**
 * Loop contract 0.4 (Batch B, G53) — `crewhaus sessions export --format
 * trajectories`: assemble (state, action, observation, reward) tuples from
 * session event logs (`.crewhaus/sessions/<id>.jsonl`) plus a session's
 * persisted trace events when a sibling `<id>.events.jsonl` exists (the
 * layout eval per-sample artifacts use for `events.jsonl`).
 *
 * G53 POSITIONING (decided, per AGENT-LOOPS-PLAN): trajectory-level RL on
 * agent scaffolds remains EXPERIMENTAL — inference-time scaffolding
 * (eval → optimize → flywheel) is the mature improvement lane. This export
 * exists so an external trainer can consume real sessions in a standard
 * shape; the meta-harness optimizer stays an opt-in experiment and is
 * deliberately NOT wired into `crewhaus optimize` in this batch (there is
 * no `--mutator meta-harness`).
 *
 * Tuple semantics (one JSONL line per assistant action):
 *   - `state`   — the FULL message prefix before the action (user text,
 *                 prior assistant actions, tool results), verbatim. Chosen
 *                 over a delta encoding so every line is independently
 *                 consumable; the O(n²) duplication is the documented cost
 *                 of an experimental export.
 *   - `action`  — the assistant's response: its text and/or the tool calls
 *                 it made (one model response = one action, even when it
 *                 fans out to several tools).
 *   - `observation` — what the environment returned: the action's tool
 *                 results (name-joined via the granular `tool_use` events),
 *                 or `null` for a plain text turn.
 *   - `reward`  — terminal-sparse: `null` on every step except the
 *                 session's last, which carries the reward ladder below.
 *
 * Reward ladder (G53): the LAST `eval_graded` score when the session
 * carries one — accepted both as a durable event-log line and as a trace
 * event in the sibling events file — else the LATEST user rating
 * (`user_feedback`), normalized to [0,1] by the same convention distill
 * uses (thumbs up→1/down→0, stars (n−1)/4, scale span-normalized), else
 * `null`. `rewardSource` says which rung fired.
 *
 * Every parser here is tolerant: unknown event kinds are skipped (the
 * session-log reader contract), malformed lines are dropped, and payloads
 * are duck-typed — a hand-edited log must never abort an export.
 *
 * Side-effect-free (the CLI entry file runs an argv switch on import), so
 * assembly is unit-testable without spawning a subprocess.
 */
import { extractFeedbackRecords, mergeFeedback, normalizeRating } from "./feedback";

/** A parsed event-log line, duck-typed (see session-store's parseSessionLog). */
export type LoggedEvent = { kind?: string; payload?: unknown };

export type TrajectoryToolCall = {
  readonly tool: string;
  readonly input: unknown;
};

/** One message in a step's `state` prefix. `role: "tool"` is a tool result. */
export type TrajectoryMessage = {
  readonly role: "user" | "assistant" | "tool";
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<TrajectoryToolCall>;
  readonly isError?: boolean;
  /** Runtime-injected user message (e.g. an evaluation-retry correction). */
  readonly synthetic?: boolean;
};

export type TrajectoryAction = {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<TrajectoryToolCall>;
};

export type TrajectoryObservation = {
  readonly results: ReadonlyArray<{
    readonly tool?: string;
    readonly text: string;
    readonly isError: boolean;
  }>;
} | null;

export type TrajectoryRewardSource = "eval_graded" | "user_rating";

export type TrajectoryStep = {
  readonly sessionId: string;
  /** 0-based step index within the session. */
  readonly step: number;
  readonly state: ReadonlyArray<TrajectoryMessage>;
  readonly action: TrajectoryAction;
  readonly observation: TrajectoryObservation;
  readonly reward: number | null;
  readonly rewardSource?: TrajectoryRewardSource;
};

// -------- tolerant payload parsing --------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract the USER text of a `user_message` payload. String content is user
 * text; array content contributes its `text` blocks. A block array with no
 * text blocks (the API-shape tool_result round the runtime also logs as a
 * user message) returns undefined — those results are consumed from the
 * granular `tool_result` events instead, so they are never double-counted.
 */
function userText(payload: unknown): string | undefined {
  const p = asRecord(payload);
  if (p === undefined) return undefined;
  const content = p["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b !== undefined && b["type"] === "text" && typeof b["text"] === "string") {
      texts.push(b["text"]);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Parse an `assistant_message` payload into the action's text + tool calls. */
function assistantAction(payload: unknown): TrajectoryAction | undefined {
  const p = asRecord(payload);
  if (p === undefined) return undefined;
  const content = p["content"];
  if (typeof content === "string") {
    return content.length > 0 ? { text: content } : {};
  }
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  const toolCalls: TrajectoryToolCall[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b === undefined) continue;
    if (b["type"] === "text" && typeof b["text"] === "string") texts.push(b["text"]);
    if (b["type"] === "tool_use" && typeof b["name"] === "string") {
      toolCalls.push({ tool: b["name"], input: b["input"] });
    }
  }
  return {
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

// -------- reward ladder --------

/**
 * The LAST `eval_graded` score across the durable log and the trace-event
 * file, in that order (the trace file is today's canonical carrier; a
 * future durable mirror wins nothing extra — last write wins). Accepts both
 * the event-log envelope (`{kind, payload: {score}}`) and the flat trace
 * shape (`{kind, score}`).
 */
function lastEvalGradedScore(
  events: ReadonlyArray<LoggedEvent>,
  traceEvents: ReadonlyArray<unknown>,
): number | undefined {
  let last: number | undefined;
  const consider = (value: unknown): void => {
    const r = asRecord(value);
    if (r === undefined || r["kind"] !== "eval_graded") return;
    const flat = r["score"];
    const nested = asRecord(r["payload"])?.["score"];
    const score = typeof flat === "number" ? flat : nested;
    if (typeof score === "number" && Number.isFinite(score)) last = score;
  };
  for (const e of events) consider(e);
  for (const e of traceEvents) consider(e);
  return last;
}

/** The latest (by record ts) numeric user rating for this session, in [0,1]. */
function latestUserRating(
  sessionId: string,
  events: ReadonlyArray<LoggedEvent>,
): number | undefined {
  const records = mergeFeedback(extractFeedbackRecords(events)).filter(
    (r) => r.sessionId === sessionId,
  );
  let best: { ts: string; score: number } | undefined;
  for (const r of records) {
    const score = normalizeRating(r);
    if (score === undefined) continue;
    if (best === undefined || r.ts >= best.ts) best = { ts: r.ts, score };
  }
  return best?.score;
}

/** Resolve the session's terminal reward per the G53 ladder. */
export function resolveSessionReward(
  sessionId: string,
  events: ReadonlyArray<LoggedEvent>,
  traceEvents: ReadonlyArray<unknown> = [],
): { score: number; source: TrajectoryRewardSource } | undefined {
  const graded = lastEvalGradedScore(events, traceEvents);
  if (graded !== undefined) return { score: graded, source: "eval_graded" };
  const rating = latestUserRating(sessionId, events);
  if (rating !== undefined) return { score: rating, source: "user_rating" };
  return undefined;
}

// -------- assembly --------

/**
 * Assemble one session's trajectory steps from its event log (+ optional
 * trace events). Returns [] for sessions with no assistant action.
 */
export function assembleTrajectory(
  sessionId: string,
  events: ReadonlyArray<LoggedEvent>,
  traceEvents: ReadonlyArray<unknown> = [],
): TrajectoryStep[] {
  // toolUseId → tool name, from the granular tool_use events, so each
  // observation entry can carry the tool it came from.
  const toolNameById = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    const p = asRecord(ev.payload);
    if (p !== undefined && typeof p["id"] === "string" && typeof p["name"] === "string") {
      toolNameById.set(p["id"], p["name"]);
    }
  }

  type PendingStep = {
    readonly state: TrajectoryMessage[];
    readonly action: TrajectoryAction;
    readonly results: Array<{ tool?: string; text: string; isError: boolean }>;
  };

  const steps: Array<Omit<TrajectoryStep, "reward">> = [];
  const history: TrajectoryMessage[] = [];
  let pending: PendingStep | undefined;

  const flush = (): void => {
    if (pending === undefined) return;
    steps.push({
      sessionId,
      step: steps.length,
      state: pending.state,
      action: pending.action,
      observation: pending.results.length > 0 ? { results: pending.results } : null,
    });
    pending = undefined;
  };

  for (const ev of events) {
    if (ev.kind === "user_message") {
      const text = userText(ev.payload);
      if (text === undefined) continue; // tool_result round — consumed granularly
      flush();
      const synthetic = asRecord(ev.payload)?.["synthetic"] === true;
      history.push({ role: "user", text, ...(synthetic ? { synthetic: true } : {}) });
    } else if (ev.kind === "assistant_message") {
      const action = assistantAction(ev.payload);
      if (action === undefined) continue;
      flush();
      pending = { state: [...history], action, results: [] };
      history.push({ role: "assistant", ...action });
    } else if (ev.kind === "tool_result") {
      const p = asRecord(ev.payload);
      if (p === undefined) continue;
      const toolUseId = p["toolUseId"];
      const tool = typeof toolUseId === "string" ? toolNameById.get(toolUseId) : undefined;
      const entry = {
        ...(tool !== undefined ? { tool } : {}),
        text: typeof p["content"] === "string" ? p["content"] : "",
        isError: p["isError"] === true,
      };
      if (pending !== undefined) pending.results.push(entry);
      history.push({
        role: "tool",
        text: entry.text,
        ...(entry.isError ? { isError: true } : {}),
      });
    }
    // Every other kind (cost_accrual, permission, model_meta, compaction,
    // wiki_write, …) is non-conversational — skipped by contract.
  }
  flush();

  if (steps.length === 0) return [];
  const reward = resolveSessionReward(sessionId, events, traceEvents);
  return steps.map((s, i) =>
    i === steps.length - 1 && reward !== undefined
      ? { ...s, reward: reward.score, rewardSource: reward.source }
      : { ...s, reward: null },
  );
}

/** Serialize steps as JSONL (one line per step; trailing newline when any). */
export function trajectoryStepsToJsonl(steps: ReadonlyArray<TrajectoryStep>): string {
  if (steps.length === 0) return "";
  return `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`;
}

/** Tolerant JSONL parse for the sibling trace-events file. */
export function parseJsonlLoose(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A malformed line must not abort the export.
    }
  }
  return out;
}
