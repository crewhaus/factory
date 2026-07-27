import { afterEach, describe, expect, test } from "bun:test";
import type { Driver } from "@crewhaus/computer-use-driver";
import { NavigateError, _setDnsLookup, createNavigateTool } from "./index.js";

type GotoRecord = { calls: string[] };

function stubDriver(record: GotoRecord, opts: { gotoErr?: Error } = {}): Driver {
  return {
    backend: "chromium",
    async connect() {},
    async goto(url: string) {
      record.calls.push(url);
      if (opts.gotoErr) throw opts.gotoErr;
    },
    async screenshot() {
      return new Uint8Array(0);
    },
    async click() {},
    async type() {},
    async key() {},
    async scroll() {},
    async getViewport() {
      return { width: 800, height: 600, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
}

describe("createNavigateTool", () => {
  // A public IP literal skips DNS resolution, keeping these tests hermetic
  // while still passing the SSRF guard (it's a public, non-loopback address).
  const PUBLIC_URL = "https://93.184.216.34/";

  test("happy path: forwards url to driver.goto and returns a text confirmation", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });

    const result = await tool.execute({ url: PUBLIC_URL }, {});
    expect(record.calls).toEqual([PUBLIC_URL]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error("expected ToolResultContent array");
    expect(result).toHaveLength(1);
    const block = result[0];
    if (block?.type !== "text") throw new Error("expected text block");
    expect(block.text).toBe(`navigated to ${PUBLIC_URL}`);
  });

  test("schema rejects non-URL strings (and missing url)", () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    expect(() => tool.inputSchema.parse({ url: "not-a-url" })).toThrow();
    expect(() => tool.inputSchema.parse({})).toThrow();
  });

  test("driver.goto failure surfaces as NavigateError with the URL in the message", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({
      driver: stubDriver(record, { gotoErr: new Error("net::ERR_CONNECTION_REFUSED") }),
    });
    try {
      // Public IP literal passes the SSRF guard and reaches driver.goto.
      await tool.execute({ url: PUBLIC_URL }, {});
      throw new Error("expected NavigateError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NavigateError);
      expect((err as Error).message).toContain(PUBLIC_URL);
      expect((err as Error).message).toContain("net::ERR_CONNECTION_REFUSED");
    }
  });

  test("flag profile: default-allowed, external scope, classifier off", () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    // destructive: false → permission-engine allows in default mode.
    // Navigation is the agent's bootstrap; gating it behind alwaysAllow
    // would silently break every browser spec without explicit rules.
    expect(tool.destructive).toBe(false);
    expect(tool.readOnly).toBe(false);
    expect(tool.classifyOutput).toBe(false);
    expect(tool.scope).toBe("external");
    expect(tool.name).toBe("Navigate");
  });
});

// SECURITY: the model picks the navigation URL and is prompt-injectable, so
// an attacker who controls any untrusted input could steer it to file://,
// cloud metadata, or a loopback/private host and read the result back via
// Screenshot. The guard must run before driver.goto.
describe("Navigate SSRF guard", () => {
  afterEach(() => _setDnsLookup(undefined));

  const expectBlocked = async (url: string) => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    let threw: unknown;
    try {
      await tool.execute({ url }, {});
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(NavigateError);
    // The browser must never have been touched.
    expect(record.calls).toEqual([]);
  };

  test.each([
    ["file scheme", "file:///etc/passwd"],
    ["gopher scheme", "gopher://127.0.0.1:6379/"],
    ["data scheme", "data:text/html,<h1>x</h1>"],
    ["loopback IPv4", "http://127.0.0.1/"],
    ["loopback name", "http://localhost:8080/admin"],
    ["AWS/GCP metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["RFC1918 10.x", "http://10.0.0.5/"],
    ["RFC1918 192.168", "http://192.168.1.1/"],
    ["RFC1918 172.16", "http://172.16.0.1/"],
    ["CGNAT 100.64", "http://100.64.0.1/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/"],
    ["octal-encoded loopback", "http://0177.0.0.1/"],
    ["integer-encoded loopback", "http://2130706433/"],
    ["mDNS .local", "http://printer.local/"],
  ])("blocks %s", async (_label, url) => {
    await expectBlocked(url);
  });

  test("blocks a public hostname that resolves to a private IP (DNS rebinding at check time)", async () => {
    _setDnsLookup(async () => ({ address: "127.0.0.1", family: 4 }));
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    await expect(
      tool.execute({ url: "http://totally-innocent.example/" }, {}),
    ).rejects.toBeInstanceOf(NavigateError);
    expect(record.calls).toEqual([]);
  });

  test("allows a public hostname that resolves to a public IP", async () => {
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    await tool.execute({ url: "http://example.com/" }, {});
    expect(record.calls).toEqual(["http://example.com/"]);
  });

  test("allows a public IP literal without any DNS lookup", async () => {
    // If DNS were consulted for an IP literal this would throw.
    _setDnsLookup(async () => {
      throw new Error("DNS must not be called for an IP literal");
    });
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    await tool.execute({ url: "https://93.184.216.34/" }, {});
    expect(record.calls).toEqual(["https://93.184.216.34/"]);
  });
});

/**
 * SECURITY — `driver.allowPrivateTargets` (spec-level, default false) is the
 * only way to reach a private target, and it waives the private-range checks
 * ONLY. Everything else about the guard survives it. These tests pin that
 * boundary, because the difference between "waives loopback" and "waives the
 * guard" is the difference between a testable fixture page and an SSRF hole.
 */
describe("Navigate SSRF guard — allowPrivateTargets opt-in", () => {
  test("without the opt-in, loopback is still refused (the default is unchanged)", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record) });
    await expect(tool.execute({ url: "http://127.0.0.1:8080/" }, {})).rejects.toThrow(
      /private\/loopback IP/,
    );
    expect(record.calls).toEqual([]);
  });

  test("with the opt-in, a loopback fixture page is reachable", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record), allowPrivateTargets: true });
    await tool.execute({ url: "http://127.0.0.1:8080/" }, {});
    expect(record.calls).toEqual(["http://127.0.0.1:8080/"]);
  });

  test("the opt-in does NOT waive the scheme allowlist", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record), allowPrivateTargets: true });
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "chrome://settings"]) {
      await expect(tool.execute({ url }, {})).rejects.toThrow(/only http\/https is allowed/);
    }
    expect(record.calls).toEqual([]);
  });

  test("the opt-in does NOT waive the absolute-URL check", async () => {
    const record: GotoRecord = { calls: [] };
    const tool = createNavigateTool({ driver: stubDriver(record), allowPrivateTargets: true });
    await expect(tool.execute({ url: "not a url" }, {})).rejects.toThrow();
    expect(record.calls).toEqual([]);
  });

  test("cloud metadata is reachable ONLY under the explicit opt-in", async () => {
    // 169.254.169.254 is the canonical SSRF prize. It stays blocked by
    // default; an opted-in spec is one whose operator has accepted that its
    // whole job is a private target, so it is reachable there by design.
    const blocked = createNavigateTool({ driver: stubDriver({ calls: [] }) });
    await expect(blocked.execute({ url: "http://169.254.169.254/" }, {})).rejects.toThrow(
      /private\/loopback IP/,
    );
    const record: GotoRecord = { calls: [] };
    const opted = createNavigateTool({ driver: stubDriver(record), allowPrivateTargets: true });
    await opted.execute({ url: "http://169.254.169.254/" }, {});
    expect(record.calls).toEqual(["http://169.254.169.254/"]);
  });
});
