/**
 * 0.6.0 PR 6 (spec surface) — the compiler's ONE interim guard for the whole
 * §11.1 spec delta, whose lowering lands with the IR widening (PR 7). Every
 * pending key is parse-ACCEPTED and compile-REFUSED with a path-precise
 * `CompilerError`, never a silently dropped key: a candidate declared with
 * `tools: []` + `permissions.deny` must not serve with the full toolset, a
 * grader declared with `judges` and no `model` must not become the serving
 * model judging itself, and `enabled: false` must not keep serving.
 *
 * Table-driven: one row per key family. Each row's spec PARSES (the guard is
 * downstream of the spec, so a parse issue would mask a hole) and `compile()`
 * throws naming the offending path. Absent config keeps lowering
 * byte-identical (the `index.test.ts` byte-pin fixtures cover that; the last
 * block here pins the 0.5.x-shaped twins of every guarded block compiling).
 *
 * PR 7 deletes this file together with `assertNoPending060Keys`.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { compile } from "./index";

const cli = (...blocks: string[]): string =>
  [
    "name: hello",
    "target: cli",
    "agent:",
    "  model: m",
    "  instructions: be helpful",
    ...blocks,
  ].join("\n");

const POOL_2 = [
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-5, tags: [strong] }",
];

/** A cli agent whose pool carries `extra` INSIDE the `model_pool` block. */
const cliPool = (...extra: string[]): string => cli(...POOL_2, ...extra);

/** A cli agent whose pool's FIRST candidate carries `fields` inline. */
const cliCandidate = (fields: string): string =>
  cli(
    "  model_pool:",
    "    candidates:",
    `      - { model: claude-haiku-4-5, tags: [cheap], ${fields} }`,
    "      - { model: claude-opus-5, tags: [strong] }",
  );

const cliSubAgent = (...fields: string[]): string =>
  cli(
    "  sub_agents:",
    "    helper:",
    "      description: helps",
    "      instructions: help",
    ...fields.map((f) => `      ${f}`),
  );

const workflow = (...blocks: string[]): string =>
  [
    "name: w",
    "target: workflow",
    "model: m",
    "steps:",
    "  - name: draft",
    "    instructions: write it",
    ...blocks,
  ].join("\n");

const STEP_POOL = [
  "    model_pool:",
  "      candidates:",
  "        - { model: m1, tags: [cheap] }",
  "        - { model: m2, tags: [strong] }",
];

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

/** [row name, spec yaml, the path the CompilerError must name] */
const PENDING: ReadonlyArray<readonly [string, string, RegExp]> = [
  // ---- §4.1 the registry -------------------------------------------------
  [
    "models: registry",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5 }",
      "agent:",
      "  model: $fast",
      "  instructions: be helpful",
    ].join("\n"),
    /^models: \(the model-profile registry\)/,
  ],
  // ---- §4.1 temperature on every agent-like block ------------------------
  ["agent.temperature (cli)", cli("  temperature: 0"), /^agent\.temperature/],
  ["steps[].temperature (workflow)", workflow("    temperature: 0.2"), /^steps\[0\]\.temperature/],
  ["nodes.<n>.temperature (graph)", graph("    temperature: 0.2"), /^nodes\.a\.temperature/],
  ["roles.<r>.temperature (crew)", crew("    temperature: 0.2"), /^roles\.lead\.temperature/],
  [
    "agent.temperature (pooled single-agent shape: research)",
    [
      "name: r",
      "target: research",
      "agent:",
      "  model: m",
      "  instructions: hi",
      "  temperature: 0",
      "goal: find things",
    ].join("\n"),
    /^agent\.temperature/,
  ],
  // ---- §7.1 model_pool hybrid siblings -----------------------------------
  [
    "model_pool.policy: classifier",
    cliPool(
      "    policy: classifier",
      "    classifier: { model: claude-haiku-4-5, labels: { cheap: simple, strong: hard } }",
    ),
    /^agent\.model_pool\.policy: classifier/,
  ],
  ["model_pool.directives", cliPool("    directives: true"), /^agent\.model_pool\.directives/],
  [
    "model_pool.rules",
    cliPool("    rules: [{ id: pics, when: { has_images: true }, use: strong }]"),
    /^agent\.model_pool\.rules/,
  ],
  [
    "model_pool.strategy (cascade)",
    cliPool("    strategy: { cascade: { draft: cheap, escalate_to: strong } }"),
    /^agent\.model_pool\.strategy/,
  ],
  [
    "model_pool.strategy (model_directed)",
    cliPool("    strategy: { model_directed: true }"),
    /^agent\.model_pool\.strategy/,
  ],
  [
    "model_pool.reward",
    cliPool("    reward: { quality_source: none, reset_on_profile_change: true }"),
    /^agent\.model_pool\.reward/,
  ],
  ["model_pool.scope", cliPool("    scope: chat"), /^agent\.model_pool\.scope/],
  // ---- §7.1 per-candidate profile fields + enabled -----------------------
  [
    "candidate enabled: false",
    cliCandidate("enabled: false"),
    /^agent\.model_pool\.candidates\[0\]\.enabled/,
  ],
  ["candidate tools: []", cliCandidate("tools: []"), /^agent\.model_pool\.candidates\[0\]\.tools/],
  [
    "candidate permissions.deny",
    cliCandidate("permissions: { deny: ['Bash(*)'] }"),
    /^agent\.model_pool\.candidates\[0\]\.permissions/,
  ],
  [
    "candidate max_tokens",
    cliCandidate("max_tokens: 512"),
    /^agent\.model_pool\.candidates\[0\]\.max_tokens/,
  ],
  [
    "candidate temperature",
    cliCandidate("temperature: 0"),
    /^agent\.model_pool\.candidates\[0\]\.temperature/,
  ],
  [
    "candidate thinking",
    cliCandidate("thinking: { budget_tokens: 2048 }"),
    /^agent\.model_pool\.candidates\[0\]\.thinking/,
  ],
  [
    "candidate instructions overlay",
    cliCandidate("instructions: be terse"),
    /^agent\.model_pool\.candidates\[0\]\.instructions/,
  ],
  [
    "candidate fallbacks",
    cliCandidate("fallbacks: [claude-sonnet-4-6]"),
    /^agent\.model_pool\.candidates\[0\]\.fallbacks/,
  ],
  // ---- §6.2 / §7.3 in-loop evaluation ------------------------------------
  [
    "evaluation.on_fail: escalate",
    cliPool(
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ),
    /^evaluation\.on_fail: escalate/,
  ],
  [
    "evaluation.allow_self_judge",
    cli(
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  allow_self_judge: true",
    ),
    /^evaluation\.allow_self_judge/,
  ],
  [
    "evaluation.grader.judges (panel, no model)",
    cli(
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful, judges: [claude-opus-5, claude-sonnet-4-6] }",
    ),
    /^evaluation\.grader\.judges/,
  ],
  [
    "evaluation.grader.repeats",
    cli("evaluation:", "  grader: { type: llm_judge, criteria: helpful, repeats: 3 }"),
    /^evaluation\.grader\.repeats/,
  ],
  [
    "evaluation.grader.temperature",
    cli("evaluation:", "  grader: { type: llm_judge, criteria: helpful, temperature: 0 }"),
    /^evaluation\.grader\.temperature/,
  ],
  [
    "evaluation.grader.target",
    cli("evaluation:", "  grader: { type: llm_judge, criteria: helpful, target: transcript }"),
    /^evaluation\.grader\.target/,
  ],
  // ---- §6.2 / §7.3 kind: judge gates (workflow + graph) ------------------
  [
    "steps[].judge.judges (workflow)",
    workflow("  - name: gate", "    kind: judge", "    judge: { criteria: c, judges: [m3, m4] }"),
    /^steps\[1\]\.judge\.judges/,
  ],
  [
    "steps[].judge.repeats (workflow)",
    workflow("  - name: gate", "    kind: judge", "    judge: { criteria: c, repeats: 3 }"),
    /^steps\[1\]\.judge\.repeats/,
  ],
  [
    "steps[].judge.temperature (workflow)",
    workflow("  - name: gate", "    kind: judge", "    judge: { criteria: c, temperature: 0 }"),
    /^steps\[1\]\.judge\.temperature/,
  ],
  [
    "steps[].judge.target (workflow)",
    workflow("  - name: gate", "    kind: judge", "    judge: { criteria: c, target: transcript }"),
    /^steps\[1\]\.judge\.target/,
  ],
  [
    "steps[].judge.escalate_to (workflow) — the gated step's pool fires first",
    workflow(
      ...STEP_POOL,
      "  - name: gate",
      "    kind: judge",
      "    judge: { criteria: c, escalate_to: strong }",
    ),
    // The walk is in step order: the gated step's own (0.5.x-shaped) pool
    // passes, then the gate's escalate_to is the first pending key.
    /^steps\[1\]\.judge\.escalate_to/,
  ],
  [
    "nodes.<n>.judge.repeats (graph)",
    graph(
      "  gate:",
      "    kind: judge",
      "    judge: { criteria: c, repeats: 3 }",
      "edges: [{from: a, to: gate}]",
    ),
    /^nodes\.gate\.judge\.repeats/,
  ],
  [
    "nodes.<n>.judge.judges (graph)",
    graph(
      "  gate:",
      "    kind: judge",
      "    judge: { criteria: c, judges: [m3, m4] }",
      "edges: [{from: a, to: gate}]",
    ),
    /^nodes\.gate\.judge\.judges/,
  ],
  // ---- §7.7 graph-node routing (nodes carried none before 0.6.0) ---------
  [
    "nodes.<n>.model_pool (graph)",
    graph(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
    ),
    /^nodes\.a\.model_pool/,
  ],
  [
    "nodes.<n>.model_tiers (graph)",
    graph("    model_tiers: { fast: m1, default: m2 }"),
    /^nodes\.a\.model_tiers/,
  ],
  [
    "nodes.<n>.model_fallbacks (graph)",
    graph("    model_fallbacks: [m1]"),
    /^nodes\.a\.model_fallbacks/,
  ],
  [
    "nodes.<n>.circuit_breaker (graph)",
    graph("    circuit_breaker: { failureThreshold: 3 }"),
    /^nodes\.a\.circuit_breaker/,
  ],
  // ---- §7.1 / §7.7 pools on steps and roles carry the same guard ---------
  [
    "steps[].model_pool.strategy (workflow)",
    workflow(...STEP_POOL, "      strategy: { cascade: { draft: cheap, escalate_to: strong } }"),
    /^steps\[0\]\.model_pool\.strategy/,
  ],
  [
    "roles.<r>.model_pool.directives (crew)",
    crew(
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "      directives: true",
    ),
    /^roles\.lead\.model_pool\.directives/,
  ],
  // ---- §7.7 sub-agent routing + params -----------------------------------
  [
    "sub_agents.<n>.model_pool",
    cliSubAgent(
      "model_pool:",
      "  candidates:",
      "    - { model: m1, tags: [cheap] }",
      "    - { model: m2, tags: [strong] }",
    ),
    /^agent\.sub_agents\.helper\.model_pool/,
  ],
  [
    "sub_agents.<n>.model_tiers",
    cliSubAgent("model_tiers: { fast: m1, default: m2 }"),
    /^agent\.sub_agents\.helper\.model_tiers/,
  ],
  [
    "sub_agents.<n>.model_fallbacks",
    cliSubAgent("model_fallbacks: [m1]"),
    /^agent\.sub_agents\.helper\.model_fallbacks/,
  ],
  [
    "sub_agents.<n>.circuit_breaker",
    cliSubAgent("circuit_breaker: { failureThreshold: 3 }"),
    /^agent\.sub_agents\.helper\.circuit_breaker/,
  ],
  [
    "sub_agents.<n>.thinking",
    cliSubAgent("thinking: { budget_tokens: 2048 }"),
    /^agent\.sub_agents\.helper\.thinking/,
  ],
  [
    "sub_agents.<n>.max_tokens",
    cliSubAgent("max_tokens: 512"),
    /^agent\.sub_agents\.helper\.max_tokens/,
  ],
  [
    "sub_agents.<n>.temperature",
    cliSubAgent("temperature: 0"),
    /^agent\.sub_agents\.helper\.temperature/,
  ],
  [
    "sub_agents.<n>.budget_share",
    cliSubAgent("budget_share: 0.25"),
    /^agent\.sub_agents\.helper\.budget_share/,
  ],
  [
    "sub_agents.<n>.inherit_routing",
    cliSubAgent("inherit_routing: true"),
    /^agent\.sub_agents\.helper\.inherit_routing/,
  ],
  // `allowed_profiles` entries must be resolving `$refs`, so the spec forces a
  // `models:` registry alongside — the registry check fires first. Pinned so
  // the row stays visibly covered rather than silently absent.
  [
    "sub_agents.<n>.allowed_profiles (registry fires first)",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5 }",
      ...cliSubAgent("allowed_profiles: [$fast]").split("\n").slice(2),
    ].join("\n"),
    /^models: /,
  ],
  [
    "roles.<r>.sub_agents.<n>.budget_share (crew)",
    crew(
      "    sub_agents:",
      "      helper:",
      "        description: helps",
      "        instructions: help",
      "        budget_share: 0.5",
    ),
    /^roles\.lead\.sub_agents\.helper\.budget_share/,
  ],
  // ---- §7.7 crew llm router model ----------------------------------------
  ["routing.model (crew)", crew("routing: { kind: llm, model: claude-opus-5 }"), /^routing\.model/],
  // ---- §5 item 5 MCP tool flags ------------------------------------------
  [
    "mcp_servers.<n>.tool_flags",
    cli(
      "mcp_servers:",
      "  fs:",
      "    transport: stdio",
      "    command: npx",
      "    tool_flags: { defaults: { readOnly: true } }",
    ),
    /^mcp_servers\.fs\.tool_flags/,
  ],
];

describe("0.6.0 interim compiler guard — every §11.1 key is parse-accepted and compile-refused until PR 7", () => {
  for (const [name, yaml, path] of PENDING) {
    test(name, () => {
      // The spec accepts it (a parse issue here would mask a guard hole) …
      expect(parseSpecIssues(yaml)).toEqual([]);
      // … and the compiler refuses to lower it, naming the path.
      expect(() => compile(yaml)).toThrow(CompilerError);
      expect(() => compile(yaml)).toThrow(/not yet lowered by this compiler/);
      expect(() => compile(yaml)).toThrow(path);
    });
  }

  test("the error names the landing (PR 7) and tells the author what to do", () => {
    expect(() => compile(cli("  temperature: 0"))).toThrow(/0\.6\.0 IR widening \(PR 7\)/);
    expect(() => compile(cli("  temperature: 0"))).toThrow(/remove it from the spec for now/);
  });
});

describe("0.6.0 interim compiler guard — the 0.5.x-shaped twins still compile (byte-identical path untouched)", () => {
  const OK: ReadonlyArray<readonly [string, string]> = [
    ["a plain pool", cliPool()],
    [
      "a pool with policy / objective / routing / learning",
      cliPool(
        "    policy: learned",
        "    objective: { quality: 1, cost: 0.5 }",
        "    routing: { strongTag: strong, cheapTag: cheap }",
        "    learning: { minSamplesPerArm: 2 }",
      ),
    ],
    [
      "an in-loop grader with model / threshold / on_fail / max_retries",
      cli(
        "evaluation:",
        "  grader: { type: llm_judge, criteria: helpful, model: claude-opus-5 }",
        "  threshold: 0.8",
        "  on_fail: retry",
        "  max_retries: 2",
      ),
    ],
    [
      "a judge step with model / threshold / on_fail / max_retries",
      workflow(
        ...STEP_POOL,
        "  - name: gate",
        "    kind: judge",
        "    judge: { criteria: c, model: m3, threshold: 0.8, on_fail: halt, max_retries: 2 }",
      ),
    ],
    [
      "a graph judge node and a node with max_tokens + thinking",
      graph(
        "    max_tokens: 512",
        "    thinking: { budget_tokens: 2048 }",
        "  gate:",
        "    kind: judge",
        "    judge: { criteria: c }",
        "edges: [{from: a, to: gate}]",
      ),
    ],
    [
      "a sub-agent with the 0.5.x keys",
      cliSubAgent("tools: [read]", "model: m2", "permissions: scoped", "inherit_bypass: false"),
    ],
    [
      "a crew match router",
      crew("routing: { kind: match, match: { lead: [{ contains: hi, to: lead }] } }"),
    ],
    [
      "an MCP server without tool_flags",
      cli("mcp_servers:", "  fs:", "    transport: stdio", "    command: npx"),
    ],
  ];
  for (const [name, yaml] of OK) {
    test(name, () => {
      expect(parseSpecIssues(yaml)).toEqual([]);
      expect(parseSpec(yaml).models).toBeUndefined();
      expect(compile(yaml).files.length).toBeGreaterThan(0);
    });
  }
});
