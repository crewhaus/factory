import { describe, expect, test } from "bun:test";
import { buildTenant, withTenant } from "@crewhaus/tenancy";
import { resolveEvalOutDir } from "./index";

// Regression — issue #150 (CWE-1230). Eval artifacts must land under the active
// tenant's evalRoot so one tenant's eval data never shares a directory with
// another's.
describe("resolveEvalOutDir — tenant isolation (#150)", () => {
  test("each tenant resolves under its own evalRoot, disjoint", () => {
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-eval-test" });
    const b = buildTenant("tenant-b", { tenantsRoot: "/tmp/ch-eval-test" });
    const outA = withTenant(a, () => resolveEvalOutDir("run1")) as string;
    const outB = withTenant(b, () => resolveEvalOutDir("run1")) as string;
    expect(outA.startsWith(`${a.evalRoot}/`)).toBe(true);
    expect(outB.startsWith(`${b.evalRoot}/`)).toBe(true);
    expect(outA).not.toBe(outB);
  });

  test("outside a tenant scope, uses the global default", () => {
    const out = resolveEvalOutDir("runX");
    expect(out).toContain(".crewhaus");
    expect(out).toContain("runX");
  });

  test("an explicit outDir always wins (trusted caller override)", () => {
    const a = buildTenant("tenant-a", { tenantsRoot: "/tmp/ch-eval-test" });
    const out = withTenant(a, () => resolveEvalOutDir("runX", "/tmp/explicit-out")) as string;
    expect(out).toBe("/tmp/explicit-out");
  });
});
