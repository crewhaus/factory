/**
 * Deterministic handoff rendering (design §2.2/§2.8): `handoff.md` is rebuilt
 * from store state at teardown with NO model call — same inputs, identical
 * bytes (the determinism is test-pinned). It renders what session 2 needs to
 * pick up: current focus, the active plan's steps with claimed-vs-proven
 * marked DISTINCTLY (a claim is never conflated with a machine-verified ✓),
 * open goals, unresolved requirements, derived next actions, and the last
 * session id.
 */
import type { Goal, PlanRecord, Requirement } from "./types";

export const HANDOFF_MARKER = "<!-- crewhaus:handoff -->";

export type HandoffInput = {
  readonly focusBody: string;
  readonly activePlan: PlanRecord | null;
  /** Every plan in the store (used for the "other open plans" section). */
  readonly plans: readonly PlanRecord[];
  readonly goals: readonly Goal[];
  readonly requirements: readonly Requirement[];
  readonly lastSessionId?: string;
};

const NONE = "_none_";

/** `[proven]` vs `[claimed — unverified]`: the ladder's two top rungs are
 *  never rendered alike (design §2.4). */
export function renderStatus(status: string): string {
  return status === "claimed" ? "[claimed — unverified]" : `[${status}]`;
}

function renderStepLine(step: PlanRecord["steps"][number]): string {
  const proofSuffix =
    step.status === "proven" && step.proofs.length > 0
      ? ` — proof: ${step.proofs.map((p) => `${p.toolUseId} (${p.sessionId})`).join(", ")}`
      : "";
  return `${step.index}. ${renderStatus(step.status)} ${step.text}${proofSuffix}`;
}

function planSummary(plan: PlanRecord): string {
  const proven = plan.steps.filter((s) => s.status === "proven").length;
  return `${plan.id} — ${plan.title} (${proven}/${plan.steps.length} steps proven)`;
}

function renderGoalLine(goal: Goal): string {
  const progress =
    goal.target !== undefined
      ? ` (${goal.current ?? 0}/${goal.target}${goal.unit !== undefined ? ` ${goal.unit}` : ""})`
      : "";
  return `- ${goal.id} ${renderStatus(goal.status)} ${goal.title}${progress}`;
}

function renderRequirementLine(req: Requirement): string {
  return `- ${req.id} [${req.status}] ${JSON.stringify(req.text)} (user, ${req.source.sessionId}, turn ${req.source.turn})`;
}

function nextActions(plan: PlanRecord | null): string[] {
  if (plan === null) return [];
  const actions: string[] = [];
  for (const step of plan.steps) {
    if (step.status === "claimed") {
      actions.push(
        `Verify or redo: ${step.text} (${plan.id} step ${step.index} is claimed but unproven)`,
      );
    }
  }
  for (const step of plan.steps) {
    if (step.status === "in_progress") {
      actions.push(`Continue: ${step.text} (${plan.id} step ${step.index})`);
    }
  }
  for (const step of plan.steps) {
    if (step.status === "open") {
      actions.push(`Do: ${step.text} (${plan.id} step ${step.index})`);
    }
  }
  return actions.slice(0, 5);
}

/** Pure renderer — no clock, no filesystem, no model. */
export function renderHandoff(input: HandoffInput): string {
  const lines: string[] = [HANDOFF_MARKER, "# Handoff", "", "## Focus", ""];
  lines.push(input.focusBody.trim() !== "" ? input.focusBody.trim() : "_no focus set_");

  lines.push("", "## Active plan", "");
  if (input.activePlan !== null) {
    lines.push(planSummary(input.activePlan), "");
    for (const step of input.activePlan.steps) {
      lines.push(renderStepLine(step));
    }
    if (input.activePlan.steps.length === 0) lines.push(NONE);
  } else {
    lines.push(NONE);
  }

  const others = input.plans.filter(
    (p) => p.id !== input.activePlan?.id && p.steps.some((s) => s.status !== "proven"),
  );
  if (others.length > 0) {
    lines.push("", "## Other open plans", "");
    for (const plan of others) lines.push(`- ${planSummary(plan)}`);
  }

  lines.push("", "## Goals", "");
  const openGoals = input.goals.filter((g) => g.status !== "proven");
  if (openGoals.length > 0) {
    for (const goal of openGoals) lines.push(renderGoalLine(goal));
  } else {
    lines.push(NONE);
  }

  lines.push("", "## Unresolved requirements", "");
  const unresolved = input.requirements.filter((r) => r.status === "open");
  if (unresolved.length > 0) {
    for (const req of unresolved) lines.push(renderRequirementLine(req));
  } else {
    lines.push(NONE);
  }

  lines.push("", "## Next actions", "");
  const actions = nextActions(input.activePlan);
  if (actions.length > 0) {
    actions.forEach((action, i) => lines.push(`${i + 1}. ${action}`));
  } else {
    lines.push(NONE);
  }

  lines.push("", "## Last session", "");
  lines.push(input.lastSessionId ?? "_unknown_");
  lines.push("");
  return lines.join("\n");
}
