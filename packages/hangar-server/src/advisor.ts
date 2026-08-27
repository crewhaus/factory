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
import { appendFileSync, mkdirSync } from "node:fs";
import { countOpenIncidents } from "@crewhaus/harness-inventory";
import { runPreflight } from "@crewhaus/preflight";
import { pendingApprovalCount } from "./approvals";
import { SAFE_SEGMENT_RE } from "./constants";
import { foldHarnessCosts } from "./costs";
import { mergedSpawnEnv } from "./env-file";
import { evalHealth, evalsView } from "./evals";
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
import { requireString } from "./m3";
import { resolveInside } from "./safety";
import { declaredCadences, dreamStates, readSpecYaml } from "./schedulers";
import { listSessions } from "./sessions";
import { specView } from "./spec-view";

// ---------------------------------------------------------------------------
// The item model
// ---------------------------------------------------------------------------

/** critical = the harness cannot do its job · warn = it is degraded or at
 *  risk · suggestion = it would run better. Never color alone: every item
 *  carries its severity as text too. */
export type AdvisorSeverity = "critical" | "warn" | "suggestion";

/** One quick action. `job` queues a CLI verb through the job queue;
 *  `link` deep-links the screen that owns the fix (the console navigates —
 *  nothing runs). `cliTwin` is the command an operator could paste instead. */
export type AdvisorAction = {
  readonly kind: "job" | "link";
  readonly label: string;
  readonly cliTwin: string | null;
  /** A key of {@link ADVISOR_JOB_ARGV} when kind === "job"; null for links. */
  readonly jobKind: string | null;
};

export type AdvisorItem = {
  /** Stable, {@link SAFE_SEGMENT_RE}-safe — it names a route segment and a
   *  ledger key, and it must survive re-derivation to keep a dismissal
   *  attached to its item. */
  readonly id: string;
  readonly severity: AdvisorSeverity;
  /** One line: what is wrong (or what could be better). */
  readonly title: string;
  /** The fact it was derived from, in the operator's words. */
  readonly detail: string;
  /** The tooltip: why this matters / what happens if it stays unaddressed. */
  readonly explain: string;
  /** What to do about it — always present, even when no button is. */
  readonly guidance: string;
  /** The console screen that owns the fix: a harness tab name, or one of the
   *  fleet screens ("approvals"). The view renders it as a deep link. */
  readonly screen: string;
  /** The panel family the signal came from (preflight, spec, evals, …). */
  readonly source: string;
  readonly action: AdvisorAction | null;
  readonly status: "open" | "dismissed";
  /** Present when status === "dismissed": the recorded reasoning. */
  readonly dismissal?: { readonly reason: string; readonly by: string; readonly at: string };
  /** The most recent acted record for this item, when one exists — so the
   *  feed shows "already queued yesterday, with this comment". */
  readonly lastAction?: {
    readonly comment: string | null;
    readonly by: string;
    readonly at: string;
    readonly jobId: string | null;
  };
};

/**
 * The closed job-argv vocabulary — the ONLY commands a quick action can
 * queue, mirrored from the CLI verbs each signal's own screen names. Keyed
 * by the job kind recorded in the queue; no argv element ever comes from a
 * request body.
 */
export const ADVISOR_JOB_ARGV: Readonly<Record<string, readonly string[]>> = {
  doctor: ["doctor"],
  compile: ["compile", "crewhaus.yaml", "-o", "dist"],
  eval: ["eval", "crewhaus.yaml"],
  "dream-run": ["dream", "run", "crewhaus.yaml"],
  optimize: ["optimize", "crewhaus.yaml"],
  advise: ["advise", "--all"],
};

const CLI_TWIN: Readonly<Record<string, string>> = {
  doctor: "crewhaus doctor",
  compile: "crewhaus compile crewhaus.yaml -o dist",
  eval: "crewhaus eval crewhaus.yaml",
  "dream-run": "crewhaus dream run crewhaus.yaml",
  optimize: "crewhaus optimize crewhaus.yaml",
  advise: "crewhaus advise --all",
};

const jobAction = (jobKind: string, label: string): AdvisorAction => ({
  kind: "job",
  label,
  cliTwin: CLI_TWIN[jobKind] ?? null,
  jobKind,
});

const linkAction = (label: string, cliTwin: string | null = null): AdvisorAction => ({
  kind: "link",
  label,
  cliTwin,
  jobKind: null,
});

/** Preflight area → the tab that fixes it (the health module's own table,
 *  restated here so the advisor and the score can be tested independently). */
const AREA_SCREEN: Readonly<Record<string, string>> = {
  spec: "spec",
  credentials: "creds",
  channels: "channels",
  mcp: "dev",
  ports: "runs",
  bundle: "runs",
  durability: "memory",
};

/** Item-id charset: SAFE_SEGMENT only, so an id can ride a route path. */
const safeId = (raw: string): string => {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+/, "");
  const capped = cleaned.slice(0, 120);
  return SAFE_SEGMENT_RE.test(capped) ? capped : "item";
};

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

/** Everything {@link deriveAdvisorItems} folds — plain data, so the ranking
 *  is testable without a harness. `null` means "could not be read", and an
 *  unreadable signal produces no item (an unknown is not an alert). */
export type AdvisorInputs = {
  readonly preflight: { readonly items: readonly HealthPreflightItem[] } | null;
  readonly specUnreadable: boolean;
  readonly specIssues: ReadonlyArray<{ readonly message: string }>;
  readonly evalHealth: { readonly healthy: boolean; readonly note: string } | null;
  /** Recorded eval runs (0 = no signal yet). */
  readonly evalRuns: number;
  readonly baselinePinned: boolean;
  readonly openIncidents: number;
  readonly procState: string | null;
  readonly pendingApprovals: number;
  readonly budget: { readonly declaredUsd: number | null; readonly spentUsd: number };
  readonly adviceProposals: number;
  readonly overdueDreams: readonly string[];
};

/**
 * Inputs → open items, worst first. Pure. The ordering inside a severity
 * tier is derivation order, which follows the operator's own triage order:
 * can it start, is it healthy, is it spending safely, could it be better.
 */
export function deriveAdvisorItems(inputs: AdvisorInputs): AdvisorItem[] {
  const items: AdvisorItem[] = [];
  const open = (item: Omit<AdvisorItem, "status">): void => {
    items.push({ ...item, status: "open" });
  };

  // --- can it run at all -------------------------------------------------
  if (inputs.specUnreadable) {
    open({
      id: "spec-unreadable",
      severity: "critical",
      title: "crewhaus.yaml is missing or unreadable",
      detail: "the spec could not be parsed",
      explain:
        "every downstream signal — compile, preflight, badges, evals — derives from the spec; none of them can be trusted without it",
      guidance: "restore or fix crewhaus.yaml on the Spec tab, then recompile",
      screen: "spec",
      source: "spec",
      action: linkAction("Open the spec", null),
    });
  }
  for (const item of inputs.preflight?.items ?? []) {
    if (item.level !== "blocking") continue;
    const screen = AREA_SCREEN[item.area] ?? "overview";
    open({
      id: safeId(`preflight-${item.id}`),
      severity: "critical",
      title: `preflight blocks the start: ${item.id}`,
      detail:
        item.remediation !== undefined ? `${item.message} — ${item.remediation}` : item.message,
      explain:
        "this is the Start gate's own refusal set: a daemon started anyway would exit on boot, so nothing runs until it clears",
      guidance:
        item.remediation ?? `fix it on the ${screen} tab — the same finding gates every start`,
      screen,
      source: "preflight",
      action:
        item.area === "credentials"
          ? jobAction("doctor", "Run doctor")
          : item.area === "bundle"
            ? jobAction("compile", "Recompile the bundle")
            : linkAction(`Open ${screen}`),
    });
  }
  if (inputs.procState === "crash-looping") {
    open({
      id: "proc-crash-looping",
      severity: "critical",
      title: "the daemon is crash-looping",
      detail: "restarts hit the crash-loop window, so the supervisor stopped restarting it",
      explain:
        "it is manual-start-only until the cause is fixed — the supervisor will not fight a process that dies on boot",
      guidance: "read the last exit and its failure class on the Runs tab before starting again",
      screen: "runs",
      source: "process",
      action: linkAction("Open the run ledger"),
    });
  } else if (inputs.procState === "parked") {
    open({
      id: "proc-parked",
      severity: "warn",
      title: "the run is parked on a human decision",
      detail: "supervision is parked",
      explain: "the daemon is waiting for an approval verdict — nothing proceeds until it lands",
      guidance: "settle the parked item in the approvals inbox",
      screen: "approvals",
      source: "process",
      action: linkAction("Open approvals"),
    });
  } else if (inputs.procState === "terminal") {
    open({
      id: "proc-terminal",
      severity: "warn",
      title: "supervision is terminal",
      detail: "the last exit was a terminal class, so no restart was attempted",
      explain:
        "terminal exits (bad credentials, exit 2 config refusals) repeat identically on restart — the supervisor deliberately stops trying",
      guidance: "fix the cause named by the exit's failure class, then start manually",
      screen: "runs",
      source: "process",
      action: linkAction("Open the run ledger"),
    });
  }

  // --- is it healthy -------------------------------------------------------
  if (inputs.evalHealth !== null && !inputs.evalHealth.healthy) {
    open({
      id: "eval-below-baseline",
      severity: "warn",
      title: "quality regressed below the pinned baseline",
      detail: inputs.evalHealth.note,
      explain:
        "the latest eval run scored under the run you pinned as acceptable — users are seeing worse answers than the ones you signed off on",
      guidance:
        "queue an optimize run: the eval→patch loop searches the spec's tunable paths and emits an update ready to review and run",
      screen: "evals",
      source: "evals",
      action: jobAction("optimize", "Queue an optimize run"),
    });
  }
  if (inputs.openIncidents > 0) {
    open({
      id: "incidents-open",
      severity: "warn",
      title: `${inputs.openIncidents} incident record${inputs.openIncidents === 1 ? "" : "s"} open`,
      detail: "unresolved records under .crewhaus/incidents",
      explain:
        "an incident file is written when something tripped a runtime guard; leaving it open means nobody has judged whether it can recur",
      guidance: "review each record on the Security tab and resolve or escalate it",
      screen: "security",
      source: "security",
      action: linkAction("Open security"),
    });
  }
  if (inputs.pendingApprovals > 0) {
    open({
      id: "approvals-pending",
      severity: "warn",
      title: `${inputs.pendingApprovals} approval${inputs.pendingApprovals === 1 ? "" : "s"} waiting`,
      detail: "tool calls are parked for a human verdict",
      explain:
        "each parked call is a session holding its breath — the agent cannot finish that turn until someone grants or denies",
      guidance: "triage them in the approvals inbox (j/k to move, one key per verdict)",
      screen: "approvals",
      source: "approvals",
      action: linkAction("Open approvals"),
    });
  }
  for (const spec of inputs.overdueDreams) {
    open({
      id: safeId(`dream-overdue-${spec}`),
      severity: "suggestion",
      title: `the "${spec}" dream is overdue`,
      detail: "more than two cadence windows have passed without a successful dream run",
      explain:
        "dreams are the consolidation pass — memory decays into noise without them, and an overdue dream usually means the scheduler lane is not firing",
      guidance: "run it now through the job queue, then check why the lane missed its window",
      screen: "schedulers",
      source: "memory",
      action: jobAction("dream-run", "Run the dream now"),
    });
  }

  // --- is it spending safely ----------------------------------------------
  const { declaredUsd, spentUsd } = inputs.budget;
  if (declaredUsd !== null && declaredUsd > 0) {
    const ratio = spentUsd / declaredUsd;
    if (ratio >= 1) {
      open({
        id: "budget-exceeded",
        severity: "critical",
        title: "spend has exceeded the declared budget",
        detail: `$${spentUsd.toFixed(2)} spent against a $${declaredUsd.toFixed(2)} budget`,
        explain:
          "the budget: block is the ceiling you declared for this harness — past it, the runtime's on_exceed ladder decides what still runs",
        guidance: "review the per-model breakdown on Costs, then raise the ceiling or cut a model",
        screen: "costs",
        source: "costs",
        action: linkAction("Open costs"),
      });
    } else if (ratio >= 0.8) {
      open({
        id: "budget-near-limit",
        severity: "warn",
        title: `spend is at ${Math.round(ratio * 100)}% of the declared budget`,
        detail: `$${spentUsd.toFixed(2)} of $${declaredUsd.toFixed(2)}`,
        explain: "at 100% the on_exceed ladder engages — decide now, not at the cliff",
        guidance: "check which model is spending on Costs; a model-usage report shows the split",
        screen: "costs",
        source: "costs",
        action: linkAction("Open costs"),
      });
    }
  } else if (spentUsd > 0) {
    open({
      id: "budget-absent",
      severity: "suggestion",
      title: "no budget declared, and this harness is spending",
      detail: `$${spentUsd.toFixed(2)} recorded with no budget: block in the spec`,
      explain: "a budget: block is the only thing that caps a runaway loop's spend",
      guidance: "declare budget: { usd: <ceiling> } in the spec (a human-owned path — use propose)",
      screen: "costs",
      source: "costs",
      action: linkAction("Open costs", "crewhaus propose"),
    });
  }

  // --- could it be better --------------------------------------------------
  if (!inputs.specUnreadable) {
    for (const [i, issue] of inputs.specIssues.entries()) {
      open({
        id: `spec-issue-${i + 1}`,
        severity: "warn",
        title: "the spec does not validate against this manager's schema",
        detail: issue.message,
        explain:
          "a schema mismatch either means a typo (fix it) or a spec newer than this manager (upgrade the manager) — both are worth knowing now",
        guidance: "open the Spec tab; the parse issues panel lists each diagnostic in place",
        screen: "spec",
        source: "spec",
        action: linkAction("Open the spec"),
      });
    }
  }
  if (inputs.evalRuns === 0 && !inputs.specUnreadable) {
    open({
      id: "evals-none",
      severity: "suggestion",
      title: "no eval signal yet",
      detail: "no eval run is recorded for this harness",
      explain:
        "without an eval history there is no way to see a regression, no baseline to pin, and nothing for the optimizer to improve against",
      guidance: "queue a first eval run; once it lands, pin it as the baseline",
      screen: "evals",
      source: "evals",
      action: jobAction("eval", "Queue an eval run"),
    });
  } else if (inputs.evalRuns > 0 && !inputs.baselinePinned) {
    open({
      id: "evals-no-baseline",
      severity: "suggestion",
      title: "eval history exists but no baseline is pinned",
      detail: `${inputs.evalRuns} run${inputs.evalRuns === 1 ? "" : "s"} recorded, none pinned`,
      explain:
        "a baseline is what turns eval history into a regression alarm — without one, 'healthy' has nothing to mean",
      guidance: "open Evals and pin the run you consider acceptable",
      screen: "evals",
      source: "evals",
      action: linkAction("Open evals"),
    });
  }
  if (inputs.adviceProposals > 0) {
    open({
      id: "advice-waiting",
      severity: "suggestion",
      title: `${inputs.adviceProposals} mined advice proposal${inputs.adviceProposals === 1 ? "" : "s"} waiting`,
      detail: "the advise pass mined applicable spec patches from this harness's sessions",
      explain:
        "each proposal is a concrete SpecPatch with its rationale — advisory until you apply one, and every apply goes back through the spec write path",
      guidance:
        "review them on the Feedback tab; apply is a separate, explicit gesture per proposal",
      screen: "feedback",
      source: "feedback",
      action: linkAction("Review the proposals"),
    });
  }

  const rank: Record<AdvisorSeverity, number> = { critical: 0, warn: 1, suggestion: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// The decisions ledger
// ---------------------------------------------------------------------------

const ADVISOR_SEGMENTS = [".crewhaus", "advisor"] as const;

type DecisionRecord = {
  readonly v: 1;
  readonly itemId: string;
  readonly action: "acted" | "dismissed" | "reopened";
  readonly at: string;
  readonly by: string;
  readonly comment?: string;
  readonly reason?: string;
  readonly jobId?: string;
};

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

/** Fold: for each itemId, the latest dismissal still in force (a later
 *  reopen or act lifts it) and the latest acted record. */
function foldDecisions(records: readonly DecisionRecord[]): {
  dismissed: Map<string, DecisionRecord>;
  acted: Map<string, DecisionRecord>;
} {
  const dismissed = new Map<string, DecisionRecord>();
  const acted = new Map<string, DecisionRecord>();
  for (const rec of records) {
    if (rec.action === "dismissed") dismissed.set(rec.itemId, rec);
    else if (rec.action === "reopened") dismissed.delete(rec.itemId);
    else {
      acted.set(rec.itemId, rec);
      dismissed.delete(rec.itemId);
    }
  }
  return { dismissed, acted };
}

// ---------------------------------------------------------------------------
// Gathering (the impure half — every read tolerant, nothing mutated)
// ---------------------------------------------------------------------------

const ADVICE_SEGMENTS = [".crewhaus", "advice"] as const;

function countAdviceProposals(ctx: M3Context): number {
  const file = readJsonAt(safeContain(ctx, [...ADVICE_SEGMENTS, "suggestions.json"]));
  if (typeof file !== "object" || file === null) return 0;
  const proposals = (file as Record<string, unknown>)["proposals"];
  return Array.isArray(proposals) ? proposals.length : 0;
}

async function gatherInputs(ctx: M3Context, dir: string): Promise<AdvisorInputs> {
  const view = specView(dir, ctx.env);
  let preflight: { items: readonly HealthPreflightItem[] } | null = null;
  try {
    const merged = mergedSpawnEnv(ctx.env, dir);
    const report = await runPreflight({ harnessDir: dir, env: merged.env });
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
  let health: { healthy: boolean; note: string } | null = null;
  try {
    health = evalHealth(`${dir}/.crewhaus/evals`, view.specName);
  } catch {
    health = null;
  }
  return {
    preflight,
    specUnreadable: view.specUnreadable,
    specIssues: view.issues,
    evalHealth: health,
    evalRuns: evals.runs.length,
    baselinePinned: Object.keys(evals.baselines).length > 0,
    openIncidents: countOpenIncidents(dir),
    procState,
    pendingApprovals: pendingApprovalCount(dir),
    budget: {
      declaredUsd: declaredBudgetUsd(yamlText),
      spentUsd: costs.totalUsdMicros / 1_000_000,
    },
    adviceProposals: countAdviceProposals(ctx),
    overdueDreams,
  };
}

/** Derived items with the ledger folded on: dismissals attach and drop items
 *  into the dismissed list; acted records ride along as `lastAction`. */
function assembleFeed(
  items: AdvisorItem[],
  records: readonly DecisionRecord[],
): { open: AdvisorItem[]; dismissed: AdvisorItem[] } {
  const folded = foldDecisions(records);
  const open: AdvisorItem[] = [];
  const dismissed: AdvisorItem[] = [];
  for (const item of items) {
    const dismissal = folded.dismissed.get(item.id);
    const acted = folded.acted.get(item.id);
    const withAction =
      acted !== undefined
        ? {
            ...item,
            lastAction: {
              comment: acted.comment ?? null,
              by: acted.by,
              at: acted.at,
              jobId: acted.jobId ?? null,
            },
          }
        : item;
    if (dismissal !== undefined) {
      dismissed.push({
        ...withAction,
        status: "dismissed",
        dismissal: {
          reason: dismissal.reason ?? "",
          by: dismissal.by,
          at: dismissal.at,
        },
      });
    } else {
      open.push(withAction);
    }
  }
  return { open, dismissed };
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
  const { open, dismissed } = assembleFeed(deriveAdvisorItems(inputs), readDecisions(ctx));
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
    const record = ctx.submitJob(item.action.jobKind, argv);
    job = record;
    jobId = (record as { jobId?: string }).jobId;
  }
  const decision: DecisionRecord = {
    v: 1,
    itemId,
    action: "acted",
    at: new Date(ctx.now()).toISOString(),
    by: ctx.operator,
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
    by: ctx.operator,
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
    by: ctx.operator,
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
 */
export const advisorTrend: M3Handler = (ctx) => {
  const dir = requireDir(ctx);
  const evals = evalsView(dir);
  const evalSeries = [...evals.runs]
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
    .map((r) => ({
      runId: r.runId,
      ts: r.ts,
      passRate: r.passRate,
      datasetName: r.datasetName,
    }));
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
  const summary =
    evalSeries.length === 0
      ? "no eval history yet — improvement is unmeasured until a first run lands"
      : delta === null
        ? "one eval run recorded — a second run makes this a trend"
        : delta > 0.001
          ? `pass rate is up ${(delta * 100).toFixed(1)} points since the first recorded run`
          : delta < -0.001
            ? `pass rate is down ${(Math.abs(delta) * 100).toFixed(1)} points since the first recorded run`
            : "pass rate is flat across the recorded runs";
  return {
    ...found(
      "folded from the eval index, the session cost ledger and the advisor's own decisions — nothing here is a stored snapshot",
      "crewhaus eval crewhaus.yaml",
    ),
    evalSeries,
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
export const REPORT_KINDS = ["model-usage", "costs", "usefulness", "optimization"] as const;
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
    by: ctx.operator,
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
  requireDir(ctx);
  const title = requireString(ctx.body, "title");
  const detail = typeof ctx.body["detail"] === "string" ? (ctx.body["detail"] as string) : "";
  const kindRaw = ctx.body["kind"] ?? "optimize";
  if (!isIssueKind(kindRaw)) {
    throw new HttpError(400, `"kind" must be one of: ${ISSUE_KINDS.join(", ")}`);
  }
  const kind: IssueKind = kindRaw;
  let jobId: string | null = null;
  let jobRecord: unknown = null;
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
    by: ctx.operator,
    update: {
      ready: kind !== "note",
      jobId,
      jobKind: kind === "note" ? null : kind,
      cliTwin: kind === "note" ? null : (CLI_TWIN[kind] ?? null),
      note:
        kind === "note"
          ? "recorded only — no update was queued; pick a kind to turn it into one"
          : kind === "optimize"
            ? "queued the optimize loop — its patch lands as a reviewable spec update, never an automatic write"
            : `queued ${CLI_TWIN[kind] ?? kind} — watch it in the job queue`,
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
    const subCtx: M3Context = {
      ...ctx,
      entry: null,
      harnessDir: h.dir,
      contain: (segments) => {
        // The fleet fold reads OTHER harnesses' trees; each read is contained
        // inside the harness it belongs to, exactly as the per-harness route
        // would contain it.
        const resolved = safeContainIn(h.dir, segments);
        if (resolved === undefined) throw new HttpError(400, "path escapes the harness directory");
        return resolved;
      },
      process: async () => {
        throw new HttpError(400, "no process handle in a fleet fold");
      },
    };
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

/** `resolveInside` for a dir this request did not name — the same realpath
 *  containment the dispatcher applies, applied to a fleet-fold member. */
function safeContainIn(dir: string, segments: readonly string[]): string | undefined {
  return resolveInside(dir, segments);
}
