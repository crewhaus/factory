/**
 * Item 14 — `crewhaus advise` rule library: the pure, side-effect-free half
 * of the trace-mining spec advisor. Aggregates session JSONLs (including the
 * advisor kinds runtime-core now persists — `recovery`, `tool_stats`,
 * `permission`, `model_meta`) plus `.crewhaus/audit` records into an
 * `AdviceContext`, then runs a library of threshold rules over it. Each rule
 * returns typed findings whose suggestion is either a pre-validated
 * `SpecPatch` (consumable by a future `optimize --from-advice`) or free-form
 * advice text.
 *
 * Everything here is pure so it is unit-testable; all filesystem access
 * lives in `apps/cli/src/index.ts` (mirrors `feedback.ts` / `eval-history.ts`).
 *
 * Old-vintage logs (written before the advisor kinds existed) build an empty
 * context slice for each missing kind and simply produce no findings — the
 * rules only fire where the data now exists.
 */
import type { Spec } from "@crewhaus/spec";
import { type SpecPatch, validatePatch } from "@crewhaus/spec-patch";

// -------- findings --------

export type AdviceSeverity = "info" | "warn";

export type AdviceSuggestion =
  | { readonly kind: "spec-patch"; readonly patch: SpecPatch }
  | { readonly kind: "advice"; readonly text: string };

export type AdviceFinding = {
  /** `<rule>` or `<rule>:<subject>` (e.g. `repeated-tool-failures:Fetch`). */
  readonly id: string;
  readonly severity: AdviceSeverity;
  /** One-line human summary of what tripped. */
  readonly summary: string;
  /** Human-readable evidence lines (counts, rates, example subjects). */
  readonly evidence: ReadonlyArray<string>;
  /** The numeric aggregates the rule fired on. */
  readonly counts: Readonly<Record<string, number>>;
  readonly suggestion: AdviceSuggestion;
};

// -------- context --------

export type ToolCallStats = {
  calls: number;
  errors: number;
  totalDurationMs: number;
};

export type AskStats = { asks: number; approved: number; denied: number };

/** Item 19 — per-errorName recovery aggregate: total occurrences plus the
 *  distribution of recovery actions that error drove. */
export type ErrorRecoveryStats = {
  count: number;
  /** action (`retry`/`compact`/`continue`/`tombstone`/`fail`) → occurrences. */
  actions: Map<string, number>;
};

/**
 * Session-derived aggregates the rules consume. Built by
 * `buildAdviceContext` from parsed session-JSONL objects (tolerant of
 * old-vintage logs, malformed lines, and unknown kinds) plus optional
 * `.crewhaus/audit` records.
 */
export type AdviceContext = {
  readonly sessionIds: ReadonlyArray<string>;
  /** Per-tool aggregate over `tool_stats` lines. */
  readonly toolStats: ReadonlyMap<string, ToolCallStats>;
  /** `recovery` lines grouped by action (`retry`/`compact`/`continue`/…). */
  readonly recoveriesByAction: ReadonlyMap<string, number>;
  /**
   * Item 19 — `recovery` lines grouped by `errorName`, each carrying the
   * action distribution that error drove. The failure-taxonomy rule clusters
   * these into draft `failure_taxonomy` entries (error class → recovery
   * action). Old-vintage logs (no recovery lines) leave this empty.
   */
  readonly recoveriesByErrorName: ReadonlyMap<string, ErrorRecoveryStats>;
  /**
   * `action: "continue"` recoveries — emitted exclusively for
   * `max_output_tokens` truncations (recovery-engine's taxonomy), so this
   * IS the truncation-pressure count.
   */
  readonly truncationContinues: number;
  /**
   * Item 19 — synthetic `[runtime] possible loop detected` nudges mined from
   * `user_message` lines, grouped by tool signature. `matchNamedFailure`
   * matches error.message only, so a loop (which is NOT an error — no
   * exception is thrown) can never be caught by a taxonomy entry; the
   * loop-break rule turns recurring signatures into instructions-addendum
   * advice instead.
   */
  readonly loopSignatures: ReadonlyMap<string, number>;
  /** `compaction` lines per session (any vintage — this kind predates item 14). */
  readonly compactionsBySession: ReadonlyMap<string, number>;
  /** Resolved permission asks per tool, from `permission` lines. */
  readonly asksByTool: ReadonlyMap<string, AskStats>;
  /** Stop-reason distribution over `model_meta` lines. */
  readonly stopReasons: ReadonlyMap<string, number>;
  readonly modelResponses: number;
  /** `.crewhaus/audit` record kinds → counts (report context + future rules). */
  readonly auditKindCounts: ReadonlyMap<string, number>;
};

export type SessionEvents = {
  readonly sessionId: string;
  readonly objects: ReadonlyArray<unknown>;
};

/** Parse a JSONL blob into objects, skipping blank/malformed lines —
 *  a session log must never abort mining over one corrupt line. */
export function parseJsonlObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip: a malformed line carries no advisory signal.
    }
  }
  return out;
}

type LoggedLine = { kind?: unknown; payload?: unknown };

/** The fixed prefix the runtime stamps on a loop-detection nudge (a
 *  `user_message` with `synthetic: true`). Exported so a fixture/test can
 *  build a realistic nudge without hard-coding the string twice. */
export const LOOP_NUDGE_PREFIX = "[runtime] possible loop detected:";

/** Matches the looping tool name inside a loop-detection nudge string. */
const LOOP_TOOL_RE = /tool "([^"]+)"/;

/**
 * Item 19 — extract a loop signature (the looping tool name) from a
 * `user_message` payload's `content` when it is a runtime loop-detection
 * nudge, else undefined. The nudge content is the fixed string
 * `[runtime] possible loop detected: tool "<name>" has been called …`.
 * Returns `tool:<name>` so recurring loops on the same tool cluster; falls
 * back to a generic `loop` signature when the tool name can't be parsed.
 */
export function loopSignatureOf(content: unknown): string | undefined {
  if (typeof content !== "string" || !content.startsWith(LOOP_NUDGE_PREFIX)) return undefined;
  const m = LOOP_TOOL_RE.exec(content);
  return m?.[1] !== undefined ? `tool:${m[1]}` : "loop";
}

/** Tolerantly read a session-JSONL line's payload when its `kind` matches —
 *  the canonical defensive accessor shared with `context-pressure.ts`
 *  (`doctor --context-pressure` folds the same persisted events). */
export function payloadOf(obj: unknown, kind: string): Record<string, unknown> | undefined {
  if (obj === null || typeof obj !== "object") return undefined;
  const line = obj as LoggedLine;
  if (line.kind !== kind) return undefined;
  if (line.payload === null || typeof line.payload !== "object") return undefined;
  return line.payload as Record<string, unknown>;
}

/**
 * Fold parsed session objects (and optional audit records) into the
 * aggregates the rules consume. Every field access is defensive: missing
 * payloads, wrong-typed fields, and unknown kinds are skipped, so
 * old-vintage logs (no advisor kinds) and future kinds both pass through
 * cleanly.
 */
export function buildAdviceContext(
  sessions: ReadonlyArray<SessionEvents>,
  auditObjects: ReadonlyArray<unknown> = [],
): AdviceContext {
  const toolStats = new Map<string, ToolCallStats>();
  const recoveriesByAction = new Map<string, number>();
  const recoveriesByErrorName = new Map<string, ErrorRecoveryStats>();
  const compactionsBySession = new Map<string, number>();
  const asksByTool = new Map<string, AskStats>();
  const stopReasons = new Map<string, number>();
  const loopSignatures = new Map<string, number>();
  let truncationContinues = 0;
  let modelResponses = 0;

  for (const session of sessions) {
    for (const obj of session.objects) {
      const tool = payloadOf(obj, "tool_stats");
      if (tool !== undefined && typeof tool["toolName"] === "string") {
        const s = toolStats.get(tool["toolName"]) ?? {
          calls: 0,
          errors: 0,
          totalDurationMs: 0,
        };
        s.calls += 1;
        if (tool["isError"] === true) s.errors += 1;
        if (typeof tool["durationMs"] === "number") s.totalDurationMs += tool["durationMs"];
        toolStats.set(tool["toolName"], s);
        continue;
      }
      const recovery = payloadOf(obj, "recovery");
      if (recovery !== undefined && typeof recovery["action"] === "string") {
        const action = recovery["action"];
        recoveriesByAction.set(action, (recoveriesByAction.get(action) ?? 0) + 1);
        if (action === "continue") truncationContinues += 1;
        // Item 19 — cluster by errorName for the failure-taxonomy rule.
        if (typeof recovery["errorName"] === "string" && recovery["errorName"].length > 0) {
          const errorName = recovery["errorName"];
          const stats = recoveriesByErrorName.get(errorName) ?? { count: 0, actions: new Map() };
          stats.count += 1;
          stats.actions.set(action, (stats.actions.get(action) ?? 0) + 1);
          recoveriesByErrorName.set(errorName, stats);
        }
        continue;
      }
      // Item 19 — synthetic loop-detection nudges are `user_message` lines
      // whose content starts with the runtime's fixed prefix; group by the
      // tool signature so a recurring loop on the same tool clusters.
      const userMsg = payloadOf(obj, "user_message");
      if (userMsg !== undefined) {
        const signature = loopSignatureOf(userMsg["content"]);
        if (signature !== undefined) {
          loopSignatures.set(signature, (loopSignatures.get(signature) ?? 0) + 1);
        }
        continue;
      }
      const compaction = payloadOf(obj, "compaction");
      if (compaction !== undefined) {
        compactionsBySession.set(
          session.sessionId,
          (compactionsBySession.get(session.sessionId) ?? 0) + 1,
        );
        continue;
      }
      const permission = payloadOf(obj, "permission");
      if (
        permission !== undefined &&
        typeof permission["toolName"] === "string" &&
        permission["decision"] === "ask"
      ) {
        const ask = asksByTool.get(permission["toolName"]) ?? {
          asks: 0,
          approved: 0,
          denied: 0,
        };
        ask.asks += 1;
        if (permission["askOutcome"] === "approved") ask.approved += 1;
        if (permission["askOutcome"] === "denied") ask.denied += 1;
        asksByTool.set(permission["toolName"], ask);
        continue;
      }
      const meta = payloadOf(obj, "model_meta");
      if (meta !== undefined && typeof meta["stopReason"] === "string") {
        modelResponses += 1;
        stopReasons.set(meta["stopReason"], (stopReasons.get(meta["stopReason"]) ?? 0) + 1);
      }
    }
  }

  const auditKindCounts = new Map<string, number>();
  for (const obj of auditObjects) {
    if (obj === null || typeof obj !== "object") continue;
    const kind = (obj as { kind?: unknown }).kind;
    if (typeof kind !== "string") continue;
    auditKindCounts.set(kind, (auditKindCounts.get(kind) ?? 0) + 1);
  }

  return {
    sessionIds: sessions.map((s) => s.sessionId),
    toolStats,
    recoveriesByAction,
    recoveriesByErrorName,
    truncationContinues,
    loopSignatures,
    compactionsBySession,
    asksByTool,
    stopReasons,
    modelResponses,
    auditKindCounts,
  };
}

// -------- thresholds --------

export type AdviceThresholds = {
  /** Minimum calls before a tool's error rate is judged at all. */
  toolFailureMinCalls: number;
  /** Error rate (errors/calls) at/above which the failure rule fires. */
  toolFailureRate: number;
  /** `continue` recoveries at/above which truncation pressure fires. */
  truncationContinues: number;
  /** Compactions in a single session at/above which thrash fires. */
  compactionsPerSession: number;
  /** Resolved asks per tool at/above which churn is judged. */
  asksPerTool: number;
  /** Minimum model responses before stop reasons are judged at all. */
  stopMinResponses: number;
  /** Anomalous-stop rate at/above which the stop rule fires. */
  stopAnomalyRate: number;
  /** Item 19 — occurrences of one error CLASS at/above which a
   *  failure_taxonomy entry is drafted. */
  recoveryClusterMin: number;
  /** Item 19 — occurrences of one loop SIGNATURE at/above which loop-break
   *  instructions advice fires. */
  loopSignatureMin: number;
};

/**
 * Canonical rule thresholds. runtime-core's in-run digest
 * (observability.ts DIGEST_THRESHOLDS) mirrors these — it cannot import
 * them (apps/cli depends on runtime-core, not vice versa), so keep the two
 * in sync when tuning.
 */
export const DEFAULT_ADVICE_THRESHOLDS: AdviceThresholds = {
  toolFailureMinCalls: 5,
  toolFailureRate: 0.5,
  truncationContinues: 2,
  compactionsPerSession: 3,
  asksPerTool: 3,
  stopMinResponses: 4,
  stopAnomalyRate: 0.25,
  recoveryClusterMin: 3,
  loopSignatureMin: 2,
};

/** Stop reasons that are part of healthy operation; everything else
 *  (max_tokens, refusal, pause_turn, …) counts as anomalous. Mirrored by
 *  runtime-core's digest tally. */
export const CLEAN_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "tool_use",
  "stop_sequence",
]);

export type RuleOptions = {
  /** The cwd spec, when one exists — enables patch suggestions. */
  readonly spec?: Spec;
  readonly thresholds?: Partial<AdviceThresholds>;
};

export type AdviceRule = (ctx: AdviceContext, opts?: RuleOptions) => AdviceFinding[];

function resolveThresholds(opts?: RuleOptions): AdviceThresholds {
  return { ...DEFAULT_ADVICE_THRESHOLDS, ...(opts?.thresholds ?? {}) };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

// Narrow accessors over the Spec union — the fields exist on most (not all)
// targets, so read through an index signature rather than per-target casts.
function specField<T>(spec: Spec | undefined, key: string): T | undefined {
  if (spec === undefined) return undefined;
  return (spec as unknown as Record<string, unknown>)[key] as T | undefined;
}

function agentMaxTokens(spec: Spec | undefined): number | undefined {
  const agent = specField<Record<string, unknown>>(spec, "agent");
  const value = agent?.["max_tokens"];
  return typeof value === "number" ? value : undefined;
}

function toolConfigFor(spec: Spec | undefined, toolName: string): unknown {
  const cfg = specField<Record<string, unknown>>(spec, "tool_config");
  return cfg?.[toolName];
}

/** Wrap a candidate patch: keep it when `validatePatch` accepts it against
 *  the spec, otherwise fall back to the advice text. EVERY patch the rules
 *  emit goes through here — the OPTIMIZABLE_PATHS whitelist stays the
 *  single safety floor even if a rule drifts. */
function patchOrAdvice(
  spec: Spec | undefined,
  patch: SpecPatch,
  fallback: string,
): AdviceSuggestion {
  if (spec === undefined) return { kind: "advice", text: fallback };
  try {
    validatePatch(spec, patch);
    return { kind: "spec-patch", patch };
  } catch {
    return { kind: "advice", text: fallback };
  }
}

// -------- rules --------

/**
 * Repeated tool failures: a tool with ≥ minCalls whose error rate crosses
 * the threshold. Advice-only by design — `tool_config` is not in
 * OPTIMIZABLE_PATHS (the whitelist is the autotune safety floor), so the
 * suggestion points at the spec's `tool_config` block when one exists for
 * the tool instead of emitting a patch. NOTE: `tool_stats.isError` includes
 * permission-denied results; the churn rule covers the ask side of that.
 */
export const ruleRepeatedToolFailures: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  const findings: AdviceFinding[] = [];
  for (const [tool, s] of ctx.toolStats) {
    if (s.calls < t.toolFailureMinCalls) continue;
    const rate = s.errors / s.calls;
    if (rate < t.toolFailureRate) continue;
    const hasConfig = toolConfigFor(opts?.spec, tool) !== undefined;
    const configNote = hasConfig
      ? ` The spec has a \`tool_config.${tool}\` block — review its knobs (timeouts, limits) before swapping the tool.`
      : "";
    findings.push({
      id: `repeated-tool-failures:${tool}`,
      severity: "warn",
      summary: `tool ${tool} failed ${s.errors}/${s.calls} calls (${pct(rate)})`,
      evidence: [
        `${s.errors} of ${s.calls} ${tool} calls returned is_error (threshold: ≥${t.toolFailureMinCalls} calls at ≥${pct(t.toolFailureRate)})`,
        `mean duration ${s.calls > 0 ? Math.round(s.totalDurationMs / s.calls) : 0}ms per call`,
      ],
      counts: { calls: s.calls, errors: s.errors },
      suggestion: {
        kind: "advice",
        text:
          `Investigate why ${tool} keeps failing (bad inputs from the model, an unreachable backend, or permission denials) ` +
          `or swap it for an alternative tool.${configNote}`,
      },
    });
  }
  return findings;
};

/**
 * Truncation pressure: `continue` recoveries (always max_output_tokens) at
 * or above the threshold. Suggests a SpecPatch bumping `agent.max_tokens`
 * (whitelisted in OPTIMIZABLE_PATHS): double the spec's current value, or
 * add 16384 (2× the runtime's 8192 default) when the spec doesn't set one.
 */
export const ruleTruncationPressure: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  if (ctx.truncationContinues < t.truncationContinues) return [];
  const spec = opts?.spec;
  const current = agentMaxTokens(spec);
  const proposed = current !== undefined ? Math.min(current * 2, 32768) : 16384;
  const adviceText = `Responses are being cut off by the per-turn output-token cap. Raise agent.max_tokens in the spec (e.g. to ${proposed}) so long tool calls and multi-file edits complete in one turn.`;
  const patch: SpecPatch = {
    target: spec?.target ?? "cli",
    path: ["agent", "max_tokens"],
    op: current !== undefined ? "replace" : "add",
    value: proposed,
    rationale: `advise: ${ctx.truncationContinues} max_output_tokens truncation recoveries observed`,
  };
  return [
    {
      id: "truncation-pressure",
      severity: "warn",
      summary: `${ctx.truncationContinues} max_output_tokens truncation recoveries`,
      evidence: [
        `${ctx.truncationContinues} recovery events with action=continue (threshold: ≥${t.truncationContinues})`,
        current !== undefined
          ? `spec sets agent.max_tokens: ${current}`
          : "spec does not set agent.max_tokens (runtime default 8192)",
      ],
      counts: { truncationContinues: ctx.truncationContinues },
      suggestion: patchOrAdvice(spec, patch, adviceText),
    },
  ];
};

/**
 * Compaction thrash: any single session compacting ≥ threshold times.
 * ADVICE-ONLY — no auto-applicable SpecPatch. `compaction.curate` is listed
 * in OPTIMIZABLE_PATHS and lowers to IR (`packages/ir/src/index.ts`,
 * `IrCompaction.curate`), but no target emitter or runtime-core path
 * actually consumes it yet (see the IR field's doc comment). A patch that
 * flips a runtime no-op would pass the `optimize --from-advice` eval gate
 * trivially (inert change → equal pass rate) and get written into the
 * user's spec while changing nothing, so this rule surfaces the finding as
 * a warning with concrete alternatives instead of proposing `curate: true`.
 * `compaction.threshold` is ALSO whitelisted, but the strict spec schema
 * carries no such key today, so a threshold patch could never apply either.
 */
export const ruleCompactionThrash: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  let worstSession: string | undefined;
  let worstCount = 0;
  for (const [sessionId, count] of ctx.compactionsBySession) {
    if (count > worstCount) {
      worstCount = count;
      worstSession = sessionId;
    }
  }
  if (worstSession === undefined || worstCount < t.compactionsPerSession) return [];
  const spec = opts?.spec;
  const compaction = specField<Record<string, unknown>>(spec, "compaction");
  const curateOn = compaction?.["curate"] === true;
  const suggestion: AdviceSuggestion = {
    kind: "advice",
    text: curateOn
      ? "compaction.curate is already set but sessions still thrash — that flag is not yet wired at runtime " +
        "(reserved for a future compaction-curator pass), so it will not help. Reduce compaction thrash by " +
        "widening the compaction window, trimming which tools are available (fewer tools per turn means less " +
        "context to summarize), or splitting the work across a sub-agent so each session carries less history."
      : "Sessions are compacting repeatedly, which burns tokens on re-summarization and loses context each " +
        "pass. `compaction.curate` is not yet wired at runtime, so enabling it would not help today. Reduce " +
        "thrash by widening the compaction window, trimming which tools are available (fewer tools per turn " +
        "means less context to summarize), or splitting the work across a sub-agent so each session carries " +
        "less history.",
  };
  return [
    {
      id: "compaction-thrash",
      severity: "warn",
      summary: `session ${worstSession} compacted ${worstCount} times`,
      evidence: [
        `${worstCount} compaction events in session ${worstSession} (threshold: ≥${t.compactionsPerSession})`,
        `${ctx.compactionsBySession.size} session(s) compacted at least once`,
      ],
      counts: { compactions: worstCount, sessionsWithCompaction: ctx.compactionsBySession.size },
      suggestion,
    },
  ];
};

/**
 * Permission churn: a tool prompting ≥ threshold times with 100% approved
 * outcomes. NEVER a patch — permissions are excluded from OPTIMIZABLE_PATHS
 * by design (an optimizer must not be able to widen its own permissions);
 * the human gets the alwaysAllow one-liner with the evidence instead.
 */
export const rulePermissionChurn: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  const findings: AdviceFinding[] = [];
  for (const [tool, a] of ctx.asksByTool) {
    if (a.asks < t.asksPerTool) continue;
    if (a.denied > 0 || a.approved !== a.asks) continue;
    findings.push({
      id: `permission-churn:${tool}`,
      severity: "info",
      summary: `${tool} prompted ${a.asks} times — every ask was approved`,
      evidence: [
        `${a.asks} ask prompts for ${tool}, ${a.approved} approved, 0 denied (threshold: ≥${t.asksPerTool} asks, 100% approved)`,
      ],
      counts: { asks: a.asks, approved: a.approved },
      suggestion: {
        kind: "advice",
        text: `If ${tool} is safe for this agent, add \`{ type: alwaysAllow, pattern: ${tool} }\` to permissions.rules in the spec to stop re-prompting. Permission rules are deliberately NOT auto-patched — review before widening.`,
      },
    });
  }
  return findings;
};

/**
 * Stop-reason anomalies: a high rate of stops outside CLEAN_STOP_REASONS
 * (end_turn / tool_use / stop_sequence are healthy; max_tokens, refusal,
 * pause_turn, … are not). Advice-only — the right fix depends on which
 * reason dominates.
 */
export const ruleStopReasonAnomalies: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  if (ctx.modelResponses < t.stopMinResponses) return [];
  let anomalous = 0;
  const anomalousReasons: string[] = [];
  for (const [reason, count] of ctx.stopReasons) {
    if (CLEAN_STOP_REASONS.has(reason)) continue;
    anomalous += count;
    anomalousReasons.push(`${reason}×${count}`);
  }
  const rate = anomalous / ctx.modelResponses;
  if (rate < t.stopAnomalyRate) return [];
  anomalousReasons.sort();
  return [
    {
      id: "stop-reason-anomalies",
      severity: "warn",
      summary: `${pct(rate)} of model responses stopped abnormally (${anomalousReasons.join(", ")})`,
      evidence: [
        `${anomalous} of ${ctx.modelResponses} responses stopped outside {end_turn, tool_use, stop_sequence} (threshold: ≥${pct(t.stopAnomalyRate)} over ≥${t.stopMinResponses} responses)`,
        `anomalous stop reasons: ${anomalousReasons.join(", ")}`,
      ],
      counts: { anomalous, responses: ctx.modelResponses },
      suggestion: {
        kind: "advice",
        text:
          "Inspect the dominant abnormal stop reason: max_tokens → raise agent.max_tokens or tighten instructions; " +
          "refusal → review what the sessions are asking the model to do; provider-specific reasons → check the adapter/router config.",
      },
    },
  ];
};

// -------- item 19: failure_taxonomy + loop-break rules from telemetry --------

/** The recovery actions a drafted `failure_taxonomy` entry may declare —
 *  exactly the spec's `failureTaxonomyEntrySchema.recovery` enum. */
const TAXONOMY_RECOVERY_ACTIONS: ReadonlySet<string> = new Set([
  "retry",
  "compact",
  "continue",
  "tombstone",
  "fail",
]);

/** One drafted failure_taxonomy entry (shape = the spec's entry schema:
 *  `{ class, pattern, recovery, hint? }`). */
export type FailureTaxonomyEntry = {
  readonly class: string;
  readonly pattern: string;
  readonly recovery: string;
  readonly hint?: string;
};

/** The dominant recovery action observed for an error class (ties broken by
 *  the enum's declared order → deterministic). Falls back to `retry` when the
 *  observed action isn't a valid taxonomy action (e.g. a future action name). */
function dominantRecoveryAction(actions: ReadonlyMap<string, number>): string {
  let best: string | undefined;
  let bestCount = -1;
  for (const action of TAXONOMY_RECOVERY_ACTIONS) {
    const count = actions.get(action) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = action;
    }
  }
  return best ?? "retry";
}

/** Read the spec's existing `failure_taxonomy`, defensively — returns the
 *  entries' `class` strings already covered so a draft never duplicates one. */
function existingTaxonomyClasses(spec: Spec | undefined): Set<string> {
  const covered = new Set<string>();
  const taxonomy = specField<unknown>(spec, "failure_taxonomy");
  if (!Array.isArray(taxonomy)) return covered;
  for (const entry of taxonomy) {
    if (entry !== null && typeof entry === "object") {
      const cls = (entry as { class?: unknown }).class;
      if (typeof cls === "string") covered.add(cls);
    }
  }
  return covered;
}

/**
 * Item 19 — failure-taxonomy learning. Clusters recurring `recovery` events
 * by `errorName`; each class seen ≥ recoveryClusterMin times (and NOT already
 * covered by the spec's taxonomy) becomes a draft `failure_taxonomy` entry
 * whose `recovery` action is the one the runtime actually took most for that
 * class, and whose `pattern` is a case-insensitive substring of the error
 * name.
 *
 * `failure_taxonomy` IS whitelisted in OPTIMIZABLE_PATHS for every target, so
 * the emitted patch rides the eval-gated `optimize --from-advice` apply. The
 * patch REPLACES the whole `failure_taxonomy` array (existing entries +
 * drafts) when the spec already has one, else ADDS the array — a whole-block
 * edit the whitelist's prefix match allows. Budget caps aren't a field on the
 * strict entry schema (`{ class, pattern, recovery, hint? }`), so the drafted
 * `hint` carries the observed count + the "matches error.message" caveat and
 * the recovery-engine's per-turn budget note.
 */
export const ruleFailureTaxonomy: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  const spec = opts?.spec;
  const covered = existingTaxonomyClasses(spec);
  const drafts: FailureTaxonomyEntry[] = [];
  const evidence: string[] = [];
  let clustered = 0;

  // Deterministic: sort clusters by count desc, then errorName.
  const clusters = [...ctx.recoveriesByErrorName.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[0].localeCompare(b[0]);
  });
  for (const [errorName, stats] of clusters) {
    if (stats.count < t.recoveryClusterMin) continue;
    if (covered.has(errorName)) continue;
    const recovery = dominantRecoveryAction(stats.actions);
    drafts.push({
      class: errorName,
      // matchNamedFailure matches error.MESSAGE (substring/regex); the class
      // name is the best available proxy — the error message usually contains
      // it. The reviewer refines to a precise pattern.
      pattern: errorName,
      recovery,
      hint: `observed ${stats.count}× → recovery-engine took "${recovery}" most; refine 'pattern' to a substring of the actual error.message, and note recovery actions are budget-capped per turn (repeated failures still fail-fast)`,
    });
    evidence.push(`${errorName}: ${stats.count} recoveries → draft recovery=${recovery}`);
    clustered += stats.count;
  }

  if (drafts.length === 0) return [];

  // Compose the full array: existing entries (verbatim) + the new drafts.
  const existingArray = Array.isArray(specField<unknown>(spec, "failure_taxonomy"))
    ? (specField<unknown[]>(spec, "failure_taxonomy") as unknown[])
    : [];
  const value = [...existingArray, ...drafts];
  const op: SpecPatch["op"] = existingArray.length > 0 ? "replace" : "add";
  const patch: SpecPatch = {
    target: spec?.target ?? "cli",
    path: ["failure_taxonomy"],
    op,
    value,
    rationale: `advise: ${drafts.length} error class(es) recurred ≥${t.recoveryClusterMin}× — drafted failure_taxonomy entries`,
  };
  const adviceText = `Recurring error classes were recovered from repeatedly (${evidence.join("; ")}). Add failure_taxonomy entries so the runtime handles them deterministically: ${drafts
    .map((d) => `${d.class} → ${d.recovery}`)
    .join(", ")}. Set each 'pattern' to a substring of the real error.message.`;

  return [
    {
      id: "failure-taxonomy-learned",
      severity: "warn",
      summary: `${drafts.length} recurring error class(es) → draft failure_taxonomy`,
      evidence: [
        ...evidence,
        `threshold: ≥${t.recoveryClusterMin} recoveries per class; ${covered.size} class(es) already in the spec were skipped`,
      ],
      counts: { classes: drafts.length, recoveries: clustered },
      suggestion: patchOrAdvice(spec, patch, adviceText),
    },
  ];
};

/**
 * Item 19 — loop-break learning. A `[runtime] possible loop detected` nudge
 * is NOT an error (no exception is thrown), so `matchNamedFailure` — which
 * matches error.message only — can never catch it; a taxonomy entry is the
 * wrong tool. This rule instead drafts an instructions-ADDENDUM as advice
 * text (never a patch: `agent.instructions` IS optimizable, but a
 * mechanically-appended nudge is a prompt edit a human should own, and the
 * optimizer already rewrites instructions on its own signal). Fires per
 * recurring loop signature (same tool looped in ≥ loopSignatureMin sessions/
 * turns).
 */
export const ruleLoopBreak: AdviceRule = (ctx, opts) => {
  const t = resolveThresholds(opts);
  const recurring = [...ctx.loopSignatures.entries()]
    .filter(([, count]) => count >= t.loopSignatureMin)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])));
  if (recurring.length === 0) return [];
  const tools = recurring.map(([sig]) => sig.replace(/^tool:/, ""));
  const evidence = recurring.map(([sig, count]) => `${sig}: ${count} loop nudge(s)`);
  const total = recurring.reduce((sum, [, count]) => sum + count, 0);
  return [
    {
      id: "loop-break",
      severity: "warn",
      summary: `${recurring.length} recurring loop signature(s) (${tools.join(", ")})`,
      evidence: [
        ...evidence,
        `threshold: ≥${t.loopSignatureMin} nudges per signature — loops aren't errors, so a failure_taxonomy entry can't catch them (matchNamedFailure matches error.message only)`,
      ],
      counts: { signatures: recurring.length, nudges: total },
      suggestion: {
        kind: "advice",
        text: `The agent repeatedly looped on: ${tools.join(", ")}. Add an instructions addendum that breaks the loop, e.g.: "If a tool returns the same result twice for the same input, do NOT call it again — change approach or answer from what you already have. Prefer batching related ${tools[0]} calls and reading the results before deciding the next step." This is an instructions edit (a loop isn't an error, so failure_taxonomy can't match it).`,
      },
    },
  ];
};

export const ADVICE_RULES: ReadonlyArray<AdviceRule> = [
  ruleRepeatedToolFailures,
  ruleTruncationPressure,
  ruleCompactionThrash,
  rulePermissionChurn,
  ruleStopReasonAnomalies,
  ruleFailureTaxonomy,
  ruleLoopBreak,
];

/**
 * Run every rule and rank the findings: warn before info, then by the
 * magnitude of the primary count, then by id (deterministic output). Each
 * emitted patch was already pre-validated by its rule via `patchOrAdvice`.
 */
export function runAdviceRules(ctx: AdviceContext, opts?: RuleOptions): AdviceFinding[] {
  const findings = ADVICE_RULES.flatMap((rule) => rule(ctx, opts));
  const magnitude = (f: AdviceFinding): number =>
    Object.values(f.counts).reduce((max, n) => Math.max(max, n), 0);
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "warn" ? -1 : 1;
    const diff = magnitude(b) - magnitude(a);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
}

// -------- artifacts (suggestions.json + HTML report) --------

export type SuggestionsFile = {
  readonly generatedAt: string;
  readonly sessionIds: ReadonlyArray<string>;
  /** Only the findings whose suggestion is a validated SpecPatch. */
  readonly suggestions: ReadonlyArray<{
    readonly findingId: string;
    readonly severity: AdviceSeverity;
    readonly summary: string;
    readonly patch: SpecPatch;
  }>;
};

/** The `suggestions.json` payload — the SpecPatch list a future
 *  `optimize --from-advice` consumes. Advice-only findings are report-only. */
export function buildSuggestionsFile(
  findings: ReadonlyArray<AdviceFinding>,
  sessionIds: ReadonlyArray<string>,
  generatedAt: string,
): SuggestionsFile {
  const suggestions: SuggestionsFile["suggestions"] = findings.flatMap((f) =>
    f.suggestion.kind === "spec-patch"
      ? [{ findingId: f.id, severity: f.severity, summary: f.summary, patch: f.suggestion.patch }]
      : [],
  );
  return { generatedAt, sessionIds, suggestions };
}

// Dependency-free HTML (the eval-report render.ts posture): inline style,
// no script, everything user-derived escaped.
const REPORT_STYLE = `
:root { --bg: #0f1115; --fg: #e6e6e6; --muted: #999; --warn: #ffb74d; --info: #61dafb; --card: #1a1d23; --border: #333; }
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 24px; line-height: 1.5; }
h1 { margin: 0 0 8px; }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.finding { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin: 12px 0; }
.finding h2 { margin: 0 0 8px; font-size: 16px; }
.sev { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; border-radius: 4px; padding: 2px 8px; margin-right: 8px; }
.sev.warn { background: rgba(255, 183, 77, 0.15); color: var(--warn); }
.sev.info { background: rgba(97, 218, 251, 0.15); color: var(--info); }
ul.evidence { margin: 8px 0; padding-left: 20px; color: var(--muted); font-size: 13px; }
pre { background: #0a0c10; padding: 12px; overflow-x: auto; border-radius: 4px; font-size: 12px; line-height: 1.4; }
.advice { font-size: 14px; }
.healthy { color: var(--muted); }
`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findingHtml(f: AdviceFinding): string {
  const evidence = f.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
  const suggestion =
    f.suggestion.kind === "spec-patch"
      ? `<pre>${escapeHtml(JSON.stringify(f.suggestion.patch, null, 2))}</pre>`
      : `<p class="advice">${escapeHtml(f.suggestion.text)}</p>`;
  return `<section class="finding">
<h2><span class="sev ${f.severity}">${f.severity}</span>${escapeHtml(f.id)}</h2>
<p>${escapeHtml(f.summary)}</p>
<ul class="evidence">${evidence}</ul>
${suggestion}
</section>`;
}

/** Self-contained `report.html` for `crewhaus advise` — ranked findings with
 *  evidence and the suggested patch/advice per finding. */
export function renderAdviceHtml(input: {
  readonly findings: ReadonlyArray<AdviceFinding>;
  readonly sessionIds: ReadonlyArray<string>;
  readonly generatedAt: string;
}): string {
  const body =
    input.findings.length === 0
      ? `<p class="healthy">No findings — the mined sessions look healthy.</p>`
      : input.findings.map(findingHtml).join("\n");
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>crewhaus advise</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<h1>crewhaus advise</h1>
<p class="meta">${input.findings.length} finding(s) across ${input.sessionIds.length} session(s) · generated ${escapeHtml(input.generatedAt)}</p>
${body}
</body></html>`;
}

/** One line per finding for the CLI's text mode. */
export function formatFindingLines(f: AdviceFinding): string[] {
  const lines = [`[${f.severity}] ${f.id} — ${f.summary}`];
  for (const e of f.evidence) lines.push(`  · ${e}`);
  if (f.suggestion.kind === "spec-patch") {
    const p = f.suggestion.patch;
    lines.push(`  patch: ${p.op} ${p.path.join(".")} → ${JSON.stringify(p.value)}`);
  } else {
    lines.push(`  advice: ${f.suggestion.text}`);
  }
  return lines;
}
