import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuditKind, AuditRecord } from "@crewhaus/audit-log";

/**
 * Item 48 — `crewhaus security digest` plumbing, factored out of the entry
 * file `index.ts` (which runs a top-level argv switch and so cannot be
 * imported by a test without executing the CLI). Side-effect-free on import
 * and directly unit-testable, mirroring `audit-verify.ts` / `retention.ts`.
 *
 * The problem this closes: warn-tier egress verdicts, boundary redactions,
 * injection hits, justification denials and circuit events all accumulate in
 * `.crewhaus/audit` JSONL and on the TraceEventBus, but nothing triages them
 * — answering "are we being probed, or over-blocking?" meant hand-grepping.
 * This module walks the durable stores and emits a ranked rollup; the live
 * per-run tally lives in `@crewhaus/runtime-core`'s observability module
 * (CREWHAUS_SECURITY_DIGEST=1).
 *
 * WHAT THE AUDIT KINDS ACTUALLY CARRY TODAY (verified by grepping for
 * writers, 2026-07 — the digest reports on what has writers and keeps the
 * declared-but-writerless kinds visible instead of fabricating sections):
 *
 *   kinds WITH writers:
 *     - permission_justification_evaluated  runtime-core's intent gate
 *       (payload { toolName, justification, verdict, reason, judgeModel,
 *       confidence? }) — powers the top-denied-tools + judge-deny-rate rollup.
 *     - policy_decision   policy-engine's auditPolicyDecision (payload
 *       { toolName, sideEffect, decision, reason, tenantId, matchedRule }) —
 *       deny/audit-and-allow rows only by default.
 *     - model_call, gateway_request, secrets_rotation, secrets_access,
 *       deployment_action, retention_enforcement — operational kinds; the
 *       digest counts them per-kind (countsByKind) but builds no verdict
 *       rollup from them.
 *
 *   kinds DECLARED in @crewhaus/audit-log but with NO writer anywhere in the
 *   tree today: `egress_decision`, `tool_classification`, `session_fork`,
 *   `tenancy_context`. Egress verdicts currently surface ONLY as ephemeral
 *   `permission_decision` trace events (outcome: egress-*) — runtime-core
 *   never appends the documented `egress_decision` audit record. The digest
 *   still aggregates `egress_decision` records by the payload shape the
 *   audit-log header documents ({ sinkId, sinkScope, verdict, originsFound,
 *   matchCount }) so the rollup lights up the day a writer lands, and it
 *   reports these kinds under `absentDeclaredKinds` so "0 egress rows"
 *   reads as "no durable writer yet", not "no egress happened".
 *
 * Because block-tier verdicts DO leave durable residue in the session event
 * logs (`.crewhaus/sessions/<id>.jsonl` `tool_result` events carry the
 * `[justification denied]` / `[egress denied]` / `[blocked by hook]` notices,
 * and injection redactions replace the tool output with
 * `[tool output redacted: prompt injection detected: <rule-ids>]`), the
 * digest ALSO scans session JSONLs in the window — that is where injection
 * rule-id hit counts come from today.
 *
 * HTML output: apps/cli already depends on `@crewhaus/eval-report`, but its
 * render.ts keeps `shell`/`escapeHtml` private to the eval-report shapes.
 * Rather than widen that package's public API for a CLI-side concern, the
 * digest ships a small local renderer following the same dependency-free
 * style (inline CSS variables, no external assets).
 *
 * Webhook notify: `--notify <url>` POSTs the JSON digest with plain `fetch`
 * — deliberately NOT via `@crewhaus/channel-adapter-slack`, to keep the CLI
 * dependency graph clean (the adapter pulls in channel-runtime concerns the
 * digest doesn't need). Slack incoming webhooks reject arbitrary JSON, so
 * point `--notify` at a receiver that accepts the digest shape, or wrap it:
 * a one-line proxy that forwards `{ text: renderSecurityDigestText(...) }`
 * satisfies Slack.
 */

const MS_PER_DAY = 86_400_000;
const AUDIT_RELPATH = ".crewhaus/audit";
const SESSIONS_RELPATH = ".crewhaus/sessions";
const AUDIT_DAY_FILE_REGEX = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const SESSION_EVENT_LOG_REGEX = /^sess_[0-9a-f]{16}\.jsonl$/;

/** How many entries each ranked "top …" list carries. */
const TOP_N = 10;

/**
 * Every kind declared by `@crewhaus/audit-log`. Kept as a local literal list
 * (rather than importing a value — the package only exports the TYPE) so the
 * digest can report declared kinds that produced zero records in the window.
 * `satisfies` keeps it in lockstep with the union: adding a kind to
 * audit-log without updating this list is a type error.
 */
export const DECLARED_AUDIT_KINDS = [
  "policy_decision",
  "model_call",
  "tool_classification",
  "gateway_request",
  "session_fork",
  "tenancy_context",
  "secrets_rotation",
  "secrets_access",
  "deployment_action",
  "egress_decision",
  "permission_justification_evaluated",
  "retention_enforcement",
] as const satisfies ReadonlyArray<AuditKind>;

/** Thrown by `parseSinceFlag` on an unparseable `--since`. The CLI entry
 *  file catches it and routes the message through `die()`; tests assert on
 *  `.message` without the process exiting. */
export class InvalidSinceFlagError extends Error {
  override readonly name = "InvalidSinceFlagError";
  constructor(readonly value: string) {
    super(
      `invalid --since "${value}" — expected a day window like 7d or 30d, or an ISO date/datetime (e.g. 2026-06-01 or 2026-06-01T00:00:00Z)`,
    );
  }
}

export type SinceWindow = {
  /** Inclusive epoch-ms lower bound on record timestamps. */
  readonly sinceMs: number;
  /** Human label for the report header: "7d", "30d", or the ISO value. */
  readonly label: string;
};

/**
 * Parse the `--since` flag: `<N>d` (a trailing day window, default `7d`) or
 * an ISO date/datetime (bare dates are UTC midnight per `Date.parse`).
 */
export function parseSinceFlag(
  value: string | undefined,
  now: () => number = () => Date.now(),
): SinceWindow {
  const raw = value ?? "7d";
  const dayMatch = /^(\d+)d$/.exec(raw);
  if (dayMatch !== null) {
    const days = Number(dayMatch[1]);
    if (days <= 0) throw new InvalidSinceFlagError(raw);
    return { sinceMs: now() - days * MS_PER_DAY, label: raw };
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new InvalidSinceFlagError(raw);
  return { sinceMs: ms, label: raw };
}

export type DeniedToolEntry = {
  readonly toolName: string;
  readonly denials: number;
  /** Distinct judge identities that produced the denials. */
  readonly judges: ReadonlyArray<string>;
  /** Mean judge confidence over denials that carried one; null when none did. */
  readonly meanConfidence: number | null;
  /** The most recent denial reason, for triage at a glance. */
  readonly lastReason?: string;
};

export type JudgeEntry = {
  readonly judgeModel: string;
  readonly evaluated: number;
  readonly denied: number;
};

export type EgressSinkEntry = {
  readonly sinkId: string;
  readonly warned: number;
  readonly blocked: number;
  /** Distinct trust origins found in this sink's non-pass payloads. */
  readonly origins: ReadonlyArray<string>;
};

export type CountEntry = { readonly name: string; readonly count: number };

export type SecurityDigest = {
  readonly version: 1;
  readonly generatedAt: string;
  /** ISO instant of the window's inclusive lower bound. */
  readonly since: string;
  readonly windowLabel: string;
  readonly rootDir: string;
  readonly audit: {
    readonly dir: string;
    /** Records parsed from day files that could overlap the window. */
    readonly recordsScanned: number;
    /** Records whose ts landed inside the window (the rollup input). */
    readonly recordsInWindow: number;
    /** Unparseable JSONL lines — reported, never fatal (triage tool). */
    readonly malformedLines: number;
    readonly countsByKind: Readonly<Record<string, number>>;
    /** Kinds @crewhaus/audit-log declares that produced 0 window records —
     *  today that inevitably includes the writerless kinds (see header). */
    readonly absentDeclaredKinds: ReadonlyArray<string>;
  };
  /** Pillar 3 intent gate — from `permission_justification_evaluated`. */
  readonly justification: {
    readonly evaluated: number;
    readonly allowed: number;
    readonly denied: number;
    /** denied / evaluated; null when nothing was evaluated in the window. */
    readonly denyRate: number | null;
    readonly topDeniedTools: ReadonlyArray<DeniedToolEntry>;
    readonly byJudge: ReadonlyArray<JudgeEntry>;
  };
  /** Pillar 3 sink-side — from `egress_decision` records (NO writer today;
   *  see the module header — populated the day one lands). */
  readonly egress: {
    readonly decisions: number;
    readonly passed: number;
    readonly warned: number;
    readonly blocked: number;
    readonly topSinks: ReadonlyArray<EgressSinkEntry>;
    readonly topOrigins: ReadonlyArray<CountEntry>;
  };
  /** From `policy_decision` (policy-engine writes deny/audit-and-allow). */
  readonly policy: {
    readonly decisions: number;
    readonly denied: number;
    readonly auditAndAllow: number;
    readonly topDeniedTools: ReadonlyArray<CountEntry>;
  };
  /** Durable block-tier residue scanned out of session event logs. */
  readonly sessions: {
    readonly scanned: number;
    readonly justificationDenials: number;
    readonly egressBlocks: number;
    readonly hookBlocks: number;
    readonly injectionRedactions: number;
    /** Rule-id hit counts parsed from redaction notices, ranked. */
    readonly injectionRuleHits: ReadonlyArray<CountEntry>;
  };
};

type JustificationPayload = {
  readonly toolName?: unknown;
  readonly verdict?: unknown;
  readonly reason?: unknown;
  readonly judgeModel?: unknown;
  readonly confidence?: unknown;
};

type EgressPayload = {
  readonly sinkId?: unknown;
  readonly verdict?: unknown;
  readonly originsFound?: unknown;
};

type PolicyPayload = {
  readonly toolName?: unknown;
  readonly decision?: unknown;
};

function asObject(payload: unknown): Record<string, unknown> | undefined {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

/** `YYYY-MM-DD` day file → epoch ms of the LAST instant of that UTC day
 *  (mirrors retention.ts): a day overlaps the window when its newest
 *  possible record does. Undefined for labels that don't round-trip. */
function endOfUtcDayMs(y: string, m: string, d: string): number | undefined {
  const startMs = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const roundTrip = new Date(startMs).toISOString().slice(0, 10);
  if (roundTrip !== `${y}-${m}-${d}`) return undefined;
  return startMs + MS_PER_DAY - 1;
}

function rankEntries<V, R>(
  map: ReadonlyMap<string, V>,
  score: (v: V) => number,
  build: (name: string, v: V) => R,
): ReadonlyArray<R> {
  return [...map.entries()]
    .sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([name, v]) => build(name, v));
}

/**
 * Walk `<rootDir>/.crewhaus/audit` + `<rootDir>/.crewhaus/sessions` and
 * build the windowed rollup. Missing stores yield an empty (but complete)
 * digest — the command is a report, not a gate, so it never throws on an
 * absent or partially-corrupt store; malformed lines are counted instead.
 */
export function buildSecurityDigest(opts: {
  readonly rootDir: string;
  readonly window: SinceWindow;
  readonly now?: () => number;
}): SecurityDigest {
  const rootDir = resolve(opts.rootDir);
  const now = opts.now ?? ((): number => Date.now());
  const auditDir = join(rootDir, AUDIT_RELPATH);
  const { sinceMs } = opts.window;

  let recordsScanned = 0;
  let recordsInWindow = 0;
  let malformedLines = 0;
  const countsByKind = new Map<string, number>();

  // Justification rollup accumulators.
  let jEvaluated = 0;
  let jAllowed = 0;
  let jDenied = 0;
  const deniedTools = new Map<
    string,
    { denials: number; judges: Set<string>; confidences: number[]; lastReason?: string }
  >();
  const judges = new Map<string, { evaluated: number; denied: number }>();

  // Egress rollup accumulators (no writer today — see module header).
  let ePassed = 0;
  let eWarned = 0;
  let eBlocked = 0;
  const sinks = new Map<string, { warned: number; blocked: number; origins: Set<string> }>();
  const origins = new Map<string, number>();

  // Policy rollup accumulators.
  let pDenied = 0;
  let pAuditAndAllow = 0;
  let pOther = 0;
  const policyDeniedTools = new Map<string, number>();

  if (existsSync(auditDir)) {
    const dayFiles = readdirSync(auditDir)
      .filter((f) => {
        const m = AUDIT_DAY_FILE_REGEX.exec(f);
        if (m === null) return false;
        const end = endOfUtcDayMs(m[1] as string, m[2] as string, m[3] as string);
        return end !== undefined && end >= sinceMs;
      })
      .sort();
    for (const file of dayFiles) {
      for (const raw of readFileSync(join(auditDir, file), "utf8").split("\n")) {
        if (raw === "") continue;
        let record: AuditRecord;
        try {
          record = JSON.parse(raw) as AuditRecord;
        } catch {
          malformedLines += 1;
          continue;
        }
        recordsScanned += 1;
        if (typeof record.ts !== "number" || record.ts < sinceMs) continue;
        recordsInWindow += 1;
        const kind = typeof record.kind === "string" ? record.kind : "(unknown)";
        countsByKind.set(kind, (countsByKind.get(kind) ?? 0) + 1);

        if (kind === "permission_justification_evaluated") {
          const p = (asObject(record.payload) ?? {}) as JustificationPayload;
          const toolName = typeof p.toolName === "string" ? p.toolName : "(unknown tool)";
          const judgeModel = typeof p.judgeModel === "string" ? p.judgeModel : "(unknown judge)";
          const denied = p.verdict === "deny";
          jEvaluated += 1;
          if (denied) jDenied += 1;
          else jAllowed += 1;
          const judge = judges.get(judgeModel) ?? { evaluated: 0, denied: 0 };
          judge.evaluated += 1;
          if (denied) judge.denied += 1;
          judges.set(judgeModel, judge);
          if (denied) {
            const t = deniedTools.get(toolName) ?? {
              denials: 0,
              judges: new Set<string>(),
              confidences: [],
            };
            t.denials += 1;
            t.judges.add(judgeModel);
            if (typeof p.confidence === "number") t.confidences.push(p.confidence);
            if (typeof p.reason === "string") t.lastReason = p.reason;
            deniedTools.set(toolName, t);
          }
        } else if (kind === "egress_decision") {
          const p = (asObject(record.payload) ?? {}) as EgressPayload;
          const sinkId = typeof p.sinkId === "string" ? p.sinkId : "(unknown sink)";
          const verdict = p.verdict;
          if (verdict === "warn") eWarned += 1;
          else if (verdict === "block") eBlocked += 1;
          else ePassed += 1;
          if (verdict === "warn" || verdict === "block") {
            const s = sinks.get(sinkId) ?? { warned: 0, blocked: 0, origins: new Set<string>() };
            if (verdict === "warn") s.warned += 1;
            else s.blocked += 1;
            if (Array.isArray(p.originsFound)) {
              for (const o of p.originsFound) {
                if (typeof o === "string") {
                  s.origins.add(o);
                  origins.set(o, (origins.get(o) ?? 0) + 1);
                }
              }
            }
            sinks.set(sinkId, s);
          }
        } else if (kind === "policy_decision") {
          const p = (asObject(record.payload) ?? {}) as PolicyPayload;
          if (p.decision === "deny") {
            pDenied += 1;
            const toolName = typeof p.toolName === "string" ? p.toolName : "(unknown tool)";
            policyDeniedTools.set(toolName, (policyDeniedTools.get(toolName) ?? 0) + 1);
          } else if (p.decision === "audit-and-allow") {
            pAuditAndAllow += 1;
          } else {
            pOther += 1;
          }
        }
      }
    }
  }

  const sessions = scanSessionDenials(join(rootDir, SESSIONS_RELPATH), sinceMs);

  const absentDeclaredKinds = DECLARED_AUDIT_KINDS.filter((k) => !countsByKind.has(k));

  return {
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    since: new Date(sinceMs).toISOString(),
    windowLabel: opts.window.label,
    rootDir,
    audit: {
      dir: auditDir,
      recordsScanned,
      recordsInWindow,
      malformedLines,
      countsByKind: Object.fromEntries([...countsByKind.entries()].sort()),
      absentDeclaredKinds,
    },
    justification: {
      evaluated: jEvaluated,
      allowed: jAllowed,
      denied: jDenied,
      denyRate: jEvaluated > 0 ? jDenied / jEvaluated : null,
      topDeniedTools: rankEntries(
        deniedTools,
        (t) => t.denials,
        (toolName, t): DeniedToolEntry => ({
          toolName,
          denials: t.denials,
          judges: [...t.judges].sort(),
          meanConfidence:
            t.confidences.length > 0
              ? t.confidences.reduce((a, b) => a + b, 0) / t.confidences.length
              : null,
          ...(t.lastReason !== undefined ? { lastReason: t.lastReason } : {}),
        }),
      ),
      byJudge: [...judges.entries()]
        .sort((a, b) => b[1].evaluated - a[1].evaluated || a[0].localeCompare(b[0]))
        .map(([judgeModel, j]) => ({ judgeModel, evaluated: j.evaluated, denied: j.denied })),
    },
    egress: {
      decisions: ePassed + eWarned + eBlocked,
      passed: ePassed,
      warned: eWarned,
      blocked: eBlocked,
      topSinks: rankEntries(
        sinks,
        (s) => s.blocked * 2 + s.warned,
        (sinkId, s): EgressSinkEntry => ({
          sinkId,
          warned: s.warned,
          blocked: s.blocked,
          origins: [...s.origins].sort(),
        }),
      ),
      topOrigins: rankEntries(
        origins,
        (c) => c,
        (name, count): CountEntry => ({ name, count }),
      ),
    },
    policy: {
      decisions: pDenied + pAuditAndAllow + pOther,
      denied: pDenied,
      auditAndAllow: pAuditAndAllow,
      topDeniedTools: rankEntries(
        policyDeniedTools,
        (c) => c,
        (name, count): CountEntry => ({ name, count }),
      ),
    },
    sessions,
  };
}

/** Prefixes the runtime writes into `tool_result` event contents on the
 *  block tier — the durable residue the session scan keys on. Kept in one
 *  place so the digest and its tests cite the same literals as
 *  `@crewhaus/runtime-core`'s denial messages. */
export const SESSION_DENIAL_MARKERS = {
  justification: "[justification denied]",
  egress: "[egress denied]",
  hook: "[blocked by hook]",
} as const;

const REDACTION_NOTICE_REGEX = /^\[tool output redacted: prompt injection detected: ([^\]]*)\]/;

type SessionEvent = {
  readonly ts?: unknown;
  readonly kind?: unknown;
  readonly payload?: unknown;
};

function scanSessionDenials(sessionsDir: string, sinceMs: number): SecurityDigest["sessions"] {
  let scanned = 0;
  let justificationDenials = 0;
  let egressBlocks = 0;
  let hookBlocks = 0;
  let injectionRedactions = 0;
  const ruleHits = new Map<string, number>();

  if (existsSync(sessionsDir)) {
    for (const file of readdirSync(sessionsDir).sort()) {
      if (!SESSION_EVENT_LOG_REGEX.test(file)) continue;
      scanned += 1;
      for (const raw of readFileSync(join(sessionsDir, file), "utf8").split("\n")) {
        if (raw === "") continue;
        let event: SessionEvent;
        try {
          event = JSON.parse(raw) as SessionEvent;
        } catch {
          continue; // the digest triages; event-log integrity is not its job
        }
        if (event.kind !== "tool_result") continue;
        if (typeof event.ts !== "number" || event.ts < sinceMs) continue;
        const payload = asObject(event.payload);
        const content = payload?.["content"];
        if (typeof content !== "string") continue;
        if (content.startsWith(SESSION_DENIAL_MARKERS.justification)) justificationDenials += 1;
        else if (content.startsWith(SESSION_DENIAL_MARKERS.egress)) egressBlocks += 1;
        else if (content.startsWith(SESSION_DENIAL_MARKERS.hook)) hookBlocks += 1;
        else {
          const m = REDACTION_NOTICE_REGEX.exec(content);
          if (m !== null) {
            injectionRedactions += 1;
            for (const rule of (m[1] as string).split(",")) {
              const id = rule.trim();
              if (id !== "") ruleHits.set(id, (ruleHits.get(id) ?? 0) + 1);
            }
          }
        }
      }
    }
  }

  return {
    scanned,
    justificationDenials,
    egressBlocks,
    hookBlocks,
    injectionRedactions,
    injectionRuleHits: [...ruleHits.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_N)
      .map(([name, count]) => ({ name, count })),
  };
}

/** Render the digest as the CLI's indented text summary lines. */
export function renderSecurityDigestText(d: SecurityDigest): ReadonlyArray<string> {
  const lines: string[] = [];
  const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
  lines.push(
    `window: ${d.windowLabel} (since ${d.since}) — ${d.audit.recordsInWindow} audit record(s) in window (${d.audit.recordsScanned} scanned${d.audit.malformedLines > 0 ? `, ${d.audit.malformedLines} malformed line(s) skipped` : ""})`,
  );

  lines.push(
    `justification gate: ${d.justification.evaluated} evaluated, ${d.justification.denied} denied (deny rate ${pct(d.justification.denyRate)})`,
  );
  for (const t of d.justification.topDeniedTools) {
    lines.push(
      `  ✗ ${t.toolName} — ${t.denials} denial(s) [judge=${t.judges.join(", ")}${
        t.meanConfidence !== null ? `, mean confidence ${t.meanConfidence.toFixed(2)}` : ""
      }]${t.lastReason !== undefined ? ` — last: ${t.lastReason}` : ""}`,
    );
  }
  for (const j of d.justification.byJudge) {
    lines.push(`  • judge ${j.judgeModel}: ${j.evaluated} evaluated, ${j.denied} denied`);
  }

  if (d.egress.decisions > 0) {
    lines.push(
      `egress: ${d.egress.decisions} decision(s) — ${d.egress.warned} warned, ${d.egress.blocked} blocked`,
    );
    for (const s of d.egress.topSinks) {
      lines.push(
        `  ✗ sink ${s.sinkId} — ${s.warned} warned / ${s.blocked} blocked (origins: ${s.origins.join(", ") || "n/a"})`,
      );
    }
    for (const o of d.egress.topOrigins) lines.push(`  • origin ${o.name}: ${o.count} hit(s)`);
  } else {
    lines.push(
      "egress: no durable egress_decision records — the kind is declared but has no writer yet; live verdicts surface per-run via CREWHAUS_SECURITY_DIGEST=1",
    );
  }

  lines.push(
    `policy engine: ${d.policy.decisions} audited decision(s) — ${d.policy.denied} denied, ${d.policy.auditAndAllow} audit-and-allow`,
  );
  for (const t of d.policy.topDeniedTools) lines.push(`  ✗ ${t.name} — ${t.count} denial(s)`);

  lines.push(
    `sessions (${d.sessions.scanned} event log(s)): ${d.sessions.justificationDenials} justification denial notice(s), ${d.sessions.egressBlocks} egress block(s), ${d.sessions.hookBlocks} hook block(s), ${d.sessions.injectionRedactions} injection redaction(s)`,
  );
  for (const r of d.sessions.injectionRuleHits) {
    lines.push(`  ✗ injection rule ${r.name}: ${r.count} hit(s)`);
  }

  const kindCounts = Object.entries(d.audit.countsByKind)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  lines.push(`audit kinds in window: ${kindCounts === "" ? "none" : kindCounts}`);
  if (d.audit.absentDeclaredKinds.length > 0) {
    lines.push(`  ~ declared kinds with no records: ${d.audit.absentDeclaredKinds.join(", ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// HTML rendering — local, dependency-free, following the visual style of
// packages/eval-report/src/render.ts (whose shell/escapeHtml are private to
// the eval-report shapes; see the module header for why we don't widen them).
// ---------------------------------------------------------------------------

const STYLE = `
:root {
  --bg: #0f1115; --fg: #e6e6e6; --muted: #999; --pass: #4caf50; --fail: #ef5350;
  --card: #1a1d23; --border: #333; --link: #61dafb;
}
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 24px; line-height: 1.5; }
h1 { margin: 0 0 16px; }
h2 { margin: 24px 0 12px; }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.aggregate { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 24px; }
.aggregate .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.aggregate .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
.aggregate .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; }
th { background: #14171c; }
tr:last-child td { border-bottom: none; }
.fail { color: var(--fail); font-weight: 600; }
.note { color: var(--muted); font-size: 13px; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function card(label: string, value: string): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function tableOf(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  if (rows.length === 0) return '<p class="note">none</p>';
  return `<table>
  <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody>
</table>`;
}

/** Render the digest as a self-contained HTML page (no external assets). */
export function renderSecurityDigestHtml(d: SecurityDigest): string {
  const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
  const body = `
<h1>Security digest</h1>
<p class="meta">Window ${escapeHtml(d.windowLabel)} (since ${escapeHtml(d.since)}) · generated ${escapeHtml(d.generatedAt)} · ${escapeHtml(d.rootDir)}</p>
<section class="aggregate">
${card("Audit records", String(d.audit.recordsInWindow))}
${card("Justification denials", String(d.justification.denied))}
${card("Judge deny rate", pct(d.justification.denyRate))}
${card("Egress warned", String(d.egress.warned))}
${card("Egress blocked", String(d.egress.blocked))}
${card("Policy denials", String(d.policy.denied))}
${card("Injection redactions", String(d.sessions.injectionRedactions))}
</section>
<h2>Top denied tools (justification gate)</h2>
${tableOf(
  ["Tool", "Denials", "Judges", "Mean confidence", "Last reason"],
  d.justification.topDeniedTools.map((t) => [
    t.toolName,
    String(t.denials),
    t.judges.join(", "),
    t.meanConfidence !== null ? t.meanConfidence.toFixed(2) : "n/a",
    t.lastReason ?? "",
  ]),
)}
<h2>Judges</h2>
${tableOf(
  ["Judge", "Evaluated", "Denied"],
  d.justification.byJudge.map((j) => [j.judgeModel, String(j.evaluated), String(j.denied)]),
)}
<h2>Egress sinks (warn/block)</h2>
${
  d.egress.decisions === 0
    ? '<p class="note">no durable egress_decision records — the kind is declared but has no writer yet; live verdicts surface per-run via CREWHAUS_SECURITY_DIGEST=1</p>'
    : tableOf(
        ["Sink", "Warned", "Blocked", "Origins"],
        d.egress.topSinks.map((s) => [
          s.sinkId,
          String(s.warned),
          String(s.blocked),
          s.origins.join(", "),
        ]),
      )
}
<h2>Policy denials</h2>
${tableOf(
  ["Tool", "Denials"],
  d.policy.topDeniedTools.map((t) => [t.name, String(t.count)]),
)}
<h2>Injection rule hits (session redaction notices)</h2>
${tableOf(
  ["Rule", "Hits"],
  d.sessions.injectionRuleHits.map((r) => [r.name, String(r.count)]),
)}
<h2>Audit kinds in window</h2>
${tableOf(
  ["Kind", "Records"],
  Object.entries(d.audit.countsByKind).map(([k, n]) => [k, String(n)]),
)}
<p class="note">Declared kinds with no records in window: ${escapeHtml(
    d.audit.absentDeclaredKinds.join(", ") || "none",
  )}</p>
`;
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Security digest ${escapeHtml(d.windowLabel)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body></html>`;
}

/** Thrown by `notifySecurityDigest` on a malformed URL or non-2xx response.
 *  The CLI routes it through `die()` — a scheduled digest whose notification
 *  silently failed would fabricate assurance, so it exits 1 loudly
 *  (mirroring audit-verify's requested-but-unconsulted-anchor stance). */
export class NotifyError extends Error {
  override readonly name = "NotifyError";
}

/**
 * POST the JSON digest to a webhook. Plain `fetch`, no channel-adapter
 * dependency (see module header); Slack users wrap the payload — incoming
 * webhooks accept `{ text }`, not arbitrary JSON.
 */
export async function notifySecurityDigest(
  url: string,
  digest: SecurityDigest,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotifyError(`invalid --notify URL "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NotifyError(`--notify only supports http(s) URLs (got "${parsed.protocol}//")`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(digest),
    });
  } catch (err) {
    throw new NotifyError(`--notify POST to ${url} failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new NotifyError(`--notify POST to ${url} returned ${res.status} ${res.statusText}`);
  }
}
