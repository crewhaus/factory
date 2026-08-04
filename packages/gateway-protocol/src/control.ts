/**
 * `crewhaus.control.v1` — the daemon control plane every daemon-shape bundle
 * serves.
 *
 * WHY THIS EXISTS. A compiled daemon's schedulers are in-process
 * (`setInterval` for `heartbeat:`, `armSchedule` for `schedule:`), so from
 * the outside there is no way to ask "when does the next heartbeat fire?" and
 * no way to make one fire now: the phase of a heartbeat is knowable ONLY
 * inside the process that armed it. A supervisor that wants to drive — not
 * just watch — a fleet of daemons needs a uniform, signal-free surface. This
 * module is that surface, written ONCE and consumed by every daemon-emitting
 * target (channel, managed, batch, crew, voice) so the five shapes can never
 * drift apart.
 *
 * SHAPE OF THE CONTRACT.
 *   - A DEDICATED control port, separate from any public webhook/gateway
 *     port. Default bind `127.0.0.1`; the port comes from
 *     `CREWHAUS_CONTROL_PORT` (`0` asks the kernel for an ephemeral port,
 *     which is then reported on stdout). Unset ⇒ no control socket at all,
 *     so upgrading a bundle never opens a listener nobody asked for.
 *     Exposing it on a PaaS is an explicit opt-in: set the bind + token as
 *     provider secrets at deploy time.
 *   - Bearer auth against `CREWHAUS_CONTROL_TOKEN`, or a token minted at boot
 *     into `<cwd>/.crewhaus/run/control-token` (0600) so a local manager can
 *     read it off disk. Compared in constant time; never logged, never
 *     echoed, never written to an audit payload.
 *   - `GET  /control/v1/healthz` → `{ok, name, target}`
 *   - `GET  /control/v1/status`  → counters + per-lane timers + channels +
 *                                  pending approvals
 *   - `POST /control/v1/wake`    → one synthetic tick down the IDENTICAL code
 *                                  path as the timer fire
 *   - `POST /control/v1/drain`   → stop intake, finish in-flight work, exit 0
 *   - Every call appends a `gateway_request` record to the harness's
 *     hash-chained audit log when one is wired.
 *
 * Separately — and INDEPENDENT of whether the control port is bound — a bare,
 * unauthenticated `GET /healthz` is served on the daemon's PUBLIC port when it
 * has one ({@link ControlPlane.publicGate}). Deployment scaffolds declare that
 * health check but no daemon served it; the liveness answer carries no state,
 * so closing that gap never exposes control.
 *
 * TESTABILITY. `fetch` is a plain `Request → Response` function, so the whole
 * router (auth, wake, 409-while-in-flight, drain) is exercisable with no
 * socket, no timers and no daemon. `start()` is the only part that touches
 * `Bun.serve`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";

/** Wire identifier for this control protocol. Bumping it is a breaking change. */
export const CONTROL_PROTOCOL = "crewhaus.control.v1" as const;

/** Every control route lives under this prefix. */
export const CONTROL_PATH_PREFIX = "/control/v1" as const;

/** Harness-local ops directory. All daemon-written control state lives here. */
export const CONTROL_RUN_DIR = ".crewhaus/run" as const;

/** File the boot-minted bearer token lands in, mode 0600. */
export const CONTROL_TOKEN_FILENAME = "control-token" as const;

export const CONTROL_BIND_ENV = "CREWHAUS_CONTROL_BIND" as const;
export const CONTROL_PORT_ENV = "CREWHAUS_CONTROL_PORT" as const;
export const CONTROL_TOKEN_ENV = "CREWHAUS_CONTROL_TOKEN" as const;

/** Loopback-only unless the operator explicitly widens it. */
export const DEFAULT_CONTROL_BIND = "127.0.0.1" as const;

/** `Retry-After` (seconds) on the 503 a draining daemon answers intake with. */
export const DRAIN_RETRY_AFTER_SECONDS = 15;

/** The two lanes an operator can poke. Both are in-process timers. */
export type ControlLane = "heartbeat" | "schedule";

export type ControlOutcome = "ok" | "error";

/** Counters `/control/v1/status` reports. Mutated in place by the daemon. */
export type ControlCounters = {
  turns: number;
  heartbeatTicks: number;
  scheduleWakes: number;
  janitorRuns: number;
};

export type ControlTimerReport = {
  readonly lane: string;
  /** Human cadence, e.g. `every 60000ms` or `cron "0 * * * *" UTC`. */
  readonly cadence: string;
  readonly lastFiredAt?: string;
  readonly lastOutcome?: ControlOutcome;
  readonly nextDueAt?: string;
};

/** What a lane's tick body receives. `synthetic` is set only for operator pokes. */
export type ControlTickContext = {
  readonly sessionId: string;
  readonly synthetic?: { readonly reason: string; readonly by: string };
};

export type ControlLaneOptions = {
  readonly lane: ControlLane;
  readonly cadence: string;
  /**
   * Interval in ms, when the lane has a fixed one. Used to project
   * `nextDueAt` from the last fire — the number no offline reader can
   * compute for a heartbeat, which is the entire reason `/status` exists.
   */
  readonly everyMs?: number;
  /** Overrides the `everyMs` projection (cron lanes supply their own). */
  readonly nextDueAt?: () => string | undefined;
  /**
   * The tick body. The SAME function backs the timer fire and the operator
   * wake — there is deliberately no second code path to drift.
   */
  readonly run: (ctx: ControlTickContext) => Promise<unknown>;
};

export interface ControlLaneHandle {
  readonly lane: ControlLane;
  /** True while a tick for this lane is executing. Ticks never overlap. */
  busy(): boolean;
  /**
   * ORGANIC fire (the timer's own call). Awaits the tick to completion so
   * `armSchedule`'s re-arm-after-resolve rule keeps holding. A fire while the
   * previous tick is still running is dropped, not queued.
   */
  tick(): Promise<void>;
  /**
   * SYNTHETIC fire (an operator poke). Records the marker, starts the tick and
   * returns immediately with the minted session id — the caller answers 202
   * without waiting for a model round-trip.
   */
  wake(args: { readonly reason: string; readonly by: string }): Promise<{
    readonly accepted: boolean;
    readonly sessionId: string;
  }>;
  /** Resolves once no tick is in flight (used by drain). */
  settled(): Promise<void>;
  report(): ControlTimerReport;
}

export type ControlAuditRecord = {
  readonly kind: "gateway_request";
  readonly payload: Record<string, unknown>;
};

export type ControlPlaneOptions = {
  readonly name: string;
  readonly target: string;
  /** Harness root. Defaults to `process.cwd()` — never the bundle dir. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Channel ids this daemon serves (channel shape); empty elsewhere. */
  readonly channels?: () => readonly string[];
  /** Count of parked approvals. Read-only — must never evict or mutate. */
  readonly pendingApprovals?: () => number | Promise<number>;
  /**
   * The harness's existing hash-chained audit log. Every control call appends
   * a `gateway_request` record through it. Absent ⇒ control still works, just
   * un-evidenced (a daemon booted with `CREWHAUS_SECURITY_AUDIT=0`).
   */
  readonly audit?: (record: ControlAuditRecord) => Promise<unknown> | unknown;
  /** Session root for the synthetic-wake marker. Defaults to event-log's. */
  readonly sessionRootDir?: string;
  readonly now?: () => number;
  readonly pid?: number;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
  /** Injected for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /**
   * Delay between answering a drain request and running the drain sequence,
   * so the 202 is on the wire before the process starts tearing down.
   */
  readonly drainSettleMs?: number;
};

export interface ControlPlane {
  readonly counters: ControlCounters;
  /** Register a pokeable lane. Returns the handle the timer body fires. */
  lane(opts: ControlLaneOptions): ControlLaneHandle;
  /** Register a read-only timer row (janitor, dream) for `/status`. */
  timer(report: () => ControlTimerReport): void;
  /** Register a drain step. Steps run in registration order. */
  onDrain(step: () => Promise<void> | void): void;
  draining(): boolean;
  /** The whole router, socket-free. */
  fetch(req: Request): Promise<Response>;
  /**
   * Bind the dedicated control port when `CREWHAUS_CONTROL_PORT` is set.
   * Returns undefined when control is not configured (the default).
   */
  start(): Promise<{ readonly port: number; readonly url: string } | undefined>;
  stop(): Promise<void>;
  /**
   * The PUBLIC-port gate: answers the bare `GET /healthz` liveness check and,
   * once draining, sheds every other request with `503` + `Retry-After`.
   * Returns undefined when the request should fall through to the daemon's
   * real handler.
   */
  publicGate(req: Request): Response | undefined;
  /** Where the bearer came from. Never returns the token itself. */
  tokenSource(): { readonly source: "env" | "file"; readonly path?: string } | undefined;
}

/** Session ids must satisfy `@crewhaus/session-store`'s grammar or the very
 *  first store/event-log write of the tick throws. Minted exactly as the
 *  store's own `generateId` does. */
function mintSessionId(): string {
  return `sess_${randomBytes(8).toString("hex")}`;
}

/**
 * Constant-time string compare. Both sides are hashed first so the comparison
 * is over fixed-length buffers — `timingSafeEqual` throws on length mismatch,
 * and branching on length would itself leak the token's length.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export type ResolvedControlToken = {
  readonly token: string;
  readonly source: "env" | "file";
  readonly path?: string;
};

/**
 * Resolve the control bearer. `CREWHAUS_CONTROL_TOKEN` wins; otherwise a fresh
 * 32-byte token is minted into `<cwd>/.crewhaus/run/control-token` at 0600.
 *
 * Minting FRESH each boot is deliberate: a token left behind by a dead daemon
 * must not authenticate against its replacement, and the manager reads the
 * file after it spawns the process, so there is nothing to preserve.
 */
export function resolveControlToken(opts: {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ResolvedControlToken {
  const env = opts.env ?? process.env;
  const fromEnv = env[CONTROL_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, source: "env" };
  const dir = join(opts.cwd, CONTROL_RUN_DIR);
  const path = join(dir, CONTROL_TOKEN_FILENAME);
  const token = randomBytes(32).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // `writeFileSync`'s mode only applies when the file is CREATED; an existing
  // file from a previous boot keeps its old mode, so re-assert it.
  chmodSync(path, 0o600);
  return { token, source: "file", path };
}

/**
 * Append the operator-poke marker to the tick's session log.
 *
 * It is written as a `user_message` carrying `synthetic: true` — the
 * established convention for runtime-injected turns. Every turn-deriving
 * reader in the stack (feedback distill, the eval-judge transcript digest, the
 * session summarizer, the advise rules) already skips `synthetic: true` user
 * messages, so an operator poke can never inflate a turn count or land in a
 * training set as if a human had typed it. The `control` sub-object is what
 * lets evals and watch-me positively IDENTIFY the poke and tell it apart from
 * an organic wake.
 */
export async function recordSyntheticWake(args: {
  readonly sessionId: string;
  readonly lane: ControlLane;
  readonly reason: string;
  readonly by: string;
  readonly sessionRootDir?: string;
}): Promise<void> {
  const log = await openEventLog(
    args.sessionId,
    args.sessionRootDir !== undefined ? { rootDir: args.sessionRootDir } : {},
  );
  try {
    await log.append({
      kind: "user_message",
      payload: {
        content: `[${CONTROL_PROTOCOL} wake] lane=${args.lane} reason=${args.reason}`,
        synthetic: true,
        control: {
          protocol: CONTROL_PROTOCOL,
          lane: args.lane,
          synthetic: true,
          reason: args.reason,
          by: args.by,
        },
      },
    });
  } finally {
    await log.close();
  }
}

/** Default filename `@crewhaus/session-store`'s approval store writes. */
export const APPROVALS_FILENAME = "approvals.jsonl" as const;

/**
 * Count parked approvals WITHOUT calling `PendingApprovalStore.list()`.
 *
 * `list()` compacts the backing file as a side-effect (it drops expired and
 * superseded lines), exactly like `SessionStore.list()`'s TTL eviction. A
 * status endpoint is a read: polling it must never rewrite an operator's
 * approvals ledger. So this folds the JSONL itself — last-wins by `id`, the
 * same upsert rule `persist` documents — and counts the records still awaiting
 * a human. A missing file, a torn tail line, or an unreadable record counts as
 * nothing rather than failing the whole status call.
 */
export function countPendingApprovals(filePath: string): number {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }
  const latest = new Map<string, { decision?: unknown; consumedAt?: unknown }>();
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let parsed: { id?: unknown; decision?: unknown; consumedAt?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue; // torn tail line — a reader never aborts on one
    }
    if (typeof parsed.id !== "string") continue;
    latest.set(parsed.id, parsed);
  }
  let pending = 0;
  for (const record of latest.values()) {
    if (record.consumedAt !== undefined) continue;
    if (record.decision === undefined || record.decision === "pending") pending += 1;
  }
  return pending;
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

export function createControlPlane(opts: ControlPlaneOptions): ControlPlane {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const stdout = opts.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = opts.stderr ?? ((line: string) => process.stderr.write(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const drainSettleMs = opts.drainSettleMs ?? 50;

  const startedAt = new Date(now()).toISOString();
  const counters: ControlCounters = {
    turns: 0,
    heartbeatTicks: 0,
    scheduleWakes: 0,
    janitorRuns: 0,
  };

  const lanes = new Map<ControlLane, ControlLaneHandle>();
  const extraTimers: Array<() => ControlTimerReport> = [];
  const drainSteps: Array<() => Promise<void> | void> = [];
  let draining = false;
  let server: { stop(closeActiveConnections?: boolean): unknown; port?: number } | undefined;
  let resolved: ResolvedControlToken | undefined;

  function laneCounterKey(lane: ControlLane): keyof ControlCounters {
    return lane === "heartbeat" ? "heartbeatTicks" : "scheduleWakes";
  }

  function makeLane(laneOpts: ControlLaneOptions): ControlLaneHandle {
    const armedAtMs = now();
    let busy = false;
    let inFlight: Promise<void> = Promise.resolve();
    let lastStartMs: number | undefined;
    let lastFiredAt: string | undefined;
    let lastOutcome: ControlOutcome | undefined;

    /**
     * Claim the lane and run one tick. The claim (`busy = true`) is made
     * SYNCHRONOUSLY, before any await: two wakes arriving in the same tick of
     * the event loop must not both pass the guard, and anything awaited ahead
     * of the claim — writing the marker, say — is a yield point where exactly
     * that would happen.
     */
    function start(synthetic?: { reason: string; by: string }): {
      accepted: boolean;
      sessionId: string;
      done: Promise<void>;
    } {
      if (busy) return { accepted: false, sessionId: "", done: inFlight };
      busy = true;
      const sessionId = mintSessionId();
      lastStartMs = now();
      lastFiredAt = new Date(lastStartMs).toISOString();
      counters[laneCounterKey(laneOpts.lane)] += 1;
      const done = (async () => {
        if (synthetic !== undefined) {
          // Written BEFORE the turn so a tick that dies mid-flight is still
          // attributable to the operator who poked it.
          try {
            await recordSyntheticWake({
              sessionId,
              lane: laneOpts.lane,
              reason: synthetic.reason,
              by: synthetic.by,
              ...(opts.sessionRootDir !== undefined ? { sessionRootDir: opts.sessionRootDir } : {}),
            });
          } catch (err) {
            stderr(`[control] wake marker not recorded: ${(err as Error).message}\n`);
          }
        }
        try {
          await laneOpts.run({
            sessionId,
            ...(synthetic !== undefined ? { synthetic } : {}),
          });
          lastOutcome = "ok";
        } catch (err) {
          lastOutcome = "error";
          stderr(`[control] ${laneOpts.lane} tick failed: ${(err as Error).message}\n`);
        } finally {
          busy = false;
        }
      })();
      inFlight = done;
      return { accepted: true, sessionId, done };
    }

    const handle: ControlLaneHandle = {
      lane: laneOpts.lane,
      busy: () => busy,
      async tick(): Promise<void> {
        await start().done;
      },
      async wake(args): Promise<{ accepted: boolean; sessionId: string }> {
        const started = start({ reason: args.reason, by: args.by });
        // Deliberately NOT awaiting `started.done`: the operator gets a 202
        // and the session id, and the tick runs on its own.
        void started.done;
        return { accepted: started.accepted, sessionId: started.sessionId };
      },
      async settled(): Promise<void> {
        while (busy) await inFlight;
      },
      report(): ControlTimerReport {
        const projected =
          laneOpts.nextDueAt !== undefined
            ? laneOpts.nextDueAt()
            : laneOpts.everyMs !== undefined
              ? new Date((lastStartMs ?? armedAtMs) + laneOpts.everyMs).toISOString()
              : undefined;
        return {
          lane: laneOpts.lane,
          cadence: laneOpts.cadence,
          ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
          ...(lastOutcome !== undefined ? { lastOutcome } : {}),
          ...(projected !== undefined ? { nextDueAt: projected } : {}),
        };
      },
    };
    return handle;
  }

  function token(): string {
    if (resolved === undefined) resolved = resolveControlToken({ cwd, env });
    return resolved.token;
  }

  function authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return false;
    return constantTimeEquals(header.slice(7), token());
  }

  async function audit(payload: Record<string, unknown>): Promise<void> {
    if (opts.audit === undefined) return;
    try {
      await opts.audit({ kind: "gateway_request", payload });
    } catch (err) {
      // An unwritable audit log must never take the daemon's control plane
      // down; the failure is reported and the call proceeds.
      stderr(`[control] audit append failed: ${(err as Error).message}\n`);
    }
  }

  async function statusBody(): Promise<Record<string, unknown>> {
    let pendingApprovals = 0;
    if (opts.pendingApprovals !== undefined) {
      try {
        pendingApprovals = await opts.pendingApprovals();
      } catch {
        pendingApprovals = 0;
      }
    }
    const timers: ControlTimerReport[] = [
      ...[...lanes.values()].map((l) => l.report()),
      ...extraTimers.map((t) => t()),
    ];
    return {
      protocol: CONTROL_PROTOCOL,
      name: opts.name,
      target: opts.target,
      pid: opts.pid ?? process.pid,
      startedAt,
      draining,
      counters: { ...counters },
      timers,
      channels: opts.channels !== undefined ? [...opts.channels()] : [],
      pendingApprovals,
    };
  }

  function beginDrain(): void {
    draining = true;
    setTimeout(() => {
      void (async () => {
        try {
          // Order matters. Intake is already refused (the `draining` flag was
          // set synchronously above: `publicGate` sheds and `/wake` 409s), so
          // this waits out the work that was already accepted, lets each
          // registered step flush — the steps are also what CANCEL the timers,
          // so a tick could have started while the first wait ran — and then
          // waits once more for anything that slipped through.
          await Promise.all([...lanes.values()].map((l) => l.settled()));
          for (const step of drainSteps) await step();
          await Promise.all([...lanes.values()].map((l) => l.settled()));
        } catch (err) {
          stderr(`[control] drain error: ${(err as Error).message}\n`);
        } finally {
          stdout("[control] drained — exiting 0\n");
          exit(0);
        }
      })();
    }, drainSettleMs);
  }

  type WakeOutcome = {
    readonly res: Response;
    readonly lane?: ControlLane;
    readonly sessionId?: string;
  };

  async function handleWake(req: Request): Promise<WakeOutcome> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }
    const parsed = (body ?? {}) as { lane?: unknown; reason?: unknown; by?: unknown };
    const lane = parsed.lane;
    if (lane !== "heartbeat" && lane !== "schedule") {
      return {
        res: jsonResponse(
          { error: 'wake requires {"lane": "heartbeat" | "schedule"}', code: "bad_request" },
          400,
        ),
      };
    }
    if (draining) {
      // A poke during a drain would start work the drain is about to abandon.
      return {
        lane,
        res: jsonResponse(
          { error: "daemon is draining — no new ticks accepted", code: "draining", lane },
          409,
        ),
      };
    }
    const handle = lanes.get(lane);
    if (handle === undefined) {
      return {
        lane,
        res: jsonResponse(
          { error: `lane "${lane}" is not armed in this bundle`, code: "lane_not_armed", lane },
          404,
        ),
      };
    }
    const reason =
      typeof parsed.reason === "string" && parsed.reason !== "" ? parsed.reason : "operator wake";
    const by = typeof parsed.by === "string" && parsed.by !== "" ? parsed.by : CONTROL_PROTOCOL;
    const outcome = await handle.wake({ reason, by });
    if (!outcome.accepted) {
      // Ticks never overlap themselves — armSchedule's re-arm-after-resolve
      // rule applies to operator pokes too.
      return {
        lane,
        res: jsonResponse(
          { error: `a ${lane} tick is already in flight`, code: "tick_in_flight", lane },
          409,
        ),
      };
    }
    return {
      lane,
      sessionId: outcome.sessionId,
      res: jsonResponse({ sessionId: outcome.sessionId, lane, reason, synthetic: true }, 202),
    };
  }

  async function fetchControl(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(CONTROL_PATH_PREFIX)) {
      return jsonResponse({ error: "not found", code: "not_found" }, 404);
    }
    const route = path.slice(CONTROL_PATH_PREFIX.length);
    if (!authorized(req)) {
      // The rejected attempt is evidenced too — an unauthenticated poke at the
      // control plane is exactly what an operator wants to see later. The
      // presented credential is never part of the record.
      await audit({
        protocol: CONTROL_PROTOCOL,
        route: path,
        method: req.method,
        authorized: false,
        status: 401,
      });
      return jsonResponse({ error: "unauthorized", code: "unauthorized" }, 401, {
        "www-authenticate": `Bearer realm="${CONTROL_PROTOCOL}"`,
      });
    }

    if (req.method === "GET" && route === "/healthz") {
      await audit({
        protocol: CONTROL_PROTOCOL,
        route: path,
        method: "GET",
        authorized: true,
        status: 200,
      });
      return jsonResponse({ ok: true, name: opts.name, target: opts.target }, 200);
    }

    if (req.method === "GET" && route === "/status") {
      const body = await statusBody();
      await audit({
        protocol: CONTROL_PROTOCOL,
        route: path,
        method: "GET",
        authorized: true,
        status: 200,
      });
      return jsonResponse(body, 200);
    }

    if (req.method === "POST" && route === "/wake") {
      const outcome = await handleWake(req);
      await audit({
        protocol: CONTROL_PROTOCOL,
        route: path,
        method: "POST",
        authorized: true,
        status: outcome.res.status,
        ...(outcome.lane !== undefined ? { lane: outcome.lane } : {}),
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      });
      return outcome.res;
    }

    if (req.method === "POST" && route === "/drain") {
      const already = draining;
      if (!already) beginDrain();
      await audit({
        protocol: CONTROL_PROTOCOL,
        route: path,
        method: "POST",
        authorized: true,
        status: 202,
        alreadyDraining: already,
      });
      return jsonResponse({ draining: true, alreadyDraining: already }, 202);
    }

    await audit({
      protocol: CONTROL_PROTOCOL,
      route: path,
      method: req.method,
      authorized: true,
      status: 404,
    });
    return jsonResponse({ error: `no such control route: ${path}`, code: "not_found" }, 404);
  }

  return {
    counters,
    lane(laneOpts): ControlLaneHandle {
      const handle = makeLane(laneOpts);
      lanes.set(laneOpts.lane, handle);
      return handle;
    },
    timer(report): void {
      extraTimers.push(report);
    },
    onDrain(step): void {
      drainSteps.push(step);
    },
    draining: () => draining,
    fetch: fetchControl,

    async start(): Promise<{ port: number; url: string } | undefined> {
      const raw = env[CONTROL_PORT_ENV];
      if (raw === undefined || raw === "") return undefined;
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        stderr(
          `[control] ${CONTROL_PORT_ENV}="${raw}" is not a valid port — control.v1 not served\n`,
        );
        return undefined;
      }
      const bind = env[CONTROL_BIND_ENV] ?? DEFAULT_CONTROL_BIND;
      // Resolving the token here is what MINTS `.crewhaus/run/control-token`
      // — a daemon with no control port never writes one. Reuse an already
      // resolved token rather than minting a second: a fresh mint would
      // silently invalidate one a caller had already been handed.
      const tok = resolved ?? resolveControlToken({ cwd, env });
      resolved = tok;
      const handle = Bun.serve({ port, hostname: bind, fetch: fetchControl });
      server = handle;
      const bound = handle.port ?? port;
      const url = `http://${bind}:${bound}`;
      // The PORT is reported (never the token) so a supervisor that passed
      // port 0 learns the ephemeral port from the log pump.
      stdout(
        `[control] ${CONTROL_PROTOCOL} listening on ${url} (token: ${
          tok.source === "env" ? CONTROL_TOKEN_ENV : `${CONTROL_RUN_DIR}/${CONTROL_TOKEN_FILENAME}`
        })\n`,
      );
      return { port: bound, url };
    },

    async stop(): Promise<void> {
      if (server === undefined) return;
      server.stop(true);
      server = undefined;
    },

    publicGate(req): Response | undefined {
      const path = new URL(req.url).pathname;
      // Liveness first: a health check must still answer while draining, or a
      // PaaS reaps the process before it finishes its in-flight work. No state
      // is disclosed — this route is unauthenticated by design.
      if (req.method === "GET" && path === "/healthz") {
        return jsonResponse({ ok: true }, 200);
      }
      if (draining) {
        return jsonResponse({ error: "draining", code: "draining" }, 503, {
          "retry-after": String(DRAIN_RETRY_AFTER_SECONDS),
        });
      }
      return undefined;
    },

    tokenSource(): { source: "env" | "file"; path?: string } | undefined {
      if (resolved === undefined) return undefined;
      return resolved.path !== undefined
        ? { source: resolved.source, path: resolved.path }
        : { source: resolved.source };
    },
  };
}
