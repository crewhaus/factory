/**
 * Port availability. A daemon that cannot bind its port dies immediately
 * after spawn with an EADDRINUSE stack trace; checking first turns that
 * into a typed, actionable item.
 *
 * The check binds a throwaway listener on the port and releases it — the
 * standard free-port probe. It is inherently approximate (another process
 * can take the port between check and spawn), which is fine for a
 * preflight: the spawn path still owns the authoritative bind.
 */

import { createServer } from "node:net";
import type { PreflightItem } from "./types";

export type PortStatus = {
  readonly port: number;
  readonly free: boolean;
  /** OS detail when not free (e.g. the error code). */
  readonly detail?: string;
};

export type PortChecker = (port: number) => Promise<PortStatus>;

/**
 * True-up whether `port` is currently bindable on `host` (default
 * 127.0.0.1 — the bind daemons and the control listener default to).
 */
export function checkPortFree(port: number, host = "127.0.0.1"): Promise<PortStatus> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve({
        port,
        free: false,
        detail: err.code ?? err.message,
      });
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve({ port, free: true }));
    });
  });
}

/** A port to check, with the source that requested it (spec field, env
 *  var, allocator) so the item message says WHY the port matters. */
export type PortRequest = { readonly port: number; readonly source: string };

/**
 * The ports area of the report: one item per requested port — blocking
 * when taken (the daemon's bind will fail), info when free. `check` is
 * injectable for tests and for managers that consult their own port
 * ledger instead of the OS.
 */
export async function portItems(
  requests: readonly PortRequest[],
  check: PortChecker = checkPortFree,
): Promise<PreflightItem[]> {
  const items: PreflightItem[] = [];
  const seen = new Set<number>();
  for (const { port, source } of requests) {
    if (seen.has(port)) continue;
    seen.add(port);
    const status = await check(port);
    items.push(
      status.free
        ? {
            id: `ports.${port}`,
            area: "ports",
            level: "info",
            message: `port ${port} (${source}) is free`,
          }
        : {
            id: `ports.${port}`,
            area: "ports",
            level: "blocking",
            message: `port ${port} (${source}) is already in use${status.detail !== undefined ? ` (${status.detail})` : ""} — the daemon cannot bind it`,
            remediation: "stop the process holding the port, or configure a different one",
          },
    );
  }
  return items;
}
