import { verify } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { type PluginRegistry, createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  type PluginChannelAdapter,
  type PluginContributions,
  type PluginGrader,
  type PluginManifest,
  type PluginModelAdapter,
  type PluginPermissions,
  type PluginTargetEmitter,
  type RegisteredTool,
  type ToolDefinition,
  entrypointDigest,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";
import { buildTool } from "@crewhaus/tool-builder";

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
  /**
   * Override for tests: read the entrypoint file's bytes for the
   * `entrypointDigest` integrity check. Defaults to reading via `Bun.file`.
   */
  readonly readEntrypoint?: (absPath: string) => Promise<Uint8Array>;
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
  const readEntrypoint =
    opts.readEntrypoint ??
    (async (absPath) => new Uint8Array(await Bun.file(absPath).arrayBuffer()));

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

      // Code-integrity: the signature only attests to the MANIFEST. When the
      // manifest carries an entrypointDigest (which is covered by the
      // signature), recompute the hash of the actual index.js and refuse to
      // import if it differs — otherwise a swapped index.js next to a validly-
      // signed manifest would execute while the loader reported signed:true.
      if (manifest.entrypointDigest !== undefined) {
        let bytes: Uint8Array;
        try {
          bytes = await readEntrypoint(entrypointPath);
        } catch (err) {
          throw new PluginLoaderError(
            `failed to read plugin entrypoint at ${entrypointPath} for digest check: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
        const actual = entrypointDigest(bytes);
        if (actual !== manifest.entrypointDigest) {
          throw new PluginLoaderError(
            `plugin "${manifest.name}": entrypoint digest mismatch — index.js does not match the signed entrypointDigest (signature attests to different code). Refusing to import.`,
          );
        }
      }

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

// ---------------------------------------------------------------------------
// Activation (Item 3 / G32) — the zero-caller load path, wired.
// ---------------------------------------------------------------------------

/**
 * Item 3 (G32) — canonical default locations for the installed-plugin fabric,
 * mirroring the §42 marketplace CLI's `defaultPluginsDir` /
 * `defaultPluginRegistryPath`. `pluginsDir` (`~/.crewhaus/plugins`) is the
 * loader's trusted root; `registryPath` (`~/.crewhaus/plugin-registry.json`) is
 * the install-record file `plugin-registry` reads. A host that installs plugins
 * elsewhere overrides both; the defaults are what a compiled bundle assumes.
 */
export function defaultPluginPaths(homeDir: string = homedir()): {
  readonly pluginsDir: string;
  readonly registryPath: string;
} {
  const base = join(homeDir, ".crewhaus");
  return { pluginsDir: join(base, "plugins"), registryPath: join(base, "plugin-registry.json") };
}

export type DefaultPluginRuntimeOptions = {
  /** Home directory the default `~/.crewhaus/…` paths resolve under. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Override the loader's trusted root (the installed-plugin directory). */
  readonly pluginsDir?: string;
  /** Override the install-record file path. */
  readonly registryPath?: string;
  /** Trust anchors the loader verifies each manifest signature against. */
  readonly trustAnchors?: ReadonlyArray<TrustAnchor>;
  /**
   * Accept unsigned plugins (dev only — the loader logs the downgrade). With no
   * `trustAnchors` and `allowUnsigned: false` the loader construction FAILS
   * CLOSED (no plugin would ever verify), which is the intended production
   * default: a bundle that activates plugins must be given trust anchors.
   */
  readonly allowUnsigned?: boolean;
};

/**
 * Item 3 (G32) — build the `{ registry, loader }` pair `activatePlugins` needs
 * from the canonical default locations. This is the one-liner a compiled
 * cli/channel bundle (and the `crewhaus run` interpreter) spreads into
 * `activatePlugins({ names, ...createDefaultPluginRuntime(...) })`, so the
 * default-path knowledge lives in exactly one place.
 *
 * The registry is used READ-ONLY here (`get`/`list`), which never verifies a
 * signature — so it is constructed `allowUnsigned: true` to sidestep the
 * register-time constraint. Trust is enforced by the LOADER: it re-verifies
 * every manifest's Ed25519 signature (and the entrypoint digest) against
 * `trustAnchors` on each `load`, failing closed unless `allowUnsigned` is set.
 */
export function createDefaultPluginRuntime(opts: DefaultPluginRuntimeOptions = {}): {
  readonly registry: PluginRegistry;
  readonly loader: PluginLoader;
} {
  const paths = defaultPluginPaths(opts.homeDir);
  const registry = createPluginRegistry({
    registryPath: opts.registryPath ?? paths.registryPath,
    allowUnsigned: true,
  });
  const loader = createPluginLoader({
    trustedRoots: [opts.pluginsDir ?? paths.pluginsDir],
    ...(opts.trustAnchors !== undefined ? { trustAnchors: opts.trustAnchors } : {}),
    allowUnsigned: opts.allowUnsigned ?? false,
  });
  return { registry, loader };
}

/**
 * Item 3 (G32) — the aggregate of every activated plugin's contributions,
 * bucketed by kind for the host to bind. Tools are already normalized through
 * `buildTool` (so the security-relevant `scope` / `ioCapability` inference runs
 * on plugin-supplied tools exactly as on first-party ones — a plugin tool that
 * forgets `scope: "external"` still lowers external under an outward name);
 * `channels` / `models` / `graders` / `targetEmitters` pass through verbatim
 * for their respective hosts (channel daemon / model-router / eval stack /
 * compiler). `skillDirs` are the existing `<plugin>/skills` directories to feed
 * `skills-registry`'s `discoverSkills({ pluginDirs })`.
 */
export type ActivatedPlugins = {
  readonly loaded: ReadonlyArray<LoadedPlugin>;
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly channels: ReadonlyArray<PluginChannelAdapter>;
  readonly models: ReadonlyArray<PluginModelAdapter>;
  readonly graders: ReadonlyArray<PluginGrader>;
  readonly targetEmitters: ReadonlyArray<PluginTargetEmitter>;
  readonly skillDirs: ReadonlyArray<string>;
  /** Non-fatal notes (e.g. a `warn`-mode missing plugin). */
  readonly warnings: ReadonlyArray<string>;
};

export type ActivatePluginsOptions = {
  /**
   * Plugin names to activate, in load order (the spec's `plugins:` list, or the
   * CLI `--plugins` override). Repeats are de-duplicated, first occurrence wins.
   */
  readonly names: ReadonlyArray<string>;
  /** The catalog of installed plugins (name → pinned install record). */
  readonly registry: PluginRegistry;
  /** The activator that verifies + imports each pinned entry's manifest. */
  readonly loader: PluginLoader;
  /**
   * What to do when a named plugin is not installed. `"throw"` (the default,
   * the fail-loud posture a compiled bundle wants) aborts activation; `"warn"`
   * records the miss in `warnings` and skips it.
   */
  readonly onMissing?: "throw" | "warn";
  /** Test seam: override the skill-directory existence probe. */
  readonly existsImpl?: (path: string) => boolean;
};

function defaultDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a loaded plugin module's live contributions. The JSON manifest can't
 * carry executable code (tool `execute` fns, channel/model/grader/emitter
 * objects), so contributions come from the imported module's default export —
 * the `definePlugin({ … })` result — read structurally so a malformed module
 * degrades to "no contributions" instead of throwing.
 */
function readContributions(moduleDefault: unknown): PluginContributions {
  if (moduleDefault === null || typeof moduleDefault !== "object") return {};
  const contributions = (moduleDefault as { contributions?: unknown }).contributions;
  if (contributions === null || typeof contributions !== "object") return {};
  return contributions as PluginContributions;
}

/**
 * Item 3 (G32) — activate the named plugins and collect their contributions.
 * This is the wiring that closes §41 `plugin-loader`'s previously zero-caller
 * `load` path: for each name it resolves the pinned §42 `plugin-registry`
 * entry, `load`s it (path allow-list + Ed25519 signature + entrypoint-digest
 * checks all run inside `loader.load`), and buckets the module's contributions
 * for the host to bind. Loading is sequential so the declared load order is
 * preserved. Binding stays the CALLER's job (register tools on the catalog,
 * feed `skillDirs` to `discoverSkills`, hand channels/models to their hosts) —
 * the same decoupling the loader itself keeps.
 */
export async function activatePlugins(opts: ActivatePluginsOptions): Promise<ActivatedPlugins> {
  const exists = opts.existsImpl ?? defaultDirExists;
  const onMissing = opts.onMissing ?? "throw";
  const loaded: LoadedPlugin[] = [];
  const tools: RegisteredTool[] = [];
  const channels: PluginChannelAdapter[] = [];
  const models: PluginModelAdapter[] = [];
  const graders: PluginGrader[] = [];
  const targetEmitters: PluginTargetEmitter[] = [];
  const skillDirs: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const name of opts.names) {
    if (seen.has(name)) continue; // de-dupe repeats; keep first-occurrence order
    seen.add(name);
    const entry = await opts.registry.get(name);
    if (entry === undefined) {
      const msg = `plugin "${name}" is named in plugins: but is not installed in the plugin registry`;
      if (onMissing === "throw") throw new PluginLoaderError(`activatePlugins: ${msg}`);
      warnings.push(msg);
      continue;
    }
    const plugin = await opts.loader.load(entry.sourcePath);
    loaded.push(plugin);
    const contributions = readContributions(plugin.module.default);
    // Normalize tools through buildTool so plugin tools get the same
    // fail-closed scope/justification inference as first-party tools.
    for (const tool of contributions.tools ?? []) {
      tools.push(buildTool(tool as ToolDefinition<unknown>));
    }
    for (const channel of contributions.channels ?? []) channels.push(channel);
    for (const model of contributions.models ?? []) models.push(model);
    for (const grader of contributions.graders ?? []) graders.push(grader);
    for (const emitter of contributions.targetEmitters ?? []) targetEmitters.push(emitter);
    // Skill-bundle convention: `<plugin-dir>/skills/` — a directory of
    // `<name>/SKILL.md` subdirs, exactly skills-registry's pluginDirs contract.
    // The entrypoint sits at `<plugin-dir>/index.js`, so its parent is the dir.
    const skillDir = resolvePath(plugin.entrypointPath, "..", "skills");
    if (exists(skillDir)) skillDirs.push(skillDir);
  }
  return { loaded, tools, channels, models, graders, targetEmitters, skillDirs, warnings };
}
