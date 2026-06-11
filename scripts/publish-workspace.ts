#!/usr/bin/env bun
/**
 * publish-workspace.ts — Publish every @crewhaus/* package in this workspace
 * to npm, in topological dependency order, skipping versions that are already
 * on the registry.
 *
 * This IS the release path: versioning is lockstep via scripts/release-prep.ts
 * (a changesets config existed 2026-05→06 but was never adopted and has been
 * removed). Stay on `bun publish` — never `npm publish` — because bun rewrites
 * `workspace:*` deps to concrete versions at pack time; npm ships the literal
 * range and breaks every install.
 *
 * Pre-flight:
 *   export NPM_CONFIG_TOKEN=…  # classic npm *Automation* token; a 2FA-bound
 *                              # token dead-ends `bun publish` in a web-OTP
 *                              # prompt ("failed to send OTP request")
 *   npm whoami                 # must succeed
 *   bun install                # ensure node_modules are in shape
 *   bun run typecheck          # belt-and-braces
 *
 * Run:
 *   bun scripts/publish-workspace.ts --dry-run                  # plan only
 *   bun scripts/publish-workspace.ts --filter @crewhaus/errors  # canary a leaf first
 *   bun scripts/publish-workspace.ts                            # full run
 *
 * Brand-new package names can 404 on the registry for a few minutes after a
 * successful publish — poll before assuming failure or re-running.
 *
 * Ownership guard: before touching any name that already exists on the
 * registry (including the already-published skip path), the registry's
 * `repository` url+directory must match the local package.json's, else the
 * package is reported as a failure instead of published/skipped. This is
 * what catches two workspaces accidentally sharing one npm name. The guard
 * also runs under --dry-run, making it a usable pre-flight.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type PkgInfo = {
  name: string;
  version: string;
  dir: string;
  deps: string[]; // names of internal @crewhaus/* dependencies
  repoUrl?: string; // package.json repository.url — used for the ownership check
  repoDir?: string; // package.json repository.directory
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const DRY = has("dry-run");
const FILTER = flag("filter"); // exact package name to publish, useful for retries
const ROOT = resolve(flag("root") ?? process.cwd());

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function discoverPackages(): PkgInfo[] {
  const rootPkg = readJson<{ workspaces?: string[] }>(join(ROOT, "package.json"));
  const ws = rootPkg.workspaces ?? [];
  const dirs: string[] = [];
  for (const pattern of ws) {
    if (pattern === "*") {
      for (const entry of readdirSync(ROOT)) {
        const d = join(ROOT, entry);
        if (statSync(d).isDirectory() && existsSync(join(d, "package.json"))) dirs.push(d);
      }
      continue;
    }
    const star = pattern.endsWith("/*");
    const base = star ? pattern.slice(0, -2) : pattern;
    const fullBase = join(ROOT, base);
    if (!existsSync(fullBase)) continue;
    if (star) {
      for (const entry of readdirSync(fullBase)) {
        const d = join(fullBase, entry);
        if (statSync(d).isDirectory() && existsSync(join(d, "package.json"))) dirs.push(d);
      }
    } else if (existsSync(join(fullBase, "package.json"))) {
      dirs.push(fullBase);
    }
  }

  const allNames = new Set<string>();
  const raw: { dir: string; pkg: Record<string, unknown> }[] = [];
  for (const dir of dirs) {
    const pkg = readJson<Record<string, unknown>>(join(dir, "package.json"));
    if (pkg.private === true) continue;
    const name = pkg.name as string | undefined;
    if (!name || !name.startsWith("@crewhaus/")) continue;
    allNames.add(name);
    raw.push({ dir, pkg });
  }

  const pkgs: PkgInfo[] = raw.map(({ dir, pkg }) => {
    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.peerDependencies as Record<string, string>) ?? {}),
    };
    const repo = pkg.repository as { url?: string; directory?: string } | undefined;
    return {
      name: pkg.name as string,
      version: pkg.version as string,
      dir,
      deps: Object.keys(allDeps).filter((d) => allNames.has(d)),
      repoUrl: repo?.url,
      repoDir: repo?.directory,
    };
  });

  return pkgs;
}

/** Kahn's algorithm: produce a publish order with leaves first. */
function topoSort(pkgs: PkgInfo[]): PkgInfo[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const out: PkgInfo[] = [];
  const inDeg = new Map<string, number>();
  for (const p of pkgs) inDeg.set(p.name, 0);
  for (const p of pkgs) {
    for (const d of p.deps) {
      if (byName.has(d)) inDeg.set(p.name, (inDeg.get(p.name) ?? 0) + 1);
    }
  }
  const ready: string[] = [];
  for (const [n, d] of inDeg) if (d === 0) ready.push(n);
  ready.sort();
  while (ready.length) {
    const n = ready.shift();
    if (n === undefined) break;
    const p = byName.get(n);
    if (!p) continue;
    out.push(p);
    for (const candidate of pkgs) {
      if (candidate.deps.includes(n)) {
        const next = (inDeg.get(candidate.name) ?? 0) - 1;
        inDeg.set(candidate.name, next);
        if (next === 0) {
          ready.push(candidate.name);
          ready.sort();
        }
      }
    }
  }
  if (out.length !== pkgs.length) {
    throw new Error(
      `Topo sort incomplete (cycle?). Sorted ${out.length}/${pkgs.length}. ` +
        `Unsorted: ${pkgs
          .filter((p) => !out.includes(p))
          .map((p) => p.name)
          .join(", ")}`,
    );
  }
  return out;
}

/** npm view <name>@<version> — returns true if already published. */
function isPublished(name: string, version: string): boolean {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf-8",
  });
  if (r.status === 0 && r.stdout.trim().length > 0) return true;
  return false;
}

/** Normalize a repository URL for comparison: lowercase, strip git+ / .git. */
function normRepoUrl(url: string | undefined): string {
  return (url ?? "")
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

/**
 * Ownership guard: if the name already exists on the registry, its
 * `repository` (url + directory) must match this local package. Two
 * different local packages publishing to one npm name is otherwise a
 * SILENT hijack — `@crewhaus/plugin-sdk` was two distinct packages
 * (factory §41 vs utilities Studio SDK) across 0.1.1→0.1.2 and nobody
 * was told. Returns null when ok (or name not on the registry yet),
 * else a human-readable mismatch description.
 */
function ownershipMismatch(p: PkgInfo): string | null {
  const r = spawnSync("npm", ["view", p.name, "repository", "--json"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return null; // name not on the registry — first publish
  let repo: { url?: string; directory?: string };
  try {
    repo = JSON.parse(r.stdout || "{}") ?? {};
  } catch {
    return "registry repository field is unparseable — verify ownership manually";
  }
  const urlOk = normRepoUrl(repo.url) === normRepoUrl(p.repoUrl);
  const dirOk = (repo.directory ?? "") === (p.repoDir ?? "");
  if (urlOk && dirOk) return null;
  return `registry says repository=${repo.url ?? "<none>"} dir=${repo.directory ?? "<none>"}, local says repository=${p.repoUrl ?? "<none>"} dir=${p.repoDir ?? "<none>"} — this npm name appears to belong to a DIFFERENT package; publishing would hijack it`;
}

type PublishResult = "ok" | "already" | "failed";

function publish(p: PkgInfo): PublishResult {
  console.log(`\n→ publishing ${p.name}@${p.version}`);
  if (DRY) {
    console.log("  (dry-run, skipping)");
    return "ok";
  }
  // Capture output so we can recognize "already published" as success.
  const r = spawnSync("bun", ["publish"], { cwd: p.dir, encoding: "utf-8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out);
  if (r.status === 0) return "ok";
  if (/cannot publish over the previously published versions/i.test(out)) {
    console.log("  (already published — treating as success)");
    return "already";
  }
  return "failed";
}

// ─── main ──────────────────────────────────────────────────────────────────
const whoamiResult = spawnSync("npm", ["whoami"], { encoding: "utf-8" });
if (!DRY && whoamiResult.status !== 0) {
  console.error("✗ npm whoami failed. Run `npm login` (or `npm login --scope=@crewhaus`) first.");
  console.error(`  stderr: ${whoamiResult.stderr?.trim()}`);
  process.exit(1);
}
if (!DRY) {
  console.log(`✓ Logged in as: ${whoamiResult.stdout.trim()}`);

  // Regenerate bun.lock so workspace:* deps resolve to current versions, not
  // whatever the lockfile last saw. Without this, freshly-bumped packages can
  // publish with the previous version recorded as their internal dep range —
  // the silent bug that tombstoned v0.1.0 on the initial cut.
  console.log("Refreshing bun.lock so workspace:* deps resolve to current versions...");
  const { unlinkSync, existsSync: lockExists } = require("node:fs");
  const lockPath = join(ROOT, "bun.lock");
  if (lockExists(lockPath)) unlinkSync(lockPath);
  const install = spawnSync("bun", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    console.error("✗ bun install failed; aborting publish");
    process.exit(1);
  }
}

const pkgs = discoverPackages();
console.log(`Discovered ${pkgs.length} publishable @crewhaus/* packages in ${ROOT}`);

const sorted = topoSort(pkgs);
const filtered = FILTER ? sorted.filter((p) => p.name === FILTER) : sorted;
if (FILTER && filtered.length === 0) {
  console.error(`No package matched --filter ${FILTER}`);
  process.exit(1);
}

let published = 0;
let skipped = 0;
const failures: string[] = [];

for (const p of filtered) {
  // Ownership first, even on the would-skip path: a version-exists skip is
  // exactly how a hijacked name hides ("already on registry" tells you
  // nothing about WHOSE content that is). Runs in dry-run too.
  const mismatch = ownershipMismatch(p);
  if (mismatch) {
    failures.push(`${p.name}@${p.version} (ownership)`);
    console.error(`✗ ${p.name}: ${mismatch}`);
    continue;
  }
  if (!DRY && isPublished(p.name, p.version)) {
    console.log(`= ${p.name}@${p.version} already on registry — skipping`);
    skipped++;
    continue;
  }
  const result = publish(p);
  if (result === "ok") {
    published++;
  } else if (result === "already") {
    skipped++;
  } else {
    failures.push(`${p.name}@${p.version}`);
    console.error(`✗ ${p.name}@${p.version} failed`);
    if (!DRY) {
      console.error(`  (continuing; re-run with --filter ${p.name} after fixing)`);
      // Don't break — keep going. Dependents that need this package will fail
      // their own publish if the registry can't resolve the dep, and we'll
      // surface them in the failure list at the end.
    }
  }
}

console.log("");
console.log(`Published: ${published}  Skipped: ${skipped}  Failed: ${failures.length}`);
if (failures.length) process.exit(1);
