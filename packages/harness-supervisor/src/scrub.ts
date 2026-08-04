/**
 * The captured-output secret scrubber.
 *
 * A daemon's log is written by the CHILD straight into a file descriptor, so
 * nothing can be masked at write time. And harness logs quote credentials
 * routinely: MCP servers echo their argv at boot, provider SDKs put the
 * offending key in the error body, and shell wrappers print their env. The
 * scrubber therefore runs on the READ path — every byte this package hands
 * to a subscriber or persists as an extracted event passes through it.
 *
 * The rule is deliberately narrow and explainable: a value that the
 * harness's own `.env` chain (or the merged spawn env) defines is replaced
 * by `«NAME»`, so the operator still learns WHICH variable the log was
 * talking about. Shape-based masking (`sk-…`-looking strings that are in no
 * env file) is a separate concern owned by the serving layer;
 * {@link composeScrubbers} chains the two without either knowing about the
 * other.
 */

/** Rewrites one chunk of captured output. */
export type Scrubber = (text: string) => string;

/** Values shorter than this are never scrubbed: replacing every occurrence
 *  of a 4-character value would shred the log for no security gain. */
export const MIN_SCRUBBED_VALUE_LENGTH = 8;

/**
 * Variables whose values are operational, not secret, and whose presence in
 * a log is the whole point (a relocated session dir, the port a daemon bound,
 * the trace mode). Scrubbing these would hide exactly the diagnostics the
 * manager exists to show.
 */
export const NON_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "CREWHAUS_TRACE",
  "CREWHAUS_COST_TRACKING",
  "CREWHAUS_SESSION_DIR",
  "CREWHAUS_DATASETS_DIR",
  "CREWHAUS_WATCHME_ROOT",
  "CREWHAUS_SHARED_DIR",
  "CREWHAUS_CONTROL_PORT",
  "CREWHAUS_CONTROL_BIND",
  "CREWHAUS_DEDUP_STORE",
  "CREWHAUS_REGISTRY_ROOT",
  "CREWHAUS_HANGAR_ROOT",
  "PORT",
  "HOST",
  "HOME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "LANG",
  "USER",
  "LOGNAME",
  "NODE_ENV",
  "LOG_LEVEL",
]);

/** Values that carry no secret regardless of the key they sit under. */
const NON_SECRET_VALUE_RE = /^(?:\d+|true|false|null|none|debug|info|warn|error|trace|json)$/i;

export type EnvScrubberOptions = {
  readonly minLength?: number;
  /** Extra variable names to leave alone. */
  readonly allowKeys?: Iterable<string>;
  /** Placeholder builder; defaults to `«NAME»`. */
  readonly placeholder?: (name: string) => string;
};

/**
 * Build a scrubber over a set of environment variables — pass the MERGED
 * spawn env so a key exported by the manager is caught as surely as one from
 * the harness `.env` file.
 *
 * Values are replaced longest-first: when two variables share a prefix (an
 * account id embedded in a token, say), the longer match must win or the
 * remainder of the longer value would survive in the output.
 */
export function createEnvScrubber(
  vars: Readonly<Record<string, string | undefined>>,
  options: EnvScrubberOptions = {},
): Scrubber {
  const minLength = options.minLength ?? MIN_SCRUBBED_VALUE_LENGTH;
  const placeholder = options.placeholder ?? ((name: string) => `«${name}»`);
  const allow = new Set<string>(NON_SECRET_ENV_KEYS);
  for (const k of options.allowKeys ?? []) allow.add(k);

  const pairs: Array<{ value: string; token: string }> = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    if (allow.has(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length < minLength) continue;
    if (NON_SECRET_VALUE_RE.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    pairs.push({ value: trimmed, token: placeholder(name) });
  }
  pairs.sort((a, b) => b.value.length - a.value.length);
  if (pairs.length === 0) return (text) => text;

  return (text: string): string => {
    let out = text;
    for (const { value, token } of pairs) {
      if (out.includes(value)) out = out.split(value).join(token);
    }
    return out;
  };
}

/**
 * The env-variable NAMES `createEnvScrubber` would actually scrub for a given
 * env — i.e. those whose value is long enough, not allow-listed, and not
 * obviously non-secret.
 *
 * Persisted (names only) in the runfile so a manager that ADOPTS a running
 * daemon can rebuild an equivalent scrubber instead of falling back to the
 * harness `.env` chain alone and leaking `process.env`-sourced secrets into
 * the durable events file.
 */
export function scrubbableEnvKeys(
  vars: Readonly<Record<string, string | undefined>>,
  options: EnvScrubberOptions = {},
): string[] {
  const minLength = options.minLength ?? MIN_SCRUBBED_VALUE_LENGTH;
  const allow = new Set<string>(NON_SECRET_ENV_KEYS);
  for (const k of options.allowKeys ?? []) allow.add(k);
  const keys: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;
    if (allow.has(name)) continue;
    const trimmed = value.trim();
    if (trimmed.length < minLength) continue;
    if (NON_SECRET_VALUE_RE.test(trimmed)) continue;
    keys.push(name);
  }
  return keys.sort();
}

/** Chain scrubbers left to right; the identity scrubber when empty. */
export function composeScrubbers(...scrubbers: readonly Scrubber[]): Scrubber {
  const active = scrubbers.filter((s) => typeof s === "function");
  if (active.length === 0) return (text) => text;
  if (active.length === 1) return active[0] as Scrubber;
  return (text: string) => active.reduce((acc, s) => s(acc), text);
}

/** A scrubber that changes nothing — the explicit default. */
export const noopScrubber: Scrubber = (text) => text;

/**
 * Apply a scrubber to every string inside a parsed TraceEvent (keys are
 * structural and left alone; values at any depth are scrubbed). A provider
 * error carrying a key lands in an event payload just as easily as in prose,
 * so the durable event file gets the same treatment as the console.
 */
export function scrubDeep(value: unknown, scrub: Scrubber): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, scrub);
    }
    return out;
  }
  return value;
}
