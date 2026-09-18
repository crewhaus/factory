/**
 * Tallies over a harness's own events: what it did, which tools it called,
 * and how those calls went.
 *
 * TOOL COUNTING, precisely — the same rule `crewhaus sessions summarize` uses,
 * because two tools that count the same log differently are worse than one:
 *
 *   - A CALL is a `tool_use` line. That is the record the runtime writes for
 *     every call it makes.
 *   - `tool_stats` is the advisor mirror of those same calls (name, duration,
 *     error), so counting both would double every call. Durations and errors
 *     come from it; calls do not — UNLESS the log has no `tool_use` lines at
 *     all, in which case `tool_stats` is the only evidence a call happened and
 *     is counted instead.
 *   - When a log carries neither mirror, an error is recovered by joining a
 *     `tool_result`'s `isError` back to its `tool_use` id.
 *
 * `mcp_stats` is a separate namespace (`<server>/<tool>`) and never merges
 * into the built-in tally, because an MCP server's `Read` and the built-in
 * `Read` are different tools that happen to share a name.
 */
import { type ObsEvent, asNumber, asRecord, asString, byString } from "./events";

export type KindCount = { readonly kind: string; readonly count: number };

export type ToolTally = {
  readonly name: string;
  readonly calls: number;
  readonly errors: number;
  /** Only present when the log carried `tool_stats` lines for this tool. */
  readonly totalDurationMs?: number;
};

export type OutcomeCounts = {
  /** `tool_result` lines that carried `isError: true`. */
  readonly toolErrors: number;
  /** `tool_result` lines that did not. */
  readonly toolOk: number;
  /** `error` lines — recoverable failures, recorded as they happened. */
  readonly errors: number;
  /** `run_failed` lines — the ONE failure a run actually died with. */
  readonly runsFailed: number;
  /** `model_meta` stop reasons, most frequent first. */
  readonly stopReasons: readonly KindCount[];
};

export type EventCountsResult = {
  readonly sessions: readonly string[];
  readonly events: number;
  readonly byKind: readonly KindCount[];
  readonly byTool: readonly ToolTally[];
  readonly byMcpTool: readonly ToolTally[];
  readonly outcomes: OutcomeCounts;
  /** Epoch ms of the first and last timestamped event, when there is one. */
  readonly firstTs?: number;
  readonly lastTs?: number;
};

type Bucket = { calls: number; errors: number; totalMs: number; durations: number[] };

function emptyBucket(): Bucket {
  return { calls: 0, errors: 0, totalMs: 0, durations: [] };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function bumpBucket(
  map: Map<string, Bucket>,
  key: string,
  durationMs: number | undefined,
  isError: boolean,
): void {
  const row = map.get(key) ?? emptyBucket();
  row.calls += 1;
  if (isError) row.errors += 1;
  if (durationMs !== undefined) {
    row.totalMs += durationMs;
    row.durations.push(durationMs);
  }
  map.set(key, row);
}

/** Descending count, then ascending name — a total order, so ties never wobble. */
function byCountThenName(
  a: { count: number; key: string },
  b: { count: number; key: string },
): number {
  return b.count - a.count || byString(a.key, b.key);
}

/** The scan both `EventCounts` and `ToolCallStats` run on. */
type Scan = {
  readonly byKind: Map<string, number>;
  readonly useByName: Map<string, number>;
  readonly statsByName: Map<string, Bucket>;
  readonly mcpByName: Map<string, Bucket>;
  readonly resultErrors: Map<string, number>;
  readonly stopReasons: Map<string, number>;
  readonly sessions: Set<string>;
  sawToolUse: boolean;
  toolOk: number;
  toolErrors: number;
  errors: number;
  runsFailed: number;
  firstTs?: number;
  lastTs?: number;
};

function scan(events: readonly ObsEvent[]): Scan {
  const s: Scan = {
    byKind: new Map(),
    useByName: new Map(),
    statsByName: new Map(),
    mcpByName: new Map(),
    resultErrors: new Map(),
    stopReasons: new Map(),
    sessions: new Set(),
    sawToolUse: false,
    toolOk: 0,
    toolErrors: 0,
    errors: 0,
    runsFailed: 0,
  };
  const idToName = new Map<string, string>();

  for (const event of events) {
    s.sessions.add(event.session);
    bump(s.byKind, event.kind);
    if (event.ts !== undefined) {
      if (s.firstTs === undefined || event.ts < s.firstTs) s.firstTs = event.ts;
      if (s.lastTs === undefined || event.ts > s.lastTs) s.lastTs = event.ts;
    }
    const payload = asRecord(event.payload);
    switch (event.kind) {
      case "tool_use": {
        s.sawToolUse = true;
        const name = asString(payload?.["name"]) ?? "(unnamed)";
        bump(s.useByName, name);
        const id = asString(payload?.["id"]);
        if (id !== undefined) idToName.set(id, name);
        break;
      }
      case "tool_result": {
        if (payload?.["isError"] === true) {
          s.toolErrors += 1;
          const id = asString(payload["toolUseId"]);
          const name = (id !== undefined ? idToName.get(id) : undefined) ?? "(unknown tool)";
          bump(s.resultErrors, name);
        } else {
          s.toolOk += 1;
        }
        break;
      }
      case "tool_stats": {
        bumpBucket(
          s.statsByName,
          asString(payload?.["toolName"]) ?? "(unnamed)",
          asNumber(payload?.["durationMs"]),
          payload?.["isError"] === true,
        );
        break;
      }
      case "mcp_stats": {
        const server = asString(payload?.["server"]) ?? "(unknown server)";
        const tool = asString(payload?.["toolName"]) ?? "(unnamed)";
        bumpBucket(
          s.mcpByName,
          `${server}/${tool}`,
          asNumber(payload?.["durationMs"]),
          payload?.["isError"] === true,
        );
        break;
      }
      case "model_meta": {
        bump(s.stopReasons, asString(payload?.["stopReason"]) ?? "(none)");
        break;
      }
      case "error": {
        s.errors += 1;
        break;
      }
      case "run_failed": {
        s.runsFailed += 1;
        break;
      }
      default:
        break;
    }
  }
  return s;
}

function tallies(s: Scan): ToolTally[] {
  const names = [...new Set([...s.useByName.keys(), ...s.statsByName.keys()])].sort(byString);
  return names.map((name) => {
    const stats = s.statsByName.get(name);
    const calls = s.sawToolUse ? (s.useByName.get(name) ?? 0) : (stats?.calls ?? 0);
    return {
      name,
      calls,
      errors: stats !== undefined ? stats.errors : (s.resultErrors.get(name) ?? 0),
      ...(stats !== undefined && stats.durations.length > 0
        ? { totalDurationMs: stats.totalMs }
        : {}),
    };
  });
}

/** "What did this harness actually do", without reading every line. */
export function countEvents(events: readonly ObsEvent[]): EventCountsResult {
  const s = scan(events);
  const mcp: ToolTally[] = [...s.mcpByName.keys()].sort(byString).map((name) => {
    const row = s.mcpByName.get(name) as Bucket;
    return {
      name,
      calls: row.calls,
      errors: row.errors,
      ...(row.durations.length > 0 ? { totalDurationMs: row.totalMs } : {}),
    };
  });
  return {
    sessions: [...s.sessions].sort(byString),
    events: events.length,
    byKind: [...s.byKind.keys()]
      .map((kind) => ({ kind, count: s.byKind.get(kind) as number }))
      .sort((a, b) =>
        byCountThenName({ count: a.count, key: a.kind }, { count: b.count, key: b.kind }),
      ),
    byTool: tallies(s),
    byMcpTool: mcp,
    outcomes: {
      toolErrors: s.toolErrors,
      toolOk: s.toolOk,
      errors: s.errors,
      runsFailed: s.runsFailed,
      stopReasons: [...s.stopReasons.keys()]
        .map((kind) => ({ kind, count: s.stopReasons.get(kind) as number }))
        .sort((a, b) =>
          byCountThenName({ count: a.count, key: a.kind }, { count: b.count, key: b.kind }),
        ),
    },
    ...(s.firstTs !== undefined ? { firstTs: s.firstTs } : {}),
    ...(s.lastTs !== undefined ? { lastTs: s.lastTs } : {}),
  };
}

// ---------------------------------------------------------------------------
// per-tool latency
// ---------------------------------------------------------------------------

/**
 * NEAREST-RANK percentile on a sorted ascending sample, the definition in
 * NIST's primary method: the value at index `ceil(p/100 * n) - 1`.
 *
 * It is stated rather than assumed because the alternatives disagree on small
 * samples by a lot — linear interpolation on six values can return a number
 * that was never measured, which is the wrong answer to "how slow does this
 * tool actually get". Nearest-rank always returns an OBSERVED value, and with
 * one sample every percentile is that sample.
 */
export function nearestRankPercentile(
  sortedAscending: readonly number[],
  p: number,
): number | undefined {
  const n = sortedAscending.length;
  if (n === 0) return undefined;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAscending[index];
}

export type ToolCallStat = {
  readonly name: string;
  readonly calls: number;
  readonly errors: number;
  readonly errorRate: number;
  /** How many of `calls` carried a duration; the latency fields describe these. */
  readonly timedCalls: number;
  readonly meanMs?: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly maxMs?: number;
  readonly totalDurationMs?: number;
};

export type ToolCallStatsResult = {
  readonly percentileMethod: "nearest-rank";
  /** True when the log had no `tool_stats` lines, so no latency could be read. */
  readonly latencyUnavailable: boolean;
  readonly tools: readonly ToolCallStat[];
  readonly mcpTools: readonly ToolCallStat[];
};

/** Round to three decimals so a mean is stable rather than float-noisy. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function statsFrom(
  name: string,
  calls: number,
  errors: number,
  bucket: Bucket | undefined,
): ToolCallStat {
  const durations = bucket === undefined ? [] : [...bucket.durations].sort((a, b) => a - b);
  const timed = durations.length;
  const base = {
    name,
    calls,
    errors,
    errorRate: calls === 0 ? 0 : round3(errors / calls),
    timedCalls: timed,
  };
  if (timed === 0) return base;
  const total = (bucket as Bucket).totalMs;
  return {
    ...base,
    meanMs: round3(total / timed),
    p50Ms: nearestRankPercentile(durations, 50),
    p95Ms: nearestRankPercentile(durations, 95),
    maxMs: durations[timed - 1],
    totalDurationMs: total,
  };
}

/**
 * Per-tool call counts, failures and latency, most-failing first.
 *
 * The order is deliberate: errors descending, then p95 descending, then name.
 * The question this answers is "which tool is failing or slow", so the tool
 * that is failing sorts to the top without the caller re-sorting.
 */
export function toolCallStats(events: readonly ObsEvent[]): ToolCallStatsResult {
  const s = scan(events);
  const rank = (a: ToolCallStat, b: ToolCallStat): number =>
    b.errors - a.errors || (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || byString(a.name, b.name);

  const names = [...new Set([...s.useByName.keys(), ...s.statsByName.keys()])];
  const tools = names
    .map((name) => {
      const bucket = s.statsByName.get(name);
      const calls = s.sawToolUse ? (s.useByName.get(name) ?? 0) : (bucket?.calls ?? 0);
      const errors = bucket !== undefined ? bucket.errors : (s.resultErrors.get(name) ?? 0);
      return statsFrom(name, calls, errors, bucket);
    })
    .sort(rank);

  const mcpTools = [...s.mcpByName.keys()]
    .map((name) => {
      const bucket = s.mcpByName.get(name) as Bucket;
      return statsFrom(name, bucket.calls, bucket.errors, bucket);
    })
    .sort(rank);

  return {
    percentileMethod: "nearest-rank",
    latencyUnavailable: s.statsByName.size === 0 && s.mcpByName.size === 0,
    tools,
    mcpTools,
  };
}
