/**
 * The env-chain area: WHICH files the merged spawn env was built from.
 *
 * Preflight's whole promise is "the env I checked is the env the spawn
 * gets". That promise is only auditable if the operator can see the chain,
 * and the chain stopped being obvious the moment a fleet could point several
 * harnesses at one shared file: a key that resolves from `../.env` looks
 * exactly like a key that resolves from nowhere until something reports the
 * file. So the caller — the supervisor's gate, which owns the merge — hands
 * the resolved chain in, and this area renders it.
 *
 * Two levels, and only two:
 *
 *   - `info` for every file that was read, shared ones named with their
 *     resolved absolute path (a relative declaration is meaningless without
 *     the root it resolved against);
 *   - `warn` for a SHARED file that was declared and is not there. Not
 *     blocking: a harness whose keys are already in `process.env` starts
 *     fine without it, and the credentials area is what actually refuses a
 *     missing key. But never silent — a declared-and-absent shared file is
 *     precisely the failure the declaration exists to make visible (the
 *     dangling `.env → ../.env` symlink a copied harness used to carry).
 *
 * This package never reads the chain itself: it has no opinion about where
 * a harness keeps its env files, and `loadEnvChain` lives a layer above it.
 */
import type { PreflightItem } from "./types";

/** One file in the resolved env chain. Mirrors `EnvFileRef` from
 *  `@crewhaus/harness-supervisor`, structurally — this package sits UNDER
 *  the supervisor and cannot import from it. */
export type EnvChainFile = {
  /** As declared: `.env`, or a `manager.envFiles` entry like `../.env`. */
  readonly declaredAs: string;
  /** Resolved absolute path. */
  readonly path: string;
  readonly scope: "shared" | "harness";
  readonly present: boolean;
};

/** Report the env chain the merged spawn env was built from, lowest
 *  precedence first. Pure. */
export function envChainItems(files: readonly EnvChainFile[]): PreflightItem[] {
  const items: PreflightItem[] = [];
  files.forEach((file, index) => {
    if (file.scope === "shared" && !file.present) {
      items.push({
        id: `env.shared-missing.${index}`,
        area: "env",
        level: "warn",
        message: `shared env file "${file.declaredAs}" is declared in .crewhaus/settings.json but is not readable at ${file.path}`,
        remediation:
          "create the file, fix the path, or drop the entry from `manager.envFiles` — every key it would have supplied must come from process.env instead",
      });
      return;
    }
    items.push({
      id: `env.file.${index}`,
      area: "env",
      level: "info",
      message:
        file.scope === "shared"
          ? `shared env file "${file.declaredAs}" → ${file.path} (merged UNDER the harness-local chain)`
          : `harness env file ${file.declaredAs}`,
    });
  });
  return items;
}
