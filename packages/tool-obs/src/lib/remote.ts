/**
 * Shaping what a monitoring platform sends back.
 *
 * Pure functions over an already-parsed response body, so the parsing rules
 * are testable without a socket. The network itself lives in `../net.ts`.
 *
 * The design rule for the whole remote half: NO VENDOR IS HARD-CODED except
 * the one open standard. `MetricsQuery` speaks the Prometheus HTTP API because
 * that API is implemented by Prometheus, Thanos, Cortex, Mimir, VictoriaMetrics
 * and Grafana's own endpoint — it is a format, not a product. Everything else
 * (logs, alerts, status pages) is addressed through paths and field names the
 * SPEC supplies, because those genuinely differ per vendor and a tool that
 * guessed would be wrong for every deployment but one.
 */
import { asRecord, byString } from "./events";

/** Read a dotted path out of a parsed body; `undefined` when it is not there. */
export function pluck(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path === "") return value;
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

/**
 * A JSON body, or a readable refusal carrying the first of it.
 *
 * The excerpt is capped hard: a monitoring platform behind a captive portal
 * returns a whole HTML login page, and pasting that into a transcript is the
 * unhelpful version of "the response was not JSON".
 */
export function parseJsonBody(
  text: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const excerpt = text.slice(0, 200).replace(/\s+/g, " ").trim();
    return {
      ok: false,
      message: `the response was not JSON (${(err as Error).message}); it began: ${excerpt || "<empty>"}`,
    };
  }
}

export type MetricSample = {
  /** Epoch SECONDS, as the Prometheus API expresses time. */
  readonly t: number;
  /** The value as sent — a string, because `NaN`, `+Inf` and full float
   *  precision all survive as text and none of them survive `Number`. */
  readonly v: string;
};

export type MetricSeries = {
  readonly labels: Readonly<Record<string, string>>;
  /** Stable identity for the label set: `k="v"` pairs, keys sorted. */
  readonly seriesKey: string;
  readonly samples: readonly MetricSample[];
  /** True when the per-series sample cap cut this series short. */
  readonly truncated: boolean;
};

export type MetricsResult = {
  readonly resultType: string;
  readonly series: readonly MetricSeries[];
  readonly seriesReturned: number;
  readonly seriesTotal: number;
  /** Warnings the server attached to the query, verbatim. */
  readonly warnings: readonly string[];
};

/** `{a="1",b="2"}` with keys sorted — the identity two runs can compare. */
export function seriesKey(labels: Readonly<Record<string, string>>): string {
  const inner = Object.keys(labels)
    .sort(byString)
    .map((k) => `${k}=${JSON.stringify(labels[k] ?? "")}`)
    .join(",");
  return `{${inner}}`;
}

function labelsOf(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record === undefined) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort(byString)) {
    const raw = record[key];
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

/** One `[timestamp, "value"]` pair as the Prometheus API sends it. */
function sampleOf(value: unknown): MetricSample | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const t = value[0];
  const v = value[1];
  if (typeof t !== "number" || !Number.isFinite(t)) return undefined;
  return { t, v: typeof v === "string" ? v : String(v) };
}

/**
 * Shape a Prometheus `data` object into sorted series.
 *
 * Series come back in whatever order the server's index produced them, which
 * is not stable across replicas; they are re-sorted here by `seriesKey` so the
 * same query against the same data returns the same bytes. Samples are left in
 * the server's order, which for a range query is ascending by time and is the
 * only order that means anything.
 */
export function shapeMetrics(
  data: unknown,
  maxSeries: number,
  maxSamplesPerSeries: number,
  warnings: readonly string[] = [],
): MetricsResult | string {
  const record = asRecord(data);
  if (record === undefined)
    return "the response carried no `data` object — this does not look like a Prometheus-style API";
  const resultType = typeof record["resultType"] === "string" ? record["resultType"] : "unknown";
  const raw = record["result"];
  if (!Array.isArray(raw)) {
    return `the response's data.result was not an array (resultType "${resultType}") — a scalar or string query result is not supported`;
  }

  const series: MetricSeries[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (item === undefined) continue;
    const labels = labelsOf(item["metric"]);
    const values: MetricSample[] = [];
    let truncated = false;
    const single = sampleOf(item["value"]);
    if (single !== undefined) {
      values.push(single);
    } else if (Array.isArray(item["values"])) {
      for (const v of item["values"] as unknown[]) {
        if (values.length >= maxSamplesPerSeries) {
          truncated = true;
          break;
        }
        const sample = sampleOf(v);
        if (sample !== undefined) values.push(sample);
      }
    }
    series.push({ labels, seriesKey: seriesKey(labels), samples: values, truncated });
  }
  series.sort((a, b) => byString(a.seriesKey, b.seriesKey));

  return {
    resultType,
    series: series.slice(0, maxSeries),
    seriesReturned: Math.min(series.length, maxSeries),
    seriesTotal: series.length,
    warnings: [...warnings].map(String),
  };
}

/**
 * The array of records a generic platform returned, bounded and projected.
 *
 * `fields`, when given, keeps only those keys — a log platform returns the
 * whole document per hit, and one verbose field can be the entire context
 * window. When it is not given, every value is stringified and cut to
 * `maxFieldChars`, which bounds the same risk without the caller having to
 * know the schema first.
 */
export function shapeRecords(
  value: unknown,
  limit: number,
  maxFieldChars: number,
  fields?: readonly string[],
):
  | {
      readonly records: readonly Record<string, string>[];
      readonly total: number;
      readonly truncated: boolean;
    }
  | string {
  if (!Array.isArray(value)) {
    return "the configured result_path did not point at an array — check the `result_path` in the obs tool_config block against what this platform returns";
  }
  const cut = (text: string): string =>
    text.length > maxFieldChars ? `${text.slice(0, maxFieldChars)}…` : text;
  const records: Record<string, string>[] = [];
  for (const entry of value) {
    if (records.length >= limit) break;
    const record = asRecord(entry);
    if (record === undefined) {
      records.push({ value: cut(JSON.stringify(entry) ?? "null") });
      continue;
    }
    const keys = (fields !== undefined ? fields : Object.keys(record)).slice().sort(byString);
    const out: Record<string, string> = {};
    for (const key of keys) {
      const raw = record[key];
      if (raw === undefined) continue;
      out[key] = cut(typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "null"));
    }
    records.push(out);
  }
  return { records, total: value.length, truncated: value.length > records.length };
}
