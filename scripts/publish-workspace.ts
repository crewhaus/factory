#!/usr/bin/env bun
/**
 * publish-workspace.ts — Publish every @crewhaus/* package in this workspace
 * to npm, in topological dependency order, skipping versions that are already
 * on the registry.
 *
 * This IS the release path: versioning is lockstep via scripts/release-prep.ts
 * (a changesets config existed 2026-05→06 but was never adopted and has been
 * removed).
 *
 * Publishes with `npm publish`. It used to be `bun publish`, for one reason: bun
 * rewrote `workspace:*` deps to concrete versions at pack time and npm shipped the
 * literal range, breaking every install. `release-prep.ts --for-publish` now does
 * that resolution itself, from the stamped version, so the manifest is publisher-
 * agnostic before either tool sees it — and checkPublishableManifest() refuses to
 * publish if one slipped through. That unblocks npm, which is required because only
 * the npm CLI can do the OIDC trusted-publishing token exchange (bun 1.3.14 has
 * neither OIDC nor --provenance; oven-sh/bun#22423 is open).
 *
 * Doing the resolution from the stamped version also kills a bug class bun was prone
 * to: bun resolved `workspace:*` from bun.lock, so a lockfile predating the bump
 * shipped internal deps pinned to the PREVIOUS version — the failure that tombstoned
 * v0.1.0, and the reason this script used to delete bun.lock and reinstall.
 *
 * Auth, in preference order:
 *   1. OIDC trusted publishing — nothing to export. In GitHub Actions with
 *      `permissions: id-token: write` and a trusted publisher configured for the
 *      package, npm mints a short-lived package-scoped credential itself, and this
 *      script adds --provenance. There is no `npm whoami` identity on this path.
 *   2. A *granular* access token with bypass-2FA, scoped to the @crewhaus scope plus
 *      the unscoped `crewhaus` package, as NPM_TOKEN / ~/.npmrc. Fallback only.
 *      Classic automation tokens are NOT an option: npm permanently revoked all of
 *      them on 2025-12-09 and they cannot be recreated.
 *
 * Pre-flight (token path):
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
    // Publishable names: the scoped library packages plus the unscoped
    // flagship `crewhaus` CLI (apps/cli — the bare package users install).
    if (!name || !(name === "crewhaus" || name.startsWith("@crewhaus/"))) continue;
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
  // Checked BEFORE the dry-run early-return, like the ownership guard above: a
  // manifest that would install broken is exactly what a pre-flight is for, and
  // catching it under --dry-run costs nothing and needs no credentials.
  const manifestErr = checkPublishableManifest(p);
  if (manifestErr !== undefined) {
    console.error(`✗ ${p.name}: ${manifestErr}`);
    return "failed";
  }
  if (DRY) {
    console.log("  (dry-run, skipping)");
    return "ok";
  }
  // Guard: when release-prep --for-publish has flipped entrypoints to dist/, the build
  // must have run first. If the dist entrypoint is missing, `bun publish` would pack a
  // tarball with no JS (just README/LICENSE) and ship a broken package — fail loudly.
  const pj = readJson<{ main?: string }>(join(p.dir, "package.json"));
  if (
    typeof pj.main === "string" &&
    pj.main.startsWith("dist/") &&
    !existsSync(join(p.dir, pj.main))
  ) {
    console.error(
      `✗ ${p.name}: main="${pj.main}" but ${join(p.dir, pj.main)} is missing — run \`bun run build\` before publishing.`,
    );
    return "failed";
  }
  // Capture output so we can recognize "already published" as success.
  // `npm publish`, not `bun publish`: only the npm CLI can do the OIDC trusted-
  // publishing token exchange (bun 1.3.14 has neither OIDC nor --provenance), and
  // OIDC is what replaces the revoked classic automation token. Safe to switch only
  // because the manifest no longer carries `workspace:` ranges — that difference,
  // not anything else about bun, was why this script was pinned to `bun publish`.
  const r = spawnSync("npm", ["publish", ...PUBLISH_FLAGS], { cwd: p.dir, encoding: "utf-8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(out);
  if (r.status === 0) return "ok";
  // bun says "cannot publish over the previously published versions"; npm says
  // "You cannot publish over the previously published versions" / EPUBLISHCONFLICT.
  if (/cannot publish over the previously published versions|EPUBLISHCONFLICT/i.test(out)) {
    console.log("  (already published — treating as success)");
    return "already";
  }
  return "failed";
}

/**
 * OIDC trusted publishing is detected by the npm CLI itself: when GitHub Actions
 * exposes ACTIONS_ID_TOKEN_REQUEST_URL (i.e. the job has `permissions: id-token:
 * write`) and the package has a trusted publisher configured, npm exchanges the
 * OIDC token automatically. Nothing here has to request it.
 *
 * `--provenance` is only added on that path: provenance attestation requires the
 * OIDC identity, and asking for it while authenticating with a plain token makes
 * npm reject the publish outright rather than degrade.
 */
const OIDC_AVAILABLE = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] !== undefined;
const PUBLISH_FLAGS: readonly string[] = OIDC_AVAILABLE ? ["--provenance"] : [];

/** Every workspace package name; populated from discovery before publishing starts. */
const INTERNAL_NAMES = new Set<string>();

/**
 * Refuse to publish a manifest that would install broken.
 *
 * Two failure shapes, both silent at pack time and both fatal for consumers:
 *   - a surviving `workspace:` range (npm ships it literally), and
 *   - an internal dep pinned to some version OTHER than the one being cut, which is
 *     what a stale bun.lock produces.
 * Returns an error string, or undefined when the manifest is publishable.
 */
function checkPublishableManifest(p: PkgInfo): string | undefined {
  const pj = readJson<Record<string, unknown>>(join(p.dir, "package.json"));
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const deps = pj[field];
    if (deps === null || typeof deps !== "object") continue;
    for (const [dep, range] of Object.entries(deps as Record<string, string>)) {
      if (typeof range !== "string") continue;
      if (range.startsWith("workspace:")) {
        return `${field}["${dep}"] is still "${range}" — run \`release-prep.ts --for-publish\` before publishing (npm ships the literal range and every install fails).`;
      }
      // Internal deps are lockstep: anything else means a stale resolution.
      if (INTERNAL_NAMES.has(dep) && range !== p.version) {
        return `${field}["${dep}"] is "${range}" but this cut is ${p.version} — internal deps are lockstep, so this tarball would resolve a different generation.`;
      }
    }
  }
  return undefined;
}

// ─── main ──────────────────────────────────────────────────────────────────
// `npm whoami` is a TOKEN identity check and there is no equivalent under OIDC:
// trusted publishing mints a short-lived, package-scoped credential during
// `npm publish` itself, so there is no logged-in user to report and whoami
// legitimately fails. Only demand it on the token path.
if (!DRY && !OIDC_AVAILABLE) {
  const whoamiResult = spawnSync("npm", ["whoami"], { encoding: "utf-8" });
  if (whoamiResult.status !== 0) {
    console.error("✗ npm whoami failed — no usable npm credential.");
    console.error("  In CI this means the NPM_TOKEN secret is missing or revoked. Note that npm");
    console.error("  permanently revoked ALL classic automation tokens on 2025-12-09; they cannot");
    console.error(
      "  be recreated. Mint a granular access token scoped to the @crewhaus scope plus",
    );
    console.error("  the unscoped `crewhaus` package, with bypass-2FA enabled.");
    console.error(`  stderr: ${whoamiResult.stderr?.trim()}`);
    process.exit(1);
  }
  console.log(`✓ Logged in as: ${whoamiResult.stdout.trim()}`);
} else if (!DRY) {
  console.log("✓ OIDC trusted publishing detected (ACTIONS_ID_TOKEN_REQUEST_URL set)");
  console.log("  publishing with --provenance; no npm token required");
}

// NOTE: this used to delete bun.lock and reinstall, so `bun publish` would resolve
// `workspace:*` against current versions instead of whatever the lockfile last saw
// (the bug that tombstoned v0.1.0). That workaround is gone because the cause is:
// `release-prep.ts --for-publish` now resolves those ranges from the stamped
// version, and checkPublishableManifest() refuses to publish if any survived.

const pkgs = discoverPackages();
for (const p of pkgs) INTERNAL_NAMES.add(p.name);
console.log(`Discovered ${pkgs.length} publishable packages (crewhaus + @crewhaus/*) in ${ROOT}`);

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
