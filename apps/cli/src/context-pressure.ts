/**
 * Item 17 (completion) — `crewhaus doctor --context-pressure`: the
 * telemetry-driven tuning loop's report face. The advise rules already
 * turn recovery/compaction telemetry into SpecPatches (the detection
 * half); this module reads the same persisted session events and prints
 * WHERE the pressure is — truncation recoveries, compaction fires per
 * session, the snip-vs-autocompact split — next to the spec's current
 * knobs, and, when the advise thresholds trip, the exact advise/optimize
 * commands that close the loop. A report, not a gate: doctor exits 0.
 *
 * Event vocabulary (runtime-core's `logEvent` kinds):
 *   - `recovery` with `action: "continue"` — emitted exclusively for
 *     max_output_tokens truncations (recovery-engine's taxonomy), so the
 *     continue count IS the truncation-pressure count;
 *   - `compaction` with `kind: "snip" | "autocompact" | "reactive"` —
 *     snips are free (head/tail trim), autocompact + reactive summarize
 *     via a model call. The ratio is only derivable when kind-tagged
 *     events exist (the kind field ships with the events themselves, so
 *     any persisted compaction carries it; "unknown" tolerates foreign
 *     or hand-edited logs).
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv
 * switch on import) following the doctor-checks.ts pattern: pure builders
 * over caller-supplied `SessionEvents`, directly unit-testable.
 */
import type { Spec } from "@crewhaus/spec";
import {
  type AdviceThresholds,
  DEFAULT_ADVICE_THRESHOLDS,
  type SessionEvents,
  payloadOf,
} from "./advise-rules";

/** Default number of most-recent sessions the doctor report scans. */
export const DEFAULT_CONTEXT_PRESSURE_SESSIONS = 20;

export type CompactionKindCounts = {
  readonly snip: number;
  readonly autocompact: number;
  readonly reactive: number;
  /** Compaction events without a recognized `kind` (foreign logs). */
  readonly unknown: number;
};

export type ContextPressureReport = {
  readonly sessionCount: number;
  /** `recovery` events with `action: "continue"` — max_output_tokens
   *  truncations by construction. */
  readonly truncationContinues: number;
  readonly compactionTotal: number;
  readonly sessionsWithCompaction: number;
  /** Mean over ALL scanned sessions (a quiet session counts as 0). */
  readonly avgCompactionsPerSession: number;
  readonly maxCompactionsPerSession: number;
  readonly maxCompactionSessionId?: string;
  readonly compactionKinds: CompactionKindCounts;
  /** snip / (snip + model-backed fires); undefined when no kind-tagged
   *  compaction event was seen (ratio not derivable). */
  readonly snipRatio?: number;
  readonly spec: {
    /** False when no parseable crewhaus.yaml was supplied. */
    readonly present: boolean;
    readonly maxTokens?: number;
    readonly compactionCurate?: boolean;
    readonly compactionDedupeThreshold?: number;
    readonly compactionRelevanceTopK?: number;
  };
  /** Advise-threshold trips: "truncation-pressure" / "compaction-thrash". */
  readonly tripped: ReadonlyArray<string>;
  /** The exact commands to run when any threshold tripped (empty otherwise). */
  readonly commands: ReadonlyArray<string>;
};

/** The commands the report prints when pressure trips — the nightly
 *  advisor composition (advise emits the patches, optimize --from-advice
 *  eval-gates and applies them). */
export const CONTEXT_PRESSURE_COMMANDS: ReadonlyArray<string> = Object.freeze([
  "crewhaus advise --all -o .",
  "crewhaus optimize crewhaus.yaml --from-advice suggestions.json --write-back --dataset eval/dataset.jsonl --graders eval/graders.yaml",
]);

// Narrow accessors over the Spec union (mirrors advise-rules): the fields
// exist on most (not all) targets, so read through an index signature.
function specField<T>(spec: Spec | undefined, key: string): T | undefined {
  if (spec === undefined) return undefined;
  return (spec as unknown as Record<string, unknown>)[key] as T | undefined;
}

/**
 * Fold the persisted session events into the context-pressure report.
 * Every field access is defensive (missing payloads, wrong-typed fields,
 * old-vintage logs all pass through cleanly), matching
 * `buildAdviceContext`'s posture.
 */
export function buildContextPressureReport(
  sessions: ReadonlyArray<SessionEvents>,
  opts: { readonly spec?: Spec; readonly thresholds?: Partial<AdviceThresholds> } = {},
): ContextPressureReport {
  const thresholds: AdviceThresholds = { ...DEFAULT_ADVICE_THRESHOLDS, ...(opts.thresholds ?? {}) };

  let truncationContinues = 0;
  let snip = 0;
  let autocompact = 0;
  let reactive = 0;
  let unknown = 0;
  const compactionsBySession = new Map<string, number>();

  for (const session of sessions) {
    for (const obj of session.objects) {
      const recovery = payloadOf(obj, "recovery");
      if (recovery !== undefined) {
        if (recovery["action"] === "continue") truncationContinues += 1;
        continue;
      }
      const compaction = payloadOf(obj, "compaction");
      if (compaction !== undefined) {
        compactionsBySession.set(
          session.sessionId,
          (compactionsBySession.get(session.sessionId) ?? 0) + 1,
        );
        switch (compaction["kind"]) {
          case "snip":
            snip += 1;
            break;
          case "autocompact":
            autocompact += 1;
            break;
          case "reactive":
            reactive += 1;
            break;
          default:
            unknown += 1;
        }
      }
    }
  }

  let compactionTotal = 0;
  let maxCompactionsPerSession = 0;
  let maxCompactionSessionId: string | undefined;
  for (const [sessionId, count] of compactionsBySession) {
    compactionTotal += count;
    if (count > maxCompactionsPerSession) {
      maxCompactionsPerSession = count;
      maxCompactionSessionId = sessionId;
    }
  }
  const avgCompactionsPerSession = sessions.length === 0 ? 0 : compactionTotal / sessions.length;

  // Ratio of free snips to ALL kind-tagged fires (autocompact + reactive
  // both summarize via a model call). Underivable without tagged events.
  const tagged = snip + autocompact + reactive;
  const snipRatio = tagged > 0 ? snip / tagged : undefined;

  const spec = opts.spec;
  const agent = specField<Record<string, unknown>>(spec, "agent");
  const maxTokens = typeof agent?.["max_tokens"] === "number" ? agent["max_tokens"] : undefined;
  const compactionBlock = specField<Record<string, unknown>>(spec, "compaction");
  const curate =
    typeof compactionBlock?.["curate"] === "boolean" ? compactionBlock["curate"] : undefined;
  const dedupe =
    typeof compactionBlock?.["dedupeThreshold"] === "number"
      ? compactionBlock["dedupeThreshold"]
      : undefined;
  const topK =
    typeof compactionBlock?.["relevanceTopK"] === "number"
      ? compactionBlock["relevanceTopK"]
      : undefined;

  // The SAME thresholds the advise rules fire on — when the report says
  // "tripped", `crewhaus advise` will emit a patch for it.
  const tripped: string[] = [];
  if (truncationContinues >= thresholds.truncationContinues) tripped.push("truncation-pressure");
  if (maxCompactionsPerSession >= thresholds.compactionsPerSession) {
    tripped.push("compaction-thrash");
  }

  return {
    sessionCount: sessions.length,
    truncationContinues,
    compactionTotal,
    sessionsWithCompaction: compactionsBySession.size,
    avgCompactionsPerSession,
    maxCompactionsPerSession,
    ...(maxCompactionSessionId !== undefined ? { maxCompactionSessionId } : {}),
    compactionKinds: { snip, autocompact, reactive, unknown },
    ...(snipRatio !== undefined ? { snipRatio } : {}),
    spec: {
      present: spec !== undefined,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(curate !== undefined ? { compactionCurate: curate } : {}),
      ...(dedupe !== undefined ? { compactionDedupeThreshold: dedupe } : {}),
      ...(topK !== undefined ? { compactionRelevanceTopK: topK } : {}),
    },
    tripped,
    commands: tripped.length > 0 ? [...CONTEXT_PRESSURE_COMMANDS] : [],
  };
}

/** One-screen report, printed by `doctor --context-pressure`. */
export function formatContextPressureLines(report: ContextPressureReport): string[] {
  const lines: string[] = ["── context-pressure report ──────────────────────"];
  lines.push(`sessions scanned:      ${report.sessionCount} (most recent)`);
  lines.push(`truncation recoveries: ${report.truncationContinues} max_output_tokens continue(s)`);
  const maxNote =
    report.maxCompactionSessionId !== undefined
      ? `, max ${report.maxCompactionsPerSession} in ${report.maxCompactionSessionId}`
      : "";
  lines.push(
    `compaction fires:      ${report.compactionTotal} across ${report.sessionsWithCompaction} session(s) ` +
      `(avg ${report.avgCompactionsPerSession.toFixed(1)}/session${maxNote})`,
  );
  if (report.snipRatio !== undefined) {
    const k = report.compactionKinds;
    lines.push(
      `snip vs autocompact:   ${k.snip} snip / ${k.autocompact} autocompact / ${k.reactive} reactive ` +
        `(${(report.snipRatio * 100).toFixed(0)}% free snips)`,
    );
  } else {
    lines.push("snip vs autocompact:   not derivable (no kind-tagged compaction events)");
  }
  if (!report.spec.present) {
    lines.push("spec:                  no parseable crewhaus.yaml in cwd");
  } else {
    lines.push(
      `spec agent.max_tokens: ${
        report.spec.maxTokens !== undefined
          ? report.spec.maxTokens
          : "not set (runtime default 8192)"
      }`,
    );
    const curate =
      report.spec.compactionCurate === true
        ? "on"
        : report.spec.compactionCurate === false
          ? "off (explicit)"
          : "off (default)";
    const curatorKnobs = [
      ...(report.spec.compactionDedupeThreshold !== undefined
        ? [`dedupeThreshold ${report.spec.compactionDedupeThreshold}`]
        : []),
      ...(report.spec.compactionRelevanceTopK !== undefined
        ? [`relevanceTopK ${report.spec.compactionRelevanceTopK}`]
        : []),
    ];
    lines.push(
      `spec compaction.curate: ${curate}${curatorKnobs.length > 0 ? ` (${curatorKnobs.join(", ")})` : ""}`,
    );
  }
  if (report.tripped.length === 0) {
    lines.push("pressure:              healthy — no advise thresholds tripped");
  } else {
    lines.push(`pressure:              ${report.tripped.join(", ")} tripped`);
    lines.push("next:");
    for (const cmd of report.commands) {
      lines.push(`  ${cmd}`);
    }
  }
  lines.push("─────────────────────────────────────────────────");
  return lines;
}
