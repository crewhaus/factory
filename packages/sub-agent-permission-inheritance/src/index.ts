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
 */
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
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
