/**
 * `crewhaus route` — inspect, explain, and reset adaptive model routing
 * (the `agent.model_pool` reward scoreboard + per-turn routing decisions).
 *
 *   route status  [--dir <root>] [--by profile|scope] [--shadow] [--json]
 *                                        show the learned arms, best-per-bucket first
 *   route explain <session> [--dir …] [--json]
 *                                        replay a run's per-turn routing timeline
 *   route reset   [--dir <root>]         wipe the scoreboard (kill switch)
 *   route freeze  <policyVersion> [--reason <text>] [--dir <root>]
 *                                        pin the learned policy (kill switch #2)
 *   route freeze  --clear [--dir <root>] lift the pin
 *   route promote [--gate] [--spec <n>] [--dry-run] [--json] [--dir <root>]
 *                                        fold the observe-only `q:` / `shadow:`
 *                                        lanes into live arms, once a routed
 *                                        eval has authorized it (§6.3)
 *
 * `--dir` points at the `.crewhaus` root (default `.crewhaus`); the scoreboard
 * lives at `<root>/routing/arms.jsonl` and session logs at
 * `<root>/sessions/<id>.jsonl`. `status` surfaces the ACCUMULATED learning a
 * `learned` policy exploits; `explain` shows WHY each turn of one run picked
 * the model it did (including ε-greedy exploration draws).
 *
 * 0.6.0 §6.3 / §10.1 — `route freeze <policyVersion>` writes
 * `<root>/routing/freeze.json`; while it exists every pooled run in that root
 * routes off the frozen history, records no new observation and reports the
 * frozen `policyVersion` on its `model_route` lines. `route reset` removes the
 * marker too (it wipes the whole routing state).
 *
 * 0.6.0 §8.2 — `route explain` is a TIMELINE, not just a route table: the
 * durable `model_route` lines interleaved with the `model_directive` lines a
 * typed input seam produced (PR 9b) and the `model_stage` lines a hybrid
 * strategy produced (PRs 9c/9d), in turn order. `--json` renders every
 * durable field verbatim — `hint`, `hasImages`, `eligible`, `ruleId`,
 * `classifierVerdict`, `policy`, `profile`, `armId`, `scope`,
 * `toolsetFingerprint`, `floor`, `backedOffTo` — so a reviewer reads the
 * decision rather than a rendering of it.
 *
 * 0.6.0 §9.1 — `route propose` mines the scoreboard (and the installed
 * priors) into `SpecPatch`es on WHITELISTED paths only, written as the same
 * `suggestions.json` `crewhaus advise` emits, so `optimize --from-advice`
 * eval-gates them through `gateRuns` before anything is written back. The
 * roster itself is never proposed — that is `models propose`'s PR door.
 *
 * 0.6.0 §6.3 — `route promote` is the ONE sanctioned path out of the
 * observe-only lanes: the offline `q:<band>` join and the online
 * `shadow:<scope>/<band>` audition never steer a live decision on their own
 * (PR 9d/PR 10 settled that committee and shadow member arms do not fold),
 * so folding them is a deliberate, eval-gated, audited act. The gate itself
 * lives in `./route-promote`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ArmStats,
  type RouteFreeze,
  SHADOW_LANE_PREFIX,
  clearRouteFreeze,
  isObserveOnlyLane,
  openScoreboard,
  readRouteFreeze,
  writeRouteFreeze,
} from "@crewhaus/routing-store";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { specHasPath } from "@crewhaus/spec-patch";
import { type RoutePromoteOptions, runRoutePromote } from "./route-promote";
import { buildRouteProposals, formatRouteProposals, routeSuggestionsFile } from "./route-propose";

export type RouteArgs = {
  readonly sub: "status" | "reset" | "explain" | "freeze" | "promote" | "propose";
  readonly dir: string;
  /** Session id — required for `explain`. */
  readonly session?: string;
  /** `freeze <policyVersion>` — the pool fingerprint to pin (absent with `--clear`). */
  readonly policyVersion?: string;
  /** `freeze --clear` — lift the pin. */
  readonly clear?: boolean;
  /** `freeze --reason <text>` — an operator note on the marker. */
  readonly reason?: string;
  /** `promote --gate` — map a refused promotion to a non-zero exit. */
  readonly gate?: boolean;
  /** `promote --dry-run` — report the fold without writing anything. */
  readonly dryRun?: boolean;
  /** `promote --json` — machine-readable output. */
  readonly json?: boolean;
  /** `promote --spec <name>` — restrict the authorizing eval run to one spec. */
  readonly spec?: string;
  /** `status --by profile|scope` — regroup the arm table (§8.2). */
  readonly by?: "profile" | "scope";
  /** `status --shadow` — include the observe-only `q:`/`shadow:` lanes. */
  readonly shadow?: boolean;
  /** `propose -o <dir>` — where the suggestions bundle lands. */
  readonly out?: string;
};

const DEFAULT_ROOT = ".crewhaus";

/** Parse `route <sub> [<session>] [--dir <root>]` argv (everything after `route`). */
export function parseRouteArgs(argv: readonly string[]): RouteArgs {
  let dir = DEFAULT_ROOT;
  let sub: RouteArgs["sub"] | undefined;
  let session: string | undefined;
  let policyVersion: string | undefined;
  let clear = false;
  let reason: string | undefined;
  let gate = false;
  let dryRun = false;
  let json = false;
  let spec: string | undefined;
  let by: "profile" | "scope" | undefined;
  let shadow = false;
  let out: string | undefined;
  const USAGE =
    "status [--by profile|scope] [--shadow] [--json] | reset | explain <session> [--json] | " +
    "freeze <policyVersion> [--reason <text>] | freeze --clear | " +
    "promote [--gate] [--spec <name>] [--dry-run] [--json] | propose [--json] [-o <dir>] [--dir <root>]";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route: --dir requires a path");
      dir = v;
      i++;
    } else if (
      sub === undefined &&
      (a === "status" ||
        a === "reset" ||
        a === "explain" ||
        a === "freeze" ||
        a === "promote" ||
        a === "propose")
    ) {
      // A subcommand keyword is only the subcommand when it comes FIRST; after
      // that the same word is a plain positional (so `route explain status`
      // explains a session literally named "status", not runs `status`).
      sub = a;
    } else if (sub === "explain" && session === undefined && !a.startsWith("--")) {
      session = a; // the session id positional (only `explain` takes one)
    } else if (sub === "freeze" && a === "--clear") {
      clear = true;
    } else if (sub === "freeze" && a === "--reason") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route freeze: --reason requires a text");
      reason = v;
      i++;
    } else if (sub === "freeze" && policyVersion === undefined && !a.startsWith("--")) {
      policyVersion = a; // the policyVersion positional
    } else if (sub === "promote" && a === "--gate") {
      gate = true;
    } else if (sub === "promote" && a === "--dry-run") {
      dryRun = true;
    } else if (
      a === "--json" &&
      (sub === "promote" || sub === "explain" || sub === "status" || sub === "propose")
    ) {
      json = true;
    } else if (sub === "status" && a === "--by") {
      const v = argv[i + 1];
      if (v !== "profile" && v !== "scope") {
        throw new Error('route status: --by must be "profile" or "scope"');
      }
      by = v;
      i++;
    } else if (sub === "status" && a === "--shadow") {
      shadow = true;
    } else if (sub === "propose" && (a === "-o" || a === "--out")) {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route propose: -o requires a directory");
      out = v;
      i++;
    } else if (sub === "promote" && a === "--spec") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route promote: --spec requires a spec name");
      spec = v;
      i++;
    } else {
      throw new Error(`route: unknown argument "${a}" (expected: ${USAGE})`);
    }
  }
  if (sub === undefined) {
    throw new Error(`route: expected a subcommand (${USAGE})`);
  }
  if (sub === "explain" && session === undefined) {
    throw new Error("route explain: a <session> id is required");
  }
  if (sub === "freeze") {
    if (clear && policyVersion !== undefined) {
      throw new Error("route freeze: pass either a <policyVersion> to pin or --clear, not both");
    }
    if (!clear && policyVersion === undefined) {
      throw new Error(
        "route freeze: a <policyVersion> is required (the `policyVersion` on a model_route line — see `route explain`), or --clear to lift a pin",
      );
    }
  }
  return {
    sub,
    dir,
    ...(session !== undefined ? { session } : {}),
    ...(policyVersion !== undefined ? { policyVersion } : {}),
    ...(clear ? { clear } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(gate ? { gate } : {}),
    ...(dryRun ? { dryRun } : {}),
    ...(json ? { json } : {}),
    ...(spec !== undefined ? { spec } : {}),
    ...(by !== undefined ? { by } : {}),
    ...(shadow ? { shadow } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}

/** Snapshot the scoreboard arms (sorted routeKey then model). */
export function loadArms(rootDir: string): ArmStats[] {
  return openScoreboard(rootDir).snapshot();
}

/**
 * 0.6.0 §8.2 — how `route status` groups the arm table. `band` (the default)
 * is the pre-0.6.0 grouping by routeKey; `profile` groups by arm id, which is
 * the profile name for a profiled candidate, so one row per roster member
 * across every band; `scope` groups by the routeKey's scope prefix
 * (`<scope>/<band>`), which is how a workflow step / graph node / crew role
 * separates its own routing from the run's.
 */
export type RouteStatusGrouping = "band" | "profile" | "scope";

/** The scope half of a scoped routeKey (`step-a/hard` → `step-a`), else `-`. */
function scopeOf(routeKey: string): string {
  const live = routeKey.replace(/^(q:|shadow:)/, "");
  const slash = live.indexOf("/");
  return slash > 0 ? live.slice(0, slash) : "-";
}

/**
 * Render the scoreboard as a human table: grouped by routeKey, best mean-reward
 * arm first within each bucket and starred (the arm a `learned` policy would
 * exploit once every arm clears its sample floor).
 *
 * 0.6.0 §8.2 — the observe-only lanes (`q:` / `shadow:`) are HIDDEN unless
 * `shadow` is set: they never steer a live decision, so listing them beside
 * the live arms by default would misread as "these arms are serving". `by`
 * regroups the same rows without changing a single number.
 */
export function formatRouteStatus(
  arms: readonly ArmStats[],
  opts: { readonly by?: RouteStatusGrouping; readonly shadow?: boolean } = {},
): string {
  const shown = opts.shadow === true ? arms : arms.filter((a) => !isObserveOnlyLane(a.routeKey));
  if (shown.length === 0) {
    const hidden = arms.length - shown.length;
    return hidden > 0
      ? `No LIVE routing arms yet — ${hidden} observe-only lane arm(s) exist (\`route status --shadow\` shows them; they never steer a live decision until \`route promote\`).`
      : "No routing data yet. Run a harness whose spec declares `agent.model_pool` to accumulate arms.";
  }
  const by = opts.by ?? "band";
  const keyOf = (a: ArmStats): string =>
    by === "profile" ? a.model : by === "scope" ? scopeOf(a.routeKey) : a.routeKey;
  const header = by === "profile" ? "arm" : by === "scope" ? "scope" : "routeKey";
  const secondary = by === "profile" ? "routeKey" : "model";
  const secondaryOf = (a: ArmStats): string => (by === "profile" ? a.routeKey : a.model);
  const grouped = new Map<string, ArmStats[]>();
  for (const a of shown) {
    const g = grouped.get(keyOf(a)) ?? [];
    g.push(a);
    grouped.set(keyOf(a), g);
  }
  const lines: string[] = [];
  lines.push(
    `${header.padEnd(14)} ${secondary.padEnd(28)} ${"n".padStart(5)} ${"reward".padStart(7)} ${"quality".padStart(8)} ${"latency".padStart(9)} ${"cost".padStart(10)}`,
  );
  for (const key of [...grouped.keys()].sort()) {
    const group = (grouped.get(key) ?? []).slice().sort((x, y) => y.meanReward - x.meanReward);
    group.forEach((a, i) => {
      const star = i === 0 && a.n > 0 ? " *" : "";
      const latency = `${a.meanLatencyMs.toFixed(0)}ms`;
      const cost = a.meanCostUsd > 0 ? `$${a.meanCostUsd.toFixed(5)}` : "-";
      const quality = a.qualityCount > 0 ? a.meanQuality.toFixed(3) : "-";
      lines.push(
        `${key.padEnd(14)} ${secondaryOf(a).padEnd(28)} ${String(a.n).padStart(5)} ${a.meanReward.toFixed(3).padStart(7)} ${quality.padStart(8)} ${latency.padStart(9)} ${cost.padStart(10)}${star}`,
      );
    });
  }
  lines.push("");
  lines.push(
    `* = current best arm in its ${by === "band" ? "bucket" : by} (what a \`learned\` policy exploits once every arm clears its sample floor).`,
  );
  const laneArms = arms.filter((a) => isObserveOnlyLane(a.routeKey));
  if (laneArms.length > 0) {
    lines.push(
      opts.shadow === true
        ? `Rows whose key starts \`${SHADOW_LANE_PREFIX}\` or \`q:\` are OBSERVE-ONLY: they steer nothing until \`crewhaus route promote\` folds them.`
        : `${laneArms.length} observe-only lane arm(s) hidden — \`route status --shadow\` shows the audition.`,
    );
  }
  return lines.join("\n");
}

/** The machine-readable `route status` payload (`--json`). */
export function routeStatusJson(
  arms: readonly ArmStats[],
  freeze: RouteFreeze | undefined,
  opts: { readonly by?: RouteStatusGrouping; readonly shadow?: boolean } = {},
): {
  readonly by: RouteStatusGrouping;
  readonly frozen?: RouteFreeze;
  readonly arms: ReadonlyArray<
    ArmStats & { readonly lane: "live" | "observe-only"; readonly scope: string }
  >;
} {
  const shown = opts.shadow === true ? arms : arms.filter((a) => !isObserveOnlyLane(a.routeKey));
  return {
    by: opts.by ?? "band",
    ...(freeze !== undefined ? { frozen: freeze } : {}),
    arms: shown.map((a) => ({
      ...a,
      lane: isObserveOnlyLane(a.routeKey) ? ("observe-only" as const) : ("live" as const),
      scope: scopeOf(a.routeKey),
    })),
  };
}

/**
 * Wipe the whole scoreboard — and the freeze marker, since a reset is "start
 * the learning over", not "keep serving a pinned policy over an empty store".
 * Returns the number of arms removed.
 */
export function resetRouting(rootDir: string): number {
  const removed = loadArms(rootDir).length;
  const path = join(rootDir, "routing", "arms.jsonl");
  if (existsSync(path)) rmSync(path, { force: true });
  clearRouteFreeze(rootDir);
  return removed;
}

/** The freeze marker in force for `rootDir`, if any (a malformed one reads as absent). */
export function loadRouteFreeze(rootDir: string): RouteFreeze | undefined {
  return readRouteFreeze(rootDir);
}

/** Render the freeze state as the one-line banner `route status` prints. */
export function formatRouteFreeze(freeze: RouteFreeze | undefined): string {
  if (freeze === undefined) return "";
  const when = freeze.frozenAt.length > 0 ? ` since ${freeze.frozenAt}` : "";
  const why = freeze.reason !== undefined ? ` — ${freeze.reason}` : "";
  return `FROZEN at policyVersion ${freeze.policyVersion}${when}${why}. Pooled runs route off the recorded history and record nothing new; \`crewhaus route freeze --clear\` lifts it.`;
}

/** Pin the learned policy: write the freeze marker. Returns the persisted record. */
export function freezeRouting(
  rootDir: string,
  policyVersion: string,
  reason?: string,
  now?: () => number,
): RouteFreeze {
  return writeRouteFreeze(rootDir, {
    policyVersion,
    ...(reason !== undefined ? { reason } : {}),
    ...(now !== undefined ? { now } : {}),
  });
}

/**
 * One persisted `model_route` decision from a session log, with every durable
 * 0.6.0 field the runtime writes (§8.1). Optional fields are absent exactly
 * when the line did not carry them, so a pre-0.6.0 session replays with the
 * same four columns it always had.
 */
export type RouteDecision = {
  readonly turnNumber?: number;
  readonly routeKey: string;
  readonly model: string;
  readonly policy: string;
  readonly reason: string;
  readonly explored?: boolean;
  readonly policyVersion?: string;
  // ---- 0.6.0 durable attribution
  /** The spec model string, when it differs from the wire id. */
  readonly specModel?: string;
  /** The `models:` profile of the serving candidate. */
  readonly profile?: string;
  /**
   * The scoreboard arm this decision was recorded under: the profile name for
   * a profiled candidate, else the spec model string, else the wire id — the
   * `profile ?? model` identity `recordPoolOutcome` keys on. DERIVED here
   * rather than persisted, because the durable line carries the two halves
   * and stamping a third would let them disagree.
   */
  readonly armId: string;
  readonly scope?: string;
  readonly toolsetFingerprint?: string;
  readonly stage?: string;
  readonly strategy?: string;
  readonly ruleId?: string;
  readonly classifierVerdict?: string;
  readonly eligible?: ReadonlyArray<string>;
  readonly hint?: Record<string, unknown>;
  /** Derived per-turn signals (never the user's text). */
  readonly signals?: Record<string, unknown>;
  /** `signals.hasImages`, lifted for the table column. */
  readonly hasImages?: boolean;
  readonly floor?: unknown;
  readonly backedOffTo?: string;
};

/** One persisted `/model` directive (PR 9b), in turn order. */
export type RouteDirective = {
  readonly turnNumber?: number;
  readonly source: string;
  readonly requested: string;
  readonly resolved?: string;
  readonly accepted: boolean;
  readonly reason?: string;
};

/** One persisted hybrid-strategy stage transition (PRs 9c/9d), in turn order. */
export type RouteStage = {
  readonly turnNumber?: number;
  readonly stage: string;
  readonly strategy: string;
  readonly role: string;
  readonly model: string;
  readonly profile?: string;
  readonly outcome: string;
  readonly cause?: string;
  readonly costUsdMicros?: number;
};

/** Everything `route explain` replays for one session, in file order. */
export type RouteTimeline = {
  readonly decisions: ReadonlyArray<RouteDecision>;
  readonly directives: ReadonlyArray<RouteDirective>;
  readonly stages: ReadonlyArray<RouteStage>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  return typeof p[key] === "string" ? (p[key] as string) : undefined;
}

/** Guard a hostile session id from escaping the sessions dir. */
function sessionLogPath(rootDir: string, sessionId: string): string {
  // Real ids are `sess_<hex>`; anything with a path separator or `..` is
  // rejected outright.
  if (/[/\\]/.test(sessionId) || sessionId.includes("..") || sessionId.length === 0) {
    throw new Error(`route explain: invalid session id "${sessionId}"`);
  }
  return join(rootDir, "sessions", `${sessionId}.jsonl`);
}

/**
 * Read the routing TIMELINE persisted in a session's event log at
 * `<rootDir>/sessions/<sessionId>.jsonl`: the `model_route` decisions plus
 * the `model_directive` and `model_stage` lines, each in file (turn) order.
 * A missing log yields three empty arrays; a malformed line is skipped (the
 * log is best-effort observability).
 */
export function readRouteTimeline(rootDir: string, sessionId: string): RouteTimeline {
  const path = sessionLogPath(rootDir, sessionId);
  const decisions: RouteDecision[] = [];
  const directives: RouteDirective[] = [];
  const stages: RouteStage[] = [];
  if (!existsSync(path)) return { decisions, directives, stages };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec: { kind?: unknown; payload?: unknown };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const p = asRecord(rec.payload);
    if (p === undefined) continue;
    const turn = typeof p["turnNumber"] === "number" ? { turnNumber: p["turnNumber"] } : {};
    if (rec.kind === "model_route") {
      const routeKey = str(p, "routeKey");
      const model = str(p, "model");
      if (routeKey === undefined || model === undefined) continue;
      const signals = asRecord(p["signals"]);
      const profile = str(p, "profile");
      const specModel = str(p, "specModel");
      decisions.push({
        ...turn,
        routeKey,
        model,
        policy: str(p, "policy") ?? "?",
        reason: str(p, "reason") ?? "",
        ...(typeof p["explored"] === "boolean" ? { explored: p["explored"] } : {}),
        ...(str(p, "policyVersion") !== undefined
          ? { policyVersion: str(p, "policyVersion") as string }
          : {}),
        ...(specModel !== undefined ? { specModel } : {}),
        ...(profile !== undefined ? { profile } : {}),
        armId: profile ?? specModel ?? model,
        ...(str(p, "scope") !== undefined ? { scope: str(p, "scope") as string } : {}),
        ...(str(p, "toolsetFingerprint") !== undefined
          ? { toolsetFingerprint: str(p, "toolsetFingerprint") as string }
          : {}),
        ...(str(p, "stage") !== undefined ? { stage: str(p, "stage") as string } : {}),
        ...(str(p, "strategy") !== undefined ? { strategy: str(p, "strategy") as string } : {}),
        ...(str(p, "ruleId") !== undefined ? { ruleId: str(p, "ruleId") as string } : {}),
        ...(str(p, "classifierVerdict") !== undefined
          ? { classifierVerdict: str(p, "classifierVerdict") as string }
          : {}),
        ...(Array.isArray(p["eligible"])
          ? {
              eligible: (p["eligible"] as unknown[]).filter(
                (x): x is string => typeof x === "string",
              ),
            }
          : {}),
        ...(asRecord(p["hint"]) !== undefined
          ? { hint: asRecord(p["hint"]) as Record<string, unknown> }
          : {}),
        ...(signals !== undefined ? { signals } : {}),
        ...(signals !== undefined && typeof signals["hasImages"] === "boolean"
          ? { hasImages: signals["hasImages"] as boolean }
          : {}),
        ...(p["floor"] !== undefined ? { floor: p["floor"] } : {}),
        ...(str(p, "backedOffTo") !== undefined
          ? { backedOffTo: str(p, "backedOffTo") as string }
          : {}),
      });
      continue;
    }
    if (rec.kind === "model_directive") {
      const requested = str(p, "requested");
      if (requested === undefined) continue;
      directives.push({
        ...turn,
        source: str(p, "source") ?? "?",
        requested,
        ...(str(p, "resolved") !== undefined ? { resolved: str(p, "resolved") as string } : {}),
        accepted: p["accepted"] === true,
        ...(str(p, "reason") !== undefined ? { reason: str(p, "reason") as string } : {}),
      });
      continue;
    }
    if (rec.kind === "model_stage") {
      const stage = str(p, "stage");
      if (stage === undefined) continue;
      stages.push({
        ...turn,
        stage,
        strategy: str(p, "strategy") ?? "?",
        role: str(p, "role") ?? "?",
        model: str(p, "model") ?? "",
        ...(str(p, "profile") !== undefined ? { profile: str(p, "profile") as string } : {}),
        outcome: str(p, "outcome") ?? "?",
        ...(str(p, "cause") !== undefined ? { cause: str(p, "cause") as string } : {}),
        ...(typeof p["costUsdMicros"] === "number"
          ? { costUsdMicros: p["costUsdMicros"] as number }
          : {}),
      });
    }
  }
  return { decisions, directives, stages };
}

/**
 * The `model_route` decisions alone — kept as its own export because
 * `route explain`'s pre-0.6.0 table and several tests read only these.
 */
export function readRouteDecisions(rootDir: string, sessionId: string): RouteDecision[] {
  return [...readRouteTimeline(rootDir, sessionId).decisions];
}

/**
 * Render a run's routing timeline as the §8.2 v2 table: turn / stage / scope /
 * band / rule / policy / profile / model / eligible / reason, with the
 * directive and stage lines interleaved in turn order beneath the decision
 * they belong to.
 */
export function formatRouteExplain(
  sessionId: string,
  timeline: RouteTimeline | readonly RouteDecision[],
): string {
  const t: RouteTimeline = Array.isArray(timeline)
    ? { decisions: timeline as readonly RouteDecision[], directives: [], stages: [] }
    : (timeline as RouteTimeline);
  if (t.decisions.length === 0 && t.directives.length === 0 && t.stages.length === 0) {
    return `No model_route decisions recorded for session ${sessionId}. (Only runs whose spec declares \`agent.model_pool\` persist routing decisions.)`;
  }
  const lines: string[] = [
    `session ${sessionId} — ${t.decisions.length} routing decision(s), ${t.directives.length} directive(s), ${t.stages.length} stage line(s):`,
    "",
  ];
  lines.push(
    `${"turn".padStart(4)} ${"stage".padEnd(9)} ${"scope".padEnd(10)} ${"band".padEnd(7)} ${"rule".padEnd(14)} ${"policy".padEnd(11)} ${"profile".padEnd(10)} ${"model".padEnd(26)} ${"pick".padEnd(8)} ${"eligible".padStart(8)} reason`,
  );
  const turnsSeen = new Set<number>();
  const turnKey = (n: number | undefined): number => n ?? -1;
  for (const d of t.decisions) {
    turnsSeen.add(turnKey(d.turnNumber));
    const turn = d.turnNumber !== undefined ? String(d.turnNumber) : "-";
    const pick = d.explored === true ? "explore" : "exploit";
    const eligible = d.eligible !== undefined ? String(d.eligible.length) : "-";
    lines.push(
      `${turn.padStart(4)} ${(d.stage ?? "-").padEnd(9)} ${(d.scope ?? "-").padEnd(10)} ${d.routeKey.padEnd(7)} ${(d.ruleId ?? "-").padEnd(14)} ${d.policy.padEnd(11)} ${(d.profile ?? "-").padEnd(10)} ${d.model.padEnd(26)} ${pick.padEnd(8)} ${eligible.padStart(8)} ${d.reason}`,
    );
    for (const dir of t.directives.filter((x) => turnKey(x.turnNumber) === turnKey(d.turnNumber))) {
      lines.push(
        `${"".padStart(4)}   /model ${dir.requested}${dir.resolved !== undefined ? ` → ${dir.resolved}` : ""} [${dir.source}] ${dir.accepted ? "accepted" : `REFUSED${dir.reason !== undefined ? `: ${dir.reason}` : ""}`}`,
      );
    }
    for (const st of t.stages.filter((x) => turnKey(x.turnNumber) === turnKey(d.turnNumber))) {
      lines.push(`${"".padStart(4)}   ${stageLine(st)}`);
    }
  }
  // Directives and stages from turns that produced no route line (a
  // directive refused before routing, a side call on an unrouted turn) still
  // belong to the replay — dropping them would hide exactly the refusals.
  for (const dir of t.directives.filter((x) => !turnsSeen.has(turnKey(x.turnNumber)))) {
    lines.push(
      `${(dir.turnNumber !== undefined ? String(dir.turnNumber) : "-").padStart(4)}   /model ${dir.requested} [${dir.source}] ${dir.accepted ? "accepted" : `REFUSED${dir.reason !== undefined ? `: ${dir.reason}` : ""}`}`,
    );
  }
  for (const st of t.stages.filter((x) => !turnsSeen.has(turnKey(x.turnNumber)))) {
    lines.push(
      `${(st.turnNumber !== undefined ? String(st.turnNumber) : "-").padStart(4)}   ${stageLine(st)}`,
    );
  }
  return lines.join("\n");
}

/**
 * One stage line of the timeline. COST lives here rather than on the decision
 * row: the durable `model_route` line carries no cost (the decision precedes
 * the call), while `model_stage` carries the priced spend of the stage it
 * closes — so this is where a reader can actually see what a hybrid topology
 * charged for a turn.
 */
function stageLine(st: RouteStage): string {
  const cost =
    st.costUsdMicros !== undefined ? ` $${(st.costUsdMicros / 1_000_000).toFixed(5)}` : "";
  return `${st.strategy}/${st.stage} ${st.role} ${st.model}${st.profile !== undefined ? ` ($${st.profile})` : ""} ${st.outcome}${st.cause !== undefined ? ` (${st.cause})` : ""}${cost}`;
}

/** The `route explain --json` payload: the timeline verbatim. */
export function routeExplainJson(
  sessionId: string,
  timeline: RouteTimeline,
): { readonly session: string } & RouteTimeline {
  return { session: sessionId, ...timeline };
}

/**
 * Run `crewhaus route …`, returning the text to print.
 *
 * SYNCHRONOUS subcommands only. `promote` reads the eval history and appends
 * an audit record, both asynchronous, so it is served by
 * {@link runRouteCommand} — the entry point the CLI dispatch calls.
 */
export function runRoute(argv: readonly string[]): string {
  const args = parseRouteArgs(argv);
  if (args.sub === "promote") {
    throw new Error("route promote is asynchronous — call runRouteCommand()");
  }
  if (args.sub === "propose") {
    throw new Error("route propose reads the spec — call runRouteCommand()");
  }
  if (args.sub === "status") {
    const freeze = loadRouteFreeze(args.dir);
    const arms = loadArms(args.dir);
    const grouping = {
      ...(args.by !== undefined ? { by: args.by } : {}),
      ...(args.shadow === true ? { shadow: true } : {}),
    };
    if (args.json === true) {
      return `${JSON.stringify(routeStatusJson(arms, freeze, grouping), null, 2)}\n`;
    }
    const banner = formatRouteFreeze(freeze);
    const table = formatRouteStatus(arms, grouping);
    return banner.length > 0 ? `${banner}\n\n${table}` : table;
  }
  if (args.sub === "explain") {
    const session = args.session as string; // parseRouteArgs guarantees it for explain
    const timeline = readRouteTimeline(args.dir, session);
    return args.json === true
      ? `${JSON.stringify(routeExplainJson(session, timeline), null, 2)}\n`
      : formatRouteExplain(session, timeline);
  }
  if (args.sub === "freeze") {
    const markerPath = join(args.dir, "routing", "freeze.json");
    if (args.clear === true) {
      return clearRouteFreeze(args.dir)
        ? `Lifted the routing freeze at ${markerPath}. Pooled runs learn again from their next call.`
        : `No routing freeze at ${markerPath} — nothing to lift.`;
    }
    const record = freezeRouting(args.dir, args.policyVersion as string, args.reason);
    return `Froze routing at policyVersion ${record.policyVersion} (${markerPath}). Pooled runs under this root now route off the recorded history, record nothing new and report this policyVersion; \`crewhaus route freeze --clear\` lifts it.`;
  }
  const removed = resetRouting(args.dir);
  return `Reset routing scoreboard at ${join(args.dir, "routing", "arms.jsonl")} (${removed} arm${removed === 1 ? "" : "s"} removed).`;
}

/**
 * The CLI dispatch entry: every `route` subcommand, including the
 * asynchronous `promote`. Returns the text to print plus the process exit
 * code (`promote --gate` is the only path that can make it non-zero).
 */
export async function runRouteCommand(
  argv: readonly string[],
  overrides: Partial<RoutePromoteOptions> = {},
): Promise<{ readonly text: string; readonly exitCode: number }> {
  const args = parseRouteArgs(argv);
  if (args.sub === "propose") return { text: runRouteProposeCli(args), exitCode: 0 };
  if (args.sub !== "promote") return { text: runRoute(argv), exitCode: 0 };
  const outcome = await runRoutePromote({
    rootDir: args.dir,
    gate: args.gate === true,
    dryRun: args.dryRun === true,
    json: args.json === true,
    ...(args.spec !== undefined ? { specName: args.spec } : {}),
    ...overrides,
  });
  return { text: outcome.text, exitCode: outcome.exitCode };
}

/**
 * 0.6.0 §9.1 — the `route propose` I/O wrapper: read the harness spec beside
 * the `.crewhaus` root, mine the scoreboard, and write the `suggestions.json`
 * `optimize --from-advice` consumes. Nothing else is written, and the spec is
 * never touched — the proposal IS the output.
 *
 * The spec is resolved as the `crewhaus.yaml` beside `--dir`'s parent (the
 * standalone-harness convention: `.crewhaus/` sits inside the harness dir),
 * falling back to the cwd. A missing or unparseable spec is not fatal: the
 * proposer reports every candidate as skipped with that reason, which is more
 * useful than a stack trace in a nightly job.
 */
export function runRouteProposeCli(args: RouteArgs): string {
  const harnessDir = args.dir === DEFAULT_ROOT ? process.cwd() : dirname(resolve(args.dir));
  const specPath = join(harnessDir, "crewhaus.yaml");
  let spec: Spec | undefined;
  let yamlText: string | undefined;
  if (existsSync(specPath)) {
    try {
      yamlText = readFileSync(specPath, "utf-8");
      spec = parseSpec(yamlText);
    } catch {
      spec = undefined;
    }
  }
  const result = buildRouteProposals({
    ...(spec !== undefined ? { spec } : {}),
    arms: loadArms(args.dir),
    ...(yamlText !== undefined
      ? { specHasPath: (path: ReadonlyArray<string>) => specHasPath(yamlText as string, path) }
      : {}),
  });
  if (args.json === true) {
    return `${JSON.stringify(routeSuggestionsFile(result, new Date().toISOString()), null, 2)}\n`;
  }
  if (result.proposals.length === 0) return formatRouteProposals(result);
  const outDir = resolve(args.out ?? join(args.dir, "route-propose"));
  mkdirSync(outDir, { recursive: true });
  const suggestionsPath = join(outDir, "suggestions.json");
  writeFileSync(
    suggestionsPath,
    `${JSON.stringify(routeSuggestionsFile(result, new Date().toISOString()), null, 2)}\n`,
    { mode: 0o600 },
  );
  return formatRouteProposals(result, suggestionsPath);
}
