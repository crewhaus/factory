/**
 * One state tree, two heads, one command ledger: Home's Stop and `crewhaus daemon stop`
 * write their receipts to the same ledger in the harness, so each head sees what the
 * other did. Nothing is spawned: both heads share one fake `ProcessOps`.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { createProcessLayer, startHangarServer } from "@crewhaus/hangar-server";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { ProcessOps, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { runDaemonCommand } from "./daemon-cmd";

/** A `ProcessOps` that spawns nothing and knows no process. */
function quietOps(): ProcessOps {
  return {
    platform: "posix",
    spawn: () =>
      ({
        pid: 7_001,
        exited: new Promise(() => undefined),
        write: () => undefined,
        closeStdin: () => undefined,
        unref: () => undefined,
      }) as unknown as SpawnedProcess,
    isAlive: () => false,
    startTimeMs: () => undefined,
    commandLine: () => undefined,
    terminate: () => undefined,
    forceKill: () => undefined,
  };
}

describe("Home and the CLI share one command ledger", () => {
  test("a stop from each head: two receipts, one ledger, via home and via cli", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "two-heads-")));
    const registryRoot = join(root, "registry");
    const hangarRoot = join(root, "hangar");
    const dir = join(root, "harness");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "daemon.ts"), "// compiled bundle\n");
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      [
        "name: two-heads",
        "target: channel",
        "agent:",
        "  model: anthropic/claude-sonnet-4",
        "  instructions: |",
        "    You are a fixture.",
        "",
      ].join("\n"),
    );
    const env = {
      CREWHAUS_REGISTRY_ROOT: registryRoot,
      CREWHAUS_WATCHME_ROOT: join(root, "watchme"),
    };
    const entry = openHangarRegistry({ root: registryRoot, env }).upsert({
      dir,
      specName: "two-heads",
      target: "channel",
      origin: "manual",
      originDetail: "test",
    });
    const ops = quietOps();
    const processLayer = createProcessLayer({
      registry: openHangarRegistry({ root: registryRoot, env }),
      env,
      now: Date.now,
      onWarn: () => undefined,
      hangarRoot,
      managerVersion: "test",
      ops,
      noPreflight: true,
      runJob: () => new Promise(() => undefined),
    });
    const server = startHangarServer({
      port: 0,
      root: hangarRoot,
      registryRoot,
      env,
      processLayer,
      onWarn: () => undefined,
    });
    try {
      await server.ready;
      const res = await fetch(`${server.url}/api/h/${entry.id}/proc/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);
      const out = await runDaemonCommand(["stop", dir], { env, ops, cwd: dir });
      expect(out.exitCode).toBe(0);

      const fold = foldStates(commandsLedgerOf(dir));
      if (!fold.ok) throw new Error(fold.reason);
      const receipts = [...fold.objects.values()].map((o) => o.record);
      expect(receipts.map((r) => r["via"])).toEqual(["home", "cli"]);
      expect(receipts.map((r) => r["kind"])).toEqual(["controls.stop", "controls.stop"]);
      // Both heads name the harness the same way: the CLI finds its registry id by dir.
      expect(receipts.map((r) => r["target"])).toEqual([
        `home/harness/${entry.id}`,
        `home/harness/${entry.id}`,
      ]);
      expect(receipts.every((r) => r["state"] === "succeeded")).toBe(true);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
