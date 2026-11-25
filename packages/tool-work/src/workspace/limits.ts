/**
 * A change past the binding's size limits: a decision on it goes through the harness's own
 * approval store, like any parked call, with the counts in the input the person sees. The
 * decision is about this change (a digest of what it adds and removes, the same after a clean
 * rebase), in the item's scope, and is spent once, just before the push.
 *
 * The request carries its own name, never the tool's, so a grant of it never stands in for a
 * call of `WorkspacePublish`, and an "always allow" saved from it allows nothing.
 */
import { type RunStarter, formatResumeScope, starterOf } from "@crewhaus/control-contract";
import { readApproverProjection, runsLedger } from "@crewhaus/control-records";
import type { RunContext } from "@crewhaus/run-context";
import {
  type PendingApproval,
  type PendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { readLedgerLines } from "../work-items/delivery";
import type { LimitsPort, OverLimits } from "./engine";

/** The name an over-limits request carries in the approval store. */
export const OVER_LIMITS_TOOL = "WorkspacePublishOverLimits";

/** What a person decides on. */
export function overLimitsInput(over: OverLimits): Readonly<Record<string, string | number>> {
  return {
    work: over.wi,
    repository: over.repository,
    branch: over.branch,
    files: over.files,
    lines: over.lines,
    max_files: over.maxFiles,
    max_lines: over.maxLines,
    change: over.change,
  };
}

export type OverLimitsApprovals = {
  readonly store: Pick<PendingApprovalStore, "persist" | "get"> &
    Partial<Pick<PendingApprovalStore, "consume">>;
  readonly notify?: (approval: PendingApproval) => Promise<void>;
  readonly surface?: string;
};

/** Who spends a decision: the run or command, the run it continues, and who started it. */
export type Spender = {
  readonly runId: string;
  readonly continues?: string;
  readonly starter?: RunStarter;
};

/**
 * Who a run's call spends as: its own lineage, else what its row in the runs ledger says (a
 * supervised job's run reads its starter and the run it continues from there).
 */
export function spenderOf(harnessDir: string, rc: RunContext): Spender {
  const runId = rc.parent ?? rc.runId;
  let continues = rc.continues;
  let via: unknown = rc.trigger?.via;
  if (continues === undefined || via === undefined) {
    try {
      for (const raw of readLedgerLines(runsLedger(harnessDir)).lines) {
        if (raw["id"] !== runId) continue;
        const trigger = raw["trigger"] as Record<string, unknown> | undefined;
        if (via === undefined && typeof trigger?.["via"] === "string") via = trigger["via"];
        if (continues === undefined && typeof raw["continues"] === "string") {
          continues = raw["continues"];
        }
      }
    } catch {
      // Unreadable: the run is not a person's and continues nothing, the stricter reading.
    }
  }
  const starter = starterOf(via as Parameters<typeof starterOf>[0]);
  return {
    runId,
    ...(continues !== undefined ? { continues } : {}),
    ...(starter !== undefined ? { starter } : {}),
  };
}

const scopeOf = (wi: string): string => formatResumeScope({ kind: "work", id: wi });

/** Whether a person granted exactly this change, and how the grant is spent. */
export function overLimitsPort(
  harnessDir: string,
  approvals: OverLimitsApprovals,
  spender: Spender,
): LimitsPort {
  return async (over) => {
    const hash = hashApprovalInput(OVER_LIMITS_TOOL, overLimitsInput(over));
    const scope = scopeOf(over.wi);
    const record = await approvals.store.get(OVER_LIMITS_TOOL, hash, { resumeScope: scope });
    if (record === null || record.decision !== "grant") return { approved: false };
    return {
      approved: true,
      spend: async () => {
        if (typeof approvals.store.consume === "function") {
          const answer = await approvals.store.consume(record.id, {
            ...spender,
            resumeScope: scope,
            resourceRevision: over.change,
            places: [],
            approvers: readApproverProjection(harnessDir),
            reask: false,
            ...(approvals.surface !== undefined ? { surface: approvals.surface } : {}),
          });
          return answer.outcome === "consumed";
        }
        await approvals.store.persist({ ...record, consumedAt: new Date().toISOString() });
        return true;
      },
    };
  };
}

export type RaisedOverLimits =
  | { readonly state: "pending"; readonly id: string }
  | { readonly state: "denied"; readonly id: string };

/** Ask for a decision on this change, once: a request already waiting is the same request. */
export async function raiseOverLimits(
  harnessDir: string,
  approvals: OverLimitsApprovals,
  over: OverLimits,
  rc: RunContext,
): Promise<RaisedOverLimits> {
  const input = overLimitsInput(over);
  const hash = hashApprovalInput(OVER_LIMITS_TOOL, input);
  const scope = scopeOf(over.wi);
  const existing = await approvals.store.get(OVER_LIMITS_TOOL, hash, { resumeScope: scope });
  if (existing !== null && existing.decision !== "grant") {
    return existing.decision === "deny"
      ? { state: "denied", id: existing.id }
      : { state: "pending", id: existing.id };
  }
  const spender = spenderOf(harnessDir, rc);
  const id = generateApprovalId();
  const surface = approvals.surface ?? "daemon";
  await approvals.store.persist({
    id,
    toolName: OVER_LIMITS_TOOL,
    inputHash: hash,
    input,
    places: [],
    runId: spender.runId,
    sessionId: rc.sessionId,
    surface,
    createdAt: new Date().toISOString(),
    requiredClass: "maintainer",
    binding: {
      runId: spender.runId,
      resumeScope: scope,
      sessionId: rc.sessionId,
      workItem: over.wi,
      ...(spender.starter !== undefined ? { starter: spender.starter } : {}),
      resourceRevision: over.change,
      resourceRevisionBound: true,
    },
  });
  rc.eventBus.publish({
    ...rc.eventBus.envelope(),
    kind: "approval_requested",
    approvalId: id,
    toolName: OVER_LIMITS_TOOL,
    surface,
  });
  if (approvals.notify !== undefined) {
    const record = await approvals.store.get(OVER_LIMITS_TOOL, hash, { resumeScope: scope });
    if (record !== null) await approvals.notify(record).catch(() => undefined);
  }
  return { state: "pending", id };
}
