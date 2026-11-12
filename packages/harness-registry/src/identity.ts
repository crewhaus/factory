/**
 * A harness's own id, as `harness.json` in the harness records it. The same file format
 * as `@crewhaus/control-records`' writer (a test in the control service holds the two
 * paths equal); this package only reads it, and stays free of that dependency.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { HARNESS_ID_RE } from "./doc.js";

/** Where `harness.json` lives, relative to the harness directory. */
export const HARNESS_IDENTITY_REL = join(".crewhaus", "run", "control", "harness.json");

const IDENTITY_MAX_BYTES = 16 * 1024;

/** `harness.json`'s id and slug, as the harness records them. */
export type HarnessIdentityFile = { readonly id: string; readonly slug?: string };

/**
 * Read a harness's `harness.json`, contained to the harness (a link is not followed, and a
 * path whose real location leaves the harness is not read), tolerant (anything unreadable
 * or malformed is `undefined`). Never writes.
 *
 * First consumers: `upsert`'s adoption of a harness's own id, and `crewhaus harness adopt`.
 */
export function readHarnessIdentityFile(dir: string): HarnessIdentityFile | undefined {
  const path = join(dir, HARNESS_IDENTITY_REL);
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const root = realpathSync(dir);
    const rel = relative(root, realpathSync(path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const text = readFileSync(path, "utf8");
    if (text.length > IDENTITY_MAX_BYTES) return undefined;
    const parsed = JSON.parse(text) as { v?: unknown; id?: unknown; slug?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !HARNESS_ID_RE.test(parsed.id)) {
      return undefined;
    }
    return {
      id: parsed.id,
      ...(typeof parsed.slug === "string" ? { slug: parsed.slug } : {}),
    };
  } catch {
    return undefined;
  }
}
