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
 *     provider secrets at deploy time. A bind beyond this computer (any
 *     `CREWHAUS_CONTROL_BIND` that {@link isLoopbackBind} does not accept)
 *     opens only with a token set in `CREWHAUS_CONTROL_TOKEN`; a token minted
 *     into a file serves a loopback socket only.
 *   - Bearer auth against `CREWHAUS_CONTROL_TOKEN`, or a token minted at boot
 *     into `<cwd>/.crewhaus/run/control-token` (0600) so a local manager can
 *     read it off disk. Compared in constant time; never logged, never
 *     echoed, never written to an audit payload.
 *   - The routes are {@link CONTROL_ROUTES}:
 *     - `GET  /control/v1/healthz` → `{ok, name, target}`
 *     - `GET  /control/v1/status`  → counters, per-lane timers, channels,
 *                                    pending approvals, the operator record,
 *                                    the controls this daemon supports and
 *                                    its active runs
 *     - `POST /control/v1/wake`    → one synthetic tick down the IDENTICAL
 *                                    code path as the timer fire
 *     - `POST /control/v1/drain`   → stop intake, finish in-flight work, exit 0
 *     - `POST /control/v1/runs/{runId}/cancel` → signal that run's abort
 *     - `POST /control/v1/operator/reload` → re-read the operator record now
 *     - `POST /control/v1/runs/claim` → wake the registered queued-runs follower
 *   - A control route restricts or asks for a re-read; lifting a restriction is
 *     a record write by an authorized command. No route sets or lifts a pause
 *     or a disable.
 *   - A refused call (401, an unknown route) and every POST append one
 *     `gateway_request` record to the harness's hash-chained audit log when
 *     one is wired; a successful `healthz` or `status` read appends nothing.
 *
 * THE OPERATOR RECORD. The plane honours `.crewhaus/run/control/operator.json`
 * (`@crewhaus/control-records`): a daemon booting while it is disabled, or
 * while it cannot be read, exits 38 from the constructor; while intake is
 * closed, a lane's tick runs nothing and a wake answers 409 with the verdict's
 * code. `start()` names the harness as this process's intake root, which the
 * runtime's loop admission reads, and writes a heartbeat to
 * `.crewhaus/run/control-heartbeat.json` every {@link HEARTBEAT_INTERVAL_MS},
 * with or without a control port.
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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CapabilityName,
  effectiveDecisionState,
} from "@crewhaus/control-contract";
import {
  type IntakeVerdict,
  type OperatorRead,
  assertRunnable,
  intakeVerdict,
  readOperatorRecord,
  refreshOperatorRecord,
  registerIntakeRoot,
  unregisterIntakeRoot,
  writeHeartbeat,
} from "@crewhaus/control-records";
import { EXIT_CODES } from "@crewhaus/errors";
import { openEventLog } from "@crewhaus/event-log";
import {
  type RunScope,
  activeRunCount,
  cancelRun,
  formatResumeScope,
  runWithScope,
} from "@crewhaus/run-context";
import { foldReadOnly } from "@crewhaus/session-store";

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

/**
 * Longest free-text a control-plane field (`reason`, `by`) may carry into a
 * daemon's prose log, and the default cap {@link sanitizeControlText} applies.
 */
export const CONTROL_TEXT_MAX = 200;

/**
 * Budget (ms) for a best-effort housekeeping step run during a drain, and the
 * env var that widens it. `0` skips the step entirely.
 */
export const DRAIN_SWEEP_BUDGET_ENV = "CREWHAUS_DRAIN_SWEEP_MS" as const;
export const DEFAULT_DRAIN_SWEEP_MS = 5_000;

/** `Retry-After` (seconds) on the 503 a draining daemon answers intake with. */
export const DRAIN_RETRY_AFTER_SECONDS = 15;

/** How often `start()` rewrites `.crewhaus/run/control-heartbeat.json`, in ms. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Every control route, as `{method, route}` with the full path. `fetch`
 * dispatches from this list, so a route is served exactly when it is listed.
 */
export const CONTROL_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", route: `${CONTROL_PATH_PREFIX}/healthz` }),
  Object.freeze({ method: "GET", route: `${CONTROL_PATH_PREFIX}/status` }),
  Object.freeze({ method: "POST", route: `${CONTROL_PATH_PREFIX}/wake` }),
  Object.freeze({ method: "POST", route: `${CONTROL_PATH_PREFIX}/drain` }),
  Object.freeze({ method: "POST", route: `${CONTROL_PATH_PREFIX}/runs/{runId}/cancel` }),
  Object.freeze({ method: "POST", route: `${CONTROL_PATH_PREFIX}/operator/reload` }),
  Object.freeze({ method: "POST", route: `${CONTROL_PATH_PREFIX}/runs/claim` }),
] as const);

export type ControlRoute = (typeof CONTROL_ROUTES)[number];

/** The code a closed intake answers with: the operator verdict's. */
export type IntakeClosedCode = Extract<IntakeVerdict, { readonly state: "closed" }>["code"];

/**
 * Whether `host` is a loopback address: `localhost`, any `127.0.0.0/8`
 * address, or `::1`, bracketed or not, and the IPv4-mapped `::ffff:127.x.x.x`.
 * Anything else, `0.0.0.0` and `::` included, is beyond this computer.
 */
export function isLoopbackBind(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  const octets = v4.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

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
  /** Set when the last organic fire ran nothing because intake was closed. */
  readonly skipped?: IntakeClosedCode;
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
   * Does this lane's body actually THREAD `ctx.sessionId` into a session?
   *
   * On the channel shape it does — the tick calls `agent.runTurn({sessionId})`,
   * so the id the 202 hands back names a transcript the operator can open, and
   * writing the poke marker into that session's event log is what attributes
   * the turn to the operator who asked for it.
   *
   * On the multi-tenant (managed) and producer (batch) shapes it does NOT: one
   * tick fans out to a turn per tenant, each in its own session, or enqueues a
   * job whose handler mints its own. Advertising the lane's id there promised a
   * transcript that never existed, and the marker it left behind was a `.jsonl`
   * with no `.json` beside it — a file `sweepExpired`, `crewhaus retention` and
   * the janitor's TTL eviction all skip BY DESIGN, so it outlived every
   * retention policy the harness has. Such a lane declares `ownsSession: false`:
   * no marker is written, and the 202 omits `sessionId` rather than lying. The
   * poke stays evidenced through the control plane's `gateway_request` audit
   * record, which carries the same `reason`/`by` and IS covered by retention.
   *
   * Default `true` (the channel shape's behaviour).
   */
  readonly ownsSession?: boolean;
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
   * returns immediately — the caller answers 202 without waiting for a model
   * round-trip. `sessionId` is present only when the lane owns the session it
   * was minted for (see {@link ControlLaneOptions.ownsSession}); a lane that
   * does not returns none rather than a dangling id.
   */
  wake(args: { readonly reason: string; readonly by: string }): Promise<{
    readonly accepted: boolean;
    readonly sessionId?: string;
    /** Set when intake is closed: the tick did not start, and this is why. */
    readonly refused?: IntakeClosedCode;
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
  /**
   * The operator-record reader, for tests. Defaults to `readOperatorRecord`,
   * which `POST /control/v1/operator/reload` refreshes; an injected reader
   * that carries a `refresh` is refreshed too.
   */
  readonly operatorRead?: (harnessDir: string) => OperatorRead;
  /** The heartbeat's timer, for tests. Defaults to the global interval timer. */
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
  };
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
  /**
   * Register what `POST /control/v1/runs/claim` wakes: the follower that
   * claims queued runs. The last registration wins. While none is registered
   * the route answers 404 `claim_unsupported`, and `/status` lists no
   * `runs.create`.
   */
  onClaim(handler: () => void | Promise<void>): void;
  /**
   * Register how this process counts the runs it is running. The last
   * registration wins. On target `managed`, `/status` and the heartbeat
   * answer this count; a counter that throws or answers anything but a
   * non-negative safe integer reads as `null` ("could not determine"). Other
   * targets count their runs by run holds and ignore it.
   */
  onActiveRuns(count: () => number): void;
}

/**
 * Flatten untrusted text into ONE printable log-safe line.
 *
 * WHY THIS EXISTS. A daemon's stdout/stderr is not just for humans: the
 * manager PARSES it — the `[control] crewhaus.control.v1 listening on
 * http://host:port` announcement is the only way it learns a kernel-assigned
 * control port. Every prose line a daemon prints that interpolates text the
 * daemon did not author is therefore a log-injection surface: an operator's
 * `reason`, and — strictly worse, because it needs no operator at all — the
 * AGENT's own turn output, which a channel message can steer. A single
 * newline in either would let that text START a line, and a forged
 * announcement line is enough to repoint the manager's control calls (bearer
 * included) at an attacker-chosen port.
 *
 * So: every control character (C0, DEL + C1) and every Unicode line separator
 * is replaced with a space, whitespace runs collapse, and the result is capped
 * — one line, bounded, no matter what went in. Anchoring the manager's own
 * announcement regex to a line start is the other half of the same fix; this
 * half is what makes the anchor hold, because it guarantees untrusted text can
 * never begin a line.
 */
export function sanitizeControlText(value: string, maxLen: number = CONTROL_TEXT_MAX): string {
  const flattened = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > maxLen ? `${flattened.slice(0, maxLen)}…` : flattened;
}

export type DrainSweepOutcome = "done" | "timeout" | "failed" | "skipped";

function resolveDrainSweepBudgetMs(
  explicit: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  // An UNSET or empty env var is "not configured", not "skip" — `Number("")`
  // is 0, and a stray `CREWHAUS_DRAIN_SWEEP_MS=` must not silently disable
  // housekeeping.
  const raw = env[DRAIN_SWEEP_BUDGET_ENV];
  const candidate = explicit ?? (raw === undefined || raw === "" ? Number.NaN : Number(raw));
  if (!Number.isFinite(candidate) || candidate < 0) return DEFAULT_DRAIN_SWEEP_MS;
  return candidate;
}

/**
 * Run a BEST-EFFORT housekeeping step during a drain, under its own budget.
 *
 * WHY THIS EXISTS. A drain's contract is "stop intake, finish in-flight work,
 * exit 0", and a supervisor holds it to a deadline. A janitor sweep is not
 * in-flight work — it is housekeeping the next boot repeats — so letting it
 * sit inside that deadline spends the operator's whole drain budget on a step
 * nothing depends on, and the turn the drain existed to finish gets SIGTERM'd
 * anyway. Emitted drain steps therefore close their listeners FIRST and run
 * the sweep through here, last and time-boxed: a slow or wedged sweep can
 * cost at most `budgetMs`, and its failure is reported, never thrown.
 */
export async function runDrainSweep(
  step: () => Promise<unknown> | unknown,
  opts: {
    readonly budgetMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly onOutcome?: (outcome: DrainSweepOutcome, detail?: string) => void;
  } = {},
): Promise<DrainSweepOutcome> {
  const budgetMs = resolveDrainSweepBudgetMs(opts.budgetMs, opts.env ?? process.env);
  if (budgetMs === 0) {
    opts.onOutcome?.("skipped");
    return "skipped";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detail: string | undefined;
  try {
    const ran = (async (): Promise<DrainSweepOutcome> => {
      try {
        await step();
        return "done";
      } catch (err) {
        detail = (err as Error).message;
        return "failed";
      }
    })();
    const deadline = new Promise<DrainSweepOutcome>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs);
      // A finished sweep must not leave a live timer holding the loop open —
      // the drain exits explicitly, but this keeps the seam usable elsewhere.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([ran, deadline]);
    opts.onOutcome?.(outcome, detail);
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
 * Count parked approvals still awaiting a human, the way every other reader
 * counts them: `@crewhaus/session-store`'s `foldReadOnly` (first decision wins,
 * decision claims applied), then `effectiveDecisionState` says `pending`.
 *
 * A status endpoint is a read: polling it never rewrites an operator's
 * approvals, and `foldReadOnly` writes nothing. `filePath` names the approvals
 * file; its directory is the session root the claims sit beside. A missing or
 * unreadable file counts as nothing rather than failing the whole status call.
 */
export function countPendingApprovals(filePath: string): number {
  const folded = foldReadOnly(dirname(filePath));
  const now = Date.now();
  return folded.records.filter(
    (record) => effectiveDecisionState(record, null, now).state === "pending",
  ).length;
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

/**
 * The run scope a lane's tick runs in: resumable as `lane:<lane>`, started by
 * the lane's kind (`heartbeat` or `schedule`, the base of a named lane such as
 * `schedule:<name>`), marked `synthetic` when an operator woke it. A lane id no
 * scope can name gets none, and the tick still runs.
 */
function laneScope(lane: string, synthetic: boolean): RunScope {
  const kind = lane.split(":")[0] === "heartbeat" ? "heartbeat" : "schedule";
  const trigger = { kind, lane, ...(synthetic ? { synthetic: true as const } : {}) } as const;
  try {
    return { resumeScope: formatResumeScope({ kind: "lane", id: lane }), trigger };
  } catch {
    return { trigger: { kind, ...(synthetic ? { synthetic: true as const } : {}) } };
  }
}

export function createControlPlane(opts: ControlPlaneOptions): ControlPlane {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const stdout = opts.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = opts.stderr ?? ((line: string) => process.stderr.write(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const drainSettleMs = opts.drainSettleMs ?? 50;
  const readOperator = opts.operatorRead ?? readOperatorRecord;

  // A daemon whose operator disabled it, or whose operator record cannot be
  // read, does not start: it exits 38 here, before it binds anything.
  const boot = assertRunnable(cwd, { mode: "start", read: readOperator });
  const bootRefused = !boot.ok;
  if (!boot.ok) {
    stderr(
      boot.reason === "unreadable"
        ? "[control] operator record unreadable, not starting\n"
        : "[control] disabled by its operator, not starting\n",
    );
    exit(EXIT_CODES.disabled);
  }

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
  let claimHandler: (() => void | Promise<void>) | undefined;
  let activeRunsCounter: (() => number) | undefined;
  let heartbeatHandle: unknown;
  const heartbeatFailures = new Set<string>();
  const timers = opts.timers ?? {
    setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
    clearInterval: (handle: unknown): void =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };

  function laneCounterKey(lane: ControlLane): keyof ControlCounters {
    return lane === "heartbeat" ? "heartbeatTicks" : "scheduleWakes";
  }

  function makeLane(laneOpts: ControlLaneOptions): ControlLaneHandle {
    const armedAtMs = now();
    const ownsSession = laneOpts.ownsSession !== false;
    let busy = false;
    let inFlight: Promise<void> = Promise.resolve();
    let lastStartMs: number | undefined;
    let lastFiredAt: string | undefined;
    let lastOutcome: ControlOutcome | undefined;
    let lastSkipped: IntakeClosedCode | undefined;

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
      refused?: IntakeClosedCode;
    } {
      const closed = intakeClosed();
      if (closed !== undefined) {
        if (synthetic === undefined) {
          lastSkipped = closed;
          lastStartMs = now();
        }
        return { accepted: false, sessionId: "", done: Promise.resolve(), refused: closed };
      }
      if (busy) return { accepted: false, sessionId: "", done: inFlight };
      if (synthetic === undefined) lastSkipped = undefined;
      busy = true;
      const sessionId = mintSessionId();
      lastStartMs = now();
      lastFiredAt = new Date(lastStartMs).toISOString();
      counters[laneCounterKey(laneOpts.lane)] += 1;
      const done = (async () => {
        // The marker is a SESSION artifact, so it is written only by a lane
        // that owns the session — see `ownsSession`. A lane that does not gets
        // no orphan `.jsonl`; its evidence is the `gateway_request` record.
        if (synthetic !== undefined && ownsSession) {
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
          // The tick's runs are started by the lane and resume as the lane.
          // An operator's wake marks the trigger synthetic; its reason and
          // author stay in the marker and the audit record, never in a run row.
          await runWithScope(laneScope(laneOpts.lane, synthetic !== undefined), () =>
            laneOpts.run({
              sessionId,
              ...(synthetic !== undefined ? { synthetic } : {}),
            }),
          );
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
      async wake(args): Promise<{ accepted: boolean; sessionId?: string }> {
        // Sanitized HERE as well as at the router, because this handle is
        // public API: a target that pokes a lane directly must not be able to
        // push a newline into the daemon's own prose log either.
        const started = start({
          reason: sanitizeControlText(args.reason),
          by: sanitizeControlText(args.by),
        });
        // Deliberately NOT awaiting `started.done`: the operator gets a 202
        // and the session id, and the tick runs on its own.
        void started.done;
        return {
          accepted: started.accepted,
          ...(started.accepted && ownsSession ? { sessionId: started.sessionId } : {}),
          ...(started.refused !== undefined ? { refused: started.refused } : {}),
        };
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
          ...(lastSkipped !== undefined ? { skipped: lastSkipped } : {}),
        };
      },
    };
    return handle;
  }

  /** The code new work is refused with while the operator record closes intake. */
  function intakeClosed(): IntakeClosedCode | undefined {
    const verdict = intakeVerdict(cwd, { read: readOperator });
    return verdict.state === "closed" ? verdict.code : undefined;
  }

  /** What `/status`, the heartbeat and a reload answer about the operator record. */
  function operatorState(): {
    readonly rev: number | null;
    readonly paused: boolean;
    readonly disabled: boolean;
    readonly unreadable: boolean;
  } {
    const read = readOperator(cwd);
    if (read.state === "unreadable") {
      // An unreadable record counts as paused, and stops a start.
      return { rev: null, paused: true, disabled: false, unreadable: true };
    }
    if (read.state === "absent") {
      return { rev: null, paused: false, disabled: false, unreadable: false };
    }
    return {
      rev: read.record.rev,
      paused: read.record.intake?.paused === true,
      disabled: read.record.deployment?.disabled === true,
      unreadable: false,
    };
  }

  /** Whether this process records run rows (`CREWHAUS_RUN_LEDGER=0` turns them off). */
  function runLedgerOn(): boolean {
    return env["CREWHAUS_RUN_LEDGER"] !== "0";
  }

  /**
   * Runs this process is running, or `null` where it cannot count them. A
   * managed plane answers its registered counter (with run rows on or off),
   * and `null` while none is registered or when the counter throws or answers
   * anything but a non-negative safe integer. Every other shape counts run
   * holds, and answers `null` with run rows off (such a run takes no hold).
   */
  function activeRuns(): number | null {
    if (opts.target === "managed") {
      if (activeRunsCounter === undefined) return null;
      let count: unknown;
      try {
        count = activeRunsCounter();
      } catch {
        return null;
      }
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
    }
    return !runLedgerOn() ? null : activeRunCount();
  }

  /** The controls `/status` says this daemon supports. */
  function capabilities(): CapabilityName[] {
    return [
      ...(opts.target === "voice" ? [] : (["controls.pauseIntake"] as const)),
      "controls.cancelRun",
      "controls.drain",
      "controls.disable",
      ...(runLedgerOn() ? (["runs.ledger"] as const) : []),
      ...(claimHandler !== undefined ? (["runs.create"] as const) : []),
    ];
  }

  /** Write one heartbeat; a failure is one stderr line per reason, never a throw. */
  function beat(): void {
    const operator = operatorState();
    const written = writeHeartbeat(cwd, {
      v: 1,
      pid: opts.pid ?? process.pid,
      at: new Date(now()).toISOString(),
      operatorRev: operator.rev,
      paused: operator.paused,
      disabled: operator.disabled,
      operatorUnreadable: operator.unreadable,
      activeRuns: activeRuns(),
      runLedger: runLedgerOn(),
    });
    if (!written.ok && !heartbeatFailures.has(written.reason)) {
      heartbeatFailures.add(written.reason);
      stderr(`[control] heartbeat not written: ${sanitizeControlText(written.reason)}\n`);
    }
  }

  function startHeartbeat(): void {
    if (heartbeatHandle !== undefined) return;
    beat();
    heartbeatHandle = timers.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    (heartbeatHandle as { unref?: () => void } | null)?.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatHandle === undefined) return;
    timers.clearInterval(heartbeatHandle);
    heartbeatHandle = undefined;
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
      operator: operatorState(),
      capabilities: capabilities(),
      activeRuns: activeRuns(),
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
          stopHeartbeat();
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
    readonly reason?: string;
    readonly by?: string;
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
    // THE control-plane trust boundary for operator free-text. `reason`/`by`
    // are echoed into the daemon's prose stdout, which the manager PARSES for
    // the control-port announcement — so they are flattened to one bounded
    // line here, before they can reach a log line, a marker record or the 202.
    const cleanReason = typeof parsed.reason === "string" ? sanitizeControlText(parsed.reason) : "";
    const cleanBy = typeof parsed.by === "string" ? sanitizeControlText(parsed.by) : "";
    const reason = cleanReason !== "" ? cleanReason : "operator wake";
    const by = cleanBy !== "" ? cleanBy : CONTROL_PROTOCOL;
    const outcome = await handle.wake({ reason, by });
    if (outcome.refused !== undefined) {
      // Intake is closed by the operator record: no new tick starts until it opens.
      return {
        lane,
        reason,
        by,
        res: jsonResponse(
          {
            error: `this daemon is ${outcome.refused} by its operator — no new ticks start`,
            code: outcome.refused,
            lane,
          },
          409,
        ),
      };
    }
    if (!outcome.accepted) {
      // Ticks never overlap themselves — armSchedule's re-arm-after-resolve
      // rule applies to operator pokes too.
      return {
        lane,
        reason,
        by,
        res: jsonResponse(
          { error: `a ${lane} tick is already in flight`, code: "tick_in_flight", lane },
          409,
        ),
      };
    }
    return {
      lane,
      reason,
      by,
      ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
      res: jsonResponse(
        {
          // Present ONLY when the lane threads it into a real session. Omitted
          // rather than dangling on the fan-out/producer shapes.
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
          lane,
          reason,
          synthetic: true,
        },
        202,
      ),
    };
  }

  /** One audited record for a control call, never carrying a credential. */
  function audited(
    req: Request,
    path: string,
    status: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return audit({
      protocol: CONTROL_PROTOCOL,
      route: path,
      method: req.method,
      authorized: true,
      status,
      ...extra,
    });
  }

  /**
   * `POST /control/v1/runs/{runId}/cancel`: signal the abort of a run this
   * process is running (run-context `cancelRun`). A 202 means this process
   * signalled the run's abort; a run whose controller this process still
   * keeps after the run ended, as a managed run's can be, answers 202 too. A
   * run this process is not running, a parked one included, answers 404
   * `run_not_active`. Served while draining, paused or disabled. The body is
   * not read.
   */
  async function handleCancel(req: Request, path: string, runId: string): Promise<Response> {
    if (!CANONICAL_RUN_ID_RE.test(runId)) {
      await audited(req, path, 400);
      return jsonResponse(
        { error: "cancel needs a crewhaus run id: run_ and 26 characters", code: "bad_request" },
        400,
      );
    }
    if (cancelRun(runId)) {
      await audited(req, path, 202, { runId });
      return jsonResponse({ runId, cancelled: true }, 202);
    }
    await audited(req, path, 404, { runId });
    return jsonResponse(
      { error: `this daemon is not running run ${runId}`, code: "run_not_active", runId },
      404,
    );
  }

  /**
   * `POST /control/v1/operator/reload`: read the operator record now, through
   * the default reader and through an injected reader that can refresh, and
   * answer what is enforced from here on. The body is not read.
   */
  async function handleReload(req: Request, path: string): Promise<Response> {
    refreshOperatorRecord(cwd);
    const injected = opts.operatorRead as { readonly refresh?: unknown } | undefined;
    if (typeof injected?.refresh === "function") {
      (injected.refresh as (harnessDir: string) => OperatorRead)(cwd);
    }
    const operator = operatorState();
    await audited(req, path, 200, { rev: operator.rev });
    return jsonResponse({ operator }, 200);
  }

  /**
   * `POST /control/v1/runs/claim`: wake the registered queued-runs follower
   * without waiting for it. 404 `claim_unsupported` while none is registered;
   * 409 while draining or while intake is closed, and the follower is not
   * woken. The body is not read.
   */
  async function handleClaim(req: Request, path: string): Promise<Response> {
    const follower = claimHandler;
    if (follower === undefined) {
      await audited(req, path, 404);
      return jsonResponse(
        { error: "this daemon runs no queued runs", code: "claim_unsupported" },
        404,
      );
    }
    if (draining) {
      await audited(req, path, 409, { code: "draining" });
      return jsonResponse(
        { error: "daemon is draining — no new work accepted", code: "draining" },
        409,
      );
    }
    const closed = intakeClosed();
    if (closed !== undefined) {
      await audited(req, path, 409, { code: closed });
      return jsonResponse(
        { error: `this daemon is ${closed} by its operator — no new work starts`, code: closed },
        409,
      );
    }
    void (async () => {
      try {
        await follower();
      } catch (err) {
        stderr(`[control] claim failed: ${sanitizeControlText((err as Error).message)}\n`);
      }
    })();
    await audited(req, path, 202);
    return jsonResponse({ claimed: "requested" }, 202);
  }

  type RouteHandler = (
    req: Request,
    path: string,
    params: Readonly<Record<string, string>>,
  ) => Promise<Response>;

  /** One handler per listed route: a route missing here does not compile. */
  const ROUTE_HANDLERS: Readonly<Record<ControlRoute["route"], RouteHandler>> = {
    "/control/v1/healthz": async () =>
      // A successful read is not audited: a liveness probe would fill the log.
      jsonResponse({ ok: true, name: opts.name, target: opts.target }, 200),
    "/control/v1/status": async () => jsonResponse(await statusBody(), 200),
    "/control/v1/wake": async (req, path) => {
      const outcome = await handleWake(req);
      await audited(req, path, outcome.res.status, {
        ...(outcome.lane !== undefined ? { lane: outcome.lane } : {}),
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        // The poke's provenance rides the hash-chained audit log — the record
        // that IS covered by the harness's retention policy — so a lane with
        // no session of its own is still evidenced.
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.by !== undefined ? { by: outcome.by } : {}),
      });
      return outcome.res;
    },
    "/control/v1/drain": async (req, path) => {
      const already = draining;
      if (!already) beginDrain();
      await audited(req, path, 202, { alreadyDraining: already });
      return jsonResponse({ draining: true, alreadyDraining: already }, 202);
    },
    "/control/v1/runs/{runId}/cancel": (req, path, params) =>
      handleCancel(req, path, params["runId"] ?? ""),
    "/control/v1/operator/reload": (req, path) => handleReload(req, path),
    "/control/v1/runs/claim": (req, path) => handleClaim(req, path),
  };

  /** The listed route `method` and `path` name, with its `{param}` segments. */
  function matchRoute(
    method: string,
    path: string,
  ): { readonly route: ControlRoute; readonly params: Record<string, string> } | undefined {
    const parts = path.split("/");
    for (const route of CONTROL_ROUTES) {
      if (route.method !== method) continue;
      const pattern = route.route.split("/");
      if (pattern.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const matches = pattern.every((segment, i) => {
        const part = parts[i] ?? "";
        if (segment.startsWith("{") && segment.endsWith("}")) {
          params[segment.slice(1, -1)] = part;
          return part !== "";
        }
        return segment === part;
      });
      if (matches) return { route, params };
    }
    return undefined;
  }

  async function fetchControl(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(CONTROL_PATH_PREFIX)) {
      return jsonResponse({ error: "not found", code: "not_found" }, 404);
    }
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

    const matched = matchRoute(req.method, path);
    if (matched !== undefined) {
      return ROUTE_HANDLERS[matched.route.route](req, path, matched.params);
    }

    await audited(req, path, 404);
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
      if (bootRefused) return undefined;
      // Whether or not a control port is configured: this process serves this
      // harness's control plane, and says it is alive.
      registerIntakeRoot(cwd);
      startHeartbeat();
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
      const envToken = env[CONTROL_TOKEN_ENV];
      if (!isLoopbackBind(bind) && (envToken === undefined || envToken === "")) {
        // Checked before the token is resolved, so no token file is minted for
        // a socket that will not open.
        stderr(
          `[control] ${CONTROL_BIND_ENV}="${sanitizeControlText(bind)}" is beyond this computer` +
            ` and ${CONTROL_TOKEN_ENV} is not set — control.v1 not served\n`,
        );
        return undefined;
      }
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
      stopHeartbeat();
      unregisterIntakeRoot(cwd);
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

    onClaim(handler): void {
      claimHandler = handler;
    },

    onActiveRuns(count): void {
      activeRunsCounter = count;
    },
  };
}
