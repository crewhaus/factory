import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// release-prep.ts exits at module load without --version, so it is exercised as
// a subprocess rather than imported.
const SCRIPT = join(import.meta.dir, "release-prep.ts");
const FACTORY_ROOT = dirname(import.meta.dir);
const REAL_BIOME = join(FACTORY_ROOT, "node_modules", ".bin", "biome");

const LICENSE_TEXT = "LICENSE-SENTINEL\n";
const NOTICE_TEXT = "NOTICE-SENTINEL\n";

type RootOptions = {
  /** Root `engines`; null leaves the field out. */
  engines?: Record<string, string> | null;
  license?: string | null;
  notice?: string | null;
  /**
   * Link the workspace's pinned biome into the fixture, so the script's final
   * reformat step runs and the exit code means something. Without it the script
   * writes everything and then exits 1 on "biome not found".
   */
  biome?: boolean;
};

/** A workspace root named `factory` (release-prep keys repo metadata off the basename). */
function makeRoot(opts: RootOptions = {}): { tmp: string; root: string } {
  const tmp = mkdtempSync(join(tmpdir(), "release-prep-"));
  const root = join(tmp, "factory");
  mkdirSync(root, { recursive: true });
  const engines = opts.engines === undefined ? { bun: ">=1.2.0" } : opts.engines;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "root",
      private: true,
      version: "0.0.0",
      workspaces: ["packages/*"],
      ...(engines === null ? {} : { engines }),
    }),
  );
  const license = opts.license === undefined ? LICENSE_TEXT : opts.license;
  const notice = opts.notice === undefined ? NOTICE_TEXT : opts.notice;
  if (license !== null) writeFileSync(join(root, "LICENSE"), license);
  if (notice !== null) writeFileSync(join(root, "NOTICE"), notice);
  if (opts.biome) {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    symlinkSync(REAL_BIOME, join(root, "node_modules", ".bin", "biome"));
  }
  return { tmp, root };
}

function addPkg(root: string, dir: string, manifest: Record<string, unknown>): string {
  const pkgDir = join(root, "packages", dir);
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(join(pkgDir, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest));
  return pkgDir;
}

function runPrep(root: string, ...args: string[]) {
  const r = Bun.spawnSync(["bun", SCRIPT, "--version", "0.3.1", ...args, "--root", root]);
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const readPkg = (pkgDir: string) => JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

function runForPublish(files: string[]): { files: unknown; main: unknown } {
  const { tmp, root } = makeRoot();
  try {
    const pkgDir = addPkg(root, "data-pkg", {
      name: "@crewhaus/data-pkg",
      version: "0.0.0",
      main: "src/index.ts",
      files,
    });
    runPrep(root, "--for-publish");
    // Assert the WRITTEN package.json: the src→dist transform lands before the
    // script's final biome-reformat step, so the output is correct regardless of
    // whether biome is installed in this isolated fixture.
    const out = readPkg(pkgDir);
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
const REAL_DEFAULT_SKILLS = join(FACTORY_ROOT, "packages", "default-skills");

test("the published default-skills tarball ships its skills/ + commands/ runtime files", () => {
  const { tmp, root } = makeRoot();
  const pkgDir = join(root, "packages", "default-skills");
  try {
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
    runPrep(root, "--for-publish");
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: pkgDir });
    const manifest = packed.stdout.toString();

    // A bare `dist`-only tarball (the bug) would omit both of these.
    expect(manifest).toContain("skills/continuity/SKILL.md");
    expect(manifest).toMatch(/commands\/\w[\w-]*\.md/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── LICENSE / NOTICE / README in the tarball ─────────────────────────────────

test("--for-publish puts the root LICENSE and NOTICE and a README into the packed tarball", () => {
  const { tmp, root } = makeRoot({ biome: true });
  try {
    const pkgDir = addPkg(root, "data-pkg", {
      name: "@crewhaus/tool-data-pkg",
      version: "0.0.0",
      description: "Reads and writes data files.",
      main: "src/index.ts",
      files: ["src", "README.md", "LICENSE", "NOTICE"],
    });
    mkdirSync(join(pkgDir, "dist"));
    writeFileSync(join(pkgDir, "dist", "index.js"), "export const answer = 42;\n");

    const r = runPrep(root, "--for-publish");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Copied 2 LICENSE/NOTICE file(s)");
    expect(r.stdout).toContain("wrote 1 generated README.md file(s)");

    expect(readFileSync(join(pkgDir, "LICENSE"), "utf8")).toBe(LICENSE_TEXT);
    expect(readFileSync(join(pkgDir, "NOTICE"), "utf8")).toBe(NOTICE_TEXT);
    const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
    expect(readme.split("\n")[0]).toBe("# @crewhaus/tool-data-pkg");
    expect(readme).toContain("Reads and writes data files.");
    expect(readme).toContain("Bun](https://bun.sh) `>=1.2.0`; plain Node is not supported.");
    expect(readme).toContain("TOOLS-REFERENCE.md");
    expect(readme).toContain("https://github.com/crewhaus/factory/tree/main/packages/data-pkg");

    // The packed artifact, not the directory: npm packs a `files` entry only
    // when it is there, and skips a missing one without a word.
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: pkgDir });
    const listing = packed.stdout.toString();
    expect(listing).toMatch(/\bLICENSE\b/);
    expect(listing).toMatch(/\bNOTICE\b/);
    expect(listing).toMatch(/\bREADME\.md\b/);

    // Idempotent: a second run finds nothing to change and nothing to copy.
    const again = runPrep(root, "--for-publish");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("Updated: 0");
    expect(again.stdout).toContain("Copied 0 LICENSE/NOTICE file(s)");
    expect(again.stdout).toContain("wrote 0 generated README.md file(s)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);

test("--for-publish overwrites a committed copy that drifted and keeps a package's own README", () => {
  const { tmp, root } = makeRoot();
  try {
    const pkgDir = addPkg(root, "drifted", {
      name: "@crewhaus/drifted",
      version: "0.0.0",
      files: ["src", "README.md", "LICENSE", "NOTICE"],
    });
    writeFileSync(join(pkgDir, "NOTICE"), "an old NOTICE\n");
    writeFileSync(join(pkgDir, "LICENSE"), LICENSE_TEXT);
    writeFileSync(join(pkgDir, "README.md"), "# hand-written\n");
    const r = runPrep(root, "--for-publish");
    expect(r.stdout).toContain("Copied 1 LICENSE/NOTICE file(s)");
    expect(r.stdout).toContain("wrote 0 generated README.md file(s)");
    expect(readFileSync(join(pkgDir, "NOTICE"), "utf8")).toBe(NOTICE_TEXT);
    expect(readFileSync(join(pkgDir, "README.md"), "utf8")).toBe("# hand-written\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--for-publish refuses a package whose LICENSE is a symlink, naming it", () => {
  const { tmp, root } = makeRoot({ biome: true });
  try {
    const pkgDir = addPkg(root, "linked", { name: "@crewhaus/linked", version: "0.0.0" });
    symlinkSync(join(root, "LICENSE"), join(pkgDir, "LICENSE"));
    const r = runPrep(root, "--for-publish");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("packages/linked/LICENSE is not a regular file");
    // The link is left for the operator, not written through.
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toBe(LICENSE_TEXT);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--for-publish with no root NOTICE fails before stamping anything, and names NOTICE", () => {
  const { tmp, root } = makeRoot({ notice: null, biome: true });
  try {
    const manifest = { name: "@crewhaus/data-pkg", version: "0.0.0", main: "src/index.ts" };
    const pkgDir = addPkg(root, "data-pkg", manifest);
    const r = runPrep(root, "--for-publish");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("has no NOTICE");
    expect(readPkg(pkgDir)).toEqual(manifest);
    expect(existsSync(join(pkgDir, "LICENSE"))).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--for-publish --check reports the files it would place and writes none", () => {
  const { tmp, root } = makeRoot();
  try {
    const pkgDir = addPkg(root, "data-pkg", { name: "@crewhaus/data-pkg", version: "0.0.0" });
    const r = runPrep(root, "--for-publish", "--check");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("+ packages/data-pkg/LICENSE (would copy from the root)");
    expect(r.stdout).toContain("+ packages/data-pkg/NOTICE (would copy from the root)");
    expect(r.stdout).toContain("+ packages/data-pkg/README.md (would write a generated README)");
    for (const f of ["LICENSE", "NOTICE", "README.md"]) {
      expect(existsSync(join(pkgDir, f))).toBe(false);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a bare --version run places no files: that output is committed", () => {
  const { tmp, root } = makeRoot({ biome: true });
  try {
    const pkgDir = addPkg(root, "data-pkg", { name: "@crewhaus/data-pkg", version: "0.0.0" });
    const r = runPrep(root);
    expect(r.exitCode).toBe(0);
    for (const f of ["LICENSE", "NOTICE", "README.md"]) {
      expect(existsSync(join(pkgDir, f))).toBe(false);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── engines + the `default` export condition ─────────────────────────────────

test("every publishable manifest is stamped with the root's engines.bun, on both run forms", () => {
  for (const mode of [[], ["--for-publish"]]) {
    const { tmp, root } = makeRoot({ engines: { bun: ">=1.2.0" }, biome: true });
    try {
      const plain = addPkg(root, "plain", { name: "@crewhaus/plain", version: "0.0.0" });
      const withNode = addPkg(root, "with-node", {
        name: "@crewhaus/with-node",
        version: "0.0.0",
        engines: { node: ">=22" },
      });
      const cli = addPkg(root, "cli", { name: "crewhaus", version: "0.0.0" });
      const other = addPkg(root, "other", { name: "someone-else", version: "0.0.0" });
      const r = runPrep(root, ...mode);
      expect(r.exitCode).toBe(0);
      expect(readPkg(plain).engines).toEqual({ bun: ">=1.2.0" });
      expect(readPkg(withNode).engines).toEqual({ node: ">=22", bun: ">=1.2.0" });
      expect(readPkg(cli).engines).toEqual({ bun: ">=1.2.0" });
      // Not ours to publish, so not ours to stamp.
      expect(readPkg(other).engines).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}, 30_000);

test("a package's own engines.bun is kept when it asks for a newer Bun, and raised when it is older", () => {
  for (const mode of [[], ["--for-publish"]]) {
    const { tmp, root } = makeRoot({ engines: { bun: ">=1.2.0" }, biome: true });
    try {
      const pkg = (dir: string, engines: Record<string, string>) =>
        addPkg(root, dir, { name: `@crewhaus/${dir}`, version: "0.0.0", engines });
      // It uses an API from a newer Bun: stamping the root's range would claim
      // it runs where it does not.
      const newer = pkg("newer", { bun: ">=1.3" });
      // Stamped before the root was raised: it rises with the root.
      const older = pkg("older", { bun: ">= 1.1.9", node: ">=22" });
      const same = pkg("same", { bun: ">=1.2.0" });
      const r = runPrep(root, ...mode);
      expect(r.exitCode).toBe(0);
      expect(readPkg(newer).engines).toEqual({ bun: ">=1.3" });
      expect(readPkg(older).engines).toEqual({ bun: ">=1.2.0", node: ">=22" });
      expect(readPkg(same).engines).toEqual({ bun: ">=1.2.0" });
      if (mode.length > 0) {
        // The generated README states the range the manifest does.
        expect(readFileSync(join(newer, "README.md"), "utf8")).toContain(
          "Bun](https://bun.sh) `>=1.3`; plain Node is not supported.",
        );
        expect(readFileSync(join(older, "README.md"), "utf8")).toContain(
          "Bun](https://bun.sh) `>=1.2.0`; plain Node is not supported.",
        );
      }
      // And a second run leaves both where they are.
      const again = runPrep(root, ...mode);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain("Updated: 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}, 60_000);

test("a package engines.bun that cannot be ordered against the root's is refused, named, before anything is written", () => {
  const { tmp, root } = makeRoot({ biome: true });
  try {
    const plain = { name: "@crewhaus/aa-plain", version: "0.0.0" };
    const caret = { name: "@crewhaus/caret", version: "0.0.0", engines: { bun: "^1.3.0" } };
    const plainDir = addPkg(root, "aa-plain", plain);
    const caretDir = addPkg(root, "caret", caret);
    const r = runPrep(root, "--for-publish");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot stamp engines.bun (nothing was written)");
    expect(r.stderr).toContain(
      `packages/caret/package.json: engines.bun is "^1.3.0" but the root's is ">=1.2.0"`,
    );
    expect(readPkg(plainDir)).toEqual(plain);
    expect(readPkg(caretDir)).toEqual(caret);
    expect(existsSync(join(plainDir, "LICENSE"))).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a root package.json without engines.bun is refused, before anything is written", () => {
  const { tmp, root } = makeRoot({ engines: null });
  try {
    const manifest = { name: "@crewhaus/plain", version: "0.0.0" };
    const pkgDir = addPkg(root, "plain", manifest);
    const r = runPrep(root);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("root package.json must declare engines.bun");
    expect(readPkg(pkgDir)).toEqual(manifest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--for-publish export targets carry a `default` condition, last", () => {
  const { tmp, root } = makeRoot();
  try {
    const pkgDir = addPkg(root, "tool-x", {
      name: "@crewhaus/tool-x",
      version: "0.0.0",
      type: "module",
      main: "src/index.ts",
      exports: {
        ".": "./src/index.ts",
        "./sub": { types: "./src/sub.ts", import: "./src/sub.ts" },
        "./cjs": { import: "./src/cjs.ts", require: "./cjs/index.cjs" },
        "./package.json": "./package.json",
      },
    });
    runPrep(root, "--for-publish");
    const exp = readPkg(pkgDir).exports;
    expect(exp["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(Object.keys(exp["."]).at(-1)).toBe("default");
    expect(exp["./sub"]).toEqual({
      types: "./dist/sub.d.ts",
      import: "./dist/sub.js",
      default: "./dist/sub.js",
    });
    expect(Object.keys(exp["./sub"]).at(-1)).toBe("default");
    // A target that already says what require gets is left to say it.
    expect(exp["./cjs"]).toEqual({ import: "./dist/cjs.js", require: "./cjs/index.cjs" });
    expect(exp["./package.json"]).toBe("./package.json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The packed-tarball smoke for the claim the manifest makes: on Bun, the package
// both imports and requires. Before the `default` condition, require() of every
// published package failed with MODULE_NOT_FOUND on Bun (and
// ERR_PACKAGE_PATH_NOT_EXPORTED on Node). Only Bun is exercised: that is the
// runtime the stamped engines field claims.
test("a --for-publish tarball both imports and requires on Bun", () => {
  const { tmp, root } = makeRoot();
  try {
    const pkgDir = addPkg(root, "zz-req", {
      name: "@crewhaus/zz-req",
      version: "0.0.0",
      type: "module",
      main: "src/index.ts",
      exports: { ".": "./src/index.ts" },
      files: ["src", "README.md", "LICENSE", "NOTICE"],
    });
    mkdirSync(join(pkgDir, "dist"));
    writeFileSync(join(pkgDir, "dist", "index.js"), "export const answer = 42;\n");
    runPrep(root, "--for-publish");
    const pack = Bun.spawnSync(["bun", "pm", "pack", "--quiet"], { cwd: pkgDir });
    expect(pack.exitCode).toBe(0);
    const tarball = join(pkgDir, "crewhaus-zz-req-0.3.1.tgz");
    expect(existsSync(tarball)).toBe(true);

    const consumer = join(tmp, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "c", private: true }));
    const add = Bun.spawnSync(["bun", "add", tarball], { cwd: consumer });
    expect(add.exitCode).toBe(0);
    writeFileSync(
      join(consumer, "r.cjs"),
      'console.log("require", require("@crewhaus/zz-req").answer);\n',
    );
    writeFileSync(
      join(consumer, "i.mjs"),
      'console.log("import", (await import("@crewhaus/zz-req")).answer);\n',
    );
    const req = Bun.spawnSync(["bun", "r.cjs"], { cwd: consumer });
    expect(req.stderr.toString()).toBe("");
    expect(req.stdout.toString().trim()).toBe("require 42");
    const imp = Bun.spawnSync(["bun", "i.mjs"], { cwd: consumer });
    expect(imp.stdout.toString().trim()).toBe("import 42");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);
