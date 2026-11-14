/**
 * Who may decide a tool approval in a harness, read from the harness's own approver
 * projection (`.crewhaus/run/control/approvers.json`) and the principal the surface
 * signed the person in as.
 *
 *  - No projection: single-owner mode. Anyone who can reach the store decides, and the
 *    principal, when the surface has one, is recorded; a service principal decides only
 *    `operator` requests.
 *  - A projection: a decision counts only from a member whose class reaches the class
 *    the request needs (`memberMayDecide`), or from the owner. It is recorded as that
 *    member (`decidedByPrincipal`). A request with no principal is refused, and so is a
 *    service principal on anything above `operator`. A refusal names the class needed,
 *    never who has it.
 *  - A projection that cannot be read: nothing is decided until it is rewritten with
 *    `crewhaus access sync`.
 *
 * A service principal decides `operator` requests only, with a projection, without one,
 * and while one cannot be read.
 *
 * It imports nothing from access-control, so a compiled channel daemon can call it.
 */
import { type DecisionClass, memberMayDecide } from "@crewhaus/control-contract";
import { type ApproverRead, readApproverProjection } from "@crewhaus/control-records";
import type { ApprovalAuthorizer } from "./decide";

/** Who is asking: the member a surface signed in, and whether it is a service. */
export type ApprovalPrincipal = {
  /** The `prn_` the surface authenticated. Absent: nobody it can name. */
  readonly principal?: string;
  /** The principal is a service, which never decides above `operator`. */
  readonly service?: true;
};

/** What a person with no principal is told on a harness with members. */
export const NO_PRINCIPAL_REASON =
  "Decisions on this harness are made by its members. Sign in to Home, or ask its owner.";

/** The fixed refusal for a class the asker does not reach. */
export function needsClassReason(requiredClass: DecisionClass): string {
  if (requiredClass === "owner") return "Needs the owner.";
  return requiredClass === "maintainer" ? "Needs a maintainer." : "Needs an operator.";
}

export function principalAuthorizer(
  harnessDir: string,
  who: ApprovalPrincipal,
  opts: {
    readonly reader?: (harnessDir: string) => ApproverRead;
    readonly now?: () => number;
  } = {},
): ApprovalAuthorizer {
  const reader = opts.reader ?? readApproverProjection;
  const now = opts.now ?? (() => Date.now());
  return ({ requiredClass }) => {
    if (who.service === true && requiredClass !== "operator") {
      return { ok: false, reason: needsClassReason(requiredClass) };
    }
    const read = reader(harnessDir);
    if (read.state === "absent") {
      return who.principal !== undefined ? { ok: true, principal: who.principal } : { ok: true };
    }
    if (read.state === "unreadable") {
      return {
        ok: false,
        reason: `this harness's list of who may approve cannot be read (${read.reason}); rewrite it with \`crewhaus access sync\``,
      };
    }
    if (who.principal === undefined) return { ok: false, reason: NO_PRINCIPAL_REASON };
    return memberMayDecide(read.projection, who.principal, requiredClass, now())
      ? { ok: true, principal: who.principal }
      : { ok: false, reason: needsClassReason(requiredClass) };
  };
}
