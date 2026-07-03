/**
 * Ops item 38 — `crewhaus mcp doctor` core, in a side-effect-free module (this
 * entry file runs an argv switch on import) mirroring `doctor-checks.ts` /
 * `eval-matrix.ts`. Three capabilities, all pure — the CLI owns the file I/O
 * and the live `listTools` probe; this module does the aggregation + diffing:
 *
 *   1. HEALTH SCORING — fold the durable `mcp_stats` session-log records
 *      (`{ server, toolName, durationMs, isError }`, mirrored from the
 *      trace-bus-only `mcp_call_end` by runtime-core) into per-server
 *      error-rate + latency + a chronic-failure verdict. `mcp_call_*` events
 *      are trace-bus-ONLY, so this durable mirror is the only cross-session
 *      history there is to score.
 *
 *   2. DRIFT WATCH — snapshot each server's `listTools` (tool name + a stable
 *      JSON-schema hash) and diff it against the LAST snapshot on disk, so an
 *      added / removed / schema-changed tool is reported BEFORE a production
 *      call fails (tool lists are fetched once at connect today; drift is
 *      otherwise invisible until runtime failure).
 *
 *   3. QUARANTINE DECISION — decide which chronically-failing servers' tools
 *      should be withdrawn from the ToolCatalog (the runtime injects a synthetic
 *      "unavailable" notice so the model routes around them) and which have
 *      recovered enough to restore. The catalog mutation lives in the runtime /
 *      CLI; this module only decides.
 */
import { createHash } from "node:crypto";

// -------- 1. health scoring --------

/** One durable `mcp_stats` record's payload (what runtime-core persists). */
export type McpStatsPayload = {
  readonly server: string;
  readonly toolName: string;
  readonly durationMs: number;
  readonly isError: boolean;
};

/** Per-server rolled-up health over the scored session window. */
export type McpServerHealth = {
  readonly server: string;
  readonly calls: number;
  readonly errors: number;
  readonly errorRate: number;
  /** p50 / p95 call latency, ms (nearest-rank). */
  readonly p50Ms: number;
  readonly p95Ms: number;
  /** Longest run of CONSECUTIVE erroring calls — a reconnect-churn proxy, since
   *  the mcp client's reconnect events are Logger-only (not durable). */
  readonly maxErrorStreak: number;
  /** True when the server is chronically failing (see {@link QUARANTINE_POLICY}). */
  readonly chronic: boolean;
};

/** Thresholds a server must cross to be judged chronically failing → quarantine
 *  candidate. Kept together so the report and the quarantine decision agree. */
export const QUARANTINE_POLICY = {
  /** Minimum calls before an error rate is trustworthy (cold-start guard). */
  minCalls: 5,
  /** Error-rate ceiling; above it (with enough calls) the server is chronic. */
  errorRate: 0.5,
  /** OR: this many consecutive errors is chronic regardless of overall rate
   *  (a server that just went hard-down mid-session). */
  errorStreak: 4,
} as const;

/** Nearest-rank percentile (0-based floor). Empty ⇒ 0. */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

/**
 * Fold a flat stream of `mcp_stats` payloads (already read from session logs,
 * oldest-first) into per-server health. The `maxErrorStreak` is computed over
 * the input order, so callers should pass records in chronological order (the
 * session-log reader yields insertion order — which is chronological).
 */
export function scoreMcpHealth(records: ReadonlyArray<McpStatsPayload>): McpServerHealth[] {
  type Acc = {
    calls: number;
    errors: number;
    durations: number[];
    curStreak: number;
    maxStreak: number;
  };
  const byServer = new Map<string, Acc>();
  for (const r of records) {
    let acc = byServer.get(r.server);
    if (acc === undefined) {
      acc = { calls: 0, errors: 0, durations: [], curStreak: 0, maxStreak: 0 };
      byServer.set(r.server, acc);
    }
    acc.calls += 1;
    acc.durations.push(r.durationMs);
    if (r.isError) {
      acc.errors += 1;
      acc.curStreak += 1;
      if (acc.curStreak > acc.maxStreak) acc.maxStreak = acc.curStreak;
    } else {
      acc.curStreak = 0;
    }
  }
  const out: McpServerHealth[] = [];
  for (const [server, acc] of byServer) {
    const errorRate = acc.calls > 0 ? acc.errors / acc.calls : 0;
    const chronic = isChronic(acc.calls, errorRate, acc.maxStreak);
    out.push({
      server,
      calls: acc.calls,
      errors: acc.errors,
      errorRate,
      p50Ms: percentile(acc.durations, 0.5),
      p95Ms: percentile(acc.durations, 0.95),
      maxErrorStreak: acc.maxStreak,
      chronic,
    });
  }
  // Sickest first (chronic, then by error rate desc) so the report leads with
  // the servers that need attention.
  return out.sort((a, b) => {
    if (a.chronic !== b.chronic) return a.chronic ? -1 : 1;
    return b.errorRate - a.errorRate;
  });
}

/** Chronic-failure verdict shared by scoring + quarantine decision. */
export function isChronic(calls: number, errorRate: number, maxErrorStreak: number): boolean {
  if (maxErrorStreak >= QUARANTINE_POLICY.errorStreak) return true;
  return calls >= QUARANTINE_POLICY.minCalls && errorRate >= QUARANTINE_POLICY.errorRate;
}

// -------- 2. drift watch --------

/** A single tool as advertised by a server, for drift snapshotting. */
export type McpToolSnapshot = {
  readonly name: string;
  /** Stable hash of the tool's JSON-schema (order-insensitive). */
  readonly schemaHash: string;
};

/** The on-disk drift snapshot for one server (`.crewhaus/mcp/<server>.json`). */
export type McpServerSnapshot = {
  readonly version: 1;
  readonly server: string;
  readonly ts: string;
  readonly tools: ReadonlyArray<McpToolSnapshot>;
};

/**
 * Stable hash of a JSON-schema value: recursively sort object keys so
 * `{a,b}` and `{b,a}` hash identically, then sha256 the canonical form. A
 * server that reorders its schema keys between connects is NOT drift; a server
 * that changes a field's type IS. Returns the first 16 hex chars (collision-
 * safe enough for a per-tool change signal).
 */
export function schemaHash(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex").slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/** Build a fresh snapshot from a server's live `listTools` result. */
export function buildSnapshot(
  server: string,
  tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>,
  ts: string,
): McpServerSnapshot {
  return {
    version: 1,
    server,
    ts,
    tools: tools
      .map((t) => ({ name: t.name, schemaHash: schemaHash(t.inputSchema) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type McpDrift = {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  /** Tools present in both but whose schema hash changed. */
  readonly schemaChanged: ReadonlyArray<string>;
};

/** True when nothing changed. */
export function driftIsEmpty(drift: McpDrift): boolean {
  return drift.added.length === 0 && drift.removed.length === 0 && drift.schemaChanged.length === 0;
}

/**
 * Diff a previous snapshot against the current one. `previous` undefined (no
 * snapshot on disk yet) ⇒ empty drift (the current becomes the new baseline;
 * a first-ever connect is not "drift"). Added = in current not previous;
 * removed = in previous not current; schemaChanged = in both, different hash.
 */
export function diffSnapshots(
  previous: McpServerSnapshot | undefined,
  current: McpServerSnapshot,
): McpDrift {
  if (previous === undefined) return { added: [], removed: [], schemaChanged: [] };
  const prev = new Map(previous.tools.map((t) => [t.name, t.schemaHash]));
  const cur = new Map(current.tools.map((t) => [t.name, t.schemaHash]));
  const added: string[] = [];
  const removed: string[] = [];
  const schemaChanged: string[] = [];
  for (const [name, hash] of cur) {
    const prevHash = prev.get(name);
    if (prevHash === undefined) added.push(name);
    else if (prevHash !== hash) schemaChanged.push(name);
  }
  for (const name of prev.keys()) {
    if (!cur.has(name)) removed.push(name);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    schemaChanged: schemaChanged.sort(),
  };
}

// -------- 3. quarantine decision --------

export type QuarantineDecision = {
  /** Servers whose tools should be WITHDRAWN (chronic + not already out). */
  readonly quarantine: ReadonlyArray<string>;
  /** Servers whose tools should be RESTORED (were out, now healthy). */
  readonly restore: ReadonlyArray<string>;
};

/**
 * Decide catalog mutations from the current health + the set of servers whose
 * tools are ALREADY quarantined. A chronic server not yet quarantined →
 * quarantine; a quarantined server that is no longer chronic (its recent
 * window is healthy — e.g. a probe succeeded) → restore. A server absent from
 * `health` entirely (no recent calls) is left as-is: no signal either way.
 */
export function decideQuarantine(
  health: ReadonlyArray<McpServerHealth>,
  alreadyQuarantined: ReadonlyArray<string>,
): QuarantineDecision {
  const out = new Set(alreadyQuarantined);
  const byServer = new Map(health.map((h) => [h.server, h]));
  const quarantine: string[] = [];
  const restore: string[] = [];
  for (const h of health) {
    if (h.chronic && !out.has(h.server)) quarantine.push(h.server);
  }
  for (const server of out) {
    const h = byServer.get(server);
    if (h !== undefined && !h.chronic) restore.push(server);
  }
  return { quarantine: quarantine.sort(), restore: restore.sort() };
}

/**
 * The synthetic notice injected in place of a quarantined server's tools so the
 * model routes around them — mirrors loop-detection's warning injection. Kept
 * here so the report and the runtime injection render the identical text.
 */
export function quarantineNotice(server: string, reason: string): string {
  return `[mcp] tools from server "${server}" are temporarily unavailable (${reason}). Route around them; they auto-restore once the server is healthy again.`;
}

// -------- report rendering --------

/** Render the per-server health table lines for `crewhaus mcp doctor`. */
export function formatHealthReport(health: ReadonlyArray<McpServerHealth>): string[] {
  if (health.length === 0) {
    return ["no MCP call history yet — run the agent against its MCP servers first"];
  }
  const lines: string[] = ["per-server MCP health (from durable mcp_stats):"];
  for (const h of health) {
    const mark = h.chronic ? "✗" : h.errorRate > 0 ? "~" : "✓";
    lines.push(
      `  ${mark} ${h.server}: ${h.calls} call(s), ${(h.errorRate * 100).toFixed(1)}% errors, ` +
        `p50 ${Math.round(h.p50Ms)}ms / p95 ${Math.round(h.p95Ms)}ms, max error streak ${h.maxErrorStreak}` +
        `${h.chronic ? " — CHRONIC (quarantine candidate)" : ""}`,
    );
  }
  return lines;
}

/** Render the drift lines for one server. Empty array when no drift. */
export function formatDriftReport(server: string, drift: McpDrift): string[] {
  if (driftIsEmpty(drift)) return [];
  const lines: string[] = [`  drift on "${server}":`];
  if (drift.added.length > 0) lines.push(`    + added: ${drift.added.join(", ")}`);
  if (drift.removed.length > 0) lines.push(`    - removed: ${drift.removed.join(", ")}`);
  if (drift.schemaChanged.length > 0) {
    lines.push(`    ~ schema-changed: ${drift.schemaChanged.join(", ")}`);
  }
  return lines;
}
