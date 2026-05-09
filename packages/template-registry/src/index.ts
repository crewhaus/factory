import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

/**
 * Catalog F4 `template-registry` — Section 40 backend-agnostic
 * spec-template registry.
 *
 * `RegistrySource` interface (`list`, `fetch`, `metadata`) so the
 * registry can be backed by git releases, HuggingFace datasets, npm
 * packages, a local directory, etc. Built-in `LocalRegistrySource`
 * is the file-backed default and the test fixture for the others.
 *
 * Manifest schema: `{ name, version, description, author, target,
 * yaml, exampleEnv?, screenshots?, signature?, publicKey? }`.
 * `signature` is base64-encoded Ed25519 over a canonical JSON of the
 * non-signature fields; `publicKey` is the corresponding raw public
 * key (PKCS#8 PEM or raw 32-byte). The registry verifies signatures
 * against a configured trust root; unverified manifests are refused
 * (T8 supply-chain check).
 *
 * TTL cache: `cachedRegistry({source, ttlMs})` wraps any source with
 * a 60-minute (default) TTL. `refresh()` clears the cache so callers
 * (and the `crewhaus templates refresh` CLI subcommand) can force a
 * re-fetch on demand.
 *
 * Layer F4. Pairs with `scaffold-templates` (§26 — built-in
 * templates), `template-marketplace-client` (§40 — Studio UI integration).
 */

export class TemplateRegistryError extends CrewhausError {
  override readonly name = "TemplateRegistryError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type TemplateManifest = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly target: string;
  readonly yaml: string;
  readonly exampleEnv?: Record<string, string>;
  readonly screenshots?: ReadonlyArray<string>;
  /** Base64-encoded Ed25519 signature over canonical JSON of the rest. */
  readonly signature?: string;
  /** PKCS#8 PEM-encoded Ed25519 public key, OR raw 32-byte hex. */
  readonly publicKey?: string;
};

export type SignableManifest = Omit<TemplateManifest, "signature">;

export type TemplateMetadata = Omit<TemplateManifest, "yaml">;

export interface RegistrySource {
  readonly id: string;
  list(): Promise<ReadonlyArray<TemplateMetadata>>;
  fetch(name: string): Promise<TemplateManifest>;
  metadata(name: string): Promise<TemplateMetadata>;
}

export type TrustRoot = {
  /** PKCS#8 PEM-encoded Ed25519 public keys trusted to sign manifests. */
  readonly publicKeys: ReadonlyArray<string>;
};

// --------------------------------------------------------------------
// Canonical JSON for signing
// --------------------------------------------------------------------

function canonicalManifestJson(m: SignableManifest): string {
  // Stable key order; omit undefined optional fields.
  const ordered: Record<string, unknown> = {
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    target: m.target,
    yaml: m.yaml,
  };
  if (m.exampleEnv !== undefined) ordered["exampleEnv"] = m.exampleEnv;
  if (m.screenshots !== undefined) ordered["screenshots"] = m.screenshots;
  if (m.publicKey !== undefined) ordered["publicKey"] = m.publicKey;
  return JSON.stringify(ordered);
}

export function signManifest(manifest: SignableManifest, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(canonicalManifestJson(manifest), "utf8"), key);
  return sig.toString("base64");
}

export function verifyManifest(
  manifest: TemplateManifest,
  trustRoot: TrustRoot,
): { ok: boolean; reason?: string } {
  if (manifest.signature === undefined || manifest.signature === "") {
    return { ok: false, reason: "manifest is unsigned" };
  }
  if (manifest.publicKey === undefined || manifest.publicKey === "") {
    return { ok: false, reason: "manifest is missing publicKey" };
  }
  if (!trustRoot.publicKeys.some((pk) => pk === manifest.publicKey)) {
    return { ok: false, reason: "publicKey is not in trust root" };
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(manifest.publicKey);
  } catch (err) {
    return { ok: false, reason: `invalid publicKey: ${(err as Error).message}` };
  }
  const { signature: _sig, ...rest } = manifest;
  const sigBuf = Buffer.from(manifest.signature, "base64");
  const ok = cryptoVerify(null, Buffer.from(canonicalManifestJson(rest), "utf8"), key, sigBuf);
  return ok ? { ok: true } : { ok: false, reason: "signature does not verify" };
}

export function generateSigningKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

// --------------------------------------------------------------------
// Local file-backed source (default)
// --------------------------------------------------------------------

export type LocalRegistrySourceOptions = {
  readonly rootDir: string;
};

export class LocalRegistrySource implements RegistrySource {
  readonly id = "local";
  constructor(private readonly opts: LocalRegistrySourceOptions) {
    if (typeof opts.rootDir !== "string" || opts.rootDir === "") {
      throw new TemplateRegistryError("LocalRegistrySource: rootDir is required");
    }
    if (!existsSync(opts.rootDir)) {
      mkdirSync(opts.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  private manifestPath(name: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      throw new TemplateRegistryError(`invalid template name "${name}"`);
    }
    return join(this.opts.rootDir, `${name}.json`);
  }

  async list(): Promise<ReadonlyArray<TemplateMetadata>> {
    const out: TemplateMetadata[] = [];
    if (!existsSync(this.opts.rootDir)) return out;
    for (const f of readdirSync(this.opts.rootDir)) {
      if (!f.endsWith(".json")) continue;
      const path = join(this.opts.rootDir, f);
      if (!statSync(path).isFile()) continue;
      try {
        const m = JSON.parse(readFileSync(path, "utf8")) as TemplateManifest;
        const { yaml: _yaml, ...meta } = m;
        out.push(meta);
      } catch {
        // skip malformed files
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async fetch(name: string): Promise<TemplateManifest> {
    const path = this.manifestPath(name);
    if (!existsSync(path)) {
      throw new TemplateRegistryError(`template "${name}" not found`);
    }
    return JSON.parse(readFileSync(path, "utf8")) as TemplateManifest;
  }

  async metadata(name: string): Promise<TemplateMetadata> {
    const m = await this.fetch(name);
    const { yaml: _yaml, ...meta } = m;
    return meta;
  }

  /** Test/admin helper: write a manifest into the file-backed registry. */
  put(manifest: TemplateManifest): void {
    const path = this.manifestPath(manifest.name);
    writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }
}

// --------------------------------------------------------------------
// Generic HTTP-backed source (covers git releases / HuggingFace / npm
// — all of which serve manifest blobs over HTTP). Caller supplies the
// list URL + per-manifest URL builder.
// --------------------------------------------------------------------

export type HttpRegistrySourceOptions = {
  readonly id: "git" | "huggingface" | "npm";
  readonly listUrl: string;
  readonly fetchUrl: (name: string) => string;
  readonly fetchImpl?: typeof fetch;
};

export class HttpRegistrySource implements RegistrySource {
  readonly id: HttpRegistrySourceOptions["id"];
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: HttpRegistrySourceOptions) {
    this.id = opts.id;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async list(): Promise<ReadonlyArray<TemplateMetadata>> {
    const res = await this.fetchImpl(this.opts.listUrl);
    if (!res.ok) {
      throw new TemplateRegistryError(
        `${this.id} list ${res.status}: ${(await res.text()).slice(0, 256)}`,
      );
    }
    const data = (await res.json()) as { templates?: ReadonlyArray<TemplateMetadata> };
    if (!Array.isArray(data?.templates)) {
      throw new TemplateRegistryError(`${this.id} list payload missing templates[]`);
    }
    return data.templates;
  }

  async fetch(name: string): Promise<TemplateManifest> {
    const res = await this.fetchImpl(this.opts.fetchUrl(name));
    if (!res.ok) {
      throw new TemplateRegistryError(
        `${this.id} fetch "${name}" ${res.status}: ${(await res.text()).slice(0, 256)}`,
      );
    }
    return (await res.json()) as TemplateManifest;
  }

  async metadata(name: string): Promise<TemplateMetadata> {
    const m = await this.fetch(name);
    const { yaml: _yaml, ...meta } = m;
    return meta;
  }
}

// --------------------------------------------------------------------
// TTL cache wrapper
// --------------------------------------------------------------------

export type CachedRegistryOptions = {
  readonly source: RegistrySource;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

export interface CachedRegistry extends RegistrySource {
  refresh(): void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

export function cachedRegistry(opts: CachedRegistryOptions): CachedRegistry {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? ((): number => Date.now());
  type Cache<T> = { value: T; expiresAt: number };
  let listCache: Cache<ReadonlyArray<TemplateMetadata>> | undefined;
  const fetchCache = new Map<string, Cache<TemplateManifest>>();
  const metadataCache = new Map<string, Cache<TemplateMetadata>>();

  return {
    id: `${opts.source.id}+cache`,
    async list(): Promise<ReadonlyArray<TemplateMetadata>> {
      if (listCache && listCache.expiresAt > now()) return listCache.value;
      const value = await opts.source.list();
      listCache = { value, expiresAt: now() + ttl };
      return value;
    },
    async fetch(name): Promise<TemplateManifest> {
      const hit = fetchCache.get(name);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = await opts.source.fetch(name);
      fetchCache.set(name, { value, expiresAt: now() + ttl });
      return value;
    },
    async metadata(name): Promise<TemplateMetadata> {
      const hit = metadataCache.get(name);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = await opts.source.metadata(name);
      metadataCache.set(name, { value, expiresAt: now() + ttl });
      return value;
    },
    refresh(): void {
      listCache = undefined;
      fetchCache.clear();
      metadataCache.clear();
    },
  };
}

// --------------------------------------------------------------------
// Verifying registry — wraps any source with mandatory signature
// verification. Throws if the manifest's signature does not verify
// against the configured trust root.
// --------------------------------------------------------------------

export type VerifyingRegistryOptions = {
  readonly source: RegistrySource;
  readonly trustRoot: TrustRoot;
};

export function verifyingRegistry(opts: VerifyingRegistryOptions): RegistrySource {
  return {
    id: `${opts.source.id}+verifying`,
    async list(): Promise<ReadonlyArray<TemplateMetadata>> {
      // metadata-only listings can't verify (no yaml + signature is on the
      // full manifest); list returns metadata as-is and callers must call
      // fetch() to get a verified manifest.
      return opts.source.list();
    },
    async fetch(name: string): Promise<TemplateManifest> {
      const manifest = await opts.source.fetch(name);
      const result = verifyManifest(manifest, opts.trustRoot);
      if (!result.ok) {
        throw new TemplateRegistryError(
          `template "${name}" failed signature verification: ${result.reason ?? "unknown reason"}`,
        );
      }
      return manifest;
    },
    async metadata(name: string): Promise<TemplateMetadata> {
      return opts.source.metadata(name);
    },
  };
}

export {
  canonicalManifestJson as _canonicalManifestJsonForTest,
  DEFAULT_TTL_MS as _defaultTtlMsForTest,
};
