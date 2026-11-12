/**
 * Trusted-proxy mode against a live Home: the identity header counts only from a listed
 * peer that sends the proxy's secret, or on the proxy's socket; anywhere else it is
 * stripped and noted, content-free, at most once per peer per hour. A fake proxy that
 * logs everything it relays logs no secret Home issued and not Home's own key.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAccessSetUp, localActorOf, openAccess } from "@crewhaus/access-control";
import { bearer, codeFrom, exchange, refresh, returning } from "./__test__/browser";
import { type BootOptions, type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

/** Built at runtime from parts, never a real secret. */
const SECRET = ["proxy", "secret", "for", "tests", "only"].join("-");
const OWNER = "max@example.test";
const HOUR = 60 * 60 * 1000;

async function sha256(text: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
}

function proxySettings(proxy: Record<string, unknown>): BootOptions["prepare"] {
  return ({ hangarRoot }) =>
    writeFileSync(
      join(hangarRoot, "settings.json"),
      JSON.stringify({ access: { trustedProxy: { header: "X-Auth-User", hosts: [], ...proxy } } }),
    );
}

async function bootProxied(
  proxy: Record<string, unknown>,
  opts: BootOptions = {},
): Promise<TestServer> {
  const t = bootTestServer({ ...opts, prepare: proxySettings(proxy) });
  servers.push(t);
  return t;
}

/** Set access up as this OS user and link the proxy subject to the owner (or a new member). */
async function link(t: TestServer, value: string, member?: string): Promise<void> {
  const setup = await ensureAccessSetUp(t.hangarRoot, {
    localActor: localActorOf({ username: "tester", hostname: "test-host" }),
  });
  if (!setup.ok) throw new Error(setup.reason);
  const done = await openAccess(t.hangarRoot).link(
    { principal: setup.result.owner },
    member === undefined
      ? { subject: `proxy:x-auth-user:${value}`, member: setup.result.owner }
      : { subject: `proxy:x-auth-user:${value}`, member, create: true },
  );
  if (!done.ok) throw new Error(done.reason);
}

const securityLines = (t: TestServer): string[] => {
  const path = join(t.hangarRoot, "access", "security.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
};

describe("boot", () => {
  test("refuses a trusted proxy on a Home bound beyond loopback", () => {
    expect(() =>
      bootTestServer({
        hostname: "0.0.0.0",
        prepare: proxySettings({ peers: ["127.0.0.1/32"], secretDigest: "0".repeat(64) }),
      }),
    ).toThrow(/listens on this computer only/);
  });

  test("refuses a trusted proxy with no proof, naming the file and the field", () => {
    expect(() => bootTestServer({ prepare: proxySettings({ peers: ["127.0.0.1/32"] }) })).toThrow(
      /settings\.json: access\.trustedProxy needs a proof/,
    );
  });
});

describe("the identity header", () => {
  test("from a listed peer with the secret, linked to the owner: the owner", async () => {
    const t = await bootProxied({ peers: ["127.0.0.1/32"], secretDigest: await sha256(SECRET) });
    await link(t, OWNER);
    const res = await t.fetchRaw("/api/version", {
      headers: { "x-auth-user": OWNER, "crewhaus-proxy-secret": SECRET },
    });
    expect(res.status).toBe(200);
  });

  test("from an unlisted peer it is ignored, and noted once per peer per hour", async () => {
    let clock = Date.parse("2026-11-11T00:00:00.000Z");
    const t = await bootProxied(
      { peers: ["10.0.0.0/8"], secretDigest: await sha256(SECRET) },
      { now: () => clock },
    );
    await link(t, OWNER);
    const headers = { "x-auth-user": OWNER, "crewhaus-proxy-secret": SECRET };
    for (let i = 0; i < 2; i++) {
      const res = await t.fetchRaw("/api/version", { headers });
      // An owner-linked identity that does not count names nobody.
      expect(res.status).toBe(401);
    }
    const lines = securityLines(t);
    expect(lines.length).toBe(1);
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(["at", "event", "listener", "peerRef", "v"]);
    expect(line["event"]).toBe("identity_header_ignored");
    expect(line["listener"]).toBe("tcp");
    expect(line["peerRef"]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0]).not.toContain("127.0.0.1");
    expect(lines[0]).not.toContain(OWNER);
    clock += HOUR;
    await t.fetchRaw("/api/version", { headers });
    expect(securityLines(t).length).toBe(2);
  });

  test("with a wrong secret it is ignored", async () => {
    const t = await bootProxied({ peers: ["127.0.0.1/32"], secretDigest: await sha256(SECRET) });
    await link(t, OWNER);
    const res = await t.fetchRaw("/api/version", {
      headers: { "x-auth-user": OWNER, "crewhaus-proxy-secret": "not-the-secret" },
    });
    expect(res.status).toBe(401);
  });

  test("an unlinked identity is asked to get an invite", async () => {
    const t = await bootProxied({ peers: ["127.0.0.1/32"], secretDigest: await sha256(SECRET) });
    await link(t, OWNER);
    const res = await t.fetchRaw("/api/version", {
      headers: { "x-auth-user": "stranger@example.test", "crewhaus-proxy-secret": SECRET },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; reason: string };
    expect(body.code).toBe("forbidden");
    expect(body.reason).toBe("not_invited");
    expect(body.error).toBe("Ask the owner of this Home to invite you.");
  });

  test("a listed peer with the secret and no identity is not the owner, even with Home's own key", async () => {
    const t = await bootProxied({ peers: ["127.0.0.1/32"], secretDigest: await sha256(SECRET) });
    await link(t, OWNER);
    const res = await t.fetchRaw("/api/version", {
      headers: { "crewhaus-proxy-secret": SECRET, ...bearer(t.token) },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason: string }).reason).toBe("bootstrap_not_accepted_here");
  });

  test.skipIf(process.platform === "win32")(
    "on the proxy's socket it counts with no secret (skipped on Windows: no unix sockets)",
    async () => {
      const t = await bootProxied({ peers: [], socket: true });
      await link(t, OWNER);
      const sock = join(t.hangarRoot, "proxy.sock");
      const res = await fetch("http://localhost/api/version", {
        unix: sock,
        headers: { "x-auth-user": OWNER },
      } as RequestInit);
      expect(res.status).toBe(200);
      // Home's own key is not taken on the proxy's socket.
      const key = await fetch("http://localhost/api/version", {
        unix: sock,
        headers: bearer(t.token),
      } as RequestInit);
      expect(key.status).toBe(401);
    },
  );
});

describe("a proxy that logs everything", () => {
  test("logs no session secret and not Home's own key", async () => {
    const t = await bootProxied({ peers: ["127.0.0.1/32"], secretDigest: await sha256(SECRET) });
    await link(t, OWNER);
    const log = join(t.workspace, "proxy.log");
    writeFileSync(log, "");
    const write = (line: string): void => appendFileSync(log, `${line}\n`);
    // Like a reverse proxy's access log: request line, headers and body, then the
    // response's. The Authorization header is redacted, as Caddy's default access log
    // does: what this proves is that nothing Home answers, and nothing a browser posts,
    // carries a secret in the clear.
    const proxy = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? undefined : await req.text();
        write(`> ${req.method} ${url.pathname}`);
        for (const [name, value] of req.headers) {
          write(`> ${name}: ${name === "authorization" ? "REDACTED" : value}`);
        }
        if (body !== undefined) write(`> ${body}`);
        const headers = new Headers(req.headers);
        headers.delete("host");
        headers.set("x-auth-user", OWNER);
        headers.set("crewhaus-proxy-secret", SECRET);
        const upstream = await fetch(`${t.base}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
        });
        const text = await upstream.text();
        write(`< ${upstream.status}`);
        for (const [name, value] of upstream.headers) write(`< ${name}: ${value}`);
        write(`< ${text}`);
        return new Response(text, { status: upstream.status, headers: upstream.headers });
      },
    });
    stops.push(() => proxy.stop(true));
    const via = (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`http://127.0.0.1:${proxy.port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });

    const code = await codeFrom(via, t.server.bootPath as string);
    const browser = await exchange(via, code);
    const back = await returning(via, browser);
    expect(back.status).toBe(200);
    const fresh = await refresh(via, back.session as string);
    const read = await via("/api/harnesses", { headers: bearer(fresh) });
    expect(read.status).toBe(200);

    const text = readFileSync(log, "utf8");
    expect(text).toContain("/api/v1/auth/exchange");
    expect(text).toContain("/api/v1/auth/refresh");
    expect(text).not.toMatch(/cha_[A-Za-z0-9_-]{43}/);
    for (const secret of [browser.session, back.session as string, fresh])
      expect(text).not.toContain(secret);
    expect(text).not.toContain(t.token);
    // The exchange code did pass through, in a request body; it was spent before the log
    // could be read.
    expect(text).toContain(code);
    await expect(exchange(t.fetchRaw, code)).rejects.toThrow(/code_unknown/);
  }, 20_000); // four WebCrypto round trips through a second server
});
