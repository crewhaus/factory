/**
 * Where a path-kind operative value really lands, for the permission gate.
 *
 * The matcher (`@crewhaus/tool-permission-matcher`) and the subject builder
 * (`preparePermissionSubject` in `@crewhaus/tool-executor`) are pure — the
 * worker runtime runs them on a Cloudflare Worker, where there is no
 * filesystem to ask. Following symlinks needs one, so it lives here, in the
 * Node runtime that owns the workspace, and is handed to the subject builder
 * as its `canonicalizePath`.
 *
 * A path is resolved against the workspace root, `..` collapsed, and its
 * directories followed through symlinks (the deepest one that exists is
 * realpath'd) — so it names the place the tool will actually touch — then
 * written relative to the workspace. When the last component exists, it is
 * written the way the directory stores it: on a filesystem that ignores case
 * or Unicode normal form (macOS, Windows), `.ENV` opens `.env`, and a rule
 * about `.env` must see that. When the last component is itself a symlink,
 * its target is a second value. A path that ends up outside the workspace,
 * whose destination cannot be worked out, or that is longer than any path can
 * be ({@link MAX_PATH_CHARS}), is flagged; the matcher never lets it satisfy
 * an allow rule and always lets it satisfy a deny or ask.
 * A path on a filesystem that ignores case (or where that cannot be told) is
 * marked `caseInsensitive`, so a deny or ask compares it ignoring case — the
 * name a tool is about to CREATE has no stored spelling to read. A path that
 * names an existing file (or a link to one) is marked `notDirectory`: a tool
 * that walks what a directory holds finds nothing beneath it.
 *
 * The workspace root can itself be reached another way — the shell's `$PWD`
 * through a symlinked directory, or a top-level symlink such as macOS's
 * `/tmp` → `/private/tmp` — and a rule may name it that way:
 * `alwaysDeny Write(/tmp/ws/.crewhaus/**)` while the runtime's cwd reads
 * `/private/tmp/ws`. The same location under each of those spellings of the
 * root is a further spelling, so such a deny is not dodged by a relative
 * path. (A spelling, not a canonical value: it widens what a deny or ask
 * catches, never what an allow grants.)
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalPlace } from "@crewhaus/session-store";
import type {
  PathCanonicalizer,
  ProgramPathReader,
  ProgramPathReading,
} from "@crewhaus/tool-executor";
import { physicalPath } from "@crewhaus/tool-safety/fs";

type OperativeValue = ReturnType<PathCanonicalizer>[number];

function toPosix(p: string): string {
  return path.sep === "\\" ? p.split(path.sep).join("/") : p;
}

/**
 * The longest path this resolves, in UTF-16 code units; a longer one is
 * refused before it is walked. Nothing that long can be opened or created:
 * PATH_MAX is 1,024 bytes on macOS and 4,096 on Linux, Windows stops at
 * 32,767 UTF-16 units, and a path's UTF-8 form is never shorter than its
 * UTF-16 one. The limit is twice that because the part of a path that exists
 * is itself under PATH_MAX, so the part that does not is over PATH_MAX on its
 * own: no spelling of the place reaches it, not even one through a symlink
 * that shortens the part that exists.
 */
export const MAX_PATH_CHARS =
  2 * (process.platform === "darwin" ? 1_024 : process.platform === "win32" ? 32_767 : 4_096);

/** Top-level symlinks and the directory each resolves to, read once per process. */
let topLevelLinksRead: ReadonlyArray<readonly [string, string]> | undefined;

function topLevelLinks(): ReadonlyArray<readonly [string, string]> {
  if (topLevelLinksRead !== undefined) return topLevelLinksRead;
  const out: Array<readonly [string, string]> = [];
  const top = path.parse(path.resolve("/")).root;
  try {
    for (const entry of readdirSync(top, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const link = path.join(top, entry.name);
      try {
        out.push([link, realpathSync(link)]);
      } catch {
        // A dangling top-level link names no directory a workspace is in.
      }
    }
  } catch {
    // An unreadable root has no aliases to offer.
  }
  topLevelLinksRead = out;
  return out;
}

/** Where the workspace root's other spellings come from; tests pass their own. */
export type RootSpellingSources = {
  /** The shell's logical working directory. Default `process.env.PWD`. */
  readonly pwd?: string | undefined;
  /** Top-level symlinks and their resolved targets. Default: read from `/`. */
  readonly topLevelLinks?: ReadonlyArray<readonly [string, string]>;
};

/**
 * The other absolute spellings of the workspace root `rootReal` (already
 * realpath'd): the root as given, `$PWD` when it resolves to the root, and
 * the root under each top-level symlink whose target contains it.
 */
function rootAliases(rootAbs: string, rootReal: string, sources: RootSpellingSources): string[] {
  const out = new Set<string>();
  if (rootAbs !== rootReal) out.add(rootAbs);
  const pwd = "pwd" in sources ? sources.pwd : process.env["PWD"];
  if (pwd !== undefined && path.isAbsolute(pwd)) {
    try {
      if (realpathSync(pwd) === rootReal) out.add(path.resolve(pwd));
    } catch {
      // A $PWD that no longer resolves names nothing.
    }
  }
  for (const [link, target] of sources.topLevelLinks ?? topLevelLinks()) {
    if (rootReal === target) out.add(link);
    else if (rootReal.startsWith(target.endsWith(path.sep) ? target : `${target}${path.sep}`)) {
      out.add(`${link}${rootReal.slice(target.length)}`);
    }
  }
  out.delete(rootReal);
  return [...out];
}

/** A relative path that leaves its base: `..`, `../x`, or another drive. */
function climbsOut(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** True when the NAME exists, whether or not a symlink there leads anywhere. */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `p` names an existing entry that is not a directory, following a
 * symlink: nothing lies beneath it. A dangling link, or a name that is not
 * there, is not known to be a file, so a tool that walks directories may
 * still find something beneath it by the time it runs.
 */
function isNonDirectory(p: string): boolean {
  try {
    return !statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where `target` would land with every symlink on the way followed — the
 * deepest ancestor that exists is resolved, a dangling link is followed a hop
 * by hand (a missing target is still a door), and the parts that do not exist
 * yet are appended. Mirrors `resolveLocation` in `@crewhaus/tool-fs`, which is
 * what the file tools check containment against. Throws when the chain
 * cannot be resolved; the caller treats that as "cannot tell where it lands".
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  const { probe, tail } = deepestName(target);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const link = readlinkSync(probe);
    real = resolveLocation(path.resolve(realpathSync(path.dirname(probe)), link), depth + 1);
  }
  // One string, not one argument per name: Bun's `path.join` keeps only
  // (argument count mod 65,536) of its arguments, so 65,536 missing names
  // would give back `real` alone — a path the tool, whose own walk has one
  // name more, does not act on.
  return tail.length > 0 ? path.join(real, tail) : real;
}

/**
 * `target`, an absolute path, split where its deepest prefix that exists as
 * a NAME ends: that prefix, and the names below it, which do not exist, as
 * one string ("" when `target` itself exists). This is `path.dirname` and
 * `path.basename` worked by index on `target` itself: handing them each
 * shorter prefix in turn copied the rest of the path once per missing name,
 * the square of a count the caller picks.
 */
function deepestName(target: string): { readonly probe: string; readonly tail: string } {
  const top = path.parse(target).root.length;
  const isSep = (i: number): boolean => target[i] === "/" || target[i] === path.sep;
  let probe = target;
  let start = target.length;
  let stop = -1;
  while (!nameExists(probe)) {
    // `path.basename(probe)` is `target.slice(start, end)`, and
    // `path.dirname(probe)` is `target.slice(0, up)`.
    let end = probe.length;
    while (end > top && isSep(end - 1)) end--;
    if (stop < 0) stop = end;
    start = end;
    while (start > top && !isSep(start - 1)) start--;
    const up = start > top ? start - 1 : top;
    if (up === probe.length) break; // reached the filesystem root
    probe = target.slice(0, up);
  }
  return { probe, tail: stop < 0 ? "" : target.slice(start, stop) };
}

/** Two paths that are the same directory entry: same device, same inode. */
function sameEntry(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** Case and Unicode normal form folded away — how a folding filesystem compares names. */
function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * How the directory `dir` stores the existing entry the caller named `name`:
 * `[name]` when that is an entry as spelled, otherwise the entry (or, for a
 * name with several hard links there, the entries) the filesystem resolved it
 * to — `.env` for `.ENV` on a case-insensitive volume. `undefined` when the
 * directory cannot be listed or no entry is that file: the caller cannot tell
 * which name a rule should see.
 */
function storedNames(dir: string, name: string): string[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  if (entries.includes(name)) return [name];
  const at = path.join(dir, name);
  // A folding filesystem resolves `name` to an entry that folds the same way;
  // look at those first, and at every entry only if its folding is not ours.
  const folded = foldName(name);
  const likely = entries.filter((e) => foldName(e) === folded && sameEntry(path.join(dir, e), at));
  if (likely.length > 0) return likely;
  const any = entries.filter((e) => sameEntry(path.join(dir, e), at));
  return any.length > 0 ? any : undefined;
}

/**
 * Does the filesystem at `dir` treat names that differ only in letter case as
 * the same? Asked of the nearest existing directory whose own name has a
 * letter: its name with the case swapped either finds the same directory
 * (yes) or nothing (no). `undefined` when no such directory answers.
 */
function ignoresCase(dir: string): boolean | undefined {
  // `path.basename` and `path.dirname` worked by index on `dir`, as in
  // `deepestName`: `dir` can end in as many missing names as a caller wrote.
  const top = path.parse(dir).root.length;
  const isSep = (i: number): boolean => dir[i] === "/" || dir[i] === path.sep;
  let end = dir.length;
  for (;;) {
    let stop = end;
    while (stop > top && isSep(stop - 1)) stop--;
    let start = stop;
    while (start > top && !isSep(start - 1)) start--;
    const probe = dir.slice(0, end);
    const parent = dir.slice(0, start > top ? start - 1 : top);
    const base = dir.slice(start, stop);
    const swapped = [...base]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join("");
    if (swapped !== base && nameExists(probe)) {
      const other = path.join(parent, swapped);
      if (!nameExists(other)) return false;
      return sameEntry(probe, other);
    }
    if (parent.length === end) return undefined;
    end = parent.length;
  }
}

/**
 * The value(s) `raw` names inside the workspace at `root`. Parent
 * directories are followed through symlinks — `build/link/app.ts` with
 * `build/link → ../src` IS `src/app.ts` for every tool. The last component is
 * not followed, because a tool that replaces or deletes it acts on the link
 * itself; but it is written the way its directory stores it when it exists
 * (`.ENV` is `.env` on macOS), and when it is a symlink, a tool that opens it
 * acts on the target instead, so the target is a second value. An allow then
 * has to cover both, and a deny fires on either. The name as written stays a
 * spelling a deny also fires on.
 */
export function canonicalWorkspacePath(
  raw: string,
  root: string,
  rootSpellings: RootSpellingSources = {},
): OperativeValue[] {
  return readWorkspacePath(raw, root, rootSpellings).values;
}

/** The values a rule reads, and the absolute places they stand for (see {@link ApprovalPlace}). */
type WorkspacePathReading = {
  readonly values: OperativeValue[];
  /** Worked out only when asked: a path that climbs out lexically is walked for it alone. */
  readonly places: () => string[];
  /** The place `raw` names on its face: the root joined to it, `..` collapsed, no link followed. */
  readonly asWritten: string;
};

/**
 * {@link canonicalWorkspacePath}, with the place each value stands for: the
 * absolute location, with every symlink followed, that a value inside the
 * workspace names in `canonical` — and that a value flagged outside does
 * not, since a rule needs only the flag. An approval is bound to these
 * places, and an outside place is a place an operator approved as much as an
 * inside one.
 *
 * Where `realpath` cannot say where a path lands, the rule still reads only
 * the outside flag, but the place is walked the way the file tools walk it
 * (`physicalPath` in `@crewhaus/tool-safety/fs`, one `lstat`/`readlink` per
 * name): a directory that can be searched but not read (mode 0300) stops
 * `realpath` and stops listing it, and stops no tool. Only where that walk
 * fails too (a loop of links, a directory that cannot be searched), which is
 * where the tool cannot open the path either, is the place
 * {@link UNRESOLVED_PLACE} followed by the path as written.
 */
function readWorkspacePath(
  raw: string,
  root: string,
  rootSpellings: RootSpellingSources,
): WorkspacePathReading {
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const aliases = rootAliases(rootAbs, rootReal, rootSpellings);
  // Lexical: `..` collapsed, symlinks untouched.
  const lexicalAbs = path.resolve(rootAbs, raw);
  const lexicalRel = path.relative(rootAbs, lexicalAbs);
  const spellings = [raw, toPosix(lexicalRel === "" ? "." : lexicalRel), toPosix(lexicalAbs)];
  const outside: OperativeValue = {
    kind: "path",
    canonical: [],
    spellings,
    outsideWorkspace: true,
  };
  const asWritten = toPosix(path.resolve(rootReal, lexicalRel));
  const unresolved = `${UNRESOLVED_PLACE}${toPosix(lexicalAbs)}`;
  const known = { lexical: rootAbs, physical: rootReal };
  /** Where `abs` lands, walked as the tools walk it; `undefined` where they could not open it. */
  const walked = (abs: string): string | undefined => {
    try {
      return toPosix(physicalPath(abs, { known }));
    } catch {
      return undefined;
    }
  };
  /**
   * The entry `name` in the directory that really holds it, and where it
   * leads when it is a symlink: the places the normal reading below gives a
   * rule, for a directory it could not read.
   */
  const entryPlaces = (dir: string, name: string): string[] => {
    const at = path.join(dir, name);
    if (!isSymlink(at)) return [toPosix(at)];
    const target = walked(at);
    if (target === undefined) return [toPosix(at), unresolved];
    return target === toPosix(at) ? [toPosix(at)] : [toPosix(at), target];
  };
  /** The places of `lexicalAbs` where its directory could not be read. */
  const placesByWalk = (): string[] => {
    const dir = walked(path.dirname(lexicalAbs));
    return dir === undefined ? [unresolved] : entryPlaces(dir, path.basename(lexicalAbs));
  };
  const read = (
    values: OperativeValue[],
    places: string[] | (() => string[]),
  ): WorkspacePathReading => {
    let known = typeof places === "function" ? undefined : places;
    return {
      values,
      places: () => {
        known ??= (places as () => string[])();
        return known;
      },
      asWritten,
    };
  };
  let caseInsensitive = true;
  const located = (real: string): OperativeValue => {
    const rel = path.relative(rootReal, real);
    if (climbsOut(rel)) return outside;
    const relPosix = rel === "" ? "." : toPosix(rel);
    const underAliases = aliases.map((a) => toPosix(rel === "" ? a : path.join(a, rel)));
    return {
      kind: "path",
      canonical:
        relPosix === "." ? [".", toPosix(real)] : [relPosix, `./${relPosix}`, toPosix(real)],
      spellings: underAliases.length === 0 ? spellings : [...spellings, ...underAliases],
      ...(caseInsensitive ? { caseInsensitive: true } : {}),
      // A tool that walks a directory (`beneath`) acts on nothing beneath a
      // file, so a deny naming something under this name cannot concern it.
      ...(isNonDirectory(real) ? { notDirectory: true } : {}),
    };
  };
  if (climbsOut(lexicalRel)) {
    // A rule needs only the flag. The place is walked for only when an
    // approval asks, so a grant made for one place outside is not spent on
    // another — and walked in one pass over the path: `resolveLocation`
    // hands the rest of the path to dirname and basename once per missing
    // name, the square of a length the model chooses.
    return read([outside], () => [walked(lexicalAbs) ?? unresolved]);
  }
  // Longer than any path can be: no tool acts on it, and it is not walked.
  if (lexicalAbs.length > MAX_PATH_CHARS) return read([outside], [unresolved]);
  if (lexicalAbs === rootAbs) {
    caseInsensitive = ignoresCase(rootReal) !== false;
    return read([located(rootReal)], [toPosix(rootReal)]);
  }
  let parent: string;
  try {
    parent = resolveLocation(path.dirname(lexicalAbs));
  } catch {
    // Where it lands cannot be worked out: an allow must not guess.
    return read([outside], placesByWalk());
  }
  // Unknown counts as "ignores case": that only widens what a deny or an ask
  // catches, never what an allow grants.
  caseInsensitive = ignoresCase(parent) !== false;
  const leaf = path.basename(lexicalAbs);
  let names = [leaf];
  if (nameExists(path.join(parent, leaf))) {
    // It exists, so the tool will open the entry the filesystem resolves the
    // name to — which, on a filesystem that folds case or Unicode form, may
    // be stored under another spelling. A rule sees that spelling.
    const stored = storedNames(parent, leaf);
    if (stored === undefined) return read([outside], placesByWalk());
    names = stored;
  }
  const values: OperativeValue[] = [];
  const places: string[] = [];
  for (const name of names) {
    const at = path.join(parent, name);
    values.push(located(at));
    places.push(toPosix(at));
    if (isSymlink(at)) {
      let target: string;
      try {
        target = resolveLocation(at);
      } catch {
        values.push(outside);
        places.push(walked(at) ?? unresolved);
        continue;
      }
      if (target !== at) {
        values.push(located(target));
        places.push(toPosix(target));
      }
    }
  }
  return read(values, places);
}

/**
 * How a place reads when even the tools' own walk cannot follow the path: a
 * loop of links, or a directory that cannot be searched. A tool cannot open
 * such a path either.
 */
export const UNRESOLVED_PLACE = "unresolved:";

/** A command word read by {@link readProgramPlace}: what a rule reads, and the places an approval binds. */
type ProgramPlace = {
  /** `undefined` where the walk failed: a loop of links, a directory that cannot be searched. */
  readonly reading: ProgramPathReading | undefined;
  /** Where it lands and, when that is a symlink, where it leads (or {@link UNRESOLVED_PLACE}). */
  readonly at: string[];
  /** Where it lands on its face: the directory joined to the word, `..` collapsed, nothing followed. */
  readonly asWritten: string;
};

function isSeparator(code: number): boolean {
  return code === 0x2f || (path.sep === "\\" && code === 0x5c);
}

/**
 * `rel` walked from the physical directory `dir` the way the kernel walks it:
 * `physicalPath` from a start already known to be physical, so each `..` is
 * applied after the link before it, never folded as text first.
 */
function walkFrom(dir: string, rel: string): string {
  if (rel === "") return dir;
  const joined = dir.endsWith(path.sep) ? `${dir}${rel}` : `${dir}${path.sep}${rel}`;
  return physicalPath(joined, { known: { lexical: dir, physical: dir } });
}

/**
 * Where a command word that names a file lands (`ProgramPathReader` in
 * `@crewhaus/tool-executor`): from the directory the command runs in — the
 * tools join `runsIn` to the root as text and the kernel then follows it —
 * each name followed the way the kernel follows it, a `..` after a link
 * climbing out of the link's target. `link/../run.sh` with `link →
 * secrets/deep` is `secrets/run.sh`, which `path.resolve` would fold to
 * `run.sh` before any link was seen. The last name is kept as written; when
 * it is a symlink, where it leads is the program the kernel runs, and a
 * second place.
 */
function readProgramPlace(word: string, runsIn: string | undefined, root: string): ProgramPlace {
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const dirLexical = path.resolve(rootReal, runsIn ?? ".");
  const lexical = path.resolve(dirLexical, word);
  const asWritten = toPosix(lexical);
  const unresolved: ProgramPlace = {
    reading: undefined,
    at: [`${UNRESOLVED_PLACE}${asWritten}`],
    asWritten,
  };
  // Longer than any path can be: the kernel refuses to run it.
  if (word.length > MAX_PATH_CHARS || dirLexical.length > MAX_PATH_CHARS) return unresolved;
  const inWorkspace = (p: string): string | undefined => {
    const rel = path.relative(rootReal, p);
    return climbsOut(rel) ? undefined : rel === "" ? "." : toPosix(rel);
  };
  // The last name, and the directory part before it, by index.
  let end = word.length;
  while (end > 0 && isSeparator(word.charCodeAt(end - 1))) end--;
  let cut = end;
  while (cut > 0 && !isSeparator(word.charCodeAt(cut - 1))) cut--;
  const leaf = word.slice(cut, end);
  const head = word.slice(0, cut);
  const known = { lexical: rootReal, physical: rootReal };
  let at: string;
  let target: string | undefined;
  try {
    const absolute = path.isAbsolute(word);
    const start = absolute ? path.parse(word).root : physicalPath(dirLexical, { known });
    const from = (rel: string): string =>
      absolute ? physicalPath(`${start}${rel}`, { known }) : walkFrom(start, rel);
    const relHead = absolute ? head.slice(start.length) : head;
    if (leaf === "" || leaf === "." || leaf === "..") {
      at = from(absolute ? word.slice(start.length) : word);
    } else {
      const parent = from(relHead);
      at = path.join(parent, leaf);
      if (isSymlink(at)) {
        const led = walkFrom(parent, leaf);
        if (led !== at) target = led;
      }
    }
  } catch {
    return unresolved;
  }
  const atInWorkspace = inWorkspace(at);
  const targetInWorkspace = target !== undefined ? inWorkspace(target) : undefined;
  const reading: ProgramPathReading = {
    at: toPosix(at),
    ...(atInWorkspace !== undefined ? { inWorkspace: atInWorkspace } : {}),
    asWritten,
    writtenInWorkspace: inWorkspace(lexical) !== undefined,
    ...(target !== undefined
      ? {
          target: {
            at: toPosix(target),
            ...(targetInWorkspace !== undefined ? { inWorkspace: targetInWorkspace } : {}),
          },
        }
      : {}),
  };
  return {
    reading,
    at: target !== undefined ? [toPosix(at), toPosix(target)] : [toPosix(at)],
    asWritten,
  };
}

/** `text` without its trailing separators, in one pass from the end. */
function withoutTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && isSeparator(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

/**
 * The gate's canonicaliser, keeping a record of every path it read and where
 * each one lands — absolute, every symlink followed, one place per value it
 * gave a rule (the entry itself and, when that is a symlink, its target),
 * inside or outside the workspace alike. That record is what a headless
 * approval is bound to (`landsWhereApproved` in this package). Paths a call names through a directory field (a
 * command's `cwd`, a PATH entry it sets) are read through it too, and so is
 * each command word that names a file — the program run by its path, the
 * script an interpreter is handed — through `readProgramPath`, so the record
 * is everything on the filesystem the gate's decision rested on.
 */
export function placeRecordingCanonicalizer(root: string = process.cwd()): {
  readonly canonicalizePath: PathCanonicalizer;
  /** Where a command word that names a file lands, recorded like a path. */
  readonly readProgramPath: ProgramPathReader;
  /**
   * Every path read so far, ordered by path, each with where it lands; then
   * every command word, ordered the same way, keyed by the word joined to
   * the directory it runs in.
   */
  readonly places: () => ApprovalPlace[];
  /**
   * True when every path and command word read lands exactly where it reads
   * on its face — one place, the root joined to the path with `..` collapsed
   * and no symlink followed. Vacuously true when nothing was read.
   */
  readonly allAsWritten: () => boolean;
} {
  const seen = new Map<string, WorkspacePathReading>();
  const programs = new Map<string, ProgramPlace>();
  const byKey = <T>(entries: Iterable<[string, T]>): Array<[string, T]> =>
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonicalizePath: (raw) => {
      const reading = readWorkspacePath(raw, root, {});
      seen.set(raw, reading);
      return reading.values;
    },
    readProgramPath: (word, runsIn, opts) => {
      const place = readProgramPlace(word, runsIn, root);
      // A bare word an interpreter is handed may be a subcommand or a module
      // (`bun run build`, `python -m pytest`): it is a place only where it
      // names an entry, or a card would list files that are not there.
      const separated = word.includes("/") || (path.sep === "\\" && word.includes("\\"));
      if (!separated && place.reading !== undefined && !nameExists(place.reading.at)) {
        return place.reading;
      }
      // An argument (or a candidate on a PATH the call sets) is a place only
      // where it lands elsewhere than it reads, or is a link: anywhere else
      // its text says where it lands, and it would only crowd the card. A
      // grant is still bound to it, since a link moving in or out of its way
      // adds or drops it. One that cannot be walked (text longer than any
      // path, a loop of links) is no file the call names.
      const onItsFace = place.at.length === 1 && place.at[0] === place.asWritten;
      if (opts?.argument === true && (onItsFace || place.reading === undefined)) {
        return place.reading;
      }
      const dir = runsIn !== undefined ? withoutTrailingSeparators(runsIn) : "";
      const key = dir === "" || dir === "." || path.isAbsolute(word) ? word : `${dir}/${word}`;
      programs.set(key, place);
      return place.reading;
    },
    places: () => [
      ...byKey(seen.entries()).map(([p, r]) => ({ path: p, at: [...r.places()] })),
      ...byKey(programs.entries()).map(([p, r]) => ({ path: p, at: [...r.at] })),
    ],
    allAsWritten: () =>
      [...seen.values()].every((r) => {
        const at = r.places();
        return at.length === 1 && at[0] === r.asWritten;
      }) && [...programs.values()].every((r) => r.at.length === 1 && r.at[0] === r.asWritten),
  };
}

/**
 * The canonicaliser the permission gate hands `preparePermissionSubject`:
 * paths resolved against `root` — by default the current working directory,
 * which is the root every workspace tool resolves against at call time.
 */
export function workspacePathCanonicalizer(root: string = process.cwd()): PathCanonicalizer {
  return (raw) => canonicalWorkspacePath(raw, root);
}
