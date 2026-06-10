import { describe, expect, test } from "bun:test";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import { resolveChildPermissions } from "./index.js";

const PARENT_RULES: RuleSet = {
  flag: [{ type: "alwaysAllow", pattern: "Read", source: "flag" }],
  settings: [{ type: "alwaysDeny", pattern: "Bash(curl**)", source: "settings" }],
  yaml: [{ type: "alwaysAllow", pattern: "Glob", source: "yaml" }],
  hooks: [],
  builtin: BUILTIN_DEFAULT_RULES,
};

const DEF_BASE: SubAgentDefinition = {
  name: "child",
  description: "test child",
  instructions: "do the thing",
};

describe("resolveChildPermissions — modes", () => {
  test("inherit (undefined) copies parent rules verbatim", () => {
    const out = resolveChildPermissions({ mode: "auto", rules: PARENT_RULES }, DEF_BASE);
    expect(out.mode).toBe("auto");
    expect(out.rules.flag).toEqual(PARENT_RULES.flag);
    expect(out.rules.settings).toEqual(PARENT_RULES.settings);
    expect(out.rules.yaml).toEqual(PARENT_RULES.yaml);
    expect(out.rules.builtin).toEqual(BUILTIN_DEFAULT_RULES);
  });

  test('inherit ("inherit" string) is identical to undefined', () => {
    const a = resolveChildPermissions({ mode: "default", rules: PARENT_RULES }, DEF_BASE);
    const b = resolveChildPermissions(
      { mode: "default", rules: PARENT_RULES },
      { ...DEF_BASE, permissions: "inherit" },
    );
    expect(a).toEqual(b);
  });

  test("scoped keeps only rules whose toolGlob matches def.tools", () => {
    const out = resolveChildPermissions(
      { mode: "default", rules: PARENT_RULES },
      { ...DEF_BASE, tools: ["Read", "Glob"], permissions: "scoped" },
    );
    // flag rule "Read" matches → kept.
    // settings rule "Bash(curl**)" → toolGlob "Bash" does not match Read/Glob → dropped.
    // yaml rule "Glob" → matches → kept.
    // builtin: "Bash(rm**)", "Bash(sudo**)" dropped, "Read"/"Glob"/"Grep" → Read & Glob match.
    expect(out.rules.flag).toHaveLength(1);
    expect(out.rules.flag[0]?.pattern).toBe("Read");
    expect(out.rules.settings).toHaveLength(0);
    expect(out.rules.yaml).toHaveLength(1);
    expect(out.rules.yaml[0]?.pattern).toBe("Glob");
    const builtinPatterns = out.rules.builtin.map((r) => r.pattern);
    expect(builtinPatterns).toContain("Read");
    expect(builtinPatterns).toContain("Glob");
    expect(builtinPatterns).not.toContain("Bash(rm**)");
  });

  test("scoped drops a rule whose pattern fails to compile (defensive catch)", () => {
    // A malformed pattern that makes compilePattern() throw (unmatched paren).
    // ruleMatchesAnyAllowedName must swallow the throw and treat the rule as a
    // non-match, so it is filtered out rather than aborting the scope reduction.
    const rulesWithBadPattern: RuleSet = {
      flag: [
        { type: "alwaysAllow", pattern: "Read", source: "flag" },
        { type: "alwaysDeny", pattern: "Bash(", source: "flag" },
      ],
      settings: [],
      yaml: [],
      hooks: [],
      builtin: [],
    };
    const out = resolveChildPermissions(
      { mode: "default", rules: rulesWithBadPattern },
      { ...DEF_BASE, tools: ["Read"], permissions: "scoped" },
    );
    // The valid "Read" rule survives; the uncompilable "Bash(" rule is dropped.
    expect(out.rules.flag).toHaveLength(1);
    expect(out.rules.flag[0]?.pattern).toBe("Read");
  });

  test("scoped drops a rule with an empty pattern (compilePattern throws)", () => {
    const rulesWithEmptyPattern: RuleSet = {
      flag: [{ type: "alwaysAllow", pattern: "   ", source: "flag" }],
      settings: [],
      yaml: [],
      hooks: [],
      builtin: [],
    };
    const out = resolveChildPermissions(
      { mode: "default", rules: rulesWithEmptyPattern },
      { ...DEF_BASE, tools: ["Read"], permissions: "scoped" },
    );
    expect(out.rules.flag).toHaveLength(0);
  });

  test("scoped with empty def.tools drops every rule", () => {
    const out = resolveChildPermissions(
      { mode: "default", rules: PARENT_RULES },
      { ...DEF_BASE, tools: [], permissions: "scoped" },
    );
    expect(out.rules.flag).toHaveLength(0);
    expect(out.rules.settings).toHaveLength(0);
    expect(out.rules.yaml).toHaveLength(0);
    expect(out.rules.builtin).toHaveLength(0);
  });

  test("replace { allow, deny } lifts the safety-floor guards above the replace allows", () => {
    const out = resolveChildPermissions(
      { mode: "default", rules: PARENT_RULES },
      {
        ...DEF_BASE,
        permissions: { allow: ["Read", "Grep"], deny: ["Bash(rm**)"] },
      },
    );
    expect(out.rules.flag).toHaveLength(0);
    // Floor GUARD rules (alwaysAsk/alwaysDeny) are lifted into `settings`,
    // which outranks `yaml` — so they gate before any replace allow.
    expect(out.rules.settings.map((r) => r.pattern)).toEqual(["Bash(rm**)", "Bash(sudo**)"]);
    expect(out.rules.settings.every((r) => r.type === "alwaysAsk")).toBe(true);
    // Replace allow/deny live in yaml.
    const yamlRules = out.rules.yaml;
    expect(yamlRules).toHaveLength(3);
    expect(yamlRules.filter((r) => r.type === "alwaysAllow")).toHaveLength(2);
    expect(yamlRules.filter((r) => r.type === "alwaysDeny")).toHaveLength(1);
    // Permissive defaults stay in builtin as a narrow-only fallback.
    expect(out.rules.builtin.map((r) => r.pattern)).toEqual(["Read", "Glob", "Grep"]);
    expect(out.rules.builtin.every((r) => r.type === "alwaysAllow")).toBe(true);
  });
});

// SECURITY (privilege escalation): in replace mode a child must not be able to
// grant itself a permission the builtin safety floor gates. Evaluate the
// resolved rules end-to-end through the engine to prove the floor wins.
describe("resolveChildPermissions — replace floor is authoritative", () => {
  // Bare `Bash` is the blanket grant — it matches EVERY Bash command
  // (including `rm -rf /`), so without the fix the child would run any shell
  // with no prompt. The floor must claw `rm`/`sudo` back to "ask".
  const blanketBash: SubAgentDefinition = {
    ...DEF_BASE,
    tools: ["Bash"],
    permissions: { allow: ["Bash"], deny: [] },
  };
  const bashRm: ToolCallContext = {
    toolName: "Bash",
    input: { command: "rm -rf /" },
    readOnly: false,
    destructive: true,
  };
  const bashLs: ToolCallContext = {
    toolName: "Bash",
    input: { command: "ls" },
    readOnly: false,
    destructive: true,
  };

  test("a blanket replace allow:[Bash] cannot override the Bash(rm**) floor", () => {
    const out = resolveChildPermissions({ mode: "default", rules: PARENT_RULES }, blanketBash);
    // The bare `Bash` allow DOES match `rm -rf /`. Before the fix that yaml
    // allow outranked the builtin floor → "allow" (escalation); now the floor
    // lives in `settings`, which outranks yaml → "ask".
    expect(evaluate(bashRm, out.mode, out.rules)).toBe("ask");
  });

  test("the replace allow still grants non-floor Bash commands", () => {
    const out = resolveChildPermissions({ mode: "default", rules: PARENT_RULES }, blanketBash);
    expect(evaluate(bashLs, out.mode, out.rules)).toBe("allow");
  });
});

describe("resolveChildPermissions — bypass non-propagation (T8)", () => {
  test("parent bypass + def without inherit_bypass → child mode is default", () => {
    const out = resolveChildPermissions({ mode: "bypass", rules: PARENT_RULES }, DEF_BASE);
    expect(out.mode).toBe("default");
  });

  test("parent bypass + def.inherit_bypass=false → child mode is default", () => {
    const out = resolveChildPermissions(
      { mode: "bypass", rules: PARENT_RULES },
      { ...DEF_BASE, inherit_bypass: false },
    );
    expect(out.mode).toBe("default");
  });

  test("parent bypass + def.inherit_bypass=true → child mode stays bypass", () => {
    const out = resolveChildPermissions(
      { mode: "bypass", rules: PARENT_RULES },
      { ...DEF_BASE, inherit_bypass: true },
    );
    expect(out.mode).toBe("bypass");
  });

  test("non-bypass parent ignores inherit_bypass", () => {
    for (const mode of ["default", "plan", "auto"] as const) {
      const out = resolveChildPermissions(
        { mode, rules: PARENT_RULES },
        { ...DEF_BASE, inherit_bypass: true },
      );
      expect(out.mode).toBe(mode);
    }
  });
});

describe("resolveChildPermissions — property (T9)", () => {
  // Helper random pickers — seeded deterministically per iteration so failures
  // are reproducible by re-running the same test (Bun does not re-seed RNG
  // between test runs by default, but the loop count keeps flakes low).
  function randMode(): PermissionMode {
    const modes: PermissionMode[] = ["default", "plan", "auto", "bypass"];
    return modes[Math.floor(Math.random() * modes.length)] ?? "default";
  }
  function randPerms(): SubAgentDefinition["permissions"] {
    const which = Math.floor(Math.random() * 4);
    if (which === 0) return undefined;
    if (which === 1) return "inherit";
    if (which === 2) return "scoped";
    return { allow: ["Read"], deny: ["Bash(rm**)"] };
  }
  function randTools(): string[] | undefined {
    const which = Math.floor(Math.random() * 3);
    if (which === 0) return undefined;
    if (which === 1) return [];
    return ["Read", "Grep"];
  }

  test("never widens past parent + builtin defaults", () => {
    const PARENT_TOTAL =
      PARENT_RULES.flag.length +
      PARENT_RULES.settings.length +
      PARENT_RULES.yaml.length +
      PARENT_RULES.hooks.length +
      PARENT_RULES.builtin.length;

    for (let i = 0; i < 100; i++) {
      const mode = randMode();
      const def: SubAgentDefinition = {
        name: "p",
        description: "p",
        instructions: "p",
        ...(randTools() !== undefined ? { tools: randTools() } : {}),
        ...(randPerms() !== undefined ? { permissions: randPerms() } : {}),
        inherit_bypass: Math.random() < 0.3,
      };
      const out = resolveChildPermissions({ mode, rules: PARENT_RULES }, def);
      const childTotal =
        out.rules.flag.length +
        out.rules.settings.length +
        out.rules.yaml.length +
        out.rules.hooks.length +
        out.rules.builtin.length;
      // For inherit & scoped, child rules are a subset of parent.
      // For replace, yaml ≤ allow.length + deny.length (which is 2 here),
      // and builtin = BUILTIN_DEFAULT_RULES (≤ parent.builtin).
      // Either way the total is bounded by parent + replace-yaml budget.
      expect(childTotal).toBeLessThanOrEqual(PARENT_TOTAL + 2);
      // Bypass non-propagation invariant.
      if (mode === "bypass" && def.inherit_bypass !== true) {
        expect(out.mode).toBe("default");
      } else {
        expect(out.mode).toBe(mode);
      }
    }
  });
});

describe("resolveChildPermissions — empty parent fallback", () => {
  test("inherit on empty rules yields empty rules", () => {
    const out = resolveChildPermissions({ mode: "default", rules: emptyRuleSet }, DEF_BASE);
    expect(out.rules.flag).toEqual([]);
    expect(out.rules.builtin).toEqual([]);
  });
});
