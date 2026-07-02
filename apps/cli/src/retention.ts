import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import {
  type PurgeResult,
  RETENTION_CONFIG_RELPATH,
  type RecordStore,
  type RetentionConfig,
  RetentionConfigError,
  type RetentionRecord,
  SESSION_ID_REGEX,
  createDataRetentionEngine,
  loadRetentionConfig,
} from "@crewhaus/data-retention-engine";
import { createSessionStore } from "@crewhaus/session-store";

// Config loading lives in @crewhaus/data-retention-engine (retention-config.ts)
// so the daemon janitors read the IDENTICAL policy this CLI enforces
// (ops-review F2). Re-exported here so callers/tests of this module keep one
// import surface.
export {
  DEFAULT_SESSION_MAX_AGE_DAYS,
  RETENTION_CONFIG_RELPATH,
  type RetentionAuditWindowConfig,
  type RetentionConfig,
  RetentionConfigError,
  loadRetentionConfig,
} from "@crewhaus/data-retention-engine";

/**
 * Item 35 — `crewhaus retention sweep|export|purge` plumbing, factored out of
 * the entry file `index.ts` (which runs a top-level argv switch and so cannot
 * be imported by a test without executing the CLI). Side-effect-free on
 * import and directly unit-testable, mirroring `audit-verify.ts` /
 * `compliance-schedule.ts`. The exported `runRetentionSweep` /
 * `runRetentionExport` / `runRetentionPurge` are plain library functions so a
 * future daemon janitor can call them without the CLI (no boot wiring here).
 *
 * What this module wires together:
 *
 *   1. `HarnessRecordStore` — a `@crewhaus/data-retention-engine` RecordStore
 *      adapter over the two real on-disk stores of a harness directory:
 *        - `.crewhaus/sessions` (`@crewhaus/session-store`): one record per
 *          `sess_<16 hex>.json`. `createdAt` is the file MTIME — the exact
 *          eviction key session-store's `list()` uses — and deletion goes
 *          through `sessionStore.delete()` so the sibling `<id>.jsonl` event
 *          log is unlinked too. The sweep therefore makes session TTL
 *          eviction happen on a schedule instead of only as a `list()` side
 *          effect, under the same rules.
 *        - `.crewhaus/audit` (`@crewhaus/audit-log`): one record per UTC
 *          day file (`YYYY-MM-DD.jsonl`), NEVER individual records — and in
 *          fact never deleted at all; see AUDIT_CHAIN_EXCLUSION_REASON.
 *
 *   2. `.crewhaus/retention.json` — the engine's policies/windows/pins are
 *      purely programmatic (in-memory maps on the engine instance), so the
 *      config file is read via `@crewhaus/data-retention-engine`'s exported
 *      `loadRetentionConfig` (schema + safety stance live there, in
 *      retention-config.ts; the daemon janitors read the SAME file with the
 *      SAME parser). `sessions.maxAgeDays` becomes an engine `retain()`
 *      policy, `pins` become adapter deletion refusals, and `auditWindows`
 *      become `addAuditWindow()` registrations (already-expired entries are
 *      ignored).
 *
 *   3. Evidence: every REAL (non-dry-run) sweep/export/purge appends one
 *      `retention_enforcement` record to `.crewhaus/audit` — the same
 *      hash-chained store the `run` justification gate writes — so retention
 *      enforcement is itself tamper-evidenced. Dry runs append nothing. A
 *      no-op run against a directory with no existing audit store also
 *      appends nothing: fabricating `.crewhaus/audit` just to log that
 *      nothing happened would litter arbitrary directories (ops-review F8b).
 *
 * Tenancy: `AuditRecord` carries no tenantId and sessions are per-directory,
 * so everything here operates on the single local tenant (`LOCAL_TENANT`).
 * A `--tenant` surface is deferred until the stores are tenant-scoped.
 *
 * Safety stance: when in doubt (unrecognised filename, unparseable day label,
 * orphaned event log), SKIP the entry and report it — never delete.
 */

const SESSIONS_RELPATH = ".crewhaus/sessions";
const AUDIT_RELPATH = ".crewhaus/audit";

/** Single-tenant placeholder: the on-disk stores carry no tenant ids. */
export const LOCAL_TENANT = "local";

const MS_PER_DAY = 86_400_000;
/**
 * `defaultRetentionDays` for kinds WITHOUT an explicit policy (i.e. anything
 * but "session"): effectively never — an unconfigured kind must not be
 * deletable by accident. ~100 years.
 */
const NEVER_EXPIRE_DAYS = 36_500;

const AUDIT_DAY_FILE_REGEX = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const CHAIN_TAIL_FILENAME = "_chain-tail.json";

/**
 * Why NO audit data — not individual records, not whole day files — is ever
 * deleted by retention. Kept as an exported constant so the report, the
 * adapter refusal, and the tests all cite the same rationale.
 */
export const AUDIT_CHAIN_EXCLUSION_REASON =
  "audit chain integrity — @crewhaus/audit-log verify() walks every day file as ONE " +
  "hash chain (prevHash from GENESIS in the oldest file, seq gapless from 0 across " +
  "files), so deleting any record OR any whole day file — even the oldest — breaks " +
  "verification of every surviving record after the gap";

/** Thrown by `parseRetentionDate` on an unparseable `--since`/`--before`. */
export class InvalidRetentionDateError extends Error {
  override readonly name = "InvalidRetentionDateError";
  constructor(flag: string, value: string) {
    super(
      `invalid ${flag} "${value}" — expected an ISO date (YYYY-MM-DD) or datetime (e.g. 2026-07-01T00:00:00Z)`,
    );
  }
}

/** Parse a `--since`/`--before` flag value to epoch ms (UTC for bare dates). */
export function parseRetentionDate(flag: string, value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new InvalidRetentionDateError(flag, value);
  return ms;
}

export type SkippedEntry = { readonly path: string; readonly reason: string };
export type DeletionEntry = { readonly id: string; readonly paths: ReadonlyArray<string> };
export type RefusalEntry = { readonly id: string; readonly reason: string };

type SessionInventoryEntry = {
  readonly record: RetentionRecord;
  readonly sessionId: string;
  readonly jsonPath: string;
  /** Present when the sibling `<id>.jsonl` event log exists. */
  readonly eventLogPath?: string;
};

type AuditInventoryEntry = {
  readonly record: RetentionRecord;
  readonly day: string;
  readonly path: string;
};

/**
 * RecordStore adapter over `<rootDir>/.crewhaus/sessions` +
 * `<rootDir>/.crewhaus/audit`. The inventory is a snapshot taken by
 * `openHarnessRecordStore` (a sweep operates on the state it observed at
 * start). Deletions are tracked for reporting; in `dryRun` mode `delete()`
 * makes the same decision (and records it) without touching the disk, so the
 * engine's counters mirror a real run exactly.
 */
export class HarnessRecordStore implements RecordStore {
  readonly sessions: ReadonlyArray<SessionInventoryEntry>;
  readonly auditDays: ReadonlyArray<AuditInventoryEntry>;
  readonly skipped: ReadonlyArray<SkippedEntry>;
  readonly deletions: DeletionEntry[] = [];
  readonly refusals: RefusalEntry[] = [];

  private readonly byId: ReadonlyMap<string, SessionInventoryEntry | AuditInventoryEntry>;
  private readonly pins: ReadonlySet<string>;
  private readonly dryRun: boolean;
  private readonly sessionsDir: string;

  constructor(opts: {
    readonly sessionsDir: string;
    readonly sessions: ReadonlyArray<SessionInventoryEntry>;
    readonly auditDays: ReadonlyArray<AuditInventoryEntry>;
    readonly skipped: ReadonlyArray<SkippedEntry>;
    readonly pins: ReadonlyArray<string>;
    readonly dryRun: boolean;
  }) {
    this.sessionsDir = opts.sessionsDir;
    this.sessions = opts.sessions;
    this.auditDays = opts.auditDays;
    this.skipped = opts.skipped;
    this.pins = new Set(opts.pins);
    this.dryRun = opts.dryRun;
    const byId = new Map<string, SessionInventoryEntry | AuditInventoryEntry>();
    for (const s of opts.sessions) byId.set(s.record.id, s);
    for (const a of opts.auditDays) byId.set(a.record.id, a);
    this.byId = byId;
  }

  async *listAll(): AsyncIterable<RetentionRecord> {
    for (const s of this.sessions) yield s.record;
    for (const a of this.auditDays) yield a.record;
  }

  async *listByTenant(tenantId: string): AsyncIterable<RetentionRecord> {
    for await (const r of this.listAll()) {
      if (r.tenantId === tenantId) yield r;
    }
  }

  async delete(id: string): Promise<boolean> {
    // GRANULARITY CONSTRAINT (enforced here, the single deletion choke
    // point): audit data is NEVER deleted by retention — not individual
    // records, not whole `YYYY-MM-DD.jsonl` day files. `verify()` in
    // @crewhaus/audit-log walks every day file in sorted order as ONE hash
    // chain: `prevHash` starts at GENESIS in the OLDEST file and `seq` must
    // be gapless from 0 across files, so removing even the oldest whole day
    // file leaves the next surviving record with prevHash != GENESIS and
    // seq != 0 — verify() then fails on the FIRST surviving line and the
    // entire remaining log is unverifiable. Until audit-log grows a
    // chain-aware archival/re-anchor operation, retention treats
    // `.crewhaus/audit` as read-only: enumerate + export, never delete.
    if (id.startsWith("audit:")) {
      this.refusals.push({ id, reason: AUDIT_CHAIN_EXCLUSION_REASON });
      return false;
    }
    const entry = this.byId.get(id);
    if (entry === undefined || !("sessionId" in entry)) return false;
    if (this.pins.has(entry.sessionId)) {
      this.refusals.push({ id, reason: `pinned in ${RETENTION_CONFIG_RELPATH}` });
      return false;
    }
    const paths = [
      entry.jsonPath,
      ...(entry.eventLogPath !== undefined ? [entry.eventLogPath] : []),
    ];
    this.deletions.push({ id, paths });
    if (!this.dryRun) {
      // Reuse session-store's own deletion (id validation + unlink of both
      // the session file AND the sibling event log) instead of re-implementing
      // its eviction rules.
      await createSessionStore({ rootDir: this.sessionsDir }).delete(entry.sessionId);
    }
    return true;
  }
}

/** `YYYY-MM-DD` → epoch ms of the LAST instant of that UTC day, so a day
 *  file only counts as expired once its newest possible record is. Returns
 *  undefined for a label that doesn't round-trip (e.g. `2026-13-40`). */
function endOfUtcDayMs(y: string, m: string, d: string): number | undefined {
  const startMs = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const roundTrip = new Date(startMs).toISOString().slice(0, 10);
  if (roundTrip !== `${y}-${m}-${d}`) return undefined;
  return startMs + MS_PER_DAY - 1;
}

export type OpenHarnessRecordStoreOptions = {
  readonly rootDir: string;
  readonly pins?: ReadonlyArray<string>;
  readonly dryRun?: boolean;
};

/**
 * Snapshot the two stores under `rootDir` into a `HarnessRecordStore`.
 * Anything unrecognised is SKIPPED with a reason, never deleted:
 * `.tmp` leftovers, non-`sess_` filenames, orphaned event logs (a
 * `<id>.jsonl` without its `<id>.json`), and non-day files in the audit dir.
 */
export async function openHarnessRecordStore(
  opts: OpenHarnessRecordStoreOptions,
): Promise<HarnessRecordStore> {
  const sessionsDir = join(opts.rootDir, SESSIONS_RELPATH);
  const auditDir = join(opts.rootDir, AUDIT_RELPATH);
  const skipped: SkippedEntry[] = [];
  const sessions: SessionInventoryEntry[] = [];
  const auditDays: AuditInventoryEntry[] = [];

  let sessionEntries: string[] = [];
  try {
    sessionEntries = await readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const sessionEntrySet = new Set(sessionEntries);
  for (const entry of sessionEntries.sort()) {
    const full = join(sessionsDir, entry);
    if (entry.endsWith(".json")) {
      const id = entry.slice(0, -".json".length);
      if (!SESSION_ID_REGEX.test(id)) {
        skipped.push({ path: full, reason: "not a session file (expected sess_<16 hex>.json)" });
        continue;
      }
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // raced away
        throw err;
      }
      const eventLog = `${id}.jsonl`;
      sessions.push({
        sessionId: id,
        jsonPath: full,
        ...(sessionEntrySet.has(eventLog) ? { eventLogPath: join(sessionsDir, eventLog) } : {}),
        record: {
          id: `session:${id}`,
          tenantId: LOCAL_TENANT,
          kind: "session",
          // The file MTIME, deliberately — session-store's list() eviction is
          // keyed on mtime (not the in-file updatedAt), so the sweep expires
          // exactly what list() would have evicted. The JSON content is not
          // consulted: it cannot change the decision, so a malformed session
          // file cannot cause a wrong deletion.
          createdAt: mtimeMs,
          payload: { file: full },
        },
      });
    } else if (entry.endsWith(".jsonl")) {
      const id = entry.slice(0, -".jsonl".length);
      if (SESSION_ID_REGEX.test(id) && sessionEntrySet.has(`${id}.json`)) {
        continue; // companion event log — lives and dies with its session file
      }
      skipped.push({
        path: full,
        reason: SESSION_ID_REGEX.test(id)
          ? "orphaned session event log (no matching .json) — left in place"
          : "not a session artifact",
      });
    } else {
      skipped.push({ path: full, reason: "not a session artifact (e.g. a .tmp leftover)" });
    }
  }

  let auditEntries: string[] = [];
  try {
    auditEntries = await readdir(auditDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const entry of auditEntries.sort()) {
    const full = join(auditDir, entry);
    if (entry === CHAIN_TAIL_FILENAME) continue; // audit-log's internal tail anchor
    const m = AUDIT_DAY_FILE_REGEX.exec(entry);
    if (m === null) {
      skipped.push({ path: full, reason: "not an audit day file (expected YYYY-MM-DD.jsonl)" });
      continue;
    }
    const day = entry.slice(0, -".jsonl".length);
    const createdAt = endOfUtcDayMs(m[1] as string, m[2] as string, m[3] as string);
    if (createdAt === undefined) {
      skipped.push({ path: full, reason: `unparseable day label "${day}"` });
      continue;
    }
    auditDays.push({
      day,
      path: full,
      record: {
        id: `audit:${day}`,
        tenantId: LOCAL_TENANT,
        kind: "audit",
        createdAt,
        payload: { file: full, day },
      },
    });
  }

  return new HarnessRecordStore({
    sessionsDir,
    sessions,
    auditDays,
    skipped,
    pins: opts.pins ?? [],
    dryRun: opts.dryRun === true,
  });
}

export type EvidenceRef = { readonly seq: number; readonly hash: string };

export type RetentionEnforcementReport = {
  readonly action: "sweep" | "purge";
  readonly rootDir: string;
  readonly dryRun: boolean;
  readonly config: RetentionConfig;
  readonly before?: number;
  /** Sessions deleted (or, dry-run, that WOULD be) with their on-disk paths. */
  readonly deleted: ReadonlyArray<DeletionEntry>;
  /** Sessions kept because they are pinned (only reached once expired). */
  readonly keptPinned: ReadonlyArray<RefusalEntry>;
  /** Audit day files — always kept; see AUDIT_CHAIN_EXCLUSION_REASON. */
  readonly keptAuditChain: ReadonlyArray<string>;
  /** Session ids still inside the retention window (age < maxAgeDays). */
  readonly keptWithinRetention: ReadonlyArray<string>;
  /** Record ids deferred because an audit window is active. */
  readonly keptAuditWindow: ReadonlyArray<string>;
  /** Session ids outside the `--before` cutoff (purge only). */
  readonly keptOutsideCutoff: ReadonlyArray<string>;
  readonly activeAuditWindows: PurgeResult["auditWindowDeferred"];
  readonly skipped: ReadonlyArray<SkippedEntry>;
  /** The appended `retention_enforcement` record (real runs only). */
  readonly evidence?: EvidenceRef;
};

type EnforcementOptions = {
  readonly rootDir: string;
  readonly action: "sweep" | "purge";
  readonly dryRun: boolean;
  readonly before?: number;
  readonly now: () => number;
};

async function runRetentionEnforcement(
  opts: EnforcementOptions,
): Promise<RetentionEnforcementReport> {
  const rootDir = resolve(opts.rootDir);
  const config = await loadRetentionConfig(rootDir, opts.now);
  const store = await openHarnessRecordStore({
    rootDir,
    pins: config.pins,
    dryRun: opts.dryRun,
  });

  const engine = createDataRetentionEngine({
    recordStore: store,
    now: opts.now,
    // Safe by default: any kind WITHOUT an explicit policy below effectively
    // never expires — only "session" gets a real TTL. ("audit" additionally
    // can never be deleted at all; the adapter's delete() refuses it.)
    defaultRetentionDays: NEVER_EXPIRE_DAYS,
  });
  engine.retain(LOCAL_TENANT, "session", config.sessionMaxAgeDays);
  for (const w of config.auditWindows) engine.addAuditWindow(w);

  // purge() rather than sweep(): both apply the identical window → retention
  // → delete rules, but purge() returns the per-record deferral arrays the
  // --dry-run report needs (sweep() only counts). With a single local tenant
  // they cover the same records.
  const result = await engine.purge(
    LOCAL_TENANT,
    opts.before !== undefined ? { before: opts.before } : {},
  );

  const auditIds = new Set(store.auditDays.map((a) => a.record.id));
  const keptWithinRetention = result.retentionDeferred.filter((id) => !auditIds.has(id));
  // Audit day files land in retentionDeferred (NEVER_EXPIRE default) or, when
  // a window is active, in deferred — either way the load-bearing reason is
  // the chain exclusion, so report them all under it.
  const keptAuditChain = store.auditDays.map((a) => a.record.id);
  const keptAuditWindow = result.deferred.filter((id) => !auditIds.has(id));
  const keptOutsideCutoff =
    opts.before === undefined
      ? []
      : store.sessions
          .filter((s) => s.record.createdAt >= (opts.before as number))
          .map((s) => s.record.id);
  const keptPinned = store.refusals.filter((r) => r.id.startsWith("session:"));

  let evidence: EvidenceRef | undefined;
  // Evidence gating (ops-review F8b): dry runs never append. A REAL run
  // appends when it deleted something (enforcement happened — evidence it,
  // creating the audit store if this harness lacked one) or when an audit
  // store already exists to receive the record. A no-op run in a directory
  // with no audit store appends nothing — `crewhaus retention sweep` in an
  // arbitrary directory must not fabricate `.crewhaus/audit`.
  const auditStoreExists = existsSync(join(rootDir, AUDIT_RELPATH));
  if (!opts.dryRun && (store.deletions.length > 0 || auditStoreExists)) {
    evidence = await appendEvidence(rootDir, opts.now, {
      action: opts.action,
      dryRun: false,
      ...(opts.before !== undefined ? { before: new Date(opts.before).toISOString() } : {}),
      policy: {
        sessionMaxAgeDays: config.sessionMaxAgeDays,
        pins: config.pins,
        auditWindows: config.auditWindows.map((w) => `${w.frameworkId}/${w.controlId}`),
      },
      deletedSessionIds: store.deletions.map((d) => d.id),
      counts: {
        deleted: store.deletions.length,
        keptPinned: keptPinned.length,
        keptAuditChain: keptAuditChain.length,
        keptWithinRetention: keptWithinRetention.length,
        keptAuditWindow: keptAuditWindow.length,
        keptOutsideCutoff: keptOutsideCutoff.length,
        skipped: store.skipped.length,
      },
    });
  }

  return {
    action: opts.action,
    rootDir,
    dryRun: opts.dryRun,
    config,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    deleted: [...store.deletions],
    keptPinned,
    keptAuditChain,
    keptWithinRetention,
    keptAuditWindow,
    keptOutsideCutoff,
    activeAuditWindows: result.auditWindowDeferred,
    skipped: store.skipped,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** Append the `retention_enforcement` evidence record to `.crewhaus/audit`
 *  — the same append path (openAuditLog on the harness audit root) the run
 *  justification sink uses, so enforcement lands in the verifiable chain. */
async function appendEvidence(
  rootDir: string,
  now: () => number,
  payload: unknown,
): Promise<EvidenceRef> {
  const log = await openAuditLog({ rootDir: join(rootDir, AUDIT_RELPATH), now });
  const record: AuditRecord = await log.append({ kind: "retention_enforcement", payload });
  return { seq: record.seq, hash: record.hash };
}

export type RunRetentionSweepOptions = {
  readonly rootDir: string;
  readonly dryRun?: boolean;
  readonly now?: () => number;
};

/**
 * `crewhaus retention sweep` — the scheduled GDPR/TTL enforcement pass.
 * Deletes expired sessions (mtime older than `sessions.maxAgeDays`), honors
 * pins + audit windows, never touches audit data, and appends a
 * `retention_enforcement` evidence record on real runs. Exported as a plain
 * library function so a daemon janitor can call it without the CLI.
 */
export async function runRetentionSweep(
  opts: RunRetentionSweepOptions,
): Promise<RetentionEnforcementReport> {
  return runRetentionEnforcement({
    rootDir: opts.rootDir,
    action: "sweep",
    dryRun: opts.dryRun === true,
    now: opts.now ?? (() => Date.now()),
  });
}

export type RunRetentionPurgeOptions = {
  readonly rootDir: string;
  /** Only records with createdAt strictly BEFORE this epoch-ms cutoff are
   *  candidates. Omitted = every expired record (same coverage as sweep). */
  readonly before?: number;
  /** Report what WOULD be purged; delete nothing, append no evidence.
   *  (Ops-review F1: `--dry-run` used to be accepted-and-ignored here — a
   *  dry run that really deletes is the worst possible failure mode.) */
  readonly dryRun?: boolean;
  readonly now?: () => number;
};

/**
 * `crewhaus retention purge` — the explicit right-to-delete verb. Identical
 * rules to the sweep (pins, audit windows, retention TTLs, audit exclusion)
 * restricted to records older than `--before` when given. Not a bypass:
 * a record still inside its retention window is deferred, not deleted.
 */
export async function runRetentionPurge(
  opts: RunRetentionPurgeOptions,
): Promise<RetentionEnforcementReport> {
  return runRetentionEnforcement({
    rootDir: opts.rootDir,
    action: "purge",
    dryRun: opts.dryRun === true,
    ...(opts.before !== undefined ? { before: opts.before } : {}),
    now: opts.now ?? (() => Date.now()),
  });
}

export type RetentionExportReport = {
  readonly rootDir: string;
  readonly outDir: string;
  readonly dryRun: boolean;
  readonly since?: number;
  /** Session ids whose files were copied (dry run: WOULD be copied). */
  readonly sessions: ReadonlyArray<string>;
  /** Audit day labels whose files were copied (dry run: WOULD be copied). */
  readonly auditDays: ReadonlyArray<string>;
  /**
   * True when the export covered EVERY audit day file and the on-host
   * `_chain-tail.json` anchor was copied too — the exported audit directory
   * is then independently verifiable with `crewhaus audit verify --dir
   * <outDir>/audit`. A `--since`-filtered (partial) export omits the anchor:
   * its chain starts mid-stream and would fail verification by construction.
   * (Dry run: whether the anchor WOULD be copied.)
   */
  readonly chainTailCopied: boolean;
  readonly skipped: ReadonlyArray<SkippedEntry>;
  /** The appended `retention_enforcement` record. Absent on a dry run, and
   *  on a real no-op export against a harness with no audit store (F8b). */
  readonly evidence?: EvidenceRef;
};

export type RunRetentionExportOptions = {
  readonly rootDir: string;
  readonly outDir: string;
  /** Only records at/after this epoch-ms timestamp are exported (sessions by
   *  mtime; audit at day granularity — a day is included when any instant of
   *  it is >= since, an inclusive over-approximation). */
  readonly since?: number;
  /** Report what WOULD be exported; write nothing (no outDir, no manifest),
   *  append no audit evidence. */
  readonly dryRun?: boolean;
  readonly now?: () => number;
};

/** True when `a` equals `b`, or either path contains the other. */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/**
 * `crewhaus retention export` — the right-to-export verb. Copies matching
 * records OUT of the harness stores (originals untouched) as raw files, so
 * an exported audit set keeps its verbatim hash-chain lines:
 *
 *   <outDir>/sessions/<id>.json (+ <id>.jsonl event log when present)
 *   <outDir>/audit/<day>.jsonl  (+ _chain-tail.json on a complete export)
 *   <outDir>/manifest.json
 *
 * Non-destructive, so pins and audit windows do not gate it; it IS
 * audit-logged (a `retention_enforcement` record with action "export").
 */
export async function runRetentionExport(
  opts: RunRetentionExportOptions,
): Promise<RetentionExportReport> {
  const rootDir = resolve(opts.rootDir);
  const outDir = resolve(opts.outDir);
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? (() => Date.now());
  const sessionsDir = join(rootDir, SESSIONS_RELPATH);
  const auditDir = join(rootDir, AUDIT_RELPATH);
  const sessionsOut = join(outDir, "sessions");
  const auditOut = join(outDir, "audit");
  // Containment (ops-review F5): refuse any outDir whose RESOLVED output
  // paths (outDir itself, <outDir>/sessions, <outDir>/audit) equal, sit
  // inside, or CONTAIN a live store. The classic foot-gun is
  // `retention export <root>/.crewhaus`, whose sessions/audit outputs are
  // exactly the live stores — a self-copy onto the data being exported.
  for (const outPath of [outDir, sessionsOut, auditOut]) {
    for (const storeDir of [sessionsDir, auditDir]) {
      if (pathsOverlap(outPath, storeDir)) {
        throw new RetentionConfigError(
          `export output path ${outPath} overlaps the live store ${storeDir} — refusing to write export output onto the store being exported`,
        );
      }
    }
  }

  const store = await openHarnessRecordStore({ rootDir, dryRun: true });
  const matchesSince = (createdAt: number): boolean =>
    opts.since === undefined || createdAt >= opts.since;

  const exportedSessions: string[] = [];
  for (const s of store.sessions) {
    if (!matchesSince(s.record.createdAt)) continue;
    if (!dryRun) {
      await mkdir(sessionsOut, { recursive: true });
      await copyFile(s.jsonPath, join(sessionsOut, `${s.sessionId}.json`));
      if (s.eventLogPath !== undefined) {
        await copyFile(s.eventLogPath, join(sessionsOut, `${s.sessionId}.jsonl`));
      }
    }
    exportedSessions.push(s.sessionId);
  }

  const exportedDays: string[] = [];
  for (const a of store.auditDays) {
    if (!matchesSince(a.record.createdAt)) continue;
    if (!dryRun) {
      await mkdir(auditOut, { recursive: true });
      await copyFile(a.path, join(auditOut, `${a.day}.jsonl`));
    }
    exportedDays.push(a.day);
  }
  const complete = exportedDays.length === store.auditDays.length && exportedDays.length > 0;
  const chainTailPath = join(auditDir, CHAIN_TAIL_FILENAME);
  const chainTailCopied = complete && existsSync(chainTailPath);
  if (chainTailCopied && !dryRun) {
    await copyFile(chainTailPath, join(auditOut, CHAIN_TAIL_FILENAME));
  }

  // Dry run (ops-review F1): report what WOULD be exported and stop — no
  // outDir, no manifest, no audit evidence, nothing on disk at all.
  if (dryRun) {
    return {
      rootDir,
      outDir,
      dryRun: true,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      sessions: exportedSessions,
      auditDays: exportedDays,
      chainTailCopied,
      skipped: store.skipped,
    };
  }

  // Evidence AFTER the copies: the record describes the completed export and
  // must not appear inside the exported snapshot itself. Gated like the
  // enforcement verbs (ops-review F8b): appended when something was actually
  // exported, or when an audit store already exists to receive it — a no-op
  // export must not fabricate `.crewhaus/audit`.
  let evidence: EvidenceRef | undefined;
  if (exportedSessions.length + exportedDays.length > 0 || existsSync(auditDir)) {
    evidence = await appendEvidence(rootDir, now, {
      action: "export",
      dryRun: false,
      outDir,
      ...(opts.since !== undefined ? { since: new Date(opts.since).toISOString() } : {}),
      counts: {
        sessions: exportedSessions.length,
        auditDays: exportedDays.length,
        skipped: store.skipped.length,
      },
      chainTailCopied,
    });
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        exportedAt: new Date(now()).toISOString(),
        rootDir,
        ...(opts.since !== undefined ? { since: new Date(opts.since).toISOString() } : {}),
        sessions: exportedSessions,
        auditDays: exportedDays,
        chainTailCopied,
        skipped: store.skipped,
        ...(evidence !== undefined ? { evidence } : {}),
      },
      null,
      2,
    )}\n`,
  );

  return {
    rootDir,
    outDir,
    dryRun: false,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    sessions: exportedSessions,
    auditDays: exportedDays,
    chainTailCopied,
    skipped: store.skipped,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

/** Render a sweep/purge report as the CLI's indented summary lines. */
export function formatEnforcementReport(report: RetentionEnforcementReport): ReadonlyArray<string> {
  const lines: string[] = [];
  const verb = report.dryRun ? "would delete" : "deleted";
  lines.push(
    `policy: sessions maxAgeDays=${report.config.sessionMaxAgeDays}${
      report.config.fromFile ? ` (${RETENTION_CONFIG_RELPATH})` : " (default)"
    }, pins=${report.config.pins.length}; audit: excluded from deletion (chain integrity)`,
  );
  for (const w of report.activeAuditWindows) {
    lines.push(
      `~ audit window active — ${w.frameworkId}/${w.controlId} defers ALL deletion until ${new Date(w.expiresAt).toISOString()}`,
    );
  }
  for (const d of report.deleted) {
    lines.push(`${report.dryRun ? "→" : "✓"} ${verb} ${d.id} (${d.paths.join(", ")})`);
  }
  for (const k of report.keptPinned) lines.push(`• kept ${k.id} — ${k.reason}`);
  for (const id of report.keptWithinRetention) {
    lines.push(`• kept ${id} — within retention (< ${report.config.sessionMaxAgeDays}d)`);
  }
  for (const id of report.keptOutsideCutoff) {
    lines.push(
      `• kept ${id} — newer than --before ${new Date(report.before as number).toISOString()}`,
    );
  }
  for (const id of report.keptAuditWindow) lines.push(`• kept ${id} — audit window active`);
  if (report.keptAuditChain.length > 0) {
    lines.push(
      `• kept ${report.keptAuditChain.length} audit day file(s) (${report.keptAuditChain[0]}${
        report.keptAuditChain.length > 1 ? " …" : ""
      }) — ${AUDIT_CHAIN_EXCLUSION_REASON}`,
    );
  }
  for (const s of report.skipped) lines.push(`~ skipped ${s.path} — ${s.reason}`);
  lines.push(
    `summary: ${report.deleted.length} ${verb}, ${
      report.keptPinned.length +
      report.keptWithinRetention.length +
      report.keptAuditWindow.length +
      report.keptOutsideCutoff.length +
      report.keptAuditChain.length
    } kept, ${report.skipped.length} skipped${
      report.evidence !== undefined
        ? ` — evidence appended to ${AUDIT_RELPATH} (seq ${report.evidence.seq})`
        : report.dryRun
          ? " — dry run: nothing deleted, no evidence appended"
          : ` — no-op: nothing deleted and no ${AUDIT_RELPATH} store present, no evidence appended`
    }`,
  );
  return lines;
}

/** Render an export report as the CLI's indented summary lines. */
export function formatExportReport(report: RetentionExportReport): ReadonlyArray<string> {
  const lines: string[] = [];
  const mark = report.dryRun ? "→" : "✓";
  const verb = report.dryRun ? "would export" : "exported";
  lines.push(
    `${mark} ${verb} ${report.sessions.length} session(s) → ${join(report.outDir, "sessions")}`,
  );
  lines.push(
    `${mark} ${verb} ${report.auditDays.length} audit day file(s) → ${join(report.outDir, "audit")}`,
  );
  lines.push(
    report.chainTailCopied
      ? `${mark} complete audit export — _chain-tail.json ${
          report.dryRun ? "would be included" : "included"
        }, re-verify with: crewhaus audit verify --dir ${join(report.outDir, "audit")}`
      : "~ partial audit export — _chain-tail.json omitted (a mid-stream chain cannot re-verify standalone)",
  );
  for (const s of report.skipped) lines.push(`~ skipped ${s.path} — ${s.reason}`);
  lines.push(
    report.dryRun
      ? "summary: dry run — nothing written, no evidence appended"
      : `summary: manifest.json written${
          report.evidence !== undefined
            ? ` — evidence appended to ${AUDIT_RELPATH} (seq ${report.evidence.seq})`
            : ` — no-op: nothing exported and no ${AUDIT_RELPATH} store present, no evidence appended`
        }`,
  );
  return lines;
}
