/**
 * Reading `@crewhaus/watchme-store` — the observational-learning ledger — and
 * the two places its tolerant reads have to be made intolerant again.
 *
 * The store is deliberately forgiving, because it is read by a background
 * loop that must not wedge: a torn `state.json` "reads as never-ran rather
 * than wedging the schedule (dream-engine semantics)", and a malformed JSONL
 * line is skipped. That is right for the loop and wrong for a report. A tool
 * that says "watching: false" because the state file was truncated has told
 * an operator the opposite of the truth, and a roll-up that silently drops
 * half its observation lines reports a healthy small store instead of a
 * damaged large one.
 *
 * So: the VALUES still come from the store (nothing here re-implements the
 * Welford fold, the last-writer-wins dedupe by sessionId, or the aggregate
 * grammar), but the FILES are probed first, and a file that exists and cannot
 * be understood is reported as its own state instead of as an absent one.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  WatchmeAggregate,
  WatchmeJudgment,
  WatchmeObservation,
  WatchmeState,
} from "@crewhaus/watchme-store";
import { openWatchmeStore } from "@crewhaus/watchme-store";
import { type Loaded, compareStrings, fail, isPlainObject, renderPath } from "./result";
import { type MeanView, type RateView, meanWithInterval, rate } from "./stats";

/** The store's own directory name under the harness state dir. */
export const WATCHME_RELDIR = "watchme";

/** Every path a watchme read opens, relative to the harness state directory. */
export const WATCHME_READ_RELPATHS: ReadonlyArray<string> = [
  WATCHME_RELDIR,
  `${WATCHME_RELDIR}/observations.jsonl`,
  `${WATCHME_RELDIR}/judgments.jsonl`,
  `${WATCHME_RELDIR}/state.json`,
];

/**
 * The three report-window outcomes, as `WatchmeState.windows` records them.
 *
 * Collapsing these into "failed" is the trap the survey named: a
 * `model_refused_unpriced` window is a CONFIGURATION error (the harness is
 * pointed at a model with no price, so the report refused to spend against an
 * unknown cost) and it consumed the window; a `model_failed` is transient and
 * the next tick retries. One needs an edit, the other needs nothing.
 */
export const WINDOW_OUTCOMES = ["ok", "model_refused_unpriced", "model_failed"] as const;
export type WindowOutcome = (typeof WINDOW_OUTCOMES)[number];

export type WindowTally = {
  readonly ok: number;
  readonly model_refused_unpriced: number;
  readonly model_failed: number;
  /**
   * Windows whose recorded value is none of the three. A hand-edited or
   * future-version state file lands here rather than being counted as a
   * success — the count is the fold of a PARSED value, never of a string that
   * merely looked close.
   */
  readonly unrecognised: ReadonlyArray<{ readonly windowKey: string; readonly value: string }>;
  readonly total: number;
  /**
   * Set when `windows` is not an object of windowKey -> outcome at all. The
   * three counts are then 0 because nothing could be read, which is a
   * different statement from "no window has been consumed".
   */
  readonly unreadable?: string;
};

function isWindowOutcome(value: unknown): value is WindowOutcome {
  return typeof value === "string" && (WINDOW_OUTCOMES as ReadonlyArray<string>).includes(value);
}

export function tallyWindows(windows: unknown): WindowTally {
  const counts: Record<WindowOutcome, number> = {
    ok: 0,
    model_refused_unpriced: 0,
    model_failed: 0,
  };
  const unrecognised: Array<{ windowKey: string; value: string }> = [];
  // `WatchmeState.windows` is typed as a record and is whatever JSON the file
  // held — `Object.keys("abc")` would happily return ["0","1","2"] and invent
  // three windows. An input that is not an object is reported as unreadable
  // rather than tallied as zero consumed windows.
  if (windows !== undefined && !isPlainObject(windows)) {
    return {
      ...counts,
      unrecognised,
      total: 0,
      unreadable: `windows in state.json is ${Array.isArray(windows) ? "an array" : typeof windows}, not an object of windowKey -> outcome — no window could be read, which is not the same as no window having been consumed`,
    };
  }
  const keys = Object.keys(windows ?? {}).sort(compareStrings);
  for (const windowKey of keys) {
    const value = (windows as Record<string, unknown>)[windowKey];
    if (isWindowOutcome(value)) counts[value] += 1;
    else unrecognised.push({ windowKey, value: renderPath(String(value)) });
  }
  return { ...counts, unrecognised, total: keys.length };
}

/**
 * One durable `fedRoutingKeys` entry, parsed.
 *
 * `watchme report --feed-routing` writes `sessionId#turnNumber` for an
 * unstaged turn and `sessionId#turnNumber#stage` for each stage of a hybrid
 * one. A reader that asks `fed.has(\`${sessionId}#${turnNumber}\`)` therefore
 * misses every staged turn and reports judged turns as un-fed that were fed
 * three times over. The turn identity is the PARSED (sessionId, turnNumber)
 * pair, so that is what gets compared — never the key's spelling.
 */
export type FedKey = {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly stage?: string;
};

export function parseFedKey(key: string): FedKey | undefined {
  const parts = key.split("#");
  if (parts.length < 2) return undefined;
  const sessionId = parts[0];
  const turn = parts[1];
  if (sessionId === undefined || sessionId.length === 0 || turn === undefined) return undefined;
  const turnNumber = Number(turn);
  if (!Number.isInteger(turnNumber)) return undefined;
  const stage = parts.slice(2).join("#");
  return { sessionId, turnNumber, ...(stage.length > 0 ? { stage } : {}) };
}

/**
 * The turn identity a judgment and a fed key are compared on.
 *
 * A JSON pair rather than a joined string: session ids are `sess_<hex>` today,
 * but a separator character is a bug waiting for the first id that contains
 * it, and a control byte as a separator is a raw control byte in source.
 */
export const turnId = (sessionId: string, turnNumber: number): string =>
  JSON.stringify([sessionId, turnNumber]);

/**
 * Whether the state document can be trusted, kept apart from what it says.
 *
 * `WatchmeStore.state()` returns the DEFAULT state for a missing file, a torn
 * file and a file whose `schemaVersion` is not 1 — three situations with one
 * answer, and the answer is the one that reads as "this harness has never
 * watched anything". The file is therefore probed for its shape before the
 * store's values are used. The probe never becomes the reader: when it says
 * the document is fine, the fields still come from `store.state()`.
 */
export type StateProbe =
  | { readonly state: "absent" }
  | { readonly state: "ok" }
  | { readonly state: "unreadable"; readonly detail: string };

export function probeState(watchmeDir: string): StateProbe {
  const path = join(watchmeDir, "state.json");
  if (!existsSync(path)) {
    // `existsSync` follows symlinks, so a dangling link reports absent here.
    // That is the correct answer for a READ: there is nothing to read through
    // it. The write-side trap (a dangling link that `open(…,"w")` creates) is
    // handled by containment before any of this runs.
    return { state: "absent" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { state: "unreadable", detail: `state.json could not be read (${code ?? "unknown"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      state: "unreadable",
      detail: `state.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — the store reads this as a harness that has never watched anything, which is a different claim`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unreadable", detail: "state.json is not a JSON object" };
  }
  const version = (parsed as Record<string, unknown>)["schemaVersion"];
  if (version !== 1) {
    return {
      state: "unreadable",
      detail: `state.json carries schemaVersion ${String(version)} (expected 1) — the store falls back to its default state for this, which reads as never-watched`,
    };
  }
  // A `schemaVersion` of 1 is the ONLY thing `WatchmeStore.state()` checks:
  // everything after it is `parsed as WatchmeState`, so the fields this report
  // renders are whatever JSON was in the file. Probing the version and then
  // acting on the fields would be validating one thing and using another —
  // and it is not theoretical: `startedAt: 1e20` made `new Date(x)
  // .toISOString()` throw a RangeError straight out of `execute`, and a
  // non-array `fedRoutingKeys` made `for…of` throw. The reads below are now
  // total, and this names WHICH field is wrong instead of reporting a
  // damaged document as a healthy one.
  const bad = malformedStateFields(parsed as Record<string, unknown>);
  if (bad.length > 0) {
    return {
      state: "unreadable",
      detail: `state.json parses and carries schemaVersion 1, but ${bad.join("; ")}. The store hands these fields back unvalidated, so anything below that depends on them is not to be trusted`,
    };
  }
  return { state: "ok" };
}

/** The widest epoch-ms `Date` renders; past it `toISOString()` throws. */
const MAX_TIME_MS = 8.64e15;

/**
 * Which `WatchmeState` fields are not the shape the type declares.
 *
 * Only the fields this report actually reads, named individually, because
 * "the state file is broken" sends an operator to the wrong place.
 */
function malformedStateFields(doc: Record<string, unknown>): string[] {
  const bad: string[] = [];
  if (typeof doc["watching"] !== "boolean") {
    bad.push(`watching is ${typeof doc["watching"]}, not a boolean`);
  }
  for (const field of ["startedAt", "lastReportAt"] as const) {
    const value = doc[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_TIME_MS) {
      bad.push(`${field} is not an epoch-ms number a date can be built from`);
    }
  }
  if (doc["windows"] !== undefined && !isPlainObject(doc["windows"])) {
    bad.push("windows is not an object of windowKey -> outcome");
  }
  if (doc["observed"] !== undefined && !isPlainObject(doc["observed"])) {
    bad.push("observed is not an object of sessionId -> cursor");
  }
  const fed = doc["fedRoutingKeys"];
  if (fed !== undefined) {
    if (!Array.isArray(fed)) bad.push("fedRoutingKeys is not an array");
    else if (fed.some((k) => typeof k !== "string")) {
      bad.push("fedRoutingKeys contains an entry that is not a string");
    }
  }
  return bad;
}

/**
 * The `fedRoutingKeys` entries, as STRINGS, with everything else counted.
 *
 * `WatchmeState.fedRoutingKeys` is typed `readonly string[]` and is whatever
 * was in the file. A number there used to reach `for (const key of …)` and
 * throw "number is not iterable"; a number INSIDE the array reached
 * `key.split("#")`. Both are now counted as unusable rather than crashing,
 * and the count is reported so a reader is never shown a smaller fed set than
 * the file claims without being told why.
 */
export function fedRoutingKeyStrings(value: unknown): {
  readonly keys: ReadonlyArray<string>;
  readonly unusable: number;
  readonly note?: string;
} {
  if (value === undefined || value === null) return { keys: [], unusable: 0 };
  if (!Array.isArray(value)) {
    return {
      keys: [],
      unusable: 0,
      note: "fedRoutingKeys in state.json is not an array, so NO fed turn could be read — this is not a harness that has fed nothing",
    };
  }
  const keys: string[] = [];
  let unusable = 0;
  for (const entry of value) {
    if (typeof entry === "string") keys.push(entry);
    else unusable += 1;
  }
  return { keys, unusable };
}

/** What one watchme read produced, with unreadable files separated out. */
export type WatchmeRead = {
  readonly dir: string;
  readonly observations: ReadonlyArray<WatchmeObservation>;
  readonly aggregates: ReadonlyArray<WatchmeAggregate>;
  readonly judgments: ReadonlyArray<WatchmeJudgment>;
  readonly state: WatchmeState;
  readonly stateProbe: StateProbe;
};

/**
 * Open the store and read everything, turning a filesystem error into a
 * `Loaded` failure rather than an empty ledger.
 *
 * The store's `readJsonl` guards with `existsSync` and then reads, so an
 * unreadable file throws out of the accessor. Letting that throw escape a
 * tool would be a crash; catching it and returning `[]` would be a lie. It
 * becomes an `unreadable` failure with the reason attached.
 */
export function readWatchme(stateRoot: string, specName?: string): Loaded<WatchmeRead> {
  const store = openWatchmeStore(stateRoot, specName === undefined ? {} : { specName });
  try {
    const observations = store.readObservations();
    const aggregates = store.readAggregates();
    const judgments = store.readJudgments();
    return {
      ok: true,
      value: {
        dir: store.dir,
        observations,
        aggregates,
        judgments,
        state: store.state(),
        stateProbe: probeState(store.dir),
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(
      "unreadable",
      `the watchme store at "${renderPath(store.dir)}" could not be read (${code ?? (err instanceof Error ? err.message : "unknown error")}) — this is not an empty ledger`,
    );
  }
}

/**
 * How many lines the ledger holds, and how many of them are not JSON.
 *
 * The store SKIPS a line it cannot parse, which is right for a background
 * loop and hides damage from a report: a file whose second half was
 * overwritten with garbage reads as a small healthy store. The skipped count
 * is a purely syntactic fact — no interpretation of the line's shape, which
 * stays the store's job — so counting it here is not a second reader.
 *
 * `undefined` when the file is absent or past `maxBytes`: a count is not
 * worth reading a gigabyte for, and reporting 0 unparseable lines for a file
 * nobody counted would be the same lie one level down.
 */
export type LineCount = {
  readonly lines: number;
  readonly unparseable: number;
  readonly note?: string;
};

export function countLines(abs: string, maxBytes: number): LineCount | undefined {
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    return undefined;
  }
  if (size > maxBytes) {
    return {
      lines: 0,
      unparseable: 0,
      note: `${size} bytes is past the ${maxBytes}-byte ceiling for counting lines, so neither number was computed — they are not zero`,
    };
  }
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { lines: 0, unparseable: 0, note: `could not be counted (${code ?? "unknown"})` };
  }
  let lines = 0;
  let unparseable = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    lines += 1;
    try {
      JSON.parse(line);
    } catch {
      unparseable += 1;
    }
  }
  return { lines, unparseable };
}

/** True when the store's directory exists at all. */
export function watchmeDirExists(stateRoot: string): boolean {
  const dir = join(stateRoot, WATCHME_RELDIR);
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The counted roll-up of a set of aggregate lines, per `<specName>|<target>`
 * key, with every proportion carrying its interval.
 *
 * The aggregate's own fields are used verbatim — `n`, `meanTurns`,
 * `meanQuality`, `qualityN` and the summed counters are the store's fold and
 * are not recomputed. What is added is the two rates a reader would otherwise
 * compute in their head from the raw counters and get wrong at small n.
 */
export type WatchmeKeyRollup = {
  readonly key: string;
  readonly sessions: number;
  /**
   * Turns per session and pooled quality per session, each WITH its interval.
   *
   * These are the two numbers an operator reads as "how is this harness
   * doing", and they used to leave here bare. A mean quality of 0.92 over one
   * session is not a better harness than 0.81 over four hundred, and a bare
   * number says it is — the same trap the arm means carry an interval for.
   * The store already holds the spread: an aggregate line carries the Welford
   * `m2Turns` / `m2Quality` beside the means, and dropping them on the way out
   * threw away the only thing that made the mean readable.
   */
  readonly turns: MeanView;
  readonly quality: MeanView;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly toolErrorRate: RateView;
  readonly feedbackUp: number;
  readonly feedbackDown: number;
  readonly feedbackUpRate: RateView;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsdMicros: number;
};

/**
 * Welford M2 → sample variance, the convention `@crewhaus/routing-store`'s
 * `toStats` uses for its own arms (`m2 / (n - 1)`, and 0 below two
 * observations). Written once here rather than at each call site so the two
 * halves of a roll-up cannot disagree about it, and matched to routing-store
 * so the same statistic does not mean two things in one result.
 */
function sampleVariance(m2: number, n: number): number {
  return n > 1 ? m2 / (n - 1) : 0;
}

/**
 * Mean, M2 and n over a list of samples, the two-pass form.
 *
 * Only used for the RAW half, where the per-observation values are in hand.
 * The aggregate half never recomputes anything: it reads the store's own
 * Welford fields straight off the line.
 */
function momentsOf(values: ReadonlyArray<number>): { mean: number; m2: number; n: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, m2: 0, n: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  let m2 = 0;
  for (const v of values) m2 += (v - mean) * (v - mean);
  return { mean, m2, n };
}

export function rollupAggregates(aggregates: ReadonlyArray<WatchmeAggregate>): WatchmeKeyRollup[] {
  return [...aggregates]
    .sort((a, b) => compareStrings(a.key, b.key))
    .map((agg) => ({
      key: agg.key,
      sessions: agg.n,
      turns: meanWithInterval(agg.meanTurns, sampleVariance(agg.m2Turns, agg.n), agg.n),
      // `meanQuality` is 0 when no session carried one; reporting that 0 as a
      // quality score would say "every session scored zero", which is the
      // opposite of "no session was scored". `meanWithInterval` at n=0 reports
      // `mean: null` with that reason, which is the same statement.
      quality: meanWithInterval(
        agg.meanQuality,
        sampleVariance(agg.m2Quality, agg.qualityN),
        agg.qualityN,
      ),
      toolCalls: agg.toolCalls,
      toolErrors: agg.toolErrors,
      toolErrorRate: rate(agg.toolErrors, agg.toolCalls),
      feedbackUp: agg.feedbackUp,
      feedbackDown: agg.feedbackDown,
      feedbackUpRate: rate(agg.feedbackUp, agg.feedbackUp + agg.feedbackDown),
      tokensIn: agg.tokensIn,
      tokensOut: agg.tokensOut,
      costUsdMicros: agg.costUsdMicros,
    }));
}

/**
 * The same roll-up shape, computed from RAW observation lines.
 *
 * `compact()` folds raw lines into aggregates, so a store holds some of each
 * and a report that read only one of them would show a fraction of the
 * harness. The counters summed here are the observation's own fields; the
 * session count is `observations.length`, which is already deduplicated by
 * sessionId by the store's `readObservations` (last digest wins), so a
 * re-analyzed session counts once.
 */
export function rollupObservations(
  observations: ReadonlyArray<WatchmeObservation>,
): WatchmeKeyRollup[] {
  type Acc = {
    /** Per-session values, kept so the roll-up can report a spread, not just a mean. */
    turns: number[];
    quality: number[];
    toolCalls: number;
    toolErrors: number;
    up: number;
    down: number;
    tokensIn: number;
    tokensOut: number;
    costUsdMicros: number;
  };
  const byKey = new Map<string, Acc>();
  for (const obs of observations) {
    const key = `${obs.specName}|${obs.target}`;
    const acc = byKey.get(key) ?? {
      turns: [],
      quality: [],
      toolCalls: 0,
      toolErrors: 0,
      up: 0,
      down: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsdMicros: 0,
    };
    acc.turns.push(obs.turnCount);
    // The count-weighted pooled quality, the same weighting `store.compact()`
    // applies — ratings and judgments pooled by how many of each there were,
    // so a session with one rating does not outweigh one with forty judged
    // turns.
    const q = obs.quality;
    if (q !== undefined) {
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
      if (weight > 0) acc.quality.push(sum / weight);
    }
    for (const m of obs.models) {
      acc.tokensIn += m.usage.in;
      acc.tokensOut += m.usage.out;
      acc.costUsdMicros += m.costUsdMicros ?? 0;
    }
    for (const t of obs.toolStats) {
      acc.toolCalls += t.calls;
      acc.toolErrors += t.errors;
    }
    acc.up += obs.feedback?.up ?? 0;
    acc.down += obs.feedback?.down ?? 0;
    byKey.set(key, acc);
  }
  return [...byKey.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([key, acc]) => {
      const turns = momentsOf(acc.turns);
      const quality = momentsOf(acc.quality);
      return {
        key,
        sessions: acc.turns.length,
        turns: meanWithInterval(turns.mean, sampleVariance(turns.m2, turns.n), turns.n),
        quality: meanWithInterval(quality.mean, sampleVariance(quality.m2, quality.n), quality.n),
        toolCalls: acc.toolCalls,
        toolErrors: acc.toolErrors,
        toolErrorRate: rate(acc.toolErrors, acc.toolCalls),
        feedbackUp: acc.up,
        feedbackDown: acc.down,
        feedbackUpRate: rate(acc.up, acc.up + acc.down),
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        costUsdMicros: acc.costUsdMicros,
      };
    });
}

/**
 * What the model-backed half of `crewhaus watchme` does that this tool does
 * not. Named so a reader does not take a complete-looking report for the
 * whole feature.
 */
export const WATCHME_MODEL_SURFACE_UNAVAILABLE =
  "this tool reads the ledger only. It never runs the phase-2 judge and never runs `watchme synthesize`, both of which take model calls; it also never feeds routing (`watchme report --feed-routing`), which WRITES observe-only arms. Use `crewhaus watchme report` for those.";
