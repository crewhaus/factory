/**
 * Tolerant `.env` handling. The server reads a harness's env file(s) for two
 * purposes only: (1) building the MERGED environment a spawn from that
 * harness dir would receive — the harness chain UNDER the process env, the
 * precedence `buildSpawnPlan` uses, which preflight checks run against — and
 * (2) reporting KEY presence booleans. Raw values never leave the server —
 * no route serializes them, and the masking tests enforce that byte-level.
 */
import { type EnvFileRef, buildSpawnEnv, loadEnvChain } from "@crewhaus/harness-supervisor";

/**
 * Parse dotenv text — the supervisor's parser, re-exported rather than
 * reimplemented.
 *
 * It used to be a verbatim copy, and the copy is exactly what let a bug live
 * in two places: both readers stripped surrounding quotes without reversing
 * the `\\`/`\"` escapes the writer emits, so a value containing either came
 * back altered. Worse than the bug itself, a second reader can disagree with
 * the one that builds the spawn environment — the server would report one
 * value and the child would receive another. One implementation makes that
 * class of drift impossible.
 */
export { parseEnvText } from "@crewhaus/harness-supervisor";

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
 * is now exactly ONE encoding of the precedence, and the pin in
 * `env-precedence.test.ts` fails if the two ever diverge again.
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
