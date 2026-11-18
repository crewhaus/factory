/**
 * Permission rules that can never do what they say, found over a parsed spec
 * and its lowered IR: a spec key where the tool's name belongs, a near-miss
 * tool name, an MCP server the spec does not declare, an argument pattern
 * that cannot match the field the tool declares, a deny or ask below an allow
 * that always matches first.
 *
 * One home for every build that reports them: `crewhaus lint`, `crewhaus
 * compile` (local and `--emit-as cf-worker`) and the compiler-worker's
 * `POST /compile` with `emitAs: "cf-worker"` all read these findings, so the
 * hosted edge compile says what the CLI's edge compile says.
 *
 * The module imports only types, `@crewhaus/tool-permission-matcher` and the
 * builtin manifest's flags: it runs inside a Cloudflare Worker, so it reads
 * no file and loads no tool package. A caller that holds live tools passes a
 * {@link RuleToolResolver}; without one, the builtin manifest describes each
 * tool.
 */
import type { IrNode } from "@crewhaus/ir";
import {
  type PermissionRuleProblem,
  type RuleToolDescriptor,
  permissionRuleProblems,
  shadowedPermissionRules,
  specPermissionRuleLists,
} from "@crewhaus/tool-permission-matcher";
import {
  NON_CLI_TOOL_FLAGS,
  RUNTIME_TOOL_NAMES,
  THREDZ_TOOL_NAMES,
  TOOL_FLAGS,
  TOOL_FLAGS_BY_NAME,
} from "@crewhaus/tool-registry-manifest/flags";

/**
 * Every tool a rule can name, as the rule checker needs them: the builtins,
 * with their flags, and the tools the runtime registers without a spec
 * listing them (`Skill`, `ListTools`, the browser shape's `Type`, …), by name.
 * With the second half a real tool name such as `Skill` is read as the tool
 * it is, never as a typo of a builtin.
 */
export const KNOWN_TOOLS: ReadonlyArray<RuleToolDescriptor> = [
  ...Object.values(TOOL_FLAGS),
  ...Object.values(NON_CLI_TOOL_FLAGS),
  ...RUNTIME_TOOL_NAMES.map((name) => ({ name })),
];

/**
 * The tools a spec's `thredz:` block registers under their bare names
 * (`goal_list`, `task_complete`, …; the messaging set too when a block says
 * `messaging: true`), or none when the spec has no block. A crew carries a
 * block per role as well as the crew-wide one.
 */
export function thredzToolNamesOf(ir: IrNode): string[] {
  const blocks: Array<{ readonly messaging?: unknown }> = [];
  const top = (ir as { readonly thredz?: { readonly messaging?: unknown } }).thredz;
  if (top !== undefined) blocks.push(top);
  const roles = (ir as { readonly roles?: unknown }).roles;
  if (Array.isArray(roles)) {
    for (const role of roles) {
      const block = (role as { readonly thredz?: { readonly messaging?: unknown } } | null)?.thredz;
      if (block !== undefined) blocks.push(block);
    }
  }
  if (blocks.length === 0) return [];
  return [
    ...THREDZ_TOOL_NAMES.memory,
    ...(blocks.some((b) => b.messaging === true) ? THREDZ_TOOL_NAMES.messaging : []),
  ];
}

/**
 * The manifest's flags for a builtin no cli bundle carries, by spec key or by
 * registered name (a sub-agent list uses the name) — for describing a rule's
 * tool, not for vouching for a sink's scope.
 */
export function nonCliBuiltinFlags(name: string): (typeof NON_CLI_TOOL_FLAGS)[string] | undefined {
  if (Object.hasOwn(NON_CLI_TOOL_FLAGS, name)) return NON_CLI_TOOL_FLAGS[name];
  return Object.values(NON_CLI_TOOL_FLAGS).find((flags) => flags.name === name);
}

/**
 * Every tool NAME referenced anywhere in a lowered IR, as the spec spells it,
 * variant-agnostically: every string under a `tools` key of the serialized
 * IR, wherever a variant nests it (top level, steps, nodes, stages,
 * sub-agents). Deterministic and dedup'd.
 */
export function collectIrToolNames(ir: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "tools" && Array.isArray(value)) {
          for (const v of value) if (typeof v === "string") names.add(v);
        }
        visit(value);
      }
    }
  };
  visit(ir);
  return [...names];
}

/**
 * Describes a tool the spec lists, by its spec key or its registered name:
 * the live tool when the caller holds one. `undefined` hands the tool to the
 * builtin manifest. Structural, so a CLI tool map's `RegisteredTool` serves
 * as it is.
 */
export type RuleToolResolver = (name: string) =>
  | {
      readonly name: string;
      readonly operativeArgs?: RuleToolDescriptor["operativeArgs"];
    }
  | undefined;

/** A rule that can never do what it says, and where the spec holds it. */
export type LocatedRuleProblem = PermissionRuleProblem & {
  /** The list that holds the rule, e.g. `models.fast.permissions.deny`. */
  readonly list: string;
  /** `<list>[<type> <pattern>]`, e.g. `models.fast.permissions.deny[alwaysDeny fetch]`. */
  readonly path: string;
};

/** Which build the permission-rule findings are for. */
export type PermissionRuleCheckOptions = {
  /**
   * A Cloudflare Worker's (`compile --emit-as cf-worker`). A worker reads the
   * deny and ask rules of `permissions.rules` before its allow rules, so one
   * listed below an allow decides every call it matches there, and the
   * findings about that list's first-match order are not said. The edge
   * notice `edge-tool-needs-allow` says when such a rule refuses every call
   * to a wired tool.
   */
  readonly edge?: boolean;
};

/**
 * The permission rules of a spec that can never do what they say (see
 * `permissionRuleProblems`, and `shadowedPermissionRules` for a deny or ask
 * an allow above it always beats), in every list the spec carries (see
 * `specPermissionRuleLists`: the shape's rules, each model profile's and
 * pool candidate's deny/ask, each sub-agent's allow/deny). A granted tool is
 * one the lowered spec lists, described by the tool `resolveTool` returns,
 * else by the builtin manifest, so the check sees the same declarations the
 * runtime will; the tools a `thredz:` block registers are known in a spec
 * that has one. For a worker's build (`opts.edge`), the shape's rules are
 * read in the worker's order.
 */
export function permissionRuleProblemsOf(
  spec: unknown,
  ir: IrNode,
  resolveTool?: RuleToolResolver,
  opts: PermissionRuleCheckOptions = {},
): LocatedRuleProblem[] {
  const lists = specPermissionRuleLists(spec);
  if (lists.length === 0) return [];
  const node = ir as { readonly mcp_servers?: Readonly<Record<string, unknown>> };
  const granted: RuleToolDescriptor[] = [];
  for (const name of collectIrToolNames(ir)) {
    const live = resolveTool?.(name);
    const described =
      live ?? TOOL_FLAGS[name] ?? TOOL_FLAGS_BY_NAME.get(name) ?? nonCliBuiltinFlags(name);
    if (described === undefined) continue;
    granted.push({
      name: described.name,
      key: name,
      ...(described.operativeArgs !== undefined ? { operativeArgs: described.operativeArgs } : {}),
    });
  }
  const thredz = thredzToolNamesOf(ir);
  const known =
    thredz.length === 0 ? KNOWN_TOOLS : [...KNOWN_TOOLS, ...thredz.map((name) => ({ name }))];
  const mcpServers = Object.keys(node.mcp_servers ?? {});
  const out: LocatedRuleProblem[] = [];
  for (const list of lists) {
    for (const p of permissionRuleProblems({ rules: list.rules, granted, known, mcpServers })) {
      out.push({ ...p, list: list.path, path: `${list.path}[${p.type} ${p.pattern}]` });
    }
  }
  // A deny or ask that an allow above it in the same layer always beats —
  // except in a plan-mode spec, which reads no allow, where it is a note. A
  // worker reads the shape's deny and ask rules first, so on its build that
  // list's order decides nothing.
  const permissions = (spec as { readonly permissions?: { readonly mode?: unknown } } | null)
    ?.permissions;
  const mode = typeof permissions?.mode === "string" ? permissions.mode : undefined;
  for (const p of shadowedPermissionRules(lists, mode !== undefined ? { mode } : {})) {
    if (opts.edge === true && p.list === "permissions.rules") continue;
    const { shadowedBy: _allow, ...problem } = p;
    out.push({ ...problem, path: `${p.list}[${p.type} ${p.pattern}]` });
  }
  return out;
}

/**
 * Rule findings that inform without saying the rule is dead, so `--strict`
 * never escalates them: a `builtin-not-reached` note is about a rule that
 * still fires (on a declared MCP server's tools), a `tool-not-known` one about
 * a name a plugin or custom tool may still supply, and a
 * `shadowed-outside-plan` one about a rule a plan-mode spec still fires.
 */
export const PERMISSION_RULE_NOTES: ReadonlySet<string> = new Set([
  "builtin-not-reached",
  "tool-not-known",
  "shadowed-outside-plan",
]);

/**
 * A permission-rule finding as a compile warning. Its three fields are
 * `CompileWarning`'s, so it is one.
 */
export type PermissionRuleFinding = {
  /** `permission-rule`, or `permission-rule-note` for a note `--strict` does not escalate. */
  readonly code: "permission-rule" | "permission-rule-note";
  /** The rule list that holds the rule, e.g. `permissions.rules`. */
  readonly path: string;
  readonly message: string;
};

/**
 * {@link permissionRuleProblemsOf} as compile warnings, in the same order:
 * code `permission-rule`, or `permission-rule-note` for a
 * {@link PERMISSION_RULE_NOTES} finding, at the list that holds the rule.
 */
export function permissionRuleFindings(
  spec: unknown,
  ir: IrNode,
  resolveTool?: RuleToolResolver,
  opts: PermissionRuleCheckOptions = {},
): PermissionRuleFinding[] {
  return permissionRuleProblemsOf(spec, ir, resolveTool, opts).map((p) => ({
    code: PERMISSION_RULE_NOTES.has(p.code) ? "permission-rule-note" : "permission-rule",
    path: p.list,
    message: p.message,
  }));
}
