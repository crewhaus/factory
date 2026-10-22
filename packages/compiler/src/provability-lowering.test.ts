/**
 * 0.8.0 (design/0.8.0-provability-release.md §3, §4.2–§4.3, §8) — the
 * spec→IR lowering of the `provability:` block:
 *   - spread-return-{}: an absent block, the `off` shorthand and a
 *     `{ level: off }` object carry NO key, so bundles stay byte-identical;
 *   - every default resolved at lower time (a bare `provability: cited`
 *     arrives fully populated), and every declared field lowered;
 *   - `execution.allow` expanded through the `tools:` category grammar, with
 *     the same compile errors `tools:` gives;
 *   - the judge as an auxiliary model slot (`$profile`, sentinels, params),
 *     and `escalateTo` resolved exactly as `IrEvaluation.escalateTo` is;
 *   - the per-shape rules: research's report gate (halt | note), crew's
 *     accepted-but-unwired row, the inert-block warning, the
 *     `--strict`-escalated execution-unresolved warning, and the waiver
 *     judge's self-judge note.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import type { IrCrewV0, IrProvability, IrResearchV0, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { BUILTIN_TOOLS, expandToolSelectors } from "@crewhaus/tool-categories";
import {
  type CompileWarning,
  PROVABILITY_DEFAULT_EXECUTION_ALLOW,
  compile,
  inertProvabilityKeys,
  lower,
  lowerWithWarnings,
  provabilityOf,
  unresolvedProvabilityExecutionTools,
} from "./index";

const TODAY = "2026-10-22";
const opts = { today: TODAY } as const;

const cliYaml = (extra: string, agentExtra: ReadonlyArray<string> = []): string =>
  [
    "name: c",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: i",
    ...agentExtra,
    extra,
  ].join("\n");

const channelYaml = (extra: string): string =>
  [
    "name: ch",
    "target: channel",
    "agent: { model: claude-sonnet-4-5, instructions: i }",
    "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
    "routing: { sessionKey: thread }",
    extra,
  ].join("\n");

const managedYaml = (extra: string): string =>
  [
    "name: mg",
    "target: managed",
    "agent: { model: claude-sonnet-4-5, instructions: i }",
    "tenants:",
    "  - id: t1",
    "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
    extra,
  ].join("\n");

const researchYaml = (extra: string): string =>
  [
    "name: re",
    "target: research",
    "agent: { model: claude-sonnet-4-5, instructions: i }",
    "goal: learn",
    extra,
  ].join("\n");

const crewYaml = (extra: string): string =>
  [
    "name: cr",
    "target: crew",
    "model: claude-sonnet-4-5",
    "entry: lead",
    "roles:",
    "  lead: { instructions: lead it }",
    extra,
  ].join("\n");

const lowered = (yaml: string): { ir: unknown; warnings: ReadonlyArray<CompileWarning> } =>
  lowerWithWarnings(parseSpec(yaml), opts);

const cli = (extra: string, agentExtra: ReadonlyArray<string> = []): IrV0 => {
  const ir = lower(parseSpec(cliYaml(extra, agentExtra)), opts);
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
};

const research = (extra: string): { ir: IrResearchV0; warnings: CompileWarning[] } => {
  const r = lowerWithWarnings(parseSpec(researchYaml(extra)), opts);
  if (r.ir.target !== "research") throw new Error("unexpected target");
  return { ir: r.ir, warnings: [...r.warnings] };
};

const crew = (extra: string): { ir: IrCrewV0; warnings: CompileWarning[] } => {
  const r = lowerWithWarnings(parseSpec(crewYaml(extra)), opts);
  if (r.ir.target !== "crew") throw new Error("unexpected target");
  return { ir: r.ir, warnings: [...r.warnings] };
};

const codes = (warnings: ReadonlyArray<CompileWarning>): string[] => warnings.map((w) => w.code);

/** The concrete default allowlist: the category grammar expanded the way `tools:` is. */
const DEFAULT_ALLOW: ReadonlyArray<string> = expandToolSelectors(
  PROVABILITY_DEFAULT_EXECUTION_ALLOW,
  { path: "provability.execution.allow" },
).tools;

const DEFAULTS = (level: IrProvability["level"]): IrProvability => ({
  level,
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  scope: "session",
  assumptions: "allow",
  render: "footer",
  sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
  grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
  execution: { allow: [...DEFAULT_ALLOW], replay: true, maxReplays: 20 },
  formal: {
    checkers: ["builtin", "smt"],
    forbid: ["sorry", "axiom", "native_decide"],
    timeoutMs: 30_000,
  },
});

const POOL = [
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-4-8, tags: [strong] }",
];

describe("provability lowering — spread-return-{} (byte-identical when absent or off)", () => {
  test("absent, `off` and `{ level: off }` carry NO provability key on every carrier shape", () => {
    for (const block of [
      "permissions: { mode: auto }",
      "provability: off",
      "provability: { level: off }",
    ]) {
      for (const yaml of [
        cliYaml(block),
        channelYaml(block),
        managedYaml(block),
        researchYaml(block.startsWith("permissions") ? "" : block),
        crewYaml(block.startsWith("permissions") ? "" : block),
      ]) {
        const { ir, warnings } = lowered(yaml);
        expect(provabilityOf(ir as never)).toBeUndefined();
        expect("provability" in (ir as object)).toBe(false);
        expect(codes(warnings).filter((c) => c.startsWith("provability-"))).toEqual([]);
      }
    }
  });

  test("a spec with `provability: off` compiles to the same bytes as one without the block", () => {
    const without = compile(cliYaml("permissions: { mode: auto }"), opts);
    const off = compile(cliYaml("permissions: { mode: auto }\nprovability: off"), opts);
    const offObject = compile(
      cliYaml("permissions: { mode: auto }\nprovability: { level: off }"),
      opts,
    );
    expect(off.files).toEqual(without.files);
    expect(offObject.files).toEqual(without.files);
    expect(off.warnings).toEqual([]);
    expect(offObject.warnings).toEqual([]);
  });

  test("an inert `level: off` block with other keys also lowers to nothing (bytes unchanged), with a warning", () => {
    const without = compile(cliYaml("permissions: { mode: auto }"), opts);
    const inert = compile(
      cliYaml(
        "permissions: { mode: auto }\nprovability: { level: off, on_fail: halt, threshold: 0.5 }",
      ),
      opts,
    );
    expect(inert.files).toEqual(without.files);
    expect(inert.warnings).toEqual([
      {
        code: "provability-inert-block",
        path: "provability",
        message:
          "provability: level: off turns the gate off, so provability.on_fail, provability.threshold have no effect — nothing is verified and no proof bundle is written. Set a level (cited | grounded | checked | proven) to turn the gate on, or delete the other keys.",
      },
    ]);
  });
});

describe("provability lowering — defaults resolved at lower time (design §4.2)", () => {
  test("the default execution allowlist is the concrete expansion of all-compute + all-verify", () => {
    expect([...PROVABILITY_DEFAULT_EXECUTION_ALLOW]).toEqual(["all-compute", "all-verify"]);
    // Concrete keys only (no emitter ever sees a category), and the gates the
    // design names are in it while bash is not (design §3).
    expect(DEFAULT_ALLOW.length).toBeGreaterThan(50);
    expect(DEFAULT_ALLOW.some((k) => k.startsWith("all-") || k.startsWith("-"))).toBe(false);
    for (const key of ["evaluate", "moneyAdd", "citationLint", "factCrossCheck"]) {
      expect(DEFAULT_ALLOW).toContain(key);
    }
    for (const key of ["bash", "python", "webFetch", "write"]) {
      expect(DEFAULT_ALLOW).not.toContain(key);
    }
  });

  test("a bare rung shorthand arrives fully populated, at every rung", () => {
    for (const level of ["cited", "grounded", "checked", "proven"] as const) {
      expect(cli(`provability: ${level}`).provability).toEqual(DEFAULTS(level));
    }
  });

  test("the object form with only `level` resolves to the same defaults as the shorthand", () => {
    expect(cli("provability: { level: grounded }").provability).toEqual(DEFAULTS("grounded"));
  });

  test("channel and managed carry the same lowered block as cli", () => {
    for (const yaml of [
      channelYaml("provability: grounded"),
      managedYaml("provability: grounded"),
    ]) {
      const { ir, warnings } = lowered(yaml);
      expect(provabilityOf(ir as never)).toEqual(DEFAULTS("grounded"));
      expect(codes(warnings)).toEqual([]);
    }
  });

  test("the block is carried beside evaluation without disturbing it", () => {
    const ir = cli(
      ["evaluation:", "  grader: { type: contains, value: ok }", "provability: cited"].join("\n"),
    );
    expect(ir.evaluation?.grader).toEqual({ type: "contains", value: "ok" });
    expect(ir.provability?.level).toBe("cited");
  });
});

describe("provability lowering — every declared field", () => {
  test("a full block lowers field by field (snake_case → camelCase)", () => {
    const ir = cli(
      [
        "provability:",
        "  level: proven",
        "  on_fail: note",
        "  max_retries: 3",
        "  threshold: 0.75",
        "  scope: turn",
        "  assumptions: forbid",
        "  max_assumptions: 2",
        "  render: json",
        "  sources:",
        '    allow: ["*.gov", arxiv.org]',
        "    deny: [evil.example]",
        "    bibliographic: true",
        "    resolve: head",
        "  grounded: { coverage: 0.6, window_tokens: 120, independent: 2 }",
        "  execution: { allow: [evaluate, moneyAdd], replay: false, max_replays: 5 }",
        "  formal:",
        "    checkers: [lean4, builtin]",
        "    image: ghcr.io/acme/lean-mathlib:4.9",
        "    forbid: [sorry]",
        "    timeout_ms: 120000",
        "  judge: { model: claude-haiku-4-5, allow_self_judge: true }",
      ].join("\n"),
    );
    expect(ir.provability).toEqual({
      level: "proven",
      onFail: "note",
      maxRetries: 3,
      threshold: 0.75,
      scope: "turn",
      assumptions: "forbid",
      maxAssumptions: 2,
      render: "json",
      sources: {
        allow: ["*.gov", "arxiv.org"],
        deny: ["evil.example"],
        bibliographic: true,
        resolve: "head",
      },
      grounded: { coverage: 0.6, windowTokens: 120, independent: 2 },
      execution: { allow: ["evaluate", "moneyAdd"], replay: false, maxReplays: 5 },
      formal: {
        checkers: ["lean4", "builtin"],
        image: "ghcr.io/acme/lean-mathlib:4.9",
        forbid: ["sorry"],
        timeoutMs: 120_000,
      },
      judge: { model: "claude-haiku-4-5", allowSelfJudge: true },
    });
  });

  test("sources host globs lower lowercased (hosts are case-insensitive), order kept", () => {
    const p = cli(
      'provability: { level: cited, sources: { allow: [ArXiv.org, "*.GOV"], deny: [EVIL.example] } }',
    ).provability;
    expect(p?.sources.allow).toEqual(["arxiv.org", "*.gov"]);
    expect(p?.sources.deny).toEqual(["evil.example"]);
  });

  test("optional keys are spread only when declared (maxAssumptions, formal.image, judge, escalateTo)", () => {
    const p = cli("provability: { level: grounded, max_assumptions: 0 }").provability;
    expect(p?.maxAssumptions).toBe(0);
    const bare = cli("provability: grounded").provability as Record<string, unknown>;
    for (const key of ["maxAssumptions", "judge", "escalateTo"]) {
      expect(key in bare).toBe(false);
    }
    expect("image" in (bare["formal"] as object)).toBe(false);
  });

  test("an empty forbid list and threshold 0 survive (falsy is not absent)", () => {
    const p = cli(
      "provability: { level: proven, threshold: 0, formal: { forbid: [] } }",
    ).provability;
    expect(p?.threshold).toBe(0);
    expect(p?.formal.forbid).toEqual([]);
  });
});

describe("provability lowering — execution.allow through the tools: category grammar", () => {
  test("a category expands to its concrete keys, and an exclusion subtracts", () => {
    const math = cli(
      "provability: { level: checked, execution: { allow: [all-math] } }",
    ).provability;
    expect(math?.execution.allow).toEqual([
      ...expandToolSelectors(["all-math"], { path: "x" }).tools,
    ]);
    expect(math?.execution.allow).toContain("moneyAdd");
    const verify = cli(
      "provability: { level: checked, execution: { allow: [all-verify, -citationLint] } }",
    ).provability;
    expect(verify?.execution.allow).toContain("factCrossCheck");
    expect(verify?.execution.allow).not.toContain("citationLint");
  });

  test("a list without category syntax keeps the author's order", () => {
    expect(
      cli("provability: { level: checked, execution: { allow: [moneyAdd, evaluate] } }").provability
        ?.execution.allow,
    ).toEqual(["moneyAdd", "evaluate"]);
  });

  test("a builtin lowers to its spec key however it is spelled, and repeats then drop", () => {
    // The IR carries ONE spelling per builtin (the IR doc): the verifier maps
    // a recorded name to its key and matches exactly.
    expect(
      cli(
        "provability: { level: cited, execution: { allow: [moneyadd, MONEYADD, MoneyAdd, Evaluate, moneyAdd] } }",
      ).provability?.execution.allow,
    ).toEqual(["moneyAdd", "evaluate"]);
    expect(
      cli("provability: { level: checked, execution: { allow: [MoneyAdd, Evaluate] } }").provability
        ?.execution.allow,
    ).toEqual(["moneyAdd", "evaluate"]);
  });

  test("a registered name obeys the category grammar's exclusions exactly as its key does", () => {
    // Names are canonicalised BEFORE the grammar runs. Canonicalising only the
    // expanded output let `MoneyAdd` escape `-all-math` (it was not a key the
    // category subtracted) and refused `-MoneyAdd` as excluding a tool that
    // nothing includes. This list decides which results count as `checked`
    // evidence, so two spellings of one tool must expand identically.
    const allowOf = (list: string): ReadonlyArray<string> | undefined =>
      cli(`provability: { level: checked, execution: { allow: ${list} } }`).provability?.execution
        .allow;
    const byKey = allowOf("[all-compute, moneyAdd, -all-math]");
    const byName = allowOf("[all-compute, MoneyAdd, -all-math]");
    expect(byKey).not.toContain("moneyAdd");
    expect(byName).not.toContain("moneyAdd");
    expect(byName).toEqual(byKey);
    expect(allowOf("[all-compute, moneyadd, -all-math]")).toEqual(byKey);

    const excludedByKey = allowOf("[all-compute, -moneyAdd]");
    expect(excludedByKey).not.toContain("moneyAdd");
    expect(allowOf("[all-compute, -MoneyAdd]")).toEqual(excludedByKey);
    expect(allowOf("[all-compute, -MONEYADD]")).toEqual(excludedByKey);
  });

  test("an exclusion of a non-builtin name is matched exactly, never case-folded", () => {
    // MCP tool names are case-sensitive: `-mcp__calc__ADD` removes only that
    // spelling, and excluding a spelling nothing includes is still refused.
    const MCP = ["mcp_servers:", "  calc:", "    transport: stdio", "    command: calc"].join("\n");
    const allow = cli(
      `${MCP}\nprovability: { level: cited, execution: { allow: [all-verify, mcp__calc__add, mcp__calc__ADD, -mcp__calc__ADD] } }`,
    ).provability?.execution.allow;
    expect(allow).toContain("mcp__calc__add");
    expect(allow).not.toContain("mcp__calc__ADD");
    expect(() =>
      lower(
        parseSpec(
          cliYaml(
            `${MCP}\nprovability: { level: cited, execution: { allow: [all-verify, mcp__calc__add, -mcp__calc__ADD] } }`,
          ),
        ),
        opts,
      ),
    ).toThrow(CompilerError);
  });

  test("every builtin entry in the IR is a catalog key; a non-builtin name is kept exactly", () => {
    const MCP = ["mcp_servers:", "  calc:", "    transport: stdio", "    command: calc"].join("\n");
    const allow = cli(
      `${MCP}\nprovability: { level: cited, execution: { allow: [all-money, MoneyAdd, mcp__calc__add, mcp__calc__ADD, mcp__calc__add, moneyAd] } }`,
    ).provability?.execution.allow;
    const builtins = (allow ?? []).filter((k) => !k.startsWith("mcp__") && k !== "moneyAd");
    for (const key of builtins)
      expect({ key, isKey: Object.hasOwn(BUILTIN_TOOLS, key) }).toEqual({ key, isKey: true });
    // MCP tool names are case-sensitive: folding case would allowlist
    // `mcp__calc__ADD` when only `mcp__calc__add` was named, so both stay and
    // only the exact repeat drops. A typo is kept as written (lint names it).
    // (A category list expands sorted, as `tools:` does.)
    expect((allow ?? []).filter((k) => !builtins.includes(k)).sort()).toEqual(
      ["mcp__calc__add", "mcp__calc__ADD", "moneyAd"].sort(),
    );
    expect(builtins.filter((k) => k === "moneyAdd")).toHaveLength(1);
  });

  test("an unknown category fails the compile exactly as it does in tools:", () => {
    const bad = cliYaml("provability: { level: checked, execution: { allow: [all-bogus] } }");
    expect(() => lower(parseSpec(bad), opts)).toThrow(CompilerError);
    const inTools = cliYaml("tools: [all-bogus]");
    let provabilityMessage = "";
    let toolsMessage = "";
    try {
      lower(parseSpec(bad), opts);
    } catch (err) {
      provabilityMessage = (err as Error).message;
    }
    try {
      lower(parseSpec(inTools), opts);
    } catch (err) {
      toolsMessage = (err as Error).message;
    }
    expect(provabilityMessage).toContain("provability.execution.allow");
    expect(provabilityMessage).toContain("all-bogus");
    // Same wording past the path: one grammar, one error.
    expect(provabilityMessage.replace("provability.execution.allow", "tools")).toBe(toolsMessage);
  });

  test("an inert `level: off` block's allowlist is still checked (a typo is a typo)", () => {
    // The spec refuses an undeclared judge profile at every level; the
    // category grammar gets the same treatment, so turning the gate back on
    // never surfaces a typo that was there all along.
    expect(() =>
      lower(
        parseSpec(cliYaml("provability: { level: off, execution: { allow: [all-mathz] } }")),
        opts,
      ),
    ).toThrow(CompilerError);
    expect(() =>
      lower(
        parseSpec(cliYaml("provability: { level: off, execution: { allow: [all-math, -bash] } }")),
        opts,
      ),
    ).toThrow(CompilerError);
    // A valid one still lowers to nothing, with only the inert warning.
    const ok = lowered(cliYaml("provability: { level: off, execution: { allow: [all-math] } }"));
    expect(provabilityOf(ok.ir as never)).toBeUndefined();
    expect(codes(ok.warnings)).toEqual(["provability-inert-block"]);
  });

  test("an exclusion that removes nothing fails the compile", () => {
    expect(() =>
      lower(
        parseSpec(
          cliYaml("provability: { level: checked, execution: { allow: [all-math, -bash] } }"),
        ),
        opts,
      ),
    ).toThrow(CompilerError);
  });
});

describe("provability lowering — the waiver judge is an auxiliary model slot", () => {
  const REGISTRY = [
    "models:",
    "  cheap:",
    "    model: claude-haiku-4-5",
    "    max_tokens: 512",
    "    temperature: 0",
    "    tools: []",
  ].join("\n");

  test("a literal model lowers to { model } alone", () => {
    expect(
      cli("provability: { level: grounded, judge: { model: claude-haiku-4-5 } }").provability
        ?.judge,
    ).toEqual({ model: "claude-haiku-4-5" });
  });

  test("a $profile resolves to its model, with provenance and pinned params", () => {
    const ir = cli(`${REGISTRY}\nprovability: { level: grounded, judge: { model: $cheap } }`);
    expect(ir.provability?.judge).toEqual({
      model: "claude-haiku-4-5",
      modelProfile: "cheap",
      params: { maxTokens: 512, temperature: 0 },
    });
  });

  test("the cheapest sentinel resolves through the same path the other judges use", () => {
    const judge = cli("provability: { level: grounded, judge: { model: cheapest } }").provability
      ?.judge;
    expect(judge?.model).toBeDefined();
    expect(judge?.model).not.toBe("cheapest");
  });

  test("allow_self_judge rides the IR only when true", () => {
    expect(
      cli(
        "provability: { level: grounded, judge: { model: claude-haiku-4-5, allow_self_judge: true } }",
      ).provability?.judge?.allowSelfJudge,
    ).toBe(true);
    const off = cli(
      "provability: { level: grounded, judge: { model: claude-haiku-4-5, allow_self_judge: false } }",
    ).provability?.judge;
    expect(off).toEqual({ model: "claude-haiku-4-5" });
  });
});

describe("provability lowering — escalateTo is resolved exactly as IrEvaluation.escalateTo is", () => {
  test("default: the strong-tagged candidate; with a cascade: its escalate_to", () => {
    const plain = cli("provability: { level: grounded, on_fail: escalate }", POOL);
    expect(plain.provability?.onFail).toBe("escalate");
    expect(plain.provability?.escalateTo).toBe("strong");

    const cascade = [
      ...POOL,
      "    strategy:",
      "      cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }",
    ];
    expect(
      cli("provability: { level: grounded, on_fail: escalate }", cascade).provability?.escalateTo,
    ).toBe("strong");
  });

  test("the same pool gives the evaluation gate and the provability gate the same target", () => {
    const untagged = [
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5 }",
      "      - { model: claude-sonnet-4-5 }",
    ];
    const ir = cli(
      [
        "evaluation:",
        "  grader: { type: contains, value: ok }",
        "  on_fail: escalate",
        "provability: { level: grounded, on_fail: escalate }",
      ].join("\n"),
      untagged,
    );
    expect(ir.evaluation?.escalateTo).toBe("claude-sonnet-4-5");
    expect(ir.provability?.escalateTo).toBe(ir.evaluation?.escalateTo);
  });

  test("escalateTo is absent for every other on_fail", () => {
    for (const onFail of ["retry", "halt", "note"]) {
      const p = cli(`provability: { level: grounded, on_fail: ${onFail} }`, POOL).provability;
      expect(p?.onFail).toBe(onFail as "note");
      expect("escalateTo" in (p as object)).toBe(false);
    }
  });
});

describe("provability lowering — research: the report gate supports halt | note (design §8)", () => {
  test("an undeclared on_fail resolves to note SILENTLY (the shape's default, not a degraded retry)", () => {
    const { ir, warnings } = research("provability: cited");
    expect(ir.provability).toEqual({ ...DEFAULTS("cited"), onFail: "note" });
    expect(warnings).toEqual([]);
  });

  test("a declared retry or escalate lowers to note with provability-on-fail-degraded", () => {
    for (const onFail of ["retry", "escalate"]) {
      const { ir, warnings } = research(`provability: { level: grounded, on_fail: ${onFail} }`);
      expect(ir.provability?.onFail).toBe("note");
      expect("escalateTo" in (ir.provability as object)).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("provability-on-fail-degraded");
      expect(warnings[0]?.path).toBe("provability.on_fail");
      expect(warnings[0]?.message).toContain(
        `provability.on_fail: ${onFail} is not supported on the research shape`,
      );
      expect(warnings[0]?.message).toContain("halt | note");
    }
  });

  test("halt and note are kept, without a warning", () => {
    for (const onFail of ["halt", "note"]) {
      const { ir, warnings } = research(`provability: { level: grounded, on_fail: ${onFail} }`);
      expect(ir.provability?.onFail).toBe(onFail as "halt");
      expect(warnings).toEqual([]);
    }
  });

  test("compile() surfaces the degrade warning too", () => {
    const result = compile(researchYaml("provability: { level: cited, on_fail: retry }"), opts);
    expect(codes(result.warnings)).toContain("provability-on-fail-degraded");
  });
});

describe("provability lowering — crew carries the block with the accepted-but-unwired warning", () => {
  test("crew lowers the block and warns that its synthesis turn is not gated yet", () => {
    const { ir } = crew("provability: grounded");
    expect(ir.provability).toEqual(DEFAULTS("grounded"));
    const result = compile(crewYaml("provability: grounded"), opts);
    expect(result.warnings).toEqual([
      {
        code: "accepted-but-unwired",
        path: "provability",
        message:
          "provability is accepted on the crew shape but its emitter does not wire it yet — the crew orchestrator's synthesis turn is not exposed to the gate yet, so no answer is verified and no proof bundle is written (design/0.8.0-provability-release.md §12 item 2)",
      },
    ]);
  });

  test("`provability: off` on crew is an opt-out, not a declaration: no warning at all", () => {
    expect(compile(crewYaml("provability: off"), opts).warnings).toEqual([]);
    expect(compile(crewYaml("provability: { level: off }"), opts).warnings).toEqual([]);
  });

  test("an inert crew block warns provability-inert-block, never accepted-but-unwired as well", () => {
    expect(
      codes(compile(crewYaml("provability: { level: off, threshold: 0.5 }"), opts).warnings),
    ).toEqual(["provability-inert-block"]);
  });

  test("a declared escalate on crew degrades to note (crew has no agent.model_pool)", () => {
    const { ir, warnings } = crew("provability: { level: cited, on_fail: escalate }");
    expect(ir.provability?.onFail).toBe("note");
    expect(codes(warnings)).toEqual(["provability-on-fail-degraded"]);
    expect(
      codes(
        compile(crewYaml("provability: { level: cited, on_fail: escalate }"), opts).warnings,
      ).sort(),
    ).toEqual(["accepted-but-unwired", "provability-on-fail-degraded"]);
  });
});

describe("provability lowering — the inert-block warning", () => {
  test("inertProvabilityKeys names the keys beside level: off, sorted; [] otherwise", () => {
    expect(
      inertProvabilityKeys({ provability: { level: "off", threshold: 0.5, on_fail: "halt" } }),
    ).toEqual(["on_fail", "threshold"]);
    expect(inertProvabilityKeys({ provability: { level: "off" } })).toEqual([]);
    expect(inertProvabilityKeys({ provability: "off" })).toEqual([]);
    expect(inertProvabilityKeys({ provability: { level: "cited", threshold: 0.5 } })).toEqual([]);
    expect(inertProvabilityKeys({})).toEqual([]);
  });

  test("every carrier shape warns once, with one key spelled in the singular", () => {
    for (const yaml of [
      cliYaml("provability: { level: off, render: none }"),
      channelYaml("provability: { level: off, render: none }"),
      managedYaml("provability: { level: off, render: none }"),
      researchYaml("provability: { level: off, render: none }"),
    ]) {
      const { warnings } = lowered(yaml);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.code).toBe("provability-inert-block");
      expect(warnings[0]?.message).toContain("provability.render has no effect");
    }
  });

  test("an inert off block with on_fail: escalate and no pool compiles (the spec accepts it)", () => {
    const result = compile(cliYaml("provability: { level: off, on_fail: escalate }"), opts);
    expect(codes(result.warnings)).toEqual(["provability-inert-block"]);
  });
});

describe("provability lowering — execution tools the catalog cannot resolve offline", () => {
  const MCP = ["mcp_servers:", "  calc:", "    transport: stdio", "    command: calc"].join("\n");
  const checkedMcp = cliYaml(
    `${MCP}\nprovability: { level: checked, execution: { allow: [mcp__calc__add, moneyAdd] } }`,
  );

  test("a checked floor naming an mcp tool warns provability-execution-unresolved, naming only it", () => {
    const { ir, warnings } = lowered(checkedMcp);
    expect(unresolvedProvabilityExecutionTools(ir as never)).toEqual(["mcp__calc__add"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("provability-execution-unresolved");
    expect(warnings[0]?.path).toBe("provability.execution.allow");
    expect(warnings[0]?.message).toContain('"mcp__calc__add"');
    expect(warnings[0]?.message).not.toContain('"moneyAdd"');
    expect(warnings[0]?.message).toContain("crewhaus compile --strict");
  });

  test("proven warns the same; cited and grounded do not (design §4.3 scopes it to checked | proven)", () => {
    const at = (level: string) =>
      lowered(
        cliYaml(`${MCP}\nprovability: { level: ${level}, execution: { allow: [mcp__calc__add] } }`),
      );
    expect(codes(at("proven").warnings)).toEqual(["provability-execution-unresolved"]);
    for (const level of ["cited", "grounded"]) {
      const { ir, warnings } = at(level);
      expect(warnings).toEqual([]);
      expect(unresolvedProvabilityExecutionTools(ir as never)).toEqual([]);
    }
  });

  test("a registered name (MoneyAdd) and every category expansion resolve offline", () => {
    for (const allow of ["[MoneyAdd, Evaluate]", "[all-math, all-verify]"]) {
      const { ir, warnings } = lowered(
        cliYaml(`provability: { level: checked, execution: { allow: ${allow} } }`),
      );
      expect(warnings).toEqual([]);
      expect(unresolvedProvabilityExecutionTools(ir as never)).toEqual([]);
    }
    // The default allowlist always resolves.
    expect(lowered(cliYaml("provability: proven")).warnings).toEqual([]);
  });

  test("a typo'd key is unresolved too", () => {
    const { warnings } = lowered(
      cliYaml("provability: { level: checked, execution: { allow: [moneyAd] } }"),
    );
    expect(codes(warnings)).toEqual(["provability-execution-unresolved"]);
  });

  test("the warning and unresolvedProvabilityExecutionTools name exactly the same entries", () => {
    // One predicate behind both, so a reader of the IR and the compile
    // warning cannot disagree about which entries are unresolved.
    const { ir, warnings } = lowered(
      cliYaml(
        `${MCP}\nprovability: { level: proven, execution: { allow: [MoneyAdd, mcp__calc__add, moneyAd, all-verify] } }`,
      ),
    );
    const unresolved = unresolvedProvabilityExecutionTools(ir as never);
    expect(unresolved).toEqual(["mcp__calc__add", "moneyAd"]);
    expect(warnings).toHaveLength(1);
    const named = [...(warnings[0]?.message ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(named).toEqual([...unresolved]);
  });

  test("compile({ strict: true }) — FR-002's DEFAULT-ON scope gate — does NOT refuse it", () => {
    // `crewhaus compile`, `run --watch` and the compiler worker all pass
    // strict: true without any --strict flag, so a refusal here would reject a
    // spec plain `crewhaus run` accepts. `crewhaus compile --strict` refuses
    // it by escalating the warning (apps/cli/src/compile-warnings.ts does not
    // list it as informational — pinned by apps/cli/src/lint.test.ts).
    const plain = compile(checkedMcp, opts);
    const strict = compile(checkedMcp, { ...opts, strict: true });
    expect(strict.files).toEqual(plain.files);
    expect(codes(strict.warnings)).toEqual(["provability-execution-unresolved"]);
  });
});

describe("provability lowering — the waiver judge's independence (model-plan-self-judge)", () => {
  test("a waiver judge that is the agent's serving model warns, even with no models: registry", () => {
    const { warnings } = lowered(
      cliYaml("provability: { level: grounded, judge: { model: claude-sonnet-4-5 } }"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("model-plan-self-judge");
    expect(warnings[0]?.path).toBe("provability.judge.model");
    expect(warnings[0]?.message).toContain('"claude-sonnet-4-5"');
    expect(warnings[0]?.message).toContain("allow_self_judge: true");
  });

  test("a pool candidate as the waiver judge warns; an independent judge does not", () => {
    expect(
      codes(
        lowered(
          cliYaml("provability: { level: grounded, judge: { model: claude-opus-4-8 } }", POOL),
        ).warnings,
      ),
    ).toEqual(["model-plan-self-judge"]);
    expect(
      lowered(cliYaml("provability: { level: grounded, judge: { model: claude-haiku-4-5 } }"))
        .warnings,
    ).toEqual([]);
  });

  test("allow_self_judge: true silences it", () => {
    expect(
      lowered(
        cliYaml(
          "provability: { level: grounded, judge: { model: claude-sonnet-4-5, allow_self_judge: true } }",
        ),
      ).warnings,
    ).toEqual([]);
  });

  test("research is checked; crew (no agent, block unwired) is not", () => {
    expect(
      codes(
        research(
          "provability: { level: grounded, on_fail: note, judge: { model: claude-sonnet-4-5 } }",
        ).warnings,
      ),
    ).toEqual(["model-plan-self-judge"]);
    expect(
      crew("provability: { level: grounded, judge: { model: claude-sonnet-4-5 } }").warnings,
    ).toEqual([]);
  });
});
