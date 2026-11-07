/**
 * A check that nothing committed looks like a real credential. GitHub push
 * protection rejects a real-shaped literal anywhere in a pushed range, and a
 * test value has no reason to look like one: fakes build theirs at runtime.
 *
 * The patterns are assembled from parts, so this file does not match itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SHAPES: readonly RegExp[] = [
  new RegExp(`${"xox"}[abeoprs]-[0-9A-Za-z-]{10,}`),
  new RegExp(`${"sk"}-${"ant"}-[0-9A-Za-z_-]{16,}`),
  new RegExp(`${"gh"}[opsu]_[0-9A-Za-z]{30,}`),
  new RegExp(`${"github"}_${"pat"}_[0-9A-Za-z_]{20,}`),
  new RegExp(`${"AKIA"}[0-9A-Z]{16}`),
  new RegExp(`-----BEGIN [A-Z ]*${"PRIVATE"} ${"KEY"}-----`),
];

/** The credential-shaped strings in a text. */
export function secretShapesIn(text: string): string[] {
  const found: string[] = [];
  for (const shape of SHAPES) {
    const match = shape.exec(text);
    if (match !== null) found.push(match[0]);
  }
  return found;
}

/** Every committed-looking file under `dir`, skipping installs and builds. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.name.endsWith(".tsbuildinfo")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Scan a package directory. A caller asserts `scanned`, so an empty walk fails. */
export function scanForSecretShapes(dir: string): {
  readonly scanned: number;
  readonly hits: readonly string[];
} {
  const files = filesUnder(dir);
  const hits: string[] = [];
  for (const file of files) {
    for (const hit of secretShapesIn(readFileSync(file, "utf8"))) hits.push(`${file}: ${hit}`);
  }
  return { scanned: files.length, hits };
}
