/**
 * The per-harness "watch me" store at `<rootDir>/watchme` (rootDir is the
 * harness `.crewhaus` directory, scoreboard convention).
 *
 * Files (all mode 0600):
 *   - `observations.jsonl` — append-only {@link WatchmeObservation} digests
 *     plus `{agg:1}` Welford aggregate lines written by `compact()`. NO TTL:
 *     this is the long-horizon store that outlives the 30-day transcript
 *     sweep, so digests must stand alone (no pointers into raw transcripts).
 *   - `judgments.jsonl` — append-only {@link WatchmeJudgment} verdicts from
 *     the budgeted phase-2 judge (machine signal, kept OUT of the human
 *     feedback channel).
 *   - `state.json` — {@link WatchmeState}, tmp+rename atomic.
 *   - `run.lock` — advisory single-writer lock in the dream-engine `run.lock`
 *     mold (O_EXCL create, stale-steal past 30 s).
 *
 * Concurrency model is the scoreboard's: appends are atomic small-line
 * `O_APPEND` writes so concurrent harness processes never lose each other's
 * lines; `compact()` and `setState()` are single-writer maintenance ops run
 * under `acquireLock()` and land write-then-rename so a reader never
 * observes a torn file.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  WatchmeAggregate,
  WatchmeJudgment,
  WatchmeObservation,
  WatchmeState,
} from "./types.js";

export type WatchmeStoreOptions = {
  /**
   * Spec name used in {@link WatchmeStore.windowKey} (`watchme:<spec>:<idx>`).
   * When omitted the harness directory basename (rootDir's parent) stands in —
   * still collision-exact for every process on the same harness.
   */
  readonly specName?: string;
};

export type WatchmeStore = {
  /** `<rootDir>/watchme` — where every store file lives. */
  readonly dir: string;
  /** Append one redacted digest (`O_APPEND`, mode 0600). */
  appendObservation(obs: WatchmeObservation): void;
  /** All raw (non-aggregate) observation lines; malformed lines are skipped. */
  readObservations(): WatchmeObservation[];
  /** All `{agg:1}` aggregate lines written by `compact()`. */
  readAggregates(): WatchmeAggregate[];
  /** Append one judge verdict to `judgments.jsonl`. */
  appendJudgment(j: WatchmeJudgment): void;
  readJudgments(): WatchmeJudgment[];
  /** Fold raw observations (and prior aggregates) into one Welford aggregate
   *  line per key; write-then-rename. Run under `acquireLock()`. */
  compact(): void;
  /** Current state; a missing or torn `state.json` reads as the default. */
  state(): WatchmeState;
  /** Top-level shallow merge (nested objects are replaced wholesale); lands
   *  tmp+rename atomic, mode 0600. */
  setState(patch: Partial<WatchmeState>): void;
  /** `watchme:<spec>:<floor(nowMs/everyMs)>` — the report-window idempotency
   *  key (dream-engine window math: fixed epoch-anchored flooring). */
  windowKey(nowMs: number, everyMs: number): string;
  /** Try-once advisory `run.lock` acquire: a release fn on success,
   *  `undefined` on contention. A lock older than 30 s (holder crashed) is
   *  stolen and re-raced, per the §7.6 policy. */
  acquireLock(): (() => void) | undefined;
};

/** A lock whose file mtime is older than this is presumed abandoned (§7.6). */
const LOCK_STALE_MS = 30_000;

const DEFAULT_STATE: WatchmeState = {
  schemaVersion: 1,
  watching: false,
  watermark: { lastMtimeMs: 0 },
  windows: {},
};

/** A mutable Welford accumulator, one per aggregation key. */
type Fold = {
  key: string;
  n: number;
  meanTurns: number;
  m2Turns: number;
  qualityN: number;
  meanQuality: number;
  m2Quality: number;
  tokensIn: number;
  tokensOut: number;
  costUsdMicros: number;
  toolCalls: number;
  toolErrors: number;
  feedbackUp: number;
  feedbackDown: number;
  intents: Record<string, number>;
};

function emptyFold(key: string): Fold {
  return {
    key,
    n: 0,
    meanTurns: 0,
    m2Turns: 0,
    qualityN: 0,
    meanQuality: 0,
    m2Quality: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicros: 0,
    toolCalls: 0,
    toolErrors: 0,
    feedbackUp: 0,
    feedbackDown: 0,
    intents: {},
  };
}

/** Welford update of one (mean, M2) pair. */
function foldSample(state: { n: number; mean: number; m2: number }, x: number): void {
  state.n += 1;
  const delta = x - state.mean;
  state.mean += delta / state.n;
  state.m2 += delta * (x - state.mean);
}

/** Chan et al. parallel combine of aggregate B into A. */
function combinePair(
  a: { n: number; mean: number; m2: number },
  bN: number,
  bMean: number,
  bM2: number,
): void {
  if (bN <= 0) return;
  const n = a.n + bN;
  const delta = bMean - a.mean;
  a.mean = a.mean + (delta * bN) / n;
  a.m2 = a.m2 + bM2 + (delta * delta * a.n * bN) / n;
  a.n = n;
}

/** The count-weighted pooled quality mean of one observation, if it has one. */
function qualitySample(obs: WatchmeObservation): number | undefined {
  const q = obs.quality;
  if (q === undefined) return undefined;
  let weight = 0;
  let sum = 0;
  if (q.meanRating !== undefined && q.ratings > 0) {
    weight += q.ratings;
    sum += q.ratings * q.meanRating;
  }
  if (q.meanJudge !== undefined && q.judged > 0) {
    weight += q.judged;
    sum += q.judged * q.meanJudge;
  }
  return weight > 0 ? sum / weight : undefined;
}

function foldObservation(fold: Fold, obs: WatchmeObservation): void {
  const turns = { n: fold.n, mean: fold.meanTurns, m2: fold.m2Turns };
  foldSample(turns, obs.turnCount);
  fold.n = turns.n;
  fold.meanTurns = turns.mean;
  fold.m2Turns = turns.m2;
  const q = qualitySample(obs);
  if (q !== undefined) {
    const quality = { n: fold.qualityN, mean: fold.meanQuality, m2: fold.m2Quality };
    foldSample(quality, q);
    fold.qualityN = quality.n;
    fold.meanQuality = quality.mean;
    fold.m2Quality = quality.m2;
  }
  for (const m of obs.models) {
    fold.tokensIn += m.usage.in;
    fold.tokensOut += m.usage.out;
    fold.costUsdMicros += m.costUsdMicros ?? 0;
  }
  for (const t of obs.toolStats) {
    fold.toolCalls += t.calls;
    fold.toolErrors += t.errors;
  }
  fold.feedbackUp += obs.feedback?.up ?? 0;
  fold.feedbackDown += obs.feedback?.down ?? 0;
  for (const key of obs.intentKeys) fold.intents[key] = (fold.intents[key] ?? 0) + 1;
}

function foldAggregate(fold: Fold, agg: WatchmeAggregate): void {
  const turns = { n: fold.n, mean: fold.meanTurns, m2: fold.m2Turns };
  combinePair(turns, agg.n, agg.meanTurns, agg.m2Turns);
  fold.n = turns.n;
  fold.meanTurns = turns.mean;
  fold.m2Turns = turns.m2;
  const quality = { n: fold.qualityN, mean: fold.meanQuality, m2: fold.m2Quality };
  combinePair(quality, agg.qualityN, agg.meanQuality, agg.m2Quality);
  fold.qualityN = quality.n;
  fold.meanQuality = quality.mean;
  fold.m2Quality = quality.m2;
  fold.tokensIn += agg.tokensIn;
  fold.tokensOut += agg.tokensOut;
  fold.costUsdMicros += agg.costUsdMicros;
  fold.toolCalls += agg.toolCalls;
  fold.toolErrors += agg.toolErrors;
  fold.feedbackUp += agg.feedbackUp;
  fold.feedbackDown += agg.feedbackDown;
  for (const [key, count] of Object.entries(agg.intents)) {
    fold.intents[key] = (fold.intents[key] ?? 0) + count;
  }
}

function toAggregate(fold: Fold): WatchmeAggregate {
  return {
    v: 1,
    agg: 1,
    key: fold.key,
    n: fold.n,
    meanTurns: fold.meanTurns,
    m2Turns: fold.m2Turns,
    meanQuality: fold.meanQuality,
    m2Quality: fold.m2Quality,
    qualityN: fold.qualityN,
    tokensIn: fold.tokensIn,
    tokensOut: fold.tokensOut,
    costUsdMicros: fold.costUsdMicros,
    toolCalls: fold.toolCalls,
    toolErrors: fold.toolErrors,
    feedbackUp: fold.feedbackUp,
    feedbackDown: fold.feedbackDown,
    intents: fold.intents,
  };
}

/** Parse a JSONL file into records, skipping blank/torn/malformed lines. */
function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const records: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Tolerate a torn final line from a crashed writer.
    }
  }
  return records;
}

const isObservation = (rec: Record<string, unknown>): boolean =>
  rec["agg"] !== 1 &&
  typeof rec["sessionId"] === "string" &&
  typeof rec["specName"] === "string" &&
  typeof rec["turnCount"] === "number";

const isAggregate = (rec: Record<string, unknown>): boolean =>
  rec["agg"] === 1 && typeof rec["key"] === "string" && typeof rec["n"] === "number";

const isJudgment = (rec: Record<string, unknown>): boolean =>
  typeof rec["sessionId"] === "string" &&
  typeof rec["turnNumber"] === "number" &&
  typeof rec["score"] === "number";

/** Open (or create) the watch-me store rooted at the harness `.crewhaus` dir. */
export function openWatchmeStore(rootDir: string, opts: WatchmeStoreOptions = {}): WatchmeStore {
  const dir = join(rootDir, "watchme");
  const observationsPath = join(dir, "observations.jsonl");
  const judgmentsPath = join(dir, "judgments.jsonl");
  const statePath = join(dir, "state.json");
  const lockPath = join(dir, "run.lock");
  const specToken = opts.specName ?? basename(dirname(resolve(rootDir)));

  const ensureDir = (): void => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  };

  const readObservations = (): WatchmeObservation[] =>
    readJsonl(observationsPath).filter(isObservation) as unknown as WatchmeObservation[];

  const readAggregates = (): WatchmeAggregate[] =>
    readJsonl(observationsPath).filter(isAggregate) as unknown as WatchmeAggregate[];

  const state = (): WatchmeState => {
    if (!existsSync(statePath)) return DEFAULT_STATE;
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["schemaVersion"] === 1
      ) {
        return parsed as WatchmeState;
      }
    } catch {
      // A torn or hand-mangled state file reads as never-ran rather than
      // wedging the schedule (dream-engine semantics).
    }
    return DEFAULT_STATE;
  };

  return {
    dir,
    appendObservation(obs: WatchmeObservation): void {
      ensureDir();
      appendFileSync(observationsPath, `${JSON.stringify(obs)}\n`, { mode: 0o600 });
    },
    readObservations,
    readAggregates,
    appendJudgment(j: WatchmeJudgment): void {
      ensureDir();
      appendFileSync(judgmentsPath, `${JSON.stringify(j)}\n`, { mode: 0o600 });
    },
    readJudgments(): WatchmeJudgment[] {
      return readJsonl(judgmentsPath).filter(isJudgment) as unknown as WatchmeJudgment[];
    },
    compact(): void {
      ensureDir();
      const folds = new Map<string, Fold>();
      const foldFor = (key: string): Fold => {
        let fold = folds.get(key);
        if (fold === undefined) {
          fold = emptyFold(key);
          folds.set(key, fold);
        }
        return fold;
      };
      // Prior aggregates first, then raw deltas — parallel-combine is
      // order-insensitive, but this mirrors on-disk order for readability.
      for (const agg of readAggregates()) foldAggregate(foldFor(agg.key), agg);
      for (const obs of readObservations()) {
        foldObservation(foldFor(`${obs.specName}|${obs.target}`), obs);
      }
      const lines = [...folds.values()]
        .filter((f) => f.n > 0)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((f) => JSON.stringify(toAggregate(f)));
      // Write-then-rename for an atomic swap: a concurrent reader sees either
      // the old or the new file, never a half-written one.
      const tmp = `${observationsPath}.tmp`;
      writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
      renameSync(tmp, observationsPath);
    },
    state,
    setState(patch: Partial<WatchmeState>): void {
      ensureDir();
      const next: WatchmeState = { ...state(), ...patch, schemaVersion: 1 };
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, statePath);
    },
    windowKey(nowMs: number, everyMs: number): string {
      return `watchme:${specToken}:${Math.floor(nowMs / everyMs)}`;
    },
    acquireLock(): (() => void) | undefined {
      ensureDir();
      for (;;) {
        try {
          const payload = { pid: process.pid, acquiredAt: new Date().toISOString() };
          writeFileSync(lockPath, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
          return () => {
            try {
              unlinkSync(lockPath);
            } catch {
              // Already gone — release is idempotent.
            }
          };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        let mtimeMs: number;
        try {
          mtimeMs = statSync(lockPath).mtimeMs;
        } catch {
          continue; // The holder released between create and stat — re-race.
        }
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another waiter stole it first.
          }
          continue; // Re-race the create — another waiter may legitimately win.
        }
        return undefined;
      }
    },
  };
}
