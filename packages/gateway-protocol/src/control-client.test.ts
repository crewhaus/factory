/**
 * The control.v1 client, against a scripted `fetch` — no socket, no daemon.
 *
 * What must hold, refusal by refusal: each code carries the right two flags
 * (`retryable`: the same call may succeed shortly; `expected`: a fact about
 * the bundle, rendered disabled-with-reason rather than as an error), the
 * two 409s never collapse into one, and nothing reaches the wire without a
 * port and a token. And the token: read from the file the daemon's own
 * writer (`resolveControlToken`) mints, on EVERY call, never cached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_PATH_PREFIX, CONTROL_PROTOCOL, resolveControlToken } from "./control";
import {
  CONTROL_LANES,
  CONTROL_LISTENING_RE,
  type ControlRefusal,
  type ControlResult,
  DEFAULT_CONTROL_TIMEOUT_MS,
  createControlClient,
  isControlLane,
  knownControlPort,
  parseControlPort,
} from "./control-client";

/** Built from parts: never a realistic-shaped literal in a fixture. */
const TOKEN = ["c0ntrol", "client", "test", "0123456789abcdef"].join("-");
const PORT = 41_777;

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/** A harness dir with a token file at `.crewhaus/run/control-token`, or none. */
function harness(token?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "control-client-"));
  scratch.push(dir);
  if (token !== undefined) {
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "run", "control-token"), `${token}\n`, { mode: 0o600 });
  }
  return dir;
}

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A `fetch` that answers every call with `status` + `body`, recording each. */
function answering(status: number, body: unknown): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    return new Response(body === undefined ? "not json" : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: doFetch, seen };
}

function refused<T>(result: ControlResult<T>): ControlRefusal {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result;
}

describe("refusals that never reach the wire", () => {
  test("no control port is an EXPECTED fact, and nothing is read or sent", async () => {
    const { fetch, seen } = answering(200, {});
    let tokenReads = 0;
    const client = createControlClient({
      fetch,
      readToken: () => {
        tokenReads += 1;
        return TOKEN;
      },
    });
    for (const controlPort of [undefined, 0, -1, 1.5]) {
      const result = refused(
        await client.wake({ harnessDir: "/nonexistent", controlPort }, { lane: "heartbeat" }),
      );
      expect(result.code).toBe("no_control_port");
      expect(result.status).toBe(0);
      expect(result.expected).toBe(true);
      expect(result.retryable).toBe(false);
      expect(result.lane).toBe("heartbeat");
      expect(result.reason).toContain("crewhaus.control.v1");
    }
    expect(tokenReads).toBe(0);
    expect(seen).toEqual([]);
  });

  test("no token yet is not expected, not retryable, and sends nothing", async () => {
    const { fetch, seen } = answering(200, {});
    const client = createControlClient({ fetch });
    for (const dir of [harness(), harness("")]) {
      const result = refused(await client.status({ harnessDir: dir, controlPort: PORT }));
      expect(result.code).toBe("no_control_token");
      expect(result.status).toBe(0);
      expect(result.expected).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.reason).toContain(".crewhaus/run/control-token");
    }
    expect(seen).toEqual([]);
  });

  test("a fetch that throws is unreachable, with the port and the cause", async () => {
    const client = createControlClient({
      fetch: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const result = refused(await client.drain({ harnessDir: harness(TOKEN), controlPort: PORT }));
    expect(result.code).toBe("unreachable");
    expect(result.status).toBe(0);
    expect(result.expected).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain(String(PORT));
    expect(result.reason).toContain("ECONNREFUSED");
    expect(result.reason).not.toContain(TOKEN);
  });
});

describe("refusals the daemon answers", () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly status: number;
    readonly body: unknown;
    readonly code: ControlRefusal["code"];
    readonly retryable: boolean;
    readonly expected: boolean;
    readonly reason: string;
  }> = [
    {
      label: "404 lane_not_armed",
      status: 404,
      body: { error: "no schedule lane", code: "lane_not_armed" },
      code: "lane_not_armed",
      retryable: false,
      expected: true,
      reason: "this bundle armed no schedule lane — the spec declares no such schedule",
    },
    {
      label: "409 tick_in_flight",
      status: 409,
      body: { error: "busy", code: "tick_in_flight" },
      code: "tick_in_flight",
      retryable: true,
      expected: false,
      reason: "a schedule tick is already running",
    },
    {
      label: "409 draining",
      status: 409,
      body: { error: "draining", code: "draining" },
      code: "draining",
      retryable: false,
      expected: true,
      reason: "the daemon is draining — it accepts no new work",
    },
    {
      label: "409 paused",
      status: 409,
      body: { error: "paused", code: "paused", lane: "schedule" },
      code: "paused",
      retryable: false,
      expected: true,
      reason: "the daemon's operator paused new work — it starts nothing new until resumed",
    },
    {
      label: "409 disabled",
      status: 409,
      body: { error: "disabled", code: "disabled", lane: "schedule" },
      code: "disabled",
      retryable: false,
      expected: true,
      reason: "the daemon's operator disabled this harness — it starts nothing new",
    },
    {
      label: "401",
      status: 401,
      body: { error: "unauthorized" },
      code: "unauthorized",
      retryable: false,
      expected: false,
      reason:
        "the control token on disk was refused — the daemon reminted it at boot; restart the manager's view",
    },
    {
      label: "a 409 with no code",
      status: 409,
      body: { error: "conflict of some other kind" },
      code: "error",
      retryable: false,
      expected: false,
      reason: "conflict of some other kind",
    },
    {
      label: "a 404 that is not lane_not_armed",
      status: 404,
      body: { error: "no such route" },
      code: "error",
      retryable: false,
      expected: false,
      reason: "no such route",
    },
    {
      label: "a 500 whose body is not JSON",
      status: 500,
      body: undefined,
      code: "error",
      retryable: false,
      expected: false,
      reason: "HTTP 500",
    },
  ];

  for (const c of cases) {
    test(`${c.label} is ${c.code} (retryable ${c.retryable}, expected ${c.expected})`, async () => {
      const { fetch, seen } = answering(c.status, c.body);
      const client = createControlClient({ fetch });
      const result = refused(
        await client.wake({ harnessDir: harness(TOKEN), controlPort: PORT }, { lane: "schedule" }),
      );
      expect(seen).toHaveLength(1);
      expect(result).toEqual({
        ok: false,
        code: c.code,
        status: c.status,
        reason: c.reason,
        lane: "schedule",
        retryable: c.retryable,
        expected: c.expected,
      });
    });
  }

  test("a refusal from a lane-less call carries no lane", async () => {
    const { fetch } = answering(409, { code: "draining" });
    const client = createControlClient({ fetch });
    const result = refused(await client.drain({ harnessDir: harness(TOKEN), controlPort: PORT }));
    expect(result.code).toBe("draining");
    expect("lane" in result).toBe(false);
  });
});

describe("the calls on the wire", () => {
  test("status, wake and drain hit their routes with the bearer and answer the body", async () => {
    const { fetch, seen } = answering(200, { ok: true, sessionId: "sess_00000000000000ab" });
    const client = createControlClient({ fetch });
    const target = { harnessDir: harness(TOKEN), controlPort: PORT };

    const status = await client.status(target);
    const wake = await client.wake(target, { lane: "heartbeat", reason: "operator poke" });
    const quiet = await client.wake(
      { ...target, bind: "127.0.0.2" },
      { lane: "schedule", by: "cli", reason: "" },
    );
    const drain = await client.drain(target);

    expect(status).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, sessionId: "sess_00000000000000ab" },
    });
    expect(wake.ok && drain.ok && quiet.ok).toBe(true);
    const base = `http://127.0.0.1:${PORT}${CONTROL_PATH_PREFIX}`;
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${base}/status`,
      `POST ${base}/wake`,
      `POST http://127.0.0.2:${PORT}${CONTROL_PATH_PREFIX}/wake`,
      `POST ${base}/drain`,
    ]);
    for (const call of seen) expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    // A body only where there is one, and JSON-typed when there is.
    expect(seen.map((s) => s.headers["content-type"] ?? null)).toEqual([
      null,
      "application/json",
      "application/json",
      null,
    ]);
    expect(seen[1]?.body).toEqual({ lane: "heartbeat", reason: "operator poke", by: "hangar" });
    // An empty reason is dropped, and the caller's `by` wins.
    expect(seen[2]?.body).toEqual({ lane: "schedule", by: "cli" });
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[3]?.body).toBeUndefined();
  });

  test("every call carries a timeout", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const client = createControlClient({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      timeoutMs: 1_234,
    });
    await client.status({ harnessDir: harness(TOKEN), controlPort: PORT });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_CONTROL_TIMEOUT_MS).toBe(5_000);
  });
});

describe("the token", () => {
  test("is the one the daemon's own writer minted, read from the file it wrote", async () => {
    const dir = harness();
    const minted = resolveControlToken({ cwd: dir, env: {} });
    expect(minted.source).toBe("file");
    const { fetch, seen } = answering(200, {});
    await createControlClient({ fetch }).status({ harnessDir: dir, controlPort: PORT });
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${minted.token}`);
  });

  test("is re-read on every call — a daemon that reminted it is not cached out", async () => {
    const dir = harness(["old", "token", "0123456789abcdef"].join("-"));
    const { fetch, seen } = answering(200, {});
    const client = createControlClient({ fetch });
    await client.status({ harnessDir: dir, controlPort: PORT });
    writeFileSync(join(dir, ".crewhaus", "run", "control-token"), `${TOKEN}\n`, { mode: 0o600 });
    await client.status({ harnessDir: dir, controlPort: PORT });
    expect(seen.map((s) => s.headers["authorization"])).toEqual([
      `Bearer ${["old", "token", "0123456789abcdef"].join("-")}`,
      `Bearer ${TOKEN}`,
    ]);
  });

  test("the reader seam replaces the file, per harness", async () => {
    const asked: string[] = [];
    const { fetch, seen } = answering(200, {});
    const client = createControlClient({
      fetch,
      readToken: (dir) => {
        asked.push(dir);
        return TOKEN;
      },
    });
    await client.status({ harnessDir: "/nowhere/a", controlPort: PORT });
    await client.status({ harnessDir: "/nowhere/b", controlPort: PORT });
    expect(asked).toEqual(["/nowhere/a", "/nowhere/b"]);
    expect(seen).toHaveLength(2);
  });
});

describe("the port", () => {
  test("knownControlPort treats 0 and junk as not known", () => {
    expect(knownControlPort(41_000)).toBe(41_000);
    for (const port of [undefined, 0, -5, 1.5, Number.NaN]) {
      expect(knownControlPort(port)).toBeUndefined();
    }
  });

  test("parseControlPort reads the daemon's boot line, and only that", () => {
    const line = `[control] ${CONTROL_PROTOCOL} listening on http://127.0.0.1:${PORT} (token: .crewhaus/run/control-token)`;
    expect(CONTROL_LISTENING_RE.test(line)).toBe(true);
    expect(parseControlPort(`boot\n${line}\nready\n`)).toBe(PORT);
    expect(
      parseControlPort(`[control] ${CONTROL_PROTOCOL} listening on https://[::1]:443`),
    ).toBeUndefined();
    expect(
      parseControlPort("[control] crewhaus.control.v2 listening on http://127.0.0.1:41777"),
    ).toBeUndefined();
    expect(
      parseControlPort(`[control] ${CONTROL_PROTOCOL} listening on http://127.0.0.1:99999`),
    ).toBeUndefined();
    expect(parseControlPort("listening on http://127.0.0.1:41777")).toBeUndefined();
  });

  test("the two fixed lanes and the named schedule lanes, and nothing else, are lanes", () => {
    expect([...CONTROL_LANES]).toEqual(["heartbeat", "schedule"]);
    expect(isControlLane("heartbeat")).toBe(true);
    expect(isControlLane("schedule")).toBe(true);
    expect(isControlLane("schedule:discovery")).toBe(true);
    expect(isControlLane(`schedule:a${"b".repeat(31)}`)).toBe(true);
    expect(isControlLane("janitor")).toBe(false);
    expect(isControlLane("dream")).toBe(false);
    expect(isControlLane("")).toBe(false);
    expect(isControlLane("schedule:")).toBe(false);
    expect(isControlLane("schedule:Bad")).toBe(false);
    expect(isControlLane("schedule:a_b")).toBe(false);
    expect(isControlLane(`schedule:a${"b".repeat(32)}`)).toBe(false);
    expect(isControlLane("heartbeat:x")).toBe(false);
  });
});
