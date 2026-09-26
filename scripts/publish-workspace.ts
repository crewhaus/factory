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
 *   bun scripts/publish-workspace.ts --dry-run --no-registry    # offline pack check (CI)
 *
 * Every form except --no-registry needs `npm` on PATH (checked once, up front)
 * and a registry that answers (the ownership guard below will not guess), and
 * every form needs a tree already stamped by `release-prep.ts --for-publish` (an
 * unstamped one fails the manifest check).
 *
 * After a failed run, fix the cause and re-run WITHOUT --filter: versions already
 * on the registry are skipped and everything the failure held back goes out.
 * `--filter <leaf>` would publish the leaf alone and exit 0 with its dependents
 * still missing. The summary of a failed run says this.
 *
 * Brand-new package names can 404 on the registry for a few minutes after a
 * successful publish — poll before assuming failure or re-running.
 *
 * Ownership guard: before touching any name that already exists on the
 * registry (including the already-published skip path), the registry's
 * `repository` url+directory must match the local package.json's, else the
 * package is reported as a failure instead of published/skipped. This is
 * what catches two workspaces accidentally sharing one npm name. The guard
 * also runs under --dry-run, making it a usable pre-flight. It fails CLOSED:
 * only npm's E404 ("no such package") counts as a first publish; any other
 * failure to read the registry refuses the package, because "could not ask"
 * is not "nobody owns it". (npm already retries transient fetch errors itself.)
 *
 * Dependency gate: npm does not check at publish time that a package's
 * dependencies exist, and neither does the registry (v0.1.0 went out pinned to
 * @crewhaus/<dep>@0.0.0, which never existed). So a package is refused when an
 * internal dependency (dependencies, peerDependencies or optionalDependencies)
 * failed or was refused in this run, or — for a dependency outside this run,
 * as under --filter — is not on the registry at this version, or pins something
 * that is not (its whole closure is checked). The refusal cascades: when a leaf
 * fails, nothing that depends on it, the bare `crewhaus` CLI included, goes out
 * pointing at a version that does not exist. A package already on the registry
 * whose dependency is not is reported as not installable and fails the run.
 * Under --dry-run the plan shows the same cascade.
 *
 * Packed-contents check: before publishing (and under --dry-run), the package
 * dir must hold what its tarball is supposed to carry — every entry point and
 * literal `files` entry, plus README.md, LICENSE and NOTICE (release-prep
 * --for-publish puts the last three there). npm packs a missing `files` entry
 * as nothing, silently, and the same for a symlinked entry or a `name/` entry
 * that is not a directory; each is refused here.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { preflight } from "../packages/tool-pkg/src/lib/preflight";

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
// Exact package name to publish, e.g. a canary leaf. Not the way to finish a
// failed run: it publishes that one package and nothing that depends on it —
// a full re-run skips what is already out and publishes the rest.
const FILTER = flag("filter");
// --dry-run only: leave the registry out entirely, so CI can run the packed-contents
// and dependency-plan checks on every PR without a network. Ownership is then NOT
// checked, and a dependency outside the run cannot be confirmed (so it blocks).
const NO_REGISTRY = has("no-registry");
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
    // Optional deps too: npm installs a missing optional dependency as nothing,
    // so a CLI whose provider adapter failed to publish would install without it.
    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.peerDependencies as Record<string, string>) ?? {}),
      ...((pkg.optionalDependencies as Record<string, string>) ?? {}),
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

/**
 * What a spawned `npm view` returned: the parts classification needs. `status`
 * is not a number when npm did not exit normally — Node says null, and Bun's
 * node:child_process says undefined for a command it could not start.
 */
export type ViewResult = {
  readonly status: number | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string; readonly message: string } | undefined;
  readonly signal?: string | null | undefined;
};

/** The parts of a spawnSync result a {@link ViewResult} keeps. */
export function toViewResult(r: {
  readonly status: number | null | undefined;
  readonly stdout?: string | null;
  readonly stderr?: string | null;
  readonly error?: unknown;
  readonly signal?: string | null;
}): ViewResult {
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: (r.error ?? undefined) as ViewResult["error"],
    signal: r.signal,
  };
}

/** Why npm did not run to an exit code (not found, killed), or undefined when it did. */
export function spawnProblem(r: ViewResult): string | undefined {
  if (r.error !== undefined) return `npm could not be run (${r.error.code ?? r.error.message})`;
  if (typeof r.status !== "number") return `npm was killed${r.signal ? ` by ${r.signal}` : ""}`;
  return undefined;
}

/**
 * npm's error code for a failed command, e.g. "E404", "E429", "ECONNREFUSED".
 * `--json` puts `{"error":{"code":…}}` on stdout (npm >= 7); every npm also
 * prints `npm error code X` (npm >= 10) or `npm ERR! code X` (older) on stderr.
 */
export function npmErrorCode(stdout: string, stderr: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const code = (JSON.parse(trimmed) as { error?: { code?: unknown } } | null)?.error?.code;
      if (typeof code === "string" && code !== "") return code;
    } catch {
      // not JSON after all — fall through to stderr
    }
  }
  return /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
}

/**
 * A failed `npm view`: either the registry said the thing does not exist (E404),
 * or we could not find out. Only the first is an answer.
 */
export function classifyViewFailure(
  r: ViewResult,
): { readonly absent: true } | { readonly absent: false; readonly reason: string } {
  const spawn = spawnProblem(r);
  if (spawn !== undefined) return { absent: false, reason: spawn };
  const code = npmErrorCode(r.stdout, r.stderr);
  if (code === "E404") return { absent: true };
  return {
    absent: false,
    reason: `npm view exited ${r.status} with ${code ? `code ${code}` : "no error code"}`,
  };
}

export type RegistryState =
  | { readonly kind: "published" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/** Classify `npm view <name>@<version> version`. */
export function versionState(r: ViewResult): RegistryState {
  // Older npm exits 0 with nothing on stdout for a version that does not exist;
  // npm 11 exits 1 with E404.
  if (r.status === 0) return r.stdout.trim() !== "" ? { kind: "published" } : { kind: "absent" };
  const c = classifyViewFailure(r);
  return c.absent ? { kind: "absent" } : { kind: "unknown", reason: c.reason };
}

function npmView(args: string[]): ViewResult {
  return toViewResult(spawnSync("npm", ["view", ...args], { encoding: "utf-8" }));
}

/** Is <name>@<version> on the registry? Three answers, not two. */
function registryState(name: string, version: string): RegistryState {
  return versionState(npmView([`${name}@${version}`, "version"]));
}

/** Normalize a repository URL for comparison: lowercase, strip git+ / .git. */
function normRepoUrl(url: string | undefined): string {
  return (url ?? "")
    .toLowerCase()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

/**
 * Ownership verdict from `npm view <name> repository --json`: null when the name
 * is free (E404) or the registry's repository matches this package, else why
 * the package must not be published. Any failure other than E404 refuses: an
 * unreachable, rate-limited or erroring registry says nothing about who owns
 * the name, and treating it as "free" is exactly how the guard used to be
 * switched off by a flaky network.
 */
export function ownershipVerdict(
  r: ViewResult,
  p: Pick<PkgInfo, "name" | "repoUrl" | "repoDir">,
): string | null {
  if (r.status !== 0) {
    const c = classifyViewFailure(r);
    if (c.absent) return null; // name not on the registry — first publish
    // No retry advice here: `--filter <this>` would publish this package alone and
    // leave what depends on it behind. The run's summary says how to re-run.
    return `could not verify who owns this npm name (${c.reason}) — refusing to publish until the registry answers`;
  }
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

/**
 * Ownership guard: if the name already exists on the registry, its
 * `repository` (url + directory) must match this local package. Two
 * different local packages publishing to one npm name is otherwise a
 * SILENT hijack — `@crewhaus/plugin-sdk` was two distinct packages
 * (factory §41 vs utilities Studio SDK) across 0.1.1→0.1.2 and nobody
 * was told. Returns null when ok (or name not on the registry yet),
 * else a human-readable reason to refuse.
 */
function ownershipMismatch(p: PkgInfo): string | null {
  return ownershipVerdict(npmView([p.name, "repository", "--json"]), p);
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
  const packErrs = packedContentsProblems(
    p.dir,
    readJson<Record<string, unknown>>(join(p.dir, "package.json")),
  );
  if (packErrs.length > 0) {
    for (const e of packErrs) console.error(`✗ ${p.name} (${relative(ROOT, p.dir)}): ${e}`);
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

/** Files every published package carries. release-prep --for-publish puts them there. */
const REQUIRED_FILES = ["README.md", "LICENSE", "NOTICE"] as const;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * What the tarball of the package in `dir` would be missing, as messages; empty
 * when it carries everything it declares. npm packs a missing `files` entry as
 * nothing, without a word, so this is the only place it gets noticed.
 *
 * The rules shared with the PackagePreflight tool (entry points that do not exist
 * or that `files` does not cover, unpublishable ranges, secrets that would ship)
 * come from @crewhaus/tool-pkg's preflight(); its blocking findings block here.
 * On top of that, every literal `files` entry must exist, and README.md, LICENSE
 * and NOTICE must be regular files (npm leaves a symlink out) — NOTICE listed in
 * `files` too, since npm adds README and LICENSE by itself but never NOTICE.
 */
export function packedContentsProblems(dir: string, manifest: Record<string, unknown>): string[] {
  const report = preflight(manifest, {
    exists: (rel) => existsSync(join(dir, rel)),
    isDirectory: (rel) => {
      try {
        return statSync(join(dir, rel)).isDirectory();
      } catch {
        return false;
      }
    },
  });
  const problems = report.blocking.map((b) => b.message);
  for (const f of REQUIRED_FILES) {
    if (!isRegularFile(join(dir, f))) {
      problems.push(
        `${f} is missing or not a regular file — run \`release-prep.ts --for-publish\`, which puts README.md, LICENSE and NOTICE into every package`,
      );
    }
  }
  const files = Array.isArray(manifest.files)
    ? (manifest.files as unknown[]).filter((f): f is string => typeof f === "string")
    : null;
  if (files !== null) {
    for (const entry of files) {
      // npm reads `./x` and `/x` as x at the package root, and `x/` as "x, if it
      // is a directory" (gitignore rules): `NOTICE/` packs no NOTICE.
      const dirOnly = entry.endsWith("/");
      const e = entry.replace(/^\.?\/+/, "").replace(/\/+$/, "");
      // Globs and negations are npm's to expand; the required files are checked
      // above (npm adds README and LICENSE whatever `files` says).
      if (e === "" || /[*?[\]{}!]/.test(e)) continue;
      if (!dirOnly && (REQUIRED_FILES as readonly string[]).includes(e)) continue;
      const why = literalEntryProblem(join(dir, e), dirOnly);
      if (why !== undefined) {
        problems.push(`"files" lists "${entry}", ${why}`);
      }
    }
    // Only these spellings pack NOTICE (checked against real npm pack in the tests).
    if (!files.some((e) => /^(?:\.?\/)?NOTICE$/.test(e))) {
      problems.push('"files" does not list NOTICE — npm packs NOTICE only when `files` names it');
    }
  }
  return problems;
}

/**
 * Why npm would pack nothing for a literal `files` entry at `path`, or undefined
 * when it packs it. npm lstat()s the entry: a regular file or a directory is
 * packed, a symlink (to anything) or special file is left out, and an entry with
 * a trailing slash matches only a directory.
 */
function literalEntryProblem(path: string, dirOnly: boolean): string | undefined {
  const nothing = "npm would pack nothing for it";
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return `which is not there — ${nothing}`;
  }
  if (st.isSymbolicLink()) return `which is a symlink — ${nothing}`;
  if (st.isDirectory()) return undefined;
  if (dirOnly) {
    return `which is not a directory — a trailing slash matches only a directory, so ${nothing}`;
  }
  return st.isFile() ? undefined : `which is not a regular file or directory — ${nothing}`;
}

/** What the dependency gate knows when it looks at a package. */
export type DependencyGate = {
  /** Names that failed, were refused, or are on the registry without their own deps. */
  readonly unavailable: ReadonlySet<string>;
  /** Names this run handles; in topological order, so a dependency is settled first. */
  readonly inRun: ReadonlySet<string>;
  /** Registry lookup for a dependency this run does not handle (e.g. under --filter). */
  readonly registry: (name: string, version: string) => RegistryState;
  /** A workspace package's internal dependencies, from the discovered graph. */
  readonly depsOf: (name: string) => readonly string[];
};

/**
 * The internal dependencies of `p` that would not install at `p.version`, each
 * with the reason. Empty means every one is published, being published in this
 * run, or (dry-run) would be. Internal deps are exact lockstep pins
 * (checkPublishableManifest enforces it), so `<dep>@<p.version>` is the coordinate.
 * A registry that cannot be read counts against the dependency: publishing onto
 * a dependency nobody could confirm is the failure this gate exists to stop.
 *
 * A dependency outside the run is walked down to its own dependencies: it being
 * on the registry says nothing about whether what IT pins is (a 0.7.0-era run
 * or a hand `npm publish` can leave a package there without its dependencies),
 * and npm installs the whole closure. Its dependencies are read from the
 * workspace graph, which is the same source at the same lockstep version. A
 * dependency this run settled is not walked: its own check covered its closure,
 * and one whose closure was unmet was refused and is in `unavailable`.
 */
export function unmetDependencies(
  p: Pick<PkgInfo, "deps" | "version">,
  gate: DependencyGate,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (d: string, via: string | undefined): void => {
    if (seen.has(d)) return;
    seen.add(d);
    const through = via === undefined ? "" : `; needed through ${via}`;
    if (gate.unavailable.has(d)) {
      out.push(`${d} (failed or was refused in this run${through})`);
      return;
    }
    if (gate.inRun.has(d)) return;
    const state = gate.registry(d, p.version);
    if (state.kind === "absent") {
      out.push(`${d}@${p.version} (not on the registry${through})`);
      return;
    }
    if (state.kind === "unknown") {
      out.push(`${d}@${p.version} (could not check the registry: ${state.reason}${through})`);
      return;
    }
    for (const next of gate.depsOf(d)) visit(next, via ?? d);
  };
  for (const d of p.deps) visit(d, undefined);
  return out;
}

/**
 * What to do after a failed run. A full re-run is what finishes a release: it
 * skips every version already on the registry and publishes what the failure
 * held back. `--filter <name>` publishes that one package and nothing that
 * depends on it, so on its own it can exit 0 with most of the release missing.
 */
export function rerunAdvice(filter: string | undefined): string {
  const all =
    "re-run without --filter: versions already on the registry are skipped, and the rest go out";
  return filter === undefined
    ? `After fixing, ${all}.`
    : `After fixing, re-run with --filter ${filter} to retry that package alone, or ${all}.`;
}

// ─── main ──────────────────────────────────────────────────────────────────
function main(): void {
  if (NO_REGISTRY) {
    if (!DRY) {
      console.error(
        "✗ --no-registry is a --dry-run option: a real publish must check the registry.",
      );
      process.exit(1);
    }
    console.log("Registry not consulted (--no-registry): ownership is NOT checked.");
  } else {
    // Once, up front: without a working npm every package below would be refused
    // with a registry complaint that is not the reason.
    const probe = toViewResult(spawnSync("npm", ["--version"], { encoding: "utf-8" }));
    const why =
      spawnProblem(probe) ??
      (probe.status === 0 ? undefined : `npm --version exited ${probe.status}`);
    if (why !== undefined) {
      console.error(`✗ ${why}. Every run except --dry-run --no-registry needs npm on PATH.`);
      process.exit(1);
    }
  }
  // `npm whoami` is a TOKEN identity check and there is no equivalent under OIDC:
  // trusted publishing mints a short-lived, package-scoped credential during
  // `npm publish` itself, so there is no logged-in user to report and whoami
  // legitimately fails. Only demand it on the token path.
  if (!DRY && !OIDC_AVAILABLE) {
    const whoamiResult = spawnSync("npm", ["whoami"], { encoding: "utf-8" });
    if (whoamiResult.status !== 0) {
      console.error("✗ npm whoami failed — no usable npm credential.");
      console.error("  In CI this means the NPM_TOKEN secret is missing or revoked. Note that npm");
      console.error(
        "  permanently revoked ALL classic automation tokens on 2025-12-09; they cannot",
      );
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
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const filtered = FILTER ? sorted.filter((p) => p.name === FILTER) : sorted;
  if (FILTER && filtered.length === 0) {
    console.error(`No package matched --filter ${FILTER}`);
    process.exit(1);
  }

  let published = 0;
  let skipped = 0;
  const failures: string[] = [];
  // Already on the registry, so nothing to publish, but pinned to a dependency
  // that is not: installs of it fail. That is not a finished release either.
  const notInstallable: string[] = [];
  const unavailable = new Set<string>();
  const registryMemo = new Map<string, RegistryState>();
  const gate: DependencyGate = {
    unavailable,
    inRun: new Set(filtered.map((p) => p.name)),
    registry: (name, version) => {
      if (NO_REGISTRY) return { kind: "unknown", reason: "--no-registry" };
      const key = `${name}@${version}`;
      let state = registryMemo.get(key);
      if (state === undefined) {
        state = registryState(name, version);
        registryMemo.set(key, state);
      }
      return state;
    },
    depsOf: (name) => byName.get(name)?.deps ?? [],
  };
  const fail = (p: PkgInfo, entry: string) => {
    failures.push(entry);
    unavailable.add(p.name);
  };

  for (const p of filtered) {
    // Ownership first, even on the would-skip path: a version-exists skip is
    // exactly how a hijacked name hides ("already on registry" tells you
    // nothing about WHOSE content that is). Runs in dry-run too.
    const mismatch = NO_REGISTRY ? null : ownershipMismatch(p);
    if (mismatch) {
      fail(p, `${p.name}@${p.version} (ownership)`);
      console.error(`✗ ${p.name}: ${mismatch}`);
      continue;
    }
    const unmet = unmetDependencies(p, gate);
    if (!DRY) {
      const state = registryState(p.name, p.version);
      if (state.kind === "published") {
        console.log(`= ${p.name}@${p.version} already on registry — skipping`);
        skipped++;
        if (unmet.length > 0) {
          // Nothing to do for it, but what depends on it would not install either.
          unavailable.add(p.name);
          notInstallable.push(`${p.name}@${p.version} (depends on ${unmet.join(", ")})`);
          console.error(
            `  ! it depends on ${unmet.join(", ")}; installs of it fail until that is published`,
          );
        }
        continue;
      }
      if (state.kind === "unknown") {
        // Ownership was just confirmed, and npm itself refuses a version that
        // exists (EPUBLISHCONFLICT, handled as "already"), so trying is safe.
        console.log(
          `  (could not tell whether ${p.name}@${p.version} is already published: ${state.reason}; trying the publish)`,
        );
      }
    }
    if (unmet.length > 0) {
      fail(p, `${p.name}@${p.version} (blocked: ${unmet.join(", ")})`);
      console.error(
        `✗ ${p.name}@${p.version} not published: it depends on ${unmet.join(", ")}, so it would install broken`,
      );
      continue;
    }
    const result = publish(p);
    if (result === "ok") {
      published++;
    } else if (result === "already") {
      skipped++;
    } else {
      fail(p, `${p.name}@${p.version}`);
      console.error(`✗ ${p.name}@${p.version} failed`);
      if (!DRY) {
        // Keep going: packages that do not depend on this one can still ship.
        // Those that do are refused by the dependency gate above — npm would
        // otherwise publish them pointing at a version that does not exist.
        console.error("  (continuing; what depends on it is held back)");
      }
    }
  }

  console.log("");
  console.log(`Published: ${published}  Skipped: ${skipped}  Failed: ${failures.length}`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  for (const b of notInstallable) console.error(`On the registry but not installable: ${b}`);
  if (failures.length > 0 || notInstallable.length > 0) {
    if (!DRY) console.error(rerunAdvice(FILTER));
    process.exit(1);
  }
}

if (import.meta.main) main();
