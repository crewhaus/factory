/** `registerDomain`: a domain's permissions go to its own checker, and only there. */
import { afterAll, describe, expect, test } from "bun:test";
import { PERMISSIONS, ROLES } from "@crewhaus/control-contract";
import { openAccess } from "./access";
import { CORE_PERMISSION_PREFIXES, type DomainRequest, domainOf } from "./authorize";
import { homeFixture, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

const HOME = { scope: "home" } as const;

describe("domains", () => {
  test("with no checker registered, a domain permission is refused, even for the owner", async () => {
    const home = await homeFixture();
    const verdict = home.access.authorize(home.snapshot(), home.actor, "people.read", HOME);
    expect(verdict).toEqual({ allow: false, needs: "people.read", role: "owner" });
  });

  test("a registered checker decides, and is handed the principal and the snapshot", async () => {
    const home = await homeFixture();
    const seen: DomainRequest[] = [];
    home.access.registerDomain("people", (request) => {
      seen.push(request);
      return request.permission === "people.read"
        ? { allow: true, grant: "people-rule" }
        : { allow: false, needs: request.permission, role: null };
    });
    const snapshot = home.snapshot();
    expect(home.access.authorize(snapshot, home.actor, "people.read", HOME)).toEqual({
      allow: true,
      grant: "people-rule",
    });
    expect(home.access.authorize(snapshot, home.actor, "people.write", HOME).allow).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.principal.id).toBe(home.owner);
    expect(seen[0]?.snapshot).toBe(snapshot);
  });

  test("no role implies a domain permission: an owner the checker refuses is refused", async () => {
    const home = await homeFixture();
    home.access.registerDomain("people", () => ({
      allow: false,
      needs: "people.read",
      role: null,
    }));
    expect(home.access.authorize(home.snapshot(), home.actor, "people.read", HOME).allow).toBe(
      false,
    );
  });

  test("a checker that throws or answers nonsense refuses", async () => {
    const home = await homeFixture();
    home.access.registerDomain("people", () => {
      throw new Error("boom");
    });
    home.access.registerDomain("vault", () => ({ allow: true }) as never);
    expect(home.access.authorize(home.snapshot(), home.actor, "people.read", HOME).allow).toBe(
      false,
    );
    expect(home.access.authorize(home.snapshot(), home.actor, "vault.read", HOME).allow).toBe(
      false,
    );
  });

  test("an unknown or removed principal never reaches the checker", async () => {
    const home = await homeFixture();
    let calls = 0;
    home.access.registerDomain("people", () => {
      calls += 1;
      return { allow: true, grant: "x" };
    });
    expect(
      home.access.authorize(home.snapshot(), { principal: "sys:scheduler" }, "people.read", HOME)
        .allow,
    ).toBe(false);
    expect(calls).toBe(0);
  });

  test("a core prefix, a second registration or a bad name throws", async () => {
    const home = await homeFixture();
    const checker = () => ({ allow: false as const, needs: "x", role: null });
    for (const name of ["home", "h", "self"]) {
      expect(() => home.access.registerDomain(name, checker)).toThrow(/core permission prefix/);
    }
    home.access.registerDomain("people", checker);
    expect(() => home.access.registerDomain("people", checker)).toThrow(/already registered/);
    expect(() => home.access.registerDomain("People!", checker)).toThrow(/not a domain name/);
  });

  test("two handles do not share a domain table", async () => {
    const home = await homeFixture();
    const other = openAccess(home.root, { now: home.clock.now });
    home.access.registerDomain("people", () => ({ allow: true, grant: "x" }));
    expect(home.access.authorize(home.snapshot(), home.actor, "people.read", HOME).allow).toBe(
      true,
    );
    expect(other.authorize(home.snapshot(), home.actor, "people.read", HOME).allow).toBe(false);
    expect(() => other.registerDomain("people", () => ({ allow: true, grant: "y" }))).not.toThrow();
  });
});

describe("the people domain, with its permissions declared", () => {
  const PEOPLE = PERMISSIONS.filter((permission) => permission.startsWith("people."));

  test("people is a domain, not a core prefix, while h and home stay core", () => {
    expect(PEOPLE).toHaveLength(9);
    expect(CORE_PERMISSION_PREFIXES.has("people")).toBe(false);
    expect([...CORE_PERMISSION_PREFIXES].sort()).toEqual(["h", "home", "self"]);
    expect(domainOf("people.person.read")).toBe("people");
    // h.subject.assert has no role either, but h is core: its other permissions have floors.
    expect(domainOf("h.subject.assert")).toBeUndefined();
  });

  test("its checker registers and decides a declared permission", async () => {
    const home = await homeFixture();
    const asked: string[] = [];
    home.access.registerDomain("people", (request) => {
      asked.push(request.permission);
      return request.permission === "people.person.read"
        ? { allow: true, grant: "people-owner" }
        : { allow: false, needs: request.permission, role: null };
    });
    expect(home.access.authorize(home.snapshot(), home.actor, "people.person.read", HOME)).toEqual({
      allow: true,
      grant: "people-owner",
    });
    expect(
      home.access.authorize(home.snapshot(), home.actor, "people.person.write", HOME).allow,
    ).toBe(false);
    expect(asked).toEqual(["people.person.read", "people.person.write"]);
    expect(() => home.access.registerDomain("h", () => ({ allow: true, grant: "x" }))).toThrow(
      /core permission prefix/,
    );
  });

  test("with no checker, every role is refused every people permission, and told its home role", async () => {
    const home = await homeFixture();
    const harness = home.addHarness("one");
    const target = { scope: "harness", harness: harness.id, groups: [] } as const;
    let refused = 0;
    for (const role of ROLES) {
      const granted = await home.access.grant(home.actor, {
        member: `member-${role}`,
        role,
        scope: `harness:${harness.id}`,
        create: true,
      });
      if (!granted.ok) throw new Error(granted.reason);
      const principal = granted.result.principal;
      for (const permission of PEOPLE) {
        for (const where of [HOME, target]) {
          const verdict = home.access.authorize(home.snapshot(), { principal }, permission, where);
          // The grant is on one harness, so the home role a people permission reports is none.
          expect(verdict).toEqual({ allow: false, needs: permission, role: null });
          refused++;
        }
      }
    }
    for (const permission of PEOPLE) {
      expect(home.access.authorize(home.snapshot(), home.actor, permission, HOME)).toEqual({
        allow: false,
        needs: permission,
        role: "owner",
      });
    }
    expect(refused).toBe(ROLES.length * PEOPLE.length * 2);
  });

  test("a service token can never list a people permission", async () => {
    const home = await homeFixture();
    for (const permission of PEOPLE) {
      const answer = await home.access.mintServiceToken(home.actor, {
        service: "app",
        permissions: [permission],
      });
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.reason).toBe(`A service can never hold ${permission}.`);
    }
  });
});
