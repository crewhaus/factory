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
 * Spans, asked one question: does `[start, end)` overlap any of them?
 *
 * Overlap is `start < k.end && k.start < end`, the test `dedupeOverlaps` and
 * `secretFindings` make, answered for any numbers, empty spans included.
 * Among the spans that start before `end`, one overlaps exactly when the
 * largest of their ends is past `start`. So the index keeps that largest end
 * in a Fenwick tree with one slot per distinct start, and a question or an
 * addition visits O(log n) slots. Checking every span kept so far made
 * those two passes quadratic in the findings, on text a model or a web page
 * supplies.
 *
 * Every start a span will be added with is named up front, because the
 * slots are the distinct starts in order. `steps` counts the slots and
 * probes the calls visit, so a test can hold the index to its bound.
 */
export class SpanIndex {
  /** Tree slots and binary-search probes visited so far. */
  steps = 0;
  /** The distinct starts, ascending. */
  private readonly starts: Float64Array;
  /** 1-based Fenwick tree of the largest end per prefix of `starts`. */
  private readonly maxEnd: Float64Array;

  constructor(starts: ReadonlyArray<number>) {
    const sorted = new Float64Array(starts.length);
    let n = 0;
    // A NaN start never satisfies the test, so it never needs a slot.
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i] as number;
      if (!Number.isNaN(s)) sorted[n++] = s;
    }
    sorted.subarray(0, n).sort();
    let distinct = 0;
    for (let i = 0; i < n; i++) {
      const s = sorted[i] as number;
      if (distinct === 0 || s !== sorted[distinct - 1]) sorted[distinct++] = s;
    }
    this.starts = sorted.slice(0, distinct);
    this.maxEnd = new Float64Array(distinct + 1).fill(Number.NEGATIVE_INFINITY);
  }

  /** How many distinct starts are below `bound`; none are below NaN. */
  private below(bound: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      this.steps++;
      const mid = (lo + hi) >>> 1;
      if ((this.starts[mid] as number) < bound) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Whether some span added so far has `k.start < end && start < k.end`. */
  overlaps(start: number, end: number): boolean {
    let most = Number.NEGATIVE_INFINITY;
    for (let i = this.below(end); i > 0; i -= i & -i) {
      this.steps++;
      const e = this.maxEnd[i] as number;
      if (e > most) most = e;
    }
    return most > start;
  }

  /** Add `[start, end)`; `start` must be one the index was built with. */
  add(start: number, end: number): void {
    // A NaN on either side never satisfies the test, so it is never found.
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    const at = this.below(start);
    if (at >= this.starts.length || this.starts[at] !== start) {
      throw new Error(`SpanIndex: start ${start} was not named when the index was built`);
    }
    for (let i = at + 1; i < this.maxEnd.length; i += i & -i) {
      this.steps++;
      if (end > (this.maxEnd[i] as number)) this.maxEnd[i] = end;
    }
  }
}

/**
 * Drop findings swallowed by a stronger one.
 *
 * Overlap is common and mostly noise: the digit run inside an IBAN also
 * looks like a phone number, and a JWT is three high-entropy blobs. The
 * survivor is chosen by confidence, then by length, then by earliest start,
 * then by rule name — a total order, so the same input always yields the
 * same set.
 *
 * Each candidate, in that order, is kept unless it overlaps one kept before
 * it. A `SpanIndex` answers that, so the pass is O(k log k) in the findings
 * rather than a check against every finding kept so far.
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
  const index = new SpanIndex(ranked.map((f) => f.start));
  const kept: Finding[] = [];
  for (const candidate of ranked) {
    if (index.overlaps(candidate.start, candidate.end)) continue;
    kept.push(candidate);
    index.add(candidate.start, candidate.end);
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
 * Spans must not overlap (`dedupeOverlaps` guarantees that). `replace` is
 * called right to left, as it always has been, and the output is the text
 * between the spans joined with their replacements: one copy of the text.
 * Rebuilding the whole string for every span was O(spans × text), and a
 * redaction pass over megabytes of findings-dense text has hundreds of
 * thousands of spans. Spans that overlap, sit out of order or outside the
 * text, or have fractional offsets keep the old right-to-left rebuild, which
 * gives the same result on spans that do none of those things.
 */
export function applySpans(
  text: string,
  findings: ReadonlyArray<Finding>,
  replace: (finding: Finding) => string,
): string {
  const ordered = sortFindings(findings);
  if (!disjointWithin(ordered, text.length)) return rebuildRightToLeft(text, ordered, replace);
  const replacements: Array<string | undefined> = new Array(ordered.length);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const f = ordered[i];
    if (f) replacements[i] = replace(f);
  }
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    if (!f) continue;
    parts.push(text.slice(at, f.start), replacements[i] as string);
    at = f.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** Whether sorted spans are whole offsets, in order, apart, and inside the text. */
function disjointWithin(ordered: ReadonlyArray<Finding | undefined>, length: number): boolean {
  let at = 0;
  for (let i = 0; i < ordered.length; i++) {
    const f = ordered[i];
    if (!f) continue;
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end)) return false;
    if (f.start < at || f.end < f.start || f.end > length) return false;
    at = f.end;
  }
  return true;
}

/** The original rebuild, kept for spans `disjointWithin` refuses. */
function rebuildRightToLeft(
  text: string,
  ordered: ReadonlyArray<Finding | undefined>,
  replace: (finding: Finding) => string,
): string {
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
 * `matchAll(text, pattern)`'s matches, in order, with the pattern tried
 * (sticky) only where `canStart` says a match may begin, and, after a try
 * that fails at `at`, not again before `failedTo(text, at)`.
 *
 * For a pattern that opens with an unbounded run (an email's local part, a
 * word before a comma, the whitespace after a line start), a global search
 * that fails at one start moves one character right and scans the same run
 * again: quadratic in the run's length. Every later start inside such a run
 * shares the run's end and reads the same text after it, so it fails too;
 * `failedTo` names where that stops being true, and the matches are the
 * global pattern's, start for start. After a match the next try is at its
 * end (one further for an empty match), as `lastIndex` would be.
 */
export function* matchAllSkipping(
  text: string,
  pattern: RegExp,
  canStart: (text: string, at: number) => boolean,
  failedTo: (text: string, at: number) => number,
): Generator<{ index: number; match: RegExpExecArray }> {
  let flags = pattern.flags.replace("g", "");
  if (!flags.includes("d")) flags = `${flags}d`;
  if (!flags.includes("y")) flags = `${flags}y`;
  const re = new RegExp(pattern.source, flags);
  let at = 0;
  while (at <= text.length) {
    if (!canStart(text, at)) {
      at++;
      continue;
    }
    re.lastIndex = at;
    const m = re.exec(text);
    if (m !== null) {
      yield { index: at, match: m };
      at += Math.max(1, m[0].length);
      continue;
    }
    at = Math.max(at + 1, failedTo(text, at));
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
