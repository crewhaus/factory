/**
 * "Have I already told them about this?" — as a pure function over a state
 * record the caller keeps.
 *
 * A harness that notices the same broken thing on every loop iteration will
 * notify about it on every loop iteration unless something remembers. That
 * memory has to live somewhere the harness controls (a KV entry, a file, a
 * field on its own state) rather than inside a tool, because a tool's
 * process-local memory dies with the process and the flood comes back after
 * the first restart. So this takes the state in and hands the next state
 * back, and the caller persists it wherever its state already lives.
 *
 * Fixed windows, not a sliding log. A sliding window needs every timestamp
 * retained, which grows without bound in exactly the situation the gate
 * exists for; a fixed window costs two numbers per key and is easy to
 * reason about out loud ("at most 3 per hour per key").
 */

export type RateEntry = {
  /** Start of the current window, in epoch milliseconds. */
  readonly windowStart: number;
  /** How many sends have been recorded in that window. */
  readonly count: number;
  /** When the most recent send was recorded. */
  readonly last: number;
};

export type RateState = Readonly<Record<string, RateEntry>>;

export type RateDecision = {
  readonly allowed: boolean;
  readonly reason: string;
  /** Sends recorded for this key in the current window, after this call. */
  readonly count: number;
  readonly limit: number;
  /** Milliseconds until the window resets. Present only when refused. */
  readonly retryAfterMs?: number;
  /** When the window resets, ISO-8601 UTC. Present only when refused. */
  readonly retryAt?: string;
  /** The record to persist. Unchanged from the input when refused. */
  readonly nextState: RateState;
  /** Keys dropped because their window had long expired. */
  readonly pruned: readonly string[];
};

/**
 * How many expired windows to keep before pruning. A state record that only
 * ever grows is a slow leak in whatever the harness persists it to, so
 * entries whose window ended more than `windowMs` ago are dropped — they can
 * no longer refuse anything, so nothing is lost by forgetting them.
 */
function prune(
  state: RateState,
  nowMs: number,
  windowMs: number,
  keep: string,
): { readonly kept: Record<string, RateEntry>; readonly pruned: string[] } {
  const kept: Record<string, RateEntry> = {};
  const pruned: string[] = [];
  for (const name of Object.keys(state).sort()) {
    const entry = state[name] as RateEntry;
    if (name !== keep && nowMs - entry.windowStart >= windowMs * 2) {
      pruned.push(name);
      continue;
    }
    kept[name] = entry;
  }
  return { kept, pruned };
}

export type RateOptions = {
  readonly key: string;
  readonly nowMs: number;
  readonly windowMs: number;
  /** How many sends the window allows. Default 1 — "tell me once". */
  readonly limit?: number;
  /**
   * `"consume"` records the send when it is allowed; `"peek"` answers the
   * question without changing anything, for a caller that wants to decide
   * before it has built the message.
   */
  readonly mode?: "consume" | "peek";
  readonly state?: RateState;
};

/** Decide, and hand back the record to persist. */
export function rateLimitGate(options: RateOptions): RateDecision {
  const limit = Math.max(1, options.limit ?? 1);
  const windowMs = Math.max(1, options.windowMs);
  const state = options.state ?? {};
  const { kept, pruned } = prune(state, options.nowMs, windowMs, options.key);

  const existing = kept[options.key];
  const inWindow = existing !== undefined && options.nowMs - existing.windowStart < windowMs;
  const current = inWindow ? (existing as RateEntry) : undefined;
  const count = current?.count ?? 0;

  if (count >= limit) {
    const windowStart = (current as RateEntry).windowStart;
    const resetAt = windowStart + windowMs;
    return {
      allowed: false,
      reason: `"${options.key}" has already been notified ${count} time(s) in this window of ${windowMs}ms, which is the limit`,
      count,
      limit,
      retryAfterMs: Math.max(0, resetAt - options.nowMs),
      retryAt: new Date(resetAt).toISOString(),
      nextState: kept,
      pruned,
    };
  }

  if (options.mode === "peek") {
    return {
      allowed: true,
      reason: `"${options.key}" is under the limit; nothing was recorded because mode is "peek"`,
      count,
      limit,
      nextState: kept,
      pruned,
    };
  }

  const next: Record<string, RateEntry> = { ...kept };
  next[options.key] = {
    windowStart: current?.windowStart ?? options.nowMs,
    count: count + 1,
    last: options.nowMs,
  };
  return {
    allowed: true,
    reason:
      count === 0
        ? `"${options.key}" has not been notified in this window`
        : `"${options.key}" is under the limit of ${limit} per ${windowMs}ms`,
    count: count + 1,
    limit,
    nextState: next,
    pruned,
  };
}
