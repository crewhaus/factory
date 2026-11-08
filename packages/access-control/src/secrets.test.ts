/** Issued secrets: their grammar, their digest and their hint. */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ISSUED_SECRET_RES, mintId } from "@crewhaus/control-contract";
import { maskCredentialTokens } from "@crewhaus/spec-patch";
import { type IssuedSecretKind, mintIssuedSecret, prefixHintOf, sha256Hex } from "./secrets";
import { homeFixture, ok, removeTempDirs } from "./test-helpers";

afterAll(removeTempDirs);

const KINDS: readonly IssuedSecretKind[] = ["session", "personal", "service", "invite"];

describe("mintIssuedSecret", () => {
  test("every mint of every kind matches its grammar, and none repeats", () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      for (let i = 0; i < 500; i++) {
        const secret = mintIssuedSecret(kind);
        expect(ISSUED_SECRET_RES[kind].test(secret)).toBe(true);
        seen.add(secret);
      }
    }
    expect(seen.size).toBe(KINDS.length * 500);
  });

  test("an unknown kind throws", () => {
    expect(() => mintIssuedSecret("scoped" as IssuedSecretKind)).toThrow();
  });

  test("every minted secret is masked, and its hint is not", () => {
    for (const kind of KINDS) {
      const secret = mintIssuedSecret(kind);
      expect(maskCredentialTokens(`here: ${secret}.`)).toBe("here: ***.");
      const hint = prefixHintOf(secret);
      expect(hint).toHaveLength(8);
      expect(secret.startsWith(hint)).toBe(true);
      expect(maskCredentialTokens(hint)).toBe(hint);
    }
    // Ids, digests and the bare prefix pass untouched.
    for (const value of [mintId("prn"), mintId("crd"), "ab".repeat(32), "chs_"]) {
      expect(maskCredentialTokens(value)).toBe(value);
    }
  });
});

describe("sha256Hex", () => {
  test("lowercase hex of SHA-256 over the UTF-8 of the text", async () => {
    for (const text of ["", "chs_x", "é"]) {
      expect(await sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("what the records keep of a service token", () => {
  test("its digest and an 8-character hint, never the secret; the list shows the hint only", async () => {
    const home = await homeFixture();
    const minted = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["home.read"],
        harnesses: [],
      }),
    );
    expect(ISSUED_SECRET_RES.service.test(minted.secret)).toBe(true);
    expect(minted.token.prefixHint).toBe(minted.secret.slice(0, 8));
    expect(minted.token).not.toHaveProperty("sha256");
    const row = home.snapshot().tokens.find((credential) => credential.id === minted.token.id);
    expect(row?.sha256).toBe(await sha256Hex(minted.secret));
    expect(row?.prefixHint).toHaveLength(8);
  });

  test("a lifetime is 180 days by default and no longer; a listed content or subject permission is refused", async () => {
    const home = await homeFixture();
    const minted = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["home.read"],
        harnesses: [],
      }),
    );
    expect(Date.parse(minted.token.expiresAt as string) - home.clock.now()).toBe(180 * 86_400_000);
    const tooLong = await home.access.mintServiceToken(home.actor, {
      service: "ci",
      permissions: ["home.read"],
      harnesses: [],
      ttlMs: 181 * 86_400_000,
    });
    expect(tooLong).toEqual(expect.objectContaining({ ok: false, code: "invalid" }));
    for (const permission of [
      "h.read.content",
      "h.subject.assert",
      "home.access.manage",
      "h.standing-rule.manage",
      "h.nope",
    ]) {
      const answer = await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: [permission],
        harnesses: [],
      });
      expect(`${permission} ${answer.ok}`).toBe(`${permission} false`);
    }
  });

  test("a service name in use by a member is refused, and a grant to a service is refused", async () => {
    const home = await homeFixture();
    ok(
      await home.access.grant(home.actor, {
        member: "Ana",
        create: true,
        role: "viewer",
        scope: "home",
      }),
    );
    const clash = await home.access.mintServiceToken(home.actor, {
      service: "ana",
      permissions: ["home.read"],
      harnesses: [],
    });
    expect(clash).toEqual(expect.objectContaining({ ok: false, code: "conflict" }));
    const ci = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "ci",
        permissions: ["home.read"],
        harnesses: [],
      }),
    );
    const grant = await home.access.grant(home.actor, {
      member: ci.principal,
      role: "viewer",
      scope: "home",
    });
    expect(grant).toEqual(expect.objectContaining({ ok: false, code: "invalid" }));
    const again = ok(
      await home.access.mintServiceToken(home.actor, {
        service: "CI",
        permissions: ["home.read"],
        harnesses: [],
      }),
    );
    expect(again.principal).toBe(ci.principal);
    expect(again.createdService).toBe(false);
  });
});
