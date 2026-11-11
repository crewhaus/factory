/**
 * How every reader folds the approvals rendezvous (#507, #513): first decision
 * wins, a claim outranks the file, and a read never writes.
 *
 * Until 0.9.0 the fold was last-wins: whichever surface wrote last decided, so a
 * Home grant and a CLI deny on the same request could overwrite each other, and a
 * 0.8.x compaction (which rewrote the file from each id's LAST line) could replace
 * the first decision with a later one. Now:
 *
 *  - while no line has set `decision`, the newest line wins (a deferral updates a
 *    pending request this way);
 *  - once a line has set it, a later line may only add `consumedAt` to an
 *    unconsumed grant, `consumedByRun`, or `supersededBy` with `supersededReason` to
 *    an unconsumed record. Every other field keeps its first-decided value, and a
 *    line whose `decision` differs is ignored and counted;
 *  - a readable decision claim (`approvals.d/claims/decision/<appr>.json`) outranks
 *    the file, because the claim is what decided and a compaction cannot rewrite it.
 *
 * A claim that cannot be read is reported as a fault and the file's record is left
 * as it is: a read never repairs. Repairs happen under the lock, in `decide.ts`.
 */
import { closeSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  APPROVAL_ID_RE,
  DECISION_LOG_REASONS,
  RECEIPT_VIA,
  type ReceiptVia,
  STORED_LOCAL_ACTOR_RE,
  type SupersedeReason,
  isId,
} from "@crewhaus/control-contract";
import { type ClaimContent, readClaim } from "@crewhaus/control-records";
import { openForReadFd, resolveContained } from "@crewhaus/tool-safety/fs";
import { fencePath } from "../fence";
import type { ApprovalDecision, PendingApproval } from "../index";
import { APPROVALS_CLAIMS_DIR, DEFAULT_APPROVALS_FILENAME, approvalsLedger } from "./log";

/**
 * A rendezvous record: seven required strings, nothing else. Tolerant on purpose,
 * so a field a later release adds never makes a record unreadable to an older one.
 */
export function isPendingApprovalShape(value: unknown): value is PendingApproval {
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

/**
 * Whether an approval has aged past the cutoff.
 *
 * An UNPARSEABLE `createdAt` counts as EXPIRED. `isPendingApprovalShape` only
 * requires a string, so a hand-edited or corrupted line would otherwise
 * survive every compaction forever — and these records embed the raw tool
 * input, which is by construction a call some policy deemed sensitive enough
 * to need a human. For a file holding that, failing open on a bad timestamp
 * is the wrong direction.
 */
export function approvalIsExpired(approval: PendingApproval, cutoffMs: number): boolean {
  const created = Date.parse(approval.createdAt);
  if (!Number.isFinite(created)) return true;
  return created < cutoffMs;
}

/** The approvals file for a root, through the tenant fence. */
export function approvalsFilePath(rootDir: string): string {
  return fencePath(resolve(rootDir, DEFAULT_APPROVALS_FILENAME));
}

export type ApprovalFold = {
  /** One record per id, in file order of each id's first line. */
  readonly records: PendingApproval[];
  /** Lines that tried to change a decision already made, and were ignored. */
  readonly ignored: number;
  /** The same count, per id, for a reader that shows one record. */
  readonly ignoredById: ReadonlyMap<string, number>;
};

/** What a later line may add to a decided record, and nothing else. */
function addToDecided(current: PendingApproval, line: PendingApproval): PendingApproval {
  let next = current;
  const extra = line as PendingApproval & { readonly consumedByRun?: unknown };
  if (
    current.decision === "grant" &&
    current.consumedAt === undefined &&
    typeof line.consumedAt === "string"
  ) {
    next = { ...next, consumedAt: line.consumedAt };
  }
  if (
    (next as { consumedByRun?: unknown }).consumedByRun === undefined &&
    typeof extra.consumedByRun === "string"
  ) {
    // The run that spent a grant, carried through when a writer records it.
    next = { ...next, consumedByRun: extra.consumedByRun } as PendingApproval;
  }
  if (
    current.consumedAt === undefined &&
    current.supersededBy === undefined &&
    typeof line.supersededBy === "string"
  ) {
    next = {
      ...next,
      supersededBy: line.supersededBy,
      ...(typeof line.supersededReason === "string"
        ? { supersededReason: line.supersededReason }
        : {}),
    };
  }
  return next;
}

/**
 * Fold rendezvous lines, already parsed, into one record per id: first decision
 * wins (see the module docblock). Pure: it reads no file and no claim.
 */
export function foldApprovalRecords(objects: Iterable<unknown>): ApprovalFold {
  const byId = new Map<string, PendingApproval>();
  const ignoredById = new Map<string, number>();
  let ignored = 0;
  for (const value of objects) {
    if (!isPendingApprovalShape(value)) continue;
    const current = byId.get(value.id);
    if (current === undefined || current.decision === undefined) {
      byId.set(value.id, value);
      continue;
    }
    if (value.decision !== current.decision) {
      ignored += 1;
      ignoredById.set(value.id, (ignoredById.get(value.id) ?? 0) + 1);
      continue;
    }
    byId.set(value.id, addToDecided(current, value));
  }
  return { records: [...byId.values()], ignored, ignoredById };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** What a decision claim records: enough to rebuild the decided line. */
export type DecisionClaim = {
  readonly choice: ApprovalDecision;
  readonly decidedAt: string;
  readonly decidedBy?: string;
  readonly decidedByPrincipal?: string;
  readonly decidedVia?: ReceiptVia;
  readonly always?: true;
};

/** What a supersede claim records: the fresh request and why. */
export type SupersedeClaim = {
  readonly supersededBy: string;
  readonly reason: SupersedeReason;
  /** When the fresh request was parked, so a repair parks it with the same time. */
  readonly parkedAt: string;
};

export type ClaimFault = { readonly id: string; readonly reason: string };

export type ReadDecisionClaim = { readonly content: ClaimContent; readonly claim: DecisionClaim };
export type ReadSupersedeClaim = {
  readonly content: ClaimContent;
  readonly claim: SupersedeClaim;
};

export type ClaimsRead = {
  readonly decisions: ReadonlyMap<string, ReadDecisionClaim>;
  readonly supersedes: ReadonlyMap<string, ReadSupersedeClaim>;
  readonly faults: readonly ClaimFault[];
};

function isStoredPrincipal(value: unknown): boolean {
  return isId("prn", value) || (typeof value === "string" && STORED_LOCAL_ACTOR_RE.test(value));
}

/** A decision claim's record, or why it is not one. */
export function parseDecisionClaim(
  record: Readonly<Record<string, unknown>>,
): DecisionClaim | string {
  const { choice, decidedAt, decidedBy, decidedByPrincipal, decidedVia, always } = record;
  if (choice !== "grant" && choice !== "deny") return "its choice is not grant or deny";
  if (typeof decidedAt !== "string") return "its decidedAt is not a string";
  if (decidedBy !== undefined && typeof decidedBy !== "string") {
    return "its decidedBy is not a string";
  }
  if (decidedByPrincipal !== undefined && !isStoredPrincipal(decidedByPrincipal)) {
    return "its decidedByPrincipal is not a stored actor";
  }
  if (decidedVia !== undefined && !(RECEIPT_VIA as readonly unknown[]).includes(decidedVia)) {
    return "its decidedVia is not a known surface";
  }
  if (always !== undefined && always !== true) return "its always is not true";
  return {
    choice,
    decidedAt,
    ...(typeof decidedBy === "string" ? { decidedBy } : {}),
    ...(typeof decidedByPrincipal === "string" ? { decidedByPrincipal } : {}),
    ...(decidedVia !== undefined ? { decidedVia: decidedVia as ReceiptVia } : {}),
    ...(always === true && choice === "grant" ? { always: true as const } : {}),
  };
}

/** A supersede claim's record, or why it is not one. */
export function parseSupersedeClaim(
  record: Readonly<Record<string, unknown>>,
): SupersedeClaim | string {
  const { supersededBy, reason, parkedAt } = record;
  if (typeof supersededBy !== "string" || !APPROVAL_ID_RE.test(supersededBy)) {
    return "its supersededBy is not an approval id";
  }
  if (!(DECISION_LOG_REASONS.supersede as readonly unknown[]).includes(reason)) {
    return "its reason is not a supersede reason";
  }
  if (typeof parkedAt !== "string") return "its parkedAt is not a string";
  return { supersededBy, reason: reason as SupersedeReason, parkedAt };
}

/** The record with a decision claim applied: the claim's decision fields replace the file's. */
export function applyDecisionClaim(record: PendingApproval, claim: DecisionClaim): PendingApproval {
  const {
    decision: _decision,
    decidedBy: _decidedBy,
    decidedAt: _decidedAt,
    decidedByPrincipal: _principal,
    decidedVia: _via,
    always: _always,
    ...rest
  } = record;
  return {
    ...rest,
    decision: claim.choice,
    ...(claim.decidedBy !== undefined ? { decidedBy: claim.decidedBy } : {}),
    decidedAt: claim.decidedAt,
    ...(claim.decidedByPrincipal !== undefined
      ? { decidedByPrincipal: claim.decidedByPrincipal }
      : {}),
    ...(claim.decidedVia !== undefined ? { decidedVia: claim.decidedVia } : {}),
    ...(claim.always === true ? { always: true } : {}),
  };
}

/** The record with a supersede claim applied. */
export function applySupersedeClaim(
  record: PendingApproval,
  claim: SupersedeClaim,
): PendingApproval {
  return { ...record, supersededBy: claim.supersededBy, supersededReason: claim.reason };
}

/**
 * The claim names of one kind on disk, or `undefined` when the directory exists and
 * cannot be listed (every claim is then read one by one, and refused one by one).
 */
function claimIds(root: string, kind: string): ReadonlySet<string> | undefined {
  const at = resolveContained(root, join(APPROVALS_CLAIMS_DIR, kind));
  if (!at.ok) return at.code === "not-found" ? new Set() : undefined;
  let names: readonly string[];
  try {
    names = readdirSync(at.real);
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? new Set() : undefined;
  }
  const ids = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".json")) ids.add(name.slice(0, -".json".length));
  }
  return ids;
}

/**
 * The decision and supersede claims for `ids`, read with control-records'
 * `readClaim` on the session root's ledger. Synchronous; creates nothing. Each
 * claims directory is listed once, and a claim is read only for an id in `ids`.
 */
export function readClaims(rootDir: string, ids: Iterable<string>): ClaimsRead {
  const ledger = approvalsLedger(rootDir);
  const decisionIds = claimIds(ledger.root, "decision");
  const supersedeIds = claimIds(ledger.root, "supersede");
  const decisions = new Map<string, ReadDecisionClaim>();
  const supersedes = new Map<string, ReadSupersedeClaim>();
  const faults: ClaimFault[] = [];
  const read = <T>(
    kind: string,
    id: string,
    listed: ReadonlySet<string> | undefined,
    parse: (record: Readonly<Record<string, unknown>>) => T | string,
  ): { readonly content: ClaimContent; readonly claim: T } | undefined => {
    if (listed !== undefined && !listed.has(id)) return undefined;
    const answer = readClaim(ledger, `${kind}/${id}`);
    if (!answer.ok) {
      if (answer.code !== "not-found") faults.push({ id, reason: answer.reason });
      return undefined;
    }
    const claim = parse(answer.content.record);
    if (typeof claim === "string") {
      faults.push({ id, reason: `the ${kind} claim for ${id} is not readable: ${claim}` });
      return undefined;
    }
    return { content: answer.content, claim };
  };
  for (const id of ids) {
    if (!APPROVAL_ID_RE.test(id)) continue;
    const decision = read("decision", id, decisionIds, parseDecisionClaim);
    if (decision !== undefined) decisions.set(id, decision);
    const supersede = read("supersede", id, supersedeIds, parseSupersedeClaim);
    if (supersede !== undefined) supersedes.set(id, supersede);
  }
  return { decisions, supersedes, faults };
}

/** `records` with every readable claim applied. */
export function applyClaims(
  records: readonly PendingApproval[],
  claims: ClaimsRead,
): PendingApproval[] {
  return records.map((record) => {
    let next = record;
    const decision = claims.decisions.get(record.id);
    if (decision !== undefined) next = applyDecisionClaim(next, decision.claim);
    const supersede = claims.supersedes.get(record.id);
    if (supersede !== undefined) next = applySupersedeClaim(next, supersede.claim);
    return next;
  });
}

export type ClaimOverlay = {
  readonly records: PendingApproval[];
  /** Claims that exist and could not be read: their records are left as the file says. */
  readonly faults: readonly ClaimFault[];
};

/**
 * Apply the session root's decision and supersede claims to folded records. A
 * readable decision claim outranks the file; a supersede claim sets `supersededBy`
 * and `supersededReason`. Synchronous and read-only: it creates nothing, and a
 * claim it cannot read is a fault, never a repair.
 */
export function overlayDecisionClaims(
  rootDir: string,
  records: readonly PendingApproval[],
): ClaimOverlay {
  const claims = readClaims(
    rootDir,
    records.map((r) => r.id),
  );
  return { records: applyClaims(records, claims), faults: claims.faults };
}

// ---------------------------------------------------------------------------
// The read-only fold
// ---------------------------------------------------------------------------

export type ApprovalsFileRead =
  | { readonly state: "absent" }
  | { readonly state: "read"; readonly objects: readonly unknown[] }
  | {
      readonly state: "unreadable";
      readonly path: string;
      readonly reason: string;
      readonly code: string;
    };

/**
 * `approvals.jsonl` read whole and parsed line by line, never through a link at the
 * name. A line that does not parse is skipped (a torn final line is a write still
 * landing). Whole, because a write path folds through it: a capped read is a view.
 */
export function readApprovalsFile(rootDir: string): ApprovalsFileRead {
  const abs = approvalsFilePath(rootDir);
  const opened = openForReadFd(dirname(abs), basename(abs), { followLeafSymlink: false });
  if (!opened.ok) {
    return opened.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", path: abs, reason: opened.reason, code: opened.code };
  }
  let text: string;
  try {
    text = readFileSync(opened.fd, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      state: "unreadable",
      path: abs,
      reason: `${abs} could not be read${typeof code === "string" ? `: ${code}` : ""}`,
      code: "io-error",
    };
  } finally {
    closeSync(opened.fd);
  }
  const objects: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      // A torn or foreign line: a reader never aborts on one.
    }
  }
  return { state: "read", objects };
}

export type ReadOnlyFold = {
  readonly state: "absent" | "read" | "unreadable";
  readonly records: PendingApproval[];
  readonly ignored: number;
  readonly ignoredById: ReadonlyMap<string, number>;
  readonly faults: readonly ClaimFault[];
  /** Why the file could not be read, when `state` is `unreadable`. */
  readonly reason?: string;
};

/**
 * Every record in a session root's approvals, folded first-decision-wins with its
 * claims applied. Synchronous, and it writes nothing: no rewrite of the file, no
 * `approvals.d/`, no key. Records come back in file order; nothing is filtered by
 * age, so a caller decides what it shows.
 */
export function foldReadOnly(rootDir: string): ReadOnlyFold {
  const read = readApprovalsFile(rootDir);
  if (read.state !== "read") {
    return {
      state: read.state,
      records: [],
      ignored: 0,
      ignoredById: new Map(),
      faults: [],
      ...(read.state === "unreadable" ? { reason: read.reason } : {}),
    };
  }
  const folded = foldApprovalRecords(read.objects);
  const overlay = overlayDecisionClaims(rootDir, folded.records);
  return {
    state: "read",
    records: overlay.records,
    ignored: folded.ignored,
    ignoredById: folded.ignoredById,
    faults: overlay.faults,
  };
}
