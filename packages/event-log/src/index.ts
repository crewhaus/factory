/**
 * Catalog R7 `event-log` — append-only JSONL transcript per session.
 *
 * One event per line at `<rootDir>/<sessionId>.jsonl` (default rootDir
 * `.crewhaus/sessions`). Every line is a self-describing JSON object:
 * `{ ts, version: 1, kind, payload }`. The schema-version field is
 * stamped onto every event so future migrations can fan out on it.
 *
 * Append semantics: each `append()` calls `appendFileSync(...)` with
 * mode 0o600 (owner-only) per the
 * `claude-code/utils/sessionStorage.ts` precedent. Synchronous append on
 * POSIX is atomic per line (when `len < PIPE_BUF`), so concurrent runs
 * cannot interleave partial JSON. The API is async to keep the door open
 * for a future buffered-writer optimisation; today it resolves
 * immediately.
 *
 * Read semantics: `read({ since?, until? })` opens a fresh read stream
 * via `node:readline`, parses each line as JSON, and yields events in
 * insertion order (filtered by epoch `ts` if either bound is supplied).
 * Missing files yield zero events. A malformed line throws
 * `RuntimeError` carrying the line number — event logs must round-trip
 * cleanly.
 *
 * Reference: `claude-code/utils/sessionStorage.ts`,
 * `AI-Harness-Systems.md` §append-only event history.
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { RuntimeError } from "@crewhaus/errors";
import { assertSamePath, currentTenantContext, requireTenant } from "@crewhaus/tenancy";

export const DEFAULT_ROOT_DIR = ".crewhaus/sessions";
const ID_REGEX = /^sess_[0-9a-f]{16}$/;

export type EventKind =
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"
  | "error"
  // v0.3.0 Goal 6 — the structured TERMINAL failure record, appended by
  // runtime-core immediately before the run-ending throw (mirrors the
  // `run_failed` trace event; payload `{ class, message, remediation?,
  // exitCode }` from the thrown FailureReport). The pre-existing `error`
  // kind records every recoverable model-call error as it happens; this
  // kind records the ONE failure the run actually died with, so offline
  // consumers (`crewhaus advise`, incident collection, session viewers)
  // can tell "the run ended because the provider account is out of
  // funding (exit 31)" without re-deriving it from the recovery ladder.
  // Non-conversational: `replayMessageHistory` ignores it, so `--resume`
  // is unaffected, and readers written before this kind existed keep
  // parsing (every session-log reader branches on the kinds it knows).
  | "run_failed"
  // v0.3.0 Goal 1 (§2.3) — verbatim externalization of content EVICTED by
  // compaction, appended by runtime-core BEFORE `snip` drops middle messages
  // and BEFORE `autoCompact` replaces history (gated on the continuity
  // seam's `ledger !== false`). Payload `{ role: "user" | "assistant" |
  // "tool", text, turnNumber? }` — `text` is the evicted content verbatim,
  // zero model trust. Evicted USER messages are additionally folded into the
  // in-run requirements ledger and re-injected into every model call's
  // `<requirements_ledger>` tail block, so a user's clarification answer
  // survives any number of compactions regardless of summary quality; the
  // assistant/tool records are episodic externalization for a later recall
  // integration. `--resume` rebuilds the ledger deterministically from these
  // events. Non-conversational: `replayMessageHistory` ignores it, so
  // `--resume` replay is unaffected, and readers written before this kind
  // existed keep parsing (every session-log reader branches on the kinds it
  // knows and skips the rest).
  | "context_evicted"
  // Payload today: `{ kind: "snip" | "autocompact" | "reactive", before,
  // after }` message counts, PLUS (v0.3.0 §2.3, additive) `summary?` — the
  // verbatim autocompact summary TEXT that replaced the history, persisted
  // so post-mortems and verifiers can check what the model claimed the
  // conversation contained (before/after counts alone said nothing about
  // WHAT survived). Absent on pure snip steps and on records written before
  // v0.3.0; old readers skip the unknown field.
  | "compaction"
  | "sub_agent_start"
  | "sub_agent_end"
  // Section 22 — CRW (multi-agent crew) lifecycle events. Single durable
  // sessionId across an entire crew run; every role's turn writes here.
  | "role_start"
  | "role_end"
  | "handoff"
  | "a2a_message"
  // a2a_turn_start / a2a_turn_end bracket the nested inline `runChatLoop`
  // an A2A peer call drives. Because every role in a crew shares one
  // session JSONL, the peer's `user_message` + `assistant_message`
  // events land in the parent's log; on a later role's `resume`,
  // `replayMessageHistory` uses these markers to skip the peer's nested
  // transcript and keep the parent's `tool_use → tool_result` pair
  // immediately adjacent (Claude API requires it). Symmetric to
  // `sub_agent_start/end` for Section-13 sub-agents.
  | "a2a_turn_start"
  | "a2a_turn_end"
  | "crew_done"
  // Section 27 — per-call cost accrual mirrored from the trace bus into the
  // session JSONL (opt-in via CREWHAUS_COST_TRACKING) so
  // `crewhaus cost-summary --session <id>` can sum spend after a run. It is not
  // a conversational message, so `replayMessageHistory` ignores it and resume
  // is unaffected.
  | "cost_accrual"
  // A human rating on a specific assistant turn — a thumbs up/down, a
  // star/scale score, and/or a free-text comment or correction. Written by
  // the `crewhaus rate`/`feedback` capture surfaces and read back by
  // `crewhaus distill` to synthesize eval datasets + graders. Like
  // `cost_accrual` it is non-conversational, so `replayMessageHistory`
  // ignores it and `--resume` is unaffected. Payload is a `FeedbackRecord`.
  | "user_feedback"
  // Advisor groundwork (AUTOMATION-OPPORTUNITIES items 14/15/17) — durable
  // mirrors of runtime signals that previously lived only on the in-process
  // trace bus, persisted by runtime-core's advisor subscriber (default-on,
  // disable with CREWHAUS_ADVISOR_EVENTS=0) so `crewhaus advise` can mine
  // sessions offline. All four are non-conversational: `replayMessageHistory`
  // ignores them (so `--resume` is unaffected) and readers written before
  // these kinds existed keep parsing, because every session-log reader
  // branches on the kinds it knows and skips the rest.
  //
  // One recovery-engine action (payload `{ errorName, action, depth }`),
  // mirrored from the `error_recovered` trace event. `action: "continue"`
  // is emitted exclusively for `max_output_tokens` truncations
  // (recovery-engine's taxonomy), so counting it measures truncation
  // pressure directly.
  | "recovery"
  // One line PER TOOL CALL (payload `{ toolName, durationMs, isError }`),
  // mirrored from `tool_call_end`. Granularity decision: per-call, not a
  // per-turn aggregate — the session log already carries a full `tool_use`
  // line (entire input JSON) and `tool_result` line (entire output text)
  // for every call, so this ~100-byte stats line adds a few percent to the
  // per-call footprint at worst while preserving the per-call latency/error
  // distribution a per-turn aggregate would destroy.
  | "tool_stats"
  // One line per RESOLVED permission decision (payload `{ toolName,
  // decision, askOutcome }`). `decision` is allow|deny|ask; `askOutcome` is
  // "approved"/"denied" for a resolved ask prompt and null for allow/deny
  // decisions. An ask that never resolves (e.g. the run is killed at the
  // prompt) writes nothing — only outcomes persist.
  | "permission"
  // One line per model response (payload `{ stopReason, model }`), mirrored
  // from `model_response`. Persists the stop-reason distribution
  // (end_turn / tool_use / max_tokens / refusal / …) that was previously
  // trace-bus-only.
  | "model_meta"
  // Ops item 38 — one line PER MCP TOOL CALL (payload `{ server, toolName,
  // durationMs, isError }`), mirrored from the `mcp_call_end` trace event by
  // runtime-core's mcp-stats subscriber (default-on with the advisor events;
  // disable with CREWHAUS_ADVISOR_EVENTS=0). `mcp_call_start`/`mcp_call_end`
  // are trace-bus-ONLY today — nothing durable records per-server MCP health,
  // so `crewhaus mcp doctor` had no history to score. This durable mirror is
  // that history: per-server error-rate + latency over past sessions.
  // Non-conversational, so `replayMessageHistory` ignores it and `--resume` is
  // unaffected; readers written before this kind existed keep parsing (each
  // session-log reader branches on the kinds it knows and skips the rest).
  | "mcp_stats"
  // Adaptive model routing — one line per ROUTING DECISION when an
  // `agent.model_pool` is active (payload `{ turnNumber, routeKey, model,
  // policy, reason, explored, policyVersion? }`), written by runtime-core's
  // pool router. A turn that runs tools re-routes as the difficulty band
  // shifts, so multiple lines can share one `turnNumber`. Feeds `crewhaus
  // route explain <session>`. Non-conversational, so `replayMessageHistory`
  // ignores it and `--resume` is unaffected.
  | "model_route"
  // 0.3.0 memory release (design §9) — one line per wiki mutation (payload
  // `WikiWriteEventPayload`), emitted by @crewhaus/tool-wiki through its
  // injected append seam (the emitter / memory-service composition root
  // decides where it lands). Non-conversational, so `replayMessageHistory`
  // ignores it and `--resume` is unaffected; readers written before this
  // kind existed keep parsing. Additive — kept on its own line so the
  // parallel 0.3.0 branches (plan_update/goal_update/action_proof,
  // run_failed) merge trivially.
  | "wiki_write"
  // v0.3.0 continuity (design §2.4) — plan/goal mutations and machine-checked
  // action proof, appended by `@crewhaus/tool-plan` through its injected
  // append seam (the tool package stays decoupled from runtime wiring). All
  // three are non-conversational: `replayMessageHistory` ignores them and
  // readers written before these kinds existed keep parsing (every session-log
  // reader branches on the kinds it knows and skips the rest). Payload shapes
  // are exported below as `PlanUpdateEventPayload` / `GoalUpdateEventPayload`
  // / `ActionProofEventPayload`.
  | "plan_update"
  | "goal_update"
  | "action_proof";

/**
 * Payload for the `wiki_write` event kind (0.3.0 design §9): which article
 * was mutated, at what version, and how. `action` distinguishes a body
 * upsert (`"write"`), a reflection-pass signals change (`"set_signals"`),
 * and the standalone `log_knowledge_gap` fallback (`"gap"`).
 */
export type WikiWriteEventPayload = {
  readonly slug: string;
  readonly version: number;
  readonly action: "write" | "set_signals" | "gap";
  /** thredz-parity `editMessage`, when the model supplied one. */
  readonly editMessage?: string;
};

export type Event = {
  readonly ts: number;
  readonly version: 1;
  readonly kind: EventKind;
  readonly payload: unknown;
};

export type AppendEvent = Pick<Event, "kind" | "payload">;

export type OpenEventLogOptions = {
  readonly rootDir?: string;
  readonly now?: () => number;
};

export interface EventLog {
  append(event: AppendEvent): Promise<void>;
  read(opts?: { since?: number; until?: number }): AsyncIterable<Event>;
  close(): Promise<void>;
}

function validateId(sessionId: string): void {
  if (!ID_REGEX.test(sessionId)) {
    throw new RuntimeError(`event-log: invalid sessionId "${sessionId}" — expected sess_<16 hex>`);
  }
}

/**
 * Open (or implicitly create) the JSONL log for `sessionId`. Creates the
 * parent directory on demand. Subsequent `append()` calls write
 * synchronously to the file; `read()` opens its own read stream so it
 * sees a consistent snapshot of the bytes already on disk.
 */
export async function openEventLog(
  sessionId: string,
  opts: OpenEventLogOptions = {},
): Promise<EventLog> {
  validateId(sessionId);
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const now = opts.now ?? (() => Date.now());
  const fullPath = resolve(rootDir, `${sessionId}.jsonl`);
  mkdirSync(rootDir, { recursive: true });

  // When a tenant context is active, fail closed on a resolved path that
  // escapes the tenant's sessionRoot (CWE-1230). Outside a tenant scope (the
  // common CLI case) this is a no-op so non-tenant behaviour is unchanged.
  function fence(): void {
    if (currentTenantContext() !== undefined) {
      assertSamePath(fullPath, requireTenant().sessionRoot);
    }
  }
  fence();

  return {
    async append(event: AppendEvent): Promise<void> {
      fence();
      const wire: Event = {
        ts: now(),
        version: 1,
        kind: event.kind,
        payload: event.payload,
      };
      const line = `${JSON.stringify(wire)}\n`;
      appendFileSync(fullPath, line, { mode: 0o600 });
    },

    read(readOpts: { since?: number; until?: number } = {}): AsyncIterable<Event> {
      fence();
      return readEvents(fullPath, readOpts);
    },

    async close(): Promise<void> {
      // No persistent handle today; reserved for a future buffered writer.
    },
  };
}

async function* readEvents(
  fullPath: string,
  opts: { since?: number; until?: number },
): AsyncIterable<Event> {
  if (!existsSync(fullPath)) return;
  const stream = createReadStream(fullPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const raw of rl) {
      lineNumber += 1;
      if (raw === "") continue;
      let parsed: Event;
      try {
        parsed = JSON.parse(raw) as Event;
      } catch (err) {
        throw new RuntimeError(
          `event-log: malformed JSON on line ${lineNumber} of ${fullPath}`,
          err,
        );
      }
      if (opts.since !== undefined && parsed.ts < opts.since) continue;
      if (opts.until !== undefined && parsed.ts > opts.until) continue;
      yield parsed;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

// ---- v0.3.0 continuity event payloads (design §2.4, PR 7) ----
// Additive exports only: writers are `@crewhaus/tool-plan`'s injected append
// seam; readers that predate these kinds skip them by convention.

/** Payload of a `plan_update` event — one plan mutation (creation, a new
 *  step, a ladder-status move up to `claimed`, the active-plan pointer, or
 *  the machine-checked `prove_step` transition recorded alongside its
 *  `action_proof` events). */
export type PlanUpdateEventPayload = {
  readonly planId: string;
  readonly action: "create" | "add_step" | "set_step_status" | "set_active" | "prove_step";
  readonly step?: number;
  readonly status?: string;
  readonly title?: string;
  /** v0.3.0 §7.1 — `formatAgentIdentity` of the acting run context when one
   *  is set (e.g. `subagent=researcher` for a plan mutation made from inside
   *  a sub-agent). Absent for top-level runs. */
  readonly agentIdentity?: string;
};

/** Payload of a `goal_update` event — one goal creation or mutation. */
export type GoalUpdateEventPayload = {
  readonly goalId: string;
  readonly action: "create" | "update";
  readonly status?: string;
  readonly title?: string;
  /** See `PlanUpdateEventPayload.agentIdentity`. */
  readonly agentIdentity?: string;
};

/** Payload of an `action_proof` event — one evidence reference checked
 *  during a `proven` transition. `verified` means the cited `tool_use` /
 *  `tool_result` pair resolved in a session log (parent or child) with
 *  `isError` false; `missing` and `error_result` record rejected attempts so
 *  the audit trail shows proof pressure, not just successes. */
export type ActionProofEventPayload = {
  readonly planId: string;
  readonly step: number;
  readonly toolUseId: string;
  readonly verdict: "verified" | "missing" | "error_result";
  /** See `PlanUpdateEventPayload.agentIdentity`. */
  readonly agentIdentity?: string;
};
