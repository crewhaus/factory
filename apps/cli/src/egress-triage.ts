import type { Spec } from "@crewhaus/spec";
import { type SpecPatch, validatePatch } from "@crewhaus/spec-patch";
import type { AdviceFinding, AdviceSuggestion } from "./advise-rules";

/**
 * AUTOMATION-OPPORTUNITIES.md item 20 — `crewhaus egress review [--propose]`:
 * triage durable egress/boundary history into learned security spec
 * suggestions. Side-effect-free so it is unit-testable, mirroring
 * `advise-rules.ts` (all filesystem access stays in `index.ts`).
 *
 * INPUT (durability, verified 2026-07): egress verdicts are NOW durable —
 * runtime-core's `egressAuditSink` (this branch) appends one `egress_decision`
 * record per NON-PASS verdict to the hash-chained `.crewhaus/audit`, payload
 * `{ sinkId, sinkScope, verdict: "warn"|"block", originsFound[], matchCount }`
 * (lineage summary only, never the raw payload). Rule-based justification
 * denials come from the `permission_justification_evaluated` records the
 * intent gate already writes.
 *
 * OUTPUT: three proposal families, matching the item:
 *
 *   1. Per-sink RELAXATION — sinks that warned ≥ warnRelaxMin times with ZERO
 *      blocks and a single stable origin: the flow is chronic-but-benign, so
 *      the operator may want to whitelist it. EMITTED AS ADVICE TEXT, never a
 *      patch: the natural home is a `security.egressPolicy` block, but that
 *      schema field is RESERVED for the egress-fabric FRs (FR-002/006) — the
 *      spec schema intentionally does NOT carry it today, and
 *      `OPTIMIZABLE_PATHS` lists `["security","egressPolicy"]` on their behalf.
 *      Adding the field here would clobber their ownership, so we coordinate:
 *      the proposal is advice text pointing at where the relaxation will live
 *      once that block ships. (See packages/spec/src/index.ts securityBlock
 *      doc comment: "Do NOT add egressPolicy here".)
 *
 *   2. `security.egressMatcher: semantic` — when warn-noise is HIGH but blocks
 *      are ZERO across sinks, substring matching is over-firing on benign
 *      lineage overlaps; the embedding matcher scores by similarity instead.
 *      ADVICE-ONLY: `["security","egressMatcher"]` is NOT in OPTIMIZABLE_PATHS
 *      (switching the matcher changes detection semantics — a human decision),
 *      so it must never ride `optimize --from-advice`.
 *
 *   3. `security.justification.judge: claude` — when RULE-BASED justification
 *      denials are frequent, the deterministic judge is likely over-denying;
 *      the model-backed judge reasons about intent. `["security","justification"]`
 *      IS whitelisted (cli/managed), so this rides the eval-gated
 *      `optimize --from-advice` apply as a SPEC-PATCH when a spec is present
 *      and the patch validates; otherwise it degrades to advice text.
 */

// -------- durable-record shapes (defensive; opaque JSON on disk) --------

export type EgressDecisionRecord = {
  readonly sinkId: string;
  readonly sinkScope: string;
  readonly verdict: "warn" | "block";
  readonly originsFound: ReadonlyArray<string>;
  readonly matchCount: number;
};

/** Per (sink, origin, scope) cluster of egress records. */
export type EgressCluster = {
  readonly sinkId: string;
  readonly sinkScope: string;
  /** Origins observed across this sink's non-pass records, deduped + sorted. */
  readonly origins: ReadonlyArray<string>;
  readonly warned: number;
  readonly blocked: number;
  /** Total records folded into this cluster. */
  readonly total: number;
};

export type EgressTriageContext = {
  /** Non-pass egress clusters keyed by sinkId, ranked by (blocked, warned). */
  readonly clusters: ReadonlyArray<EgressCluster>;
  /** Total warn / block records across all sinks (the matcher-noise signal). */
  readonly totalWarned: number;
  readonly totalBlocked: number;
  /** Rule-based justification denials — the judge-upgrade signal. */
  readonly ruleBasedDenials: number;
  readonly ruleBasedEvaluated: number;
  /** Egress records parsed; malformed/other kinds skipped. */
  readonly egressRecords: number;
};

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Fold parsed `.crewhaus/audit` records into the triage context. Tolerant of
 * malformed/unknown records (skipped). Reads two kinds:
 *   - `egress_decision` → per-sink warn/block clusters + totals
 *   - `permission_justification_evaluated` → rule-based deny counts
 */
export function buildEgressTriageContext(
  auditRecords: ReadonlyArray<unknown>,
): EgressTriageContext {
  type Acc = {
    scope: string;
    origins: Set<string>;
    warned: number;
    blocked: number;
    total: number;
  };
  const bySink = new Map<string, Acc>();
  let totalWarned = 0;
  let totalBlocked = 0;
  let ruleBasedDenials = 0;
  let ruleBasedEvaluated = 0;
  let egressRecords = 0;

  for (const rec of auditRecords) {
    const obj = asObject(rec);
    if (obj === undefined) continue;
    const kind = obj["kind"];

    if (kind === "egress_decision") {
      const p = asObject(obj["payload"]);
      if (p === undefined) continue;
      const verdict = p["verdict"];
      if (verdict !== "warn" && verdict !== "block") continue;
      egressRecords += 1;
      const sinkId = typeof p["sinkId"] === "string" ? p["sinkId"] : "(unknown sink)";
      const scope = typeof p["sinkScope"] === "string" ? p["sinkScope"] : "(unknown scope)";
      const acc = bySink.get(sinkId) ?? {
        scope,
        origins: new Set<string>(),
        warned: 0,
        blocked: 0,
        total: 0,
      };
      if (verdict === "warn") {
        acc.warned += 1;
        totalWarned += 1;
      } else {
        acc.blocked += 1;
        totalBlocked += 1;
      }
      acc.total += 1;
      if (Array.isArray(p["originsFound"])) {
        for (const o of p["originsFound"]) if (typeof o === "string") acc.origins.add(o);
      }
      bySink.set(sinkId, acc);
      continue;
    }

    if (kind === "permission_justification_evaluated") {
      const p = asObject(obj["payload"]);
      if (p === undefined) continue;
      // The rule-based judge stamps judgeModel "rule-based" (justification-gate).
      if (p["judgeModel"] !== "rule-based") continue;
      ruleBasedEvaluated += 1;
      if (p["verdict"] === "deny") ruleBasedDenials += 1;
    }
  }

  const clusters: EgressCluster[] = [...bySink.entries()]
    .map(([sinkId, a]) => ({
      sinkId,
      sinkScope: a.scope,
      origins: [...a.origins].sort(),
      warned: a.warned,
      blocked: a.blocked,
      total: a.total,
    }))
    .sort(
      (x, y) => y.blocked - x.blocked || y.warned - x.warned || x.sinkId.localeCompare(y.sinkId),
    );

  return {
    clusters,
    totalWarned,
    totalBlocked,
    ruleBasedDenials,
    ruleBasedEvaluated,
    egressRecords,
  };
}

// -------- thresholds --------

export type EgressTriageThresholds = {
  /** Warns on ONE sink (with 0 blocks) at/above which a relaxation is proposed. */
  readonly warnRelaxMin: number;
  /** Total warns (with 0 total blocks) at/above which semantic is proposed. */
  readonly semanticWarnMin: number;
  /** Rule-based denials at/above which the claude-judge upgrade is proposed. */
  readonly judgeDenialMin: number;
};

export const DEFAULT_EGRESS_TRIAGE_THRESHOLDS: EgressTriageThresholds = {
  warnRelaxMin: 5,
  semanticWarnMin: 10,
  judgeDenialMin: 5,
};

/** Targets whose schema carries `security.justification` AND for which
 *  `["security","justification"]` is optimizable (rides --from-advice). */
export const JUSTIFICATION_PATCH_TARGETS: ReadonlySet<string> = new Set(["cli", "managed"]);

// -------- helper: patch-or-advice (mirrors advise-rules) --------

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

function specJustificationJudge(spec: Spec | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const security = (spec as unknown as Record<string, unknown>)["security"];
  const just = asObject(security)?.["justification"];
  const judge = asObject(just)?.["judge"];
  return typeof judge === "string" ? judge : undefined;
}

// -------- proposals --------

export type EgressTriageOptions = {
  readonly spec?: Spec;
  readonly thresholds?: Partial<EgressTriageThresholds>;
};

function resolveThresholds(opts?: EgressTriageOptions): EgressTriageThresholds {
  return { ...DEFAULT_EGRESS_TRIAGE_THRESHOLDS, ...(opts?.thresholds ?? {}) };
}

/**
 * Proposal 1 — per-sink relaxation for chronic warn-only flows. ADVICE-ONLY:
 * the relaxation's home (`security.egressPolicy`) is reserved for the egress
 * FRs and does not exist in the schema yet, so we emit guidance rather than a
 * schema-adding patch (coordinate, don't clobber).
 */
export function ruleSinkRelaxation(
  ctx: EgressTriageContext,
  opts?: EgressTriageOptions,
): AdviceFinding[] {
  const t = resolveThresholds(opts);
  const findings: AdviceFinding[] = [];
  for (const c of ctx.clusters) {
    if (c.blocked > 0) continue; // never relax a sink that also blocked
    if (c.warned < t.warnRelaxMin) continue;
    const originList = c.origins.length > 0 ? c.origins.join(", ") : "(unknown)";
    findings.push({
      id: `egress-relax:${c.sinkId}`,
      severity: "info",
      summary: `sink ${c.sinkId} warned ${c.warned}× with 0 blocks (origins: ${originList})`,
      evidence: [
        `${c.warned} warn-tier egress decisions to ${c.sinkId} (scope ${c.sinkScope}), 0 blocks (threshold: ≥${t.warnRelaxMin} warns)`,
        `origins seen: ${originList}`,
      ],
      counts: { warned: c.warned, blocked: c.blocked },
      suggestion: {
        kind: "advice",
        text:
          `The sink \`${c.sinkId}\` has warned repeatedly (${c.warned}×) carrying content from [${originList}] but never had to BLOCK — a chronic-but-benign cross-origin flow. ` +
          `If this flow is intended, relax it per-sink once the \`security.egressPolicy\` block ships (reserved for the egress-fabric FRs; not yet in the spec schema): a per-sink override like \`${c.sinkId}: { ${c.origins[0] ?? "origin"}: pass }\`. ` +
          `Until then, review whether \`${c.sinkId}\` should carry [${originList}] content at all — a durable warn stream is exactly the signal to audit before whitelisting. This is deliberately NOT auto-applied.`,
      },
    });
  }
  return findings;
}

/**
 * Proposal 2 — `security.egressMatcher: semantic` when warn-noise is high but
 * blocks are zero (the substring matcher is over-firing on benign lineage
 * overlaps). ADVICE-ONLY: egressMatcher is not optimizer-whitelisted.
 */
export function ruleSemanticMatcher(
  ctx: EgressTriageContext,
  opts?: EgressTriageOptions,
): AdviceFinding[] {
  const t = resolveThresholds(opts);
  if (ctx.totalBlocked > 0) return []; // real blocks → don't loosen matching
  if (ctx.totalWarned < t.semanticWarnMin) return [];
  const current = asObject((opts?.spec as unknown as Record<string, unknown>)?.["security"])?.[
    "egressMatcher"
  ];
  if (current === "semantic") return []; // already on
  return [
    {
      id: "egress-matcher-semantic",
      severity: "warn",
      summary: `${ctx.totalWarned} warn-tier egress decisions, 0 blocks — substring matcher likely over-firing`,
      evidence: [
        `${ctx.totalWarned} warns across ${ctx.clusters.length} sink(s), 0 blocks (threshold: ≥${t.semanticWarnMin} warns, 0 blocks)`,
        "high warn-noise with zero blocks is the signature of a substring matcher hitting benign lineage overlaps",
      ],
      counts: { warned: ctx.totalWarned, blocked: ctx.totalBlocked },
      suggestion: {
        kind: "advice",
        text: "Set `security.egressMatcher: semantic` in the spec so outbound payloads are scored against tagged data-lineage by cosine similarity instead of verbatim substring — this cuts the false-positive warn stream while keeping the same per-origin/per-sink block policy. Switching matchers changes detection semantics, so it is a human decision (never auto-applied) and needs an embedder wired (`--egress-embedder`).",
      },
    },
  ];
}

/**
 * Proposal 3 — `security.justification.judge: claude` when rule-based denials
 * are frequent. SPEC-PATCH when the spec is a justification-optimizable target
 * and the patch validates (rides `optimize --from-advice`); else advice.
 */
export function ruleJustificationJudgeUpgrade(
  ctx: EgressTriageContext,
  opts?: EgressTriageOptions,
): AdviceFinding[] {
  const t = resolveThresholds(opts);
  if (ctx.ruleBasedDenials < t.judgeDenialMin) return [];
  const spec = opts?.spec;
  if (specJustificationJudge(spec) === "claude") return []; // already upgraded

  const denyRate =
    ctx.ruleBasedEvaluated > 0 ? ctx.ruleBasedDenials / ctx.ruleBasedEvaluated : null;
  const adviceText =
    "The rule-based justification judge denied frequently — the deterministic judge is prone to over-denying legitimate calls whose justification does not lexically match the goal. Set `security.justification.judge: claude` (and optionally `security.justification.model`) so the model-backed judge reasons about intent. This is eval-gated: `optimize --from-advice` applies it only if the eval pass-rate holds.";

  // The whole `security.justification` block is the optimizable path; compose
  // it preserving any existing model selection.
  const existingModel = asObject(
    asObject((spec as unknown as Record<string, unknown>)?.["security"])?.["justification"],
  )?.["model"];
  const value: Record<string, unknown> = { judge: "claude" };
  if (typeof existingModel === "string") value["model"] = existingModel;

  const patch: SpecPatch = {
    target: spec?.target ?? "cli",
    path: ["security", "justification"],
    op: specJustificationJudge(spec) !== undefined ? "replace" : "add",
    value,
    rationale: `egress review: ${ctx.ruleBasedDenials} rule-based justification denials — upgrade to the claude judge`,
  };

  // Gate the patch on a justification-optimizable target; otherwise advice.
  const suggestion =
    spec !== undefined && JUSTIFICATION_PATCH_TARGETS.has(spec.target)
      ? patchOrAdvice(spec, patch, adviceText)
      : { kind: "advice" as const, text: adviceText };

  return [
    {
      id: "justification-judge-upgrade",
      severity: "warn",
      summary: `${ctx.ruleBasedDenials} rule-based justification denials — consider the claude judge`,
      evidence: [
        `${ctx.ruleBasedDenials} of ${ctx.ruleBasedEvaluated} rule-based justification evaluations denied${
          denyRate !== null ? ` (${(denyRate * 100).toFixed(0)}% deny rate)` : ""
        } (threshold: ≥${t.judgeDenialMin} denials)`,
      ],
      counts: { denials: ctx.ruleBasedDenials, evaluated: ctx.ruleBasedEvaluated },
      suggestion,
    },
  ];
}

export const EGRESS_TRIAGE_RULES = [
  ruleSinkRelaxation,
  ruleSemanticMatcher,
  ruleJustificationJudgeUpgrade,
] as const;

/** Run every triage rule and rank: warn before info, then by primary count. */
export function runEgressTriage(
  ctx: EgressTriageContext,
  opts?: EgressTriageOptions,
): AdviceFinding[] {
  const findings = EGRESS_TRIAGE_RULES.flatMap((rule) => rule(ctx, opts));
  const magnitude = (f: AdviceFinding): number =>
    Object.values(f.counts).reduce((max, n) => Math.max(max, n), 0);
  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "warn" ? -1 : 1;
    const diff = magnitude(b) - magnitude(a);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
}

/** One line per finding for the CLI's text mode (mirrors formatFindingLines). */
export function formatEgressFindingLines(f: AdviceFinding): string[] {
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
