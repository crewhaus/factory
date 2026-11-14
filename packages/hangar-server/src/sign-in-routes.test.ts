/**
 * The sign-in routes end to end, with WebCrypto in Bun and the console's own modules:
 * a boot link, an exchange, a session that reads the API, a returning device, a refresh
 * and a sign-out. Every issuing answer is never cached and is unchanged by the masker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import {
  acceptInvite,
  acceptInviteTabOnly,
  bearer,
  codeFrom,
  exchange,
  refresh,
  returning,
  sealedJs,
  signInFromBootLink,
  signInJs,
} from "./__test__/browser";
import { maskDeep } from "./mask";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(opts: Parameters<typeof bootTestServer>[0] = {}): TestServer {
  const t = bootTestServer(opts);
  servers.push(t);
  return t;
}

/** An invite from the owner, as `crewhaus access invite` makes one. */
async function inviteFrom(t: TestServer, role: string, scope = "home"): Promise<string> {
  await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
  const read = loadAccessSnapshot(t.hangarRoot);
  if (read.state !== "present") throw new Error("no access records");
  const done = await openAccess(t.hangarRoot).createInvite(
    { principal: read.snapshot.owner as string },
    { role, scope },
  );
  if (!done.ok) throw new Error(done.reason);
  return done.result.code;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("a browser signs in", () => {
  test("boot link → code → exchange → the API answers the session", async () => {
    const t = boot();
    const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    expect(browser.session).toMatch(/^cha_[A-Za-z0-9_-]{43}$/);
    const res = await t.fetchRaw("/api/harnesses", { headers: bearer(browser.session) });
    expect(res.status).toBe(200);
  });

  test("every issuing answer is never cached and is unchanged by the masker", async () => {
    const t = boot();
    const answers: Response[] = [];
    const recording = async (path: string, init?: RequestInit): Promise<Response> => {
      const res = await t.fetchRaw(path, init);
      if (path.startsWith("/api/v1/auth/")) answers.push(res.clone());
      return res;
    };
    const browser = await signInFromBootLink(recording, t.server.bootPath as string);
    const back = await returning(recording, browser);
    expect(back.status).toBe(200);
    await refresh(recording, back.session as string);
    const issuing = answers.filter((res) => res.url.includes("/challenge") === false);
    expect(issuing.length).toBe(3);
    for (const res of answers) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as unknown;
      expect(maskDeep(body)).toEqual(body);
    }
  });

  test("a request that also carries X-Forwarded-For still signs in through the exchange", async () => {
    const t = boot();
    const forwarded = (path: string, init: RequestInit = {}): Promise<Response> =>
      t.fetchRaw(path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": "203.0.113.9" },
      });
    const browser = await signInFromBootLink(forwarded, t.server.bootPath as string);
    const res = await forwarded("/api/harnesses", { headers: bearer(browser.session) });
    expect(res.status).toBe(200);
  });

  test("a code works once", async () => {
    const t = boot();
    const code = await codeFrom(t.fetchRaw, t.server.bootPath as string);
    await exchange(t.fetchRaw, code);
    await expect(exchange(t.fetchRaw, code)).rejects.toThrow(/401.*code_unknown/);
  });
});

describe("refusals", () => {
  test("a body that fails its schema is a 400 that never echoes the code", async () => {
    const t = boot();
    const code = await codeFrom(t.fetchRaw, t.server.bootPath as string);
    const res = await t.fetchRaw(
      "/api/v1/auth/exchange",
      json({ code, deviceJwk: { kty: "RSA" } }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(code);
    const body = JSON.parse(text) as {
      error: { code: string; retryable: boolean; details: { reason: string } };
    };
    expect(body.error.code).toBe("invalid");
    expect(body.error.details.reason).toBe("body_invalid");
    expect(body.error.retryable).toBe(false);
    // A refused body did not spend the code.
    expect((await exchange(t.fetchRaw, code)).session).toMatch(/^cha_/);
    expect(
      (await t.fetchRaw("/api/v1/auth/exchange", { method: "POST", body: "{not json" })).status,
    ).toBe(400);
  });

  test("refresh and sign-out need a session, and Home's own key is not one", async () => {
    const t = boot();
    const seal = await (await sealedJs()).makeSeal();
    const bare = await t.fetchRaw("/api/v1/auth/refresh", json({ seal: seal.seal }));
    expect(bare.status).toBe(401);
    const asOwner = await t.fetchRaw("/api/v1/auth/sign-out", {
      ...json({}),
      headers: { "content-type": "application/json", ...bearer(t.token) },
    });
    expect(asOwner.status).toBe(403);
    expect(
      ((await asOwner.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("session_required");
  });

  test("a wrong method is 405 and an unknown sign-in path 404, in the v1 envelope", async () => {
    const t = boot();
    const wrong = await t.fetchRaw("/api/v1/auth/challenge", { method: "POST" });
    expect(wrong.status).toBe(405);
    const missing = await t.fetchRaw("/api/v1/auth/nowhere", json({}));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("a signed-out session no longer works, and a session cannot mint boot links", async () => {
    const t = boot();
    const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const minted = await t.fetchRaw("/api/boot-ticket", {
      method: "POST",
      headers: bearer(browser.session),
    });
    expect(minted.status).toBe(403);
    expect(((await minted.json()) as { reason: string }).reason).toBe("owner_only");
    const out = await t.fetchRaw("/api/v1/auth/sign-out", {
      ...json({}),
      headers: { "content-type": "application/json", ...bearer(browser.session) },
    });
    expect(await out.json()).toEqual({ signedOut: true });
    const after = await t.fetchRaw("/api/harnesses", { headers: bearer(browser.session) });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { reason: string }).reason).toBe("session_unknown");
  });

  test("a device signature over another seal is refused", async () => {
    const t = boot();
    const browser = await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
    const challenge = (await (await t.fetchRaw("/api/v1/auth/challenge")).json()) as {
      nonce: string;
    };
    const sealed = await sealedJs();
    const mine = await sealed.makeSeal();
    const relay = await sealed.makeSeal();
    const signature = await (await signInJs()).signChallenge(browser.privateKey, {
      device: browser.device,
      nonce: challenge.nonce,
      seal: mine.seal,
    });
    const res = await t.fetchRaw(
      "/api/v1/auth/session",
      json({ device: browser.device, nonce: challenge.nonce, signature, seal: relay.seal }),
    );
    expect(res.status).toBe(401);
    expect(
      ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("signature_invalid");
  });
});

describe("a sign-in body is held to its limit as it is read", () => {
  test("a declared length over the limit is refused as an invalid body", async () => {
    const t = boot();
    const res = await t.fetchRaw("/api/v1/auth/exchange", json({ pad: "x".repeat(9 * 1024) }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("body_invalid");
  });

  test("a streamed body that passes the limit is answered without waiting for its end", async () => {
    const t = boot();
    // 16 KiB, then a stream that never ends. A read of the whole body would
    // wait for an end that never comes, and the fetch would time out; the
    // counted read answers at the chunk that passes 8 KiB.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 16) return new Promise<void>(() => {});
        sent++;
        controller.enqueue(new Uint8Array(1024).fill(0x20));
        return undefined;
      },
    });
    const res = await t.fetchRaw("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("body_invalid");
  });
});

describe("joining from an invite", () => {
  test("a sealed join makes a member whose session reads what the invite's role may", async () => {
    const t = boot();
    const code = await inviteFrom(t, "viewer");
    const member = await acceptInvite(t.fetchRaw, code, "Ana");
    expect(Object.keys(member.answer).sort()).toEqual([
      "device",
      "expiresAt",
      "issued",
      "principal",
      "receipt",
    ]);
    const list = await t.fetchRaw("/api/harnesses", { headers: bearer(member.session) });
    expect(list.status).toBe(200);
    // A viewer changes nothing.
    const scan = await t.fetchRaw("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(member.session) },
      body: "{}",
    });
    expect(scan.status).toBe(403);
    expect(((await scan.json()) as { reason: string }).reason).toBe("permission");
    // The code works once.
    const again = await t.fetchRaw(
      "/api/v1/auth/accept-invite",
      json({ code, displayName: "Bo", sessionSecret: "A".repeat(43) }),
    );
    expect(again.status).toBe(403);
    const reused = await acceptInvite(t.fetchRaw, code, "Bo").catch((err: Error) => err.message);
    expect(String(reused)).toContain("401");
    expect(String(reused)).toContain("consumed");
  });

  test("a tab-only join is refused on a Home started without the LAN door", async () => {
    const t = boot();
    const code = await inviteFrom(t, "viewer");
    const tab = await acceptInviteTabOnly(t.fetchRaw, code, "Ana");
    expect(tab.status).toBe(403);
    expect((tab.body["error"] as { details: { reason: string } }).details.reason).toBe("tab_only");
    // Nothing was spent: the same code still joins with keys.
    expect((await acceptInvite(t.fetchRaw, code, "Ana")).session.startsWith("cha_")).toBe(true);
  });

  test("a tab-only join answers no secret, counts only on its address, and cannot be renewed", async () => {
    const t = boot({ lanHost: "127.0.0.1" });
    const code = await inviteFrom(t, "viewer");
    // Relayed or on another name, it is refused before the invite is spent.
    const relayed = await acceptInviteTabOnly(t.fetchRaw, code, "Ana", {
      "x-forwarded-for": "10.0.0.9",
    });
    expect(relayed.status).toBe(403);
    const elsewhere = await acceptInviteTabOnly(t.fetchRaw, code, "Ana", {
      host: `localhost:${t.server.port}`,
    });
    expect(elsewhere.status).toBe(403);
    const tab = await acceptInviteTabOnly(t.fetchRaw, code, "Ana");
    expect(tab.status).toBe(200);
    expect(Object.keys(tab.body).sort()).toEqual([
      "expiresAt",
      "ok",
      "principal",
      "receipt",
      "tabOnly",
    ]);
    expect(JSON.stringify(tab.body)).not.toContain(tab.session.slice(4));
    const read = await t.fetchRaw("/api/harnesses", { headers: bearer(tab.session) });
    expect(read.status).toBe(200);
    const offHost = await t.fetchRaw("/api/harnesses", {
      headers: { ...bearer(tab.session), host: `localhost:${t.server.port}` },
    });
    expect(offHost.status).toBe(403);
    const seal = await (await sealedJs()).makeSeal();
    const renewed = await t.fetchRaw("/api/v1/auth/refresh", {
      ...json({ seal: seal.seal }),
      headers: { "content-type": "application/json", ...bearer(tab.session) },
    });
    expect(renewed.status).toBe(403);
    expect(
      ((await renewed.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("tab_only");
  });
});

describe("joining is on record", () => {
  const joins = (t: TestServer): Record<string, unknown>[] => {
    const dir = join(t.hangarRoot, "control", "commands");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["kind"] === "auth.acceptInvite");
  };

  test("an accepted invite writes one workspace receipt, as the new member", async () => {
    const t = boot();
    const code = await inviteFrom(t, "viewer");
    const member = await acceptInvite(t.fetchRaw, code, "Ana");
    const rows = joins(t);
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "succeeded"]);
    expect(rows[0]?.["actor"]).toBe(member.answer["principal"]);
    expect(String(rows[0]?.["target"]).startsWith("home/cmd/")).toBe(true);
    expect((member.answer["receipt"] as Record<string, unknown>)["id"]).toBe(rows[0]?.["id"]);
    // A second acceptance of the same code is refused and writes none.
    await acceptInvite(t.fetchRaw, code, "Bo").catch(() => undefined);
    expect(joins(t)).toHaveLength(2);
  });

  test("a tab-only join is on record too", async () => {
    const t = boot({ lanHost: "127.0.0.1" });
    const code = await inviteFrom(t, "viewer");
    const joined = await acceptInviteTabOnly(t.fetchRaw, code, "Tab");
    expect(joined.status).toBe(200);
    const rows = joins(t);
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "succeeded"]);
    expect(rows[0]?.["actor"]).toBe(joined.body["principal"]);
  });
});
