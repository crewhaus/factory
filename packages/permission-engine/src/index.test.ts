import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BUILTIN_DEFAULT_RULES,
  type JustificationJudge,
  PermissionConfigError,
  type PermissionRule,
  RULE_BASED_JUDGE_MODEL,
  type RuleSet,
  type ToolCallContext,
  __resetRuleBasedJudgeWarningForTests,
  emptyRuleSet,
  evaluate,
  evaluateJustification,
  evaluateWithReason,
  parsePermissionsConfig,
  ruleBasedJustificationJudge,
  tagRules,
} from "./index";

const readCall: ToolCallContext = {
  toolName: "Read",
  input: { path: "x" },
  readOnly: true,
  destructive: false,
};
const bashRm: ToolCallContext = {
  toolName: "Bash",
  input: { command: "rm -rf /tmp/foo" },
  readOnly: false,
  destructive: true,
};
const bashLs: ToolCallContext = {
  toolName: "Bash",
  input: { command: "ls" },
  readOnly: false,
  destructive: true,
};
const writeCall: ToolCallContext = {
  toolName: "Write",
  input: { file_path: "/tmp/x" },
  readOnly: false,
  destructive: true,
};

function rule(
  type: PermissionRule["type"],
  pattern: string,
  source: PermissionRule["source"] = "yaml",
): PermissionRule {
  return { type, pattern, source };
}

describe("evaluate — modes", () => {
  test("bypass always allows", () => {
    expect(evaluate(bashRm, "bypass", emptyRuleSet)).toBe("allow");
    expect(evaluate(writeCall, "bypass", emptyRuleSet)).toBe("allow");
  });

  test("plan allows read-only, denies everything else (rules ignored)", () => {
    expect(evaluate(readCall, "plan", emptyRuleSet)).toBe("allow");
    expect(evaluate(writeCall, "plan", emptyRuleSet)).toBe("deny");
    // Even a permissive rule cannot override plan mode's no-write rule.
    const allowAllRules: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAllow", "*")],
    };
    expect(evaluate(writeCall, "plan", allowAllRules)).toBe("deny");
  });

  test("default falls back to ask when no rule matches", () => {
    expect(evaluate(readCall, "default", emptyRuleSet)).toBe("ask");
    expect(evaluate(writeCall, "default", emptyRuleSet)).toBe("ask");
  });

  test("auto auto-allows read-only and asks for destructive when no rule matches", () => {
    expect(evaluate(readCall, "auto", emptyRuleSet)).toBe("allow");
    expect(evaluate(bashLs, "auto", emptyRuleSet)).toBe("ask");
  });
});

describe("evaluate — rule types", () => {
  test("alwaysAllow matches → allow", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Read")] };
    expect(evaluate(readCall, "default", rs)).toBe("allow");
  });

  test("alwaysDeny matches → deny", () => {
    // `**` glob crosses `/`, so this matches `rm -rf /tmp/foo`.
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysDeny", "Bash(rm**)")] };
    expect(evaluate(bashRm, "default", rs)).toBe("deny");
  });

  test("alwaysAsk matches → ask", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Bash(*)")] };
    expect(evaluate(bashLs, "default", rs)).toBe("ask");
  });

  test("a malformed alwaysAllow is skipped (a broken grant is not honored)", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAllow", "Bash(unclosed"), rule("alwaysAllow", "Read")],
    };
    // First rule errors → skipped (fail closed: no grant); second matches → allow.
    expect(evaluate(readCall, "default", rs)).toBe("allow");
  });

  // SECURITY: a malformed guard rule must NOT silently fail open. An attacker
  // who can influence a sub-agent definition could otherwise ship a deny whose
  // pattern fails to compile and watch it get dropped.
  test("a malformed alwaysDeny fails CLOSED (gates instead of being dropped)", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysDeny", "Bash(unclosed")] };
    expect(evaluate(bashRm, "default", rs)).toBe("deny");
  });

  test("a malformed alwaysAsk fails CLOSED (gates instead of being dropped)", () => {
    const rs: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Bash(unclosed")] };
    expect(evaluate(bashLs, "default", rs)).toBe("ask");
  });
});

describe("T9 — rule precedence", () => {
  test("settings (deny) beats yaml (allow): higher source wins", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      settings: [rule("alwaysDeny", "Bash(*)", "settings")],
      yaml: [rule("alwaysAllow", "Bash(*)", "yaml")],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("deny");
  });

  test("flag (allow) beats settings (deny)", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      flag: [rule("alwaysAllow", "Bash(*)", "flag")],
      settings: [rule("alwaysDeny", "Bash(*)", "settings")],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("allow");
  });

  test("hook decision overrides builtin default", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      hooks: [rule("alwaysDeny", "Read", "hook")],
      builtin: [...BUILTIN_DEFAULT_RULES],
    };
    expect(evaluate(readCall, "default", rs)).toBe("deny");
  });

  test("first rule within a source wins over later rules in same source", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [
        rule("alwaysAllow", "Bash(ls)"),
        rule("alwaysDeny", "Bash(*)"), // would also match, but loses to first
      ],
    };
    expect(evaluate(bashLs, "default", rs)).toBe("allow");
  });

  test("property: random RuleSet — decision matches highest-priority matching source", () => {
    const tools = ["Read", "Bash", "Write"];
    const types: PermissionRule["type"][] = ["alwaysAllow", "alwaysDeny", "alwaysAsk"];
    const sources: PermissionRule["source"][] = ["flag", "settings", "yaml", "hook", "builtin"];
    const sourceKeyMap = {
      flag: "flag",
      settings: "settings",
      yaml: "yaml",
      hook: "hooks",
      builtin: "builtin",
    } as const;

    for (let trial = 0; trial < 200; trial++) {
      const ruleCount = 1 + Math.floor(Math.random() * 8);
      const all: PermissionRule[] = [];
      for (let i = 0; i < ruleCount; i++) {
        const tool = tools[Math.floor(Math.random() * tools.length)] as string;
        const t = types[Math.floor(Math.random() * types.length)] as PermissionRule["type"];
        const s = sources[Math.floor(Math.random() * sources.length)] as PermissionRule["source"];
        all.push({ type: t, pattern: tool, source: s });
      }

      const rs: RuleSet = {
        flag: all.filter((r) => r.source === "flag"),
        settings: all.filter((r) => r.source === "settings"),
        yaml: all.filter((r) => r.source === "yaml"),
        hooks: all.filter((r) => r.source === "hook"),
        builtin: all.filter((r) => r.source === "builtin"),
      };
      const target = tools[Math.floor(Math.random() * tools.length)] as string;

      // Compute oracle: walk the priority order ourselves.
      const priority: PermissionRule["source"][] = ["flag", "settings", "yaml", "hook", "builtin"];
      let oracle: ReturnType<typeof evaluate> = "ask"; // default fallback
      for (const src of priority) {
        const list = rs[sourceKeyMap[src]];
        const match = list.find((r) => r.pattern === target);
        if (match) {
          oracle =
            match.type === "alwaysAllow" ? "allow" : match.type === "alwaysDeny" ? "deny" : "ask";
          break;
        }
      }

      const call: ToolCallContext = {
        toolName: target,
        input: {},
        readOnly: false,
        destructive: false,
      };
      const decision = evaluate(call, "default", rs);
      expect(decision).toBe(oracle);
    }
  });
});

describe("parsePermissionsConfig — happy path", () => {
  test("parses mode + rules", () => {
    const out = parsePermissionsConfig(
      {
        mode: "auto",
        rules: [
          { type: "alwaysAllow", pattern: "Read" },
          { type: "alwaysDeny", pattern: "Bash(rm *)" },
        ],
      },
      "yaml",
    );
    expect(out.mode).toBe("auto");
    expect(out.rules).toHaveLength(2);
  });

  test("undefined / null → empty rules", () => {
    expect(parsePermissionsConfig(undefined, "yaml")).toEqual({ rules: [] });
    expect(parsePermissionsConfig(null, "yaml")).toEqual({ rules: [] });
  });

  test("rejects unknown rule type", () => {
    expect(() =>
      parsePermissionsConfig({ rules: [{ type: "neverAllow", pattern: "x" }] }, "yaml"),
    ).toThrow(PermissionConfigError);
  });

  test("rejects unknown top-level keys (strict)", () => {
    expect(() => parsePermissionsConfig({ extra: 1 }, "yaml")).toThrow(PermissionConfigError);
  });
});

describe("T8 — bypass mode security lockdown", () => {
  test("rejects mode: bypass from yaml source", () => {
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "yaml")).toThrow(
      PermissionConfigError,
    );
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "yaml")).toThrow(
      /bypass mode cannot be set from yaml/,
    );
  });

  test("rejects mode: bypass from settings source", () => {
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "settings")).toThrow(
      PermissionConfigError,
    );
    expect(() => parsePermissionsConfig({ mode: "bypass", rules: [] }, "settings")).toThrow(
      /bypass mode cannot be set from settings/,
    );
  });

  test("the schema's mode enum does NOT include 'bypass' (defense in depth)", () => {
    // Even if the explicit string-check at the top of parsePermissionsConfig were
    // bypassed (e.g. via a clever Object.create(null) shape), the Zod enum would
    // still reject it. We assert by trying a shape where `mode` is a frozen string
    // primitive — both layers should still reject.
    const maliciousShape = Object.create(null) as { mode: string };
    maliciousShape.mode = "bypass";
    expect(() => parsePermissionsConfig(maliciousShape, "yaml")).toThrow(PermissionConfigError);
  });

  test("bypass IS a legal runtime mode for evaluate() — it just can't enter via config", () => {
    expect(evaluate(bashRm, "bypass", emptyRuleSet)).toBe("allow");
  });
});

describe("tagRules", () => {
  test("attaches source to each rule", () => {
    const out = tagRules(
      [
        { type: "alwaysAllow", pattern: "Read" },
        { type: "alwaysDeny", pattern: "Bash(rm *)" },
      ],
      "yaml",
    );
    expect(out[0]?.source).toBe("yaml");
    expect(out[1]?.source).toBe("yaml");
  });
});

describe("Section 18 — requiresSandbox floor", () => {
  const pythonCall: ToolCallContext = {
    toolName: "Python",
    input: { code: "print('hi')" },
    readOnly: false,
    destructive: true,
    requiresSandbox: true,
  };

  test("denies in default mode when no rule + no sandbox", () => {
    const r = evaluateWithReason(pythonCall, "default", emptyRuleSet);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("requires a sandbox");
  });

  test("denies even with rule when sandbox not available", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: false });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("requires a sandbox");
  });

  test("denies in default mode with sandbox but no allow rule", () => {
    const r = evaluateWithReason(pythonCall, "default", emptyRuleSet, {
      sandboxAvailable: true,
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("alwaysAllow rule");
  });

  test("allows when sandbox available AND alwaysAllow matches", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAllow", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: true });
    expect(r.decision).toBe("allow");
  });

  test("denies when sandbox available but alwaysAsk matches (ask is not allow)", () => {
    const rules: RuleSet = { ...emptyRuleSet, yaml: [rule("alwaysAsk", "Python")] };
    const r = evaluateWithReason(pythonCall, "default", rules, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("auto mode still applies floor — denies without alwaysAllow even when destructive auto-asks would say ask", () => {
    const r = evaluateWithReason(pythonCall, "auto", emptyRuleSet, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("plan mode unaffected by sandbox floor — still denies non-readOnly", () => {
    const r = evaluateWithReason(pythonCall, "plan", emptyRuleSet, { sandboxAvailable: true });
    expect(r.decision).toBe("deny");
  });

  test("bypass mode unaffected — bypass is a deliberate operator override", () => {
    const r = evaluateWithReason(pythonCall, "bypass", emptyRuleSet);
    expect(r.decision).toBe("allow");
  });

  test("non-sandbox tools unaffected by sandboxAvailable=false", () => {
    const r = evaluateWithReason(readCall, "default", emptyRuleSet, {
      sandboxAvailable: false,
    });
    // readCall doesn't set requiresSandbox; floor doesn't apply.
    expect(r.decision).toBe("ask");
  });
});

describe("Pillar 3 — ruleBasedJustificationJudge", () => {
  test("denies brief justifications", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "ok",
      sessionGoal: "summarize the user's emails",
      input: {},
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/too brief/);
    expect(v.judgeModel).toBe("rule-based");
  });

  test("allows when no session goal is supplied (audit-only path)", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "user wants a confirmation message sent to slack #team",
      sessionGoal: "",
      input: {},
    });
    expect(v.allow).toBe(true);
    expect(v.confidence).toBe(0);
  });

  test("denies when justification shares no salient tokens with goal", async () => {
    const v = await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/no salient tokens/);
  });

  test("allows when justification overlaps the goal", async () => {
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "post the email summary to the #customer-success channel",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(v.allow).toBe(true);
    expect(v.confidence ?? 0).toBeGreaterThan(0);
  });

  // SECURITY: the rule-based judge is gameable (the same model writes the
  // justification), so its `allow` must NOT stand in production.
  const OVERLAPPING = {
    toolName: "SendMessage",
    justification: "post the email summary to the #customer-success channel",
    sessionGoal: "summarize the customer's recent email correspondence",
    input: {},
  } as const;

  test("fails closed in production when the rule-based judge would allow", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOptIn = process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"];
    process.env.NODE_ENV = "production";
    process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = ""; // not "1" → fail-closed
    __resetRuleBasedJudgeWarningForTests();
    try {
      const v = await evaluateJustification({ ...OVERLAPPING });
      expect(v.allow).toBe(false);
      expect(v.reason).toMatch(/fail-closed/);
    } finally {
      process.env.NODE_ENV = prevEnv ?? "test";
      process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = prevOptIn ?? "";
    }
  });

  test("CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1 restores the rule-based allow in production", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOptIn = process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"];
    process.env.NODE_ENV = "production";
    process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = "1";
    __resetRuleBasedJudgeWarningForTests();
    try {
      const v = await evaluateJustification({ ...OVERLAPPING });
      expect(v.allow).toBe(true);
    } finally {
      process.env.NODE_ENV = prevEnv ?? "test";
      process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] = prevOptIn ?? "";
    }
  });

  test("custom judge overrides the default", async () => {
    const custom: JustificationJudge = () => ({
      allow: false,
      reason: "denied by test judge",
      judgeModel: "test-judge",
    });
    const v = await evaluateJustification(
      {
        toolName: "SendMessage",
        justification: "long enough justification text here",
        sessionGoal: "long enough justification text here",
        input: {},
      },
      custom,
    );
    expect(v.allow).toBe(false);
    expect(v.judgeModel).toBe("test-judge");
  });

  test("async judge is awaited", async () => {
    const asyncJudge: JustificationJudge = async () => ({
      allow: true,
      reason: "async ok",
      judgeModel: "async-test",
    });
    const v = await evaluateJustification(
      {
        toolName: "X",
        justification: "long enough justification text here",
        sessionGoal: "long enough justification text here",
        input: {},
      },
      asyncJudge,
    );
    expect(v.allow).toBe(true);
    expect(v.judgeModel).toBe("async-test");
  });

  // FR-004 — a model-backed judge plugs into evaluateJustification with no
  // signature change; its judgeModel + confidence propagate onto the
  // verdict. Stub stands in for @crewhaus/justification-judge-claude so this
  // assertion stays in-package and deterministic.
  test("model-backed judge round-trips judgeModel + confidence (no signature change)", async () => {
    const modelBackedJudge: JustificationJudge = async (input) => ({
      allow: true,
      reason: `model judged "${input.toolName}" consistent with the session goal`,
      confidence: 0.83,
      judgeModel: "claude-haiku-4-5",
    });
    const v = await evaluateJustification(
      {
        toolName: "SendMessage",
        justification: "acknowledge the ticket the user pointed me at",
        sessionGoal: "Acknowledge support tickets the user points you at.",
        input: { body: "got it" },
      },
      modelBackedJudge,
    );
    expect(v.allow).toBe(true);
    expect(v.judgeModel).toBe("claude-haiku-4-5");
    expect(v.confidence).toBe(0.83);
    expect(v.reason).toContain("SendMessage");
  });
});

// #161 (CWE-807) — the rule-based judge is satisfiable by attacker-influenced
// justification text, so in a real (non-test) run evaluateJustification must
// surface a prominent one-time warning that it offers no protection and that
// production needs an LLM-backed judge. A model-backed judge must NOT trip it.
describe("Pillar 3 — rule-based judge weakness warning (#161)", () => {
  const originalWarn = console.warn;
  const originalNodeEnv = process.env.NODE_ENV;
  let warnings: string[] = [];

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    // The guard latches per process; reset it so each test asserts for the
    // right reason regardless of order.
    __resetRuleBasedJudgeWarningForTests();
  });

  afterEach(() => {
    console.warn = originalWarn;
    process.env.NODE_ENV = originalNodeEnv;
    __resetRuleBasedJudgeWarningForTests();
  });

  test("warns for the rule-based judge path in a non-test run", async () => {
    process.env.NODE_ENV = "production";
    await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[permission-engine]");
    expect(warnings[0]).toContain("SECURITY");
    expect(warnings[0]).toContain("EvmSendTransaction");
    expect(warnings[0]).toContain("security.justification.judge: claude");
    // Warning is decoupled from the verdict — it fires on allow paths too.
  });

  test("warns on the rule-based allow path AND fails it closed in production", async () => {
    process.env.NODE_ENV = "production";
    const v = await evaluateJustification({
      toolName: "SendMessage",
      justification: "post the email summary to the #customer-success channel",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    // The rule-based judge would have allowed (token overlap), so the warning
    // fires — but the allow is overridden to a fail-closed deny in production.
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/fail-closed/);
    expect(v.judgeModel).toBe(RULE_BASED_JUDGE_MODEL);
    expect(warnings).toHaveLength(1);
  });

  test("fires at most once per process even across many tool calls", async () => {
    process.env.NODE_ENV = "production";
    for (let i = 0; i < 5; i++) {
      await evaluateJustification({
        toolName: `Tool${i}`,
        justification: "broadcasting a transaction to mint the new NFT collection",
        sessionGoal: "summarize the customer's recent email correspondence",
        input: {},
      });
    }
    expect(warnings).toHaveLength(1);
    // First-seen tool name is the one captured in the one-time warning.
    expect(warnings[0]).toContain("Tool0");
  });

  test("does NOT warn for an injected model-backed judge", async () => {
    process.env.NODE_ENV = "production";
    const modelBackedJudge: JustificationJudge = async (input) => ({
      allow: true,
      reason: `model judged "${input.toolName}" consistent with the session goal`,
      confidence: 0.91,
      judgeModel: "claude-haiku-4-5",
    });
    const v = await evaluateJustification(
      {
        toolName: "EvmSendTransaction",
        justification: "broadcasting a transaction to mint the new NFT collection",
        sessionGoal: "summarize the customer's recent email correspondence",
        input: {},
      },
      modelBackedJudge,
    );
    expect(v.judgeModel).toBe("claude-haiku-4-5");
    expect(warnings).toHaveLength(0);
  });

  test("stays silent under NODE_ENV=test even on the rule-based path", async () => {
    process.env.NODE_ENV = "test";
    await evaluateJustification({
      toolName: "EvmSendTransaction",
      justification: "broadcasting a transaction to mint the new NFT collection",
      sessionGoal: "summarize the customer's recent email correspondence",
      input: {},
    });
    expect(warnings).toHaveLength(0);
  });
});
