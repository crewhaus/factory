/**
 * Reading `@crewhaus/routing-store` without becoming a second copy of it.
 *
 * WHAT THIS FILE DOES NOT DO. It does not parse `arms.jsonl`. The fold from
 * lines to arms — Welford, the aggregate parallel-combine, the `v:2` quality
 * accumulator, the `ungraded` counter, the `pf` lineage skip that drops
 * history from a profile that no longer exists — is `openScoreboard`'s, and a
 * second reader of that grammar would answer a different question the first
 * time a lineage stamp appeared. Last wave `SpecAdvise` reported
 * `routingScoreboard.read:false` rather than hand-parsing the file, which was
 * the right call; this package has the dependency, so it opens the store.
 *
 * WHAT IT ADDS. Three things the store deliberately leaves to its caller:
 *
 *   1. FAILURE SHAPES. `openScoreboard` reads the file inside an `existsSync`
 *      guard, so a missing store is empty and an UNREADABLE one throws. Both
 *      arrive here as a `Loaded`, and they are different answers: a store
 *      nobody has written to is not a store that says the routing is healthy,
 *      and a store this process could not read is neither.
 *   2. THE MALFORMED FREEZE MARKER. `readRouteFreeze` takes an `onMalformed`
 *      callback and reports absence when the file will not parse. Every
 *      caller that omits the callback therefore reads a corrupt kill switch
 *      as "not frozen" — including `promoteLanes`, whose own internal call
 *      passes none (`apps/cli`'s `loadRouteFreeze` documents the same
 *      behaviour). A fold is the one operation whose purpose is changing
 *      which model serves, so this package reads the marker WITH the callback
 *      first and refuses on `corrupt`, rather than letting a pin an operator
 *      set after an incident evaporate because the file got truncated.
 *   3. STATISTICS. See `./stats` — the store reports a mean and an `n`, and a
 *      mean without its interval is the thing that makes a three-observation
 *      arm look like a winner.
 */
import {
  type ArmStats,
  QUALITY_LANE_PREFIX,
  type RouteFreeze,
  SHADOW_LANE_PREFIX,
  isObserveOnlyLane,
  liveRouteKeyOf,
  openScoreboard,
  readRouteFreeze,
  readRoutingPriorsRaw,
  readShadowLaneSides,
  routeFreezePath,
  routingPriorsPath,
} from "@crewhaus/routing-store";
import { type Loaded, compareStrings, fail, renderPath } from "./result";
import { type MeanView, type RateView, meanWithInterval, rate } from "./stats";

/** Where a harness keeps its durable state, by convention. */
export const STATE_RELDIR = ".crewhaus";

/**
 * Every path under the state directory that opening or writing the routing
 * store can touch, relative to it.
 *
 * The `.tmp` names are not incidental. `Scoreboard.compact()` and
 * `promoteLanes()` both write `<file>.tmp` and then `renameSync` it ON TOP of
 * the real file; `writeRouteFreeze` does the same. A rename replaces whatever
 * was there, and a symlink at the `.tmp` name sends the write out of the
 * workspace before the rename ever runs — which is the InvoiceRender shape:
 * the directory was contained and the leaf that became the filename was not.
 */
export const ROUTING_TOUCHED_RELPATHS: ReadonlyArray<string> = [
  "routing",
  "routing/arms.jsonl",
  "routing/arms.jsonl.tmp",
  "routing/freeze.json",
  "routing/freeze.json.tmp",
  "routing/priors.json",
];

/** The subset touched by a read-only inspection. */
export const ROUTING_READ_RELPATHS: ReadonlyArray<string> = [
  "routing",
  "routing/arms.jsonl",
  "routing/freeze.json",
  "routing/priors.json",
];

/**
 * The freeze marker, with "there is none" and "there is one and it will not
 * parse" kept apart.
 *
 * `corrupt` is the state the store's own default collapses into absence. It
 * is surfaced as its own case so a caller has to decide what to do about it
 * instead of receiving `undefined` and carrying on.
 */
export type FreezeProbe =
  | { readonly state: "none" }
  | { readonly state: "frozen"; readonly freeze: RouteFreeze }
  | { readonly state: "corrupt"; readonly detail: string };

export function probeFreeze(rootDir: string): FreezeProbe {
  const complaints: string[] = [];
  const freeze = readRouteFreeze(rootDir, (detail) => complaints.push(detail));
  if (freeze !== undefined) return { state: "frozen", freeze };
  // A complaint means the FILE IS THERE and could not be understood.
  // `readRouteFreeze` returns `undefined` for both that and a plain absent
  // marker, so the callback is the only thing that separates them.
  if (complaints.length > 0) return { state: "corrupt", detail: complaints.join("; ") };
  return { state: "none" };
}

/**
 * Snapshot the arms, distinguishing "no store" from "could not read it".
 *
 * `openScoreboard` throws whatever `readFileSync` threw (EACCES, EISDIR, a
 * symlink loop) once the file exists. Swallowing that into an empty snapshot
 * is the "could not determine is not no" failure in its most expensive form:
 * a routing report that says there are no arms is read as "nothing has been
 * learned yet", and an operator acts on it.
 */
export function loadArms(rootDir: string): Loaded<ArmStats[]> {
  try {
    return { ok: true, value: openScoreboard(rootDir).snapshot() };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      "unreadable",
      `the routing scoreboard under "${renderPath(rootDir)}" could not be read (${code ?? (err instanceof Error ? err.message : "unknown error")}) — this is not an empty scoreboard`,
    );
  }
}

/** Which namespace a routeKey belongs to, as `@crewhaus/routing-store` defines it. */
export type Lane = "live" | "quality" | "shadow";

export function laneOf(routeKey: string): Lane {
  // Classified by the store's own predicate and prefixes rather than by a
  // regex written here: the runtime router mints and reads exactly one of
  // these namespaces, and a tool that disagreed about which would report
  // observe-only arms as arms that are serving.
  if (!isObserveOnlyLane(routeKey)) return "live";
  return routeKey.startsWith(SHADOW_LANE_PREFIX) ? "shadow" : "quality";
}

export {
  QUALITY_LANE_PREFIX,
  SHADOW_LANE_PREFIX,
  liveRouteKeyOf,
  routeFreezePath,
  routingPriorsPath,
};

/**
 * The shadow lane's two sides, or an empty split WITH the reason.
 *
 * `readShadowLaneSides` reads `arms.jsonl` directly and lets a filesystem
 * error out. Every caller here has already loaded the arms, so the file was
 * readable a moment ago — but "a moment ago" is not a guarantee, and an
 * uncaught throw out of a tool is a crash where a refusal belongs. Three
 * empty sets with no explanation would also be the exact failure this package
 * is about: "nothing could be read" rendered as "there is nothing".
 */
export type ShadowSides = {
  readonly shadow: ReadonlySet<string>;
  readonly primary: ReadonlySet<string>;
  readonly unattributed: ReadonlySet<string>;
  /** Set when the lane could not be read; the three sets are then empty. */
  readonly unreadable?: string;
};

export function shadowSides(rootDir: string): ShadowSides {
  try {
    return readShadowLaneSides(rootDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      shadow: new Set<string>(),
      primary: new Set<string>(),
      unattributed: new Set<string>(),
      unreadable: `the shadow lane could not be read (${code ?? (err instanceof Error ? err.message : "unknown error")}) — these sets are empty because nothing could be read, not because the lane is empty`,
    };
  }
}

/** One arm, with every rate carrying its interval. */
export type ArmView = {
  readonly routeKey: string;
  readonly model: string;
  readonly lane: Lane;
  /** For an observe-only arm, the live routeKey it audits. */
  readonly auditsRouteKey?: string;
  /** Reward observations folded into the arm. */
  readonly n: number;
  readonly reward: MeanView;
  readonly quality: MeanView;
  /**
   * How often a grade attempt on this arm actually produced one: judged
   * observations over judged plus `ungraded` (the arm served, the grader
   * threw). A proportion, so it gets a Wilson interval — and it is the number
   * that says whether `quality.mean`'s denominator is honest.
   */
  readonly graded: RateView;
  readonly ungraded: number;
  readonly meanLatencyMs: number;
  readonly meanCostUsd: number;
  readonly costCount: number;
};

export function armView(arm: ArmStats): ArmView {
  const lane = laneOf(arm.routeKey);
  const audits = lane === "live" ? undefined : liveRouteKeyOf(arm.routeKey);
  return {
    routeKey: arm.routeKey,
    model: arm.model,
    lane,
    // A lane prefix with nothing after it audits no live arm; `liveRouteKeyOf`
    // returns the empty string there and `promoteLanes` skips such a line, so
    // the field is omitted rather than reported as an arm named "".
    ...(audits !== undefined && audits.length > 0 ? { auditsRouteKey: audits } : {}),
    n: arm.n,
    reward: meanWithInterval(arm.meanReward, arm.varReward, arm.n),
    quality: meanWithInterval(arm.meanQuality, arm.varQuality, arm.qualityCount),
    graded: rate(arm.qualityCount, arm.qualityCount + arm.ungraded),
    ungraded: arm.ungraded,
    meanLatencyMs: arm.meanLatencyMs,
    meanCostUsd: arm.meanCostUsd,
    costCount: arm.costCount,
  };
}

/**
 * Why this package will not rank two arms with a rank test.
 *
 * The statistics rule for this wave is that a comparison between arms uses
 * Mann-Whitney rather than comparing means. That test needs the individual
 * observations, and `ArmStats` is a FOLD: `n`, a Welford mean and an M2, with
 * the per-observation rewards gone by the time `snapshot()` returns.
 * `@crewhaus/routing-store` exports no per-observation reader — the closest
 * thing it has, `readShadowLaneSides`, reads raw lines for a discriminant
 * `ArmStats` cannot carry and deliberately does no folding at all.
 *
 * Re-reading `arms.jsonl` here to recover the rewards would mean a second
 * implementation of the line grammar that would have to agree with the
 * store's about aggregates, about `v:2` fields and about the `pf` lineage
 * skip — and the first time it did not, two parts of the product would
 * disagree about which arm is winning. So the comparison offered on arms is
 * the weaker one the fold can actually support (overlapping intervals on the
 * grade-attempt rate, and the reward mean with its own interval and `n`), and
 * this string says why rather than letting a reader assume the strong test
 * was run and found nothing. `ExperimentLedger` does run Mann-Whitney,
 * because its ledger keeps per-observation scores.
 */
export const ARM_RANK_TEST_UNAVAILABLE =
  "a rank test (Mann-Whitney) between arms is not offered: @crewhaus/routing-store folds observations into a Welford (n, mean, M2) and exports no per-observation reader, so the individual rewards do not exist by the time an arm is read. Ranking on the folded means is exactly the comparison the interval on each mean exists to discourage. For a rank test over routed outcomes, use an eval run (`crewhaus eval`) or ExperimentLedger, whose ledger keeps every observation.";

/** `route reset` is not offered here, and this is the reason. */
export const RESET_UNAVAILABLE =
  "resetting the scoreboard is not offered by this tool. `@crewhaus/routing-store` has no reset primitive: the wipe lives in `apps/cli`'s `resetRouting`, and re-implementing it here would be a second copy of it. It is also the one routing operation that is unsafe to perform from outside the loop — `arms.jsonl` is append-only and written live, so removing it races any harness process mid-append, and there is no generation marker for a router to notice that the store it is appending to was replaced underneath it. Run `crewhaus route reset` (which also clears the freeze marker, because a reset is 'start the learning over', not 'keep serving a pinned policy over an empty store').";

/** The eval gate `crewhaus route promote` resolves and this package cannot. */
export const PROMOTE_GATE_UNAVAILABLE =
  "this tool does NOT resolve the promotion's eval gate. `crewhaus route promote` admits a fold only when the newest recorded eval run for the spec routed `as-declared`, pinned `model_pool.learning.seed`, ran off a frozen and WARM arm snapshot, was neither budget-aborted nor replayed from a cassette, and passed `gateRuns` against its own lineage's pinned baseline. That check lives in `apps/cli`'s `route-promote` over `@crewhaus/eval-report` and `@crewhaus/eval-ops`, neither of which this package depends on. `promoteLanes` itself enforces no gate, so a fold from here is an UNGATED fold and takes `acceptUngated: true` to happen at all.";

/**
 * The arms a `compact()` would DELETE, and why that is not a line-count
 * change.
 *
 * `Scoreboard.compact()` rewrites the store to one aggregate line per arm and
 * keeps only the arms with `n > 0 || ungraded > 0`. `snapshot()` applies no
 * such filter, so counting the snapshot as "the arms before" and calling the
 * result a shrink in LINES is a parallel preview that disagrees with the real
 * selection — and the disagreement is destructive, not cosmetic.
 *
 * The arm it deletes is a real one: `route promote` folds a `q:` lane into
 * the live arm it audits as an `n: 0` aggregate back-fill carrying only
 * `qs`/`qn`/`qm2` (the lane re-observes turns the live arm already counted,
 * so carrying the whole line would double `n`). A live arm whose ONLY
 * evidence is that back-fill therefore has `n: 0`, `ungraded: 0` and a
 * judged-quality history — and `compact()` drops it. The lane sources are
 * already stamped `pm: 1`, so `route promote` can never fold them again:
 * the evidence is gone for good.
 *
 * The predicate below restates `compact()`'s filter, which is exactly the
 * drift this package avoids elsewhere — so it is PINNED: `index.test.ts`
 * builds such an arm, runs the REAL `compact()`, and asserts this function
 * named precisely the arms that disappeared. If routing-store changes its
 * filter, that test fails rather than this silently reporting the wrong set.
 */
export function armsDroppedByCompaction(arms: ReadonlyArray<ArmStats>): ArmStats[] {
  return [...arms]
    .filter((arm) => !(arm.n > 0 || arm.ungraded > 0))
    .sort((a, b) => compareStrings(a.routeKey, b.routeKey) || compareStrings(a.model, b.model));
}

/** One arm a compaction would delete, in the shape a result reports it. */
export type DroppedArm = {
  readonly routeKey: string;
  readonly model: string;
  readonly lane: Lane;
  readonly n: number;
  readonly ungraded: number;
  readonly qualityCount: number;
  readonly meanQuality: number | null;
  readonly reason: string;
};

export function droppedArmView(arm: ArmStats): DroppedArm {
  return {
    routeKey: arm.routeKey,
    model: arm.model,
    lane: laneOf(arm.routeKey),
    n: arm.n,
    ungraded: arm.ungraded,
    qualityCount: arm.qualityCount,
    meanQuality: arm.qualityCount > 0 ? arm.meanQuality : null,
    reason:
      arm.qualityCount > 0
        ? "carries judged quality but no reward observation and no ungraded count — the shape a `route promote` quality back-fill leaves behind. compact() keeps only arms with n>0 or ungraded>0, so this arm and its quality history would be deleted, and the lane lines it came from are stamped `pm:1` and can never be promoted again."
        : "holds no reward observation, no ungraded count and no judged quality, so compact() drops it and nothing is lost.",
  };
}

/** The flag name a caller passes to compact anyway, named in one place. */
export const ARM_LOSS_FLAG = "acceptArmLoss";

/** Sorted arm views, by routeKey then model, with plain string comparison. */
export function armViews(arms: ReadonlyArray<ArmStats>): ArmView[] {
  return [...arms]
    .map(armView)
    .sort((a, b) => compareStrings(a.routeKey, b.routeKey) || compareStrings(a.model, b.model));
}

/** The priors file, with its three states kept apart. */
export type PriorsProbe =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly path: string }
  | { readonly state: "unparseable"; readonly path: string; readonly detail: string };

export function probePriors(rootDir: string): PriorsProbe {
  const raw = readRoutingPriorsRaw(rootDir);
  if (raw === undefined) return { state: "absent" };
  // Validation is `@crewhaus/model-plan`'s `loadPriors`, not this package's:
  // reporting "present" plus the path is the whole honest answer a reader of
  // the raw JSON can give, and claiming the priors are VALID would be a
  // second validator.
  return raw.ok
    ? { state: "present", path: raw.path }
    : { state: "unparseable", path: raw.path, detail: raw.error };
}
