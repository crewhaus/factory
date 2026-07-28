#!/usr/bin/env bun
/**
 * release-prep.ts — Prepares all publishable packages in a workspace for npm publish.
 *
 * Idempotent: updates package.json metadata for every package whose name starts with
 * "@crewhaus/" or "crewhaus-" (root workspace packages stay private as configured).
 *
 * Run:
 *   bun scripts/release-prep.ts --version 0.1.3            # stamp every package (lockstep)
 *   bun scripts/release-prep.ts --version 0.1.3 --check    # diff-only, no writes
 *   bun scripts/release-prep.ts --version 0.1.3 --access restricted   # override access
 *   bun scripts/release-prep.ts --version 0.1.3 --for-publish         # also flip src→dist entrypoints (CI publish only)
 *
 * The bare `--version` form is what the in-repo lockstep bump commit runs (entrypoints
 * stay on src so the Bun dev flow needs no build). `--for-publish` is the CI-only form:
 * the Release workflow runs `bun run build` then this with `--for-publish`, so the packed
 * tarball ships compiled dist/*.js + .d.ts. Never commit the `--for-publish` output.
 *
 * `--version` is REQUIRED — there is no safe default for a flag that stamps
 * every publishable package (a bare run used to silently downgrade the whole
 * workspace to 0.1.0/restricted). Access defaults to "public", the live
 * scope. After writing, the touched files are re-run through biome so the
 * bump commits lint-clean.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const versionFlag = flag("version");
if (versionFlag === undefined) {
  console.error("✗ --version is required: it stamps EVERY publishable package in lockstep.");
  console.error(
    "  Usage: bun scripts/release-prep.ts --version <semver> [--access public|restricted] [--for-publish] [--check] [--root <dir>]",
  );
  process.exit(1);
}
const TARGET_VERSION = versionFlag;
const ACCESS = (flag("access") ?? "public") as "restricted" | "public";
const CHECK = has("check");
// --for-publish additionally rewrites entrypoints (main/types/exports/bin) and the
// `files` allowlist from src/*.ts to the compiled dist/*.js + .d.ts, so the packed
// tarball is loadable under plain Node (no TS type-stripping). This is a PUBLISH-ONLY
// transform — the committed tree stays on src/ so the Bun dev flow needs no build step.
// The release workflow runs `bun run build` before this and publishes the dist output;
// a bare `--version` run (the in-repo lockstep version bump) must NOT pass this flag.
const FOR_PUBLISH = has("for-publish");
const ROOT = resolve(flag("root") ?? process.cwd());

const AUTHOR = {
  name: "Max Meier",
  email: "max@crewhaus.ai",
  url: "https://crewhaus.ai",
};

// Map workspace root → GitHub repo info
const REPO_BY_BASENAME: Record<string, { owner: string; repo: string }> = {
  factory: { owner: "crewhaus", repo: "factory" },
  utilities: { owner: "crewhaus", repo: "utilities" },
  demos: { owner: "crewhaus", repo: "demos" },
  docs: { owner: "crewhaus", repo: "docs" },
  "studio-pwa": { owner: "crewhaus", repo: "studio-pwa" },
};

const repoBase = (() => {
  const parts = ROOT.split("/");
  const base = parts[parts.length - 1] ?? "";
  return REPO_BY_BASENAME[base];
})();

if (!repoBase) {
  console.error(`Unknown workspace root: ${ROOT}. Update REPO_BY_BASENAME in release-prep.ts.`);
  process.exit(1);
}

const REPO_URL = `https://github.com/${repoBase.owner}/${repoBase.repo}.git`;
const HOMEPAGE_BASE = `https://github.com/${repoBase.owner}/${repoBase.repo}`;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: Json) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ─── --for-publish: rewrite src entrypoints to their compiled dist outputs ────
// tsconfig builds `src/*.ts` (rootDir) → `dist/*.js` + `dist/*.d.ts` (outDir).

/** "./src/index.ts" → "./dist/index.js"; "src/foo.ts" → "dist/foo.js" (preserves ./). */
function toDist(p: string, ext: ".js" | ".d.ts"): string {
  const dotSlash = p.startsWith("./");
  const rel = p
    .replace(/^\.\//, "")
    .replace(/^src\//, "dist/")
    .replace(/\.tsx?$/, ext === ".js" ? ".js" : ".d.ts");
  return dotSlash ? `./${rel}` : rel;
}

/** Default packed allowlist for a package with no explicit `files`. */
const DEFAULT_FILES = ["src", "README.md", "LICENSE", "NOTICE"];

/**
 * `--for-publish` packed `files`: map `src` → `dist`, keep every other entry.
 * Runtime data dirs that ship uncompiled (e.g. default-skills' `skills`/
 * `commands`) MUST survive into the tarball — replacing the whole array with a
 * literal `["dist", …]` silently drops them. `dist` is guaranteed present.
 */
function distFilesForPublish(files: readonly string[]): string[] {
  const mapped = files.map((f) => (f === "src" ? "dist" : f));
  return mapped.includes("dist") ? mapped : ["dist", ...mapped];
}

/** A single exports target: "./src/x.ts" → { types, import }; conditional objects remap in place. */
function distExportTarget(value: unknown): unknown {
  if (typeof value === "string") {
    return /\.tsx?$/.test(value)
      ? { types: toDist(value, ".d.ts"), import: toDist(value, ".js") }
      : value;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [cond, v] of Object.entries(value as Record<string, unknown>)) {
      out[cond] =
        typeof v === "string" && /\.tsx?$/.test(v)
          ? toDist(v, cond === "types" ? ".d.ts" : ".js")
          : distExportTarget(v);
    }
    return out;
  }
  return value;
}

/** bin: "src/index.ts" or { name: "src/index.ts" } → dist/index.js. */
function distBin(bin: unknown): unknown {
  if (typeof bin === "string") return /\.tsx?$/.test(bin) ? toDist(bin, ".js") : bin;
  if (bin && typeof bin === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(bin as Record<string, unknown>)) {
      out[name] = typeof v === "string" && /\.tsx?$/.test(v) ? toDist(v, ".js") : v;
    }
    return out;
  }
  return bin;
}

/** Get glob-expanded list of package dirs from workspace root. */
function discoverWorkspacePackages(rootPkgPath: string): string[] {
  const pkg = readJson(rootPkgPath) as { workspaces?: string[] };
  const ws = pkg.workspaces ?? [];
  const results: string[] = [];
  const rootDir = dirname(rootPkgPath);
  for (const pattern of ws) {
    // Supports: `*`, `dir/*`, `dir`. Sufficient for this repo's layout.
    if (pattern === "*") {
      for (const entry of readdirSync(rootDir)) {
        const dir = join(rootDir, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) {
          results.push(dir);
        }
      }
      continue;
    }
    const star = pattern.endsWith("/*");
    const base = star ? pattern.slice(0, -2) : pattern;
    const fullBase = join(rootDir, base);
    if (!existsSync(fullBase)) continue;
    if (star) {
      for (const entry of readdirSync(fullBase)) {
        const dir = join(fullBase, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) {
          results.push(dir);
        }
      }
    } else {
      if (statSync(fullBase).isDirectory() && existsSync(join(fullBase, "package.json"))) {
        results.push(fullBase);
      }
    }
  }
  return results;
}

/** Apply the release-prep transforms to a package.json object. Returns true if changed. */
function applyRelease(pkg: Json, pkgDir: string, isRoot: boolean): boolean {
  let changed = false;
  const name = pkg.name as string | undefined;
  // Publishable: scoped @crewhaus/* and crewhaus-* packages, plus the bare
  // `crewhaus` CLI (apps/cli). The root workspace stays private (isRoot).
  const isPublishable =
    !isRoot && typeof name === "string" && (name === "crewhaus" || /^@?crewhaus[-/]/.test(name));

  if (!isPublishable) {
    return false; // root workspace packages stay private as-is
  }

  const set = (key: string, value: unknown) => {
    if (JSON.stringify(pkg[key]) !== JSON.stringify(value)) {
      pkg[key] = value;
      changed = true;
    }
  };

  // version
  set("version", TARGET_VERSION);

  // private: remove (set to undefined so it doesn't serialize)
  if (pkg.private !== undefined) {
    pkg.private = undefined;
    changed = true;
  }

  // license
  set("license", "Apache-2.0");

  // author
  set("author", AUTHOR);

  // repository
  const relDir = relative(ROOT, pkgDir);
  set("repository", {
    type: "git",
    url: `git+${REPO_URL}`,
    directory: relDir || undefined,
  });

  // homepage / bugs
  set(
    "homepage",
    relDir ? `${HOMEPAGE_BASE}/tree/main/${relDir}#readme` : `${HOMEPAGE_BASE}#readme`,
  );
  set("bugs", { url: `${HOMEPAGE_BASE}/issues` });

  // publishConfig
  set("publishConfig", { access: ACCESS });

  // files (default to src + README + LICENSE; respect existing if present)
  if (pkg.files === undefined) {
    set("files", [...DEFAULT_FILES]);
  }

  // --for-publish: flip entrypoints + the packed `files` from src → built dist so the
  // tarball is plain-Node loadable, and resolve internal `workspace:*` deps to the
  // concrete version being cut.
  //
  // Resolving them HERE, from TARGET_VERSION, fixes two things at once.
  //
  // 1. It makes the stamped tree publisher-agnostic. `bun publish` rewrote
  //    `workspace:*` at pack time and `npm publish` does not — it ships the literal
  //    range and every install of the tarball then fails. That single difference is
  //    what pinned the release to bun, and bun cannot do OIDC trusted publishing
  //    (no --provenance, no id-token exchange as of 1.3.14), which npm now requires.
  //
  // 2. It removes a silent, install-breaking bug class. bun resolves `workspace:*`
  //    from **bun.lock**, not from the version just stamped — so a lockfile that
  //    predates the bump ships internal deps pinned to the PREVIOUS version.
  //    Verified: packing a freshly-stamped 0.4.3 tree against a 0.4.1 lockfile
  //    produced `crewhaus-eval-judge-0.4.3.tgz` whose deps all read "0.4.1". That is
  //    the bug that tombstoned v0.1.0, and why publish-workspace.ts used to delete
  //    bun.lock and reinstall before publishing. TARGET_VERSION cannot go stale.
  //
  // Only the three blocks that actually ship are rewritten. `devDependencies` are
  // dropped from the tarball by npm and bun alike (verified on both packers), so a
  // `workspace:` range surviving there never reaches a consumer.
  //
  // The pin is EXACT, not a caret range, to stay byte-identical to what bun already
  // published: `@crewhaus/eval-judge@0.4.0` on the registry declares
  // `"@crewhaus/errors": "0.4.0"`. A caret would silently widen every internal edge
  // across a 214-package lockstep graph.
  if (FOR_PUBLISH) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const deps = pkg[field];
      if (deps === null || typeof deps !== "object") continue;
      const next: Record<string, string> = {};
      let touched = false;
      for (const [dep, range] of Object.entries(deps as Record<string, string>)) {
        if (typeof range === "string" && range.startsWith("workspace:")) {
          next[dep] = TARGET_VERSION;
          touched = true;
        } else {
          next[dep] = range;
        }
      }
      if (touched) set(field, next);
    }
    if (typeof pkg.main === "string") set("main", toDist(pkg.main, ".js"));
    if (typeof pkg.types === "string") set("types", toDist(pkg.types, ".d.ts"));
    if (pkg.exports && typeof pkg.exports === "object") {
      const next: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(pkg.exports as Record<string, unknown>)) {
        next[key] = distExportTarget(val);
      }
      set("exports", next);
    } else if (typeof pkg.exports === "string") {
      set("exports", distExportTarget(pkg.exports));
    }
    if (pkg.bin !== undefined) set("bin", distBin(pkg.bin));
    // Map the packed allowlist src → dist, PRESERVING every non-`src` entry.
    // A hardcoded `["dist", …]` here dropped runtime data dirs that ship
    // uncompiled — e.g. `@crewhaus/default-skills`' `skills/`/`commands/`
    // (its `dist/index.js` reads `skills/<name>/SKILL.md` at boot), so every
    // compiled agent-loop bundle crashed at boot with ENOENT once default-on
    // continuity pulled the package in. Only `src` maps to `dist`.
    set("files", distFilesForPublish((pkg.files as string[] | undefined) ?? DEFAULT_FILES));
  }

  return changed;
}

// ─── main ──────────────────────────────────────────────────────────────────
const rootPkgPath = join(ROOT, "package.json");
if (!existsSync(rootPkgPath)) {
  console.error(`No package.json at workspace root: ${ROOT}`);
  process.exit(1);
}

const pkgDirs = discoverWorkspacePackages(rootPkgPath);
console.log(`Found ${pkgDirs.length} workspace packages under ${ROOT}`);
console.log(`Target version: ${TARGET_VERSION}`);
console.log(`publishConfig.access: ${ACCESS}`);
console.log(`Mode: ${CHECK ? "CHECK (dry-run)" : "WRITE"}`);
console.log("");

let updated = 0;
let unchanged = 0;
const errors: string[] = [];
const written: string[] = [];

for (const dir of pkgDirs) {
  const path = join(dir, "package.json");
  try {
    const pkg = readJson(path);
    const before = JSON.stringify(pkg);
    const changed = applyRelease(pkg, dir, false);
    if (changed) {
      const after = JSON.stringify(pkg);
      if (before === after) {
        unchanged++;
        continue;
      }
      updated++;
      console.log(`  ${changed ? "✎" : " "} ${relative(ROOT, path)} → ${pkg.version}`);
      if (!CHECK) {
        writeJson(path, pkg);
        written.push(path);
      }
    } else {
      unchanged++;
    }
  } catch (err) {
    errors.push(`${path}: ${(err as Error).message}`);
  }
}

console.log("");
console.log(`Updated: ${updated}  Unchanged: ${unchanged}  Errors: ${errors.length}`);
if (errors.length) {
  console.error("\nErrors:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

// writeJson's JSON.stringify array style differs from biome's (single-line
// `files` arrays get expanded); reformat the touched files so the bump
// commits lint-clean — the v0.1.2 cut hit 200 lint errors without this.
//
// This step is load-bearing: v0.3.0 shipped 209 unformatted `files` arrays to
// main (CI red for a day) because the reformat silently no-op'd. Two guards make
// that impossible:
//   1. Invoke the workspace's PINNED biome (node_modules/.bin/biome) rather than
//      `bun x biome` — the latter resolves to whatever biome is cached/latest
//      when node_modules isn't populated, and a different major formats
//      package.json differently, so the write lands non-canonical.
//   2. VERIFY after writing. `biome check --write` exits 0 even when it changes
//      nothing, so a no-op reformat would otherwise pass silently; a second
//      `biome check` (no --write) over the touched files hard-fails the script
//      if anything is still unformatted. release-prep can no longer exit 0
//      while leaving an un-normalized bump for CI to reject after it hits main.
if (written.length > 0) {
  const biome = join(ROOT, "node_modules", ".bin", "biome");
  if (!existsSync(biome)) {
    console.error(`✗ biome not found at ${relative(ROOT, biome)} — run \`bun install\` first.`);
    process.exit(1);
  }
  const fmt = spawnSync(biome, ["check", "--write", ...written], { cwd: ROOT, stdio: "inherit" });
  if (fmt.status !== 0) {
    console.error("✗ biome reformat failed; run `bun run lint:fix` before committing the bump.");
    process.exit(1);
  }
  const verify = spawnSync(biome, ["check", ...written], { cwd: ROOT, stdio: "inherit" });
  if (verify.status !== 0) {
    console.error(
      "✗ package.json still not biome-clean after reformat — refusing to leave an un-normalized bump. Run `bun run lint:fix`, then re-run.",
    );
    process.exit(1);
  }
  console.log(`Reformatted + verified ${written.length} written file(s) with biome.`);
}
