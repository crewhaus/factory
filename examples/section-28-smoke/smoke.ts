#!/usr/bin/env bun
/**
 * Section 28 Deployment + canary + migration — end-to-end smoke.
 *
 * Five probes covering the wiring of spec-registry, ir-passes,
 * migration-engine/runner, deployment-controller, and canary-controller:
 *
 *   1. spec-registry — put/list/pin/alias round-trip + tenant overlay
 *   2. ir-passes — applyPasses removes a dead tool + idempotence
 *   3. migration-engine + runner — register a 0→1 migration; runner
 *      walks every spec in the registry; dry-run + write cycle
 *   4. deployment-controller — promote staging → prod with audit-log assertion
 *   5. canary-controller — 50% traffic split + auto-rollback on injected
 *      regression; audit-log records the rollback reason
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import { type RegressionGate, createCanaryController } from "@crewhaus/canary-controller";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import { applyPasses } from "@crewhaus/ir-passes";
import { createDefaultEngine } from "@crewhaus/migration-engine";
import { migrateAll } from "@crewhaus/migration-runner";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";

const log = (m: string): void => {
  process.stderr.write(`[smoke-28] ${m}\n`);
};
const fail = (m: string): never => {
  process.stderr.write(`[smoke-28] FAIL: ${m}\n`);
  process.exit(2);
};
const ok = (m: string): void => {
  process.stderr.write(`[smoke-28] ✓ ${m}\n`);
};

const main = async (): Promise<void> => {
  const tmpRoot = join(tmpdir(), `smoke28-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(tmpRoot, { recursive: true });

  try {
    // ────────── Probe 1: spec-registry ──────────
    {
      log("probe 1: spec-registry — put/list/pin/alias + tenant overlay");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
      await reg.put("hello", "v1", "name: hello\nversion: 0\n");
      await reg.put("hello", "v2", "name: hello\nversion: 0\n");
      const versions = [...(await reg.list("hello"))].sort();
      if (JSON.stringify(versions) !== JSON.stringify(["v1", "v2"])) {
        fail(`expected [v1, v2], got ${JSON.stringify(versions)}`);
      }
      await reg.pin("hello", "prod", "v1");
      await reg.pinForTenant("tenant-a", "hello", "prod", "v2");
      const globalProd = await reg.aliasFor("hello", "prod");
      const tenantProd = await reg.aliasForTenant("tenant-a", "hello", "prod");
      if (globalProd !== "v1") fail(`global prod expected v1, got ${globalProd}`);
      if (tenantProd !== "v2") fail(`tenant-a prod expected v2, got ${tenantProd}`);
      ok("spec-registry: put + list + pin + tenant overlay all work");
    }

    // ────────── Probe 2: ir-passes ──────────
    {
      log("probe 2: ir-passes — dead-tool elimination + idempotence");
      const ir = {
        version: 0,
        name: "x",
        target: "cli" as const,
        agent: { model: "claude-opus-4-7", instructions: "y" },
        tools: ["Read", "Write", "Bash"],
        toolConfigs: {},
        mcp_servers: {},
        permissions: {
          rules: [{ type: "alwaysAllow" as const, pattern: "Read" }],
        },
        subAgents: [],
        compaction: {},
      };
      const once = applyPasses(ir);
      const twice = applyPasses(once);
      const onceTools = (once as { tools: readonly string[] }).tools;
      if (!onceTools.includes("Read") || onceTools.includes("Write")) {
        fail(`ir-passes did not eliminate Write: ${JSON.stringify(onceTools)}`);
      }
      if (JSON.stringify(once) !== JSON.stringify(twice)) {
        fail("ir-passes is not idempotent");
      }
      ok("ir-passes: Write eliminated; double-apply matches single-apply");
    }

    // ────────── Probe 3: migration-engine + runner ──────────
    {
      log("probe 3: migration-engine + runner — 0→1 dry-run + apply");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "migrate") });
      await reg.put(
        "a",
        "v1",
        "name: a\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
      );
      await reg.put(
        "b",
        "v1",
        "name: b\ntarget: cli\nversion: 0\nagent:\n  model: x\n  instructions: y\n",
      );
      const engine = createDefaultEngine();
      const dry = await migrateAll({
        registry: reg,
        engine,
        fromVersion: 0,
        toVersion: 1,
        dryRun: true,
      });
      if (dry.migrated !== 2) fail(`dry-run plan: expected 2 migrated, got ${dry.migrated}`);
      const before = [...(await reg.list("a"))].sort();
      if (JSON.stringify(before) !== JSON.stringify(["v1"])) {
        fail(`dry-run wrote a new version: ${JSON.stringify(before)}`);
      }
      const real = await migrateAll({
        registry: reg,
        engine,
        fromVersion: 0,
        toVersion: 1,
      });
      if (real.migrated !== 2) fail(`expected 2 migrated, got ${real.migrated}`);
      const after = [...(await reg.list("a"))].sort();
      if (JSON.stringify(after) !== JSON.stringify(["v1", "v2"])) {
        fail(`expected [v1, v2] after migrate, got ${JSON.stringify(after)}`);
      }
      const replay = await migrateAll({
        registry: reg,
        engine,
        fromVersion: 0,
        toVersion: 1,
      });
      if (replay.migrated !== 0) fail(`expected idempotent re-run, got ${replay.migrated}`);
      ok("migration-engine + runner: dry-run, apply, idempotent re-run");
    }

    // ────────── Probe 4: deployment-controller ──────────
    {
      log("probe 4: deployment-controller — promote with audit-log");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "deploy") });
      const auditDir = join(tmpRoot, "deploy-audit");
      const audit = await openAuditLog({ rootDir: auditDir });
      await reg.put("hello", "v1", "x");
      await reg.put("hello", "v2", "y");
      await reg.pin("hello", "staging", "v2");
      const ctrl = createDeploymentController({
        registry: reg,
        auditLog: audit,
        actor: "smoke-test",
      });
      const rec = await ctrl.promote("hello", "staging", "prod");
      if (rec.toVersion !== "v2") fail(`expected promoted to v2, got ${rec.toVersion}`);
      const records: AuditRecord[] = [];
      for await (const r of audit.read()) records.push(r);
      if (records.length !== 1) fail(`expected 1 audit record, got ${records.length}`);
      if (records[0]?.kind !== "deployment_action") {
        fail(`expected kind deployment_action, got ${records[0]?.kind}`);
      }
      ok("deployment-controller: promote staging → prod + audit-log");
    }

    // ────────── Probe 5: canary-controller ──────────
    {
      log("probe 5: canary-controller — 50% traffic split + auto-rollback on regression");
      const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "canary") });
      await reg.put("hello", "v1", "x");
      await reg.put("hello", "v2", "y");
      await reg.pin("hello", "prod", "v2"); // canary already deployed
      const audit = await openAuditLog({ rootDir: join(tmpRoot, "canary-audit") });
      const deploy = createDeploymentController({ registry: reg });
      const ctrl = createCanaryController({
        registry: reg,
        deploymentController: deploy,
        auditLog: audit,
      });
      const config = { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent: 50 };
      let canary = 0;
      for (let i = 0; i < 100; i++) {
        if (ctrl.route(config, `req-${i}`).isCanary) canary++;
      }
      if (canary < 30 || canary > 70) {
        fail(`expected ~50% canary share over 100 requests, got ${canary}`);
      }
      const failingGate: RegressionGate = async () => ({
        verdict: "fail",
        reason: "pass-rate dropped from 0.95 to 0.62",
      });
      const result = await ctrl.evaluate(config, { intervalMs: 0, gate: failingGate });
      if (result.verdict !== "fail") fail("expected fail verdict");
      if (result.action !== "rollback") fail("expected auto-rollback action");
      const after = await reg.aliasFor("hello", "prod");
      if (after !== "v1") fail(`expected rollback to v1, got ${after}`);
      const records: AuditRecord[] = [];
      for await (const r of audit.read()) records.push(r);
      const rollback = records.find((r) => r.kind === "deployment_action");
      const reason = (rollback?.payload as { reason?: string })?.reason ?? "";
      if (!reason.includes("pass-rate dropped")) fail(`audit reason missing: ${reason}`);
      ok("canary-controller: hash routing distributes; failing gate auto-rolls-back");
    }

    log("all probes passed.");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  process.stderr.write(
    `[smoke-28] threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
