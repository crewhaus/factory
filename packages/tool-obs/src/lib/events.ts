/**
 * Reading a harness's own JSONL telemetry.
 *
 * `@crewhaus/event-log` writes one JSON object per line to
 * `.crewhaus/sessions/<sessionId>.jsonl`, shaped `{ ts, version, kind,
 * payload }`. Everything in this module is a pure function over those LINES —
 * `../index.ts` does the (contained, byte-capped) reading, this file does the
 * parsing, filtering and arithmetic, so the counting is unit-testable without
 * a filesystem.
 *
 * Three compatibility facts, all of which exist in the CLI's own readers:
 *
 *   - a line may be FLAT (fields at the top level, no `payload` envelope) on
 *     logs written by older runtimes, so a missing `payload` falls back to the
 *     object itself;
 *   - a log carries kinds this module has never heard of. They are counted and
 *     otherwise left alone — branching only on the kinds you know is the
 *     documented contract for every session-log reader in this codebase;
 *   - a malformed line is COUNTED, never thrown. A transcript truncated by a
 *     killed process is the normal case, and a tool that cannot read a
 *     half-written log is no use during an incident, which is exactly when it
 *     will be called.
 */

/** Locale-independent string order. `localeCompare` without a locale is not deterministic. */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type ObsEvent = {
  /** Session id — the log's filename without `.jsonl`. */
  readonly session: string;
  /** 1-based line number within that file. */
  readonly line: number;
  readonly kind: string;
  /** Epoch ms, when the line carried one. */
  readonly ts?: number;
  readonly payload: unknown;
};

export type ParsedLog = {
  readonly events: readonly ObsEvent[];
  /** Lines that were not JSON, or were JSON without a string `kind`. */
  readonly malformedLines: number;
  /** True when the event cap stopped the read before the end of the file. */
  readonly truncated: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The payload, with the flat-line fallback older logs need. */
function payloadOf(record: Record<string, unknown>): unknown {
  const payload = record["payload"];
  return payload !== undefined ? payload : record;
}

/**
 * Parse one session log's text. `maxEvents` caps the events retained.
 *
 * The scan walks the text with `indexOf` rather than `text.split("\n")`: a
 * split materialises EVERY line of the transcript at once — a second copy of
 * the whole file, before the cap has had a chance to stop anything — so on a
 * large log the cap bounded the RESULT while the parse had already paid for
 * the lot. Here only the line being parsed exists, so the extra memory is
 * O(longest line) and the cap actually bounds the work.
 */
export function parseLog(session: string, text: string, maxEvents = 200_000): ParsedLog {
  const events: ObsEvent[] = [];
  let malformedLines = 0;
  let truncated = false;
  let lineNumber = 0;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    start = end + 1;
    lineNumber += 1;
    if (newline === -1 && line === "") break;
    if (line.trim() === "") {
      if (newline === -1) break;
      continue;
    }
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      if (newline === -1) break;
      continue;
    }
    const record = asRecord(parsed);
    const kind = asString(record?.["kind"]);
    if (record === undefined || kind === undefined) {
      malformedLines += 1;
      if (newline === -1) break;
      continue;
    }
    const ts = asNumber(record["ts"]);
    events.push({
      session,
      line: lineNumber,
      kind,
      ...(ts !== undefined ? { ts } : {}),
      payload: payloadOf(record),
    });
    if (newline === -1) break;
  }
  return { events, malformedLines, truncated };
}

// ---------------------------------------------------------------------------
// field access and predicates
// ---------------------------------------------------------------------------

/**
 * Read a dotted path out of a payload. `a.b.0.c` walks objects and arrays
 * alike; a segment that is missing yields `undefined` rather than throwing.
 *
 * Deliberately NOT JSONPath: no wildcards, no filters, no recursive descent.
 * A path grammar a caller can get subtly wrong is a path grammar that returns
 * a confidently empty answer, and this one either finds the field or says it
 * did not.
 */
export function readPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(segment)) return undefined;
      current = current[Number.parseInt(segment, 10)];
      continue;
    }
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[segment];
  }
  return current;
}

export const PREDICATE_OPS = [
  "eq",
  "ne",
  "contains",
  "startsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "missing",
] as const;

export type PredicateOp = (typeof PREDICATE_OPS)[number];

export type FieldPredicate = {
  /** Dotted path inside the event's payload. */
  readonly path: string;
  readonly op: PredicateOp;
  /** Compared as a string for the text ops, as a number for the ordering ops. */
  readonly value?: string | number | boolean;
};

/** A scalar rendered for string comparison; objects and arrays are JSON. */
function asComparableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * Evaluate one predicate against a payload.
 *
 * The ordering ops (`gt`/`gte`/`lt`/`lte`) are NUMERIC and return false when
 * either side is not a finite number — comparing `"2026-01-02" > "2026-01-10"`
 * as text is the kind of answer that looks right and is wrong, so it is not
 * offered at all. Compare timestamps with `sinceTs`/`untilTs` instead.
 */
export function matchesPredicate(payload: unknown, predicate: FieldPredicate): boolean {
  const found = readPath(payload, predicate.path);
  switch (predicate.op) {
    case "exists":
      return found !== undefined;
    case "missing":
      return found === undefined;
    case "eq":
      return asComparableText(found) === asComparableText(predicate.value);
    case "ne":
      return asComparableText(found) !== asComparableText(predicate.value);
    case "contains":
      return asComparableText(found).includes(asComparableText(predicate.value));
    case "startsWith":
      return asComparableText(found).startsWith(asComparableText(predicate.value));
    default: {
      const left = asNumber(found);
      const right = typeof predicate.value === "number" ? predicate.value : undefined;
      if (left === undefined || right === undefined) return false;
      if (predicate.op === "gt") return left > right;
      if (predicate.op === "gte") return left >= right;
      if (predicate.op === "lt") return left < right;
      return left <= right;
    }
  }
}

export type EventFilter = {
  readonly kinds?: readonly string[];
  /** Epoch ms, inclusive. An event with no `ts` never matches a time bound. */
  readonly sinceTs?: number;
  /** Epoch ms, inclusive. */
  readonly untilTs?: number;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly predicate?: FieldPredicate;
};

/**
 * The run a line belongs to.
 *
 * Not every kind carries one — `user_message` does not — so this is
 * best-effort by design: `runId` where the payload has it, and the two
 * spellings the runtime's own records use.
 */
export function runIdOf(event: ObsEvent): string | undefined {
  const payload = asRecord(event.payload);
  if (payload === undefined) return undefined;
  return asString(payload["runId"]) ?? asString(payload["run_id"]);
}

/** Apply a filter, in log order. Pure — the caller pages and truncates. */
export function filterEvents(
  events: readonly ObsEvent[],
  filter: EventFilter,
): readonly ObsEvent[] {
  const kinds = filter.kinds !== undefined ? new Set(filter.kinds) : undefined;
  return events.filter((event) => {
    if (kinds !== undefined && !kinds.has(event.kind)) return false;
    if (filter.sessionId !== undefined && event.session !== filter.sessionId) return false;
    if (filter.sinceTs !== undefined && (event.ts === undefined || event.ts < filter.sinceTs)) {
      return false;
    }
    if (filter.untilTs !== undefined && (event.ts === undefined || event.ts > filter.untilTs)) {
      return false;
    }
    if (filter.runId !== undefined && runIdOf(event) !== filter.runId) return false;
    if (filter.predicate !== undefined && !matchesPredicate(event.payload, filter.predicate)) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// paging
// ---------------------------------------------------------------------------

export type Cursor = { readonly session: string; readonly line: number };

/**
 * The canonical order for every listing here: session id ascending, then line
 * number ascending. It is the order the files are read in and the order they
 * were written in, it needs no timestamp (which a line may not carry), and it
 * is total — which is what makes a cursor a cursor rather than a hint.
 */
export function compareEvents(a: ObsEvent, b: ObsEvent): number {
  return byString(a.session, b.session) || a.line - b.line;
}

/** Encode a resume point. Opaque to the caller, stable across calls. */
export function encodeCursor(event: ObsEvent): string {
  return `${event.session}#${event.line}`;
}

/** Decode a cursor, or `undefined` when it is not one this tool wrote. */
export function decodeCursor(raw: string): Cursor | undefined {
  const hash = raw.lastIndexOf("#");
  if (hash <= 0) return undefined;
  const session = raw.slice(0, hash);
  const line = raw.slice(hash + 1);
  if (!/^[0-9]+$/.test(line)) return undefined;
  return { session, line: Number.parseInt(line, 10) };
}

export type Page = {
  readonly events: readonly ObsEvent[];
  /**
   * Pass back as `cursor` to continue. Present whenever the page was not
   * empty, INCLUDING on the last page: a session log is appended to while it
   * is being read, so "there is nothing more right now" and "there will never
   * be anything more" are different answers. `remaining` is how much was
   * waiting at the moment of the call, so a caller that only wants a complete
   * snapshot compares it against the page size and stops.
   */
  readonly nextCursor?: string;
  /** Total matches at or after the cursor, before the page cap. */
  readonly remaining: number;
};

/**
 * One page of an already-filtered, already-ordered list.
 *
 * The cursor is EXCLUSIVE: it names the last event returned, and the next page
 * starts strictly after it. That is what makes paging safe against a log that
 * grew between calls — a new line can only appear after the cursor, never
 * before it, so nothing is skipped and nothing is repeated.
 */
export function pageEvents(ordered: readonly ObsEvent[], limit: number, cursor?: string): Page {
  const from = cursor === undefined ? undefined : decodeCursor(cursor);
  const after =
    from === undefined
      ? ordered
      : ordered.filter(
          (e) =>
            byString(e.session, from.session) > 0 ||
            (e.session === from.session && e.line > from.line),
        );
  const slice = after.slice(0, limit);
  const last = slice[slice.length - 1];
  return {
    events: slice,
    ...(last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    remaining: after.length,
  };
}

/**
 * An event rendered for a model: the payload serialised and cut to a budget.
 * Every byte returned is a byte in somebody's context window, and one stack
 * trace should not be the whole page.
 */
export function renderEvent(event: ObsEvent, payloadBudget: number): Record<string, unknown> {
  const payload = JSON.stringify(event.payload ?? null) ?? "null";
  const cut = payload.length > payloadBudget;
  return {
    session: event.session,
    line: event.line,
    ...(event.ts !== undefined ? { ts: event.ts } : {}),
    kind: event.kind,
    payload: cut ? `${payload.slice(0, payloadBudget)}…` : payload,
    ...(cut ? { payloadTruncated: true } : {}),
  };
}
