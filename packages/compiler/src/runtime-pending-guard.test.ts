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
 * PR 9c landed the cascade, so `evaluation.on_fail: escalate` (with its
 * lower-time-resolved `escalateTo`) and `judge.escalate_to` now COMPILE
 * THROUGH too (the `CASCADE` rows): runtime-core's `runEvaluatedTurn` re-runs
 * a failing turn on the escalation rung, and the workflow / graph retry
 * closures force the `retry_previous` re-run onto `escalate_to`.
 *
 * What is STILL refused (the `REFUSED` rows): `mcp_servers.<n>.tool_flags` (no
 * PR-train row for its IR + emit half yet), and a narrowing profile referenced
 * from a SINGLE-MODEL serving slot — the IR has no per-candidate plan carrier
 * for a slot that routes no pool, so accepting `models.fast: { tools: [] }`
 * behind `agent.model: $fast` would serve with the full toolset. Every refused
 * row still parses, `compile()` refuses it naming the path and the landing
 * row, and `lower()` with `allowRuntimePendingKeys` carries it into the IR
 * with a `model-plan-pending-runtime` warning. The landing PR deletes its row
 * here.
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
 * knob compiles through and rides the pool blob verbatim. Since PR 11 the
 * sub-agent rows are emitted too (the `__subAgents` literal carries the child's
 * `modelPool`), so every row probes the bundle; the optional fourth element is
 * kept for a future IR-only row.
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
];

/** PR 9c — [row, spec, the IR probe, the emitted-bundle probe]: the cascade keys compile through. */
const CASCADE: ReadonlyArray<
  readonly [string, string, (json: string) => boolean, (bundle: string) => boolean]
> = [
  [
    "evaluation.on_fail: escalate with a declared cascade escalate_to (a tag)",
    cli(
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "    strategy:",
      "      cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }",
      "      max_escalations: 2",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ),
    (j) => j.includes('"onFail":"escalate","maxRetries":1,"escalateTo":"strong"'),
    (b) =>
      b.includes('onFail: "escalate",') &&
      b.includes('escalateTo: "strong",') &&
      b.includes('"cascade":{"draft":"cheap","escalateTo":"strong","cleanPrompt":true}') &&
      b.includes('"maxEscalations":2'),
  ],
  [
    "evaluation.on_fail: escalate without a cascade defaults escalateTo to the strong-tagged candidate",
    cli(
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ),
    (j) => j.includes('"escalateTo":"strong"'),
    (b) => b.includes('escalateTo: "strong",'),
  ],
  [
    "evaluation.on_fail: escalate with no strong tag defaults escalateTo to the LAST candidate's arm id ($profile → its name)",
    [
      "name: hello",
      "target: cli",
      "models:",
      "  big: { model: claude-opus-4-8 }",
      "agent:",
      "  model: claude-haiku-4-5",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: $big, tags: [heavy] }",
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ].join("\n"),
    (j) => j.includes('"escalateTo":"big"'),
    (b) => b.includes('escalateTo: "big",'),
  ],
  [
    "steps[].judge.escalate_to (workflow) rides the IR and forces the retry closure",
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
    (j) => j.includes('"escalateTo":"strong"'),
    (b) =>
      b.includes("const __runStep1 = async (__nudge: string, __force?: string)") &&
      b.includes("...(__force !== undefined ? { forcedCandidate: __force } : {}),") &&
      b.includes('+ __result.rationale, "strong");'),
  ],
];

describe("0.6.0 PR 9c — the cascade keys compile through to the runtime", () => {
  for (const [name, yaml, irProbe, bundleProbe] of CASCADE) {
    test(`${name}: parses, compile() succeeds, nothing pends, the IR and bundle carry it`, () => {
      expect(parseSpecIssues(yaml)).toEqual([]);
      const result = compile(yaml);
      expect(result.files.length).toBeGreaterThan(0);
      expect(irProbe(JSON.stringify(lower(parseSpec(yaml))))).toBe(true);
      const bundle = result.files.map((f) => f.content).join("\n");
      expect(bundleProbe(bundle)).toBe(true);
      const pending = result.warnings.filter(
        (w) =>
          w.code === "model-plan-pending-runtime" &&
          (w.path.includes("on_fail") ||
            w.path.includes("escalate_to") ||
            w.path.includes("strategy.cascade") ||
            w.path.includes("max_escalations") ||
            w.path === "agent.model_pool.strategy"),
      );
      expect(pending).toEqual([]);
    });
  }

  test("on_fail: retry | halt | note lower without an escalateTo and render byte-identically to the pre-cascade shape", () => {
    for (const onFail of ["retry", "halt", "note"] as const) {
      const yaml = cli(
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-haiku-4-5, tags: [cheap] }",
        "      - { model: claude-opus-4-8, tags: [strong] }",
        "evaluation:",
        "  grader: { type: llm_judge, criteria: helpful }",
        `  on_fail: ${onFail}`,
      );
      const ir = lower(parseSpec(yaml));
      if (ir.target !== "cli") throw new Error("unexpected target");
      expect(ir.evaluation?.escalateTo).toBeUndefined();
      expect("escalateTo" in (ir.evaluation ?? {})).toBe(false);
      const agentTs = compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";
      expect(agentTs).toContain(`onFail: "${onFail}",\n  maxRetries: 1,\n  evaluate:`);
      expect(agentTs).not.toContain("escalateTo");
    }
  });
});

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
