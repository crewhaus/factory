/**
 * The one writer for the files `crewhaus compile` puts in its output directory. A name it
 * writes is a regular file it created: a link (or any other non-regular file) at the leaf
 * is removed and replaced, never read through or written through; a directory between the
 * output directory and the leaf that is a link refuses the compile, naming it. Nothing
 * outside the output directory is touched.
 */
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export class BundleWriteError extends Error {
  override readonly name = "BundleWriteError";
}

type Kind = "absent" | "file" | "dir" | "link" | "other";

function kindOf(path: string): Kind {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return "link";
    if (stats.isDirectory()) return "dir";
    if (stats.isFile()) return "file";
    return "other";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    throw err;
  }
}

function segmentsOf(rel: string): string[] {
  if (rel === "" || isAbsolute(rel)) throw new BundleWriteError(`not a bundle path: ${rel}`);
  const parts = rel.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new BundleWriteError(`not a bundle path: ${rel}`);
  }
  return parts;
}

/** Make each directory between `outDir` and the leaf, refusing one that is a link. */
function ensureParents(outDir: string, parts: readonly string[]): string {
  let at = outDir;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const kind = kindOf(at);
    if (kind === "absent") {
      mkdirSync(at);
      continue;
    }
    if (kind !== "dir") {
      throw new BundleWriteError(
        `refusing to write into ${at}: it is ${kind === "link" ? "a link" : "not a directory"}`,
      );
    }
  }
  return at;
}

/**
 * Write one bundle file at `outDir/rel` as a new regular file. Whatever was at the leaf is
 * removed first, so the write never follows a link.
 */
export function writeBundleFile(outDir: string, rel: string, content: string | Uint8Array): string {
  const parts = segmentsOf(rel);
  const parent = ensureParents(outDir, parts);
  const leaf = join(parent, parts[parts.length - 1] as string);
  const kind = kindOf(leaf);
  if (kind === "dir") throw new BundleWriteError(`refusing to write ${leaf}: it is a directory`);
  if (kind !== "absent") unlinkSync(leaf);
  // `wx`: created here, so a name planted between the removal and the write is refused
  // rather than followed.
  writeFileSync(leaf, content, { flag: "wx" });
  return leaf;
}

/**
 * What is at `outDir/rel`, for the probes that decide whether a file is ours: the text of a
 * regular file, `absent`, or `other` for anything else (a link is never read).
 */
export function probeBundleFile(
  outDir: string,
  rel: string,
):
  | { readonly kind: "absent" }
  | { readonly kind: "other" }
  | { readonly kind: "file"; readonly text: string } {
  const parts = segmentsOf(rel);
  let at = outDir;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const kind = kindOf(at);
    if (kind === "absent") return { kind: "absent" };
    if (kind !== "dir") return { kind: "other" };
  }
  const leaf = join(at, parts[parts.length - 1] as string);
  const kind = kindOf(leaf);
  if (kind === "absent") return { kind: "absent" };
  if (kind !== "file") return { kind: "other" };
  try {
    return { kind: "file", text: readFileSync(leaf, "utf-8") };
  } catch {
    return { kind: "other" };
  }
}

/** Refuse an output directory that is itself a link (when it is a harness's bundle). */
export function assertOutDirNotLinked(outDir: string): void {
  if (kindOf(outDir) === "link") {
    throw new BundleWriteError(`refusing to compile into ${outDir}: it is a link`);
  }
}

/** Whether `path` sits inside `root`, by `relative()`. */
export function isInsideDir(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}
