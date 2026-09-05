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

  test("thredz warns on research only (cli/channel/managed/crew emit-WIRED)", () => {
    // Batch E (G23) — channel + managed port the cli connectThredz fragment,
    // so thredz no longer warns there; research + crew stay carried-with-note.
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
    expect(channel.warnings).toEqual([]);

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
    expect(managed.warnings).toEqual([]);

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
    // 0.5.0 — crew thredz is emit-WIRED too (with the per-role fan-out), so
    // its ACCEPTED_BUT_UNWIRED row is DELETED rather than silenced. research
    // is now the only shape that still carries the block with an ignored-note.
    expect(crew.warnings).toEqual([]);
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

  test("Batch-C keys never warn — observability + permissions.ask_mode are wired-in-batch", () => {
    // cli with the full observability control block + ask_mode.
    const cli = compile(
      [
        "name: c",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: i",
        "permissions:",
        "  ask_mode: pause",
        "observability:",
        "  trace:",
        "    level: pretty",
        "  metrics:",
        "    enabled: true",
        "  otel:",
        "    endpoint: http://localhost:4318",
      ].join("\n"),
    );
    expect(cli.warnings).toEqual([]);

    // crew — the shape Batch C newly joins to the observability carriers.
    const crew = compile(
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: lead it",
        "permissions:",
        "  ask_mode: deny",
        "observability:",
        "  cost:",
        "    enabled: false",
      ].join("\n"),
    );
    expect(crew.warnings).toEqual([]);
  });
});

describe("compile() warnings — channel-reactions-join (D40)", () => {
  const channelYaml = (feedbackLines: readonly string[]): string =>
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
      ...feedbackLines,
    ].join("\n");

  test("channelReactions: true → one join-accumulation heads-up", () => {
    const result = compile(channelYaml(["feedback:", "  channelReactions: true"]));
    expect(result.warnings.length).toBe(1);
    const w = result.warnings[0];
    expect(w?.code).toBe("channel-reactions-join");
    expect(w?.path).toBe("feedback.channelReactions");
    expect(w?.message).toContain(".crewhaus/feedback/joins/channel.jsonl");
    expect(w?.message).toContain("older builds");
  });

  test("feedback without channelReactions (or channelReactions: false) does not warn", () => {
    expect(compile(channelYaml(["feedback:", "  modality: binary"])).warnings).toEqual([]);
    expect(compile(channelYaml(["feedback:", "  channelReactions: false"])).warnings).toEqual([]);
    expect(compile(channelYaml([])).warnings).toEqual([]);
  });
});

describe("compile() warnings — cli-autodistill-toolchain (item 1)", () => {
  const cliYaml = (feedbackLines: readonly string[]): string =>
    [
      "name: ghost",
      "target: cli",
      "agent:",
      "  model: m",
      "  instructions: i",
      ...feedbackLines,
    ].join("\n");

  test("feedback.autoDistill: true → one honest toolchain-step heads-up", () => {
    const result = compile(cliYaml(["feedback:", "  autoDistill: true"]));
    expect(result.warnings.length).toBe(1);
    const w = result.warnings[0];
    expect(w?.code).toBe("cli-autodistill-toolchain");
    expect(w?.path).toBe("feedback.autoDistill");
    // Honest about BOTH halves: the bundle does capture, it does not distill.
    expect(w?.message).toContain("CAPTURES ratings");
    expect(w?.message).toContain("ghost-ratings");
    expect(w?.message).toContain("crewhaus distill --register");
  });

  test("a plain feedback block does NOT warn — the bundle wires the capture half", () => {
    expect(compile(cliYaml(["feedback:", "  modality: binary"])).warnings).toEqual([]);
    expect(compile(cliYaml(["feedback:", "  autoDistill: false"])).warnings).toEqual([]);
    expect(compile(cliYaml([])).warnings).toEqual([]);
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

// 0.6.0 §7.12 — `budget.on_exceed.degrade.model` outside the `model_pool`
// roster is a WARNING (plus an extra runtime rung), never a parse error: no
// refine forbids `budget` beside `model_pool`, and such specs compile today.
describe("compile() warnings — budget-degrade-outside-pool", () => {
  const pooled = (degradeModel: string | undefined, extra: string[] = []): string =>
    [
      "name: p",
      "target: cli",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-sonnet-4-6, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "budget:",
      "  usd: 1",
      ...(degradeModel !== undefined
        ? ["  on_exceed:", "    action: degrade", `    model: ${degradeModel}`]
        : []),
      ...extra,
    ].join("\n");

  test("an off-roster degrade model warns with a stable code and the roster in the message", () => {
    const result = compile(pooled("claude-haiku-4-5"));
    expect(result.files.length).toBeGreaterThan(0); // it still compiles
    expect(result.warnings).toHaveLength(1);
    const w = result.warnings[0];
    expect(w?.code).toBe("budget-degrade-outside-pool");
    expect(w?.path).toBe("budget.on_exceed.model");
    expect(w?.message).toContain("claude-haiku-4-5");
    expect(w?.message).toContain("claude-sonnet-4-6, claude-opus-4-8");
    expect(w?.message).toContain("EXTRA pool rung");
    // The compiled bundle still carries the degrade ladder verbatim — the
    // runtime pre-resolves the rung and forces it on a breach.
    const entry = result.files.find((f) => f.path.endsWith(".ts"))?.content ?? "";
    expect(entry).toContain('"onExceed":{"kind":"degrade","model":"claude-haiku-4-5"}');
  });

  test("a roster-member degrade model, a stop ladder, or no pool → no warning", () => {
    expect(compile(pooled("claude-sonnet-4-6")).warnings).toEqual([]);
    expect(compile(pooled(undefined)).warnings).toEqual([]);
    const noPool = compile(
      [
        "name: s",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "budget:",
        "  usd: 1",
        "  on_exceed:",
        "    action: degrade",
        "    model: claude-haiku-4-5",
      ].join("\n"),
    );
    expect(noPool.warnings).toEqual([]);
  });

  test("the warning fires on the other pool-carrying shapes too (channel)", () => {
    const result = compile(
      [
        "name: ch",
        "target: channel",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-sonnet-4-6, tags: [cheap] }",
        "      - { model: claude-opus-4-8, tags: [strong] }",
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
        "budget:",
        "  usd: 1",
        "  scope: session",
        "  on_exceed:",
        "    action: degrade",
        "    model: claude-haiku-4-5",
      ].join("\n"),
    );
    expect(result.warnings.map((w) => w.code)).toEqual(["budget-degrade-outside-pool"]);
  });
});
