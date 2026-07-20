/**
 * CLI version resolution, shared by `crewhaus version` (index.ts) and the
 * bundle-manifest dependency pinning every compile emits (bundle-manifest.ts,
 * re-ensured by `--check`). Side-effect-free so it is importable from
 * unit-testable modules (the CLI entry file runs an argv switch on import).
 */
import { readFileSync } from "node:fs";

// Substituted at build time by @crewhaus/single-binary-cli's `bun build
// --compile --define` — standalone binaries have no package.json on disk.
declare const CREWHAUS_EMBEDDED_VERSION: string | undefined;

/**
 * The CLI's own version: the build-time embedded constant when compiled to a
 * standalone binary, else the version in apps/cli/package.json. `undefined`
 * only when neither is available (a broken installation).
 */
export function cliVersion(): string | undefined {
  if (typeof CREWHAUS_EMBEDDED_VERSION === "string") {
    return CREWHAUS_EMBEDDED_VERSION;
  }
  // The package ships src/ directly (bin → src/index.ts) and tsc -b also
  // emits dist/, so resolve package.json relative to this module — one level
  // up lands on apps/cli/package.json from either tree, and on
  // node_modules/crewhaus/package.json when installed.
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
        version: string;
      }
    ).version;
  } catch {
    return undefined;
  }
}
