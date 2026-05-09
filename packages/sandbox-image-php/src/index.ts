import { type SandboxImageEntry, registerSandboxImage } from "@crewhaus/sandbox-image-registry";

/**
 * Catalog R8 `sandbox-image-php` — Section 36 polyglot PHP sandbox image.
 *
 * Snippet mode (default entrypoint): `php -r <code>` reads the snippet
 * from the next argv slot. Advanced callers who mount a project can
 * exec `php <file>.php` after a composer install. Composer 2 is
 * preinstalled into /usr/bin/composer for projects with a
 * composer.json.
 *
 * Cold-start budget: ≤500ms — PHP is a shell-shape interpreter and
 * `php --version` returns in ~50ms warm. The kickoff prompt's
 * tighter shell-shape ≤500ms budget applies.
 *
 * Layer R8.
 */

export const PHP_IMAGE_ID = "php";
export const PHP_IMAGE_REF = "php:8.3-alpine";
export const PHP_DEFAULT_ENTRYPOINT: ReadonlyArray<string> = ["php", "-r"];
export const PHP_HEALTHCHECK_ARGV: ReadonlyArray<string> = ["php", "--version"];

/** Cold-start budget for the warm pool (ms). T7 layer asserts this. */
export const PHP_COLD_START_BUDGET_MS = 500;

export function registerPhpSandboxImage(): SandboxImageEntry {
  return registerSandboxImage({
    id: PHP_IMAGE_ID,
    image: PHP_IMAGE_REF,
    defaultEntrypoint: PHP_DEFAULT_ENTRYPOINT,
    healthcheck: {
      command: PHP_HEALTHCHECK_ARGV,
      expectedExitCode: 0,
      timeoutMs: PHP_COLD_START_BUDGET_MS,
    },
    description:
      "PHP 8.3 alpine — snippet mode via `php -r`; composer 2 preinstalled for mounted projects.",
  });
}
