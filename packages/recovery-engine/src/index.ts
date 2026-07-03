/**
 * Catalog R1 `recovery-engine` — pure decision function that maps an
 * Anthropic API error + per-turn recovery state to a `RecoveryAction`.
 * No I/O. The orchestrator (runtime-core) is responsible for *executing*
 * the chosen action (sleeping, recompacting, injecting messages).
 *
 * Taxonomy:
 *   prompt_too_long      → compact   (max once per turn → fail)
 *   max_output_tokens    → continue  (max 3 per turn   → fail)
 *   overloaded / 5xx     → retry     (exponential backoff, max 5 → fail)
 *   invalid_request 400  → tombstone (max once per turn → fail)
 *   user-aborted         → fail("user_aborted")  — orchestrator handles abort separately
 *   anything else        → fail(message)
 *
 * Item 23 — `switch-model` is an OPT-IN `failure_taxonomy` recovery action
 * (never a built-in `classify()` verdict, so default runs are byte-for-byte
 * unchanged). It tells the orchestrator to route the same turn onto the
 * next provider-failover candidate (open the active breaker so the chain
 * reroutes) instead of exhausting backoff retries against a dead provider.
 * Budgeted per turn like the others; a run without a failover chain treats
 * it as a retry-shaped no-op re-issue (documented in runtime-core).
 *
 * References: claude-code/query.ts recovery branches; agent-framework
 * _runner.py retry; AI-Harness-Systems §recovery.
 */
import { CrewhausError } from "@crewhaus/errors";

export type RecoveryAction =
  | { readonly kind: "compact" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly attempt: number }
  | { readonly kind: "continue" }
  | { readonly kind: "tombstone"; readonly messageId?: string }
  | { readonly kind: "switch-model" }
  | { readonly kind: "fail"; readonly reason: string };

export type RecoveryErrorClass =
  | "prompt_too_long"
  | "max_output_tokens"
  | "overloaded_or_5xx"
  | "invalid_request"
  | "user_aborted"
  | "unknown";

export type RecoveryState = {
  /** Number of `retry` actions already chosen in this turn. */
  readonly retryCount: number;
  /** Number of `compact` actions already chosen in this turn. */
  readonly compactCount: number;
  /** Number of `continue` actions already chosen in this turn. */
  readonly continueCount: number;
  /** Number of `tombstone` actions already chosen in this turn. */
  readonly tombstoneCount: number;
  /** Item 23 — number of `switch-model` actions already chosen this turn. */
  readonly switchModelCount: number;
};

export const initialRecoveryState: RecoveryState = {
  retryCount: 0,
  compactCount: 0,
  continueCount: 0,
  tombstoneCount: 0,
  switchModelCount: 0,
};

export class RecoveryEngineError extends CrewhausError {
  override readonly name = "RecoveryEngineError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

const MAX_RETRIES = 5;
const MAX_COMPACTS = 1;
const MAX_CONTINUES = 3;
const MAX_TOMBSTONES = 1;
// Item 23 — cap `switch-model` hops per turn. Generous enough to walk a
// short failover chain (primary → fallback → fallback), low enough that a
// mutually-degraded chain fails the turn instead of looping forever.
const MAX_SWITCH_MODELS = 3;

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_JITTER_MS = 250;

/**
 * Compute exponential-backoff delay for the Nth retry (0-indexed): 1 s, 2 s,
 * 4 s, ..., capped at 30 s, plus 0–250 ms of jitter.
 */
export function backoffMs(attempt: number, jitterFn: () => number = Math.random): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Clamp into [0, MAX_JITTER_MS] so the contract holds even if a test injects
  // a jitterFn that returns exactly 1.0 (Math.random itself returns [0, 1)).
  const jitter = Math.min(Math.floor(jitterFn() * (MAX_JITTER_MS + 1)), MAX_JITTER_MS);
  return exp + jitter;
}

/**
 * Classify an unknown error value into a recovery taxonomy bucket. Duck-typed
 * against the Anthropic SDK error shape: `.status`, `.error.type`, `.message`,
 * plus the SDK's `name === "APIUserAbortError"` or `"AbortError"` for aborts.
 *
 * Synthetic max-output-tokens errors should carry `error.type === "max_output_tokens"`
 * (the SDK doesn't throw on stop_reason — the caller fabricates an Error with
 * that shape after seeing `stop_reason: "max_tokens"`).
 */
export function classify(error: unknown): RecoveryErrorClass {
  if (error === null || error === undefined) return "unknown";

  const errObj = error as {
    name?: unknown;
    status?: unknown;
    message?: unknown;
    error?: { type?: unknown; message?: unknown };
  };

  // Aborts come through with name === "APIUserAbortError" or "AbortError".
  if (typeof errObj.name === "string") {
    if (errObj.name === "APIUserAbortError" || errObj.name === "AbortError") {
      return "user_aborted";
    }
  }

  const innerType = typeof errObj.error?.type === "string" ? errObj.error.type : undefined;
  const message = typeof errObj.message === "string" ? errObj.message : "";
  const status = typeof errObj.status === "number" ? errObj.status : undefined;

  if (innerType === "max_output_tokens") return "max_output_tokens";

  // Anthropic returns "Prompt is too long" inside invalid_request_error responses;
  // distinguish from generic invalid_request by sniffing the message.
  if (innerType === "invalid_request_error" && /prompt is too long|input length/i.test(message)) {
    return "prompt_too_long";
  }

  if (innerType === "overloaded_error") return "overloaded_or_5xx";
  if (status !== undefined && status >= 500 && status < 600) return "overloaded_or_5xx";
  if (status === 529) return "overloaded_or_5xx";

  if (innerType === "invalid_request_error" || status === 400) return "invalid_request";

  return "unknown";
}

/**
 * Section 55 (Track A) — a single entry from a spec's `failure_taxonomy`,
 * carried verbatim from the IR. The recovery engine consults the taxonomy
 * BEFORE falling back to its built-in classify+recover logic so user-
 * named classes take precedence. Cited paper: NLAH (arxiv 2603.25723).
 */
export type NamedFailureClass = {
  readonly class: string;
  readonly pattern: string;
  readonly recovery: "retry" | "compact" | "continue" | "tombstone" | "switch-model" | "fail";
  readonly hint?: string;
};

/**
 * Match an unknown error against a taxonomy entry's `pattern`. The pattern
 * is either a `/regex/flags` literal or a case-insensitive substring of
 * the error.message. Returns the first matching entry, or undefined.
 */
export function matchNamedFailure(
  error: unknown,
  taxonomy: ReadonlyArray<NamedFailureClass>,
): NamedFailureClass | undefined {
  const message =
    typeof (error as { message?: unknown })?.message === "string"
      ? (error as { message: string }).message
      : "";
  if (message.length === 0) return undefined;
  for (const entry of taxonomy) {
    const p = entry.pattern;
    if (p.length > 2 && p.startsWith("/") && p.lastIndexOf("/") > 0) {
      const lastSlash = p.lastIndexOf("/");
      const body = p.slice(1, lastSlash);
      const flags = p.slice(lastSlash + 1);
      let re: RegExp;
      try {
        re = new RegExp(body, flags);
      } catch {
        continue;
      }
      if (re.test(message)) return entry;
    } else {
      if (message.toLowerCase().includes(p.toLowerCase())) return entry;
    }
  }
  return undefined;
}

/**
 * Decide what to do about `error` given the per-turn recovery state. Pure.
 * Each call returns a single action; the caller advances state.
 *
 * When `taxonomy` is provided, named classes take precedence over the
 * built-in classify+recover taxonomy. A named match returns its declared
 * `recovery` action directly (subject to the same per-turn budgets as
 * built-in classes). Unmatched errors fall through to the built-in flow.
 */
export function recover(
  error: unknown,
  state: RecoveryState,
  taxonomy?: ReadonlyArray<NamedFailureClass>,
): RecoveryAction {
  if (taxonomy !== undefined && taxonomy.length > 0) {
    const named = matchNamedFailure(error, taxonomy);
    if (named !== undefined) {
      return recoverNamed(named, state);
    }
  }
  const klass = classify(error);
  const message = (error as { message?: unknown })?.message;
  const reasonStr = typeof message === "string" && message.length > 0 ? message : klass;

  switch (klass) {
    case "prompt_too_long":
      if (state.compactCount >= MAX_COMPACTS) {
        return { kind: "fail", reason: `compact budget exhausted: ${reasonStr}` };
      }
      return { kind: "compact" };

    case "max_output_tokens":
      if (state.continueCount >= MAX_CONTINUES) {
        return { kind: "fail", reason: `continue budget exhausted: ${reasonStr}` };
      }
      return { kind: "continue" };

    case "overloaded_or_5xx":
      if (state.retryCount >= MAX_RETRIES) {
        return { kind: "fail", reason: `retry budget exhausted: ${reasonStr}` };
      }
      return {
        kind: "retry",
        delayMs: backoffMs(state.retryCount),
        attempt: state.retryCount + 1,
      };

    case "invalid_request":
      if (state.tombstoneCount >= MAX_TOMBSTONES) {
        return { kind: "fail", reason: `tombstone budget exhausted: ${reasonStr}` };
      }
      return { kind: "tombstone" };

    case "user_aborted":
      return { kind: "fail", reason: "user_aborted" };

    case "unknown":
      return { kind: "fail", reason: reasonStr };
  }
}

/**
 * Convert a matched named-failure entry into the corresponding
 * RecoveryAction, respecting the same per-turn budgets as built-in
 * classes. Budget exhaustion always returns `fail` so the user can't
 * declare an infinite retry loop via taxonomy.
 */
function recoverNamed(named: NamedFailureClass, state: RecoveryState): RecoveryAction {
  const reason = `failure_taxonomy: ${named.class}`;
  switch (named.recovery) {
    case "retry":
      if (state.retryCount >= MAX_RETRIES) {
        return { kind: "fail", reason: `retry budget exhausted: ${reason}` };
      }
      return {
        kind: "retry",
        delayMs: backoffMs(state.retryCount),
        attempt: state.retryCount + 1,
      };
    case "compact":
      if (state.compactCount >= MAX_COMPACTS) {
        return { kind: "fail", reason: `compact budget exhausted: ${reason}` };
      }
      return { kind: "compact" };
    case "continue":
      if (state.continueCount >= MAX_CONTINUES) {
        return { kind: "fail", reason: `continue budget exhausted: ${reason}` };
      }
      return { kind: "continue" };
    case "tombstone":
      if (state.tombstoneCount >= MAX_TOMBSTONES) {
        return { kind: "fail", reason: `tombstone budget exhausted: ${reason}` };
      }
      return { kind: "tombstone" };
    case "switch-model":
      if (state.switchModelCount >= MAX_SWITCH_MODELS) {
        return { kind: "fail", reason: `switch-model budget exhausted: ${reason}` };
      }
      return { kind: "switch-model" };
    case "fail":
      return { kind: "fail", reason };
  }
}

/**
 * Helper for the orchestrator: advance recovery state by one chosen action.
 * Pure; returns a new state.
 */
export function advanceState(state: RecoveryState, action: RecoveryAction): RecoveryState {
  switch (action.kind) {
    case "retry":
      return { ...state, retryCount: state.retryCount + 1 };
    case "compact":
      return { ...state, compactCount: state.compactCount + 1 };
    case "continue":
      return { ...state, continueCount: state.continueCount + 1 };
    case "tombstone":
      return { ...state, tombstoneCount: state.tombstoneCount + 1 };
    case "switch-model":
      return { ...state, switchModelCount: state.switchModelCount + 1 };
    case "fail":
      return state;
  }
}

/** Budget constants exported so the orchestrator and tests stay in sync. */
export const BUDGETS = {
  MAX_RETRIES,
  MAX_COMPACTS,
  MAX_CONTINUES,
  MAX_TOMBSTONES,
  MAX_SWITCH_MODELS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_JITTER_MS,
} as const;
