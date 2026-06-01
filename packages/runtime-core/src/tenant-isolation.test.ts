import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildTenant, withTenant } from "@crewhaus/tenancy";
import { resolveSessionRootDir, resolveToolResultRoot } from "./index";

// Regression — issue #142 (CWE-1230). The managed daemon wraps every gateway
// request in `withTenant(...)`; runtime-core must resolve its session/event-log
// root from that ambient tenant context so two tenants' transcripts never share
// a directory. These tests pin the resolution contract directly (no model loop).

const ENV_KEYS = ["CREWHAUS_SESSION_DIR"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveSessionRootDir — tenant isolation (#142)", () => {
  test("each tenant resolves to its own disjoint sessionRoot", () => {
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-tenant-test" });
    const b = buildTenant("tenant-b", { tenantsRoot: "/tmp/ch-tenant-test" });

    const rootA = withTenant(a, () => resolveSessionRootDir(undefined)) as string;
    const rootB = withTenant(b, () => resolveSessionRootDir(undefined)) as string;

    expect(rootA).toBe(a.sessionRoot);
    expect(rootB).toBe(b.sessionRoot);
    expect(rootA).not.toBe(rootB);
    // Neither tenant's transcripts can land under the other's root.
    expect(rootA.startsWith(`${rootB}/`)).toBe(false);
    expect(rootB.startsWith(`${rootA}/`)).toBe(false);
  });

  test("does NOT fall back to the global default inside a tenant scope", () => {
    process.env["CREWHAUS_SESSION_DIR"] = "/tmp/GLOBAL-shared";
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-tenant-test" });
    const root = withTenant(a, () => resolveSessionRootDir(undefined)) as string;
    expect(root).toBe(a.sessionRoot);
    expect(root).not.toBe("/tmp/GLOBAL-shared");
  });

  test("outside any tenant scope, honours env then undefined (unchanged behaviour)", () => {
    expect(resolveSessionRootDir(undefined)).toBeUndefined();
    process.env["CREWHAUS_SESSION_DIR"] = "/tmp/env-root";
    expect(resolveSessionRootDir(undefined)).toBe("/tmp/env-root");
  });

  test("an explicit per-call root still wins (trusted caller override)", () => {
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-tenant-test" });
    const root = withTenant(a, () => resolveSessionRootDir("/tmp/explicit")) as string;
    expect(root).toBe("/tmp/explicit");
  });
});

// Regression — issue #150 (CWE-1230). The tool-result spill store must be
// rebased per tenant too, not just the session store.
describe("resolveToolResultRoot — tenant isolation (#150)", () => {
  test("each tenant resolves to its own toolResultRoot, disjoint", () => {
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-tenant-test" });
    const b = buildTenant("tenant-b", { tenantsRoot: "/tmp/ch-tenant-test" });
    const rootA = withTenant(a, () => resolveToolResultRoot()) as string;
    const rootB = withTenant(b, () => resolveToolResultRoot()) as string;
    expect(rootA).toBe(a.toolResultRoot);
    expect(rootB).toBe(b.toolResultRoot);
    expect(rootA).not.toBe(rootB);
  });

  test("outside a tenant scope, returns undefined (tool-result-store default applies)", () => {
    expect(resolveToolResultRoot()).toBeUndefined();
  });
});
