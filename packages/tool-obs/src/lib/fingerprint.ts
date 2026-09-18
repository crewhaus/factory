/**
 * Turning a thousand error lines into six.
 *
 * Errors from a harness are overwhelmingly the SAME error with different
 * particulars: a different request id, a different temp path, a different
 * retry count. Grouping on the raw message therefore produces one group per
 * occurrence, which is the same thing as not grouping at all. Masking the
 * particulars first is what makes the grouping mean something.
 *
 * The masks run in a fixed order, widest-first, because a narrower mask that
 * ran earlier would eat a piece of a wider one and leave the rest unmasked —
 * masking the digits inside a UUID first leaves `<n>a1b<n>-...`, which is a
 * different fingerprint for every UUID, which is the bug this module exists to
 * avoid. Each mask is anchored on shape, never on vocabulary, so it does not
 * need to know which platform wrote the message.
 *
 * What it does NOT do: it does not cluster by edit distance or embedding. Two
 * genuinely different messages that share no shape stay in different groups
 * even when a human would call them the same problem, and two different
 * problems whose messages differ only in a number land in the same group. The
 * example line is carried on every group so that second case is visible rather
 * than hidden.
 */
import { type ObsEvent, asRecord, asString, byString } from "./events";

/** Error text is a model-visible string; cap it so one stack trace is not the report. */
export const MAX_ERROR_CHARS = 300;

type Mask = { readonly pattern: RegExp; readonly replacement: string };

/**
 * Widest shape first. Every pattern is global and case-insensitive where the
 * alphabet allows it.
 */
const MASKS: readonly Mask[] = [
  // A URL, before anything eats its digits or its path.
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, replacement: "<url>" },
  // A UUID, before the hex mask claims its segments.
  {
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "<uuid>",
  },
  // An ISO-8601 timestamp, before the number mask shreds it.
  {
    pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    replacement: "<ts>",
  },
  // A POSIX or Windows absolute path.
  { pattern: /(?:[A-Za-z]:)?[\\/](?:[\w.@ -]+[\\/])+[\w.@-]*/g, replacement: "<path>" },
  // A prefixed id — `sess_a1b2…`, `run-9f3…`, `tu_01H…` — kept as its prefix so
  // two ids from the same namespace group and two from different ones do not.
  { pattern: /\b([A-Za-z][A-Za-z0-9]{1,15})[_-][A-Za-z0-9]{6,}\b/g, replacement: "$1_<id>" },
  // A bare hex blob: a hash, a token fragment, an object id.
  { pattern: /\b[0-9a-f]{6,}\b/gi, replacement: "<hex>" },
  // A quoted literal — a filename, a key, a user's input.
  { pattern: /"[^"\n]*"/g, replacement: '"<str>"' },
  { pattern: /'[^'\n]*'/g, replacement: "'<str>'" },
  // Anything numeric left standing, including decimals, exponents and a short
  // trailing unit. The unit matters: without it `after 5s` and `after 9s` are
  // different fingerprints, because the digit's word boundary falls before the
  // `s` and the mask never fires — which is the single most common shape in a
  // timeout message.
  { pattern: /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?[a-z%]{0,3}\b/gi, replacement: "<n>" },
];

/**
 * The normalised shape of one error message.
 *
 * Whitespace is collapsed last so a message wrapped across lines and the same
 * message on one line fingerprint identically.
 */
export function fingerprint(message: string): string {
  let out = message;
  for (const mask of MASKS) out = out.replace(mask.pattern, mask.replacement);
  return out.replace(/\s+/g, " ").trim();
}

/** The human-readable text of an error event, capped. */
export function errorText(payload: unknown): string {
  const record = asRecord(payload);
  const message =
    asString(record?.["message"]) ??
    asString(record?.["error"]) ??
    asString(record?.["class"]) ??
    asString(record?.["reason"]);
  const text = message ?? JSON.stringify(payload ?? null) ?? "";
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/** Event kinds this module treats as carrying an error. */
export const ERROR_KINDS: ReadonlySet<string> = new Set(["error", "run_failed"]);

export type ErrorGroup = {
  readonly fingerprint: string;
  readonly count: number;
  /** One verbatim message from the group, so the masking stays auditable. */
  readonly example: string;
  /** Where that example was written. */
  readonly exampleSession: string;
  readonly exampleLine: number;
  /** Epoch ms of the first and last occurrence that carried a timestamp. */
  readonly firstTs?: number;
  readonly lastTs?: number;
  /** Which kinds contributed, sorted. */
  readonly kinds: readonly string[];
};

export type ErrorClusterResult = {
  readonly errors: number;
  readonly groups: readonly ErrorGroup[];
  /** Groups beyond the cap, folded into a count rather than dropped silently. */
  readonly groupsOmitted: number;
};

type Accumulator = {
  count: number;
  example: string;
  exampleSession: string;
  exampleLine: number;
  firstTs?: number;
  lastTs?: number;
  kinds: Set<string>;
};

/**
 * Group errors by fingerprint, most frequent first.
 *
 * The example kept is the FIRST occurrence in log order, not the longest or
 * the most recent, because "first" is the only choice that does not change
 * when the log grows.
 */
export function clusterErrors(
  events: readonly ObsEvent[],
  maxGroups = 20,
  includeToolErrors = false,
): ErrorClusterResult {
  const groups = new Map<string, Accumulator>();
  let errors = 0;

  for (const event of events) {
    const isToolError =
      includeToolErrors &&
      event.kind === "tool_result" &&
      asRecord(event.payload)?.["isError"] === true;
    if (!ERROR_KINDS.has(event.kind) && !isToolError) continue;
    errors += 1;
    const text = errorText(event.payload);
    const key = fingerprint(text);
    const row = groups.get(key);
    if (row === undefined) {
      groups.set(key, {
        count: 1,
        example: text,
        exampleSession: event.session,
        exampleLine: event.line,
        ...(event.ts !== undefined ? { firstTs: event.ts, lastTs: event.ts } : {}),
        kinds: new Set([event.kind]),
      });
      continue;
    }
    row.count += 1;
    row.kinds.add(event.kind);
    if (event.ts !== undefined) {
      if (row.firstTs === undefined || event.ts < row.firstTs) row.firstTs = event.ts;
      if (row.lastTs === undefined || event.ts > row.lastTs) row.lastTs = event.ts;
    }
  }

  const all: ErrorGroup[] = [...groups.keys()]
    .map((key) => {
      const row = groups.get(key) as Accumulator;
      return {
        fingerprint: key,
        count: row.count,
        example: row.example,
        exampleSession: row.exampleSession,
        exampleLine: row.exampleLine,
        ...(row.firstTs !== undefined ? { firstTs: row.firstTs } : {}),
        ...(row.lastTs !== undefined ? { lastTs: row.lastTs } : {}),
        kinds: [...row.kinds].sort(byString),
      };
    })
    .sort((a, b) => b.count - a.count || byString(a.fingerprint, b.fingerprint));

  return {
    errors,
    groups: all.slice(0, maxGroups),
    groupsOmitted: Math.max(0, all.length - maxGroups),
  };
}
