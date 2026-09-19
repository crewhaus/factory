/**
 * What the self-improvement loop has left on disk, and — more importantly —
 * what cannot be read from disk at all.
 *
 * THE PRECEDENCE RULE IS NOT REPRODUCED HERE. `crewhaus flywheel run` picks
 * its dataset by three rungs: the `--dataset` flag, then the conventional
 * `eval/dataset.jsonl` beside the spec, then `registry:<spec>-ratings`. That
 * rule lives in `apps/cli`'s `resolveFlywheelData`, and the shadow warning
 * that fires when the conventional file hides distilled user ratings lives
 * beside it in `formatRatingsShadowWarning`. A second copy here would be the
 * `tool-dataset` failure exactly: same rule, different implementation, and
 * the day they disagree the tool is reporting a decision the product did not
 * make.
 *
 * AND THE TOP RUNG IS NOT OBSERVABLE. `--dataset` is an argument, not a file.
 * No tool reading a directory can know whether the last run passed it, so no
 * tool reading a directory can name "the source the last run used" — it can
 * only say which rungs are AVAILABLE and which one would win if the flag were
 * omitted. Anything stronger than that is a guess presented as a fact, which
 * is the precise failure the survey sketch asked this tool to avoid, one
 * level further up than the sketch looked.
 *
 * So this module reports presence, artifacts and the conditional shadowing,
 * names `apps/cli`'s functions as the owner of the decision, and reports the
 * two facts it genuinely cannot obtain as unknown rather than as absent.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Loaded, compareStrings, fail, renderPath } from "./result";

/** The flywheel's own directory under the harness state dir. */
export const FLYWHEEL_RELDIR = "flywheel";

/**
 * Workflow files `crewhaus flywheel init` / `init --ci` / `init --sentinel`
 * write, by the constants in `apps/cli` (`FLYWHEEL_WORKFLOW_RELPATH`,
 * `MODEL_PLAN_WORKFLOW_RELPATH`, `EVAL_CI_WORKFLOW_RELPATH`,
 * `SENTINEL_WORKFLOW_RELPATH`, `DREAM_WORKFLOW_RELPATH`).
 *
 * The list is a LABELLING aid, not the test. The directory is enumerated and
 * every file in it is reported; a name on this list gets its scaffolder
 * named, and a name that is not gets listed anyway. A checker that only
 * looked for known names would report a renamed or hand-written workflow as
 * "no scaffolding", and `.github/workflows` is exactly the directory people
 * rename things in.
 */
export const KNOWN_WORKFLOWS: Readonly<Record<string, string>> = {
  "crewhaus-flywheel.yml": "crewhaus flywheel init",
  "crewhaus-model-plan.yml": "crewhaus flywheel init --model-plan",
  "crewhaus-eval.yml": "crewhaus init --ci",
  "sentinel-drift.yml": "crewhaus init --sentinel",
  "crewhaus-dream.yml": "crewhaus dream init",
};

export const WORKFLOWS_RELDIR = ".github/workflows";

/** The conventional data files, as `apps/cli` names them, resolved beside the SPEC. */
export const CONVENTIONAL_DATASET = "eval/dataset.jsonl";
export const CONVENTIONAL_GRADERS = "eval/graders.yaml";

/** Directory entries, distinguishing absent from unlistable. */
export function listDir(abs: string): Loaded<string[]> {
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is "there is nothing here". ENOTDIR, EACCES, ELOOP are "this
    // could not be listed", which is a different answer: a flywheel report
    // that calls an unreadable `.github/workflows` an unscaffolded one has
    // told an operator to run `flywheel init` over files it could not see.
    return code === "ENOENT"
      ? { ok: true, value: [] }
      : fail(
          "unreadable",
          `"${renderPath(abs)}" could not be listed (${code ?? "unknown error"}) — this is not an empty directory`,
        );
  }
  // Sorted with plain string comparison and never relied on as readdir order:
  // readdir order is filesystem-dependent and nothing here may depend on it.
  return { ok: true, value: entries.sort(compareStrings) };
}

/** Does a NAME exist, and is it a directory? Three answers, not two. */
export type DirProbe =
  | { readonly state: "absent" }
  | { readonly state: "directory" }
  | { readonly state: "not-a-directory" }
  | { readonly state: "unreadable"; readonly detail: string };

export function probeDir(abs: string): DirProbe {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable", detail: `could not be read (${code ?? "unknown error"})` };
  }
  return stat.isDirectory() ? { state: "directory" } : { state: "not-a-directory" };
}

/** Does a FILE exist? Same three answers. */
export type FileProbe =
  | { readonly state: "absent" }
  | { readonly state: "file"; readonly bytes: number; readonly mtimeMs: number }
  | { readonly state: "not-a-file" }
  | { readonly state: "unreadable"; readonly detail: string };

export function probeFile(abs: string): FileProbe {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { state: "absent" }
      : { state: "unreadable", detail: `could not be read (${code ?? "unknown error"})` };
  }
  return stat.isFile()
    ? { state: "file", bytes: stat.size, mtimeMs: stat.mtimeMs }
    : { state: "not-a-file" };
}

/** One `.crewhaus/flywheel/<runId>` directory and which stages it holds. */
export type FlywheelRun = {
  readonly runId: string;
  /** Which of the loop's output directories are present. */
  readonly stages: ReadonlyArray<string>;
  readonly mtimeMs: number;
};

export type RunListing = {
  readonly runs: ReadonlyArray<FlywheelRun>;
  /**
   * Entries the containment check refused. A run directory that is a symlink
   * out of the workspace is NOT silently dropped: dropping it would report a
   * harness with fewer runs than it has, and "I would not look at this" is a
   * different answer from "this is not here".
   */
  readonly uncontained: ReadonlyArray<string>;
};

/** The output directories `crewhaus flywheel run` writes under its run id. */
const RUN_STAGES = ["before", "after", "optimize", "diff"] as const;

/**
 * Enumerate the run directories. `crewhaus flywheel run` mints
 * `fly_<hex-epoch-ms>` and writes `before/`, `after/`, `optimize/` and
 * `diff/` under it; the run id is NOT parsed back into a timestamp here (a
 * directory someone else created would then get an invented date) — the
 * directory's own mtime is reported instead, and runs are ordered by name.
 *
 * `contained` is asked about every name the READDIR handed back, and about
 * every stage path under it, before any of them is stat'd. The caller
 * contained `flywheel/`; that says nothing about the names inside it, and a
 * name a directory listing produced is exactly as untrusted as one a caller
 * typed.
 */
export function listRuns(
  flywheelDir: string,
  contained: (relFromState: string) => boolean,
): Loaded<RunListing> {
  const entries = listDir(flywheelDir);
  if (!entries.ok) return entries;
  const runs: FlywheelRun[] = [];
  const uncontained: string[] = [];
  for (const name of entries.value) {
    const rel = `${FLYWHEEL_RELDIR}/${name}`;
    if (!contained(rel)) {
      uncontained.push(name);
      continue;
    }
    const abs = join(flywheelDir, name);
    const probe = probeDir(abs);
    if (probe.state !== "directory") continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      // Raced away between the listing and the stat; it still existed at
      // listing time, so it is reported with an unknown mtime rather than
      // dropped.
    }
    runs.push({
      runId: name,
      stages: RUN_STAGES.filter(
        (stage) => contained(`${rel}/${stage}`) && probeDir(join(abs, stage)).state === "directory",
      ),
      mtimeMs,
    });
  }
  // Ordered by name, never by readdir order.
  return {
    ok: true,
    value: {
      runs: runs.sort((a, b) => compareStrings(a.runId, b.runId)),
      uncontained: uncontained.sort(compareStrings),
    },
  };
}

/**
 * Which dataset rungs are available on disk, and which would win if
 * `flywheel run` were invoked with no `--dataset`.
 *
 * `flagPassed` is deliberately absent from the result: it is unknowable here.
 * `ratingsRegistered` is deliberately `"unknown"`: answering it means
 * resolving `registry:<spec>-ratings` through `@crewhaus/dataset-registry`,
 * which this package does not depend on, and guessing it from a directory
 * layout would be a second registry reader.
 */
export type DatasetPrecedence = {
  /** `eval/dataset.jsonl` beside the spec. */
  readonly conventionalDataset: FileProbe;
  /** `eval/graders.yaml` beside the spec. */
  readonly conventionalGraders: FileProbe;
  readonly ratingsRegistered: "unknown";
  readonly ratingsRef: string;
  /** Which rung wins when no `--dataset` is passed, as far as disk can say. */
  readonly withoutDatasetFlag: "convention" | "ratings-registry-or-refusal";
  /** True when the convention file would hide the ratings dataset, IF one is registered. */
  readonly wouldShadowRatings: boolean;
  readonly ruleOwner: string;
  readonly note: string;
};

export function datasetPrecedence(specDirAbs: string, specName: string): DatasetPrecedence {
  const conventionalDataset = probeFile(join(specDirAbs, "eval", "dataset.jsonl"));
  const conventionalGraders = probeFile(join(specDirAbs, "eval", "graders.yaml"));
  const hasConvention = conventionalDataset.state === "file";
  const ratingsRef = `registry:${specName}-ratings`;
  return {
    conventionalDataset,
    conventionalGraders,
    ratingsRegistered: "unknown",
    ratingsRef,
    withoutDatasetFlag: hasConvention ? "convention" : "ratings-registry-or-refusal",
    // Conditional on purpose: the shadowing is real only when ratings HAVE
    // been distilled, and that is the fact this build cannot obtain. Saying
    // "shadowing: true" unconditionally would make every day-one harness look
    // broken; saying "false" would hide the case the warning exists for.
    wouldShadowRatings: hasConvention,
    ruleOwner:
      "apps/cli/src/flywheel.ts — resolveFlywheelData (the three rungs) and formatRatingsShadowWarning (the warning). Not reimplemented here.",
    note: hasConvention
      ? `${CONVENTIONAL_DATASET} exists beside the spec, so a \`flywheel run\` with no --dataset uses it. If ${ratingsRef} has been distilled, that file SHADOWS it and the loop optimizes against the scaffold while real ratings pile up unused — pass --dataset ${ratingsRef} to use them. Whether ${ratingsRef} exists needs @crewhaus/dataset-registry, which this tool does not read.`
      : `no ${CONVENTIONAL_DATASET} beside the spec, so a \`flywheel run\` with no --dataset falls through to ${ratingsRef}, and refuses if nothing has been distilled into it. Whether it has needs @crewhaus/dataset-registry, which this tool does not read.`,
  };
}

/**
 * The optimizer write-back stamp this build cannot read, named so a reader
 * does not mistake its absence for "the spec was never written back".
 */
export const WRITE_BACK_HEADER_UNAVAILABLE =
  "whether the optimizer's last accepted patch actually landed in the spec is recorded in the spec's LEADING comment block, and is read by `@crewhaus/spec-patch`'s `parseWriteBackHeader` (runId, mutator, iterations, scoreBefore, scoreAfter). This package does not depend on spec-patch, so the stamp is not read and its absence from this result says nothing about whether one is there. `crewhaus optimize --show-writeback` and the flywheel's own report print it.";

/**
 * The acceptance verdict this build cannot read, for the same reason.
 */
export const RUN_VERDICT_UNAVAILABLE =
  "the acceptance verdict of a run (pass_rate before/after, per-sample recoveries and regressions) lives in the eval run artifacts under the run directory's `before/` and `after/`, and is loaded by `@crewhaus/eval-report`'s `loadRun` and gated by `@crewhaus/eval-ops`'s `gateRuns`. Neither is a dependency here, so this tool reports which stage directories exist and does not open them. Parsing them by hand would be a second eval-report.";

/**
 * `state.json` is READ by `@crewhaus/hangar-server`'s flywheel handler, and
 * in this tree nothing writes it — `crewhaus flywheel run` records itself as
 * a `.crewhaus/flywheel/<runId>/` directory instead. It is probed and
 * reported anyway (something else may write it, and an absent file is a fact
 * worth stating), but its absence is NOT evidence that the flywheel has never
 * run: the run directories are.
 */
export const STATE_JSON_NOTE =
  "`.crewhaus/flywheel/state.json` is read by the Hangar flywheel endpoint; in this build `crewhaus flywheel run` writes per-run directories (`.crewhaus/flywheel/<runId>/{before,after,optimize,diff}`) and no state.json. An absent state.json therefore means nothing on its own — read `runs` instead.";
