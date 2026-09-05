/**
 * 0.6.0 PR 7 — the residual runtime-pending guard. PR 6 refused the WHOLE
 * §11.1 spec delta at compile time; PR 7 lowers it, and keeps refusing only
 * the NARROWING knobs whose runtime consumer has not landed: a candidate's
 * (or a serving-slot profile's) `tools` / `tool_config` / `permissions` /
 * `rate_limits` / `cost` (PR 9a), `evaluation.on_fail: escalate` and
 * `judge.escalate_to` (PR 9c), and `mcp_servers.<n>.tool_flags` (no PR-train
 * row for its IR + emit half yet). Accepting them while the runtime ignores
 * them would serve a candidate declared `tools: []` with the full toolset.
 *
 * Every row PARSES (the guard is downstream of the spec), `compile()` refuses
 * it naming the path and the landing PR, and `lower()` with
 * `allowRuntimePendingKeys` carries it into the IR with a
 * `model-plan-pending-runtime` warning — the lowering the runtime PR will
 * consume is exercised, not dead. The landing PR deletes its row here.
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

/** [row, spec, the refused path, the IR probe once lowered with the bypass] */
const REFUSED: ReadonlyArray<readonly [string, string, RegExp, (json: string) => boolean]> = [
  [
    "candidate tools",
    cliCandidate("tools: [read]"),
    /^agent\.model_pool\.candidates\[0\]\.tools/,
    (j) => j.includes('"tools":["read"]'),
  ],
  [
    "candidate tools: [] (zero shape tools)",
    cliCandidate("tools: []"),
    /^agent\.model_pool\.candidates\[0\]\.tools/,
    (j) => j.includes('"tools":[]'),
  ],
  [
    "candidate tool_config",
    cliCandidate("tool_config: { fetch: { timeoutMs: 8000 } }"),
    /^agent\.model_pool\.candidates\[0\]\.tool_config/,
    (j) => j.includes('"toolConfigs":{"fetch":{"timeoutMs":8000}}'),
  ],
  [
    "candidate permissions",
    cliCandidate("permissions: { deny: ['Bash(*)'] }"),
    /^agent\.model_pool\.candidates\[0\]\.permissions/,
    (j) => j.includes('"permissions":{"deny":["Bash(*)"]}'),
  ],
  [
    "candidate rate_limits",
    cliCandidate("rate_limits: { '*': { rpm: 60 } }"),
    /^agent\.model_pool\.candidates\[0\]\.rate_limits/,
    (j) => j.includes('"rateLimits":{"*":{"rpm":60}}'),
  ],
  [
    "candidate cost",
    cliCandidate("cost: { max_usd: 0.5 }"),
    /^agent\.model_pool\.candidates\[0\]\.cost/,
    (j) => j.includes('"costCapUsdMicros":500000'),
  ],
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
    /^agent\.sub_agents\.helper\.model_pool\.candidates\[0\]\.tools/,
    (j) => j.includes('"tools":["read"]'),
  ],
];

describe("0.6.0 PR 7 residual guard — narrowing knobs are refused until their runtime lands", () => {
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

  test("the error names the landing row and tells the author what to do", () => {
    expect(() => compile(cliCandidate("tools: []"))).toThrow(/PR 9a/);
    expect(() => compile(cliCandidate("tools: []"))).toThrow(/remove it from the spec for now/);
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
