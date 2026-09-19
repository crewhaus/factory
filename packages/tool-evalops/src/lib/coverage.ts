/**
 * The two distributions `eval coverage` intersects, loaded from disk.
 *
 * The intersection, the ranking, the bigram bookkeeping and the deterministic
 * input clustering all live in `@crewhaus/eval-ops`'s `eval-coverage` and are
 * called, not re-derived — including the clustering, which has to stay
 * bit-identical to `graders-suggest`'s or the backlog reorders itself between
 * runs and nobody can work through it.
 *
 * This module does the part that module deliberately has no opinion about:
 * getting the bytes off disk, under containment, with an account of what could
 * not be read. That account is the point. A coverage report built from zero
 * readable sessions would print "no coverage gaps" — the single most dangerous
 * sentence this tool can emit, because it is also what a perfectly covered
 * harness prints.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { CoverageSample } from "@crewhaus/eval-ops";
import {
  type Loaded,
  compareStrings,
  contain,
  containedDir,
  fail,
  joinRel,
  listJsonlByRecency,
  parseJsonlObjects,
  readContained,
  renderPath,
} from "./read";

/** One session, in the shape `buildProdBehavior` consumes. */
export type LoadedSession = {
  readonly sessionId: string;
  readonly events: ReadonlyArray<{ kind?: string; payload?: unknown }>;
};

export type SessionLoad = {
  readonly sessions: ReadonlyArray<LoadedSession>;
  /** Session files present in the directory, before the `sessions` cap. */
  readonly available: number;
  /** Files that could not be read or parsed, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
  /** Non-blank lines across every session that were not JSON objects. */
  readonly malformedLines: number;
  /** Files whose mtime could not be read, so their place in the
   *  most-recent-first ordering is a guess. */
  readonly unorderable: ReadonlyArray<string>;
  /** True when a per-file row cap cut a session short. */
  readonly truncated: boolean;
  /** True when the selection was cut short by a ceiling — the caller's own
   *  `sessions: N`, or this tool's file ceiling. */
  readonly fileCapApplied: boolean;
  /** How many files were actually opened at most, and WHICH ceiling produced
   *  that number. Reporting the tool ceiling when the caller's own smaller
   *  number is what applied states a cap that never ran. */
  readonly capApplied?: { readonly limit: number; readonly source: "requested" | "tool-ceiling" };
  /** Set when the directory could not be LISTED. Distinct from an empty
   *  directory, which yields zero names and no reason. */
  readonly listingFailed?: string;
};

/**
 * Load the most recent N session logs.
 *
 * A file that cannot be read is SKIPPED AND NAMED rather than dropped: the
 * session count is the denominator of every fraction in the report, and one
 * silently missing file moves every one of them.
 */
export function loadSessions(
  toolName: string,
  dirRel: string,
  want: number | "all",
  limits: {
    readonly maxFileBytes: number;
    readonly maxEventsPerFile: number;
    readonly maxFiles: number;
  },
): Loaded<SessionLoad> {
  const dir = containedDir(toolName, dirRel);
  if (!dir.ok) return dir;
  const listing = listJsonlByRecency(dir.value.real);
  // `"all"` is the caller's intent, not a licence to open a hundred thousand
  // files in one call. The ceiling is applied here and REPORTED, so a capped
  // read is never mistaken for the whole directory.
  const wanted = want === "all" ? limits.maxFiles : Math.min(want, limits.maxFiles);
  const capSource: "requested" | "tool-ceiling" =
    want !== "all" && want <= limits.maxFiles ? "requested" : "tool-ceiling";
  const chosen = listing.names.slice(0, wanted);
  const sessions: LoadedSession[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  let malformedLines = 0;
  let truncated = false;
  for (const name of chosen) {
    const rel = joinRel(dirRel, name);
    const read = readContained(toolName, rel, limits.maxFileBytes);
    if (!read.ok) {
      skipped.push({ file: name, reason: read.message });
      continue;
    }
    const parsed = parseJsonlObjects(read.value.text, limits.maxEventsPerFile);
    malformedLines += parsed.malformedLines.length + parsed.nonObjectLines.length;
    if (parsed.truncated) truncated = true;
    sessions.push({
      sessionId: name.replace(/\.jsonl$/, ""),
      events: parsed.rows as ReadonlyArray<{ kind?: string; payload?: unknown }>,
    });
  }
  return {
    ok: true,
    value: {
      sessions,
      available: listing.names.length,
      skipped: skipped.sort((a, b) => compareStrings(a.file, b.file)),
      malformedLines,
      unorderable: listing.unstatable,
      truncated,
      fileCapApplied: listing.names.length > wanted,
      ...(listing.names.length > wanted
        ? { capApplied: { limit: wanted, source: capSource } }
        : {}),
      ...(listing.listingFailed !== undefined ? { listingFailed: listing.listingFailed } : {}),
    },
  };
}

export type DatasetLoad = {
  readonly samples: ReadonlyArray<CoverageSample>;
  /** Rows that parsed but declared no usable `expected_tools`. Counted so a
   *  dataset that declares none is distinguishable from one that was not
   *  read — the first means "coverage is run-events only", the second means
   *  "this report is wrong". */
  readonly withoutExpectedTools: number;
  readonly malformedLines: ReadonlyArray<number>;
  readonly nonObjectLines: ReadonlyArray<number>;
  readonly truncated: boolean;
};

/** Load a dataset JSONL and project it onto what coverage needs. */
export function loadDataset(
  toolName: string,
  rel: string,
  limits: { readonly maxBytes: number; readonly maxRows: number },
): Loaded<DatasetLoad> {
  const read = readContained(toolName, rel, limits.maxBytes);
  if (!read.ok) return read;
  const parsed = parseJsonlObjects(read.value.text, limits.maxRows);
  const samples: CoverageSample[] = [];
  let withoutExpectedTools = 0;
  for (const row of parsed.rows) {
    const tools = row["expected_tools"];
    if (Array.isArray(tools)) {
      const names = tools.filter((t): t is string => typeof t === "string" && t !== "");
      if (names.length > 0) {
        samples.push({ expected_tools: names });
        continue;
      }
    }
    withoutExpectedTools += 1;
    samples.push({});
  }
  return {
    ok: true,
    value: {
      samples,
      withoutExpectedTools,
      malformedLines: parsed.malformedLines,
      nonObjectLines: parsed.nonObjectLines,
      truncated: parsed.truncated,
    },
  };
}

export type RunEventsLoad = {
  readonly runId: string;
  readonly texts: ReadonlyArray<string>;
  readonly sampleDirs: number;
  readonly unreadable: ReadonlyArray<string>;
  readonly truncated: boolean;
};

/**
 * Read the per-sample `events.jsonl` of one recorded run.
 *
 * `outDir` on an index row is ABSOLUTE and was written by whichever machine
 * ran the eval, so it is re-contained against this workspace before anything
 * is opened — a history copied between machines otherwise reaches wherever
 * that path now points.
 */
export function loadRunEvents(
  toolName: string,
  runId: string,
  outDir: string,
  limits: { readonly maxSampleDirs: number; readonly maxFileBytes: number },
): Loaded<RunEventsLoad> {
  const rel = path.isAbsolute(outDir) ? path.relative(process.cwd(), outDir) : outDir;
  if (rel === "" || rel.startsWith("..")) {
    return fail(
      "refused",
      `run ${runId} recorded its output at "${renderPath(outDir)}", which is outside this workspace — its events were not read`,
    );
  }
  const dir = contain(toolName, rel);
  if (!dir.ok) return dir;
  let names: string[];
  try {
    names = readdirSync(dir.value.real).sort(compareStrings);
  } catch {
    return fail("missing", `run ${runId}'s output directory could not be listed`);
  }
  const texts: string[] = [];
  const unreadable: string[] = [];
  let sampleDirs = 0;
  let truncated = false;
  for (const name of names) {
    if (sampleDirs >= limits.maxSampleDirs) {
      truncated = true;
      break;
    }
    const child = path.join(dir.value.real, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      unreadable.push(name);
      continue;
    }
    sampleDirs += 1;
    const eventsPath = path.join(child, "events.jsonl");
    if (!existsSync(eventsPath)) continue;
    const read = readContained(
      toolName,
      joinRel(joinRel(rel, name), "events.jsonl"),
      limits.maxFileBytes,
    );
    if (!read.ok) {
      unreadable.push(`${name}: ${read.message}`);
      continue;
    }
    texts.push(read.value.text);
  }
  return {
    ok: true,
    value: { runId, texts, sampleDirs, unreadable: unreadable.sort(compareStrings), truncated },
  };
}
