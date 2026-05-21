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
  /**
   * Section 18 — when true, the tool is gated behind the production
   * safety floor. `evaluate()` refuses to grant `allow` in default mode
   * unless an `alwaysAllow` rule matches AND a non-noop sandbox backend
   * is configured (`sandboxAvailable: true`).
   */
  readonly requiresSandbox?: boolean;
};

export type Decision = "allow" | "deny" | "ask";

/**
 * Section 18 — extra signals the runtime threads through. `sandboxAvailable`
 * is true when a non-noop sandbox backend is wired; without it, any
 * `requiresSandbox: true` tool is denied even if a rule would have allowed
 * it. This keeps the noop backend strictly test-scope.
 */
export type EvaluateOptions = {
  readonly sandboxAvailable?: boolean;
};

/**
 * Decision details. `evaluate()` returns just the Decision (back-compat);
 * `evaluateWithReason()` exposes the structured form so runtime-core can
 * publish `permission_decision { reason }` events.
 */
export type DecisionDetails = {
  readonly decision: Decision;
  readonly reason?: string;
};

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
export function evaluate(
  call: ToolCallContext,
  mode: PermissionMode,
  rules: RuleSet,
  opts: EvaluateOptions = {},
): Decision {
  return evaluateWithReason(call, mode, rules, opts).decision;
}

/**
 * Section 18 — full structured form. Returns `decision` plus an optional
 * `reason` (always populated on a `requiresSandbox` denial). Pure.
 */
export function evaluateWithReason(
  call: ToolCallContext,
  mode: PermissionMode,
  rules: RuleSet,
  opts: EvaluateOptions = {},
): DecisionDetails {
  if (mode === "bypass") return { decision: "allow" };
  if (mode === "plan") return { decision: call.readOnly ? "allow" : "deny" };

  // Section 18 production safety floor: a tool that declared
  // `requiresSandbox` cannot be allowed unless (a) a rule explicitly
  // matched AND (b) a non-noop sandbox is available. We compute the
  // base decision first so ruleHit is already known.
  let baseDecision: Decision | undefined;
  for (const sourceKey of SOURCE_PRIORITY) {
    for (const rule of rules[sourceKey]) {
      try {
        const compiled = compile(rule);
        if (matchesPattern(compiled, call.toolName, call.input)) {
          baseDecision = ruleTypeToDecision(rule.type);
          break;
        }
      } catch {
        // A malformed rule pattern is silently skipped — implicit by
        // catching the exception and continuing the inner-loop iteration.
      }
    }
    if (baseDecision !== undefined) break;
  }

  if (baseDecision === undefined) {
    // No rule matched: mode-specific fallback.
    if (mode === "auto") {
      if (call.readOnly) baseDecision = "allow";
      else if (call.destructive) baseDecision = "ask";
      else baseDecision = "allow";
    } else {
      // mode === "default"
      baseDecision = "ask";
    }
  }

  if (call.requiresSandbox === true) {
    if (opts.sandboxAvailable !== true) {
      return {
        decision: "deny",
        reason: `tool "${call.toolName}" requires a sandbox but none is configured (CREWHAUS_SANDBOX must be set to docker or podman)`,
      };
    }
    if (baseDecision !== "allow") {
      return {
        decision: "deny",
        reason: `tool "${call.toolName}" requires an explicit alwaysAllow rule (sandbox-floor — default mode does not auto-grant requiresSandbox tools)`,
      };
    }
  }
  return { decision: baseDecision };
}

/**
 * Pillar 3 intent gate — verdict from a justification judge.
 */
export type JustificationVerdict = {
  /** True if the justification is consistent with the session's stated goal. */
  readonly allow: boolean;
  /** Short human-readable rationale. Always present; lands in audit-log. */
  readonly reason: string;
  /** Confidence in [0, 1] when the judge supplies it; undefined for binary judges. */
  readonly confidence?: number;
  /** Judge model identifier — `"rule-based"` for the default, otherwise the
   *  LLM model name supplied by the runtime. */
  readonly judgeModel: string;
};

/**
 * Pillar 3 intent gate — interface a judge function implements. Sync OR
 * async; runtime-core awaits the return. Implementations:
 *   - `ruleBasedJustificationJudge` (default; deterministic for tests)
 *   - LLM-backed judge supplied by runtime-core when the spec opts in
 *
 * The session-goal string is the agent's declared task (typically the user
 * message that started the run, or a planner-emitted summary). The judge
 * compares the justification to the goal; deciding factors are
 * implementation-specific.
 */
export type JustificationJudge = (input: {
  readonly toolName: string;
  readonly justification: string;
  readonly sessionGoal: string;
  readonly input: unknown;
}) => Promise<JustificationVerdict> | JustificationVerdict;

/**
 * Default rule-based judge. Deterministic, no LLM call, suitable for tests
 * and for low-stakes deployments where rough intent checking is enough.
 *
 * Heuristics (intentionally simple — production should override with an
 * LLM-backed judge):
 *   - Justification length < 16 chars → deny ("too brief to be meaningful")
 *   - Goal not provided → allow with low confidence (no signal to check
 *     against; the audit trail still captures the justification verbatim)
 *   - Otherwise: token overlap. The justification's lowercase token set
 *     must share ≥ 1 non-stopword token with the session goal's set.
 *     Tightens too easily under polysemy; an LLM judge replaces this
 *     entirely when wired.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "for",
  "on",
  "at",
  "by",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "i",
  "you",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "my",
  "your",
  "our",
  "their",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "would",
  "should",
  "could",
  "may",
  "might",
  "can",
  "will",
  "shall",
  "must",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

export const ruleBasedJustificationJudge: JustificationJudge = (input) => {
  if (input.justification.length < 16) {
    return {
      allow: false,
      reason: `justification too brief (${input.justification.length} chars); supply at least 16 characters of explanation`,
      confidence: 1.0,
      judgeModel: "rule-based",
    };
  }
  if (input.sessionGoal.length === 0) {
    return {
      allow: true,
      reason: "no session goal supplied to compare against; justification captured verbatim",
      confidence: 0.0,
      judgeModel: "rule-based",
    };
  }
  const justTokens = tokenize(input.justification);
  const goalTokens = tokenize(input.sessionGoal);
  let overlap = 0;
  for (const t of justTokens) if (goalTokens.has(t)) overlap += 1;
  if (overlap === 0) {
    return {
      allow: false,
      reason: `justification shares no salient tokens with session goal (justification: ${justTokens.size} tokens, goal: ${goalTokens.size} tokens, overlap: 0)`,
      confidence: 0.7,
      judgeModel: "rule-based",
    };
  }
  return {
    allow: true,
    reason: `${overlap} token(s) overlap between justification and session goal`,
    confidence: Math.min(1, overlap / 3),
    judgeModel: "rule-based",
  };
};

/**
 * Evaluate a justification under the supplied judge. Convenience wrapper
 * so runtime-core does not have to handle the sync-or-async ambiguity.
 */
export async function evaluateJustification(
  input: {
    readonly toolName: string;
    readonly justification: string;
    readonly sessionGoal: string;
    readonly input: unknown;
  },
  judge: JustificationJudge = ruleBasedJustificationJudge,
): Promise<JustificationVerdict> {
  return await Promise.resolve(judge(input));
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
