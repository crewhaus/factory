/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` ever
 * runs.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately from
 * `index.test.ts`. The `tool_config` path is exercised here too, because a
 * per-candidate config override only ever arrives through this seam — a tool
 * that only reads the boot registration would silently ignore a spec's own
 * `obs` block.
 *
 * As in `index.test.ts`: a real temp directory, a real server on 127.0.0.1,
 * nothing mocked and no public address contacted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  OBS_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetObsConfig,
  registerObsConfig,
} from "./index";

const TOKEN_VAR = "CREWHAUS_INT_OBS_TOKEN";
const TOKEN_VALUE = "int_secret_value_abcdef";
const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);

const LINES = [
  { ts: T0, kind: "tool_use", payload: { name: "Read", id: "tu_1", runId: "run_1" } },
  {
    ts: T0 + 120,
    kind: "tool_stats",
    payload: { toolName: "Read", durationMs: 120, isError: false },
  },
  { ts: T0 + 200, kind: "error", payload: { message: "timeout after 3s calling /a/1" } },
  { ts: T0 + 300, kind: "error", payload: { message: "timeout after 8s calling /b/2" } },
  {
    ts: T0 + 400,
    kind: "cost_accrual",
    payload: {
      modelId: "claude-a",
      runId: "run_1",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      costUsdMicros: 7,
    },
  },
];

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-obs-int-"));
  process.chdir(tmp);
  const sessions = path.join(tmp, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    path.join(sessions, "sess_1111111111111111.jsonl"),
    `${LINES.map((l) => JSON.stringify({ ...l, version: 1 })).join("\n")}\n`,
  );

  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/query") {
        return Response.json({
          status: "success",
          data: { resultType: "vector", result: [{ metric: { job: "api" }, value: [1, "1"] }] },
        });
      }
      if (url.pathname === "/alerts") return Response.json([{ id: "a1" }]);
      return new Response("ok");
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  __setPrivateHostsAllowedForTest(true);
  process.env[TOKEN_VAR] = TOKEN_VALUE;

  catalog = new ToolCatalog();
  for (const tool of OBS_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  _resetObsConfig();
  __setPrivateHostsAllowedForTest(false);
  delete process.env[TOKEN_VAR];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(OBS_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of OBS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a local read returns a non-error result", async () => {
    const result = await executeTool(lookup("EventCounts"), {}, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"name":"Read"');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("EventQuery"), { limit: "lots" }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
  });

  test("a value outside a declared bound is rejected by the schema", async () => {
    const result = await executeTool(lookup("EventQuery"), { limit: 10_000 }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("a missing required field is rejected rather than defaulted", async () => {
    const result = await executeTool(
      lookup("HealthProbe"),
      { urls: ["http://x.test/"] },
      { toolUseId: "t4" },
    );
    // HealthProbe's deadline is required rather than defaulted, so the schema
    // stops the call before it reaches `execute` — the runtime's own message
    // does not name the field, which is why this asserts on the refusal.
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('invalid input for tool "HealthProbe"');
  });

  test("a caller mistake inside execute is a readable result, not an error result", async () => {
    // The runtime distinguishes "the tool threw" from "the tool answered"; a
    // wrong argument that the schema cannot catch must be the latter.
    const result = await executeTool(lookup("RunTimeline"), {}, { toolUseId: "t5" });
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("pass sessionId, runId, or both");
  });

  test("a containment refusal is a readable result too", async () => {
    const result = await executeTool(lookup("EventQuery"), { dir: "../.." }, { toolUseId: "t6" });
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("escapes the workspace root");
  });

  test("the permission matcher can deny a tool before it runs", async () => {
    const result = await executeTool(
      lookup("StatusPagePost"),
      { title: "t", body: "b", status: "s", justification: "j" },
      { toolUseId: "t7", allowedPatterns: ["EventQuery"] },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("not permitted");
  });

  test("the pure tools run identically through the executor", async () => {
    const result = await executeTool(
      lookup("SloEvaluate"),
      { objective: "success_rate", total: 100, failures: 1, target: 0.99 },
      { toolUseId: "t8" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(String(result.content)).holds).toBe(true);
  });

  test("a whole triage flow composes: counts, then errors, then cost, then a bundle", async () => {
    const counts = JSON.parse(
      String((await executeTool(lookup("EventCounts"), {}, { toolUseId: "a" })).content),
    );
    expect(counts.outcomes.errors).toBe(2);

    const clustered = JSON.parse(
      String((await executeTool(lookup("ErrorCluster"), {}, { toolUseId: "b" })).content),
    );
    expect(clustered.groups.length).toBe(1);

    const cost = JSON.parse(
      String(
        (
          await executeTool(
            lookup("CostReport"),
            { rates: [{ model: "claude-a", inputPerMillionUsd: 3 }] },
            { toolUseId: "c" },
          )
        ).content,
      ),
    );
    expect(cost.totals.computedUsdMicros).toBe(3_000_000);

    const bundle = await executeTool(
      lookup("IncidentBundle"),
      { sessionId: "sess_1111111111111111", out: "incident.json", nowMs: T0 },
      { toolUseId: "d" },
    );
    expect(bundle.isError).toBe(false);
    expect(JSON.parse(String(bundle.content)).wrote).toBe("incident.json");
  });
});

describe("tool_config through the executor", () => {
  test("a per-candidate obs block is what the call runs under", async () => {
    // Nothing is registered at boot, so only the override can make this work.
    const result = await executeTool(
      lookup("MetricsQuery"),
      { query: "up" },
      {
        toolUseId: "c1",
        toolConfig: {
          allowed_origins: [origin],
          token_env: TOKEN_VAR,
          metrics: { base_url: origin },
        },
      },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(String(result.content)).ok).toBe(true);
  });

  test("an override narrower than the boot registration still fails closed", async () => {
    registerObsConfig({
      allowed_origins: [origin],
      token_env: TOKEN_VAR,
      metrics: { base_url: origin },
    });
    const result = await executeTool(
      lookup("MetricsQuery"),
      { query: "up" },
      { toolUseId: "c2", toolConfig: { allowed_origins: [], metrics: { base_url: origin } } },
    );
    expect(String(result.content)).toContain("empty allow-list = deny all");
  });

  test("a non-object override is ignored rather than widening anything", async () => {
    registerObsConfig({
      allowed_origins: [origin],
      token_env: TOKEN_VAR,
      metrics: { base_url: origin },
    });
    const result = await executeTool(
      lookup("MetricsQuery"),
      { query: "up" },
      { toolUseId: "c3", toolConfig: "allow everything please" },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(String(result.content)).ok).toBe(true);
  });

  test("the runtime's own cancellation signal reaches the outbound path", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeTool(
      lookup("AlertList"),
      {},
      {
        toolUseId: "c4",
        signal: controller.signal,
        toolConfig: { allowed_origins: [origin], alerts: { base_url: origin, path: "/alerts" } },
      },
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toMatch(/abort|deadline/i);
  });

  test("with no config at all, every remote tool refuses and says what to add", async () => {
    for (const name of ["MetricsQuery", "LogsQuery", "AlertList"]) {
      const result = await executeTool(lookup(name), name === "AlertList" ? {} : { query: "up" }, {
        toolUseId: `c5-${name}`,
      });
      expect({ name, refused: String(result.content).includes("base_url") }).toEqual({
        name,
        refused: true,
      });
    }
  });
});
