/**
 * Where a dependency's version lives inside a manifest — every spelling this
 * package can locate EXACTLY, and an explicit refusal for every one it
 * cannot.
 *
 * This is the read half of `ManifestDependencySet` and the whole of what
 * `RegistryOutdated` needs from a project: a list of declared dependencies
 * with the byte span of each version, so a bump is a splice and nothing else
 * in the file moves.
 *
 * The refusals are the point. A dependency can be written a dozen ways across
 * three manifest formats, and the ones that cannot be located exactly — a git
 * or path dependency with no version at all, a key declared twice, a
 * multi-line string, a requirement pinned to a URL — are reported as skipped,
 * with the reason, rather than rewritten on a guess. A best-effort write into
 * somebody's Cargo.toml is a corrupt Cargo.toml.
 */
import { locateJsonMember } from "./jsonspan";
import { normalizePypiName } from "./names";
import type { Ecosystem } from "./net";
import type { RangeDialect } from "./ranges";
import {
  type Span,
  type TomlEntry,
  type TomlScan,
  type TomlTable,
  inlineTableEntries,
  lineAt,
  lookupPath,
  scanToml,
  stringArrayElements,
  stringInner,
} from "./toml";

export type ManifestKind = "package.json" | "Cargo.toml" | "pyproject.toml";

export const MANIFEST_ECOSYSTEM: Readonly<Record<ManifestKind, Ecosystem>> = Object.freeze({
  "package.json": "npm",
  "Cargo.toml": "crates",
  "pyproject.toml": "pypi",
});

/** The shape a dependency is written in. Each one is located differently. */
export type Spelling =
  | "jsonString"
  | "tomlString"
  | "inlineTable"
  | "detachedTable"
  | "dottedKey"
  | "requirementString";

export type DependencySite = {
  readonly name: string;
  /** The declaring section, as written: "devDependencies", "target.cfg(unix).dependencies". */
  readonly section: string;
  readonly spelling: Spelling;
  /** The grammar THIS site's spec is written in — see `dialectForSection`. */
  readonly dialect: RangeDialect;
  /** The version spec exactly as written; empty when the requirement pins nothing. */
  readonly spec: string;
  /** The span to replace. Empty (start === end) when the spec has to be inserted. */
  readonly specSpan: Span;
  /** The quote around the spec, when it sits inside one. */
  readonly quote?: '"' | "'";
  readonly line: number;
};

export type SkippedSite = {
  readonly name: string;
  readonly section: string;
  readonly reason: string;
};

export type ManifestSites =
  | { readonly ok: true; readonly sites: DependencySite[]; readonly skipped: SkippedSite[] }
  | { readonly ok: false; readonly reason: string };

/** Which manifest a filename is, or `undefined` when it is not one we write. */
export function manifestKind(fileName: string): ManifestKind | undefined {
  const base = fileName.toLowerCase();
  if (base === "package.json") return "package.json";
  if (base === "cargo.toml") return "Cargo.toml";
  if (base === "pyproject.toml") return "pyproject.toml";
  return undefined;
}

const NPM_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Cargo and Poetry both end a dependency table with one of these. */
const TOML_DEP_TABLE_NAMES = new Set([
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "dev_dependencies",
]);

/**
 * Which range grammar a section's specs are written in.
 *
 * A pyproject.toml holds TWO, which is the whole reason this is a function of
 * the section rather than of the file: `[project] dependencies` is PEP 508,
 * whose specifiers are PEP 440, while every `[tool.poetry…]` table is Poetry's
 * own caret/tilde grammar. `requests = "^2.31"` is an ordinary Poetry pin and
 * not a PEP 440 specifier at all, so reading it as one loses the row.
 */
export function dialectForSection(kind: ManifestKind, section: string): RangeDialect {
  if (kind === "package.json") return "npm";
  if (kind === "Cargo.toml") return "cargo";
  return section === "tool.poetry" || section.startsWith("tool.poetry.") ? "poetry" : "pep440";
}

export function collectSites(kind: ManifestKind, text: string): ManifestSites {
  if (kind === "package.json") return collectNpmSites(text);
  const scan = scanToml(text);
  if (!scan.ok) return { ok: false, reason: `this file does not scan as TOML: ${scan.reason}` };
  return kind === "Cargo.toml" ? collectCargoSites(text, scan) : collectPyprojectSites(text, scan);
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

function collectNpmSites(text: string): ManifestSites {
  let parsed: unknown;
  try {
    // `JSON.parse` throws on a leading byte-order mark; the locator skips it,
    // so the two agree about what the document is.
    parsed = JSON.parse(text.startsWith("\ufeff") ? text.slice(1) : text);
  } catch (err) {
    return { ok: false, reason: `this file does not parse as JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "the manifest is not a JSON object" };
  }
  const sites: DependencySite[] = [];
  const skipped: SkippedSite[] = [];
  for (const section of NPM_SECTIONS) {
    const block = (parsed as Record<string, unknown>)[section];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    for (const name of Object.keys(block)) {
      const value = (block as Record<string, unknown>)[name];
      if (typeof value !== "string") {
        skipped.push({
          name,
          section,
          reason: `the entry is ${value === null ? "null" : typeof value}, not a version string`,
        });
        continue;
      }
      const located = locateJsonMember(text, [section, name]);
      if (!located.ok || located.inner === undefined) {
        skipped.push({
          name,
          section,
          reason: located.ok ? "the entry is not a string in the text" : located.reason,
        });
        continue;
      }
      const raw = text.slice(located.inner.start, located.inner.end);
      if (raw.includes("\\")) {
        // A JSON escape inside a version spec is not something any package
        // manager writes, and splicing next to one means reasoning about
        // escape boundaries. Refuse instead.
        skipped.push({ name, section, reason: "the declared spec contains a JSON escape" });
        continue;
      }
      sites.push({
        name,
        section,
        spelling: "jsonString",
        dialect: "npm",
        spec: raw,
        specSpan: located.inner,
        quote: '"',
        line: lineAt(text, located.inner.start),
      });
    }
  }
  return { ok: true, sites, skipped };
}

// ---------------------------------------------------------------------------
// Cargo.toml and Poetry — the same three spellings
// ---------------------------------------------------------------------------

type TomlDepTable = { readonly section: string; readonly table: TomlTable };

/** Tables that declare dependencies, plus the detached `[deps.name]` tables. */
function dependencyTables(scan: { tables: readonly TomlTable[] }): {
  direct: TomlDepTable[];
  detached: Array<{ section: string; name: string; table: TomlTable }>;
} {
  const direct: TomlDepTable[] = [];
  const detached: Array<{ section: string; name: string; table: TomlTable }> = [];
  for (const table of scan.tables) {
    if (table.arrayOfTables) continue;
    const last = table.path[table.path.length - 1];
    if (last !== undefined && TOML_DEP_TABLE_NAMES.has(last)) {
      direct.push({ section: table.path.join("."), table });
      continue;
    }
    const parent = table.path[table.path.length - 2];
    if (parent !== undefined && TOML_DEP_TABLE_NAMES.has(parent) && last !== undefined) {
      detached.push({ section: table.path.slice(0, -1).join("."), name: last, table });
    }
  }
  return { direct, detached };
}

function siteFromTomlEntry(
  kind: ManifestKind,
  text: string,
  section: string,
  name: string,
  entry: TomlEntry,
  spelling: Spelling,
): DependencySite | SkippedSite {
  const inner = stringInner(text, entry.kind, entry.valueSpan);
  if (inner === null) {
    return {
      name,
      section,
      reason:
        entry.kind === "multilineString"
          ? "the version is a multi-line string"
          : `the version is a ${entry.kind}, not a quoted string`,
    };
  }
  const raw = text.slice(inner.inner.start, inner.inner.end);
  if (inner.quote === '"' && raw.includes("\\")) {
    return { name, section, reason: "the declared spec contains a TOML escape" };
  }
  return {
    name,
    section,
    spelling,
    dialect: dialectForSection(kind, section),
    spec: raw,
    specSpan: inner.inner,
    quote: inner.quote,
    line: lineAt(text, inner.inner.start),
  };
}

function isSkipped(value: DependencySite | SkippedSite): value is SkippedSite {
  return (value as SkippedSite).reason !== undefined;
}

/**
 * Locate every dependency declared in the dependency tables of a TOML
 * manifest — the Cargo grammar, which Poetry borrows wholesale.
 */
function collectTomlTableSites(
  kind: ManifestKind,
  text: string,
  scan: TomlScan & { ok: true },
): { sites: DependencySite[]; skipped: SkippedSite[] } {
  const sites: DependencySite[] = [];
  const skipped: SkippedSite[] = [];
  const { direct, detached } = dependencyTables(scan);

  for (const { section, table } of direct) {
    // Group by dependency name first: `serde = "1"`, `serde.version = "1"`
    // and `serde.features = [...]` are all entries of this table, and the
    // dependency is the first key part either way.
    const byName = new Map<string, TomlEntry[]>();
    for (const entry of table.entries) {
      const name = entry.keyParts[0];
      if (name === undefined) continue;
      const list = byName.get(name) ?? [];
      list.push(entry);
      byName.set(name, list);
    }
    for (const [name, entries] of byName) {
      const plains = entries.filter((e) => e.keyParts.length === 1);
      const dotteds = entries.filter((e) => e.keyParts.length === 2 && e.keyParts[1] === "version");
      const declarations = [...plains, ...dotteds];
      if (declarations.length > 1) {
        // Every version this name has in this table, not just the first two
        // spellings. `serde = "1"` twice is a duplicate key that a real TOML
        // parser rejects outright, and taking the first silently edits one of
        // them and leaves a file that still says two different things.
        const lines = declarations
          .map((entry) => lineAt(text, entry.keySpan.start))
          .sort((a, b) => a - b);
        skipped.push({
          name,
          section,
          reason: `the dependency is declared ${declarations.length} times in the same table (lines ${lines.join(", ")})`,
        });
        continue;
      }
      const plain = plains[0];
      const dotted = dotteds[0];
      if (dotted !== undefined) {
        const site = siteFromTomlEntry(kind, text, section, name, dotted, "dottedKey");
        if (isSkipped(site)) skipped.push(site);
        else sites.push(site);
        continue;
      }
      if (plain === undefined) {
        // Only auxiliary keys (`serde.features`) — the version, if there is
        // one, lives somewhere this loop is not looking.
        skipped.push({ name, section, reason: "no version key is declared beside it" });
        continue;
      }
      if (plain.kind === "inlineTable") {
        const fields = inlineTableEntries(text, plain.valueSpan);
        if (fields === null) {
          skipped.push({ name, section, reason: "the inline table could not be read exactly" });
          continue;
        }
        const version = fields.find((f) => f.keyParts.length === 1 && f.keyParts[0] === "version");
        if (version === undefined) {
          const others = fields.map((f) => f.keyParts.join(".")).sort();
          skipped.push({
            name,
            section,
            // A git, path or workspace dependency has no registry version to
            // write, and inventing a `version` key for it would change what
            // the dependency IS.
            reason: `the inline table declares no version (it has ${others.join(", ") || "nothing"})`,
          });
          continue;
        }
        const site = siteFromTomlEntry(kind, text, section, name, version, "inlineTable");
        if (isSkipped(site)) skipped.push(site);
        else sites.push(site);
        continue;
      }
      const site = siteFromTomlEntry(kind, text, section, name, plain, "tomlString");
      if (isSkipped(site)) skipped.push(site);
      else sites.push(site);
    }
  }

  for (const { section, name, table } of detached) {
    const versions = table.entries.filter(
      (e) => e.keyParts.length === 1 && e.keyParts[0] === "version",
    );
    if (versions.length > 1) {
      const lines = versions
        .map((entry) => lineAt(text, entry.keySpan.start))
        .sort((a, b) => a - b);
      skipped.push({
        name,
        section,
        reason: `the table declares a version ${versions.length} times (lines ${lines.join(", ")})`,
      });
      continue;
    }
    const version = versions[0];
    if (version === undefined) {
      skipped.push({ name, section, reason: "the detached table declares no version key" });
      continue;
    }
    const site = siteFromTomlEntry(kind, text, section, name, version, "detachedTable");
    if (isSkipped(site)) skipped.push(site);
    else sites.push(site);
  }
  return { sites, skipped };
}

function collectCargoSites(text: string, scan: TomlScan & { ok: true }): ManifestSites {
  const { sites, skipped } = collectTomlTableSites("Cargo.toml", text, scan);
  return { ok: true, sites, skipped };
}

// ---------------------------------------------------------------------------
// pyproject.toml — PEP 621 arrays on top of the Poetry tables
// ---------------------------------------------------------------------------

/** Array-valued dependency lists: PEP 621 and PEP 735. */
function requirementArrays(scan: TomlScan & { ok: true }): Array<{ section: string; span: Span }> {
  const out: Array<{ section: string; span: Span }> = [];
  for (const entry of lookupPath(scan, ["project", "dependencies"])) {
    if (entry.entry.kind === "array") {
      out.push({ section: "project.dependencies", span: entry.entry.valueSpan });
    }
  }
  for (const table of scan.tables) {
    const path = table.path.join(".");
    const isOptional = path === "project.optional-dependencies";
    const isGroups = path === "dependency-groups";
    if (!isOptional && !isGroups) continue;
    for (const entry of table.entries) {
      if (entry.kind !== "array" || entry.keyParts.length !== 1) continue;
      out.push({ section: `${path}.${entry.keyParts[0]}`, span: entry.valueSpan });
    }
  }
  return out;
}

export type ParsedRequirement = {
  readonly name: string;
  /** Offsets WITHIN the requirement text. */
  readonly specStart: number;
  readonly specEnd: number;
  readonly spec: string;
};

const REQUIREMENT_HEAD = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[^\]]*\])?/;

/**
 * The PEP 508 subset a version can be spliced into: a name, optional extras,
 * an optional specifier and an optional marker. A URL requirement
 * (`foo @ https://…`) has no specifier to replace and comes back `null`, as
 * does anything else that does not match this shape.
 */
export function parseRequirement(raw: string): ParsedRequirement | null {
  const head = REQUIREMENT_HEAD.exec(raw);
  if (head === null) return null;
  const name = head[1] as string;
  const cursor = head[0].length;
  const rest = raw.slice(cursor);
  if (rest.trimStart().startsWith("@")) return null;
  const markerAt = rest.indexOf(";");
  const region = markerAt === -1 ? rest : rest.slice(0, markerAt);
  const trimmed = region.trim();
  if (trimmed === "") {
    // Nothing is pinned, so the span is the empty one right after the name and
    // its extras — an INSERTION point, not the end of the line. `tomli ;
    // python_version < "3.11"` becomes `tomli>=2 ; python_version < "3.11"`,
    // with the author's spacing and the marker both intact.
    return { name, specStart: cursor, specEnd: cursor, spec: "" };
  }
  const specStart = cursor + (region.length - region.trimStart().length);
  return { name, specStart, specEnd: specStart + trimmed.length, spec: trimmed };
}

function collectPyprojectSites(text: string, scan: TomlScan & { ok: true }): ManifestSites {
  const { sites, skipped } = collectTomlTableSites("pyproject.toml", text, scan);
  for (const { section, span } of requirementArrays(scan)) {
    const elements = stringArrayElements(text, span);
    if (elements === null) {
      skipped.push({
        name: "*",
        section,
        // PEP 735's `{include-group = "…"}` lives in these arrays too, and a
        // nested array or a multi-line string would put element boundaries
        // where this locator cannot see them.
        reason: "the list holds something other than single-line strings",
      });
      continue;
    }
    for (const element of elements) {
      const raw = text.slice(element.inner.start, element.inner.end);
      if (element.quote === '"' && raw.includes("\\")) {
        skipped.push({ name: raw, section, reason: "the requirement contains a TOML escape" });
        continue;
      }
      const requirement = parseRequirement(raw);
      if (requirement === null) {
        skipped.push({
          name: raw.slice(0, 60),
          section,
          reason: "the requirement is a URL or a shape this package does not edit",
        });
        continue;
      }
      sites.push({
        name: requirement.name,
        section,
        spelling: "requirementString",
        dialect: dialectForSection("pyproject.toml", section),
        spec: requirement.spec,
        specSpan: {
          start: element.inner.start + requirement.specStart,
          end: element.inner.start + requirement.specEnd,
        },
        quote: element.quote,
        line: lineAt(text, element.inner.start),
      });
    }
  }
  return { ok: true, sites, skipped };
}

// ---------------------------------------------------------------------------
// matching a caller's name to a site
// ---------------------------------------------------------------------------

/** Names match the way their ecosystem matches them: PEP 503 folds, npm does not. */
export function namesMatch(ecosystem: Ecosystem, a: string, b: string): boolean {
  if (ecosystem === "pypi") return normalizePypiName(a) === normalizePypiName(b);
  if (ecosystem === "crates") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export type StyledSpec = {
  readonly spec: string;
  readonly preserved: boolean;
  readonly note?: string;
};

/**
 * A spec that is exactly one operator followed by one plain numeric version.
 * `1.x` and `1.0.post1` deliberately do NOT match: a wildcard and a PEP 440
 * post-release are styles with no prefix to reapply, and turning `1.x` into
 * `1.3.0` silently narrows a range the author wrote wide.
 */
const SINGLE_PREFIX = /^(\^|~=|~|>=|<=|==|=|>|<)?\s*(v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * Prefixes whose meaning survives having the version swapped underneath them.
 *
 * `<` and `>` do not, and that is the trap: carrying `<` from `<2.0.0` onto a
 * bump to 2.5.0 writes `<2.5.0`, a range that EXCLUDES the very version the
 * caller asked to set, and reports it as a preserved style. An exclusive bound
 * is a deliberate ceiling somebody wrote; moving it is a decision, not a
 * detail, so the new spec goes in verbatim and the note says the old bound was
 * dropped.
 */
const CARRYABLE_PREFIX = new Set(["", "^", "~", "~=", ">=", "<=", "==", "="]);

/**
 * Carry the old spec's range style onto a new bare version.
 *
 * The rule is narrow on purpose, because "preserve the style" is ambiguous
 * for everything that is not a single prefix. `>=1 <3`, `1.x`, `workspace:*`,
 * `npm:alias@^2` and `>=2,<3` each have a style, and none of them has a
 * prefix to reapply — so the new spec is written verbatim and the result says
 * the style was not preserved, rather than inventing `^>=1 <3`.
 */
export function reapplyStyle(oldSpec: string, newSpec: string): StyledSpec {
  const incoming = SINGLE_PREFIX.exec(newSpec.trim());
  if (incoming === null || incoming[1] !== undefined) {
    return {
      spec: newSpec.trim(),
      preserved: false,
      note:
        incoming === null
          ? "the new spec is not a bare version, so it was written as given"
          : "the new spec carries its own operator, which wins over the old one",
    };
  }
  if (oldSpec.trim() === "") {
    return {
      spec: newSpec.trim(),
      preserved: false,
      note: "the previous declaration pinned nothing, so there was no style to carry over",
    };
  }
  const previous = SINGLE_PREFIX.exec(oldSpec.trim());
  if (previous === null) {
    return {
      spec: newSpec.trim(),
      preserved: false,
      note: `"${oldSpec}" is not a single-prefix range, so its style could not be carried over`,
    };
  }
  const prefix = previous[1] ?? "";
  if (!CARRYABLE_PREFIX.has(prefix)) {
    return {
      spec: newSpec.trim(),
      preserved: false,
      note: `"${oldSpec}" is an exclusive bound, and carrying "${prefix}" over would write a range that excludes ${newSpec.trim()} — the bound was dropped instead`,
    };
  }
  return { spec: `${prefix}${newSpec.trim()}`, preserved: true };
}

export type SpliceCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Re-read the spliced text and prove it says what the edit meant.
 *
 * The splice itself is arithmetic on offsets, and arithmetic on offsets is
 * how a file gets shifted by one byte and silently broken. So the result is
 * parsed again by the same locator and compared POSITIONALLY against the
 * sites the edit was planned on: same count, same name, section and spelling
 * at every position, the new spec where it was edited and the old one
 * everywhere else.
 *
 * Positional, not keyed by name: a pyproject.toml can legitimately declare
 * the same package twice in one list under different environment markers
 * (`tomli ; python_version < "3.11"` beside a newer pin), and a map keyed by
 * name would fold those two rows into one and stop noticing which of them
 * moved. This runs BEFORE anything is written, so a disagreement costs a
 * refusal rather than a manifest.
 */
export function verifySplice(
  kind: ManifestKind,
  after: string,
  planned: {
    readonly sites: readonly DependencySite[];
    readonly skipped: readonly SkippedSite[];
    readonly edits: ReadonlyArray<{ site: DependencySite; spec: string }>;
  },
): SpliceCheck {
  const reread = collectSites(kind, after);
  if (!reread.ok) return { ok: false, reason: `the edited file no longer reads: ${reread.reason}` };
  if (reread.sites.length !== planned.sites.length) {
    return {
      ok: false,
      reason: `the edit changed how many dependencies the file declares (${planned.sites.length} before, ${reread.sites.length} after)`,
    };
  }
  if (reread.skipped.length !== planned.skipped.length) {
    return { ok: false, reason: "the edit changed which declarations cannot be placed" };
  }
  const edited = new Map<DependencySite, string>();
  for (const edit of planned.edits) edited.set(edit.site, edit.spec);

  for (let index = 0; index < planned.sites.length; index++) {
    const was = planned.sites[index] as DependencySite;
    const now = reread.sites[index] as DependencySite;
    if (was.name !== now.name || was.section !== now.section || was.spelling !== now.spelling) {
      return {
        ok: false,
        reason: `after the edit, "${was.section}/${was.name}" reads as "${now.section}/${now.name}"`,
      };
    }
    const want = edited.get(was) ?? was.spec;
    if (now.spec !== want) {
      return {
        ok: false,
        reason: `"${was.name}" in ${was.section} reads "${now.spec}" after the edit, not "${want}"`,
      };
    }
  }
  return { ok: true };
}

/**
 * Text that is safe to splice into a spec span.
 *
 * This is the last gate before bytes go into somebody's manifest, and it is
 * strict on purpose: a spec of `1.0", "evil": "9` would close the JSON string
 * and add a key, and `1.0" } # ` would do the same to an inline table. A
 * version range needs none of those characters, so none of them are allowed.
 */
export function checkSpecText(spec: string, quote: '"' | "'" | undefined): string | undefined {
  if (spec === "") return "the replacement spec is empty";
  if (spec.length > 200) return "the replacement spec is implausibly long";
  if (spec !== spec.trim()) return "the replacement spec has leading or trailing whitespace";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is being rejected.
  if (/[\u0000-\u001f\u007f]/.test(spec)) {
    return "the replacement spec contains a control character";
  }
  if (spec.includes("\\")) return "the replacement spec contains a backslash";
  if (spec.includes('"')) return "the replacement spec contains a double quote";
  if (quote === "'" && spec.includes("'")) return "the replacement spec contains a single quote";
  if (spec.includes("#")) return "the replacement spec contains a comment character";
  return undefined;
}
