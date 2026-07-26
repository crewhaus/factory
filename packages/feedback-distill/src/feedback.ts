/**
 * Response-feedback core — the pure, side-effect-free half of the
 * `crewhaus rate` / `crewhaus feedback` / `crewhaus distill` subcommands.
 *
 * A `FeedbackRecord` is one human rating placed on one assistant turn (a
 * thumbs up/down, a 1–5 star vote, an arbitrary scale vote, and/or a
 * free-text comment or correction). The capture surfaces write it durably as
 * a `user_feedback` event-log line (payload = FeedbackRecord); the web-UI host
 * writes bare records to `.crewhaus/feedback/*.jsonl`. `distill` reads both,
 * pairs each rating to a conversation turn, and emits the two artifacts the
 * R-eval stack already consumes: a `Sample[]` dataset (`@crewhaus/eval-dataset`)
 * and a `graders.yaml` (`@crewhaus/eval-grader`).
 *
 * Everything here is pure so it is unit-testable; the CLI's filesystem access
 * lives in `apps/cli/src/index.ts`, and the daemon's in this package's
 * `collect.ts` / `janitor-step.ts` (D39 — a compiled daemon distills on its
 * janitor clock instead of waiting for a `crewhaus run` teardown that never
 * comes). `apps/cli/src/feedback.ts` re-exports this module verbatim, so
 * every historical `./feedback` import is unchanged.
 *
 * turnNumber convention: the 1-based ordinal of USER-TEXT turns in a session.
 * A `user_message` whose content is a string (or an array containing a `text`
 * block and no `tool_result` block) starts a new turn; a `user_message` that
 * carries only `tool_result` blocks is a tool-result echo, and one marked
 * `synthetic: true` (a runtime-injected loop/continue/tombstone nudge) is NOT a
 * turn. This is the same count the CLI `--turn` flag, the web-UI (prompts
 * sent), and the runtime's runContext.turnNumber all compute, so a rating keys
 * back to the exact exchange it rated even after a recovery fires mid-session.
 */

/** The event-log EventKind under which a FeedbackRecord is persisted. */
export const FEEDBACK_EVENT_KIND = "user_feedback" as const;

export const FEEDBACK_SCHEMA_VERSION = 1 as const;

export type FeedbackModality = "binary" | "stars" | "scale" | "comment";
/** "watchme" marks machine judge verdicts bridged from `.crewhaus/watchme/
 *  judgments.jsonl` — written ONLY by the explicit `crewhaus watchme report
 *  --emit-feedback` opt-in, never by the capture loop (human-signal purity). */
export type FeedbackSource = "user" | "ui" | "channel" | "cli" | "watchme";

export type FeedbackRating = {
  thumbs?: "up" | "down";
  stars?: number;
  scale?: { value: number; min: number; max: number };
};

export type FeedbackRecord = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  runId?: string;
  /** 1-based ordinal of the rated user-text turn. */
  turnNumber: number;
  /** spanId of the rated model_response, when the capture surface knows it. */
  targetSpanId?: string;
  modality: FeedbackModality;
  rating: FeedbackRating;
  comment?: string;
  /** A user-supplied better answer — becomes `expected_output` at distill. */
  correction?: string;
  source: FeedbackSource;
  rater?: string;
  /** B19 — this record is an ADJUDICATION: at distill time it always wins a
   *  multi-rater disagreement on its turn and closes it (no review-queue
   *  entry). Written by `crewhaus rate --adjudicate` / `feedback
   *  --adjudicate`; absent on every pre-B19 record. */
  adjudication?: boolean;
  /** ISO 8601 timestamp. */
  ts: string;
};

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** Max stored length for a free-text comment/correction. Untrusted input (a
 *  hand-edited or web-UI-supplied `.crewhaus/feedback` line) flows into
 *  expected_output/metadata and the optimizer meta-prompt, so it is bounded at
 *  ingestion and stripped of control chars (newline/tab kept). */
export const MAX_FEEDBACK_TEXT = 8192;

export function clipFeedbackText(s: string): string {
  // Drop C0/C1 control chars and DEL (keeping tab, newline, carriage return),
  // then bound the length. Built by code point so the source carries no
  // literal control characters.
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const printable =
      c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f));
    if (printable) out += ch;
    if (out.length >= MAX_FEEDBACK_TEXT) break;
  }
  return out.slice(0, MAX_FEEDBACK_TEXT);
}

function isValidRating(rating: Record<string, unknown>): boolean {
  const { thumbs, stars, scale } = rating as {
    thumbs?: unknown;
    stars?: unknown;
    scale?: unknown;
  };
  if (thumbs !== undefined && thumbs !== "up" && thumbs !== "down") return false;
  if (stars !== undefined) {
    if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5)
      return false;
  }
  if (scale !== undefined) {
    if (typeof scale !== "object" || scale === null) return false;
    const s = scale as Record<string, unknown>;
    if (!["value", "min", "max"].every((k) => typeof s[k] === "number" && Number.isFinite(s[k]))) {
      return false;
    }
  }
  return true;
}

/** Narrow an arbitrary parsed JSON value to a FeedbackRecord. Tolerant of the
 *  optional fields; rejects anything missing the required core OR carrying a
 *  malformed rating (so a corrupt/crafted line can't coerce a NaN/spurious
 *  score downstream). */
export function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return false;
  if (typeof v["id"] !== "string") return false;
  if (typeof v["sessionId"] !== "string" || !SESSION_ID_REGEX.test(v["sessionId"] as string)) {
    return false;
  }
  if (typeof v["turnNumber"] !== "number" || !Number.isFinite(v["turnNumber"])) return false;
  const modality = v["modality"];
  if (
    modality !== "binary" &&
    modality !== "stars" &&
    modality !== "scale" &&
    modality !== "comment"
  ) {
    return false;
  }
  if (typeof v["rating"] !== "object" || v["rating"] === null) return false;
  if (!isValidRating(v["rating"] as Record<string, unknown>)) return false;
  if (typeof v["source"] !== "string") return false;
  if (typeof v["ts"] !== "string") return false;
  if (v["adjudication"] !== undefined && typeof v["adjudication"] !== "boolean") return false;
  return true;
}

export type BuildFeedbackInput = {
  id: string;
  sessionId: string;
  turnNumber: number;
  ts: string;
  source: FeedbackSource;
  runId?: string;
  targetSpanId?: string;
  rater?: string;
  /** B19 — mark the record as an adjudication (see FeedbackRecord). */
  adjudicate?: boolean;
  thumbs?: "up" | "down";
  stars?: number;
  /** A [0,1] scalar score (stored as scale {min:0,max:1}). */
  score?: number;
  /** A scale rating on the CAPTURE SURFACE's own range, stored verbatim (the
   *  gateway's `feedback.submit` accepts one). Mutually exclusive with
   *  `score`, which is the pre-normalized [0,1] form the CLI passes. */
  scale?: { value: number; min: number; max: number };
  comment?: string;
  correction?: string;
};

/**
 * Assemble + validate a FeedbackRecord from capture-surface inputs. The
 * modality is inferred from which rating fields are present (thumbs → binary,
 * stars → stars, score → scale, else → comment). Throws a plain Error (the CLI
 * routes it through `die`) when no rating signal at all is supplied.
 */
export function buildFeedbackRecord(input: BuildFeedbackInput): FeedbackRecord {
  const rating: FeedbackRating = {};
  let modality: FeedbackModality | undefined;
  if (input.thumbs !== undefined) {
    rating.thumbs = input.thumbs;
    modality = "binary";
  }
  if (input.stars !== undefined) {
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw new Error(`--stars must be an integer 1–5 (got ${input.stars})`);
    }
    rating.stars = input.stars;
    modality = "stars";
  }
  if (input.score !== undefined) {
    if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
      throw new Error(`--score must be a number in [0,1] (got ${input.score})`);
    }
    rating.scale = { value: input.score, min: 0, max: 1 };
    modality = "scale";
  }
  if (input.scale !== undefined) {
    const { value, min, max } = input.scale;
    if (![value, min, max].every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error("scale must carry finite value/min/max numbers");
    }
    if (!(min < max)) throw new Error(`scale min (${min}) must be < max (${max})`);
    if (value < min || value > max) {
      throw new Error(`scale value ${value} is outside its declared range [${min}, ${max}]`);
    }
    rating.scale = { value, min, max };
    modality = "scale";
  }
  if (modality === undefined) {
    if (input.comment === undefined && input.correction === undefined) {
      throw new Error(
        "no rating supplied — give --thumbs, --stars, --score, --text, or --correction",
      );
    }
    modality = "comment";
  }
  // B19 — an adjudication must carry a VERDICT. A comment alone can't settle
  // a disagreement: resolveFeedback would have nothing to overrule the split
  // with, and the turn's label would fall back to whichever disputing rater
  // voted last — the exact timestamp pathology adjudication exists to end.
  if (input.adjudicate === true && modality === "comment" && input.correction === undefined) {
    throw new Error(
      "--adjudicate needs a verdict — give a rating (--thumbs/--stars/--score) or --correction; a comment alone cannot settle a disagreement",
    );
  }
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: input.id,
    sessionId: input.sessionId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    turnNumber: input.turnNumber,
    ...(input.targetSpanId !== undefined ? { targetSpanId: input.targetSpanId } : {}),
    modality,
    rating,
    ...(input.comment !== undefined ? { comment: clipFeedbackText(input.comment) } : {}),
    ...(input.correction !== undefined ? { correction: clipFeedbackText(input.correction) } : {}),
    source: input.source,
    ...(input.rater !== undefined ? { rater: input.rater } : {}),
    ...(input.adjudicate === true ? { adjudication: true } : {}),
    ts: input.ts,
  };
}

/**
 * Normalize a rating to [0,1] — the same convention `GradeResult.score` uses
 * ((n-1)/4 for a 1–5 judge score). Returns `undefined` for a comment-only
 * record (no numeric signal). Thumbs: up→1, down→0. Stars n→(n-1)/4. Scale
 * value→(value-min)/(max-min), clamped.
 */
export function normalizeRating(r: FeedbackRecord): number | undefined {
  const { thumbs, stars, scale } = r.rating;
  if (thumbs !== undefined) return thumbs === "up" ? 1 : 0;
  if (stars !== undefined) return clamp01((stars - 1) / 4);
  if (scale !== undefined) {
    const span = scale.max - scale.min;
    if (span <= 0) return undefined;
    return clamp01((scale.value - scale.min) / span);
  }
  return undefined;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// -------- transcript → turns --------

/** A parsed event-log line: `{ ts, version, kind, payload }`. */
export type LoggedEvent = { kind?: string; payload?: unknown };

export type DerivedTurn = {
  turnNumber: number;
  /** The user's text prompt for this turn. */
  input: string;
  /** The assistant's final text answer for this turn (what was rated). */
  output: string;
  /** Tool names the assistant called this turn, verbatim (PascalCase), unique. */
  toolNames: string[];
};

/** A DerivedTurn tagged with the session it came from — the join key for
 *  `distill`, so ratings across many sessions never collide on turnNumber. */
export type SessionTurn = DerivedTurn & { sessionId: string };

function turnKey(sessionId: string, turnNumber: number): string {
  return `${sessionId}#${turnNumber}`;
}

type Block = { type?: string; text?: string; name?: string };

function contentBlocks(payload: unknown): { blocks: Block[]; text?: string } {
  const content = (payload as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return { blocks: [], text: content };
  if (Array.isArray(content)) return { blocks: content as Block[] };
  return { blocks: [] };
}

/** The text when a `user_message` is a real user-text turn (string content, or
 *  an array with ≥1 text block and no tool_result block); undefined otherwise.
 *  Runtime-injected nudges (loop warnings, "continue"/tombstone recovery) carry
 *  `synthetic: true` and are NOT turns — skipping them keeps deriveTurns's turn
 *  ordinal aligned with the runtime's runContext.turnNumber and the web UI. */
function userTurnText(payload: unknown): string | undefined {
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { synthetic?: unknown }).synthetic === true
  ) {
    return undefined;
  }
  const { blocks, text } = contentBlocks(payload);
  if (text !== undefined) return text;
  const hasToolResult = blocks.some((b) => b.type === "tool_result");
  if (hasToolResult) return undefined;
  const texts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function assistantText(payload: unknown): string {
  const { blocks, text } = contentBlocks(payload);
  if (text !== undefined) return text;
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function assistantToolNames(payload: unknown): string[] {
  const { blocks } = contentBlocks(payload);
  return blocks
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

/**
 * Reconstruct conversation turns from a session transcript. Each user-text
 * message opens a turn; the assistant's messages until the next user-text
 * message form its response. `output` is the LAST assistant text (the answer);
 * `toolNames` are the unique tool names the assistant called, in first-seen
 * order.
 */
export function deriveTurns(events: ReadonlyArray<LoggedEvent>): DerivedTurn[] {
  const turns: DerivedTurn[] = [];
  let current:
    | { turnNumber: number; input: string; texts: string[]; tools: string[]; toolSeen: Set<string> }
    | undefined;
  let counter = 0;

  const finalize = (): void => {
    if (!current) return;
    turns.push({
      turnNumber: current.turnNumber,
      input: current.input,
      output: current.texts.length > 0 ? (current.texts[current.texts.length - 1] as string) : "",
      toolNames: current.tools,
    });
  };

  for (const ev of events) {
    if (ev.kind === "user_message") {
      const text = userTurnText(ev.payload);
      if (text !== undefined) {
        finalize();
        counter += 1;
        current = { turnNumber: counter, input: text, texts: [], tools: [], toolSeen: new Set() };
      }
    } else if (ev.kind === "assistant_message" && current) {
      const t = assistantText(ev.payload);
      if (t !== "") current.texts.push(t);
      for (const name of assistantToolNames(ev.payload)) {
        if (!current.toolSeen.has(name)) {
          current.toolSeen.add(name);
          current.tools.push(name);
        }
      }
    }
  }
  finalize();
  return turns;
}

/** Extract FeedbackRecords from parsed JSON objects. Accepts both event-log
 *  envelopes (`{ kind: "user_feedback", payload }`) and bare records (the
 *  web-UI host's `.crewhaus/feedback/*.jsonl`). */
export function extractFeedbackRecords(objects: ReadonlyArray<unknown>): FeedbackRecord[] {
  const out: FeedbackRecord[] = [];
  for (const obj of objects) {
    if (obj && typeof obj === "object" && (obj as LoggedEvent).kind === FEEDBACK_EVENT_KIND) {
      const payload = (obj as LoggedEvent).payload;
      if (isFeedbackRecord(payload)) out.push(payload);
    } else if (isFeedbackRecord(obj)) {
      out.push(obj);
    }
  }
  return out;
}

/**
 * Collapse records to one per (sessionId, turnNumber). Rather than pure
 * last-write-wins — which would let a later comment-only `feedback` erase an
 * earlier `rate` on the same turn — fields are merged chronologically: the
 * newest value of each field wins, but a later comment-only record keeps the
 * earlier record's rating. So `rate --thumbs up` then `feedback --text "…"`
 * yields one record carrying BOTH.
 */
export function mergeFeedback(records: ReadonlyArray<FeedbackRecord>): FeedbackRecord[] {
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const byKey = new Map<string, FeedbackRecord>();
  for (const r of sorted) {
    const key = turnKey(r.sessionId, r.turnNumber);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? r : foldRecords(existing, r));
  }
  return [...byKey.values()];
}

function hasRating(r: FeedbackRecord): boolean {
  return (
    r.rating.thumbs !== undefined || r.rating.stars !== undefined || r.rating.scale !== undefined
  );
}

/** Merge an earlier + later record for the same turn (later ts wins per field;
 *  a comment-only later record does not erase the earlier rating). */
function foldRecords(earlier: FeedbackRecord, later: FeedbackRecord): FeedbackRecord {
  const ratingRecord = hasRating(later) ? later : hasRating(earlier) ? earlier : later;
  const comment = later.comment ?? earlier.comment;
  const correction = later.correction ?? earlier.correction;
  const rater = later.rater ?? earlier.rater;
  const runId = later.runId ?? earlier.runId;
  const targetSpanId = later.targetSpanId ?? earlier.targetSpanId;
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: later.id,
    sessionId: later.sessionId,
    turnNumber: later.turnNumber,
    modality: hasRating(ratingRecord) ? ratingRecord.modality : "comment",
    rating: ratingRecord.rating,
    source: later.source,
    ts: later.ts,
    ...(runId !== undefined ? { runId } : {}),
    ...(targetSpanId !== undefined ? { targetSpanId } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(correction !== undefined ? { correction } : {}),
    ...(rater !== undefined ? { rater } : {}),
  };
}

// -------- multi-rater resolution (B19) --------

/** One rater's merged verdict on one turn ([0,1]-normalized). */
export type RaterVote = {
  /** The rater identity (`""` for an unattributed record). */
  rater: string;
  /** The rater's normalized [0,1] rating. */
  score: number;
  /** Present when the vote was a thumbs verdict (the majority-rule input). */
  thumbs?: "up" | "down";
};

export type TurnResolutionKind = "majority" | "mean" | "adjudicated" | "tie";

/** Per-turn agreement record for a turn with ≥2 rating raters. */
export type TurnAgreement = {
  sessionId: string;
  turnNumber: number;
  votes: RaterVote[];
  resolution: TurnResolutionKind;
  /** All votes binarized at the resolve threshold land on the same verdict. */
  unanimous: boolean;
};

export type ResolvedFeedback = {
  /** One record per turn, in the same order `mergeFeedback` would produce.
   *  Single-rater turns fold exactly as before (byte-identical); multi-rater
   *  turns carry the aggregate verdict. Tie turns are ABSENT. */
  resolved: FeedbackRecord[];
  /** One entry per multi-rater turn (≥2 raters with a rating), ties included. */
  agreement: TurnAgreement[];
  /** The split-verdict turns (no adjudication): excluded from `resolved`,
   *  destined for the review queue instead of a silently-picked label. */
  ties: TurnAgreement[];
  /** Overall Cohen's kappa over the multi-rater turns: per rater pair over
   *  their common turns (verdicts binarized at the threshold), pooled as the
   *  common-turn-count-weighted mean. Present iff `agreement` is non-empty. */
  kappa?: number;
};

/**
 * B19 — collapse append-only feedback to one record per turn WITHOUT letting a
 * second rater silently erase the first. Records are grouped per (sessionId,
 * turnNumber) and then per rater (`rater ?? ""`), each rater's records folding
 * chronologically like `mergeFeedback`. A turn with ≤1 rating rater folds all
 * records chronologically — the exact pre-B19 behavior. A turn with ≥2 rating
 * raters resolves explicitly:
 *
 *   - any `adjudication: true` record wins and closes the turn (all records
 *     fold with the adjudications ordered last, so the adjudicator's fields
 *     take precedence);
 *   - else all-thumbs votes resolve by MAJORITY; a split vote is a TIE — the
 *     turn is withheld from `resolved` and reported in `ties`;
 *   - else (any stars/scale vote) the votes resolve to the MEAN normalized
 *     score (recorded as a scale {min:0,max:1} rating — no tie possible).
 *
 * `threshold` binarizes votes (score ≥ threshold) for the `unanimous` flag and
 * the Cohen's-kappa agreement statistic; distill passes its `minScore` so the
 * agreement figures use the same positive/negative bar as sample labeling.
 */
export function resolveFeedback(
  records: ReadonlyArray<FeedbackRecord>,
  opts: { threshold: number },
): ResolvedFeedback {
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const byTurn = new Map<string, FeedbackRecord[]>();
  for (const r of sorted) {
    const key = turnKey(r.sessionId, r.turnNumber);
    const list = byTurn.get(key);
    if (list === undefined) byTurn.set(key, [r]);
    else list.push(r);
  }

  const resolved: FeedbackRecord[] = [];
  const agreement: TurnAgreement[] = [];
  const ties: TurnAgreement[] = [];
  // rater → (turnKey → binarized verdict), the kappa input.
  const labelsByRater = new Map<string, Map<string, string>>();

  for (const [key, turnRecords] of byTurn) {
    const foldChronological = (list: ReadonlyArray<FeedbackRecord>): FeedbackRecord => {
      let acc = list[0] as FeedbackRecord;
      for (const r of list.slice(1)) acc = foldRecords(acc, r);
      return acc;
    };
    const foldAll = foldChronological(turnRecords);

    // Per-rater fold (records without a rater share the "" bucket).
    const byRater = new Map<string, FeedbackRecord>();
    for (const r of turnRecords) {
      const rk = r.rater ?? "";
      const prev = byRater.get(rk);
      byRater.set(rk, prev === undefined ? r : foldRecords(prev, r));
    }
    const votes: RaterVote[] = [];
    for (const [rater, rec] of byRater) {
      const score = normalizeRating(rec);
      if (score === undefined) continue; // comment-only rater — no vote
      votes.push({
        rater,
        score,
        ...(rec.rating.thumbs !== undefined ? { thumbs: rec.rating.thumbs } : {}),
      });
    }
    if (votes.length < 2) {
      // Single (or zero) rating rater — exact mergeFeedback behavior.
      resolved.push(foldAll);
      continue;
    }

    const first = turnRecords[0] as FeedbackRecord;
    const labels = votes.map((v) => (v.score >= opts.threshold ? "pos" : "neg"));
    for (let i = 0; i < votes.length; i++) {
      const vote = votes[i] as RaterVote;
      let m = labelsByRater.get(vote.rater);
      if (m === undefined) {
        m = new Map();
        labelsByRater.set(vote.rater, m);
      }
      m.set(key, labels[i] as string);
    }
    const unanimous = labels.every((l) => l === labels[0]);
    const entry = (resolution: TurnResolutionKind): TurnAgreement => ({
      sessionId: first.sessionId,
      turnNumber: first.turnNumber,
      votes,
      resolution,
      unanimous,
    });

    // Only an adjudication carrying a VERDICT (a rating or a correction) can
    // settle the turn. The CLI rejects verdict-less --adjudicate at capture
    // (buildFeedbackRecord), but a hand-edited/web-UI JSONL line can still
    // arrive flagged adjudication:true with neither — folding it last would
    // just re-crown whichever disputing rater voted latest, so it is ignored
    // as an adjudication (its comment still folds in) and the turn falls
    // through to the normal majority/tie logic.
    const adjudications = turnRecords.filter(
      (r) => r.adjudication === true && (hasRating(r) || r.correction !== undefined),
    );
    if (adjudications.length > 0) {
      // Adjudication always wins: fold with the adjudication records ordered
      // LAST so the adjudicator's rating/comment/correction take precedence
      // under the same later-wins fold every other path uses.
      const others = turnRecords.filter((r) => r.adjudication !== true);
      resolved.push(foldChronological([...others, ...adjudications]));
      agreement.push(entry("adjudicated"));
      continue;
    }

    if (votes.every((v) => v.thumbs !== undefined)) {
      const up = votes.filter((v) => v.thumbs === "up").length;
      const down = votes.length - up;
      if (up === down) {
        // A true tie is never silently resolved — withhold from distill.
        const tie = entry("tie");
        agreement.push(tie);
        ties.push(tie);
        continue;
      }
      const winner: "up" | "down" = up > down ? "up" : "down";
      resolved.push({ ...foldAll, modality: "binary", rating: { thumbs: winner } });
      agreement.push(entry("majority"));
      continue;
    }

    const mean = votes.reduce((s, v) => s + v.score, 0) / votes.length;
    resolved.push({
      ...foldAll,
      modality: "scale",
      rating: { scale: { value: mean, min: 0, max: 1 } },
    });
    agreement.push(entry("mean"));
  }

  const kappa = pairwiseKappa(labelsByRater);
  return { resolved, agreement, ties, ...(kappa !== undefined ? { kappa } : {}) };
}

/**
 * Cohen's kappa over paired categorical labels: (po − pe) / (1 − pe), po the
 * observed agreement fraction, pe the expected-by-chance agreement from each
 * side's marginal category distribution. `undefined` on an empty input. When
 * both sides used a single identical category throughout (pe = 1, agreement
 * trivially perfect) the degenerate ratio is reported as 1.
 */
export function cohenKappa(pairs: ReadonlyArray<readonly [string, string]>): number | undefined {
  if (pairs.length === 0) return undefined;
  const n = pairs.length;
  let agree = 0;
  const aCounts = new Map<string, number>();
  const bCounts = new Map<string, number>();
  for (const [a, b] of pairs) {
    if (a === b) agree += 1;
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [cat, ca] of aCounts) pe += (ca / n) * ((bCounts.get(cat) ?? 0) / n);
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

/** The overall figure: per-rater-pair Cohen's kappa over their common turns,
 *  pooled as the common-turn-count-weighted mean. Undefined when no pair
 *  shares a turn (i.e. no multi-rater turn existed). */
function pairwiseKappa(labelsByRater: Map<string, Map<string, string>>): number | undefined {
  const raters = [...labelsByRater.keys()].sort();
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) {
      const a = labelsByRater.get(raters[i] as string) as Map<string, string>;
      const b = labelsByRater.get(raters[j] as string) as Map<string, string>;
      const pairs: Array<readonly [string, string]> = [];
      for (const [key, la] of a) {
        const lb = b.get(key);
        if (lb !== undefined) pairs.push([la, lb]);
      }
      const k = cohenKappa(pairs);
      if (k !== undefined) {
        weighted += k * pairs.length;
        total += pairs.length;
      }
    }
  }
  return total > 0 ? weighted / total : undefined;
}

/** Render a vote for the agreement print: thumbs verbatim, else the score. */
function voteLabel(v: RaterVote): string {
  const who = v.rater === "" ? "(unattributed)" : v.rater;
  return `${who} ${v.thumbs ?? v.score.toFixed(2)}`;
}

/**
 * B19 — the `[distill]` agreement block: a kappa header plus one line per
 * multi-rater turn showing every rater's verdict and how it resolved.
 */
export function formatAgreementLines(agreement: {
  perTurn: ReadonlyArray<TurnAgreement>;
  kappa?: number;
}): string[] {
  const kappaText = agreement.kappa !== undefined ? agreement.kappa.toFixed(2) : "n/a";
  const lines = [
    `[distill] rater agreement: ${agreement.perTurn.length} multi-rater turn(s), Cohen's kappa ${kappaText}`,
  ];
  for (const t of agreement.perTurn) {
    const votes = t.votes.map(voteLabel).join(" / ");
    let outcome: string;
    if (t.resolution === "adjudicated") outcome = "adjudicated";
    else if (t.resolution === "tie") outcome = "TIE — withheld; needs adjudication";
    else if (t.resolution === "majority") {
      const up = t.votes.filter((v) => v.thumbs === "up").length;
      outcome = `majority ${up > t.votes.length - up ? "up" : "down"}`;
    } else {
      const mean = t.votes.reduce((s, v) => s + v.score, 0) / t.votes.length;
      outcome = `mean ${mean.toFixed(2)}`;
    }
    lines.push(`[distill]   ${t.sessionId} turn ${t.turnNumber}: ${votes} → ${outcome}`);
  }
  return lines;
}

// -------- distill --------

type Sample = {
  id: string;
  input: string;
  expected_output?: string;
  expected_tools?: string[];
  metadata?: Record<string, unknown>;
};

export type RubricAnchors = {
  "1": string;
  "2": string;
  "3": string;
  "4": string;
  "5": string;
};

export type GraderSpecObject =
  | {
      name: string;
      type: "tool_call_sequence";
      expected: string[];
      mode: "set" | "subseq" | "exact";
    }
  | { name: string; type: "contains"; substring: string; case_insensitive?: boolean }
  | { name: string; type: "regex"; pattern: string }
  | { name: string; type: "json_path"; path: string; expected?: unknown }
  | {
      name: string;
      type: "llm_judge";
      rubric: {
        criteria: Array<{ name: string; description: string; anchors: RubricAnchors }>;
        passing_score?: number;
      };
      model?: string;
    };

export type GradersConfigObject = { graders: GraderSpecObject[] };

export type DistillOptions = {
  /** Normalized score at/above which a turn is a positive (gold) sample. */
  minScore: number;
  /** Emit a single `llm_judge` grader seeded from comment themes instead of the
   *  deterministic grader. Opt-in (each eval sample then costs a judge call). */
  judge?: boolean;
  /** Judge model baked into the emitted llm_judge grader (else the runner's
   *  `--judge-model` applies at eval time). */
  judgeModel?: string;
  /** B23 — applied to every free-text field before it can land in a sample:
   *  turn input/output (→ `input` / `expected_output`), feedback
   *  comment/correction (→ gold, metadata, and the judge-rubric/grader
   *  synthesis they seed), and the rater identity (→ `metadata.rater` — it
   *  can be an email or chat handle, and `dataset audit` scans ALL string
   *  metadata leaves, so an unredacted rater would fail `--strict` on the
   *  default pipeline's own output). The CLI passes the shared sync
   *  PII/secret redactor (`dataset-audit.ts` `redactDatasetText`) unless
   *  `--no-redact` was given; absent → text flows verbatim, byte-identical
   *  to the pre-B23 behavior. */
  redact?: (text: string) => string;
};

export type DistillStats = {
  totalFeedback: number;
  matchedTurns: number;
  unmatchedFeedback: number;
  positives: number;
  negatives: number;
};

export type DistillResult = {
  samples: Sample[];
  graders: GradersConfigObject;
  stats: DistillStats;
  /** Non-fatal warnings (e.g. a rating whose turn is missing from the log). */
  warnings: string[];
  /** B19 — per-turn agreement + overall Cohen's kappa. Present iff at least
   *  one turn had ≥2 rating raters (single-rater corpora keep the exact
   *  pre-B19 result shape). */
  agreement?: { perTurn: TurnAgreement[]; kappa?: number };
  /** B19 — split-verdict turns (no adjudication): NOT distilled into samples;
   *  the CLI enqueues them to the review queue. Present iff non-empty. */
  ties?: TurnAgreement[];
};

/**
 * Tag-all distillation. Every rated turn becomes a Sample; positively-rated
 * turns (normalized ≥ minScore) — and any turn with a `correction` — become
 * GOLD (expected_output set), the rest carry a low `metadata.user_rating` and
 * no expected_output so they feed the optimizer's failure channel. A single
 * deterministic grader is synthesized from the positive turns' behavior
 * (exactly one, to avoid the hard-AND collapse in `all(...)`). When
 * `opts.redact` is set it runs over every turn/feedback free-text field FIRST,
 * so nothing downstream — samples, metadata, grader synthesis, the judge
 * rubric — ever sees the raw text (B23). B19 — turns rated by MULTIPLE raters
 * resolve via {@link resolveFeedback} (majority / mean / adjudication); split
 * verdicts are withheld from the samples and surfaced in `ties` instead.
 */
export function distill(
  turns: ReadonlyArray<SessionTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  opts: DistillOptions,
): DistillResult {
  const redact = opts.redact;
  const cleanTurns =
    redact === undefined
      ? turns
      : turns.map((t) => ({ ...t, input: redact(t.input), output: redact(t.output) }));
  const cleanFeedback =
    redact === undefined
      ? feedback
      : feedback.map((r) => ({
          ...r,
          ...(r.comment !== undefined ? { comment: redact(r.comment) } : {}),
          ...(r.correction !== undefined ? { correction: redact(r.correction) } : {}),
          ...(r.rater !== undefined ? { rater: redact(r.rater) } : {}),
        }));
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of cleanTurns) turnByKey.set(turnKey(t.sessionId, t.turnNumber), t);

  // B19 — multi-rater turns resolve explicitly (majority / mean /
  // adjudication) instead of later-timestamp-wins; single-rater turns fold
  // exactly as mergeFeedback always did. Split verdicts are withheld.
  const resolution = resolveFeedback(cleanFeedback, { threshold: opts.minScore });
  const merged = resolution.resolved;
  const agreementByKey = new Map<string, TurnAgreement>(
    resolution.agreement.map((a) => [turnKey(a.sessionId, a.turnNumber), a]),
  );
  const samples: Sample[] = [];
  const positiveTurns: DerivedTurn[] = [];
  const positiveComments: string[] = [];
  const negativeComments: string[] = [];
  const warnings: string[] = [];
  let matched = 0;
  let unmatched = 0;
  let positives = 0;
  let negatives = 0;

  for (const fb of merged) {
    const turn = turnByKey.get(turnKey(fb.sessionId, fb.turnNumber));
    if (turn === undefined) {
      unmatched += 1;
      warnings.push(
        `rating for ${fb.sessionId} turn ${fb.turnNumber} has no matching turn in the transcript — skipped`,
      );
      continue;
    }
    matched += 1;
    const score = normalizeRating(fb);
    const isPositive =
      (score !== undefined && score >= opts.minScore) || fb.correction !== undefined;
    // Gold = the user's correction, else the assistant's answer for a positive
    // turn. Omit an empty answer (e.g. a turn that errored before replying) so
    // we never emit a meaningless empty-string gold.
    const goldCandidate = fb.correction ?? (isPositive ? turn.output : undefined);
    const expectedOutput =
      goldCandidate !== undefined && goldCandidate.trim() !== "" ? goldCandidate : undefined;

    const metadata: Record<string, unknown> = {
      sessionId: fb.sessionId,
      turnNumber: fb.turnNumber,
      // B22 — distilled samples come from real production sessions, so the
      // canonical provenance taxonomy value is "production_log"; the rating
      // CHANNEL (user|ui|channel|cli — what `source` used to carry) moves to
      // `feedback_source` so no information is lost.
      source: "production_log",
      feedback_source: fb.source,
      raw_rating: fb.rating,
    };
    if (score !== undefined) metadata["user_rating"] = score;
    if (fb.comment !== undefined) metadata["comment"] = fb.comment;
    if (fb.correction !== undefined) metadata["correction"] = fb.correction;
    if (fb.rater !== undefined) metadata["rater"] = fb.rater;
    // B19 — a multi-rater turn records every rater's normalized verdict (the
    // individual annotations survive into the sample) and whether an
    // adjudication closed it. Single-rater samples are byte-identical.
    const agr = agreementByKey.get(turnKey(fb.sessionId, fb.turnNumber));
    if (agr !== undefined) {
      metadata["ratings"] = agr.votes.map((v) => ({ rater: v.rater, score: v.score }));
      if (agr.resolution === "adjudicated") metadata["adjudicated"] = true;
    }

    const sample: Sample = { id: `${fb.sessionId}_t${fb.turnNumber}`, input: turn.input, metadata };
    if (expectedOutput !== undefined) sample.expected_output = expectedOutput;
    if (isPositive && turn.toolNames.length > 0) sample.expected_tools = turn.toolNames;
    samples.push(sample);

    if (isPositive) {
      positives += 1;
      positiveTurns.push(turn);
      if (fb.comment !== undefined) positiveComments.push(fb.comment);
    } else {
      negatives += 1;
      if (fb.comment !== undefined) negativeComments.push(fb.comment);
    }
  }

  // B19 — a split verdict with no adjudication is disagreement SIGNAL, not a
  // label: say so loudly (the optimize --ratings path prints warnings too)
  // and let the CLI route the turn to the review queue.
  for (const t of resolution.ties) {
    const up = t.votes.filter((v) => v.thumbs === "up").length;
    warnings.push(
      `rater disagreement on ${t.sessionId} turn ${t.turnNumber} (${up} up / ${
        t.votes.length - up
      } down, no adjudication) — not distilled; settle it with \`crewhaus rate --adjudicate\` or \`crewhaus review\``,
    );
  }

  return {
    samples,
    graders:
      opts.judge === true
        ? { graders: [buildJudgeRubricGrader(positiveComments, negativeComments, opts.judgeModel)] }
        : synthesizeGraders(positiveTurns, warnings),
    stats: {
      // Ties count as rated turns (they exist; they just are not labelable).
      totalFeedback: merged.length + resolution.ties.length,
      matchedTurns: matched,
      unmatchedFeedback: unmatched,
      positives,
      negatives,
    },
    warnings,
    ...(resolution.agreement.length > 0
      ? {
          agreement: {
            perTurn: resolution.agreement,
            ...(resolution.kappa !== undefined ? { kappa: resolution.kappa } : {}),
          },
        }
      : {}),
    ...(resolution.ties.length > 0 ? { ties: resolution.ties } : {}),
  };
}

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "your",
  "have",
  "will",
  "here",
  "there",
  "what",
  "when",
  "which",
  "would",
  "could",
  "should",
  "about",
  "into",
  "then",
  "than",
  "them",
  "they",
  "you",
  "for",
  "are",
  "was",
  "were",
  "its",
]);

/**
 * Pick the single deterministic grader that best captures the up-rated
 * behavior. Prefers a `tool_call_sequence` over the tools every tool-using
 * positive turn shared (falling back to the most common tool); if the positive
 * turns used no tools, a `contains` over a distinctive token common to their
 * answers; failing that, a non-empty-answer floor (with a warning).
 */
export function synthesizeGraders(
  positiveTurns: ReadonlyArray<DerivedTurn>,
  warnings: string[] = [],
): GradersConfigObject {
  const toolCounts = new Map<string, number>();
  let turnsWithTools = 0;
  for (const t of positiveTurns) {
    const uniq = [...new Set(t.toolNames)];
    if (uniq.length > 0) turnsWithTools += 1;
    for (const name of uniq) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }

  if (turnsWithTools > 0 && toolCounts.size > 0) {
    const inEvery = [...toolCounts.entries()]
      .filter(([, c]) => c === turnsWithTools)
      .map(([n]) => n);
    let expected = inEvery;
    if (expected.length === 0) {
      const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      expected = top ? [top[0]] : [];
    }
    if (expected.length > 0) {
      return {
        graders: [{ name: "preferred_tools", type: "tool_call_sequence", expected, mode: "set" }],
      };
    }
  }

  const token = commonToken(positiveTurns.map((t) => t.output));
  if (token !== undefined) {
    return {
      graders: [
        { name: "preferred_phrase", type: "contains", substring: token, case_insensitive: true },
      ],
    };
  }

  warnings.push(
    "no consistent tool or phrase signal in the up-rated turns — emitted a non-empty-answer floor grader; add ratings or edit graders.yaml for a sharper eval",
  );
  return { graders: [{ name: "non_empty_answer", type: "regex", pattern: "\\S" }] };
}

/**
 * Build a single `llm_judge` grader seeded from the aggregated comment themes.
 * One criterion ("user_preference") with fixed 1–5 anchors and a description
 * folding a short, quoted, clipped summary of what users praised vs criticized.
 * Emitted as the SOLE grader so it is never hard-ANDed with a deterministic one
 * (the `all(...)` min-collapse). The untrusted comment text is bounded and
 * quoted-as-data; the rubric is trusted context sent verbatim to the judge.
 */
export function buildJudgeRubricGrader(
  positiveComments: ReadonlyArray<string>,
  negativeComments: ReadonlyArray<string>,
  model?: string,
): GraderSpecObject {
  const praised = summarizeComments(positiveComments);
  const criticized = summarizeComments(negativeComments);
  const praisedNote = praised !== undefined ? ` Users praised responses like: '${praised}'.` : "";
  const criticizedNote =
    criticized !== undefined ? ` Users criticized responses like: '${criticized}'.` : "";
  const description = `Judge how well the response matches the qualities real users prefer, learned from their ratings.${praisedNote}${criticizedNote}`;
  return {
    name: "user_preference",
    type: "llm_judge",
    rubric: {
      criteria: [
        {
          name: "user_preference",
          description,
          anchors: {
            "1": "Strongly conflicts with what users liked; clearly exhibits the criticized traits.",
            "2": "Mostly misses the qualities users preferred.",
            "3": "Partially matches user preferences; a mixed response.",
            "4": "Largely matches the qualities users praised.",
            "5": "Strongly matches the user-preferred style and avoids the criticized traits.",
          },
        },
      ],
      passing_score: 3,
    },
    ...(model !== undefined ? { model } : {}),
  };
}

/** Dedupe, join, and clip a batch of comments into one short quoted summary for
 *  a rubric description (~400 chars). Undefined when there are no comments. */
function summarizeComments(comments: ReadonlyArray<string>): string | undefined {
  const cleaned = [...new Set(comments.map((c) => c.trim()).filter((c) => c !== ""))];
  if (cleaned.length === 0) return undefined;
  const joined = clipFeedbackText(cleaned.slice(0, 8).join("; ")).replace(/'/g, "");
  return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
}

/** B23 — the ingestion redactor's own markers: replace-mode
 *  `[REDACTED:<kind>]` (the only form `dataset-audit.ts` `redactDatasetText`
 *  emits) plus the PiiRedactor hash mode's `[HASHED:<kind>:<hmac>]` for
 *  symmetry. Stripped before tokenizing so the marker's own tokens
 *  ("redacted", detector kinds like "email") can never win the frequency
 *  ranking and become a `preferred_phrase` grader — live agent output is
 *  never redacted, so such a grader could never pass. */
const REDACTION_MARKER_RE = /\[(?:REDACTED:[a-z0-9_]+|HASHED:[a-z0-9_]+:[0-9a-f]+)\]/gi;

/** The most frequent distinctive token (alnum, length ≥ 4, non-stopword)
 *  appearing in at least half of the answers. Undefined when none qualifies.
 *  Redaction markers are stripped first (see {@link REDACTION_MARKER_RE}) so
 *  a grader is only ever derived from the up-rated behavior itself. */
function commonToken(answers: ReadonlyArray<string>): string | undefined {
  const nonEmpty = answers.filter((a) => a.trim() !== "");
  if (nonEmpty.length === 0) return undefined;
  const docFreq = new Map<string, number>();
  for (const answer of nonEmpty) {
    const seen = new Set<string>();
    for (const raw of answer
      .replace(REDACTION_MARKER_RE, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
      seen.add(raw);
      docFreq.set(raw, (docFreq.get(raw) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(nonEmpty.length / 2);
  const ranked = [...docFreq.entries()]
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.length > 0 ? ranked[0]?.[0] : undefined;
}

// -------- serialization --------

/** One SampleSchema-valid JSON object per line (round-trips through loadJsonl). */
export function samplesToJsonl(samples: ReadonlyArray<Sample>): string {
  return `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`;
}

/** The default graders.yaml header — distill's provenance note. Callers with
 *  a different provenance (scaffold-evals item 13, graders suggest item 4)
 *  pass their own header lines instead. */
const DISTILL_GRADERS_HEADER: ReadonlyArray<string> = [
  "# Synthesized by `crewhaus distill` from user ratings.",
  "# Exactly one grader — stacking graders hard-ANDs their scores (see eval-grader `all`).",
];

/** Emit a GradersConfigSchema-valid graders.yaml. Scalars are JSON-encoded so
 *  arbitrary substrings/tool names stay YAML-safe (JSON is a YAML subset).
 *  `headerLines` replaces the distill provenance header (each line must be a
 *  full `# …` YAML comment). */
export function gradersConfigToYaml(
  config: GradersConfigObject,
  headerLines: ReadonlyArray<string> = DISTILL_GRADERS_HEADER,
): string {
  const lines: string[] = [...headerLines, "graders:"];
  for (const g of config.graders) {
    lines.push(`  - name: ${JSON.stringify(g.name)}`);
    lines.push(`    type: ${g.type}`);
    if (g.type === "tool_call_sequence") {
      lines.push(`    expected: ${JSON.stringify(g.expected)}`);
      lines.push(`    mode: ${g.mode}`);
    } else if (g.type === "contains") {
      lines.push(`    substring: ${JSON.stringify(g.substring)}`);
      if (g.case_insensitive !== undefined)
        lines.push(`    case_insensitive: ${g.case_insensitive}`);
    } else if (g.type === "json_path") {
      lines.push(`    path: ${JSON.stringify(g.path)}`);
      if (g.expected !== undefined) lines.push(`    expected: ${JSON.stringify(g.expected)}`);
    } else if (g.type === "llm_judge") {
      lines.push("    rubric:");
      lines.push("      criteria:");
      for (const c of g.rubric.criteria) {
        lines.push(`        - name: ${JSON.stringify(c.name)}`);
        lines.push(`          description: ${JSON.stringify(c.description)}`);
        lines.push("          anchors:");
        for (const k of ["1", "2", "3", "4", "5"] as const) {
          lines.push(`            ${JSON.stringify(k)}: ${JSON.stringify(c.anchors[k])}`);
        }
      }
      if (g.rubric.passing_score !== undefined) {
        lines.push(`      passing_score: ${g.rubric.passing_score}`);
      }
      if (g.model !== undefined) lines.push(`    model: ${JSON.stringify(g.model)}`);
    } else {
      lines.push(`    pattern: ${JSON.stringify(g.pattern)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
