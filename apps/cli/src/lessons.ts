/**
 * Item #56 — auto-maintained LESSONS.md + per-user preference files.
 *
 * `crewhaus lessons update` mines two durable signals:
 *   - CORRECTION lessons: a `user_feedback` record carrying a `correction`
 *     (the user's better answer) OR a low-rated turn with a comment — the
 *     "here's what went wrong / do this instead" signal.
 *   - FAILURE→FIX lessons: recurring negative signals from `dataset-mine`'s
 *     `mineSession` (tool-error spikes, runtime errors, loop nudges, retries)
 *     paired to the triggering turn — "when X happens, watch out."
 * These fold into a deduped, append-with-merge LESSONS.md (like the project-
 * memory files the runtime already auto-loads — LESSONS.md is added to the
 * canonical set, so it is injected into the system prompt at run start).
 *
 * Per-user preferences: when feedback carries a `rater` identity, ratings +
 * comments for that rater fold into a per-user prefs file
 * (`.crewhaus/preferences/<rater>.md`) injected when that user is known.
 *
 * Pure + deterministic (stable order, normalized-text dedupe → idempotent
 * re-runs); FS + redaction wiring lives in `apps/cli/src/index.ts`. Lesson +
 * preference text is model/user output → PII/secret-redacted by the caller.
 */

import { mergeFeedback, normalizeRating } from "./feedback";
import type { FeedbackRecord, SessionTurn } from "./feedback";

/** One durable lesson. `key` is the normalized-text dedupe handle. */
export type Lesson = {
  /** Normalized dedupe key (lowercased, whitespace-collapsed). */
  readonly key: string;
  /** The human-readable lesson line rendered into LESSONS.md. */
  readonly text: string;
  readonly kind: "correction" | "failure-fix";
};

export type LessonsOptions = {
  /** Low-rated threshold: a turn at/below this contributes a correction lesson
   *  when it carries a comment. Default 0.5. */
  readonly lowScore?: number;
  /** Async redactor for lesson text. Identity by default. */
  readonly redact?: (text: string) => Promise<string>;
};

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * Mine lessons from turns + feedback + pre-mined failure signals. Returns a
 * deterministically-ordered, deduped list. `failureSignals` is the output of
 * `mineSession` across the scanned sessions (each `{ input, reason }`), so the
 * failure→fix lessons reuse the same negative-signal detection the dataset
 * miner uses rather than reinventing it.
 */
export async function mineLessons(
  turns: ReadonlyArray<SessionTurn>,
  feedback: ReadonlyArray<FeedbackRecord>,
  failureSignals: ReadonlyArray<{ input: string; reason: string }>,
  opts: LessonsOptions = {},
): Promise<Lesson[]> {
  const lowScore = opts.lowScore ?? 0.5;
  const redact = opts.redact ?? (async (t: string) => t);
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of turns) turnByKey.set(`${t.sessionId}#${t.turnNumber}`, t);

  const byKey = new Map<string, Lesson>();
  const add = (text: string, kind: Lesson["kind"]): void => {
    const clean = clip(text, 300);
    if (clean === "") return;
    const key = normalizeKey(clean);
    if (!byKey.has(key)) byKey.set(key, { key, text: clean, kind });
  };

  // Correction lessons from feedback (merged so one per turn). #56 F3 — the
  // echoed question prefix is a raw user turn (may carry a pasted credential),
  // so it is redacted too, not just the correction/comment body.
  for (const fb of mergeFeedback(feedback)) {
    const turn = turnByKey.get(`${fb.sessionId}#${fb.turnNumber}`);
    const question = turn?.input?.trim();
    const score = normalizeRating(fb);
    if (fb.correction !== undefined && fb.correction.trim() !== "") {
      const q = question ? `For "${await redact(clip(question, 80))}": ` : "";
      add(`${q}prefer this answer — ${await redact(fb.correction)}`, "correction");
    } else if (
      fb.comment !== undefined &&
      fb.comment.trim() !== "" &&
      score !== undefined &&
      score <= lowScore
    ) {
      const q = question ? `For "${await redact(clip(question, 80))}": ` : "";
      add(`${q}avoid — ${await redact(fb.comment)}`, "correction");
    }
  }

  // Failure→fix lessons from the mined negative signals. #56 F3 — BOTH the
  // echoed user input AND the failure reason (raw error messages carry
  // connection strings / tokens) are redacted before landing in an
  // auto-injected lesson.
  for (const sig of failureSignals) {
    const redactedInput = sig.input.trim() !== "" ? await redact(clip(sig.input, 80)) : "";
    const q = redactedInput !== "" ? ` on "${redactedInput}"` : "";
    add(`Watch out${q}: ${await redact(sig.reason)}.`, "failure-fix");
  }

  // Stable order: corrections first (higher-signal), then failure-fixes; each
  // group alphabetized by key so re-runs produce byte-identical output.
  return [...byKey.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "correction" ? -1 : 1) || a.key.localeCompare(b.key),
  );
}

/**
 * Merge fresh lessons into existing ones, deduping by normalized key so a
 * re-run never duplicates a lesson (append-with-merge idempotency). Existing
 * lessons are preserved; new keys appended; ordering re-stabilized.
 */
export function mergeLessons(
  existing: ReadonlyArray<Lesson>,
  fresh: ReadonlyArray<Lesson>,
): Lesson[] {
  const byKey = new Map<string, Lesson>();
  for (const l of existing) byKey.set(l.key, l);
  for (const l of fresh) if (!byKey.has(l.key)) byKey.set(l.key, l);
  return [...byKey.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "correction" ? -1 : 1) || a.key.localeCompare(b.key),
  );
}

const LESSONS_HEADER = "# LESSONS";
const LESSONS_NOTE =
  "<!-- Auto-maintained by `crewhaus lessons update`. Deduped + idempotent; hand-edits above the marker are preserved. -->";
const LESSONS_MARKER = "<!-- crewhaus:lessons -->";

/**
 * Render LESSONS.md. Everything BELOW the `crewhaus:lessons` marker is machine-
 * managed (the sorted lesson list); anything a human wrote ABOVE it is
 * preserved verbatim by `parseLessonsMd` on the next update.
 */
export function renderLessonsMd(lessons: ReadonlyArray<Lesson>, preamble = ""): string {
  const corrections = lessons.filter((l) => l.kind === "correction");
  const failures = lessons.filter((l) => l.kind === "failure-fix");
  const lines: string[] = [];
  const pre = preamble.trimEnd();
  lines.push(pre === "" ? `${LESSONS_HEADER}\n\n${LESSONS_NOTE}` : pre);
  lines.push("");
  lines.push(LESSONS_MARKER);
  if (corrections.length > 0) {
    lines.push("");
    lines.push("## Corrections & preferences");
    lines.push("");
    for (const l of corrections) lines.push(`- ${l.text}`);
  }
  if (failures.length > 0) {
    lines.push("");
    lines.push("## Known failure patterns");
    lines.push("");
    for (const l of failures) lines.push(`- ${l.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Parse an existing LESSONS.md back into `{ preamble, lessons }`. The preamble
 * is everything before the `crewhaus:lessons` marker (preserved on re-render);
 * lessons are the `- ` bullets under the two managed sections, tagged by which
 * section they came from. Files without the marker are treated as all-preamble
 * (a human-authored file), so we never clobber hand-written lessons.
 */
export function parseLessonsMd(content: string): { preamble: string; lessons: Lesson[] } {
  const markerIdx = content.indexOf(LESSONS_MARKER);
  if (markerIdx === -1) return { preamble: content, lessons: [] };
  const preamble = content.slice(0, markerIdx).trimEnd();
  const managed = content.slice(markerIdx + LESSONS_MARKER.length);
  const lessons: Lesson[] = [];
  let kind: Lesson["kind"] = "correction";
  for (const rawLine of managed.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("## Known failure")) kind = "failure-fix";
    else if (line.startsWith("## Corrections")) kind = "correction";
    else if (line.startsWith("- ")) {
      const text = line.slice(2).trim();
      if (text !== "") lessons.push({ key: normalizeKey(text), text, kind });
    }
  }
  return { preamble, lessons };
}

// -------- per-user preferences --------

export type UserPreferences = {
  readonly rater: string;
  /** Preference bullets (comments on up-rated turns, corrections). */
  readonly notes: ReadonlyArray<string>;
};

/**
 * Fold feedback carrying a `rater` into per-user preference notes. A rater's
 * comments (on any rating) and corrections become their preference bullets,
 * deduped + stably ordered. Returns one entry per rater, sorted by rater id.
 */
export async function minePreferences(
  feedback: ReadonlyArray<FeedbackRecord>,
  opts: { redact?: (text: string) => Promise<string> } = {},
): Promise<UserPreferences[]> {
  const redact = opts.redact ?? (async (t: string) => t);
  const byRater = new Map<string, { keys: Set<string>; notes: string[] }>();
  for (const fb of mergeFeedback(feedback)) {
    if (fb.rater === undefined || fb.rater.trim() === "") continue;
    const bucket = byRater.get(fb.rater) ?? { keys: new Set<string>(), notes: [] };
    const candidates: string[] = [];
    if (fb.correction !== undefined && fb.correction.trim() !== "") {
      candidates.push(`prefers answers like: ${await redact(fb.correction)}`);
    }
    if (fb.comment !== undefined && fb.comment.trim() !== "") {
      candidates.push(await redact(fb.comment));
    }
    for (const c of candidates) {
      const clean = clip(c, 240);
      const key = normalizeKey(clean);
      if (clean !== "" && !bucket.keys.has(key)) {
        bucket.keys.add(key);
        bucket.notes.push(clean);
      }
    }
    byRater.set(fb.rater, bucket);
  }
  return [...byRater.entries()]
    .filter(([, b]) => b.notes.length > 0)
    .map(([rater, b]) => ({ rater, notes: b.notes }))
    .sort((a, b) => a.rater.localeCompare(b.rater));
}

/** Render a per-user preferences markdown file (a project-memory-style block). */
export function renderPreferencesMd(prefs: UserPreferences): string {
  const lines = [
    `# Preferences — ${prefs.rater}`,
    "",
    "<!-- Auto-maintained by `crewhaus lessons update`. -->",
    "",
    "When serving this user, honour these preferences learned from their feedback:",
    "",
  ];
  for (const n of prefs.notes) lines.push(`- ${n}`);
  return `${lines.join("\n")}\n`;
}
