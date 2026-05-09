import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-rust` — Section 36 polyglot Rust sandbox image.
 *
 * Registers a curated Rust stable image into `@crewhaus/sandbox-image-registry`
 * so polyglot agents can `lookupSandboxImage("rust")` and route a snippet
 * through `tool-code-execution`'s sandbox path.
 *
 * Snippet mode (default entrypoint): `rustc - -o /tmp/snippet && /tmp/snippet`
 * is the cargo-script-style pattern. Advanced callers who mount a project
 * exec their own compiled binary path. We keep the registered entrypoint
 * short — `["rustc", "-"]` — and let `tool-code-execution` extend it with
 * the snippet text + post-compile exec at call time.
 *
 * Cold-start budget: ≤2s for the compiled-language warm pool. Rust's
 * `rustc --version` healthcheck is a single binary invocation and stays
 * well under the budget. The actual compile-and-run round-trip can take
 * longer; tool-code-execution callers may pass a higher timeoutMs.
 *
 * Layer R8.
 */

export const RUST_IMAGE_ID = "rust";
export const RUST_IMAGE_REF = "rust:1-alpine";
export const RUST_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["rustc", "-"];
export const RUST_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["rustc", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const RUST_COLD_START_BUDGET_MS = 2_000;

/** Idempotent — calling twice throws via the registry's duplicate-id refusal. */
export function registerRustSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: RUST_IMAGE_ID,
    image: RUST_IMAGE_REF,
    defaultEntrypoint: RUST_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: RUST_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: RUST_COLD_START_BUDGET_MS,
    },
    description:
      "Rust stable on alpine — snippet mode via `rustc -`; compiled-binary mode for mounted crates.",
  });
}
