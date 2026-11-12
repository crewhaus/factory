/**
 * What lies on disk after a Home is set up and used: no issued secret and no body of one,
 * the bootstrap token only in its own file, no raw local actor in an append-only row,
 * no field name the masker would redact, and every row a valid wire shape.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISSUED_SECRET_RES, isStoredActor } from "@crewhaus/control-contract";
import { grant, invite, link, member, tokenRow } from "@crewhaus/control-contract/schemas";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { redeemInvite } from "./access";
import { accessPaths } from "./paths";
import { openSignIn } from "./sign-in";
import {
  BOOTSTRAP_TOKEN,
  type Fixture,
  LOCAL,
  filesUnder,
  homeFixture,
  ok,
  projectionPath,
  removeTempDirs,
} from "./test-helpers";
import { listInvites, listMembers, listTokens } from "./views";

afterAll(removeTempDirs);

type Used = { home: Fixture; secrets: string[] };

/** A Home after the migration, an invite (one redeemed), a service token and links. */
async function usedHome(): Promise<Used> {
  const home = await homeFixture({ harnesses: [[]] });
  const [h] = home.harnesses;
  if (h === undefined) throw new Error("no harness");
  const first = ok(await home.access.createInvite(home.actor, { role: "viewer", scope: "home" }));
  const second = ok(
    await home.access.createInvite(home.actor, { role: "operator", scope: `harness:${h.id}` }),
  );
  expect((await redeemInvite(home.root, second.code, { now: home.clock.now })).ok).toBe(true);
  const token = ok(
    await home.access.mintServiceToken(home.actor, {
      service: "ci",
      permissions: ["h.decision.resolve"],
      harnesses: [h.id],
      contentRead: true,
    }),
  );
  ok(await home.access.link(home.actor, { subject: "slack:T0:U0", member: "Ana", create: true }));
  ok(
    await home.access.grant(home.actor, {
      member: "Ana",
      role: "operator",
      scope: `harness:${h.id}`,
    }),
  );
  ok(await home.access.link(home.actor, { subject: "github:99", member: "Ana" }));
  return { home, secrets: [first.code, second.code, token.secret, ...(await signedIn(home))] };
}

/** A UI module Home serves, loaded by URL. */
async function uiModule<T>(name: string): Promise<T> {
  return (await import(new URL(`../../hangar-ui/assets/js/${name}`, import.meta.url).href)) as T;
}

type Jwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

/**
 * Browsers sign in, come back, refresh and sign out, and a proxy header from a stray peer
 * is noted. Answers every secret, code and address that went by.
 */
async function signedIn(home: Fixture): Promise<string[]> {
  const sealed = await uiModule<{
    makeSeal(): Promise<{ seal: Jwk; open(issued: unknown, op: string): Promise<string> }>;
  }>("sealed.js");
  const ui = await uiModule<{
    makeDeviceKey(): Promise<{ privateKey: CryptoKey; deviceJwk: Jwk }>;
    signChallenge(
      key: CryptoKey,
      input: { device: string; nonce: string; seal: Jwk },
    ): Promise<string>;
  }>("sign-in.js");
  const signIn = openSignIn(home.root, { now: home.clock.now, localActor: LOCAL });
  const code = signIn.mintExchangeCode(signIn.mintBootTicket().slice("/boot/".length)) as string;
  const key = await ui.makeDeviceKey();
  const first = await sealed.makeSeal();
  const exchanged = await signIn.exchange({ code, deviceJwk: key.deviceJwk, seal: first.seal });
  if (!exchanged.ok) throw new Error(exchanged.reason);
  const one = await first.open(exchanged.issued, "auth.exchange");
  const { nonce } = signIn.challenge();
  const second = await sealed.makeSeal();
  const signature = await ui.signChallenge(key.privateKey, {
    device: exchanged.device,
    nonce,
    seal: second.seal,
  });
  const returned = await signIn.signInWithDevice({
    device: exchanged.device,
    nonce,
    signature,
    seal: second.seal,
  });
  if (!returned.ok) throw new Error(returned.reason);
  const two = await second.open(returned.issued, "auth.session");
  const check = await signIn.verifyBearer(two);
  if (!check.ok) throw new Error(check.reason);
  const third = await sealed.makeSeal();
  const refreshed = await signIn.refresh(check.sessionRef, third.seal);
  if (!refreshed.ok) throw new Error(refreshed.reason);
  const three = await third.open(refreshed.issued, "auth.refresh");
  const last = await signIn.verifyBearer(three);
  if (!last.ok) throw new Error(last.reason);
  await signIn.signOut(last.sessionRef);
  await signIn.noteIgnoredIdentity("tcp", PEER_ADDRESS);
  return [code, nonce, one, two, three, PEER_ADDRESS];
}

/** A documentation address (RFC 5737): it must never reach a record. */
const PEER_ADDRESS = "203.0.113.77";

/** Every file under the Hangar root and every projection, as `path: text`. */
function everyFile({ home }: Used): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of filesUnder(home.root)) out[rel] = readFileSync(join(home.root, rel), "utf8");
  for (const h of home.harnesses)
    out[`${h.name}:approvers.json`] = readFileSync(projectionPath(h), "utf8");
  return out;
}

/** Each place a secret or its body appears. */
function leaks(files: Record<string, string>, secrets: readonly string[]): string[] {
  const out: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const secret of secrets) {
      if (text.includes(secret.slice(4))) out.push(path);
    }
    for (const re of Object.values(ISSUED_SECRET_RES)) {
      const unanchored = new RegExp(re.source.slice(1, -1));
      if (unanchored.test(text)) out.push(`${path} (shape)`);
    }
  }
  return out;
}

describe("no plaintext secret at rest", () => {
  test("no issued secret, no body of one, and the bootstrap token only in its own file", async () => {
    const used = await usedHome();
    const files = everyFile(used);
    expect(Object.keys(files).length).toBeGreaterThan(10);
    for (const rel of ["devices.jsonl", "sessions.jsonl", "security.jsonl"]) {
      expect(Object.keys(files)).toContain(`access/${rel}`);
    }
    expect(leaks(files, used.secrets)).toEqual([]);
    expect(
      Object.entries(files)
        .filter(([, text]) => text.includes(BOOTSTRAP_TOKEN))
        .map(([path]) => path),
    ).toEqual(["token"]);
  });

  test("the scan catches a secret planted in a row (positive control)", async () => {
    const used = await usedHome();
    const rel = accessPaths().ledgers.grants;
    const path = join(used.home.root, rel);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}${JSON.stringify({ note: used.secrets[2] })}\n`,
    );
    expect(leaks(everyFile(used), used.secrets)).toContain(rel);
    const bootstrapPlanted = join(used.home.root, accessPaths().revision);
    writeFileSync(bootstrapPlanted, BOOTSTRAP_TOKEN);
    expect(
      Object.entries(everyFile(used)).filter(([, text]) => text.includes(BOOTSTRAP_TOKEN)).length,
    ).toBe(2);
  });
});

function rows(home: Fixture): { file: string; row: Record<string, unknown> }[] {
  const out: { file: string; row: Record<string, unknown> }[] = [];
  for (const rel of filesUnder(join(home.root, "access"))) {
    if (!rel.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(home.root, "access", rel), "utf8").split("\n")) {
      if (line !== "") out.push({ file: rel, row: JSON.parse(line) as Record<string, unknown> });
    }
  }
  return out;
}

function keysOf(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

describe("the rows", () => {
  test("no row holds a raw local actor; every actor field is a stored actor", async () => {
    const { home } = await usedHome();
    const all = rows(home);
    expect(all.length).toBeGreaterThan(10);
    for (const { file, row } of all) {
      expect(JSON.stringify(row)).not.toContain("local:");
      for (const field of ["by", "grantedBy", "createdBy"]) {
        if (field in row)
          expect(`${file} ${field} ${isStoredActor(row[field])}`).toBe(`${file} ${field} true`);
      }
    }
  });

  test("no key of anything this package writes or answers is one the masker redacts", async () => {
    const used = await usedHome();
    const { home } = used;
    const names = new Set<string>();
    for (const { row } of rows(home)) keysOf(row, names);
    for (const rel of filesUnder(join(home.root, "access"))) {
      if (rel.endsWith(".json"))
        keysOf(JSON.parse(readFileSync(join(home.root, "access", rel), "utf8")), names);
    }
    for (const h of home.harnesses)
      keysOf(JSON.parse(readFileSync(projectionPath(h), "utf8")), names);
    const snapshot = home.snapshot();
    keysOf(snapshot, names);
    keysOf(listMembers(snapshot, home.clock.now()), names);
    keysOf(listTokens(snapshot, home.clock.now()), names);
    keysOf(listInvites(snapshot, home.clock.now()), names);
    for (const expected of [
      "sha256",
      "prefixHint",
      "subjectRef",
      "contentRead",
      "governedSince",
      "verifiedVia",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    expect([...names].filter((name) => isCredentialKey(name))).toEqual([]);
    // The check itself can fail.
    expect(isCredentialKey("inviteToken")).toBe(true);
  });

  test("each row parses with its wire schema, the principal joined with its name", async () => {
    const { home } = await usedHome();
    const snapshot = home.snapshot();
    const now = home.clock.now();
    let checked = 0;
    for (const view of listMembers(snapshot, now)) {
      expect(member.safeParse(view).success).toBe(true);
      checked++;
    }
    for (const row of snapshot.grants) expect(grant.safeParse(row).success).toBe(true);
    for (const row of snapshot.invites) expect(invite.safeParse(row).success).toBe(true);
    for (const row of snapshot.tokens) expect(tokenRow.safeParse(row).success).toBe(true);
    for (const row of snapshot.links) expect(link.safeParse(row).success).toBe(true);
    for (const view of listTokens(snapshot, now))
      expect(tokenRow.safeParse(view).success).toBe(true);
    expect(checked).toBe(3);
    expect(
      snapshot.invites.some((row) => row.state === "consumed" && row.consumedAt !== undefined),
    ).toBe(true);
  });

  test("an ended row says it ended", async () => {
    const { home } = await usedHome();
    const before = home.snapshot();
    const anaGrant = before.grants.find((row) => row.role === "operator");
    ok(await home.access.revoke(home.actor, anaGrant?.id as string));
    const after = home.snapshot().grants.find((row) => row.id === anaGrant?.id);
    expect(after).toEqual(
      expect.objectContaining({ state: "revoked", revokedAt: expect.any(String) }),
    );
    expect(grant.safeParse(after).success).toBe(true);
  });
});

describe("lists", () => {
  test("no list answer carries a sha256", async () => {
    const { home } = await usedHome();
    const snapshot = home.snapshot();
    const now = home.clock.now();
    const digests = [...snapshot.tokens, ...snapshot.invites].map((row) => row.sha256);
    expect(digests.length).toBeGreaterThan(3);
    for (const list of [
      listMembers(snapshot, now),
      listTokens(snapshot, now),
      listInvites(snapshot, now),
    ]) {
      expect(keysOf(list, new Set()).has("sha256")).toBe(false);
      const text = JSON.stringify(list);
      expect(digests.filter((digest) => text.includes(digest))).toEqual([]);
    }
  });
});
