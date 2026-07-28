#!/usr/bin/env bun
/**
 * configure-trusted-publishers.ts — point every publishable package at this repo's
 * release workflow as its npm trusted publisher, so releases publish over OIDC
 * instead of a long-lived token.
 *
 * WHY THIS EXISTS
 *
 * npm is retiring token publishing: bypass-2FA tokens lose account/package
 * MANAGEMENT actions in early August 2026, and lose DIRECT PUBLISH entirely in
 * January 2027, after which a token can only stage a publish for a human to approve.
 * Trusted publishing (OIDC) is the replacement. It is configured PER PACKAGE — there
 * is no scope- or org-level setting and no `@crewhaus/*` wildcard — and this
 * workspace has 214 of them, which is why this is a script and not a runbook step.
 *
 * WHAT IT CANNOT DO
 *
 * This is a MANAGEMENT action, so it deliberately cannot run in CI:
 *   - It needs an interactive npm login with account-level 2FA. npm documents that
 *     granular access tokens with bypass-2FA "are not supported" for `npm trust`,
 *     which is precisely the token CI holds.
 *   - The package must ALREADY EXIST on the registry. OIDC cannot perform a
 *     first-ever publish, so a brand-new package name has to be published once by
 *     token before it can be configured here. --skip-missing reports those instead
 *     of failing the run.
 *
 * Run it from a workstation, logged in, with a second factor to hand.
 *
 * Usage:
 *   bun scripts/configure-trusted-publishers.ts --dry-run   # print the plan, touch nothing
 *   bun scripts/configure-trusted-publishers.ts             # configure every package
 *   bun scripts/configure-trusted-publishers.ts --filter @crewhaus/errors
 *   bun scripts/configure-trusted-publishers.ts --skip-missing
 *
 * Requires npm >= 11.15.0 (`npm trust` does not exist before it) — checked at start.
 *
 * 2FA pacing: npm's own guidance is that one 2FA authorization covers roughly a
 * 5-minute window, which fits ~80 packages at the 2s spacing used here. Expect to be
 * challenged about three times for a full 214-package run. Don't walk away.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has("dry-run");
const SKIP_MISSING = has("skip-missing");
const FILTER = flag("filter");
const ROOT = resolve(flag("root") ?? process.cwd());

/**
 * The trusted publisher binds to the repo and the workflow FILENAME — bare, with its
 * extension, no path prefix, case-sensitive. These two values must match
 * .github/workflows/release.yml exactly; npm does not validate them at save time, so
 * a typo here surfaces much later as a publish-time 404/ENEEDAUTH on every package.
 */
const REPO = "crewhaus/factory";
const WORKFLOW_FILE = "release.yml";

/** Sanity-check the binding against the tree rather than trusting the constants. */
const workflowPath = join(ROOT, ".github", "workflows", WORKFLOW_FILE);
if (!existsSync(workflowPath)) {
  console.error(`✗ ${workflowPath} does not exist.`);
  console.error("  WORKFLOW_FILE must name the workflow that runs the publish. If release.yml was");
  console.error("  renamed, every existing trusted-publisher config is already invalid.");
  process.exit(1);
}
if (!readFileSync(workflowPath, "utf-8").includes("id-token: write")) {
  console.error(`✗ ${WORKFLOW_FILE} has no \`id-token: write\` permission.`);
  console.error("  Without it the runner cannot mint an OIDC token and npm falls back");
  console.error("  to token auth — configuring trusted publishers would be a no-op.");
  process.exit(1);
}

/** npm >= 11.15.0; `npm trust` simply does not exist before that. */
const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf-8" }).stdout?.trim() ?? "";
const [maj = 0, min = 0] = npmVersion.split(".").map((n) => Number.parseInt(n, 10));
if (!(maj > 11 || (maj === 11 && min >= 15))) {
  console.error(`✗ npm ${npmVersion || "(unknown)"} is too old — \`npm trust\` needs >= 11.15.0.`);
  console.error("  Install a newer npm (`npm install -g npm@latest`) and re-run.");
  process.exit(1);
}

type Pkg = { name: string; dir: string };

/**
 * Discovered from the workspace globs — the same source of truth publish-workspace.ts
 * uses — so the trust list cannot drift from the publish list. A hand-maintained list
 * would silently miss a new package, and a package with no trusted publisher falls
 * back to token auth, which is exactly what this migration removes.
 */
function discoverPackages(): Pkg[] {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    workspaces?: string[];
  };
  const out: Pkg[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    const base = join(ROOT, dirname(pattern));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const j = JSON.parse(readFileSync(manifest, "utf-8")) as {
        name?: string;
        private?: boolean;
      };
      if (j.private === true || typeof j.name !== "string") continue;
      out.push({ name: j.name, dir });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** OIDC cannot create a package, so an unpublished name cannot be configured. */
function existsOnRegistry(name: string): boolean {
  const r = spawnSync("npm", ["view", name, "version"], { encoding: "utf-8" });
  return r.status === 0;
}

const all = discoverPackages();
const pkgs = FILTER ? all.filter((p) => p.name === FILTER) : all;
if (FILTER && pkgs.length === 0) {
  console.error(`No package matched --filter ${FILTER}`);
  process.exit(1);
}

console.log(`Workspace root : ${ROOT}`);
console.log(`Repository     : ${REPO}`);
console.log(`Workflow file  : ${WORKFLOW_FILE}`);
console.log(`npm            : ${npmVersion}`);
console.log(`Packages       : ${pkgs.length}${FILTER ? " (filtered)" : ""}`);
console.log(`Mode           : ${DRY ? "DRY-RUN (no changes)" : "WRITE"}`);
console.log("");

const failures: string[] = [];
const missing: string[] = [];
let configured = 0;

for (const [i, p] of pkgs.entries()) {
  const prefix = `[${i + 1}/${pkgs.length}] ${p.name}`;

  if (!existsOnRegistry(p.name)) {
    // Not a failure of this script: the package has to be published once, by token,
    // before OIDC can ever be used for it.
    missing.push(p.name);
    console.log(`${prefix}: not on the registry — publish it once by token first`);
    if (SKIP_MISSING) continue;
    failures.push(p.name);
    continue;
  }

  // --allow-publish is REQUIRED, not cosmetic: configs created after 2026-05-20 must
  // name at least one permission, and one saved without it authenticates but cannot
  // publish. --allow-stage-publish costs nothing now and avoids a second pass over
  // 214 packages if staged publishing is ever needed.
  const cmd = [
    "trust",
    "github",
    p.name,
    "--repo",
    REPO,
    "--file",
    WORKFLOW_FILE,
    "--allow-publish",
    "--allow-stage-publish",
    "-y",
  ];

  if (DRY) {
    console.log(`${prefix}: npm ${cmd.join(" ")}`);
    continue;
  }

  const r = spawnSync("npm", cmd, { encoding: "utf-8" });
  if (r.status === 0) {
    configured++;
    console.log(`${prefix}: ✓`);
  } else {
    failures.push(p.name);
    console.error(`${prefix}: ✗ ${(r.stderr ?? r.stdout ?? "").trim().split("\n")[0]}`);
  }

  // Spacing keeps the run inside npm's rate limits and inside one 2FA window for as
  // long as possible.
  Bun.sleepSync(2000);
}

console.log("");
console.log(`Configured: ${configured}  Missing: ${missing.length}  Failed: ${failures.length}`);
if (missing.length > 0) {
  console.log("");
  console.log("Never published (publish once by token, then re-run):");
  for (const n of missing) console.log(`  ${n}`);
}
if (failures.length > 0) {
  console.log("");
  console.log("Failed:");
  for (const n of failures) console.log(`  ${n}`);
  console.log("");
  console.log("Verify one by hand with: npm trust list <package>");
  process.exit(1);
}
