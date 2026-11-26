/**
 * Git for the managed clone: every call through `@crewhaus/tool-git/run`, with the repository
 * named explicitly and an environment nothing inherited can steer.
 *
 * - **One credential mechanism.** {@link networkGitEnv} is the only way a token reaches git:
 *   one `http.<origin>/.extraheader` entry in the environment of the one child that talks to
 *   the code host (a fetch, the remote-head read before a push, and a push), for that
 *   origin only. Never argv, never a URL, never a config file. Askpass is not used, and no
 *   credential helper runs.
 * - **Nothing inherited.** Every inherited `GIT_*` variable is left out, and so is the
 *   variable that holds the token and everything credential-shaped. The machine's own git
 *   configuration is not read: what a run does depends on the arguments here alone.
 * - **No program the repository supplies.** Hooks are off on every call, no transport is
 *   allowed but https (http for an admitted loopback host), redirects are refused, and
 *   submodules and external diff drivers are off.
 * - **The clone's own configuration is git's.** Before a call that carries the token, the
 *   managed clone's config file is read: a key `git init` did not write refuses the call.
 * - **The repository is named.** The bare clone by `--git-dir`, a worktree by its own
 *   administrative directory and `--work-tree`, so a `.git` file inside a worktree is never
 *   what git reads.
 */
import { basename, join } from "node:path";
import { type GitRun, NO_HOOKS_PATH, type runGit } from "@crewhaus/tool-git/run";

/** The runner, as a seam: tests record every argv and environment it is given. */
export type GitPort = typeof runGit;

/** How long a local git step may take. */
export const LOCAL_TIMEOUT_MS = 120_000;
/** How long a fetch or a push may take. */
export const NETWORK_TIMEOUT_MS = 300_000;
/** The most of a diff that is read back, in characters. */
export const DIFF_MAX_CHARS = 8_000_000;

/** A full SHA-1 or SHA-256 object name. */
export const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The environment entries that hand one token to one git process for one origin, and nothing
 * else. Clone, fetch and push use it; so does anything else that reads a repository with the
 * same credential.
 */
export function networkGitEnv(origin: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

/** Switches every call carries. */
const BASE_CONFIG: readonly string[] = [
  `core.hooksPath=${NO_HOOKS_PATH}`,
  "core.excludesFile=/dev/null",
  "core.attributesFile=/dev/null",
  "core.askPass=",
  "core.autocrlf=false",
  "credential.helper=",
  "commit.gpgSign=false",
  "gc.auto=0",
  "maintenance.auto=false",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "http.followRedirects=false",
  "protocol.allow=never",
];

export type NetworkGit = {
  readonly origin: string;
  /** An admitted loopback host may be plain http. */
  readonly loopback: boolean;
  readonly token: string;
};

export type GitCall = {
  readonly args: readonly string[];
  /** Absolute. The bare clone; absent only for the step that makes it, which names `cwd`. */
  readonly repoDir?: string;
  readonly cwd?: string;
  /** Absolute. Set for a step in a worktree. */
  readonly worktree?: string;
  /** A call that talks to the code host. */
  readonly network?: NetworkGit;
  readonly identity?: string;
  /** A commit's author and committer date, so the same tree on the same base is the same commit. */
  readonly date?: string;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
};

export type GitContext = {
  readonly run: GitPort;
  /** The variable the token is read from: never handed to a child. */
  readonly tokenEnv?: string;
  /** The environment whose `GIT_*` names are dropped; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** A name git accepts in an identity: plain, bounded, never empty. */
function identityName(raw: string | undefined): string {
  const name = (raw ?? "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .trim()
    .slice(0, 64);
  return name === "" ? "crewhaus" : name;
}

/** Run one git step. The repository is always named; the child gets only what is pinned here. */
export function git(ctx: GitContext, call: GitCall): Promise<GitRun> {
  const config = [...BASE_CONFIG];
  if (call.network !== undefined) {
    config.push(
      "protocol.https.allow=always",
      ...(call.network.loopback ? ["protocol.http.allow=always"] : []),
    );
  }
  const env = ctx.env ?? process.env;
  const dropNames = [
    ...Object.keys(env).filter((name) => name.startsWith("GIT_")),
    ...(ctx.tokenEnv !== undefined ? [ctx.tokenEnv] : []),
  ];
  const name = identityName(call.identity);
  const { repoDir, worktree } = call;
  const where =
    repoDir === undefined
      ? []
      : worktree === undefined
        ? [`--git-dir=${repoDir}`]
        : [`--git-dir=${worktreeAdminDir(repoDir, worktree)}`, `--work-tree=${worktree}`];
  return ctx.run([...where, ...call.args], {
    cwd: worktree ?? repoDir ?? call.cwd ?? ".",
    timeoutMs:
      call.timeoutMs ?? (call.network !== undefined ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
    configArgs: config.flatMap((pair) => ["-c", pair]),
    isolatedEnv: { dropNames },
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@crewhaus.invalid`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@crewhaus.invalid`,
      ...(call.date !== undefined
        ? { GIT_AUTHOR_DATE: call.date, GIT_COMMITTER_DATE: call.date }
        : {}),
      ...(call.network !== undefined ? networkGitEnv(call.network.origin, call.network.token) : {}),
    },
    ...(call.stdin !== undefined ? { stdin: call.stdin } : {}),
    ...(call.signal !== undefined ? { signal: call.signal } : {}),
    ...(call.maxOutputChars !== undefined ? { maxOutputChars: call.maxOutputChars } : {}),
  });
}

/** A worktree's administrative directory in the bare clone: named after the worktree's own. */
export function worktreeAdminDir(repoDir: string, worktree: string): string {
  return join(repoDir, "worktrees", basename(worktree));
}

/** Whether a git version line is 2.38 or newer. */
export function gitIsRecent(version: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 38);
}

/**
 * The keys a managed clone's own configuration may hold: the ones `git init --bare` writes,
 * and the hooks path, which every call here overrides.
 */
const CLONE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.logallrefupdates",
  "core.hookspath",
  "extensions.objectformat",
  "extensions.compatobjectformat",
  "extensions.refstorage",
]);

/** The other keys in a `git config --null --name-only --list`, plain and bounded. */
export function strangeConfigKeys(out: string): string[] {
  const keys = new Set<string>();
  for (const name of out.split("\0")) {
    if (name === "" || CLONE_CONFIG_KEYS.has(name.toLowerCase())) continue;
    // A key's section and its last word: what is between them can be a URL, and is not repeated.
    const parts = name.split(".");
    const plain = `${parts[0] ?? ""}.${parts.length > 1 ? (parts.at(-1) ?? "") : ""}`;
    keys.add(plain.replace(/[^A-Za-z0-9.-]/g, "").slice(0, 60));
  }
  return [...keys].sort();
}

/** Why a network step failed, read from git's own words: the token, the host, or neither. */
export function networkFailure(
  run: GitRun,
): "credential" | "host" | "timeout" | "rejected" | "other" {
  if (run.timedOut) return "timeout";
  const text = `${run.stderr}\n${run.stdout}`;
  if (/stale info|\[rejected\]|non-fast-forward|fetch first/i.test(text)) return "rejected";
  if (
    /Authentication failed|could not read Username|HTTP Basic: Access denied|returned error: 40[13]|Invalid username or (?:password|token)|Permission to .* denied|Repository not found/i.test(
      text,
    )
  ) {
    return "credential";
  }
  if (
    /Could not resolve host|Failed to connect|Connection (?:refused|timed out|reset)|unable to access|SSL|returned error: 5\d\d/i.test(
      text,
    )
  ) {
    return "host";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// The change
// ---------------------------------------------------------------------------

/** One line a change adds. */
export type AddedLine = { readonly file: string; readonly line: number; readonly text: string };

export type DiffStat = { readonly files: number; readonly lines: number };

/**
 * `git diff --numstat -z --no-renames` as counts. A binary file counts as a file and no
 * lines; a name is never read here.
 */
export function parseNumstat(out: string): DiffStat {
  let files = 0;
  let lines = 0;
  for (const entry of out.split("\0")) {
    if (entry === "") continue;
    const [added, deleted] = entry.split("\t");
    files += 1;
    for (const n of [added, deleted]) {
      const value = Number.parseInt(n ?? "", 10);
      if (Number.isFinite(value)) lines += value;
    }
  }
  return { files, lines };
}

/**
 * The lines a `git diff --unified=0 --no-color --text` adds, with the file each is in and
 * its line there. A hunk is read by its own counts, so a removed or added line that looks
 * like a header is still content.
 */
export function parseAddedLines(diff: string): readonly AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let next = 0;
  let addLeft = 0;
  let delLeft = 0;
  for (const raw of diff.split("\n")) {
    if (addLeft > 0 || delLeft > 0) {
      if (raw.startsWith("+") && addLeft > 0) {
        out.push({ file, line: next, text: raw.slice(1) });
        next += 1;
        addLeft -= 1;
        continue;
      }
      if (raw.startsWith("-") && delLeft > 0) {
        delLeft -= 1;
        continue;
      }
      if (raw.startsWith("\\")) continue;
      addLeft = 0;
      delLeft = 0;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk !== null) {
      delLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      next = Number(hunk[2]);
      addLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const name = raw.slice(4).replace(/\t$/, "");
      file = name === "/dev/null" ? "" : name.replace(/^b\//, "");
    }
  }
  return out;
}
