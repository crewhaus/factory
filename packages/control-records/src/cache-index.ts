/**
 * Home's rebuildable read models, under `<hangarRoot>/cache/index/`. Everything here is
 * derived from records and can be deleted at any time: the next projector pass writes it
 * again.
 *
 *   cache/index/<hrn>/<name>.json      one projection of one harness, written whole
 *   cache/index/refs.json              which harnesses a bare id is recorded in
 *   cache/index/fleet.json             `{v: 1, epoch, seq}`: the change log's epoch and its last seq
 *   cache/index/fleet-changes/         the change log: segments of `{seq, epoch, …envelope}` lines
 *   cache/index/<name>/nudge-<hrn>     "project this harness first", from another process
 *
 * Every file is `0600` in `0700` directories, every path contained in the Hangar root.
 * The epoch is a random safe integer minted when `fleet.json` is created, so a deleted
 * index starts a new epoch and a reader's old cursor answers a reset, never a wrong seq.
 */
import { randomInt } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { HARNESS_ID_RE } from "@crewhaus/control-contract";
import {
  type SafeFsFailure,
  ensureDirContained,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { decodeStrict, parseObject, readRecordFile, refusal } from "./io";
import { type LedgerRecord, withLedgerLock } from "./ledger";
import type { Ledger } from "./paths";
import { type DropAnswer, dropSegmentsBefore } from "./retention";
import { listSegments, segmentRel } from "./segments";
import { readTail } from "./tail";

/**
 * The read models' directory, relative to the Hangar root.
 *
 * First consumer: Home's projector and the reads that use its projections.
 */
export const CACHE_INDEX_DIR = join("cache", "index");

/**
 * Names under `cache/index/` that are taken: the change log, its state and the ref index.
 * A projection may not be named one of them, nor like a harness id.
 *
 * First consumer: Home's composition check of the projections areas register.
 */
export const RESERVED_INDEX_NAMES: readonly string[] = Object.freeze([
  "fleet-changes",
  "fleet",
  "refs",
]);

const INDEX_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Whether `name` may name a projection: a lower-case word, not reserved, not a harness id.
 *
 * First consumer: Home's composition check of the projections areas register.
 */
export function isProjectionName(name: string): boolean {
  return (
    INDEX_NAME_RE.test(name) && !RESERVED_INDEX_NAMES.includes(name) && !HARNESS_ID_RE.test(name)
  );
}

export type IndexRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly body: Record<string, unknown> }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * One JSON object under the index, read whole up to `maxBytes`. Creates nothing.
 *
 * First consumer: the reads that use a projection.
 */
export function readIndexRecord(hangarRoot: string, rel: string, maxBytes: number): IndexRead {
  const read = readRecordFile(hangarRoot, join(CACHE_INDEX_DIR, rel), maxBytes);
  if (!read.ok) {
    return read.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: read.reason };
  }
  if (read.truncated)
    return { state: "unreadable", reason: `${rel} is larger than ${maxBytes} bytes` };
  const text = decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  return body === undefined
    ? { state: "unreadable", reason: `${rel} is not a JSON object` }
    : { state: "present", body };
}

/**
 * Write one JSON object under the index, whole and atomically, `0600`.
 *
 * First consumer: Home's projector.
 */
export function writeIndexRecord(
  hangarRoot: string,
  rel: string,
  body: Readonly<Record<string, unknown>>,
): { readonly ok: true } | SafeFsFailure {
  const at = join(CACHE_INDEX_DIR, rel);
  const dir = ensureDirContained(hangarRoot, dirname(at), { mode: 0o700 });
  if (!dir.ok) return dir;
  const written = writeFileSafe(hangarRoot, at, `${JSON.stringify(body)}\n`, {
    overwrite: true,
    mode: 0o600,
  });
  return written.ok ? { ok: true } : written;
}

/**
 * Where one harness's projection is, relative to the index. A name that is not a
 * projection's, or an id that is not a harness's, throws.
 *
 * First consumer: Home's projector.
 */
export function projectionRel(hrn: string, name: string): string {
  if (!HARNESS_ID_RE.test(hrn) || !isProjectionName(name)) {
    throw new TypeError(`control-records: not a projection: ${JSON.stringify([hrn, name])}`);
  }
  return join(hrn, `${name}.json`);
}

// ---------------------------------------------------------------------------
// The fleet change log
// ---------------------------------------------------------------------------

const FLEET_FILE = "fleet.json";
const FLEET_MAX_BYTES = 4096;

/**
 * The change log of the fleet: segments under the index, on their own lock.
 *
 * First consumer: Home's fleet event stream.
 */
export function fleetChangesLedger(hangarRoot: string): Ledger {
  const dir = join(CACHE_INDEX_DIR, "fleet-changes");
  return {
    root: hangarRoot,
    records: { dir },
    lock: join(dir, "lock"),
    claims: join(dir, "claims"),
  };
}

export type FleetState = { readonly v: 1; readonly epoch: number; readonly seq: number };

export type FleetStateRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly fleet: FleetState }
  | { readonly state: "unreadable"; readonly reason: string };

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * `cache/index/fleet.json`, read. Creates nothing.
 *
 * First consumer: Home's fleet event stream.
 */
export function readFleetState(hangarRoot: string): FleetStateRead {
  const read = readIndexRecord(hangarRoot, FLEET_FILE, FLEET_MAX_BYTES);
  if (read.state !== "present") return read;
  const { v, epoch, seq } = read.body;
  if (v !== 1 || !isCount(epoch) || epoch === 0 || !isCount(seq)) {
    return { state: "unreadable", reason: `${FLEET_FILE} is not a fleet record` };
  }
  return { state: "present", fleet: { v: 1, epoch, seq } };
}

/** A new epoch: a random safe integer, never 0. */
function mintEpoch(): number {
  return randomInt(1, 2 ** 47);
}

/** The highest seq the log's newest segment holds for `epoch`, or 0. */
function lastLoggedSeq(ledger: Ledger, epoch: number): number {
  const listed = listSegments(ledger);
  if (!listed.ok) return 0;
  const newest = listed.segs[listed.segs.length - 1];
  if (newest === undefined) return 0;
  const tail = readTail(ledger.root, segmentRel(ledger.records, newest), {
    maxLines: 64,
    maxBytes: 256 * 1024,
  });
  if (tail.state !== "read") return 0;
  let seq = 0;
  for (const record of tail.records) {
    if (record["epoch"] === epoch && isCount(record["seq"])) seq = Math.max(seq, record["seq"]);
  }
  return seq;
}

export type FleetAppend =
  | {
      readonly ok: true;
      readonly epoch: number;
      /** The last seq after this call. */
      readonly seq: number;
      readonly appended: number;
    }
  | SafeFsFailure;

/**
 * Append changes to the fleet's log, each as one line `{seq, epoch, …change}`, under the
 * log's lock: `seq` continues densely from the last one recorded in this epoch, then
 * `fleet.json` records it. A missing `fleet.json` starts a new epoch at seq 1; an
 * unreadable one refuses, and nothing is appended. A change's own `seq`, `epoch` and `id`
 * are not kept.
 *
 * First consumer: Home's projector, once per change it observes.
 */
export async function appendFleetChanges(
  hangarRoot: string,
  changes: readonly LedgerRecord[],
): Promise<FleetAppend> {
  const ledger = fleetChangesLedger(hangarRoot);
  const answer = await withLedgerLock<FleetAppend>(ledger, (lockedAppend) => {
    const read = readFleetState(hangarRoot);
    if (read.state === "unreadable") {
      return refusal("io-error", join(CACHE_INDEX_DIR, FLEET_FILE), read.reason);
    }
    const epoch = read.state === "present" ? read.fleet.epoch : mintEpoch();
    let seq = Math.max(read.state === "present" ? read.fleet.seq : 0, lastLoggedSeq(ledger, epoch));
    const start = seq;
    for (const change of changes) {
      const { seq: _seq, epoch: _epoch, id: _id, ...fields } = change;
      const written = lockedAppend({ seq: seq + 1, epoch, ...fields });
      if (!written.ok) return written;
      seq += 1;
    }
    if (read.state === "present" && seq === read.fleet.seq) {
      return { ok: true, epoch, seq, appended: 0 };
    }
    const saved = writeIndexRecord(hangarRoot, FLEET_FILE, { v: 1, epoch, seq });
    if (!saved.ok) return saved;
    return { ok: true, epoch, seq, appended: seq - start };
  });
  return answer;
}

/**
 * Keep the change log's newest `keep` segments and evict the rest (the watermark first,
 * then the files). A log of `keep` segments or fewer is left as it is.
 *
 * First consumer: Home's projector, after each pass.
 */
export async function keepFleetSegments(hangarRoot: string, keep: number): Promise<DropAnswer> {
  const ledger = fleetChangesLedger(hangarRoot);
  const listed = listSegments(ledger);
  if (!listed.ok) return listed;
  const segs = listed.segs;
  if (segs.length <= keep || keep < 1) return { ok: true, watermark: segs[0] ?? 0, dropped: [] };
  return await dropSegmentsBefore(ledger, segs[segs.length - keep] as number);
}

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

const NUDGE_PREFIX = "nudge-";

/**
 * Ask the projector, from another process, to project `hrn` first on its next pass: an
 * empty `0600` marker `cache/index/<name>/nudge-<hrn>`. Writing it twice is one nudge.
 *
 * First consumer: the CLI's command path, after a harness receipt is written.
 */
export function writeNudgeMarker(
  hangarRoot: string,
  name: string,
  hrn: string,
): { readonly ok: true } | SafeFsFailure {
  if (!isProjectionName(name) || !HARNESS_ID_RE.test(hrn)) {
    return refusal(
      "invalid-path",
      join(CACHE_INDEX_DIR, name),
      "not a projection and a harness id",
    );
  }
  const rel = join(CACHE_INDEX_DIR, name, `${NUDGE_PREFIX}${hrn}`);
  const dir = ensureDirContained(hangarRoot, dirname(rel), { mode: 0o700 });
  if (!dir.ok) return dir;
  const written = writeFileSafe(hangarRoot, rel, "", { overwrite: true, mode: 0o600 });
  return written.ok ? { ok: true } : written;
}

/**
 * The harnesses nudged under these projection names, oldest name first, each once; their
 * markers are removed as they are read. A directory that cannot be listed nudges nothing.
 *
 * First consumer: Home's projector, at the start of a pass.
 */
export function takeNudgeMarkers(hangarRoot: string, names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    if (!isProjectionName(name)) continue;
    const at = resolveContained(hangarRoot, join(CACHE_INDEX_DIR, name), { followLeaf: false });
    if (!at.ok) continue;
    let entries: string[];
    try {
      entries = readdirSync(at.real);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith(NUDGE_PREFIX)) continue;
      const hrn = entry.slice(NUDGE_PREFIX.length);
      if (!HARNESS_ID_RE.test(hrn)) continue;
      out.add(hrn);
      const marker = resolveContained(hangarRoot, join(CACHE_INDEX_DIR, name, entry), {
        followLeaf: false,
      });
      if (!marker.ok) continue;
      try {
        unlinkSync(marker.real);
      } catch {
        // Taken by a racing pass: one nudge either way.
      }
    }
  }
  return [...out];
}
