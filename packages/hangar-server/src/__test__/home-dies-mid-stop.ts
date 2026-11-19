/**
 * A Home that dies between persisting a stop and its effect: run as a child `bun` process by
 * `cross-surface.test.ts`, never imported.
 *
 * It boots Home over the root its environment names, with a process seam that reports one
 * adopted, live daemon. The stop's effect is the signal, so the seam's `terminate` appends a
 * line to the `reached` marker and then blocks this process for good, recording no effect:
 * the parent kills it there, after the receipt is persisted and before the effect ran.
 *
 * Environment: `HOME_DIES_ROOT` (the workspace, holding `hangar` and `registry`),
 * `HOME_DIES_REACHED` (the marker), `HOME_DIES_READY` (where Home's address is written),
 * `HOME_DIES_PID` and `HOME_DIES_START` (the daemon the seam reports alive).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { ProcessOps, SpawnedProcess } from "@crewhaus/harness-supervisor";
import { createProcessLayer } from "../process";
import { startHangarServer } from "../server";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const root = required("HOME_DIES_ROOT");
const reached = required("HOME_DIES_REACHED");
const ready = required("HOME_DIES_READY");
const daemonPid = Number(required("HOME_DIES_PID"));
const daemonStart = Number(required("HOME_DIES_START"));

const ops: ProcessOps = {
  platform: "posix",
  spawn: () =>
    ({
      pid: 7_001,
      exited: new Promise(() => undefined),
      write: () => undefined,
      closeStdin: () => undefined,
      unref: () => undefined,
    }) as unknown as SpawnedProcess,
  isAlive: (pid) => pid === daemonPid,
  startTimeMs: (pid) => (pid === daemonPid ? daemonStart : undefined),
  commandLine: () => undefined,
  terminate: (pid) => {
    appendFileSync(reached, `${pid}\n`);
    // The process dies here: nothing after the signal's call ever runs.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
  forceKill: () => undefined,
};

const env = {
  CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
  CREWHAUS_WATCHME_ROOT: join(root, "watchme"),
};
const processLayer = createProcessLayer({
  registry: openHangarRegistry({ root: join(root, "registry"), env }),
  env,
  now: Date.now,
  onWarn: () => undefined,
  hangarRoot: join(root, "hangar"),
  managerVersion: "test",
  ops,
  noPreflight: true,
  pumpIntervalMs: 10,
  runJob: () => new Promise(() => undefined),
});
const server = startHangarServer({
  port: 0,
  root: join(root, "hangar"),
  registryRoot: join(root, "registry"),
  env,
  processLayer,
  onWarn: () => undefined,
});
await server.ready;
writeFileSync(ready, JSON.stringify({ url: server.url, token: server.token }));
