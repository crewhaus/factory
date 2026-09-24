/**
 * An `auth` profile may only read a variable the operator listed (C050:
 * config-delivery#4, flag-truth-4#2, security-8#4).
 *
 * In 0.7.0 `auth.envVar` was model input and `applyAuth` read
 * `process.env[name]` for ANY name, so a model (or the text steering it)
 * could send ANTHROPIC_API_KEY as a bearer token, or under any header name,
 * to an allowed origin, through tools plan and auto mode run unasked
 * (HttpPaginate, HeadRequest, HttpWaitFor, SseRead are read-only). The
 * egress classifier saw only the NAME. And whatever the server echoed back
 * (a 401 quoting the key, a debug endpoint repeating headers, a JSON
 * preview) reached the transcript unredacted.
 *
 * Now `tool_config.http.allowed_auth_envs` names the variables (optionally
 * bound to origins); anything else is refused before a socket opens, and
 * every spelling of a resolved secret is scrubbed from what comes back.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  downloadFile,
  graphqlQuery,
  headRequest,
  httpBatch,
  httpPaginate,
  httpRequest,
  httpWaitFor,
  registerHttpConfig,
  sseRead,
} from "./index";
import { HttpPermissionError, buildHttpConfig } from "./net";

const LISTED = "CREWHAUS_TEST_LISTED_TOKEN";
const UNLISTED = "CREWHAUS_TEST_UNLISTED_SECRET";
const LISTED_VALUE = "listed-s3cret-VALUE+/=42";
const UNLISTED_VALUE = "unlisted-provider-key-9f8e7d";

type Seen = { server: string; path: string; authorization: string | null; apiKey: string | null };
let seen: Seen[] = [];

function recorder(name: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const authorization = req.headers.get("authorization");
    const apiKey = req.headers.get("x-api-key");
    seen.push({ server: name, path: url.pathname, authorization, apiKey });
    await req.text();
    if (url.pathname === "/401") {
      return new Response(`Bad credentials: got ${authorization ?? apiKey}`, { status: 401 });
    }
    if (url.pathname === "/notjson") {
      return new Response(`oops ${authorization} and ${encodeURIComponent(authorization ?? "")}`);
    }
    if (url.pathname === "/sse") {
      return new Response(`data: ${authorization}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(
      JSON.stringify({
        items: [{ authorization, apiKey }],
        data: { authorization },
        authorization,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
}

let a: ReturnType<typeof Bun.serve>;
let b: ReturnType<typeof Bun.serve>;
let originA = "";
let originB = "";
const cwd = process.cwd();
let workspace = "";

beforeAll(() => {
  a = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: recorder("a") });
  b = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: recorder("b") });
  originA = `http://127.0.0.1:${a.port}`;
  originB = `http://127.0.0.1:${b.port}`;
});

afterAll(() => {
  a.stop(true);
  b.stop(true);
});

beforeEach(() => {
  seen = [];
  workspace = mkdtempSync(path.join(tmpdir(), "crewhaus-http-auth-"));
  process.chdir(workspace);
  __setPrivateHostsAllowedForTest(true);
  process.env[LISTED] = LISTED_VALUE;
  process.env[UNLISTED] = UNLISTED_VALUE;
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(workspace, { recursive: true, force: true });
  __setPrivateHostsAllowedForTest(false);
  _resetHttpConfig();
  delete process.env[LISTED];
  delete process.env[UNLISTED];
});

async function call(tool: RegisteredTool, input: unknown, ctx?: unknown): Promise<string> {
  const out = await tool.execute(input, ctx as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

/** Every auth-capable tool, with the smallest input that reaches its request. */
const AUTH_TOOLS: ReadonlyArray<[RegisteredTool, (url: string) => Record<string, unknown>]> = [
  [httpRequest, (url) => ({ url })],
  [
    httpPaginate,
    (url) => ({ url, style: "link", itemsPath: "items", maxPages: 1, timeoutMs: 5_000 }),
  ],
  [graphqlQuery, (url) => ({ url, query: "{ x }" })],
  [httpBatch, (url) => ({ requests: [{ url }] })],
  [downloadFile, (url) => ({ url, path: "out.json" })],
  [headRequest, (url) => ({ url })],
  [httpWaitFor, (url) => ({ url, expectStatus: [200], timeoutMs: 2_000, intervalMs: 100 })],
  [sseRead, (url) => ({ url: url.replace("/echo", "/sse"), timeoutMs: 2_000 })],
];

describe("an auth profile reads only a variable the operator listed", () => {
  test("every auth-capable tool refuses an unlisted variable before a socket opens", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    let checked = 0;
    for (const [tool, input] of AUTH_TOOLS) {
      const out = await call(tool, {
        ...input(`${originA}/echo`),
        auth: { type: "header", headerName: "X-Anything", envVar: UNLISTED },
      });
      expect({ tool: tool.name, refused: out.includes("allowed_auth_envs") }).toEqual({
        tool: tool.name,
        refused: true,
      });
      expect(out).not.toContain(UNLISTED_VALUE);
      checked++;
    }
    expect(checked).toBe(8);
    expect(seen).toEqual([]);
  });

  test("the refusal is the same whether or not the unlisted variable is set", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    const set = await call(httpRequest, {
      url: `${originA}/echo`,
      auth: { type: "bearer", envVar: UNLISTED },
    });
    delete process.env[UNLISTED];
    const unset = await call(httpRequest, {
      url: `${originA}/echo`,
      auth: { type: "bearer", envVar: UNLISTED },
    });
    expect(set).toBe(unset);
    expect(seen).toEqual([]);
  });

  test("with no allowed_auth_envs at all, every auth profile is refused", async () => {
    registerHttpConfig({ allowed_origins: [originA] });
    const out = await call(httpRequest, {
      url: `${originA}/echo`,
      auth: { type: "bearer", envVar: LISTED },
    });
    expect(out).toContain("allowed_auth_envs lists no variables");
    expect(seen).toEqual([]);
  });

  test("a pasted secret in envVar is refused and never quoted back", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    for (const pasted of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-live-abc def",
      "has space",
    ]) {
      const out = await call(httpRequest, {
        url: `${originA}/echo`,
        auth: { type: "bearer", envVar: pasted },
      });
      expect(out).toContain("has not been echoed back");
      expect(out).not.toContain(pasted);
    }
    expect(seen).toEqual([]);
  });

  test("a per-call tool_config block uses its own list and never inherits the boot one", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    const out = await call(
      httpRequest,
      { url: `${originA}/echo`, auth: { type: "bearer", envVar: LISTED } },
      { toolConfig: { allowed_origins: [originA] } },
    );
    expect(out).toContain("allowed_auth_envs lists no variables");
    expect(seen).toEqual([]);
  });
});

describe("what a server echoes of a listed credential is scrubbed", () => {
  const forms = (value: string): string[] => [
    value,
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
  ];

  test("an echoing server, a 401 that quotes the key, and a JSON preview carry none of its spellings", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    const auth = { type: "bearer", envVar: LISTED };
    const outs = [
      await call(httpRequest, { url: `${originA}/echo`, auth }),
      await call(httpRequest, { url: `${originA}/401`, auth }),
      await call(httpRequest, { url: `${originA}/notjson`, auth, parseJson: true }),
      await call(httpPaginate, {
        url: `${originA}/echo`,
        auth,
        style: "link",
        itemsPath: "items",
        maxPages: 1,
        timeoutMs: 5_000,
      }),
      await call(graphqlQuery, { url: `${originA}/echo`, query: "{ x }", auth }),
      await call(httpBatch, { requests: [{ url: `${originA}/echo` }], auth }),
      await call(sseRead, { url: `${originA}/sse`, auth, timeoutMs: 2_000 }),
    ];
    // The credential really went out, every time.
    expect(seen.length).toBe(outs.length);
    expect(seen.every((s) => s.authorization === `Bearer ${LISTED_VALUE}`)).toBe(true);
    for (const out of outs) {
      for (const form of forms(LISTED_VALUE)) expect(out).not.toContain(form);
      expect(out).toContain("<redacted>");
    }
    // A redacted JSON result still parses.
    expect(JSON.parse(outs[0] as string).body).toContain("<redacted>");
  });

  test("a basic profile's user:secret pair and its base64 are scrubbed too", async () => {
    registerHttpConfig({ allowed_origins: [originA], allowed_auth_envs: [LISTED] });
    const out = await call(httpRequest, {
      url: `${originA}/401`,
      auth: { type: "basic", envVar: LISTED, username: "ada" },
    });
    const pair = `ada:${LISTED_VALUE}`;
    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from(pair).toString("base64")}`);
    for (const form of [...forms(LISTED_VALUE), ...forms(pair)]) expect(out).not.toContain(form);
    expect(out).toContain("Basic <redacted>");
  });
});

describe("a credential bound to origins goes nowhere else", () => {
  test("HttpRequest to an allowed origin the credential is not bound to is refused before dialling", async () => {
    registerHttpConfig({
      allowed_origins: [originA, originB],
      allowed_auth_envs: { [LISTED]: [originA] },
    });
    const out = await call(httpRequest, {
      url: `${originB}/echo`,
      auth: { type: "bearer", envVar: LISTED },
    });
    expect(out).toContain(`may be sent only to ${originA}`);
    expect(seen).toEqual([]);
    const ok = JSON.parse(
      await call(httpRequest, { url: `${originA}/echo`, auth: { type: "bearer", envVar: LISTED } }),
    );
    expect(ok.status).toBe(200);
    expect(seen.map((s) => s.server)).toEqual(["a"]);
  });

  test("HttpBatch sends the credential only to the origin it is bound to", async () => {
    registerHttpConfig({
      allowed_origins: [originA, originB],
      allowed_auth_envs: { [LISTED]: [originA] },
    });
    const out = JSON.parse(
      await call(httpBatch, {
        requests: [{ url: `${originA}/echo` }, { url: `${originB}/echo` }],
        auth: { type: "bearer", envVar: LISTED },
      }),
    );
    expect(out.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
    expect(out.results[1].error).toContain("may be sent only to");
    expect(seen).toEqual([
      { server: "a", path: "/echo", authorization: `Bearer ${LISTED_VALUE}`, apiKey: null },
    ]);
  });
});

describe("allowed_auth_envs is checked when the harness starts", () => {
  test.each([
    [["has space"]],
    [["ghp_abcdefghijklmnopqrstuvwxyz0123456789"]],
    [[42]],
    ["GITHUB_TOKEN"],
    [{ "not a name": ["https://a.example"] }],
  ])("%p is refused, and the entry is not echoed", (entry) => {
    let message = "";
    try {
      buildHttpConfig({
        allowed_origins: ["https://a.example"],
        allowed_auth_envs: entry as never,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpPermissionError);
      message = (err as Error).message;
    }
    expect(message).toContain("tool_config.http.allowed_auth_envs");
    for (const part of [entry].flat()) {
      if (typeof part === "string" && part !== "GITHUB_TOKEN") expect(message).not.toContain(part);
    }
  });

  test("a binding to an origin outside allowed_origins, or to none, is refused", () => {
    expect(() =>
      buildHttpConfig({
        allowed_origins: ["https://a.example"],
        allowed_auth_envs: { TOKEN: ["https://b.example"] },
      }),
    ).toThrow(/TOKEN lists https:\/\/b\.example, which is not in allowed_origins/);
    expect(() =>
      buildHttpConfig({ allowed_origins: ["https://a.example"], allowed_auth_envs: { TOKEN: [] } }),
    ).toThrow(/must list the origins/);
  });

  test("both spellings are read, camelCase first, as allowed_origins is", () => {
    expect([...buildHttpConfig({ allowedAuthEnvs: ["A_TOKEN"] }).authEnvs.keys()]).toEqual([
      "A_TOKEN",
    ]);
    expect([...buildHttpConfig({ allowed_auth_envs: ["B_TOKEN"] }).authEnvs.keys()]).toEqual([
      "B_TOKEN",
    ]);
  });
});
