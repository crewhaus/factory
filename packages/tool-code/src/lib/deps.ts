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

export type LockedVersion = {
  readonly name: string;
  readonly version: string;
};

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
 * `packages` map holds `"<key>": ["<name>@<version>", …]`.
 *
 * `bun.lockb`, the older binary lockfile, is not readable here at all; the
 * tools say so rather than returning an empty list that looks like "no
 * dependencies".
 */
export function parseBunLock(text: string): LockedVersion[] {
  const root = asRecord(parseJsonc(text));
  const packages = asRecord(root?.["packages"]);
  if (packages === undefined) return [];
  const out: LockedVersion[] = [];
  for (const [key, value] of Object.entries(packages)) {
    const spec =
      Array.isArray(value) && typeof value[0] === "string" ? (value[0] as string) : undefined;
    const split = spec === undefined ? undefined : splitNameVersion(spec);
    if (split === undefined) continue;
    // A workspace member is recorded with an empty or non-semver version.
    out.push({ name: split.name === "" ? key : split.name, version: split.version });
  }
  return dedupeLocked(out);
}

/** `package-lock.json` v2/v3 — the `packages` map keyed by install path. */
export function parsePackageLock(text: string): LockedVersion[] {
  const root = asRecord(parseJsonc(text));
  if (root === undefined) return [];
  const out: LockedVersion[] = [];
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
      out.push({ name, version });
    }
  }
  // v1 lockfiles keep a `dependencies` tree instead.
  const legacy = asRecord(root["dependencies"]);
  if (packages === undefined && legacy !== undefined) {
    for (const [name, value] of Object.entries(legacy)) {
      const record = asRecord(value);
      const version =
        typeof record?.["version"] === "string" ? (record["version"] as string) : undefined;
      if (version !== undefined) out.push({ name, version });
    }
  }
  return dedupeLocked(out);
}

/**
 * `yarn.lock`, both dialects: classic (`version "1.2.3"`) and berry
 * (`version: 1.2.3`). The entry key carries the name, which may be quoted,
 * comma-separated and suffixed with `@npm:`.
 */
export function parseYarnLock(text: string): LockedVersion[] {
  const out: LockedVersion[] = [];
  let names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      names = [];
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
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (m === null) continue;
    for (const name of names) out.push({ name, version: m[1] as string });
    names = [];
  }
  return dedupeLocked(out);
}

function dedupeLocked(items: readonly LockedVersion[]): LockedVersion[] {
  const seen = new Set<string>();
  const out: LockedVersion[] = [];
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

/** `Cargo.lock`: repeated `[[package]]` tables with a name and a version. */
export function parseCargoLock(text: string): LockedVersion[] {
  const out: LockedVersion[] = [];
  let name: string | undefined;
  let version: string | undefined;
  const flush = (): void => {
    if (name !== undefined && version !== undefined) out.push({ name, version });
    name = undefined;
    version = undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "[[package]]") {
      flush();
      continue;
    }
    const m = /^(name|version)\s*=\s*"([^"]*)"$/.exec(line);
    if (m === null) continue;
    if (m[1] === "name") name = m[2] as string;
    else version = m[2] as string;
  }
  flush();
  return dedupeLocked(out);
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

/** Compare two versions, prereleases ordering below their release. */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function satisfiesComparator(version: SemVer, comparator: string): boolean | undefined {
  const text = comparator.trim();
  if (text === "" || text === "*" || text === "x" || text === "latest") return true;
  const m = /^(?<op>\^|~|>=|<=|>|<|=)?\s*(?<rest>.+)$/.exec(text);
  if (m === null) return undefined;
  const op = m.groups?.["op"] ?? "";
  const restRaw = (m.groups?.["rest"] as string).trim();
  if (/^(workspace|path|file|link|npm|git|https?|latest)/.test(restRaw)) return undefined;
  const wildcard = /^(?<major>\d+)(?:\.(?<minor>\d+))?\.(?:x|\*)$/.exec(restRaw);
  if (wildcard !== null && op === "") {
    const major = Number(wildcard.groups?.["major"]);
    const minor = wildcard.groups?.["minor"];
    if (version.major !== major) return false;
    return minor === undefined ? true : version.minor === Number(minor);
  }
  const target = parseSemver(restRaw);
  if (target === undefined) return undefined;
  const cmp = compareSemver(version, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    case "=":
    case "":
      return cmp === 0;
    case "^": {
      if (cmp < 0) return false;
      if (target.major > 0) return version.major === target.major;
      if (target.minor > 0) return version.major === 0 && version.minor === target.minor;
      return version.major === 0 && version.minor === 0 && version.patch === target.patch;
    }
    case "~": {
      if (cmp < 0) return false;
      return version.major === target.major && version.minor === target.minor;
    }
    default:
      return undefined;
  }
}

/**
 * Does `version` satisfy `range`?
 *
 * `undefined` means "cannot tell" — a `workspace:*` protocol, a git URL, a
 * hyphen range — and every caller treats that as unchecked rather than as
 * false. This is a deliberately small subset of node-semver: caret, tilde,
 * the four inequalities, exact, `x`-wildcards, whitespace-joined AND and
 * `||`-joined OR. Enough for the ranges real manifests hold, and honest about
 * the rest.
 */
export function satisfies(versionRaw: string, range: string): boolean | undefined {
  const version = parseSemver(versionRaw);
  if (version === undefined) return undefined;
  const alternatives = range.split("||");
  let anyKnown = false;
  for (const alternative of alternatives) {
    const comparators = alternative
      .trim()
      .split(/\s+/)
      .filter((c) => c !== "");
    if (comparators.length === 0) return true;
    let all = true;
    let known = true;
    for (const comparator of comparators) {
      const result = satisfiesComparator(version, comparator);
      if (result === undefined) {
        known = false;
        break;
      }
      if (!result) all = false;
    }
    if (!known) continue;
    anyKnown = true;
    if (all) return true;
  }
  return anyKnown ? false : undefined;
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
