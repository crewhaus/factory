#!/usr/bin/env bun
/**
 * Test fixture: a miniature manager, for the one thing a fake cannot prove —
 * that a manager process actually EXITS while supervised children are alive.
 *
 * It supervises two real children at once:
 *
 *   - a DAEMON (`long-sleeper.ts`, detached, own log fd, runfile written) —
 *     which must SURVIVE this process and stay adoptable;
 *   - an ATTACHED interactive run (`ignore-sigterm.ts`, piped stdio) — which
 *     must NOT survive, and whose pipes are exactly what kept the real
 *     manager's event loop open after `server.stop()`.
 *
 * On SIGTERM it runs `runManagerShutdown` and then simply RETURNS. There is
 * no `process.exit()` here on purpose: if the shutdown failed to reach the
 * attached child, this process stays alive and the test times out — which is
 * the bug, reproduced.
 *
 * Argv: `<daemonHarnessDir> <attachedHarnessDir> <statusFile>`.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createPosixProcessOps } from "../src/process-ops";
import { runManagerShutdown, shutdownReportLines } from "../src/shutdown";
import type { SpawnPlan } from "../src/spawn-contracts";
import { createHarnessSupervisor } from "../src/supervisor";

const [daemonDir, attachedDir, statusFile] = process.argv.slice(2);
if (daemonDir === undefined || attachedDir === undefined || statusFile === undefined) {
  throw new Error("usage: mini-manager.ts <daemonDir> <attachedDir> <statusFile>");
}

const FIXTURES = import.meta.dir;
const say = (line: string): void => appendFileSync(statusFile, `${line}\n`);

function plan(dir: string, fixture: string, over: Partial<SpawnPlan>): SpawnPlan {
  return {
    runClass: "daemon",
    kind: "daemon",
    argv: [process.execPath, join(FIXTURES, fixture)],
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "" },
    envFiles: [],
    overrides: [],
    detached: true,
    stdio: "file",
    launchMode: "compiled",
    canResume: false,
    supervised: true,
    entry: fixture,
    bundleDir: FIXTURES,
    ports: {},
    ...over,
  } as SpawnPlan;
}

const ops = createPosixProcessOps();

const daemon = createHarnessSupervisor({
  harnessDir: daemonDir,
  target: "channel",
  ops,
  pumpIntervalMs: 25,
  plan: () => plan(daemonDir, "long-sleeper.ts", {}),
});

const attached = createHarnessSupervisor({
  harnessDir: attachedDir,
  target: "cli",
  ops,
  pumpIntervalMs: 25,
  plan: () =>
    plan(attachedDir, "ignore-sigterm.ts", {
      runClass: "interactive",
      kind: "interactive",
      supervised: false,
      detached: false,
      stdio: "pipe",
    }),
});

// Wait until the pump has CONSUMED the daemon's banner before declaring
// ourselves up: the persisted cursor then sits past that line, so the test
// can prove the next manager resumes the log instead of replaying it.
let daemonSpoke = false;
daemon.subscribe((event) => {
  if (event.type === "output" && event.prose.includes("fixture: pid")) daemonSpoke = true;
});

await daemon.start();
await attached.start();

process.on("SIGTERM", () => {
  void (async () => {
    const report = await runManagerShutdown({
      supervisors: [daemon, attached],
      graceMs: 400,
      deadlineMs: 8_000,
    });
    for (const line of shutdownReportLines(report)) say(`report: ${line}`);
    say("down");
    // No process.exit(): returning here is the assertion.
  })();
});

for (let i = 0; i < 400; i += 1) {
  if (daemonSpoke && attached.snapshot().state === "running") break;
  await Bun.sleep(25);
}
say(`up ${daemon.snapshot().pid ?? 0} ${attached.snapshot().pid ?? 0}`);
