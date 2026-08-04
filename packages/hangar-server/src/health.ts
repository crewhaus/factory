/**
 * HM-11 — the harness health score: 0–100 with its deductions LISTED.
 *
 * The number is the least important thing this module produces. A bare
 * "72/100" tells an operator nothing they can act on, and a score whose
 * arithmetic lives inside a view cannot be argued with; so the contract
 * here is that {@link computeHealth} returns every deduction it applied,
 * each one carrying:
 *
 *   - `points`  — what it cost, so the total is reconstructible by hand;
 *   - `detail`  — the fact it was derived from, in the operator's words;
 *   - `screen`  — the console tab that FIXES it, so the number is a route
 *                 into the work rather than a verdict about it.
 *
 * Every input is something the console already reads for another panel
 * (§5's data-source notes): the preflight report the Start gate runs, the
 * eval-health verdict the Library column shows, the incident count the
 * inventory folds, the supervision state the process layer holds, the spec
 * lint the Spec tab renders, the capability badges the fleet row carries,
 * and the dream state the schedulers timeline draws. Nothing here opens a
 * transcript or spends money, and — like every read in this server — nothing
 * here writes.
 *
 * PURE. `computeHealth` takes a plain inputs record and returns a plain
 * result; the gathering (which does touch the filesystem) is the caller's,
 * so the weighting can be unit-tested without a fixture harness.
 *
 * DOUBLE-COUNTING IS THE ONE REAL TRAP. Preflight's credentials area and
 * the spec's own `$VAR` reference list describe the same missing key from
 * two directions, and an operator who is missing one API key should not be
 * charged for it twice. The unset-env deduction therefore subtracts only
 * the keys preflight did not already name (it dedupes on `envVar`), and the
 * test suite pins that.
 */

/** The console tab a deduction is fixed on — every value is a real tab in
 *  the harness detail strip (`HARNESS_TABS` in the console's router), so a
 *  deduction can always be rendered as a link. */
export const HEALTH_SCREENS = [
  "overview",
  "spec",
  "runs",
  "schedulers",
  "sessions",
  "evals",
  "memory",
  "data",
  "feedback",
  "costs",
  "creds",
  "channels",
  "security",
  "deploy",
  "inspect",
  "dev",
] as const;
export type HealthScreen = (typeof HEALTH_SCREENS)[number];

export type HealthDeduction = {
  /** Stable id (`preflight:<itemId>`, `eval:baseline`, …) — safe to dedupe
   *  and deep-link on. */
  readonly id: string;
  /** Points subtracted from 100. Always > 0. */
  readonly points: number;
  /** One short line: what is wrong. */
  readonly label: string;
  /** The fact it was derived from. */
  readonly detail: string;
  /** The tab that fixes it. */
  readonly screen: HealthScreen;
};

export type HealthResult = {
  /** 0–100, floor 0. */
  readonly score: number;
  readonly band: "good" | "fair" | "poor";
  /** Every deduction applied, worst first. NEVER empty when score < 100. */
  readonly deductions: readonly HealthDeduction[];
  /** Signals that could not be read at all — an unknown is not a pass, and
   *  saying so is cheaper than pretending the score covered it. */
  readonly unknowns: readonly string[];
  /** One sentence for the card header. */
  readonly summary: string;
};

/** The weights, as data — one table so the arithmetic is reviewable. */
export const HEALTH_WEIGHTS = {
  /** Per blocking preflight item (the Start gate's own refusal set). */
  preflightBlocking: 12,
  preflightBlockingCap: 36,
  /** Latest eval run below its pinned baseline. */
  evalBelowBaseline: 20,
  /** Per open incident. */
  incident: 8,
  incidentCap: 24,
  /** Supervision parked in a state that needs a human. */
  crashLooping: 30,
  terminal: 15,
  /** Per `$VAR` the spec references that is unset AND preflight did not
   *  already charge for. */
  missingCredential: 6,
  missingCredentialCap: 18,
  /** Per `parseSpecIssues` diagnostic; the spec being unreadable is worse
   *  than any number of individual issues. */
  specIssue: 5,
  specIssueCap: 15,
  specUnreadable: 25,
  /** Live provider credentials with no `budget:` block to cap them. */
  unbudgeted: 6,
  /** Per dream spec overdue by more than two windows. */
  dreamOverdue: 5,
  dreamOverdueCap: 10,
} as const;

/** A preflight item, structurally (avoids importing the whole package into
 *  the pure layer — the server passes the real report through). */
export type HealthPreflightItem = {
  readonly id: string;
  readonly area: string;
  readonly level: string;
  readonly message: string;
  readonly remediation?: string;
  readonly envVar?: string;
};

export type HealthInputs = {
  /** The preflight report, or null when it could not be run. */
  readonly preflight: { readonly items: readonly HealthPreflightItem[] } | null;
  /** `evalHealth()` for this harness, or null when unread. */
  readonly evalHealth: { readonly healthy: boolean; readonly note: string } | null;
  readonly openIncidents: number;
  /** Supervision state (`running`, `crash-looping`, `terminal`, …) or null
   *  when the process layer holds no handle for this harness. */
  readonly procState: string | null;
  /** Spec `$VAR` references with SET/UNSET presence (never values). */
  readonly envRefs: ReadonlyArray<{ readonly key: string; readonly set: boolean }>;
  /** `parseSpecIssues` diagnostics. */
  readonly specIssues: ReadonlyArray<{ readonly message: string }>;
  readonly specUnreadable: boolean;
  /** True when the spec declares a `budget:` block. */
  readonly budgeted: boolean;
  /** Dream specs with their overdue verdict (see {@link dreamOverdue}). */
  readonly dreams: ReadonlyArray<{ readonly specName: string } & DreamOverdue>;
};

/**
 * How overdue one dream spec is.
 *
 *   - `neverRan` — no state, unreadable state, or a last run that did not
 *     succeed. Overdue the moment a cadence exists, exactly as
 *     `dream-engine`'s own `overdueOf` treats it, and NOT expressible as a
 *     window count (there is no timestamp to count from).
 *   - `windows` — full cadence windows elapsed since the last successful
 *     run; `null` when the cadence itself could not be read.
 */
export type DreamOverdue = {
  readonly windows: number | null;
  readonly neverRan: boolean;
};

/** Preflight area → the tab that fixes it. */
const AREA_SCREEN: Readonly<Record<string, HealthScreen>> = {
  spec: "spec",
  credentials: "creds",
  channels: "channels",
  mcp: "dev",
  ports: "runs",
  bundle: "runs",
  durability: "memory",
};

/** Supervision states that mean "a human is required" (M2's own vocabulary). */
const CRASH_LOOPING = "crash-looping";
const TERMINAL_STATES = new Set(["terminal", "parked"]);

const clampPoints = (
  deductions: HealthDeduction[],
  made: readonly HealthDeduction[],
  cap: number,
): void => {
  let spent = 0;
  for (const d of made) {
    if (spent >= cap) return;
    const points = Math.min(d.points, cap - spent);
    spent += points;
    deductions.push({ ...d, points });
  }
};

/**
 * Score one harness. Never throws: an input the caller could not read is
 * passed as null and comes back as an `unknown`, because "we did not look"
 * and "we looked and it was fine" are different answers.
 */
export function computeHealth(inputs: HealthInputs): HealthResult {
  const deductions: HealthDeduction[] = [];
  const unknowns: string[] = [];

  // --- preflight: the Start gate's own blocking set -----------------------
  const chargedEnvVars = new Set<string>();
  if (inputs.preflight === null) {
    unknowns.push("preflight did not run — blocking findings are unknown");
  } else {
    const blocking = inputs.preflight.items.filter((i) => i.level === "blocking");
    clampPoints(
      deductions,
      blocking.map((item) => {
        if (item.envVar !== undefined) chargedEnvVars.add(item.envVar);
        return {
          id: `preflight:${item.id}`,
          points: HEALTH_WEIGHTS.preflightBlocking,
          label: `preflight blocks the start: ${item.id}`,
          detail:
            item.remediation !== undefined ? `${item.message} — ${item.remediation}` : item.message,
          screen: AREA_SCREEN[item.area] ?? "overview",
        };
      }),
      HEALTH_WEIGHTS.preflightBlockingCap,
    );
  }

  // --- eval health vs the pinned baseline ---------------------------------
  if (inputs.evalHealth === null) {
    unknowns.push("eval history unread — quality vs baseline is unknown");
  } else if (!inputs.evalHealth.healthy) {
    deductions.push({
      id: "eval:baseline",
      points: HEALTH_WEIGHTS.evalBelowBaseline,
      label: "latest eval run is below its pinned baseline",
      detail: inputs.evalHealth.note,
      screen: "evals",
    });
  }

  // --- open incidents ------------------------------------------------------
  if (inputs.openIncidents > 0) {
    clampPoints(
      deductions,
      Array.from({ length: inputs.openIncidents }, (_v, i) => ({
        id: `incident:${i + 1}`,
        points: HEALTH_WEIGHTS.incident,
        label: "an incident is open",
        detail: `${inputs.openIncidents} unresolved incident record(s) under .crewhaus/incidents`,
        screen: "security" as HealthScreen,
      })),
      HEALTH_WEIGHTS.incidentCap,
    );
  }

  // --- supervision state ---------------------------------------------------
  if (inputs.procState === CRASH_LOOPING) {
    deductions.push({
      id: "proc:crash-looping",
      points: HEALTH_WEIGHTS.crashLooping,
      label: "the daemon is crash-looping",
      detail:
        "restarts hit the crash-loop window, so the supervisor stopped restarting it — it is manual-start-only until the cause is fixed",
      screen: "runs",
    });
  } else if (inputs.procState !== null && TERMINAL_STATES.has(inputs.procState)) {
    deductions.push({
      id: `proc:${inputs.procState}`,
      points: HEALTH_WEIGHTS.terminal,
      label: `supervision is ${inputs.procState}`,
      detail:
        inputs.procState === "parked"
          ? "the run is parked on a human decision — settle it in the approvals inbox"
          : "the last exit was a terminal class, so no restart was attempted",
      screen: "runs",
    });
  }

  // --- credentials the spec names but the environment does not hold -------
  // Deliberately AFTER preflight, and only for keys preflight did not
  // already charge for: one missing key is one problem, not two.
  const unsetRefs = inputs.envRefs.filter((r) => !r.set && !chargedEnvVars.has(r.key));
  clampPoints(
    deductions,
    unsetRefs.map((ref) => ({
      id: `env:${ref.key}`,
      points: HEALTH_WEIGHTS.missingCredential,
      label: `${ref.key} is referenced by the spec but unset`,
      detail:
        "the spec interpolates this variable; nothing in the .env chain or the manager's environment sets it",
      screen: "creds" as HealthScreen,
    })),
    HEALTH_WEIGHTS.missingCredentialCap,
  );

  // --- spec drift ----------------------------------------------------------
  if (inputs.specUnreadable) {
    deductions.push({
      id: "spec:unreadable",
      points: HEALTH_WEIGHTS.specUnreadable,
      label: "crewhaus.yaml is missing or unreadable",
      detail: "nothing downstream — compile, preflight, badges — can be trusted without it",
      screen: "spec",
    });
  } else {
    clampPoints(
      deductions,
      inputs.specIssues.map((issue, i) => ({
        id: `spec:issue:${i + 1}`,
        points: HEALTH_WEIGHTS.specIssue,
        label: "the spec does not validate against this manager's schema",
        detail: issue.message,
        screen: "spec" as HealthScreen,
      })),
      HEALTH_WEIGHTS.specIssueCap,
    );
  }

  // --- an unbudgeted harness that CAN spend --------------------------------
  const hasLiveCredential = inputs.envRefs.some((r) => r.set);
  if (!inputs.budgeted && hasLiveCredential) {
    deductions.push({
      id: "budget:absent",
      points: HEALTH_WEIGHTS.unbudgeted,
      label: "no budget declared, and provider credentials are live",
      detail:
        "this harness can spend without a ceiling — a budget: block is the only thing that caps a runaway loop",
      screen: "costs",
    });
  }

  // --- overdue dreams ------------------------------------------------------
  // §5's threshold is "> 2 windows", so a dream one window late is late, not
  // broken, and costs nothing.
  for (const d of inputs.dreams) {
    if (!d.neverRan && d.windows === null) {
      unknowns.push(`dream "${d.specName}" has no readable cadence — overdue-ness is unknown`);
    }
  }
  const overdue = inputs.dreams.filter((d) => d.neverRan || (d.windows !== null && d.windows > 2));
  clampPoints(
    deductions,
    overdue.map((d) => ({
      id: `dream:${d.specName}`,
      points: HEALTH_WEIGHTS.dreamOverdue,
      label: `the "${d.specName}" dream is overdue`,
      detail: d.neverRan
        ? "no successful dream run is recorded for this spec"
        : `${d.windows} cadence windows have passed since the last successful dream run`,
      screen: "schedulers" as HealthScreen,
    })),
    HEALTH_WEIGHTS.dreamOverdueCap,
  );

  const total = deductions.reduce((n, d) => n + d.points, 0);
  const score = Math.max(0, 100 - total);
  const band = score >= 90 ? "good" : score >= 70 ? "fair" : "poor";
  const summary =
    deductions.length === 0
      ? unknowns.length === 0
        ? "no deductions — every signal this manager reads is clean"
        : `no deductions from the signals that could be read (${unknowns.length} unknown)`
      : `${deductions.length} deduction${deductions.length === 1 ? "" : "s"} totalling ${total} points`;

  return {
    score,
    band,
    deductions: [...deductions].sort((a, b) => b.points - a.points),
    unknowns,
    summary,
  };
}

/**
 * The declared run budget in USD (`budget: { usd: n }`), or null.
 *
 * A TEXT scan, deliberately, for the same reason the capability badges are
 * one: a spec a schema version ahead of this manager must still report its
 * ceiling. `usd` is the only field read — the `on_exceed` ladder is the
 * runtime's business, not the fleet board's.
 */
export function declaredBudgetUsd(yamlText: string): number | null {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^budget\s*:/.test(line));
  if (start === -1) return null;
  const block: string[] = [(lines[start] as string).replace(/^budget\s*:/, "")];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "" || /^[\s#]/.test(line)) block.push(line.replace(/#.*$/, ""));
    else break;
  }
  const m = block.join("\n").match(/(?:^|[\s{,])usd\s*:\s*([0-9]+(?:\.[0-9]+)?)/m);
  if (m?.[1] === undefined) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The overdue verdict for one dream spec, from its cadence and its
 * `state.json`. Mirrors `dream-engine`'s own `overdueOf`: a never-run or
 * last-failed dream is overdue the moment a cadence exists, and there is no
 * timestamp to express that as a window count — hence the separate flag
 * rather than a magic number standing in for "very".
 */
export function dreamOverdue(
  cadenceMs: number | null,
  state: { readonly lastRunAt?: unknown; readonly lastOutcome?: unknown } | null,
  nowMs: number,
): DreamOverdue {
  const outcome = typeof state?.lastOutcome === "string" ? state.lastOutcome : "";
  const last = typeof state?.lastRunAt === "string" ? Date.parse(state.lastRunAt) : Number.NaN;
  const succeeded = outcome === "ok" || outcome === "success";
  if (state === null || Number.isNaN(last) || !succeeded) {
    return { windows: null, neverRan: true };
  }
  if (cadenceMs === null || !Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    return { windows: null, neverRan: false };
  }
  const elapsed = nowMs - last;
  return { windows: elapsed <= 0 ? 0 : Math.floor(elapsed / cadenceMs), neverRan: false };
}

/**
 * Parse the cadence strings `declaredCadences` produces (`every 24h`,
 * `every 30m`, `every 1d (deep)`) into milliseconds. Anything else — a cron
 * expression, "declared (no interval read)" — is `null`: an unknown cadence
 * must not be guessed at, because guessing low invents overdue dreams and
 * guessing high hides real ones.
 */
export function cadenceToMs(cadence: string | null | undefined): number | null {
  if (typeof cadence !== "string") return null;
  const m = cadence.match(/every\s+(\d{1,6})\s*(ms|s|m|h|d)\b/i);
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return n * factor;
}
