/**
 * Loop contract 0.4 (Batch F, keystone) — the spec+IR grammar the keystone
 * lands for the downstream emitter agents: the `schedule:` block (temporal
 * contract), managed `tools`/`tool_config` (G81), and the cf-worker
 * edge-safety tool gate (G12/G83).
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { type CompileWarning, assertCfWorkerToolsEdgeSafe, compile, lower } from "./index";

const paths = (w: ReadonlyArray<CompileWarning>): string[] => w.map((x) => x.path).sort();

describe("schedule: block lowering (temporal contract)", () => {
  test("cron schedule lowers verbatim + jitter to ms on channel", () => {
    const ir = lower(
      parseSpec(
        [
          "name: ch",
          "target: channel",
          "agent: { model: m, instructions: i }",
          "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
          "routing: { sessionKey: thread }",
          "schedule:",
          "  kind: cron",
          "  cron: 0 */6 * * *",
          "  timezone: America/New_York",
          "  jitter: 30s",
          "  instructions: sweep the queue",
        ].join("\n"),
      ),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.schedule).toEqual({
      kind: "cron",
      cron: "0 */6 * * *",
      timezone: "America/New_York",
      jitterMs: 30_000,
      instructions: "sweep the queue",
    });
  });

  test("interval schedule normalizes every + jitter to ms on managed", () => {
    const ir = lower(
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent: { model: m, instructions: i }",
          "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
          "schedule: { kind: interval, every: 6h, jitter: 500ms }",
        ].join("\n"),
      ),
    );
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect(ir.schedule).toEqual({ kind: "interval", everyMs: 21_600_000, jitterMs: 500 });
  });

  test("batch carries a bare interval schedule; absent schedule stays absent", () => {
    const withSchedule = lower(
      parseSpec(
        [
          "name: b",
          "target: batch",
          "agent: { model: m, instructions: i }",
          "queue: { adapter: in-memory }",
          "schedule: { kind: interval, every: 1h }",
        ].join("\n"),
      ),
    );
    if (withSchedule.target !== "batch") throw new Error("unexpected target");
    expect(withSchedule.schedule).toEqual({ kind: "interval", everyMs: 3_600_000 });

    const without = lower(
      parseSpec(
        "name: b\ntarget: batch\nagent: { model: m, instructions: i }\nqueue: { adapter: in-memory }",
      ),
    );
    if (without.target !== "batch") throw new Error("unexpected target");
    expect("schedule" in without).toBe(false);
  });

  test("a bad cron field-count is rejected at parse time", () => {
    expect(() =>
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent: { model: m, instructions: i }",
          "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
          "schedule: { kind: cron, cron: 'oops not cron' }",
        ].join("\n"),
      ),
    ).toThrow(/cron/);
  });

  test("a declared schedule does NOT warn — the daemon arms the wake loop", () => {
    const warnings = compile(
      [
        "name: mg",
        "target: managed",
        "agent: { model: m, instructions: i }",
        "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
        "schedule: { kind: interval, every: 1h }",
      ].join("\n"),
    ).warnings;
    // Batch F wires the managed wake loop (renderScheduleWake → a per-tenant
    // setInterval/cron wake), so schedule is emit-WIRED, not accepted-but-inert
    // — its ACCEPTED_BUT_UNWIRED row is deleted together with this expectation.
    expect(paths(warnings)).toEqual([]);
  });
});

describe("managed tools + tool_config (G81)", () => {
  test("managed agent.tools + tool_config lower onto the managed IR", () => {
    const ir = lower(
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  tools: [webSearch, fetch]",
          "  tool_config:",
          "    fetch: { allowedHosts: ['api.example.com'] }",
          "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
        ].join("\n"),
      ),
    );
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect(ir.tools).toEqual(["webSearch", "fetch"]);
    expect(ir.toolConfigs).toEqual({ fetch: { allowedHosts: ["api.example.com"] } });
  });

  test("a managed spec without tools stays byte-identical (no tools/toolConfigs keys)", () => {
    const ir = lower(
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent: { model: m, instructions: i }",
          "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
        ].join("\n"),
      ),
    );
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect("tools" in ir).toBe(false);
    expect("toolConfigs" in ir).toBe(false);
  });
});

describe("cf-worker edge-safety tool gate (assertCfWorkerToolsEdgeSafe)", () => {
  const cliWithTools = (tools: string): ReturnType<typeof lower> =>
    lower(parseSpec(`name: c\ntarget: cli\nagent: { model: m, instructions: i }\ntools: ${tools}`));

  test("host tools throw a clear compile error", () => {
    expect(() => assertCfWorkerToolsEdgeSafe(cliWithTools("[read, bash]"))).toThrow(
      /cf-worker target cannot run 2 host tool\(s\)/,
    );
  });

  test("edge-safe builtins compile cleanly (no warnings)", () => {
    expect(assertCfWorkerToolsEdgeSafe(cliWithTools("[webSearch, fetch, webFetch]"))).toEqual([]);
  });

  test("unrecognised custom tools are permitted with an edge-unsafe-tool warning", () => {
    const warnings = assertCfWorkerToolsEdgeSafe(cliWithTools("[myCustomThing]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("edge-unsafe-tool");
    expect(warnings[0]?.message).toContain("myCustomThing");
  });

  test("a run with no tools passes trivially", () => {
    expect(assertCfWorkerToolsEdgeSafe(cliWithTools("[]"))).toEqual([]);
  });
});
