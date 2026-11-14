/**
 * Every accepted channel message is on record before the platform is told `ok`,
 * and a run whose turn never started is closed.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_RUN_ID_RE, mintId } from "@crewhaus/control-contract";
import {
  type DigestKeyRead,
  append,
  controlPaths,
  foldStates,
  readDigestKey,
  runsLedger,
} from "@crewhaus/control-records";
import { createRunContext } from "@crewhaus/run-context";
import { acceptInbound, handleInboundEvent } from "./inbound";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const savedLedger = process.env["CREWHAUS_RUN_LEDGER"];
afterEach(() => {
  if (savedLedger === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_RUN_LEDGER");
  else process.env["CREWHAUS_RUN_LEDGER"] = savedLedger;
});

const TEXT = "please deploy the staging branch tonight";

const EVENT = {
  idempotencyKey: "Ev0123456789",
  workspaceId: "T0WORKSPACE",
  channelId: "C0CHANNEL",
  userId: "U0SENDER",
  ts: "1700000000.000100",
  text: TEXT,
};

const SLACK = { id: "slack" };

function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "inbound-")));
  roots.push(dir);
  return dir;
}

function rows(dir: string): Record<string, unknown>[] {
  const runs = join(dir, controlPaths(dir).runsDir);
  let names: string[];
  try {
    names = readdirSync(runs).sort();
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readFileSync(join(runs, name), "utf8").split("\n"))
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rawLines(dir: string): string[] {
  const runs = join(dir, controlPaths(dir).runsDir);
  return readdirSync(runs)
    .sort()
    .flatMap((name) => readFileSync(join(runs, name), "utf8").split("\n"))
    .filter((line) => line !== "");
}

const memoryDedup = () => {
  const seen = new Set<string>();
  return {
    remember: async (key: string): Promise<boolean> => {
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    },
  };
};

async function drain(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("handleInboundEvent", () => {
  test("the answer waits on the record: queued, then preparing, content-free, folding cleanly", async () => {
    const dir = harness();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handled: string[] = [];
    let answered = 0;
    const pending = handleInboundEvent(EVENT, SLACK, {
      dedup: memoryDedup(),
      sessionRouter: { handle: async (event) => void handled.push(event.idempotencyKey) },
      harnessDir: dir,
      digestKey: async (d) => {
        await held;
        return (await import("@crewhaus/control-records")).ensureDigestKey(d);
      },
    }).then((res) => {
      answered += 1;
      return res;
    });
    await drain();
    expect(answered).toBe(0);
    expect(rows(dir)).toEqual([]);
    release();
    const res = await pending;
    expect(answered).toBe(1);
    expect(await res.text()).toBe("ok");
    const written = rows(dir);
    expect(written.map((r) => r["state"])).toEqual(["queued", "preparing"]);
    const id = written[0]?.["id"];
    expect(typeof id === "string" && CANONICAL_RUN_ID_RE.test(id)).toBe(true);
    expect(written[1]?.["id"]).toBe(id);
    for (const row of written) {
      expect(Object.keys(row).sort()).toEqual(["at", "holder", "id", "state", "trigger"]);
      const trigger = row["trigger"] as Record<string, unknown>;
      expect(Object.keys(trigger).sort()).toEqual(["kind", "source", "via"]);
      expect(trigger["kind"]).toBe("channel");
      expect(trigger["via"]).toBe("slack");
      const source = trigger["source"] as Record<string, unknown>;
      expect(Object.keys(source).sort()).toEqual([
        "conversationRef",
        "messageRef",
        "platform",
        "senderRef",
      ]);
      expect(source["platform"]).toBe("slack");
      for (const field of ["conversationRef", "messageRef", "senderRef"]) {
        expect(source[field]).toMatch(/^[0-9a-f]{64}$/);
      }
      const holder = row["holder"] as Record<string, unknown>;
      expect(Object.keys(holder).sort()).toEqual(["host", "pid", "startedAt"]);
      expect(holder["pid"]).toBe(process.pid);
    }
    for (const line of rawLines(dir)) {
      expect(Buffer.byteLength(`${line}\n`)).toBeLessThan(4096);
      expect(line).not.toContain(TEXT);
      expect(line).not.toContain("please");
      for (const raw of [EVENT.idempotencyKey, EVENT.workspaceId, EVENT.channelId, EVENT.userId]) {
        expect(line).not.toContain(raw);
      }
    }
    const fold = foldStates(runsLedger(dir));
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toEqual([]);
    expect(fold.objects.get(id as string)?.state).toBe("preparing");
    await drain();
    expect(handled).toEqual([EVENT.idempotencyKey]);
  });

  test("a duplicate key answers duplicate and records nothing more", async () => {
    const dir = harness();
    const dedup = memoryDedup();
    const deps = { dedup, sessionRouter: { handle: async () => undefined }, harnessDir: dir };
    expect(await (await handleInboundEvent(EVENT, SLACK, deps)).text()).toBe("ok");
    await drain();
    const after = rows(dir).length;
    const again = await handleInboundEvent(EVENT, SLACK, deps);
    expect(await again.text()).toBe("duplicate");
    expect(rows(dir)).toHaveLength(after);
  });

  test("a failing append still accepts the message, with one stderr line", async () => {
    const dir = harness();
    // The run ledger's directory is a file: no row can land.
    const control = join(dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, "runs"), "not a directory");
    const lines: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    let res: Response;
    try {
      res = await handleInboundEvent(EVENT, SLACK, {
        dedup: memoryDedup(),
        sessionRouter: { handle: async () => undefined },
        harnessDir: dir,
      });
      await drain();
    } finally {
      spy.mockRestore();
    }
    expect(await res.text()).toBe("ok");
    const notRecorded = lines.filter((l) => l.startsWith("[gateway] run not recorded: "));
    expect(notRecorded).toHaveLength(1);
    expect(lines.filter((l) => l.includes("not settled"))).toEqual([]);
  });

  test("CREWHAUS_RUN_LEDGER=0 writes no row, and still runs the turn in its scope", async () => {
    process.env["CREWHAUS_RUN_LEDGER"] = "0";
    const dir = harness();
    let runId: string | undefined;
    await handleInboundEvent(EVENT, SLACK, {
      dedup: memoryDedup(),
      sessionRouter: {
        handle: async () => {
          runId = createRunContext().runId;
        },
      },
      harnessDir: dir,
    });
    await drain();
    expect(rows(dir)).toEqual([]);
    expect(runId).toMatch(CANONICAL_RUN_ID_RE);
    // No key was made either: nothing at all under the control directory.
    expect((await readDigestKey(dir)).state).toBe("absent");
  });
});

describe("acceptInbound", () => {
  test("a linked sender is named by the member, an unlinked one by a keyed digest", async () => {
    const dir = harness();
    const member = mintId("prn");
    const control = join(dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(
      join(control, "approvers.json"),
      JSON.stringify({
        v: 1,
        epoch: 1,
        generatedAt: new Date().toISOString(),
        harness: "hrn_00000000000000c1",
        owner: member,
        governedSince: new Date().toISOString(),
        members: [],
        links: [{ external: `slack:${EVENT.workspaceId}:${EVENT.userId}`, principal: member }],
      }),
    );
    await acceptInbound(EVENT, SLACK, { harnessDir: dir });
    const linked = rows(dir)[0]?.["trigger"] as { source: { senderRef: string } };
    expect(linked.source.senderRef).toBe(member);
    // Another platform has no links: a digest, and no `via`.
    await acceptInbound(EVENT, { id: "telegram" }, { harnessDir: dir });
    const other = rows(dir)[2]?.["trigger"] as Record<string, unknown>;
    expect(other["via"]).toBeUndefined();
    expect((other["source"] as { senderRef: string }).senderRef).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a digest key that cannot be read leaves the refs out; the rows are still written", async () => {
    const dir = harness();
    const unreadable = async (): Promise<DigestKeyRead> => ({ state: "unreadable", reason: "x" });
    await acceptInbound(EVENT, SLACK, { harnessDir: dir, digestKey: unreadable });
    const written = rows(dir);
    expect(written.map((r) => r["state"])).toEqual(["queued", "preparing"]);
    expect(written[0]?.["trigger"]).toEqual({ kind: "channel", via: "slack" });
  });

  test("the first context in the run's scope takes its id; a later one names it as parent", async () => {
    const dir = harness();
    const accepted = await acceptInbound(EVENT, SLACK, { harnessDir: dir });
    const [first, second] = await accepted.run(async () => [
      createRunContext(),
      createRunContext(),
    ]);
    expect(first?.runId).toBe(accepted.runId);
    expect(first?.trigger?.kind).toBe("channel");
    expect(second?.runId).not.toBe(accepted.runId);
    expect(second?.parent).toBe(accepted.runId);
  });
});

describe("a run its turn never reached is closed", () => {
  const close = async (fn: (runId: string, dir: string) => Promise<void>) => {
    const dir = harness();
    const accepted = await acceptInbound(EVENT, SLACK, { harnessDir: dir });
    let threw: unknown;
    try {
      await accepted.run(() => fn(accepted.runId, dir));
    } catch (err) {
      threw = err;
    }
    const fold = foldStates(runsLedger(dir));
    if (!fold.ok) throw new Error(fold.reason);
    return { dir, rows: rows(dir), threw, fold, runId: accepted.runId };
  };

  test("it threw before any row: failed, not started, and the throw goes on", async () => {
    const out = await close(async () => {
      throw new Error("boom");
    });
    expect((out.threw as Error).message).toBe("boom");
    expect(out.rows.map((r) => r["state"])).toEqual(["queued", "preparing", "failed"]);
    expect(out.rows[2]?.["failureClass"]).toBe("not-started");
    expect(out.fold.anomalies).toEqual([]);
  });

  test("it returned with no row (a paused harness's notice, a skipped turn): cancelled, not admitted", async () => {
    const out = await close(async () => undefined);
    expect(out.rows.map((r) => r["state"])).toEqual(["queued", "preparing", "cancelled"]);
    expect(out.rows[2]?.["reason"]).toBe("not-admitted");
    expect((out.rows[2]?.["trigger"] as { kind: string }).kind).toBe("channel");
    expect(out.fold.anomalies).toEqual([]);
  });

  test("its context wrote running: the settle writes nothing after it", async () => {
    const out = await close(async (runId, dir) => {
      append(runsLedger(dir), {
        id: runId,
        state: "running",
        at: new Date().toISOString(),
        trigger: { kind: "channel" },
      });
    });
    expect(out.rows.map((r) => r["state"])).toEqual(["queued", "preparing", "running"]);
    expect(out.fold.anomalies).toEqual([]);
  });
});
