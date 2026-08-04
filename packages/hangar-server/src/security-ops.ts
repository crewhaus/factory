/**
 * M3 · SECURITY — the audit chain, egress review, the PII tuner, the
 * justification console, the security corpus + sandbox checks, the onchain
 * safety consoles, compliance evidence, retention, and the SLO monitor.
 *
 * STUBS. Owned by the Creds+Channels+Security implementer.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY BE SERVED, AND WHAT MAY NOT
 * ---------------------------------------------------------------------------
 * RAW AUDIT FILES ARE NEVER SERVED OVER HTTP. The audit log is hash-chained
 * and its integrity claim is only meaningful through the verify API — so
 * this module renders RECORDS (via `@crewhaus/audit-log`'s verify/read API)
 * and never streams the underlying files. The same rule already keeps
 * `secrets/` and `.env` unreachable.
 *
 * `audit verify` must be reported HONESTLY, including its designed limits:
 * `anchorChecked` and `externalAnchorChecked: false` are facts about what
 * the verifier does, not failures to hide. When audit encryption is on, say
 * so with a badge rather than showing an empty list.
 *
 * EGRESS RECORDS CARRY LINEAGE, NOT PAYLOADS. An `egress_decision` audit
 * record deliberately does not contain the outbound body. The review console
 * triages lineage summaries; do not try to reconstruct the payload.
 *
 * THE DESTRUCTIVE LADDER APPLIES IN FULL HERE:
 *   - `retention sweep` and `retention purge` are DRY-RUN FIRST. The manager
 *     runs `--dry-run`, shows the plan, and only then offers the real run as
 *     a SECOND, typed-confirm gesture. Each real run self-audits as a
 *     `retention_enforcement` record.
 *   - `retire` (lifecycle) surfaces its ACTIVE-PIN REFUSAL before it offers
 *     the real thing, and depends on final compliance evidence — which is
 *     why the compliance route belongs beside it.
 *   - `pii tune` and `onchain tune` write POLICY. Both show a before/after
 *     preview and neither writes without confirmation.
 *
 * `justification preflight` is a dry run of the security.justification judge
 * against a candidate tool call: it must never actually execute the tool.
 *
 * The SLO panel reads observed metrics against the spec's
 * `observability.slo` thresholds and renders the mitigation ladder state
 * (alert | pause-intake | rollback) plus `alert_raised` history with its
 * trailing-p95×1.5 baselines. Exporter configuration status
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `CREWHAUS_METRICS`) is PRESENCE only.
 *
 * Implementation needs `@crewhaus/audit-log` and the pii / egress /
 * compliance packages added to this package's dependencies + tsconfig
 * references; `@crewhaus/data-retention-engine` is already there.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/audit` — the audit chain panel.
 *
 * The 17 audit kinds browsable as RENDERED RECORDS through the audit-log
 * read API. Raw files are never served. Encryption state is a badge.
 */
export const audit: M3Handler = () => notImplemented("audit chain");

/**
 * `POST /api/h/:id/audit/verify` — run `audit verify`.
 *
 * Report the result honestly: `anchorChecked`, and
 * `externalAnchorChecked: false` as a DESIGNED limitation rather than a
 * failure. A read-only job.
 */
export const auditVerify: M3Handler = () => notImplemented("audit verify");

/**
 * `GET /api/h/:id/security/egress` — the egress review console.
 *
 * `egress_decision` audit records as triage rows: destination, classifier
 * verdict, and LINEAGE SUMMARY. The record carries no outbound payload by
 * design — say so rather than showing an empty "body" field.
 */
export const egress: M3Handler = () => notImplemented("egress review");

/** `POST /api/h/:id/security/egress/:decisionId` — triage one decision.
 *  Body: `{ verdict, note? }` through `egress review`; the decision itself
 *  is immutable — this appends a triage record. */
export const egressReview: M3Handler = () => notImplemented("egress triage");

/** `GET /api/h/:id/security/pii` — `.crewhaus/pii-policy.json` rendered with
 *  the redactor's current rule set and recent hit counts. */
export const pii: M3Handler = () => notImplemented("pii policy");

/** `POST /api/h/:id/security/pii` — `pii tune`. Body: `{ policy, dryRun }`
 *  with dryRun defaulting true; the before/after preview is mandatory. */
export const piiTune: M3Handler = () => notImplemented("pii tune");

/**
 * `GET /api/h/:id/security/justification` — the justification console.
 *
 * The `security.justification` judge's configuration plus the verbatim
 * `permission_justification_evaluated` audit records, linked to the turns
 * that produced them.
 */
export const justification: M3Handler = () => notImplemented("justification console");

/** `POST /api/h/:id/security/justification/calibrate` —
 *  `justification calibrate`. Body: `{ apply?, confirm? }`; without `apply`
 *  this previews the cut it would choose. */
export const justificationCalibrate: M3Handler = () => notImplemented("justification calibrate");

/**
 * `POST /api/h/:id/security/justification/preflight` — dry-run the judge.
 *
 * Body: `{ tool, input? }`. Evaluates what the judge WOULD decide for a
 * candidate tool call. It must never execute the tool.
 */
export const justificationPreflight: M3Handler = () => notImplemented("justification preflight");

/** `GET /api/h/:id/security/corpus` — the security corpus state
 *  (`security corpus check` results, last run, findings). */
export const securityCorpus: M3Handler = () => notImplemented("security corpus");

/** `POST /api/h/:id/security/corpus` — run `security corpus check` as a
 *  read-only job with actionable findings. */
export const securityCorpusCheck: M3Handler = () => notImplemented("security corpus check");

/** `GET /api/h/:id/security/sandbox` — `sandbox doctor`: backend
 *  availability, image state, and what would happen to a sandboxed tool
 *  call right now. */
export const sandboxDoctor: M3Handler = () => notImplemented("sandbox doctor");

/**
 * `GET /api/h/:id/security/onchain` — the onchain safety panel.
 *
 * Chains / wallets / contracts, `transaction_policy` PROMINENTLY (its
 * approval mode is on the header safety strip for a reason), triggers, and
 * transaction history. Shape-gated to the onchain targets.
 */
export const onchain: M3Handler = () => notImplemented("onchain panel");

/** `POST /api/h/:id/security/onchain/tune` — `onchain tune`. Body:
 *  `{ policy, dryRun }`. `transaction_policy` is human-owned: preview,
 *  typed-confirm, then the spec write path. */
export const onchainTune: M3Handler = () => notImplemented("onchain tune");

/** `GET /api/h/:id/security/onchain/sentinel` — `onchain sentinel` status:
 *  what it watches and what it has flagged. */
export const onchainSentinel: M3Handler = () => notImplemented("onchain sentinel");

/** `GET /api/h/:id/security/compliance` — the `.crewhaus/compliance/`
 *  browser: generated evidence bundles with their framework and timestamp. */
export const compliance: M3Handler = () => notImplemented("compliance browser");

/**
 * `POST /api/h/:id/security/compliance` — `compliance evidence`.
 *
 * Body: `{ framework: "soc2"|"iso"|"hipaa" }` through the job queue.
 * Retire's dry-run plan depends on final evidence, so the two surfaces must
 * reference each other rather than duplicating the rule.
 */
export const complianceEvidence: M3Handler = () => notImplemented("compliance evidence");

/**
 * `GET /api/h/:id/security/retention` — the retention console.
 *
 * `retention.json`: the pins list (what is protected from every sweep) and
 * what the current policy would touch.
 */
export const retention: M3Handler = () => notImplemented("retention console");

/**
 * `POST /api/h/:id/security/retention/sweep` — `retention sweep`.
 *
 * Body: `{ dryRun, confirmName? }`. DRY RUN IS THE DEFAULT and the plan is
 * always shown first; the real run needs the typed confirmation and
 * self-audits as `retention_enforcement`.
 */
export const retentionSweep: M3Handler = () => notImplemented("retention sweep");

/**
 * `POST /api/h/:id/security/retention/purge` — `retention purge`.
 *
 * The most destructive verb the manager exposes: dry-run first, then
 * typed-confirm. Pinned items are never purgeable, and the plan must show
 * what the pins saved.
 */
export const retentionPurge: M3Handler = () => notImplemented("retention purge");

/**
 * `GET /api/h/:id/slo` — the SLO monitor.
 *
 * `observability.slo` thresholds (error_rate / p95_latency_ms / ttft_ms /
 * cost_per_hour_usd / egress_block_rate) vs observed values from
 * `.crewhaus/metrics/sessions.jsonl`, the mitigation-ladder state
 * (alert | pause-intake | rollback), `alert_raised` history with the
 * trailing-p95×1.5 baselines, and exporter configuration PRESENCE.
 */
export const slo: M3Handler = () => notImplemented("slo monitor");
