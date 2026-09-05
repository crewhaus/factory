/**
 * N2 — eval-seeded priors (§6.1, §7.11). `eval leaderboard --export-priors`
 * writes `.crewhaus/routing/priors.json` in REWARD UNITS (each arm's eval
 * quality folded with its expected cost and latency through
 * `computeReward`, pseudo-count capped at ten); with `reward.priors: eval`
 * the router seeds `ArmScore` from it so warm-up is skipped for seeded arms.
 *
 * This module is the fs-free half: it VALIDATES an already-read JSON value
 * and turns it into a lookup. The file is hashed into `poolFingerprint` (a
 * new leaderboard is a new `policyVersion`); a malformed or
 * fingerprint-stale file is IGNORED with a reason the caller prints as a
 * boot warning, and the router falls back to cold warm-up — never to a
 * silently wrong prior.
 */
import { canonicalJson, fnv1a64 } from "./fingerprint.js";
import type { ArmPrior } from "./types.js";

/** The on-disk shape (version 1). */
export type PriorsFile = {
  readonly version: 1;
  /** The `planFingerprint` of the pool the priors were computed for. */
  readonly fingerprint: string;
  readonly generatedAt?: string;
  /** Provenance: which eval run / leaderboard produced these. */
  readonly source?: string;
  readonly arms: ReadonlyArray<{
    readonly routeKey: string;
    readonly arm: string;
    readonly n: number;
    readonly meanReward: number;
    readonly varReward?: number;
  }>;
};

/** Pseudo-count cap: a prior can never outweigh ten live observations. */
export const MAX_PRIOR_PSEUDO_COUNT = 10;

export type LoadedPriors = {
  readonly fingerprint: string;
  /** `routeKey|arm` → seeded score. */
  readonly arms: ReadonlyMap<string, ArmPrior>;
  /** Digest of the accepted file, for `poolFingerprint`. */
  readonly digest: string;
};

export type LoadPriorsResult =
  | { readonly ok: true; readonly priors: LoadedPriors }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "fingerprint-stale" | "unsupported-version";
      readonly detail: string;
    };

export type LoadPriorsOptions = {
  /** The live pool's `planFingerprint`; when given, a mismatch rejects the file. */
  readonly expectFingerprint?: string;
  /** Override the pseudo-count cap (tests). Default `MAX_PRIOR_PSEUDO_COUNT`. */
  readonly maxPseudoCount?: number;
};

/** The scoreboard key convention (`@crewhaus/routing-store`): `${routeKey}|${arm}`. */
export function priorKey(routeKey: string, arm: string): string {
  return `${routeKey}|${arm}`;
}

export function loadPriors(raw: unknown, opts: LoadPriorsOptions = {}): LoadPriorsResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed", detail: "priors file is not a JSON object" };
  }
  const file = raw as Partial<PriorsFile> & { version?: unknown };
  if (file.version !== 1) {
    return {
      ok: false,
      reason: "unsupported-version",
      detail: `priors version ${String(file.version)} is not supported (expected 1)`,
    };
  }
  if (typeof file.fingerprint !== "string" || file.fingerprint.length === 0) {
    return { ok: false, reason: "malformed", detail: "priors file has no fingerprint" };
  }
  if (!Array.isArray(file.arms)) {
    return { ok: false, reason: "malformed", detail: "priors file has no arms array" };
  }
  if (opts.expectFingerprint !== undefined && file.fingerprint !== opts.expectFingerprint) {
    return {
      ok: false,
      reason: "fingerprint-stale",
      detail: `priors were computed for pool ${file.fingerprint}, the live pool is ${opts.expectFingerprint} — re-run eval leaderboard --export-priors`,
    };
  }
  const cap = Math.max(1, opts.maxPseudoCount ?? MAX_PRIOR_PSEUDO_COUNT);
  const arms = new Map<string, ArmPrior>();
  for (const [i, entry] of file.arms.entries()) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, reason: "malformed", detail: `arms[${i}] is not an object` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["routeKey"] !== "string" || typeof e["arm"] !== "string") {
      return {
        ok: false,
        reason: "malformed",
        detail: `arms[${i}] needs routeKey and arm strings`,
      };
    }
    const n = e["n"];
    const mean = e["meanReward"];
    if (!isFiniteNumber(n) || n < 0 || !isFiniteNumber(mean) || mean < 0 || mean > 1) {
      return {
        ok: false,
        reason: "malformed",
        detail: `arms[${i}] needs n >= 0 and meanReward in [0, 1]`,
      };
    }
    const varReward = e["varReward"];
    if (varReward !== undefined && (!isFiniteNumber(varReward) || varReward < 0)) {
      return { ok: false, reason: "malformed", detail: `arms[${i}] varReward must be >= 0` };
    }
    const key = priorKey(e["routeKey"], e["arm"]);
    if (arms.has(key)) {
      return { ok: false, reason: "malformed", detail: `arms[${i}] duplicates ${key}` };
    }
    arms.set(key, {
      n: Math.min(cap, Math.floor(n)),
      meanReward: mean,
      ...(varReward !== undefined ? { varReward: varReward as number } : {}),
    });
  }
  return {
    ok: true,
    priors: { fingerprint: file.fingerprint, arms, digest: fnv1a64(canonicalJson(raw)) },
  };
}

/**
 * Compose a scoreboard lookup with priors: a live arm with observations wins;
 * an arm the live scoreboard has never seen reads its prior, so warm-up
 * (`minSamplesPerArm`) is skipped for seeded arms. The result is the
 * `ScoreLookup` shape `@crewhaus/model-router` consumes.
 */
export function seededScoreLookup(
  live: (routeKey: string, arm: string) => ArmPrior | undefined,
  priors: LoadedPriors | undefined,
): (routeKey: string, arm: string) => ArmPrior | undefined {
  if (priors === undefined) return live;
  return (routeKey, arm) => {
    const observed = live(routeKey, arm);
    if (observed !== undefined && observed.n > 0) return observed;
    const prior = priors.arms.get(priorKey(routeKey, arm));
    if (prior === undefined) return observed;
    // The prior stands in for the missing live history; `seeded` tells the
    // router to skip warm-up for it (a pseudo-count ≤ 10 would otherwise sit
    // under the 25-sample floor and the arm would be explored as if cold).
    return { ...prior, seeded: true };
  };
}

/**
 * The fingerprint a priors file is pinned to: the ROSTER (`model_pool.
 * candidates`, every per-candidate setting included), not the whole pool.
 * Priors describe arms, so a rule toggle or a `learning` edit must not
 * invalidate them — but any change to what an arm IS (its model, its
 * settings, its enabled flag) does. `eval leaderboard --export-priors`
 * writes this value as `PriorsFile.fingerprint`; runtime-core passes it as
 * `expectFingerprint` when it loads the file.
 */
export function priorsFingerprint(candidates: ReadonlyArray<unknown>): string {
  return fnv1a64(canonicalJson(candidates));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
