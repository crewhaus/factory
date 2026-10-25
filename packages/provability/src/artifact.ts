/**
 * Proof-artifact identity and shape (design §6.4): one definition of what a
 * `prf_` id is and what a stored artifact must hold, shared by the store
 * (which refuses anything else before a path is built from it) and the
 * `proven` verifier (which refuses anything else before reading a field).
 */
import { randomBytes } from "node:crypto";
import type { ProofArtifact } from "./types";

/** `prf_` and 16 lowercase hex: the only shape a proof id has. */
export const PROOF_ID_REGEX = /^prf_[0-9a-f]{16}$/;

/** Is `id` a proof id (`prf_<16 lowercase hex>`)? */
export function isProofId(id: unknown): id is string {
  return typeof id === "string" && PROOF_ID_REGEX.test(id);
}

/** A fresh proof id: `prf_` and 16 hex characters from the system CSPRNG. */
export function newProofId(): string {
  return `prf_${randomBytes(8).toString("hex")}`;
}

const strings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Does `value` have every field a `ProofArtifact` must, with the right types? */
export function isProofArtifact(value: unknown): value is ProofArtifact {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["version"] === 1 &&
    isProofId(v["id"]) &&
    typeof v["checker"] === "string" &&
    typeof v["claim"] === "string" &&
    typeof v["statement"] === "string" &&
    typeof v["proof"] === "string" &&
    typeof v["ok"] === "boolean" &&
    strings(v["assumptions"]) &&
    strings(v["axioms"]) &&
    typeof v["output"] === "string" &&
    typeof v["outputDigest"] === "string" &&
    typeof v["checkedAt"] === "string" &&
    (v["counterexample"] === undefined || typeof v["counterexample"] === "string") &&
    (v["reason"] === undefined || typeof v["reason"] === "string")
  );
}
