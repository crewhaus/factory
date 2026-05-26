import { verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type PluginManifest,
  type PluginPermissions,
  type PluginSignature,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";
import type { Secrets } from "@crewhaus/secrets-manager";

/**
 * Section 42 — `@crewhaus/plugin-registry`.
 *
 * Discovery + version pinning + signature verification + capability
 * declaration for installed plugins. File-backed JSON registry that
 * the runtime / studio / CLI read at boot to find which plugins are
 * available, what version is pinned, and what capabilities each
 * plugin declares.
 *
 * The registry is the *catalog* of installed plugins. The companion
 * §41 `plugin-loader` is the *activator* — it reads a manifest and
 * loads its entrypoint at runtime. Together they form the v1 plugin
 * surface; the §42 `module-marketplace-client` then sits on top of
 * the registry to install + update plugins from a remote source.
 *
 * Storage shape (default at `~/.crewhaus/plugin-registry.json`):
 *
 *   {
 *     "version": "1",
 *     "entries": {
 *       "<plugin-name>": {
 *         "manifest": {...},        // validated PluginManifest
 *         "sourcePath": "...",      // absolute path to the plugin's manifest file
 *         "installedAt": "...",     // ISO-8601 timestamp
 *         "pinnedVersion": "..."    // optional explicit pin (empty = follow latest registered)
 *       }
 *     }
 *   }
 *
 * Trust anchors are PEM-encoded Ed25519 public keys. They can be
 * provided either inline (e.g. via a config file) or by reference
 * to a `Secrets` backend — for example, an enterprise might keep its
 * production trust anchor PEM in Vault and inject it through the §27
 * secrets-manager.
 */

export class PluginRegistryError extends CrewhausError {
  override readonly name = "PluginRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type PluginRegistryEntry = {
  readonly manifest: PluginManifest;
  /** Absolute path to the manifest file the plugin was installed from. */
  readonly sourcePath: string;
  /** ISO-8601 timestamp. */
  readonly installedAt: string;
  /** Optional explicit version pin. When empty, follows the manifest's `version`. */
  readonly pinnedVersion?: string;
};

type RegistryFileShape = {
  readonly version: "1";
  readonly entries: Readonly<Record<string, PluginRegistryEntry>>;
};

const FILE_SHAPE_VERSION = "1";

export type TrustAnchorSource =
  | { readonly kind: "pem"; readonly name: string; readonly publicKeyPem: string }
  | { readonly kind: "secret"; readonly name: string; readonly secretName: string };

export type PluginRegistryOptions = {
  /** Absolute path to the registry file. Created on first write. */
  readonly registryPath: string;
  /** Trust anchors for signature verification. */
  readonly trustAnchors?: ReadonlyArray<TrustAnchorSource>;
  /**
   * Secrets backend, required only when any TrustAnchorSource has
   * `kind: "secret"`. Plugin-registry calls `secrets.get(secretName)`
   * to resolve the PEM at verify-time, so rotating the secret takes
   * effect on the next verify call without restarting the host.
   */
  readonly secrets?: Secrets;
  /** Test seam: override the file-read fn. */
  readonly readFileImpl?: (path: string) => string;
  /** Test seam: override the file-write fn. */
  readonly writeFileImpl?: (path: string, contents: string) => void;
  /** Test seam: override the existence check. */
  readonly existsImpl?: (path: string) => boolean;
};

export interface PluginRegistry {
  /** Register (or replace) a plugin entry. Throws on duplicate name with different sourcePath unless `replace: true`. */
  register(args: {
    readonly manifest: PluginManifest;
    readonly sourcePath: string;
    readonly replace?: boolean;
  }): Promise<PluginRegistryEntry>;
  /** Remove a plugin entry. No-op if not present. */
  unregister(name: string): Promise<void>;
  /** Return every entry, sorted by name. */
  list(): Promise<ReadonlyArray<PluginRegistryEntry>>;
  /** Return one entry, or undefined. */
  get(name: string): Promise<PluginRegistryEntry | undefined>;
  /** Set an explicit version pin. Empty string clears the pin. */
  pin(name: string, version: string): Promise<PluginRegistryEntry>;
  /**
   * Re-verify a plugin's manifest signature against the configured
   * trust anchors. Returns `true` on success. Throws
   * `PluginRegistryError` if the entry is missing, unsigned, or fails
   * verification.
   */
  verifyEntry(name: string): Promise<boolean>;
  /**
   * Union of every registered plugin's `permissions`. Useful for
   * surfacing the maximum-capability surface in Studio's plugin panel.
   */
  aggregatedPermissions(): Promise<PluginPermissions>;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultWriteFile(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
}

function defaultExists(path: string): boolean {
  return existsSync(path);
}

function emptyShape(): RegistryFileShape {
  return { version: FILE_SHAPE_VERSION, entries: {} };
}

function parseRegistryFile(text: string): RegistryFileShape {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PluginRegistryError(
      `plugin-registry: failed to parse registry file as JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new PluginRegistryError("plugin-registry: registry file must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== FILE_SHAPE_VERSION) {
    throw new PluginRegistryError(
      `plugin-registry: registry file version ${JSON.stringify(obj["version"])} is not supported (expected "${FILE_SHAPE_VERSION}")`,
    );
  }
  const entries = obj["entries"];
  if (entries === null || typeof entries !== "object") {
    throw new PluginRegistryError("plugin-registry: registry file `entries` must be an object");
  }
  const validated: Record<string, PluginRegistryEntry> = {};
  for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") {
      throw new PluginRegistryError(`plugin-registry: entry "${name}" is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const manifest = validatePluginManifest(entry["manifest"]);
    if (typeof entry["sourcePath"] !== "string" || entry["sourcePath"].length === 0) {
      throw new PluginRegistryError(`plugin-registry: entry "${name}" missing sourcePath`);
    }
    if (typeof entry["installedAt"] !== "string" || entry["installedAt"].length === 0) {
      throw new PluginRegistryError(`plugin-registry: entry "${name}" missing installedAt`);
    }
    validated[name] = {
      manifest,
      sourcePath: entry["sourcePath"],
      installedAt: entry["installedAt"],
      ...(typeof entry["pinnedVersion"] === "string" && entry["pinnedVersion"].length > 0
        ? { pinnedVersion: entry["pinnedVersion"] }
        : {}),
    };
  }
  return { version: FILE_SHAPE_VERSION, entries: validated };
}

export function createPluginRegistry(opts: PluginRegistryOptions): PluginRegistry {
  if (typeof opts.registryPath !== "string" || opts.registryPath.length === 0) {
    throw new PluginRegistryError("plugin-registry: registryPath is required");
  }
  const readFile = opts.readFileImpl ?? defaultReadFile;
  const writeFile = opts.writeFileImpl ?? defaultWriteFile;
  const exists = opts.existsImpl ?? defaultExists;
  const anchors = opts.trustAnchors ?? [];
  if (anchors.some((a) => a.kind === "secret") && opts.secrets === undefined) {
    throw new PluginRegistryError(
      'plugin-registry: secrets backend required when any trustAnchor is kind: "secret"',
    );
  }

  function load(): RegistryFileShape {
    if (!exists(opts.registryPath)) return emptyShape();
    return parseRegistryFile(readFile(opts.registryPath));
  }

  function save(shape: RegistryFileShape): void {
    writeFile(opts.registryPath, `${JSON.stringify(shape, null, 2)}\n`);
  }

  async function resolveAnchor(source: TrustAnchorSource): Promise<string> {
    if (source.kind === "pem") return source.publicKeyPem;
    if (!opts.secrets) {
      throw new PluginRegistryError(
        'plugin-registry: cannot resolve trustAnchor of kind: "secret" without a secrets backend',
      );
    }
    return opts.secrets.get(source.secretName);
  }

  async function verifyManifestSignature(
    manifest: PluginManifest,
    signature: PluginSignature,
  ): Promise<boolean> {
    if (signature.algorithm !== "ed25519") {
      throw new PluginRegistryError(
        `plugin-registry: signature.algorithm "${signature.algorithm}" is not supported (only ed25519)`,
      );
    }
    const payload = Buffer.from(manifestPayloadForSigning(manifest), "utf8");
    const sigBuf = Buffer.from(signature.sigB64, "base64");
    for (const anchor of anchors) {
      const pem = await resolveAnchor(anchor);
      let ok = false;
      try {
        ok = cryptoVerify(null, payload, pem, sigBuf);
      } catch {
        ok = false;
      }
      if (ok) return true;
    }
    return false;
  }

  return {
    async register(args): Promise<PluginRegistryEntry> {
      const shape = load();
      const existing = shape.entries[args.manifest.name];
      if (existing && !args.replace && existing.sourcePath !== args.sourcePath) {
        throw new PluginRegistryError(
          `plugin-registry: "${args.manifest.name}" is already registered from ${existing.sourcePath} (pass replace: true to override)`,
        );
      }
      const entry: PluginRegistryEntry = {
        manifest: args.manifest,
        sourcePath: args.sourcePath,
        installedAt: existing?.installedAt ?? new Date().toISOString(),
      };
      const nextEntries: Record<string, PluginRegistryEntry> = {
        ...shape.entries,
        [args.manifest.name]: entry,
      };
      save({ version: FILE_SHAPE_VERSION, entries: nextEntries });
      return entry;
    },

    async unregister(name): Promise<void> {
      const shape = load();
      if (!(name in shape.entries)) return;
      const nextEntries = { ...shape.entries };
      delete nextEntries[name];
      save({ version: FILE_SHAPE_VERSION, entries: nextEntries });
    },

    async list(): Promise<ReadonlyArray<PluginRegistryEntry>> {
      const shape = load();
      return Object.keys(shape.entries)
        .sort()
        .map((name) => shape.entries[name] as PluginRegistryEntry);
    },

    async get(name): Promise<PluginRegistryEntry | undefined> {
      const shape = load();
      return shape.entries[name];
    },

    async pin(name, version): Promise<PluginRegistryEntry> {
      const shape = load();
      const entry = shape.entries[name];
      if (!entry) {
        throw new PluginRegistryError(`plugin-registry: cannot pin "${name}" — not registered`);
      }
      const next: PluginRegistryEntry =
        version.length === 0
          ? {
              manifest: entry.manifest,
              sourcePath: entry.sourcePath,
              installedAt: entry.installedAt,
            }
          : {
              manifest: entry.manifest,
              sourcePath: entry.sourcePath,
              installedAt: entry.installedAt,
              pinnedVersion: version,
            };
      save({
        version: FILE_SHAPE_VERSION,
        entries: { ...shape.entries, [name]: next },
      });
      return next;
    },

    async verifyEntry(name): Promise<boolean> {
      const shape = load();
      const entry = shape.entries[name];
      if (!entry) {
        throw new PluginRegistryError(`plugin-registry: cannot verify "${name}" — not registered`);
      }
      if (!entry.manifest.signature) {
        throw new PluginRegistryError(
          `plugin-registry: cannot verify "${name}" — manifest is unsigned`,
        );
      }
      if (anchors.length === 0) {
        throw new PluginRegistryError(
          "plugin-registry: verifyEntry called but no trustAnchors are configured",
        );
      }
      const ok = await verifyManifestSignature(entry.manifest, entry.manifest.signature);
      if (!ok) {
        throw new PluginRegistryError(
          `plugin-registry: "${name}" signature does not verify against any configured trustAnchor`,
        );
      }
      return true;
    },

    async aggregatedPermissions(): Promise<PluginPermissions> {
      const shape = load();
      const fs = new Set<string>();
      const net = new Set<string>();
      const tools = new Set<string>();
      const secrets = new Set<string>();
      for (const entry of Object.values(shape.entries)) {
        for (const p of entry.manifest.permissions?.fs ?? []) fs.add(p);
        for (const p of entry.manifest.permissions?.net ?? []) net.add(p);
        for (const p of entry.manifest.permissions?.tools ?? []) tools.add(p);
        for (const p of entry.manifest.permissions?.secrets ?? []) secrets.add(p);
      }
      return {
        fs: [...fs].sort(),
        net: [...net].sort(),
        tools: [...tools].sort(),
        secrets: [...secrets].sort(),
      };
    },
  };
}
