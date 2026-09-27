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
 *
 * Every publishable manifest is stamped with the workspace root's `engines.bun`
 * (or its own, when that asks for a newer Bun): the libraries run on Bun only,
 * and the manifest should say so. `--for-publish`
 * also copies the root LICENSE and NOTICE into every publishable package (npm
 * packs a `files` entry only when the file is there, and skips a missing one
 * silently) and writes a short README.md where a package has none.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
// tarball loads on Bun (>= the root's engines.bun) without TS type-stripping. It is
// NOT plain-Node loadable: tsc keeps the extensionless relative specifiers that
// `moduleResolution: Bundler` allows, and many packages call Bun.* APIs or import
// text with `with { type: "text" }`. The stamped `engines.bun` says so.
// This is a PUBLISH-ONLY transform — the committed tree stays on src/ so the Bun dev
// flow needs no build step. The release workflow runs `bun run build` before this and
// publishes the dist output; a bare `--version` run (the in-repo lockstep version
// bump) must NOT pass this flag.
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

const rootPkgPath = join(ROOT, "package.json");
if (!existsSync(rootPkgPath)) {
  console.error(`No package.json at workspace root: ${ROOT}`);
  process.exit(1);
}

/**
 * The Bun range every publishable manifest is stamped with, read from the
 * workspace root so there is one copy of it. `engines.bun` is advisory — npm,
 * pnpm and yarn do not enforce an engine they do not know — but it is the one
 * place a registry page and a package manager can read the requirement from.
 */
const ROOT_BUN_ENGINE = (() => {
  const engines = readJson(rootPkgPath).engines as Record<string, unknown> | undefined;
  const bun = engines?.bun;
  if (typeof bun !== "string" || bun.trim() === "") {
    console.error(
      "✗ root package.json must declare engines.bun — it is the Bun range stamped on every published package.",
    );
    process.exit(1);
  }
  return bun;
})();

/** A bare lower bound (`>=1.2`, `>= 1.2.3`): the one range shape two of can be ordered. */
const LOWER_BOUND = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

function lowerBound(range: string): string | undefined {
  const m = range.trim().match(LOWER_BOUND);
  return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : undefined;
}

/**
 * The engines.bun a package is stamped with: the stricter of its own and the
 * root's. A package that needs a newer Bun than the rest (it calls a newer API)
 * keeps saying so; one stamped by an earlier run, before the root was raised, is
 * raised with it. Only bare `>=` bounds can be ordered here, so any other range
 * that differs from the root's is refused rather than overwritten either way.
 */
function stampedBunEngine(
  own: unknown,
  root: string,
): { readonly ok: true; readonly range: string } | { readonly ok: false; readonly reason: string } {
  if (own === undefined || own === root) return { ok: true, range: root };
  if (typeof own !== "string") {
    return { ok: false, reason: `engines.bun is ${JSON.stringify(own)}, not a version range` };
  }
  const mine = lowerBound(own);
  const theirs = lowerBound(root);
  if (mine === undefined || theirs === undefined) {
    return {
      ok: false,
      reason: `engines.bun is "${own}" but the root's is "${root}", and only ">=x.y.z" ranges can be compared — make it ">=x.y.z" or remove it`,
    };
  }
  return { ok: true, range: Bun.semver.order(mine, theirs) > 0 ? own : root };
}

/** Root files every published package carries (Apache-2.0 §4(a) and §4(d)). */
const LEGAL_FILES = ["LICENSE", "NOTICE"] as const;

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

/**
 * A single exports target: "./src/x.ts" → { types, import, default }; conditional
 * objects remap in place and gain a `default` equal to their `import`.
 *
 * `default` is what a resolver falls back to when it does not pass `import` — Bun's
 * and Node's `require()` among them. Without it every subpath of every package was
 * unresolvable there (MODULE_NOT_FOUND / ERR_PACKAGE_PATH_NOT_EXPORTED). It points at
 * the same ESM file, so this is not a CommonJS build: it only stops the resolver
 * from refusing. `types` stays first and `default` last, as condition order requires.
 */
function distExportTarget(value: unknown): unknown {
  if (typeof value === "string") {
    if (!/\.tsx?$/.test(value)) return value;
    const js = toDist(value, ".js");
    return { types: toDist(value, ".d.ts"), import: js, default: js };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [cond, v] of Object.entries(value as Record<string, unknown>)) {
      out[cond] =
        typeof v === "string" && /\.tsx?$/.test(v)
          ? toDist(v, cond === "types" ? ".d.ts" : ".js")
          : distExportTarget(v);
    }
    if (typeof out.import === "string" && out.default === undefined && out.require === undefined) {
      out.default = out.import;
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

/**
 * Publishable: scoped @crewhaus/* and crewhaus-* packages, plus the bare
 * `crewhaus` CLI (apps/cli). The root workspace stays private.
 */
function isPublishableName(name: unknown): name is string {
  return typeof name === "string" && (name === "crewhaus" || /^@?crewhaus[-/]/.test(name));
}

/** Apply the release-prep transforms to a package.json object. Returns true if changed. */
function applyRelease(pkg: Json, pkgDir: string, isRoot: boolean): boolean {
  let changed = false;
  if (isRoot || !isPublishableName(pkg.name)) {
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

  // engines: the runtime the package needs — the root's Bun range, or the package's
  // own when it asks for a newer Bun. Stamped on the committed tree too (not only
  // --for-publish): the src/*.ts entrypoints are Bun-only as well. Any other engine
  // a package declares is kept. The pre-pass in main refused a range that cannot
  // be ordered against the root's, before anything was written.
  const engines =
    pkg.engines !== null && typeof pkg.engines === "object" ? (pkg.engines as Json) : {};
  const bun = stampedBunEngine(engines.bun, ROOT_BUN_ENGINE);
  set("engines", { ...engines, bun: bun.ok ? bun.range : ROOT_BUN_ENGINE });

  // files (default to src + README + LICENSE; respect existing if present)
  if (pkg.files === undefined) {
    set("files", [...DEFAULT_FILES]);
  }

  // --for-publish: flip entrypoints + the packed `files` from src → built dist so the
  // tarball loads on Bun without TS type-stripping (not on plain Node — see
  // FOR_PUBLISH above), and resolve internal `workspace:*` deps to the concrete
  // version being cut.
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

// ─── --for-publish: the files a tarball carries besides its code ─────────────

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The README.md written into a package that has none, so its npm page says what
 * it is and what it needs instead of "no README". Only written at publish time
 * (never committed by this script) and never over a README a package already has.
 */
function generatedReadme(pkg: Json, relDir: string): string {
  const name = pkg.name as string;
  const out = [`# ${name}`, ""];
  const description = typeof pkg.description === "string" ? pkg.description.trim() : "";
  if (description !== "") out.push(description, "");
  if (name !== "crewhaus") {
    out.push(
      `Part of [CrewHaus](${HOMEPAGE_BASE}). Most people install the CLI (\`npm install -g crewhaus\`) rather than this package.`,
      "",
    );
  }
  if (name.startsWith("@crewhaus/tool-")) {
    out.push(
      "Which tools a spec can turn on, and how: [tools reference](https://github.com/crewhaus/docs/blob/main/TOOLS-REFERENCE.md).",
      "",
    );
  }
  // The range this package was stamped with (applyRelease ran first), which may be
  // newer than the root's.
  const bun = (pkg.engines as Json | undefined)?.bun;
  out.push(
    `Requires [Bun](https://bun.sh) \`${typeof bun === "string" ? bun : ROOT_BUN_ENGINE}\`; plain Node is not supported.`,
    "",
  );
  out.push(`[Source](${HOMEPAGE_BASE}/tree/main/${relDir})`, "");
  return out.join("\n");
}

let legalCopied = 0;
let readmesWritten = 0;

/**
 * Put LICENSE, NOTICE and a README.md into a publishable package dir. The legal
 * files always come from the root (a committed copy that drifted is overwritten,
 * so what ships is the root text); a README the package has is left alone.
 */
function placePublishFiles(pkg: Json, dir: string, errors: string[]): void {
  for (const file of LEGAL_FILES) {
    const src = join(ROOT, file);
    const dest = join(dir, file);
    const rel = relative(ROOT, dest);
    if (existsSync(dest) || isSymlink(dest)) {
      if (!isRegularFile(dest)) {
        errors.push(
          `${rel} is not a regular file — npm would not pack it; replace it with a plain file or remove it`,
        );
        continue;
      }
      if (readFileSync(dest).equals(readFileSync(src))) continue;
    }
    if (CHECK) {
      console.log(`  + ${rel} (would copy from the root)`);
    } else {
      copyFileSync(src, dest);
    }
    legalCopied++;
  }
  const readme = join(dir, "README.md");
  if (existsSync(readme) || isSymlink(readme)) return;
  if (CHECK) {
    console.log(`  + ${relative(ROOT, readme)} (would write a generated README)`);
  } else {
    writeFileSync(readme, generatedReadme(pkg, relative(ROOT, dir)));
  }
  readmesWritten++;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
const pkgDirs = discoverWorkspacePackages(rootPkgPath);
console.log(`Found ${pkgDirs.length} workspace packages under ${ROOT}`);
console.log(`Target version: ${TARGET_VERSION}`);
console.log(`publishConfig.access: ${ACCESS}`);
console.log(`Mode: ${CHECK ? "CHECK (dry-run)" : "WRITE"}`);
console.log("");

// Refuse before stamping anything: a package without them ships without the
// license text and attribution notice Apache-2.0 §4(a) and §4(d) require.
if (FOR_PUBLISH) {
  const missing = LEGAL_FILES.filter((f) => !isRegularFile(join(ROOT, f)));
  if (missing.length > 0) {
    console.error(
      `✗ --for-publish copies the root ${LEGAL_FILES.join(" and ")} into every published package, but ${ROOT} has no ${missing.join(" or ")} (as a regular file).`,
    );
    process.exit(1);
  }
}

// Refuse before stamping anything: a package's own engines.bun that cannot be
// ordered against the root's would otherwise be overwritten one way or the other.
{
  const unorderable: string[] = [];
  for (const dir of pkgDirs) {
    let pkg: Json;
    try {
      pkg = readJson(join(dir, "package.json"));
    } catch {
      continue; // the loop below reports an unreadable manifest
    }
    if (!isPublishableName(pkg.name)) continue;
    const engines = pkg.engines !== null && typeof pkg.engines === "object" ? pkg.engines : {};
    const bun = stampedBunEngine((engines as Json).bun, ROOT_BUN_ENGINE);
    if (!bun.ok) unorderable.push(`${relative(ROOT, join(dir, "package.json"))}: ${bun.reason}`);
  }
  if (unorderable.length > 0) {
    console.error("✗ cannot stamp engines.bun (nothing was written):");
    for (const u of unorderable) console.error(`  ${u}`);
    process.exit(1);
  }
}

let updated = 0;
let unchanged = 0;
const errors: string[] = [];
const written: string[] = [];

for (const dir of pkgDirs) {
  const path = join(dir, "package.json");
  try {
    const pkg = readJson(path);
    const before = JSON.stringify(pkg);
    const changed = applyRelease(pkg, dir, false) && JSON.stringify(pkg) !== before;
    if (changed) {
      updated++;
      console.log(`  ✎ ${relative(ROOT, path)} → ${pkg.version}`);
      if (!CHECK) {
        writeJson(path, pkg);
        written.push(path);
      }
    } else {
      unchanged++;
    }
    // Whether or not the manifest changed: a re-run must still place the files.
    if (FOR_PUBLISH && isPublishableName(pkg.name)) placePublishFiles(pkg, dir, errors);
  } catch (err) {
    errors.push(`${path}: ${(err as Error).message}`);
  }
}

if (FOR_PUBLISH) {
  const verb = CHECK ? "Would copy" : "Copied";
  console.log(
    `${verb} ${legalCopied} LICENSE/NOTICE file(s) from the root; ${CHECK ? "would write" : "wrote"} ${readmesWritten} generated README.md file(s).`,
  );
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
