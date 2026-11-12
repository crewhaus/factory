/**
 * What a build is: the files a harness runs from, recorded at compile and checked before a
 * start. One collector serves both, so the record and every check compare like with like.
 *
 * A build's inputs are:
 *
 *   1. **The bundle.** Every regular file under the bundle directory, recursively, apart
 *      from `node_modules` and the lockfile `bun install` writes beside the manifest. For a
 *      bundle at the harness root (`-o .`), only the files compile wrote (the record's
 *      `files`) and the root `package.json`.
 *   2. **The resolver configuration.** For each directory from the bundle directory up to
 *      the harness root: `tsconfig.json`, `jsconfig.json`, `package.json` and
 *      `bunfig.toml`, each present or absent, and every file a `tsconfig.json` or
 *      `jsconfig.json` names in `extends` inside the harness, followed in turn (depth 8,
 *      cycles stop). An `extends` naming a package or a place outside the harness is
 *      recorded by its text.
 *   3. **The boot inputs the spec names.** The local files a stdio MCP server's `command`
 *      or `args` name, recorded at compile as `bootInputs`.
 *
 * Nothing is followed through a link: every name is `lstat`ed, and a link is recorded by its
 * own text and never read.
 */
import { createHash } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { type BuildFile, bundleDigest } from "@crewhaus/ir/policy";

/** The fields of a deployment record's artifact the collector reads. */
export type BuildArtifact = {
  /** The entry, posix, relative to the harness (`dist/daemon.ts`, `agent.ts`). */
  readonly entry: string;
  /** For a bundle at the harness root: the files compile wrote, posix, relative. */
  readonly files?: readonly string[];
  /** The local files the spec's boot names, posix, relative. */
  readonly bootInputs?: readonly string[];
};

/** Names in the bundle that are not the build: what an install leaves beside it. */
const NOT_THE_BUILD: ReadonlySet<string> = new Set(["node_modules", ".DS_Store"]);
/** Lockfiles `bun install --cwd <bundle>` writes at the bundle's top. */
const INSTALL_LOCKFILES: ReadonlySet<string> = new Set(["bun.lock", "bun.lockb"]);

/** Resolver configuration read in each directory from the bundle up to the harness root. */
export const RESOLVER_FILES = ["tsconfig.json", "jsconfig.json", "package.json", "bunfig.toml"];

const EXTENDS_DEPTH = 8;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(rel: string): string {
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Contained by `relative()`: `rel === ""` or not leaving and not absolute. */
function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

type Collected = Map<string, BuildFile>;

type Probe =
  | { readonly kind: "absent" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "file"; readonly bytes: Buffer }
  | { readonly kind: "dir" }
  | { readonly kind: "other" };

/** One name, never followed. Throws only for an error other than "not there". */
function probe(abs: string): Probe {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw err;
  }
  if (stats.isSymbolicLink()) return { kind: "link", target: readlinkSync(abs) };
  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isFile()) return { kind: "file", bytes: readFileSync(abs) };
  return { kind: "other" };
}

/** Record one name relative to the harness. A directory or special file is recorded absent. */
function record(out: Collected, harnessDir: string, rel: string): Probe {
  const path = toPosix(rel);
  const found = probe(join(harnessDir, rel));
  switch (found.kind) {
    case "link":
      out.set(path, { path, sha256: null, link: found.target });
      break;
    case "file":
      out.set(path, { path, sha256: sha256Hex(found.bytes) });
      break;
    default:
      out.set(path, { path, sha256: null });
  }
  return found;
}

/** Every regular file under a bundle directory, never through a link. */
function walkBundle(out: Collected, harnessDir: string, bundleRel: string): void {
  const top = record(out, harnessDir, bundleRel);
  if (top.kind !== "dir") return;
  // The directory itself is not an input; its files are.
  out.delete(toPosix(bundleRel));
  const visit = (rel: string, atTop: boolean): void => {
    const entries: Dirent[] = readdirSync(join(harnessDir, rel), { withFileTypes: true });
    for (const entry of entries) {
      if (NOT_THE_BUILD.has(entry.name)) continue;
      if (atTop && INSTALL_LOCKFILES.has(entry.name)) continue;
      const child = join(rel, entry.name);
      if (entry.isDirectory()) visit(child, false);
      else record(out, harnessDir, child);
    }
  };
  visit(bundleRel, true);
}

/** A tolerant JSONC read: comments and trailing commas allowed. `undefined` when it is not JSON. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function extendsOf(text: string): readonly string[] {
  const parsed = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null) return [];
  const value = (parsed as Record<string, unknown>)["extends"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** Where an `extends` lands inside the harness, or `undefined` when it does not. */
function extendsTarget(harnessDir: string, fromRel: string, spec: string): string | undefined {
  if (!(spec.startsWith(".") || isAbsolute(spec))) return undefined;
  const base = resolve(harnessDir, dirname(fromRel));
  const candidates = [resolve(base, spec)];
  if (!spec.endsWith(".json")) candidates.push(resolve(base, `${spec}.json`));
  for (const abs of candidates) {
    if (!inside(harnessDir, abs)) return undefined;
    // The directory it sits in must really be inside, not reached through a link.
    let parentReal: string;
    try {
      parentReal = realpathSync(dirname(abs));
    } catch {
      continue;
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(harnessDir);
    } catch {
      return undefined;
    }
    if (!inside(rootReal, parentReal)) return undefined;
    if (probe(abs).kind !== "absent") return relative(harnessDir, abs);
  }
  return relative(harnessDir, candidates[0] as string);
}

/** Follow a config file's `extends` chain from `rel`, recording each file it names. */
function followExtends(
  out: Collected,
  harnessDir: string,
  rel: string,
  text: string,
  depth: number,
  seen: Set<string>,
): void {
  if (depth >= EXTENDS_DEPTH) return;
  for (const spec of extendsOf(text)) {
    const target = extendsTarget(harnessDir, rel, spec);
    if (target === undefined) {
      const path = `extends:${spec}`;
      out.set(path, { path, sha256: sha256Hex(spec) });
      continue;
    }
    const key = toPosix(target);
    if (seen.has(key)) continue;
    seen.add(key);
    const found = record(out, harnessDir, target);
    if (found.kind === "file") {
      followExtends(out, harnessDir, target, found.bytes.toString("utf8"), depth + 1, seen);
    }
  }
}

/** The resolver configuration from the bundle directory up to the harness root. */
function collectResolverChain(out: Collected, harnessDir: string, bundleRel: string): void {
  const dirs: string[] = [];
  let at = bundleRel === "" ? "." : bundleRel;
  for (;;) {
    dirs.push(at);
    if (at === "." || at === "") break;
    const up = dirname(at);
    at = up === "" ? "." : up;
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of RESOLVER_FILES) {
      const rel = dir === "." ? name : join(dir, name);
      const found = record(out, harnessDir, rel);
      if (found.kind === "file" && (name === "tsconfig.json" || name === "jsconfig.json")) {
        seen.add(toPosix(rel));
        followExtends(out, harnessDir, rel, found.bytes.toString("utf8"), 0, seen);
      }
    }
  }
}

/** The bundle directory of an entry, posix, relative to the harness (`.` at the root). */
export function bundleDirOf(entry: string): string {
  const dir = posix.dirname(entry);
  return dir === "" ? "." : dir;
}

/**
 * The inputs of a build, sorted by path. Refuses (`unreadable`) only when the harness
 * cannot be read at all; a missing file is recorded absent.
 *
 * First consumers: compile's `prepared` record and `verifyActiveBuild`.
 */
export function collectBuildFiles(
  harnessDir: string,
  artifact: BuildArtifact,
): BuildFile[] | { readonly unreadable: string } {
  const out: Collected = new Map();
  try {
    const bundleRel = bundleDirOf(artifact.entry);
    if (bundleRel === ".") {
      for (const file of artifact.files ?? [artifact.entry]) record(out, harnessDir, file);
      record(out, harnessDir, "package.json");
    } else {
      walkBundle(out, harnessDir, bundleRel);
    }
    collectResolverChain(out, harnessDir, bundleRel);
    for (const file of artifact.bootInputs ?? []) record(out, harnessDir, file);
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : String(err) };
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `bundleDigest` over {@link collectBuildFiles}, or why it could not be taken. */
export function buildDigest(
  harnessDir: string,
  artifact: BuildArtifact,
): { readonly digest: string } | { readonly unreadable: string } {
  const files = collectBuildFiles(harnessDir, artifact);
  return Array.isArray(files) ? { digest: bundleDigest(files) } : files;
}

/** The stdio MCP servers a lowered IR names, in any shape that carries them. */
function stdioServers(ir: unknown): Array<{ command: string; args: readonly string[] }> {
  const servers =
    typeof ir === "object" && ir !== null
      ? (ir as { readonly mcp_servers?: unknown }).mcp_servers
      : undefined;
  if (typeof servers !== "object" || servers === null) return [];
  const out: Array<{ command: string; args: readonly string[] }> = [];
  for (const config of Object.values(servers as Record<string, unknown>)) {
    if (typeof config !== "object" || config === null) continue;
    const server = config as { transport?: unknown; command?: unknown; args?: unknown };
    if (server.transport !== "stdio" || typeof server.command !== "string") continue;
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : [];
    out.push({ command: server.command, args });
  }
  return out;
}

/**
 * The boot inputs a lowered IR names: each stdio MCP server's `command` and `args` that
 * resolve, against the harness root, to an existing regular file inside the harness and
 * outside `node_modules`. Posix, relative, sorted. Remote servers name nothing.
 *
 * First consumer: compile's `prepared` record.
 */
export function bootInputsOf(harnessDir: string, ir: unknown): string[] {
  const found = new Set<string>();
  let rootReal: string;
  try {
    rootReal = realpathSync(harnessDir);
  } catch {
    return [];
  }
  for (const server of stdioServers(ir)) {
    for (const word of [server.command, ...server.args]) {
      if (word === "" || word.startsWith("-")) continue;
      const abs = resolve(harnessDir, word);
      if (!inside(harnessDir, abs)) continue;
      const rel = relative(harnessDir, abs);
      if (rel === "" || rel.split(sep).includes("node_modules")) continue;
      let parentReal: string;
      try {
        parentReal = realpathSync(dirname(abs));
      } catch {
        continue;
      }
      if (!inside(rootReal, parentReal)) continue;
      const kind = (() => {
        try {
          return probe(abs).kind;
        } catch {
          return "absent";
        }
      })();
      if (kind === "file" || kind === "link") found.add(toPosix(rel));
    }
  }
  return [...found].sort();
}
