/**
 * 0.6.0 design §4.4 — `narrowRuleSet(base, deny, ask)`: the per-candidate
 * permission narrowing is a decision-level MEET (deny < ask < allow). The
 * property test below draws random base rule sets, random profile deny/ask
 * lists and random calls, and asserts `evaluate(narrowed) ≤ evaluate(base)`
 * in every non-bypass mode — a profile can only ever tighten.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_DEFAULT_RULES,
  type Decision,
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  type ToolCallContext,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import { NarrowRuleSetError, narrowRuleSet } from "./index.js";

/** deny < ask < allow — the lattice the meet is defined over. */
const RANK: Record<Decision, number> = { deny: 0, ask: 1, allow: 2 };

const call = (toolName: string, input: unknown = {}, readOnly = false): ToolCallContext => ({
  toolName,
  input,
  readOnly,
  destructive: false,
});

const BASE: RuleSet = {
  flag: [],
  // A disk standing allow — `crewhaus approvals grant --always` lands here.
  settings: [{ type: "alwaysAllow", pattern: "Bash(*)", source: "settings" }],
  yaml: [
    { type: "alwaysDeny", pattern: "Edit(*)", source: "yaml" },
    { type: "alwaysAllow", pattern: "Write(*)", source: "yaml" },
  ],
  hooks: [],
  builtin: BUILTIN_DEFAULT_RULES,
};

describe("narrowRuleSet — the decision-level meet", () => {
  test("empty deny AND ask return the base by reference (nothing to narrow)", () => {
    expect(narrowRuleSet(BASE, [], [])).toBe(BASE);
  });

  test("a disk standing allow (settings) cannot defeat a profile deny", () => {
    const narrowed = narrowRuleSet(BASE, ["Bash(*)"], []);
    expect(evaluate(call("Bash", { command: "ls" }), "default", BASE)).toBe("allow");
    expect(evaluate(call("Bash", { command: "ls" }), "default", narrowed)).toBe("deny");
  });

  test("a profile ask narrows an allow to ask, but cannot soften a shape deny", () => {
    const narrowed = narrowRuleSet(BASE, [], ["Write(*)", "Edit(*)"]);
    // Write was allowed by the shape's yaml → the profile asks instead.
    expect(evaluate(call("Write", { path: "a" }), "default", BASE)).toBe("allow");
    expect(evaluate(call("Write", { path: "a" }), "default", narrowed)).toBe("ask");
    // Edit was denied by the shape's yaml → the profile ask does NOT soften it.
    expect(evaluate(call("Edit", { path: "a" }), "default", BASE)).toBe("deny");
    expect(evaluate(call("Edit", { path: "a" }), "default", narrowed)).toBe("deny");
  });

  test("the shape's denies from every source are hoisted ahead of the profile rules", () => {
    const base: RuleSet = {
      ...emptyRuleSet,
      settings: [{ type: "alwaysAsk", pattern: "Grep", source: "settings" }],
      builtin: [{ type: "alwaysDeny", pattern: "Grep", source: "builtin" }],
    };
    const narrowed = narrowRuleSet(base, [], ["Grep"]);
    const hoisted = narrowed.settings[0] as PermissionRule;
    expect(hoisted.type).toBe("alwaysDeny");
    expect(hoisted.pattern).toBe("Grep");
    expect(hoisted.source).toBe("settings");
    // The profile's ask comes AFTER the hoisted deny, so the deny wins.
    expect(evaluate(call("Grep"), "default", narrowed)).toBe("deny");
  });

  test("no new RuleSource is introduced and the other sources are carried verbatim", () => {
    const narrowed = narrowRuleSet(BASE, ["Bash(*)"], ["Write(*)"]);
    for (const source of ["flag", "settings", "yaml", "hooks", "builtin"] as const) {
      for (const rule of narrowed[source]) {
        expect(["flag", "settings", "yaml", "hook", "builtin"]).toContain(rule.source);
      }
    }
    expect(narrowed.flag).toEqual(BASE.flag);
    expect(narrowed.yaml).toEqual(BASE.yaml);
    expect(narrowed.hooks).toEqual(BASE.hooks);
    expect(narrowed.builtin).toEqual(BASE.builtin);
    // The input is never mutated.
    expect(BASE.settings).toHaveLength(1);
  });

  test("a `flag` allow keeps the engine's own top priority (operator invocation wins)", () => {
    const base: RuleSet = {
      ...emptyRuleSet,
      flag: [{ type: "alwaysAllow", pattern: "Bash(*)", source: "flag" }],
    };
    const narrowed = narrowRuleSet(base, ["Bash(*)"], []);
    expect(evaluate(call("Bash", { command: "ls" }), "default", narrowed)).toBe("allow");
    expect(evaluate(call("Bash", { command: "ls" }), "default", base)).toBe("allow");
  });

  test("mode semantics are untouched: plan stays readOnly-only, bypass stays bypass", () => {
    const narrowed = narrowRuleSet(BASE, ["Read"], []);
    expect(evaluate(call("Read", {}, true), "plan", narrowed)).toBe("allow");
    expect(evaluate(call("Bash", {}, false), "plan", narrowed)).toBe("deny");
    expect(evaluate(call("Read", {}, true), "bypass", narrowed)).toBe("allow");
  });

  test("a malformed profile pattern is a boot-time config error, never a silent deny-all", () => {
    expect(() => narrowRuleSet(BASE, ["Bash(("], [])).toThrow(NarrowRuleSetError);
    expect(() => narrowRuleSet(BASE, [], ["Bash(("])).toThrow(/does not compile/);
  });

  test("PROPERTY: evaluate(narrowed) ≤ evaluate(base) for random rule sets, profiles and calls", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 0x2f6e2b1;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(rnd() * xs.length)] as T;
    const TOOLS = ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "Consult"];
    const PATTERNS = [
      "Bash",
      "Bash(*)",
      "Bash(rm**)",
      "Read",
      "Write(*)",
      "Edit(*)",
      "Grep",
      "Glob",
      "WebFetch",
      "Consult",
      "*",
    ];
    const TYPES = ["alwaysAllow", "alwaysDeny", "alwaysAsk"] as const;
    const SOURCES = ["flag", "settings", "yaml", "hooks", "builtin"] as const;
    const randomRules = (source: PermissionRule["source"], max: number): PermissionRule[] => {
      const n = Math.floor(rnd() * (max + 1));
      const out: PermissionRule[] = [];
      for (let i = 0; i < n; i++) out.push({ type: pick(TYPES), pattern: pick(PATTERNS), source });
      return out;
    };
    const randomList = (max: number): string[] => {
      const n = Math.floor(rnd() * (max + 1));
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push(pick(PATTERNS));
      return out;
    };
    let checked = 0;
    for (let round = 0; round < 400; round++) {
      const base: RuleSet = {
        flag: randomRules("flag", 1),
        settings: randomRules("settings", 3),
        yaml: randomRules("yaml", 3),
        hooks: randomRules("hook", 1),
        builtin: rnd() < 0.5 ? [...BUILTIN_DEFAULT_RULES] : randomRules("builtin", 2),
      };
      const deny = randomList(2);
      const ask = randomList(2);
      const narrowed = narrowRuleSet(base, deny, ask);
      for (const s of SOURCES) expect(narrowed[s].every((r) => r.source !== undefined)).toBe(true);
      for (let c = 0; c < 6; c++) {
        const toolName = pick(TOOLS);
        const input = pick([{}, { command: "rm -rf /tmp/x" }, { command: "ls" }, { path: "a" }]);
        const readOnly = rnd() < 0.4;
        const mode: PermissionMode = pick(["default", "auto", "plan"] as const);
        const before = evaluate(call(toolName, input, readOnly), mode, base);
        const after = evaluate(call(toolName, input, readOnly), mode, narrowed);
        if (RANK[after] > RANK[before]) {
          throw new Error(
            `narrowRuleSet WIDENED ${toolName} (${mode}): ${before} → ${after}\nbase=${JSON.stringify(base)}\ndeny=${JSON.stringify(deny)} ask=${JSON.stringify(ask)}`,
          );
        }
        checked += 1;
      }
    }
    expect(checked).toBe(2400);
  });
});
