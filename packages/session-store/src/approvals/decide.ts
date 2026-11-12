/**
 * Every write to a session root's approvals, under one lock (#507, #513).
 *
 * The lock is `approvals.d/lock`. It ORDERS writes: the shared lock policy steals a
 * lock older than 30 seconds, so a writer paused across a laptop sleep can wake to
 * find another inside. What DECIDES is the claim: `decide` creates
 * `approvals.d/claims/decision/<appr>.json` exclusively, so exactly one decision
 * wins on every surface (Home, the CLI, a channel daemon), even after a lock steal.
 *
 * Inside one `decide` the order is: fold (the whole file and the claims), check,
 * claim, decision-log line, decided rendezvous line. The fold comes first, so a
 * decided line an 0.8.x writer appended counts; the claim comes second, so another
 * writer cannot win after a steal; the log line comes before the rendezvous line,
 * so a repair can tell which half a crash left out.
 *
 * REPAIR ON EVERY LOCKED TOUCH. A claim whose decided line is missing from the file
 * (a crash between claim and append, or a 0.8.x compaction that rewrote the file) is
 * completed by the next writer that takes the lock: it writes the log line if the
 * log lacks it (`outcome: "repaired"`) and the rendezvous line. Reads never repair.
 *
 * `persist` and the TTL sweep take the same lock, so a compaction can no longer drop
 * a line appended while it ran.
 *
 * SPENDING A GRANT. `consume` makes the checks a grant must pass just before the call
 * it covers runs (control-contract's `verifyDecision`: the scope, the revisions, where
 * the call lands, and whether its decider may still decide at its class), under the
 * lock, then creates `approvals.d/claims/consume/<appr>.json` exclusively: one caller
 * spends it, across processes and after a lock steal. A refusal leaves the grant
 * unspent and logs why; one that retires the grant (its revisions moved, or its
 * decider lost the right) supersedes it and parks the request asked in its place.
 */
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  APPROVAL_ID_RE,
  CANONICAL_RUN_ID_RE,
  DECISION_CLASSES,
  DECISION_LOG_REASONS,
  type DecisionClass,
  type DecisionState,
  LOCAL_ACTOR_RE,
  OPERATOR_SUPERSEDE_REASONS,
  RECEIPT_VIA,
  type ReceiptVia,
  type SupersedeReason,
  type VerifyReason,
  effectiveDecisionState,
  isId,
  verifyDecision,
} from "@crewhaus/control-contract";
import {
  type ClaimContent,
  type Ledger,
  type LockedAppend,
  ensureDigestKey,
  publishClaim,
  readClaim,
  withLedgerLock,
} from "@crewhaus/control-records";
import { RuntimeError } from "@crewhaus/errors";
import {
  type SafeFsFailure,
  appendContained,
  openForReadFd,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { fencePath } from "../fence";
import type {
  ApprovalDecision,
  ApprovalPlace,
  ApprovalToPersist,
  ConsumeAnswer,
  ConsumeRequest,
  PendingApproval,
  SupersedeRunRequest,
} from "../index";
import {
  type ClaimsRead,
  type ConsumeClaim,
  type DecisionClaim,
  type ReadConsumeClaim,
  type ReadDecisionClaim,
  type ReadSupersedeClaim,
  type SupersedeClaim,
  applyConsumeClaim,
  applyDecisionClaim,
  applySupersedeClaim,
  approvalIsExpired,
  approvalsFilePath,
  foldApprovalRecords,
  foldWithClaims,
  isPendingApprovalShape,
  parseConsumeClaim,
  parseDecisionClaim,
  parseSupersedeClaim,
  readApprovalsFile,
  wasWithdrawn,
} from "./fold";
import {
  APPROVALS_DIGEST_KEY_FILE,
  APPROVALS_DIRNAME,
  type LogLineFields,
  approvalsLedger,
  decisionLogLine,
  logHasLine,
  placesDigestOf,
  sealBinding,
  storedLocalActor,
} from "./log";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Who is deciding. `principal` is a `prn_` member id; `local` is the OS user as
 * `local:<user>@<host>`, which is stored only as a keyed digest; `display` is free
 * text for display (`decidedBy`), and carries no authority.
 */
export type ApprovalActor = {
  readonly principal?: string;
  readonly local?: string;
  readonly display?: string;
};

export type ApprovalOp = "decide" | "supersede" | "defer";

export type AuthorizeRequest = {
  readonly op: ApprovalOp;
  readonly record: PendingApproval;
  /** The lowest class that may do this: `operator` to decide or defer, `maintainer` to supersede. */
  readonly requiredClass: DecisionClass;
};

/**
 * The authorizer's answer. An allowed answer may name the principal the decision is
 * recorded as (`decidedByPrincipal`); it outranks the actor's own.
 */
export type AuthorizeAnswer =
  | { readonly ok: true; readonly principal?: string }
  | { readonly ok: false; readonly reason: string };

export type ApprovalAuthorizer = (
  request: AuthorizeRequest,
) => AuthorizeAnswer | Promise<AuthorizeAnswer>;

/** The reasons an operator can give to supersede a decision. */
export const SUPERSEDE_REASONS: readonly string[] = OPERATOR_SUPERSEDE_REASONS;
/** The reasons a deferral can give. */
export const DEFER_REASONS: readonly string[] = DECISION_LOG_REASONS.defer;

/** Single-owner mode: everyone who can reach the store may decide, as before 0.9.0. */
export const allowSingleOwner: ApprovalAuthorizer = () => ({ ok: true });

export type DecideRequest = {
  readonly choice: ApprovalDecision;
  readonly actor: ApprovalActor;
  /** The door the decision came through; the log says `legacy` when none is given. */
  readonly via?: ReceiptVia;
  /** Decide only when the request is in this state now; anything else answers `stale`. */
  readonly expect?: DecisionState;
  /** A standing allow (#383): recorded on a grant, ignored on a deny. */
  readonly always?: boolean;
};

export type DecideAnswer = {
  readonly outcome: "decided" | "already-decided" | "stale" | "expired" | "forbidden" | "not-found";
  /** The record as it now stands; `null` when there is none. */
  readonly record: PendingApproval | null;
  /** On `already-decided`: the record as the first decision left it. */
  readonly winner?: PendingApproval;
  readonly reason?: string;
};

export type SupersedeRequest = {
  readonly actor: ApprovalActor;
  readonly via?: ReceiptVia;
  /** One of `OPERATOR_SUPERSEDE_REASONS`. */
  readonly reason: string;
};

export type SupersedeAnswer = {
  readonly outcome: "superseded" | "already-decided" | "stale" | "forbidden" | "not-found";
  readonly record: PendingApproval | null;
  /** The fresh pending request parked in its place. */
  readonly fresh?: PendingApproval;
  readonly winner?: PendingApproval;
  readonly reason?: string;
};

export type DeferRequest = {
  /** An ISO date and time with `Z` or an offset, later than now. */
  readonly until: string;
  /** One of the closed `defer` reasons. */
  readonly reason: string;
  readonly actor: ApprovalActor;
  readonly via?: ReceiptVia;
};

export type DeferAnswer = {
  readonly outcome: "deferred" | "already-decided" | "expired" | "forbidden" | "not-found";
  readonly record: PendingApproval | null;
  readonly winner?: PendingApproval;
  readonly reason?: string;
};

/** The lifecycle steps a file-backed approvals store adds to `PendingApprovalStore`. */
export interface ApprovalDecisions {
  /**
   * Record a decision if, and only if, it is the first. Answers `already-decided`
   * (with the winner) to every later one, on every surface.
   */
  decide(
    id: string,
    request: DecideRequest,
    options: { readonly authorize: ApprovalAuthorizer },
  ): Promise<DecideAnswer>;
  /**
   * Replace a request that was not yet used: the old record is marked superseded
   * and a fresh pending request is parked in its place, carrying `supersedes`.
   */
  supersede(
    id: string,
    request: SupersedeRequest,
    options: { readonly authorize: ApprovalAuthorizer },
  ): Promise<SupersedeAnswer>;
  /** Mark a pending request as deferred until a time, with a reason code. */
  defer(
    id: string,
    request: DeferRequest,
    options: { readonly authorize: ApprovalAuthorizer },
  ): Promise<DeferAnswer>;
  /**
   * Spend a grant, once: the checks just before its call runs, under the lock,
   * then an exclusive consume claim. See the module docblock.
   */
  consume(id: string, request: ConsumeRequest): Promise<ConsumeAnswer>;
  /**
   * Withdraw the requests the named runs wait on, because they were cancelled:
   * superseded `run-cancelled`, with nothing asked in their place.
   */
  supersedeRun(
    runIds: readonly string[],
    request: SupersedeRunRequest,
  ): Promise<{ readonly superseded: string[] }>;
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

type Hook = () => void | Promise<void>;

type ApprovalSeams = {
  /** After a locked operation has folded and repaired, before it checks. */
  readonly afterFold?: Hook;
  /** After a claim is published, before the log line. May throw (a crash). */
  readonly afterClaim?: Hook;
  /** In the TTL sweep, after every log line and before the rewrite. May throw. */
  readonly beforeRewrite?: Hook;
};

let seams: ApprovalSeams = {};

/**
 * Test seam: hold an interleaving. Each call reads the seams once, when it starts,
 * so two concurrent writers can be held differently. Pass `undefined` to restore.
 */
export function _setApprovalSeamsForTest(next: ApprovalSeams | undefined): void {
  seams = next ?? {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Mint a fresh approval id in the `appr_<16 hex>` format the store validates. */
export function generateApprovalId(): string {
  return `appr_${randomBytes(8).toString("hex")}`;
}

function validateId(id: string): void {
  if (typeof id !== "string" || !APPROVAL_ID_RE.test(id)) {
    throw new RuntimeError(`session-store: invalid approvalId "${id}" — expected appr_<16 hex>`);
  }
}

function validateVia(via: unknown): void {
  if (via !== undefined && !(RECEIPT_VIA as readonly unknown[]).includes(via)) {
    throw new RuntimeError(
      `session-store: "${String(via)}" is not a surface (one of: ${RECEIPT_VIA.join(", ")})`,
    );
  }
}

function validateActor(actor: ApprovalActor): void {
  if (typeof actor !== "object" || actor === null) {
    throw new RuntimeError("session-store: a decision needs an actor");
  }
  if (actor.principal !== undefined && !isId("prn", actor.principal)) {
    throw new RuntimeError("session-store: an actor's principal must be a prn_ id");
  }
  if (actor.local !== undefined && !LOCAL_ACTOR_RE.test(actor.local)) {
    throw new RuntimeError("session-store: an actor's local identity must be local:<user>@<host>");
  }
  if (actor.display !== undefined && typeof actor.display !== "string") {
    throw new RuntimeError("session-store: an actor's display name must be text");
  }
}

/**
 * The class a decision on `record` needs. Only an absent class defaults to
 * `operator`; one that is present and not a class needs the owner.
 */
function classOf(record: PendingApproval): DecisionClass {
  const required: unknown = record.requiredClass;
  if (required === undefined) return "operator";
  return (DECISION_CLASSES as readonly unknown[]).includes(required)
    ? (required as DecisionClass)
    : "owner";
}

/** Decided, spent or superseded: nothing a later decision may change. */
function isSettled(record: PendingApproval): boolean {
  return (
    record.decision !== undefined ||
    record.consumedAt !== undefined ||
    record.supersededBy !== undefined
  );
}

function refusal(op: string, what: string, failure: SafeFsFailure): RuntimeError {
  return new RuntimeError(
    `session-store: refusing to ${op} ${what} at ${failure.path}: ${failure.reason} (code ${failure.code})`,
  );
}

/** The record's last byte is `\n`; `undefined` when the file cannot say (the append will). */
function endsInNewline(abs: string): boolean | undefined {
  const opened = openForReadFd(dirname(abs), basename(abs), { followLeafSymlink: false });
  if (!opened.ok) return undefined;
  try {
    if (opened.stats.size === 0) return true;
    const last = Buffer.alloc(1);
    if (readSync(opened.fd, last, 0, 1, opened.stats.size - 1) !== 1) return undefined;
    return last[0] === 0x0a;
  } catch {
    return undefined;
  } finally {
    closeSync(opened.fd);
  }
}

/** The ISO instant shapes `defer` accepts: a date and a time, with `Z` or an offset. */
const UNTIL_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})$/;
const OFFSETLESS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * `until` as an instant, or why it is refused. A time without an offset is refused
 * rather than read in the host's zone: the same text would name a different instant
 * on another machine.
 */
export function parseDeferUntil(until: unknown, nowMs: number): number | string {
  if (typeof until !== "string") return "until must be an ISO date and time";
  if (OFFSETLESS_RE.test(until)) {
    return `"${until}" has no UTC offset; add Z or ±HH:MM (for example ${until}Z)`;
  }
  const match = UNTIL_RE.exec(until);
  if (match === null) {
    return `"${until}" is not an ISO date and time with Z or an offset (for example 2026-12-01T09:00:00Z)`;
  }
  const [, date, time, offset] = match;
  const zone = offset === "Z" ? "Z" : `${offset?.slice(0, 3)}:${offset?.slice(-2)}`;
  const ms = Date.parse(`${date}T${time}${zone}`);
  if (Number.isNaN(ms)) return `"${until}" is not a real date and time`;
  if (ms <= nowMs) return `"${until}" is not later than now`;
  return ms;
}

// ---------------------------------------------------------------------------
// The locked touch
// ---------------------------------------------------------------------------

export type ApprovalWriterContext = {
  readonly rootDir: string;
  readonly ttlDays: number;
  readonly now: () => Date;
};

/** What a locked operation sees: the file, its fold, the claims, and the two appends. */
type Touch = {
  readonly ledger: Ledger;
  /** Ids in file order of their first line. */
  readonly order: readonly string[];
  /** The fold with every readable claim applied. Updated as repairs and writes land. */
  readonly records: Map<string, PendingApproval>;
  readonly claims: ClaimsRead;
  /** Which facts the file holds a line for. */
  readonly facts: Set<string>;
  /** The session root's digest key, created on first use. */
  key(): Promise<CryptoKey>;
  /** Append to the decision log, or throw. */
  log(record: PendingApproval, fields: LogLineFields): Promise<void>;
  /** Append to the rendezvous file, or throw. */
  rendezvous(record: PendingApproval): void;
};

const decidedFact = (id: string, choice: string): string => `decided\0${id}\0${choice}`;
const supersededFact = (id: string, by: string): string => `superseded\0${id}\0${by}`;
const parkedFact = (id: string): string => `parked\0${id}`;
const consumedFact = (id: string): string => `consumed\0${id}`;

function factsOf(objects: readonly unknown[]): Set<string> {
  const facts = new Set<string>();
  for (const value of objects) {
    if (!isPendingApprovalShape(value)) continue;
    facts.add(parkedFact(value.id));
    if (typeof value.decision === "string") facts.add(decidedFact(value.id, value.decision));
    if (typeof value.supersededBy === "string") {
      facts.add(supersededFact(value.id, value.supersededBy));
    }
    if (typeof value.consumedAt === "string") facts.add(consumedFact(value.id));
  }
  return facts;
}

function openTouch(rootDir: string, ledger: Ledger, lockedAppend: LockedAppend): Touch {
  const read = readApprovalsFile(rootDir);
  if (read.state === "unreadable") {
    // Every locked operation appends to it: refused the way an append is.
    throw new RuntimeError(
      `session-store: refusing to append to the approvals log at ${read.path}: ${read.reason} (code ${read.code})`,
    );
  }
  const objects = read.state === "read" ? read.objects : [];
  const folded = foldWithClaims(rootDir, objects);
  const { claims } = folded;
  const records = new Map(folded.records.map((r) => [r.id, r] as const));
  const facts = factsOf(objects);
  let keyed: Promise<CryptoKey> | undefined;
  const key = (): Promise<CryptoKey> => {
    keyed ??= ensureDigestKey(ledger.root, { file: APPROVALS_DIGEST_KEY_FILE }).then((answer) => {
      if (answer.state !== "present") {
        throw new RuntimeError(
          `session-store: the approvals digest key cannot be read: ${answer.reason}`,
        );
      }
      return answer.hmac;
    });
    return keyed;
  };
  const abs = approvalsFilePath(rootDir);
  return {
    ledger,
    order: folded.records.map((r) => r.id),
    records,
    claims,
    facts,
    key,
    async log(record, fields) {
      const line = await decisionLogLine(await key(), record, fields);
      const written = lockedAppend(line);
      if (!written.ok) throw refusal("append to", "the decision log", written);
    },
    rendezvous(record) {
      const seal = endsInNewline(abs) === false ? "\n" : "";
      const written = appendContained(
        dirname(abs),
        basename(abs),
        `${seal}${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );
      if (!written.ok) throw refusal("append to", "the approvals log", written);
      facts.add(parkedFact(record.id));
      if (record.decision !== undefined) facts.add(decidedFact(record.id, record.decision));
      if (record.supersededBy !== undefined) {
        facts.add(supersededFact(record.id, record.supersededBy));
      }
      if (record.consumedAt !== undefined) facts.add(consumedFact(record.id));
    },
  };
}

/**
 * Run `fn` under the session root's lock, on a fresh fold. Every path it can write is
 * checked against the tenant fence first, and the root is created as before.
 */
async function locked<T>(rootDir: string, fn: (touch: Touch) => Promise<T>): Promise<T> {
  const root = resolve(rootDir);
  fencePath(resolve(root, APPROVALS_DIRNAME));
  approvalsFilePath(root);
  mkdirSync(root, { recursive: true });
  const ledger = approvalsLedger(root);
  const answer = await withLedgerLock(ledger, async (lockedAppend) => ({
    value: await fn(openTouch(root, ledger, lockedAppend)),
  }));
  if (!("value" in answer)) throw refusal("lock", "the approvals log", answer);
  return answer.value;
}

/** What a spend that retired a grant knows now, so the request asked in its place is bound to it. */
type Rebind = {
  readonly runId: string;
  readonly deploymentId?: string;
  readonly specHash?: string;
  readonly resourceRevision?: string;
  readonly places: ReadonlyArray<ApprovalPlace>;
};

/** The binding of a request asked in place of one whose grant was refused at the spend. */
function reboundBinding(record: PendingApproval, rebind: Rebind): ApprovalToPersist["binding"] {
  const old: unknown = record.binding;
  if (typeof old !== "object" || old === null) return undefined;
  const { resumeScope, sessionId, workItem } = old as Partial<Record<string, unknown>>;
  if (typeof resumeScope !== "string" || typeof sessionId !== "string") return undefined;
  const bound = typeof rebind.resourceRevision === "string" && rebind.resourceRevision !== "";
  return {
    runId: rebind.runId,
    resumeScope,
    sessionId,
    ...(typeof workItem === "string" ? { workItem } : {}),
    ...(rebind.deploymentId !== undefined ? { deploymentId: rebind.deploymentId } : {}),
    ...(rebind.specHash !== undefined ? { specHash: rebind.specHash } : {}),
    ...(bound ? { resourceRevision: rebind.resourceRevision } : {}),
    resourceRevisionBound: bound,
  };
}

/**
 * The fresh request a supersede parks in place of `record`. It keeps the record's
 * class and its binding, so a request asked again is never easier to grant, nor
 * bound to less, than the one it replaces. With `rebind` (a grant refused at the
 * spend) it is bound to what the spend found instead: the spending run, the
 * revisions it runs under and where the call lands now, since a copy of the old
 * revisions would be refused again on every grant of the replacement. The caller
 * seals the binding.
 */
function freshRequest(
  record: PendingApproval,
  id: string,
  at: string,
  rebind?: Rebind,
): ApprovalToPersist {
  const places = rebind !== undefined ? rebind.places : record.places;
  const binding = rebind !== undefined ? reboundBinding(record, rebind) : record.binding;
  return {
    id,
    toolName: record.toolName,
    inputHash: record.inputHash,
    ...(record.input !== undefined ? { input: record.input } : {}),
    ...(places !== undefined ? { places } : {}),
    supersedes: {
      id: record.id,
      ...(record.decision !== undefined ? { decision: record.decision } : {}),
      ...(record.places !== undefined ? { places: record.places } : {}),
    },
    runId: rebind !== undefined ? rebind.runId : record.runId,
    sessionId: record.sessionId,
    surface: record.surface,
    createdAt: at,
    ...(record.requiredClass !== undefined ? { requiredClass: record.requiredClass } : {}),
    ...(binding !== undefined ? { binding } : {}),
  };
}

/** Complete a decision whose claim exists and whose decided line the file lacks. */
async function repairDecision(touch: Touch, id: string, read: ReadDecisionClaim): Promise<void> {
  const current = touch.records.get(id);
  if (current === undefined) return;
  const decided = applyDecisionClaim(current, read.claim);
  touch.records.set(id, decided);
  if (touch.facts.has(decidedFact(id, read.claim.choice))) return;
  const logged = logHasLine(
    touch.ledger,
    read.content.seg,
    (line) => line["event"] === "decide" && line["decision"] === id,
  );
  if (!logged) {
    await touch.log(decided, {
      event: "decide",
      at: read.claim.decidedAt,
      surface: read.claim.decidedVia ?? "legacy",
      ...(read.claim.decidedByPrincipal !== undefined ? { by: read.claim.decidedByPrincipal } : {}),
      choice: read.claim.choice,
      outcome: "repaired",
    });
  }
  touch.rendezvous(decided);
}

/** Complete a supersede whose claim exists and whose lines the file lacks, fresh park included. */
async function repairSupersede(touch: Touch, id: string, read: ReadSupersedeClaim): Promise<void> {
  const current = touch.records.get(id);
  if (current === undefined) return;
  const { supersededBy, reason, parkedAt } = read.claim;
  const superseded = applySupersedeClaim(current, read.claim);
  touch.records.set(id, superseded);
  if (!touch.facts.has(supersededFact(id, supersededBy))) {
    const logged = logHasLine(
      touch.ledger,
      read.content.seg,
      (line) => line["event"] === "supersede" && line["decision"] === id,
    );
    if (!logged) {
      await touch.log(superseded, {
        event: "supersede",
        at: read.content.at,
        surface: "legacy",
        reason,
        outcome: "repaired",
      });
    }
    touch.rendezvous(superseded);
  }
  // A request withdrawn because its run was cancelled is replaced by nothing:
  // `supersededBy` names the run, not a request to park.
  if (wasWithdrawn(superseded)) return;
  if (!touch.facts.has(parkedFact(supersededBy))) {
    const fresh = await sealed(touch, freshRequest(superseded, supersededBy, parkedAt));
    const logged = logHasLine(
      touch.ledger,
      read.content.seg,
      (line) => line["event"] === "park" && line["decision"] === supersededBy,
    );
    if (!logged) {
      await touch.log(fresh, { event: "park", at: parkedAt, surface: fresh.surface });
    }
    touch.rendezvous(fresh);
    touch.records.set(supersededBy, fresh);
  }
}

/** Complete a spend whose consume claim exists and whose lines the file or the log lacks. */
async function repairConsume(touch: Touch, id: string, read: ReadConsumeClaim): Promise<void> {
  const current = touch.records.get(id);
  if (current === undefined || current.decision !== "grant") return;
  const consumed = applyConsumeClaim(current, read.claim);
  touch.records.set(id, consumed);
  if (touch.facts.has(consumedFact(id))) return;
  const logged = logHasLine(
    touch.ledger,
    read.content.seg,
    (line) => line["event"] === "consume" && line["decision"] === id,
  );
  if (!logged) {
    await touch.log(consumed, {
      event: "consume",
      at: read.claim.consumedAt,
      surface: consumed.surface,
      outcome: "repaired",
    });
  }
  touch.rendezvous(consumed);
}

/** Every repair the claims call for. Runs first in every locked operation. */
async function repairAll(touch: Touch): Promise<void> {
  for (const id of [...touch.order]) {
    const decision = touch.claims.decisions.get(id);
    if (decision !== undefined) await repairDecision(touch, id, decision);
    const supersede = touch.claims.supersedes.get(id);
    if (supersede !== undefined) await repairSupersede(touch, id, supersede);
    const consume = touch.claims.consumes.get(id);
    if (consume !== undefined) await repairConsume(touch, id, consume);
  }
}

/** A claim another writer published first, read whole, or a throw: a winner must be known. */
function winnerClaim<T>(
  touch: Touch,
  claim: string,
  parse: (record: Readonly<Record<string, unknown>>) => T | string,
): { readonly content: ClaimContent; readonly claim: T } {
  const answer = readClaim(touch.ledger, claim);
  if (!answer.ok) throw refusal("read", `the claim ${claim}`, answer);
  const parsed = parse(answer.content.record);
  if (typeof parsed === "string") {
    throw new RuntimeError(`session-store: the claim ${claim} is not readable: ${parsed}`);
  }
  return { content: answer.content, claim: parsed };
}

async function storedActor(
  touch: Touch,
  actor: ApprovalActor,
  verdict: { readonly principal?: string },
): Promise<string | undefined> {
  const principal = verdict.principal ?? actor.principal;
  if (principal !== undefined) {
    if (!isId("prn", principal)) {
      throw new RuntimeError("session-store: an authorizer's principal must be a prn_ id");
    }
    return principal;
  }
  if (actor.local !== undefined) return storedLocalActor(await touch.key(), actor.local);
  return undefined;
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

export type ApprovalWriter = ApprovalDecisions & {
  /**
   * Append a record under the lock: a park line for a new id, a consume line for a
   * spend, a newer line for a pending request. A record that carries a binding is
   * sealed first (`sealBinding`). An undecided line for a request already decided
   * or withdrawn writes nothing.
   */
  persist(approval: ApprovalToPersist): Promise<void>;
};

function validateConsume(request: ConsumeRequest): void {
  if (typeof request !== "object" || request === null) {
    throw new RuntimeError("session-store: a spend needs a request");
  }
  if (typeof request.runId !== "string" || request.runId === "") {
    throw new RuntimeError("session-store: a spend names the run spending it");
  }
  if (typeof request.resumeScope !== "string" || request.resumeScope === "") {
    throw new RuntimeError("session-store: a spend names the scope it is made in");
  }
  if (!Array.isArray(request.places)) {
    throw new RuntimeError("session-store: a spend says where its call lands");
  }
  if (typeof request.approvers !== "object" || request.approvers === null) {
    throw new RuntimeError("session-store: a spend says who may decide in this harness");
  }
}

/** The record as the file holds it: a binding sealed, or no binding at all. */
async function sealed(touch: Touch, approval: ApprovalToPersist): Promise<PendingApproval> {
  if (approval.binding === undefined) return approval as PendingApproval;
  return sealBinding(await touch.key(), approval);
}

export function createApprovalWriter(ctx: ApprovalWriterContext): ApprovalWriter {
  const { rootDir, ttlDays, now } = ctx;
  const cutoffMs = (): number => now().getTime() - ttlDays * MS_PER_DAY;
  const expiredAt = (record: PendingApproval, nowMs: number): boolean =>
    approvalIsExpired(record, cutoffMs()) ||
    effectiveDecisionState(record, null, nowMs).state === "expired";

  return {
    async persist(approval) {
      validateId(approval.id);
      const seam = seams;
      await locked(rootDir, async (touch) => {
        await repairAll(touch);
        await seam.afterFold?.();
        const existing = touch.records.get(approval.id);
        // An undecided line adds nothing to a request already decided or withdrawn.
        if (
          existing !== undefined &&
          approval.decision === undefined &&
          (existing.decision !== undefined || existing.supersededBy !== undefined)
        ) {
          return;
        }
        const at = now().toISOString();
        const record = await sealed(touch, approval);
        if (existing === undefined) {
          await touch.log(record, { event: "park", at, surface: record.surface });
        } else if (
          record.consumedAt !== undefined &&
          existing.decision === "grant" &&
          existing.consumedAt === undefined
        ) {
          await touch.log(existing, { event: "consume", at, surface: existing.surface });
        }
        touch.rendezvous(record);
      });
    },

    async decide(id, request, { authorize }) {
      validateId(id);
      if (request.choice !== "grant" && request.choice !== "deny") {
        throw new RuntimeError(`session-store: "${String(request.choice)}" is not grant or deny`);
      }
      validateVia(request.via);
      validateActor(request.actor);
      const seam = seams;
      return locked(rootDir, async (touch): Promise<DecideAnswer> => {
        await repairAll(touch);
        await seam.afterFold?.();
        const record = touch.records.get(id);
        if (record === undefined) return { outcome: "not-found", record: null };
        const verdict = await authorize({ op: "decide", record, requiredClass: classOf(record) });
        if (!verdict.ok) return { outcome: "forbidden", record, reason: verdict.reason };
        const nowMs = now().getTime();
        const state = effectiveDecisionState(record, null, nowMs).state;
        if (request.expect !== undefined && state !== request.expect) {
          return { outcome: "stale", record, reason: `the request is ${state}` };
        }
        if (isSettled(record)) return { outcome: "already-decided", record, winner: record };
        if (expiredAt(record, nowMs)) return { outcome: "expired", record };

        const by = await storedActor(touch, request.actor, verdict);
        // The display name goes on the decided line only, never in the claim: a
        // claim outlives the TTL sweep, and free text must not (see DecisionClaim).
        const claim: DecisionClaim = {
          choice: request.choice,
          decidedAt: now().toISOString(),
          ...(by !== undefined ? { decidedByPrincipal: by } : {}),
          ...(request.via !== undefined ? { decidedVia: request.via } : {}),
          ...(request.always === true && request.choice === "grant" ? { always: true } : {}),
        };
        const published = publishClaim(touch.ledger, `decision/${id}`, claim);
        if (!published.ok) {
          if (published.code !== "exists") throw refusal("claim", `decision ${id}`, published);
          // A writer that stole the lock decided first: complete its lines, then say so.
          const winner = winnerClaim(touch, `decision/${id}`, parseDecisionClaim);
          await repairDecision(touch, id, winner);
          const decided = touch.records.get(id) ?? applyDecisionClaim(record, winner.claim);
          return { outcome: "already-decided", record: decided, winner: decided };
        }
        await seam.afterClaim?.();
        const decided: PendingApproval = {
          ...applyDecisionClaim(record, claim),
          ...(request.actor.display !== undefined ? { decidedBy: request.actor.display } : {}),
        };
        await touch.log(decided, {
          event: "decide",
          at: claim.decidedAt,
          surface: request.via ?? "legacy",
          ...(by !== undefined ? { by } : {}),
          choice: request.choice,
        });
        touch.rendezvous(decided);
        touch.records.set(id, decided);
        return { outcome: "decided", record: decided };
      });
    },

    async supersede(id, request, { authorize }) {
      validateId(id);
      if (!(OPERATOR_SUPERSEDE_REASONS as readonly unknown[]).includes(request.reason)) {
        throw new RuntimeError(
          `session-store: "${String(request.reason)}" is not a reason to supersede (one of: ${OPERATOR_SUPERSEDE_REASONS.join(", ")})`,
        );
      }
      validateVia(request.via);
      validateActor(request.actor);
      const reason = request.reason as SupersedeReason;
      const seam = seams;
      return locked(rootDir, async (touch): Promise<SupersedeAnswer> => {
        await repairAll(touch);
        await seam.afterFold?.();
        const record = touch.records.get(id);
        if (record === undefined) return { outcome: "not-found", record: null };
        const verdict = await authorize({ op: "supersede", record, requiredClass: "maintainer" });
        if (!verdict.ok) return { outcome: "forbidden", record, reason: verdict.reason };
        const nowMs = now().getTime();
        const state = effectiveDecisionState(record, null, nowMs).state;
        if (record.supersededBy !== undefined || record.consumedAt !== undefined) {
          return { outcome: "stale", record, reason: `the request is ${state}` };
        }
        if (expiredAt(record, nowMs)) {
          return { outcome: "stale", record, reason: "the request is expired" };
        }

        const by = await storedActor(touch, request.actor, verdict);
        const parkedAt = now().toISOString();
        const claim: SupersedeClaim = {
          supersededBy: generateApprovalId(),
          reason,
          parkedAt,
        };
        const published = publishClaim(touch.ledger, `supersede/${id}`, claim);
        if (!published.ok) {
          if (published.code !== "exists") throw refusal("claim", `supersede ${id}`, published);
          const winner = winnerClaim(touch, `supersede/${id}`, parseSupersedeClaim);
          await repairSupersede(touch, id, winner);
          const settled = touch.records.get(id) ?? applySupersedeClaim(record, winner.claim);
          return { outcome: "already-decided", record: settled, winner: settled };
        }
        await seam.afterClaim?.();
        const superseded = applySupersedeClaim(record, claim);
        await touch.log(superseded, {
          event: "supersede",
          at: parkedAt,
          surface: request.via ?? "legacy",
          ...(by !== undefined ? { by } : {}),
          reason,
        });
        touch.rendezvous(superseded);
        touch.records.set(id, superseded);
        const fresh = await sealed(touch, freshRequest(superseded, claim.supersededBy, parkedAt));
        await touch.log(fresh, { event: "park", at: parkedAt, surface: fresh.surface });
        touch.rendezvous(fresh);
        touch.records.set(fresh.id, fresh);
        return { outcome: "superseded", record: superseded, fresh };
      });
    },

    async defer(id, request, { authorize }) {
      validateId(id);
      const until = parseDeferUntil(request.until, now().getTime());
      if (typeof until === "string") throw new RuntimeError(`session-store: ${until}`);
      const reasons: readonly string[] = DECISION_LOG_REASONS.defer;
      if (!reasons.includes(request.reason)) {
        throw new RuntimeError(
          `session-store: "${String(request.reason)}" is not a reason to defer (one of: ${reasons.join(", ")})`,
        );
      }
      validateVia(request.via);
      validateActor(request.actor);
      const untilIso = new Date(until).toISOString();
      const seam = seams;
      return locked(rootDir, async (touch): Promise<DeferAnswer> => {
        await repairAll(touch);
        await seam.afterFold?.();
        const record = touch.records.get(id);
        if (record === undefined) return { outcome: "not-found", record: null };
        const verdict = await authorize({ op: "defer", record, requiredClass: "operator" });
        if (!verdict.ok) return { outcome: "forbidden", record, reason: verdict.reason };
        if (touch.claims.decisions.has(id) || isSettled(record)) {
          return { outcome: "already-decided", record, winner: record };
        }
        if (expiredAt(record, now().getTime())) return { outcome: "expired", record };
        // No claim decides a deferral. One a lock stealer published since the fold wins.
        const late = readClaim(touch.ledger, `decision/${id}`);
        if (late.ok) {
          const parsed = parseDecisionClaim(late.content.record);
          const winner = typeof parsed === "string" ? record : applyDecisionClaim(record, parsed);
          return { outcome: "already-decided", record: winner, winner };
        }
        const by = await storedActor(touch, request.actor, verdict);
        const deferred: PendingApproval = { ...record, deferredUntil: untilIso };
        await touch.log(deferred, {
          event: "defer",
          at: now().toISOString(),
          surface: request.via ?? "legacy",
          ...(by !== undefined ? { by } : {}),
          reason: request.reason,
          until: untilIso,
        });
        touch.rendezvous(deferred);
        touch.records.set(id, deferred);
        return { outcome: "deferred", record: deferred };
      });
    },

    async consume(id, request) {
      validateId(id);
      validateConsume(request);
      const seam = seams;
      return locked(rootDir, async (touch): Promise<ConsumeAnswer> => {
        await repairAll(touch);
        await seam.afterFold?.();
        const record = touch.records.get(id);
        if (record === undefined) return { outcome: "not-found", record: null };
        const nowMs = now().getTime();
        const at = now().toISOString();
        const surface = request.surface ?? record.surface;
        const refused = async (
          reason: VerifyReason,
          fresh?: PendingApproval,
        ): Promise<ConsumeAnswer> => {
          await touch.log(record, { event: "refuse", at, surface, reason });
          return {
            outcome: "refused",
            reason,
            record: touch.records.get(id) ?? record,
            ...(fresh !== undefined ? { fresh } : {}),
          };
        };
        // Past the TTL, a grant is about to be swept: never spent.
        if (approvalIsExpired(record, cutoffMs())) return refused("expired");
        const key = await touch.key();
        const verdict = verifyDecision({
          decision: record,
          consumer: {
            runId: request.runId,
            resumeScope: request.resumeScope,
            ...(request.continues !== undefined ? { continues: request.continues } : {}),
            ...(request.deploymentId !== undefined ? { deploymentId: request.deploymentId } : {}),
            ...(request.specHash !== undefined ? { specHash: request.specHash } : {}),
            ...(request.resourceRevision !== undefined
              ? { resourceRevision: request.resourceRevision }
              : {}),
            placesDigest: await placesDigestOf(key, request.places),
          },
          approvers: request.approvers,
          now: nowMs,
        });
        if (!verdict.ok) {
          const reason = verdict.supersedeReason;
          // A refusal that can change back (a scope, a place, a list that cannot be
          // read) leaves the grant as it is. One that cannot retires it, unless no
          // run waits on an answer, so nothing new reaches the inbox.
          if (reason === undefined || request.reask === false) return refused(verdict.reason);
          const claim: SupersedeClaim = {
            supersededBy: generateApprovalId(),
            reason,
            parkedAt: at,
          };
          const published = publishClaim(touch.ledger, `supersede/${id}`, claim);
          if (!published.ok) {
            if (published.code !== "exists") throw refusal("claim", `supersede ${id}`, published);
            // Another writer retired it first: complete its lines, and hand back its request.
            const winner = winnerClaim(touch, `supersede/${id}`, parseSupersedeClaim);
            await repairSupersede(touch, id, winner);
            const asked =
              winner.claim.reason === "run-cancelled"
                ? undefined
                : touch.records.get(winner.claim.supersededBy);
            return refused(verdict.reason, asked);
          }
          await seam.afterClaim?.();
          const superseded = applySupersedeClaim(record, claim);
          await touch.log(record, { event: "refuse", at, surface, reason: verdict.reason });
          await touch.log(superseded, { event: "supersede", at, surface, reason });
          touch.rendezvous(superseded);
          touch.records.set(id, superseded);
          const fresh = await sealed(
            touch,
            freshRequest(superseded, claim.supersededBy, at, {
              runId: request.runId,
              ...(request.deploymentId !== undefined ? { deploymentId: request.deploymentId } : {}),
              ...(request.specHash !== undefined ? { specHash: request.specHash } : {}),
              ...(request.resourceRevision !== undefined
                ? { resourceRevision: request.resourceRevision }
                : {}),
              places: request.places,
            }),
          );
          await touch.log(fresh, { event: "park", at, surface: fresh.surface });
          touch.rendezvous(fresh);
          touch.records.set(fresh.id, fresh);
          return { outcome: "refused", reason: verdict.reason, record: superseded, fresh };
        }
        const claim: ConsumeClaim = { consumedAt: at, consumedByRun: request.runId };
        const published = publishClaim(touch.ledger, `consume/${id}`, claim);
        if (!published.ok) {
          if (published.code !== "exists") throw refusal("claim", `consume ${id}`, published);
          // A writer that stole the lock spent it first: complete its lines, then say so.
          const winner = winnerClaim(touch, `consume/${id}`, parseConsumeClaim);
          await repairConsume(touch, id, winner);
          return refused("consumed");
        }
        await seam.afterClaim?.();
        const consumed = applyConsumeClaim(record, claim);
        await touch.log(consumed, { event: "consume", at, surface });
        touch.rendezvous(consumed);
        touch.records.set(id, consumed);
        return { outcome: "consumed", record: consumed };
      });
    },

    async supersedeRun(runIds, request) {
      if (request?.reason !== "run-cancelled") {
        throw new RuntimeError(
          "session-store: a run's requests are withdrawn only when it is cancelled",
        );
      }
      validateVia(request.via);
      const named = (Array.isArray(runIds) ? runIds : []).filter(
        (id): id is string => typeof id === "string" && id !== "",
      );
      // A withdrawn request names the run whose cancel withdrew it, by its canonical id.
      const by = named.find((id) => CANONICAL_RUN_ID_RE.test(id));
      if (by === undefined) return { superseded: [] };
      // A root with no approvals has nothing to withdraw, and nothing is created there.
      if (readApprovalsFile(rootDir).state === "absent") return { superseded: [] };
      const runs = new Set(named);
      const seam = seams;
      return locked(rootDir, async (touch) => {
        await repairAll(touch);
        await seam.afterFold?.();
        const nowMs = now().getTime();
        const at = now().toISOString();
        const superseded: string[] = [];
        for (const id of [...touch.order]) {
          const record = touch.records.get(id);
          if (record === undefined || !runs.has(boundRunOf(record))) continue;
          // Pending, or granted and unspent: what a cancelled run was waiting on.
          if (record.supersededBy !== undefined || record.consumedAt !== undefined) continue;
          if (record.decision !== undefined && record.decision !== "grant") continue;
          if (expiredAt(record, nowMs)) continue;
          const claim: SupersedeClaim = {
            supersededBy: by,
            reason: "run-cancelled",
            parkedAt: at,
          };
          const published = publishClaim(touch.ledger, `supersede/${id}`, claim);
          if (!published.ok) {
            if (published.code !== "exists") throw refusal("claim", `supersede ${id}`, published);
            const winner = winnerClaim(touch, `supersede/${id}`, parseSupersedeClaim);
            await repairSupersede(touch, id, winner);
            continue;
          }
          await seam.afterClaim?.();
          const withdrawn = applySupersedeClaim(record, claim);
          await touch.log(withdrawn, {
            event: "supersede",
            at,
            surface: request.via ?? "system",
            reason: "run-cancelled",
          });
          touch.rendezvous(withdrawn);
          touch.records.set(id, withdrawn);
          superseded.push(id);
        }
        return { superseded };
      });
    },
  };
}

/** The run a request is bound to: its binding's, or, unbound, the run that parked it. */
function boundRunOf(record: PendingApproval): string {
  const binding: unknown = record.binding;
  if (typeof binding === "object" && binding !== null) {
    const runId = (binding as { readonly runId?: unknown }).runId;
    if (typeof runId === "string") return runId;
  }
  return record.runId;
}

// ---------------------------------------------------------------------------
// The TTL sweep
// ---------------------------------------------------------------------------

/** A pending request or an unspent grant: what a TTL drop expires before it evicts. */
function expiresBeforeEviction(record: PendingApproval): boolean {
  if (record.supersededBy !== undefined || record.consumedAt !== undefined) return false;
  return record.decision === undefined || record.decision === "grant";
}

/**
 * Drop records past the TTL, under the lock. A root with no approvals file, or one
 * that folds to no record, is left alone and nothing is created: the runtime sweeps
 * at every boot. Otherwise every dropped record gets its log lines first (`expire`
 * for a pending request or an unspent grant, then `evict` for each), and only then
 * is the file rewritten with the folded survivors, claims applied: never each id's
 * last line. A rewrite that fails is reported and leaves the log lines in place.
 */
export async function sweepApprovals(
  rootDir: string,
  cutoffMs: number,
  now: () => Date,
): Promise<{ evictedIds: string[]; live: PendingApproval[] }> {
  const first = readApprovalsFile(rootDir);
  if (first.state === "absent") return { evictedIds: [], live: [] };
  if (first.state === "unreadable") {
    throw new RuntimeError(
      `session-store: refusing to sweep the approvals log at ${first.path}: ${first.reason} (code ${first.code})`,
    );
  }
  if (foldApprovalRecords(first.objects).records.length === 0) {
    return { evictedIds: [], live: [] };
  }
  const seam = seams;
  return locked(rootDir, async (touch) => {
    await repairAll(touch);
    await seam.afterFold?.();
    const live: PendingApproval[] = [];
    const evicted: PendingApproval[] = [];
    for (const id of touch.order) {
      const record = touch.records.get(id);
      if (record === undefined) continue;
      (approvalIsExpired(record, cutoffMs) ? evicted : live).push(record);
    }
    // Repairs can park a fresh request that the file did not hold yet.
    for (const [id, record] of touch.records) {
      if (!touch.order.includes(id)) live.push(record);
    }
    const at = now().toISOString();
    for (const record of evicted) {
      if (expiresBeforeEviction(record)) {
        await touch.log(record, { event: "expire", at, surface: record.surface, reason: "ttl" });
      }
      await touch.log(record, { event: "evict", at, surface: record.surface, reason: "ttl" });
    }
    try {
      await seam.beforeRewrite?.();
      const body = live.map((a) => JSON.stringify(a)).join("\n");
      const abs = approvalsFilePath(rootDir);
      const written = writeFileSafe(
        dirname(abs),
        basename(abs),
        body.length > 0 ? `${body}\n` : "",
        {
          overwrite: true,
          mode: 0o600,
        },
      );
      if (!written.ok) throw refusal("write", "the approvals log", written);
    } catch (err) {
      // The log lines are written; the next sweep drops the records again.
      console.error("session-store: approvals compaction failed", err);
    }
    return { evictedIds: evicted.map((r) => r.id), live };
  });
}
