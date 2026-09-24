import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { PluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginManifest,
  canonicalJson,
  crewhausEngineProblem,
  entrypointDigest,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";
import { readFileBounded } from "@crewhaus/tool-safety/streams";
import pkg from "../package.json" with { type: "json" };

/**
 * The crewhaus version install checks a manifest's `engines.crewhaus` range
 * against: this package's own, which the release train bumps in lockstep.
 */
const HOST_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/** The most of a plugin's index.js install reads to check it against `entrypointDigest`. */
export const MAX_ENTRYPOINT_BYTES = 64 * 1024 * 1024;

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
 *
 * Install delivers the MANIFEST only (0.7.x): no registry source ships code
 * in a form crewhaus unpacks, and the loader imports `<plugin-dir>/index.js`.
 * `install` says so in `warnings` (and `runnable: false`) until that file is
 * there and matches the manifest's `entrypointDigest`.
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
  /**
   * Optional source archive. This crewhaus installs the manifest only and
   * does not fetch or unpack an archive; `install` warns when a source offers
   * one.
   */
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
  /**
   * Whether a spec that names the plugin can load it as installed: its
   * `index.js` sits next to the manifest (matching `entrypointDigest` when
   * the manifest sets one), and its `engines.crewhaus` range includes this
   * crewhaus. When false, `warnings` says what is missing.
   */
  readonly runnable: boolean;
  /** What the operator has to know or do before a spec can load the plugin. */
  readonly warnings: ReadonlyArray<string>;
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
  /**
   * Test seam: read a plugin's `index.js`. Resolves `undefined` when there is
   * no such file, and throws when it cannot be read as a regular file. The
   * default reads at most {@link MAX_ENTRYPOINT_BYTES} and refuses a FIFO or
   * other special file rather than blocking on it.
   */
  readonly readEntrypointImpl?: (path: string) => Promise<Uint8Array | undefined>;
  /** The crewhaus version `engines.crewhaus` is checked against. Defaults to this package's. */
  readonly hostVersion?: string;
};

async function defaultReadEntrypoint(path: string): Promise<Uint8Array | undefined> {
  const read = await readFileBounded(path, { maxBytes: MAX_ENTRYPOINT_BYTES });
  if (read.ok) {
    if (read.truncated) throw new Error(`it is larger than ${MAX_ENTRYPOINT_BYTES} bytes`);
    return read.bytes;
  }
  if (read.code === "not-found") return undefined;
  throw new Error(read.reason);
}

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
  const readEntrypoint = opts.readEntrypointImpl ?? defaultReadEntrypoint;
  const hostVersion = opts.hostVersion ?? HOST_VERSION;

  /**
   * Is the plugin's code where the loader will look, and the code the
   * manifest names? Adds a warning for each thing that is not so.
   */
  async function checkEntrypoint(
    manifest: PluginManifest,
    entryPath: string,
    warnings: string[],
  ): Promise<boolean> {
    const who = `${manifest.name}@${manifest.version}`;
    const digestNote =
      manifest.entrypointDigest !== undefined
        ? " (its sha256 must equal the manifest's entrypointDigest)"
        : "";
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readEntrypoint(entryPath);
    } catch (err) {
      warnings.push(
        `${who}: ${entryPath} cannot be checked: ${err instanceof Error ? err.message : String(err)}. A spec that names the plugin will not start until it is a readable file${digestNote}.`,
      );
      return false;
    }
    if (bytes === undefined) {
      warnings.push(
        `${who} is installed as a manifest only: the registry delivers no code. Put the plugin's index.js at ${entryPath}${digestNote} before a spec names it in plugins:.`,
      );
      return false;
    }
    if (
      manifest.entrypointDigest !== undefined &&
      entrypointDigest(bytes) !== manifest.entrypointDigest
    ) {
      warnings.push(
        `${who}: the index.js at ${entryPath} does not match the manifest's entrypointDigest, so a spec that names the plugin will be refused at boot until it does.`,
      );
      return false;
    }
    return true;
  }

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
      // A source that answers a pinned version with another one (a local
      // directory falls back to <name>.json) must not install it silently.
      if (version !== undefined && manifest.version !== version) {
        throw new ModuleMarketplaceError(
          `module-marketplace-client: registry "${opts.registry.id}" served ${manifest.name}@${manifest.version} when ${version} was asked for — not installed`,
        );
      }
      // Refuse a manifest the registry will not register BEFORE it is
      // written, so it never replaces a working manifest on disk.
      await opts.pluginRegistry.verifyManifest?.(manifest);
      const subdir = installOpts?.subdir ?? manifest.name;
      const filename = installOpts?.manifestFilename ?? "plugin.json";
      const manifestPath = join(opts.pluginsDir, subdir, filename);
      writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await opts.pluginRegistry.register({
        manifest,
        sourcePath: manifestPath,
        replace: true,
      });

      const warnings: string[] = [];
      // The loader imports <plugin-dir>/index.js, and nothing here writes it.
      // An archive a source offers is not fetched: unpacking one is how a
      // symlink or a `../` path lands outside the plugin directory, and 0.7.x
      // defines no archive format to verify against entrypointDigest.
      if (opts.registry.downloadSource !== undefined) {
        warnings.push(
          `registry "${opts.registry.id}" offers a source archive for ${manifest.name}@${manifest.version}; this crewhaus installs the manifest only and does not fetch or unpack it.`,
        );
      }
      const hasCode = await checkEntrypoint(
        manifest,
        join(opts.pluginsDir, subdir, "index.js"),
        warnings,
      );
      const engine = crewhausEngineProblem(manifest, hostVersion);
      if (engine !== undefined) {
        warnings.push(`${engine}, so a spec that names it will be refused at boot.`);
      }
      return {
        manifest,
        manifestPath,
        runnable: hasCode && engine === undefined,
        warnings,
      };
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
