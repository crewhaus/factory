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

export type RegistryJsonSnapshot = {
  counters: Record<string, Array<{ labels: Labels; value: number }>>;
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

  prometheus(): string {
    return [
      this.turnsTotal.prometheus(),
      this.toolCallsTotal.prometheus(),
      this.tokensTotal.prometheus(),
      this.errorsTotal.prometheus(),
      this.turnDurationSeconds.prometheus(),
      this.toolDurationSeconds.prometheus(),
      this.modelTtftSeconds.prometheus(),
    ].join("\n");
  }

  jsonSnapshot(): RegistryJsonSnapshot {
    const counters: RegistryJsonSnapshot["counters"] = {};
    for (const c of [this.turnsTotal, this.toolCallsTotal, this.tokensTotal, this.errorsTotal]) {
      counters[c.name] = c.series().map((s) => ({ labels: s.labels, value: s.value }));
    }
    const histograms: RegistryJsonSnapshot["histograms"] = {};
    for (const h of [this.turnDurationSeconds, this.toolDurationSeconds, this.modelTtftSeconds]) {
      histograms[h.name] = h.series().map((s) => ({
        labels: s.labels,
        counts: s.counts,
        sum: s.sum,
        total: s.total,
        buckets: h.buckets,
      }));
    }
    return { counters, histograms };
  }
}
