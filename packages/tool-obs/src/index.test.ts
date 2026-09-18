/**
 * The tools themselves, against a real filesystem and real servers.
 *
 * Every local test writes JSONL into a throwaway temp directory and chdirs
 * into it, so the containment boundary under test is the real one and nothing
 * is ever written inside the repository. Every network test stands up an
 * actual `Bun.serve` on 127.0.0.1 with an ephemeral port and drives the tools
 * at it — a stubbed `fetch` would prove nothing about whether a redirect chain
 * really drops the token, whether a deadline really fires, or whether a byte
 * cap really cancels a stream, which is most of what this package has to get
 * right. No public address is ever contacted.
 *
 * Reaching 127.0.0.1 means lifting the loopback refusal, which is what
 * `__setPrivateHostsAllowedForTest` is for: test-only, off by default, reset
 * after every test. The refusal itself is proved with the flag in its
 * production position.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  OBS_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetObsConfig,
  _setDnsLookup,
  alertAck,
  alertList,
  budgetCheck,
  costReport,
  errorCluster,
  eventCounts,
  eventQuery,
  healthProbe,
  incidentBundle,
  logsQuery,
  metricsQuery,
  registerObsConfig,
  runTimeline,
  sloEvaluate,
  statusPagePost,
  toolCallStats,
} from "./index";

const TOKEN_VAR = "CREWHAUS_TEST_OBS_TOKEN";
const TOKEN_VALUE = "obs_secret_value_9f8e7d6c";

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: RegisteredTool, input: unknown, ctx?: unknown): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: the context shape is the runtime's, not ours to narrow here.
  const out = await tool.execute(input, ctx as any);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type Line = { kind: string; ts?: number; payload: unknown };

function jsonl(lines: readonly Line[]): string {
  return `${lines.map((l) => JSON.stringify({ ...(l.ts !== undefined ? { ts: l.ts } : {}), version: 1, kind: l.kind, payload: l.payload })).join("\n")}\n`;
}

const T0 = Date.UTC(2026, 8, 17, 9, 0, 0);

/** A session that ran two tools, failed twice, and accrued cost. */
const SESSION_A: Line[] = [
  { kind: "user_message", ts: T0, payload: { text: "go" } },
  { kind: "tool_use", ts: T0 + 100, payload: { name: "Read", id: "tu_1", runId: "run_1" } },
  { kind: "tool_result", ts: T0 + 400, payload: { toolUseId: "tu_1", isError: false } },
  {
    kind: "tool_stats",
    ts: T0 + 400,
    payload: { toolName: "Read", durationMs: 300, isError: false },
  },
  { kind: "tool_use", ts: T0 + 500, payload: { name: "Fetch", id: "tu_2", runId: "run_1" } },
  { kind: "tool_result", ts: T0 + 2500, payload: { toolUseId: "tu_2", isError: true } },
  {
    kind: "tool_stats",
    ts: T0 + 2500,
    payload: { toolName: "Fetch", durationMs: 2000, isError: true },
  },
  {
    kind: "error",
    ts: T0 + 2600,
    payload: { message: "timeout after 2s calling /api/v1/items/42" },
  },
  {
    kind: "error",
    ts: T0 + 2700,
    payload: { message: "timeout after 9s calling /api/v1/items/88" },
  },
  {
    kind: "cost_accrual",
    ts: T0 + 3000,
    payload: {
      modelId: "claude-a",
      runId: "run_1",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      costUsdMicros: 4242,
      specName: "triage-bot",
    },
  },
  {
    kind: "run_failed",
    ts: T0 + 3100,
    payload: { class: "tool", message: "gave up", runId: "run_1" },
  },
];

/** A second, quieter session, to prove directory sweeps and sorting. */
const SESSION_B: Line[] = [
  { kind: "tool_use", ts: T0 + 10_000, payload: { name: "Read", id: "tu_9", runId: "run_2" } },
  {
    kind: "tool_stats",
    ts: T0 + 10_050,
    payload: { toolName: "Read", durationMs: 50, isError: false },
  },
];

const originalCwd = process.cwd();
let tmp: string;
let sessions: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-obs-"));
  process.chdir(tmp);
  sessions = path.join(tmp, ".crewhaus", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, "sess_aaaaaaaaaaaaaaaa.jsonl"), jsonl(SESSION_A));
  writeFileSync(path.join(sessions, "sess_bbbbbbbbbbbbbbbb.jsonl"), jsonl(SESSION_B));
  process.env[TOKEN_VAR] = TOKEN_VALUE;
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  _resetObsConfig();
  __setPrivateHostsAllowedForTest(false);
  delete process.env[TOKEN_VAR];
});

// ---------------------------------------------------------------------------
// the package's own contract
// ---------------------------------------------------------------------------

describe("package contract", () => {
  test("every tool is exported once in OBS_TOOLS, and the array is frozen", () => {
    expect(OBS_TOOLS.length).toBe(15);
    expect(Object.isFrozen(OBS_TOOLS)).toBe(true);
    expect(new Set(OBS_TOOLS.map((t) => t.name)).size).toBe(OBS_TOOLS.length);
  });

  test("names are PascalCase", () => {
    for (const tool of OBS_TOOLS) {
      expect({ name: tool.name, ok: /^[A-Z][A-Za-z0-9]*$/.test(tool.name) }).toEqual({
        name: tool.name,
        ok: true,
      });
    }
  });

  test("every description's second sentence tells the caller when to use it", () => {
    for (const tool of OBS_TOOLS) {
      const second = tool.description.split(/(?<=\.)\s+/)[1] ?? "";
      expect({ name: tool.name, second: second.slice(0, 4) }).toEqual({
        name: tool.name,
        second: "Use ",
      });
    }
  });

  test("the scope audit is clean: everything that crosses a boundary declares it", () => {
    expect(auditToolScopes([...OBS_TOOLS])).toEqual([]);
  });

  test("the local half crosses no boundary at all", () => {
    const local = [
      "EventQuery",
      "EventCounts",
      "ToolCallStats",
      "ErrorCluster",
      "RunTimeline",
      "CostReport",
      "BudgetCheck",
      "SloEvaluate",
      "IncidentBundle",
    ];
    for (const name of local) {
      const tool = OBS_TOOLS.find((t) => t.name === name) as RegisteredTool;
      expect({ name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name,
        scope: "internal",
        io: undefined,
      });
    }
  });

  test("the remote half is external and declares the network capability", () => {
    const remote = [
      "MetricsQuery",
      "LogsQuery",
      "AlertList",
      "AlertAck",
      "StatusPagePost",
      "HealthProbe",
    ];
    for (const name of remote) {
      const tool = OBS_TOOLS.find((t) => t.name === name) as RegisteredTool;
      expect({ name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name,
        scope: "external",
        io: "network",
      });
    }
  });

  test("only the three tools that change something outside are destructive", () => {
    expect(
      OBS_TOOLS.filter((t) => t.destructive)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["AlertAck", "IncidentBundle", "StatusPagePost"]);
  });

  test("the two tools whose output a human reads elsewhere are justification-gated", () => {
    expect(
      OBS_TOOLS.filter((t) => t.requireJustification)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["AlertAck", "StatusPagePost"]);
  });

  test("a read-only tool is never also destructive", () => {
    for (const tool of OBS_TOOLS) {
      expect({ name: tool.name, both: tool.readOnly && tool.destructive }).toEqual({
        name: tool.name,
        both: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// local: reading
// ---------------------------------------------------------------------------

describe("EventQuery", () => {
  test("sweeps the whole directory in sorted filename order", async () => {
    const result = await run(eventQuery, { limit: 500 });
    expect(result.files).toBe(2);
    expect(result.results[0].session).toBe("sess_aaaaaaaaaaaaaaaa");
    expect(result.results.at(-1).session).toBe("sess_bbbbbbbbbbbbbbbb");
  });

  test("filters by kind, run and a field predicate", async () => {
    expect((await run(eventQuery, { kinds: ["error"] })).matched).toBe(2);
    expect((await run(eventQuery, { runId: "run_2" })).matched).toBe(1);
    const predicate = await run(eventQuery, {
      kinds: ["tool_stats"],
      where: { path: "durationMs", op: "gte", value: 300 },
    });
    expect(predicate.matched).toBe(2);
  });

  test("a cursor walks the whole log exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page: {
        results: { session: string; line: number }[];
        nextCursor?: string;
        remainingFromCursor: number;
      } = await run(eventQuery, { limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      for (const e of page.results) seen.push(`${e.session}#${e.line}`);
      if (page.remainingFromCursor <= page.results.length) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(SESSION_A.length + SESSION_B.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the same query twice returns the same bytes", async () => {
    const a = await eventQuery.execute({ limit: 100 });
    const b = await eventQuery.execute({ limit: 100 });
    expect(a).toBe(b);
  });

  test("a path escaping the workspace is refused", async () => {
    const result = await run(eventQuery, { dir: "../outside" });
    expect(result).toContain("escapes the workspace root");
  });

  test("an absolute path outside the workspace is refused", async () => {
    expect(await run(eventQuery, { dir: "/etc" })).toContain("escapes the workspace root");
  });

  test("a sessionId that is really a path is refused before any syscall", async () => {
    const result = await run(eventQuery, { sessionId: "../../etc/passwd" });
    expect(result).toContain("looks like a path");
  });

  test("a missing directory says so rather than returning an empty success", async () => {
    expect(await run(eventQuery, { dir: "nope" })).toContain("does not exist");
  });

  test("a symlink inside the workspace pointing outside it is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-obs-outside-"));
    try {
      writeFileSync(path.join(outside, "x.jsonl"), jsonl(SESSION_B));
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outside, path.join(tmp, "link"));
      expect(await run(eventQuery, { dir: "link" })).toContain("escapes the workspace root");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a truncated last line is reported, not fatal", async () => {
    writeFileSync(path.join(sessions, "sess_cccccccccccccccc.jsonl"), '{"ts":1,"kind":"err');
    const result = await run(eventQuery, { limit: 500 });
    expect(result.malformedLines).toBe(1);
    expect(result.files).toBe(3);
  });

  test("the payload budget caps what one event can spend of a context window", async () => {
    const result = await run(eventQuery, { kinds: ["cost_accrual"], maxPayloadChars: 50 });
    expect(result.results[0].payload.length).toBe(51);
    expect(result.results[0].payloadTruncated).toBe(true);
  });
});

describe("EventCounts", () => {
  test("answers what the harness did in one call", async () => {
    const result = await run(eventCounts, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.byTool).toEqual([
      { name: "Fetch", calls: 1, errors: 1, totalDurationMs: 2000 },
      { name: "Read", calls: 1, errors: 0, totalDurationMs: 300 },
    ]);
    expect(result.outcomes.runsFailed).toBe(1);
    expect(result.outcomes.errors).toBe(2);
  });

  test("a session id with or without the .jsonl suffix is the same session", async () => {
    const a = await eventCounts.execute({ sessionId: "sess_aaaaaaaaaaaaaaaa" });
    const b = await eventCounts.execute({ sessionId: "sess_aaaaaaaaaaaaaaaa.jsonl" });
    expect(a).toBe(b);
  });

  test("a named session that does not exist is a refusal, not an empty report", async () => {
    expect(await run(eventCounts, { sessionId: "sess_nope" })).toContain("does not exist");
  });
});

describe("ToolCallStats", () => {
  test("the failing tool sorts first, with the percentile convention named", async () => {
    const result = await run(toolCallStats, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.percentileMethod).toBe("nearest-rank");
    expect(result.tools[0].name).toBe("Fetch");
    expect(result.tools[0]).toMatchObject({ errors: 1, p95Ms: 2000, meanMs: 2000 });
  });

  test("a log with no stats mirror says latency is unavailable rather than estimating", async () => {
    writeFileSync(
      path.join(sessions, "sess_aaaaaaaaaaaaaaaa.jsonl"),
      jsonl(SESSION_A.filter((l) => l.kind !== "tool_stats")),
    );
    const result = await run(toolCallStats, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.latencyUnavailable).toBe(true);
    expect(result.tools.find((t: { name: string }) => t.name === "Fetch").errors).toBe(1);
  });
});

describe("ErrorCluster", () => {
  test("two timeouts differing only in a number and a path become one group", async () => {
    const result = await run(errorCluster, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.errors).toBe(3);
    const timeouts = result.groups.find((g: { count: number }) => g.count === 2);
    expect(timeouts.example).toBe("timeout after 2s calling /api/v1/items/42");
    expect(timeouts.fingerprint).not.toContain("42");
  });

  test("groups beyond the cap are counted rather than dropped", async () => {
    const result = await run(errorCluster, { sessionId: "sess_aaaaaaaaaaaaaaaa", maxGroups: 1 });
    expect(result.groups.length).toBe(1);
    expect(result.groupsOmitted).toBe(1);
  });
});

describe("RunTimeline", () => {
  test("refuses to draw a timeline across every session, which would mean nothing", async () => {
    expect(await run(runTimeline, {})).toContain("pass sessionId, runId, or both");
  });

  test("gaps and measured durations come from the events, not a clock", async () => {
    const result = await run(runTimeline, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.startTs).toBe(T0);
    expect(result.elapsedMs).toBe(3100);
    const fetchStats = result.entries.find(
      (e: { kind: string; label?: string }) => e.kind === "tool_stats" && e.label === "Fetch",
    );
    expect(fetchStats.durationMs).toBe(2000);
    expect(fetchStats.gapMs).toBe(0);
  });

  test("a runId that matches nothing explains why rather than returning an empty draw", async () => {
    const result = await run(runTimeline, {
      sessionId: "sess_aaaaaaaaaaaaaaaa",
      runId: "run_absent",
    });
    expect(result.matched).toBe(0);
    expect(result.note).toContain("only matches kinds whose payload records one");
  });
});

describe("CostReport", () => {
  test("recorded and recomputed costs come back side by side", async () => {
    const result = await run(costReport, {
      sessionId: "sess_aaaaaaaaaaaaaaaa",
      rates: [{ model: "claude-a", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }],
    });
    expect(result.totals.recordedUsdMicros).toBe(4242);
    expect(result.totals.computedUsdMicros).toBe(3_000_000 + 3_000_000);
    expect(result.byRun[0].key).toBe("run_1");
  });

  test("with no rate table the models that would need one are named", async () => {
    const result = await run(costReport, { sessionId: "sess_aaaaaaaaaaaaaaaa" });
    expect(result.modelsWithoutRate).toEqual(["claude-a"]);
    expect(result.totals.computedUsdMicros).toBe(0);
  });

  test("a harness that ran without cost tracking says so instead of reporting zero spend", async () => {
    const result = await run(costReport, { sessionId: "sess_bbbbbbbbbbbbbbbb" });
    expect(result.accruals).toBe(0);
    expect(result.note).toContain("ran without cost tracking");
  });
});

// ---------------------------------------------------------------------------
// local: pure
// ---------------------------------------------------------------------------

describe("BudgetCheck and SloEvaluate", () => {
  test("BudgetCheck names the highest crossed threshold", async () => {
    const result = await run(budgetCheck, {
      spentUsdMicros: 900_000,
      budgetUsdMicros: 1_000_000,
      thresholds: [
        { percent: 50, label: "notice" },
        { percent: 80, label: "warn" },
      ],
    });
    expect(result.highestCrossed.label).toBe("warn");
    expect(result.remainingUsdMicros).toBe(100_000);
  });

  test("BudgetCheck reads no clock: the same input is the same output", async () => {
    const a = await budgetCheck.execute({ spentUsdMicros: 1, budgetUsdMicros: 2 });
    const b = await budgetCheck.execute({ spentUsdMicros: 1, budgetUsdMicros: 2 });
    expect(a).toBe(b);
  });

  test("SloEvaluate reports the remaining failure allowance as a number", async () => {
    const result = await run(sloEvaluate, {
      objective: "error_budget",
      total: 1000,
      failures: 7,
      target: 0.99,
    });
    expect(result.errorBudgetRemaining).toBe(3);
  });

  test("SloEvaluate returns a readable string for a caller mistake", async () => {
    expect(await run(sloEvaluate, { objective: "success_rate", total: 10, target: 0.9 })).toContain(
      'needs "failures"',
    );
  });
});

// ---------------------------------------------------------------------------
// local: writing
// ---------------------------------------------------------------------------

describe("IncidentBundle", () => {
  test("writes a portable JSON document a human can be handed", async () => {
    const result = await run(incidentBundle, {
      sessionId: "sess_aaaaaaaaaaaaaaaa",
      out: "reports/incident.json",
    });
    expect(result.wrote).toBe("reports/incident.json");
    const bundle = JSON.parse(readFileSync(path.join(tmp, "reports", "incident.json"), "utf8"));
    expect(bundle.specName).toBe("triage-bot");
    expect(bundle.counts.outcomes.runsFailed).toBe(1);
    expect(bundle.errors.groups.length).toBeGreaterThan(0);
    expect(bundle.timeline.elapsedMs).toBe(3100);
    expect(bundle.failures[0].fingerprint).toBeDefined();
  });

  test("it records no time of its own unless the caller supplies one", async () => {
    await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "a.json" });
    expect(
      JSON.parse(readFileSync(path.join(tmp, "a.json"), "utf8")).generatedAtMs,
    ).toBeUndefined();
    await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "b.json", nowMs: 5 });
    expect(JSON.parse(readFileSync(path.join(tmp, "b.json"), "utf8")).generatedAtMs).toBe(5);
  });

  test("two bundles from the same log are byte-identical", async () => {
    await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "one.json" });
    await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "two.json" });
    expect(readFileSync(path.join(tmp, "one.json"), "utf8")).toBe(
      readFileSync(path.join(tmp, "two.json"), "utf8"),
    );
  });

  test("an existing file is never silently replaced", async () => {
    await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "x.json" });
    const second = await run(incidentBundle, { sessionId: "sess_aaaaaaaaaaaaaaaa", out: "x.json" });
    expect(second).toContain("already exists");
    const third = await run(incidentBundle, {
      sessionId: "sess_aaaaaaaaaaaaaaaa",
      out: "x.json",
      overwrite: true,
    });
    expect(third.wrote).toBe("x.json");
  });

  test("a destination outside the workspace is refused and nothing is written", async () => {
    const result = await run(incidentBundle, {
      sessionId: "sess_aaaaaaaaaaaaaaaa",
      out: "../escaped.json",
    });
    expect(result).toContain("escapes the workspace root");
    expect(existsSync(path.join(tmp, "..", "escaped.json"))).toBe(false);
  });

  test("it refuses to bundle every session in the directory", async () => {
    expect(await run(incidentBundle, { out: "x.json" })).toContain("not an incident report");
  });
});

// ---------------------------------------------------------------------------
// remote: the servers
// ---------------------------------------------------------------------------

type Server = ReturnType<typeof Bun.serve>;

const PROM_BODY = {
  status: "success",
  data: {
    resultType: "vector",
    result: [
      { metric: { __name__: "up", job: "api" }, value: [1758100000, "1"] },
      { metric: { __name__: "up", job: "web" }, value: [1758100000, "0"] },
    ],
  },
};

function startMain(seenAuth: string[]): Server {
  return Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      seenAuth.push(req.headers.get("authorization") ?? "<none>");
      if (url.pathname === "/api/v1/query" || url.pathname === "/api/v1/query_range") {
        const form = new URLSearchParams(await req.text());
        if (form.get("query") === "boom") {
          return new Response(JSON.stringify({ status: "error", error: "parse error" }), {
            status: 400,
          });
        }
        return Response.json(PROM_BODY);
      }
      if (url.pathname === "/loki/query") {
        return Response.json({
          data: {
            result: [
              { line: "second", at: url.searchParams.get("start") },
              { line: "first", at: url.searchParams.get("end") },
            ],
          },
        });
      }
      if (url.pathname === "/alerts") {
        return Response.json([
          { id: "a1", severity: "page", summary: "x".repeat(50) },
          { id: "a2", severity: "warn", summary: "ok" },
        ]);
      }
      if (url.pathname.startsWith("/alerts/") && url.pathname.endsWith("/ack")) {
        return Response.json({ acked: url.pathname.split("/")[2], body: await req.json() });
      }
      if (url.pathname === "/status/incidents") {
        return Response.json({ id: "inc_1", body: await req.json() }, { status: 201 });
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(3000);
        return new Response("late");
      }
      if (url.pathname === "/huge") {
        return new Response("z".repeat(2_000_000), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/notjson") return new Response("<html>nope</html>");
      if (url.pathname === "/down") return new Response("bad", { status: 503 });
      if (url.pathname === "/echo-token") {
        // The hostile case the redactor exists for: a platform that reflects
        // the credential straight back into the response body.
        return Response.json([{ sawAuthorization: req.headers.get("authorization") ?? "<none>" }]);
      }
      return new Response("ok");
    },
  });
}

let main: Server;
let other: Server;
let mainOrigin = "";
let otherOrigin = "";
let seenAuth: string[] = [];
let seenOtherAuth: string[] = [];

function startServers(): void {
  seenAuth = [];
  seenOtherAuth = [];
  main = startMain(seenAuth);
  mainOrigin = `http://127.0.0.1:${main.port}`;
  other = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      seenOtherAuth.push(req.headers.get("authorization") ?? "<none>");
      if (url.pathname === "/redirect-away") {
        return new Response(null, {
          status: 302,
          headers: { location: `${mainOrigin}/echo-token` },
        });
      }
      return Response.json({ from: "other", authorization: req.headers.get("authorization") });
    },
  });
  otherOrigin = `http://127.0.0.1:${other.port}`;
}

function stopServers(): void {
  main.stop(true);
  other.stop(true);
}

function baseConfig(): Record<string, unknown> {
  return {
    allowed_origins: [mainOrigin, otherOrigin],
    token_env: TOKEN_VAR,
    metrics: { base_url: mainOrigin },
    logs: {
      base_url: mainOrigin,
      path: "/loki/query",
      result_path: "data.result",
      params: { query: "q", start: "start", end: "end", limit: "limit", time_format: "ns" },
    },
    alerts: { base_url: mainOrigin, path: "/alerts" },
    alert_ack: { base_url: mainOrigin, path: "/alerts/{id}/ack" },
    status_page: { base_url: mainOrigin, path: "/status/incidents" },
  };
}

describe("remote tools", () => {
  beforeEach(() => {
    startServers();
    registerObsConfig(baseConfig());
    __setPrivateHostsAllowedForTest(true);
  });

  afterEach(() => {
    stopServers();
  });

  test("MetricsQuery returns sorted series with their labels", async () => {
    const result = await run(metricsQuery, { query: "up" });
    expect(result.ok).toBe(true);
    expect(result.series.map((s: { seriesKey: string }) => s.seriesKey)).toEqual([
      '{__name__="up",job="api"}',
      '{__name__="up",job="web"}',
    ]);
    expect(result.series[0].samples[0]).toEqual({ t: 1758100000, v: "1" });
  });

  test("MetricsQuery sends the expression in a form body, not the URL", async () => {
    const result = await run(metricsQuery, { query: 'up{customer="acme"}' });
    expect(result.ok).toBe(true);
    // The query never reaches the URL, so it never reaches a proxy access log.
    expect(JSON.stringify(result)).not.toContain("acme");
  });

  test("a range query without a step is refused with a reason", async () => {
    expect(await run(metricsQuery, { query: "up", type: "range", startSec: 1 })).toContain(
      "startSec, endSec and stepSec",
    );
  });

  test("a non-2xx answer is reported with its status rather than parsed as data", async () => {
    const result = await run(metricsQuery, { query: "boom" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  test("LogsQuery maps the spec's parameter names and time format", async () => {
    const result = await run(logsQuery, { query: "level=error", startMs: 5, endMs: 7, limit: 2 });
    expect(result.ok).toBe(true);
    // `ns` from the config: 5ms became 5000000ns.
    expect(result.records[0].at).toBe("5000000");
    expect(result.total).toBe(2);
  });

  test("LogsQuery projects only the named fields and cuts each to a budget", async () => {
    const result = await run(logsQuery, { query: "x", fields: ["line"], maxFieldChars: 20 });
    expect(Object.keys(result.records[0])).toEqual(["line"]);
  });

  test("AlertList returns a bounded page of alerts", async () => {
    const result = await run(alertList, { limit: 1, maxFieldChars: 10 });
    expect(result.alerts.length).toBe(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.alerts[0].summary.length).toBe(11);
  });

  test("AlertAck substitutes the id into the configured path", async () => {
    const result = await run(alertAck, {
      alertId: "a1",
      acknowledgedBy: "triage-bot",
      justification: "already handling it",
    });
    expect(result.ok).toBe(true);
    expect(result.acknowledged).toBe("a1");
    expect(result.response).toContain('"acked":"a1"');
  });

  test("StatusPagePost sends the update the customer will read", async () => {
    const result = await run(statusPagePost, {
      title: "Degraded API",
      body: "We are investigating.",
      status: "investigating",
      justification: "incident commander asked for it",
    });
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.status).toBe(201);
  });

  test("HealthProbe reports each endpoint with its status", async () => {
    const result = await run(healthProbe, {
      urls: [`${mainOrigin}/ok`, `${mainOrigin}/down`],
      deadlineMs: 5000,
    });
    expect(result.probed).toBe(2);
    expect(result.healthy).toBe(1);
    expect(result.unhealthy).toBe(1);
    expect(result.probes.every((p: { latencyMs: number }) => typeof p.latencyMs === "number")).toBe(
      true,
    );
  });

  test("HealthProbe carries the token to a configured surface and to nowhere else", async () => {
    // Both origins are allow-listed — that is the REACHABILITY list. Only one
    // of them is an obs surface, and only that one was what the token was
    // minted for. Probing the other must not hand its operator the credential.
    registerObsConfig({
      allowed_origins: [mainOrigin, otherOrigin],
      token_env: TOKEN_VAR,
      metrics: { base_url: mainOrigin },
    });
    const result = await run(healthProbe, {
      urls: [`${mainOrigin}/ok`, `${otherOrigin}/ok`],
      deadlineMs: 5000,
    });
    expect(result.probed).toBe(2);
    expect(seenAuth.at(-1)).toBe(`Bearer ${TOKEN_VALUE}`);
    expect(seenOtherAuth).toEqual(["<none>"]);
    const byUrl = Object.fromEntries(
      result.probes.map((p: { url: string; authenticated?: boolean }) => [
        p.url.startsWith(mainOrigin) ? "main" : "other",
        p.authenticated,
      ]),
    );
    expect(byUrl).toEqual({ main: true, other: false });
  });

  test("HealthProbe honours expectStatus, so a 503 can be the healthy answer", async () => {
    const result = await run(healthProbe, {
      urls: [`${mainOrigin}/down`],
      deadlineMs: 5000,
      expectStatus: [503],
    });
    expect(result.healthy).toBe(1);
  });

  test("HealthProbe's deadline bounds the whole sweep and skips what it could not reach", async () => {
    const startedAt = Date.now();
    const result = await run(healthProbe, {
      urls: [`${mainOrigin}/slow`, `${mainOrigin}/slow`, `${mainOrigin}/ok`],
      deadlineMs: 300,
      concurrency: 1,
    });
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(result.healthy).toBe(0);
    expect(result.skipped + result.unhealthy).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// remote: the refusals
// ---------------------------------------------------------------------------

describe("the outbound gate", () => {
  beforeEach(() => {
    startServers();
    __setPrivateHostsAllowedForTest(true);
  });

  afterEach(() => {
    stopServers();
  });

  test("an empty allow-list denies everything — there is no allow-all value", async () => {
    registerObsConfig({ metrics: { base_url: mainOrigin } });
    expect(await run(metricsQuery, { query: "up" })).toContain("empty allow-list = deny all");
  });

  test("an origin outside the allow-list is refused even when it is configured", async () => {
    registerObsConfig({ allowed_origins: [otherOrigin], metrics: { base_url: mainOrigin } });
    const result = await run(metricsQuery, { query: "up" });
    expect(result).toContain("is not in allowed_origins");
  });

  test("a surface with no configured endpoint says which config key is missing", async () => {
    registerObsConfig({ allowed_origins: [mainOrigin] });
    expect(await run(logsQuery, { query: "x" })).toContain("logs.base_url");
    expect(await run(alertList, {})).toContain("alerts.base_url");
    expect(
      await run(statusPagePost, { title: "t", body: "b", status: "s", justification: "j" }),
    ).toContain("status_page.base_url");
  });

  test("HealthProbe refuses a URL whose origin is not allow-listed, per URL", async () => {
    registerObsConfig({ allowed_origins: [mainOrigin], token_env: TOKEN_VAR });
    const result = await run(healthProbe, {
      urls: [`${mainOrigin}/ok`, "https://example.invalid/health"],
      deadlineMs: 3000,
    });
    expect(result.healthy).toBe(1);
    const refused = result.probes.find((p: { url: string }) => p.url.includes("example.invalid"));
    expect(refused.error).toContain("not in allowed_origins");
  });

  test("the SSRF gate refuses the cloud metadata address even with the test flag on", async () => {
    registerObsConfig({ allowed_origins: ["http://169.254.169.254"], token_env: TOKEN_VAR });
    const result = await run(healthProbe, {
      urls: ["http://169.254.169.254/latest/meta-data/"],
      deadlineMs: 2000,
    });
    expect(result.probes[0].error).toContain("SSRF");
  });

  test("with the flag in its production position, loopback itself is refused", async () => {
    __setPrivateHostsAllowedForTest(false);
    registerObsConfig({ allowed_origins: [mainOrigin], metrics: { base_url: mainOrigin } });
    expect(await run(metricsQuery, { query: "up" })).toContain("SSRF");
  });

  test("a deadline fires rather than hanging", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      metrics: { base_url: mainOrigin, path: "/slow" },
    });
    const startedAt = Date.now();
    const result = await run(metricsQuery, { query: "up", timeoutMs: 200 });
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(result).toContain("deadline");
  });

  test("a DNS lookup that never answers loses to the deadline too", async () => {
    // The resolver takes no signal of its own, so without an explicit race the
    // OS resolver's timeout — tens of seconds, and longer with retries — would
    // outlive the deadline the caller declared. The hostname is deliberately
    // not an IP literal, so the lookup is actually reached.
    _setDnsLookup(() => new Promise(() => {}));
    registerObsConfig({
      allowed_origins: ["http://obs.example.test"],
      metrics: { base_url: "http://obs.example.test" },
    });
    const startedAt = Date.now();
    try {
      const result = await run(metricsQuery, { query: "up", timeoutMs: 200 });
      expect(result).toContain("deadline");
      expect(Date.now() - startedAt).toBeLessThan(2500);
    } finally {
      _setDnsLookup(undefined);
    }
  });

  test("a private address is refused in every encoding, not just the plain one", async () => {
    // Each of these is the cloud metadata address, or loopback, wearing a
    // different spelling — and each is allow-listed, so the allow-list is not
    // what refuses them.
    const dressedUp = [
      "http://0xa9fea9fe/latest/meta-data/", // hex
      "http://0251.0376.0251.0376/latest/meta-data/", // octal
      "http://2852039166/latest/meta-data/", // 32-bit integer
      "http://[::ffff:169.254.169.254]/latest/meta-data/", // IPv4-mapped
      "http://[64:ff9b::169.254.169.254]/latest/meta-data/", // NAT64
      "http://[2002:a9fe:a9fe::]/latest/meta-data/", // 6to4
    ];
    registerObsConfig({
      allowed_origins: dressedUp.map((u) => new URL(u).origin),
      token_env: TOKEN_VAR,
    });
    // The flag is ON, which lifts loopback and nothing else — these must still
    // be refused with it lifted.
    __setPrivateHostsAllowedForTest(true);
    const result = await run(healthProbe, { urls: dressedUp, deadlineMs: 2000 });
    expect(result.healthy).toBe(0);
    for (const probe of result.probes as { error: string }[]) {
      expect(probe.error).toContain("SSRF");
    }
  });

  test("a hostname that resolves to a private address is refused after the lookup", async () => {
    _setDnsLookup(async () => ({ address: "169.254.169.254", family: 4 }));
    registerObsConfig({
      allowed_origins: ["https://metrics.example.test"],
      metrics: { base_url: "https://metrics.example.test" },
    });
    try {
      const result = await run(metricsQuery, { query: "up" });
      expect(result).toContain("resolves to private IP");
    } finally {
      _setDnsLookup(undefined);
    }
  });

  test("the byte cap cuts a body the server would happily keep sending", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      logs: { base_url: mainOrigin, path: "/huge" },
    });
    const result = await run(logsQuery, { query: "x", maxBytes: 4096 });
    // 2MB of 'z' cut to 4KB is no longer JSON, which is the point: the cap
    // bounded what was HELD, not what was returned after buffering.
    expect(result).toContain("was not JSON");
    expect(result.length).toBeLessThan(600);
  });

  test("a body that is not JSON is a readable refusal with a capped excerpt", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      logs: { base_url: mainOrigin, path: "/notjson" },
    });
    expect(await run(logsQuery, { query: "x" })).toContain("was not JSON");
  });
});

// ---------------------------------------------------------------------------
// remote: the credential
// ---------------------------------------------------------------------------

describe("the token", () => {
  beforeEach(() => {
    startServers();
    __setPrivateHostsAllowedForTest(true);
  });

  afterEach(() => {
    stopServers();
  });

  test("it is read from the named environment variable and sent as a header", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      metrics: { base_url: mainOrigin },
    });
    await run(metricsQuery, { query: "up" });
    expect(seenAuth.at(-1)).toBe(`Bearer ${TOKEN_VALUE}`);
  });

  test("it never appears in a successful result, even when the platform echoes it back", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      alerts: { base_url: mainOrigin, path: "/echo-token" },
    });
    const raw = await alertList.execute({});
    expect(typeof raw).toBe("string");
    expect(raw as string).toContain("<redacted>");
    expect(raw as string).not.toContain(TOKEN_VALUE);
  });

  test("a token pasted in place of a variable NAME is refused and never echoed", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: "ghp_realsecrettokenvalue",
      alerts: { base_url: mainOrigin, path: "/alerts" },
    });
    const result = await run(alertList, {});
    expect(result).toContain("NAME of an environment variable");
    expect(result).not.toContain("ghp_realsecrettokenvalue");
  });

  test("an unset variable is named, because a variable name is not a secret", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: "CREWHAUS_TEST_OBS_UNSET",
      alert_ack: { base_url: mainOrigin, path: "/alerts/{id}/ack" },
    });
    const result = await run(alertAck, { alertId: "a1", acknowledgedBy: "x", justification: "y" });
    expect(result).toContain("CREWHAUS_TEST_OBS_UNSET");
    expect(result).toContain("unset or empty");
  });

  test("a read-only surface with no configured token proceeds unauthenticated", async () => {
    registerObsConfig({ allowed_origins: [mainOrigin], metrics: { base_url: mainOrigin } });
    const result = await run(metricsQuery, { query: "up" });
    expect(result.ok).toBe(true);
    expect(seenAuth.at(-1)).toBe("<none>");
  });

  test("a write surface with no configured token refuses rather than posting anonymously", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      status_page: { base_url: mainOrigin, path: "/status/incidents" },
    });
    const result = await run(statusPagePost, {
      title: "t",
      body: "b",
      status: "s",
      justification: "j",
    });
    expect(result).toContain("no token");
  });

  test("a cross-origin redirect drops the credential before the socket opens", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin, otherOrigin],
      token_env: TOKEN_VAR,
      alerts: { base_url: otherOrigin, path: "/redirect-away" },
    });
    const result = await run(alertList, {});
    expect(result.credentialsDropped).toBe(true);
    // The second server saw the token; the redirect target must not have.
    expect(seenAuth.at(-1)).toBe("<none>");
  });

  test("a URL carrying userinfo is refused outright", async () => {
    const withUser = mainOrigin.replace("http://", "http://user:pass@");
    registerObsConfig({ allowed_origins: [mainOrigin], token_env: TOKEN_VAR });
    const result = await run(healthProbe, { urls: [`${withUser}/ok`], deadlineMs: 2000 });
    expect(result.probes[0].error).toContain("userinfo");
    expect(result.probes[0].error).not.toContain("pass@");
  });
});

describe("configured path templates", () => {
  beforeEach(() => {
    startServers();
    __setPrivateHostsAllowedForTest(true);
  });

  afterEach(() => {
    stopServers();
  });

  test("a path needing {id} with none supplied is refused, not collapsed to the collection", async () => {
    // `/status/incidents//update` is routed to the COLLECTION by some servers,
    // so an update meant for one incident would silently create a new one.
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      status_page: { base_url: mainOrigin, path: "/status/incidents/{id}/update" },
    });
    const result = await run(statusPagePost, {
      title: "t",
      body: "b",
      status: "s",
      justification: "j",
    });
    expect(result).toContain("contains {id} but no id was supplied");
  });

  test("a dot-segment id is refused rather than walking up to the collection", async () => {
    // `..` is the one value percent-encoding does not neutralise: it encodes
    // to itself and the URL parser then RESOLVES it, so `/alerts/../ack` is
    // REQUESTED as `/ack`. A destructive tool must address what it was asked
    // to address or nothing at all.
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      alert_ack: { base_url: mainOrigin, path: "/alerts/{id}/ack" },
    });
    for (const alertId of ["..", "."]) {
      const result = await run(alertAck, { alertId, acknowledgedBy: "bot", justification: "j" });
      expect(typeof result).toBe("string");
      expect(result).toContain("relative path segment");
    }
    // Nothing was sent: the refusal happens before the first byte.
    expect(seenAuth).toEqual([]);
  });

  test("a dot-segment incident id cannot turn an update into a new incident", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      status_page: { base_url: mainOrigin, path: "/status/incidents/{id}/update" },
    });
    const result = await run(statusPagePost, {
      title: "t",
      body: "b",
      status: "s",
      incidentId: "..",
      justification: "j",
    });
    expect(result).toContain("relative path segment");
    expect(seenAuth).toEqual([]);
  });

  test("an id that survives encoding stays one segment of the path that is sent", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      alert_ack: { base_url: mainOrigin, path: "/alerts/{id}/ack" },
    });
    // Built by hand from the id rather than by re-running the tool's own
    // encoder: the assertion is the path the SERVER saw, not a round trip
    // through the same function under test.
    for (const [alertId, segment] of [
      ["a 1", "a%201"],
      ["a#b", "a%23b"],
      ["a?b=c", "a%3Fb%3Dc"],
      ["../../etc", "..%2F..%2Fetc"],
      ["a%2e%2e", "a%252e%252e"],
    ] as const) {
      const result = await run(alertAck, { alertId, acknowledgedBy: "bot", justification: "j" });
      expect(result.url).toBe(`${mainOrigin}/alerts/${segment}/ack`);
    }
  });

  test("the id is percent-encoded into the path rather than concatenated raw", async () => {
    registerObsConfig({
      allowed_origins: [mainOrigin],
      token_env: TOKEN_VAR,
      alert_ack: { base_url: mainOrigin, path: "/alerts/{id}/ack" },
    });
    const result = await run(alertAck, {
      alertId: "a/../escape",
      acknowledgedBy: "bot",
      justification: "j",
    });
    // The traversal is encoded, so it stays ONE path segment and cannot walk
    // up to a sibling resource on the platform.
    expect(result.url).toContain("/alerts/a%2F..%2Fescape/ack");
    expect(result.url).not.toContain("/../");
  });
});
