/**
 * The port ledger.
 *
 * Everything the manager can put on a port goes through here: daemon
 * webhook ports, spec `gateway.port`s, control.v1 ports, HTTP+SSE
 * mcp-servers, and spawned shape-UI hosts. Two independent facts have to
 * agree before a port is handed out:
 *
 *   1. **The OS says it is free** — a bind probe, because a port claimed by
 *      something outside this manager is just as taken.
 *   2. **The ledger says it is unclaimed** — because an adopted daemon's
 *      runfile declares ports that nothing is listening on YET (a daemon
 *      that is still booting), and because two allocations inside one
 *      manager tick must not race onto the same number.
 *
 * The ledger is rebuilt from runfiles on manager boot, so adoption restores
 * the port picture rather than re-allocating over a live daemon.
 */
import { createServer } from "node:net";

export type PortRole = "daemon" | "gateway" | "control" | "mcp-server" | "ui-host";

export type PortClaim = {
  readonly port: number;
  readonly role: PortRole;
  /** The harness the port belongs to (absolute dir). */
  readonly harnessDir: string;
  /** The run holding it, when it came from a spawn. */
  readonly runId?: string;
  /** True when the claim was rebuilt from a runfile rather than allocated
   *  by this manager — the manager did not open it and must not free it on
   *  a whim. */
  readonly adopted?: boolean;
  readonly claimedAt: string;
};

/** Bind probe: true when the port can be bound right now. */
export type PortProbe = (port: number) => Promise<boolean>;

/** The default probe binds and immediately releases on the loopback
 *  interface. */
export const defaultPortProbe: PortProbe = (port) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

export class PortCollisionError extends Error {
  readonly port: number;
  readonly existing: PortClaim;
  constructor(port: number, existing: PortClaim) {
    super(
      `port ${port} is already claimed by ${existing.harnessDir} (${existing.role}${
        existing.runId !== undefined ? `, ${existing.runId}` : ""
      })`,
    );
    this.name = "PortCollisionError";
    this.port = port;
    this.existing = existing;
  }
}

export type AllocateRequest = {
  readonly preferred: number;
  readonly role: PortRole;
  readonly harnessDir: string;
  readonly runId?: string;
  /** How many consecutive ports to try after `preferred`. */
  readonly span?: number;
};

export type PortLedger = {
  /** Claim `preferred`, or the next free port after it. Throws only when
   *  the whole span is taken. */
  allocate(req: AllocateRequest): Promise<PortClaim>;
  /** Claim an exact port. Throws {@link PortCollisionError} when the ledger
   *  already holds it for someone else. */
  claim(claim: Omit<PortClaim, "claimedAt">): PortClaim;
  release(port: number): void;
  releaseRun(runId: string): void;
  /** Every live claim, newest last. */
  claims(): readonly PortClaim[];
  claimFor(port: number): PortClaim | undefined;
  /** Rebuild claims from adopted runfiles (manager boot). Existing claims
   *  for the same harness are replaced. */
  adopt(entries: readonly Omit<PortClaim, "claimedAt" | "adopted">[]): void;
};

export const DEFAULT_PORT_SPAN = 50;

export function createPortLedger(
  deps: { readonly probe?: PortProbe; readonly now?: () => number } = {},
): PortLedger {
  const probe = deps.probe ?? defaultPortProbe;
  const now = deps.now ?? Date.now;
  const byPort = new Map<number, PortClaim>();

  const put = (claim: Omit<PortClaim, "claimedAt">): PortClaim => {
    const full: PortClaim = { ...claim, claimedAt: new Date(now()).toISOString() };
    byPort.set(full.port, full);
    return full;
  };

  return {
    allocate: async (req) => {
      const span = req.span ?? DEFAULT_PORT_SPAN;
      for (let port = req.preferred; port < req.preferred + span; port++) {
        if (byPort.has(port)) continue;
        if (!(await probe(port))) continue;
        return put({
          port,
          role: req.role,
          harnessDir: req.harnessDir,
          ...(req.runId !== undefined ? { runId: req.runId } : {}),
        });
      }
      throw new Error(
        `no free port in ${req.preferred}..${req.preferred + span - 1} for ${req.role} (${req.harnessDir})`,
      );
    },
    claim: (claim) => {
      const existing = byPort.get(claim.port);
      if (existing !== undefined && existing.harnessDir !== claim.harnessDir) {
        throw new PortCollisionError(claim.port, existing);
      }
      if (
        existing !== undefined &&
        existing.runId !== undefined &&
        claim.runId !== undefined &&
        existing.runId !== claim.runId
      ) {
        throw new PortCollisionError(claim.port, existing);
      }
      return put(claim);
    },
    release: (port) => {
      byPort.delete(port);
    },
    releaseRun: (runId) => {
      for (const [port, claim] of [...byPort.entries()]) {
        if (claim.runId === runId) byPort.delete(port);
      }
    },
    claims: () => [...byPort.values()],
    claimFor: (port) => byPort.get(port),
    adopt: (entries) => {
      for (const entry of entries) {
        put({ ...entry, adopted: true });
      }
    },
  };
}

/** The ports one runfile declares, flattened for {@link PortLedger.adopt}. */
export function runfilePortClaims(
  harnessDir: string,
  runfile: {
    readonly runId: string;
    readonly port?: number;
    readonly gatewayPort?: number;
    readonly controlPort?: number;
  },
): Array<Omit<PortClaim, "claimedAt" | "adopted">> {
  const out: Array<Omit<PortClaim, "claimedAt" | "adopted">> = [];
  const add = (port: number | undefined, role: PortRole): void => {
    if (port === undefined || !Number.isInteger(port) || port <= 0) return;
    out.push({ port, role, harnessDir, runId: runfile.runId });
  };
  add(runfile.port, "daemon");
  add(runfile.gatewayPort, "gateway");
  add(runfile.controlPort, "control");
  return out;
}
