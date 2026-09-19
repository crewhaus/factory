/**
 * Fixtures: the session records and spec texts the tests drive the tools
 * with.
 *
 * These are DATA, deliberately. Nothing here re-implements a rule, a
 * threshold or a path list - a fixture that computed what a rule should
 * decide would be testing itself. Every line shape here is the shape
 * `attachRoutingPersistence` and the runtime actually write, copied from the
 * advice package's own tests so a drift in the record format shows up as a
 * failing test here too.
 */

/** One session-JSONL record. */
export function line(kind: string, payload: unknown): unknown {
  return { ts: 1, version: 1, kind, payload };
}

/** Records as a JSONL blob, the way they sit on disk. */
export function jsonl(lines: ReadonlyArray<unknown>): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

/** `recovery` lines: `action: "continue"` is emitted only for truncations. */
export function recoveryLines(errorName: string, action: string, count: number): unknown[] {
  return Array.from({ length: count }, () => line("recovery", { errorName, action, depth: 1 }));
}

export function compactionLines(count: number): unknown[] {
  return Array.from({ length: count }, () =>
    line("compaction", { kind: "snip", before: 40, after: 20 }),
  );
}

export function toolStatsLines(tool: string, calls: number, errors: number): unknown[] {
  return Array.from({ length: calls }, (_, i) =>
    line("tool_stats", { toolName: tool, durationMs: 10, isError: i < errors }),
  );
}

/** A `model_stage` line as the routing persistence writes it. */
export function stageLine(
  stage: string,
  role: string,
  outcome: string,
  extra: Record<string, unknown> = {},
): unknown {
  return line("model_stage", { strategy: "cascade", stage, role, model: "m", outcome, ...extra });
}

/** A `model_route` line carrying the rule that forced the decision. */
export function routeLine(turnNumber: number, ruleId?: string): unknown {
  return line("model_route", {
    turnNumber,
    routeKey: "hard",
    model: "claude-haiku-4-5",
    policy: ruleId !== undefined ? "rule" : "heuristic",
    reason: "signals",
    ...(ruleId !== undefined ? { ruleId } : {}),
  });
}

/** 8 drafts, 6 of them escalated, every turn routed by one rule. */
export function noisyCascadeLines(ruleId = "code-goes-cheap"): unknown[] {
  const lines: unknown[] = [];
  for (let turn = 1; turn <= 8; turn++) {
    lines.push(routeLine(turn, ruleId));
    lines.push(stageLine("draft", "draft", "started", { turnNumber: turn }));
    if (turn <= 6) {
      lines.push(stageLine("escalate", "escalation", "started", { turnNumber: turn }));
      lines.push(stageLine("escalate", "escalation", "done", { turnNumber: turn }));
    }
  }
  return lines;
}

/** One reward-scoreboard arm, in the shape `buildAdviceContext` folds. */
export function arm(routeKey: string, model: string, n: number, meanReward: number) {
  return {
    routeKey,
    model,
    n,
    meanReward,
    varReward: 0.01,
    meanLatencyMs: 500,
    meanCostUsd: 0.01,
    costCount: n,
    meanQuality: 0,
    qualityCount: 0,
    ungraded: 0,
  };
}

/** Every POOL candidate past `n` samples in both bands. */
export function fullCoverageArms(n: number) {
  return [
    arm("hard", "claude-haiku-4-5", n, 0.3),
    arm("hard", "claude-sonnet-4-6", n, 0.75),
    arm("hard", "claude-opus-4-1", n, 0.8),
    arm("easy", "claude-haiku-4-5", n, 0.85),
    arm("easy", "claude-sonnet-4-6", n, 0.8),
    arm("easy", "claude-opus-4-1", n, 0.4),
  ];
}

/** A minimal cli spec, with a comment and a deliberate key order to protect. */
export const CLI_SPEC_YAML = [
  "# a spec a human maintains",
  "name: hello",
  "target: cli",
  "agent:",
  "  # the roster is human-owned",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "",
].join("\n");

/** The same spec with the tunable leaves already present. */
export const CLI_SPEC_TUNED_YAML = [
  "name: hello",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  max_tokens: 8192",
  "compaction:",
  "  curate: false",
  "",
].join("\n");

/** A pool with three candidates and the default (heuristic) policy. */
export const POOL_SPEC_YAML = [
  "name: pooled",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-sonnet-4-6, tags: [balanced] }",
  "      - { model: claude-opus-4-1, tags: [strong] }",
  "",
].join("\n");

/** A converged learned pool that never explores. */
export const LEARNED_POOL_SPEC_YAML = [
  "name: pooled",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  model_pool:",
  "    policy: learned",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-sonnet-4-6, tags: [balanced] }",
  "      - { model: claude-opus-4-1, tags: [strong] }",
  "",
].join("\n");

/**
 * A learned pool whose `learning` block carries the PINNED seed.
 *
 * §6.1's refusal only bites on a spec that actually has one, which is why the
 * fixture above (no seed) cannot stand in for it.
 */
export const SEEDED_POOL_SPEC_YAML = [
  "name: pooled",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  model_pool:",
  "    policy: learned",
  "    learning:",
  "      explorationRate: 0.1",
  '      seed: "run-1"',
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-sonnet-4-6, tags: [balanced] }",
  "",
].join("\n");

/** The same pool with a `learning` block that pins NOTHING. */
export const UNSEEDED_POOL_SPEC_YAML = SEEDED_POOL_SPEC_YAML.replace('      seed: "run-1"\n', "");

/** A pool carrying one routing rule, so the escalation rule can name it. */
export const RULED_SPEC_YAML = [
  "name: pooled",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-4-1, tags: [strong] }",
  "    rules:",
  '      - { id: code-goes-cheap, when: { message_matches: "code" }, use: cheap }',
  "",
].join("\n");

/** A channel spec: same tunable leaves as cli, a different allow-list row. */
export const CHANNEL_SPEC_YAML = [
  "name: chan",
  "target: channel",
  "channels:",
  "  slack:",
  "    botToken: $SLACK_BOT_TOKEN",
  "    signingSecret: $SLACK_SIGNING_SECRET",
  "routing:",
  "  sessionKey: channel",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: help",
  "  max_tokens: 4096",
  "",
].join("\n");
