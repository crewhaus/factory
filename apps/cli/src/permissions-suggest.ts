import type { PermissionRule, RuleType } from "@crewhaus/permission-engine";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
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
 * sampling the operative field of the tool_use inputs seen for that tool.
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
  escapeGlobLiteral,
} from "@crewhaus/tool-permission-matcher";
import { type SessionEvents, payloadOf } from "./advise-rules";

// -------- aggregation --------

export type AskAggregate = {
  readonly toolName: string;
  asks: number;
  approved: number;
  denied: number;
  /** Sampled operative-arg values from adjacent tool_use inputs (deduped,
   *  capped). Empty ⇒ no arg pattern derivable → propose a bare tool glob. */
  readonly argSamples: string[];
};

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

function operativeValue(toolName: string, input: unknown): string | undefined {
  const fields = OPERATIVE_ARG_FIELDS[toolName];
  if (fields === undefined || input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const f of fields) {
    const v = record[f];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Fold sessions into per-tool ask aggregates. Reads `permission` lines for
 * the ask counts and `tool_use` lines for the operative-arg samples. Pure;
 * tolerant of old-vintage logs (no permission lines → empty result).
 */
export function aggregateAsks(
  sessions: ReadonlyArray<SessionEvents>,
): ReadonlyMap<string, AskAggregate> {
  const byTool = new Map<string, AskAggregate>();
  const get = (toolName: string): AskAggregate => {
    let agg = byTool.get(toolName);
    if (agg === undefined) {
      agg = { toolName, asks: 0, approved: 0, denied: 0, argSamples: [] };
      byTool.set(toolName, agg);
    }
    return agg;
  };

  // First pass: tool_use inputs → operative-arg sample bank per tool.
  for (const session of sessions) {
    for (const obj of session.objects) {
      const tu = payloadOf(obj, "tool_use");
      if (tu === undefined || typeof tu["name"] !== "string") continue;
      const value = operativeValue(tu["name"], tu["input"]);
      if (value === undefined) continue;
      const agg = get(tu["name"]);
      if (agg.argSamples.length < MAX_ARG_SAMPLES && !agg.argSamples.includes(value)) {
        agg.argSamples.push(value);
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
 * Compile a permission pattern for a tool. When exactly one operative-arg
 * value recurred we emit a tool+arg glob (`Bash(git status)`); a small set of
 * distinct values stays a bare tool glob (a per-value rule set would be noise
 * — the human can tighten). Tools with no operative field (or no samples) get
 * the bare tool name.
 *
 * SAFETY (glob widening): the observed value is a LITERAL the human approved,
 * not a glob the human authored. tool-permission-matcher treats `*`/`?` in an
 * arg-glob as wildcards, so splicing a raw value that contains them would make
 * the suggested rule match unapproved siblings (`Bash(npm run test:*)` matching
 * `Bash(npm run test:PRODUCTION-DELETE)`). We `escapeGlobLiteral` the value so
 * the rule matches ONLY the approved string. A value containing `(`/`)` cannot
 * be represented in the matcher's `Tool(arg)` format (its paren split isn't
 * escape-aware), so we fall back to a bare tool glob rather than emit a rule
 * that misparses — the reviewer can hand-write a tighter one.
 */
export function patternFor(agg: AskAggregate): string {
  if (agg.argSamples.length === 1 && OPERATIVE_ARG_FIELDS[agg.toolName] !== undefined) {
    const value = agg.argSamples[0] as string;
    if (!value.includes("(") && !value.includes(")")) {
      // A single recurring operative value → a precise glob for exactly it,
      // with glob metacharacters neutralised so it matches only the literal.
      return `${agg.toolName}(${escapeGlobLiteral(value)})`;
    }
  }
  return agg.toolName;
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
          ...(pattern.includes("(")
            ? [`derived from a single recurring input: ${pattern}`]
            : agg.argSamples.length > 1
              ? [`inputs varied (${agg.argSamples.length} distinct) — proposing a bare tool grant`]
              : []),
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
    // literals in patternFor, so a `+` line should never trip this.
    const warn = hasUnescapedWildcard(r.pattern) ? " (⚠ wildcard — matches multiple)" : "";
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
