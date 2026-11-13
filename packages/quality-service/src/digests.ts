/**
 * The digests a change record keeps. Each is a keyed digest (HMAC-SHA256 under the
 * harness's own digest key) over canonical JSON, so no unkeyed hash of a person's
 * content lands in a record that outlives it.
 */
import { canonicalJson } from "@crewhaus/control-contract";
import { ensureDigestKey, keyedDigest } from "@crewhaus/control-records";

/** The labels each digest is taken under. Stored digests join forever: a pin. */
export const PATCH_DIGEST_LABEL = "change-patch";
export const EVIDENCE_DIGEST_LABEL = "change-evidence";
export const BINDING_DIGEST_LABEL = "change-adoption";

/** The harness's digest key, created by the first writer that needs it. */
export async function digestKeyOf(harnessDir: string): Promise<CryptoKey> {
  const key = await ensureDigestKey(harnessDir);
  if (key.state !== "present") {
    throw new Error(`the harness's digest key cannot be read: ${key.reason}`);
  }
  return key.hmac;
}

/** A keyed digest of `value` under `label`. */
export async function keyedJsonDigest(
  key: CryptoKey,
  label: string,
  value: unknown,
): Promise<string> {
  return keyedDigest(key, label, [canonicalJson(value)]);
}
