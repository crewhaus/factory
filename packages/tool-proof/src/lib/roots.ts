/**
 * Where the proof tools file artifacts and read session logs, tenant-aware
 * (design §5.3, §8: proofs are tenant-fenced on the managed shape).
 *
 * Outside a tenant scope the proofs root is provability's
 * `proofsRoot(workspaceRoot, spec)`, `<cwd>/.crewhaus/proofs/<spec>`. Every
 * managed turn runs inside its request's `withTenant`, and there the
 * tenant's root stands where `.crewhaus/` does: `<tenantRoot>/proofs/<spec>`,
 * beside the tenant's sessions, tool results and state. One tenant's claims,
 * statements and proofs then never share a directory with another's, and a
 * preflight reads only its own tenant's artifacts. The tenant's root is the
 * parent of its `sessionRoot`, the rule continuity-store and wiki-store
 * fence by.
 *
 * Under a tenant, any root the tools would use — a caller's explicit
 * `proofsRoot` or `sessionRootDir` included — that resolves outside the
 * tenant's root fails closed (`TenancyError`, CWE-1230), as every
 * tenant-aware store does. A tools instance built once with a fixed root
 * and shared by every tenant would otherwise pool them all.
 */
import { join, resolve } from "node:path";
import { proofsRoot } from "@crewhaus/provability";
import { type Tenant, assertSamePath } from "@crewhaus/tenancy";

/** A tenant's own root: the parent of its sessions, state and tool results. */
export function tenantRootOf(tenant: Tenant): string {
  return resolve(tenant.sessionRoot, "..");
}

/**
 * The proofs root for `specName`: `<tenantRoot>/proofs/<spec>` under a
 * tenant, `<workspaceRoot>/.crewhaus/proofs/<spec>` otherwise. The spec
 * name is checked by provability's rule either way.
 */
export function defaultProofsRoot(
  workspaceRoot: string,
  specName: string,
  tenant: Tenant | undefined,
): string {
  const plain = proofsRoot(workspaceRoot, specName);
  return tenant === undefined ? plain : join(tenantRootOf(tenant), "proofs", specName);
}

/**
 * The session-log root a preflight reads when nobody named one: the active
 * tenant's `sessionRoot`, else `CREWHAUS_SESSION_DIR` — runtime-core's
 * `resolveSessionRootDir` order, so the tools read where the runtime wrote.
 * Undefined leaves event-log's default (`.crewhaus/sessions`).
 */
export function defaultSessionRoot(tenant: Tenant | undefined): string | undefined {
  if (tenant !== undefined) return tenant.sessionRoot;
  const fromEnv = process.env["CREWHAUS_SESSION_DIR"];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

/** `dir`, resolved, after checking it lies inside the active tenant's root (when there is one). */
export function fenced(dir: string, tenant: Tenant | undefined): string {
  const abs = resolve(dir);
  if (tenant !== undefined) assertSamePath(abs, tenantRootOf(tenant));
  return abs;
}
