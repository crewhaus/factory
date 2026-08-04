/**
 * Module-level coverage for `crewhaus.control.v1`: the router, the bearer
 * gate, the never-overlap wake semantics and the drain sequence. Everything
 * here runs against `plane.fetch(Request)` — no socket, no daemon, no timers
 * — which is exactly why the plane exposes `fetch` separately from `start`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_PATH_PREFIX,
  CONTROL_PROTOCOL,
  CONTROL_RUN_DIR,
  CONTROL_TOKEN_FILENAME,
  type ControlAuditRecord,
  type ControlPlane,
  type ControlPlaneOptions,
  DRAIN_RETRY_AFTER_SECONDS,
  constantTimeEquals,
  createControlPlane,
  resolveControlToken,
} from "./control";

let tmp: string;
let sessions: string;
// Built from parts so no realistic-shaped credential literal lands in the repo.
const TOKEN = ["ctl", "0".repeat(8), "abcd"].join("-");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-control-"));
  sessions = join(tmp, "sessions");
});
afterEach(() => {
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
  test("binds nothing (and mints no token file) when CREWHAUS_CONTROL_PORT is unset", async () => {
    const { plane } = harness({ env: {} });
    expect(await plane.start()).toBeUndefined();
    expect(readdirSync(tmp)).not.toContain(".crewhaus");
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
