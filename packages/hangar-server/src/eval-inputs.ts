/**
 * What the eval stack's jobs need before they can run, and the argv they run
 * with.
 *
 * `crewhaus eval` and `optimize` die without `--dataset` and `--graders`, and
 * each runs only on some harness shapes, so a console that queued them bare
 * queued a job that could only fail. This module decides, from the harness on
 * disk, what can run and what to say when it cannot. Every button, read and
 * handler asks the same {@link launchOffers}, so a control is drawn only where
 * its job can start.
 *
 * It stays free of server state: pure argv builders over a request body and the
 * offers, so a CLI test can parse what they build with the real flag schemas.
 */
import { readFileSync, statSync } from "node:fs";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { RUN_ID_RE } from "./constants";
import { HttpError } from "./http";
import { jobArg, requireString } from "./m3";
import { resolveInside } from "./safety";

const SPEC_PATH = "crewhaus.yaml";
const CONVENTIONAL_DATASET = "eval/dataset.jsonl";
const CONVENTIONAL_GRADERS = "eval/graders.yaml";
/** Where the drift sentinel's frozen baseline lives by convention. */
export const SENTINEL_BASELINE_PATH = "eval/sentinel-baseline";

/** The eval a harness runs with its conventional inputs. */
export const EVAL_JOB_ARGV: readonly string[] = [
  "eval",
  SPEC_PATH,
  "--dataset",
  CONVENTIONAL_DATASET,
  "--graders",
  CONVENTIONAL_GRADERS,
];

/** The optimize a harness runs with its conventional inputs. */
export const OPTIMIZE_JOB_ARGV: readonly string[] = [
  "optimize",
  SPEC_PATH,
  "--dataset",
  CONVENTIONAL_DATASET,
  "--graders",
  CONVENTIONAL_GRADERS,
];

/** The commands a person pastes, spelled from the same vocabulary. */
export const EVAL_COMMAND = `crewhaus ${EVAL_JOB_ARGV.join(" ")}`;
export const OPTIMIZE_COMMAND = `crewhaus ${OPTIMIZE_JOB_ARGV.join(" ")}`;
const FLYWHEEL_COMMAND = "crewhaus flywheel run";
const COMPILE_EVAL_COMMAND = `crewhaus compile ${SPEC_PATH} --with-eval-harness`;

const SPEC_UNREADABLE = "The spec could not be read.";
const NO_DATASET = `No test cases yet: add ${CONVENTIONAL_DATASET}.`;
const NO_GRADERS = `No checks yet: add ${CONVENTIONAL_GRADERS}.`;

/** Which harness shapes each verb runs on, as the CLI itself decides it. */
const EVAL_SHAPES: ReadonlySet<string> = new Set(["cli"]);
const OPTIMIZE_SHAPES: ReadonlySet<string> = new Set([
  "cli",
  "workflow",
  "graph",
  "crew",
  "pipeline",
]);
const FLYWHEEL_SHAPES: ReadonlySet<string> = new Set(["cli"]);

export type LaunchOffer = {
  /** A click can start this job as things stand. */
  readonly offered: boolean;
  /** The harness shape can run it. An explicit dataset can stand in for a
   *  missing file, but never for a shape. */
  readonly shapeOk: boolean;
  /** Why not, in plain words. `null` when offered. */
  readonly note: string | null;
  /** The exact command that does this, or `null` when none would work. */
  readonly verb: string | null;
};

export type LaunchOffers = {
  readonly eval: LaunchOffer;
  readonly optimize: LaunchOffer;
  readonly flywheel: LaunchOffer;
  /** Which conventional files are on disk. */
  readonly conventional: { readonly dataset: boolean; readonly graders: boolean };
};

const offered = (verb: string): LaunchOffer => ({
  offered: true,
  shapeOk: true,
  note: null,
  verb,
});

const wrongShape = (note: string, verb: string | null = null): LaunchOffer => ({
  offered: false,
  shapeOk: false,
  note,
  verb,
});

const missingInput = (notes: readonly string[]): LaunchOffer => ({
  offered: false,
  shapeOk: true,
  note: notes.join(" "),
  verb: null,
});

/** True for a regular file at this harness-relative path, realpath-contained. */
function isContainedFile(dir: string, segments: readonly string[]): boolean {
  const path = resolveInside(dir, segments);
  if (path === undefined) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isContainedDir(dir: string, segments: readonly string[]): boolean {
  const path = resolveInside(dir, segments);
  if (path === undefined) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The spec's own name and target, read live, or `undefined` when unreadable. */
function readLiveHeader(dir: string): { name?: string; target?: string } | undefined {
  const path = resolveInside(dir, [SPEC_PATH]);
  if (path === undefined) return undefined;
  try {
    return readSpecHeader(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * What can run on this harness, and what to say about what cannot. The target
 * comes from the live spec; `registryTarget` is only for a spec that does not
 * name one.
 */
export function launchOffers(dir: string, registryTarget?: string): LaunchOffers {
  const conventional = {
    dataset: isContainedFile(dir, CONVENTIONAL_DATASET.split("/")),
    graders: isContainedFile(dir, CONVENTIONAL_GRADERS.split("/")),
  };
  const header = readLiveHeader(dir);
  const target = header?.target ?? (header === undefined ? undefined : registryTarget);
  if (header === undefined || target === undefined) {
    const unreadable = wrongShape(SPEC_UNREADABLE);
    return { eval: unreadable, optimize: unreadable, flywheel: unreadable, conventional };
  }

  const missing = [
    ...(conventional.dataset ? [] : [NO_DATASET]),
    ...(conventional.graders ? [] : [NO_GRADERS]),
  ];
  const withFiles = (verb: string): LaunchOffer =>
    missing.length === 0 ? offered(verb) : missingInput(missing);

  // The flywheel resolves its own dataset: the conventional file, else the
  // ratings its feedback loop distilled. A ratings-driven harness runs from the
  // CLI, so it runs from here. The CLI's own check still has the last word,
  // since that fallback also needs a `feedback:` block.
  const ratings =
    header.name !== undefined &&
    isContainedDir(dir, [".crewhaus", "datasets", `${header.name}-ratings`]);
  const flywheelMissing = [
    ...(conventional.dataset || ratings ? [] : [NO_DATASET]),
    ...(conventional.graders ? [] : [NO_GRADERS]),
  ];

  return {
    eval: EVAL_SHAPES.has(target)
      ? withFiles(EVAL_COMMAND)
      : wrongShape(
          "Checks for this harness type run inside its compiled test bundle.",
          COMPILE_EVAL_COMMAND,
        ),
    optimize: OPTIMIZE_SHAPES.has(target)
      ? withFiles(OPTIMIZE_COMMAND)
      : wrongShape("Automatic prompt search isn't available for this harness type."),
    flywheel: FLYWHEEL_SHAPES.has(target)
      ? flywheelMissing.length === 0
        ? offered(FLYWHEEL_COMMAND)
        : missingInput(flywheelMissing)
      : wrongShape("The improvement loop runs on command-line harnesses only."),
    conventional,
  };
}

// ---------------------------------------------------------------------------
// The closed argv vocabulary
// ---------------------------------------------------------------------------

type Body = Readonly<Record<string, unknown>>;

export function positiveInt(body: Body, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `"${key}" must be a positive integer`);
  }
  return value;
}

export function positiveNumber(body: Body, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, `"${key}" must be a positive number`);
  }
  return value;
}

/**
 * The two paths a measuring job needs: what the request named, else the
 * conventional file when it exists. A shape that cannot run the job, or a path
 * nothing can fill, is a 409 that says which.
 */
function resolveInputs(
  explicit: { readonly dataset: unknown; readonly graders: unknown },
  offer: LaunchOffer,
  conventional: LaunchOffers["conventional"],
): { readonly dataset: unknown; readonly graders: unknown } {
  if (!offer.shapeOk) throw new HttpError(409, offer.note ?? SPEC_UNREADABLE);
  const missing = [
    ...(explicit.dataset === undefined && !conventional.dataset ? [NO_DATASET] : []),
    ...(explicit.graders === undefined && !conventional.graders ? [NO_GRADERS] : []),
  ];
  if (missing.length > 0) throw new HttpError(409, missing.join(" "));
  return {
    dataset: explicit.dataset ?? CONVENTIONAL_DATASET,
    graders: explicit.graders ?? CONVENTIONAL_GRADERS,
  };
}

function inputFlags(body: Body, offer: LaunchOffer, offers: LaunchOffers): string[] {
  const inputs = resolveInputs(
    { dataset: body["dataset"], graders: body["graders"] },
    offer,
    offers.conventional,
  );
  return [
    "--dataset",
    jobArg("dataset", inputs.dataset),
    "--graders",
    jobArg("graders", inputs.graders),
  ];
}

/**
 * The options `POST /jobs` hands `jobArgv` for an eval. `jobArgv` keeps its own
 * shape check on them, so an unusable value is its 400.
 */
export function evalJobOptions(
  body: Body,
  offers: LaunchOffers,
): { readonly dataset: string; readonly graders: string } {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : undefined;
  const inputs = resolveInputs(
    { dataset: text(body["dataset"]), graders: text(body["graders"]) },
    offers.eval,
    offers.conventional,
  );
  return { dataset: inputs.dataset as string, graders: inputs.graders as string };
}

export type EvalPlan = {
  readonly argv: readonly string[];
  readonly warnings: readonly string[];
};

/** `crewhaus eval`. Nothing outside this function's flags reaches the line, and
 *  every interpolated value is `jobArg`-shaped before it gets there. */
export function evalArgv(body: Body, offers: LaunchOffers): EvalPlan {
  const argv: string[] = ["eval", SPEC_PATH, ...inputFlags(body, offers.eval, offers)];
  const warnings: string[] = [];

  const slice = body["slice"];
  if (slice !== undefined) argv.push("--slice", jobArg("slice", slice));

  const models = body["models"];
  if (models !== undefined) {
    if (!Array.isArray(models) || models.length === 0) {
      throw new HttpError(400, '"models" must be a non-empty array of model ids');
    }
    argv.push("--models", models.map((m, i) => jobArg(`models[${i}]`, m)).join(","));
  }

  const repeats = positiveInt(body, "repeats");
  if (repeats !== undefined) argv.push("--repeats", String(repeats));
  const seed = positiveInt(body, "seed");
  if (seed !== undefined) argv.push("--seed", String(seed));
  const budgetUsd = positiveNumber(body, "budgetUsd");
  if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
  const maxCostUsd = positiveNumber(body, "maxCostUsd");
  if (maxCostUsd !== undefined) argv.push("--max-cost-usd", String(maxCostUsd));

  if (body["gate"] === true) argv.push("--gate");
  // A resume re-opens a run directory by path, and `--resume` takes that path.
  // It is built here from a checked id, because every run directory sits under
  // `.crewhaus`, whose leading dot `jobArg` refuses.
  const resume = body["resume"];
  if (resume !== undefined) {
    if (typeof resume !== "string" || !RUN_ID_RE.test(resume)) {
      throw new HttpError(400, '"resume" must be the id of a run to resume');
    }
    argv.push("--resume", `.crewhaus/evals/${resume}`);
  }

  // The held-out test cases. `--allow-test-split` is not a convenience flag: the
  // server refuses it without `releaseConfirm: true`, which the form sends only
  // for the typed word, so a stray checkbox cannot reach it. The refusal is for the
  // person at that form, who has no fields to send.
  if (body["allowTestSplit"] === true) {
    if (body["releaseConfirm"] !== true) {
      throw new HttpError(409, 'Type "release" to confirm using the held-out test cases.');
    }
    argv.push("--allow-test-split");
    warnings.push(
      "This run uses the held-out test cases and is not recorded. Only crewhaus datasets release records a use.",
    );
  }
  return { argv, warnings };
}

const OPTIMIZER_MUTATORS: ReadonlySet<string> = new Set(["rule-based", "claude", "meta-harness"]);

/** `crewhaus optimize`. Applying saved suggestions replaces the mutation search,
 *  so `--from-advice` never travels with `--mutator`: the CLI refuses the pair. */
export function optimizeArgv(
  body: Body,
  offers: LaunchOffers,
): { readonly argv: readonly string[]; readonly mutator: string | null } {
  const fromAdvice = body["fromAdvice"];
  let mutator: string | null = null;
  if (fromAdvice === undefined) {
    mutator = requireString(body, "mutator");
    if (!OPTIMIZER_MUTATORS.has(mutator)) {
      throw new HttpError(400, '"mutator" must be one of rule-based, claude, meta-harness');
    }
  }
  const adviceFile =
    fromAdvice === undefined
      ? undefined
      : fromAdvice === true
        ? "suggestions.json"
        : jobArg("fromAdvice", fromAdvice);
  const flags = inputFlags(body, offers.optimize, offers);
  // `optimize --from-advice` measures through `crewhaus eval`'s own path, so it
  // has eval's shape rule, not optimize's wider one.
  if (adviceFile !== undefined && !offers.eval.shapeOk) {
    throw new HttpError(409, "Applying saved suggestions runs on command-line harnesses only.");
  }
  const argv: string[] = ["optimize", SPEC_PATH];
  if (mutator !== null) argv.push("--mutator", mutator);
  argv.push(...flags);
  const budgetUsd = positiveNumber(body, "budgetUsd");
  if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
  const concurrency = positiveInt(body, "concurrency");
  if (concurrency !== undefined) argv.push("--concurrency", String(concurrency));
  if (adviceFile !== undefined) argv.push("--from-advice", adviceFile);
  return { argv, mutator };
}

/**
 * `crewhaus flywheel run|init`. The loop resolves its own inputs, and no flag is
 * ever added for them: a flag would change where the dataset came from, which
 * silences the warning for a conventional file shadowing distilled ratings.
 * `init` only writes scaffolding, so nothing gates it.
 */
export function flywheelArgv(
  body: Body,
  offers: LaunchOffers,
): { readonly argv: readonly string[]; readonly action: "run" | "init" } {
  const action = body["action"] ?? "run";
  if (action !== "run" && action !== "init") {
    throw new HttpError(400, '"action" must be "run" or "init"');
  }
  const argv: string[] = ["flywheel", action];
  if (action === "run") {
    if (!offers.flywheel.offered) {
      throw new HttpError(409, offers.flywheel.note ?? SPEC_UNREADABLE);
    }
    const budgetUsd = positiveNumber(body, "budgetUsd");
    if (budgetUsd !== undefined) argv.push("--budget-usd", String(budgetUsd));
    const iterations = positiveInt(body, "iterations");
    if (iterations !== undefined) argv.push("--iterations", String(iterations));
  }
  return { argv, action };
}

/** The drift sentinel: an eval against a frozen baseline. `eval` wants its inputs
 *  before it looks at `--sentinel`, so they travel here too. */
export function sentinelArgv(
  body: Body,
  offers: LaunchOffers,
): { readonly argv: readonly string[]; readonly baseline: string } {
  const baseline = jobArg("baseline", body["baseline"] ?? SENTINEL_BASELINE_PATH);
  const flags = inputFlags(body, offers.eval, offers);
  return {
    argv: ["eval", SPEC_PATH, ...flags, "--sentinel", "--baseline", baseline],
    baseline,
  };
}
