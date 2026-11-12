import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;
const PACKAGES = join(SRC, "..", "..");

function sources(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const name = String(entry.name);
    const path = join(dir, name);
    if (entry.isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe("what this package may touch, and what may touch it", () => {
  test("it never imports hangar-server, and does not declare it", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    const imports = /from\s+["']@crewhaus\/hangar-server|import\(\s*["']@crewhaus\/hangar-server/;
    const hits = files.filter((file) => imports.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
    // The pattern sees a planted import (built from parts, so this file never holds one).
    expect(imports.test(`import { x } from "@crewhaus/${"hangar"}-server";`)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })).not.toContain(
      "@crewhaus/hangar-server",
    );
  });

  test("no emitter and no compiled bundle names it", () => {
    const targets = readdirSync(PACKAGES).filter((name) => name.startsWith("target-"));
    expect(targets.length).toBeGreaterThan(5);
    const dirs = ["compiler", ...targets].map((name) => join(PACKAGES, name, "src"));
    const files = dirs.flatMap(sources);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.includes(`${join("packages", "target-cli", "src")}`))).toBe(
      true,
    );
    const hits = files.filter((file) =>
      readFileSync(file, "utf8").includes("@crewhaus/control-service"),
    );
    expect(hits).toEqual([]);
  });
});
