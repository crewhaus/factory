/**
 * The Advisor's pure half: the item model, the ranking that turns a harness's
 * signals into open items ({@link deriveAdvisorItems}), and the fold of the
 * act/dismiss/reopen ledger onto those items ({@link foldDecisions},
 * {@link assembleFeed}). Plain data in, plain data out: no file is read here,
 * so the ranking and the ledger mapping are tested in one place and any
 * surface (Home, the CLI, the attention inbox) derives the same items.
 *
 * Gathering the inputs, reading and appending the ledger file, and the job
 * vocabulary a quick action may queue stay with the server that runs them:
 * the twin table a job action shows arrives here as data.
 *
 * Every item id is keyed by its evidence: one item per open incident
 * (`incident-<id>`), the newest pending approval (`approvals-pending-<appr>`),
 * the budget's decile and period (`budget-near-<decile>-<period>`,
 * `budget-exceeded-<period>`) and a digest of a spec issue's message
 * (`spec-issue-<12 hex>`). A dismissal therefore hides only the evidence it was
 * made on. A ledger line written for a count-keyed id hides an item only when
 * that item's evidence is older than the line; a line written for a
 * position-keyed spec issue hides nothing and is reported as applied to an
 * older spec.
 */
import { createHash } from "node:crypto";

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
  /** The job kind the server's closed job vocabulary keys, when kind === "job"; null for links. */
  readonly jobKind: string | null;
};

/**
 * Every console screen an advisor item can name as the owner of its fix: a
 * harness screen by the id the console's link builder takes, or the fleet
 * approvals inbox. `screen-routes.test.ts` sends each through the console's
 * own builders and fails if one lands nowhere.
 */
export const ADVISOR_SCREENS = [
  "overview",
  "approvals",
  "spec",
  "runs",
  "schedulers",
  "evals",
  "memory",
  "feedback",
  "costs",
  "models",
  "creds",
  "channels",
  "security",
  "deploy",
  "dev",
] as const;
export type AdvisorScreen = (typeof ADVISOR_SCREENS)[number];

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
  /** The console screen that owns the fix: a harness screen, or the fleet
   *  approvals inbox. The view renders it as a deep link. */
  readonly screen: AdvisorScreen;
  /** The panel family the signal came from (preflight, spec, evals, …). */
  readonly source: string;
  readonly action: AdvisorAction | null;
  readonly status: "open" | "dismissed";
  /** Present when status === "dismissed": the recorded reasoning. */
  readonly dismissal?: { readonly reason: string; readonly by: string; readonly at: string };
  /** The most recent acted record for this item, when one exists — so the
   *  feed shows "already queued yesterday, with this comment". */
  /** When the newest evidence behind it was recorded (ISO), when the gatherer knows it. */
  readonly evidenceAt?: string;
  readonly lastAction?: {
    readonly comment: string | null;
    readonly by: string;
    readonly at: string;
    readonly jobId: string | null;
  };
};

/** One preflight finding, as the ranking reads it (structurally the preflight item). */
export type AdvisorPreflightItem = {
  readonly id: string;
  readonly area: string;
  readonly level: string;
  readonly message: string;
  readonly remediation?: string;
  readonly envVar?: string;
};

/** Eval health against the pinned baseline. */
export type AdvisorEvalHealthState = "healthy" | "regressed" | "not_measured";

/** Whether a measuring job can start here, and the command that would. */
export type AdvisorLaunchOffer = {
  /** A click can start this job as things stand. */
  readonly offered: boolean;
  /** The harness shape can run it. */
  readonly shapeOk: boolean;
  /** Why not, in plain words. `null` when offered. */
  readonly note: string | null;
  /** The exact command that does this, or `null` when none would work. */
  readonly verb: string | null;
};

/** Job kind → the command it runs, shown beside a job action. Supplied by the caller. */
export type AdvisorJobTwins = Readonly<Record<string, string>>;

/**
 * The item-id charset: one route segment, no leading dot, no separators. The same
 * grammar as Hangar's own `SAFE_SEGMENT_RE`; a test holds the two equal.
 */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const linkAction = (label: string, cliTwin: string | null = null): AdvisorAction => ({
  kind: "link",
  label,
  cliTwin,
  jobKind: null,
});

/** Preflight area → the tab that fixes it (the health module's own table,
 *  restated here so the advisor and the score can be tested independently). */
const AREA_SCREEN: Readonly<Record<string, AdvisorScreen>> = {
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
  readonly preflight: { readonly items: readonly AdvisorPreflightItem[] } | null;
  readonly specUnreadable: boolean;
  readonly specIssues: ReadonlyArray<{ readonly message: string }>;
  readonly evalHealth: { readonly state: AdvisorEvalHealthState; readonly note: string } | null;
  /** Recorded eval runs (0 = no signal yet). */
  readonly evalRuns: number;
  /** The history could not be read, so `evalRuns` and `baselinePinned` say nothing. */
  readonly evalsUnreadable: boolean;
  readonly baselinePinned: boolean;
  /** Which measuring jobs can start here. An item never offers one that cannot. */
  readonly offers: { readonly eval: AdvisorLaunchOffer; readonly optimize: AdvisorLaunchOffer };
  /** The open incident records, by id, with when each was written. */
  readonly openIncidents: readonly OpenIncidentInput[];
  readonly procState: string | null;
  /** The pending approvals, or `null` when they could not be read (nothing is raised). */
  readonly pendingApprovals: PendingApprovalsInput | null;
  readonly budget: { readonly declaredUsd: number | null; readonly spentUsd: number };
  readonly adviceProposals: number;
  readonly overdueDreams: readonly string[];
  // ---- 0.6.0 (design §8.3) — the hybrid-routing signals -------------------
  /** The learned scoreboard and the pool that feeds it. `null` = not pooled. */
  readonly routing: RoutingInputs | null;
  /** Folded from the session logs' durable routing lines. */
  readonly routeStats: RouteStatsInput;
  /** Priced spend by role, from the SAME cost fold the budget item reads. */
  readonly roleSpend: RoleSpendInput;
  /** Models named anywhere in the spec that carry a compiled-in sunset date. */
  readonly sunsets: readonly SunsetInput[];
  /** Registry pins the running (or compiled) bundle was NOT built from. */
  readonly unservedPins: readonly UnservedPinInput[];
};

/** One unresolved incident record: its id (the file's stem) and when it was written. */
export type OpenIncidentInput = { readonly id: string; readonly at: string };

/** The pending approvals: how many, and the newest one. */
export type PendingApprovalsInput = {
  readonly count: number;
  readonly newestId: string;
  readonly newestAt: string;
};

/** The period a budget is counted over until a spec declares one. */
export const BUDGET_PERIOD = "total";

/** The first 12 hex characters of a spec issue's message digest: its id. */
export function specIssueKey(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex").slice(0, 12);
}

/** One arm, reduced to what the ranking needs. */
export type AdvisorArm = {
  /** The routing band (`easy`, `hard`, `shadow:easy`, …). */
  readonly band: string;
  readonly model: string;
  readonly n: number;
  readonly meanReward: number;
  readonly shadow: boolean;
};

export type RoutingInputs = {
  readonly arms: readonly AdvisorArm[];
  /**
   * The declared pool policy (`static` when omitted). A spec that declares
   * pools at more than one host with more than one policy reads `mixed` —
   * the advisor never picks one host's answer and calls it the harness's.
   */
  readonly policy: string;
  readonly candidates: number;
  /**
   * True when ANY declared pool is already `learned`. `policy-flip-ready`
   * proposes a flip that has already happened otherwise: a crew harness's
   * per-role pool is a pool this manager must not overlook. Absent reads as
   * false, so a caller that knows only `policy` behaves as it always did.
   */
  readonly learnedAnywhere?: boolean;
};

export type RouteStatsInput = {
  /** `model_route` lines across the sessions read. */
  readonly decisions: number;
  /** `model_stage` lines whose stage is an escalation. */
  readonly escalations: number;
};

export type RoleSpendInput = {
  readonly totalUsdMicros: number;
  /** role → priced micros, from `foldHarnessCosts().byRole`. */
  readonly byRole: Readonly<Record<string, number>>;
};

export type SunsetInput = {
  readonly model: string;
  readonly retiresOn: string;
  readonly replacement: string | null;
  /** True once the retirement date has passed. */
  readonly past: boolean;
};

export type UnservedPinInput = {
  readonly env: string;
  readonly version: string;
  readonly detail: string;
};

/**
 * How many observations an arm needs before "this candidate is losing" or
 * "the policy is ready to flip" is a claim rather than a coin toss.
 *
 * It is the router's OWN exploration floor (`DEFAULT_MIN_SAMPLES` in
 * `@crewhaus/model-router`'s policy router), so `policy-flip-ready` fires
 * exactly when a `learned` policy would start exploiting rather than
 * exploring. Restated rather than imported: the advisor ranks a snapshot
 * read off disk and has no business pulling the router into the manager.
 */
export const ARM_SAMPLE_FLOOR = 25;

/** Reward gap below the band leader that makes a candidate worth naming. */
export const UNDERPERFORMING_GAP = 0.15;

/** Auxiliary spend share above which the judge is the story, not the agent. */
export const JUDGE_SPEND_SHARE = 0.4;

/** Escalation share above which the cheap lane is not earning its place. */
export const ESCALATION_RATE_CEILING = 0.3;

/** Roles whose spend is auxiliary to the turn the user is waiting on. */
const JUDGE_ROLES = ["judge", "committee"] as const;

/**
 * Inputs → open items, worst first. Pure. The ordering inside a severity
 * tier is derivation order, which follows the operator's own triage order:
 * can it start, is it healthy, is it spending safely, could it be better.
 */
export function deriveAdvisorItems(
  inputs: AdvisorInputs,
  jobTwins: AdvisorJobTwins = {},
): AdvisorItem[] {
  const jobAction = (jobKind: string, label: string): AdvisorAction => ({
    kind: "job",
    label,
    cliTwin: Object.hasOwn(jobTwins, jobKind) ? (jobTwins[jobKind] as string) : null,
    jobKind,
  });
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
        item.area === "workspace"
          ? "a harness's tools work inside its directory, so a harness gets a directory of its own; Start anyway runs it where it is, for that start"
          : "this is the Start gate's own refusal set: a daemon started anyway would exit on boot, so nothing runs until it clears",
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
  if (inputs.evalHealth?.state === "regressed") {
    const offer = inputs.offers.optimize;
    open({
      id: "eval-below-baseline",
      severity: "warn",
      title: "quality regressed below the pinned baseline",
      detail: inputs.evalHealth.note,
      explain:
        "the latest eval run scored under the run you pinned as acceptable — users are seeing worse answers than the ones you signed off on",
      guidance: offer.offered
        ? "queue an optimize run: the eval→patch loop searches the spec's tunable paths and emits an update ready to review and run"
        : (offer.note ?? ""),
      screen: "evals",
      source: "evals",
      action: offer.offered
        ? jobAction("optimize", "Queue an optimize run")
        : linkAction("Open evals", offer.verb),
    });
  }
  for (const incident of inputs.openIncidents) {
    open({
      id: safeId(`incident-${incident.id}`),
      severity: "warn",
      title: `incident record ${incident.id} is open`,
      detail: "an unresolved record under .crewhaus/incidents",
      explain:
        "an incident file is written when something tripped a runtime guard; leaving it open means nobody has judged whether it can recur",
      guidance: "review the record on the Security tab and resolve or escalate it",
      screen: "security",
      source: "security",
      action: linkAction("Open security"),
      evidenceAt: incident.at,
    });
  }
  const pending = inputs.pendingApprovals;
  if (pending !== null && pending.count > 0) {
    open({
      id: safeId(`approvals-pending-${pending.newestId}`),
      severity: "warn",
      title: `${pending.count} approval${pending.count === 1 ? "" : "s"} waiting`,
      detail: "tool calls are parked for a human verdict",
      explain:
        "each parked call is a session holding its breath — the agent cannot finish that turn until someone grants or denies",
      guidance: "triage them in the approvals inbox (j/k to move, one key per verdict)",
      screen: "approvals",
      source: "approvals",
      action: linkAction("Open approvals"),
      evidenceAt: pending.newestAt,
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
        id: `budget-exceeded-${BUDGET_PERIOD}`,
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
        id: `budget-near-${Math.min(9, Math.floor(ratio * 10))}-${BUDGET_PERIOD}`,
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
    const seen = new Set<string>();
    for (const issue of inputs.specIssues) {
      const key = specIssueKey(issue.message);
      if (seen.has(key)) continue;
      seen.add(key);
      open({
        id: `spec-issue-${key}`,
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
  if (inputs.evalsUnreadable) {
    // A history nobody can read is not an empty one, so nothing here can be said.
  } else if (inputs.evalRuns === 0 && !inputs.specUnreadable) {
    const offer = inputs.offers.eval;
    open({
      id: "evals-none",
      severity: "suggestion",
      title: "no eval signal yet",
      detail: "no eval run is recorded for this harness",
      explain:
        "without an eval history there is no way to see a regression, no baseline to pin, and nothing for the optimizer to improve against",
      guidance: offer.offered
        ? "queue a first eval run; once it lands, pin it as the baseline"
        : (offer.note ?? ""),
      screen: "evals",
      source: "evals",
      action: offer.offered
        ? jobAction("eval", "Queue an eval run")
        : linkAction("Open evals", offer.verb),
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

  // --- is it routing well (0.6.0 §8.3) -------------------------------------
  // Every item here is derived from a file another panel already reads: the
  // routing scoreboard, the session logs' durable routing lines, the cost
  // fold's per-role split, the compiled-in sunset table, and the spec
  // registry's pins. The advisor still measures nothing new.
  const routing = inputs.routing;
  if (routing !== null) {
    const live = routing.arms.filter((a) => !a.shadow);
    const ready = live.length > 1 && live.every((a) => a.n >= ARM_SAMPLE_FLOOR);
    if (ready && routing.policy !== "learned" && routing.learnedAnywhere !== true) {
      open({
        id: "policy-flip-ready",
        severity: "suggestion",
        title: "every routing arm has enough samples for a learned policy",
        detail: `${live.length} arms, each with at least ${ARM_SAMPLE_FLOOR} observations, under policy "${routing.policy}"`,
        explain:
          "a static or heuristic policy picks the same way forever; the scoreboard now has enough evidence for the learned policy to exploit the arm that is actually winning each band",
        guidance:
          "run `route propose` — it mines the arms and emits a reviewable spec patch; the flip is never applied for you",
        screen: "models",
        source: "routing",
        action: jobAction("route-propose", "Propose the policy flip"),
      });
    }
    // Worst offender per band, so a four-candidate pool does not produce four
    // near-identical rows for one decision.
    const byBand = new Map<string, AdvisorArm[]>();
    for (const arm of live) {
      const group = byBand.get(arm.band) ?? [];
      group.push(arm);
      byBand.set(arm.band, group);
    }
    for (const band of [...byBand.keys()].sort()) {
      const group = [...(byBand.get(band) ?? [])].sort((a, b) => b.meanReward - a.meanReward);
      const leader = group[0];
      const worst = group[group.length - 1];
      if (leader === undefined || worst === undefined || leader === worst) continue;
      if (worst.n < ARM_SAMPLE_FLOOR) continue;
      const gap = leader.meanReward - worst.meanReward;
      if (gap < UNDERPERFORMING_GAP) continue;
      open({
        id: safeId(`candidate-underperforming-${band}-${worst.model}`),
        severity: "suggestion",
        title: `"${worst.model}" is losing its band by ${gap.toFixed(2)} reward`,
        detail: `band ${band}: ${worst.model} scores ${worst.meanReward.toFixed(3)} over ${worst.n} observations against ${leader.model} at ${leader.meanReward.toFixed(3)}`,
        explain:
          "reward folds success, cost and latency (and judged quality when a quality source is wired) — a candidate this far behind is spending turns to lose them",
        guidance:
          "the roster is human-owned: review the arm on the Models tab, then remove or re-tag the candidate through `crewhaus propose`",
        screen: "models",
        source: "routing",
        action: jobAction("route-status", "Show the scoreboard"),
      });
    }
    const auditionable = routing.arms.filter((a) => a.shadow && a.n >= ARM_SAMPLE_FLOOR);
    for (const arm of auditionable) {
      open({
        id: safeId(`audition-ready-${arm.band}-${arm.model}`),
        severity: "suggestion",
        title: `the shadow audition of "${arm.model}" has enough runs to judge`,
        detail: `${arm.n} observed turns on the observe-only lane ${arm.band}, mean reward ${arm.meanReward.toFixed(3)}`,
        explain:
          "a shadow lane serves nothing — it watches the primary and is graded beside it, so promoting it is the first moment its answers reach a user",
        guidance:
          "`route promote` gates the audition against its own eval runs before the candidate can serve; nothing promotes itself",
        screen: "models",
        source: "routing",
        action: jobAction("route-status", "Show the audition lane"),
      });
    }
  }

  const decisions = inputs.routeStats.decisions;
  if (decisions > 0) {
    const rate = inputs.routeStats.escalations / decisions;
    if (rate > ESCALATION_RATE_CEILING) {
      open({
        id: "escalation-rate-high",
        severity: "warn",
        title: `${Math.round(rate * 100)}% of routed turns escalated to a stronger model`,
        detail: `${inputs.routeStats.escalations} escalations across ${decisions} routing decisions`,
        explain:
          "a cascade only saves money while the cheap draft usually passes; past that the harness pays for the draft AND the escalation, and answers arrive later than if the strong model had gone first",
        guidance:
          "tighten the draft's routing rules or move the band boundary — `models explain` prints which rule sent each turn to the cheap lane",
        screen: "models",
        source: "routing",
        action: jobAction("models-explain", "Explain the routing"),
      });
    }
  }

  const spendTotal = inputs.roleSpend.totalUsdMicros;
  if (spendTotal > 0) {
    let auxiliary = 0;
    for (const role of JUDGE_ROLES) auxiliary += inputs.roleSpend.byRole[role] ?? 0;
    const share = auxiliary / spendTotal;
    if (share > JUDGE_SPEND_SHARE) {
      open({
        id: "judge-spend-dominates",
        severity: "warn",
        title: `the judge is ${Math.round(share * 100)}% of this harness's spend`,
        detail: `$${(auxiliary / 1_000_000).toFixed(4)} of $${(spendTotal / 1_000_000).toFixed(4)} went to grading rather than answering`,
        explain:
          "grading every turn with a strong judge can cost more than answering with one — which inverts the whole point of a cheap-worker topology",
        guidance:
          "cap it with budget.judge_share, sample the judge instead of grading every turn, or give the judge its own cheaper profile",
        screen: "models",
        source: "costs",
        action: linkAction("Open the models tab", "crewhaus cost-summary --session <id>"),
      });
    }
  }

  for (const sunset of inputs.sunsets) {
    open({
      id: safeId(`sunset-in-roster-${sunset.model}`),
      severity: sunset.past ? "warn" : "suggestion",
      title: sunset.past
        ? `"${sunset.model}" is past its retirement date`
        : `"${sunset.model}" retires on ${sunset.retiresOn}`,
      detail:
        sunset.replacement !== null
          ? `retires ${sunset.retiresOn}; the provider names ${sunset.replacement} as the replacement`
          : `retires ${sunset.retiresOn}`,
      explain:
        "a retired model stops answering on the provider's schedule, not yours — the harness fails at boot or mid-run, whichever comes first",
      guidance:
        "swap the model on the Models tab through `crewhaus propose`; `models audit` names every slot that still references it",
      screen: "models",
      source: "routing",
      action: jobAction("models-audit", "Audit the roster"),
    });
  }

  for (const pin of inputs.unservedPins) {
    open({
      id: safeId(`restart-to-serve-pin-${pin.env}`),
      severity: "warn",
      title: `the ${pin.env} pin is newer than the bundle this harness serves`,
      detail: `${pin.env} → ${pin.version}: ${pin.detail}`,
      explain:
        "nothing propagates a registry pin to a running daemon — a promote ends at the registry, and the daemon keeps serving the bundle it was started with until someone recompiles and restarts",
      guidance:
        "recompile from the pinned version and restart the daemon; the Deployments tab shows both sides of the comparison",
      screen: "deploy",
      source: "deployments",
      action: jobAction("compile", "Recompile the bundle"),
    });
  }

  const rank: Record<AdvisorSeverity, number> = { critical: 0, warn: 1, suggestion: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ---------------------------------------------------------------------------
// The decisions ledger, folded
// ---------------------------------------------------------------------------

/** One act/dismiss/reopen line, as the ledger reader parsed it. */
export type DecisionRecord = {
  readonly v: 1;
  readonly itemId: string;
  readonly action: "acted" | "dismissed" | "reopened";
  readonly at: string;
  readonly by: string;
  readonly comment?: string;
  readonly reason?: string;
  readonly jobId?: string;
};

/** Fold: for each itemId, the latest dismissal still in force (a later
 *  reopen or act lifts it) and the latest acted record. */
export function foldDecisions(records: readonly DecisionRecord[]): {
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

/**
 * The ids a 0.8 ledger keyed by count, and the family of evidence-keyed ids each one
 * stood for. A line for one of them hides an item of its family only when the item's
 * evidence is older than the line: a dismissal hides what it was made on, never what
 * came after it. An item that does not say when its evidence was recorded (a budget
 * item) is not hidden by such a line.
 */
export const LEGACY_ITEM_FAMILIES: ReadonlyArray<{
  readonly legacy: string;
  readonly prefix: string;
}> = [
  { legacy: "incidents-open", prefix: "incident-" },
  { legacy: "approvals-pending", prefix: "approvals-pending-" },
  { legacy: "budget-near-limit", prefix: "budget-near-" },
  { legacy: "budget-exceeded", prefix: "budget-exceeded-" },
];

/** A spec issue's id by its position, as a 0.8 ledger wrote it. It names no issue now. */
export const POSITIONAL_SPEC_ISSUE_RE = /^spec-issue-[0-9]{1,4}$/;

/** The line for this item's legacy family that applies to it, if any. */
function legacyLine(
  item: AdvisorItem,
  lines: ReadonlyMap<string, DecisionRecord>,
): DecisionRecord | undefined {
  const family = LEGACY_ITEM_FAMILIES.find((f) => item.id.startsWith(f.prefix));
  if (family === undefined || item.evidenceAt === undefined) return undefined;
  const line = lines.get(family.legacy);
  if (line === undefined) return undefined;
  const evidence = Date.parse(item.evidenceAt);
  const at = Date.parse(line.at);
  return Number.isFinite(evidence) && Number.isFinite(at) && evidence < at ? line : undefined;
}

/** Derived items with the ledger folded on: dismissals attach and drop items
 *  into the dismissed list; acted records ride along as `lastAction`.
 *  `olderSpec` lists the dismissals in force for spec issues named by their
 *  position: they were made on an older spec, and hide nothing now. */
export function assembleFeed(
  items: AdvisorItem[],
  records: readonly DecisionRecord[],
): { open: AdvisorItem[]; dismissed: AdvisorItem[]; olderSpec: DecisionRecord[] } {
  const folded = foldDecisions(records);
  const open: AdvisorItem[] = [];
  const dismissed: AdvisorItem[] = [];
  for (const item of items) {
    const dismissal = folded.dismissed.get(item.id) ?? legacyLine(item, folded.dismissed);
    const acted = folded.acted.get(item.id) ?? legacyLine(item, folded.acted);
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
  const olderSpec = [...folded.dismissed.values()].filter((line) =>
    POSITIONAL_SPEC_ISSUE_RE.test(line.itemId),
  );
  return { open, dismissed, olderSpec };
}
