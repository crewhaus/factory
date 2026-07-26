/**
 * E51 — offline eval results reach the configured exporters.
 *
 * BEFORE: `runEval` published a per-sample `test_verdict` on each sample's
 * OWN fresh `RunContext` bus (run-sample.ts's documented "OTel exporters can
 * route verdicts to a verdict dashboard" comment), and nothing ever
 * subscribed to those buses — the eval CLI never constructed a run context,
 * and the per-sample chat loop's env-gated subscribers are shut down BEFORE
 * grading, so even with `OTEL_EXPORTER_OTLP_ENDPOINT` set the verdict landed
 * on a dead bus. Run summaries (pass rate / mean score / cost / flakes /
 * needs-human) were never emitted at all.
 *
 * NOW: the eval CLI mints ONE run-level `RunContext`, attaches the SAME
 * env-gated subscribers every serving loop uses (`attachDefaultSubscribers`
 * — OTLP through `@crewhaus/otel-exporter`, metrics through
 * `@crewhaus/metrics-collector`'s registry + sinks), republishes each
 * sample's verdict onto that live bus, records the run summary onto the
 * metrics registry, and flushes AFTER the last verdict.
 *
 * EXPORTER SCOPE (do not overstate this). `attachDefaultSubscribers` attaches
 * the PRINTER, the METRICS COLLECTOR and the GENERIC OTLP EXPORTER — and
 * nothing else. The vendor packages (`@crewhaus/exporter-datadog`,
 * `-honeycomb`, `-newrelic`, `-splunk`) wrap the same otel-exporter span
 * mapping, so eval verdicts DO map into their span shape, but they are
 * programmatic surfaces: `attachDatadogIfEnvSet` and friends have no caller
 * anywhere in the repo, so `DD_API_KEY` alone exports nothing — from an eval
 * run OR from serving. Point `OTEL_EXPORTER_OTLP_ENDPOINT` /
 * `OTEL_EXPORTER_OTLP_HEADERS` at the vendor's OTLP intake, or call the
 * vendor attach yourself from an embedding process.
 *
 * Three contracts this module holds to:
 *
 *  1. PRESENCE-GATED. With neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor a
 *     parseable `CREWHAUS_METRICS` set, {@link attachEvalTelemetry} returns
 *     `undefined` and the eval path does exactly what it did before — no
 *     context minted, no bus, no subscriber, zero overhead.
 *  2. NARROWED ENV. Only the exporter-relevant keys are forwarded to
 *     `attachDefaultSubscribers`, so turning on an exporter can never also
 *     turn on the pretty printer / inline cost lines / alert watchdog for an
 *     eval run and change what the operator sees on stdout.
 *  3. NEVER FAILS THE RUN. Every call is wrapped: a broken collector, an
 *     unreachable endpoint, or a throwing sink is logged to stderr once and
 *     the eval continues. Telemetry is never load-bearing for a measurement.
 */
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import type { AttachDefaultSubscribersOptions } from "@crewhaus/runtime-core";
import { attachDefaultSubscribers as defaultAttach } from "@crewhaus/runtime-core";

// runtime-core exports `attachDefaultSubscribers` but not its return type by
// name; derive it rather than editing the keystone package's barrel.
type AttachedSubscribers = Awaited<ReturnType<typeof defaultAttach>>;

/** The env keys that select an exporter. Nothing else is forwarded. */
const EXPORTER_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "CREWHAUS_METRICS",
] as const;

export type EvalRunSummaryMetrics = {
  readonly specName: string;
  readonly datasetName: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  readonly errorCount: number;
  readonly flakyCount?: number;
  readonly needsHumanCount?: number;
  readonly costUsd?: number;
};

export type EvalTelemetry = {
  /** The run-level context the subscribers are attached to. */
  readonly runContext: RunContext;
  /**
   * Republish each graded sample's verdict onto the live run bus as a
   * `test_verdict` event — the kind `run-sample` already publishes (and the
   * kind `otel-exporter` already maps to a first-class span), now with a
   * subscriber actually listening.
   */
  publishSampleVerdicts(summary: EvalRunSummary): void;
  /** Record the run's headline figures onto the metrics registry. */
  recordRunSummary(summary: EvalRunSummaryMetrics): void;
  /** Flush + shut every subscriber down. Never throws. */
  finish(): Promise<void>;
};

export type AttachEvalTelemetryOptions = {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — the subscriber attach function (default: runtime-core's). */
  readonly attach?: typeof defaultAttach;
  /** Test seam — where a telemetry failure is reported (default: stderr). */
  readonly warn?: (line: string) => void;
  /** Forwarded verbatim to `attachDefaultSubscribers`. */
  readonly options?: AttachDefaultSubscribersOptions;
};

/** True when at least one exporter is configured in `env`. */
export function evalTelemetryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const otlp = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (typeof otlp === "string" && otlp.trim() !== "") return true;
  const metrics = env["CREWHAUS_METRICS"];
  return typeof metrics === "string" && metrics.trim() !== "";
}

function narrowEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of EXPORTER_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Attach the exporter subscribers to a fresh run-level context, or return
 * `undefined` when no exporter is configured (the zero-overhead default).
 * A failure to attach is reported and swallowed — never fatal.
 */
export async function attachEvalTelemetry(
  opts: AttachEvalTelemetryOptions = {},
): Promise<EvalTelemetry | undefined> {
  const env = opts.env ?? process.env;
  if (!evalTelemetryConfigured(env)) return undefined;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const attach = opts.attach ?? defaultAttach;

  const runContext = createRunContext();
  let subscribers: AttachedSubscribers;
  try {
    subscribers = await attach(runContext.eventBus, runContext, narrowEnv(env), opts.options ?? {});
  } catch (err) {
    warn(`[eval] telemetry disabled: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const guard = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      warn(`[eval] telemetry ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    runContext,
    publishSampleVerdicts(summary: EvalRunSummary): void {
      guard("verdict publish", () => {
        const bus = runContext.eventBus;
        for (const sample of summary.samples) {
          const overall = sample.grades.overall;
          bus.publish({
            ...bus.envelope(),
            // The envelope carries the CLI's synthetic run-level session id,
            // which matches nothing a backend has seen. Overwrite it with the
            // SAMPLE's own session id — the same id the per-sample chat loop
            // already exported its model/tool spans under — so a failing
            // `test_verdict.fail` span joins the transcript that produced it
            // instead of needing a `crewhaus.test.id` string match. runId /
            // traceId stay run-level: one eval run is one trace.
            sessionId: sample.sessionId,
            kind: "test_verdict",
            testId: sample.sampleId,
            // Mirror run-sample's own mapping: an invoker error is `error`,
            // an abstained sample is `skip` (needs-human, not a graded fail),
            // otherwise the combined verdict.
            verdict:
              sample.error !== undefined
                ? "error"
                : overall.abstained === true
                  ? "skip"
                  : overall.passed
                    ? "pass"
                    : "fail",
            ...(overall.rationale !== undefined ? { reason: overall.rationale } : {}),
            durationMs: sample.latencyMs,
          });
        }
      });
    },
    recordRunSummary(summary: EvalRunSummaryMetrics): void {
      guard("run summary", () => {
        const registry = subscribers.metrics?.registry;
        if (registry === undefined) return;
        // Structural call into the metrics registry the attach result already
        // hands back — no direct dependency on `@crewhaus/metrics-collector`
        // from the CLI, and no new event kind invented for a figure that only
        // exists after the last per-sample event.
        const labels = { spec: summary.specName, dataset: summary.datasetName };
        registry.evalRunsTotal.inc(labels);
        registry.evalRunPassRate.set(summary.passRate, labels);
        registry.evalRunMeanScore.set(summary.meanScore, labels);
        registry.evalRunSamples.set(summary.sampleCount, labels);
        registry.evalRunErrors.set(summary.errorCount, labels);
        registry.evalRunFlakySamples.set(summary.flakyCount ?? 0, labels);
        registry.evalRunNeedsHuman.set(summary.needsHumanCount ?? 0, labels);
        if (summary.costUsd !== undefined) {
          registry.evalRunCostUsdMicros.set(Math.round(summary.costUsd * 1_000_000), labels);
        }
      });
    },
    async finish(): Promise<void> {
      // Flush AFTER the last verdict/summary (the whole point of E51 — the
      // old path shut its subscribers down before grading), then shut down.
      try {
        await subscribers.flushAll();
      } catch (err) {
        warn(`[eval] telemetry flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await subscribers.shutdownAll();
      } catch (err) {
        warn(
          `[eval] telemetry shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/**
 * Project an {@link EvalRunSummary} (plus the CLI's separately-computed cost)
 * into the metrics summary. Kept beside the attach so the field mapping —
 * notably "flake count" meaning C34's `aggregates.flaky`, and "needs human"
 * meaning A3's abstention bucket — lives in one reviewable place.
 */
export function evalRunSummaryMetrics(
  summary: EvalRunSummary,
  extra: { readonly specName: string; readonly costUsd?: number },
): EvalRunSummaryMetrics {
  const a = summary.aggregates;
  return {
    specName: extra.specName,
    datasetName: summary.config.datasetName,
    passRate: a.passRate,
    meanScore: a.meanScore,
    sampleCount: summary.samples.length,
    errorCount: a.errorCount,
    ...(a.flaky !== undefined ? { flakyCount: a.flaky } : {}),
    ...(a.needsHuman !== undefined ? { needsHumanCount: a.needsHuman } : {}),
    ...(extra.costUsd !== undefined ? { costUsd: extra.costUsd } : {}),
  };
}
