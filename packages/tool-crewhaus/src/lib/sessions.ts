/**
 * Reading a harness's own session transcripts.
 *
 * `@crewhaus/event-log` writes one JSON object per line to
 * `.crewhaus/sessions/<sessionId>.jsonl`, shaped `{ ts, version, kind,
 * payload }`. Everything here is a pure function over those LINES — the
 * tools in `../index.ts` do the (contained) reading, this module does the
 * parsing and the arithmetic, so the counting is unit-testable without a
 * filesystem.
 *
 * Two compatibility facts the readers honour, both of which exist in the
 * CLI's own readers:
 *
 *   - a line may be FLAT (the fields at the top level, no `payload`
 *     envelope) on logs written by older runtimes, so a missing `payload`
 *     falls back to the object itself;
 *   - a log carries kinds this module has never heard of. They are counted
 *     and otherwise left alone. Branching only on the kinds you know is the
 *     documented contract for every session-log reader in the codebase.
 *
 * A malformed line is COUNTED, never thrown: a transcript truncated by a
 * killed process is the normal case, and a supervisor that cannot read a
 * partially-written log is no supervisor.
 */

import { compareStrings } from "./spec-view";

export type SessionEvent = {
  /** Session id — the log's filename without `.jsonl`. */
  readonly session: string;
  /** 1-based line number within that file. */
  readonly line: number;
  readonly kind: string;
  /** Epoch ms, when the line carried one. */
  readonly ts?: number;
  readonly payload: unknown;
};

export type ParsedSessionLog = {
  readonly events: readonly SessionEvent[];
  /** Lines that were not JSON, or were JSON without a string `kind`. */
  readonly malformedLines: number;
  /** True when the line cap stopped the read before the end of the file. */
  readonly truncated: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
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
 * the whole file, before the `maxEvents` cap has had a chance to stop
 * anything — so on a large log the cap bounded the result while the parse
 * had already paid for the lot. Here only the line being parsed exists, so
 * the extra memory is O(longest line) and the cap actually bounds the work.
 */
export function parseSessionLog(
  session: string,
  text: string,
  maxEvents = 200_000,
): ParsedSessionLog {
  const events: SessionEvent[] = [];
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

export type ToolTally = {
  readonly name: string;
  readonly calls: number;
  readonly errors: number;
  /** Only present when the log carried `tool_stats` lines for this tool. */
  readonly totalDurationMs?: number;
};

export type ErrorTally = { readonly message: string; readonly count: number };

export type SessionSummary = {
  readonly sessions: readonly string[];
  readonly events: number;
  readonly byKind: ReadonlyArray<{ readonly kind: string; readonly count: number }>;
  readonly tools: readonly ToolTally[];
  readonly mcpTools: readonly ToolTally[];
  readonly errors: readonly ErrorTally[];
  /** Epoch ms of the first and last timestamped event, when there is one. */
  readonly firstTs?: number;
  readonly lastTs?: number;
};

/** Error text is a model-visible string; cap it so one stack trace is not the report. */
const MAX_ERROR_CHARS = 200;

function errorText(payload: unknown): string {
  const record = asRecord(payload);
  const message =
    asString(record?.["message"]) ?? asString(record?.["error"]) ?? asString(record?.["class"]);
  const text = message ?? JSON.stringify(payload ?? null);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/**
 * Counts by kind, a per-tool tally, and the errors — the "what happened in
 * this harness" view.
 *
 * TOOL COUNTING, precisely. A call is a `tool_use` line; that is the record
 * the runtime writes for every call it makes. `tool_stats` is the advisor
 * mirror of the same calls (name, duration, error), so counting both would
 * double every call: durations and errors are taken from it, calls are not —
 * unless the log has no `tool_use` lines at all, in which case `tool_stats`
 * is the only evidence a call happened and is counted instead. When a log
 * carries neither mirror, errors are recovered by joining `tool_result`'s
 * `isError` back to its `tool_use` id.
 */
export function summarizeEvents(events: readonly SessionEvent[]): SessionSummary {
  const byKind = new Map<string, number>();
  const useByName = new Map<string, number>();
  const statsByName = new Map<string, { calls: number; errors: number; totalMs: number }>();
  const mcpByName = new Map<string, { calls: number; errors: number; totalMs: number }>();
  const idToName = new Map<string, string>();
  const resultErrors = new Map<string, number>();
  const errors = new Map<string, number>();
  const sessions = new Set<string>();
  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let sawToolUse = false;

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const bumpStats = (
    map: Map<string, { calls: number; errors: number; totalMs: number }>,
    key: string,
    durationMs: number,
    isError: boolean,
  ): void => {
    const row = map.get(key) ?? { calls: 0, errors: 0, totalMs: 0 };
    row.calls += 1;
    if (isError) row.errors += 1;
    row.totalMs += durationMs;
    map.set(key, row);
  };

  for (const event of events) {
    sessions.add(event.session);
    bump(byKind, event.kind);
    if (event.ts !== undefined) {
      if (firstTs === undefined || event.ts < firstTs) firstTs = event.ts;
      if (lastTs === undefined || event.ts > lastTs) lastTs = event.ts;
    }
    const payload = asRecord(event.payload);
    switch (event.kind) {
      case "tool_use": {
        sawToolUse = true;
        const name = asString(payload?.["name"]) ?? "(unnamed)";
        bump(useByName, name);
        const id = asString(payload?.["id"]);
        if (id !== undefined) idToName.set(id, name);
        break;
      }
      case "tool_result": {
        if (payload?.["isError"] !== true) break;
        const id = asString(payload["toolUseId"]);
        const name = (id !== undefined ? idToName.get(id) : undefined) ?? "(unknown tool)";
        bump(resultErrors, name);
        break;
      }
      case "tool_stats": {
        bumpStats(
          statsByName,
          asString(payload?.["toolName"]) ?? "(unnamed)",
          asNumber(payload?.["durationMs"]) ?? 0,
          payload?.["isError"] === true,
        );
        break;
      }
      case "mcp_stats": {
        const server = asString(payload?.["server"]) ?? "(unknown server)";
        const tool = asString(payload?.["toolName"]) ?? "(unnamed)";
        bumpStats(
          mcpByName,
          `${server}/${tool}`,
          asNumber(payload?.["durationMs"]) ?? 0,
          payload?.["isError"] === true,
        );
        break;
      }
      case "error":
      case "run_failed": {
        bump(errors, errorText(event.payload));
        break;
      }
      default:
        break;
    }
  }

  const toolNames = [...new Set([...useByName.keys(), ...statsByName.keys()])].sort(compareStrings);
  const tools: ToolTally[] = toolNames.map((name) => {
    const stats = statsByName.get(name);
    const calls = sawToolUse ? (useByName.get(name) ?? 0) : (stats?.calls ?? 0);
    return {
      name,
      calls,
      errors: stats !== undefined ? stats.errors : (resultErrors.get(name) ?? 0),
      ...(stats !== undefined ? { totalDurationMs: stats.totalMs } : {}),
    };
  });

  const mcpTools: ToolTally[] = [...mcpByName.keys()].sort(compareStrings).map((name) => {
    const row = mcpByName.get(name) as { calls: number; errors: number; totalMs: number };
    return { name, calls: row.calls, errors: row.errors, totalDurationMs: row.totalMs };
  });

  return {
    sessions: [...sessions].sort(compareStrings),
    events: events.length,
    byKind: [...byKind.keys()]
      .sort(compareStrings)
      .map((kind) => ({ kind, count: byKind.get(kind) as number })),
    tools,
    mcpTools,
    errors: [...errors.keys()]
      .map((message) => ({ message, count: errors.get(message) as number }))
      .sort((a, b) => b.count - a.count || compareStrings(a.message, b.message)),
    ...(firstTs !== undefined ? { firstTs } : {}),
    ...(lastTs !== undefined ? { lastTs } : {}),
  };
}

export type EventFilter = {
  readonly kinds?: readonly string[];
  /** Epoch ms, inclusive. */
  readonly sinceTs?: number;
  /** Epoch ms, inclusive. */
  readonly untilTs?: number;
  /** Case-sensitive substring, matched against the serialized payload. */
  readonly contains?: string;
};

/** Apply a filter, in log order. Pure — the caller slices and truncates. */
export function filterEvents(events: readonly SessionEvent[], filter: EventFilter): SessionEvent[] {
  const kinds = filter.kinds !== undefined ? new Set(filter.kinds) : undefined;
  return events.filter((event) => {
    if (kinds !== undefined && !kinds.has(event.kind)) return false;
    if (filter.sinceTs !== undefined && (event.ts === undefined || event.ts < filter.sinceTs)) {
      return false;
    }
    if (filter.untilTs !== undefined && (event.ts === undefined || event.ts > filter.untilTs)) {
      return false;
    }
    if (filter.contains !== undefined) {
      return JSON.stringify(event.payload ?? null).includes(filter.contains);
    }
    return true;
  });
}

export type CostBucket = {
  readonly key: string;
  readonly calls: number;
  readonly costUsdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheCreationTokens: number;
};

export type CostSummary = {
  readonly accruals: number;
  /** Accruals the model was not priced for — tokens are real, cost reads 0. */
  readonly unpriced: number;
  readonly totals: Omit<CostBucket, "key">;
  readonly byModel: readonly CostBucket[];
  readonly byDay: readonly CostBucket[];
  readonly byProvider: readonly CostBucket[];
};

function emptyBucket(key: string): CostBucket & { calls: number } {
  return {
    key,
    calls: 0,
    costUsdMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function addTo(
  map: Map<string, CostBucket>,
  key: string,
  fields: Omit<CostBucket, "key" | "calls">,
): void {
  const row = map.get(key) ?? emptyBucket(key);
  map.set(key, {
    key,
    calls: row.calls + 1,
    costUsdMicros: row.costUsdMicros + fields.costUsdMicros,
    inputTokens: row.inputTokens + fields.inputTokens,
    outputTokens: row.outputTokens + fields.outputTokens,
    cachedReadTokens: row.cachedReadTokens + fields.cachedReadTokens,
    cacheCreationTokens: row.cacheCreationTokens + fields.cacheCreationTokens,
  });
}

/** UTC calendar day of an epoch-ms timestamp; `unknown` when there is none. */
function utcDay(ts: number | undefined): string {
  if (ts === undefined) return "unknown";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "unknown" : (date.toISOString().slice(0, 10) as string);
}

/**
 * Sum `cost_accrual` events by model, by provider and by UTC day.
 *
 * The runner's own terminal roll-up (`summary: true`) is skipped, exactly as
 * `crewhaus incident collect` skips it, so a run total is never counted
 * twice. Costs stay in integer USD micros — the unit the events carry — so
 * the arithmetic is exact; converting to dollars is the reader's problem.
 */
export function summarizeCost(events: readonly SessionEvent[]): CostSummary {
  const byModel = new Map<string, CostBucket>();
  const byDay = new Map<string, CostBucket>();
  const byProvider = new Map<string, CostBucket>();
  let accruals = 0;
  let unpriced = 0;
  const totals = { ...emptyBucket("") };

  for (const event of events) {
    if (event.kind !== "cost_accrual") continue;
    const payload = asRecord(event.payload);
    if (payload === undefined || payload["summary"] === true) continue;
    accruals += 1;
    if (payload["unpriced"] === true) unpriced += 1;
    const fields = {
      costUsdMicros: asNumber(payload["costUsdMicros"]) ?? 0,
      inputTokens: asNumber(payload["inputTokens"]) ?? 0,
      outputTokens: asNumber(payload["outputTokens"]) ?? 0,
      cachedReadTokens: asNumber(payload["cachedReadTokens"]) ?? 0,
      cacheCreationTokens: asNumber(payload["cacheCreationTokens"]) ?? 0,
    };
    addTo(
      byModel,
      asString(payload["modelId"]) ?? asString(payload["specModel"]) ?? "unknown",
      fields,
    );
    addTo(byProvider, asString(payload["provider"]) ?? "unknown", fields);
    addTo(byDay, utcDay(event.ts), fields);
    totals.calls += 1;
    totals.costUsdMicros += fields.costUsdMicros;
    totals.inputTokens += fields.inputTokens;
    totals.outputTokens += fields.outputTokens;
    totals.cachedReadTokens += fields.cachedReadTokens;
    totals.cacheCreationTokens += fields.cacheCreationTokens;
  }

  const sorted = (map: Map<string, CostBucket>): CostBucket[] =>
    [...map.values()].sort((a, b) => compareStrings(a.key, b.key));

  return {
    accruals,
    unpriced,
    totals: {
      calls: totals.calls,
      costUsdMicros: totals.costUsdMicros,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedReadTokens: totals.cachedReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
    },
    byModel: sorted(byModel),
    byDay: sorted(byDay),
    byProvider: sorted(byProvider),
  };
}
