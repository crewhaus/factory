/**
 * The macOS backend for `OsIndexSearch`: `mdfind` for the query, `mdutil`
 * for whether the index can be believed.
 *
 * TWO THINGS ABOUT `mdfind` DECIDE THE SHAPE OF THIS MODULE, both recorded
 * from a real host in `../fixtures.ts`:
 *
 * 1. IT HAS NO `--`. Running `mdfind -- x` prints `Unknown option --` and a
 *    usage block, and exits 1 (recorded). So the usual defence against a
 *    caller-supplied value that starts with `-` becoming a flag is not
 *    available — which is why the caller's text NEVER becomes an argv element
 *    of its own here. It is always spliced into a quoted literal inside a
 *    predicate that starts with `kMDItem`, and `mdfindArgv` asserts that
 *    before it will build an argv at all. A query of `-count` is a search for
 *    files named `-count`, not a flag.
 * 2. AN EMPTY ANSWER IS AMBIGUOUS. `mdfind` exits 0 and prints nothing both
 *    when there are no matches and when the volume is not indexed (recorded:
 *    `mdfind -onlyin /no/such/dir` also prints nothing and exits 0). So the
 *    tool asks `mdutil` what the index's state actually is before it reports
 *    "nothing found", and says which of the two it is.
 *
 * The predicate is also an injection surface in its own right, and not a
 * theoretical one: a `"` inside the caller's text would close the literal
 * and let the rest be read as predicate SYNTAX — turning a filename search
 * into `kMDItemTextContent == "*"` over everything the user can read. So the
 * splice escapes `\` and `"`, and a control character is refused outright.
 */

export type SearchMode = "name" | "content";

/** The attribute each mode searches, and what the caller is really asking. */
const ATTRIBUTE: Record<SearchMode, string> = {
  name: "kMDItemFSName",
  content: "kMDItemTextContent",
};

/**
 * Splice the caller's text into an NSPredicate string literal.
 *
 * `*` and `?` are left alone deliberately: in a `==` comparison they are the
 * wildcards, and `plocate` treats them the same way, so one documented
 * contract covers both backends — the query is a substring match and those
 * two characters are wildcards.
 */
export function escapePredicateLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A query with a control character cannot be spliced safely, and is refused.
 *
 * Checked by character CODE rather than with a regular expression: a regex
 * literal holding raw control characters is unreadable, and the linter is
 * right to object to one. The refusal itself is not optional — a NUL would
 * truncate the argument at the `execve` boundary with everything after it
 * silently gone, and a newline would end a line in output this package parses
 * back.
 */
export function rejectUnsafeQuery(query: string): string | undefined {
  for (let i = 0; i < query.length; i += 1) {
    const code = query.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return "the query contains a control character, which cannot be passed to the index safely";
    }
  }
  return undefined;
}

export type PredicateOptions = {
  readonly query: string;
  readonly mode: SearchMode;
  readonly matchCase: boolean;
};

/**
 * Build the predicate. `c` is case-insensitive, `d` diacritic-insensitive;
 * content search always takes `d` because "cafe" not matching "café" in a
 * document search is a false negative nobody expects.
 */
export function buildPredicate(options: PredicateOptions): string {
  const attribute = ATTRIBUTE[options.mode];
  const literal = escapePredicateLiteral(options.query);
  const modifiers = `${options.matchCase ? "" : "c"}${options.mode === "content" ? "d" : ""}`;
  return `${attribute} == "*${literal}*"${modifiers}`;
}

export type MdfindArgvOptions = {
  readonly predicate: string;
  readonly roots: readonly string[];
};

/**
 * `mdfind -0 [-onlyin ROOT]... PREDICATE`.
 *
 * `-0` because a filename may contain a newline: a line-delimited listing of
 * such a file is two results, one of them invented.
 */
export function mdfindArgv(options: MdfindArgvOptions): readonly string[] {
  if (!options.predicate.startsWith("kMDItem")) {
    // The guard for the missing `--`: if this ever fails, a caller's text has
    // reached argv on its own and a leading `-` would be read as a flag.
    throw new Error("refusing to run mdfind with a predicate that is not an attribute comparison");
  }
  const argv = ["mdfind", "-0"];
  for (const root of options.roots) {
    if (!root.startsWith("/")) {
      throw new Error("refusing to run mdfind with a search root that is not an absolute path");
    }
    argv.push("-onlyin", root);
  }
  argv.push(options.predicate);
  return argv;
}

/** Paths out of a `-0` listing. Empty segments (including the trailing one) are dropped. */
export function parseNulList(stdout: string): readonly string[] {
  return stdout.split("\0").filter((entry) => entry !== "");
}

export type MdfindFailure = {
  readonly kind: "backendMissing" | "badQuery" | "timedOut" | "failed";
  readonly detail: string;
};

/**
 * Did the run fail, and how?
 *
 * `mdfind` reports a malformed query on STDOUT (`Failed to create query for
 * '…'.`, exit 1 — recorded), so a parser that only looked at stderr would
 * read the error text as a search result and hand back a path that does not
 * exist.
 */
export function classifyMdfindResult(result: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
}): MdfindFailure | undefined {
  if (result.missing) {
    return {
      kind: "backendMissing",
      detail: "mdfind is not installed on this machine (it ships with macOS)",
    };
  }
  if (result.timedOut) {
    return { kind: "timedOut", detail: "mdfind did not finish before the timeout" };
  }
  const firstLine = (result.stdout.split("\n")[0] ?? "").trim();
  if (firstLine.startsWith("Failed to create query")) {
    return { kind: "badQuery", detail: firstLine };
  }
  if (firstLine.startsWith("Unknown option")) {
    return { kind: "badQuery", detail: firstLine };
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() !== "" ? result.stderr : result.stdout).trim();
    return { kind: "failed", detail: detail === "" ? `mdfind exited ${result.code}` : detail };
  }
  return undefined;
}

export type IndexState = "enabled" | "disabled" | "unknown";

export type MdutilStatus = {
  readonly volume: string;
  readonly state: IndexState;
  readonly detail: string;
};

/** `mdutil -s VOLUME` — the index-health probe. */
export function mdutilArgv(volume: string): readonly string[] {
  if (!volume.startsWith("/")) {
    throw new Error("refusing to run mdutil with a volume that is not an absolute path");
  }
  return ["mdutil", "-s", volume];
}

/**
 * Parse `mdutil -s`.
 *
 * Recorded shapes, all of which exit 0:
 *
 *     /:
 *     \tIndexing enabled.
 *
 *     /System/Volumes/Data/private/tmp:
 *     \tError: unknown indexing state.
 *
 *     Error: invalid path `/Volumes/nonexistent'.
 *
 * The last two are why the default is `unknown` and not `disabled`. A path
 * that is not a volume root reports an error, not a state, and calling that
 * "disabled" would turn every ordinary directory into a false alarm — while
 * calling it "enabled" would restore exactly the false negative this probe
 * exists to prevent.
 */
export function parseMdutilStatus(stdout: string, requested: string): MdutilStatus {
  const lines = stdout.split("\n").map((line) => line.trim());
  const volumeLine = lines.find((line) => line.endsWith(":"));
  const volume = volumeLine === undefined ? requested : volumeLine.slice(0, -1);
  const body = lines.filter((line) => line !== "" && !line.endsWith(":"));
  const text = body.join(" ");
  const lower = text.toLowerCase();
  // "Indexing and searching disabled." is also a disabled state; both forms
  // are matched by looking for the word "disabled" after "indexing".
  if (/indexing(?:\s+and\s+searching)?\s+disabled/.test(lower)) {
    return { volume, state: "disabled", detail: text };
  }
  if (/indexing\s+enabled/.test(lower)) {
    return { volume, state: "enabled", detail: text };
  }
  return { volume, state: "unknown", detail: text === "" ? "mdutil said nothing" : text };
}
