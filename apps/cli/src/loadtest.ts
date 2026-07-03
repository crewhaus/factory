/**
 * Item 68 — `crewhaus loadtest <spec>`: drive a daemon-shape harness (managed
 * gateway / channel-bot / batch) under concurrent load and measure throughput,
 * p50/p95/p99 latency, error rate, and cost/req — with a `--gate` mode that
 * fails (exit 1) when p95 latency or error rate exceed declared thresholds (a
 * pre-deploy gate).
 *
 * Load is driven through an INJECTED `LoadDriver` — one async call per request
 * that returns a `RequestOutcome`. That seam makes the runner deterministic +
 * credential-free in tests (a stub driver returns canned latencies), while the
 * CLI wires a real driver: the managed gateway's in-process `handle()` behind a
 * stub/echo model, or the batch queue's consumer. No live server or provider
 * key is needed for the runner itself.
 *
 * Everything here is side-effect-free (the CLI entry file constructs the driver
 * + writes the report). The aggregation is pure: same outcomes → same report.
 */

/** Thrown on bad flags / driver misuse. The CLI routes it through `die()`. */
export class LoadtestError extends Error {
  override readonly name = "LoadtestError";
}

/** The result of one driven request. */
export type RequestOutcome = {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Token usage, when the driver knows it (for cost/req). */
  readonly tokens?: { input: number; output: number };
  /** A short classification when `ok` is false (e.g. "429", "timeout"). */
  readonly errorKind?: string;
};

/** The injected load driver: given a 0-based request index, drive ONE request
 *  and resolve with its outcome. Must not throw — a thrown error is caught and
 *  recorded as an errored request (errorKind "threw"). */
export type LoadDriver = (reqIndex: number) => Promise<RequestOutcome>;

export type LoadtestConfig = {
  /** Concurrent in-flight requests. Default 10. */
  readonly concurrency?: number;
  /** Total requests to send. Mutually informative with `durationMs`; when both
   *  are set, whichever bound is hit first ends the run. Default 100. */
  readonly requests?: number;
  /** Wall-clock budget (ms). When set, the run stops issuing new requests once
   *  elapsed ≥ durationMs (in-flight requests still drain). */
  readonly durationMs?: number;
  /** Target requests-per-second. When set, the runner paces request dispatch to
   *  approximately this rate (open-loop). Default: unthrottled (closed-loop). */
  readonly rps?: number;
  /** Price per 1M input / output tokens (USD) for the cost/req estimate. */
  readonly pricePerMInput?: number;
  readonly pricePerMOutput?: number;
  /** A monotonic clock (ms) — injected for deterministic tests. Default performance.now. */
  readonly now?: () => number;
  /** A sleep(ms) primitive — injected for deterministic tests (rps pacing). */
  readonly sleep?: (ms: number) => Promise<void>;
};

/** Gate thresholds — a run fails when any is exceeded. */
export type GateThresholds = {
  readonly maxP95LatencyMs?: number;
  readonly maxErrorRate?: number;
};

export type LoadtestReport = {
  readonly requests: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorRate: number;
  readonly wallClockMs: number;
  readonly throughputRps: number;
  readonly latency: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly min: number;
    readonly max: number;
    readonly mean: number;
  };
  readonly tokens: { input: number; output: number };
  /** USD per request (0 when pricing not supplied). */
  readonly costPerReqUsd: number;
  readonly totalCostUsd: number;
  /** Breakdown of error kinds → count. */
  readonly errorKinds: Readonly<Record<string, number>>;
};

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_REQUESTS = 100;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank on a pre-sorted array.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Run a concurrent load test against the injected driver. Dispatches up to
 * `concurrency` requests in flight until the request budget (or duration) is
 * exhausted, then drains. Deterministic given a deterministic driver + clock.
 */
export async function runLoadtest(
  driver: LoadDriver,
  config: LoadtestConfig = {},
): Promise<LoadtestReport> {
  const concurrency = Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY);
  const maxRequests = config.requests ?? DEFAULT_REQUESTS;
  if (maxRequests < 1) throw new LoadtestError("requests must be ≥ 1");
  const now = config.now ?? (() => performance.now());
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const durationMs = config.durationMs;
  const rps = config.rps;

  const outcomes: RequestOutcome[] = [];
  let dispatched = 0;
  const startedAt = now();

  const shouldStop = (): boolean => {
    if (dispatched >= maxRequests) return true;
    if (durationMs !== undefined && now() - startedAt >= durationMs) return true;
    return false;
  };

  // Open-loop pacing: the interval between dispatches for the target rps.
  const dispatchIntervalMs = rps !== undefined && rps > 0 ? 1000 / rps : 0;

  async function worker(): Promise<void> {
    while (!shouldStop()) {
      const idx = dispatched;
      dispatched += 1;
      if (dispatchIntervalMs > 0) {
        // Pace dispatch toward the target rps. Each of the `concurrency` workers
        // waits `concurrency / rps` seconds between its own dispatches, so the
        // aggregate dispatch rate across all workers approximates `rps`.
        await sleep(dispatchIntervalMs * concurrency);
      }
      let outcome: RequestOutcome;
      try {
        outcome = await driver(idx);
      } catch (err) {
        outcome = {
          ok: false,
          latencyMs: 0,
          errorKind: err instanceof Error ? err.name || "threw" : "threw",
        };
      }
      outcomes.push(outcome);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  const wallClockMs = Math.max(0, now() - startedAt);
  return aggregateLoadtest(outcomes, {
    wallClockMs,
    ...(config.pricePerMInput !== undefined ? { pricePerMInput: config.pricePerMInput } : {}),
    ...(config.pricePerMOutput !== undefined ? { pricePerMOutput: config.pricePerMOutput } : {}),
  });
}

/**
 * Aggregate raw outcomes into a report. Pure — exported so tests can assert on
 * percentile math without driving a run, and so the CLI can re-aggregate a
 * persisted outcome set.
 */
export function aggregateLoadtest(
  outcomes: readonly RequestOutcome[],
  opts: { wallClockMs: number; pricePerMInput?: number; pricePerMOutput?: number },
): LoadtestReport {
  const requests = outcomes.length;
  const succeeded = outcomes.filter((o) => o.ok).length;
  const failed = requests - succeeded;
  // Latency percentiles over SUCCESSFUL requests (a failed 429 at 1ms would
  // otherwise flatter the tail).
  const latencies = outcomes
    .filter((o) => o.ok)
    .map((o) => o.latencyMs)
    .sort((a, b) => a - b);
  const sumLatency = latencies.reduce((acc, l) => acc + l, 0);
  const tokens = outcomes.reduce(
    (acc, o) => ({
      input: acc.input + (o.tokens?.input ?? 0),
      output: acc.output + (o.tokens?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );
  const errorKinds: Record<string, number> = {};
  for (const o of outcomes) {
    if (!o.ok) {
      const kind = o.errorKind ?? "error";
      errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    }
  }
  const priceIn = opts.pricePerMInput ?? 0;
  const priceOut = opts.pricePerMOutput ?? 0;
  const totalCostUsd =
    (tokens.input / 1_000_000) * priceIn + (tokens.output / 1_000_000) * priceOut;

  return {
    requests,
    succeeded,
    failed,
    errorRate: requests === 0 ? 0 : failed / requests,
    wallClockMs: opts.wallClockMs,
    throughputRps: opts.wallClockMs > 0 ? (requests / opts.wallClockMs) * 1000 : 0,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      min: latencies[0] ?? 0,
      max: latencies[latencies.length - 1] ?? 0,
      mean: latencies.length === 0 ? 0 : sumLatency / latencies.length,
    },
    tokens,
    costPerReqUsd: requests === 0 ? 0 : totalCostUsd / requests,
    totalCostUsd,
    errorKinds,
  };
}

/** The gate verdict — which thresholds (if any) were breached. */
export type GateVerdict = {
  readonly passed: boolean;
  readonly breaches: readonly string[];
};

/** Evaluate a report against gate thresholds. Empty thresholds → always passes. */
export function evaluateGate(report: LoadtestReport, thresholds: GateThresholds): GateVerdict {
  const breaches: string[] = [];
  if (thresholds.maxP95LatencyMs !== undefined && report.latency.p95 > thresholds.maxP95LatencyMs) {
    breaches.push(
      `p95 latency ${report.latency.p95.toFixed(1)}ms > ${thresholds.maxP95LatencyMs}ms`,
    );
  }
  if (thresholds.maxErrorRate !== undefined && report.errorRate > thresholds.maxErrorRate) {
    breaches.push(
      `error rate ${(report.errorRate * 100).toFixed(1)}% > ${(thresholds.maxErrorRate * 100).toFixed(1)}%`,
    );
  }
  return { passed: breaches.length === 0, breaches };
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(6)}`;
}

/** Render a plain-text loadtest report. */
export function renderLoadtestText(report: LoadtestReport, verdict?: GateVerdict): string {
  const lines: string[] = [];
  lines.push("loadtest:");
  lines.push(
    `  requests:    ${report.requests} (${report.succeeded} ok / ${report.failed} failed, ${(report.errorRate * 100).toFixed(1)}% error rate)`,
  );
  lines.push(
    `  throughput:  ${report.throughputRps.toFixed(1)} req/s over ${report.wallClockMs.toFixed(0)}ms`,
  );
  lines.push(
    `  latency:     p50 ${report.latency.p50.toFixed(1)}ms · p95 ${report.latency.p95.toFixed(1)}ms · p99 ${report.latency.p99.toFixed(1)}ms (min ${report.latency.min.toFixed(1)} / max ${report.latency.max.toFixed(1)})`,
  );
  lines.push(
    `  tokens:      ${report.tokens.input} in / ${report.tokens.output} out; cost/req ${fmtUsd(report.costPerReqUsd)}; total ${fmtUsd(report.totalCostUsd)}`,
  );
  const kinds = Object.entries(report.errorKinds);
  if (kinds.length > 0) {
    lines.push(`  errors:      ${kinds.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (verdict !== undefined) {
    lines.push(verdict.passed ? "  gate:        PASS" : "  gate:        FAIL");
    for (const b of verdict.breaches) lines.push(`    ! ${b}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render an HTML loadtest report (self-contained). */
export function renderLoadtestHtml(report: LoadtestReport, verdict?: GateVerdict): string {
  const gateRow =
    verdict === undefined
      ? ""
      : `<tr><th>Gate</th><td>${verdict.passed ? "PASS" : `FAIL — ${verdict.breaches.map((b) => b.replace(/</g, "&lt;")).join("; ")}`}</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Loadtest report</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:.4rem .7rem;text-align:left}th{background:#f5f5f5}</style>
</head><body>
<h1>Loadtest report</h1>
<table>
<tr><th>Requests</th><td>${report.requests} (${report.succeeded} ok / ${report.failed} failed)</td></tr>
<tr><th>Error rate</th><td>${(report.errorRate * 100).toFixed(1)}%</td></tr>
<tr><th>Throughput</th><td>${report.throughputRps.toFixed(1)} req/s</td></tr>
<tr><th>Latency p50 / p95 / p99</th><td>${report.latency.p50.toFixed(1)} / ${report.latency.p95.toFixed(1)} / ${report.latency.p99.toFixed(1)} ms</td></tr>
<tr><th>Cost / req</th><td>${fmtUsd(report.costPerReqUsd)}</td></tr>
${gateRow}
</table>
</body></html>
`;
}
