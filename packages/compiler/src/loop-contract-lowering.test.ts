/**
 * Loop contract 0.4 (Batch A) — lowering assertions for the new spec keys:
 * limits (+ crew sub-block), thinking (budget/effort), hooks, rate_limits,
 * streaming, compaction threshold/snip window, memory.embedder, graph
 * edges[].when + parallel, budget on the six newly-covered shapes, and
 * maxTokens everywhere agent-ish blocks gained it. Mirrors the existing
 * per-feature lowering test files (continuity-lowering, learning-lowering).
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { lower } from "./index";

const CLI_FULL = `
name: c
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
`;

describe("Batch A — cli lowering", () => {
  test("thinking/streaming/rateLimits/limits/hooks/compaction/memory.embedder all land in the IR", () => {
    const ir = lower(parseSpec(CLI_FULL));
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.agent.maxTokens).toBe(9000);
    expect(ir.agent.thinking).toEqual({ effort: "high" });
    expect(ir.agent.streaming).toBe(true);
    expect(ir.agent.rateLimits).toEqual({ Bash: { rpm: 30, burst: 5 }, "*": { rpm: 120 } });
    expect(ir.compaction.threshold).toBe(0.85);
    expect(ir.compaction.snipKeepHead).toBe(3);
    expect(ir.compaction.snipKeepTail).toBe(8);
    expect(ir.memory?.embedder).toBe("builtin:hash");
    expect(ir.limits).toEqual({
      maxToolIterations: 25,
      maxConcurrentTools: 4,
      contextLimit: 180_000,
      deadlineMs: 600_000,
      turnTimeoutMs: 120_000,
      modelCallTimeoutMs: 60_000,
      loopDetection: { window: 10, threshold: 3, escalation: "justify" },
    });
    expect(ir.hooks).toEqual([
      { event: "pre-tool", matcher: "Bash", command: "./guard.sh", timeoutMs: 3000 },
      { event: "session-start", command: "echo hi" },
    ]);
  });

  test("thinking budget form lowers to { budgetTokens }", () => {
    const ir = lower(
      parseSpec(
        "name: c\ntarget: cli\nagent:\n  model: m\n  instructions: i\n  thinking:\n    budget_tokens: 4096",
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.agent.thinking).toEqual({ budgetTokens: 4096 });
  });

  test("all new keys stay ABSENT when the spec omits them (spread-return-{} discipline)", () => {
    const ir = lower(parseSpec("name: c\ntarget: cli\nagent:\n  model: m\n  instructions: i"));
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect("thinking" in ir.agent).toBe(false);
    expect("streaming" in ir.agent).toBe(false);
    expect("rateLimits" in ir.agent).toBe(false);
    expect("limits" in ir).toBe(false);
    expect("hooks" in ir).toBe(false);
    expect("threshold" in ir.compaction).toBe(false);
    expect("snipKeepHead" in ir.compaction).toBe(false);
    expect("snipKeepTail" in ir.compaction).toBe(false);
  });
});

describe("Batch A — per-shape lowering", () => {
  test("channel agent gains maxTokens/thinking/rateLimits; top level gains limits/hooks", () => {
    const ir = lower(
      parseSpec(
        [
          "name: ch",
          "target: channel",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 12000",
          "  thinking:",
          "    effort: low",
          "  rate_limits:",
          "    SendMessage:",
          "      rpm: 6",
          "channels:",
          "  slack:",
          "    botToken: $SLACK_BOT_TOKEN",
          "    signingSecret: $SLACK_SIGNING_SECRET",
          "routing:",
          "  sessionKey: thread",
          "limits:",
          "  turn_timeout_ms: 90000",
          "hooks:",
          "  - event: post-tool",
          "    command: log",
        ].join("\n"),
      ),
    );
    if (ir.target !== "channel") throw new Error("unexpected target");
    expect(ir.agent.maxTokens).toBe(12_000);
    expect(ir.agent.thinking).toEqual({ effort: "low" });
    expect(ir.agent.rateLimits).toEqual({ SendMessage: { rpm: 6 } });
    expect(ir.limits).toEqual({ turnTimeoutMs: 90_000 });
    expect(ir.hooks).toEqual([{ event: "post-tool", command: "log" }]);
  });

  test("managed agent gains maxTokens/thinking/rateLimits; top level gains limits/hooks", () => {
    const ir = lower(
      parseSpec(
        [
          "name: mg",
          "target: managed",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 6000",
          "  thinking:",
          "    budget_tokens: 8192",
          "  rate_limits:",
          "    Bash:",
          "      rpm: 10",
          "tenants:",
          "  - id: t1",
          "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
          "limits:",
          "  max_tool_iterations: 15",
          "hooks:",
          "  - event: alert",
          "    command: notify",
        ].join("\n"),
      ),
    );
    if (ir.target !== "managed") throw new Error("unexpected target");
    expect(ir.agent.maxTokens).toBe(6000);
    expect(ir.agent.thinking).toEqual({ budgetTokens: 8192 });
    expect(ir.agent.rateLimits).toEqual({ Bash: { rpm: 10 } });
    expect(ir.limits).toEqual({ maxToolIterations: 15 });
    expect(ir.hooks).toEqual([{ event: "alert", command: "notify" }]);
  });

  test("workflow steps gain maxTokens/thinking; shape gains budget/limits/hooks", () => {
    const ir = lower(
      parseSpec(
        [
          "name: wf",
          "target: workflow",
          "model: m",
          "steps:",
          "  - name: one",
          "    instructions: do it",
          "    max_tokens: 9000",
          "    thinking:",
          "      effort: low",
          "  - name: two",
          "    instructions: then this",
          "budget:",
          "  usd: 2",
          "limits:",
          "  deadline_ms: 300000",
          "hooks:",
          "  - event: stop",
          "    command: echo done",
        ].join("\n"),
      ),
    );
    if (ir.target !== "workflow") throw new Error("unexpected target");
    expect(ir.steps[0]?.maxTokens).toBe(9000);
    expect(ir.steps[0]?.thinking).toEqual({ effort: "low" });
    expect(ir.steps[1]?.maxTokens).toBeUndefined();
    expect("thinking" in (ir.steps[1] ?? {})).toBe(false);
    expect(ir.budget).toEqual({ usdMicros: 2_000_000, onExceed: { kind: "stop" } });
    expect(ir.limits).toEqual({ deadlineMs: 300_000 });
    expect(ir.hooks).toEqual([{ event: "stop", command: "echo done" }]);
  });

  test("graph nodes gain maxTokens/thinking; edges gain when; shape gains parallel/budget/limits/hooks", () => {
    const ir = lower(
      parseSpec(
        [
          "name: g",
          "target: graph",
          "model: m",
          "entry: a",
          "nodes:",
          "  a:",
          "    instructions: do a",
          "    max_tokens: 2048",
          "    thinking:",
          "      budget_tokens: 2048",
          "  b:",
          "    instructions: do b",
          "  c:",
          "    instructions: do c",
          "edges:",
          "  - from: a",
          "    to: b",
          "    when:",
          "      key: a",
          "      equals: approve",
          "  - from: a",
          "    to: c",
          "    when:",
          "      key: a",
          "      exists: true",
          "parallel:",
          "  - [b, c]",
          "budget:",
          "  usd: 1",
          "limits:",
          "  max_tool_iterations: 5",
          "hooks:",
          "  - event: pre-model",
          "    command: trace",
        ].join("\n"),
      ),
    );
    if (ir.target !== "graph") throw new Error("unexpected target");
    expect(ir.nodes[0]?.maxTokens).toBe(2048);
    expect(ir.nodes[0]?.thinking).toEqual({ budgetTokens: 2048 });
    expect(ir.edges).toEqual([
      { from: "a", to: "b", when: { key: "a", equals: "approve" } },
      { from: "a", to: "c", when: { key: "a", exists: true } },
    ]);
    expect(ir.parallel).toEqual([["b", "c"]]);
    expect(ir.budget?.usdMicros).toBe(1_000_000);
    expect(ir.limits).toEqual({ maxToolIterations: 5 });
    expect(ir.hooks).toEqual([{ event: "pre-model", command: "trace" }]);
    // Absent-when-omitted: an edge without `when` carries no key.
    const plain = lower(
      parseSpec(
        [
          "name: g2",
          "target: graph",
          "model: m",
          "entry: a",
          "nodes:",
          "  a:",
          "    instructions: do a",
        ].join("\n"),
      ),
    );
    if (plain.target !== "graph") throw new Error("unexpected target");
    expect("parallel" in plain).toBe(false);
  });

  test("crew roles gain maxTokens/thinking; shape gains budget/limits (incl. crew sub-block)/hooks", () => {
    const ir = lower(
      parseSpec(
        [
          "name: cr",
          "target: crew",
          "model: m",
          "entry: lead",
          "roles:",
          "  lead:",
          "    instructions: lead it",
          "    max_tokens: 4096",
          "    thinking:",
          "      effort: medium",
          "budget:",
          "  usd: 3",
          "limits:",
          "  max_tool_iterations: 9",
          "  crew:",
          "    max_activations: 12",
          "    refusal_depth: 0",
          "    max_a2a_depth: 3",
          "hooks:",
          "  - event: pre-compact",
          "    command: snapshot",
        ].join("\n"),
      ),
    );
    if (ir.target !== "crew") throw new Error("unexpected target");
    expect(ir.roles[0]?.maxTokens).toBe(4096);
    expect(ir.roles[0]?.thinking).toEqual({ effort: "medium" });
    expect(ir.budget?.usdMicros).toBe(3_000_000);
    expect(ir.limits).toEqual({
      maxToolIterations: 9,
      crew: { maxActivations: 12, refusalDepth: 0, maxA2aDepth: 3 },
    });
    expect(ir.hooks).toEqual([{ event: "pre-compact", command: "snapshot" }]);
  });

  test("research/batch/browser agents gain maxTokens; shapes gain budget/limits/hooks", () => {
    const research = lower(
      parseSpec(
        [
          "name: re",
          "target: research",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 9000",
          "goal: learn",
          "budget:",
          "  usd: 4",
          "limits:",
          "  deadline_ms: 120000",
          "hooks:",
          "  - event: post-model",
          "    command: audit",
        ].join("\n"),
      ),
    );
    if (research.target !== "research") throw new Error("unexpected target");
    expect(research.agent.maxTokens).toBe(9000);
    expect(research.budget?.usdMicros).toBe(4_000_000);
    expect(research.limits).toEqual({ deadlineMs: 120_000 });
    expect(research.hooks).toEqual([{ event: "post-model", command: "audit" }]);

    const batch = lower(
      parseSpec(
        [
          "name: bt",
          "target: batch",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 7000",
          "queue:",
          "  adapter: in-memory",
          "budget:",
          "  usd: 5",
          "limits:",
          "  max_concurrent_tools: 2",
          "hooks:",
          "  - event: pre-slash",
          "    command: expand",
        ].join("\n"),
      ),
    );
    if (batch.target !== "batch") throw new Error("unexpected target");
    expect(batch.agent.maxTokens).toBe(7000);
    expect(batch.budget?.usdMicros).toBe(5_000_000);
    expect(batch.limits).toEqual({ maxConcurrentTools: 2 });
    expect(batch.hooks).toEqual([{ event: "pre-slash", command: "expand" }]);

    const browser = lower(
      parseSpec(
        [
          "name: br",
          "target: browser",
          "agent:",
          "  model: m",
          "  instructions: i",
          "  max_tokens: 5000",
          "budget:",
          "  usd: 6",
          "limits:",
          "  turn_timeout_ms: 45000",
          "hooks:",
          "  - event: post-compact",
          "    command: verify",
        ].join("\n"),
      ),
    );
    if (browser.target !== "browser") throw new Error("unexpected target");
    expect(browser.agent.maxTokens).toBe(5000);
    expect(browser.budget?.usdMicros).toBe(6_000_000);
    expect(browser.limits).toEqual({ turnTimeoutMs: 45_000 });
    expect(browser.hooks).toEqual([{ event: "post-compact", command: "verify" }]);
  });
});
