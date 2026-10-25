/**
 * 0.8.0 (design §6.1) — `guardedHead`, the reachability check behind
 * `provability.sources.resolve: head`: the Fetch tool's guarded path (SSRF
 * classifier on every hop, IP pinning, bounded redirects), a HEAD with no
 * body read, the caller's host policy re-applied to every redirect hop, and
 * the Fetch tool's own `allowed_origins` list NOT consulted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FetchPermissionError,
  _resetFetchConfig,
  _setDnsLookup,
  _setRawFetch,
  guardedHead,
} from "./index";

const PUBLIC_DNS_STUB = async () => ({ address: "93.184.216.34", family: 4 });

type Seen = { readonly method: string; readonly url: string; readonly pinnedIp: string };

function recordingFetch(answer: (req: Request) => Response): {
  readonly seen: Seen[];
  install(): void;
} {
  const seen: Seen[] = [];
  return {
    seen,
    install() {
      _setRawFetch(async (req, pinnedIp) => {
        seen.push({ method: req.method, url: req.url, pinnedIp });
        return answer(req);
      });
    },
  };
}

/**
 * A DNS lookup that never returns, installed now; resolves once a request
 * waits on it, so a test stops the request there rather than on a timer.
 */
function hungLookup(): Promise<void> {
  return new Promise((entered) => {
    _setDnsLookup(() => {
      entered();
      return new Promise(() => {});
    });
  });
}

type Settled =
  | { readonly settled: "pending" }
  | { readonly settled: "resolved"; readonly value: unknown }
  | { readonly settled: "rejected"; readonly error: unknown };

/**
 * Watch `call` from now on; `afterThisTurn()` says where it stands once
 * everything already queued has run (microtasks drain before an
 * immediate). No clock: what settles in this turn does so however loaded
 * the machine is, and a request still waiting on something else is
 * `pending`.
 */
function watch(call: Promise<unknown>): { readonly afterThisTurn: () => Promise<Settled> } {
  let state: Settled = { settled: "pending" };
  call.then(
    (value) => {
      state = { settled: "resolved", value };
    },
    (error: unknown) => {
      state = { settled: "rejected", error };
    },
  );
  return {
    afterThisTurn: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return state;
    },
  };
}

beforeEach(() => {
  _resetFetchConfig();
  _setRawFetch(undefined);
  _setDnsLookup(PUBLIC_DNS_STUB);
});

afterEach(() => {
  _resetFetchConfig();
  _setRawFetch(undefined);
  _setDnsLookup(undefined);
});

describe("guardedHead", () => {
  test("sends one HEAD, pinned to the vetted IP, and returns the status — with no allowed_origins configured", async () => {
    const raw = recordingFetch(() => new Response(null, { status: 200 }));
    raw.install();
    expect(await guardedHead("https://docs.example.com/policy")).toBe(200);
    expect(raw.seen).toEqual([
      { method: "HEAD", url: "https://docs.example.com/policy", pinnedIp: "93.184.216.34" },
    ]);
  });

  test("a non-2xx answer is returned as is (the caller decides what it means)", async () => {
    recordingFetch(() => new Response(null, { status: 404 })).install();
    expect(await guardedHead("https://docs.example.com/missing")).toBe(404);
  });

  test("follows a redirect and reports the final status", async () => {
    const raw = recordingFetch((req) =>
      req.url.endsWith("/old")
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response(null, { status: 204 }),
    );
    raw.install();
    expect(await guardedHead("https://docs.example.com/old")).toBe(204);
    expect(raw.seen.map((s) => s.url)).toEqual([
      "https://docs.example.com/old",
      "https://docs.example.com/new",
    ]);
    expect(raw.seen.every((s) => s.method === "HEAD")).toBe(true);
  });

  test("refuses a private address before any request", async () => {
    const raw = recordingFetch(() => new Response(null, { status: 200 }));
    raw.install();
    await expect(guardedHead("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    await expect(guardedHead("http://localhost:8080/")).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    expect(raw.seen).toEqual([]);
  });

  test("a public name that resolves to a private address is refused (rebinding)", async () => {
    _setDnsLookup(async () => ({ address: "10.0.0.7", family: 4 }));
    const raw = recordingFetch(() => new Response(null, { status: 200 }));
    raw.install();
    await expect(guardedHead("https://intranet.example.com/")).rejects.toThrow(/private IP/);
    expect(raw.seen).toEqual([]);
  });

  test("a redirect into private space is refused at the hop", async () => {
    const raw = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    );
    raw.install();
    await expect(guardedHead("https://docs.example.com/x")).rejects.toBeInstanceOf(
      FetchPermissionError,
    );
    expect(raw.seen).toHaveLength(1);
  });

  test("allowHost is applied to the first URL and to every redirect hop", async () => {
    const raw = recordingFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example.net/x" } }),
    );
    raw.install();
    const allowHost = (host: string): boolean => host.endsWith("example.com");
    await expect(guardedHead("https://other.example.org/", { allowHost })).rejects.toThrow(
      /head denied/,
    );
    expect(raw.seen).toEqual([]);
    await expect(guardedHead("https://docs.example.com/", { allowHost })).rejects.toThrow(
      /evil\.example\.net/,
    );
    expect(raw.seen).toHaveLength(1);
  });

  test("only http and https are spoken", async () => {
    await expect(guardedHead("file:///etc/passwd")).rejects.toThrow(/only http\/https/);
    await expect(guardedHead("not a url")).rejects.toThrow(/invalid URL/);
  });

  test("more than five redirects is refused", async () => {
    let n = 0;
    recordingFetch(() => {
      n += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${n}` } });
    }).install();
    await expect(guardedHead("https://docs.example.com/loop")).rejects.toThrow(
      /too many redirects/,
    );
  });

  test("the timeout and the caller's abort both stop the request", async () => {
    _setRawFetch(
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          if (req.signal.aborted) {
            reject(req.signal.reason);
            return;
          }
          req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
        }),
    );
    await expect(guardedHead("https://slow.example.com/", { timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20ms/,
    );
    const ctrl = new AbortController();
    const pending = guardedHead("https://slow.example.com/", { signal: ctrl.signal });
    ctrl.abort(new Error("turn over"));
    await expect(pending).rejects.toThrow(/turn over/);
    const already = new AbortController();
    already.abort(new Error("already gone"));
    await expect(
      guardedHead("https://slow.example.com/", { signal: already.signal }),
    ).rejects.toThrow(/already gone/);
  });

  test("the bound covers DNS: a lookup that never returns is cut off by the timeout and by the abort", async () => {
    // No clock, so no load can make it look late: each request is stopped
    // once it waits on the lookup, and must have answered by a point the
    // event loop orders, not by a number of milliseconds.
    const raw = recordingFetch(() => new Response(null, { status: 200 }));
    raw.install();
    // The timeout: a timer armed after the request's own, and for longer,
    // fires after it however late both are.
    let inLookup = hungLookup();
    const timedOut = watch(guardedHead("https://hung-dns.example/", { timeoutMs: 30 }));
    await inLookup;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const late = await timedOut.afterThisTurn();
    expect(late.settled).toBe("rejected");
    expect(late.settled === "rejected" && String(late.error)).toMatch(/timed out after 30ms/);
    // The abort answers in the turn it fires in — not at the 10 s default.
    inLookup = hungLookup();
    const ctrl = new AbortController();
    const aborted = watch(guardedHead("https://hung-dns.example/", { signal: ctrl.signal }));
    await inLookup;
    ctrl.abort(new Error("turn over"));
    const now = await aborted.afterThisTurn();
    expect(now.settled).toBe("rejected");
    expect(now.settled === "rejected" && String(now.error)).toMatch(/turn over/);
    // Nothing was sent: the lookup never vetted an address.
    expect(raw.seen).toEqual([]);
  });
});
