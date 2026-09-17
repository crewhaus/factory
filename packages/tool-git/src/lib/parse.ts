/**
 * Pure parsers for git's machine-readable output formats.
 *
 * Nothing here spawns anything or touches the filesystem: every function takes
 * a string that `git` already printed and returns structured data. That split
 * is deliberate — the parsing is the part that is easy to get subtly wrong, so
 * it lives where it can be unit-tested against captured fixtures, and the
 * process-spawning half (`../git-run`) stays thin enough to read in one sitting.
 *
 * Everywhere there was a choice of output format we took git's most stable,
 * explicitly-for-scripts one, and each parser says which one and why.
 */

// ---------------------------------------------------------------------------
// shared helpers

/** Split NUL-separated output, dropping the empty tail after the last NUL. */
export function splitNul(stdout: string): string[] {
  const parts = stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Split line-separated output, dropping blank lines. */
export function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * Turn git's `<epoch-seconds> <±hhmm>` pair into an ISO-8601 string that keeps
 * the committer's own offset. Done by arithmetic rather than by `Date`'s
 * locale-aware formatters so the result never depends on the host timezone.
 */
export function gitTimeToIso(epochSeconds: number, tz: string): string {
  const m = tz.match(/^([+-])(\d{2})(\d{2})$/);
  if (m === null) return new Date(epochSeconds * 1000).toISOString();
  const sign = m[1] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date((epochSeconds + offsetMinutes * 60) * 1000);
  return `${shifted.toISOString().slice(0, 19)}${m[1]}${m[2]}:${m[3]}`;
}

/** Ascending comparison on a `path` field — plain `<`, never a locale collator. */
export function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status — `git status --porcelain=v2 -z`

/** One changed path, with git's two-letter index/worktree status split apart. */
export type StatusEntry = {
  readonly path: string;
  /** Status in the index ("." when unchanged): M A D R C T. */
  readonly index: string;
  /** Status in the worktree ("." when unchanged): M A D R C T. */
  readonly worktree: string;
  /** The previous path, for a rename or copy. */
  readonly from?: string;
};

export type ConflictEntry = {
  readonly path: string;
  /** The unmerged code pair, e.g. "UU" (both modified) or "AA" (both added). */
  readonly code: string;
};

export type GitStatusReport = {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly head: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: StatusEntry[];
  readonly unstaged: StatusEntry[];
  readonly untracked: string[];
  readonly ignored: string[];
  readonly conflicted: ConflictEntry[];
  readonly clean: boolean;
};

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * v2 is the format git documents as the stable one for scripts (v1 exists only
 * for backwards compatibility and carries no branch/upstream fields), and `-z`
 * removes the last ambiguity: without it git quotes and backslash-escapes any
 * path containing a space, quote or newline, so a parser would have to
 * re-implement C-string unquoting. With `-z` every path is a literal byte run
 * between NULs, and a rename's original path is simply the next NUL field.
 */
export function parseStatusV2(stdout: string): GitStatusReport {
  const records = splitNul(stdout);
  let branch: string | null = null;
  let detached = false;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: StatusEntry[] = [];
  const unstaged: StatusEntry[] = [];
  const untracked: string[] = [];
  const ignored: string[] = [];
  const conflicted: ConflictEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record === "") continue;
    const kind = record[0];

    if (kind === "#") {
      const space = record.indexOf(" ", 2);
      const key = space === -1 ? record.slice(2) : record.slice(2, space);
      const value = space === -1 ? "" : record.slice(space + 1);
      if (key === "branch.oid") head = value === "(initial)" ? null : value;
      else if (key === "branch.head") {
        detached = value === "(detached)";
        branch = detached ? null : value;
      } else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const ab = value.match(/^\+(\d+) -(\d+)$/);
        if (ab !== null) {
          ahead = Number(ab[1]);
          behind = Number(ab[2]);
        }
      }
      continue;
    }

    if (kind === "?") {
      untracked.push(record.slice(2));
      continue;
    }
    if (kind === "!") {
      ignored.push(record.slice(2));
      continue;
    }

    if (kind === "1" || kind === "2") {
      // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>" — eight fixed
      // space-separated fields, then the path; a "2" (rename/copy) record has
      // one more fixed field (the similarity score) and its original path is
      // the FOLLOWING NUL-separated element.
      const fields = record.split(" ");
      const fixed = kind === "1" ? 8 : 9;
      const xy = fields[1] ?? "..";
      const path = fields.slice(fixed).join(" ");
      let from: string | undefined;
      if (kind === "2") {
        from = records[i + 1];
        i++;
      }
      const index = xy[0] ?? ".";
      const worktree = xy[1] ?? ".";
      const entry: StatusEntry =
        from === undefined ? { path, index, worktree } : { path, index, worktree, from };
      if (index !== ".") staged.push(entry);
      if (worktree !== ".") unstaged.push(entry);
      continue;
    }

    if (kind === "u") {
      // "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const fields = record.split(" ");
      conflicted.push({ path: fields.slice(10).join(" "), code: fields[1] ?? "UU" });
    }
  }

  staged.sort(byPath);
  unstaged.sort(byPath);
  conflicted.sort(byPath);
  untracked.sort();
  ignored.sort();

  return {
    branch,
    detached,
    head,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    ignored,
    conflicted,
    clean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      conflicted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// log — a NUL-delimited custom format

/**
 * Field and record separators for every `--format` this package uses.
 *
 * A commit message can contain anything printable, including tabs, pipes and
 * whatever separator a naive implementation picks — so fields are split on NUL
 * (`%x00`), which git's object format forbids inside a commit message, and
 * records are introduced by RS (`%x1e`). Neither can appear in the data, so the
 * parse below cannot be confused by a cleverly-worded commit.
 */
export const RECORD_SEP = String.fromCharCode(0x1e);
export const FIELD_SEP = String.fromCharCode(0);

/** The `--format` string whose output `parseCommits` expects. */
export const COMMIT_FORMAT =
  "%x1e%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x00";

export type NameStatusEntry = {
  /** A single letter (M/A/D/T), or R/C followed by a similarity score. */
  readonly status: string;
  readonly path: string;
  /** The previous path, for a rename or copy. */
  readonly from?: string;
};

export type Commit = {
  readonly sha: string;
  readonly shortSha: string;
  readonly author: string;
  readonly authorEmail: string;
  /** Strict ISO-8601, from `%aI` — a fixed-width machine format, not a locale one. */
  readonly authorDate: string;
  readonly committer: string;
  readonly committerEmail: string;
  readonly commitDate: string;
  readonly subject: string;
  readonly body: string;
  /** Present only when the command was run with `--name-status`. */
  readonly changes?: NameStatusEntry[];
};

/**
 * Parse `--name-status` output: one tab-separated line per changed path, with
 * renames and copies carrying both the old and the new path.
 */
export function parseNameStatus(block: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  for (const line of splitLines(block)) {
    const parts = line.split("\t");
    const status = parts[0];
    if (status === undefined || status === "") continue;
    if ((status.startsWith("R") || status.startsWith("C")) && parts.length >= 3) {
      entries.push({ status, path: parts[2] as string, from: parts[1] as string });
    } else if (parts.length >= 2) {
      entries.push({ status, path: parts[1] as string });
    }
  }
  return entries;
}

/**
 * Parse the output of a `git log` / `git show` run using `COMMIT_FORMAT`. When
 * `withChanges` is set, the text trailing each record's last field is treated
 * as that commit's `--name-status` block.
 */
export function parseCommits(stdout: string, withChanges = false): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    if (record === "") continue;
    const f = record.split(FIELD_SEP);
    if (f.length < 10) continue;
    const base: Commit = {
      sha: f[0] as string,
      shortSha: f[1] as string,
      author: f[2] as string,
      authorEmail: f[3] as string,
      authorDate: f[4] as string,
      committer: f[5] as string,
      committerEmail: f[6] as string,
      commitDate: f[7] as string,
      subject: f[8] as string,
      body: (f[9] as string).replace(/\n+$/, ""),
    };
    commits.push(withChanges ? { ...base, changes: parseNameStatus(f[10] ?? "") } : base);
  }
  return commits;
}

// ---------------------------------------------------------------------------
// numstat — `git diff --numstat -z`

export type NumstatEntry = {
  /** null for a binary file, where git prints "-". */
  readonly added: number | null;
  readonly removed: number | null;
  readonly path: string;
  readonly from?: string;
};

/**
 * Parse `git diff --numstat -z`.
 *
 * `-z` is used for the same reason as in status: it turns off path quoting.
 * Its one wrinkle is renames — git emits "<added>\t<removed>\t" and then the
 * old and the new path as two further NUL fields, which is the branch below.
 */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const fields = splitNul(stdout);
  const entries: NumstatEntry[] = [];
  const count = (raw: string | undefined): number | null =>
    raw === undefined || raw === "-" ? null : Number(raw);
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record === undefined || record === "") continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const added = count(parts[0]);
    const removed = count(parts[1]);
    if (parts[2] === "") {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (from === undefined || to === undefined) continue;
      entries.push({ added, removed, path: to, from });
    } else {
      entries.push({ added, removed, path: parts[2] as string });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// blame — `git blame --line-porcelain`

export type BlameLine = {
  readonly line: number;
  readonly sha: string;
  readonly author: string;
  readonly authorEmail: string;
  readonly date: string;
  readonly summary: string;
  readonly content: string;
};

/**
 * Parse `git blame --line-porcelain`.
 *
 * Plain `--porcelain` prints a commit's author block only the first time that
 * commit is seen, so a parser has to carry state across the whole file to
 * answer "who last touched line N". `--line-porcelain` repeats the block on
 * every line, which costs a few bytes and removes that state entirely.
 */
export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  let sha = "";
  let finalLine = 0;
  let author = "";
  let authorEmail = "";
  let time = 0;
  let tz = "+0000";
  let summary = "";
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (m !== null) {
      sha = m[1] as string;
      finalLine = Number(m[2]);
      continue;
    }
    if (line.startsWith("\t")) {
      out.push({
        line: finalLine,
        sha,
        author,
        authorEmail,
        date: gitTimeToIso(time, tz),
        summary,
        content: line.slice(1),
      });
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "author") author = value;
    else if (key === "author-mail") authorEmail = value.replace(/^<|>$/g, "");
    else if (key === "author-time") time = Number(value);
    else if (key === "author-tz") tz = value;
    else if (key === "summary") summary = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// refs — `git for-each-ref --format=...`

/**
 * `for-each-ref` is git's documented scripting interface for ref listing:
 * unlike `git branch` / `git tag` it takes an explicit field format, never
 * decorates the current branch with a "* ", and sorts by refname by default,
 * so its output is already stable without any post-processing.
 */
export const REF_FORMAT =
  "%(refname:short)%00%(refname)%00%(objectname)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(contents:subject)";

export type RefRecord = {
  readonly name: string;
  readonly fullName: string;
  readonly sha: string;
  readonly upstream: string | null;
  readonly date: string;
  readonly subject: string;
};

export function parseRefs(stdout: string): RefRecord[] {
  const records: RefRecord[] = [];
  for (const line of splitLines(stdout)) {
    const f = line.split(FIELD_SEP);
    if (f.length < 6) continue;
    records.push({
      name: f[0] as string,
      fullName: f[1] as string,
      sha: f[2] as string,
      upstream: f[3] === "" ? null : (f[3] as string),
      date: f[4] as string,
      subject: f[5] as string,
    });
  }
  return records;
}

/** Tags carry a creator date (annotated) or a commit date (lightweight). */
export const TAG_FORMAT =
  "%(refname:short)%00%(refname)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents:subject)";

export type TagRecord = {
  readonly name: string;
  readonly fullName: string;
  /** The tag object for an annotated tag, or the commit for a lightweight one. */
  readonly sha: string;
  /** The commit an annotated tag points at; equal to `sha` when lightweight. */
  readonly commit: string;
  readonly annotated: boolean;
  readonly date: string;
  readonly subject: string;
};

export function parseTags(stdout: string): TagRecord[] {
  const tags: TagRecord[] = [];
  for (const line of splitLines(stdout)) {
    const f = line.split(FIELD_SEP);
    if (f.length < 6) continue;
    const deref = f[3] as string;
    tags.push({
      name: f[0] as string,
      fullName: f[1] as string,
      sha: f[2] as string,
      commit: deref === "" ? (f[2] as string) : deref,
      annotated: deref !== "",
      date: f[4] as string,
      subject: f[5] as string,
    });
  }
  return tags;
}

// ---------------------------------------------------------------------------
// remotes — `git remote -v`

export type RemoteRecord = {
  readonly name: string;
  readonly fetch: string | null;
  readonly push: string | null;
};

/** Parse `git remote -v`: "<name>\t<url> (fetch|push)", one line per direction. */
export function parseRemotes(stdout: string): RemoteRecord[] {
  const byName = new Map<string, { fetch: string | null; push: string | null }>();
  for (const line of splitLines(stdout)) {
    const m = line.match(/^(\S+)\t(.*) \((fetch|push)\)$/);
    if (m === null) continue;
    const name = m[1] as string;
    const entry = byName.get(name) ?? { fetch: null, push: null };
    if (m[3] === "fetch") entry.fetch = m[2] as string;
    else entry.push = m[2] as string;
    byName.set(name, entry);
  }
  return [...byName.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, urls]) => ({ name, fetch: urls.fetch, push: urls.push }));
}

// ---------------------------------------------------------------------------
// worktrees — `git worktree list --porcelain`

export type WorktreeRecord = {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
};

/**
 * Parse `git worktree list --porcelain`: blank-line-separated stanzas of
 * "<key> <value>" lines. The plain listing pads columns for human reading and
 * gives no way to tell padding apart from a path that contains spaces.
 */
export function parseWorktrees(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const stanza of stdout.split("\n\n")) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of splitLines(stanza)) {
      const space = line.indexOf(" ");
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? "" : line.slice(space + 1);
      if (key === "worktree") path = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value;
      else if (key === "detached") detached = true;
      else if (key === "bare") bare = true;
      else if (key === "locked") locked = true;
      else if (key === "prunable") prunable = true;
    }
    if (path !== null) records.push({ path, head, branch, detached, bare, locked, prunable });
  }
  return records.sort(byPath);
}

// ---------------------------------------------------------------------------
// stashes — `git stash list --format=...`

export type StashRecord = {
  readonly ref: string;
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
};

export const STASH_FORMAT = "%x1e%gd%x00%H%x00%gs%x00%aI";

export function parseStashes(stdout: string): StashRecord[] {
  const stashes: StashRecord[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    if (record === "") continue;
    const f = record.replace(/\n+$/, "").split(FIELD_SEP);
    if (f.length < 4) continue;
    stashes.push({
      ref: f[0] as string,
      sha: f[1] as string,
      subject: f[2] as string,
      date: f[3] as string,
    });
  }
  return stashes;
}

// ---------------------------------------------------------------------------
// conflict markers

export type ConflictRegion = {
  /** 1-based line of the "<<<<<<<" marker. */
  readonly startLine: number;
  /** 1-based line of the "=======" separator, or null when malformed. */
  readonly separatorLine: number | null;
  /** 1-based line of the ">>>>>>>" marker, or null when unterminated. */
  readonly endLine: number | null;
  readonly oursLabel: string;
  readonly theirsLabel: string;
};

/**
 * Locate merge-conflict regions in a file's text.
 *
 * Markers are matched only at the start of a line, with git's exact
 * seven-character runs, so prose that merely mentions the marker mid-sentence
 * is not mistaken for one. An unterminated region is reported with nulls rather
 * than dropped — a half-written conflict is exactly what the caller needs told.
 */
export function locateConflicts(text: string): ConflictRegion[] {
  const lines = text.split("\n");
  const regions: ConflictRegion[] = [];
  let start: number | null = null;
  let separator: number | null = null;
  let ours = "";
  const flushUnterminated = (): void => {
    if (start === null) return;
    regions.push({
      startLine: start,
      separatorLine: separator,
      endLine: null,
      oursLabel: ours,
      theirsLabel: "",
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("<<<<<<<")) {
      flushUnterminated();
      start = i + 1;
      separator = null;
      ours = line.slice(7).trim();
    } else if (start !== null && line.trim() === "=======") {
      separator = i + 1;
    } else if (start !== null && line.startsWith(">>>>>>>")) {
      regions.push({
        startLine: start,
        separatorLine: separator,
        endLine: i + 1,
        oursLabel: ours,
        theirsLabel: line.slice(7).trim(),
      });
      start = null;
      separator = null;
      ours = "";
    }
  }
  flushUnterminated();
  return regions;
}

// ---------------------------------------------------------------------------
// object info — `git cat-file --batch-check`

export type ObjectInfo = {
  readonly ref: string;
  readonly sha: string | null;
  readonly type: string | null;
  readonly missing: boolean;
};

/**
 * Parse `git cat-file --batch-check='%(objectname) %(objecttype)'`.
 *
 * One spawn resolves every requested revision at once, and an unknown one comes
 * back as "<what-was-asked> missing" on its own line instead of failing the
 * whole batch — which is why this beats one `git rev-parse` per ref.
 */
export function parseBatchCheck(stdout: string, refs: readonly string[]): ObjectInfo[] {
  const lines = splitLines(stdout);
  return refs.map((ref, i) => {
    const line = lines[i];
    if (line === undefined || line.endsWith(" missing") || line.endsWith(" ambiguous")) {
      return { ref, sha: null, type: null, missing: true };
    }
    const parts = line.split(" ");
    return { ref, sha: parts[0] ?? null, type: parts[1] ?? null, missing: false };
  });
}
