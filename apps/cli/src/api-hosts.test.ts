/**
 * 0.7.1 — a rule on a tool that can be pointed at another API reads which API.
 *
 * The code-host tools reach the API their tool_config is set up for unless a
 * call names another in `baseUrl`, and a spec may allow-list several. A rule
 * read only the repository, so `alwaysAllow IssueCreate(acme/app)` granted
 * acme/app on every allow-listed host, and no rule could name a host. Now a
 * call that names an API is matched with that API's origin in front
 * (`https://ghe.example.com/acme/app`): an allow must name it, and a deny
 * reads the URL, the bare host and the repository on its own. A call that
 * names no API is read as before, so a spec with one host keeps its rules.
 *
 * Everything runs through runChatLoop's real gate and the real tools, against
 * two loopback servers standing for two allow-listed hosts; a name resolves to
 * loopback through the package's own resolver seam. The outcome is read from
 * what each server received.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import {
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  _resetCodehostConfig,
  __setPrivateHostsAllowedForTest as allowCodehostLoopback,
  issueCreate,
  issueList,
  registerCodehostConfig,
  searchCode,
  _setDnsLookup as setCodehostDns,
} from "@crewhaus/tool-codehost";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** A loopback server that records `METHOD /path` for every request it is sent. */
function server() {
  const got: string[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      got.push(`${req.method} ${url.pathname}`);
      if (url.pathname.includes("/search/")) return Response.json({ total_count: 0, items: [] });
      if (req.method === "GET") return Response.json([]);
      return Response.json({ number: 1, title: "t", state: "open", html_url: "x" });
    },
  });
  return { port: s.port ?? 0, got, stop: () => s.stop(true) };
}

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

/** A model that makes one call, then stops. */
function adapterFor(name: string, input: unknown): ProviderAdapter {
  let turn = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: () => {
      const first = turn++ === 0;
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: first
            ? { type: "tool_use", id: "tu_1", name, input: {} }
            : { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: first
            ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
            : { type: "text_delta", text: "done" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const A = server();
const B = server();
/** The API the tool_config is set up for, and a second allow-listed one a call may name. */
const originA = `http://api.example.test:${A.port}`;
const originB = `http://ghe.example.test:${B.port}`;
const baseB = `${originB}/api/v3`;
let state: string;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), "api-hosts-state-"));
  const loopback = async () => ({ address: "127.0.0.1", family: 4 });
  setCodehostDns(loopback);
  allowCodehostLoopback(true);
  process.env["API_HOSTS_TOKEN_A"] = "ghp_api_hosts_token_A_0123456789";
  process.env["API_HOSTS_TOKEN_B"] = "ghp_api_hosts_token_B_0123456789";
  registerCodehostConfig({
    allowed_origins: [originA, originB],
    base_url: originA,
    token_env: "API_HOSTS_TOKEN_A",
    token_envs: { API_HOSTS_TOKEN_B: [originB] },
  });
});

afterAll(() => {
  setCodehostDns(undefined);
  allowCodehostLoopback(false);
  _resetCodehostConfig();
  for (const name of ["API_HOSTS_TOKEN_A", "API_HOSTS_TOKEN_B"]) delete process.env[name];
  A.stop();
  B.stop();
  rmSync(state, { recursive: true, force: true });
});

type Outcome = {
  /** The gate's decision on the call. */
  readonly decision: string | undefined;
  /** The requests each server received during the call. */
  readonly a: ReadonlyArray<string>;
  readonly b: ReadonlyArray<string>;
};

/** One call through runChatLoop's real gate and the real tool. */
async function call(
  tool: RegisteredTool,
  input: unknown,
  ruleSet: RuleSet,
  mode: PermissionMode = "default",
): Promise<Outcome> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    events.push(e);
  });
  const before = { a: A.got.length, b: B.got.length };
  await runChatLoop({
    model: "test-model",
    instructions: "file the issue",
    runContext,
    sessionRootDir: mkdtempSync(join(state, "sess-")),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: mode,
    permissionRules: ruleSet,
    tools: [tool],
    justificationJudge: () => ({ allow: true, reason: "on task", judgeModel: "test" }),
    _adapter: adapterFor(tool.name, input),
  });
  const first = events.find((e) => e.kind === "permission_decision");
  return {
    decision: first?.kind === "permission_decision" ? first.decision : undefined,
    a: A.got.slice(before.a),
    b: B.got.slice(before.b),
  };
}

const issue = { owner: "acme", repo: "app", title: "Broken build", justification: "file it" };
/** The same issue on the second host: the call names its API and its token. */
const issueOnB = { ...issue, baseUrl: baseB, tokenEnv: "API_HOSTS_TOKEN_B" };
const created = ["POST /repos/acme/app/issues"];
const createdOnB = ["POST /api/v3/repos/acme/app/issues"];

// ---------------------------------------------------------------------------
// code host
// ---------------------------------------------------------------------------

describe("a code-host rule reads the API a call names (baseUrl)", () => {
  test("an allow that names no host covers the configured API only", async () => {
    const rs = rules(["alwaysAllow", "IssueCreate(acme/app)"]);
    expect(await call(issueCreate, issue, rs)).toEqual({ decision: "allow", a: created, b: [] });
    // The same repository on the second host is not what the rule named.
    expect(await call(issueCreate, issueOnB, rs)).toEqual({ decision: "ask", a: [], b: [] });
  }, 30_000);

  test("an allow that names the host covers that host, and only it", async () => {
    const onB = rules(["alwaysAllow", `IssueCreate(${originB}/acme/app)`]);
    expect(await call(issueCreate, issueOnB, onB)).toEqual({
      decision: "allow",
      a: [],
      b: createdOnB,
    });
    expect(await call(issueCreate, issue, onB)).toEqual({ decision: "ask", a: [], b: [] });
    // An owner on that host, not another one there.
    const owner = rules(["alwaysAllow", `IssueCreate(${originB}/acme/*)`]);
    expect(await call(issueCreate, { ...issueOnB, owner: "evil" }, owner)).toEqual({
      decision: "ask",
      a: [],
      b: [],
    });
    // `**/acme/app` names the repository on any host.
    const anyHost = rules(["alwaysAllow", "IssueCreate(**/acme/app)"]);
    expect(await call(issueCreate, issue, anyHost)).toEqual({
      decision: "allow",
      a: created,
      b: [],
    });
    expect(await call(issueCreate, issueOnB, anyHost)).toEqual({
      decision: "allow",
      a: [],
      b: createdOnB,
    });
  }, 30_000);

  test("a deny written on the host fires on a call to it, however the host is spelled", async () => {
    for (const glob of [
      // as a URL: another scheme and no port still name the host
      "https://ghe.example.test/**",
      `${originB}/**`,
      // the bare host, and the API root
      "ghe.example.test/**",
      `${baseB}/**`,
      // the repository on that host
      "https://ghe.example.test/acme/app",
    ]) {
      const rs = rules(["alwaysDeny", `IssueCreate(${glob})`], ["alwaysAllow", "IssueCreate"]);
      expect({ glob, got: await call(issueCreate, issueOnB, rs) }).toEqual({
        glob,
        got: { decision: "deny", a: [], b: [] },
      });
      // A call to the configured API is not that host.
      expect({ glob, got: await call(issueCreate, issue, rs) }).toEqual({
        glob,
        got: { decision: "allow", a: created, b: [] },
      });
    }
  }, 60_000);

  test("a deny that names no host fires on every host", async () => {
    const rs = rules(["alwaysDeny", "IssueCreate(acme/app)"], ["alwaysAllow", "IssueCreate"]);
    expect(await call(issueCreate, issue, rs)).toEqual({ decision: "deny", a: [], b: [] });
    expect(await call(issueCreate, issueOnB, rs)).toEqual({ decision: "deny", a: [], b: [] });
  }, 30_000);

  test("plan and auto mode honour a host deny and ask on the read tools too", async () => {
    const list = { owner: "acme", repo: "app", baseUrl: baseB, tokenEnv: "API_HOSTS_TOKEN_B" };
    for (const type of ["alwaysDeny", "alwaysAsk"] as const) {
      const rs = rules([type, "IssueList(https://ghe.example.test/**)"]);
      expect({ type, got: await call(issueList, list, rs, "plan") }).toEqual({
        type,
        got: { decision: "deny", a: [], b: [] },
      });
      expect({ type, got: await call(issueList, list, rs, "auto") }).toEqual({
        type,
        got: { decision: type === "alwaysDeny" ? "deny" : "ask", a: [], b: [] },
      });
    }
    // The same read on the configured API runs in plan mode.
    const rs = rules(["alwaysDeny", "IssueList(https://ghe.example.test/**)"]);
    const onA = await call(issueList, { owner: "acme", repo: "app" }, rs, "plan");
    expect(onA.decision).toBe("allow");
    expect(onA.a).toEqual(["GET /repos/acme/app/issues"]);
  }, 60_000);

  test("a search on a named host that covers a denied repository meets the deny", async () => {
    const rs = rules(
      ["alwaysDeny", "SearchCode(https://ghe.example.test/acme/secret)"],
      ["alwaysAllow", "SearchCode"],
    );
    const onB = { baseUrl: baseB, tokenEnv: "API_HOSTS_TOKEN_B", query: "password" };
    // Every repository on the host, and every one of the owner's.
    expect(await call(searchCode, onB, rs)).toEqual({ decision: "deny", a: [], b: [] });
    expect(
      await call(searchCode, { ...onB, owner: "acme", query: "password org:acme" }, rs),
    ).toEqual({ decision: "deny", a: [], b: [] });
    // Another owner's on that host is not this rule's business.
    const other = await call(
      searchCode,
      { ...onB, owner: "other", query: "password org:other" },
      rs,
    );
    expect(other.decision).toBe("allow");
    expect(other.b).toEqual(["GET /api/v3/search/code"]);
  }, 30_000);

  test("a base URL that names no origin a request can go to is granted by no allow", async () => {
    const rs = rules(["alwaysAllow", "IssueCreate(**)"]);
    const withUser = { ...issueOnB, baseUrl: baseB.replace("http://", "http://user:pw@") };
    expect(await call(issueCreate, withUser, rs)).toEqual({ decision: "ask", a: [], b: [] });
  }, 30_000);
});
