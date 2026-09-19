/**
 * Every parser in this package, and nothing else.
 *
 * Each one takes a string that a real manager printed — recorded in
 * `../fixtures.ts` — and returns a shape, or `undefined` when the bytes are
 * not what it was told to expect. None of them reads the host, none of them
 * spawns anything, and none of them guesses: a parser that cannot find what
 * it is looking for says so, and the caller turns that into an `unknown` with
 * a reason rather than into a `false`.
 *
 * Two traps recur across the six managers and are worth stating once.
 *
 * LOCALISATION. `apt-cache policy`, `dnf`, `pacman -Si` and `brew` all
 * translate their labels through gettext. Every parser below reads ENGLISH
 * keywords, which is sound only because `../run.ts` pins `LC_ALL=C` on every
 * child. If that pin is ever removed these parsers do not fail loudly — they
 * find nothing, and "nothing" reads as "not installed". The suite includes a
 * German `apt-cache policy` capture precisely so that failure has a name.
 *
 * COLUMN OUTPUT. `winget list` and `dnf list` print aligned columns, and a
 * column layout is not a data format. winget truncates a wide field with an
 * ellipsis (U+2026) and pads with spaces indistinguishable from the
 * separator, so the parser below refuses a row it cannot split unambiguously
 * rather than returning a version that is a prefix of the real one.
 */

/** Split into lines, tolerating CRLF from a Windows manager. */
export function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

export type BrewEntry = {
  readonly name: string;
  readonly kind: "formula" | "cask";
  /** Versions on disk, as brew prints them. Empty when absent. */
  readonly installedVersions: readonly string[];
  /** What the tap currently offers, or null when the document omits it. */
  readonly stableVersion: string | null;
  readonly pinned: boolean;
  readonly outdated: boolean;
  readonly dependencies: readonly string[];
  readonly tap: string | null;
};

export type BrewInfo = {
  readonly formula?: BrewEntry;
  readonly cask?: BrewEntry;
};

/**
 * `brew info --json=v2` — the one call that answers both halves of a query.
 *
 * The document always has both arrays, and a name resolves into exactly one
 * of them, so a caller does not have to know whether it is asking about a
 * formula or a cask before it asks. A cask spells everything differently
 * (`token` not `name`, a scalar `version` not a `versions` object, a scalar
 * `installed` not an array), which is why the two are normalised here rather
 * than at the call site.
 *
 * Returns `undefined` when the bytes are not a v2 document at all — which is
 * what a failed `brew` prints, and must not be read as "no such package".
 */
export function parseBrewInfoJson(stdout: string): BrewInfo | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const record = doc as Record<string, unknown>;
  const formulae = Array.isArray(record["formulae"]) ? record["formulae"] : undefined;
  const casks = Array.isArray(record["casks"]) ? record["casks"] : undefined;
  // Both keys absent means this is not a v2 info document. Both present and
  // empty is a legitimate answer (brew printed an empty result), and is not
  // the same thing.
  if (formulae === undefined && casks === undefined) return undefined;

  const result: { formula?: BrewEntry; cask?: BrewEntry } = {};
  const firstFormula = formulae?.[0];
  if (typeof firstFormula === "object" && firstFormula !== null) {
    const f = firstFormula as Record<string, unknown>;
    const versions = asRecord(f["versions"]);
    const installed = Array.isArray(f["installed"]) ? f["installed"] : [];
    result.formula = {
      name: asString(f["full_name"]) ?? asString(f["name"]) ?? "",
      kind: "formula",
      installedVersions: installed
        .map((entry) => asString(asRecord(entry)?.["version"]))
        .filter((v): v is string => v !== undefined),
      stableVersion: asString(versions?.["stable"]) ?? null,
      pinned: f["pinned"] === true,
      outdated: f["outdated"] === true,
      dependencies: Array.isArray(f["dependencies"])
        ? f["dependencies"].filter((d): d is string => typeof d === "string")
        : [],
      tap: asString(f["tap"]) ?? null,
    };
  }
  const firstCask = casks?.[0];
  if (typeof firstCask === "object" && firstCask !== null) {
    const c = firstCask as Record<string, unknown>;
    // A cask's `installed` is a scalar version string, or null when absent.
    const installedVersion = asString(c["installed"]);
    result.cask = {
      name: asString(c["full_token"]) ?? asString(c["token"]) ?? "",
      kind: "cask",
      installedVersions: installedVersion === undefined ? [] : [installedVersion],
      stableVersion: asString(c["version"]) ?? null,
      // A cask cannot be pinned; brew reports outdated the same way.
      pinned: false,
      outdated: c["outdated"] === true,
      dependencies: [],
      tap: asString(c["tap"]) ?? null,
    };
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `brew list --formula --versions` — `name version [version…]`, one per line.
 *
 * A keg-only formula with several versions kegged prints all of them, which
 * is why the value is an array: reporting the first as "the" installed
 * version would be wrong for exactly the formulae (python@3.x, openssl@3) a
 * caller is most likely to ask about.
 */
export function parseBrewListVersions(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines(stdout)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const name = parts[0];
    if (name === undefined || parts.length < 2) continue;
    out.set(name, parts.slice(1));
  }
  return out;
}

/** `brew deps --formula <name>` — one dependency per line, already transitive. */
export function parseBrewDeps(stdout: string): string[] {
  return lines(stdout)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * Homebrew's own "no such package" signal.
 *
 * Recorded verbatim: `brew info --json=v2 nope-nope` exits 1 and prints
 * `Error: No available formula with the name "nope-nope".` on stderr.
 * Matching that specific sentence rather than "exit code 1" is what keeps a
 * tap that failed to load from being reported as a missing package.
 */
export function brewSaysNoSuchPackage(stderr: string): boolean {
  return /No available (formula|cask)( or cask)? with the name/i.test(stderr);
}

// ---------------------------------------------------------------------------
// apt / dpkg
// ---------------------------------------------------------------------------

export type DpkgRow = {
  readonly name: string;
  readonly version: string;
  /** dpkg's status abbreviation, e.g. "ii", "un", "rc". */
  readonly statusAbbrev: string;
};

/**
 * `dpkg-query -W -f='${binary:Package}\t${Version}\t${db:Status-Abbrev}\n'`.
 *
 * Tab-separated because a Debian version can contain almost anything except a
 * tab, and named fields because the abbrev's first character is the fact that
 * matters: `i` means the files are on disk, while `u` (unknown) and `r`
 * (removed, config files left) are packages dpkg KNOWS ABOUT but does not
 * have installed. An `rc` package read as installed is the classic dpkg
 * mistake — the binary is gone and only `/etc` remains.
 */
export function parseDpkgQuery(stdout: string): DpkgRow[] {
  const rows: DpkgRow[] = [];
  for (const line of lines(stdout)) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const name = parts[0];
    if (name === undefined || name === "") continue;
    rows.push({ name, version: parts[1] ?? "", statusAbbrev: (parts[2] ?? "").trim() });
  }
  return rows;
}

/** True when dpkg's status abbreviation means the package is actually on disk. */
export function dpkgStatusIsInstalled(abbrev: string): boolean {
  // `ii` = installed; `iU`/`iF` = installed but unconfigured, which is still
  // "the files are there". Anything starting with u/r/p/h/n is not installed.
  return abbrev.startsWith("i");
}

/** dpkg's own "I have never heard of this package" signal, on stderr. */
export function dpkgSaysNoSuchPackage(stderr: string): boolean {
  return /no packages found matching/i.test(stderr);
}

export type AptPolicy = {
  readonly installed: string | null;
  readonly candidate: string | null;
};

/**
 * `apt-cache policy <name>` under `LC_ALL=C`.
 *
 *     curl:
 *       Installed: 7.81.0-1ubuntu1.15
 *       Candidate: 7.81.0-1ubuntu1.16
 *       Version table: …
 *
 * `(none)` is apt's word for "not installed" and becomes `null` here — which
 * is a DIFFERENT null from "the label was not found at all", and the caller
 * tells them apart by whether the parse returned undefined.
 *
 * An unknown package produces an empty document (apt-cache prints nothing and
 * exits 0), which parses to `undefined` rather than to two nulls, so "apt has
 * never heard of this" cannot be confused with "apt has it, not installed".
 */
export function parseAptCachePolicy(stdout: string): AptPolicy | undefined {
  let installed: string | null | undefined;
  let candidate: string | null | undefined;
  for (const line of lines(stdout)) {
    const installedMatch = line.match(/^\s+Installed:\s*(.+?)\s*$/);
    if (installedMatch?.[1] !== undefined) {
      installed = installedMatch[1] === "(none)" ? null : installedMatch[1];
      continue;
    }
    const candidateMatch = line.match(/^\s+Candidate:\s*(.+?)\s*$/);
    if (candidateMatch?.[1] !== undefined) {
      candidate = candidateMatch[1] === "(none)" ? null : candidateMatch[1];
    }
  }
  if (installed === undefined && candidate === undefined) return undefined;
  return { installed: installed ?? null, candidate: candidate ?? null };
}

export type AptSimulatedChange = {
  readonly action: "install" | "remove";
  readonly name: string;
  readonly version: string | null;
};

/**
 * `apt-get install -s` — the best dry run of the six managers.
 *
 * It resolves the whole transaction without root and prints a line per
 * package:
 *
 *     Inst libnghttp2-14 (1.43.0-1 Debian:12 [amd64])
 *     Inst curl [7.88.1-10] (7.88.1-10+deb12u5 Debian-Security:12 [amd64])
 *     Conf curl (7.88.1-10+deb12u5 Debian-Security:12 [amd64])
 *     Remv oldthing [1.0-1]
 *
 * `Conf` lines are dropped: they name the same packages as `Inst`, and
 * counting both would double every transitive addition. `Remv` is kept,
 * because a transaction that REMOVES something is exactly the case an
 * operator has to see before approving an install. The optional `[old]`
 * bracket between the name and the parenthesis is what an UPGRADE looks like,
 * and is skipped so the version reported is the one being installed.
 */
export function parseAptSimulate(stdout: string): AptSimulatedChange[] {
  const changes: AptSimulatedChange[] = [];
  for (const line of lines(stdout)) {
    const inst = line.match(/^Inst\s+(\S+)\s+(?:\[[^\]]*\]\s+)?\(([^\s)]+)/);
    if (inst?.[1] !== undefined) {
      changes.push({ action: "install", name: inst[1], version: inst[2] ?? null });
      continue;
    }
    const remv = line.match(/^Remv\s+(\S+)(?:\s+\[([^\]]*)\])?/);
    if (remv?.[1] !== undefined) {
      changes.push({ action: "remove", name: remv[1], version: remv[2] ?? null });
    }
  }
  return changes;
}

/** apt's "there is no such package" signal, which it prints on stderr. */
export function aptSaysNoSuchPackage(stderr: string): boolean {
  return /Unable to locate package|has no installation candidate|Couldn't find any package/i.test(
    stderr,
  );
}

/** apt's "you are not root" signal. */
export function aptSaysNeedsRoot(text: string): boolean {
  return /are you root|Permission denied|Unable to acquire the dpkg frontend lock|Could not open lock file/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// dnf / rpm
// ---------------------------------------------------------------------------

export type RpmRow = {
  readonly name: string;
  /** epoch:version-release, as rpm's `%{EVR}` renders it. */
  readonly evr: string;
  readonly arch: string;
};

/**
 * `rpm -q --queryformat '%{NAME}\t%{EVR}\t%{ARCH}\n' <name>`.
 *
 * rpm prints "package foo is not installed" on STDOUT (not stderr) and exits
 * 1, so that sentence has to be filtered out of the rows rather than detected
 * by exit code alone — a query for several names prints some rows and some of
 * those sentences in the same stream.
 */
export function parseRpmQuery(stdout: string): RpmRow[] {
  const rows: RpmRow[] = [];
  for (const line of lines(stdout)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/ is not installed$/.test(trimmed)) continue;
    const parts = line.split("\t");
    const name = parts[0];
    if (name === undefined || name === "") continue;
    rows.push({ name, evr: parts[1] ?? "", arch: (parts[2] ?? "").trim() });
  }
  return rows;
}

/** rpm's own not-installed sentence, which it prints on stdout. */
export function rpmSaysNotInstalled(stdout: string): boolean {
  return /package .+ is not installed/i.test(stdout);
}

export type DnfListRow = {
  readonly name: string;
  readonly arch: string;
  readonly version: string;
  readonly repo: string;
};

/**
 * `dnf list --available <name>` — three columns, `name.arch version repo`.
 *
 * Header lines ("Available Packages", "Last metadata expiration check: …")
 * are skipped by SHAPE rather than by text: a line qualifies only when it
 * splits into exactly three whitespace-separated fields, the first contains a
 * `.` separating a name from an architecture, and the second starts with a
 * digit. Matching on the header text would break the moment dnf renames it,
 * and dnf5 did exactly that.
 */
export function parseDnfList(stdout: string): DnfListRow[] {
  const rows: DnfListRow[] = [];
  for (const line of lines(stdout)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 3) continue;
    const nameArch = parts[0];
    const version = parts[1];
    const repo = parts[2];
    if (nameArch === undefined || version === undefined || repo === undefined) continue;
    const dot = nameArch.lastIndexOf(".");
    if (dot <= 0) continue;
    if (!/^[0-9]/.test(version)) continue;
    rows.push({ name: nameArch.slice(0, dot), arch: nameArch.slice(dot + 1), version, repo });
  }
  return rows;
}

/**
 * dnf's "the cache is empty and I was told not to fetch" complaint.
 *
 * This is the difference between "not in the repositories" and "I do not
 * know", and `--cacheonly` makes the second common on a fresh container.
 */
export function dnfSaysNoCache(text: string): boolean {
  return /Cache-only enabled but no cache|no cache for|Failed to (download|synchronize) metadata|There are no enabled repositories/i.test(
    text,
  );
}

/** dnf's own "no such package" signal. */
export function dnfSaysNoMatch(text: string): boolean {
  return /No matching Packages to list|No match for argument|Unable to find a match/i.test(text);
}

/** dnf's "you are not root" signal — checked before a transaction is read. */
export function dnfSaysNeedsRoot(text: string): boolean {
  return /has to be run with superuser privileges|You need to be root|Operation not permitted|Insufficient permissions/i.test(
    text,
  );
}

export type DnfTransactionRow = {
  readonly name: string;
  readonly arch: string;
  readonly version: string;
  readonly repo: string;
};

/**
 * The transaction table `dnf install --assumeno` prints before it declines.
 *
 *     Installing:
 *      tree            x86_64   1.8.0-10.el9    baseos    55 k
 *     Installing dependencies:
 *      libfoo          x86_64   1.2-3           baseos    10 k
 *
 * Section headers are matched on the English words, which is sound under the
 * pinned `LC_ALL=C` and nowhere else. A row must have at least five fields;
 * the size is two of them ("55 k") and is dropped, since a caller who wants a
 * download total has dnf's own summary line.
 */
export function parseDnfTransaction(stdout: string): DnfTransactionRow[] {
  const rows: DnfTransactionRow[] = [];
  let inSection = false;
  for (const line of lines(stdout)) {
    if (
      /^(Installing|Upgrading|Downgrading|Reinstalling)(\s+(weak\s+)?dependencies)?:\s*$/.test(line)
    ) {
      inSection = true;
      continue;
    }
    if (/^\S/.test(line)) {
      // Any unindented line ends the section — "Transaction Summary", the
      // rule of `=` characters, or the next heading.
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 5) continue;
    const [name, arch, version, repo] = parts;
    if (name === undefined || arch === undefined || version === undefined || repo === undefined) {
      continue;
    }
    rows.push({ name, arch, version, repo });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// pacman
// ---------------------------------------------------------------------------

export type PacmanRow = { readonly name: string; readonly version: string };

/** `pacman -Q <name>` — `name version`, one per line. */
export function parsePacmanQuery(stdout: string): PacmanRow[] {
  const rows: PacmanRow[] = [];
  for (const line of lines(stdout)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const name = parts[0];
    const version = parts[1];
    if (name === undefined || version === undefined) continue;
    rows.push({ name, version });
  }
  return rows;
}

/**
 * `pacman -Si <name>` — a `Key : Value` block with indented continuations.
 *
 * Only the FIRST block is read: a name that matches in two repositories
 * prints two blocks, and merging them would report `extra`'s version against
 * `core`'s repository. The caller reports the first block and says the name
 * was ambiguous.
 */
export function parsePacmanInfo(stdout: string): Map<string, string> {
  const fields = new Map<string, string>();
  let lastKey: string | undefined;
  for (const line of lines(stdout)) {
    if (line.trim() === "") {
      // A blank line ends the first block; stop rather than merge the second.
      if (fields.size > 0) break;
      continue;
    }
    const match = line.match(/^(\S(?:[^:]*\S)?)\s*:\s?(.*)$/);
    if (match?.[1] !== undefined && !/^\s/.test(line)) {
      lastKey = match[1].trim();
      fields.set(lastKey, (match[2] ?? "").trim());
      continue;
    }
    if (lastKey !== undefined) {
      fields.set(lastKey, `${fields.get(lastKey) ?? ""} ${line.trim()}`.trim());
    }
  }
  return fields;
}

export type PacmanTarget = {
  readonly repo: string | null;
  readonly name: string;
  readonly version: string;
};

/**
 * `pacman -S --print --print-format '%r/%n %v'` — every target, dependencies
 * included, with versions, no root and no transaction.
 *
 * A package coming from a local file rather than a repository prints an empty
 * repo, which becomes `null` rather than a made-up repository name.
 */
export function parsePacmanSimulate(stdout: string): PacmanTarget[] {
  const targets: PacmanTarget[] = [];
  for (const line of lines(stdout)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const qualified = parts[0];
    const version = parts[1];
    if (qualified === undefined || version === undefined) continue;
    const slash = qualified.indexOf("/");
    const repo = slash > 0 ? qualified.slice(0, slash) : null;
    const name = slash >= 0 ? qualified.slice(slash + 1) : qualified;
    if (name === "") continue;
    targets.push({ repo, name, version });
  }
  return targets;
}

/** pacman's own "no such package" signal. */
export function pacmanSaysNoSuchPackage(stderr: string): boolean {
  return /was not found|target not found/i.test(stderr);
}

/** pacman's "you are not root" signal. */
export function pacmanSaysNeedsRoot(text: string): boolean {
  return /you cannot perform this operation unless you are root|insufficient permission/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// winget
// ---------------------------------------------------------------------------

export type WingetRow = {
  readonly name: string;
  readonly id: string;
  /** null when the row could not be split safely — see `parseWingetList`. */
  readonly version: string | null;
  readonly available: string | null;
  /** Why `version` or `available` is null, when it is. */
  readonly unparsedReason?: string;
};

/** The ellipsis winget uses to mark a field it had to cut. */
const WINGET_ELLIPSIS = "…";

/**
 * `winget list --exact --query <name>` — an aligned table, which is not a
 * data format.
 *
 * winget has no JSON output for `list`. The survey sketch proposed splitting
 * by the header's character offsets; that is wrong, and this is the improved
 * version. Offsets break on two things winget does routinely: it TRUNCATES a
 * field that does not fit and marks the cut with `…`, and it pads with
 * ordinary spaces, so a CJK or emoji display name — double-width in the
 * console but one or two UTF-16 code units in the string — shifts every
 * offset after it. A version read from a shifted offset is not an error, it
 * is a WRONG VERSION, which is the worst answer a query tool can give.
 *
 * So rows are split on runs of TWO OR MORE spaces (one space is inside a
 * display name; two is padding), and a row is refused rather than guessed at
 * when it does not split cleanly:
 *
 *   - any field containing `…` was truncated, so nothing in the row is
 *     trusted;
 *   - fewer than three fields is not a `Name Id Version` row at all;
 *   - the column ORDER is fixed across locales (`Name Id Version [Available]
 *     Source`) even though the header TEXT is localised, so position 2 is the
 *     installed version — but position 3 is ambiguous: a four-field row is
 *     either `…Version Source` or `…Version Available`, with no way to tell.
 *     Four fields therefore yields a null `available` with a reason.
 */
export function parseWingetList(stdout: string): WingetRow[] {
  const rows: WingetRow[] = [];
  for (const raw of lines(stdout)) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    // The rule winget draws under the header, and the spinner characters it
    // leaves behind when its progress display is written to a pipe.
    if (/^[-—─\\|/]+$/.test(line.trim())) continue;
    const fields = line
      .split(/ {2,}/)
      .map((f) => f.trim())
      .filter((f) => f !== "");
    if (fields.length < 3) continue;
    const name = fields[0];
    const id = fields[1];
    const version = fields[2];
    if (name === undefined || id === undefined || version === undefined) continue;
    // The localised header row splits the same way a data row does; it is
    // recognised by the pair of labels rather than by either one alone.
    if (/^(Name|Id|Version)$/i.test(name) && /^(Id|Version|Source)$/i.test(id)) continue;
    if (fields.some((f) => f.includes(WINGET_ELLIPSIS))) {
      rows.push({
        name,
        id,
        version: null,
        available: null,
        unparsedReason:
          "winget cut at least one field of this row with an ellipsis, so the version in it is a prefix rather than a version",
      });
      continue;
    }
    rows.push({
      name,
      id,
      version,
      available: fields.length >= 5 ? (fields[3] ?? null) : null,
      ...(fields.length === 4
        ? {
            unparsedReason:
              "this row has four columns, which is either Name/Id/Version/Source or Name/Id/Version/Available — winget's headers are localised, so the fourth column cannot be identified and no available version is reported from it",
          }
        : {}),
    });
  }
  return rows;
}

/**
 * winget's "no installed package matched" exit code, 0x8A15002B as a signed
 * 32-bit integer.
 *
 * `winget list` exits with this rather than 0-and-empty, which makes presence
 * decidable from the EXIT CODE alone — the one part of winget's answer that
 * is neither localised nor column-aligned.
 */
export const WINGET_NO_PACKAGES_FOUND = -1978335189;

// ---------------------------------------------------------------------------
// chocolatey
// ---------------------------------------------------------------------------

/**
 * `choco list --limit-output` — `name|version`, one per line, no header.
 *
 * `--limit-output` is chocolatey's documented machine-readable mode and the
 * reason choco is the easiest of the six to read. A trailing summary line
 * ("2 packages installed.") does not appear in this mode, and is dropped by
 * shape anyway in case an older build prints one.
 */
export function parseChocoList(stdout: string): PacmanRow[] {
  const rows: PacmanRow[] = [];
  for (const line of lines(stdout)) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.includes("|")) continue;
    const [name, version] = trimmed.split("|");
    if (name === undefined || name === "" || version === undefined || version === "") continue;
    rows.push({ name, version });
  }
  return rows;
}

/**
 * The major version of `choco --version`.
 *
 * Chocolatey 2.0 removed `--local-only` from `choco list`, so which flags are
 * legal depends on this number. Guessing would mean either an unknown-option
 * error on v2 or a REMOTE search on v1 — and a remote search answering "yes,
 * 8.7.1" for a package that is not installed at all is precisely the wrong
 * answer this package exists to avoid.
 */
export function parseChocoMajorVersion(stdout: string): number | undefined {
  const match = stdout.trim().match(/(\d+)\.(\d+)/);
  const major = match?.[1];
  if (major === undefined) return undefined;
  const value = Number.parseInt(major, 10);
  return Number.isFinite(value) ? value : undefined;
}
