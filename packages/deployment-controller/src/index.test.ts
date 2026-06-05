/**
 * Section 28 — `deployment-controller` tests:
 *  - T3 promote + rollback round-trip with audit-log assertions
 *  - tenant-scoped promote/rollback overlay isolation
 *  - audit-after-pin ordering + payload-shape regression guards (mocked)
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppendInput, AuditLog, AuditRecord } from "@crewhaus/audit-log";
import { openAuditLog } from "@crewhaus/audit-log";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
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

  test("tenant-scoped rollback re-pins only the tenant overlay and tags the record", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2"); // global prod = v2
    await reg.pinForTenant("tenant-a", "hello", "prod", "v2"); // tenant prod = v2
    const ctrl = createDeploymentController({
      registry: reg,
      tenantId: "tenant-a",
      actor: "bob",
    });
    const rec = await ctrl.rollback("hello", "prod", "v1");
    expect(rec.action).toBe("rollback");
    expect(rec.fromVersion).toBe("v2"); // previous tenant alias captured
    expect(rec.toVersion).toBe("v1");
    expect(rec.tenantId).toBe("tenant-a");
    expect(rec.actor).toBe("bob");
    // Global prod is untouched; only the tenant overlay rolled back.
    expect(await reg.aliasFor("hello", "prod")).toBe("v2");
    expect(await reg.aliasForTenant("tenant-a", "hello", "prod")).toBe("v1");
  });

  test("rollback with no prior pin omits fromVersion", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    // No pin for `prod` yet.
    const ctrl = createDeploymentController({ registry: reg });
    const rec = await ctrl.rollback("hello", "prod", "v1");
    expect(rec.fromVersion).toBeUndefined();
    expect(rec.toVersion).toBe("v1");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
  });

  test("promote audit payload carries tenantId + actor and the deployment_action kind", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.pin("hello", "staging", "v1");
    const appended: AppendInput[] = [];
    const auditLog: AuditLog = {
      append: mock(async (input: AppendInput): Promise<AuditRecord> => {
        appended.push(input);
        return {
          ts: 0,
          version: 1,
          kind: input.kind,
          seq: 0,
          payload: input.payload,
          prevHash: "",
          hash: "",
        };
      }),
      read: () => {
        throw new Error("read should not be called");
      },
    };
    const ctrl = createDeploymentController({
      registry: reg,
      auditLog,
      tenantId: "tenant-a",
      actor: "carol",
    });
    const rec = await ctrl.promote("hello", "staging", "prod");
    expect(appended.length).toBe(1);
    expect(appended[0]?.kind).toBe("deployment_action");
    expect(appended[0]?.payload).toBe(rec); // the exact record is audit-logged
    expect(rec.tenantId).toBe("tenant-a");
    expect(rec.actor).toBe("carol");
  });

  test("audit is appended only AFTER the registry pin succeeds (no misleading history)", async () => {
    const calls: string[] = [];
    const pinError = new Error("pin failed: storage down");
    // Minimal RegistryAdapter mock; only the methods promote() touches are real.
    const reg: RegistryAdapter = {
      aliasFor: mock(async (): Promise<string | undefined> => {
        calls.push("aliasFor");
        return "v2";
      }),
      pin: mock(async (): Promise<void> => {
        calls.push("pin");
        throw pinError;
      }),
      // Unused by this path — present to satisfy the interface.
      put: async () => {},
      get: async () => "",
      list: async () => [],
      listSpecs: async () => [],
      delete: async () => {},
      manifest: async () => ({ versions: [], pins: {} }),
      pinForTenant: async () => {},
      aliasForTenant: async () => undefined,
    };
    const auditAppend = mock(async (input: AppendInput): Promise<AuditRecord> => {
      calls.push("audit");
      return {
        ts: 0,
        version: 1,
        kind: input.kind,
        seq: 0,
        payload: input.payload,
        prevHash: "",
        hash: "",
      };
    });
    const auditLog: AuditLog = {
      append: auditAppend,
      read: () => {
        throw new Error("read should not be called");
      },
    };
    const ctrl = createDeploymentController({ registry: reg, auditLog });
    await expect(ctrl.promote("hello", "staging", "prod")).rejects.toBe(pinError);
    // The pin threw, so NO audit record was written for the failed deploy.
    expect(auditAppend).not.toHaveBeenCalled();
    expect(calls).toEqual(["aliasFor", "aliasFor", "pin"]);
  });
});
