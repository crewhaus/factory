/**
 * Where a spec's fact store keeps its locks and its archive, and what an archived line is:
 * shared by the store and its erasure, so both hold the same locks over the same files.
 * Internal to this package.
 */
import { join, resolve } from "node:path";
import type { Ledger } from "@crewhaus/control-records";
import type { MemoryArchivedLine } from "./index";

/** The archive's segment names: six digits and `.jsonl`. */
export const ARCHIVE_SEGMENT_RE = /^\d{6}\.jsonl$/;

export type MemoryLayout = {
  /** `<spec>.jsonl`, the live file. */
  readonly fileName: string;
  /** `.<spec>.lock`, the fact lock. */
  readonly lockName: string;
  /** `archive/<spec>`, relative to the root. */
  readonly archiveDir: string;
  /** The fact lock, on control-records' one lock policy. */
  readonly ledger: Ledger;
  /** The archive's own lock, `archive/<spec>/.lock`. */
  readonly archiveLedger: Ledger;
};

export function memoryLayout(rootDir: string, specName: string): MemoryLayout {
  const archiveDir = join("archive", specName);
  const lockName = `.${specName}.lock`;
  const shared = {
    root: resolve(rootDir),
    records: { dir: archiveDir },
    // Never written: the archive takes no claims.
    claims: join(archiveDir, ".claims"),
  };
  return {
    fileName: `${specName}.jsonl`,
    lockName,
    archiveDir,
    ledger: { ...shared, lock: lockName },
    archiveLedger: { ...shared, lock: join(archiveDir, ".lock") },
  };
}

export function isArchivedLine(value: unknown): value is MemoryArchivedLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    typeof v["archivedAt"] === "string" &&
    v["cause"] === "compaction" &&
    (v["line"] !== undefined || typeof v["raw"] === "string")
  );
}
