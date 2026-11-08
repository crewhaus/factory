/**
 * What a list shows: ids, roles, scopes, providers, hints and times. Never a `sha256`,
 * never a readable link subject (a list names the provider), and never a removed member.
 */
import type { Permission, Role } from "@crewhaus/control-contract";
import type { CredentialRow, GrantRow, InviteRow, LinkRow, PrincipalKind } from "./records";
import {
  type AccessSnapshot,
  displayNameOf,
  hasPassed,
  isLiveCredential,
  isLiveGrant,
} from "./snapshot";

export type GrantView = {
  readonly id: string;
  readonly principal: string;
  readonly role: Role;
  readonly scope: string;
  readonly grantedBy: string;
  readonly at: string;
  readonly expiresAt?: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
  /** Active, unexpired and held by an active member. */
  readonly live: boolean;
};

export type LinkView = {
  readonly id: string;
  readonly principal: string;
  readonly provider: LinkRow["provider"];
  readonly subjectRef: string;
  readonly verifiedVia: LinkRow["verifiedVia"];
  readonly at: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
};

export type MemberView = {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly displayName?: string;
  readonly createdAt: string;
  /** The home owner, who always decides. */
  readonly homeOwner: boolean;
  readonly grants: readonly GrantView[];
  /** Active links only. */
  readonly links: readonly LinkView[];
};

export type TokenView = {
  readonly id: string;
  readonly principal: string;
  readonly displayName?: string;
  readonly kind: CredentialRow["kind"];
  readonly prefixHint?: string;
  readonly permissions?: readonly Permission[];
  readonly harnesses?: readonly string[];
  readonly contentRead?: true;
  readonly subjectAssert?: true;
  readonly at: string;
  readonly expiresAt?: string;
  readonly state: "active" | "revoked";
  readonly revokedAt?: string;
  readonly live: boolean;
};

export type InviteView = {
  readonly id: string;
  readonly role: Role;
  readonly scope: string;
  readonly createdBy: string;
  readonly at: string;
  readonly expiresAt: string;
  readonly state: InviteRow["state"];
  readonly consumedAt?: string;
  readonly revokedAt?: string;
  readonly principal?: string;
  readonly live: boolean;
};

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function grantView(snapshot: AccessSnapshot, row: GrantRow, now: number): GrantView {
  return {
    id: row.id,
    principal: row.principal,
    role: row.role,
    scope: row.scope,
    grantedBy: row.grantedBy,
    at: row.at,
    ...optional("expiresAt", row.expiresAt),
    state: row.state,
    ...optional("revokedAt", row.revokedAt),
    live: isLiveGrant(snapshot, row, now),
  };
}

export function linkView(row: LinkRow): LinkView {
  return {
    id: row.id,
    principal: row.principal,
    provider: row.provider,
    subjectRef: row.subjectRef,
    verifiedVia: row.verifiedVia,
    at: row.at,
    state: row.state,
    ...optional("revokedAt", row.revokedAt),
  };
}

export function tokenView(snapshot: AccessSnapshot, row: CredentialRow, now: number): TokenView {
  return {
    id: row.id,
    principal: row.principal,
    ...optional("displayName", displayNameOf(snapshot, row.principal)),
    kind: row.kind,
    ...optional("prefixHint", row.prefixHint),
    ...optional("permissions", row.permissions),
    ...optional("harnesses", row.harnesses),
    ...optional("contentRead", row.contentRead),
    ...optional("subjectAssert", row.subjectAssert),
    at: row.at,
    ...optional("expiresAt", row.expiresAt),
    state: row.state,
    ...optional("revokedAt", row.revokedAt),
    live: isLiveCredential(snapshot, row, now),
  };
}

export function inviteView(row: InviteRow, now: number): InviteView {
  return {
    id: row.id,
    role: row.role,
    scope: row.scope,
    createdBy: row.createdBy,
    at: row.at,
    expiresAt: row.expiresAt,
    state: row.state,
    ...optional("consumedAt", row.consumedAt),
    ...optional("revokedAt", row.revokedAt),
    ...optional("principal", row.principal),
    live: row.state === "open" && !hasPassed(row.expiresAt, now),
  };
}

/**
 * Every active member and service, the home owner first, with their grants and active
 * links.
 *
 * First consumer: `crewhaus access members`.
 */
export function listMembers(snapshot: AccessSnapshot, now: number): MemberView[] {
  const members = snapshot.principals
    .filter((principal) => principal.state === "active")
    .map(
      (principal): MemberView => ({
        id: principal.id,
        kind: principal.kind,
        ...optional("displayName", displayNameOf(snapshot, principal.id)),
        createdAt: principal.at,
        homeOwner: principal.id === snapshot.owner,
        grants: snapshot.grants
          .filter((grant) => grant.principal === principal.id && grant.state === "active")
          .map((grant) => grantView(snapshot, grant, now)),
        links: snapshot.links
          .filter((link) => link.principal === principal.id && link.state === "active")
          .map(linkView),
      }),
    );
  return members.sort((a, b) => Number(b.homeOwner) - Number(a.homeOwner));
}

/**
 * Every credential, with its kind, `prefixHint`, expiry and state; never its digest.
 *
 * First consumer: `crewhaus access tokens`.
 */
export function listTokens(snapshot: AccessSnapshot, now: number): TokenView[] {
  return snapshot.tokens.map((row) => tokenView(snapshot, row, now));
}

/**
 * Every invite, with its role, scope and expiry; never its digest.
 *
 * First consumer: `crewhaus access members`, which shows the open ones.
 */
export function listInvites(snapshot: AccessSnapshot, now: number): InviteView[] {
  return snapshot.invites.map((row) => inviteView(row, now));
}
