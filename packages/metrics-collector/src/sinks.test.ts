/**
 * Sink unit tests. The HTTP sink serves an **unauthenticated** `/metrics`
 * endpoint, so its bind address is security-relevant: it must default to
 * loopback and only listen on a wider interface when explicitly asked to.
 */
import { describe, expect, test } from "bun:test";
import { Registry } from "./registry";
import { DEFAULT_HTTP_HOST, httpServer } from "./sinks";

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
});
