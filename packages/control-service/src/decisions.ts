/**
 * The decision service: one way a tool approval, or a request to a harness's owner, is
 * decided, whichever surface asks (Home and the CLI here; a channel daemon's buttons call
 * the same tool-approval step, `./approval-resolve`, directly).
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
 * A `dec_` of kind `merge` or `rollout` asks whether a `ship`-class action may run. A
 * person decides it the way a change adoption is decided; an owner's delegation rule may
 * resolve it instead (`resolveDelegated`), through the same first-decision-wins claim,
 * recorded as the rule's (`resolvedBy: "delegation"`), never as a person's. No surface's
 * request can name `resolvedBy`.
 *
 * A request to the owner for a delegation rule (`terms.ruleKind: "delegate"`) is never
 * granted here: an owner turns the rule on from its consequences page.
 *
 * A local user or a principal decides on a harness with an approver projection only
 * through the Home that wrote it: who they are comes from the access records under
 * `deps.hangarRoot` when that is the root the projection names (`accessRoot`), and from
 * nowhere otherwise.
 *
 * Superseding an approval answers the standing rules made from it that still stand. When
 * the owner supersedes it as decided in error, those rules end with it.
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
  type ActionDecisionRow,
  type ApproverRead,
  type ChangeAdoptionRow,
  type ProposalRow,
  actionDecisionState,
  casAppend,
  changeAdoptionState,
  decisionsLedger,
  ensureDigestKey,
  proposalState,
  readActionDecisions,
  readApproverProjection,
  readChangeAdoptions,
  readProposals,
  readStandingRules,
  ruleIsLive,
  storedLocalActor,
} from "@crewhaus/control-records";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import { loadSettingsRules } from "@crewhaus/permission-engine";
import {
  type ApprovalActor,
  type ApprovalPrincipal,
  type DeferAnswer,
  type SupersedeAnswer,
  createPendingApprovalStore,
  foldReadOnly,
  needsClassReason,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import {
  type ResolveAnswer,
  type ResolveHooks,
  authorizerFor as authorizerOf,
  mayManage as mayManageOn,
  resolveToolApproval,
} from "./approval-resolve";
import { isServiceActor } from "./deployments";
import {
  type RuleWriteAnswer,
  createStandingRule,
  revokeStandingRule,
  ruleEndProblem,
  standingPatternFor,
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

/** What a local user is told on a harness whose approver projection names no Home root. */
const UNNAMED_ACCESS_ROOT =
  "this harness's list of who may approve does not say which Home wrote it; rewrite it with `crewhaus access sync`";

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
 * The settings paths that decide what the agent may do, what runs around it, and which
 * environment files (with the harness's credentials in them) it starts with:
 * `permissions`, `hooks`, `manager.hooks` and `manager.envFiles`. Every surface that
 * treats a settings change as a security change reads this one list.
 */
export const SECURITY_SETTINGS_PATHS: ReadonlyArray<readonly string[]> = Object.freeze(
  [["permissions"], ["hooks"], ["manager", "hooks"], ["manager", "envFiles"]].map((path) =>
    Object.freeze(path),
  ),
);

/**
 * The class a change to `.crewhaus/settings.json` needs: the owner's when it changes a
 * path of {@link SECURITY_SETTINGS_PATHS} (what the agent may do, what runs around it,
 * or `manager.envFiles`, the files that hold the harness's credentials), a maintainer's
 * for anything else.
 */
export function settingsWriteClass(before: unknown, after: unknown): "owner" | "maintainer" {
  for (const path of SECURITY_SETTINGS_PATHS) {
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
 * Every ancestor of a session root that holds `.crewhaus/`, nearest first: those of the
 * root as written (`resolve`) and those of where it lands on disk (links followed), each
 * directory once by its real path.
 */
function crewhausAncestors(rootDir: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const start of [resolve(rootDir), realOf(rootDir)]) {
    for (let dir = dirname(start); ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".crewhaus"))) {
        const real = realOf(dir);
        if (!seen.has(real)) {
          seen.add(real);
          found.push(dir);
        }
      }
      if (dirname(dir) === dir) break;
    }
  }
  return found;
}

/**
 * The nearest governed harness above a session root: an ancestor (as written, or where
 * the root lands on disk) whose approver list is present or cannot be read. A session
 * root inside it is decided only by the harness it belongs to, named with `--dir`.
 */
export function governedAncestorOf(
  rootDir: string,
  approvers: (harnessDir: string) => ApproverRead = readApproverProjection,
): string | undefined {
  return crewhausAncestors(rootDir).find((dir) => approvers(dir).state !== "absent");
}

/**
 * Which harness a session root belongs to, for a head that found the root through the
 * environment (a tenant scope, `CREWHAUS_SESSION_DIR`) rather than from a harness.
 * Candidates: the live registry rows, the working directory, and each ancestor that
 * holds `.crewhaus/` of the root as written and of where it lands on disk, so a root
 * reached through a link is matched to the harness it lies in. One matches when the
 * session root its own environment files give it is the root, or when the root lies
 * inside its tenants root (`<candidate>/.crewhaus/tenants`). A session root outside
 * every harness matches none.
 */
export function harnessForSessionRoot(
  rootDir: string,
  options: { readonly registry?: () => readonly string[]; readonly cwd?: string } = {},
): HarnessFound {
  const target = realOf(rootDir);
  const candidates: string[] = [...(options.registry?.() ?? [])];
  if (options.cwd !== undefined) candidates.push(options.cwd);
  candidates.push(...crewhausAncestors(rootDir));
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

export type { ResolveAnswer, ResolveHooks } from "./approval-resolve";

/** A standing rule made from a superseded approval. */
export type DerivedRule = {
  readonly id: string;
  /** The supersede ended it. */
  readonly revoked: boolean;
  /** The verb that ends it, while it stands. */
  readonly verb?: string;
};

/**
 * A supersede's answer, and on a harness, once superseded, every standing rule made from
 * the approval that still stood (`derivedRules`). `ruleError` says why one or more of
 * them could not be read or ended; the supersede stands either way.
 */
export type DecisionSupersedeAnswer = SupersedeAnswer & {
  readonly derivedRules?: readonly DerivedRule[];
  readonly ruleError?: string;
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

/** What a delegation rule's resolution of a decision asks for. */
export type DelegatedResolveRequest = {
  readonly harnessDir: string;
  /** The `dec_` of kind `merge` or `rollout`. */
  readonly ref: string;
  /** The rule, at the revision whose terms and gates allowed it. */
  readonly delegation: { readonly rule: string; readonly revision: number };
  /** Who ran the pass: a stored actor or a system actor. It decided nothing. */
  readonly appliedBy: string;
};

export type DelegatedResolveAnswer = {
  readonly outcome: "decided" | "already-decided" | "expired" | "not-found" | "unavailable";
  readonly decision?: ActionDecisionRow;
  readonly reason?: string;
};

export type Decisions = {
  resolve(request: ResolveRequest, hooks?: ResolveHooks): Promise<ResolveAnswer>;
  /**
   * Resolve a pending `merge` or `rollout` decision as a delegation rule's: the same
   * compare-and-set a person's decision takes, so the first decision wins. Only the
   * delegation service calls this, after the rule's every check passed.
   */
  resolveDelegated(request: DelegatedResolveRequest): Promise<DelegatedResolveAnswer>;
  supersede(request: SupersedeRequest): Promise<DecisionSupersedeAnswer>;
  defer(request: DeferRequest): Promise<DeferAnswer>;
  /** Whether this actor may make and end standing rules on the harness. */
  mayManageRules(harnessDir: string | undefined, actor: DecisionActor): boolean;
  /**
   * The principal an actor decides as, when there is one; on `harnessDir`, a local user's
   * only through the Home that wrote its approver projection.
   */
  principalOf(actor: DecisionActor, harnessDir?: string): ApprovalPrincipal;
  /** The stored actor a record in the harness names for this actor. */
  storedActorOf(harnessDir: string, actor: DecisionActor): Promise<string>;
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

  const judged = { approvers, now: deps.now };
  const authorizerFor = (harnessDir: string | undefined, who: ApprovalPrincipal) =>
    authorizerOf(harnessDir, who, judged);
  const mayManage = (harnessDir: string | undefined, who: ApprovalPrincipal): boolean =>
    mayManageOn(harnessDir, who, judged);

  /**
   * Whom the authorizer judges on `harnessDir`. A local user or a principal on a harness
   * with an approver projection is who this head's access records say only when the
   * projection names this head's Hangar root as the one that wrote it, and nobody under
   * another root; a projection that names no root refuses until `crewhaus access sync`
   * rewrites it. The root is resolved to its real path once, and the records read are
   * the ones under that same path.
   */
  const whoOn = (
    actor: DecisionActor,
    harnessDir: string | undefined,
  ): { readonly who: ApprovalPrincipal } | { readonly refused: string } => {
    const root = realOf(deps.hangarRoot);
    const who = principalOfActor(actor, root);
    // Nobody is nobody under every root: the authorizer says why.
    if (who.principal === undefined || harnessDir === undefined) return { who };
    const read = approvers(harnessDir);
    if (read.state !== "present") return { who };
    const { accessRoot } = read.projection;
    if (accessRoot === undefined) return { refused: UNNAMED_ACCESS_ROOT };
    return accessRoot === root ? { who } : { who: {} };
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
    requiredClass: ChangeAdoptionRow["requiredClass"] | ActionDecisionRow["requiredClass"],
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

  async function resolveActionDecision(
    request: ResolveRequest,
    harnessDir: string,
    who: ApprovalPrincipal,
    row: ActionDecisionRow,
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
        actionDecision: row,
        reason: "a service credential never decides whether this runs; a person does",
      };
    }
    if (!mayDecideAdoption(harnessDir, who, row.requiredClass)) {
      return {
        outcome: "forbidden",
        record: null,
        actionDecision: row,
        reason: needsClassReason(row.requiredClass),
      };
    }
    const nowMs = deps.now();
    const state = actionDecisionState(row, nowMs);
    if (state === "expired") return { outcome: "expired", record: null, actionDecision: row };
    if (state !== "pending") {
      return { outcome: "already-decided", record: null, actionDecision: row };
    }
    if (request.expect !== undefined && request.expect !== "pending") {
      return {
        outcome: "stale",
        record: null,
        actionDecision: row,
        reason: "the decision is pending",
      };
    }
    const by = await storedActor(harnessDir, request.actor, who);
    const decided: ActionDecisionRow = {
      ...row,
      state: request.choice === "grant" ? "granted" : "denied",
      decision: request.choice,
      decidedAt: new Date(nowMs).toISOString(),
      decidedByPrincipal: by,
    };
    // The first decision wins, a person's or a rule's: its generation claim decides.
    const cas = await casAppend(decisionsLedger(harnessDir), row.id, "pending", decided);
    if (!cas.ok) throw new Error(`control-service: the decision cannot be made: ${cas.reason}`);
    if (!cas.applied) {
      const current = readActionDecisions(harnessDir);
      const winner =
        current.state === "present" ? current.rows.find((r) => r.id === row.id) : undefined;
      return { outcome: "already-decided", record: null, actionDecision: winner ?? row };
    }
    return { outcome: "decided", record: null, actionDecision: decided };
  }

  async function resolveDelegated(
    request: DelegatedResolveRequest,
  ): Promise<DelegatedResolveAnswer> {
    const read = readActionDecisions(request.harnessDir);
    if (read.state === "unreadable") return { outcome: "unavailable", reason: read.reason };
    const row = read.state === "present" ? read.rows.find((r) => r.id === request.ref) : undefined;
    if (row === undefined) return { outcome: "not-found" };
    const nowMs = deps.now();
    const state = actionDecisionState(row, nowMs);
    if (state === "expired") return { outcome: "expired", decision: row };
    if (state !== "pending") return { outcome: "already-decided", decision: row };
    const decided: ActionDecisionRow = {
      ...row,
      state: "granted",
      decision: "grant",
      decidedAt: new Date(nowMs).toISOString(),
      resolvedBy: "delegation",
      delegation: { rule: request.delegation.rule, revision: request.delegation.revision },
      appliedBy: request.appliedBy,
    };
    // The same claim a person's decision takes: whoever is first wins.
    const cas = await casAppend(decisionsLedger(request.harnessDir), row.id, "pending", decided);
    if (!cas.ok) return { outcome: "unavailable", reason: cas.reason };
    if (!cas.applied) {
      const current = readActionDecisions(request.harnessDir);
      const winner =
        current.state === "present" ? current.rows.find((r) => r.id === row.id) : undefined;
      return { outcome: "already-decided", decision: winner ?? row };
    }
    return { outcome: "decided", decision: decided };
  }

  /**
   * Whether a request to the owner still asks for exactly the rule its approval gives: the
   * approval is in the store (`rootDir`, else the harness's own root), was granted and
   * still stands (not superseded, not ended by the store's sweep), and its call's narrow
   * rule is the request's tool and pattern.
   */
  const termsStillDerive = (
    harnessDir: string,
    rootDir: string | undefined,
    row: ProposalRow,
  ): boolean => {
    let folded: ReturnType<typeof foldReadOnly>;
    try {
      folded = foldReadOnly(rootOf(harnessDir, rootDir));
    } catch {
      return false;
    }
    if (folded.state === "unreadable") return false;
    const record = folded.records.find((r) => r.id === row.derivedFrom);
    if (record === undefined || record.supersededBy !== undefined) return false;
    if (record.decision !== "grant" || record.expiredAt !== undefined) return false;
    const narrow = standingPatternFor(record.toolName, record.input, harnessDir);
    if ("refused" in narrow) return false;
    const { terms } = row;
    return (
      terms.ruleKind === "allow" &&
      record.toolName === terms.tool &&
      narrow.pattern === terms.pattern
    );
  };

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
    const actions = readActionDecisions(harnessDir);
    const action =
      actions.state === "present" ? actions.rows.find((r) => r.id === request.ref) : undefined;
    if (action !== undefined) return resolveActionDecision(request, harnessDir, who, action);
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
    const terms = row.terms;
    if (request.choice === "grant" && terms.ruleKind === "delegate") {
      return {
        outcome: "invalid",
        record: null,
        proposal: row,
        reason: `a delegation rule is turned on from its consequences page: crewhaus delegations enable ${terms.action} --proposal ${row.id} --harness <h> --confirm <name>`,
      };
    }
    if (request.choice === "grant" && terms.ruleKind === "allow") {
      const endProblem = ruleEndProblem(terms.expiresAt, nowMs);
      if (endProblem !== undefined) {
        return {
          outcome: "invalid",
          record: null,
          proposal: row,
          reason: `the rule this request asks for cannot be made (${endProblem}); ask for it again`,
        };
      }
      if (!termsStillDerive(harnessDir, request.rootDir, row)) {
        return {
          outcome: "invalid",
          record: null,
          proposal: row,
          reason:
            "the approval this request came from is gone or no longer names this rule; ask for it again",
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
    if (request.choice === "deny" || terms.ruleKind !== "allow") {
      return { outcome: "decided", record: null, proposal: decided };
    }
    const made = await runRule(hooks, (cmd) =>
      createStandingRule({
        harnessDir,
        ...(ruleId !== undefined ? { id: ruleId } : {}),
        tool: terms.tool,
        pattern: terms.pattern,
        reason: "proposal",
        ...(row.derivedFrom !== undefined ? { derivedFrom: row.derivedFrom } : {}),
        proposal: row.id,
        createdBy: by,
        expiresAt: terms.expiresAt,
        ...(cmd !== undefined ? { cmd } : {}),
        now: nowMs,
      }),
    );
    return made.ok
      ? { outcome: "decided", record: null, proposal: decided, rule: made.rule }
      : { outcome: "decided", record: null, proposal: decided, ruleError: made.reason };
  }

  async function resolve(request: ResolveRequest, hooks?: ResolveHooks): Promise<ResolveAnswer> {
    const on = whoOn(request.actor, request.harnessDir);
    if ("refused" in on) return { outcome: "forbidden", record: null, reason: on.refused };
    const { who } = on;
    if (isId("dec", request.ref)) return resolveProposal(request, who, hooks);
    if (!APPROVAL_ID_RE.test(request.ref)) {
      return { outcome: "invalid", record: null, reason: `"${request.ref}" is not an approval id` };
    }
    const { harnessDir } = request;
    return resolveToolApproval(
      {
        ...(harnessDir !== undefined ? { harnessDir } : {}),
        rootDir: rootOf(harnessDir, request.rootDir),
        ref: request.ref,
        choice: request.choice,
        who,
        storeActor: storeActorOf(request.actor, who),
        // A rule or a request names its maker only once a decision is made.
        storedBy: () =>
          harnessDir === undefined
            ? Promise.reject(new Error("control-service: a standing rule needs a harness"))
            : storedActor(harnessDir, request.actor, who),
        via: request.via,
        ...(request.always !== undefined ? { always: request.always } : {}),
        ...(request.days !== undefined ? { days: request.days } : {}),
        ...(request.pattern !== undefined ? { pattern: request.pattern } : {}),
        ...(request.confirm !== undefined ? { confirm: request.confirm } : {}),
        ...(request.expect !== undefined ? { expect: request.expect } : {}),
        ...(request.ttlDays !== undefined ? { ttlDays: request.ttlDays } : {}),
      },
      { now: deps.now, approvers },
      hooks,
    );
  }

  /**
   * The standing rules made from a superseded approval that still stand, each ended when
   * the owner superseded it as decided in error, and otherwise named with its verb.
   */
  async function derivedRulesOf(
    request: SupersedeRequest,
    harnessDir: string,
    who: ApprovalPrincipal,
  ): Promise<Pick<DecisionSupersedeAnswer, "derivedRules" | "ruleError">> {
    const listVerb = `crewhaus approvals rules --dir ${harnessDir}`;
    const read = readStandingRules(harnessDir);
    if (read.state === "unreadable") {
      return {
        derivedRules: [],
        ruleError: `the standing rules cannot be read (${read.reason}); a rule made from ${request.ref} may still stand: ${listVerb}`,
      };
    }
    const nowMs = deps.now();
    const rows =
      read.state === "present"
        ? read.rows.filter(
            (row) =>
              row.derivedFrom === request.ref && row.state === "active" && ruleIsLive(row, nowMs),
          )
        : [];
    const problems: string[] = [];
    if (read.state === "present" && read.anomalies.length > 0) {
      problems.push(
        `part of the standing rules cannot be read; a rule made from ${request.ref} may still stand: ${listVerb}`,
      );
    }
    const ends = request.reason === "decided-in-error" && mayManage(harnessDir, who);
    let revokedBy: string | undefined;
    const derivedRules: DerivedRule[] = [];
    for (const row of rows) {
      const verb = `crewhaus approvals revoke ${row.id} --dir ${harnessDir}`;
      if (ends) {
        try {
          revokedBy ??= await storedActor(harnessDir, request.actor, who);
          const ended = await revokeStandingRule({
            harnessDir,
            id: row.id,
            revokedBy,
            now: deps.now(),
          });
          if (ended.outcome === "revoked") {
            derivedRules.push({ id: row.id, revoked: true });
            continue;
          }
          problems.push(
            `${row.id} could not be ended (${ended.outcome === "unavailable" ? ended.reason : ended.outcome}): ${verb}`,
          );
        } catch (err) {
          problems.push(`${row.id} could not be ended (${(err as Error).message}): ${verb}`);
        }
      }
      derivedRules.push({ id: row.id, revoked: false, verb });
    }
    return { derivedRules, ...(problems.length > 0 ? { ruleError: problems.join("; ") } : {}) };
  }

  return {
    resolve,
    resolveDelegated,
    async supersede(request) {
      const on = whoOn(request.actor, request.harnessDir);
      if ("refused" in on) return { outcome: "forbidden", record: null, reason: on.refused };
      const { who } = on;
      const store = storeFor(rootOf(request.harnessDir, request.rootDir));
      const answer = await store.supersede(
        request.ref,
        { actor: storeActorOf(request.actor, who), via: request.via, reason: request.reason },
        { authorize: authorizerFor(request.harnessDir, who) },
      );
      const { harnessDir } = request;
      if (answer.outcome !== "superseded" || harnessDir === undefined) return answer;
      return { ...answer, ...(await derivedRulesOf(request, harnessDir, who)) };
    },
    async defer(request) {
      const on = whoOn(request.actor, request.harnessDir);
      if ("refused" in on) return { outcome: "forbidden", record: null, reason: on.refused };
      const { who } = on;
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
    mayManageRules: (harnessDir, actor) => {
      const on = whoOn(actor, harnessDir);
      return "who" in on && mayManage(harnessDir, on.who);
    },
    principalOf: (actor, harnessDir) => {
      const on = whoOn(actor, harnessDir);
      return "who" in on ? on.who : {};
    },
    storedActorOf: (harnessDir, actor) => {
      const on = whoOn(actor, harnessDir);
      return storedActor(harnessDir, actor, "who" in on ? on.who : {});
    },
  };
}
