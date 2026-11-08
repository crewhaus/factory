#!/usr/bin/env bun
/**
 * node-load-smoke.ts — load every Node-loadable package from its packed tarball
 * under real `node`, the way a Node project that installs it would.
 *
 * A package is Node-loadable when its committed package.json declares
 * `engines.node` (scripts/node-packages.test.ts holds its source to the rules).
 * This is the other half: for each such package of a tree already built
 * (`bun run build`) and stamped (`release-prep.ts --for-publish`), it
 *
 *   1. packs the package and its internal closure with `npm pack`;
 *   2. writes a temp project (`"type": "module"`) whose `dependencies` and
 *      `overrides` name every closure package by its `file:` tarball, and runs
 *      `npm install` there;
 *   3. imports every `exports` subpath with
 *      `node --input-type=module -e "await import('<name><subpath>')"`;
 *   4. type-checks a NodeNext consumer that imports each subpath, with the
 *      workspace's own TypeScript (`node_modules/typescript/bin/tsc`).
 *
 * One line per package, then a total; exit 1 when any package fails, naming the
 * step. With no Node-loadable package it says so and exits 0.
 *
 * Every npm call runs with an environment built from scratch: no user or global
 * npmrc, a private cache, no token. Temp work lives in one mkdtemp directory that
 * is removed afterwards.
 *
 * Run (CI runs it right after the pack pre-flight):
 *   bun scripts/node-load-smoke.ts [--root <dir>] [--offline]
 *
 * `--offline` installs from the tarballs and the cache only; the tests use it.
 * Without it a third-party dependency of a Node package is fetched from the
 * registry.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Manifest = {
  readonly name?: string;
  readonly engines?: Record<string, unknown>;
  readonly exports?: unknown;
  readonly main?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

export type WorkspacePackage = {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Manifest;
};

const SHIPPING_BLOCKS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

/** The TypeScript the workspace builds with; a Node consumer's compiler, here. */
const TSC = join(import.meta.dir, "..", "node_modules", "typescript", "bin", "tsc");

/** Does this manifest declare the Node-loadable class? */
export function declaresNode(m: Manifest): boolean {
  const node = m.engines?.["node"];
  return typeof node === "string" && node.trim() !== "";
}

/** Every named workspace package under `root`, by its root manifest's `workspaces`. */
export function workspacePackages(root: string): WorkspacePackage[] {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces.filter((p): p is string => typeof p === "string")
    : [];
  const out: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    const star = pattern.endsWith("/*");
    const base = join(root, star ? pattern.slice(0, -2) : pattern);
    if (!existsSync(base)) continue;
    const dirs = star
      ? readdirSync(base)
          .sort()
          .map((e) => join(base, e))
      : [base];
    for (const dir of dirs) {
      const file = join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      if (typeof manifest.name === "string") out.push({ name: manifest.name, dir, manifest });
    }
  }
  return out;
}

/** The package and every workspace package it reaches through its shipping dependencies. */
export function closureOf(
  pkg: WorkspacePackage,
  byName: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage[] {
  const seen = new Map<string, WorkspacePackage>();
  const visit = (p: WorkspacePackage): void => {
    if (seen.has(p.name)) return;
    seen.set(p.name, p);
    for (const block of SHIPPING_BLOCKS) {
      for (const dep of Object.keys(p.manifest[block] ?? {})) {
        const next = byName.get(dep);
        if (next !== undefined) visit(next);
      }
    }
  };
  visit(pkg);
  return [...seen.values()];
}

/** The import specifier of every `exports` subpath: `.` is the name itself. */
export function exportSpecifiers(name: string, exports: unknown): string[] {
  if (exports === undefined || exports === null || typeof exports !== "object") return [name];
  const keys = Object.keys(exports as Record<string, unknown>);
  // A conditions object at the top (`{ import, types }`) is the `.` entry alone.
  if (!keys.some((k) => k.startsWith("."))) return [name];
  return keys
    .filter((k) => !k.includes("*") && k !== "./package.json")
    .map((k) => (k === "." ? name : `${name}${k.slice(1)}`));
}

type Step = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function runStep(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Step {
  const r = spawnSync(cmd, [...args], { cwd, env, encoding: "utf8" });
  if (r.error !== undefined) {
    return {
      status: null,
      stdout: "",
      stderr: `${cmd} could not be run (${(r.error as { code?: string }).code ?? r.error.message})`,
    };
  }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The last lines of a failed step's output, short enough for one log line. */
function tail(step: Step): string {
  const text = `${step.stderr}\n${step.stdout}`.trim();
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const last = lines.slice(-6).join(" | ");
  return last.length > 800 ? `${last.slice(0, 800)}…` : last || `exit ${step.status}`;
}

export type SmokeResult =
  | { readonly ok: true; readonly specifiers: readonly string[] }
  | { readonly ok: false; readonly step: string; readonly detail: string };

/** Pack, install, import and type-check one Node package inside `work`. */
export function smokePackage(
  pkg: WorkspacePackage,
  byName: ReadonlyMap<string, WorkspacePackage>,
  work: string,
  opts: { readonly offline: boolean },
): SmokeResult {
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "user-npmrc"), "");
  writeFileSync(join(home, "global-npmrc"), "");
  // Built from scratch: nothing from the caller's npm configuration or credentials.
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    npm_config_userconfig: join(home, "user-npmrc"),
    npm_config_globalconfig: join(home, "global-npmrc"),
    npm_config_cache: join(home, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };

  const tarballs = join(work, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  const files: Record<string, string> = {};
  for (const member of closureOf(pkg, byName)) {
    const packed = runStep(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", tarballs],
      member.dir,
      env,
    );
    let filename: unknown;
    try {
      filename = (JSON.parse(packed.stdout) as Array<{ filename?: unknown }>)[0]?.filename;
    } catch {
      filename = undefined;
    }
    if (packed.status !== 0 || typeof filename !== "string") {
      return { ok: false, step: `pack ${member.name}`, detail: tail(packed) };
    }
    files[member.name] = `file:${join(tarballs, filename)}`;
  }

  const project = join(work, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "node-load-smoke",
        private: true,
        type: "module",
        dependencies: files,
        overrides: files,
      },
      null,
      2,
    )}\n`,
  );
  const install = runStep(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      ...(opts.offline ? ["--offline"] : []),
    ],
    project,
    env,
  );
  if (install.status !== 0) return { ok: false, step: "install", detail: tail(install) };

  const specifiers = exportSpecifiers(pkg.name, pkg.manifest.exports);
  for (const spec of specifiers) {
    const loaded = runStep(
      "node",
      ["--input-type=module", "-e", `await import(${JSON.stringify(spec)});`],
      project,
      env,
    );
    if (loaded.status !== 0) return { ok: false, step: `import ${spec}`, detail: tail(loaded) };
  }

  writeFileSync(
    join(project, "consumer.ts"),
    `${specifiers.map((s, i) => `import * as m${i} from ${JSON.stringify(s)};`).join("\n")}\nexport { ${specifiers.map((_, i) => `m${i}`).join(", ")} };\n`,
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          lib: ["ES2022", "DOM"],
          types: [],
          strict: true,
          noEmit: true,
        },
        files: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  if (!existsSync(TSC)) {
    return { ok: false, step: "type-check", detail: `no TypeScript at ${TSC}; run bun install` };
  }
  const checked = runStep("node", [TSC, "--noEmit", "-p", project], project, env);
  if (checked.status !== 0) return { ok: false, step: "type-check", detail: tail(checked) };
  return { ok: true, specifiers };
}

/** Run the smoke over `root`; returns the exit code. */
export function main(
  argv: readonly string[],
  log: (line: string) => void = (l) => console.log(l),
): 0 | 1 {
  const i = argv.indexOf("--root");
  const root = resolve(i >= 0 ? (argv[i + 1] ?? ".") : process.cwd());
  const offline = argv.includes("--offline");
  const all = workspacePackages(root);
  const byName = new Map(all.map((p) => [p.name, p]));
  const nodePackages = all.filter((p) => declaresNode(p.manifest));
  if (nodePackages.length === 0) {
    log("No package declares engines.node yet; nothing to load.");
    return 0;
  }
  const version = runStep("node", ["--version"], root, { PATH: process.env["PATH"] ?? "" });
  const nodeVersion = version.status === 0 ? version.stdout.trim() : "(unknown version)";
  let failed = 0;
  for (const pkg of nodePackages) {
    const work = mkdtempSync(join(tmpdir(), "node-load-smoke-"));
    try {
      const r = smokePackage(pkg, byName, work, { offline });
      if (r.ok) {
        log(
          `✓ ${pkg.name} loads under node ${nodeVersion} (${r.specifiers.length} entry point(s)) and type-checks`,
        );
      } else {
        failed += 1;
        log(`✗ ${pkg.name}: ${r.step} failed: ${r.detail}`);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  log(
    `Node load smoke: ${nodePackages.length - failed} of ${nodePackages.length} package(s) load and type-check on plain Node.`,
  );
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
