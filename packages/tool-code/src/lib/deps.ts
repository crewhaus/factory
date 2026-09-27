/**
 * Manifests and lockfiles into one dependency list.
 *
 * Five ecosystems, one record shape. None of this talks to a registry: every
 * answer comes from files already in the workspace, which is what makes the
 * dependency tools deterministic and what makes `DependencyOutdated` honest
 * about the question it can actually answer (see its own note).
 *
 * The TOML readers here are DELIBERATELY partial. A full TOML parser is a
 * dependency this package does not have, so `pyproject.toml` and `Cargo.toml`
 * are read with a section-and-key scanner that handles the shapes those two
 * files actually take — a table header, a key with a string value, an inline
 * table with a `version` key, and an array of strings that may span lines.
 * Anything more exotic (nested arrays of tables, multi-line basic strings,
 * dotted keys) is skipped rather than guessed at, and the tools say when a
 * manifest was read this way.
 *
 * Every lockfile reader has two views over ONE parse: `parse<Format>Lock`
 * returns `LockedVersion` (name and version, which is all the tools in this
 * package ever wanted), and `parse<Format>LockDetailed` returns
 * `LockedDependency` — the same entries plus the ecosystem, the resolved URL
 * and the integrity hash, for callers that have to take a dependency
 * somewhere else with it. The narrow one is the wide one with two fields
 * picked off; there is no second parse to drift.
 *
 * Pure: text in, records out.
 */
import { KIND_COMMENT, maskSource } from "./scan";

export type DependencyScope = "prod" | "dev" | "peer" | "optional" | "build";
export type Ecosystem = "npm" | "pypi" | "go" | "cargo";

export type Dependency = {
  readonly name: string;
  /** The range as the manifest declares it (`^1.2.0`, `>=4,<5`, `v1.2.3`). */
  readonly range: string;
  readonly scope: DependencyScope;
  readonly ecosystem: Ecosystem;
  /** The manifest it came from, relative to the directory that was read. */
  readonly source: string;
};

/** The narrow view of a lockfile entry. See `LockedDependency` for the wide one. */
export type LockedVersion = {
  readonly name: string;
  readonly version: string;
};

/**
 * The ecosystems that have a lockfile reader here — a subset of `Ecosystem`,
 * spelled with the same strings so a `LockedDependency` and a `Dependency`
 * can be compared without a translation table between them.
 */
export type LockEcosystem = Extract<Ecosystem, "npm" | "cargo">;

/**
 * A lockfile entry with everything the file itself records about it.
 *
 * The extra fields exist for callers that leave the workspace with an entry —
 * one asking a vulnerability database about (ecosystem, name, version),
 * another asking a registry what is newer. `ecosystem` is on the record
 * rather than left to the caller to infer from which parser it called,
 * because the caller that matters is two packages away from that choice.
 *
 * `resolvedUrl` and `integrity` are optional because for several of these
 * formats they are simply not in the file, and absent is the honest answer.
 * NEITHER IS EVER RECONSTRUCTED. Both an npm tarball URL and a crates.io
 * download URL are derivable from a name and a version, and deriving one here
 * would hand a consumer a URL this project may never have installed from —
 * which is exactly wrong for a package that came from a private registry.
 *
 * What `integrity` holds depends on `ecosystem`, and that is the whole reason
 * the discriminator is carried:
 *
 * - `npm` — Subresource Integrity, `sha512-<base64>` (sha1/sha256/sha384 in
 *   older files), exactly as npm, bun and yarn classic write it.
 * - `cargo` — the bare lowercase SHA-256 hex of the `.crate` file, which is
 *   what `Cargo.lock`'s `checksum` is. NOT SRI: feeding it to an SRI check
 *   fails, and comparing it with an npm `integrity` is meaningless.
 *
 * A hash of a package manager's own repackaging is not carried at all — see
 * `sriIntegrity` on yarn berry's `checksum:`.
 */
export type LockedDependency = {
  readonly ecosystem: LockEcosystem;
  readonly name: string;
  readonly version: string;
  /** The URL the lockfile records, verbatim. Absent when it records none. */
  readonly resolvedUrl?: string;
  /** A content hash of the published artifact; encoding depends on `ecosystem`. */
  readonly integrity?: string;
};

/**
 * A recorded value as a URL, or nothing.
 *
 * The scheme test is load-bearing rather than tidiness: `package-lock.json`
 * writes a RELATIVE PATH into `resolved` for a `link: true` workspace entry
 * (`"packages/ui"`), and a consumer that fetched that string would be
 * fetching something else entirely. Anything carrying a scheme is kept
 * verbatim — `file:`, `git+ssh:` and a registry that is not npmjs included —
 * because what the lockfile says is the answer, not what it ought to say.
 */
function recordedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : undefined;
}

/**
 * Subresource Integrity — one or more `algo-base64` tokens — which is what
 * `integrity` means in every npm-side lockfile.
 *
 * Yarn berry's `checksum:` (`10c0/9f3a…`) deliberately fails this test and is
 * dropped. It hashes Yarn's own zip in Yarn's own cache format, not the
 * published tarball, so it cannot be compared against any other lockfile's
 * integrity; carrying it under this name would make one field mean two
 * things, and a consumer verifying a download against it would reject a
 * perfectly good tarball.
 */
function sriIntegrity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const tokens = text.split(/\s+/);
  const sri = /^(?:sha1|sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/;
  return tokens.every((token) => sri.test(token)) ? text : undefined;
}

/** `Cargo.lock`'s `checksum`: the SHA-256 of the `.crate`, bare lowercase hex. */
const CARGO_CHECKSUM = /^[0-9a-f]{64}$/;

/** Sort order for every listing these tools return: name, then version. */
export function sortDependencies(items: readonly Dependency[]): Dependency[] {
  return [...items].sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// JSON with comments

/**
 * Strip comments and trailing commas so `JSON.parse` accepts a `bun.lock` or
 * a `tsconfig.json`.
 *
 * The comment stripping reuses this package's own lexer rather than a regex,
 * because `"https://example.com"` contains `//` and a regex would cut the
 * string in half — a bug that ships in a surprising number of JSONC readers.
 */
export function stripJsonc(text: string): string {
  const { kind } = maskSource(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += kind[i] === KIND_COMMENT ? (text[i] === "\n" ? "\n" : " ") : (text[i] as string);
  }
  // Trailing commas, decided on the comment-free text so a comma inside a
  // string is never touched.
  const { kind: kind2 } = maskSource(out);
  let result = "";
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "," && kind2[i] === 0) {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j] as string)) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    result += out[i];
  }
  return result;
}

type Unknown = Record<string, unknown>;
const asRecord = (value: unknown): Unknown | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Unknown)
    : undefined;

function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// npm

export type PackageManifest = {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: readonly Dependency[];
  /** `workspaces` entries, as declared (globs included). */
  readonly workspaces: readonly string[];
};

const NPM_SCOPES: ReadonlyArray<[string, DependencyScope]> = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["peerDependencies", "peer"],
  ["optionalDependencies", "optional"],
];

/** Read a `package.json`: scripts, dependencies by scope, workspace globs. */
export function parsePackageJson(
  text: string,
  source = "package.json",
): PackageManifest | undefined {
  const root = asRecord(parseJsonc(text));
  if (root === undefined) return undefined;
  const scripts: Record<string, string> = {};
  const rawScripts = asRecord(root["scripts"]);
  if (rawScripts !== undefined) {
    for (const [key, value] of Object.entries(rawScripts)) {
      if (typeof value === "string") scripts[key] = value;
    }
  }
  const dependencies: Dependency[] = [];
  for (const [field, scope] of NPM_SCOPES) {
    const record = asRecord(root[field]);
    if (record === undefined) continue;
    for (const [name, range] of Object.entries(record)) {
      if (typeof range !== "string") continue;
      dependencies.push({ name, range, scope, ecosystem: "npm", source });
    }
  }
  const workspaces: string[] = [];
  const rawWorkspaces = root["workspaces"];
  if (Array.isArray(rawWorkspaces)) {
    for (const entry of rawWorkspaces) if (typeof entry === "string") workspaces.push(entry);
  } else {
    const nested = asRecord(rawWorkspaces)?.["packages"];
    if (Array.isArray(nested)) {
      for (const entry of nested) if (typeof entry === "string") workspaces.push(entry);
    }
  }
  return {
    ...(typeof root["name"] === "string" ? { name: root["name"] as string } : {}),
    ...(typeof root["version"] === "string" ? { version: root["version"] as string } : {}),
    ...(typeof root["private"] === "boolean" ? { private: root["private"] as boolean } : {}),
    scripts,
    dependencies: sortDependencies(dependencies),
    workspaces: [...workspaces].sort(),
  };
}

/** Split `@scope/name@1.2.3` into its parts, scoped names included. */
export function splitNameVersion(spec: string): { name: string; version: string } | undefined {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * `bun.lock` — bun's text lockfile, which is JSON with trailing commas. Its
 * `packages` map holds `"<key>": ["<name>@<version>", <resolution>, <meta>,
 * "<integrity>"]`, and the tuple gets SHORTER for anything that is not a
 * registry package.
 *
 * `bun.lockb`, the older binary lockfile, is not readable here at all; the
 * tools say so rather than returning an empty list that looks like "no
 * dependencies".
 */
export function parseBunLockDetailed(text: string): LockedDependency[] {
  const root = asRecord(parseJsonc(text));
  const packages = asRecord(root?.["packages"]);
  if (packages === undefined) return [];
  const out: LockedDependency[] = [];
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value)) continue;
    const spec = typeof value[0] === "string" ? (value[0] as string) : undefined;
    const split = spec === undefined ? undefined : splitNameVersion(spec);
    if (split === undefined) continue;
    // Slot 1 is the resolution: EMPTY for anything bun can rebuild from the
    // configured registry, a URL only when it cannot. That is why a
    // default-registry package has no `resolvedUrl` here — bun did not record
    // one, and the one it would rebuild depends on a registry config this
    // reader cannot see.
    const url = recordedUrl(value[1]);
    // The integrity is LAST, not at a fixed index. A workspace member is a
    // one-element tuple and a git resolution a shorter one, so reading slot 3
    // of those would pick up a dependency map, or nothing, and call it a hash.
    const integrity = sriIntegrity(value[value.length - 1]);
    out.push({
      ecosystem: "npm",
      // A workspace member is recorded with an empty or non-semver version.
      name: split.name === "" ? key : split.name,
      version: split.version,
      ...(url === undefined ? {} : { resolvedUrl: url }),
      ...(integrity === undefined ? {} : { integrity }),
    });
  }
  return dedupeLocked(out);
}

export function parseBunLock(text: string): LockedVersion[] {
  return narrow(parseBunLockDetailed(text));
}

/**
 * `package-lock.json` v2/v3 — the `packages` map keyed by install path — and
 * the v1 `dependencies` tree. Both record `resolved` and `integrity` per
 * entry; the root entry, a workspace link and a bundled dependency record
 * neither, and `resolved` on a link is a path rather than a URL.
 */
export function parsePackageLockDetailed(text: string): LockedDependency[] {
  const root = asRecord(parseJsonc(text));
  if (root === undefined) return [];
  const out: LockedDependency[] = [];
  const push = (name: string, version: string, record: Unknown): void => {
    const url = recordedUrl(record["resolved"]);
    const integrity = sriIntegrity(record["integrity"]);
    out.push({
      ecosystem: "npm",
      name,
      version,
      ...(url === undefined ? {} : { resolvedUrl: url }),
      ...(integrity === undefined ? {} : { integrity }),
    });
  };
  const packages = asRecord(root["packages"]);
  if (packages !== undefined) {
    for (const [path, value] of Object.entries(packages)) {
      const record = asRecord(value);
      if (record === undefined) continue;
      const version =
        typeof record["version"] === "string" ? (record["version"] as string) : undefined;
      if (version === undefined) continue;
      const marker = "node_modules/";
      const idx = path.lastIndexOf(marker);
      const name =
        idx === -1
          ? typeof record["name"] === "string"
            ? (record["name"] as string)
            : path
          : path.slice(idx + marker.length);
      if (name === "") continue;
      push(name, version, record);
    }
  }
  // v1 lockfiles keep a `dependencies` tree instead.
  const legacy = asRecord(root["dependencies"]);
  if (packages === undefined && legacy !== undefined) {
    for (const [name, value] of Object.entries(legacy)) {
      const record = asRecord(value);
      if (record === undefined) continue;
      const version =
        typeof record["version"] === "string" ? (record["version"] as string) : undefined;
      if (version !== undefined) push(name, version, record);
    }
  }
  return dedupeLocked(out);
}

export function parsePackageLock(text: string): LockedVersion[] {
  return narrow(parsePackageLockDetailed(text));
}

/**
 * `yarn.lock`, both dialects: classic (`version "1.2.3"`) and berry
 * (`version: 1.2.3`). The entry key carries the name, which may be quoted,
 * comma-separated and suffixed with `@npm:`.
 *
 * Only classic carries the wide fields. Berry replaced `resolved` with
 * `resolution: "zod@npm:3.23.8"`, which is a descriptor and not a URL, and
 * `integrity` with `checksum:`, which `sriIntegrity` refuses; both come back
 * absent rather than filled with the nearest-looking string.
 *
 * Fields are collected across the whole entry and flushed at the next header,
 * because `resolved` and `integrity` are written BELOW `version` — a parser
 * that finished an entry the moment it saw the version could never read them.
 */
export function parseYarnLockDetailed(text: string): LockedDependency[] {
  const out: LockedDependency[] = [];
  let names: string[] = [];
  let version: string | undefined;
  let resolved: string | undefined;
  let integrity: string | undefined;
  const flush = (): void => {
    if (version !== undefined) {
      for (const name of names) {
        out.push({
          ecosystem: "npm",
          name,
          version,
          ...(resolved === undefined ? {} : { resolvedUrl: resolved }),
          ...(integrity === undefined ? {} : { integrity }),
        });
      }
    }
    names = [];
    version = undefined;
    resolved = undefined;
    integrity = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      flush();
      const header = line.replace(/:\s*$/, "");
      for (const part of header.split(",")) {
        const spec = part.trim().replace(/^"/, "").replace(/"$/, "");
        if (spec === "" || spec.startsWith("__metadata")) continue;
        const at = spec.lastIndexOf("@");
        if (at <= 0) continue;
        names.push(spec.slice(0, at));
      }
      continue;
    }
    // Berry's own `resolution:` and `checksum:` are NOT these fields, and the
    // alternation is anchored so neither is mistaken for one.
    const m = /^\s+(version|resolved|integrity):?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m === null) continue;
    const value = m[2] as string;
    if (m[1] === "version") version ??= value;
    else if (m[1] === "resolved") resolved ??= recordedUrl(value);
    else integrity ??= sriIntegrity(value);
  }
  flush();
  return dedupeLocked(out);
}

export function parseYarnLock(text: string): LockedVersion[] {
  return narrow(parseYarnLockDetailed(text));
}

/**
 * A `pnpm-lock.yaml` entry key into a name and a version.
 *
 * Three key shapes, because pnpm changed this twice and a lockfile of every
 * generation is still in the wild:
 *
 * - v5 (`lockfileVersion: 5.4`) — `/zod/3.23.8`, `/@scope/pkg/1.2.3`, with a
 *   peer suffix appended to the VERSION as `_react@18.2.0`.
 * - v6 (`'6.0'`, pnpm 8) — `/zod@3.23.8`, `/@scope/pkg@1.2.3`, peers as
 *   `(react@18.2.0)`.
 * - v9 (`'9.0'`, pnpm 9+) — the same without the leading slash. Peer suffixes
 *   live in `snapshots:` rather than here, but are cut anyway.
 *
 * The generation is read off the key rather than off `lockfileVersion`, so a
 * file that mixes shapes still parses and a header this reader has never
 * heard of is not a reason to refuse the entries below it.
 *
 * Two details are what make this more than a `split`:
 *
 * - The v5/v6 split is decided by whether the segment after the last `/` is a
 *   VERSION, because `_` is legal in a package name (`@a2ui/web_core@0.10.0`
 *   is a real one). Cutting the v5 peer suffix at the first `_` in the key
 *   would truncate that name; cutting it inside the version segment cannot.
 * - The name/version `@` is the FIRST one after the scope, never the last.
 *   A git dependency's key is `foo@git+ssh://git@github.com/x/y.git#sha`, and
 *   splitting that at the last `@` yields the name `foo@git+ssh://git`.
 */
function splitPnpmKey(raw: string): { name: string; version: string } | undefined {
  const cut = (text: string, marker: string): string => {
    const at = text.indexOf(marker);
    return at === -1 ? text : text.slice(0, at);
  };
  const splitAtScopedAt = (body: string): { name: string; version: string } | undefined => {
    const at = body.indexOf("@", 1);
    return at <= 0 ? undefined : { name: body.slice(0, at), version: body.slice(at + 1) };
  };
  const key = cut(raw, "(");
  if (!key.startsWith("/")) return splitAtScopedAt(key);
  const body = key.slice(1);
  const slash = body.lastIndexOf("/");
  // A v5 key ends in its version; a v6 one ends in `name@version`, whose last
  // `/` is the scope separator and is therefore followed by a letter.
  if (slash !== -1 && /^\d/.test(body.slice(slash + 1))) {
    return { name: body.slice(0, slash), version: cut(body.slice(slash + 1), "_") };
  }
  return splitAtScopedAt(body);
}

/** One `key: value` out of a `resolution: {…}` inline map, unquoted. */
function resolutionField(map: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}:\\s*([^,}]+)`).exec(map);
  if (m === null) return undefined;
  const value = (m[1] as string).trim();
  return value.replace(/^['"]/, "").replace(/['"]$/, "");
}

/**
 * `pnpm-lock.yaml`, generations 5, 6 and 9 — the top-level `packages:` map,
 * which lists every resolved package exactly once.
 *
 * Only `packages:` is read. `importers:` is the workspace's own declared
 * ranges rather than resolutions, and `snapshots:` (v9) re-lists the same
 * packages once per peer combination, so reading either would double-count.
 *
 * This is a line scanner, not a YAML parser — the same deliberate partiality
 * the TOML readers above are written with, and for the same reason: the
 * shapes pnpm actually writes are a table header, an entry key, and a flat
 * inline map, none of which need a YAML engine this package does not have.
 *
 * `integrity` comes from `resolution: {integrity: …}`, which is SRI and
 * directly comparable with the npm-side readers above. A `tarball:` URL is
 * recorded only for a package pnpm did not get from the registry, and is the
 * only resolution field taken as `resolvedUrl`: a git resolution records
 * `repo` and `commit` as separate fields, and a `repo` alone is not the URL
 * the package came from — it is a moving reference to a repository. Nothing
 * is reconstructed here, in line with `LockedDependency`.
 *
 * A non-registry entry carries its own `name:` and `version:` fields, and
 * those WIN over the key: a git dependency's key holds the git URL where a
 * version would be, while its `version:` field holds the real `3.0.1`. When
 * pnpm records neither — a v6 `file:` dependency has a `name:` and no
 * `version:` — the key stands in, so the entry stays visible in a diff
 * instead of being silently dropped.
 */
export function parsePnpmLockDetailed(text: string): LockedDependency[] {
  const out: LockedDependency[] = [];
  let inPackages = false;
  let key: string | undefined;
  let name: string | undefined;
  let version: string | undefined;
  let resolvedUrl: string | undefined;
  let integrity: string | undefined;
  const flush = (): void => {
    if (key !== undefined) {
      const split = splitPnpmKey(key);
      const finalName = name ?? split?.name;
      const finalVersion = version ?? split?.version ?? key;
      if (finalName !== undefined && finalName !== "") {
        out.push({
          ecosystem: "npm",
          name: finalName,
          version: finalVersion,
          ...(resolvedUrl === undefined ? {} : { resolvedUrl }),
          ...(integrity === undefined ? {} : { integrity }),
        });
      }
    }
    key = undefined;
    name = undefined;
    version = undefined;
    resolvedUrl = undefined;
    integrity = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // A column-0 key ends the section, so `snapshots:` and `importers:` close
    // `packages:` rather than being read as more of it.
    if (!/^\s/.test(line)) {
      flush();
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    // Entry keys sit at exactly two spaces and fields at exactly four, which
    // is what keeps a nested `dependencies:` map out of both.
    const header = /^ {2}(\S.*?):\s*$/.exec(line);
    if (header !== null) {
      flush();
      key = (header[1] as string).replace(/^['"]/, "").replace(/['"]$/, "");
      continue;
    }
    if (key === undefined) continue;
    const field = /^ {4}(name|version|resolution):\s*(.+?)\s*$/.exec(line);
    if (field === null) continue;
    const value = (field[2] as string).replace(/^['"]/, "").replace(/['"]$/, "");
    if (field[1] === "name") name ??= value;
    else if (field[1] === "version") version ??= value;
    else {
      resolvedUrl ??= recordedUrl(resolutionField(value, "tarball"));
      integrity ??= sriIntegrity(resolutionField(value, "integrity"));
    }
  }
  flush();
  return dedupeLocked(out);
}

export function parsePnpmLock(text: string): LockedVersion[] {
  return narrow(parsePnpmLockDetailed(text));
}

/** The wide entries as the narrow view every tool in this package reads. */
function narrow(items: readonly LockedDependency[]): LockedVersion[] {
  return items.map(({ name, version }) => ({ name, version }));
}

/**
 * One entry per name@version, first occurrence winning.
 *
 * First-wins matters now that an entry carries more than a version: a
 * lockfile that lists one name@version twice keeps the URL and hash of the
 * first, rather than merging two records into a third that appears in neither.
 */
function dedupeLocked(items: readonly LockedDependency[]): LockedDependency[] {
  const seen = new Set<string>();
  const out: LockedDependency[] = [];
  for (const item of items) {
    const key = `${item.name}@${item.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
}

/**
 * Pick a reader from a lockfile's name, so a caller does not re-derive the
 * mapping and get `bun.lockb` wrong.
 *
 * `undefined` means "not a lockfile this package reads", which is NOT the
 * same answer as an empty array and must not be reported as one: `bun.lockb`
 * is bun's BINARY lockfile, and handing it to the `bun.lock` reader — which
 * is what a caller re-deriving this mapping from the extension does — yields
 * zero entries that look exactly like a project with no dependencies.
 */
const LOCKFILE_READERS: ReadonlyArray<readonly [string, (text: string) => LockedDependency[]]> = [
  ["bun.lock", parseBunLockDetailed],
  ["package-lock.json", parsePackageLockDetailed],
  ["npm-shrinkwrap.json", parsePackageLockDetailed],
  ["yarn.lock", parseYarnLockDetailed],
  ["pnpm-lock.yaml", parsePnpmLockDetailed],
  ["Cargo.lock", parseCargoLockDetailed],
];

/**
 * The lockfile names `parseLockfileDetailed` reads, in the casing they are
 * written in.
 *
 * Exported so a caller that has to match a name LOOSELY — `LockfileDiff` is
 * handed two files to compare, and a copy taken for comparison is usually
 * renamed to `before-package-lock.json` — can do that without also deciding
 * which reader a name gets. That second decision is the one that drifted.
 */
export const LOCKFILE_NAMES: readonly string[] = LOCKFILE_READERS.map(([name]) => name);

export function parseLockfileDetailed(
  filename: string,
  text: string,
): LockedDependency[] | undefined {
  const base = filename.toLowerCase().replace(/^.*[\\/]/, "");
  const hit = LOCKFILE_READERS.find(([name]) => name.toLowerCase() === base);
  return hit === undefined ? undefined : hit[1](text);
}

// ---------------------------------------------------------------------------
// python

/** `requirements.txt`: one requirement per line, markers and extras stripped. */
export function parseRequirementsTxt(text: string, source = "requirements.txt"): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    // Options (`-r other.txt`, `--index-url …`) are not requirements.
    if (line.startsWith("-")) continue;
    const hash = line.indexOf(" #");
    if (hash !== -1) line = line.slice(0, hash).trim();
    const marker = line.indexOf(";");
    if (marker !== -1) line = line.slice(0, marker).trim();
    if (line.includes("://") || line.startsWith(".")) continue;
    const m = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[(?<extras>[^\]]*)\])?\s*(?<range>.*)$/.exec(line);
    if (m === null) continue;
    out.push({
      name: (m.groups?.["name"] as string).trim(),
      range: (m.groups?.["range"] ?? "").trim(),
      scope: "prod",
      ecosystem: "pypi",
      source,
    });
  }
  return sortDependencies(out);
}

/** Split a PEP 508 requirement string into a name and the rest. */
function splitPep508(spec: string): { name: string; range: string } | undefined {
  const cleaned = spec.split(";")[0]?.trim() ?? "";
  if (cleaned === "") return undefined;
  const m = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?<range>.*)$/.exec(cleaned);
  if (m === null) return undefined;
  return { name: m.groups?.["name"] as string, range: (m.groups?.["range"] ?? "").trim() };
}

/**
 * `pyproject.toml`, the two dependency shapes in the wild: PEP 621's
 * `[project] dependencies = [...]` (plus `optional-dependencies` groups) and
 * poetry's `[tool.poetry.dependencies]` table. Read with the partial TOML
 * scanner this file documents at the top.
 */
export function parsePyproject(text: string, source = "pyproject.toml"): Dependency[] {
  const out: Dependency[] = [];
  const sections = tomlSections(text);

  for (const [header, body] of sections) {
    if (header === "project") {
      for (const item of tomlStringArray(body, "dependencies")) {
        const split = splitPep508(item);
        if (split !== undefined) {
          out.push({ ...split, scope: "prod", ecosystem: "pypi", source });
        }
      }
    } else if (header === "project.optional-dependencies" || header === "dependency-groups") {
      for (const [, items] of tomlAllStringArrays(body)) {
        for (const item of items) {
          const split = splitPep508(item);
          if (split !== undefined) {
            out.push({ ...split, scope: "optional", ecosystem: "pypi", source });
          }
        }
      }
    } else if (header === "tool.poetry.dependencies" || header === "tool.poetry.dev-dependencies") {
      const scope: DependencyScope = header.endsWith("dev-dependencies") ? "dev" : "prod";
      for (const [name, value] of tomlKeyValues(body)) {
        if (name === "python") continue;
        out.push({ name, range: value, scope, ecosystem: "pypi", source });
      }
    }
  }
  return sortDependencies(out);
}

// ---------------------------------------------------------------------------
// go

/** `go.mod`: the `require` block, plus `// indirect` markers. */
export function parseGoMod(text: string, source = "go.mod"): Dependency[] {
  const out: Dependency[] = [];
  let inRequire = false;
  for (const raw of text.split("\n")) {
    const withComment = raw.replace(/\r$/, "");
    const indirect = /\/\/\s*indirect/.test(withComment);
    const line = withComment.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const body = inRequire ? line : /^require\s+(.*)$/.exec(line)?.[1];
    if (body === undefined) continue;
    const m = /^(?<name>\S+)\s+(?<range>\S+)$/.exec(body.trim());
    if (m === null) continue;
    out.push({
      name: m.groups?.["name"] as string,
      range: m.groups?.["range"] as string,
      scope: indirect ? "optional" : "prod",
      ecosystem: "go",
      source,
    });
  }
  return sortDependencies(out);
}

// ---------------------------------------------------------------------------
// cargo

/** `Cargo.toml`: the dependency tables, values either a string or an inline table. */
export function parseCargoToml(text: string, source = "Cargo.toml"): Dependency[] {
  const out: Dependency[] = [];
  const scopes: Readonly<Record<string, DependencyScope>> = {
    dependencies: "prod",
    "dev-dependencies": "dev",
    "build-dependencies": "build",
    "workspace.dependencies": "prod",
  };
  for (const [header, body] of tomlSections(text)) {
    const scope = scopes[header];
    if (scope === undefined) continue;
    for (const [name, value] of tomlKeyValues(body)) {
      out.push({ name, range: value, scope, ecosystem: "cargo", source });
    }
  }
  return sortDependencies(out);
}

/**
 * `Cargo.lock`: repeated `[[package]]` tables with a name and a version.
 *
 * `checksum` is the SHA-256 of the `.crate`, carried verbatim as `integrity`
 * — bare hex, not SRI, which is why `ecosystem` travels with it. It is absent
 * for a path or git dependency, and for lockfile version 1, which kept every
 * checksum in a `[metadata]` table keyed by source id rather than beside the
 * package.
 *
 * `source` is deliberately NOT reported as `resolvedUrl`. It identifies the
 * source registry — `registry+https://github.com/rust-lang/crates.io-index`,
 * the same string for every crate in the file — and is not an address the
 * crate can be fetched from; the download URL crates.io would serve is
 * derived from the name and version, which is precisely the guess these
 * readers do not make.
 */
export function parseCargoLockDetailed(text: string): LockedDependency[] {
  const out: LockedDependency[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let checksum: string | undefined;
  const flush = (): void => {
    if (name !== undefined && version !== undefined) {
      out.push({
        ecosystem: "cargo",
        name,
        version,
        ...(checksum === undefined ? {} : { integrity: checksum }),
      });
    }
    name = undefined;
    version = undefined;
    checksum = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    // Flush at ANY table header, not only `[[package]]`. A `[[patch.unused]]`
    // table is written after the packages and carries its own `name` and
    // `version`; stopping only at `[[package]]` let those overwrite the record
    // still in hand, which dropped a real crate and — now that an entry
    // carries one — handed its checksum to a different package.
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      flush();
      continue;
    }
    const m = /^(name|version|checksum)\s*=\s*"([^"]*)"$/.exec(line);
    if (m === null) continue;
    if (m[1] === "name") name = m[2] as string;
    else if (m[1] === "version") version = m[2] as string;
    // A `checksum` that is not 64 hex characters is not the hash this claims
    // to be, so it is dropped rather than passed on for something to verify.
    else checksum = CARGO_CHECKSUM.test(m[2] as string) ? (m[2] as string) : undefined;
  }
  flush();
  return dedupeLocked(out);
}

export function parseCargoLock(text: string): LockedVersion[] {
  return narrow(parseCargoLockDetailed(text));
}

// ---------------------------------------------------------------------------
// the partial TOML scanner

/** `[header]` sections and their bodies, in file order. */
function tomlSections(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let header = "";
  let body: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (m === null) {
      body.push(line);
      continue;
    }
    out.push([header, body.join("\n")]);
    header = (m[1] as string).trim();
    body = [];
  }
  out.push([header, body.join("\n")]);
  return out;
}

/** `key = "value"` and `key = { version = "value", … }` pairs in a section body. */
function tomlKeyValues(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of body.split("\n")) {
    const line = raw
      .replace(/\r$/, "")
      .replace(/\s+#.*$/, "")
      .trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?<key>[A-Za-z0-9._-]+)\s*=\s*(?<value>.+)$/.exec(line);
    if (m === null) continue;
    const key = m.groups?.["key"] as string;
    const rawValue = (m.groups?.["value"] as string).trim();
    if (rawValue.startsWith('"')) {
      out.push([key, rawValue.replace(/^"/, "").replace(/"$/, "")]);
      continue;
    }
    if (rawValue.startsWith("{")) {
      const version = /version\s*=\s*"([^"]*)"/.exec(rawValue);
      const isPath = /\bpath\s*=/.test(rawValue);
      const isWorkspace = /\bworkspace\s*=\s*true/.test(rawValue);
      out.push([
        key,
        version !== null
          ? (version[1] as string)
          : isWorkspace
            ? "workspace"
            : isPath
              ? "path"
              : "",
      ]);
    }
  }
  return out;
}

/** A `key = ["a", "b"]` array, possibly spanning lines. */
function tomlStringArray(body: string, key: string): string[] {
  const start = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(body);
  if (start === null) return [];
  const from = (start.index as number) + start[0].length - 1;
  let depth = 0;
  let end = from;
  for (let i = from; i < body.length; i++) {
    if (body[i] === "[") depth += 1;
    else if (body[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const inner = body.slice(from + 1, end);
  const out: string[] = [];
  for (const m of inner.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    out.push((m[1] ?? m[2] ?? "").trim());
  }
  return out;
}

/** Every `key = [...]` array in a section body, for optional-dependency groups. */
function tomlAllStringArrays(body: string): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const m of body.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=\s*\[/gm)) {
    const key = m[1] as string;
    out.push([key, tomlStringArray(body, key)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// semver, enough of it

export type SemVer = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
};

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-rc.1`, `1.2` and `1`. */
export function parseSemver(raw: string): SemVer | undefined {
  const m =
    /^[v=\s]*(?<major>\d+)(?:\.(?<minor>\d+))?(?:\.(?<patch>\d+))?(?:-(?<pre>[0-9A-Za-z.-]+))?/.exec(
      raw.trim(),
    );
  if (m === null) return undefined;
  return {
    major: Number(m.groups?.["major"]),
    minor: m.groups?.["minor"] === undefined ? 0 : Number(m.groups["minor"]),
    patch: m.groups?.["patch"] === undefined ? 0 : Number(m.groups["patch"]),
    prerelease: m.groups?.["pre"] ?? "",
  };
}

/**
 * Compare two versions, prereleases ordering below their release.
 *
 * Prereleases compare identifier by identifier, as SemVer 2.0.0 §11 and npm
 * do: numeric identifiers numerically and below alphanumeric ones, and a
 * longer list above a prefix of it. Compared as whole strings, `rc.10`
 * sorted below `rc.9`, so a range, a pick or an advisory's bounds could
 * land on the wrong side of a release candidate.
 */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

const NUMERIC_IDENTIFIER_RE = /^\d+$/;

function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = NUMERIC_IDENTIFIER_RE.test(x);
    const yNum = NUMERIC_IDENTIFIER_RE.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** One comparator: an optional operator, then the version or wildcard it applies to. */
const COMPARATOR_RE = /^(?<op>\^|~>?|>=|<=|>|<|=)?\s*(?<rest>.+)$/;

/**
 * A comparator's version, as node-semver's XRANGEPLAIN reads it: each of
 * major, minor and patch a number or `x`/`X`/`*`, minor and patch optional,
 * a prerelease only after a patch, build metadata ignored. Every class is
 * disjoint from the delimiter after it, so a match is linear.
 */
const COMPARATOR_VERSION_RE =
  /^[v=\s]*(?<major>\d+|[xX*])(?:\.(?<minor>\d+|[xX*])(?:\.(?<patch>\d+|[xX*])(?:-(?<pre>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/;

/** A bound a desugared comparator puts on a version. */
type Bound = { readonly op: ">=" | ">" | "<" | "<=" | "="; readonly at: SemVer };

const sv = (major: number, minor: number, patch: number, prerelease = ""): SemVer => ({
  major,
  minor,
  patch,
  prerelease,
});

/**
 * One comparator as the bounds npm desugars it to (node-semver's
 * replaceXRange, replaceTilde and replaceCaret), or "any"/"none", or
 * undefined when it is not a comparator npm would read. A missing or `x`
 * part is a wildcard: `1.2` is `>=1.2.0 <1.3.0-0`, `<=1.2` is `<1.3.0-0`,
 * `>1` is `>=2.0.0`, `~1` is `>=1.0.0 <2.0.0-0`, `^0` is `>=0.0.0 <1.0.0-0`.
 * The `-0` upper bounds keep a prerelease of the next tuple out.
 * `includePrerelease` lowers a wildcard's floor to its `-0`, as npm does.
 */
function desugarComparator(
  op: string,
  rest: string,
  includePrerelease: boolean,
): readonly Bound[] | "any" | "none" | undefined {
  const m = COMPARATOR_VERSION_RE.exec(rest);
  if (m === null) return undefined;
  const part = (raw: string | undefined): number | undefined =>
    raw === undefined || raw === "x" || raw === "X" || raw === "*" ? undefined : Number(raw);
  const M = part(m.groups?.["major"]);
  const xM = M === undefined;
  const mi = xM ? undefined : part(m.groups?.["minor"]);
  const xm = mi === undefined;
  const pa = xm ? undefined : part(m.groups?.["patch"]);
  const xp = pa === undefined;
  const pre = xp ? "" : (m.groups?.["pre"] ?? "");
  const z = includePrerelease ? "0" : "";
  const major = M ?? 0;
  const minor = mi ?? 0;
  const patch = pa ?? 0;
  switch (op) {
    case "":
    case "=": {
      if (xM) return "any";
      if (xm)
        return [
          { op: ">=", at: sv(major, 0, 0, z) },
          { op: "<", at: sv(major + 1, 0, 0, "0") },
        ];
      if (xp) {
        return [
          { op: ">=", at: sv(major, minor, 0, z) },
          { op: "<", at: sv(major, minor + 1, 0, "0") },
        ];
      }
      return [{ op: "=", at: sv(major, minor, patch, pre) }];
    }
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (xM) return op === ">" || op === "<" ? "none" : "any";
      if (!xp) return [{ op, at: sv(major, minor, patch, pre) }];
      if (op === ">") {
        return [{ op: ">=", at: xm ? sv(major + 1, 0, 0, z) : sv(major, minor + 1, 0, z) }];
      }
      if (op === "<=") {
        return [{ op: "<", at: xm ? sv(major + 1, 0, 0, "0") : sv(major, minor + 1, 0, "0") }];
      }
      if (op === "<") return [{ op: "<", at: sv(major, minor, 0, "0") }];
      return [{ op: ">=", at: sv(major, minor, 0, z) }];
    }
    case "~": {
      if (xM) return "any";
      if (xm)
        return [
          { op: ">=", at: sv(major, 0, 0) },
          { op: "<", at: sv(major + 1, 0, 0, "0") },
        ];
      return [
        { op: ">=", at: sv(major, minor, patch, pre) },
        { op: "<", at: sv(major, minor + 1, 0, "0") },
      ];
    }
    case "^": {
      if (xM) return "any";
      if (xm)
        return [
          { op: ">=", at: sv(major, 0, 0, z) },
          { op: "<", at: sv(major + 1, 0, 0, "0") },
        ];
      const floor = sv(major, minor, patch, xp ? z : pre === "" && major === 0 ? z : pre);
      const ceiling =
        major > 0
          ? sv(major + 1, 0, 0, "0")
          : xp || minor > 0
            ? sv(0, minor + 1, 0, "0")
            : sv(0, 0, patch + 1, "0");
      return [
        { op: ">=", at: floor },
        { op: "<", at: ceiling },
      ];
    }
    default:
      return undefined;
  }
}

function holds(version: SemVer, bound: Bound): boolean {
  const cmp = compareSemver(version, bound.at);
  switch (bound.op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    default:
      return cmp === 0;
  }
}

function satisfiesComparator(
  version: SemVer,
  comparator: string,
  includePrerelease: boolean,
): boolean | undefined {
  const text = comparator.trim();
  if (text === "" || text === "latest") return true;
  const m = COMPARATOR_RE.exec(text);
  if (m === null) return undefined;
  // `~>` is npm's other spelling of `~`.
  const op = m.groups?.["op"] === "~>" ? "~" : (m.groups?.["op"] ?? "");
  const restRaw = (m.groups?.["rest"] as string).trim();
  if (/^(workspace|path|file|link|npm|git|https?|latest)/.test(restRaw)) return undefined;
  const bounds = desugarComparator(op, restRaw, includePrerelease);
  if (bounds === undefined) return undefined;
  if (bounds === "any") return true;
  if (bounds === "none") return false;
  return bounds.every((bound) => holds(version, bound));
}

/** `A - B`: one whole `||` alternative that is a hyphen range. Linear: each class is disjoint from the next. */
const HYPHEN_RANGE_RE = /^\s*(\S+)\s+-\s+(\S+)\s*$/;

/**
 * A hyphen range as the comparators npm desugars it to (node-semver's
 * hyphenReplace): `1.2.3 - 2.3.4` is `>=1.2.3 <=2.3.4`; a partial FROM is
 * its floor (`1.2 - 2.3.4` is `>=1.2.0 <=2.3.4`) and a partial TO its
 * ceiling (`1.2.3 - 2.3` is `>=1.2.3 <2.4.0-0`); an `x` side is unbounded.
 * `includePrerelease` lowers the floor to `-0`, as npm does (npm also
 * writes an inclusive release ceiling as `<` the next patch's `-0`, which
 * admits exactly the same versions). The
 * alternative unchanged when it is not a hyphen range, or when either side
 * is not a version npm reads (then it stays "cannot tell").
 */
function expandHyphenRange(alternative: string, includePrerelease: boolean): string {
  const m = HYPHEN_RANGE_RE.exec(alternative);
  if (m === null) return alternative;
  const sides = [m[1] as string, m[2] as string].map((raw) => {
    const v = COMPARATOR_VERSION_RE.exec(raw);
    if (v === null) return undefined;
    const x = (part: string | undefined) =>
      part === undefined || part === "x" || part === "X" || part === "*";
    return {
      M: v.groups?.["major"] as string,
      m: v.groups?.["minor"],
      p: v.groups?.["patch"],
      pre: v.groups?.["pre"],
      xM: x(v.groups?.["major"]),
      xm: x(v.groups?.["major"]) || x(v.groups?.["minor"]),
      xp: x(v.groups?.["major"]) || x(v.groups?.["minor"]) || x(v.groups?.["patch"]),
    };
  });
  const [from, to] = sides;
  if (from === undefined || to === undefined) return alternative;
  const z = includePrerelease ? "-0" : "";
  const floor = from.xM
    ? ""
    : from.xm
      ? `>=${from.M}.0.0${z}`
      : from.xp
        ? `>=${from.M}.${from.m}.0${z}`
        : from.pre !== undefined
          ? `>=${from.M}.${from.m}.${from.p}-${from.pre}`
          : `>=${from.M}.${from.m}.${from.p}${z}`;
  const ceiling = to.xM
    ? ""
    : to.xm
      ? `<${Number(to.M) + 1}.0.0-0`
      : to.xp
        ? `<${to.M}.${Number(to.m) + 1}.0-0`
        : to.pre !== undefined
          ? `<=${to.M}.${to.m}.${to.p}-${to.pre}`
          : `<=${to.M}.${to.m}.${to.p}`;
  return `${floor} ${ceiling}`.trim();
}

/**
 * The comparators of one `||` alternative. An operator may be written apart
 * from its version (`>= 1.2`), which npm joins before splitting on
 * whitespace; without the join `>=` alone was a comparator nobody understood.
 */
function comparatorsOf(alternative: string): string[] {
  return alternative
    .replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1")
    .trim()
    .split(/\s+/)
    .filter((c) => c !== "");
}

/**
 * Does `version` satisfy `range`?
 *
 * `undefined` means "cannot tell" — a `workspace:*` protocol, a git URL, a
 * typo — and every caller treats that as unchecked rather than as false.
 * This is a deliberately small subset of node-semver: caret, tilde (`~` and
 * `~>`), the four inequalities, exact, partial versions and `x`-wildcards
 * read as npm reads them (a missing segment is a wildcard), hyphen ranges,
 * whitespace-joined AND and `||`-joined OR. Enough for the ranges real
 * manifests hold, and honest about the rest: when one `||` alternative
 * cannot be read and no other matched, the answer is "cannot tell", never
 * a definite no (the unread alternative might have matched).
 * `includePrerelease` lowers a wildcard's floor to its `-0`, as npm's option
 * does; the prerelease INSTALL rule is {@link satisfiesInstallable}'s.
 */
export function satisfies(
  versionRaw: string,
  range: string,
  options: { readonly includePrerelease?: boolean } = {},
): boolean | undefined {
  const version = parseSemver(versionRaw);
  if (version === undefined) return undefined;
  const alternatives = range.split("||");
  let anyUnknown = false;
  for (const alternative of alternatives) {
    const comparators = comparatorsOf(
      expandHyphenRange(alternative, options.includePrerelease === true),
    );
    if (comparators.length === 0) return true;
    let all = true;
    let known = true;
    for (const comparator of comparators) {
      const result = satisfiesComparator(version, comparator, options.includePrerelease === true);
      if (result === undefined) {
        known = false;
        break;
      }
      if (!result) all = false;
    }
    if (!known) {
      anyUnknown = true;
      continue;
    }
    if (all) return true;
  }
  return anyUnknown ? undefined : false;
}

/**
 * `satisfies`, plus the rule an npm install applies to prereleases: a version
 * with a prerelease tag counts only when a comparator in the SAME `||`
 * alternative names a prerelease of the same major.minor.patch, or when
 * `includePrerelease` is set. So `^1.2.3-beta.2` admits 1.2.3-beta.4 and
 * 1.5.0 but never 1.9.0-rc.1, and a prerelease named in one alternative
 * admits nothing in another. `satisfies` itself answers the plain range
 * question (DependencyOutdated asks that one); this answers "would an
 * install pick it". `undefined` exactly when `satisfies` is.
 */
export function satisfiesInstallable(
  versionRaw: string,
  range: string,
  options: { readonly includePrerelease?: boolean } = {},
): boolean | undefined {
  const version = parseSemver(versionRaw);
  if (version === undefined) return undefined;
  if (version.prerelease === "" || options.includePrerelease === true) {
    return satisfies(versionRaw, range, options);
  }
  let anyUnknown = false;
  for (const alternative of range.split("||")) {
    const result = satisfies(versionRaw, alternative);
    if (result === undefined) {
      anyUnknown = true;
      continue;
    }
    if (result && namesPrereleaseOf(expandHyphenRange(alternative, false), version)) return true;
  }
  return anyUnknown ? undefined : false;
}

/** Whether a comparator in `alternative` targets a prerelease on `version`'s tuple. */
function namesPrereleaseOf(alternative: string, version: SemVer): boolean {
  for (const comparator of comparatorsOf(alternative)) {
    const rest = COMPARATOR_RE.exec(comparator)?.groups?.["rest"];
    const target = rest === undefined ? undefined : parseSemver(rest);
    if (
      target !== undefined &&
      target.prerelease !== "" &&
      target.major === version.major &&
      target.minor === version.minor &&
      target.patch === version.patch
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// workspace globs

/**
 * Match a workspace glob (`packages/*`, `apps/**`, `packages/tool-*`) against
 * a directory path relative to the workspace root.
 *
 * Only the two wildcards npm, bun, pnpm and yarn workspaces actually use are
 * supported: `*` within one segment and `**` across segments. Negations
 * (`!packages/private`) are not, and a caller passing one gets no match rather
 * than a wrong one.
 */
export function matchWorkspaceGlob(dir: string, pattern: string): boolean {
  if (pattern.startsWith("!")) return false;
  const cleaned = pattern.replace(/\/+$/, "");
  const escaped = cleaned.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*/g, "@@GLOBSTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/@@GLOBSTAR@@/g, ".*");
  return new RegExp(`^${body}$`).test(dir.replace(/\/+$/, ""));
}
