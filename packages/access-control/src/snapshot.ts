/**
 * One immutable view of `<hangarRoot>/access`: every ledger folded by `id`, the revision
 * and the subjects file. Loading takes no lock and creates nothing. The revision is read
 * first, so a reader that reloads when the epoch moves never pairs old rows with a newer
 * epoch and then stops reloading.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { foldStates } from "@crewhaus/control-records";
import { EMPTY_SUBJECTS, type Subjects, readRevision, readSubjects } from "./files";
import { LEDGER_KINDS, type LedgerKind, accessLedger, accessPaths } from "./paths";
import {
  type CredentialRow,
  type GovernedRow,
  type GrantRow,
  type InviteRow,
  type LinkRow,
  type PrincipalRow,
  type RowOf,
  isRowOf,
  stripBookkeeping,
} from "./records";

export type AccessSnapshot = {
  /** The access revision: 0 before the first change. */
  readonly epoch: number;
  /** The home owner: the principal the bootstrap migration created. */
  readonly owner: string | undefined;
  /** The grant that makes `owner` the home owner, which can never be revoked. */
  readonly ownerGrant: string | undefined;
  readonly principals: readonly PrincipalRow[];
  readonly grants: readonly GrantRow[];
  /** The credential rows (`credentials.jsonl`), named so the masker never hides the list. */
  readonly tokens: readonly CredentialRow[];
  readonly invites: readonly InviteRow[];
  readonly links: readonly LinkRow[];
  readonly governed: readonly GovernedRow[];
  readonly subjects: Subjects;
};

export type AccessSnapshotRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly snapshot: AccessSnapshot }
  | { readonly state: "unreadable"; readonly reason: string };

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** The home owner's grant: the earliest a member gave themselves, owner of the whole Home. */
function homeOwnerGrantOf(grants: readonly GrantRow[]): GrantRow | undefined {
  return grants.find(
    (grant) =>
      grant.grantedBy === grant.principal && grant.role === "owner" && grant.scope === "home",
  );
}

function foldKind<K extends LedgerKind>(
  root: string,
  kind: K,
): { readonly rows: RowOf[K][] } | { readonly reason: string } {
  const ledger = accessLedger(root, kind);
  const rel = accessPaths().ledgers[kind];
  const fold = foldStates(ledger);
  if (!fold.ok) return { reason: fold.reason };
  if (fold.gaps.length > 0) return { reason: `${rel} has a line that cannot be read` };
  const rows: RowOf[K][] = [];
  for (const object of fold.objects.values()) {
    const row = stripBookkeeping({ ...object.record });
    if (!isRowOf(kind, row)) return { reason: `${rel} holds a row that is not a ${kind} row` };
    rows.push(row as RowOf[K]);
  }
  return { rows };
}

/** Whether `<root>/access` is there, is something else, or is missing. */
function accessDirState(root: string): "missing" | "directory" | "other" {
  try {
    return lstatSync(join(root, accessPaths().dir)).isDirectory() ? "directory" : "other";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}

/**
 * The access records as one frozen snapshot: `absent` when `access/` does not exist (not
 * set up, a single owner implied), `present`, or `unreadable` when a ledger has a line that
 * cannot be read or a row of the wrong shape, or the revision or subjects file is bad. The
 * reason names the file, never a value. It takes no lock and creates nothing.
 *
 * First consumers: `crewhaus access members` and `tokens`, and every mutation, which loads
 * it again under the access lock.
 */
export function loadAccessSnapshot(root: string): AccessSnapshotRead {
  const dir = accessDirState(root);
  if (dir === "missing") return { state: "absent" };
  if (dir === "other") return { state: "unreadable", reason: "access is not a directory" };
  const revision = readRevision(root);
  if (revision.state === "unreadable") return revision;
  const folded: Partial<{ [K in LedgerKind]: RowOf[K][] }> = {};
  for (const kind of LEDGER_KINDS) {
    const answer = foldKind(root, kind);
    if ("reason" in answer) return { state: "unreadable", reason: answer.reason };
    (folded as Record<LedgerKind, unknown>)[kind] = answer.rows;
  }
  const subjects = readSubjects(root);
  if (subjects.state === "unreadable") return subjects;
  const grants = folded.grants ?? [];
  const ownerGrant = homeOwnerGrantOf(grants);
  const snapshot: AccessSnapshot = {
    epoch: revision.state === "present" ? revision.value.epoch : 0,
    owner: ownerGrant?.principal,
    ownerGrant: ownerGrant?.id,
    principals: folded.principals ?? [],
    grants,
    tokens: folded.credentials ?? [],
    invites: folded.invites ?? [],
    links: folded.links ?? [],
    governed: folded.governed ?? [],
    subjects: subjects.state === "present" ? subjects.value : EMPTY_SUBJECTS,
  };
  return { state: "present", snapshot: deepFreeze(snapshot) };
}

// ---------------------------------------------------------------------------
// Lookups over a snapshot. Pure.
// ---------------------------------------------------------------------------

export function principalOf(snapshot: AccessSnapshot, id: string): PrincipalRow | undefined {
  return snapshot.principals.find((row) => row.id === id);
}

export function isActivePrincipal(snapshot: AccessSnapshot, id: string): boolean {
  return principalOf(snapshot, id)?.state === "active";
}

/** A time that cannot be read counts as passed. */
export function hasPassed(at: string | undefined, now: number): boolean {
  if (at === undefined) return false;
  const ms = Date.parse(at);
  return Number.isNaN(ms) || ms <= now;
}

/** A grant that counts now: active, not expired, held by an active member. */
export function isLiveGrant(snapshot: AccessSnapshot, grant: GrantRow, now: number): boolean {
  if (grant.state !== "active" || hasPassed(grant.expiresAt, now)) return false;
  const holder = principalOf(snapshot, grant.principal);
  return holder?.state === "active" && holder.kind === "member";
}

/** A credential that counts now: active, not expired, held by an active principal. */
export function isLiveCredential(
  snapshot: AccessSnapshot,
  credential: CredentialRow,
  now: number,
): boolean {
  if (credential.state !== "active" || hasPassed(credential.expiresAt, now)) return false;
  return isActivePrincipal(snapshot, credential.principal);
}

export function displayNameOf(snapshot: AccessSnapshot, id: string): string | undefined {
  return snapshot.subjects.principals[id]?.displayName;
}

/**
 * The principal the local actor is linked to, through its active `local` link, or
 * `undefined` for an OS user nobody linked.
 *
 * First consumer: `crewhaus access sync`, which acts as the local actor.
 */
export function localPrincipalOf(snapshot: AccessSnapshot, localActor: string): string | undefined {
  for (const link of snapshot.links) {
    if (link.provider !== "local" || link.state !== "active") continue;
    if (snapshot.subjects.links[link.id] !== localActor) continue;
    if (isActivePrincipal(snapshot, link.principal)) return link.principal;
  }
  return undefined;
}
