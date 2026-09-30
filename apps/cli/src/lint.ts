import { type IrNode, checkShapeTools, collectCompileWarnings, lower } from "@crewhaus/compiler";
import { CrewhausError } from "@crewhaus/errors";
import { DEFAULT_PIPELINE, type IrPass } from "@crewhaus/ir-passes";
import {
  type Spec,
  SpecParseError,
  mcpServerNameWarnings,
  parseSpec,
  parseSpecIssues,
  specJsonSchema,
} from "@crewhaus/spec";
import { auditToolScopes } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  BUILTIN_TOOLS,
  SHAPE_TOOL_PROFILES,
  type ToolShape,
  builtinKeyForName,
  builtinToolsFor,
} from "@crewhaus/tool-categories";
import {
  type PermissionRuleProblem,
  type RuleToolDescriptor,
  permissionRuleProblems,
  specPermissionRuleLists,
} from "@crewhaus/tool-permission-matcher";
import {
  NON_CLI_TOOL_FLAGS,
  RUNTIME_TOOL_NAMES,
  THREDZ_TOOL_NAMES,
  TOOL_FLAGS,
  TOOL_FLAGS_BY_NAME,
} from "@crewhaus/tool-registry-manifest/flags";
import { type Document, type Scalar, isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { auditModelPlan } from "./model-plan-lint";
import { auditSpecToolNames, collectToolNames, nonCliBuiltinFlags } from "./scope-audit";

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
  // Stage 3c — the spec-key warnings compile prints: a key the shape accepts
  // but does not wire (`tools:` on onchain, `tool_config:` on voice) is
  // `accepted-but-unwired`, which fails `compile --strict`. Lint said "clean"
  // for those specs.
  for (const w of collectCompileWarnings(spec)) {
    findings.push({ message: w.message, path: w.path, severity: "warning", rule: w.code });
  }
  // A typo in a list that narrows a site's tools (a sub-agent's, a model
  // profile's) compiles — the name just never matches — so it is a warning,
  // the one `lint --fix` would rewrite (C025).
  findings.push(...narrowingListFindings(yamlText, resolveTool));

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
  for (const p of permissionRuleProblemsOf(spec, ir, resolveTool)) {
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

/** A rule that can never do what it says, and where the spec holds it. */
export type LocatedRuleProblem = PermissionRuleProblem & {
  /** The list that holds the rule, e.g. `models.fast.permissions.deny`. */
  readonly list: string;
  /** `<list>[<type> <pattern>]`, e.g. `models.fast.permissions.deny[alwaysDeny fetch]`. */
  readonly path: string;
};

/**
 * The permission rules of a spec that can never do what they say (see
 * `permissionRuleProblems`), in every list the spec carries (see
 * `specPermissionRuleLists`: the shape's rules, each model profile's and
 * pool candidate's deny/ask, each sub-agent's allow/deny). A granted tool is
 * one the lowered spec lists, described by the live tool `resolveTool`
 * returns, falling back to the builtin manifest, so the check sees the same
 * declarations the runtime will; the tools a `thredz:` block registers are
 * known in a spec that has one.
 */
export function permissionRuleProblemsOf(
  spec: unknown,
  ir: IrNode,
  resolveTool: (name: string) => RegisteredTool | undefined,
): LocatedRuleProblem[] {
  const lists = specPermissionRuleLists(spec);
  if (lists.length === 0) return [];
  const node = ir as { readonly mcp_servers?: Readonly<Record<string, unknown>> };
  const granted: RuleToolDescriptor[] = [];
  for (const name of collectToolNames(ir)) {
    const live = resolveTool(name);
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
  return out;
}

/** Rule findings that inform without saying the rule is dead: never escalated by --strict. */
const PERMISSION_RULE_NOTES: ReadonlySet<string> = new Set([
  "builtin-not-reached",
  "tool-not-known",
]);

/**
 * The permission rules in a spec that can never do what they say, as compile
 * warnings (code `permission-rule`, or `permission-rule-note` for a note
 * --strict does not escalate), in every list the spec carries. A spec that
 * does not parse or lower has none here — the compile itself reports why.
 *
 * `loadTools` imports every builtin package the CLI carries (about half a
 * second), so it is called only when the spec has a rule to check: a
 * rule-less compile does not pay for it.
 */
export async function permissionRuleWarnings(
  yamlText: string,
  loadTools: () => Promise<Readonly<Record<string, RegisteredTool>>>,
): Promise<Array<{ code: string; path: string; message: string }>> {
  let spec: Spec;
  let ir: IrNode;
  try {
    spec = parseSpec(yamlText);
    ir = lower(spec);
  } catch {
    return [];
  }
  if (specPermissionRuleLists(spec).length === 0) return [];
  const toolMap = await loadTools();
  const byRegisteredName: Record<string, RegisteredTool> = {};
  for (const tool of Object.values(toolMap)) byRegisteredName[tool.name] = tool;
  // A `builtin-not-reached` note is about a rule that still fires (on a
  // declared MCP server's tools), and a `tool-not-known` one about a name a
  // plugin or custom tool may still supply, so --strict escalates neither.
  return permissionRuleProblemsOf(spec, ir, (name) => toolMap[name] ?? byRegisteredName[name]).map(
    (p) => ({
      code: PERMISSION_RULE_NOTES.has(p.code) ? "permission-rule-note" : "permission-rule",
      path: p.list,
      message: p.message,
    }),
  );
}

/** Re-exported for the CLI wrapper's philosophy-alignment parity note. */
export { auditToolScopes };

// -------------------------------------------------------------------------
// --fix: mechanical corrections for the findings a nearest-match / typo scan
// can resolve. Pure suggesters; `applyLintFixes` below applies them to the
// YAML document, and the CLI wrapper writes the result.
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

// -------------------------------------------------------------------------
// --fix, applied: a walk over the YAML document, not over its lines (C025).
// -------------------------------------------------------------------------

/** One replacement of a scalar's source text. */
type ScalarEdit = { readonly start: number; readonly end: number; readonly text: string };

/** What `lint --fix` would change, and what it would only suggest. */
export type LintFixResult = {
  /** The spec text with every applied fix in it (the input when there is none). */
  readonly text: string;
  /** One line per applied fix. */
  readonly applied: string[];
  /** One line per typo it will not pick a fix for. */
  readonly suggested: string[];
  /**
   * Why nothing was looked at, when the file could not be walked (it is not
   * valid YAML) — so "no fixes" is never said of a file nobody read.
   */
  readonly skipped?: string;
};

/** A path through a YAML document: a mapping key, or `[]` for a sequence item. */
type DocPath = ReadonlyArray<string>;

const SEQ_ITEM = "[]";

/** Where each shape's spec holds a `tools:` list, read once per shape. */
const toolListPathCache = new Map<string, ReadonlyArray<DocPath>>();

/**
 * Every place a spec of this `target` holds a `tools:` list of names, read
 * from the spec's own JSON schema: `*` is any mapping key (a sub-agent's or a
 * node's name), `[]` any sequence item. Reading the schema instead of
 * listing the places keeps a new site (a pool candidate's `tools`) from being
 * missed, and keeps `tools` anywhere else — an MCP server's `args`, a
 * `tool_config` block, text inside `instructions: |` — from being touched.
 */
export function toolListPaths(target: string | undefined): ReadonlyArray<DocPath> {
  const key = target ?? "";
  const cached = toolListPathCache.get(key);
  if (cached !== undefined) return cached;
  const schema = specJsonSchema();
  const definitions = asJson(schema["definitions"]) ?? {};
  const root =
    target !== undefined && Object.hasOwn(definitions, target) ? definitions[target] : schema;
  const resolve = (ref: string): unknown => {
    let at: unknown = schema;
    for (const seg of ref.replace(/^#\//, "").split("/")) {
      at = asJson(at)?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return at;
  };
  const deref = (node: unknown): Record<string, unknown> | undefined => {
    let at = asJson(node);
    for (let i = 0; i < 32 && typeof at?.["$ref"] === "string"; i++) {
      at = asJson(resolve(at["$ref"] as string));
    }
    return at;
  };
  const found = new Map<string, DocPath>();
  const walk = (node: unknown, path: string[], refs: ReadonlySet<string>): void => {
    const n = asJson(node);
    // A tools list sits a few levels down; nothing recursive holds one.
    if (n === undefined || path.length > 16) return;
    const ref = n["$ref"];
    if (typeof ref === "string") {
      if (refs.has(ref)) return;
      walk(resolve(ref), path, new Set([...refs, ref]));
      return;
    }
    for (const combinator of ["anyOf", "oneOf", "allOf"]) {
      const branches = n[combinator];
      if (Array.isArray(branches)) for (const b of branches) walk(b, path, refs);
    }
    for (const [prop, value] of Object.entries(asJson(n["properties"]) ?? {})) {
      if (prop === "tools" && deref(value)?.["type"] === "array") {
        found.set([...path, prop].join("\u0000"), [...path, prop]);
      }
      walk(value, [...path, prop], refs);
    }
    if (asJson(n["additionalProperties"]) !== undefined) {
      walk(n["additionalProperties"], [...path, "*"], refs);
    }
    if (n["items"] !== undefined) walk(n["items"], [...path, SEQ_ITEM], refs);
  };
  walk(root, [], new Set());
  const paths = [...found.values()];
  toolListPathCache.set(key, paths);
  return paths;
}

function asJson(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pathMatches(pattern: DocPath, path: DocPath): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((seg, i) => seg === path[i] || (seg === "*" && path[i] !== SEQ_ITEM));
}

/**
 * A `tools:` list that narrows what its site registers — a sub-agent's, a
 * model profile's, a pool candidate's — takes a builtin under either
 * spelling; the others register tools and take the spec key.
 */
function isNarrowingList(path: DocPath): boolean {
  return path[0] === "models" || path.includes("sub_agents") || path.includes("model_pool");
}

/** The spec's `target:` as written, and the shape whose tools a fix may name. */
function shapeOf(doc: Document): { target?: string; shape: ToolShape } {
  const target = doc.get("target");
  const shape =
    typeof target === "string" && Object.hasOwn(SHAPE_TOOL_PROFILES, target)
      ? (target as ToolShape)
      : "cli";
  return typeof target === "string" ? { target, shape } : { shape };
}

/**
 * Names a `tools:` list may hold that are not builtins, and must never be
 * "fixed" into one: the tools the runtime adds on its own, a `thredz:`
 * block's tools, and MCP tools (`mcp__server__tool`, or `server__tool`).
 */
function isKnownNonBuiltin(token: string, doc: Document): boolean {
  if (token.includes("__")) return true;
  if (RUNTIME_TOOL_NAMES.includes(token)) return true;
  const thredz = doc.get("thredz");
  if (thredz === undefined || thredz === false || thredz === null) return false;
  return THREDZ_TOOL_NAMES.memory.includes(token) || THREDZ_TOOL_NAMES.messaging.includes(token);
}

/** One `tools:` item a fix names, or a typo it will only suggest a fix for. */
type ToolListFix = {
  /** The list's path in the spec, dot-joined (`agent.sub_agents.helper.tools`). */
  readonly list: string;
  readonly narrowing: boolean;
  readonly token: string;
  readonly node: Scalar;
  readonly to?: string;
  readonly candidates?: readonly string[];
  /**
   * Where the same item is read again through a YAML alias of it (or of a
   * node holding it) that is not a `tools:` list of the same kind — an MCP
   * server's `args: *shared`. Editing the item edits those too, so the fix
   * is suggested, not applied.
   */
  readonly aliasedAt?: readonly string[];
};

/** Every YAML alias in the document, by the anchor it names, with where it sits. */
function aliasesByAnchor(doc: Document): Map<string, DocPath[]> {
  const out = new Map<string, DocPath[]>();
  const visit = (node: unknown, path: string[], depth: number): void => {
    if (depth > 64) return;
    if (isAlias(node)) {
      const at = out.get(node.source) ?? [];
      at.push(path);
      out.set(node.source, at);
    } else if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? pair.key.value : pair.key;
        visit(pair.value, [...path, String(k)], depth + 1);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item, [...path, SEQ_ITEM], depth + 1);
    }
  };
  visit(doc.contents, [], 0);
  return out;
}

/** A node's anchor, when it carries one. */
function anchorOf(node: unknown): string | undefined {
  const anchor = (node as { readonly anchor?: unknown } | null)?.anchor;
  return typeof anchor === "string" && anchor !== "" ? anchor : undefined;
}

/**
 * Every item of every `tools:` list in the document that names no tool the
 * list takes and is a typo of one: the nearest legal name, or, when the
 * nearest names differ in what they may do, the tied names to choose from.
 *
 * On a shape whose runtime carries no tools (voice, onchain), compile
 * accepts a `tools:` list and ignores it, and lint says nothing about it, so
 * there is nothing to fix.
 */
function toolListFixes(
  doc: Document,
  getReadOnly: (candidateName: string) => boolean | undefined,
): ToolListFix[] {
  const { target, shape } = shapeOf(doc);
  const patterns = toolListPaths(target);
  // A typo is fixed to a spelling `compile` accepts on THIS spec's shape: the
  // camelCase spec key, which every tools: list takes (a narrowing list maps
  // it to the registered name). A narrowing list also takes the registered
  // name (`Read`, as 0.7.0 documented), so a typo there is fixed in the
  // spelling it was written in.
  const keys = builtinToolsFor(shape);
  if (keys.length === 0) return [];
  const names = keys.map((k) => BUILTIN_TOOLS[k]?.name ?? k);
  const aliases = aliasesByAnchor(doc);
  const isToolList = (path: DocPath, narrowing: boolean): boolean =>
    path[path.length - 1] === "tools" &&
    patterns.some((p) => pathMatches(p, path)) &&
    isNarrowingList(path) === narrowing;
  // Where an item at `itemPath` is also read through an alias of a node on
  // the way to it (`anchored`, each with its path), when that is not an item
  // of a tools: list of the same kind.
  const aliasedOutside = (
    itemPath: DocPath,
    anchored: ReadonlyArray<{ readonly anchor: string; readonly path: DocPath }>,
    narrowing: boolean,
  ): string[] => {
    const out: string[] = [];
    for (const { anchor, path } of anchored) {
      for (const aliasPath of aliases.get(anchor) ?? []) {
        const effective = [...aliasPath, ...itemPath.slice(path.length)];
        const list = effective.slice(0, -1);
        if (effective[effective.length - 1] === SEQ_ITEM && isToolList(list, narrowing)) continue;
        out.push(aliasPath.join("."));
      }
    }
    return out;
  };
  const out: ToolListFix[] = [];
  const visit = (
    node: unknown,
    path: string[],
    anchored: ReadonlyArray<{ readonly anchor: string; readonly path: DocPath }>,
  ): void => {
    const own = anchorOf(node);
    const here = own !== undefined ? [...anchored, { anchor: own, path }] : anchored;
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? pair.key.value : pair.key;
        if (typeof k !== "string" && typeof k !== "number") continue;
        const key = String(k);
        const at = [...path, key];
        if (key === "tools" && isSeq(pair.value) && patterns.some((p) => pathMatches(p, at))) {
          const narrowing = isNarrowingList(at);
          const seqAnchor = anchorOf(pair.value);
          const listAnchored =
            seqAnchor !== undefined ? [...here, { anchor: seqAnchor, path: at }] : here;
          for (const item of pair.value.items) {
            if (!isScalar(item) || typeof item.value !== "string") continue;
            const token = item.value;
            if (!/^[A-Za-z]\w*$/.test(token) || isKnownNonBuiltin(token, doc)) continue;
            if (narrowing && builtinKeyForName(token) !== undefined) continue;
            const candidates = narrowing && /^[A-Z]/.test(token) ? names : keys;
            const nearest = nearestToolName(token, candidates, undefined, getReadOnly);
            const list = at.join(".");
            const itemPath = [...at, SEQ_ITEM];
            const itemAnchor = anchorOf(item);
            const aliasedAt = aliasedOutside(
              itemPath,
              itemAnchor !== undefined
                ? [...listAnchored, { anchor: itemAnchor, path: itemPath }]
                : listAnchored,
              narrowing,
            );
            const aliased = aliasedAt.length > 0 ? { aliasedAt } : {};
            if (nearest?.kind === "match") {
              out.push({ list, narrowing, token, node: item, to: nearest.name, ...aliased });
            } else if (nearest?.kind === "ambiguous") {
              out.push({
                list,
                narrowing,
                token,
                node: item,
                candidates: nearest.candidates,
                ...aliased,
              });
            }
          }
        }
        visit(pair.value, at, here);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item, [...path, SEQ_ITEM], here);
    }
  };
  visit(doc.contents, [], []);
  return out;
}

/** A replacement for a scalar's source that keeps how it was quoted. */
function scalarEdit(src: string, node: Scalar, value: string): ScalarEdit | undefined {
  const range = node.range;
  if (range === undefined || range === null) return undefined;
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") return undefined;
  const [start, end] = range;
  const written = src.slice(start, end);
  const quote = written.startsWith('"') ? '"' : written.startsWith("'") ? "'" : "";
  const text =
    quote !== ""
      ? `${quote}${value}${quote}`
      : /^[A-Za-z0-9_$][\w.$-]*$/.test(value)
        ? value
        : JSON.stringify(value);
  return { start, end, text };
}

function applyEdits(src: string, edits: ReadonlyArray<ScalarEdit>): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, e.start)}${e.text}${out.slice(e.end)}`;
  }
  return out;
}

/**
 * A `lint` finding for each typo in a list that NARROWS a site's tools (a
 * sub-agent's, a model profile's, a pool candidate's). compile passes such a
 * list — the name just never matches a tool — so it was clean to `lint`,
 * while `lint --fix` rewrote it. The site lists are compile errors already.
 */
function narrowingListFindings(
  yamlText: string,
  resolveTool: (name: string) => RegisteredTool | undefined,
): LintFinding[] {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) return [];
  return toolListFixes(doc, (name) => resolveTool(name)?.readOnly)
    .filter((f) => f.narrowing)
    .map((f) => ({
      message:
        f.to !== undefined
          ? `tools: "${f.token}" is no tool, so this list never grants it — did you mean "${f.to}"? ${f.aliasedAt !== undefined ? `(not auto-fixed: the list is also read through an alias at ${f.aliasedAt.join(", ")})` : "(lint --fix writes it.)"}`
          : `tools: "${f.token}" is no tool, so this list never grants it — did you mean ${(f.candidates ?? []).map((c) => `"${c}"`).join(" or ")}? (not auto-fixed: they differ in what they may do)`,
      path: f.list,
      severity: "warning" as const,
      rule: "tool-list-typo",
    }));
}

/** The compile error for a malformed `$` credential, and the value it names. */
const CREDENTIAL_ENV_REF_ERROR =
  /^(\S+) value ("(?:[^"\\]|\\.)*") looks like an environment reference but is not a valid one/;
const WALLET_KEY_REF_ERROR =
  /^wallet "[^"]*" keyRef "(\$[^"]*)" is not a permitted signing-key reference/;

/**
 * The scalar a compile credential error is about: at the field it names, or,
 * where that label is not the spec's path (a crew role's `thredz` key, a
 * server name with a dot), the first scalar under the same top-level key that
 * holds the value under the same field name — or is the whole block
 * (`thredz: $key`).
 */
function credentialScalar(doc: Document, label: string, raw: string): Scalar | undefined {
  const segments = label.split(".");
  const direct = doc.getIn(segments, true);
  if (isScalar(direct) && direct.value === raw) return direct;
  const top = segments[0] ?? "";
  const field = segments[segments.length - 1] ?? "";
  const root = doc.get(top, true);
  if (isScalar(root)) return root.value === raw ? root : undefined;
  let hit: Scalar | undefined;
  const visit = (node: unknown, key: string | undefined): void => {
    if (hit !== undefined) return;
    if (isScalar(node)) {
      if (node.value === raw && key === field) hit = node;
    } else if (isMap(node)) {
      for (const pair of node.items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : undefined;
        visit(pair.value, k);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item, key);
    }
  };
  visit(root, undefined);
  return hit;
}

/**
 * `lint --fix`: the mechanical corrections, made on the parsed YAML document
 * so only the fields they are about change and everything else — comments,
 * quoting, text inside `instructions: |` — stays byte-for-byte (C025).
 *
 * - A typo in a `tools:` list (at a place the spec's schema says holds one)
 *   → the nearest tool the list takes; a typo equidistant from tools that
 *   differ in what they may do is returned in `suggested` instead.
 * - An unsafe `name` the spec rejects → sanitised.
 * - A credential `compile` rejects as a malformed `$` reference →
 *   `$UPPER_SNAKE_CASE`. Only what compile rejects: `model: $fast` is a
 *   profile reference, and is never touched.
 *
 * A document that is not valid YAML is left alone — there is nothing to walk
 * — and `skipped` says so. A typo in a list that is also read through a YAML
 * alias somewhere that is not a `tools:` list (`args: *shared`) is only
 * suggested: the edit would change that place too.
 */
export function applyLintFixes(
  yamlText: string,
  resolveTool: (name: string) => RegisteredTool | undefined,
): LintFixResult {
  const applied: string[] = [];
  const suggested: string[] = [];
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    const first = (doc.errors[0]?.message ?? "").split("\n")[0] ?? "";
    return {
      text: yamlText,
      applied,
      suggested,
      skipped: `the file is not valid YAML${first !== "" ? ` (${first})` : ""}`,
    };
  }

  const edits: ScalarEdit[] = [];
  for (const fix of toolListFixes(doc, (name) => resolveTool(name)?.readOnly)) {
    if (fix.aliasedAt !== undefined) {
      const options =
        fix.to !== undefined
          ? `"${fix.to}"`
          : (fix.candidates ?? []).map((c) => `"${c}"`).join(" or ");
      suggested.push(
        `tool "${fix.token}" — did you mean ${options}? (not auto-fixed — ${fix.list} is also read through an alias at ${fix.aliasedAt.join(", ")}, which the edit would change too)`,
      );
    } else if (fix.to !== undefined) {
      const edit = scalarEdit(yamlText, fix.node, fix.to);
      if (edit === undefined) continue;
      edits.push(edit);
      applied.push(`tool "${fix.token}" → "${fix.to}" (nearest match)`);
    } else {
      const options = (fix.candidates ?? []).map((c) => `"${c}"`).join(" or ");
      suggested.push(
        `tool "${fix.token}" — did you mean ${options}? (not auto-fixed — ambiguous across tool capabilities)`,
      );
    }
  }
  // An unsafe name, where the spec's own validation rejects it.
  const fixedNames = new Set<unknown>();
  for (const issue of parseSpecIssues(yamlText)) {
    if (issue.path[issue.path.length - 1] !== "name") continue;
    const node = doc.getIn(issue.path, true);
    if (!isScalar(node) || typeof node.value !== "string" || fixedNames.has(node)) continue;
    const safe = suggestSafeName(node.value);
    if (safe === undefined) continue;
    const edit = scalarEdit(yamlText, node, safe);
    if (edit === undefined) continue;
    fixedNames.add(node);
    edits.push(edit);
    applied.push(`name "${node.value}" → "${safe}" (unsafe characters)`);
  }
  let text = applyEdits(yamlText, edits);

  // A malformed credential reference, one per round, where compile names it.
  const seen = new Set<string>();
  for (let round = 0; round < 64; round++) {
    let message: string;
    try {
      lower(parseSpec(text));
      break;
    } catch (err) {
      message = (err as Error).message;
    }
    const credential = CREDENTIAL_ENV_REF_ERROR.exec(message);
    const wallet = credential === null ? WALLET_KEY_REF_ERROR.exec(message) : null;
    let label: string;
    let raw: string;
    if (credential !== null) {
      label = credential[1] as string;
      raw = JSON.parse(credential[2] as string) as string;
    } else if (wallet !== null) {
      label = "wallets.keyRef";
      raw = wallet[1] as string;
    } else {
      break;
    }
    if (seen.has(`${label}\u0000${raw}`)) break;
    seen.add(`${label}\u0000${raw}`);
    const fixed = suggestSecretFix(raw);
    if (fixed === undefined) break;
    const current = parseDocument(text);
    const node = credentialScalar(current, label, raw);
    const edit = node !== undefined ? scalarEdit(text, node, fixed) : undefined;
    if (edit === undefined) break;
    text = applyEdits(text, [edit]);
    applied.push(`secret "${raw}" → "${fixed}" ($UPPER_SNAKE_CASE)`);
  }
  return { text, applied, suggested };
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
