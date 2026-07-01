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
 * Everything here is pure so it is unit-testable; all filesystem access lives
 * in `apps/cli/src/index.ts` (mirrors `doctor-checks.ts` / `scope-audit.ts`).
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
export type FeedbackSource = "user" | "ui" | "channel" | "cli";

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
  thumbs?: "up" | "down";
  stars?: number;
  /** A [0,1] scalar score (stored as scale {min:0,max:1}). */
  score?: number;
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
  if (modality === undefined) {
    if (input.comment === undefined && input.correction === undefined) {
      throw new Error(
        "no rating supplied — give --thumbs, --stars, --score, --text, or --correction",
      );
    }
    modality = "comment";
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

/** Dedupe records to one per (sessionId, turnNumber), last-write-wins by `ts`. */
export function mergeFeedback(records: ReadonlyArray<FeedbackRecord>): FeedbackRecord[] {
  const byKey = new Map<string, FeedbackRecord>();
  for (const r of records) {
    const key = turnKey(r.sessionId, r.turnNumber);
    const existing = byKey.get(key);
    if (existing === undefined || r.ts >= existing.ts) byKey.set(key, r);
  }
  return [...byKey.values()];
}

// -------- distill --------

type Sample = {
  id: string;
  input: string;
  expected_output?: string;
  expected_tools?: string[];
  metadata?: Record<string, unknown>;
};

export type GraderSpecObject =
  | {
      name: string;
      type: "tool_call_sequence";
      expected: string[];
      mode: "set" | "subseq" | "exact";
    }
  | { name: string; type: "contains"; substring: string; case_insensitive?: boolean }
  | { name: string; type: "regex"; pattern: string };

export type GradersConfigObject = { graders: GraderSpecObject[] };

export type DistillOptions = {
  /** Normalized score at/above which a turn is a positive (gold) sample. */
  minScore: number;
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
};

/**
 * Tag-all distillation. Every rated turn becomes a Sample; positively-rated
 * turns (normalized ≥ minScore) — and any turn with a `correction` — become
 * GOLD (expected_output set), the rest carry a low `metadata.user_rating` and
 * no expected_output so they feed the optimizer's failure channel. A single
 * deterministic grader is synthesized from the positive turns' behavior
 * (exactly one, to avoid the hard-AND collapse in `all(...)`).
 */
export function distill(
  turns: ReadonlyArray<SessionTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  opts: DistillOptions,
): DistillResult {
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of turns) turnByKey.set(turnKey(t.sessionId, t.turnNumber), t);

  const merged = mergeFeedback(feedback);
  const samples: Sample[] = [];
  const positiveTurns: DerivedTurn[] = [];
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
      source: fb.source,
      raw_rating: fb.rating,
    };
    if (score !== undefined) metadata["user_rating"] = score;
    if (fb.comment !== undefined) metadata["comment"] = fb.comment;
    if (fb.correction !== undefined) metadata["correction"] = fb.correction;
    if (fb.rater !== undefined) metadata["rater"] = fb.rater;

    const sample: Sample = { id: `${fb.sessionId}_t${fb.turnNumber}`, input: turn.input, metadata };
    if (expectedOutput !== undefined) sample.expected_output = expectedOutput;
    if (isPositive && turn.toolNames.length > 0) sample.expected_tools = turn.toolNames;
    samples.push(sample);

    if (isPositive) {
      positives += 1;
      positiveTurns.push(turn);
    } else {
      negatives += 1;
    }
  }

  return {
    samples,
    graders: synthesizeGraders(positiveTurns, warnings),
    stats: {
      totalFeedback: merged.length,
      matchedTurns: matched,
      unmatchedFeedback: unmatched,
      positives,
      negatives,
    },
    warnings,
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

/** The most frequent distinctive token (alnum, length ≥ 4, non-stopword)
 *  appearing in at least half of the answers. Undefined when none qualifies. */
function commonToken(answers: ReadonlyArray<string>): string | undefined {
  const nonEmpty = answers.filter((a) => a.trim() !== "");
  if (nonEmpty.length === 0) return undefined;
  const docFreq = new Map<string, number>();
  for (const answer of nonEmpty) {
    const seen = new Set<string>();
    for (const raw of answer.toLowerCase().split(/[^a-z0-9]+/)) {
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

/** Emit a GradersConfigSchema-valid graders.yaml. Scalars are JSON-encoded so
 *  arbitrary substrings/tool names stay YAML-safe (JSON is a YAML subset). */
export function gradersConfigToYaml(config: GradersConfigObject): string {
  const lines: string[] = [
    "# Synthesized by `crewhaus distill` from user ratings.",
    "# Exactly one grader — stacking graders hard-ANDs their scores (see eval-grader `all`).",
    "graders:",
  ];
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
    } else {
      lines.push(`    pattern: ${JSON.stringify(g.pattern)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
