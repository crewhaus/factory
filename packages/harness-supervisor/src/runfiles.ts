/**
 * `<harness>/.crewhaus/run/` — the ops-state tree.
 *
 * ```
 * .crewhaus/run/
 *   daemon.json          the singleton runfile (atomic tmp+rename, 0600)
 *   runs.jsonl           append-only run ledger (open record + close patch)
 *   logs/<runId>.log     captured child stdout+stderr
 *   logs/<runId>.events.jsonl   extracted TraceEvents (scrubbed)
 *   logs/<runId>.cursor  the pump's byte-exact resume point
 *   control-token        minted control.v1 bearer, 0600
 * ```
 *
 * Everything is harness-local on purpose: `state backup` and `retire`
 * capture ops history without knowing it exists, and a harness moved to
 * another machine carries its own run history. The manager keeps pointers,
 * never the record.
 *
 * The ledger never rewrites a line in place. A run is OPENED with a full
 * record and CLOSED by appending a partial record with the same `runId`;
 * readers fold by `runId` with later-wins. A manager killed mid-run
 * therefore leaves an open entry, not a corrupt file. The one exception is
 * retention compaction, which rewrites the whole file atomically — safe
 * because the supervisor is the single writer of this directory.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  CONTROL_TOKEN_NAME,
  DEFAULT_RETENTION,
  type DaemonRunfile,
  LOGS_DIR_NAME,
  RUNFILE_NAME,
  RUNFILE_VERSION,
  RUN_DIR_SEGMENTS,
  RUN_LEDGER_NAME,
  type RetentionPolicy,
  type RunLedgerEntry,
  type RunLedgerPatch,
  START_LOCK_NAME,
  type StartLock,
} from "./types";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `<harness>/.crewhaus/run`. */
export function runDir(harnessDir: string): string {
  return join(harnessDir, ...RUN_DIR_SEGMENTS);
}

/** `<harness>/.crewhaus/run/logs`. */
export function logsDir(harnessDir: string): string {
  return join(runDir(harnessDir), LOGS_DIR_NAME);
}

/** `<harness>/.crewhaus/run/logs/<runId>.log`. */
export function runLogPath(harnessDir: string, runId: string): string {
  return join(logsDir(harnessDir), `${runId}.log`);
}

/** The durable extracted-events file for a run. */
export function runEventsPath(harnessDir: string, runId: string): string {
  return join(logsDir(harnessDir), `${runId}.events.jsonl`);
}

/** The pump's resume cursor for a run. */
export function runCursorPath(harnessDir: string, runId: string): string {
  return join(logsDir(harnessDir), `${runId}.cursor`);
}

/** `<harness>/.crewhaus/run/control-token`. */
export function controlTokenPath(harnessDir: string): string {
  return join(runDir(harnessDir), CONTROL_TOKEN_NAME);
}

/** `<harness>/.crewhaus/run/daemon.json`. */
export function runfilePath(harnessDir: string): string {
  return join(runDir(harnessDir), RUNFILE_NAME);
}

/** True when a runfile exists at all — the cheap check before the parse. */
export function runfileExists(harnessDir: string): boolean {
  return existsSync(runfilePath(harnessDir));
}

/** `<harness>/.crewhaus/run/daemon.lock`. */
export function startLockPath(harnessDir: string): string {
  return join(runDir(harnessDir), START_LOCK_NAME);
}

/** Create the run tree (0700 dirs). Idempotent. */
export function ensureRunDir(harnessDir: string): string {
  const dir = runDir(harnessDir);
  mkdirSync(join(dir, LOGS_DIR_NAME), { recursive: true, mode: 0o700 });
  return dir;
}

/** Run ids are `run_<16 hex>` — the same SAFE_ID shape the server's path
 *  guards accept, so a runId can be a URL segment without further checks. */
export const RUN_ID_RE = /^run_[0-9a-f]{16}$/;

/** Mint a run id. `randomHex` is injected in tests for determinism. */
export function newRunId(randomHex: () => string = defaultRandomHex): string {
  return `run_${randomHex()}`;
}

function defaultRandomHex(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// The runfile
// ---------------------------------------------------------------------------

function atomicWrite(path: string, text: string, mode: number): void {
  // Same-directory tmp + rename: a reader either sees the old file or the
  // new one, never a half-written one.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

/** Write `daemon.json` atomically, 0600. */
export function writeRunfile(harnessDir: string, runfile: DaemonRunfile): void {
  ensureRunDir(harnessDir);
  atomicWrite(
    join(runDir(harnessDir), RUNFILE_NAME),
    `${JSON.stringify(runfile, null, 2)}\n`,
    0o600,
  );
}

/**
 * Read `daemon.json`. Absent, unreadable, unparseable, or shape-invalid all
 * read as "no runfile" — a corrupt runfile must never wedge a harness shut,
 * and the caller's next start simply overwrites it.
 */
export function readRunfile(harnessDir: string): DaemonRunfile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(runDir(harnessDir), RUNFILE_NAME), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pid = r["pid"];
  const startTime = r["pidStartTimeMs"];
  const fingerprint = r["argvFingerprint"];
  if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
  if (typeof startTime !== "number") return undefined;
  if (typeof fingerprint !== "string") return undefined;
  const num = (key: string): number | undefined => {
    const v = r[key];
    return typeof v === "number" && Number.isInteger(v) ? v : undefined;
  };
  const str = (key: string): string | undefined => {
    const v = r[key];
    return typeof v === "string" ? v : undefined;
  };
  return {
    // Migrate-on-read: a version-less runfile from an older manager is v1.
    v: num("v") ?? RUNFILE_VERSION,
    pid,
    pidStartTimeMs: startTime,
    argvFingerprint: fingerprint,
    ...(num("port") !== undefined ? { port: num("port") as number } : {}),
    ...(num("gatewayPort") !== undefined ? { gatewayPort: num("gatewayPort") as number } : {}),
    ...(num("controlPort") !== undefined ? { controlPort: num("controlPort") as number } : {}),
    ...(str("controlTokenPath") !== undefined
      ? { controlTokenPath: str("controlTokenPath") as string }
      : {}),
    entry: str("entry") ?? "",
    bundleDir: str("bundleDir") ?? "",
    runId: str("runId") ?? "",
    startedAt: str("startedAt") ?? "",
    managerVersion: str("managerVersion") ?? "",
    // Names only — how an adopting manager rebuilds the scrubber the
    // spawning one used. Dropping these on read is what let a
    // `process.env`-sourced secret go unscrubbed after a restart.
    ...(Array.isArray(r["scrubKeys"])
      ? {
          scrubKeys: (r["scrubKeys"] as unknown[]).filter(
            (k): k is string => typeof k === "string",
          ),
        }
      : {}),
  };
}

/** Remove `daemon.json` (a clean stop). Missing file is success. */
export function clearRunfile(harnessDir: string): void {
  try {
    rmSync(join(runDir(harnessDir), RUNFILE_NAME));
  } catch {
    // Never existed, or a sibling already cleaned it up.
  }
}

// ---------------------------------------------------------------------------
// The start lock
// ---------------------------------------------------------------------------

/**
 * `daemon.lock` — the claim on the daemon SLOT while a start is in flight.
 *
 * The runfile cannot be that claim: it records a pid, and there is no pid
 * until the spawn. Everything between the liveness check and the spawn —
 * the whole preflight run, which parses the spec and probes live ports — sat
 * inside that gap, so two managers starting the same harness within the same
 * second both read "no runfile", both passed preflight, and both spawned.
 *
 * `O_EXCL` create is atomic across processes, so exactly one starter wins.
 * The holder's pid + OS start time are recorded so a lock left behind by a
 * killed manager is BREAKABLE rather than a permanent wedge (see
 * {@link startLockIsStale}), and the winner removes it on every path out of
 * `start()`.
 */
export function acquireStartLock(harnessDir: string, lock: StartLock): boolean {
  ensureRunDir(harnessDir);
  let fd: number;
  try {
    // wx: create-or-fail. This is the whole mutual exclusion.
    fd = openSync(startLockPath(harnessDir), "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${JSON.stringify(lock)}\n`);
  } catch {
    // The lock is held either way; its contents are only used for staleness.
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Read `daemon.lock`. Absent/corrupt reads as "no lock". */
export function readStartLock(harnessDir: string): StartLock | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(startLockPath(harnessDir), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const pid = r["pid"];
  const at = r["at"];
  if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
  if (typeof at !== "number") return undefined;
  const startTime = r["pidStartTimeMs"];
  return {
    pid,
    at,
    ...(typeof startTime === "number" ? { pidStartTimeMs: startTime } : {}),
  };
}

/** Release `daemon.lock`. Missing file is success. */
export function releaseStartLock(harnessDir: string): void {
  try {
    rmSync(startLockPath(harnessDir));
  } catch {
    // Never existed, or a sibling already broke it.
  }
}

/** How long a start lock may be held before it is assumed abandoned. Longer
 *  than any preflight run (spec parse + live port probes), short enough that
 *  a manager killed mid-start never wedges a harness for an operator. */
export const START_LOCK_MAX_AGE_MS = 120_000;

/**
 * True when a held lock may be broken: the holder is gone, the holder's pid
 * was recycled (start time moved), or the lock has simply been sitting there
 * longer than any start can legitimately take.
 */
export function startLockIsStale(
  lock: StartLock | undefined,
  probe: {
    readonly isAlive: (pid: number) => boolean;
    readonly startTimeMs: (pid: number) => number | undefined;
  },
  now: number,
  maxAgeMs: number = START_LOCK_MAX_AGE_MS,
  toleranceMs = 2_000,
): boolean {
  if (lock === undefined) return true;
  if (now - lock.at > maxAgeMs) return true;
  if (!probe.isAlive(lock.pid)) return true;
  if (lock.pidStartTimeMs !== undefined) {
    const observed = probe.startTimeMs(lock.pid);
    // Unknown start time errs toward "held": refusing a start is safer than
    // stealing the slot from a manager that is really there.
    if (observed !== undefined && Math.abs(observed - lock.pidStartTimeMs) > toleranceMs) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The run ledger
// ---------------------------------------------------------------------------

/** Append the opening record for a run. */
export function appendRunLedger(harnessDir: string, entry: RunLedgerEntry): void {
  ensureRunDir(harnessDir);
  appendFileSync(join(runDir(harnessDir), RUN_LEDGER_NAME), `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
  });
}

/** Append a closing/annotating patch for an existing run. */
export function patchRunLedger(harnessDir: string, patch: RunLedgerPatch): void {
  ensureRunDir(harnessDir);
  appendFileSync(join(runDir(harnessDir), RUN_LEDGER_NAME), `${JSON.stringify(patch)}\n`, {
    mode: 0o600,
  });
}

/**
 * Read the ledger, folded by `runId` (later lines win) and ordered by first
 * appearance. Torn lines are skipped, never fatal — a manager killed
 * mid-append leaves a partial final line and the rest of the history must
 * still read.
 */
export function readRunLedger(harnessDir: string): RunLedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(join(runDir(harnessDir), RUN_LEDGER_NAME), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, RunLedgerEntry>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // torn line — skip it, keep reading
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const runId = rec["runId"];
    if (typeof runId !== "string" || runId === "") continue;
    const prior = byId.get(runId);
    byId.set(runId, {
      ...(prior ?? ({ runId } as RunLedgerEntry)),
      ...(rec as object),
    } as RunLedgerEntry);
  }
  return [...byId.values()];
}

/** The most recent ledger entries, newest last (file order). */
export function recentRuns(harnessDir: string, limit: number): RunLedgerEntry[] {
  const all = readRunLedger(harnessDir);
  return limit >= all.length ? all : all.slice(all.length - limit);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Read `manager.logRetention` from `<harness>/.crewhaus/settings.json`,
 * falling back to the defaults (20 runs / 50 MB). Any read or shape problem
 * degrades to the defaults — retention is never a reason to refuse a spawn.
 */
export function readRetentionPolicy(
  harnessDir: string,
  defaults: RetentionPolicy = DEFAULT_RETENTION,
): RetentionPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(harnessDir, ".crewhaus", "settings.json"), "utf8"));
  } catch {
    return defaults;
  }
  const manager = (raw as Record<string, unknown> | null)?.["manager"];
  const retention = (manager as Record<string, unknown> | undefined)?.["logRetention"];
  if (typeof retention !== "object" || retention === null) return defaults;
  const r = retention as Record<string, unknown>;
  const runs =
    typeof r["runs"] === "number" && r["runs"] > 0 ? Math.floor(r["runs"]) : defaults.runs;
  const bytes =
    typeof r["bytes"] === "number" && r["bytes"] > 0 ? Math.floor(r["bytes"]) : defaults.bytes;
  return { runs, bytes };
}

export type PruneResult = {
  /** Run ids whose captured files were removed. */
  readonly removedRuns: readonly string[];
  readonly removedBytes: number;
  /** True when the ledger was compacted to the retained window. */
  readonly compactedLedger: boolean;
};

/** Compact the ledger once it holds this many times the retained runs. */
const LEDGER_COMPACT_FACTOR = 3;

/**
 * Enforce retention over `logs/`: keep the newest `policy.runs` runs, and
 * drop further runs from the oldest end until the retained log bytes fit
 * `policy.bytes`. A run's `.log`, `.events.jsonl`, and `.cursor` files are
 * removed together — they are one artifact.
 *
 * `keepRunIds` protects live runs from a prune triggered by a burst of
 * short-lived siblings.
 */
export function pruneRuns(
  harnessDir: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  keepRunIds: readonly string[] = [],
): PruneResult {
  const dir = logsDir(harnessDir);
  if (!existsSync(dir)) return { removedRuns: [], removedBytes: 0, compactedLedger: false };
  const ledger = readRunLedger(harnessDir);
  // Ledger order is authoritative (append order = chronological); runs with
  // captured files but no ledger entry sort first (older/orphaned).
  const ledgerOrder = new Map(ledger.map((e, i) => [e.runId, i]));
  const sizes = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { removedRuns: [], removedBytes: 0, compactedLedger: false };
  }
  for (const name of names) {
    const runId = runIdOfCaptureFile(name);
    if (runId === undefined) continue;
    let size = 0;
    try {
      size = statSync(join(dir, name)).size;
    } catch {
      size = 0;
    }
    sizes.set(runId, (sizes.get(runId) ?? 0) + size);
  }
  const ordered = [...sizes.keys()].sort(
    (a, b) => (ledgerOrder.get(a) ?? -1) - (ledgerOrder.get(b) ?? -1),
  );
  const protectedIds = new Set(keepRunIds);
  const evict: string[] = [];
  // Count cap: everything beyond the newest `policy.runs`.
  const overflow = Math.max(0, ordered.length - policy.runs);
  for (let i = 0; i < overflow; i++) {
    const id = ordered[i];
    if (id !== undefined && !protectedIds.has(id)) evict.push(id);
  }
  // Byte cap: keep dropping from the oldest retained end.
  let retainedBytes = ordered
    .filter((id) => !evict.includes(id))
    .reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
  for (const id of ordered) {
    if (retainedBytes <= policy.bytes) break;
    if (evict.includes(id) || protectedIds.has(id)) continue;
    evict.push(id);
    retainedBytes -= sizes.get(id) ?? 0;
  }

  let removedBytes = 0;
  for (const id of evict) {
    for (const suffix of [".log", ".events.jsonl", ".cursor"]) {
      const path = join(dir, `${id}${suffix}`);
      try {
        removedBytes += statSync(path).size;
        rmSync(path);
      } catch {
        // Absent sibling file — nothing to remove.
      }
    }
  }

  let compactedLedger = false;
  if (evict.length > 0 && ledger.length > policy.runs * LEDGER_COMPACT_FACTOR) {
    const evicted = new Set(evict);
    const kept = ledger.filter((e) => !evicted.has(e.runId));
    atomicWrite(
      join(runDir(harnessDir), RUN_LEDGER_NAME),
      kept.map((e) => `${JSON.stringify(e)}\n`).join(""),
      0o600,
    );
    compactedLedger = true;
  }
  return { removedRuns: evict, removedBytes, compactedLedger };
}

/** `run_x.log` / `run_x.events.jsonl` / `run_x.cursor` → `run_x`. */
function runIdOfCaptureFile(name: string): string | undefined {
  for (const suffix of [".events.jsonl", ".cursor", ".log"]) {
    if (name.endsWith(suffix)) {
      const id = name.slice(0, -suffix.length);
      return RUN_ID_RE.test(id) ? id : undefined;
    }
  }
  return undefined;
}
