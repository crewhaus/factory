/**
 * 0.7.1 — URL rules and the requests a call makes after its first one.
 *
 * A URL rule is read on the URL a call names. A tool that then follows a
 * redirect, or fetches a next page a server names, checks each later request
 * against its own allow-list in `tool_config` and the private-address guard,
 * not against permission rules: a tool has no way to ask the runtime's gate
 * about a URL in the middle of a call. That is a known limitation of 0.7.1,
 * planned for 0.8 with the extracted tool guard. The first two describes PIN
 * it, so the fix shows up here as a deliberate change, and hold the boundary
 * that does apply at every hop: an origin off the tool's allow-list.
 *
 * The rest are fixes. DependencyAudit (whose mirror is checked against
 * `tool_config.fetch`) and the chain reads (whose nodes the spec's `chains`
 * block names) sent their requests with the platform's `fetch`, which follows
 * a redirect anywhere. Both now refuse a redirect and say where it pointed. And a chain read that fails on
 * every node is judged on what each node said, not on the words of whichever
 * node failed last: that is what decides whether EvmSimulateBundle and
 * GasMarketRead fall back and whether ContractInspect reads a revert.
 *
 * Everything runs through runChatLoop's real gate and the real tools, against
 * loopback servers, and the outcome is read from what each server received.
 * tool-http lifts its loopback refusal with its own test seam. Fetch, WebFetch
 * and DependencyAudit refuse loopback outright, so for them only the dialler is
 * replaced: a name resolves to a documentation address and connects to a
 * loopback port, and the redirect handling being tested is the tool's own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  bindChainCallChains,
  contractInspect,
  evmSimulateBundle,
  gasMarketRead,
  setChainRpcResolver,
} from "@crewhaus/tool-chaincall";
import {
  _resetFetchConfig,
  _setRawFetch as _setFetchDial,
  _setDnsLookup as _setFetchDnsLookup,
  fetch as fetchTool,
  registerFetchConfig,
} from "@crewhaus/tool-fetch";
import {
  __setPrivateHostsAllowedForTest,
  _resetHttpConfig,
  feedParse,
  headRequest,
  httpPaginate,
  httpRequest,
  registerHttpConfig,
} from "@crewhaus/tool-http";
import { _setFetch as _setOsvFetch, dependencyAudit } from "@crewhaus/tool-supplychain";
import {
  _resetWebFetchConfig,
  _setRawFetch as _setWebDial,
  _setDnsLookup as _setWebDnsLookup,
  registerWebFetchConfig,
  webFetch,
} from "@crewhaus/tool-web";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/** A loopback server that records `METHOD /path` for every request it is sent. */
function server(handle: Handler) {
  const got: string[] = [];
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      got.push(`${req.method} ${url.pathname}`);
      return handle(req, url);
    },
  });
  const port = s.port ?? 0;
  return { origin: `http://127.0.0.1:${port}`, port, got, stop: () => s.stop(true) };
}

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

/** A model that makes one call, then stops; it keeps what the tool handed back. */
function adapterFor(name: string, input: unknown, seen: { result?: string; isError?: boolean }) {
  let turn = 0;
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      const first = turn++ === 0;
      if (!first) {
        for (const m of req.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const block of m.content as Array<Record<string, unknown>>) {
            if (block["type"] !== "tool_result") continue;
            const content = block["content"];
            seen.result = typeof content === "string" ? content : JSON.stringify(content);
            seen.isError = block["is_error"] === true;
          }
        }
      }
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
  return adapter;
}

type Outcome = {
  /** The gate's decision on the call: the first permission_decision. */
  readonly decision: string | undefined;
  /** What the tool handed back, when it ran. */
  readonly result: string;
  readonly isError: boolean | undefined;
};

let state: string;
beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), "url-hops-state-"));
});
afterAll(() => {
  rmSync(state, { recursive: true, force: true });
});

/** One call through runChatLoop's real gate and the real tool. */
async function call(
  tool: RegisteredTool,
  input: unknown,
  ruleSet: RuleSet,
  opts: { readonly mode?: PermissionMode; readonly judgeAllows?: boolean } = {},
): Promise<Outcome> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    events.push(e);
  });
  const seen: { result?: string; isError?: boolean } = {};
  await runChatLoop({
    model: "test-model",
    instructions: "read the inventory service and its pages",
    runContext,
    sessionRootDir: mkdtempSync(join(state, "sess-")),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: opts.mode ?? "default",
    permissionRules: ruleSet,
    tools: [tool],
    ...(opts.judgeAllows === true
      ? {
          justificationJudge: () => ({ allow: true, reason: "on task", judgeModel: "test" }),
        }
      : {}),
    _adapter: adapterFor(tool.name, input, seen),
  });
  const first = events.find((e) => e.kind === "permission_decision");
  return {
    decision: first?.kind === "permission_decision" ? first.decision : undefined,
    result: seen.result ?? "(the tool did not run)",
    isError: seen.isError,
  };
}

/**
 * A dialler for a tool that refuses loopback: connect to the loopback port
 * its host name stands for, with the request exactly as the tool built it —
 * method, headers, body, and its own redirect mode, so a redirect is still
 * the tool's to follow or refuse.
 */
function dialByName(ports: Readonly<Record<string, number>>) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const port = ports[url.hostname];
    if (port === undefined) throw new Error(`the test dialler knows no host ${url.hostname}`);
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = String(port);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    return fetch(url.toString(), {
      method: req.method,
      headers: req.headers,
      redirect: req.redirect,
      ...(hasBody ? { body: await req.text() } : {}),
    });
  };
}

/** A documentation address (TEST-NET-3): public to the guard, never dialled. */
const resolvePublic = async () => ({ address: "203.0.113.7", family: 4 });

// ---------------------------------------------------------------------------
// PINNED — tool-http: rules read the call's URL; later hops meet the allow-list
// ---------------------------------------------------------------------------

describe("tool-http: a URL rule is read on the call's URL, not on later hops (known limitation, pinned)", () => {
  // A is the origin calls name; B is on the tool's allow-list and the origin a
  // rule denies; C is on no list at all.
  const b = server((_req, url) =>
    url.pathname === "/feed.xml"
      ? new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>from-B</title><item><title>b1</title></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } },
        )
      : Response.json(url.pathname === "/page2" ? [{ secret: "from-B" }] : { admin: true }),
  );
  const c = server(() => Response.json([{ secret: "from-C" }]));
  const a = server((_req, url) => {
    const page = (next: string) =>
      Response.json([{ a: 1 }], { headers: { link: `<${next}/page2>; rel="next"` } });
    const moved = (to: string) => new Response(null, { status: 307, headers: { location: to } });
    switch (url.pathname) {
      case "/page1":
        return page(b.origin);
      case "/page1-off":
        return page(c.origin);
      case "/to-b":
        return moved(`${b.origin}/admin`);
      case "/feed-to-b":
        return moved(`${b.origin}/feed.xml`);
      default:
        return moved(`${c.origin}/admin`);
    }
  });

  beforeAll(() => {
    registerHttpConfig({ allowed_origins: [a.origin, b.origin] });
    __setPrivateHostsAllowedForTest(true);
  });
  afterAll(() => {
    _resetHttpConfig();
    __setPrivateHostsAllowedForTest(false);
    for (const s of [a, b, c]) s.stop();
  });
  beforeEach(() => {
    for (const s of [a, b, c]) s.got.length = 0;
  });

  const paginate = (from: string) => ({
    url: `${a.origin}${from}`,
    style: "link",
    maxPages: 3,
    timeoutMs: 30_000,
  });

  test("control: a call that names B is denied, and B is not reached", async () => {
    const deny = (tool: string) =>
      rules(["alwaysDeny", `${tool}(${b.origin}/**)`], ["alwaysAllow", tool]);
    const direct = { url: `${b.origin}/page2`, style: "link", maxPages: 3, timeoutMs: 30_000 };
    expect((await call(httpPaginate, direct, deny("HttpPaginate"))).decision).toBe("deny");
    expect(
      (await call(headRequest, { url: `${b.origin}/admin` }, deny("HeadRequest"))).decision,
    ).toBe("deny");
    expect(b.got).toEqual([]);
  }, 60_000);

  test("PINNED: HttpPaginate's next page reaches the origin a deny or an ask names, in default and plan mode", async () => {
    const cases: Array<[string, RuleSet, PermissionMode]> = [
      [
        "deny",
        rules(["alwaysDeny", `HttpPaginate(${b.origin}/**)`], ["alwaysAllow", "HttpPaginate"]),
        "default",
      ],
      [
        "ask",
        rules(["alwaysAsk", `HttpPaginate(${b.origin}/**)`], ["alwaysAllow", "HttpPaginate"]),
        "default",
      ],
      ["deny, plan mode", rules(["alwaysDeny", `HttpPaginate(${b.origin}/**)`]), "plan"],
    ];
    for (const [label, ruleSet, mode] of cases) {
      b.got.length = 0;
      const out = await call(httpPaginate, paginate("/page1"), ruleSet, { mode });
      expect({
        label,
        decision: out.decision,
        bGot: b.got,
        carriesB: out.result.includes("from-B"),
      }).toEqual({
        label,
        decision: "allow",
        bGot: ["GET /page2"],
        carriesB: true,
      });
    }
  }, 60_000);

  test("PINNED: a redirect hop reaches the origin a deny names (HeadRequest, FeedParse)", async () => {
    const head = await call(
      headRequest,
      { url: `${a.origin}/to-b` },
      rules(["alwaysDeny", `HeadRequest(${b.origin}/**)`], ["alwaysAllow", "HeadRequest"]),
    );
    expect({ decision: head.decision, bGot: b.got }).toEqual({
      decision: "allow",
      bGot: ["HEAD /admin"],
    });
    b.got.length = 0;
    const feed = await call(
      feedParse,
      { url: `${a.origin}/feed-to-b` },
      rules(["alwaysDeny", `FeedParse(${b.origin}/**)`], ["alwaysAllow", "FeedParse"]),
    );
    expect({
      decision: feed.decision,
      bGot: b.got,
      carriesB: feed.result.includes("from-B"),
    }).toEqual({
      decision: "allow",
      bGot: ["GET /feed.xml"],
      carriesB: true,
    });
  }, 60_000);

  test("PINNED: a justification judge that allows is not a URL check (HttpRequest)", async () => {
    const out = await call(
      httpRequest,
      { url: `${a.origin}/to-b`, method: "GET", justification: "read the inventory service pages" },
      rules(["alwaysDeny", `HttpRequest(${b.origin}/**)`], ["alwaysAllow", "HttpRequest"]),
      { judgeAllows: true },
    );
    expect({
      decision: out.decision,
      bGot: b.got,
      carriesB: out.result.includes('\\"admin\\":true'),
    }).toEqual({
      decision: "allow",
      bGot: ["GET /admin"],
      carriesB: true,
    });
  }, 60_000);

  test("HOLDS: an origin off the tool's allow-list is never reached, at any hop", async () => {
    const allow = (tool: string) => rules(["alwaysAllow", tool]);
    const next = await call(httpPaginate, paginate("/page1-off"), allow("HttpPaginate"));
    const hop = await call(headRequest, { url: `${a.origin}/to-c` }, allow("HeadRequest"));
    expect({ next: next.result, hop: hop.result, cGot: c.got }).toEqual({
      next: `denied: origin "${c.origin}" is not in allowed_origins`,
      hop: expect.stringContaining(`denied: origin "${c.origin}" is not in allowed_origins`),
      cGot: [],
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// PINNED — Fetch and WebFetch follow a redirect by their own allow-lists
// ---------------------------------------------------------------------------

describe("Fetch and WebFetch: a redirect hop is bounded by the tool's allow-list, not by URL rules (pinned)", () => {
  const b = server(() => Response.json({ admin: true }));
  const c = server(() => Response.json({ admin: "C" }));
  const a = server(
    (_req, url) =>
      new Response(null, {
        status: 307,
        headers: {
          location: url.pathname === "/to-b" ? "http://b.test/admin" : "http://c.test/admin",
        },
      }),
  );
  const dial = dialByName({ "a.test": a.port, "b.test": b.port, "c.test": c.port });

  beforeAll(() => {
    _setFetchDnsLookup(resolvePublic);
    _setFetchDial(dial);
    _setWebDnsLookup(resolvePublic);
    _setWebDial(dial);
  });
  afterAll(() => {
    _setFetchDnsLookup(undefined);
    _setFetchDial(undefined);
    _resetFetchConfig();
    _setWebDnsLookup(undefined);
    _setWebDial(undefined);
    _resetWebFetchConfig();
    for (const s of [a, b, c]) s.stop();
  });
  beforeEach(() => {
    for (const s of [a, b, c]) s.got.length = 0;
  });

  test("Fetch: a deny on b.test stops a call naming it, not a redirect to it; c.test, off the list, is refused", async () => {
    registerFetchConfig({ allowed_origins: ["http://a.test", "http://b.test"] });
    const rs = rules(["alwaysDeny", "Fetch(http://b.test/**)"], ["alwaysAllow", "Fetch"]);
    expect((await call(fetchTool, { url: "http://b.test/admin" }, rs)).decision).toBe("deny");
    expect(b.got).toEqual([]);
    const pinned = await call(fetchTool, { url: "http://a.test/to-b" }, rs);
    expect({ decision: pinned.decision, bGot: b.got }).toEqual({
      decision: "allow",
      bGot: ["GET /admin"],
    });
    const off = await call(fetchTool, { url: "http://a.test/to-c" }, rs);
    expect({ result: off.result, cGot: c.got }).toEqual({
      result: expect.stringContaining('origin "http://c.test" is not in allowed_origins'),
      cGot: [],
    });
  }, 60_000);

  test("WebFetch: with no allowed_domains a redirect reaches a denied host; allowed_domains stops it", async () => {
    const rs = rules(["alwaysDeny", "WebFetch(http://b.test/**)"], ["alwaysAllow", "WebFetch"]);
    _resetWebFetchConfig();
    const pinned = await call(webFetch, { url: "http://a.test/to-b" }, rs);
    expect({ decision: pinned.decision, bGot: b.got }).toEqual({
      decision: "allow",
      bGot: ["GET /admin"],
    });
    // The workaround until hops meet the rules: an allow-list that leaves the
    // denied host off.
    b.got.length = 0;
    registerWebFetchConfig({ allowed_domains: ["a.test"] });
    const listed = await call(webFetch, { url: "http://a.test/to-b" }, rs);
    expect({ result: listed.result, bGot: b.got }).toEqual({
      result: expect.stringContaining('host "b.test" is not in allowed_domains'),
      bGot: [],
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FIXED — DependencyAudit never follows a redirect
// ---------------------------------------------------------------------------

describe("DependencyAudit refuses a redirect from its OSV mirror", () => {
  const osvRecord = {
    id: "GHSA-pad",
    summary: "padding",
    affected: [
      {
        package: { ecosystem: "npm", name: "left-pad" },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.3.1" }] }],
      },
    ],
  };
  // B is on no list: not the public OSV API, not in tool_config.fetch.
  const b = server(() => Response.json({ results: [{ vulns: [] }] }));
  const mirror: { route: (path: string) => Response } = {
    route: () => new Response(null, { status: 500 }),
  };
  const m = server((_req, url) => mirror.route(url.pathname));
  const answer = (path: string): Response =>
    path === "/v1/querybatch"
      ? Response.json({ results: [{ vulns: [{ id: "GHSA-pad" }] }] })
      : Response.json(osvRecord);
  const moved = (path: string): Response =>
    new Response(null, { status: 307, headers: { location: `${b.origin}${path}` } });

  let ws: string;
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    ws = realpathSync(mkdtempSync(join(tmpdir(), "url-hops-osv-")));
    writeFileSync(
      join(ws, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 1,
        packages: { "left-pad": ["left-pad@1.3.0", "", {}, ""] },
      }),
    );
    process.chdir(ws);
    registerFetchConfig({ allowed_origins: ["http://mirror.test"] });
    _setFetchDnsLookup(resolvePublic);
    // The tool's own request, to the mirror's loopback port, with its init
    // untouched: whether a redirect is followed is up to that init.
    _setOsvFetch((url, init) => fetch(url.replace("http://mirror.test", m.origin), init));
    for (const s of [b, m]) s.got.length = 0;
  });
  afterEach(() => {
    process.chdir(cwd);
    rmSync(ws, { recursive: true, force: true });
    _setOsvFetch(undefined);
    _setFetchDnsLookup(undefined);
    _resetFetchConfig();
  });
  afterAll(() => {
    for (const s of [b, m]) s.stop();
  });

  const audit = () =>
    call(
      dependencyAudit,
      { endpoint: "http://mirror.test" },
      rules(["alwaysAllow", "DependencyAudit"]),
    );

  test("control: a mirror that answers is audited", async () => {
    mirror.route = answer;
    const out = await audit();
    expect({
      decision: out.decision,
      isError: out.isError,
      matched: out.result.includes('"matchCount":1'),
    }).toEqual({
      decision: "allow",
      isError: false,
      matched: true,
    });
  }, 60_000);

  test("a 307 on the batch query is refused, names where it pointed, and sends nothing there", async () => {
    mirror.route = moved;
    const out = await audit();
    expect({
      decision: out.decision,
      isError: out.isError,
      result: out.result,
      bGot: b.got,
    }).toEqual({
      decision: "allow",
      isError: true,
      result: `http://mirror.test/v1/querybatch answered HTTP 307 with a redirect to ${b.origin}; DependencyAudit does not follow redirects, so nothing was sent there and nothing was audited. Set endpoint to the address that answers directly.`,
      bGot: [],
    });
  }, 60_000);

  test("a 307 on an advisory record is refused the same way, not reported as unserved", async () => {
    mirror.route = (path) => (path === "/v1/querybatch" ? answer(path) : moved(path));
    const out = await audit();
    expect({ isError: out.isError, result: out.result, bGot: b.got }).toEqual({
      isError: true,
      result: `http://mirror.test/v1/vulns/GHSA-pad answered HTTP 307 with a redirect to ${b.origin}; DependencyAudit does not follow redirects, so nothing was sent there and nothing was audited. Set endpoint to the address that answers directly.`,
      bGot: [],
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FIXED — a chain read never follows a redirect off the chains block
// ---------------------------------------------------------------------------

describe("a chain read refuses a redirect to a node the chains block does not name", () => {
  // B answers like a node, so a followed redirect would come back as a
  // plausible answer rather than an error.
  const b = server(async (req) => {
    const body = (await req.json()) as { id: number; method: string };
    const result =
      body.method === "eth_getCode"
        ? "0x6001"
        : body.method === "eth_blockNumber"
          ? "0x10"
          : `0x${"0".repeat(64)}`;
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  // A forwarded read arrives at B as /forwarded; one B is asked by name, as /rpc.
  const a = server(
    () => new Response(null, { status: 307, headers: { location: `${b.origin}/forwarded` } }),
  );
  const bind = (rpcUrls: string[], rpcPolicy: "single" | "fallback" | "quorum") =>
    bindChainCallChains({
      chains: [
        { chainId: "1", rpcUrls, rpcPolicy, finality: { kind: "finalized" }, reorgTolerant: false },
      ],
    });
  const inspect = () =>
    call(
      contractInspect,
      {
        chainId: "1",
        address: "0x000000000000000000000000000000000000dEaD",
        probeInterfaces: false,
        timeoutMs: 30_000,
      },
      rules(["alwaysAllow", "ContractInspect"]),
    );

  beforeEach(() => {
    for (const s of [a, b]) s.got.length = 0;
  });
  afterAll(() => {
    setChainRpcResolver(undefined);
    for (const s of [a, b]) s.stop();
  });

  test("control: a node the block names answers", async () => {
    bind([`${b.origin}/rpc`], "single");
    const out = await inspect();
    expect({ isError: out.isError, isContract: out.result.includes('"isContract":true') }).toEqual({
      isError: false,
      isContract: true,
    });
  }, 60_000);

  test("a 307 is refused, names both ends and the reason, and the other node gets nothing", async () => {
    bind([`${a.origin}/rpc`], "single");
    const out = await inspect();
    expect({ isError: out.isError, result: out.result, aGot: a.got, bGot: b.got }).toEqual({
      isError: true,
      result: `[1] eth_getCode: all 1 RPC URL(s) failed; the last: ${a.origin} answered HTTP 307 with a redirect to ${b.origin}; a JSON-RPC read is not followed to a node the chains block does not name, so nothing was sent there. Set rpcUrls to the address that answers directly.`,
      aGot: ["POST /rpc"],
      bGot: [],
    });
  }, 60_000);

  test("under quorum, nodes that all redirect fail the read with the reason, and B gets nothing", async () => {
    bind([`${a.origin}/rpc`, `${a.origin}/rpc2`], "quorum");
    const out = await inspect();
    expect({ isError: out.isError, result: out.result, bGot: b.got }).toEqual({
      isError: true,
      result: expect.stringMatching(
        /^\[1\] eth_getCode: quorum failed: every RPC URL rejected; the last: http:\/\/127\.0\.0\.1:\d+ answered HTTP 307 with a redirect to /,
      ),
      bGot: [],
    });
  }, 60_000);

  test("under fallback, a node that redirects counts as failed and the next one named answers", async () => {
    bind([`${a.origin}/rpc`, `${b.origin}/rpc`], "fallback");
    const out = await inspect();
    expect({ isError: out.isError, isContract: out.result.includes('"isContract":true') }).toEqual({
      isError: false,
      isContract: true,
    });
    // Every read went to A first, was refused there, and was asked of B by
    // name: B saw only those, never one forwarded by A's redirect.
    expect({ aAsked: a.got.length > 0, bGot: [...new Set(b.got)] }).toEqual({
      aAsked: true,
      bGot: ["POST /rpc"],
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// FIXED — a chain read that fails on every node is judged on each node's answer
// ---------------------------------------------------------------------------

describe("a chain read that fails on every node is judged on what each node said, not on the last one's words", () => {
  // The adapter's error ends with the reason of the node that failed last,
  // and tool-chaincall used to read those words: whether EvmSimulateBundle
  // fell back, whether GasMarketRead answered without fee history, and
  // whether a ContractInspect probe had reverted then rested on which node
  // failed last, and on nothing at all in 0.7.0 (whose words had no reason).
  const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
  type Rpc = { readonly id: number; readonly method: string; readonly params: unknown[] };
  /** A node that answers every read, except where `refuse` names a JSON-RPC error. */
  const node = (refuse: (rpc: Rpc) => { code: number; message: string } | undefined) =>
    server(async (req) => {
      const rpc = (await req.json()) as Rpc;
      const error = refuse(rpc);
      if (error !== undefined) return Response.json({ jsonrpc: "2.0", id: rpc.id, error });
      const result =
        rpc.method === "eth_getBlockByNumber"
          ? {
              number: "0x10",
              baseFeePerGas: "0x3b9aca00",
              gasUsed: "0x5208",
              gasLimit: "0x1c9c380",
              timestamp: "0x1",
              hash: `0x${"1".repeat(64)}`,
            }
          : rpc.method === "eth_getCode"
            ? "0x6001"
            : rpc.method === "eth_getStorageAt"
              ? `0x${"0".repeat(64)}`
              : rpc.method === "eth_gasPrice"
                ? "0x3b9aca00"
                : rpc.method === "eth_call"
                  ? "0x"
                  : "0x10";
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    });
  const lacking = node((rpc) =>
    rpc.method === "eth_simulateV1" || rpc.method === "eth_feeHistory"
      ? { code: -32601, message: `the method ${rpc.method} does not exist/is not available` }
      : undefined,
  );
  const rejecting = node((rpc) =>
    rpc.method === "eth_simulateV1"
      ? { code: -32602, message: "invalid params: bundle rejected" }
      : undefined,
  );
  /** Every probe reverts; Multicall3 is not there, so the probes go one at a time. */
  const reverting = node((rpc) => {
    if (rpc.method !== "eth_call") return undefined;
    const to = String((rpc.params[0] as { to?: string } | undefined)?.to).toLowerCase();
    return to === MULTICALL3
      ? { code: -32000, message: "header not found" }
      : { code: 3, message: "execution reverted" };
  });
  const down = server(() => new Response("upstream down", { status: 503 }));
  const at = (s: { origin: string }) => `${s.origin}/rpc`;
  const bind = (rpcUrls: string[], rpcPolicy: "single" | "fallback" | "quorum") =>
    bindChainCallChains({
      chains: [
        { chainId: "1", rpcUrls, rpcPolicy, finality: { kind: "finalized" }, reorgTolerant: false },
      ],
    });
  const simulate = () =>
    call(
      evmSimulateBundle,
      {
        chainId: "1",
        calls: [
          {
            from: "0x00000000000000000000000000000000000000aa",
            to: "0x00000000000000000000000000000000000000bb",
            data: "0x",
          },
        ],
        timeoutMs: 30_000,
      },
      rules(["alwaysAllow", "EvmSimulateBundle"]),
    );
  const REFUSED =
    "EvmSimulateBundle: a node refused this bundle — invalid params: bundle rejected (code -32602). That node implements eth_simulateV1, so this is an answer about the bundle and not a reason to fall back to eth_call.";
  const NOT_EVERY =
    "The eth_call fallback is used only when every node says it lacks eth_simulateV1";

  afterAll(() => {
    setChainRpcResolver(undefined);
    for (const s of [lacking, rejecting, reverting, down]) s.stop();
  });

  test("GasMarketRead answers without fee history when the node lacks eth_feeHistory, and says so", async () => {
    bind([at(lacking)], "single");
    const out = await call(
      gasMarketRead,
      { chainId: "1" },
      rules(["alwaysAllow", "GasMarketRead"]),
    );
    expect({
      isError: out.isError,
      feeHistory: out.result.includes('"feeHistory":{"available":false}'),
      caveat: out.result.includes("this node does not implement eth_feeHistory"),
    }).toEqual({ isError: false, feeHistory: true, caveat: true });
  }, 60_000);

  test("EvmSimulateBundle falls back to eth_call when every node lacks eth_simulateV1", async () => {
    const modes: Record<string, unknown> = {};
    for (const [label, urls] of [
      ["one node", [at(lacking)]],
      ["two nodes", [at(lacking), `${lacking.origin}/rpc2`]],
    ] as const) {
      bind([...urls], urls.length === 1 ? "single" : "fallback");
      const out = await simulate();
      modes[label] = {
        isError: out.isError,
        fallback: out.result.includes('"mode":"eth_call-fallback"'),
      };
    }
    expect(modes).toEqual({
      "one node": { isError: false, fallback: true },
      "two nodes": { isError: false, fallback: true },
    });
  }, 60_000);

  test("a node that rejected the bundle keeps the fallback off, whichever node failed last", async () => {
    const out: Record<string, unknown> = {};
    for (const [label, urls] of [
      ["rejects, then lacks", [at(rejecting), at(lacking)]],
      ["lacks, then rejects", [at(lacking), at(rejecting)]],
    ] as const) {
      bind([...urls], "fallback");
      const one = await simulate();
      out[label] = { isError: one.isError, result: one.result };
    }
    expect(out).toEqual({
      "rejects, then lacks": { isError: true, result: REFUSED },
      "lacks, then rejects": { isError: true, result: REFUSED },
    });
  }, 60_000);

  test("a node that could not be reached, or a voter never heard, keeps the fallback off too", async () => {
    const out: Record<string, unknown> = {};
    for (const [label, urls, policy] of [
      ["lacks, then down", [at(lacking), at(down)], "fallback"],
      ["two quorum voters lacking it", [at(lacking), `${lacking.origin}/rpc2`], "quorum"],
    ] as const) {
      bind([...urls], policy);
      const one = await simulate();
      out[label] = {
        isError: one.isError,
        opens: one.result.startsWith(
          "EvmSimulateBundle: no node simulated this bundle — [1] eth_simulateV1: ",
        ),
        says: one.result.includes(NOT_EVERY),
      };
    }
    expect(out).toEqual({
      "lacks, then down": { isError: true, opens: true, says: true },
      "two quorum voters lacking it": { isError: true, opens: true, says: true },
    });
  }, 60_000);

  test("ContractInspect reads a revert from the node that answered, in either order of nodes", async () => {
    const out: Record<string, unknown> = {};
    for (const [label, urls, policy] of [
      ["one node", [at(reverting)], "single"],
      ["reverts, then down", [at(reverting), at(down)], "fallback"],
      ["down, then reverts", [at(down), at(reverting)], "fallback"],
    ] as const) {
      bind([...urls], policy);
      const one = await call(
        contractInspect,
        { chainId: "1", address: "0x000000000000000000000000000000000000dEaD", timeoutMs: 30_000 },
        rules(["alwaysAllow", "ContractInspect"]),
      );
      out[label] = {
        isError: one.isError,
        unreadable: one.result.includes("could not be answered by the node at all"),
      };
    }
    expect(out).toEqual({
      "one node": { isError: false, unreadable: false },
      "reverts, then down": { isError: false, unreadable: false },
      "down, then reverts": { isError: false, unreadable: false },
    });
  }, 60_000);
});
