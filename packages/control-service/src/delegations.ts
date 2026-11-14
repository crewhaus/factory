/**
 * The delegation service: an owner's rule that lets the control plane resolve one narrow
 * kind of `ship` decision on the owner's behalf (#517, #513, module brief 325).
 *
 * - **Turning a rule on is the owner's.** `enable`, `update` and `resume` need the owner's
 *   authority (`decisions.mayManageRules`), the consequences page's digest as it is now
 *   and the harness's name typed to confirm. A maintainer only `propose`s: one owner-class
 *   request the owner answers from the page. A system actor, an anonymous caller and a
 *   service credential are refused before anything is read, on a harness with or without
 *   an approver list.
 * - **A rule binds to what it was turned on under**: the active deployment's ceiling
 *   digest and policy revision. A rule is read only from records: the ceiling only from
 *   the active deployment, never the saved spec.
 * - **Applying a rule** (`apply`, one pass) never runs on a read. It resolves a pending
 *   decision only when the rule is active, bound and in scope, its owner still holds the
 *   owner's authority, the operator lets work in, every gate the action requires passed
 *   for the exact revision, and the rule's cap and one-at-a-time condition hold. The
 *   rollback plan is written before anything acts, the decision is taken through the
 *   same first-decision-wins claim a person's takes, and the action runs as a receipted
 *   command under the rule's authority. The effect re-checks everything, uncached.
 * - **Every write** goes through the harness's control lock (`casAppend`), never the
 *   mutating lease, so a revoke or a pause lands at once even while an eval runs.
 * - **Reads** (`list`, `get`, `preview`) take no lock and write nothing: `preview` reads
 *   the digest key and never creates it.
 *
 * Nothing is delegable until an area registers an action (`DelegatedAction`): with none,
 * every request to turn a rule on answers `unsupported`.
 */
import { createHash } from "node:crypto";
import {
  BOOTSTRAP_PRINCIPAL,
  type LocalIdentity,
  loadAccessSnapshot,
} from "@crewhaus/access-control";
import {
  type CommandReceipt,
  type DelegationAction,
  type DelegationList,
  type DelegationLogLine,
  type DelegationLogView,
  type DelegationPage,
  type DelegationRevisionView,
  type DelegationRuleRow,
  type DelegationRuleView,
  type DelegationSubject,
  type DelegationTerms,
  type DelegationTermsRequest,
  HARNESS_ID_RE,
  LIVE_RULE_STATES,
  type SuspendReason,
  canonicalJson,
  isId,
  isRef,
  memberMayDecide,
  mintId,
  parseActor,
  verifyDecision,
} from "@crewhaus/control-contract";
import {
  type ConsequenceCommand,
  type ConsequenceLine,
  type EffectiveRuleState,
  type GateId,
  type GateVerdict,
  type Watch,
  authorizeDelegated,
  decidedByText,
  effectiveRuleState,
  isSuspendReason,
  normalizeRuleTerms,
  renderConsequences,
  ruleLabelOf,
  ruleTermsProblem,
} from "@crewhaus/control-contract/delegation";
import {
  type ActionDecisionRow,
  type ApproverRead,
  CONSEQUENCES_LABEL,
  DELEGATION_HOST_LABEL,
  DELEGATION_TERMS_LABEL,
  type LedgerRecord,
  PROPOSAL_TTL_MS,
  type ProposalRow,
  actionDecisionState,
  appendDelegationLog,
  casAppend,
  casAppendLocked,
  createApproverReader,
  createDelegationReader,
  decisionsLedger,
  delegationRuleOf,
  delegationsLedger,
  ensureDigestKey,
  intakeVerdict,
  keyedDigest,
  openActionDecision,
  proposalState,
  readActionDecisions,
  readDelegationLog,
  readDelegations,
  readDeployments,
  readDigestKey,
  readPage,
  readProposals,
  refreshOperatorRecord,
  ruleUses,
  withLedgerLock,
} from "@crewhaus/control-records";
import type { Commands } from "./commands";
import type { DecisionActor, Decisions } from "./decisions";
import { isServiceActor } from "./deployments";
import type {
  DelegatedAction,
  DelegatedActionScope,
  Executor,
  ExecutorContext,
  RetireRevoker,
  Settlement,
} from "./executor";
import { outcomeOf } from "./refusal";

const DAY_MS = 86_400_000;
/** The window a consequences page's evidence counts over. */
const EVIDENCE_DAYS = 30;
/** A view of the application log reads at most this many lines. */
const LOG_VIEW_LINES = 2000;
/** A rule's history, as `get` shows it, reads at most this many rows. */
const HISTORY_ROWS = 500;

/** Said on every read: where rules are applied, and what happens otherwise. */
export const APPLY_NOTE =
  "Rules are applied while Home is running and whenever `crewhaus delegations apply` runs. Otherwise these decisions wait for a person.";

/** What turning a rule on answers when no registered action serves it. */
export const NOTHING_DELEGABLE = "Nothing can be delegated this way yet.";

/** What a harness whose active agreement allows no delegation answers. */
export const NOT_ALLOWED =
  "Nothing can be delegated on this harness yet. Its agreement doesn't allow it.";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The harness a call is about: its live directory, its id, and the name a person types. */
export type DelegationHarness = {
  readonly dir: string;
  readonly id: string;
  readonly name?: string;
};

export type DelegationRefusal = {
  readonly ok: false;
  readonly code:
    | "forbidden"
    | "invalid"
    | "unsupported"
    | "not-allowed"
    | "precondition-failed"
    | "not-found"
    | "conflict"
    | "already-decided"
    | "unavailable";
  readonly reason: string;
  /** The permission the caller lacks. */
  readonly needs?: string;
  /** The page as it is now, on a stale digest. */
  readonly page?: DelegationPage;
};

export type DelegationWrite = {
  readonly ok: true;
  readonly rule?: DelegationRuleRow;
  readonly rules?: readonly DelegationRuleRow[];
  readonly view?: DelegationRuleView;
  readonly proposal?: string;
};

export type PreviewAnswer =
  | { readonly ok: true; readonly page: DelegationPage }
  | DelegationRefusal;

export type ApplySummary = {
  /** Whether the pass found anything to do; nothing is written when it did not. */
  readonly ran: boolean;
  /** The receipt the pass's writes name. */
  readonly cmd?: string;
  readonly decided: number;
  readonly refused: number;
  readonly notApplied: number;
  readonly suspended: number;
  readonly ended: number;
  readonly watchesStarted: number;
  readonly rolledBack: number;
  readonly rollbackFailed: number;
  readonly kept: number;
  /** Why the pass could not run, when it could not. */
  readonly reason?: string;
};

export type DelegationDetailAnswer =
  | {
      readonly ok: true;
      readonly detail: {
        readonly rule: DelegationRuleView;
        readonly terms: DelegationTerms;
        readonly revisions: readonly DelegationRevisionView[];
        readonly log: readonly DelegationLogView[];
        readonly truncated?: { readonly reason: string; readonly verb?: string };
      };
    }
  | DelegationRefusal;

/** What the v1 list and the CLI show, before the transport adds its cursor. */
export type DelegationListing = Omit<DelegationList, "snapshotAt"> & {
  /** What could not be read, one sentence each. */
  readonly unreadable: readonly string[];
};

type Write<T> = T & { readonly actor: DecisionActor; readonly cmd: string };

export type Delegations = {
  list(harness: DelegationHarness): DelegationListing;
  get(harness: DelegationHarness, rule: string): DelegationDetailAnswer;
  preview(
    harness: DelegationHarness,
    request: { readonly action: DelegationAction; readonly terms?: DelegationTermsRequest },
  ): Promise<PreviewAnswer>;
  enable(
    harness: DelegationHarness,
    request: Write<{
      readonly action: DelegationAction;
      readonly terms?: DelegationTermsRequest;
      readonly consequencesDigest: string;
      readonly confirm: string;
      readonly proposal?: string;
    }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
  propose(
    harness: DelegationHarness,
    request: Write<{ readonly action: DelegationAction; readonly terms?: DelegationTermsRequest }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
  /** The page a change or a resume confirms, for a rule that exists. A read. */
  previewRule(
    harness: DelegationHarness,
    request: {
      readonly rule: string;
      readonly mode: "change" | "resume";
      readonly terms?: DelegationTermsRequest;
    },
  ): Promise<PreviewAnswer>;
  update(
    harness: DelegationHarness,
    request: Write<{
      readonly rule: string;
      readonly expect: number;
      readonly terms?: DelegationTermsRequest;
      readonly consequencesDigest: string;
      readonly confirm: string;
    }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
  pause(
    harness: DelegationHarness,
    request: Write<{ readonly rule: string; readonly reason?: "paused-by-member" }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
  resume(
    harness: DelegationHarness,
    request: Write<{
      readonly rule: string;
      readonly expect: number;
      readonly consequencesDigest: string;
      readonly confirm: string;
    }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
  revoke(
    harness: DelegationHarness,
    request: Write<
      | { readonly rule: string; readonly expect?: number; readonly all?: false }
      | { readonly all: true; readonly rule?: undefined; readonly expect?: undefined }
    >,
  ): Promise<DelegationWrite | DelegationRefusal>;
  /** One pass of the sweep. Never called by a read. */
  apply(
    harness: DelegationHarness,
    options: { readonly appliedBy: string; readonly cmd?: string },
  ): Promise<ApplySummary>;
  /** End a watch by hand: the action stays as it is. */
  keepWatch(
    harness: DelegationHarness,
    request: Write<{ readonly watch: string }>,
  ): Promise<DelegationWrite | DelegationRefusal>;
};

export type DelegationsDeps = {
  readonly hangarRoot: string;
  readonly identity: LocalIdentity;
  readonly now: () => number;
  readonly decisions: Decisions;
  readonly commands: Pick<Commands, "submit"> & {
    /** Move an `accepted` receipt this service wrote to its final state. */
    readonly settle?: (
      ledger: { readonly harness: string },
      id: string,
      settlement: Settlement,
    ) => Promise<CommandReceipt | undefined>;
  };
  /** The actions this composition serves (`delegatedActions(areas)`). */
  readonly actions: readonly DelegatedAction[];
  /** The approver projection reader; uncached by default. */
  readonly approvers?: (harnessDir: string) => ApproverRead;
};

// ---------------------------------------------------------------------------
// Records the service reads
// ---------------------------------------------------------------------------

/** The active deployment's delegation ceiling, its digest and its policy revision. */
export type ActiveCeiling = {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly maxDays: number;
  readonly digest: string;
  readonly policyRevision: string;
};

export type CeilingRead =
  | { readonly state: "none" }
  | { readonly state: "unreadable"; readonly reason: string }
  | { readonly state: "present"; readonly ceiling: ActiveCeiling };

/** `sha256:` over a ceiling's canonical JSON: what a rule binds to. */
export function ceilingDigestOf(ceiling: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(ceiling), "utf8").digest("hex")}`;
}

/**
 * The ceiling as the active deployment's record holds it, parsed: `maxDays` a whole
 * number from 1 to 90; every other member passed to the action that reads it.
 */
export function ceilingOf(
  record: Readonly<Record<string, unknown>> | undefined,
): ActiveCeiling | undefined {
  const raw = record?.["delegation"];
  const policyRevision = record?.["policyRevision"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (typeof policyRevision !== "string" || policyRevision === "") return undefined;
  const maxDays = (raw as Record<string, unknown>)["maxDays"];
  if (!Number.isSafeInteger(maxDays) || (maxDays as number) < 1 || (maxDays as number) > 90) {
    return undefined;
  }
  return {
    raw: raw as Readonly<Record<string, unknown>>,
    maxDays: maxDays as number,
    digest: ceilingDigestOf(raw),
    policyRevision,
  };
}

/** The ceiling of the harness's active deployment only: a prepared one allows nothing. */
export function activeCeiling(harnessDir: string): CeilingRead {
  const read = readDeployments(harnessDir);
  if (read.state === "unreadable") return { state: "unreadable", reason: read.reason };
  if (read.state === "absent" || read.active === undefined) return { state: "none" };
  const ceiling = ceilingOf(read.active);
  return ceiling === undefined ? { state: "none" } : { state: "present", ceiling };
}

/**
 * Whether a rule's enabling owner still holds the owner's authority: with no approver
 * list the harness is single-owner, so yes; with one, by it, now; with one that cannot be
 * read, could not tell (`undefined`).
 */
export function ownerHolds(read: ApproverRead, owner: string, now: number): boolean | undefined {
  if (read.state === "absent") return true;
  if (read.state !== "present") return undefined;
  return memberMayDecide(read.projection, owner, "owner", now);
}

const isLive = (state: string): boolean => (LIVE_RULE_STATES as readonly string[]).includes(state);

const iso = (ms: number): string => new Date(ms).toISOString();

const dayOf = (ms: number): string => iso(ms).slice(0, 10);

function lockRefused(
  answer: unknown,
): answer is { readonly code: string; readonly reason: string } {
  return typeof answer === "object" && answer !== null && "code" in answer && "path" in answer;
}

function refusal(
  code: DelegationRefusal["code"],
  reason: string,
  extra: Partial<Pick<DelegationRefusal, "needs" | "page">> = {},
): DelegationRefusal {
  return { ok: false, code, reason, ...extra };
}

/** A rule's row without the keys a later row must not inherit. */
function carried(rule: DelegationRuleRow): DelegationRuleRow {
  const { reason: _reason, ...rest } = rule;
  return rest as DelegationRuleRow;
}

/** The rule as a list shows it, from its row and its application lines. */
export function ruleViewOf(
  rule: DelegationRuleRow,
  lines: readonly DelegationLogLine[],
  now: number,
): DelegationRuleView {
  const uses = ruleUses(lines, rule.id);
  const state = effectiveRuleState(rule, now, uses);
  let last: DelegationLogLine | undefined;
  for (const line of lines) if (line.event === "acted" && line.rule === rule.id) last = line;
  return {
    id: rule.id,
    action: rule.action,
    state: state.state,
    revision: rule.revision,
    label: ruleLabelOf(rule.action),
    endsAt: rule.expiresAt,
    uses,
    ...(rule.maxUses !== undefined ? { maxUses: rule.maxUses } : {}),
    ...(last !== undefined
      ? {
          lastAction: {
            at: last.at,
            ...(last.decision !== undefined ? { decision: last.decision } : {}),
            ...(last.cmd !== undefined ? { cmd: last.cmd } : {}),
          },
        }
      : {}),
    ...(state.state === "suspended" && isSuspendReason(rule.reason)
      ? { suspendedReason: rule.reason }
      : {}),
  };
}

/** The application lines, whole, for a write; a read that cannot be made reads as none. */
function wholeLog(harnessDir: string): DelegationLogLine[] {
  const read = readDelegationLog(harnessDir);
  return read.state === "present" ? [...read.lines] : [];
}

/** A subject's revision as an application line may hold it. */
const REVISION_TEXT_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

/** A verdict as the log keeps it: ids, codes and times only, whatever a gate answered. */
function gateLine(verdict: GateVerdict): NonNullable<DelegationLogLine["gates"]>[number] {
  const time = (value: unknown, fallback: string): string =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
  return {
    gate: verdict.gate,
    outcome: verdict.outcome,
    boundTo:
      typeof verdict.boundTo === "string" && REVISION_TEXT_RE.test(verdict.boundTo)
        ? verdict.boundTo
        : "unreadable",
    evidence: (Array.isArray(verdict.evidence) ? verdict.evidence : []).filter(isRef).slice(0, 20),
    at: time(verdict.at, iso(0)),
    freshUntil: time(verdict.freshUntil, iso(0)),
    ...(typeof verdict.reason === "string" && /^[a-z][a-z0-9_-]{0,47}$/.test(verdict.reason)
      ? { reason: verdict.reason }
      : {}),
  };
}

/** What the effect, the sweep and a gate are shown about a harness. */
function ctxOf(harnessDir: string, now: number) {
  return { harnessDir, now };
}

/** What a refusal at the effect supersedes the grant with, and what its line says. */
function effectRefusal(verdict: ReturnType<typeof verifyDecision>): {
  readonly supersede?: "rule-revoked" | "revision-changed";
  readonly reason: string;
} {
  if (verdict.ok) return { reason: "rule-revoked" };
  if (verdict.reason === "revision-changed") {
    return { supersede: "revision-changed", reason: "revision-changed" };
  }
  if (verdict.reason === "decider-not-authorized")
    return { supersede: "rule-revoked", reason: "rule-revoked" };
  if (verdict.reason === "expired") return { reason: "decision-expired" };
  return { reason: "already-spent" };
}

/** A decision row as `verifyDecision` reads it. */
function recordViewOf(row: ActionDecisionRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind,
    actionClass: row.actionClass,
    expiresAt: row.expiresAt,
    requiredClass: row.requiredClass,
    subject: row.subject,
    ...(row.decision !== undefined ? { decision: row.decision } : {}),
    ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
    ...(row.decidedByPrincipal !== undefined ? { decidedByPrincipal: row.decidedByPrincipal } : {}),
    ...(row.resolvedBy !== undefined ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.delegation !== undefined ? { delegation: row.delegation } : {}),
    ...(row.appliedBy !== undefined ? { appliedBy: row.appliedBy } : {}),
    ...(row.consumedAt !== undefined ? { consumedAt: row.consumedAt } : {}),
    ...(row.supersededBy !== undefined ? { supersededBy: row.supersededBy } : {}),
  };
}

/** The decision a receipt's target names, when it names one. */
function decisionOfTarget(target: string): string | undefined {
  const parts = target.split("/");
  return parts.length === 3 && parts[1] === "decision" && isId("dec", parts[2])
    ? parts[2]
    : undefined;
}

/** The command a rollback receipt's target names: the action's own receipt. */
function commandOfTarget(target: string): string | undefined {
  const parts = target.split("/");
  return parts.length === 3 && parts[1] === "cmd" && isId("cmd", parts[2]) ? parts[2] : undefined;
}

/**
 * Supersede a grant a person must now decide, and ask again in its place: a fresh pending
 * decision for the same subject, at its current revision when it is known.
 */
async function reask(
  harnessDir: string,
  row: ActionDecisionRow,
  reason: "rule-revoked" | "revision-changed" | "paused",
  revision: string | undefined,
  now: number,
): Promise<string | undefined> {
  const fresh = await openActionDecision(harnessDir, {
    kind: row.kind,
    subject: {
      ref: row.subject.ref,
      revision:
        revision !== undefined && REVISION_TEXT_RE.test(revision) ? revision : row.subject.revision,
    },
    requiredClass: row.requiredClass,
    proposedBy: row.proposedBy,
    now,
  });
  const next: ActionDecisionRow = {
    ...row,
    state: "superseded",
    supersededAt: iso(now),
    supersededReason: reason,
    ...(fresh.ok ? { supersededBy: fresh.row.id } : {}),
  };
  await casAppend(decisionsLedger(harnessDir), row.id, row.state, next as unknown as LedgerRecord);
  return fresh.ok ? fresh.row.id : undefined;
}

/**
 * The code every delegated action's executor runs first, around the action's own effect.
 * Uncached, it reads the rule, the decision, the active deployment, the operator record
 * and the approver list, and checks the grant with `verifyDecision`'s delegated branch.
 * Any failure leaves the grant unspent: it is logged `refused`, superseded, and asked
 * again for a person. Otherwise the grant is consumed, the effect runs, and `acted` is
 * logged with the command's id, which opens the watch.
 *
 * First consumers: the areas that register a delegated action.
 */
export function delegatedExecutor(
  action: Pick<DelegatedAction, "currentRevision">,
  run: (ctx: ExecutorContext, decision: ActionDecisionRow) => Promise<Settlement>,
): Executor {
  return async (ctx) => {
    const { receipt, harnessDir } = ctx;
    const now = ctx.now();
    const authority = receipt.authority;
    const decisionId = decisionOfTarget(receipt.target);
    if (authority?.kind !== "delegation" || decisionId === undefined) {
      return { state: "rejected", outcome: outcomeOf("forbidden") };
    }
    const rules = readDelegations(harnessDir);
    const rule =
      rules.state === "present" ? rules.rows.find((r) => r.id === authority.rule) : undefined;
    const decisions = readActionDecisions(harnessDir);
    const row =
      decisions.state === "present" ? decisions.rows.find((r) => r.id === decisionId) : undefined;
    if (rule === undefined || row === undefined) {
      return { state: "rejected", outcome: outcomeOf("not_found") };
    }
    const lines = wholeLog(harnessDir);
    const log = async (event: "refused" | "acted", reason?: string) => {
      await appendDelegationLog(harnessDir, {
        v: 1,
        at: iso(ctx.now()),
        event,
        rule: rule.id,
        revision: authority.revision,
        decision: row.id,
        subject: row.subject,
        cmd: receipt.id,
        ...(row.appliedBy !== undefined ? { appliedBy: row.appliedBy } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
    };
    const state = effectiveRuleState(rule, now, ruleUses(lines, rule.id));
    const ceiling = activeCeiling(harnessDir);
    const bound =
      ceiling.state === "present" &&
      ceiling.ceiling.digest === rule.ceilingDigest &&
      ceiling.ceiling.policyRevision === rule.policyRevision &&
      row.delegation?.rule === authority.rule &&
      row.delegation.revision === authority.revision;
    const operator = intakeVerdict(harnessDir, { read: refreshOperatorRecord });
    let subjectRevision: string | undefined;
    try {
      subjectRevision = await action.currentRevision(row.subject, ctxOf(harnessDir, now));
    } catch {
      subjectRevision = undefined;
    }
    const verdict = verifyDecision({
      decision: recordViewOf(row),
      consumer: { runId: "", resumeScope: "" },
      approvers: { state: "absent" },
      now,
      delegation: {
        ruleState: bound ? state : { state: "suspended", revision: state.revision },
        // A reader of its own: its first read is the file as it is now.
        ownerHolds: ownerHolds(createApproverReader()(harnessDir), rule.owner, now),
        subjectRevision,
      },
    });
    if (operator.state !== "open" || !verdict.ok) {
      const why =
        operator.state !== "open"
          ? { supersede: "paused" as const, reason: "paused" }
          : effectRefusal(verdict);
      await log("refused", why.reason);
      if (why.supersede !== undefined && row.state === "granted") {
        await reask(harnessDir, row, why.supersede, subjectRevision, now);
      }
      return { state: "rejected", outcome: outcomeOf("conflict") };
    }
    const consumed = await casAppend(decisionsLedger(harnessDir), row.id, "granted", {
      ...row,
      state: "consumed",
      consumedAt: iso(now),
    } as unknown as LedgerRecord);
    if (!consumed.ok || !consumed.applied) {
      await log("refused", "already-spent");
      return { state: "rejected", outcome: outcomeOf("already_decided") };
    }
    let settle: Settlement;
    try {
      settle = await run(ctx, row);
    } catch {
      settle = { state: "unknown", outcome: outcomeOf("internal") };
    }
    await log(
      settle.state === "succeeded" ? "acted" : "refused",
      settle.state === "succeeded" ? undefined : "effect-failed",
    );
    return settle;
  };
}

/**
 * The code every delegated rollback's executor runs first: a rollback undoes only what a
 * rule did, so the action its target names must have acted under the same rule and
 * revision the receipt's authority names. It does not ask whether the rule still applies:
 * a rollback restores a state already accepted, and outlives a pause or a revoke.
 *
 * First consumers: the areas that register a delegated action.
 */
export function delegatedRollbackExecutor(
  run: (ctx: ExecutorContext, acted: DelegationLogLine) => Promise<Settlement>,
): Executor {
  return async (ctx) => {
    const { receipt, harnessDir } = ctx;
    const authority = receipt.authority;
    const acted = commandOfTarget(receipt.target);
    if (
      authority?.kind !== "delegation" ||
      authority.clause !== "rollback" ||
      acted === undefined
    ) {
      return { state: "rejected", outcome: outcomeOf("forbidden") };
    }
    const line = wholeLog(harnessDir).find(
      (l) =>
        l.event === "acted" &&
        l.cmd === acted &&
        l.rule === authority.rule &&
        l.revision === authority.revision,
    );
    if (line === undefined) return { state: "rejected", outcome: outcomeOf("not_found") };
    try {
      return await run(ctx, line);
    } catch {
      return { state: "unknown", outcome: outcomeOf("internal") };
    }
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

type PageParts = {
  readonly page: DelegationPage;
  readonly terms: DelegationTerms;
  readonly ceiling: ActiveCeiling;
  readonly served: DelegatedAction;
  readonly digest?: string;
  readonly hostDigest?: string;
  readonly termsDigest?: string;
};

export function createDelegations(deps: DelegationsDeps): Delegations {
  // By the service's own clock, so a demotion is read within a second of it.
  const approvers = deps.approvers ?? createApproverReader({ now: deps.now });
  const cached = createDelegationReader({ now: deps.now });

  const servedFor = (action: DelegationAction): DelegatedAction | undefined =>
    action === "assistant" ? undefined : deps.actions.find((a) => a.action === action);

  /** Why this caller is never the one who acts, or `undefined`. Checked before any read. */
  const personless = (actor: DecisionActor): string | undefined => {
    if (actor.kind === "anonymous") return "Only someone signed in to this Home can do this.";
    if (actor.kind !== "principal") return undefined;
    // A sweep's principal (`sys:<name>`) and anything else that is not a member is no one.
    if (
      parseActor(actor.principal)?.form === "system" ||
      (!isId("prn", actor.principal) && actor.principal !== BOOTSTRAP_PRINCIPAL)
    ) {
      return "The system never turns a delegation rule on, changes or resumes one: a person does.";
    }
    if (actor.service === true || isServiceActor(deps.hangarRoot, actor.principal)) {
      return "A service credential never manages a delegation rule: a person does.";
    }
    return undefined;
  };

  const ownerOnly = (dir: string, actor: DecisionActor): DelegationRefusal | undefined => {
    const no = personless(actor);
    if (no !== undefined) return refusal("forbidden", no, { needs: "h.standing-rule.manage" });
    return deps.decisions.mayManageRules(dir, actor)
      ? undefined
      : refusal(
          "forbidden",
          "Only this harness's owner turns a delegation rule on, changes it or ends it.",
          {
            needs: "h.standing-rule.manage",
          },
        );
  };

  /** A maintainer's act (propose, pause, keep): any local user on a single-owner harness. */
  const maintainerOnly = (
    dir: string,
    actor: DecisionActor,
    needs: string,
  ): DelegationRefusal | undefined => {
    const no = personless(actor);
    if (no !== undefined) return refusal("forbidden", no, { needs });
    const read = approvers(dir);
    if (read.state === "absent") return undefined;
    if (read.state !== "present") {
      return refusal(
        "forbidden",
        `This harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\`.`,
        { needs },
      );
    }
    const who = deps.decisions.principalOf(actor, dir);
    return who.principal !== undefined &&
      memberMayDecide(read.projection, who.principal, "maintainer", deps.now())
      ? undefined
      : refusal("forbidden", "Needs a maintainer or the owner.", { needs });
  };

  const evidenceOf = (dir: string, served: DelegatedAction, now: number) => {
    const since = now - EVIDENCE_DAYS * DAY_MS;
    const read = readActionDecisions(dir);
    let approved = 0;
    let refused = 0;
    if (read.state === "present") {
      for (const row of read.rows) {
        if (row.kind !== served.decisionKind || row.decidedByPrincipal === undefined) continue;
        const at = Date.parse(row.decidedAt ?? "");
        if (!Number.isFinite(at) || at < since) continue;
        if (row.decision === "grant") approved += 1;
        else if (row.decision === "deny") refused += 1;
      }
    }
    let rolledBack = 0;
    for (const line of wholeLog(dir)) {
      const at = Date.parse(line.at);
      if (line.event === "rolled-back" && Number.isFinite(at) && at >= since) rolledBack += 1;
    }
    return approved + refused + rolledBack === 0
      ? null
      : { days: EVIDENCE_DAYS, approved, refused, rolledBack };
  };

  /**
   * The consequences page from the records as they are now. `key: "read"` never creates
   * the digest key (a read); `"ensure"` does (a write that binds to the digest).
   */
  const pageFor = async (
    harness: DelegationHarness,
    action: DelegationAction,
    termsRequest: DelegationTermsRequest | undefined,
    command: ConsequenceCommand,
    key: "read" | "ensure",
    endsAt?: number,
  ): Promise<PageParts | DelegationRefusal> => {
    if (action === "assistant") {
      return refusal(
        "unsupported",
        "Rules for the assistant are set up in Home's settings, not on a harness.",
      );
    }
    const served = servedFor(action);
    if (served === undefined) return refusal("unsupported", NOTHING_DELEGABLE);
    if (!HARNESS_ID_RE.test(harness.id)) {
      return refusal(
        "unavailable",
        "This harness has no id yet: register it with `crewhaus harness adopt`.",
      );
    }
    const name = harness.name;
    if (name === undefined)
      return refusal("unavailable", "This harness has no name to confirm with.");
    const read = activeCeiling(harness.dir);
    if (read.state === "unreadable") return refusal("unavailable", read.reason);
    if (read.state === "none") return refusal("not-allowed", NOT_ALLOWED);
    const { ceiling } = read;
    const scope = served.scopeOf(ceiling.raw);
    if (scope === undefined) {
      return refusal("not-allowed", "This harness's agreement doesn't allow delegating this.");
    }
    const problem = ruleTermsProblem({
      action,
      terms: termsRequest,
      ceiling: { maxDays: ceiling.maxDays },
      scopeFields: scope.fields,
    });
    if (problem !== undefined) return refusal("invalid", problem);
    const terms = normalizeRuleTerms(termsRequest, { maxDays: ceiling.maxDays });
    const now = deps.now();
    let host: readonly ConsequenceLine[];
    try {
      host = await served.previewTerms(scope, ctxOf(harness.dir, now));
    } catch {
      return refusal("unavailable", "What the host says about this could not be read.");
    }
    let rendered: ReturnType<typeof renderConsequences>;
    try {
      rendered = renderConsequences({
        action,
        harness: { id: harness.id, name },
        terms,
        ceiling: { digest: ceiling.digest, policyRevision: ceiling.policyRevision },
        requiredGates: served.requiredGates,
        host,
        evidence: evidenceOf(harness.dir, served, now),
        endsOn: dayOf(endsAt ?? now + terms.days * DAY_MS),
        command,
      });
    } catch (err) {
      return refusal("invalid", err instanceof Error ? err.message : String(err));
    }
    const keyRead =
      key === "ensure" ? await ensureDigestKey(harness.dir) : await readDigestKey(harness.dir);
    if (keyRead.state === "unreadable") return refusal("unavailable", keyRead.reason);
    const hmac = keyRead.state === "present" ? keyRead.hmac : undefined;
    const digest =
      hmac === undefined
        ? undefined
        : await keyedDigest(hmac, CONSEQUENCES_LABEL, [canonicalJson(rendered.material)]);
    const termsDigest =
      hmac === undefined
        ? undefined
        : await keyedDigest(hmac, DELEGATION_TERMS_LABEL, [canonicalJson(terms)]);
    const hostDigest =
      hmac === undefined || host.length === 0
        ? undefined
        : await keyedDigest(hmac, DELEGATION_HOST_LABEL, [
            canonicalJson(rendered.material["host"]),
          ]);
    const page: DelegationPage = {
      action,
      title: rendered.title,
      sections: rendered.sections,
      text: rendered.text,
      ...(digest !== undefined ? { consequencesDigest: digest } : {}),
      ...(digest === undefined ? { note: "Turning it on sets up this harness's key first." } : {}),
      confirmName: name,
      verb: `crewhaus ${rendered.argv.join(" ")}`,
    };
    return {
      page,
      terms,
      ceiling,
      served,
      ...(digest !== undefined ? { digest } : {}),
      ...(termsDigest !== undefined ? { termsDigest } : {}),
      ...(hostDigest !== undefined ? { hostDigest } : {}),
    };
  };

  /** Write rule rows under the harness's control lock, each a compare-and-set. */
  const writeRules = async (
    dir: string,
    writes: readonly { readonly expect: string | null; readonly row: DelegationRuleRow }[],
    before?: () => Promise<DelegationRefusal | undefined>,
  ): Promise<DelegationWrite | DelegationRefusal> => {
    for (const { row } of writes) {
      if (delegationRuleOf(row as unknown as LedgerRecord) === undefined) {
        return refusal("invalid", "The rule would hold something a rule may not.");
      }
    }
    const answer = await withLedgerLock(delegationsLedger(dir), async () => {
      const first = await before?.();
      if (first !== undefined) return first;
      const written: DelegationRuleRow[] = [];
      for (const { expect, row } of writes) {
        const cas = await casAppendLocked(
          delegationsLedger(dir),
          row.id,
          expect,
          row as unknown as LedgerRecord,
        );
        if (!cas.ok) return refusal("unavailable", cas.reason);
        if (!cas.applied) {
          return refusal(
            "conflict",
            "The rule changed while this was being written; read it again.",
          );
        }
        written.push(row);
      }
      return {
        ok: true as const,
        rules: written,
        ...(written[0] !== undefined ? { rule: written[0] } : {}),
      };
    });
    return lockRefused(answer) ? refusal("unavailable", answer.reason) : answer;
  };

  const readRule = (
    dir: string,
    id: string,
  ):
    | { readonly rule: DelegationRuleRow; readonly state: EffectiveRuleState }
    | DelegationRefusal => {
    const read = readDelegations(dir);
    if (read.state === "unreadable") return refusal("unavailable", read.reason);
    const rule = read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
    if (rule === undefined)
      return refusal("not-found", "This harness has no delegation rule by that id.");
    return { rule, state: effectiveRuleState(rule, deps.now(), ruleUses(wholeLog(dir), id)) };
  };

  const confirmProblem = (
    harness: DelegationHarness,
    confirm: string,
  ): DelegationRefusal | undefined =>
    harness.name !== undefined && confirm === harness.name
      ? undefined
      : refusal("invalid", `Type ${harness.name ?? "the harness's name"} to confirm.`);

  // -------------------------------------------------------------------------
  // The pass
  // -------------------------------------------------------------------------

  type Plan = {
    readonly rules: DelegationRuleRow[];
    readonly lines: DelegationLogLine[];
    readonly ceiling: CeilingRead;
  };

  const ZERO = {
    decided: 0,
    refused: 0,
    notApplied: 0,
    suspended: 0,
    ended: 0,
    watchesStarted: 0,
    rolledBack: 0,
    rollbackFailed: 0,
    kept: 0,
  };

  const runPass = async (
    harness: DelegationHarness,
    plan: Plan,
    appliedBy: string,
    cmdFor: () => Promise<string | undefined>,
  ): Promise<ApplySummary> => {
    const dir = harness.dir;
    const counts = { ...ZERO };
    const rules = new Map(plan.rules.map((rule) => [rule.id, rule]));
    const lines = plan.lines;
    const projection = approvers(dir);
    const now = deps.now();
    const log = async (line: Omit<DelegationLogLine, "v" | "at">): Promise<void> => {
      const full: DelegationLogLine = { v: 1, at: iso(deps.now()), ...line };
      const answer = await appendDelegationLog(dir, full);
      if (answer.ok) lines.push(full);
    };
    const move = async (
      rule: DelegationRuleRow,
      state: DelegationRuleRow["state"],
      reason?: SuspendReason,
    ): Promise<void> => {
      const cmd = await cmdFor();
      if (cmd === undefined) return;
      const next: DelegationRuleRow = {
        ...carried(rule),
        at: iso(deps.now()),
        state,
        by: appliedBy,
        cmd,
        ...(reason !== undefined ? { reason } : {}),
      };
      const written = await writeRules(dir, [{ expect: rule.state, row: next }]);
      if (written.ok) rules.set(rule.id, next);
    };
    const suspend = async (rule: DelegationRuleRow, reason: SuspendReason): Promise<void> => {
      if (!isLive(rule.state)) return;
      await move(rule, "suspended", reason);
      counts.suspended += 1;
    };

    // Ends a clock or a cap reached, once.
    for (const rule of [...rules.values()]) {
      const state = effectiveRuleState(rule, now, ruleUses(lines, rule.id));
      if (!state.materialized && (state.state === "expired" || state.state === "exhausted")) {
        await move(rule, state.state);
        counts.ended += 1;
      }
    }

    // Owner authority, the policy and the ceiling, re-read every pass.
    for (const rule of [...rules.values()]) {
      if (effectiveRuleState(rule, now, ruleUses(lines, rule.id)).state !== "active") continue;
      if (plan.ceiling.state === "present") {
        if (plan.ceiling.ceiling.digest !== rule.ceilingDigest) {
          await suspend(rule, "ceiling-changed");
          continue;
        }
        if (plan.ceiling.ceiling.policyRevision !== rule.policyRevision) {
          await suspend(rule, "policy-changed");
          continue;
        }
      }
      if (ownerHolds(projection, rule.owner, now) === false) {
        await suspend(rule, "owner-authority-changed");
      }
    }

    // The decisions an active rule may resolve, oldest first.
    const operator = intakeVerdict(dir, { read: refreshOperatorRecord });
    const decisions = readActionDecisions(dir);
    const pending =
      decisions.state === "present"
        ? decisions.rows
            .filter((row) => actionDecisionState(row, now) === "pending")
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        : [];
    for (const decision of pending) {
      const served = deps.actions.find((a) => a.decisionKind === decision.kind);
      if (served === undefined) continue;
      const candidates = [...rules.values()]
        .filter(
          (rule) =>
            rule.action === served.action &&
            effectiveRuleState(rule, now, ruleUses(lines, rule.id)).state === "active",
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (candidates.length === 0) continue;
      const scope: DelegatedActionScope | undefined =
        plan.ceiling.state === "present" ? served.scopeOf(plan.ceiling.ceiling.raw) : undefined;
      const holds = (rule: DelegationRuleRow): boolean => {
        if (scope === undefined) return false;
        try {
          return served.inScope(rule.terms, scope, decision.subject);
        } catch {
          return false;
        }
      };
      const rule = candidates.find(holds) ?? (candidates[0] as DelegationRuleRow);
      const base = {
        rule: rule.id,
        revision: rule.revision,
        decision: decision.id,
        subject: decision.subject,
        appliedBy,
      };
      let oneAtATime = false;
      try {
        oneAtATime = served.oneAtATime(lines, decision.subject) === true;
      } catch {
        oneAtATime = false;
      }
      const input = {
        decision,
        rule,
        ruleState: effectiveRuleState(rule, now, ruleUses(lines, rule.id)),
        ceiling:
          plan.ceiling.state === "present"
            ? {
                digest: plan.ceiling.ceiling.digest,
                policyRevision: plan.ceiling.ceiling.policyRevision,
              }
            : undefined,
        subject: { revision: decision.subject.revision, inScope: holds(rule) },
        requiredGates: [] as GateId[],
        verdicts: [] as GateVerdict[],
        operator,
        ownerHolds: ownerHolds(projection, rule.owner, now),
        now,
        uses: ruleUses(lines, rule.id),
        oneAtATime,
      };
      const refuse = async (
        answer: Extract<ReturnType<typeof authorizeDelegated>, { allow: false }>,
        gates?: DelegationLogLine["gates"],
      ): Promise<void> => {
        const event = answer.step === 5 ? "refused" : "not-applied";
        const line = {
          ...base,
          event,
          reason: answer.reason,
          ...(gates !== undefined ? { gates } : {}),
        } as const;
        if (!repeats(lines, line)) {
          if (gates !== undefined) await log({ ...base, event: "checked", gates });
          await log(line);
        }
        if (event === "refused") counts.refused += 1;
        else counts.notApplied += 1;
        if (answer.suspend !== undefined) await suspend(rule, answer.suspend);
      };
      // Checks 1-4 first: a decision that cannot be applied spends no gate.
      const first = authorizeDelegated(input);
      if (!first.allow && first.step <= 4) {
        await refuse(first);
        continue;
      }
      const verdicts: GateVerdict[] = [];
      for (const gate of served.requiredGates) {
        const implementation = served.gates[gate];
        const missing: GateVerdict = {
          gate,
          outcome: "not-run",
          boundTo: decision.subject.revision,
          evidence: [],
          at: iso(now),
          freshUntil: iso(now),
          reason: "no_evidence",
        };
        if (implementation === undefined) {
          verdicts.push(missing);
          continue;
        }
        try {
          const verdict = await implementation.evaluate(decision.subject, {
            bindTo: decision.subject.revision,
            harnessDir: dir,
            now,
          });
          verdicts.push(
            verdict?.gate === gate
              ? verdict
              : { ...missing, outcome: "unknown", reason: "gate_error" },
          );
        } catch {
          verdicts.push({ ...missing, outcome: "unknown", reason: "gate_error" });
        }
      }
      const gates = verdicts.map(gateLine);
      // A gate may take its time: what holds now is read again.
      const fresh = cached.refresh(dir);
      const current =
        fresh.state === "present" ? fresh.rows.find((r) => r.id === rule.id) : undefined;
      const ruleNow = current ?? rule;
      const answer = authorizeDelegated({
        ...input,
        rule: ruleNow,
        ruleState: effectiveRuleState(ruleNow, deps.now(), ruleUses(lines, rule.id)),
        requiredGates: served.requiredGates,
        verdicts,
        now: deps.now(),
      });
      if (!answer.allow) {
        await refuse(answer, gates);
        continue;
      }
      await log({ ...base, event: "checked", gates });
      let rollback: Awaited<ReturnType<DelegatedAction["planRollback"]>>;
      try {
        rollback = await served.planRollback(decision.subject, ctxOf(dir, now));
      } catch {
        rollback = undefined;
      }
      if (rollback === undefined) {
        await log({ ...base, event: "refused", reason: "rollback_unavailable" });
        counts.refused += 1;
        continue;
      }
      // The plan is on disk before anything acts.
      await log({
        ...base,
        event: "planned",
        plan: rollback as unknown as Readonly<Record<string, unknown>>,
      });
      const resolved = await deps.decisions.resolveDelegated({
        harnessDir: dir,
        ref: decision.id,
        delegation: { rule: rule.id, revision: rule.revision },
        appliedBy,
      });
      if (resolved.outcome !== "decided") continue;
      await log({ ...base, event: "decided" });
      counts.decided += 1;
      await deps.commands.submit({
        kind: served.executeKind,
        actor: "sys:executor",
        target: `${harness.id}/decision/${decision.id}`,
        ledger: { harness: dir },
        via: "system",
        authority: { kind: "delegation", rule: rule.id, revision: rule.revision },
      });
    }

    // Watches: open each action's, read its signals, keep or roll back.
    const readNow = readDelegationLog(dir);
    if (readNow.state === "present") {
      lines.splice(0, lines.length, ...readNow.lines);
    }
    for (const acted of unstarted(lines)) {
      const row = rules.get(acted.rule);
      const served =
        row === undefined ? undefined : deps.actions.find((a) => a.action === row.action);
      if (row === undefined || served === undefined || acted.cmd === undefined) continue;
      let span = 0;
      try {
        span = served.watchMs(row.terms, row.scope);
      } catch {
        span = 0;
      }
      const startedAt = Date.parse(acted.at);
      await log({
        rule: acted.rule,
        revision: acted.revision,
        event: "watch-started",
        cmd: acted.cmd,
        ...(acted.decision !== undefined ? { decision: acted.decision } : {}),
        ...(acted.subject !== undefined ? { subject: acted.subject } : {}),
        watch: {
          startedAt: acted.at,
          until: iso((Number.isFinite(startedAt) ? startedAt : now) + Math.max(0, span)),
          signals: [...served.signalIds],
        },
      });
      counts.watchesStarted += 1;
    }
    for (const open of openWatches(lines)) {
      const row = rules.get(open.line.rule);
      const served =
        row === undefined ? undefined : deps.actions.find((a) => a.action === row.action);
      if (row === undefined || served === undefined || open.watch === undefined) continue;
      let reading: "regression" | "healthy" | "unknown";
      try {
        reading = await served.signals(
          { ...open.watch, action: row.action },
          ctxOf(dir, deps.now()),
        );
      } catch {
        reading = "unknown";
      }
      const base = {
        rule: open.line.rule,
        revision: open.line.revision,
        cmd: open.watch.cmd,
        ...(open.line.decision !== undefined ? { decision: open.line.decision } : {}),
        ...(open.line.subject !== undefined ? { subject: open.line.subject } : {}),
      };
      if (reading === "regression") {
        const submitted = await deps.commands.submit({
          kind: served.rollbackKind,
          actor: "sys:executor",
          target: `${harness.id}/cmd/${open.watch.cmd}`,
          ledger: { harness: dir },
          via: "system",
          authority: {
            kind: "delegation",
            rule: row.id,
            revision: open.line.revision,
            clause: "rollback",
          },
        });
        const done = submitted.ok && submitted.receipt.state === "succeeded";
        // Attempted once: a closed watch is never read again.
        await log({
          ...base,
          event: done ? "rolled-back" : "rollback-failed",
          reason: "regression",
        });
        if (done) counts.rolledBack += 1;
        else counts.rollbackFailed += 1;
        const latest = rules.get(row.id) ?? row;
        await suspend(latest, done ? "rolled-back" : "rollback-failed");
        continue;
      }
      if (deps.now() >= Date.parse(open.watch.until)) {
        await log({
          ...base,
          event: "kept",
          ...(reading === "unknown" ? { reason: "not-measured" } : {}),
        });
        counts.kept += 1;
      }
    }
    return { ran: true, ...counts };
  };

  // -------------------------------------------------------------------------
  // The methods
  // -------------------------------------------------------------------------

  return {
    list(harness) {
      const dir = harness.dir;
      const now = deps.now();
      const unreadable: string[] = [];
      const read = readDelegations(dir);
      if (read.state === "unreadable")
        unreadable.push(`The delegation rules cannot be read: ${read.reason}`);
      if (read.state === "present" && read.anomalies.length > 0) {
        unreadable.push(
          `Part of the delegation rules cannot be read (${read.anomalies.length} row(s))`,
        );
      }
      const logRead = readDelegationLog(dir, { maxLines: LOG_VIEW_LINES });
      const lines = logRead.state === "present" ? logRead.lines : [];
      const ceiling = activeCeiling(dir);
      if (ceiling.state === "unreadable")
        unreadable.push(`The deployment records cannot be read: ${ceiling.reason}`);
      const rows = read.state === "present" ? read.rows : [];
      const items = rows
        .map((rule) => ruleViewOf(rule, lines, now))
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      const offers =
        ceiling.state === "present"
          ? deps.actions.flatMap((served) => {
              if (served.action === "assistant") return [];
              let scope: DelegatedActionScope | undefined;
              try {
                scope = served.scopeOf(ceiling.ceiling.raw);
              } catch {
                scope = undefined;
              }
              return scope === undefined
                ? []
                : [
                    {
                      action: served.action,
                      label: ruleLabelOf(served.action),
                      verb: `crewhaus delegations preview ${served.action} --harness ${harness.id}`,
                    },
                  ];
            })
          : [];
      const proposalsRead = readProposals(dir);
      const proposals =
        proposalsRead.state === "present"
          ? proposalsRead.rows.flatMap((row: ProposalRow) => {
              const terms = row.terms;
              if (terms.ruleKind !== "delegate" || proposalState(row, now) !== "pending") return [];
              const action = terms.action as DelegationAction;
              return [
                {
                  id: row.id,
                  action,
                  days: terms.days,
                  createdAt: row.createdAt,
                  expiresAt: row.expiresAt,
                  verb: `crewhaus delegations enable ${action} --harness ${harness.id} --days ${terms.days} --proposal ${row.id} --confirm ${harness.name ?? "<name>"}`,
                },
              ];
            })
          : [];
      return {
        items,
        ...(logRead.state === "present" && logRead.truncated
          ? {
              truncated: {
                reason: "log_cap",
                verb: `crewhaus delegations list --harness ${harness.id}`,
              },
            }
          : {}),
        ...(items.length === 0
          ? {
              empty:
                ceiling.state === "present"
                  ? {
                      reason: "no-data" as const,
                      remedy:
                        offers.length === 0
                          ? "Merging, rollouts and routine improvements ask a person. No action can be delegated here yet."
                          : "Merging, rollouts and routine improvements ask a person. You can let this harness do some of them on its own, under rules that expire.",
                    }
                  : {
                      reason: "not-allowed" as const,
                      remedy:
                        "An owner allows delegation in this harness's agreement, then activates that build.",
                    },
            }
          : {}),
        ceiling:
          ceiling.state === "present"
            ? { present: true, maxDays: ceiling.ceiling.maxDays }
            : { present: false },
        offers,
        proposals,
        note: APPLY_NOTE,
        unreadable,
      };
    },

    get(harness, id) {
      const dir = harness.dir;
      const found = readRule(dir, id);
      if ("ok" in found) return found;
      const now = deps.now();
      const logRead = readDelegationLog(dir, { maxLines: LOG_VIEW_LINES });
      const lines = logRead.state === "present" ? logRead.lines : [];
      const history = readPage(delegationsLedger(dir), { limit: HISTORY_ROWS });
      const revisions: DelegationRevisionView[] = [];
      for (const item of [...history.items].reverse()) {
        const row = delegationRuleOf(item.record);
        if (row === undefined || row.id !== id) continue;
        revisions.push({
          revision: row.revision,
          state: row.state,
          at: row.at,
          days: row.terms.days,
          ...(row.reason !== undefined ? { reason: row.reason } : {}),
        });
      }
      const enabledAt = revisions[0]?.at;
      const ownerLabel = ownerLabelOf(found.rule.owner);
      const label = ruleLabelOf(found.rule.action);
      const log: DelegationLogView[] = lines
        .filter((line) => line.rule === id)
        .map((line) => ({
          at: line.at,
          event: line.event,
          revision: line.revision,
          ...(line.decision !== undefined ? { decision: line.decision } : {}),
          ...(line.cmd !== undefined ? { cmd: line.cmd } : {}),
          ...(line.reason !== undefined ? { reason: line.reason } : {}),
          ...(line.gates !== undefined
            ? { gates: line.gates.map((g) => ({ gate: g.gate, outcome: g.outcome })) }
            : {}),
          ...(line.event === "decided"
            ? {
                decidedByText: decidedByText({
                  resolvedBy: "delegation",
                  delegation: { rule: id, revision: line.revision },
                  ruleLabel: label,
                  ...(ownerLabel !== undefined ? { ownerLabel } : {}),
                  ...(enabledAt !== undefined ? { enabledAt } : {}),
                }),
              }
            : {}),
        }));
      const truncated =
        (logRead.state === "present" && logRead.truncated) || history.next !== undefined;
      return {
        ok: true,
        detail: {
          rule: ruleViewOf(found.rule, lines, now),
          terms: found.rule.terms,
          revisions,
          log,
          ...(truncated
            ? {
                truncated: {
                  reason: "history_cap",
                  verb: `crewhaus delegations show ${id} --harness ${harness.id}`,
                },
              }
            : {}),
        },
      };
    },

    async preview(harness, request) {
      const parts = await pageFor(
        harness,
        request.action,
        request.terms,
        { kind: "enable" },
        "read",
      );
      return "ok" in parts ? parts : { ok: true, page: parts.page };
    },

    async previewRule(harness, request) {
      const found = readRule(harness.dir, request.rule);
      if ("ok" in found) return found;
      const { rule } = found;
      const parts =
        request.mode === "resume"
          ? await pageFor(
              harness,
              rule.action,
              rule.terms,
              { kind: "resume", rule: rule.id, expect: rule.revision },
              "read",
              Date.parse(rule.expiresAt),
            )
          : await pageFor(
              harness,
              rule.action,
              request.terms ?? rule.terms,
              { kind: "change", rule: rule.id, expect: rule.revision },
              "read",
            );
      return "ok" in parts ? parts : { ok: true, page: parts.page };
    },

    async enable(harness, request) {
      const dir = harness.dir;
      const no = ownerOnly(dir, request.actor);
      if (no !== undefined) return no;
      const parts = await pageFor(
        harness,
        request.action,
        request.terms,
        { kind: "enable" },
        "ensure",
      );
      if ("ok" in parts) return parts;
      if (parts.digest === undefined || request.consequencesDigest !== parts.digest) {
        return refusal(
          "precondition-failed",
          "What turning this rule on means has changed: read the page again.",
          { page: parts.page },
        );
      }
      const confirm = confirmProblem(harness, request.confirm);
      if (confirm !== undefined) return confirm;
      const now = deps.now();
      const owner = await deps.decisions.storedActorOf(dir, request.actor);
      const id = mintId("rule", { now });
      let proposal: ProposalRow | undefined;
      if (request.proposal !== undefined) {
        const read = readProposals(dir);
        proposal =
          read.state === "present" ? read.rows.find((r) => r.id === request.proposal) : undefined;
        const terms = proposal?.terms;
        if (
          proposal === undefined ||
          terms?.ruleKind !== "delegate" ||
          terms.action !== request.action
        ) {
          return refusal("not-found", "No request for this rule waits here.");
        }
        if (proposalState(proposal, now) !== "pending") {
          return refusal("already-decided", "That request has already been answered.");
        }
      }
      const row: DelegationRuleRow = {
        v: 1,
        at: iso(now),
        id,
        state: "enabled",
        kind: "delegate",
        action: request.action,
        revision: 1,
        scope: { harness: harness.id },
        terms: parts.terms,
        termsDigest: parts.termsDigest as string,
        ceilingDigest: parts.ceiling.digest,
        policyRevision: parts.ceiling.policyRevision,
        consequencesDigest: parts.digest,
        ...(parts.hostDigest !== undefined ? { hostDigest: parts.hostDigest } : {}),
        expiresAt: iso(now + parts.terms.days * DAY_MS),
        ...(parts.terms.maxUses !== undefined ? { maxUses: parts.terms.maxUses } : {}),
        owner,
        by: owner,
        ...(proposal !== undefined ? { decision: proposal.id } : {}),
        cmd: request.cmd,
      };
      const written = await writeRules(dir, [{ expect: null, row }], async () => {
        if (proposal === undefined) return undefined;
        // The first decision on the request wins, here as from any other surface.
        const granted = await casAppendLocked(decisionsLedger(dir), proposal.id, "pending", {
          ...proposal,
          state: "granted",
          decision: "grant",
          decidedAt: iso(now),
          decidedByPrincipal: owner,
          rule: id,
        } as unknown as LedgerRecord);
        if (!granted.ok) return refusal("unavailable", granted.reason);
        return granted.applied
          ? undefined
          : refusal("already-decided", "That request has already been answered.");
      });
      if (!written.ok) return written;
      return {
        ok: true,
        rule: row,
        view: ruleViewOf(row, [], now),
        ...(proposal !== undefined ? { proposal: proposal.id } : {}),
      };
    },

    async propose(harness, request) {
      const dir = harness.dir;
      const no = maintainerOnly(dir, request.actor, "h.delegation.propose");
      if (no !== undefined) return no;
      const parts = await pageFor(
        harness,
        request.action,
        request.terms,
        { kind: "enable" },
        "read",
      );
      if ("ok" in parts) return parts;
      const now = deps.now();
      const by = await deps.decisions.storedActorOf(dir, request.actor);
      const id = mintId("dec", { now });
      const row: ProposalRow & { readonly cmd: string } = {
        id,
        kind: "standing-rule-proposal",
        createdAt: iso(now),
        expiresAt: iso(now + PROPOSAL_TTL_MS),
        requiredClass: "owner",
        proposedBy: by,
        terms: {
          ruleKind: "delegate",
          action: request.action,
          terms: parts.terms,
          days: parts.terms.days,
        },
        state: "pending",
        cmd: request.cmd,
      };
      const cas = await casAppend(decisionsLedger(dir), id, null, row as unknown as LedgerRecord);
      if (!cas.ok) return refusal("unavailable", cas.reason);
      if (!cas.applied) return refusal("conflict", "The request's id was taken; ask again.");
      return { ok: true, proposal: id };
    },

    async update(harness, request) {
      const dir = harness.dir;
      const no = ownerOnly(dir, request.actor);
      if (no !== undefined) return no;
      const found = readRule(dir, request.rule);
      if ("ok" in found) return found;
      const { rule, state } = found;
      if (state.state !== "active") {
        return refusal(
          "conflict",
          state.state === "suspended"
            ? "This rule is paused: resume it first."
            : "This rule has ended: turn on a new one.",
        );
      }
      if (request.expect !== rule.revision) {
        return refusal("conflict", `This rule is at revision ${rule.revision} now; read it again.`);
      }
      const parts = await pageFor(
        harness,
        rule.action,
        request.terms ?? rule.terms,
        { kind: "change", rule: rule.id, expect: rule.revision },
        "ensure",
      );
      if ("ok" in parts) return parts;
      if (parts.digest === undefined || request.consequencesDigest !== parts.digest) {
        return refusal(
          "precondition-failed",
          "What this change means has changed: read the page again.",
          {
            page: parts.page,
          },
        );
      }
      const confirm = confirmProblem(harness, request.confirm);
      if (confirm !== undefined) return confirm;
      const now = deps.now();
      const owner = await deps.decisions.storedActorOf(dir, request.actor);
      const { maxUses: _maxUses, hostDigest: _hostDigest, ...base } = carried(rule);
      const row: DelegationRuleRow = {
        ...base,
        at: iso(now),
        state: "revised",
        revision: rule.revision + 1,
        terms: parts.terms,
        termsDigest: parts.termsDigest as string,
        ceilingDigest: parts.ceiling.digest,
        policyRevision: parts.ceiling.policyRevision,
        consequencesDigest: parts.digest,
        ...(parts.hostDigest !== undefined ? { hostDigest: parts.hostDigest } : {}),
        expiresAt: iso(now + parts.terms.days * DAY_MS),
        ...(parts.terms.maxUses !== undefined ? { maxUses: parts.terms.maxUses } : {}),
        owner,
        by: owner,
        cmd: request.cmd,
      };
      const written = await writeRules(dir, [{ expect: rule.state, row }]);
      return written.ok
        ? { ok: true, rule: row, view: ruleViewOf(row, wholeLog(dir), now) }
        : written;
    },

    async pause(harness, request) {
      const dir = harness.dir;
      const no = maintainerOnly(dir, request.actor, "h.delegation.suspend");
      if (no !== undefined) return no;
      const found = readRule(dir, request.rule);
      if ("ok" in found) return found;
      const { rule, state } = found;
      if (state.state !== "active") {
        return refusal(
          "conflict",
          state.state === "suspended" ? "This rule is already paused." : "This rule has ended.",
        );
      }
      const now = deps.now();
      const by = await deps.decisions.storedActorOf(dir, request.actor);
      const row: DelegationRuleRow = {
        ...carried(rule),
        at: iso(now),
        state: "suspended",
        reason: "paused-by-member",
        by,
        cmd: request.cmd,
      };
      const written = await writeRules(dir, [{ expect: rule.state, row }]);
      return written.ok
        ? { ok: true, rule: row, view: ruleViewOf(row, wholeLog(dir), now) }
        : written;
    },

    async resume(harness, request) {
      const dir = harness.dir;
      const no = ownerOnly(dir, request.actor);
      if (no !== undefined) return no;
      const found = readRule(dir, request.rule);
      if ("ok" in found) return found;
      const { rule, state } = found;
      if (state.state !== "suspended") {
        return refusal(
          "conflict",
          state.state === "active"
            ? "This rule is not paused."
            : "This rule has ended: turn on a new one.",
        );
      }
      if (request.expect !== rule.revision) {
        return refusal("conflict", `This rule is at revision ${rule.revision} now; read it again.`);
      }
      const parts = await pageFor(
        harness,
        rule.action,
        rule.terms,
        { kind: "resume", rule: rule.id, expect: rule.revision },
        "ensure",
        Date.parse(rule.expiresAt),
      );
      if ("ok" in parts) return parts;
      if (parts.digest === undefined || request.consequencesDigest !== parts.digest) {
        return refusal(
          "precondition-failed",
          "What resuming this rule means has changed: read the page again.",
          {
            page: parts.page,
          },
        );
      }
      const confirm = confirmProblem(harness, request.confirm);
      if (confirm !== undefined) return confirm;
      const now = deps.now();
      const owner = await deps.decisions.storedActorOf(dir, request.actor);
      const { hostDigest: _hostDigest, ...base } = carried(rule);
      const row: DelegationRuleRow = {
        ...base,
        at: iso(now),
        state: "resumed",
        revision: rule.revision + 1,
        termsDigest: parts.termsDigest as string,
        ceilingDigest: parts.ceiling.digest,
        policyRevision: parts.ceiling.policyRevision,
        consequencesDigest: parts.digest,
        ...(parts.hostDigest !== undefined ? { hostDigest: parts.hostDigest } : {}),
        owner,
        by: owner,
        cmd: request.cmd,
      };
      const written = await writeRules(dir, [{ expect: rule.state, row }]);
      return written.ok
        ? { ok: true, rule: row, view: ruleViewOf(row, wholeLog(dir), now) }
        : written;
    },

    async revoke(harness, request) {
      const dir = harness.dir;
      const no = ownerOnly(dir, request.actor);
      if (no !== undefined) return no;
      const read = readDelegations(dir);
      if (read.state === "unreadable") return refusal("unavailable", read.reason);
      const rows = read.state === "present" ? read.rows : [];
      const now = deps.now();
      const lines = wholeLog(dir);
      const ending = (rule: DelegationRuleRow) => isLive(rule.state) || rule.state === "suspended";
      let targets: DelegationRuleRow[];
      if (request.all === true) {
        targets = rows.filter(ending);
      } else {
        const rule = rows.find((r) => r.id === request.rule);
        if (rule === undefined)
          return refusal("not-found", "This harness has no delegation rule by that id.");
        const state = effectiveRuleState(rule, now, ruleUses(lines, rule.id));
        if (!ending(rule) || state.state === "revoked")
          return refusal("conflict", "This rule has already ended.");
        if (request.expect !== undefined && request.expect !== rule.revision) {
          return refusal(
            "conflict",
            `This rule is at revision ${rule.revision} now; read it again.`,
          );
        }
        targets = [rule];
      }
      const by = await deps.decisions.storedActorOf(dir, request.actor);
      const writes = targets.map((rule) => ({
        expect: rule.state as string,
        row: { ...carried(rule), at: iso(now), state: "revoked" as const, by, cmd: request.cmd },
      }));
      if (writes.length === 0) return { ok: true, rules: [] };
      const written = await writeRules(dir, writes);
      return written.ok
        ? {
            ...written,
            ...(writes.length === 1 && writes[0] !== undefined
              ? { view: ruleViewOf(writes[0].row, lines, now) }
              : {}),
          }
        : written;
    },

    async apply(harness, options) {
      if (!HARNESS_ID_RE.test(harness.id)) return { ran: false, ...ZERO, reason: "no-harness-id" };
      const read = cached(harness.dir);
      if (read.state !== "present" || read.rows.length === 0) return { ran: false, ...ZERO };
      const plan: Plan = {
        rules: [...read.rows],
        lines: wholeLog(harness.dir),
        ceiling: activeCeiling(harness.dir),
      };
      // A receipt is written only when the pass writes a rule row, and names that pass.
      let opened: string | undefined = options.cmd;
      let mine = false;
      const cmdFor = async (): Promise<string | undefined> => {
        if (opened !== undefined) return opened;
        const system = parseActor(options.appliedBy)?.form === "system";
        const submitted = await deps.commands.submit(
          {
            kind: "delegations.apply",
            ...(system ? { actor: options.appliedBy } : {}),
            target: `home/harness/${harness.id}`,
            ledger: { harness: harness.dir },
            via: "system",
          },
          async () => ({ value: undefined }),
        );
        if (!submitted.ok || submitted.replayed) return undefined;
        opened = submitted.receipt.id;
        mine = true;
        return opened;
      };
      let summary: ApplySummary;
      try {
        summary = await runPass(harness, plan, options.appliedBy, cmdFor);
      } catch (err) {
        if (mine && opened !== undefined) {
          await deps.commands.settle?.({ harness: harness.dir }, opened, {
            state: "failed",
            outcome: outcomeOf("internal"),
          });
        }
        throw err;
      }
      if (mine && opened !== undefined) {
        await deps.commands.settle?.({ harness: harness.dir }, opened, { state: "succeeded" });
      }
      return { ...summary, ...(opened !== undefined ? { cmd: opened } : {}) };
    },

    async keepWatch(harness, request) {
      const dir = harness.dir;
      const no = maintainerOnly(dir, request.actor, "h.delegation.suspend");
      if (no !== undefined) return no;
      const lines = wholeLog(dir);
      const open = openWatches(lines).find((w) => w.watch?.cmd === request.watch);
      if (open === undefined) return refusal("not-found", "No watch by that id is open here.");
      await appendDelegationLog(dir, {
        v: 1,
        at: iso(deps.now()),
        event: "kept",
        rule: open.line.rule,
        revision: open.line.revision,
        cmd: request.watch,
        ...(open.line.decision !== undefined ? { decision: open.line.decision } : {}),
        ...(open.line.subject !== undefined ? { subject: open.line.subject } : {}),
        reason: "kept-by-member",
      });
      return { ok: true };
    },
  };

  function ownerLabelOf(owner: string): string | undefined {
    if (!isId("prn", owner)) return undefined;
    try {
      const read = loadAccessSnapshot(deps.hangarRoot);
      if (read.state !== "present") return undefined;
      const row = read.snapshot.principals.find((p) => p.id === owner) as
        | { readonly displayName?: string }
        | undefined;
      return row?.displayName;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Watches, as the application log holds them
// ---------------------------------------------------------------------------

const CLOSING = new Set(["kept", "rolled-back", "rollback-failed", "superseded-by-person"]);

/** `acted` lines whose watch has not started yet. */
function unstarted(lines: readonly DelegationLogLine[]): DelegationLogLine[] {
  const started = new Set(
    lines.filter((l) => l.event === "watch-started" && l.cmd !== undefined).map((l) => l.cmd),
  );
  return lines.filter((l) => l.event === "acted" && l.cmd !== undefined && !started.has(l.cmd));
}

/** Watches that started and have not been kept, rolled back or taken over by a person. */
function openWatches(
  lines: readonly DelegationLogLine[],
): { readonly line: DelegationLogLine; readonly watch: Watch | undefined }[] {
  const closed = new Set(lines.filter((l) => CLOSING.has(l.event)).map((l) => l.cmd));
  const plans = new Map<string, Readonly<Record<string, unknown>>>();
  for (const line of lines) {
    if (line.event === "planned" && line.decision !== undefined && line.plan !== undefined) {
      plans.set(line.decision, line.plan);
    }
  }
  const out: { line: DelegationLogLine; watch: Watch | undefined }[] = [];
  for (const line of lines) {
    if (line.event !== "watch-started" || line.cmd === undefined || closed.has(line.cmd)) continue;
    const w = line.watch as { startedAt?: unknown; until?: unknown; signals?: unknown } | undefined;
    const watch: Watch | undefined =
      typeof w?.until === "string" && line.subject !== undefined
        ? {
            rule: line.rule,
            revision: line.revision,
            action: "merge",
            subject: line.subject,
            cmd: line.cmd,
            startedAt: typeof w.startedAt === "string" ? w.startedAt : line.at,
            until: w.until,
            signals: (Array.isArray(w.signals) ? w.signals : []) as Watch["signals"],
            plan: (plans.get(line.decision ?? "") ?? {}) as unknown as Watch["plan"],
          }
        : undefined;
    out.push({ line, watch });
  }
  return out;
}

/**
 * Whether a refusal says nothing a line already said: the last refusal for this decision
 * under this rule is the same, with the same verdicts. A decision waiting on a gate is
 * not logged again every pass.
 */
function repeats(
  lines: readonly DelegationLogLine[],
  next: Pick<DelegationLogLine, "event" | "rule" | "revision" | "decision" | "reason" | "gates">,
): boolean {
  const signature = (
    line: Pick<DelegationLogLine, "event" | "rule" | "revision" | "reason" | "gates">,
  ) =>
    JSON.stringify([
      line.event,
      line.rule,
      line.revision,
      line.reason ?? "",
      (line.gates ?? []).map((g) => [g.gate, g.outcome, g.boundTo]),
    ]);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as DelegationLogLine;
    if (line.decision !== next.decision) continue;
    if (line.event === "checked") continue;
    return signature(line) === signature(next);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

/**
 * Retire's revoker: every rule that has not ended ends with the harness, `revoked` with
 * reason `retired`, under the retire's receipt. The plan reads and writes nothing.
 */
export const DELEGATIONS_REVOKER: RetireRevoker = {
  name: "delegations",
  async plan(ctx) {
    const read = readDelegations(ctx.harnessDir);
    const live =
      read.state === "present"
        ? read.rows.filter((rule) => isLive(rule.state) || rule.state === "suspended")
        : [];
    return live.length === 0
      ? []
      : [
          {
            kind: "retire.delegations",
            status: "planned",
            note: `${live.length} delegation rule(s) end`,
          },
        ];
  },
  async revoke(ctx) {
    const read = readDelegations(ctx.harnessDir);
    if (read.state === "unreadable") {
      return [{ kind: "retire.delegations", status: "failed", note: "the rules cannot be read" }];
    }
    const live =
      read.state === "present"
        ? read.rows.filter((rule) => isLive(rule.state) || rule.state === "suspended")
        : [];
    if (live.length === 0) return [{ kind: "retire.delegations", status: "skipped", note: "none" }];
    if (ctx.cmd === undefined) {
      return [{ kind: "retire.delegations", status: "failed", note: "no receipt to name" }];
    }
    const cmd = ctx.cmd;
    const ledger = delegationsLedger(ctx.harnessDir);
    let revoked = 0;
    const answer = await withLedgerLock(ledger, async () => {
      for (const rule of live) {
        const next: DelegationRuleRow = {
          ...carried(rule),
          at: iso(ctx.now),
          state: "revoked",
          reason: "retired",
          by: ctx.actor,
          cmd,
        };
        const cas = await casAppendLocked(
          ledger,
          rule.id,
          rule.state,
          next as unknown as LedgerRecord,
        );
        if (cas.ok && cas.applied) revoked += 1;
      }
      return revoked;
    });
    const ok = !lockRefused(answer) && revoked === live.length;
    return [
      {
        kind: "retire.delegations",
        status: ok ? "done" : "failed",
        observed: `${revoked} revoked`,
      },
    ];
  },
};
