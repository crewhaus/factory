/**
 * Manifest guard — every module this package imports at RUNTIME must be a
 * declared `dependency`, not a devDependency.
 *
 * The incident: 0.5.5 shipped `list-tools.ts`, the first runtime-core source
 * file to `import { z } from "zod"`, while `zod` sat in devDependencies. In
 * the workspace everything resolved through the monorepo root, so the whole
 * test suite and every CI gate passed. A consumer installing the published
 * tarball got `ENOENT while resolving package 'zod'` the moment the runtime
 * loaded — which is every compiled bundle, because the loop imports
 * `list-tools` unconditionally. Silent at pack time, fatal for consumers.
 *
 * The check is deliberately narrow: only line-anchored `import`/`export …
 * from "…"` statements in non-test sources count. Emitter packages carry
 * import statements INSIDE template literals (they generate code), which is
 * why this guard lives with the package it protects rather than sweeping the
 * workspace — a repo-wide version needs a real TS parse to tell an emitted
 * string from an import.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** The package name an import specifier resolves to (`@scope/name` or `name`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

describe("runtime-core package manifest", () => {
  test("every runtime import is a declared dependency, not a devDependency", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    const importRe = /^(?:import|export)\s[^\n]*?from\s+"([^"]+)"/gm;
    const undeclared = new Map<string, string>();
    for (const file of sourceFiles(join(PKG_DIR, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(importRe)) {
        const specifier = match[1] as string;
        if (specifier.startsWith(".") || /^(?:node|bun):/.test(specifier)) continue;
        const pkg = packageOf(specifier);
        if (!declared.has(pkg)) undeclared.set(pkg, `${dirname(file).split("/").pop()}/${file}`);
      }
    }
    expect([...undeclared.keys()].sort()).toEqual([]);
  });
});
