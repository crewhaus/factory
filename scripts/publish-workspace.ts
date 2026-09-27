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
 *   bun scripts/publish-workspace.ts --dry-run --no-registry    # pack check, no registry (CI)
 *
 * Every form needs `npm` on PATH (checked once, up front): npm itself says what
 * each tarball would carry. Every form except --no-registry also needs a
 * registry that answers (the ownership guard below will not guess), and every
 * form needs a tree already built (`bun run build`) and stamped by
 * `release-prep.ts --for-publish` (an unstamped one fails the manifest check).
 *
 * After a failed run, fix the cause and re-run WITHOUT --filter: versions already
 * on the registry are skipped and everything the failure held back goes out.
 * `--filter <leaf>` would publish the leaf alone and exit 0 with its dependents
 * still missing. The summary of a failed run says this. A --filter run looks up
 * every dependency outside the run on the registry, down its whole closure (for
 * the CLI, nearly every package); those lookups run a few at a time.
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
 * Packed-contents check: before publishing (and under --dry-run), npm is asked
 * what each tarball would hold (`npm pack --dry-run --json`, from the package
 * dir, as `npm publish` packs it), and that list must carry every entry point,
 * every literal `files` entry, and README.md, LICENSE and NOTICE (release-prep
 * --for-publish puts the last three there). npm drops a file without a word
 * for many reasons — a missing or symlinked entry, a symlinked directory on the
 * way, an ignore file under the package, a `!` entry, a spelling one npm major
 * reads and another does not — so the list, not a reading of the manifest, is
 * the verdict; the directory is only read to say why something is missing.
 * CI and the release run the same npm line, so they get the same answer.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { entryPoints, preflight, wouldInclude } from "../packages/tool-pkg/src/lib/preflight";

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

/** How many npm processes run at once when listing tarballs or asking the registry. */
const NPM_POOL = 8;

/** `fn` over every item, at most `limit` at a time; results in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `npm <args>` without blocking, so several can run at once. */
async function npmAsync(args: readonly string[], cwd?: string): Promise<ViewResult> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn(["npm", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    // Bun throws, rather than exits, for a command it cannot start.
    const e = err as { code?: string; message?: string };
    return {
      status: undefined,
      stdout: "",
      stderr: "",
      error: { code: e.code, message: e.message ?? String(err) },
    };
  }
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const signal = proc.signalCode ?? null;
  return { status: signal === null ? status : null, stdout, stderr, signal };
}

/** What npm says a package's tarball would hold, or why it could not say. */
export type PackList =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The file list for package `name` out of `npm pack --dry-run --json`. npm 8 to
 * 11 print an array with one result per package, npm 12 an object keyed by
 * package name, and npm 7 prints no JSON for pack at all. Output that is not
 * one of those is a reason, never an empty list: "npm said nothing" must not
 * read as "the tarball is empty" (or as "it holds everything").
 */
export function parsePackJson(stdout: string, name: string): PackList {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "npm pack --json printed no JSON (npm before 8 has none)" };
  }
  const results: unknown[] = Array.isArray(json)
    ? json
    : json !== null && typeof json === "object"
      ? Object.values(json)
      : [];
  const mine = results.filter(
    (r) => r !== null && typeof r === "object" && (r as { name?: unknown }).name === name,
  );
  const files = mine.length === 1 ? (mine[0] as { files?: unknown }).files : undefined;
  if (
    !Array.isArray(files) ||
    !files.every((f) => typeof (f as { path?: unknown } | null)?.path === "string")
  ) {
    return { ok: false, reason: `npm pack --json gave no file list for ${name}` };
  }
  return { ok: true, paths: files.map((f) => (f as { path: string }).path) };
}

/**
 * Ask npm what it would pack for the package in `dir`, from that dir, as
 * `npm publish` does. `--ignore-scripts`: no package here has a pack-time
 * script, and a dry run must not run one; if one ever adds files, they read as
 * missing here, which refuses rather than ships.
 */
export async function npmPackList(dir: string, name: string): Promise<PackList> {
  const r = await npmAsync(["pack", "--dry-run", "--json", "--ignore-scripts"], dir);
  const spawn = spawnProblem(r);
  if (spawn !== undefined) return { ok: false, reason: spawn };
  if (r.status !== 0) {
    const code = npmErrorCode(r.stdout, r.stderr);
    const line = r.stderr.match(/^npm (?:error|ERR!) (?!code )(.+)$/m)?.[1]?.trim();
    return {
      ok: false,
      reason: `npm pack exited ${r.status}${code ? ` with code ${code}` : ""}${line ? `: ${line}` : ""}`,
    };
  }
  return parsePackJson(r.stdout, name);
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

function publish(p: PkgInfo, pack: PackList): PublishResult {
  console.log(`\n→ publishing ${p.name}@${p.version}`);
  // Checked BEFORE the dry-run early-return, like the ownership guard above: a
  // manifest that would install broken is exactly what a pre-flight is for, and
  // catching it under --dry-run costs nothing and needs no credentials.
  const manifestErr = checkPublishableManifest(p);
  if (manifestErr !== undefined) {
    console.error(`✗ ${p.name}: ${manifestErr}`);
    return "failed";
  }
  // An unbuilt dist/ lands here too (its entry points are not in the tarball),
  // with the hint to build: it used to have a guard of its own further down.
  const packErrs = pack.ok
    ? packedContentsProblems(
        p.dir,
        readJson<Record<string, unknown>>(join(p.dir, "package.json")),
        pack.paths,
      )
    : [
        `could not list what npm would pack (${pack.reason}) — refusing, since nothing says what it would carry`,
      ];
  if (packErrs.length > 0) {
    for (const e of packErrs) console.error(`✗ ${p.name} (${relative(ROOT, p.dir)}): ${e}`);
    return "failed";
  }
  if (DRY) {
    console.log("  (dry-run, skipping)");
    return "ok";
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

/** preflight() rules whose verdict comes from npm's own list here, not from reading `files`. */
const NPM_DECIDES = new Set(["entry-missing", "entry-excluded"]);

/** A `files` entry as npm reads its path: `./x` and `/x` are x at the package root. */
const filesPath = (entry: string): string => entry.replace(/^\.?\/+/, "").replace(/\/+$/, "");

/**
 * What the tarball of the package in `dir` would be missing, as messages; empty
 * when it carries everything it declares. `packed` is npm's own list of what it
 * would pack (see npmPackList), and it is the verdict: every entry point, every
 * literal `files` entry, and README.md, LICENSE and NOTICE must be in it. npm
 * leaves a file out without a word — a missing or symlinked entry, a symlinked
 * directory on the way, an ignore file, a `!` entry, a spelling one npm major
 * reads and another does not — so only its list can say. The directory is read
 * afterwards, to say why something is missing.
 *
 * The other rules shared with the PackagePreflight tool (unpublishable ranges,
 * secrets that would ship) come from @crewhaus/tool-pkg's preflight(); its
 * blocking findings block here, except its reading of whether `files` covers an
 * entry point, which is an approximation npm's list replaces.
 */
export function packedContentsProblems(
  dir: string,
  manifest: Record<string, unknown>,
  packed: readonly string[],
): string[] {
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
  const problems = report.blocking.filter((b) => !NPM_DECIDES.has(b.id)).map((b) => b.message);
  const files = Array.isArray(manifest.files)
    ? (manifest.files as unknown[]).filter((f): f is string => typeof f === "string")
    : null;
  const exact = new Set(packed);
  const inTarball = (rel: string) => exact.has(rel) || packed.some((p) => p.startsWith(`${rel}/`));
  let unbuilt = false;
  const mustCarry = (what: string, rel: string, dirOnly = false): void => {
    if (rel === "" || inTarball(rel)) return;
    const why = whyLeftOut(dir, rel, files, dirOnly);
    if (why.absent && /^dist(?:\/|$)/.test(rel)) unbuilt = true;
    problems.push(`${what} is not in the tarball npm would publish: ${why.reason}`);
  };
  for (const entry of entryPoints(manifest)) {
    // A subpath pattern (`./dist/*.js`) names no one file.
    if (!entry.includes("*")) mustCarry(`entry point "${entry}"`, entry);
  }
  for (const entry of files ?? []) {
    const rel = filesPath(entry);
    // Negations and globs are npm's to expand: what they must cover is checked
    // as an entry point. A required file is checked below, once.
    if (entry.startsWith("!") || /[*?[\]{}]/.test(rel)) continue;
    const dirOnly = entry.endsWith("/");
    if (!dirOnly && (REQUIRED_FILES as readonly string[]).includes(rel)) continue;
    mustCarry(`"files" entry "${entry}"`, rel, dirOnly);
  }
  for (const f of REQUIRED_FILES) mustCarry(f, f);
  if (unbuilt) {
    problems.push(
      "dist/ is not built — run `bun run build` (tsc -b) before `release-prep.ts --for-publish`",
    );
  }
  return problems;
}

/**
 * Why npm left `rel` out of a package's tarball, as far as the package dir
 * shows; `absent` when the path is simply not there. Only asked once npm's list
 * lacks it, so this is a diagnosis, not a verdict. It walks from the package
 * root, the way npm lstat()s its way down: a component that is not there, a
 * symlink (npm packs nothing for one and nothing through one), a trailing slash
 * on something that is not a directory. When the path is there and plain, it
 * names what can drop a file that exists.
 */
function whyLeftOut(
  dir: string,
  rel: string,
  files: readonly string[] | null,
  dirOnly: boolean,
): { readonly absent: boolean; readonly reason: string } {
  const release = (REQUIRED_FILES as readonly string[]).includes(rel)
    ? " — run `release-prep.ts --for-publish`, which puts README.md, LICENSE and NOTICE into every package"
    : "";
  const parts = rel.split("/").filter((s) => s !== "");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const leaf = i === parts.length;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(dir, sub));
    } catch {
      return { absent: true, reason: `${leaf ? "it" : `"${sub}"`} is not there${release}` };
    }
    if (st.isSymbolicLink()) {
      return {
        absent: false,
        reason: leaf
          ? "it is a symlink, and npm packs nothing for one"
          : `"${sub}" is a symlink, and npm packs nothing through one`,
      };
    }
    if (!leaf && !st.isDirectory()) {
      return { absent: true, reason: `"${sub}" is not a directory` };
    }
    if (leaf && dirOnly && !st.isDirectory()) {
      return {
        absent: false,
        reason: 'it is not a directory, and a trailing slash in "files" matches only a directory',
      };
    }
    if (leaf && !st.isDirectory() && !st.isFile()) {
      return { absent: false, reason: "it is not a regular file or directory" };
    }
    if (leaf && st.isDirectory() && readdirSync(join(dir, sub)).length === 0) {
      return { absent: false, reason: "it is an empty directory" };
    }
  }
  const look: string[] = [];
  if (files !== null) {
    const names = files.filter((f) => !f.startsWith("!") && filesPath(f) === rel);
    if (rel === "NOTICE" && names.length === 0) {
      // npm adds README and LICENSE whatever `files` says, but never NOTICE.
      return { absent: false, reason: '"files" does not name it, and npm packs NOTICE only then' };
    }
    // tool-pkg's reading of `files` is exact only for literal entries: its `*`
    // never crosses a `/`, so with a glob in the list it is no hint at all.
    const literal = files.every((f) => !/[*?[\]{}]/.test(f));
    if (literal && rel !== "NOTICE" && names.length === 0 && !wouldInclude(files, rel)) {
      look.push('"files" (no entry covers it)');
    }
    for (const f of names) {
      if (f !== rel) {
        look.push(`the "files" entry "${f}" (not every npm reads that spelling; write "${rel}")`);
      }
    }
    for (const f of files) if (f.startsWith("!")) look.push(`the "files" entry "${f}"`);
  }
  // Ignore files npm reads on the way down (and inside, for a directory).
  for (let i = 0; i <= parts.length; i++) {
    const at = parts.slice(0, i).join("/");
    for (const f of [".npmignore", ".gitignore"]) {
      if (existsSync(join(dir, at, f))) look.push(at === "" ? f : `${at}/${f}`);
    }
  }
  return {
    absent: false,
    reason: look.length > 0 ? `npm leaves it out; look at ${look.join(", ")}` : "npm leaves it out",
  };
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
 * Every `<name>@<version>` unmetDependencies() may ask the registry about for
 * these packages: each dependency outside the run and its whole closure, at the
 * dependent's version, once each. Empty for a full run (every dependency is in
 * it). Asked up front, a few at a time, it costs a `--filter crewhaus` run
 * seconds instead of one sequential lookup per package in the closure.
 */
export function outsideClosure(
  pkgs: readonly Pick<PkgInfo, "deps" | "version">[],
  inRun: ReadonlySet<string>,
  depsOf: (name: string) => readonly string[],
): { readonly name: string; readonly version: string }[] {
  const out: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  const visit = (name: string, version: string): void => {
    const key = `${name}@${version}`;
    if (inRun.has(name) || seen.has(key)) return;
    seen.add(key);
    out.push({ name, version });
    for (const next of depsOf(name)) visit(next, version);
  };
  for (const p of pkgs) for (const d of p.deps) visit(d, p.version);
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
async function main(): Promise<void> {
  if (NO_REGISTRY && !DRY) {
    console.error("✗ --no-registry is a --dry-run option: a real publish must check the registry.");
    process.exit(1);
  }
  // Once, up front: without a working npm every package below would be refused
  // with a complaint that is not the reason. Every form needs it, --no-registry
  // too: npm is what says what each tarball would carry.
  const probe = toViewResult(spawnSync("npm", ["--version"], { encoding: "utf-8" }));
  const why =
    spawnProblem(probe) ??
    (probe.status === 0 ? undefined : `npm --version exited ${probe.status}`);
  if (why !== undefined) {
    console.error(
      `✗ ${why}. Every run needs npm on PATH: it is what says what each tarball would carry.`,
    );
    process.exit(1);
  }
  if (NO_REGISTRY) {
    console.log("Registry not consulted (--no-registry): ownership is NOT checked.");
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
  // Registry lookups the dependency gate will make (under --filter, a whole
  // closure), asked a few at a time now rather than one by one in the loop.
  if (!NO_REGISTRY) {
    const ahead = outsideClosure(filtered, gate.inRun, gate.depsOf);
    const states = await mapPool(ahead, NPM_POOL, async ({ name, version }) =>
      versionState(await npmAsync(["view", `${name}@${version}`, "version"])),
    );
    ahead.forEach(({ name, version }, i) => {
      registryMemo.set(`${name}@${version}`, states[i] as RegistryState);
    });
  }
  // What npm would pack for each package, asked before anything is published.
  console.log(`Asking npm what it would pack for ${filtered.length} package(s)...`);
  const packLists = await mapPool(filtered, NPM_POOL, (p) => npmPackList(p.dir, p.name));
  const packOf = new Map(filtered.map((p, i) => [p.name, packLists[i] as PackList]));
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
    const result = publish(
      p,
      packOf.get(p.name) ?? { ok: false, reason: "npm was not asked about this package" },
    );
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

if (import.meta.main) await main();
