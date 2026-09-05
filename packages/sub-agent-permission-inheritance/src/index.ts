/**
 * Catalog R10 `sub-agent-permission-inheritance` — Section 13.
 *
 * `resolveChildPermissions(parent, def)` reduces a parent run's permission
 * surface to the child's surface for one sub-agent invocation.
 *
 * Mode resolution
 *   - parent.mode === "bypass" AND def.inherit_bypass !== true → child mode
 *     is "default". This is the security-critical case: bypass never
 *     propagates implicitly.
 *   - otherwise the child inherits the parent's mode.
 *
 * Rule resolution
 *   - "inherit" (or undefined) → copy parent's rules unchanged.
 *   - "scoped"               → keep only parent rules whose toolGlob can
 *                              match at least one name in `def.tools`.
 *                              Empty `def.tools` → empty rule set (no
 *                              tools allowed by name; the empty child
 *                              catalog enforces this independently).
 *   - { allow, deny }        → replace yaml-source rules with explicit
 *                              alwaysAllow/alwaysDeny. The builtin safety
 *                              floor's GUARD rules (alwaysAsk/alwaysDeny) are
 *                              lifted into the higher-priority `settings`
 *                              source so they OUTRANK the replace allows — a
 *                              child can never override the floor (e.g.
 *                              `Bash(rm**)` stays gated even under
 *                              `allow: ["Bash(**)"]`). The permissive defaults
 *                              (Read/Glob/Grep) stay in `builtin` as a
 *                              narrow-only fallback.
 *
 * `narrowRuleSet(base, deny, ask)` (0.6.0 design §4.4) is the second export:
 * the per-candidate permission narrowing a `models:` profile's restricted
 * `{deny, ask}` block applies to the run's RuleSet — a decision-level MEET
 * (deny < ask < allow) that can only ever tighten. See its docblock.
 */
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { CrewhausError } from "@crewhaus/errors";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type PermissionRule,
  type RuleSet,
  emptyRuleSet,
} from "@crewhaus/permission-engine";
import { compilePattern } from "@crewhaus/tool-permission-matcher";

export type ChildPermissions = {
  readonly mode: PermissionMode;
  readonly rules: RuleSet;
};

/** Compute the child mode given the parent mode and the definition's bypass-opt-in. */
function resolveChildMode(parentMode: PermissionMode, def: SubAgentDefinition): PermissionMode {
  if (parentMode === "bypass" && def.inherit_bypass !== true) return "default";
  return parentMode;
}

/** True iff `rule.pattern`'s tool-glob can match any name in `allowedToolNames`. */
function ruleMatchesAnyAllowedName(
  rule: PermissionRule,
  allowedToolNames: ReadonlyArray<string>,
): boolean {
  let compiled: ReturnType<typeof compilePattern>;
  try {
    compiled = compilePattern(rule.pattern);
  } catch {
    return false;
  }
  return allowedToolNames.some((name) => compiled._toolRe.test(name));
}

/** Filter every rule source by the allowlist; preserves the source taxonomy. */
function scopeRuleSet(parent: RuleSet, allowedToolNames: ReadonlyArray<string>): RuleSet {
  const f = (rs: ReadonlyArray<PermissionRule>): ReadonlyArray<PermissionRule> =>
    rs.filter((r) => ruleMatchesAnyAllowedName(r, allowedToolNames));
  return {
    flag: f(parent.flag),
    settings: f(parent.settings),
    yaml: f(parent.yaml),
    hooks: f(parent.hooks),
    builtin: f(parent.builtin),
  };
}

function buildReplaceRuleSet(allow: ReadonlyArray<string>, deny: ReadonlyArray<string>): RuleSet {
  const allowRules: PermissionRule[] = allow.map((pattern) => ({
    type: "alwaysAllow" as const,
    pattern,
    source: "yaml" as const,
  }));
  const denyRules: PermissionRule[] = deny.map((pattern) => ({
    type: "alwaysDeny" as const,
    pattern,
    source: "yaml" as const,
  }));
  // The builtin safety floor must OUTRANK the replace-supplied yaml allows.
  // permission-engine's SOURCE_PRIORITY evaluates yaml before builtin and
  // first-match wins, so leaving the floor in `builtin` (the old behavior) let
  // a child's `allow: ["Bash(**)"]` beat the `alwaysAsk Bash(rm**)` guard —
  // escalating the child past the parent's effective surface. Lift the floor's
  // GUARD rules (alwaysAsk/alwaysDeny) into `settings`, which outranks `yaml`,
  // so they gate before any replace allow. The permissive defaults
  // (alwaysAllow Read/Glob/Grep) stay in `builtin` as a low-priority fallback
  // that can only narrow, never widen, the child.
  const floorGuards: PermissionRule[] = BUILTIN_DEFAULT_RULES.filter(
    (r) => r.type === "alwaysDeny" || r.type === "alwaysAsk",
  ).map((r) => ({ ...r, source: "settings" as const }));
  const floorAllows: PermissionRule[] = BUILTIN_DEFAULT_RULES.filter(
    (r) => r.type === "alwaysAllow",
  ).map((r) => ({ ...r }));
  return {
    ...emptyRuleSet,
    settings: floorGuards,
    yaml: [...allowRules, ...denyRules],
    builtin: floorAllows,
  };
}

export function resolveChildPermissions(
  parent: { readonly mode: PermissionMode; readonly rules: RuleSet },
  def: SubAgentDefinition,
): ChildPermissions {
  const mode = resolveChildMode(parent.mode, def);
  const perm = def.permissions;

  if (perm === undefined || perm === "inherit") {
    return {
      mode,
      rules: {
        flag: [...parent.rules.flag],
        settings: [...parent.rules.settings],
        yaml: [...parent.rules.yaml],
        hooks: [...parent.rules.hooks],
        builtin: [...parent.rules.builtin],
      },
    };
  }
  if (perm === "scoped") {
    return { mode, rules: scopeRuleSet(parent.rules, def.tools ?? []) };
  }
  // perm = { allow, deny }
  return { mode, rules: buildReplaceRuleSet(perm.allow, perm.deny) };
}

/**
 * 0.6.0 §4.4 — a malformed pattern in a profile's `deny` / `ask` list. Thrown
 * at boot, not at call time: permission-engine fails CLOSED on an
 * uncompilable guard rule (it treats the rule as matching every call), so a
 * typo in a profile deny would silently deny the candidate every tool.
 * Surfacing it as a config error is the honest failure.
 */
export class NarrowRuleSetError extends CrewhausError {
  override readonly name = "NarrowRuleSetError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

function assertCompilable(patterns: ReadonlyArray<string>, kind: "deny" | "ask"): void {
  for (const pattern of patterns) {
    try {
      compilePattern(pattern);
    } catch (err) {
      throw new NarrowRuleSetError(
        `narrowRuleSet: profile ${kind} pattern ${JSON.stringify(pattern)} does not compile — ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }
  }
}

/**
 * 0.6.0 design §4.4 — narrow a run's RuleSet for ONE pool candidate whose
 * `models:` profile declares the restricted `permissions: { deny, ask }`
 * block (no `alwaysAllow`, no `mode` — `packages/spec` rejects both).
 *
 * Narrowing is defined as a **decision-level meet** (deny < ask < allow), not
 * as rule-array surgery: for every call, `evaluate(narrowed)` is at most as
 * permissive as `evaluate(base)`, and a profile rule can only move a
 * decision DOWN the lattice. `evaluateWithReason` is first-match-wins across
 * `flag > settings > yaml > hooks > builtin`, so the meet is realised by
 * ORDERING inside the `settings` source (no new `RuleSource` is introduced):
 *
 *   settings = [ every `alwaysDeny` the base carries in ANY source,
 *                the profile's denies, the profile's asks,
 *                the base's own remaining settings rules ]
 *
 * — the shape's existing denies are re-sourced ahead of the profile's rules
 * so a profile `ask` can never soften a shape `deny`, and the profile's
 * rules sit ahead of the disk standing allows (`crewhaus approvals grant
 * --always`, the Slack "Always allow" button live in `settings`) so a
 * standing allow cannot defeat the profile. `yaml`, `hooks` and `builtin`
 * are carried verbatim (their denies are shadowed by the hoisted copy —
 * harmless). `flag` is carried verbatim too and keeps the engine's own top
 * priority: a `--allow` flag is the operator's explicit invocation-time
 * decision, and outranking it from a spec-authored profile would invert the
 * engine's documented source order. Mode semantics are untouched: `plan`
 * stays readOnly-only, `bypass` (CLI-only) stays bypass.
 *
 * Empty `deny` AND `ask` return `base` by reference — nothing to narrow, so
 * the run stays byte-identical (the spread-return-`{}` discipline applied to
 * a RuleSet). The property `evaluate(narrowed) ≤ evaluate(base)` is pinned by
 * a randomised test in `index.test.ts`.
 */
export function narrowRuleSet(
  base: RuleSet,
  deny: ReadonlyArray<string>,
  ask: ReadonlyArray<string>,
): RuleSet {
  if (deny.length === 0 && ask.length === 0) return base;
  assertCompilable(deny, "deny");
  assertCompilable(ask, "ask");
  const hoistedDenies: PermissionRule[] = [];
  for (const source of ["flag", "settings", "yaml", "hooks", "builtin"] as const) {
    for (const rule of base[source]) {
      if (rule.type === "alwaysDeny") {
        hoistedDenies.push(rule.source === "settings" ? rule : { ...rule, source: "settings" });
      }
    }
  }
  const profileDenies: PermissionRule[] = deny.map((pattern) => ({
    type: "alwaysDeny" as const,
    pattern,
    source: "settings" as const,
  }));
  const profileAsks: PermissionRule[] = ask.map((pattern) => ({
    type: "alwaysAsk" as const,
    pattern,
    source: "settings" as const,
  }));
  return {
    flag: [...base.flag],
    settings: [
      ...hoistedDenies,
      ...profileDenies,
      ...profileAsks,
      ...base.settings.filter((r) => r.type !== "alwaysDeny"),
    ],
    yaml: [...base.yaml],
    hooks: [...base.hooks],
    builtin: [...base.builtin],
  };
}
