/**
 * Where the gate reads and writes, resolved PER TURN for the tenant the turn
 * runs under (design §5.3, §8: bundles are tenant-fenced on managed).
 *
 * A managed daemon wires its gates once at boot, when no tenant exists, and
 * then serves every tenant from that one wiring — so nothing here is fixed at
 * wiring time. Each turn asks `@crewhaus/tenancy` for the active tenant and
 * resolves the proofs root (`<tenantRoot>/proofs/<spec>`, else
 * `<cwd>/.crewhaus/proofs/<spec>`) and the session-log root (the tenant's
 * `sessionRoot`, else `CREWHAUS_SESSION_DIR`, else event-log's default) with
 * the same functions `@crewhaus/tool-proof` uses — so a `ProofCheck` artifact
 * the tools file resolves at the gate, and the gate reads the logs the
 * runtime wrote (runtime-core's `resolveSessionRootDir` order).
 *
 * Under a tenant every resolved root must lie inside that tenant's root, or
 * the call fails closed (`TenancyError`, CWE-1230) — a caller-fixed root
 * shared across tenants would otherwise pool them.
 *
 * The proofs directory is named by {@link proofsDirName}, never by the raw
 * spec name: the spec schema admits names provability's store refuses.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { proofsRoot } from "@crewhaus/provability";
import { type Tenant, assertSamePath, currentTenantContext } from "@crewhaus/tenancy";
import { defaultProofsRoot, defaultSessionRoot, tenantRootOf } from "@crewhaus/tool-proof";

/** Whether provability's store files under `name` as it is (its own rule, asked, not copied). */
function filesAs(name: string): boolean {
  try {
    proofsRoot(".", name);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory a spec's proofs live in: `.crewhaus/proofs/<proofsDirName>/`.
 *
 * The spec schema's `name:` admits spaces and `:` (`support bot`,
 * `team:support`) and a dots-only name, while provability's store accepts
 * `[A-Za-z0-9_.-]+`, not dots only — the stricter rule, because the name is
 * a path segment there. Refusing such a name at wiring time would kill a
 * bundle that compiled warning-free (at boot on cli and managed, on every
 * turn on a channel bot), so it is mapped instead, here, in the one place
 * every proofs path is built from:
 *
 *   - a name the store accepts is its own directory, unchanged — every
 *     existing harness keeps its bundles where they are;
 *   - any other name becomes its safe characters (each run of others → `_`,
 *     `spec` if nothing is left) plus `-` and 12 hex digits of its sha256, so
 *     `support bot` and a spec literally named `support_bot` never share a
 *     directory, and the same name always maps to the same one.
 *
 * Exported for every reader of the proofs tree (`crewhaus provability`), so
 * they find what the gate filed.
 */
export function proofsDirName(specName: string): string {
  if (filesAs(specName)) return specName;
  const digest = createHash("sha256").update(specName, "utf8").digest("hex").slice(0, 12);
  const slug = specName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const mapped = `${/^\.*$/.test(slug) ? "spec" : slug}-${digest}`;
  return filesAs(mapped) ? mapped : `spec-${digest}`;
}

/** The tenant the current async context runs under, if any. */
export function activeTenant(): Tenant | undefined {
  return currentTenantContext()?.tenant;
}

/** `dir`, resolved, after checking it lies inside the tenant's root (when there is one). */
export function fencedDir(dir: string, tenant: Tenant | undefined): string {
  const abs = resolve(dir);
  if (tenant !== undefined) assertSamePath(abs, tenantRootOf(tenant));
  return abs;
}

/** The proofs root for `specName` (as {@link proofsDirName} maps it) under the given tenant (or none). */
export function gateProofsRoot(cwd: string, specName: string, tenant: Tenant | undefined): string {
  return fencedDir(defaultProofsRoot(cwd, proofsDirName(specName), tenant), tenant);
}

/**
 * The session-log root: the caller's (`deps.sessionRootDir`, which the
 * runtime was given too), else the tenant's / `CREWHAUS_SESSION_DIR`.
 * `undefined` means event-log's default (`.crewhaus/sessions`, relative to
 * the process cwd, exactly where runtime-core writes when given no root).
 */
export function gateSessionRoot(
  explicit: string | undefined,
  tenant: Tenant | undefined,
): string | undefined {
  const chosen = explicit ?? defaultSessionRoot(tenant);
  return chosen === undefined ? undefined : fencedDir(chosen, tenant);
}
