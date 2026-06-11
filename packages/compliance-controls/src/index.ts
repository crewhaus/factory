import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AuditKind, type AuditRecord, recomputeRecordHash } from "@crewhaus/audit-log";
import { CrewhausError } from "@crewhaus/errors";

/**
 * Catalog R17 `compliance-controls` — Section 39 SOC 2 / ISO 27001 /
 * HIPAA evidence collection.
 *
 * A `ControlDefinition` declares which audit-log records prove a
 * given control is operating. The collector walks the audit log per
 * control, gathers matching records into an `EvidenceBundle`, signs
 * the bundle with HMAC-SHA256, and writes it to
 *   `.crewhaus/compliance/<framework>/<controlId>/<period>.json`.
 *
 * Built-in framework definitions (SOC 2 Type II CC6.x + CC7.x, ISO
 * 27001 A.12.4, HIPAA §164.312(b)) are exported at module load so
 * callers don't have to author the filter shapes themselves.
 *
 * Layer R17. Pairs with `audit-log` (R-infra — primary record source),
 * `data-retention-engine` (§39 — adds an audit window so the records
 * referenced by an in-progress evidence collection are not purged
 * mid-run).
 */

export class ComplianceControlsError extends CrewhausError {
  override readonly name = "ComplianceControlsError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type AuditEventFilter = {
  /** Match the audit record's `kind` field. */
  readonly kind?: AuditKind;
  /** Match a specific top-level field within `payload`. */
  readonly payloadField?: string;
  /** Substring match on a serialized payload field — e.g. action="rotate". */
  readonly payloadFieldEquals?: string;
  /** Inclusive lower bound on `ts`. */
  readonly tsAfter?: number;
  /** Exclusive upper bound on `ts`. */
  readonly tsBefore?: number;
};

export type ControlDefinition = {
  readonly frameworkId: string;
  readonly controlId: string;
  /** Short description shown in the evidence bundle for auditors. */
  readonly description: string;
  /** OR-merged: a record matching any filter is evidence for this control. */
  readonly evidenceQueries: ReadonlyArray<AuditEventFilter>;
};

export type EvidenceBundle = {
  readonly frameworkId: string;
  readonly controlId: string;
  readonly description: string;
  readonly period: string;
  readonly generatedAt: number;
  readonly recordCount: number;
  readonly records: ReadonlyArray<AuditRecord>;
  /** Hex SHA-256 of the canonical record list, with HMAC signature when keyed. */
  readonly digest: string;
  readonly signature: string | null;
};

export interface AuditRecordSource {
  /** Yield every record across all days. */
  read(): AsyncIterable<AuditRecord>;
}

export type CollectOptions = {
  /** Period label (e.g. "2026-Q2"). Used in the output path. */
  readonly period: string;
  /** Optional HMAC key for signing the bundle. */
  readonly signingKey?: string;
  /** Optional clock for tests. */
  readonly now?: () => number;
};

export type CollectorOptions = {
  readonly auditSource: AuditRecordSource;
  readonly outputDir?: string;
  readonly controls?: ReadonlyArray<ControlDefinition>;
};

export interface ComplianceCollector {
  registerControl(def: ControlDefinition): void;
  listControls(filter?: { frameworkId?: string }): ReadonlyArray<ControlDefinition>;
  collect(framework: string, controlId: string, opts: CollectOptions): Promise<EvidenceBundle>;
  collectAll(framework: string, opts: CollectOptions): Promise<ReadonlyArray<EvidenceBundle>>;
  /** Test seam — write the bundle to disk under the configured outputDir. */
  writeBundle(bundle: EvidenceBundle): string;
}

// --------------------------------------------------------------------
// Built-in framework definitions
// --------------------------------------------------------------------

export const SOC2_CONTROLS: ReadonlyArray<ControlDefinition> = [
  {
    frameworkId: "soc2",
    controlId: "CC6.1",
    description: "Logical and physical access controls — every policy decision is audit-logged.",
    evidenceQueries: [{ kind: "policy_decision" }],
  },
  {
    frameworkId: "soc2",
    controlId: "CC6.7",
    description:
      "Restricted access to system functions — secrets-manager rotation + access events captured.",
    evidenceQueries: [{ kind: "secrets_rotation" }, { kind: "secrets_access" }],
  },
  {
    frameworkId: "soc2",
    controlId: "CC7.2",
    description: "System monitoring — model invocations and tool classifications are captured.",
    evidenceQueries: [{ kind: "model_call" }, { kind: "tool_classification" }],
  },
  {
    frameworkId: "soc2",
    controlId: "CC7.3",
    description: "Detection of incidents — gateway requests captured for replay/replay analysis.",
    evidenceQueries: [{ kind: "gateway_request" }],
  },
];

export const ISO27001_CONTROLS: ReadonlyArray<ControlDefinition> = [
  {
    frameworkId: "iso27001",
    controlId: "A.12.4",
    description:
      "Logging and monitoring — append-only hash-chained audit trail across every privileged operation.",
    evidenceQueries: [
      { kind: "policy_decision" },
      { kind: "model_call" },
      { kind: "secrets_rotation" },
      { kind: "deployment_action" },
    ],
  },
];

export const HIPAA_CONTROLS: ReadonlyArray<ControlDefinition> = [
  {
    frameworkId: "hipaa",
    controlId: "164.312(b)",
    description:
      "Audit controls — every access to or decision involving protected data appears in the audit log.",
    evidenceQueries: [
      { kind: "policy_decision" },
      { kind: "secrets_access" },
      { kind: "tenancy_context" },
    ],
  },
];

export const BUILT_IN_CONTROLS: ReadonlyArray<ControlDefinition> = [
  ...SOC2_CONTROLS,
  ...ISO27001_CONTROLS,
  ...HIPAA_CONTROLS,
];

// --------------------------------------------------------------------
// Match logic
// --------------------------------------------------------------------

function matches(record: AuditRecord, filter: AuditEventFilter): boolean {
  if (filter.kind !== undefined && record.kind !== filter.kind) return false;
  if (filter.tsAfter !== undefined && record.ts < filter.tsAfter) return false;
  if (filter.tsBefore !== undefined && record.ts >= filter.tsBefore) return false;
  if (filter.payloadField !== undefined) {
    const payload = record.payload as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") return false;
    // Own-property check only: a filter targets a "top-level field within
    // payload" (see AuditEventFilter.payloadField). The `in` operator would
    // also walk the prototype chain, so e.g. `payloadField: "toString"` or
    // "constructor" would spuriously match every object payload.
    if (!Object.hasOwn(payload, filter.payloadField)) return false;
    if (filter.payloadFieldEquals !== undefined) {
      const value = payload[filter.payloadField];
      if (typeof value === "string") {
        if (value !== filter.payloadFieldEquals) return false;
      } else if (String(value) !== filter.payloadFieldEquals) {
        return false;
      }
    }
  }
  return true;
}

function matchesAny(record: AuditRecord, queries: ReadonlyArray<AuditEventFilter>): boolean {
  if (queries.length === 0) return false;
  for (const q of queries) {
    if (matches(record, q)) return true;
  }
  return false;
}

/** Canonical serialization of a record — the bytes the digest must commit to. */
function canonicalRecord(r: AuditRecord): string {
  return JSON.stringify({
    ts: r.ts,
    version: r.version,
    kind: r.kind,
    seq: r.seq,
    payload: r.payload,
    prevHash: r.prevHash,
    hash: r.hash,
  });
}

function canonicalDigest(records: ReadonlyArray<AuditRecord>): string {
  // Commit to the FULL record (the payload/kind/ts the auditor actually reads),
  // not just `r.hash`. Hashing only `r.hash` let an attacker rewrite a written
  // bundle's payload while leaving its hash field untouched, so digest + HMAC
  // still validated against content that no longer matched.
  const text = records.map(canonicalRecord).join("\n");
  return createHash("sha256").update(text).digest("hex");
}

function signDigest(digest: string, key: string): string {
  return createHmac("sha256", key).update(digest).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type BundleVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Re-verify an EvidenceBundle on read. Recomputes the digest over the bundle's
 * records (so a post-signing payload rewrite is detected), re-checks each
 * record's body↔hash consistency, and — when a signing key is supplied —
 * re-derives the HMAC and compares it in constant time. Bundles MUST be
 * verified with this before being trusted as authoritative evidence.
 */
export function verifyBundle(bundle: EvidenceBundle, signingKey?: string): BundleVerification {
  if (!constantTimeEqualHex(canonicalDigest(bundle.records), bundle.digest)) {
    return {
      ok: false,
      reason: "digest does not match bundle.records (records altered after signing)",
    };
  }
  for (const r of bundle.records) {
    if (r.hash !== recomputeRecordHash(r)) {
      return { ok: false, reason: `record seq ${r.seq} body does not hash to its stored hash` };
    }
  }
  if (signingKey !== undefined) {
    if (bundle.signature === null) return { ok: false, reason: "bundle is unsigned" };
    if (!constantTimeEqualHex(signDigest(bundle.digest, signingKey), bundle.signature)) {
      return { ok: false, reason: "HMAC signature mismatch" };
    }
  }
  return { ok: true };
}

/**
 * Reject any path component that could escape the output directory. Each of
 * `frameworkId` / `controlId` / `period` becomes one path segment in the
 * evidence-bundle path; a segment containing a path separator (`/` or `\`),
 * a `..` traversal token, or a NUL byte could redirect the write to an
 * arbitrary location on disk. Returns true when the component is unsafe.
 */
function isUnsafePathComponent(component: string): boolean {
  return (
    component.includes("/") ||
    component.includes("\\") ||
    component.includes("\0") ||
    component === ".." ||
    component === "."
  );
}

// --------------------------------------------------------------------
// Collector
// --------------------------------------------------------------------

export function createComplianceCollector(opts: CollectorOptions): ComplianceCollector {
  if (opts.auditSource === undefined) {
    throw new ComplianceControlsError("auditSource is required");
  }
  const outputDir = opts.outputDir ?? join(process.cwd(), ".crewhaus", "compliance");
  const controls = new Map<string, ControlDefinition>();
  const seedControls = opts.controls ?? BUILT_IN_CONTROLS;
  for (const c of seedControls) {
    controls.set(`${c.frameworkId}::${c.controlId}`, c);
  }

  function key(framework: string, controlId: string): string {
    return `${framework}::${controlId}`;
  }

  return {
    registerControl(def: ControlDefinition): void {
      if (typeof def.frameworkId !== "string" || def.frameworkId === "") {
        throw new ComplianceControlsError("registerControl: frameworkId required");
      }
      if (typeof def.controlId !== "string" || def.controlId === "") {
        throw new ComplianceControlsError("registerControl: controlId required");
      }
      controls.set(key(def.frameworkId, def.controlId), def);
    },

    listControls(filter?: { frameworkId?: string }): ReadonlyArray<ControlDefinition> {
      const items = [...controls.values()];
      const filtered =
        filter?.frameworkId !== undefined
          ? items.filter((c) => c.frameworkId === filter.frameworkId)
          : items;
      return filtered.sort(
        (a, b) =>
          a.frameworkId.localeCompare(b.frameworkId) || a.controlId.localeCompare(b.controlId),
      );
    },

    async collect(framework, controlId, collectOpts): Promise<EvidenceBundle> {
      const def = controls.get(key(framework, controlId));
      if (def === undefined) {
        throw new ComplianceControlsError(
          `collect: control "${framework}/${controlId}" not registered`,
        );
      }
      // Verify the audit chain BEFORE accepting records as evidence — the
      // plain `read()` iterator does no validation, so a record whose payload
      // was rewritten (without repairing its hash), or a record deleted from
      // the middle of the chain, would otherwise flow straight into a signed
      // bundle presented to auditors as authoritative. We re-check every
      // record's body↔hash, and the link + gapless-seq contiguity of the
      // sequence `read()` yields, then filter the verified records.
      const matched: AuditRecord[] = [];
      let prev: AuditRecord | undefined;
      for await (const record of opts.auditSource.read()) {
        if (record.hash !== recomputeRecordHash(record)) {
          throw new ComplianceControlsError(
            `collect: audit record at seq ${record.seq} fails hash integrity — its body was modified after signing; refusing to bundle tampered evidence`,
          );
        }
        if (prev !== undefined) {
          if (record.prevHash !== prev.hash) {
            throw new ComplianceControlsError(
              `collect: audit chain broken at seq ${record.seq} — prevHash does not link to the prior record (a record was reordered or removed)`,
            );
          }
          if (record.seq !== prev.seq + 1) {
            throw new ComplianceControlsError(
              `collect: audit chain has a seq gap before seq ${record.seq} (expected ${prev.seq + 1}) — a record was removed`,
            );
          }
        }
        prev = record;
        if (matchesAny(record, def.evidenceQueries)) {
          matched.push(record);
        }
      }
      const digest = canonicalDigest(matched);
      const signature = collectOpts.signingKey ? signDigest(digest, collectOpts.signingKey) : null;
      const now = collectOpts.now?.() ?? Date.now();
      return {
        frameworkId: def.frameworkId,
        controlId: def.controlId,
        description: def.description,
        period: collectOpts.period,
        generatedAt: now,
        recordCount: matched.length,
        records: matched,
        digest,
        signature,
      };
    },

    async collectAll(framework, collectOpts): Promise<ReadonlyArray<EvidenceBundle>> {
      const matchingControls = [...controls.values()]
        .filter((c) => c.frameworkId === framework)
        .sort((a, b) => a.controlId.localeCompare(b.controlId));
      if (matchingControls.length === 0) {
        throw new ComplianceControlsError(
          `collectAll: no controls registered for framework "${framework}"`,
        );
      }
      const bundles: EvidenceBundle[] = [];
      for (const c of matchingControls) {
        bundles.push(await this.collect(c.frameworkId, c.controlId, collectOpts));
      }
      return bundles;
    },

    writeBundle(bundle: EvidenceBundle): string {
      // All three components are interpolated into the on-disk path; validate
      // each so a caller-supplied id or period label cannot traverse out of
      // outputDir (e.g. period "../../etc/cron.d/x" or an absolute path).
      for (const [field, value] of [
        ["frameworkId", bundle.frameworkId],
        ["controlId", bundle.controlId],
        ["period", bundle.period],
      ] as const) {
        if (isUnsafePathComponent(value)) {
          throw new ComplianceControlsError(
            `writeBundle: ${field} may not contain a path separator or ".." segment (got "${value}")`,
          );
        }
      }
      const path = join(outputDir, bundle.frameworkId, bundle.controlId, `${bundle.period}.json`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
      return path;
    },
  };
}

export {
  matches as _matchesForTest,
  matchesAny as _matchesAnyForTest,
  canonicalDigest as _canonicalDigestForTest,
  signDigest as _signDigestForTest,
};
