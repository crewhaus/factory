/**
 * The baseline pin: show it, move it, clear it.
 *
 * Everything about WHERE a pin lives is `@crewhaus/eval-report`'s:
 * `baselineKeyFor` spells the key, `lineageOfEntry` derives a run's lineage,
 * `resolveBaseline` is the one reader every consumer shares, and `setBaseline`
 * is the writer. None of that is re-spelled here, because a second spelling of
 * the key is a pin the gate will not find.
 *
 * What is here is the decision procedure around it, and one rule of it matters
 * more than the rest: THE LINEAGE COMES FROM THE RUN, NOT FROM THE REQUEST.
 * Baselines key on (spec, dataset) and, since 0.6.0, on the arm — so a write
 * keyed off caller-supplied strings can drop one arm's run onto another arm's
 * key and silently clobber a sibling's pin. The requested lineage is therefore
 * checked against the run's own and a mismatch is refused, not reconciled.
 *
 * The second rule is the one `crewhaus eval` already enforces on every pin
 * path: a budget-aborted PARTIAL run is never pinned. Its unexecuted samples
 * were recorded as failures, so a baseline seeded from it makes every later
 * regression read as a recovery. The rule lives inside `finishEvalRun`'s
 * private pin helper rather than in an exported predicate, so it is restated
 * here — deliberately, and named as a mirror rather than an invention.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  BASELINES_FILENAME,
  type BaselineEntry,
  type BaselineLineage,
  type BaselineLookup,
  type BaselinesFile,
  type RunIndexEntry,
  baselineKey,
  baselineKeyFor,
  lineageOfEntry,
  setBaseline,
} from "@crewhaus/eval-report";
import type { SafePath } from "../paths";
import { type Loaded, compareStrings, fail, renderPath } from "./read";
import { RESULTS_FILENAME } from "./run";

export type PinAction = "show" | "set" | "clear";

export type PinPlan = {
  readonly action: PinAction;
  readonly key: string;
  readonly lineage: BaselineLineage;
  readonly label: string;
  /** 0.6.0 §6.1 — this arm's own key is absent but the legacy (spec, dataset)
   *  key IS pinned. The legacy pin measures a different instrument, so it is
   *  not this lineage's baseline and must never be reported as one. */
  readonly legacyPresent: boolean;
  readonly previous?: BaselineEntry;
  /** What `set` would write. Present on a `set` plan that passed every check. */
  readonly next?: BaselineEntry;
  /** The other lineages pinned in this file — the siblings a naive write
   *  would have clobbered. Listed so a caller can see them stay put. */
  readonly siblingKeys: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** True when committing this plan changes the file. */
  readonly changes: boolean;
};

/** Build the pin a run would get, from the run's OWN recorded columns. */
export function pinFor(row: RunIndexEntry): BaselineEntry {
  return {
    specName: row.specName,
    datasetName: row.datasetName,
    runId: row.runId,
    ...(row.specSource !== undefined ? { specSource: row.specSource } : {}),
    outDir: row.outDir,
    datasetHash: row.datasetHash,
    ...(row.gradersHash !== undefined ? { gradersHash: row.gradersHash } : {}),
    ...(row.judgeModel !== undefined ? { judgeModel: row.judgeModel } : {}),
    ...(row.p95LatencyMs !== undefined ? { p95LatencyMs: row.p95LatencyMs } : {}),
    ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    ...(row.armId !== undefined ? { armId: row.armId } : {}),
    ...(row.routing !== undefined ? { routing: row.routing } : {}),
    ...(row.policyVersion !== undefined ? { policyVersion: row.policyVersion } : {}),
    ...(row.armsDigest !== undefined ? { armsDigest: row.armsDigest } : {}),
    // The run's OWN timestamp, not the clock. `finishEvalRun` pins the same
    // field the same way, and a result that moves because it was computed
    // twice is not a result.
    ts: row.ts,
  };
}

/** The instrument fields a re-pin would change, for the warning. */
function instrumentMoves(previous: BaselineEntry, next: BaselineEntry): string[] {
  const moves: string[] = [];
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ["datasetHash", previous.datasetHash, next.datasetHash],
    ["gradersHash", previous.gradersHash, next.gradersHash],
    ["judgeModel", previous.judgeModel, next.judgeModel],
    ["armsDigest", previous.armsDigest, next.armsDigest],
    ["policyVersion", previous.policyVersion, next.policyVersion],
  ];
  for (const [field, a, b] of pairs) {
    if (a !== undefined && b !== undefined && a !== b) moves.push(`${field} ${a} -> ${b}`);
  }
  return moves;
}

export type PlanInput = {
  readonly action: PinAction;
  readonly lineage: BaselineLineage;
  /** What `resolveBaseline` found — the key, the pin and the legacy-key flag
   *  all come from the one reader every other consumer of this file shares. */
  readonly lookup: BaselineLookup;
  readonly baselines: BaselinesFile;
  /** The index row for `runId`, when `set` named one. */
  readonly row?: RunIndexEntry;
  /** The evals directory, already contained — used to verify a run directory. */
  readonly evalsDir: SafePath;
};

/**
 * Decide what a pin call would do, without doing it.
 *
 * `dryRun` and the real call both run THIS function and then differ only in
 * whether {@link commitPin} is called with its result. There is no second,
 * parallel preview path — a preview that computes its own answer eventually
 * predicts something the real call never does.
 */
export function planPin(input: PlanInput): Loaded<PinPlan> {
  const key = input.lookup.key;
  const previous = input.lookup.entry;
  const siblingKeys = Object.keys(input.baselines)
    .filter((k) => k !== key)
    .sort(compareStrings);
  const legacyKey = baselineKey(input.lineage.specName, input.lineage.datasetName);
  const legacyPresent = input.lookup.legacyPresent;
  const label =
    input.lineage.armId !== undefined
      ? `${input.lineage.specName}/${input.lineage.datasetName}#${input.lineage.armId}`
      : input.lineage.routing !== undefined && input.lineage.routing !== "static"
        ? `${input.lineage.specName}/${input.lineage.datasetName}#routed`
        : `${input.lineage.specName}/${input.lineage.datasetName}`;
  const warnings: string[] = [];
  if (previous === undefined && input.action !== "set") {
    warnings.push(
      `no baseline is pinned for ${label} — a regression gate against this lineage has nothing to compare and passes vacuously`,
    );
  }
  if (legacyPresent) {
    warnings.push(
      `this per-arm lineage has no pin of its own, but the legacy ${legacyKey} key is pinned — that baseline measures a different instrument and is NOT this lineage's baseline`,
    );
  }

  const base = {
    action: input.action,
    key,
    lineage: input.lineage,
    label,
    legacyPresent,
    siblingKeys,
  };
  if (input.action === "show") {
    return {
      ok: true,
      value: {
        ...base,
        ...(previous !== undefined ? { previous } : {}),
        warnings,
        changes: false,
      },
    };
  }
  if (input.action === "clear") {
    return {
      ok: true,
      value: {
        ...base,
        ...(previous !== undefined ? { previous } : {}),
        warnings:
          previous === undefined
            ? [
                ...warnings,
                "nothing to clear — the file is unchanged, which is not the same as a pin having been removed",
              ]
            : [
                ...warnings,
                `clearing this pin leaves ${label} with no baseline: the next gate against it will pass because there is nothing to fail against`,
              ],
        changes: previous !== undefined,
      },
    };
  }

  const row = input.row;
  if (row === undefined) {
    return fail(
      "bad-input",
      "set needs a runId that appears in the run index — the pin's outDir and instrument hashes are copied from that row, and inventing them would pin a run nobody can verify",
    );
  }
  // THE lineage check. The run's own recorded lineage decides which key it may
  // be pinned under; the caller's spec/dataset/arm strings only select which
  // lineage is being operated on.
  const rowKey = baselineKeyFor(lineageOfEntry(row));
  if (rowKey !== key) {
    return fail(
      "bad-input",
      `run ${row.runId} belongs to lineage ${rowKey}, not ${key} — pinning it here would overwrite a different lineage's baseline with a run that did not measure it`,
    );
  }
  // NEW-HUNT-3, mirrored from `finishEvalRun`'s pin path: a budget-aborted run
  // recorded its unexecuted samples as synthetic failures.
  if (row.partial === true) {
    return fail(
      "bad-input",
      `run ${row.runId} is a partial (budget-aborted) run — its unexecuted samples were recorded as failures, so a baseline seeded from it would make every later regression read as a recovery. crewhaus eval refuses to pin one on every path; so does this.`,
    );
  }
  const verified = verifyRunDir(row);
  if (!verified.ok) return verified;
  const next = pinFor(row);
  if (row.replayed === true) {
    warnings.push(
      `run ${row.runId} replayed every tool result from a cassette — pinning it gates later LIVE runs against frozen tool output`,
    );
  }
  if (previous !== undefined) {
    const moves = instrumentMoves(previous, next);
    if (moves.length > 0) {
      warnings.push(
        `this re-pin moves the measuring instrument (${moves.join("; ")}) — it re-baselines the lineage, so scores before and after are not comparable`,
      );
    }
    if (previous.runId === row.runId) {
      warnings.push(`${row.runId} is already the pinned baseline for ${label}`);
    }
  }
  return {
    ok: true,
    value: {
      ...base,
      ...(previous !== undefined ? { previous } : {}),
      next,
      warnings,
      changes: previous === undefined || previous.runId !== row.runId,
    },
  };
}

/**
 * Check that the run being pinned is on this machine and readable.
 *
 * A pin is a pointer; a pointer to a run directory nobody can open produces a
 * gate that fails to LOAD its baseline, which `finishEvalRun` treats as a
 * reason to start a whole new lineage. Better to refuse the pin than to write
 * one that silently re-baselines the next run.
 */
function verifyRunDir(row: RunIndexEntry): Loaded<true> {
  const outDir = row.outDir;
  if (typeof outDir !== "string" || outDir === "") {
    return fail(
      "bad-input",
      `run ${row.runId} has no outDir recorded — there is nothing to pin to`,
    );
  }
  const rel = path.isAbsolute(outDir) ? path.relative(process.cwd(), outDir) : outDir;
  if (rel === "" || rel.startsWith("..")) {
    return fail(
      "refused",
      `run ${row.runId} recorded its output at "${renderPath(outDir)}", outside this workspace — its results.json cannot be verified from here, and a pin to an unverifiable run is a gate that silently re-baselines`,
    );
  }
  const results = path.join(path.resolve(process.cwd(), rel), RESULTS_FILENAME);
  try {
    if (!statSync(results).isFile()) {
      return fail("missing", `run ${row.runId}'s ${RESULTS_FILENAME} is not a file`);
    }
  } catch {
    return fail(
      "missing",
      `run ${row.runId}'s ${RESULTS_FILENAME} could not be read at "${renderPath(rel)}" — the run directory it points at is gone`,
    );
  }
  return { ok: true, value: true };
}

/**
 * Write the planned change.
 *
 * `set` goes through `setBaseline`, which owns the key and the file format.
 * `clear` cannot: `@crewhaus/eval-report` has no `deleteBaseline`, so the file
 * is rewritten here in exactly the shape `setBaseline` writes it — two spaces,
 * trailing newline, whole-file replacement. That is a second writer, and it is
 * named as such: the right fix is an upstream `deleteBaseline`.
 */
export function commitPin(plan: PinPlan, baselines: BaselinesFile, evalsDirReal: string): void {
  if (plan.action === "set" && plan.next !== undefined) {
    setBaseline(plan.next, evalsDirReal);
    return;
  }
  if (plan.action === "clear") {
    if (plan.previous === undefined) return;
    const next: BaselinesFile = { ...baselines };
    delete next[plan.key];
    mkdirSync(evalsDirReal, { recursive: true });
    writeFileSync(
      path.join(evalsDirReal, BASELINES_FILENAME),
      `${JSON.stringify(next, null, 2)}\n`,
    );
  }
}

/** True when a baselines file exists on disk for this directory. */
export function pinsFileExists(evalsDirReal: string): boolean {
  return existsSync(path.join(evalsDirReal, BASELINES_FILENAME));
}
