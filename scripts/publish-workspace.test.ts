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
import { spawnSync } from "node:child_process";
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
  rerunAdvice,
  toViewResult,
  unmetDependencies,
  versionState,
} from "./publish-workspace";

const SCRIPT = join(import.meta.dir, "publish-workspace.ts");
const DEAD_REGISTRY = "http://127.0.0.1:9/";
const REPO_URL = "git+https://github.com/crewhaus/factory.git";
const V = "0.7.1";

// ─── npm output classification (unit) ─────────────────────────────────────────

const E404_JSON = '{"error":{"code":"E404","summary":"Not Found"}}';
const view = (
  status: number | null | undefined,
  stdout = "",
  stderr = "",
  extra = {},
): ViewResult => ({
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
    view(undefined, "", "", { error: { code: "ENOENT", message: "spawn npm ENOENT" } }),
    view(null, "", "", { signal: "SIGKILL" }),
  ]) {
    const c = classifyViewFailure(r);
    expect(c.absent).toBe(false);
  }
  expect(classifyViewFailure(view(1, "", "npm error code E429"))).toEqual({
    absent: false,
    reason: "npm view exited 1 with code E429",
  });
  expect(classifyViewFailure(view(null, "", "", { signal: "SIGKILL" }))).toEqual({
    absent: false,
    reason: "npm was killed by SIGKILL",
  });
});

test("a command that is not on PATH is reported as that, in the shape Bun's spawnSync really returns", () => {
  // Bun reports a missing executable with status undefined (Node says null); the
  // classifier used to test `=== null` and so called it "exited undefined".
  const missing = toViewResult(
    spawnSync("crewhaus-no-such-command-e2b7", ["view"], { encoding: "utf-8" }),
  );
  expect(missing.error?.code).toBe("ENOENT");
  expect(classifyViewFailure(missing)).toEqual({
    absent: false,
    reason: "npm could not be run (ENOENT)",
  });
  expect(versionState(missing)).toEqual({
    kind: "unknown",
    reason: "npm could not be run (ENOENT)",
  });
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
    view(undefined, "", "", { error: { code: "ENOENT", message: "spawn npm ENOENT" } }),
  ]) {
    const verdict = ownershipVerdict(r, p);
    expect(verdict).toStartWith("could not verify who owns this npm name");
    // No retry advice here: `--filter <this>` would publish it alone and leave
    // everything that depends on it unpublished. The run's summary says how.
    expect(verdict).not.toContain("--filter");
  }
  expect(
    ownershipVerdict(
      view(undefined, "", "", { error: { code: "ENOENT", message: "spawn npm ENOENT" } }),
      p,
    ),
  ).toBe(
    "could not verify who owns this npm name (npm could not be run (ENOENT)) — refusing to publish until the registry answers",
  );
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
    depsOf: () => [],
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

test("unmetDependencies walks a dependency outside the run down to its own dependencies", () => {
  // cli -> b -> {a, c}, c -> a. b and c are on the registry; a is not. Before,
  // only b was asked about, and the CLI went out onto a closure with a hole.
  const graph: Record<string, string[]> = {
    "@crewhaus/b": ["@crewhaus/a", "@crewhaus/c"],
    "@crewhaus/c": ["@crewhaus/a"],
    "@crewhaus/a": [],
  };
  const asked: string[] = [];
  const gate = {
    unavailable: new Set<string>(),
    inRun: new Set(["crewhaus"]),
    registry: (name: string, version: string) => {
      asked.push(`${name}@${version}`);
      return name === "@crewhaus/a"
        ? ({ kind: "absent" } as const)
        : ({ kind: "published" } as const);
    },
    depsOf: (name: string) => graph[name] ?? [],
  };
  expect(unmetDependencies({ version: V, deps: ["@crewhaus/b"] }, gate)).toEqual([
    `@crewhaus/a@${V} (not on the registry; needed through @crewhaus/b)`,
  ]);
  // Each member is asked about once, even when two paths reach it.
  expect(asked).toEqual([`@crewhaus/b@${V}`, `@crewhaus/a@${V}`, `@crewhaus/c@${V}`]);

  // A member the run settled is not walked into: its own check covered it.
  asked.length = 0;
  const settled = { ...gate, inRun: new Set(["crewhaus", "@crewhaus/c"]) };
  graph["@crewhaus/b"] = ["@crewhaus/c"];
  expect(unmetDependencies({ version: V, deps: ["@crewhaus/b"] }, settled)).toEqual([]);
  expect(asked).toEqual([`@crewhaus/b@${V}`]);

  // One that failed in the run is named, with the path to it.
  asked.length = 0;
  const failed = { ...settled, unavailable: new Set(["@crewhaus/c"]) };
  expect(unmetDependencies({ version: V, deps: ["@crewhaus/b"] }, failed)).toEqual([
    "@crewhaus/c (failed or was refused in this run; needed through @crewhaus/b)",
  ]);
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

let TMP = "";
let FAKE_BIN = "";

// The fake npm. Reads its behaviour from $FAKE_NPM_CONFIG, appends every call to
// $FAKE_NPM_LOG, and never opens a socket. With `persist`, it is a registry that
// remembers: a publish is recorded in the config file, so a later run sees it,
// and a `viewErrorOnce` entry fires once and is then gone.
const FAKE_NPM_SOURCE = `
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(process.env.FAKE_NPM_CONFIG, "utf8"));
const save = () => writeFileSync(process.env.FAKE_NPM_CONFIG, JSON.stringify(cfg));
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
const fail = (code) => {
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ error: { code, summary: code } }));
  process.stderr.write("npm error code " + code + "\\n");
  process.exit(1);
};
if (args[0] === "--fake-probe") { process.stdout.write("FAKE-NPM"); process.exit(0); }
if (args[0] === "--version") { process.stdout.write("11.0.0-fake\\n"); process.exit(0); }
if (args[0] === "whoami") { process.stdout.write("fake-user\\n"); process.exit(0); }
if (args[0] === "view") {
  const spec = args[1];
  if (cfg.viewError) fail(cfg.viewError);
  const onceKey = spec + " " + args[2];
  const once = (cfg.viewErrorOnce || {})[onceKey];
  if (once) { delete cfg.viewErrorOnce[onceKey]; save(); fail(once); }
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
  const pj = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const name = pj.name;
  if ((cfg.failPublish || []).includes(name)) fail("E403");
  if (cfg.persist) {
    cfg.published = [...(cfg.published || []), name + "@" + pj.version];
    cfg.repos = { ...(cfg.repos || {}), [name]: { url: pj.repository.url, directory: pj.repository.directory } };
    save();
  }
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
  /** "<spec> <field>" → an error code returned once, e.g. a transient E429. */
  viewErrorOnce?: Record<string, string>;
  /** Record publishes in the config, so the next run sees them on the registry. */
  persist?: boolean;
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

/** `cfg: null` keeps the fake registry's state from the previous run. */
function childEnv(root: string, cfg: FakeNpm | null): Record<string, string> {
  const cfgPath = join(root, "fake-npm.json");
  if (cfg !== null) writeFileSync(cfgPath, JSON.stringify(cfg));
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

function run(root: string, cfg: FakeNpm | null, ...flags: string[]) {
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

/** The fake registry's state as the last run left it. */
const fakeState = (root: string): FakeNpm =>
  JSON.parse(readFileSync(join(root, "fake-npm.json"), "utf8")) as FakeNpm;

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

  const present = run(
    root,
    { published: [`@crewhaus/zz-b@${V}`, `@crewhaus/zz-a@${V}`] },
    "--filter",
    "crewhaus",
  );
  expect(present.stderr).toBe("");
  expect(present.exitCode).toBe(0);
  expect(publishedNames(present.stdout)).toEqual(["crewhaus"]);
}, 30_000);

test("--filter checks the whole closure: a dependency's own dependency missing from the registry refuses the package", () => {
  // crewhaus -> zz-b -> zz-a; zz-b is on the registry, zz-a is not. The full run
  // holds crewhaus back in this state; --filter used to publish it.
  const root = makeWorkspace([A, B, CLI]);
  const r = run(root, { published: [`@crewhaus/zz-b@${V}`] }, "--filter", "crewhaus");
  expect(r.exitCode).toBe(1);
  expect(r.calls.filter((a) => a[0] === "publish")).toEqual([]);
  expect(r.stderr).toContain(
    `crewhaus@${V} not published: it depends on @crewhaus/zz-a@${V} (not on the registry; needed through @crewhaus/zz-b)`,
  );
  expect(r.calls.filter((a) => a[0] === "view" && a[2] === "version").map((a) => a[1])).toEqual([
    `@crewhaus/zz-b@${V}`,
    `@crewhaus/zz-a@${V}`,
    `crewhaus@${V}`,
  ]);
  expect(r.stdout).toContain("Published: 0  Skipped: 0  Failed: 1");
}, 30_000);

test("--filter on a package already on the registry whose dependency is not says so, and fails", () => {
  const root = makeWorkspace([A, B, CLI]);
  const r = run(
    root,
    {
      published: [`@crewhaus/zz-b@${V}`],
      repos: { "@crewhaus/zz-b": { url: REPO_URL, directory: "packages/zz-b" } },
    },
    "--filter",
    "@crewhaus/zz-b",
  );
  expect(r.exitCode).toBe(1);
  expect(publishedNames(r.stdout)).toEqual([]);
  expect(r.stdout).toContain(`= @crewhaus/zz-b@${V} already on registry — skipping`);
  expect(r.stdout).toContain("Published: 0  Skipped: 1  Failed: 0");
  expect(r.stderr).toContain(
    `On the registry but not installable: @crewhaus/zz-b@${V} (depends on @crewhaus/zz-a@${V} (not on the registry))`,
  );
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
  expect(r.stderr).toContain(
    `On the registry but not installable: @crewhaus/zz-b@${V} (depends on @crewhaus/zz-a (failed or was refused in this run))`,
  );
}, 30_000);

// ─── recovering from a failed run ─────────────────────────────────────────────
// What the script tells an operator to do after a failure must finish the
// release. It used to say `re-run with --filter <leaf>`, which publishes the
// leaf alone and exits 0 with everything the leaf had held back unpublished.

/** Run again the way the previous run's summary says to finish the release. */
function followAdvice(root: string, previous: { stderr: string }, flags: string[]) {
  const filter = flags.includes("--filter") ? flags[flags.indexOf("--filter") + 1] : undefined;
  const advice = rerunAdvice(filter);
  expect(previous.stderr).toContain(advice);
  expect(advice).toContain(
    "re-run without --filter: versions already on the registry are skipped, and the rest go out",
  );
  const next = flags.filter((f, i) => f !== "--filter" && flags[i - 1] !== "--filter");
  return run(root, null, ...next);
}

test("after a leaf's publish fails, doing what the summary says publishes everything it held back", () => {
  const root = makeWorkspace([A, B, CLI]);
  const first = run(root, { persist: true, failPublish: ["@crewhaus/zz-a"] });
  expect(first.exitCode).toBe(1);
  expect(first.stderr).not.toContain("re-run with --filter");
  // The operator fixes zz-a (say, its trusted publisher) and follows the advice.
  writeFileSync(
    join(root, "fake-npm.json"),
    JSON.stringify({ ...fakeState(root), failPublish: [] }),
  );
  const second = followAdvice(root, first, []);
  expect(second.stderr).toBe("");
  expect(second.exitCode).toBe(0);
  expect(fakeState(root).published?.sort()).toEqual([
    `@crewhaus/zz-a@${V}`,
    `@crewhaus/zz-b@${V}`,
    `crewhaus@${V}`,
  ]);
}, 30_000);

test("after the registry could not confirm a leaf's owner, doing what the summary says finishes the release", () => {
  const root = makeWorkspace([A, B, CLI]);
  const first = run(root, {
    persist: true,
    viewErrorOnce: { "@crewhaus/zz-a repository": "E429" },
  });
  expect(first.exitCode).toBe(1);
  expect(first.stdout).toContain("Published: 0  Skipped: 0  Failed: 3");
  const second = followAdvice(root, first, []);
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("Published: 3  Skipped: 0  Failed: 0");
  expect(fakeState(root).published?.sort()).toEqual([
    `@crewhaus/zz-a@${V}`,
    `@crewhaus/zz-b@${V}`,
    `crewhaus@${V}`,
  ]);
}, 30_000);

test("a failed --filter run says what --filter will and will not publish, and the full re-run finishes it", () => {
  const root = makeWorkspace([A, B, CLI]);
  const first = run(
    root,
    { persist: true, failPublish: ["@crewhaus/zz-a"] },
    "--filter",
    "@crewhaus/zz-a",
  );
  expect(first.exitCode).toBe(1);
  expect(rerunAdvice("@crewhaus/zz-a")).toContain(
    "re-run with --filter @crewhaus/zz-a to retry that package alone",
  );
  writeFileSync(
    join(root, "fake-npm.json"),
    JSON.stringify({ ...fakeState(root), failPublish: [] }),
  );
  const second = followAdvice(root, first, ["--filter", "@crewhaus/zz-a"]);
  expect(second.exitCode).toBe(0);
  expect(fakeState(root).published?.sort()).toEqual([
    `@crewhaus/zz-a@${V}`,
    `@crewhaus/zz-b@${V}`,
    `crewhaus@${V}`,
  ]);
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

test("packedContentsProblems reads a `files` entry the way npm does: a trailing slash wants a directory, a symlink packs nothing", () => {
  const withFiles = (dir: string, files: string[]) => ({ name: `@crewhaus/${dir}`, dir, files });
  const root = makeWorkspace([
    withFiles("slash-notice", ["dist", "README.md", "LICENSE", "NOTICE/"]),
    withFiles("dot-notice", ["dist/", "README.md", "LICENSE", "./NOTICE"]),
    withFiles("rooted-notice", ["dist", "README.md", "LICENSE", "/NOTICE"]),
    withFiles("linked-entry", ["dist", "README.md", "LICENSE", "NOTICE", "skills"]),
  ]);
  const pkg = (dir: string) => join(root, "packages", dir);
  const problems = (dir: string) =>
    packedContentsProblems(
      pkg(dir),
      JSON.parse(readFileSync(join(pkg(dir), "package.json"), "utf8")),
    );
  // `NOTICE/` used to be read as `NOTICE`; npm packs no NOTICE for it.
  expect(problems("slash-notice")).toEqual([
    '"files" lists "NOTICE/", which is not a directory — a trailing slash matches only a directory, so npm would pack nothing for it',
    '"files" does not list NOTICE — npm packs NOTICE only when `files` names it',
  ]);
  expect(problems("dot-notice")).toEqual([]);
  expect(problems("rooted-notice")).toEqual([]);
  // An entry that is a symlink exists, but npm packs nothing for it.
  mkdirSync(join(pkg("linked-entry"), "real-skills"));
  writeFileSync(join(pkg("linked-entry"), "real-skills", "a.md"), "a\n");
  symlinkSync("real-skills", join(pkg("linked-entry"), "skills"));
  expect(problems("linked-entry")).toEqual([
    '"files" lists "skills", which is a symlink — npm would pack nothing for it',
  ]);
});

// npm's own reading of each spelling, so the check above cannot drift from it.
test.skipIf(Bun.which("npm") === null)(
  "packedContentsProblems agrees with real `npm pack` on every `files` spelling it accepts or refuses",
  () => {
    const cases: { entry: string; npmPacksIt: boolean }[] = [
      { entry: "NOTICE", npmPacksIt: true },
      { entry: "./NOTICE", npmPacksIt: true },
      { entry: "/NOTICE", npmPacksIt: true },
      { entry: "NOTICE/", npmPacksIt: false },
      { entry: "./NOTICE/", npmPacksIt: false },
      { entry: "skills", npmPacksIt: true },
      { entry: "skills/", npmPacksIt: true },
      { entry: "linked", npmPacksIt: false },
      { entry: "linked/", npmPacksIt: false },
      { entry: "linked-file.md", npmPacksIt: false },
    ];
    const root = mkdtempSync(join(TMP, "spell-"));
    const npmEnv = { PATH: process.env.PATH ?? "", HOME: root, ...isolatedNpmConfig(root) };
    for (const [i, { entry, npmPacksIt }] of cases.entries()) {
      const dir = join(root, `p${i}`);
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "skills"));
      writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
      writeFileSync(join(dir, "skills", "s.md"), "s\n");
      writeFileSync(join(dir, "real.md"), "r\n");
      for (const f of ["README.md", "LICENSE", "NOTICE"]) writeFileSync(join(dir, f), `${f}\n`);
      symlinkSync("skills", join(dir, "linked"));
      symlinkSync("real.md", join(dir, "linked-file.md"));
      const isNotice = entry.replace(/^\.?\//, "").startsWith("NOTICE");
      const manifest = {
        name: `@crewhaus/spell-${i}`,
        version: V,
        main: "dist/index.js",
        files: ["dist", "README.md", "LICENSE", ...(isNotice ? [] : ["NOTICE"]), entry],
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
      const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: dir,
        env: npmEnv,
      });
      expect(pack.exitCode).toBe(0);
      const packed = (
        JSON.parse(pack.stdout.toString()) as { files: { path: string }[] }[]
      )[0]?.files.map((f) => f.path);
      const target = isNotice ? "NOTICE" : entry.replace(/\/+$/, "");
      const npmPacked = (packed ?? []).some((p) => p === target || p.startsWith(`${target}/`));
      // Pin npm's behaviour (so a change in npm fails here, loudly) ...
      expect({ entry, npmPacked }).toEqual({ entry, npmPacked: npmPacksIt });
      // ... and require the check to agree with it.
      const problems = packedContentsProblems(dir, manifest);
      expect({ entry, accepted: problems.length === 0 }).toEqual({ entry, accepted: npmPacksIt });
    }
  },
  60_000,
);

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

test("with no npm on PATH the script stops once and says so; --dry-run --no-registry still runs", () => {
  const root = makeWorkspace([A, B]);
  // A PATH with nothing on it: the script itself is started by absolute path.
  const env = {
    PATH: mkdtempSync(join(TMP, "empty-bin-")),
    HOME: root,
    ...isolatedNpmConfig(root),
  };
  const go = (...flags: string[]) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, "--root", root, ...flags], {
      env,
      cwd: root,
    });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const noNpm =
    "✗ npm could not be run (ENOENT). Every run except --dry-run --no-registry needs npm on PATH.\n";
  for (const flags of [["--dry-run"], []]) {
    const r = go(...flags);
    expect(r.exitCode).toBe(1);
    // Once, before any package — not a registry complaint per package.
    expect(r.stderr).toBe(noNpm);
    expect(r.stdout).not.toContain("→ publishing");
  }
  const offline = go("--dry-run", "--no-registry");
  expect(offline.stderr).toBe("");
  expect(offline.exitCode).toBe(0);
  expect(offline.stdout).toContain("Published: 2  Skipped: 0  Failed: 0");
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
