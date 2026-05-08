/**
 * Section 28 — `deployment-controller` tests:
 *  - T3 promote + rollback round-trip with audit-log assertions
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import { DeploymentError, createDeploymentController } from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "deploy-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function readAudit(rootDir: string): Promise<AuditRecord[]> {
  const log = await openAuditLog({ rootDir });
  const out: AuditRecord[] = [];
  for await (const r of log.read()) out.push(r);
  return out;
}

describe("deployment-controller — T3 promote/rollback", () => {
  test("promote copies pin from staging to prod", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "staging", "v2");
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const ctrl = createDeploymentController({ registry: reg, auditLog: audit, actor: "alice" });
    const rec = await ctrl.promote("hello", "staging", "prod");
    expect(rec.action).toBe("promote");
    expect(rec.toVersion).toBe("v2");
    expect(rec.fromVersion).toBeUndefined();
    expect(await reg.aliasFor("hello", "prod")).toBe("v2");
    const records = await readAudit(join(tmpRoot, "audit"));
    expect(records.length).toBe(1);
    expect(records[0]?.kind).toBe("deployment_action");
  });

  test("promote captures previous prod pin in fromVersion", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "staging", "v2");
    await reg.pin("hello", "prod", "v1");
    const ctrl = createDeploymentController({ registry: reg });
    const rec = await ctrl.promote("hello", "staging", "prod");
    expect(rec.fromVersion).toBe("v1");
    expect(rec.toVersion).toBe("v2");
  });

  test("rollback re-pins to a known prior version", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2");
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const ctrl = createDeploymentController({ registry: reg, auditLog: audit });
    const rec = await ctrl.rollback("hello", "prod", "v1");
    expect(rec.action).toBe("rollback");
    expect(rec.fromVersion).toBe("v2");
    expect(rec.toVersion).toBe("v1");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
  });

  test("promote without source pin throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    const ctrl = createDeploymentController({ registry: reg });
    expect(ctrl.promote("hello", "staging", "prod")).rejects.toBeInstanceOf(DeploymentError);
  });

  test("rollback to unknown version throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    const ctrl = createDeploymentController({ registry: reg });
    expect(ctrl.rollback("hello", "prod", "v999")).rejects.toBeInstanceOf(DeploymentError);
  });

  test("tenant-scoped controller writes only tenant overlay, not global", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "staging", "v2");
    await reg.pin("hello", "prod", "v1");
    const ctrl = createDeploymentController({ registry: reg, tenantId: "tenant-a" });
    await ctrl.promote("hello", "staging", "prod");
    // Global prod stays at v1; tenant-a overlay points to v2.
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    expect(await reg.aliasForTenant("tenant-a", "hello", "prod")).toBe("v2");
  });
});
