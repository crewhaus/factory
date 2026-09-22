/**
 * The filesystem seam `doctor --fix` plans against, as a write-capturing
 * overlay.
 *
 * WHY AN OVERLAY AND NOT TWO CODE PATHS. `@crewhaus/harness-advice`'s fixers
 * split into a pure planner and an `apply()` that mutates through this seam.
 * The obvious way to build a preview is to render the planner's `diff` and
 * stop - and that is exactly the bug tool-hostfs shipped, where the preview
 * predicted a destination the real call never used. Here `apply()` ALWAYS
 * runs, against an overlay that serves reads from disk and holds writes in
 * memory. A dry run is that run, reported. A real run is that same run,
 * committed afterwards. There is no second implementation to drift, and the
 * bytes shown are the bytes that land, because they are the same bytes.
 *
 * The overlay also makes a batch of fixes correct. `planScopeFix.apply()`
 * reads the spec, patches it, and writes it back; two of them in one call
 * would each read the ORIGINAL file off disk and the second would silently
 * drop the first's edit. Reading through the overlay makes the second see the
 * first, in dry-run and real mode alike.
 *
 * Containment holds inside the seam too: every path a fixer reads or writes
 * goes through `resolveSafe`, not just the ones the caller typed, because a
 * planner composes paths of its own.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { FixFs } from "@crewhaus/harness-advice/doctor-fix";
import { MAX_SPEC_BYTES, readContained, renderPath, resolveInput } from "./sources";

/** A read or write the overlay refused, raised out of a fixer's `apply()`. */
export class FixFsError extends CrewhausError {
  override readonly name = "FixFsError";
  constructor(message: string) {
    super("tool", message);
  }
}

export type CapturedWrite =
  | { readonly kind: "file"; readonly path: string; readonly content: string }
  | { readonly kind: "dir"; readonly path: string };

export type OverlayFs = FixFs & {
  /** Everything `apply()` wrote, in the order it wrote it. */
  captured(): ReadonlyArray<CapturedWrite>;
};

/**
 * An overlay over the real filesystem, rooted at the workspace.
 *
 * `maxReadBytes` caps every file a fixer reads; the only file any shipped
 * fixer reads is a spec or a `.env`, both small.
 */
export function createOverlayFs(toolName: string, maxReadBytes = MAX_SPEC_BYTES): OverlayFs {
  const writes: CapturedWrite[] = [];
  const fileWrites = new Map<string, string>();
  const dirWrites = new Set<string>();

  /** The key an overlay entry is stored under: the contained, normalised path. */
  const keyOf = (p: string): string => {
    const safe = resolveInput(toolName, p);
    if (!safe.ok) throw new FixFsError(safe.message);
    return safe.value.rel;
  };

  return {
    exists(p: string): boolean {
      let key: string;
      try {
        key = keyOf(p);
      } catch {
        // A path the boundary refuses is not one this tool may report on.
        // Answering "false" would send a fixer straight into creating it.
        throw new FixFsError(`"${renderPath(p)}" is outside the workspace`);
      }
      if (fileWrites.has(key) || dirWrites.has(key)) return true;
      // An earlier captured write makes its parent directories exist too, so
      // a later fixer does not plan to create a directory this run already did.
      for (const dir of dirWrites) {
        if (key.startsWith(`${dir}/`)) return true;
      }
      return existsSync(path.resolve(process.cwd(), key));
    },
    read(p: string): string {
      const key = keyOf(p);
      const pending = fileWrites.get(key);
      // Read-through-writes: the second fixer in a batch must see the first
      // one's edit, or it patches a stale document and drops it.
      if (pending !== undefined) return pending;
      const read = readContained(toolName, key, maxReadBytes);
      if (!read.ok) throw new FixFsError(read.message);
      return read.value;
    },
    write(p: string, content: string): void {
      const key = keyOf(p);
      fileWrites.set(key, content);
      writes.push({ kind: "file", path: key, content });
    },
    mkdirp(p: string): void {
      const key = keyOf(p);
      dirWrites.add(key);
      writes.push({ kind: "dir", path: key });
    },
    captured(): ReadonlyArray<CapturedWrite> {
      // The last write to a path is the one that lands, so a path written
      // twice in a batch is reported once, at its final content.
      const lastIndex = new Map<string, number>();
      writes.forEach((w, i) => lastIndex.set(`${w.kind}:${w.path}`, i));
      return writes.filter((w, i) => lastIndex.get(`${w.kind}:${w.path}`) === i);
    },
  };
}

export type CommitResult = {
  /** Paths that actually landed on disk, in order. */
  readonly committed: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  /**
   * Set when the commit stopped. `committed` is then what DID land - a
   * partial write reported as a partial write, never as a success and never
   * as a rollback that did not happen.
   */
  readonly error?: string;
};

/**
 * Write captured changes to disk.
 *
 * The destinations are checked FIRST and the whole commit is refused if any
 * of them cannot be written, so the common failure (a parent directory that
 * does not exist) costs nothing. What cannot be pre-checked - a permission
 * denied, a full disk, a race - is reported with the exact prefix that did
 * land, because the caller's next move depends on which half happened.
 */
export function commitWrites(toolName: string, writes: ReadonlyArray<CapturedWrite>): CommitResult {
  const willExist = new Set<string>();
  for (const w of writes) {
    if (w.kind === "dir") willExist.add(w.path);
  }
  // Directories first, whatever order the fixers captured them in. The
  // pre-check below treats "some fix in this batch creates that parent" as
  // satisfied WITHOUT regard to order, so a file captured before the mkdirp
  // that makes its parent used to clear the pre-check and then fail at the
  // syscall with ENOENT - the batch lost for a reason the pre-check exists to
  // make free. `mkdir -p` is idempotent and order-independent, so hoisting the
  // directories is the fix, not a second pre-check that would have to agree
  // with this one.
  const ordered = [
    ...writes.filter((w) => w.kind === "dir"),
    ...writes.filter((w) => w.kind !== "dir"),
  ];
  for (const w of writes) {
    if (w.kind !== "file") continue;
    const parent = path.dirname(w.path);
    if (parent === "." || parent === "" || willExist.has(parent)) continue;
    const abs = path.resolve(process.cwd(), parent);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return {
        committed: [],
        error: `nothing was written: "${w.path}" needs the directory "${parent}", which does not exist`,
      };
    }
  }

  const committed: Array<{ path: string; bytes: number }> = [];
  for (const w of ordered) {
    // Re-resolved at commit time rather than reusing the path captured
    // earlier: the gap between planning and writing is a window in which a
    // symlink could have been swapped in, and the boundary has to hold at the
    // moment of the syscall, not at the moment of the plan.
    const safe = resolveInput(toolName, w.path);
    if (!safe.ok) {
      return {
        committed,
        error: `${safe.message}; ${committed.length} earlier change(s) DID land`,
      };
    }
    const abs = safe.value.real;
    try {
      if (w.kind === "dir") {
        mkdirSync(abs, { recursive: true });
        committed.push({ path: w.path, bytes: 0 });
      } else {
        writeFileSync(abs, w.content);
        committed.push({ path: w.path, bytes: Buffer.byteLength(w.content, "utf8") });
      }
    } catch (err) {
      return {
        committed,
        error: `"${w.path}" could not be written (${(err as Error).message.split("\n")[0]}); ${committed.length} earlier change(s) DID land`,
      };
    }
  }
  return { committed };
}
