/**
 * A call names only a token variable the operator configured, and the token
 * goes only to the origin it was configured for (C155, flag-truth-5#11,
 * security-10#8).
 *
 * 0.7.0 resolved `input.tokenEnv ?? cfg.tokenEnv` and `input.baseUrl ??
 * cfg.baseUrl`: the call's arguments beat the operator's config. Any
 * process variable could be sent as `Authorization: Bearer` to an allowed
 * origin (a provider key, a deploy token), a token configured for a
 * self-hosted instance could be aimed at another allowed host by passing a
 * `baseUrl`, and the refusal text told set variables from unset ones. The
 * read tools are readOnly, so plan and auto mode ran them unasked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetCodehostConfig,
  prList,
  rateLimitStatus,
  registerCodehostConfig,
} from "./index";
import { CodehostPermissionError, buildCodehostConfig } from "./net";

const TOKEN_VAR = "CREWHAUS_TEST_CH_TOKEN";
const TOKEN = "configured-token-value-4e2a";
const OTHER_VAR = "CREWHAUS_TEST_CH_OTHER_SECRET";
const OTHER = "sk-other-provider-value-91b0";
const GHE_VAR = "CREWHAUS_TEST_CH_GHE_TOKEN";
const GHE = "ghe-token-value-77d1";

type Seen = { server: "A" | "B"; path: string; auth: string | null };
let seen: Seen[] = [];
let a: ReturnType<typeof Bun.serve>;
let b: ReturnType<typeof Bun.serve>;
let originA = "";
let originB = "";

const rate = () =>
  Response.json({ resources: { core: { limit: 1, remaining: 1, used: 0, reset: 1 } } });

beforeAll(() => {
  a = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push({ server: "A", path, auth: req.headers.get("authorization") });
      if (path === "/repos/acme/widget/pulls") {
        return Response.json([{ number: 1, title: "one", state: "open" }], {
          headers: { link: `<${originB}/repos/acme/widget/pulls?page=2>; rel="next"` },
        });
      }
      return rate();
    },
  });
  b = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      seen.push({ server: "B", path, auth: req.headers.get("authorization") });
      if (path === "/repos/acme/widget/pulls") return Response.json([]);
      return rate();
    },
  });
  originA = `http://127.0.0.1:${a.port}`;
  originB = `http://127.0.0.1:${b.port}`;
});

afterAll(() => {
  a.stop(true);
  b.stop(true);
});

beforeEach(() => {
  seen = [];
  process.env[TOKEN_VAR] = TOKEN;
  process.env[OTHER_VAR] = OTHER;
  process.env[GHE_VAR] = GHE;
  __setPrivateHostsAllowedForTest(true);
  registerCodehostConfig({
    allowed_origins: [originA, originB],
    base_url: originA,
    token_env: TOKEN_VAR,
  });
});

afterEach(() => {
  for (const name of [TOKEN_VAR, OTHER_VAR, GHE_VAR]) delete process.env[name];
  __setPrivateHostsAllowedForTest(false);
  _resetCodehostConfig();
});

const call = async (input: Record<string, unknown>, toolConfig?: unknown): Promise<string> =>
  String(
    await rateLimitStatus.execute(input, (toolConfig === undefined ? {} : { toolConfig }) as never),
  );

describe("the token variable is the operator's choice (C155)", () => {
  test("a call cannot name another process secret: refused, nothing sent, nothing read", async () => {
    const out = await call({ tokenEnv: OTHER_VAR });
    expect(out).toContain("tool_config.codehost.token_envs");
    expect(out).toContain(`"${OTHER_VAR}" is not listed`);
    expect(out).not.toContain(OTHER);
    expect(seen).toEqual([]);
  });

  test("the refusal is the same whether the variable is set or not", async () => {
    const set = await call({ tokenEnv: OTHER_VAR });
    delete process.env[OTHER_VAR];
    expect(await call({ tokenEnv: OTHER_VAR })).toBe(set);
  });

  test("with no token_env or token_envs, a named variable is refused (fail-closed)", async () => {
    const out = await call(
      { tokenEnv: TOKEN_VAR },
      { allowed_origins: [originA], base_url: originA },
    );
    expect(out).toContain("tool_config.codehost.token_envs");
    expect(seen).toEqual([]);
  });

  test("naming the configured token_env, or nothing, still works", async () => {
    await call({});
    await call({ tokenEnv: TOKEN_VAR });
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  test("a variable listed in token_envs may be chosen, through the per-call block too", async () => {
    const cfg = {
      allowed_origins: [originA, originB],
      base_url: originA,
      token_env: TOKEN_VAR,
      token_envs: [OTHER_VAR],
    };
    await call({ tokenEnv: OTHER_VAR }, cfg);
    expect(seen).toEqual([{ server: "A", path: "/rate_limit", auth: `Bearer ${OTHER}` }]);
  });

  test("a pasted token is refused without being quoted", async () => {
    const pasted = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    const out = await call({ tokenEnv: pasted });
    expect(out).not.toContain(pasted);
    expect(seen).toEqual([]);
  });
});

describe("the token goes only where it was configured for (C155)", () => {
  test("token_env belongs to base_url: a call's own baseUrl cannot carry it elsewhere", async () => {
    const out = await call({ baseUrl: originB });
    expect(out).toContain(`may be sent only to ${originA}`);
    expect(seen).toEqual([]);
  });

  test("a token_envs map entry names the origins its token may go to", async () => {
    const cfg = {
      allowed_origins: [originA, originB],
      base_url: originA,
      token_env: TOKEN_VAR,
      token_envs: { [GHE_VAR]: [originB] },
    };
    await call({ tokenEnv: GHE_VAR, baseUrl: originB }, cfg);
    expect(seen).toEqual([{ server: "B", path: "/rate_limit", auth: `Bearer ${GHE}` }]);
    seen = [];
    const out = await call({ tokenEnv: GHE_VAR, baseUrl: originA }, cfg);
    expect(out).toContain(`may be sent only to ${originB}`);
    expect(seen).toEqual([]);
  });

  test("net-review: with no base_url, token_env belongs to the host's default API, not to any allowed origin", async () => {
    // The common configuration: token_env alone, the GitHub API implied. The
    // first 0.7.1 cut bound the token only when base_url was set, so a
    // call's own baseUrl sent the operator's GitHub token to server B.
    let checked = 0;
    for (const input of [{ baseUrl: originB }, { baseUrl: originA }, { host: "gitlab" as const }]) {
      const out = await call(input, {
        allowed_origins: [originA, originB, "https://gitlab.com"],
        token_env: TOKEN_VAR,
      });
      expect({
        input,
        refused: out.includes("may be sent only to https://api.github.com"),
      }).toEqual({ input, refused: true });
      checked += 1;
    }
    expect(checked).toBe(3);
    expect(seen).toEqual([]);
  });

  test("with no base_url and host gitlab, token_env belongs to gitlab.com's API", async () => {
    const out = await call(
      { baseUrl: originB },
      { allowed_origins: [originB], token_env: TOKEN_VAR, host: "gitlab" },
    );
    expect(out).toContain("may be sent only to https://gitlab.com");
    expect(seen).toEqual([]);
  });

  test("a token_envs list entry, which names no origins, may still go to any allowed origin", async () => {
    await call(
      { baseUrl: originB, tokenEnv: OTHER_VAR },
      { allowed_origins: [originA, originB], token_env: TOKEN_VAR, token_envs: [OTHER_VAR] },
    );
    expect(seen).toEqual([{ server: "B", path: "/rate_limit", auth: `Bearer ${OTHER}` }]);
  });

  test("a next-page link naming another allowed origin is followed without the token", async () => {
    const out = JSON.parse(
      String(await prList.execute({ owner: "acme", repo: "widget", state: "open" }, {} as never)),
    );
    expect(out).toBeDefined();
    expect(seen.map((s) => [s.server, s.auth])).toEqual([
      ["A", `Bearer ${TOKEN}`],
      ["B", null],
    ]);
  });
});

describe("token_envs is checked at boot (C155)", () => {
  test("a malformed entry is refused without being echoed", () => {
    const pasted = `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`;
    let message = "";
    try {
      buildCodehostConfig({ allowed_origins: ["https://api.github.com"], token_envs: [pasted] });
    } catch (err) {
      expect(err).toBeInstanceOf(CodehostPermissionError);
      message = (err as Error).message;
    }
    expect(message).toContain("token_envs lists environment variable NAMES");
    expect(message).not.toContain(pasted);
  });

  test("a map entry must name allowed origins", () => {
    expect(() =>
      buildCodehostConfig({
        allowed_origins: ["https://api.github.com"],
        token_envs: { GHE_TOKEN: ["https://ghe.example.com"] },
      }),
    ).toThrow(/not in allowed_origins/);
  });
});
