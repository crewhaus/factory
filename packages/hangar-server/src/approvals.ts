/**
 * The fleet approvals inbox — every harness's parked tool-approval requests
 * in one list, and the two writes that settle them.
 *
 * READS FOLD, THEY NEVER LIST. An inbox is polled; polling must never
 * rewrite an operator's approvals ledger. So reads take the JSONL through
 * control-records' tail reader, under the same caps as every other view in
 * this package but from the file's NEWEST end, so a large file shows its
 * latest asks, and fold it the store's way (`foldWithClaims`): the first
 * decision on a request wins, and the decision claims beside the file outrank
 * it, so a line that disagrees with a claim never folds. A final line with no
 * newline is a write still landing: it waits for the next read.
 *
 * WRITES GO THROUGH THE SANCTIONED STORE. Grant and deny call the store's
 * `decide`, which takes the session root's lock and publishes an exclusive
 * decision claim: the first decision on a request wins, from Home, the CLI or
 * a channel, and a later one is answered with the winner. The CLI
 * (`crewhaus approvals`) and the runtime's re-resolve path read through the
 * same store, so a manager can never write a shape they do not recognize.
 *
 * THE FILE LIVES WHERE THE SESSIONS DO. `approvals.jsonl` sits beside the
 * session files, so a harness that relocated its session root with
 * `CREWHAUS_SESSION_DIR` relocated its approvals too — the inbox resolves
 * the root the same env-override-aware, containment-checked way the sessions
 * browser does (§3.7).
 */
import { join } from "node:path";
import { APPROVAL_ID_RE } from "@crewhaus/control-contract";
import { readTail } from "@crewhaus/control-records";
import {
  type ApprovalDecision,
  type PendingApproval,
  createPendingApprovalStore,
  foldWithClaims,
  ownerAuthorizer,
} from "@crewhaus/session-store";
import { MAX_JSONL_BYTES, MAX_JSONL_LINES } from "./constants";
import { maskDeep } from "./mask";
import { resolveContained } from "./safety";
import { resolveSessionRoot } from "./sessions";

export const APPROVALS_FILENAME = "approvals.jsonl";
export { APPROVAL_ID_RE };

export function isApprovalId(id: string): boolean {
  return APPROVAL_ID_RE.test(id);
}

/** One inbox row. The tool input is rendered VERBATIM (masked) — an approver
 *  cannot judge a call they cannot see. */
export type ApprovalRow = {
  readonly id: string;
  readonly harnessId: string;
  readonly harnessDir: string;
  readonly specName: string;
  readonly toolName: string;
  /** Verbatim tool input, credential-masked. */
  readonly input: unknown;
  readonly inputHash: string;
  readonly surface: string;
  readonly createdAt: string;
  readonly status: "pending" | "granted" | "granted-always" | "denied" | "consumed" | "superseded";
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  /** #383 — the grant was recorded as a standing allow (an `alwaysAllow`
   *  rule in the harness's `.crewhaus/settings.json` covers the tool). */
  readonly always?: boolean;
  /** The run that parked on this approval — the grant-and-resume link. */
  readonly runId: string;
  readonly sessionId: string;
  /** The `crewhaus daemon`/run route a UI links to for the parked run. */
  readonly parkedRun: {
    readonly harnessId: string;
    readonly runId: string;
    readonly sessionId: string;
  };
};

export type ApprovalsView = {
  readonly approvals: readonly ApprovalRow[];
  readonly pending: number;
  /** Harness ids whose approvals file was capped mid-read. */
  readonly truncatedHarnesses: readonly string[];
};

function statusOf(a: PendingApproval): ApprovalRow["status"] {
  // A replaced request is settled whatever it said before; first, as
  // `effectiveDecisionState` puts it.
  if (a.supersededBy !== undefined) return "superseded";
  // #383 — a standing allow is the terminal state whether or not the parked
  // call was since consumed (mirrors the CLI's approvalStatus).
  if (a.decision === "grant" && a.always === true) return "granted-always";
  if (a.consumedAt !== undefined) return "consumed";
  if (a.decision === "grant") return "granted";
  if (a.decision === "deny") return "denied";
  return "pending";
}

/** Fold one harness's approvals log the store's way: first decision wins, and
 *  the decision claims beside it outrank it. Never compacts, never evicts,
 *  never repairs. The log is contained at its RESOLVED session root, which may
 *  itself be a link, as the sessions browser's is; a log that is a link out of
 *  that root lists nothing. */
export function foldApprovals(harnessDir: string): {
  readonly approvals: readonly PendingApproval[];
  readonly truncated: boolean;
} {
  const { root } = resolveSessionRoot(harnessDir);
  const read = readTail(root, APPROVALS_FILENAME, {
    maxLines: MAX_JSONL_LINES,
    maxBytes: MAX_JSONL_BYTES,
    followLeafSymlink: true,
  });
  if (read.state !== "read") return { approvals: [], truncated: false };
  const approvals = foldWithClaims(root, read.records).records;
  return { approvals, truncated: read.truncated };
}

export type ApprovalHarness = {
  readonly id: string;
  readonly dir: string;
  readonly specName: string;
};

/** Fold every registered harness's approvals into one inbox, newest first. */
export function approvalsInbox(
  harnesses: readonly ApprovalHarness[],
  opts: { readonly includeSettled?: boolean } = {},
): ApprovalsView {
  const rows: ApprovalRow[] = [];
  const truncatedHarnesses: string[] = [];
  for (const harness of harnesses) {
    const { approvals, truncated } = foldApprovals(harness.dir);
    if (truncated) truncatedHarnesses.push(harness.id);
    for (const a of approvals) {
      const status = statusOf(a);
      if (opts.includeSettled !== true && status !== "pending") continue;
      rows.push({
        id: a.id,
        harnessId: harness.id,
        harnessDir: harness.dir,
        specName: harness.specName,
        toolName: a.toolName,
        // Verbatim, then masked: the approver sees the real call, never a
        // credential that happened to be an argument to it.
        input: maskDeep(a.input ?? null),
        inputHash: a.inputHash,
        surface: a.surface,
        createdAt: a.createdAt,
        status,
        decidedBy: a.decidedBy ?? null,
        decidedAt: a.decidedAt ?? null,
        ...(a.always === true ? { always: true } : {}),
        runId: a.runId,
        sessionId: a.sessionId,
        parkedRun: { harnessId: harness.id, runId: a.runId, sessionId: a.sessionId },
      });
    }
  }
  rows.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
  return {
    approvals: rows,
    pending: rows.filter((r) => r.status === "pending").length,
    truncatedHarnesses,
  };
}

export type ResolveApprovalResult =
  | { readonly outcome: "resolved"; readonly approval: PendingApproval }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "unreachable"; readonly reason: string }
  /** Another decision came first; `approval` is the record as it left it. */
  | { readonly outcome: "already-decided"; readonly approval: PendingApproval }
  /** The request is spent or replaced, so there is nothing left to decide. */
  | { readonly outcome: "stale"; readonly approval: PendingApproval }
  | { readonly outcome: "expired"; readonly approval: PendingApproval }
  | { readonly outcome: "forbidden"; readonly reason: string };

/**
 * Record a decision THROUGH the sanctioned store's `decide`, so the CLI verbs
 * and the runtime's re-resolve path see exactly the record they expect, and
 * the first decision wins: a request already decided from any surface answers
 * `already-decided`. The decision is recorded as coming through Home, and the
 * harness's approver projection says who it is recorded as (`ownerAuthorizer`).
 *
 * `ttlDays` is passed as `Number.MAX_SAFE_INTEGER` deliberately: `resolve`
 * folds the file to find the record, and a manager settling an approval that
 * happens to be a day past its TTL should say "not found" for the right
 * reason (the record is gone) rather than silently miss a record still on
 * disk. Eviction stays the store's own job, on its own schedule.
 */
export async function resolveApproval(args: {
  readonly harnessDir: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  readonly by: string;
  readonly now?: () => Date;
}): Promise<ResolveApprovalResult> {
  if (!isApprovalId(args.approvalId)) return { outcome: "not-found" };
  const { root } = resolveSessionRoot(args.harnessDir);
  if (resolveContained(root, APPROVALS_FILENAME) === undefined) {
    return { outcome: "unreachable", reason: "the session root escapes the harness dir" };
  }
  const store = createPendingApprovalStore({
    rootDir: root,
    ttlDays: Number.MAX_SAFE_INTEGER,
    ...(args.now !== undefined ? { now: args.now } : {}),
  });
  const answer = await store.decide(
    args.approvalId,
    { choice: args.decision, actor: { display: args.by }, via: "home" },
    { authorize: ownerAuthorizer(args.harnessDir) },
  );
  switch (answer.outcome) {
    case "decided":
      return answer.record === null
        ? { outcome: "not-found" }
        : { outcome: "resolved", approval: answer.record };
    case "not-found":
      return { outcome: "not-found" };
    case "forbidden":
      return {
        outcome: "forbidden",
        reason: answer.reason ?? "not allowed to decide this request",
      };
    case "already-decided":
    case "stale":
    case "expired":
      return answer.record === null
        ? { outcome: "not-found" }
        : { outcome: answer.outcome, approval: answer.winner ?? answer.record };
  }
}

/**
 * What the route says when a decision is refused: fixed text naming the state,
 * never who decided (`decidedBy` is free text a surface supplied).
 */
export function refusedDecisionMessage(
  outcome: "already-decided" | "stale" | "expired",
  approval: PendingApproval,
): string {
  if (outcome === "expired") return "This request has expired.";
  if (approval.supersededBy !== undefined && approval.supersededReason === "run-cancelled") {
    return "This request was withdrawn: its run was cancelled.";
  }
  if (approval.supersededBy !== undefined) return "This request was replaced by a newer one.";
  if (approval.consumedAt !== undefined) return "This request was already used.";
  if (approval.decision === "grant") return "This request was already granted.";
  if (approval.decision === "deny") return "This request was already denied.";
  return "This request was already settled.";
}

/** Count pending approvals for one harness — the cheap fleet-badge read. */
export function pendingApprovalCount(harnessDir: string): number {
  return foldApprovals(harnessDir).approvals.filter((a) => statusOf(a) === "pending").length;
}

/** The default (un-relocated) approvals path, for messages. */
export function defaultApprovalsPath(harnessDir: string): string {
  return join(harnessDir, ".crewhaus", "sessions", APPROVALS_FILENAME);
}
