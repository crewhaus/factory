/**
 * Sealed issuance, both halves: the server seals here and the browser module Home serves
 * opens it, so a byte of drift between the two fails this file. The answer must parse as
 * control-contract's `issued`, and the masker must leave every field of it alone.
 */
import { describe, expect, test } from "bun:test";
import { issued as issuedSchema } from "@crewhaus/control-contract/schemas";
import { isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";
import { type Issued, sealSecret } from "./sealed";
import { mintIssuedSecret } from "./secrets";

type SealedJs = {
  makeSeal(): Promise<{
    seal: { kty: "EC"; crv: "P-256"; x: string; y: string };
    open(issued: Issued, op: string): Promise<string>;
  }>;
  openIssued(key: CryptoKey, issued: Issued, op: string): Promise<string>;
};

async function loadSealedJs(): Promise<SealedJs> {
  const url = new URL("../../hangar-ui/assets/js/sealed.js", import.meta.url).href;
  return (await import(url)) as SealedJs;
}

describe("sealed issuance", () => {
  test("a secret sealed here opens in the browser module, for its operation", async () => {
    const ui = await loadSealedJs();
    const client = await ui.makeSeal();
    expect(Object.keys(client.seal).sort()).toEqual(["crv", "kty", "x", "y"]);
    const secret = mintIssuedSecret("session");
    for (const op of [
      "auth.exchange",
      "auth.session",
      "auth.refresh",
      "auth.acceptInvite",
    ] as const) {
      const issued = await sealSecret(client.seal, secret, op);
      expect(await client.open(issued, op)).toBe(secret);
    }
  });

  test("the answer is hex the contract parses, and its epk is a raw uncompressed point", async () => {
    const ui = await loadSealedJs();
    const client = await ui.makeSeal();
    const issued = await sealSecret(client.seal, mintIssuedSecret("session"), "auth.session");
    expect(issuedSchema.safeParse(issued).success).toBe(true);
    expect(issued.alg).toBe("ECDH-ES+A256GCM");
    expect(issued.epk).toMatch(/^04[0-9a-f]{128}$/);
    expect(issued.iv).toMatch(/^[0-9a-f]{24}$/);
    // 43-character body plus the prefix, plus the 16-byte tag.
    expect(issued.ct.length).toBe((47 + 16) * 2);
  });

  test("another seal key, another operation or a flipped byte each fail to open", async () => {
    const ui = await loadSealedJs();
    const client = await ui.makeSeal();
    const other = await ui.makeSeal();
    const issued = await sealSecret(client.seal, mintIssuedSecret("session"), "auth.exchange");
    await expect(other.open(issued, "auth.exchange")).rejects.toThrow();
    await expect(client.open(issued, "auth.session")).rejects.toThrow();
    const last = issued.ct.slice(-2);
    const flipped = (Number.parseInt(last, 16) ^ 0x01).toString(16).padStart(2, "0");
    await expect(
      client.open({ ...issued, ct: issued.ct.slice(0, -2) + flipped }, "auth.exchange"),
    ).rejects.toThrow();
  });

  test("every key is masker-safe and every value passes the token masker unchanged", async () => {
    const ui = await loadSealedJs();
    const client = await ui.makeSeal();
    for (let i = 0; i < 20; i++) {
      const issued = await sealSecret(client.seal, mintIssuedSecret("session"), "auth.refresh");
      for (const [key, value] of Object.entries(issued)) {
        expect(`${key}:${isCredentialKey(key)}`).toBe(`${key}:false`);
        expect(maskCredentialTokens(value)).toBe(value);
      }
    }
  });

  test("a seal that is not a P-256 point is refused", async () => {
    await expect(
      sealSecret(
        { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) },
        "x",
        "auth.session",
      ),
    ).rejects.toThrow();
  });
});
