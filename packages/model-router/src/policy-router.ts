/**
 * `model_pool` — declared-candidate, per-task model selection that improves
 * with usage. The generalisation of the two-tier router (`tier-router.ts`):
 * instead of exactly two rungs picked by a fixed heuristic, a pool holds N
 * user-declared candidates and a `policy` that selects one PER TURN.
 *
 *   - `static`    — always the first candidate (declared order = priority).
 *   - `heuristic` — deterministic difficulty routing (reuses `pickTier`):
 *                   hard turns go to a `strong`-tagged candidate, easy turns to
 *                   a `cheap`-tagged one. Zero state, fully reproducible.
 *   - `learned`   — per-difficulty-band arm selection off the durable reward
 *                   scoreboard (`@crewhaus/routing-store`). Under-sampled arms
 *                   are explored DETERMINISTICALLY (least-sampled first, tie →
 *                   declared order); once every arm in a band clears
 *                   `minSamplesPerArm`, the highest mean-reward arm wins. No
 *                   RNG — the decision replays exactly from the persisted
 *                   scoreboard + the turn's signals.
 *
 * This module is PURE and fs-free (mirroring the rest of model-router): the
 * `learned` policy reads the scoreboard through an injected `score` lookup, so
 * runtime-core owns all persistence and the router stays trivially testable.
 *
 * 0.6.0 (§7.9 / §7.10 / §7.11 — PR 10):
 *   - **Arm identity** is `poolCandidateArmId()` — the `models:` profile name
 *     when the candidate is a profile, else the spec model string — in every
 *     scoreboard read (no migration: unprofiled arms keep their key).
 *   - **Scoped route keys**: with `scope` set the router mints `<scope>/<band>`
 *     (`support/hard`), and `decideLearned` BACKS OFF to the unscoped `<band>`
 *     arm while the scoped one is under-sampled, so one shared store stops
 *     pooling five workflow steps into two arms without discarding the
 *     history those arms already hold. Absent scope → the 0.5.x key.
 *   - **Per-candidate breakers**: a candidate whose `breaker.state()` is
 *     `"open"` is filtered from the roster before the policy runs (never a
 *     veto — an all-open roster leaves the full roster in play).
 *   - **The floor** (`floor`): in the exploit phase an arm is exploitable
 *     only if the Wilson lower bound of its judged quality clears the floor
 *     arm's judged mean minus `tolerance`; when nothing but the floor arm
 *     is exploitable the floor arm serves with the VERBATIM reason
 *     {@link FLOOR_BLOCKED_ROUTE_REASON}. Exploration draws are unaffected.
 *   - **Seeded priors**: an `ArmScore` marked `seeded` skips warm-up.
 *
 * Like the tier router and the failover chain, every candidate adapter binds
 * ONCE at boot; `route()` only selects among the already-resolved candidates.
 * A failed cheap pick escalates to `escalation()` (the strongest candidate) —
 * composing with the loop's misroute-recovery ladder exactly as the tier
 * router's fast→default escalation does.
 */
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { CircuitState } from "@crewhaus/circuit-breaker";
import { checkFloor } from "@crewhaus/model-plan";
import type { ProviderId } from "./parse.js";
import { type TierRoutingConfig, type TierSignals, pickTier } from "./tier-router.js";

/**
 * 0.6.0 §7.2.2 — `RouteSignals ⊇ TierSignals`: the tier router's four
 * deterministic signals plus the additions the `preRoute` phase derives
 * (rules and the classifier read them; the band still comes from the four).
 * Structurally `@crewhaus/model-plan`'s `RouteSignals`, so the one object the
 * loop builds feeds `evaluateRules`, `pickTier` and `route()` alike.
 */
export type RouteSignals = TierSignals & {
  /** The latest user text (input only — never persisted by the loop). */
  readonly userText?: string;
  readonly userTextChars?: number;
  readonly hasImages?: boolean;
  readonly toolNamesLastTurn?: readonly string[];
  /** Fraction of the run budget already spent, in `[0, 1]`. */
  readonly budgetSpentRatio?: number;
  readonly channelHint?: string;
};

/** The chain member that actually served a candidate's last call (§4.4). */
export type PoolCandidateServed = {
  readonly modelString: string;
  readonly modelId: string;
  readonly providerId: ProviderId;
};

/** One resolved candidate in a model pool. */
export type PoolCandidate = {
  readonly adapter: ProviderAdapter;
  /** Wire model id the candidate resolved to. */
  readonly modelId: string;
  /** Spec model-router grammar string (the arm identity for an unprofiled candidate). */
  readonly modelString: string;
  /** Free-form tags (e.g. `cheap`, `strong`) the heuristic routes on. */
  readonly tags: readonly string[];
  /**
   * 0.6.0 §7.9 — the ARM IDENTITY: the `models:` profile name when the
   * candidate is a profile, else the spec model string. Defaults to
   * `modelString`, so a bare 0.5.x candidate needs no change. Every
   * scoreboard read and write keys on `poolCandidateArmId(candidate)`.
   */
  readonly armId?: string;
  /**
   * 0.6.0 §4.4 — the candidate's circuit breaker (its own
   * `@crewhaus/circuit-breaker` wrap, or the all-members view of its
   * failover chain). `state() === "open"` removes the candidate from the
   * roster for the turn — an eligibility filter, never a request-time error.
   */
  readonly breaker?: { state(): CircuitState };
  /**
   * 0.6.0 §4.4 — when the candidate's adapter is a `FailoverChain`, the
   * member that served (or is serving) its most recent call, so pricing,
   * `model_response.model` and the arm reward attribute a fallback's work to
   * the member that did it rather than to the profile's primary. `undefined`
   * before the first call; absent on a plain candidate.
   */
  readonly lastServed?: () => PoolCandidateServed | undefined;
};

/**
 * 0.6.0 §7.10 — the `model_route.reason` the learned policy records when no
 * non-floor arm is exploitable and it serves the floor arm instead. Published
 * VERBATIM (nothing appended by the router) because the alert watchdog, the
 * SLO monitor and metrics-collector key `floor_block_rate` on this string —
 * import the constant, never retype it.
 */
export const FLOOR_BLOCKED_ROUTE_REASON = "floor-blocked";

/** The scope/band separator in a scoped route key (`support/hard`). */
export const ROUTE_SCOPE_SEPARATOR = "/";

/**
 * §7.9 — the scoped route key: `<scope>/<band>` when the pool is scoped (a
 * workflow step, a graph node, a crew role, a sub-agent), else the bare band.
 * `band` may already carry a hint suffix (`hard:code`). Scope names come from
 * the spec's `safeName`, which admits neither `|` nor `/`, so the split is
 * unambiguous.
 */
export function scopedRouteKey(band: string, scope?: string): string {
  return scope !== undefined && scope.length > 0 ? `${scope}${ROUTE_SCOPE_SEPARATOR}${band}` : band;
}

/** Split a route key into its optional scope and its band (the band keeps any `:suffix`). */
export function splitRouteKey(routeKey: string): {
  readonly scope?: string;
  readonly band: string;
} {
  const at = routeKey.indexOf(ROUTE_SCOPE_SEPARATOR);
  if (at <= 0) return { band: routeKey };
  return { scope: routeKey.slice(0, at), band: routeKey.slice(at + 1) };
}

/** The unscoped twin of a route key — what a scoped arm backs off to. */
export function unscopedRouteKey(routeKey: string): string {
  return splitRouteKey(routeKey).band;
}

export type PoolPolicy = "static" | "heuristic" | "learned";

/**
 * 0.6.0 §7.2 / §7.12 — the policy stamped on a {@link PolicyDecision}. Every
 * configured {@link PoolPolicy}, plus the lanes the `preRoute` phase decides
 * BEFORE the policy (§7.2 ordering: forced → directive → rules → classifier →
 * policy over `eligible[]`):
 *
 *   - `"forced"` — a budget degrade restricting the pool to its rung
 *     (reason `budget_degrade`), substituted by the loop OUTSIDE the router
 *     because the rung may sit outside the roster;
 *   - `"escalation"` — the misroute-recovery latch or the model's own
 *     `Escalate` request, likewise substituted by the loop;
 *   - `"directive"` / `"rule"` / `"classifier"` — a {@link PolicyRouteHint}
 *     whose `forcedArm` names a roster candidate; `route()` serves it and
 *     stamps the hint's source, keeping the band (`routeKey`) so the
 *     scoreboard arm is still keyed on the turn's difficulty.
 *
 * `route()` never returns `"forced"` or `"escalation"` itself — the router
 * stays a pure selector over the roster.
 */
export type PolicyDecisionPolicy =
  | PoolPolicy
  | "classifier"
  | "rule"
  | "directive"
  | "escalation"
  | "forced";

/**
 * 0.6.0 §7.2 — the `preRoute` phase's output, handed INTO the synchronous
 * `route()` (the router stays pure: the hint is an input like the signals).
 * Structurally `@crewhaus/model-plan`'s `RouteHint` (whose `eligible` is
 * required), declared here so the router keeps its zero dependency on the
 * plan package.
 *
 *   - `forcedArm` — an arm the policy MUST serve when it is on the roster
 *     (a directive pin, a rule's target, a classifier verdict); the decision
 *     is stamped with the policy matching `source`. An arm the roster does
 *     not hold is ignored (the loop handles out-of-roster forcing itself).
 *   - `eligible` — the arms the policy may choose among this turn (N1,
 *     §7.11): `static` takes the first eligible, `heuristic` its strongest /
 *     cheapest among them, `learned` scores only them. An EMPTY or absent
 *     set leaves the whole roster in play (the loop records
 *     `no-eligible-candidate`).
 *   - `routeKeySuffix` — appended to the band as `<band>:<suffix>` so a
 *     hinted decision learns in its own bucket (unused by the loop until the
 *     scoped-key grammar lands).
 */
export type PolicyRouteHint = {
  readonly forcedArm?: string;
  readonly excludedArms?: readonly string[];
  readonly eligible?: readonly string[];
  readonly routeKeySuffix?: string;
  readonly source: "forced" | "directive" | "rule" | "classifier" | "eligibility" | "none";
  readonly evidence?: Readonly<Record<string, unknown>>;
};

/**
 * Difficulty thresholds (shared verbatim with the tier router) plus the tag
 * preferences the heuristic routes on. All optional — sensible defaults apply.
 */
export type PoolRoutingConfig = TierRoutingConfig & {
  /** Tag the heuristic prefers for HARD turns. Default `"strong"`. */
  readonly strongTag?: string;
  /** Tag the heuristic prefers for EASY turns. Default `"cheap"`. */
  readonly cheapTag?: string;
};

export type PoolLearningConfig = {
  /** Observations an arm needs before it can win its band on merit. Default 25. */
  readonly minSamplesPerArm?: number;
  /**
   * ε for ε-greedy ONLINE exploration once every arm in a band has cleared
   * `minSamplesPerArm`: the fraction of exploit-phase turns that try a
   * non-best candidate instead of the current best, so the policy keeps
   * sampling (catching drift, escaping a stale local optimum) rather than
   * hard-committing forever. Default `0` — with `0` the learned policy is
   * exactly the deterministic explore-then-exploit of 0.2.1 (no RNG). Clamped
   * to `[0, 1]`. The draw is seeded from the run + turn (see `route`), so it
   * stays replayable from the transcript.
   */
  readonly explorationRate?: number;
  /**
   * Which exploration strategy runs in the exploit phase (after every arm
   * clears `minSamplesPerArm`):
   *   - `"epsilon-greedy"` (default) — exploit the best arm, explore a random
   *     non-best arm `explorationRate` of the time.
   *   - `"thompson"` — Gaussian Thompson sampling: draw each arm from its
   *     reward posterior `Normal(meanReward, varReward / n)` and take the arm
   *     with the highest draw. Self-balances explore/exploit (an uncertain arm
   *     wins more often), so `explorationRate` is ignored under `thompson`.
   * Both draw from a transcript-seeded RNG, so both replay exactly.
   */
  readonly bandit?: "epsilon-greedy" | "thompson";
};

/** The minimal per-arm read the learned policy needs from the scoreboard. */
export type ArmScore = {
  readonly n: number;
  readonly meanReward: number;
  /** Sample variance of reward (0 when n < 2). Consumed by Thompson sampling. */
  readonly varReward?: number;
  /** 0.6.0 §7.10 — mean JUDGED quality over the observations that carried one (the floor's input). */
  readonly meanQuality?: number;
  /** How many observations carried a judged quality. */
  readonly qualityCount?: number;
  /** 0.6.0 §7.11 — the score came from an eval-seeded prior: warm-up is skipped for this arm. */
  readonly seeded?: boolean;
};

/**
 * Injected scoreboard reader: `(routeKey, armId) → arm stats | undefined`.
 * The arm id is `poolCandidateArmId(candidate)` (§7.9).
 */
export type ScoreLookup = (routeKey: string, armId: string) => ArmScore | undefined;

/** 0.6.0 §7.10 — `model_pool.reward.floor`. */
export type PoolFloorConfig = {
  /**
   * The floor ARM ID (`poolCandidateArmId`), compared by strict equality;
   * default the roster's strongest (`strongTag`, else last declared). The
   * spec's `reward.floor.arm` is a role slot (tag / `$profile` / model), so
   * the caller resolves it against the booted roster before handing it here.
   */
  readonly arm?: string;
  /** Confidence for the Wilson lower bound. Default 0.9. */
  readonly confidence?: number;
  /** How far below the floor mean an arm's LCB may sit. Default 0.02. */
  readonly tolerance?: number;
};

export type PolicyRouterOptions = {
  readonly candidates: readonly PoolCandidate[];
  readonly policy: PoolPolicy;
  readonly routing?: PoolRoutingConfig;
  readonly learning?: PoolLearningConfig;
  /** Required for `policy: "learned"`; ignored by `static`/`heuristic`. */
  readonly score?: ScoreLookup;
  /**
   * 0.6.0 §7.9 — the pool's scope (`model_pool.scope`: the step / role /
   * node / sub-agent). Route keys become `<scope>/<band>`; the learned
   * policy backs off to the unscoped band arm while the scoped one is
   * under-sampled. Absent → unscoped keys, exactly as before.
   */
  readonly scope?: string;
  /** 0.6.0 §7.10 — the quality floor the learned policy may not exploit below. */
  readonly floor?: PoolFloorConfig;
};

/** 0.6.0 §7.10 — the floor check's outcome on a learned exploit-phase decision. */
export type PolicyFloorVerdict = {
  /** The floor arm id. */
  readonly arm: string;
  /**
   * `ok` — the constraint applied and a non-floor arm was exploitable (or the
   * floor arm won on merit); `blocked` — nothing but the floor arm was
   * exploitable, so it serves (`reason: "floor-blocked"`); `unavailable` —
   * the floor arm has no judged quality yet or is not eligible this turn, so
   * the check is suspended for the turn (§7.13).
   */
  readonly status: "ok" | "blocked" | "unavailable";
  /** Arm ids the floor kept out of exploitation this turn. */
  readonly blocked?: readonly string[];
};

export type PolicyDecision = {
  readonly candidate: PoolCandidate;
  /**
   * The learning bucket this decision keys on: `"hard"` | `"easy"`, with a
   * `:suffix` when the hint asked for one and a `<scope>/` prefix when the
   * pool is scoped (§7.9).
   */
  readonly routeKey: string;
  /** Human-readable trigger for the `model_route` trace event / logs. */
  readonly reason: string;
  readonly policy: PolicyDecisionPolicy;
  /** True when the learned policy chose an under-sampled arm to explore it. */
  readonly explored: boolean;
  /** 0.6.0 §7.10 — present on a learned exploit-phase decision made under a floor. */
  readonly floor?: PolicyFloorVerdict;
  /**
   * 0.6.0 §7.9 — the unscoped route key the learned policy read the chosen
   * arm's statistics from because its scoped arm was still under-sampled.
   */
  readonly backedOffTo?: string;
};

export interface PolicyRouter {
  /**
   * The per-turn model decision from the loop's deterministic signals.
   *
   * `seed` + `seq` seed ε-greedy online exploration (only consulted by
   * `learned` with `explorationRate > 0`). `seed` is a per-RUN-stable value
   * that varies across runs (runtime-core passes the spec's `learning.seed`
   * when set, else the `sessionId`). `seq` is a MONOTONIC per-decision counter
   * that must keep advancing across `--resume` and across a channel-bot's
   * resume-per-message pattern — runtime-core passes the transcript length, so
   * every decision (even the first turn of a resumed session) draws a fresh
   * coin, while replay of the same transcript reproduces it exactly. `seq`
   * defaults to `signals.turnIndex` for callers/tests that route a single run
   * without resume. Omitting `seed` is equivalent to `""`.
   */
  route(signals: RouteSignals, seed?: string, seq?: number, hint?: PolicyRouteHint): PolicyDecision;
  /** The resolved candidate set (declared order). */
  candidates(): readonly PoolCandidate[];
  /** Strongest candidate — the escalation target for a failed cheap pick. */
  escalation(): PoolCandidate;
}

const DEFAULT_MIN_SAMPLES = 25;
const STRONG_TAG = "strong";
const CHEAP_TAG = "cheap";

/**
 * A deterministic uniform draw in `[0, 1)` from string/number seed material
 * (FNV-1a over the joined parts). Same inputs → same draw, so ε-greedy
 * exploration keyed on `(seed, turnIndex, band)` is fully replayable from the
 * transcript — no persisted RNG state.
 */
function uniform01(...parts: ReadonlyArray<string | number>): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/**
 * A standard-normal draw `N(0, 1)` from the same deterministic seed material,
 * via Box-Muller over two independent `uniform01` draws. Used by Thompson
 * sampling to draw each arm from its reward posterior. Reproducible from the
 * transcript for the same reason `uniform01` is.
 */
function gaussian(...parts: ReadonlyArray<string | number>): number {
  const u1 = Math.max(1e-12, uniform01(...parts, "z1"));
  const u2 = uniform01(...parts, "z2");
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * The learning bucket for a turn. Reuses the tier router's escalation logic so
 * a pool with two candidates + `policy: heuristic` behaves identically to the
 * equivalent `model_tiers` block: `"hard"` ⟺ the tier router would pick
 * `default`, `"easy"` ⟺ it would pick `fast`.
 */
function routeBand(
  signals: TierSignals,
  routing: PoolRoutingConfig,
): { band: "hard" | "easy"; reason: string } {
  const decision = pickTier(signals, routing);
  return decision.tier === "default"
    ? { band: "hard", reason: decision.reason }
    : { band: "easy", reason: decision.reason };
}

/** First candidate carrying `tag`, else `undefined`. */
function firstTagged(candidates: readonly PoolCandidate[], tag: string): PoolCandidate | undefined {
  return candidates.find((c) => c.tags.includes(tag));
}

/** Render hint evidence as `k=v` pairs for the decision's reason string. */
function describeEvidence(evidence: Readonly<Record<string, unknown>>): string {
  return Object.entries(evidence)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** The arm id a hint names a candidate by (§7.9): profile name, else model string. */
export function poolCandidateArmId(candidate: PoolCandidate): string {
  return candidate.armId ?? candidate.modelString;
}

/** The decision policy a hint lane stamps (`forced` for anything the loop substitutes). */
function policyForHintSource(source: PolicyRouteHint["source"]): PolicyDecisionPolicy {
  switch (source) {
    case "directive":
      return "directive";
    case "rule":
      return "rule";
    case "classifier":
      return "classifier";
    default:
      return "forced";
  }
}

export function createPolicyRouter(opts: PolicyRouterOptions): PolicyRouter {
  const candidates = opts.candidates;
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    throw new Error("model-router: createPolicyRouter requires at least one candidate");
  }
  // Declaration-order fallbacks when tags don't disambiguate: cheapest = first,
  // strongest = last (the documented "declare cheapest→strongest" convention).
  const lastCandidate = candidates[candidates.length - 1] ?? firstCandidate;
  const routing = opts.routing ?? {};
  const strongTag = routing.strongTag ?? STRONG_TAG;
  const cheapTag = routing.cheapTag ?? CHEAP_TAG;
  const minSamples = Math.max(1, opts.learning?.minSamplesPerArm ?? DEFAULT_MIN_SAMPLES);
  const explorationRate = Math.max(0, Math.min(1, opts.learning?.explorationRate ?? 0));
  const bandit = opts.learning?.bandit ?? "epsilon-greedy";
  const score = opts.score;
  if (opts.policy === "learned" && score === undefined) {
    throw new Error("model-router: policy 'learned' requires an injected score lookup");
  }
  const scope = opts.scope !== undefined && opts.scope.length > 0 ? opts.scope : undefined;
  const floor = opts.floor;

  /** Strongest of a (possibly narrowed) roster: first `strongTag` match, else the last. */
  const strongestOf = (pool: readonly PoolCandidate[]): PoolCandidate =>
    firstTagged(pool, strongTag) ?? pool[pool.length - 1] ?? lastCandidate;
  /** Cheapest of a (possibly narrowed) roster: first `cheapTag` match, else the first. */
  const cheapestOf = (pool: readonly PoolCandidate[]): PoolCandidate =>
    firstTagged(pool, cheapTag) ?? pool[0] ?? firstCandidate;
  /** Strongest candidate: first `strongTag` match, else the last declared. */
  const strongest = (): PoolCandidate => strongestOf(candidates);

  /**
   * The per-arm statistics for a band: the scoped arm when it has cleared
   * warm-up (or is seeded), else — under a scope — the unscoped band arm when
   * THAT has, so a freshly scoped pool keeps steering on the history it
   * already holds while its own arm fills in (§7.9 backoff). An arm with
   * neither is cold and explored.
   */
  const readArm = (
    candidate: PoolCandidate,
    scopedKey: string,
    unscopedKey: string,
  ): {
    readonly candidate: PoolCandidate;
    readonly armId: string;
    readonly n: number;
    readonly meanReward: number;
    readonly varReward: number;
    readonly seeded: boolean;
    readonly qN: number;
    readonly qMean: number;
    readonly backedOff: boolean;
  } => {
    const armId = poolCandidateArmId(candidate);
    const scoped = score?.(scopedKey, armId);
    const cleared = (a: ArmScore | undefined): boolean =>
      a !== undefined && (a.seeded === true || a.n >= minSamples);
    let stats = scoped;
    let backedOff = false;
    if (scope !== undefined && !cleared(scoped)) {
      const unscoped = score?.(unscopedKey, armId);
      if (cleared(unscoped)) {
        stats = unscoped;
        backedOff = true;
      }
    }
    return {
      candidate,
      armId,
      n: stats?.n ?? 0,
      meanReward: stats?.meanReward ?? 0,
      varReward: stats?.varReward ?? 0,
      seeded: stats?.seeded === true,
      qN: stats?.qualityCount ?? 0,
      qMean: stats?.meanQuality ?? 0,
      backedOff,
    };
  };

  const decideLearned = (
    signals: RouteSignals,
    seed: string,
    seq: number,
    pool: readonly PoolCandidate[],
    withSuffix: (band: string) => string,
  ): PolicyDecision => {
    const { band } = routeBand(signals, routing);
    const bandKey = withSuffix(band);
    const routeKey = scopedRouteKey(bandKey, scope);
    // Snapshot each candidate's sample count / mean reward for THIS band
    // (only the arms the hint left eligible, §7.11), backing off to the
    // unscoped arm where the scoped one is still cold (§7.9).
    const arms = pool.map((candidate) => readArm(candidate, routeKey, bandKey));
    const backoffOf = (a: (typeof arms)[number]): { backedOffTo?: string } =>
      a.backedOff ? { backedOffTo: bandKey } : {};
    // Warm-up: any arm below the floor → deterministically pick the least
    // sampled (declared order breaks ties). This round-robins arms up to the
    // floor over successive turns/runs, so every arm gets sampled without any
    // RNG BEFORE any exploit/explore trade-off begins. A SEEDED arm (an
    // eval prior, §7.11) skips warm-up: its prior stands in for the samples.
    const underSampled = arms.filter((a) => a.n < minSamples && !a.seeded);
    if (underSampled.length > 0) {
      // Least-sampled wins; declared order breaks ties (reduce keeps the FIRST
      // on a tie since it only switches on a strict `<`).
      const pick = underSampled.reduce((lo, a) => (a.n < lo.n ? a : lo));
      return {
        candidate: pick.candidate,
        routeKey,
        reason: `learned/${band}: exploring under-sampled arm (n=${pick.n} < ${minSamples})`,
        policy: "learned",
        explored: true,
      };
    }
    // §7.10 — the floor: which arms may be EXPLOITED this turn. The floor
    // arm is resolved on the full roster (`floor.arm`, else the strongest);
    // when it is not in the eligible pool or has no judged quality the check
    // is suspended for the turn (status `unavailable`).
    let verdict: PolicyFloorVerdict | undefined;
    let exploitable = arms;
    if (floor !== undefined) {
      const floorArmId = floor.arm ?? poolCandidateArmId(strongest());
      const floorArm = arms.find((a) => a.armId === floorArmId);
      if (floorArm === undefined) {
        verdict = { arm: floorArmId, status: "unavailable" };
      } else {
        const check = checkFloor(
          arms.map((a) => ({ armId: a.armId, tags: a.candidate.tags, qN: a.qN, qMean: a.qMean })),
          {
            arm: floorArmId,
            ...(floor.confidence !== undefined ? { confidence: floor.confidence } : {}),
            ...(floor.tolerance !== undefined ? { tolerance: floor.tolerance } : {}),
            strongTag,
          },
        );
        if (check.status === "unavailable") {
          verdict = { arm: floorArmId, status: "unavailable" };
        } else {
          exploitable = arms.filter((a) => check.exploitable.includes(a.armId));
          const blocked = check.blocked.map((b) => b.armId);
          const onlyFloorLeft = exploitable.length === 1 && arms.length > 1;
          verdict = {
            arm: floorArmId,
            status: onlyFloorLeft ? "blocked" : "ok",
            ...(blocked.length > 0 ? { blocked } : {}),
          };
        }
      }
    }
    const floorFields = verdict !== undefined ? { floor: verdict } : {};
    // Exploit-phase best: highest mean reward among the exploitable arms
    // (declared order breaks ties).
    const best = exploitable.reduce((hi, a) => (a.meanReward > hi.meanReward ? a : hi));
    // Thompson sampling: draw each arm from its reward posterior
    // `Normal(meanReward, varReward / n)` and take the highest draw. Arms with
    // more uncertainty (higher variance / fewer samples) win more often, so it
    // self-balances explore/exploit without an ε knob. Deterministic per
    // (seed, seq, band, arm) → replayable from the transcript. Under a floor
    // the draw runs over the exploitable arms only.
    if (bandit === "thompson" && exploitable.length > 1) {
      const drawn = exploitable.map((a) => ({
        arm: a,
        value:
          a.meanReward +
          gaussian(seed, seq, band, a.armId) * Math.sqrt(a.varReward / Math.max(1, a.n)),
      }));
      const winner = drawn.reduce((hi, x) => (x.value > hi.value ? x : hi));
      return {
        candidate: winner.arm.candidate,
        routeKey,
        reason: `learned/${band}: thompson draw=${winner.value.toFixed(3)} (mean=${winner.arm.meanReward.toFixed(3)}, n=${winner.arm.n})`,
        policy: "learned",
        explored: winner.arm !== best,
        ...floorFields,
        ...backoffOf(winner.arm),
      };
    }
    // ε-greedy ONLINE exploration: with probability `explorationRate` (per a
    // transcript-seeded draw), try a non-best arm so the policy keeps sampling
    // and can escape a stale optimum. `explorationRate === 0` (the default)
    // never draws — the pick is exactly the deterministic argmax of 0.2.1.
    // Exploration draws are UNAFFECTED by the floor (§7.10): a blocked arm can
    // still be explored, capped at `explorationRate`.
    if (explorationRate > 0 && arms.length > 1) {
      const draw = uniform01(seed, seq, band, "explore");
      if (draw < explorationRate) {
        const alternatives = arms.filter((a) => a !== best);
        const idx = Math.min(
          alternatives.length - 1,
          Math.floor(uniform01(seed, seq, band, "arm") * alternatives.length),
        );
        const pick = alternatives[idx] ?? best;
        return {
          candidate: pick.candidate,
          routeKey,
          reason: `learned/${band}: ε-greedy explore (ε=${explorationRate}, draw=${draw.toFixed(3)}) → n=${pick.n} meanReward=${pick.meanReward.toFixed(3)}`,
          policy: "learned",
          explored: true,
          ...floorFields,
          ...backoffOf(pick),
        };
      }
    }
    // §7.10 — nothing but the floor arm is exploitable: serve it and say so,
    // VERBATIM (the watchdog / SLO `floor_block_rate` key on this string).
    if (verdict?.status === "blocked") {
      return {
        candidate: best.candidate,
        routeKey,
        reason: FLOOR_BLOCKED_ROUTE_REASON,
        policy: "learned",
        explored: false,
        ...floorFields,
        ...backoffOf(best),
      };
    }
    // Exploit: the best arm.
    return {
      candidate: best.candidate,
      routeKey,
      reason: `learned/${band}: best arm meanReward=${best.meanReward.toFixed(3)} (n=${best.n})`,
      policy: "learned",
      explored: false,
      ...floorFields,
      ...backoffOf(best),
    };
  };

  return {
    route(
      signals: RouteSignals,
      seed = "",
      seq = signals.turnIndex,
      hint?: PolicyRouteHint,
    ): PolicyDecision {
      // 0.6.0 §7.2 — the hint narrows the roster BEFORE the policy runs. An
      // empty eligible set is not a veto here (the loop records it); the
      // policy then runs over the full roster exactly as before.
      const eligibleIds = hint?.eligible;
      const narrowed =
        eligibleIds !== undefined && eligibleIds.length > 0
          ? candidates.filter((c) => eligibleIds.includes(poolCandidateArmId(c)))
          : [];
      const hinted: readonly PoolCandidate[] = narrowed.length > 0 ? narrowed : candidates;
      // §4.4 — an OPEN per-candidate breaker is an eligibility filter, never a
      // veto: an all-open roster stays in play (the loop records the outcome).
      const closed = hinted.filter((c) => c.breaker?.state() !== "open");
      const pool: readonly PoolCandidate[] = closed.length > 0 ? closed : hinted;
      const withSuffix = (band: string): string =>
        hint?.routeKeySuffix !== undefined ? `${band}:${hint.routeKeySuffix}` : band;
      /** The persisted key: `<scope>/<band>[:suffix]` (§7.9). */
      const keyOf = (band: string): string => scopedRouteKey(withSuffix(band), scope);
      // A forced arm on the roster is served as-is, stamped with the lane
      // that forced it; the band is still computed so the arm learns in the
      // turn's difficulty bucket.
      if (hint?.forcedArm !== undefined) {
        const forced = candidates.find((c) => poolCandidateArmId(c) === hint.forcedArm);
        if (forced !== undefined) {
          const { band } = routeBand(signals, routing);
          const evidence = hint.evidence !== undefined ? describeEvidence(hint.evidence) : "";
          return {
            candidate: forced,
            routeKey: keyOf(band),
            reason: `${hint.source}: ${poolCandidateArmId(forced)}${evidence !== "" ? ` (${evidence})` : ""}`,
            policy: policyForHintSource(hint.source),
            explored: false,
          };
        }
      }
      if (opts.policy === "static") {
        const { band } = routeBand(signals, routing);
        return {
          candidate: pool[0] ?? firstCandidate,
          routeKey: keyOf(band),
          reason:
            pool.length === candidates.length
              ? "static: first declared candidate"
              : "static: first eligible candidate",
          policy: "static",
          explored: false,
        };
      }
      if (opts.policy === "heuristic") {
        const { band, reason } = routeBand(signals, routing);
        const candidate = band === "hard" ? strongestOf(pool) : cheapestOf(pool);
        return {
          candidate,
          routeKey: keyOf(band),
          reason: `heuristic/${band}: ${reason}`,
          policy: "heuristic",
          explored: false,
        };
      }
      return decideLearned(signals, seed, seq, pool, withSuffix);
    },
    candidates(): readonly PoolCandidate[] {
      return candidates;
    },
    escalation(): PoolCandidate {
      return strongest();
    },
  };
}
