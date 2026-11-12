/**
 * The Host allowlist, against a live Home: a name it does not know answers 421 on every
 * path but `/healthz`, before a boot link is spent; every name it should know passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeFrom } from "./__test__/browser";
import { MISDIRECTED_TEXT, allowedHosts, hostAllowed, hostNameOf } from "./host-allowlist";
import { type BootOptions, type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const ASSETS = {
  "/index.html": {
    body: "<!doctype html><title>Hangar — CrewHaus</title>",
    contentType: "text/html",
  },
  "/assets/js/app.js": { body: "export {};", contentType: "text/javascript" },
};

function boot(opts: BootOptions = {}): TestServer {
  const t = bootTestServer({ assets: ASSETS, ...opts });
  servers.push(t);
  return t;
}

const FOREIGN = "rebind.example.test";

describe("a name Home does not know", () => {
  test("answers 421 everywhere but /healthz, and does not spend a boot link", async () => {
    const t = boot();
    const as = (host: string, init: RequestInit = {}): RequestInit => ({
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
    });
    const bootPath = t.server.bootPath as string;
    const paths: Array<[string, RequestInit]> = [
      ["/", {}],
      ["/assets/js/app.js", {}],
      ["/api/harnesses", { headers: { authorization: `Bearer ${t.token}` } }],
      ["/api/v1/auth/challenge", {}],
      [bootPath, { redirect: "manual" }],
      ["/pane/0000", {}],
    ];
    for (const [path, init] of paths) {
      const res = await t.fetchRaw(path, as(FOREIGN, init));
      expect(`${path} ${res.status}`).toBe(`${path} 421`);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.text()).trim()).toBe(MISDIRECTED_TEXT);
    }
    // The refused request did not spend the link: it still redirects, once.
    expect((await codeFrom(t.fetchRaw, bootPath)).length).toBe(43);
    expect((await t.fetchRaw(bootPath, { redirect: "manual" })).status).toBe(404);
    // Liveness answers whatever the name.
    expect((await t.fetchRaw("/healthz", as(FOREIGN))).status).toBe(200);
  });

  test("a missing or malformed Host is refused", () => {
    const hosts = allowedHosts({ bound: ["127.0.0.1"] });
    for (const header of [
      null,
      "",
      ":4200",
      "127.0.0.1:port",
      "localhost.",
      "a:b:c",
      "[::1",
      "[::1]x",
    ]) {
      expect(`${header} ${hostAllowed(header, hosts)}`).toBe(`${header} false`);
    }
  });
});

describe("the names Home knows", () => {
  test("loopback in each spelling, --allow-host, the owner's names, the base URL's host and the proxy's", async () => {
    const again = boot({
      allowHosts: ["home.lan.example.test"],
      // The owner's blocks are read at boot.
      prepare: ({ hangarRoot }) =>
        writeFileSync(
          join(hangarRoot, "settings.json"),
          JSON.stringify({
            access: {
              allowedHosts: ["Owner.Example.Test"],
              trustedProxy: {
                header: "X-Auth-User",
                peers: ["127.0.0.1/32"],
                hosts: ["proxy.example.test"],
                secretDigest: "0".repeat(64),
              },
            },
            links: { baseUrl: "https://base.example.test/home" },
          }),
        ),
    });
    const port = again.server.port;
    for (const host of [
      `127.0.0.1:${port}`,
      "localhost",
      `localhost:${port}`,
      `[::1]:${port}`,
      "LOCALHOST",
      "home.lan.example.test",
      "owner.example.test",
      "base.example.test",
      "proxy.example.test",
    ]) {
      const res = await again.fetchRaw("/healthz-not", { headers: { host } });
      expect(`${host} ${res.status}`).toBe(`${host} 404`);
    }
    expect((await again.fetchRaw("/", { headers: { host: "localhost." } })).status).toBe(421);
    expect((await again.fetchRaw("/", { headers: { host: "evil.example.test" } })).status).toBe(
      421,
    );
  });

  test("a wildcard bind adds this computer's addresses, never the wildcard itself", () => {
    const hosts = allowedHosts({
      bound: ["0.0.0.0"],
      interfaces: () => ({
        en0: [
          { address: "192.168.1.20", family: "IPv4" },
          { address: "fe80::1%en0", family: "IPv6" },
        ],
        lo0: [{ address: "127.0.0.1", family: "IPv4" }],
      }),
    });
    expect(hosts.has("192.168.1.20")).toBe(true);
    expect(hosts.has("[fe80::1]")).toBe(true);
    expect(hosts.has("0.0.0.0")).toBe(false);
    expect(hostAllowed("0.0.0.0:4200", hosts)).toBe(false);
    expect(hostAllowed("192.168.1.20:4200", hosts)).toBe(true);
  });

  test("names are compared lower-case and without the port; an IPv6 address keeps its brackets", () => {
    expect(hostNameOf("LocalHost:4200")).toBe("localhost");
    expect(hostNameOf("[::1]:4200")).toBe("[::1]");
    expect(hostNameOf("[::1]")).toBe("[::1]");
    expect(hostNameOf("::1")).toBeUndefined();
  });
});
