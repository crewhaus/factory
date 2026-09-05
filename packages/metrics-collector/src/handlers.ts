/**
 * Pure event-to-registry handler. Stateful only for `model_ttft_seconds`,
 * which needs to remember the timestamp of the most recent `model_request`
 * per traceId so the first `model_stream_token` can compute time-to-first-token.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import type { Registry } from "./registry";

/** Clamp a possibly-rogue grader score onto the histogram's 0..1 domain. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export class EventToMetrics {
  private readonly registry: Registry;
  /** traceId → ms timestamp of the most recent model_request that has not seen a token yet. */
  private readonly modelRequestStarts = new Map<string, number>();
  /** Tracks whether we already observed TTFT for the current model_request — only the first chunk counts. */
  private readonly modelTtftSeen = new Set<string>();

  constructor(registry: Registry) {
    this.registry = registry;
  }

  handle(ev: TraceEvent): void {
    switch (ev.kind) {
      case "turn_end":
        this.registry.turnsTotal.inc();
        this.registry.turnDurationSeconds.observe(ev.durationMs / 1000);
        return;
      case "tool_call_end":
        this.registry.toolCallsTotal.inc({ tool: ev.toolName });
        this.registry.toolDurationSeconds.observe(ev.durationMs / 1000, { tool: ev.toolName });
        return;
      case "model_request":
        this.modelRequestStarts.set(ev.traceId, Date.parse(ev.timestamp));
        this.modelTtftSeen.delete(ev.traceId);
        return;
      case "model_stream_token": {
        if (this.modelTtftSeen.has(ev.traceId)) return;
        const startMs = this.modelRequestStarts.get(ev.traceId);
        if (startMs === undefined) return;
        const tokenMs = Date.parse(ev.timestamp);
        if (Number.isNaN(tokenMs)) return;
        const ttftSec = Math.max(0, (tokenMs - startMs) / 1000);
        this.registry.modelTtftSeconds.observe(ttftSec);
        this.modelTtftSeen.add(ev.traceId);
        return;
      }
      case "model_response":
        this.registry.tokensTotal.inc({ direction: "in" }, ev.usage.input);
        this.registry.tokensTotal.inc({ direction: "out" }, ev.usage.output);
        // Clear tracking — the request is complete.
        this.modelRequestStarts.delete(ev.traceId);
        this.modelTtftSeen.delete(ev.traceId);
        return;
      case "error_recovered":
        this.registry.errorsTotal.inc({ kind: ev.errorName });
        return;
      case "cost_accrual":
        // G57 — meter per-call spend labeled by provider + model. Skip the
        // aggregate run-total accrual (`summary: true`, published by the
        // optimizer orchestrator) so it never double-counts the per-call
        // events it sums over. `unpriced` accruals carry a real token tally
        // but `costUsdMicros: 0`, so incrementing is a harmless no-op.
        if (ev.summary) return;
        // 0.6.0 (design §8.4) — labeled by the call's role too (absent ⇒
        // primary), so judge / shadow / compaction spend is separable.
        this.registry.costUsdMicrosTotal.inc(
          { provider: ev.provider, model: ev.modelId, role: ev.role ?? "primary" },
          ev.costUsdMicros,
        );
        return;
      // 0.6.0 (design §8.4) — one increment per pool routing decision. The
      // label set is fixed (`-` stands in for an absent scope/profile) so a
      // Prometheus `sum by (profile)` never splits on label presence.
      case "model_route":
        this.registry.modelRouteTotal.inc({
          scope: ev.scope ?? "-",
          routeKey: ev.routeKey,
          profile: ev.profile ?? "-",
          policy: ev.policy,
          explored: ev.explored === true ? "true" : "false",
        });
        return;
      // 0.6.0 (design §8.4) — escalations. A hybrid-strategy escalation stage
      // counts once, when it STARTS (its `done`/`failed` twin is the same
      // escalation); a fast-tier misroute recovery counts on its route.
      case "model_stage":
        if (ev.role === "escalation" && ev.outcome === "started") {
          this.registry.modelEscalationsTotal.inc({ source: "stage", strategy: ev.strategy });
        }
        return;
      case "model_tier_route":
        if (ev.escalated === true) {
          this.registry.modelEscalationsTotal.inc({ source: "tier", strategy: "tiers" });
        }
        return;
      // NEW-E-2 — in-loop quality. The `evaluation:` block emits one
      // `eval_graded` per grading pass (retries included) on cli / channel /
      // managed serving loops; nothing folded it, so live quality scores were
      // computed and then dropped for ops purposes. Labeled by grader type so
      // a judge-graded loop and a regex-graded one stay distinguishable.
      case "eval_graded":
        this.registry.evalVerdictsTotal.inc({ source: "in_loop", verdict: ev.verdict });
        this.registry.evalScore.observe(clamp01(ev.score), {
          source: "in_loop",
          grader: ev.graderType,
        });
        return;
      // NEW-E-2 — a `kind: judge` workflow step / graph node verdict.
      case "judge_verdict":
        this.registry.evalVerdictsTotal.inc({ source: "judge_step", verdict: ev.verdict });
        this.registry.evalScore.observe(clamp01(ev.score), { source: "judge_step" });
        return;
      // E51 — the eval runner's per-sample verdict (`test_verdict`), which a
      // run-level bus carries when the CLI attaches exporters to an offline
      // eval run. `skip` is an abstained sample, `error` an invoker failure —
      // both are counted so a dashboard's denominator matches the run's.
      case "test_verdict":
        this.registry.evalVerdictsTotal.inc({ source: "eval_sample", verdict: ev.verdict });
        return;
      // NEW-E-2 — human ratings, the third online quality channel. Thumbs
      // land as `up`/`down`; numeric ratings additionally feed the score
      // histogram normalized onto the same 0..1 scale as the graders' when
      // they are already in range (an out-of-range scale is counted but not
      // silently rescaled — we cannot know its maximum).
      case "response_rated": {
        const rating = typeof ev.rating === "number" ? String(ev.rating) : ev.rating;
        this.registry.responseRatingsTotal.inc({ source: ev.source ?? "unknown", rating });
        if (typeof ev.rating === "number" && ev.rating >= 0 && ev.rating <= 1) {
          this.registry.evalScore.observe(ev.rating, { source: "human_rating" });
        }
        return;
      }
      default:
        return;
    }
  }
}
