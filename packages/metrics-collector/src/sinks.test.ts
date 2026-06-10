/**
 * Sink unit tests. The HTTP sink serves an **unauthenticated** `/metrics`
 * endpoint, so its bind address is security-relevant: it must default to
 * loopback and only listen on a wider interface when explicitly asked to.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Registry } from "./registry";
import {
  DEFAULT_HTTP_HOST,
  handleMetricsRequest,
  httpServer,
  prometheusTextfile,
  stdoutJson,
} from "./sinks";

// Captured before any mock.module call so the afterEach below can reinstall
// the real module. (`mock.restore()` does NOT undo `mock.module`, and Bun
// shares one module registry across all test files, in nondeterministic
// order — only re-mocking the real module prevents cross-file leaks.)
const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");

/** Minimal ServerResponse stand-in capturing what the handler wrote. */
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    body: undefined as string | undefined,
    ended: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    end(chunk?: string) {
      this.body = chunk;
      this.ended = true;
    },
    get headers() {
      return headers;
    },
  };
}

describe("httpServer bind address", () => {
  test("defaults to loopback (127.0.0.1) when no host is given", async () => {
    const sink = await httpServer(new Registry(), 0);
    try {
      expect(DEFAULT_HTTP_HOST).toBe("127.0.0.1");
      expect(sink.host).toBe("127.0.0.1");
    } finally {
      await sink.shutdown();
    }
  });

  test("binds all interfaces only when 0.0.0.0 is explicitly requested", async () => {
    const sink = await httpServer(new Registry(), 0, "0.0.0.0");
    try {
      expect(sink.host).toBe("0.0.0.0");
    } finally {
      await sink.shutdown();
    }
  });

  test("default loopback sink still serves /metrics (no functional regression)", async () => {
    const registry = new Registry();
    registry.turnsTotal.inc();
    const sink = await httpServer(registry, 0);
    try {
      const res = await fetch(`http://127.0.0.1:${sink.port}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("crewhaus_turns_total");
    } finally {
      await sink.shutdown();
    }
  });

  test("flush() is a no-op for the pull-based http sink (resolves, no throw)", async () => {
    const sink = await httpServer(new Registry(), 0);
    try {
      await expect(sink.flush()).resolves.toBeUndefined();
    } finally {
      await sink.shutdown();
    }
  });
});

describe("handleMetricsRequest routing", () => {
  test("GET /metrics → 200 with the Prometheus exposition body", () => {
    const registry = new Registry();
    registry.turnsTotal.inc();
    const res = fakeRes();
    handleMetricsRequest(registry, { url: "/metrics" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/plain; version=0.0.4");
    expect(res.body).toContain("crewhaus_turns_total");
    expect(res.ended).toBe(true);
  });

  test("missing req.url → 404 with empty body", () => {
    const res = fakeRes();
    handleMetricsRequest(new Registry(), { url: undefined }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });

  test("any other path → 404 with empty body", () => {
    const res = fakeRes();
    handleMetricsRequest(new Registry(), { url: "/healthz" }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBeUndefined();
    expect(res.ended).toBe(true);
  });
});

describe("stdoutJson sink", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);

  afterEach(() => {
    // Restore the real stdout writer so no mock leaks into other tests.
    process.stdout.write = originalWrite;
  });

  test("flush() with an injected writer emits the JSON snapshot exactly once", async () => {
    const registry = new Registry();
    registry.turnsTotal.inc();
    const chunks: string[] = [];
    const sink = stdoutJson(registry, { write: (c) => chunks.push(c) });

    await sink.flush();
    // Second flush is a no-op — the snapshot is buffered + written once.
    await sink.flush();
    await expect(sink.shutdown()).resolves.toBeUndefined();

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0] ?? "{}");
    expect(parsed.counters["crewhaus_turns_total"][0].value).toBe(1);
  });

  test("default writer falls back to process.stdout.write (stubbed, no real output)", async () => {
    // No `write` option → exercises the `?? process.stdout.write` default arrow.
    const captured: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    const registry = new Registry();
    registry.turnsTotal.inc();
    const sink = stdoutJson(registry);
    await sink.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("crewhaus_turns_total");
  });
});

describe("prometheusTextfile sink", () => {
  afterEach(() => {
    // Reinstall the real node:fs/promises so the per-test writeFile stub
    // never leaks into later tests or sibling files.
    mock.module("node:fs/promises", () => realFsPromises);
  });

  test("flush() writes the registry's exposition to the given path (writeFile mocked)", async () => {
    const calls: Array<{ path: string; data: string; encoding: string }> = [];
    await mock.module("node:fs/promises", () => ({
      writeFile: async (path: string, data: string, encoding: string) => {
        calls.push({ path, data, encoding });
      },
    }));

    const registry = new Registry();
    registry.turnsTotal.inc();
    const sink = prometheusTextfile(registry, "/var/run/crewhaus/metrics.prom");

    await sink.flush();
    // shutdown is a documented no-op; call it to cover the branch + prove no throw.
    await expect(sink.shutdown()).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/var/run/crewhaus/metrics.prom");
    expect(calls[0]?.encoding).toBe("utf8");
    expect(calls[0]?.data).toContain("crewhaus_turns_total");
  });
});
