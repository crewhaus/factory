import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-go` — Section 36 polyglot Go sandbox image.
 *
 * Registers a curated Go 1.23 image into `@crewhaus/sandbox-image-registry`
 * so polyglot agents can `lookupSandboxImage("go")` and route a snippet
 * through `tool-code-execution`'s sandbox path.
 *
 * Snippet mode (default entrypoint): `go run -` reads stdin as a single
 * `package main` source file. Advanced callers who mount a project can
 * exec `./<binary>` after a build step — the entrypoint is overridable
 * at `sandbox.exec({ argv })` time.
 *
 * Cold-start budget: ≤2s for the compiled-language warm pool; the
 * `healthcheck.timeoutMs = 2_000` enforces the registry's view of
 * "healthy". Live-image probe runs `go version` against the actual
 * docker image when `CREWHAUS_SECTION36_LIVE_DOCKER=1` is set.
 *
 * Layer R8. Pairs with `sandbox-image-registry` (R8 — registration
 * surface) and `sandbox` (R8 — exec backend).
 */

export const GO_IMAGE_ID = "go";
export const GO_IMAGE_REF = "golang:1.23-alpine";
export const GO_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["go", "run", "-"];
export const GO_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["go", "version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const GO_COLD_START_BUDGET_MS = 2_000;

/**
 * Register the Go 1.23 image. Idempotent — calling twice throws via
 * the registry's duplicate-id refusal. Callers in app boot paths
 * should call `registerGoSandboxImage()` once.
 */
export function registerGoSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: GO_IMAGE_ID,
    image: GO_IMAGE_REF,
    defaultEntrypoint: GO_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: GO_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: GO_COLD_START_BUDGET_MS,
    },
    description:
      "Go 1.23 alpine — snippet mode via `go run -`; compiled-binary mode for mounted projects.",
  });
}
