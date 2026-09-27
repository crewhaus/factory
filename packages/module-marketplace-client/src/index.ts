import { mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type PluginRegistry,
  type TrustAnchorSource,
  createPluginRegistry,
} from "@crewhaus/plugin-registry";
import {
  MAX_PLUGIN_MANIFEST_BYTES,
  type PluginManifest,
  canonicalJson,
  crewhausEngineProblem,
  entrypointDigest,
  entrypointImportProblem,
  manifestExpiryProblem,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";
import { openForRead, writeFileSafe } from "@crewhaus/tool-safety/fs";
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
   * the manifest sets one), its `engines.crewhaus` range includes this
   * crewhaus, its signed `notAfter` has not passed, and — when
   * `bootTrustAnchors` is given — a key a boot trusts verifies its
   * signature. When false, `warnings` says what is missing.
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
  /**
   * Test seam: override the file write. The default writes inside
   * `pluginsDir` only, never through a link: a new manifest is created 0600,
   * a temp file is renamed into place, and a link planted at `plugin.json`
   * or at the plugin's directory is refused, naming the path.
   */
  readonly writeFileImpl?: (path: string, contents: string) => void;
  /**
   * The publisher keys a boot verifies signed plugins against
   * (`~/.crewhaus/plugin-trust`, `CREWHAUS_PLUGIN_TRUST_ANCHORS`). Give it
   * when install verifies against more keys than a boot reads (the CLI's
   * `--trust-anchor`): a signed manifest that none of these verifies still
   * installs, but is reported not runnable, since every boot would refuse
   * it. Omitted, `pluginRegistry`'s keys are taken to be the boot's.
   */
  readonly bootTrustAnchors?: ReadonlyArray<TrustAnchorSource>;
  /**
   * Test seam: read a plugin's `index.js`. Resolves `undefined` when there is
   * no such file, and throws when it cannot be read as a regular file. The
   * default reads at most {@link MAX_ENTRYPOINT_BYTES}, refuses a FIFO or
   * other special file rather than blocking on it, and refuses a link that
   * leads outside the plugin's directory, as the loader does at boot.
   */
  readonly readEntrypointImpl?: (path: string) => Promise<Uint8Array | undefined>;
  /** The crewhaus version `engines.crewhaus` is checked against. Defaults to this package's. */
  readonly hostVersion?: string;
};

/**
 * The default entrypoint reader, holding `index.js` to the loader's rule: it
 * must really be inside the plugin's own directory (a link within it is
 * fine; one that leads out is what the boot refuses) and a regular file, read
 * up to {@link MAX_ENTRYPOINT_BYTES}.
 */
async function defaultReadEntrypoint(path: string): Promise<Uint8Array | undefined> {
  const pluginDir = dirname(path);
  const read = await openForRead(pluginDir, basename(path), { maxBytes: MAX_ENTRYPOINT_BYTES });
  if (read.ok) {
    if (read.truncated) throw new Error(`it is larger than ${MAX_ENTRYPOINT_BYTES} bytes`);
    return read.bytes;
  }
  if (read.code === "not-found") return undefined;
  if (read.code === "escapes-root") {
    throw new Error(
      `it is a link that leads outside the plugin's directory ${pluginDir}, and the boot loads only code inside it`,
    );
  }
  if (read.code === "not-regular-file") {
    throw new Error(`it is a ${read.kind ?? "special file"}, not a regular file`);
  }
  throw new Error(read.reason);
}

/**
 * The default manifest writer: `path` inside `pluginsDir`, through
 * tool-safety's writeFileSafe. The plugin's directory is created inside
 * `pluginsDir` without following a link out of it; the bytes go to a temp
 * file created beside the manifest and renamed into place, so a link planted
 * at `plugin.json` is never written through (a leaf link is refused, naming
 * the path). A new manifest is 0600; one it replaces keeps its mode.
 */
function writeManifestContained(pluginsDir: string, path: string, contents: string): void {
  // pluginsDir is the operator's own directory; what is inside it is not.
  mkdirSync(pluginsDir, { recursive: true });
  const written = writeFileSafe(pluginsDir, relative(pluginsDir, path), contents, {
    overwrite: true,
    createParents: true,
    mode: 0o600,
  });
  if (!written.ok) {
    throw new ModuleMarketplaceError(
      `module-marketplace-client: cannot write ${path}: ${written.reason} — not installed`,
    );
  }
}

export interface MarketplaceClient {
  /** Search the remote registry. Pure-pull; results not cached locally. */
  search(filter?: SearchFilter): Promise<ReadonlyArray<PluginMetadata>>;
  /** Fetch + validate + write to disk + register locally. */
  install(name: string, version?: string, opts?: InstallOptions): Promise<InstallResult>;
  /** Inverse of install — removes from registry. Does NOT delete the on-disk source. */
  uninstall(name: string): Promise<void>;
  /**
   * Compare the installed version to the remote latest; install if newer.
   * Returns the install result on update, or `undefined` if already current —
   * or pinned: a plugin the registry pins stays at its pin (activation loads
   * a pinned plugin only at that version, so updating past it would stop it
   * loading).
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
  const writeFile =
    opts.writeFileImpl ??
    ((path: string, contents: string) => writeManifestContained(opts.pluginsDir, path, contents));
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
    if (manifest.signature !== undefined && manifest.entrypointDigest === undefined) {
      // The loader refuses this at boot whatever index.js holds.
      warnings.push(
        `${who} is signed, but its manifest has no entrypointDigest, so the signature covers none of its code, and a spec that names it will be refused at boot outside development mode. Ask the publisher to re-sign it with entrypointDigest set.`,
      );
      return false;
    }
    const digestNote =
      manifest.entrypointDigest !== undefined
        ? " (its sha256 must equal the manifest's entrypointDigest)"
        : "";
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readEntrypoint(entryPath);
    } catch (err) {
      warnings.push(
        `${who}: ${entryPath} cannot be used: ${err instanceof Error ? err.message : String(err)}. A spec that names the plugin will not start until it is a regular file inside the plugin's directory${digestNote}.`,
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
    if (manifest.signature !== undefined) {
      // A signed plugin runs as exactly these bytes, so it must be one file.
      const outside = entrypointImportProblem(bytes);
      if (outside !== undefined) {
        warnings.push(
          `${who}: the index.js at ${entryPath} cannot run as signed code, so a spec that names the plugin will be refused at boot: ${outside}.`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * Why a boot would refuse `manifest`'s signature although install accepted
   * it, or undefined: only when `bootTrustAnchors` is given and the manifest
   * is signed, and no key a boot reads verifies it.
   */
  async function bootTrustProblem(manifest: PluginManifest): Promise<string | undefined> {
    const anchors = opts.bootTrustAnchors;
    if (anchors === undefined || manifest.signature === undefined) return undefined;
    if (anchors.length > 0) {
      try {
        await createPluginRegistry({
          registryPath: join(opts.pluginsDir, ".boot-trust-check"),
          trustAnchors: anchors,
        }).verifyManifest?.(manifest);
        return undefined;
      } catch {
        // Not verified by any key a boot reads: reported below.
      }
    }
    return `${manifest.name}@${manifest.version}: no key a boot trusts verifies its signature (it was verified against a key given only to this install), so every boot will refuse it. Put the publisher's .pem in ~/.crewhaus/plugin-trust, or list it in CREWHAUS_PLUGIN_TRUST_ANCHORS.`;
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
      // What is written is what the loader reads; a boot refuses a larger one.
      const text = `${JSON.stringify(manifest, null, 2)}\n`;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > MAX_PLUGIN_MANIFEST_BYTES) {
        throw new ModuleMarketplaceError(
          `module-marketplace-client: ${manifest.name}@${manifest.version}'s manifest is ${bytes} bytes as written, and a boot reads at most ${MAX_PLUGIN_MANIFEST_BYTES} — not installed`,
        );
      }
      // Refuse a manifest the registry will not register BEFORE it is
      // written, so it never replaces a working manifest on disk.
      await opts.pluginRegistry.verifyManifest?.(manifest);
      const subdir = installOpts?.subdir ?? manifest.name;
      const filename = installOpts?.manifestFilename ?? "plugin.json";
      const manifestPath = join(opts.pluginsDir, subdir, filename);
      writeFile(manifestPath, text);
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
      const expired = manifestExpiryProblem(manifest, Date.now());
      if (expired !== undefined) {
        warnings.push(
          `${expired}, so a spec that names it will be refused at boot. Ask the publisher for a release signed with a later notAfter.`,
        );
      }
      const untrusted = await bootTrustProblem(manifest);
      if (untrusted !== undefined) warnings.push(untrusted);
      return {
        manifest,
        manifestPath,
        runnable:
          hasCode && engine === undefined && expired === undefined && untrusted === undefined,
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
      if (existing.pinnedVersion !== undefined) return undefined;
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
