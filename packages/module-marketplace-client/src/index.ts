import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { PluginRegistry } from "@crewhaus/plugin-registry";
import { type PluginManifest, canonicalJson, validatePluginManifest } from "@crewhaus/plugin-sdk";

/**
 * Section 42 — `@crewhaus/module-marketplace-client`.
 *
 * Sits on top of §42 `plugin-registry` to discover, install, update,
 * and publish plugins via a remote registry source. Mirrors the §40
 * `template-marketplace-client` shape: take a `RegistrySource` (any
 * backend with `listPlugins / getManifest / downloadSource`), expose
 * search + install / uninstall / update / publish-draft over it, and
 * delegate the actual git/HTTP transport to a Studio integration the
 * caller wires.
 *
 * Studio's "Plugins" tab (deferred to a §35 UI follow-up) is the
 * primary consumer of `MarketplaceClient`. The `crewhaus plugins
 * {list,search,install,uninstall}` CLI subcommands (deferred to a CLI
 * follow-up) are the secondary consumer.
 */

export class ModuleMarketplaceError extends CrewhausError {
  override readonly name = "ModuleMarketplaceError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Item 10 (G89) — the canonical default plugin (module) registry index URL.
 *
 * A host with no `--registry` flag and no `CREWHAUS_PLUGIN_REGISTRY` env var
 * resolves the marketplace against THIS index. It follows the HTTP
 * `ModuleRegistrySource` contract: `GET <url>` returns
 * `{ plugins: PluginMetadata[] }`, and per-name manifests live at
 * `<url>/<name>.json` (`<url>/<name>@<version>.json` for a pinned version).
 *
 * Exported (rather than inlined at the CLI) so the CLI, Studio's Plugins tab,
 * and any other consumer share one source of truth for the default endpoint.
 */
export const DEFAULT_MODULE_REGISTRY_URL = "https://registry.crewhaus.ai/plugins";

/**
 * Minimal metadata the marketplace surfaces in a search result. Full
 * `PluginManifest` is only fetched on `install` / `update`.
 */
export type PluginMetadata = {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  /** Categories that map to the SDK's contribution kinds. */
  readonly contributes?: ReadonlyArray<"tool" | "channel" | "model" | "grader" | "target">;
  /** Optional download count / rating / etc., backend-defined. */
  readonly stats?: Readonly<Record<string, number>>;
};

/**
 * Abstract remote registry. A backend implementation might wrap a
 * GitHub Pages JSON index, a private S3 bucket, an OCI registry, or a
 * git-hosted manifest folder. The client only cares about these three
 * operations.
 */
export interface ModuleRegistrySource {
  readonly id: string;
  /** Return the catalog of installable plugins. */
  listPlugins(): Promise<ReadonlyArray<PluginMetadata>>;
  /** Fetch the full validated manifest for `name@version` (latest if version omitted). */
  getManifest(name: string, version?: string): Promise<PluginManifest>;
  /** Optional source tarball. Required for `install` to write a plugin's files locally. */
  downloadSource?(name: string, version: string): Promise<Uint8Array>;
}

export type SearchFilter = {
  /** Case-insensitive substring match against name + description. */
  readonly query?: string;
  /** Exact match against `author`. */
  readonly author?: string;
  /** Restrict to plugins that contribute the given kind. */
  readonly contributes?: "tool" | "channel" | "model" | "grader" | "target";
  /** Cap results. Default 50. */
  readonly limit?: number;
};

export type InstallOptions = {
  /** Subdirectory under `pluginsDir`. Defaults to the plugin's name. */
  readonly subdir?: string;
  /** Manifest filename in that subdirectory. Defaults to `plugin.json`. */
  readonly manifestFilename?: string;
};

export type InstallResult = {
  readonly manifest: PluginManifest;
  readonly manifestPath: string;
};

export type PublishDraft = {
  readonly registryId: string;
  readonly name: string;
  readonly version: string;
  readonly canonicalManifest: string;
  readonly prTitle: string;
  readonly prBody: string;
};

export type MarketplaceClientOptions = {
  readonly registry: ModuleRegistrySource;
  readonly pluginRegistry: PluginRegistry;
  /** Local directory under which installed plugins live. Mirrors the §41 trustedRoots. */
  readonly pluginsDir: string;
  /** Test seam: override the file write. Defaults to a 0600-mode writeFileSync. */
  readonly writeFileImpl?: (path: string, contents: string) => void;
};

function defaultWriteFile(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
}

export interface MarketplaceClient {
  /** Search the remote registry. Pure-pull; results not cached locally. */
  search(filter?: SearchFilter): Promise<ReadonlyArray<PluginMetadata>>;
  /** Fetch + validate + write to disk + register locally. */
  install(name: string, version?: string, opts?: InstallOptions): Promise<InstallResult>;
  /** Inverse of install — removes from registry. Does NOT delete the on-disk source. */
  uninstall(name: string): Promise<void>;
  /**
   * Compare local pinned version to remote latest; install if newer.
   * Returns the install result on update, or `undefined` if already current.
   */
  update(name: string, opts?: InstallOptions): Promise<InstallResult | undefined>;
  /**
   * Produce a `PublishDraft` for a Studio git client to submit. The
   * client never speaks git itself — that's a Studio integration.
   */
  draftPublish(manifest: PluginManifest): PublishDraft;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function compareSemver(a: string, b: string): number {
  // Compare core numbers only — pre-release / build metadata ordering
  // is well-defined per semver but rarely matters for "is remote newer?".
  // If anyone needs full SemVer 2.0 ordering, swap this for the `semver`
  // package without breaking the public API.
  const [aCore = ""] = a.split("-");
  const [bCore = ""] = b.split("-");
  const aN = aCore.split(".").map((n) => Number.parseInt(n, 10));
  const bN = bCore.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = aN[i] ?? 0;
    const bi = bN[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

export function createMarketplaceClient(opts: MarketplaceClientOptions): MarketplaceClient {
  if (typeof opts.pluginsDir !== "string" || opts.pluginsDir.length === 0) {
    throw new ModuleMarketplaceError("module-marketplace-client: pluginsDir is required");
  }
  const writeFile = opts.writeFileImpl ?? defaultWriteFile;

  return {
    async search(filter): Promise<ReadonlyArray<PluginMetadata>> {
      const all = await opts.registry.listPlugins();
      const limit = filter?.limit ?? 50;
      const q = filter?.query ? lower(filter.query) : undefined;
      let out = all.slice();
      if (q !== undefined) {
        out = out.filter(
          (p) =>
            lower(p.name).includes(q) ||
            (p.description !== undefined && lower(p.description).includes(q)),
        );
      }
      if (filter?.author !== undefined) {
        const author = filter.author;
        out = out.filter((p) => p.author === author);
      }
      if (filter?.contributes !== undefined) {
        const k = filter.contributes;
        out = out.filter((p) => p.contributes?.includes(k));
      }
      return out.slice(0, limit);
    },

    async install(name, version, installOpts): Promise<InstallResult> {
      const raw = await opts.registry.getManifest(name, version);
      const manifest = validatePluginManifest(raw);
      if (manifest.name !== name) {
        throw new ModuleMarketplaceError(
          `module-marketplace-client: remote manifest name "${manifest.name}" does not match install request for "${name}"`,
        );
      }
      const subdir = installOpts?.subdir ?? manifest.name;
      const filename = installOpts?.manifestFilename ?? "plugin.json";
      const manifestPath = join(opts.pluginsDir, subdir, filename);
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      // Source tarball is the registry's responsibility; if available, the
      // client streams it to disk. We model the contract — the test suite
      // exercises the with-source and without-source paths.
      if (opts.registry.downloadSource) {
        const bytes = await opts.registry.downloadSource(manifest.name, manifest.version);
        const sourcePath = join(opts.pluginsDir, subdir, "source.bin");
        writeFile(sourcePath, Buffer.from(bytes).toString("base64"));
      }

      await opts.pluginRegistry.register({
        manifest,
        sourcePath: manifestPath,
        replace: true,
      });
      return { manifest, manifestPath };
    },

    async uninstall(name): Promise<void> {
      await opts.pluginRegistry.unregister(name);
    },

    async update(name, installOpts): Promise<InstallResult | undefined> {
      const existing = await opts.pluginRegistry.get(name);
      if (!existing) {
        // Not installed — nothing to update.
        return undefined;
      }
      const remote = await opts.registry.getManifest(name);
      const validated = validatePluginManifest(remote);
      if (compareSemver(validated.version, existing.manifest.version) <= 0) {
        return undefined;
      }
      return this.install(name, validated.version, installOpts);
    },

    draftPublish(manifest): PublishDraft {
      validatePluginManifest(manifest);
      const descriptionLine = manifest.description ? `> ${manifest.description}\n\n` : "";
      const prBody = `Adds \`${manifest.name}\` version \`${manifest.version}\` to the \`${opts.registry.id}\` marketplace registry.\n\n${descriptionLine}Submitted via \`@crewhaus/module-marketplace-client\`.\n`;
      return {
        registryId: opts.registry.id,
        name: manifest.name,
        version: manifest.version,
        canonicalManifest: canonicalJson(manifest),
        prTitle: `plugin: publish ${manifest.name}@${manifest.version}`,
        prBody,
      };
    },
  };
}
