/**
 * Catalog R17 `audit-log` — per-tenant hash-chained append-only JSONL.
 *
 * Daily file rotation: `<auditRoot>/<YYYY-MM-DD>.jsonl`. Every line is
 * a self-describing record with a SHA-256 hash that includes the
 * previous line's hash, forming a tamper-evident chain:
 *
 *   {
 *     ts: <ms epoch>, version: 1, kind: "policy_decision" | …,
 *     seq: <0-based strictly-increasing per-log counter>,
 *     payload: <opaque JSON>,
 *     prevHash: <hex of prior line, or "GENESIS">,
 *     hash: <SHA-256(prevHash || JSON.stringify({ts,version,kind,seq,payload}))>
 *   }
 *
 * `verify(rootDir)` walks the chain and reports the first broken link
 * (line number + reason). The chain is per-day; the previous day's
 * tail seeds the next day's `prevHash` AND `seq` via a one-line index
 * file (`_chain-tail.json` = `{ day, hash, seq }`).
 *
 * Tail-truncation detection. A pure hash chain is only tamper-evident
 * for *interior* edits: deleting a suffix of the newest day file (or
 * `rm`-ing the whole newest day) leaves the survivors internally
 * consistent, so a naive walk would still pass. Two commitments close
 * that gap: (1) the per-record `seq` lets `verify` assert the chain is
 * gapless from 0 — a hole proves records were removed from the middle;
 * (2) `verify` reads the `_chain-tail.json` anchor and fails if the
 * surviving chain's last `{ hash, seq }` does not match the recorded
 * tail, which catches a truncation that drops trailing records.
 *
 * IMPORTANT — on-host files are NOT tamper-proof against a same-uid
 * attacker. The 0o600 mode only blocks *other* users; the gateway's own
 * uid (or anything that compromises it) can rewrite both the JSONL and
 * `_chain-tail.json` in lockstep, defeating the on-host anchor check
 * above. True non-repudiation requires an anchor the audit-writer cannot
 * rewrite — an off-host / WORM bucket, a separate-privilege service, or
 * periodic publication to an external transparency log. A *missing*
 * on-host anchor is therefore reported by `verify` as a known limitation
 * (`anchorChecked: false`), never silently treated as a pass.
 *
 * Off-host anchor hook (`AnchorStore`). To close the same-uid lockstep
 * gap, `openAuditLog` and `verify` accept an OPTIONAL pluggable
 * `AnchorStore` — `{ putAnchor(logId, {seq, hash}), getAnchor(logId) }`.
 * On each `append`, the new tail `{ seq, hash }` is *best-effort* mirrored
 * to the store (a put failure never blocks the durable local write). On
 * `verify`, the external anchor is consulted IN ADDITION to
 * `_chain-tail.json`: if it witnesses a `seq` the surviving chain no
 * longer reaches — or a hash that disagrees with the surviving chain's
 * record AT the anchored seq — verify FAILS, catching a tail truncation
 * that ALSO rewrote the on-host `_chain-tail.json` in lockstep (the
 * attacker cannot reach back into the external store). An anchor that
 * merely lags behind newer appends (the benign best-effort case) is NOT
 * treated as a failure — but its hash must still match the chain's record
 * at that seq, so a wholesale chain rewrite followed by fresh appends
 * cannot masquerade as benign lag. Two reference
 * implementations ship: the in-memory `InMemoryAnchorStore` (tests/dev)
 * and the durable `FileAnchorStore` (append-only anchor files under a
 * directory — tamper-resistant exactly insofar as that directory is not
 * writable by the audit writer's uid; see file-anchor-store.ts). PRODUCTION
 * DEPLOYMENTS SHOULD BACK THE SEAM WITH A WORM STORE (object-lock bucket,
 * append-only/separate-privilege service, or transparency log) so the audit
 * writer's own uid cannot rewrite it.
 *
 * Files are created with mode 0o600 (owner-only) so the audit trail
 * cannot be read by other users on the host. Append uses
 * `appendFileSync` which is atomic per line on POSIX when the line
 * fits in `PIPE_BUF`, mirroring `event-log`'s contract.
 *
 * Layer R17. Pairs with `tenancy` (R17) and `gateway-server` (R16).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CrewhausError, RuntimeError } from "@crewhaus/errors";

export const GENESIS_HASH = "GENESIS";

export type AuditKind =
  | "policy_decision"
  | "model_call"
  | "tool_classification"
  | "gateway_request"
  | "session_fork"
  | "tenancy_context"
  // Section 27 — secrets-manager rotation + access events
  | "secrets_rotation"
  | "secrets_access"
  // Section 28 — deployment-controller actions
  | "deployment_action"
  // Pillar 3 sink-side fabric — egress-classifier emits one event per
  // external-tool invocation. Payload shape (informally; opaque JSON):
  //   { sinkId, sinkScope, verdict, originsFound, matchCount, originStack }
  // The raw outbound payload is NEVER stored verbatim — only the lineage
  // summary. The egress-classifier's `summarizeEgress(result)` produces
  // the human-readable form that lands in the `payload_summary` field.
  | "egress_decision"
  // Pillar 3 intent gate — `runtime-core`'s justification gate appends one
  // record per justification-evaluated tool call (allow OR deny) when a
  // durable sink is wired via `runChatLoop({ justificationAuditSink })`. The
  // CLI `run`/browser paths open a real audit-log rooted at `.crewhaus/audit`
  // and pass it (disable with `--no-justification-audit`); the ephemeral
  // `permission_decision` trace-bus event mirrors the same verdict + judge
  // identity for live observability. Payload shape (opaque JSON):
  //   { toolName, justification, verdict: "allow"|"deny", reason, judgeModel,
  //     confidence? }
  // Stored verbatim because the justification IS the audit artifact;
  // redacting it would defeat the purpose. (`runtime-core` declares a minimal
  // structural `JustificationAuditSink` rather than importing this package, to
  // avoid a dependency cycle; this `AuditLog` satisfies that seam.)
  | "permission_justification_evaluated"
  // Section 39 / item 35 — `crewhaus retention sweep|export|purge` appends one
  // record per REAL (non-dry-run) run so retention enforcement is itself
  // tamper-evidenced. Payload shape (opaque JSON; see apps/cli/src/retention.ts):
  //   { action: "sweep"|"export"|"purge", dryRun: false, deletedSessionIds,
  //     kept/deferred counts, policy inputs (maxAgeDays, pins, windows), ... }
  | "retention_enforcement"
  // Item 59 — approval-gated promotion. `crewhaus deploy promote
  // --require-approval` appends one record when an approval gate is
  // EVALUATED for a protected environment: the recorded approvals/tokens or
  // green PR check that satisfied the quorum (or the refusal), stamped
  // alongside the promotion it authorized so the approval and the pin flip
  // sit in the same tamper-evident chain. Payload shape (opaque JSON; see
  // apps/cli/src/approval-gate.ts):
  //   { name, toEnv, required, approvals: [{approver, ts, ...}], satisfied,
  //     prCheck?, ... }
  | "governance_approval"
  // Item 59 — PR-based optimize/advise proposals. `crewhaus propose` appends
  // one record when a spec-change proposal is packaged into a review artifact
  // (and, when driven, opened as a PR) so the proposal's provenance — source
  // command, patch hash, eval delta, PR ref — is itself evidenced without
  // waiting for a human to merge. Payload shape (opaque JSON; see
  // apps/cli/src/propose.ts):
  //   { source, specName, patchHash, evalDelta?, prNumber?, prUrl?, ... }
  | "governance_proposal"
  // Ops item 31 — the alert watchdog (CREWHAUS_ALERTS) appends one record per
  // metric breach against a baseline-derived threshold, so the alert history is
  // itself tamper-evidenced. Payload shape (opaque JSON; see the AlertSink the
  // CLI `run` path wires): { sessionId, metric, observed, threshold,
  //   baselineSessions, detail }.
  | "alert_raised"
  // Ops item 37 — the SLO monitor (CREWHAUS_SLO) appends one record per
  // ATTEMPTED mitigation rung (alert / pause-intake / rollback) on a sustained
  // SLO breach, so the mitigation history — including an auto-rollback of a
  // deployment pin — is itself tamper-evidenced. Payload shape (opaque JSON;
  // see the SloMitigationSink the CLI `run` path wires): { sessionId, rung,
  //   breach: { metric, observed, target, detail }, windowMs }.
  | "slo_mitigation"
  // NEW-inloop-coverage — the managed gateway's `feedback.submit` route
  // appends one record per DURABLE rating write, so the ratings that later
  // become an `expected_output` in a `<spec>-ratings` dataset are themselves
  // tamper-evidenced. Distinct from the `gateway_request` entry the server
  // already appends for every authenticated call (duplicating that kind
  // would double per-method request counts and read like a replay). Payload
  // shape (opaque JSON): { tenantId, sessionId, turnNumber, modality,
  //   recordId } — never the rater's free text.
  | "feedback_recorded";

export type AuditRecord = {
  readonly ts: number;
  readonly version: 1;
  readonly kind: AuditKind;
  /**
   * Strictly-increasing per-log sequence number, 0-based and gapless.
   * Committed into `hash` so it cannot be rewritten without breaking the
   * chain; `verify` asserts the run starts at 0 and has no holes, which
   * surfaces records removed from the middle of the chain.
   */
  readonly seq: number;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly hash: string;
};

export type AppendInput = Pick<AuditRecord, "kind" | "payload">;

export class AuditLogError extends CrewhausError {
  override readonly name = "AuditLogError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Off-host anchor commitment for a single log: the latest `{ seq, hash }`
 * the writer has published externally. Deliberately minimal so a
 * deployment can back it with a WORM bucket, an append-only/separate-
 * privilege service, or a transparency log.
 */
export type AnchorRecord = { readonly seq: number; readonly hash: string };

/**
 * Pluggable hook for mirroring the hash-chain tail to an anchor the audit
 * writer's own uid CANNOT rewrite. `append` calls `putAnchor` best-effort
 * after the local write; `verify` calls `getAnchor` to cross-check the
 * surviving chain (see file header). `logId` namespaces multiple logs in
 * one store — `openAuditLog` defaults it to the absolute `rootDir`.
 *
 * Implementations should make `putAnchor` monotonic (never regress to a
 * lower `seq`) when the backing store permits; a stale/lagging anchor is
 * benign for `verify`, but a regressed one weakens truncation detection.
 * PRODUCTION SHOULD SUPPLY A WORM-BACKED IMPLEMENTATION — the bundled
 * {@link InMemoryAnchorStore} is for tests/dev only and offers no
 * tamper-resistance on its own.
 */
export interface AnchorStore {
  putAnchor(logId: string, anchor: AnchorRecord): Promise<void>;
  getAnchor(logId: string): Promise<AnchorRecord | undefined>;
}

/**
 * Reference {@link AnchorStore} that keeps the latest anchor per `logId`
 * in process memory, monotonic on `seq`. Useful for tests and for wiring
 * the `verify` cross-check in a single process; it provides NO durability
 * or tamper-resistance and MUST NOT be relied on for non-repudiation in
 * production — back the seam with a WORM store instead.
 */
export class InMemoryAnchorStore implements AnchorStore {
  private readonly anchors: Map<string, AnchorRecord>;

  constructor() {
    this.anchors = new Map<string, AnchorRecord>();
  }

  async putAnchor(logId: string, anchor: AnchorRecord): Promise<void> {
    const existing = this.anchors.get(logId);
    // Monotonic: never let a later put regress the committed tip backwards.
    if (existing !== undefined && anchor.seq < existing.seq) return;
    this.anchors.set(logId, { seq: anchor.seq, hash: anchor.hash });
  }

  async getAnchor(logId: string): Promise<AnchorRecord | undefined> {
    return this.anchors.get(logId);
  }
}

// File-backed AnchorStore (append-only anchors under a directory) — the
// durable sibling of InMemoryAnchorStore. See file-anchor-store.ts for the
// layout + threat model (its tamper-resistance is exactly the directory's).
export {
  FileAnchorStore,
  FileAnchorStoreError,
  type FileAnchorStoreOptions,
} from "./file-anchor-store";

export type OpenAuditLogOptions = {
  readonly rootDir: string;
  readonly now?: () => number;
  readonly day?: () => string;
  /**
   * Optional off-host anchor store. When supplied, every `append`
   * best-effort mirrors the new tail `{ seq, hash }` to it (a put failure
   * is swallowed so the durable local write is never blocked). Pass the
   * same store + `logId` to {@link verify} to cross-check the chain.
   */
  readonly anchorStore?: AnchorStore;
  /**
   * Key under which this log's anchor is stored in `anchorStore`. Defaults
   * to the absolute `rootDir`, letting one store hold many logs.
   */
  readonly logId?: string;
};

export interface AuditLog {
  append(input: AppendInput): Promise<AuditRecord>;
  read(opts?: { readonly day?: string }): AsyncIterable<AuditRecord>;
}

function hashBody(
  body: { ts: number; version: 1; kind: AuditKind; seq: number; payload: unknown },
  prevHash: string,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update("|")
    .update(JSON.stringify(body))
    .digest("hex");
}

/**
 * Recompute a record's hash from its own fields — the exact derivation
 * `append` and `verify` use. Lets an external consumer (e.g.
 * `@crewhaus/compliance-controls`) re-check a record's body↔hash consistency
 * without re-reading the log files. Compare the result against `record.hash`:
 * a mismatch means the body (payload/kind/ts/seq) was altered after signing.
 */
export function recomputeRecordHash(record: AuditRecord): string {
  const body = {
    ts: record.ts,
    version: record.version,
    kind: record.kind,
    seq: record.seq,
    payload: record.payload,
  };
  return hashBody(body, record.prevHash);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function indexPath(rootDir: string): string {
  return join(rootDir, "_chain-tail.json");
}

type ChainTail = { readonly day: string; readonly hash: string; readonly seq: number };

function readChainTail(rootDir: string): ChainTail | undefined {
  const p = indexPath(rootDir);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as ChainTail;
}

function writeChainTail(rootDir: string, day: string, hash: string, seq: number): void {
  const p = indexPath(rootDir);
  writeFileSync(p, JSON.stringify({ day, hash, seq }), { mode: 0o600 });
}

export async function openAuditLog(opts: OpenAuditLogOptions): Promise<AuditLog> {
  if (typeof opts.rootDir !== "string" || opts.rootDir === "") {
    throw new AuditLogError("rootDir is required");
  }
  mkdirSync(opts.rootDir, { recursive: true, mode: 0o700 });
  const now = opts.now ?? ((): number => Date.now());
  const day = opts.day ?? todayStr;
  const anchorStore = opts.anchorStore;
  const logId = opts.logId ?? opts.rootDir;

  return {
    async append(input: AppendInput): Promise<AuditRecord> {
      const tail = readChainTail(opts.rootDir);
      const prevHash = tail?.hash ?? GENESIS_HASH;
      // First record gets seq 0; thereafter strictly increment the tail's
      // seq. A pre-`seq` anchor (`seq` absent) is treated as -1 so the next
      // record starts the gapless run at 0.
      const seq = (tail?.seq ?? -1) + 1;
      const body = {
        ts: now(),
        version: 1 as const,
        kind: input.kind,
        seq,
        payload: input.payload,
      };
      const hash = hashBody(body, prevHash);
      const record: AuditRecord = { ...body, prevHash, hash };
      // Evaluate the day selector exactly once: a second call could straddle
      // a midnight boundary (with the default UTC-date `day`), writing the
      // record to one day's file while committing the tail under the next
      // day — leaving the JSONL filename and the anchor's `day` inconsistent.
      const today = day();
      const file = join(opts.rootDir, `${today}.jsonl`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      writeChainTail(opts.rootDir, today, hash, seq);
      // Best-effort: mirror the new tail to the off-host anchor. A failure
      // here (network/WORM hiccup) must NOT fail the durable local append —
      // the chain remains internally verifiable, and a lagging external
      // anchor is benign for `verify` (it only ever flags an anchor that is
      // AHEAD of a truncated chain, never one that trails).
      if (anchorStore !== undefined) {
        try {
          await anchorStore.putAnchor(logId, { seq, hash });
        } catch {
          // Swallowed by design — see comment above.
        }
      }
      return record;
    },
    read(readOpts: { day?: string } = {}): AsyncIterable<AuditRecord> {
      return readDay(opts.rootDir, readOpts.day ?? day());
    },
  };
}

async function* readDay(rootDir: string, day: string): AsyncIterable<AuditRecord> {
  const file = join(rootDir, `${day}.jsonl`);
  if (!existsSync(file)) return;
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const raw of rl) {
      lineNumber += 1;
      if (raw === "") continue;
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(raw) as AuditRecord;
      } catch (err) {
        throw new RuntimeError(`audit-log: malformed JSON on line ${lineNumber} of ${file}`, err);
      }
      yield parsed;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

export type VerifyResult =
  | {
      readonly ok: true;
      readonly recordsChecked: number;
      /**
       * Whether the surviving chain was matched against the independent
       * on-host `_chain-tail.json` anchor. `false` means the anchor was
       * absent, so tail-truncation could NOT be ruled out — `ok: true` here
       * attests only that the survivors are internally consistent and
       * gapless from 0, not that nothing was dropped off the end. Callers
       * that need non-repudiation must treat `ok && !anchorChecked` as a
       * limitation, not a clean bill of health. (And see the file header:
       * even a present on-host anchor is rewritable by a same-uid attacker.)
       */
      readonly anchorChecked: boolean;
      /**
       * Whether an off-host {@link AnchorStore} was supplied AND held an
       * anchor that was cross-checked against the surviving chain. `false`
       * means no store was passed, or it had no anchor yet — so a same-uid
       * lockstep rewrite of the on-host anchor could NOT be ruled out. Only
       * `ok && externalAnchorChecked` attests that an anchor the writer
       * cannot rewrite agreed with the chain tip.
       */
      readonly externalAnchorChecked: boolean;
    }
  | {
      readonly ok: false;
      readonly recordsChecked: number;
      readonly file: string;
      readonly line: number;
      readonly reason: string;
    };

/**
 * Optional cross-check inputs for {@link verify}. Supply the same
 * `anchorStore` (and matching `logId`) used when the log was opened to
 * have `verify` consult the off-host anchor in addition to the on-host
 * `_chain-tail.json`. Both are optional and back-compatible — calling
 * `verify(rootDir)` keeps the original on-host-only behaviour.
 */
export type VerifyOptions = {
  readonly anchorStore?: AnchorStore;
  readonly logId?: string;
};

/**
 * Walk every `<rootDir>/*.jsonl` chain, verifying each record's
 * `hash` against `SHA-256(prevHash || canonical-body)`, that `prevHash`
 * matches the previous record's `hash`, and that `seq` is gapless from
 * 0. After the walk, the surviving chain's last `{ hash, seq }` is
 * matched against the independent on-host `_chain-tail.json` anchor so a
 * dropped suffix (tail truncation / newest-day deletion) is caught.
 *
 * If a `{ anchorStore }` is supplied (see {@link VerifyOptions}), the
 * off-host anchor is consulted IN ADDITION to `_chain-tail.json`: when it
 * witnesses a `seq` the surviving chain no longer reaches — or a hash that
 * disagrees with the chain's record AT the anchored seq — verify FAILS.
 * This catches a tail truncation that ALSO rewrote the on-host anchor in
 * lockstep, since a same-uid attacker cannot reach into the external
 * (ideally WORM) store. An external anchor that merely lags BEHIND newer
 * appends (the benign best-effort case) is not a failure, but even a
 * lagging anchor's hash is matched against the record at its seq — so a
 * chain rebuilt from scratch and then extended past the anchored height
 * (rewrite + fresh appends) is still caught.
 *
 * Returns the first broken link (file + line number + reason), or
 * `{ ok: true }` if the chain is intact. On success, `anchorChecked`
 * reports whether the on-host tail anchor was present and matched, and
 * `externalAnchorChecked` whether an off-host anchor was supplied and
 * cross-checked; `false` on either means that gap could not be ruled out
 * (a limitation, not a pass — see the file header on same-uid tamper).
 */
export async function verify(rootDir: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  // Fetch the external anchor BEFORE the walk so the walk can capture the
  // surviving chain's hash AT the anchored seq — the lag case (anchor.seq <
  // lastSeq) is only benign when that record's hash still matches what the
  // store witnessed; comparing tips alone would let a wholesale chain rewrite
  // hide behind a few fresh appends.
  const externalAnchor = await fetchExternalAnchor(rootDir, options);
  if (!existsSync(rootDir)) {
    // No local chain at all. Even so, an external anchor may witness records
    // that a wholesale deletion (rootDir rm'd) destroyed — cross-check it
    // against the empty (GENESIS-tipped, seq -1) chain before passing.
    const empty = crossCheckExternalAnchor(externalAnchor, GENESIS_HASH, -1, undefined);
    if (empty !== undefined && !empty.ok) {
      return {
        ok: false,
        recordsChecked: 0,
        file: empty.file,
        line: empty.line,
        reason: empty.reason,
      };
    }
    return {
      ok: true,
      recordsChecked: 0,
      anchorChecked: false,
      externalAnchorChecked: empty?.externalAnchorChecked ?? false,
    };
  }
  const files = readdirSync(rootDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  let prevHash = GENESIS_HASH;
  let expectedSeq = 0;
  let recordsChecked = 0;
  // The surviving chain's hash at the externally-anchored seq (captured in
  // the walk below), for the lag-case cross-check.
  let hashAtAnchoredSeq: string | undefined;
  for (const f of files) {
    const file = join(rootDir, f);
    const stream = createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let lineNumber = 0;
    try {
      for await (const raw of rl) {
        lineNumber += 1;
        if (raw === "") continue;
        let r: AuditRecord;
        try {
          r = JSON.parse(raw) as AuditRecord;
        } catch (err) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `malformed JSON: ${(err as Error).message}`,
          };
        }
        if (r.prevHash !== prevHash) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `prevHash mismatch — expected "${prevHash}", got "${r.prevHash}"`,
          };
        }
        if (r.seq !== expectedSeq) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `seq gap — expected ${expectedSeq}, got ${r.seq}`,
          };
        }
        const body = { ts: r.ts, version: r.version, kind: r.kind, seq: r.seq, payload: r.payload };
        const expected = hashBody(body, r.prevHash);
        if (r.hash !== expected) {
          stream.close();
          rl.close();
          return {
            ok: false,
            recordsChecked,
            file,
            line: lineNumber,
            reason: `hash mismatch — expected "${expected}", got "${r.hash}"`,
          };
        }
        if (externalAnchor !== undefined && r.seq === externalAnchor.seq) {
          hashAtAnchoredSeq = r.hash;
        }
        prevHash = r.hash;
        expectedSeq = r.seq + 1;
        recordsChecked += 1;
      }
    } finally {
      rl.close();
      stream.close();
    }
  }

  const lastSeq = expectedSeq - 1;

  // Off-host anchor check FIRST: the external store is the only commitment a
  // same-uid attacker cannot rewrite, so it is what catches a truncation that
  // also rewrote `_chain-tail.json` in lockstep. (See file header.)
  const external = crossCheckExternalAnchor(externalAnchor, prevHash, lastSeq, hashAtAnchoredSeq);
  if (external !== undefined && !external.ok) {
    return {
      ok: false,
      recordsChecked,
      file: external.file,
      line: external.line,
      reason: external.reason,
    };
  }
  const externalAnchorChecked = external?.externalAnchorChecked ?? false;

  // On-host anchor check: compare the surviving chain's last { hash, seq }
  // against the independent _chain-tail.json. A truncation that drops trailing
  // records leaves the survivors internally consistent, so this anchor — not
  // the walk above — is what catches it. A missing anchor is reported
  // (anchorChecked: false), never silently treated as a clean pass. NOTE: an
  // on-host anchor is rewritable by a same-uid attacker (see header); it
  // defends only against truncation by a party that does NOT also rewrite the
  // anchor in lockstep — which is exactly what the external anchor above adds.
  // A corrupt/partially-written `_chain-tail.json` (truncated by a crash, or
  // garbled by an attacker) must be REPORTED as a broken link, not crash the
  // verifier with an unhandled JSON.parse throw — mirroring how a malformed
  // JSONL line is surfaced above. Throwing here would let a one-byte anchor
  // corruption turn `verify` into a denial of service.
  let tail: ChainTail | undefined;
  try {
    tail = readChainTail(rootDir);
  } catch (err) {
    return {
      ok: false,
      recordsChecked,
      file: indexPath(rootDir),
      line: 0,
      reason: `chain-tail anchor unreadable — ${(err as Error).message}`,
    };
  }
  if (tail === undefined) {
    return { ok: true, recordsChecked, anchorChecked: false, externalAnchorChecked };
  }
  if (tail.hash !== prevHash) {
    return {
      ok: false,
      recordsChecked,
      file: indexPath(rootDir),
      line: 0,
      reason:
        `chain-tail anchor mismatch — anchor records hash "${tail.hash}" ` +
        `but surviving chain ends at "${prevHash}" (records were dropped from the tail)`,
    };
  }
  // The seq field is optional in legacy anchors; only assert when present.
  if (typeof tail.seq === "number" && tail.seq !== lastSeq) {
    return {
      ok: false,
      recordsChecked,
      file: indexPath(rootDir),
      line: 0,
      reason:
        `chain-tail anchor mismatch — anchor records seq ${tail.seq} ` +
        `but surviving chain ends at seq ${lastSeq} (records were dropped from the tail)`,
    };
  }
  return { ok: true, recordsChecked, anchorChecked: true, externalAnchorChecked };
}

type ExternalAnchorCheck =
  | { readonly ok: true; readonly externalAnchorChecked: boolean }
  | {
      readonly ok: false;
      readonly file: string;
      readonly line: number;
      readonly reason: string;
      readonly externalAnchorChecked: boolean;
    };

/**
 * Read the off-host anchor for this log, if a store was supplied. Returns
 * `undefined` when there is no store, no anchor yet, or the backend threw —
 * "anchor unavailable" degrades to not-checked (`externalAnchorChecked:
 * false` downstream), never to a fabricated pass or failure.
 */
async function fetchExternalAnchor(
  rootDir: string,
  options: VerifyOptions,
): Promise<AnchorRecord | undefined> {
  const store = options.anchorStore;
  if (store === undefined) return undefined;
  const logId = options.logId ?? rootDir;
  try {
    return await store.getAnchor(logId);
  } catch {
    // Anchor backend unavailable: cannot rule the truncation gap in OR out,
    // so report "not checked" rather than fabricating a pass or a failure.
    return undefined;
  }
}

/**
 * Cross-check the surviving chain (tip `tipHash` at `lastSeq`; an empty
 * chain is `GENESIS_HASH` at `-1`) against a fetched off-host anchor.
 * `hashAtAnchoredSeq` is the surviving chain's hash at `anchor.seq`, captured
 * during the verify walk (undefined when the chain never reaches that seq).
 *
 * Threat model — the store witnesses the highest tail the writer published.
 *  - external `seq > lastSeq`  → the chain no longer reaches a record the
 *    anchor saw ⇒ tail truncation (even if `_chain-tail.json` was rewritten
 *    in lockstep, which the attacker cannot do to the external store) → FAIL.
 *  - external `seq === lastSeq` but `hash !== tipHash` → the tip was rewritten
 *    in place at the anchored height → FAIL.
 *  - external `seq < lastSeq` AND `hash === hashAtAnchoredSeq` → the anchor
 *    merely lags behind newer appends (benign best-effort `putAnchor` lag)
 *    → pass.
 *  - external `seq < lastSeq` but `hash !== hashAtAnchoredSeq` → the chain
 *    was rewritten from (at or before) the anchored height and then extended
 *    with fresh appends — lag alone is NOT proof of innocence → FAIL.
 *
 * Returns `undefined` when no anchor was available (store missing, empty, or
 * unreachable); otherwise a result carrying `externalAnchorChecked: true`
 * plus, on mismatch, the failure fields.
 */
function crossCheckExternalAnchor(
  anchor: AnchorRecord | undefined,
  tipHash: string,
  lastSeq: number,
  hashAtAnchoredSeq: string | undefined,
): ExternalAnchorCheck | undefined {
  if (anchor === undefined) return { ok: true, externalAnchorChecked: false };

  if (anchor.seq > lastSeq) {
    return {
      ok: false,
      file: "<external-anchor>",
      line: 0,
      reason: `external anchor mismatch — store witnesses seq ${anchor.seq} (hash "${anchor.hash}") but surviving chain ends at seq ${lastSeq} (records were dropped from the tail and the on-host anchor rewritten in lockstep)`,
      externalAnchorChecked: true,
    };
  }
  if (anchor.seq === lastSeq && anchor.hash !== tipHash) {
    return {
      ok: false,
      file: "<external-anchor>",
      line: 0,
      reason: `external anchor mismatch — store records hash "${anchor.hash}" at seq ${anchor.seq} but surviving chain tip is "${tipHash}" (the tail record was rewritten in place)`,
      externalAnchorChecked: true,
    };
  }
  if (anchor.seq < lastSeq && anchor.hash !== hashAtAnchoredSeq) {
    return {
      ok: false,
      file: "<external-anchor>",
      line: 0,
      reason:
        `external anchor mismatch — store records hash "${anchor.hash}" at seq ${anchor.seq} ` +
        `but the surviving chain's record at that seq hashes to ${
          hashAtAnchoredSeq === undefined ? "nothing (seq not reached)" : `"${hashAtAnchoredSeq}"`
        } (the chain was rewritten below the anchored height and extended with fresh appends)`,
      externalAnchorChecked: true,
    };
  }
  // Matched tip, or benign lag whose anchored record still matches.
  return { ok: true, externalAnchorChecked: true };
}
