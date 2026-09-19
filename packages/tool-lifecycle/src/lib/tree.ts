/**
 * Walking and fingerprinting a directory tree.
 *
 * Two tools need to say "this is exactly what moved, and it is still the same
 * bytes afterwards": `HarnessRetire` (which archives a harness's `.crewhaus`
 * and cannot get it back) and `StoreMigrate` (which must be able to report a
 * half-finished migration rather than a boolean). Both answers come from
 * here.
 *
 * Three properties the callers depend on:
 *
 *   1. A walk that hit anything it could not read comes back `complete:
 *      false` with the reason. A manifest with a hole in it must never be
 *      presented as a verified one — that is the failure this package exists
 *      to avoid, at the exact moment the original is about to be destroyed.
 *   2. Symlinks are recorded, never followed. Following them would walk out
 *      of the tree (and could loop), and the archive move preserves the link
 *      itself, so the link's TARGET is not what is being fingerprinted.
 *   3. The budgets are checked while walking, not after. A tree that blows
 *      the file or byte budget stops the walk and says so, rather than
 *      hashing a hundred gigabytes because nobody looked first.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import * as path from "node:path";
import { type Loaded, fail } from "./result";

export type TreeEntry = {
  /** Path relative to the walk root, with `/` separators on every OS. */
  readonly rel: string;
  readonly kind: "file" | "symlink" | "other";
  readonly bytes: number;
  /** sha256 of the file's bytes. Absent for a symlink or an unhashed entry. */
  readonly sha256?: string;
  /** A symlink's target, verbatim. */
  readonly target?: string;
};

export type TreeUnreadable = { readonly rel: string; readonly reason: string };

export type Tree = {
  readonly root: string;
  readonly entries: ReadonlyArray<TreeEntry>;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Oldest / newest mtime seen, epoch ms. Absent for an empty tree. */
  readonly oldestMtimeMs?: number;
  readonly newestMtimeMs?: number;
  /** Entries that could not be read, with the reason each one failed. */
  readonly unreadable: ReadonlyArray<TreeUnreadable>;
  /**
   * True only when every entry under the root was visited AND (when hashing
   * was requested) hashed. False the moment anything was skipped, refused or
   * truncated — the caller must not treat such a tree as a verified one.
   */
  readonly complete: boolean;
};

export type WalkOptions = {
  readonly maxFiles: number;
  readonly maxBytes: number;
  /** Compute sha256 per file. Off for a cheap inventory. */
  readonly hash: boolean;
};

const toPosix = (p: string): string => (path.sep === "/" ? p : p.split(path.sep).join("/"));

/**
 * Walk `root` depth-first in sorted order.
 *
 * Sorted because a result that depends on `readdir` order is a result that
 * differs between two machines looking at the same directory, and because the
 * manifest this produces is compared byte-for-byte against a later walk.
 */
export function walkTree(root: string, opts: WalkOptions): Loaded<Tree> {
  const entries: TreeEntry[] = [];
  const unreadable: TreeUnreadable[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let oldestMtimeMs: number | undefined;
  let newestMtimeMs: number | undefined;
  let budgetExceeded: string | undefined;

  const visit = (abs: string, rel: string): void => {
    if (budgetExceeded !== undefined) return;
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch (err) {
      unreadable.push({
        rel: rel === "" ? "." : rel,
        reason: `directory could not be listed (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      });
      return;
    }
    for (const name of names) {
      if (budgetExceeded !== undefined) return;
      const childAbs = path.join(abs, name);
      const childRel = toPosix(rel === "" ? name : `${rel}/${name}`);
      let stat: ReturnType<typeof lstatSync>;
      try {
        // lstat, not stat: a symlink is recorded as itself. `stat` would
        // report its target's size and could be made to point anywhere.
        stat = lstatSync(childAbs);
      } catch (err) {
        unreadable.push({
          rel: childRel,
          reason: `could not be stat'd (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
        });
        continue;
      }
      if (stat.isDirectory()) {
        visit(childAbs, childRel);
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(childAbs);
        } catch (err) {
          unreadable.push({
            rel: childRel,
            reason: `symlink could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
          });
          continue;
        }
        entries.push({ rel: childRel, kind: "symlink", bytes: 0, target });
        continue;
      }
      if (!stat.isFile()) {
        // A socket or a fifo is not data and cannot be hashed; it is recorded
        // so the caller knows the archive will not be a faithful copy.
        entries.push({ rel: childRel, kind: "other", bytes: 0 });
        unreadable.push({ rel: childRel, reason: "not a regular file (not hashed)" });
        continue;
      }
      fileCount += 1;
      totalBytes += stat.size;
      oldestMtimeMs =
        oldestMtimeMs === undefined ? stat.mtimeMs : Math.min(oldestMtimeMs, stat.mtimeMs);
      newestMtimeMs =
        newestMtimeMs === undefined ? stat.mtimeMs : Math.max(newestMtimeMs, stat.mtimeMs);
      if (fileCount > opts.maxFiles) {
        budgetExceeded = `the tree holds more than ${opts.maxFiles} files`;
        return;
      }
      if (totalBytes > opts.maxBytes) {
        budgetExceeded = `the tree holds more than ${opts.maxBytes} bytes`;
        return;
      }
      if (!opts.hash) {
        entries.push({ rel: childRel, kind: "file", bytes: stat.size });
        continue;
      }
      try {
        entries.push({
          rel: childRel,
          kind: "file",
          bytes: stat.size,
          sha256: createHash("sha256").update(readFileSync(childAbs)).digest("hex"),
        });
      } catch (err) {
        unreadable.push({
          rel: childRel,
          reason: `could not be read for hashing (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
        });
        entries.push({ rel: childRel, kind: "file", bytes: stat.size });
      }
    }
  };

  try {
    visit(root, "");
  } catch (err) {
    return fail("unreadable", `"${root}" could not be walked: ${(err as Error).message}`);
  }
  if (budgetExceeded !== undefined) {
    return fail(
      "too-large",
      `${budgetExceeded} — raise the budget explicitly if that is really what you meant to touch`,
    );
  }
  return {
    ok: true,
    value: {
      root,
      entries,
      fileCount,
      totalBytes,
      ...(oldestMtimeMs !== undefined ? { oldestMtimeMs } : {}),
      ...(newestMtimeMs !== undefined ? { newestMtimeMs } : {}),
      unreadable,
      complete: unreadable.length === 0,
    },
  };
}

export type VerifyMismatch = {
  readonly rel: string;
  readonly problem: "missing" | "size" | "sha256" | "unreadable" | "kind";
  readonly detail: string;
};

export type VerifyResult = {
  readonly checked: number;
  readonly verified: number;
  readonly mismatched: ReadonlyArray<VerifyMismatch>;
  /**
   * True only when every entry of the manifest was found and matched. A
   * manifest that was itself incomplete can never verify, because the
   * entries it is missing are exactly the ones nothing is being checked
   * against.
   */
  readonly ok: boolean;
};

/**
 * Check a tree against a manifest taken earlier.
 *
 * Used twice: after `HarnessRetire` moves `.crewhaus` into the archive (did
 * every byte arrive?), and after `StoreMigrate` copies a store (is the
 * destination really the source?). An entry the manifest never hashed is
 * reported as unverifiable rather than counted as verified.
 */
export function verifyAgainst(
  destRoot: string,
  manifest: ReadonlyArray<TreeEntry>,
  manifestComplete = true,
): VerifyResult {
  const mismatched: VerifyMismatch[] = [];
  let verified = 0;
  for (const entry of manifest) {
    const abs = path.join(destRoot, ...entry.rel.split("/"));
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      mismatched.push({
        rel: entry.rel,
        problem: "missing",
        detail: `not present at the destination (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      });
      continue;
    }
    if (entry.kind === "symlink") {
      if (!stat.isSymbolicLink()) {
        mismatched.push({ rel: entry.rel, problem: "kind", detail: "was a symlink, is not now" });
        continue;
      }
      // The link's TARGET is the only content a symlink has, so verifying
      // that a symlink is still a symlink verifies nothing about it. A
      // repointed link would otherwise have counted towards `verified` at the
      // moment the original was being destroyed.
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch (err) {
        mismatched.push({
          rel: entry.rel,
          problem: "unreadable",
          detail: `symlink could not be read at the destination (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
        });
        continue;
      }
      if (entry.target === undefined) {
        mismatched.push({
          rel: entry.rel,
          problem: "unreadable",
          detail: "no target was recorded for this symlink, so it cannot be verified",
        });
        continue;
      }
      if (target !== entry.target) {
        mismatched.push({
          rel: entry.rel,
          problem: "sha256",
          detail: `pointed at "${entry.target}" before, "${target}" now`,
        });
        continue;
      }
      verified += 1;
      continue;
    }
    if (entry.kind !== "file") {
      mismatched.push({
        rel: entry.rel,
        problem: "unreadable",
        detail: "not a regular file — nothing was hashed, so nothing can be verified",
      });
      continue;
    }
    if (stat.size !== entry.bytes) {
      mismatched.push({
        rel: entry.rel,
        problem: "size",
        detail: `${entry.bytes} bytes before, ${stat.size} now`,
      });
      continue;
    }
    if (entry.sha256 === undefined) {
      mismatched.push({
        rel: entry.rel,
        problem: "unreadable",
        detail: "no hash was recorded for this file, so its contents cannot be verified",
      });
      continue;
    }
    let digest: string;
    try {
      digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
    } catch (err) {
      mismatched.push({
        rel: entry.rel,
        problem: "unreadable",
        detail: `could not be read at the destination (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      });
      continue;
    }
    if (digest !== entry.sha256) {
      mismatched.push({ rel: entry.rel, problem: "sha256", detail: "contents differ" });
      continue;
    }
    verified += 1;
  }
  return {
    checked: manifest.length,
    verified,
    mismatched,
    ok: manifestComplete && mismatched.length === 0,
  };
}

/** sha256 of one file, or the reason it could not be hashed. */
export function hashFile(abs: string): Loaded<string> {
  try {
    return { ok: true, value: createHash("sha256").update(readFileSync(abs)).digest("hex") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? fail("missing", "file does not exist")
      : fail("unreadable", `file could not be read (${code ?? "unknown error"})`);
  }
}
