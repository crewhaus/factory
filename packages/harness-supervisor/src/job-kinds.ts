/**
 * The job vocabulary: which jobs a manager may submit, and the `crewhaus`
 * argv each one runs. A CLOSED vocabulary — an HTTP body names a kind and a
 * few shape-checked options, and this module alone turns them into a command
 * line, so a request can never append a flag (or a second command) to a
 * spawn.
 *
 * It sits beside the job queue that runs these argv vectors. It moved here
 * from `@crewhaus/hangar-server`, which still re-exports every name (the
 * same bindings, so `instanceof JobArgumentError` holds across the two), for
 * one release.
 */
import { isAbsolute } from "node:path";

/** Job kinds the M2 action faces submit. Anything else is a 400. */
export const JOB_KINDS = ["doctor", "compile", "eval", "dream-run"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/** Typed job options. Deliberately NOT free-form argv: a job's command line
 *  is built here from a closed vocabulary, so an HTTP body can never append
 *  a flag (or a second command) to a spawn. */
export type JobOptions = {
  /** Registered dataset name or a harness-relative dataset file. */
  readonly dataset?: string;
  /** Harness-relative graders config. */
  readonly graders?: string;
};

/** One path segment, or a harness-relative path of such segments. Keeps a
 *  job argument from becoming `../..`, an absolute path, or a flag. */
const JOB_ARG_RE =
  /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127})*$/;

export class JobArgumentError extends Error {}

/**
 * The `crewhaus` argv for one job. Pure, and pinned by a test: this is the
 * boundary where an HTTP body turns into a command line, so it is the one
 * place a mistake becomes an injection.
 */
export function jobArgv(kind: JobKind, options: JobOptions = {}): string[] {
  const checked = (name: string, value: string): string => {
    if (!JOB_ARG_RE.test(value)) {
      throw new JobArgumentError(
        `job ${kind}: "${name}" must be a plain name or harness-relative path (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };
  switch (kind) {
    case "doctor":
      return ["doctor"];
    case "compile":
      return ["compile", "crewhaus.yaml", "-o", "dist"];
    case "dream-run":
      return ["dream", "run", "crewhaus.yaml"];
    case "eval": {
      const argv = ["eval", "crewhaus.yaml"];
      if (options.dataset !== undefined)
        argv.push("--dataset", checked("dataset", options.dataset));
      if (options.graders !== undefined)
        argv.push("--graders", checked("graders", options.graders));
      return argv;
    }
  }
}

/**
 * The job that archives a whole harness for its owner: `crewhaus state backup --out <path>`.
 * It is not one of {@link JOB_KINDS}, so the job route that names a kind never starts it;
 * only the export operation does, with a path it chose itself.
 */
export const EXPORT_JOB_KIND = "export-harness";

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** The argv the export job runs, for an absolute archive path with no control character. */
export function exportHarnessArgv(out: string): string[] {
  if (typeof out !== "string" || out === "" || !isAbsolute(out)) {
    throw new JobArgumentError("export: the archive path must be absolute");
  }
  if (CONTROL_CHAR_RE.test(out)) {
    throw new JobArgumentError("export: the archive path holds a control character");
  }
  return ["state", "backup", "--out", out];
}
