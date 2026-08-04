/**
 * The fleet approvals inbox — every harness's parked tool-approval requests
 * in one list, and the two writes that settle them.
 *
 * READS FOLD, THEY NEVER LIST. `PendingApprovalStore.list()` COMPACTS the
 * backing file as a side-effect (it drops expired and superseded lines),
 * exactly like `SessionStore.list()`'s TTL eviction. An inbox is polled;
 * polling must never rewrite an operator's approvals ledger. So reads fold
 * the JSONL directly — last-wins by `id`, the upsert rule `persist`
 * documents — through the capped, torn-tolerant reader every other view in
 * this package uses.
 *
 * WRITES GO THROUGH THE SANCTIONED STORE. Grant and deny call
 * `createPendingApprovalStore(...).resolve(id, decision, by)`, which appends
 * an updated record. Hand-editing the file would work today and diverge the
 * moment the record shape moves; more importantly, the CLI
 * (`crewhaus approvals`) and the runtime's re-resolve path read through the
 * store, and a manager that wrote a shape they do not recognize would park
 * the run forever.
 *
 * THE FILE LIVES WHERE THE SESSIONS DO. `approvals.jsonl` sits beside the
 * session files, so a harness that relocated its session root with
 * `CREWHAUS_SESSION_DIR` relocated its approvals too — the inbox resolves
 * the root the same env-override-aware, containment-checked way the sessions
 * browser does (§3.7).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type ApprovalDecision,
  type PendingApproval,
  createPendingApprovalStore,
} from "@crewhaus/session-store";
import { readJsonlCapped } from "./jsonl";
import { maskDeep } from "./mask";
import { resolveContained } from "./safety";
import { resolveSessionRoot } from "./sessions";

export const APPROVALS_FILENAME = "approvals.jsonl";
export const APPROVAL_ID_RE = /^appr_[0-9a-f]{16}$/;

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
  readonly status: "pending" | "granted" | "denied" | "consumed";
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
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

function isApprovalShape(value: unknown): value is PendingApproval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["inputHash"] === "string" &&
    typeof v["runId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["surface"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

function statusOf(a: PendingApproval): ApprovalRow["status"] {
  if (a.consumedAt !== undefined) return "consumed";
  if (a.decision === "grant") return "granted";
  if (a.decision === "deny") return "denied";
  return "pending";
}

/** The approvals log for a harness, containment-checked at its RESOLVED
 *  session root (undefined when the root escapes the harness dir). */
export function approvalsPathFor(harnessDir: string): string | undefined {
  const { root } = resolveSessionRoot(harnessDir);
  return resolveContained(root, APPROVALS_FILENAME);
}

/** Fold one harness's approvals log. Never compacts, never evicts. */
export function foldApprovals(harnessDir: string): {
  readonly approvals: readonly PendingApproval[];
  readonly truncated: boolean;
} {
  const path = approvalsPathFor(harnessDir);
  if (path === undefined || !existsSync(path)) return { approvals: [], truncated: false };
  const read = readJsonlCapped(path);
  const byId = new Map<string, PendingApproval>();
  for (const obj of read.objects) {
    if (isApprovalShape(obj)) byId.set(obj.id, obj);
  }
  return { approvals: [...byId.values()], truncated: read.truncated };
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
  | { readonly outcome: "unreachable"; readonly reason: string };

/**
 * Record a decision THROUGH the sanctioned store, so the CLI verbs and the
 * runtime's re-resolve path see exactly the record they expect.
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
  const updated = await store.resolve(args.approvalId, args.decision, args.by);
  if (updated === null) return { outcome: "not-found" };
  return { outcome: "resolved", approval: updated };
}

/** Count pending approvals for one harness — the cheap fleet-badge read. */
export function pendingApprovalCount(harnessDir: string): number {
  return foldApprovals(harnessDir).approvals.filter((a) => statusOf(a) === "pending").length;
}

/** The default (un-relocated) approvals path, for messages. */
export function defaultApprovalsPath(harnessDir: string): string {
  return join(harnessDir, ".crewhaus", "sessions", APPROVALS_FILENAME);
}
