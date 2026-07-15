import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// release-prep.ts exits at module load without --version, so it is exercised as
// a subprocess rather than imported.
const SCRIPT = join(import.meta.dir, "release-prep.ts");

function runForPublish(files: string[]): { exitCode: number; files: unknown; main: unknown } {
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
