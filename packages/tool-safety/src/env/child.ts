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
 * `PGPASSWORD`, `DATABASE_URL`, `SSH_AUTH_SOCK` …), or a value that is a
 * single token in a known secret format (`sk-…`, `ghp_…`, a JWT, an AWS key
 * id) under any name.
 *
 * It is defence in depth, not a sandbox: the child can still read a `.env`
 * on disk. What it removes is the credential the harness itself was given.
 */
import { isCredentialShapedName, looksLikePastedSecret } from "./names";

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
    if (!ALWAYS_KEPT.has(name) && (isCredentialShapedName(name) || isSecretShapedValue(value))) {
      removed.push(name);
      continue;
    }
    env[name] = value;
  }
  for (const [name, value] of Object.entries(set)) env[name] = value;
  return { env, removed: removed.sort() };
}
