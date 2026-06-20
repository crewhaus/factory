import { createHash } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";
import type { RegisteredTool, ToolDefinition } from "@crewhaus/tool-catalog";

/**
 * Section 41 — `@crewhaus/plugin-sdk` v2.
 *
 * Public typed surface for third-party plugins. A plugin is a single
 * TS/JS module exporting `definePlugin({ … })`. The §41 `plugin-loader`
 * loads + activates plugins at runtime; the §42 `plugin-registry`
 * discovers them; the §40 sigstore-style signature verification runs
 * before either.
 *
 * v2 widens the v1 surface (Studio-only — see `crewhaus/utilities/studio-plugin-sdk`)
 * to cover the five extension points the catalog cares about:
 *
 *   1. **Tools** — anything you would otherwise pass to `buildTool()`.
 *   2. **Channels** — `ChannelAdapter`-shaped inbound surface (Slack,
 *      Telegram, … plus future plugins like Mastodon, IRC, etc.).
 *   3. **Models** — provider adapters that match the canonical
 *      `ProviderAdapter` contract from `adapter-anthropic`.
 *   4. **Graders** — evaluators that match the `RegisteredGrader`
 *      contract from `grader-registry`.
 *   5. **Target emitters** — compile-time target backends that match
 *      the `Emitter` contract from `compiler-core`.
 *
 * The contributions are *declarations*; `plugin-loader` is responsible
 * for wiring each declaration into the host's registry at runtime
 * (and for enforcing the `permissions` allow-list).
 *
 * The SDK is intentionally **dependency-light**: it only imports
 * `@crewhaus/errors` + `@crewhaus/tool-catalog` (to expose the
 * `ToolDefinition` type plugins already know). Other contract types
 * are re-exported as structural shapes so a plugin author doesn't
 * have to pull in five workspace packages just to declare a manifest.
 */

export class PluginSdkError extends CrewhausError {
  override readonly name = "PluginSdkError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// ---------------------------------------------------------------------------
// Re-exported contract types
// ---------------------------------------------------------------------------

export type { RegisteredTool, ToolDefinition } from "@crewhaus/tool-catalog";

/**
 * Structural shape of a channel adapter contribution. Matches the
 * `ChannelAdapter` interface duplicated across `channel-adapter-slack`
 * / `-telegram` / `-discord` / `-whatsapp` / `-imessage`. Plugins
 * implement this shape directly; `plugin-loader` adapts it into the
 * channel registry slot for the target shape.
 */
export interface PluginChannelAdapter {
  readonly id: string;
  verify(req: { headers: Headers; body: string }): Promise<boolean>;
  parseInbound(req: { headers: Headers; body: string }): Promise<unknown>;
  sendReply(args: {
    channelId: string;
    threadKey?: string;
    text: string;
    [k: string]: unknown;
  }): Promise<void>;
  setTyping?(args: { channelId: string; on: boolean }): Promise<void>;
}

/**
 * Structural shape of a provider adapter. Mirrors the `ProviderAdapter`
 * exported from `adapter-anthropic` without forcing the SDK to import
 * that package's transitive deps. The full provider request / stream
 * event types live in `adapter-anthropic`; plugins implementing this
 * type should import those for accurate parameter shapes.
 */
export interface PluginModelAdapter {
  readonly id: string;
  readonly features: {
    readonly caching?: boolean;
    readonly tool_use?: boolean;
    readonly vision?: boolean;
    readonly thinking?: boolean;
    readonly web_search?: boolean;
  };
  stream(request: unknown): AsyncIterable<unknown>;
  countTokens?(messages: unknown): Promise<number>;
}

/**
 * Structural shape of a grader contribution. Matches `RegisteredGrader`
 * from `grader-registry`.
 */
export interface PluginGrader {
  readonly id: string;
  readonly description?: string;
  grade(sample: { input: unknown; output: unknown; expected?: unknown }): Promise<{
    pass: boolean;
    score?: number;
    notes?: string;
  }>;
}

/**
 * Structural shape of a target emitter contribution. Matches the
 * `Emitter` contract from `compiler-core` — a function that takes the
 * IR variant and returns a `Bundle` (file list).
 */
export interface PluginTargetEmitter {
  readonly targetShape: string;
  emit(ir: unknown): {
    readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
  };
}

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/**
 * Capability declarations. Fail-closed — an undefined section means the
 * plugin has zero access to that resource class.
 */
export type PluginPermissions = {
  /** Filesystem allow-list (minimatch globs relative to the plugin's sandbox root). */
  readonly fs?: ReadonlyArray<string>;
  /** URL prefix allow-list for `fetch()` from inside the plugin. */
  readonly net?: ReadonlyArray<string>;
  /** Names of host-provided tools the plugin's tools may call. */
  readonly tools?: ReadonlyArray<string>;
  /** Env-var names the plugin is permitted to read via the host's `secrets-manager`. */
  readonly secrets?: ReadonlyArray<string>;
};

export type PluginSignatureAlgorithm = "ed25519";

/**
 * Detached signature over the canonical-JSON serialisation of the
 * manifest with `signature` set to `undefined`. Verified by §42
 * `plugin-registry` before any source is read.
 */
export type PluginSignature = {
  readonly algorithm: PluginSignatureAlgorithm;
  readonly publicKeyB64: string;
  readonly sigB64: string;
  /** Optional ISO-8601 timestamp; advisory only. */
  readonly issuedAt?: string;
};

export type PluginContributions = {
  readonly tools?: ReadonlyArray<RegisteredTool | ToolDefinition>;
  readonly channels?: ReadonlyArray<PluginChannelAdapter>;
  readonly models?: ReadonlyArray<PluginModelAdapter>;
  readonly graders?: ReadonlyArray<PluginGrader>;
  readonly targetEmitters?: ReadonlyArray<PluginTargetEmitter>;
};

export type PluginManifest = {
  /** Globally-unique kebab-case plugin id. */
  readonly name: string;
  /** Semver-shaped version string (validated by `validatePluginManifest`). */
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  /** Minimum crewhaus runtime version this plugin requires (semver range). */
  readonly engines?: { readonly crewhaus?: string };
  readonly permissions?: PluginPermissions;
  readonly contributions?: PluginContributions;
  /**
   * Lowercase hex SHA-256 of the plugin's entrypoint (`index.js`). It is part
   * of the manifest, so `manifestPayloadForSigning` includes it and the
   * signature therefore commits to the CODE, not just the metadata. The loader
   * refuses to `import()` an entrypoint whose hash does not match. Optional for
   * back-compat; signed plugins SHOULD set it (compute via `entrypointDigest`).
   */
  readonly entrypointDigest?: string;
  readonly signature?: PluginSignature;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.+-]+)?(?:\+[\w.-]+)?$/;

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginSdkError(`plugin manifest: \`${field}\` must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, field: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new PluginSdkError(
      `plugin manifest: \`${field}\` must be a non-empty string when present`,
    );
  }
}

function assertOptionalStringArray(
  value: unknown,
  field: string,
): asserts value is ReadonlyArray<string> | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new PluginSdkError(`plugin manifest: \`${field}\` must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new PluginSdkError(`plugin manifest: \`${field}\` entries must be non-empty strings`);
    }
  }
}

/**
 * Throw `PluginSdkError` if `m` is not a valid `PluginManifest`. Returns
 * the input typed as `PluginManifest` on success (used as a type guard).
 */
export function validatePluginManifest(m: unknown): PluginManifest {
  if (m === null || typeof m !== "object") {
    throw new PluginSdkError("plugin manifest must be an object");
  }
  const manifest = m as Record<string, unknown>;
  assertString(manifest["name"], "name");
  if (!NAME_PATTERN.test(manifest["name"])) {
    throw new PluginSdkError(
      `plugin manifest: \`name\` must be 3-64 chars, lowercase a-z / 0-9 / "-", start with a letter, no trailing hyphen (got "${manifest["name"]}")`,
    );
  }
  assertString(manifest["version"], "version");
  if (!SEMVER_PATTERN.test(manifest["version"])) {
    throw new PluginSdkError(
      `plugin manifest: \`version\` must be semver-shaped (got "${manifest["version"]}")`,
    );
  }
  assertOptionalString(manifest["description"], "description");
  assertOptionalString(manifest["author"], "author");
  assertOptionalString(manifest["homepage"], "homepage");
  assertOptionalString(manifest["license"], "license");

  if (manifest["entrypointDigest"] !== undefined) {
    assertString(manifest["entrypointDigest"], "entrypointDigest");
    if (!/^[a-f0-9]{64}$/.test(manifest["entrypointDigest"] as string)) {
      throw new PluginSdkError(
        "plugin manifest: `entrypointDigest` must be a lowercase hex SHA-256 (64 chars)",
      );
    }
  }

  if (manifest["engines"] !== undefined) {
    const engines = manifest["engines"];
    if (engines === null || typeof engines !== "object") {
      throw new PluginSdkError("plugin manifest: `engines` must be an object");
    }
    assertOptionalString((engines as Record<string, unknown>)["crewhaus"], "engines.crewhaus");
  }

  if (manifest["permissions"] !== undefined) {
    const perms = manifest["permissions"];
    if (perms === null || typeof perms !== "object") {
      throw new PluginSdkError("plugin manifest: `permissions` must be an object");
    }
    const p = perms as Record<string, unknown>;
    assertOptionalStringArray(p["fs"], "permissions.fs");
    assertOptionalStringArray(p["net"], "permissions.net");
    assertOptionalStringArray(p["tools"], "permissions.tools");
    assertOptionalStringArray(p["secrets"], "permissions.secrets");
  }

  if (manifest["signature"] !== undefined) {
    const sig = manifest["signature"];
    if (sig === null || typeof sig !== "object") {
      throw new PluginSdkError("plugin manifest: `signature` must be an object");
    }
    const s = sig as Record<string, unknown>;
    if (s["algorithm"] !== "ed25519") {
      throw new PluginSdkError('plugin manifest: `signature.algorithm` must be "ed25519"');
    }
    assertString(s["publicKeyB64"], "signature.publicKeyB64");
    assertString(s["sigB64"], "signature.sigB64");
    assertOptionalString(s["issuedAt"], "signature.issuedAt");
  }

  return manifest as unknown as PluginManifest;
}

/**
 * Type-only helper plugins use:
 *   export default definePlugin({ name, version, contributions, … });
 *
 * Runs `validatePluginManifest` so misconfiguration fails at load time
 * (before the plugin's tools are exposed to a host).
 */
export function definePlugin<T extends PluginManifest>(def: T): T {
  validatePluginManifest(def);
  return def;
}

// ---------------------------------------------------------------------------
// Canonical JSON (for signature payload)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation: sorted keys, no whitespace, `undefined`
 * keys omitted. This is the byte string that the `signature` is computed
 * over (with `signature` itself set to `undefined`).
 *
 * Mirrors the §40 template-marketplace-client canonical-JSON convention
 * so plugin signatures verify with the same crypto primitive.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PluginSdkError("canonical JSON: non-finite numbers are not representable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new PluginSdkError(`canonical JSON: unsupported type ${typeof value}`);
}

/**
 * Returns the byte string the plugin's signature should verify against
 * — the manifest's canonical JSON with `signature` cleared.
 */
export function manifestPayloadForSigning(manifest: PluginManifest): string {
  // Shallow clone, drop signature, then canonical-encode. `entrypointDigest`
  // is NOT dropped, so the signature commits to the plugin code via its hash.
  const { signature: _signature, ...rest } = manifest;
  return canonicalJson(rest);
}

/**
 * Compute the `entrypointDigest` for plugin code — the lowercase hex SHA-256 of
 * the entrypoint file's bytes. Plugin signing tools set the result on the
 * manifest's `entrypointDigest` before signing; the loader recomputes it from
 * the on-disk `index.js` and refuses to import on mismatch.
 */
export function entrypointDigest(code: string | Uint8Array): string {
  return createHash("sha256").update(code).digest("hex");
}
