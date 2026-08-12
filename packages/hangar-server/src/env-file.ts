/**
 * Tolerant `.env` handling. The server reads a harness's env file(s) for two
 * purposes only: (1) building the MERGED environment a spawn from that
 * harness dir would receive — the harness chain UNDER the process env, the
 * precedence `buildSpawnPlan` uses, which preflight checks run against — and
 * (2) reporting KEY presence booleans. Raw values never leave the server —
 * no route serializes them, and the masking tests enforce that byte-level.
 */
import { type EnvFileRef, buildSpawnEnv, loadEnvChain } from "@crewhaus/harness-supervisor";

const ENV_LINE_RE = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/** Parse dotenv text: `KEY=VALUE` lines, optional `export `, surrounding
 *  single/double quotes stripped, `#` comment lines skipped, no
 *  interpolation. Malformed lines are ignored, never fatal. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = ENV_LINE_RE.exec(line);
    if (m === null) continue;
    const key = m[1] as string;
    let value = (m[2] ?? "").trim();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
    if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

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
