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
import { readFileSync, realpathSync } from "node:fs";
import {
  type EnvFileRef,
  buildSpawnEnv,
  dotenvAssignedNames,
  loadEnvChain,
} from "./spawn-contracts";

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

/**
 * Where a harness's spawn would take `name` from: `process` when the process environment
 * sets it (any value, empty included: it wins over the chain in a spawn), else the real
 * path of the last present chain file that assigns it (later files win), else
 * `undefined`. Names only: a value is never returned, and a file is read only for the
 * names it assigns.
 */
export function envNameSource(
  harnessDir: string,
  name: string,
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): { readonly file: string } | "process" | undefined {
  if (typeof processEnv[name] === "string") return "process";
  const refs = readHarnessEnvFiles(harnessDir).refs;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i] as EnvFileRef;
    if (!ref.present) continue;
    let text: string;
    try {
      text = readFileSync(ref.path, "utf8");
    } catch {
      continue;
    }
    if (!dotenvAssignedNames(text).has(name)) continue;
    try {
      return { file: realpathSync(ref.path) };
    } catch {
      return { file: ref.path };
    }
  }
  return undefined;
}

/**
 * What a reader of a harness's records asks of its env chain, as one object: the folded
 * names and values (the sessions folder may be relocated there) and where a name is set.
 * Home and `crewhaus inbox` both build the attention fold's facts with it, so the two
 * group failed runs by the same credential source.
 */
export function harnessEnvFacts(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
): {
  envVars(dir: string): Readonly<Record<string, string | undefined>>;
  envNameSource(dir: string, name: string): { readonly file: string } | "process" | undefined;
} {
  return {
    envVars: (dir) => readHarnessEnvFiles(dir).vars,
    envNameSource: (dir, name) => envNameSource(dir, name, processEnv),
  };
}
