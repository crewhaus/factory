/**
 * `authorize()` over the whole role × permission × target matrix, checked against an
 * independent oracle built from each permission's floor, plus a hand-written table of the
 * boundary rows, so a mistake the oracle shares with the code still fails.
 */
import { describe, expect, test } from "bun:test";
import {
  PERMISSIONS,
  PERMISSION_DECLS,
  type Permission,
  ROLES,
  type Role,
  mintId,
} from "@crewhaus/control-contract";
import {
  type AccessTarget,
  type AuthorizeVerdict,
  authorize,
  effectiveRole,
  queuedActorHolds,
} from "./authorize";
import { EMPTY_SUBJECTS } from "./files";
import type { CredentialRow, GrantRow, PrincipalRow } from "./records";
import type { AccessSnapshot } from "./snapshot";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const AT = new Date(NOW - 1000).toISOString();
const OWNER = mintId("prn");
const ALICE = mintId("prn");
const SERVICE = mintId("prn");
const TOKEN = mintId("crd");
const H1 = "hrn_00000000000000a1";
const H2 = "hrn_00000000000000a2";
const H3 = "hrn_00000000000000a3";

const TARGETS: Readonly<Record<string, AccessTarget>> = {
  home: { scope: "home" },
  "in-group": { scope: "harness", harness: H3, groups: ["team"] },
  "outside-group": { scope: "harness", harness: H2, groups: ["other"] },
  granted: { scope: "harness", harness: H1, groups: [] },
  another: { scope: "harness", harness: H2, groups: [] },
};

function principal(
  id: string,
  kind: "member" | "service" = "member",
  state: PrincipalRow["state"] = "active",
): PrincipalRow {
  return { id, kind, state, at: AT, by: OWNER };
}

function grant(
  principalId: string,
  role: Role,
  scope: string,
  extra: Partial<GrantRow> = {},
): GrantRow {
  return {
    id: mintId("grt"),
    principal: principalId,
    role,
    scope,
    grantedBy: OWNER,
    state: "active",
    at: AT,
    by: OWNER,
    ...extra,
  };
}

function snapshotOf(
  grants: readonly GrantRow[],
  principals: readonly PrincipalRow[] = [principal(OWNER), principal(ALICE)],
  tokens: readonly CredentialRow[] = [],
): AccessSnapshot {
  const own = grant(OWNER, "owner", "home", { grantedBy: OWNER });
  return {
    epoch: 1,
    owner: OWNER,
    ownerGrant: own.id,
    principals,
    grants: [own, ...grants],
    tokens,
    invites: [],
    links: [],
    governed: [],
    subjects: EMPTY_SUBJECTS,
  };
}

const rank = (role: Role): number => ROLES.indexOf(role);

/** Written from the floors alone: the code reads ROLE_PERMISSIONS, so the two differ in kind. */
function oracle(role: Role, scope: string, permission: Permission, target: AccessTarget): boolean {
  const decl = PERMISSION_DECLS[permission];
  if (decl.floor === "none") return false;
  if (decl.scope === "home") {
    if (decl.floor === "viewer") return true;
    return scope === "home" && rank(role) >= rank(decl.floor);
  }
  if (target.scope !== "harness") return false;
  const covers =
    scope === "home" ||
    (scope.startsWith("group:") && target.groups.includes(scope.slice(6))) ||
    scope === `harness:${target.harness}`;
  return covers && rank(role) >= rank(decl.floor);
}

function check(
  snapshot: AccessSnapshot,
  who: string,
  permission: string,
  target: AccessTarget,
): AuthorizeVerdict {
  return authorize(snapshot, { principal: who }, permission, target, { now: NOW });
}

describe("the member matrix", () => {
  const SCOPES = ["home", "group:team", `harness:${H1}`];
  for (const role of ROLES) {
    for (const scope of SCOPES) {
      test(`${role} at ${scope}: every permission on every target matches the floors`, () => {
        const snapshot = snapshotOf([grant(ALICE, role, scope)]);
        const mismatches: string[] = [];
        let allowed = 0;
        for (const [name, target] of Object.entries(TARGETS)) {
          for (const permission of PERMISSIONS) {
            const verdict = check(snapshot, ALICE, permission, target);
            const expected = oracle(role, scope, permission, target);
            if (verdict.allow !== expected) mismatches.push(`${permission} on ${name}`);
            if (verdict.allow) allowed += 1;
            else {
              expect(verdict.needs).toBe(permission);
              const actual =
                PERMISSION_DECLS[permission].scope === "home"
                  ? effectiveRole(snapshot, ALICE, { scope: "home" }, NOW)
                  : target.scope === "harness"
                    ? effectiveRole(snapshot, ALICE, target, NOW)
                    : null;
              expect(verdict.role).toBe(actual);
            }
          }
        }
        expect(mismatches).toEqual([]);
        expect(allowed).toBeGreaterThan(0);
      });
    }
  }

  test("expired, revoked, a removed principal and no grant all hold nothing", () => {
    const cases: [string, AccessSnapshot][] = [
      [
        "expired",
        snapshotOf([grant(ALICE, "owner", "home", { expiresAt: new Date(NOW).toISOString() })]),
      ],
      ["revoked", snapshotOf([grant(ALICE, "owner", "home", { state: "revoked", revokedAt: AT })])],
      [
        "removed",
        snapshotOf(
          [grant(ALICE, "owner", "home")],
          [principal(OWNER), principal(ALICE, "member", "removed")],
        ),
      ],
      ["no grant", snapshotOf([])],
    ];
    for (const [name, snapshot] of cases) {
      for (const target of Object.values(TARGETS)) {
        for (const permission of PERMISSIONS) {
          const verdict = check(snapshot, ALICE, permission, target);
          if (verdict.allow) throw new Error(`${name}: ${permission} was allowed`);
          expect(verdict.role).toBeNull();
        }
      }
    }
  });

  test("an expiry just after now still counts", () => {
    const snapshot = snapshotOf([
      grant(ALICE, "operator", "home", { expiresAt: new Date(NOW + 1).toISOString() }),
    ]);
    expect(check(snapshot, ALICE, "h.control", TARGETS["granted"] as AccessTarget).allow).toBe(
      true,
    );
  });
});

describe("the boundary rows, by hand", () => {
  const on = (role: Role, scope: string, permission: string, target: string): boolean =>
    check(
      snapshotOf([grant(ALICE, role, scope)]),
      ALICE,
      permission,
      TARGETS[target] as AccessTarget,
    ).allow;

  test("viewer reads content and cannot control", () => {
    expect(on("viewer", `harness:${H1}`, "h.read.content", "granted")).toBe(true);
    expect(on("viewer", `harness:${H1}`, "h.control", "granted")).toBe(false);
  });

  test("operator resolves decisions and cannot edit the spec", () => {
    expect(on("operator", "group:team", "h.decision.resolve", "in-group")).toBe(true);
    expect(on("operator", "group:team", "h.spec.edit", "in-group")).toBe(false);
  });

  test("maintainer deploys through any covering grant, manages the registry only from home", () => {
    expect(on("maintainer", "home", "h.deploy", "another")).toBe(true);
    expect(on("maintainer", "group:team", "h.deploy", "in-group")).toBe(true);
    expect(on("maintainer", `harness:${H1}`, "h.deploy", "granted")).toBe(true);
    expect(on("maintainer", "home", "home.registry.manage", "home")).toBe(true);
    expect(on("maintainer", "group:team", "home.registry.manage", "home")).toBe(false);
    expect(on("maintainer", `harness:${H1}`, "home.registry.manage", "home")).toBe(false);
    expect(on("maintainer", "home", "h.spec.edit.security", "granted")).toBe(false);
  });

  test("owner manages access; no role asserts a subject", () => {
    expect(on("owner", "home", "home.access.manage", "home")).toBe(true);
    for (const role of ROLES) {
      expect(on(role, "home", "h.subject.assert", "granted")).toBe(false);
    }
  });

  test("a group grant reaches a harness in the group and no other", () => {
    expect(on("operator", "group:team", "h.control", "in-group")).toBe(true);
    expect(on("operator", "group:team", "h.control", "outside-group")).toBe(false);
    expect(on("operator", `harness:${H1}`, "h.control", "another")).toBe(false);
  });

  test("home.read and self.preferences come with any live grant", () => {
    expect(on("viewer", `harness:${H1}`, "home.read", "home")).toBe(true);
    expect(on("viewer", "group:team", "self.preferences", "home")).toBe(true);
  });

  test("the highest covering grant wins, and a refusal names what is missing and the real role", () => {
    const snapshot = snapshotOf([
      grant(ALICE, "viewer", "home"),
      grant(ALICE, "maintainer", "group:team"),
      grant(ALICE, "operator", `harness:${H3}`),
    ]);
    const target = TARGETS["in-group"] as AccessTarget;
    expect(effectiveRole(snapshot, ALICE, target, NOW)).toBe("maintainer");
    expect(check(snapshot, ALICE, "h.spec.edit", target).allow).toBe(true);
    expect(check(snapshot, ALICE, "h.retire", target)).toEqual({
      allow: false,
      needs: "h.retire",
      role: "maintainer",
    });
    const elsewhere = TARGETS["another"] as AccessTarget;
    expect(check(snapshot, ALICE, "h.control", elsewhere)).toEqual({
      allow: false,
      needs: "h.control",
      role: "viewer",
    });
    expect(check(snapshot, ALICE, "home.settings.manage", { scope: "home" })).toEqual({
      allow: false,
      needs: "home.settings.manage",
      role: "viewer",
    });
  });

  test("an allowed answer names the grant that holds it", () => {
    const held = grant(ALICE, "operator", `harness:${H1}`);
    const verdict = check(
      snapshotOf([held]),
      ALICE,
      "h.control",
      TARGETS["granted"] as AccessTarget,
    );
    expect(verdict).toEqual({ allow: true, grant: held.id });
  });
});

describe("refusals that need no grant to decide", () => {
  const snapshot = snapshotOf([grant(ALICE, "owner", "home")]);

  test("system actors, unknown principals and malformed actors hold nothing", () => {
    for (const who of ["sys:scheduler", "sys:executor", mintId("prn"), "local:max@laptop", ""]) {
      expect(check(snapshot, who, "h.read", TARGETS["granted"] as AccessTarget)).toEqual({
        allow: false,
        needs: "h.read",
        role: null,
      });
    }
  });

  test("an unknown permission is refused, even for the owner", () => {
    expect(check(snapshot, OWNER, "h.everything", TARGETS["granted"] as AccessTarget).allow).toBe(
      false,
    );
    expect(check(snapshot, OWNER, "home", { scope: "home" }).allow).toBe(false);
  });

  test("an absent or unreadable snapshot read refuses", () => {
    for (const read of [
      { state: "absent" as const },
      { state: "unreadable" as const, reason: "x" },
    ]) {
      expect(
        authorize(read, { principal: OWNER }, "home.read", { scope: "home" }, { now: NOW }).allow,
      ).toBe(false);
    }
    expect(
      authorize(
        { state: "present", snapshot },
        { principal: OWNER },
        "home.read",
        { scope: "home" },
        { now: NOW },
      ).allow,
    ).toBe(true);
  });
});

describe("services", () => {
  function serviceSnapshot(credential: Partial<CredentialRow>): AccessSnapshot {
    const row: CredentialRow = {
      id: TOKEN,
      principal: SERVICE,
      kind: "service",
      sha256: "ab".repeat(32),
      prefixHint: "chs_abcd",
      state: "active",
      at: AT,
      by: OWNER,
      ...credential,
    };
    return snapshotOf([], [principal(OWNER), principal(SERVICE, "service")], [row]);
  }
  const as = (
    snapshot: AccessSnapshot,
    permission: string,
    target: AccessTarget,
    credential = TOKEN,
  ) => authorize(snapshot, { principal: SERVICE, credential }, permission, target, { now: NOW });
  const ON_H1 = TARGETS["granted"] as AccessTarget;
  const ON_H2 = TARGETS["another"] as AccessTarget;

  test("its permissions, intersected with grantable, bounded to its harnesses", () => {
    const snapshot = serviceSnapshot({
      permissions: ["h.control", "h.decision.resolve", "home.read"],
      harnesses: [H1],
    });
    expect(as(snapshot, "h.control", ON_H1)).toEqual({ allow: true, grant: TOKEN });
    expect(as(snapshot, "h.decision.resolve", ON_H1).allow).toBe(true);
    expect(as(snapshot, "h.control", ON_H2).allow).toBe(false);
    expect(as(snapshot, "h.spec.edit", ON_H1).allow).toBe(false);
    expect(as(snapshot, "home.read", { scope: "home" }).allow).toBe(true);
    expect(as(snapshot, "home.registry.manage", { scope: "home" }).allow).toBe(false);
  });

  test("h.read is implicit on its harnesses; content and subject only with their flags", () => {
    const plain = serviceSnapshot({ harnesses: [H1] });
    expect(as(plain, "h.read", ON_H1).allow).toBe(true);
    expect(as(plain, "h.read", ON_H2).allow).toBe(false);
    expect(as(plain, "h.read.content", ON_H1).allow).toBe(false);
    expect(as(plain, "h.subject.assert", ON_H1).allow).toBe(false);
    const flagged = serviceSnapshot({ harnesses: [H1], contentRead: true, subjectAssert: true });
    expect(as(flagged, "h.read.content", ON_H1).allow).toBe(true);
    expect(as(flagged, "h.subject.assert", ON_H1).allow).toBe(true);
    expect(as(flagged, "h.subject.assert", ON_H2).allow).toBe(false);
  });

  test("a never-grantable permission is refused even when a row lists it", () => {
    const never = PERMISSIONS.filter((p) => PERMISSION_DECLS[p].service === "never");
    expect(never.length).toBeGreaterThan(0);
    const snapshot = serviceSnapshot({ permissions: never as Permission[], harnesses: [H1] });
    for (const permission of never) {
      const target =
        PERMISSION_DECLS[permission].scope === "home" ? { scope: "home" as const } : ON_H1;
      expect(as(snapshot, permission, target).allow).toBe(false);
    }
  });

  test("a credential with no harnesses holds no harness permission", () => {
    const snapshot = serviceSnapshot({ permissions: ["h.control", "home.read"] });
    for (const permission of PERMISSIONS.filter((p) => PERMISSION_DECLS[p].scope === "harness")) {
      expect(as(snapshot, permission, ON_H1).allow).toBe(false);
    }
    expect(as(snapshot, "home.read", { scope: "home" }).allow).toBe(true);
  });

  test("a revoked, expired, borrowed or missing credential holds nothing", () => {
    const base = { permissions: ["h.control"] as Permission[], harnesses: [H1] };
    expect(
      as(serviceSnapshot({ ...base, state: "revoked", revokedAt: AT }), "h.control", ON_H1).allow,
    ).toBe(false);
    expect(as(serviceSnapshot({ ...base, expiresAt: AT }), "h.control", ON_H1).allow).toBe(false);
    expect(as(serviceSnapshot({ ...base, principal: ALICE }), "h.control", ON_H1).allow).toBe(
      false,
    );
    expect(as(serviceSnapshot(base), "h.control", ON_H1, mintId("crd")).allow).toBe(false);
    expect(
      authorize(serviceSnapshot(base), { principal: SERVICE }, "h.control", ON_H1, { now: NOW })
        .allow,
    ).toBe(false);
  });

  test("a grant held by a service gives it nothing", () => {
    const snapshot = snapshotOf(
      [grant(SERVICE, "owner", "home")],
      [principal(OWNER), principal(SERVICE, "service")],
    );
    expect(authorize(snapshot, { principal: SERVICE }, "h.read", ON_H1, { now: NOW }).allow).toBe(
      false,
    );
  });
});

describe("queuedActorHolds: a command answers to the credential that submitted it", () => {
  const PORTAL = mintId("prn");
  const KIOSK = mintId("prn");
  const A = mintId("crd");
  const B = mintId("crd");
  const K = mintId("crd");
  const PERSONAL = mintId("crd");
  const ON_H1: AccessTarget = { scope: "harness", harness: H1, groups: [] };

  function token(
    id: string,
    principalId: string,
    kind: CredentialRow["kind"],
    extra: Partial<CredentialRow> = {},
  ): CredentialRow {
    return {
      id,
      principal: principalId,
      kind,
      sha256: "0".repeat(64),
      state: "active",
      at: AT,
      by: OWNER,
      ...extra,
    };
  }

  function world(revokedA: boolean): AccessSnapshot {
    return snapshotOf(
      [grant(ALICE, "operator", `harness:${H1}`)],
      [
        principal(OWNER),
        principal(ALICE),
        principal(PORTAL, "service"),
        principal(KIOSK, "service"),
      ],
      [
        token(A, PORTAL, "service", {
          permissions: ["h.control"],
          harnesses: [H1],
          expiresAt: new Date(NOW + 60_000).toISOString(),
          ...(revokedA ? { state: "revoked" as const, revokedAt: AT } : {}),
        }),
        token(B, PORTAL, "service", { permissions: ["h.control", "h.deploy"], harnesses: [H1] }),
        token(K, KIOSK, "service", { permissions: ["h.control"], harnesses: [H1] }),
        token(PERSONAL, ALICE, "personal", { readOnly: true }),
      ],
    );
  }

  const holds = (
    snapshot: AccessSnapshot,
    actor: string,
    credentialRef: string | undefined,
    permission = "h.control",
    now = NOW,
  ) =>
    queuedActorHolds(
      snapshot,
      credentialRef === undefined ? { actor } : { actor, credentialRef },
      permission,
      ON_H1,
      { now },
    );

  test("a receipt that names a revoked credential holds nothing, while a sibling token of its service stays live", () => {
    expect(holds(world(false), PORTAL, A)).toBe(true);
    expect(holds(world(true), PORTAL, A)).toBe(false);
    // A receipt that names no credential passes on its service's live token B.
    expect(holds(world(true), PORTAL, undefined)).toBe(true);
    expect(holds(world(true), PORTAL, B)).toBe(true);
  });

  test("the named credential must be its actor's own, and live", () => {
    expect(holds(world(false), KIOSK, B)).toBe(false);
    expect(holds(world(false), KIOSK, K)).toBe(true);
    // A expires a minute after NOW.
    expect(holds(world(false), PORTAL, A, "h.control", NOW + 60_000)).toBe(false);
    expect(holds(world(false), PORTAL, B, "h.control", NOW + 60_000)).toBe(true);
  });

  test("the named credential's own permissions decide", () => {
    expect(holds(world(false), PORTAL, A, "h.deploy")).toBe(false);
    expect(holds(world(false), PORTAL, B, "h.deploy")).toBe(true);
  });

  test("a member's read-only personal token keeps its cap", () => {
    expect(holds(world(false), ALICE, PERSONAL)).toBe(false);
    expect(holds(world(false), ALICE, undefined)).toBe(true);
    // A service token named for a member is the wrong kind.
    expect(holds(world(false), ALICE, A)).toBe(false);
  });

  test("an absent snapshot holds nothing", () => {
    expect(
      queuedActorHolds(
        { state: "absent" },
        { actor: PORTAL, credentialRef: B },
        "h.control",
        ON_H1,
        {
          now: NOW,
        },
      ),
    ).toBe(false);
  });
});
