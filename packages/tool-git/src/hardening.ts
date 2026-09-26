/**
 * What keeps a READ a read: the repository's own config cannot make git run
 * a program.
 *
 * git runs programs its config names, and the repository's own config
 * (`.git/config`, a worktree's `config.worktree`, anything either includes)
 * is as much the repository's as its files are. A checkout that arrives with
 * its `.git` intact — an archive, a copied project, a shared volume, an
 * earlier approved write — or an embedded repository directory committed
 * inside another one, can therefore make `git status` run code. Plan and
 * auto mode run the read-only git tools without asking, so each of these was
 * code execution from a read (C007: security-9#0, flag-truth-2#1,
 * flag-truth-5#2):
 *
 *   - `core.fsmonitor`: a hook git runs on every index refresh (status, diff).
 *   - `diff.<driver>.textconv`: a converter git runs on each blob a diff,
 *     show, log -p or blame prints, and which drags the file through its
 *     smudge filter to do it.
 *   - `diff.<driver>.command` / `diff.external`: an external diff program.
 *   - `filter.<driver>.clean` / `.process`: run on every tracked file whose
 *     stat data changed, by status, diff and blame of the working tree.
 *   - `gpg.program` with `log.showSignature`: run by log and show.
 *   - an embedded bare repository (`evil/HEAD`, `evil/config`, `evil/objects`)
 *     committed into a normal one: running git INSIDE it uses its config.
 *     This one needs nothing but a clone.
 *
 * What this module does about each, and what it costs:
 *
 *   - Every invocation: `core.fsmonitor=false` (an optimisation, so turning
 *     it off changes no answer), `log.showSignature=false` (no format here
 *     uses `%G`), and `safe.bareRepository=explicit`, which makes git refuse
 *     a repository directory it found by being run inside one.
 *   - Every diff-producing read (diff, show, log, blame): `--no-ext-diff
 *     --no-textconv`. A binary file that a repository's textconv would have
 *     rendered as text is reported as binary.
 *   - status and diff reads: `--ignore-submodules=dirty`. git examines a
 *     submodule's working tree by running git INSIDE it, under the
 *     submodule's own config; that is another repository, whose filters this
 *     read did not vet. A submodule's new commits are still reported; point
 *     `cwd` at the submodule to see its working tree.
 *   - Every invocation: `diff.submodule=short`. With the repository's own
 *     `diff.submodule=diff`, a diff, show or log that crosses a submodule
 *     pointer runs a child `git diff` INSIDE the submodule, under the
 *     submodule's config, and git passes that child neither `--no-ext-diff`
 *     nor `--no-textconv`: the submodule's `diff.external` or textconv ran
 *     from a read. `short` prints the pointer change (`Submodule sub
 *     abc..def`) and spawns nothing.
 *   - blame reads: `--no-ignore-revs-file`. `blame.ignoreRevsFile` names a
 *     file anywhere on the disk, and git quotes a line it cannot parse back
 *     in its error: a repository's config could have a read echo the first
 *     line of a file outside the workspace. `-c blame.ignoreRevsFile=` does
 *     not clear it (git applies the reset before the repository's value);
 *     the flag does. A reader who wants those revisions skipped passes them
 *     as `ref` ranges instead.
 *   - Every read: `mailmap.file=` (empty). blame maps each author through
 *     the mailmap, and `mailmap.file` names a file anywhere on the disk, so
 *     a line of it shaped `Name <email>` would come back as an author name.
 *     The repository's committed `.mailmap` is still honoured.
 *   - Filters have no global off switch, so each read first lists the
 *     `filter.*` keys the repository's own config sets (`--show-scope`:
 *     `local` and `worktree`; the operator's global and system config are
 *     theirs and trusted), and switches each such driver off for the run.
 *     The one exception is the exact configuration `git lfs install --local`
 *     writes, which runs the `git-lfs` on PATH. A switched-off driver means a
 *     filtered file whose stat data changed can show as modified; the result
 *     says which drivers were switched off.
 *
 * Writes (commit, switch, stash pop, cherry-pick …) keep the repository's
 * filters and hooks: they are destructive tools a person approved, and a
 * commit that skipped a clean filter would store the wrong bytes.
 */

/** `-c` pairs applied to every git invocation, read or write. */
export const HARDENED_CONFIG_ARGS: readonly string[] = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "safe.bareRepository=explicit",
  "-c",
  "diff.submodule=short",
]);

/** `-c` pairs applied to every read-only invocation, after the global ones. */
export const READ_CONFIG_ARGS: readonly string[] = Object.freeze(["-c", "mailmap.file="]);

/** Subcommands whose read-only runs get `--no-ext-diff --no-textconv`. */
const DIFF_PRODUCING: ReadonlySet<string> = new Set(["diff", "show", "log", "blame"]);
/** Subcommands whose read-only runs stay out of submodule working trees. */
const SUBMODULE_RECURSING: ReadonlySet<string> = new Set(["status", "diff"]);

/**
 * The argv of a read-only run with the per-subcommand switches inserted
 * right after the subcommand (so they precede any `--`). Idempotent: a flag
 * the caller already passed is not repeated.
 */
export function hardenReadArgs(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  if (sub === undefined) return [];
  const extra: string[] = [];
  if (DIFF_PRODUCING.has(sub)) extra.push("--no-ext-diff", "--no-textconv");
  if (SUBMODULE_RECURSING.has(sub)) extra.push("--ignore-submodules=dirty");
  if (sub === "blame") extra.push("--no-ignore-revs-file");
  const missing = extra.filter((flag) => !rest.includes(flag));
  return [sub, ...missing, ...rest];
}

/** The argv that lists the `filter.*` keys every config scope sets. */
export const FILTER_PROBE_ARGS: readonly string[] = Object.freeze([
  "config",
  "--show-scope",
  "--null",
  "--get-regexp",
  "^filter\\.",
]);

/**
 * The same for a git older than 2.26, which has no `--show-scope`: the
 * repository's own config file and what it includes, all of it treated as
 * the repository's.
 */
export const FILTER_PROBE_ARGS_LEGACY: readonly string[] = Object.freeze([
  "config",
  "--local",
  "--includes",
  "--null",
  "--get-regexp",
  "^filter\\.",
]);

/** The scopes a repository controls. `command`, `global`, `system` are the operator's. */
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(["local", "worktree"]);

/**
 * The exact values `git lfs install --local` writes (with and without
 * `--skip-smudge`). They run the `git-lfs` on PATH — a program the operator
 * installed — so a repository set up this way keeps working; any other value
 * for the `lfs` driver is switched off like every other driver.
 */
const STANDARD_LFS: Readonly<Record<string, ReadonlySet<string>>> = {
  clean: new Set(["git-lfs clean -- %f"]),
  smudge: new Set(["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"]),
  process: new Set(["git-lfs filter-process", "git-lfs filter-process --skip"]),
  required: new Set(["true"]),
};

export type FilterNeutralisation =
  | {
      readonly ok: true;
      /** `-c` pairs switching the repository's own filter drivers off. */
      readonly configArgs: readonly string[];
      /** The drivers switched off, sorted — `filter.<name>` each. */
      readonly neutralised: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

type ConfigEntry = { readonly scope: string; readonly key: string; readonly value: string | null };

/**
 * Parse `git config [--show-scope] --null --get-regexp` output: records are
 * NUL-terminated; with `--show-scope` each is preceded by a NUL-terminated
 * scope. Within a record, the first newline separates key from value; a key
 * with no newline is an implicit `true`.
 */
export function parseConfigListing(stdout: string, withScope: boolean): ConfigEntry[] {
  const parts = stdout.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  const entries: ConfigEntry[] = [];
  const step = withScope ? 2 : 1;
  for (let i = 0; i + step - 1 < parts.length; i += step) {
    const scope = withScope ? (parts[i] as string) : "local";
    const record = parts[i + step - 1] as string;
    const nl = record.indexOf("\n");
    entries.push(
      nl === -1
        ? { scope, key: record, value: null }
        : { scope, key: record.slice(0, nl), value: record.slice(nl + 1) },
    );
  }
  return entries;
}

/**
 * The `-c` overrides that switch off every filter driver the repository's
 * own config defines, from the probe's output. Refuses a driver name git's
 * `-c` cannot spell (it splits `name=value` at the first `=`).
 */
export function neutraliseRepositoryFilters(
  stdout: string,
  withScope: boolean,
): FilterNeutralisation {
  const byDriver = new Map<string, Map<string, string | null>>();
  for (const entry of parseConfigListing(stdout, withScope)) {
    if (!REPOSITORY_SCOPES.has(entry.scope)) continue;
    // `filter.<name>.<var>`: the section and variable are case-insensitive
    // and printed lower-case; the name is everything between them.
    if (!entry.key.startsWith("filter.")) continue;
    const lastDot = entry.key.lastIndexOf(".");
    if (lastDot <= "filter.".length) continue; // `filter.<var>`: no driver, git ignores it
    const name = entry.key.slice("filter.".length, lastDot);
    const variable = entry.key.slice(lastDot + 1);
    const vars = byDriver.get(name) ?? new Map<string, string | null>();
    vars.set(variable, entry.value);
    byDriver.set(name, vars);
  }
  const configArgs: string[] = [];
  const neutralised: string[] = [];
  for (const name of [...byDriver.keys()].sort()) {
    const vars = byDriver.get(name) as Map<string, string | null>;
    if (name === "lfs" && isStandardLfs(vars)) continue;
    if (["=", "\u0000", "\n", "\r"].some((c) => name.includes(c))) {
      return {
        ok: false,
        reason: `the repository's own config defines a filter driver whose name git's -c cannot switch off (${JSON.stringify(name.slice(0, 60))}), and a read-only tool does not run a program the repository names`,
      };
    }
    configArgs.push(
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    );
    neutralised.push(`filter.${name}`);
  }
  return { ok: true, configArgs, neutralised };
}

function isStandardLfs(vars: ReadonlyMap<string, string | null>): boolean {
  for (const [variable, value] of vars) {
    const allowed = STANDARD_LFS[variable];
    if (allowed === undefined || value === null || !allowed.has(value)) return false;
  }
  return true;
}

/** One sentence for a result, naming the drivers a read switched off. */
export function neutralisedNote(neutralised: readonly string[]): string | undefined {
  if (neutralised.length === 0) return undefined;
  return `this repository's own config names filter programs (${neutralised.join(", ")}); a read-only tool does not run them, so a filtered file whose timestamps changed may show as modified here`;
}
