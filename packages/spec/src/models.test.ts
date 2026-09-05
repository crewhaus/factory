/**
 * 0.6.0 (design plan §4.1, §5, §6.2, §7.1, §7.3, §7.7, §11.1) — parse-level
 * tests for the per-model surface this PR adds to the spec:
 *   - the top-level `models:` profile registry on ALL 14 strict schemas and
 *     the `$<profile>` reference form on every model slot;
 *   - the profile-name grammar, the restricted per-profile `permissions`,
 *     `requires` with both size floors, `temperature` ⊕ `thinking`;
 *   - the widened `model_pool`: per-candidate profile fields, `enabled`,
 *     `policy: classifier`, `directives`, `rules`, `classifier`, `strategy`,
 *     `reward`, `scope`;
 *   - `evaluation.on_fail: escalate`, `allow_self_judge`, judge panels on
 *     the in-loop grader and the `kind: judge` gate (+ `escalate_to`);
 *   - graph-node routing, sub-agent routing, `crew.routing.model`,
 *     `mcp_servers.<n>.tool_flags`.
 *
 * The spec layer carries every new key VERBATIM (no zod defaults), so a spec
 * that omits them parses to exactly the 0.5.x object — pinned below.
 */
import { describe, expect, test } from "bun:test";
import {
  SPEC_PROFILE_NAME_RE,
  type SpecMcpToolFlags,
  type SpecModelPoolCandidate,
  type SpecModelPoolReward,
  type SpecModelPoolRule,
  type SpecModelPoolStrategy,
  type SpecModelProfile,
  type SpecModelsBlock,
  SpecParseError,
  type SpecProfilePermissions,
  parseSpec,
  parseSpecIssues,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODELS = [
  "models:",
  "  fast:",
  "    model: claude-haiku-4-5",
  "    tags: [cheap]",
  "  strong:",
  "    model: claude-opus-5",
  "    tags: [strong]",
].join("\n");

const cli = (...blocks: string[]): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", ...blocks].join("\n");

const cliAgent = (agentLines: string[], ...blocks: string[]): string =>
  [
    "name: c",
    "target: cli",
    "agent:",
    "  model: m",
    "  instructions: i",
    ...agentLines,
    ...blocks,
  ].join("\n");

const POOL_2 = [
  "  model_pool:",
  "    candidates:",
  "      - {model: claude-haiku-4-5, tags: [cheap]}",
  "      - {model: claude-opus-5, tags: [strong]}",
];

const channel = (...blocks: string[]): string =>
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
    ...blocks,
  ].join("\n");

const workflow = (...blocks: string[]): string =>
  [
    "name: w",
    "target: workflow",
    "model: m",
    "steps:",
    "  - name: draft",
    "    instructions: write",
    ...blocks,
  ].join("\n");

const graph = (...blocks: string[]): string =>
  [
    "name: g",
    "target: graph",
    "model: m",
    "entry: a",
    "nodes:",
    "  a:",
    "    instructions: x",
    ...blocks,
  ].join("\n");

const crew = (...blocks: string[]): string =>
  [
    "name: cr",
    "target: crew",
    "model: m",
    "entry: lead",
    "roles:",
    "  lead:",
    "    instructions: go",
    ...blocks,
  ].join("\n");

/** One minimal spec per target, each with a `models:` registry AND its primary slot set to `$fast`. */
const ALL_TARGETS_WITH_MODELS: Record<string, string> = {
  cli: `name: t\ntarget: cli\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\n`,
  workflow: `name: t\ntarget: workflow\n${MODELS}\nmodel: $fast\nsteps:\n  - name: s\n    instructions: go\n    model: $strong\n`,
  channel: `name: t\ntarget: channel\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nchannels:\n  slack:\n    botToken: xoxb-test\n    signingSecret: shh\nrouting:\n  sessionKey: thread\n`,
  graph: `name: t\ntarget: graph\n${MODELS}\nmodel: $fast\nentry: a\nnodes:\n  a:\n    instructions: go\n    model: $strong\nedges: []\n`,
  managed: `name: t\ntarget: managed\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\ntenants:\n  - id: t1\n    budget:\n      maxInputTokens: 100\n      maxOutputTokens: 100\n`,
  pipeline: `name: t\ntarget: pipeline\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nretrieve:\n  embedderModel: mock/det\nindexing:\n  documents:\n    - id: doc-1\n      text: hi\n`,
  crew: `name: t\ntarget: crew\n${MODELS}\nmodel: $fast\nentry: lead\nroles:\n  lead:\n    instructions: go\n    model: $strong\n`,
  research: `name: t\ntarget: research\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\ngoal: find things\n`,
  batch: `name: t\ntarget: batch\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nqueue:\n  adapter: in-memory\n`,
  voice: `name: t\ntarget: voice\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nvoice:\n  provider: openai\n`,
  browser: `name: t\ntarget: browser\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\ngroundingModel: $strong\n`,
  eval: `name: t\ntarget: eval\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\ndataset:\n  name: d\n  version: v1\ngraders:\n  - name: g\n`,
  onchain: `name: t\ntarget: onchain\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nchains:\n  - id: base\n    kind: evm\n    rpcUrls:\n      - https://rpc.example\n    finality:\n      kind: confirmations\n      count: 12\ncontracts:\n  - id: treasury\n    chainId: base\n    address: '0xtreasury'\n    abiRef: abi://safe\ntriggers:\n  - kind: event\n    chainId: base\n    contract: treasury\n    event: Transfer\n`,
  "onchain-game": `name: t\ntarget: onchain-game\n${MODELS}\nagent:\n  model: $fast\n  instructions: hi\nchain:\n  id: base\n  kind: evm\n  rpcUrls:\n    - https://rpc.example\n  finality:\n    kind: confirmations\n    count: 1\nwallet:\n  id: player\n  chainId: base\n  custody: local\ngame:\n  contract:\n    id: game\n    chainId: base\n    address: '0xgame'\n    abiRef: abi://game\n  stateReader: readState\n`,
};

const issuePaths = (yaml: string): string[] => parseSpecIssues(yaml).map((i) => i.path.join("."));

// ---------------------------------------------------------------------------
// §4.1 — the registry on every strict union member; the $ref form
// ---------------------------------------------------------------------------

describe("models: — the profile registry (0.6.0 §4.1)", () => {
  test("is accepted on EVERY target member of the strict union, with $fast at the primary slot", () => {
    // The `version` precedent: an optional field absent from any union member
    // would be rejected on that target only, so this iterates all 14.
    expect(Object.keys(ALL_TARGETS_WITH_MODELS)).toHaveLength(14);
    for (const [target, yaml] of Object.entries(ALL_TARGETS_WITH_MODELS)) {
      const spec = parseSpec(yaml);
      expect(spec.target).toBe(target as typeof spec.target);
      expect(spec.models).toBeDefined();
      expect(Object.keys(spec.models ?? {})).toEqual(["fast", "strong"]);
      expect(spec.models?.["fast"]?.model).toBe("claude-haiku-4-5");
      expect(spec.models?.["strong"]?.tags).toEqual(["strong"]);
      expect(issuePaths(yaml)).toEqual([]);
    }
  });

  test("BACK-COMPAT: a spec without models: parses with models undefined and NO new keys on the pool", () => {
    const spec = parseSpec(cliAgent(POOL_2));
    expect(spec.models).toBeUndefined();
    if (spec.target !== "cli") expect.unreachable();
    const pool = spec.agent.model_pool;
    // The parsed object is exactly the 0.5.x shape: only the keys the spec
    // defaults (`tags`, `policy`) appear; every 0.6.0 key stays ABSENT so the
    // lowering is byte-identical.
    expect(Object.keys(pool ?? {}).sort()).toEqual(["candidates", "policy"]);
    expect(Object.keys(pool?.candidates[0] ?? {}).sort()).toEqual(["model", "tags"]);
    expect(pool?.policy).toBe("heuristic");
    expect(spec.agent.temperature).toBeUndefined();
  });

  test("carries every profile field verbatim", () => {
    const spec = parseSpec(
      cli(
        "tools: [read, grep, glob, bash]",
        "mcp_servers:",
        "  github:",
        "    transport: stdio",
        "    command: gh-mcp",
        "models:",
        "  fast:",
        "    model: claude-haiku-4-5",
        "    tags: [cheap]",
        "    max_tokens: 4096",
        "    thinking: { effort: low }",
        "    instructions: You are the fast lane.",
        "    tools: [read, grep, glob, mcp__github__*]",
        "    tool_config: { fetch: { timeoutMs: 8000 } }",
        "    permissions: { deny: ['Bash(*)'], ask: ['Edit(*)'] }",
        "    rate_limits: { '*': { rpm: 60 } }",
        "    limits: { model_call_timeout_ms: 20000 }",
        "    caching: prefer",
        "    cost: { max_usd: 0.5 }",
        "    requires: { tool_use: true, context_window_gte: 200000, max_output_tokens_gte: 8192 }",
        "    capabilities: { vision: false, context_window: 128000 }",
        "    fallbacks: [openai/gpt-4o-mini]",
        "    circuit_breaker: { failureThreshold: 3 }",
        "  checker: { model: claude-sonnet-5, temperature: 0, tools: [] }",
      ),
    );
    const fast = spec.models?.["fast"];
    expect(fast?.max_tokens).toBe(4096);
    expect(fast?.thinking).toEqual({ effort: "low" });
    expect(fast?.instructions).toBe("You are the fast lane.");
    expect(fast?.tools).toEqual(["read", "grep", "glob", "mcp__github__*"]);
    expect(fast?.tool_config).toEqual({ fetch: { timeoutMs: 8000 } });
    expect(fast?.permissions).toEqual({ deny: ["Bash(*)"], ask: ["Edit(*)"] });
    expect(fast?.rate_limits).toEqual({ "*": { rpm: 60 } });
    expect(fast?.limits).toEqual({ model_call_timeout_ms: 20000 });
    expect(fast?.caching).toBe("prefer");
    expect(fast?.cost).toEqual({ max_usd: 0.5 });
    expect(fast?.requires).toEqual({
      tool_use: true,
      context_window_gte: 200000,
      max_output_tokens_gte: 8192,
    });
    expect(fast?.capabilities).toEqual({ vision: false, context_window: 128000 });
    expect(fast?.fallbacks).toEqual(["openai/gpt-4o-mini"]);
    expect(fast?.circuit_breaker).toEqual({ failureThreshold: 3 });
    expect(spec.models?.["checker"]?.temperature).toBe(0);
    expect(spec.models?.["checker"]?.tools).toEqual([]);
  });

  test("SPEC_PROFILE_NAME_RE is the documented lowercase-first grammar (duplicated in @crewhaus/model-plan)", () => {
    expect(SPEC_PROFILE_NAME_RE.source).toBe("^[a-z][a-z0-9_-]{0,63}$");
  });

  test.each([
    ["an uppercase first character", "Fast"],
    ["a leading digit", "1fast"],
    ["a dot", "fast.lane"],
    ["a space", "fast lane"],
    ["65 characters", `a${"b".repeat(64)}`],
    ["an env-ref-shaped name", "FAST_MODEL"],
  ])("rejects a profile name with %s", (_label, name) => {
    expect(() => parseSpec(cli("models:", `  "${name}": { model: claude-haiku-4-5 }`))).toThrow(
      SpecParseError,
    );
  });

  test("accepts the full lowercase grammar (letters, digits, '_' and '-', up to 64 chars)", () => {
    const name = `a${"b".repeat(63)}`;
    const spec = parseSpec(
      cli("models:", "  fast-lane_2: { model: claude-haiku-4-5 }", `  ${name}: { model: m }`),
    );
    expect(Object.keys(spec.models ?? {})).toEqual(["fast-lane_2", name]);
  });

  test("a profile's model must be a model string or sentinel — never another $profile", () => {
    const issues = parseSpecIssues(
      cli("models:", "  fast: { model: claude-haiku-4-5 }", "  alias: { model: $fast }"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["models.alias.model"]);
    expect(issues[0]?.message).toMatch(/profiles do not inherit from profiles/);
    // Sentinels are fine.
    expect(
      issuePaths(cli("models:", "  best: { model: strongest }", "  cheap: { model: cheapest }")),
    ).toEqual([]);
  });

  test("a profile's fallbacks name model strings, not $profiles", () => {
    expect(
      issuePaths(
        cli("models:", "  fast: { model: m }", "  strong: { model: m2, fallbacks: [$fast] }"),
      ),
    ).toEqual(["models.strong.fallbacks.0"]);
  });

  test("a profile rejects unknown keys (strict)", () => {
    expect(() => parseSpec(cli("models:", "  fast: { model: m, temprature: 0.2 }"))).toThrow(
      /Unrecognized key/,
    );
  });

  test("requires exposes the two size floors as context_window_gte / max_output_tokens_gte and rejects other spellings", () => {
    expect(() =>
      parseSpec(cli("models:", "  fast: { model: m, requires: { max_output_gte: 4096 } }")),
    ).toThrow(/Unrecognized key/);
    expect(() =>
      parseSpec(cli("models:", "  fast: { model: m, requires: { contextWindowGte: 4096 } }")),
    ).toThrow(/Unrecognized key/);
    expect(() =>
      parseSpec(cli("models:", "  fast: { model: m, requires: { context_window_gte: 0 } }")),
    ).toThrow(SpecParseError);
  });
});

describe("$profile references resolve at every model slot (0.6.0 §4.1)", () => {
  test("an unknown $ref names the nearest declared profile", () => {
    const issues = parseSpecIssues(
      cli("models:", "  fast: { model: claude-haiku-4-5 }", "compaction:", "  model: $fats"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(["compaction", "model"]);
    expect(issues[0]?.code).toBe("custom");
    expect(issues[0]?.message).toMatch(/unknown profile "\$fats" — did you mean "\$fast"\?/);
    expect(() =>
      parseSpec(cli("models:", "  fast: { model: m }", "compaction:", "  model: $fats")),
    ).toThrow(/did you mean "\$fast"/);
  });

  test("a $ref without any models: block is rejected with a pointer to the missing block", () => {
    const issues = parseSpecIssues(
      ["name: c", "target: cli", "agent:", "  model: $fast", "  instructions: i"].join("\n"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model"]);
    expect(issues[0]?.message).toMatch(/declares no models: block/);
  });

  test("a $ref whose name violates the grammar is rejected as such", () => {
    const issues = parseSpecIssues(
      cli("models:", "  fast: { model: m }", "compaction:", "  model: $Fast"),
    );
    expect(issues[0]?.message).toMatch(/not a valid profile reference/);
  });

  const M = ["models:", "  fast: { model: claude-haiku-4-5, tags: [cheap] }"];

  test.each<[string, string, string]>([
    [
      "cli agent.model_fallbacks[]",
      cliAgent(["  model_fallbacks: [$ghost]"], ...M),
      "agent.model_fallbacks.0",
    ],
    [
      "cli agent.model_tiers.fast",
      cliAgent(["  model_tiers: { fast: $ghost, default: m }"], ...M),
      "agent.model_tiers.fast",
    ],
    [
      "cli agent.model_pool.candidates[].model",
      cliAgent(
        [
          "  model_pool:",
          "    candidates:",
          "      - {model: $ghost, tags: [cheap]}",
          "      - {model: m2, tags: [strong]}",
        ],
        ...M,
      ),
      "agent.model_pool.candidates.0.model",
    ],
    [
      "cli agent.model_pool.candidates[].fallbacks[]",
      cliAgent(
        [
          "  model_pool:",
          "    candidates:",
          "      - {model: m1, tags: [cheap], fallbacks: [$ghost]}",
          "      - {model: m2, tags: [strong]}",
        ],
        ...M,
      ),
      "agent.model_pool.candidates.0.fallbacks.0",
    ],
    [
      "cli agent.sub_agents.<n>.model",
      cliAgent(
        [
          "  sub_agents:",
          "    helper:",
          "      description: d",
          "      instructions: i",
          "      model: $ghost",
        ],
        ...M,
      ),
      "agent.sub_agents.helper.model",
    ],
    ["cli compaction.model", cli(...M, "compaction:", "  model: $ghost"), "compaction.model"],
    [
      "cli security.justification.model",
      cli(...M, "security:", "  justification: { judge: claude, model: $ghost }"),
      "security.justification.model",
    ],
    [
      "cli budget.on_exceed.degrade.model",
      cli(...M, "budget:", "  usd: 1", "  on_exceed: { action: degrade, model: $ghost }"),
      "budget.on_exceed.model",
    ],
    [
      "cli evaluation.grader.model",
      cli(...M, "evaluation:", "  grader: { type: llm_judge, criteria: c, model: $ghost }"),
      "evaluation.grader.model",
    ],
    [
      "cli evaluation.grader.judges[]",
      cli(
        ...M,
        "evaluation:",
        "  grader: { type: llm_judge, criteria: c, judges: [$fast, $ghost] }",
      ),
      "evaluation.grader.judges.1",
    ],
    [
      "cli watchme.judge.model",
      cli(...M, "watchme:", "  judge: { model: $ghost }"),
      "watchme.judge.model",
    ],
    ["workflow model", workflow(...M).replace("model: m\n", "model: $ghost\n"), "model"],
    ["workflow steps[].model", workflow("    model: $ghost", ...M), "steps.0.model"],
    [
      "workflow judge step judge.model",
      workflow(
        "  - name: gate",
        "    kind: judge",
        "    judge: { criteria: c, model: $ghost }",
        ...M,
      ),
      "steps.1.judge.model",
    ],
    ["graph nodes.<n>.model", graph("    model: $ghost", ...M), "nodes.a.model"],
    [
      "graph judge node judge.judges[]",
      graph(
        "  gate:",
        "    kind: judge",
        "    judge: { criteria: c, judges: [$ghost] }",
        "edges: [{from: a, to: gate}]",
        ...M,
      ),
      "nodes.gate.judge.judges.0",
    ],
    ["crew roles.<n>.model", crew("    model: $ghost", ...M), "roles.lead.model"],
    ["crew routing.model", crew("routing: { kind: llm, model: $ghost }", ...M), "routing.model"],
    [
      "browser groundingModel",
      [
        "name: b",
        "target: browser",
        "agent: { model: m, instructions: i }",
        "groundingModel: $ghost",
        ...M,
      ].join("\n"),
      "groundingModel",
    ],
    [
      "channel agent.model",
      channel(...M).replace("  model: m\n", "  model: $ghost\n"),
      "agent.model",
    ],
    [
      "strategy.guide.model",
      cliAgent([...POOL_2, "    strategy: { guide: { model: $ghost } }"], ...M),
      "agent.model_pool.strategy.guide.model",
    ],
    [
      "strategy.shadow.candidate",
      cliAgent([...POOL_2, "    strategy: { shadow: { candidate: $ghost } }"], ...M),
      "agent.model_pool.strategy.shadow.candidate",
    ],
    [
      "strategy.shadow.grade_with",
      cliAgent(
        [...POOL_2, "    strategy: { shadow: { candidate: m3, grade_with: $ghost } }"],
        ...M,
      ),
      "agent.model_pool.strategy.shadow.grade_with",
    ],
    [
      "classifier.model",
      cliAgent(
        [
          ...POOL_2,
          "    policy: classifier",
          "    classifier: { model: $ghost, labels: { cheap: simple, strong: hard } }",
        ],
        ...M,
      ),
      "agent.model_pool.classifier.model",
    ],
  ])("an unresolved $ghost at %s is reported at that path", (_slot, yaml, path) => {
    const paths = issuePaths(yaml);
    expect(paths).toContain(path);
    expect(paths).toHaveLength(1);
  });

  test("the same slots accept a RESOLVING $ref", () => {
    const yaml = cli(
      "tools: [read]",
      "models:",
      "  fast: { model: claude-haiku-4-5, tags: [cheap] }",
      "  strong: { model: claude-opus-5, tags: [strong] }",
      "compaction: { model: $fast }",
      "budget: { usd: 1, on_exceed: { action: degrade, model: $fast } }",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: c, judges: [$strong, $fast], repeats: 3 }",
      "watchme: { judge: { model: $fast } }",
      "security: { justification: { judge: claude, model: $fast } }",
    );
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.compaction?.model).toBe("$fast");
    expect(spec.evaluation?.grader.type === "llm_judge" && spec.evaluation.grader.judges).toEqual([
      "$strong",
      "$fast",
    ]);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — the RESTRICTED per-profile permissions
// ---------------------------------------------------------------------------

describe("profile permissions are deny/ask ONLY (0.6.0 §5.4)", () => {
  test("accepts deny + ask lists", () => {
    const spec = parseSpec(
      cli("models:", "  fast: { model: m, permissions: { deny: ['Bash(*)'], ask: ['Edit(*)'] } }"),
    );
    expect(spec.models?.["fast"]?.permissions).toEqual({ deny: ["Bash(*)"], ask: ["Edit(*)"] });
  });

  test.each([
    ["alwaysAllow", "{ alwaysAllow: ['Bash(*)'] }"],
    ["allow", "{ allow: ['Bash(*)'] }"],
    ["mode", "{ mode: auto }"],
    ["ask_mode", "{ ask_mode: deny }"],
    [
      "rules (the permissionsBlock shape)",
      "{ rules: [{ type: alwaysAllow, pattern: 'Bash(*)' }] }",
    ],
  ])("REJECTS %s — a profile can only narrow the shape's permissions", (_label, block) => {
    expect(() => parseSpec(cli("models:", `  fast: { model: m, permissions: ${block} }`))).toThrow(
      /may only NARROW the shape's/,
    );
  });

  test("the same restriction applies to an inline pool candidate", () => {
    expect(() =>
      parseSpec(
        cliAgent([
          "  model_pool:",
          "    candidates:",
          "      - {model: m1, tags: [cheap], permissions: { mode: auto }}",
          "      - {model: m2, tags: [strong]}",
        ]),
      ),
    ).toThrow(/may only NARROW/);
  });
});

// ---------------------------------------------------------------------------
// §4.1 — temperature ⊕ thinking; the temperature knob on every block
// ---------------------------------------------------------------------------

describe("temperature (0.6.0 §4.1)", () => {
  test("is accepted on the agent, step, node, role, sub-agent and pooled single-agent blocks", () => {
    const c = parseSpec(cliAgent(["  temperature: 0.2"]));
    if (c.target !== "cli") expect.unreachable();
    expect(c.agent.temperature).toBe(0.2);
    const w = parseSpec(workflow("    temperature: 0"));
    if (w.target !== "workflow") expect.unreachable();
    expect(
      "temperature" in (w.steps[0] ?? {}) && (w.steps[0] as { temperature?: number }).temperature,
    ).toBe(0);
    const g = parseSpec(graph("    temperature: 1"));
    if (g.target !== "graph") expect.unreachable();
    expect((g.nodes["a"] as { temperature?: number }).temperature).toBe(1);
    const cr = parseSpec(crew("    temperature: 0.7"));
    if (cr.target !== "crew") expect.unreachable();
    expect(cr.roles["lead"]?.temperature).toBe(0.7);
    const sub = parseSpec(
      cliAgent(["  sub_agents:", "    h: { description: d, instructions: i, temperature: 0.3 }"]),
    );
    if (sub.target !== "cli") expect.unreachable();
    expect(sub.agent.sub_agents?.["h"]?.temperature).toBe(0.3);
    const r = parseSpec(
      [
        "name: r",
        "target: research",
        "agent: { model: m, instructions: i, temperature: 0.5 }",
        "goal: g",
      ].join("\n"),
    );
    if (r.target !== "research") expect.unreachable();
    expect(r.agent.temperature).toBe(0.5);
  });

  test("is range-checked to 0..2", () => {
    expect(() => parseSpec(cliAgent(["  temperature: 2.5"]))).toThrow(SpecParseError);
    expect(() => parseSpec(cliAgent(["  temperature: -0.1"]))).toThrow(SpecParseError);
  });

  test.each([
    ["the cli agent block", cliAgent(["  temperature: 0.2", "  thinking: { effort: low }"])],
    ["a workflow step", workflow("    temperature: 0.2", "    thinking: { effort: low }")],
    ["a graph node", graph("    temperature: 0.2", "    thinking: { effort: low }")],
    ["a crew role", crew("    temperature: 0.2", "    thinking: { effort: low }")],
    [
      "a sub-agent",
      cliAgent([
        "  sub_agents:",
        "    h: { description: d, instructions: i, temperature: 0.2, thinking: { effort: low } }",
      ]),
    ],
    [
      "a models: profile",
      cli("models:", "  fast: { model: m, temperature: 0.2, thinking: { effort: low } }"),
    ],
    [
      "a pool candidate",
      cliAgent([
        "  model_pool:",
        "    candidates:",
        "      - {model: m1, tags: [cheap], temperature: 0.2, thinking: { effort: low }}",
        "      - {model: m2, tags: [strong]}",
      ]),
    ],
  ])("is mutually exclusive with thinking on %s (the Anthropic 400)", (_label, yaml) => {
    expect(() => parseSpec(yaml)).toThrow(/temperature and thinking are mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// §5.2 — per-model tools are subset-only
// ---------------------------------------------------------------------------

describe("profile tools are subset-only (0.6.0 §5.2)", () => {
  test("a builtin outside the shape's declared tools is rejected, with the shape list in the message", () => {
    const issues = parseSpecIssues(
      cli("tools: [read, grep]", "models:", "  fast: { model: m, tools: [read, bash] }"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["models.fast.tools.1"]);
    expect(issues[0]?.message).toMatch(/not one of the shape's tools \(read, grep\)/);
  });

  test("a subset (including the empty list) is accepted", () => {
    expect(
      issuePaths(
        cli(
          "tools: [read, grep]",
          "models:",
          "  fast: { model: m, tools: [grep] }",
          "  judge: { model: m, tools: [] }",
        ),
      ),
    ).toEqual([]);
  });

  test("when the shape declares no tools list the subset check waits for the ir-pass (no issue)", () => {
    expect(issuePaths(cli("models:", "  fast: { model: m, tools: [read] }"))).toEqual([]);
  });

  test("an MCP selector must name a declared server and be well-formed", () => {
    const declared = ["mcp_servers:", "  github: { transport: stdio, command: gh }"];
    expect(
      issuePaths(
        cli(
          ...declared,
          "models:",
          "  fast: { model: m, tools: [mcp__github__*, mcp__github__list_issues] }",
        ),
      ),
    ).toEqual([]);
    const missing = parseSpecIssues(
      cli(...declared, "models:", "  fast: { model: m, tools: [mcp__jira__*] }"),
    );
    expect(missing[0]?.path).toEqual(["models", "fast", "tools", 0]);
    expect(missing[0]?.message).toMatch(
      /names MCP server "jira", which mcp_servers does not declare \(declared: github\)/,
    );
    const malformed = parseSpecIssues(
      cli(...declared, "models:", "  fast: { model: m, tools: [mcp__github] }"),
    );
    expect(malformed[0]?.message).toMatch(/not a valid MCP tool selector/);
  });

  test("Consult / Escalate exist only under strategy.model_directed: true", () => {
    const without = parseSpecIssues(
      cli("tools: [read]", "models:", "  fast: { model: m, tools: [read, Escalate] }"),
    );
    expect(without.map((i) => i.path.join("."))).toEqual(["models.fast.tools.1"]);
    expect(without[0]?.message).toMatch(/strategy\.model_directed: true/);
    const withDirected = cliAgent(
      [...POOL_2, "    strategy: { model_directed: true }"],
      "tools: [read]",
      "models:",
      "  fast: { model: m, tools: [read, Escalate, Consult] }",
    );
    expect(issuePaths(withDirected)).toEqual([]);
  });

  test("the pipeline shape registers no tool catalog, so a profile tools list is an error there", () => {
    const yaml = [
      "name: p",
      "target: pipeline",
      "agent: { model: m, instructions: i }",
      "retrieve: { embedderModel: e }",
      "indexing:",
      "  documents:",
      "    - { id: d1, text: hello }",
      "models:",
      "  fast: { model: m, tools: [read] }",
    ].join("\n");
    const issues = parseSpecIssues(yaml);
    expect(issues.map((i) => i.path.join("."))).toEqual(["models.fast.tools"]);
    expect(issues[0]?.message).toMatch(/registers no tool catalog/);
  });
});

// ---------------------------------------------------------------------------
// §7.1 — the hybrid model_pool
// ---------------------------------------------------------------------------

describe("model_pool — per-candidate profile fields and enabled (0.6.0 §7.1)", () => {
  test("a candidate carries every profile field inline plus enabled: false", () => {
    const spec = parseSpec(
      cliAgent([
        "  model_pool:",
        "    candidates:",
        "      - model: claude-haiku-4-5",
        "        tags: [cheap]",
        "        max_tokens: 2048",
        "        thinking: { budget_tokens: 2048 }",
        "        tools: []",
        "        cost: { max_usd: 0.1 }",
        "        requires: { vision: true }",
        "        fallbacks: [openai/gpt-4o-mini]",
        "        circuit_breaker: { failureThreshold: 2 }",
        "        caching: off",
        "      - { model: claude-opus-5, tags: [strong], enabled: false }",
        "      - { model: claude-sonnet-5, tags: [mid] }",
      ]),
    );
    if (spec.target !== "cli") expect.unreachable();
    const [c0, c1] = spec.agent.model_pool?.candidates ?? [];
    expect(c0?.max_tokens).toBe(2048);
    expect(c0?.thinking).toEqual({ budget_tokens: 2048 });
    expect(c0?.tools).toEqual([]);
    expect(c0?.cost).toEqual({ max_usd: 0.1 });
    expect(c0?.requires).toEqual({ vision: true });
    expect(c0?.fallbacks).toEqual(["openai/gpt-4o-mini"]);
    expect(c0?.caching).toBe("off");
    expect(c1?.enabled).toBe(false);
    expect(c0?.enabled).toBeUndefined();
  });

  test("enabled accepts ONLY the literal false (true is the absent default)", () => {
    expect(() =>
      parseSpec(
        cliAgent([
          "  model_pool:",
          "    candidates:",
          "      - { model: m1, tags: [cheap], enabled: true }",
          "      - { model: m2, tags: [strong] }",
        ]),
      ),
    ).toThrow(SpecParseError);
  });

  test("withdrawing EVERY candidate is an error", () => {
    const issues = parseSpecIssues(
      cliAgent([
        "  model_pool:",
        "    candidates:",
        "      - { model: m1, tags: [cheap], enabled: false }",
        "      - { model: m2, tags: [strong], enabled: false }",
      ]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.candidates"]);
  });

  test("a $profile candidate with no local tags inherits the profile's tags for role resolution", () => {
    const yaml = cliAgent(
      [
        "  model_pool:",
        "    candidates:",
        "      - { model: $fast }",
        "      - { model: $strong }",
        "    strategy: { cascade: { draft: cheap, escalate_to: strong } }",
      ],
      MODELS,
    );
    expect(issuePaths(yaml)).toEqual([]);
  });

  test("directives, scope and the four new policy values parse verbatim", () => {
    const spec = parseSpec(
      cliAgent([...POOL_2, "    directives: true", "    scope: main", "    policy: learned"]),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.model_pool?.directives).toBe(true);
    expect(spec.agent.model_pool?.scope).toBe("main");
    expect(spec.agent.model_pool?.policy).toBe("learned");
  });
});

describe("model_pool.policy: classifier ⇔ classifier block (0.6.0 §7.2.3)", () => {
  const CLASSIFIER =
    "    classifier: { model: $fast, labels: { cheap: simple lookup, strong: multi-step reasoning }, max_tokens: 16 }";

  test("policy: classifier with a classifier block whose labels are candidate tags is accepted", () => {
    const yaml = cliAgent([...POOL_2, "    policy: classifier", CLASSIFIER], MODELS);
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.model_pool?.classifier?.max_tokens).toBe(16);
  });

  test("policy: classifier without a classifier block is an error", () => {
    expect(issuePaths(cliAgent([...POOL_2, "    policy: classifier"]))).toEqual([
      "agent.model_pool.policy",
    ]);
  });

  test("a classifier block under another policy is an error (it would never run)", () => {
    const issues = parseSpecIssues(cliAgent([...POOL_2, CLASSIFIER], MODELS));
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.classifier"]);
    expect(issues[0]?.message).toMatch(/runs only under policy: classifier/);
  });

  test("a label that is not a candidate tag is rejected", () => {
    const issues = parseSpecIssues(
      cliAgent([
        ...POOL_2,
        "    policy: classifier",
        "    classifier: { model: m, labels: { cheap: a, medium: b } }",
      ]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "agent.model_pool.classifier.labels.medium",
    ]);
  });

  test("labels must be non-empty", () => {
    expect(() =>
      parseSpec(
        cliAgent([...POOL_2, "    policy: classifier", "    classifier: { model: m, labels: {} }"]),
      ),
    ).toThrow(/at least one <tag>: <description>/);
  });
});

describe("model_pool.rules (0.6.0 §7.2.2)", () => {
  test("accepts tag / $profile / requires targets and every when condition", () => {
    const yaml = cliAgent(
      [
        "  model_pool:",
        "    candidates:",
        "      - { model: $fast, tags: [cheap] }",
        "      - { model: $strong, tags: [strong] }",
        "    rules:",
        "      - { id: images-need-vision, when: { has_images: true }, use: { requires: { vision: true } } }",
        "      - { id: code-goes-strong, when: { message_matches: '(refactor|stack ?trace)' }, use: strong, enabled: true }",
        "      - { id: cheap-when-broke, when: { budget_spent_ratio_gt: 0.8 }, use: cheap }",
        "      - { id: long-context, when: { context_tokens_gt: 50000, user_text_chars_gt: 2000, tool_in_play: true, channel: support, turn_index_lt: 3 }, use: $strong, enabled: false }",
      ],
      MODELS,
    );
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "cli") expect.unreachable();
    const rules = spec.agent.model_pool?.rules ?? [];
    expect(rules).toHaveLength(4);
    expect(rules[0]?.use).toEqual({ requires: { vision: true } });
    expect(rules[3]?.enabled).toBe(false);
  });

  test("rule ids must be unique", () => {
    const issues = parseSpecIssues(
      cliAgent([
        ...POOL_2,
        "    rules:",
        "      - { id: r1, when: { has_images: true }, use: strong }",
        "      - { id: r1, when: { tool_in_play: true }, use: cheap }",
      ]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.rules.1.id"]);
  });

  test("when: needs at least one condition and message_matches must compile", () => {
    expect(() =>
      parseSpec(cliAgent([...POOL_2, "    rules:", "      - { id: r1, when: {}, use: strong }"])),
    ).toThrow(/requires at least one condition/);
    expect(() =>
      parseSpec(
        cliAgent([
          ...POOL_2,
          "    rules:",
          "      - { id: r1, when: { message_matches: '(' }, use: strong }",
        ]),
      ),
    ).toThrow(/not a valid regular expression/);
  });

  test("a string use: must be a candidate tag or a roster $profile", () => {
    const issues = parseSpecIssues(
      cliAgent([
        ...POOL_2,
        "    rules:",
        "      - { id: r1, when: { has_images: true }, use: stronk }",
      ]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.rules.0.use"]);
    expect(issues[0]?.message).toMatch(/did you mean "strong"\? candidate tags: cheap, strong/);
  });

  test("a declared profile that is NOT in the roster is rejected as a role target", () => {
    const issues = parseSpecIssues(
      cliAgent(
        [...POOL_2, "    rules:", "      - { id: r1, when: { has_images: true }, use: $fast }"],
        MODELS,
      ),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.rules.0.use"]);
    expect(issues[0]?.message).toMatch(/not one of this model_pool's candidates/);
  });
});

describe("model_pool.strategy (0.6.0 §7.3–§7.8)", () => {
  test("the full strategy block from the plan parses on a workflow step (a single-turn host)", () => {
    const yaml = workflow(
      "    model_pool:",
      "      candidates:",
      "        - { model: $fast, tags: [cheap] }",
      "        - { model: $strong, tags: [strong] }",
      "      strategy:",
      "        cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }",
      "        guide: { model: $strong, every: first_turn, max_tokens: 400, budget_usd: 0.2 }",
      "        shadow: { candidate: claude-sonnet-5, sample_rate: 0.1, grade_with: $strong }",
      "        committee: { members: [cheap, strong], judge: $strong, escalate_on_disagreement: strong }",
      "        model_directed: true",
      "        max_escalations: 1",
      MODELS,
    );
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "workflow") expect.unreachable();
    const step = spec.steps[0] as { model_pool?: { strategy?: SpecModelPoolStrategy } };
    expect(step.model_pool?.strategy?.cascade).toEqual({
      draft: "cheap",
      escalate_to: "strong",
      clean_prompt: true,
    });
    expect(step.model_pool?.strategy?.guide?.every).toBe("first_turn");
    expect(step.model_pool?.strategy?.max_escalations).toBe(1);
  });

  test("a cascade must escalate to a DIFFERENT rung", () => {
    const issues = parseSpecIssues(
      cliAgent([...POOL_2, "    strategy: { cascade: { draft: cheap, escalate_to: cheap } }"]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "agent.model_pool.strategy.cascade.escalate_to",
    ]);
  });

  test("a role slot naming an unknown tag is rejected with a did-you-mean", () => {
    const issues = parseSpecIssues(
      cliAgent([...POOL_2, "    strategy: { cascade: { draft: cheep, escalate_to: strong } }"]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "agent.model_pool.strategy.cascade.draft",
    ]);
    expect(issues[0]?.message).toMatch(/did you mean "cheap"/);
  });

  test("committee is a spec error on a REPL host (cli / channel / managed) and legal on steps, nodes and roles", () => {
    const repl = parseSpecIssues(
      cliAgent([...POOL_2, "    strategy: { committee: { members: [cheap, strong] } }"]),
    );
    expect(repl.map((i) => i.path.join("."))).toEqual(["agent.model_pool.strategy.committee"]);
    expect(repl[0]?.message).toMatch(/single-turn hosts only/);
    const ch = parseSpecIssues(
      channel().replace(
        "  instructions: i\n",
        `  instructions: i\n${[...POOL_2, "    strategy: { committee: { members: [cheap, strong] } }"].join("\n")}\n`,
      ),
    );
    expect(ch.map((i) => i.path.join("."))).toEqual(["agent.model_pool.strategy.committee"]);
    const node = graph(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "      strategy: { committee: { members: [cheap, strong] } }",
    );
    expect(issuePaths(node)).toEqual([]);
    const role = crew(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "      strategy: { committee: { members: [cheap, strong] } }",
    );
    expect(issuePaths(role)).toEqual([]);
  });

  test("committee members are at least two distinct role slots", () => {
    expect(() =>
      parseSpec(
        workflow(
          "    model_pool:",
          "      candidates:",
          "        - { model: m1, tags: [cheap] }",
          "        - { model: m2, tags: [strong] }",
          "      strategy: { committee: { members: [cheap] } }",
        ),
      ),
    ).toThrow(SpecParseError);
    const dup = parseSpecIssues(
      workflow(
        "    model_pool:",
        "      candidates:",
        "        - { model: m1, tags: [cheap] }",
        "        - { model: m2, tags: [strong] }",
        "      strategy: { committee: { members: [cheap, cheap] } }",
      ),
    );
    expect(dup.map((i) => i.path.join("."))).toEqual([
      "steps.0.model_pool.strategy.committee.members.1",
    ]);
  });

  test("shadow.candidate is an AUDITION model — a $ref must resolve but need not be in the roster", () => {
    expect(
      issuePaths(
        cliAgent(
          [...POOL_2, "    strategy: { shadow: { candidate: $fast, sample_rate: 0.1 } }"],
          MODELS,
        ),
      ),
    ).toEqual([]);
    expect(() =>
      parseSpec(
        cliAgent([...POOL_2, "    strategy: { shadow: { candidate: m3, sample_rate: 1.5 } }"]),
      ),
    ).toThrow(SpecParseError);
  });

  test("unknown strategy keys are rejected (strict)", () => {
    expect(() => parseSpec(cliAgent([...POOL_2, "    strategy: { race: true }"]))).toThrow(
      /Unrecognized key/,
    );
  });
});

describe("model_pool.reward (0.6.0 §6.3, §7.10)", () => {
  const EVAL = ["evaluation:", "  grader: { type: llm_judge, criteria: c }"];

  test("parses every field; in_loop with a floor and an in-loop grader is accepted", () => {
    const yaml = cliAgent(
      [
        ...POOL_2,
        "    reward:",
        "      quality_source: in_loop",
        "      priors: eval",
        "      floor: { arm: strong, confidence: 0.9, tolerance: 0.02 }",
        "      reset_on_profile_change: true",
      ],
      ...EVAL,
    );
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "cli") expect.unreachable();
    const reward: SpecModelPoolReward | undefined = spec.agent.model_pool?.reward;
    expect(reward).toEqual({
      quality_source: "in_loop",
      priors: "eval",
      floor: { arm: "strong", confidence: 0.9, tolerance: 0.02 },
      reset_on_profile_change: true,
    });
  });

  test("in_loop without a floor is an error", () => {
    const issues = parseSpecIssues(
      cliAgent([...POOL_2, "    reward: { quality_source: in_loop }"], ...EVAL),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.reward.quality_source"]);
    expect(issues[0]?.message).toMatch(/requires reward\.floor/);
  });

  test("in_loop without an in-loop grader on the shape is an error", () => {
    const issues = parseSpecIssues(
      cliAgent([...POOL_2, "    reward: { quality_source: in_loop, floor: { arm: strong } }"]),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["agent.model_pool.reward.quality_source"]);
    expect(issues[0]?.message).toMatch(/requires an in-loop grader/);
    // A workflow's grader is a `kind: judge` step.
    const wf = workflow(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "      reward: { quality_source: in_loop, floor: { arm: strong } }",
      "  - { name: gate, kind: judge, judge: { criteria: c } }",
    );
    expect(issuePaths(wf)).toEqual([]);
  });

  test("shadow / promoted / none need neither floor nor grader", () => {
    for (const source of ["none", "shadow", "promoted"]) {
      expect(
        issuePaths(cliAgent([...POOL_2, `    reward: { quality_source: ${source} }`])),
      ).toEqual([]);
    }
  });

  test("floor.arm is a role slot", () => {
    expect(issuePaths(cliAgent([...POOL_2, "    reward: { floor: { arm: ghost } }"]))).toEqual([
      "agent.model_pool.reward.floor.arm",
    ]);
  });
});

// ---------------------------------------------------------------------------
// §6.2 / §7.3 — evaluation and judge gates
// ---------------------------------------------------------------------------

describe("evaluation: on_fail: escalate, allow_self_judge, judge panels (0.6.0 §6.2, §7.3)", () => {
  test("on_fail: escalate requires agent.model_pool", () => {
    const issues = parseSpecIssues(
      cli("evaluation:", "  grader: { type: llm_judge, criteria: c }", "  on_fail: escalate"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["evaluation.on_fail"]);
    expect(issues[0]?.message).toMatch(/agent\.model_pool must be declared/);
    const ok = cliAgent(
      POOL_2,
      "evaluation:",
      "  grader: { type: llm_judge, criteria: c }",
      "  on_fail: escalate",
    );
    expect(issuePaths(ok)).toEqual([]);
    const spec = parseSpec(ok);
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.evaluation?.on_fail).toBe("escalate");
  });

  test("the llm_judge grader gains judges / repeats / temperature / target; allow_self_judge rides the block", () => {
    const spec = parseSpec(
      cli(
        "evaluation:",
        "  grader: { type: llm_judge, criteria: c, judges: [claude-opus-5, claude-sonnet-5], repeats: 3, temperature: 0, target: transcript }",
        "  allow_self_judge: true",
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    const grader = spec.evaluation?.grader;
    expect(grader?.type === "llm_judge" && grader.judges).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    expect(grader?.type === "llm_judge" && grader.repeats).toBe(3);
    expect(grader?.type === "llm_judge" && grader.temperature).toBe(0);
    expect(grader?.type === "llm_judge" && grader.target).toBe("transcript");
    expect(spec.evaluation?.allow_self_judge).toBe(true);
  });

  test("judges (a panel) and model (one judge) are mutually exclusive", () => {
    expect(() =>
      parseSpec(
        cli("evaluation:", "  grader: { type: llm_judge, criteria: c, model: m1, judges: [m2] }"),
      ),
    ).toThrow(/evaluation\.grader\.judges .* mutually exclusive/);
  });

  test("repeats is 1..9; the deterministic graders reject the panel fields", () => {
    expect(() =>
      parseSpec(cli("evaluation:", "  grader: { type: llm_judge, criteria: c, repeats: 0 }")),
    ).toThrow(SpecParseError);
    expect(() =>
      parseSpec(cli("evaluation:", "  grader: { type: contains, value: ok, repeats: 2 }")),
    ).toThrow(SpecParseError);
  });
});

describe("kind: judge gates gain the panel fields and escalate_to (0.6.0 §6.2, §7.3)", () => {
  const POOLED_STEP = [
    "    model_pool:",
    "      candidates:",
    "        - { model: m1, tags: [cheap] }",
    "        - { model: m2, tags: [strong] }",
  ];

  test("a workflow judge step carries judges / repeats / temperature / target / escalate_to", () => {
    const yaml = workflow(
      ...POOLED_STEP,
      "  - name: gate",
      "    kind: judge",
      "    judge: { criteria: c, judges: [m3, m4], repeats: 3, temperature: 0, target: output, escalate_to: strong }",
    );
    expect(issuePaths(yaml)).toEqual([]);
    const spec = parseSpec(yaml);
    if (spec.target !== "workflow") expect.unreachable();
    const gate = spec.steps[1];
    if (gate === undefined || !("kind" in gate)) expect.unreachable();
    expect(gate.judge.judges).toEqual(["m3", "m4"]);
    expect(gate.judge.repeats).toBe(3);
    expect(gate.judge.escalate_to).toBe("strong");
  });

  test("escalate_to needs the gated (previous) step to declare a model_pool", () => {
    const issues = parseSpecIssues(
      workflow("  - { name: gate, kind: judge, judge: { criteria: c, escalate_to: strong } }"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["steps.1.judge.escalate_to"]);
    expect(issues[0]?.message).toMatch(/the gated step "draft" declares no model_pool/);
  });

  test("escalate_to must be a tag (or roster $profile) of the gated step's pool", () => {
    const issues = parseSpecIssues(
      workflow(
        ...POOLED_STEP,
        "  - { name: gate, kind: judge, judge: { criteria: c, escalate_to: stronk } }",
      ),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["steps.1.judge.escalate_to"]);
    expect(issues[0]?.message).toMatch(/did you mean "strong"/);
  });

  test("a graph judge node's escalate_to is checked against the union of the graph's node pools", () => {
    const ok = graph(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "  gate:",
      "    kind: judge",
      "    judge: { criteria: c, escalate_to: strong }",
      "edges: [{from: a, to: gate}]",
    );
    expect(issuePaths(ok)).toEqual([]);
    const none = graph(
      "  gate:",
      "    kind: judge",
      "    judge: { criteria: c, escalate_to: strong }",
      "edges: [{from: a, to: gate}]",
    );
    expect(issuePaths(none)).toEqual(["nodes.gate.judge.escalate_to"]);
  });

  test("judges and model are mutually exclusive on a gate too", () => {
    expect(() =>
      parseSpec(
        workflow(
          "  - { name: gate, kind: judge, judge: { criteria: c, model: m1, judges: [m2] } }",
        ),
      ),
    ).toThrow(/judge\.judges .* mutually exclusive/);
  });
});

// ---------------------------------------------------------------------------
// §7.7 — graph nodes, sub-agents, crew routing
// ---------------------------------------------------------------------------

describe("graph nodes carry the routing blocks (0.6.0 §7.7)", () => {
  test("model_pool / model_tiers / model_fallbacks / circuit_breaker parse on a node", () => {
    const spec = parseSpec(
      graph(
        "    model_fallbacks: [m2]",
        "    circuit_breaker: { failureThreshold: 2 }",
        "  b:",
        "    instructions: y",
        "    model_tiers: { fast: m1, default: m2 }",
        "  c:",
        "    instructions: z",
        "    model_pool:",
        "      candidates:",
        "        - { model: m1, tags: [cheap] }",
        "        - { model: m2, tags: [strong] }",
        "edges: [{from: a, to: b}, {from: b, to: c}]",
      ),
    );
    if (spec.target !== "graph") expect.unreachable();
    const a = spec.nodes["a"] as { model_fallbacks?: string[]; circuit_breaker?: unknown };
    expect(a.model_fallbacks).toEqual(["m2"]);
    expect(a.circuit_breaker).toEqual({ failureThreshold: 2 });
    const c = spec.nodes["c"] as { model_pool?: { candidates: SpecModelPoolCandidate[] } };
    expect(c.model_pool?.candidates).toHaveLength(2);
  });

  test("shares the pool ⊕ tiers ⊕ fallbacks mutual-exclusion rule", () => {
    expect(() =>
      parseSpec(
        graph(
          "    model_tiers: { fast: m1, default: m2 }",
          "    model_pool:",
          "      candidates:",
          "        - { model: m1, tags: [cheap] }",
          "        - { model: m2, tags: [strong] }",
        ),
      ),
    ).toThrow(/mutually exclusive/);
  });
});

describe("sub-agents gain routing, params and the profile allowlist (0.6.0 §7.7)", () => {
  const SUB = (...lines: string[]): string =>
    cliAgent(
      ["  sub_agents:", "    helper:", "      description: d", "      instructions: i", ...lines],
      MODELS,
    );

  test("every new sub-agent key parses verbatim", () => {
    const spec = parseSpec(
      SUB(
        "      model_pool:",
        "        candidates:",
        "          - { model: $fast }",
        "          - { model: $strong }",
        "      thinking: { effort: low }",
        "      max_tokens: 1024",
        "      budget_share: 0.25",
        "      inherit_routing: true",
        "      allowed_profiles: [$fast, $strong]",
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    const helper = spec.agent.sub_agents?.["helper"];
    expect(helper?.model_pool?.candidates).toHaveLength(2);
    expect(helper?.thinking).toEqual({ effort: "low" });
    expect(helper?.max_tokens).toBe(1024);
    expect(helper?.budget_share).toBe(0.25);
    expect(helper?.inherit_routing).toBe(true);
    expect(helper?.allowed_profiles).toEqual(["$fast", "$strong"]);
  });

  test("model_tiers / model_fallbacks / circuit_breaker parse, and share the mutual-exclusion rule", () => {
    const spec = parseSpec(
      SUB("      model_fallbacks: [m2]", "      circuit_breaker: { cooldownMs: 100 }"),
    );
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.sub_agents?.["helper"]?.model_fallbacks).toEqual(["m2"]);
    expect(() =>
      parseSpec(
        SUB(
          "      model_fallbacks: [m2]",
          "      model_pool:",
          "        candidates:",
          "          - { model: $fast }",
          "          - { model: $strong }",
        ),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("allowed_profiles entries must be $profile refs that resolve", () => {
    const plain = parseSpecIssues(SUB("      allowed_profiles: [claude-haiku-4-5]"));
    expect(plain.map((i) => i.path.join("."))).toEqual([
      "agent.sub_agents.helper.allowed_profiles.0",
    ]);
    expect(plain[0]?.message).toMatch(/must be a \$profile reference/);
    const ghost = parseSpecIssues(SUB("      allowed_profiles: [$fast, $ghost]"));
    expect(ghost.map((i) => i.path.join("."))).toEqual([
      "agent.sub_agents.helper.allowed_profiles.1",
    ]);
  });

  test("budget_share is a fraction in (0, 1]", () => {
    expect(() => parseSpec(SUB("      budget_share: 1.5"))).toThrow(SpecParseError);
    expect(() => parseSpec(SUB("      budget_share: 0"))).toThrow(SpecParseError);
  });

  test("a sub-agent pool's candidate tools are checked against the sub-agent's own tools", () => {
    const issues = parseSpecIssues(
      SUB(
        "      tools: [read]",
        "      model_pool:",
        "        candidates:",
        "          - { model: $fast, tools: [bash] }",
        "          - { model: $strong }",
      ),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual([
      "agent.sub_agents.helper.model_pool.candidates.0.tools.0",
    ]);
  });
});

describe("crew.routing.model (0.6.0 §7.7)", () => {
  test("is accepted with kind: llm", () => {
    const spec = parseSpec(crew("routing: { kind: llm, model: $fast }", MODELS));
    if (spec.target !== "crew") expect.unreachable();
    expect(spec.routing?.model).toBe("$fast");
  });

  test("is an error with kind: match (a match router never calls a model)", () => {
    const issues = parseSpecIssues(
      crew("routing: { kind: match, model: m, match: { lead: [{ contains: x, to: lead }] } }"),
    );
    expect(issues.map((i) => i.path.join("."))).toEqual(["routing.model"]);
  });
});

// ---------------------------------------------------------------------------
// §5.5 — MCP tool_flags narrow only
// ---------------------------------------------------------------------------

describe("mcp_servers.<n>.tool_flags is narrowing-only (0.6.0 §5.5)", () => {
  const server = (flags: string): string =>
    cli(
      "mcp_servers:",
      "  github:",
      "    transport: stdio",
      "    command: gh",
      `    tool_flags: ${flags}`,
    );

  test("accepts defaults + per_tool in the tightening direction on both transports", () => {
    const spec = parseSpec(
      server(
        "{ defaults: { readOnly: true }, per_tool: { create_issue: { destructive: true, requireJustification: true } } }",
      ),
    );
    if (spec.target !== "cli") expect.unreachable();
    const flags: SpecMcpToolFlags = spec.mcp_servers?.["github"]?.tool_flags;
    expect(flags).toEqual({
      defaults: { readOnly: true },
      per_tool: { create_issue: { destructive: true, requireJustification: true } },
    });
    const sse = parseSpec(
      cli(
        "mcp_servers:",
        "  remote:",
        "    transport: sse",
        "    url: https://mcp.example",
        "    tool_flags: { defaults: { readOnly: true } }",
      ),
    );
    if (sse.target !== "cli") expect.unreachable();
    expect(sse.mcp_servers?.["remote"]?.tool_flags?.defaults?.readOnly).toBe(true);
  });

  test.each([
    ["readOnly: false", "{ defaults: { readOnly: false } }"],
    ["requireJustification: false", "{ per_tool: { x: { requireJustification: false } } }"],
    ["destructive: false", "{ defaults: { destructive: false } }"],
    ["scope: internal", "{ defaults: { scope: internal } }"],
    ["ioCapability", "{ defaults: { ioCapability: network } }"],
    ["classifyOutput", "{ per_tool: { x: { classifyOutput: false } } }"],
    ["an unknown top-level key", "{ perTool: {} }"],
  ])("REJECTS %s", (_label, flags) => {
    expect(() => parseSpec(server(flags))).toThrow(SpecParseError);
  });
});

// ---------------------------------------------------------------------------
// Types — the exported Spec* types cover the new blocks
// ---------------------------------------------------------------------------

describe("exported types", () => {
  test("the new Spec* types are usable as annotations", () => {
    const registry: SpecModelsBlock = { fast: { model: "claude-haiku-4-5", tags: ["cheap"] } };
    const profile: SpecModelProfile = {
      model: "m",
      temperature: 0.2,
      permissions: { deny: ["Bash(*)"] },
    };
    const permissions: SpecProfilePermissions = { ask: ["Edit(*)"] };
    const rule: SpecModelPoolRule = {
      id: "r",
      when: { has_images: true },
      use: { requires: { vision: true } },
    };
    const candidate: SpecModelPoolCandidate = { model: "$fast", tags: [], enabled: false };
    expect(registry["fast"]?.tags).toEqual(["cheap"]);
    expect(profile.temperature).toBe(0.2);
    expect(permissions.ask).toEqual(["Edit(*)"]);
    expect(typeof rule.use).toBe("object");
    expect(candidate.enabled).toBe(false);
  });
});
