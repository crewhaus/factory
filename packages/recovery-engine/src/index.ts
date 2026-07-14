/**
 * Catalog R1 `recovery-engine` — pure decision function that maps an
 * Anthropic API error + per-turn recovery state to a `RecoveryAction`.
 * No I/O. The orchestrator (runtime-core) is responsible for *executing*
 * the chosen action (sleeping, recompacting, injecting messages).
 *
 * Taxonomy:
 *   billing (402 / credit balance / insufficient_quota)
 *                        → halt      (terminal — retrying an empty account is futile)
 *   auth (401/403)       → halt      (terminal — retrying bad credentials is futile)
 *   rate_limit (429)     → retry     (honors Retry-After; exhaustion → halt, exit 32)
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
import { CrewhausError, EXIT_CODES, type FailureClass, type FailureReport } from "@crewhaus/errors";

export type RecoveryAction =
  | { readonly kind: "compact" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly attempt: number }
  | { readonly kind: "continue" }
  | { readonly kind: "tombstone"; readonly messageId?: string }
  | { readonly kind: "switch-model" }
  | { readonly kind: "fail"; readonly reason: string }
  // v0.3.0 Goal 6 — terminal, classified stop. Unlike `fail` (whose reason is
  // a raw string), `halt` carries a structured FailureReport with a title,
  // the raw provider text, a remediation line, and a coded exit status.
  | { readonly kind: "halt"; readonly report: FailureReport };

export type RecoveryErrorClass =
  | "billing"
  | "auth"
  | "rate_limit"
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

// Honor a provider Retry-After up to this cap so a pathological header
// (e.g. an HTTP-date hours away) can't stall the run indefinitely; past the
// cap the normal capped exponential backoff applies.
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * v0.3.0 Goal 6 — extract a provider Retry-After delay from an error object,
 * in milliseconds, or undefined when absent. Duck-typed against the shapes
 * the SDKs / adapters surface:
 *   · `retryAfterMs` (number, milliseconds) — adapter-normalized field;
 *   · `retryAfter`   (number, seconds)      — SDK convenience field;
 *   · `headers` — a Headers instance or plain object carrying `retry-after`
 *     as delta-seconds or an HTTP-date.
 * Results are clamped into [0, RETRY_AFTER_CAP_MS].
 */
export function retryAfterMs(error: unknown, now: () => number = Date.now): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const errObj = error as {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    headers?: unknown;
  };

  const clamp = (ms: number): number | undefined =>
    Number.isFinite(ms) ? Math.min(Math.max(Math.round(ms), 0), RETRY_AFTER_CAP_MS) : undefined;

  if (typeof errObj.retryAfterMs === "number") return clamp(errObj.retryAfterMs);
  if (typeof errObj.retryAfter === "number") return clamp(errObj.retryAfter * 1_000);

  const headers = errObj.headers;
  let raw: unknown;
  if (headers !== null && typeof headers === "object") {
    const maybeGet = (headers as { get?: unknown }).get;
    if (typeof maybeGet === "function") {
      raw = (maybeGet as (name: string) => unknown).call(headers, "retry-after");
    } else {
      const record = headers as Record<string, unknown>;
      raw = record["retry-after"] ?? record["Retry-After"];
    }
  }
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  // Delta-seconds form ("30") first, then the HTTP-date form.
  if (/^\d+$/.test(raw.trim())) return clamp(Number(raw.trim()) * 1_000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return clamp(at - now());
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
    code?: unknown;
    error?: { type?: unknown; message?: unknown; code?: unknown };
  };

  // Aborts come through with name === "APIUserAbortError" or "AbortError".
  if (typeof errObj.name === "string") {
    if (errObj.name === "APIUserAbortError" || errObj.name === "AbortError") {
      return "user_aborted";
    }
  }

  const innerType = typeof errObj.error?.type === "string" ? errObj.error.type : undefined;
  const innerMessage = typeof errObj.error?.message === "string" ? errObj.error.message : "";
  const message = typeof errObj.message === "string" ? errObj.message : "";
  const status = typeof errObj.status === "number" ? errObj.status : undefined;
  // BOTH code slots are consulted independently (PR 2): a raw SDK error
  // carries the provider code top-level, but adapter WRAPPERS keep
  // CrewhausError's ErrorCode there ("adapter") and surface the provider
  // code on the copied error envelope — a top-level string must not shadow
  // the envelope's discriminator.
  const code = typeof errObj.code === "string" ? errObj.code : undefined;
  const innerCode = typeof errObj.error?.code === "string" ? errObj.error.code : undefined;

  // v0.3.0 Goal 6 — billing / auth / rate_limit come BEFORE the pre-existing
  // buckets so an out-of-funds 400 is not misrouted through a tombstone and
  // an insufficient_quota 429 is not burned through backoff retries.
  //
  // billing — the provider account itself is out of funding:
  //   · HTTP 402 anywhere;
  //   · Anthropic: 400 invalid_request_error + "credit balance … too low";
  //   · OpenAI: 429 + code "insufficient_quota" (distinct from rate limits);
  //   · Bedrock: ServiceQuotaExceededException by name (a hard account
  //     quota — retrying won't help; raise the quota instead).
  if (status === 402) return "billing";
  if (code === "insufficient_quota" || innerCode === "insufficient_quota") return "billing";
  if (status === 400 && /credit balance/i.test(innerMessage.length > 0 ? innerMessage : message)) {
    return "billing";
  }
  if (typeof errObj.name === "string" && /ServiceQuotaExceeded/.test(errObj.name)) {
    return "billing";
  }

  // auth — runtime 401/403 (distinct from boot-time ProviderAuthError, which
  // fires before any request when credentials are entirely missing).
  if (status === 401 || status === 403) return "auth";

  // rate_limit — a genuine 429 (NOT insufficient_quota, handled above).
  // Retried with Retry-After honored; budget exhaustion halts with exit 32.
  if (status === 429 || innerType === "rate_limit_error") return "rate_limit";

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
 * v0.3.0 Goal 6 — built-in named failure classes. Report metadata (title /
 * remediation / exit code) for the terminal classes the engine can halt
 * with. Consulted AFTER user `failure_taxonomy` entries (user overrides
 * win) and BEFORE the generic classify buckets. `mcp_boot_failure` and
 * `crewhaus_budget` are not produced by `classify()` — they exist so the
 * runtime's MCP-boot and budget-cap paths build their reports from the
 * same table (wired in the follow-up runtime PR).
 */
export type BuiltinFailureClass = {
  readonly class: FailureClass;
  readonly title: string;
  readonly remediation: string;
  readonly exitCode: number;
  readonly docsUrl?: string;
};

export const BUILTIN_FAILURE_CLASSES = {
  billing_exhausted: {
    class: "billing",
    title: "provider account out of funding",
    remediation: "add credits to your provider account, then rerun.",
    exitCode: EXIT_CODES.billing,
  },
  auth_invalid: {
    class: "auth",
    title: "provider rejected the credentials",
    remediation: "check the provider API key env var (see .env.example), then rerun.",
    exitCode: EXIT_CODES.auth,
  },
  rate_limited: {
    class: "rate_limit",
    title: "provider rate limit still exceeded after retries",
    remediation: "wait for the rate-limit window to reset (or lower the request rate), then rerun.",
    exitCode: EXIT_CODES.rate_limit,
  },
  mcp_boot_failure: {
    class: "mcp_boot",
    title: "an MCP server failed to boot",
    remediation: "check the MCP server command, URL, and credentials in the spec, then rerun.",
    exitCode: EXIT_CODES.tool,
  },
  crewhaus_budget: {
    class: "crewhaus_budget",
    title: "run stopped by the configured budget cap",
    remediation: "raise the spec's budget cap (or rerun with a higher cap).",
    exitCode: EXIT_CODES.crewhaus_budget,
  },
} as const satisfies Record<string, BuiltinFailureClass>;

/** Provider display names for `detail` attribution ("Anthropic said: …"). */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  bedrock: "Bedrock",
};

/** Per-provider remediation overrides for the billing / auth classes. */
const PROVIDER_REMEDIATIONS: Record<string, Partial<Record<FailureClass, string>>> = {
  anthropic: {
    billing: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
    auth: "check ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY (see .env.example), then rerun.",
  },
  openai: {
    billing:
      "add credits at https://platform.openai.com/settings/organization/billing, then rerun.",
    auth: "check OPENAI_API_KEY (see .env.example), then rerun.",
  },
  gemini: {
    billing: "check your plan and billing at https://aistudio.google.com/, then rerun.",
    auth: "check GEMINI_API_KEY / GOOGLE_API_KEY (see .env.example), then rerun.",
  },
  bedrock: {
    billing: "request a service-quota increase in the AWS console, then rerun.",
    auth: "check your AWS credentials and Bedrock model access, then rerun.",
  },
};

/** Best raw provider text: the API envelope message, else the wrapper message. */
function rawProviderText(error: unknown): string {
  const errObj = error as {
    message?: unknown;
    error?: { message?: unknown };
  } | null;
  const inner = typeof errObj?.error?.message === "string" ? errObj.error.message : "";
  if (inner.length > 0) return inner;
  const outer = typeof errObj?.message === "string" ? errObj.message : "";
  if (outer.length > 0) return outer;
  return String(error);
}

/**
 * Build a `FailureReport` for a built-in class from the offending error.
 * AdapterError wrappers carry `providerId`, which drives the "…said:"
 * attribution in `detail` and the provider-specific remediation line.
 */
export function buildFailureReport(
  key: keyof typeof BUILTIN_FAILURE_CLASSES,
  error: unknown,
): FailureReport {
  const builtin: BuiltinFailureClass = BUILTIN_FAILURE_CLASSES[key];
  const providerId =
    typeof (error as { providerId?: unknown } | null)?.providerId === "string"
      ? (error as { providerId: string }).providerId
      : undefined;
  const raw = rawProviderText(error);
  const detail =
    providerId !== undefined
      ? `${PROVIDER_DISPLAY_NAMES[providerId] ?? providerId} said: ${JSON.stringify(raw)}`
      : raw;
  const remediation =
    (providerId !== undefined ? PROVIDER_REMEDIATIONS[providerId]?.[builtin.class] : undefined) ??
    builtin.remediation;
  return {
    class: builtin.class,
    title: builtin.title,
    detail,
    remediation,
    exitCode: builtin.exitCode,
    ...(builtin.docsUrl !== undefined ? { docsUrl: builtin.docsUrl } : {}),
  };
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
      return recoverNamed(named, state, error);
    }
  }
  const klass = classify(error);
  const message = (error as { message?: unknown })?.message;
  const reasonStr = typeof message === "string" && message.length > 0 ? message : klass;

  switch (klass) {
    // v0.3.0 Goal 6 — terminal classes halt immediately: no tombstone
    // detour, no futile backoff retries against an empty account or a
    // rejected key.
    case "billing":
      return { kind: "halt", report: buildFailureReport("billing_exhausted", error) };

    case "auth":
      return { kind: "halt", report: buildFailureReport("auth_invalid", error) };

    case "rate_limit": {
      // A genuine rate limit is transient: keep retrying, but honor the
      // provider's Retry-After for the delay when one is present. Budget
      // exhaustion is a classified halt (exit 32), not a generic fail.
      if (state.retryCount >= MAX_RETRIES) {
        return { kind: "halt", report: buildFailureReport("rate_limited", error) };
      }
      return {
        kind: "retry",
        delayMs: retryAfterMs(error) ?? backoffMs(state.retryCount),
        attempt: state.retryCount + 1,
      };
    }

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
 * classes. Budget exhaustion always returns a terminal action so the
 * user can't declare an infinite retry loop via taxonomy.
 *
 * v0.3.0 Goal 6 — the entry's `hint` field (declared since §55, never
 * consumed until now) finally reaches the user: when a matched entry
 * resolves terminally (declared `fail` or budget exhaustion) AND carries a
 * `hint`, the result is a `halt` whose report carries the hint as the
 * remediation line. Entries without a hint keep the pre-0.3.0 `fail`.
 */
function recoverNamed(
  named: NamedFailureClass,
  state: RecoveryState,
  error?: unknown,
): RecoveryAction {
  const reason = `failure_taxonomy: ${named.class}`;
  const terminal = (fullReason: string): RecoveryAction => {
    if (named.hint === undefined) return { kind: "fail", reason: fullReason };
    return {
      kind: "halt",
      report: {
        class: "unknown",
        title: fullReason,
        detail: error === undefined ? "" : rawProviderText(error),
        remediation: named.hint,
        exitCode: EXIT_CODES.generic,
      },
    };
  };
  switch (named.recovery) {
    case "retry":
      if (state.retryCount >= MAX_RETRIES) {
        return terminal(`retry budget exhausted: ${reason}`);
      }
      return {
        kind: "retry",
        delayMs: backoffMs(state.retryCount),
        attempt: state.retryCount + 1,
      };
    case "compact":
      if (state.compactCount >= MAX_COMPACTS) {
        return terminal(`compact budget exhausted: ${reason}`);
      }
      return { kind: "compact" };
    case "continue":
      if (state.continueCount >= MAX_CONTINUES) {
        return terminal(`continue budget exhausted: ${reason}`);
      }
      return { kind: "continue" };
    case "tombstone":
      if (state.tombstoneCount >= MAX_TOMBSTONES) {
        return terminal(`tombstone budget exhausted: ${reason}`);
      }
      return { kind: "tombstone" };
    case "switch-model":
      if (state.switchModelCount >= MAX_SWITCH_MODELS) {
        return terminal(`switch-model budget exhausted: ${reason}`);
      }
      return { kind: "switch-model" };
    case "fail":
      return terminal(reason);
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
    case "halt":
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
  RETRY_AFTER_CAP_MS,
} as const;
