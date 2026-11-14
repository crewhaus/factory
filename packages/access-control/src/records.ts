/**
 * The rows the access ledgers hold. Each is `{id, state, at, by, …}`, so control-records'
 * `foldStates` folds it by `id`; a row that ends an object (`revoked`, `consumed`) also
 * carries `revokedAt` or `consumedAt`, so a served row says it ended. No row holds a
 * secret, a name, a contact or a readable link subject: those live in `subjects.json`.
 *
 * Every field name tests false under the masker's `isCredentialKey` (`sha256`,
 * `prefixHint`, `subjectRef`, `contentRead`, `subjectAssert`), and `by` is always a stored
 * actor, never a raw `local:` id.
 */
import {
  type Permission,
  ROLES,
  type Role,
  isGrantScope,
  isId,
  isPermission,
  isStoredActor,
} from "@crewhaus/control-contract";

export type PrincipalKind = "member" | "service";

type RowBase = {
  readonly id: string;
  readonly at: string;
  readonly by: string;
};

export type PrincipalRow = RowBase & {
  readonly kind: PrincipalKind;
  readonly state: "active" | "removed";
};

export type GrantRow = RowBase & {
  readonly principal: string;
  readonly role: Role;
  /** `home`, `group:<name>` or `harness:<hrn>`. */
  readonly scope: string;
  readonly grantedBy: string;
  readonly expiresAt?: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
};

/**
 * `personal` is a member's own token for a CLI or a script: it acts as that member and
 * never beyond what the member holds.
 */
export type CredentialKind = "bootstrap" | "service" | "personal";

export type CredentialRow = RowBase & {
  readonly principal: string;
  readonly kind: CredentialKind;
  /** Lowercase hex SHA-256 of the secret. Never served. */
  readonly sha256: string;
  readonly prefixHint?: string;
  readonly permissions?: readonly Permission[];
  readonly harnesses?: readonly string[];
  readonly contentRead?: true;
  readonly subjectAssert?: true;
  /** A bootstrap only `<hangarRoot>/home.sock` accepts (`crewhaus hangar rotate-token --socket-only`). */
  readonly socketOnly?: true;
  /** A personal token that can only read, whatever its member's role. */
  readonly readOnly?: true;
  readonly expiresAt?: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
};

export type InviteRow = RowBase & {
  readonly role: Role;
  readonly scope: string;
  /** Lowercase hex SHA-256 of the code. Never served. */
  readonly sha256: string;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly state: "open" | "consumed" | "revoked";
  readonly consumedAt?: string;
  readonly revokedAt?: string;
  readonly principal?: string;
};

export type LinkProviderStored = "slack" | "github" | "proxy" | "local";

export type LinkRow = RowBase & {
  readonly principal: string;
  readonly provider: LinkProviderStored;
  /** A keyed digest of the readable subject, under the Hangar root's subject key. */
  readonly subjectRef: string;
  readonly verifiedVia: "owner" | "bootstrap";
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
};

export type GovernedRow = RowBase & {
  /** The harness, `hrn_…`. */
  readonly state: "governed";
  readonly since: string;
};

export type RowOf = {
  readonly principals: PrincipalRow;
  readonly grants: GrantRow;
  readonly credentials: CredentialRow;
  readonly invites: InviteRow;
  readonly links: LinkRow;
  readonly governed: GovernedRow;
};

const HEX64_RE = /^[0-9a-f]{64}$/;

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function base(row: Record<string, unknown>, prefix: string): boolean {
  return isId(prefix, row["id"]) && isTime(row["at"]) && isStoredActor(row["by"]);
}

function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

function ended(row: Record<string, unknown>, endState: string, field: string): boolean {
  return row["state"] === endState ? isTime(row[field]) : row[field] === undefined;
}

const CHECKS: { readonly [K in keyof RowOf]: (row: Record<string, unknown>) => boolean } = {
  principals: (row) =>
    base(row, "prn") &&
    (row["kind"] === "member" || row["kind"] === "service") &&
    (row["state"] === "active" || row["state"] === "removed"),
  grants: (row) =>
    base(row, "grt") &&
    isId("prn", row["principal"]) &&
    isRole(row["role"]) &&
    isGrantScope(row["scope"]) &&
    isStoredActor(row["grantedBy"]) &&
    optional(row["expiresAt"], isTime) &&
    (row["state"] === "active" || row["state"] === "revoked") &&
    ended(row, "revoked", "revokedAt"),
  credentials: (row) =>
    base(row, "crd") &&
    isId("prn", row["principal"]) &&
    (row["kind"] === "bootstrap" || row["kind"] === "service" || row["kind"] === "personal") &&
    typeof row["sha256"] === "string" &&
    HEX64_RE.test(row["sha256"]) &&
    optional(row["prefixHint"], (v) => typeof v === "string") &&
    optional(row["permissions"], (v) => Array.isArray(v) && v.every(isPermission)) &&
    optional(row["harnesses"], (v) => Array.isArray(v) && v.every((h) => isId("hrn", h))) &&
    optional(row["contentRead"], (v) => v === true) &&
    optional(row["subjectAssert"], (v) => v === true) &&
    optional(row["socketOnly"], (v) => v === true && row["kind"] === "bootstrap") &&
    optional(row["readOnly"], (v) => v === true && row["kind"] === "personal") &&
    optional(row["expiresAt"], isTime) &&
    (row["state"] === "active" || row["state"] === "revoked") &&
    ended(row, "revoked", "revokedAt"),
  invites: (row) =>
    base(row, "inv") &&
    isRole(row["role"]) &&
    isGrantScope(row["scope"]) &&
    typeof row["sha256"] === "string" &&
    HEX64_RE.test(row["sha256"]) &&
    isTime(row["expiresAt"]) &&
    isStoredActor(row["createdBy"]) &&
    (row["state"] === "open" || row["state"] === "consumed" || row["state"] === "revoked") &&
    ended(row, "consumed", "consumedAt") &&
    ended(row, "revoked", "revokedAt") &&
    optional(row["principal"], (v) => isId("prn", v)),
  links: (row) =>
    base(row, "lnk") &&
    isId("prn", row["principal"]) &&
    ["slack", "github", "proxy", "local"].includes(row["provider"] as string) &&
    typeof row["subjectRef"] === "string" &&
    HEX64_RE.test(row["subjectRef"]) &&
    (row["verifiedVia"] === "owner" || row["verifiedVia"] === "bootstrap") &&
    (row["state"] === "active" || row["state"] === "revoked") &&
    ended(row, "revoked", "revokedAt"),
  governed: (row) => base(row, "hrn") && row["state"] === "governed" && isTime(row["since"]),
};

/** Whether a folded row is a well-formed row of its ledger. */
export function isRowOf<K extends keyof RowOf>(
  kind: K,
  row: Record<string, unknown>,
): row is Record<string, unknown> & RowOf[K] {
  return CHECKS[kind](row);
}

/** The row without the fold's bookkeeping (`claim`, `repaired`, `gen`). */
export function stripBookkeeping<T extends Record<string, unknown>>(row: T): T {
  const { claim: _claim, repaired: _repaired, gen: _gen, ...rest } = row;
  return rest as T;
}

/** A row as one JSONL line would hold it, for the size check before anything is written. */
export function lineBytes(row: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(row)}\n`);
}
