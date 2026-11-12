/**
 * The CLI's spec writes, through `@crewhaus/spec-patch/commit`.
 *
 * Every verb that writes `crewhaus.yaml` (`lint --fix`, `optimize
 * --write-back`, `flywheel run`, `model-scan --write`, `model right-size
 * --write`, `upgrade --write`, `doctor --fix`) passes the revision of the text
 * its result was computed from. When the spec changed after that read, nothing
 * is written: the result is kept as a draft under `.crewhaus/run/spec/drafts/`
 * and the verb exits `EXIT_CODES.conflict` (53) with one line naming the draft
 * and the next step. `init` creates a spec and never replaces one.
 */
import { EXIT_CODES } from "@crewhaus/errors";
import { OptimizeSpecError } from "@crewhaus/eval-optimizer-orchestrator";
import {
  type CommitFailure,
  type CommitOptions,
  type CommitSuccess,
  type SpecChange,
  type WriterId,
  commitSpec,
  parseYamlOnly,
} from "@crewhaus/spec-patch/commit";

export { createSpecFile, specRev } from "@crewhaus/spec-patch/commit";

/** Test seam: a hook run between a writer's read and its write (see `commitSpec`'s `hooks`). */
let testHooks: CommitOptions["hooks"];

/** Install (or clear, with undefined) the test seam every CLI spec write passes to `commitSpec`. */
export function setSpecCommitTestHooks(hooks: CommitOptions["hooks"]): void {
  testHooks = hooks;
}

export type CliCommitDeps = {
  readonly stderr?: (text: string) => void;
  readonly exit?: (code: number) => never;
};

/**
 * The next step a conflict names. One wording for every writer: a verb's
 * flags and arguments are what the user typed, so the line never rebuilds them.
 */
export const RERUN_STEP = "Run the same command again on the current spec.";

/** The one line a refused write prints. */
export function formatCommitRefusal(
  verb: string,
  specPath: string,
  failure: CommitFailure,
): string {
  if (failure.code === "conflict") {
    const draft = failure.draft?.path;
    return `crewhaus ${verb}: ${specPath} changed after this command read it, so nothing was written.${
      draft !== undefined ? ` Your result is kept as a draft: ${draft}.` : ""
    } ${RERUN_STEP}`;
  }
  return `crewhaus ${verb}: nothing was written to ${specPath}: ${failure.reason}`;
}

/**
 * Commit `change` to `specPath` for a CLI verb. Answers the success; on a
 * refusal prints one line and exits — 53 for a conflict, 1 otherwise. The
 * writer's own validation is kept: by default a YAML syntax check only.
 */
export async function commitCliSpec(
  verb: string,
  specPath: string,
  change: SpecChange,
  opts: {
    readonly expectedRev: string;
    readonly writer: WriterId;
    readonly parse?: CommitOptions["parse"];
  },
  deps: CliCommitDeps = {},
): Promise<CommitSuccess> {
  const result = await commitSpec({ specPath }, change, {
    expectedRev: opts.expectedRev,
    writer: opts.writer,
    actor: { kind: "person" },
    parse: opts.parse ?? parseYamlOnly,
    ...(testHooks !== undefined ? { hooks: testHooks } : {}),
  });
  if (result.ok) return result;
  (deps.stderr ?? ((text: string) => process.stderr.write(text)))(
    `${formatCommitRefusal(verb, specPath, result)}\n`,
  );
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return exit(result.code === "conflict" ? EXIT_CODES.conflict : 1);
}

/**
 * Run an optimizer write-back; when it answers that the spec changed after
 * the run read it, print the same one line a CLI write prints and exit 53.
 */
export async function exitOnOptimizeConflict<T>(
  verb: string,
  run: () => Promise<T>,
  deps: CliCommitDeps = {},
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof OptimizeSpecError) || err.failure !== "conflict") throw err;
    (deps.stderr ?? ((text: string) => process.stderr.write(text)))(
      `crewhaus ${verb}: ${err.message}. ${RERUN_STEP}\n`,
    );
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    return exit(EXIT_CODES.conflict);
  }
}
