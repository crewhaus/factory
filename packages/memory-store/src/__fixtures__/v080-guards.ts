/**
 * The 0.8.0 type guards, copied verbatim from `packages/memory-store/src/index.ts`
 * at the `v0.8.0` tag (`git show v0.8.0:packages/memory-store/src/index.ts`). The
 * mixed-versions tests run them over every line kind this release writes, so an
 * older reader on the same file is known to read a successor as an entry, a
 * tombstone as a tombstone, and to skip an annotation. Do not edit the bodies.
 */
import type { MemoryEntry, MemoryProvenance, MemoryTombstone } from "../index";

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const baseOk =
    typeof v["id"] === "string" &&
    typeof v["text"] === "string" &&
    Array.isArray(v["tags"]) &&
    (v["tags"] as unknown[]).every((t) => typeof t === "string") &&
    typeof v["createdAt"] === "string";
  if (!baseOk) return false;
  // Tombstone lines carry `tombstone` + `target` and never the entry base
  // fields, so they can't reach here — but guard anyway.
  if (v["tombstone"] !== undefined) return false;
  // v2 optional fields must be well-typed WHEN PRESENT; a line with a
  // mangled optional field is treated as malformed (skipped), never
  // half-read.
  if (v["schemaVersion"] !== undefined && typeof v["schemaVersion"] !== "number") return false;
  if (v["expiresAt"] !== undefined && typeof v["expiresAt"] !== "number") return false;
  if (v["supersededBy"] !== undefined && typeof v["supersededBy"] !== "string") return false;
  if (v["provenance"] !== undefined && !isProvenance(v["provenance"])) return false;
  return true;
}

function isProvenance(value: unknown): value is MemoryProvenance {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["sessionId"] !== undefined && typeof v["sessionId"] !== "string") return false;
  if (
    v["evidence"] !== undefined &&
    !(
      Array.isArray(v["evidence"]) &&
      (v["evidence"] as unknown[]).every((e) => typeof e === "string")
    )
  ) {
    return false;
  }
  return true;
}

export function isMemoryTombstone(value: unknown): value is MemoryTombstone {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["tombstone"] === "superseded" || v["tombstone"] === "expired") &&
    typeof v["target"] === "string" &&
    typeof v["at"] === "string"
  );
}
