/**
 * One way a tool approval (`appr_…`) is decided, for every surface: the decision service
 * (`createDecisions`, which Home and the CLI call) and a channel daemon's buttons both
 * call {@link resolveToolApproval}, so a rule or a request to the owner is made in exactly
 * one place.
 *
 * The caller says who is asking (`who`, the principal the authorizer judges), what the
 * store records for them (`storeActor`) and the stored actor a rule or a request names
 * (`storedBy`, asked only once a decision is made). On a harness with an approver
 * projection, only a member whose class reaches the request's decides, as that member
 * (session-store's `principalAuthorizer`).
 *
 * A grant with `always` also makes a standing rule: the narrowest allow that covers the
 * approved call, for 30 days unless `days` says otherwise. The pattern is worked out
 * before anything is decided, so a call no rule can name grants nothing and answers
 * `invalid`. Only the owner makes a rule: a member's `always` grants once and files a
 * request (`dec_`, kind `standing-rule-proposal`) the owner grants or denies.
 *
 * Its static imports reach no Home package (access-control, harness-supervisor,
 * harness-registry, deployment-controller, preflight), so a compiled channel daemon loads
 * it: `@crewhaus/control-service/approval-resolve`.
 */
import {
  APPROVAL_ID_RE,
  type DecisionState,
  type ReceiptVia,
  memberMayDecide,
  mintId,
} from "@crewhaus/control-contract";
import {
  type ApproverRead,
  type ChangeAdoptionRow,
  PROPOSAL_TTL_MS,
  type ProposalRow,
  type StandingRuleRow,
  casAppend,
  decisionsLedger,
  readApproverProjection,
} from "@crewhaus/control-records";
import { loadSettingsRules } from "@crewhaus/permission-engine";
import {
  type ApprovalActor,
  type ApprovalAuthorizer,
  type ApprovalPrincipal,
  type PendingApproval,
  createPendingApprovalStore,
  foldReadOnly,
  needsClassReason,
  principalAuthorizer,
} from "@crewhaus/session-store";
import {
  DEFAULT_RULE_DAYS,
  type RuleWriteAnswer,
  createStandingRule,
  ruleDaysProblem,
  ruleEnd,
  standingPatternFor,
  widenedPatternProblem,
} from "./rules";

export type ResolveHooks = {
  /**
   * Run the standing rule's step as a command of its own: `run` is called with the
   * receipt's id, which the rule's row keeps.
   */
  readonly ruleCommand?: (
    run: (cmd: string | undefined) => Promise<RuleWriteAnswer>,
  ) => Promise<RuleWriteAnswer>;
};

export type ResolveAnswer = {
  readonly outcome:
    | "decided"
    | "already-decided"
    | "stale"
    | "expired"
    | "forbidden"
    | "not-found"
    | "invalid";
  /** The tool approval as it now stands; `null` for a request to the owner, or none. */
  readonly record: PendingApproval | null;
  readonly winner?: PendingApproval;
  readonly reason?: string;
  /** The standing rule this decision made. */
  readonly rule?: StandingRuleRow;
  /** The grant stands; its standing rule could not be made, for this reason. */
  readonly ruleError?: string;
  /** The request to the owner this decision filed or decided. */
  readonly proposal?: ProposalRow;
  /** The change-adoption decision this decided. */
  readonly adoption?: ChangeAdoptionRow;
};

export type ToolApprovalRequest = {
  /** The harness the decision is about; absent: none could be told, so single-owner mode. */
  readonly harnessDir?: string;
  /** The session root the approvals live in. */
  readonly rootDir: string;
  /** The `appr_…` id. */
  readonly ref: string;
  readonly choice: "grant" | "deny";
  /** Whom the authorizer and the owner check judge. */
  readonly who: ApprovalPrincipal;
  /** What the store records as the decider. */
  readonly storeActor: ApprovalActor;
  /** The stored actor a rule or a request to the owner names; asked once a decision is made. */
  readonly storedBy: () => Promise<string>;
  readonly via: ReceiptVia;
  /** A grant that also makes a standing rule. */
  readonly always?: boolean;
  /** How long the standing rule lasts, 1-365; default 30. */
  readonly days?: number;
  /** A wider glob for the rule than the call's own value: the owner's, with `confirm`. */
  readonly pattern?: string;
  /** The tool's name, typed to confirm a wider `pattern`. */
  readonly confirm?: string;
  /** Decide only when the request is in this state now. */
  readonly expect?: DecisionState;
  /** The approvals store's TTL, in days. */
  readonly ttlDays?: number;
};

export type ToolApprovalDeps = {
  readonly now: () => number;
  /** The approver projection reader; the default caches for one second. */
  readonly approvers?: (harnessDir: string) => ApproverRead;
};

type Judged = {
  readonly approvers: (harnessDir: string) => ApproverRead;
  readonly now: () => number;
};

/** Why a call cannot become a standing rule, in words. */
export const NARROW_WORDS: Readonly<Record<string, string>> = {
  undeclared: "the tool does not say which argument decides where it acts",
  "no-scoping-argument": "no argument of the tool decides where it acts",
  "not-parsed": "the call's input does not parse",
  "no-value": "the call names no place to allow",
  "several-places": "the call acts on more than one place",
  "not-representable": "the call's value cannot be written as a rule",
  "every-value": "the call acts on every value at once",
  "carries-credential": "the call's value carries a credential, which a rule must not hold",
};

/**
 * The authorizer a decision on a harness uses: the projection's, or, with no harness,
 * single-owner mode recording the principal when there is one.
 */
export function authorizerFor(
  harnessDir: string | undefined,
  who: ApprovalPrincipal,
  deps: Judged,
): ApprovalAuthorizer {
  return harnessDir !== undefined
    ? principalAuthorizer(harnessDir, who, { reader: deps.approvers, now: deps.now })
    : () => (who.principal !== undefined ? { ok: true, principal: who.principal } : { ok: true });
}

/**
 * Whether `who` may make and end standing rules on the harness: anyone in single-owner
 * mode, the owner on a governed harness, never a service, and nobody when the projection
 * cannot be read.
 */
export function mayManage(
  harnessDir: string | undefined,
  who: ApprovalPrincipal,
  deps: Judged,
): boolean {
  if (harnessDir === undefined || who.service === true) return false;
  const read = deps.approvers(harnessDir);
  if (read.state === "absent") return true;
  if (read.state !== "present" || who.principal === undefined) return false;
  return memberMayDecide(read.projection, who.principal, "owner", deps.now());
}

const runRule = (
  hooks: ResolveHooks | undefined,
  run: (cmd: string | undefined) => Promise<RuleWriteAnswer>,
): Promise<RuleWriteAnswer> =>
  hooks?.ruleCommand !== undefined ? hooks.ruleCommand(run) : run(undefined);

/**
 * Decide tool approval `request.ref` in the store at `request.rootDir`: the pattern a
 * standing rule would take is worked out first, the decision is made through the store's
 * `decide` with the projection's authorizer, and then the owner's rule is made or a
 * member's request to the owner is filed.
 */
export async function resolveToolApproval(
  request: ToolApprovalRequest,
  deps: ToolApprovalDeps,
  hooks?: ResolveHooks,
): Promise<ResolveAnswer> {
  if (!APPROVAL_ID_RE.test(request.ref)) {
    return { outcome: "invalid", record: null, reason: `"${request.ref}" is not an approval id` };
  }
  const judged: Judged = { approvers: deps.approvers ?? readApproverProjection, now: deps.now };
  const { harnessDir, who } = request;
  const root = request.rootDir;
  const always = request.always === true;
  let owner = false;
  let rule: { readonly tool: string; readonly pattern: string; readonly days: number } | undefined;
  if (always) {
    if (request.choice !== "grant") {
      return { outcome: "invalid", record: null, reason: "always applies only to a grant" };
    }
    if (harnessDir === undefined) {
      return {
        outcome: "invalid",
        record: null,
        reason: "a standing rule is kept in a harness, and none was found: pass --dir <harness>",
      };
    }
    const days = request.days ?? DEFAULT_RULE_DAYS;
    const daysProblem = ruleDaysProblem(days);
    if (daysProblem !== undefined) return { outcome: "invalid", record: null, reason: daysProblem };
    const folded = foldReadOnly(root);
    if (folded.state === "unreadable") {
      throw new Error(
        `control-service: the approvals under ${root} cannot be read: ${folded.reason}`,
      );
    }
    const record = folded.records.find((r) => r.id === request.ref);
    if (record === undefined) return { outcome: "not-found", record: null };
    owner = mayManage(harnessDir, who, judged);
    if (request.pattern !== undefined) {
      if (!owner) return { outcome: "forbidden", record, reason: needsClassReason("owner") };
      if (request.confirm !== record.toolName) {
        return {
          outcome: "invalid",
          record,
          reason: `a wider rule is confirmed by typing the tool's name, ${record.toolName}`,
        };
      }
      const problem = widenedPatternProblem(
        record.toolName,
        record.input,
        request.pattern,
        harnessDir,
      );
      if (problem !== undefined) return { outcome: "invalid", record, reason: problem };
      rule = { tool: record.toolName, pattern: request.pattern, days };
    } else {
      const narrow = standingPatternFor(record.toolName, record.input, harnessDir);
      if ("refused" in narrow) {
        return {
          outcome: "invalid",
          record,
          reason: `no standing rule can name this call: ${NARROW_WORDS[narrow.refused] ?? narrow.refused} (${narrow.refused})`,
        };
      }
      rule = { tool: record.toolName, pattern: narrow.pattern, days };
    }
    if (owner) {
      try {
        loadSettingsRules(harnessDir);
      } catch (err) {
        return { outcome: "invalid", record, reason: (err as Error).message };
      }
    }
  }

  const store = createPendingApprovalStore({
    rootDir: root,
    ...(request.ttlDays !== undefined ? { ttlDays: request.ttlDays } : {}),
    now: () => new Date(deps.now()),
  });
  const answer = await store.decide(
    request.ref,
    {
      choice: request.choice,
      actor: request.storeActor,
      via: request.via,
      ...(request.expect !== undefined ? { expect: request.expect } : {}),
      ...(always && owner ? { always: true } : {}),
    },
    { authorize: authorizerFor(harnessDir, who, judged) },
  );
  const base: ResolveAnswer = {
    outcome: answer.outcome,
    record: answer.record,
    ...(answer.winner !== undefined ? { winner: answer.winner } : {}),
    ...(answer.reason !== undefined ? { reason: answer.reason } : {}),
  };
  const made = rule;
  if (answer.outcome !== "decided" || made === undefined || harnessDir === undefined) return base;
  const nowMs = deps.now();
  const by = await request.storedBy();
  const expiresAt = ruleEnd(nowMs, made.days);
  if (owner) {
    const written = await runRule(hooks, (cmd) =>
      createStandingRule({
        harnessDir,
        tool: made.tool,
        pattern: made.pattern,
        reason: "approval",
        derivedFrom: request.ref,
        createdBy: by,
        expiresAt,
        ...(cmd !== undefined ? { cmd } : {}),
        now: nowMs,
      }),
    );
    return written.ok ? { ...base, rule: written.rule } : { ...base, ruleError: written.reason };
  }
  const id = mintId("dec", { now: nowMs });
  const proposal: ProposalRow = {
    id,
    kind: "standing-rule-proposal",
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
    requiredClass: "owner",
    derivedFrom: request.ref,
    proposedBy: by,
    terms: { ruleKind: "allow", tool: made.tool, pattern: made.pattern, expiresAt },
    state: "pending",
  };
  const filed = await casAppend(decisionsLedger(harnessDir), id, null, proposal);
  if (!filed.ok || !filed.applied) {
    return {
      ...base,
      ruleError: `the request to the owner could not be filed${filed.ok ? "" : `: ${filed.reason}`}`,
    };
  }
  return { ...base, proposal };
}
