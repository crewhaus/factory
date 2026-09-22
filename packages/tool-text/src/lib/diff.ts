export type DiffOp = { readonly kind: "eq" | "del" | "ins"; readonly line: string };

/**
 * Line-level diff via the classic longest-common-subsequence dynamic
 * program. O(n*m) in time and memory, which is why the tool caps its input:
 * diffing two 50k-line files would allocate a 2.5-billion-cell table.
 * Callers with bigger inputs should diff a narrowed region instead.
 */
export function diffLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] as string });
      i++;
      j++;
      continue;
    }
    const down = (lcs[i + 1] as number[])[j] as number;
    const right = (lcs[i] as number[])[j + 1] as number;
    if (down >= right) {
      ops.push({ kind: "del", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "ins", line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", line: a[i++] as string });
  while (j < m) ops.push({ kind: "ins", line: b[j++] as string });
  return ops;
}

export type DiffStats = { readonly added: number; readonly removed: number; readonly same: number };

/** Count each op kind — the "+12 -3" summary a reviewer actually reads. */
export function diffStats(ops: ReadonlyArray<DiffOp>): DiffStats {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const op of ops) {
    if (op.kind === "ins") added++;
    else if (op.kind === "del") removed++;
    else same++;
  }
  return { added, removed, same };
}

/**
 * Render ops as a unified diff keeping `context` unchanged lines around each
 * change. Long runs of unchanged lines collapse, which is the entire point:
 * the reader sees the change, not the file.
 */
export function renderUnified(
  ops: ReadonlyArray<DiffOp>,
  aLabel: string,
  bLabel: string,
  context: number,
): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.kind === "eq") continue;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
      keep[j] = true;
    }
  }
  const out: string[] = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let aLine = 1;
  let bLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      const op = ops[i] as DiffOp;
      if (op.kind !== "ins") aLine++;
      if (op.kind !== "del") bLine++;
      i++;
      continue;
    }
    const hunkStartA = aLine;
    const hunkStartB = bLine;
    const body: string[] = [];
    let aCount = 0;
    let bCount = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i] as DiffOp;
      if (op.kind === "eq") {
        body.push(` ${op.line}`);
        aLine++;
        bLine++;
        aCount++;
        bCount++;
      } else if (op.kind === "del") {
        body.push(`-${op.line}`);
        aLine++;
        aCount++;
      } else {
        body.push(`+${op.line}`);
        bLine++;
        bCount++;
      }
      i++;
    }
    out.push(`@@ -${hunkStartA},${aCount} +${hunkStartB},${bCount} @@`);
    out.push(...body);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The other direction: a unified diff read back into structure.
//
// The load-bearing output is `newLine`. A caller finds something on an added
// line and then edits that line without re-reading the file, so an off-by-one
// here silently corrupts every automated fix downstream. Everything in this
// section — the counters, the count-driven hunk boundary, the first-column
// rule — exists to keep that number exact.
// ---------------------------------------------------------------------------

/** What a body line does to the file: unchanged, introduced, or taken away. */
export type DiffLineKind = "context" | "added" | "removed";

export type ParsedDiffLine = {
  readonly kind: DiffLineKind;
  /** 1-based line number in the NEW file; null on a removed line, which has none. */
  readonly newLine: number | null;
  /** 1-based line number in the OLD file; null on an added line. */
  readonly oldLine: number | null;
  /** The content with the marker column removed — never including the marker. */
  readonly text: string;
  /** A `\ No newline at end of file` marker followed this line. */
  readonly noNewline?: boolean;
};

export type ParsedHunk = {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** What git prints after the closing `@@` — usually the enclosing function. */
  readonly section: string;
  readonly lines: ReadonlyArray<ParsedDiffLine>;
};

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export type ParsedDiffFile = {
  /** Path in the old tree, prefix stripped; null when the file was added (`/dev/null`). */
  readonly oldPath: string | null;
  /** Path in the new tree, prefix stripped; null when the file was deleted. */
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly renamed: boolean;
  readonly added: number;
  readonly removed: number;
  /** The old file's last line had no terminating newline. */
  readonly oldNoFinalNewline: boolean;
  /** The new file's last line had no terminating newline. */
  readonly newNoFinalNewline: boolean;
  readonly oldMode?: string;
  readonly newMode?: string;
  /** Percentage from a `similarity index` line, on a rename or a copy. */
  readonly similarity?: number;
  /** Empty for a rename, a mode change or a binary file — those carry no body. */
  readonly hunks: ReadonlyArray<ParsedHunk>;
};

export type ParsedDiff = {
  readonly files: ReadonlyArray<ParsedDiffFile>;
  /** Everything the parser could not account for, so a caller is never silently short. */
  readonly warnings: ReadonlyArray<string>;
};

/** Standard hunk header. A missing count means 1 — `@@ -1 +1 @@` is one line. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
/** A merge/combined diff (`@@@ -1,2 -1,2 +1,3 @@@`) carries one column per parent. */
const COMBINED_HEADER = /^@@@+ /;

/** Mutable twin of the returned shapes, used while a stanza is still filling in. */
type LineDraft = {
  kind: DiffLineKind;
  newLine: number | null;
  oldLine: number | null;
  text: string;
  noNewline?: boolean;
};

type FileDraft = {
  guessOld: string | null;
  guessNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  sawOldHeader: boolean;
  sawNewHeader: boolean;
  status: DiffFileStatus;
  binary: boolean;
  renamed: boolean;
  added: number;
  removed: number;
  oldNoFinalNewline: boolean;
  newNoFinalNewline: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: ParsedHunk[];
};

/**
 * Undo git's C-style path quoting. git quotes only when it has to — a control
 * character, a quote, a backslash, or (unless `core.quotePath=false`) a
 * non-ASCII byte — and it escapes per BYTE, so the octal escapes have to be
 * reassembled into bytes and decoded as UTF-8. Decoding them as code points
 * turns every accented filename into mojibake.
 */
function dequotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const encoder = new TextEncoder();
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      for (const b of encoder.encode(ch)) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i++;
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3) {
        const digit = body[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += digit;
        i++;
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    for (const b of encoder.encode(next)) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Drop the `a/`/`b/` diff prefix; `/dev/null` means the file is absent on that side. */
function stripPrefix(value: string, prefix: "a/" | "b/"): string | null {
  // Deliberately no trim: a leading or trailing space is part of the filename,
  // and git does not quote one. Every caller slices to an exact boundary.
  const v = dequotePath(value);
  if (v === "/dev/null") return null;
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

/**
 * Read a path off a `---`/`+++` line. Plain `diff -u` appends a tab and a
 * timestamp, which is not part of the name.
 */
function headerPath(rest: string, prefix: "a/" | "b/"): string | null {
  const tab = rest.indexOf("\t");
  return stripPrefix(tab === -1 ? rest : rest.slice(0, tab), prefix);
}

/**
 * Split `a/<old> b/<new>` off a `diff --git` line. Paths may contain spaces —
 * git does not quote those — so the only sound split is the one where both
 * halves name the same file, which is every case except a rename or a copy.
 * Those carry explicit `rename from`/`rename to` lines that overwrite this
 * guess, so the fallback only has to be reasonable, not right.
 */
function splitGitHeader(rest: string): { old: string | null; new: string | null } {
  // Quoting is decided per path, so a rename can quote one side only. Either
  // quote is an unambiguous split point, which beats guessing at the spaces.
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "\\") i += 2;
      else if (rest[i] === '"') break;
      else i++;
    }
    return {
      old: stripPrefix(rest.slice(0, i + 1), "a/"),
      new: stripPrefix(rest.slice(i + 2), "b/"),
    };
  }
  const quotedNew = rest.indexOf(' "b/');
  if (quotedNew !== -1) {
    return {
      old: stripPrefix(rest.slice(0, quotedNew), "a/"),
      new: stripPrefix(rest.slice(quotedNew + 1), "b/"),
    };
  }
  let fallback: { old: string | null; new: string | null } | null = null;
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    const left = stripPrefix(rest.slice(0, at), "a/");
    const right = stripPrefix(rest.slice(at + 1), "b/");
    if (left !== null && left === right) return { old: left, new: right };
    fallback ??= { old: left, new: right };
  }
  return fallback ?? { old: null, new: null };
}

function newFileDraft(): FileDraft {
  return {
    guessOld: null,
    guessNew: null,
    headerOld: null,
    headerNew: null,
    sawOldHeader: false,
    sawNewHeader: false,
    status: "modified",
    binary: false,
    renamed: false,
    added: 0,
    removed: 0,
    oldNoFinalNewline: false,
    newNoFinalNewline: false,
    hunks: [],
  };
}

function finishFile(draft: FileDraft): ParsedDiffFile {
  // `---`/`+++` win when present: they are what a patch applier reads, and
  // they are the only place `/dev/null` appears. The `diff --git` guess and
  // the rename stanza are the fallback, for a file with no body at all.
  return {
    oldPath: draft.sawOldHeader ? draft.headerOld : draft.guessOld,
    newPath: draft.sawNewHeader ? draft.headerNew : draft.guessNew,
    status: draft.status,
    binary: draft.binary,
    renamed: draft.renamed,
    added: draft.added,
    removed: draft.removed,
    oldNoFinalNewline: draft.oldNoFinalNewline,
    newNoFinalNewline: draft.newNoFinalNewline,
    ...(draft.oldMode !== undefined ? { oldMode: draft.oldMode } : {}),
    ...(draft.newMode !== undefined ? { newMode: draft.newMode } : {}),
    ...(draft.similarity !== undefined ? { similarity: draft.similarity } : {}),
    hunks: draft.hunks,
  };
}

/**
 * Split the diff into lines. A diff transported as CRLF has a `\r` on every
 * line including its headers; a LF diff of a CRLF-content file has one only
 * on the content lines, where it is real data. Deciding once, for the whole
 * document, is the only way to tell those apart — per line it is undecidable.
 */
function splitDiffLines(diff: string): string[] {
  const uniformCrlf = diff.includes("\r\n") && !/(^|[^\r])\n/.test(diff);
  const lines = diff.split(uniformCrlf ? "\r\n" : "\n");
  // A trailing newline ends the last line; it does not begin another one.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Structural lines are ASCII markers, so a stray `\r` on one is transport, not data. */
const structural = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

/**
 * Parse a unified diff — `git diff`, `git show`, `diff -u`, a patch file —
 * into files, hunks and lines, each line carrying its number in the new file.
 *
 * Unparseable input never throws and never guesses: whatever could not be
 * accounted for comes back in `warnings`, because a caller about to edit a
 * file from these numbers needs to know the parse was incomplete.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = splitDiffLines(diff);
  const files: ParsedDiffFile[] = [];
  const warnings: string[] = [];
  let draft: FileDraft | null = null;
  let i = 0;

  const flush = (): void => {
    if (draft !== null) files.push(finishFile(draft));
    draft = null;
  };
  /** Meta lines only make sense inside a stanza; tolerate a patch that omits one. */
  const current = (): FileDraft => {
    if (draft === null) draft = newFileDraft();
    return draft;
  };

  while (i < lines.length) {
    const line = structural(lines[i] as string);

    if (line.startsWith("diff --git ")) {
      flush();
      const split = splitGitHeader(line.slice("diff --git ".length));
      const fresh = newFileDraft();
      fresh.guessOld = split.old;
      fresh.guessNew = split.new;
      draft = fresh;
      i++;
      continue;
    }

    // Plain `diff -u` has no `diff --git` line, so the `---`/`+++` pair is
    // what starts a file. Requiring the `+++` on the next line is what keeps
    // `git format-patch`'s bare `---` separator from opening an empty stanza.
    if (line.startsWith("--- ") && structural(lines[i + 1] ?? "").startsWith("+++ ")) {
      if (draft === null || draft.sawOldHeader || draft.hunks.length > 0) {
        flush();
        draft = newFileDraft();
      }
      const file = current();
      file.sawOldHeader = true;
      file.headerOld = headerPath(line.slice(4), "a/");
      if (file.headerOld === null) file.status = "added";
      i++;
      continue;
    }
    if (line.startsWith("+++ ") && draft !== null && draft.sawOldHeader) {
      draft.sawNewHeader = true;
      draft.headerNew = headerPath(line.slice(4), "b/");
      if (draft.headerNew === null) draft.status = "deleted";
      i++;
      continue;
    }

    if (COMBINED_HEADER.test(line)) {
      // A merge diff has one marker column per parent, so single-column line
      // numbers would be wrong. Refusing beats returning a plausible lie.
      warnings.push(
        `line ${i + 1}: combined (merge) diff hunk skipped — it has one column per parent, which this parser does not number`,
      );
      i++;
      while (i < lines.length && !structural(lines[i] as string).startsWith("diff ")) i++;
      continue;
    }

    if (HUNK_HEADER.test(line)) {
      i = readHunk(lines, i, current(), warnings);
      continue;
    }

    if (line.startsWith("Binary files ") || line.startsWith("Binary file ")) {
      current().binary = true;
      i++;
      continue;
    }
    if (line === "GIT binary patch") {
      // The payload is base85, whose lines begin with a length letter and
      // would otherwise read as stray content. Skip to the next stanza.
      current().binary = true;
      i++;
      while (i < lines.length && !structural(lines[i] as string).startsWith("diff ")) i++;
      continue;
    }

    if (draft !== null) {
      const file = draft;
      const meta = (prefix: string): string | null =>
        // No trim: the rest of a `rename from` line is the path, spaces and all.
        line.startsWith(prefix) ? line.slice(prefix.length) : null;

      const newFileMode = meta("new file mode ");
      const deletedFileMode = meta("deleted file mode ");
      const oldMode = meta("old mode ");
      const newMode = meta("new mode ");
      const renameFrom = meta("rename from ");
      const renameTo = meta("rename to ");
      const copyFrom = meta("copy from ");
      const copyTo = meta("copy to ");
      const similarity = meta("similarity index ");

      if (newFileMode !== null) {
        file.status = "added";
        file.newMode = newFileMode;
      } else if (deletedFileMode !== null) {
        file.status = "deleted";
        file.oldMode = deletedFileMode;
      } else if (oldMode !== null) {
        file.oldMode = oldMode;
      } else if (newMode !== null) {
        file.newMode = newMode;
      } else if (renameFrom !== null) {
        file.renamed = true;
        file.status = "renamed";
        file.guessOld = dequotePath(renameFrom);
      } else if (renameTo !== null) {
        file.renamed = true;
        file.status = "renamed";
        file.guessNew = dequotePath(renameTo);
      } else if (copyFrom !== null) {
        file.status = "copied";
        file.guessOld = dequotePath(copyFrom);
      } else if (copyTo !== null) {
        file.status = "copied";
        file.guessNew = dequotePath(copyTo);
      } else if (similarity !== null) {
        const pct = Number.parseInt(similarity, 10);
        if (Number.isFinite(pct)) file.similarity = pct;
      } else if (line.startsWith("index ")) {
        // `index <old>..<new> <mode>` — the mode is present only when unchanged.
        const mode = /^index [^ ]+ (\d{6})$/.exec(line)?.[1];
        if (mode !== undefined) {
          file.oldMode ??= mode;
          file.newMode ??= mode;
        }
      }
    }
    i++;
  }

  flush();
  return { files, warnings };
}

/**
 * Consume one hunk, returning the index of the first line after it.
 *
 * The hunk header's counts, not the line markers, decide where the body ends.
 * That matters: removing a line that itself starts with `--` renders as
 * `--- foo`, and an added `+++ b/x` renders as `++++ b/x`. Inside the body
 * the FIRST COLUMN is the marker and everything after it is data, so only the
 * counts can say when the body is over.
 */
function readHunk(
  lines: ReadonlyArray<string>,
  start: number,
  file: FileDraft,
  warnings: string[],
): number {
  const match = HUNK_HEADER.exec(structural(lines[start] as string));
  if (match === null) return start + 1;
  const oldStart = Number.parseInt(match[1] as string, 10);
  const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newStart = Number.parseInt(match[3] as string, 10);
  const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);

  let oldLine = oldStart;
  let newLine = newStart;
  let oldLeft = oldCount;
  let newLeft = newCount;
  const body: LineDraft[] = [];
  let i = start + 1;

  /** `\ No newline at end of file` describes the line above it and costs no count. */
  const markNoNewline = (): void => {
    const last = body[body.length - 1];
    if (last === undefined) return;
    last.noNewline = true;
    if (last.kind !== "added") file.oldNoFinalNewline = true;
    if (last.kind !== "removed") file.newNoFinalNewline = true;
  };

  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const raw = lines[i] as string;
    if (raw.startsWith("\\")) {
      markNoNewline();
      i++;
      continue;
    }
    const marker = raw.charAt(0);
    // An entirely empty line is a context line whose single leading space was
    // eaten in transit — mail clients and editors strip trailing whitespace
    // routinely, and git itself never emits one, so this is always that.
    if (marker === " " || raw === "") {
      body.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.slice(1) });
      oldLeft--;
      newLeft--;
    } else if (marker === "+") {
      body.push({ kind: "added", oldLine: null, newLine: newLine++, text: raw.slice(1) });
      newLeft--;
      file.added++;
    } else if (marker === "-") {
      body.push({ kind: "removed", oldLine: oldLine++, newLine: null, text: raw.slice(1) });
      oldLeft--;
      file.removed++;
    } else {
      warnings.push(
        `line ${i + 1}: hunk body ended early at an unrecognized marker ${JSON.stringify(marker)}`,
      );
      break;
    }
    i++;
  }
  if (i < lines.length && (lines[i] as string).startsWith("\\")) {
    markNoNewline();
    i++;
  }
  if (oldLeft > 0 || newLeft > 0) {
    warnings.push(
      `line ${start + 1}: hunk @@ -${oldStart},${oldCount} +${newStart},${newCount} @@ is short by ${oldLeft} old and ${newLeft} new lines — the diff is truncated`,
    );
  } else {
    // The counts, not the markers, ended the body — so a count that was too
    // small drops real lines silently. A bare `+` after the body can only be
    // that: `+++ ` is the only stanza line starting with one. The `-` side
    // gets no such check, because `-- ` is format-patch's mail signature.
    const after = lines[i];
    if (after?.startsWith("+") && !after.startsWith("+++ ")) {
      warnings.push(
        `line ${i + 1}: content past the end of hunk @@ -${oldStart},${oldCount} +${newStart},${newCount} @@ — its line counts are too small and lines were dropped`,
      );
    }
  }

  file.hunks.push({
    oldStart,
    oldCount,
    newStart,
    newCount,
    section: match[5] ?? "",
    lines: body as ReadonlyArray<ParsedDiffLine>,
  });
  return i;
}
