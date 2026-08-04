/**
 * The manager caching contract: fleet rollups must not walk every session JSONL
 * of a hundred harnesses on every paint.
 *
 * One JSON per harness under `<hangarRoot>/cache/<hrnId>.json` holds the
 * expensive figures (lastEval, sessionCount, feedbackCount, spend7d, cost
 * breakdown) keyed by a DIGEST of the source files consulted — names,
 * mtimes, and sizes only, so a digest check stats directories but never
 * reads a transcript. Digest mismatch → recompute lazily; matching digest →
 * serve cached with its honest `cachedAt`. The cache is rebuildable and
 * never authoritative: deleting the cache dir is always safe, which a test
 * asserts.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readRunIndex } from "@crewhaus/eval-report";
import { extractFeedbackRecords, mergeFeedback } from "@crewhaus/feedback-distill";
import { type LastEval, lastEvalFor } from "@crewhaus/harness-inventory";
import { SESSION_JSONL_RE, SESSION_JSON_RE } from "./constants";
import { type HarnessCosts, foldHarnessCosts } from "./costs";
import { readJsonlCapped } from "./jsonl";
import { resolveSessionRoot } from "./sessions";

export type HarnessRollup = {
  readonly digest: string;
  readonly cachedAt: string;
  readonly lastEval: LastEval | null;
  readonly sessionCount: number;
  readonly feedbackCount: number;
  /** USD micros accrued in the trailing 7 days. */
  readonly spend7d: number;
  readonly costBreakdown: HarnessCosts;
};

const HRN_FILE_RE = /^hrn_[0-9a-f]{16}\.json$/;

function statLine(path: string): string {
  try {
    const s = statSync(path);
    return `${path}:${s.mtimeMs}:${s.size}`;
  } catch {
    return `${path}:absent`;
  }
}

function dirLines(dir: string, filter?: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [`${dir}:absent`];
  }
  return names
    .filter((n) => (filter ? filter(n) : true))
    .sort()
    .map((n) => statLine(join(dir, n)));
}

/**
 * Digest of every source the rollup consults: session metadata + logs (at
 * the RESOLVED session root, so `.env` relocations invalidate correctly),
 * the durable sessions index, feedback files, and the eval run index.
 * Stats only — no content reads.
 */
export function computeRollupDigest(harnessDir: string): string {
  const { root } = resolveSessionRoot(harnessDir);
  const lines: string[] = [`root:${root}`];
  lines.push(...dirLines(root, (n) => SESSION_JSON_RE.test(n) || SESSION_JSONL_RE.test(n)));
  lines.push(...dirLines(join(dirname(root), "sessions-index"), (n) => SESSION_JSON_RE.test(n)));
  lines.push(...dirLines(join(harnessDir, ".crewhaus", "feedback")));
  lines.push(statLine(join(harnessDir, ".crewhaus", "evals", "index.jsonl")));
  lines.push(statLine(join(harnessDir, ".env")));
  lines.push(statLine(join(harnessDir, ".env.local")));
  return createHash("sha256").update(lines.join("|")).digest("hex");
}

function countSessionFiles(sessionRoot: string): number {
  try {
    return readdirSync(sessionRoot).filter((n) => SESSION_JSON_RE.test(n)).length;
  } catch {
    return 0;
  }
}

/** Distinct rated turns, the way `crewhaus distill` folds them: feedback
 *  events in the RESOLVED session root's logs plus bare records under
 *  `.crewhaus/feedback/*.jsonl`, merged per (sessionId, turnNumber). */
function countFeedbackRecords(harnessDir: string, sessionRoot: string): number {
  const objects: unknown[] = [];
  for (const dir of [sessionRoot, join(harnessDir, ".crewhaus", "feedback")]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      objects.push(...readJsonlCapped(join(dir, name)).objects);
    }
  }
  return mergeFeedback(extractFeedbackRecords(objects)).length;
}

/** Compute the expensive rollup from scratch (the cache-miss path). */
export function computeRollup(harnessDir: string, nowMs: number): HarnessRollup {
  const digest = computeRollupDigest(harnessDir);
  const { root } = resolveSessionRoot(harnessDir);
  const costs = foldHarnessCosts(harnessDir, nowMs);
  let lastEval: LastEval | null = null;
  try {
    lastEval = lastEvalFor(readRunIndex(join(harnessDir, ".crewhaus", "evals"))) ?? null;
  } catch {
    lastEval = null; // unreadable index — absence, not error
  }
  return {
    digest,
    cachedAt: new Date(nowMs).toISOString(),
    lastEval,
    sessionCount: countSessionFiles(root),
    feedbackCount: countFeedbackRecords(harnessDir, root),
    spend7d: costs.spend7dUsdMicros,
    costBreakdown: costs,
  };
}

export type RollupCache = {
  /** Cached-if-fresh: digest match → the stored rollup; mismatch/absent →
   *  null (plus the stale `cachedAt` when one exists, for honest latency). */
  peek(hrnId: string, harnessDir: string): { rollup: HarnessRollup | null; staleCachedAt?: string };
  /** Compute (or reuse fresh), then persist. The hydrate path. */
  get(hrnId: string, harnessDir: string, nowMs: number): HarnessRollup;
};

/** Open the rollup cache under `<hangarRoot>/cache/`. */
export function openRollupCache(hangarRoot: string): RollupCache {
  const cacheDir = join(hangarRoot, "cache");

  const readCached = (hrnId: string): HarnessRollup | undefined => {
    if (!HRN_FILE_RE.test(`${hrnId}.json`)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(cacheDir, `${hrnId}.json`), "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const r = parsed as HarnessRollup;
        if (typeof r.digest === "string" && typeof r.cachedAt === "string") return r;
      }
    } catch {
      // torn/absent cache file — a cache is rebuildable, never an error
    }
    return undefined;
  };

  const write = (hrnId: string, rollup: HarnessRollup): void => {
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const path = join(cacheDir, `${hrnId}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(rollup, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // best-effort — a cache write failure must never fail the request
    }
  };

  return {
    peek(hrnId, harnessDir) {
      const cached = readCached(hrnId);
      if (cached === undefined) return { rollup: null };
      if (!existsSync(harnessDir)) return { rollup: null, staleCachedAt: cached.cachedAt };
      const digest = computeRollupDigest(harnessDir);
      if (digest === cached.digest) return { rollup: cached };
      return { rollup: null, staleCachedAt: cached.cachedAt };
    },
    get(hrnId, harnessDir, nowMs) {
      const cached = readCached(hrnId);
      if (cached !== undefined && computeRollupDigest(harnessDir) === cached.digest) {
        return cached;
      }
      const fresh = computeRollup(harnessDir, nowMs);
      write(hrnId, fresh);
      return fresh;
    },
  };
}
