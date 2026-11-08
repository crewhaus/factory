/**
 * `authorize()`: whether a principal holds a permission on a target. A pure function over
 * an immutable snapshot and an injected time; no I/O. It answers `{allow: true, grant}`,
 * naming the grant or credential that holds it, or `{allow: false, needs, role}`, naming
 * what is missing and the role the principal actually has there.
 *
 * Members hold roles through grants: the highest live grant covering the target is the
 * role, there are no deny grants, and revoking removes. Services hold no grants: their
 * authority is their credential's explicit permission set, bounded to its harnesses.
 */
import {
  PERMISSIONS,
  PERMISSION_DECLS,
  type Permission,
  ROLES,
  ROLE_PERMISSIONS,
  type Role,
  isPermission,
} from "@crewhaus/control-contract";
import type { CredentialRow, GrantRow, PrincipalRow } from "./records";
import {
  type AccessSnapshot,
  type AccessSnapshotRead,
  isLiveCredential,
  isLiveGrant,
  principalOf,
} from "./snapshot";

/** Who is asking: a member by principal, or a service by principal and the credential it used. */
export type AccessActor =
  | { readonly principal: string }
  | { readonly principal: string; readonly credential: string };

/** What is asked about: the whole Home, or one harness with its registry groups. */
export type AccessTarget =
  | { readonly scope: "home" }
  | { readonly scope: "harness"; readonly harness: string; readonly groups: readonly string[] };

export type AuthorizeVerdict =
  | { readonly allow: true; readonly grant: string }
  | { readonly allow: false; readonly needs: string; readonly role: Role | null };

export type DomainRequest = {
  readonly actor: AccessActor;
  readonly principal: PrincipalRow;
  readonly permission: string;
  readonly target: AccessTarget;
  readonly snapshot: AccessSnapshot;
  readonly now: number;
};

/** A domain's own authorizer. It must answer; a throw refuses. */
export type DomainChecker = (request: DomainRequest) => AuthorizeVerdict;

export type AuthorizeOptions = {
  readonly now: number;
  readonly domains?: ReadonlyMap<string, DomainChecker>;
};

/** The prefixes of the core vocabulary (`home`, `h`, `self`): never a domain's. */
export const CORE_PERMISSION_PREFIXES: ReadonlySet<string> = new Set(
  PERMISSIONS.map((permission) => permission.split(".")[0] as string),
);

const rank = (role: Role): number => ROLES.indexOf(role);

/** Whether a grant's scope covers this target. A home grant covers every harness. */
export function scopeCovers(scope: string, target: AccessTarget): boolean {
  if (scope === "home") return true;
  if (target.scope !== "harness") return false;
  if (scope.startsWith("group:")) return target.groups.includes(scope.slice("group:".length));
  return scope === `harness:${target.harness}`;
}

/** The live grants this principal holds that cover the target, highest role first. */
export function coveringGrants(
  snapshot: AccessSnapshot,
  principal: string,
  target: AccessTarget,
  now: number,
): GrantRow[] {
  return snapshot.grants
    .filter(
      (grant) =>
        grant.principal === principal &&
        isLiveGrant(snapshot, grant, now) &&
        scopeCovers(grant.scope, target),
    )
    .sort((a, b) => rank(b.role) - rank(a.role) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A member's effective role on a target: the highest live grant covering it. On the home
 * target only a `home` grant covers.
 *
 * First consumers: `authorize()` and the projection writer.
 */
export function effectiveRole(
  snapshot: AccessSnapshot,
  principal: string,
  target: AccessTarget,
  now: number,
): Role | null {
  return coveringGrants(snapshot, principal, target, now)[0]?.role ?? null;
}

function refuse(needs: string, role: Role | null): AuthorizeVerdict {
  return { allow: false, needs, role };
}

function authorizeMember(
  snapshot: AccessSnapshot,
  principal: string,
  permission: Permission,
  target: AccessTarget,
  now: number,
): AuthorizeVerdict {
  const decl = PERMISSION_DECLS[permission];
  if (decl.scope === "home") {
    const home = coveringGrants(snapshot, principal, { scope: "home" }, now);
    const role = home[0]?.role ?? null;
    if (decl.floor === "none") return refuse(permission, role);
    // Reading the Home and one's own preferences come with any live grant.
    if (decl.floor === "viewer") {
      const best =
        home[0] ??
        snapshot.grants.find(
          (grant) => grant.principal === principal && isLiveGrant(snapshot, grant, now),
        );
      return best === undefined ? refuse(permission, role) : { allow: true, grant: best.id };
    }
    const floor = decl.floor;
    const holding = home.find((grant) => rank(grant.role) >= rank(floor));
    return holding === undefined ? refuse(permission, role) : { allow: true, grant: holding.id };
  }
  // A harness permission is about one harness: the home target names none.
  if (target.scope !== "harness") return refuse(permission, null);
  const covering = coveringGrants(snapshot, principal, target, now);
  const best = covering[0];
  if (best === undefined) return refuse(permission, null);
  return ROLE_PERMISSIONS[best.role].includes(permission)
    ? { allow: true, grant: best.id }
    : refuse(permission, best.role);
}

/** What one service credential holds, read without a target. */
export function credentialHolds(
  credential: CredentialRow,
  permission: Permission,
  target: AccessTarget,
): boolean {
  const decl = PERMISSION_DECLS[permission];
  if (decl.service === "never") return false;
  if (decl.scope === "home") {
    return decl.floor !== "none" && (credential.permissions ?? []).includes(permission);
  }
  // Fail closed: a credential that lists no harness covers none.
  if (target.scope !== "harness" || !(credential.harnesses ?? []).includes(target.harness)) {
    return false;
  }
  if (permission === "h.read") return true;
  if (permission === "h.read.content") return credential.contentRead === true;
  if (permission === "h.subject.assert") return credential.subjectAssert === true;
  return (credential.permissions ?? []).includes(permission);
}

function authorizeService(
  snapshot: AccessSnapshot,
  actor: AccessActor,
  permission: Permission,
  target: AccessTarget,
  now: number,
): AuthorizeVerdict {
  if (!("credential" in actor)) return refuse(permission, null);
  const credential = snapshot.tokens.find((row) => row.id === actor.credential);
  if (
    credential === undefined ||
    credential.principal !== actor.principal ||
    credential.kind !== "service" ||
    !isLiveCredential(snapshot, credential, now)
  ) {
    return refuse(permission, null);
  }
  return credentialHolds(credential, permission, target)
    ? { allow: true, grant: credential.id }
    : refuse(permission, null);
}

/** `<name>` of a permission `<name>.…` whose prefix is not a core one, else `undefined`. */
export function domainOf(permission: string): string | undefined {
  const dot = permission.indexOf(".");
  if (dot < 1) return undefined;
  const name = permission.slice(0, dot);
  return CORE_PERMISSION_PREFIXES.has(name) ? undefined : name;
}

/**
 * Whether `actor` holds `permission` on `target`, over a snapshot read. An absent or
 * unreadable snapshot, a system or unknown actor, a removed principal and an unknown
 * permission are refused. A permission of a registered domain goes to that domain's
 * checker; with none registered it is refused, and no role implies it.
 *
 * First consumer: every mutating `crewhaus access` verb, which needs `home.access.manage`.
 */
export function authorize(
  read: AccessSnapshotRead | AccessSnapshot,
  actor: AccessActor,
  permission: string,
  target: AccessTarget,
  options: AuthorizeOptions,
): AuthorizeVerdict {
  const snapshot = "state" in read ? (read.state === "present" ? read.snapshot : undefined) : read;
  if (snapshot === undefined) return refuse(permission, null);
  const principal =
    typeof actor?.principal === "string" ? principalOf(snapshot, actor.principal) : undefined;
  // System actors and unknown or removed principals hold nothing.
  if (principal === undefined || principal.state !== "active") return refuse(permission, null);
  const memberRole =
    principal.kind === "member" ? effectiveRole(snapshot, principal.id, target, options.now) : null;
  const domain = domainOf(permission);
  if (domain !== undefined) {
    const checker = options.domains?.get(domain);
    if (checker === undefined) return refuse(permission, memberRole);
    try {
      const verdict = checker({ actor, principal, permission, target, snapshot, now: options.now });
      return verdict?.allow === true && typeof verdict.grant === "string"
        ? { allow: true, grant: verdict.grant }
        : refuse(permission, memberRole);
    } catch {
      return refuse(permission, memberRole);
    }
  }
  if (!isPermission(permission)) return refuse(permission, memberRole);
  return principal.kind === "service"
    ? authorizeService(snapshot, actor, permission, target, options.now)
    : authorizeMember(snapshot, principal.id, permission, target, options.now);
}
