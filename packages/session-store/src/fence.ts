/**
 * The tenant fence every store path passes through. When a tenant context is
 * active, a resolved path outside the tenant's session root fails closed
 * (CWE-1230). Outside a tenant scope (the common CLI case) it is a no-op, so
 * behaviour without tenants is unchanged.
 */
import { assertSamePath, currentTenantContext, requireTenant } from "@crewhaus/tenancy";

export function fencePath(absPath: string): string {
  if (currentTenantContext() !== undefined) {
    assertSamePath(absPath, requireTenant().sessionRoot);
  }
  return absPath;
}
