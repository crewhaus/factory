/**
 * Home's receivers: a delivery is verified, claimed once and recorded before it is
 * acknowledged, and its receipt settles when the work does.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as records from "@crewhaus/control-records";
import { foldStates, publishClaim } from "@crewhaus/control-records";
import {
  IDEMPOTENCY_TTL_MS,
  outcomeOf,
  wireControl,
  workspaceCommandsLedger,
} from "@crewhaus/control-service";
import {
  INBOUND_RECORD_EFFECT,
  type Receiver,
  createIngress,
  receiverProblems,
  sweepInboundRecords,
  verifyHmacSha256,
} from "./ingress";
import { CORE_SWEEPS, type HomePorts } from "./sweeps";
import { bootTestServer } from "./testkit";
import { HOME_CORE, homeCompositionProblems } from "./v1/areas";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const SECRET = ["test", "signing", "secret"].join("-");

/** Owner-only: the exact bits on POSIX; Windows reports only read and write. */
function expectOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (process.platform === "win32") expect(mode & 0o600).toBe(0o600);
  else expect(mode).toBe(0o600);
}

function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function receiver(overrides: Partial<Receiver> = {}, gate?: Promise<void>): Receiver {
  return {
    provider: "test",
    via: "github",
    kind: "legacy.hookTest",
    origin: "api",
    verify: async (req, raw) => verifyHmacSha256(SECRET, raw, req.headers.get("x-signature") ?? ""),
    dedupeRef: (req) => req.headers.get("x-delivery") ?? undefined,
    handle: async () => {
      await gate;
      return { state: "succeeded" };
    },
    ...overrides,
  };
}

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;

/** One clock for the ingress, the control plane and the records layer's own stamps. */
const clock = { now: T0 };
let clockSpy: { mockRestore(): void } | undefined;
/** Fake the shared clock for every test of the describe this is called in. */
function useClock(): void {
  beforeEach(() => {
    clock.now = T0;
    clockSpy = spyOn(Date, "now").mockImplementation(() => clock.now);
  });
  afterEach(() => {
    clockSpy?.mockRestore();
    clockSpy = undefined;
  });
}

type Probe = { isAlive(pid: number): boolean | undefined; startTimeMs(pid: number): undefined };

function wire(hangarRoot: string, options: { pid?: number; probe?: Probe } = {}) {
  return wireControl(
    {
      hangarRoot,
      supervisorFor: () => undefined,
      drainRequest: () => async () => undefined,
      identity: { username: "sam", hostname: "laptop" },
      now: () => clock.now,
      hostBootedAt: () => T0 - DAY,
      probe: options.probe ?? { isAlive: () => true, startTimeMs: () => undefined },
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
    },
    { mode: "server" },
  );
}

function setUp(
  r: Receiver,
  warnings: string[] = [],
  options: { hangarRoot?: string; pid?: number; probe?: Probe } = {},
) {
  const hangarRoot = options.hangarRoot ?? mkdtempSync(join(tmpdir(), "hangar-ingress-"));
  if (options.hangarRoot === undefined) roots.push(hangarRoot);
  const control = wire(hangarRoot, options);
  const ingress = createIngress({
    hangarRoot,
    receivers: [r],
    control,
    now: () => clock.now,
    onWarn: (message) => warnings.push(message),
  });
  const receipts = () => {
    const fold = foldStates(workspaceCommandsLedger(hangarRoot));
    return fold.ok ? [...fold.objects.values()].map((object) => object.record) : [];
  };
  const inbound = () => {
    const dir = join(hangarRoot, "ingress", r.provider);
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  const claims = () => {
    const dir = join(hangarRoot, "control", "claims", "ingress");
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  return { hangarRoot, control, ingress, receipts, inbound, claims };
}

function delivery(
  body: string,
  id: string | undefined,
  signature?: string,
  provider = "test",
): Request {
  const headers: Record<string, string> = {
    "x-signature": signature ?? createHmac("sha256", SECRET).update(body).digest("hex"),
  };
  if (id !== undefined) headers["x-delivery"] = id;
  return new Request(`http://127.0.0.1/hooks/${provider}/events`, {
    method: "POST",
    headers,
    body,
  });
}

/** The first 32 hex of a delivery id's sha256: its claim and its record's name. */
function digestOf(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

/** A receiver that counts how often its work runs. */
function counted(gate?: Promise<void>) {
  const count = { handled: 0 };
  const r = receiver({
    handle: async () => {
      count.handled += 1;
      await gate;
      return { state: "succeeded" };
    },
  });
  return { r, count };
}

/** A receipt that holds this delivery's claim and never recorded its delivery. */
async function plantNeverRecorded(control: ReturnType<typeof wire>, id: string) {
  const digest = digestOf(id);
  const answer = await control.commands.submit(
    {
      kind: "legacy.hookTest",
      actor: "sys:ingress",
      ledger: "workspace",
      via: "github",
      params: { provider: "test", delivery: digest },
      dedupeClaim: `ingress/test-${digest}`,
    },
    async () => ({
      settle: {
        state: "failed",
        outcome: outcomeOf("unavailable"),
        effects: [{ kind: INBOUND_RECORD_EFFECT, status: "failed" }],
      },
      value: undefined,
    }),
  );
  if (!answer.ok) throw new Error(answer.refusal.message);
  return answer.receipt;
}

/** Every byte under a directory, path by path. */
function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(path, readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return out;
}

describe("verifyHmacSha256", () => {
  test("agrees with node:crypto, and refuses any other signature", async () => {
    const payload = '{"event":"push"}';
    const good = createHmac("sha256", SECRET).update(payload).digest("hex");
    expect(await verifyHmacSha256(SECRET, payload, good)).toBe(true);
    expect(await verifyHmacSha256(SECRET, payload, good.toUpperCase())).toBe(true);
    expect(await verifyHmacSha256(SECRET, `${payload} `, good)).toBe(false);
    expect(await verifyHmacSha256("other", payload, good)).toBe(false);
    expect(await verifyHmacSha256(SECRET, payload, good.slice(0, 62))).toBe(false);
    expect(await verifyHmacSha256(SECRET, payload, "zz".repeat(32))).toBe(false);
  });
});

describe("a delivery", () => {
  useClock();

  test("a bad signature: 401, and nothing is written", async () => {
    const s = setUp(receiver());
    const res = await s.ingress.fetch(delivery("{}", "d1", "00".repeat(32)));
    expect(res.status).toBe(401);
    expect(s.receipts()).toEqual([]);
    expect(existsSync(join(s.hangarRoot, "ingress"))).toBe(false);
    expect(existsSync(join(s.hangarRoot, "control"))).toBe(false);
  });

  test("no delivery id: 400, and nothing is written", async () => {
    const s = setUp(receiver());
    const res = await s.ingress.fetch(delivery("{}", undefined));
    expect(res.status).toBe(400);
    expect(s.receipts()).toEqual([]);
  });

  test("a good one is recorded before the answer, then settles when the work does", async () => {
    const gate = deferred();
    const s = setUp(receiver({}, gate.promise));
    const res = await s.ingress.fetch(delivery('{"n":1}', "delivery-1"));
    expect(res.status).toBe(200);
    // The work is still waiting: the receipt and the inbound record are already there.
    const [receipt] = s.receipts();
    expect(receipt?.["state"]).toBe("accepted");
    expect(receipt?.["actor"]).toBe("sys:ingress");
    expect(receipt?.["via"]).toBe("github");
    expect(receipt?.["kind"]).toBe("legacy.hookTest");
    expect(s.inbound()).toEqual([`${digestOf("delivery-1")}.json`]);
    const record = JSON.parse(
      readFileSync(join(s.hangarRoot, "ingress", "test", `${digestOf("delivery-1")}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({ v: 1, provider: "test", body: '{"n":1}', origin: "api" });
    expectOwnerOnly(join(s.hangarRoot, "ingress", "test", `${digestOf("delivery-1")}.json`));
    gate.open();
    await s.ingress.idle();
    expect(s.receipts()[0]?.["state"]).toBe("succeeded");
    expect(s.inbound()).toEqual([]);
  });

  test("the same delivery id again: 200 duplicate, one receipt, and the claim under claims/ingress", async () => {
    const s = setUp(receiver());
    expect((await s.ingress.fetch(delivery('{"n":1}', "delivery-2"))).status).toBe(200);
    await s.ingress.idle();
    const again = await s.ingress.fetch(delivery('{"n":2}', "delivery-2"));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(s.receipts()).toHaveLength(1);
    const claims = s.claims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatch(/^test-[0-9a-f]{32}\.json$/);
  });

  test("a delivery replayed a minute later or eight days later is a duplicate, handled once", async () => {
    const { r, count } = counted();
    const s = setUp(r);
    expect((await s.ingress.fetch(delivery('{"n":1}', "delivery-late"))).status).toBe(200);
    await s.ingress.idle();
    for (const later of [MINUTE, 8 * DAY + MINUTE]) {
      clock.now = T0 + later;
      const replay = await s.ingress.fetch(delivery('{"n":1}', "delivery-late"));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ duplicate: true });
      await s.ingress.idle();
    }
    expect(count.handled).toBe(1);
    expect(s.receipts()).toHaveLength(1);
  });

  test("every provider name the receiver grammar allows is a delivery claim the ledger takes", async () => {
    let handled = 0;
    const provider = `a${"b".repeat(31)}`;
    const r = receiver({
      provider,
      handle: async () => {
        handled += 1;
        return { state: "succeeded" };
      },
    });
    expect(receiverProblems([{ area: "core", receiver: r }])).toEqual([]);
    const s = setUp(r);
    const res = await s.ingress.fetch(delivery("{}", "delivery-long", undefined, provider));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    await s.ingress.idle();
    expect(handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["succeeded"]);
  });

  test("a replay of a settled delivery keeps no body", async () => {
    const s = setUp(receiver());
    expect((await s.ingress.fetch(delivery('{"n":1}', "delivery-settled"))).status).toBe(200);
    await s.ingress.idle();
    expect(s.inbound()).toEqual([]);
    const replay = await s.ingress.fetch(delivery('{"n":1}', "delivery-settled"));
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(s.inbound()).toEqual([]);
  });

  test("a record that cannot be written: 503, nothing claimed, no receipt, and the retry is handled once", async () => {
    const { r, count } = counted();
    const warnings: string[] = [];
    const s = setUp(r, warnings);
    // A file where the inbound records' directory goes: the record cannot be written.
    writeFileSync(join(s.hangarRoot, "ingress"), "in the way");
    const first = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(first.status).toBe(503);
    await s.ingress.idle();
    expect(count.handled).toBe(0);
    expect(warnings.some((w) => w.includes("could not be recorded"))).toBe(true);
    expect(s.claims()).toEqual([]);
    expect(s.receipts()).toEqual([]);

    rmSync(join(s.hangarRoot, "ingress"));
    const retry = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ok?: boolean }).ok).toBe(true);
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    const again = await s.ingress.fetch(delivery('{"n":1}', "delivery-lost"));
    expect(await again.json()).toEqual({ duplicate: true });
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["succeeded"]);
  });

  test("an attempt that stops between its record and its claim loses nothing", async () => {
    const { r, count } = counted();
    const s = setUp(r);
    const submit = spyOn(s.control.commands, "submit").mockImplementationOnce(async () => {
      throw new Error("stopped");
    });
    try {
      expect((await s.ingress.fetch(delivery('{"n":1}', "delivery-crash"))).status).toBe(503);
    } finally {
      submit.mockRestore();
    }
    expect(
      existsSync(join(s.hangarRoot, "ingress", "test", `${digestOf("delivery-crash")}.json`)),
    ).toBe(true);
    expect(s.claims()).toEqual([]);
    expect(s.receipts()).toEqual([]);
    await s.control.commands.recover("all");
    const retry = await s.ingress.fetch(delivery('{"n":1}', "delivery-crash"));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ok?: boolean }).ok).toBe(true);
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    expect(s.inbound()).toEqual([]);
    const again = await s.ingress.fetch(delivery('{"n":1}', "delivery-crash"));
    expect(await again.json()).toEqual({ duplicate: true });
    await s.ingress.idle();
    expect(count.handled).toBe(1);
  });

  test("a claim held by a receipt that never recorded its delivery is given up on the next attempt", async () => {
    const { r, count } = counted();
    const s = setUp(r);
    await plantNeverRecorded(s.control, "delivery-held");
    expect(s.claims()).toHaveLength(1);
    // Replayed onto a receipt that never recorded it: not a duplicate, and the claim goes.
    const replay = await s.ingress.fetch(delivery("{}", "delivery-held"));
    expect(replay.status).toBe(503);
    expect(s.claims()).toEqual([]);
    // The record stays for whichever attempt claims next.
    expect(s.inbound()).toEqual([`${digestOf("delivery-held")}.json`]);
    const retry = await s.ingress.fetch(delivery("{}", "delivery-held"));
    expect(retry.status).toBe(200);
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["failed", "succeeded"]);
  });

  test("a replay that gives up a never-recorded receipt's claim keeps a newer receipt's claim", async () => {
    const { r, count } = counted();
    const s = setUp(r);
    await plantNeverRecorded(s.control, "delivery-raced");
    // C is held after its submit answers, until B and B' have both run.
    const real = s.control.commands.submit;
    const reached = deferred();
    const gate = deferred();
    const submit = spyOn(s.control.commands, "submit").mockImplementationOnce(
      async (request, effect) => {
        const answer = await real(request, effect);
        reached.open();
        await gate.promise;
        return answer;
      },
    );
    try {
      const c = s.ingress.fetch(delivery("{}", "delivery-raced"));
      await reached.promise;
      const b = await s.ingress.fetch(delivery("{}", "delivery-raced"));
      expect(b.status).toBe(503);
      const bPrime = await s.ingress.fetch(delivery("{}", "delivery-raced"));
      expect(bPrime.status).toBe(200);
      expect(((await bPrime.json()) as { ok?: boolean }).ok).toBe(true);
      gate.open();
      expect((await c).status).toBe(503);
    } finally {
      submit.mockRestore();
    }
    expect(s.claims()).toHaveLength(1);
    const d = await s.ingress.fetch(delivery("{}", "delivery-raced"));
    expect(await d.json()).toEqual({ duplicate: true });
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["failed", "succeeded"]);
  });

  test("a claim whose receipt is open is a duplicate while this ingress works on it, or when another head wrote it", async () => {
    const gate = deferred();
    const { r, count } = counted(gate.promise);
    const s = setUp(r);
    // Worked on here: the first delivery's handle is still waiting.
    expect((await s.ingress.fetch(delivery("{}", "delivery-busy"))).status).toBe(200);
    const busy = await s.ingress.fetch(delivery("{}", "delivery-busy"));
    expect(busy.status).toBe(200);
    expect(await busy.json()).toEqual({ duplicate: true });
    expect(s.receipts().map((row) => row["state"])).toEqual(["accepted"]);
    gate.open();
    await s.ingress.idle();
    expect(count.handled).toBe(1);

    // Written by another head, which is alive: recovery owns it, never this ingress.
    const other = wire(s.hangarRoot, { pid: 2000 });
    const digest = digestOf("delivery-elsewhere");
    const held = await other.commands.submit({
      kind: "legacy.hookTest",
      actor: "sys:ingress",
      ledger: "workspace",
      via: "github",
      params: { provider: "test", delivery: digest },
      dedupeClaim: `ingress/test-${digest}`,
    });
    expect(held.ok).toBe(true);
    const res = await s.ingress.fetch(delivery("{}", "delivery-elsewhere"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duplicate: true });
    await s.ingress.idle();
    expect(count.handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["succeeded", "accepted"]);
  });

  test("a receipt this head wrote and nothing works on is given up, so the provider's retry is handled once", async () => {
    const { r, count } = counted();
    const s = setUp(r);
    // The claim is published and its receipt row never reached the ledger: the receipt the
    // retry completes is open, this head's, and worked on by nothing.
    const digest = digestOf("delivery-partial");
    const held = await s.control.commands.submit({
      kind: "legacy.hookTest",
      actor: "sys:ingress",
      ledger: "workspace",
      via: "github",
      params: { provider: "test", delivery: digest },
      dedupeClaim: `ingress/test-${digest}`,
    });
    expect(held.ok).toBe(true);
    const segments = join(s.hangarRoot, "control", "commands");
    for (const name of readdirSync(segments)) rmSync(join(segments, name));
    expect(s.receipts()).toEqual([]);
    expect(s.claims()).toHaveLength(1);

    const first = await s.ingress.fetch(delivery("{}", "delivery-partial"));
    expect(first.status).toBe(503);
    expect(count.handled).toBe(0);
    expect(s.claims()).toEqual([]);
    const retry = await s.ingress.fetch(delivery("{}", "delivery-partial"));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ok?: boolean }).ok).toBe(true);
    await s.ingress.idle();
    for (let i = 0; i < 2; i += 1) {
      const again = await s.ingress.fetch(delivery("{}", "delivery-partial"));
      expect(await again.json()).toEqual({ duplicate: true });
      await s.ingress.idle();
    }
    expect(count.handled).toBe(1);
    expect(s.receipts().map((row) => row["state"])).toEqual(["failed", "succeeded"]);
  });

  test("the request that wins the claim confirms its record, writing it again when it is gone", async () => {
    const gate = deferred();
    const { r, count } = counted(gate.promise);
    const s = setUp(r);
    const path = join(s.hangarRoot, "ingress", "test", `${digestOf("delivery-confirm")}.json`);
    const real = s.control.commands.submit;
    const submit = spyOn(s.control.commands, "submit").mockImplementationOnce(
      async (request, effect) => {
        // The record goes between its write and the claim.
        rmSync(path);
        return real(request, effect);
      },
    );
    try {
      const res = await s.ingress.fetch(delivery('{"n":1}', "delivery-confirm"));
      expect(res.status).toBe(200);
    } finally {
      submit.mockRestore();
    }
    expect(s.receipts().map((row) => row["state"])).toEqual(["accepted"]);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ body: '{"n":1}' });
    expectOwnerOnly(path);
    gate.open();
    await s.ingress.idle();
    expect(count.handled).toBe(1);
  });

  test("a record an earlier attempt left is reused with this attempt's time, so the age rule keeps it", async () => {
    const gate = deferred();
    const { r, count } = counted(gate.promise);
    const s = setUp(r);
    const dir = join(s.hangarRoot, "ingress", "test");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${digestOf("delivery-reused")}.json`);
    writeFileSync(path, "{}\n", { mode: 0o600 });
    const old = (clock.now - IDEMPOTENCY_TTL_MS - MINUTE) / 1000;
    utimesSync(path, old, old);
    expect((await s.ingress.fetch(delivery("{}", "delivery-reused"))).status).toBe(200);
    expect(statSync(path).mtimeMs).toBe(clock.now);
    expect(s.receipts().map((row) => row["state"])).toEqual(["accepted"]);
    gate.open();
    await s.ingress.idle();
    expect(count.handled).toBe(1);
  });

  test("work that throws settles the receipt failed", async () => {
    const s = setUp(
      receiver({
        handle: async () => {
          throw new Error("boom");
        },
      }),
    );
    await s.ingress.fetch(delivery("{}", "delivery-3"));
    await s.ingress.idle();
    const [receipt] = s.receipts();
    expect(receipt?.["state"]).toBe("failed");
    expect((receipt?.["outcome"] as { code: string }).code).toBe("internal");
  });

  test("an unknown provider and another path: 404", async () => {
    const s = setUp(receiver());
    const other = new Request("http://127.0.0.1/hooks/nobody/x", { method: "POST", body: "{}" });
    expect((await s.ingress.fetch(other)).status).toBe(404);
    expect((await s.ingress.fetch(new Request("http://127.0.0.1/api/fleet"))).status).toBe(404);
  });
});

describe("the inbound sweep", () => {
  useClock();

  const inboundSweep = (hangarRoot: string, warnings: string[] = []) => {
    const sweep = CORE_SWEEPS.find((candidate) => candidate.name === "inbound");
    if (sweep === undefined) throw new Error("no inbound sweep");
    return sweep.run({
      home: { hangarRoot } as unknown as HomePorts,
      now: clock.now,
      jobs: {} as never,
      warn: (message) => warnings.push(message),
    });
  };

  test("a body is dropped once recovery ends its receipt, and its claim is kept", async () => {
    const gate = deferred();
    const { r, count } = counted(gate.promise);
    const warningsA: string[] = [];
    const a = setUp(r, warningsA, { pid: 1001 });
    expect((await a.ingress.fetch(delivery('{"n":1}', "delivery-orphan"))).status).toBe(200);
    expect(a.receipts().map((row) => row["state"])).toEqual(["accepted"]);
    expect(a.inbound()).toEqual([`${digestOf("delivery-orphan")}.json`]);

    // Another head, which sees the first one's process gone, recovers its receipt.
    const b = setUp(r, [], {
      hangarRoot: a.hangarRoot,
      pid: 2002,
      probe: { isAlive: (pid) => pid !== 1001, startTimeMs: () => undefined },
    });
    await b.control.commands.recover("all");
    expect(b.receipts().map((row) => row["state"])).toEqual(["unknown"]);
    const claimsBefore = treeBytes(join(a.hangarRoot, "control", "claims"));

    await inboundSweep(a.hangarRoot);
    expect(a.inbound()).toEqual([]);
    expect(treeBytes(join(a.hangarRoot, "control", "claims"))).toEqual(claimsBefore);
    expect(b.claims()).toHaveLength(1);
    const replay = await b.ingress.fetch(delivery('{"n":1}', "delivery-orphan"));
    expect(await replay.json()).toEqual({ duplicate: true });
    expect(count.handled).toBe(1);

    gate.open();
    await a.ingress.idle();
    expect(warningsA.some((w) => w.includes("not-accepted"))).toBe(true);
    expect(a.receipts().map((row) => row["state"])).toEqual(["unknown"]);
    expect(a.inbound()).toEqual([]);
  });

  test("an unclaimed or never-recorded body goes only once it is old, and nothing else is touched", async () => {
    const s = setUp(receiver());
    const dir = join(s.hangarRoot, "ingress", "test");
    mkdirSync(dir, { recursive: true });
    const old = (clock.now - IDEMPOTENCY_TTL_MS - MINUTE) / 1000;
    const young = (clock.now - IDEMPOTENCY_TTL_MS + MINUTE) / 1000;
    const plantRecord = (id: string, at: number): string => {
      const path = join(dir, `${digestOf(id)}.json`);
      writeFileSync(path, "{}\n", { mode: 0o600 });
      utimesSync(path, at, at);
      return path;
    };
    const unclaimedOld = plantRecord("unclaimed-old", old);
    const unclaimedYoung = plantRecord("unclaimed-young", young);
    await plantNeverRecorded(s.control, "never-old");
    await plantNeverRecorded(s.control, "never-young");
    const neverOld = plantRecord("never-old", old);
    const neverYoung = plantRecord("never-young", young);
    // An open receipt's record stays, however old.
    const digest = digestOf("open-old");
    const held = await s.control.commands.submit({
      kind: "legacy.hookTest",
      actor: "sys:ingress",
      ledger: "workspace",
      via: "github",
      params: { provider: "test", delivery: digest },
      dedupeClaim: `ingress/test-${digest}`,
    });
    expect(held.ok).toBe(true);
    const openOld = plantRecord("open-old", old);
    // A linked provider directory, a linked record and a name that is not a digest.
    const elsewhere = mkdtempSync(join(tmpdir(), "hangar-ingress-elsewhere-"));
    roots.push(elsewhere);
    const target = join(elsewhere, `${digestOf("linked")}.json`);
    writeFileSync(target, "{}\n");
    utimesSync(target, old, old);
    symlinkSync(elsewhere, join(s.hangarRoot, "ingress", "linked"));
    const linkedRecord = join(dir, `${digestOf("linked-record")}.json`);
    symlinkSync(target, linkedRecord);
    const notDigest = join(dir, "not-a-digest.json");
    writeFileSync(notDigest, "{}\n");
    utimesSync(notDigest, old, old);
    const claimsBefore = treeBytes(join(s.hangarRoot, "control", "claims"));

    await inboundSweep(s.hangarRoot);
    expect(existsSync(unclaimedOld)).toBe(false);
    expect(existsSync(unclaimedYoung)).toBe(true);
    expect(existsSync(neverOld)).toBe(false);
    expect(existsSync(neverYoung)).toBe(true);
    expect(existsSync(openOld)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(linkedRecord).isSymbolicLink()).toBe(true);
    expect(existsSync(notDigest)).toBe(true);
    expect(treeBytes(join(s.hangarRoot, "control", "claims"))).toEqual(claimsBefore);
  });

  for (const [what, change] of [
    [
      "is written again",
      (path: string): void => {
        utimesSync(path, clock.now / 1000, clock.now / 1000);
      },
    ],
    [
      "is claimed",
      (_path: string, hangarRoot: string, digest: string): void => {
        const published = publishClaim(
          workspaceCommandsLedger(hangarRoot),
          `ingress/test-${digest}`,
          { id: "cmd_newer" },
        );
        if (!published.ok) throw new Error(published.reason);
      },
    ],
  ] as const) {
    test(`an old unclaimed body stays when it ${what} before the sweep takes the ledger lock`, async () => {
      const s = setUp(receiver());
      const dir = join(s.hangarRoot, "ingress", "test");
      mkdirSync(dir, { recursive: true });
      const digest = digestOf(`delivery-${what}`);
      const path = join(dir, `${digest}.json`);
      writeFileSync(path, "{}\n", { mode: 0o600 });
      const old = (clock.now - IDEMPOTENCY_TTL_MS - MINUTE) / 1000;
      utimesSync(path, old, old);
      const warnings: string[] = [];
      // The sweep has looked at the record; the change lands before its lock is taken.
      const real = records.withLedgerLock;
      let changed = 0;
      const lock = spyOn(records, "withLedgerLock").mockImplementation(((ledger, fn) => {
        changed += 1;
        change(path, s.hangarRoot, digest);
        return real(ledger, fn);
      }) as typeof real);
      let swept: unknown;
      try {
        swept = await sweepInboundRecords(s.hangarRoot, clock.now, (m) => warnings.push(m));
      } finally {
        lock.mockRestore();
      }
      expect(changed).toBe(1);
      expect(swept).toEqual({ checked: 1, removed: 0, truncated: false });
      expect(existsSync(path)).toBe(true);
      expect(warnings).toEqual([]);
    });
  }
});

describe("the receivers a composition may hold", () => {
  test("each refusal is named", () => {
    const problems = receiverProblems([
      { area: "core", receiver: receiver() },
      { area: "integrations", receiver: receiver() },
      { area: "core", receiver: receiver({ provider: "Bad_Name" }) },
      { area: "core", receiver: receiver({ provider: "o", origin: "webhook" as never }) },
      { area: "core", receiver: receiver({ provider: "v", via: "email" as never }) },
      { area: "core", receiver: receiver({ provider: "k", kind: "hooks.delivered" }) },
    ]);
    expect(problems).toEqual([
      'receiver "test" registered twice (areas "core" and "integrations")',
      'receiver provider "Bad_Name" is not a provider name (area "core")',
      'receiver "o" declares origin "webhook", which is not a TrustOrigin (area "core")',
      'receiver "v" declares via "email", which is not a receipt door (area "core")',
      'receiver "k" declares kind "hooks.delivered", which is not a receipt kind (area "core")',
    ]);
  });

  test("a sweep named twice or run more often than once a second is refused", () => {
    const tick = { name: "reconcile", everyMs: 500, run: () => undefined };
    expect(homeCompositionProblems([HOME_CORE, { area: "quality", sweeps: [tick] }])).toEqual([
      'sweep "reconcile" registered twice (areas "core" and "quality")',
      'sweep "reconcile" runs every 500 ms, more often than once a second (area "quality")',
    ]);
    expect(homeCompositionProblems([HOME_CORE])).toEqual([]);
  });
});

describe("Home's listeners", () => {
  let serveSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    serveSpy?.mockRestore();
    serveSpy = undefined;
  });

  test("the console never answers /hooks, and with no receiver composed nothing more binds", async () => {
    serveSpy = spyOn(Bun, "serve");
    const plain = bootTestServer();
    const baseline = serveSpy.mock.calls.length;
    await plain.stop();
    expect(baseline).toBeGreaterThan(0);
    serveSpy.mockClear();
    const t = bootTestServer({ ingress: { port: 0 } });
    try {
      // The console's own listeners, and nothing for the ingress.
      expect(serveSpy.mock.calls.length).toBe(baseline);
      expect(t.server.ingress).toBeUndefined();
      const res = await t.fetchRaw("/hooks/test/x", { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    } finally {
      await t.stop();
    }
  });

  test("every composition refusal is named in the boot error, and nothing binds", () => {
    serveSpy = spyOn(Bun, "serve");
    const fast = { name: "fast", everyMs: 100, run: () => undefined };
    let message = "";
    try {
      bootTestServer({
        areas: [
          HOME_CORE,
          {
            area: "integrations",
            sweeps: [fast, { ...fast, everyMs: 5000 }],
            receivers: [
              receiver(),
              receiver(),
              receiver({ provider: "No_Good" }),
              receiver({ provider: "o", origin: "webhook" as never }),
              receiver({ provider: "v", via: "email" as never }),
              receiver({ provider: "k", kind: "hooks.delivered" }),
            ],
          },
        ],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    for (const line of [
      'sweep "fast" registered twice (areas "integrations" and "integrations")',
      'sweep "fast" runs every 100 ms, more often than once a second (area "integrations")',
      'receiver "test" registered twice (areas "integrations" and "integrations")',
      'receiver provider "No_Good" is not a provider name (area "integrations")',
      'receiver "o" declares origin "webhook", which is not a TrustOrigin (area "integrations")',
      'receiver "v" declares via "email", which is not a receipt door (area "integrations")',
      'receiver "k" declares kind "hooks.delivered", which is not a receipt kind (area "integrations")',
    ]) {
      expect(message).toContain(line);
    }
    expect(serveSpy).toHaveBeenCalledTimes(0);
  });

  test("a receiver composed with an origin that is not a TrustOrigin refuses boot, naming it", () => {
    serveSpy = spyOn(Bun, "serve");
    expect(() =>
      bootTestServer({
        areas: [
          HOME_CORE,
          { area: "integrations", receivers: [receiver({ origin: "webhook" as never })] },
        ],
        ingress: { port: 0 },
      }),
    ).toThrow('receiver "test" declares origin "webhook", which is not a TrustOrigin');
    expect(serveSpy).toHaveBeenCalledTimes(0);
  });

  test("with a receiver composed, the ingress binds loopback and answers it there only", async () => {
    serveSpy = spyOn(Bun, "serve");
    // The console on another host than the ingress's, so an ingress that took the
    // console's host would be seen.
    const t = bootTestServer({
      hostname: "localhost",
      areas: [HOME_CORE, { area: "quality", receivers: [receiver()] }],
      ingress: { port: 0 },
    });
    try {
      const ingress = t.server.ingress;
      if (ingress === undefined) throw new Error("no ingress");
      expect(t.server.hostname).toBe("localhost");
      // The bind itself: the call that made the ingress's socket asked for loopback.
      const results = serveSpy.mock.results as { readonly value: { readonly port?: number } }[];
      const bound = serveSpy.mock.calls.filter(
        (_call, i) => results[i]?.value?.port === ingress.port,
      );
      expect(bound).toHaveLength(1);
      expect((bound[0]?.[0] as { hostname?: string }).hostname).toBe("127.0.0.1");
      expect(ingress.hostname).toBe("127.0.0.1");
      const body = '{"n":1}';
      const res = await fetch(`${ingress.url}/hooks/test/events`, {
        method: "POST",
        headers: {
          "x-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
          "x-delivery": "listener-1",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);
      expect((await fetch(`${ingress.url}/api/fleet`)).status).toBe(404);
    } finally {
      await t.stop();
    }
  });
});
