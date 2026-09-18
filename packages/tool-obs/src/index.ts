/**
 * `@crewhaus/tool-obs` — observability and cost, without a model turn.
 *
 * The package has two halves, and they are deliberately not mixed.
 *
 * **Local.** Nine tools read a harness's OWN telemetry: the JSONL session logs
 * `@crewhaus/event-log` writes under `.crewhaus/sessions`. They touch no
 * network, every path goes through `./paths` containment, every file is
 * byte-capped on disk before a byte is read, and every parse is event-capped
 * so the cap bounds MEMORY rather than being applied after buffering. Two of
 * them (`BudgetCheck`, `SloEvaluate`) are pure arithmetic and touch nothing at
 * all. One of them (`IncidentBundle`) writes a single contained file.
 *
 * **Remote.** Six tools query an external platform. Every outbound byte goes
 * through `./net` — fail-closed origin allow-list, SSRF refusal, IP pinning,
 * per-hop re-checks, credential dropping on a cross-origin redirect, a
 * deadline and a byte cap. The token is a spec-declared environment variable
 * NAME, never a tool argument, and it is scrubbed out of everything on the way
 * back.
 *
 * No vendor is hard-coded except one open standard: `MetricsQuery` speaks the
 * Prometheus HTTP API, which Prometheus, Thanos, Cortex, Mimir, VictoriaMetrics
 * and Grafana all implement. Logs, alerts and status pages genuinely differ per
 * platform, so their endpoints, paths and field names come from the `obs`
 * `tool_config` block. A tool that guessed would be right for one deployment
 * and wrong for every other.
 *
 * **Determinism.** Same inputs against the same world state, same bytes out.
 * Listings are sorted, comparisons are locale-free, nothing is random, and
 * nothing reads the clock: anything that needs "now" — a budget's elapsed
 * fraction, an incident bundle's generation time, a metrics query's evaluation
 * instant — takes it as an input. The single exception is `HealthProbe`'s
 * `latencyMs`, which is a measurement and says so in its description.
 *
 * Results are compact JSON, and a caller's mistake comes back as a readable
 * string rather than an exception.
 */
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { budgetCheck as budgetCheckFn } from "./lib/budget";
import { costReport as costReportFn } from "./lib/cost";
import type { ModelRate } from "./lib/cost";
import { countEvents, toolCallStats as toolCallStatsFn } from "./lib/counts";
import {
  type EventFilter,
  type FieldPredicate,
  type ObsEvent,
  PREDICATE_OPS,
  byString,
  compareEvents,
  filterEvents,
  pageEvents,
  parseLog,
  renderEvent,
} from "./lib/events";
import { clusterErrors, errorText, fingerprint } from "./lib/fingerprint";
import { parseJsonBody, pluck, shapeMetrics, shapeRecords } from "./lib/remote";
import { evaluateSlo } from "./lib/slo";
import { buildTimeline } from "./lib/timeline";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_BYTES,
  MAX_TIMEOUT_MS,
  type ObsConfig,
  ObsPermissionError,
  authHeaders,
  configuredOrigins,
  describeFailure,
  isConfiguredOrigin,
  json,
  openRequest,
  parseUrl,
  readCapped,
  redactorFor,
  resolveObsConfig,
  resolveToken,
  responseHeaders,
  safeUrlLabel,
  startDeadline,
} from "./net";
import { type SafePath, ToolPermissionError, resolveSafe, toPosix } from "./paths";

export {
  ObsPermissionError,
  _resetObsConfig,
  _setDnsLookup,
  _setRawFetch,
  __setPrivateHostsAllowedForTest,
  canonicalizeOrigin,
  getObsConfig,
  registerObsConfig,
} from "./net";
export { ToolPermissionError } from "./paths";

// ---------------------------------------------------------------------------
// local: shared plumbing
// ---------------------------------------------------------------------------

/** Where a harness keeps its session transcripts, by convention. */
const DEFAULT_SESSIONS_DIR = ".crewhaus/sessions";

/**
 * Per-file cap, applied to the size ON DISK before a byte is read.
 *
 * A cap applied after the read is not a cap. A session log this large is
 * already pathological, and the refusal names the size so the caller can pick
 * one file instead of the directory.
 */
const MAX_LOG_BYTES = 128 * 1024 * 1024;

/** Default and hard ceiling on events retained across a whole call. */
const DEFAULT_MAX_EVENTS = 50_000;
const MAX_MAX_EVENTS = 500_000;

/** Cap on what `IncidentBundle` will write, so one bad run cannot fill a disk. */
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

type Loaded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** A caller-supplied path, cut for a message; never the absolute form. */
function renderPath(rel: string): string {
  return rel.length > 200 ? `${rel.slice(0, 200)}…` : rel;
}

/** Read a contained file as UTF-8, refusing anything over `maxBytes`. */
function readContained(toolName: string, rel: string, maxBytes: number): Loaded<string> {
  const shown = renderPath(rel);
  let safe: SafePath;
  try {
    safe = resolveSafe(toolName, rel);
  } catch (err) {
    if (err instanceof ToolPermissionError) return { ok: false, message: err.message };
    throw err;
  }
  let size: number;
  try {
    const stat = statSync(safe.real);
    if (!stat.isFile()) return { ok: false, message: `"${shown}" is not a file` };
    size = stat.size;
  } catch {
    return { ok: false, message: `"${shown}" does not exist or is unreadable` };
  }
  if (size > maxBytes) {
    return {
      ok: false,
      message: `"${shown}" is ${size} bytes, over the ${maxBytes} limit for this tool — pass a single sessionId instead of a whole directory`,
    };
  }
  try {
    return { ok: true, value: readFileSync(safe.real, "utf8") };
  } catch {
    // The node error text carries the ABSOLUTE path, which is workspace layout
    // the caller did not supply and does not need.
    return { ok: false, message: `"${shown}" could not be read` };
  }
}

/** A session id is a filename component: never a path, never a traversal. */
function sessionFileName(sessionId: string): Loaded<string> {
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    return {
      ok: false,
      message: `"${renderPath(sessionId)}" is not a session id — it looks like a path`,
    };
  }
  return { ok: true, value: sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl` };
}

type LoadedEvents = {
  readonly events: readonly ObsEvent[];
  readonly files: readonly string[];
  readonly malformedLines: number;
  readonly truncated: boolean;
  readonly skipped: readonly string[];
};

/**
 * Read one session log, or every `*.jsonl` under the sessions directory, in
 * sorted filename order so the same directory always parses the same way.
 *
 * A named session that cannot be read is a refusal — the caller asked for that
 * one. A single unreadable file inside a directory sweep is recorded in
 * `skipped` and the sweep continues, because one corrupt transcript should not
 * hide the other ninety-nine during an incident.
 */
function loadEvents(
  toolName: string,
  dirRel: string,
  sessionId: string | undefined,
  maxEvents: number,
): Loaded<LoadedEvents> {
  let dir: SafePath;
  try {
    dir = resolveSafe(toolName, dirRel);
  } catch (err) {
    if (err instanceof ToolPermissionError) return { ok: false, message: err.message };
    throw err;
  }
  try {
    if (!statSync(dir.real).isDirectory()) {
      return { ok: false, message: `"${renderPath(dirRel)}" is not a directory` };
    }
  } catch {
    return {
      ok: false,
      message: `"${renderPath(dirRel)}" does not exist or is unreadable — a harness that has never run has no session logs yet`,
    };
  }

  let names: string[];
  if (sessionId !== undefined) {
    const file = sessionFileName(sessionId);
    if (!file.ok) return file;
    names = [file.value];
  } else {
    try {
      names = readdirSync(dir.real)
        .filter((n) => n.endsWith(".jsonl"))
        .sort(byString);
    } catch {
      return { ok: false, message: `"${renderPath(dirRel)}" could not be listed` };
    }
  }

  const events: ObsEvent[] = [];
  const files: string[] = [];
  const skipped: string[] = [];
  let malformedLines = 0;
  let truncated = false;
  for (const name of names) {
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    const rel = toPosix(path.join(dirRel, name));
    const read = readContained(toolName, rel, MAX_LOG_BYTES);
    if (!read.ok) {
      if (sessionId !== undefined) return read;
      skipped.push(`${name}: ${read.message}`);
      continue;
    }
    const parsed = parseLog(name.replace(/\.jsonl$/, ""), read.value, maxEvents - events.length);
    events.push(...parsed.events);
    files.push(name);
    malformedLines += parsed.malformedLines;
    if (parsed.truncated) truncated = true;
  }
  return { ok: true, value: { events, files, malformedLines, truncated, skipped } };
}

/** The read-provenance fields every local result carries. */
function sourceOf(loaded: LoadedEvents): Record<string, unknown> {
  return {
    files: loaded.files.length,
    events: loaded.events.length,
    ...(loaded.truncated ? { truncated: true } : {}),
    ...(loaded.malformedLines > 0 ? { malformedLines: loaded.malformedLines } : {}),
    ...(loaded.skipped.length > 0 ? { skipped: loaded.skipped } : {}),
  };
}

const sessionSourceFields = {
  dir: z
    .string()
    .optional()
    .describe(
      `sessions directory, relative to the working directory (default ${DEFAULT_SESSIONS_DIR})`,
    ),
  sessionId: z
    .string()
    .optional()
    .describe("one session id; omit to read every *.jsonl in the directory"),
  maxEvents: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_EVENTS)
    .optional()
    .describe(`events retained across the whole call (default ${DEFAULT_MAX_EVENTS})`),
};

const timeRangeFields = {
  sinceTs: z
    .number()
    .int()
    .optional()
    .describe("epoch ms, inclusive; an event with no timestamp never matches a time bound"),
  untilTs: z.number().int().optional().describe("epoch ms, inclusive"),
};

const predicateSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("dotted path inside the payload, e.g. `toolName` or `usage.input`"),
    op: z.enum(PREDICATE_OPS),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .describe("compared as text for eq/ne/contains/startsWith, as a number for gt/gte/lt/lte"),
  })
  .optional()
  .describe("one field test against each event's payload");

function filterFrom(input: {
  kinds?: readonly string[];
  sinceTs?: number;
  untilTs?: number;
  runId?: string;
  sessionId?: string;
  where?: FieldPredicate;
}): EventFilter {
  return {
    ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
    ...(input.sinceTs !== undefined ? { sinceTs: input.sinceTs } : {}),
    ...(input.untilTs !== undefined ? { untilTs: input.untilTs } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.where !== undefined ? { predicate: input.where } : {}),
  };
}

// ---------------------------------------------------------------------------
// local: reading the harness's own telemetry
// ---------------------------------------------------------------------------

export const eventQuery: RegisteredTool = buildTool({
  name: "EventQuery",
  description:
    "Page through a harness's own JSONL event logs, filtered by kind, time range, run id, session id and one field predicate, returning a bounded page and a cursor to continue from. Use it to pull the handful of lines that matter out of a transcript with tens of thousands, instead of reading whole files into context. Ordering is by session id then line number, which is the order the lines were written and is total, so the cursor is exact rather than approximate: a log that grew between pages appends after the cursor and nothing is skipped or repeated. The ordering ops on the predicate are numeric only, because comparing dates as text is the kind of answer that looks right and is wrong; use sinceTs and untilTs for time.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    kinds: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("event kinds to keep, e.g. ['tool_use','error']; omit for all"),
    runId: z
      .string()
      .optional()
      .describe(
        "keep only events whose payload carries this runId; kinds that record no run never match",
      ),
    where: predicateSchema,
    limit: z.number().int().min(1).max(500).optional().describe("events per page (default 50)"),
    cursor: z.string().optional().describe("the nextCursor from a previous call"),
    maxPayloadChars: z
      .number()
      .int()
      .min(50)
      .max(20_000)
      .optional()
      .describe("per-event payload budget (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadEvents(
      "EventQuery",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = [...filterEvents(loaded.value.events, filterFrom(input))].sort(compareEvents);
    const page = pageEvents(matched, input.limit ?? 50, input.cursor);
    const budget = input.maxPayloadChars ?? 500;
    return json({
      ...sourceOf(loaded.value),
      matched: matched.length,
      returned: page.events.length,
      remainingFromCursor: page.remaining,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      results: page.events.map((event) => renderEvent(event, budget)),
    });
  },
});

export const eventCounts: RegisteredTool = buildTool({
  name: "EventCounts",
  description:
    "Tally a harness's own event logs by kind, by tool and by outcome, so one call answers what this harness actually did. Use it before EventQuery to find out which kinds and which tools are worth paging through, rather than reading every line to find out. A call is counted from tool_use lines and its duration and error from the tool_stats mirror, so the two are never double-counted; when a log carries neither, errors are recovered by joining a tool_result's isError back to its tool_use id. MCP tools are tallied separately as server/tool, because an MCP server's Read and the built-in Read are different tools that share a name.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    kinds: z.array(z.string().min(1)).max(50).optional(),
    runId: z.string().optional(),
    where: predicateSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadEvents(
      "EventCounts",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = filterEvents(loaded.value.events, filterFrom(input));
    return json({ ...sourceOf(loaded.value), ...countEvents(matched) });
  },
});

export const toolCallStats: RegisteredTool = buildTool({
  name: "ToolCallStats",
  description:
    "Per-tool call counts, failure counts, mean, p50, p95 and max duration from a harness's own logs, ordered most-failing first. Use it to find which tool is failing or slow without eyeballing a transcript. Percentiles are NEAREST-RANK — the value at index ceil(p/100 × n) − 1 of the ascending sample — so every figure returned is a duration that was actually measured, never an interpolated one that was not; with a single sample every percentile is that sample. Durations come only from the runtime's tool_stats and mcp_stats mirrors, so a harness that ran with advisor events disabled reports counts with latencyUnavailable set rather than an estimate.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    runId: z.string().optional(),
    where: predicateSchema,
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadEvents(
      "ToolCallStats",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = filterEvents(loaded.value.events, filterFrom(input));
    return json({ ...sourceOf(loaded.value), ...toolCallStatsFn(matched) });
  },
});

export const errorCluster: RegisteredTool = buildTool({
  name: "ErrorCluster",
  description:
    "Group a harness's errors by a normalised fingerprint — URLs, uuids, timestamps, paths, prefixed ids, hex blobs, quoted strings and numbers all masked — most frequent first, with one verbatim example each. Use it to turn a thousand error lines into the six distinct problems they actually are. Masking is by SHAPE, never by vocabulary, so it needs no knowledge of which platform wrote the message; the example is the first occurrence in log order, which is the only choice that does not change as the log grows. It does not cluster by meaning: two messages that differ only in a number land together even when they are different problems, which is exactly why the example is carried on every group.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    runId: z.string().optional(),
    maxGroups: z.number().int().min(1).max(200).optional().describe("groups returned (default 20)"),
    includeToolErrors: z
      .boolean()
      .optional()
      .describe("also cluster tool_result lines flagged isError (default false)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadEvents(
      "ErrorCluster",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = filterEvents(loaded.value.events, filterFrom(input));
    return json({
      ...sourceOf(loaded.value),
      ...clusterErrors(matched, input.maxGroups ?? 20, input.includeToolErrors === true),
    });
  },
});

export const runTimeline: RegisteredTool = buildTool({
  name: "RunTimeline",
  description:
    "One run's events in order with the gap before each and the runtime's own measured duration where it recorded one, so a caller can see where the time went. Use it after EventCounts points at a slow or failed run, to find the step that actually cost the time. A gap is the distance from the previous timestamped line and is attributed to the line that ends it, which is not the same as how long that step took — where the runtime measured the step itself, durationMs carries the measured figure and is the one to trust. An event with no timestamp keeps its place in order and carries no gap, because a made-up timestamp reads exactly like a real one.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    runId: z
      .string()
      .optional()
      .describe("the run to draw; omit to draw the whole session, which is the usual case"),
    kinds: z.array(z.string().min(1)).max(50).optional().describe("restrict to these kinds"),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .optional()
      .describe("entries drawn (default 500)"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.sessionId === undefined && input.runId === undefined) {
      return "pass sessionId, runId, or both — a timeline across every session in the directory would interleave unrelated runs and mean nothing";
    }
    const loaded = loadEvents(
      "RunTimeline",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = [...filterEvents(loaded.value.events, filterFrom(input))].sort(compareEvents);
    if (matched.length === 0) {
      return json({
        ...sourceOf(loaded.value),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        matched: 0,
        note: "no events matched — a runId filter only matches kinds whose payload records one (cost_accrual does, user_message does not)",
      });
    }
    return json({
      ...sourceOf(loaded.value),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...buildTimeline(matched, input.maxEntries ?? 500),
    });
  },
});

const rateSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .describe("model id, matched against the accrual's modelId then specModel"),
    inputPerMillionUsd: z.number().min(0).optional(),
    outputPerMillionUsd: z.number().min(0).optional(),
    cachedReadPerMillionUsd: z
      .number()
      .min(0)
      .optional()
      .describe("falls back to the input rate when omitted — a cache read is discounted, not free"),
    cacheCreationPerMillionUsd: z
      .number()
      .min(0)
      .optional()
      .describe("falls back to the input rate when omitted"),
  })
  .describe("USD per MILLION tokens");

export const costReport: RegisteredTool = buildTool({
  name: "CostReport",
  description:
    "Token and cost totals from a harness's own logs, broken down by model, by UTC day and by run, with the rate table supplied by the caller rather than assumed. Use it to see where a fleet's spend went without a billing API, and to re-price historical tokens at current rates. Both figures come back side by side: recordedUsdMicros is what the runtime computed from whatever price table that process held, computedUsdMicros is what your rates say those tokens cost. Figures are integer micro-USD so the arithmetic is exact; a model with no row in your table is counted under modelsWithoutRate with real tokens and zero computed cost, never silently at zero, and an accrual the runtime itself could not price is counted under unpricedAccruals.",
  inputSchema: z.object({
    ...sessionSourceFields,
    ...timeRangeFields,
    runId: z.string().optional(),
    rates: z
      .array(rateSchema)
      .max(200)
      .optional()
      .describe("price table; omit to report tokens and the recorded cost only"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const loaded = loadEvents(
      "CostReport",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;
    const matched = filterEvents(loaded.value.events, filterFrom(input));
    const rates = (input.rates ?? []) as readonly ModelRate[];
    const report = costReportFn(matched, rates);
    return json({
      ...sourceOf(loaded.value),
      rateRows: rates.length,
      ...report,
      ...(report.accruals === 0
        ? {
            note: "no cost_accrual lines — this harness ran without cost tracking (CREWHAUS_COST_TRACKING), so there is nothing to total rather than nothing spent",
          }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// local: pure arithmetic
// ---------------------------------------------------------------------------

export const budgetCheck: RegisteredTool = buildTool({
  name: "BudgetCheck",
  description:
    "Given spend so far and a budget in integer micro-USD, report what is left, what fraction is used, and which declared thresholds have been crossed. Use it to gate work on a spend limit without a model doing the arithmetic and getting a percentage subtly wrong. It is pure: no files, no network, and no clock — a burn-rate projection is offered only when the caller states elapsedFraction themselves, because a tool that read Date.now() would answer the same question differently every time it ran. A threshold is crossed at or above its limit, not strictly above, and an overspend is reported as overUsdMicros rather than a negative remaining.",
  inputSchema: z.object({
    spentUsdMicros: z.number().int().min(0).describe("integer micro-USD spent so far"),
    budgetUsdMicros: z
      .number()
      .int()
      .min(0)
      .describe("integer micro-USD the budget allows; 0 is a real budget and reports as exhausted"),
    thresholds: z
      .array(
        z.object({
          percent: z.number().min(0).max(100).describe("percent of the budget, e.g. 80"),
          label: z.string().optional(),
        }),
      )
      .max(20)
      .optional()
      .describe("warn levels; returned sorted ascending with the highest crossed one named"),
    elapsedFraction: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "how far through the budget period you are, 0-1; supplied, never read from a clock",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(
      budgetCheckFn(
        input.spentUsdMicros,
        input.budgetUsdMicros,
        input.thresholds ?? [],
        input.elapsedFraction,
      ),
    ),
});

export const sloEvaluate: RegisteredTool = buildTool({
  name: "SloEvaluate",
  description:
    "Given counts or observed durations and a declared objective — success rate, latency percentile, or error budget — report whether the objective holds and how much error budget is left. Use it to turn EventCounts or ToolCallStats output into a yes-or-no answer about a service level, with the remaining failure allowance stated as a number rather than a rate to re-derive. Latency percentiles are nearest-rank, so an observed value is always returned; an empty window reports holds with an explicit verdict saying nothing confirmed it, because calling zero observations a 100% success rate is the confidently wrong answer. It has no notion of time: there is no rolling window and no multi-window burn-rate alerting, since both need a clock and this is a pure function — the caller decides which observations make up the window.",
  inputSchema: z.object({
    objective: z.enum(["success_rate", "latency_percentile", "error_budget"]),
    target: z
      .number()
      .describe("a FRACTION: 0.99 for a 99% success rate, or 0.01 with targetIs max_error_rate"),
    targetIs: z
      .enum(["min_success_rate", "max_error_rate"])
      .optional()
      .describe("how to read target (default min_success_rate)"),
    total: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("observations in the window, for the rate objectives"),
    failures: z.number().int().min(0).optional().describe("pass this or successes, not both"),
    successes: z.number().int().min(0).optional(),
    durationsMs: z
      .array(z.number())
      .max(100_000)
      .optional()
      .describe("observed durations, for latency_percentile"),
    percentile: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("which percentile to take (default 95)"),
    thresholdMs: z.number().optional().describe("the ceiling that percentile must stay under"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = evaluateSlo({
      objective: input.objective,
      target: input.target,
      ...(input.targetIs !== undefined ? { targetIs: input.targetIs } : {}),
      ...(input.total !== undefined ? { total: input.total } : {}),
      ...(input.failures !== undefined ? { failures: input.failures } : {}),
      ...(input.successes !== undefined ? { successes: input.successes } : {}),
      ...(input.durationsMs !== undefined ? { durationsMs: input.durationsMs } : {}),
      ...(input.percentile !== undefined ? { percentile: input.percentile } : {}),
      ...(input.thresholdMs !== undefined ? { thresholdMs: input.thresholdMs } : {}),
    });
    return typeof result === "string" ? result : json(result);
  },
});

// ---------------------------------------------------------------------------
// local: the incident bundle
// ---------------------------------------------------------------------------

/** The spec a session belonged to, where any line recorded one. */
function specNameOf(events: readonly ObsEvent[]): string | undefined {
  for (const event of events) {
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const name = (payload as Record<string, unknown>)["specName"];
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
}

export const incidentBundle: RegisteredTool = buildTool({
  name: "IncidentBundle",
  description:
    "Assemble one failed run's events, clustered errors, tool statistics and spec name into a single contained JSON file a human can be handed. Use it at the end of a triage pass so the findings leave the context window as a durable artefact instead of being re-derived by the next reader. The output path goes through workspace containment like every other path here, and the write refuses an existing file unless overwrite is set, so a second bundle never silently replaces the first. It records no timestamp of its own: pass nowMs if the bundle should say when it was made, because a tool that read the clock would produce a different file from the same log every time.",
  inputSchema: z.object({
    ...sessionSourceFields,
    out: z.string().min(1).describe("where to write the bundle, relative to the working directory"),
    runId: z
      .string()
      .optional()
      .describe("narrow the events to one run; omit for the whole session"),
    nowMs: z
      .number()
      .int()
      .optional()
      .describe(
        "epoch ms to stamp the bundle with; omitted means the bundle carries no generation time",
      ),
    maxEntries: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("timeline entries and events included (default 500)"),
    maxPayloadChars: z
      .number()
      .int()
      .min(50)
      .max(20_000)
      .optional()
      .describe("per-event payload budget (default 1000)"),
    overwrite: z.boolean().optional().describe("replace an existing file (default false)"),
  }),
  destructive: true,
  execute: async (input) => {
    if (input.sessionId === undefined && input.runId === undefined) {
      return "pass sessionId, runId, or both — a bundle spanning every session in the directory is not an incident report";
    }
    const loaded = loadEvents(
      "IncidentBundle",
      input.dir ?? DEFAULT_SESSIONS_DIR,
      input.sessionId,
      input.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    if (!loaded.ok) return loaded.message;

    let out: SafePath;
    try {
      out = resolveSafe("IncidentBundle", input.out);
    } catch (err) {
      if (err instanceof ToolPermissionError) return err.message;
      throw err;
    }

    const matched = [...filterEvents(loaded.value.events, filterFrom(input))].sort(compareEvents);
    const limit = input.maxEntries ?? 500;
    const budget = input.maxPayloadChars ?? 1000;
    const errors = matched.filter((e) => e.kind === "error" || e.kind === "run_failed");
    const specName = specNameOf(matched);

    const bundle = {
      bundleVersion: 1,
      ...(input.nowMs !== undefined ? { generatedAtMs: input.nowMs } : {}),
      source: {
        dir: renderPath(input.dir ?? DEFAULT_SESSIONS_DIR),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...sourceOf(loaded.value),
        matched: matched.length,
      },
      ...(specName !== undefined ? { specName } : {}),
      counts: countEvents(matched),
      toolCalls: toolCallStatsFn(matched),
      errors: clusterErrors(matched, 50, true),
      failures: errors.slice(0, 50).map((e) => ({
        session: e.session,
        line: e.line,
        ...(e.ts !== undefined ? { ts: e.ts } : {}),
        kind: e.kind,
        message: errorText(e.payload),
        fingerprint: fingerprint(errorText(e.payload)),
      })),
      timeline: buildTimeline(matched, limit),
      events: matched.slice(0, limit).map((e) => renderEvent(e, budget)),
      eventsOmitted: Math.max(0, matched.length - limit),
    };

    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_BUNDLE_BYTES) {
      return `the bundle would be ${bytes} bytes, over the ${MAX_BUNDLE_BYTES} limit — lower maxEntries or maxPayloadChars`;
    }
    try {
      // The parent is created because `reports/incident.json` is the obvious
      // thing to ask for and failing on it teaches nothing. It is created
      // through the already-validated real path, so the directory that appears
      // is inside the workspace by the same check the file is.
      const parent = path.dirname(out.real);
      if (parent !== out.real) mkdirSync(parent, { recursive: true });
      // "wx" is an atomic create-or-fail, so the no-clobber promise is kept by
      // the filesystem rather than by a stat that something could race.
      writeFileSync(out.real, text, {
        encoding: "utf8",
        flag: input.overwrite === true ? "w" : "wx",
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return `"${renderPath(input.out)}" already exists — pass overwrite: true to replace it`;
      }
      return `"${renderPath(input.out)}" could not be written${code !== undefined ? ` (${code})` : ""}`;
    }
    return json({
      wrote: toPosix(out.rel),
      bytes,
      events: matched.length,
      eventsIncluded: Math.min(matched.length, limit),
      errorGroups: bundle.errors.groups.length,
    });
  },
});

// ---------------------------------------------------------------------------
// remote: shared plumbing
// ---------------------------------------------------------------------------

/** The config this call runs under. */
function configFor(ctx: ToolExecuteContext | undefined): ObsConfig {
  return resolveObsConfig(ctx?.toolConfig);
}

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the request is abandoned (default ${DEFAULT_TIMEOUT_MS})`);

const maxBytesSchema = z
  .number()
  .int()
  .min(1024)
  .max(MAX_MAX_BYTES)
  .optional()
  .describe(
    `response body cap in bytes (default ${DEFAULT_MAX_BYTES}); the body is cut, not grown`,
  );

const justificationSchema = z
  .string()
  .min(1)
  .describe(
    "why this is being sent, recorded with the call — this action is visible outside the harness",
  );

type Surface = "metrics" | "logs" | "alerts" | "alertAck" | "statusPage";

const SURFACE_KEY: Record<Surface, string> = {
  metrics: "metrics",
  logs: "logs",
  alerts: "alerts",
  alertAck: "alert_ack",
  statusPage: "status_page",
};

/** The URL one surface addresses, or a readable refusal naming the missing config. */
function surfaceUrl(
  cfg: ObsConfig,
  surface: Surface,
  defaultPath: string,
  substitutions: Readonly<Record<string, string>> = {},
): URL | string {
  const endpoint = cfg[surface];
  if (endpoint === undefined) {
    return `no ${SURFACE_KEY[surface]} endpoint is configured — add an obs tool_config block with ${SURFACE_KEY[surface]}.base_url (and its origin in allowed_origins) before calling this`;
  }
  let suffix = endpoint.path ?? defaultPath;
  const applied: Array<{ key: string; encoded: string }> = [];
  for (const key of Object.keys(substitutions).sort(byString)) {
    const placeholder = `{${key}}`;
    const value = substitutions[key] as string;
    if (!suffix.includes(placeholder)) continue;
    // An empty substitution would silently collapse `/incidents/{id}/updates`
    // into `/incidents//updates`, which some servers route to the COLLECTION —
    // an update meant for one incident would create a new one. Refuse instead.
    if (value === "") {
      return `${SURFACE_KEY[surface]}.path contains {${key}} but no ${key} was supplied — pass one, or configure a path that does not need it`;
    }
    // `.` and `..` are the two values percent-encoding does NOT neutralise:
    // they encode to themselves, and the URL parser then RESOLVES them, so
    // `/incidents/../updates` is requested as `/updates`. That is the same
    // collection endpoint the empty case above exists to keep away from,
    // reached by an id instead of by a missing one. A dot segment is not an id.
    if (/^\.{1,2}$/.test(value)) {
      return `${SURFACE_KEY[surface]}.path substitutes {${key}}, and "${value}" is a relative path segment rather than an ${key} — it would walk the request up to a different endpoint`;
    }
    const encoded = encodeURIComponent(value);
    applied.push({ key, encoded });
    suffix = suffix.split(placeholder).join(encoded);
  }
  const base = endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl.slice(0, -1) : endpoint.baseUrl;
  const parsed = parseUrl(`${base}${suffix}`);
  if (typeof parsed === "string") {
    return `${SURFACE_KEY[surface]}.base_url is not usable: ${parsed}`;
  }
  // Belt and braces, checked against the URL that will ACTUALLY be requested
  // rather than against the string it was built from: whatever normalisation
  // the parser applied, every substituted value must still be in the path. If
  // one is not, the request is addressing something other than what was asked
  // for, and that is never a request worth sending.
  for (const { key, encoded } of applied) {
    if (!parsed.pathname.includes(encoded)) {
      return `the ${key} did not survive into the request path — "${SURFACE_KEY[surface]}.path" would address ${safeUrlLabel(parsed)} instead, which is a different endpoint`;
    }
  }
  return parsed;
}

type RemoteCall = {
  readonly url: URL;
  readonly method: string;
  readonly cfg: ObsConfig;
  readonly body?: string;
  readonly contentType?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  /** A surface a deployment may legitimately expose without auth. */
  readonly tokenOptional?: boolean;
};

type RemoteResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly text: string;
      readonly bytes: number;
      readonly truncated: boolean;
      readonly headers: Record<string, string>;
      readonly finalUrl: string;
      readonly redirects: readonly string[];
      readonly credentialsDropped: boolean;
      readonly redact: (text: string) => string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * One request through the full gate, with the token resolved from its named
 * environment variable and scrubbed out of whatever comes back.
 */
async function callRemote(call: RemoteCall): Promise<RemoteResult> {
  const token = resolveToken(call.cfg.tokenEnv, process.env, call.tokenOptional === true);
  if (!token.ok) return { ok: false, message: token.message };
  const redact = redactorFor(token.token === "" ? undefined : token.token);
  const auth = authHeaders(call.cfg, token.token);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...auth,
    ...(call.contentType !== undefined ? { "content-type": call.contentType } : {}),
  };
  const secretHeaders = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
  const deadline = startDeadline(call.timeoutMs, call.signal);
  try {
    const opened = await openRequest({
      url: call.url,
      method: call.method,
      headers,
      ...(call.body !== undefined ? { body: call.body } : {}),
      signal: deadline.signal,
      cfg: call.cfg,
      credentialHeaders: secretHeaders,
    });
    const body = await readCapped(opened.res, call.maxBytes);
    return {
      ok: true,
      status: opened.res.status,
      text: redact(body.text),
      bytes: body.bytes,
      truncated: body.truncated,
      // Credential headers are already stripped; the redactor covers the case
      // of a platform that reflects the token back in a header of its own.
      headers: Object.fromEntries(
        Object.entries(responseHeaders(opened.res)).map(([k, v]) => [k, redact(v)]),
      ),
      finalUrl: redact(opened.finalUrl),
      redirects: opened.redirects.map(redact),
      credentialsDropped: opened.credentialsDropped,
      redact,
    };
  } catch (err) {
    return { ok: false, message: redact(describeFailure(err, deadline)) };
  } finally {
    deadline.cancel();
  }
}

/** The shape every non-2xx answer comes back as, with the body excerpt capped. */
function httpFailure(surface: string, result: Extract<RemoteResult, { ok: true }>): string {
  const excerpt = result.text.slice(0, 500).replace(/\s+/g, " ").trim();
  return json({
    ok: false,
    surface,
    status: result.status,
    url: result.finalUrl,
    ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
    body: excerpt,
  });
}

// ---------------------------------------------------------------------------
// remote: querying
// ---------------------------------------------------------------------------

export const metricsQuery: RegisteredTool = buildTool({
  name: "MetricsQuery",
  description:
    "Run a Prometheus-style instant or range query against the allow-listed metrics endpoint and return the matching series with their labels. Use it to answer a question about a live system from its own metrics instead of guessing from logs. It speaks the Prometheus HTTP API, which is a format rather than a product — Thanos, Cortex, Mimir, VictoriaMetrics and Grafana all serve it — and the query goes in a POST form body so it stays out of the URL and out of any proxy's access log. Evaluation time is an input, never the clock: an instant query with no timeSec asks the server for its own now, which is the one value that cannot be made deterministic, and sample values are returned as strings so NaN, +Inf and full float precision all survive.",
  inputSchema: z.object({
    query: z.string().min(1).max(20_000).describe("the PromQL expression"),
    type: z.enum(["instant", "range"]).optional().describe("default instant"),
    timeSec: z
      .number()
      .optional()
      .describe("instant queries: epoch SECONDS to evaluate at; omitted means the server's now"),
    startSec: z.number().optional().describe("range queries: epoch seconds, inclusive"),
    endSec: z.number().optional().describe("range queries: epoch seconds, inclusive"),
    stepSec: z.number().positive().optional().describe("range queries: resolution in seconds"),
    maxSeries: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("series returned (default 100)"),
    maxSamplesPerSeries: z.number().int().min(1).max(10_000).optional().describe("default 500"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const kind = input.type ?? "instant";
    const form = new URLSearchParams();
    form.set("query", input.query);
    if (kind === "range") {
      if (
        input.startSec === undefined ||
        input.endSec === undefined ||
        input.stepSec === undefined
      ) {
        return "a range query needs startSec, endSec and stepSec — without a step the server cannot decide the resolution";
      }
      if (input.endSec < input.startSec) return "endSec is before startSec";
      form.set("start", String(input.startSec));
      form.set("end", String(input.endSec));
      form.set("step", String(input.stepSec));
    } else if (input.timeSec !== undefined) {
      form.set("time", String(input.timeSec));
    }

    const url = surfaceUrl(
      cfg,
      "metrics",
      kind === "range" ? "/api/v1/query_range" : "/api/v1/query",
    );
    if (typeof url === "string") return url;

    const result = await callRemote({
      url,
      method: cfg.metrics?.method ?? "POST",
      cfg,
      body: form.toString(),
      contentType: "application/x-www-form-urlencoded",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      tokenOptional: true,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) return result.message;
    if (result.status < 200 || result.status >= 300) return httpFailure("metrics", result);

    const parsed = parseJsonBody(result.text);
    if (!parsed.ok) return parsed.message;
    const envelope = parsed.value as Record<string, unknown> | null;
    const warnings = Array.isArray(envelope?.["warnings"])
      ? (envelope["warnings"] as unknown[]).map(String)
      : [];
    const shaped = shapeMetrics(
      pluck(parsed.value, cfg.metrics?.resultPath ?? "data"),
      input.maxSeries ?? 100,
      input.maxSamplesPerSeries ?? 500,
      warnings,
    );
    if (typeof shaped === "string") return shaped;
    return json({
      ok: true,
      queryType: kind,
      status: result.status,
      ...(result.truncated ? { bodyTruncated: true } : {}),
      ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
      ...shaped,
    });
  },
});

export const logsQuery: RegisteredTool = buildTool({
  name: "LogsQuery",
  description:
    "Query a log platform through the endpoint, parameter names and result path declared in the obs tool_config block, returning a bounded, field-projected page of records. Use it to search a production log store from a harness without hard-coding a vendor into the tool. Nothing here knows what Loki, Elasticsearch or CloudWatch call their parameters: the spec maps query, start, end and limit to whatever this platform names them, states the time format it wants, and names the dot path to the records inside the response. Every field is stringified and cut to a budget, because one verbose log field repeated across a hundred hits is an entire context window.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(20_000)
      .describe("the platform's own query expression, passed through verbatim"),
    startMs: z
      .number()
      .int()
      .optional()
      .describe("epoch ms; converted to the configured time_format"),
    endMs: z
      .number()
      .int()
      .optional()
      .describe("epoch ms; converted to the configured time_format"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("records requested and returned (default 100)"),
    fields: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("keep only these keys of each record; omit to keep all, cut to the field budget"),
    maxFieldChars: z
      .number()
      .int()
      .min(20)
      .max(20_000)
      .optional()
      .describe("per-field budget (default 500)"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const url = surfaceUrl(cfg, "logs", "");
    if (typeof url === "string") return url;
    const params = cfg.logs?.params ?? {};
    const format = params["time_format"] ?? "ms";
    const stamp = (ms: number): string => {
      if (format === "s") return String(Math.floor(ms / 1000));
      if (format === "ns") return `${ms}000000`;
      if (format === "iso") return new Date(ms).toISOString();
      return String(ms);
    };

    const search = new URLSearchParams();
    search.set(params["query"] ?? "query", input.query);
    if (input.startMs !== undefined) search.set(params["start"] ?? "start", stamp(input.startMs));
    if (input.endMs !== undefined) search.set(params["end"] ?? "end", stamp(input.endMs));
    search.set(params["limit"] ?? "limit", String(input.limit ?? 100));

    const method = cfg.logs?.method ?? "GET";
    const target = new URL(url.toString());
    if (method === "GET") target.search = search.toString();

    const result = await callRemote({
      url: target,
      method,
      cfg,
      ...(method === "GET"
        ? {}
        : { body: search.toString(), contentType: "application/x-www-form-urlencoded" }),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      tokenOptional: true,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) return result.message;
    if (result.status < 200 || result.status >= 300) return httpFailure("logs", result);

    const parsed = parseJsonBody(result.text);
    if (!parsed.ok) return parsed.message;
    const shaped = shapeRecords(
      pluck(parsed.value, cfg.logs?.resultPath),
      input.limit ?? 100,
      input.maxFieldChars ?? 500,
      input.fields,
    );
    if (typeof shaped === "string") return shaped;
    return json({
      ok: true,
      status: result.status,
      ...(result.truncated ? { bodyTruncated: true } : {}),
      ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
      ...shaped,
    });
  },
});

export const alertList: RegisteredTool = buildTool({
  name: "AlertList",
  description:
    "List the alerts the configured alerting endpoint is currently reporting, bounded and field-projected. Use it to find out what is already firing before opening an incident or acknowledging anything. Like LogsQuery it is vendor-neutral: the endpoint, the path and the dot path to the alert array all come from the obs tool_config block, and any extra query parameters the platform needs are declared there too. It reads only — acknowledging an alert is AlertAck, which is a separate, justification-gated tool.",
  inputSchema: z.object({
    filter: z
      .record(z.string())
      .optional()
      .describe(
        "extra query parameters; the spec's own params win, so a filter narrows rather than overrides",
      ),
    limit: z.number().int().min(1).max(500).optional().describe("alerts returned (default 100)"),
    fields: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("keep only these keys of each alert"),
    maxFieldChars: z
      .number()
      .int()
      .min(20)
      .max(20_000)
      .optional()
      .describe("per-field budget (default 500)"),
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const url = surfaceUrl(cfg, "alerts", "");
    if (typeof url === "string") return url;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input.filter ?? {}).sort((a, b) =>
      byString(a[0], b[0]),
    )) {
      search.set(key, value);
    }
    // The spec's own parameters are written LAST, so they win. They are how a
    // deployment scopes this surface — to one team, one account, one severity
    // — and a caller-supplied filter that could overwrite them would widen the
    // query past what the spec allowed. A filter adds; it does not override.
    for (const [key, value] of Object.entries(cfg.alerts?.params ?? {}).sort((a, b) =>
      byString(a[0], b[0]),
    )) {
      search.set(key, value);
    }
    const target = new URL(url.toString());
    if ([...search.keys()].length > 0) target.search = search.toString();

    const result = await callRemote({
      url: target,
      method: cfg.alerts?.method ?? "GET",
      cfg,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      tokenOptional: true,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) return result.message;
    if (result.status < 200 || result.status >= 300) return httpFailure("alerts", result);

    const parsed = parseJsonBody(result.text);
    if (!parsed.ok) return parsed.message;
    const shaped = shapeRecords(
      pluck(parsed.value, cfg.alerts?.resultPath),
      input.limit ?? 100,
      input.maxFieldChars ?? 500,
      input.fields,
    );
    if (typeof shaped === "string") return shaped;
    return json({
      ok: true,
      status: result.status,
      ...(result.truncated ? { bodyTruncated: true } : {}),
      ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
      alerts: shaped.records,
      total: shaped.total,
      truncated: shaped.truncated,
    });
  },
});

// ---------------------------------------------------------------------------
// remote: acting
// ---------------------------------------------------------------------------

export const alertAck: RegisteredTool = buildTool({
  name: "AlertAck",
  description:
    "Acknowledge one alert through the configured acknowledgement endpoint, recording who acknowledged it and why. Use it to silence a page a harness has confirmed it is already handling, never to make a dashboard look quieter. This mutates state on a system other people are watching and can stop a human being paged, so it is destructive and justification-gated; the alert id is substituted into the configured path template and sent as a JSON body alongside any static fields the spec declares. It does not resolve, close or delete an alert, and it does not create a silence rule — those are different operations with different blast radii and none of them are implemented here.",
  inputSchema: z.object({
    alertId: z
      .string()
      .min(1)
      .max(500)
      .describe("the platform's own alert id; substituted for {id} in the configured path"),
    acknowledgedBy: z
      .string()
      .min(1)
      .max(200)
      .describe("who is acknowledging — a person or a harness name, recorded on the alert"),
    comment: z.string().max(2000).optional().describe("free text sent with the acknowledgement"),
    justification: justificationSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const url = surfaceUrl(cfg, "alertAck", "", { id: input.alertId });
    if (typeof url === "string") return url;
    const body = {
      ...(cfg.alertAck?.params ?? {}),
      alertId: input.alertId,
      acknowledgedBy: input.acknowledgedBy,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    };
    const result = await callRemote({
      url,
      method: cfg.alertAck?.method ?? "POST",
      cfg,
      body: JSON.stringify(body),
      contentType: "application/json",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) return result.message;
    if (result.status < 200 || result.status >= 300) return httpFailure("alert_ack", result);
    return json({
      ok: true,
      acknowledged: input.alertId,
      status: result.status,
      url: result.finalUrl,
      ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
      response: result.text.slice(0, 1000),
    });
  },
});

export const statusPagePost: RegisteredTool = buildTool({
  name: "StatusPagePost",
  description:
    "Publish an incident update to the configured status page endpoint. Use it only when a human has decided the incident should be announced, because what this writes is read by customers. It is destructive and justification-gated for that reason: a status page post is public the moment it lands, cannot be unpublished by this tool, and is frequently the first thing anyone outside the team learns about an outage. The endpoint, the path (with {id} substituted when updating an existing incident) and any static fields come from the obs tool_config block, so nothing about a particular status-page vendor is baked in here.",
  inputSchema: z.object({
    title: z.string().min(1).max(300).describe("the incident headline, as customers will read it"),
    body: z.string().min(1).max(10_000).describe("the update text, as customers will read it"),
    status: z
      .string()
      .min(1)
      .max(60)
      .describe(
        "the platform's own status value, e.g. investigating, identified, monitoring, resolved",
      ),
    incidentId: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("an existing incident to update; substituted for {id} in the configured path"),
    componentIds: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("affected components, if the platform takes them"),
    justification: justificationSchema,
    timeoutMs: timeoutSchema,
    maxBytes: maxBytesSchema,
  }),
  scope: "external",
  ioCapability: "network",
  destructive: true,
  requireJustification: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const url = surfaceUrl(cfg, "statusPage", "", { id: input.incidentId ?? "" });
    if (typeof url === "string") return url;
    const body = {
      ...(cfg.statusPage?.params ?? {}),
      title: input.title,
      body: input.body,
      status: input.status,
      ...(input.incidentId !== undefined ? { incidentId: input.incidentId } : {}),
      ...(input.componentIds !== undefined
        ? { componentIds: [...input.componentIds].sort(byString) }
        : {}),
    };
    const result = await callRemote({
      url,
      method: cfg.statusPage?.method ?? "POST",
      cfg,
      body: JSON.stringify(body),
      contentType: "application/json",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: input.maxBytes ?? DEFAULT_MAX_BYTES,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) return result.message;
    if (result.status < 200 || result.status >= 300) return httpFailure("status_page", result);
    return json({
      ok: true,
      published: true,
      status: result.status,
      url: result.finalUrl,
      ...(input.incidentId !== undefined ? { incidentId: input.incidentId } : {}),
      ...(result.credentialsDropped ? { credentialsDropped: true } : {}),
      response: result.text.slice(0, 1000),
    });
  },
});

// ---------------------------------------------------------------------------
// remote: probing
// ---------------------------------------------------------------------------

export const healthProbe: RegisteredTool = buildTool({
  name: "HealthProbe",
  description:
    "Check a list of allow-listed endpoints with a concurrency cap and a required deadline, returning each one's status and latency. Use it to answer whether a fleet is up in a single call, instead of one model turn per endpoint. The deadline is required rather than defaulted and bounds the WHOLE sweep, so a hung endpoint cannot hold the others up; each probe is additionally bounded by whatever is left of it, and a probe that never got a turn comes back as skipped rather than as a failure it did not have. The configured token is sent only to the origins the spec declared as obs surfaces, because the allow-list is a reachability list and a probe of somebody else's service must not hand them the credential — authenticated on each probe says whether it carried one. latencyMs is a wall-clock measurement and is the one field in this package that differs run to run — everything else about the result is determined by the endpoints' answers.",
  inputSchema: z.object({
    urls: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("absolute http(s) URLs; every origin must appear in the configured allow-list"),
    deadlineMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .describe("REQUIRED deadline in milliseconds — the whole sweep never runs longer than this"),
    method: z
      .enum(["GET", "HEAD"])
      .optional()
      .describe("default GET; HEAD when the endpoint supports it"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe("probes in flight at once (default 4)"),
    expectStatus: z
      .array(z.number().int().min(100).max(599))
      .max(20)
      .optional()
      .describe("statuses counted as healthy; omit to accept any 2xx"),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .optional()
      .describe("bytes read from each body before the stream is cancelled (default 2048)"),
  }),
  scope: "external",
  ioCapability: "network",
  readOnly: true,
  concurrencySafe: true,
  execute: async (input, ctx) => {
    const cfg = configFor(ctx);
    const token = resolveToken(cfg.tokenEnv, process.env, true);
    if (!token.ok) return token.message;
    const redact = redactorFor(token.token === "" ? undefined : token.token);
    const auth = authHeaders(cfg, token.token);
    const secretHeaders = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
    // The allow-list is the REACHABILITY list and is wider than the platform
    // the token belongs to — a fleet allow-lists every service it wants
    // probed. Sending the observability token to each of them would hand the
    // credential to whoever runs those services, so it goes only to the
    // origins the spec configured as obs surfaces.
    const tokenOrigins = configuredOrigins(cfg);
    const method = input.method ?? "GET";
    const maxBytes = input.maxBytes ?? 2048;
    const expected = input.expectStatus !== undefined ? new Set(input.expectStatus) : undefined;
    const deadline = startDeadline(input.deadlineMs, ctx?.signal);

    type Probe = {
      url: string;
      ok: boolean;
      status?: number;
      latencyMs?: number;
      skipped?: boolean;
      /** Present only when a token exists: whether this probe carried it. */
      authenticated?: boolean;
      error?: string;
    };
    const results = new Array<Probe>(input.urls.length);

    const probe = async (index: number): Promise<void> => {
      const raw = input.urls[index] as string;
      const label = safeUrlLabel(raw);
      if (deadline.expired()) {
        results[index] = {
          url: label,
          ok: false,
          skipped: true,
          error: "the sweep deadline elapsed before this endpoint was probed",
        };
        return;
      }
      const url = parseUrl(raw);
      if (typeof url === "string") {
        results[index] = { url: label, ok: false, error: url };
        return;
      }
      const startedAt = Date.now();
      const carriesToken = isConfiguredOrigin(url, tokenOrigins);
      try {
        const opened = await openRequest({
          url,
          method,
          headers: { accept: "*/*", ...(carriesToken ? auth : {}) },
          signal: deadline.signal,
          cfg,
          credentialHeaders: secretHeaders,
        });
        // Drain under the cap rather than leaving the stream open: a probe
        // that never reads the body leaks a socket per endpoint.
        await readCapped(opened.res, maxBytes);
        const status = opened.res.status;
        results[index] = {
          url: redact(opened.finalUrl),
          ok: expected !== undefined ? expected.has(status) : status >= 200 && status < 300,
          status,
          latencyMs: Date.now() - startedAt,
          ...(token.token === "" ? {} : { authenticated: carriesToken }),
        };
      } catch (err) {
        results[index] = {
          url: label,
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: redact(describeFailure(err, deadline)),
        };
      }
    };

    try {
      // A fixed pool of workers pulling from a shared index: the concurrency
      // cap is a real bound on sockets in flight, not a batch size that would
      // let one slow endpoint idle the rest of its batch.
      let next = 0;
      const width = Math.min(input.concurrency ?? 4, input.urls.length);
      const workers = Array.from({ length: width }, async () => {
        while (true) {
          const index = next++;
          if (index >= input.urls.length) return;
          await probe(index);
        }
      });
      await Promise.all(workers);
    } finally {
      deadline.cancel();
    }

    const probes = [...results].sort((a, b) => byString(a.url, b.url));
    return json({
      probed: probes.length,
      healthy: probes.filter((p) => p.ok).length,
      unhealthy: probes.filter((p) => !p.ok && p.skipped !== true).length,
      skipped: probes.filter((p) => p.skipped === true).length,
      deadlineMs: input.deadlineMs,
      probes,
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const OBS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  alertAck,
  alertList,
  budgetCheck,
  costReport,
  errorCluster,
  eventCounts,
  eventQuery,
  healthProbe,
  incidentBundle,
  logsQuery,
  metricsQuery,
  runTimeline,
  sloEvaluate,
  statusPagePost,
  toolCallStats,
]);
