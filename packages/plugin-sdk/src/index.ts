import { createHash, randomBytes } from "node:crypto";
import { builtinModules } from "node:module";
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
 * to declare five extension points:
 *
 *   1. **Tools** — anything you would otherwise pass to `buildTool()`.
 *      BOUND: every host that activates plugins registers them.
 *   2. **Channels** — `ChannelAdapter`-shaped inbound surface.
 *   3. **Models** — provider adapters shaped like `ProviderAdapter`.
 *   4. **Graders** — evaluators shaped like `RegisteredGrader`.
 *   5. **Target emitters** — compile-time target backends shaped like
 *      `Emitter`.
 *
 * Only tools (and a plugin's `skills/` directory) are bound in this release.
 * Channels, models, graders and target emitters are accepted and collected,
 * and have no effect: no host reads them, and a boot that activates a plugin
 * contributing one says so (`UNBOUND_CONTRIBUTION_KINDS` in plugin-loader).
 * A grader belongs in `.crewhaus/graders/<name>/index.ts` instead.
 *
 * A plugin is code that runs INSIDE the crewhaus process, with its full
 * authority, from the moment it is imported. Of its declared
 * `permissions`, only `tools` is applied; see {@link PluginPermissions}.
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
 * / `-telegram` / `-discord` / `-whatsapp` / `-imessage`. NOT BOUND in
 * this release: a channel daemon's adapters are built into it from the
 * spec, and a plugin's are collected and ignored, with a boot note.
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
 * that package's transitive deps. NOT BOUND in this release: the model
 * router resolves models from the spec and ignores a plugin's.
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
 * from `grader-registry`. NOT BOUND in this release: put a grader in
 * `.crewhaus/graders/<name>/index.ts` (default export `{ name, grader }`),
 * which the eval runner loads.
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
 * IR variant and returns a `Bundle` (file list). NOT BOUND in this
 * release: target shapes are part of the compiler.
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
 * What a plugin declares it needs. Read this before trusting one.
 *
 * A plugin's code is imported into the crewhaus process and runs with that
 * process's full authority — its environment (secrets included), files,
 * network and child processes — from the moment it is imported, before any
 * tool is called. Whether it runs at all is decided by its signature
 * (`plugin-loader`), not by these declarations.
 *
 * - `tools` IS applied. A plugin tool finds on `ctx.bridge` only
 *   `runContext` and the host tools listed here (none when it is absent),
 *   and its `concurrencyClassifier` is shown only those, with an `execute`
 *   that runs nothing. A listed host tool the plugin calls runs with the
 *   runtime's context for that call, so `Task` still reaches its sub-agent
 *   spawner, which the plugin cannot see. It runs directly: the permission
 *   engine, the justification gate and the egress check that guard a
 *   model's call do not run for it. List only tools the plugin may drive
 *   unchecked.
 * - `fs`, `net` and `secrets` are NOT enforced on plugin code. The Hangar
 *   console evaluates `fs` and `net` for the panes it serves, whose code runs
 *   in a sandboxed browser iframe rather than in crewhaus; everywhere else
 *   they state what the plugin says it will touch, for the operator to read.
 */
export type PluginPermissions = {
  /** Filesystem globs the plugin says it reads or writes (`read:`/`write:` prefixed). Not enforced on plugin code. */
  readonly fs?: ReadonlyArray<string>;
  /** URL globs the plugin says it fetches (`fetch:` prefixed). Not enforced on plugin code. */
  readonly net?: ReadonlyArray<string>;
  /** Host tools the plugin's tools may reach through `ctx.bridge`. Enforced. */
  readonly tools?: ReadonlyArray<string>;
  /** Environment variables the plugin says it reads. Not enforced: plugin code sees the whole environment. */
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
  /**
   * Optional ISO-8601 timestamp, for people. It sits inside `signature`,
   * which the signature does not cover, so anyone can change it: nothing
   * reads it as a date. To give a signature an end, sign
   * {@link PluginManifest.notAfter}.
   */
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
  /**
   * The crewhaus versions this plugin runs on, as a semver range
   * (`"^0.7.0"`). The loader refuses the plugin on a version outside it, or
   * when the range is not one ({@link crewhausEngineProblem}).
   */
  readonly engines?: { readonly crewhaus?: string };
  readonly permissions?: PluginPermissions;
  /**
   * What the plugin's code contributes, listed in the manifest so it is
   * signed and can be read before anything runs. When `provides.tools` is
   * present, the plugin loads only if its code contributes exactly those
   * tools — no more, no fewer. Optional: a manifest without it loads as
   * before. (This makes the manifest the contract for what loads; it is not
   * a sandbox: the code has already run by the time the list is compared.)
   */
  readonly provides?: { readonly tools?: ReadonlyArray<string> };
  readonly contributions?: PluginContributions;
  /**
   * Lowercase hex SHA-256 of the plugin's entrypoint (`index.js`). It is part
   * of the manifest, so `manifestPayloadForSigning` includes it and the
   * signature therefore commits to the CODE, not just the metadata.
   *
   * REQUIRED on a signed manifest: without it a signature attests to no code,
   * and the loader refuses the plugin (it loads unverified only under
   * `CREWHAUS_PLUGIN_ALLOW_UNSIGNED=1`). Compute it with `entrypointDigest`.
   *
   * A signed plugin is ONE ES module file. The digest covers `index.js` and
   * nothing it loads, so the loader imports exactly the bytes it checked,
   * from a private copy, and refuses an `index.js` that loads anything but a
   * runtime builtin — by import, by `require`, or by a name worked out at run
   * time ({@link entrypointImportProblem}). Bundle the
   * plugin first: `bun build src/index.ts --target=bun --format=esm
   * --outfile index.js`. An unsigned (development) plugin may still be
   * several files; a digest on it is checked, and it is imported in place.
   */
  readonly entrypointDigest?: string;
  /**
   * The last moment this manifest's signature is good for, as an RFC 3339
   * date-time with an explicit offset (`2027-01-01T00:00:00Z`). It is signed
   * with the rest of the manifest, and the loader refuses the plugin after
   * it. A date-time without `Z` or an offset is refused rather than read as
   * the host's local time.
   */
  readonly notAfter?: string;
  readonly signature?: PluginSignature;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
/** A tool name every model provider accepts. */
export const PLUGIN_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
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
 *
 * This is the check for a manifest crewhaus is about to install or load:
 * {@link validatePluginManifestRecord}'s, plus the fields 0.7.1 gave a
 * meaning to (`notAfter`, `provides`), held to their exact shape.
 */
export function validatePluginManifest(m: unknown): PluginManifest {
  const manifest = validatePluginManifestRecord(m) as unknown as Record<string, unknown>;

  if (manifest["notAfter"] !== undefined) {
    const notAfter = manifest["notAfter"];
    if (typeof notAfter !== "string" || parseOffsetDateTime(notAfter) === undefined) {
      throw new PluginSdkError(
        `plugin manifest: \`notAfter\` must be an RFC 3339 date-time with Z or an offset, such as "2027-01-01T00:00:00Z" (got ${JSON.stringify(notAfter)}); a date-time without one would be read as the host's local time`,
      );
    }
  }

  if (manifest["provides"] !== undefined) {
    const provides = manifest["provides"];
    if (provides === null || typeof provides !== "object" || Array.isArray(provides)) {
      throw new PluginSdkError("plugin manifest: `provides` must be an object");
    }
    const tools = (provides as Record<string, unknown>)["tools"];
    assertOptionalStringArray(tools, "provides.tools");
    for (const tool of tools ?? []) {
      if (!PLUGIN_TOOL_NAME_PATTERN.test(tool)) {
        throw new PluginSdkError(
          `plugin manifest: \`provides.tools\` entry ${JSON.stringify(tool)} must be 1-64 letters, digits, "_" or "-"`,
        );
      }
    }
    if (tools !== undefined && new Set(tools).size !== tools.length) {
      throw new PluginSdkError("plugin manifest: `provides.tools` lists a tool twice");
    }
  }

  return manifest as unknown as PluginManifest;
}

/**
 * Throw `PluginSdkError` if `m` is not a manifest the plugin registry can
 * list: the checks 0.7.0 applied. `notAfter` and `provides` meant nothing
 * to 0.7.0, so an install record written then may carry them in any shape
 * (`"provides": ["notes_search"]`, a date-only `notAfter`); reading the
 * registry must not fail on that, or one such entry would stop every other
 * plugin from loading. Those fields are held to their shape where they
 * matter, when the plugin itself installs or loads
 * ({@link validatePluginManifest}).
 */
export function validatePluginManifestRecord(m: unknown): PluginManifest {
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

// ---------------------------------------------------------------------------
// engines.crewhaus — which crewhaus a plugin runs on
// ---------------------------------------------------------------------------

/** One version in a range: `1`, `1.2`, `1.2.3`, `1.x`, `*`, `1.2.3-beta.1+build`. */
const RANGE_PARTIAL =
  /^(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])(?:\.(?:0|[1-9]\d*|[xX*])(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?)?$/;
/** A comparator: an optional operator (npm's `~>` is `~`), npm's `v`/`=` prefix, a version. */
const RANGE_COMPARATOR = /^(<=|>=|<|>|=|~>?|\^)?[v=]*(.*)$/;
const MAX_RANGE_LENGTH = 256;

/** `token` as a comparator Bun.semver reads as npm does, or undefined when it is not one. */
function rangeComparator(token: string): string | undefined {
  const m = RANGE_COMPARATOR.exec(token);
  const op = m?.[1] ?? "";
  const version = m?.[2] ?? "";
  if (!RANGE_PARTIAL.test(version)) return undefined;
  return `${op === "~>" ? "~" : op === "=" ? "" : op}${version}`;
}

/**
 * `range` as crewhaus checks it, or undefined when it is not a semver range.
 * The npm grammar, read the way npm reads it: comparator sets joined by
 * `||`, each a space-separated list of versions with an optional `<`, `<=`,
 * `>`, `>=`, `=`, `~` (or `~>`) or `^`, or a hyphen range `1.2.3 - 2.3.4`.
 * Versions may be partial (`1.2`) or use `x`/`*`. An operator may be
 * followed by spaces (`>= 1.2.3`), and an empty set — the empty range, or
 * an empty side of `||` — matches every version, as it does for npm. The
 * result is spelled so that `Bun.semver.satisfies` reads it the same way.
 */
function normalizedEngineRange(range: string): string | undefined {
  if (typeof range !== "string" || range.length > MAX_RANGE_LENGTH) return undefined;
  const sets: string[] = [];
  for (const raw of range.split("||")) {
    const set = raw.trim().replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, "$1");
    if (set === "") {
      sets.push("*");
      continue;
    }
    const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen !== null) {
      const from = rangeComparator(hyphen[1] ?? "");
      const to = rangeComparator(hyphen[2] ?? "");
      // A hyphen range's ends are plain versions.
      if (from === undefined || to === undefined || !RANGE_PARTIAL.test(from)) return undefined;
      if (!RANGE_PARTIAL.test(to)) return undefined;
      sets.push(`${from} - ${to}`);
      continue;
    }
    const comparators: string[] = [];
    for (const token of set.split(/\s+/)) {
      const comparator = rangeComparator(token);
      if (comparator === undefined) return undefined;
      comparators.push(comparator);
    }
    sets.push(comparators.join(" "));
  }
  return sets.join(" || ");
}

/**
 * Is `range` a semver range crewhaus can check a version against? The npm
 * grammar, as npm reads it (see {@link crewhausEngineProblem}): a range npm
 * accepts is accepted, `~>0.7.0` and an empty side of `||` included.
 *
 * Checked on its own because `Bun.semver.satisfies` answers `true` for text
 * that is not a range at all ("not a range", "garbage>=1"), which would let a
 * plugin that declares nonsense run anywhere.
 */
export function isValidEngineRange(range: string): boolean {
  return normalizedEngineRange(range) !== undefined;
}

/**
 * Why a plugin must not run on crewhaus `hostVersion`, or undefined when it
 * may: its manifest's `engines.crewhaus` is not a semver range, or the range
 * leaves this version out. A plugin that declares no range runs anywhere, as
 * before. A prerelease host (`0.7.1-canary.2`) is checked as its release
 * (`0.7.1`), so a canary runs the plugins its release will.
 */
export function crewhausEngineProblem(
  manifest: Pick<PluginManifest, "name" | "version" | "engines">,
  hostVersion: string,
): string | undefined {
  const range = manifest.engines?.crewhaus;
  if (range === undefined) return undefined;
  const who = `plugin "${manifest.name}" ${manifest.version}`;
  const normalized = normalizedEngineRange(range);
  if (normalized === undefined) {
    return `${who} declares engines.crewhaus ${JSON.stringify(range)}, which is not a semver range, so crewhaus cannot tell whether it runs on ${hostVersion}`;
  }
  const release = hostVersion.match(/^\d+\.\d+\.\d+/)?.[0] ?? hostVersion;
  if (Bun.semver.satisfies(release, normalized)) return undefined;
  return `${who} requires crewhaus ${range}, and this is crewhaus ${hostVersion}`;
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

// ---------------------------------------------------------------------------
// notAfter — when a signed manifest stops being good
// ---------------------------------------------------------------------------

const OFFSET_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Milliseconds since the epoch for an RFC 3339 date-time that carries `Z` or
 * an offset, or undefined for anything else — including a date-time with no
 * offset, which `Date.parse` would read as the host's local time, and a
 * calendar date that does not exist (`2027-02-30`).
 */
function parseOffsetDateTime(text: string): number | undefined {
  const m = OFFSET_DATE_TIME.exec(text);
  if (m === null) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return undefined;
  }
  // `Date` rolls 2027-02-30 over to March; a date that does not exist is refused.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Why a manifest must not load at `nowMs`, or undefined when it may: its
 * signed `notAfter` has passed. A manifest without one does not expire.
 */
export function manifestExpiryProblem(
  manifest: Pick<PluginManifest, "name" | "version" | "notAfter">,
  nowMs: number,
): string | undefined {
  if (manifest.notAfter === undefined) return undefined;
  const until = parseOffsetDateTime(manifest.notAfter);
  if (until === undefined) {
    return `plugin "${manifest.name}" ${manifest.version} has a notAfter crewhaus cannot read (${JSON.stringify(manifest.notAfter)})`;
  }
  if (nowMs <= until) return undefined;
  return `plugin "${manifest.name}" ${manifest.version} expired: its manifest is good until ${manifest.notAfter}, and it is now ${new Date(nowMs).toISOString()}`;
}

// ---------------------------------------------------------------------------
// What a signed entrypoint may import
// ---------------------------------------------------------------------------

const HOST_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/**
 * The builtin that loads modules by name (`createRequire`, `Module._load`,
 * `register`): a signed plugin that imports it can load a package the
 * digest does not cover, so it is not one of the builtins a signed plugin
 * may import.
 */
const MODULE_LOADER_BUILTINS: ReadonlySet<string> = new Set(["module", "node:module"]);

/** A module the runtime itself provides: `node:*`, `bun:*`, `bun`, or a bare Node builtin (`fs`). */
function isRuntimeBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier === "bun" ||
    HOST_BUILTINS.has(specifier)
  );
}

/** A module a signed entrypoint may import: a runtime builtin, but not the module loader. */
function isSignedImportAllowed(specifier: string): boolean {
  return isRuntimeBuiltin(specifier) && !MODULE_LOADER_BUILTINS.has(specifier);
}

const BUNDLE_HINT =
  "A signed plugin must be one file: bundle it (bun build src/index.ts --target=bun --format=esm --outfile index.js) and sign that";

/**
 * The properties of `import.meta` that say where the module is and read
 * nothing: every other use (`require`, `resolve`, the object itself passed
 * along) is a way to load a module by name.
 */
const IMPORT_META_LOCATION = /^\.(?:url|dir|dirname|file|filename|path|main|env)(?![\w$])/;

/** The run-time ways to find a module by name that no literal import shows. */
const RESOLVERS: ReadonlyArray<readonly [string, string]> = [
  ["require.resolve", "requireResolve"],
  ["import.meta.resolve", "metaResolve"],
  ["Bun.resolveSync", "bunResolveSync"],
  ["Bun.resolve", "bunResolve"],
  ["process.getBuiltinModule", "getBuiltinModule"],
  ["process.mainModule", "mainModule"],
];

/** `"…"`, `'…'` or `` `…` `` holding a specifier a signed entrypoint may import, at the start of `text`. */
function allowedLiteralAt(text: string, from: number): number | undefined {
  const m = /^(["'`])([^"'`\\$]*)\1/.exec(text.slice(from, from + 256));
  if (m === null || m[2] === undefined || !isSignedImportAllowed(m[2])) return undefined;
  return from + m[0].length;
}

/** `[A-Za-z0-9_$]`, by code unit; a non-ASCII identifier character reads as punctuation, which only shortens {@link codeMask}'s `word`. */
function isIdentChar(c: string): boolean {
  const k = c.charCodeAt(0);
  return (
    (k >= 0x61 && k <= 0x7a) ||
    (k >= 0x41 && k <= 0x5a) ||
    (k >= 0x30 && k <= 0x39) ||
    k === 0x5f ||
    k === 0x24
  );
}

function isSpace(c: string): boolean {
  const k = c.charCodeAt(0);
  return k === 0x20 || k === 0x0a || k === 0x09 || k === 0x0d;
}

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** Punctuation after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_PUNCT = "(,=:[!&|?{};+-*%<>~^";

/**
 * Which characters of `text` — the transpiler's own normalised output — are
 * code, and which sit inside a string, a template's text, a comment or a
 * regular-expression literal: a `1` for each code character. One pass, so
 * its time is linear in the text. A template's `${…}` is code, nested to any
 * depth. A `/` is read as a regular expression where JavaScript reads it so
 * (after an operator or one of {@link REGEX_AFTER_WORD}).
 */
function codeMask(text: string): Uint8Array {
  const n = text.length;
  const mask = new Uint8Array(n);
  // One entry per open `${`: the `{` depth inside it, so its `}` is found.
  const templates: number[] = [];
  let depth = 0;
  let prev = ""; // the last code character that is not white space
  let word = ""; // the identifier that ends at `prev`, if any
  let i = 0;
  const skipTemplateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") j += 2;
      else if (ch === "`") return j + 1;
      else if (ch === "$" && text[j + 1] === "{") {
        templates.push(depth);
        return j + 2;
      } else j += 1;
    }
    return n;
  };
  while (i < n) {
    const c = text[i] as string;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      i = j + 1;
      prev = c;
      word = "";
      continue;
    }
    if (c === "`") {
      i = skipTemplateText(i + 1);
      prev = "`";
      word = "";
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (
      c === "/" &&
      (prev === "" || REGEX_AFTER_PUNCT.includes(prev) || REGEX_AFTER_WORD.has(word))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const ch = text[j];
        if (ch === "\\") j += 1;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j += 1;
      }
      i = j + 1;
      while (i < n && isIdentChar(text[i] as string)) i += 1;
      prev = "/";
      word = "";
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        i = skipTemplateText(i + 1);
        prev = "`";
        word = "";
        continue;
      }
      depth -= 1;
    }
    mask[i] = 1;
    if (isIdentChar(c)) word = isIdentChar(prev) ? word + c : c;
    else if (!isSpace(c)) word = "";
    if (!isSpace(c)) prev = c;
    i += 1;
  }
  return mask;
}

/**
 * Whether the name at `start`..`end` of `text` is only tested with `typeof`,
 * which loads nothing: `typeof name`, or `typeof (0, name)` as the
 * transpiler prints a replaced member expression.
 */
function isTypeofAt(text: string, start: number, end: number): boolean {
  if (text.slice(Math.max(0, start - 7), start) === "typeof ") return true;
  return text.slice(Math.max(0, start - 11), start) === "typeof (0, " && text[end] === ")";
}

/** Whether `text` at `from` is a call on one literal builtin name: `("node:fs")`. */
function isBuiltinCall(text: string, from: number): boolean {
  if (text[from] !== "(") return false;
  const close = allowedLiteralAt(text, from + 1);
  return close !== undefined && text[close] === ")";
}

/**
 * Why the module-loading code in `text` — a signed entrypoint that passed
 * the literal-import check — could load a module the digest does not cover,
 * or undefined when it cannot. Bun's own transpiler finds the references
 * (it replaces each global name below with a random marker, so a string or
 * a comment never counts, and a local variable that shadows one is left
 * alone); then:
 *
 * - `require` may only be called directly on a builtin's literal name, or
 *   tested with `typeof`;
 * - `import.meta.require` likewise, or through the one alias a bundler
 *   writes (`var __require = import.meta.require;`) when every call through
 *   that alias names a builtin;
 * - `import.meta` may only be read for where the module is (`.url`,
 *   `.dir`, …);
 * - `import()` must name a builtin literally;
 * - `require.resolve`, `import.meta.resolve`, `Bun.resolveSync`,
 *   `Bun.resolve`, `process.getBuiltinModule` and `process.mainModule` are
 *   refused outright.
 *
 * This reads the source as written. Code built or looked up at run time —
 * `eval`, `new Function`, `globalThis[name]` — is not examined; the loader
 * stages a signed plugin where only the operator can plant a package, so a
 * name found that way resolves in the operator's own directories.
 */
function runtimeLoadProblem(text: string): string | undefined {
  const marker = `__crewhaus_${randomBytes(8).toString("hex")}_`;
  const define: Record<string, string> = {
    require: `${marker}require`,
    "import.meta": `${marker}meta`,
    "import.meta.require": `${marker}metaRequire`,
  };
  for (const [name, id] of RESOLVERS) define[name] = `${marker}${id}`;
  let out: string;
  try {
    out = new Bun.Transpiler({ loader: "js", define }).transformSync(text);
  } catch (err) {
    return `it cannot be read as JavaScript (${err instanceof Error ? err.message : String(err)})`;
  }
  const refused = new Set<string>();
  const aliases = new Set<string>();
  const found = new RegExp(`${marker}(\\w+)`, "g");
  for (let m = found.exec(out); m !== null; m = found.exec(out)) {
    const id = m[1] as string;
    const after = found.lastIndex;
    const resolver = RESOLVERS.find(([, rid]) => rid === id);
    if (resolver !== undefined) {
      refused.add(resolver[0]);
      continue;
    }
    if (id === "meta") {
      if (!IMPORT_META_LOCATION.test(out.slice(after, after + 16))) refused.add("import.meta");
      continue;
    }
    const name = id === "require" ? "require" : "import.meta.require";
    if (isTypeofAt(out, m.index, after) || isBuiltinCall(out, after)) continue;
    // The alias a bundler writes for import.meta.require.
    const alias = /(?:var|let|const) ([A-Za-z_$][\w$]*) = $/.exec(
      out.slice(Math.max(0, m.index - 80), m.index),
    );
    if (id === "metaRequire" && alias?.[1] !== undefined && out[after] === ";") {
      aliases.add(alias[1]);
      continue;
    }
    refused.add(`${name} with a name that is not a builtin's, written out`);
  }
  const code = codeMask(out);
  for (const alias of aliases) {
    const uses = new RegExp(`(?<![\\w$.])${alias.replaceAll("$", "\\$")}(?![\\w$])`, "g");
    for (let m = uses.exec(out); m !== null; m = uses.exec(out)) {
      if (code[m.index] !== 1) continue; // in a string or a comment
      const after = uses.lastIndex;
      if (out.startsWith(` = ${marker}metaRequire;`, after)) continue; // its declaration
      if (isTypeofAt(out, m.index, after)) continue;
      if (isBuiltinCall(out, after)) continue;
      refused.add(
        `import.meta.require (through ${alias}) with a name that is not a builtin's, written out`,
      );
      break;
    }
  }
  const dynamic = /(?<![\w$.])import\(/g;
  for (let m = dynamic.exec(out); m !== null; m = dynamic.exec(out)) {
    if (code[m.index] !== 1) continue; // in a string or a comment
    const close = allowedLiteralAt(out, dynamic.lastIndex);
    if (close === undefined || (out[close] !== ")" && out[close] !== ",")) {
      refused.add("import() with a name that is not a builtin's, written out");
      break;
    }
  }
  if (refused.size === 0) return undefined;
  return `it loads modules by a name found at run time (${[...refused].join("; ")}), which its entrypointDigest does not cover. ${BUNDLE_HINT}`;
}

/**
 * Why `code`, a signed plugin's `index.js`, cannot run as the code its
 * `entrypointDigest` attests to, or undefined when it can. The digest covers
 * this one file, so loading anything the runtime does not provide itself —
 * a sibling (`./lib.js`) or a package (`zod`, which Bun may even fetch from
 * npm when no `node_modules` has it) — would run code the signature does not
 * cover.
 *
 * - Literal imports are read with Bun's own scanner — static imports,
 *   re-exports, `require("…")` and `import("…")` — and may name only a
 *   runtime builtin other than `module` (whose `createRequire` loads
 *   packages).
 * - The file must be an ES module that exports something (the loader reads
 *   its default export): a CommonJS file has `module.require`, which no
 *   scan can follow.
 * - Run-time loading by name is refused too (see {@link runtimeLoadProblem}).
 */
export function entrypointImportProblem(code: string | Uint8Array): string | undefined {
  const text = typeof code === "string" ? code : new TextDecoder().decode(code);
  let scanned: {
    readonly exports: ReadonlyArray<string>;
    readonly imports: ReadonlyArray<{ readonly path: string }>;
  };
  let imports: ReadonlyArray<{ readonly path: string }>;
  try {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    imports = transpiler.scanImports(text);
    scanned = transpiler.scan(text);
  } catch (err) {
    return `it cannot be read as JavaScript (${err instanceof Error ? err.message : String(err)})`;
  }
  const outside = [...new Set(imports.map((i) => i.path).filter((p) => !isSignedImportAllowed(p)))];
  if (outside.length > 0) {
    const listed = outside
      .slice(0, 5)
      .map((p) => JSON.stringify(p))
      .join(", ");
    const more = outside.length > 5 ? ` and ${outside.length - 5} more` : "";
    const loader = outside.some((p) => MODULE_LOADER_BUILTINS.has(p))
      ? " (the module builtin loads packages by name)"
      : "";
    return `it imports ${listed}${more}${loader}, which its entrypointDigest does not cover. ${BUNDLE_HINT}`;
  }
  if (scanned.exports.length === 0) {
    return `it exports nothing, so it is not an ES module crewhaus can check: a signed plugin is an ES module whose default export is the plugin. ${BUNDLE_HINT}`;
  }
  return runtimeLoadProblem(text);
}
