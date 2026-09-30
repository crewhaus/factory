/**
 * `guardedGet` is this package's gate lent to a package with no HTTP client
 * of its own (`@crewhaus/tool-token` reads a contract's metadata through it),
 * so it is tested as a gate: the operator's list, the SSRF refusal, no
 * redirects, a byte cap. A real server on 127.0.0.1, as elsewhere here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __setPrivateHostsAllowedForTest, guardedGet } from "./index";

let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/moved") return Response.redirect(`${origin}/doc.json`, 302);
      if (path === "/big") return new Response("x".repeat(4096));
      return Response.json({ name: "token #1" });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("guardedGet", () => {
  test("loopback is refused by the SSRF gate even when it is on the list", async () => {
    await expect(
      guardedGet(`${origin}/doc.json`, { allowedOrigins: [origin], maxBytes: 1024 }),
    ).rejects.toThrow(/SSRF/);
  });

  test("an allowed origin is read, a redirect is refused, and the cap holds", async () => {
    __setPrivateHostsAllowedForTest(true);
    try {
      const got = await guardedGet(`${origin}/doc.json`, {
        allowedOrigins: [origin],
        maxBytes: 1024,
      });
      expect(got.status).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(got.bytes))).toEqual({ name: "token #1" });
      await expect(
        guardedGet(`${origin}/moved`, { allowedOrigins: [origin], maxBytes: 1024 }),
      ).rejects.toThrow('redirect policy is "error"');
      const big = await guardedGet(`${origin}/big`, { allowedOrigins: [origin], maxBytes: 100 });
      expect(big.truncated).toBe(true);
      expect(big.bytes.length).toBe(100);
    } finally {
      __setPrivateHostsAllowedForTest(false);
    }
  });

  test("an origin off the list is refused before anything is dialled", async () => {
    await expect(
      guardedGet("https://elsewhere.example/doc.json", {
        allowedOrigins: [origin],
        maxBytes: 1024,
      }),
    ).rejects.toThrow('origin "https://elsewhere.example" is not in allowed_origins');
    await expect(
      guardedGet("https://elsewhere.example/doc.json", { allowedOrigins: [], maxBytes: 1024 }),
    ).rejects.toThrow("empty allow-list = deny all");
  });
});
