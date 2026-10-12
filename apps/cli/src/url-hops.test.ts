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
 * Everything runs through runChatLoop's real gate and the real tools, against
 * loopback servers, and the outcome is read from what each server received.
 * tool-http lifts its loopback refusal with its own test seam. Fetch and
 * WebFetch refuse loopback outright, so for them only the dialler is
 * replaced: a name resolves to a documentation address and connects to a
 * loopback port, and the redirect handling being tested is the tool's own.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
