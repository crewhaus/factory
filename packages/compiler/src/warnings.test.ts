/**
 * Loop contract 0.4 (Batch A) — the compile() warnings framework
 * (ACCEPTED_BUT_UNWIRED) and the G45 unconditional validating passes.
 *
 * The warnings table encodes the POST-Batch-A intended state; these tests
 * PIN it: when an emitter wires a listed key, its row (and the matching
 * expectation here) is deleted together.
 */
import { describe, expect, test } from "bun:test";
import { IrPassError } from "@crewhaus/ir-passes";
import { type CompileWarning, compile } from "./index";

const paths = (warnings: ReadonlyArray<CompileWarning>): string[] =>
  warnings.map((w) => w.path).sort();

describe("compile() warnings — additive result field", () => {
  test("a clean cli compile returns an empty warnings array alongside files", () => {
    const result = compile("name: c\ntarget: cli\nagent:\n  model: m\n  instructions: i");
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  test("cli mcp_servers does NOT warn (wired shape)", () => {
    const result = compile(
      [
        "name: c",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: i",
        "mcp_servers:",
        "  fs:",
        "    transport: stdio",
        "    command: mcp-fs",
      ].join("\n"),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("compile() warnings — ACCEPTED_BUT_UNWIRED table", () => {
  test("voice warns for mcp_servers + tools + continuity (each only when declared)", () => {
    const result = compile(
      [
        "name: vc",
        "target: voice",
        "agent:",
        "  model: m",
        "  instructions: i",
        "voice:",
        "  provider: openai",
        "tools:",
        "  - read",
        "mcp_servers:",
        "  fs:",
        "    transport: stdio",
        "    command: mcp-fs",
        "continuity: true",
      ].join("\n"),
    );
    expect(paths(result.warnings)).toEqual(["continuity", "mcp_servers", "tools"]);
    for (const w of result.warnings) {
      expect(w.code).toBe("accepted-but-unwired");
      expect(w.message).toContain(w.path);
    }
    // Nothing declared → nothing warned.
    const clean = compile(
      [
        "name: vc",
        "target: voice",
        "agent:",
        "  model: m",
        "  instructions: i",
        "voice:",
        "  provider: openai",
      ].join("\n"),
    );
    expect(clean.warnings).toEqual([]);
  });

  test("browser warns for mcp_servers + continuity but NOT tools", () => {
    const result = compile(
      [
        "name: br",
        "target: browser",
        "agent:",
        "  model: m",
        "  instructions: i",
        "mcp_servers:",
        "  fs:",
        "    transport: stdio",
        "    command: mcp-fs",
        "continuity: true",
        "tools:",
        "  - read",
      ].join("\n"),
    );
    expect(paths(result.warnings)).toEqual(["continuity", "mcp_servers"]);
  });

  test("workflow/batch warn for a declared continuity, and continuity: false does not warn (live opt-out)", () => {
    const wf = (continuityLine: string): string =>
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: s",
        "    instructions: i",
        continuityLine,
      ].join("\n");
    expect(paths(compile(wf("continuity: true")).warnings)).toEqual(["continuity"]);
    expect(compile(wf("continuity: false")).warnings).toEqual([]);

    const bt = compile(
      [
        "name: bt",
        "target: batch",
        "agent:",
        "  model: m",
        "  instructions: i",
        "queue:",
        "  adapter: in-memory",
        "continuity:",
        "  plan: false",
      ].join("\n"),
    );
    expect(paths(bt.warnings)).toEqual(["continuity"]);
  });

  test("thredz warns on channel/managed/research/crew (carried, ignored-note shapes)", () => {
    const channel = compile(
      [
        "name: ch",
        "target: channel",
        "agent:",
        "  model: m",
        "  instructions: i",
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
        "thredz: $THREDZ_API_KEY",
      ].join("\n"),
    );
    expect(paths(channel.warnings)).toEqual(["thredz"]);

    const managed = compile(
      [
        "name: mg",
        "target: managed",
        "agent:",
        "  model: m",
        "  instructions: i",
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
        "thredz: $THREDZ_API_KEY",
      ].join("\n"),
    );
    expect(paths(managed.warnings)).toEqual(["thredz"]);

    const research = compile(
      [
        "name: re",
        "target: research",
        "agent:",
        "  model: m",
        "  instructions: i",
        "goal: learn",
        "thredz: $THREDZ_API_KEY",
      ].join("\n"),
    );
    expect(paths(research.warnings)).toEqual(["thredz"]);

    const crew = compile(
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: lead it",
        "thredz: $THREDZ_API_KEY",
      ].join("\n"),
    );
    expect(paths(crew.warnings)).toEqual(["thredz"]);
    // cli thredz is emit-WIRED — no warning.
    const cli = compile(
      "name: c\ntarget: cli\nagent:\n  model: m\n  instructions: i\nthredz: $THREDZ_API_KEY",
    );
    expect(cli.warnings).toEqual([]);
  });

  test("Batch-A keys never warn (limits/thinking/hooks are wired-by-contract)", () => {
    const result = compile(
      [
        "name: wf",
        "target: workflow",
        "model: m",
        "steps:",
        "  - name: s",
        "    instructions: i",
        "    thinking:",
        "      effort: low",
        "limits:",
        "  max_tool_iterations: 5",
        "hooks:",
        "  - event: stop",
        "    command: echo",
        "budget:",
        "  usd: 1",
      ].join("\n"),
    );
    expect(result.warnings).toEqual([]);
  });
});

describe("G45 — validating ir-passes run unconditionally in compile()", () => {
  test("a graph with an unreachable node fails compile WITHOUT applyIrPasses", () => {
    const yaml = [
      "name: g",
      "target: graph",
      "model: m",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: do a",
      "  island:",
      "    instructions: never reached",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(IrPassError);
    expect(() => compile(yaml)).toThrow(/unreachable/);
  });

  test("a parallel group makes its members reachable (barrier fires from group[0])", () => {
    const yaml = [
      "name: g",
      "target: graph",
      "model: m",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: do a",
      "  b:",
      "    instructions: do b",
      "  c:",
      "    instructions: do c",
      "edges:",
      "  - from: a",
      "    to: b",
      "parallel:",
      "  - [b, c]",
    ].join("\n");
    const result = compile(yaml);
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("chain referential integrity fails compile on a cli spec (wallet → undeclared chain)", () => {
    const yaml = [
      "name: c",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: i",
      "chains:",
      "  - id: mainnet",
      "    kind: evm",
      "    rpcUrls:",
      "      - $RPC_URL",
      "    finality:",
      "      kind: finalized",
      "wallets:",
      "  - id: hot",
      "    chainId: ghostnet",
      "    custody: local",
      "    keyRef: $WALLET_KEY",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(IrPassError);
    expect(() => compile(yaml)).toThrow(/ghostnet/);
  });

  test("a well-formed graph still compiles and rewriting passes stay opt-in", () => {
    // Two mcp servers with identical signatures: the REWRITING collapse pass
    // must NOT run on the plain path (both keys survive), and must run under
    // applyIrPasses: true (they dedupe to one).
    const yaml = [
      "name: c",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: i",
      "mcp_servers:",
      "  one:",
      "    transport: stdio",
      "    command: mcp-fs",
      "  two:",
      "    transport: stdio",
      "    command: mcp-fs",
    ].join("\n");
    const plain = compile(yaml);
    const agentTs = plain.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('"one"');
    expect(agentTs).toContain('"two"');
    const optimized = compile(yaml, { applyIrPasses: true });
    const optimizedTs = optimized.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(optimizedTs).toContain('"one"');
    expect(optimizedTs).not.toContain('"two"');
  });
});
