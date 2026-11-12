/**
 * The layout of `<sessionRoot>/approvals.d/` and the content-free decision log
 * (#507, #513).
 *
 * `approvals.jsonl` stays the rendezvous a parked run re-reads. Beside it,
 * `approvals.d/` holds what decides and what records:
 *
 *   approvals.d/lock                         orders every write to both files
 *   approvals.d/claims/decision/appr_….json  the first decision, created exclusively
 *   approvals.d/claims/supersede/appr_….json the one supersede of a record
 *   approvals.d/claims/consume/appr_….json   the one spend of a grant
 *   approvals.d/decisions/NNNNNN.jsonl       the decision log, segmented by size
 *   approvals.d/keys/digest.key              the key its digests are made with (0600)
 *
 * A log line holds ids, keyed digests, a member id or a keyed digest of the local
 * user, times and codes from closed lists: never tool input, free text or a user
 * name. Its keys are `DECISION_LOG_KEYS` (control-contract). The log is never
 * compacted: the TTL sweep writes an `expire` and an `evict` line before it drops a
 * rendezvous record, so the record of what was decided outlives the record of what
 * was asked.
 *
 * The digest key sits beside the session root, not in the harness directory: the
 * store is handed a session root and never learns which harness owns it, and inside
 * a tenant scope every path it writes must stay under the tenant's session root.
 */
import { join, resolve } from "node:path";
import {
  type CursorPosition,
  DECISION_LOG_REASONS,
  type DecisionLogEvent,
  canonicalJson,
} from "@crewhaus/control-contract";
import {
  type DigestKeyRead,
  type Ledger,
  keyedDigest,
  readDigestKey,
  readPage,
} from "@crewhaus/control-records";
import type { ApprovalDecision, ApprovalToPersist, PendingApproval } from "../index";

/** The rendezvous file, beside the session files. */
export const DEFAULT_APPROVALS_FILENAME = "approvals.jsonl";
/** The directory beside it that holds the lock, the claims, the log and the key. */
export const APPROVALS_DIRNAME = "approvals.d";
/** Relative to the session root. */
export const APPROVALS_LOCK_FILE = join(APPROVALS_DIRNAME, "lock");
/** Relative to the session root. */
export const APPROVALS_CLAIMS_DIR = join(APPROVALS_DIRNAME, "claims");
/** Relative to the session root. */
export const DECISION_LOG_DIR = join(APPROVALS_DIRNAME, "decisions");
/** Relative to the session root. Never served by any reader. */
export const APPROVALS_DIGEST_KEY_FILE = join(APPROVALS_DIRNAME, "keys", "digest.key");

/**
 * The label of the action digest: one function for the decision log's
 * `inputDigest` and for anything that later joins a verdict to the action it was
 * asked about. Pinned by a test, because stored digests join forever.
 */
export const ACTION_DIGEST_LABEL = "decision.action";
/** The label of a parked call's places digest. */
export const PLACES_DIGEST_LABEL = "decision.places";
/** The label of a binding's digest, over the sealed binding's canonical JSON. */
export const BINDING_DIGEST_LABEL = "decision.binding";
/** The label of an unlinked local actor's stored form, `local:#<digest>`. */
export const LOCAL_ACTOR_LABEL = "local-actor";

/** The session root's ledger: its log segments, its lock and its claims. */
export function approvalsLedger(rootDir: string): Ledger {
  return {
    root: resolve(rootDir),
    records: { dir: DECISION_LOG_DIR },
    lock: APPROVALS_LOCK_FILE,
    claims: APPROVALS_CLAIMS_DIR,
  };
}

/** The keyed digest of a parked call's `inputHash`. */
export function inputDigestOf(key: CryptoKey, inputHash: string): Promise<string> {
  return keyedDigest(key, ACTION_DIGEST_LABEL, [inputHash]);
}

/** The keyed digest of a parked call's canonical places; no places digest as `[]`. */
export function placesDigestOf(key: CryptoKey, places: unknown): Promise<string> {
  return keyedDigest(key, PLACES_DIGEST_LABEL, [
    canonicalJson(Array.isArray(places) ? places : []),
  ]);
}

/** The keyed digest of a sealed binding: its canonical JSON. */
export function bindingDigestOf(key: CryptoKey, binding: unknown): Promise<string> {
  return keyedDigest(key, BINDING_DIGEST_LABEL, [canonicalJson(binding)]);
}

/**
 * The record with its binding sealed: the binding's `placesDigest` made from the
 * record's own `places`, then the record's `bindingDigest` over the binding. A
 * record without a binding comes back as it is. Every writer that parks a bound
 * record seals it here, so a binding is sealed the same way however it is parked;
 * a `placesDigest` a caller supplied is replaced, never trusted.
 */
export async function sealBinding(
  key: CryptoKey,
  record: ApprovalToPersist,
): Promise<PendingApproval> {
  const { binding, bindingDigest: _unsealed, ...rest } = record;
  if (binding === undefined) return rest as PendingApproval;
  const sealed = { ...binding, placesDigest: await placesDigestOf(key, record.places) };
  return { ...rest, binding: sealed, bindingDigest: await bindingDigestOf(key, sealed) };
}

/** `local:<user>@<host>` as an append-only record may hold it: `local:#<keyed digest>`. */
export async function storedLocalActor(key: CryptoKey, localActor: string): Promise<string> {
  return `local:#${await keyedDigest(key, LOCAL_ACTOR_LABEL, [localActor])}`;
}

/**
 * The session root's digest key, read. Creates nothing: a root that never wrote a
 * decision answers `absent`.
 */
export function approvalsDigestKey(rootDir: string): Promise<DigestKeyRead> {
  return readDigestKey(resolve(rootDir), { file: APPROVALS_DIGEST_KEY_FILE });
}

/** One decision-log line. Every key is one of `DECISION_LOG_KEYS`. */
export type DecisionLogLine = {
  readonly v: 1;
  readonly at: string;
  readonly event: DecisionLogEvent;
  /** The `appr_` id. */
  readonly decision: string;
  readonly runId?: string;
  readonly sessionId: string;
  /** The tool's name. */
  readonly tool: string;
  readonly inputDigest: string;
  readonly placesDigest: string;
  /** The record's keyed binding digest, on every line for a bound record. */
  readonly bindingDigest?: string;
  /** The stored actor: a `prn_` id or `local:#<digest>`. */
  readonly by?: string;
  /** Where it came from: the record's surface, or the door a decision came through. */
  readonly surface: string;
  readonly outcome?: "repaired";
  readonly reason?: string;
  readonly until?: string;
  readonly choice?: ApprovalDecision;
};

export type LogLineFields = {
  readonly event: DecisionLogEvent;
  readonly at: string;
  readonly surface: string;
  readonly by?: string;
  readonly choice?: ApprovalDecision;
  readonly reason?: string;
  readonly until?: string;
  readonly outcome?: "repaired";
};

/**
 * Build a log line for `record`. A `reason` must come from the event's closed list:
 * anything else is a programming error, and throws before anything is written.
 */
export async function decisionLogLine(
  key: CryptoKey,
  record: PendingApproval,
  fields: LogLineFields,
): Promise<DecisionLogLine> {
  if (fields.reason !== undefined) {
    const allowed: readonly string[] =
      (DECISION_LOG_REASONS as Readonly<Record<string, readonly string[]>>)[fields.event] ?? [];
    if (!allowed.includes(fields.reason)) {
      throw new TypeError(
        `session-store: "${fields.reason}" is not a ${fields.event} reason (one of: ${allowed.join(", ") || "none"})`,
      );
    }
  }
  return {
    v: 1,
    at: fields.at,
    event: fields.event,
    decision: record.id,
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    sessionId: record.sessionId,
    tool: record.toolName,
    inputDigest: await inputDigestOf(key, record.inputHash),
    placesDigest: await placesDigestOf(key, record.places),
    // A keyed digest only: a binding names runs and sessions, which stay in the record.
    ...(typeof record.bindingDigest === "string" && /^[0-9a-f]{64}$/.test(record.bindingDigest)
      ? { bindingDigest: record.bindingDigest }
      : {}),
    ...(fields.by !== undefined ? { by: fields.by } : {}),
    surface: fields.surface,
    ...(fields.outcome !== undefined ? { outcome: fields.outcome } : {}),
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    ...(fields.until !== undefined ? { until: fields.until } : {}),
    ...(fields.choice !== undefined ? { choice: fields.choice } : {}),
  };
}

/** Lines read per page when a repair looks for a line. */
const LOG_SCAN_PAGE = 512;

/**
 * Whether the log holds a line `match` accepts, in segment `fromSeg` or later. It
 * reads newest first and stops at the first segment below `fromSeg`, so a repair
 * reads only the segments a claim's line can be in. A segment it cannot read counts
 * as holding nothing, so the line is written again: a repeated line is harmless,
 * and a missing one is not.
 */
export function logHasLine(
  ledger: Ledger,
  fromSeg: number,
  match: (line: Readonly<Record<string, unknown>>) => boolean,
): boolean {
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, {
      limit: LOG_SCAN_PAGE,
      ...(before !== undefined ? { before } : {}),
    });
    for (const item of page.items) {
      if (item.at.seg < fromSeg) return false;
      if (match(item.record)) return true;
    }
    if (page.next === undefined) return false;
    before = page.next;
  }
}
