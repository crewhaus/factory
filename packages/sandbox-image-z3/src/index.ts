import {
  type SandboxImageEntry,
  hasSandboxImage,
  lookupSandboxImage,
  registerSandboxImage,
} from "@crewhaus/sandbox-image-registry";

/**
 * `sandbox-image-z3` — the curated Z3 image behind the `proven` rung's `smt`
 * checker (design/0.8.0-provability-release.md §6.4, §13).
 *
 * Registers the image into `@crewhaus/sandbox-image-registry` exactly the way
 * `sandbox-image-go` registers Go, so it joins the sandbox allowlist through
 * `listAllowedImageRefs()` and shows in `crewhaus sandbox doctor`.
 *
 * Snippet mode (default entrypoint): `z3 -in` reads one SMT-LIB 2 script from
 * stdin. `@crewhaus/proof-checker`'s smt adapter writes that script itself —
 * the model's problem goes in as data between the adapter's own `check-sat`
 * commands, never as a program.
 *
 * The image is ours, not an upstream one: the release builds it from
 * `packages/sandbox-image-z3/Dockerfile` and pushes
 * `ghcr.io/crewhaus/sandbox-z3:<version>`. The tag below is a CONSTANT, not
 * the package version read at runtime — a compiled `crewhaus` binary cannot
 * read its package.json, and a pinned tag keeps every release on an image
 * whose solver version is known. Bump {@link Z3_IMAGE_TAG} when the image
 * changes.
 *
 * Cold-start budget: ≤2 s — Z3 is one native binary, and `z3 --version` is
 * the healthcheck. Live-image probe runs against the real image when
 * `CREWHAUS_SECTION36_LIVE_DOCKER=1` is set (the sibling packages' convention).
 */

export const Z3_IMAGE_ID = "z3";
/** Where the release pushes the image. */
export const Z3_IMAGE_REPO = "ghcr.io/crewhaus/sandbox-z3";
/** The image tag this release pins (see the module doc for why it is a constant). */
export const Z3_IMAGE_TAG = "0.8.0";
export const Z3_IMAGE_REF = `${Z3_IMAGE_REPO}:${Z3_IMAGE_TAG}`;
/**
 * The Z3 release the image at {@link Z3_IMAGE_TAG} carries — the Dockerfile's
 * `Z3_VERSION` (a unit test holds the two in step), and what
 * `z3 --version` prints in it. The official release binary, pinned per
 * architecture by sha256 (see the Dockerfile).
 */
export const Z3_SOLVER_VERSION = "4.16.0";
export const Z3_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["z3", "-in"];
export const Z3_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["z3", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const Z3_COLD_START_BUDGET_MS = 2_000;

/**
 * Register the Z3 image. Calling twice throws via the registry's duplicate-id
 * refusal; boot paths that may run more than once use
 * {@link ensureZ3SandboxImage}.
 */
export function registerZ3SandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: Z3_IMAGE_ID,
    image: Z3_IMAGE_REF,
    defaultEntrypoint: Z3_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: Z3_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: Z3_COLD_START_BUDGET_MS,
    },
    description:
      "Z3 SMT solver — the provability `smt` checker; snippet mode via `z3 -in` (SMT-LIB 2 on stdin).",
  });
}

/** Register the Z3 image unless it already is; returns the registered entry either way. */
export function ensureZ3SandboxImage(): SandboxImageEntry {
  return hasSandboxImage(Z3_IMAGE_ID) ? lookupSandboxImage(Z3_IMAGE_ID) : registerZ3SandboxImage();
}
