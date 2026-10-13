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
 * The one call the fake hands to the real npm is `pack --dry-run`, which reads
 * the package dir and nothing else: what npm would pack is npm's to say.
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
  mapPool,
  npmErrorCode,
  npmPackList,
  outsideClosure,
  ownershipVerdict,
  packedContentsProblems,
  parsePackJson,
  rerunAdvice,
  toViewResult,
  unmetDependencies,
  versionState,
} from "./publish-workspace";

const SCRIPT = join(import.meta.dir, "publish-workspace.ts");
const DEAD_REGISTRY = "http://127.0.0.1:9/";
const REPO_URL = "git+https://github.com/crewhaus/factory.git";
const V = "0.7.1";

// The pack check asks the real npm what a tarball would hold, so most tests here
// need one. Skipped on a machine without npm, but never in CI: there a missing
// npm fails these tests rather than passing them by skipping.
const REAL_NPM = Bun.which("npm");
const withNpm = test.skipIf(REAL_NPM === null && !process.env.CI);
/** A test that runs the script (and so npm pack) more than once. */
const RUN_BUDGET = 90_000;

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

test("outsideClosure lists every registry lookup the gate may make: the closure outside the run, once each", () => {
  const graph: Record<string, string[]> = {
    "@crewhaus/b": ["@crewhaus/a", "@crewhaus/c"],
    "@crewhaus/c": ["@crewhaus/a", "@crewhaus/in-run"],
    "@crewhaus/a": [],
    "@crewhaus/in-run": ["@crewhaus/never-walked"],
  };
  const depsOf = (name: string) => graph[name] ?? [];
  const cli = { version: V, deps: ["@crewhaus/b", "@crewhaus/in-run"] };
  const ahead = outsideClosure([cli], new Set(["crewhaus", "@crewhaus/in-run"]), depsOf);
  expect(ahead).toEqual([
    { name: "@crewhaus/b", version: V },
    { name: "@crewhaus/a", version: V },
    { name: "@crewhaus/c", version: V },
  ]);
  // Every lookup unmetDependencies makes is one of these, so none is left to
  // make one at a time in the loop.
  const asked: string[] = [];
  unmetDependencies(cli, {
    unavailable: new Set(),
    inRun: new Set(["crewhaus", "@crewhaus/in-run"]),
    registry: (name, version) => {
      asked.push(`${name}@${version}`);
      return { kind: "published" };
    },
    depsOf,
  });
  expect(asked.sort()).toEqual(ahead.map((d) => `${d.name}@${d.version}`).sort());
  // A full run has every dependency in it, so it asks the registry nothing extra.
  expect(outsideClosure([cli], new Set(Object.keys(graph)), depsOf)).toEqual([]);
});

test("mapPool keeps input order and never runs more than its limit at once", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapPool([5, 1, 4, 2, 3], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    // Yield a few turns so the workers interleave; no timer involved.
    for (let i = 0; i < n; i++) await Promise.resolve();
    running--;
    return n * 10;
  });
  expect(out).toEqual([50, 10, 40, 20, 30]);
  expect(peak).toBe(2);
  expect(await mapPool([], 8, async () => 1)).toEqual([]);
});

test("parsePackJson reads npm 8-11's array and npm 12's name-keyed object, and refuses anything else", () => {
  const result = {
    name: "@crewhaus/zz-a",
    files: [{ path: "package.json" }, { path: "dist/index.js" }],
  };
  const paths = ["package.json", "dist/index.js"];
  expect(parsePackJson(JSON.stringify([result]), "@crewhaus/zz-a")).toEqual({ ok: true, paths });
  expect(parsePackJson(JSON.stringify({ "@crewhaus/zz-a": result }), "@crewhaus/zz-a")).toEqual({
    ok: true,
    paths,
  });
  // npm 7 prints the tarball's name, not JSON. "No list" is never "empty list".
  expect(parsePackJson("crewhaus-zz-a-0.7.1.tgz\n", "@crewhaus/zz-a")).toEqual({
    ok: false,
    reason: "npm pack --json printed no JSON (npm before 8 has none)",
  });
  for (const other of [
    [],
    [{ ...result, name: "@crewhaus/other" }],
    [result, result],
    [{ name: "@crewhaus/zz-a" }],
    [{ name: "@crewhaus/zz-a", files: [{ size: 1 }] }],
    { error: { code: "E500" } },
    null,
  ]) {
    expect(parsePackJson(JSON.stringify(other), "@crewhaus/zz-a")).toEqual({
      ok: false,
      reason: "npm pack --json gave no file list for @crewhaus/zz-a",
    });
  }
});

// ─── fixtures ─────────────────────────────────────────────────────────────────

let TMP = "";
let FAKE_BIN = "";

// The fake npm. Reads its behaviour from $FAKE_NPM_CONFIG, appends every call to
// $FAKE_NPM_LOG, and never opens a socket. With `persist`, it is a registry that
// remembers: a publish is recorded in the config file, so a later run sees it,
// and a `viewErrorOnce` entry fires once and is then gone. `pack --dry-run` goes
// to the real npm ($REAL_NPM), which reads only the package dir.
const FAKE_NPM_SOURCE = `
const { spawnSync } = require("node:child_process");
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
if (args[0] === "pack") {
  const pj = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  if ((cfg.failPack || []).includes(pj.name)) fail("EJSONPARSE");
  if (!args.includes("--dry-run")) { process.stderr.write("fake npm: only a dry-run pack\\n"); process.exit(2); }
  const r = spawnSync(process.env.REAL_NPM, args, { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
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
  /** Package names whose `npm pack` fails. */
  failPack?: string[];
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
    REAL_NPM: REAL_NPM ?? "",
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

withNpm(
  "a failed publish is not followed by its dependents, the bare crewhaus CLI included",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "an internal optional dependency that fails blocks its dependent too",
  () => {
    const OPT = { name: "@crewhaus/zz-adapter", dir: "zz-adapter" };
    const cli = { name: "crewhaus", dir: "cli", optionalDeps: { "@crewhaus/zz-adapter": V } };
    const root = makeWorkspace([OPT, cli]);
    const r = run(root, { failPublish: ["@crewhaus/zz-adapter"] });
    expect(r.exitCode).toBe(1);
    expect(publishedNames(r.stdout)).toEqual([]);
    expect(r.stderr).toContain(`crewhaus@${V} (blocked: @crewhaus/zz-adapter`);
  },
  RUN_BUDGET,
);

withNpm(
  "--dry-run shows the same cascade instead of planning the dependents",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "--filter checks a dependency outside the run on the registry: absent or unknown refuses, present publishes",
  () => {
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
    expect(flaky.stderr).toContain(
      "could not check the registry: npm view exited 1 with code E500",
    );

    const present = run(
      root,
      { published: [`@crewhaus/zz-b@${V}`, `@crewhaus/zz-a@${V}`] },
      "--filter",
      "crewhaus",
    );
    expect(present.stderr).toBe("");
    expect(present.exitCode).toBe(0);
    expect(publishedNames(present.stdout)).toEqual(["crewhaus"]);
  },
  RUN_BUDGET,
);

withNpm(
  "--filter checks the whole closure: a dependency's own dependency missing from the registry refuses the package",
  () => {
    // crewhaus -> zz-b -> zz-a; zz-b is on the registry, zz-a is not. The full run
    // holds crewhaus back in this state; --filter used to publish it.
    const root = makeWorkspace([A, B, CLI]);
    const r = run(root, { published: [`@crewhaus/zz-b@${V}`] }, "--filter", "crewhaus");
    expect(r.exitCode).toBe(1);
    expect(r.calls.filter((a) => a[0] === "publish")).toEqual([]);
    expect(r.stderr).toContain(
      `crewhaus@${V} not published: it depends on @crewhaus/zz-a@${V} (not on the registry; needed through @crewhaus/zz-b)`,
    );
    // The closure is asked about up front, a few at a time (so in no fixed order),
    // each member once; then the package itself, in the loop.
    const versionCalls = r.calls
      .filter((a) => a[0] === "view" && a[2] === "version")
      .map((a) => a[1]);
    expect(versionCalls.slice(0, 2).sort()).toEqual([`@crewhaus/zz-a@${V}`, `@crewhaus/zz-b@${V}`]);
    expect(versionCalls.slice(2)).toEqual([`crewhaus@${V}`]);
    // Up front means before the loop: before npm is even asked what it would pack.
    const firstPack = r.calls.findIndex((a) => a[0] === "pack");
    const closureAsked = r.calls.flatMap((a, i) =>
      a[0] === "view" && a[1] !== `crewhaus@${V}` && a[2] === "version" ? [i] : [],
    );
    expect(closureAsked).toHaveLength(2);
    expect(closureAsked.every((i) => i < firstPack)).toBe(true);
    expect(r.stdout).toContain("Published: 0  Skipped: 0  Failed: 1");
  },
  RUN_BUDGET,
);

withNpm(
  "--filter on a package already on the registry whose dependency is not says so, and fails",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "a package already on the registry whose dependency failed still holds back its dependents",
  () => {
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
  },
  RUN_BUDGET,
);

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

withNpm(
  "after a leaf's publish fails, doing what the summary says publishes everything it held back",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "after the registry could not confirm a leaf's owner, doing what the summary says finishes the release",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "a failed --filter run says what --filter will and will not publish, and the full re-run finishes it",
  () => {
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
  },
  RUN_BUDGET,
);

withNpm(
  "a registry that cannot say whether a version exists does not skip it: the publish is tried",
  () => {
    // Ownership was confirmed a moment earlier, and npm refuses to publish over
    // an existing version, so the publish itself is the authoritative check.
    const root = makeWorkspace([D]);
    const r = run(root, { versionError: { [`@crewhaus/zz-d@${V}`]: "E500" } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `could not tell whether @crewhaus/zz-d@${V} is already published: npm view exited 1 with code E500; trying the publish`,
    );
    expect(publishedNames(r.stdout)).toEqual(["@crewhaus/zz-d"]);
  },
  RUN_BUDGET,
);

// ─── the ownership guard, end to end ──────────────────────────────────────────

withNpm(
  "the ownership guard refuses when the registry cannot be read, and passes a clean E404",
  () => {
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
  },
  RUN_BUDGET,
);

// ─── packed contents ──────────────────────────────────────────────────────────

/** What the real npm says it would pack for the package in `dir`. */
async function npmPacks(dir: string): Promise<string[]> {
  const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string };
  const r = await npmPackList(dir, name);
  if (!r.ok) throw new Error(`npm pack failed in ${dir}: ${r.reason}`);
  return [...r.paths];
}

const manifestOf = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

const NOT_IN = "is not in the tarball npm would publish";
const RELEASE_PREP_HINT =
  " — run `release-prep.ts --for-publish`, which puts README.md, LICENSE and NOTICE into every package";
const BUILD_HINT =
  "dist/ is not built — run `bun run build` (tsc -b) before `release-prep.ts --for-publish`";

withNpm(
  "packedContentsProblems names each thing npm's tarball would be missing, and why",
  async () => {
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
    const pkg = (dir: string) => join(root, "packages", dir);
    const problems = async (dir: string) =>
      packedContentsProblems(pkg(dir), manifestOf(pkg(dir)), await npmPacks(pkg(dir)));
    expect(await problems("ok")).toEqual([]);
    expect(await problems("no-license")).toEqual([
      `LICENSE ${NOT_IN}: it is not there${RELEASE_PREP_HINT}`,
    ]);
    expect(await problems("no-readme")).toEqual([
      `README.md ${NOT_IN}: it is not there${RELEASE_PREP_HINT}`,
    ]);
    expect(await problems("no-notice-entry")).toEqual([
      `NOTICE ${NOT_IN}: "files" does not name it, and npm packs NOTICE only then`,
    ]);
    // A literal entry that is not there is named; a glob is npm's to expand.
    expect(await problems("data")).toEqual([`"files" entry "skills" ${NOT_IN}: it is not there`]);
    // npm leaves a symlink out of the tarball.
    symlinkSync(join(pkg("ok"), "NOTICE"), join(pkg("linked"), "NOTICE"));
    expect(await problems("linked")).toEqual([
      `NOTICE ${NOT_IN}: it is a symlink, and npm packs nothing for one`,
    ]);
    // Not built: each entry point is named, then one line that says what to run.
    // (A guard that said so only after the pack check had already refused the
    // package, and so never ran, is gone.)
    rmSync(join(pkg("ok"), "dist"), { recursive: true });
    expect(await problems("ok")).toEqual([
      `entry point "dist/index.js" ${NOT_IN}: "dist" is not there`,
      `"files" entry "dist" ${NOT_IN}: it is not there`,
      BUILD_HINT,
    ]);
  },
  RUN_BUDGET,
);

test("what npm's list holds is the verdict: a `files` glob npm expands is not refused by a reading of it", () => {
  // `dist/**/*.js` packs dist/index.js; tool-pkg's approximate `files` reader
  // does not let `*` cross a `/`, and used to refuse this manifest.
  const root = makeWorkspace([
    {
      name: "@crewhaus/glob",
      dir: "glob",
      files: ["dist/**/*.js", "README.md", "LICENSE", "NOTICE"],
    },
  ]);
  const dir = join(root, "packages", "glob");
  const packed = ["package.json", "README.md", "LICENSE", "NOTICE", "dist/index.js"];
  expect(packedContentsProblems(dir, manifestOf(dir), packed)).toEqual([]);
  // And the same manifest with npm's list lacking the entry point is refused.
  expect(packedContentsProblems(dir, manifestOf(dir), packed.slice(0, 4))).toEqual([
    `entry point "dist/index.js" ${NOT_IN}: npm leaves it out`,
  ]);
});

test("when npm leaves something out, the check says where to look", () => {
  const root = makeWorkspace([
    { name: "@crewhaus/d1", dir: "d1", files: ["dist", "README.md", "LICENSE", "NOTICE/"] },
    { name: "@crewhaus/d2", dir: "d2", files: ["dist", "README.md", "LICENSE", "./NOTICE"] },
    {
      name: "@crewhaus/d3",
      dir: "d3",
      files: ["dist", "!dist/sub.js", "README.md", "LICENSE", "NOTICE"],
    },
    { name: "@crewhaus/d4", dir: "d4" },
    {
      name: "@crewhaus/d5",
      dir: "d5",
      files: ["dist", "assets/data.json", "templates", "README.md", "LICENSE", "NOTICE"],
    },
    { name: "@crewhaus/d6", dir: "d6" },
  ]);
  const pkg = (dir: string) => join(root, "packages", dir);
  const base = ["package.json", "README.md", "LICENSE", "NOTICE", "dist/index.js"];
  const without = (...drop: string[]) => base.filter((p) => !drop.includes(p));
  const problems = (dir: string, packed: string[], manifest = manifestOf(pkg(dir))) =>
    packedContentsProblems(pkg(dir), manifest, packed);

  // A trailing slash on a file: npm 11 packs nothing for it (npm 12 does).
  expect(problems("d1", without("NOTICE"))).toEqual([
    `"files" entry "NOTICE/" ${NOT_IN}: it is not a directory, and a trailing slash in "files" matches only a directory`,
    `NOTICE ${NOT_IN}: npm leaves it out; look at the "files" entry "NOTICE/" (not every npm reads that spelling; write "NOTICE")`,
  ]);
  // A `./` spelling npm 8 does not pack.
  expect(problems("d2", without("NOTICE"))).toEqual([
    `NOTICE ${NOT_IN}: npm leaves it out; look at the "files" entry "./NOTICE" (not every npm reads that spelling; write "NOTICE")`,
  ]);
  // A negation, and an ignore file under the package.
  writeFileSync(join(pkg("d3"), "dist", "sub.js"), "export {};\n");
  const withSub = {
    ...manifestOf(pkg("d3")),
    exports: { ".": "./dist/index.js", "./sub": "./dist/sub.js" },
  };
  expect(problems("d3", base, withSub)).toEqual([
    `entry point "dist/sub.js" ${NOT_IN}: npm leaves it out; look at the "files" entry "!dist/sub.js"`,
  ]);
  writeFileSync(join(pkg("d4"), "dist", "sub.js"), "export {};\n");
  writeFileSync(join(pkg("d4"), "dist", ".npmignore"), "sub.js\n");
  const d4 = { ...manifestOf(pkg("d4")), bin: { zz: "dist/sub.js" } };
  expect(problems("d4", base, d4)).toEqual([
    `entry point "dist/sub.js" ${NOT_IN}: npm leaves it out; look at dist/.npmignore`,
  ]);
  // A symlinked directory on the way (npm packs nothing through it), and an
  // empty directory (npm packs nothing from it).
  mkdirSync(join(pkg("d5"), "real-assets"));
  writeFileSync(join(pkg("d5"), "real-assets", "data.json"), "{}\n");
  symlinkSync("real-assets", join(pkg("d5"), "assets"));
  mkdirSync(join(pkg("d5"), "templates"));
  expect(problems("d5", base)).toEqual([
    `"files" entry "assets/data.json" ${NOT_IN}: "assets" is a symlink, and npm packs nothing through one`,
    `"files" entry "templates" ${NOT_IN}: it is an empty directory`,
  ]);
  // A file no `files` entry covers.
  mkdirSync(join(pkg("d6"), "lib"));
  writeFileSync(join(pkg("d6"), "lib", "x.js"), "export {};\n");
  const d6 = { ...manifestOf(pkg("d6")), module: "lib/x.js" };
  expect(problems("d6", base, d6)).toEqual([
    `entry point "lib/x.js" ${NOT_IN}: npm leaves it out; look at "files" (no entry covers it)`,
  ]);
});

// Each `files` spelling, read by the npm on PATH. The check must agree with it
// on every npm. What npm does is pinned only where npm 8, 11 and 12 agree
// (checked by hand): `./NOTICE` is dropped by npm 8, and `NOTICE/` is packed by
// npm 12 and dropped by 11. The npm that publishes decides, and CI runs the
// release job's npm line for the pack pre-flight.
withNpm(
  "packedContentsProblems agrees with the npm on PATH on every `files` spelling",
  async () => {
    const cases: { entry: string; npmPacksIt?: boolean }[] = [
      { entry: "NOTICE", npmPacksIt: true },
      { entry: "./NOTICE" },
      { entry: "/NOTICE", npmPacksIt: true },
      { entry: "NOTICE/" },
      { entry: "./NOTICE/" },
      { entry: "skills", npmPacksIt: true },
      { entry: "skills/", npmPacksIt: true },
      { entry: "./skills" },
      { entry: "/skills", npmPacksIt: true },
      { entry: "linked", npmPacksIt: false },
      { entry: "linked/", npmPacksIt: false },
      { entry: "linked-file.md", npmPacksIt: false },
    ];
    const root = mkdtempSync(join(TMP, "spell-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", private: true, workspaces: ["p*"] }),
    );
    const dirs = cases.map(({ entry }, i) => {
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
      return dir;
    });
    const lists = await mapPool(dirs, 8, npmPacks);
    for (const [i, { entry, npmPacksIt }] of cases.entries()) {
      const packed = lists[i] ?? [];
      const target = entry.replace(/^\.?\/+/, "").replace(/\/+$/, "");
      const npmPacked = packed.some((p) => p === target || p.startsWith(`${target}/`));
      if (npmPacksIt !== undefined) {
        expect({ entry, npmPacked }).toEqual({ entry, npmPacked: npmPacksIt });
      }
      const problems = packedContentsProblems(
        dirs[i] as string,
        manifestOf(dirs[i] as string),
        packed,
      );
      expect({ entry, accepted: problems.length === 0 }).toEqual({ entry, accepted: npmPacked });
    }
  },
  RUN_BUDGET,
);

// The spellings a reading of the manifest let through while npm dropped the
// file, and a glob it refused while npm packed it. Real npm decides each one.
withNpm(
  "a file npm drops is refused, however it came to be dropped, and a glob npm expands is not",
  async () => {
    type Case = {
      label: string;
      /** Paths the package declares; the check must refuse iff npm drops one. */
      want: string[];
      /** Part of the reason, when npm dropped something. */
      why: string;
      /** Whether npm 8, 11 and 12 all drop one (undefined: they differ). */
      npmDrops?: boolean;
      setup: (dir: string) => Record<string, unknown>;
    };
    const std = (extra: Record<string, unknown> = {}) => ({
      name: "@crewhaus/zz",
      version: V,
      main: "dist/index.js",
      files: ["dist", "README.md", "LICENSE", "NOTICE"],
      ...extra,
    });
    const subExport = { exports: { ".": "./dist/index.js", "./sub": "./dist/sub.js" } };
    const cases: Case[] = [
      {
        label: "an ignore-everything dist/.gitignore",
        want: ["dist/index.js", "dist/sub.js"],
        why: "look at dist/.gitignore",
        setup: (d) => {
          writeFileSync(join(d, "dist", "sub.js"), "x\n");
          writeFileSync(join(d, "dist", ".gitignore"), "*\n");
          return std(subExport);
        },
      },
      {
        label: "a dist/.npmignore naming an export target",
        want: ["dist/sub.js"],
        why: "look at dist/.npmignore",
        npmDrops: true,
        setup: (d) => {
          writeFileSync(join(d, "dist", "sub.js"), "x\n");
          writeFileSync(join(d, "dist", ".npmignore"), "sub.js\n");
          return std(subExport);
        },
      },
      {
        label: "a negated `files` entry",
        want: ["dist/sub.js"],
        why: 'look at the "files" entry "!dist/sub.js"',
        npmDrops: true,
        setup: (d) => {
          writeFileSync(join(d, "dist", "sub.js"), "x\n");
          return std({
            ...subExport,
            files: ["dist", "!dist/sub.js", "README.md", "LICENSE", "NOTICE"],
          });
        },
      },
      {
        label: "a symlinked export target",
        want: ["dist/sub.js"],
        why: "it is a symlink",
        npmDrops: true,
        setup: (d) => {
          writeFileSync(join(d, "dist", "real-sub.js"), "x\n");
          symlinkSync("real-sub.js", join(d, "dist", "sub.js"));
          return std(subExport);
        },
      },
      {
        label: "a symlinked bin target",
        want: ["dist/cli.js"],
        why: "it is a symlink",
        npmDrops: true,
        setup: (d) => {
          writeFileSync(join(d, "dist", "real-cli.js"), "x\n");
          symlinkSync("real-cli.js", join(d, "dist", "cli.js"));
          return std({ bin: { zz: "dist/cli.js" } });
        },
      },
      {
        label: "a literal entry under a symlinked directory",
        want: ["assets/data.json"],
        why: '"assets" is a symlink',
        setup: (d) => {
          mkdirSync(join(d, "real-assets"));
          writeFileSync(join(d, "real-assets", "data.json"), "{}\n");
          symlinkSync("real-assets", join(d, "assets"));
          return std({ files: ["dist", "assets/data.json", "README.md", "LICENSE", "NOTICE"] });
        },
      },
      {
        label: "a `**` glob",
        want: ["dist/index.js", "dist/sub/x.js"],
        why: "",
        npmDrops: false,
        setup: (d) => {
          mkdirSync(join(d, "dist", "sub"));
          writeFileSync(join(d, "dist", "sub", "x.js"), "x\n");
          return std({ files: ["dist/**/*.js", "README.md", "LICENSE", "NOTICE"] });
        },
      },
    ];
    const root = mkdtempSync(join(TMP, "dropped-"));
    const dirs = cases.map((c, i) => {
      const dir = join(root, `c${i}`);
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
      for (const f of ["README.md", "LICENSE", "NOTICE"]) writeFileSync(join(dir, f), `${f}\n`);
      writeFileSync(join(dir, "package.json"), JSON.stringify(c.setup(dir)));
      return dir;
    });
    const lists = await mapPool(dirs, 8, npmPacks);
    let refused = 0;
    for (const [i, c] of cases.entries()) {
      const packed = lists[i] ?? [];
      const dropped = c.want.filter((w) => !packed.includes(w));
      if (c.npmDrops !== undefined) {
        expect({ case: c.label, npmDrops: dropped.length > 0 }).toEqual({
          case: c.label,
          npmDrops: c.npmDrops,
        });
      }
      const problems = packedContentsProblems(
        dirs[i] as string,
        manifestOf(dirs[i] as string),
        packed,
      );
      expect({ case: c.label, refused: problems.length > 0 }).toEqual({
        case: c.label,
        refused: dropped.length > 0,
      });
      for (const d of dropped) {
        expect(problems.some((p) => p.includes(`"${d}"`) && p.includes(c.why))).toBe(true);
      }
      if (problems.length > 0) refused++;
    }
    // Not vacuous: at least the drops every npm makes were refused (npm 11 and
    // 12 drop all six; npm 8 packs `main` whatever an ignore file says, and
    // packs through a symlinked directory).
    expect(refused).toBeGreaterThanOrEqual(cases.filter((c) => c.npmDrops === true).length);
    expect(cases.filter((c) => c.npmDrops === true)).toHaveLength(4);
  },
  RUN_BUDGET,
);

withNpm(
  "a package whose tarball would miss LICENSE fails the --dry-run pre-flight, and its dependents with it",
  () => {
    const root = makeWorkspace([{ ...A, omit: ["LICENSE"] }, B]);
    const r = run(root, {}, "--dry-run");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `✗ @crewhaus/zz-a (packages/zz-a): LICENSE ${NOT_IN}: it is not there`,
    );
    expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
    expect(r.stdout).toContain("Published: 0  Skipped: 0  Failed: 2");
  },
  RUN_BUDGET,
);

withNpm(
  "an unbuilt package is refused with one line that says to build, and its dependents with it",
  () => {
    const root = makeWorkspace([A, B]);
    rmSync(join(root, "packages", "zz-a", "dist"), { recursive: true });
    const r = run(root, {}, "--dry-run", "--no-registry");
    expect(r.exitCode).toBe(1);
    expect(r.stderr.split("\n").filter((l) => l.endsWith(BUILD_HINT))).toEqual([
      `✗ @crewhaus/zz-a (packages/zz-a): ${BUILD_HINT}`,
    ]);
    expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
  },
  RUN_BUDGET,
);

withNpm(
  "a package npm cannot pack is refused with npm's reason, and its dependents with it",
  () => {
    const root = makeWorkspace([A, B, D]);
    const r = run(root, { failPack: ["@crewhaus/zz-a"] }, "--dry-run", "--no-registry");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "✗ @crewhaus/zz-a (packages/zz-a): could not list what npm would pack (npm pack exited 1 with code EJSONPARSE) — refusing, since nothing says what it would carry",
    );
    expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
    expect(r.stdout).toContain("Published: 1  Skipped: 0  Failed: 2");
  },
  RUN_BUDGET,
);

withNpm(
  "--dry-run --no-registry never asks the registry, still checks packed contents and the plan, and says ownership was not checked",
  () => {
    const root = makeWorkspace([{ ...A, omit: ["NOTICE"] }, B, D]);
    const r = run(root, {}, "--dry-run", "--no-registry");
    // npm is asked what it would pack, once per package, and nothing else.
    const registryFree = (calls: string[][]) =>
      calls.filter((a) => a[0] !== "--version" && a[0] !== "pack");
    expect(registryFree(r.calls)).toEqual([]);
    expect(r.calls.filter((a) => a[0] === "pack")).toHaveLength(3);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Registry not consulted (--no-registry): ownership is NOT checked.");
    expect(r.stderr).toContain(
      `✗ @crewhaus/zz-a (packages/zz-a): NOTICE ${NOT_IN}: it is not there`,
    );
    expect(r.stderr).toContain(`@crewhaus/zz-b@${V} (blocked: @crewhaus/zz-a`);
    expect(r.stdout).toContain("Published: 1  Skipped: 0  Failed: 2");

    // A dependency outside the run cannot be confirmed without the registry.
    const filtered = run(root, {}, "--dry-run", "--no-registry", "--filter", "@crewhaus/zz-b");
    expect(registryFree(filtered.calls)).toEqual([]);
    expect(filtered.exitCode).toBe(1);
    expect(filtered.stderr).toContain(
      `@crewhaus/zz-a@${V} (could not check the registry: --no-registry)`,
    );

    // And a real publish refuses the flag outright, before running anything.
    const real = run(root, {}, "--no-registry");
    expect(real.exitCode).toBe(1);
    expect(real.stderr).toContain("--no-registry is a --dry-run option");
    expect(real.calls).toEqual([]);
  },
  RUN_BUDGET,
);

test("with no npm on PATH every form stops once and says so", () => {
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
    "✗ npm could not be run (ENOENT). Every run needs npm on PATH: it is what says what each tarball would carry.\n";
  // --no-registry too: without npm nothing can say what a tarball would hold,
  // and "could not ask" must not pass as "carries everything".
  for (const flags of [["--dry-run"], [], ["--dry-run", "--no-registry"]]) {
    const r = go(...flags);
    expect({ flags, exitCode: r.exitCode, stderr: r.stderr }).toEqual({
      flags,
      exitCode: 1,
      stderr: noNpm,
    });
    // Once, before any package — not a complaint per package.
    expect(r.stdout).not.toContain("→ publishing");
  }
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

withNpm(
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
