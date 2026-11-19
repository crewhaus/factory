/**
 * `./credentials`: the token provider names what to set and never echoes a value, and a
 * code host origin is admitted on the tools' own SSRF terms. A loopback host is admitted
 * only when the caller passes `allowLoopback`, by the origin check and by every request
 * through `CallCtx.allowLoopback`, against a real server on 127.0.0.1; RFC1918 and
 * link-local are refused either way. The tests' own loopback switch stays off here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CodehostOriginError, assertCodehostOrigin, tokenEnvProvider } from "./credentials";
import { CodehostPermissionError, __setPrivateHostsAllowedForTest, _setDnsLookup } from "./net";
import { getPull, withPullsCall } from "./pulls";

const TOKEN = ["fake", "host", "token", "value"].join("-");

describe("tokenEnvProvider", () => {
  const ask = { origin: "https://api.github.com", repo: "acme/app" };

  test("answers the named variable's value", async () => {
    const provider = tokenEnvProvider({ tokenEnv: "DELIVERY_TOKEN", env: { DELIVERY_TOKEN: TOKEN } });
    expect(await provider(ask)).toEqual({ ok: true, token: TOKEN });
  });

  test("an absent name, a malformed one and an empty value name the key and echo nothing", async () => {
    for (const [tokenEnv, env] of [
      [undefined, { DELIVERY_TOKEN: TOKEN }],
      ["$DELIVERY_TOKEN", { DELIVERY_TOKEN: TOKEN }],
      ["DELIVERY_TOKEN", { DELIVERY_TOKEN: "" }],
      ["DELIVERY_TOKEN", {}],
    ] as const) {
      const answer = await tokenEnvProvider({ tokenEnv, env })(ask);
      expect(answer.ok).toBe(false);
      if (answer.ok) continue;
      expect(answer.code).toBe("credential_unavailable");
      expect(answer.message).toContain("tool_config.codehost.token_env");
      expect(answer.message).not.toContain(TOKEN);
    }
  });
});

describe("assertCodehostOrigin", () => {
  beforeAll(() => __setPrivateHostsAllowedForTest(false));
  afterAll(() => _setDnsLookup(undefined));

  test("a public https origin passes, canonical", async () => {
    _setDnsLookup(async () => ({ address: "140.82.112.3", family: 4 }));
    expect(await assertCodehostOrigin("https://GitHub.com:443")).toEqual({
      origin: "https://github.com",
      loopback: false,
    });
  });

  test("loopback only with allowLoopback, http only for loopback", async () => {
    await expect(assertCodehostOrigin("http://127.0.0.1:8080")).rejects.toBeInstanceOf(
      CodehostOriginError,
    );
    await expect(assertCodehostOrigin("https://127.0.0.1:8443")).rejects.toThrow("private");
    expect(await assertCodehostOrigin("http://127.0.0.1:8080", { allowLoopback: true })).toEqual({
      origin: "http://127.0.0.1:8080",
      loopback: true,
    });
    expect(
      (await assertCodehostOrigin("https://localhost:9", { allowLoopback: true })).loopback,
    ).toBe(true);
    _setDnsLookup(async () => ({ address: "140.82.112.3", family: 4 }));
    await expect(
      assertCodehostOrigin("http://github.com", { allowLoopback: true }),
    ).rejects.toThrow("https");
  });

  test("RFC1918, link-local and a name resolving there are refused, allowLoopback or not", async () => {
    for (const origin of ["https://10.0.0.5", "https://192.168.1.1", "https://169.254.169.254"]) {
      await expect(assertCodehostOrigin(origin, { allowLoopback: true })).rejects.toBeInstanceOf(
        CodehostOriginError,
      );
    }
    _setDnsLookup(async () => ({ address: "192.168.1.10", family: 4 }));
    await expect(
      assertCodehostOrigin("https://git.internal.example", { allowLoopback: true }),
    ).rejects.toThrow("192.168.1.10");
  });

  test("userinfo, a path and another scheme are refused", async () => {
    _setDnsLookup(async () => ({ address: "140.82.112.3", family: 4 }));
    for (const origin of [
      "https://user:pass@github.com",
      "https://github.com/acme",
      "https://github.com/?q=1",
      "ftp://github.com",
      "not a url",
    ]) {
      await expect(assertCodehostOrigin(origin)).rejects.toBeInstanceOf(CodehostOriginError);
    }
  });
});

describe("a request through CallCtx.allowLoopback", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: string[] = [];
  beforeAll(() => {
    __setPrivateHostsAllowedForTest(false);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return Response.json({
          number: 1,
          state: "open",
          head: { ref: "crewhaus/x", sha: "a".repeat(40) },
          base: { ref: "main" },
        });
      },
    });
  });
  afterAll(() => server.stop(true));

  const call = (allowLoopback: boolean) =>
    withPullsCall(
      {
        apiBase: `http://127.0.0.1:${server.port}`,
        token: TOKEN,
        timeoutMs: 10_000,
        allowLoopback,
      },
      (c) => getPull(c, { owner: "acme", name: "app" }, 1),
    );

  test("reaches a loopback host only when the call admits it", async () => {
    await expect(call(false)).rejects.toBeInstanceOf(CodehostPermissionError);
    expect(seen).toEqual([]);
    const answer = await call(true);
    expect(answer).toMatchObject({ ok: true, pull: { number: 1, headRef: "crewhaus/x" } });
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
  });
});
