import { CrewhausError } from "@crewhaus/errors";

/**
 * Catalog R17 `data-retention-engine` — Section 39 GDPR-shaped retention.
 *
 * Three operations:
 *   retain(tenantId, kind, durationDays) — pin records for at least
 *     this long. The cron-style sweeper consults the policy table
 *     before deleting. Multiple retain() calls compose: the longest
 *     duration wins.
 *   export(tenantId, format)             — right-to-export. Streams
 *     a tenant's records out in JSON or NDJSON.
 *   purge(tenantId, opts?)               — right-to-delete. Honors a
 *     compliance-controls "do not purge during audit window" override
 *     so SOC 2 evidence collection isn't disrupted.
 *
 * The engine is record-store-agnostic. Callers supply a `RecordStore`
 * shape (list / get / delete / count) so the engine can operate over
 * the audit-log JSONL files, a SQL table, an object-store prefix, etc.
 *
 * Audit-window override: callers register an `AuditWindow` (with
 * `frameworkId` / `controlId` / `expiresAt`) via `addAuditWindow`. As
 * long as any window is active, `purge()` skips records and returns
 * the deferral reason. Cleared automatically once `expiresAt` passes.
 *
 * Cross-tenant isolation: every operation requires an explicit
 * `tenantId`; the engine refuses to operate on records that don't
 * report a matching `tenantId`. T8 isolation test asserts that a
 * tenant-A purge does not touch tenant-B records.
 *
 * Layer R17. Pairs with `audit-log` (R-infra — primary record store
 * for audit data), `tenancy` (R-infra — tenant-scoping primitives).
 */

// `.crewhaus/retention.json` — the shared on-disk policy file read by BOTH
// the `crewhaus retention` CLI and the daemon shapes' boot-time janitor, so
// the two enforcement paths cannot drift (ops-review F2). See
// retention-config.ts for the schema + safety stance.
export {
  DEFAULT_SESSION_MAX_AGE_DAYS,
  RETENTION_CONFIG_RELPATH,
  type RetentionAuditWindowConfig,
  type RetentionConfig,
  RetentionConfigError,
  SESSION_ID_REGEX,
  loadRetentionConfig,
} from "./retention-config";

export class DataRetentionError extends CrewhausError {
  override readonly name = "DataRetentionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type RetentionRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly createdAt: number;
  readonly payload: unknown;
};

export interface RecordStore {
  /** Iterate every record (retention engine filters per-tenant downstream). */
  listAll(): AsyncIterable<RetentionRecord>;
  /** Iterate records for a specific tenant. */
  listByTenant(tenantId: string): AsyncIterable<RetentionRecord>;
  /** Delete a record by id. Returns true if a record was actually deleted. */
  delete(id: string): Promise<boolean>;
}

export type RetentionPolicy = {
  readonly tenantId: string;
  readonly kind: string;
  readonly durationDays: number;
};

export type AuditWindow = {
  readonly frameworkId: string;
  readonly controlId: string;
  readonly expiresAt: number;
};

export type ExportFormat = "json" | "ndjson";

export type ExportOptions = {
  readonly format: ExportFormat;
  readonly kinds?: ReadonlyArray<string>;
};

export type PurgeOptions = {
  readonly kind?: string;
  readonly before?: number;
};

export type PurgeResult = {
  readonly tenantId: string;
  readonly deleted: number;
  readonly deferred: ReadonlyArray<string>;
  readonly retentionDeferred: ReadonlyArray<string>;
  readonly auditWindowDeferred: ReadonlyArray<{
    readonly frameworkId: string;
    readonly controlId: string;
    readonly expiresAt: number;
  }>;
};

export type SweepResult = {
  readonly deletedCount: number;
  readonly recordsKept: number;
};

export interface DataRetentionEngine {
  retain(tenantId: string, kind: string, durationDays: number): void;
  removeRetention(tenantId: string, kind: string): void;
  listRetention(): ReadonlyArray<RetentionPolicy>;
  addAuditWindow(window: AuditWindow): void;
  listAuditWindows(): ReadonlyArray<AuditWindow>;
  /** Purge a single tenant's records. Honors retention + audit windows. */
  purge(tenantId: string, opts?: PurgeOptions): Promise<PurgeResult>;
  /** Stream a single tenant's records in the requested format. */
  export(tenantId: string, opts: ExportOptions): Promise<string>;
  /** Cron-style sweeper: walk all records and delete expired-by-policy ones. */
  sweep(): Promise<SweepResult>;
}

export type CreateOptions = {
  readonly recordStore: RecordStore;
  readonly now?: () => number;
  readonly defaultRetentionDays?: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createDataRetentionEngine(opts: CreateOptions): DataRetentionEngine {
  if (opts.recordStore === undefined) {
    throw new DataRetentionError("recordStore is required");
  }
  const now = opts.now ?? ((): number => Date.now());
  const defaultRetentionDays = opts.defaultRetentionDays ?? 90;
  const policies = new Map<string, RetentionPolicy>();
  const auditWindows: AuditWindow[] = [];

  const policyKey = (tenantId: string, kind: string): string => `${tenantId}::${kind}`;

  function activeAuditWindows(): ReadonlyArray<AuditWindow> {
    const active = auditWindows.filter((w) => w.expiresAt > now());
    // Mutate in place to drop expired windows so the array doesn't grow
    // unboundedly across many sweeps.
    auditWindows.length = 0;
    auditWindows.push(...active);
    return active;
  }

  function retentionEnd(record: RetentionRecord): number {
    const key = policyKey(record.tenantId, record.kind);
    const policy = policies.get(key);
    const days = policy?.durationDays ?? defaultRetentionDays;
    return record.createdAt + days * MS_PER_DAY;
  }

  return {
    retain(tenantId, kind, durationDays): void {
      if (typeof tenantId !== "string" || tenantId === "") {
        throw new DataRetentionError("retain: tenantId required");
      }
      if (typeof kind !== "string" || kind === "") {
        throw new DataRetentionError("retain: kind required");
      }
      if (!Number.isFinite(durationDays) || durationDays <= 0) {
        throw new DataRetentionError("retain: durationDays must be > 0");
      }
      const key = policyKey(tenantId, kind);
      const existing = policies.get(key);
      if (existing === undefined || durationDays > existing.durationDays) {
        policies.set(key, { tenantId, kind, durationDays });
      }
    },

    removeRetention(tenantId, kind): void {
      policies.delete(policyKey(tenantId, kind));
    },

    listRetention(): ReadonlyArray<RetentionPolicy> {
      return [...policies.values()].sort(
        (a, b) => a.tenantId.localeCompare(b.tenantId) || a.kind.localeCompare(b.kind),
      );
    },

    addAuditWindow(window: AuditWindow): void {
      if (window.expiresAt <= now()) {
        throw new DataRetentionError(
          `addAuditWindow: expiresAt (${window.expiresAt}) must be in the future (now=${now()})`,
        );
      }
      auditWindows.push({ ...window });
    },

    listAuditWindows(): ReadonlyArray<AuditWindow> {
      return activeAuditWindows().map((w) => ({ ...w }));
    },

    async purge(tenantId, purgeOpts = {}): Promise<PurgeResult> {
      if (typeof tenantId !== "string" || tenantId === "") {
        throw new DataRetentionError("purge: tenantId required");
      }
      const active = activeAuditWindows();
      const result = {
        tenantId,
        deleted: 0,
        deferred: [] as string[],
        retentionDeferred: [] as string[],
        auditWindowDeferred: [] as PurgeResult["auditWindowDeferred"][number][],
      };
      for (const window of active) {
        result.auditWindowDeferred.push({
          frameworkId: window.frameworkId,
          controlId: window.controlId,
          expiresAt: window.expiresAt,
        });
      }
      const cutoff = purgeOpts.before;
      const restrictKind = purgeOpts.kind;
      for await (const record of opts.recordStore.listByTenant(tenantId)) {
        if (record.tenantId !== tenantId) continue; // T8 cross-tenant guard
        if (restrictKind !== undefined && record.kind !== restrictKind) continue;
        if (cutoff !== undefined && record.createdAt >= cutoff) continue;
        if (active.length > 0) {
          result.deferred.push(record.id);
          continue;
        }
        if (retentionEnd(record) > now()) {
          result.retentionDeferred.push(record.id);
          continue;
        }
        const deleted = await opts.recordStore.delete(record.id);
        if (deleted) result.deleted += 1;
      }
      return {
        tenantId: result.tenantId,
        deleted: result.deleted,
        deferred: result.deferred,
        retentionDeferred: result.retentionDeferred,
        auditWindowDeferred: result.auditWindowDeferred,
      };
    },

    async export(tenantId, exportOpts): Promise<string> {
      if (typeof tenantId !== "string" || tenantId === "") {
        throw new DataRetentionError("export: tenantId required");
      }
      const records: RetentionRecord[] = [];
      for await (const record of opts.recordStore.listByTenant(tenantId)) {
        if (record.tenantId !== tenantId) continue; // T8 cross-tenant guard
        if (exportOpts.kinds !== undefined && !exportOpts.kinds.includes(record.kind)) continue;
        records.push(record);
      }
      if (exportOpts.format === "ndjson") {
        return records.map((r) => JSON.stringify(r)).join("\n");
      }
      return JSON.stringify(records, null, 2);
    },

    async sweep(): Promise<SweepResult> {
      const active = activeAuditWindows();
      let deleted = 0;
      let kept = 0;
      for await (const record of opts.recordStore.listAll()) {
        if (active.length > 0) {
          kept += 1;
          continue;
        }
        if (retentionEnd(record) > now()) {
          kept += 1;
          continue;
        }
        const ok = await opts.recordStore.delete(record.id);
        if (ok) deleted += 1;
        else kept += 1;
      }
      return { deletedCount: deleted, recordsKept: kept };
    },
  };
}

export class InMemoryRecordStore implements RecordStore {
  private records: RetentionRecord[];
  constructor(initial: ReadonlyArray<RetentionRecord> = []) {
    this.records = [...initial];
  }

  async *listAll(): AsyncIterable<RetentionRecord> {
    for (const r of [...this.records]) yield r;
  }

  async *listByTenant(tenantId: string): AsyncIterable<RetentionRecord> {
    for (const r of [...this.records]) {
      if (r.tenantId === tenantId) yield r;
    }
  }

  async delete(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length < before;
  }

  size(): number {
    return this.records.length;
  }

  ids(): ReadonlyArray<string> {
    return this.records.map((r) => r.id);
  }
}

export { MS_PER_DAY as _msPerDayForTest };
