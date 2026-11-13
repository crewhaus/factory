/**
 * `crewhaus eval <spec> --dataset <d> --graders <g> --regrade <runId>`: grade a
 * recorded run's answers again with the graders as they are now. The run
 * reads each case's input and expected output from the dataset, takes the
 * agent's answer, transcript, trace events and proof bundle from the source
 * run's directory, and never calls the agent. It is recorded in the run
 * history as a regrade of its source, and it is never gated or pinned.
 *
 * `--regrade-baseline` (with a live run): when the baseline was measured with
 * other graders, regrade the baseline's answers with this run's graders and
 * gate this run against that, so the comparison is on the same answers.
 *
 * Side-effect-free on import, so the unit tests drive it directly; `index.ts`
 * dies with a refusal.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, GradersConfig } from "@crewhaus/eval-grader";
import { runCriteriaRecord } from "@crewhaus/eval-grader";
import {
  DEFAULT_EVALS_DIR,
  type RunIndexEntry,
  readRunIndexLatest,
  recordEvalRun,
} from "@crewhaus/eval-report";
import {
  type EvalPricingFn,
  type EvalRunSummary,
  type GraderLookup,
  PROVABILITY_GRADER_NAMES,
  type RegradePurpose,
  createRegrade,
  runEval,
} from "@crewhaus/eval-runner";
import type { IrV0 } from "@crewhaus/ir";

/** What a regrade's source run id looks like. */
export const REGRADE_RUN_ID_RE = /^run_[A-Za-z0-9]{4,64}$/;

/** The command a re-anchor through a regraded baseline records on its pin. */
export const REGRADE_BASELINE_CMD = "crewhaus eval --regrade-baseline";

/** Flags `--regrade` cannot be combined with, and why. */
const REGRADE_INCOMPATIBLE: ReadonlyArray<readonly [flag: string, why: string]> = [
  ["gate", "a regrade grades recorded answers and is never gated"],
  ["rebaseline", "a regrade is never a baseline"],
  ["regrade-baseline", "--regrade-baseline regrades the baseline of a live run"],
  ["resume", "a regrade runs no agent, so there is nothing to resume"],
  ["models", "a regrade grades one recorded run"],
  ["sentinel", "a sentinel probes a live provider"],
  ["provability", "a regrade grades what the source run recorded, at its own floor"],
  ["record-tools", "a regrade runs no tools"],
  ["replay-tools", "a regrade runs no tools"],
  ["voice", "--voice replays call sessions"],
  ["repeats", "a regrade grades one recorded answer per case"],
];

/** Flags `--regrade-baseline` cannot be combined with, and why. */
const REGRADE_BASELINE_INCOMPATIBLE: ReadonlyArray<readonly [flag: string, why: string]> = [
  ["rebaseline", "choose one way to re-anchor: --rebaseline pins this run as it is"],
  ["models", "a --models matrix compares models and pins no single run"],
  ["sentinel", "a sentinel pins nothing"],
  ["voice", "--voice replays call sessions and pins no baseline"],
];

export type RegradeParse =
  | {
      readonly ok: true;
      readonly regrade?: { readonly runId: string };
      readonly regradeBaseline?: true;
    }
  | { readonly ok: false; readonly error: string };

const set = (v: unknown): boolean => v !== undefined && v !== false;

/** Read `--regrade <runId>` and `--regrade-baseline` from an `eval` invocation's flags. */
export function parseRegrade(flags: Readonly<Record<string, unknown>>): RegradeParse {
  const raw = flags["regrade"];
  const baseline = flags["regrade-baseline"] === true;
  if (raw !== undefined) {
    if (typeof raw !== "string" || raw === "") {
      return { ok: false, error: "--regrade requires the id of the run to regrade (run_…)" };
    }
    if (!REGRADE_RUN_ID_RE.test(raw)) {
      return {
        ok: false,
        error: `--regrade "${raw}" is not a run id (run_ followed by letters and digits)`,
      };
    }
    for (const [flag, why] of REGRADE_INCOMPATIBLE) {
      if (set(flags[flag])) {
        return { ok: false, error: `--regrade and --${flag} cannot be combined: ${why}` };
      }
    }
    return { ok: true, regrade: { runId: raw } };
  }
  if (baseline) {
    for (const [flag, why] of REGRADE_BASELINE_INCOMPATIBLE) {
      if (set(flags[flag])) {
        return { ok: false, error: `--regrade-baseline and --${flag} cannot be combined: ${why}` };
      }
    }
    return { ok: true, regradeBaseline: true };
  }
  return { ok: true };
}

/** Whether `path`'s real path lies inside `root`'s. */
function containedIn(root: string, path: string): boolean {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(path);
  } catch {
    return false;
  }
  const rel = relative(realRoot, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The run history's row for `runId` (the newest, for a run resumed into
 * several rows), refused when the history holds none, it graded another
 * run's answers itself, or its directory lies outside the evals directory.
 * Throws a plain `Error`.
 */
export function resolveRegradeSource(
  runId: string,
  evalsDir: string = DEFAULT_EVALS_DIR,
): RunIndexEntry {
  if (!REGRADE_RUN_ID_RE.test(runId)) {
    throw new Error(`--regrade "${runId}" is not a run id (run_ followed by letters and digits)`);
  }
  const row = readRunIndexLatest(evalsDir).find((e) => e.runId === runId);
  if (row === undefined) {
    throw new Error(
      `--regrade: no run ${runId} in ${join(evalsDir, "index.jsonl")} — list runs with \`crewhaus eval history\``,
    );
  }
  if (row.purpose !== undefined) {
    throw new Error(
      `--regrade: run ${runId} is itself a ${row.purpose} of run ${row.regradeOf ?? "(unknown)"} — regrade the run that answered`,
    );
  }
  if (typeof row.outDir !== "string" || !containedIn(evalsDir, resolve(row.outDir))) {
    throw new Error(
      `--regrade: run ${runId}'s directory is not inside ${evalsDir} — only a run this harness recorded there can be regraded`,
    );
  }
  return row;
}

/**
 * The perGrader names this graders file records through one of the six
 * provability graders: every entry whose `type: registry` grader is one of
 * them, under the entry's own name.
 */
export function provabilityGraderNamesOf(
  compiled: ReadonlyArray<Pick<CompiledGrader, "name" | "registrySpec">>,
): ReadonlySet<string> {
  return new Set(
    compiled
      .filter(
        (g) =>
          g.registrySpec !== undefined && PROVABILITY_GRADER_NAMES.includes(g.registrySpec.grader),
      )
      .map((g) => g.name),
  );
}

export type RegradeRunArgs = {
  readonly ir: IrV0;
  readonly sourceDir: string;
  readonly purpose: RegradePurpose;
  readonly datasetName: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly datasetHash: string;
  readonly compiled: ReadonlyArray<CompiledGrader>;
  readonly gradersConfig: GradersConfig;
  readonly gradersHash: string;
  readonly outDir?: string;
  readonly judgeModel?: string;
  readonly graderRegistry?: GraderLookup;
  readonly concurrency?: number;
  readonly cliVersion?: string;
  readonly pricing?: EvalPricingFn;
  readonly cwd?: string;
  /** Record the run in the history index (a regrade is; a preview is not). */
  readonly record?: {
    readonly specName: string;
    readonly specSource?: string;
    readonly evalsDir?: string;
    readonly judgeCostUsd?: (summary: EvalRunSummary) => number | undefined;
  };
};

/** Regrade a recorded run's answers with these graders; record the run when asked. */
export async function regradeRecordedRun(args: RegradeRunArgs): Promise<EvalRunSummary> {
  const criteria = runCriteriaRecord(args.gradersConfig);
  const plan = createRegrade({
    sourceDir: args.sourceDir,
    purpose: args.purpose,
    samples: args.samples,
    datasetHash: args.datasetHash,
    ...(criteria !== undefined ? { criteria } : {}),
    ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
  });
  async function* stream(): AsyncIterable<Sample> {
    for (const s of args.samples) yield s;
  }
  const summary = await runEval({
    ir: args.ir,
    dataset: { name: args.datasetName, samples: stream() },
    compiledGraders: args.compiled,
    opts: {
      regrade: plan,
      datasetHash: args.datasetHash,
      gradersHash: args.gradersHash,
      ...(criteria !== undefined ? { criteria } : {}),
      ...(args.outDir !== undefined ? { outDir: args.outDir } : {}),
      ...(args.judgeModel !== undefined ? { judgeModel: args.judgeModel } : {}),
      ...(args.graderRegistry !== undefined ? { graderRegistry: args.graderRegistry } : {}),
      ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
      ...(args.cliVersion !== undefined ? { cliVersion: args.cliVersion } : {}),
      ...(args.pricing !== undefined ? { pricing: args.pricing } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    },
  });
  if (args.record !== undefined) {
    const judgeCostUsd = args.record.judgeCostUsd?.(summary);
    recordEvalRun(summary, {
      specName: args.record.specName,
      ...(args.record.specSource !== undefined ? { specSource: args.record.specSource } : {}),
      datasetHash: args.datasetHash,
      outDir: resolve(summary.outDir),
      ...(args.record.evalsDir !== undefined ? { evalsDir: args.record.evalsDir } : {}),
      // No agent ran: the only spend is the judges'.
      ...(judgeCostUsd !== undefined ? { costUsd: judgeCostUsd, judgeCostUsd } : {}),
    });
  }
  return summary;
}
