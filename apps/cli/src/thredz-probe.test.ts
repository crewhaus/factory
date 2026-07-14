/**
 * v0.3.0 Goal 3 (design §4.4) — `doctor --probe`'s thredz check: target
 * extraction from the cwd spec, the wiki_stats round-trip (driven end-to-end
 * against a minimal stdio stub honoring the thredz-mcp v0.2.0 wire contract),
 * and the classified failure rows.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeThredz, thredzProbeTarget, thredzProbeToCheck } from "./thredz-probe";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "thredz-probe-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const THREDZ_SPEC = `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
thredz: true
`;

const PLAIN_SPEC = `
name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: be helpful
`;

describe("thredzProbeTarget", () => {
  test("returns the synthesized server config for a thredz spec", () => {
    const target = thredzProbeTarget(THREDZ_SPEC);
    expect(target?.transport).toBe("stdio");
    if (target?.transport !== "stdio") throw new Error("expected stdio");
    expect(target.command).toBe("npx");
    expect(target.env?.["THREDZ_API_KEY"]).toEqual({ kind: "env", name: "THREDZ_API_KEY" });
  });

  test("returns undefined without a thredz block, and on unparseable specs", () => {
    expect(thredzProbeTarget(PLAIN_SPEC)).toBeUndefined();
    expect(thredzProbeTarget("not: [valid")).toBeUndefined();
  });
});

/**
 * A minimal newline-delimited JSON-RPC stdio server honoring the thredz-mcp
 * v0.2.0 wire contract for the probe's needs (initialize / tools/list /
 * tools/call wiki_stats). THREDZ_STUB_MODE picks the wiki_stats behavior.
 */
const STUB_SOURCE = `
const mode = process.env.THREDZ_STUB_MODE ?? "ok";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const DISABLED = 'wiki_stats failed (HTTP 403) — this Thredz API key is disabled — usually a lapsed subscription. Fix billing at https://thredz.crewhaus.ai (Account → Billing); the agent keeps running, but Thredz-backed memory is unavailable until the key is re-enabled:\\n{"error":"API key is disabled"}';
const QUOTA = 'wiki_stats failed (HTTP 402):\\n{"code":"quota_exceeded"}';
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "thredz", version: "0.2.0" } } });
    } else if (method === "notifications/initialized") {
      // notification — no reply
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [{ name: "wiki_stats", description: "corpus health", inputSchema: { type: "object", properties: {}, required: [] } }] } });
    } else if (method === "tools/call") {
      if (mode === "disabled") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: DISABLED }], isError: true } });
      } else if (mode === "quota") {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: QUOTA }], isError: true } });
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"articles":12,"tags":4}' }], isError: false } });
      }
    } else if (id !== undefined && id !== null) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
    }
  }
});
`;

function stubConfig(mode: string, stubPath: string) {
  return {
    transport: "stdio" as const,
    command: "bun",
    args: [stubPath],
    env: {
      THREDZ_API_KEY: { kind: "env" as const, name: "THREDZ_API_KEY" },
      THREDZ_STUB_MODE: { kind: "literal" as const, value: mode },
    },
  };
}

describe("probeThredz — live wiki_stats round-trip (stdio stub)", () => {
  test("a healthy server passes with the round-trip duration", async () => {
    const stubPath = join(tmp, "stub.mjs");
    writeFileSync(stubPath, STUB_SOURCE);
    const result = await probeThredz(stubConfig("ok", stubPath), {
      env: { THREDZ_API_KEY: "tk_test" },
    });
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/^wiki_stats ok \(\d+ms\)$/);
    expect(thredzProbeToCheck(result).pass).toBe(true);
  }, 15000);

  test("a disabled key (billing lapse) fails classified as thredz_billing", async () => {
    const stubPath = join(tmp, "stub.mjs");
    writeFileSync(stubPath, STUB_SOURCE);
    const result = await probeThredz(stubConfig("disabled", stubPath), {
      env: { THREDZ_API_KEY: "tk_test" },
    });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("thredz_billing");
    const check = thredzProbeToCheck(result);
    expect(check.pass).toBe(false);
    expect(check.reason).toContain("thredz_billing");
  }, 15000);

  test("a plan cap fails classified as thredz_quota", async () => {
    const stubPath = join(tmp, "stub.mjs");
    writeFileSync(stubPath, STUB_SOURCE);
    const result = await probeThredz(stubConfig("quota", stubPath), {
      env: { THREDZ_API_KEY: "tk_test" },
    });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("thredz_quota");
  }, 15000);

  test("a missing THREDZ_API_KEY is a config failure NAMING the variable — no server is spawned", async () => {
    const result = await probeThredz(stubConfig("ok", "/never-spawned.mjs"), { env: {} });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("config");
    expect(result.detail).toContain("THREDZ_API_KEY");
  });

  test("a server that cannot boot fails classified as mcp_boot", async () => {
    const result = await probeThredz(
      {
        transport: "stdio",
        command: "/nonexistent-crewhaus-thredz-probe-binary",
        args: [],
      },
      { env: {} },
    );
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("mcp_boot");
  }, 15000);

  test("the injected call seam bypasses the spawn (unit path)", async () => {
    const result = await probeThredz(
      { transport: "stdio", command: "unused", args: [] },
      { call: async () => ({ content: '{"articles":1}', isError: false }), now: () => 0 },
    );
    expect(result).toEqual({ pass: true, detail: "wiki_stats ok (0ms)" });
  });
});
