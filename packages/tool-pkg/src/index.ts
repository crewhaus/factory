/**
 * @crewhaus/tool-pkg — packaging, lockfiles and releases.
 *
 * These answer questions about a dependency tree and about what a publish
 * would actually ship. Each of them is otherwise answered by reading a large
 * mechanical file — a lockfile, a tarball listing, a few thousand tiny
 * package.json files — and reading those into a context window to answer a
 * one-line question is the waste this package exists to remove.
 *
 * Paths are read, never written. Every caller-supplied path goes through the
 * same containment resolver the other filesystem packages use, so a symlink
 * pointing out of the workspace is refused rather than followed.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type LockedVersion,
  parseBunLock,
  parseCargoLock,
  parsePackageLock,
  parseYarnLock,
} from "@crewhaus/tool-code";
import { z } from "zod";
import { type LicenseFinding, declaredLicense, splitExpression, summarize } from "./lib/license";
import { diffLocks } from "./lib/lockdiff";
import { type PreflightProbe, preflight } from "./lib/preflight";
import { resolveRange } from "./lib/resolve";
import { listTar } from "./lib/tar";
import { archiveEntryEscapes, isInside, resolveSafe, workspaceRoot } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

/** Ceilings that keep one pathological input from becoming a hang. */
const LIMITS = {
  /** A lockfile this size is not a lockfile. */
  lockBytes: 64 * 1024 * 1024,
  tarballBytes: 512 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  packages: 20_000,
  versions: 5_000,
} as const;

function readCapped(abs: string, limit: number, what: string): Buffer {
  const size = statSync(abs).size;
  if (size > limit) {
    throw new Error(`${what} is ${size} bytes, over the ${limit}-byte limit — narrow the input`);
  }
  return readFileSync(abs);
}

/** Pick a lockfile parser from the filename, since the formats are distinct. */
function parseLock(name: string, text: string): LockedVersion[] {
  const base = name.toLowerCase();
  if (base.endsWith("bun.lock") || base.endsWith("bun.lockb")) return parseBunLock(text);
  if (base.endsWith("package-lock.json") || base.endsWith("npm-shrinkwrap.json")) {
    return parsePackageLock(text);
  }
  if (base.endsWith("yarn.lock") || base.endsWith("pnpm-lock.yaml")) return parseYarnLock(text);
  if (base.endsWith("cargo.lock")) return parseCargoLock(text);
  throw new Error(
    `cannot tell what kind of lockfile "${name}" is — expected bun.lock, package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml or Cargo.lock`,
  );
}

// ---------------------------------------------------------------------------

export const semverResolve: RegisteredTool = buildTool({
  name: "SemverResolve",
  description:
    "Resolve a version range against a list of versions: which satisfy it, and which one an install would pick. Use it to answer 'does the fix in 2.4.1 land inside our range?' or 'what would this upgrade actually install?' without a model guessing at caret and tilde semantics. Prereleases are excluded unless the range itself names one, matching npm, and a range the grammar does not understand is reported as such rather than as 'nothing matched'.",
  inputSchema: z.object({
    range: z.string().min(1).describe("a version range, e.g. ^1.2.0, ~2.1, >=3 <4, 1.x"),
    versions: z
      .array(z.string())
      .min(1)
      .max(LIMITS.versions)
      .describe("the versions available, in any order"),
    includePrerelease: z.boolean().optional().describe("consider prereleases; off by default"),
    strategy: z
      .enum(["highest", "lowest"])
      .optional()
      .describe("highest (default) is what a fresh install picks"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = resolveRange(input.range, input.versions, {
      includePrerelease: input.includePrerelease,
      strategy: input.strategy,
    });
    if (!result.rangeUnderstood) {
      return `the range "${input.range}" was not understood as a version range — workspace:, file:, link:, git: and URL specifiers are not version ranges`;
    }
    return json(result);
  },
});

export const lockfileDiff: RegisteredTool = buildTool({
  name: "LockfileDiff",
  description:
    "Compare two lockfiles and report what was added, removed and moved, with each move classified as major, minor, patch, prerelease or downgrade. Use it to review a dependency bump: the version-control diff is thousands of lines of integrity hashes, and the question is always the same four counts. Reads the files itself, so neither lockfile enters the context window. Supports bun.lock, package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml and Cargo.lock.",
  inputSchema: z.object({
    before: z.string().min(1).describe("workspace-relative path to the earlier lockfile"),
    after: z.string().min(1).describe("workspace-relative path to the later lockfile"),
    onlyChanged: z
      .boolean()
      .optional()
      .describe("drop the added and removed lists, keep the counts"),
    limit: z.number().int().positive().max(5_000).optional().describe("cap each list; default 200"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = resolveSafe("LockfileDiff", input.before);
    const b = resolveSafe("LockfileDiff", input.after);
    const before = parseLock(a.rel, readCapped(a.real, LIMITS.lockBytes, a.rel).toString("utf-8"));
    const after = parseLock(b.rel, readCapped(b.real, LIMITS.lockBytes, b.rel).toString("utf-8"));
    const diff = diffLocks(before, after);
    const limit = input.limit ?? 200;
    const body = {
      before: a.rel,
      after: b.rel,
      counts: diff.counts,
      unchanged: diff.unchanged,
      changed: diff.changed.slice(0, limit),
      ...(input.onlyChanged
        ? {}
        : { added: diff.added.slice(0, limit), removed: diff.removed.slice(0, limit) }),
      truncated:
        diff.changed.length > limit || diff.added.length > limit || diff.removed.length > limit,
    };
    return json(body);
  },
});

export const licenseAggregate: RegisteredTool = buildTool({
  name: "LicenseAggregate",
  description:
    "Roll up the declared licenses of an installed dependency tree: counts per identifier, everything copyleft, everything that declares nothing, and anything a declared policy forbids. Use it before a release instead of reading a few thousand package.json files. It reports what packages declare — it does not read license texts, so a package declaring MIT while shipping otherwise is reported as MIT. OR expressions are treated as alternatives and AND as cumulative, which is what decides whether a deny rule bites.",
  inputSchema: z.object({
    directory: z
      .string()
      .optional()
      .describe("workspace-relative directory holding node_modules; defaults to the root"),
    deny: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('identifiers or prefixes to forbid, e.g. ["AGPL", "SSPL", "GPL-3.0"]'),
    allow: z
      .array(z.string())
      .max(200)
      .optional()
      .describe("when set, anything outside this list is a violation"),
    listPackages: z.boolean().optional().describe("include every package, not just the exceptions"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const root = resolveSafe("LicenseAggregate", input.directory ?? ".");
    const modules = join(root.real, "node_modules");
    let names: string[];
    try {
      names = readdirSync(modules);
    } catch {
      return `no node_modules directory under "${root.rel}" — install dependencies first, since this reports what is actually installed rather than what is declared`;
    }

    const findings: LicenseFinding[] = [];
    const root_ = workspaceRoot();
    let escaped = 0;
    const visit = (dir: string, label: string): void => {
      if (findings.length >= LIMITS.packages) return;
      // A node_modules entry is very often a symlink — that is how pnpm and
      // workspace protocols work — and one may point out of the workspace.
      // Links that stay inside are followed, which is what makes a workspace
      // tree readable at all; one that leaves is skipped and counted, never
      // read, because the containment boundary is the whole promise here.
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        return;
      }
      if (!isInside(root_, real)) {
        escaped += 1;
        return;
      }
      let manifest: Record<string, unknown>;
      try {
        const raw = readFileSync(join(real, "package.json"), "utf-8");
        manifest = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      const license = declaredLicense(manifest);
      findings.push({
        name: typeof manifest["name"] === "string" ? (manifest["name"] as string) : label,
        version: typeof manifest["version"] === "string" ? (manifest["version"] as string) : "",
        license,
        identifiers: license === "" ? [] : splitExpression(license),
      });
    };

    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const full = join(modules, name);
      // A scope directory holds packages; it is not one itself.
      if (name.startsWith("@")) {
        let scoped: string[];
        try {
          scoped = readdirSync(full).sort();
        } catch {
          continue;
        }
        for (const inner of scoped) visit(join(full, inner), `${name}/${inner}`);
        continue;
      }
      visit(full, name);
    }

    const report = summarize(findings, { deny: input.deny, allow: input.allow });
    return json({
      directory: root.rel,
      ...report,
      ...(input.listPackages ? { all: findings } : {}),
      ...(escaped > 0 ? { skippedOutsideWorkspace: escaped } : {}),
      capped: findings.length >= LIMITS.packages,
    });
  },
});

export const packageTarballInspect: RegisteredTool = buildTool({
  name: "PackageTarballInspect",
  description:
    "List what is actually inside a package tarball: every member, its size, the total, and anything that should not be there. Use it as the authoritative answer to 'is the build output in the published artifact?' — a question that source, tests and the files field can all answer wrongly. It lists and never extracts, so nothing is written anywhere, and hostile member names are reported exactly as stored rather than resolved.",
  inputSchema: z.object({
    file: z.string().min(1).describe("workspace-relative path to a .tgz or .tar"),
    expect: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('paths that must be present, e.g. ["package/dist/index.js"]; prefixes match'),
    listFiles: z.boolean().optional().describe("include the full member list"),
    limit: z.number().int().positive().max(10_000).optional().describe("cap the list; default 500"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const at = resolveSafe("PackageTarballInspect", input.file);
    const listing = listTar(new Uint8Array(readCapped(at.real, LIMITS.tarballBytes, at.rel)));
    const files = listing.entries.filter((e) => e.type === "file");
    const totalBytes = files.reduce((sum, e) => sum + e.size, 0);

    // Member names that would escape their destination if anything ever
    // extracted this, plus links — a link member is how an archive reaches a
    // file it does not contain. Reported, never resolved.
    const suspicious = listing.entries
      .filter((e) => archiveEntryEscapes(e.name) || e.type === "symlink" || e.type === "hardlink")
      .map((e) => ({ name: e.name, type: e.type, linkname: e.linkname }));

    const missing = (input.expect ?? []).filter(
      (want) => !listing.entries.some((e) => e.name === want || e.name.startsWith(`${want}/`)),
    );

    const limit = input.limit ?? 500;
    const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 10);

    return json({
      file: at.rel,
      entries: listing.entries.length,
      files: files.length,
      directories: listing.entries.filter((e) => e.type === "directory").length,
      totalBytes,
      truncated: listing.truncated,
      capped: listing.capped,
      ...(missing.length > 0 ? { missing } : {}),
      ...(suspicious.length > 0 ? { suspicious } : {}),
      biggest: biggest.map((e) => ({ name: e.name, size: e.size })),
      ...(input.listFiles
        ? {
            members: listing.entries
              .slice(0, limit)
              .map((e) => ({ name: e.name, size: e.size, type: e.type })),
            listTruncated: listing.entries.length > limit,
          }
        : {}),
    });
  },
});

export const packagePublishPreflight: RegisteredTool = buildTool({
  name: "PackagePublishPreflight",
  description:
    "Check a package directory for the mistakes that only show up after publishing: a workspace: range no registry client can resolve, an entry point no files entry covers, a .env that would ship, a missing version. Use it before cutting a release. Blocking problems would break the published package; warnings would only embarrass it. The files-coverage check approximates npm's rules, so a clean result is not proof — PackageTarballInspect on real pack output is.",
  inputSchema: z.object({
    directory: z
      .string()
      .optional()
      .describe("workspace-relative package directory; defaults to the root"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const at = resolveSafe("PackagePublishPreflight", input.directory ?? ".");
    let manifest: Record<string, unknown>;
    try {
      const raw = readCapped(join(at.real, "package.json"), LIMITS.manifestBytes, "package.json");
      manifest = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
    } catch (err) {
      return `could not read ${at.rel}/package.json: ${(err as Error).message}`;
    }

    const probe: PreflightProbe = {
      exists: (rel) => {
        try {
          // Resolve through containment too: a `main` of "../../etc/passwd"
          // must not be answered by a stat outside the workspace.
          statSync(resolveSafe("PackagePublishPreflight", join(at.rel, rel)).real);
          return true;
        } catch {
          return false;
        }
      },
      isDirectory: (rel) => {
        try {
          return statSync(
            resolveSafe("PackagePublishPreflight", join(at.rel, rel)).real,
          ).isDirectory();
        } catch {
          return false;
        }
      },
    };

    return json({ directory: at.rel, ...preflight(manifest, probe) });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const PKG_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  licenseAggregate,
  lockfileDiff,
  packagePublishPreflight,
  packageTarballInspect,
  semverResolve,
]);
