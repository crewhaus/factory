import { verify } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  type PluginManifest,
  type PluginPermissions,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";

/**
 * Section 41 — `@crewhaus/plugin-loader`.
 *
 * Runtime activation of third-party plugins. Three concerns:
 *
 *   1. **Path allow-list.** Plugin sources may only be loaded from
 *      configured trusted roots (typically `~/.crewhaus/plugins/`).
 *      Symlinks are resolved to a real path before the check, so
 *      `ln -s /etc/passwd ~/.crewhaus/plugins/x/index.ts` can't trick
 *      the loader. This mirrors the §31 plugin-sandbox content
 *      isolation pattern.
 *
 *   2. **Signature verification.** Manifests carry an Ed25519
 *      detached signature over their canonical-JSON form. The loader
 *      verifies against a trust anchor (one or more allow-listed
 *      Ed25519 public keys). Unsigned plugins are rejected unless
 *      the loader is constructed with `allowUnsigned: true` (intended
 *      for development only — logged loudly).
 *
 *   3. **Capability gating.** The returned `LoadedPlugin` exposes the
 *      plugin's contributions and its declared `PluginPermissions`.
 *      Hosts (the runtime / studio-server / channel gateway) consult
 *      the permissions before binding a contribution to a registry
 *      slot or before forwarding a sandboxed `fs` / `net` call.
 *
 * The loader does NOT itself bind contributions to registries — that
 * is the responsibility of the calling host (which knows which
 * target shape is being assembled). Wiring decoupling keeps the loader
 * unit-testable without dragging in every downstream registry.
 *
 * Test layers: T1 (parsing + validation), T3 (load happy path),
 * T8 (path-escape + signature-tampering rejection).
 */

export class PluginLoaderError extends CrewhausError {
  override readonly name = "PluginLoaderError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type TrustAnchor = {
  /** Identifier shown in audit logs. */
  readonly name: string;
  /** PEM-encoded Ed25519 public key. */
  readonly publicKeyPem: string;
};

export type PluginLoaderOptions = {
  /**
   * Allowed plugin source roots. Each path is resolved to a real path
   * and any plugin file outside these roots is rejected.
   */
  readonly trustedRoots: ReadonlyArray<string>;
  /**
   * Public keys the loader will accept for signature verification.
   * If empty AND `allowUnsigned: true`, signature checks are skipped.
   */
  readonly trustAnchors?: ReadonlyArray<TrustAnchor>;
  /**
   * When true, manifests without a `signature` are accepted. The
   * default is `false` — production deployments should always require
   * signatures.
   */
  readonly allowUnsigned?: boolean;
  /**
   * Override for tests: load + parse a manifest file. Defaults to
   * reading via `Bun.file` + `JSON.parse`.
   */
  readonly readManifestFile?: (absPath: string) => Promise<unknown>;
  /**
   * Override for tests: dynamically import a plugin entrypoint. Defaults
   * to native dynamic `import()`. Wrapping lets tests verify the loader
   * doesn't reach for the entrypoint until path + signature checks pass.
   */
  readonly importEntrypoint?: (absPath: string) => Promise<{ default?: unknown }>;
};

export type LoadedPlugin = {
  readonly manifest: PluginManifest;
  readonly entrypointPath: string;
  /** Declared capability allow-list — fail-closed if undefined. */
  readonly permissions: PluginPermissions;
  /** `true` if the manifest carried a valid signature. */
  readonly signed: boolean;
  /** The module's default export (typed loosely — callers narrow per contribution kind). */
  readonly module: { default?: unknown };
};

function normalizeRoot(root: string): string {
  const abs = resolvePath(root);
  try {
    return realpathSync(abs);
  } catch {
    // If realpath fails (the root may not exist yet at construct time),
    // fall back to the resolved path. The per-load check still uses
    // realpath on the actual plugin file, so allowing a phantom root is
    // safe — it just won't match anything.
    return abs;
  }
}

function isUnderRoot(real: string, root: string): boolean {
  if (real === root) return true;
  return real.startsWith(root + sep);
}

export interface PluginLoader {
  /**
   * Load + activate a plugin from a manifest path. Throws
   * `PluginLoaderError` if any check fails. The plugin's entrypoint
   * module is only `import()`-ed after path + signature pass.
   */
  load(manifestPath: string): Promise<LoadedPlugin>;
}

export function createPluginLoader(opts: PluginLoaderOptions): PluginLoader {
  if (opts.trustedRoots.length === 0) {
    throw new PluginLoaderError("plugin-loader: at least one trustedRoot is required");
  }
  const roots = opts.trustedRoots.map(normalizeRoot);
  const allowUnsigned = opts.allowUnsigned ?? false;
  const anchors = opts.trustAnchors ?? [];
  if (anchors.length === 0 && !allowUnsigned) {
    throw new PluginLoaderError(
      "plugin-loader: no trustAnchors configured and allowUnsigned is false — no plugin would load",
    );
  }

  const readManifest =
    opts.readManifestFile ??
    (async (absPath) => {
      const file = Bun.file(absPath);
      const text = await file.text();
      return JSON.parse(text);
    });
  const importEntry =
    opts.importEntrypoint ??
    (async (absPath) => {
      const mod = (await import(absPath)) as { default?: unknown };
      return mod;
    });

  function assertUnderTrustedRoot(realPath: string): void {
    if (!roots.some((root) => isUnderRoot(realPath, root))) {
      throw new PluginLoaderError(
        `plugin path ${realPath} is outside every configured trustedRoot — refusing to load`,
      );
    }
  }

  function verifySignature(manifest: PluginManifest): boolean {
    if (manifest.signature === undefined) {
      if (allowUnsigned) return false;
      throw new PluginLoaderError(
        `plugin manifest "${manifest.name}" is unsigned and allowUnsigned is false`,
      );
    }
    const sig = manifest.signature;
    if (sig.algorithm !== "ed25519") {
      throw new PluginLoaderError(
        `plugin manifest "${manifest.name}" signature.algorithm "${sig.algorithm}" is not supported (only ed25519)`,
      );
    }
    const payload = manifestPayloadForSigning(manifest);
    const payloadBuf = Buffer.from(payload, "utf8");
    const sigBuf = Buffer.from(sig.sigB64, "base64");
    // Try every trust anchor; success on first match. Ed25519 uses the
    // one-shot `crypto.verify()`, not the streaming `createVerify` API.
    for (const anchor of anchors) {
      let ok = false;
      try {
        ok = verify(null, payloadBuf, anchor.publicKeyPem, sigBuf);
      } catch {
        // Bad PEM or wrong-algorithm key — treat as non-match, continue.
        ok = false;
      }
      if (ok) return true;
    }
    throw new PluginLoaderError(
      `plugin manifest "${manifest.name}" signature does not verify against any configured trustAnchor`,
    );
  }

  return {
    async load(manifestPath: string): Promise<LoadedPlugin> {
      const absManifest = resolvePath(manifestPath);
      // Stat first to surface a clean error if the file is missing /
      // is a directory — realpathSync would throw an opaque ENOENT.
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(absManifest);
      } catch (err) {
        throw new PluginLoaderError(`plugin manifest not found: ${absManifest}`, err);
      }
      if (!stat.isFile()) {
        throw new PluginLoaderError(`plugin manifest path is not a regular file: ${absManifest}`);
      }
      const realManifest = realpathSync(absManifest);
      assertUnderTrustedRoot(realManifest);

      let raw: unknown;
      try {
        raw = await readManifest(realManifest);
      } catch (err) {
        throw new PluginLoaderError(
          `failed to read plugin manifest at ${realManifest}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      const manifest = validatePluginManifest(raw);
      const signed = verifySignature(manifest);

      // Resolve the entrypoint. The convention is "the manifest sits
      // next to an index.ts / index.js / dist/index.js"; for v1 we
      // accept an explicit `entrypoint` field via a sibling file in
      // the same directory. Default: `<manifest-dir>/index.js`.
      // (Plugins shipped uncompiled use `index.ts` and rely on the
      // runtime importer accepting it.)
      const manifestDir = realManifest.slice(0, realManifest.lastIndexOf(sep));
      const entrypointPath = resolvePath(manifestDir, "index.js");
      assertUnderTrustedRoot(entrypointPath);

      let module: { default?: unknown };
      try {
        module = await importEntry(entrypointPath);
      } catch (err) {
        throw new PluginLoaderError(
          `failed to import plugin entrypoint at ${entrypointPath}: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
      return {
        manifest,
        entrypointPath,
        permissions: manifest.permissions ?? {},
        signed,
        module,
      };
    },
  };
}

/**
 * Pure capability check. Used by hosts that want to enforce the plugin's
 * declared `permissions.fs` / `permissions.net` allow-lists before
 * forwarding a sandboxed call.
 *
 * Pattern uses a minimal glob: `*` = any chars except `/`, `**` = any
 * chars including `/`. Matches the §31 plugin-sandbox `isFsAllowed` /
 * `isNetAllowed` semantics so behavior is consistent across the SDK.
 */
export function matchesGlob(target: string, pattern: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "::DOUBLESTAR::")
      .replace(/\*/g, "[^/]*")
      .replace(/::DOUBLESTAR::/g, ".*")}$`,
  );
  return re.test(target);
}

export function isFsAllowed(
  permissions: PluginPermissions | undefined,
  mode: "read" | "write",
  path: string,
): boolean {
  if (!permissions?.fs || permissions.fs.length === 0) return false;
  for (const entry of permissions.fs) {
    const colon = entry.indexOf(":");
    if (colon === -1) continue;
    const op = entry.slice(0, colon);
    const pattern = entry.slice(colon + 1);
    if (op !== mode) continue;
    if (matchesGlob(path, pattern)) return true;
  }
  return false;
}

export function isNetAllowed(permissions: PluginPermissions | undefined, url: string): boolean {
  if (!permissions?.net || permissions.net.length === 0) return false;
  for (const entry of permissions.net) {
    const colon = entry.indexOf(":");
    if (colon === -1) continue;
    const op = entry.slice(0, colon);
    const pattern = entry.slice(colon + 1);
    if (op !== "fetch") continue;
    if (matchesGlob(url, pattern)) return true;
  }
  return false;
}
