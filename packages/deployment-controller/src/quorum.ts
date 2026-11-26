/**
 * The protected-environment quorum as a decision people answer (#513, #517): a `dec_` of
 * kind `deploy-quorum`, opened when a promotion or an activation is blocked, and one vote
 * per person.
 *
 * - {@link openQuorumDecision} opens the decision for one version of one spec in one
 *   environment, once per version: asked again, it answers the one that is open.
 * - {@link recordQuorumVote} records one person's approve or deny. A vote is a claim named
 *   by the voter's digest, so a person votes once however often they ask. An approval also
 *   adds an entry to `.crewhaus/approvals/<spec>__<env>.json`, the file every release's
 *   gate reads, naming the version and the content it is for; a deny adds none. When the
 *   recorded approvals satisfy the environment's policy the decision is granted; a deny
 *   before that denies it.
 * - {@link settleQuorumDecision} closes it once a gated move went through.
 *
 * A vote is a person's: a service credential is refused, and on a harness with members
 * only a maintainer or the owner votes. Everything here happens under the harness's one
 * control lock, through its contained file primitives. Nothing here moves a pin.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  DEPLOY_QUORUM_KIND,
  type DeployQuorumSubject,
  isStoredActor,
  memberMayDecide,
  mintId,
} from "@crewhaus/control-contract";
import {
  DEPLOY_QUORUM_TTL_MS,
  type DeployQuorumRow,
  type LedgerRecord,
  casAppendLocked,
  createApproverReader,
  decisionsLedger,
  deployQuorumOf,
  deployQuorumState,
  publishClaim,
  readClaim,
  readDeployQuorums,
  readRecordFile,
  withLedgerLock,
} from "@crewhaus/control-records";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import {
  APPROVALS_RELDIR,
  type ApprovalDecision,
  approvalsFileName,
  decideApproval,
  loadEnvironmentsConfig,
  policyForEnv,
  readApprovals,
} from "./approval-gate";

/** An approvals file larger than this is not rewritten. */
export const APPROVALS_MAX_BYTES = 4 * 1024 * 1024;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const iso = (ms: number): string => new Date(ms).toISOString();

const sameSubject = (a: DeployQuorumSubject, b: DeployQuorumSubject): boolean =>
  a.spec === b.spec &&
  a.environment === b.environment &&
  a.version === b.version &&
  a.specHash === b.specHash;

/** Run under the harness's control lock; a lock that cannot be had is an answer, never a throw. */
async function locked<T>(
  harnessDir: string,
  run: () => Promise<T>,
): Promise<T | { readonly lockFailed: string }> {
  try {
    const answer = await withLedgerLock(decisionsLedger(harnessDir), run);
    if (
      typeof answer === "object" &&
      answer !== null &&
      (answer as { ok?: unknown }).ok === false &&
      "code" in answer &&
      "path" in answer
    ) {
      return { lockFailed: (answer as { reason: string }).reason };
    }
    return answer as T;
  } catch (err) {
    return { lockFailed: reasonOf(err) };
  }
}

/** The newest quorum for this subject that has not run out, whatever it answered. */
function liveQuorumFor(
  harnessDir: string,
  subject: DeployQuorumSubject,
  now: number,
): { readonly row?: DeployQuorumRow } | { readonly unreadable: string } {
  const read = readDeployQuorums(harnessDir);
  if (read.state === "unreadable") return { unreadable: read.reason };
  if (read.state === "absent") return {};
  const rows = read.rows
    .filter((row) => sameSubject(row.subject, subject))
    .filter((row) => {
      const state = deployQuorumState(row, now);
      return state === "pending" || state === "granted" || state === "denied";
    })
    // A deny stands until its decision would have run out: asking again does not undo it.
    .filter((row) => Date.parse(row.expiresAt) > now)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return rows[0] === undefined ? {} : { row: rows[0] };
}

export type OpenQuorumAnswer =
  | { readonly ok: true; readonly row: DeployQuorumRow; readonly opened: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Open the quorum's decision for one version, or answer the one that is there. A name or a
 * version that fits no command opens nothing: the gate still refuses, and says why.
 *
 * First consumers: the CLI's protected-environment gate and activation, when they refuse.
 */
export async function openQuorumDecision(
  harnessDir: string,
  subject: DeployQuorumSubject,
  opts: { readonly now: number },
): Promise<OpenQuorumAnswer> {
  const row: DeployQuorumRow = {
    id: mintId("dec", { now: opts.now }),
    kind: DEPLOY_QUORUM_KIND,
    createdAt: iso(opts.now),
    expiresAt: iso(opts.now + DEPLOY_QUORUM_TTL_MS),
    requiredClass: "maintainer",
    subject: {
      spec: subject.spec,
      environment: subject.environment,
      version: subject.version,
      specHash: subject.specHash,
    },
    state: "pending",
  };
  if (deployQuorumOf(row as unknown as LedgerRecord) === undefined) {
    return { ok: false, reason: "the spec, environment or version fits no decision" };
  }
  const answer = await locked<OpenQuorumAnswer>(harnessDir, async () => {
    const live = liveQuorumFor(harnessDir, row.subject, opts.now);
    if ("unreadable" in live) return { ok: false, reason: live.unreadable };
    if (live.row !== undefined) return { ok: true, row: live.row, opened: false };
    const cas = await casAppendLocked(
      decisionsLedger(harnessDir),
      row.id,
      null,
      row as unknown as LedgerRecord,
    );
    if (!cas.ok) return { ok: false, reason: cas.reason };
    if (!cas.applied) return { ok: false, reason: "the decision's id was taken" };
    return { ok: true, row, opened: true };
  });
  return "lockFailed" in answer ? { ok: false, reason: answer.lockFailed } : answer;
}

export type QuorumVote = {
  /** The voter, as a stored actor: a member's id, or a keyed digest of the local user. */
  readonly principal: string;
  /** The voter's name, as the approvals file shows it. */
  readonly display: string;
  readonly choice: "approve" | "deny";
  readonly service?: boolean;
  readonly now: number;
};

export type QuorumVoteAnswer =
  | {
      readonly outcome: "recorded";
      readonly row: DeployQuorumRow;
      readonly counted: readonly string[];
      readonly required: number;
    }
  | { readonly outcome: "already-voted"; readonly row: DeployQuorumRow }
  | { readonly outcome: "already-decided"; readonly row: DeployQuorumRow }
  | { readonly outcome: "expired"; readonly row: DeployQuorumRow }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "forbidden"; readonly reason: string }
  | { readonly outcome: "unavailable"; readonly reason: string };

/** The claim a person's vote on a decision takes. A stored actor is digested: it may hold `:`. */
export function quorumVoteClaim(dec: string, principal: string): string {
  const digest = createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 32);
  return `quorum-vote/${dec}.p${digest}`;
}

/**
 * Why this person may not vote, or `undefined` when they may: a stored actor, not a
 * service; on a harness with members, one whose class reaches maintainer now. A harness
 * with no list of members is a single owner's. Writes nothing.
 *
 * First consumers: {@link recordQuorumVote} and the inbox, before it asks for one.
 */
export function quorumVoterProblem(
  harnessDir: string,
  voter: { readonly principal: string; readonly service?: boolean },
  now: number,
): string | undefined {
  if (voter.service === true)
    return "a service credential never approves a deployment; a person does";
  if (!isStoredActor(voter.principal) || voter.principal.startsWith("sys:")) {
    return "only a person approves a deployment";
  }
  // Read now, never from a cache: a vote is rare, and a member may just have been removed.
  const read = createApproverReader()(harnessDir);
  if (read.state === "unreadable") {
    return `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``;
  }
  if (read.state === "absent") return undefined;
  return memberMayDecide(read.projection, voter.principal, "maintainer", now)
    ? undefined
    : "approving a deployment needs a maintainer";
}

/** The approvals file as it is, every entry kept whatever it holds; `[]` when there is none. */
function rawApprovals(
  harnessDir: string,
  rel: string,
): { readonly entries: readonly unknown[] } | { readonly reason: string } {
  const read = readRecordFile(harnessDir, rel, APPROVALS_MAX_BYTES);
  if (!read.ok) {
    return read.code === "not-found" ? { entries: [] } : { reason: read.reason };
  }
  if (read.truncated) return { reason: "the approvals file is too large to add to" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
  } catch {
    return { reason: "the approvals file is not valid JSON" };
  }
  return Array.isArray(parsed)
    ? { entries: parsed }
    : { reason: "the approvals file is not a JSON array" };
}

/** Whether the approvals file already holds this person's approval of this version. */
function holdsApproval(
  entries: readonly unknown[],
  principal: string,
  subject: DeployQuorumSubject,
): boolean {
  return entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      e["principal"] === principal &&
      e["specHash"] === subject.specHash &&
      e["version"] === subject.version
    );
  });
}

/** Add one approval to the file, whole, through a temp file and a rename; why it could not be. */
function addApproval(
  harnessDir: string,
  subject: DeployQuorumSubject,
  vote: QuorumVote,
): string | undefined {
  const rel = join(APPROVALS_RELDIR, approvalsFileName(subject.spec, subject.environment));
  const raw = rawApprovals(harnessDir, rel);
  if ("reason" in raw) return raw.reason;
  if (holdsApproval(raw.entries, vote.principal, subject)) return undefined;
  const entry = {
    approver: vote.display,
    ts: iso(vote.now),
    specHash: subject.specHash,
    // The version is always named, beside the content.
    version: subject.version,
    principal: vote.principal,
  };
  const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700 });
  if (!dir.ok) return dir.reason;
  const written = writeFileSafe(
    harnessDir,
    rel,
    `${JSON.stringify([...raw.entries, entry], null, 2)}\n`,
    { overwrite: true, mode: 0o600 },
  );
  return written.ok ? undefined : written.reason;
}

/** The quorum's count now, from the file every gate reads. */
function countNow(harnessDir: string, subject: DeployQuorumSubject): ApprovalDecision {
  return decideApproval({
    specName: subject.spec,
    toEnv: subject.environment,
    toVersion: subject.version,
    specHash: subject.specHash,
    policy: policyForEnv(loadEnvironmentsConfig(harnessDir), subject.environment),
    approvals: readApprovals(harnessDir, subject.spec, subject.environment),
  });
}

/**
 * Record one person's vote on a quorum decision, once. The first vote of a person counts;
 * asking again answers `already-voted`. A vote whose recording was cut short is finished
 * by asking again.
 *
 * First consumers: `crewhaus deploy approve` and the inbox.
 */
export async function recordQuorumVote(
  harnessDir: string,
  dec: string,
  vote: QuorumVote,
): Promise<QuorumVoteAnswer> {
  const problem = quorumVoterProblem(harnessDir, vote, vote.now);
  if (problem !== undefined) return { outcome: "forbidden", reason: problem };
  const answer = await locked<QuorumVoteAnswer>(harnessDir, async () => {
    const ledger = decisionsLedger(harnessDir);
    const read = readDeployQuorums(harnessDir);
    if (read.state === "unreadable") return { outcome: "unavailable", reason: read.reason };
    const row = read.state === "present" ? read.rows.find((r) => r.id === dec) : undefined;
    if (row === undefined) return { outcome: "not-found" };
    const state = deployQuorumState(row, vote.now);
    if (state === "expired") return { outcome: "expired", row };
    if (state !== "pending") return { outcome: "already-decided", row };
    // What the vote will count against is read before anything is written.
    try {
      countNow(harnessDir, row.subject);
    } catch (err) {
      return { outcome: "unavailable", reason: reasonOf(err) };
    }
    const claim = quorumVoteClaim(dec, vote.principal);
    const published = publishClaim(ledger, claim, {
      id: dec,
      principal: vote.principal,
      choice: vote.choice,
      at: iso(vote.now),
    });
    if (!published.ok) {
      if (published.code !== "exists") return { outcome: "unavailable", reason: published.reason };
      const held = readClaim(ledger, claim);
      if (!held.ok) return { outcome: "unavailable", reason: held.reason };
      // The same person asking the same again finishes a recording that was cut short.
      if (held.content.record["choice"] !== vote.choice) return { outcome: "already-voted", row };
      if (vote.choice === "approve") {
        const rel = join(
          APPROVALS_RELDIR,
          approvalsFileName(row.subject.spec, row.subject.environment),
        );
        const raw = rawApprovals(harnessDir, rel);
        if ("reason" in raw) return { outcome: "unavailable", reason: raw.reason };
        if (holdsApproval(raw.entries, vote.principal, row.subject)) {
          return { outcome: "already-voted", row };
        }
      }
    }
    if (vote.choice === "approve") {
      const failed = addApproval(harnessDir, row.subject, vote);
      if (failed !== undefined) return { outcome: "unavailable", reason: failed };
    }
    let count: ApprovalDecision;
    try {
      count = countNow(harnessDir, row.subject);
    } catch (err) {
      return { outcome: "unavailable", reason: reasonOf(err) };
    }
    const ended =
      vote.choice === "deny" ? "denied" : count.satisfied ? ("granted" as const) : undefined;
    if (ended === undefined) {
      return {
        outcome: "recorded",
        row,
        counted: count.countedApprovers,
        required: count.required,
      };
    }
    const next: DeployQuorumRow = {
      ...row,
      state: ended,
      decision: ended === "granted" ? "grant" : "deny",
      decidedAt: iso(vote.now),
      decidedByPrincipal: vote.principal,
    };
    const cas = await casAppendLocked(ledger, dec, "pending", next as unknown as LedgerRecord);
    if (!cas.ok) return { outcome: "unavailable", reason: cas.reason };
    if (!cas.applied) return { outcome: "already-decided", row };
    return {
      outcome: "recorded",
      row: next,
      counted: count.countedApprovers,
      required: count.required,
    };
  });
  return "lockFailed" in answer ? { outcome: "unavailable", reason: answer.lockFailed } : answer;
}

/**
 * Close a subject's decision once its gated move went through: a granted one is consumed,
 * and one still waiting (the gate was satisfied another way) is superseded. Answers whether
 * anything was written; a decision that cannot be written stays as it was.
 *
 * First consumers: the CLI's protected-environment gate and activation, when they pass.
 */
export async function settleQuorumDecision(
  harnessDir: string,
  subject: DeployQuorumSubject,
  opts: { readonly now: number },
): Promise<boolean> {
  // Nothing was ever asked here: no lock is taken and nothing is created.
  if (readDeployQuorums(harnessDir).state !== "present") return false;
  const answer = await locked<boolean>(harnessDir, async () => {
    const live = liveQuorumFor(harnessDir, subject, opts.now);
    if ("unreadable" in live || live.row === undefined) return false;
    const { row } = live;
    if (row.state !== "granted" && row.state !== "pending") return false;
    const next: DeployQuorumRow =
      row.state === "granted"
        ? { ...row, state: "consumed", consumedAt: iso(opts.now) }
        : { ...row, state: "superseded", supersededAt: iso(opts.now) };
    const cas = await casAppendLocked(
      decisionsLedger(harnessDir),
      row.id,
      row.state,
      next as unknown as LedgerRecord,
    );
    return cas.ok && cas.applied;
  });
  return answer === true;
}
