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
 *   3. `readOnly` / `destructive` / `scope` are properties of the TOOL. For a
 *      builtin they come from the builtin manifest the caller passes in
 *      (`flagsOf`), which is generated from the tools themselves. For
 *      anything else — an MCP tool, a custom tool — only what the document
 *      declares (`mcp_servers.*.tool_flags`), what the caller passes in, and
 *      the definitionally outward names (`mcp__*`, `Fetch`, …) are known.
 *      Nothing is guessed from a name beyond that.
 *
 * Pure: no filesystem, no clock, no locale-sensitive comparison.
 */

import { isOutwardName } from "@crewhaus/tool-builder";
import { legacyMcpToolName } from "@crewhaus/tool-catalog";
import {
  type PermissionRuleProblem,
  type RuleToolDescriptor,
  permissionRuleProblems,
} from "@crewhaus/tool-permission-matcher";
import { compareStrings } from "./spec-view";

/**
 * How a builtin is gated, as the manifest describes it (`ToolFlags` in
 * `@crewhaus/tool-registry-manifest`, taken structurally).
 */
export type ToolFlagsLike = {
  readonly name: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly operativeArgs?: ReadonlyArray<{ readonly kind: string }>;
};

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
  /**
   * The tool crosses a process or network boundary: its flags say
   * `scope: "external"` or declare an io capability, or — for a tool the
   * manifest does not describe — its name is definitionally outward.
   */
  readonly external: boolean;
  /** From the tool's flags, the document's `tool_flags` or the caller. */
  readonly destructive?: boolean;
  /** From the tool's flags; absent when they are not known. */
  readonly readOnly?: boolean;
  /** Every call must carry a justification the intent gate accepts. */
  readonly requireJustification?: boolean;
  /** The engine allows it only with a sandbox and an explicit allow rule. */
  readonly requiresSandbox?: boolean;
  /**
   * Where the flags came from: `"builtin"` when the manifest describes the
   * tool, `"name"` when only its name (and anything the document or caller
   * declared) was available.
   */
  readonly flagsFrom: "builtin" | "name";
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
   * True when `mode` overrides part of the rule list: in `plan` the engine
   * ignores every allow rule, reads deny and ask rules (both deny — plan mode
   * cannot ask), and otherwise decides on the tool's own `readOnly` flag. The
   * `decision`s below are computed that way.
   */
  readonly modeOverridesRules: boolean;
  /**
   * Rules that can never do what they say: a spec key where the tool's name
   * belongs, an argument pattern the tool's operative field cannot match, an
   * MCP server the spec does not declare. The same check `crewhaus lint`
   * runs. Such a rule is not counted as covering any tool.
   */
  readonly ruleProblems: readonly PermissionRuleProblem[];
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

/**
 * How well `pattern` covers `toolName`. A malformed pattern covers nothing.
 * An MCP tool (`mcp__<server>__<tool>`) is also covered by a pattern written
 * against its pre-0.7.1 spelling `<server>__<tool>`, as the engine does.
 */
export function patternCoverage(pattern: string, toolName: string): Coverage {
  const split = splitPattern(pattern);
  if (split === undefined) return "none";
  const glob = compileToolGlob(split.toolGlob);
  const legacy = legacyMcpToolName(toolName);
  if (!glob.test(toolName) && (legacy === undefined || !glob.test(legacy))) return "none";
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

/**
 * True when the tool crosses a process or network boundary: its flags say so
 * when they are known, else its name is definitionally outward.
 */
export function isExternalTool(toolKey: string, flags?: ToolFlagsLike): boolean {
  if (flags !== undefined) return flags.scope === "external" || flags.ioCapability !== undefined;
  return isOutwardName(toolKey) || isOutwardName(toRegisteredName(toolKey));
}

/**
 * What the engine decides for a call no rule matched, when the tool's flags
 * are known — the mode's fallback applied to this tool, then the sandbox
 * floor.
 */
export function unmatchedDecision(mode: string, flags: ToolFlagsLike): string {
  if (mode === "plan") return flags.readOnly ? "allow" : "deny";
  const base = mode === "auto" ? (flags.readOnly || !flags.destructive ? "allow" : "ask") : "ask";
  // Section 18 floor: a sandboxed tool is never allowed by a fallback.
  return flags.requiresSandbox ? "deny" : base;
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
  /**
   * The flags of a builtin, looked up by spec key or registered name;
   * `undefined` for anything the manifest does not describe.
   */
  readonly flagsOf?: (tool: string) => ToolFlagsLike | undefined;
  /**
   * Every tool that exists — the builtins and the tools the runtime registers
   * on its own (`Skill`, `Type`, …) — for spotting a rule that names none of
   * them. A tool given without flags is treated as one that may change or
   * delete things.
   */
  readonly knownTools?: readonly RuleToolDescriptor[];
  /** The MCP servers the spec declares. */
  readonly mcpServers?: readonly string[];
  /** The spec's `security.justification.judge`, when it sets one. */
  readonly justificationJudge?: string;
};

/**
 * The report. Rules are consulted in declaration order and the FIRST match
 * wins, which is how the engine scans one source's rule list.
 */
export function auditPermissions(input: AuditPermissionsInput): PermissionAuditResult {
  const destructive = input.destructiveTools ?? new Set<string>();
  const fallback = fallbackDecision(input.mode);
  // `plan` reads only deny and ask rules (both deny) and ignores allows, so
  // the scan below skips allows and reports a matched ask as a deny there.
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
  const flagsOf = input.flagsOf ?? (() => undefined);
  const grantedTools = [...new Set(input.tools)].sort(compareStrings);

  // Rules that can never fire as written cover nothing; the ones whose
  // argument is merely unscoped still match (on the call's text).
  const ruleProblems = permissionRuleProblems({
    rules: input.rules,
    granted: grantedTools.flatMap((tool) => {
      const flags = flagsOf(tool);
      return flags !== undefined
        ? [
            {
              name: flags.name,
              ...(flags.operativeArgs ? { operativeArgs: flags.operativeArgs } : {}),
            },
          ]
        : [{ name: toRegisteredName(tool) }];
    }),
    known: input.knownTools ?? [],
    mcpServers: input.mcpServers ?? [],
  });
  const deadRules = new Set(
    ruleProblems
      .filter((p) => p.code !== "argument-not-scoped")
      .map((p) => `${p.type} ${p.pattern}`),
  );

  for (const tool of grantedTools) {
    const registered = toRegisteredName(tool);
    const flags = flagsOf(tool);
    let matched: { rule: RuleLike; coverage: Coverage } | undefined;
    for (const rule of input.rules) {
      if (modeOverridesRules && rule.type === "alwaysAllow") continue;
      if (deadRules.has(`${rule.type} ${rule.pattern}`)) continue;
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
    const external = isExternalTool(tool, flags);
    const isDestructive =
      destructive.has(tool) || destructive.has(registered) || flags?.destructive === true;
    const ruled = matched === undefined ? undefined : decisionOf(matched.rule.type);
    const decision =
      matched === undefined
        ? flags !== undefined
          ? unmatchedDecision(input.mode, flags)
          : fallback
        : modeOverridesRules
          ? "deny"
          : // The sandbox floor holds even over a matching allow: only an
            // allow can let a sandboxed tool through, and only with a sandbox.
            flags?.requiresSandbox === true && ruled !== "allow"
            ? "deny"
            : (ruled as string);
    const entry: ToolPermission = {
      tool,
      decision,
      ...(matched !== undefined ? { rule: matched.rule } : {}),
      conditional: matched?.coverage === "conditional",
      external,
      ...(isDestructive ? { destructive: true } : {}),
      ...(flags !== undefined
        ? {
            readOnly: flags.readOnly,
            requireJustification: flags.requireJustification,
            requiresSandbox: flags.requiresSandbox,
          }
        : {}),
      flagsFrom: flags !== undefined ? "builtin" : "name",
    };
    tools.push(entry);

    if (flags?.requireJustification === true && decision !== "deny") {
      findings.push({
        tool,
        reason:
          input.justificationJudge === undefined || input.justificationJudge === "rule-based"
            ? "needs a justification on every call, and this spec sets no security.justification.judge: outside tests the default judge denies every such call unless CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1. Set security.justification.judge: claude"
            : `needs a justification on every call, judged by ${input.justificationJudge}`,
      });
    }

    // What an unruled call comes to: this tool's own answer when its flags
    // are known, else the mode's general fallback.
    const unruled =
      flags !== undefined
        ? `${unmatchedDecision(input.mode, flags)} (mode ${input.mode})`
        : fallback;
    if (matched === undefined && external) {
      findings.push({
        tool,
        reason: `reaches outside the process (${registered}) and no declared rule names it — it resolves to the mode fallback: ${unruled}`,
      });
    } else if (matched === undefined && isDestructive) {
      findings.push({
        tool,
        reason: `is destructive and no rule names it — it resolves to the mode fallback: ${unruled}`,
      });
    } else if (matched?.coverage === "conditional" && (external || isDestructive)) {
      findings.push({
        tool,
        reason: `is covered only by the argument-scoped rule "${matched.rule.pattern}" — calls whose arguments fall outside that glob resolve to the mode fallback: ${unruled}`,
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
        'permissions.mode is "plan": the engine ignores every allow rule, denies a call any deny or ask rule matches (plan mode cannot ask), and otherwise allows read-only tools and denies the rest — the decisions reported here are computed that way',
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
    ruleProblems,
    findings,
  };
}
