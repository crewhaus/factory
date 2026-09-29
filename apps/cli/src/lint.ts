import { type IrNode, checkShapeTools, lower } from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_PIPELINE, type IrPass } from "@crewhaus/ir-passes";
import { type Spec, SpecParseError, mcpServerNameWarnings, parseSpec } from "@crewhaus/spec";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type PermissionRuleProblem,
  type RuleToolDescriptor,
  permissionRuleProblems,
} from "@crewhaus/tool-permission-matcher";
import {
  RUNTIME_TOOL_NAMES,
  THREDZ_TOOL_NAMES,
  TOOL_FLAGS,
  TOOL_FLAGS_BY_NAME,
} from "@crewhaus/tool-registry-manifest/flags";
import { auditModelPlan } from "./model-plan-lint";
import { auditSpecToolNames, collectToolNames } from "./scope-audit";

/**
 * Item 41 — `crewhaus lint`. A check-only command: `parseSpec` +
 * `compile({ applyIrPasses: true })` (the §47 chain / graph-crew
 * well-formedness passes) + `auditToolScopes`, WITHOUT emitting a bundle.
 *
 * WHY THIS EXISTS: the CLI compile path never applied the ir-passes today, so
 * §47 referential-integrity and graph/crew well-formedness checks silently
 * skipped for CLI users — a spec with a dangling `wallets[].chainId` or an
 * unreachable graph node compiled clean. `lint` runs those passes (discarding
 * the result) so authoring bugs surface without a build.
 *
 * COLLECT-ALL vs FAIL-FAST: the IR passes throw on the FIRST violation. For
 * `--format text` that fail-fast is fine (one error, fix, re-run). For
 * `--format json` (editors/CI) we want as many findings as possible, so we run
 * each pass INDEPENDENTLY and catch-and-continue — collecting at most one
 * finding per pass. That is the honest limit of an exception-based pass API
 * (a single pass still stops at its own first violation); it is documented
 * here and surfaced as `severity: "error"` findings with a stable `path`.
 *
 * Side-effect-free: `runLint` is a pure function over the spec text plus an
 * injected tool resolver (so tests don't import the heavy tool packages). The
 * CLI wrapper owns file IO and process exit.
 */

export type LintSeverity = "error" | "warning";

/** One structured finding. `path` is a dot-joined spec/IR location (or a
 *  synthetic id for whole-spec failures); shaped for editor/CI consumption. */
export type LintFinding = {
  readonly message: string;
  readonly path: string;
  readonly severity: LintSeverity;
  /** Stable rule id (parse | ir-pass:<name> | scope | …) for grouping. */
  readonly rule: string;
};

export type LintResult = {
  readonly ok: boolean;
  readonly findings: readonly LintFinding[];
  /** The parsed spec when parse succeeded (so --fix can operate on it). */
  readonly spec?: Spec;
  /** The lowered IR when lowering succeeded. */
  readonly ir?: IrNode;
};

/**
 * Run the lint pipeline. `resolveTool` maps a tool NAME (either the camelCase
 * spec key or its registered PascalCase name) to a `RegisteredTool`, or
 * undefined — injected so this stays pure. `passes` defaults to the published
 * `DEFAULT_PIPELINE` and is overridable for tests.
 */
export function runLint(
  yamlText: string,
  resolveTool: (name: string) => RegisteredTool | undefined,
  passes: ReadonlyArray<IrPass> = DEFAULT_PIPELINE,
): LintResult {
  const findings: LintFinding[] = [];

  // Stage 1 — parse. A parse failure is terminal: without a spec there is
  // nothing to lower or audit.
  let spec: Spec;
  try {
    spec = parseSpec(yamlText);
  } catch (err) {
    const message = err instanceof SpecParseError ? err.message : (err as Error).message;
    findings.push({ message, path: "<spec>", severity: "error", rule: "parse" });
    return { ok: false, findings };
  }

  // Stage 2 — lower. lower() can throw CompilerError (e.g. a malformed
  // credential env-ref); treat as terminal for the IR-pass stage.
  let ir: IrNode;
  try {
    ir = lower(spec);
  } catch (err) {
    const message = err instanceof CrewhausError ? err.message : (err as Error).message;
    findings.push({ message, path: "<lower>", severity: "error", rule: "lower" });
    return { ok: false, findings, spec };
  }

  // Stage 3 — IR passes, COLLECT-ALL. Run each pass independently so one pass's
  // violation doesn't hide the others'. Validating passes
  // (transactionPolicyEnforcement, wellFormednessCheck) throw IrPassError; the
  // rewriting passes are pure and never throw. We discard rewritten IR (lint
  // never emits) — only the thrown violations matter.
  for (const pass of passes) {
    try {
      pass(ir);
    } catch (err) {
      const message = err instanceof CrewhausError ? err.message : (err as Error).message;
      findings.push({
        message,
        path: `ir-pass:${pass.name || "anonymous"}`,
        severity: "error",
        rule: `ir-pass:${pass.name || "anonymous"}`,
      });
    }
  }

  // Stage 3b — the compiler's own per-shape tool check (shape-reach#6): a
  // name that is not a builtin, or a builtin this spec's shape cannot run,
  // is an error worded exactly as `crewhaus compile` words it; a builtin that
  // compiles but can never succeed, or a sub-agent tool its parent never
  // registers, is a warning. Before this, lint said "clean" for tool lists
  // compile rejected.
  const shapeTools = checkShapeTools(ir);
  for (const e of shapeTools.errors) {
    findings.push({ message: e.message, path: e.path, severity: "error", rule: "tool" });
  }
  for (const w of shapeTools.warnings) {
    findings.push({ message: w.message, path: w.path, severity: "warning", rule: w.code });
  }

  // Stage 4 — tool-scope audit over the IR's tool names, sharing the exact
  // gate `compile --strict` uses. A resolvable built-in is audited by
  // capability/scope; an outward-by-name sink that resolves to no external
  // tool is a finding.
  const toolNames = collectToolNames(ir);
  const scopeFindings = auditSpecToolNames(toolNames, resolveTool);
  for (const f of scopeFindings) {
    findings.push({
      message: `tool "${f.toolName}" ${f.reason}`,
      path: `tools.${f.toolName}`,
      severity: "error",
      rule: "scope",
    });
  }

  // Stage 5 — v0.3.0 Goal 3 (design §4.1): a user-declared
  // `mcp_servers.thredz` next to a `thredz:` block WINS over the compiler's
  // synthesis (explicit beats implicit). That is deliberate — the vendored
  // -server escape hatch — but worth a warning so nobody wonders why their
  // `base_url`/`visibility` knobs stopped applying.
  const specThredz = (spec as { thredz?: unknown }).thredz;
  const specMcp = (spec as { mcp_servers?: Record<string, unknown> }).mcp_servers;
  if (specThredz !== undefined && specThredz !== false && specMcp?.["thredz"] !== undefined) {
    findings.push({
      message:
        "mcp_servers.thredz is user-declared, so the thredz: block does not synthesize a server — your explicit entry wins (explicit beats implicit). The thredz: knobs still drive the wiring (aliases, goal mirror), but api_key/base_url/visibility only apply through YOUR server's env; it must speak the thredz-mcp v0.2.0 tool contract.",
      path: "mcp_servers.thredz",
      severity: "warning",
      rule: "thredz-override",
    });
  }

  // Stage 5b — 0.7.1: an mcp_servers key with `__` in it, or `_` at either
  // end, makes `mcp__<server>__<tool>` ambiguous. 0.7.0 ran such keys, so the
  // spec still parses; `compile` prints the same warning.
  for (const w of mcpServerNameWarnings(spec)) {
    findings.push({
      message: w.message,
      path: w.path,
      severity: "warning",
      rule: "mcp-server-name",
    });
  }

  // Stage 6 — 0.6.0 (design §10.1): the model-plan checks shared with
  // `doctor --philosophy-alignment` — judge independence on pooled / strategy
  // blocks (warning), profile tools ⊆ the shape's resolved toolset (warning),
  // roster references that name no roster member (error, a drift guard behind
  // the spec cross-field checks and the modelPlanIntegrity ir-pass).
  for (const f of auditModelPlan(ir)) {
    findings.push({ message: f.message, path: f.path, severity: f.severity, rule: f.rule });
  }

  // Stage 7 — 0.7.1 (permission-integration#12): permission rules that can
  // never do what they say — a spec key where the tool's name belongs, a
  // near-miss tool name, an MCP server the spec does not declare, an
  // argument pattern that cannot match the field the tool declares. Shared
  // with `compile` (which fails on them under --strict) and PermissionAudit.
  for (const p of permissionRuleProblemsOf(ir, resolveTool)) {
    findings.push({
      message: p.message,
      path: p.path,
      severity: "warning",
      rule: `permission-rule:${p.code}`,
    });
  }

  // Warnings inform; only errors gate (`ok` drives the CLI exit code).
  return { ok: findings.every((f) => f.severity !== "error"), findings, spec, ir };
}

/**
 * Every tool a rule can name, as the rule checker needs them: the builtins,
 * with their flags, and the tools the runtime registers without a spec
 * listing them (`Skill`, `ListTools`, the browser shape's `Type`, …), by name.
 * Without the second half a real tool name reads as a typo of a builtin, and
 * the "fix" for `alwaysAllow Skill` was `Shell`.
 */
export const KNOWN_TOOLS: ReadonlyArray<RuleToolDescriptor> = [
  ...Object.values(TOOL_FLAGS),
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

/** One list of permission patterns a spec carries, and how the engine reads it. */
type RuleList = {
  /** Where it sits in the spec, for the finding's path. */
  readonly path: string;
  readonly rules: ReadonlyArray<{ readonly type: string; readonly pattern: string }>;
};

/**
 * Every list of permission patterns in a lowered spec, each rule typed the
 * way the engine applies it: the shape's `permissions.rules`, each model
 * profile's `permissions.deny` / `ask` (they narrow whatever the profile
 * serves), and each sub-agent's `permissions.allow` / `deny` (they replace or
 * narrow the parent's for the sub-agent). All of them are matched against a
 * tool's registered name, so a spec key or a misspelling is as dead in one as
 * in another (C146).
 */
function permissionRuleListsOf(ir: IrNode): RuleList[] {
  const lists: RuleList[] = [];
  const node = ir as {
    readonly permissions?: { readonly rules?: ReadonlyArray<{ type: string; pattern: string }> };
    readonly models?: Readonly<Record<string, unknown>>;
    readonly subAgents?: unknown;
    readonly roles?: unknown;
  };
  const top = node.permissions?.rules ?? [];
  if (top.length > 0) lists.push({ path: "permissions.rules", rules: top });
  const typed = (type: string, patterns: unknown) =>
    Array.isArray(patterns)
      ? patterns
          .filter((p): p is string => typeof p === "string")
          .map((pattern) => ({ type, pattern }))
      : [];
  for (const [name, profile] of Object.entries(node.models ?? {})) {
    const perms = (profile as { readonly permissions?: { deny?: unknown; ask?: unknown } } | null)
      ?.permissions;
    if (perms === undefined) continue;
    for (const [field, type] of [
      ["deny", "alwaysDeny"],
      ["ask", "alwaysAsk"],
    ] as const) {
      const rules = typed(type, perms[field]);
      if (rules.length > 0) lists.push({ path: `models.${name}.permissions.${field}`, rules });
    }
  }
  const subAgents = (owner: unknown, at: string): void => {
    const defs = (owner as { readonly subAgents?: unknown } | null)?.subAgents;
    if (!Array.isArray(defs)) return;
    for (const def of defs as ReadonlyArray<{ name?: unknown; permissions?: unknown }>) {
      const perms = def?.permissions;
      if (typeof def?.name !== "string" || perms === null || typeof perms !== "object") continue;
      for (const [field, type] of [
        ["allow", "alwaysAllow"],
        ["deny", "alwaysDeny"],
      ] as const) {
        const rules = typed(type, (perms as Record<string, unknown>)[field]);
        if (rules.length > 0) {
          lists.push({ path: `${at}.sub_agents.${def.name}.permissions.${field}`, rules });
        }
      }
    }
  };
  subAgents(node, "agent");
  if (Array.isArray(node.roles)) {
    for (const role of node.roles as ReadonlyArray<{ name?: unknown } | null>) {
      if (typeof role?.name === "string") subAgents(role, `roles.${role.name}`);
    }
  }
  return lists;
}

/** A rule that can never do what it says, and where the spec holds it. */
export type LocatedRuleProblem = PermissionRuleProblem & {
  /** The list that holds the rule, e.g. `models.fast.permissions.deny`. */
  readonly list: string;
  /** `<list>[<type> <pattern>]`, e.g. `models.fast.permissions.deny[alwaysDeny fetch]`. */
  readonly path: string;
};

/**
 * The permission rules of a lowered spec that can never do what they say
 * (see `permissionRuleProblems`), in every list a spec carries (see
 * `permissionRuleListsOf`). A granted tool is described by the live tool
 * `resolveTool` returns, falling back to the builtin manifest, so the check
 * sees the same declarations the runtime will; the tools a `thredz:` block
 * registers are known in a spec that has one.
 */
export function permissionRuleProblemsOf(
  ir: IrNode,
  resolveTool: (name: string) => RegisteredTool | undefined,
): LocatedRuleProblem[] {
  const lists = permissionRuleListsOf(ir);
  if (lists.length === 0) return [];
  const node = ir as { readonly mcp_servers?: Readonly<Record<string, unknown>> };
  const granted: RuleToolDescriptor[] = [];
  for (const name of collectToolNames(ir)) {
    const live = resolveTool(name);
    const described = live ?? TOOL_FLAGS[name] ?? TOOL_FLAGS_BY_NAME.get(name);
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
  return out;
}

/** Re-exported for the CLI wrapper's philosophy-alignment parity note. */
export { auditToolScopes };

// -------------------------------------------------------------------------
// --fix: mechanical corrections for the findings a nearest-match / typo scan
// can resolve. Pure suggesters; the CLI wrapper applies chosen edits via
// spec-patch.
// -------------------------------------------------------------------------

/** A single mechanical fix suggestion for a lint finding. */
export type LintFixSuggestion = {
  readonly kind: "unknown-tool" | "secret-typo" | "safe-name";
  /** The offending token as written in the spec. */
  readonly from: string;
  /** The suggested replacement. */
  readonly to: string;
  /** Human-readable one-liner. */
  readonly note: string;
};

/** Case-insensitive Levenshtein distance — the nearest-match metric. */
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * The outcome of a nearest-match lookup:
 *  - `undefined` — no candidate close enough (genuinely unknown, not a typo),
 *    or the name is already legal.
 *  - `{ kind: "match", name }` — a single unambiguous nearest candidate;
 *    safe to auto-apply.
 *  - `{ kind: "ambiguous", candidates }` — two or more equally-near
 *    candidates whose I/O capability DIFFERS (e.g. a read-only tool vs a
 *    mutating one), so auto-applying could silently cross a capability
 *    boundary. Callers should surface this as a suggestion, not a fix.
 */
export type NearestToolMatch =
  | { readonly kind: "match"; readonly name: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

/**
 * Nearest legal name(s) for a mistyped tool name. `candidates` are the legal
 * spellings — the camelCase spec keys of the builtins the spec's shape can
 * compile, which every `tools:` list accepts (a sub-agent list maps them to
 * the registered names since 0.7.1). An exact match returns undefined
 * (nothing to fix). Otherwise the closest
 * candidate(s) within `maxDistance` (default 3) are considered; undefined
 * means nothing is close enough (a genuinely unknown tool, not a typo).
 *
 * `getReadOnly` is an optional injected lookup from candidate name → the
 * resolved tool's `readOnly` flag (undefined when the candidate can't be
 * resolved to a RegisteredTool, e.g. an unregistered custom-tool name — in
 * that case its capability is unknown and it is never treated as crossing a
 * boundary against another candidate). When ALL of the closest candidates
 * (same minimum distance) agree on `readOnly` — including the degenerate
 * single-candidate case — this returns a `"match"` for the first of them
 * (stable, deterministic). When they DISAGREE — a typo equidistant from a
 * read-only tool (e.g. `Read`) and a mutating one (e.g. `Edit`) — this
 * returns `"ambiguous"` with the full tied set rather than silently picking
 * one, because auto-applying would cross a read-only/mutating capability
 * boundary the author never asked for.
 */
export function nearestToolName(
  name: string,
  candidates: readonly string[],
  maxDistance = 3,
  getReadOnly?: (candidateName: string) => boolean | undefined,
): NearestToolMatch | undefined {
  if (candidates.includes(name)) return undefined;
  let bestDist: number | undefined;
  let tied: string[] = [];
  for (const cand of candidates) {
    const dist = levenshtein(name, cand);
    if (bestDist === undefined || dist < bestDist) {
      bestDist = dist;
      tied = [cand];
    } else if (dist === bestDist) {
      tied.push(cand);
    }
  }
  if (bestDist === undefined || bestDist > maxDistance) return undefined;
  if (tied.length === 1) {
    const only = tied[0];
    if (only === undefined) return undefined;
    return { kind: "match", name: only };
  }
  // Multiple equally-near candidates. If a capability lookup was injected and
  // the tied set spans more than one `readOnly` value, that is a genuine
  // cross-capability ambiguity — refuse to pick one. Candidates with unknown
  // capability (getReadOnly returns undefined) don't by themselves create
  // ambiguity: they only conflict when they disagree with a KNOWN capability
  // among the tied set.
  if (getReadOnly !== undefined) {
    const knownCapabilities = new Set(
      tied.map((c) => getReadOnly(c)).filter((v): v is boolean => v !== undefined),
    );
    if (knownCapabilities.size > 1) {
      return { kind: "ambiguous", candidates: tied };
    }
  } else {
    // No capability signal available — a plain tie is still ambiguous rather
    // than silently guessing via iteration order.
    return { kind: "ambiguous", candidates: tied };
  }
  const first = tied[0];
  if (first === undefined) return undefined;
  return { kind: "match", name: first };
}

/**
 * Suggest a `$UPPER_SNAKE_CASE` correction for a credential value that looks
 * like an env reference but isn't a valid one — the same class the compiler's
 * `lowerCredential` rejects (`$slack_token`, `${SLACK}`, `$1PASSWORD`).
 * Returns the normalised form, or undefined when `value` is not a
 * malformed-env-ref (a genuine literal, or already valid). Pure string logic.
 */
export function suggestSecretFix(value: string): string | undefined {
  if (!value.startsWith("$")) return undefined;
  // Already valid $UPPER_SNAKE_CASE — nothing to fix.
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) return undefined;
  // Strip a ${...} brace wrapper, then normalise the inner token.
  const inner = value.replace(/^\$\{?/, "").replace(/\}$/, "");
  if (inner === "") return undefined;
  // UPPER_SNAKE_CASE it: non-alnum → _, then uppercase, then ensure it does
  // not start with a digit (prefix `_`).
  let normalised = inner.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  if (/^[0-9]/.test(normalised)) normalised = `_${normalised}`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalised)) return undefined;
  return `$${normalised}`;
}

/** The single-line-safe name charset the spec's `safeName` enforces. */
const SAFE_NAME_RE = /^[\w .:-]+$/;

/**
 * Normalise a name that violates the `safeName` charset (letters, digits,
 * spaces, `_ . - :`) by replacing every illegal character with `-` and
 * collapsing runs. Returns undefined when `name` is already safe. Pure.
 */
export function suggestSafeName(name: string): string | undefined {
  if (SAFE_NAME_RE.test(name) && name.length >= 1) return undefined;
  const fixed = name
    .replace(/[^\w .:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
  if (fixed === "" || !SAFE_NAME_RE.test(fixed)) return undefined;
  return fixed;
}

/** Render the lint findings as the human-readable `text` report. Returns the
 *  block plus whether it is clean, so the CLI can pick the exit code. */
export function formatLintText(result: LintResult): string {
  if (result.findings.length === 0) return "lint: clean — no findings.\n";
  const lines: string[] = [];
  for (const f of result.findings) {
    const marker = f.severity === "error" ? "✗" : "~";
    lines.push(`${marker} [${f.rule}] ${f.path}: ${f.message}`);
  }
  const errorCount = result.findings.filter((f) => f.severity === "error").length;
  lines.push("");
  lines.push(`lint: ${errorCount} error(s), ${result.findings.length - errorCount} warning(s).`);
  return `${lines.join("\n")}\n`;
}

/** Render the lint findings as `{ findings: LintFinding[] }` JSON for editors/CI. */
export function formatLintJson(result: LintResult): string {
  return `${JSON.stringify({ ok: result.ok, findings: result.findings }, null, 2)}\n`;
}
