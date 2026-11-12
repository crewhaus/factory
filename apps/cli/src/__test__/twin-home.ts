/**
 * Home, booted in this process over temporary roots through the server's
 * public surface, for the command-line-equivalent sweep: an explicit
 * environment that never spreads this process's, recording notification
 * sinks (the defaults raise OS notifications), and a job runner that never
 * settles, so nothing a request queues ever runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Delivery,
  type HangarServer,
  createProcessLayer,
  startHangarServer,
} from "@crewhaus/hangar-server";
import { hangarAssets } from "@crewhaus/hangar-ui";
import { openHangarRegistry } from "@crewhaus/harness-registry";

export type TwinHome = {
  /** A directory to put fixture harnesses in. */
  readonly harnessesRoot: string;
  readonly server: HangarServer;
  readonly notifications: { readonly os: Delivery[]; readonly webhook: Delivery[] };
  api(
    path: string,
    init?: RequestInit,
  ): Promise<{ readonly status: number; readonly type: string; readonly body: unknown }>;
  stop(): Promise<void>;
};

export function bootTwinHome(now: () => number): TwinHome {
  const scratch = mkdtempSync(join(tmpdir(), "cli-twins-home-"));
  const root = join(scratch, "hangar");
  const registryRoot = join(scratch, "registry");
  const harnessesRoot = join(scratch, "harnesses");
  const cwd = join(scratch, "cwd");
  for (const dir of [harnessesRoot, cwd]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    HOME: scratch,
    CREWHAUS_WATCHME_ROOT: join(scratch, "watchme"),
    CREWHAUS_REGISTRY_ROOT: registryRoot,
    CREWHAUS_HANGAR_ROOT: root,
  };
  const onWarn = (): void => {};
  const notifications = { os: [] as Delivery[], webhook: [] as Delivery[] };
  const processLayer = createProcessLayer({
    registry: openHangarRegistry({ root: registryRoot, env, now, onWarn }),
    env,
    now,
    onWarn,
    hangarRoot: root,
    managerVersion: "test",
    noPreflight: true,
    runJob: () => new Promise<{ exitCode?: number }>(() => {}),
  });
  const server = startHangarServer({
    port: 0,
    root,
    registryRoot,
    assets: hangarAssets,
    pluginsDir: join(scratch, "plugins"),
    cwd,
    env,
    now,
    onWarn,
    processLayer,
    notificationSinks: {
      os: (delivery) => {
        notifications.os.push(delivery);
      },
      webhook: (delivery) => {
        notifications.webhook.push(delivery);
      },
    },
  });
  const token = server.token ?? "";
  return {
    harnessesRoot,
    server,
    notifications,
    api: async (path, init = {}) => {
      const res = await fetch(`${server.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
      });
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      let body: unknown = text;
      if (type.includes("json")) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: res.status, type, body };
    },
    stop: async () => {
      await server.stop();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
