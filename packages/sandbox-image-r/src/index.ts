import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-r` — Section 36 polyglot R sandbox image.
 *
 * Snippet mode (default entrypoint): `Rscript -e <code>` reads the
 * snippet from the next argv slot. Analyst-style packages (tidyverse,
 * data.table) are baked in so common stats workloads run without
 * needing a network-aware package install (the sandbox enforces
 * `--network=none`).
 *
 * Cold-start budget: ≤2s for R 4.x — `Rscript -e cat(R.version.string)`
 * is around 600ms warm because R has to bootstrap its base packages
 * even for a one-line snippet. The kickoff prompt's compiled-language
 * 2s budget covers this; we do not use the tighter shell-shape budget.
 *
 * Layer R8.
 */

export const R_IMAGE_ID = "r";
export const R_IMAGE_REF = "rocker/r-base:4.4";
export const R_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["Rscript", "-e"];
export const R_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["Rscript", "-e", "cat(R.version.string)"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const R_COLD_START_BUDGET_MS = 2_000;

export function registerRSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: R_IMAGE_ID,
    image: R_IMAGE_REF,
    defaultEntrypoint: R_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: R_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: R_COLD_START_BUDGET_MS,
    },
    description:
      "R 4.x (rocker/r-base) — snippet mode via `Rscript -e`; tidyverse + data.table preinstalled for analyst workloads.",
  });
}
