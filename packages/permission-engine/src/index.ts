/**
 * Catalog R8 `permission-engine` — modes, layered rule sources, decisions.
 *
 * Modes
 *   default — ask on first encounter; rules can pre-decide
 *   plan    — read-only; non-readOnly tools always denied (no rules consulted)
 *   auto    — read-only auto-allow; destructive auto-ask; rules can override
 *   bypass  — allow everything (CLI flag only — see security note)
 *
 * Rule sources (priority high → low)
 *   flag → settings → yaml → hooks → builtin
 * The first matching rule in source-priority order wins. A later source
 * cannot override an earlier source's decision.
 *
 * Rule types: alwaysAllow / alwaysDeny / alwaysAsk
 *
 * SECURITY: `mode: bypass` must NEVER come from a config file. Both
 * `parsePermissionsConfig()` (yaml/settings) and the Zod schema reject it
 * explicitly. Bypass enters the system through the `--permission-mode bypass`
 * CLI flag and nothing else. See the T8 test in src/index.test.ts.
 *
 * References: claude-code/utils/permissions/ (24 files); AI-Harness-Systems
 * §Policy engine.
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  type CompiledPattern,
  compilePattern,
  matchesPattern,
} from "@crewhaus/tool-permission-matcher";
import { z } from "zod";

export type PermissionMode = "default" | "plan" | "auto" | "bypass";
export type RuleType = "alwaysAllow" | "alwaysDeny" | "alwaysAsk";
export type RuleSource = "flag" | "settings" | "yaml" | "hook" | "builtin";

export type PermissionRule = {
  readonly type: RuleType;
  readonly pattern: string;
  readonly source: RuleSource;
};

export type RuleSet = {
  readonly flag: ReadonlyArray<PermissionRule>;
  readonly settings: ReadonlyArray<PermissionRule>;
  readonly yaml: ReadonlyArray<PermissionRule>;
  readonly hooks: ReadonlyArray<PermissionRule>;
  readonly builtin: ReadonlyArray<PermissionRule>;
};

export type ToolCallContext = {
  readonly toolName: string;
  readonly input: unknown;
  readonly readOnly: boolean;
  readonly destructive: boolean;
};

export type Decision = "allow" | "deny" | "ask";

export class PermissionConfigError extends CrewhausError {
  override readonly name = "PermissionConfigError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const SOURCE_PRIORITY: ReadonlyArray<keyof RuleSet> = [
  "flag",
  "settings",
  "yaml",
  "hooks",
  "builtin",
];

export const emptyRuleSet: RuleSet = {
  flag: [],
  settings: [],
  yaml: [],
  hooks: [],
  builtin: [],
};

/**
 * Reasonable starting defaults. The CLI seeds these into the `builtin` source.
 * Intentionally small — just dangerous bash forms get an `alwaysAsk`, and a
 * few obviously-safe read-only tools get `alwaysAllow`. Everything else falls
 * through to mode-specific behavior (default → ask).
 */
export const BUILTIN_DEFAULT_RULES: ReadonlyArray<PermissionRule> = [
  // `**` (vs `*`) matches across path separators — necessary to catch `rm -rf /tmp/foo`.
  { type: "alwaysAsk", pattern: "Bash(rm**)", source: "builtin" },
  { type: "alwaysAsk", pattern: "Bash(sudo**)", source: "builtin" },
  { type: "alwaysAllow", pattern: "Read", source: "builtin" },
  { type: "alwaysAllow", pattern: "Glob", source: "builtin" },
  { type: "alwaysAllow", pattern: "Grep", source: "builtin" },
];

function ruleTypeToDecision(t: RuleType): Decision {
  switch (t) {
    case "alwaysAllow":
      return "allow";
    case "alwaysDeny":
      return "deny";
    case "alwaysAsk":
      return "ask";
  }
}

const compileCache = new WeakMap<PermissionRule, CompiledPattern>();
function compile(rule: PermissionRule): CompiledPattern {
  const cached = compileCache.get(rule);
  if (cached !== undefined) return cached;
  const compiled = compilePattern(rule.pattern);
  compileCache.set(rule, compiled);
  return compiled;
}

/**
 * Decide allow/deny/ask for one tool call. Pure.
 */
export function evaluate(call: ToolCallContext, mode: PermissionMode, rules: RuleSet): Decision {
  if (mode === "bypass") return "allow";
  if (mode === "plan") return call.readOnly ? "allow" : "deny";

  for (const sourceKey of SOURCE_PRIORITY) {
    for (const rule of rules[sourceKey]) {
      try {
        const compiled = compile(rule);
        if (matchesPattern(compiled, call.toolName, call.input)) {
          return ruleTypeToDecision(rule.type);
        }
      } catch {
        // A malformed rule pattern is silently skipped — implicit by
        // catching the exception and continuing the inner-loop iteration.
      }
    }
  }

  // No rule matched: mode-specific fallback.
  if (mode === "auto") {
    if (call.readOnly) return "allow";
    if (call.destructive) return "ask";
    return "allow";
  }
  // mode === "default"
  return "ask";
}

// ---------------------------------------------------------------------------
// Config parsing — security-critical. Bypass is excluded from the parser.
// ---------------------------------------------------------------------------

const ruleSchema = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();

const configSchema = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(), // bypass intentionally absent
    rules: z.array(ruleSchema).optional(),
  })
  .strict();

export type ParsedPermissionsConfig = {
  readonly mode?: Exclude<PermissionMode, "bypass">;
  readonly rules: ReadonlyArray<{ readonly type: RuleType; readonly pattern: string }>;
};

/**
 * Parse a permissions config from a YAML or JSON config file.
 *
 * SECURITY: an explicit string check on `mode === "bypass"` runs *before* Zod
 * so the error message is friendly regardless of the bytestream's structure.
 * Defense in depth: even if that check were missing, the Zod schema doesn't
 * include "bypass" in its enum and would reject it on its own.
 */
export function parsePermissionsConfig(
  raw: unknown,
  source: "yaml" | "settings",
): ParsedPermissionsConfig {
  if (raw === null || raw === undefined) return { rules: [] };

  if (typeof raw === "object" && "mode" in raw) {
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === "bypass") {
      throw new PermissionConfigError(
        `bypass mode cannot be set from ${source}: only the --permission-mode bypass CLI flag is permitted`,
      );
    }
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermissionConfigError(
      `permissions config (${source}) failed validation:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      parsed.error,
    );
  }

  return {
    mode: parsed.data.mode,
    rules: parsed.data.rules ?? [],
  };
}

/**
 * Convenience: tag parsed rules with a source for use in a RuleSet. The CLI
 * uses this after `parsePermissionsConfig`.
 */
export function tagRules(
  rules: ReadonlyArray<{ type: RuleType; pattern: string }>,
  source: RuleSource,
): ReadonlyArray<PermissionRule> {
  return rules.map((r) => ({ type: r.type, pattern: r.pattern, source }));
}
