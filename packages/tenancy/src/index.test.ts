import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TenancyError,
  assertSamePath,
  buildTenant,
  currentTenantContext,
  requireTenant,
  validateTenantId,
  withTenant,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tenancy-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("validateTenantId", () => {
  test("accepts alphanumeric ids", () => {
    expect(() => validateTenantId("tenant-a")).not.toThrow();
    expect(() => validateTenantId("Acme_42")).not.toThrow();
    expect(() => validateTenantId("a")).not.toThrow();
  });

  test("rejects leading hyphen / underscore", () => {
    expect(() => validateTenantId("-bad")).toThrow(TenancyError);
    expect(() => validateTenantId("_bad")).toThrow(TenancyError);
  });

  test("rejects path-traversal characters", () => {
    expect(() => validateTenantId("../etc")).toThrow(TenancyError);
    expect(() => validateTenantId("a/b")).toThrow(TenancyError);
    expect(() => validateTenantId("a\\b")).toThrow(TenancyError);
  });

  test("rejects whitespace / nulls / overlong ids", () => {
    expect(() => validateTenantId("a b")).toThrow(TenancyError);
    expect(() => validateTenantId("a".repeat(70))).toThrow(TenancyError);
  });
});

describe("buildTenant", () => {
  test("rebases all per-tenant roots under the tenants root", () => {
    const t = buildTenant("acme", { tenantsRoot: tmp });
    expect(t.id).toBe("acme");
    expect(t.sessionRoot).toBe(join(tmp, "acme", "sessions"));
    expect(t.evalRoot).toBe(join(tmp, "acme", "evals"));
    expect(t.toolResultRoot).toBe(join(tmp, "acme", "tool-results"));
    expect(t.auditRoot).toBe(join(tmp, "acme", "audit"));
  });

  test("applies overrides", () => {
    const t = buildTenant("acme", {
      tenantsRoot: tmp,
      overrides: { acme: { sessionRoot: "/srv/custom" } },
    });
    expect(t.sessionRoot).toBe("/srv/custom");
    // Other roots still default.
    expect(t.evalRoot).toBe(join(tmp, "acme", "evals"));
  });
});

describe("withTenant + AsyncLocalStorage", () => {
  test("requireTenant returns the active tenant inside withTenant", async () => {
    const t = buildTenant("acme", { tenantsRoot: tmp });
    await withTenant(t, async () => {
      expect(requireTenant().id).toBe("acme");
    });
  });

  test("requireTenant throws outside of withTenant", () => {
    expect(() => requireTenant()).toThrow(TenancyError);
  });

  test("currentTenantContext returns undefined outside", () => {
    expect(currentTenantContext()).toBeUndefined();
  });

  test("nested withTenant overrides the outer", async () => {
    const a = buildTenant("acme", { tenantsRoot: tmp });
    const b = buildTenant("bravo", { tenantsRoot: tmp });
    await withTenant(a, async () => {
      await withTenant(b, () => {
        expect(requireTenant().id).toBe("bravo");
      });
      expect(requireTenant().id).toBe("acme");
    });
  });

  test("async work inside withTenant retains the context across awaits", async () => {
    const t = buildTenant("acme", { tenantsRoot: tmp });
    await withTenant(t, async () => {
      await new Promise((r) => setTimeout(r, 10));
      expect(requireTenant().id).toBe("acme");
    });
  });
});

describe("assertSamePath (T8)", () => {
  test("accepts exact root match", () => {
    expect(() => assertSamePath("/srv/acme", "/srv/acme")).not.toThrow();
  });
  test("accepts a child path", () => {
    expect(() => assertSamePath("/srv/acme/sessions/abc", "/srv/acme")).not.toThrow();
  });
  test("rejects a sibling path", () => {
    expect(() => assertSamePath("/srv/bravo/sessions/abc", "/srv/acme")).toThrow(
      /cross-tenant access denied/,
    );
  });
  test("rejects a parent path", () => {
    expect(() => assertSamePath("/srv", "/srv/acme")).toThrow(TenancyError);
  });
  test("rejects an unrelated path", () => {
    expect(() => assertSamePath("/etc/passwd", "/srv/acme")).toThrow(TenancyError);
  });
  test("normalises ../ traversal before checking", () => {
    expect(() => assertSamePath("/srv/acme/../bravo/data", "/srv/acme")).toThrow(TenancyError);
  });
});
