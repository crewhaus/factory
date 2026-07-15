import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// release-prep.ts exits at module load without --version, so it is exercised as
// a subprocess rather than imported.
const SCRIPT = join(import.meta.dir, "release-prep.ts");

function runForPublish(files: string[]): { files: unknown; main: unknown } {
  const tmp = mkdtempSync(join(tmpdir(), "release-prep-"));
  // release-prep keys repo metadata off the workspace-root basename, so the
  // root must be a known repo directory (e.g. `factory`).
  const root = join(tmp, "factory");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", private: true, version: "0.0.0", workspaces: ["packages/*"] }),
    );
    const pkgDir = join(root, "packages", "data-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@crewhaus/data-pkg", version: "0.0.0", main: "src/index.ts", files }),
    );

    Bun.spawnSync(["bun", SCRIPT, "--version", "0.3.1", "--for-publish", "--root", root]);
    // Assert the WRITTEN package.json: the src→dist transform lands before the
    // script's final biome-reformat step, so the output is correct regardless of
    // whether biome is installed in this isolated fixture (it is in CI, not in a
    // bare worktree — so the exit code is environment-dependent, the output is not).
    const out = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return { files: out.files, main: out.main };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("--for-publish preserves a package's uncompiled data dirs (default-skills' skills/commands)", () => {
  const r = runForPublish(["src", "skills", "commands", "README.md", "LICENSE", "NOTICE"]);
  expect(r.main).toBe("dist/index.js");
  // `skills`/`commands` survive; only `src` maps to `dist`. A hardcoded
  // ["dist", …] here would drop them and every compiled agent-loop bundle
  // would crash at boot on a missing SKILL.md.
  expect(r.files).toEqual(["dist", "skills", "commands", "README.md", "LICENSE", "NOTICE"]);
});

test("--for-publish still flips a plain code package's files src→dist", () => {
  const r = runForPublish(["src", "README.md", "LICENSE", "NOTICE"]);
  expect(r.files).toEqual(["dist", "README.md", "LICENSE", "NOTICE"]);
});

// Smoke: the whole reason the fix matters — the PUBLISHED tarball of a data-dir
// package must actually contain its runtime files. This tracks the REAL
// @crewhaus/default-skills (its `dist/index.js` reads `skills/<name>/SKILL.md`
// and `commands/<name>.md` at boot; a bundle that can't find them crashes with
// ENOENT). Runs the real `--for-publish` transform, then `bun pm pack` — the
// exact artifact a release publishes — and asserts the data files are packed.
// Before the fix (`files: ["dist", …]`) this pack list omits them and fails.
const FACTORY_ROOT = dirname(import.meta.dir);
const REAL_DEFAULT_SKILLS = join(FACTORY_ROOT, "packages", "default-skills");

test("the published default-skills tarball ships its skills/ + commands/ runtime files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "release-prep-pack-"));
  const root = join(tmp, "factory");
  const pkgDir = join(root, "packages", "default-skills");
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", private: true, version: "0.0.0", workspaces: ["packages/*"] }),
    );
    // Copy the real package (its package.json + skills/ + commands/), minus the
    // build/dev output, so the smoke reflects the actual shipped package.
    cpSync(REAL_DEFAULT_SKILLS, pkgDir, {
      recursive: true,
      filter: (src) => !src.includes(`${"/"}node_modules`) && !/[/\\]dist([/\\]|$)/.test(src),
    });
    // Drop workspace deps so `bun pm pack` (which resolves `workspace:*`) can run
    // in this isolated fixture. The smoke asserts packed FILES, which the `files`
    // glob determines independently of dependencies.
    const pkgJsonPath = join(pkgDir, "package.json");
    const copied = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    for (const k of [
      "dependencies",
      "peerDependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      delete copied[k];
    }
    writeFileSync(pkgJsonPath, JSON.stringify(copied));

    // The real publish path: rewrite entrypoints/`files` for publish, then pack.
    Bun.spawnSync(["bun", SCRIPT, "--version", "0.3.1", "--for-publish", "--root", root]);
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: pkgDir });
    const manifest = packed.stdout.toString();

    // A bare `dist`-only tarball (the bug) would omit both of these.
    expect(manifest).toContain("skills/continuity/SKILL.md");
    expect(manifest).toMatch(/commands\/\w[\w-]*\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
