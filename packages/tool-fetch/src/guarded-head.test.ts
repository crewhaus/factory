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
    _setDnsLookup(() => new Promise(() => {}));
    const raw = recordingFetch(() => new Response(null, { status: 200 }));
    raw.install();
    const started = Date.now();
    await expect(guardedHead("https://hung-dns.example/", { timeoutMs: 30 })).rejects.toThrow(
      /timed out after 30ms/,
    );
    const ctrl = new AbortController();
    const pending = guardedHead("https://hung-dns.example/", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error("turn over")), 30);
    await expect(pending).rejects.toThrow(/turn over/);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Nothing was sent: the lookup never vetted an address.
    expect(raw.seen).toEqual([]);
  });
});
