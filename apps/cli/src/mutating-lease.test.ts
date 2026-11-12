import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { LeaseProbe } from "@crewhaus/control-records";
import {
  LEASE_BUSY_EXIT,
  _releaseHeldLeasesForTest,
  holdCliMutatingLease,
  withCliMutatingLease,
} from "./mutating-lease";

const dirs: string[] = [];
afterEach(() => {
  _releaseHeldLeasesForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ALIVE: LeaseProbe = { isAlive: () => true, startTimeMs: () => undefined };

function harness(withRun = true): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-lease-"));
  dirs.push(dir);
  if (withRun) mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
  return dir;
}

const leaseFile = (dir: string): string =>
  join(dir, ".crewhaus", "run", "control", "leases", "mutating.json");

/** Home holding the harness, as its job runner would. */
function heldByHome(dir: string, leaseRef = "home-lease-ref"): void {
  mkdirSync(join(dir, ".crewhaus", "run", "control", "leases"), { recursive: true });
  writeFileSync(
    leaseFile(dir),
    `${JSON.stringify({
      v: 1,
      pid: 4242,
      host: hostname(),
      head: "server",
      kind: "eval",
      acquiredAt: "2026-11-11T00:00:00.000Z",
      leaseRef,
    })}\n`,
  );
}

function fakeSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly polls: () => number;
} {
  let polls = 0;
  return {
    sleep: async () => {
      polls += 1;
    },
    polls: () => polls,
  };
}

describe("the CLI's mutating lease", () => {
  test("a held lease: it waits, then refuses naming the holder, with exit 53, and runs nothing", async () => {
    const dir = harness();
    heldByHome(dir);
    const time = fakeSleep();
    let ran = false;
    const answer = await withCliMutatingLease(
      dir,
      "optimize",
      () => {
        ran = true;
      },
      { env: {}, probe: ALIVE, sleep: time.sleep, waitMs: 1000 },
    );
    expect(ran).toBe(false);
    expect(time.polls()).toBe(4);
    if (answer.ok) throw new Error("it must refuse");
    expect(answer.exitCode).toBe(53);
    expect(LEASE_BUSY_EXIT).toBe(53);
    const text = answer.lines.join("\n");
    expect(text).toContain("`crewhaus eval` from Home");
    expect(text).toContain("pid 4242");
    expect(text).toContain("since 2026-11-11T00:00:00.000Z");
  });

  test("the lease its parent holds: CREWHAUS_LEASE_REF matching it runs at once", async () => {
    const dir = harness();
    heldByHome(dir, "parent-ref");
    const before = readFileSync(leaseFile(dir), "utf8");
    const time = fakeSleep();
    const answer = await withCliMutatingLease(dir, "eval", () => "ran", {
      env: { CREWHAUS_LEASE_REF: "parent-ref" },
      probe: ALIVE,
      sleep: time.sleep,
    });
    expect(answer).toEqual({ ok: true, value: "ran" });
    expect(time.polls()).toBe(0);
    expect(readFileSync(leaseFile(dir), "utf8")).toBe(before);
  });

  test("a ref that names another lease is no pass: it waits like anyone", async () => {
    const dir = harness();
    heldByHome(dir, "parent-ref");
    const time = fakeSleep();
    const answer = await withCliMutatingLease(dir, "eval", () => "ran", {
      env: { CREWHAUS_LEASE_REF: "some-other-ref" },
      probe: ALIVE,
      sleep: time.sleep,
      waitMs: 500,
    });
    expect(answer.ok).toBe(false);
    expect(time.polls()).toBeGreaterThan(0);
  });

  test("a harness with no .crewhaus/run runs, and the lease creates nothing", async () => {
    const dir = harness(false);
    const answer = await withCliMutatingLease(dir, "compile", () => "ran", {
      env: {},
      probe: ALIVE,
    });
    expect(answer).toEqual({ ok: true, value: "ran" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a free harness: the lease is held while it runs and released after", async () => {
    const dir = harness();
    let during: Record<string, unknown> | undefined;
    const answer = await withCliMutatingLease(
      dir,
      "dream run",
      () => {
        during = JSON.parse(readFileSync(leaseFile(dir), "utf8")) as Record<string, unknown>;
        return 7;
      },
      { env: {}, probe: ALIVE },
    );
    expect(answer).toEqual({ ok: true, value: 7 });
    expect(during?.["head"]).toBe("cli");
    expect(during?.["kind"]).toBe("dream run");
    expect(during?.["pid"]).toBe(process.pid);
    expect(existsSync(leaseFile(dir))).toBe(false);
  });

  test("this process already holding it: a nested verb runs without waiting on itself", async () => {
    const dir = harness();
    const time = fakeSleep();
    const answer = await withCliMutatingLease(
      dir,
      "eval suite",
      () =>
        withCliMutatingLease(dir, "eval", () => "inner", {
          env: {},
          probe: ALIVE,
          sleep: time.sleep,
          waitMs: 500,
        }),
      { env: {}, probe: ALIVE },
    );
    expect(answer).toEqual({ ok: true, value: { ok: true, value: "inner" } });
    expect(time.polls()).toBe(0);
  });

  test("held for the process: a refusal prints the holder and exits 53", async () => {
    const dir = harness();
    heldByHome(dir);
    const written: string[] = [];
    const exits: number[] = [];
    await holdCliMutatingLease(dir, "compile", {
      env: {},
      probe: ALIVE,
      sleep: fakeSleep().sleep,
      waitMs: 0,
      writeErr: (text) => written.push(text),
      exit: ((code: number) => {
        exits.push(code);
      }) as (code: number) => never,
    });
    expect(exits).toEqual([53]);
    expect(written.join("")).toContain("another change is running on this harness");
  });

  test("held for the process: a free harness is taken and kept", async () => {
    const dir = harness();
    await holdCliMutatingLease(dir, "compile", { env: {}, probe: ALIVE });
    const lease = JSON.parse(readFileSync(leaseFile(dir), "utf8")) as Record<string, unknown>;
    expect(lease["kind"]).toBe("compile");
    // A second verb in the same process does not wait on its own lease.
    const again = await withCliMutatingLease(dir, "eval", () => "ran", {
      env: {},
      probe: ALIVE,
      waitMs: 0,
    });
    expect(again).toEqual({ ok: true, value: "ran" });
  });
});
