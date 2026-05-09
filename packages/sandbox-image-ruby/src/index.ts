import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-ruby` — Section 36 polyglot Ruby sandbox image.
 *
 * Snippet mode (default entrypoint): `ruby -e <code>` reads the snippet
 * from the next argv slot. Advanced callers who mount a project can
 * exec `ruby <file>.rb` after a bundler install.
 *
 * Cold-start budget: ≤500ms for the shell-shape interpreter warm pool —
 * Ruby 3.3 with YJIT enabled boots in ~150ms on warm hosts. The kickoff
 * prompt assigns shell-shape interpreters the tighter 500ms budget; Ruby
 * sits in that bucket because each snippet exec is a fresh ruby process,
 * not a recompile-and-link round-trip like Go/Rust/Java.
 *
 * Layer R8.
 */

export const RUBY_IMAGE_ID = "ruby";
export const RUBY_IMAGE_REF = "ruby:3.3-alpine";
export const RUBY_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["ruby", "-e"];
export const RUBY_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["ruby", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const RUBY_COLD_START_BUDGET_MS = 500;

export function registerRubySandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: RUBY_IMAGE_ID,
    image: RUBY_IMAGE_REF,
    defaultEntrypoint: RUBY_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: RUBY_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: RUBY_COLD_START_BUDGET_MS,
    },
    description:
      "Ruby 3.3 alpine (YJIT enabled) — snippet mode via `ruby -e`; bundler-aware mode for mounted gems.",
  });
}
