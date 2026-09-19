/**
 * The gate every caller-supplied package name and version passes through
 * before an argv exists.
 *
 * ── WHY THIS FILE IS THE SECURITY BOUNDARY ────────────────────────────────
 *
 * A package name is a caller value that reaches an argv, and an argv element
 * beginning with `-` is a FLAG, not an operand. `PackageInstall({name:"-y"})`
 * against a manager that does not stop option parsing would not install a
 * package called `-y`; it would add a flag to a command that modifies the
 * system. This repository has already shipped exactly that bug once —
 * `gitBranchCreate({name:"-D"})` ran `git branch -D victim` — and the cheapest
 * way not to ship it twice is for a leading dash never to reach an argv.
 *
 * `--` is the usual defence, and it is used below wherever it is documented
 * to work. But it is NOT the primary defence here, because the six managers
 * genuinely differ: `apt-get`, `apt-cache`, `dpkg-query`, `pacman`, `rpm`
 * (popt) and `dnf` (argparse) all honour `--`, while `winget` and `choco`
 * have their own parsers that do not document it at all and Homebrew's is a
 * Ruby `OptionParser` whose behaviour this package has not recorded. A
 * defence that is true for four of six managers is not a defence. So a name
 * that begins with `-` is REFUSED, on every manager, before anything is
 * spawned — and `--` is passed on top, where it is known to work, as the belt
 * to that brace.
 *
 * Everything else a hostile name might contain — a double quote, a backslash,
 * a newline, `$(id)`, a backtick, `</toast>`, `&`, a NUL — is inert in an
 * argv array, because this package has no shell (see `../run.ts`). It is
 * still refused, for a different and simpler reason: none of it is a legal
 * package name in any of these managers, so accepting it could only ever turn
 * into a confusing error from a child process instead of a clear refusal from
 * the tool. The tests assert both halves: that each hostile value is refused,
 * and that when a name IS accepted it reaches the argv as exactly one element
 * with byte-identical content.
 */

export type ManagerId = "homebrew" | "apt" | "dnf" | "pacman" | "winget" | "choco";

export type NameRule = {
  /** Names this manager will accept, anchored. */
  readonly pattern: RegExp;
  /** The charset, in words, for the refusal message. */
  readonly charset: string;
};

/**
 * Per-manager name grammars, each narrowed to what the manager documents.
 *
 *   - homebrew: formula and cask tokens are lowercase `a-z0-9@+._-`, and a
 *     tap-qualified name adds two slashes (`homebrew/cask/firefox`). Upper
 *     case is allowed through because a tap's user segment can carry it.
 *   - apt: Debian policy §5.6.1 — `[a-z0-9][a-z0-9+.-]+`, plus an optional
 *     `:arch` qualifier (`libc6:i386`).
 *   - dnf: an rpm name is `[A-Za-z0-9._+-]`, and the whole NEVRA form
 *     (`kernel-5.14.0-427.el9.x86_64`) is spelled with the same characters,
 *     which is why a version is passed as part of the NAME for dnf rather
 *     than built into one here (see `versionSupport`).
 *   - pacman: `[a-z0-9@._+-]` per PKGBUILD(5), plus `repo/name`.
 *   - winget: an Id is `Publisher.Package`, ASCII alphanumerics with `.`,
 *     `-` and `_`. A DISPLAY name (which may contain spaces and CJK) is not
 *     accepted, because it is not what `--exact` matches on and guessing
 *     which one the caller meant is how a query answers about the wrong app.
 *   - choco: package ids are `[A-Za-z0-9._-]`.
 *
 * Every pattern rejects a leading `-` structurally, and the check below
 * rejects it again by name so the refusal says WHY rather than "does not
 * match".
 */
export const NAME_RULES: Readonly<Record<ManagerId, NameRule>> = Object.freeze({
  homebrew: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9@+._-]*(\/[A-Za-z0-9][A-Za-z0-9@+._-]*){0,2}$/,
    charset: "letters, digits and @ + . _ - , with at most two / segments for a tap-qualified name",
  },
  apt: {
    pattern: /^[a-z0-9][a-z0-9+._-]*(:[a-z0-9][a-z0-9-]*)?$/,
    charset: "lowercase letters, digits and + . _ - , with an optional :architecture suffix",
  },
  dnf: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
    charset: "letters, digits and . _ + -",
  },
  pacman: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9@._+-]*(\/[A-Za-z0-9][A-Za-z0-9@._+-]*)?$/,
    charset: "letters, digits and @ . _ + - , with an optional repository/ prefix",
  },
  winget: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    charset: "ASCII letters, digits and . _ - (a winget package Id, not its display name)",
  },
  choco: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    charset: "letters, digits and . _ -",
  },
});

/** Longest name accepted. Debian's own limit is far shorter; this is a sanity bound. */
export const MAX_NAME_LENGTH = 200;
/** Longest version specifier accepted. */
export const MAX_VERSION_LENGTH = 100;

/**
 * Check one caller-supplied package name.
 *
 * Returns the refusal, or `undefined` when the name may become an argv
 * element. The checks are ordered so the message names the SPECIFIC problem:
 * "starts with -" is far more useful to a caller than "does not match the
 * accepted characters", and both are more useful than a manager's own error.
 */
export function checkPackageName(manager: ManagerId, name: string): string | undefined {
  if (name === "") return "the package name is empty";
  if (name.length > MAX_NAME_LENGTH) {
    return `the package name is ${name.length} characters, over the ${MAX_NAME_LENGTH}-character limit`;
  }
  if (name.includes("\0")) {
    // execve truncates an argument at a NUL, so a name that reads as harmless
    // here would arrive at the kernel cut short with whatever followed gone.
    return "the package name contains a NUL byte, which would be truncated at the execve boundary";
  }
  if (/[\n\r]/.test(name)) {
    return "the package name contains a newline, which no package manager accepts in a name";
  }
  if (name.startsWith("-")) {
    return `the package name starts with "-", which a package manager reads as a FLAG rather than a package (${JSON.stringify(name)}) — this is refused rather than defended with "--", because winget, choco and brew do not all document "--" as an end-of-options marker`;
  }
  if (name === "." || name === "..") {
    return `"${name}" is a path, not a package name`;
  }
  // Ordered after the specific checks so a control character or a shell
  // metacharacter is reported as itself rather than as a charset miss.
  // \u escapes, not \x, and never the raw bytes biome folds \x into: this
  // class is rewritten by the formatter, and bun 1.3.11 (what CI runs) rejects
  // a class carrying raw control bytes as "range out of order" while 1.3.14
  // (what this machine runs) accepts it. The suppression below must stay on
  // the line directly above the regex — a comment between them makes the
  // suppression unused AND leaves the rule unsuppressed, which is two errors.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return "the package name contains a control character";
  }
  if (/\s/.test(name)) {
    return "the package name contains whitespace; a package name is a single token";
  }
  const rule = NAME_RULES[manager];
  if (!rule.pattern.test(name)) {
    return `${JSON.stringify(name)} is not a valid ${manager} package name — accepted: ${rule.charset}`;
  }
  return undefined;
}

/**
 * The version grammars the managers that CAN pin a version accept.
 *
 * Only apt is here, and that is the honest answer rather than a gap:
 *
 *   - apt expresses an exact version as `name=version`, and a Debian version
 *     string is `[A-Za-z0-9.+~:-]` (policy §5.6.12). `=` is what makes this
 *     work and is why the version has its own grammar: a version containing
 *     `=` would produce `name=1=2`, which apt reads as a different package.
 *   - dnf CAN take `name-version-release`, and this package will not build
 *     one, because the join is ambiguous the moment the NAME contains a dash
 *     — which most rpm names do. A caller who wants an exact rpm passes the
 *     whole NEVRA as the name; that is unambiguous and needs no guessing.
 *   - pacman has no version selection at all. There is no flag, and the sync
 *     database holds exactly one version per package.
 *   - Homebrew installs the tap's current version. The only pin is a
 *     versioned FORMULA (`node@20`), which is a different name, not a version.
 *   - winget and choco can pin, but this package does not install through
 *     either of them at all (see `./managers.ts`), so the question does not
 *     arise.
 *
 * Every one of those is refused explicitly with that sentence, rather than
 * silently installing latest — which is the failure mode the refusal exists
 * to prevent.
 */
export const DEBIAN_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+~:-]*$/;

export function checkVersionSyntax(version: string): string | undefined {
  if (version === "") return "the version is empty";
  if (version.length > MAX_VERSION_LENGTH) {
    return `the version is ${version.length} characters, over the ${MAX_VERSION_LENGTH}-character limit`;
  }
  if (!DEBIAN_VERSION_PATTERN.test(version)) {
    return `${JSON.stringify(version)} is not a Debian version string — accepted: letters, digits and . + ~ : - , starting with a letter or digit`;
  }
  return undefined;
}
