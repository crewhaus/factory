/**
 * Manifest guard — every module the CLI imports at RUNTIME is a declared
 * `dependency` (or optional/peer dependency), never a devDependency.
 *
 * The publish step drops devDependencies from the tarball. Inside the
 * workspace every package resolves anyway, and after an install a
 * devDependency often still resolves because some other package pulled it in
 * and the installer hoisted it — so a missing declaration passes every local
 * gate and breaks only for an installer that lays things out differently.
 * 0.7.1 shipped `lint.ts` importing `@crewhaus/tool-registry-manifest` that
 * way, and `zod` had been imported the same way since before it.
 *
 * `tool-registry.test.ts` holds the dynamic `import("@crewhaus/tool-…")`
 * calls of `loadToolMap`; this holds the static ones. Only line-anchored
 * `import`/`export … from "…"` statements in non-test sources count — the
 * same narrow reading as runtime-core's `manifest.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const PKG_DIR = join(import.meta.dir, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** The package an import specifier resolves to (`@scope/name` or `name`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

describe("crewhaus CLI package manifest", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const importRe = /^(?:import|export)\s[^\n]*?from\s+"([^"]+)"/gm;
  const imports: Array<{ pkg: string; file: string }> = [];
  for (const file of sourceFiles(join(PKG_DIR, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(importRe)) {
      const specifier = match[1] as string;
      if (specifier.startsWith(".") || /^(?:node|bun):/.test(specifier)) continue;
      imports.push({ pkg: packageOf(specifier), file: relative(PKG_DIR, file) });
    }
  }

  test("the sweep finds the imports it is meant to guard", () => {
    // The CLI imports well over a hundred packages statically; a sweep that
    // found a handful would be reading the wrong directory or the wrong syntax.
    expect(imports.length).toBeGreaterThan(100);
    expect(imports.some((i) => i.pkg === "@crewhaus/tool-registry-manifest")).toBe(true);
    expect(imports.some((i) => i.pkg === "zod")).toBe(true);
  });

  test("every static runtime import is a declared dependency", () => {
    const undeclared = imports.filter((i) => !declared.has(i.pkg));
    expect(undeclared).toEqual([]);
  });
});
