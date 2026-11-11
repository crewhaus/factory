/**
 * Who may decide a tool approval in a harness, read from the harness's own
 * approver projection (`.crewhaus/run/control/approvers.json`).
 *
 *  - No projection: single-owner mode. Anyone who can reach the store decides,
 *    as before, and no principal is recorded.
 *  - A projection: the harness has an owner, and the local user deciding here is
 *    that owner. The decision is recorded as the owner's (`decidedByPrincipal`),
 *    and a supersede is allowed (the owner is above maintainer).
 *  - A projection that cannot be read: nothing is decided until it is rewritten
 *    with `crewhaus access sync`.
 *
 * Principal-aware authorization, which tells the members of a harness apart,
 * replaces this authorizer.
 */
import { type ApproverRead, readApproverProjection } from "@crewhaus/control-records";
import type { ApprovalAuthorizer } from "./decide";

export function ownerAuthorizer(
  harnessDir: string,
  reader: (harnessDir: string) => ApproverRead = readApproverProjection,
): ApprovalAuthorizer {
  return () => {
    const read = reader(harnessDir);
    if (read.state === "absent") return { ok: true };
    if (read.state === "present") return { ok: true, principal: read.projection.owner };
    return {
      ok: false,
      reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
    };
  };
}
