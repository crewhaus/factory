/**
 * The `crewhaus.control.v1` client the manager proxies through.
 *
 * The wire contract lives in `@crewhaus/gateway-protocol/control` and is
 * imported here rather than restated: the prefix, the protocol id, and the
 * refusal codes must never drift between the daemon that serves them and the
 * manager that reads them.
 *
 * It lives beside the daemon side of the protocol so that every head — the
 * manager, `crewhaus daemon`, and anything else that drives a daemon — can
 * share one client without depending on the manager's HTTP server.
 * `@crewhaus/hangar-server` still re-exports it, for one release.
 *
 * THREE THINGS THIS MODULE EXISTS TO GET RIGHT.
 *
 *   1. **The bearer never reaches the browser.** The token is read off
 *      `<harness>/.crewhaus/run/control-token` (0600) at call time, on the
 *      server, and is never part of any payload this returns. It is re-read
 *      on EVERY call because a daemon mints a fresh token each boot — a
 *      cached token 401s against its own replacement.
 *   2. **Absence is not an error.** A daemon with no control port is a
 *      pre-0.5.0 bundle, not a fault: the outcome is `no_control_port` with
 *      an operator-facing reason, and the UI renders the poke controls
 *      disabled-with-reason instead of an error toast. `lane_not_armed`
 *      (404) is the same shape of fact — that spec armed no such lane.
 *   3. **The two 409s mean opposite things.** `tick_in_flight` is "come back
 *      in a second" (retryable); `draining` is "this daemon is going away"
 *      (not retryable). Collapsing them into one "conflict" would tell an
 *      operator to retry into a process that is exiting.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLaneId } from "@crewhaus/control-contract";
import {
  CONTROL_PATH_PREFIX,
  CONTROL_PROTOCOL,
  CONTROL_RUN_DIR,
  CONTROL_TOKEN_FILENAME,
  type ControlLane,
  type ControlTimerReport,
  DEFAULT_CONTROL_BIND,
} from "./control";

export type { ControlLane, ControlTimerReport };

/**
 * The two fixed lane ids. A daemon may also arm one `schedule:<name>` lane per
 * named schedule (#513), which this list does not hold: {@link isControlLane}
 * is the test for any lane id.
 */
export const CONTROL_LANES: readonly ControlLane[] = ["heartbeat", "schedule"];

/** `heartbeat`, `schedule` or `schedule:<name>`: the daemon's own check, so the two cannot drift. */
export function isControlLane(value: string): value is ControlLane {
  return isLaneId(value);
}

/** Why a control call did not succeed. Every one is renderable as a sentence. */
export type ControlRefusalCode =
  /** No control port is known for this harness — a pre-0.5.0 bundle, or a
   *  daemon that is not running. Not an error. */
  | "no_control_port"
  /** Port known, but no readable `control-token` — the daemon has not minted
   *  one yet (it mints at bind) or the file is not ours to read. */
  | "no_control_token"
  /** Connect refused / timed out. */
  | "unreachable"
  /** 404 `lane_not_armed` — this spec armed no such lane. Not an error. */
  | "lane_not_armed"
  /** 409 `tick_in_flight` — a tick is running; retry shortly. */
  | "tick_in_flight"
  /** 409 `draining` — the daemon is shutting down; do not retry. */
  | "draining"
  /** 409 `paused` — the operator paused new work; a tick starts once it is resumed. */
  | "paused"
  /** 409 `disabled` — the operator disabled this harness; nothing new starts. */
  | "disabled"
  /** 404 on a route this daemon's build does not serve (`operator/reload` on a bundle
   *  built before it). A fact about the bundle: rebuild it to get the route. */
  | "unsupported_by_bundle"
  /** 401 — the token on disk is not the one the daemon is using. */
  | "unauthorized"
  /** Anything else the daemon answered. */
  | "error";

export type ControlOk<T> = {
  readonly ok: true;
  readonly status: number;
  readonly body: T;
};

export type ControlRefusal = {
  readonly ok: false;
  readonly code: ControlRefusalCode;
  /** Upstream HTTP status, or 0 when the call never reached the wire. */
  readonly status: number;
  /** Operator-facing sentence. Never contains the token. */
  readonly reason: string;
  readonly lane?: ControlLane;
  /** True only for `tick_in_flight`: the same call may succeed shortly. */
  readonly retryable: boolean;
  /** True when this is a fact about the bundle rather than a fault — the UI
   *  renders the control disabled-with-reason, not an error. */
  readonly expected: boolean;
};

export type ControlResult<T> = ControlOk<T> | ControlRefusal;

/** The `/control/v1/status` body, as the daemon's `statusBody()` builds it. */
export type ControlStatusBody = {
  readonly protocol: string;
  readonly name: string;
  readonly target: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly draining: boolean;
  readonly counters: {
    readonly turns: number;
    readonly heartbeatTicks: number;
    readonly scheduleWakes: number;
    readonly janitorRuns: number;
  };
  readonly timers: readonly ControlTimerReport[];
  readonly channels: readonly string[];
  readonly pendingApprovals: number;
  /** The operator record this daemon enforces. Absent from a bundle built before it. */
  readonly operator?: {
    readonly rev: number | null;
    readonly paused: boolean;
    readonly disabled: boolean;
    readonly unreadable: boolean;
  };
  /** The controls this daemon supports. Absent from a bundle built before it. */
  readonly capabilities?: readonly string[];
  /** Runs it is running, `null` where it cannot count them. Absent from an older bundle. */
  readonly activeRuns?: number | null;
};

export type ControlWakeBody = {
  readonly sessionId: string;
  readonly lane: ControlLane;
  readonly reason: string;
  readonly synthetic: true;
};

export type ControlDrainBody = {
  readonly draining: true;
  readonly alreadyDraining: boolean;
};

/** The `/control/v1/operator/reload` body: the operator record the daemon enforces now. */
export type ControlReloadBody = {
  readonly operator: {
    readonly rev: number | null;
    readonly paused: boolean;
    readonly disabled: boolean;
    readonly unreadable: boolean;
  };
};

/** Where to reach one harness's control plane. */
export type ControlTarget = {
  readonly harnessDir: string;
  /** From the runfile, or parsed off the boot log. Absent ⇒ no control. */
  readonly controlPort?: number | undefined;
  /** Bind host; loopback unless the operator widened it. */
  readonly bind?: string;
};

export type ControlClientOptions = {
  /** Injected in tests (a stub control server is still a real fetch, but a
   *  seam keeps offline suites honest). */
  readonly fetch?: typeof fetch;
  /** Per-call timeout. Control calls answer immediately by contract —
   *  `/wake` returns 202 without awaiting the tick. */
  readonly timeoutMs?: number;
  /** Token reader seam; defaults to reading the 0600 file. */
  readonly readToken?: (harnessDir: string) => string | undefined;
};

export type ControlClient = {
  status(target: ControlTarget): Promise<ControlResult<ControlStatusBody>>;
  wake(
    target: ControlTarget,
    args: { readonly lane: ControlLane; readonly reason?: string; readonly by?: string },
  ): Promise<ControlResult<ControlWakeBody>>;
  drain(target: ControlTarget): Promise<ControlResult<ControlDrainBody>>;
  /**
   * Ask the daemon to read the operator record now. A bundle built before the route
   * answers 404, which is `unsupported_by_bundle`: the record is written, and that
   * build does not enforce it.
   */
  reload(target: ControlTarget): Promise<ControlResult<ControlReloadBody>>;
  /**
   * Signal the abort of a run the daemon is running. A run it is not running, a parked
   * one included, answers 404 `run_not_active`, read as `error` with that reason.
   */
  cancelRun(target: ControlTarget, runId: string): Promise<ControlResult<ControlCancelBody>>;
  /**
   * Wake the daemon's queued-runs follower now. A daemon with no follower answers 404
   * `claim_unsupported`, read as `unsupported_by_bundle`.
   */
  claimRuns(target: ControlTarget): Promise<ControlResult<ControlClaimBody>>;
};

/** The `/control/v1/runs/{id}/cancel` body. */
export type ControlCancelBody = { readonly runId: string; readonly cancelled: true };

/** The `/control/v1/runs/claim` body. */
export type ControlClaimBody = Readonly<Record<string, unknown>>;

export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

/**
 * The boot line every control-serving daemon prints on stdout. The manager
 * passes `CREWHAUS_CONTROL_PORT=0` (kernel-assigned) so it never has to
 * reserve a number in advance, which makes THIS the only way to learn the
 * port. Matched off the log pump's prose.
 */
export const CONTROL_LISTENING_RE = new RegExp(
  `\\[control\\] ${CONTROL_PROTOCOL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} listening on https?://[^\\s/:]+:(\\d{1,5})`,
);

/**
 * Normalize a recorded control port.
 *
 * The runfile records what the PLAN asked for, and the plan asks for `0` —
 * "kernel, pick one". A literal 0 is therefore "not known yet", never a
 * reachable port, and rendering it as `127.0.0.1:0` would promise an
 * operator a wake/drain that cannot work.
 */
export function knownControlPort(port: number | undefined): number | undefined {
  return port !== undefined && Number.isInteger(port) && port > 0 ? port : undefined;
}

/** The control port a chunk of captured daemon output announces, if any. */
export function parseControlPort(text: string): number | undefined {
  const m = text.match(CONTROL_LISTENING_RE);
  if (m === null) return undefined;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Read the boot-minted bearer. Never cached — a stale token 401s.
 *
 * The path is built from the two constants `resolveControlToken` writes the
 * file with, so the reader sits beside the writer and cannot drift from it.
 * It is the same path as harness-supervisor's `controlTokenPath`, which a
 * supervisor records in the runfile, and a test holds the two together.
 */
function readTokenFile(harnessDir: string): string | undefined {
  try {
    const token = readFileSync(
      join(harnessDir, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME),
      "utf8",
    ).trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

const refusal = (
  code: ControlRefusalCode,
  status: number,
  reason: string,
  extra: { readonly lane?: ControlLane } = {},
): ControlRefusal => ({
  ok: false,
  code,
  status,
  reason,
  ...(extra.lane !== undefined ? { lane: extra.lane } : {}),
  retryable: code === "tick_in_flight",
  expected:
    code === "no_control_port" ||
    code === "lane_not_armed" ||
    code === "draining" ||
    code === "paused" ||
    code === "disabled" ||
    code === "unsupported_by_bundle",
});

/** Map a non-2xx control response onto a typed refusal. */
function classifyFailure(status: number, body: unknown, lane?: ControlLane): ControlRefusal {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record["code"] === "string" ? record["code"] : "";
  const message = typeof record["error"] === "string" ? record["error"] : `HTTP ${status}`;
  const withLane = lane !== undefined ? { lane } : {};
  if (status === 404 && code === "lane_not_armed") {
    return refusal(
      "lane_not_armed",
      status,
      `this bundle armed no ${lane ?? "such"} lane — the spec declares no such schedule`,
      withLane,
    );
  }
  if (status === 409 && code === "tick_in_flight") {
    return refusal(
      "tick_in_flight",
      status,
      `a ${lane ?? "lane"} tick is already running`,
      withLane,
    );
  }
  if (status === 409 && code === "draining") {
    return refusal("draining", status, "the daemon is draining — it accepts no new work", withLane);
  }
  if (status === 409 && code === "paused") {
    return refusal(
      "paused",
      status,
      "the daemon's operator paused new work — it starts nothing new until resumed",
      withLane,
    );
  }
  if (status === 409 && code === "disabled") {
    return refusal(
      "disabled",
      status,
      "the daemon's operator disabled this harness — it starts nothing new",
      withLane,
    );
  }
  if (status === 401) {
    return refusal(
      "unauthorized",
      status,
      "the control token on disk was refused — the daemon reminted it at boot; restart the manager's view",
      withLane,
    );
  }
  return refusal("error", status, message, withLane);
}

export function createControlClient(options: ControlClientOptions = {}): ControlClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const readToken = options.readToken ?? readTokenFile;

  const call = async <T>(
    target: ControlTarget,
    route: string,
    init: {
      readonly method: string;
      readonly body?: unknown;
      /** A 404 here means the bundle has no such route. */
      readonly notFoundIsBundle?: boolean;
    },
    lane?: ControlLane,
  ): Promise<ControlResult<T>> => {
    const port = target.controlPort;
    if (port === undefined || !Number.isInteger(port) || port <= 0) {
      return refusal(
        "no_control_port",
        0,
        "no control port — the daemon is not running, or its bundle predates crewhaus.control.v1 (recompile to enable wake/drain)",
        lane !== undefined ? { lane } : {},
      );
    }
    const token = readToken(target.harnessDir);
    if (token === undefined) {
      return refusal(
        "no_control_token",
        0,
        "the daemon has not minted .crewhaus/run/control-token yet — it is written when the control port binds",
        lane !== undefined ? { lane } : {},
      );
    }
    const url = `http://${target.bind ?? DEFAULT_CONTROL_BIND}:${port}${CONTROL_PATH_PREFIX}${route}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return refusal(
        "unreachable",
        0,
        `control plane unreachable on port ${port}: ${err instanceof Error ? err.message : String(err)}`,
        lane !== undefined ? { lane } : {},
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok && res.status === 404 && init.notFoundIsBundle === true) {
      return refusal(
        "unsupported_by_bundle",
        404,
        "this daemon's build predates the route — recompile it to enable it",
      );
    }
    if (!res.ok) return classifyFailure(res.status, body, lane);
    return { ok: true, status: res.status, body: body as T };
  };

  return {
    status: (target) => call<ControlStatusBody>(target, "/status", { method: "GET" }),
    wake: (target, args) =>
      call<ControlWakeBody>(
        target,
        "/wake",
        {
          method: "POST",
          body: {
            lane: args.lane,
            ...(args.reason !== undefined && args.reason !== "" ? { reason: args.reason } : {}),
            by: args.by ?? "hangar",
          },
        },
        args.lane,
      ),
    // 202 + the process exits 0 shortly after. The caller MUST record that
    // exit as an operator stop, or the supervisor reads a graceful drain as
    // "exited cleanly (unexpected)" and restarts what was just shut down.
    drain: (target) => call<ControlDrainBody>(target, "/drain", { method: "POST" }),
    reload: (target) =>
      call<ControlReloadBody>(target, "/operator/reload", {
        method: "POST",
        notFoundIsBundle: true,
      }),
    cancelRun: (target, runId) =>
      call<ControlCancelBody>(target, `/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      }),
    claimRuns: (target) =>
      call<ControlClaimBody>(target, "/runs/claim", { method: "POST", notFoundIsBundle: true }),
  };
}
