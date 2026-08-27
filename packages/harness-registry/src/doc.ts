/**
 * Tolerant document model for `harnesses.json`: parse-anything reads, a
 * best-effort lift of pre-v2 (watchme-format) documents, unknown-field
 * preservation, stable on-disk sorting, and the small pure helpers behind
 * the read-merge-write loop (id minting, stat fingerprints, sync sleep).
 *
 * Everything here is pure or fs-read-only; all writing lives in
 * `registry.ts` so there is exactly one write path.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  GroupDef,
  HangarHarnessEntry,
  HangarRegistryDoc,
  HarnessOrigin,
  ScanRoot,
} from "./types.js";

export const REGISTRY_FILENAME = "harnesses.json";

/** Shape of a minted harness id: `hrn_` + 16 lowercase hex. */
export const HARNESS_ID_RE = /^hrn_[0-9a-f]{16}$/;

const ORIGINS: readonly HarnessOrigin[] = ["scan", "manual", "run-hook", "import"];

/** Mint a crypto-random id not present in `taken`. */
export function mintHarnessId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `hrn_${randomBytes(8).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** ISO 8601 from an ISO string (kept), an epoch-ms number (lifted — the
 *  watchme v1 timestamp format), or anything else (the fallback). */
const toIso = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
};

export type NormalizeCtx = {
  readonly nowIso: string;
  /** Mint an id for `dir`, avoiding everything in `taken`. */
  readonly mint: (dir: string, taken: Set<string>) => string;
};

/** Normalize one raw harness record; `undefined` for rows with no usable
 *  `dir` (skipped, watchme posture — dropped only when the doc is rewritten). */
function normalizeEntry(
  raw: Record<string, unknown>,
  ctx: NormalizeCtx,
  taken: Set<string>,
  liftingV1: boolean,
): { entry: HangarHarnessEntry; minted: boolean } | undefined {
  const dirRaw = asString(raw["dir"]);
  if (dirRaw === undefined || dirRaw.length === 0) return undefined;
  const dir = resolve(dirRaw);

  const idRaw = asString(raw["id"]);
  const minted = idRaw === undefined || !HARNESS_ID_RE.test(idRaw);
  const id = minted ? ctx.mint(dir, taken) : idRaw;

  const originRaw = raw["origin"];
  const origin: HarnessOrigin = ORIGINS.includes(originRaw as HarnessOrigin)
    ? (originRaw as HarnessOrigin)
    : liftingV1
      ? "import"
      : "manual";
  const originDetail = asString(raw["originDetail"]) ?? (liftingV1 ? "watchme" : "");

  // v1 carried a top-level `share` flag; v2 nests it under `watchme.share`,
  // so a lift moves the flag instead of spreading the stale copy along.
  const watchmeRaw = asRecord(raw["watchme"]);
  const share =
    typeof watchmeRaw?.["share"] === "boolean" ? watchmeRaw["share"] : raw["share"] === true;
  const carried = liftingV1
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "share"))
    : raw;

  const entry: HangarHarnessEntry = {
    ...carried,
    id,
    dir,
    specName: asString(raw["specName"]) ?? basename(dir),
    target: asString(raw["target"]) ?? "unknown",
    origin,
    originDetail,
    registeredAt: toIso(raw["registeredAt"], ctx.nowIso),
    lastSeen: toIso(raw["lastSeen"], ctx.nowIso),
    groups: asStringArray(raw["groups"]),
    tags: asStringArray(raw["tags"]),
    pinned: raw["pinned"] === true,
    hidden: raw["hidden"] === true,
    notes: asString(raw["notes"]) ?? "",
    kind: raw["kind"] === "remote" ? "remote" : "local",
    watchme: { ...watchmeRaw, share },
    remotes: Array.isArray(raw["remotes"])
      ? raw["remotes"].filter(
          (item): item is Record<string, unknown> => asRecord(item) !== undefined,
        )
      : [],
    missingSince: asString(raw["missingSince"]) ?? null,
  };
  return { entry, minted };
}

function normalizeScanRoot(raw: Record<string, unknown>): ScanRoot | undefined {
  const dirRaw = asString(raw["dir"]);
  if (dirRaw === undefined || dirRaw.length === 0) return undefined;
  return {
    ...raw,
    dir: resolve(dirRaw),
    depth: typeof raw["depth"] === "number" ? raw["depth"] : 6,
    auto: raw["auto"] !== false,
    rescanIntervalMin: typeof raw["rescanIntervalMin"] === "number" ? raw["rescanIntervalMin"] : 15,
    lastScanAt: asString(raw["lastScanAt"]) ?? null,
  };
}

function normalizeGroupDef(raw: Record<string, unknown>, index: number): GroupDef | undefined {
  const name = asString(raw["name"]);
  if (name === undefined || name.length === 0) return undefined;
  return {
    ...raw,
    name,
    order: typeof raw["order"] === "number" ? raw["order"] : index + 1,
    color: asString(raw["color"]) ?? "",
  };
}

export const EMPTY_DOC: HangarRegistryDoc = { v: 2, harnesses: [], scanRoots: [], groups: [] };

/**
 * Normalize a parsed document. `lifted` reports whether persisting the
 * normalized form would change the file in a schema-meaningful way (pre-v2
 * document, or entries that needed an id minted) — the signal `list()` uses
 * to heal the file on read.
 */
export function normalizeDoc(
  rawUnknown: unknown,
  ctx: NormalizeCtx,
): { doc: HangarRegistryDoc; lifted: boolean } {
  const raw = asRecord(rawUnknown) ?? {};
  const liftingV1 = raw["v"] !== 2;

  const rawHarnesses = Array.isArray(raw["harnesses"]) ? raw["harnesses"] : [];
  // Pre-collect valid ids so minting never collides with a later row.
  const taken = new Set<string>();
  for (const rec of rawHarnesses) {
    const id = asRecord(rec)?.["id"];
    if (typeof id === "string" && HARNESS_ID_RE.test(id)) taken.add(id);
  }
  let minted = false;
  const byDir = new Map<string, HangarHarnessEntry>();
  for (const rec of rawHarnesses) {
    const record = asRecord(rec);
    if (record === undefined) continue;
    const normalized = normalizeEntry(record, ctx, taken, liftingV1);
    if (normalized === undefined) continue;
    minted = minted || normalized.minted;
    byDir.set(normalized.entry.dir, normalized.entry); // last-wins per dir
  }

  const scanRoots: ScanRoot[] = [];
  if (Array.isArray(raw["scanRoots"])) {
    for (const rec of raw["scanRoots"]) {
      const record = asRecord(rec);
      const normalized = record === undefined ? undefined : normalizeScanRoot(record);
      if (normalized !== undefined) scanRoots.push(normalized);
    }
  }

  const groups: GroupDef[] = [];
  if (Array.isArray(raw["groups"])) {
    let index = 0;
    for (const rec of raw["groups"]) {
      const record = asRecord(rec);
      const normalized = record === undefined ? undefined : normalizeGroupDef(record, index);
      if (normalized !== undefined) {
        groups.push(normalized);
        index += 1;
      }
    }
  }

  const doc: HangarRegistryDoc = {
    ...raw,
    v: 2,
    harnesses: [...byDir.values()],
    scanRoots,
    groups,
  };
  return { doc, lifted: liftingV1 || minted };
}

/** Stable on-disk ordering: harnesses/scanRoots by dir, groups by order. */
export function sortDoc(doc: HangarRegistryDoc): HangarRegistryDoc {
  return {
    ...doc,
    harnesses: [...doc.harnesses].sort((a, b) => a.dir.localeCompare(b.dir)),
    scanRoots: [...doc.scanRoots].sort((a, b) => a.dir.localeCompare(b.dir)),
    groups: [...doc.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
  };
}

/**
 * Cheap change fingerprint of the registry file (inode + mtime + size,
 * bigint stats). Compared before a rename lands to detect a concurrent
 * writer; `"absent"` when the file does not exist.
 */
export function fingerprintPath(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch {
    return "absent";
  }
}

/** Synchronous sleep for retry backoff (runtime-neutral, no busy loop). */
export function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
