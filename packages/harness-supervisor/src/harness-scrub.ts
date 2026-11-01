/**
 * The two env scrubbers a reader of a harness's captured output builds: one
 * from the harness's own `.env` chain, and one from the merged spawn env the
 * live pump scrubbed with.
 *
 * They moved here from `@crewhaus/hangar-server`, which still re-exports
 * them for one release, so `crewhaus daemon logs` can scrub without depending
 * on the HTTP server. Shape-based masking stays with the serving layer (see
 * `scrub.ts`); these know VALUES only.
 */
import { mergedSpawnEnv } from "./env-file";
import { type Scrubber, createEnvScrubber } from "./scrub";
import { loadEnvChain } from "./spawn-contracts";

/** A scrubber built from the harness's own `.env` chain — the supervisor's
 *  fallback default, and the weakest of the two. Kept exported because an
 *  adopted run's spawn env was never built by this process; prefer
 *  {@link spawnEnvScrubber}, which is a strict superset of it. */
export function harnessScrubber(harnessDir: string): Scrubber {
  return createEnvScrubber(loadEnvChain(harnessDir).vars);
}

/**
 * The scrubber the LIVE pump runs: the harness `.env` chain UNDER the
 * manager's own environment — `buildSpawnEnv`'s precedence, via the same
 * function the spawn plan uses. Serving history with anything weaker means a
 * key exported in the shell that launched the manager is `«KEY»` in the live
 * `output` frame and verbatim in the `replay` frame of the same stream.
 */
export function spawnEnvScrubber(
  harnessDir: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Scrubber {
  return createEnvScrubber(mergedSpawnEnv(processEnv, harnessDir).env);
}
