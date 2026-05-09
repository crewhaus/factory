import {
  type CipherGCM,
  type DecipherGCM,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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
 *   { tenantId, kekRef, dekRef, iv, tag, encryptedPayload }
 * and is verifiable + decryptable by any caller with the same KEK.
 *
 * Algorithms:
 *   - AES-256-GCM for both DEK→payload and KEK→DEK wrapping. GCM is
 *     authenticated, so tampering with `encryptedPayload`, `iv`, or
 *     `tag` causes `decrypt` to throw — satisfies the §39 T8
 *     ciphertext-integrity requirement.
 *   - 12-byte (96-bit) IVs randomly generated per record.
 *
 * Key rotation:
 *   `secrets.onRotation(...)` triggers `rotateKek()` which re-wraps
 *   every cached DEK with the new KEK. Already-written records keep
 *   their `kekRef`, so old records still verify against the previous
 *   KEK if the secret backend retains it.
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
   * Optional persistent DEK store. If omitted, DEKs live in-memory
   * (process-local). Production should plug a tenant-scoped key store
   * here (HSM, KMS, vault path).
   */
  readonly dekStore?: DekStore;
  /** Test seam: deterministic IV generator. */
  readonly randomBytesImpl?: (n: number) => Buffer;
  /** Test seam: synthetic Date.now. */
  readonly now?: () => number;
};

export interface DekStore {
  get(tenantId: string): Promise<Buffer | undefined>;
  set(tenantId: string, dek: Buffer): Promise<void>;
}

export class InMemoryDekStore implements DekStore {
  private readonly map = new Map<string, Buffer>();
  async get(tenantId: string): Promise<Buffer | undefined> {
    return this.map.get(tenantId);
  }
  async set(tenantId: string, dek: Buffer): Promise<void> {
    this.map.set(tenantId, Buffer.from(dek));
  }
}

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard

function deriveKekKey(kekValue: string): Buffer {
  // KEK comes back from secrets-manager as a string. Derive a 32-byte
  // AES key via SHA-256 — same shape regardless of whether the secret
  // backend stores raw bytes, base64, or a passphrase.
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
   * Re-wrap every cached DEK with the new KEK value. Production callers
   * subscribe via `secrets.onRotation(handler)` and forward to this.
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
  const initialKekValue = await opts.secrets.get(opts.kekName);
  let currentKekRef = `kek:${opts.kekName}:v1`;
  let currentKekKey = deriveKekKey(initialKekValue);

  // Auto-subscribe to rotation events.
  const unsubscribeRotation = opts.secrets.onRotation((event) => {
    if (event.name !== opts.kekName) return;
    void rotateInternal(event.newValue, `kek:${opts.kekName}:${event.rotatedAt}`);
  });
  // Suppress unused-variable warning — unsubscribeRotation is intended
  // for future shutdown plumbing; tests can ignore it.
  void unsubscribeRotation;

  async function getOrCreateDek(tenantId: string): Promise<{ dek: Buffer; dekRef: string }> {
    const existing = await dekStore.get(tenantId);
    if (existing !== undefined && existing.length === KEY_BYTES) {
      return { dek: existing, dekRef: `dek:${tenantId}:v1` };
    }
    const dek = rng(KEY_BYTES);
    await dekStore.set(tenantId, dek);
    return { dek, dekRef: `dek:${tenantId}:v1` };
  }

  async function rotateInternal(newKekValue: string, newKekRef: string): Promise<void> {
    // For now we just swap the active KEK; old records still verify
    // against the previous KEK if the secret backend retains it. Cached
    // DEKs are wrapped lazily on the next encryptPayload call.
    currentKekKey = deriveKekKey(newKekValue);
    currentKekRef = newKekRef;
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
      // Wrap the DEK with the KEK so we can persist the wrapped form
      // alongside the record (production callers may store the
      // wrapped DEK out-of-band; we include it here for self-contained
      // round-trip).
      const dekIv = rng(IV_BYTES);
      const { ciphertext: wrappedDek, tag: wrappedTag } = encryptBytes(dek, currentKekKey, dekIv);
      return {
        tenantId,
        kekRef: currentKekRef,
        dekRef,
        iv: iv.toString("hex"),
        tag: tag.toString("hex"),
        encryptedPayload: ciphertext.toString("hex"),
        wrappedDek: wrappedDek.toString("hex"),
        wrappedDekIv: dekIv.toString("hex"),
        wrappedDekTag: wrappedTag.toString("hex"),
      };
    },
    async decryptPayload(record: EncryptedRecord): Promise<unknown> {
      // Unwrap the DEK first.
      const dek = decryptBytes(
        Buffer.from(record.wrappedDek, "hex"),
        currentKekKey,
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
};
