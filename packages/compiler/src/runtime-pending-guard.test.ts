/**
 * 0.6.0 PR 7 introduced the residual runtime-pending guard: PR 6 refused the
 * WHOLE §11.1 spec delta at compile time, PR 7 lowered it and kept refusing
 * the keys whose runtime consumer had not landed. PR 9a landed the
 * per-candidate plan table, so a `model_pool` CANDIDATE's narrowing knobs —
 * `tools` / `tool_config` / `permissions` / `rate_limits` / `cost`, inline or
 * inherited from a `$profile` — now COMPILE THROUGH on every pool-bearing
 * slot (agent, step, node, role, sub-agent): runtime-core builds one plan per
 * candidate from the pool blob at boot (subset advertisement + dispatch gate,
 * narrowed permissions, rate buckets, per-call tool_config, spend cap). The
 * `HONOURED` rows pin that: each parses, `compile()` succeeds, the key rides
 * the emitted pool blob, and no `model-plan-pending-runtime` warning names it.
 *
 * What is STILL refused (the `REFUSED` rows): `evaluation.on_fail: escalate`
 * and `judge.escalate_to` (PR 9c), `mcp_servers.<n>.tool_flags` (no PR-train
 * row for its IR + emit half yet), and a narrowing profile referenced from a
 * SINGLE-MODEL serving slot — the IR has no per-candidate plan carrier for a
 * slot that routes no pool, so accepting `models.fast: { tools: [] }` behind
 * `agent.model: $fast` would serve with the full toolset. Every refused row
 * still parses, `compile()` refuses it naming the path and the landing row,
 * and `lower()` with `allowRuntimePendingKeys` carries it into the IR with a
 * `model-plan-pending-runtime` warning. The landing PR deletes its row here.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import { parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { compile, lower, lowerWithWarnings } from "./index";

const cli = (...blocks: string[]): string =>
  [
    "name: hello",
    "target: cli",
    "agent:",
    "  model: m",
    "  instructions: be helpful",
    ...blocks,
  ].join("\n");

const cliCandidate = (fields: string): string =>
  cli(
    "  model_pool:",
    "    candidates:",
    `      - { model: claude-haiku-4-5, tags: [cheap], ${fields} }`,
    "      - { model: claude-opus-4-8, tags: [strong] }",
    "tools: [read, fetch]",
  );

/**
 * PR 9a — [row, spec, the blob probe, emitted?]: every candidate narrowing
 * knob compiles through and rides the pool blob verbatim. `emitted` is false
 * for the sub-agent rows: a sub-agent's pool is lowered but not rendered into
 * a bundle until the spawner consumes it (PR 11), so those probe the IR only.
 */
const HONOURED: ReadonlyArray<
  | readonly [string, string, (json: string) => boolean]
  | readonly [string, string, (json: string) => boolean, false]
> = [
  ["candidate tools", cliCandidate("tools: [read]"), (j) => j.includes('"tools":["read"]')],
  [
    "candidate tools: [] (zero shape tools)",
    cliCandidate("tools: []"),
    (j) => j.includes('"tools":[]'),
  ],
  [
    "candidate tool_config",
    cliCandidate("tool_config: { fetch: { timeoutMs: 8000 } }"),
    (j) => j.includes('"toolConfigs":{"fetch":{"timeoutMs":8000}}'),
  ],
  [
    "candidate permissions",
    cliCandidate("permissions: { deny: ['Bash(*)'] }"),
    (j) => j.includes('"permissions":{"deny":["Bash(*)"]}'),
  ],
  [
    "candidate rate_limits",
    cliCandidate("rate_limits: { '*': { rpm: 60 } }"),
    (j) => j.includes('"rateLimits":{"*":{"rpm":60}}'),
  ],
  [
    "candidate cost",
    cliCandidate("cost: { max_usd: 0.5 }"),
    (j) => j.includes('"costCapUsdMicros":500000'),
  ],
  [
    "a $profile candidate inheriting the profile's tools / permissions (agent pool)",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5, tools: [], permissions: { deny: ['Bash(*)'] } }",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: $fast, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "tools: [read, fetch]",
    ].join("\n"),
    (j) => j.includes('"profile":"fast","tools":[],"permissions":{"deny":["Bash(*)"]}'),
  ],
  [
    "a $profile candidate inheriting the profile's rate_limits (workflow step pool)",
    [
      "name: w",
      "target: workflow",
      "models:",
      "  fast: { model: claude-haiku-4-5, rate_limits: { '*': { rpm: 60 } } }",
      "model: m",
      "steps:",
      "  - name: draft",
      "    instructions: write it",
      "    model_pool:",
      "      candidates:",
      "        - { model: $fast, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
    ].join("\n"),
    (j) => j.includes('"profile":"fast","rateLimits":{"*":{"rpm":60}}'),
  ],
  [
    "a $profile candidate inheriting the profile's cost cap (graph node pool)",
    [
      "name: g",
      "target: graph",
      "models:",
      "  fast: { model: claude-haiku-4-5, cost: { max_usd: 0.5 } }",
      "model: m",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: x",
      "    model_pool:",
      "      candidates:",
      "        - { model: $fast, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
    ].join("\n"),
    (j) => j.includes('"profile":"fast","costCapUsdMicros":500000'),
  ],
  [
    "a $profile candidate inheriting the profile's tool_config (crew role pool)",
    [
      "name: c",
      "target: crew",
      "models:",
      "  fast: { model: claude-haiku-4-5, tool_config: { fetch: { timeoutMs: 8000 } } }",
      "model: m",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: go",
      "    model_pool:",
      "      candidates:",
      "        - { model: $fast, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
    ].join("\n"),
    (j) => j.includes('"profile":"fast","toolConfigs":{"fetch":{"timeoutMs":8000}}'),
  ],
  [
    "a $profile candidate inheriting the profile's tools: [] (sub-agent pool)",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5, tools: [] }",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  sub_agents:",
      "    helper:",
      "      description: helps",
      "      instructions: help",
      "      tools: [read]",
      "      model_pool:",
      "        candidates:",
      "          - { model: $fast, tags: [cheap] }",
      "          - { model: m2, tags: [strong] }",
      "tools: [read]",
    ].join("\n"),
    (j) => j.includes('"profile":"fast","tools":[]'),
    false,
  ],
  [
    "sub_agents.<n>.model_pool candidate tools",
    cli(
      "  sub_agents:",
      "    helper:",
      "      description: helps",
      "      instructions: help",
      "      tools: [read]",
      "      model_pool:",
      "        candidates:",
      "          - { model: m1, tags: [cheap], tools: [read] }",
      "          - { model: m2, tags: [strong] }",
      "tools: [read]",
    ),
    (j) => j.includes('"tools":["read"]'),
    false,
  ],
];

/** [row, spec, the refused path, the IR probe once lowered with the bypass] */
const REFUSED: ReadonlyArray<readonly [string, string, RegExp, (json: string) => boolean]> = [
  [
    "a narrowing profile referenced from the serving agent slot",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5, tools: [read] }",
      "agent:",
      "  model: $fast",
      "  instructions: i",
      "tools: [read, fetch]",
    ].join("\n"),
    /^models\.fast\.tools \(referenced from agent\.model\)/,
    (j) => j.includes('"modelProfile":"fast"'),
  ],
  [
    "evaluation.on_fail: escalate",
    cli(
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ),
    /^evaluation\.on_fail: escalate/,
    (j) => j.includes('"onFail":"escalate"'),
  ],
  [
    "steps[].judge.escalate_to (workflow)",
    [
      "name: w",
      "target: workflow",
      "model: m",
      "steps:",
      "  - name: draft",
      "    instructions: write it",
      "    model_pool:",
      "      candidates:",
      "        - { model: m1, tags: [cheap] }",
      "        - { model: m2, tags: [strong] }",
      "  - name: gate",
      "    kind: judge",
      "    judge: { criteria: c, escalate_to: strong }",
    ].join("\n"),
    /^steps\[1\]\.judge\.escalate_to/,
    (j) => j.includes('"escalateTo":"strong"'),
  ],
];

describe("0.6.0 PR 9a — a pool candidate's narrowing knobs compile through to the plan table", () => {
  for (const [name, yaml, probe, emitted] of HONOURED) {
    test(`${name}: parses, compile() succeeds, the key rides the pool blob, nothing pends on it`, () => {
      expect(parseSpecIssues(yaml)).toEqual([]);
      const result = compile(yaml);
      expect(result.files.length).toBeGreaterThan(0);
      const bundle = result.files.map((f) => f.content).join("\n");
      // The key reaches the emitted pool blob (what runtime-core boots from).
      if (emitted !== false) expect(probe(bundle)).toBe(true);
      expect(probe(JSON.stringify(lower(parseSpec(yaml))))).toBe(true);
      // No warning claims the narrowing knob is inert.
      const inert = result.warnings.filter(
        (w) =>
          w.code === "model-plan-pending-runtime" &&
          /\.(tools|tool_config|permissions|rate_limits|cost)\b/.test(w.path),
      );
      expect(inert).toEqual([]);
    });
  }
});

describe("0.6.0 PR 7 residual guard — the keys whose runtime has not landed stay refused", () => {
  for (const [name, yaml, path, probe] of REFUSED) {
    test(`${name}: parses, compile() refuses naming the path, lower({allowRuntimePendingKeys}) carries it`, () => {
      expect(parseSpecIssues(yaml)).toEqual([]);
      expect(() => compile(yaml)).toThrow(CompilerError);
      expect(() => compile(yaml)).toThrow(/does not enforce it yet/);
      expect(() => compile(yaml)).toThrow(path);
      expect(() => lower(parseSpec(yaml))).toThrow(path);
      const { ir, warnings } = lowerWithWarnings(parseSpec(yaml), {
        allowRuntimePendingKeys: true,
      });
      expect(probe(JSON.stringify(ir))).toBe(true);
      expect(warnings.some((w) => w.code === "model-plan-pending-runtime")).toBe(true);
    });
  }

  test("the single-slot refusal tells the author the pool candidate honours the same profile", () => {
    const yaml = [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5, tools: [read] }",
      "agent:",
      "  model: $fast",
      "  instructions: i",
      "tools: [read, fetch]",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(/single-model serving slot/);
    expect(() => compile(yaml)).toThrow(/declare the profile as a model_pool candidate/);
    expect(() => compile(yaml)).toThrow(/remove it from the spec for now/);
  });

  test("mcp_servers.<n>.tool_flags stays refused (no IR + emit row yet)", () => {
    const yaml = cli(
      "mcp_servers:",
      "  fs:",
      "    transport: stdio",
      "    command: npx",
      "    tool_flags: { defaults: { readOnly: true } }",
    );
    expect(parseSpecIssues(yaml)).toEqual([]);
    expect(() => compile(yaml)).toThrow(/^mcp_servers\.fs\.tool_flags/);
  });

  test("a narrowing profile referenced from an AUXILIARY slot is not refused — the fields are meaningless there and warned", () => {
    const yaml = [
      "name: hello",
      "target: cli",
      "models:",
      "  checker: { model: claude-haiku-4-5, tools: [], permissions: { deny: ['Bash(*)'] } }",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "tools: [read]",
      "compaction: { model: $checker }",
    ].join("\n");
    const result = compile(yaml);
    expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
      ["model-plan-ignored-on-slot", "models.checker.permissions"],
    ]);
  });
});

describe("the 0.5.x-shaped twins compile untouched", () => {
  const OK: ReadonlyArray<readonly [string, string]> = [
    [
      "a plain pool with policy / objective / routing / learning",
      cli(
        "  model_pool:",
        "    policy: learned",
        "    candidates:",
        "      - { model: claude-haiku-4-5, tags: [cheap] }",
        "      - { model: claude-opus-4-8, tags: [strong] }",
        "    objective: { quality: 1, cost: 0.5 }",
        "    routing: { strongTag: strong, cheapTag: cheap }",
        "    learning: { minSamplesPerArm: 2 }",
      ),
    ],
    [
      "an in-loop grader with model / threshold / on_fail / max_retries",
      cli(
        "evaluation:",
        "  grader: { type: llm_judge, criteria: helpful, model: claude-opus-4-8 }",
        "  threshold: 0.8",
        "  on_fail: retry",
        "  max_retries: 2",
      ),
    ],
    [
      "an MCP server without tool_flags",
      cli("mcp_servers:", "  fs:", "    transport: stdio", "    command: npx"),
    ],
  ];
  for (const [name, yaml] of OK) {
    test(name, () => {
      expect(parseSpecIssues(yaml)).toEqual([]);
      const result = compile(yaml);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
    });
  }
});
