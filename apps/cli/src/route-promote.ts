/**
 * `crewhaus route promote [--gate]` — 0.6.0 §6.3 (PR 14).
 *
 * The observe-only routing lanes (`q:<band>` from the offline
 * `watchme report --feed-routing` join, `shadow:<scope>/<band>` from the
 * online `strategy.shadow` audition) exist so quality can be MEASURED without
 * steering a live decision: the runtime router mints neither prefix and reads
 * neither back, and PR 9d/PR 10 settled that committee and shadow member arms
 * never fold into live arms on their own. `route promote` is the one
 * sanctioned path out of the lane — and because folding an audition into the
 * live arms changes which model serves, it is gated and audited.
 *
 * THE GATE. A promotion is admissible only when the routing it is about to
 * change was measured the way §6.1 measures routing:
 *
 *   1. the newest recorded eval run for the spec routed `as-declared` — the
 *      whole roster, what production actually serves (a `candidate:` run pins
 *      one arm and says nothing about the policy);
 *   2. it pinned `model_pool.learning.seed` and routed off a FROZEN arm
 *      snapshot (`armsDigest`), so the measurement is replayable and could
 *      not move the harness's own learned policy;
 *   3. the snapshot was WARM (`--warm-arms`) — a cold snapshot answers n=0 for
 *      every arm, which makes the learned policy degenerate to the first
 *      under-sampled candidate and measures nothing about the arms being
 *      promoted;
 *   4. it is a complete, live measurement — never a budget-aborted `partial`
 *      run and never a cassette `replayed` one; and
 *   5. it PASSED `gateRuns` against its own lineage's pinned baseline. A
 *      lineage whose baseline is the run's own only comparison (§6.1's
 *      "V2 key absent but legacy key present") is refused outright — the run
 *      that creates a lineage must never satisfy its own gate.
 *
 * `--gate` mirrors `crewhaus eval --gate`: it only decides whether a refusal
 * maps to a non-zero EXIT. The fold itself is refused without a passing gate
 * either way — that is the safety property, not a flag.
 *
 * THE FREEZE COMES FIRST. §6.3 closes with `route reset` and `route freeze`
 * as the kill switches for exactly this feedback loop, and a freeze means
 * "no new observation moves an arm" — so an operator who pinned the policy
 * after a routing incident must not have live arms moved underneath the pin
 * by a scheduled promotion. `runRoutePromote` reads
 * `<root>/routing/freeze.json` BEFORE it resolves the gate and refuses
 * outright; `promoteLanes` refuses again beneath it, so a library caller
 * cannot bypass the switch either.
 */
import { join } from "node:path";
import type { AuditKind } from "@crewhaus/audit-log";
import {
  type BaselineEntry,
  type LoadedRun,
  type RunIndexEntry,
  lineageOfEntry,
  loadRun as loadRunFromDisk,
  readRunIndexLatest,
  resolveBaseline,
} from "@crewhaus/eval-report";
import type { EvalRoutingMode } from "@crewhaus/eval-runner";
import { type PromoteResult, promoteLanes, readRouteFreeze } from "@crewhaus/routing-store";
import { gateRuns } from "./eval-history";

/** The verdict on whether a promotion is authorized, and by which run. */
export type PromotionGate = {
  /** True only when a routed run passed its baseline gate. */
  readonly passed: boolean;
  /** Why it passed, or exactly what is missing. Printed verbatim. */
  readonly reason: string;
  readonly specName?: string;
  readonly datasetName?: string;
  readonly candidateRunId?: string;
  readonly baselineRunId?: string;
  readonly routing?: EvalRoutingMode;
  readonly armsDigest?: string;
  readonly policyVersion?: string;
  readonly learningSeed?: string;
  /** Non-blocking notes (e.g. the live arms moved while the run was in flight). */
  readonly warnings: readonly string[];
};

export type ResolveGateOptions = {
  /** `.crewhaus/evals` (or a tenant scope). */
  readonly evalsDir: string;
  /** Only consider runs of this spec; absent ⇒ the newest routed run of any spec. */
  readonly specName?: string;
  /** Injected for tests; defaults to `@crewhaus/eval-report`'s disk loader. */
  readonly loadRun?: (idOrPath: string) => Promise<LoadedRun>;
  /** Injected for tests; defaults to reading `<evalsDir>/index.jsonl`. */
  readonly readIndex?: (evalsDir: string) => RunIndexEntry[];
  /** Injected for tests; defaults to reading `<evalsDir>/baselines.json`. */
  readonly resolveBaseline?: (
    entry: RunIndexEntry,
    evalsDir: string,
  ) => { readonly entry?: BaselineEntry; readonly legacyPresent: boolean };
};

const refuse = (reason: string, extra: Partial<PromotionGate> = {}): PromotionGate => ({
  passed: false,
  reason,
  warnings: [],
  ...extra,
});

/**
 * Resolve whether a routed eval authorizes a promotion. Pure apart from the
 * injected readers, so the refusal path is unit-testable without a run dir.
 */
export async function resolveRoutePromotionGate(opts: ResolveGateOptions): Promise<PromotionGate> {
  const readIndex = opts.readIndex ?? readRunIndexLatest;
  const load = opts.loadRun ?? loadRunFromDisk;
  const resolve =
    opts.resolveBaseline ??
    ((entry: RunIndexEntry, evalsDir: string) => resolveBaseline(lineageOfEntry(entry), evalsDir));

  const forSpec = (e: RunIndexEntry): boolean =>
    opts.specName === undefined || e.specName === opts.specName;
  const routed = readIndex(opts.evalsDir).filter((e) => e.routing === "as-declared" && forSpec(e));
  const scope = opts.specName !== undefined ? ` for spec "${opts.specName}"` : "";
  if (routed.length === 0) {
    return refuse(
      `no \`routing: as-declared\` eval run is recorded${scope} — run \`crewhaus eval <spec> --routing as-declared --warm-arms --gate\` first, so the promotion is authorized by a measurement of what production serves`,
    );
  }
  // Newest by completion timestamp; the index is append-ordered but a resumed
  // run supersedes in place, so compare the stamps rather than trusting order.
  const candidate = routed.reduce((newest, e) =>
    Date.parse(e.ts) >= Date.parse(newest.ts) ? e : newest,
  );
  const ident = {
    specName: candidate.specName,
    datasetName: candidate.datasetName,
    candidateRunId: candidate.runId,
    routing: candidate.routing,
    ...(candidate.armsDigest !== undefined ? { armsDigest: candidate.armsDigest } : {}),
    ...(candidate.policyVersion !== undefined ? { policyVersion: candidate.policyVersion } : {}),
  };
  if (candidate.partial === true) {
    return refuse(
      `the newest routed run ${candidate.runId} was budget-aborted (partial) — an incomplete measurement cannot authorize a promotion`,
      ident,
    );
  }
  if (candidate.replayed === true) {
    return refuse(
      `the newest routed run ${candidate.runId} replayed recorded tool cassettes — it measures the agent's reasoning, not the live system, so it cannot authorize a promotion`,
      ident,
    );
  }

  let candidateRun: LoadedRun;
  try {
    candidateRun = await load(candidate.outDir);
  } catch (err) {
    return refuse(
      `could not load the routed run ${candidate.runId} (${err instanceof Error ? err.message : String(err)})`,
      ident,
    );
  }
  const manifest = candidateRun.summary.config.routing;
  if (manifest === undefined || manifest.mode !== "as-declared") {
    return refuse(
      `run ${candidate.runId} is indexed as routed but its results.json carries no \`as-declared\` routing manifest — re-run the eval with \`--routing as-declared\``,
      ident,
    );
  }
  const learningSeed = manifest.learningSeed;
  const withSeed = { ...ident, ...(learningSeed !== undefined ? { learningSeed } : {}) };
  if (learningSeed === undefined) {
    return refuse(
      `routed run ${candidate.runId} pinned no \`model_pool.learning.seed\` — an unseeded routed run is not replayable, so it cannot authorize a promotion`,
      withSeed,
    );
  }
  if (manifest.armsDigest === undefined) {
    return refuse(
      `routed run ${candidate.runId} recorded no frozen arm snapshot (armsDigest) — the promotion would be authorized by a measurement whose instrument is unknown`,
      withSeed,
    );
  }
  if (manifest.warmArms !== true) {
    return refuse(
      `routed run ${candidate.runId} routed off a COLD arm snapshot — every arm answers n=0, so the learned policy degenerates and the run measures nothing about the arms being promoted. Re-run with \`--warm-arms\``,
      withSeed,
    );
  }

  const lookup = resolve(candidate, opts.evalsDir);
  if (lookup.entry === undefined) {
    return refuse(
      lookup.legacyPresent
        ? `the routed lineage for "${candidate.specName}::${candidate.datasetName}" has no baseline of its own yet (only the legacy unrouted pin exists) — run the routed eval once more so the lineage has a comparison that is not the run being gated`
        : `no baseline is pinned for the routed lineage "${candidate.specName}::${candidate.datasetName}" — the first routed run pins it; promote after the SECOND one gates against it`,
      withSeed,
    );
  }
  const baseline = lookup.entry;
  if (baseline.runId === candidate.runId) {
    return refuse(
      `the newest routed run ${candidate.runId} IS the pinned baseline — a run cannot gate against itself; record another routed run first`,
      { ...withSeed, baselineRunId: baseline.runId },
    );
  }
  let baselineRun: LoadedRun;
  try {
    baselineRun = await load(baseline.outDir);
  } catch (err) {
    return refuse(
      `could not load the pinned baseline run ${baseline.runId} (${err instanceof Error ? err.message : String(err)})`,
      { ...withSeed, baselineRunId: baseline.runId },
    );
  }

  const verdict = gateRuns(baselineRun.summary, candidateRun.summary);
  const warnings: string[] = [];
  if (manifest.armsMutated === true) {
    warnings.push(
      `the live arms.jsonl changed while run ${candidate.runId} was in flight — the measurement itself is unaffected (the snapshot was frozen), but the harness its digest names is not the harness on disk`,
    );
  }
  if (manifest.degenerate === true) {
    warnings.push(
      `every sample of run ${candidate.runId} routed to ${manifest.degenerateArm ?? "one arm"} — the run measured one candidate rather than the roster`,
    );
  }
  const base = { ...withSeed, baselineRunId: baseline.runId };
  if (verdict.verdict !== "pass") {
    return {
      passed: false,
      reason: `routed run ${candidate.runId} FAILED its baseline gate against ${baseline.runId}: ${verdict.reason}`,
      ...base,
      warnings,
    };
  }
  return {
    passed: true,
    reason: `routed run ${candidate.runId} passed its baseline gate against ${baseline.runId} (${candidate.specName}::${candidate.datasetName}, armsDigest ${manifest.armsDigest})`,
    ...base,
    warnings,
  };
}

/** The minimal audit seam this path needs — satisfied by `@crewhaus/audit-log`. */
export type PromotionAuditSink = {
  append(input: { kind: AuditKind; payload: unknown }): Promise<{ readonly seq: number }>;
};

export type RoutePromoteOptions = {
  /** The `.crewhaus` root (`route --dir`). */
  readonly rootDir: string;
  /** `--gate`: map a refusal to a non-zero exit. */
  readonly gate: boolean;
  /** `--dry-run`: report the fold without writing arms.jsonl or an audit record. */
  readonly dryRun: boolean;
  readonly json: boolean;
  /** `--spec <name>`: restrict the authorizing run to one spec. */
  readonly specName?: string;
  /** Overrides for tests / tenant scopes; default to `<rootDir>/evals` and `<rootDir>/audit`. */
  readonly evalsDir?: string;
  readonly auditDir?: string;
  readonly resolveGate?: (opts: ResolveGateOptions) => Promise<PromotionGate>;
  readonly promote?: (rootDir: string, opts: { dryRun: boolean }) => PromoteResult;
  readonly openAudit?: (rootDir: string) => Promise<PromotionAuditSink>;
};

export type RoutePromoteOutcome = {
  readonly text: string;
  /** Non-zero only under `--gate` with a refused promotion. */
  readonly exitCode: number;
  readonly gate: PromotionGate;
  readonly result?: PromoteResult;
  /** Set when the refusal came from `route freeze`, not from the eval gate. */
  readonly frozenPolicyVersion?: string;
  /** Seq of the appended `routing_promotion` record, when one was written. */
  readonly auditSeq?: number;
};

/** Default audit opener — imported lazily so `route status` never touches it. */
async function defaultOpenAudit(rootDir: string): Promise<PromotionAuditSink> {
  const { openAuditLog } = await import("@crewhaus/audit-log");
  return (await openAuditLog({ rootDir })) as PromotionAuditSink;
}

/**
 * Run `crewhaus route promote`. Resolves the gate, folds the observe-only
 * lanes when it passed, and appends the `routing_promotion` audit record that
 * ties the fold to the measurement that authorized it.
 */
export async function runRoutePromote(opts: RoutePromoteOptions): Promise<RoutePromoteOutcome> {
  const evalsDir = opts.evalsDir ?? join(opts.rootDir, "evals");
  const auditDir = opts.auditDir ?? join(opts.rootDir, "audit");
  const resolveGate = opts.resolveGate ?? resolveRoutePromotionGate;
  const promote = opts.promote ?? ((root, o) => promoteLanes(root, o));
  const openAudit = opts.openAudit ?? defaultOpenAudit;

  // §6.3 / §10.1 — the kill switch outranks the gate: a frozen policy is
  // refused before a routed eval is even consulted, because a PASSING gate is
  // exactly the case where a scheduled promotion would otherwise move the
  // arms the operator pinned.
  const freeze = readRouteFreeze(opts.rootDir);
  if (freeze !== undefined) {
    const reason = `routing is FROZEN at policyVersion ${freeze.policyVersion}${freeze.frozenAt !== "" ? ` (since ${freeze.frozenAt})` : ""}${freeze.reason !== undefined ? ` — ${freeze.reason}` : ""}. A freeze means no new observation moves an arm, so no promotion may either; clear it with \`crewhaus route freeze --clear\` once the incident is closed`;
    const frozenGate: PromotionGate = { passed: false, reason, warnings: [] };
    const text = opts.json
      ? JSON.stringify(
          { promoted: false, frozen: freeze, gate: frozenGate, pending: null },
          null,
          2,
        )
      : ["route promote: REFUSED — routing is frozen.", `  ${reason}`].join("\n");
    return {
      text,
      exitCode: opts.gate ? 1 : 0,
      gate: frozenGate,
      frozenPolicyVersion: freeze.policyVersion,
    };
  }

  const gate = await resolveGate({
    evalsDir,
    ...(opts.specName !== undefined ? { specName: opts.specName } : {}),
  });

  if (!gate.passed) {
    // A refused promotion still reports what it WOULD have folded, so an
    // operator can see the audition is ready and only the gate is missing.
    const pending = promote(opts.rootDir, { dryRun: true });
    const text = opts.json
      ? JSON.stringify({ promoted: false, gate, pending }, null, 2)
      : [
          "route promote: REFUSED — no passing gate.",
          `  ${gate.reason}`,
          ...gate.warnings.map((w) => `  note: ${w}`),
          "",
          pending.lines === 0
            ? "Nothing is waiting in the observe-only lanes (`q:` / `shadow:`) anyway."
            : `${pending.lines} lane observation(s) across ${pending.promotions.length} arm(s) are waiting to fold; nothing was written.`,
        ].join("\n");
    return { text, exitCode: opts.gate ? 1 : 0, gate };
  }

  const result = promote(opts.rootDir, { dryRun: opts.dryRun });
  let auditSeq: number | undefined;
  if (!opts.dryRun && result.lines > 0) {
    const sink = await openAudit(auditDir);
    const record = await sink.append({
      kind: "routing_promotion",
      payload: {
        rootDir: opts.rootDir,
        lanes: result.promotions,
        lines: result.lines,
        alreadyPromoted: result.alreadyPromoted,
        dryRun: false,
        gate: {
          passed: true,
          reason: gate.reason,
          ...(gate.specName !== undefined ? { specName: gate.specName } : {}),
          ...(gate.datasetName !== undefined ? { datasetName: gate.datasetName } : {}),
          ...(gate.candidateRunId !== undefined ? { candidateRunId: gate.candidateRunId } : {}),
          ...(gate.baselineRunId !== undefined ? { baselineRunId: gate.baselineRunId } : {}),
          ...(gate.routing !== undefined ? { routing: gate.routing } : {}),
          ...(gate.armsDigest !== undefined ? { armsDigest: gate.armsDigest } : {}),
          ...(gate.policyVersion !== undefined ? { policyVersion: gate.policyVersion } : {}),
          ...(gate.learningSeed !== undefined ? { learningSeed: gate.learningSeed } : {}),
          warnings: gate.warnings,
        },
      },
    });
    auditSeq = record.seq;
  }

  const text = opts.json
    ? JSON.stringify(
        { promoted: !opts.dryRun, gate, result, ...(auditSeq !== undefined ? { auditSeq } : {}) },
        null,
        2,
      )
    : formatPromotion(gate, result, auditDir, auditSeq);
  return {
    text,
    exitCode: 0,
    gate,
    result,
    ...(auditSeq !== undefined ? { auditSeq } : {}),
  };
}

/** Render a passing promotion as the human table `route promote` prints. */
export function formatPromotion(
  gate: PromotionGate,
  result: PromoteResult,
  auditDir: string,
  auditSeq?: number,
): string {
  const lines: string[] = [];
  lines.push(
    result.dryRun
      ? "route promote --dry-run: gate PASSED; the fold below was computed, nothing was written."
      : "route promote: gate PASSED.",
  );
  lines.push(`  ${gate.reason}`);
  for (const w of gate.warnings) lines.push(`  note: ${w}`);
  lines.push("");
  if (result.lines === 0) {
    lines.push(
      result.alreadyPromoted > 0
        ? `Nothing new to promote — all ${result.alreadyPromoted} lane observation(s) in ${result.path} were folded by an earlier promotion.`
        : `Nothing to promote — no \`q:\` or \`shadow:\` observations in ${result.path}.`,
    );
    return lines.join("\n");
  }
  lines.push(
    `${"from".padEnd(22)} ${"to".padEnd(14)} ${"arm".padEnd(26)} ${"carried".padEnd(8)} ${"obs".padStart(6)} ${"quality".padStart(8)}`,
  );
  for (const p of result.promotions) {
    const q = p.meanQuality !== undefined ? p.meanQuality.toFixed(3) : "-";
    lines.push(
      `${p.from.padEnd(22)} ${p.to.padEnd(14)} ${p.model.padEnd(26)} ${p.carried.padEnd(8)} ${String(p.observations).padStart(6)} ${q.padStart(8)}`,
    );
  }
  lines.push("");
  // The `q:` lane re-observes turns the live arm already recorded, so it
  // back-fills the judged quality alone; only `shadow:` carries a whole new
  // observation. The column says which, so the audit trail is unambiguous.
  if (result.promotions.some((p) => p.carried === "quality")) {
    lines.push(
      "carried=quality: the offline `q:` lane re-observed turns the live arm already recorded, so only the judged quality was folded (no second reward observation).",
    );
  }
  lines.push(
    result.dryRun
      ? `Would fold ${result.lines} lane line(s) into live arms (${result.alreadyPromoted} already promoted). Re-run without --dry-run to apply.`
      : `Folded ${result.lines} lane line(s) into live arms in ${result.path} (${result.alreadyPromoted} already promoted).`,
  );
  if (auditSeq !== undefined) {
    lines.push(
      `Appended a routing_promotion record (seq ${auditSeq}) to ${auditDir} — \`crewhaus audit verify\` covers it.`,
    );
  }
  return lines.join("\n");
}
