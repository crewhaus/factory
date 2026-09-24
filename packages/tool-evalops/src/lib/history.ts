import { lstatSync } from "node:fs";
import * as path from "node:path";
/**
 * The eval history, read through the reader that owns it.
 *
 * `@crewhaus/eval-report` parses `index.jsonl` and `baselines.json`, collapses
 * a resumed run's superseding rows, and derives a run's baseline lineage key.
 * None of that is re-derived here. What IS here is the accounting the shared
 * reader deliberately does not do:
 *
 *   - `readRunIndex` skips a torn line rather than throwing, which is right
 *     for an append-only log and wrong for a report — a caller told "7 runs"
 *     has no way to learn that an eighth line was unreadable. So the file's
 *     non-blank lines are counted here and the difference is REPORTED.
 *   - `RunIndexEntry` is a TYPE, not a validator: `JSON.parse` casts every
 *     object to it. A row missing `runId`, or carrying a string where a rate
 *     belongs, would flow into a fold and come out as a point on a chart. Rows
 *     are checked against the type's own requirements here, and the ones that
 *     fail are counted and named rather than dropped.
 *
 * Both are the same rule: an empty answer and an unreadable one are different
 * answers, and only the return type can keep them apart.
 */
import {
  BASELINES_FILENAME,
  type BaselineEntry,
  type BaselineLineage,
  type BaselinesFile,
  INDEX_FILENAME,
  type RunIndexEntry,
  baselineKeyFor,
  latestRunIndexEntries,
  lineageOfEntry,
  parseRunIndex,
} from "@crewhaus/eval-report";
import { type SafePath, workspaceRoot } from "../paths";
import {
  type Loaded,
  containedDir,
  countNonBlankLines,
  fail,
  joinRel,
  readLeaf,
  renderPath,
} from "./read";

/**
 * The most bytes of `baselines.json` read. A pin is a few hundred bytes; a
 * file this size is not a pin file, and refusing it is not "none pinned".
 */
const MAX_BASELINES_BYTES = 16 * 1024 * 1024;

/** One row the index carried that this package refuses to fold. */
export type UnusableRow = {
  /** Position in the parsed (post-collapse) list — the log's own order. */
  readonly at: number;
  readonly reason: string;
  /** The row's `runId`, when it had a usable one. */
  readonly runId?: string;
};

export type IndexRead = {
  readonly dir: SafePath;
  /** False when `index.jsonl` does not exist — no runs have ever been
   *  recorded here, which is NOT the same as a directory that could not be
   *  read (that comes back as a refusal, not as this flag). */
  readonly present: boolean;
  readonly bytes: number;
  /** Non-blank lines in the file. */
  readonly lines: number;
  /** Lines `@crewhaus/eval-report` turned into rows. */
  readonly parsedRows: number;
  /** Non-blank lines the shared reader could not turn into a row: they did
   *  not parse, or they parsed as something that cannot be a run (`null`,
   *  `42`, `[]`). It skips both by design; a report that does not say so is
   *  claiming a completeness it cannot support. */
  readonly unparsedLines: number;
  /** Rows dropped by the supersede collapse — a resumed run's earlier,
   *  truncated figures. */
  readonly supersededRows: number;
  /** Set when the supersede collapse could not run at all (see `readIndex`).
   *  The rows are still returned; what is absent is the guarantee of one row
   *  per run, and saying that is the difference between a degraded answer and
   *  a wrong one. */
  readonly collapseFailed?: string;
  /** Usable rows, newest-wins, in the log's order. */
  readonly entries: ReadonlyArray<RunIndexEntry>;
  readonly unusable: ReadonlyArray<UnusableRow>;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Why this row cannot be folded, or `undefined` when it can.
 *
 * Deliberately minimal: only the fields every consumer of a row reads — its
 * identity, its lineage and its two rates. Optional columns are left to the
 * readers that want them, so a row written by an older CLI stays usable.
 */
export function rowProblem(parsed: unknown): string | undefined {
  // The argument is `unknown` on purpose. `readRunIndex` casts every parsed
  // line to `RunIndexEntry`, so a line holding `null`, `42` or `[]` arrives
  // typed as a row; reading `.runId` off the first of those throws. The type
  // is a claim about the file, not a check of it.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  const row = parsed as RunIndexEntry;
  if (!isNonEmptyString(row.runId)) return "no runId";
  if (!isNonEmptyString(row.specName)) return "no specName";
  if (!isNonEmptyString(row.datasetName)) return "no datasetName";
  if (!isNonEmptyString(row.ts)) return "no ts";
  if (!isFiniteNumber(row.passRate)) return "passRate is not a finite number";
  if (!isFiniteNumber(row.meanScore)) return "meanScore is not a finite number";
  if (!Number.isInteger(row.sampleCount) || row.sampleCount < 0) {
    return "sampleCount is not a whole count";
  }
  // A rate outside 0..1 is not a rate. Passing one through would put a point
  // above the top of any chart drawn from this fold and, worse, would make a
  // delta against it meaningless.
  if (row.passRate < 0 || row.passRate > 1) return `passRate ${row.passRate} is outside 0..1`;
  return undefined;
}

/**
 * Read the run index for an evals directory, with the accounting above.
 *
 * `index.jsonl` is read with its LEAF contained (security-7#12): a link at
 * that name leading out of the workspace is refused, not stat'ed, counted and
 * reported. The bytes read here are the bytes parsed — they go to
 * `@crewhaus/eval-report`'s text parser, not back to it as a path to open a
 * second time.
 */
export function readIndex(toolName: string, dirRel: string, maxBytes: number): Loaded<IndexRead> {
  const dir = containedDir(toolName, dirRel);
  if (!dir.ok) return dir;
  const read = readLeaf(
    joinRel(dir.value.rel, INDEX_FILENAME),
    `${dirRel}/${INDEX_FILENAME}`,
    maxBytes,
  );
  if (!read.ok) {
    if (read.code !== "missing") return read;
    return {
      ok: true,
      value: {
        dir: dir.value,
        present: false,
        bytes: 0,
        lines: 0,
        parsedRows: 0,
        unparsedLines: 0,
        supersededRows: 0,
        entries: [],
        unusable: [],
      },
    };
  }
  // The cap was applied by the read itself, and the file's own line count is
  // the only denominator against which the shared parser's silent skipping
  // becomes visible.
  const { text, bytes } = read.value;
  const lines = countNonBlankLines(text);

  const allRows = parseRunIndex(text);
  // BELT AND BRACES. `readRunIndexLatest` reads `.runId` off every row it is
  // given, and `readRunIndex` used to hand it a line holding `null` — which
  // parses fine — so the collapse threw a TypeError and took this whole read
  // down with it. The shared reader now skips a line that parses but is not a
  // JSON object, so nothing in a file should reach that throw any more; this
  // catch stays because the alternative to a named degradation is a crash,
  // and that trade does not depend on which shapes the reader skips today.
  // If it ever fires: the raw rows are used and the DEGRADATION is named —
  // without the collapse, a resumed run's superseded row is still in the
  // list, and the fold will report the duplicate runId.
  let latest: RunIndexEntry[];
  let collapseFailed: string | undefined;
  try {
    latest = latestRunIndexEntries(allRows);
  } catch (err) {
    latest = allRows;
    collapseFailed = `the supersede collapse in @crewhaus/eval-report threw (${(err as Error).message}) — a line in this index parses as JSON but is not an object. Rows are reported WITHOUT the collapse, so a resumed run may appear more than once.`;
  }
  const unusable: UnusableRow[] = [];
  const entries: RunIndexEntry[] = [];
  latest.forEach((row, at) => {
    const problem = rowProblem(row);
    if (problem === undefined) {
      entries.push(row);
      return;
    }
    unusable.push({
      at,
      reason: problem,
      ...(isNonEmptyString((row as RunIndexEntry | undefined)?.runId) ? { runId: row.runId } : {}),
    });
  });
  return {
    ok: true,
    value: {
      dir: dir.value,
      present: true,
      bytes,
      lines,
      parsedRows: allRows.length,
      unparsedLines: Math.max(0, lines - allRows.length),
      supersededRows: allRows.length - latest.length,
      entries,
      unusable,
      ...(collapseFailed !== undefined ? { collapseFailed } : {}),
    },
  };
}

export type BaselinesRead = {
  readonly present: boolean;
  readonly file: BaselinesFile;
  /**
   * `baselines.json` is a symbolic link that stays inside the workspace. It
   * is READ through the link; a pin is never WRITTEN through one (see
   * `commitPin`), so `set` and `clear` refuse it.
   */
  readonly linked: boolean;
};

/**
 * True when a parsed `baselines.json` is the MAP its type claims.
 *
 * `readBaselines` is `JSON.parse` plus a cast, so `null`, `[]`, `"x"` and `3`
 * all come back as a `BaselinesFile` without throwing. Each one then breaks a
 * different consumer silently: `Object.values(null)` throws inside a read-only
 * listing, and `setBaseline` on an ARRAY assigns a string key that
 * `JSON.stringify` drops — so a pin reports `committed: true` and the file on
 * disk is still `[]`, leaving a gate with nothing to fail against while the
 * caller was told the baseline was written. Checked here, once, at the seam
 * where the bytes become a value.
 */
function isBaselinesMap(parsed: unknown): parsed is BaselinesFile {
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
}

/**
 * Read `baselines.json`, distinguishing "no pins yet" from "unreadable".
 *
 * The LEAF is contained (security-7#0): a link at that name leading out of the
 * workspace is refused before anything is read — dangling or not, since a
 * dangling link is exactly the one a write would follow to CREATE its target.
 * A parse failure is reported without the parser's message, which quotes the
 * file's first token.
 */
export function readPins(dir: SafePath, dirRel: string): Loaded<BaselinesRead> {
  const shown = `${renderPath(dirRel)}/${BASELINES_FILENAME}`;
  const leafRel = joinRel(dir.rel, BASELINES_FILENAME);
  const read = readLeaf(leafRel, `${dirRel}/${BASELINES_FILENAME}`, MAX_BASELINES_BYTES);
  if (!read.ok) {
    if (read.code === "missing" && !nameExists(path.join(workspaceRoot(), leafRel))) {
      return { ok: true, value: { present: false, file: {}, linked: false } };
    }
    if (read.code === "missing") {
      // The NAME is there but leads nowhere: a dangling link inside the
      // workspace. Not "no pins yet" — a write would follow it.
      return fail(
        "refused",
        `"${shown}" is a symbolic link to nothing — the pins cannot be read, and a pin is never written through a link`,
      );
    }
    return read;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.text);
  } catch {
    // A malformed pin file is NOT "no baseline is pinned": every gate that
    // reads it is currently broken, and saying "none" here would hide that.
    return fail(
      "malformed",
      `"${shown}" could not be parsed (it is not valid JSON) — the pins cannot be read, which is not the same as none being pinned`,
    );
  }
  if (!isBaselinesMap(parsed)) {
    return fail(
      "malformed",
      `"${shown}" parses as JSON but is ${
        parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`
      }, not a map of lineage key to pinned run — the pins cannot be read, which is not the same as none being pinned, and writing over it would be a guess about what it was meant to hold`,
    );
  }
  return {
    ok: true,
    value: {
      present: true,
      file: parsed,
      linked: isSymlink(path.join(workspaceRoot(), leafRel)),
    },
  };
}

/** True when the NAME exists, whether or not it leads anywhere (`lstat`). */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every pinned run id in the file — the `pinnedRunIds` a trend fold marks. */
export function pinnedRunIds(file: BaselinesFile): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(file)) {
    if (entry !== null && typeof entry === "object" && isNonEmptyString(entry.runId)) {
      ids.add(entry.runId);
    }
  }
  return ids;
}

/**
 * The NEWEST row in a list, by the run's own timestamp.
 *
 * Not `rows[rows.length - 1]`. The index is an append-only log and usually
 * chronological, but it is not ordered BY ts: `--resume` appends a superseding
 * row for an older run, an index copied between machines interleaves two
 * clocks, and a hand-edited file can hold anything. Taking the last LINE and
 * calling it "the most recent run" reports the wrong run's tool calls under a
 * label that says otherwise.
 *
 * The ordering rule is `@crewhaus/eval-report`'s own (`stableSortByTs` in
 * trends.ts and the `tsOf` in `readRunIndexLatest`): `Date.parse`, an
 * unparseable stamp sorting oldest, later file position winning ties. It is
 * mirrored rather than imported because eval-report exports neither the
 * comparator nor a "newest entry" helper — and mirrored ONLY here, so there is
 * one copy to reconcile if that rule ever changes.
 *
 * `tsUnparseable` is returned rather than hidden: a chosen row whose stamp
 * could not be parsed was chosen by file position, not by time, and a caller
 * that says "most recent" must be able to say so with a caveat.
 */
export function newestByTs(rows: ReadonlyArray<RunIndexEntry>): {
  readonly row?: RunIndexEntry;
  readonly tsUnparseable: boolean;
} {
  const at = (e: RunIndexEntry): number => {
    const t = Date.parse(e.ts);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  let best: RunIndexEntry | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  rows.forEach((row, i) => {
    const ts = at(row);
    if (i === 0 || ts >= bestAt) {
      best = row;
      bestAt = ts;
    }
  });
  if (best === undefined) return { tsUnparseable: false };
  return { row: best, tsUnparseable: bestAt === Number.NEGATIVE_INFINITY };
}

/** The lineage key a row belongs to, derived by `@crewhaus/eval-report`. */
export function keyOf(entry: RunIndexEntry): string {
  return baselineKeyFor(lineageOfEntry(entry));
}

/** The lineage key for an explicit (spec, dataset, arm) selection. */
export function keyOfLineage(lineage: BaselineLineage): string {
  return baselineKeyFor(lineage);
}

export type { BaselineEntry, BaselineLineage, BaselinesFile, RunIndexEntry };
