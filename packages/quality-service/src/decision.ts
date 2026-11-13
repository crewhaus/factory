/**
 * The decision a passing check opens: a `dec_` of kind `change-adoption` in the
 * harness's decisions ledger, bound to the change, its patch, its base revision and its
 * evidence by a keyed digest. A maintainer decides it, or the owner when the change
 * touches a protected bar, the intent or a security surface; it is decided through the
 * decision service (`crewhaus approvals grant|deny <dec_>`), and a grant applies
 * nothing: adopting is the change's own command.
 */
import { mintId } from "@crewhaus/control-contract";
import {
  type ChangeAdoptionRow,
  type LedgerRecord,
  PROPOSAL_TTL_MS,
  casAppend,
  decisionsLedger,
  readChangeAdoptions,
} from "@crewhaus/control-records";
import { BINDING_DIGEST_LABEL, digestKeyOf, keyedJsonDigest } from "./digests";
import { type ChangeRow, moveChange } from "./store";
import { requiredClassFor } from "./touches";

/** What a decision is bound to, from a checked change. */
export function subjectOf(row: ChangeRow): ChangeAdoptionRow["subject"] | undefined {
  if (row.evidenceDigest === undefined) return undefined;
  return {
    chg: row.id,
    patchDigest: row.patchDigest,
    baseRevision: row.base.revision,
    evidenceDigest: row.evidenceDigest,
  };
}

/** The binding digest of a subject, under the harness's key. */
export async function bindingDigestOf(
  harnessDir: string,
  subject: ChangeAdoptionRow["subject"],
  label: string = BINDING_DIGEST_LABEL,
): Promise<string> {
  return keyedJsonDigest(await digestKeyOf(harnessDir), label, subject);
}

export type OpenDecisionAnswer =
  | { readonly ok: true; readonly decision: string; readonly row: ChangeRow }
  | { readonly ok: false; readonly reason: string };

/** Open the adoption decision for a checked, passing change, and move it to
 *  `awaiting-decision`. */
export async function openAdoptionDecision(opts: {
  readonly harnessDir: string;
  readonly row: ChangeRow;
  readonly actor: string;
  readonly now: () => number;
  readonly bindingLabel?: string;
}): Promise<OpenDecisionAnswer> {
  const subject = subjectOf(opts.row);
  if (subject === undefined) return { ok: false, reason: "the change has no evidence to bind" };
  const nowMs = opts.now();
  const id = mintId("dec", { now: nowMs });
  const requiredClass = requiredClassFor(opts.row.touches);
  const decision: ChangeAdoptionRow = {
    id,
    kind: "change-adoption",
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + PROPOSAL_TTL_MS).toISOString(),
    requiredClass,
    subject,
    bindingDigest: await bindingDigestOf(opts.harnessDir, subject, opts.bindingLabel),
    proposedBy: opts.actor,
    state: "pending",
  };
  const cas = await casAppend(
    decisionsLedger(opts.harnessDir),
    id,
    null,
    decision as unknown as LedgerRecord,
  );
  if (!cas.ok) return { ok: false, reason: `the decision could not be written: ${cas.reason}` };
  if (!cas.applied) return { ok: false, reason: "the decision id was already taken" };
  const moved = await moveChange(opts.harnessDir, "checked", {
    ...opts.row,
    state: "awaiting-decision",
    at: new Date(nowMs).toISOString(),
    decision: id,
    requiredClass,
  });
  if (!moved.ok) return { ok: false, reason: moved.reason };
  return { ok: true, decision: id, row: moved.row };
}

/** One change-adoption decision by id, as its latest row says. */
export function readAdoptionDecision(
  harnessDir: string,
  id: string,
): ChangeAdoptionRow | undefined {
  const read = readChangeAdoptions(harnessDir);
  return read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
}

/** Move a decision from `from` to `next` through the ledger's compare-and-set. */
export async function moveDecision(
  harnessDir: string,
  from: ChangeAdoptionRow["state"],
  next: ChangeAdoptionRow,
): Promise<boolean> {
  const cas = await casAppend(
    decisionsLedger(harnessDir),
    next.id,
    from,
    next as unknown as LedgerRecord,
  );
  return cas.ok && cas.applied;
}
