/**
 * Tolerant `.env` handling. The server reads a harness's env file(s) for two
 * purposes only: (1) building the MERGED environment a spawn from that
 * harness dir would receive — the harness chain UNDER the process env, the
 * precedence `buildSpawnPlan` uses, which preflight checks run against — and
 * (2) reporting KEY presence booleans. Raw values never leave the server —
 * no route serializes them, and the masking tests enforce that byte-level.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpawnEnv } from "@crewhaus/harness-supervisor";

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

/** The harness env-file chain, in precedence order (later wins). */
const ENV_FILENAMES = [".env", ".env.local"] as const;

export type HarnessEnvFiles = {
  /** Folded key → value map across the chain (later files win). */
  readonly vars: Record<string, string>;
  /** Which chain files actually existed, in read order. */
  readonly files: readonly string[];
};

/** Read the harness's own env-file chain from its root dir. */
export function readHarnessEnvFiles(harnessDir: string): HarnessEnvFiles {
  const vars: Record<string, string> = {};
  const files: string[] = [];
  for (const name of ENV_FILENAMES) {
    const path = join(harnessDir, name);
    if (!existsSync(path)) continue;
    try {
      Object.assign(vars, parseEnvText(readFileSync(path, "utf8")));
      files.push(name);
    } catch {
      // unreadable env file — presence checks degrade, never throw
    }
  }
  return { vars, files };
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
): { env: Record<string, string | undefined>; envFiles: readonly string[] } {
  const { env, envFiles } = buildSpawnEnv({ harnessRoot: harnessDir, processEnv: baseEnv });
  return { env, envFiles };
}
