import { describe, expect, test } from "bun:test";
import {
  BUILTIN_DEFAULT_RULES,
  PermissionConfigError,
  type PermissionRule,
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluate,
  evaluateWithReason,
  parsePermissionsConfig,
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

  test("a malformed pattern is skipped (engine doesn't crash)", () => {
    const rs: RuleSet = {
      ...emptyRuleSet,
      yaml: [rule("alwaysAllow", "Bash(unclosed"), rule("alwaysAllow", "Read")],
    };
    // First rule errors → skipped; second matches → allow.
    expect(evaluate(readCall, "default", rs)).toBe("allow");
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
