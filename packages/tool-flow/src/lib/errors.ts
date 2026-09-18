/**
 * Map an error to a stable class and a next action.
 *
 * Deciding "is this worth retrying?" is the single most common reason a
 * harness spends a model turn on something that has a right answer. A 429
 * with `Retry-After: 30` is not a judgement call, and neither is exit code
 * 127. This turns the signals a failure actually carries — status, exit
 * code, errno, the text — into one of a fixed set of classes and one of a
 * fixed set of actions, so a loop can act on it directly.
 *
 * Nothing here reads the clock. `Retry-After` in its HTTP-date form is a
 * point in time, and turning that into a wait needs a "now"; the caller
 * supplies one or gets the date back unconverted. A classifier that quietly
 * called `Date.now()` would return a different answer every second, which is
 * exactly what this package promises not to do.
 */

export const ERROR_CLASSES = [
  "ok",
  "transient",
  "timeout",
  "unavailable",
  "rate_limited",
  "quota",
  "auth",
  "permission",
  "not_found",
  "bad_request",
  "conflict",
  "too_large",
  "unsupported",
  "capacity",
  "integrity",
  "cancelled",
  "redirect",
  "bug",
  "unknown",
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const NEXT_ACTIONS = [
  "continue",
  "retry",
  "retry_after",
  "backoff",
  "reauth",
  "reduce_input",
  "escalate",
  "skip",
  "fail",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Everything a failure might carry. All optional; more is better. */
export type ErrorSignal = {
  readonly status?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  /** A Node errno (`ECONNRESET`) or a provider code (`insufficient_quota`). */
  readonly code?: string;
  /** The error message, or the tail of stderr. */
  readonly message?: string;
  /** The raw `Retry-After` header: delta-seconds or an HTTP-date. */
  readonly retryAfter?: string;
  /** 1-based attempt number and its ceiling, to decide when to stop. */
  readonly attempt?: number;
  readonly maxAttempts?: number;
};

/** A caller-supplied rule, tried before every builtin pack. */
export type ErrorRule = {
  readonly id: string;
  /** Case-insensitive substring of the message, or of `code`. */
  readonly contains?: string;
  /** Regex source matched against the message. Anchored by the caller. */
  readonly matches?: string;
  readonly status?: number;
  readonly exitCode?: number;
  readonly class: ErrorClass;
  readonly action: NextAction;
  readonly waitMs?: number;
};

export type Classification = {
  readonly class: ErrorClass;
  readonly action: NextAction;
  readonly retryable: boolean;
  /** How long to wait, when the error itself said so. Never invented. */
  readonly waitMs: number | null;
  /** The `Retry-After` date, when it was a date and no `now` was given. */
  readonly retryAt: string | null;
  /** Which rule decided this: a pack entry's id, or a caller rule's id. */
  readonly matched: string;
  readonly source: "custom" | "status" | "exit" | "signal" | "code" | "message" | "default";
  /** True when attempts ran out, which downgrades a retry to an escalation. */
  readonly exhausted: boolean;
};

type Verdict = {
  readonly class: ErrorClass;
  readonly action: NextAction;
  readonly waitMs?: number;
};

/**
 * Classes whose default action is "try again" rather than "change something".
 *
 * This decides whether a `Retry-After` is allowed to upgrade a plain retry —
 * it is not the same question as {@link Classification.retryable}, which
 * follows the final action. A capacity failure is in here because some of
 * them (EMFILE, EAGAIN) do clear on their own, but an OOM kill under the
 * same class resolves to `escalate`, and then it is not retryable.
 */
const RETRY_BY_DEFAULT = new Set<ErrorClass>([
  "transient",
  "timeout",
  "unavailable",
  "rate_limited",
  "capacity",
]);

/** The actions that mean "call it again". */
const RETRY_ACTIONS = new Set<NextAction>(["retry", "retry_after", "backoff"]);

const STATUS_TABLE: ReadonlyMap<number, Verdict> = new Map([
  [400, { class: "bad_request", action: "fail" }],
  [401, { class: "auth", action: "reauth" }],
  [402, { class: "quota", action: "escalate" }],
  [403, { class: "permission", action: "escalate" }],
  [404, { class: "not_found", action: "fail" }],
  [405, { class: "bad_request", action: "fail" }],
  [406, { class: "bad_request", action: "fail" }],
  [408, { class: "timeout", action: "retry" }],
  [409, { class: "conflict", action: "escalate" }],
  [410, { class: "not_found", action: "fail" }],
  [412, { class: "conflict", action: "escalate" }],
  [413, { class: "too_large", action: "reduce_input" }],
  [414, { class: "too_large", action: "reduce_input" }],
  [415, { class: "unsupported", action: "fail" }],
  [422, { class: "bad_request", action: "fail" }],
  [423, { class: "conflict", action: "backoff" }],
  [425, { class: "transient", action: "retry" }],
  [428, { class: "bad_request", action: "fail" }],
  [429, { class: "rate_limited", action: "retry_after" }],
  [431, { class: "too_large", action: "reduce_input" }],
  [451, { class: "permission", action: "fail" }],
  [500, { class: "transient", action: "retry" }],
  [501, { class: "unsupported", action: "fail" }],
  [502, { class: "unavailable", action: "retry" }],
  [503, { class: "unavailable", action: "retry_after" }],
  [504, { class: "timeout", action: "retry" }],
  [507, { class: "capacity", action: "escalate" }],
  [508, { class: "bug", action: "fail" }],
  [509, { class: "quota", action: "escalate" }],
  // Anthropic and several other providers use 529 for "overloaded".
  [529, { class: "unavailable", action: "backoff" }],
]);

/**
 * Exit codes with an agreed meaning. 1 is deliberately absent: it is the
 * generic "it failed" and says nothing about why, so claiming a class for it
 * would be inventing information.
 */
const EXIT_TABLE: ReadonlyMap<number, Verdict> = new Map([
  [0, { class: "ok", action: "continue" }],
  [2, { class: "bad_request", action: "fail" }],
  // GNU coreutils `timeout` exits 124 when it had to kill the child.
  [124, { class: "timeout", action: "retry" }],
  [125, { class: "bug", action: "fail" }],
  [126, { class: "permission", action: "fail" }],
  [127, { class: "not_found", action: "fail" }],
]);

/** 128+N, the shell's encoding of "died on signal N". */
const SIGNAL_TABLE: ReadonlyMap<string, Verdict> = new Map([
  ["SIGINT", { class: "cancelled", action: "fail" }],
  ["SIGTERM", { class: "cancelled", action: "fail" }],
  ["SIGQUIT", { class: "cancelled", action: "fail" }],
  // A killed process is usually the OOM killer, which is a capacity problem.
  ["SIGKILL", { class: "capacity", action: "escalate" }],
  ["SIGSEGV", { class: "bug", action: "fail" }],
  ["SIGABRT", { class: "bug", action: "fail" }],
  ["SIGBUS", { class: "bug", action: "fail" }],
  ["SIGFPE", { class: "bug", action: "fail" }],
  ["SIGPIPE", { class: "transient", action: "retry" }],
  ["SIGALRM", { class: "timeout", action: "retry" }],
  ["SIGHUP", { class: "transient", action: "retry" }],
  ["SIGXFSZ", { class: "too_large", action: "reduce_input" }],
]);

const EXIT_SIGNALS: ReadonlyMap<number, string> = new Map([
  [129, "SIGHUP"],
  [130, "SIGINT"],
  [131, "SIGQUIT"],
  [134, "SIGABRT"],
  [136, "SIGFPE"],
  [137, "SIGKILL"],
  [138, "SIGBUS"],
  [139, "SIGSEGV"],
  [141, "SIGPIPE"],
  [142, "SIGALRM"],
  [143, "SIGTERM"],
  [153, "SIGXFSZ"],
]);

const CODE_TABLE: ReadonlyMap<string, Verdict> = new Map([
  ["ECONNREFUSED", { class: "unavailable", action: "retry" }],
  ["ECONNRESET", { class: "transient", action: "retry" }],
  ["ECONNABORTED", { class: "transient", action: "retry" }],
  ["ETIMEDOUT", { class: "timeout", action: "retry" }],
  ["ESOCKETTIMEDOUT", { class: "timeout", action: "retry" }],
  ["EPIPE", { class: "transient", action: "retry" }],
  ["EHOSTUNREACH", { class: "unavailable", action: "retry" }],
  ["ENETUNREACH", { class: "unavailable", action: "retry" }],
  ["ENETDOWN", { class: "unavailable", action: "retry" }],
  // EAI_AGAIN is a temporary resolver failure; ENOTFOUND is a real NXDOMAIN.
  ["EAI_AGAIN", { class: "transient", action: "retry" }],
  ["ENOTFOUND", { class: "not_found", action: "fail" }],
  ["ENOENT", { class: "not_found", action: "fail" }],
  ["EEXIST", { class: "conflict", action: "escalate" }],
  ["EACCES", { class: "permission", action: "escalate" }],
  ["EPERM", { class: "permission", action: "escalate" }],
  ["EROFS", { class: "permission", action: "escalate" }],
  ["ENOSPC", { class: "capacity", action: "escalate" }],
  ["EDQUOT", { class: "quota", action: "escalate" }],
  ["EMFILE", { class: "capacity", action: "backoff" }],
  ["ENFILE", { class: "capacity", action: "backoff" }],
  ["ENOMEM", { class: "capacity", action: "escalate" }],
  ["EAGAIN", { class: "transient", action: "backoff" }],
  ["EBUSY", { class: "conflict", action: "backoff" }],
  ["EISDIR", { class: "bad_request", action: "fail" }],
  ["ENOTDIR", { class: "bad_request", action: "fail" }],
  ["ENOTEMPTY", { class: "conflict", action: "escalate" }],
  ["EMSGSIZE", { class: "too_large", action: "reduce_input" }],
  ["ELOOP", { class: "bad_request", action: "fail" }],
  ["ENAMETOOLONG", { class: "bad_request", action: "fail" }],
  ["CERT_HAS_EXPIRED", { class: "integrity", action: "fail" }],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", { class: "integrity", action: "fail" }],
  ["SELF_SIGNED_CERT_IN_CHAIN", { class: "integrity", action: "fail" }],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", { class: "integrity", action: "fail" }],
  ["ERR_TLS_CERT_ALTNAME_INVALID", { class: "integrity", action: "fail" }],
  ["insufficient_quota", { class: "quota", action: "escalate" }],
  ["rate_limit_exceeded", { class: "rate_limited", action: "retry_after" }],
  ["context_length_exceeded", { class: "too_large", action: "reduce_input" }],
  ["overloaded_error", { class: "unavailable", action: "backoff" }],
  ["invalid_api_key", { class: "auth", action: "reauth" }],
  ["authentication_error", { class: "auth", action: "reauth" }],
  ["permission_error", { class: "permission", action: "escalate" }],
  ["not_found_error", { class: "not_found", action: "fail" }],
  ["invalid_request_error", { class: "bad_request", action: "fail" }],
  ["api_error", { class: "transient", action: "retry" }],
]);

/**
 * Message signatures, tried in order. Plain lowercased substrings, not
 * regular expressions: these run on attacker-influenced text (a remote
 * server's error body), and a pattern with nested quantifiers there is a
 * denial of service waiting to happen. Order matters — the more specific
 * phrase has to come first.
 */
const MESSAGE_TABLE: ReadonlyArray<readonly [string, Verdict]> = [
  ["too many requests", { class: "rate_limited", action: "retry_after" }],
  ["rate limit", { class: "rate_limited", action: "retry_after" }],
  ["rate_limit", { class: "rate_limited", action: "retry_after" }],
  ["credit balance is too low", { class: "quota", action: "escalate" }],
  ["insufficient funds", { class: "quota", action: "escalate" }],
  ["insufficient_quota", { class: "quota", action: "escalate" }],
  ["billing", { class: "quota", action: "escalate" }],
  ["quota", { class: "quota", action: "escalate" }],
  ["maximum context length", { class: "too_large", action: "reduce_input" }],
  ["context length", { class: "too_large", action: "reduce_input" }],
  ["context window", { class: "too_large", action: "reduce_input" }],
  ["too many tokens", { class: "too_large", action: "reduce_input" }],
  ["request entity too large", { class: "too_large", action: "reduce_input" }],
  ["payload too large", { class: "too_large", action: "reduce_input" }],
  ["javascript heap out of memory", { class: "capacity", action: "escalate" }],
  ["out of memory", { class: "capacity", action: "escalate" }],
  ["no space left on device", { class: "capacity", action: "escalate" }],
  ["cannot allocate memory", { class: "capacity", action: "escalate" }],
  ["invalid api key", { class: "auth", action: "reauth" }],
  ["incorrect api key", { class: "auth", action: "reauth" }],
  ["api key not valid", { class: "auth", action: "reauth" }],
  ["unauthorized", { class: "auth", action: "reauth" }],
  ["authentication failed", { class: "auth", action: "reauth" }],
  ["token expired", { class: "auth", action: "reauth" }],
  ["permission denied", { class: "permission", action: "escalate" }],
  ["access denied", { class: "permission", action: "escalate" }],
  ["forbidden", { class: "permission", action: "escalate" }],
  ["certificate", { class: "integrity", action: "fail" }],
  ["checksum mismatch", { class: "integrity", action: "fail" }],
  ["signature verification failed", { class: "integrity", action: "fail" }],
  ["connection refused", { class: "unavailable", action: "retry" }],
  ["connection reset", { class: "transient", action: "retry" }],
  ["socket hang up", { class: "transient", action: "retry" }],
  ["temporarily unavailable", { class: "unavailable", action: "retry" }],
  ["service unavailable", { class: "unavailable", action: "retry" }],
  ["server is overloaded", { class: "unavailable", action: "backoff" }],
  ["overloaded", { class: "unavailable", action: "backoff" }],
  ["timed out", { class: "timeout", action: "retry" }],
  ["timeout", { class: "timeout", action: "retry" }],
  ["deadline exceeded", { class: "timeout", action: "retry" }],
  ["already exists", { class: "conflict", action: "escalate" }],
  ["conflict", { class: "conflict", action: "escalate" }],
  ["not found", { class: "not_found", action: "fail" }],
  ["no such file or directory", { class: "not_found", action: "fail" }],
  ["command not found", { class: "not_found", action: "fail" }],
  ["cancell", { class: "cancelled", action: "fail" }],
  ["aborted", { class: "cancelled", action: "fail" }],
];

/** Guards the substring scan against a multi-megabyte error body. */
const MAX_MESSAGE_CHARS = 64_000;

/**
 * Parse `Retry-After`. Two forms are legal: delta-seconds, and an HTTP-date.
 * The date form needs a reference point to become a duration, so without
 * `nowMs` it is returned as a date and `waitMs` stays null.
 */
export function parseRetryAfter(
  raw: string,
  nowMs?: number,
): { waitMs: number | null; retryAt: string | null } {
  const text = raw.trim();
  if (text === "") return { waitMs: null, retryAt: null };
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return { waitMs: seconds * 1000, retryAt: null };
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { waitMs: null, retryAt: null };
  const retryAt = new Date(parsed).toISOString();
  if (nowMs === undefined) return { waitMs: null, retryAt };
  // A date already in the past means "retry now", not "wait a negative time".
  return { waitMs: Math.max(0, parsed - nowMs), retryAt };
}

/**
 * Match a caller rule.
 *
 * `message` and `code` are tested SEPARATELY rather than concatenated. Two
 * reasons, and the second is the important one:
 *
 * - A pattern anchored with `$` means "the end of the message", and against
 *   a joined `"<message> <code>"` it could never match.
 * - Because it could never match, the engine has to exhaust every
 *   alternative before saying so — which turns a pattern that would have
 *   matched immediately into a backtracking search over attacker-supplied
 *   text. Joining the fields manufactured the worst case for free.
 */
function matchCustom(
  signal: ErrorSignal,
  rules: ReadonlyArray<ErrorRule>,
  fields: ReadonlyArray<string>,
) {
  for (const rule of rules) {
    if (rule.status !== undefined && rule.status !== signal.status) continue;
    if (rule.exitCode !== undefined && rule.exitCode !== signal.exitCode) continue;
    if (rule.contains !== undefined) {
      const needle = rule.contains.toLowerCase();
      if (!fields.some((f) => f.includes(needle))) continue;
    }
    if (rule.matches !== undefined) {
      let re: RegExp;
      try {
        re = new RegExp(rule.matches, "i");
      } catch (err) {
        throw new Error(`rule "${rule.id}" has an invalid pattern: ${(err as Error).message}`);
      }
      if (!fields.some((f) => re.test(f))) continue;
    }
    // A rule with no conditions at all would match everything silently.
    const hasCondition =
      rule.status !== undefined ||
      rule.exitCode !== undefined ||
      rule.contains !== undefined ||
      rule.matches !== undefined;
    if (!hasCondition)
      throw new Error(`rule "${rule.id}" has no conditions, so it matches every error`);
    return rule;
  }
  return null;
}

export type ClassifyOptions = {
  readonly rules?: ReadonlyArray<ErrorRule>;
  /** Epoch milliseconds, only used to turn an HTTP-date `Retry-After` into a wait. */
  readonly nowMs?: number;
};

export function classifyError(signal: ErrorSignal, options: ClassifyOptions = {}): Classification {
  const message = (signal.message ?? "").slice(0, MAX_MESSAGE_CHARS);
  const fields = [message.toLowerCase(), (signal.code ?? "").toLowerCase()];

  const retry =
    signal.retryAfter === undefined
      ? { waitMs: null, retryAt: null }
      : parseRetryAfter(signal.retryAfter, options.nowMs);

  let verdict: Verdict | null = null;
  let matched = "default";
  let source: Classification["source"] = "default";

  const custom = matchCustom(signal, options.rules ?? [], fields);
  if (custom) {
    verdict = { class: custom.class, action: custom.action, waitMs: custom.waitMs };
    matched = custom.id;
    source = "custom";
  }

  if (!verdict && signal.status !== undefined) {
    const found = STATUS_TABLE.get(signal.status);
    if (found) {
      verdict = found;
      matched = `status:${signal.status}`;
      source = "status";
    } else if (signal.status >= 200 && signal.status < 300) {
      verdict = { class: "ok", action: "continue" };
      matched = "status:2xx";
      source = "status";
    } else if (signal.status >= 300 && signal.status < 400) {
      verdict = { class: "redirect", action: "fail" };
      matched = "status:3xx";
      source = "status";
    } else if (signal.status >= 500) {
      verdict = { class: "transient", action: "retry" };
      matched = "status:5xx";
      source = "status";
    } else if (signal.status >= 400) {
      verdict = { class: "bad_request", action: "fail" };
      matched = "status:4xx";
      source = "status";
    }
  }

  if (!verdict && signal.signal !== undefined) {
    const found = SIGNAL_TABLE.get(signal.signal.toUpperCase());
    if (found) {
      verdict = found;
      matched = `signal:${signal.signal.toUpperCase()}`;
      source = "signal";
    }
  }

  if (!verdict && signal.exitCode !== undefined) {
    const direct = EXIT_TABLE.get(signal.exitCode);
    if (direct) {
      verdict = direct;
      matched = `exit:${signal.exitCode}`;
      source = "exit";
    } else {
      const named = EXIT_SIGNALS.get(signal.exitCode);
      const found = named ? SIGNAL_TABLE.get(named) : undefined;
      if (named && found) {
        verdict = found;
        matched = `exit:${signal.exitCode} (${named})`;
        source = "signal";
      }
    }
  }

  if (!verdict && signal.code !== undefined) {
    const found = CODE_TABLE.get(signal.code) ?? CODE_TABLE.get(signal.code.toUpperCase());
    if (found) {
      verdict = found;
      matched = `code:${signal.code}`;
      source = "code";
    }
  }

  if (!verdict && message !== "") {
    const lower = message.toLowerCase();
    for (const [needle, found] of MESSAGE_TABLE) {
      if (lower.includes(needle)) {
        verdict = found;
        matched = `message:${needle}`;
        source = "message";
        break;
      }
    }
  }

  if (!verdict) verdict = { class: "unknown", action: "escalate" };

  // A server that told us when to come back outranks a generic "retry".
  let action = verdict.action;
  const waitMs = verdict.waitMs ?? retry.waitMs;
  if (RETRY_BY_DEFAULT.has(verdict.class) && retry.waitMs !== null && action === "retry") {
    action = "retry_after";
  }
  if (action === "retry_after" && waitMs === null && retry.retryAt === null) action = "backoff";

  // Attempts run out regardless of how retryable the class is. Without this
  // a loop reading `action` alone retries a 503 forever.
  const exhausted =
    signal.attempt !== undefined &&
    signal.maxAttempts !== undefined &&
    signal.attempt >= signal.maxAttempts;
  if (exhausted && RETRY_ACTIONS.has(action)) action = "escalate";

  // `retryable` follows the action, not the class. Deriving it from the class
  // instead would report an OOM kill — class `capacity`, action `escalate` —
  // as retryable, and a caller that reads the boolean rather than the action
  // would re-run the identical command and be killed identically.
  const retryable = RETRY_ACTIONS.has(action);

  return {
    class: verdict.class,
    action,
    retryable,
    waitMs: waitMs ?? null,
    retryAt: retry.retryAt,
    matched,
    source,
    exhausted,
  };
}
