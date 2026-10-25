import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FetchPermissionError, _setDnsLookup, _setRawFetch } from "@crewhaus/tool-fetch";
import {
  HEAD_CACHE_ENTRIES,
  type HeadDecision,
  createHeadResolver,
  hopPolicy,
  sourceHostPolicy,
} from "./head";

const SOURCES = { allow: [], deny: [], bibliographic: false, resolve: "head" } as const;

describe("sourceHostPolicy", () => {
  test("private hosts are refused whatever the lists say", () => {
    const allowAll = sourceHostPolicy({ ...SOURCES, allow: ["*"] });
    expect(allowAll("docs.example.com")).toBe(true);
    expect(allowAll("localhost")).toBe(false);
    expect(allowAll("10.1.2.3")).toBe(false);
    expect(allowAll("[::1]")).toBe(false);
  });

  test("deny wins over allow; an allow list admits only its hosts", () => {
    const policy = sourceHostPolicy({
      ...SOURCES,
      allow: ["*.gov", "arxiv.org"],
      deny: ["evil.gov"],
    });
    expect(policy("data.gov")).toBe(true);
    expect(policy("www.data.gov")).toBe(true);
    expect(policy("gov")).toBe(false); // `*.gov` needs a label before .gov
    expect(policy("arxiv.org")).toBe(true);
    expect(policy("evil.gov")).toBe(false);
    expect(policy("example.com")).toBe(false);
  });
});

describe("hopPolicy", () => {
  test("the cited URL meets the whole policy; a redirect hop meets the private rule and deny, not allow", () => {
    const sources = { ...SOURCES, allow: ["doi.org"], deny: ["evil.example"] };
    const hops = hopPolicy(sources);
    expect(hops("doi.org")).toBe(true);
    // The publisher a DOI redirects to need not be on the allow list...
    expect(hops("www.nature.com")).toBe(true);
    // ...but a denied or private host is refused at any hop.
    expect(hops("evil.example")).toBe(false);
    expect(hops("127.0.0.1")).toBe(false);
    // A fresh request starts over: its first host meets allow again.
    expect(hopPolicy(sources)("www.nature.com")).toBe(false);
  });
});

describe("createHeadResolver (injected request)", () => {
  test("an answer is asked once per (session, URL)", async () => {
    const asked: string[] = [];
    const resolve = createHeadResolver(SOURCES, async (url) => {
      asked.push(url);
      return 200;
    });
    expect(await resolve("https://a.example/x", { sessionId: "s1" })).toBe(200);
    expect(await resolve("https://a.example/x", { sessionId: "s1" })).toBe(200);
    expect(await resolve("https://a.example/x", { sessionId: "s2" })).toBe(200);
    expect(asked).toEqual(["https://a.example/x", "https://a.example/x"]);
  });

  test("a timeout, a network failure or an unresolvable name is no answer NOW, and asked again next time", async () => {
    for (const failure of [
      new Error("the HEAD request timed out after 10000ms"),
      new Error("ECONNRESET"),
      new FetchPermissionError('SSRF: cannot resolve "a.example": EAI_AGAIN'),
    ]) {
      let calls = 0;
      const resolve = createHeadResolver(SOURCES, async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return 200;
      });
      expect(await resolve("https://a.example/p", { sessionId: "s1" })).toBeUndefined();
      // The gate's retry asks again — and the blip is over.
      expect(await resolve("https://a.example/p", { sessionId: "s1" })).toBe(200);
      expect(await resolve("https://a.example/p", { sessionId: "s1" })).toBe(200);
      expect(calls).toBe(2);
    }
  });

  test("a refusal the guard will repeat (private or denied host, bad URL) is an answer: cached", async () => {
    let calls = 0;
    const resolve = createHeadResolver(SOURCES, async () => {
      calls += 1;
      throw new FetchPermissionError('[head denied] host "b.example" is not allowed');
    });
    expect(await resolve("https://a.example/p", { sessionId: "s1" })).toBeUndefined();
    expect(await resolve("https://a.example/p", { sessionId: "s1" })).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a non-number answer is no answer, and not kept", async () => {
    let calls = 0;
    const resolve = createHeadResolver(SOURCES, async () => {
      calls += 1;
      return Number.NaN;
    });
    expect(await resolve("https://a.example/", {})).toBeUndefined();
    expect(await resolve("https://a.example/", {})).toBeUndefined();
    expect(calls).toBe(2);
  });

  test("a request that never answers is cut off by the turn's abort", async () => {
    const resolve = createHeadResolver(SOURCES, () => new Promise<number>(() => {}));
    const ctrl = new AbortController();
    const pending = resolve("https://a.example/", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  test("an abort is the turn ending, not the page: rethrown and not cached", async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const resolve = createHeadResolver(SOURCES, async () => {
      calls += 1;
      if (calls === 1) {
        ctrl.abort();
        throw new Error("aborted");
      }
      return 204;
    });
    await expect(resolve("https://a.example/", { signal: ctrl.signal })).rejects.toThrow(/aborted/);
    expect(await resolve("https://a.example/", {})).toBe(204);
    expect(calls).toBe(2);
  });

  test("the cache is bounded", async () => {
    let calls = 0;
    const resolve = createHeadResolver(SOURCES, async () => {
      calls += 1;
      return 200;
    });
    for (let i = 0; i <= HEAD_CACHE_ENTRIES; i += 1) await resolve(`https://a.example/${i}`, {});
    expect(calls).toBe(HEAD_CACHE_ENTRIES + 1);
    // The oldest entry was evicted, so it is asked again; the newest is not.
    await resolve("https://a.example/0", {});
    await resolve(`https://a.example/${HEAD_CACHE_ENTRIES}`, {});
    expect(calls).toBe(HEAD_CACHE_ENTRIES + 2);
  });
});

describe("every request decided is recorded (an egress_decision), never a cache hit", () => {
  test("sent: pass with the status; refused: block; failed: pass with no status — the host only, never the URL", async () => {
    const decisions: HeadDecision[] = [];
    const record = (decision: HeadDecision) => {
      decisions.push(decision);
    };
    const resolve = createHeadResolver(SOURCES, async (url) => {
      if (url.includes("denied")) throw new FetchPermissionError(`invalid URL "${url}"`);
      if (url.includes("flaky")) throw new Error("ECONNRESET");
      return 404;
    });
    const secret = "https://a.example/leak?d=SECRET-TOKEN";
    expect(await resolve(secret, { sessionId: "s1", record })).toBe(404);
    expect(await resolve(secret, { sessionId: "s1", record })).toBe(404);
    expect(await resolve("https://denied.example/x", { sessionId: "s1", record })).toBeUndefined();
    expect(await resolve("https://flaky.example/x", { sessionId: "s1", record })).toBeUndefined();
    expect(decisions).toEqual([
      {
        sinkId: "provability.resolve",
        sinkScope: "external-dynamic",
        method: "HEAD",
        host: "a.example",
        verdict: "pass",
        status: 404,
      },
      {
        sinkId: "provability.resolve",
        sinkScope: "external-dynamic",
        method: "HEAD",
        host: "denied.example",
        verdict: "block",
        reason: "refused",
      },
      {
        sinkId: "provability.resolve",
        sinkScope: "external-dynamic",
        method: "HEAD",
        host: "flaky.example",
        verdict: "pass",
        reason: "failed",
      },
    ]);
    expect(JSON.stringify(decisions)).not.toContain("SECRET-TOKEN");
  });

  test("a recorder that throws costs the answer nothing", async () => {
    const resolve = createHeadResolver(SOURCES, async () => 200);
    expect(
      await resolve("https://a.example/", {
        record: () => {
          throw new Error("audit disk full");
        },
      }),
    ).toBe(200);
  });
});

describe("a shared cache", () => {
  test("two resolvers over one cache ask once per (session, policy, URL)", async () => {
    let calls = 0;
    const request = async () => {
      calls += 1;
      return 200;
    };
    const cache = new Map();
    const a = createHeadResolver(SOURCES, request, cache);
    const b = createHeadResolver(SOURCES, request, cache);
    await a("https://a.example/", { sessionId: "s1" });
    await b("https://a.example/", { sessionId: "s1" });
    expect(calls).toBe(1);
    // A different source policy is a different question.
    const strict = createHeadResolver({ ...SOURCES, deny: ["b.example"] }, request, cache);
    await strict("https://a.example/", { sessionId: "s1" });
    expect(calls).toBe(2);
  });
});

describe("createHeadResolver (default: tool-fetch's guarded HEAD)", () => {
  const seen: string[] = [];
  beforeEach(() => {
    seen.length = 0;
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
  });
  afterEach(() => {
    _setRawFetch(undefined);
    _setDnsLookup(undefined);
  });

  test("a HEAD through the guarded path; the status comes back", async () => {
    _setRawFetch(async (req) => {
      seen.push(`${req.method} ${req.url}`);
      return new Response(null, { status: 200 });
    });
    const resolve = createHeadResolver(SOURCES);
    expect(await resolve("https://docs.example.com/p", {})).toBe(200);
    expect(seen).toEqual(["HEAD https://docs.example.com/p"]);
  });

  test("an allow list admits the cited URL; its redirect to a publisher the list does not name is followed", async () => {
    _setRawFetch(async (req) => {
      seen.push(req.url);
      return req.url.startsWith("https://doi.org/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://www.nature.com/articles/x" },
          })
        : new Response(null, { status: 200 });
    });
    const resolve = createHeadResolver({ ...SOURCES, allow: ["doi.org", "arxiv.org"] });
    expect(await resolve("https://doi.org/10.1038/x", {})).toBe(200);
    expect(seen).toEqual(["https://doi.org/10.1038/x", "https://www.nature.com/articles/x"]);
    // A cited URL off the list is never requested.
    expect(await resolve("https://www.nature.com/articles/y", {})).toBeUndefined();
    expect(seen).toHaveLength(2);
  });

  test("a hung DNS lookup cannot hold the turn: the abort answers at once", async () => {
    // No clock, so no load can make it look late: the turn ends while the
    // lookup (which never returns) is in flight, and the resolver has
    // answered by the end of that turn — not at the HEAD's own 10 s timeout.
    const inLookup = new Promise<void>((entered) => {
      _setDnsLookup(() => {
        entered();
        return new Promise(() => {});
      });
    });
    _setRawFetch(async () => new Response(null, { status: 200 }));
    const resolve = createHeadResolver(SOURCES);
    const ctrl = new AbortController();
    let settled = "pending";
    resolve("https://slow-dns.example/p", { signal: ctrl.signal }).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await inLookup;
    ctrl.abort(new Error("turn over"));
    // Microtasks drain before an immediate: what the abort settles, it settles by then.
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe("rejected");
  });

  test("the spec's source policy holds on a redirect hop: a hop to a denied host is no answer", async () => {
    _setRawFetch(async (req) => {
      seen.push(req.url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://denied.example.net/landing" },
      });
    });
    const resolve = createHeadResolver({ ...SOURCES, deny: ["denied.example.net"] });
    expect(await resolve("https://docs.example.com/p", {})).toBeUndefined();
    expect(seen).toEqual(["https://docs.example.com/p"]);
  });

  test("a citation of private space is never requested", async () => {
    _setRawFetch(async (req) => {
      seen.push(req.url);
      return new Response(null, { status: 200 });
    });
    const resolve = createHeadResolver(SOURCES);
    expect(await resolve("http://169.254.169.254/latest", {})).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("the sink-side screen (design §6.1, §10; AGENTS.md Pillar 3)", () => {
  const BLOCKED = { verdict: "block", originsFound: ["tool"], matchCount: 1 } as const;
  const CLEAN = { verdict: "pass", originsFound: [], matchCount: 0 } as const;

  test("a URL the screen blocks is never requested, is recorded as a block (egress), and is not cached", async () => {
    const sent: string[] = [];
    const decisions: HeadDecision[] = [];
    let verdict: "block" | "pass" = "block";
    const resolve = createHeadResolver(SOURCES, async (url) => {
      sent.push(url);
      return 200;
    });
    const ctx = {
      sessionId: "s1",
      record: (d: HeadDecision) => {
        decisions.push(d);
      },
      screen: async () => (verdict === "block" ? BLOCKED : CLEAN),
    };
    const url = "https://collector.example/c?k=SECRET-TOKEN";
    // The verifier is told the request was refused, not that it went unanswered.
    expect(await resolve(url, ctx)).toEqual({ refused: "egress" });
    expect(sent).toEqual([]);
    expect(decisions).toEqual([
      {
        sinkId: "provability.resolve",
        sinkScope: "external-dynamic",
        method: "HEAD",
        host: "collector.example",
        verdict: "block",
        reason: "egress",
        originsFound: ["tool"],
        matchCount: 1,
      },
    ]);
    // Not an answer about the page: screened again next time.
    verdict = "pass";
    expect(await resolve(url, ctx)).toBe(200);
    expect(sent).toEqual([url]);
    expect(JSON.stringify(decisions)).not.toContain("SECRET-TOKEN");
  });

  test("a clean screen sends the request and the record carries the screen's verdict", async () => {
    const decisions: HeadDecision[] = [];
    const resolve = createHeadResolver(SOURCES, async () => 204);
    expect(
      await resolve("https://a.example/page", {
        record: (d) => {
          decisions.push(d);
        },
        screen: async () => ({ verdict: "warn", originsFound: ["mcp"], matchCount: 2 }),
      }),
    ).toBe(204);
    expect(decisions).toEqual([
      {
        sinkId: "provability.resolve",
        sinkScope: "external-dynamic",
        method: "HEAD",
        host: "a.example",
        verdict: "warn",
        status: 204,
        originsFound: ["mcp"],
        matchCount: 2,
      },
    ]);
  });

  test("a screen that cannot answer refuses: the request is an egress, never sent unscreened", async () => {
    const sent: string[] = [];
    const resolve = createHeadResolver(SOURCES, async (url) => {
      sent.push(url);
      return 200;
    });
    expect(
      await resolve("https://a.example/page", {
        screen: async () => {
          throw new Error("classifier unavailable");
        },
      }),
    ).toEqual({ refused: "egress" });
    expect(sent).toEqual([]);
  });
});
