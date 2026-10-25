/**
 * v0.3.0 Goal 1 — `tool-plan` (design §2.4/§2.6, PR 7). RegisteredTools over
 * `@crewhaus/continuity-store`, packaged like `tool-memory`: one factory
 * bound to a spec name, returning tools the caller registers into the
 * runtime catalog.
 *
 * The tool table (product-DX §2.6 + proof ladder §2.4):
 *
 *   FocusRead    readOnly     — current focus, active plan pointer, REQ ledger
 *   FocusWrite   destructive  — the hot loop: audit-and-allow, deliberately
 *                               NO requireJustification (a judge call per
 *                               routine focus update would drown the loop)
 *   PlanRead     readOnly
 *   PlanUpdate   destructive  — create plans/steps, ladder moves UP TO
 *                               `claimed`, active-plan pointer; audit-and-allow
 *   PlanComplete destructive  — the `proven` transition: requires
 *                               evidence [{toolUseId}], machine-checked
 *                               against session event logs (child sessions
 *                               included); rejects teach, never bluff
 *   GoalWrite    destructive
 *   GoalUpdate   destructive  — `proven` requires evidence, like steps
 *   GoalList     readOnly
 *   MemoryClear  destructive + requireJustification — clears via trash
 *                               (never hard-deletes); the intent gate is the
 *                               brake on model-initiated forgetting
 *
 * Events: mutations emit the additive event-log kinds `plan_update`,
 * `goal_update`, and `action_proof {planId, step, toolUseId, verdict}`
 * through an INJECTED `appendEvent` seam — this package never imports
 * runtime wiring, so emitters/memory-service decide where events land.
 * Rejected proof attempts emit `action_proof` too (verdict `missing` /
 * `error_result`): the audit trail records proof pressure, not just wins.
 *
 * Proof modes (`continuity.proof`, design §2.4; enforced from 0.8.0,
 * design/0.8.0-provability-release.md §6.3) — `createPlanTools({proofMode})`:
 *
 *   ladder  (default) the proof behaviour above, unchanged from before
 *           0.8.0: `claimed` is free, `proven` needs verified evidence, and
 *           the tool descriptions are the pre-0.8.0 strings.
 *   require the ladder, plus: nothing below `proven` COMPLETES anything.
 *           `claimed` stays settable — it is honest progress — but the
 *           tools refuse every operation that would mark a goal achieved
 *           while it is below `proven`. The store has exactly one such
 *           path: a goal whose progress (`current`, 0 when unset) reaches
 *           its `target` (the Thredz mirror completes a goal on
 *           `currentValue >= targetValue`), so GoalWrite/GoalUpdate refuse
 *           that unless the same call proves the goal — GoalUpdate through
 *           a store guard evaluated under the store lock, so concurrent
 *           sessions cannot each pass a stale check. Plans have no close
 *           operation: a plan is complete exactly when every step is
 *           proven, which only PlanComplete's verified path reaches — so a
 *           claimed step leaves the plan open, and the tools say which
 *           steps still need proof. A record proven by assertion under an
 *           earlier `off` run counts as below `proven` here, and so does a
 *           `proven` record with no frozen proof (the store never writes one;
 *           see `verifiedProven`). The `<current_plan>` tail, handoff.md and
 *           the Thredz goal mirror count such a record the same way
 *           (continuity-store's `countsAsProven`): open, and not completed.
 *   off     no verification, for harnesses that keep no session event log
 *           to resolve evidence against. PlanComplete / GoalUpdate `proven`
 *           still demand cited toolUseIds (one token each, see the store's
 *           `UNVERIFIED_TOOL_USE_ID_REGEX`), record them as UNVERIFIED refs
 *           (never frozen proofs) and pin no session for retention.
 *           PlanComplete emits `action_proof` with `verdict: "unverified"`;
 *           GoalUpdate marks its `goal_update` `verification: "unverified"`
 *           (`action_proof` is keyed by plan step). Every tool render says
 *           `[proven (unverified)]`, never `[proven]`.
 *
 * In EVERY mode, the ladder included (0.8.0, continuity-store's "one line
 * per record"): a plan or goal title, and a goal unit, is stored as one line
 * — every whitespace run, newlines included, collapses to one space and the
 * ends are trimmed, as step text always was — and a title over 512
 * characters (`MAX_TITLE_CHARS`) or a unit over 64 (`MAX_UNIT_CHARS`) is
 * refused with nothing written. Before 0.8.0 the store only trimmed a title
 * and kept a unit as given, so a multi-line title could carry a forged
 * `[proven]` step line into a plan file, which defeated `require`. These caps, and a GoalUpdate title
 * that is only whitespace (refused as GoalWrite's and PlanUpdate's always
 * were), are the input the default mode now refuses that it used to accept.
 *
 * Pillar 3: plan/focus/ledger content is user-authored working state
 * (origin "user" semantics, like tool-memory writes) — recalled wiki/fact
 * content is what gets the new `memory` TrustOrigin, not this. All tools are
 * `scope: "internal"` (process-local files only).
 */
import {
  type ContinuityScope,
  type ContinuityStore,
  EvidenceError,
  type EvidenceRef,
  type Goal,
  type PlanRecord,
  type Requirement,
  type UpdateGoalInput,
  createContinuityStore,
  isProvenByAssertion,
  isProvenVerified,
  renderLadderStatus,
  renderUnverifiedRef,
} from "@crewhaus/continuity-store";
import type {
  ActionProofEventPayload,
  GoalUpdateEventPayload,
  PlanUpdateEventPayload,
} from "@crewhaus/event-log";
import { type RunContext, formatAgentIdentity } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { z } from "zod";

/** The three additive event kinds this package emits (event-log union). */
export type ContinuityEventKind = "plan_update" | "goal_update" | "action_proof";

export type ContinuityEvent =
  | { readonly kind: "plan_update"; readonly payload: PlanUpdateEventPayload }
  | { readonly kind: "goal_update"; readonly payload: GoalUpdateEventPayload }
  | { readonly kind: "action_proof"; readonly payload: ActionProofEventPayload };

/**
 * The injected append seam: typically wired to the session event log's
 * `append` (and/or the trace bus) by the emitter or memory-service — kept as
 * a callback so this package stays decoupled from runtime-core. Should not
 * throw; a throwing sink fails the tool call loudly rather than dropping
 * audit events silently.
 */
export type AppendContinuityEvent = (event: ContinuityEvent) => void | Promise<void>;

/**
 * v0.3.0 §2.5 seam — the per-run state-store key plan-mutating tools flip
 * (through `ToolExecuteContext.bridge.runState`, when the runtime wires one)
 * so runtime-core re-renders the volatile `<current_plan>` tail before the
 * next model call. Deliberately a duplicated literal: this package never
 * imports runtime wiring, and runtime-core exports the same literal as its
 * own `PLAN_DIRTY_STATE_KEY`; the runtime-core continuity suite pins the
 * end-to-end round trip (a real PlanUpdate execute → the loop's dirty-check
 * → tail re-render), so a drift in either literal fails tests.
 */
export const PLAN_DIRTY_STATE_KEY = "plan.dirty";

/** Structural view of `RuntimeBridge.runState` — no runtime-core import. */
type RunStateLike = { set(partial: Record<string, unknown>): void };

/**
 * `continuity.proof` (design §2.4, enforced from design/0.8.0 §6.3) — how the
 * tools treat the `proven` rung. See the module docblock for each mode.
 */
export type ProofMode = "ladder" | "require" | "off";

export const PROOF_MODES: readonly ProofMode[] = ["ladder", "require", "off"];

/** The lowered default, and the only behaviour before 0.8.0. */
export const DEFAULT_PROOF_MODE: ProofMode = "ladder";

/**
 * Thrown under `proofMode: "require"` by an operation that would complete
 * something below `proven`. The message teaches the proven path — the
 * model's next call should be the proof, not a retry of the same claim.
 */
export class ProofRequiredError extends Error {
  override readonly name = "ProofRequiredError";
}

export type CreatePlanToolsOptions = {
  readonly specName: string;
  readonly rootDir?: string;
  readonly scope?: ContinuityScope;
  /** Where session `.jsonl` logs live (proof verification). */
  readonly sessionRootDir?: string;
  /** Fallback session for evidence refs when the runtime context carries no
   *  sessionId (refs and `ctx.runContext.sessionId` take precedence). */
  readonly sessionId?: string;
  /** Inject a custom store implementation for tests. */
  readonly store?: ContinuityStore;
  /** Event-log append seam — see `AppendContinuityEvent`. */
  readonly appendEvent?: AppendContinuityEvent;
  readonly now?: () => Date;
  /** `continuity.proof` — default {@link DEFAULT_PROOF_MODE} (`"ladder"`). */
  readonly proofMode?: ProofMode;
};

export type PlanToolBundle = {
  readonly focusRead: RegisteredTool;
  readonly focusWrite: RegisteredTool;
  readonly planRead: RegisteredTool;
  readonly planUpdate: RegisteredTool;
  readonly planComplete: RegisteredTool;
  readonly goalWrite: RegisteredTool;
  readonly goalUpdate: RegisteredTool;
  readonly goalList: RegisteredTool;
  readonly memoryClear: RegisteredTool;
  /** Every tool above, registration-ready. */
  readonly all: readonly RegisteredTool[];
  /** Exposed for direct inspection (tests, CLI verbs). */
  readonly store: ContinuityStore;
};

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

const planIdSchema = z
  .string()
  .regex(/^plan-\d{4}$/)
  .describe("Plan id, e.g. plan-0001.");
const optionalPlanIdSchema = planIdSchema
  .optional()
  .describe("Plan id, e.g. plan-0001. Omit to use the active plan.");

const focusReadSchema = z.object({});

const focusWriteSchema = z.object({
  focus: z
    .string()
    .min(1)
    .describe(
      "The new focus body: what you are working on right now and the next actions. Short — hard-capped at focusMaxChars (default 4096).",
    ),
});

const planReadSchema = z.object({
  planId: optionalPlanIdSchema,
});

const claimableStatusSchema = z
  .enum(["open", "in_progress", "claimed"])
  .describe(
    "Ladder status. 'claimed' records unverified progress; 'proven' is NOT settable here — use PlanComplete with evidence.",
  );

const planUpdateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(1).describe("Plan title."),
    steps: z.array(z.string().min(1)).optional().describe("Initial numbered steps, in order."),
  }),
  z.object({
    action: z.literal("add_step"),
    planId: optionalPlanIdSchema,
    text: z.string().min(1).describe("The new step."),
  }),
  z.object({
    action: z.literal("set_step_status"),
    planId: optionalPlanIdSchema,
    step: z.number().int().min(1).describe("1-based step number."),
    status: claimableStatusSchema,
  }),
  z.object({
    action: z.literal("set_active"),
    planId: planIdSchema,
  }),
]);

const evidenceRefSchema = z.object({
  toolUseId: z.string().min(1).describe("A toolUseId from a tool call you actually ran."),
  sessionId: z
    .string()
    .regex(/^sess_[0-9a-f]{16}$/)
    .optional()
    .describe("Session the call ran in. Omit for the current session."),
});

const planCompleteSchema = z.object({
  planId: optionalPlanIdSchema,
  step: z.number().int().min(1).describe("1-based step number to mark proven."),
  evidence: z
    .array(evidenceRefSchema)
    .min(1)
    .describe("Evidence for the proven transition — cite the tool call(s) that did the work."),
});

const goalWriteSchema = z.object({
  title: z.string().min(1).describe("The goal."),
  target: z.number().optional().describe("Optional numeric target."),
  current: z.number().optional().describe("Optional current value."),
  unit: z.string().optional().describe("Optional unit for target/current (e.g. '%')."),
});

const goalUpdateSchema = z.object({
  goalId: z
    .string()
    .regex(/^goal-\d{4}$/)
    .describe("Goal id, e.g. goal-0001."),
  title: z.string().min(1).optional(),
  status: z
    .enum(["open", "in_progress", "claimed", "proven"])
    .optional()
    .describe("Ladder status. 'proven' requires evidence."),
  target: z.number().optional(),
  current: z.number().optional(),
  unit: z.string().optional(),
  evidence: z
    .array(evidenceRefSchema)
    .optional()
    .describe("Required when status is 'proven' — the tool call(s) that achieved the goal."),
});

const goalListSchema = z.object({});

const memoryClearSchema = z.object({
  scope: z
    .enum(["focus", "plans", "goals", "all"])
    .describe("What to clear. Files move to .crewhaus/trash/<ts>/ — recoverable, never deleted."),
});

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

function renderPlan(plan: PlanRecord): string {
  const lines = [`${plan.id} — ${plan.title}`];
  if (plan.steps.length === 0) {
    lines.push("  (no steps yet — add some with PlanUpdate {action: 'add_step'})");
  }
  for (const step of plan.steps) {
    const proofSuffix = isProvenByAssertion(step)
      ? ` — cited, not verified: ${(step.unverified ?? []).map((r) => r.toolUseId).join(", ")}`
      : step.status === "proven" && step.proofs.length > 0
        ? ` — proof: ${step.proofs.map((p) => p.toolUseId).join(", ")}`
        : "";
    lines.push(`  ${step.index}. ${renderLadderStatus(step)} ${step.text}${proofSuffix}`);
  }
  return lines.join("\n");
}

function progressOf(goal: Pick<Goal, "target" | "current" | "unit">): string {
  return goal.target !== undefined
    ? ` (${goal.current ?? 0}/${goal.target}${goal.unit !== undefined ? ` ${goal.unit}` : ""})`
    : "";
}

function renderGoal(goal: Goal): string {
  return `- ${goal.id} ${renderLadderStatus(goal)} ${goal.title}${progressOf(goal)}`;
}

/**
 * The `require`-mode reading of "achieved": progress at or past the target,
 * with an unset `current` read as 0. That is how every surface shows a goal
 * (`progressOf`, the handoff, the `<current_plan>` tail all print
 * `current ?? 0`), and it is the Thredz goal mirror's completion rule
 * (`currentValue >= targetValue`, `currentValue` defaulting to 0). So a
 * `target: 0` goal is achieved the moment it exists.
 */
function atTarget(goal: { readonly target?: number; readonly current?: number }): boolean {
  return goal.target !== undefined && (goal.current ?? 0) >= goal.target;
}

type LadderRecord = {
  readonly status: string;
  readonly unverified?: Goal["unverified"];
  readonly proofs?: Goal["proofs"];
};

/** The `require` label for a `proven` record with no frozen proof. */
const NO_PROOF_LABEL = "marked proven with no proof on record";

/**
 * `proven` with machine-checked evidence on record (the store's
 * `isProvenVerified`). Under `require`, two kinds of `proven` record are
 * below this, and complete nothing until a verified proof replaces them: one
 * proven by assertion (an earlier `off` run), and one with no frozen proof at
 * all. The store never writes the second — every verified transition freezes
 * at least one proof — so it was edited into a file by hand, or read back
 * from a step line that a multi-line plan title smuggled into a plan file
 * before the store kept titles to one line. Nobody checked either.
 */
function verifiedProven(record: LadderRecord): boolean {
  return isProvenVerified(record);
}

/** How a below-proven record names itself in a `require` refusal. */
function belowProvenLabel(record: LadderRecord): string {
  if (isProvenByAssertion(record)) return "proven (unverified)";
  return record.status === "proven" ? NO_PROOF_LABEL : record.status;
}

/** `a`, `a or b`, `a, b or c`. */
function orList(items: readonly string[]): string {
  return items.length > 2
    ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`
    : items.join(" or ");
}

/**
 * Under `require`, the note a plan earns once nothing is left open or in
 * progress while some step is still below proven: claimed, proven by
 * assertion under an earlier `off` run, or marked proven with no proof on
 * record (see {@link verifiedProven}). That is the moment a model is
 * likeliest to believe the plan is done, and it is not: each such step still
 * needs a verified proof. Null while the plan still has unstarted work (the
 * claim is then plainly not the end) or once every step is proven.
 */
function incompletePlanNote(plan: PlanRecord): string | null {
  if (plan.steps.some((s) => s.status === "open" || s.status === "in_progress")) return null;
  const below = plan.steps.filter((s) => !verifiedProven(s));
  if (below.length === 0) return null;
  const present = new Set(below.map(belowProvenLabel));
  const labels = orList(
    ["claimed", "proven (unverified)", NO_PROOF_LABEL].filter((l) => present.has(l)),
  );
  const which =
    below.length === 1
      ? `step ${below[0]?.index} is ${labels}, not proven — prove it`
      : `steps ${below.map((s) => s.index).join(", ")} are ${labels}, not proven — prove each`;
  return `${plan.id} is not complete: ${which} with PlanComplete({step, evidence: [{toolUseId}]}) first.`;
}

/**
 * The `require` refusal for a GoalWrite that would create a goal already at
 * its target, or null when the goal starts below it.
 */
function goalWriteRefusal(input: {
  readonly target?: number;
  readonly current?: number;
  readonly unit?: string;
}): string | null {
  if (input.target === undefined || !atTarget(input)) return null;
  const progress = `${input.current ?? 0}/${input.target}${input.unit !== undefined ? ` ${input.unit}` : ""}`;
  const head = `a new goal cannot start at its target (${progress}) under continuity.proof: require — that would mark it achieved without proof.`;
  if (input.target > 0) {
    return `${head} Create it without current (or below the target), then prove it with GoalUpdate({goalId, current: ${input.current}, status: "proven", evidence: [{toolUseId}]}).`;
  }
  // A target of 0 or below is met before any work: progress counts up from
  // `current`, which reads as 0 when unset. Leaving out `current` cannot help.
  return `${head} Progress counts up from current (0 when unset), so a target of ${input.target} is met before any work. Count up toward a positive target instead (for example, items done out of a total), or create the goal without a target and set it in the GoalUpdate that proves it: GoalUpdate({goalId, target: ${input.target}, status: "proven", evidence: [{toolUseId}]}).`;
}

/**
 * The `require` refusal for a GoalUpdate whose RESULT (`next`, the record
 * as written) sits at its target below a verified proof, or null. `input`
 * supplies the fields the reply tells the model to resend with its proof.
 */
function goalUpdateRefusal(
  goalId: string,
  input: { readonly current?: number; readonly target?: number },
  next: LadderRecord & Pick<Goal, "target" | "current" | "unit">,
): string | null {
  if (!atTarget(next) || verifiedProven(next)) return null;
  const fields = [
    ...(input.current !== undefined ? [`current: ${input.current}`] : []),
    ...(input.target !== undefined ? [`target: ${input.target}`] : []),
  ].join(", ");
  const why = isProvenByAssertion(next)
    ? `${goalId} is proven (unverified), which under continuity.proof: require is not proven — reaching its target${progressOf(next)} would mark it achieved. Prove it again in the same call, with verified evidence`
    : `${goalId} is ${belowProvenLabel(next)}, not proven — reaching its target${progressOf(next)} would mark it achieved. Prove it in the same call`;
  return `${why}: GoalUpdate({goalId: "${goalId}", ${fields}, status: "proven", evidence: [{toolUseId}]}), citing the call that measured it.`;
}

function renderRequirement(req: Requirement): string {
  return `- ${req.id} [${req.status}] ${JSON.stringify(req.text)} (user, ${req.source.sessionId}, turn ${req.source.turn})`;
}

// ---------------------------------------------------------------------------
// per-mode descriptions — the ladder strings are the pre-0.8.0 bytes
// ---------------------------------------------------------------------------

const PLAN_READ_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "Read a plan's numbered steps with their proof-ladder statuses. 'claimed' steps are rendered as unverified — only 'proven' steps have machine-checked evidence. Omit planId for the active plan.",
  require:
    "Read a plan's numbered steps with their proof-ladder statuses. 'claimed' steps are rendered as unverified — only 'proven' steps have machine-checked evidence, and a plan is complete only when every step is proven. Omit planId for the active plan.",
  off: "Read a plan's numbered steps with their proof-ladder statuses. Proof checking is off in this harness: 'claimed' and 'proven (unverified)' steps are both the model's own account, and nothing is machine-checked. Omit planId for the active plan.",
};

const PLAN_UPDATE_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "Mutate the persisted plan: create a plan, add a step, move a step's ladder status (open → in_progress → claimed), or set the active plan. 'claimed' records progress WITHOUT verification — the 'proven' transition goes through PlanComplete with evidence.",
  require:
    "Mutate the persisted plan: create a plan, add a step, move a step's ladder status (open → in_progress → claimed), or set the active plan. 'claimed' records progress WITHOUT verification and completes nothing — a step is done only once PlanComplete proves it with evidence.",
  off: "Mutate the persisted plan: create a plan, add a step, move a step's ladder status (open → in_progress → claimed), or set the active plan. 'claimed' records progress; the 'proven' transition goes through PlanComplete, which in this harness records the cited evidence without checking it.",
};

const PLAN_COMPLETE_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "The proven transition (machine-checked): mark a plan step proven by citing the toolUseId(s) of the calls that did the work. Each id is resolved against the session event logs (child sessions included); missing or errored results are rejected. Do the work first, then complete the step.",
  require:
    "The proven transition (machine-checked): mark a plan step proven by citing the toolUseId(s) of the calls that did the work. Each id is resolved against the session event logs (child sessions included); missing or errored results are rejected. This is the ONLY way a step completes — 'claimed' never counts as done. Do the work first, then complete the step.",
  off: "Mark a plan step proven by citing the toolUseId(s) of the calls that did the work. Proof checking is off in this harness: the ids are RECORDED as unverified refs, not resolved against an event log, and the step reads 'proven (unverified)'. Cite only calls you actually ran. Do the work first, then complete the step.",
};

const GOAL_WRITE_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "Create a persisted goal ({title, target?, current?, unit?}) in goals.yaml. Goals carry the same open → in_progress → claimed → proven ladder as plan steps.",
  require:
    "Create a persisted goal ({title, target?, current?, unit?}) in goals.yaml. Goals carry the same open → in_progress → claimed → proven ladder as plan steps, and reach their target only as proven — create a goal below its target, then prove it with GoalUpdate.",
  off: "Create a persisted goal ({title, target?, current?, unit?}) in goals.yaml. Goals carry the same open → in_progress → claimed → proven ladder as plan steps.",
};

const GOAL_UPDATE_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "Update a goal: title, target/current progress, or ladder status. 'claimed' is free; 'proven' requires evidence [{toolUseId}] verified against the session event logs, exactly like PlanComplete.",
  require:
    "Update a goal: title, target/current progress, or ladder status. 'claimed' is free; 'proven' requires evidence [{toolUseId}] verified against the session event logs, exactly like PlanComplete. A goal reaches its target only as proven: set current to the target in the same call as status 'proven' with evidence.",
  off: "Update a goal: title, target/current progress, or ladder status. 'claimed' is free; 'proven' requires evidence [{toolUseId}], which this harness records WITHOUT checking it (the goal reads 'proven (unverified)').",
};

const GOAL_LIST_DESCRIPTION: Record<ProofMode, string> = {
  ladder:
    "List persisted goals with ladder statuses and progress. 'claimed' goals are rendered as unverified.",
  require:
    "List persisted goals with ladder statuses and progress. 'claimed' goals are rendered as unverified.",
  off: "List persisted goals with ladder statuses and progress. 'claimed' and 'proven (unverified)' goals are both unchecked.",
};

/** Thrown when a plan-scoped call has neither a planId nor an active plan. */
export class NoActivePlanError extends Error {
  override readonly name = "NoActivePlanError";
}

// ---------------------------------------------------------------------------
// the factory
// ---------------------------------------------------------------------------

/**
 * Construct the continuity tool set bound to a spec's continuity store. The
 * caller registers the returned tools into the runtime catalog (e.g.
 * `for (const t of bundle.all) defaultCatalog.register(t)`).
 */
export function createPlanTools(opts: CreatePlanToolsOptions): PlanToolBundle {
  const proofMode: ProofMode = opts.proofMode ?? DEFAULT_PROOF_MODE;
  // A hand-built fragment can carry any string; a typo'd mode must not
  // quietly become the ladder (the spec schema rejects it at compile time —
  // this is the same refusal for callers that skip the compiler).
  if (!PROOF_MODES.includes(proofMode)) {
    throw new Error(
      `createPlanTools: proofMode "${String(proofMode)}" is not one of ${PROOF_MODES.join(" | ")}.`,
    );
  }
  const store: ContinuityStore =
    opts.store ??
    createContinuityStore({
      specName: opts.specName,
      ...(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.sessionRootDir !== undefined ? { sessionRootDir: opts.sessionRootDir } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      // The store's handoff.md counts `proven` as these tools do (§6.3).
      proofMode,
    });

  async function emit(event: ContinuityEvent): Promise<void> {
    if (opts.appendEvent !== undefined) await opts.appendEvent(event);
  }

  function currentSessionId(ctx?: ToolExecuteContext): string | undefined {
    return ctx?.runContext?.sessionId ?? opts.sessionId;
  }

  /** v0.3.0 §7.1 — attribution: stamp the acting run context's identity
   *  (e.g. `subagent=researcher`) into emitted event payloads so a plan
   *  mutation made from inside a sub-agent records WHO acted. Mirrors
   *  tool-wiki's `createdBy` stamping: prefers `ctx.runContext`, falls back
   *  to the opaque bridge's runContext (the field the runtime threads on
   *  every tool execute). Empty for top-level runs. */
  function identityOf(ctx?: ToolExecuteContext): { agentIdentity: string } | Record<string, never> {
    const rc =
      ctx?.runContext ?? (ctx?.bridge as { runContext?: RunContext } | undefined)?.runContext;
    return rc?.agentIdentity !== undefined
      ? { agentIdentity: formatAgentIdentity(rc.agentIdentity) }
      : {};
  }

  /** §2.5 — flag the runtime's per-run state-store after a successful
   *  mutation so the loop re-renders the plan tail before the next model
   *  call. No-op when the runtime didn't wire `bridge.runState` (pre-0.3.0
   *  bridge builders, direct tool execution in tests/CLI verbs). */
  function markPlanDirty(ctx?: ToolExecuteContext): void {
    const bridge = ctx?.bridge as { runState?: RunStateLike } | undefined;
    bridge?.runState?.set({ [PLAN_DIRTY_STATE_KEY]: true });
  }

  async function resolvePlanId(planId: string | undefined): Promise<string> {
    if (planId !== undefined) return planId;
    const active = await store.getActivePlan();
    if (active === null) {
      throw new NoActivePlanError(
        "no active plan — pass planId, or create a plan first with PlanUpdate {action: 'create'}.",
      );
    }
    return active.id;
  }

  const focusRead: RegisteredTool = buildTool({
    name: "FocusRead",
    description:
      "Read the persisted focus: what this harness is working on, the active plan pointer, and the REQ-nnn requirements ledger. Check this FIRST at session start and before asking the user anything they may already have answered.",
    inputSchema: focusReadSchema,
    readOnly: true,
    execute: async () => {
      const focus = await store.readFocus();
      if (focus === null) {
        return "no focus set — write one with FocusWrite.";
      }
      const lines: string[] = ["focus:"];
      lines.push(focus.body !== "" ? focus.body : "  (empty)");
      lines.push(`active plan: ${focus.activePlanId ?? "none"}`);
      lines.push("requirements:");
      if (focus.requirements.length > 0) {
        if (focus.ledgerTruncated) lines.push("[ledger truncated]");
        for (const req of focus.requirements) lines.push(renderRequirement(req));
      } else {
        lines.push("  (none)");
      }
      return lines.join("\n");
    },
  });

  const focusWrite: RegisteredTool = buildTool({
    name: "FocusWrite",
    description:
      "Replace the persisted focus body (current objective + next actions). This is the hot loop — keep it current and short (capped at focusMaxChars). Requirements are appended via the ledger, not here.",
    inputSchema: focusWriteSchema,
    destructive: true, // audit-and-allow; deliberately NO requireJustification (§7.4)
    execute: async (input, ctx) => {
      await store.writeFocus(input.focus);
      markPlanDirty(ctx);
      return `focus updated (${input.focus.length} chars)`;
    },
  });

  const planRead: RegisteredTool = buildTool({
    name: "PlanRead",
    description: PLAN_READ_DESCRIPTION[proofMode],
    inputSchema: planReadSchema,
    readOnly: true,
    execute: async (input) => {
      if (input.planId !== undefined) {
        const plan = await store.getPlan(input.planId);
        if (plan === null) return `no plan "${input.planId}"`;
        return renderPlan(plan);
      }
      const active = await store.getActivePlan();
      if (active !== null) return renderPlan(active);
      const plans = await store.listPlans();
      if (plans.length === 0) {
        return "no plans yet — create one with PlanUpdate {action: 'create'}.";
      }
      return [
        "no active plan. available plans:",
        ...plans.map((p) => `- ${p.id} — ${p.title}`),
      ].join("\n");
    },
  });

  const planUpdate: RegisteredTool = buildTool({
    name: "PlanUpdate",
    description: PLAN_UPDATE_DESCRIPTION[proofMode],
    inputSchema: planUpdateSchema,
    destructive: true, // audit-and-allow (§7.4): a judge call per routine plan update would drown the loop
    execute: async (input, ctx) => {
      switch (input.action) {
        case "create": {
          const plan = await store.createPlan({
            title: input.title,
            ...(input.steps !== undefined ? { steps: input.steps } : {}),
          });
          await emit({
            kind: "plan_update",
            payload: { planId: plan.id, action: "create", title: plan.title, ...identityOf(ctx) },
          });
          markPlanDirty(ctx);
          return `created ${plan.id} — ${plan.title} (${plan.steps.length} step(s))\n${renderPlan(plan)}`;
        }
        case "add_step": {
          const planId = await resolvePlanId(input.planId);
          const plan = await store.addStep(planId, input.text);
          await emit({
            kind: "plan_update",
            payload: { planId, action: "add_step", step: plan.steps.length, ...identityOf(ctx) },
          });
          markPlanDirty(ctx);
          return `added step ${plan.steps.length} to ${planId}`;
        }
        case "set_step_status": {
          const planId = await resolvePlanId(input.planId);
          const plan = await store.setStepStatus(planId, input.step, input.status);
          await emit({
            kind: "plan_update",
            payload: {
              planId,
              action: "set_step_status",
              step: input.step,
              status: input.status,
              ...identityOf(ctx),
            },
          });
          markPlanDirty(ctx);
          if (proofMode === "require" && input.status === "claimed") {
            // `claimed` stays settable under require — it is honest progress
            // — but the reply says plainly that it completes nothing.
            const note = incompletePlanNote(plan);
            return `${planId} step ${input.step} → claimed (unverified — under continuity.proof: require it completes nothing; prove it with PlanComplete({step: ${input.step}, evidence: [{toolUseId}]}))${
              note !== null ? `\n${note}` : ""
            }`;
          }
          return `${planId} step ${input.step} → ${input.status}${
            input.status === "claimed" ? " (unverified — prove it with PlanComplete)" : ""
          }`;
        }
        case "set_active": {
          await store.setActivePlan(input.planId);
          await emit({
            kind: "plan_update",
            payload: { planId: input.planId, action: "set_active", ...identityOf(ctx) },
          });
          markPlanDirty(ctx);
          return `active plan → ${input.planId}`;
        }
      }
    },
  });

  const planComplete: RegisteredTool = buildTool({
    name: "PlanComplete",
    description: PLAN_COMPLETE_DESCRIPTION[proofMode],
    inputSchema: planCompleteSchema,
    destructive: true,
    execute: async (input, ctx) => {
      const planId = await resolvePlanId(input.planId);
      const sessionId = currentSessionId(ctx);
      const refs: EvidenceRef[] = input.evidence.map((ref) => ({
        toolUseId: ref.toolUseId,
        ...(ref.sessionId !== undefined
          ? { sessionId: ref.sessionId }
          : sessionId !== undefined
            ? { sessionId }
            : {}),
      }));
      if (proofMode === "off") {
        // design/0.8.0 §6.3 — no verification: the step is proven by
        // assertion, the citations are recorded unresolved, no session is
        // pinned, and the audit trail says `unverified`, never `verified`.
        const plan = await store.proveStep(planId, input.step, refs, {
          verification: "unverified",
        });
        const step = plan.steps.find((s) => s.index === input.step);
        if (step === undefined || !isProvenByAssertion(step)) {
          // The store kept an earlier machine-checked proof rather than
          // downgrade it — nothing new was recorded, so nothing is emitted.
          return `${planId} step ${input.step} is already proven with verified evidence — nothing recorded.`;
        }
        const cited = new Set(refs.map((r) => r.toolUseId));
        const recorded = (step.unverified ?? []).filter((r) => cited.has(r.toolUseId));
        for (const ref of recorded) {
          await emit({
            kind: "action_proof",
            payload: {
              planId,
              step: input.step,
              toolUseId: ref.toolUseId,
              verdict: "unverified",
              ...identityOf(ctx),
            },
          });
        }
        await emit({
          kind: "plan_update",
          payload: {
            planId,
            action: "prove_step",
            step: input.step,
            status: "proven",
            ...identityOf(ctx),
          },
        });
        markPlanDirty(ctx);
        return `${planId} step ${input.step} proven (unverified) — continuity.proof is off, so the evidence was recorded, not checked: ${recorded
          .map(renderUnverifiedRef)
          .join(", ")}`;
      }
      try {
        const plan = await store.proveStep(planId, input.step, refs);
        const step = plan.steps.find((s) => s.index === input.step);
        for (const proof of step?.proofs ?? []) {
          if (refs.some((r) => r.toolUseId === proof.toolUseId)) {
            await emit({
              kind: "action_proof",
              payload: {
                planId,
                step: input.step,
                toolUseId: proof.toolUseId,
                verdict: "verified",
                ...identityOf(ctx),
              },
            });
          }
        }
        await emit({
          kind: "plan_update",
          payload: {
            planId,
            action: "prove_step",
            step: input.step,
            status: "proven",
            ...identityOf(ctx),
          },
        });
        markPlanDirty(ctx);
        const reply = `${planId} step ${input.step} proven — evidence: ${refs
          .map((r) => r.toolUseId)
          .join(", ")}`;
        // Under require, proving the last open step of a plan whose other
        // steps are claimed (or proven only by assertion) does not finish
        // it; say which steps still need a verified proof.
        const note = proofMode === "require" ? incompletePlanNote(plan) : null;
        return note !== null ? `${reply}\n${note}` : reply;
      } catch (err) {
        if (err instanceof EvidenceError) {
          // Audit the rejected attempt too — proof pressure is signal.
          await emit({
            kind: "action_proof",
            payload: {
              planId,
              step: input.step,
              toolUseId: err.toolUseId,
              verdict: err.verdict,
              ...identityOf(ctx),
            },
          });
        }
        throw err;
      }
    },
  });

  const goalWrite: RegisteredTool = buildTool({
    name: "GoalWrite",
    description: GOAL_WRITE_DESCRIPTION[proofMode],
    inputSchema: goalWriteSchema,
    destructive: true,
    execute: async (input, ctx) => {
      // A new goal's record comes from the input alone, so checking the
      // input is checking the record (no lock needed, unlike GoalUpdate).
      const refusal = proofMode === "require" ? goalWriteRefusal(input) : null;
      if (refusal !== null) throw new ProofRequiredError(refusal);
      const goal = await store.writeGoal({
        title: input.title,
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.current !== undefined ? { current: input.current } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
      });
      await emit({
        kind: "goal_update",
        payload: { goalId: goal.id, action: "create", title: goal.title, ...identityOf(ctx) },
      });
      markPlanDirty(ctx);
      return `created ${goal.id} — ${goal.title}`;
    },
  });

  const goalUpdate: RegisteredTool = buildTool({
    name: "GoalUpdate",
    description: GOAL_UPDATE_DESCRIPTION[proofMode],
    inputSchema: goalUpdateSchema,
    destructive: true,
    execute: async (input, ctx) => {
      const sessionId = currentSessionId(ctx);
      const evidence: EvidenceRef[] | undefined = input.evidence?.map((ref) => ({
        toolUseId: ref.toolUseId,
        ...(ref.sessionId !== undefined
          ? { sessionId: ref.sessionId }
          : sessionId !== undefined
            ? { sessionId }
            : {}),
      }));
      // `require`: the store's one completion path below proven is progress
      // reaching the target (the Thredz mirror completes the goal on it), so
      // an update that moves progress is refused when the goal would end up
      // at its target without a verified proof. Only progress moves are
      // policed: a title edit on a goal already sitting at its target
      // completes nothing new.
      const guarded =
        proofMode === "require" && (input.current !== undefined || input.target !== undefined);
      const refuseUnproven = (next: Parameters<typeof goalUpdateRefusal>[2]): void => {
        const why = goalUpdateRefusal(input.goalId, input, next);
        if (why !== null) throw new ProofRequiredError(why);
      };
      if (guarded) {
        // Early refusal on a snapshot, before any evidence is resolved; it
        // holds whatever store wrapper is in use. The authoritative check is
        // the store guard below, which sees the record as written under the
        // lock, so two sessions cannot each pass on a stale read. An unknown
        // id falls through to the store's own "no goal" error.
        const existing = (await store.listGoals()).find((g) => g.id === input.goalId);
        // A call that sets `proven` resolves its evidence (require is the
        // ladder there), so it lands verified — with a frozen proof,
        // replacing any assertion — or not at all; the snapshot has nothing
        // to refuse in it.
        if (existing !== undefined && input.status !== "proven") {
          refuseUnproven({
            status: input.status ?? existing.status,
            unverified: existing.unverified,
            proofs: existing.proofs,
            target: input.target ?? existing.target,
            current: input.current ?? existing.current,
            unit: input.unit ?? existing.unit,
          });
        }
      }
      const patch: UpdateGoalInput = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.current !== undefined ? { current: input.current } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
      };
      // `off` records a proven goal's evidence unresolved (design/0.8.0
      // §6.3); `require` hands the store its at-target guard; the ladder
      // makes the exact pre-0.8.0 call.
      const goal =
        proofMode === "off"
          ? await store.updateGoal(input.goalId, patch, { verification: "unverified" })
          : guarded
            ? await store.updateGoal(input.goalId, patch, { guard: (next) => refuseUnproven(next) })
            : await store.updateGoal(input.goalId, patch);
      // `action_proof` is keyed by plan step, so a goal proven by assertion
      // is marked on its own `goal_update` instead: the log must not show it
      // the way it shows a verified goal proof.
      const asserted = input.status === "proven" && isProvenByAssertion(goal);
      await emit({
        kind: "goal_update",
        payload: {
          goalId: goal.id,
          action: "update",
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(asserted ? { verification: "unverified" as const } : {}),
          ...identityOf(ctx),
        },
      });
      markPlanDirty(ctx);
      return `${goal.id} updated — ${renderGoal(goal).slice(2)}`;
    },
  });

  const goalList: RegisteredTool = buildTool({
    name: "GoalList",
    description: GOAL_LIST_DESCRIPTION[proofMode],
    inputSchema: goalListSchema,
    readOnly: true,
    execute: async () => {
      const goals = await store.listGoals();
      if (goals.length === 0) return "no goals yet — create one with GoalWrite.";
      return goals.map(renderGoal).join("\n");
    },
  });

  const memoryClear: RegisteredTool = buildTool({
    name: "MemoryClear",
    description:
      "Clear continuity state (focus | plans | goals | all). Files move to .crewhaus/trash/<ts>/ and can be restored — nothing is hard-deleted. Destructive: requires a justification.",
    inputSchema: memoryClearSchema,
    destructive: true,
    // Pillar 3 intent gate (§7.4): model-initiated forgetting is exactly
    // where the justification judge belongs — unlike the hot-loop
    // Focus/Plan updates, clears are rare and destructive-by-intent.
    requireJustification: true,
    execute: async (input, ctx) => {
      const result = await store.clear(input.scope);
      if (result.moved.length === 0) {
        return `nothing to clear for scope "${input.scope}" (store is empty)`;
      }
      markPlanDirty(ctx);
      return (
        `cleared: ${input.scope} (${result.moved.length} file(s)/dir(s)) → ${result.trashDir}\n` +
        `undo: crewhaus memory restore ${result.ts}`
      );
    },
  });

  const all = [
    focusRead,
    focusWrite,
    planRead,
    planUpdate,
    planComplete,
    goalWrite,
    goalUpdate,
    goalList,
    memoryClear,
  ];

  return {
    focusRead,
    focusWrite,
    planRead,
    planUpdate,
    planComplete,
    goalWrite,
    goalUpdate,
    goalList,
    memoryClear,
    all,
    store,
  };
}
