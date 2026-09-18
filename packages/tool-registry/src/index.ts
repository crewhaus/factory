/**
 * @crewhaus/tool-registry — what the public package registries know, and
 * writing one answer back into a manifest.
 *
 * Three of these tools read npm, PyPI and crates.io over anonymous HTTP and
 * return one normalized shape each. The fourth writes a version into a
 * package.json, a Cargo.toml or a pyproject.toml by splicing the exact bytes
 * of one version string, and refuses every shape it cannot locate exactly.
 *
 * Two rules run through all of it:
 *
 *   1. **An absent field means the registry does not publish it.** npm's
 *      search has no download counts and PyPI has no search endpoint at all.
 *      Filling those in from somewhere else, or sorting one page and calling
 *      it a ranking, would be a shortlist chosen on a number nobody measured.
 *   2. **A write is a splice or a refusal.** There is no reserialize path in
 *      this package. A manifest that comes back from an edit differs from the
 *      one that went in by exactly the bytes of the versions that changed —
 *      comments, key order, indentation and trailing newline included — and
 *      the edit is verified by re-reading the result before it is written.
 *
 * The network seam is `_setRegistryFetch`, exported below: every test in this
 * package drives it, and nothing in the suite resolves a name or opens a
 * socket.
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  type DependencySite,
  MANIFEST_ECOSYSTEM,
  type ManifestKind,
  checkSpecText,
  collectSites,
  manifestKind,
  namesMatch,
  reapplyStyle,
  verifySplice,
} from "./lib/manifest";
import {
  DEFAULT_TIMEOUT_MS,
  type Ecosystem,
  MAX_TIMEOUT_MS,
  byString,
  json,
  mapPool,
  startDeadline,
} from "./lib/net";
import {
  DIALECT_BY_ECOSYSTEM,
  type RangeDialect,
  highestSatisfying,
  isSemverShaped,
  sortVersionsDescending,
  toNpmRange,
  toNpmRangeIn,
  versionDelta,
  versionSatisfies,
} from "./lib/ranges";
import {
  type PackageResult,
  type SearchSort,
  fetchPackage,
  searchRegistry,
} from "./lib/registries";
import { resolveSafe } from "./paths";

export { _setRegistryFetch, type RegistryFetch } from "./lib/net";

/** A manifest larger than this is not a manifest. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const ecosystemField = z
  .enum(["npm", "pypi", "crates"])
  .describe("npm (registry.npmjs.org), pypi (pypi.org) or crates (crates.io)");

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`deadline for the whole call in ms; default ${DEFAULT_TIMEOUT_MS}`);

const NETWORK_TOOL = {
  readOnly: true,
  concurrencySafe: true,
  // Pillar 3 sink-side: these cross a network boundary, so they declare it and
  // lower external. The destinations are three constants, but "we only talk to
  // npm" is not a reason to hide the fact that bytes leave the process.
  scope: "external",
  ioCapability: "network",
} as const;

/** What went wrong, in the one line a tool returns when it cannot answer. */
function failureLine(
  tool: string,
  ecosystem: Ecosystem,
  name: string,
  result: PackageResult,
): string {
  if (result.ok) return "";
  return `${tool} could not read ${ecosystem} package "${name}": ${result.message}`;
}

// ---------------------------------------------------------------------------

export const registryPackageInfo: RegisteredTool = buildTool({
  name: "RegistryPackageInfo",
  description:
    "Ask a public registry what it knows about one package: whether it exists, its latest version and publish date, licence, repository, whether it is deprecated or yanked, and optionally its version list. Use it before adding a dependency, or to settle 'is this still maintained' without a model recalling a version number. Reads npm, PyPI and crates.io anonymously over HTTPS; it never authenticates, never installs and never reaches a private mirror. A package that is not published comes back as exists:false rather than as an error, because that is an answer. Fields the registry does not publish are left out rather than guessed at.",
  inputSchema: z
    .object({
      ecosystem: ecosystemField,
      name: z.string().min(1).max(256).describe("the package name, as the registry spells it"),
      version: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("also answer whether this exact version is published"),
      range: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("also resolve what this range would install today"),
      includeVersions: z.boolean().optional().describe("include the version list, newest first"),
      maxVersions: z.number().int().positive().max(2_000).optional().describe("cap it; default 50"),
      includePrerelease: z.boolean().optional(),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const result = await fetchPackage(input.ecosystem, input.name, { signal: deadline.signal });
      if (!result.ok) {
        if (result.kind === "notFound") {
          return json({ ecosystem: input.ecosystem, name: input.name, exists: false });
        }
        return failureLine("RegistryPackageInfo", input.ecosystem, input.name, result);
      }

      const limit = input.maxVersions ?? 50;
      const newestFirst = sortVersionsDescending(result.versions);
      const body: Record<string, unknown> = {
        ecosystem: result.ecosystem,
        name: result.name,
        exists: true,
        ...(result.latest === undefined ? {} : { latest: result.latest }),
        ...(result.latestPublishedAt === undefined
          ? {}
          : { latestPublishedAt: result.latestPublishedAt }),
        ...(result.description === undefined ? {} : { description: result.description }),
        ...(result.license === undefined ? {} : { license: result.license }),
        ...(result.homepage === undefined ? {} : { homepage: result.homepage }),
        ...(result.repository === undefined ? {} : { repository: result.repository }),
        ...(result.deprecated === undefined ? {} : { deprecated: result.deprecated }),
        ...(result.yanked === true ? { latestIsYanked: true } : {}),
        versionCount: result.versions.length,
        ...(result.yankedVersions.length === 0
          ? {}
          : { yankedCount: result.yankedVersions.length }),
        ...(result.versionListUnavailable === true ? { versionListUnavailable: true } : {}),
      };

      if (input.includeVersions === true) {
        body["versions"] = newestFirst.slice(0, limit);
        if (newestFirst.length > limit) body["versionsTruncated"] = true;
      }
      if (input.version !== undefined) {
        body["requestedVersion"] = {
          version: input.version,
          published: result.versions.includes(input.version),
          yanked: result.yankedVersions.includes(input.version),
        };
      }
      if (input.range !== undefined) {
        const translated = toNpmRange(input.ecosystem, input.range);
        if (!translated.ok) {
          body["resolved"] = { range: input.range, resolved: null, note: translated.reason };
        } else {
          const wanted = highestSatisfying(
            result.versions,
            translated.range,
            input.includePrerelease === true,
          );
          body["resolved"] = {
            range: input.range,
            resolved: wanted ?? null,
            ...(wanted === undefined ? { note: "no published version satisfies this range" } : {}),
          };
        }
      }
      return json(body);
    } finally {
      deadline.cancel();
    }
  },
});

export const registrySearch: RegisteredTool = buildTool({
  name: "RegistrySearch",
  description:
    "Search a package registry's own index and return a structured shortlist — name, latest version, description, repository and, where the registry publishes it, a download count. Use it to find candidate libraries without spending a web search and a model turn on reading blog posts. npm and crates.io are supported; PyPI is refused with a reason, because it publishes no search API and scraping its HTML search page would be a tool that breaks silently on a redesign. Sorting is only reported as applied when the registry itself can do it: npm ranks by its own relevance score and publishes no download counts, so a downloads sort there is declined rather than faked by re-sorting one page.",
  inputSchema: z
    .object({
      ecosystem: ecosystemField,
      query: z.string().min(1).max(200).describe("free text, as you would type into the registry"),
      limit: z.number().int().positive().max(50).optional().describe("how many hits; default 10"),
      sort: z
        .enum(["relevance", "downloads", "recentlyUpdated"])
        .optional()
        .describe("relevance (default); the others apply on crates.io only"),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      const sort: SearchSort = input.sort ?? "relevance";
      const limit = input.limit ?? 10;
      const result = await searchRegistry(input.ecosystem, input.query, limit, sort, {
        signal: deadline.signal,
      });
      if (!result.ok) {
        return result.kind === "unsupported"
          ? result.message
          : `RegistrySearch could not search ${input.ecosystem}: ${result.message}`;
      }
      return json({
        ecosystem: input.ecosystem,
        query: input.query,
        sortRequested: sort,
        sortApplied: result.sortApplied,
        ...(result.sortNote === undefined ? {} : { sortNote: result.sortNote }),
        count: result.hits.length,
        ...(result.total === undefined ? {} : { total: result.total }),
        results: result.hits,
      });
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// reading a project's declared dependencies
// ---------------------------------------------------------------------------

const MANIFEST_FILES: readonly string[] = ["package.json", "Cargo.toml", "pyproject.toml"];

type LoadedManifest =
  | {
      readonly ok: true;
      readonly kind: ManifestKind;
      readonly rel: string;
      /** The resolved path, so the write uses the one that was READ. */
      readonly real: string;
      readonly text: string;
      /**
       * False when decoding the file as UTF-8 and re-encoding it does NOT
       * reproduce the bytes on disk. A splice is done on the decoded string,
       * so every byte the decoder replaced with U+FFFD would be written back
       * changed — a byte nobody asked to touch, arbitrarily far from the edit.
       */
      readonly lossless: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve a caller's path to exactly one manifest.
 *
 * A directory holding both a package.json and a pyproject.toml is refused
 * rather than resolved by a precedence rule nobody would remember: the
 * question "is anything outdated here" has two different answers in that
 * directory, and picking one silently answers the wrong one half the time.
 */
function loadManifest(tool: string, given: string): LoadedManifest {
  const at = resolveSafe(tool, given);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(at.real);
  } catch {
    return { ok: false, message: `${tool} found nothing at "${given}"` };
  }
  if (stat.isDirectory()) {
    const present = MANIFEST_FILES.filter((file) => {
      try {
        return statSync(join(at.real, file)).isFile();
      } catch {
        return false;
      }
    });
    if (present.length === 0) {
      return {
        ok: false,
        message: `${tool} found no package.json, Cargo.toml or pyproject.toml in "${given}"`,
      };
    }
    if (present.length > 1) {
      return {
        ok: false,
        message: `${tool} found ${present.join(" and ")} in "${given}" — name the one to read, because they are different dependency sets with different registries`,
      };
    }
    return loadManifest(tool, join(given, present[0] as string));
  }
  const kind = manifestKind(basename(at.real));
  if (kind === undefined) {
    return {
      ok: false,
      message: `${tool} does not read "${basename(at.real)}" — it reads package.json, Cargo.toml and pyproject.toml. A go.mod, a requirements.txt or a Gemfile is a different grammar, and guessing at one is how a manifest gets corrupted.`,
    };
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    return {
      ok: false,
      message: `${tool}: "${at.rel}" is ${stat.size} bytes, which is not a manifest`,
    };
  }
  const bytes = readFileSync(at.real);
  const text = bytes.toString("utf-8");
  return {
    ok: true,
    kind,
    rel: at.rel,
    real: at.real,
    text,
    lossless: Buffer.compare(Buffer.from(text, "utf-8"), bytes) === 0,
  };
}

/** Poetry declares the interpreter here, and it is not a package on PyPI. */
const NOT_A_PACKAGE = new Set(["python"]);

export const registryOutdated: RegisteredTool = buildTool({
  name: "RegistryOutdated",
  description:
    "Read a project's manifest, ask the registry what is newest for each dependency, and report the drift: the declared range, the highest version that range still allows, the latest published version, how far apart they are, and whether the package is deprecated or yanked. Use it to decide what to upgrade. It contacts npm, PyPI or crates.io anonymously — which is what separates it from DependencyOutdated in @crewhaus/tool-code, which compares a manifest against its own lockfile and never leaves the machine. A range it cannot evaluate exactly (a git or workspace spec, a PEP 440 '!=', a version that does not order as semver) is listed as unchecked with the reason, never counted as up to date.",
  inputSchema: z
    .object({
      manifest: z
        .string()
        .optional()
        .describe("workspace-relative manifest or directory; defaults to the workspace root"),
      ecosystem: ecosystemField
        .optional()
        .describe("required only with an explicit dependency list"),
      dependencies: z
        .array(
          z
            .object({
              name: z.string().min(1).max(256),
              spec: z.string().min(1).max(200).describe("the declared range, e.g. ^1.2.0"),
            })
            .strict(),
        )
        .max(500)
        .optional()
        .describe("ask about these instead of reading a manifest"),
      sections: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("only these manifest sections, e.g. dependencies"),
      onlyOutdated: z.boolean().optional().describe("drop the rows that are already current"),
      includePrerelease: z.boolean().optional(),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("requests in flight; default 4, which is polite to crates.io"),
      maxPackages: z.number().int().positive().max(500).optional().describe("cap; default 200"),
      timeoutMs: timeoutField,
    })
    .strict(),
  ...NETWORK_TOOL,
  execute: async (input, ctx) => {
    const deadline = startDeadline(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx?.signal);
    try {
      let ecosystem: Ecosystem;
      // Only the three fields this tool asks the registry about. A manifest
      // site carries a byte span too, and a span means nothing for a
      // dependency a caller typed out.
      let declared: Array<{ name: string; section: string; spec: string; dialect: RangeDialect }>;
      let skipped: Array<{ name: string; section: string; reason: string }> = [];
      let manifestLabel: string | undefined;

      if (input.dependencies !== undefined) {
        if (input.ecosystem === undefined) {
          return "RegistryOutdated needs an ecosystem when it is given a dependency list, because a name means a different package on each registry.";
        }
        ecosystem = input.ecosystem;
        declared = input.dependencies.map((dep) => ({
          name: dep.name,
          section: "(given)",
          spec: dep.spec,
          // A caller typing out a list names the registry, not a table, so
          // the registry's own dialect is all there is to go on.
          dialect: DIALECT_BY_ECOSYSTEM[ecosystem],
        }));
      } else {
        const loaded = loadManifest("RegistryOutdated", input.manifest ?? ".");
        if (!loaded.ok) return loaded.message;
        const collected = collectSites(loaded.kind, loaded.text);
        if (!collected.ok)
          return `RegistryOutdated could not read "${loaded.rel}": ${collected.reason}`;
        ecosystem = MANIFEST_ECOSYSTEM[loaded.kind];
        if (input.ecosystem !== undefined && input.ecosystem !== ecosystem) {
          return `RegistryOutdated reads ${loaded.rel} against ${ecosystem}, not ${input.ecosystem}.`;
        }
        declared = collected.sites.map((site) => ({
          name: site.name,
          section: site.section,
          spec: site.spec,
          // Read with the grammar of the TABLE it was written in: one
          // pyproject.toml holds both PEP 508 arrays and Poetry tables.
          dialect: site.dialect,
        }));
        skipped = collected.skipped;
        manifestLabel = loaded.rel;
      }

      const wanted = input.sections;
      if (wanted !== undefined) {
        const present = [...new Set(declared.map((dep) => dep.section))].sort(byString);
        declared = declared.filter((dep) => wanted.includes(dep.section));
        if (declared.length === 0 && present.length > 0) {
          // An empty table because a section name was misspelled reads exactly
          // like an empty table because nothing is declared. Say which it is.
          return `RegistryOutdated matched no dependency in ${wanted.join(", ")} — the sections declared here are ${present.join(", ")}.`;
        }
      }
      for (const dep of declared.filter((d) => NOT_A_PACKAGE.has(d.name.toLowerCase()))) {
        skipped.push({
          name: dep.name,
          section: dep.section,
          reason: "this is the interpreter constraint, not a package on the registry",
        });
      }
      declared = declared.filter((dep) => !NOT_A_PACKAGE.has(dep.name.toLowerCase()));

      const cap = input.maxPackages ?? 200;
      const uniqueNames = [...new Set(declared.map((dep) => dep.name))].sort(byString);
      const queried = uniqueNames.slice(0, cap);
      const results = await mapPool(queried, input.concurrency ?? 4, (name) =>
        fetchPackage(ecosystem, name, {
          signal: deadline.signal,
          // The install-sized npm document: dist-tags, the version list and
          // each version's deprecation, without the per-release descriptions
          // and licences that would make fifty of these enormous.
          abbreviated: true,
        }),
      );
      const byName = new Map<string, PackageResult>();
      queried.forEach((name, index) => byName.set(name, results[index] as PackageResult));

      const rows: Array<Record<string, unknown>> = [];
      const unchecked: Array<Record<string, unknown>> = [];
      for (const dep of declared) {
        const result = byName.get(dep.name);
        if (result === undefined) {
          unchecked.push({
            name: dep.name,
            section: dep.section,
            current: dep.spec,
            reason: `not asked about — the ${cap}-package cap was reached`,
          });
          continue;
        }
        if (!result.ok) {
          unchecked.push({
            name: dep.name,
            section: dep.section,
            current: dep.spec,
            reason: result.kind === "notFound" ? "not published on this registry" : result.message,
          });
          continue;
        }
        const translated = toNpmRangeIn(dep.dialect, dep.spec);
        const latest = result.latest;
        if (!translated.ok) {
          unchecked.push({
            name: dep.name,
            section: dep.section,
            current: dep.spec,
            ...(latest === undefined ? {} : { latest }),
            reason: translated.reason,
          });
          continue;
        }
        if (latest === undefined) {
          unchecked.push({
            name: dep.name,
            section: dep.section,
            current: dep.spec,
            reason: "the registry names no latest version for this package",
          });
          continue;
        }
        const allows = versionSatisfies(latest, translated.range);
        if (allows === undefined) {
          unchecked.push({
            name: dep.name,
            section: dep.section,
            current: dep.spec,
            latest,
            reason: isSemverShaped(latest)
              ? `"${dep.spec}" is not a range this package evaluates`
              : `"${latest}" does not order as semver, so nothing can be said about the gap`,
          });
          continue;
        }
        const highest = highestSatisfying(
          result.versions,
          translated.range,
          input.includePrerelease === true,
        );
        const delta = highest === undefined ? undefined : versionDelta(highest, latest);
        rows.push({
          name: dep.name,
          section: dep.section,
          current: dep.spec,
          ...(highest === undefined ? {} : { wanted: highest }),
          latest,
          ...(result.latestPublishedAt === undefined
            ? {}
            : { latestPublishedAt: result.latestPublishedAt }),
          upToDate: allows,
          ...(delta === undefined || delta === "same" ? {} : { delta }),
          ...(result.deprecated === undefined ? {} : { deprecated: result.deprecated }),
          ...(result.yanked === true ? { latestIsYanked: true } : {}),
        });
      }

      rows.sort((a, b) => byString(String(a["name"]), String(b["name"])));
      unchecked.sort((a, b) => byString(String(a["name"]), String(b["name"])));
      const outdated = rows.filter((row) => row["upToDate"] !== true);
      // `outdatedCount: 0` over an empty table reads exactly like "everything
      // is current", and it is the answer a tool gives when it compared
      // nothing at all — a manifest whose declarations it could not locate,
      // or whose ranges it could not evaluate. Say which happened.
      const note =
        rows.length > 0
          ? undefined
          : declared.length === 0
            ? `no dependency declaration was located${manifestLabel === undefined ? "" : ` in ${manifestLabel}`}, so nothing was compared — outdatedCount says nothing about this project`
            : `none of the ${declared.length} declarations found could be compared against the registry — every one is in "unchecked" with its reason, and outdatedCount says nothing about this project`;
      return json({
        ...(manifestLabel === undefined ? {} : { manifest: manifestLabel }),
        ecosystem,
        checked: rows.length,
        outdatedCount: outdated.length,
        ...(note === undefined ? {} : { note }),
        rows: input.onlyOutdated === true ? outdated : rows,
        ...(unchecked.length === 0 ? {} : { unchecked }),
        ...(skipped.length === 0 ? {} : { skipped }),
        ...(uniqueNames.length > queried.length
          ? { truncated: true, packagesSeen: uniqueNames.length }
          : {}),
      });
    } finally {
      deadline.cancel();
    }
  },
});

// ---------------------------------------------------------------------------
// writing one back
// ---------------------------------------------------------------------------

export const manifestDependencySet: RegisteredTool = buildTool({
  name: "ManifestDependencySet",
  description:
    "Set the version of one or more dependencies already declared in a package.json, Cargo.toml or pyproject.toml, preserving the file exactly — comments, key order, indentation and trailing newline all survive, because only the bytes of the version string are replaced. Use it to apply an upgrade without a model rewriting a manifest from memory. It locates every spelling it can locate exactly (a JSON string, a TOML string, an inline table's version key, a dotted key, a [dependencies.name] table, a PEP 621 requirement string) and REFUSES the whole write when any requested edit is a shape it cannot place — a git or path dependency, a duplicate key, a URL requirement — naming which one and why. It never adds a dependency, never removes one, never reserializes, and never runs a package manager, so a lockfile is left stale on purpose.",
  inputSchema: z
    .object({
      manifest: z
        .string()
        .min(1)
        .describe("workspace-relative path to the manifest FILE, e.g. packages/app/package.json"),
      edits: z
        .array(
          z
            .object({
              name: z.string().min(1).max(256),
              spec: z.string().min(1).max(200).describe("the version or range to write"),
              section: z
                .string()
                .min(1)
                .optional()
                .describe("which section, when the name appears in more than one"),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      preserveRangeStyle: z
        .boolean()
        .optional()
        .describe("carry over a leading ^, ~ or >= from the old spec; on by default"),
      dryRun: z.boolean().optional().describe("report what would change and write nothing"),
    })
    .strict(),
  readOnly: false,
  // It overwrites a file the project builds from. Nothing here is recoverable
  // from the tool's own result, so it is destructive and justification-gated,
  // like GoldenUpdate in @crewhaus/tool-verify.
  destructive: true,
  requireJustification: true,
  concurrencySafe: false,
  execute: async (input) => {
    const loaded = loadManifest("ManifestDependencySet", input.manifest);
    if (!loaded.ok) return loaded.message;
    if (!loaded.lossless) {
      // The splice happens on the decoded string and is written back as
      // UTF-8, so a byte the decoder could not represent comes back as U+FFFD
      // — a silent edit to bytes nobody named, possibly nowhere near the
      // version being changed. "Only the version moved" has to be true.
      return `ManifestDependencySet will not edit "${loaded.rel}": it is not valid UTF-8, and writing it back would replace the bytes that do not decode. Re-save the file as UTF-8 first.`;
    }
    const collected = collectSites(loaded.kind, loaded.text);
    if (!collected.ok) {
      return `ManifestDependencySet will not edit "${loaded.rel}": ${collected.reason}`;
    }
    const ecosystem = MANIFEST_ECOSYSTEM[loaded.kind];
    const preserve = input.preserveRangeStyle !== false;

    type Plan = {
      readonly site: DependencySite;
      readonly spec: string;
      readonly stylePreserved: boolean;
      readonly styleNote?: string;
    };
    const plans: Plan[] = [];
    const refusals: Array<Record<string, unknown>> = [];

    for (const edit of input.edits) {
      const matches = collected.sites.filter(
        (site) =>
          namesMatch(ecosystem, site.name, edit.name) &&
          (edit.section === undefined || site.section === edit.section),
      );
      if (matches.length === 0) {
        const skipped = collected.skipped.filter((s) => namesMatch(ecosystem, s.name, edit.name));
        refusals.push({
          name: edit.name,
          reason:
            skipped.length > 0
              ? `"${edit.name}" is declared in ${skipped[0]?.section} but cannot be placed exactly: ${skipped[0]?.reason}`
              : `"${edit.name}" is not declared in ${loaded.rel}${edit.section === undefined ? "" : ` under ${edit.section}`} — this tool changes a version, it does not add a dependency`,
        });
        continue;
      }
      if (matches.length > 1) {
        const sections = [...new Set(matches.map((m) => m.section))].sort(byString);
        refusals.push({
          name: edit.name,
          reason:
            sections.length > 1
              ? `"${edit.name}" is declared in ${sections.join(", ")} — name the section, because bumping one and not the others is a decision, not a detail`
              : // Twice in ONE section: a pyproject list can pin the same
                // package under two environment markers, and naming the
                // section cannot choose between them. Guessing would change
                // which interpreter gets which version.
                `"${edit.name}" is declared ${matches.length} times in ${sections[0]} (lines ${matches.map((m) => m.line).join(", ")}) — this tool will not choose between them`,
        });
        continue;
      }
      const site = matches[0] as DependencySite;
      const styled = preserve
        ? reapplyStyle(site.spec, edit.spec)
        : { spec: edit.spec, preserved: false, note: "preserveRangeStyle was off" };
      const bad = checkSpecText(styled.spec, site.quote);
      if (bad !== undefined) {
        refusals.push({ name: edit.name, section: site.section, reason: bad });
        continue;
      }
      if (site.spelling === "requirementString" && !/^(===|==|!=|<=|>=|~=|<|>)/.test(styled.spec)) {
        // `requests` + `2.0` would splice into `requests2.0`, which is a
        // different package name, not a pinned version.
        refusals.push({
          name: edit.name,
          section: site.section,
          reason: `a PEP 508 requirement needs an operator: write ">=${styled.spec}" or "==${styled.spec}" rather than a bare version`,
        });
        continue;
      }
      plans.push({
        site,
        spec: styled.spec,
        stylePreserved: styled.preserved,
        ...(styled.note === undefined ? {} : { styleNote: styled.note }),
      });
    }

    const overlapping = plans.some((plan, index) =>
      plans.some((other, otherIndex) => {
        if (otherIndex === index) return false;
        const a = plan.site.specSpan;
        const b = other.site.specSpan;
        // The second clause is for the INSERTION spans a PEP 508 requirement
        // with no specifier has: two empty spans at one offset do not overlap
        // by the interval test, and splicing both would double the text.
        return (a.start < b.end && b.start < a.end) || (a.start === b.start && a.end === b.end);
      }),
    );
    if (overlapping) {
      refusals.push({ name: "*", reason: "two edits land on the same bytes of the manifest" });
    }

    const report = (applied: boolean): string =>
      json({
        manifest: loaded.rel,
        kind: loaded.kind,
        applied,
        dryRun: input.dryRun === true,
        changed: plans.filter((p) => p.spec !== p.site.spec).length,
        edits: plans.map((plan) => ({
          name: plan.site.name,
          section: plan.site.section,
          spelling: plan.site.spelling,
          line: plan.site.line,
          from: plan.site.spec,
          to: plan.spec,
          stylePreserved: plan.stylePreserved,
          ...(plan.styleNote === undefined ? {} : { styleNote: plan.styleNote }),
        })),
        ...(refusals.length === 0 ? {} : { refused: refusals }),
      });

    if (refusals.length > 0) {
      // All or nothing. A partial write leaves a manifest that is neither the
      // old one nor the one that was asked for, and the caller finds out by
      // reading the report carefully — which is exactly what nobody does.
      return `ManifestDependencySet refused the whole edit: ${refusals.length} of ${input.edits.length} could not be placed exactly, and a partial write would leave "${loaded.rel}" in a state nobody asked for.\n${report(false)}`;
    }

    let next = loaded.text;
    // Splice from the end so every earlier span keeps its offsets.
    for (const plan of [...plans].sort((a, b) => b.site.specSpan.start - a.site.specSpan.start)) {
      next =
        next.slice(0, plan.site.specSpan.start) + plan.spec + next.slice(plan.site.specSpan.end);
    }

    const verified = verifySplice(loaded.kind, next, {
      sites: collected.sites,
      skipped: collected.skipped,
      edits: plans.map((plan) => ({ site: plan.site, spec: plan.spec })),
    });
    if (!verified.ok) {
      // The edit was located, spliced and then re-read, and the re-read
      // disagreed. Nothing has been written at this point, and nothing will
      // be: a manifest this tool cannot re-read is a manifest it has no
      // business saving.
      return `ManifestDependencySet built an edit it could not verify and wrote nothing: ${verified.reason}`;
    }

    if (input.dryRun === true) return report(false);

    // Temp file plus rename: an interrupted write leaves the old manifest in
    // place rather than a truncated one, which builds nothing and looks like
    // a merge conflict. The path is the one `loadManifest` resolved and read,
    // not a second resolution of the same string.
    const temp = `${loaded.real}.tmp-${process.pid}`;
    try {
      // "wx" is O_CREAT|O_EXCL, which refuses an existing name INCLUDING a
      // symlink. The manifest path went through `resolveSafe` precisely so a
      // link could not carry a write out of the workspace; a plain open of a
      // derived name beside it would hand that back, and the name is
      // predictable enough to pre-place.
      writeFileSync(temp, next, { flag: "wx" });
    } catch (err) {
      return `ManifestDependencySet wrote nothing: it could not create "${basename(temp)}" beside the manifest (${(err as Error).message}). Remove whatever is already at that name and try again.`;
    }
    try {
      chmodSync(temp, statSync(loaded.real).mode & 0o7777);
    } catch {
      // A filesystem that will not carry the mode over is not a reason to
      // abandon the write; the content is what matters.
    }
    renameSync(temp, loaded.real);
    return report(true);
  },
});

export const REGISTRY_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  manifestDependencySet,
  registryOutdated,
  registryPackageInfo,
  registrySearch,
]);
