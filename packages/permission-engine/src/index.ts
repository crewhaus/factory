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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * #383 — the runtime's own bookkeeping toolset: the `Skill` loader plus the
 * non-destructive continuity tools (`@crewhaus/tool-plan`'s focus/plan/goal
 * family). Continuity is default-on, and the agent loop calls these
 * autonomously on every fresh session — with varying input, so on a headless
 * surface (`ask_mode: pause`) an unruled loop parks on its OWN bookkeeping
 * and a one-shot `(toolName, inputHash)` grant can never satisfy the next
 * call. These are local-only reads/writes to the harness's continuity store
 * (no network, no process boundary), so they get a builtin `alwaysAllow` —
 * the same reasoning that already allows `Read`/`Glob`/`Grep`. `MemoryClear`
 * is deliberately EXCLUDED: it erases continuity state, so it keeps the
 * mode-default behavior unless a spec rule allows it. A spec can still
 * override any of these (the `yaml` source outranks `builtin`).
 */
export const BUILTIN_BOOKKEEPING_RULES: ReadonlyArray<PermissionRule> = [
  { type: "alwaysAllow", pattern: "Skill", source: "builtin" },
  { type: "alwaysAllow", pattern: "FocusRead", source: "builtin" },
  { type: "alwaysAllow", pattern: "FocusWrite", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanRead", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanUpdate", source: "builtin" },
  { type: "alwaysAllow", pattern: "PlanComplete", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalWrite", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalUpdate", source: "builtin" },
  { type: "alwaysAllow", pattern: "GoalList", source: "builtin" },
];

/**
 * Reasonable starting defaults. The CLI seeds these into the `builtin` source.
 * Intentionally small — just dangerous bash forms get an `alwaysAsk`, a
 * few obviously-safe read-only tools get `alwaysAllow`, and the runtime's own
 * bookkeeping toolset rides along via {@link BUILTIN_BOOKKEEPING_RULES}.
 * Everything else falls through to mode-specific behavior (default → ask).
 */
export const BUILTIN_DEFAULT_RULES: ReadonlyArray<PermissionRule> = [
  // `**` (vs `*`) matches across path separators — necessary to catch `rm -rf /tmp/foo`.
  { type: "alwaysAsk", pattern: "Bash(rm**)", source: "builtin" },
  { type: "alwaysAsk", pattern: "Bash(sudo**)", source: "builtin" },
  { type: "alwaysAllow", pattern: "Read", source: "builtin" },
  { type: "alwaysAllow", pattern: "Glob", source: "builtin" },
  { type: "alwaysAllow", pattern: "Grep", source: "builtin" },
  ...BUILTIN_BOOKKEEPING_RULES,
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
        // A malformed rule pattern fails CLOSED for safety rules: an
        // uncompilable `alwaysDeny`/`alwaysAsk` still gates (treated as a
        // match for its own decision), so an attacker-influenced broken guard
        // — e.g. a deny pattern in an untrusted sub-agent definition — can't
        // be silently dropped to fail open. A malformed `alwaysAllow` is still
        // skipped: a broken grant simply isn't honored (no widening).
        if (rule.type === "alwaysDeny" || rule.type === "alwaysAsk") {
          baseDecision = ruleTypeToDecision(rule.type);
          break;
        }
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
 * Model id reported by `ruleBasedJustificationJudge`. The verdict that the
 * default judge emits is tagged with this so the evaluation site can tell a
 * rule-based verdict apart from an LLM-backed one after the fact.
 */
export const RULE_BASED_JUDGE_MODEL = "rule-based";

/**
 * One-time guard so the rule-based-judge weakness warning fires at most once
 * per process. Module-level (mirrors `adapter-anthropic`'s
 * `warnedAboutCliFallback`) so repeated tool calls in a long run don't spam.
 */
let warnedAboutRuleBasedJudge = false;

/**
 * Test-only: reset the one-time warning guard. The warning latches for the
 * lifetime of the process, which is correct in production but makes
 * order-independent assertions in the test suite impossible. Not part of the
 * supported runtime surface — callers other than tests should never need it.
 */
export function __resetRuleBasedJudgeWarningForTests(): void {
  warnedAboutRuleBasedJudge = false;
}

/**
 * CWE-807 (#161) — the rule-based judge scores a justification by token
 * overlap against the spec instructions. That text is attacker-influenceable:
 * the SAME (possibly prompt-injected) model that picked the tool also writes
 * the justification, so it can trivially echo a salient goal token and pass.
 * In the default crewhaus run config this judge therefore provides no real
 * protection. We can't safely re-wire the default judge from here (that's a
 * cross-package decision), so instead we make the weakness LOUD: a prominent
 * one-time runtime warning at the evaluation site whenever a rule-based
 * verdict gates a real (non-test) run. An LLM-backed judge reports a different
 * `judgeModel` and does not trip this.
 */
function warnRuleBasedJudgeOnce(toolName: string): void {
  if (warnedAboutRuleBasedJudge) return;
  // `bun test`/`NODE_ENV=test` exercises the rule-based judge constantly; only
  // surface the warning for real runs so test output stays clean.
  if (process.env.NODE_ENV === "test") return;
  warnedAboutRuleBasedJudge = true;
  console.warn(
    `[permission-engine] SECURITY: the rule-based justification judge is gating a justification-required tool (first seen: \`${toolName}\`). It only checks token overlap between the justification and the spec instructions, so the SAME (potentially prompt-injected) model that chose the tool can also write a passing justification — this offers NO protection against an injected justification. Production MUST set \`security.justification.judge: claude\` in the spec (or pass an LLM-backed \`justificationJudge\` to the runtime). This warning fires once per process.`,
  );
}

/**
 * Evaluate a justification under the supplied judge. Convenience wrapper
 * so runtime-core does not have to handle the sync-or-async ambiguity.
 *
 * Side effect (#161): when the resolved verdict came from the rule-based judge
 * and this is a real (non-test) run, emit a prominent one-time warning that the
 * rule-based judge is no defence against a justification written by the same
 * model. See `warnRuleBasedJudgeOnce`.
 */
/**
 * Whether a rule-based `allow` verdict should be overridden to deny. The
 * rule-based judge scores a justification by token overlap with the goal, but
 * the SAME (prompt-injectable) model that picked the tool also writes the
 * justification, so an `allow` from it is no real authorization. We therefore
 * fail CLOSED in production: a justification-required tool is denied unless an
 * LLM-backed judge is configured (it reports a different judgeModel and is
 * never overridden). Two escape hatches keep this from being a hard break:
 *   - `NODE_ENV=test` (Bun sets it for `bun test`) keeps the judge deterministic
 *     for the test suite;
 *   - `CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1` lets an operator explicitly
 *     accept the rule-based judge's weakness in production.
 */
function ruleBasedShouldFailClosed(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env["CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION"] === "1") return false;
  return true;
}

export async function evaluateJustification(
  input: {
    readonly toolName: string;
    readonly justification: string;
    readonly sessionGoal: string;
    readonly input: unknown;
  },
  judge: JustificationJudge = ruleBasedJustificationJudge,
): Promise<JustificationVerdict> {
  const verdict = await Promise.resolve(judge(input));
  if (verdict.judgeModel === RULE_BASED_JUDGE_MODEL) {
    warnRuleBasedJudgeOnce(input.toolName);
    if (verdict.allow && ruleBasedShouldFailClosed()) {
      return {
        allow: false,
        reason:
          "justification denied (fail-closed): the default rule-based judge is gameable by the same model that wrote the justification, so its `allow` is not trustworthy. Configure security.justification.judge: claude (an LLM-backed judge), or set CREWHAUS_ALLOW_RULE_BASED_JUSTIFICATION=1 to explicitly accept the rule-based judge.",
        judgeModel: RULE_BASED_JUDGE_MODEL,
      };
    }
  }
  return verdict;
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

// ---------------------------------------------------------------------------
// #383 — the `settings`-source file. `<harnessDir>/.crewhaus/settings.json`'s
// `permissions` sub-object is the operator-owned rule layer that outranks the
// spec's `yaml` rules without touching the spec: the CLI has always read it
// for `crewhaus run`/`serve`, runtime-core now loads it for every surface
// (so compiled daemons honor it too), and the approval surfaces persist
// standing allows into it (`crewhaus approvals grant --always`, the Slack
// "Always allow" button).
// ---------------------------------------------------------------------------

/** The settings file's path relative to a harness root. */
export const SETTINGS_RELATIVE_PATH = join(".crewhaus", "settings.json");

/** Absolute settings path for a harness root. */
export function settingsFilePath(dir: string): string {
  return join(dir, SETTINGS_RELATIVE_PATH);
}

/**
 * Parse the top-level JSON of a settings file, keeping the whole root so
 * unrelated keys (`hooks`, …) survive a write-back. Throws
 * {@link PermissionConfigError} on malformed JSON or a non-object root —
 * fail closed: a file that cannot be read must not silently drop an
 * operator's `alwaysDeny`, and a write-back must never clobber a file it
 * could not understand.
 */
function readSettingsRoot(path: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PermissionConfigError(`cannot read settings file ${path}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PermissionConfigError(`settings file ${path} is not valid JSON`, err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PermissionConfigError(`settings file ${path} must hold a JSON object at the root`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load the `settings`-source permission rules from
 * `<dir>/.crewhaus/settings.json`. Missing file → `[]`. Only the
 * `permissions` sub-object is consulted (so `hooks` and other settings keys
 * never trip the strict validator); its shape is the same
 * `{ mode?, rules? }` the spec's `permissions:` block uses, and
 * `mode: bypass` is rejected here exactly as it is for yaml. Malformed JSON
 * or an invalid permissions config THROWS {@link PermissionConfigError} —
 * fail closed, matching the CLI's behavior when it reads the same file.
 */
export function loadSettingsRules(dir: string): ReadonlyArray<PermissionRule> {
  const root = readSettingsRoot(settingsFilePath(dir));
  if (root === undefined) return [];
  const parsed = parsePermissionsConfig(root["permissions"], "settings");
  return tagRules(parsed.rules, "settings");
}

/**
 * Append one permission rule to `<dir>/.crewhaus/settings.json`'s
 * `permissions.rules`, creating the file (and `.crewhaus/`) when absent and
 * preserving every unrelated key on write-back. Deduped on
 * `(type, pattern)` — re-appending an existing rule is a no-op. The write is
 * atomic (tmp + rename) so a concurrently-booting run never reads a torn
 * file. This is the persistence half of a standing allow: the approval
 * surfaces call it with `{ type: "alwaysAllow", pattern: <toolName> }` when
 * an operator grants an approval with `--always`.
 *
 * Throws {@link PermissionConfigError} when the existing file is malformed —
 * never overwrite a file we could not parse.
 */
export function appendSettingsRule(
  dir: string,
  rule: { readonly type: RuleType; readonly pattern: string },
): { readonly added: boolean; readonly path: string } {
  const path = settingsFilePath(dir);
  const root = readSettingsRoot(path) ?? {};
  // Validate what is already there before writing next to it.
  const existing = parsePermissionsConfig(root["permissions"], "settings");
  if (existing.rules.some((r) => r.type === rule.type && r.pattern === rule.pattern)) {
    return { added: false, path };
  }
  const permissionsRoot =
    typeof root["permissions"] === "object" && root["permissions"] !== null
      ? (root["permissions"] as Record<string, unknown>)
      : {};
  const next = {
    ...root,
    permissions: {
      ...permissionsRoot,
      rules: [
        ...existing.rules.map((r) => ({ type: r.type, pattern: r.pattern })),
        { type: rule.type, pattern: rule.pattern },
      ],
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmpPath, path);
  return { added: true, path };
}
