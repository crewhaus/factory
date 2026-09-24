/**
 * publish-workspace.ts: the ownership guard fails closed, a package whose
 * internal dependency failed is not published, and a package whose tarball
 * would miss what it lists is refused — each under --dry-run as well.
 *
 * The integration cases run the real script against a FAKE `npm` placed first
 * on PATH: it records every call and never reaches a registry. Three separate
 * locks keep a broken PATH from ever reaching the real one: the test checks the
 * fake is the `npm` the script will run, npm's registry is pointed at a closed
 * port, and every fixture manifest's publishConfig.registry points there too.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ViewResult,
  classifyViewFailure,
  npmErrorCode,
  ownershipVerdict,
  packedContentsProblems,
  unmetDependencies,
  versionState,
} from "./publish-workspace";

const SCRIPT = join(import.meta.dir, "publish-workspace.ts");
const DEAD_REGISTRY = "http://127.0.0.1:9/";
const REPO_URL = "git+https://github.com/crewhaus/factory.git";
const V = "0.7.1";

// ─── npm output classification (unit) ─────────────────────────────────────────

const E404_JSON = '{"error":{"code":"E404","summary":"Not Found"}}';
const view = (status: number | null, stdout = "", stderr = "", extra = {}): ViewResult => ({
  status,
  stdout,
  stderr,
  ...extra,
});

test("npmErrorCode reads npm's --json error, then its stderr code line", () => {
  expect(npmErrorCode(E404_JSON, "")).toBe("E404");
  expect(npmErrorCode('{"error":{"code":"ECONNREFUSED"}}', "")).toBe("ECONNREFUSED");
  expect(npmErrorCode("", "npm error code E429\nnpm error 429 Too Many")).toBe("E429");
  expect(npmErrorCode("", "npm ERR! code E500\n")).toBe("E500");
  expect(npmErrorCode("not json {", "npm error code E404")).toBe("E404");
  expect(npmErrorCode("", "")).toBeUndefined();
});

test("only E404 counts as 'not on the registry'; every other failure is unknown", () => {
  expect(classifyViewFailure(view(1, E404_JSON))).toEqual({ absent: true });
  for (const r of [
    view(1, '{"error":{"code":"ECONNREFUSED"}}'),
    view(1, "", "npm error code E429"),
    view(1, "", "npm error code E500"),
    view(1, "", ""),
    view(null, "", "", { error: { code: "ENOENT", message: "spawn npm ENOENT" } }),
    view(null, "", "", { signal: "SIGKILL" }),
  ]) {
    const c = classifyViewFailure(r);
    expect(c.absent).toBe(false);
  }
  expect(classifyViewFailure(view(1, "", "npm error code E429"))).toEqual({
    absent: false,
    reason: "npm view exited 1 with code E429",
  });
  expect(
    classifyViewFailure(view(null, "", "", { error: { code: "ENOENT", message: "x" } })),
  ).toEqual({ absent: false, reason: "npm could not be run (ENOENT)" });
});

test("versionState: published, absent (npm 11's E404 and older npm's empty exit 0), or unknown", () => {
  expect(versionState(view(0, "0.7.1\n"))).toEqual({ kind: "published" });
  expect(versionState(view(0, ""))).toEqual({ kind: "absent" });
  expect(versionState(view(1, "", "npm error code E404"))).toEqual({ kind: "absent" });
  expect(versionState(view(1, "", "npm error code ETIMEDOUT"))).toEqual({
    kind: "unknown",
    reason: "npm view exited 1 with code ETIMEDOUT",
  });
});

test("the ownership guard passes a free name or a matching repository, and refuses the rest", () => {
  const p = { name: "@crewhaus/tool-fs", repoUrl: REPO_URL, repoDir: "packages/tool-fs" };
  expect(ownershipVerdict(view(1, E404_JSON), p)).toBeNull();
  expect(
    ownershipVerdict(
      view(0, JSON.stringify({ url: "https://github.com/crewhaus/factory", directory: p.repoDir })),
      p,
    ),
  ).toBeNull();
  const hijack = ownershipVerdict(
    view(0, JSON.stringify({ url: "git+https://github.com/someone-else/other.git" })),
    p,
  );
  expect(hijack).toContain("belong to a DIFFERENT package");
  // The hole: any failure to read the registry used to count as "name is free".
  for (const r of [
    view(1, '{"error":{"code":"ECONNREFUSED"}}'),
    view(1, '{"error":{"code":"E429"}}'),
    view(1, "", "npm error code E500"),
    view(null, "", "", { error: { code: "ENOENT", message: "spawn npm ENOENT" } }),
  ]) {
    const verdict = ownershipVerdict(r, p);
    expect(verdict).toStartWith("could not verify who owns this npm name");
    expect(verdict).toContain("--filter @crewhaus/tool-fs");
  }
});

test("unmetDependencies: failed in this run, missing from the registry, or unknown — each named", () => {
  const asked: string[] = [];
  const registry = (name: string, version: string) => {
    asked.push(`${name}@${version}`);
    if (name === "@crewhaus/there") return { kind: "published" } as const;
    if (name === "@crewhaus/missing") return { kind: "absent" } as const;
    return { kind: "unknown", reason: "npm view exited 1 with code E500" } as const;
  };
  const gate = {
    unavailable: new Set(["@crewhaus/failed"]),
    inRun: new Set(["@crewhaus/failed", "@crewhaus/ok-in-run"]),
    registry,
  };
  const unmet = unmetDependencies(
    {
      version: V,
      deps: [
        "@crewhaus/failed",
        "@crewhaus/ok-in-run",
        "@crewhaus/there",
        "@crewhaus/missing",
        "@crewhaus/flaky",
      ],
    },
    gate,
  );
  expect(unmet).toEqual([
    "@crewhaus/failed (failed or was refused in this run)",
    `@crewhaus/missing@${V} (not on the registry)`,
    `@crewhaus/flaky@${V} (could not check the registry: npm view exited 1 with code E500)`,
  ]);
  // A dependency this run handles is never looked up: a brand-new name can 404
  // for minutes after its own successful publish.
  expect(asked).toEqual([`@crewhaus/there@${V}`, `@crewhaus/missing@${V}`, `@crewhaus/flaky@${V}`]);
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

let TMP = "";
let FAKE_BIN = "";

// The fake npm. Reads its behaviour from $FAKE_NPM_CONFIG, appends every call to
// $FAKE_NPM_LOG, and never opens a socket.
const FAKE_NPM_SOURCE = `
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(process.env.FAKE_NPM_CONFIG, "utf8"));
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
const fail = (code) => {
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ error: { code, summary: code } }));
  process.stderr.write("npm error code " + code + "\\n");
  process.exit(1);
};
if (args[0] === "--fake-probe") { process.stdout.write("FAKE-NPM"); process.exit(0); }
if (args[0] === "whoami") { process.stdout.write("fake-user\\n"); process.exit(0); }
if (args[0] === "view") {
  const spec = args[1];
  if (cfg.viewError) fail(cfg.viewError);
  if (args[2] === "repository") {
    const repo = (cfg.repos || {})[spec];
    if (repo) { process.stdout.write(JSON.stringify(repo)); process.exit(0); }
    fail("E404");
  }
  if (args[2] === "version") {
    if ((cfg.published || []).includes(spec)) { process.stdout.write(spec.slice(spec.lastIndexOf("@") + 1) + "\\n"); process.exit(0); }
    fail((cfg.versionError || {})[spec] || "E404");
  }
}
if (args[0] === "publish") {
  const name = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).name;
  if ((cfg.failPublish || []).includes(name)) fail("E403");
  process.stdout.write("+ " + name + "\\n");
  process.exit(0);
}
process.stderr.write("fake npm: unhandled " + JSON.stringify(args) + "\\n");
process.exit(2);
`;

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "publish-workspace-"));
  FAKE_BIN = join(TMP, "bin");
  mkdirSync(FAKE_BIN);
  writeFileSync(join(TMP, "fake-npm.cjs"), FAKE_NPM_SOURCE);
  const shim = join(FAKE_BIN, "npm");
  writeFileSync(shim, `#!/bin/sh\nexec bun ${JSON.stringify(join(TMP, "fake-npm.cjs"))} "$@"\n`);
  chmodSync(shim, 0o755);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

type FakeNpm = {
  repos?: Record<string, { url: string; directory: string }>;
  published?: string[];
  failPublish?: string[];
  viewError?: string;
  versionError?: Record<string, string>;
};

type PkgSpec = {
  name: string;
  dir: string;
  deps?: Record<string, string>;
  optionalDeps?: Record<string, string>;
  /** Files to leave out of the package dir. */
  omit?: string[];
  files?: string[];
};

/** A workspace laid out as release-prep --for-publish leaves it. */
function makeWorkspace(pkgs: PkgSpec[]): string {
  const root = mkdtempSync(join(TMP, "ws-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  for (const spec of pkgs) {
    const dir = join(root, "packages", spec.dir);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    for (const f of ["README.md", "LICENSE", "NOTICE"]) {
      if (!spec.omit?.includes(f)) writeFileSync(join(dir, f), `${f}\n`);
    }
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: spec.name,
        version: V,
        type: "module",
        main: "dist/index.js",
        files: spec.files ?? ["dist", "README.md", "LICENSE", "NOTICE"],
        repository: { type: "git", url: REPO_URL, directory: `packages/${spec.dir}` },
        // Lock 3: even the real npm would publish to a closed port.
        publishConfig: { access: "public", registry: DEAD_REGISTRY },
        ...(spec.deps ? { dependencies: spec.deps } : {}),
        ...(spec.optionalDeps ? { optionalDependencies: spec.optionalDeps } : {}),
      }),
    );
  }
  return root;
}

/**
 * npm config that cannot see the developer's: empty user and global files (two
 * files — npm refuses to load one path as both) and a private cache.
 */
function isolatedNpmConfig(root: string): Record<string, string> {
  const user = join(root, "user-npmrc");
  const global = join(root, "global-npmrc");
  writeFileSync(user, "");
  writeFileSync(global, "");
  return {
    npm_config_userconfig: user,
    npm_config_globalconfig: global,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

function childEnv(root: string, cfg: FakeNpm): Record<string, string> {
  const cfgPath = join(root, "fake-npm.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const log = join(root, "npm-calls.log");
  writeFileSync(log, "");
  // Built from scratch: no NPM_TOKEN, no ACTIONS_ID_TOKEN_REQUEST_URL, no
  // npm_config_* from the developer's shell.
  return {
    PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
    HOME: root,
    FAKE_NPM_CONFIG: cfgPath,
    FAKE_NPM_LOG: log,
    ...isolatedNpmConfig(root),
    npm_config_registry: DEAD_REGISTRY,
  };
}

function run(root: string, cfg: FakeNpm, ...flags: string[]) {
  const env = childEnv(root, cfg);
  // Lock 1: the npm the script will spawn is the fake.
  const probe = Bun.spawnSync(["npm", "--fake-probe"], { env, cwd: root });
  expect(probe.stdout.toString()).toBe("FAKE-NPM");
  const r = Bun.spawnSync(["bun", SCRIPT, "--root", root, ...flags], { env, cwd: root });
  const calls = readFileSync(env.FAKE_NPM_LOG as string, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] !== "--fake-probe");
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    calls,
  };
}

/** Names `npm publish` was run for, in order (the fake prints "+ <name>"). */
const publishedNames = (stdout: string) =>
  stdout
    .split("\n")
    .filter((l) => l.startsWith("+ "))
    .map((l) => l.slice(2));

const A = { name: "@crewhaus/zz-a", dir: "zz-a" };
const B = { name: "@crewhaus/zz-b", dir: "zz-b", deps: { "@crewhaus/zz-a": V } };
const CLI = { name: "crewhaus", dir: "cli", deps: { "@crewhaus/zz-b": V } };
const D = { name: "@crewhaus/zz-d", dir: "zz-d" };

// ─── the dependency gate ──────────────────────────────────────────────────────

test("a failed publish is not followed by its dependents, the bare crewhaus CLI included", () => {
  const root = makeWorkspace([A, B, CLI, D]);
  const r = run(root, { failPublish: ["@crewhaus/zz-a"] });
  expect(r.exitCode).toBe(1);
  // npm publish ran for A (which failed) and for the independent D — never for
  // B, which pins A, nor for crewhaus, which pins B.
  const publishCalls = r.calls.filter((a) => a[0] === "publish").length;
  expect(publishCalls).toBe(2);
  expect(publishedNames(r.stdout)).toEqual(["@crewhaus/zz-d"]);
  expect(r.stdout).not.toContain("→ publishing @crewhaus/zz-b");
  expect(r.stdout).not.toContain("→ publishing crewhaus@");
  expect(r.stdout).toContain("Published: 1  Skipped: 0  Failed: 3");
  expect(r.stderr).toContain(
    `@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a (failed or was refused in this run))`,
  );
  expect(r.stderr).toContain(
    `crewhaus@${V} (blocked: @crewhaus/zz-b (failed or was refused in this run))`,
  );
}, 30_000);

test("an internal optional dependency that fails blocks its dependent too", () => {
  const OPT = { name: "@crewhaus/zz-adapter", dir: "zz-adapter" };
  const cli = { name: "crewhaus", dir: "cli", optionalDeps: { "@crewhaus/zz-adapter": V } };
  const root = makeWorkspace([OPT, cli]);
  const r = run(root, { failPublish: ["@crewhaus/zz-adapter"] });
  expect(r.exitCode).toBe(1);
  expect(publishedNames(r.stdout)).toEqual([]);
  expect(r.stderr).toContain(`crewhaus@${V} (blocked: @crewhaus/zz-adapter`);
}, 30_000);

test("--dry-run shows the same cascade instead of planning the dependents", () => {
  const root = makeWorkspace([A, B, CLI, D]);
  // A fails its manifest check: a workspace: range survived.
  const aPkg = join(root, "packages", "zz-a", "package.json");
  const manifest = JSON.parse(readFileSync(aPkg, "utf8"));
  manifest.dependencies = { "@crewhaus/zz-d": "workspace:*" };
  writeFileSync(aPkg, JSON.stringify(manifest));
  const r = run(root, {}, "--dry-run");
  expect(r.exitCode).toBe(1);
  expect(r.calls.filter((a) => a[0] === "publish")).toEqual([]);
  expect(r.stderr).toContain('is still "workspace:*"');
  expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
  expect(r.stderr).toContain(`crewhaus@${V} (blocked: @crewhaus/zz-b`);
  expect(r.stdout).toContain("Published: 1  Skipped: 0  Failed: 3");
}, 30_000);

test("--filter checks a dependency outside the run on the registry: absent or unknown refuses, present publishes", () => {
  const root = makeWorkspace([A, B, CLI]);
  const absent = run(root, {}, "--filter", "crewhaus");
  expect(absent.exitCode).toBe(1);
  expect(absent.calls.filter((a) => a[0] === "publish")).toEqual([]);
  expect(absent.stderr).toContain(`@crewhaus/zz-b@${V} (not on the registry)`);

  const flaky = run(
    root,
    { versionError: { [`@crewhaus/zz-b@${V}`]: "E500" } },
    "--filter",
    "crewhaus",
  );
  expect(flaky.exitCode).toBe(1);
  expect(flaky.calls.filter((a) => a[0] === "publish")).toEqual([]);
  expect(flaky.stderr).toContain("could not check the registry: npm view exited 1 with code E500");

  const present = run(root, { published: [`@crewhaus/zz-b@${V}`] }, "--filter", "crewhaus");
  expect(present.stderr).toBe("");
  expect(present.exitCode).toBe(0);
  expect(publishedNames(present.stdout)).toEqual(["crewhaus"]);
}, 30_000);

test("a package already on the registry whose dependency failed still holds back its dependents", () => {
  const root = makeWorkspace([A, B, CLI]);
  const r = run(root, {
    failPublish: ["@crewhaus/zz-a"],
    published: [`@crewhaus/zz-b@${V}`],
    repos: { "@crewhaus/zz-b": { url: REPO_URL, directory: "packages/zz-b" } },
  });
  expect(r.exitCode).toBe(1);
  expect(publishedNames(r.stdout)).toEqual([]);
  expect(r.stdout).toContain(`= @crewhaus/zz-b@${V} already on registry — skipping`);
  expect(r.stderr).toContain("installs of it fail until that is published");
  expect(r.stderr).toContain(`crewhaus@${V} (blocked: @crewhaus/zz-b`);
  expect(r.stdout).toContain("Published: 0  Skipped: 1  Failed: 2");
}, 30_000);

test("a registry that cannot say whether a version exists does not skip it: the publish is tried", () => {
  // Ownership was confirmed a moment earlier, and npm refuses to publish over
  // an existing version, so the publish itself is the authoritative check.
  const root = makeWorkspace([D]);
  const r = run(root, { versionError: { [`@crewhaus/zz-d@${V}`]: "E500" } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain(
    `could not tell whether @crewhaus/zz-d@${V} is already published: npm view exited 1 with code E500; trying the publish`,
  );
  expect(publishedNames(r.stdout)).toEqual(["@crewhaus/zz-d"]);
}, 30_000);

// ─── the ownership guard, end to end ──────────────────────────────────────────

test("the ownership guard refuses when the registry cannot be read, and passes a clean E404", () => {
  const root = makeWorkspace([{ name: "@crewhaus/tool-fs", dir: "tool-fs" }]);
  for (const code of ["ECONNREFUSED", "E429", "E500"]) {
    const r = run(root, { viewError: code }, "--dry-run");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `could not verify who owns this npm name (npm view exited 1 with code ${code})`,
    );
    expect(r.stdout).toContain("Published: 0  Skipped: 0  Failed: 1");
  }
  const free = run(root, {}, "--dry-run");
  expect(free.stderr).toBe("");
  expect(free.exitCode).toBe(0);
  expect(free.stdout).toContain("Published: 1  Skipped: 0  Failed: 0");
}, 30_000);

// ─── packed contents ──────────────────────────────────────────────────────────

test("packedContentsProblems names each thing a tarball would be missing", () => {
  const root = makeWorkspace([
    { name: "@crewhaus/ok", dir: "ok" },
    { name: "@crewhaus/no-license", dir: "no-license", omit: ["LICENSE"] },
    { name: "@crewhaus/no-readme", dir: "no-readme", omit: ["README.md"] },
    {
      name: "@crewhaus/no-notice-entry",
      dir: "no-notice-entry",
      files: ["dist", "README.md", "LICENSE"],
    },
    {
      name: "@crewhaus/data",
      dir: "data",
      files: ["dist", "skills", "templates/*.md", "README.md", "LICENSE", "NOTICE"],
    },
    { name: "@crewhaus/linked", dir: "linked", omit: ["NOTICE"] },
  ]);
  const problems = (dir: string) => {
    const pkgDir = join(root, "packages", dir);
    return packedContentsProblems(
      pkgDir,
      JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")),
    );
  };
  expect(problems("ok")).toEqual([]);
  expect(problems("no-license")).toEqual([
    "LICENSE is missing or not a regular file — run `release-prep.ts --for-publish`, which puts README.md, LICENSE and NOTICE into every package",
  ]);
  expect(problems("no-readme")).toHaveLength(1);
  expect(problems("no-readme")[0]).toStartWith("README.md is missing");
  expect(problems("no-notice-entry")).toEqual([
    '"files" does not list NOTICE — npm packs NOTICE only when `files` names it',
  ]);
  // A literal entry that is not there is named; a glob is npm's to expand.
  expect(problems("data")).toEqual([
    '"files" lists "skills", which is not there — npm would pack nothing for it',
  ]);
  // npm leaves a symlink out of the tarball.
  symlinkSync(join(root, "packages", "ok", "NOTICE"), join(root, "packages", "linked", "NOTICE"));
  expect(problems("linked")).toHaveLength(1);
  expect(problems("linked")[0]).toStartWith("NOTICE is missing or not a regular file");
  // The shared preflight's blocking rules apply: an entry point that is not built.
  rmSync(join(root, "packages", "ok", "dist"), { recursive: true });
  expect(problems("ok")).toEqual([
    'entry point "dist/index.js" does not exist',
    '"files" lists "dist", which is not there — npm would pack nothing for it',
  ]);
});

test("a package whose tarball would miss LICENSE fails the --dry-run pre-flight, and its dependents with it", () => {
  const root = makeWorkspace([{ ...A, omit: ["LICENSE"] }, B]);
  const r = run(root, {}, "--dry-run");
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("✗ @crewhaus/zz-a (packages/zz-a): LICENSE is missing");
  expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
  expect(r.stdout).toContain("Published: 0  Skipped: 0  Failed: 2");
}, 30_000);

test("--dry-run --no-registry never runs npm, still checks packed contents and the plan, and says ownership was not checked", () => {
  const root = makeWorkspace([{ ...A, omit: ["NOTICE"] }, B, D]);
  const r = run(root, {}, "--dry-run", "--no-registry");
  expect(r.calls).toEqual([]);
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toContain("Registry not consulted (--no-registry): ownership is NOT checked.");
  expect(r.stderr).toContain("✗ @crewhaus/zz-a (packages/zz-a): NOTICE is missing");
  expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
  expect(r.stdout).toContain("Published: 1  Skipped: 0  Failed: 2");

  // A dependency outside the run cannot be confirmed without the registry.
  const filtered = run(root, {}, "--dry-run", "--no-registry", "--filter", "@crewhaus/zz-b");
  expect(filtered.calls).toEqual([]);
  expect(filtered.exitCode).toBe(1);
  expect(filtered.stderr).toContain(
    `@crewhaus/zz-a@${V} (could not check the registry: --no-registry)`,
  );

  // And a real publish refuses the flag outright.
  const real = run(root, {}, "--no-registry");
  expect(real.exitCode).toBe(1);
  expect(real.stderr).toContain("--no-registry is a --dry-run option");
  expect(real.calls).toEqual([]);
}, 30_000);

// ─── the real npm CLI against a local registry ────────────────────────────────
// The classifier above is only as good as its reading of npm's actual output,
// which changes between npm majors (`npm ERR!` → `npm error`, JSON on stdout).
// This runs whatever npm the machine has — CI's included — against an
// in-process registry, under --dry-run (nothing is ever published), with npm's
// config pointed away from the developer's own.

async function runWithRealNpm(root: string, status: number) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      status === 404
        ? Response.json({ error: "Not found" }, { status: 404 })
        : new Response("upstream down", { status }),
  });
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: root,
      ...isolatedNpmConfig(root),
      npm_config_registry: `http://127.0.0.1:${server.port}/`,
      npm_config_fetch_retries: "0",
    };
    // Async spawn: a synchronous one would block the in-process registry.
    const proc = Bun.spawn(["bun", SCRIPT, "--root", root, "--dry-run"], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    server.stop(true);
  }
}

test.skipIf(Bun.which("npm") === null)(
  "with the real npm: a registry answering 500 refuses the package, a 404 is a first publish",
  async () => {
    const root = makeWorkspace([{ name: "@crewhaus/tool-fs", dir: "tool-fs" }]);
    const down = await runWithRealNpm(root, 500);
    expect(down.exitCode).toBe(1);
    expect(down.stderr).toContain(
      "could not verify who owns this npm name (npm view exited 1 with code E500)",
    );
    expect(down.stdout).toContain("Failed: 1");
    const free = await runWithRealNpm(root, 404);
    expect(free.stderr).toBe("");
    expect(free.exitCode).toBe(0);
    expect(free.stdout).toContain("Published: 1  Skipped: 0  Failed: 0");
  },
  60_000,
);
