import { createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve as resolvePath, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { type PluginRegistry, createPluginRegistry } from "@crewhaus/plugin-registry";
import {
  PLUGIN_TOOL_NAME_PATTERN,
  type PluginChannelAdapter,
  type PluginContributions,
  type PluginGrader,
  type PluginManifest,
  type PluginModelAdapter,
  type PluginPermissions,
  type PluginTargetEmitter,
  type RegisteredTool,
  type ToolDefinition,
  canonicalJson,
  crewhausEngineProblem,
  entrypointDigest,
  entrypointImportProblem,
  manifestExpiryProblem,
  manifestPayloadForSigning,
  validatePluginManifest,
} from "@crewhaus/plugin-sdk";
import { auditToolScopes, buildTool } from "@crewhaus/tool-builder";
import { type ToolExecuteContext, legacyMcpToolName } from "@crewhaus/tool-catalog";
import { RUNTIME_TOOL_NAMES, TOOL_FLAGS_BY_NAME } from "@crewhaus/tool-registry-manifest/flags";
import {
  createExclusive,
  openForRead,
  probeKind,
  resolveContained,
} from "@crewhaus/tool-safety/fs";
import { readFileBounded } from "@crewhaus/tool-safety/streams";
import type { ZodType as Zod4Type } from "zod/v4";
import pkg from "../package.json" with { type: "json" };

/**
 * The crewhaus version a plugin's `engines.crewhaus` range is checked against:
 * this package's own version, which the release train bumps in lockstep with
 * every other crewhaus package. A static import, so a compiled bundle carries
 * the version it was built from.
 */
export const PLUGIN_HOST_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/** The largest `plugin.json` the loader reads. A manifest is metadata; this is generous. */
export const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;
/** The largest `index.js` the loader reads for its digest check (the marketplace's cap too). */
export const MAX_PLUGIN_ENTRYPOINT_BYTES = 64 * 1024 * 1024;

/**
 * Section 41 — `@crewhaus/plugin-loader`.
 *
 * Runtime activation of third-party plugins. Three concerns:
 *
 *   1. **Path allow-list.** Plugin sources may only be loaded from
 *      configured trusted roots (typically `~/.crewhaus/plugins/`).
 *      Symlinks are resolved to a real path before the check: the
 *      manifest must really sit under a trusted root, and its `index.js`
 *      must really sit inside the manifest's own directory, so
 *      `ln -s /tmp/evil.js ~/.crewhaus/plugins/x/index.js` is refused
 *      rather than imported. The entrypoint must be a regular file (a
 *      FIFO or device is refused, never read), and both files are read
 *      with a byte cap.
 *
 *   2. **Signature verification.** Manifests carry an Ed25519
 *      detached signature over their canonical-JSON form. The loader
 *      verifies against a trust anchor (one or more allow-listed
 *      Ed25519 public keys). Unsigned plugins are rejected unless
 *      the loader is constructed with `allowUnsigned: true` (intended
 *      for development only — logged loudly). A signed manifest must
 *      carry an `entrypointDigest`, may carry a signed `notAfter`, and
 *      its code is imported from a private copy of exactly the bytes
 *      the digest was checked against, staged under the operator's own
 *      `~/.crewhaus/verified-code` — which is why a signed plugin must be
 *      one ES module file that loads nothing but runtime builtins.
 *
 *   3. **What a plugin can reach.** A plugin's code is imported into this
 *      process and runs with its full authority — environment, files,
 *      network — from the moment it is imported. `permissions.tools` is
 *      applied: a plugin tool's `ctx.bridge` shows only `runContext` and
 *      the host tools it names (see {@link pluginBridgeView}). `fs`, `net`
 *      and `secrets` are declarations crewhaus does not enforce on plugin
 *      code; only the Hangar's declarative panes evaluate them (with
 *      {@link isFsAllowed} / {@link isNetAllowed}).
 *
 * The loader does NOT itself bind contributions to registries — that
 * is the responsibility of the calling host (which knows which
 * target shape is being assembled). Wiring decoupling keeps the loader
 * unit-testable without dragging in every downstream registry. In this
 * release hosts bind a plugin's tools and its `skills/` directory only;
 * see {@link UNBOUND_CONTRIBUTION_KINDS}.
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
   * Where a dev-mode downgrade is reported: every plugin loaded without a
   * verified signature under `allowUnsigned`. Defaults to stderr.
   */
  readonly warn?: (line: string) => void;
  /**
   * The crewhaus version a manifest's `engines.crewhaus` range must include.
   * Defaults to {@link PLUGIN_HOST_VERSION}; tests pin it.
   */
  readonly hostVersion?: string;
  /**
   * Where a signed plugin's verified code is staged for import: a private
   * directory is made here for each load and removed after it. It must be
   * this user's and writable by nobody else. Defaults to
   * {@link defaultVerifiedCodeDir} (`~/.crewhaus/verified-code`).
   */
  readonly verifiedCodeDir?: string;
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
  /**
   * The manifest's declared permissions. Only `tools` is applied at runtime
   * (it bounds what `ctx.bridge` shows the plugin's tools); the rest are
   * declarations. See {@link pluginBridgeView}.
   */
  readonly permissions: PluginPermissions;
  /**
   * `true` when the manifest's signature verified against a trust anchor, and
   * the code that was imported is exactly the bytes its signed
   * `entrypointDigest` names. `false` for a plugin loaded in development mode.
   */
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

/** The default manifest reader: at most {@link MAX_PLUGIN_MANIFEST_BYTES}, a regular file only. */
async function readManifestBounded(absPath: string): Promise<unknown> {
  const read = await readFileBounded(absPath, { maxBytes: MAX_PLUGIN_MANIFEST_BYTES });
  if (!read.ok) throw new Error(read.reason);
  if (read.truncated) throw new Error(`it is larger than ${MAX_PLUGIN_MANIFEST_BYTES} bytes`);
  return JSON.parse(read.text);
}

/**
 * The default entrypoint reader: the file at `absPath` (already resolved and
 * contained), read only if it is still a regular file there and not a link —
 * a swap between the check and the read is refused, not followed — and at
 * most {@link MAX_PLUGIN_ENTRYPOINT_BYTES}.
 */
async function readEntrypointBounded(absPath: string): Promise<Uint8Array> {
  const read = await openForRead(dirname(absPath), basename(absPath), {
    maxBytes: MAX_PLUGIN_ENTRYPOINT_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok) {
    throw Object.assign(
      new Error(read.reason),
      read.code === "not-found" ? { code: "ENOENT" } : {},
    );
  }
  if (read.truncated) throw new Error(`it is larger than ${MAX_PLUGIN_ENTRYPOINT_BYTES} bytes`);
  return read.bytes;
}

/**
 * The file a plugin's `<manifestDir>/index.js` really is. It must be inside
 * the plugin's own directory — a link to another directory, even another
 * plugin's, is refused — and a regular file: a FIFO would block the read and
 * a device never ends. When there is nothing there at all the name is
 * returned as it is, and reading or importing it reports the missing code.
 */
function resolveEntrypoint(pluginName: string, manifestDir: string): string {
  const shown = join(manifestDir, "index.js");
  const contained = resolveContained(manifestDir, "index.js");
  if (!contained.ok) {
    throw new PluginLoaderError(
      contained.code === "escapes-root"
        ? `plugin "${pluginName}": ${shown} is a link that leads outside the plugin's directory ${manifestDir}; only code inside it is loaded — refusing to load it`
        : `plugin "${pluginName}": ${shown}: ${contained.reason} — refusing to load it`,
    );
  }
  const probe = probeKind(contained.real, { given: shown });
  if (!probe.ok) {
    if (probe.code === "not-found") return contained.real;
    throw new PluginLoaderError(`plugin "${pluginName}": ${probe.reason} — refusing to load it`);
  }
  if (probe.kind !== "file") {
    throw new PluginLoaderError(
      `plugin "${pluginName}": ${shown} is a ${probe.kind}, not a regular file — refusing to load it`,
    );
  }
  return contained.real;
}

/** Where a signed plugin's verified code is staged by default: `~/.crewhaus/verified-code`. */
export function defaultVerifiedCodeDir(homeDir: string = homedir()): string {
  return join(homeDir, ".crewhaus", "verified-code");
}

/**
 * Why `dir` cannot hold a signed plugin's verified code, or undefined when it
 * can: it must be a real directory (not a link), and — where the platform
 * has owners — this user's and writable by nobody else. Anyone who can write
 * there could swap the copy before it is imported, or plant a package beside
 * it for the plugin's code to find.
 */
function stagingDirProblem(dir: string): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (err) {
    return `it cannot be read (${err instanceof Error ? err.message : String(err)})`;
  }
  if (st.isSymbolicLink()) return "it is a link";
  if (!st.isDirectory()) return "it is not a directory";
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return undefined;
  if (st.uid !== uid) return `it belongs to another user (uid ${st.uid})`;
  if ((st.mode & 0o022) !== 0) {
    return `other users can write to it (mode ${(st.mode & 0o777).toString(8)}); run chmod go-w on it`;
  }
  return undefined;
}

/**
 * Stage a signed plugin's verified bytes for import: a new private directory
 * (mode 0700, random name) under `parent` holding `index.mjs` (0600), created
 * exclusively. Importing this copy instead of the file in
 * `~/.crewhaus/plugins` means what runs is what was hashed — the plugin's
 * file can change after the check and it does not matter — and a relative
 * import has nothing beside it to find. `.mjs` makes it an ES module
 * whatever package.json sits above it, so it has no CommonJS `module` to
 * load packages through.
 *
 * `parent` defaults to `~/.crewhaus/verified-code`, never the shared temp
 * directory: a package the code names at run time resolves by walking up
 * from the copy, and on Linux `/tmp/node_modules` is anyone's to create. It
 * must be this user's and writable by nobody else, or nothing is staged.
 * `remove` deletes the directory once the module is loaded.
 */
function writeVerifiedCopy(
  pluginName: string,
  bytes: Uint8Array,
  parent: string,
): { readonly path: string; readonly remove: () => void } {
  const refuse = (why: string, err?: unknown): PluginLoaderError =>
    new PluginLoaderError(
      `plugin "${pluginName}": cannot stage its verified code for import in ${parent}: ${why}`,
      err,
    );
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err), err);
  }
  const unsafe = stagingDirProblem(parent);
  if (unsafe !== undefined) throw refuse(unsafe);
  let dir: string;
  try {
    dir = mkdtempSync(join(parent, `${pluginName}-`));
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err), err);
  }
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    const made = createExclusive(dir, "index.mjs", { mode: 0o600 });
    if (!made.ok) throw new Error(made.reason);
    try {
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(made.fd, bytes, written, bytes.length - written);
      }
    } finally {
      closeSync(made.fd);
    }
    return { path: made.real, remove };
  } catch (err) {
    remove();
    throw refuse(err instanceof Error ? err.message : String(err), err);
  }
}

/**
 * Who the caller expects to find at a manifest path: the plugin registry's
 * name for the entry, and the version it pins. A manifest that is someone
 * else is refused before it is verified or imported.
 */
export type ExpectedPlugin = {
  readonly name?: string;
  readonly version?: string;
};

/**
 * Why `manifest` (read from `where`) is not the plugin `expected` names, or
 * undefined when it is.
 */
export function pluginIdentityProblem(
  expected: ExpectedPlugin,
  manifest: Pick<PluginManifest, "name" | "version">,
  where: string,
): string | undefined {
  if (expected.name !== undefined && manifest.name !== expected.name) {
    return `the plugin registry lists "${expected.name}" at ${where}, but that manifest is plugin "${manifest.name}" — refusing to load it under "${expected.name}"`;
  }
  if (expected.version !== undefined && manifest.version !== expected.version) {
    return `plugin "${manifest.name}" is pinned to ${expected.version} in the plugin registry, but ${where} is version ${manifest.version} — refusing to load it. Install ${expected.version}, or clear the pin.`;
  }
  return undefined;
}

export interface PluginLoader {
  /**
   * Load + activate a plugin from a manifest path. Throws
   * `PluginLoaderError` if any check fails. The plugin's entrypoint
   * module is only `import()`-ed after path + signature pass, and after the
   * manifest is found to be the plugin `expected` names.
   */
  load(manifestPath: string, expected?: ExpectedPlugin): Promise<LoadedPlugin>;
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

  const readManifest = opts.readManifestFile ?? readManifestBounded;
  const importEntry =
    opts.importEntrypoint ??
    (async (absPath) => {
      const mod = (await import(absPath)) as { default?: unknown };
      return mod;
    });
  const readEntrypoint = opts.readEntrypoint ?? readEntrypointBounded;

  function assertUnderTrustedRoot(realPath: string): void {
    if (!roots.some((root) => isUnderRoot(realPath, root))) {
      throw new PluginLoaderError(
        `plugin path ${realPath} is outside every configured trustedRoot — refusing to load`,
      );
    }
  }

  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const hostVersion = opts.hostVersion ?? PLUGIN_HOST_VERSION;

  /** The error for an entrypoint that cannot be read or imported; `failed` says which. */
  function entrypointError(
    manifest: PluginManifest,
    entrypointPath: string,
    failed: string,
    err: unknown,
  ): PluginLoaderError {
    if (!existsSync(entrypointPath)) {
      // 0.7.x `crewhaus plugins install` writes the manifest only, so this is
      // what an installed-but-never-supplied plugin looks like at boot.
      return new PluginLoaderError(
        `plugin "${manifest.name}" has no index.js next to its plugin.json: expected ${entrypointPath}. \`crewhaus plugins install\` delivers the manifest only; put the plugin's code there (its sha256 must equal the manifest's entrypointDigest when one is set).`,
        err,
      );
    }
    return new PluginLoaderError(
      `${failed}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  function verifySignature(manifest: PluginManifest): boolean {
    if (manifest.signature === undefined) {
      if (allowUnsigned) {
        warn(
          `[plugins] "${manifest.name}" is unsigned and loads only because CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — development only`,
        );
        return false;
      }
      throw new PluginLoaderError(
        `plugin manifest "${manifest.name}" is unsigned and allowUnsigned is false`,
      );
    }
    if (anchors.length === 0 && allowUnsigned) {
      // Dev mode with nothing to check against: the signature cannot be
      // verified either way, so the plugin is loaded as unverified — the same
      // standing as an unsigned one — rather than refused for being signed.
      warn(
        `[plugins] "${manifest.name}" is signed, but no trust anchor is configured to check it; it loads unverified only because CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — development only`,
      );
      return false;
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
    async load(manifestPath: string, expected: ExpectedPlugin = {}): Promise<LoadedPlugin> {
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
      const notExpected = pluginIdentityProblem(expected, manifest, realManifest);
      if (notExpected !== undefined) throw new PluginLoaderError(notExpected);
      // A plugin that says which crewhaus it runs on is held to it, before
      // anything else about it is trusted or run.
      const engineProblem = crewhausEngineProblem(manifest, hostVersion);
      if (engineProblem !== undefined) {
        throw new PluginLoaderError(`${engineProblem} — refusing to load it`);
      }
      let signed = verifySignature(manifest);
      const expired = manifestExpiryProblem(manifest, Date.now());
      if (expired !== undefined) {
        throw new PluginLoaderError(`${expired} — refusing to load it`);
      }

      // The entrypoint is `<manifest-dir>/index.js`. `entrypointPath` is that
      // name (activatePlugins finds `<plugin>/skills` beside it);
      // `realEntry` is the file it really is, which is what gets hashed and
      // imported, so a link out of the plugin's directory cannot smuggle in
      // code from elsewhere.
      const manifestDir = dirname(realManifest);
      const entrypointPath = join(manifestDir, "index.js");
      const realEntry = resolveEntrypoint(manifest.name, manifestDir);

      // A signature that names no code attests to nothing that runs: without
      // an entrypointDigest, index.js could be anything.
      if (signed && manifest.entrypointDigest === undefined) {
        if (!allowUnsigned) {
          throw new PluginLoaderError(
            `plugin "${manifest.name}" is signed, but its manifest has no entrypointDigest, so the signature covers none of its code — refusing to load it. The publisher must re-sign it with entrypointDigest set to the sha256 of its index.js.`,
          );
        }
        warn(
          `[plugins] "${manifest.name}" is signed, but has no entrypointDigest, so the signature covers none of its code; it loads unverified only because CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1 — development only`,
        );
        signed = false;
      }

      // Code-integrity: the signature only attests to the MANIFEST. When the
      // manifest carries an entrypointDigest (which is covered by the
      // signature), recompute the hash of the actual index.js and refuse to
      // import if it differs — otherwise a swapped index.js next to a validly-
      // signed manifest would execute while the loader reported signed:true.
      // For a VERIFIED plugin, the bytes that were hashed are the bytes that
      // are imported (a private copy of them), and they may import nothing
      // the digest does not cover.
      let importPath = realEntry;
      let verifiedCopy: { readonly path: string; readonly remove: () => void } | undefined;
      if (manifest.entrypointDigest !== undefined) {
        let bytes: Uint8Array;
        try {
          bytes = await readEntrypoint(realEntry);
        } catch (err) {
          throw entrypointError(
            manifest,
            entrypointPath,
            `failed to read plugin entrypoint at ${entrypointPath} for digest check`,
            err,
          );
        }
        const actual = entrypointDigest(bytes);
        if (actual !== manifest.entrypointDigest) {
          throw new PluginLoaderError(
            `plugin "${manifest.name}": entrypoint digest mismatch — index.js does not match the signed entrypointDigest (signature attests to different code). Refusing to import.`,
          );
        }
        if (signed) {
          const outside = entrypointImportProblem(bytes);
          if (outside !== undefined) {
            throw new PluginLoaderError(
              `plugin "${manifest.name}": ${entrypointPath} cannot run as signed code: ${outside}`,
            );
          }
          verifiedCopy = writeVerifiedCopy(
            manifest.name,
            bytes,
            opts.verifiedCodeDir ?? defaultVerifiedCodeDir(),
          );
          importPath = verifiedCopy.path;
        }
      }

      let module: { default?: unknown };
      try {
        module = await importEntry(importPath);
      } catch (err) {
        throw entrypointError(
          manifest,
          entrypointPath,
          `failed to import plugin entrypoint at ${entrypointPath}`,
          err,
        );
      } finally {
        verifiedCopy?.remove();
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
 * chars including `/` (but not a line break). Every other character,
 * `?` included, stands for itself. Matches the §31 plugin-sandbox
 * `isFsAllowed` / `isNetAllowed` semantics so behavior is consistent
 * across the SDK.
 *
 * The pattern comes from a plugin's manifest, so it is matched in time
 * proportional to the pattern's length times the target's — never by a
 * backtracking regex, where `*a*a*a…` against a long run of `a` takes
 * exponential time. `work`, when passed, has the number of positions
 * visited added to `work.steps` (a count of the work that does not depend
 * on how busy the machine is).
 */
export function matchesGlob(target: string, pattern: string, work?: { steps: number }): boolean {
  const n = target.length;
  // reach[j] is 1 when the pattern read so far matches target.slice(0, j).
  let reach = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  reach[0] = 1;
  let steps = 0;
  let i = 0;
  while (i < pattern.length) {
    next.fill(0);
    let any = false;
    if (pattern[i] === "*") {
      const double = pattern[i + 1] === "*";
      i += double ? 2 : 1;
      // A match can start wherever the pattern so far ends, and runs on until
      // a character the wildcard does not cover.
      let open = false;
      for (let j = 0; j <= n; j++) {
        if (j > 0 && open) {
          const c = target.charCodeAt(j - 1);
          if (double ? isLineTerminator(c) : c === SLASH) open = false;
        }
        if (reach[j] === 1) open = true;
        if (open) {
          next[j] = 1;
          any = true;
        }
      }
      steps += n + 1;
    } else {
      const c = pattern.charCodeAt(i);
      i += 1;
      for (let j = 0; j < n; j++) {
        if (reach[j] === 1 && target.charCodeAt(j) === c) {
          next[j + 1] = 1;
          any = true;
        }
      }
      steps += n;
    }
    [reach, next] = [next, reach];
    if (!any) break;
  }
  if (work !== undefined) work.steps += steps;
  return reach[n] === 1;
}

const SLASH = 0x2f;

/** The characters `**` does not cross: those a regex `.` does not match, as 0.7.0's `.*` did not. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
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
    verifiedCodeDir: defaultVerifiedCodeDir(opts.homeDir),
  });
  return { registry, loader };
}

/** Names a list of PEM files (or directories of them) the loader trusts, beside the default directory. */
export const PLUGIN_TRUST_ANCHORS_ENV = "CREWHAUS_PLUGIN_TRUST_ANCHORS";
/** `1` loads unsigned plugins. Development only; every boot says so. */
export const PLUGIN_ALLOW_UNSIGNED_ENV = "CREWHAUS_PLUGIN_ALLOW_UNSIGNED";

/** The documented trust-anchor directory: `~/.crewhaus/plugin-trust`, one `*.pem` per publisher. */
export function defaultTrustAnchorDir(homeDir: string = homedir()): string {
  return join(homeDir, ".crewhaus", "plugin-trust");
}

/**
 * Read the operator's trust anchors: every `*.pem` in
 * `~/.crewhaus/plugin-trust/`, and every file or directory listed in
 * `CREWHAUS_PLUGIN_TRUST_ANCHORS` (separated like PATH). Each must hold one
 * Ed25519 public key. A listed path that does not exist, or a file that is not
 * such a key, is a problem the caller refuses to boot on — an anchor the
 * operator meant to trust and silently lost is how signed plugins stop
 * verifying. A missing default directory is not a problem.
 */
export function loadTrustAnchors(
  opts: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
  } = {},
): { readonly anchors: ReadonlyArray<TrustAnchor>; readonly problems: ReadonlyArray<string> } {
  const env = opts.env ?? process.env;
  const anchors: TrustAnchor[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const readKey = (file: string): void => {
    const abs = resolvePath(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    let pem: string;
    try {
      pem = readFileSync(abs, "utf8");
    } catch (err) {
      problems.push(`cannot read trust anchor ${abs}: ${(err as Error).message}`);
      return;
    }
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") {
        problems.push(
          `trust anchor ${abs} is a ${key.asymmetricKeyType} key; plugins are signed with Ed25519`,
        );
        return;
      }
    } catch {
      problems.push(`trust anchor ${abs} is not a PEM public key`);
      return;
    }
    anchors.push({ name: abs, publicKeyPem: pem });
  };
  const readDir = (dir: string, required: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir)
        .filter((f) => f.endsWith(".pem"))
        .sort();
    } catch (err) {
      if (required)
        problems.push(`cannot read trust anchor directory ${dir}: ${(err as Error).message}`);
      return;
    }
    for (const f of entries) readKey(join(dir, f));
  };
  readDir(defaultTrustAnchorDir(opts.homeDir), false);
  for (const raw of (env[PLUGIN_TRUST_ANCHORS_ENV] ?? "").split(delimiter)) {
    const path = raw.trim();
    if (path === "") continue;
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch (err) {
      problems.push(
        `${PLUGIN_TRUST_ANCHORS_ENV} lists ${path}, which cannot be read: ${(err as Error).message}`,
      );
      continue;
    }
    if (isDir) readDir(path, true);
    else readKey(path);
  }
  return { anchors, problems };
}

/**
 * The plugin runtime every boot path uses — a compiled cli or channel bundle
 * and `crewhaus run`. Trust anchors come from the documented places
 * ({@link loadTrustAnchors}), so a signed plugin verifies. Unsigned plugins
 * stay refused unless `CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1`, and that downgrade
 * is announced on every boot.
 *
 * With neither an anchor nor the downgrade, no plugin could ever load, so
 * this refuses to boot and says what to do.
 */
export function createBootPluginRuntime(
  opts: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly warn?: (line: string) => void;
  } = {},
): {
  readonly registry: PluginRegistry;
  readonly loader: PluginLoader;
  /**
   * Where the boot's plugin warnings go (stderr by default). Spread into
   * {@link activatePlugins} with the rest, so a plugin tool it leaves out is
   * reported on every boot path without the host printing `warnings` itself.
   */
  readonly warn: (line: string) => void;
} {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { anchors, problems } = loadTrustAnchors({
    env,
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  });
  if (problems.length > 0) {
    throw new PluginLoaderError(`plugin trust anchors: ${problems.join("; ")}`);
  }
  const allowUnsigned = env[PLUGIN_ALLOW_UNSIGNED_ENV] === "1";
  if (allowUnsigned) {
    warn(
      `[plugins] ${PLUGIN_ALLOW_UNSIGNED_ENV}=1 — unsigned plugins load without verification. Development only; unset it in production.`,
    );
  }
  if (anchors.length === 0 && !allowUnsigned) {
    throw new PluginLoaderError(
      `no plugin can be verified: no trust anchor is configured. Put the publisher's Ed25519 public key (a .pem file) in ${defaultTrustAnchorDir(opts.homeDir)}, or list .pem files in ${PLUGIN_TRUST_ANCHORS_ENV}. For development only, ${PLUGIN_ALLOW_UNSIGNED_ENV}=1 loads unsigned plugins.`,
    );
  }
  const paths = defaultPluginPaths(opts.homeDir);
  const registry = createPluginRegistry({ registryPath: paths.registryPath, allowUnsigned: true });
  const loader = createPluginLoader({
    trustedRoots: [paths.pluginsDir],
    trustAnchors: anchors,
    allowUnsigned,
    warn,
    verifiedCodeDir: defaultVerifiedCodeDir(opts.homeDir),
  });
  return { registry, loader, warn };
}

/** The host tools in `tools` that `allowedTools` names. */
function declaredHostTools(tools: unknown, allowedTools: ReadonlySet<string>): RegisteredTool[] {
  if (!Array.isArray(tools)) return [];
  return tools.filter(
    (t): t is RegisteredTool =>
      t !== null &&
      typeof t === "object" &&
      typeof (t as { name?: unknown }).name === "string" &&
      allowedTools.has((t as { name: string }).name),
  );
}

/**
 * What a plugin tool sees as `ctx.bridge`. The runtime hands every tool the
 * same bridge — the whole tool catalog (each tool's raw `execute`), the
 * permission rules, the approvals store, the sub-agent spawner, the run
 * state — which first-party tools like `Task` need. A plugin tool gets
 * `runContext` (boundary tagging reads it) and only the host tools its
 * manifest's `permissions.tools` names, each a frozen copy.
 *
 * A declared host tool runs with `hostCtx`, the context the runtime gave the
 * plugin tool's own call, whatever context the plugin passes it: so `Task`
 * still finds the sub-agent spawner, and the plan tools the run state, that
 * the plugin itself cannot see. It runs directly: the permission engine, the
 * justification gate and the egress check that guard a model's call do not
 * run for it, so name only tools the plugin may drive unchecked.
 *
 * This bounds what the bridge hands a plugin; it is not a sandbox. Plugin
 * code runs in this process and can import anything itself.
 */
export function pluginBridgeView(
  bridge: unknown,
  allowedTools: ReadonlySet<string>,
  hostCtx?: ToolExecuteContext,
): unknown {
  if (bridge === null || typeof bridge !== "object") return undefined;
  const { runContext, tools } = bridge as { runContext?: unknown; tools?: unknown };
  const visible = declaredHostTools(tools, allowedTools).map((t) =>
    Object.freeze({ ...t, execute: (input: unknown) => t.execute(input, hostCtx) }),
  );
  return Object.freeze({
    ...(runContext !== undefined ? { runContext } : {}),
    tools: Object.freeze(visible),
  });
}

/**
 * The catalog a plugin tool's `concurrencyClassifier` is shown: the host
 * tools its manifest names, as frozen copies whose `execute` runs nothing. A
 * classifier reads flags; it runs before the permission engine has decided
 * the call — even for a call it will deny — so it must not be a way to run a
 * tool.
 */
function pluginClassifierCatalog(
  catalog: ReadonlyArray<RegisteredTool>,
  allowedTools: ReadonlySet<string>,
): ReadonlyArray<RegisteredTool> {
  return Object.freeze(
    declaredHostTools(catalog, allowedTools).map((t) =>
      Object.freeze({
        ...t,
        execute: async () =>
          `[refused] ${t.name} cannot be run from a concurrency classifier; it only decides whether a call may run alongside others.`,
      }),
    ),
  );
}

/**
 * `tool`, whose `execute` sees {@link pluginBridgeView} in place of the
 * runtime's bridge, and whose `concurrencyClassifier`, if it has one, sees
 * {@link pluginClassifierCatalog} in place of the runtime's catalog.
 *
 * Both stay methods and pass their receiver on: the runtime calls
 * `tool.execute(input, ctx)` on the registered tool, and on 0.7.0 a plugin
 * tool written as an object literal could read its own `this.name` or
 * `this.inputSchema` there. An arrow wrapper would call it with no `this`.
 */
function withPluginBridge(tool: RegisteredTool, allowedTools: ReadonlySet<string>): RegisteredTool {
  const run = tool.execute;
  const classify = tool.concurrencyClassifier;
  return {
    ...tool,
    execute(this: RegisteredTool, input, ctx) {
      return run.call(
        this,
        input,
        ctx?.bridge === undefined
          ? ctx
          : { ...ctx, bridge: pluginBridgeView(ctx.bridge, allowedTools, ctx) },
      );
    },
    ...(classify !== undefined
      ? {
          concurrencyClassifier(
            this: RegisteredTool,
            input: unknown,
            catalog: ReadonlyArray<RegisteredTool>,
          ) {
            return classify.call(this, input, pluginClassifierCatalog(catalog, allowedTools));
          },
        }
      : {}),
  };
}

/** The plugin contribution kinds no host binds. */
export type UnboundContributionKind = "channels" | "models" | "graders" | "targetEmitters";

/**
 * The extension points plugin-sdk declares that nothing in crewhaus binds, with
 * why — the runtime counterpart of the Hangar's `DEFERRED_EXTENSION_POINTS`.
 * A plugin that contributes one loads (its tools and skills still work), and
 * the boot says the rest has no effect.
 */
export const UNBOUND_CONTRIBUTION_KINDS: Readonly<Record<UnboundContributionKind, string>> = {
  channels:
    "a channel daemon's adapters are built into it from the spec, and it does not read a plugin's",
  models:
    "models are resolved from the spec by the model router, which does not read a plugin's adapters",
  graders:
    "graders are loaded from .crewhaus/graders/<name>/index.ts (a default export of { name, grader }), not from a plugin",
  targetEmitters:
    "target shapes are part of the crewhaus compiler, which does not read a plugin's emitters",
};

const UNBOUND_SINGULAR: Readonly<Record<UnboundContributionKind, string>> = {
  channels: "channel",
  models: "model",
  graders: "grader",
  targetEmitters: "target emitter",
};

/** The boot note for a plugin's contributions of one unbound kind. */
function unboundContributionNote(
  pluginName: string,
  kind: UnboundContributionKind,
  items: ReadonlyArray<unknown>,
): string {
  const ids = items
    .map((item) => {
      const key = kind === "targetEmitters" ? "targetShape" : "id";
      const id = isPlainObject(item) ? item[key] : undefined;
      return typeof id === "string" ? JSON.stringify(id) : undefined;
    })
    .filter((id): id is string => id !== undefined);
  const named =
    ids.length > 0 ? ` (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""})` : "";
  const noun = UNBOUND_SINGULAR[kind];
  const count = items.length === 1 ? `1 ${noun}` : `${items.length} ${noun}s`;
  return `plugin "${pluginName}" contributes ${count}${named}, which ${items.length === 1 ? "has" : "have"} no effect: ${UNBOUND_CONTRIBUTION_KINDS[kind]}. Only a plugin's tools and its skills/ directory are used.`;
}

/**
 * Item 3 (G32) — the aggregate of every activated plugin's contributions,
 * bucketed by kind. Tools are already normalized through `buildTool` (so the
 * security-relevant `scope` / `ioCapability` inference runs on
 * plugin-supplied tools exactly as on first-party ones — a plugin tool that
 * forgets `scope: "external"` still lowers external under an outward name)
 * and are what hosts register. `channels` / `models` / `graders` /
 * `targetEmitters` are COLLECTED, NOT BOUND: no host reads them in this
 * release ({@link UNBOUND_CONTRIBUTION_KINDS}), and `warnings` says so for
 * each plugin that contributes one. `skillDirs` are the existing
 * `<plugin>/skills` directories to feed `skills-registry`'s
 * `discoverSkills({ pluginDirs })`.
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
  /**
   * Where each warning is also reported as it is recorded, prefixed
   * `[plugins] `. {@link createBootPluginRuntime} supplies stderr, so every
   * boot path that spreads it reports them. Without it they are only returned.
   */
  readonly warn?: (line: string) => void;
  /** Test seam: override the skill-directory existence probe. */
  readonly existsImpl?: (path: string) => boolean;
};

/**
 * Why a plugin tool may not have the name `name`, or undefined when it may.
 * A plugin adds tools; it cannot take the name of one crewhaus defines:
 *
 * - a builtin: permission rules, the builtin rules crewhaus seeds itself (a
 *   `Read`/`Glob`/`Grep` alwaysAllow), the matcher's per-tool argument fields
 *   and `ToolRegistry` all key on the name, so a plugin `Grep` would run under
 *   the builtin's grants and be reported as the builtin — whether or not the
 *   spec lists the builtin;
 * - a tool the runtime registers itself (`ListTools`, `Skill`, `Task`, the
 *   Focus/Plan/Goal and memory tools, `Consult`, `Escalate`, …): a plugin one
 *   would displace it, and inherit its builtin alwaysAllow where it has one;
 * - any of those names in another letter case (`grep`, `READ`,
 *   `listtools`): a model profile's `tools` list matches names without
 *   regard to case, so a profile that lists `Grep` would offer a plugin
 *   `grep` to the model it is meant to restrict;
 * - an `mcp__` name (in any case), which everything reads as an MCP server's
 *   tool;
 * - a `<server>__<tool>` name, how an MCP server's tool was named before
 *   0.7.1: permission rules, skill and sub-agent tool lists and rate limits
 *   written that way still match `mcp__<server>__<tool>`, so a rule meant
 *   for the MCP tool (`alwaysAllow: broker__paper_buy`) would grant a plugin
 *   tool of that name too.
 *
 * Names come from `@crewhaus/tool-registry-manifest/flags`, the generated
 * list every builtin and runtime tool is checked against, so a tool added
 * later is reserved without an edit here.
 */
export function reservedPluginToolNameReason(name: string): string | undefined {
  if (TOOL_FLAGS_BY_NAME.has(name)) return "a builtin crewhaus tool has that name";
  if (RUNTIME_TOOL_NAMES.includes(name)) {
    return "the crewhaus runtime registers a tool of that name itself";
  }
  const folded = reservedNamesByCase().get(name.toLowerCase());
  if (folded !== undefined) {
    return `crewhaus has a tool named "${folded}", and a model profile's tools list matches names in any letter case, so a profile that lists ${folded} would offer this tool too`;
  }
  if (name.toLowerCase().startsWith("mcp__")) {
    return "names starting mcp__ belong to MCP servers' tools";
  }
  if (legacyMcpToolName(`mcp__${name}`) !== undefined) {
    return `a name of the form <server>__<tool> is how rules written before crewhaus 0.7.1 name an MCP server's tool, so a rule meant for mcp__${name} would govern this tool too`;
  }
  return undefined;
}

let reservedByCase: ReadonlyMap<string, string> | undefined;

/**
 * Every builtin and runtime tool name, lower-cased, to the name itself. A
 * model profile's `tools` list (model-plan) matches a plain name without
 * regard to case, so `grep` would be offered wherever `Grep` is.
 */
function reservedNamesByCase(): ReadonlyMap<string, string> {
  if (reservedByCase === undefined) {
    const map = new Map<string, string>();
    for (const n of [...TOOL_FLAGS_BY_NAME.keys(), ...RUNTIME_TOOL_NAMES]) {
      if (!map.has(n.toLowerCase())) map.set(n.toLowerCase(), n);
    }
    reservedByCase = map;
  }
  return reservedByCase;
}

/** A name a reserved plugin tool could take instead: prefixed with its plugin's, with no `__`. */
function suggestedPluginToolName(pluginName: string, toolName: string): string {
  return `${pluginName}_${toolName}`.replace(/_{2,}/g, "_");
}

/** A zod 4 schema carries `_zod`; a zod 3 one carries `_def.typeName`. */
function isZod4Schema(schema: unknown): boolean {
  return schema !== null && typeof schema === "object" && "_zod" in schema;
}

function isZod3Schema(schema: unknown): boolean {
  const def = (schema as { _def?: { typeName?: unknown } } | null)?._def;
  return typeof def?.typeName === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A value as a message shows it: short, and never a whole object. */
function shown(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") {
    return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  }
  if (Array.isArray(value)) return "a list";
  if (typeof value === "function") return "a function";
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

/** The flags every consumer reads as booleans (`=== true`, or truthiness). */
const TOOL_FLAG_FIELDS = [
  "concurrencySafe",
  "readOnly",
  "destructive",
  "requiresSandbox",
  "classifyOutput",
  "requireJustification",
] as const;

/**
 * The optional fields of a tool definition in which `null` means "not set".
 * buildTool reads each with `??` or `!== undefined`, so on 0.7.0 a null flag
 * or scope took the same default as a missing one (and a null schema fell
 * back to the zod one); a plugin written that way keeps loading.
 */
const NULL_MEANS_UNSET = [
  "description",
  ...TOOL_FLAG_FIELDS,
  "scope",
  "ioCapability",
  "jsonSchema",
  "concurrencyClassifier",
  "requiresModelFeatures",
  "operativeArgs",
] as const;

/** Every field a tool definition can have, read through its prototype too. */
const TOOL_DEFINITION_FIELDS = ["name", "inputSchema", "execute", ...NULL_MEANS_UNSET] as const;

/**
 * `tool` with each field of {@link NULL_MEANS_UNSET} that is `null` left out,
 * or `tool` itself when none is. The copy keeps every other field, including
 * one the definition inherits.
 */
function withNullsUnset(tool: Record<string, unknown>): Record<string, unknown> {
  if (!NULL_MEANS_UNSET.some((field) => tool[field] === null)) return tool;
  const copy: Record<string, unknown> = {};
  for (const field of new Set<string>([...TOOL_DEFINITION_FIELDS, ...Object.keys(tool)])) {
    const value = tool[field];
    if (value === undefined) continue;
    if (value === null && (NULL_MEANS_UNSET as ReadonlyArray<string>).includes(field)) continue;
    copy[field] = value;
  }
  return copy;
}

/** Why a contributed tool has no usable name, or undefined when it has one. */
function pluginToolNameProblem(tool: unknown): string | undefined {
  if (!isPlainObject(tool)) return `is ${shown(tool)}, not a tool definition`;
  const name = tool["name"];
  if (typeof name !== "string") return `has no name (name is ${shown(name)})`;
  if (!PLUGIN_TOOL_NAME_PATTERN.test(name)) {
    return `name ${JSON.stringify(name)} must be 1-64 letters, digits, "_" or "-", the names model providers accept`;
  }
  return undefined;
}

/**
 * Why a plugin's tool definition cannot be trusted as written, or undefined
 * when it can. A plugin is JavaScript, so nothing typed its tools: every flag
 * is read by something that compares it (`=== true`, `=== "external"`) or
 * tests its truth, and a string there fails open — `readOnly: "false"` is
 * truthy, so plan mode would run the tool; `requiresSandbox: "true"` is not
 * `true`, so the sandbox floor would skip it. A schema crewhaus cannot read
 * would crash every run that lists the tool, whether or not the model calls
 * it. So each field must be what the tool contract says, or absent — and
 * `null`, which buildTool always read as absent, is absent here too (see
 * {@link withNullsUnset}, applied first).
 */
function pluginToolDefinitionProblem(tool: unknown): string | undefined {
  const unnamed = pluginToolNameProblem(tool);
  if (unnamed !== undefined) return unnamed;
  const t = tool as Record<string, unknown>;
  if (t["description"] !== undefined && typeof t["description"] !== "string") {
    return `description is ${shown(t["description"])}, not a string`;
  }
  if (typeof t["execute"] !== "function")
    return `execute is ${shown(t["execute"])}, not a function`;
  for (const field of TOOL_FLAG_FIELDS) {
    const value = t[field];
    if (value !== undefined && typeof value !== "boolean") {
      return `${field} is ${shown(value)}, not true or false`;
    }
  }
  const scope = t["scope"];
  if (scope !== undefined && scope !== "internal" && scope !== "external") {
    return `scope is ${shown(scope)}, not "internal" or "external"`;
  }
  const io = t["ioCapability"];
  if (io !== undefined && io !== "network" && io !== "process") {
    return `ioCapability is ${shown(io)}, not "network" or "process"`;
  }
  const schema = t["inputSchema"];
  if (
    schema === null ||
    typeof schema !== "object" ||
    typeof (schema as { safeParse?: unknown }).safeParse !== "function"
  ) {
    return `inputSchema is ${shown(schema)}; it must be a schema with safeParse (zod), which checks every call`;
  }
  const json = t["jsonSchema"];
  if (json !== undefined) {
    if (!isPlainObject(json)) return `jsonSchema is ${shown(json)}, not a JSON Schema object`;
    if (json["type"] !== undefined && json["type"] !== "object") {
      return `jsonSchema describes ${JSON.stringify(json["type"])} input; a tool's input is an object`;
    }
  } else if (!isZod3Schema(schema) && !isZod4Schema(schema)) {
    return "inputSchema is not a zod schema crewhaus can describe to the model, and the tool gives no jsonSchema: use zod, or add a jsonSchema";
  }
  if (
    t["concurrencyClassifier"] !== undefined &&
    typeof t["concurrencyClassifier"] !== "function"
  ) {
    return `concurrencyClassifier is ${shown(t["concurrencyClassifier"])}, not a function`;
  }
  if (t["requiresModelFeatures"] !== undefined && !isPlainObject(t["requiresModelFeatures"])) {
    return `requiresModelFeatures is ${shown(t["requiresModelFeatures"])}, not an object`;
  }
  if (t["operativeArgs"] !== undefined && !Array.isArray(t["operativeArgs"])) {
    return `operativeArgs is ${shown(t["operativeArgs"])}, not a list`;
  }
  return undefined;
}

/**
 * A plugin tool's definition with a JSON Schema the model can read. crewhaus
 * describes a tool's input to the model with a zod 3 converter, which reads a
 * zod 4 schema — what `npm i zod` installs today — as having no parameters at
 * all. So a tool with a zod 4 `inputSchema` and no `jsonSchema` of its own
 * gets one from zod's own zod 4 converter (validation still runs through the
 * schema's own `safeParse`). If zod cannot describe it, the tool keeps the
 * empty schema it had before, and a warning says so.
 */
async function describePluginToolInput(
  pluginName: string,
  def: ToolDefinition<unknown>,
): Promise<{ readonly def: ToolDefinition<unknown>; readonly warning?: string }> {
  if (def.jsonSchema !== undefined || !isZod4Schema(def.inputSchema)) return { def };
  let why: string;
  try {
    const { toJSONSchema } = await import("zod/v4");
    const json = toJSONSchema(def.inputSchema as unknown as Zod4Type, {
      target: "draft-7",
      io: "input",
    }) as Record<string, unknown>;
    if (json["type"] === "object") return { def: { ...def, jsonSchema: json } };
    why = `it describes ${JSON.stringify(json["type"] ?? "no")} input, and a tool's input is an object`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  return {
    def,
    warning: `plugin "${pluginName}" tool "${def.name}" has a zod 4 input schema crewhaus cannot describe (${why}), so the model is shown it with no parameters. Give the tool a jsonSchema, or build its schema with zod 3.`,
  };
}

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
 * The imported code must be the plugin its manifest describes. A module whose
 * default export says it is another plugin (`definePlugin({ name })`) is the
 * wrong code at this path, and is refused. A differing version or
 * permissions block is only noted — the manifest is what crewhaus goes by —
 * and the note is returned.
 */
function moduleIdentity(plugin: LoadedPlugin): string | undefined {
  const declared = plugin.module.default;
  if (!isPlainObject(declared)) return undefined;
  const { name, version } = plugin.manifest;
  if (typeof declared["name"] === "string" && declared["name"] !== name) {
    throw new PluginLoaderError(
      `plugin "${name}": its code says it is plugin ${JSON.stringify(declared["name"])}, so the index.js beside "${name}"'s manifest is another plugin's code — refusing to load it`,
    );
  }
  const differs: string[] = [];
  if (typeof declared["version"] === "string" && declared["version"] !== version) {
    differs.push(`version ${declared["version"]} (the manifest says ${version})`);
  }
  if (declared["permissions"] !== undefined) {
    let same = false;
    try {
      same =
        canonicalJson(declared["permissions"]) === canonicalJson(plugin.manifest.permissions ?? {});
    } catch {
      same = false;
    }
    if (!same) differs.push("permissions that differ from the manifest's");
  }
  if (differs.length === 0) return undefined;
  return `plugin "${name}": its code declares ${differs.join(" and ")}. The manifest is what crewhaus goes by; rebuild the plugin so they agree.`;
}

/**
 * Why a plugin's contributed tools are not the ones its manifest's
 * `provides.tools` lists, or undefined when they are (or it lists none).
 */
function providesMismatch(
  manifest: PluginManifest,
  contributed: ReadonlyArray<unknown>,
): string | undefined {
  const listed = manifest.provides?.tools;
  if (listed === undefined) return undefined;
  const names = contributed
    .map((t) => (isPlainObject(t) ? t["name"] : undefined))
    .filter((n): n is string => typeof n === "string");
  const quoted = (xs: ReadonlyArray<string>) => xs.map((x) => JSON.stringify(x)).join(", ");
  const extra = names.filter((n) => !listed.includes(n));
  if (extra.length > 0) {
    return `its code contributes ${quoted(extra)}, which its manifest's provides.tools does not list`;
  }
  const missing = listed.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    return `its manifest's provides.tools lists ${quoted(missing)}, which its code does not contribute`;
  }
  return undefined;
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
  /** Tool name → the plugin that contributed it, so a second one is left out by name. */
  const toolOwners = new Map<string, string>();
  const note = (msg: string): void => {
    warnings.push(msg);
    opts.warn?.(`[plugins] ${msg}`);
  };
  const seen = new Set<string>();
  for (const name of opts.names) {
    if (seen.has(name)) continue; // de-dupe repeats; keep first-occurrence order
    seen.add(name);
    const entry = await opts.registry.get(name);
    if (entry === undefined) {
      const msg = `plugin "${name}" is named in plugins: but is not installed in the plugin registry`;
      if (onMissing === "throw") throw new PluginLoaderError(`activatePlugins: ${msg}`);
      note(msg);
      continue;
    }
    // The entry's manifest must be the plugin it is listed as, at the version
    // it is pinned to: a registry entry pointing at another plugin's files,
    // or at an older release of this one, is refused before it is imported.
    // Checked again on what a host's own loader returns.
    const expected: ExpectedPlugin = {
      name,
      ...(entry.pinnedVersion !== undefined ? { version: entry.pinnedVersion } : {}),
    };
    const plugin = await opts.loader.load(entry.sourcePath, expected);
    const notExpected = pluginIdentityProblem(expected, plugin.manifest, entry.sourcePath);
    if (notExpected !== undefined) throw new PluginLoaderError(notExpected);
    if (canonicalJson(entry.manifest) !== canonicalJson(plugin.manifest)) {
      // Changed in place since it was installed: the plugin on disk is what
      // loads, but `crewhaus plugins outdated` reads the stale record.
      const differs =
        entry.manifest.version === plugin.manifest.version
          ? `${entry.sourcePath} differs from its install record (both say ${plugin.manifest.version})`
          : `the install record says ${entry.manifest.version}, but ${entry.sourcePath} is ${plugin.manifest.version}`;
      note(
        `plugin "${name}": ${differs}. The plugin on disk is what loads; install it again to bring the record up to date.`,
      );
    }
    loaded.push(plugin);
    const moduleNote = moduleIdentity(plugin);
    if (moduleNote !== undefined) note(moduleNote);
    const unenforced = (["fs", "net", "secrets"] as const).filter(
      (k) => plugin.permissions[k] !== undefined,
    );
    if (unenforced.length > 0) {
      note(
        `plugin "${name}" declares ${unenforced.map((k) => `permissions.${k}`).join(", ")}; crewhaus does not enforce ${unenforced.length === 1 ? "it" : "these"} on plugin code, which runs inside this process with its full authority (environment, files, network). Only permissions.tools is applied.`,
      );
    }
    const contributions = readContributions(plugin.module.default);
    const contributed = contributions.tools ?? [];
    if (!Array.isArray(contributed)) {
      throw new PluginLoaderError(
        `plugin "${name}": contributions.tools is ${shown(contributed)}, not a list of tools — refusing to load the plugin`,
      );
    }
    const providesProblem = providesMismatch(plugin.manifest, contributed);
    if (providesProblem !== undefined) {
      throw new PluginLoaderError(
        `plugin "${name}": ${providesProblem} — refusing to load the plugin`,
      );
    }
    // The host tools this plugin's tools may reach through ctx.bridge.
    const bridgeTools: ReadonlySet<string> = new Set(plugin.permissions.tools ?? []);
    // Each tool is checked: a malformed one refuses the whole plugin at boot,
    // naming the tool and the field, instead of failing open on a flag or
    // crashing the first turn. Then it is normalized through buildTool, the
    // same fail-closed scope/justification inference as first-party tools. A
    // plugin is signed, in-process code, so its descriptions are not
    // boundary-classified the way a remote MCP server's are.
    for (const [index, tool] of contributed.entries()) {
      const label =
        isPlainObject(tool) && typeof tool["name"] === "string"
          ? `tool ${JSON.stringify(tool["name"])}`
          : `tools[${index}]`;
      const refuse = (why: string, cause?: unknown): PluginLoaderError =>
        new PluginLoaderError(
          `plugin "${name}" ${label}: ${why} — refusing to load the plugin`,
          cause,
        );
      const unnamed = pluginToolNameProblem(tool);
      if (unnamed !== undefined) throw refuse(unnamed);
      const normalized = withNullsUnset(tool as Record<string, unknown>);
      const def = normalized as unknown as ToolDefinition<unknown>;
      const reserved = reservedPluginToolNameReason(def.name);
      if (reserved !== undefined) {
        note(
          `plugin "${name}" tool "${def.name}" was left out: ${reserved}. Rename it in the plugin (for example "${suggestedPluginToolName(name, def.name)}").`,
        );
        continue;
      }
      const malformed = pluginToolDefinitionProblem(normalized);
      if (malformed !== undefined) throw refuse(malformed);
      const owner = toolOwners.get(def.name);
      if (owner !== undefined) {
        note(
          owner === name
            ? `plugin "${name}" contributes two tools named "${def.name}"; the second was left out.`
            : `plugin "${name}" tool "${def.name}" was left out: plugin "${owner}" already contributes a tool of that name.`,
        );
        continue;
      }
      const described = await describePluginToolInput(name, def);
      if (described.warning !== undefined) note(described.warning);
      let built: RegisteredTool;
      try {
        built = buildTool(described.def);
      } catch (err) {
        throw refuse(err instanceof Error ? err.message : String(err), err);
      }
      // A tool that says it crosses a network or process boundary runs as
      // external, so its payloads pass the egress check — the rule compile
      // --strict holds first-party tools to, through the same audit.
      if (auditToolScopes([built]).length > 0) {
        note(
          `plugin "${name}" tool "${def.name}" declares ioCapability "${built.ioCapability}" but not scope "external"; it runs as external, so what it sends is checked on the way out. Set scope: "external" in the plugin.`,
        );
        built = { ...built, scope: "external" };
      }
      toolOwners.set(def.name, name);
      tools.push(withPluginBridge(built, bridgeTools));
    }
    // Channels, models, graders and target emitters are collected (the
    // buckets stay on ActivatedPlugins) but nothing binds them, and the boot
    // says so rather than letting a plugin that contributes one look wired.
    const buckets = { channels, models, graders, targetEmitters } as const;
    for (const kind of Object.keys(UNBOUND_CONTRIBUTION_KINDS) as UnboundContributionKind[]) {
      const items: unknown = contributions[kind];
      if (items === undefined) continue;
      if (!Array.isArray(items)) {
        note(
          `plugin "${name}": contributions.${kind} is ${shown(items)}, not a list, and was ignored.`,
        );
        continue;
      }
      if (items.length === 0) continue;
      (buckets[kind] as unknown[]).push(...items);
      note(unboundContributionNote(name, kind, items));
    }
    // Skill-bundle convention: `<plugin-dir>/skills/` — a directory of
    // `<name>/SKILL.md` subdirs, exactly skills-registry's pluginDirs contract.
    // The entrypoint sits at `<plugin-dir>/index.js`, so its parent is the dir.
    // Like index.js, it must really be inside the plugin's directory; each
    // skill in it, and its SKILL.md, is held to the same rule where it is
    // read (skills-registry's discoverSkills, for every pluginDirs entry).
    const pluginDir = dirname(plugin.entrypointPath);
    const skillDir = join(pluginDir, "skills");
    if (exists(skillDir)) {
      const contained = resolveContained(pluginDir, "skills");
      if (contained.ok) skillDirs.push(skillDir);
      else {
        note(
          `plugin "${name}": its skills directory ${contained.code === "escapes-root" ? "is a link that leads outside the plugin's directory" : `cannot be used (${contained.reason})`}, so its skills were not loaded.`,
        );
      }
    }
  }
  return { loaded, tools, channels, models, graders, targetEmitters, skillDirs, warnings };
}

/**
 * Boot activation for the channel daemon, which accepted `plugins:` and
 * ignored it before 0.7.1: a daemon that ran then must keep starting. Each
 * named plugin that is installed and verifies is activated, exactly as
 * {@link activatePlugins} does it. Anything else — no trust anchor, a plugin
 * that is not installed, a signature that does not verify — is reported
 * through `warn`, once per start, and that plugin is skipped. Nothing that
 * fails verification is ever imported; the daemon only goes without it.
 */
export async function activatePluginsOrStartWithout(opts: {
  readonly names: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly warn?: (line: string) => void;
}): Promise<ActivatedPlugins> {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const names = [...new Set(opts.names)];
  const merged: {
    loaded: LoadedPlugin[];
    tools: RegisteredTool[];
    channels: PluginChannelAdapter[];
    models: PluginModelAdapter[];
    graders: PluginGrader[];
    targetEmitters: PluginTargetEmitter[];
    skillDirs: string[];
    warnings: string[];
  } = {
    loaded: [],
    tools: [],
    channels: [],
    models: [],
    graders: [],
    targetEmitters: [],
    skillDirs: [],
    warnings: [],
  };
  const skip = (what: string, err: unknown, without: "it" | "them"): void => {
    const raw = (err instanceof Error ? err.message : String(err)).replace(
      /^activatePlugins: /,
      "",
    );
    const why = /[.!?]$/.test(raw) ? raw : `${raw}.`;
    const line = `[plugins] ${what} not loaded: ${why} The daemon starts without ${without}.`;
    merged.warnings.push(line);
    warn(line);
  };
  let runtime: { readonly registry: PluginRegistry; readonly loader: PluginLoader };
  try {
    runtime = createBootPluginRuntime({
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      warn,
    });
  } catch (err) {
    skip(names.map((n) => `"${n}"`).join(", "), err, names.length === 1 ? "it" : "them");
    return merged;
  }
  for (const name of names) {
    try {
      const one = await activatePlugins({ names: [name], ...runtime, onMissing: "throw", warn });
      merged.warnings.push(...one.warnings);
      merged.loaded.push(...one.loaded);
      merged.tools.push(...one.tools);
      merged.channels.push(...one.channels);
      merged.models.push(...one.models);
      merged.graders.push(...one.graders);
      merged.targetEmitters.push(...one.targetEmitters);
      merged.skillDirs.push(...one.skillDirs);
    } catch (err) {
      skip(`"${name}"`, err, "it");
    }
  }
  return merged;
}
