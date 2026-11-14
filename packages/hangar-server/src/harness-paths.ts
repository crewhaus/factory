/**
 * Where a harness-relative path may be read or written: realpath-contained to the
 * harness's directory, per file, and never inside Home's own records, wherever the
 * harness is. Containment is decided by `relative()`, never by a string prefix, so it
 * holds on Windows too.
 *
 * First consumers: the per-harness routes' `contain` (`server.ts`), the versioned API's
 * `specs.schema` (`v1/creation.ts`), and the relocation check in `server.ts`.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveInside } from "@crewhaus/harness-supervisor";

/** A path's real place: its nearest existing ancestor resolved, the rest appended. */
export function realOr(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realOr(parent), basename(absolute));
  }
}

/** Whether `path` is `root` or inside it, by `relative()`. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Where a harness-relative path resolves, or why it is not served. */
export type HarnessPath =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      /** `escapes`: it resolves outside the harness. `home-records`: it lands in Home's own records. */
      readonly reason: "escapes" | "home-records";
    };

/**
 * A `<harness>`-relative path, realpath-contained to `dir`, that never lands in
 * Home's own records (`hangarRoot`). Call it per FILE: a listed name can be a
 * symlink. Each caller answers a refusal in its own door's words.
 */
export function harnessPathOf(
  dir: string,
  hangarRoot: string,
  segments: readonly string[],
): HarnessPath {
  const resolved = resolveInside(dir, segments);
  if (resolved === undefined) return { ok: false, reason: "escapes" };
  if (isWithin(realOr(hangarRoot), realOr(resolved))) return { ok: false, reason: "home-records" };
  return { ok: true, path: resolved };
}
