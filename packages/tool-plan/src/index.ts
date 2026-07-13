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
  createContinuityStore,
  renderStatus,
} from "@crewhaus/continuity-store";
import type {
  ActionProofEventPayload,
  GoalUpdateEventPayload,
  PlanUpdateEventPayload,
} from "@crewhaus/event-log";
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
    const proofSuffix =
      step.status === "proven" && step.proofs.length > 0
        ? ` — proof: ${step.proofs.map((p) => p.toolUseId).join(", ")}`
        : "";
    lines.push(`  ${step.index}. ${renderStatus(step.status)} ${step.text}${proofSuffix}`);
  }
  return lines.join("\n");
}

function renderGoal(goal: Goal): string {
  const progress =
    goal.target !== undefined
      ? ` (${goal.current ?? 0}/${goal.target}${goal.unit !== undefined ? ` ${goal.unit}` : ""})`
      : "";
  return `- ${goal.id} ${renderStatus(goal.status)} ${goal.title}${progress}`;
}

function renderRequirement(req: Requirement): string {
  return `- ${req.id} [${req.status}] ${JSON.stringify(req.text)} (user, ${req.source.sessionId}, turn ${req.source.turn})`;
}

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
  const store: ContinuityStore =
    opts.store ??
    createContinuityStore({
      specName: opts.specName,
      ...(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.sessionRootDir !== undefined ? { sessionRootDir: opts.sessionRootDir } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });

  async function emit(event: ContinuityEvent): Promise<void> {
    if (opts.appendEvent !== undefined) await opts.appendEvent(event);
  }

  function currentSessionId(ctx?: ToolExecuteContext): string | undefined {
    return ctx?.runContext?.sessionId ?? opts.sessionId;
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
    execute: async (input) => {
      await store.writeFocus(input.focus);
      return `focus updated (${input.focus.length} chars)`;
    },
  });

  const planRead: RegisteredTool = buildTool({
    name: "PlanRead",
    description:
      "Read a plan's numbered steps with their proof-ladder statuses. 'claimed' steps are rendered as unverified — only 'proven' steps have machine-checked evidence. Omit planId for the active plan.",
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
    description:
      "Mutate the persisted plan: create a plan, add a step, move a step's ladder status (open → in_progress → claimed), or set the active plan. 'claimed' records progress WITHOUT verification — the 'proven' transition goes through PlanComplete with evidence.",
    inputSchema: planUpdateSchema,
    destructive: true, // audit-and-allow (§7.4): a judge call per routine plan update would drown the loop
    execute: async (input) => {
      switch (input.action) {
        case "create": {
          const plan = await store.createPlan({
            title: input.title,
            ...(input.steps !== undefined ? { steps: input.steps } : {}),
          });
          await emit({
            kind: "plan_update",
            payload: { planId: plan.id, action: "create", title: plan.title },
          });
          return `created ${plan.id} — ${plan.title} (${plan.steps.length} step(s))\n${renderPlan(plan)}`;
        }
        case "add_step": {
          const planId = await resolvePlanId(input.planId);
          const plan = await store.addStep(planId, input.text);
          await emit({
            kind: "plan_update",
            payload: { planId, action: "add_step", step: plan.steps.length },
          });
          return `added step ${plan.steps.length} to ${planId}`;
        }
        case "set_step_status": {
          const planId = await resolvePlanId(input.planId);
          await store.setStepStatus(planId, input.step, input.status);
          await emit({
            kind: "plan_update",
            payload: {
              planId,
              action: "set_step_status",
              step: input.step,
              status: input.status,
            },
          });
          return `${planId} step ${input.step} → ${input.status}${
            input.status === "claimed" ? " (unverified — prove it with PlanComplete)" : ""
          }`;
        }
        case "set_active": {
          await store.setActivePlan(input.planId);
          await emit({
            kind: "plan_update",
            payload: { planId: input.planId, action: "set_active" },
          });
          return `active plan → ${input.planId}`;
        }
      }
    },
  });

  const planComplete: RegisteredTool = buildTool({
    name: "PlanComplete",
    description:
      "The proven transition (machine-checked): mark a plan step proven by citing the toolUseId(s) of the calls that did the work. Each id is resolved against the session event logs (child sessions included); missing or errored results are rejected. Do the work first, then complete the step.",
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
              },
            });
          }
        }
        await emit({
          kind: "plan_update",
          payload: { planId, action: "prove_step", step: input.step, status: "proven" },
        });
        return `${planId} step ${input.step} proven — evidence: ${refs
          .map((r) => r.toolUseId)
          .join(", ")}`;
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
            },
          });
        }
        throw err;
      }
    },
  });

  const goalWrite: RegisteredTool = buildTool({
    name: "GoalWrite",
    description:
      "Create a persisted goal ({title, target?, current?, unit?}) in goals.yaml. Goals carry the same open → in_progress → claimed → proven ladder as plan steps.",
    inputSchema: goalWriteSchema,
    destructive: true,
    execute: async (input) => {
      const goal = await store.writeGoal({
        title: input.title,
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.current !== undefined ? { current: input.current } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
      });
      await emit({
        kind: "goal_update",
        payload: { goalId: goal.id, action: "create", title: goal.title },
      });
      return `created ${goal.id} — ${goal.title}`;
    },
  });

  const goalUpdate: RegisteredTool = buildTool({
    name: "GoalUpdate",
    description:
      "Update a goal: title, target/current progress, or ladder status. 'claimed' is free; 'proven' requires evidence [{toolUseId}] verified against the session event logs, exactly like PlanComplete.",
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
      const goal = await store.updateGoal(input.goalId, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.current !== undefined ? { current: input.current } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
      });
      await emit({
        kind: "goal_update",
        payload: {
          goalId: goal.id,
          action: "update",
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      });
      return `${goal.id} updated — ${renderGoal(goal).slice(2)}`;
    },
  });

  const goalList: RegisteredTool = buildTool({
    name: "GoalList",
    description:
      "List persisted goals with ladder statuses and progress. 'claimed' goals are rendered as unverified.",
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
    execute: async (input) => {
      const result = await store.clear(input.scope);
      if (result.moved.length === 0) {
        return `nothing to clear for scope "${input.scope}" (store is empty)`;
      }
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
