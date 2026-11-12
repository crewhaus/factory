/**
 * `@crewhaus/people/vault`: custody, sealing and forgetting for people profiles (#521,
 * module brief 328). Light and node-only: WebCrypto for every key, the OS credential
 * store through an injected port shaped like `Bun.secrets`, and no package-relative file.
 *
 * First consumer: `@crewhaus/people-service`, which holds the rules, and through it
 * `crewhaus people`.
 */
export {
  type Custodian,
  type KeyRead,
  KEYCHAIN_SERVICE,
  SPACE_KEY_ENV,
  type SecretsPort,
  keyFileOf,
  probeKeychain,
} from "./custody";
export { DOMAIN, KEY_HEX_RE, hexOf, sha256Hex } from "./crypto";
export { DIR_MODE, FILE_MODE, VaultError, type VaultErrorCode, within } from "./files";
export { type RootRefusal, rootRefusal } from "./root";
export {
  type ActivityRow,
  type ClaimConflict,
  type ClaimLine,
  type ClaimRecord,
  type CreatePersonInput,
  ERASURE_NONCE_TTL_MS,
  type ErasureMark,
  type ErasureRow,
  type ExportRow,
  type IndexRow,
  type Inventory,
  type OpenVaultOptions,
  type PersonConflict,
  type RejectedEntry,
  type RotationResult,
  SEGMENT_BYTES,
  type Vault,
  type VaultObservation,
  type VaultStatus,
  type VaultWriter,
  isRootRefusal,
  normalizeNote,
  openVault,
} from "./vault";
