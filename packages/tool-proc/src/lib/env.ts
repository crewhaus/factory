/**
 * Environment handling for spawned processes.
 *
 * Two rules drive everything here.
 *
 * 1. A spawned command does NOT inherit this process's environment. The
 *    harness environment holds API keys, tokens and cloud credentials, and
 *    handing all of them to every `ls` is an exfiltration channel nobody
 *    asked for. The caller names what it wants forwarded.
 * 2. What is left is pinned for determinism: `LC_ALL`/`LANG` fix collation
 *    and message language, `TZ` fixes any timestamp the program prints.
 *    Without those, the same command produces different bytes on two
 *    machines that differ only in locale.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/** PATH used when the parent has none — enough to find the system tools. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type SpawnEnvResult = {
  /** The environment to hand the child, key-sorted so it is stable. */
  readonly env: Record<string, string>;
  /** Names the caller asked to forward that the parent does not define. */
  readonly missing: readonly string[];
  /** Names rejected as not being environment-variable names at all. */
  readonly invalid: readonly string[];
};

export function buildSpawnEnv(
  parent: Readonly<Record<string, string | undefined>>,
  options: {
    readonly forward?: readonly string[];
    readonly set?: Readonly<Record<string, string>>;
  } = {},
): SpawnEnvResult {
  const out = new Map<string, string>();
  // The deterministic floor. PATH and HOME are forwarded because almost no
  // real command works without them; everything else must be asked for.
  out.set("PATH", parent["PATH"] ?? FALLBACK_PATH);
  const home = parent["HOME"];
  if (home !== undefined) out.set("HOME", home);
  out.set("LC_ALL", "C");
  out.set("LANG", "C");
  out.set("TZ", "UTC");

  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of options.forward ?? []) {
    if (!isValidEnvName(name)) {
      invalid.push(name);
      continue;
    }
    const value = parent[name];
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    out.set(name, value);
  }
  for (const [name, value] of Object.entries(options.set ?? {})) {
    if (!isValidEnvName(name)) {
      invalid.push(name);
      continue;
    }
    out.set(name, value);
  }

  const env: Record<string, string> = {};
  for (const name of [...out.keys()].sort()) env[name] = out.get(name) as string;
  return { env, missing, invalid };
}

/** One variable as EnvInspect reports it. `value` is present only for names
 *  the caller explicitly asked to reveal. */
export type EnvView = {
  readonly name: string;
  readonly present: boolean;
  readonly chars: number;
  readonly value?: string;
};

/**
 * Inspect named variables and nothing else. There is deliberately no way to
 * enumerate the environment: a caller must know the name to learn anything,
 * and learns only whether it is set and how long it is unless it names the
 * variable in `reveal`.
 */
export function inspectEnv(
  parent: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
  reveal: readonly string[] = [],
): { readonly views: EnvView[]; readonly invalid: readonly string[] } {
  const revealSet = new Set(reveal);
  const invalid: string[] = [];
  const views: EnvView[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!isValidEnvName(name)) {
      invalid.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const value = parent[name];
    const base = {
      name,
      present: value !== undefined,
      chars: value === undefined ? 0 : value.length,
    };
    views.push(value !== undefined && revealSet.has(name) ? { ...base, value } : base);
  }
  // Sorted by name so two calls with the same names in a different order
  // return the same bytes.
  views.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { views, invalid };
}
