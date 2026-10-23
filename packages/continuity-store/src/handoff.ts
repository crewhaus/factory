/**
 * Deterministic handoff rendering (design §2.2/§2.8): `handoff.md` is rebuilt
 * from store state at teardown with NO model call — same inputs, identical
 * bytes (the determinism is test-pinned). It renders what session 2 needs to
 * pick up: current focus, the active plan's steps with claimed-vs-proven
 * marked DISTINCTLY (a claim is never conflated with a machine-verified ✓,
 * and a step proven without verification under `continuity.proof: off`
 * renders `[proven (unverified)]`, never `[proven]`), open goals, unresolved
 * requirements, derived next actions, and the last session id.
 *
 * What counts as done follows `continuity.proof` ({@link countsAsProven}):
 * under `require` a record proven by assertion, or with no frozen proof, is
 * still open — listed under Goals, named in Next actions — because that is
 * how the require tools treat it (design/0.8.0 §6.3). The ladder and `off`
 * render exactly as before.
 */
import type { FrozenProof } from "./evidence";
import type { Goal, PlanRecord, Requirement, UnverifiedRef } from "./types";

export const HANDOFF_MARKER = "<!-- crewhaus:handoff -->";

/**
 * `continuity.proof` (design §2.4, enforced from design/0.8.0 §6.3), as the
 * renders and the Thredz goal mirror read it: which `proven` records count as
 * done. Transitions never read it — the store applies no policy of its own,
 * and each call says how it verifies (`ProveOptions`); tool-plan's
 * `createPlanTools({proofMode})` is where the mode is enforced.
 */
export type ContinuityProofMode = "ladder" | "require" | "off";

export const CONTINUITY_PROOF_MODES: readonly ContinuityProofMode[] = ["ladder", "require", "off"];

export type HandoffInput = {
  readonly focusBody: string;
  readonly activePlan: PlanRecord | null;
  /** Every plan in the store (used for the "other open plans" section). */
  readonly plans: readonly PlanRecord[];
  readonly goals: readonly Goal[];
  readonly requirements: readonly Requirement[];
  readonly lastSessionId?: string;
  /** Default `"ladder"` — see {@link countsAsProven}. */
  readonly proofMode?: ContinuityProofMode;
};

const NONE = "_none_";

/** `[proven]` vs `[claimed — unverified]`: the ladder's two top rungs are
 *  never rendered alike (design §2.4). */
export function renderStatus(status: string): string {
  return status === "claimed" ? "[claimed — unverified]" : `[${status}]`;
}

/** The label a proven-by-assertion record renders with (design/0.8.0 §6.3):
 *  `continuity.proof: off` still says `proven`, but never the way a
 *  machine-checked `[proven]` says it. */
export const PROVEN_UNVERIFIED_LABEL = "[proven (unverified)]";

/**
 * True when a record's `proven` status came from a transition that skipped
 * verification (`continuity.proof: off`) — it carries the refs it cited as
 * {@link UnverifiedRef}s and no verified transition has superseded them.
 */
export function isProvenByAssertion(record: {
  readonly status: string;
  readonly unverified?: readonly UnverifiedRef[];
}): boolean {
  return record.status === "proven" && (record.unverified?.length ?? 0) > 0;
}

/**
 * True when a record's `proven` status is backed by machine-checked evidence
 * ON RECORD: not proven by assertion, and carrying at least one frozen proof.
 * Every verified transition freezes one, so a `proven` record with none was
 * written outside the store's API — a hand edit, or a step line that a
 * multi-line plan title smuggled into a plan file before titles were kept to
 * one line — and nothing checked it. Renders still show it as `[proven]`
 * (the ladder's bytes are unchanged), but `continuity.proof: require` counts
 * it below proven and an unverified transition may replace it (design/0.8.0
 * §6.3).
 */
export function isProvenVerified(record: {
  readonly status: string;
  readonly unverified?: readonly UnverifiedRef[];
  readonly proofs?: readonly FrozenProof[];
}): boolean {
  return (
    record.status === "proven" && !isProvenByAssertion(record) && (record.proofs?.length ?? 0) > 0
  );
}

/**
 * Whether a step or goal counts as DONE under a proof mode. Under the ladder
 * and `off` that is `status: "proven"` — a proof by assertion is what `off`
 * means by proven. Under `require` it is {@link isProvenVerified}: a record
 * proven by assertion (an earlier `off` run) or with no frozen proof is
 * below proven, so it completes nothing (tool-plan refuses it), the handoff
 * and the `<current_plan>` tail keep it open, and the Thredz mirror does not
 * complete its remote goal (design/0.8.0 §6.3). One rule, so the tools,
 * the renders and the mirror agree on what is done.
 */
export function countsAsProven(
  record: {
    readonly status: string;
    readonly unverified?: readonly UnverifiedRef[];
    readonly proofs?: readonly FrozenProof[];
  },
  proofMode: ContinuityProofMode = "ladder",
): boolean {
  return proofMode === "require" ? isProvenVerified(record) : record.status === "proven";
}

/**
 * {@link renderStatus} for a whole step or goal record: identical to it for
 * every record the ladder wrote, and {@link PROVEN_UNVERIFIED_LABEL} for one
 * proven by assertion — so "the log proves X ran" and "the model said X ran
 * and nobody checked" stay as distinct as claimed and proven (design §2.4,
 * design/0.8.0 §6.3).
 */
export function renderLadderStatus(record: {
  readonly status: string;
  readonly unverified?: readonly UnverifiedRef[];
}): string {
  return isProvenByAssertion(record) ? PROVEN_UNVERIFIED_LABEL : renderStatus(record.status);
}

/** `tu_x (sess_…)` — or the bare id when the citation named no session. */
export function renderUnverifiedRef(ref: UnverifiedRef): string {
  return ref.sessionId !== undefined ? `${ref.toolUseId} (${ref.sessionId})` : ref.toolUseId;
}

function renderStepLine(step: PlanRecord["steps"][number]): string {
  const proofSuffix = isProvenByAssertion(step)
    ? ` — cited, not verified: ${(step.unverified ?? []).map(renderUnverifiedRef).join(", ")}`
    : step.status === "proven" && step.proofs.length > 0
      ? ` — proof: ${step.proofs.map((p) => `${p.toolUseId} (${p.sessionId})`).join(", ")}`
      : "";
  return `${step.index}. ${renderLadderStatus(step)} ${step.text}${proofSuffix}`;
}

function planSummary(plan: PlanRecord, proofMode: ContinuityProofMode): string {
  const proven = plan.steps.filter((s) => countsAsProven(s, proofMode)).length;
  // Proven-by-assertion steps still count as proven under the ladder and
  // `off` (that is what `off` means), and not under `require`; either way
  // the summary says how many of them nobody checked. Absent on every
  // ladder plan, so its bytes are unchanged.
  const unverified = plan.steps.filter(isProvenByAssertion).length;
  const unverifiedNote = unverified > 0 ? `, ${unverified} unverified` : "";
  return `${plan.id} — ${plan.title} (${proven}/${plan.steps.length} steps proven${unverifiedNote})`;
}

function renderGoalLine(goal: Goal): string {
  const progress =
    goal.target !== undefined
      ? ` (${goal.current ?? 0}/${goal.target}${goal.unit !== undefined ? ` ${goal.unit}` : ""})`
      : "";
  return `- ${goal.id} ${renderLadderStatus(goal)} ${goal.title}${progress}`;
}

function renderRequirementLine(req: Requirement): string {
  return `- ${req.id} [${req.status}] ${JSON.stringify(req.text)} (user, ${req.source.sessionId}, turn ${req.source.turn})`;
}

function nextActions(plan: PlanRecord | null, proofMode: ContinuityProofMode): string[] {
  if (plan === null) return [];
  const actions: string[] = [];
  for (const step of plan.steps) {
    if (step.status === "claimed") {
      actions.push(
        `Verify or redo: ${step.text} (${plan.id} step ${step.index} is claimed but unproven)`,
      );
    } else if (step.status === "proven" && !countsAsProven(step, proofMode)) {
      // `require` only (design/0.8.0 §6.3): PlanComplete still owes this
      // step a verified proof, so it is unfinished work beside the claims.
      const label = isProvenByAssertion(step)
        ? "proven (unverified)"
        : "marked proven with no proof on record";
      actions.push(
        `Prove: ${step.text} (${plan.id} step ${step.index} is ${label}, not proven under continuity.proof: require)`,
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
  const proofMode = input.proofMode ?? "ladder";
  const lines: string[] = [HANDOFF_MARKER, "# Handoff", "", "## Focus", ""];
  lines.push(input.focusBody.trim() !== "" ? input.focusBody.trim() : "_no focus set_");

  lines.push("", "## Active plan", "");
  if (input.activePlan !== null) {
    lines.push(planSummary(input.activePlan, proofMode), "");
    for (const step of input.activePlan.steps) {
      lines.push(renderStepLine(step));
    }
    if (input.activePlan.steps.length === 0) lines.push(NONE);
  } else {
    lines.push(NONE);
  }

  const others = input.plans.filter(
    (p) => p.id !== input.activePlan?.id && p.steps.some((s) => !countsAsProven(s, proofMode)),
  );
  if (others.length > 0) {
    lines.push("", "## Other open plans", "");
    for (const plan of others) lines.push(`- ${planSummary(plan, proofMode)}`);
  }

  lines.push("", "## Goals", "");
  const openGoals = input.goals.filter((g) => !countsAsProven(g, proofMode));
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
  const actions = nextActions(input.activePlan, proofMode);
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
