/**
 * Item 60 — the marketplace CLI: `crewhaus plugins {list,search,install,
 * uninstall,publish,outdated}` and `crewhaus templates {list,search,use}`.
 * These verbs were the explicitly-deferred CLI surface on top of the §42
 * `module-marketplace-client` / §40 `template-marketplace-client` (their
 * docstrings name "the CLI follow-up" as the secondary consumer); this
 * closes them, plus the publish loop and a dependency-freshness watch.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import, mirroring `datasets.ts` / `retention.ts`:
 *   - the registry-source construction + the marketplace clients are the only
 *     I/O, and they route network through an injectable `fetch` seam so
 *     `list`/`search`/`install`/`outdated` are tested against a seeded LOCAL
 *     registry or a mocked HTTP source with no real network;
 *   - the `outdated` comparison and the report formatters are pure;
 *   - the publish loop drives `gh` behind an injected driver seam.
 *
 * REGISTRY RESOLUTION — a `--registry <ref>` flag, else
 * `CREWHAUS_PLUGIN_REGISTRY` / `CREWHAUS_TEMPLATE_REGISTRY`, else (item 10 / G89)
 * the default PUBLIC registry (`DEFAULT_MODULE_REGISTRY_URL` /
 * `DEFAULT_TEMPLATE_REGISTRY_URL` on `registry.crewhaus.ai`, wired at the
 * `crewhaus plugins`/`templates` call sites), selects the backend:
 *   - a filesystem path (or `file:<path>`) → a LOCAL source (a directory of
 *     manifest JSONs — the same on-disk shape the registries write);
 *   - an `http(s)://` URL → an HTTP source (a `{plugins:[]}` / `{templates:[]}`
 *     JSON index at `<url>` + per-name manifests at `<url>/<name>.json`).
 * {@link resolveRegistryRef} itself stays pure — it throws "no registry
 * configured" for a truly-absent ref (the datasets registry path still relies
 * on that); the default is a `?? DEFAULT_*_REGISTRY_URL` fallback the CLI
 * applies before calling in for plugins/templates.
 *
 * SIGNING — install respects `plugin-registry`'s fail-closed verification:
 * when trust anchors are configured (via `--trust-anchor` / env), an unsigned
 * or badly-signed plugin is refused; `--allow-unsigned` is the explicit dev
 * opt-out. Templates carry their own `verifyingRegistry` wrapper (out of scope
 * here — install fetches the manifest verbatim).
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ModuleRegistrySource, PluginMetadata } from "@crewhaus/module-marketplace-client";
import type { PluginRegistryEntry } from "@crewhaus/plugin-registry";
import type { PluginManifest } from "@crewhaus/plugin-sdk";

/** Thrown for operational failures (no registry configured, bad ref, driver
 *  failure). The CLI routes the message through `die()`; tests assert on
 *  `.message`. */
export class MarketplaceCliError extends Error {
  override readonly name = "MarketplaceCliError";
}

// ---------------------------------------------------------------------------
// default locations
// ---------------------------------------------------------------------------

/** Where installed plugins live (mirrors §41 trustedRoots). */
export function defaultPluginsDir(): string {
  return join(homedir(), ".crewhaus", "plugins");
}

/** The plugin-registry install-record file. */
export function defaultPluginRegistryPath(): string {
  return join(homedir(), ".crewhaus", "plugin-registry.json");
}

/** Where `templates use` writes the fetched template. Defaults to the cwd
 *  (a template is scaffolded into the working directory). */
export function defaultTemplateWorkspaceDir(): string {
  return process.cwd();
}

// ---------------------------------------------------------------------------
// registry ref resolution
// ---------------------------------------------------------------------------

export type RegistryRefKind =
  | { readonly kind: "local"; readonly dir: string }
  | { readonly kind: "http"; readonly baseUrl: string };

/**
 * Resolve a registry ref string into a backend descriptor. `http(s)://…` →
 * HTTP; anything else is a filesystem path (a leading `file:` is stripped).
 * `undefined` (nothing configured) throws so a read verb fails loudly instead
 * of silently hitting nothing.
 */
export function resolveRegistryRef(ref: string | undefined, kindLabel: string): RegistryRefKind {
  if (ref === undefined || ref === "") {
    throw new MarketplaceCliError(
      `no ${kindLabel} registry configured — pass --registry <dir|url> or set the CREWHAUS_${kindLabel.toUpperCase()}_REGISTRY env var (a directory of manifest JSONs, or an http(s):// index URL)`,
    );
  }
  if (/^https?:\/\//.test(ref)) return { kind: "http", baseUrl: ref.replace(/\/$/, "") };
  const path = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
  return { kind: "local", dir: isAbsolute(path) ? path : resolve(process.cwd(), path) };
}

// ---------------------------------------------------------------------------
// HTTP-backed ModuleRegistrySource (plugins)
// ---------------------------------------------------------------------------

/**
 * A `ModuleRegistrySource` over an HTTP JSON index. The catalog is
 * `GET <baseUrl>` returning `{ plugins: PluginMetadata[] }`; a manifest is
 * `GET <baseUrl>/<name>.json` (optionally `<name>@<version>.json`). `fetch`
 * is injected so tests drive it without a network.
 */
export function createHttpModuleRegistrySource(opts: {
  readonly id: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}): ModuleRegistrySource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  return {
    id: opts.id,
    async listPlugins(): Promise<ReadonlyArray<PluginMetadata>> {
      const res = await fetchImpl(base);
      if (!res.ok) {
        throw new MarketplaceCliError(
          `plugin registry list ${res.status}: ${(await res.text()).slice(0, 256)}`,
        );
      }
      const data = (await res.json()) as { plugins?: ReadonlyArray<PluginMetadata> };
      if (!Array.isArray(data?.plugins)) {
        throw new MarketplaceCliError("plugin registry list payload missing plugins[]");
      }
      return data.plugins;
    },
    async getManifest(name: string, version?: string): Promise<PluginManifest> {
      const suffix = version !== undefined ? `${name}@${version}` : name;
      const res = await fetchImpl(`${base}/${suffix}.json`);
      if (!res.ok) {
        throw new MarketplaceCliError(
          `plugin registry fetch "${suffix}" ${res.status}: ${(await res.text()).slice(0, 256)}`,
        );
      }
      return (await res.json()) as PluginManifest;
    },
  };
}

/**
 * A LOCAL `ModuleRegistrySource` over a directory of plugin manifest JSONs
 * (`<name>.json`). Mirrors template-registry's `LocalRegistrySource`; used
 * for `--registry <dir>` and by tests. Reads go through injected fs seams so
 * this stays unit-testable.
 */
export function createLocalModuleRegistrySource(opts: {
  readonly dir: string;
  readonly readdirImpl: (dir: string) => ReadonlyArray<string>;
  readonly readFileImpl: (path: string) => string;
  readonly existsImpl: (path: string) => boolean;
}): ModuleRegistrySource {
  const manifestPath = (name: string, version?: string): string =>
    join(opts.dir, `${version !== undefined ? `${name}@${version}` : name}.json`);
  return {
    id: `local:${opts.dir}`,
    async listPlugins(): Promise<ReadonlyArray<PluginMetadata>> {
      if (!opts.existsImpl(opts.dir)) return [];
      const out: PluginMetadata[] = [];
      for (const f of opts.readdirImpl(opts.dir)) {
        if (!f.endsWith(".json") || f.includes("@")) continue;
        try {
          const m = JSON.parse(opts.readFileImpl(join(opts.dir, f))) as PluginManifest;
          out.push(toMetadata(m));
        } catch {
          // skip malformed
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async getManifest(name: string, version?: string): Promise<PluginManifest> {
      const versioned = manifestPath(name, version);
      const path =
        version !== undefined && opts.existsImpl(versioned) ? versioned : manifestPath(name);
      if (!opts.existsImpl(path)) {
        throw new MarketplaceCliError(`plugin "${name}" not found in ${opts.dir}`);
      }
      return JSON.parse(opts.readFileImpl(path)) as PluginManifest;
    },
  };
}

/** Project a full manifest down to the search metadata shape. */
export function toMetadata(m: PluginManifest): PluginMetadata {
  const rec = m as unknown as Record<string, unknown>;
  return {
    name: m.name,
    version: m.version,
    ...(typeof rec["description"] === "string" ? { description: rec["description"] } : {}),
    ...(typeof rec["author"] === "string" ? { author: rec["author"] } : {}),
    ...(typeof rec["homepage"] === "string" ? { homepage: rec["homepage"] } : {}),
    ...(typeof rec["license"] === "string" ? { license: rec["license"] } : {}),
  };
}

// ---------------------------------------------------------------------------
// outdated (dependency-freshness watch)
// ---------------------------------------------------------------------------

/** Compare two `major.minor.patch` cores; pre-release/build ignored (matches
 *  module-marketplace-client's own `compareSemver`). */
export function compareSemverCore(a: string, b: string): number {
  const core = (v: string): number[] =>
    (v.split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const aN = core(a);
  const bN = core(b);
  for (let i = 0; i < 3; i++) {
    const ai = aN[i] ?? 0;
    const bi = bN[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

export type OutdatedRow = {
  readonly name: string;
  readonly installed: string;
  readonly latest?: string;
  /** "outdated" | "current" | "unknown" (not in the remote registry). */
  readonly status: "outdated" | "current" | "unknown";
};

/**
 * Compute the freshness report: for each installed plugin, its installed
 * version vs the remote latest. `unknown` when the plugin is not in the
 * remote catalog (a private/local install). Pure over the two lists.
 */
export function computeOutdated(
  installed: ReadonlyArray<{ readonly name: string; readonly version: string }>,
  remote: ReadonlyArray<PluginMetadata>,
): OutdatedRow[] {
  const latestByName = new Map<string, string>();
  for (const p of remote) {
    const prev = latestByName.get(p.name);
    if (prev === undefined || compareSemverCore(p.version, prev) > 0) {
      latestByName.set(p.name, p.version);
    }
  }
  const rows: OutdatedRow[] = [];
  for (const inst of installed) {
    const latest = latestByName.get(inst.name);
    if (latest === undefined) {
      rows.push({ name: inst.name, installed: inst.version, status: "unknown" });
      continue;
    }
    const status = compareSemverCore(latest, inst.version) > 0 ? "outdated" : "current";
    rows.push({ name: inst.name, installed: inst.version, latest, status });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The installed (name, version) pairs from plugin-registry entries. */
export function installedVersions(
  entries: ReadonlyArray<PluginRegistryEntry>,
): Array<{ name: string; version: string }> {
  return entries.map((e) => ({
    name: e.manifest.name,
    version: e.pinnedVersion ?? e.manifest.version,
  }));
}

// ---------------------------------------------------------------------------
// formatters (pure)
// ---------------------------------------------------------------------------

export function formatPluginList(rows: ReadonlyArray<PluginMetadata>): ReadonlyArray<string> {
  if (rows.length === 0) return ["no plugins in the registry"];
  return rows.map(
    (p) =>
      `${p.name}@${p.version}${p.author !== undefined ? ` — ${p.author}` : ""}${
        p.description !== undefined ? `\n    ${p.description}` : ""
      }`,
  );
}

export function formatOutdated(rows: ReadonlyArray<OutdatedRow>): ReadonlyArray<string> {
  if (rows.length === 0) return ["no plugins installed"];
  const lines: string[] = [];
  let outdated = 0;
  for (const r of rows) {
    if (r.status === "outdated") {
      outdated += 1;
      lines.push(`⤴ ${r.name}: ${r.installed} → ${r.latest} (update available)`);
    } else if (r.status === "current") {
      lines.push(`✓ ${r.name}: ${r.installed} (current)`);
    } else {
      lines.push(`? ${r.name}: ${r.installed} (not in the configured registry)`);
    }
  }
  lines.push("");
  lines.push(
    outdated === 0
      ? "summary: all installed plugins current"
      : `summary: ${outdated} update(s) available`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// publish loop (drives the PublishDraft through a gh PR)
// ---------------------------------------------------------------------------

/** The minimal PublishDraft fields the publish loop needs (structurally
 *  satisfied by BOTH marketplace clients' PublishDraft shapes). */
export type PublishDraftLike = {
  readonly prTitle: string;
  readonly prBody: string;
  /** repo-relative path the manifest is written to on the branch. */
  readonly manifestRelPath: string;
  /** the manifest bytes to write. */
  readonly manifestContents: string;
  readonly name: string;
  readonly version: string;
};

/** The write-and-open plan the driver executes for a publish. */
export type PublishPrPlan = {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly files: Readonly<Record<string, string>>;
  readonly commitMessage: string;
};

/** Assemble the publish PR plan from a draft. Pure. */
export function buildPublishPrPlan(draft: PublishDraftLike, now: Date): PublishPrPlan {
  const slug = draft.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const branch = `publish/${slug || "plugin"}-${draft.version}-${stamp}`;
  return {
    branch,
    title: draft.prTitle,
    body: draft.prBody,
    files: { [draft.manifestRelPath]: draft.manifestContents },
    commitMessage: `publish(${draft.name}): ${draft.version}`,
  };
}

/** Driver seam: execute a `PublishPrPlan` (branch → write → commit → push →
 *  `gh pr create`). CLI wires git/gh; tests inject a stub. NEVER auto-merges. */
export type PublishPrDriver = (plan: PublishPrPlan) => Promise<{
  readonly prNumber?: number;
  readonly url: string;
  readonly branch: string;
}>;
