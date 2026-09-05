/**
 * The durable per-`(routeKey, model)` reward scoreboard behind `model_pool`
 * learned routing — the persistence layer that makes model selection improve
 * the more a harness is used.
 *
 * Storage: an append-only JSONL at `<rootDir>/routing/arms.jsonl` (mode 0600).
 * Each line is either
 *   - a DELTA observation  `{v:1,k,m,r,s,l,c?,t?}` (one recorded model call), or
 *   - an AGGREGATE snapshot `{v:1,agg:1,k,m,n,mr,m2,ml,mc?,cn}` (written by
 *     `compact()` so the file can be shrunk to one line per arm).
 *
 * 0.6.0 §7.9 / §7.10 (PR 9c) — additive `v:2` fields, all optional:
 *   - a delta line carrying a judged quality or hybrid-strategy attribution
 *     adds `q` (quality in [0,1]), `st` (stage), `sg` (strategy), `at`
 *     (attributedTo) and `wp` (wouldPass) and is stamped `v:2`; a 0.5.x reader
 *     folds it as a plain delta (it reads only `k`/`m`/`r`/`l`/`c`), a 0.6.0
 *     reader also folds `q` into the arm's quality mean.
 *   - an `ungraded()` increment is persisted as an AGGREGATE line with `n:0`
 *     and `ug:1` — never as a phantom delta (a line with `m` and no `r` would
 *     fold as reward 0 on any reader); a 0.5.x reader's parallel-combine
 *     returns early on `n <= 0`, so the line is invisible to it.
 *   - `compact()` carries `qs`/`qn`/`ug` through (only when non-zero, so a
 *     store that never recorded quality compacts byte-identically).
 *
 * Append-only + load-time replay is what makes the store correct under
 * CONCURRENT harness processes: every run only ever appends its own new
 * observations (atomic small-line `O_APPEND` writes) and never rewrites another
 * run's data, so two harnesses learning into the same store cannot lose each
 * other's updates. Aggregates are folded in memory with Welford's algorithm on
 * load; `compact()` (an explicit single-writer maintenance op, e.g. from
 * `crewhaus route`) rewrites the file to aggregate lines.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RouteObservation } from "./reward.js";

/** Rolled-up statistics for one `(routeKey, model)` arm. */
export type ArmStats = {
  readonly routeKey: string;
  readonly model: string;
  /** Number of observations folded into this arm. */
  readonly n: number;
  /** Running mean reward in `[0, 1]`. */
  readonly meanReward: number;
  /** Sample variance of reward (0 when `n < 2`). */
  readonly varReward: number;
  /** Running mean latency (ms) across all observations. */
  readonly meanLatencyMs: number;
  /** Running mean cost (USD) across observations that carried a cost; 0 when none did. */
  readonly meanCostUsd: number;
  /** How many observations carried a cost (denominator for `meanCostUsd`). */
  readonly costCount: number;
  /** 0.6.0 §7.10 — running mean of the JUDGED quality across observations that carried one; 0 when none did. */
  readonly meanQuality: number;
  /** How many observations carried a judged quality (denominator for `meanQuality`). */
  readonly qualityCount: number;
  /**
   * 0.6.0 §6.3 / §7.13 — observations whose grader THREW: the arm served but
   * no quality could be attributed, so no reward line was recorded (an omitted
   * quality would read as a perfect 1.0 through `computeReward`). Counted on
   * the arm so the quality mean's denominator is honest about what it misses.
   */
  readonly ungraded: number;
};

/** A mutable Welford accumulator kept in memory, one per arm. */
type Arm = {
  routeKey: string;
  model: string;
  n: number;
  mean: number;
  m2: number;
  latSum: number;
  costSum: number;
  costCount: number;
  qSum: number;
  qN: number;
  ungraded: number;
};

export type ScoreboardOptions = {
  /**
   * Clock for the optional `t` timestamp on delta lines. Injected so tests are
   * deterministic; defaults to `Date.now`. Timestamps are advisory (retention /
   * debugging) and never affect aggregation.
   */
  readonly now?: () => number;
};

/** The reader half handed to a `PolicyRouter` — a pure lookup, no I/O. */
export interface ScoreReader {
  score(routeKey: string, model: string): ArmStats | undefined;
}

export interface Scoreboard extends ScoreReader {
  /** Fold one observation into the arm and append it to the store. */
  record(routeKey: string, model: string, reward: number, obs: RouteObservation): void;
  /**
   * 0.6.0 §6.3 / §7.13 — count one served-but-ungraded observation on the arm
   * (the grader threw, so no reward line is recorded). Appended as an
   * aggregate line with `n:0`, invisible to a 0.5.x reader.
   */
  ungraded(routeKey: string, model: string): void;
  /** All arms, sorted by routeKey then model (stable ordering for `route status`). */
  snapshot(): ArmStats[];
  /** Rewrite the file to one aggregate line per arm (shrinks an append-heavy store). */
  compact(): void;
  /** Absolute path of the backing file. */
  readonly path: string;
}

// In-memory Map key only (never persisted): the separator can't appear in a
// routeKey (we mint those as alphanumeric bands), so distinct pairs never
// collide even if a model string happens to contain the separator.
const SEP = "|";
const armKey = (routeKey: string, model: string): string => `${routeKey}${SEP}${model}`;

function emptyArm(routeKey: string, model: string): Arm {
  return {
    routeKey,
    model,
    n: 0,
    mean: 0,
    m2: 0,
    latSum: 0,
    costSum: 0,
    costCount: 0,
    qSum: 0,
    qN: 0,
    ungraded: 0,
  };
}

/** Welford update: fold a single reward into a running (mean, M2). */
function foldReward(arm: Arm, reward: number): void {
  arm.n += 1;
  const delta = reward - arm.mean;
  arm.mean += delta / arm.n;
  arm.m2 += delta * (reward - arm.mean);
}

/**
 * Chan et al. parallel combine: fold a whole aggregate `B` into `arm` (`A`).
 * Used on load when an `agg` line seeds an arm that later delta lines extend,
 * or when two aggregate lines for the same arm appear.
 */
function combineAggregate(
  arm: Arm,
  bN: number,
  bMean: number,
  bM2: number,
  bLatSum: number,
  bCostSum: number,
  bCostCount: number,
): void {
  if (bN <= 0) return;
  const aN = arm.n;
  const n = aN + bN;
  const delta = bMean - arm.mean;
  arm.mean = arm.mean + (delta * bN) / n;
  arm.m2 = arm.m2 + bM2 + (delta * delta * aN * bN) / n;
  arm.n = n;
  arm.latSum += bLatSum;
  arm.costSum += bCostSum;
  arm.costCount += bCostCount;
}

function toStats(arm: Arm): ArmStats {
  return {
    routeKey: arm.routeKey,
    model: arm.model,
    n: arm.n,
    meanReward: arm.mean,
    varReward: arm.n > 1 ? arm.m2 / (arm.n - 1) : 0,
    meanLatencyMs: arm.n > 0 ? arm.latSum / arm.n : 0,
    meanCostUsd: arm.costCount > 0 ? arm.costSum / arm.costCount : 0,
    costCount: arm.costCount,
    meanQuality: arm.qN > 0 ? arm.qSum / arm.qN : 0,
    qualityCount: arm.qN,
    ungraded: arm.ungraded,
  };
}

/** Fold a `v:2` delta's optional judged quality into the arm. */
function foldQuality(arm: Arm, quality: unknown): void {
  if (typeof quality !== "number" || !Number.isFinite(quality)) return;
  arm.qSum += Math.min(1, Math.max(0, quality));
  arm.qN += 1;
}

/** Parse one JSONL line into the in-memory arm map. Malformed lines are skipped. */
function applyLine(arms: Map<string, Arm>, line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return; // tolerate a torn final line from a crashed writer
  }
  const routeKey = typeof rec["k"] === "string" ? rec["k"] : undefined;
  const model = typeof rec["m"] === "string" ? rec["m"] : undefined;
  if (routeKey === undefined || model === undefined) return;
  const key = armKey(routeKey, model);
  let arm = arms.get(key);
  if (arm === undefined) {
    arm = emptyArm(routeKey, model);
    arms.set(key, arm);
  }
  if (rec["agg"] === 1) {
    // `ls`/`cs` are raw SUMS (not means) so parallel-combine can add them.
    combineAggregate(
      arm,
      typeof rec["n"] === "number" ? rec["n"] : 0,
      typeof rec["mr"] === "number" ? rec["mr"] : 0,
      typeof rec["m2"] === "number" ? rec["m2"] : 0,
      typeof rec["ls"] === "number" ? rec["ls"] : 0,
      typeof rec["cs"] === "number" ? rec["cs"] : 0,
      typeof rec["cn"] === "number" ? rec["cn"] : 0,
    );
    // 0.6.0 — the quality sums and the ungraded counter ride aggregate lines
    // (a compacted store, or an `ungraded()` increment with `n:0`).
    if (typeof rec["qs"] === "number" && typeof rec["qn"] === "number" && rec["qn"] > 0) {
      arm.qSum += rec["qs"];
      arm.qN += rec["qn"];
    }
    if (typeof rec["ug"] === "number" && rec["ug"] > 0) arm.ungraded += rec["ug"];
    return;
  }
  // Delta observation.
  const reward = typeof rec["r"] === "number" ? rec["r"] : 0;
  foldReward(arm, reward);
  arm.latSum += typeof rec["l"] === "number" ? rec["l"] : 0;
  const cost = rec["c"];
  if (typeof cost === "number") {
    arm.costSum += cost;
    arm.costCount += 1;
  }
  foldQuality(arm, rec["q"]);
}

/**
 * Open (or create) the scoreboard rooted at `rootDir`. The backing file is
 * `<rootDir>/routing/arms.jsonl`; a missing file is treated as an empty store.
 */
export function openScoreboard(rootDir: string, opts: ScoreboardOptions = {}): Scoreboard {
  const path = join(rootDir, "routing", "arms.jsonl");
  const now = opts.now ?? Date.now;
  const arms = new Map<string, Arm>();

  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) applyLine(arms, line);
  }

  const ensureDir = (): void => {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  };

  return {
    path,
    score(routeKey: string, model: string): ArmStats | undefined {
      const arm = arms.get(armKey(routeKey, model));
      return arm === undefined ? undefined : toStats(arm);
    },
    record(routeKey: string, model: string, reward: number, obs: RouteObservation): void {
      const key = armKey(routeKey, model);
      let arm = arms.get(key);
      if (arm === undefined) {
        arm = emptyArm(routeKey, model);
        arms.set(key, arm);
      }
      foldReward(arm, reward);
      arm.latSum += Math.max(0, obs.latencyMs);
      // 0.6.0 — a line carrying quality or strategy attribution is `v:2`; a
      // plain observation keeps the exact `v:1` shape (byte-identical store).
      const enriched =
        obs.quality !== undefined ||
        obs.stage !== undefined ||
        obs.strategy !== undefined ||
        obs.attributedTo !== undefined ||
        obs.wouldPass !== undefined;
      const line: Record<string, unknown> = {
        v: enriched ? 2 : 1,
        k: routeKey,
        m: model,
        r: reward,
        s: obs.success ? 1 : 0,
        l: Math.max(0, obs.latencyMs),
        t: now(),
      };
      if (obs.costUsd !== undefined) {
        arm.costSum += Math.max(0, obs.costUsd);
        arm.costCount += 1;
        line["c"] = Math.max(0, obs.costUsd);
      }
      if (obs.quality !== undefined && Number.isFinite(obs.quality)) {
        const q = Math.min(1, Math.max(0, obs.quality));
        foldQuality(arm, q);
        line["q"] = q;
      }
      if (obs.stage !== undefined) line["st"] = obs.stage;
      if (obs.strategy !== undefined) line["sg"] = obs.strategy;
      if (obs.attributedTo !== undefined) line["at"] = obs.attributedTo;
      if (obs.wouldPass !== undefined) line["wp"] = obs.wouldPass ? 1 : 0;
      ensureDir();
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    },
    ungraded(routeKey: string, model: string): void {
      const key = armKey(routeKey, model);
      let arm = arms.get(key);
      if (arm === undefined) {
        arm = emptyArm(routeKey, model);
        arms.set(key, arm);
      }
      arm.ungraded += 1;
      // An aggregate line with `n:0`: a 0.5.x reader's parallel-combine
      // returns early on `n <= 0`, so the increment never reads as a reward.
      const line = { v: 2, agg: 1, k: routeKey, m: model, n: 0, ug: 1, t: now() };
      ensureDir();
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    },
    snapshot(): ArmStats[] {
      return [...arms.values()]
        .map(toStats)
        .sort((a, b) => a.routeKey.localeCompare(b.routeKey) || a.model.localeCompare(b.model));
    },
    compact(): void {
      ensureDir();
      const lines = [...arms.values()]
        .filter((a) => a.n > 0 || a.ungraded > 0)
        .sort((a, b) => a.routeKey.localeCompare(b.routeKey) || a.model.localeCompare(b.model))
        .map((a) =>
          JSON.stringify({
            v: a.qN > 0 || a.ungraded > 0 ? 2 : 1,
            agg: 1,
            k: a.routeKey,
            m: a.model,
            n: a.n,
            mr: a.mean,
            m2: a.m2,
            // `ls`/`cs` are raw SUMS (latency, cost) so a reopened store can
            // parallel-combine them with later delta lines; means are derived.
            ls: a.latSum,
            cs: a.costSum,
            cn: a.costCount,
            // 0.6.0 — carried only when present, so a store that never
            // recorded quality compacts byte-identically to 0.5.x.
            ...(a.qN > 0 ? { qs: a.qSum, qn: a.qN } : {}),
            ...(a.ungraded > 0 ? { ug: a.ungraded } : {}),
          }),
        );
      // Write-then-rename for an atomic swap: a concurrent reader sees either
      // the old or the new file, never a half-written one.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}
