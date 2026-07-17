/**
 * Loop contract 0.4 (Batch A) — end-to-end compile-fixture smoke over the
 * batch's whole new key surface in one place: limits (incl. the
 * loop_detection ladder), thinking, hooks, rate_limits, and graph
 * edges[].when + parallel. Where the per-feature tests pin lowering
 * (loop-contract-lowering) and the warnings table (warnings.test), this
 * file pins the CONTRACT the two sides add up to: a newly wired key
 * compiles with NO "accepted-but-unwired" warning AND its plumbing
 * actually lands in the emitted bundle bytes, while a still-unwired key
 * declared on the very same spec keeps warning. If an emitter regresses a
 * wired key back to dropped-on-the-floor, the bundle-content assertions
 * here catch what the (silent) warnings table cannot.
 */
import { describe, expect, test } from "bun:test";
import { type CompileWarning, compile } from "./index";

const paths = (warnings: ReadonlyArray<CompileWarning>): string[] =>
  warnings.map((w) => w.path).sort();

const bundleText = (files: ReadonlyArray<{ path: string; content: string }>): string =>
  files.map((f) => `// ---- ${f.path}\n${f.content}`).join("\n");

describe("Batch A smoke — cli carries the full wired surface, warning-free", () => {
  const CLI_SMOKE = `
name: smoke-cli
target: cli
agent:
  model: m
  instructions: i
  max_tokens: 9000
  thinking:
    effort: high
  streaming: true
  rate_limits:
    Bash:
      rpm: 30
      burst: 5
    "*":
      rpm: 120
compaction:
  threshold: 0.85
  snip_keep_head: 3
  snip_keep_tail: 8
memory:
  embedder: builtin:hash
limits:
  max_tool_iterations: 25
  max_concurrent_tools: 4
  context_limit: 180000
  deadline_ms: 600000
  turn_timeout_ms: 120000
  model_call_timeout_ms: 60000
  loop_detection:
    window: 10
    threshold: 3
    escalation: justify
hooks:
  - event: pre-tool
    matcher: Bash
    command: ./guard.sh
    timeout_ms: 3000
  - event: session-start
    command: echo hi
mcp_servers:
  fs:
    transport: stdio
    command: mcp-fs
`;

  test("compiles with zero warnings — every declared key is wired on cli", () => {
    const result = compile(CLI_SMOKE);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  test("the wired keys land as real runChatLoop plumbing in the bundle", () => {
    const text = bundleText(compile(CLI_SMOKE).files);
    // limits → 1:1 runtime knobs (G10 timers + G27 detector tuning).
    expect(text).toContain("maxToolIterations: 25,");
    expect(text).toContain("maxConcurrentTools: 4,");
    expect(text).toContain("contextLimit: 180000,");
    expect(text).toContain("deadlineMs: 600000,");
    expect(text).toContain("turnTimeoutMs: 120000,");
    expect(text).toContain("modelCallTimeoutMs: 60000,");
    expect(text).toContain('loopDetection: {"window":10,"threshold":3,"escalation":"justify"},');
    // agent knobs (G01 thinking, G17 rate limits, streaming, max_tokens).
    expect(text).toContain('thinking: {"effort":"high"},');
    expect(text).toContain('rateLimits: {"Bash":{"rpm":30,"burst":5},"*":{"rpm":120}},');
    expect(text).toContain("maxTokens: 9000,");
    // spec hooks boot below the settings.json layers (spec first).
    expect(text).toContain("const __specHooks = ");
    expect(text).toContain("[...__specHooks, ...__hooks]");
    expect(text).toContain('"event":"pre-tool"');
    // compaction tuning + memory.embedder fallback.
    expect(text).toContain("compactionThreshold: 0.85,");
    expect(text).toContain("snipKeepHead: 3,");
    expect(text).toContain("snipKeepTail: 8,");
    expect(text).toContain("builtin:hash");
  });
});

describe("Batch A smoke — graph when-edges + parallel compile into engine calls", () => {
  const GRAPH_SMOKE = `
name: smoke-graph
target: graph
model: m
entry: plan
nodes:
  plan:
    instructions: plan it
  fetch_a:
    instructions: fetch a
    thinking:
      effort: low
  fetch_b:
    instructions: fetch b
    thinking:
      budget_tokens: 2048
  judge:
    instructions: judge it
edges:
  - from: plan
    to: fetch_a
  - from: fetch_b
    to: judge
    when:
      key: plan
      equals: ship
  - from: fetch_b
    to: judge
    when:
      key: fetch_a
      exists: true
parallel:
  - [fetch_a, fetch_b]
limits:
  max_tool_iterations: 7
  deadline_ms: 90000
hooks:
  - event: stop
    command: echo done
`;

  test("compiles with zero warnings and reaches every node through the parallel barrier", () => {
    const result = compile(GRAPH_SMOKE);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  test("edges[].when lowers to EdgeCondition lambdas and parallel to addParallel", () => {
    const text = bundleText(compile(GRAPH_SMOKE).files);
    expect(text).toContain('.addParallel(["fetch_a", "fetch_b"])');
    expect(text).toContain('(__state) => (__state as Record<string, unknown>)["plan"] === "ship"');
    expect(text).toContain(
      '(__state) => (__state as Record<string, unknown>)["fetch_a"] !== undefined',
    );
    // Unconditional edge stays a bare addEdge (declaration order preserved).
    expect(text).toContain('.addEdge("plan", "fetch_a")');
    // Per-node thinking + limits thread into the node bodies.
    expect(text).toContain('thinking: {"effort":"low"},');
    expect(text).toContain('thinking: {"budgetTokens":2048},');
    expect(text).toContain("maxToolIterations: 7,");
    expect(text).toContain("deadlineMs:");
  });
});

describe("Batch A smoke — wired and unwired keys split correctly on one compile", () => {
  test("channel: limits/thinking/rate_limits/hooks stay silent while thredz still warns", () => {
    const result = compile(
      [
        "name: smoke-channel",
        "target: channel",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  thinking:",
        "    budget_tokens: 4096",
        "  rate_limits:",
        "    SendMessage:",
        "      rpm: 10",
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "routing:",
        "  sessionKey: thread",
        "limits:",
        "  turn_timeout_ms: 45000",
        "  loop_detection:",
        "    escalation: abort",
        "hooks:",
        "  - event: post-tool",
        "    command: ./audit.sh",
        "thredz: true",
      ].join("\n"),
    );
    expect(paths(result.warnings)).toEqual(["thredz"]);
    for (const w of result.warnings) {
      expect(w.code).toBe("accepted-but-unwired");
    }
    const text = bundleText(result.files);
    expect(text).toContain('thinking: {"budgetTokens":4096},');
    expect(text).toContain('rateLimits: {"SendMessage":{"rpm":10}},');
    expect(text).toContain("turnTimeoutMs: 45000,");
    expect(text).toContain('loopDetection: {"escalation":"abort"},');
    expect(text).toContain('"event":"post-tool"');
  });

  test("browser: limits + hooks emit plumbing while mcp_servers + continuity keep warning", () => {
    const result = compile(
      [
        "name: smoke-browser",
        "target: browser",
        "agent:",
        "  model: m",
        "  instructions: i",
        "limits:",
        "  deadline_ms: 120000",
        "  turn_timeout_ms: 60000",
        "hooks:",
        "  - event: session-start",
        "    command: echo up",
        "mcp_servers:",
        "  fs:",
        "    transport: stdio",
        "    command: mcp-fs",
        "continuity: true",
      ].join("\n"),
    );
    expect(paths(result.warnings)).toEqual(["continuity", "mcp_servers"]);
    const text = bundleText(result.files);
    expect(text).toContain("deadlineMs: 120000,");
    expect(text).toContain("turnTimeoutMs: 60000,");
    expect(text).toContain("SPEC_HOOKS");
    expect(text).toContain('"event":"session-start"');
  });
});
