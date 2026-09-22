/**
 * `@crewhaus/hangar-server/scaffolded-workflows` — the single source of
 * truth for the filenames CrewHaus writes into `.github/workflows`. The
 * CLI's scaffolders derive their `*_WORKFLOW_RELPATH` constants from this
 * list and the Hangar reads `.github/workflows` through it, so the writer
 * and the reader cannot name different files.
 *
 * They DID name different files. The flywheel endpoint matched
 * `/crewhaus-(flywheel|eval-gate|sentinel)/`, and two of those three names
 * are never written to disk by anything: `crewhaus-eval-gate` and
 * `crewhaus-sentinel` are the SYSTEMD UNIT labels `schedule-generate.ts`
 * emits — plausible-looking siblings of the real filenames, which is
 * exactly why a hand-written pattern could sit there looking correct. The
 * eval gate, the sentinel, the model-plan and the dream workflows were all
 * invisible to the endpoint; a harness scaffolded with `init --ci
 * --sentinel` reported one workflow, and one scaffolded with `--sentinel`
 * alone reported none and tripped the "no flywheel scaffolding on this
 * harness" branch on a harness that is scaffolded.
 *
 * A LEAF module on purpose: zero imports, no side effects, its own export
 * subpath. `apps/cli` depends on this package (never the reverse), but the
 * CLI entry deliberately keeps the Hangar server behind a dynamic import —
 * every `crewhaus` invocation would otherwise pay to load a web server it
 * is not going to start. Importing this file costs nothing, so the
 * scaffolders can share the names without taking that trade.
 */

/**
 * Keys name the CONCEPT (what an operator calls the job); values are the
 * filenames actually written. Note `evalGate` → `crewhaus-eval.yml` and
 * `sentinel` → `sentinel-drift.yml`: neither filename contains the word a
 * reader would guess, which is the whole reason this mapping is explicit.
 */
export const SCAFFOLDED_WORKFLOWS = {
  /** `crewhaus flywheel init` */
  flywheel: "crewhaus-flywheel.yml",
  /** `crewhaus flywheel init --model-plan` */
  modelPlan: "crewhaus-model-plan.yml",
  /** `crewhaus init --ci` */
  evalGate: "crewhaus-eval.yml",
  /** `crewhaus init --sentinel` */
  sentinel: "sentinel-drift.yml",
  /** `crewhaus dream init` */
  dream: "crewhaus-dream.yml",
} as const;

/** The directory GitHub reads workflows from. Segments, so callers can
 *  `join(...)` them for disk or `.join("/")` them for a wire path. */
export const WORKFLOWS_DIR_SEGMENTS = [".github", "workflows"] as const;

/** Every scaffolded workflow filename, for membership tests. */
export const SCAFFOLDED_WORKFLOW_FILENAMES: readonly string[] = Object.values(SCAFFOLDED_WORKFLOWS);

/** A `.github/workflows` entry we scaffolded — exact basename, never a
 *  substring: `crewhaus-eval.yml` and a hand-written
 *  `crewhaus-eval-nightly.yml` are different files with different owners. */
export const isScaffoldedWorkflow = (name: string): boolean =>
  SCAFFOLDED_WORKFLOW_FILENAMES.includes(name);

/** A scaffolded workflow's path relative to the harness root, as a POSIX
 *  wire path (`.github/workflows/<name>`). */
export const scaffoldedWorkflowPath = (name: string): string =>
  [...WORKFLOWS_DIR_SEGMENTS, name].join("/");
