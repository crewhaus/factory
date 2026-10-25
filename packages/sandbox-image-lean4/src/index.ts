import {
  type SandboxImageEntry,
  hasSandboxImage,
  lookupSandboxImage,
  registerSandboxImage,
} from "@crewhaus/sandbox-image-registry";

/**
 * `sandbox-image-lean4` — the curated Lean 4 image behind the `proven` rung's
 * `lean4` checker (design/0.8.0-provability-release.md §6.4, §13, §17.4).
 *
 * Registers the image into `@crewhaus/sandbox-image-registry` exactly the way
 * `sandbox-image-go` registers Go, so it joins the sandbox allowlist through
 * `listAllowedImageRefs()` and shows in `crewhaus sandbox doctor`.
 *
 * Snippet mode (default entrypoint): `lean --stdin --json` elaborates one Lean
 * file read from stdin and reports every message as one JSON line.
 * `@crewhaus/proof-checker`'s lean4 adapter writes that file itself — the
 * model's statement and proof are spliced into one `theorem` after a
 * deterministic pre-scan, followed by the adapter's own `#print axioms`.
 *
 * Mathlib-free by default (design §16: a Mathlib image is multi-gigabyte);
 * a spec that needs Mathlib points `provability.formal.image` at its own
 * image, and the adapter then also accepts `import Mathlib…` lines.
 *
 * The image is ours: the release builds it from
 * `packages/sandbox-image-lean4/Dockerfile` and pushes
 * `ghcr.io/crewhaus/sandbox-lean4:<version>`. The tag below is a CONSTANT, not
 * the package version read at runtime — a compiled `crewhaus` binary cannot
 * read its package.json, and a pinned tag keeps every release on a known
 * toolchain. Bump {@link LEAN4_IMAGE_TAG} when the image changes.
 *
 * Cold-start budget: ≤4 s — the looser bucket (`sandbox-image-dotnet`'s): the
 * toolchain is large and its first start in a fresh slot is slower than a
 * single native binary's.
 */

export const LEAN4_IMAGE_ID = "lean4";
/** Where the release pushes the image. */
export const LEAN4_IMAGE_REPO = "ghcr.io/crewhaus/sandbox-lean4";
/** The image tag this release pins (see the module doc for why it is a constant). */
export const LEAN4_IMAGE_TAG = "0.8.0";
export const LEAN4_IMAGE_REF = `${LEAN4_IMAGE_REPO}:${LEAN4_IMAGE_TAG}`;
/**
 * The Lean toolchain the image at {@link LEAN4_IMAGE_TAG} carries — the
 * Dockerfile's `LEAN_VERSION` (a unit test holds the two in step), and what
 * `lean --version` prints in it. The official `leanprover/lean4` release,
 * pinned per architecture by sha256 and cut down to Init and Std (see the
 * Dockerfile).
 */
export const LEAN4_TOOLCHAIN_VERSION = "4.34.1";
export const LEAN4_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["lean", "--stdin", "--json"];
export const LEAN4_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["lean", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const LEAN4_COLD_START_BUDGET_MS = 4_000;

/**
 * Register the Lean 4 image. Calling twice throws via the registry's
 * duplicate-id refusal; boot paths that may run more than once use
 * {@link ensureLean4SandboxImage}.
 */
export function registerLean4SandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: LEAN4_IMAGE_ID,
    image: LEAN4_IMAGE_REF,
    defaultEntrypoint: LEAN4_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: LEAN4_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: LEAN4_COLD_START_BUDGET_MS,
    },
    description:
      "Lean 4 (Mathlib-free) — the provability `lean4` checker; snippet mode via `lean --stdin --json`.",
  });
}

/** Register the Lean 4 image unless it already is; returns the registered entry either way. */
export function ensureLean4SandboxImage(): SandboxImageEntry {
  return hasSandboxImage(LEAN4_IMAGE_ID)
    ? lookupSandboxImage(LEAN4_IMAGE_ID)
    : registerLean4SandboxImage();
}
