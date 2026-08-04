/**
 * M3 · SECURITY — the audit chain, egress review, the PII tuner, the
 * justification console, the security corpus + sandbox checks, the onchain
 * safety consoles, compliance evidence, retention, and the SLO monitor.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY BE SERVED, AND WHAT MAY NOT
 * ---------------------------------------------------------------------------
 * RAW AUDIT FILES ARE NEVER SERVED OVER HTTP. This module serves RENDERED
 * RECORDS — decoded fields, masked payloads, truncated hashes — and never a
 * file's bytes, a file's name, or a path. The integrity CLAIM comes from
 * `@crewhaus/audit-log`'s `verify()`, and per-record body↔hash consistency
 * from its `recomputeRecordHash()`: both are the package's own derivations,
 * so the console cannot quietly disagree with the verifier.
 *
 * The browse walk is this package's capped, torn-line-tolerant JSONL reader
 * rather than `openAuditLog().read()`, for three reasons that are all
 * correctness, not preference: `openAuditLog` MKDIRS its root (a GET must
 * not create the audit store), `read()` covers exactly one DAY (browsing
 * needs the chain), and it THROWS on a single malformed line (one torn tail
 * would blank the whole panel). Every file is realpath-contained per file
 * before it is opened.
 *
 * `audit verify` is reported HONESTLY, including its designed limits.
 * `anchorChecked: false` means tail truncation could not be ruled out;
 * `externalAnchorChecked: false` means no off-host anchor was consulted.
 * Neither is a failure and neither is hidden — a verifier that overstates
 * its guarantee is worse than no verifier.
 *
 * EGRESS RECORDS CARRY LINEAGE, NOT PAYLOADS. An `egress_decision` record
 * deliberately does not contain the outbound body. The review console
 * triages lineage summaries and SAYS SO, rather than rendering an empty
 * "body" field that reads like data loss.
 *
 * THE DESTRUCTIVE LADDER APPLIES IN FULL:
 *   - `retention sweep` / `retention purge` are DRY-RUN FIRST. The manager
 *     runs `--dry-run`, shows the plan, and only then offers the real run as
 *     a SECOND, typed-confirm gesture. Each real run self-audits as a
 *     `retention_enforcement` record.
 *   - `pii tune` and `onchain tune` write POLICY, so both show a
 *     before/after preview and neither writes without confirmation.
 *     `transaction_policy` additionally lives in the SPEC and is
 *     human-owned, so this module never writes it — it hands the operator
 *     the edit and points at the spec write path, which owns the diff
 *     interstitial and the re-validation.
 *
 * `justification preflight` must never execute the tool, and does not: it
 * projects from the durable `permission_justification_evaluated` record and
 * the spec's own permission rules.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type AuditRecord, recomputeRecordHash, verify } from "@crewhaus/audit-log";
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { MAX_JSONL_LINES, SAFE_SEGMENT_RE } from "./constants";
import { containProbe, harnessDirOf, m3Base, readHarnessSpec } from "./creds-ops";
import { HttpError } from "./http";
import { readJsonlCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { isDryRun, jobArg, requireString, requireTypedConfirm } from "./m3";
import { maskDeep, maskText } from "./mask";
import { asNumber, asRecord, asString, at } from "./yaml-scan";

/** Cap on rendered audit records per request. The chain can be enormous and
 *  a browse is a browse, not an export. */
const MAX_AUDIT_RECORDS = 500;

/** Hash prefix length in a rendered record. A full 64-hex digest is noise on
 *  screen; the prefix is enough to eyeball continuity, and `verify()` — not
 *  the reader — is what actually checks the chain. */
const HASH_PREFIX = 12;

// ---------------------------------------------------------------------------
// The audit chain
// ---------------------------------------------------------------------------

const AUDIT_DIR = [".crewhaus", "audit"] as const;

/** True when a payload is an `@crewhaus/audit-encryption` envelope rather
 *  than a plain record body. Detected structurally so the badge does not
 *  need the encryption package as a dependency. */
function isEncryptedPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  if (record === undefined) return false;
  return (
    typeof record["encryptedPayload"] === "string" &&
    typeof record["wrappedDek"] === "string" &&
    typeof record["iv"] === "string"
  );
}

type RenderedRecord = {
  readonly seq: number;
  readonly ts: string | null;
  readonly kind: string;
  readonly hash: string;
  readonly prevHash: string;
  /** Body↔hash consistency, recomputed with the package's own derivation. */
  readonly hashOk: boolean;
  readonly encrypted: boolean;
  readonly payload: unknown;
};

type AuditFold = {
  readonly records: RenderedRecord[];
  readonly present: boolean;
  readonly truncated: boolean;
  readonly torn: number;
  readonly kinds: Record<string, number>;
  readonly encryptedCount: number;
};

/** Fold the chain's day files into rendered records. Newest last, so the
 *  chain reads in the order it was written. */
function foldAudit(ctx: M3Context, kindFilter?: string): AuditFold {
  const contain = containProbe(ctx);
  const root = contain([...AUDIT_DIR]);
  const empty: AuditFold = {
    records: [],
    present: false,
    truncated: false,
    torn: 0,
    kinds: {},
    encryptedCount: 0,
  };
  if (root === undefined || !existsSync(root)) return empty;
  let files: string[];
  try {
    files = readdirSync(root)
      .filter((name) => name.endsWith(".jsonl") && SAFE_SEGMENT_RE.test(name))
      .sort();
  } catch {
    return empty;
  }
  const records: RenderedRecord[] = [];
  const kinds: Record<string, number> = {};
  let truncated = false;
  let torn = 0;
  let encryptedCount = 0;
  for (const name of files) {
    // Per FILE: a listed name can be a symlink out of the harness tree.
    const path = contain([...AUDIT_DIR, name]);
    if (path === undefined) continue;
    const read = readJsonlCapped(path, MAX_JSONL_LINES);
    truncated = truncated || read.truncated;
    torn += read.tornCount;
    for (const object of read.objects) {
      const record = object as Partial<AuditRecord>;
      const kind = typeof record.kind === "string" ? record.kind : "unknown";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const encrypted = isEncryptedPayload(record.payload);
      if (encrypted) encryptedCount += 1;
      if (kindFilter !== undefined && kind !== kindFilter) continue;
      if (records.length >= MAX_AUDIT_RECORDS) {
        truncated = true;
        continue;
      }
      const hash = typeof record.hash === "string" ? record.hash : "";
      const hashOk =
        hash !== "" &&
        typeof record.prevHash === "string" &&
        typeof record.seq === "number" &&
        typeof record.ts === "number" &&
        recomputeRecordHash(record as AuditRecord) === hash;
      records.push({
        seq: typeof record.seq === "number" ? record.seq : -1,
        ts: typeof record.ts === "number" ? new Date(record.ts).toISOString() : null,
        kind,
        hash: hash.slice(0, HASH_PREFIX),
        prevHash: typeof record.prevHash === "string" ? record.prevHash.slice(0, HASH_PREFIX) : "",
        hashOk,
        encrypted,
        // A payload is arbitrary agent-supplied JSON: masked here as well as
        // at the dispatch site, because a justification body is free text.
        payload: encrypted ? { encrypted: true } : maskDeep(record.payload),
      });
    }
  }
  return {
    records,
    present: files.length > 0,
    truncated,
    torn,
    kinds,
    encryptedCount,
  };
}

/** `GET /api/h/:id/audit` — the audit chain panel. */
export const audit: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const kindFilter = ctx.query.get("kind") ?? undefined;
  const fold = foldAudit(ctx, kindFilter ?? undefined);
  return {
    ...m3Base(
      fold.present,
      fold.present
        ? null
        : "this harness has no audit chain yet — it appears the first time the agent makes a decision worth evidencing",
      "crewhaus audit verify",
    ),
    records: fold.records,
    kinds: Object.entries(fold.kinds)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([kind, count]) => ({ kind, count })),
    kindFilter: kindFilter ?? null,
    truncated: fold.truncated,
    tornLines: fold.torn,
    encryption: {
      on: fold.encryptedCount > 0,
      encryptedRecords: fold.encryptedCount,
      note:
        fold.encryptedCount > 0
          ? "payloads are sealed by @crewhaus/audit-encryption — the chain is still verifiable, but the bodies are not readable here"
          : null,
    },
    rawFilesNote:
      "records are RENDERED here; the underlying chain files are never served over HTTP",
  };
};

/**
 * `POST /api/h/:id/audit/verify` — run `audit verify`.
 *
 * Run inline rather than through the job queue: this is a library call over
 * a local file tree with no side effects, and an operator asking "is the
 * chain intact" deserves the answer in the response rather than a job id.
 *
 * Both anchor flags are reported with their meaning attached. `ok: true`
 * with `anchorChecked: false` attests that the SURVIVING records are
 * internally consistent and gapless from zero — not that nothing was
 * dropped off the end.
 */
export const auditVerify: M3Handler = async (ctx) => {
  harnessDirOf(ctx);
  const contain = containProbe(ctx);
  const root = contain([...AUDIT_DIR]);
  if (root === undefined || !existsSync(root)) {
    return {
      ok: true,
      present: false,
      recordsChecked: 0,
      anchorChecked: false,
      externalAnchorChecked: false,
      note: "there is no audit chain to verify yet",
      limitations: [],
    };
  }
  const result = await verify(root);
  if (!result.ok) {
    return {
      ok: false,
      present: true,
      recordsChecked: result.recordsChecked,
      anchorChecked: false,
      externalAnchorChecked: false,
      // `file` names a chain FILE. It is reported as a basename so the panel
      // can say where the break is without serving a path.
      brokenAt: { line: result.line, file: basenameOf(result.file) },
      reason: maskText(result.reason),
      limitations: [],
    };
  }
  return {
    ok: true,
    present: true,
    recordsChecked: result.recordsChecked,
    anchorChecked: result.anchorChecked,
    externalAnchorChecked: result.externalAnchorChecked,
    limitations: [
      result.anchorChecked
        ? null
        : "anchorChecked: false — the on-host tail anchor was absent, so records dropped off the END of the chain could not be ruled out",
      result.externalAnchorChecked
        ? null
        : "externalAnchorChecked: false — no off-host anchor was consulted, so a same-uid rewrite that also rewrote the local anchor could not be ruled out. This is a DESIGNED limitation of a local verifier, not a failure",
    ].filter((line): line is string => line !== null),
  };
};

/** Last path segment, for reporting WHERE a chain broke without serving a
 *  filesystem path. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ---------------------------------------------------------------------------
// Egress review
// ---------------------------------------------------------------------------

const EGRESS_TRIAGE = [".crewhaus", "egress-review", "triage.jsonl"] as const;

/** Stable id for one egress decision: the audit chain's own sequence number
 *  is the only identifier the record has, and it is unique per chain. */
function egressId(seq: number): string {
  return `egr_${seq}`;
}

/** The operator's triage ledger, folded. Append-only: the audit decision is
 *  immutable, so a verdict is a NEW record beside it, never an edit. */
function readTriage(ctx: M3Context): Map<string, Record<string, unknown>> {
  const path = containProbe(ctx)([...EGRESS_TRIAGE]);
  const out = new Map<string, Record<string, unknown>>();
  if (path === undefined || !existsSync(path)) return out;
  for (const object of readJsonlCapped(path).objects) {
    const record = asRecord(object);
    const id = asString(record?.["decisionId"]);
    if (record === undefined || id === undefined) continue;
    out.set(id, record); // later lines win — the ledger folds, it does not edit
  }
  return out;
}

/** `GET /api/h/:id/security/egress` — the egress review console. */
export const egress: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const fold = foldAudit(ctx, "egress_decision");
  const triage = readTriage(ctx);
  const decisions = fold.records.map((record) => {
    const payload = asRecord(record.payload) ?? {};
    const origins = payload["originsFound"];
    const id = egressId(record.seq);
    const settled = triage.get(id);
    return {
      decisionId: id,
      seq: record.seq,
      ts: record.ts,
      sinkId: asString(payload["sinkId"]) ?? null,
      sinkScope: asString(payload["sinkScope"]) ?? null,
      verdict: asString(payload["verdict"]) ?? null,
      matchCount: asNumber(payload["matchCount"]) ?? null,
      /** The LINEAGE: which origins the classifier traced into this call. */
      origins: Array.isArray(origins) ? origins.map(String) : [],
      triage:
        settled === undefined
          ? null
          : {
              verdict: asString(settled["verdict"]) ?? null,
              note: asString(settled["note"]) ?? null,
              by: asString(settled["by"]) ?? null,
              at: asString(settled["at"]) ?? null,
            },
    };
  });
  return {
    ...m3Base(
      fold.present,
      decisions.length === 0
        ? "no egress decisions have been recorded — the classifier writes one per non-pass verdict"
        : null,
      "crewhaus egress review",
    ),
    decisions,
    open: decisions.filter((decision) => decision.triage === null).length,
    payloadNote:
      "an egress_decision record carries LINEAGE (which origins fed the call), never the outbound body — that omission is deliberate, not missing data",
    truncated: fold.truncated,
  };
};

/**
 * `POST /api/h/:id/security/egress/:decisionId` — triage one decision.
 *
 * The decision itself is a record in a hash-chained log and is immutable.
 * A verdict therefore APPENDS a triage record beside it; a decision id that
 * matches nothing is reported back rather than recorded, because a triage
 * ledger full of verdicts on records that do not exist is worse than empty.
 */
export const egressReview: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const decisionId = ctx.params["decisionId"] ?? "";
  const verdict = requireString(ctx.body, "verdict");
  const allowed = ["allow", "block", "acknowledge", "needs-review"];
  if (!allowed.includes(verdict)) {
    throw new HttpError(400, `"verdict" must be one of: ${allowed.join(", ")}`);
  }
  const rawNote = ctx.body["note"];
  const note = typeof rawNote === "string" ? maskText(rawNote.slice(0, 2000)) : null;
  const known = new Set(foldAudit(ctx, "egress_decision").records.map((r) => egressId(r.seq)));
  if (!known.has(decisionId)) {
    return {
      recorded: false,
      decisionId,
      code: "no_such_decision",
      reason: "no egress_decision with that id exists in this harness's audit chain",
      expected: true,
    };
  }
  const path = ctx.contain([...EGRESS_TRIAGE]);
  const record = {
    schemaVersion: 1,
    decisionId,
    verdict,
    note,
    by: ctx.operator,
    at: new Date(ctx.now()).toISOString(),
  };
  appendJsonl(path, record);
  return { recorded: true, decisionId, triage: record };
};

/** Append one line to a JSONL ledger, creating it (and its directory) 0600
 *  on first write. Append-only by construction: nothing here rewrites a
 *  line, so a torn write costs one record and never the ledger. */
function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// PII policy
// ---------------------------------------------------------------------------

const PII_POLICY = [".crewhaus", "pii-policy.json"] as const;

function readJsonFile(path: string | undefined): unknown {
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** `GET /api/h/:id/security/pii` — the redactor's policy, as written. */
export const pii: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const policy = readJsonFile(containProbe(ctx)([...PII_POLICY]));
  const record = asRecord(policy);
  const allow = record?.["allow"];
  return {
    ...m3Base(
      policy !== undefined,
      policy === undefined
        ? "this harness has no pii-policy.json — the redactor is running on its built-in detector set"
        : null,
      "crewhaus pii tune --write",
    ),
    policy: maskDeep(policy ?? null),
    allowEntries: Array.isArray(allow) ? allow.length : 0,
    /** The spec's own redaction switch, when it declares one. */
    specRedaction: asRecord(at(spec.doc, ["security", "pii"])) ?? null,
    hitCounts: null,
    hitCountsNote:
      "hit counts are derived by re-running the detector over durable session content, which is what `crewhaus pii tune` does — the manager does not re-derive them on a page load",
    valuesNote:
      "an allow entry stores kind + HMAC hash, never the raw value — nothing here can be turned back into a person's data",
  };
};

/**
 * `POST /api/h/:id/security/pii` — `pii tune`.
 *
 * `dryRun` DEFAULTS TO TRUE and the before/after preview is mandatory: a
 * redaction policy decides what leaves the process, and an operator who did
 * not see the diff did not consent to it. The real write additionally needs
 * the typed harness name.
 */
export const piiTune: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const proposed = ctx.body["policy"];
  if (asRecord(proposed) === undefined) throw new HttpError(400, 'missing "policy" object');
  const path = ctx.contain([...PII_POLICY]);
  const current = readJsonFile(path) ?? null;
  const preview = {
    before: maskDeep(current),
    after: maskDeep(proposed),
    changed: JSON.stringify(current) !== JSON.stringify(proposed),
  };
  if (isDryRun(ctx.body)) {
    return {
      dryRun: true,
      wrote: false,
      preview,
      confirmWith: spec.specName,
      note: "nothing was written — send dryRun:false with the typed harness name to apply this policy",
      deriveVerb: "crewhaus pii tune",
    };
  }
  requireTypedConfirm(ctx.body, spec.specName);
  // A harness that has never been run has no `.crewhaus/` yet, and a policy
  // write must not 500 on that — the directory IS the store.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(proposed, null, 2)}\n`, { mode: 0o600 });
  return { dryRun: false, wrote: true, preview };
};

// ---------------------------------------------------------------------------
// The justification console
// ---------------------------------------------------------------------------

const JUSTIFICATION_KIND = "permission_justification_evaluated";

type JustificationRow = {
  readonly toolName: string;
  readonly verdict: string;
  readonly judgeModel: string | null;
  readonly confidence: number | null;
  readonly justification: string;
  readonly reason: string | null;
  readonly ts: string | null;
  readonly seq: number;
};

function justificationRows(ctx: M3Context): JustificationRow[] {
  return foldAudit(ctx, JUSTIFICATION_KIND).records.map((record) => {
    const payload = asRecord(record.payload) ?? {};
    return {
      toolName: asString(payload["toolName"]) ?? "unknown",
      verdict: asString(payload["verdict"]) ?? "unknown",
      judgeModel: asString(payload["judgeModel"]) ?? null,
      confidence: asNumber(payload["confidence"]) ?? null,
      // The justification IS the audit artifact and is stored verbatim, so
      // it reaches this response as FREE TEXT and gets the value-shape
      // masker: an agent that pasted a token into its own rationale must
      // not have it re-served here.
      justification: maskText(asString(payload["justification"]) ?? ""),
      reason: payload["reason"] === undefined ? null : maskText(String(payload["reason"])),
      ts: record.ts,
      seq: record.seq,
    };
  });
}

/** `GET /api/h/:id/security/justification` — the console. */
export const justification: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const rows = justificationRows(ctx);
  const byTool = new Map<string, { allow: number; deny: number }>();
  for (const row of rows) {
    const tally = byTool.get(row.toolName) ?? { allow: 0, deny: 0 };
    if (row.verdict === "deny") tally.deny += 1;
    else tally.allow += 1;
    byTool.set(row.toolName, tally);
  }
  return {
    ...m3Base(
      rows.length > 0 || asRecord(at(spec.doc, ["security", "justification"])) !== undefined,
      rows.length === 0
        ? "no justification records yet — the intent gate writes one per evaluated tool call"
        : null,
      "crewhaus justification calibrate",
    ),
    config: asRecord(at(spec.doc, ["security", "justification"])) ?? null,
    records: rows,
    byTool: [...byTool.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([toolName, tally]) => ({ toolName, ...tally })),
    linkNote:
      "these records carry no session id, so they cannot be linked to an individual turn — the join the durable data supports is per TOOL",
  };
};

/**
 * `POST /api/h/:id/security/justification/calibrate` — `justification
 * calibrate`.
 *
 * The calibration itself replays the judge against the per-tool outcome
 * proxy, which is a real analysis over session history, so it goes through
 * the job queue. Without `apply` this route answers with the shape the
 * calibration would tune plus the current setting, so the operator sees the
 * before side without paying for the run.
 */
export const justificationCalibrate: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const config = asRecord(at(spec.doc, ["security", "justification"]));
  const apply = ctx.body["apply"] === true;
  const rows = justificationRows(ctx);
  const preview = {
    records: rows.length,
    denials: rows.filter((row) => row.verdict === "deny").length,
    currentThreshold: asNumber(config?.["threshold"]) ?? null,
    currentJudge: asString(config?.["judge"]) ?? null,
  };
  if (!apply) {
    return {
      submitted: false,
      preview,
      note: "this is the BEFORE side; submit with apply:true to run the calibration over session history",
    };
  }
  const job = ctx.submitJob("justification calibrate", ["justification", "calibrate"]);
  return {
    // `submitted`, not `applied`: calibration REPORTS a threshold, it never
    // writes one — claiming otherwise would be the exact overstatement this
    // module exists to avoid.
    submitted: true,
    preview,
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
    applyNote:
      "calibration REPORTS a proposed threshold; changing security.justification is a spec edit and goes through the spec write path, which owns the human-owned-surface interstitial",
  };
};

/**
 * `POST /api/h/:id/security/justification/preflight` — dry-run the judge.
 *
 * THE TOOL IS NEVER EXECUTED, and nothing here could execute it: the answer
 * is projected from (a) the spec's own permission rules, which are the first
 * gate any call passes, and (b) every historical verdict the judge has
 * recorded for that tool. That is a real, useful answer derived only from
 * durable data.
 *
 * It is NOT a live judge invocation, and the response says so rather than
 * implying a stronger prediction than it has: the rule-based judge lives in
 * `@crewhaus/permission-engine`, which the manager does not depend on, and
 * the model-backed judge would spend a call. `crewhaus justification
 * preflight` is the verb that does the faithful replay.
 */
export const justificationPreflight: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const tool = requireString(ctx.body, "tool");
  const rows = justificationRows(ctx).filter((row) => row.toolName === tool);
  const denies = rows.filter((row) => row.verdict === "deny");
  const confidences = rows
    .map((row) => row.confidence)
    .filter((value): value is number => value !== null);
  const permissions = asRecord(at(spec.doc, ["permissions"]));
  return {
    tool,
    executed: false,
    mode: "historical-projection",
    permissions: {
      mode: asString(permissions?.["mode"]) ?? null,
      askMode: asString(permissions?.["ask_mode"]) ?? null,
      matchingRules: matchingPermissionRules(permissions, tool),
    },
    judge: {
      configured: asString(at(spec.doc, ["security", "justification", "judge"])) ?? null,
      threshold: asNumber(at(spec.doc, ["security", "justification", "threshold"])) ?? null,
    },
    history: {
      evaluations: rows.length,
      denials: denies.length,
      meanConfidence:
        confidences.length === 0
          ? null
          : confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
      recentReasons: denies.slice(-5).map((row) => row.reason),
    },
    likelyVerdict:
      rows.length === 0 ? "unknown" : denies.length > rows.length / 2 ? "deny" : "allow",
    note:
      rows.length === 0
        ? "this judge has never evaluated that tool, so there is nothing to project from — run `crewhaus justification preflight` for a faithful rule-based replay"
        : "projected from the durable record; `crewhaus justification preflight` replays the judge itself",
  };
};

/** Permission rules whose pattern mentions the tool. A lenient match, and
 *  labelled as such — the engine's matcher is the authority at run time. */
function matchingPermissionRules(
  permissions: Record<string, unknown> | undefined,
  tool: string,
): string[] {
  const out: string[] = [];
  for (const bucket of ["allow", "ask", "deny"]) {
    const rules = permissions?.[bucket];
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const text = String(rule);
      if (text === tool || text.startsWith(`${tool}(`) || text.startsWith(`${tool}:`)) {
        out.push(`${bucket}: ${text}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Security corpus + sandbox
// ---------------------------------------------------------------------------

const CORPUS_DIR = [".crewhaus", "security-corpus"] as const;

/** `GET /api/h/:id/security/corpus` — the corpus state. */
export const securityCorpus: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const contain = containProbe(ctx);
  const corpusPath = contain([...CORPUS_DIR, "corpus.json"]);
  const candidatesPath = contain([...CORPUS_DIR, "candidate-rules.json"]);
  const corpus = asRecord(readJsonFile(corpusPath));
  const candidates = asRecord(readJsonFile(candidatesPath));
  const cases = corpus?.["cases"];
  const candidateList = candidates?.["candidates"];
  let builtAt: string | null = null;
  if (corpusPath !== undefined && existsSync(corpusPath)) {
    try {
      builtAt = new Date(statSync(corpusPath).mtimeMs).toISOString();
    } catch {
      builtAt = null;
    }
  }
  const last = ctx.jobs
    .recent(50)
    .find((job) => job.kind === "security corpus check" && job.harnessDir === ctx.harnessDir);
  return {
    ...m3Base(
      corpus !== undefined,
      corpus === undefined
        ? "no security corpus yet — it is harvested from blocked prompt-injection attempts in this harness's session logs"
        : null,
      "crewhaus security corpus",
    ),
    cases: Array.isArray(cases) ? cases.length : 0,
    candidateRules: Array.isArray(candidateList) ? candidateList.length : 0,
    window: asString(corpus?.["window"]) ?? null,
    builtAt,
    asOfNote:
      builtAt === null ? null : "the corpus is a stored artifact — this is when it was built",
    lastCheck:
      last === undefined
        ? null
        : {
            jobId: last.jobId,
            state: last.state,
            exitCode: last.exitCode ?? null,
            endedAt: last.endedAt ?? null,
          },
    payloadNote:
      "corpus cases pin a canonical exemplar built at run time, never a stored attack payload; candidate samples are redacted and hashed",
  };
};

/** `POST /api/h/:id/security/corpus` — run the regression as a read-only job. */
export const securityCorpusCheck: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const job = ctx.submitJob("security corpus check", ["security", "corpus", "check"]);
  return {
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
    readOnly: true,
    note: "the check replays the corpus against the CURRENT detector and fails when a case's classification tier has drifted DOWN from its baseline",
  };
};

/** Container backends the sandbox can use, and whether one is on PATH. */
function sandboxBackends(env: Readonly<Record<string, string | undefined>>): Array<{
  name: string;
  available: boolean;
}> {
  const path = env["PATH"] ?? "";
  const dirs = path.split(process.platform === "win32" ? ";" : ":").filter((d) => d !== "");
  return ["docker", "podman"].map((name) => ({
    name,
    available: dirs.some((dir) => {
      try {
        return existsSync(join(dir, name));
      } catch {
        return false;
      }
    }),
  }));
}

/** `GET /api/h/:id/security/sandbox` — `sandbox doctor`, offline. */
export const sandboxDoctor: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const sandbox = asRecord(at(spec.doc, ["sandbox"]));
  const toolConfig = asRecord(at(spec.doc, ["tool_config"]));
  const backends = sandboxBackends(ctx.env);
  const anyBackend = backends.some((backend) => backend.available);
  const declared = sandbox !== undefined || toolConfig?.["sandbox"] !== undefined;
  return {
    ...m3Base(
      declared || anyBackend,
      declared
        ? null
        : "this spec declares no sandbox: block — tool calls run unsandboxed in the daemon's own process",
      "crewhaus sandbox doctor --probe",
    ),
    declared,
    config: sandbox ?? null,
    toolConfigSandbox: toolConfig?.["sandbox"] ?? null,
    backends,
    wouldHappen: declared
      ? anyBackend
        ? "a sandboxed tool call would run in a container on the backend above"
        : "a sandboxed tool call would FAIL — the spec asks for a sandbox and no container backend is on this machine's PATH"
      : "a tool call would run directly in the daemon's process, with the daemon's own filesystem and network access",
    probeNote:
      "image healthchecks actually START containers, so they are opt-in — run `crewhaus sandbox doctor --probe` for them",
  };
};

// ---------------------------------------------------------------------------
// Onchain
// ---------------------------------------------------------------------------

const ONCHAIN_TARGETS: ReadonlySet<string> = new Set(["onchain", "onchain-game"]);
const RECEIPTS = [".crewhaus", "onchain", "receipts.jsonl"] as const;

/** `GET /api/h/:id/security/onchain` — chains, wallets, contracts, policy. */
export const onchain: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const policy = asRecord(at(spec.doc, ["transaction_policy"]));
  const shapeGated = ONCHAIN_TARGETS.has(spec.target);
  const path = containProbe(ctx)([...RECEIPTS]);
  const receipts =
    path === undefined || !existsSync(path)
      ? []
      : readJsonlCapped(path).objects.map((object) => {
          const record = asRecord(object) ?? {};
          return {
            ts: record["ts"] ?? null,
            walletId: asString(record["walletId"]) ?? null,
            chainId: asString(record["chainId"]) ?? null,
            contractId: asString(record["contractId"]) ?? null,
            valueWei: record["valueWei"] === undefined ? null : String(record["valueWei"]),
            status: asString(record["status"]) ?? null,
            simulated: record["simulated"] === true,
          };
        });
  return {
    ...m3Base(
      shapeGated || policy !== undefined,
      shapeGated
        ? null
        : `this harness's target is "${spec.target}" — the onchain panel belongs to the onchain shapes`,
      "crewhaus onchain sentinel",
    ),
    shapeGated,
    target: spec.target,
    // transaction_policy is on the header safety strip for a reason: it is
    // the ceiling on what the agent can move, so it leads this panel.
    transactionPolicy: policy ?? null,
    approvalMode: asString(policy?.["approval"]) ?? null,
    chains: at(spec.doc, ["chains"]) ?? null,
    wallets: at(spec.doc, ["wallets"]) ?? null,
    contracts: at(spec.doc, ["contracts"]) ?? null,
    triggers: at(spec.doc, ["triggers"]) ?? null,
    receipts,
    keyNote:
      "a wallet's keyRef is a REFERENCE — no private key material is stored in the spec, and none is read here",
  };
};

/**
 * `POST /api/h/:id/security/onchain/tune` — `onchain tune`.
 *
 * `transaction_policy` is the ceiling on what value the agent can move, and
 * it lives in the SPEC. This module therefore never writes it: a dry run
 * previews the before/after, and a confirmed apply hands back the exact edit
 * for the SPEC WRITE PATH, which owns the credential-redacted diff
 * interstitial, the typed confirm, and the re-validation. Two writers for
 * one file is how a spec ends up with an edit nobody reviewed.
 */
export const onchainTune: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const proposed = asRecord(ctx.body["policy"]);
  if (proposed === undefined) throw new HttpError(400, 'missing "policy" object');
  const current = asRecord(at(spec.doc, ["transaction_policy"])) ?? null;
  const preview = {
    before: maskDeep(current),
    after: maskDeep(proposed),
    changed: JSON.stringify(current) !== JSON.stringify(proposed),
  };
  if (isDryRun(ctx.body)) {
    return {
      dryRun: true,
      wrote: false,
      preview,
      confirmWith: spec.specName,
      deriveVerb: "crewhaus onchain tune",
      note: "nothing was written — transaction_policy is human-owned spec, so applying it goes through the spec write path",
    };
  }
  requireTypedConfirm(ctx.body, spec.specName);
  return {
    dryRun: false,
    wrote: false,
    preview,
    // The edit, ready for the spec write path. Handing it over is the whole
    // point: one writer, one diff, one review.
    specEdit: { path: "transaction_policy", value: proposed },
    handoff: "PUT /api/h/:id/spec",
    note: "transaction_policy is outside the optimizer-writable set — the spec write path applies it with its own diff interstitial and re-validation",
  };
};

/** `GET /api/h/:id/security/onchain/sentinel` — what it watches, what it
 *  flagged. Derived from the receipt history the sentinel itself reads. */
export const onchainSentinel: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const path = containProbe(ctx)([...RECEIPTS]);
  const present = path !== undefined && existsSync(path);
  const receipts = present ? readJsonlCapped(path).objects : [];
  const perContract = new Map<string, { count: number; maxWei: bigint }>();
  for (const object of receipts) {
    const record = asRecord(object);
    const contractId = asString(record?.["contractId"]);
    if (contractId === undefined) continue;
    let wei = 0n;
    try {
      wei = BigInt(String(record?.["valueWei"] ?? "0"));
    } catch {
      wei = 0n;
    }
    const tally = perContract.get(contractId) ?? { count: 0, maxWei: 0n };
    tally.count += 1;
    if (wei > tally.maxWei) tally.maxWei = wei;
    perContract.set(contractId, tally);
  }
  return {
    ...m3Base(
      present,
      present
        ? null
        : "no broadcast receipts yet — the sentinel learns its baseline from this harness's own transaction history",
      "crewhaus onchain sentinel",
    ),
    watches: {
      capWei: asString(at(spec.doc, ["transaction_policy", "maxValueWei"])) ?? null,
      allowedContracts: at(spec.doc, ["transaction_policy", "allowedContracts"]) ?? null,
      simulationRequired: at(spec.doc, ["transaction_policy", "simulationRequired"]) ?? null,
    },
    baselines: [...perContract.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([contractId, tally]) => ({
        contractId,
        broadcasts: tally.count,
        maxValueWei: tally.maxWei.toString(),
      })),
    receipts: receipts.length,
    note: "the sentinel flags spend above a multiple of each contract's own observed ceiling — a fresh harness has no baseline and flags nothing",
  };
};

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

const COMPLIANCE_DIR = [".crewhaus", "compliance"] as const;
const FRAMEWORKS: ReadonlySet<string> = new Set(["soc2", "iso", "hipaa"]);

/** `GET /api/h/:id/security/compliance` — the evidence-bundle browser. */
export const compliance: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const contain = containProbe(ctx);
  const root = contain([...COMPLIANCE_DIR]);
  const bundles: Array<Record<string, unknown>> = [];
  if (root !== undefined && existsSync(root)) {
    let names: string[] = [];
    try {
      names = readdirSync(root).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!SAFE_SEGMENT_RE.test(name)) continue;
      // Per FILE: a listed name can be a symlink out of the harness tree.
      const path = contain([...COMPLIANCE_DIR, name]);
      if (path === undefined) continue;
      let generatedAt: string | null = null;
      try {
        generatedAt = new Date(statSync(path).mtimeMs).toISOString();
      } catch {
        continue;
      }
      const body = asRecord(name.endsWith(".json") ? readJsonFile(path) : undefined);
      bundles.push({
        name,
        generatedAt,
        framework: asString(body?.["frameworkId"]) ?? frameworkFromName(name),
        period: asString(body?.["period"]) ?? null,
        controls: Array.isArray(body?.["controls"]) ? body["controls"].length : null,
      });
    }
  }
  return {
    ...m3Base(
      bundles.length > 0,
      bundles.length === 0 ? "no evidence bundles have been generated for this harness yet" : null,
      "crewhaus compliance evidence --framework soc2 --period current",
    ),
    bundles,
    frameworks: [...FRAMEWORKS],
    retireNote:
      "`crewhaus retire` refuses to finish without FINAL evidence — generate the bundle here before you retire a harness, and the retire plan will name it",
  };
};

function frameworkFromName(name: string): string | null {
  for (const framework of FRAMEWORKS) {
    if (name.toLowerCase().includes(framework)) return framework;
  }
  return null;
}

/** `POST /api/h/:id/security/compliance` — `compliance evidence`. */
export const complianceEvidence: M3Handler = (ctx) => {
  harnessDirOf(ctx);
  const framework = requireString(ctx.body, "framework");
  if (!FRAMEWORKS.has(framework)) {
    throw new HttpError(400, `"framework" must be one of: ${[...FRAMEWORKS].join(", ")}`);
  }
  // Closed vocabulary: the framework is one of three literals and `current`
  // is a literal the CLI resolves to the current UTC quarter, so a scheduled
  // run never hardcodes a stale label.
  const job = ctx.submitJob("compliance evidence", [
    "compliance",
    "evidence",
    "--framework",
    jobArg("framework", framework),
    "--period",
    "current",
  ]);
  return {
    framework,
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
    note: "collection walks the audit chain for the period and writes a signed bundle into .crewhaus/compliance/",
  };
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/security/retention` — the retention console. */
export const retention: M3Handler = async (ctx) => {
  const dir = harnessDirOf(ctx);
  // `loadRetentionConfig` joins the path itself, so containment is checked
  // HERE before it is called: a `retention.json` symlinked out of the
  // harness is somebody else's policy, and a policy read must not follow it.
  if (containProbe(ctx)([".crewhaus", "retention.json"]) === undefined) {
    return {
      ...m3Base(
        false,
        "this harness's retention.json resolves outside its own directory — refusing to read it",
        "crewhaus retention sweep --dry-run",
      ),
      malformed: false,
      pins: [],
      sessionMaxAgeDays: null,
      auditWindows: [],
      fromFile: false,
    };
  }
  let config: Awaited<ReturnType<typeof loadRetentionConfig>>;
  try {
    config = await loadRetentionConfig(dir, ctx.now);
  } catch (err) {
    // A malformed policy file is a REFUSAL, not a guess: an enforcer that
    // half-understands its policy must not run, and the console must say so
    // rather than render the defaults as if they were configured.
    return {
      ...m3Base(true, maskText((err as Error).message), "crewhaus retention sweep --dry-run"),
      malformed: true,
      pins: [],
      sessionMaxAgeDays: null,
      auditWindows: [],
      fromFile: true,
    };
  }
  return {
    ...m3Base(
      config.fromFile,
      config.fromFile
        ? null
        : "this harness has no retention.json — the built-in session TTL applies and nothing is pinned",
      "crewhaus retention sweep --dry-run",
    ),
    malformed: false,
    fromFile: config.fromFile,
    sessionMaxAgeDays: config.sessionMaxAgeDays,
    /** Session ids enforcement refuses to delete, from every sweep. */
    pins: [...config.pins],
    /** An ACTIVE window defers ALL deletion — evidence collection is in
     *  flight and a sweep would destroy what it is collecting. */
    auditWindows: config.auditWindows.map((window) => ({
      frameworkId: window.frameworkId,
      controlId: window.controlId,
      expiresAt: new Date(window.expiresAt).toISOString(),
      active: window.expiresAt > ctx.now(),
    })),
    auditChainNote:
      "audit records are enumerated and exportable but NEVER deleted: the hash chain spans every day file, so removing any record breaks verification of everything after it",
  };
};

/** The two retention verbs share their whole shape; only the word differs. */
function retentionRun(ctx: M3Context, action: "sweep" | "purge"): Record<string, unknown> {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const dryRun = isDryRun(ctx.body);
  if (!dryRun) {
    // Rung three of the ladder: the dry run came first, and the real run is
    // a SECOND gesture with the harness name typed out.
    requireTypedConfirm(ctx.body, spec.specName);
  }
  const argv = ["retention", action];
  if (dryRun) argv.push("--dry-run");
  const job = ctx.submitJob(`retention ${action}`, argv);
  return {
    action,
    dryRun,
    job: { jobId: job.jobId, kind: job.kind, state: job.state, argv: job.argv },
    confirmWith: dryRun ? spec.specName : null,
    note: dryRun
      ? `this is the PLAN: --dry-run deletes nothing, writes nothing and records no evidence. Send dryRun:false with confirmName:"${spec.specName}" to run it for real`
      : "the real run self-audits as a retention_enforcement record, so the enforcement is itself tamper-evidenced",
    pinsNote: "pinned sessions are never deleted, and the plan names what the pins saved",
  };
}

/** `POST /api/h/:id/security/retention/sweep` — dry-run first, then typed. */
export const retentionSweep: M3Handler = (ctx) => retentionRun(ctx, "sweep");

/** `POST /api/h/:id/security/retention/purge` — the most destructive verb
 *  the manager exposes, and the one most tightly gated. */
export const retentionPurge: M3Handler = (ctx) => retentionRun(ctx, "purge");

// ---------------------------------------------------------------------------
// The SLO monitor
// ---------------------------------------------------------------------------

const METRICS = [".crewhaus", "metrics", "sessions.jsonl"] as const;

/** The five thresholds `observability.slo` can declare, paired with the
 *  metric each one is measured against. Latency targets are declared in
 *  MILLISECONDS and observed in SECONDS — converting in one place is the
 *  difference between a panel that reads right and one that is 1000× wrong. */
const SLO_METRICS = [
  { key: "error_rate", field: "errorRate", scale: 1, unit: "rate" },
  { key: "p95_latency_ms", field: "turnP95Seconds", scale: 1000, unit: "ms" },
  { key: "ttft_ms", field: "ttftP95Seconds", scale: 1000, unit: "ms" },
  { key: "cost_per_hour_usd", field: "costBurnUsdPerMin", scale: 60, unit: "usd/hour" },
] as const;

/** One threshold row: what was asked for, what was observed, and whether the
 *  two disagree. Both sides are nullable on purpose — a declared target with
 *  no data and observed data with no target are BOTH worth showing. */
type SloTarget = {
  readonly metric: string;
  readonly unit: string;
  readonly threshold: number | null;
  readonly observed: number | null;
  readonly breached: boolean;
  readonly source: string | null;
};

/** `GET /api/h/:id/slo` — thresholds vs observed, and the ladder's state. */
export const slo: M3Handler = (ctx) => {
  const dir = harnessDirOf(ctx);
  const spec = readHarnessSpec(dir);
  const block = asRecord(at(spec.doc, ["observability", "slo"]));
  const path = containProbe(ctx)([...METRICS]);
  const samples =
    path === undefined || !existsSync(path)
      ? []
      : readJsonlCapped(path).objects.map((object) => asRecord(object) ?? {});
  const latest = samples[samples.length - 1];

  const targets: SloTarget[] = SLO_METRICS.map((metric) => {
    const threshold = asNumber(block?.[metric.key]) ?? null;
    const raw = asNumber(latest?.[metric.field]);
    const observed = raw === undefined ? null : raw * metric.scale;
    return {
      metric: metric.key,
      unit: metric.unit,
      threshold,
      observed,
      breached: threshold !== null && observed !== null && observed > threshold,
      source: observed === null ? null : "the last session in .crewhaus/metrics",
    };
  }).filter((target) => target.threshold !== null || target.observed !== null);

  // `egress_block_rate` has no field on the metrics line — it is derived
  // from the egress counter against model calls, so it is computed here
  // rather than left as a silently missing row.
  const egressBlocked = asNumber(latest?.["egressBlocked"]);
  const modelCalls = asNumber(latest?.["modelCalls"]);
  const egressThreshold = asNumber(block?.["egress_block_rate"]) ?? null;
  if (egressThreshold !== null || egressBlocked !== undefined) {
    const observed =
      egressBlocked === undefined || modelCalls === undefined || modelCalls === 0
        ? null
        : egressBlocked / modelCalls;
    targets.push({
      metric: "egress_block_rate",
      unit: "rate",
      threshold: egressThreshold,
      observed,
      breached: egressThreshold !== null && observed !== null && observed > egressThreshold,
      source: observed === null ? null : "the last session in .crewhaus/metrics",
    });
  }

  const alerts = foldAudit(ctx, "alert_raised").records.map((record) => {
    const payload = asRecord(record.payload) ?? {};
    return {
      ts: record.ts,
      metric: asString(payload["metric"]) ?? null,
      observed: asNumber(payload["observed"]) ?? null,
      threshold: asNumber(payload["threshold"]) ?? null,
      baselineSessions: asNumber(payload["baselineSessions"]) ?? null,
      detail: payload["detail"] === undefined ? null : maskText(String(payload["detail"])),
    };
  });
  const mitigations = foldAudit(ctx, "slo_mitigation").records.map((record) => {
    const payload = asRecord(record.payload) ?? {};
    return {
      ts: record.ts,
      rung: asString(payload["rung"]) ?? null,
      breach: maskDeep(payload["breach"] ?? null),
      windowMs: asNumber(payload["windowMs"]) ?? null,
    };
  });
  const ladder = at(spec.doc, ["observability", "slo", "mitigation"]);

  return {
    ...m3Base(
      block !== undefined || samples.length > 0,
      block === undefined
        ? "this spec declares no observability.slo block — nothing is being held to a target"
        : samples.length === 0
          ? "no session metrics recorded yet — the monitor writes one line per session"
          : null,
      "crewhaus doctor --slo",
    ),
    declared: block !== undefined,
    targets,
    windowSeconds: asNumber(block?.["window_seconds"]) ?? 300,
    ladder: Array.isArray(ladder) ? ladder.map(String) : ["alert"],
    ladderNote:
      "the ladder is walked in declared order on a SUSTAINED breach — a single blip never mitigates, and each rung fires at most once per session",
    ladderState:
      mitigations.length === 0 ? "idle" : (mitigations[mitigations.length - 1]?.rung ?? "idle"),
    alerts,
    mitigations,
    baselineNote:
      "alert thresholds are derived from a trailing p95 × 1.5 over previous sessions — a harness with no history bootstraps and alerts on nothing",
    sessions: samples.length,
    observedAt: asString(latest?.["ts"]) ?? null,
    exporters: {
      // PRESENCE only: an endpoint URL can carry a token in its query.
      otlpEndpointConfigured: (ctx.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "") !== "",
      metricsConfigured: (ctx.env["CREWHAUS_METRICS"] ?? "") !== "",
      note: "exporter configuration is reported as presence — an OTLP endpoint URL can carry credentials in its query string",
    },
  };
};
