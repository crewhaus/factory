/**
 * 0.7.1 — a rule on a tool that can be pointed at another API reads which API.
 *
 * The code-host tools (`baseUrl`) and the Chat tools (`apiBaseUrl`) reach the
 * API their tool_config is set up for unless a call names another, and a spec
 * may allow-list several. A rule read only the repository or the channel, so
 * `alwaysAllow IssueCreate(acme/app)` granted acme/app on every allow-listed
 * host, and no rule could name a host. Now the repository is matched with the
 * origin of the API the call goes to in front (`https://ghe.example.com/acme/app`):
 * the one it names, else the one its tool_config sends it to. An allow must
 * name the origin, except on that configured API, where the repository alone
 * still covers a call (so a spec with one host keeps its rules); a deny reads
 * the URL, the bare host and the repository on its own.
 *
 * Through an incoming webhook, ChatPost ignores `channel` and posts where the
 * webhook is bound; the rule now reads the variable naming the webhook
 * (`webhookUrlEnv`), as WebhookPost's reads `urlEnv`, and the channel such a
 * call carries is read by a deny or ask only.
 *
 * Everything runs through runChatLoop's real gate and the real tools, against
 * two loopback servers standing for two allow-listed hosts; a name resolves to
 * loopback through each package's own resolver seam. The outcome is read from
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
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { type PendingApprovalStore, createPendingApprovalStore } from "@crewhaus/session-store";
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
import {
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  __setPrivateHostsAllowedForTest as allowNotifyLoopback,
  chatPost,
  registerNotifyConfig,
  _setDnsLookup as setNotifyDns,
  webhookPost,
} from "@crewhaus/tool-notify";
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
      if (url.pathname.endsWith("chat.postMessage")) return Response.json({ ok: true, ts: "1.2" });
      if (url.pathname.startsWith("/hooks/")) return new Response("ok");
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
  setNotifyDns(loopback);
  allowCodehostLoopback(true);
  allowNotifyLoopback(true);
  process.env["API_HOSTS_TOKEN_A"] = "ghp_api_hosts_token_A_0123456789";
  process.env["API_HOSTS_TOKEN_B"] = "ghp_api_hosts_token_B_0123456789";
  // A bot token's shape, built from parts so no scanner reads it as one.
  process.env["API_HOSTS_BOT"] = ["xoxb", "api-hosts", "0123456789", "abcdef"].join("-");
  process.env["API_HOSTS_HOOK"] = `${originA}/hooks/a`;
  registerCodehostConfig({
    allowed_origins: [originA, originB],
    base_url: originA,
    token_env: "API_HOSTS_TOKEN_A",
    token_envs: { API_HOSTS_TOKEN_B: [originB] },
  });
  registerNotifyConfig({
    allowed_origins: [originA, originB],
    allowed_secret_envs: ["API_HOSTS_BOT", "API_HOSTS_HOOK"],
  });
});

afterAll(() => {
  setCodehostDns(undefined);
  setNotifyDns(undefined);
  allowCodehostLoopback(false);
  allowNotifyLoopback(false);
  _resetCodehostConfig();
  _resetNotifyConfig();
  _resetIdempotencyLedger();
  for (const name of [
    "API_HOSTS_TOKEN_A",
    "API_HOSTS_TOKEN_B",
    "API_HOSTS_BOT",
    "API_HOSTS_HOOK",
  ]) {
    delete process.env[name];
  }
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
    instructions: "file the issue and tell the room",
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
    // `http://*/acme/app` names the repository on any http host.
    const anyHost = rules(["alwaysAllow", "IssueCreate(http://*/acme/app)"]);
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

  test("a deny written on the configured host fires on a call that names no baseUrl", async () => {
    for (const glob of [`${originA}/**`, "https://api.example.test/**", "api.example.test/**"]) {
      const rs = rules(["alwaysDeny", `IssueCreate(${glob})`], ["alwaysAllow", "IssueCreate"]);
      for (const call_ of [issue, { ...issue, baseUrl: originA }]) {
        expect({ glob, call_, got: await call(issueCreate, call_, rs) }).toEqual({
          glob,
          call_,
          got: { decision: "deny", a: [], b: [] },
        });
      }
      // The other host is not this rule's business.
      expect({ glob, got: await call(issueCreate, issueOnB, rs) }).toEqual({
        glob,
        got: { decision: "allow", a: [], b: createdOnB },
      });
    }
  }, 60_000);

  test("an allow that names no host covers a call that names the configured API", async () => {
    const rs = rules(["alwaysAllow", "IssueCreate(acme/app)"]);
    for (const baseUrl of [originA, `${originA}/`]) {
      expect({ baseUrl, got: await call(issueCreate, { ...issue, baseUrl }, rs) }).toEqual({
        baseUrl,
        got: { decision: "allow", a: created, b: [] },
      });
    }
    // And one that names the configured host covers a call that names none.
    const onA = rules(["alwaysAllow", `IssueCreate(${originA}/acme/*)`]);
    expect(await call(issueCreate, issue, onA)).toEqual({ decision: "allow", a: created, b: [] });
  }, 30_000);

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
    // And a deny or ask on the configured host stops a read that names no baseUrl.
    for (const type of ["alwaysDeny", "alwaysAsk"] as const) {
      const onHost = rules([type, `IssueList(${originA}/**)`]);
      const plain = { owner: "acme", repo: "app" };
      expect({ type, got: await call(issueList, plain, onHost, "plan") }).toEqual({
        type,
        got: { decision: "deny", a: [], b: [] },
      });
    }
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

describe("a code-host rule on GitLab, whose owner is a group path", () => {
  beforeAll(() => {
    registerCodehostConfig({
      host: "gitlab",
      allowed_origins: [originA, originB],
      base_url: originA,
      token_env: "API_HOSTS_TOKEN_A",
      token_envs: { API_HOSTS_TOKEN_B: [originB] },
    });
  });
  afterAll(() => {
    registerCodehostConfig({
      allowed_origins: [originA, originB],
      base_url: originA,
      token_env: "API_HOSTS_TOKEN_A",
      token_envs: { API_HOSTS_TOKEN_B: [originB] },
    });
  });

  test("a rule for one repository on any host does not cover a subgroup's project", async () => {
    // `IssueCreate(**/acme/app)` would: `**` is any run of groups, so it also
    // names evil/acme/app. One origin segment, then the repository, does not.
    const rs = rules(["alwaysAllow", "IssueCreate(http://*/acme/app)"]);
    const issues = `/projects/${encodeURIComponent("acme/app")}/issues`;
    expect(await call(issueCreate, issue, rs)).toEqual({
      decision: "allow",
      a: [`POST ${issues}`],
      b: [],
    });
    expect(await call(issueCreate, issueOnB, rs)).toEqual({
      decision: "allow",
      a: [],
      b: [`POST /api/v3${issues}`],
    });
    for (const input of [
      { ...issue, owner: "evil/acme" },
      { ...issue, owner: "evil/acme", baseUrl: originA },
      { ...issueOnB, owner: "evil/acme" },
    ]) {
      expect({ input, got: await call(issueCreate, input, rs) }).toEqual({
        input,
        got: { decision: "ask", a: [], b: [] },
      });
    }
  }, 60_000);
});

describe("without base_url, a call's host picks the API as well as the dialect", () => {
  beforeAll(() => {
    // Set up for GitHub; gitlab.com is allow-listed too.
    registerCodehostConfig({
      allowed_origins: ["https://api.github.com", "https://gitlab.com"],
      token_env: "API_HOSTS_TOKEN_A",
    });
  });
  afterAll(() => {
    registerCodehostConfig({
      allowed_origins: [originA, originB],
      base_url: originA,
      token_env: "API_HOSTS_TOKEN_A",
      token_envs: { API_HOSTS_TOKEN_B: [originB] },
    });
  });

  test("a call with host gitlab goes to gitlab.com, which a rule reads as that host", async () => {
    const onGitlab = { ...issue, host: "gitlab" };
    // The repository alone names it on the configured API, github.com.
    const repoOnly = rules(["alwaysAllow", "IssueCreate(acme/app)"]);
    expect(await call(issueCreate, onGitlab, repoOnly)).toEqual({ decision: "ask", a: [], b: [] });
    for (const glob of ["https://gitlab.com/**", "gitlab.com/**"]) {
      const rs = rules(["alwaysDeny", `IssueCreate(${glob})`], ["alwaysAllow", "IssueCreate"]);
      expect({ glob, got: await call(issueCreate, onGitlab, rs) }).toEqual({
        glob,
        got: { decision: "deny", a: [], b: [] },
      });
    }
  }, 30_000);
});

describe("the gate reads the serving candidate's tool_config, the one the tool runs with", () => {
  // Registered at boot: base_url A. The serving candidate's block: base_url B.
  const candidateBlock = {
    allowed_origins: [originA, originB],
    base_url: baseB,
    token_env: "API_HOSTS_TOKEN_B",
  };
  /** One IssueCreate call under a model pool whose one candidate carries the block. */
  async function served(
    input: unknown,
    ruleSet: RuleSet,
    extra: { readonly sessionId?: string; readonly store?: PendingApprovalStore } = {},
  ): Promise<Outcome> {
    const runContext = createRunContext(
      extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {},
    );
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
      permissionMode: "default",
      permissionRules: ruleSet,
      tools: [issueCreate],
      justificationJudge: () => ({ allow: true, reason: "on task", judgeModel: "test" }),
      _adapter: adapterFor(issueCreate.name, input),
      modelPool: {
        candidates: [{ model: "pool-model", toolConfigs: { codehost: candidateBlock } }],
        policy: "static",
      },
      _poolAdapters: new Map([["pool-model", adapterFor(issueCreate.name, input)]]),
      _scoreboard: openScoreboard(mkdtempSync(join(state, "sb-"))),
      ...(extra.store !== undefined ? { approvals: { store: extra.store } } : {}),
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    }).catch(() => undefined);
    const first = events.find((e) => e.kind === "permission_decision");
    return {
      decision: first?.kind === "permission_decision" ? first.decision : undefined,
      a: A.got.slice(before.a),
      b: B.got.slice(before.b),
    };
  }

  test("a call that names no baseUrl is read on the candidate's base_url", async () => {
    const denyB = rules(
      ["alwaysDeny", "IssueCreate(ghe.example.test/**)"],
      ["alwaysAllow", "IssueCreate"],
    );
    expect(await served(issue, denyB)).toEqual({ decision: "deny", a: [], b: [] });
    // A deny on the boot registration's host is not where this call goes.
    const denyA = rules(
      ["alwaysDeny", "IssueCreate(api.example.test/**)"],
      ["alwaysAllow", "IssueCreate"],
    );
    expect(await served(issue, denyA)).toEqual({ decision: "allow", a: [], b: createdOnB });
    // The repository alone names it on the candidate's API.
    expect(await served(issue, rules(["alwaysAllow", "IssueCreate(acme/app)"]))).toEqual({
      decision: "allow",
      a: [],
      b: createdOnB,
    });
  }, 60_000);

  test("a granted approval replayed for a re-worded call is re-checked on that API too", async () => {
    const store = createPendingApprovalStore({ rootDir: join(state, "approvals") });
    const sessionId = "sess_0123456789abcdef";
    // Park the call (a destructive tool asks by default), then grant it.
    await served(issue, emptyRuleSet, { sessionId, store });
    const parked = (await store.list()).find((r) => r.toolName === "IssueCreate");
    if (parked === undefined) throw new Error("expected a parked approval");
    await store.resolve(parked.id, "grant", "tester");
    // The operator then denies the candidate's host. The model re-words the
    // call to name A, which asks; the replay would run the APPROVED input,
    // which names no baseUrl and so goes to B.
    const rs = rules(
      ["alwaysDeny", "IssueCreate(ghe.example.test/**)"],
      ["alwaysAsk", "IssueCreate(api.example.test/**)"],
    );
    const got = await served({ ...issue, baseUrl: originA }, rs, { sessionId, store });
    expect(got).toEqual({ decision: "ask", a: [], b: [] });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// chat and webhooks
// ---------------------------------------------------------------------------

const post = {
  platform: "slack",
  apiBaseUrl: `${originB}/api`,
  tokenEnv: "API_HOSTS_BOT",
  channel: "C123",
  text: "deploy finished",
  justification: "tell the room",
};
const posted = ["POST /api/chat.postMessage"];

describe("a Chat rule reads the API a call names, and a webhook post the variable naming it", () => {
  test("an API-mode post is matched with its API's origin", async () => {
    const bare = rules(["alwaysAllow", "ChatPost(C123)"]);
    expect(await call(chatPost, post, bare)).toEqual({ decision: "ask", a: [], b: [] });
    const named = rules(["alwaysAllow", `ChatPost(${originB}/C123)`]);
    expect(await call(chatPost, post, named)).toEqual({ decision: "allow", a: [], b: posted });
    const elsewhere = rules(["alwaysAllow", `ChatPost(${originA}/C123)`]);
    expect(await call(chatPost, post, elsewhere)).toEqual({ decision: "ask", a: [], b: [] });
    const deny = rules(
      ["alwaysDeny", "ChatPost(https://ghe.example.test/**)"],
      ["alwaysAllow", "ChatPost"],
    );
    expect(await call(chatPost, post, deny)).toEqual({ decision: "deny", a: [], b: [] });
  }, 30_000);

  test("a webhook post is read by its variable; the channel it ignores is read by a deny only", async () => {
    // The webhook in API_HOSTS_HOOK is bound to a channel of its own; the call's
    // `channel` is not where the post goes.
    const hook = {
      platform: "slack",
      webhookUrlEnv: "API_HOSTS_HOOK",
      channel: "C123",
      text: "deploy finished",
      justification: "tell the room",
    };
    const { channel: _channel, ...plain } = hook;
    const byVariable = rules(["alwaysAllow", "ChatPost(API_HOSTS_HOOK)"]);
    for (const input of [hook, plain]) {
      _resetIdempotencyLedger();
      expect({ input, got: await call(chatPost, input, byVariable) }).toEqual({
        input,
        got: { decision: "allow", a: ["POST /hooks/a"], b: [] },
      });
    }
    // An allow on the channel does not cover it, alone or beside one on another hook.
    for (const set of [
      [["alwaysAllow", "ChatPost(C123)"]],
      [
        ["alwaysAllow", "ChatPost(C123)"],
        ["alwaysAllow", "ChatPost(OTHER_HOOK)"],
      ],
    ] as Array<Array<[PermissionRule["type"], string]>>) {
      expect({ set, got: await call(chatPost, hook, rules(...set)) }).toEqual({
        set,
        got: { decision: "ask", a: [], b: [] },
      });
    }
    // A deny on the variable, or on the channel, still fires.
    for (const glob of ["API_HOSTS_HOOK", "C123"]) {
      const deny = rules(["alwaysDeny", `ChatPost(${glob})`], ["alwaysAllow", "ChatPost"]);
      expect({ glob, got: await call(chatPost, hook, deny) }).toEqual({
        glob,
        got: { decision: "deny", a: [], b: [] },
      });
    }
    // The webhook's URL is a credential no rule reads, its host included:
    // a deny on an API is an API-mode rule (README).
    _resetIdempotencyLedger();
    const onHost = rules(["alwaysDeny", `ChatPost(${originA}/**)`], ["alwaysAllow", "ChatPost"]);
    expect(await call(chatPost, plain, onHost)).toEqual({
      decision: "allow",
      a: ["POST /hooks/a"],
      b: [],
    });
  }, 30_000);

  test("WebhookPost reads the variable a call names its URL through", async () => {
    const hook = {
      urlEnv: "API_HOSTS_HOOK",
      payload: { event: "deploy", link: "http://status.example.test/1" },
      justification: "tell the room",
    };
    expect(
      await call(webhookPost, hook, rules(["alwaysAllow", "WebhookPost(API_HOSTS_HOOK)"])),
    ).toEqual({ decision: "allow", a: ["POST /hooks/a"], b: [] });
    const deny = rules(
      ["alwaysDeny", "WebhookPost(API_HOSTS_HOOK)"],
      ["alwaysAllow", "WebhookPost"],
    );
    expect(await call(webhookPost, hook, deny)).toEqual({ decision: "deny", a: [], b: [] });
    // A link in the payload is not where the post goes.
    const link = rules(["alwaysDeny", "WebhookPost(http://**)"], ["alwaysAllow", "WebhookPost"]);
    expect(await call(webhookPost, hook, link)).toEqual({
      decision: "allow",
      a: ["POST /hooks/a"],
      b: [],
    });
  }, 30_000);
});
