/**
 * The shared spine of this package: located spans, the size caps every
 * entry point applies, and the masking helper that keeps a finding from
 * becoming a leak.
 *
 * Nothing here is a detector. Detectors live next door and all of them
 * speak in `Finding`s, so one renderer, one de-duplicator and one redactor
 * serve every scan.
 */

/** A located, classified hit. `value` is NEVER put in a tool result verbatim. */
export type Finding = {
  /** What kind of thing this is, e.g. `email`, `aws.access-key-id`. */
  readonly type: string;
  /** The named rule that matched, so a reviewer can look it up. */
  readonly rule: string;
  /** How much the rule proves. See `Confidence`. */
  readonly confidence: Confidence;
  /** UTF-16 code-unit offset of the first character. */
  readonly start: number;
  /** UTF-16 code-unit offset one past the last character. */
  readonly end: number;
  /** 1-based line of `start`. */
  readonly line: number;
  /** 1-based column of `start`, counted in code units. */
  readonly column: number;
  /** The matched text. Internal only — mask or drop it before returning. */
  readonly value: string;
  /** Optional rule-specific detail (brand, country, entropy, …). */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
};

/**
 * What a match is worth.
 *
 * - `verified` — a check digit passed (Luhn, ISO 7064 mod-97). The string is
 *   a structurally valid instance of the format. It still says nothing about
 *   whether the number was ever issued, or to whom.
 * - `likely` — a distinctive shape plus corroborating context (a labelled
 *   field, a vendor-specific prefix).
 * - `possible` — shape alone. Expect false positives.
 *
 * No level means "this is personal data" or "this is a live credential".
 * Those are judgements about the world; these rules only see bytes.
 */
export type Confidence = "verified" | "likely" | "possible";

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  verified: 3,
  likely: 2,
  possible: 1,
};

/**
 * The ceiling on any text a tool in this package will examine.
 *
 * Every scanner is linear in the input, but a caller that hands over a
 * 200 MB string has already lost: the string, the findings and the redacted
 * copy all sit in memory at once. Refusing is the honest answer.
 */
export const MAX_TEXT_CHARS = 2_000_000;

/** Raised for a caller mistake. Tools catch it and return the message. */
export class SecureInputError extends Error {
  override readonly name = "SecureInputError";
}

/** Refuse an over-large string before any scanning work begins. */
export function assertTextSize(text: string, field: string, limit = MAX_TEXT_CHARS): void {
  if (text.length > limit) {
    throw new SecureInputError(
      `${field} is ${text.length} characters, over this package's ${limit} limit — split the input and scan the pieces`,
    );
  }
}

/** Offsets at which each line starts; `[0]` is always 0. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line and column for an offset, against a prepared `lineStarts`. */
export function locate(
  starts: ReadonlyArray<number>,
  offset: number,
): {
  line: number;
  column: number;
} {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
}

/** Locale-independent ordering. `localeCompare` would make results host-dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mask a value so a finding can be reviewed without the value leaking.
 *
 * The rule: at most `keep` leading and `keep` trailing characters survive,
 * and only when the value is long enough that those characters are a small
 * fraction of it. Anything shorter is masked whole. The length is reported
 * separately, because length is useful and is not the secret.
 *
 * This is the one function standing between `SecretScan` and a tool result
 * that contains a live credential. It is tested directly.
 */
export function maskValue(value: string, keep = 2): string {
  const n = value.length;
  if (n === 0) return "";
  // Below this a prefix+suffix would expose too much of the value: at n = 12
  // and keep = 2, four of twelve characters survive, and that is the floor.
  if (keep <= 0 || n < 4 * keep + 4) return "*".repeat(Math.min(n, 12));
  const head = value.slice(0, keep);
  const tail = value.slice(n - keep);
  return `${head}${"*".repeat(Math.min(n - 2 * keep, 12))}${tail}`;
}

/**
 * Drop findings swallowed by a stronger one.
 *
 * Overlap is common and mostly noise: the digit run inside an IBAN also
 * looks like a phone number, and a JWT is three high-entropy blobs. The
 * survivor is chosen by confidence, then by length, then by earliest start,
 * then by rule name — a total order, so the same input always yields the
 * same set.
 */
export function dedupeOverlaps(findings: ReadonlyArray<Finding>): Finding[] {
  const ranked = [...findings].sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
    if (byConfidence !== 0) return byConfidence;
    const byLength = b.end - b.start - (a.end - a.start);
    if (byLength !== 0) return byLength;
    if (a.start !== b.start) return a.start - b.start;
    return compareStrings(a.rule, b.rule);
  });
  const kept: Finding[] = [];
  for (const candidate of ranked) {
    const clashes = kept.some((k) => candidate.start < k.end && k.start < candidate.end);
    if (!clashes) kept.push(candidate);
  }
  return sortFindings(kept);
}

/** Reading order, with a deterministic tiebreak. */
export function sortFindings(findings: ReadonlyArray<Finding>): Finding[] {
  return [...findings].sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      compareStrings(a.type, b.type) ||
      compareStrings(a.rule, b.rule),
  );
}

/** Attach line/column to raw offsets in one pass over the text. */
export function withPositions(
  text: string,
  raw: ReadonlyArray<Omit<Finding, "line" | "column">>,
): Finding[] {
  const starts = lineStarts(text);
  return raw.map((f) => ({ ...f, ...locate(starts, f.start) }));
}

/**
 * Replace each span with the string `replace` returns for it.
 *
 * Spans must not overlap (`dedupeOverlaps` guarantees that); they are
 * applied right to left so earlier offsets stay valid.
 */
export function applySpans(
  text: string,
  findings: ReadonlyArray<Finding>,
  replace: (finding: Finding) => string,
): string {
  const ordered = sortFindings(findings);
  let out = text;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const f = ordered[i];
    if (!f) continue;
    out = out.slice(0, f.start) + replace(f) + out.slice(f.end);
  }
  return out;
}

/** Tally findings by `type`, sorted by type so the record is stable. */
export function countByType(findings: ReadonlyArray<Finding>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort(compareStrings)) out[key] = counts.get(key) ?? 0;
  return out;
}

/**
 * Run a global regex over text, yielding matches with their offsets.
 *
 * The pattern is cloned so a caller's `lastIndex` cannot leak between calls,
 * and a zero-length match advances the cursor rather than spinning forever.
 *
 * The clone always carries `g` and `d`. `d` matters: a rule that captures the
 * secret in a group needs the group's REAL offset, and searching the match
 * text for the group's own text finds the wrong copy whenever the value also
 * appears earlier in the match — `scheme://admin_hunter2:hunter2@host` is the
 * shape that does it. `groupSpan` below is how a caller gets that offset.
 */
export function* matchAll(
  text: string,
  pattern: RegExp,
): Generator<{ index: number; match: RegExpExecArray }> {
  let flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  if (!flags.includes("d")) flags = `${flags}d`;
  const re = new RegExp(pattern.source, flags);
  for (;;) {
    const m = re.exec(text);
    if (m === null) return;
    yield { index: m.index, match: m };
    if (m[0].length === 0) re.lastIndex += 1;
  }
}

/**
 * The absolute `[start, end)` of one capture group of a match produced by
 * `matchAll`, or `undefined` when the group did not participate.
 *
 * Group 0 is the whole match. Any other group's offsets come from the `d`
 * flag's indices, never from searching for the group's text inside the match.
 */
export function groupSpan(
  match: RegExpExecArray,
  group: number,
): { start: number; end: number } | undefined {
  const whole = match[0];
  if (group === 0) return { start: match.index, end: match.index + whole.length };
  const span = match.indices?.[group];
  if (!span) return undefined;
  return { start: span[0], end: span[1] };
}
