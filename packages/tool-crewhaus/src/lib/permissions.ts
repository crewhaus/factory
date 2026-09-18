/**
 * "What can this harness actually do" — the permission-rule side of it.
 *
 * `@crewhaus/permission-engine` decides ONE call at run time, against the
 * live rule set, the live tool flags and a live sandbox. This module answers
 * the offline question a fleet operator asks instead: for every tool a spec
 * GRANTS, which declared rule (if any) speaks to it, and which of the
 * unruled ones are the dangerous kind.
 *
 * Three limits, stated here because a permission report that overstates its
 * reach is worse than none:
 *
 *   1. Only the tool-NAME half of a pattern is matched. `Bash(git *)` is
 *      reported as covering `Bash` CONDITIONALLY — whether a given call's
 *      arguments match is a run-time fact about the call, not about the spec.
 *   2. Only the spec's own rules are seen. The engine also consults CLI
 *      flags, `.crewhaus/settings.json`, hook-installed rules and a builtin
 *      floor, in that precedence order; none of those live in the spec.
 *   3. `readOnly` / `destructive` are properties of the TOOL, and the tool
 *      registry lives in the compiled bundle, not in the spec. So the
 *      destructive column is filled only from what the document itself
 *      declares (`mcp_servers.*.tool_flags`) plus anything the caller passes
 *      in. It is never guessed from a name.
 *
 * Pure: no filesystem, no clock, no locale-sensitive comparison.
 */

import { isOutwardName } from "@crewhaus/tool-builder";
import { compareStrings } from "./spec-view";

/** A rule as a spec declares it. */
export type RuleLike = { readonly type: string; readonly pattern: string };

/** How thoroughly a rule's pattern covers a tool name. */
export type Coverage = "full" | "conditional" | "none";

export type ToolPermission = {
  readonly tool: string;
  /** `allow` / `deny` / `ask` from the matched rule, else the mode fallback. */
  readonly decision: string;
  /** Absent when no declared rule names this tool. */
  readonly rule?: RuleLike;
  /** True when the matched rule also constrains arguments (`Tool(glob)`). */
  readonly conditional: boolean;
  /** The tool crosses a process or network boundary by name (see `isOutwardName`). */
  readonly external: boolean;
  /** Only set when the document or the caller SAYS so — never inferred. */
  readonly destructive?: boolean;
};

export type PermissionFinding = {
  readonly tool: string;
  readonly reason: string;
};

export type PermissionAuditResult = {
  readonly mode: string;
  readonly askMode: string;
  /** What an unmatched call resolves to under `mode`, before tool flags. */
  readonly fallback: string;
  readonly tools: readonly ToolPermission[];
  /** Declared rules that match none of the granted tools — likely dead. */
  readonly unusedRules: readonly RuleLike[];
  /**
   * Rules the runtime matcher would REFUSE to compile. The engine fails
   * closed on these: an uncompilable `alwaysDeny`/`alwaysAsk` gates every
   * call as if it had matched, while an uncompilable `alwaysAllow` is simply
   * dropped. Reported separately because neither behaviour is what the
   * author wrote, and because a malformed deny silently covering everything
   * is the kind of thing an audit exists to surface.
   */
  readonly malformedRules: readonly RuleLike[];
  /**
   * True when `mode` makes the rule list moot: in `plan` the engine decides
   * on the tool's own `readOnly` flag and consults no rule at all, so every
   * `decision` below describes a rule that will not be reached.
   */
  readonly modeOverridesRules: boolean;
  readonly findings: readonly PermissionFinding[];
};

/**
 * Split a permission pattern into its tool-name glob and its optional
 * argument glob, mirroring `compilePattern` in
 * `@crewhaus/tool-permission-matcher`. `undefined` means the pattern is
 * malformed and the matcher would throw on it.
 */
export function splitPattern(
  pattern: string,
): { readonly toolGlob: string; readonly argGlob: string | null } | undefined {
  if (pattern.trim() === "") return undefined;
  const parenIdx = pattern.indexOf("(");
  if (parenIdx === -1) return { toolGlob: pattern.trim(), argGlob: null };
  if (!pattern.endsWith(")")) return undefined;
  const toolGlob = pattern.slice(0, parenIdx).trim();
  if (toolGlob === "") return undefined;
  return { toolGlob, argGlob: pattern.slice(parenIdx + 1, -1) };
}

/**
 * Compile a tool-name glob to a regex, mirroring `globToRegex` in
 * `@crewhaus/tool-permission-matcher` for the tool-name half of a pattern.
 *
 * Three wildcards, as there: `**` is any run of characters, `*` is any run
 * that is not `/`, `?` is one such character. A BACKSLASH is the escape
 * lead-in — `\*` matches a literal asterisk — which the matcher supports and
 * `escapeGlobLiteral` emits; treating it as an ordinary literal here (the
 * previous behaviour) made `Web\*Fetch` compile to a regex demanding an
 * actual backslash in the tool name, so this module and the engine disagreed
 * about which tools a rule covers. Tool names contain no separators, so the
 * matcher's path-aware `**` cases collapse to a plain `.*`.
 *
 * Runs of `*` are folded to ONE `.*`: `.*.*.*.*a` and `.*a` accept the same
 * strings, but the first backtracks exponentially against a name that has no
 * `a` in it, and both the pattern and the tool name come from a spec.
 */
export function compileToolGlob(glob: string): RegExp {
  let re = "";
  let i = 0;
  let lastWasAnyRun = false;
  const anyRun = (): void => {
    if (!lastWasAnyRun) re += ".*";
    lastWasAnyRun = true;
  };
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === "\\" && i + 1 < glob.length) {
      // Escape lead-in: the next character is a literal, escaped against the
      // FULL regex metachar set (including `*`/`?`, which are quantifiers).
      re += (glob[i + 1] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      lastWasAnyRun = false;
      i += 2;
    } else if (ch === "*" && glob[i + 1] === "*") {
      anyRun();
      i += 2;
    } else if (ch === "*") {
      // A `*` next to a `**` adds nothing: `.*` already covers it.
      if (lastWasAnyRun) {
        i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      re += "[^/]";
      lastWasAnyRun = false;
      i += 1;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      lastWasAnyRun = false;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, "s");
}

/** How well `pattern` covers `toolName`. A malformed pattern covers nothing. */
export function patternCoverage(pattern: string, toolName: string): Coverage {
  const split = splitPattern(pattern);
  if (split === undefined) return "none";
  if (!compileToolGlob(split.toolGlob).test(toolName)) return "none";
  return split.argGlob === null ? "full" : "conditional";
}

function decisionOf(ruleType: string): string {
  switch (ruleType) {
    case "alwaysAllow":
      return "allow";
    case "alwaysDeny":
      return "deny";
    case "alwaysAsk":
      return "ask";
    default:
      return "unknown";
  }
}

/**
 * A spec's `tools:` list may spell a builtin in either legal form — the
 * camelCase key (`webFetch`) or the registered PascalCase name (`WebFetch`).
 * Permission patterns are written against the registered name, so both forms
 * are checked wherever a name is compared to the registry.
 */
export function toRegisteredName(toolKey: string): string {
  if (toolKey.startsWith("mcp__")) return toolKey;
  const first = toolKey[0];
  return first === undefined ? toolKey : first.toUpperCase() + toolKey.slice(1);
}

/** True when the tool crosses a process or network boundary by definition. */
export function isExternalTool(toolKey: string): boolean {
  return isOutwardName(toolKey) || isOutwardName(toRegisteredName(toolKey));
}

/** What an unmatched call resolves to under each mode, before tool flags. */
export function fallbackDecision(mode: string): string {
  switch (mode) {
    case "plan":
      return "allow for read-only tools, deny for the rest";
    case "auto":
      return "allow, except destructive tools which ask";
    default:
      return "ask";
  }
}

export type AuditPermissionsInput = {
  readonly tools: readonly string[];
  readonly mode: string;
  readonly askMode: string;
  readonly rules: readonly RuleLike[];
  /** Tools the document or the caller declares destructive. */
  readonly destructiveTools?: ReadonlySet<string>;
};

/**
 * The report. Rules are consulted in declaration order and the FIRST match
 * wins, which is how the engine scans one source's rule list.
 */
export function auditPermissions(input: AuditPermissionsInput): PermissionAuditResult {
  const destructive = input.destructiveTools ?? new Set<string>();
  const fallback = fallbackDecision(input.mode);
  // `plan` never reaches the rule list — `evaluateWithReason` returns on the
  // tool's own readOnly flag before the scan — so a report that presented
  // rule decisions under it would be describing code that does not run.
  const modeOverridesRules = input.mode === "plan";
  const malformedRules = input.rules
    .filter((rule) => splitPattern(rule.pattern) === undefined)
    .sort((a, b) => compareStrings(a.pattern, b.pattern) || compareStrings(a.type, b.type));
  // The engine treats an uncompilable deny/ask as a MATCH (fail closed), so
  // from a granted tool's point of view such a rule covers everything.
  const blanketGate = malformedRules.find(
    (rule) => rule.type === "alwaysDeny" || rule.type === "alwaysAsk",
  );
  const usedRules = new Set<string>();
  const tools: ToolPermission[] = [];
  const findings: PermissionFinding[] = [];

  for (const tool of [...new Set(input.tools)].sort(compareStrings)) {
    const registered = toRegisteredName(tool);
    let matched: { rule: RuleLike; coverage: Coverage } | undefined;
    for (const rule of input.rules) {
      if (splitPattern(rule.pattern) === undefined) {
        // Mirror the engine: a broken guard still gates, a broken grant does
        // not. Scanning in declaration order, so this rule wins here exactly
        // when it would win there.
        if (rule.type === "alwaysDeny" || rule.type === "alwaysAsk") {
          matched = { rule, coverage: "full" };
          usedRules.add(`${rule.type} ${rule.pattern}`);
          break;
        }
        continue;
      }
      const coverage =
        patternCoverage(rule.pattern, tool) !== "none"
          ? patternCoverage(rule.pattern, tool)
          : patternCoverage(rule.pattern, registered);
      if (coverage !== "none") {
        matched = { rule, coverage };
        usedRules.add(`${rule.type} ${rule.pattern}`);
        break;
      }
    }
    const external = isExternalTool(tool);
    const isDestructive = destructive.has(tool) || destructive.has(registered);
    const entry: ToolPermission = {
      tool,
      decision: matched !== undefined ? decisionOf(matched.rule.type) : fallback,
      ...(matched !== undefined ? { rule: matched.rule } : {}),
      conditional: matched?.coverage === "conditional",
      external,
      ...(isDestructive ? { destructive: true } : {}),
    };
    tools.push(entry);

    if (matched === undefined && external) {
      findings.push({
        tool,
        reason: `reaches outside the process (${registered}) and no declared rule names it — it resolves to the mode fallback: ${fallback}`,
      });
    } else if (matched === undefined && isDestructive) {
      findings.push({
        tool,
        reason: `is declared destructive and no rule names it — it resolves to the mode fallback: ${fallback}`,
      });
    } else if (matched?.coverage === "conditional" && (external || isDestructive)) {
      findings.push({
        tool,
        reason: `is covered only by the argument-scoped rule "${matched.rule.pattern}" — calls whose arguments fall outside that glob resolve to the mode fallback: ${fallback}`,
      });
    }
  }

  // A rule naming a tool the spec does not grant cannot fire. Worth saying:
  // it is usually a rename or a tool that was dropped and the guard left.
  const unusedRules = input.rules
    .filter((rule) => !usedRules.has(`${rule.type} ${rule.pattern}`))
    .sort((a, b) => compareStrings(a.pattern, b.pattern) || compareStrings(a.type, b.type));

  if (blanketGate !== undefined) {
    findings.push({
      tool: "<every tool>",
      reason: `the rule "${blanketGate.type} ${blanketGate.pattern}" does not compile, and the engine fails a broken ${blanketGate.type === "alwaysDeny" ? "deny" : "ask"} CLOSED — it gates every call regardless of what it was meant to name`,
    });
  }
  if (modeOverridesRules) {
    findings.push({
      tool: "<every tool>",
      reason:
        'permissions.mode is "plan", under which the engine allows read-only tools and denies the rest without consulting a single rule — the decisions reported here are what WOULD apply in default or auto mode',
    });
  }

  findings.sort((a, b) => compareStrings(a.tool, b.tool) || compareStrings(a.reason, b.reason));
  return {
    mode: input.mode,
    askMode: input.askMode,
    fallback,
    tools,
    unusedRules,
    malformedRules,
    modeOverridesRules,
    findings,
  };
}
