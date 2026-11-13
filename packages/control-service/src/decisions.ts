/**
 * The decision service: one way a tool approval, or a request to a harness's owner, is
 * decided, whichever surface asks (Home, the CLI, and later a channel daemon).
 *
 * A decision counts by who made it and what they may decide. The surface says who is
 * asking (`DecisionActor`): Home the principal it signed in, the CLI the local user,
 * whose linked principal Home's access records name. A display name (`--by`, Home's
 * operator label) is written as `decidedBy` and is never authority. On a harness with an
 * approver projection, only a member whose class reaches the request's class decides,
 * and the decision is recorded as that member (session-store's `principalAuthorizer`);
 * with no projection the harness is in single-owner mode.
 *
 * A grant with `always` also makes a standing rule: the narrowest allow that covers the
 * approved call, for 30 days unless `days` says otherwise. The pattern is worked out
 * before anything is decided, so a call no rule can name grants nothing and answers
 * `invalid`. Only the owner makes a rule: a member's `always` grants once and files a
 * request (`dec_`, kind `standing-rule-proposal`) the owner grants or denies here.
 *
 * A `dec_` of kind `change-adoption` asks whether a checked change may be adopted. A
 * member whose class reaches the decision's `requiredClass` grants or denies it (the
 * owner reaches every class; a harness with no approver projection is single-owner),
 * and a service principal never decides one, whatever its class. The first decision
 * wins; nothing is applied on a grant: adopting is the change's own command.
 *
 * The service writes no receipt itself: Home's receipts middleware does for its routes,
 * and the CLI wraps each call in `commands.submit`. A rule's own step can be wrapped in
 * a command of its own through `hooks.ruleCommand`, so its row carries that receipt.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BOOTSTRAP_PRINCIPAL,
  type LocalIdentity,
  loadAccessSnapshot,
  localActorOf,
  localPrincipalOf,
} from "@crewhaus/access-control";
import {
  APPROVAL_ID_RE,
  type DecisionState,
  type ReceiptVia,
  isId,
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
  changeAdoptionState,
  decisionsLedger,
  ensureDigestKey,
  proposalState,
  readApproverProjection,
  readChangeAdoptions,
  readProposals,
  storedLocalActor,
} from "@crewhaus/control-records";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import { loadSettingsRules } from "@crewhaus/permission-engine";
import {
  type ApprovalActor,
  type ApprovalAuthorizer,
  type ApprovalPrincipal,
  type DeferAnswer,
  type PendingApproval,
  type SupersedeAnswer,
  createPendingApprovalStore,
  foldReadOnly,
  needsClassReason,
  principalAuthorizer,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import { isServiceActor } from "./deployments";
import {
  DEFAULT_RULE_DAYS,
  type RuleWriteAnswer,
  createStandingRule,
  ruleDaysProblem,
  ruleEnd,
  standingPatternFor,
  widenedPatternProblem,
} from "./rules";

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * Who asks for a decision, as the surface knows them. `display` is a label shown with
 * the decision and nothing more.
 */
export type DecisionActor =
  | {
      readonly kind: "principal";
      readonly principal: string;
      readonly service?: true;
      readonly display?: string;
    }
  | { readonly kind: "local"; readonly identity: LocalIdentity; readonly display?: string }
  | { readonly kind: "anonymous"; readonly display?: string };

export type DecisionsDeps = {
  /** Home's root, where the access records say whom a local user is linked to. */
  readonly hangarRoot: string;
  /** The head's own local user: who a record names when a surface names nobody. */
  readonly identity: LocalIdentity;
  readonly now: () => number;
  /** The approver projection reader; the default caches for one second. */
  readonly approvers?: (harnessDir: string) => ApproverRead;
};

/**
 * The principal an actor decides as, when there is one. Home's bootstrap credential
 * before any access records names nobody; a local user counts only through an active
 * `local` link in Home's access records, and records that cannot be read name nobody.
 */
export function principalOfActor(actor: DecisionActor, hangarRoot: string): ApprovalPrincipal {
  if (actor.kind === "principal") {
    if (actor.principal === BOOTSTRAP_PRINCIPAL || !isId("prn", actor.principal)) return {};
    const service = actor.service === true || isServiceActor(hangarRoot, actor.principal);
    return { principal: actor.principal, ...(service ? { service: true as const } : {}) };
  }
  if (actor.kind === "anonymous") return {};
  try {
    const snapshot = loadAccessSnapshot(hangarRoot);
    if (snapshot.state !== "present") return {};
    const principal = localPrincipalOf(snapshot.snapshot, localActorOf(actor.identity));
    return principal !== undefined ? { principal } : {};
  } catch {
    return {};
  }
}

/** The actor as the approvals store takes it: a principal, or the local user for a digest. */
function storeActorOf(actor: DecisionActor, who: ApprovalPrincipal): ApprovalActor {
  const display = actor.display !== undefined ? { display: actor.display } : {};
  if (who.principal !== undefined) return { principal: who.principal, ...display };
  if (actor.kind === "local") return { local: localActorOf(actor.identity), ...display };
  return display;
}

// ---------------------------------------------------------------------------
// The class a settings write needs
// ---------------------------------------------------------------------------

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function field(root: unknown, ...path: string[]): unknown {
  let at: unknown = root;
  for (const name of path) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[name];
  }
  return at;
}

/**
 * The class a change to `.crewhaus/settings.json` needs: the owner's when it changes
 * what the agent may do or what runs around it (`permissions`, `hooks`,
 * `manager.hooks`), a maintainer's for anything else.
 */
export function settingsWriteClass(before: unknown, after: unknown): "owner" | "maintainer" {
  for (const path of [["permissions"], ["hooks"], ["manager", "hooks"]]) {
    if (canonical(field(before, ...path)) !== canonical(field(after, ...path))) return "owner";
  }
  return "maintainer";
}

// ---------------------------------------------------------------------------
// Finding the harness a session root belongs to
// ---------------------------------------------------------------------------

/** `path` with every link on its existing part followed; the rest is joined back as written. */
function realOf(path: string): string {
  const rest: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      // Rebuilt one name at a time: the list is never spread into join.
      return rest.reduceRight((built, name) => join(built, name), realpathSync(head));
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      rest.push(basename(head));
      head = parent;
    }
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type HarnessFound =
  | { readonly state: "one"; readonly dir: string }
  | { readonly state: "several"; readonly dirs: readonly string[] }
  | { readonly state: "none" };

/**
 * Which harness a session root belongs to, for a head that found the root through the
 * environment (a tenant scope, `CREWHAUS_SESSION_DIR`) rather than from a harness.
 * Candidates: the live registry rows, the working directory, and each ancestor of the
 * root that holds `.crewhaus/`. One matches when the session root its own environment
 * files give it is the root, or when the root lies inside its tenants root
 * (`<candidate>/.crewhaus/tenants`). A session root outside every harness matches none.
 */
export function harnessForSessionRoot(
  rootDir: string,
  options: { readonly registry?: () => readonly string[]; readonly cwd?: string } = {},
): HarnessFound {
  const target = realOf(rootDir);
  const candidates: string[] = [...(options.registry?.() ?? [])];
  if (options.cwd !== undefined) candidates.push(options.cwd);
  for (let dir = dirname(resolve(rootDir)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".crewhaus"))) candidates.push(dir);
    if (dirname(dir) === dir) break;
  }
  const matches = new Map<string, string>();
  for (const candidate of candidates) {
    const real = realOf(candidate);
    if (matches.has(real) || !existsSync(candidate)) continue;
    let own: string;
    try {
      own = resolveHarnessSessionRoot(candidate, readHarnessEnvFiles(candidate).vars).root;
    } catch {
      continue;
    }
    const tenants = realOf(join(candidate, ".crewhaus", "tenants"));
    if (realOf(own) === target || inside(tenants, target)) matches.set(real, candidate);
  }
  const dirs = [...matches.values()];
  if (dirs.length === 1) return { state: "one", dir: dirs[0] as string };
  return dirs.length === 0 ? { state: "none" } : { state: "several", dirs };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type ResolveRequest = {
  /** The harness the decision is about; absent: none could be told, so single-owner mode. */
  readonly harnessDir?: string;
  /** The session root the approvals live in; absent, the harness's own, as Home reads it. */
  readonly rootDir?: string;
  /** `appr_…` (a tool approval) or `dec_…` (a request to the owner). */
  readonly ref: string;
  readonly choice: "grant" | "deny";
  readonly actor: DecisionActor;
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

export type SupersedeRequest = {
  readonly harnessDir?: string;
  readonly rootDir?: string;
  readonly ref: string;
  /** One of the reasons a person may give. */
  readonly reason: string;
  readonly actor: DecisionActor;
  readonly via: ReceiptVia;
};

export type DeferRequest = {
  readonly harnessDir?: string;
  readonly rootDir?: string;
  readonly ref: string;
  readonly until: string;
  readonly reason: string;
  readonly actor: DecisionActor;
  readonly via: ReceiptVia;
};

export type Decisions = {
  resolve(request: ResolveRequest, hooks?: ResolveHooks): Promise<ResolveAnswer>;
  supersede(request: SupersedeRequest): Promise<SupersedeAnswer>;
  defer(request: DeferRequest): Promise<DeferAnswer>;
  /** Whether this actor may make and end standing rules on the harness. */
  mayManageRules(harnessDir: string | undefined, actor: DecisionActor): boolean;
  /** The principal an actor decides as, when there is one. */
  principalOf(actor: DecisionActor): ApprovalPrincipal;
  /** The stored actor a record in the harness names for this actor. */
  storedActorOf(harnessDir: string, actor: DecisionActor): Promise<string>;
};

/** Why a call cannot become a standing rule, in words. */
const NARROW_WORDS: Readonly<Record<string, string>> = {
  undeclared: "the tool does not say which argument decides where it acts",
  "no-scoping-argument": "no argument of the tool decides where it acts",
  "not-parsed": "the call's input does not parse",
  "no-value": "the call names no place to allow",
  "several-places": "the call acts on more than one place",
  "not-representable": "the call's value cannot be written as a rule",
  "every-value": "the call acts on every value at once",
  "carries-credential": "the call's value carries a credential, which a rule must not hold",
};

export function createDecisions(deps: DecisionsDeps): Decisions {
  const approvers = deps.approvers ?? readApproverProjection;
  const nowDate = (): Date => new Date(deps.now());

  const rootOf = (harnessDir: string | undefined, rootDir: string | undefined): string => {
    if (rootDir !== undefined) return rootDir;
    if (harnessDir === undefined)
      throw new Error("control-service: a decision needs a session root");
    return resolveHarnessSessionRoot(harnessDir, readHarnessEnvFiles(harnessDir).vars).root;
  };

  const storeFor = (root: string, ttlDays?: number) =>
    createPendingApprovalStore({
      rootDir: root,
      ...(ttlDays !== undefined ? { ttlDays } : {}),
      now: nowDate,
    });

  const authorizerFor = (
    harnessDir: string | undefined,
    who: ApprovalPrincipal,
  ): ApprovalAuthorizer =>
    harnessDir !== undefined
      ? principalAuthorizer(harnessDir, who, { reader: approvers, now: deps.now })
      : () => (who.principal !== undefined ? { ok: true, principal: who.principal } : { ok: true });

  const mayManage = (harnessDir: string | undefined, who: ApprovalPrincipal): boolean => {
    if (harnessDir === undefined || who.service === true) return false;
    const read = approvers(harnessDir);
    if (read.state === "absent") return true;
    if (read.state !== "present" || who.principal === undefined) return false;
    return memberMayDecide(read.projection, who.principal, "owner", deps.now());
  };

  /** The stored actor a rule or a request names: the principal, else a keyed digest. */
  const storedActor = async (
    harnessDir: string,
    actor: DecisionActor,
    who: ApprovalPrincipal,
  ): Promise<string> => {
    if (who.principal !== undefined) return who.principal;
    const key = await ensureDigestKey(harnessDir);
    if (key.state !== "present") {
      throw new Error(`control-service: the harness's digest key cannot be read: ${key.reason}`);
    }
    return storedLocalActor(
      key.hmac,
      localActorOf(actor.kind === "local" ? actor.identity : deps.identity),
    );
  };

  const runRule = (
    hooks: ResolveHooks | undefined,
    run: (cmd: string | undefined) => Promise<RuleWriteAnswer>,
  ): Promise<RuleWriteAnswer> =>
    hooks?.ruleCommand !== undefined ? hooks.ruleCommand(run) : run(undefined);

  /**
   * Whether this actor may decide a change-adoption decision of `requiredClass`: never a
   * service principal; every local user on a harness with no approver projection; else
   * a member whose class reaches it, now.
   */
  const mayDecideAdoption = (
    harnessDir: string,
    who: ApprovalPrincipal,
    requiredClass: ChangeAdoptionRow["requiredClass"],
  ): boolean => {
    if (who.service === true) return false;
    const read = approvers(harnessDir);
    if (read.state === "absent") return true;
    if (read.state !== "present" || who.principal === undefined) return false;
    return memberMayDecide(read.projection, who.principal, requiredClass, deps.now());
  };

  async function resolveAdoption(
    request: ResolveRequest,
    harnessDir: string,
    who: ApprovalPrincipal,
    row: ChangeAdoptionRow,
  ): Promise<ResolveAnswer> {
    const read = approvers(harnessDir);
    if (read.state === "unreadable") {
      return {
        outcome: "forbidden",
        record: null,
        reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
      };
    }
    if (who.service === true) {
      return {
        outcome: "forbidden",
        record: null,
        adoption: row,
        reason: "a service credential never decides whether a change is adopted; a person does",
      };
    }
    if (!mayDecideAdoption(harnessDir, who, row.requiredClass)) {
      return {
        outcome: "forbidden",
        record: null,
        adoption: row,
        reason: needsClassReason(row.requiredClass),
      };
    }
    const nowMs = deps.now();
    const state = changeAdoptionState(row, nowMs);
    if (state === "expired") return { outcome: "expired", record: null, adoption: row };
    if (state !== "pending") return { outcome: "already-decided", record: null, adoption: row };
    if (request.expect !== undefined && request.expect !== "pending") {
      return { outcome: "stale", record: null, adoption: row, reason: "the decision is pending" };
    }
    const by = await storedActor(harnessDir, request.actor, who);
    const decided: ChangeAdoptionRow = {
      ...row,
      state: request.choice === "grant" ? "granted" : "denied",
      decision: request.choice,
      decidedAt: new Date(nowMs).toISOString(),
      decidedByPrincipal: by,
    };
    // The first decision wins: its generation claim decides. A grant applies nothing.
    const cas = await casAppend(decisionsLedger(harnessDir), row.id, "pending", decided);
    if (!cas.ok) throw new Error(`control-service: the decision cannot be made: ${cas.reason}`);
    if (!cas.applied) {
      const current = readChangeAdoptions(harnessDir);
      const winner =
        current.state === "present" ? current.rows.find((r) => r.id === row.id) : undefined;
      return { outcome: "already-decided", record: null, adoption: winner ?? row };
    }
    return { outcome: "decided", record: null, adoption: decided };
  }

  async function resolveProposal(
    request: ResolveRequest,
    who: ApprovalPrincipal,
    hooks: ResolveHooks | undefined,
  ): Promise<ResolveAnswer> {
    const { harnessDir } = request;
    if (harnessDir === undefined) return { outcome: "not-found", record: null };
    // A change-adoption decision has its own path; every other `dec_` is a request to
    // the owner.
    const adoptions = readChangeAdoptions(harnessDir);
    const adoption =
      adoptions.state === "present" ? adoptions.rows.find((r) => r.id === request.ref) : undefined;
    if (adoption !== undefined) return resolveAdoption(request, harnessDir, who, adoption);
    const read = approvers(harnessDir);
    if (read.state === "unreadable") {
      return {
        outcome: "forbidden",
        record: null,
        reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
      };
    }
    if (!mayManage(harnessDir, who)) {
      return { outcome: "forbidden", record: null, reason: needsClassReason("owner") };
    }
    const proposals = readProposals(harnessDir);
    if (proposals.state === "unreadable") {
      throw new Error(`control-service: the owner's requests cannot be read: ${proposals.reason}`);
    }
    const row =
      proposals.state === "present" ? proposals.rows.find((r) => r.id === request.ref) : undefined;
    if (row === undefined) return { outcome: "not-found", record: null };
    const nowMs = deps.now();
    const state = proposalState(row, nowMs);
    if (state === "expired") return { outcome: "expired", record: null, proposal: row };
    if (state !== "pending") return { outcome: "already-decided", record: null, proposal: row };
    if (request.expect !== undefined && request.expect !== "pending") {
      return { outcome: "stale", record: null, proposal: row, reason: "the request is pending" };
    }
    if (request.choice === "grant") {
      if (!(Date.parse(row.terms.expiresAt) > nowMs)) {
        return {
          outcome: "invalid",
          record: null,
          proposal: row,
          reason: "the rule this request asks for would already have ended; ask for it again",
        };
      }
      try {
        loadSettingsRules(harnessDir);
      } catch (err) {
        return { outcome: "invalid", record: null, reason: (err as Error).message };
      }
    }
    const by = await storedActor(harnessDir, request.actor, who);
    const ruleId = request.choice === "grant" ? mintId("rule", { now: nowMs }) : undefined;
    const decided: ProposalRow = {
      ...row,
      state: request.choice === "grant" ? "granted" : "denied",
      decision: request.choice,
      decidedAt: new Date(nowMs).toISOString(),
      decidedByPrincipal: by,
      ...(ruleId !== undefined ? { rule: ruleId } : {}),
    };
    // The first decision wins: its generation claim decides.
    const cas = await casAppend(decisionsLedger(harnessDir), row.id, "pending", decided);
    if (!cas.ok) throw new Error(`control-service: the request cannot be decided: ${cas.reason}`);
    if (!cas.applied) {
      const current = readProposals(harnessDir);
      const winner =
        current.state === "present" ? current.rows.find((r) => r.id === row.id) : undefined;
      return { outcome: "already-decided", record: null, proposal: winner ?? row };
    }
    if (request.choice === "deny") return { outcome: "decided", record: null, proposal: decided };
    const made = await runRule(hooks, (cmd) =>
      createStandingRule({
        harnessDir,
        ...(ruleId !== undefined ? { id: ruleId } : {}),
        tool: row.terms.tool,
        pattern: row.terms.pattern,
        reason: "proposal",
        derivedFrom: row.derivedFrom,
        proposal: row.id,
        createdBy: by,
        expiresAt: row.terms.expiresAt,
        ...(cmd !== undefined ? { cmd } : {}),
        now: nowMs,
      }),
    );
    return made.ok
      ? { outcome: "decided", record: null, proposal: decided, rule: made.rule }
      : { outcome: "decided", record: null, proposal: decided, ruleError: made.reason };
  }

  async function resolve(request: ResolveRequest, hooks?: ResolveHooks): Promise<ResolveAnswer> {
    const who = principalOfActor(request.actor, deps.hangarRoot);
    if (isId("dec", request.ref)) return resolveProposal(request, who, hooks);
    if (!APPROVAL_ID_RE.test(request.ref)) {
      return { outcome: "invalid", record: null, reason: `"${request.ref}" is not an approval id` };
    }
    const { harnessDir } = request;
    const root = rootOf(harnessDir, request.rootDir);
    const always = request.always === true;
    let owner = false;
    let rule:
      | { readonly tool: string; readonly pattern: string; readonly days: number }
      | undefined;
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
      if (daysProblem !== undefined)
        return { outcome: "invalid", record: null, reason: daysProblem };
      const folded = foldReadOnly(root);
      if (folded.state === "unreadable") {
        throw new Error(
          `control-service: the approvals under ${root} cannot be read: ${folded.reason}`,
        );
      }
      const record = folded.records.find((r) => r.id === request.ref);
      if (record === undefined) return { outcome: "not-found", record: null };
      owner = mayManage(harnessDir, who);
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

    const store = storeFor(root, request.ttlDays);
    const answer = await store.decide(
      request.ref,
      {
        choice: request.choice,
        actor: storeActorOf(request.actor, who),
        via: request.via,
        ...(request.expect !== undefined ? { expect: request.expect } : {}),
        ...(always && owner ? { always: true } : {}),
      },
      { authorize: authorizerFor(harnessDir, who) },
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
    const by = await storedActor(harnessDir, request.actor, who);
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

  return {
    resolve,
    async supersede(request) {
      const who = principalOfActor(request.actor, deps.hangarRoot);
      const store = storeFor(rootOf(request.harnessDir, request.rootDir));
      return store.supersede(
        request.ref,
        { actor: storeActorOf(request.actor, who), via: request.via, reason: request.reason },
        { authorize: authorizerFor(request.harnessDir, who) },
      );
    },
    async defer(request) {
      const who = principalOfActor(request.actor, deps.hangarRoot);
      const store = storeFor(rootOf(request.harnessDir, request.rootDir));
      return store.defer(
        request.ref,
        {
          until: request.until,
          reason: request.reason,
          actor: storeActorOf(request.actor, who),
          via: request.via,
        },
        { authorize: authorizerFor(request.harnessDir, who) },
      );
    },
    mayManageRules: (harnessDir, actor) =>
      mayManage(harnessDir, principalOfActor(actor, deps.hangarRoot)),
    principalOf: (actor) => principalOfActor(actor, deps.hangarRoot),
    storedActorOf: (harnessDir, actor) =>
      storedActor(harnessDir, actor, principalOfActor(actor, deps.hangarRoot)),
  };
}
