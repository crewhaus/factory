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
  CONTROL_TEXT_MAX,
  CONTROL_TOKEN_FILENAME,
  type ControlAuditRecord,
  type ControlPlane,
  type ControlPlaneOptions,
  DEFAULT_DRAIN_SWEEP_MS,
  DRAIN_RETRY_AFTER_SECONDS,
  DRAIN_SWEEP_BUDGET_ENV,
  constantTimeEquals,
  createControlPlane,
  resolveControlToken,
  runDrainSweep,
  sanitizeControlText,
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
