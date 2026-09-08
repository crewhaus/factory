/**
 * 0.6.0 §6.1 (PR 12) — ROUTED EVALS: measuring what production actually
 * serves, reproducibly.
 *
 * Evals were unrouted for a structural reason, not an oversight: the shared
 * deps carry a single `model: ir.agent.model` (`wire-once.ts`) and the
 * invoker's `chatLoop({...})` call threads no pool, tiers, fallbacks or
 * scoreboard. `RunEvalOptions.routing` opens that seam:
 *
 *   - `"static"` (the default) — byte-identical to a pre-0.6.0 run: the
 *     configured `agent.model`, no pool, no scoreboard, legacy baseline key.
 *   - `"as-declared"` — the spec's own `model_pool` / `model_tiers` /
 *     `model_fallbacks` are wired through `@crewhaus/model-service`'s
 *     `wireModels`, so the eval measures the routing production runs.
 *   - `"candidate:<$profile|model>"` — one roster member pinned: the run is
 *     single-model on that candidate's model and request params, and its
 *     history keys on that arm.
 *
 * DETERMINISM, corrected by verification. Pinning `learning.seed` is not
 * enough: `decideLearned` selects over ACCUMULATED arm statistics, the reward
 * folds measured wall-clock latency, and samples run four-wide by default, so
 * a shared mutable scoreboard races across samples and two runs read
 * different `arms.jsonl` content anyway. A routed eval therefore injects a
 * FROZEN snapshot through runtime-core's `_scoreboard` seam
 * ({@link freezeArmsSnapshot}): `score()` answers from statistics read ONCE
 * at run start, `record()` / `ungraded()` / `compact()` are no-op sinks whose
 * observations are captured onto the run's `routing` manifest
 * (`results.json`) instead — a run-level capture belongs on the run-level
 * artifact; each sample's own `meta.json` carries its `routes` lines. The snapshot's
 * {@link armsDigest} is recorded on the run entry and guards cross-run
 * comparison — two different arm snapshots are two different instruments.
 * `--warm-arms` seeds the snapshot from the harness's live `arms.jsonl`; the
 * digest is re-read at the end of the run so a live-arm mutation mid-run is
 * DETECTED rather than silently folded into the measurement.
 *
 * A spec-declared `learning.seed` wins; the eval seed only fills in when the
 * spec omits one (mirroring runtime-core's own precedence), and
 * `["agent","model_pool","learning","seed"]` is excluded from the optimizer
 * whitelist so a patch to it cannot produce a guaranteed-zero measured delta.
 */
import type { IrModelPool, IrModelProfile, IrThinking, IrV0 } from "@crewhaus/ir";
import { canonicalJson, fnv1a64 } from "@crewhaus/model-plan";
import type { ModelWiringFragment } from "@crewhaus/model-service";
import type { ArmStats, RouteObservation, Scoreboard } from "@crewhaus/routing-store";
import { openScoreboard } from "@crewhaus/routing-store";
import type { ModelResponseEvent, ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { RunnerError } from "./errors";
import type { EvalRouteDecision, ServedModel } from "./types";

/** The `candidate:` prefix of a pinned-arm routing mode. */
export const EVAL_ROUTING_CANDIDATE_PREFIX = "candidate:";

/**
 * `RunEvalOptions.routing`. `static` is the default so an absent option is
 * byte-identical with a pre-0.6.0 run.
 */
export type EvalRoutingMode = "static" | "as-declared" | `candidate:${string}`;

/**
 * The `learning.seed` a routed eval pins when the spec declares none. A
 * CONSTANT, not the runId: two routed runs of the same spec must make the
 * same learned draws, and a per-run seed would defeat the whole point.
 * `--seed N` (the eval seed) overrides it.
 */
export const DEFAULT_EVAL_LEARNING_SEED = "crewhaus-eval";

/** The lineage segment a routed-but-unpinned run keys its baseline under. */
export const ROUTED_ARM_SEGMENT = "routed";

/** Parse a `--routing` value. Throws a `RunnerError` naming the vocabulary. */
export function parseEvalRoutingMode(raw: string): EvalRoutingMode {
  const value = raw.trim();
  if (value === "static" || value === "as-declared") return value;
  if (value.startsWith(EVAL_ROUTING_CANDIDATE_PREFIX)) {
    const ref = value.slice(EVAL_ROUTING_CANDIDATE_PREFIX.length).trim();
    if (ref.length === 0) {
      throw new RunnerError(
        'invalid routing "candidate:" — name the roster member, e.g. candidate:$fast or candidate:claude-haiku-4-5',
      );
    }
    return `${EVAL_ROUTING_CANDIDATE_PREFIX}${ref}`;
  }
  throw new RunnerError(
    `invalid routing ${JSON.stringify(raw)} — expected static | as-declared | candidate:<$profile|model>`,
  );
}

/** The roster member a `candidate:` mode pins, `$` stripped; else undefined. */
export function evalRoutingCandidateRef(mode: EvalRoutingMode): string | undefined {
  if (!mode.startsWith(EVAL_ROUTING_CANDIDATE_PREFIX)) return undefined;
  const ref = mode.slice(EVAL_ROUTING_CANDIDATE_PREFIX.length);
  return ref.startsWith("$") ? ref.slice(1) : ref;
}

/** True for every mode that leaves the pre-0.6.0 single-model path alone. */
export function isStaticRouting(mode: EvalRoutingMode | undefined): boolean {
  return mode === undefined || mode === "static";
}

// ---------------------------------------------------------------------------
// Arm identity
// ---------------------------------------------------------------------------

/**
 * The ARM ID of one pool candidate — the `models:` profile name when the
 * candidate is a profile, else the spec model string. Mirrors
 * `@crewhaus/model-router`'s `poolCandidateArmId` (PR 10 re-keyed profiled
 * arms to the profile name); duplicated structurally rather than imported so
 * this package does not depend on the router for one field read.
 */
export function candidateArmId(candidate: IrModelProfile): string {
  return candidate.profile ?? candidate.model;
}

/** Every routable arm id of a pool, in declaration order (disabled ones dropped). */
export function poolArmIds(pool: IrModelPool): string[] {
  return pool.candidates.filter((c) => c.enabled !== false).map(candidateArmId);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The request params a pinned candidate is measured with. */
export type EvalCandidateParams = {
  readonly thinking?: IrThinking;
  readonly maxTokens?: number;
  readonly temperature?: number;
};

export type ResolvedEvalRouting = {
  readonly mode: EvalRoutingMode;
  /** The model the chat loop runs on. */
  readonly model: string;
  /** The arm this run measures; absent under `as-declared` (many arms serve). */
  readonly armId?: string;
  /** The routing options fragment to wire (`as-declared` only). */
  readonly fragment?: ModelWiringFragment;
  /** The pinned candidate's own params (`candidate:` only). */
  readonly params?: EvalCandidateParams;
  /** The pinned candidate's `instructions` overlay, appended to the prompt. */
  readonly overlay?: string;
  /** The `learning.seed` in force for this run (`as-declared` with a pool). */
  readonly learningSeed?: string;
};

/**
 * Resolve `routing` against the lowered IR. Pure: no fs, no clock.
 *
 * `as-declared` carries the agent block's routing quartet through verbatim,
 * with ONE substitution — the pool's `learning.seed` is pinned so two runs
 * with the same eval seed make identical learned draws. A spec-declared seed
 * wins.
 */
export function resolveEvalRouting(
  ir: IrV0,
  mode: EvalRoutingMode,
  opts: { readonly seed?: number } = {},
): ResolvedEvalRouting {
  if (isStaticRouting(mode)) return { mode: "static", model: ir.agent.model };
  const agent = ir.agent;
  if (mode === "as-declared") {
    const pool = agent.modelPool;
    const learningSeed =
      pool !== undefined
        ? (pool.learning?.seed ?? String(opts.seed ?? DEFAULT_EVAL_LEARNING_SEED))
        : undefined;
    const pinnedPool: IrModelPool | undefined =
      pool !== undefined && learningSeed !== undefined
        ? { ...pool, learning: { ...(pool.learning ?? {}), seed: learningSeed } }
        : pool;
    const fallbacks = agent.modelFallbacks;
    const fragment: ModelWiringFragment = {
      ...(fallbacks !== undefined && fallbacks.length > 0 ? { modelFallbacks: fallbacks } : {}),
      ...(agent.circuitBreaker !== undefined ? { circuitBreaker: agent.circuitBreaker } : {}),
      ...(agent.modelTiers !== undefined ? { modelTiers: agent.modelTiers } : {}),
      ...(pinnedPool !== undefined ? { modelPool: pinnedPool } : {}),
    };
    if (Object.keys(fragment).length === 0) {
      throw new RunnerError(
        `--routing as-declared: spec "${ir.name}" declares no model_pool, model_tiers or model_fallbacks — there is no routing to measure (use --routing static)`,
      );
    }
    return {
      mode,
      model: agent.model,
      fragment,
      ...(learningSeed !== undefined ? { learningSeed } : {}),
    };
  }

  const ref = evalRoutingCandidateRef(mode) as string;
  const candidate = findRosterMember(ir, ref);
  if (candidate === undefined) {
    const known = rosterRefs(ir);
    throw new RunnerError(
      `--routing candidate:${ref} — no such roster member in spec "${ir.name}"${
        known.length > 0
          ? ` (declared: ${known.join(", ")})`
          : " (it declares no models: registry and no model_pool)"
      }`,
    );
  }
  const params: EvalCandidateParams = {
    ...(candidate.thinking !== undefined ? { thinking: candidate.thinking } : {}),
    ...(candidate.maxTokens !== undefined ? { maxTokens: candidate.maxTokens } : {}),
    ...(candidate.temperature !== undefined ? { temperature: candidate.temperature } : {}),
  };
  const fallbacks = candidate.fallbacks;
  const fragment: ModelWiringFragment = {
    ...(fallbacks !== undefined && fallbacks.length > 0 ? { modelFallbacks: fallbacks } : {}),
    ...(candidate.circuitBreaker !== undefined ? { circuitBreaker: candidate.circuitBreaker } : {}),
  };
  return {
    mode,
    model: candidate.model,
    armId: candidateArmId(candidate),
    ...(Object.keys(fragment).length > 0 ? { fragment } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(candidate.overlay !== undefined ? { overlay: candidate.overlay } : {}),
  };
}

/** Pool candidate by profile name or model string, else a `models:` profile. */
function findRosterMember(ir: IrV0, ref: string): IrModelProfile | undefined {
  const candidates = ir.agent.modelPool?.candidates ?? [];
  return (
    candidates.find((c) => c.profile === ref) ??
    candidates.find((c) => c.model === ref) ??
    ir.models?.[ref]
  );
}

/** Every name a `candidate:` ref may take, for the did-you-mean message. */
export function rosterRefs(ir: IrV0): string[] {
  const out = new Set<string>();
  for (const c of ir.agent.modelPool?.candidates ?? []) {
    if (c.profile !== undefined) out.add(`$${c.profile}`);
    out.add(c.model);
  }
  for (const name of Object.keys(ir.models ?? {})) out.add(`$${name}`);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// The frozen score reader
// ---------------------------------------------------------------------------

/** One observation a routed run WOULD have recorded, captured instead. */
export type CapturedRouteObservation = {
  readonly routeKey: string;
  readonly arm: string;
  readonly reward: number;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly costUsd?: number;
  readonly quality?: number;
  readonly stage?: string;
  readonly strategy?: string;
};

export type FrozenScoreboard = Scoreboard & {
  /** Digest of the frozen snapshot — the routed run's instrument identity. */
  readonly armsDigest: string;
  /** Everything the run tried to record, in order. Read by `runEval` into
   *  `EvalRunSummary.config.routing.observations`. */
  observations(): ReadonlyArray<CapturedRouteObservation>;
  /** Arms the run tried to mark ungraded, in order — likewise captured onto
   *  the run's routing manifest as `routing.ungraded`. */
  ungradedArms(): ReadonlyArray<{ readonly routeKey: string; readonly arm: string }>;
};

/**
 * Digest of an arm snapshot — the eval's INSTRUMENT identity. Not a
 * cryptographic hash and not meant as one: it detects CHANGE, which is what
 * the cross-run guard needs. An EMPTY snapshot (a cold routed run without
 * `--warm-arms`) has a stable digest, so two cold runs compare cleanly.
 */
export function armsDigest(stats: ReadonlyArray<ArmStats>): string {
  const canonical = [...stats]
    .map((s) => ({
      routeKey: s.routeKey,
      model: s.model,
      n: s.n,
      meanReward: s.meanReward,
      varReward: s.varReward,
      meanLatencyMs: s.meanLatencyMs,
      meanCostUsd: s.meanCostUsd,
      costCount: s.costCount,
      meanQuality: s.meanQuality,
      varQuality: s.varQuality,
      qualityCount: s.qualityCount,
      ungraded: s.ungraded,
    }))
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey) || a.model.localeCompare(b.model));
  return fnv1a64(canonicalJson(canonical));
}

/**
 * Freeze an arm snapshot into a `Scoreboard` the routed eval injects through
 * runtime-core's `_scoreboard` seam. Reads answer from the snapshot for the
 * whole run — identical for every sample, whichever order they finish in —
 * and every write is captured rather than persisted, so a measurement run
 * can never move a production harness's learned policy.
 */
export function freezeArmsSnapshot(stats: ReadonlyArray<ArmStats>): FrozenScoreboard {
  const frozen = new Map<string, ArmStats>();
  for (const s of stats) frozen.set(`${s.routeKey}|${s.model}`, s);
  const ordered = [...stats].sort(
    (a, b) => a.routeKey.localeCompare(b.routeKey) || a.model.localeCompare(b.model),
  );
  const observed: CapturedRouteObservation[] = [];
  const ungradedSeen: Array<{ routeKey: string; arm: string }> = [];
  return {
    path: "",
    armsDigest: armsDigest(stats),
    score: (routeKey: string, model: string) => frozen.get(`${routeKey}|${model}`),
    snapshot: () => ordered.map((s) => ({ ...s })),
    record: (routeKey: string, model: string, reward: number, obs: RouteObservation) => {
      observed.push({
        routeKey,
        arm: model,
        reward,
        success: obs.success,
        latencyMs: obs.latencyMs,
        ...(obs.costUsd !== undefined ? { costUsd: obs.costUsd } : {}),
        ...(obs.quality !== undefined ? { quality: obs.quality } : {}),
        ...(obs.stage !== undefined ? { stage: obs.stage } : {}),
        ...(obs.strategy !== undefined ? { strategy: obs.strategy } : {}),
      });
    },
    ungraded: (routeKey: string, model: string) => {
      ungradedSeen.push({ routeKey, arm: model });
    },
    compact: () => undefined,
    observations: () => observed,
    ungradedArms: () => ungradedSeen,
  };
}

/**
 * Read the harness's LIVE arms (`<rootDir>/routing/arms.jsonl`) for
 * `--warm-arms`. A missing store is an empty snapshot, never an error: an
 * eval must run on a harness that has never learned.
 */
export function readLiveArms(rootDir: string): ArmStats[] {
  return openScoreboard(rootDir).snapshot();
}

// ---------------------------------------------------------------------------
// Served-model attribution (§6.1)
// ---------------------------------------------------------------------------

/**
 * Fold a sample's `model_response` events into per-(model, role) served
 * entries. `SampleResult.model` stays the CONFIGURED model for
 * compatibility; THIS is what actually answered.
 *
 * A cascade turn serves MORE THAN ONE model per sample (a draft rung and an
 * escalation rung), and a judge / guide / classifier call serves another
 * still — so the list carries one entry per (wire model, spec model, profile,
 * role, stage) and never collapses them: per-arm lineage must be able to
 * count the draft arm's judged quality without double-counting the
 * escalation.
 */
export function foldServedModels(events: ReadonlyArray<TraceEvent>): ServedModel[] {
  const byKey = new Map<string, { entry: ServedModel; order: number }>();
  let order = 0;
  for (const ev of events) {
    if (ev.kind !== "model_response") continue;
    const e = ev as ModelResponseEvent;
    const key = JSON.stringify([
      e.model,
      e.specModel ?? null,
      e.profile ?? null,
      e.role ?? null,
      e.stage ?? null,
    ]);
    const found = byKey.get(key);
    if (found === undefined) {
      byKey.set(key, {
        order: order++,
        entry: {
          wire: e.model,
          ...(e.specModel !== undefined ? { specModel: e.specModel } : {}),
          ...(e.profile !== undefined ? { profile: e.profile } : {}),
          ...(e.role !== undefined ? { role: e.role } : {}),
          ...(e.stage !== undefined ? { stage: e.stage } : {}),
          calls: 1,
          tokens: { input: e.usage.input, output: e.usage.output },
        },
      });
      continue;
    }
    const prev = found.entry;
    found.entry = {
      ...prev,
      calls: prev.calls + 1,
      tokens: {
        input: prev.tokens.input + e.usage.input,
        output: prev.tokens.output + e.usage.output,
      },
    };
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order).map((v) => v.entry);
}

/**
 * Fold a sample's `model_route` decisions into the durable per-sample lines
 * `meta.json` records. `arm` is the arm id the scoreboard keys on — the
 * profile name when the candidate is a profile, else the SPEC model string
 * (never the wire id, which a failover chain member can change under it).
 *
 * The fields are chosen so two runs of the same seed produce IDENTICAL lines:
 * nothing derived from wall-clock or from a per-run id is carried.
 */
export function foldRouteDecisions(events: ReadonlyArray<TraceEvent>): EvalRouteDecision[] {
  const out: EvalRouteDecision[] = [];
  for (const ev of events) {
    if (ev.kind !== "model_route") continue;
    const e = ev as ModelRouteEvent;
    out.push({
      routeKey: e.routeKey,
      arm: e.profile ?? e.specModel ?? e.model,
      model: e.model,
      policy: e.policy,
      reason: e.reason,
      ...(e.explored === true ? { explored: true } : {}),
      ...(e.stage !== undefined ? { stage: e.stage } : {}),
      ...(e.scope !== undefined ? { scope: e.scope } : {}),
      ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
      ...(e.policyVersion !== undefined ? { policyVersion: e.policyVersion } : {}),
      ...(e.backedOffTo !== undefined ? { backedOffTo: e.backedOffTo } : {}),
    });
  }
  return out;
}

/** Merge per-sample served-model entries into one run-level list. */
export function mergeServedModels(
  perSample: ReadonlyArray<ReadonlyArray<ServedModel> | undefined>,
): ServedModel[] {
  const byKey = new Map<string, { entry: ServedModel; order: number }>();
  let order = 0;
  for (const list of perSample) {
    for (const s of list ?? []) {
      const key = JSON.stringify([
        s.wire,
        s.specModel ?? null,
        s.profile ?? null,
        s.role ?? null,
        s.stage ?? null,
      ]);
      const found = byKey.get(key);
      if (found === undefined) {
        byKey.set(key, { order: order++, entry: { ...s, tokens: { ...s.tokens } } });
        continue;
      }
      found.entry = {
        ...found.entry,
        calls: found.entry.calls + s.calls,
        tokens: {
          input: found.entry.tokens.input + s.tokens.input,
          output: found.entry.tokens.output + s.tokens.output,
        },
      };
    }
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order).map((v) => v.entry);
}
