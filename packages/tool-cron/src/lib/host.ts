/**
 * The two seams that are not a command: the filesystem, and the clock.
 *
 * **Filesystem.** Only two jobs need one. Listing `~/Library/LaunchAgents`
 * is how launchd agents are found at all (a plist is a file, not something
 * `launchctl` will enumerate with its definition), and installing a rewritten
 * crontab needs a file to hand to `crontab(1)`. Both go through `HostFs` so a
 * test can drive them without a home directory full of the developer's own
 * agents — the same reason commands go through `HostRunner`.
 *
 * `homedir()` is part of the seam for one specific reason: every directory
 * this package reads is DERIVED from it and none is accepted from the caller.
 * A tool that took a directory argument would be a tool that could be pointed
 * at `/etc`, and there is no version of that which is safe to hand a model.
 * Moving the home directory is therefore the only way to redirect this
 * package, and it is a test-only move.
 *
 * **Clock.** `CronList` computes the next firings of a cron expression, which
 * means it needs "now". Reading `Date.now()` inside the tool would make every
 * assertion about a schedule a race with the wall clock (house rule: never
 * assert wall-clock timing — inject the clock instead). The tool also accepts
 * an explicit `now`, which is what a caller replaying a transcript wants.
 */
import {
  type Dirent,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";

/**
 * What happened when a directory was listed — three outcomes, not two.
 *
 * "There is no such directory" and "I was not allowed to look" are different
 * facts about the machine, and collapsing them into an empty list turns a
 * permission error into the sentence "you have no scheduled agents". That is
 * the failure this package is most likely to produce silently, because a
 * LaunchAgents directory that cannot be read looks exactly like one that is
 * not there.
 */
export type DirListing =
  | { readonly kind: "names"; readonly names: string[] }
  /** ENOENT/ENOTDIR: the directory genuinely is not there. */
  | { readonly kind: "missing" }
  /** It exists (or might) and could not be listed: EACCES, EIO, EPERM… */
  | { readonly kind: "error"; readonly reason: string };

export type HostFs = {
  /** The user whose schedule is being read. Every directory derives from it. */
  homedir(): string;
  tmpdir(): string;
  /** File names in `dir` — or why they could not be had. */
  readdir(dir: string): DirListing;
  /** A fresh private directory; the caller removes it. */
  mkdtemp(prefix: string): string;
  writeFile(path: string, text: string, mode: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  removeDir(path: string): void;
};

const nodeFs: HostFs = {
  homedir: () => osHomedir(),
  tmpdir: () => osTmpdir(),
  readdir: (dir) => {
    try {
      // `withFileTypes` keeps a subdirectory out of the plist list without a
      // second stat per entry. Order is whatever the filesystem hands back —
      // every caller here sorts, because readdir order is not a fact.
      return {
        kind: "names",
        names: readdirSync(dir, { withFileTypes: true })
          .filter((entry: Dirent) => entry.isFile() || entry.isSymbolicLink())
          .map((entry: Dirent) => entry.name),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
      // The code, not the message: the message repeats the path (which the
      // caller already has) and nothing else useful, and an errno is the part
      // a reader can act on.
      return { kind: "error", reason: code ?? "the directory could not be listed" };
    }
  },
  mkdtemp: (prefix) => mkdtempSync(join(osTmpdir(), prefix)),
  writeFile: (path, text, mode) => {
    writeFileSync(path, text, { mode });
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
  removeDir: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
};

let hostFs: HostFs = nodeFs;

/** Test-only injection point; `undefined` restores the real filesystem. */
export function _setFs(fs: HostFs | undefined): void {
  hostFs = fs ?? nodeFs;
}

export function fs(): HostFs {
  return hostFs;
}

let clock: () => number = Date.now;

/** Test-only injection point; `undefined` restores the wall clock. */
export function _setClock(fn: (() => number) | undefined): void {
  clock = fn ?? Date.now;
}

export function now(): number {
  return clock();
}

/**
 * The uid launchd's `gui/<uid>` domain is keyed on.
 *
 * `process.getuid` is absent on Windows, and a launchd domain target built
 * from a guessed uid would either fail or — worse, if it ever resolved —
 * address somebody else's session, so an unknown uid is refused rather than
 * defaulted.
 */
export function currentUid(): number | undefined {
  const get = process.getuid;
  if (typeof get !== "function") return undefined;
  const uid = get.call(process);
  return Number.isInteger(uid) && uid >= 0 ? uid : undefined;
}
