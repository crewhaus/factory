/**
 * security-6#1 — one reading of CREWHAUS_SANDBOX.
 *
 * The permission floor compared the raw variable with "noop" while the sandbox
 * trimmed it, so `noop ` (or `noop\r` from a CRLF .env) told the floor a sandbox
 * existed and then ran model code on the host. `@crewhaus/sandbox` now owns the
 * only parser (`resolveSandboxBackend` / `sandboxAvailableFromEnv`), and the
 * `crewhaus run` floor and the floor a compiled bundle emits both call it.
 *
 * This guard keeps it that way: no source file outside the sandbox package
 * reads the variable itself — including inside emitted-code strings, where the
 * old inline reading lived. The scope is every package and app `src/`
 * directory on disk, not a list.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");
// `env["CREWHAUS_SANDBOX"]`, `env['CREWHAUS_SANDBOX']`, `env.CREWHAUS_SANDBOX` —
// a READ of the variable, not a mention of its name in prose or a message.
const DIRECT_READ = /\benv(?:\.CREWHAUS_SANDBOX\b|\[\s*["'`]CREWHAUS_SANDBOX["'`]\s*\])/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("CREWHAUS_SANDBOX is read in one place", () => {
  test("only @crewhaus/sandbox reads the variable directly", () => {
    const srcDirs: string[] = [];
    for (const top of ["packages", "apps"]) {
      for (const pkg of readdirSync(join(REPO_ROOT, top))) {
        const src = join(REPO_ROOT, top, pkg, "src");
        try {
          if (statSync(src).isDirectory()) srcDirs.push(src);
        } catch {
          // a package without src/
        }
      }
    }
    const readers: string[] = [];
    let scanned = 0;
    for (const dir of srcDirs) {
      for (const file of sourceFiles(dir)) {
        scanned++;
        if (DIRECT_READ.test(readFileSync(file, "utf8"))) {
          readers.push(relative(REPO_ROOT, file));
        }
      }
    }
    // The sweep's own hit counts: it looked at the whole tree, and it found
    // the one reader that must exist.
    expect(srcDirs.length).toBeGreaterThanOrEqual(250);
    expect(scanned).toBeGreaterThan(1000);
    expect(readers).toEqual(["packages/sandbox/src/index.ts"]);
  });
});
