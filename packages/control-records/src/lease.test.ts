import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  type LeaseProbe,
  type LeaseRecord,
  _setLeaseSeamsForTest,
  acquireMutatingLease,
  readMutatingLease,
  withMutatingLease,
} from "./lease";
import { controlFile, jsonLine, plant, removeTempDirs, tempDir } from "./test-helpers";

afterEach(() => _setLeaseSeamsForTest(undefined));
afterAll(removeTempDirs);

const ALIVE: LeaseProbe = { isAlive: () => true, startTimeMs: () => undefined };
const WHO = { head: "server", kind: "eval run" } as const;
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

const leaseFile = (root: string): string => controlFile(root, "leases/mutating.json");

function holder(change: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    v: 1,
    pid: 4242,
    host: hostname(),
    head: "cli",
    kind: "optimize",
    acquiredAt: "2026-11-07T00:00:00.000Z",
    leaseRef: "aaaa",
    ...change,
  };
}

function harnessHeldBy(lease: LeaseRecord): string {
  const root = tempDir();
  plant(leaseFile(root), jsonLine(lease));
  return root;
}

function fakeTime(): { readonly sleep: (ms: number) => Promise<void>; polls: () => number } {
  let polls = 0;
  return {
    sleep: async () => {
      polls += 1;
    },
    polls: () => polls,
  };
}

describe("taking the lease", () => {
  test("a free lease is taken, recording who, and owner-only", async () => {
    const root = tempDir();
    const answer = await acquireMutatingLease(root, WHO, {
      probe: { isAlive: () => true, startTimeMs: () => 1234 },
      now: () => NOW,
    });
    if (!answer.ok) throw new Error("not taken");
    const body = JSON.parse(readFileSync(leaseFile(root), "utf8"));
    expect(body).toEqual({
      v: 1,
      pid: process.pid,
      startedAt: 1234,
      host: hostname(),
      head: "server",
      kind: "eval run",
      acquiredAt: new Date(NOW).toISOString(),
      leaseRef: answer.lease.leaseRef,
    });
    expect(answer.lease.leaseRef).toMatch(/^[0-9a-f]+$/);
    if (process.platform !== "win32") {
      expect(statSync(leaseFile(root)).mode & 0o777).toBe(0o600);
    }
  });

  test("no start time is recorded when the probe has none", async () => {
    const root = tempDir();
    await acquireMutatingLease(root, WHO, { probe: ALIVE });
    expect("startedAt" in JSON.parse(readFileSync(leaseFile(root), "utf8"))).toBe(false);
  });

  test("a contender polls, then refuses naming kind, head, pid, host and since", async () => {
    const root = harnessHeldBy(holder());
    const time = fakeTime();
    const answer = await acquireMutatingLease(root, WHO, {
      waitMs: 1000,
      probe: ALIVE,
      sleep: time.sleep,
    });
    expect(answer).toEqual({
      ok: false,
      holder: {
        kind: "optimize",
        head: "cli",
        pid: 4242,
        host: hostname(),
        since: "2026-11-07T00:00:00.000Z",
      },
    });
    expect(time.polls()).toBeGreaterThan(1);
  });

  test("waitMs 0 refuses without sleeping", async () => {
    const time = fakeTime();
    const answer = await acquireMutatingLease(harnessHeldBy(holder()), WHO, {
      waitMs: 0,
      probe: ALIVE,
      sleep: time.sleep,
    });
    expect(answer.ok).toBe(false);
    expect(time.polls()).toBe(0);
  });

  test("a holder that releases during the wait hands over", async () => {
    const root = tempDir();
    const first = await acquireMutatingLease(root, WHO, { probe: ALIVE });
    if (!first.ok) throw new Error("not taken");
    const second = await acquireMutatingLease(
      root,
      { head: "cli", kind: "dream" },
      {
        probe: ALIVE,
        sleep: async () => {
          first.release();
        },
      },
    );
    expect(second.ok).toBe(true);
    expect(readFileSync(leaseFile(root), "utf8")).toContain("dream");
  });
});

describe("breaking the lease", () => {
  const take = (root: string, probe: LeaseProbe) =>
    acquireMutatingLease(root, WHO, { waitMs: 0, probe });

  test("isAlive false: broken, and the new holder is recorded", async () => {
    const root = harnessHeldBy(holder());
    const answer = await take(root, { isAlive: () => false, startTimeMs: () => undefined });
    expect(answer.ok).toBe(true);
    const read = readMutatingLease(root);
    expect(read.state === "present" && read.lease.kind).toBe("eval run");
  });

  test("isAlive undefined: held", async () => {
    const root = harnessHeldBy(holder());
    expect((await take(root, { isAlive: () => undefined, startTimeMs: () => undefined })).ok).toBe(
      false,
    );
    const read = readMutatingLease(root);
    expect(read.state === "present" && read.lease.kind).toBe("optimize");
  });

  test("a start time 3 s off: broken, because the pid was recycled", async () => {
    const root = harnessHeldBy(holder({ startedAt: 10_000 }));
    const answer = await take(root, { isAlive: () => true, startTimeMs: () => 13_000 });
    expect(answer.ok).toBe(true);
  });

  test("a start time within the tolerance: held", async () => {
    const root = harnessHeldBy(holder({ startedAt: 10_000 }));
    const answer = await take(root, { isAlive: () => true, startTimeMs: () => 12_000 });
    expect(answer.ok).toBe(false);
  });

  test("a recorded start time with an unknown probe: held", async () => {
    const root = harnessHeldBy(holder({ startedAt: 10_000 }));
    expect((await take(root, ALIVE)).ok).toBe(false);
  });

  test("no recorded start time: only isAlive decides", async () => {
    const root = harnessHeldBy(holder());
    expect((await take(root, { isAlive: () => true, startTimeMs: () => 99_999 })).ok).toBe(false);
  });

  test("a foreign host is always held, even when the probe says dead", async () => {
    const root = harnessHeldBy(holder({ host: "another-machine" }));
    const answer = await take(root, { isAlive: () => false, startTimeMs: () => undefined });
    expect(answer.ok).toBe(false);
  });

  test("any age is held: no clock can break a live holder", async () => {
    const root = harnessHeldBy(holder({ acquiredAt: "2001-01-01T00:00:00.000Z" }));
    const answer = await acquireMutatingLease(root, WHO, {
      waitMs: 0,
      probe: ALIVE,
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    });
    expect(answer.ok).toBe(false);
  });

  test("the default probe holds a pid that exists", async () => {
    const live = harnessHeldBy(holder({ pid: process.pid }));
    expect((await acquireMutatingLease(live, WHO, { waitMs: 0 })).ok).toBe(false);
  });

  test("the default probe breaks a pid that does not exist", async () => {
    if (process.platform === "win32") return; // kill(pid, 0) on an impossible pid is POSIX's answer
    const dead = harnessHeldBy(holder({ pid: 2_147_483_646 }));
    expect((await acquireMutatingLease(dead, WHO, { waitMs: 0 })).ok).toBe(true);
  });

  test("a holder it records carries no start time, because the default probe knows none", async () => {
    const root = tempDir();
    await acquireMutatingLease(root, WHO, { waitMs: 0 });
    expect("startedAt" in JSON.parse(readFileSync(leaseFile(root), "utf8"))).toBe(false);
  });

  test("two contenders racing one dead holder: exactly one acquires", async () => {
    const root = harnessHeldBy(holder());
    const dead = (pid: number): boolean => pid !== 4242;
    const probe: LeaseProbe = { isAlive: dead, startTimeMs: () => undefined };
    let second: Awaited<ReturnType<typeof acquireMutatingLease>> | undefined;
    _setLeaseSeamsForTest({
      afterInspect: async () => {
        // Inside the first contender's gap between inspect and break, the other runs whole.
        _setLeaseSeamsForTest(undefined);
        second = await acquireMutatingLease(
          root,
          { head: "cli", kind: "second" },
          {
            waitMs: 0,
            probe,
          },
        );
      },
    });
    const first = await acquireMutatingLease(
      root,
      { head: "cli", kind: "first" },
      {
        waitMs: 0,
        probe,
      },
    );
    expect(second?.ok).toBe(true);
    expect(first).toMatchObject({ ok: false, holder: { kind: "second" } });
    const read = readMutatingLease(root);
    expect(read.state === "present" && read.lease.kind).toBe("second");
  });

  test("a successor published between inspect and break is not removed", async () => {
    const root = harnessHeldBy(holder());
    const successor = holder({ pid: process.pid, kind: "successor", leaseRef: "bbbb" });
    _setLeaseSeamsForTest({
      afterInspect: () => {
        writeFileSync(leaseFile(root), jsonLine(successor));
      },
    });
    const answer = await acquireMutatingLease(root, WHO, {
      waitMs: 0,
      probe: { isAlive: (pid) => pid === process.pid, startTimeMs: () => undefined },
    });
    expect(answer).toMatchObject({ ok: false, holder: { kind: "successor" } });
    const read = readMutatingLease(root);
    expect(read.state === "present" && read.lease.leaseRef).toBe("bbbb");
  });

  test("an unreadable lease file is held, and its refusal says how to clear it", async () => {
    for (const body of ["", "not json\n", jsonLine({ v: 2 }), jsonLine({ ...holder(), pid: -1 })]) {
      const root = tempDir();
      plant(leaseFile(root), body);
      const answer = await acquireMutatingLease(root, WHO, {
        waitMs: 0,
        probe: { isAlive: () => false, startTimeMs: () => undefined },
      });
      expect(answer).toMatchObject({ ok: false, code: "io-error" });
      if (answer.ok || !("reason" in answer)) throw new Error("not a refusal");
      expect(answer.reason).toContain("if nothing is running");
      expect(answer.reason).toContain("delete");
      expect(answer.reason).toContain("mutating.json");
      expect(readFileSync(leaseFile(root), "utf8")).toBe(body);
    }
  });
});

describe("release", () => {
  test("release removes the holder's own lease", async () => {
    const root = tempDir();
    const held = await acquireMutatingLease(root, WHO, { probe: ALIVE });
    if (!held.ok) throw new Error("not taken");
    expect(held.release()).toBe(true);
    expect(existsSync(leaseFile(root))).toBe(false);
    expect(held.release()).toBe(false);
  });

  test("release leaves a successor's lease alone", async () => {
    const root = tempDir();
    const held = await acquireMutatingLease(root, WHO, { probe: ALIVE });
    if (!held.ok) throw new Error("not taken");
    const successor = jsonLine(holder({ leaseRef: "successor" }));
    writeFileSync(leaseFile(root), successor);
    expect(held.release()).toBe(false);
    expect(readFileSync(leaseFile(root), "utf8")).toBe(successor);
  });

  test("withMutatingLease holds it while fn runs, and hands back the value", async () => {
    const root = tempDir();
    const answer = await withMutatingLease(
      root,
      WHO,
      (lease) => {
        const read = readMutatingLease(root);
        expect(read.state === "present" && read.lease.leaseRef).toBe(lease.leaseRef);
        return 7;
      },
      { probe: ALIVE },
    );
    expect(answer).toEqual({ ok: true, value: 7 });
    expect(existsSync(leaseFile(root))).toBe(false);
  });

  test("withMutatingLease releases when fn throws", async () => {
    const root = tempDir();
    await expect(
      withMutatingLease(
        root,
        WHO,
        async () => {
          throw new Error("job failed");
        },
        { probe: ALIVE },
      ),
    ).rejects.toThrow("job failed");
    expect(existsSync(leaseFile(root))).toBe(false);
  });

  test("withMutatingLease answers the refusal and does not run fn when refused", async () => {
    const root = harnessHeldBy(holder());
    let ran = false;
    const answer = await withMutatingLease(
      root,
      WHO,
      () => {
        ran = true;
      },
      { waitMs: 0, probe: ALIVE },
    );
    expect(answer.ok).toBe(false);
    expect(ran).toBe(false);
  });
});

describe("readMutatingLease", () => {
  test("absent, present and unreadable", () => {
    expect(readMutatingLease(tempDir())).toEqual({ state: "absent" });
    const lease = holder({ startedAt: 5 });
    expect(readMutatingLease(harnessHeldBy(lease))).toEqual({ state: "present", lease });
    const root = tempDir();
    plant(leaseFile(root), "garbage");
    expect(readMutatingLease(root).state).toBe("unreadable");
  });

  test("each malformed field is unreadable", () => {
    const bad: readonly Partial<Record<keyof LeaseRecord, unknown>>[] = [
      { v: 2 },
      { pid: 0 },
      { pid: "1" },
      { startedAt: "soon" },
      { host: 1 },
      { head: "somewhere" },
      { kind: 1 },
      { acquiredAt: 1 },
      { leaseRef: "" },
    ];
    for (const change of bad) {
      const root = tempDir();
      plant(leaseFile(root), jsonLine({ ...holder(), ...change }));
      expect(readMutatingLease(root).state).toBe("unreadable");
    }
  });
});
