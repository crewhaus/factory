/**
 * Recovery for the one workspace command a device sign-in writes: a member's choice to
 * allow or deny it. The choice runs inline and records the receipt's id on the request it
 * decided, so the reconcile sweep can tell whether it landed.
 */
import { openDeviceRequests } from "@crewhaus/access-control";
import type { Reconciler } from "./executor";

/**
 * `done` when a stored request names this receipt and its actor decided it; `unknown`
 * otherwise, since an expired request is dropped by the next writer and a missing row
 * proves nothing.
 */
export const reconcileDeviceDecide: Reconciler = (receipt, ctx) => {
  if (ctx.hangarRoot === undefined) return "unknown";
  const row = openDeviceRequests(ctx.hangarRoot)
    .read()
    .find((request) => request.decidedCmd === receipt.id);
  if (row === undefined) return "unknown";
  return row.decidedBy === receipt.actor ? "done" : "not-done";
};
