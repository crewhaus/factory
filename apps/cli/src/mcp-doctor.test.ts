/**
 * Ops item 38 — tests for the `crewhaus mcp doctor` core: health scoring from
 * seeded mcp_stats records, the listTools drift diff (added/removed/schema-
 * changed with an order-insensitive schema hash), the quarantine/restore
 * decision, and the report rendering.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type McpStatsPayload,
  buildSnapshot,
  decideQuarantine,
  diffSnapshots,
  driftIsEmpty,
  formatHealthReport,
  isChronic,
  quarantineNotice,
  safeMcpFileName,
  schemaHash,
  scoreMcpHealth,
} from "./mcp-doctor";

function stat(server: string, isError: boolean, durationMs = 100): McpStatsPayload {
  return { server, toolName: "t", durationMs, isError };
}

describe("scoreMcpHealth", () => {
  test("rolls up per-server error rate + latency percentiles", () => {
    const records: McpStatsPayload[] = [
      stat("good", false, 50),
      stat("good", false, 100),
      stat("good", false, 150),
      stat("bad", true, 200),
      stat("bad", false, 300),
    ];
    const health = scoreMcpHealth(records);
    const good = health.find((h) => h.server === "good");
    const bad = health.find((h) => h.server === "bad");
    expect(good?.errorRate).toBe(0);
    expect(good?.p50Ms).toBe(100);
    expect(bad?.errorRate).toBe(0.5);
  });

  test("computes the max consecutive-error streak (reconnect-churn proxy)", () => {
    const records: McpStatsPayload[] = [
      stat("s", false),
      stat("s", true),
      stat("s", true),
      stat("s", true),
      stat("s", false),
      stat("s", true),
    ];
    const [h] = scoreMcpHealth(records);
    expect(h?.maxErrorStreak).toBe(3);
  });

  test("flags a chronic server (over error-rate ceiling with enough calls)", () => {
    const records: McpStatsPayload[] = Array.from({ length: 10 }, (_, i) =>
      stat("flaky", i % 2 === 0),
    );
    const [h] = scoreMcpHealth(records);
    expect(h?.chronic).toBe(true);
  });

  test("sorts sickest-first (chronic then error rate desc)", () => {
    const records: McpStatsPayload[] = [
      ...Array.from({ length: 6 }, () => stat("chronic", true)),
      stat("mild", true),
      stat("mild", false),
      stat("mild", false),
      stat("mild", false),
      stat("mild", false),
      stat("healthy", false),
      stat("healthy", false),
      stat("healthy", false),
      stat("healthy", false),
      stat("healthy", false),
    ];
    const health = scoreMcpHealth(records);
    expect(health[0]?.server).toBe("chronic");
    expect(health.at(-1)?.server).toBe("healthy");
  });
});

describe("isChronic", () => {
  test("a long error streak is chronic regardless of overall rate", () => {
    // 100 calls, only 4 errors overall (4% rate) but all consecutive.
    expect(isChronic(100, 0.04, 4)).toBe(true);
  });

  test("high rate below min-calls is not yet chronic (cold-start guard)", () => {
    expect(isChronic(3, 1.0, 3)).toBe(false);
  });
});

describe("schemaHash + diffSnapshots", () => {
  test("schema hash is key-order-insensitive", () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
    expect(schemaHash({ a: 1, b: 2 })).not.toBe(schemaHash({ a: 1, b: 3 }));
  });

  test("first snapshot (no previous) is not drift", () => {
    const cur = buildSnapshot(
      "s",
      [{ name: "x", inputSchema: { type: "string" } }],
      "2026-07-02T00:00:00Z",
    );
    expect(driftIsEmpty(diffSnapshots(undefined, cur))).toBe(true);
  });

  test("detects added / removed / schema-changed tools", () => {
    const prev = buildSnapshot(
      "s",
      [
        { name: "keep", inputSchema: { type: "string" } },
        { name: "gone", inputSchema: { type: "number" } },
        { name: "morph", inputSchema: { type: "string" } },
      ],
      "2026-07-01T00:00:00Z",
    );
    const cur = buildSnapshot(
      "s",
      [
        { name: "keep", inputSchema: { type: "string" } },
        { name: "morph", inputSchema: { type: "number" } }, // schema changed
        { name: "fresh", inputSchema: { type: "boolean" } }, // added
      ],
      "2026-07-02T00:00:00Z",
    );
    const drift = diffSnapshots(prev, cur);
    expect(drift.added).toEqual(["fresh"]);
    expect(drift.removed).toEqual(["gone"]);
    expect(drift.schemaChanged).toEqual(["morph"]);
  });
});

describe("decideQuarantine", () => {
  test("quarantines a chronic server not yet out", () => {
    const health = scoreMcpHealth(Array.from({ length: 6 }, () => stat("bad", true)));
    const decision = decideQuarantine(health, []);
    expect(decision.quarantine).toEqual(["bad"]);
    expect(decision.restore).toEqual([]);
  });

  test("restores a quarantined server that is now healthy", () => {
    const health = scoreMcpHealth(Array.from({ length: 6 }, () => stat("recovered", false)));
    const decision = decideQuarantine(health, ["recovered"]);
    expect(decision.restore).toEqual(["recovered"]);
    expect(decision.quarantine).toEqual([]);
  });

  test("leaves a server with no recent signal untouched", () => {
    const decision = decideQuarantine([], ["silent"]);
    expect(decision.quarantine).toEqual([]);
    expect(decision.restore).toEqual([]);
  });

  test("does not re-quarantine an already-out chronic server", () => {
    const health = scoreMcpHealth(Array.from({ length: 6 }, () => stat("bad", true)));
    const decision = decideQuarantine(health, ["bad"]);
    expect(decision.quarantine).toEqual([]);
    expect(decision.restore).toEqual([]);
  });
});

describe("rendering", () => {
  test("health report marks chronic servers and reports empty history", () => {
    expect(formatHealthReport([])[0]).toContain("no MCP call history");
    const health = scoreMcpHealth(Array.from({ length: 6 }, () => stat("bad", true)));
    const lines = formatHealthReport(health).join("\n");
    expect(lines).toContain("CHRONIC");
  });

  test("quarantine notice names the server + reason", () => {
    expect(quarantineNotice("weather", "80% errors")).toContain("weather");
    expect(quarantineNotice("weather", "80% errors")).toContain("80% errors");
  });
});

describe("safeMcpFileName — F5 path-traversal safety", () => {
  const mcpDir = "/repo/.crewhaus/mcp";

  test("a traversal name stays inside the mcp dir", () => {
    const path = join(mcpDir, `${safeMcpFileName("../../evil")}.json`);
    expect(path.startsWith(mcpDir)).toBe(true);
    expect(path).not.toContain("..");
    // basename("../../evil") is "evil" → the file is .crewhaus/mcp/evil.json.
    expect(path).toBe(join(mcpDir, "evil.json"));
  });

  test("a slashed name cannot introduce a subdirectory", () => {
    const path = join(mcpDir, `${safeMcpFileName("a/b/c")}.json`);
    expect(path).toBe(join(mcpDir, "c.json"));
  });

  test("an absolute-path name is neutralised to a bare segment", () => {
    const path = join(mcpDir, `${safeMcpFileName("/etc/passwd")}.json`);
    expect(path).toBe(join(mcpDir, "passwd.json"));
  });

  test("dot-only / empty names floor to a stable placeholder", () => {
    expect(safeMcpFileName("..")).toBe("_server");
    expect(safeMcpFileName(".")).toBe("_server");
    expect(safeMcpFileName("...")).toBe("_server");
  });

  test("odd characters (spaces, colons) collapse to underscores", () => {
    expect(safeMcpFileName("we ird:na me")).toBe("we_ird_na_me");
  });

  test("an ordinary server name is preserved", () => {
    expect(safeMcpFileName("weather-api_v2.1")).toBe("weather-api_v2.1");
  });
});
