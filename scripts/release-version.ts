#!/usr/bin/env bun
/**
 * release-version.ts — what kind of release a version is, and whether this tree may
 * publish it. The release workflow's first step runs it, so every later job reads one
 * answer instead of each testing the version string its own way.
 *
 *   - A version is `X.Y.Z` (a final release) or `X.Y.Z-rc.N` (a release candidate),
 *     anchored, with no leading zeros. Anything else stops the release.
 *   - A release candidate publishes to npm under the `next` dist tag and as a GitHub
 *     pre-release; the package-manager channels skip it. The npm job stamps every
 *     package with the candidate's version, so the tree's own stamp is not checked.
 *   - A final version publishes only from a tree whose publishable manifests are all
 *     stamped with it: the bump lands on main through a PR before the tag. This holds
 *     on a dry run too, so a dry run of a final version fails where the real run would.
 *
 * Run:
 *   bun scripts/release-version.ts --version 0.9.0-rc.1 --homepage https://github.com/crewhaus/factory \
 *     [--dry-run true|false|""] [--github-output "$GITHUB_OUTPUT"] [--root <dir>]
 *
 * Writes `version=`, `prerelease=true|false`, `dry_run=true|false` and
 * `download_base_url=<homepage>/releases/download/v<version>` to stdout, and appends
 * them to the --github-output file when one is given. An empty --dry-run (a tag push
 * has no dispatch inputs) means false. Exits 1 on an invalid version, and on a final
 * version the tree is not stamped with.
 *
 * Imports only node:* and ./publishable.ts (which imports nothing): the workflow runs
 * this before `bun install`.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { isPublishableName } from "./publishable.ts";

export type ReleaseVersion =
  | {
      readonly ok: true;
      readonly version: string;
      readonly prerelease: boolean;
      /** `next` for a release candidate; a final version publishes under npm's default. */
      readonly distTag: "next" | undefined;
    }
  | { readonly ok: false; readonly reason: string };

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;

const FORMS = "a release version is X.Y.Z or X.Y.Z-rc.N, with no leading zeros";

/** Parse a release version, or say why it is not one. */
export function parseReleaseVersion(raw: string): ReleaseVersion {
  if (raw === "") return { ok: false, reason: `no version was given; ${FORMS}` };
  const match = RELEASE_VERSION.exec(raw);
  if (match !== null) {
    const prerelease = match[4] !== undefined;
    return { ok: true, version: raw, prerelease, distTag: prerelease ? "next" : undefined };
  }
  if (/^v\d/.test(raw)) {
    return {
      ok: false,
      reason: `"${raw}" starts with "v"; give the version without it (${FORMS})`,
    };
  }
  if (/^\d+\.\d+\.\d+-(?!rc\.)/.test(raw)) {
    return {
      ok: false,
      reason: `"${raw}" has a prerelease part other than -rc.N, the only one a release takes (${FORMS})`,
    };
  }
  return { ok: false, reason: `"${raw}" is not a release version: ${FORMS}` };
}

export type StampMismatch = {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
};

/** Workspace package directories from the root manifest's `workspaces` globs. */
function workspaceDirs(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: unknown;
  };
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces.filter((p): p is string => typeof p === "string")
    : [];
  const dirs: string[] = [];
  const isPackage = (dir: string): boolean => {
    try {
      return statSync(dir).isDirectory() && existsSync(join(dir, "package.json"));
    } catch {
      return false; // a dangling link is no package
    }
  };
  for (const pattern of patterns) {
    const star = pattern === "*" || pattern.endsWith("/*");
    const base = join(root, pattern === "*" ? "" : star ? pattern.slice(0, -2) : pattern);
    if (!existsSync(base)) continue;
    if (!star) {
      if (isPackage(base)) dirs.push(base);
      continue;
    }
    for (const entry of readdirSync(base).sort()) {
      const dir = join(base, entry);
      if (isPackage(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Every workspace manifest release-prep stamps (by name, so a committed
 * `private: true` `@crewhaus/x`, which the release publishes, is covered) whose
 * version is not `version`. `dir` is relative to `root`.
 */
export function stampMismatches(root: string, version: string): StampMismatch[] {
  const out: StampMismatch[] = [];
  for (const dir of workspaceDirs(root)) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (!isPublishableName(pkg.name)) continue;
    if (pkg.version === version) continue;
    out.push({
      dir: relative(root, dir),
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : String(pkg.version),
    });
  }
  return out;
}

/** How many mismatches the refusal names before it says how many more there are. */
const SHOWN = 10;

type Cli = {
  readonly version: string | undefined;
  readonly homepage: string | undefined;
  readonly dryRun: string | undefined;
  readonly githubOutput: string | undefined;
  readonly root: string;
};

function parseArgs(argv: readonly string[]): Cli {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    version: flag("version"),
    homepage: flag("homepage"),
    dryRun: flag("dry-run"),
    githubOutput: flag("github-output"),
    root: resolve(flag("root") ?? process.cwd()),
  };
}

/** Run the CLI; returns the exit code. Output goes through `out` and `err`. */
export function main(
  argv: readonly string[],
  out: (line: string) => void = (l) => console.log(l),
  err: (line: string) => void = (l) => console.error(l),
): 0 | 1 {
  const cli = parseArgs(argv);
  if (cli.homepage === undefined || cli.homepage === "") {
    err("✗ --homepage <url> is required: the download links are built from it.");
    return 1;
  }
  const dryRunFlag = cli.dryRun ?? "";
  if (dryRunFlag !== "" && dryRunFlag !== "true" && dryRunFlag !== "false") {
    err(`✗ --dry-run is "${dryRunFlag}"; it takes true, false or nothing.`);
    return 1;
  }
  const parsed = parseReleaseVersion(cli.version ?? "");
  if (!parsed.ok) {
    if (cli.githubOutput !== undefined) err(`::error::${parsed.reason}`);
    err(`✗ ${parsed.reason}`);
    return 1;
  }
  const { version, prerelease } = parsed;
  if (prerelease) {
    out(
      `${version} is a release candidate: the tree's stamped version is not checked, because the npm job stamps every package with ${version} before it publishes.`,
    );
  } else {
    const mismatches = stampMismatches(cli.root, version);
    if (mismatches.length > 0) {
      const headline = `${version} is a final version, but ${mismatches.length} publishable manifest(s) are not stamped ${version}, so this tree cannot publish it.`;
      if (cli.githubOutput !== undefined) err(`::error::${headline}`);
      err(`✗ ${headline}`);
      for (const m of mismatches.slice(0, SHOWN)) err(`  ${m.dir} (${m.name}) is ${m.version}`);
      if (mismatches.length > SHOWN) err(`  … and ${mismatches.length - SHOWN} more`);
      err(
        `  Fix: run \`bun scripts/release-prep.ts --version ${version}\`, land the bump on main through a PR, then tag v${version}.`,
      );
      return 1;
    }
    out(`${version}: every publishable manifest is stamped ${version}.`);
  }
  const lines = [
    `version=${version}`,
    `prerelease=${prerelease}`,
    `dry_run=${dryRunFlag === "true"}`,
    `download_base_url=${cli.homepage}/releases/download/v${version}`,
  ];
  for (const line of lines) out(line);
  if (cli.githubOutput !== undefined && cli.githubOutput !== "") {
    // Appended, never replaced: an earlier step's outputs in the same file survive.
    const fd = openSync(cli.githubOutput, "a");
    try {
      writeSync(fd, `${lines.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
