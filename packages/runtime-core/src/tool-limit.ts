/**
 * provider-limits#0 — the boot check of the run's tool list against the
 * per-request limit of each model that can be sent it.
 *
 * The compiler checks the spec's builtin tools; this is the authoritative
 * check, because only the running loop knows the full list: the builtins plus
 * the loop's own tools (ListTools, continuity, memory, Task, Skill), MCP
 * server tools, plugin tools and the hybrid pair — and a `crewhaus run
 * --model` override the compiler never saw. It runs before the first model
 * call, so an over-long list costs a clear error instead of a provider 400
 * on every call (retried, then reported as "tombstone budget exhausted", or
 * for a fallback as "breaker open").
 *
 * Pure: the caller says which models can serve and how many tools each is
 * sent; the limits come from `@crewhaus/cost-tracker`, the table the
 * compiler reads.
 */
import {
  type ToolLimitOverrun,
  describeToolLimitOverrun,
  toolLimitOverrun,
} from "@crewhaus/cost-tracker";

/** One model that can be sent the run's tools, and how many it would be sent. */
export type ServingModel = {
  readonly model: string;
  readonly toolCount: number;
  /**
   * `serves` — the primary, a fallback, a tier or a pool candidate: a model
   * the run's calls go to. `degrade` — the budget degrade rung, which serves
   * only after spend, so it can never be the only way a run succeeds.
   */
  readonly role: "serves" | "degrade";
  /** How the boot line names it: "model_fallbacks[0] openai/gpt-4o", … */
  readonly label: string;
  /** What the run does about it when another model can serve: "routing leaves it out", … */
  readonly whenOver: string;
};

export type ToolLimitVerdict = {
  /** Set when no model that serves can accept its tools: the run cannot make one call. */
  readonly fatal?: string;
  /** One boot line per model over its limit, when some other model can serve. */
  readonly warnings: ReadonlyArray<string>;
};

/** Check every serving model's tool count against its provider's per-request limit. */
export function checkServingToolLimits(serving: ReadonlyArray<ServingModel>): ToolLimitVerdict {
  const overruns = new Map<ServingModel, ToolLimitOverrun>();
  for (const s of serving) {
    const o = toolLimitOverrun(s.model, s.toolCount);
    if (o !== undefined) overruns.set(s, o);
  }
  if (overruns.size === 0) return { warnings: [] };
  const servers = serving.filter((s) => s.role === "serves");
  const fix =
    "Narrow the tools (smaller all-<category> roll-ups, -<tool> exclusions, fewer MCP servers), or pick a model whose provider accepts more.";
  if (servers.length > 0 && servers.every((s) => overruns.has(s))) {
    const why = servers
      .map((s) => describeToolLimitOverrun(overruns.get(s) as ToolLimitOverrun, "the run's tools"))
      .join("; ");
    return { fatal: `${why}. ${fix}`, warnings: [] };
  }
  const warnings = [...overruns].map(
    ([s, o]) =>
      `${s.label}: ${describeToolLimitOverrun(o, "the run's tools")}; ${s.whenOver}. ${fix}`,
  );
  return { warnings };
}
