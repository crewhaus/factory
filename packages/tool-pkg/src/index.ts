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
 * pointing out of the workspace is refused rather than followed. So does
 * every file a tool reads UNDER one — a directory's `package.json` included
 * (0.7.1, security-7#1): the file itself must physically be in the workspace,
 * and a FIFO or device is refused without being opened.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { LOCKFILE_NAMES, type LockedVersion, parseLockfileDetailed } from "@crewhaus/tool-code";
import {
  type SafeFsFailure,
  joinRel,
  openForRead,
  openForReadSync,
} from "@crewhaus/tool-safety/fs";
import { z } from "zod";
import { type LicenseFinding, declaredLicense, splitExpression, summarize } from "./lib/license";
import { diffLocks } from "./lib/lockdiff";
import { type PreflightProbe, preflight } from "./lib/preflight";
import { resolveRange } from "./lib/resolve";
import { listTar } from "./lib/tar";
import { ToolPermissionError, archiveEntryEscapes, resolveSafe, workspaceRoot } from "./paths";

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

/**
 * Read `rel` (workspace-relative) whole, refusing anything over `limit`.
 *
 * The WHOLE path is resolved physically and must land in the workspace, so a
 * leaf joined onto a contained directory cannot lead out through a link
 * planted at its name; a FIFO or device is refused before it is opened (an
 * open would block); and the read itself is capped. Escapes throw
 * {@link ToolPermissionError}, like every other containment refusal here.
 * No message says where a link leads or quotes what is there.
 */
async function readContained(
  toolName: string,
  rel: string,
  limit: number,
  what: string,
): Promise<Uint8Array> {
  const read = await openForRead(workspaceRoot(), rel, { maxBytes: limit });
  if (!read.ok) throw readFailure(toolName, read, what);
  if (read.truncated) {
    throw new Error(
      `${what} is ${read.size} bytes, over the ${limit}-byte limit — narrow the input`,
    );
  }
  return read.bytes;
}

function readFailure(toolName: string, failure: SafeFsFailure, what: string): Error {
  switch (failure.code) {
    case "escapes-root":
      return new ToolPermissionError(toolName, what);
    case "not-found":
    case "not-directory":
      return new Error(`${what} does not exist`);
    case "not-regular-file":
      return new Error(
        `${what} is not a regular file${failure.kind !== undefined ? ` (it is a ${failure.kind})` : ""} — refused without opening it`,
      );
    default:
      return new Error(`${what} could not be read`);
  }
}

/**
 * Pick a lockfile reader from the filename.
 *
 * The filename-to-reader mapping is NOT re-derived here. This function used
 * to keep its own copy, and the copy drifted: it sent `pnpm-lock.yaml` to the
 * yarn reader, whose entry grammar no pnpm generation matches, and the BINARY
 * `bun.lockb` to a text reader. Neither threw. Both returned zero entries, so
 * comparing two pnpm lockfiles produced all-zero counts — a wrong answer
 * wearing the shape of a right one, which is the worst thing a tool that
 * exists to be trusted without checking can do.
 *
 * `bun.lockb` is still refused, because it is the one format named in the
 * description that genuinely cannot be read as text.
 *
 * The name is matched as a SUFFIX, which the exact-basename lookup behind
 * `parseLockfileDetailed` is not: comparing two lockfiles means having two of
 * them at once, so one of the pair is normally a renamed copy
 * (`before-package-lock.json`). The names come from the same module as the
 * readers, so this stays a question about spelling rather than a second
 * opinion about which format is readable.
 */
function parseLock(name: string, text: string): LockedVersion[] {
  const base = name.toLowerCase();
  if (base.endsWith("bun.lockb")) {
    throw new Error(
      `"${name}" is bun's BINARY lockfile and cannot be read as text — run \`bun install --save-text-lockfile\` to get a bun.lock this tool can read`,
    );
  }
  const canonical = LOCKFILE_NAMES.find((known) => base.endsWith(known.toLowerCase()));
  const locked = canonical === undefined ? undefined : parseLockfileDetailed(canonical, text);
  if (locked === undefined) {
    throw new Error(
      `cannot tell what kind of lockfile "${name}" is — expected ${LOCKFILE_NAMES.join(", ")}`,
    );
  }
  // Narrowed on the way out: `diffLocks` rebuilds its own entries, but the
  // wide records also carry an integrity hash, and this tool's output has
  // never contained one.
  return locked.map(({ name: dep, version }) => ({ name: dep, version }));
}

// ---------------------------------------------------------------------------

export const semverResolve: RegisteredTool = buildTool({
  name: "SemverResolve",
  description:
    "Resolve a version range against a list of versions: which satisfy it, and which one an install would pick. Use it to answer 'does the fix in 2.4.1 land inside our range?' or 'what would this upgrade actually install?' without a model guessing at caret and tilde semantics. A prerelease is considered only when the range names a prerelease of the same major.minor.patch, as npm does, and a range the grammar does not understand is reported as such rather than as 'nothing matched'.",
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
    if (result.versionsParsed === 0) {
      // The range is fine; the list is not. Blaming the range would send the
      // caller to fix the wrong input.
      return `none of the ${input.versions.length} versions parsed as a version (e.g. ${JSON.stringify(input.versions[0])}), so nothing could be checked against "${input.range}"`;
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
    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    const before = parseLock(
      a.rel,
      decode(await readContained("LockfileDiff", a.rel, LIMITS.lockBytes, a.rel)),
    );
    const after = parseLock(
      b.rel,
      decode(await readContained("LockfileDiff", b.rel, LIMITS.lockBytes, b.rel)),
    );
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
    let unreadable = 0;
    const visit = (dir: string, label: string): void => {
      if (findings.length >= LIMITS.packages) return;
      // A node_modules entry is very often a symlink — that is how pnpm and
      // workspace protocols work — and one may point out of the workspace.
      // Links that stay inside are followed, which is what makes a workspace
      // tree readable at all; one that leaves is skipped and counted, never
      // read, because the containment boundary is the whole promise here.
      // That holds for the MANIFEST as well as the directory: a real package
      // directory whose package.json is a link out of the workspace used to
      // be read, its name and license reported (security-7#1). The whole
      // path is resolved, so either link counts as one skip.
      const read = openForReadSync(root_, join(dir, "package.json"), {
        maxBytes: LIMITS.manifestBytes,
      });
      if (!read.ok) {
        if (read.code === "escapes-root") escaped += 1;
        else if (read.code !== "not-found" && read.code !== "not-directory") unreadable += 1;
        return;
      }
      if (read.truncated) {
        unreadable += 1;
        return;
      }
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(read.text) as Record<string, unknown>;
      } catch {
        unreadable += 1;
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
      // A manifest that is there and could not be used (not JSON, over the
      // cap, a FIFO) is not a package with no license: it is counted, so a
      // clean-looking roll-up says what it could not see.
      ...(unreadable > 0 ? { skippedUnreadableManifests: unreadable } : {}),
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
    const listing = listTar(
      await readContained("PackageTarballInspect", at.rel, LIMITS.tarballBytes, at.rel),
    );
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
    // The manifest LEAF is contained, not only the directory (security-7#1):
    // a package.json linked out of the workspace throws ToolPermissionError
    // before anything is read.
    const manifestRel = joinRel(at.rel, "package.json");
    let raw: Uint8Array;
    try {
      raw = await readContained(
        "PackagePublishPreflight",
        manifestRel,
        LIMITS.manifestBytes,
        manifestRel,
      );
    } catch (err) {
      if (err instanceof ToolPermissionError) throw err;
      return `could not read ${manifestRel}: ${(err as Error).message}`;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    } catch {
      // Not the parser's message: it quotes the file's first token.
      return `${manifestRel} is not valid JSON`;
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
