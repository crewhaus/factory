/**
 * The env-file chain as a manager reads it: the folded chain a harness
 * resolves, and the MERGED environment a spawn from that harness dir would
 * receive — the record preflight checks run against.
 *
 * It sits beside `buildSpawnEnv` and `loadEnvChain` because it IS them, named
 * for the two questions a manager asks. It moved here from
 * `@crewhaus/hangar-server`, which still re-exports it for one release, so
 * that `crewhaus daemon` reaches it without depending on the HTTP server.
 */
import { type EnvFileRef, buildSpawnEnv, loadEnvChain } from "./spawn-contracts";

export type HarnessEnvFiles = {
  /** Folded key → value map across the chain (later files win). */
  readonly vars: Record<string, string>;
  /** Which chain files actually existed, in read order, named as declared. */
  readonly files: readonly string[];
  /** Every file in the chain including declared-but-absent shared ones. */
  readonly refs: readonly EnvFileRef[];
};

/**
 * Read the env-file chain this harness resolves — the shared files
 * `manager.envFiles` declares, then `<harness>/.env`, then `.env.local`.
 *
 * Delegates to `loadEnvChain` rather than walking the two local filenames
 * itself: a console that only looked at the harness-local pair reported
 * "not set" for every key a fleet keeps in its shared file, while the daemon
 * started from that same directory had them the whole time.
 */
export function readHarnessEnvFiles(harnessDir: string): HarnessEnvFiles {
  return loadEnvChain(harnessDir);
}

/**
 * The environment a spawn from this harness dir would actually receive —
 * the record preflight must be evaluated against.
 *
 * PRECEDENCE IS NOT A DETAIL. `buildSpawnPlan` layers the harness `.env`
 * chain **UNDER** `process.env` (an exported variable always wins) and
 * stamps `CREWHAUS_TRACE` / `CREWHAUS_COST_TRACKING`. M1 layered the chain
 * on TOP here, so the console could pass preflight against a value the
 * daemon would never see — "it passed preflight and then died on a missing
 * key", inverted. Rather than restate the rule, this delegates to
 * `buildSpawnEnv`, the same function the plan builds `plan.env` with: there
 * is now exactly ONE encoding of the precedence, and the pins in
 * `env-file.test.ts` here and hangar-server's `env-precedence.test.ts` fail if
 * the two ever diverge again.
 */
export function mergedSpawnEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  harnessDir: string,
): {
  env: Record<string, string | undefined>;
  envFiles: readonly string[];
  envFileRefs: readonly EnvFileRef[];
} {
  const { env, envFiles, envFileRefs } = buildSpawnEnv({
    harnessRoot: harnessDir,
    processEnv: baseEnv,
  });
  return { env, envFiles, envFileRefs };
}
