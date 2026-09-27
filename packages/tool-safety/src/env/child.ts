/**
 * The environment for a child process that runs a program this process did
 * not choose: a project's linter (`node_modules/.bin/eslint` and the
 * `eslint.config.js` it loads), `cargo clippy` compiling a `build.rs`, a
 * `git` whose repository config names a helper. Such a program reads its
 * whole environment, so a provider key in the harness's environment is a key
 * handed to the repository's code.
 *
 * This is the lighter of the two child-environment disciplines in the repo.
 * An allow-list (tool-proc's `buildSpawnEnv`, tool-fleet's `spawnEnv`) forwards
 * only what the caller names, and suits a command the caller wrote. A
 * toolchain is different: rustup, cargo, go, a Python venv, a proxy and a
 * private CA certificate each need variables no fixed list can name. So this
 * keeps everything EXCEPT what holds a credential: a credential-shaped name
 * ({@link isCredentialShapedName} — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`,
 * `PGPASSWORD`, `DATABASE_URL`, `SSH_AUTH_SOCK` …), a value that is a
 * single token in a known secret format (`sk-…`, `ghp_…`, a JWT, an AWS key
 * id) under any name, a value holding a URL with a credential in it
 * (`PIP_INDEX_URL=https://bot:pypi-…@host`, `HTTPS_PROXY=http://u:pw@proxy`,
 * a `?token=` parameter — judged by the same scrubber results go through,
 * so a user name alone in a URL counts), or an HTTP authorization value
 * (`Bearer …`, `Authorization: Basic …`).
 *
 * git's environment config (`GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>`) is handled as one unit, because git refuses to
 * start when a pair the count promises is missing: a pair is dropped only
 * when it holds a credential (an `http.extraHeader`, a `credential.*` key, a
 * credential-shaped value), the rest are renumbered and the count set to
 * match. `safe.directory` passed that way keeps working.
 *
 * It is defence in depth, not a sandbox: the child can still read a `.env`
 * on disk. What it removes is the credential the harness itself was given.
 */
import { isCredentialShapedName, looksLikePastedSecret } from "./names";
import { redactUrlCredentialsInText } from "./redact";

/** Names every child keeps whatever they hold: without them almost nothing runs. */
const ALWAYS_KEPT: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "PWD",
]);

/**
 * Whether a VALUE is a secret on its face: one token in a known format.
 * A value with a path separator, a colon or whitespace is a path list, a URL
 * or prose, never a pasted token, and is kept — `looksLikePastedSecret`'s
 * "long mixed-case string" rule would otherwise take `PATH` for a secret.
 */
function isSecretShapedValue(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // `/`, `\`, `:`, space, tab, newline, carriage return
    if (c === 47 || c === 92 || c === 58 || c === 32 || c === 9 || c === 10 || c === 13) {
      return false;
    }
  }
  return looksLikePastedSecret(value);
}

/**
 * Whether a value holds a URL with a credential in it: userinfo, or a
 * credential-named query or fragment parameter. The test is "would the
 * shared scrubber change it", so this and every scrubbed result agree.
 */
function carriesUrlCredential(value: string): boolean {
  if (!value.includes("://")) return false;
  return redactUrlCredentialsInText(value) !== value;
}

/** `Bearer …` or `Basic …`, or any scheme after an `Authorization:` header name. */
const AUTHORIZATION_VALUE_RE =
  /^\s*(?:(?:proxy-)?authorization\s*:\s*[A-Za-z-]+|bearer|basic)\s+\S{8,}/i;

/** Whether a value holds a credential, whatever its variable is called. */
function isCredentialValue(value: string): boolean {
  return (
    isSecretShapedValue(value) || carriesUrlCredential(value) || AUTHORIZATION_VALUE_RE.test(value)
  );
}

const GIT_CONFIG_PAIR_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

/**
 * Whether a config pair passed through git's environment holds a
 * credential: `http.<url>.extraHeader` (how CI hands git an auth header),
 * any `credential.*` key (a helper can be an inline script with a token in
 * it), a credential-shaped key, or a credential-shaped value.
 */
function isCredentialConfigPair(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.endsWith(".extraheader") ||
    lower.startsWith("credential.") ||
    isCredentialShapedName(key) ||
    isCredentialValue(value)
  );
}

/**
 * git's `GIT_CONFIG_COUNT` family, without the pairs that hold a credential
 * and renumbered so the count still matches: git aborts ("missing config
 * key GIT_CONFIG_KEY_0") when a promised pair is absent, which is what a
 * name-by-name filter did, since `KEY` marks a credential-shaped name.
 */
function gitConfigFamily(
  parent: Readonly<Record<string, string | undefined>>,
  removed: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const familyNames = Object.keys(parent).filter(
    (name) =>
      parent[name] !== undefined && (name === "GIT_CONFIG_COUNT" || GIT_CONFIG_PAIR_RE.test(name)),
  );
  if (familyNames.length === 0) return out;
  const countText = parent["GIT_CONFIG_COUNT"];
  const count =
    countText !== undefined && /^\d{1,6}$/.test(countText.trim())
      ? Number.parseInt(countText.trim(), 10)
      : undefined;
  if (count === undefined) {
    // No count, or one git would reject: nothing here is config git reads.
    removed.push(...familyNames);
    return out;
  }
  const used = new Set<string>(["GIT_CONFIG_COUNT"]);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const keyName = `GIT_CONFIG_KEY_${i}`;
    const valueName = `GIT_CONFIG_VALUE_${i}`;
    const key = parent[keyName];
    const value = parent[valueName];
    used.add(keyName);
    used.add(valueName);
    if (key === undefined || value === undefined || isCredentialConfigPair(key, value)) {
      if (key !== undefined) removed.push(keyName);
      if (value !== undefined) removed.push(valueName);
      continue;
    }
    out[`GIT_CONFIG_KEY_${kept}`] = key;
    out[`GIT_CONFIG_VALUE_${kept}`] = value;
    kept += 1;
  }
  // Pairs past the count are ones git never reads.
  for (const name of familyNames) if (!used.has(name)) removed.push(name);
  if (kept > 0) out["GIT_CONFIG_COUNT"] = String(kept);
  else removed.push("GIT_CONFIG_COUNT");
  return out;
}

export type CredentialFreeEnv = {
  /** The environment to hand the child. */
  readonly env: Record<string, string>;
  /** The names left out, sorted — for a test or a log line; never the values. */
  readonly removed: ReadonlyArray<string>;
};

/**
 * `parent` without the variables that hold a credential, by name or by value
 * shape. `set` is applied afterwards and wins, so a caller's pinned values
 * (`CI=1`, `LC_ALL=C`) always reach the child.
 */
export function withoutCredentials(
  parent: Readonly<Record<string, string | undefined>>,
  set: Readonly<Record<string, string>> = {},
): CredentialFreeEnv {
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name === "GIT_CONFIG_COUNT" || GIT_CONFIG_PAIR_RE.test(name)) continue;
    if (!ALWAYS_KEPT.has(name) && (isCredentialShapedName(name) || isCredentialValue(value))) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }
  Object.assign(env, gitConfigFamily(parent, removed));
  for (const [name, value] of Object.entries(set)) env[name] = value;
  return { env, removed: [...new Set(removed)].sort() };
}
