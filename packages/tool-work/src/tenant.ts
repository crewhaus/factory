/**
 * The one tenant whose runs reach the work list and the workspaces: both live in the harness
 * directory, so they are the harness's and Home's own, never a managed tenant's.
 */
import { currentTenantContext } from "@crewhaus/tenancy";

/**
 * The tenant Home's own runs serve on a managed daemon (the gateway's `HOME_RUN_TENANT`;
 * a control-service test pins the two equal). The only tenant whose runs reach the store.
 */
export const WORK_HOME_TENANT = "home";

/** Whether this call runs inside a tenant the harness's own records are not for. */
export function inManagedTenant(): boolean {
  const ctx = currentTenantContext();
  return ctx !== undefined && ctx.tenant.id !== WORK_HOME_TENANT;
}
