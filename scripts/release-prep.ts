#!/usr/bin/env bun
/**
 * release-prep.ts — Prepares all publishable packages in a workspace for npm publish.
 *
 * Idempotent: updates package.json metadata for every package whose name starts with
 * "@crewhaus/" or "crewhaus-" (root workspace packages stay private as configured).
 *
 * Run:
 *   bun scripts/release-prep.ts                       # apply defaults to this workspace
 *   bun scripts/release-prep.ts --check               # diff-only, no writes
 *   bun scripts/release-prep.ts --version 0.1.1       # override target version
 *   bun scripts/release-prep.ts --access public       # override publishConfig.access
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const TARGET_VERSION = flag("version") ?? "0.1.0";
const ACCESS = (flag("access") ?? "restricted") as "restricted" | "public";
const CHECK = has("check");
const ROOT = resolve(flag("root") ?? process.cwd());

const AUTHOR = {
  name: "Max Meier",
  email: "max@studiomax.io",
  url: "https://studiomax.io",
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
  const base = ROOT.split("/").pop()!;
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
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
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
  const isPublishable = !isRoot && typeof name === "string" && /^@?crewhaus[-/]/.test(name);

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

  // private: remove
  if (pkg.private !== undefined) {
    delete pkg.private;
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
  set("homepage", relDir ? `${HOMEPAGE_BASE}/tree/main/${relDir}#readme` : `${HOMEPAGE_BASE}#readme`);
  set("bugs", { url: `${HOMEPAGE_BASE}/issues` });

  // publishConfig
  set("publishConfig", { access: ACCESS });

  // files (default to src + README + LICENSE; respect existing if present)
  if (pkg.files === undefined) {
    set("files", ["src", "README.md", "LICENSE", "NOTICE"]);
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
      if (!CHECK) writeJson(path, pkg);
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
