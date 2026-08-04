/**
 * Test scaffolding: boot one isolated server per test against a temp
 * workspace (temp hangar root, temp registry root, temp watchme root so the
 * registry's legacy write-through never touches the real machine), with a
 * fetch helper that always carries a timeout. Not exported from the package
 * index — tests import it directly.
 *
 * SERVER TESTS NEVER SPAWN A HARNESS. The process layer is built over a
 * fake `ProcessOps` and a fake `Clock`, so start/stop/restart/drain drive
 * the REAL supervision state machine against a child the test controls.
 * Real spawns live in `@crewhaus/harness-supervisor`'s own suite (four tiny
 * fixture scripts, each with an explicit timeout); the manager has nothing
 * to add by re-proving that signals work, and a server suite that spawned
 * daemons would be the slowest and flakiest thing in the repo.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type {
  Clock,
  JobRunner,
  ProcessOps,
  SpawnRequest,
  SpawnedProcess,
} from "@crewhaus/harness-supervisor";
import type { ControlClient } from "./control-client";
import { type ProcessLayer, createProcessLayer } from "./process";
import { type HangarServer, type HangarServerOptions, startHangarServer } from "./server";

export const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Fake process ops + clock
// ---------------------------------------------------------------------------

export type FakeClock = Clock & {
  /** Advance time and fire every timer due at or before the new now. */
  advance(ms: number): void;
  pendingCount(): number;
};

/** A clock whose time only moves when a test says so — the restart backoff
 *  and the 15 s stop grace run instantly under it. */
export function createTestClock(startMs: number): FakeClock {
  let nowMs = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: nowMs + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance: (ms) => {
      nowMs += ms;
      // Re-scan after each callback: a timer may schedule another timer.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= nowMs)
          .sort((a, b) => a[1].at - b[1].at);
        const next = due[0];
        if (next === undefined) return;
        timers.delete(next[0]);
        next[1].fn();
      }
    },
    pendingCount: () => timers.size,
  };
}

export type FakeChild = {
  readonly pid: number;
  readonly request: SpawnRequest;
  /** Signals the supervisor sent, in order. */
  readonly signals: string[];
  /** Resolve the child's exit. */
  exit(code: number | null, signal?: string | null): void;
  /** Append text as if the child had written it to its log fd — the ONLY
   *  I/O this fake performs, and exactly what an fd-redirected daemon does. */
  writeLog(text: string): void;
  alive: boolean;
};

export type FakeProcessOps = ProcessOps & {
  readonly children: FakeChild[];
  last(): FakeChild | undefined;
};

/** A `ProcessOps` whose every effect is observable and whose every child is
 *  driven by the test. Nothing here touches a real process. */
export function createTestProcessOps(now: () => number): FakeProcessOps {
  let nextPid = 4_242;
  const children: FakeChild[] = [];
  const registry = new Map<number, { startTimeMs: number; commandLine: string }>();
  const childFor = (pid: number): FakeChild | undefined => children.find((c) => c.pid === pid);

  return {
    platform: "posix",
    children,
    last: () => children[children.length - 1],
    spawn: (request: SpawnRequest): SpawnedProcess => {
      const pid = nextPid;
      nextPid += 1;
      let resolveExit: (v: { code: number | null; signal: string | null }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
        resolveExit = r;
      });
      const logPath = request.stdio.mode === "file" ? request.stdio.path : undefined;
      const child: FakeChild = {
        pid,
        request,
        signals: [],
        alive: true,
        exit: (code, signal = null) => {
          if (!child.alive) return;
          child.alive = false;
          registry.delete(pid);
          resolveExit({ code, signal });
        },
        writeLog: (text) => {
          if (logPath !== undefined) appendFileSync(logPath, text);
        },
      };
      children.push(child);
      registry.set(pid, { startTimeMs: now(), commandLine: request.argv.join(" ") });
      return { pid, exited, write: () => {}, closeStdin: () => {}, unref: () => {} };
    },
    isAlive: (pid) => registry.has(pid),
    startTimeMs: (pid) => registry.get(pid)?.startTimeMs,
    commandLine: (pid) => registry.get(pid)?.commandLine,
    terminate: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGTERM");
      child?.exit(null, "SIGTERM");
    },
    forceKill: (pid) => {
      const child = childFor(pid);
      child?.signals.push("SIGKILL");
      child?.exit(null, "SIGKILL");
    },
  };
}

export type TestServer = {
  readonly workspace: string;
  readonly hangarRoot: string;
  readonly registryRoot: string;
  readonly harnessesRoot: string;
  readonly server: HangarServer;
  readonly base: string;
  readonly token: string;
  readonly warnings: readonly string[];
  /** The fake `ProcessOps` the supervisors spawn against (undefined when the
   *  caller supplied their own process layer). */
  readonly ops?: FakeProcessOps;
  /** The fake clock driving backoff, the stop grace, and the log pump. */
  readonly clock?: FakeClock;
  /** Fetch with an explicit timeout and NO auth header. */
  fetchRaw(path: string, init?: RequestInit): Promise<Response>;
  /** Fetch with the bearer token; returns parsed status + JSON body. */
  api(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Fetch with the bearer token; returns the raw TEXT body (SSE streams). */
  apiText(path: string, init?: RequestInit): Promise<{ status: number; text: string }>;
  stop(): Promise<void>;
};

export type BootOptions = Omit<
  HangarServerOptions,
  "port" | "root" | "registryRoot" | "env" | "processLayer"
> & {
  readonly env?: Record<string, string | undefined>;
  /** Supply a process layer instead of the fake-ops one built here. */
  readonly processLayer?: ProcessLayer;
  /** Wrap the fake-ops layer built here — the seam for injecting a
   *  supervision FAULT (an adoption that throws, say) without hand-building
   *  a whole `ProcessLayer`. Ignored when `processLayer` is supplied. */
  readonly wrapProcessLayer?: (layer: ProcessLayer) => ProcessLayer;
  readonly controlClient?: ControlClient;
  /** Job executor for the built-in layer. Defaults to a runner that never
   *  resolves, so a submitted job stays observably `running` instead of
   *  racing the assertion that it was accepted. */
  readonly runJob?: JobRunner;
  /** Run the preflight gate before spawns (default: off, so a fixture
   *  harness with no credentials is still startable in a test). */
  readonly preflight?: boolean;
};

/** Boot an isolated server on an ephemeral loopback port. */
export function bootTestServer(opts: BootOptions = {}): TestServer {
  const workspace = mkdtempSync(join(tmpdir(), "hangar-server-test-"));
  const hangarRoot = join(workspace, "hangar");
  const registryRoot = join(workspace, "registry");
  const harnessesRoot = join(workspace, "harnesses");
  mkdirSync(harnessesRoot, { recursive: true });
  const warnings: string[] = [];
  const {
    env: extraEnv,
    onWarn,
    processLayer: suppliedLayer,
    wrapProcessLayer,
    preflight,
    controlClient,
    runJob,
    ...rest
  } = opts;
  const env = { CREWHAUS_WATCHME_ROOT: join(workspace, "watchme"), ...extraEnv };
  const now = opts.now ?? Date.now;
  const collectWarn = (m: string): void => {
    warnings.push(m);
    onWarn?.(m);
  };

  let ops: FakeProcessOps | undefined;
  let clock: FakeClock | undefined;
  let processLayer = suppliedLayer;
  if (processLayer === undefined) {
    const testClock = createTestClock(now());
    clock = testClock;
    ops = createTestProcessOps(() => testClock.now());
    processLayer = createProcessLayer({
      // Its OWN registry handle over the same root: the layer only reads the
      // list at boot, and sharing one mutable handle across the seam would
      // hide a coupling the real composition does not have.
      registry: openHangarRegistry({ root: registryRoot, env, now, onWarn: collectWarn }),
      env,
      now,
      onWarn: collectWarn,
      hangarRoot,
      managerVersion: "test",
      ops,
      clock,
      // A job that never settles: the queue holds it `running`, which is the
      // observable effect a submit assertion needs. Override for real work.
      runJob: runJob ?? (() => new Promise<{ exitCode?: number }>(() => {})),
      ...(preflight === true ? {} : { noPreflight: true }),
    });
    if (wrapProcessLayer !== undefined) processLayer = wrapProcessLayer(processLayer);
  }

  const server = startHangarServer({
    ...rest,
    port: 0,
    root: hangarRoot,
    registryRoot,
    env,
    processLayer,
    ...(controlClient !== undefined ? { controlClient } : {}),
    onWarn: collectWarn,
  });
  const token = server.token ?? "";

  const fetchRaw = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  const authed = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetchRaw(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });

  const api = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await authed(path, init);
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  };

  const apiText = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; text: string }> => {
    const res = await authed(path, init);
    return { status: res.status, text: await res.text() };
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
    ...(ops !== undefined ? { ops } : {}),
    ...(clock !== undefined ? { clock } : {}),
    fetchRaw,
    api,
    apiText,
    stop: async () => {
      await server.stop();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/**
 * A tiny stub of `crewhaus.control.v1` for proxy tests: a real socket
 * speaking the real wire contract, so the client's 404/409 handling is
 * exercised against the responses a daemon actually sends rather than a
 * mock's idea of them.
 */
export type StubControlPlane = {
  readonly port: number;
  /** Requests the stub received, in order. */
  readonly calls: Array<{ readonly path: string; readonly authorization: string | null }>;
  /** Lanes that answer 202. Anything else 404s `lane_not_armed`. */
  armed: Set<string>;
  /** When set, `/wake` answers 409 `tick_in_flight`. */
  busy: boolean;
  /** When set, `/wake` answers 409 `draining`. */
  draining: boolean;
  /** The `/status` body. */
  status: Record<string, unknown>;
  stop(): Promise<void>;
};

export function startStubControlPlane(token: string): StubControlPlane {
  const state = {
    armed: new Set<string>(["heartbeat"]),
    busy: false,
    draining: false,
    status: {} as Record<string, unknown>,
    calls: [] as Array<{ path: string; authorization: string | null }>,
  };
  const jsonRes = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    development: false,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const authorization = req.headers.get("authorization");
      state.calls.push({ path, authorization });
      if (authorization !== `Bearer ${token}`) {
        return jsonRes({ error: "unauthorized", code: "unauthorized" }, 401);
      }
      if (req.method === "GET" && path === "/control/v1/status") {
        return jsonRes(state.status, 200);
      }
      if (req.method === "POST" && path === "/control/v1/wake") {
        const body = (await req.json().catch(() => ({}))) as { lane?: string };
        const lane = body.lane ?? "";
        if (state.draining) {
          return jsonRes(
            { error: "daemon is draining — no new ticks accepted", code: "draining", lane },
            409,
          );
        }
        if (!state.armed.has(lane)) {
          return jsonRes(
            { error: `lane "${lane}" is not armed in this bundle`, code: "lane_not_armed", lane },
            404,
          );
        }
        if (state.busy) {
          return jsonRes(
            { error: `a ${lane} tick is already in flight`, code: "tick_in_flight", lane },
            409,
          );
        }
        return jsonRes(
          { sessionId: "sess_00000000000000ff", lane, reason: "operator wake", synthetic: true },
          202,
        );
      }
      if (req.method === "POST" && path === "/control/v1/drain") {
        const already = state.draining;
        state.draining = true;
        return jsonRes({ draining: true, alreadyDraining: already }, 202);
      }
      return jsonRes({ error: "not found", code: "not_found" }, 404);
    },
  });

  return {
    port: server.port ?? 0,
    calls: state.calls,
    get armed() {
      return state.armed;
    },
    set armed(next: Set<string>) {
      state.armed = next;
    },
    get busy() {
      return state.busy;
    },
    set busy(next: boolean) {
      state.busy = next;
    },
    get draining() {
      return state.draining;
    },
    set draining(next: boolean) {
      state.draining = next;
    },
    get status() {
      return state.status;
    },
    set status(next: Record<string, unknown>) {
      state.status = next;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
