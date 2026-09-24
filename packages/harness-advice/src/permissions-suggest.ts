import type { PermissionRule, RuleType } from "@crewhaus/permission-engine";
import {
  type OperativeArg,
  type RegisteredTool,
  stripJustificationField,
} from "@crewhaus/tool-catalog";
import { operativeValuesOf, preparePermissionSubject } from "@crewhaus/tool-executor";
/**
 * Item 16 — `crewhaus permissions suggest`: mine persisted ask/deny history
 * into reviewable permission rules. The pure, side-effect-free half; all
 * filesystem access + the interactive `--apply` confirm live in
 * `apps/cli/src/index.ts` (mirrors `advise-rules.ts`).
 *
 * SIGNAL SHAPE (verified against `@crewhaus/event-log` + runtime-core's
 * advisor subscriber): the durable `permission` line is
 * `{ toolName, decision, askOutcome }` and carries NO tool input (the input
 * lives only on the adjacent `tool_use` line `{ id, name, input }`). Both
 * `permission.toolName` and `tool_use.name` are the RegisteredTool's
 * PascalCase `.name` (`Read`, `Bash`), so the two correlate directly by name.
 * We therefore aggregate asks by toolName and derive an OPTIONAL arg glob by
 * reading every tool_use input seen for that tool the way the permission
 * matcher will: the tool's declared `operativeArgs`, canonicalised. A rule is
 * scoped only when every recorded call acted on the same single place; any
 * other proposal is a bare tool grant, and says so (`BLANKET GRANT`).
 *
 * SAFETY: permissions are deliberately EXCLUDED from OPTIMIZABLE_PATHS — an
 * optimizer must never widen its own permissions. This module only ever
 * PROPOSES rules; nothing here writes, and the CLI's `--apply` is always an
 * interactive human confirm (never eval-gated). Read-only tools get
 * `alwaysAllow` proposals first (lowest blast radius); recurring DENIED asks
 * get an `alwaysAsk` tightening (never a blanket `alwaysDeny` — a human
 * denied THIS call, not necessarily every future one).
 */
import {
  OPERATIVE_ARG_FIELDS as MATCHER_OPERATIVE_ARG_FIELDS,
  type OperativeValue,
  type OperativeValueKind,
  escapeGlobLiteral,
} from "@crewhaus/tool-permission-matcher";
import { type SessionEvents, payloadOf } from "./advise-rules";

// -------- aggregation --------

/**
 * Why a proposal for a tool could not be narrowed to the calls that were
 * approved, so it is a bare grant for the whole tool:
 *
 * - `undeclared` — the tool does not say which argument decides where it acts
 *   (an MCP or custom tool, or one this caller could not look up);
 * - `no-scoping-argument` — it says no argument does (`operativeArgs: []`);
 * - `not-parsed` — a recorded input no longer parses with the tool's schema;
 * - `no-value` — a call carried none of the tool's operative arguments;
 * - `several-places` — one call acted on more than one place (a source and a
 *   destination, several recipients), which one rule value cannot cover;
 * - `not-representable` — a value cannot be written as a rule value: a path
 *   outside the workspace, text that is not a URL, or a parenthesis;
 * - `varied` — the calls acted on different places.
 */
export type UnscopedReason =
  | "undeclared"
  | "no-scoping-argument"
  | "not-parsed"
  | "no-value"
  | "several-places"
  | "not-representable"
  | "varied";

export type AskAggregate = {
  readonly toolName: string;
  asks: number;
  approved: number;
  denied: number;
  /** Sampled operative-arg values from adjacent tool_use inputs (deduped,
   *  capped), in the canonical form a rule is matched against. */
  readonly argSamples: string[];
  /** The kind of the sampled values, when the tool declares it. */
  argKind?: OperativeValueKind;
  /** Why no single value covers every recorded call; empty when one does. */
  readonly unscoped?: UnscopedReason[];
};

/** What the suggester knows about one tool. */
export type SuggestToolInfo = {
  /** The tool's declared `operativeArgs`; absent when it declares none. */
  readonly operativeArgs?: ReadonlyArray<OperativeArg>;
  /**
   * The tool itself, when it is loaded. A recorded input is then parsed with
   * the tool's schema before its values are read — what the runtime does
   * before a rule is checked. Without it (the builtin manifest has no
   * schema) the values are read from the input as recorded.
   */
  readonly tool?: RegisteredTool;
};

/** Looks a tool up by its registered name; `undefined` when it is unknown here. */
export type SuggestToolLookup = (toolName: string) => SuggestToolInfo | undefined;

/** A lookup over loaded tools, keyed by their registered `.name`. */
export function suggestLookupFromTools(
  toolMap: Readonly<Record<string, RegisteredTool>>,
): SuggestToolLookup {
  const byName = new Map<string, RegisteredTool>();
  for (const t of Object.values(toolMap)) byName.set(t.name, t);
  return (toolName) => {
    const tool = byName.get(toolName);
    if (tool === undefined) return undefined;
    return {
      ...(tool.operativeArgs !== undefined ? { operativeArgs: tool.operativeArgs } : {}),
      tool,
    };
  };
}

/**
 * The operative input field(s) per built-in tool — the one a permission
 * arg-glob constrains. Re-exported from `@crewhaus/tool-permission-matcher`
 * (the SINGLE source of truth) so a suggested pattern always targets the SAME
 * field the matcher checks. This was hand-copied here (a silent-desync risk);
 * now a matcher edit propagates automatically. Keyed by the PascalCase runtime
 * `.name`.
 */
export const OPERATIVE_ARG_FIELDS = MATCHER_OPERATIVE_ARG_FIELDS;

/** Max distinct operative-arg samples kept per tool (bounds report size). */
export const MAX_ARG_SAMPLES = 5;

/** One recorded call, read the way a rule would read it. */
type CallReading =
  | { readonly kind: "value"; readonly value: string; readonly valueKind?: OperativeValueKind }
  | { readonly kind: "unscoped"; readonly reason: UnscopedReason };

const unscoped = (reason: UnscopedReason): CallReading => ({ kind: "unscoped", reason });

/**
 * The single place a recorded call acted on, or why there is not one.
 *
 * A declared tool is read like the runtime reads it: the input parsed with
 * the tool's schema when the tool is at hand, the declared fields read from
 * it, and each value canonicalised (a path with `..` collapsed, a URL in its
 * parsed form). An undeclared tool falls back to the matcher's name table,
 * as it always has.
 */
function readCall(toolName: string, input: unknown, lookup?: SuggestToolLookup): CallReading {
  const info = lookup?.(toolName);
  const declared = info?.operativeArgs;
  if (declared === undefined) {
    const fields = OPERATIVE_ARG_FIELDS[toolName];
    if (fields === undefined) return unscoped("undeclared");
    if (input === null || typeof input !== "object") return unscoped("no-value");
    const record = input as Record<string, unknown>;
    for (const f of fields) {
      const v = record[f];
      if (typeof v === "string" && v.length > 0) return representable(v);
    }
    return unscoped("no-value");
  }
  if (declared.length === 0) return unscoped("no-scoping-argument");
  let values: ReadonlyArray<OperativeValue>;
  if (info?.tool !== undefined) {
    const subject = preparePermissionSubject(
      info.tool,
      withoutInjectedJustification(info.tool, input),
    );
    if (!subject.ok) return unscoped("not-parsed");
    values = subject.operativeValues ?? [];
  } else {
    values = operativeValuesOf(declared, input) ?? [];
  }
  if (values.length === 0) return unscoped("no-value");
  if (values.length > 1) return unscoped("several-places");
  const only = values[0] as OperativeValue;
  const value = only.canonical[0];
  if (only.outsideWorkspace === true || value === undefined) return unscoped("not-representable");
  return representable(value, only.kind);
}

/**
 * A value the `Tool(arg)` grammar can carry. A parenthesis is refused: the
 * pattern is split at its first `(`, and a reviewer reading a proposal with
 * nested parentheses cannot tell where the argument ends.
 */
function representable(value: string, valueKind?: OperativeValueKind): CallReading {
  if (value.includes("(") || value.includes(")")) return unscoped("not-representable");
  return { kind: "value", value, ...(valueKind !== undefined ? { valueKind } : {}) };
}

/** A justification-gated tool is logged with the `justification` the runtime
 *  strips before the schema sees the input; strip it the same way. */
function withoutInjectedJustification(tool: RegisteredTool, input: unknown): unknown {
  if (!tool.requireJustification) return input;
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && Object.hasOwn(shape, "justification")
    ? input
    : stripJustificationField(input);
}

/**
 * Fold sessions into per-tool ask aggregates. Reads `permission` lines for
 * the ask counts and `tool_use` lines for the operative-arg samples. Pure;
 * tolerant of old-vintage logs (no permission lines → empty result).
 *
 * `lookup` says which argument of each tool decides where it acts. Without
 * it only the matcher's legacy name table is known, and every other tool
 * gets a bare proposal.
 */
export function aggregateAsks(
  sessions: ReadonlyArray<SessionEvents>,
  lookup?: SuggestToolLookup,
): ReadonlyMap<string, AskAggregate> {
  const byTool = new Map<string, AskAggregate>();
  const get = (toolName: string): AskAggregate => {
    let agg = byTool.get(toolName);
    if (agg === undefined) {
      agg = { toolName, asks: 0, approved: 0, denied: 0, argSamples: [], unscoped: [] };
      byTool.set(toolName, agg);
    }
    return agg;
  };

  // First pass: tool_use inputs → operative-arg sample bank per tool. Every
  // call counts, asked or not: a rule scoped on one value is proposed only
  // when no recorded call acted anywhere else.
  for (const session of sessions) {
    for (const obj of session.objects) {
      const tu = payloadOf(obj, "tool_use");
      if (tu === undefined || typeof tu["name"] !== "string") continue;
      const agg = get(tu["name"]);
      const reading = readCall(tu["name"], tu["input"], lookup);
      if (reading.kind === "unscoped") {
        const reasons = agg.unscoped as UnscopedReason[];
        if (!reasons.includes(reading.reason)) reasons.push(reading.reason);
        continue;
      }
      if (reading.valueKind !== undefined) agg.argKind = reading.valueKind;
      if (!agg.argSamples.includes(reading.value)) {
        if (agg.argSamples.length < MAX_ARG_SAMPLES) agg.argSamples.push(reading.value);
        else if (!(agg.unscoped as UnscopedReason[]).includes("varied")) {
          (agg.unscoped as UnscopedReason[]).push("varied");
        }
      }
    }
  }

  // Second pass: resolved permission asks → counts.
  for (const session of sessions) {
    for (const obj of session.objects) {
      const perm = payloadOf(obj, "permission");
      if (perm === undefined || typeof perm["toolName"] !== "string") continue;
      if (perm["decision"] !== "ask") continue; // allow/deny were not human prompts
      const agg = get(perm["toolName"]);
      agg.asks += 1;
      if (perm["askOutcome"] === "approved") agg.approved += 1;
      else if (perm["askOutcome"] === "denied") agg.denied += 1;
    }
  }

  // Drop tools that only contributed arg samples but never actually prompted.
  for (const [name, agg] of byTool) if (agg.asks === 0) byTool.delete(name);
  return byTool;
}

// -------- suggestion ranking --------

export type PermissionSuggestion = {
  readonly rule: PermissionRule;
  /** Why: "recurring-approved" | "recurring-denied". */
  readonly reason: "recurring-approved" | "recurring-denied";
  readonly toolName: string;
  readonly readOnly: boolean;
  readonly evidence: ReadonlyArray<string>;
  /** The count the ranking sorts on (approvals or denials). */
  readonly weight: number;
};

export type SuggestThresholds = {
  /** Minimum ask prompts for a tool before any rule is proposed. */
  readonly minAsks: number;
  /** Fraction of asks approved at/above which an alwaysAllow is proposed. */
  readonly approveRate: number;
  /** Fraction of asks denied at/above which an alwaysAsk tightening fires. */
  readonly denyRate: number;
};

export const DEFAULT_SUGGEST_THRESHOLDS: SuggestThresholds = Object.freeze({
  minAsks: 3,
  approveRate: 1.0, // only propose a grant when EVERY ask was approved
  denyRate: 0.5,
});

/** Build a name → readOnly lookup from the resolvable tool map (keyed by the
 *  RegisteredTool `.name`, which is what the ask aggregate is keyed by). */
export function readOnlyByName(
  toolMap: Readonly<Record<string, RegisteredTool>>,
): ReadonlyMap<string, boolean> {
  const out = new Map<string, boolean>();
  for (const t of Object.values(toolMap)) out.set(t.name, t.readOnly);
  return out;
}

/**
 * Compile a permission pattern for a tool. When every recorded call acted on
 * one and the same place we emit a tool+arg glob for it (`Bash(git status)`,
 * `Write(out/report.md)`); anything else — calls that varied, a tool with no
 * scoping argument, a value a rule cannot carry — is a bare tool glob, which
 * {@link blanketGrantNote} says out loud.
 *
 * SAFETY (glob widening): the observed value is a LITERAL the human approved,
 * not a glob the human authored. tool-permission-matcher treats `*`/`?` in an
 * arg-glob as wildcards, so splicing a raw value that contains them would make
 * the suggested rule match unapproved siblings (`Bash(npm run test:*)` matching
 * `Bash(npm run test:PRODUCTION-DELETE)`). We `escapeGlobLiteral` the value so
 * the rule matches ONLY the approved string.
 */
export function patternFor(agg: AskAggregate): string {
  if (agg.argSamples.length === 1 && (agg.unscoped ?? []).length === 0) {
    const value = agg.argSamples[0] as string;
    // Checked here too, for an aggregate built by hand rather than mined.
    if (!value.includes("(") && !value.includes(")")) {
      return `${agg.toolName}(${escapeGlobLiteral(value)})`;
    }
  }
  return agg.toolName;
}

/** Whether {@link patternFor} scopes this aggregate to the value it recorded. */
export function isArgScoped(agg: AskAggregate): boolean {
  return patternFor(agg) !== agg.toolName;
}

/**
 * The line a reviewer needs when a grant is for the whole tool rather than
 * the calls that were approved, or `undefined` when the grant is scoped. The
 * reason is the most specific one recorded.
 */
export function blanketGrantNote(agg: AskAggregate): string | undefined {
  if (isArgScoped(agg)) return undefined;
  const reasons = agg.unscoped ?? [];
  const why: Record<UnscopedReason, string> = {
    undeclared: `${agg.toolName} does not declare which argument decides where it acts, so the proposal cannot be narrowed to the approved calls`,
    "no-scoping-argument": `${agg.toolName} has no argument that decides where it acts, so no rule can be narrower than the tool`,
    "not-parsed": "a recorded call no longer fits the tool's input, so what it acted on is unknown",
    "not-representable":
      "an approved call acted on a place a rule cannot name (outside the workspace, not a URL, or containing a parenthesis)",
    "several-places":
      "an approved call acted on more than one place (a source and a destination, several recipients), and one rule value cannot cover them",
    "no-value": "an approved call carried none of the arguments a rule is checked against",
    varied: `the approved calls acted on ${agg.argSamples.length === MAX_ARG_SAMPLES ? "many" : agg.argSamples.length} different places`,
  };
  const order: UnscopedReason[] = [
    "undeclared",
    "no-scoping-argument",
    "not-parsed",
    "not-representable",
    "several-places",
    "no-value",
    "varied",
  ];
  const reason =
    order.find((r) => reasons.includes(r)) ??
    (agg.argSamples.length > 1
      ? "varied"
      : agg.argSamples.length === 1
        ? "not-representable"
        : "no-value");
  const example =
    reason === "varied" && agg.argSamples[0] !== undefined
      ? `; to allow only those, write one rule per place, e.g. ${agg.toolName}(${escapeGlobLiteral(agg.argSamples[0])})`
      : "";
  return `BLANKET GRANT: this allows every ${agg.toolName} call — ${why[reason]}${example}`;
}

/**
 * Rank ask aggregates into reviewable permission suggestions. Deterministic:
 *   - recurring-APPROVED tools (100% approved, ≥ minAsks) → `alwaysAllow`,
 *     read-only tools FIRST (lowest blast radius), then by approval count;
 *   - recurring-DENIED tools (deny rate ≥ denyRate) → `alwaysAsk` tightening
 *     (NOT alwaysDeny — a human denied a specific call, not the whole tool),
 *     by denial count.
 * Read-only-ness comes from the tool map; an unknown tool defaults to false
 * (treated as non-read-only ⇒ ranked after read-only grants).
 */
export function rankSuggestions(
  aggregates: ReadonlyMap<string, AskAggregate>,
  readOnly: ReadonlyMap<string, boolean>,
  thresholds: SuggestThresholds = DEFAULT_SUGGEST_THRESHOLDS,
): PermissionSuggestion[] {
  const grants: PermissionSuggestion[] = [];
  const tightenings: PermissionSuggestion[] = [];

  for (const agg of aggregates.values()) {
    if (agg.asks < thresholds.minAsks) continue;
    const ro = readOnly.get(agg.toolName) ?? false;
    const approveRate = agg.approved / agg.asks;
    const denyRate = agg.denied / agg.asks;
    const pattern = patternFor(agg);

    if (agg.denied === 0 && approveRate >= thresholds.approveRate) {
      const blanket = blanketGrantNote(agg);
      grants.push({
        rule: { type: "alwaysAllow", pattern, source: "settings" },
        reason: "recurring-approved",
        toolName: agg.toolName,
        readOnly: ro,
        weight: agg.approved,
        evidence: [
          `${agg.approved}/${agg.asks} ${agg.toolName} asks approved, 0 denied (threshold: ≥${thresholds.minAsks} asks, 100% approved)`,
          ro
            ? "tool is read-only — lowest blast radius to auto-allow"
            : "tool is NOT read-only — review the effect before granting",
          ...(blanket === undefined
            ? [`scoped to the one place every recorded call acted on: ${pattern}`]
            : [blanket]),
        ],
      });
    } else if (denyRate >= thresholds.denyRate) {
      tightenings.push({
        rule: { type: "alwaysAsk", pattern, source: "settings" },
        reason: "recurring-denied",
        toolName: agg.toolName,
        readOnly: ro,
        weight: agg.denied,
        evidence: [
          `${agg.denied}/${agg.asks} ${agg.toolName} asks DENIED (${(denyRate * 100).toFixed(0)}%, threshold: ≥${(thresholds.denyRate * 100).toFixed(0)}%)`,
          "proposing alwaysAsk (keep prompting) — a human denied specific calls; alwaysDeny would over-reach",
        ],
      });
    }
  }

  // Grants: read-only first, then approval count desc, then tool name.
  grants.sort((a, b) => {
    if (a.readOnly !== b.readOnly) return a.readOnly ? -1 : 1;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.toolName.localeCompare(b.toolName);
  });
  // Tightenings: denial count desc, then tool name.
  tightenings.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.toolName.localeCompare(b.toolName);
  });

  return [...grants, ...tightenings];
}

// -------- settings.json diff + merge --------

export type SettingsPermissionRule = { readonly type: RuleType; readonly pattern: string };

/**
 * Read the existing `permissions.rules` out of a parsed `.crewhaus/settings.json`
 * root (the EXACT shape `buildRuleSet` in index.ts consumes). Tolerant of a
 * missing/foreign file: anything that isn't the expected shape yields `[]`.
 */
export function existingSettingsRules(settingsRoot: unknown): SettingsPermissionRule[] {
  if (settingsRoot === null || typeof settingsRoot !== "object") return [];
  const perms = (settingsRoot as { permissions?: unknown }).permissions;
  if (perms === null || typeof perms !== "object") return [];
  const rules = (perms as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const out: SettingsPermissionRule[] = [];
  for (const r of rules) {
    if (r === null || typeof r !== "object") continue;
    const type = (r as { type?: unknown }).type;
    const pattern = (r as { pattern?: unknown }).pattern;
    if (
      (type === "alwaysAllow" || type === "alwaysDeny" || type === "alwaysAsk") &&
      typeof pattern === "string" &&
      pattern.length > 0
    ) {
      out.push({ type, pattern });
    }
  }
  return out;
}

export type PermissionsDiff = {
  /** The suggestions not already covered by an identical existing rule. */
  readonly additions: ReadonlyArray<SettingsPermissionRule>;
  /** Suggestions dropped because an identical rule already exists. */
  readonly alreadyPresent: ReadonlyArray<SettingsPermissionRule>;
  /** The full rule list after applying additions (existing ++ additions). */
  readonly merged: ReadonlyArray<SettingsPermissionRule>;
};

/**
 * Compute the additive diff between the existing settings rules and the
 * ranked suggestions. A suggestion whose (type, pattern) already exists is
 * reported as already-present, never duplicated. Order-preserving: existing
 * rules first, then new additions in suggestion rank order.
 */
export function diffPermissions(
  existing: ReadonlyArray<SettingsPermissionRule>,
  suggestions: ReadonlyArray<PermissionSuggestion>,
): PermissionsDiff {
  const key = (r: SettingsPermissionRule): string => `${r.type} ${r.pattern}`;
  const have = new Set(existing.map(key));
  const additions: SettingsPermissionRule[] = [];
  const alreadyPresent: SettingsPermissionRule[] = [];
  const seen = new Set(have);
  for (const s of suggestions) {
    const r: SettingsPermissionRule = { type: s.rule.type, pattern: s.rule.pattern };
    if (have.has(key(r))) {
      alreadyPresent.push(r);
    } else if (!seen.has(key(r))) {
      additions.push(r);
      seen.add(key(r));
    }
  }
  return { additions, alreadyPresent, merged: [...existing, ...additions] };
}

/**
 * Render the settings.json `permissions` block that `--apply` would write,
 * MERGING into the existing settings root so unrelated top-level keys
 * (`hooks`, skills, …) survive. Returns the full new root object; the CLI
 * JSON-stringifies it. Pure — never touches disk.
 */
export function applyToSettingsRoot(
  settingsRoot: unknown,
  merged: ReadonlyArray<SettingsPermissionRule>,
): Record<string, unknown> {
  const root: Record<string, unknown> =
    settingsRoot !== null && typeof settingsRoot === "object"
      ? { ...(settingsRoot as Record<string, unknown>) }
      : {};
  const existingPerms =
    root["permissions"] !== null && typeof root["permissions"] === "object"
      ? { ...(root["permissions"] as Record<string, unknown>) }
      : {};
  root["permissions"] = { ...existingPerms, rules: merged.map((r) => ({ ...r })) };
  return root;
}

// -------- rendering --------

/** Human-readable suggestion lines for the CLI text mode. */
export function formatSuggestionLines(suggestions: ReadonlyArray<PermissionSuggestion>): string[] {
  const lines: string[] = [];
  for (const s of suggestions) {
    lines.push(`[${s.reason}] ${s.rule.type} ${s.rule.pattern}${s.readOnly ? " (read-only)" : ""}`);
    for (const e of s.evidence) lines.push(`  · ${e}`);
  }
  return lines;
}

/**
 * A unified-diff-ish view of the settings.json permissions change: existing
 * rules as context, additions as `+` lines. Purely for human review — this
 * is NOT applied unless the user confirms `--apply` interactively.
 */
export function formatSettingsDiff(diff: PermissionsDiff): string[] {
  const lines: string[] = [".crewhaus/settings.json → permissions.rules:"];
  if (diff.merged.length === 0) {
    lines.push("  (no rules — nothing to suggest)");
    return lines;
  }
  const addKeys = new Set(diff.additions.map((r) => `${r.type} ${r.pattern}`));
  for (const r of diff.merged) {
    const isNew = addKeys.has(`${r.type} ${r.pattern}`);
    // Flag any UNESCAPED wildcard still present — such a rule matches multiple
    // values (an existing hand-authored broad rule or, defensively, a
    // suggestion that somehow kept a wildcard). Suggested rules escape their
    // literals in patternFor, so a `+` line should never trip this. A NEW
    // bare allow is a grant for every call of the tool, and is flagged too:
    // the suggestion's evidence says why it could not be narrower.
    const warn = hasUnescapedWildcard(r.pattern)
      ? " (⚠ wildcard — matches multiple)"
      : isNew && r.type === "alwaysAllow" && !r.pattern.includes("(")
        ? " (⚠ BLANKET GRANT — every call of the tool)"
        : "";
    lines.push(
      `  ${isNew ? "+" : " "} { type: ${r.type}, pattern: ${JSON.stringify(r.pattern)} }${warn}`,
    );
  }
  if (diff.additions.length === 0) {
    lines.push("  (all suggestions already present — nothing to add)");
  }
  return lines;
}

/**
 * True when a pattern contains a glob wildcard (`*`/`?`) that is NOT
 * backslash-escaped — i.e. one the matcher will treat as widening. A `\\*`/`\\?`
 * (a literal escaped by `escapeGlobLiteral`) does not count.
 */
export function hasUnescapedWildcard(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // skip the escaped char — it's a literal, not a wildcard
      continue;
    }
    if (ch === "*" || ch === "?") return true;
  }
  return false;
}
