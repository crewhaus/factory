/**
 * The Advisor — every alert, suggestion and optimization signal this manager
 * can read about a harness, folded into ONE feed with a quick action on each
 * item, plus the surfaces that close the loop around it: an act/dismiss
 * ledger that records the operator's reasoning, an improvement trend, report
 * generation, and an issue inbox that turns a complaint into an update that
 * is ready to run.
 *
 * Three rules shape everything here:
 *
 *   1. **Nothing is invented.** Every item is derived from a signal another
 *      panel already reads — the preflight report (the Start gate), the spec
 *      lint, eval health vs the pinned baseline, the cost fold and the
 *      declared budget, incidents, parked approvals, overdue dreams, the
 *      advice feed. The advisor ranks and explains; it measures nothing new.
 *      {@link deriveAdvisorItems} is PURE so the ranking is unit-testable
 *      without a fixture harness.
 *   2. **A suggestion is never an application.** A quick action either queues
 *      a CLI verb through the job queue (argv from the CLOSED
 *      {@link ADVISOR_JOB_ARGV} vocabulary — a request body can never append
 *      a flag) or deep-links the tab that owns the fix. Spec writes stay on
 *      the spec write path; the advisor never edits YAML.
 *   3. **A decision is a record, not a deletion.** Acting on an item (with an
 *      optional operator comment) and dismissing one (with a REQUIRED reason)
 *      both append to `.crewhaus/advisor/decisions.jsonl`; reopen appends a
 *      superseding record. Nothing is ever unlinked, so "why was this alert
 *      ignored" always has an answer.
 *
 * On-disk state (harness-local, so the CLI and the console read one tree):
 *
 *   .crewhaus/advisor/decisions.jsonl   append-only act/dismiss/reopen records
 *   .crewhaus/advisor/issues.jsonl      append-only submitted issues
 *   .crewhaus/advisor/reports/          generated report JSON, one per run
 *
 * All reads are capped and torn-line tolerant; the feed GET derives, it
 * never writes (reads never mutate — the trend is folded from durable
 * sources rather than from snapshots a read would have to persist).
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import {
  baselineKeyFor,
  breakBoundaries,
  buildTrends,
  lineageOfEntry,
  segmentSeries,
  trendSeriesLabel,
} from "@crewhaus/eval-report";
import {
  type AdvisorArm,
  type AdvisorInputs,
  type AdvisorItem,
  type DecisionRecord,
  type OpenIncidentInput,
  type PendingApprovalsInput,
  assembleFeed,
  deriveAdvisorItems as deriveWith,
} from "@crewhaus/harness-advice/advisor";
import { PORTS_NOT_CHECKED, runPreflight } from "@crewhaus/preflight";
import { foldApprovals, statusOf } from "./approvals";
import { foldHarnessCosts } from "./costs";
import { mergedSpawnEnv } from "./env-file";
import {
  EVAL_COMMAND,
  EVAL_JOB_ARGV,
  OPTIMIZE_COMMAND,
  OPTIMIZE_JOB_ARGV,
  launchOffers,
} from "./eval-inputs";
import { type EvalHealthState, evalHealth, evalsView } from "./evals";
import {
  absent,
  found,
  isDirAt,
  isFileAt,
  listNames,
  num,
  readJsonAt,
  safeContain,
  str,
} from "./evals-ops";
import { type HealthPreflightItem, cadenceToMs, declaredBudgetUsd, dreamOverdue } from "./health";
import { HttpError } from "./http";
import { readJsonlCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { requirePermission, requireString } from "./m3";
import {
  type ArmRow,
  buildLeaderboard,
  foldRouteStats,
  readArms,
  readPinServeStates,
  readPoolView,
  readPoolViews,
  rosterSunsets,
} from "./models";
import { resolveInside } from "./safety";
import { declaredCadences, dreamStates, readSpecYaml } from "./schedulers";
import { listSessions } from "./sessions";
import { specView } from "./spec-view";

// ---------------------------------------------------------------------------
// The item model and the pure derivation: `@crewhaus/harness-advice/advisor`
// ---------------------------------------------------------------------------

export {
  ADVISOR_SCREENS,
  ARM_SAMPLE_FLOOR,
  type OpenIncidentInput,
  type PendingApprovalsInput,
  type AdvisorAction,
  type AdvisorArm,
  type AdvisorInputs,
  type AdvisorItem,
  type AdvisorScreen,
  type AdvisorSeverity,
  ESCALATION_RATE_CEILING,
  JUDGE_SPEND_SHARE,
  type RoleSpendInput,
  type RouteStatsInput,
  type RoutingInputs,
  type SunsetInput,
  UNDERPERFORMING_GAP,
  type UnservedPinInput,
} from "@crewhaus/harness-advice/advisor";

/**
 * The closed job-argv vocabulary — the ONLY commands a quick action can
 * queue, mirrored from the CLI verbs each signal's own screen names. Keyed
 * by the job kind recorded in the queue; no argv element ever comes from a
 * request body.
 */
export const ADVISOR_JOB_ARGV: Readonly<Record<string, readonly string[]>> = {
  doctor: ["doctor"],
  compile: ["compile", "crewhaus.yaml", "-o", "dist"],
  eval: EVAL_JOB_ARGV,
  "dream-run": ["dream", "run", "crewhaus.yaml"],
  optimize: OPTIMIZE_JOB_ARGV,
  advise: ["advise", "--all"],
  // 0.6.0 (design §8.3) — the routing/model verbs the hybrid items name.
  // Still a CLOSED vocabulary: an item picks a KEY, never an argv.
  "route-status": ["route", "status"],
  "route-propose": ["route", "propose"],
  "models-audit": ["models", "audit", "crewhaus.yaml"],
  "models-explain": ["models", "explain", "crewhaus.yaml"],
};

/** The permission each advisor job kind needs: the one its own route needs. */
export const ADVISOR_JOB_PERMISSIONS: Readonly<Record<string, string>> = {
  doctor: "h.eval.run",
  compile: "h.deploy",
  eval: "h.eval.run",
  "dream-run": "h.memory.write",
  optimize: "h.quality.edit",
  advise: "h.eval.run",
  "route-status": "h.read",
  "route-propose": "h.quality.edit",
  "models-audit": "h.read",
  "models-explain": "h.read",
};

/** The command each advisor job kind runs, shown beside its action. */
export const ADVISOR_CLI_TWINS: Readonly<Record<string, string>> = {
  doctor: "crewhaus doctor",
  compile: "crewhaus compile crewhaus.yaml -o dist",
  eval: EVAL_COMMAND,
  "dream-run": "crewhaus dream run crewhaus.yaml",
  optimize: OPTIMIZE_COMMAND,
  advise: "crewhaus advise --all",
  "route-status": "crewhaus route status",
  "route-propose": "crewhaus route propose",
  "models-audit": "crewhaus models audit crewhaus.yaml",
  "models-explain": "crewhaus models explain crewhaus.yaml",
};

/**
 * Inputs → open items, worst first, with each job action showing the command
 * {@link ADVISOR_CLI_TWINS} names for it. The ranking itself is
 * `@crewhaus/harness-advice/advisor`'s.
 */
export function deriveAdvisorItems(inputs: AdvisorInputs): AdvisorItem[] {
  return deriveWith(inputs, ADVISOR_CLI_TWINS);
}

// ---------------------------------------------------------------------------
// The decisions ledger
// ---------------------------------------------------------------------------

const ADVISOR_SEGMENTS = [".crewhaus", "advisor"] as const;

function readDecisions(ctx: M3Context): DecisionRecord[] {
  const path = safeContain(ctx, [...ADVISOR_SEGMENTS, "decisions.jsonl"]);
  if (path === undefined) return [];
  const out: DecisionRecord[] = [];
  for (const obj of readJsonlCapped(path).objects) {
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const itemId = str(rec["itemId"]);
    const action = rec["action"];
    if (itemId === undefined) continue;
    if (action !== "acted" && action !== "dismissed" && action !== "reopened") continue;
    out.push({
      v: 1,
      itemId,
      action,
      at: str(rec["at"]) ?? "",
      by: str(rec["by"]) ?? "",
      ...(str(rec["comment"]) !== undefined ? { comment: str(rec["comment"]) as string } : {}),
      ...(str(rec["reason"]) !== undefined ? { reason: str(rec["reason"]) as string } : {}),
      ...(str(rec["jobId"]) !== undefined ? { jobId: str(rec["jobId"]) as string } : {}),
    });
  }
  return out;
}

function appendAdvisorLine(ctx: M3Context, file: string, record: unknown): void {
  // ctx.contain (throwing form): a write path must never be best-effort.
  const dir = ctx.contain([...ADVISOR_SEGMENTS]);
  mkdirSync(dir, { recursive: true });
  const path = ctx.contain([...ADVISOR_SEGMENTS, file]);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Gathering (the impure half — every read tolerant, nothing mutated)
// ---------------------------------------------------------------------------

const ADVICE_SEGMENTS = [".crewhaus", "advice"] as const;

/** The mined suggestions waiting in `.crewhaus/advice/suggestions.json`, as the advise pass writes them. */
function countAdviceProposals(ctx: M3Context): number {
  const file = readJsonAt(safeContain(ctx, [...ADVICE_SEGMENTS, "suggestions.json"]));
  if (typeof file !== "object" || file === null) return 0;
  const suggestions = (file as Record<string, unknown>)["suggestions"];
  return Array.isArray(suggestions) ? suggestions.length : 0;
}

const INCIDENT_SEGMENTS = [".crewhaus", "incidents"] as const;

/** The open incident records (files not ending `.resolved.json`), each with when it was written. */
function openIncidentsOf(ctx: M3Context): OpenIncidentInput[] {
  const out: OpenIncidentInput[] = [];
  for (const name of listNames(safeContain(ctx, [...INCIDENT_SEGMENTS]))) {
    if (!name.endsWith(".json") || name.endsWith(".resolved.json")) continue;
    const path = safeContain(ctx, [...INCIDENT_SEGMENTS, name]);
    if (path === undefined) continue;
    let at: string;
    try {
      at = new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      continue;
    }
    out.push({ id: name.slice(0, -5), at });
  }
  return out;
}

/** The pending approvals and the newest of them; `null` when the session root is outside the harness. */
function pendingApprovalsInput(dir: string): PendingApprovalsInput | null {
  const folded = foldApprovals(dir);
  if (folded.unreachable === true) return null;
  let count = 0;
  let newest: { id: string; createdAt: string } | undefined;
  for (const approval of folded.approvals) {
    if (statusOf(approval) !== "pending") continue;
    count += 1;
    if (newest === undefined || approval.createdAt > newest.createdAt) newest = approval;
  }
  return newest === undefined
    ? { count: 0, newestId: "", newestAt: "" }
    : { count, newestId: newest.id, newestAt: newest.createdAt };
}

async function gatherInputs(ctx: M3Context, dir: string): Promise<AdvisorInputs> {
  const view = specView(dir, ctx.env);
  let preflight: { items: readonly HealthPreflightItem[] } | null = null;
  try {
    const merged = mergedSpawnEnv(ctx.env, dir);
    const report = await runPreflight({
      harnessDir: dir,
      env: merged.env,
      ...(ctx.checkPort !== undefined ? { checkPort: ctx.checkPort } : {}),
    });
    preflight = { items: report.items };
  } catch (err) {
    ctx.warn(
      `hangar-server: advisor preflight failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const evals = evalsView(dir);
  const yamlText = readSpecYaml(dir);
  const cadence = cadenceToMs(declaredCadences(yamlText).dream ?? null);
  const overdueDreams = dreamStates(dir)
    .map((row) => ({
      specName: row.specName,
      ...dreamOverdue(
        cadence,
        (row.state ?? null) as { lastRunAt?: unknown; lastOutcome?: unknown } | null,
        ctx.now(),
      ),
    }))
    .filter((d) => d.neverRan || (d.windows !== null && d.windows > 2))
    .map((d) => d.specName);
  let procState: string | null = null;
  try {
    procState = (await ctx.process()).snapshot().state;
  } catch {
    procState = null; // a fleet fold has no process handle for this harness
  }
  const costs = foldHarnessCosts(dir, ctx.now());
  let health: { state: EvalHealthState; note: string } | null = null;
  try {
    health = evalHealth(`${dir}/.crewhaus/evals`, view.specName);
  } catch {
    health = null;
  }
  // 0.6.0 §8.3 — the routing signals. Each read is tolerant: an unreadable
  // scoreboard, an absent registry or a spec this manager cannot fully parse
  // produces NO item rather than a wrong one.
  // Every pool the spec declares, not just `agent.model_pool`: a crew role's
  // or a workflow step's pool routes turns too, and an advisor that reads one
  // host proposes flips for a policy that is already flipped.
  const pools = readPoolViews(yamlText);
  const arms = readArms(ctx).rows;
  const policies = [...new Set(pools.map((p) => p.pool.policy ?? "static"))];
  // One policy across every declared pool is the harness's policy; two
  // different ones is `mixed`, never one host's answer spoken for all.
  const policy = policies.length > 1 ? "mixed" : (policies[0] ?? "static");
  const routing =
    pools.length > 0 || arms.length > 0
      ? {
          arms: arms.map(toAdvisorArm),
          policy,
          candidates: pools.reduce((n, p) => n + p.pool.candidates.length, 0),
          learnedAnywhere: policies.includes("learned"),
        }
      : null;
  const routeStats = foldRouteStats(dir);
  const byRole: Record<string, number> = {};
  for (const row of costs.byRole) byRole[row.role] = row.usdMicros;
  let unservedPins: ReturnType<typeof readPinServeStates> = [];
  try {
    unservedPins = readPinServeStates(ctx, dir, view.specName, view.target);
  } catch (err) {
    ctx.warn(
      `hangar-server: advisor pin freshness failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    preflight,
    specUnreadable: view.specUnreadable,
    specIssues: view.issues,
    evalHealth: health,
    evalRuns: evals.runs.length,
    evalsUnreadable: evals.unreadable !== null,
    baselinePinned: Object.keys(evals.baselines).length > 0,
    offers: launchOffers(dir, ctx.entry?.target),
    openIncidents: openIncidentsOf(ctx),
    procState,
    pendingApprovals: pendingApprovalsInput(dir),
    budget: {
      declaredUsd: declaredBudgetUsd(yamlText),
      spentUsd: costs.totalUsdMicros / 1_000_000,
    },
    adviceProposals: countAdviceProposals(ctx),
    overdueDreams,
    routing,
    routeStats: { decisions: routeStats.decisions, escalations: routeStats.escalations },
    roleSpend: { totalUsdMicros: costs.totalUsdMicros, byRole },
    sunsets: view.specUnreadable ? [] : rosterSunsets(yamlText, ctx.now()),
    unservedPins: unservedPins
      .filter((p) => p.state === "not-served")
      .map((p) => ({ env: p.env, version: p.version, detail: p.detail })),
  };
}

/** An `ArmRow` reduced to the fields the pure ranking reads. */
function toAdvisorArm(row: ArmRow): AdvisorArm {
  return {
    band: row.band,
    model: row.model,
    n: row.n,
    meanReward: row.meanReward,
    shadow: row.shadow,
  };
}

const requireDir = (ctx: M3Context): string => {
  if (ctx.harnessDir === null) throw new HttpError(400, "not a per-harness route");
  return ctx.harnessDir;
};

// ---------------------------------------------------------------------------
// Handlers — the feed and its decisions
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/advisor` — the unified feed. Optimal is a first-class
 *  answer, not an empty screen: zero open items IS the goal state. */
export const advisorFeed: M3Handler = async (ctx) => {
  const dir = requireDir(ctx);
  const inputs = await gatherInputs(ctx, dir);
  const { open, dismissed, olderSpec } = assembleFeed(
    deriveAdvisorItems(inputs),
    readDecisions(ctx),
  );
  const counts = {
    critical: open.filter((i) => i.severity === "critical").length,
    warn: open.filter((i) => i.severity === "warn").length,
    suggestion: open.filter((i) => i.severity === "suggestion").length,
    dismissed: dismissed.length,
  };
  const optimal = open.length === 0;
  return {
    ...found(
      optimal
        ? "running optimally — every signal this manager reads is clean"
        : "every item names its source, its fix, and the screen that owns it",
      "crewhaus doctor",
    ),
    items: open,
    dismissed,
    // Dismissals made on an older spec's issues, named by position: they hide nothing now.
    olderSpec: olderSpec.map((line) => ({
      itemId: line.itemId,
      at: line.at,
      by: line.by,
      reason: line.reason ?? "",
      note: "applied to an older spec",
    })),
    open: open.length,
    optimal,
    counts,
    guidance: optimal
      ? "nothing needs attention — check the trend panel to see how it got here"
      : (open[0] as AdvisorItem).guidance,
    asOf: new Date(ctx.now()).toISOString(),
  };
};

/**
 * `POST /api/h/:id/advisor/:itemId/act` — run an item's quick action.
 *
 * The item is re-derived server-side, so what runs is what the feed showed —
 * a stale button cannot run a job the current state no longer proposes. The
 * operator's optional `comment` is recorded verbatim in the decisions
 * ledger, next to the queued job's id.
 */
export const advisorAct: M3Handler = async (ctx) => {
  const dir = requireDir(ctx);
  const itemId = ctx.params["itemId"] as string;
  const inputs = await gatherInputs(ctx, dir);
  const item = deriveAdvisorItems(inputs).find((i) => i.id === itemId);
  if (item === undefined) {
    // A typed refusal, not a 404: the id was well-formed — the state moved.
    return {
      ...absent(
        `no open advisor item "${itemId}" on this harness — the signal may have cleared; reload the feed`,
        null,
      ),
      itemId,
      acted: false,
    };
  }
  const comment = typeof ctx.body["comment"] === "string" ? (ctx.body["comment"] as string) : null;
  let job: unknown = null;
  let jobId: string | undefined;
  if (item.action?.kind === "job" && item.action.jobKind !== null) {
    const argv = ADVISOR_JOB_ARGV[item.action.jobKind];
    if (argv === undefined) throw new HttpError(500, "advisor action names an unknown job kind");
    // Acting queues the item's job: the caller needs that job's own permission too.
    requirePermission(ctx, ADVISOR_JOB_PERMISSIONS[item.action.jobKind] ?? "h.job.run");
    const record = ctx.submitJob(item.action.jobKind, argv);
    job = record;
    jobId = (record as { jobId?: string }).jobId;
  }
  const decision: DecisionRecord = {
    v: 1,
    itemId,
    action: "acted",
    at: new Date(ctx.now()).toISOString(),
    by: ctx.principal,
    ...(comment !== null && comment !== "" ? { comment } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
  };
  appendAdvisorLine(ctx, "decisions.jsonl", decision);
  return {
    ...found(
      item.action?.kind === "job"
        ? "queued — the job appears in the queue panel; the item clears when its signal does"
        : "recorded — this item's fix is a screen, so the console navigates rather than runs",
      item.action?.cliTwin ?? null,
    ),
    itemId,
    acted: true,
    item,
    decision,
    job,
  };
};

/** `POST /api/h/:id/advisor/:itemId/dismiss` — dismiss WITH the reasoning.
 *  The reason is required: "why was this alert ignored" must have an answer
 *  in the ledger, not in somebody's memory. */
export const advisorDismiss: M3Handler = (ctx) => {
  requireDir(ctx);
  const itemId = ctx.params["itemId"] as string;
  const reason = requireString(ctx.body, "reason");
  const decision: DecisionRecord = {
    v: 1,
    itemId,
    action: "dismissed",
    at: new Date(ctx.now()).toISOString(),
    by: ctx.principal,
    reason,
  };
  appendAdvisorLine(ctx, "decisions.jsonl", decision);
  return {
    ...found("dismissed — the item moves to the dismissed fold with this reason attached", null),
    itemId,
    dismissed: true,
    decision,
  };
};

/** `POST /api/h/:id/advisor/:itemId/reopen` — lift a dismissal. An appended
 *  superseding record, never an edit: the ledger keeps both decisions. */
export const advisorReopen: M3Handler = (ctx) => {
  requireDir(ctx);
  const itemId = ctx.params["itemId"] as string;
  const decision: DecisionRecord = {
    v: 1,
    itemId,
    action: "reopened",
    at: new Date(ctx.now()).toISOString(),
    by: ctx.principal,
  };
  appendAdvisorLine(ctx, "decisions.jsonl", decision);
  return { ...found("reopened — the item returns to the open feed", null), itemId, reopened: true };
};

// ---------------------------------------------------------------------------
// The trend — is this harness improving?
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/advisor/trend` — improvement over time, folded from
 * DURABLE sources only (the eval index, the session cost fold, the decisions
 * ledger). No snapshot is persisted by a read; a GET that wrote history
 * would violate the reads-never-mutate covenant for a convenience.
 *
 * The eval trend is one lineage's: the lineage of the latest run that
 * measured something, over the runs that measured something in its last
 * segment (since the dataset or the measuring instrument last changed). A
 * delta across lineages or across an instrument change compares different
 * measurements.
 */
export const advisorTrend: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const evals = evalsView(dir);
  const runs = [...evals.runs].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const measuredRun = (r: { readonly partial?: boolean; readonly measuredCount?: number }) =>
    r.partial !== true && r.measuredCount !== 0;
  const latest = [...runs].reverse().find(measuredRun);
  const lineageKey = latest !== undefined ? baselineKeyFor(lineageOfEntry(latest)) : undefined;
  const byRun = new Map(runs.map((r) => [r.runId, r]));
  const keyOfSeries = (s: { readonly points: ReadonlyArray<{ readonly runId: string }> }) => {
    const first = byRun.get(s.points[0]?.runId ?? "");
    return first !== undefined ? baselineKeyFor(lineageOfEntry(first)) : undefined;
  };
  const series =
    lineageKey !== undefined
      ? buildTrends(runs).find((s) => keyOfSeries(s) === lineageKey)
      : undefined;
  const walk = series !== undefined ? segmentSeries(series, runs) : undefined;
  const boundaries = breakBoundaries(walk?.boundaries ?? []);
  const lastSegment = walk?.segments[walk.segments.length - 1];
  const evalSeries = (lastSegment?.points ?? [])
    .map((p) => byRun.get(p.runId))
    .filter((r): r is (typeof runs)[number] => r !== undefined && measuredRun(r))
    .map((r) => ({
      runId: r.runId,
      ts: r.ts,
      passRate: r.passRate,
      datasetName: r.datasetName,
    }));
  const lineage =
    series !== undefined && lineageKey !== undefined
      ? // `id`, not `key`: the dispatch masker redacts a field by its name.
        { id: lineageKey, label: `${series.specName}/${trendSeriesLabel(series)}` }
      : null;
  const costs = foldHarnessCosts(dir, ctx.now());
  const records = readDecisions(ctx);
  const twoWeeksAgo = ctx.now() - 14 * 86_400_000;
  const recent = records.filter((r) => Date.parse(r.at) >= twoWeeksAgo);
  const decisions = {
    total: records.length,
    acted: records.filter((r) => r.action === "acted").length,
    dismissed: records.filter((r) => r.action === "dismissed").length,
    last14d: {
      acted: recent.filter((r) => r.action === "acted").length,
      dismissed: recent.filter((r) => r.action === "dismissed").length,
    },
  };
  const first = evalSeries[0];
  const last = evalSeries[evalSeries.length - 1];
  const delta =
    first !== undefined && last !== undefined && evalSeries.length > 1
      ? (num(last.passRate) ?? 0) - (num(first.passRate) ?? 0)
      : null;
  const since = boundaries.length > 0 ? "since the checks last changed" : undefined;
  const summary =
    evalSeries.length === 0
      ? runs.length === 0
        ? "no eval history yet — improvement is unmeasured until a first run lands"
        : "no recorded eval run measured anything yet — improvement is unmeasured until one does"
      : delta === null
        ? since !== undefined
          ? `one eval run ${since} — a second run makes this a trend`
          : "one eval run recorded — a second run makes this a trend"
        : delta > 0.001
          ? `pass rate is up ${(delta * 100).toFixed(1)} points ${since ?? "since the first recorded run"}`
          : delta < -0.001
            ? `pass rate is down ${(Math.abs(delta) * 100).toFixed(1)} points ${since ?? "since the first recorded run"}`
            : since !== undefined
              ? `pass rate is flat ${since}`
              : "pass rate is flat across the recorded runs";
  return {
    ...found(
      "folded from the eval index, the session cost ledger and the advisor's own decisions — nothing here is a stored snapshot",
      launchOffers(dir, ctx.entry?.target).eval.verb,
    ),
    evalSeries,
    lineage,
    boundaries,
    spendDays: costs.days,
    decisions,
    summary,
    baselines: evals.baselines,
  };
};

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** The closed report vocabulary. Anything else is a 400. */
export const REPORT_KINDS = [
  "model-usage",
  "costs",
  "usefulness",
  "optimization",
  // 0.6.0 (design §8.3) — the two hybrid reports. `routing` is about the
  // LEARNING (arms, bands, the policy and its freeze); `hybrid` is about the
  // SHAPE of a turn (which role and profile the money went to, how often the
  // cheap lane escalated).
  "routing",
  "hybrid",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const isReportKind = (v: unknown): v is ReportKind =>
  typeof v === "string" && (REPORT_KINDS as readonly string[]).includes(v);

function reportStamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function buildReport(ctx: M3Context, dir: string, kind: ReportKind): Record<string, unknown> {
  const costs = foldHarnessCosts(dir, ctx.now());
  switch (kind) {
    case "model-usage": {
      const rows = [...costs.byModel].sort((a, b) => b.usdMicros - a.usdMicros);
      const top = rows[0];
      return {
        byModel: rows,
        totals: { usdMicros: costs.totalUsdMicros, calls: costs.calls },
        finding:
          top === undefined
            ? "no priced model calls recorded"
            : `${top.provider}/${top.modelId} carries ${
                costs.totalUsdMicros > 0
                  ? Math.round((top.usdMicros / costs.totalUsdMicros) * 100)
                  : 0
              }% of recorded spend — right-size it first if the bill needs cutting`,
      };
    }
    case "costs": {
      const yamlText = readSpecYaml(dir);
      const declaredUsd = declaredBudgetUsd(yamlText);
      const spentUsd = costs.totalUsdMicros / 1_000_000;
      return {
        days: costs.days,
        totals: {
          usdMicros: costs.totalUsdMicros,
          spend7dUsdMicros: costs.spend7dUsdMicros,
          calls: costs.calls,
        },
        budget: {
          declaredUsd,
          spentUsd,
          ratio: declaredUsd !== null && declaredUsd > 0 ? spentUsd / declaredUsd : null,
        },
        finding:
          declaredUsd === null
            ? "no budget: block declared — spend has no ceiling"
            : `$${spentUsd.toFixed(2)} of the $${declaredUsd.toFixed(2)} ceiling is used`,
      };
    }
    case "usefulness": {
      const sessions = listSessions(dir, ctx.now());
      const evals = evalsView(dir);
      const latest = [...evals.runs].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0];
      return {
        sessions: sessions.sessions.length,
        evalRuns: evals.runs.length,
        latestPassRate: latest?.passRate ?? null,
        adviceProposals: countAdviceProposals(ctx),
        finding:
          sessions.sessions.length === 0
            ? "no sessions recorded — usefulness is unmeasured until the harness is used"
            : `${sessions.sessions.length} session(s) on record; the latest eval pass rate is ${
                latest !== undefined
                  ? `${Math.round((num(latest.passRate) ?? 0) * 100)}%`
                  : "unmeasured"
              }`,
      };
    }
    case "routing": {
      const yamlText = readSpecYaml(dir);
      const pool = readPoolView(yamlText);
      const pools = readPoolViews(yamlText);
      const arms = readArms(ctx).rows;
      const leaderboard = buildLeaderboard(arms);
      const best = leaderboard.filter((r) => r.best);
      const stats = foldRouteStats(dir);
      return {
        pool,
        pools,
        arms,
        leaderboard,
        best,
        routeStats: stats,
        finding:
          !pool.declared && arms.length === 0
            ? "no model_pool declared anywhere and no recorded arms — this harness routes nothing"
            : arms.length === 0
              ? "a pool is declared but nothing has been observed yet — run the harness to accumulate arms"
              : `${arms.length} arm(s) across ${best.length} band(s); the leading arm in each band is what a \`learned\` policy would exploit`,
      };
    }
    case "hybrid": {
      const costs = foldHarnessCosts(dir, ctx.now());
      const stats = foldRouteStats(dir);
      const sunsets = rosterSunsets(readSpecYaml(dir), ctx.now());
      const escalationRate = stats.decisions > 0 ? stats.escalations / stats.decisions : null;
      const judgeUsdMicros =
        (costs.byRole.find((r) => r.role === "judge")?.usdMicros ?? 0) +
        (costs.byRole.find((r) => r.role === "committee")?.usdMicros ?? 0);
      return {
        byRole: costs.byRole,
        byProfile: costs.byProfile,
        totals: {
          usdMicros: costs.totalUsdMicros,
          calls: costs.calls,
          rollups: costs.rollups,
        },
        routeStats: stats,
        escalationRate,
        judgeShare: costs.totalUsdMicros > 0 ? judgeUsdMicros / costs.totalUsdMicros : null,
        sunsets,
        finding:
          costs.calls === 0
            ? "no priced model calls recorded — the shape of a turn is unmeasured until the harness runs"
            : `${costs.byRole.length} role(s) and ${costs.byProfile.length} profile bucket(s) on record; ${
                escalationRate === null
                  ? "no routed turns yet"
                  : `${Math.round(escalationRate * 100)}% of routed turns escalated`
              }`,
      };
    }
    case "optimization": {
      const evals = evalsView(dir);
      const series = [...evals.runs].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const optimizeRuns = listNames(safeContain(ctx, [".crewhaus", "optimize"])).filter((name) =>
        isDirAt(safeContain(ctx, [".crewhaus", "optimize", name])),
      );
      return {
        evalSeries: series.map((r) => ({ runId: r.runId, ts: r.ts, passRate: r.passRate })),
        baselines: evals.baselines,
        optimizeRuns,
        finding:
          series.length === 0
            ? "no eval history — run an eval before an optimize; the optimizer needs a signal to climb"
            : optimizeRuns.length === 0
              ? "eval history exists but no optimize run has been recorded — `crewhaus optimize` closes the loop"
              : `${optimizeRuns.length} optimize run(s) recorded against ${series.length} eval run(s)`,
      };
    }
  }
}

/** `POST /api/h/:id/advisor/reports` — generate one report, persisted under
 *  `.crewhaus/advisor/reports/` so it can be re-read and compared later. */
export const advisorReportRun: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const kind = ctx.body["kind"];
  if (!isReportKind(kind)) {
    throw new HttpError(400, `missing "kind" — one of: ${REPORT_KINDS.join(", ")}`);
  }
  const stamp = reportStamp(ctx.now());
  const reportId = `${stamp}-${kind}`;
  const body = buildReport(ctx, dir, kind);
  const record = {
    v: 1,
    reportId,
    kind,
    generatedAt: new Date(ctx.now()).toISOString(),
    by: ctx.principal,
    body,
  };
  const reportsDir = ctx.contain([...ADVISOR_SEGMENTS, "reports"]);
  mkdirSync(reportsDir, { recursive: true });
  const path = ctx.contain([...ADVISOR_SEGMENTS, "reports", `${reportId}.json`]);
  appendFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return {
    ...found("generated and saved — re-read it any time from the reports list", null),
    report: record,
  };
};

/** `GET /api/h/:id/advisor/reports` — the saved reports, newest first. */
export const advisorReports: M3Handler = (ctx) => {
  requireDir(ctx);
  const names = listNames(safeContain(ctx, [...ADVISOR_SEGMENTS, "reports"]))
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse();
  const reports = names.map((name) => {
    const parsed = readJsonAt(safeContain(ctx, [...ADVISOR_SEGMENTS, "reports", name]));
    const rec = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    return {
      reportId: str(rec["reportId"]) ?? name.replace(/\.json$/, ""),
      kind: str(rec["kind"]) ?? null,
      generatedAt: str(rec["generatedAt"]) ?? null,
      by: str(rec["by"]) ?? null,
    };
  });
  if (reports.length === 0) {
    return {
      ...absent("no reports generated yet — pick a kind and generate one", null),
      reports,
      kinds: REPORT_KINDS,
    };
  }
  return { ...found(null, null), reports, kinds: REPORT_KINDS };
};

/** `GET /api/h/:id/advisor/reports/:reportId` — one saved report. A missing
 *  id answers the absent envelope, not a 404: nothing was malformed. */
export const advisorReport: M3Handler = (ctx) => {
  requireDir(ctx);
  const reportId = ctx.params["reportId"] as string;
  const path = safeContain(ctx, [...ADVISOR_SEGMENTS, "reports", `${reportId}.json`]);
  if (!isFileAt(path)) {
    return {
      ...absent(
        `no report "${reportId}" on this harness — generate one from the reports panel`,
        null,
      ),
      reportId,
      kind: null,
      generatedAt: null,
      report: null,
    };
  }
  const parsed = readJsonAt(path);
  const rec = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    ...found(null, null),
    reportId,
    kind: str(rec["kind"]) ?? null,
    generatedAt: str(rec["generatedAt"]) ?? null,
    report: rec,
  };
};

// ---------------------------------------------------------------------------
// Issues — a complaint becomes an update ready to run
// ---------------------------------------------------------------------------

/** Issue kinds and the update each maps to. `note` records without queueing
 *  — for issues that need a human plan before anything runs. */
export const ISSUE_KINDS = ["optimize", "eval", "doctor", "compile", "advise", "note"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

const isIssueKind = (v: unknown): v is IssueKind =>
  typeof v === "string" && (ISSUE_KINDS as readonly string[]).includes(v);

type IssueRecord = {
  readonly v: 1;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly kind: IssueKind;
  readonly at: string;
  readonly by: string;
  readonly update: {
    readonly ready: boolean;
    readonly jobId: string | null;
    readonly jobKind: string | null;
    readonly cliTwin: string | null;
    readonly note: string;
  };
};

function readIssues(ctx: M3Context): IssueRecord[] {
  const path = safeContain(ctx, [...ADVISOR_SEGMENTS, "issues.jsonl"]);
  if (path === undefined) return [];
  const out: IssueRecord[] = [];
  for (const obj of readJsonlCapped(path).objects) {
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const id = str(rec["id"]);
    const title = str(rec["title"]);
    if (id === undefined || title === undefined) continue;
    const update = (
      typeof rec["update"] === "object" && rec["update"] !== null ? rec["update"] : {}
    ) as Record<string, unknown>;
    out.push({
      v: 1,
      id,
      title,
      detail: str(rec["detail"]) ?? "",
      kind: isIssueKind(rec["kind"]) ? rec["kind"] : "note",
      at: str(rec["at"]) ?? "",
      by: str(rec["by"]) ?? "",
      update: {
        ready: update["ready"] === true,
        jobId: str(update["jobId"]) ?? null,
        jobKind: str(update["jobKind"]) ?? null,
        cliTwin: str(update["cliTwin"]) ?? null,
        note: str(update["note"]) ?? "",
      },
    });
  }
  return out.reverse(); // newest first
}

/**
 * `POST /api/h/:id/advisor/issues` — submit an issue and have it tuned into
 * an update ready to run.
 *
 * The `kind` picks the update from a CLOSED vocabulary: `optimize` queues
 * the eval→patch loop (the active-optimization pillar — the run's artifacts
 * land as a reviewable spec patch), `eval`/`doctor`/`compile`/`advise` queue
 * their verbs, and `note` records the issue for a human plan without
 * queueing anything. The issue text itself never reaches a command line.
 */
export const advisorIssueSubmit: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const title = requireString(ctx.body, "title");
  const detail = typeof ctx.body["detail"] === "string" ? (ctx.body["detail"] as string) : "";
  const kindRaw = ctx.body["kind"] ?? "optimize";
  if (!isIssueKind(kindRaw)) {
    throw new HttpError(400, `"kind" must be one of: ${ISSUE_KINDS.join(", ")}`);
  }
  const kind: IssueKind = kindRaw;
  let jobId: string | null = null;
  let jobRecord: unknown = null;
  if (kind === "eval" || kind === "optimize") {
    const offer = launchOffers(dir, ctx.entry?.target)[kind];
    if (!offer.offered) throw new HttpError(409, offer.note ?? "this job cannot run here");
  }
  if (kind !== "note") {
    const argv = ADVISOR_JOB_ARGV[kind];
    if (argv === undefined) throw new HttpError(500, "issue kind names an unknown job kind");
    const record = ctx.submitJob(kind, argv);
    jobRecord = record;
    jobId = (record as { jobId?: string }).jobId ?? null;
  }
  const issue: IssueRecord = {
    v: 1,
    id: `iss-${ctx.now().toString(36)}`,
    title,
    detail,
    kind,
    at: new Date(ctx.now()).toISOString(),
    by: ctx.principal,
    update: {
      ready: kind !== "note",
      jobId,
      jobKind: kind === "note" ? null : kind,
      cliTwin: kind === "note" ? null : (ADVISOR_CLI_TWINS[kind] ?? null),
      note:
        kind === "note"
          ? "recorded only — no update was queued; pick a kind to turn it into one"
          : kind === "optimize"
            ? "queued the optimize loop — its patch lands as a reviewable spec update, never an automatic write"
            : `queued ${ADVISOR_CLI_TWINS[kind] ?? kind} — watch it in the job queue`,
    },
  };
  appendAdvisorLine(ctx, "issues.jsonl", issue);
  return { ...found(issue.update.note, issue.update.cliTwin), issue, job: jobRecord };
};

/** `GET /api/h/:id/advisor/issues` — submitted issues, newest first. */
export const advisorIssues: M3Handler = (ctx) => {
  requireDir(ctx);
  const issues = readIssues(ctx);
  if (issues.length === 0) {
    return {
      ...absent(
        "no issues submitted yet — describe a problem and it is tuned into an update ready to run",
        null,
      ),
      issues,
      kinds: ISSUE_KINDS,
    };
  }
  return { ...found(null, null), issues, kinds: ISSUE_KINDS };
};

// ---------------------------------------------------------------------------
// The fleet board
// ---------------------------------------------------------------------------

/**
 * `GET /api/advisor` — every live harness's advisor rollup on one board,
 * worst first. Runs a preflight per harness (the same cost as the fleet
 * health board) — this is the "needs attention" screen an operator opens,
 * never anything's first paint. Supervision-derived items are absent here
 * (the fold has no process handle for other harnesses); the per-harness
 * feed is the complete picture.
 */
export const advisorFleet: M3Handler = async (ctx) => {
  const rows: Array<Record<string, unknown>> = [];
  for (const h of ctx.harnesses()) {
    const subCtx = harnessSubContext(ctx, h.dir);
    const inputs = await gatherInputs(subCtx, h.dir);
    const { open } = assembleFeed(deriveAdvisorItems(inputs), readDecisions(subCtx));
    const top = open[0];
    rows.push({
      id: h.id,
      specName: h.specName,
      open: open.length,
      critical: open.filter((i) => i.severity === "critical").length,
      warn: open.filter((i) => i.severity === "warn").length,
      suggestion: open.filter((i) => i.severity === "suggestion").length,
      optimal: open.length === 0,
      topItem:
        top === undefined
          ? null
          : { id: top.id, severity: top.severity, title: top.title, screen: top.screen },
    });
  }
  rows.sort(
    (a, b) =>
      (b["critical"] as number) - (a["critical"] as number) ||
      (b["open"] as number) - (a["open"] as number) ||
      String(a["specName"]).localeCompare(String(b["specName"])),
  );
  const totals = {
    harnesses: rows.length,
    open: rows.reduce((n, r) => n + (r["open"] as number), 0),
    critical: rows.reduce((n, r) => n + (r["critical"] as number), 0),
    optimal: rows.filter((r) => r["optimal"] === true).length,
  };
  return {
    ...found(
      rows.length === 0
        ? "no live harness to advise — register one first"
        : totals.open === 0
          ? "the whole fleet is running optimally"
          : "worst first — open a harness's Advisor tab for the full feed and its actions",
      "crewhaus doctor",
    ),
    harnesses: rows,
    totals,
  };
};

/**
 * A context for one harness this request did not name: every read contained inside that
 * harness exactly as the per-harness route would contain it, and no process handle (a
 * fold over other harnesses has none, so supervision items are left out).
 */
function harnessSubContext(ctx: M3Context, dir: string): M3Context {
  return {
    ...ctx,
    entry: null,
    harnessDir: dir,
    contain: (segments) => {
      const resolved = safeContainIn(dir, segments);
      if (resolved === undefined) throw new HttpError(400, "path escapes the harness directory");
      return resolved;
    },
    process: async () => {
      throw new HttpError(400, "no process handle in a fleet fold");
    },
  };
}

/**
 * One harness's open Advisor items, gathered and ranked with its ledger folded on, as the
 * fleet board gathers them. Home's attention sweep calls it off the request path (it runs
 * a preflight); no read does.
 */
export async function advisorOpenItems(ctx: M3Context, dir: string): Promise<AdvisorItem[]> {
  const subCtx = harnessSubContext(ctx, dir);
  const inputs = await gatherInputs(subCtx, dir);
  return assembleFeed(deriveAdvisorItems(inputs), readDecisions(subCtx)).open;
}

/** What Home lends the attention sweep's gatherer: no request, no caller, and no command runs. */
export type AdvisorSweepHome = Pick<
  M3Context,
  "env" | "now" | "warn" | "control" | "jobs" | "operator" | "hangarRoot"
>;

/**
 * One harness's open Advisor findings off the request path, for Home's attention sweep:
 * gathered in a context built as the fleet board builds one per harness (every read
 * contained in that harness, no process handle), with no caller, every permission
 * refused and every job refused. It runs a preflight, so only the sweep calls it. The
 * preflight binds no port here: no one is waiting for the answer, and a daemon may be
 * about to bind the same one. A check a person opens looks at the ports.
 */
export async function advisorSweepItems(
  home: AdvisorSweepHome,
  harness: { readonly id: string; readonly dir: string },
): Promise<AdvisorItem[]> {
  const refuse = (): never => {
    throw new HttpError(400, "the Advisor sweep runs no command");
  };
  const ctx: M3Context = {
    entry: null,
    harnessDir: harness.dir,
    adopted: false,
    params: {},
    query: new URLSearchParams(),
    body: {},
    env: home.env,
    now: home.now,
    operator: home.operator,
    principal: "sys:attention-advisor",
    authorize: (permission) => ({ allow: false, needs: permission, role: null }),
    contain: refuse,
    harnesses: () => [],
    nestedHarnessAt: () => undefined,
    process: async () => refuse(),
    control: home.control,
    jobs: home.jobs,
    submitJob: refuse,
    checkJob: refuse,
    warn: home.warn,
    checkPort: PORTS_NOT_CHECKED,
    ...(home.hangarRoot !== undefined ? { hangarRoot: home.hangarRoot } : {}),
  };
  return advisorOpenItems(ctx, harness.dir);
}

/** `resolveInside` for a dir this request did not name — the same realpath
 *  containment the dispatcher applies, applied to a fleet-fold member. */
function safeContainIn(dir: string, segments: readonly string[]): string | undefined {
  return resolveInside(dir, segments);
}
