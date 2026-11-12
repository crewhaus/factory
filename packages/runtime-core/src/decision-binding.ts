/**
 * What a grant is good for, and how one is spent (#507, #513).
 *
 * A headless park records, beside the call, the class of person who may decide it
 * and a binding: the scope the call was asked in (a conversation, a batch job, a
 * scheduled lane, a supervised job, a work item), the run that parked, the
 * deployment and spec the harness runs under when they are known, and a version
 * of the resource the call acts on when the tool reports one. The store seals the
 * binding with the session root's key when it writes the park.
 *
 * A grant is spent once, at the effect: after every gate that can refuse the call,
 * the store checks the binding against where the call runs now and whether the
 * person who granted it may still decide at its class, then claims the spend
 * exclusively, so it is spent once across processes. A refusal leaves the grant
 * unspent, and the call is asked again: the safe direction. A store without
 * `consume` (an injected minimal one) is checked here instead, and a grant on it
 * is spent once per process only.
 *
 * The parked call's index.ts call sites use what is here; nothing here reads the
 * conversation or the tool's result.
 */
import {
  type DecisionBinding,
  type DecisionClass,
  type DecisionRecordView,
  type VerifyApprovers,
  type VerifyReason,
  isId,
  parseResumeScope,
  verifyDecision,
} from "@crewhaus/control-contract";
import { readApproverProjection } from "@crewhaus/control-records";
import type { RunContext } from "@crewhaus/run-context";
import type {
  ApprovalPlace,
  ApprovalToPersist,
  PendingApproval,
  PendingApprovalStore,
  UnsealedBinding,
} from "@crewhaus/session-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { continuesOf, parkingRunIdOf, resumeScopeOf } from "./run-ledger";

/**
 * The lowest class that may decide a parked call of `tool`: a destructive tool,
 * or one that asks the model for a justification, needs a maintainer; any other
 * an operator. In single-owner mode the owner decides everything, so a class
 * bites only once a harness has members.
 */
export function requiredClassFor(
  tool: Pick<RegisteredTool, "destructive" | "requireJustification">,
): DecisionClass {
  return tool.destructive === true || tool.requireJustification === true
    ? "maintainer"
    : "operator";
}

/** Who denied a call, as the model is told: a role, never the text a surface recorded. */
export function deniedByPhrase(requiredClass: unknown): string {
  if (requiredClass === "maintainer") return "a maintainer";
  if (requiredClass === "owner") return "the owner";
  return "an operator";
}

/**
 * Why a grant could not be used, as the run's stop says it: the reason code, and
 * for a grant that names no person, where such a grant comes from. In a harness
 * with members a grant counts only when it names one; a chat channel's buttons
 * record no person, so their grant is asked again until it is made where one is.
 */
export function refusedPhrase(reason: string): string {
  if (reason === "decider-unverified") {
    return `${reason}: the grant names no member of this harness, and one made with a chat channel's buttons names none`;
  }
  return reason;
}

/** The revisions this harness runs under, when its environment names them. */
export type RunRevisions = { readonly deploymentId?: string; readonly specHash?: string };

const SPEC_HASH_RE = /^[0-9a-z:_-]{1,128}$/;

/**
 * `CREWHAUS_DEPLOYMENT_ID` when it is a deployment id and `CREWHAUS_SPEC_HASH`
 * when it is 1-128 of `[0-9a-z:_-]`. Anything else is ignored: a revision that is
 * not known is never checked, on either side.
 */
export function runRevisions(env: NodeJS.ProcessEnv = process.env): RunRevisions {
  const deploymentId = env["CREWHAUS_DEPLOYMENT_ID"];
  const specHash = env["CREWHAUS_SPEC_HASH"];
  return {
    ...(isId("dep", deploymentId) ? { deploymentId: deploymentId as string } : {}),
    ...(typeof specHash === "string" && SPEC_HASH_RE.test(specHash) ? { specHash } : {}),
  };
}

/** How long a tool's `revisionOf` may take before it counts as reporting no version. */
export const REVISION_TIMEOUT_MS = 5_000;

/** A resource version a binding can hold: bounded, and plain enough to compare and log. */
const RESOURCE_REVISION_RE = /^[0-9A-Za-z:._/-]{1,256}$/;

/**
 * The version of the resource the call acts on, when the tool reports one: 1-256
 * characters of `[0-9A-Za-z:._/-]` from its `revisionOf`. The hook runs before the
 * call is approved, so it is bounded: it gets a signal that aborts when the run is
 * cancelled or after `timeoutMs`, and an answer that does not come by then, a
 * throw, or anything else reports nothing. The binding then says the resource is
 * not bound, and a grant is checked by its places alone.
 */
export async function resourceRevisionOf(
  tool: Pick<RegisteredTool, "revisionOf">,
  operativeInput: unknown,
  opts: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<string | undefined> {
  const revisionOf = tool.revisionOf;
  if (typeof revisionOf !== "function") return undefined;
  const parent = opts.signal;
  if (parent?.aborted === true) return undefined;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  parent?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    timer = setTimeout(stop, opts.timeoutMs ?? REVISION_TIMEOUT_MS);
  });
  const answer = Promise.resolve().then(() =>
    revisionOf(operativeInput, { signal: controller.signal }),
  );
  // An answer that comes after the runtime gave up is dropped, a late throw too.
  answer.catch(() => {});
  try {
    const revision: unknown = await Promise.race([answer, gaveUp]);
    return typeof revision === "string" && RESOURCE_REVISION_RE.test(revision)
      ? revision
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener("abort", stop);
    // The hook has answered or been given up on: anything it still runs stops.
    controller.abort();
  }
}

/** What a park binds its call to. The store fills in the keyed part, `placesDigest`. */
export async function bindingFor(args: {
  readonly runContext: RunContext;
  readonly sessionId: string;
  readonly tool: Pick<RegisteredTool, "revisionOf">;
  readonly operativeInput: unknown;
}): Promise<UnsealedBinding> {
  const { runContext, sessionId } = args;
  const resourceRevision = await resourceRevisionOf(args.tool, args.operativeInput, {
    signal: runContext.abortSignal,
  });
  return {
    runId: parkingRunIdOf(runContext),
    resumeScope: resumeScopeOf(runContext, sessionId),
    sessionId,
    ...(runContext.workItem !== undefined ? { workItem: runContext.workItem } : {}),
    ...runRevisions(),
    ...(resourceRevision !== undefined ? { resourceRevision } : {}),
    resourceRevisionBound: resourceRevision !== undefined,
  };
}

/**
 * A pending request re-used by a park under a supervised job's root scope
 * (`run:<root>`), bound to the run that parks now. Under that scope a grant is
 * spent only by the run it is bound to or a run that continues it, and
 * `crewhaus runs resume` continues the newest parked run; so the request follows
 * the run that waits on it. `null` when nothing moves: a request already decided,
 * withdrawn or spent, one bound to another scope kind, or one already bound here.
 */
export function reboundToParkingRun(
  reuse: PendingApproval,
  runContext: RunContext,
): ApprovalToPersist | null {
  if (reuse.decision !== undefined || reuse.supersededBy !== undefined) return null;
  if (reuse.consumedAt !== undefined) return null;
  const binding = reuse.binding;
  if (typeof binding !== "object" || binding === null) return null;
  if (parseResumeScope(binding.resumeScope)?.kind !== "run") return null;
  const runId = parkingRunIdOf(runContext);
  if (binding.runId === runId) return null;
  // The store seals the binding again (its places digest and `bindingDigest`).
  const { bindingDigest: _sealedFor, ...rest } = reuse;
  return { ...rest, binding: { ...binding, runId } };
}

/** How a held grant's spend ended. */
export type SpendOutcome =
  | { readonly outcome: "consumed" }
  | {
      readonly outcome: "refused";
      readonly reason: VerifyReason;
      /** The grant as the check found it. */
      readonly record: PendingApproval;
      /** The request parked in its place, when the refusal retired the grant. */
      readonly fresh?: PendingApproval;
    };

/** Who may decide here now, read from the harness's projection; a read that fails is unreadable. */
function approversAt(harnessRoot: string): VerifyApprovers {
  try {
    return readApproverProjection(harnessRoot);
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * Stands in for a places digest a store could not seal (it holds no key). The
 * places are then the runtime's own check, `landsWhereApproved`, which the call
 * already passed: both sides carry the same marker.
 */
const UNSEALED_PLACES = "unsealed:places-checked-by-the-runtime";

/**
 * Spend `grant` for the call about to run, or say why not. With a store that has
 * `consume`, the store makes every check under its lock and claims the spend.
 * Without one, the checks are made here and the spend is persisted as before:
 * once per process only.
 */
export async function consumeHeld(args: {
  readonly store: Pick<PendingApprovalStore, "persist"> &
    Partial<Pick<PendingApprovalStore, "consume">>;
  readonly grant: PendingApproval;
  readonly runContext: RunContext;
  readonly sessionId: string;
  readonly tool: Pick<RegisteredTool, "revisionOf">;
  readonly operativeInput: unknown;
  /** Where the call lands now. */
  readonly places: ReadonlyArray<ApprovalPlace>;
  /** The harness root whose approver projection is read. */
  readonly harnessRoot: string;
  /** `false` when no run waits on an answer (a call a rule allows): nothing is asked again. */
  readonly reask: boolean;
  readonly surface?: string;
}): Promise<SpendOutcome> {
  const { store, grant, runContext } = args;
  const runId = parkingRunIdOf(runContext);
  const continues = continuesOf(runContext);
  const resumeScope = resumeScopeOf(runContext, args.sessionId);
  const revisions = runRevisions();
  const resourceRevision = await resourceRevisionOf(args.tool, args.operativeInput, {
    signal: runContext.abortSignal,
  });
  const approvers = approversAt(args.harnessRoot);
  const spent = {
    runId,
    resumeScope,
    ...(continues !== undefined ? { continues } : {}),
    ...revisions,
    ...(resourceRevision !== undefined ? { resourceRevision } : {}),
  };
  if (typeof store.consume === "function") {
    const answer = await store.consume(grant.id, {
      ...spent,
      places: args.places,
      approvers,
      ...(args.surface !== undefined ? { surface: args.surface } : {}),
      ...(args.reask ? {} : { reask: false as const }),
    });
    if (answer.outcome === "consumed") return { outcome: "consumed" };
    if (answer.outcome === "not-found") {
      return { outcome: "refused", reason: "not-a-grant", record: grant };
    }
    return answer;
  }
  const binding: unknown = grant.binding;
  const bound = typeof binding === "object" && binding !== null;
  const sealedDigest = bound ? (binding as { readonly placesDigest?: unknown }).placesDigest : "";
  const placesDigest =
    typeof sealedDigest === "string" && sealedDigest !== "" ? sealedDigest : UNSEALED_PLACES;
  const decision: DecisionRecordView = bound
    ? { ...grant, binding: { ...(binding as DecisionBinding), placesDigest } }
    : grant;
  const verdict = verifyDecision({
    decision,
    consumer: { ...spent, placesDigest },
    approvers,
    now: Date.now(),
  });
  if (!verdict.ok) return { outcome: "refused", reason: verdict.reason, record: grant };
  await store.persist({ ...grant, consumedAt: new Date().toISOString() });
  return { outcome: "consumed" };
}

/**
 * What a cancelled run withdraws: every request its top run, or the parked run it
 * continues, waits on. A failure is logged once, and never fails the loop.
 */
export function withdrawOnCancel(
  ctx: RunContext,
  store: Partial<Pick<PendingApprovalStore, "supersedeRun">>,
): () => Promise<void> {
  return async () => {
    if (typeof store.supersedeRun !== "function") return;
    const runs = [...new Set([parkingRunIdOf(ctx), continuesOf(ctx)])].filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
    try {
      const { superseded } = await store.supersedeRun(runs, {
        reason: "run-cancelled",
        via: "system",
      });
      if (superseded.length > 0) {
        ctx.logger.info("tool approvals withdrawn: the run was cancelled", {
          approvalIds: superseded,
        });
      }
    } catch (err) {
      ctx.logger.warn("tool approvals of a cancelled run could not be withdrawn", {
        error: (err as Error).message,
      });
    }
  };
}
