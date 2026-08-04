/**
 * Test scaffolding: boot one isolated server per test against a temp
 * workspace (temp hangar root, temp registry root, temp watchme root so the
 * registry's legacy write-through never touches the real machine), with a
 * fetch helper that always carries a timeout. Not exported from the package
 * index — tests import it directly.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HangarServer, type HangarServerOptions, startHangarServer } from "./server";

export const FETCH_TIMEOUT_MS = 10_000;

export type TestServer = {
  readonly workspace: string;
  readonly hangarRoot: string;
  readonly registryRoot: string;
  readonly harnessesRoot: string;
  readonly server: HangarServer;
  readonly base: string;
  readonly token: string;
  readonly warnings: readonly string[];
  /** Fetch with an explicit timeout and NO auth header. */
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  /** Fetch with the bearer token; returns parsed status + JSON body. */
  api(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }>;
  stop(): Promise<void>;
};

export type BootOptions = Omit<HangarServerOptions, "port" | "root" | "registryRoot" | "env"> & {
  readonly env?: Record<string, string | undefined>;
};

/** Boot an isolated server on an ephemeral loopback port. */
export function bootTestServer(opts: BootOptions = {}): TestServer {
  const workspace = mkdtempSync(join(tmpdir(), "hangar-server-test-"));
  const hangarRoot = join(workspace, "hangar");
  const registryRoot = join(workspace, "registry");
  const harnessesRoot = join(workspace, "harnesses");
  mkdirSync(harnessesRoot, { recursive: true });
  const warnings: string[] = [];
  const { env: extraEnv, onWarn, ...rest } = opts;
  const server = startHangarServer({
    ...rest,
    port: 0,
    root: hangarRoot,
    registryRoot,
    env: { CREWHAUS_WATCHME_ROOT: join(workspace, "watchme"), ...extraEnv },
    onWarn: (m) => {
      warnings.push(m);
      onWarn?.(m);
    },
  });
  const token = server.token ?? "";

  const fetchRaw = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const api = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetchRaw(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  };

  return {
    workspace,
    hangarRoot,
    registryRoot,
    harnessesRoot,
    server,
    base: server.url,
    token,
    warnings,
    fetchRaw,
    api,
    stop: async () => {
      await server.stop();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
