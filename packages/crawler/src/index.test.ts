import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Citation,
  CitationTracker,
  FetchRecord,
  RecordCitationInput,
  RecordFetchInput,
} from "@crewhaus/citation-tracker";
import { createCitationTracker } from "@crewhaus/citation-tracker";
import type { CrawlResult, Crawler } from "./index.js";
import { _setDnsLookup, createCiteFactTool, createCrawler, createSourceTool } from "./index.js";

// HTTP fetches now run an SSRF guard that resolves the host before egress.
// Resolve every name to a public IP by default so the existing transport
// tests (which use non-resolvable example hostnames) stay hermetic; the SSRF
// suite below overrides this per-test to exercise the private-IP rejections.
beforeEach(() => _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 })));
afterEach(() => _setDnsLookup(undefined));

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "crawler-"));
}

/**
 * Minimal in-memory CitationTracker stand-in. The real tracker always writes a
 * record alongside content, so a few defensive branches in the crawler (e.g.
 * "content present but record missing") are only reachable with a hand-rolled
 * tracker whose invariants we can deliberately break.
 */
function fakeTracker(
  overrides: Partial<CitationTracker> = {},
): CitationTracker & { fetches: RecordFetchInput[]; citations: RecordCitationInput[] } {
  const fetches: RecordFetchInput[] = [];
  const citations: RecordCitationInput[] = [];
  const base: CitationTracker = {
    runId: "run_0123456789abcdef",
    hasFetched: () => false,
    getFetchedContent: () => undefined,
    getFetchRecord: () => undefined,
    recordFetch: (input: RecordFetchInput): FetchRecord => {
      fetches.push(input);
      return {
        version: 1,
        url: input.url,
        retrievedAt: "2026-06-04T00:00:00.000Z",
        sha256: "a".repeat(64),
        contentBytes: Buffer.byteLength(input.content, "utf8"),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      };
    },
    recordCitation: (input: RecordCitationInput): Citation => {
      citations.push(input);
      return {
        version: 1,
        url: input.url,
        snippet: input.snippet,
        retrievedAt: "2026-06-04T00:00:00.000Z",
        sha256: "b".repeat(64),
        ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        ...(input.supportingClaim !== undefined ? { supportingClaim: input.supportingClaim } : {}),
      };
    },
    listCitationsOrdered: () => [],
    listFetches: () => [],
  };
  return Object.assign(base, overrides, { fetches, citations });
}

describe("createCrawler — http transport", () => {
  test("denies an http origin not on the allow-list", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedOrigins: new Set([]) },
      });
      await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(/allow-list/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns body and records on tracker on first fetch", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () =>
            new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
        },
      });
      const r = await crawler.fetch("https://example.com/x");
      expect(r.fromCache).toBe(false);
      expect(r.content).toBe("hello");
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tracker.hasFetched("https://example.com/x")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("second call to the same URL is cache-served (T4 dedup invariant)", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      let calls = 0;
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => {
            calls += 1;
            return new Response("hello", { status: 200 });
          },
        },
      });
      await crawler.fetch("https://example.com/x");
      const second = await crawler.fetch("https://example.com/x");
      expect(calls).toBe(1);
      expect(second.fromCache).toBe(true);
      expect(second.content).toBe("hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("redirect handling: respects allow-list at every hop", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://a.example.com"]),
          _httpFetch: async () =>
            new Response("redir", {
              status: 302,
              headers: { location: "https://forbidden.example.com/y" },
            }),
        },
      });
      await expect(crawler.fetch("https://a.example.com/x")).rejects.toThrow(/redirect target/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — file:// transport", () => {
  test("reads file body when path is under an allowed root", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "hello-from-disk");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root] },
      });
      const r = await crawler.fetch(`file://${fixture}`);
      expect(r.content).toBe("hello-from-disk");
      expect(r.fromCache).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects file paths outside the allowed roots", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "hello");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: ["/nonexistent-root"] },
      });
      await expect(crawler.fetch(`file://${fixture}`)).rejects.toThrow(/outside the configured/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("file fetch is also dedup'd via the tracker", async () => {
    const root = newRoot();
    const fixture = join(root, "fixture.txt");
    writeFileSync(fixture, "v1");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root] },
      });
      const url = `file://${fixture}`;
      await crawler.fetch(url);
      // Mutate the file to prove cache is served, NOT disk:
      writeFileSync(fixture, "v2");
      const second = await crawler.fetch(url);
      expect(second.fromCache).toBe(true);
      expect(second.content).toBe("v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — unsupported schemes", () => {
  test("rejects ftp:// and other schemes", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({ tracker });
      await expect(crawler.fetch("ftp://example.com/x")).rejects.toThrow(/unsupported URL scheme/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a malformed URL during canonicalisation", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedOrigins: new Set(["https://example.com"]) },
      });
      // Starts with https:// (so it routes to fetchHttp) but is not a parseable URL.
      await expect(crawler.fetch("https://")).rejects.toThrow(/invalid URL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — http redirect + origin canonicalisation", () => {
  test("follows a redirect to an allowed origin and returns the final body", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      let hop = 0;
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://a.example.com", "https://b.example.com"]),
          _httpFetch: async (url) => {
            hop += 1;
            if (url === "https://a.example.com/x") {
              // Relative Location resolved against the current URL's origin.
              return new Response("", { status: 301, headers: { location: "/moved" } });
            }
            if (url === "https://a.example.com/moved") {
              return new Response("", {
                status: 302,
                headers: { location: "https://b.example.com/final" },
              });
            }
            return new Response("final-body", { status: 200 });
          },
        },
      });
      const r = await crawler.fetch("https://a.example.com/x");
      expect(r.content).toBe("final-body");
      expect(r.fromCache).toBe(false);
      expect(hop).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a redirect that omits the Location header", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://a.example.com"]),
          _httpFetch: async () => new Response("", { status: 302 }),
        },
      });
      await expect(crawler.fetch("https://a.example.com/x")).rejects.toThrow(
        /redirect without Location/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws once the redirect budget is exhausted (loop guard)", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          maxRedirects: 1,
          allowedOrigins: new Set(["https://a.example.com"]),
          // Always self-redirect to a same-origin target so the allow-list passes
          // but the hop budget is the thing that trips.
          _httpFetch: async () =>
            new Response("", { status: 307, headers: { location: "https://a.example.com/again" } }),
        },
      });
      await expect(crawler.fetch("https://a.example.com/x")).rejects.toThrow(
        /exceeded 1 redirects/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative maxRedirects skips the fetch loop entirely (post-loop guard)", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      let called = false;
      const crawler = createCrawler({
        tracker,
        config: {
          maxRedirects: -1,
          allowedOrigins: new Set(["https://a.example.com"]),
          _httpFetch: async () => {
            called = true;
            return new Response("never", { status: 200 });
          },
        },
      });
      await expect(crawler.fetch("https://a.example.com/x")).rejects.toThrow(
        /exceeded -1 redirects/,
      );
      // The for-loop never iterates, so the transport is never invoked.
      expect(called).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-redirect, non-ok HTTP status", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("nope", { status: 500 }),
        },
      });
      await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(/HTTP 500/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an HTTP body that exceeds maxBodyBytes", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          maxBodyBytes: 4,
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("too-long", { status: 200 }),
        },
      });
      await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(/exceeds 4 bytes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalises explicit default ports and non-default ports", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const seen: string[] = [];
      const crawler = createCrawler({
        tracker,
        config: {
          // https on :443 canonicalises to bare origin; :8443 stays explicit.
          allowedOrigins: new Set(["https://example.com", "https://example.com:8443"]),
          _httpFetch: async (url) => {
            seen.push(url);
            return new Response("ok", { status: 200 });
          },
        },
      });
      await crawler.fetch("https://example.com:443/a");
      await crawler.fetch("https://example.com:8443/b");
      expect(seen).toEqual(["https://example.com:443/a", "https://example.com:8443/b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalises http on the default port 80 to a bare origin", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["http://example.com"]),
          _httpFetch: async () => new Response("plain", { status: 200 }),
        },
      });
      const r = await crawler.fetch("http://example.com:80/a");
      expect(r.content).toBe("plain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — per-domain rate limiting", () => {
  test("passes calls under the limit straight through (no wait)", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          rateLimit: { maxPerSecond: 5 },
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("ok", { status: 200 }),
        },
      });
      const r = await crawler.fetch("https://example.com/a");
      expect(r.content).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resets the window after one second has elapsed", async () => {
    const root = newRoot();
    const nowSpy = spyOn(Date, "now");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      let body = 0;
      const crawler = createCrawler({
        tracker,
        config: {
          rateLimit: { maxPerSecond: 1 },
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => {
            body += 1;
            return new Response(`b${body}`, { status: 200 });
          },
        },
      });
      // First call at t=1000 opens a window; second call at t=2100 (>1s later)
      // resets the window instead of waiting, so neither call blocks.
      nowSpy.mockReturnValue(1000);
      await crawler.fetch("https://example.com/a");
      nowSpy.mockReturnValue(2100);
      const r = await crawler.fetch("https://example.com/b");
      expect(r.content).toBe("b2");
    } finally {
      nowSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("waits when the per-second budget is exhausted within the window", async () => {
    const root = newRoot();
    const nowSpy = spyOn(Date, "now");
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    const waits: number[] = [];
    // Run scheduled callbacks synchronously so the test never touches the clock.
    timeoutSpy.mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          rateLimit: { maxPerSecond: 1 },
          timeoutMs: 30_000,
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("ok", { status: 200 }),
        },
      });
      // Hold the clock fixed inside the same 1s window so the 2nd call is forced
      // onto the wait branch (callsInWindow >= maxPerSecond).
      nowSpy.mockReturnValue(5000);
      await crawler.fetch("https://example.com/a");
      const r = await crawler.fetch("https://example.com/a-again");
      expect(r.content).toBe("ok");
      // The rate-limit sleep clamps to a 50ms floor (1000 - (5000-5000) = 1000,
      // but since now===windowStart the computed wait is the full second).
      expect(waits.some((w) => w >= 50)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      timeoutSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clamps the wait to a 50ms floor when the window is nearly closed", async () => {
    const root = newRoot();
    const nowSpy = spyOn(Date, "now");
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    const waits: number[] = [];
    timeoutSpy.mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          rateLimit: { maxPerSecond: 1 },
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("ok", { status: 200 }),
        },
      });
      // First call opens the window at t=10000. Second call at t=10999 is still
      // in-window (delta 999 < 1000) AND over budget, so it waits — but the
      // remaining 1ms is clamped up to the 50ms floor.
      nowSpy.mockReturnValue(10_000);
      await crawler.fetch("https://example.com/a");
      nowSpy.mockReturnValue(10_999);
      await crawler.fetch("https://example.com/a-again");
      // Math.max(50, 1000 - 999) === 50.
      expect(waits).toContain(50);
    } finally {
      nowSpy.mockRestore();
      timeoutSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — abort + timeout wiring", () => {
  test("the internal timeout aborts a hung fetch", async () => {
    const root = newRoot();
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    // Fire the timeout callback synchronously so the abort propagates at once
    // (the rate-limit gate is inert here, so this only catches the 30s timer).
    timeoutSpy.mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: {
          timeoutMs: 5,
          allowedOrigins: new Set(["https://example.com"]),
          // Reject if/when the (internal) signal aborts — the timeout drives it.
          _httpFetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              if (init.signal?.aborted) {
                reject(new Error("aborted"));
                return;
              }
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        },
      });
      await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(/aborted/);
    } finally {
      timeoutSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an external AbortSignal forwards its abort into the in-flight fetch", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const external = new AbortController();
      const removeSpy = spyOn(external.signal, "removeEventListener");
      const crawler = createCrawler({
        tracker,
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          // By the time _httpFetch runs, the crawler has already attached its
          // external-abort listener. Aborting the external signal here drives
          // the crawler's `externalAbort` handler, which aborts the *internal*
          // controller — surfaced to us via `init.signal`.
          _httpFetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted-by-external")),
                { once: true },
              );
              external.abort();
            }),
        },
      });
      await expect(
        crawler.fetch("https://example.com/x", { signal: external.signal }),
      ).rejects.toThrow(/aborted-by-external/);
      // `finally` must detach the external listener even on the failure path.
      expect(removeSpy.mock.calls.some((c) => c[0] === "abort")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes an explicit branchId through to recordFetch", async () => {
    const tracker = fakeTracker();
    const crawler = createCrawler({
      tracker,
      config: {
        allowedOrigins: new Set(["https://example.com"]),
        _httpFetch: async () => new Response("hi", { status: 200 }),
      },
    });
    const r = await crawler.fetch("https://example.com/x", { branchId: "branch-7" });
    expect(r.fromCache).toBe(false);
    expect(tracker.fetches).toEqual([
      { url: "https://example.com/x", content: "hi", branchId: "branch-7" },
    ]);
  });
});

describe("createCrawler — file:// edge cases", () => {
  test("rejects a file that exceeds maxBodyBytes", async () => {
    const root = newRoot();
    const fixture = join(root, "big.txt");
    writeFileSync(fixture, "0123456789");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root], maxBodyBytes: 4 },
      });
      await expect(crawler.fetch(`file://${fixture}`)).rejects.toThrow(/exceeds 4 bytes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wraps a read failure for a missing file under an allowed root", async () => {
    const root = newRoot();
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [root] },
      });
      const missing = join(root, "does-not-exist.txt");
      await expect(crawler.fetch(`file://${missing}`)).rejects.toThrow(/failed to read/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an exact-root path (equal to the root itself) is treated as in-bounds", async () => {
    const root = newRoot();
    // Point the allowed root at the file itself so `abs === root` is exercised.
    const fixture = join(root, "exact.txt");
    writeFileSync(fixture, "exact-match");
    try {
      const tracker = createCitationTracker({ rootDir: root });
      const crawler = createCrawler({
        tracker,
        config: { allowedFileRoots: [fixture] },
      });
      const r = await crawler.fetch(`file://${fixture}`);
      expect(r.content).toBe("exact-match");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — tracker cache metadata", () => {
  test("serves a cache hit with the stored sha256 + retrievedAt", async () => {
    const tracker = fakeTracker({
      getFetchedContent: () => "cached-body",
      getFetchRecord: () => ({
        version: 1,
        url: "https://example.com/x",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        sha256: "c".repeat(64),
        contentBytes: 11,
      }),
    });
    const crawler = createCrawler({ tracker });
    const r = await crawler.fetch("https://example.com/x");
    expect(r).toEqual({
      url: "https://example.com/x",
      content: "cached-body",
      fromCache: true,
      sha256: "c".repeat(64),
      retrievedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("throws when the tracker has content but no record metadata", async () => {
    // Deliberately break the tracker invariant: content present, record absent.
    const tracker = fakeTracker({
      getFetchedContent: () => "orphan-body",
      getFetchRecord: () => undefined,
    });
    const crawler = createCrawler({ tracker });
    await expect(crawler.fetch("https://example.com/x")).rejects.toThrow(
      /content for .* but no record metadata/,
    );
  });
});

// ---------------------------------------------------------------------------
// Agent-facing tools.
// ---------------------------------------------------------------------------

/** A Crawler stub that records the args it was called with. */
function stubCrawler(
  impl: (url: string, opts?: { branchId?: string; signal?: AbortSignal }) => Promise<CrawlResult>,
): Crawler & { calls: Array<{ url: string; opts?: { branchId?: string; signal?: AbortSignal } }> } {
  const calls: Array<{ url: string; opts?: { branchId?: string; signal?: AbortSignal } }> = [];
  return {
    calls,
    fetch: (url, opts) => {
      calls.push({ url, opts });
      return impl(url, opts);
    },
  };
}

function crawlResult(over: Partial<CrawlResult> = {}): CrawlResult {
  return {
    url: "https://example.com/x",
    content: "body",
    fromCache: false,
    sha256: "d".repeat(64),
    retrievedAt: "2026-06-04T00:00:00.000Z",
    ...over,
  };
}

describe("createSourceTool", () => {
  test("declares safe, read-only tool metadata", () => {
    const crawler = stubCrawler(async () => crawlResult());
    const tool = createSourceTool({ crawler });
    expect(tool.name).toBe("Source");
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    expect(tool.concurrencySafe).toBe(true);
  });

  test("returns the body with a fromCache/sha256 header on success", async () => {
    const crawler = stubCrawler(async () => crawlResult({ content: "page text", fromCache: true }));
    const tool = createSourceTool({ crawler });
    const out = await tool.execute({ uri: "https://example.com/x" });
    expect(out).toBe(`[fromCache=true sha256=${"d".repeat(12)}…]\npage text`);
  });

  test("truncates the body to the configured cap and reports the original size", async () => {
    const crawler = stubCrawler(async () => crawlResult({ content: "abcdefghij" }));
    const tool = createSourceTool({ crawler, maxResultBytes: 4 });
    const out = (await tool.execute({ uri: "https://example.com/x" })) as string;
    expect(out).toContain("abcd\n[truncated to 4 of 10 bytes]");
    expect(out).not.toContain("efghij\n");
  });

  test("forwards branchId (when provided) and the ctx signal to the crawler", async () => {
    const crawler = stubCrawler(async () => crawlResult());
    const tool = createSourceTool({ crawler, currentBranchId: () => "br-42" });
    const ac = new AbortController();
    await tool.execute({ uri: "https://example.com/x" }, { signal: ac.signal });
    expect(crawler.calls).toHaveLength(1);
    expect(crawler.calls[0]?.opts?.branchId).toBe("br-42");
    expect(crawler.calls[0]?.opts?.signal).toBe(ac.signal);
  });

  test("omits branchId when the resolver returns undefined and no ctx is given", async () => {
    const crawler = stubCrawler(async () => crawlResult());
    const tool = createSourceTool({ crawler, currentBranchId: () => undefined });
    await tool.execute({ uri: "https://example.com/x" });
    expect(crawler.calls[0]?.opts).toEqual({});
  });

  test("renders a fetch failure as a [Source error] line (Error.message path)", async () => {
    const crawler = stubCrawler(async () => {
      throw new Error("boom");
    });
    const tool = createSourceTool({ crawler });
    const out = await tool.execute({ uri: "https://example.com/x" });
    expect(out).toBe("[Source error] boom");
  });

  test("falls back to String(err) when the thrown value has no message", async () => {
    const crawler = stubCrawler(async () => {
      // Throw a non-Error with NO `message` property so `.message` is undefined
      // and the `?? String(err)` branch is taken (`??` ignores "", needs undefined).
      throw { toString: () => "weird-failure" };
    });
    const tool = createSourceTool({ crawler });
    const out = await tool.execute({ uri: "https://example.com/x" });
    expect(out).toBe("[Source error] weird-failure");
  });
});

describe("createCiteFactTool", () => {
  test("declares safe, read-only tool metadata", () => {
    const tracker = fakeTracker();
    const tool = createCiteFactTool({ tracker });
    expect(tool.name).toBe("CiteFact");
    expect(tool.readOnly).toBe(true);
    expect(tool.classifyOutput).toBe(false);
  });

  test("records a citation and echoes the url + short sha256", async () => {
    const tracker = fakeTracker();
    const tool = createCiteFactTool({ tracker });
    const out = await tool.execute({
      uri: "https://example.com/x",
      snippet: "the quick brown fox",
    });
    expect(out).toBe(`Recorded citation: https://example.com/x (sha256=${"b".repeat(12)}…)`);
    expect(tracker.citations).toEqual([
      { url: "https://example.com/x", snippet: "the quick brown fox" },
    ]);
  });

  test("threads branchId and supportingClaim through to recordCitation", async () => {
    const tracker = fakeTracker();
    const tool = createCiteFactTool({ tracker, currentBranchId: () => "br-9" });
    await tool.execute({
      uri: "file:///doc.txt",
      snippet: "a verbatim quote",
      supportingClaim: "supports the thesis",
    });
    expect(tracker.citations).toEqual([
      {
        url: "file:///doc.txt",
        snippet: "a verbatim quote",
        branchId: "br-9",
        supportingClaim: "supports the thesis",
      },
    ]);
  });

  test("omits branchId when no resolver is configured", async () => {
    const tracker = fakeTracker();
    const tool = createCiteFactTool({ tracker });
    await tool.execute({ uri: "u", snippet: "s" });
    expect(tracker.citations[0]).toEqual({ url: "u", snippet: "s" });
  });
});

// SECURITY: the crawler's origin allow-list and file roots come from the
// spec's `retrieve.*`, which ships inside marketplace template YAML — i.e.
// they can be attacker-chosen. So an allow-list that names loopback/metadata,
// or a file root that contains an escaping symlink, must NOT let the agent
// read internal endpoints or host files. The SSRF floor and symlink-aware
// containment below apply REGARDLESS of the allow-list/roots.
describe("createCrawler — SSRF floor (http)", () => {
  const tracker = (root: string) => createCitationTracker({ rootDir: root });

  test("rejects an allow-listed loopback IP-literal origin (no DNS needed)", async () => {
    const root = newRoot();
    try {
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          allowedOrigins: new Set(["http://127.0.0.1:8200"]),
          _httpFetch: async () => new Response("secret", { status: 200 }),
        },
      });
      await expect(crawler.fetch("http://127.0.0.1:8200/v1/secret")).rejects.toThrow(/SSRF/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an allow-listed cloud-metadata origin", async () => {
    const root = newRoot();
    try {
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          allowedOrigins: new Set(["http://169.254.169.254"]),
          _httpFetch: async () => new Response("creds", { status: 200 }),
        },
      });
      await expect(crawler.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
        /SSRF/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an allow-listed IPv4-mapped IPv6 loopback origin", async () => {
    const root = newRoot();
    try {
      // `new URL` canonicalizes [::ffff:127.0.0.1] to [::ffff:7f00:1], so a
      // real attacker's allow-list would carry that normalized form. The SSRF
      // guard must still see through it to the embedded 127.0.0.1.
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          allowedOrigins: new Set(["http://[::ffff:7f00:1]"]),
          _httpFetch: async () => new Response("x", { status: 200 }),
        },
      });
      await expect(crawler.fetch("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/SSRF/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an allow-listed public host that resolves to a private IP (rebinding)", async () => {
    _setDnsLookup(async () => ({ address: "169.254.169.254", family: 4 }));
    const root = newRoot();
    try {
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          allowedOrigins: new Set(["https://innocent.example"]),
          _httpFetch: async () => new Response("x", { status: 200 }),
        },
      });
      await expect(crawler.fetch("https://innocent.example/")).rejects.toThrow(/private IP/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a redirect to an allow-listed private host", async () => {
    const root = newRoot();
    try {
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          // Both origins are allow-listed; the redirect target is private and
          // must still be rejected by the per-hop SSRF guard.
          allowedOrigins: new Set(["https://start.example", "http://127.0.0.1"]),
          _httpFetch: async (url) => {
            if (url === "https://start.example/x") {
              return new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1/" },
              });
            }
            return new Response("secret", { status: 200 });
          },
        },
      });
      await expect(crawler.fetch("https://start.example/x")).rejects.toThrow(/SSRF/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still allows an allow-listed public host", async () => {
    const root = newRoot();
    try {
      const crawler = createCrawler({
        tracker: tracker(root),
        config: {
          allowedOrigins: new Set(["https://example.com"]),
          _httpFetch: async () => new Response("ok", { status: 200 }),
        },
      });
      const r = await crawler.fetch("https://example.com/x");
      expect(r.content).toBe("ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createCrawler — file:// symlink containment (CWE-59)", () => {
  test("rejects an in-root symlink whose real target escapes the root", async () => {
    const root = newRoot();
    const outside = newRoot();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "TOP-SECRET");
    const link = join(root, "innocent.txt");
    symlinkSync(secret, link);
    try {
      const crawler = createCrawler({
        tracker: createCitationTracker({ rootDir: root }),
        config: { allowedFileRoots: [root] },
      });
      await expect(crawler.fetch(`file://${link}`)).rejects.toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects a path that traverses out via an in-root symlinked directory", async () => {
    const root = newRoot();
    const outside = newRoot();
    mkdirSync(join(outside, "sub"));
    writeFileSync(join(outside, "sub", "secret.txt"), "TOP-SECRET");
    symlinkSync(outside, join(root, "linkdir"));
    try {
      const crawler = createCrawler({
        tracker: createCitationTracker({ rootDir: root }),
        config: { allowedFileRoots: [root] },
      });
      await expect(
        crawler.fetch(`file://${join(root, "linkdir", "sub", "secret.txt")}`),
      ).rejects.toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("still reads a genuine in-root file", async () => {
    const root = newRoot();
    const fixture = join(root, "ok.txt");
    writeFileSync(fixture, "in-root-content");
    try {
      const crawler = createCrawler({
        tracker: createCitationTracker({ rootDir: root }),
        config: { allowedFileRoots: [root] },
      });
      const r = await crawler.fetch(`file://${fixture}`);
      expect(r.content).toBe("in-root-content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
