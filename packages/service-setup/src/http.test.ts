/**
 * The shared HTTP seam.
 *
 * Nothing here opens a socket: every test injects a `fetchImpl` that records
 * the request it was handed and answers with a hand-built `Response`. The
 * URLs all point at `.invalid`, so a regression that bypasses the injected
 * fetch fails with a DNS error instead of quietly reaching a real provider.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUT_MS, asRecord, readString, requestJson } from "./http";

const URL_UNDER_TEST = "https://api.example.invalid/v1/thing";
const HOST = "api.example.invalid";

type Call = {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly signal: unknown;
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A recording `fetchImpl` plus the calls it saw. */
function fakeFetch(handler: Handler): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...((init.headers ?? {}) as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal,
    });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Answer every request the same way. */
function replies(body: string, init: ResponseInit = {}): Handler {
  return () => new Response(body, init);
}

/** The single recorded call, narrowed. */
function only(calls: readonly Call[]): Call {
  const call = calls[0];
  if (call === undefined) throw new Error("fetchImpl was never called");
  return call;
}

const JSON_OK: ResponseInit = { status: 200, headers: { "content-type": "application/json" } };

describe("requestJson — the request it builds", () => {
  test("a GET with no body sends method GET and no content-type", async () => {
    const { calls, fetchImpl } = fakeFetch(replies(`{"ok":true}`, JSON_OK));
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });

    const call = only(calls);
    expect(call.url).toBe(URL_UNDER_TEST);
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.headers["content-type"]).toBeUndefined();
    expect(call.headers["accept"]).toBe("application/json");
    expect(res.body).toEqual({ ok: true });
  });

  test("`json` sets application/json and defaults the method to POST", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson({ url: URL_UNDER_TEST, json: { name: "crew", count: 2 } }, { fetchImpl });

    const call = only(calls);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toBe(`{"name":"crew","count":2}`);
  });

  test("`form` sets urlencoded, defaults to POST, and url-encodes the body", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson(
      { url: URL_UNDER_TEST, form: { grant_type: "refresh", note: "hello world&more" } },
      { fetchImpl },
    );

    const call = only(calls);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toBe("grant_type=refresh&note=hello+world%26more");
  });

  test("an explicit method wins over the body-derived default", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson({ url: URL_UNDER_TEST, method: "PUT", json: { a: 1 } }, { fetchImpl });
    expect(only(calls).method).toBe("PUT");
  });

  test("an explicit method wins for a bodiless request too", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson({ url: URL_UNDER_TEST, method: "DELETE" }, { fetchImpl });
    const call = only(calls);
    expect(call.method).toBe("DELETE");
    expect(call.body).toBeUndefined();
  });

  test("caller headers are merged and may override accept", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson(
      { url: URL_UNDER_TEST, headers: { authorization: "Bearer token", accept: "text/plain" } },
      { fetchImpl },
    );

    const call = only(calls);
    expect(call.headers["authorization"]).toBe("Bearer token");
    expect(call.headers["accept"]).toBe("text/plain");
  });

  test("an abort signal is always attached", async () => {
    const { calls, fetchImpl } = fakeFetch(replies("{}", JSON_OK));
    await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });
    expect(only(calls).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("requestJson — the response it returns", () => {
  test("a non-2xx does NOT throw and comes back with status and parsed body", async () => {
    const { fetchImpl } = fakeFetch(
      replies(`{"error":"not_found"}`, { status: 404, headers: { "content-type": "text/json" } }),
    );
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });

    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.body).toEqual({ error: "not_found" });
  });

  test("a 500 is likewise returned, not thrown", async () => {
    const { fetchImpl } = fakeFetch(replies(`{"error":"boom"}`, { status: 500 }));
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
  });

  test("a 2xx reports ok: true", async () => {
    const { fetchImpl } = fakeFetch(replies(`{"ok":true}`, { status: 201 }));
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
  });

  test("a non-JSON body comes back as { _raw }", async () => {
    const { fetchImpl } = fakeFetch(
      replies("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });

    expect(res.status).toBe(502);
    expect(asRecord(res.body)["_raw"]).toBe("<html>502 Bad Gateway</html>");
  });

  test("a long non-JSON body is truncated to 2000 chars", async () => {
    const huge = "x".repeat(2500);
    const { fetchImpl } = fakeFetch(replies(huge, { status: 500 }));
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });

    const raw = asRecord(res.body)["_raw"];
    expect(typeof raw).toBe("string");
    expect(raw as string).toHaveLength(2000);
    expect(raw).toBe(huge.slice(0, 2000));
  });

  test("an empty body parses as {}", async () => {
    const { fetchImpl } = fakeFetch(replies("", { status: 200 }));
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });
    expect(res.body).toEqual({});
  });

  test("response headers come back lowercased", async () => {
    const { fetchImpl } = fakeFetch(
      replies("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "7" },
      }),
    );
    const res = await requestJson({ url: URL_UNDER_TEST }, { fetchImpl });

    expect(res.headers["x-ratelimit-remaining"]).toBe("7");
    expect(res.headers["content-type"]).toContain("application/json");
  });
});

describe("requestJson — transport failures", () => {
  test("a thrown transport error is wrapped with the HOST in the message", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(requestJson({ url: URL_UNDER_TEST }, { fetchImpl })).rejects.toThrow(
      `could not reach ${HOST}: fetch failed`,
    );
  });

  test("a TimeoutError becomes the `did not respond within Nms` message", async () => {
    const { fetchImpl } = fakeFetch(() => {
      const err = new Error("The operation timed out.");
      err.name = "TimeoutError";
      throw err;
    });

    await expect(
      requestJson({ url: URL_UNDER_TEST }, { fetchImpl, timeoutMs: 1500 }),
    ).rejects.toThrow(`${HOST} did not respond within 1500ms`);
  });

  test("an AbortError uses the default timeout in the message", async () => {
    const { fetchImpl } = fakeFetch(() => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    await expect(requestJson({ url: URL_UNDER_TEST }, { fetchImpl })).rejects.toThrow(
      `${HOST} did not respond within ${DEFAULT_TIMEOUT_MS}ms`,
    );
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  test("an unparseable URL falls back to the raw string in the message", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    await expect(requestJson({ url: "not a url" }, { fetchImpl })).rejects.toThrow(
      "could not reach not a url: fetch failed",
    );
  });

  test("a non-Error rejection still names the host", async () => {
    // A rejection that is not an `Error` — the `String(err)` branch.
    const { fetchImpl } = fakeFetch(() => Promise.reject("socket hang up"));

    await expect(requestJson({ url: URL_UNDER_TEST }, { fetchImpl })).rejects.toThrow(
      `could not reach ${HOST}: socket hang up`,
    );
  });
});

describe("asRecord", () => {
  test("passes an object through", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  test("rejects an array", () => {
    const out = asRecord([1, 2, 3]);
    expect(Array.isArray(out)).toBe(false);
    expect(Object.keys(out)).toEqual([]);
  });

  test("rejects null", () => {
    expect(asRecord(null)).toEqual({});
  });

  test("rejects a primitive or undefined", () => {
    expect(asRecord("nope")).toEqual({});
    expect(asRecord(42)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
  });
});

describe("readString", () => {
  test("reads a non-empty string field", () => {
    expect(readString({ token: "abc" }, "token")).toBe("abc");
  });

  test("rejects an empty string", () => {
    expect(readString({ token: "" }, "token")).toBeUndefined();
  });

  test("rejects a non-string field", () => {
    expect(readString({ token: 7 }, "token")).toBeUndefined();
    expect(readString({ token: null }, "token")).toBeUndefined();
    expect(readString({ token: { nested: "abc" } }, "token")).toBeUndefined();
  });

  test("rejects a missing field", () => {
    expect(readString({ other: "abc" }, "token")).toBeUndefined();
  });

  test("rejects a non-record body", () => {
    expect(readString(["abc"], "0")).toBeUndefined();
    expect(readString(null, "token")).toBeUndefined();
  });
});
