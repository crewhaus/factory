/**
 * Module-level coverage for `crewhaus.control.v1`: the router, the bearer
 * gate, the never-overlap wake semantics and the drain sequence. Everything
 * here runs against `plane.fetch(Request)` — no socket, no daemon, no timers
 * — which is exactly why the plane exposes `fetch` separately from `start`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_NAMES, mintRunId } from "@crewhaus/control-contract";
import { type OperatorRead, createOperatorReader, intakeRoot } from "@crewhaus/control-records";
import {
  type RunContext,
  activeRunCount,
  createRunContext,
  isCancelReason,
  retainRun,
} from "@crewhaus/run-context";
import {
  allowSingleOwner,
  createPendingApprovalStore,
  generateApprovalId,
} from "@crewhaus/session-store";
import {
  CONTROL_PATH_PREFIX,
  CONTROL_PROTOCOL,
  CONTROL_ROUTES,
  CONTROL_RUN_DIR,
  CONTROL_TEXT_MAX,
  CONTROL_TOKEN_FILENAME,
  type ControlAuditRecord,
  type ControlPlane,
  type ControlPlaneOptions,
  DEFAULT_DRAIN_SWEEP_MS,
  DRAIN_RETRY_AFTER_SECONDS,
  DRAIN_SWEEP_BUDGET_ENV,
  HEARTBEAT_INTERVAL_MS,
  constantTimeEquals,
  countPendingApprovals,
  createControlPlane,
  isLoopbackBind,
  resolveControlToken,
  runDrainSweep,
  sanitizeControlText,
} from "./control";

let tmp: string;
let sessions: string;
// Built from parts so no realistic-shaped credential literal lands in the repo.
const TOKEN = ["ctl", "0".repeat(8), "abcd"].join("-");

/**
 * Every plane a test builds. `start()` names this process's intake root and arms the
 * heartbeat timer, and `bun test` runs every file of the package in one process, so
 * each plane is stopped after its test.
 */
const planes: ControlPlane[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-control-"));
  sessions = join(tmp, "sessions");
});
afterEach(async () => {
  for (const plane of planes.splice(0)) await plane.stop();
  rmSync(tmp, { recursive: true, force: true });
});

type Harness = {
  readonly plane: ControlPlane;
  readonly audits: ControlAuditRecord[];
  readonly exits: number[];
  readonly out: string[];
};

function harness(over: Partial<ControlPlaneOptions> = {}): Harness {
  const audits: ControlAuditRecord[] = [];
  const exits: number[] = [];
  const out: string[] = [];
  const plane = createControlPlane({
    name: "acme-bot",
    target: "channel",
    cwd: tmp,
    env: { CREWHAUS_CONTROL_TOKEN: TOKEN },
    sessionRootDir: sessions,
    audit: (rec) => {
      audits.push(rec);
    },
    exit: (code) => {
      exits.push(code);
    },
    stdout: (line) => {
      out.push(line);
    },
    stderr: () => {},
    drainSettleMs: 1,
    ...over,
  });
  planes.push(plane);
  return { plane, audits, exits, out };
}

function req(path: string, init: RequestInit & { bearer?: string | null } = {}): Request {
  const { bearer, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer ?? TOKEN}`);
  return new Request(`http://127.0.0.1:9999${path}`, { ...rest, headers });
}

const wakeBody = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

describe("control token", () => {
  test("CREWHAUS_CONTROL_TOKEN wins and nothing is written to disk", () => {
    const resolvedToken = resolveControlToken({ cwd: tmp, env: { CREWHAUS_CONTROL_TOKEN: TOKEN } });
    expect(resolvedToken).toEqual({ token: TOKEN, source: "env" });
    expect(readdirSync(tmp)).not.toContain(".crewhaus");
  });

  test("mints a 0600 token under .crewhaus/run when the env is unset", () => {
    const first = resolveControlToken({ cwd: tmp, env: {} });
    expect(first.source).toBe("file");
    expect(first.path).toBe(join(tmp, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME));
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    // Mode 0600 — a local manager reads it, nobody else on the box does.
    expect(statSync(first.path as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(first.path as string, "utf-8").trim()).toBe(first.token);
  });

  test("mints a FRESH token each boot so a dead daemon's token cannot be replayed", () => {
    const first = resolveControlToken({ cwd: tmp, env: {} });
    const second = resolveControlToken({ cwd: tmp, env: {} });
    expect(second.token).not.toBe(first.token);
    expect(statSync(second.path as string).mode & 0o777).toBe(0o600);
  });

  test("constantTimeEquals compares by value across differing lengths", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcdefghijkl")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("auth", () => {
  test("401s without a bearer and advertises the scheme", async () => {
    const { plane } = harness();
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`, { bearer: null }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer realm="${CONTROL_PROTOCOL}"`);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" });
  });

  test("401s on a wrong bearer", async () => {
    const { plane } = harness();
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`, { bearer: `${TOKEN}x` }));
    expect(res.status).toBe(401);
  });

  test("a rejected call is audited, and the presented credential never lands in the record", async () => {
    const { plane, audits } = harness();
    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`, { bearer: "guessed-secret" }));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.kind).toBe("gateway_request");
    expect(audits[0]?.payload).toMatchObject({ authorized: false, status: 401 });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("guessed-secret");
    expect(serialized).not.toContain(TOKEN);
  });

  test("paths outside the control prefix 404 without consulting the token", async () => {
    const { plane, audits } = harness();
    const res = await plane.fetch(req("/status", { bearer: null }));
    expect(res.status).toBe(404);
    expect(audits).toHaveLength(0);
  });
});

describe("healthz + status", () => {
  test("healthz answers ok/name/target", async () => {
    const { plane } = harness();
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "acme-bot", target: "channel" });
  });

  test("status reports counters, lane timers, channels and parked approvals", async () => {
    const { plane } = harness({
      channels: () => ["slack", "telegram"],
      pendingApprovals: () => 3,
      now: () => 1_000_000,
    });
    plane.lane({
      lane: "heartbeat",
      cadence: "every 60000ms",
      everyMs: 60_000,
      run: async () => {},
    });
    plane.timer(() => ({ lane: "janitor", cadence: "every 3600000ms", lastOutcome: "ok" }));
    plane.counters.turns = 7;
    plane.counters.janitorRuns = 1;

    const body = (await (await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`))).json()) as {
      counters: Record<string, number>;
      timers: Array<Record<string, unknown>>;
      channels: string[];
      pendingApprovals: number;
      target: string;
      pid: number;
    };
    expect(body.counters).toEqual({
      turns: 7,
      heartbeatTicks: 0,
      scheduleWakes: 0,
      janitorRuns: 1,
    });
    expect(body.channels).toEqual(["slack", "telegram"]);
    expect(body.pendingApprovals).toBe(3);
    expect(body.target).toBe("channel");
    expect(body.pid).toBe(process.pid);
    // The heartbeat's next fire is knowable ONLY in-process — this projection
    // is the entire reason /status exists.
    expect(body.timers).toEqual([
      { lane: "heartbeat", cadence: "every 60000ms", nextDueAt: new Date(1_060_000).toISOString() },
      { lane: "janitor", cadence: "every 3600000ms", lastOutcome: "ok" },
    ]);
  });

  test("a throwing pendingApprovals reader degrades to 0 instead of failing the call", async () => {
    const { plane } = harness({
      pendingApprovals: () => {
        throw new Error("store unavailable");
      },
    });
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pendingApprovals: number }).pendingApprovals).toBe(0);
  });
});

describe("wake", () => {
  describe("named schedule lanes (#513, #514)", () => {
    const twoLanes = (plane: ControlPlane, ran: Record<string, number>) =>
      ["discovery", "weekly-report"].map((name) =>
        plane.lane({
          lane: `schedule:${name}`,
          cadence: name === "discovery" ? "every 7200000ms" : 'cron "0 17 * * 5" Europe/Berlin',
          ownsSession: false,
          run: async () => {
            ran[name] = (ran[name] ?? 0) + 1;
          },
        }),
      );

    test("/status lists each named lane with its cadence", async () => {
      const { plane } = harness();
      twoLanes(plane, {});
      const body = (await (await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`))).json()) as {
        timers: Array<{ lane: string; cadence: string }>;
      };
      expect(body.timers.map(({ lane, cadence }) => ({ lane, cadence }))).toEqual([
        { lane: "schedule:discovery", cadence: "every 7200000ms" },
        { lane: "schedule:weekly-report", cadence: 'cron "0 17 * * 5" Europe/Berlin' },
      ]);
    });

    test("a wake runs that lane's tick and no other, and counts as a schedule wake", async () => {
      const { plane } = harness();
      const ran: Record<string, number> = {};
      const [discovery] = twoLanes(plane, ran);
      const res = await plane.fetch(
        req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule:discovery" })),
      );
      expect(res.status).toBe(202);
      expect(((await res.json()) as { lane: string }).lane).toBe("schedule:discovery");
      await discovery?.settled();
      expect(ran).toEqual({ discovery: 1 });
      expect(plane.counters.scheduleWakes).toBe(1);
    });

    test("the bare schedule lane is not armed when only named lanes are", async () => {
      const { plane } = harness();
      twoLanes(plane, {});
      const res = await plane.fetch(
        req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule" })),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("lane_not_armed");
    });

    for (const lane of ["schedule:Bad", "schedule:", "dream", "schedule:a_b", 7]) {
      test(`refuses ${JSON.stringify(lane)} as no lane id`, async () => {
        const { plane } = harness();
        twoLanes(plane, {});
        const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane })));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("bad_request");
        expect(body.error).toContain("schedule:<name>");
      });
    }

    test("lane() refuses an id outside the grammar and a second registration", () => {
      const { plane } = harness();
      twoLanes(plane, {});
      const register = (lane: string) => () =>
        plane.lane({ lane: lane as "schedule", cadence: "every 1ms", run: async () => {} });
      expect(register("schedule:discovery")).toThrow(/already registered/);
      expect(register("schedule:Bad")).toThrow(TypeError);
      expect(register("schedule:Bad")).toThrow(/not a lane id/);
      expect(register("heartbeat")).not.toThrow();
      expect(register("heartbeat")).toThrow(/already registered/);
    });
  });

  test("rejects a lane the protocol does not define", async () => {
    const { plane } = harness();
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "janitor" })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_request");
  });

  test("404s a lane this bundle never armed", async () => {
    const { plane } = harness();
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule" })),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("lane_not_armed");
  });

  test("202s with the minted session id and drives the IDENTICAL tick body", async () => {
    const seen: Array<{ sessionId: string; synthetic: unknown }> = [];
    const { plane } = harness();
    const lane = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      everyMs: 1000,
      run: async (ctx) => {
        seen.push({ sessionId: ctx.sessionId, synthetic: ctx.synthetic });
      },
    });

    // Organic fire first: same runner, no synthetic marker.
    await lane.tick();

    const res = await plane.fetch(
      req(
        `${CONTROL_PATH_PREFIX}/wake`,
        wakeBody({ lane: "heartbeat", reason: "operator poke", by: "hangar" }),
      ),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string; lane: string; synthetic: boolean };
    expect(body.lane).toBe("heartbeat");
    expect(body.synthetic).toBe(true);
    expect(body.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
    await lane.settled();

    expect(seen).toHaveLength(2);
    expect(seen[0]?.synthetic).toBeUndefined();
    expect(seen[1]).toEqual({
      sessionId: body.sessionId,
      synthetic: { reason: "operator poke", by: "hangar" },
    });
    // Both fires count on the same counter — an operator poke IS a tick.
    expect(plane.counters.heartbeatTicks).toBe(2);
  });

  test("records the synthetic marker in the session event log", async () => {
    const { plane } = harness();
    const lane = plane.lane({
      lane: "schedule",
      cadence: 'cron "0 * * * *" UTC',
      run: async () => {},
    });
    const res = await plane.fetch(
      req(
        `${CONTROL_PATH_PREFIX}/wake`,
        wakeBody({ lane: "schedule", reason: "backfill", by: "max" }),
      ),
    );
    const { sessionId } = (await res.json()) as { sessionId: string };
    await lane.settled();

    const lines = readFileSync(join(sessions, `${sessionId}.jsonl`), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
    expect(lines).toHaveLength(1);
    // `user_message` + `synthetic: true` is the convention every turn-deriving
    // reader already skips, so a poke can never inflate a turn count.
    expect(lines[0]?.kind).toBe("user_message");
    expect(lines[0]?.payload["synthetic"]).toBe(true);
    expect(lines[0]?.payload["control"]).toEqual({
      protocol: CONTROL_PROTOCOL,
      lane: "schedule",
      synthetic: true,
      reason: "backfill",
      by: "max",
    });
  });

  test("409s while a tick for that lane is in flight, and accepts again once it settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { plane } = harness();
    const lane = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      run: async () => {
        await gate;
      },
    });

    const first = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(first.status).toBe(202);
    expect(lane.busy()).toBe(true);

    const second = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("tick_in_flight");
    // The refused poke never minted a session, so no orphan log was created.
    expect(readdirSync(sessions)).toHaveLength(1);

    release?.();
    await lane.settled();
    expect(lane.busy()).toBe(false);

    const third = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(third.status).toBe(202);
    await lane.settled();
  });

  test("two wakes in the SAME event-loop tick cannot both be accepted", async () => {
    // The lane must claim itself synchronously: awaiting the marker write
    // before setting the guard would let both requests pass it.
    let running = 0;
    let maxConcurrent = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { plane } = harness();
    const lane = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      run: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await gate;
        running -= 1;
      },
    });
    const [a, b] = await Promise.all([
      plane.fetch(req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" }))),
      plane.fetch(req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" }))),
    ]);
    expect([a?.status, b?.status].sort()).toEqual([202, 409]);
    release?.();
    await lane.settled();
    expect(maxConcurrent).toBe(1);
    expect(plane.counters.heartbeatTicks).toBe(1);
  });

  test("an ORGANIC tick blocks a wake too — ticks never overlap themselves", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { plane } = harness();
    const lane = plane.lane({ lane: "heartbeat", cadence: "every 1000ms", run: () => gate });
    const running = lane.tick();
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(res.status).toBe(409);
    release?.();
    await running;
  });

  test("a failing tick records lastOutcome=error and frees the lane", async () => {
    const { plane } = harness();
    const lane = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      run: async () => {
        throw new Error("provider is out of funds");
      },
    });
    await lane.tick();
    expect(lane.busy()).toBe(false);
    expect(lane.report().lastOutcome).toBe("error");
  });

  test("audits the wake with its lane, status and session id", async () => {
    const { plane, audits } = harness();
    const lane = plane.lane({ lane: "heartbeat", cadence: "every 1000ms", run: async () => {} });
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    const { sessionId } = (await res.json()) as { sessionId: string };
    await lane.settled();
    expect(audits.at(-1)?.payload).toMatchObject({
      protocol: CONTROL_PROTOCOL,
      route: `${CONTROL_PATH_PREFIX}/wake`,
      status: 202,
      lane: "heartbeat",
      sessionId,
    });
  });
});

describe("drain", () => {
  test("answers 202, waits out in-flight ticks, runs steps in order and exits 0", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    const { plane, exits } = harness();
    const lane = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      run: async () => {
        await gate;
        order.push("tick");
      },
    });
    plane.onDrain(() => {
      order.push("stop-server");
    });
    plane.onDrain(async () => {
      order.push("flush-janitor");
    });

    void lane.tick();
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/drain`, { method: "POST" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ draining: true, alreadyDraining: false });
    expect(plane.draining()).toBe(true);
    expect(exits).toEqual([]);

    release?.();
    // The drain sequence is scheduled so the 202 reaches the wire first.
    await Bun.sleep(30);
    expect(order).toEqual(["tick", "stop-server", "flush-janitor"]);
    expect(exits).toEqual([0]);
  });

  test("a wake during a drain is refused — it would start work the drain abandons", async () => {
    const { plane } = harness();
    let ran = 0;
    plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      run: async () => {
        ran += 1;
      },
    });
    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/drain`, { method: "POST" }));
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("draining");
    await Bun.sleep(30);
    expect(ran).toBe(0);
  });

  test("a second drain is idempotent and does not re-run the steps", async () => {
    let steps = 0;
    const { plane } = harness();
    plane.onDrain(() => {
      steps += 1;
    });
    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/drain`, { method: "POST" }));
    const second = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/drain`, { method: "POST" }));
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ draining: true, alreadyDraining: true });
    await Bun.sleep(30);
    expect(steps).toBe(1);
  });
});

describe("public gate", () => {
  test("serves a bare, state-free /healthz that needs no bearer", () => {
    const { plane } = harness();
    const res = plane.publicGate(new Request("http://example.test/healthz"));
    expect(res?.status).toBe(200);
  });

  test("falls through for every other request while the daemon is live", () => {
    const { plane } = harness();
    expect(plane.publicGate(new Request("http://example.test/slack/events"))).toBeUndefined();
  });

  test("sheds intake with 503 + Retry-After once draining, but keeps answering /healthz", async () => {
    const { plane } = harness();
    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/drain`, { method: "POST" }));
    const shed = plane.publicGate(
      new Request("http://example.test/slack/events", { method: "POST" }),
    );
    expect(shed?.status).toBe(503);
    expect(shed?.headers.get("retry-after")).toBe(String(DRAIN_RETRY_AFTER_SECONDS));
    // A PaaS health check must still pass or the process is reaped before it
    // finishes the work it already accepted.
    expect(plane.publicGate(new Request("http://example.test/healthz"))?.status).toBe(200);
    await Bun.sleep(30);
  });
});

describe("start", () => {
  test("binds nothing (and mints no token file) when CREWHAUS_CONTROL_PORT is unset, and still beats", async () => {
    const { plane } = harness({ env: {} });
    expect(await plane.start()).toBeUndefined();
    expect(existsSync(join(tmp, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME))).toBe(false);
    expect(existsSync(join(tmp, CONTROL_RUN_DIR, "control-heartbeat.json"))).toBe(true);
    expect(plane.tokenSource()).toBeUndefined();
  });

  test("refuses a nonsense port rather than taking the daemon down", async () => {
    const errs: string[] = [];
    const { plane } = harness({
      env: { CREWHAUS_CONTROL_PORT: "not-a-port", CREWHAUS_CONTROL_TOKEN: TOKEN },
      stderr: (line) => {
        errs.push(line);
      },
    });
    expect(await plane.start()).toBeUndefined();
    expect(errs.join("")).toContain("not a valid port");
  });

  test("binds an ephemeral port, reports it, and never prints the token", async () => {
    const { plane, out } = harness({ env: { CREWHAUS_CONTROL_PORT: "0" } });
    const bound = await plane.start();
    try {
      expect(bound?.port).toBeGreaterThan(0);
      const minted = plane.tokenSource();
      expect(minted?.source).toBe("file");
      const token = readFileSync(
        join(tmp, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME),
        "utf-8",
      ).trim();
      const banner = out.join("");
      expect(banner).toContain(`${CONTROL_RUN_DIR}/${CONTROL_TOKEN_FILENAME}`);
      expect(banner).not.toContain(token);

      const live = await fetch(`${bound?.url}${CONTROL_PATH_PREFIX}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(live.status).toBe(200);
      const unauthenticated = await fetch(`${bound?.url}${CONTROL_PATH_PREFIX}/healthz`);
      expect(unauthenticated.status).toBe(401);
    } finally {
      await plane.stop();
    }
  });
});

/**
 * M2 review — log injection through the control plane.
 *
 * The manager PARSES a daemon's prose stdout: `[control] <protocol> listening
 * on http://host:port` is the only way it learns a kernel-assigned control
 * port, and it writes what it parses into the runfile. Every prose line a
 * daemon prints that interpolates text it did not author is therefore a way to
 * repoint the manager's control calls — bearer included — at a chosen port.
 */
describe("sanitizeControlText — untrusted text can never start a log line", () => {
  /** The exact announcement the manager scans for. */
  const FORGED = `[control] ${CONTROL_PROTOCOL} listening on http://127.0.0.1:9999`;

  /** Lines a log pump would see after splitting a captured chunk. */
  function pumpLines(chunk: string): string[] {
    return chunk.split("\n");
  }

  test("a newline plus a forged banner collapses to one line", () => {
    const injected = `benign reason\n${FORGED}\ntrailing`;
    const clean = sanitizeControlText(injected);
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("\r");
    // The emitted heartbeat lane prints exactly this shape.
    const emitted = `[heartbeat] tick #1 (synthetic: ${clean}) (session sess_${"0".repeat(16)})\n`;
    expect(pumpLines(emitted).filter((l) => l.startsWith("[control]"))).toEqual([]);
    // Un-sanitized, the very same input DOES produce such a line — that is the
    // bug this pins.
    const raw = `[heartbeat] tick #1 (synthetic: ${injected}) (session sess_${"0".repeat(16)})\n`;
    expect(pumpLines(raw).filter((l) => l.startsWith("[control]"))).toEqual([FORGED]);
  });

  test("carriage returns, C1 controls and Unicode line separators all flatten", () => {
    const cr = String.fromCharCode(13);
    const c1 = String.fromCharCode(0x85);
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    for (const sep of [cr, c1, ls, ps]) {
      const clean = sanitizeControlText(`a${sep}${FORGED}`);
      expect(clean).toBe(`a ${FORGED}`);
      expect(pumpLines(`[x] ${clean}\n`).filter((l) => l.startsWith("[control]"))).toEqual([]);
    }
  });

  test("length is capped so one field cannot flood the pumped stream", () => {
    const clean = sanitizeControlText("x".repeat(5_000));
    expect(clean).toHaveLength(CONTROL_TEXT_MAX + 1); // + the ellipsis
    expect(sanitizeControlText("x".repeat(20), 8)).toBe(`${"x".repeat(8)}…`);
    expect(sanitizeControlText("short")).toBe("short");
  });

  test("agent turn output — the operator-free vector — flattens the same way", () => {
    // A channel message steers the reply, so this path needs no operator at
    // all. The emitted lanes call sanitizeControlText(__out, 200).
    const reply = `sure!\n\n${FORGED}\n`;
    const preview = sanitizeControlText(reply, 200);
    expect(
      pumpLines(`[heartbeat] → ${preview}\n`).filter((l) => l.startsWith("[control]")),
    ).toEqual([]);
  });
});

describe("wake — reason/by are sanitized at the control-plane boundary", () => {
  const FORGED = `[control] ${CONTROL_PROTOCOL} listening on http://127.0.0.1:9999`;

  async function pokeWith(reason: string, by: string) {
    const seen: Array<{ reason: string; by: string }> = [];
    const h = harness();
    const lane = h.plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      everyMs: 1000,
      run: async (ctx) => {
        if (ctx.synthetic !== undefined) seen.push({ ...ctx.synthetic });
      },
    });
    const res = await h.plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat", reason, by })),
    );
    const body = (await res.json()) as { sessionId: string; reason: string };
    await lane.settled();
    return { ...h, seen, body, status: res.status };
  }

  test("the tick body, the 202 echo and the marker all see ONE flattened line", async () => {
    const { seen, body, status } = await pokeWith(`benign\n${FORGED}`, "max\nrogue");
    expect(status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe(`benign ${FORGED}`);
    expect(seen[0]?.by).toBe("max rogue");
    expect(body.reason).not.toContain("\n");
    const marker = readFileSync(join(sessions, `${body.sessionId}.jsonl`), "utf-8");
    const record = JSON.parse(marker.trim()) as {
      payload: { control: { reason: string; by: string } };
    };
    expect(record.payload.control.reason).not.toContain("\n");
    expect(record.payload.control.by).toBe("max rogue");
  });

  test("an over-long reason is capped before it reaches the tick", async () => {
    const { seen } = await pokeWith("y".repeat(1_000), "cli");
    expect(seen[0]?.reason).toHaveLength(CONTROL_TEXT_MAX + 1);
  });

  test("whitespace-only reason falls back to the default, not an empty line", async () => {
    const { seen } = await pokeWith("   \n  ", "  ");
    expect(seen[0]?.reason).toBe("operator wake");
    expect(seen[0]?.by).toBe(CONTROL_PROTOCOL);
  });

  test("a lane poked through the handle directly is sanitized too", async () => {
    const seen: Array<{ reason: string }> = [];
    const { plane } = harness();
    const lane = plane.lane({
      lane: "schedule",
      cadence: "every 1000ms",
      run: async (ctx) => {
        if (ctx.synthetic !== undefined) seen.push({ reason: ctx.synthetic.reason });
      },
    });
    await lane.wake({ reason: `a\n${FORGED}`, by: "direct" });
    await lane.settled();
    expect(seen[0]?.reason).not.toContain("\n");
  });
});

/**
 * M2 review — the 202's `sessionId` was an orphan on the managed and batch
 * shapes: the lane minted an id its body never threads into a session, so the
 * marker landed as a `.jsonl` with no `.json` beside it — a shape `sweepExpired`,
 * `crewhaus retention` and the janitor's TTL eviction all skip BY DESIGN. The
 * wire contract is now honest: a lane that does not own the session says so.
 */
describe("ownsSession — the 202 never advertises a dangling session", () => {
  function laneOf(ownsSession: boolean | undefined) {
    const seen: Array<{ sessionId: string; synthetic: unknown }> = [];
    const h = harness();
    const lane = h.plane.lane({
      lane: "schedule",
      cadence: "every 1000ms",
      ...(ownsSession !== undefined ? { ownsSession } : {}),
      run: async (ctx) => {
        seen.push({ sessionId: ctx.sessionId, synthetic: ctx.synthetic });
      },
    });
    return { ...h, lane, seen };
  }

  function sessionFiles(): string[] {
    try {
      return readdirSync(sessions);
    } catch {
      return [];
    }
  }

  test("a session-owning lane still answers with the id and writes the marker", async () => {
    const { plane, lane } = laneOf(undefined);
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule", reason: "poke" })),
    );
    const body = (await res.json()) as { sessionId?: string };
    await lane.settled();
    expect(body.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
    expect(sessionFiles()).toEqual([`${body.sessionId}.jsonl`]);
  });

  test("a lane that owns no session omits sessionId and leaves NO orphan file", async () => {
    const { plane, lane, seen } = laneOf(false);
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule", reason: "poke" })),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    await lane.settled();
    expect("sessionId" in body).toBe(false);
    expect(body["lane"]).toBe("schedule");
    expect(body["synthetic"]).toBe(true);
    // The tick still ran, and still knows it was synthetic.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.synthetic).toEqual({ reason: "poke", by: CONTROL_PROTOCOL });
    // …and nothing was deposited where retention can never reach it.
    expect(sessionFiles()).toEqual([]);
  });

  test("the poke stays evidenced through the audit record instead", async () => {
    const { plane, lane, audits } = laneOf(false);
    await plane.fetch(
      req(
        `${CONTROL_PATH_PREFIX}/wake`,
        wakeBody({ lane: "schedule", reason: "nightly", by: "max" }),
      ),
    );
    await lane.settled();
    const wake = audits.find((a) => a.payload["route"] === `${CONTROL_PATH_PREFIX}/wake`);
    expect(wake?.payload).toMatchObject({ lane: "schedule", reason: "nightly", by: "max" });
    expect(wake?.payload["sessionId"]).toBeUndefined();
  });

  test("an organic tick is unaffected — it still gets a fresh id", async () => {
    const { lane, seen } = laneOf(false);
    await lane.tick();
    expect(seen[0]?.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
    expect(seen[0]?.synthetic).toBeUndefined();
  });
});

/**
 * M2 review — the drain deadline. A supervisor bounds the whole drain; a
 * janitor sweep is housekeeping the next boot repeats, so it must never be
 * able to spend that budget. Emitted drain steps run it through here, last.
 */
describe("runDrainSweep — best-effort housekeeping under its own budget", () => {
  test("a fast step reports done", async () => {
    let ran = 0;
    const outcomes: string[] = [];
    const out = await runDrainSweep(
      async () => {
        ran += 1;
      },
      { budgetMs: 1_000, onOutcome: (o) => outcomes.push(o) },
    );
    expect(out).toBe("done");
    expect(ran).toBe(1);
    expect(outcomes).toEqual(["done"]);
  });

  test("a step that outlives the budget times out — and returns WITHIN it", async () => {
    const t0 = Date.now();
    const out = await runDrainSweep(() => Bun.sleep(5_000), { budgetMs: 25 });
    const elapsed = Date.now() - t0;
    expect(out).toBe("timeout");
    // Without the bound this would sit for 5s inside the supervisor's deadline.
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a throwing step is reported, never rethrown", async () => {
    const outcomes: Array<[string, string | undefined]> = [];
    const out = await runDrainSweep(
      () => {
        throw new Error("janitor blew up");
      },
      { budgetMs: 500, onOutcome: (o, d) => outcomes.push([o, d]) },
    );
    expect(out).toBe("failed");
    expect(outcomes).toEqual([["failed", "janitor blew up"]]);
  });

  test("a zero budget skips the step entirely", async () => {
    let ran = 0;
    const out = await runDrainSweep(
      () => {
        ran += 1;
      },
      { budgetMs: 0 },
    );
    expect(out).toBe("skipped");
    expect(ran).toBe(0);
  });

  test("the budget is operator-tunable through the env, with a sane default", async () => {
    expect(
      await runDrainSweep(() => Bun.sleep(5_000), { env: { [DRAIN_SWEEP_BUDGET_ENV]: "20" } }),
    ).toBe("timeout");
    expect(await runDrainSweep(() => undefined, { env: { [DRAIN_SWEEP_BUDGET_ENV]: "0" } })).toBe(
      "skipped",
    );
    // Garbage — and an empty value, which `Number("")` would read as 0 — falls
    // back to the default rather than silently disabling housekeeping.
    expect(
      await runDrainSweep(() => undefined, { env: { [DRAIN_SWEEP_BUDGET_ENV]: "nope" } }),
    ).toBe("done");
    expect(await runDrainSweep(() => undefined, { env: { [DRAIN_SWEEP_BUDGET_ENV]: "" } })).toBe(
      "done",
    );
    expect(await runDrainSweep(() => undefined, { env: {} })).toBe("done");
    expect(DEFAULT_DRAIN_SWEEP_MS).toBeGreaterThan(0);
  });
});

describe("a lane's run scope", () => {
  test("a tick's run resumes as the lane and was started by it; a wake is synthetic and carries no reason or author", async () => {
    const seen: RunContext[] = [];
    const { plane } = harness();
    const heartbeat = plane.lane({
      lane: "heartbeat",
      cadence: "every 1000ms",
      everyMs: 1000,
      run: async () => {
        seen.push(createRunContext());
      },
    });
    const schedule = plane.lane({
      lane: "schedule",
      cadence: 'cron "0 * * * *" UTC',
      run: async () => {
        seen.push(createRunContext());
      },
    });
    await heartbeat.tick();
    const res = await plane.fetch(
      req(
        `${CONTROL_PATH_PREFIX}/wake`,
        wakeBody({ lane: "heartbeat", reason: "operator poke", by: "hangar" }),
      ),
    );
    expect(res.status).toBe(202);
    await heartbeat.settled();
    await schedule.tick();

    const [organic, woken, scheduled] = seen;
    expect(organic?.resumeScope).toBe("lane:heartbeat");
    expect(organic?.trigger).toEqual({ kind: "heartbeat", lane: "heartbeat" });
    expect(woken?.resumeScope).toBe("lane:heartbeat");
    expect(woken?.trigger).toEqual({ kind: "heartbeat", lane: "heartbeat", synthetic: true });
    const lineage = JSON.stringify({ trigger: woken?.trigger, scope: woken?.resumeScope });
    expect(lineage).not.toContain("operator poke");
    expect(lineage).not.toContain("hangar");
    expect(scheduled?.resumeScope).toBe("lane:schedule");
    expect(scheduled?.trigger).toEqual({ kind: "schedule", lane: "schedule" });
    // Outside a tick, no lane scope.
    expect("resumeScope" in createRunContext()).toBe(false);
  });

  test("a named lane's tick resumes in its own scope, triggered by the schedule", async () => {
    const seen: RunContext[] = [];
    const { plane } = harness();
    const discovery = plane.lane({
      lane: "schedule:discovery",
      cadence: "every 7200000ms",
      run: async () => {
        seen.push(createRunContext());
      },
    });
    await discovery.tick();
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule:discovery" })),
    );
    expect(res.status).toBe(202);
    await discovery.settled();
    const [organic, woken] = seen;
    expect(organic?.resumeScope).toBe("lane:schedule:discovery");
    expect(organic?.trigger).toEqual({ kind: "schedule", lane: "schedule:discovery" });
    expect(woken?.resumeScope).toBe("lane:schedule:discovery");
    expect(woken?.trigger).toEqual({
      kind: "schedule",
      lane: "schedule:discovery",
      synthetic: true,
    });
  });
});

describe("countPendingApprovals folds the way every reader does", () => {
  const park = (inputHash: string) => ({
    id: generateApprovalId(),
    toolName: "Bash",
    inputHash,
    runId: "run_00000001",
    sessionId: "sess_00000000000000aa",
    surface: "daemon",
    createdAt: new Date().toISOString(),
  });
  const write = (lines: readonly object[]): string => {
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "approvals.jsonl");
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return file;
  };

  test("a decided record an 0.8.x writer flipped back to waiting is not counted", () => {
    const p = park("h1");
    const granted = { ...p, decision: "grant", decidedBy: "max", decidedAt: p.createdAt };
    const file = write([p, granted, p]);
    expect(countPendingApprovals(file)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      `${[p, granted, p].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  });

  test("a record its claim decided is not counted, though its file line still waits", async () => {
    const decided = park("h2");
    const waiting = park("h3");
    const file = write([decided, waiting]);
    const store = createPendingApprovalStore({ rootDir: sessions });
    await store.decide(decided.id, { choice: "deny", actor: {} }, { authorize: allowSingleOwner });
    // As a crash between the claim and its lines would leave the file.
    writeFileSync(file, `${[decided, waiting].map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(countPendingApprovals(file)).toBe(1);
  });

  test("no file counts nothing, and creates nothing", () => {
    expect(countPendingApprovals(join(sessions, "approvals.jsonl"))).toBe(0);
    expect(() => readdirSync(sessions)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The operator record: boot, lanes, the three runtime routes, status, the
// heartbeat, the bind and the audit trail.
// ---------------------------------------------------------------------------

const OPERATOR_FILE = join(CONTROL_RUN_DIR, "control", "operator.json");

/** Write an operator record as a plain JSON fixture. */
function writeOperator(dir: string, body: Record<string, unknown>): void {
  mkdirSync(join(dir, CONTROL_RUN_DIR, "control"), { recursive: true });
  writeFileSync(
    join(dir, OPERATOR_FILE),
    `${JSON.stringify({ v: 1, rev: 1, desired: "running", intake: null, deployment: null, ...body })}\n`,
  );
}

const present = (rev: number, block: Record<string, unknown> = {}): OperatorRead => ({
  state: "present",
  record: { v: 1, rev, intake: null, deployment: null, desired: "running", ...block },
});
const OPEN: OperatorRead = { state: "absent" };
const PAUSED = present(2, { intake: { paused: true } });
const DISABLED = present(3, { deployment: { disabled: true } });

/** An injected reader whose answer a test flips. */
function flippable(initial: OperatorRead): {
  readonly read: (dir: string) => OperatorRead;
  set(next: OperatorRead): void;
} {
  let current = initial;
  return {
    read: () => current,
    set(next) {
      current = next;
    },
  };
}

/** A lane whose body counts its runs. */
function countingLane(plane: ControlPlane, lane: "heartbeat" | "schedule" = "heartbeat") {
  const ran = { count: 0 };
  const handle = plane.lane({
    lane,
    cadence: "every 1000ms",
    everyMs: 1000,
    run: async () => {
      ran.count += 1;
    },
  });
  return { handle, ran };
}

const post = (path: string): Request => req(`${CONTROL_PATH_PREFIX}${path}`, { method: "POST" });

describe("a daemon booting while its operator disabled it", () => {
  test("exits 38 once from the constructor, and its start() binds and registers nothing", async () => {
    writeOperator(tmp, { deployment: { disabled: true } });
    const errs: string[] = [];
    const { plane, exits } = harness({
      env: { CREWHAUS_CONTROL_PORT: "0", CREWHAUS_CONTROL_TOKEN: TOKEN },
      stderr: (line) => {
        errs.push(line);
      },
    });
    expect(exits).toEqual([38]);
    expect(errs.join("")).toContain("disabled by its operator, not starting");
    expect(await plane.start()).toBeUndefined();
    expect(intakeRoot()).toBeUndefined();
    expect(existsSync(join(tmp, CONTROL_RUN_DIR, "control-heartbeat.json"))).toBe(false);
  });

  test("an operator record that cannot be read stops the boot the same way", () => {
    mkdirSync(join(tmp, CONTROL_RUN_DIR, "control"), { recursive: true });
    writeFileSync(join(tmp, OPERATOR_FILE), "{");
    const errs: string[] = [];
    const { exits } = harness({
      stderr: (line) => {
        errs.push(line);
      },
    });
    expect(exits).toEqual([38]);
    expect(errs.join("")).toContain("operator record unreadable, not starting");
  });

  test("a paused daemon boots", async () => {
    writeOperator(tmp, { intake: { paused: true } });
    const { plane, exits } = harness({ env: {} });
    expect(exits).toEqual([]);
    await plane.start();
    expect(intakeRoot()).toBe(tmp);
  });
});

describe("lanes run nothing while intake is closed", () => {
  test("paused: a tick runs the body 0 times and counts nothing; a wake answers 409 paused", async () => {
    const operator = flippable(PAUSED);
    const { plane } = harness({ operatorRead: operator.read });
    const { handle, ran } = countingLane(plane);
    await handle.tick();
    expect(ran.count).toBe(0);
    expect(plane.counters.heartbeatTicks).toBe(0);
    expect(handle.report().skipped).toBe("paused");
    expect(handle.report().lastFiredAt).toBeUndefined();
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "paused", lane: "heartbeat" });
    expect(ran.count).toBe(0);
    expect(readdirSync(tmp)).not.toContain("sessions");

    operator.set(OPEN);
    await handle.tick();
    expect(ran.count).toBe(1);
    expect(plane.counters.heartbeatTicks).toBe(1);
    expect(handle.report().skipped).toBeUndefined();
  });

  test("disabled: a wake answers 409 disabled and the body never runs", async () => {
    const operator = flippable(OPEN);
    const { plane } = harness({ operatorRead: operator.read });
    const { handle, ran } = countingLane(plane, "schedule");
    operator.set(DISABLED);
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "schedule" })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "disabled", lane: "schedule" });
    await handle.tick();
    expect(ran.count).toBe(0);
    expect(handle.report().skipped).toBe("disabled");
  });

  test("a wake while draining is still refused as draining", async () => {
    const { plane } = harness({ operatorRead: () => PAUSED });
    countingLane(plane);
    await plane.fetch(post("/drain"));
    const res = await plane.fetch(
      req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })),
    );
    expect(((await res.json()) as { code: string }).code).toBe("draining");
  });
});

describe("the public gate keeps answering while paused or disabled", () => {
  test("Slack's events and actions fall through while paused and while disabled, and shed once draining", async () => {
    const operator = flippable(PAUSED);
    const { plane } = harness({ operatorRead: operator.read });
    for (const state of [PAUSED, DISABLED]) {
      operator.set(state);
      for (const path of ["/slack/events", "/slack/actions"]) {
        const gate = plane.publicGate(
          new Request(`http://example.test${path}`, { method: "POST" }),
        );
        expect({ path, gate }).toEqual({ path, gate: undefined });
      }
    }
    await plane.fetch(post("/drain"));
    const shed = plane.publicGate(
      new Request("http://example.test/slack/events", { method: "POST" }),
    );
    expect(shed?.status).toBe(503);
  });
});

describe("POST /control/v1/runs/{runId}/cancel", () => {
  test("a run this process is running is signalled: 202, its signal aborted with the cancel reason", async () => {
    writeOperator(tmp, { intake: { paused: true } });
    const before = readFileSync(join(tmp, OPERATOR_FILE));
    const { plane } = harness();
    const ctx = createRunContext();
    const res = await plane.fetch(post(`/runs/${ctx.runId}/cancel`));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: ctx.runId, cancelled: true });
    expect(ctx.abortSignal.aborted).toBe(true);
    expect(isCancelReason(ctx.abortSignal)).toBe(true);
    expect(readFileSync(join(tmp, OPERATOR_FILE)).equals(before)).toBe(true);
  });

  test("a run id this process is not running answers 404 run_not_active", async () => {
    const { plane } = harness();
    const runId = mintRunId();
    const res = await plane.fetch(post(`/runs/${runId}/cancel`));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("run_not_active");
    expect(body.error).toContain("not running");
  });

  test("an id that is not a crewhaus run id answers 400 and cancels nothing", async () => {
    const { plane } = harness();
    for (const id of ["run_123", "sess_0000000000000000", `run_${"U".repeat(26)}`]) {
      const res = await plane.fetch(post(`/runs/${id}/cancel`));
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
      expect(((await res.json()) as { code: string }).code).toBe("bad_request");
    }
  });

  test("is served while draining, paused or disabled", async () => {
    const { plane } = harness({ operatorRead: () => DISABLED });
    await plane.fetch(post("/drain"));
    const ctx = createRunContext();
    expect((await plane.fetch(post(`/runs/${ctx.runId}/cancel`))).status).toBe(202);
  });
});

describe("POST /control/v1/operator/reload", () => {
  test("the default reader: a tick runs from the cached record until a reload, and not after", async () => {
    const frozen = spyOn(Date, "now").mockReturnValue(9_000_000);
    try {
      writeOperator(tmp, { rev: 1 });
      const { plane } = harness();
      const status = (await (await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`))).json()) as {
        operator: { rev: number };
      };
      expect(status.operator.rev).toBe(1);
      const { handle, ran } = countingLane(plane);

      writeOperator(tmp, { rev: 2, intake: { paused: true } });
      await handle.tick();
      expect(ran.count).toBe(1);

      const res = await plane.fetch(post("/operator/reload"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        operator: { rev: 2, paused: true, disabled: false, unreadable: false },
      });
      await handle.tick();
      expect(ran.count).toBe(1);
    } finally {
      frozen.mockRestore();
    }
  });

  test("an injected reader that can refresh is refreshed too", async () => {
    writeOperator(tmp, { rev: 1 });
    const operatorRead = createOperatorReader({ now: () => 0 });
    const { plane } = harness({ operatorRead });
    const { handle, ran } = countingLane(plane);
    writeOperator(tmp, { rev: 2, deployment: { disabled: true } });
    await handle.tick();
    expect(ran.count).toBe(1);
    const res = await plane.fetch(post("/operator/reload"));
    expect(await res.json()).toEqual({
      operator: { rev: 2, paused: false, disabled: true, unreadable: false },
    });
    await handle.tick();
    expect(ran.count).toBe(1);
  });

  test("an absent record answers rev null, open", async () => {
    const { plane } = harness();
    const res = await plane.fetch(post("/operator/reload"));
    expect(await res.json()).toEqual({
      operator: { rev: null, paused: false, disabled: false, unreadable: false },
    });
  });

  test("an unreadable record answers paused and unreadable, and leaves the file as it is", async () => {
    const { plane } = harness();
    mkdirSync(join(tmp, CONTROL_RUN_DIR, "control"), { recursive: true });
    writeFileSync(join(tmp, OPERATOR_FILE), "{");
    const res = await plane.fetch(post("/operator/reload"));
    expect(await res.json()).toEqual({
      operator: { rev: null, paused: true, disabled: false, unreadable: true },
    });
    expect(readFileSync(join(tmp, OPERATOR_FILE), "utf8")).toBe("{");
  });
});

describe("POST /control/v1/runs/claim", () => {
  test("no follower registered answers 404 claim_unsupported", async () => {
    const { plane } = harness();
    const res = await plane.fetch(post("/runs/claim"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("claim_unsupported");
  });

  test("a registered follower is woken exactly once, without waiting for it", async () => {
    const { plane } = harness();
    let calls = 0;
    plane.onClaim(
      () =>
        new Promise<void>(() => {
          calls += 1;
        }),
    );
    const res = await plane.fetch(post("/runs/claim"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ claimed: "requested" });
    expect(calls).toBe(1);
  });

  test("while paused it answers 409 paused and does not wake the follower", async () => {
    const { plane } = harness({ operatorRead: () => PAUSED });
    let calls = 0;
    plane.onClaim(() => {
      calls += 1;
    });
    const res = await plane.fetch(post("/runs/claim"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("paused");
    expect(calls).toBe(0);
  });

  test("a follower that fails is reported on stderr, not thrown", async () => {
    let reportedLine: (line: string) => void = () => undefined;
    const reported = new Promise<string>((resolve) => {
      reportedLine = resolve;
    });
    const { plane } = harness({
      stderr: (line) => {
        if (line.includes("claim failed")) reportedLine(line);
      },
    });
    plane.onClaim(async () => {
      throw new Error("follower broke");
    });
    expect((await plane.fetch(post("/runs/claim"))).status).toBe(202);
    expect(await reported).toContain("claim failed: follower broke");
  });
});

describe("status reports the operator record, the controls and the active runs", () => {
  type Status = {
    operator: { rev: number | null; paused: boolean; disabled: boolean; unreadable: boolean };
    capabilities: string[];
    activeRuns: number | null;
  };
  const statusOf = async (plane: ControlPlane): Promise<Status> =>
    (await (await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`))).json()) as Status;

  test("operator, and a held run counted while it is held", async () => {
    const { plane } = harness({ operatorRead: () => PAUSED });
    const base = activeRunCount();
    const release = retainRun(createRunContext());
    try {
      const held = await statusOf(plane);
      expect(held.operator).toEqual({ rev: 2, paused: true, disabled: false, unreadable: false });
      expect(held.activeRuns).toBe(base + 1);
    } finally {
      release();
    }
    expect((await statusOf(plane)).activeRuns).toBe(base);
  });

  test("activeRuns is null where this process cannot count its runs", async () => {
    expect((await statusOf(harness({ target: "managed" }).plane)).activeRuns).toBeNull();
    const off = harness({ env: { CREWHAUS_CONTROL_TOKEN: TOKEN, CREWHAUS_RUN_LEDGER: "0" } });
    expect((await statusOf(off.plane)).activeRuns).toBeNull();
    expect(typeof (await statusOf(harness().plane)).activeRuns).toBe("number");
  });

  test("capabilities are control-contract names: pause for every shape but voice, runs.create only with a follower", async () => {
    const channel = harness();
    const listed = (await statusOf(channel.plane)).capabilities;
    expect(listed.every((name) => (CAPABILITY_NAMES as readonly string[]).includes(name))).toBe(
      true,
    );
    expect(listed).toEqual([
      "controls.pauseIntake",
      "controls.cancelRun",
      "controls.drain",
      "controls.disable",
      "runs.ledger",
    ]);
    channel.plane.onClaim(() => undefined);
    expect((await statusOf(channel.plane)).capabilities).toContain("runs.create");

    const voice = (await statusOf(harness({ target: "voice" }).plane)).capabilities;
    expect(voice).not.toContain("controls.pauseIntake");
    expect(voice).toContain("controls.cancelRun");
    const off = harness({ env: { CREWHAUS_CONTROL_TOKEN: TOKEN, CREWHAUS_RUN_LEDGER: "0" } });
    expect((await statusOf(off.plane)).capabilities).not.toContain("runs.ledger");
  });
});

describe("the audit trail: refusals and every POST, never a successful read", () => {
  test("healthz and status append nothing; a 401 and each POST append exactly one", async () => {
    const { plane, audits } = harness();
    const lane = countingLane(plane);
    plane.onClaim(() => undefined);

    expect((await plane.fetch(req(`${CONTROL_PATH_PREFIX}/healthz`))).status).toBe(200);
    expect((await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`))).status).toBe(200);
    expect(audits).toHaveLength(0);

    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/status`, { bearer: null }));
    expect(audits).toHaveLength(1);

    await plane.fetch(req(`${CONTROL_PATH_PREFIX}/wake`, wakeBody({ lane: "heartbeat" })));
    await lane.handle.settled();
    expect(audits).toHaveLength(2);

    const runId = mintRunId();
    await plane.fetch(post(`/runs/${runId}/cancel`));
    expect(audits).toHaveLength(3);
    expect(audits[2]?.payload).toMatchObject({ runId, status: 404, method: "POST" });

    await plane.fetch(post("/operator/reload"));
    expect(audits).toHaveLength(4);
    expect(audits[3]?.payload).toMatchObject({ rev: null, status: 200 });

    await plane.fetch(post("/runs/claim"));
    expect(audits).toHaveLength(5);
    expect(audits[4]?.payload).toMatchObject({ status: 202 });

    await plane.fetch(post("/drain"));
    expect(audits).toHaveLength(6);

    expect((await plane.fetch(req(`${CONTROL_PATH_PREFIX}/nope`))).status).toBe(404);
    expect(audits).toHaveLength(7);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });
});

describe("CONTROL_ROUTES is what the router serves", () => {
  test("lists the seven routes, and every one answers something other than no-such-route", async () => {
    expect(CONTROL_ROUTES.map((r) => `${r.method} ${r.route}`)).toEqual([
      `GET ${CONTROL_PATH_PREFIX}/healthz`,
      `GET ${CONTROL_PATH_PREFIX}/status`,
      `POST ${CONTROL_PATH_PREFIX}/wake`,
      `POST ${CONTROL_PATH_PREFIX}/drain`,
      `POST ${CONTROL_PATH_PREFIX}/runs/{runId}/cancel`,
      `POST ${CONTROL_PATH_PREFIX}/operator/reload`,
      `POST ${CONTROL_PATH_PREFIX}/runs/claim`,
    ]);
    expect(Object.isFrozen(CONTROL_ROUTES)).toBe(true);
    const { plane } = harness();
    for (const { method, route } of CONTROL_ROUTES) {
      const path = route.replace("{runId}", mintRunId());
      const res = await plane.fetch(
        req(path, { method, ...(method === "POST" ? { body: "{}" } : {}) }),
      );
      const body = (await res.json()) as { code?: string };
      expect({ route, code: body.code }).not.toEqual({ route, code: "not_found" });
    }
  });

  test("a listed path under another method is no route", async () => {
    const { plane } = harness();
    const res = await plane.fetch(req(`${CONTROL_PATH_PREFIX}/operator/reload`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});

describe("the heartbeat", () => {
  test("start() with no port writes every field at once, rewrites it on the interval, and stop() clears it", async () => {
    let t = Date.parse("2026-11-12T00:00:00.000Z");
    const armed: Array<{ fn: () => void; ms: number; handle: object }> = [];
    const cleared: unknown[] = [];
    const { plane } = harness({
      env: {},
      now: () => t,
      pid: 4321,
      operatorRead: () => PAUSED,
      timers: {
        setInterval: (fn, ms) => {
          const handle = { id: armed.length };
          armed.push({ fn, ms, handle });
          return handle;
        },
        clearInterval: (handle) => {
          cleared.push(handle);
        },
      },
    });
    expect(await plane.start()).toBeUndefined();
    expect(intakeRoot()).toBe(tmp);
    const file = join(tmp, CONTROL_RUN_DIR, "control-heartbeat.json");
    const first = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(first).toEqual({
      v: 1,
      pid: 4321,
      at: "2026-11-12T00:00:00.000Z",
      operatorRev: 2,
      paused: true,
      disabled: false,
      activeRuns: activeRunCount(),
      runLedger: true,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.ms).toBe(HEARTBEAT_INTERVAL_MS);

    t += HEARTBEAT_INTERVAL_MS;
    armed[0]?.fn();
    expect((JSON.parse(readFileSync(file, "utf8")) as { at: string }).at).toBe(
      "2026-11-12T00:00:15.000Z",
    );

    await plane.stop();
    expect(cleared).toEqual([armed[0]?.handle]);
    expect(intakeRoot()).toBeUndefined();
  });

  test("a heartbeat that cannot be written is one stderr line per reason, never a throw", async () => {
    const errs: string[] = [];
    const armed: Array<() => void> = [];
    // A file where `.crewhaus` goes: the heartbeat's directory cannot be made.
    writeFileSync(join(tmp, ".crewhaus"), "x");
    const { plane } = harness({
      operatorRead: () => OPEN,
      stderr: (line) => {
        errs.push(line);
      },
      timers: {
        setInterval: (fn) => {
          armed.push(fn);
          return 1;
        },
        clearInterval: () => undefined,
      },
    });
    expect(await plane.start()).toBeUndefined();
    armed[0]?.();
    armed[0]?.();
    expect(errs.filter((line) => line.includes("heartbeat not written"))).toHaveLength(1);
  });

  test("a drain clears the heartbeat before it exits", async () => {
    const cleared: unknown[] = [];
    let exited: () => void = () => undefined;
    const exitedOnce = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const { plane } = harness({
      exit: () => exited(),
      timers: { setInterval: () => "beat", clearInterval: (h) => cleared.push(h) },
    });
    await plane.start();
    await plane.fetch(post("/drain"));
    await exitedOnce;
    expect(cleared).toEqual(["beat"]);
  });
});

describe("a bind beyond this computer needs a token from the environment", () => {
  test("isLoopbackBind accepts loopback only", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.1.2.3",
      "127.255.255.255",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:127.0.0.2]",
    ]) {
      expect({ host, loopback: isLoopbackBind(host) }).toEqual({ host, loopback: true });
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "[::]",
      "",
      "10.0.0.1",
      "192.168.1.10",
      "128.0.0.1",
      "127.0.0.256",
      "127.0.0",
      "127.0.0.1.5",
      "localhost.example.com",
      "::ffff:10.0.0.1",
      "example.com",
    ]) {
      expect({ host, loopback: isLoopbackBind(host) }).toEqual({ host, loopback: false });
    }
  });

  test("0.0.0.0 with no CREWHAUS_CONTROL_TOKEN serves nothing, mints no token and says why", async () => {
    const errs: string[] = [];
    const { plane } = harness({
      env: { CREWHAUS_CONTROL_PORT: "0", CREWHAUS_CONTROL_BIND: "0.0.0.0" },
      stderr: (line) => {
        errs.push(line);
      },
    });
    expect(await plane.start()).toBeUndefined();
    expect(existsSync(join(tmp, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME))).toBe(false);
    expect(plane.tokenSource()).toBeUndefined();
    const said = errs.join("");
    expect(said).toContain("CREWHAUS_CONTROL_BIND");
    expect(said).toContain("CREWHAUS_CONTROL_TOKEN");
  });

  test("an empty CREWHAUS_CONTROL_TOKEN is no token", async () => {
    const { plane } = harness({
      env: { CREWHAUS_CONTROL_PORT: "0", CREWHAUS_CONTROL_BIND: "::", CREWHAUS_CONTROL_TOKEN: "" },
    });
    expect(await plane.start()).toBeUndefined();
    expect(existsSync(join(tmp, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME))).toBe(false);
  });
});
