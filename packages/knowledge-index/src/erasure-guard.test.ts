/**
 * One door. Each store's `./erasure` subpath deletes, and only this package's erasure module may
 * import one; the door itself is imported by the CLI's command alone.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SOURCE_RE = /\.(?:ts|tsx|js|mjs|cjs|mts|cts)$/;
const TEST_RE = /(?:\.test\.|\/__test__\/|\/__tests__\/|\/test-helpers)/;
const DOOR = "@crewhaus/knowledge-index/erasure";
const SUBPATH_RE =
  /(?:\bfrom|\bimport|\brequire|\bresolve)\s*\(?\s*["'`](@crewhaus\/[a-z0-9-]+\/erasure)["'`]/g;
/** A store's own code reaching its purge by path. */
const SIBLING_RE = /from\s+["'`](?:\.{1,2}\/)+(?:src\/)?erasure(?:\.js|\.ts)?["'`]/;

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE_RE.test(name)) out.push(path);
  }
  return out;
}

const rel = (file: string): string =>
  file
    .slice(REPO.length + 1)
    .split("\\")
    .join("/");
const files = ["packages", "apps", "scripts", "examples"]
  .flatMap((dir) => sources(join(REPO, dir)))
  .filter((file) => !TEST_RE.test(rel(file)));

/** Every package whose manifest exports an `./erasure` subpath. */
const exporting = ["packages", "apps"].flatMap((dir) =>
  readdirSync(join(REPO, dir)).flatMap((name) => {
    const path = join(REPO, dir, name, "package.json");
    if (!existsSync(path)) return [];
    const { exports: entries, name: pkg } = JSON.parse(readFileSync(path, "utf8")) as {
      exports?: unknown;
      name?: string;
    };
    const has =
      typeof entries === "object" && entries !== null && Object.hasOwn(entries, "./erasure");
    return has ? [`${pkg}/erasure`] : [];
  }),
);

describe("the one erasure door", () => {
  test("the stores that can erase are these five, and the door", () => {
    expect(exporting.sort()).toEqual([
      "@crewhaus/continuity-store/erasure",
      "@crewhaus/harness-lifecycle/erasure",
      DOOR,
      "@crewhaus/memory-store/erasure",
      "@crewhaus/session-store/erasure",
      "@crewhaus/wiki-store/erasure",
    ]);
  });

  test("only this package's erasure module imports a store's, and it imports each once", () => {
    const hits = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(SUBPATH_RE)].map((match) => ({
        file: rel(file),
        to: match[1] as string,
      })),
    );
    expect(files.length).toBeGreaterThan(1_000);
    const stores = hits.filter((hit) => hit.to !== DOOR);
    for (const { file } of stores) expect(file).toMatch(/^packages\/knowledge-index\/src\/erasure/);
    expect(stores.map((hit) => hit.to).sort()).toEqual(
      exporting.filter((name) => name !== DOOR).sort(),
    );
    expect(hits.filter((hit) => hit.to === DOOR).map((hit) => hit.file)).toEqual([
      "apps/cli/src/knowledge-cmd.ts",
    ]);
  });

  test("no store's own code calls its purge", () => {
    const offenders = files.filter((file) => SIBLING_RE.test(readFileSync(file, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });
});
