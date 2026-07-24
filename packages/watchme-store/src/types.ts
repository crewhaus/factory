/**
 * Record schemas for the "watch me" durable store. Everything persisted by
 * `@crewhaus/watchme-store` is one of these shapes, serialized as JSONL (the
 * append-only files) or a single JSON document (state / registry).
 *
 * Redaction is NOT this package's job: every text-bearing field is redacted
 * by the caller BEFORE append (the CLI injects its PII redactor). This
 * package never imports detectors and never inspects content.
 */

/**
 * One redacted per-session digest line. NO transcript text except through the
 * injected redact callback; NO pointers into raw transcripts (sessionId is
 * provenance only — the digest must stand alone after TTL eviction).
 */
export type WatchmeObservation = {
  readonly v: 1;
  readonly sessionId: string;
  readonly specName: string;
  readonly target: string;
  readonly agentId?: string;
  /** Analysis time, epoch ms. */
  readonly ts: number;
  /** deriveTurns count (the turnNumber contract). */
  readonly turnCount: number;
  /** How per-turn model attribution was derived: envelope turnNumber from the
   *  `.events.jsonl` sibling (`exact`) vs insertion-order correlation of the
   *  durable mirrors (`ordered` — aggregate at session level only). */
  readonly joinConfidence: "exact" | "ordered";
  readonly models: ReadonlyArray<{
    readonly wire: string;
    readonly spec?: string;
    readonly provider: string;
    readonly turns: number;
    readonly usage: { in: number; out: number; cacheRead: number; cacheCreate: number };
    readonly costUsdMicros?: number;
    readonly unpriced?: boolean;
  }>;
  readonly toolStats: ReadonlyArray<{
    readonly name: string;
    readonly calls: number;
    readonly errors: number;
  }>;
  readonly continuity?: Readonly<
    Record<string, { score: number; passed: boolean; higherIsBetter: boolean }>
  >;
  readonly factuality?: {
    readonly claims: number;
    readonly grounded: number;
    readonly faithfulness?: number;
    readonly hallucinationRate?: number;
    readonly vacuous?: boolean;
  };
  readonly quality?: {
    readonly ratings: number;
    readonly meanRating?: number;
    readonly judged: number;
    readonly meanJudge?: number;
  };
  /** Cluster keys only (redacted upstream). */
  readonly intentKeys: ReadonlyArray<string>;
  readonly feedback?: { readonly up: number; readonly down: number };
};

/**
 * Welford aggregate line: `{v:1, agg:1, key, n, mean..., m2...}` (the
 * scoreboard.ts line grammar, cloned). `compact()` folds raw observation
 * lines into one aggregate per key so `observations.jsonl` stays a bounded
 * long-horizon store; aggregates parallel-combine (Chan et al.) with later
 * aggregates on the next compaction.
 */
export type WatchmeAggregate = {
  readonly v: 1;
  readonly agg: 1;
  /** Aggregation key: `<specName>|<target>`. */
  readonly key: string;
  /** Observations folded into this aggregate. */
  readonly n: number;
  /** Welford mean/M2 of per-session `turnCount`. */
  readonly meanTurns: number;
  readonly m2Turns: number;
  /** Welford mean/M2 of the per-session quality mean (ratings and judgments
   *  pooled, count-weighted); `qualityN` counts the sessions that carried one. */
  readonly meanQuality: number;
  readonly m2Quality: number;
  readonly qualityN: number;
  /** Summed counters across folded observations. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsdMicros: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly feedbackUp: number;
  readonly feedbackDown: number;
  /** Per-intent-cluster occurrence counts (cluster keys only, redacted upstream). */
  readonly intents: Readonly<Record<string, number>>;
};

/** Phase-2 judge verdict — watchme's OWN store, deliberately NOT a FeedbackRecord. */
export type WatchmeJudgment = {
  readonly v: 1;
  readonly sessionId: string;
  readonly turnNumber: number;
  /** Model that PRODUCED the turn (spec string). */
  readonly model: string;
  readonly judgeModel: string;
  /** Judge score in `[0, 1]`. */
  readonly score: number;
  /** Redacted before append. */
  readonly rationale: string;
  readonly ts: number;
};

/** The `watchme/state.json` document. */
export type WatchmeState = {
  readonly schemaVersion: 1;
  readonly watching: boolean;
  readonly startedAt?: number;
  /** Analysis high-water mark over the sessions directory — a cheap scalar
   *  pre-filter only. The authority for the skip/growth decision is the
   *  per-session `observed` cursor below; the watermark is consulted solely
   *  for sessions the cursor has never tracked (pre-cursor digests or entries
   *  the cursor cap evicted), so a grown session is never permanently skipped. */
  readonly watermark: { readonly lastMtimeMs: number; readonly lastSessionId?: string };
  /**
   * Durable per-session analysis cursor: the last-digested `mtimeMs` +
   * `turnCount` for each sessionId. It lives in `state.json`, which
   * `compact()` never rewrites, so it survives compaction — unlike the raw
   * observation lines, which fold away into `{agg:1}` aggregates. Enumeration
   * skips a session only while its on-disk state is unchanged relative to this
   * cursor; a session whose file grew (mtime advanced ⇒ turnCount may have
   * grown) is re-analyzed, and the last-writer-wins observation log makes the
   * re-digest idempotent. Bounded to the most-recent entries by `mtimeMs`
   * (oldest evicted, cap in watchme-report) so `state.json` stays small.
   */
  readonly observed?: Readonly<
    Record<string, { readonly mtimeMs: number; readonly turnCount: number }>
  >;
  /** Durable `sessionId#turnNumber` keys already recorded as shadow routing
   *  arms by `report --feed-routing`, so re-runs never double-record the same
   *  arm even after the sessions fall past the analysis watermark. Bounded
   *  (oldest-first eviction, cap in watchme-report). */
  readonly fedRoutingKeys?: readonly string[];
  /** Consumed report windows by `windowKey` → outcome. `ok` and
   *  `model_refused_unpriced` consume the window; a transient `model_failed`
   *  is recorded but the next tick retries (dream-engine semantics). */
  readonly windows: Readonly<Record<string, "ok" | "model_refused_unpriced" | "model_failed">>;
  readonly lastReportAt?: number;
};

/** One row of the global `~/.crewhaus/watchme/harnesses.json` registry. */
export type HarnessEntry = {
  /** Absolute harness directory (the standalone-harness cwd). */
  readonly dir: string;
  readonly specName: string;
  readonly target: string;
  readonly agentId?: string;
  /**
   * Whether this harness opted into cross-harness co-learning (`watchme.share`
   * from the spec), captured at registration time. `report --all` recalls a
   * peer's local wiki articles ONLY when this is `true`. Absent on legacy
   * entries → treated as not-shared (backward-compatible default). This is an
   * intent flag on the same-machine registry, NOT a Thredz visibility signal
   * (cross-machine sharing is a deferred seam — design/watch-me.md §10).
   */
  readonly share?: boolean;
  readonly registeredAt: number;
  readonly lastSeen: number;
};
