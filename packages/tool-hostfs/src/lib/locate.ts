/**
 * The Linux backend for `OsIndexSearch`: `plocate`, falling back to `locate`.
 *
 * THE ONE FACT THAT MATTERS HERE, recorded from a real Alpine 3.19 host with
 * plocate 1.1.19 (see `../fixtures.ts`):
 *
 *     $ plocate zzzznotathing ; echo $?
 *     1                         # no output at all, on either stream
 *
 *     $ plocate foo ; echo $?    # with no database built
 *     /var/lib/plocate/plocate.db: No such file or directory   (stderr)
 *     1
 *
 * "No matches" and "there is no index" are THE SAME EXIT CODE. A backend
 * wrapper that reported exit 1 as "nothing found" would hand a caller a
 * confident empty answer on a machine where the index has never been built —
 * and "no matches" is the kind of answer a caller acts on. So the two are
 * separated by the stderr text, and anything unrecognised is reported as
 * unavailable rather than as an empty result.
 *
 * `plocate --statistics` is NOT used: it does not exist in 1.1.19 (recorded:
 * `plocate: unrecognized option: statistics`, exit 1), so index age is taken
 * from the database file's mtime instead, which every version has.
 */

export type LocateBackend = "plocate" | "locate";

/** Where each backend keeps its database — checked for age, never parsed. */
export const LOCATE_DB_PATHS: Readonly<Record<LocateBackend, string>> = Object.freeze({
  plocate: "/var/lib/plocate/plocate.db",
  locate: "/var/lib/mlocate/mlocate.db",
});

export type LocateArgvOptions = {
  readonly backend: LocateBackend;
  readonly pattern: string;
  readonly limit: number;
  readonly matchCase: boolean;
  readonly basenameOnly: boolean;
};

/**
 * `plocate -0 --limit N [-i] [-b] -- PATTERN`.
 *
 * `--` is mandatory, not decorative: the pattern is a positional argument, so
 * a caller searching for `-dashfile` would otherwise have `-d` read as
 * "--database" and the next characters as its value. Recorded working:
 * `plocate -0 -- -dashfile` returns `/srv/data/-dashfile.txt`.
 *
 * The limit passed here is deliberately LARGER than the caller's: results are
 * filtered against the search roots after the fact (the backends' own scoping
 * flags differ and `plocate` has none at all), so capping at the caller's
 * limit first would let out-of-scope hits eat the whole allowance and return
 * nothing when matches exist.
 */
export function locateArgv(options: LocateArgvOptions): readonly string[] {
  if (options.pattern === "") throw new Error("refusing to run locate with an empty pattern");
  const argv: string[] = [options.backend, "-0", "--limit", String(options.limit)];
  if (!options.matchCase) argv.push("-i");
  if (options.basenameOnly) argv.push("-b");
  argv.push("--", options.pattern);
  return argv;
}

export type LocateOutcome =
  | { readonly kind: "matches"; readonly paths: readonly string[] }
  | { readonly kind: "noMatches" }
  | { readonly kind: "backendMissing"; readonly detail: string }
  | { readonly kind: "indexUnavailable"; readonly detail: string }
  | { readonly kind: "optionUnsupported"; readonly detail: string }
  | { readonly kind: "timedOut"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

/** Messages a locate backend prints when the database is the problem. */
const DB_PROBLEM = [
  "No such file or directory",
  "Permission denied",
  "can not open",
  "cannot open",
  "no database",
  "is not a plocate database",
  "invalid database",
];

/**
 * Turn a run into an outcome.
 *
 * Order matters. The stderr text is consulted BEFORE the exit code, because
 * exit 1 is the ambiguous one; only an exit 1 with nothing on stderr is
 * allowed to mean "no matches".
 */
export function classifyLocateResult(result: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
}): LocateOutcome {
  if (result.missing) {
    return {
      kind: "backendMissing",
      detail: "no locate backend is installed (looked for plocate, then locate)",
    };
  }
  if (result.timedOut) {
    return { kind: "timedOut", detail: "the locate backend did not finish before the timeout" };
  }
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    if (/unrecognized option|invalid option|unknown option|unrecognised option/i.test(stderr)) {
      // This build does not speak the argv we constructed. Reporting it as
      // "no matches" would be a false negative caused by our own flags.
      return { kind: "optionUnsupported", detail: firstLine(stderr) };
    }
    if (DB_PROBLEM.some((needle) => stderr.includes(needle))) {
      return { kind: "indexUnavailable", detail: firstLine(stderr) };
    }
    // Something unexpected was printed. Whatever it was, it is not evidence
    // that the filesystem contains no matches.
    return { kind: "failed", detail: firstLine(stderr) };
  }
  const paths = result.stdout.split("\0").filter((entry) => entry !== "");
  if (paths.length > 0) return { kind: "matches", paths };
  // Exit 1 with no output at all: the recorded shape of a genuine miss.
  if (result.code === 1 || result.code === 0) return { kind: "noMatches" };
  return { kind: "failed", detail: `the locate backend exited ${result.code}` };
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? text).trim();
}

/**
 * How stale is the index?
 *
 * `plocate`'s database is rebuilt by a daily timer, so an index older than a
 * couple of days is usually a machine where that timer is not running — and a
 * caller who is told "no matches" from a database written a month ago has
 * been told something false about today's filesystem.
 */
export function describeIndexAge(
  dbMtimeMs: number | undefined,
  nowMs: number,
  staleAfterSeconds: number,
): { readonly ageSeconds?: number; readonly stale?: boolean } {
  if (dbMtimeMs === undefined) return {};
  const ageSeconds = Math.max(0, Math.round((nowMs - dbMtimeMs) / 1000));
  return { ageSeconds, stale: ageSeconds > staleAfterSeconds };
}
