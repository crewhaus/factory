/** `registerDomain`: a domain's permissions go to its own checker, and only there. */
import { afterAll, describe, expect, test } from "bun:test";
import { openAccess } from "./access";
import type { DomainRequest } from "./authorize";
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
