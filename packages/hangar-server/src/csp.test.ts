/**
 * Every page and asset Home serves carries the one policy, exactly, with its companions;
 * the built-in index too. JSON answers need not (a browser never renders them as pages).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME_CSP } from "./csp";
import type { StaticAsset } from "./server";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

/** The console's assets, read from disk (importing them as text here would collide with
 *  the tests that import the same files as modules). */
function consoleAssets(): Record<string, StaticAsset> {
  const root = join(import.meta.dir, "..", "..", "hangar-ui", "assets");
  const out: Record<string, StaticAsset> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else {
        const type = name.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : name.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/html; charset=utf-8";
        out[rel === "index.html" ? "/index.html" : `/assets/${rel}`] = {
          body: readFileSync(full, "utf8"),
          contentType: type,
        };
      }
    }
  };
  walk(root, "");
  return out;
}

const COMPANIONS = {
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

describe("the page policy", () => {
  test("is the minimal list: Home's own scripts, styles, fetches and frames, nothing else", () => {
    expect(HOME_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(HOME_CSP).not.toContain("unsafe-inline");
    expect(HOME_CSP).not.toContain("unsafe-eval");
  });

  test("rides every embedded asset, and the shell at /", async () => {
    const assets = consoleAssets();
    const t = bootTestServer({ assets });
    servers.push(t);
    const paths = ["/", ...Object.keys(assets).filter((p) => p !== "/index.html")];
    expect(paths.length).toBeGreaterThan(40);
    for (const path of paths) {
      const res = await t.fetchRaw(path);
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
      expect(`${path} ${res.headers.get("content-security-policy")}`).toBe(`${path} ${HOME_CSP}`);
      for (const [name, value] of Object.entries(COMPANIONS)) {
        expect(`${path} ${name}: ${res.headers.get(name)}`).toBe(`${path} ${name}: ${value}`);
      }
    }
  });

  test("rides the built-in index of a build with no console", async () => {
    const t = bootTestServer({});
    servers.push(t);
    const res = await t.fetchRaw("/");
    expect(await res.text()).toContain("Hangar manager API");
    expect(res.headers.get("content-security-policy")).toBe(HOME_CSP);
    // The index lists the sign-in routes, so an enumeration of Home's routes finds them.
    const again = await (await t.fetchRaw("/")).text();
    for (const path of [
      "/api/v1/auth/challenge",
      "/api/v1/auth/session",
      "/api/v1/auth/exchange",
      "/api/v1/auth/refresh",
      "/api/v1/auth/sign-out",
    ]) {
      expect(again).toContain(path);
    }
  });
});
