/**
 * Whether the local user may make a change only a harness's owner makes (a
 * protected criterion loosened, a lineage re-anchored over one), read from the
 * harness's approver projection (`.crewhaus/run/control/approvers.json`) the
 * way the approval store reads it:
 *
 *  - no projection: single-owner mode, so the local user is the owner;
 *  - a projection: the harness has an owner, and the local user acting here is
 *    that owner (`principal` names them for a record);
 *  - a projection that cannot be read: refused until `crewhaus access sync`
 *    rewrites it.
 *
 * Telling a harness's members apart is principal-aware authorization's job.
 */
import { type ApproverRead, readApproverProjection } from "@crewhaus/control-records";

export type OwnerCheck =
  | { readonly ok: true; readonly principal?: string }
  | { readonly ok: false; readonly reason: string };

export function ownerCheck(
  harnessDir: string,
  reader: (harnessDir: string) => ApproverRead = readApproverProjection,
): OwnerCheck {
  const read = reader(harnessDir);
  if (read.state === "absent") return { ok: true };
  if (read.state === "present") return { ok: true, principal: read.projection.owner };
  return {
    ok: false,
    reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
  };
}
