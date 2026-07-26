/**
 * Counter + histogram primitives. Deliberately dependency-free so the
 * package stays small; we render Prometheus exposition format ourselves
 * rather than pulling `prom-client`.
 */

export type Labels = Record<string, string>;

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(",");
}

function formatLabelString(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}=${JSON.stringify(labels[k])}`).join(",")}}`;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.values.set(key, { labels: { ...labels }, value: by });
    }
  }

  /** Snapshot for serialization. */
  series(): ReadonlyArray<{ labels: Labels; value: number }> {
    return Array.from(this.values.values());
  }

  prometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${formatLabelString(labels)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: ReadonlyArray<number>;
  private readonly state = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; total: number }
  >();

  constructor(name: string, help: string, buckets: ReadonlyArray<number> = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let entry = this.state.get(key);
    if (!entry) {
      entry = {
        labels: { ...labels },
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        total: 0,
      };
      this.state.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      const upper = this.buckets[i];
      if (upper === undefined) continue;
      if (value <= upper) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    }
    entry.sum += value;
    entry.total += 1;
  }

  series(): ReadonlyArray<{
    labels: Labels;
    counts: ReadonlyArray<number>;
    sum: number;
    total: number;
  }> {
    return Array.from(this.state.values());
  }

  prometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, total } of this.state.values()) {
      // Per-bucket counts are already stored cumulatively in `observe`.
      for (let i = 0; i < this.buckets.length; i += 1) {
        const bucketLabels = { ...labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${formatLabelString(bucketLabels)} ${counts[i] ?? 0}`);
      }
      lines.push(`${this.name}_bucket${formatLabelString({ ...labels, le: "+Inf" })} ${total}`);
      lines.push(`${this.name}_sum${formatLabelString(labels)} ${sum}`);
      lines.push(`${this.name}_count${formatLabelString(labels)} ${total}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/**
 * E51 — a last-write-wins gauge. Counters and histograms cannot express "the
 * pass rate of the run that just finished": a rate is neither monotonic nor a
 * distribution over observations. One gauge series per (spec, dataset) label
 * set, exactly like Prometheus's own gauge semantics.
 */
export class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  /** Snapshot for serialization. */
  series(): ReadonlyArray<{ labels: Labels; value: number }> {
    return Array.from(this.values.values());
  }

  prometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${formatLabelString(labels)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export type RegistryJsonSnapshot = {
  counters: Record<string, Array<{ labels: Labels; value: number }>>;
  /** E51 — gauge series (eval run summaries). Absent-safe for older readers. */
  gauges: Record<string, Array<{ labels: Labels; value: number }>>;
  histograms: Record<
    string,
    Array<{
      labels: Labels;
      counts: ReadonlyArray<number>;
      sum: number;
      total: number;
      buckets: ReadonlyArray<number>;
    }>
  >;
};

export class Registry {
  readonly turnsTotal = new Counter("crewhaus_turns_total", "Total user turns processed");
  readonly toolCallsTotal = new Counter(
    "crewhaus_tool_calls_total",
    "Total tool invocations by name",
  );
  readonly tokensTotal = new Counter(
    "crewhaus_tokens_total",
    "Total model tokens by direction (in/out)",
  );
  readonly errorsTotal = new Counter("crewhaus_errors_total", "Total recovered errors by kind");
  // Loop contract 0.4 (Batch C, G57) — labeled cost counter fed by the
  // `cost_accrual` trace events cost-tracker emits (one per `model_response`).
  // Labeled by `provider` + `model` so a Prometheus scrape can break spend
  // down per provider/model. Microdollars (1e-6 USD) to stay integer-valued —
  // the same unit `CostAccrualEvent.costUsdMicros` and audit-log carry, so a
  // dashboard divides by 1e6 once. Per-call accruals only: the aggregate
  // run-total accrual (`summary: true`) is skipped so it never double-counts.
  readonly costUsdMicrosTotal = new Counter(
    "crewhaus_cost_usd_micros_total",
    "Total model spend in microdollars (1e-6 USD) by provider and model",
  );
  readonly turnDurationSeconds = new Histogram(
    "crewhaus_turn_duration_seconds",
    "Wall-clock duration of one user turn",
  );
  readonly toolDurationSeconds = new Histogram(
    "crewhaus_tool_duration_seconds",
    "Wall-clock duration of one tool execution",
  );
  readonly modelTtftSeconds = new Histogram(
    "crewhaus_model_ttft_seconds",
    "Time to first streamed token after model_request",
  );

  // ---- E51 / NEW-E-2: evaluation quality signal --------------------------
  // Online (in-loop `evaluation:` grades, judge step/node verdicts) AND
  // offline (per-sample eval verdicts) quality land here, distinguished by
  // the `source` label — `in_loop` / `judge_step` / `eval_sample` — so one
  // dashboard can trend live quality beside the last gated run without the
  // two being confused for each other.
  readonly evalVerdictsTotal = new Counter(
    "crewhaus_eval_verdicts_total",
    "Evaluation verdicts by source and verdict",
  );
  readonly evalScore = new Histogram(
    "crewhaus_eval_score",
    "Evaluation scores in [0,1] by source",
    // Scores are a 0..1 quality scale, not a latency — the default
    // second-oriented buckets would pile every observation into `le=0.005`.
    [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  );
  readonly responseRatingsTotal = new Counter(
    "crewhaus_response_ratings_total",
    "Human response ratings by source and rating",
  );

  // ---- E51: offline eval RUN summaries (gauges, last run wins) ------------
  readonly evalRunsTotal = new Counter(
    "crewhaus_eval_runs_total",
    "Completed eval runs by spec and dataset",
  );
  readonly evalRunPassRate = new Gauge(
    "crewhaus_eval_run_pass_rate",
    "Pass rate of the most recent eval run, by spec and dataset",
  );
  readonly evalRunMeanScore = new Gauge(
    "crewhaus_eval_run_mean_score",
    "Mean score of the most recent eval run, by spec and dataset",
  );
  readonly evalRunSamples = new Gauge(
    "crewhaus_eval_run_samples",
    "Sample count of the most recent eval run, by spec and dataset",
  );
  readonly evalRunErrors = new Gauge(
    "crewhaus_eval_run_errors",
    "Errored samples in the most recent eval run, by spec and dataset",
  );
  readonly evalRunFlakySamples = new Gauge(
    "crewhaus_eval_run_flaky_samples",
    "Samples whose repeat trials disagreed in the most recent eval run",
  );
  readonly evalRunNeedsHuman = new Gauge(
    "crewhaus_eval_run_needs_human",
    "Samples routed to human review in the most recent eval run",
  );
  readonly evalRunCostUsdMicros = new Gauge(
    "crewhaus_eval_run_cost_usd_micros",
    "Estimated spend of the most recent eval run in microdollars (1e-6 USD)",
  );

  // Explicit (otherwise-default) constructor. The class-field initializers
  // above are folded into it; declaring it explicitly keeps every class in
  // this module on the same shape so Bun's coverage instrumenter attributes
  // the field-initialization to a single, exercised function rather than an
  // implicit `<instance_members_initializer>` thunk it counts but never marks
  // as entered (which otherwise pins this file at 16/17 = 94% function
  // coverage despite 100% line coverage and every method being exercised).
  // biome-ignore lint/complexity/noUselessConstructor: needed for accurate Bun function-coverage attribution; see comment above.
  constructor() {}

  private allCounters(): ReadonlyArray<Counter> {
    return [
      this.turnsTotal,
      this.toolCallsTotal,
      this.tokensTotal,
      this.errorsTotal,
      this.costUsdMicrosTotal,
      this.evalVerdictsTotal,
      this.responseRatingsTotal,
      this.evalRunsTotal,
    ];
  }

  private allHistograms(): ReadonlyArray<Histogram> {
    return [
      this.turnDurationSeconds,
      this.toolDurationSeconds,
      this.modelTtftSeconds,
      this.evalScore,
    ];
  }

  private allGauges(): ReadonlyArray<Gauge> {
    return [
      this.evalRunPassRate,
      this.evalRunMeanScore,
      this.evalRunSamples,
      this.evalRunErrors,
      this.evalRunFlakySamples,
      this.evalRunNeedsHuman,
      this.evalRunCostUsdMicros,
    ];
  }

  prometheus(): string {
    return [
      ...this.allCounters().map((c) => c.prometheus()),
      ...this.allHistograms().map((h) => h.prometheus()),
      ...this.allGauges().map((g) => g.prometheus()),
    ].join("\n");
  }

  jsonSnapshot(): RegistryJsonSnapshot {
    const counters: RegistryJsonSnapshot["counters"] = {};
    for (const c of this.allCounters()) {
      counters[c.name] = c.series().map((s) => ({ labels: s.labels, value: s.value }));
    }
    const histograms: RegistryJsonSnapshot["histograms"] = {};
    for (const h of this.allHistograms()) {
      histograms[h.name] = h.series().map((s) => ({
        labels: s.labels,
        counts: s.counts,
        sum: s.sum,
        total: s.total,
        buckets: h.buckets,
      }));
    }
    const gauges: RegistryJsonSnapshot["gauges"] = {};
    for (const g of this.allGauges()) {
      gauges[g.name] = g.series().map((s) => ({ labels: s.labels, value: s.value }));
    }
    return { counters, gauges, histograms };
  }
}
