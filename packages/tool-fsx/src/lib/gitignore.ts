/**
 * `.gitignore` pattern semantics, applied to a filesystem walk.
 *
 * What is implemented, from gitignore(5):
 *   - blank lines and `#` comments are skipped; `\#` escapes a leading hash
 *   - trailing whitespace is stripped unless escaped with a backslash
 *   - a leading `!` negates; `\!` escapes a leading bang
 *   - a trailing `/` makes the rule match directories only
 *   - a pattern containing a `/` anywhere (other than a trailing one) is
 *     anchored to the directory holding the `.gitignore`; otherwise it is
 *     matched against the basename at any depth below that directory
 *   - `*`, `?`, `[...]` do not cross `/`; `**` as a whole segment does
 *   - within one file the LAST matching rule wins; a file in a deeper
 *     directory overrides a shallower one
 *   - a directory that is ignored is not descended into, so a negation
 *     inside it cannot re-include anything (git behaves the same way)
 *
 * What is NOT implemented, and why it is stated rather than hidden: the git
 * index is never consulted. Git does not ignore a file it is already
 * tracking; this matcher has no index to ask, so it hides any path matching
 * a pattern. `$GIT_DIR/info/exclude`, `core.excludesFile` and the global
 * ignore file are likewise out of scope — only `.gitignore` files inside the
 * walked tree are read.
 */
import { globToRegExpSource } from "./glob";

/** One compiled line from a `.gitignore` file. */
export type IgnoreRule = {
  /** `!pattern` — re-includes a path an earlier rule ignored. */
  readonly negated: boolean;
  /** Trailing `/` — the rule matches directories only. */
  readonly dirOnly: boolean;
  /** Contains a `/`, so it matches a path relative to the file's directory. */
  readonly anchored: boolean;
  readonly regex: RegExp;
  /** The original line, for explaining a decision back to the caller. */
  readonly source: string;
};

/** The rules from one `.gitignore`, plus the directory it governs. */
export type IgnoreLayer = {
  /** Directory holding the file, relative to the walk root; "" at the root. */
  readonly base: string;
  readonly rules: ReadonlyArray<IgnoreRule>;
};

/**
 * Strip trailing whitespace that is not backslash-escaped. `foo\ ` keeps its
 * space (and loses the backslash); `foo   ` does not.
 */
function stripTrailingSpace(line: string): string {
  let end = line.length;
  while (end > 0) {
    const ch = line[end - 1];
    if (ch !== " " && ch !== "\t") break;
    // Count the backslashes immediately before this run of whitespace.
    let backslashes = 0;
    let k = end - 2;
    while (k >= 0 && line[k] === "\\") {
      backslashes += 1;
      k -= 1;
    }
    if (backslashes % 2 === 1) break; // escaped — the whitespace is significant
    end -= 1;
  }
  return line.slice(0, end);
}

/** Compile one non-blank, non-comment line. Returns undefined for an empty rule. */
export function compileIgnoreRule(rawLine: string): IgnoreRule | undefined {
  const source = rawLine;
  let pattern = stripTrailingSpace(rawLine);
  if (pattern === "") return undefined;

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
    pattern = pattern.slice(1);
  }
  if (pattern === "") return undefined;

  let dirOnly = false;
  if (pattern.endsWith("/") && !pattern.endsWith("\\/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") return undefined;

  // Anchoring is decided on the pattern AFTER the trailing slash is removed,
  // so `build/` is unanchored (any directory named build) while `a/build/`
  // is anchored to the .gitignore's own directory.
  let anchored = pattern.includes("/");
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern === "") return undefined;

  return {
    negated,
    dirOnly,
    anchored,
    regex: new RegExp(`^${globToRegExpSource(pattern)}$`),
    source,
  };
}

/** Compile a whole `.gitignore` file, in order. */
export function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith("#")) continue;
    const rule = compileIgnoreRule(line);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
}

function basenameOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut === -1 ? relPath : relPath.slice(cut + 1);
}

/**
 * Decide whether `relPath` (slash-separated, relative to the walk root) is
 * ignored. `layers` must be ordered shallowest-first — the walker appends a
 * layer as it descends — so the last match found is the highest-precedence
 * one, which is exactly git's rule.
 */
export function isIgnored(
  layers: ReadonlyArray<IgnoreLayer>,
  relPath: string,
  isDirectory: boolean,
): boolean {
  let ignored = false;
  for (const layer of layers) {
    let subject: string;
    if (layer.base === "") {
      subject = relPath;
    } else if (relPath.startsWith(`${layer.base}/`)) {
      subject = relPath.slice(layer.base.length + 1);
    } else {
      continue; // the path is not governed by this file
    }
    const base = basenameOf(subject);
    for (const rule of layer.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(rule.anchored ? subject : base)) {
        ignored = !rule.negated;
      }
    }
  }
  return ignored;
}
