/**
 * How the inbox is doing, measured from the records it already reads: open items by kind
 * with how long they have waited; how long decisions took, by kind and by the door they
 * came through; how many an agreement's fallback settled; how many asks were repeated
 * within 30 days. Local only, and pure: `now` is given. Every breakdown is an array of
 * rows, never an object keyed by a kind, so no row reaches a reader masked.
 */
import type {
  AttentionItem,
  AttentionOpenRow,
  AttentionResolutionRow,
  AttentionViaRow,
} from "@crewhaus/control-contract";
import { msOf } from "./items";
import type { MetricDecision } from "./types";

/** Two asks with one digest this close together count the later one as a re-ask. */
export const REASK_WINDOW_MS = 30 * 86_400_000;

export type AttentionMetricsBody = {
  readonly since: string;
  readonly asOf: string;
  readonly open: readonly AttentionOpenRow[];
  readonly resolution: readonly AttentionResolutionRow[];
  readonly resolutionByVia: readonly AttentionViaRow[];
  readonly fallbacks: number;
  readonly reasks: number;
};

/** The nearest-rank percentile of sorted values, or `null` for none. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

function rowsBy<T>(
  values: ReadonlyMap<string, number[]>,
  build: (key: string, n: number, p50: number | null, p90: number | null) => T,
): T[] {
  return [...values.keys()].sort().map((key) => {
    const list = [...(values.get(key) as number[])].sort((a, b) => a - b);
    return build(key, list.length, percentile(list, 50), percentile(list, 90));
  });
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function metricsOf(
  records: {
    readonly items: readonly AttentionItem[];
    readonly decisions: readonly MetricDecision[];
  },
  window: { readonly since: number; readonly now: number },
): AttentionMetricsBody {
  const { since, now } = window;
  const ages = new Map<string, number[]>();
  for (const item of records.items) {
    if (item.state !== "open" && item.state !== "assigned" && item.state !== "deferred") continue;
    const at = msOf(item.since);
    push(ages, item.kind, at === undefined ? 0 : Math.max(0, now - at));
  }
  const byKind = new Map<string, number[]>();
  const byVia = new Map<string, number[]>();
  let fallbacks = 0;
  for (const d of records.decisions) {
    const decided = msOf(d.decidedAt);
    const created = msOf(d.createdAt);
    if (decided === undefined || created === undefined) continue;
    if (decided < since || decided > now) continue;
    const took = Math.max(0, decided - created);
    push(byKind, d.kind, took);
    const via = d.resolvedBy === "policy" ? "policy" : (d.decidedVia ?? "unknown");
    push(byVia, via, took);
    if (d.resolvedBy === "policy") fallbacks++;
  }
  let reasks = 0;
  const asked = records.decisions
    .filter((d) => d.askDigest !== undefined && msOf(d.createdAt) !== undefined)
    .sort((a, b) => (msOf(a.createdAt) as number) - (msOf(b.createdAt) as number));
  const lastAsk = new Map<string, number>();
  for (const d of asked) {
    const at = msOf(d.createdAt) as number;
    const before = lastAsk.get(d.askDigest as string);
    if (before !== undefined && at - before <= REASK_WINDOW_MS && at >= since && at <= now)
      reasks++;
    lastAsk.set(d.askDigest as string, at);
  }
  return {
    since: new Date(since).toISOString(),
    asOf: new Date(now).toISOString(),
    open: rowsBy(ages, (kind, open, p50Ms, p90Ms) => ({ kind, open, p50Ms, p90Ms })),
    resolution: rowsBy(byKind, (kind, resolved, p50Ms, p90Ms) => ({
      kind,
      resolved,
      p50Ms,
      p90Ms,
    })),
    resolutionByVia: rowsBy(byVia, (decidedVia, resolved, p50Ms, p90Ms) => ({
      decidedVia,
      resolved,
      p50Ms,
      p90Ms,
    })),
    fallbacks,
    reasks,
  };
}

/** A window like `30d`, `12h` or `90m` in ms, or `undefined` for anything else. */
export function windowMs(text: string): number | undefined {
  const m = /^([1-9][0-9]{0,4})([dhm])$/.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n * (m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000);
}
