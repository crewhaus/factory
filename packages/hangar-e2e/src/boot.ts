/**
 * Start Home in this process, over a seeded fleet, through its public surface.
 * Notifications go to recording sinks, so no OS toast fires, and the server gets
 * an explicit environment that never spreads this process's.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Delivery,
  type HangarServer,
  type ProcessLayerOptions,
  createProcessLayer,
  startHangarServer,
} from "@crewhaus/hangar-server";
import { hangarAssets } from "@crewhaus/hangar-ui";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { Fleet } from "./seed/fleet";
import type { HomeAddress } from "./session";

export type RecordedNotifications = {
  readonly os: Delivery[];
  readonly webhook: Array<{ readonly delivery: Delivery; readonly url: string }>;
};

export type BootHomeOptions = {
  /** Supervision over these ops rather than real children. */
  readonly ops?: ProcessLayerOptions["ops"];
  readonly clock?: ProcessLayerOptions["clock"];
  readonly runJob?: ProcessLayerOptions["runJob"];
  /** Variables added to the server's environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
};

export type Home = HomeAddress & {
  readonly port: number;
  /** Where this Home looks for installed plugins (empty until a journey installs one). */
  readonly pluginsDir: string;
  /** Home's own root, where its control records (plugin grants among them) live. */
  readonly hangarRoot: string;
  readonly fleet: Fleet;
  readonly notifications: RecordedNotifications;
  readonly server: HangarServer;
  stop(): Promise<void>;
};

/** Boot Home on an OS-assigned loopback port. */
export function bootHome(fleet: Fleet, opts: BootHomeOptions = {}): Home {
  const scratch = mkdtempSync(join(tmpdir(), "hangar-e2e-home-"));
  const root = join(scratch, "hangar");
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd, { recursive: true });
  const env: Record<string, string> = { ...fleet.env, ...opts.env };
  const now = opts.now ?? Date.now;
  const notifications: RecordedNotifications = { os: [], webhook: [] };
  const onWarn = (): void => {};

  const processLayer =
    opts.ops === undefined
      ? undefined
      : createProcessLayer({
          registry: openHangarRegistry({ root: fleet.registryRoot, env, now, onWarn }),
          env,
          now,
          onWarn,
          hangarRoot: root,
          managerVersion: "e2e",
          noPreflight: true,
          ops: opts.ops,
          ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
          ...(opts.runJob !== undefined ? { runJob: opts.runJob } : {}),
        });

  const pluginsDir = join(scratch, "plugins");
  const server = startHangarServer({
    port: 0,
    root,
    registryRoot: fleet.registryRoot,
    assets: hangarAssets,
    pluginsDir,
    cwd,
    env,
    now,
    onWarn,
    notificationSinks: {
      os: (delivery) => {
        notifications.os.push(delivery);
      },
      webhook: (delivery, url) => {
        notifications.webhook.push({ delivery, url });
      },
    },
    ...(processLayer !== undefined ? { processLayer } : {}),
  });
  const { bootPath, token } = server;
  if (bootPath === undefined || token === undefined) {
    throw new Error("Home booted without auth, which no journey asks for");
  }

  return {
    url: server.url,
    port: server.port,
    pluginsDir,
    hangarRoot: root,
    bootPath,
    token,
    fleet,
    notifications,
    server,
    stop: async () => {
      await server.stop();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
