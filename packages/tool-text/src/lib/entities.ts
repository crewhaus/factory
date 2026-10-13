import { lineStarts, offsetToLineCol } from "./locate";

/**
 * Regex-only entity extraction. Explicitly NOT named-entity recognition:
 * these find things that have a syntax (a URL, a UUID, a semver), not things
 * that have a meaning (a company, a person). That distinction is exactly
 * what keeps the tool deterministic.
 */
export const ENTITY_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  url: /https?:\/\/[^\s<>"'`)\]]+/g,
  email: /[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  uuid: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  semver: /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g,
  isoDate: /\b\d{4}-\d{2}-\d{2}\b/g,
  time: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  money:
    /(?:[$£€¥]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|CAD|AUD)\b)/g,
  percent: /\b\d+(?:\.\d+)?\s?%/g,
  hashtag: /(?:^|\s)(#[A-Za-z][\w-]*)/g,
  mention: /(?:^|\s)(@[A-Za-z][\w.-]*)/g,
  ticket: /\b[A-Z][A-Z0-9]+-\d+\b/g,
  jwt: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  macAddress: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
});

/** Every kind `extractEntities` understands, for schema + error messages. */
export const ENTITY_KINDS = Object.freeze(Object.keys(ENTITY_PATTERNS));

/**
 * How to scan a kind whose pattern would otherwise retry a long run from
 * every position in it.
 *
 * `email`, `money` and `jwt` each start with an unbounded run
 * (`[\w.!#…-]+` before the `@`, `\d[\d,]*` before the currency code,
 * `eyJ[A-Za-z0-9_-]+` before the first dot). On a run that turns out not to
 * be followed by what the pattern needs, a global regex fails, moves one
 * character right and scans the same run again: quadratic, so 100 K of `a`
 * (or a base64 blob in a log line) took ten seconds for `email` alone.
 *
 * Every later start inside such a run shares the run's end, and the rest of
 * the pattern only looks at what comes after that end — so if the match
 * failed at one start in the run it fails at all of them. The scan below
 * therefore tries the pattern (sticky, so exactly there) at a candidate
 * start and, on failure, skips to the end of the run instead of the next
 * character. The matches are the global regex's, start for start: after a
 * success the scan resumes at the match's end even mid-run, exactly as
 * `lastIndex` would, and a differential test holds the three kinds to their
 * plain patterns.
 */
type RunScan = {
  /** Where the pattern may begin (global). */
  readonly candidate: RegExp;
  /** The pattern, anchored at a candidate (sticky). */
  readonly sticky: RegExp;
  /** The run a failed candidate may skip to the end of (sticky); null skips one character. */
  readonly run: (at: string) => RegExp | null;
};

const LOCAL_PART = "[\\w.!#$%&'*+/=?^`{|}~-]";

const RUN_SCANS: Readonly<Record<string, RunScan>> = Object.freeze({
  email: {
    candidate: new RegExp(LOCAL_PART, "g"),
    sticky: new RegExp(ENTITY_PATTERNS["email"]?.source as string, "y"),
    run: () => new RegExp(`${LOCAL_PART}+`, "y"),
  },
  money: {
    // A currency symbol starts the first alternative, a digit at a word
    // boundary the second.
    candidate: /[$£€¥]|\b\d/g,
    sticky: new RegExp(ENTITY_PATTERNS["money"]?.source as string, "y"),
    // The first alternative cannot fail after its symbol and digit, so a
    // failed symbol only skips itself; a failed digit skips its digit run.
    run: (at) => (/\d/.test(at) ? /[\d,]+/y : null),
  },
  jwt: {
    candidate: /\beyJ/g,
    sticky: new RegExp(ENTITY_PATTERNS["jwt"]?.source as string, "y"),
    run: () => /[A-Za-z0-9_-]+/y,
  },
});

/** Every match of `kind` in `text`, in order: the global regex's matches, in linear time. */
function* scanRuns(text: string, scan: RunScan): Generator<RegExpExecArray> {
  const candidate = new RegExp(scan.candidate.source, scan.candidate.flags);
  const sticky = new RegExp(scan.sticky.source, scan.sticky.flags);
  let pos = 0;
  while (pos <= text.length) {
    candidate.lastIndex = pos;
    const c = candidate.exec(text);
    if (c === null) return;
    const at = c.index;
    sticky.lastIndex = at;
    const m = sticky.exec(text);
    if (m !== null && m[0].length > 0) {
      yield m;
      pos = at + m[0].length;
      continue;
    }
    const run = scan.run(text.charAt(at));
    let next = at + 1;
    if (run !== null) {
      run.lastIndex = at;
      const r = run.exec(text);
      if (r !== null) next = Math.max(next, at + r[0].length);
    }
    pos = next;
  }
}

export type EntityHit = {
  readonly value: string;
  readonly index: number;
  readonly line: number;
};

export function extractEntities(
  text: string,
  kinds: ReadonlyArray<string>,
  unique: boolean,
): Record<string, EntityHit[]> {
  const starts = lineStarts(text);
  const out: Record<string, EntityHit[]> = {};
  for (const kind of kinds) {
    if (!Object.hasOwn(ENTITY_PATTERNS, kind)) continue;
    const source = ENTITY_PATTERNS[kind] as RegExp;
    const hits: EntityHit[] = [];
    const seen = new Set<string>();
    for (const m of matchesOf(text, kind, source)) {
      const whole = m[0] as string;
      // Patterns with a leading-boundary group (hashtag, mention) report the
      // capture, so the preceding space is not part of the value.
      const value = (m[1] ?? whole) as string;
      const index = m.index + whole.indexOf(value);
      if (unique && seen.has(value)) continue;
      seen.add(value);
      hits.push({ value, index, line: offsetToLineCol(starts, index).line });
    }
    if (hits.length > 0) out[kind] = hits;
  }
  return out;
}

/** Every match of one kind's pattern, in order. */
export function* matchesOf(text: string, kind: string, source: RegExp): Generator<RegExpExecArray> {
  const scan = Object.hasOwn(RUN_SCANS, kind) ? RUN_SCANS[kind] : undefined;
  if (scan !== undefined) {
    yield* scanRuns(text, scan);
    return;
  }
  const re = new RegExp(source.source, source.flags);
  for (;;) {
    const m = re.exec(text);
    if (m === null) return;
    if ((m[0] as string).length === 0) re.lastIndex += 1;
    yield m;
  }
}
