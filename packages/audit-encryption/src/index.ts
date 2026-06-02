import {
  type CipherGCM,
  type DecipherGCM,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import type { Secrets } from "@crewhaus/secrets-manager";

/**
 * Catalog R17 `audit-encryption` — Section 39 envelope encryption for
 * audit-log payloads.
 *
 * Encrypts per-record JSON payloads with a tenant-scoped Data
 * Encryption Key (DEK); the DEK itself is encrypted ("wrapped") with
 * a Key Encryption Key (KEK) sourced from §27 `secrets-manager`. The
 * resulting record carries
 *   { tenantId, kekRef, dekRef, kekSalt, iv, tag, encryptedPayload, ... }
 * and is verifiable + decryptable by any caller with the same KEK.
 *
 * Algorithms:
 *   - AES-256-GCM for both DEK→payload and KEK→DEK wrapping. GCM is
 *     authenticated, so tampering with `encryptedPayload`, `iv`, or
 *     `tag` causes `decrypt` to throw — satisfies the §39 T8
 *     ciphertext-integrity requirement.
 *   - The 32-byte AES wrapping key is derived from the KEK string via
 *     scrypt (a salted, memory-hard KDF) with a per-record random salt.
 *     This holds even when the KEK is a low-entropy passphrase: scrypt
 *     stretches it and the persisted salt defeats precomputation
 *     (CWE-916 — a bare unsalted hash would not). The salt is stored on
 *     the record (`kekSalt`) so the same key can be re-derived at
 *     unwrap time.
 *   - 12-byte (96-bit) IVs randomly generated per record.
 *
 * Key rotation:
 *   `secrets.onRotation(...)` triggers `rotateKek()` which mints a fresh
 *   DEK version (`dek:<tenant>:vN+1`) for every tenant in the DEK store
 *   and adopts the new KEK as current. The prior KEK *value* is retained
 *   in-process keyed by its `kekRef`, so `decryptPayload` can re-derive
 *   the wrapping key for historical records (which keep their original
 *   `kekRef` + `kekSalt`) and still unwrap them (CWE-323 — without
 *   retaining prior material, rotation would strand old records).
 *   DEKs also roll automatically once a single version has wrapped more
 *   than `maxRecordsPerDek` records.
 *
 * Layer R17. Pairs with `audit-log` (R-infra — wraps `append` /
 * `read`) and `secrets-manager` (§27 — KEK source).
 */

export class AuditEncryptionError extends CrewhausError {
  override readonly name = "AuditEncryptionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type EncryptedRecord = {
  /** Tenant whose DEK was used. */
  readonly tenantId: string;
  /** Stable identifier for the KEK version used to wrap the DEK. */
  readonly kekRef: string;
  /** Stable identifier for the DEK used to encrypt the payload. */
  readonly dekRef: string;
  /**
   * Per-record salt (hex) fed to the scrypt KEK-key derivation. Absent on
   * legacy records written before the KDF migration; those fall back to
   * the legacy unsalted-SHA-256 derivation for back-compat.
   */
  readonly kekSalt?: string;
  /** 96-bit GCM IV (24 hex chars). */
  readonly iv: string;
  /** 128-bit GCM auth tag (32 hex chars). */
  readonly tag: string;
  /** Encrypted payload (hex). */
  readonly encryptedPayload: string;
  /** Wrapped DEK (hex), sealed with `kekRef`. */
  readonly wrappedDek: string;
  /** Wrapped DEK IV (hex). */
  readonly wrappedDekIv: string;
  /** Wrapped DEK auth tag (hex). */
  readonly wrappedDekTag: string;
};

export type AuditEncryptionOptions = {
  readonly secrets: Secrets;
  /** Name of the KEK in §27 secrets-manager. */
  readonly kekName: string;
  /**
   * Stable identifier for the *boot* KEK value. Defaults to
   * `kek:<kekName>:v1`. This is the `kekRef` stamped on records sealed
   * before the first in-process rotation, and the key under which the
   * boot KEK is held in the retain-for-decrypt registry. After one or
   * more rotations, a restarted process boots with the *latest* KEK
   * value; pass that rotation's ref here so historical refs stay stable
   * and the boot value is not mistaken for the original `:v1` material.
   */
  readonly kekRef?: string;
  /**
   * Optional persistent DEK store. If omitted, DEKs live in-memory
   * (process-local). Production should plug a tenant-scoped key store
   * here (HSM, KMS, vault path) — see {@link createFileDekStore} for a
   * file-backed implementation that survives restart.
   */
  readonly dekStore?: DekStore;
  /**
   * Prior KEK material to re-seed at boot, keyed by the `kekRef` it was
   * minted under. The in-process KEK registry that {@link rotateKek}
   * populates does not survive a restart, so a freshly-constructed engine
   * can only unwrap records sealed under the *boot* KEK. Operators that
   * have rotated must re-provide each superseded KEK here so historical
   * records (which embed their original `kekRef`) keep decrypting after a
   * restart (CWE-323). Values are never persisted by this package; the
   * operator re-supplies them from the secret backend's history.
   */
  readonly retainedKeks?: ReadonlyArray<{ readonly kekRef: string; readonly kekValue: string }>;
  /**
   * Roll a tenant's DEK to a fresh version once it has wrapped this many
   * records. Bounds the blast radius of any single DEK. Defaults to
   * {@link DEFAULT_MAX_RECORDS_PER_DEK}.
   */
  readonly maxRecordsPerDek?: number;
  /** Test seam: deterministic IV/salt generator. */
  readonly randomBytesImpl?: (n: number) => Buffer;
  /** Test seam: synthetic Date.now. */
  readonly now?: () => number;
};

/**
 * Versioned DEK entry. `version` is the integer N behind the
 * `dek:<tenant>:vN` ref; `uses` counts records encrypted under it so we
 * can roll on the {@link AuditEncryptionOptions.maxRecordsPerDek}
 * threshold.
 */
export type DekEntry = {
  readonly dek: Buffer;
  readonly version: number;
  readonly uses: number;
};

export interface DekStore {
  get(tenantId: string): Promise<Buffer | undefined>;
  set(tenantId: string, dek: Buffer): Promise<void>;
  /**
   * Optional versioned read. When present it is preferred over `get`, and
   * carries the version + usage counter needed for rotation. Stores that
   * implement only `get`/`set` are treated as version 1 with no usage
   * tracking (rotation still re-mints; the threshold is a no-op).
   */
  getEntry?(tenantId: string): Promise<DekEntry | undefined>;
  /** Optional versioned write. Required for DEK versioning to take effect. */
  setEntry?(tenantId: string, entry: DekEntry): Promise<void>;
  /** Optional iteration over tenants holding a DEK. Required by `rotateKek`. */
  tenants?(): Promise<ReadonlyArray<string>>;
}

export class InMemoryDekStore implements DekStore {
  private readonly map = new Map<string, DekEntry>();
  async get(tenantId: string): Promise<Buffer | undefined> {
    return this.map.get(tenantId)?.dek;
  }
  async set(tenantId: string, dek: Buffer): Promise<void> {
    const prev = this.map.get(tenantId);
    this.map.set(tenantId, {
      dek: Buffer.from(dek),
      version: prev?.version ?? 1,
      uses: 0,
    });
  }
  async getEntry(tenantId: string): Promise<DekEntry | undefined> {
    const entry = this.map.get(tenantId);
    return entry === undefined ? undefined : { ...entry, dek: Buffer.from(entry.dek) };
  }
  async setEntry(tenantId: string, entry: DekEntry): Promise<void> {
    this.map.set(tenantId, { ...entry, dek: Buffer.from(entry.dek) });
  }
  async tenants(): Promise<ReadonlyArray<string>> {
    return [...this.map.keys()];
  }
}

/**
 * Source of KEK material for {@link createFileDekStore}. The store wraps
 * each DEK before it touches disk and unwraps on read, so it needs the
 * *current* KEK to seal new writes and any *superseded* KEK (keyed by the
 * `kekRef` recorded alongside the wrapped DEK) to open older files after
 * a rotation. Operators construct this at boot from the same KEK(s) they
 * re-provide to the engine — the store never persists the KEK value
 * itself, only the wrapped DEK plus its `kekRef`.
 */
export interface KekProvider {
  /** KEK used to wrap DEKs on write. */
  current(): { readonly kekRef: string; readonly kekValue: string };
  /** Resolve the KEK value a stored DEK was wrapped under, by `kekRef`. */
  resolve(kekRef: string): string | undefined;
}

/**
 * Build a {@link KekProvider} from a current KEK plus zero or more
 * superseded KEKs (keyed by their original `kekRef`). After a rotation,
 * the operator re-supplies the prior KEK(s) here so the file store can
 * unwrap DEK files sealed under them.
 */
export function staticKekProvider(
  current: { readonly kekRef: string; readonly kekValue: string },
  retained: ReadonlyArray<{ readonly kekRef: string; readonly kekValue: string }> = [],
): KekProvider {
  const byRef = new Map<string, string>();
  for (const { kekRef, kekValue } of retained) byRef.set(kekRef, kekValue);
  // The current KEK takes precedence over any same-ref retained entry.
  byRef.set(current.kekRef, current.kekValue);
  return {
    current: () => ({ kekRef: current.kekRef, kekValue: current.kekValue }),
    resolve: (kekRef) => byRef.get(kekRef),
  };
}

/** On-disk shape of a persisted DEK file. Never contains the raw DEK. */
type PersistedDek = {
  readonly version: number;
  readonly uses: number;
  /** KEK ref the DEK is wrapped under — selects the unwrap key on read. */
  readonly kekRef: string;
  /** Per-file scrypt salt (hex) for the wrapping-key derivation. */
  readonly kekSalt: string;
  /** Wrapped (encrypted) DEK + GCM IV/tag, all hex. */
  readonly wrappedDek: string;
  readonly wrappedDekIv: string;
  readonly wrappedDekTag: string;
};

export type FileDekStoreOptions = {
  /**
   * Test seam: deterministic IV/salt generator for the wrapping step.
   * Defaults to {@link randomBytes}.
   */
  readonly randomBytesImpl?: (n: number) => Buffer;
};

/**
 * File-backed {@link DekStore} that persists DEKs so they (and their
 * version + use-count) survive a restart. Each tenant's DEK lives in
 * `<rootDir>/dek-<tenant>.json` written at mode `0o600`.
 *
 * SECURITY: the raw DEK is **never** written to disk. It is wrapped with
 * the {@link KekProvider}'s current KEK (scrypt-derived AES-256-GCM key,
 * the same scheme the engine uses for records) and only the *wrapped*
 * bytes — together with the `kekRef` and salt needed to re-derive the
 * unwrapping key — are persisted. The KEK *value* is supplied by the
 * operator at boot and is never persisted (CWE-312/CWE-256): an attacker
 * with read access to `rootDir` gets only ciphertext.
 *
 * After a rotation the operator must keep providing the prior KEK(s) via
 * {@link staticKekProvider}'s `retained` list until every tenant's file
 * has been rewritten under the new KEK (which happens on the next write
 * for that tenant, including the re-mint that `rotateKek` performs).
 */
export function createFileDekStore(
  rootDir: string,
  kek: KekProvider,
  opts: FileDekStoreOptions = {},
): DekStore {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new AuditEncryptionError("createFileDekStore: rootDir is required");
  }
  const rng = opts.randomBytesImpl ?? randomBytes;
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });

  const FILE_PREFIX = "dek-";
  const FILE_SUFFIX = ".json";

  function pathFor(tenantId: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(tenantId)) {
      throw new AuditEncryptionError(
        `createFileDekStore: invalid tenantId "${tenantId}" (must match [A-Za-z0-9_.-]+)`,
      );
    }
    return join(rootDir, `${FILE_PREFIX}${tenantId}${FILE_SUFFIX}`);
  }

  /** Wrap a raw DEK under the current KEK for persistence. */
  function wrap(dek: Buffer): Omit<PersistedDek, "version" | "uses"> {
    const { kekRef, kekValue } = kek.current();
    const salt = rng(SALT_BYTES);
    const kekKey = deriveKekKey(kekValue, salt);
    const iv = rng(IV_BYTES);
    const { ciphertext, tag } = encryptBytes(dek, kekKey, iv);
    return {
      kekRef,
      kekSalt: salt.toString("hex"),
      wrappedDek: ciphertext.toString("hex"),
      wrappedDekIv: iv.toString("hex"),
      wrappedDekTag: tag.toString("hex"),
    };
  }

  /** Unwrap a persisted DEK using the KEK its `kekRef` selects. */
  function unwrap(p: PersistedDek): Buffer {
    const kekValue = kek.resolve(p.kekRef);
    if (kekValue === undefined) {
      throw new AuditEncryptionError(
        `createFileDekStore: no KEK material for kekRef ${p.kekRef}; cannot unwrap persisted DEK (re-provide the prior KEK via staticKekProvider's retained list)`,
      );
    }
    const kekKey = deriveKekKey(kekValue, Buffer.from(p.kekSalt, "hex"));
    return decryptBytes(
      Buffer.from(p.wrappedDek, "hex"),
      kekKey,
      Buffer.from(p.wrappedDekIv, "hex"),
      Buffer.from(p.wrappedDekTag, "hex"),
    );
  }

  function readPersisted(tenantId: string): PersistedDek | undefined {
    const p = pathFor(tenantId);
    if (!existsSync(p)) return undefined;
    const raw = readFileSync(p, "utf8");
    let parsed: PersistedDek;
    try {
      parsed = JSON.parse(raw) as PersistedDek;
    } catch (err) {
      throw new AuditEncryptionError(`createFileDekStore: corrupt DEK file at ${p}`, err);
    }
    return parsed;
  }

  /** Atomic write at 0o600: write `.tmp`, then rename into place. */
  function writePersisted(tenantId: string, value: PersistedDek): void {
    const p = pathFor(tenantId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, p);
  }

  return {
    async get(tenantId: string): Promise<Buffer | undefined> {
      const p = readPersisted(tenantId);
      return p === undefined ? undefined : unwrap(p);
    },
    async set(tenantId: string, dek: Buffer): Promise<void> {
      const prev = readPersisted(tenantId);
      writePersisted(tenantId, { ...wrap(dek), version: prev?.version ?? 1, uses: 0 });
    },
    async getEntry(tenantId: string): Promise<DekEntry | undefined> {
      const p = readPersisted(tenantId);
      if (p === undefined) return undefined;
      return { dek: unwrap(p), version: p.version, uses: p.uses };
    },
    async setEntry(tenantId: string, entry: DekEntry): Promise<void> {
      writePersisted(tenantId, {
        ...wrap(entry.dek),
        version: entry.version,
        uses: entry.uses,
      });
    },
    async tenants(): Promise<ReadonlyArray<string>> {
      if (!existsSync(rootDir)) return [];
      return readdirSync(rootDir)
        .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
        .map((f) => f.slice(FILE_PREFIX.length, f.length - FILE_SUFFIX.length));
    },
  };
}

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard
const SALT_BYTES = 16; // scrypt salt
/** scrypt cost params: N=2^15 keeps derivation well under a frame budget. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** Default DEK roll threshold. */
export const DEFAULT_MAX_RECORDS_PER_DEK = 100_000;

/**
 * Derive the 32-byte AES wrapping key from the KEK string using scrypt
 * with the supplied salt. scrypt is salted + memory-hard, so this is
 * sound even when `kekValue` is a low-entropy passphrase (CWE-916). The
 * salt must be persisted (`EncryptedRecord.kekSalt`) to re-derive.
 */
function deriveKekKey(kekValue: string, salt: Buffer): Buffer {
  return scryptSync(kekValue, salt, KEY_BYTES, SCRYPT_PARAMS);
}

/**
 * Legacy unsalted-SHA-256 derivation. Retained only to unwrap records
 * written before the scrypt migration (those carry no `kekSalt`). Never
 * used for new records.
 */
function deriveKekKeyLegacy(kekValue: string): Buffer {
  return createHash("sha256").update(kekValue).digest();
}

function encryptBytes(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer,
): { ciphertext: Buffer; tag: Buffer } {
  const cipher: CipherGCM = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, tag };
}

function decryptBytes(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher: DecipherGCM = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface AuditEncryption {
  /** Encrypt the JSON-serializable payload for this tenant. */
  encryptPayload(payload: unknown, tenantId: string): Promise<EncryptedRecord>;
  /** Decrypt and parse a previously encrypted record. */
  decryptPayload(record: EncryptedRecord): Promise<unknown>;
  /**
   * Adopt a new KEK and re-key every tenant's DEK to a fresh version.
   * Production callers subscribe via `secrets.onRotation(handler)` and
   * forward to this. The prior KEK value is retained in-process so
   * historical records (which keep their original `kekRef`) still
   * decrypt.
   */
  rotateKek(newKekValue: string, newKekRef: string): Promise<void>;
  /** Current KEK ref. */
  readonly kekRef: string;
}

export async function createAuditEncryption(
  opts: AuditEncryptionOptions,
): Promise<AuditEncryption> {
  if (typeof opts.kekName !== "string" || opts.kekName.length === 0) {
    throw new AuditEncryptionError("kekName is required");
  }
  if (opts.secrets === undefined) {
    throw new AuditEncryptionError("secrets is required");
  }
  const dekStore = opts.dekStore ?? new InMemoryDekStore();
  const rng = opts.randomBytesImpl ?? randomBytes;
  const maxRecordsPerDek =
    opts.maxRecordsPerDek !== undefined && opts.maxRecordsPerDek > 0
      ? opts.maxRecordsPerDek
      : DEFAULT_MAX_RECORDS_PER_DEK;
  const initialKekValue = await opts.secrets.get(opts.kekName);
  let currentKekRef =
    typeof opts.kekRef === "string" && opts.kekRef.length > 0
      ? opts.kekRef
      : `kek:${opts.kekName}:v1`;
  let currentKekValue = initialKekValue;
  // Retain every KEK value we have ever held, keyed by its ref, so
  // `decryptPayload` can re-derive the wrapping key for records sealed
  // under a now-superseded KEK (CWE-323). Production deployments that
  // restart rehydrate the superseded entries from `retainedKeks` (the
  // secret backend's history), since the registry is otherwise
  // process-local and lost across restarts.
  const kekValuesByRef = new Map<string, string>([[currentKekRef, currentKekValue]]);
  for (const { kekRef, kekValue } of opts.retainedKeks ?? []) {
    // The boot KEK already occupies `currentKekRef`; don't let a stale
    // retained entry shadow it.
    if (!kekValuesByRef.has(kekRef)) {
      kekValuesByRef.set(kekRef, kekValue);
    }
  }

  // Auto-subscribe to rotation events.
  const unsubscribeRotation = opts.secrets.onRotation((event) => {
    if (event.name !== opts.kekName) return;
    void rotateInternal(event.newValue, `kek:${opts.kekName}:${event.rotatedAt}`);
  });
  // Suppress unused-variable warning — unsubscribeRotation is intended
  // for future shutdown plumbing; tests can ignore it.
  void unsubscribeRotation;

  async function readEntry(tenantId: string): Promise<DekEntry | undefined> {
    if (dekStore.getEntry !== undefined) {
      return dekStore.getEntry(tenantId);
    }
    const dek = await dekStore.get(tenantId);
    if (dek === undefined || dek.length !== KEY_BYTES) return undefined;
    return { dek, version: 1, uses: 0 };
  }

  async function writeEntry(tenantId: string, entry: DekEntry): Promise<void> {
    if (dekStore.setEntry !== undefined) {
      await dekStore.setEntry(tenantId, entry);
      return;
    }
    await dekStore.set(tenantId, entry.dek);
  }

  function mintDek(tenantId: string, version: number): DekEntry {
    return { dek: rng(KEY_BYTES), version, uses: 0 };
  }

  async function getOrCreateDek(tenantId: string): Promise<{ dek: Buffer; dekRef: string }> {
    let entry = await readEntry(tenantId);
    if (entry === undefined) {
      entry = mintDek(tenantId, 1);
    } else if (entry.uses >= maxRecordsPerDek) {
      // Roll to a fresh DEK version once the current one is exhausted.
      entry = mintDek(tenantId, entry.version + 1);
    }
    const next: DekEntry = { dek: entry.dek, version: entry.version, uses: entry.uses + 1 };
    await writeEntry(tenantId, next);
    return { dek: next.dek, dekRef: `dek:${tenantId}:v${next.version}` };
  }

  async function rotateInternal(newKekValue: string, newKekRef: string): Promise<void> {
    // Retain the prior KEK value so historical records keep decrypting,
    // then adopt the new one as current.
    kekValuesByRef.set(newKekRef, newKekValue);
    currentKekValue = newKekValue;
    currentKekRef = newKekRef;
    // Re-key every tenant's DEK to a fresh version. Records already on
    // disk keep their old `dekRef`/`kekRef`; subsequent writes use the
    // new DEK version wrapped under the new KEK.
    if (dekStore.tenants !== undefined) {
      const tenants = await dekStore.tenants();
      for (const tenantId of tenants) {
        const entry = await readEntry(tenantId);
        if (entry === undefined) continue;
        await writeEntry(tenantId, mintDek(tenantId, entry.version + 1));
      }
    }
  }

  function deriveForRef(kekRef: string, kekSalt: string | undefined): Buffer {
    const kekValue = kekValuesByRef.get(kekRef);
    if (kekValue === undefined) {
      throw new AuditEncryptionError(
        `no KEK material retained for kekRef ${kekRef}; cannot unwrap DEK`,
      );
    }
    // Legacy records (pre-KDF migration) carry no salt — fall back to the
    // unsalted derivation that originally sealed them.
    if (kekSalt === undefined) {
      return deriveKekKeyLegacy(kekValue);
    }
    return deriveKekKey(kekValue, Buffer.from(kekSalt, "hex"));
  }

  return {
    get kekRef(): string {
      return currentKekRef;
    },
    async encryptPayload(payload: unknown, tenantId: string): Promise<EncryptedRecord> {
      if (typeof tenantId !== "string" || tenantId.length === 0) {
        throw new AuditEncryptionError("tenantId is required");
      }
      const { dek, dekRef } = await getOrCreateDek(tenantId);
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      const iv = rng(IV_BYTES);
      const { ciphertext, tag } = encryptBytes(plaintext, dek, iv);
      // Derive the wrapping key with a fresh per-record salt, then wrap
      // the DEK with the current KEK so we can persist the wrapped form
      // alongside the record (production callers may store the wrapped
      // DEK out-of-band; we include it here for self-contained
      // round-trip).
      const salt = rng(SALT_BYTES);
      const kekKey = deriveKekKey(currentKekValue, salt);
      const dekIv = rng(IV_BYTES);
      const { ciphertext: wrappedDek, tag: wrappedTag } = encryptBytes(dek, kekKey, dekIv);
      return {
        tenantId,
        kekRef: currentKekRef,
        dekRef,
        kekSalt: salt.toString("hex"),
        iv: iv.toString("hex"),
        tag: tag.toString("hex"),
        encryptedPayload: ciphertext.toString("hex"),
        wrappedDek: wrappedDek.toString("hex"),
        wrappedDekIv: dekIv.toString("hex"),
        wrappedDekTag: wrappedTag.toString("hex"),
      };
    },
    async decryptPayload(record: EncryptedRecord): Promise<unknown> {
      // Select the unwrapping KEK by the record's own `kekRef` so records
      // sealed under a superseded KEK still decrypt after rotation.
      const kekKey = deriveForRef(record.kekRef, record.kekSalt);
      const dek = decryptBytes(
        Buffer.from(record.wrappedDek, "hex"),
        kekKey,
        Buffer.from(record.wrappedDekIv, "hex"),
        Buffer.from(record.wrappedDekTag, "hex"),
      );
      const plaintext = decryptBytes(
        Buffer.from(record.encryptedPayload, "hex"),
        dek,
        Buffer.from(record.iv, "hex"),
        Buffer.from(record.tag, "hex"),
      );
      try {
        return JSON.parse(plaintext.toString("utf8"));
      } catch (err) {
        throw new AuditEncryptionError("decrypted payload is not valid JSON", err);
      }
    },
    async rotateKek(newKekValue: string, newKekRef: string): Promise<void> {
      await rotateInternal(newKekValue, newKekRef);
    },
  };
}

export {
  encryptBytes as _encryptBytesForTest,
  decryptBytes as _decryptBytesForTest,
  deriveKekKey as _deriveKekKeyForTest,
  deriveKekKeyLegacy as _deriveKekKeyLegacyForTest,
};
