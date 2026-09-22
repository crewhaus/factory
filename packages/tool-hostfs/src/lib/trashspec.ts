/**
 * The FreeDesktop Trash specification, as pure functions.
 *
 * Everything here was checked against a reference implementation rather than
 * against the prose: `gio trash` (GLib 2.80, Alpine 3.19) was run on a real
 * Linux filesystem and the resulting `.trashinfo` files were read back byte
 * for byte. The fixtures in `../fixtures.ts` are those bytes, and the tests
 * assert this module reproduces them exactly, because "roughly the right
 * format" means a desktop trash that cannot restore the file.
 *
 * What the reference pinned down, and the prose does not spell out:
 *
 *   - `Path=` is percent-encoded with GLib's escape set: every byte outside
 *     `A-Z a-z 0-9 - . _ ~` is escaped, EXCEPT `/`, which stays literal.
 *     `encodeURIComponent` is not this function — it leaves `!*'()` alone,
 *     so `spaced name #1 (copy).txt` would come out differently from what
 *     every desktop trash writes. The recorded bytes are
 *     `spaced%20name%20%231%20%28copy%29.txt`.
 *   - `DeletionDate` is LOCAL time with no zone suffix, to the second.
 *   - A name collision is resolved by inserting `.2`, `.3`, … before the
 *     extension (`simple.txt` → `simple.2.txt`, recorded), and the claim is
 *     made by creating the info file with `O_EXCL` so two processes cannot
 *     both take the name.
 */

/** GLib's unreserved set for a path: everything else is percent-encoded. */
const UNRESERVED = /[A-Za-z0-9\-._~/]/;

/**
 * Percent-encode an absolute path for the `Path=` field.
 *
 * Encoding is per BYTE of the UTF-8 form, not per character: `café` becomes
 * `caf%C3%A9` (recorded from gio), and a per-character encoder would write
 * something no other implementation can read back.
 */
export function encodeTrashPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && UNRESERVED.test(char)) {
      out += char;
      continue;
    }
    out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The inverse, for reading an existing `.trashinfo` back. */
export function decodeTrashPath(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const char = encoded[i] as string;
    if (char === "%" && i + 2 < encoded.length) {
      const hex = encoded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * `DeletionDate` — local wall-clock time, `YYYY-MM-DDThh:mm:ss`, no zone.
 *
 * The offset is a parameter rather than a read of the host's timezone so a
 * test can assert the exact bytes without depending on where the machine
 * thinks it is; the tool passes the offset the host's own `Date` reports.
 */
export function formatDeletionDate(epochMs: number, offsetMinutes: number): string {
  const local = new Date(epochMs - offsetMinutes * 60_000);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

export type TrashInfo = {
  /** The original location: absolute, or relative to the top directory. */
  readonly originalPath: string;
  readonly deletionDate: string;
};

/**
 * The exact bytes of a `.trashinfo` file, trailing newline included.
 *
 * Verified against gio's output: a `[Trash Info]` header, `Path=` then
 * `DeletionDate=`, in that order.
 */
export function renderTrashInfo(info: TrashInfo): string {
  return `[Trash Info]\nPath=${encodeTrashPath(info.originalPath)}\nDeletionDate=${info.deletionDate}\n`;
}

/** Read a `.trashinfo` back; `undefined` when it is not one. */
export function parseTrashInfo(text: string): TrashInfo | undefined {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "[Trash Info]") return undefined;
  let originalPath: string | undefined;
  let deletionDate: string | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith("Path=")) originalPath ??= decodeTrashPath(line.slice("Path=".length));
    if (line.startsWith("DeletionDate=")) {
      deletionDate ??= line.slice("DeletionDate=".length).trim();
    }
  }
  if (originalPath === undefined || deletionDate === undefined) return undefined;
  return { originalPath, deletionDate };
}

/**
 * The names to try for a file entering the trash, in order.
 *
 * gio's scheme, and it is NOT the obvious one — this was captured rather than
 * guessed, because the guess was wrong. The suffix goes before the FIRST dot,
 * not the last:
 *
 *     simple.txt      → simple.2.txt
 *     archive.tar.gz  → archive.2.tar.gz     (not archive.tar.2.gz)
 *     .env            → .2.env               (the leading dot counts)
 *     plaindir        → plaindir.2           (no dot, so it goes at the end)
 *
 * Which matters because a desktop trash lists these names to a person, and
 * `archive.tar.2.gz` is a name that no longer says what the file is.
 */
export function* candidateNames(basename: string, limit = 1_000): Generator<string> {
  yield basename;
  const dot = basename.indexOf(".");
  const stem = dot === -1 ? basename : basename.slice(0, dot);
  const extension = dot === -1 ? "" : basename.slice(dot);
  for (let n = 2; n <= limit; n += 1) {
    yield `${stem}.${n}${extension}`;
  }
}

/**
 * Is `$topdir/.Trash` usable, per the spec's two checks?
 *
 * Both are security checks, not tidiness: a `.Trash` that is a SYMLINK can
 * point anywhere (so a file "moved to the trash" lands somewhere an attacker
 * chose), and one without the STICKY BIT lets any user on the machine delete
 * or replace another user's trashed files. The spec says an implementation
 * that finds either MUST NOT use the directory, and this returns the reason
 * so the refusal can say which one it was.
 */
export function checkTopdirTrash(facts: {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly mode: number;
}): { readonly usable: boolean; readonly reason?: string } {
  if (!facts.exists) return { usable: false, reason: "it does not exist" };
  if (facts.isSymlink) {
    return { usable: false, reason: "it is a symbolic link, which the spec forbids trusting" };
  }
  if (!facts.isDirectory) return { usable: false, reason: "it is not a directory" };
  // 0o1000 is the sticky bit.
  if ((facts.mode & 0o1000) === 0) {
    return { usable: false, reason: "it does not have the sticky bit set" };
  }
  return { usable: true };
}

/** `$topdir/.Trash/$uid` — the shared top-directory trash. */
export function sharedTopdirTrash(topdir: string, uid: number): string {
  return `${stripTrailingSlash(topdir)}/.Trash/${uid}`;
}

/** `$topdir/.Trash-$uid` — the per-user fallback when the shared one is unusable. */
export function userTopdirTrash(topdir: string, uid: number): string {
  return `${stripTrailingSlash(topdir)}/.Trash-${uid}`;
}

/** `$XDG_DATA_HOME/Trash`, with the spec's default for an unset variable. */
export function homeTrashDir(identity: {
  readonly home: string | undefined;
  readonly xdgDataHome: string | undefined;
}): string | undefined {
  // `$XDG_DATA_HOME` is only honoured when it is ABSOLUTE: the XDG base
  // directory spec says a relative value must be ignored, and honouring one
  // would resolve the trash against whatever directory the harness happens to
  // be running in.
  const explicit =
    identity.xdgDataHome?.startsWith("/") === true ? identity.xdgDataHome : undefined;
  const dataHome =
    explicit ??
    (identity.home === undefined ? undefined : `${stripTrailingSlash(identity.home)}/.local/share`);
  if (dataHome === undefined) return undefined;
  return `${stripTrailingSlash(dataHome)}/Trash`;
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * The `Path=` value to record.
 *
 * The spec says a top-directory trash SHOULD store a path relative to the
 * top directory, so the entry survives the volume being mounted somewhere
 * else — which is the case a USB stick hits every time. The home trash
 * stores an absolute path.
 */
export function infoPathFor(originalAbs: string, topdir: string | undefined): string {
  if (topdir === undefined) return originalAbs;
  const base = stripTrailingSlash(topdir);
  if (base === "/" || !originalAbs.startsWith(`${base}/`)) return originalAbs;
  return originalAbs.slice(base.length + 1);
}
