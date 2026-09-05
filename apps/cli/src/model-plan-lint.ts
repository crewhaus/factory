/**
 * 0.6.0 (design plan §10.1, last bullet; §4.3) — the spec-level
 * model-plan checks shared by `crewhaus lint` and
 * `crewhaus doctor --philosophy-alignment`:
 *
 *   1. `model-plan:self-judge` — a POOLED or strategy block whose judge is one
 *      of its own serving arms. A model grading its own output is the single
 *      biggest measurement flaw in the stack (§4.3), so the warning fires on
 *      every pooled spec — including a 0.5.8-shaped one whose in-loop judge
 *      silently defaults to the serving model — and `allow_self_judge: true`
 *      silences it for the in-loop grader. WARNING: a 0.5.8-valid spec must
 *      keep compiling (the compiler's own `model-plan-self-judge` note covers
 *      only specs that opted into `models:` / `strategy`).
 *   2. `model-plan:profile-tools` — a `models:` profile whose `tools` is not a
 *      subset of the shape's RESOLVED toolset. The spec layer can only check
 *      against tools a block declares, and the `modelPlanIntegrity` ir-pass
 *      checks pool CANDIDATES; a profile that no candidate references, or a
 *      shape whose toolset is the emitter's default, is what this catches.
 *      WARNING (the profile may be intended for another shape's slot).
 *   3. `model-plan:roster-ref` — a strategy role slot, a rule target, the
 *      floor arm, a judge gate's `escalate_to`, or a sub-agent
 *      `allowed_profiles` entry that names no roster member / declared
 *      profile. The spec cross-field checks and the ir-pass refuse these at
 *      parse / lower time; this is the DRIFT GUARD that keeps refusing them
 *      from the lowered IR should either layer ever be relaxed. ERROR.
 *
 * The fourth §10.1 check — a Consult / guide / verifier reply path without
 * `classifyBoundary` + `tagContent` — is a CODEBASE check and lives in
 * doctor's boundary-site audit (it reads source, not a spec).
 *
 * Pure: a function of the parsed spec and the lowered IR, no I/O, so both
 * commands and the tests share one implementation.
 */
import type {
  IrCrewRole,
  IrGraphNode,
  IrModelPool,
  IrModelProfiles,
  IrModelTiers,
  IrNode,
  IrSubAgentDefinition,
  IrWorkflowStep,
} from "@crewhaus/ir";

export type ModelPlanFinding = {
  readonly message: string;
  /** Dot-joined spec location. */
  readonly path: string;
  readonly severity: "error" | "warning";
  readonly rule: "model-plan:self-judge" | "model-plan:profile-tools" | "model-plan:roster-ref";
};

/** The routing surface every agent-like IR block carries. */
type RoutedBlock = {
  readonly model: string;
  readonly modelPool?: IrModelPool;
  readonly modelTiers?: IrModelTiers;
  readonly tools?: readonly string[];
};

/** A candidate's arm identity: its profile name, else its model string (§7.9). */
function armIdOf(c: IrModelPool["candidates"][number]): string {
  return c.profile ?? c.model;
}

/** Every model that may SERVE a block's turns: primary, tiers, pool candidates. */
function servingModels(block: RoutedBlock): Set<string> {
  const out = new Set<string>([block.model]);
  for (const c of block.modelPool?.candidates ?? []) out.add(c.model);
  if (block.modelTiers !== undefined) {
    out.add(block.modelTiers.fast);
    out.add(block.modelTiers.default);
  }
  return out;
}

function selfJudge(path: string, judgeModel: string, gated: string): ModelPlanFinding {
  return {
    rule: "model-plan:self-judge",
    severity: "warning",
    path,
    message: `${path}: the judge model "${judgeModel}" is also ${gated} — a model grading its own output is a measurement-integrity hazard; point the judge at a stronger, independent model (or set evaluation.allow_self_judge: true to accept it)`,
  };
}

/** The strategy's judge slots (committee judge, shadow grader) against the pool's own arms. */
function strategyJudgeFindings(path: string, pool: IrModelPool): ModelPlanFinding[] {
  const out: ModelPlanFinding[] = [];
  const arms = new Set(pool.candidates.map((c) => c.model));
  const judge = pool.strategy?.committee?.judge;
  if (judge !== undefined && arms.has(judge)) {
    out.push(
      selfJudge(`${path}.model_pool.strategy.committee.judge`, judge, "a committee member arm"),
    );
  }
  const gradeWith = pool.strategy?.shadow?.gradeWith;
  if (gradeWith !== undefined && arms.has(gradeWith)) {
    out.push(
      selfJudge(
        `${path}.model_pool.strategy.shadow.grade_with`,
        gradeWith,
        "a serving arm of this pool",
      ),
    );
  }
  return out;
}

/** The roster references inside one pool: role slots, rule targets, the floor. */
function rosterRefFindings(path: string, pool: IrModelPool): ModelPlanFinding[] {
  const out: ModelPlanFinding[] = [];
  const tags = new Set<string>();
  const arms = new Set<string>();
  for (const c of pool.candidates) {
    for (const t of c.tags) tags.add(t);
    arms.add(armIdOf(c));
  }
  const check = (slot: string, value: string | undefined): void => {
    if (value === undefined || tags.has(value) || arms.has(value)) return;
    out.push({
      rule: "model-plan:roster-ref",
      severity: "error",
      path: `${path}.model_pool.${slot}`,
      message: `${path}.model_pool.${slot}: "${value}" is neither a candidate tag (${[...tags].join(", ") || "none"}) nor a roster arm (${[...arms].join(", ")}) of this model_pool — a strategy role, rule target or floor arm must name a roster member`,
    });
  };
  pool.rules?.forEach((rule, i) => {
    if (typeof rule.use === "string") check(`rules[${i}].use`, rule.use);
  });
  const st = pool.strategy;
  check("strategy.cascade.draft", st?.cascade?.draft);
  check("strategy.cascade.escalate_to", st?.cascade?.escalateTo);
  st?.committee?.members.forEach((m, i) => check(`strategy.committee.members[${i}]`, m));
  check("strategy.committee.escalate_on_disagreement", st?.committee?.escalateOnDisagreement);
  check("reward.floor.arm", pool.reward?.floor?.arm);
  return out;
}

/** `allowed_profiles` entries the registry does not declare. */
function subAgentFindings(
  path: string,
  subAgents: ReadonlyArray<IrSubAgentDefinition> | undefined,
  registry: IrModelProfiles | undefined,
): ModelPlanFinding[] {
  const out: ModelPlanFinding[] = [];
  for (const sa of subAgents ?? []) {
    sa.allowedProfiles?.forEach((opt, i) => {
      if (registry?.[opt.profile] !== undefined) return;
      out.push({
        rule: "model-plan:roster-ref",
        severity: "error",
        path: `${path}.sub_agents.${sa.name}.allowed_profiles[${i}]`,
        message: `${path}.sub_agents.${sa.name}.allowed_profiles[${i}]: "$${opt.profile}" is not a declared models: profile${registry === undefined ? " (this spec declares no models: block)" : ` (declared: ${Object.keys(registry).join(", ")})`} — the Task tool's profile argument is validated against the registry`,
      });
    });
    if (sa.modelPool !== undefined) {
      out.push(...rosterRefFindings(`${path}.sub_agents.${sa.name}`, sa.modelPool));
    }
  }
  return out;
}

/** A judge gate (workflow step / graph node) against the block(s) it gates. */
function judgeGateFindings(
  path: string,
  gate: { readonly model: string; readonly judge?: IrWorkflowStep["judge"] },
  gated: ReadonlyArray<RoutedBlock & { readonly name: string }>,
): ModelPlanFinding[] {
  const out: ModelPlanFinding[] = [];
  const judges = [gate.model, ...(gate.judge?.judges ?? [])];
  for (const block of gated) {
    if (block.modelPool === undefined) continue; // §10.1: pooled or strategy blocks only
    const serving = servingModels(block);
    const hit = judges.find((j) => serving.has(j));
    if (hit !== undefined) {
      out.push(
        selfJudge(`${path}.judge.model`, hit, `a serving arm of the gated block "${block.name}"`),
      );
      break;
    }
  }
  const escalateTo = gate.judge?.escalateTo;
  if (escalateTo !== undefined) {
    const pools = gated.flatMap((b) => (b.modelPool !== undefined ? [b.modelPool] : []));
    const known = new Set<string>();
    for (const pool of pools) {
      for (const c of pool.candidates) {
        for (const t of c.tags) known.add(t);
        known.add(armIdOf(c));
      }
    }
    if (!known.has(escalateTo)) {
      out.push({
        rule: "model-plan:roster-ref",
        severity: "error",
        path: `${path}.judge.escalate_to`,
        message: `${path}.judge.escalate_to: "${escalateTo}" is not a candidate tag or arm of the gated block's model_pool (${[...known].join(", ") || "no pool declared"}) — the retry_previous re-run is forced onto a roster member`,
      });
    }
  }
  return out;
}

/** The blocks whose resolved toolsets a profile's `tools` must fit inside. */
function shapeToolsets(ir: IrNode): { catalog: boolean; tools: Set<string> } {
  const tools = new Set<string>();
  const add = (list: readonly string[] | undefined): void => {
    for (const t of list ?? []) tools.add(t.toLowerCase());
  };
  switch (ir.target) {
    case "cli":
    case "channel":
    case "research":
    case "batch":
    case "browser":
      add(ir.tools);
      return { catalog: true, tools };
    case "managed":
      add(ir.tools ?? []);
      return { catalog: true, tools };
    case "workflow":
      for (const s of ir.steps) add(s.tools);
      return { catalog: true, tools };
    case "graph":
      for (const n of ir.nodes) add(n.tools);
      return { catalog: true, tools };
    case "crew":
      for (const r of ir.roles) add(r.tools);
      return { catalog: true, tools };
    default:
      return { catalog: false, tools };
  }
}

function profileToolFindings(ir: IrNode): ModelPlanFinding[] {
  const registry = (ir as { readonly models?: IrModelProfiles }).models;
  if (registry === undefined) return [];
  const { catalog, tools } = shapeToolsets(ir);
  const out: ModelPlanFinding[] = [];
  for (const [name, profile] of Object.entries(registry)) {
    if (profile.tools === undefined) continue;
    if (!catalog) {
      out.push({
        rule: "model-plan:profile-tools",
        severity: "warning",
        path: `models.${name}.tools`,
        message: `models.${name}.tools: the ${ir.target} shape registers no tool catalog, so a per-model tools list has nothing to narrow — it is ignored on this shape`,
      });
      continue;
    }
    // MCP globs, Consult / Escalate are validated by the spec layer and the
    // ir-pass against `mcp_servers` / `strategy.model_directed`; here only the
    // builtin subset question is asked.
    const strays = profile.tools.filter(
      (t) =>
        !t.startsWith("mcp__") &&
        t !== "Consult" &&
        t !== "Escalate" &&
        !tools.has(t.toLowerCase()),
    );
    if (strays.length === 0) continue;
    out.push({
      rule: "model-plan:profile-tools",
      severity: "warning",
      path: `models.${name}.tools`,
      message: `models.${name}.tools: ${strays.map((t) => `"${t}"`).join(", ")} ${strays.length === 1 ? "is" : "are"} not among the shape's resolved tools (${[...tools].join(", ") || "none"}) — a per-model tools list can only narrow the shape's toolset, never add to it; the runtime advertises the intersection`,
    });
  }
  return out;
}

/**
 * Run the three spec-level model-plan checks over a lowered IR (every fact
 * they need — resolved `$refs`, arm ids, the resolved toolset, the
 * `allow_self_judge` waiver — is on the IR). Findings carry stable rule ids
 * and dot-joined SPEC paths.
 */
export function auditModelPlan(ir: IrNode): ModelPlanFinding[] {
  const out: ModelPlanFinding[] = [];
  const registry = (ir as { readonly models?: IrModelProfiles }).models;
  out.push(...profileToolFindings(ir));

  const pooledBlock = (path: string, block: RoutedBlock): void => {
    if (block.modelPool === undefined) return;
    out.push(...strategyJudgeFindings(path, block.modelPool));
    out.push(...rosterRefFindings(path, block.modelPool));
  };

  switch (ir.target) {
    case "cli":
    case "channel":
    case "managed": {
      pooledBlock("agent", ir.agent);
      out.push(
        ...subAgentFindings("agent", ir.target === "managed" ? undefined : ir.subAgents, registry),
      );
      const ev = ir.evaluation;
      if (
        ir.agent.modelPool !== undefined &&
        ev !== undefined &&
        ev.grader.type === "llm_judge" &&
        ev.allowSelfJudge !== true
      ) {
        const serving = servingModels(ir.agent);
        // No declared judge ⇒ the emitters default it to the serving model.
        const judges = ev.grader.judges ?? [ev.grader.model ?? ir.agent.model];
        const hit = judges.find((j) => serving.has(j));
        if (hit !== undefined) {
          out.push(
            selfJudge(
              "evaluation.grader.model",
              hit,
              ev.grader.model === undefined && ev.grader.judges === undefined
                ? "a serving arm of agent.model / model_pool (no judge model is declared, so the judge defaults to the serving model)"
                : "a serving arm of agent.model / model_pool",
            ),
          );
        }
      }
      return out;
    }
    case "pipeline":
    case "research":
    case "batch":
    case "browser":
      pooledBlock("agent", ir.agent);
      return out;
    case "workflow": {
      ir.steps.forEach((step, i) => {
        const path = `steps[${i}]`;
        if (step.kind === "judge") {
          const gated = ir.steps[i - 1];
          out.push(
            ...judgeGateFindings(
              path,
              step,
              gated !== undefined && gated.kind !== "judge" ? [gated] : [],
            ),
          );
          return;
        }
        pooledBlock(path, step);
      });
      return out;
    }
    case "graph": {
      const byName = new Map<string, IrGraphNode>(ir.nodes.map((n) => [n.name, n]));
      for (const node of ir.nodes) {
        const path = `nodes.${node.name}`;
        if (node.kind === "judge") {
          const upstream = ir.edges
            .filter((e) => e.to === node.name)
            .map((e) => byName.get(e.from))
            .filter((n): n is IrGraphNode => n !== undefined && n.kind !== "judge");
          out.push(...judgeGateFindings(path, node, upstream));
          continue;
        }
        pooledBlock(path, node);
      }
      return out;
    }
    case "crew": {
      for (const role of ir.roles as ReadonlyArray<IrCrewRole>) {
        const path = `roles.${role.name}`;
        pooledBlock(path, role);
        out.push(...subAgentFindings(path, role.subAgents, registry));
      }
      return out;
    }
    default:
      return out;
  }
}
