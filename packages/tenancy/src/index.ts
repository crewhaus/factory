/**
 * Catalog R17 `tenancy` — per-tenant storage rebase + cross-tenant guard.
 *
 * The managed daemon (Section 20) routes every request through
 * `withTenant(tenantId, fn)` which:
 *
 *   1. Validates `tenantId` against `TENANT_ID_RE` so a malformed claim
 *      cannot become a path-traversal vector.
 *   2. Resolves a per-tenant root: `<tenantsRoot>/<tenantId>/`.
 *   3. Exposes that root via the AsyncLocalStorage-backed
 *      `currentTenantContext()` so downstream code (session-store,
 *      checkpoint-store, audit-log, tool-result-store) can rebase
 *      its own `rootDir`.
 *   4. Fences cross-tenant reads — `assertSamePath(absPath)` throws
 *      `TenancyError` if `absPath` is not under the active tenant's
 *      root. Storage adapters call this on every public method.
 *
 * The runtime carries the active tenant id through `RunContext.tenantId`;
 * tenancy itself stays loosely coupled to the wider runtime so it can
 * be unit-tested in isolation.
 *
 * Layer R17. Pairs with `gateway-server` (R16) and `audit-log` (R17).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve as resolvePath } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

const TENANT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_\-]{0,63}$/;

export class TenancyError extends CrewhausError {
  override readonly name = "TenancyError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type TenantBudget = {
  /** Cumulative tokens granted before runs.create returns 429. */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
};

export type Tenant = {
  readonly id: string;
  /** Path-rebased session-store root. */
  readonly sessionRoot: string;
  /** Path-rebased eval-store root. */
  readonly evalRoot: string;
  /** Path-rebased tool-result-store root. */
  readonly toolResultRoot: string;
  /** Per-tenant audit-log root. */
  readonly auditRoot: string;
  /** Per-tenant policy overrides (extends the global policy ruleset). */
  readonly policyOverrides: ReadonlyArray<{
    readonly toolName: string;
    readonly action: "allow" | "deny" | "audit";
  }>;
  readonly budget: TenantBudget;
};

export type TenantContext = {
  readonly tenant: Tenant;
};

const storage = new AsyncLocalStorage<TenantContext>();

export function validateTenantId(id: string): void {
  if (!TENANT_ID_RE.test(id)) {
    throw new TenancyError(
      `invalid tenantId "${id}" — expected alphanumeric / hyphen / underscore, max 64 chars, no leading separator`,
    );
  }
}

export type TenantOptions = {
  /** Filesystem root under which per-tenant subtrees live. */
  readonly tenantsRoot?: string;
  /** Optional overrides keyed by tenantId. */
  readonly overrides?: Readonly<Record<string, Partial<Tenant>>>;
};

const DEFAULT_BUDGET: TenantBudget = {
  maxInputTokens: 1_000_000,
  maxOutputTokens: 200_000,
};
const DEFAULT_TENANTS_ROOT = ".crewhaus/tenants";

export function buildTenant(id: string, opts: TenantOptions = {}): Tenant {
  validateTenantId(id);
  const root = resolvePath(opts.tenantsRoot ?? DEFAULT_TENANTS_ROOT, id);
  const override = opts.overrides?.[id] ?? {};
  return {
    id,
    sessionRoot: override.sessionRoot ?? resolvePath(root, "sessions"),
    evalRoot: override.evalRoot ?? resolvePath(root, "evals"),
    toolResultRoot: override.toolResultRoot ?? resolvePath(root, "tool-results"),
    auditRoot: override.auditRoot ?? resolvePath(root, "audit"),
    policyOverrides: override.policyOverrides ?? [],
    budget: override.budget ?? DEFAULT_BUDGET,
  };
}

/**
 * Run `fn` with `tenant` as the active context. Nested calls override
 * outer; the outer context is restored on return.
 */
export function withTenant<T>(tenant: Tenant, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run({ tenant }, fn);
}

export function currentTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenant(): Tenant {
  const ctx = storage.getStore();
  if (ctx === undefined) {
    throw new TenancyError("no active tenant — wrap the call in withTenant(tenant, fn)");
  }
  return ctx.tenant;
}

/**
 * Throw `TenancyError` if `absPath` is not contained within `expectedRoot`.
 * Used by storage adapters before every public read/write to fail-closed
 * on a cross-tenant path leak.
 */
export function assertSamePath(absPath: string, expectedRoot: string): void {
  const resolved = resolvePath(absPath);
  const root = resolvePath(expectedRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new TenancyError(`cross-tenant access denied: "${resolved}" is not under "${root}"`);
  }
}
