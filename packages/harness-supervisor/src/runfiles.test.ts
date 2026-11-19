import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_ID_RE,
  START_LOCK_MAX_AGE_MS,
  _setPruneSeamsForTest,
  acquireStartLock,
  appendRunLedger,
  clearRunfile,
  ensureRunDir,
  logsDir,
  newRunId,
  patchRunLedger,
  pruneRuns,
  prunedRunsPath,
  readPrunedRuns,
  readRetentionPolicy,
  readRunLedger,
  readRunfile,
  readStartLock,
  recentRuns,
  releaseStartLock,
  runDir,
  runLogPath,
  runPumpLockPath,
  runfileExists,
  startLockIsStale,
  startLockPath,
  writeRunfile,
} from "./runfiles";
import { DEFAULT_RETENTION, type DaemonRunfile, RUNFILE_NAME, RUNFILE_VERSION } from "./types";

const roots: string[] = [];
function tempHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-runfiles-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sampleRunfile(overrides: Partial<DaemonRunfile> = {}): DaemonRunfile {
  return {
    v: RUNFILE_VERSION,
    pid: 4242,
    pidStartTimeMs: 1_700_000_000_000,
    argvFingerprint: "f".repeat(32),
    port: 3000,
    controlPort: 3001,
    entry: "daemon.ts",
    bundleDir: "/h/dist",
    runId: "run_0123456789abcdef",
    startedAt: "2026-08-04T00:00:00.000Z",
    managerVersion: "0.5.0",
    ...overrides,
  };
}

describe("paths", () => {
  test("ops state lives under the HARNESS, never a central manager dir", () => {
    const dir = "/harnesses/support-bot";
    expect(runDir(dir)).toBe(join(dir, ".crewhaus", "run"));
    expect(logsDir(dir)).toBe(join(dir, ".crewhaus", "run", "logs"));
    expect(runLogPath(dir, "run_x")).toBe(join(dir, ".crewhaus", "run", "logs", "run_x.log"));
  });

  test("ensureRunDir creates the tree once, idempotently", () => {
    const dir = tempHarness();
    ensureRunDir(dir);
    ensureRunDir(dir);
    expect(statSync(logsDir(dir)).isDirectory()).toBe(true);
  });

  test("minted run ids match the SAFE_ID shape a server can path-segment", () => {
    expect(RUN_ID_RE.test(newRunId())).toBe(true);
    expect(newRunId(() => "0123456789abcdef")).toBe("run_0123456789abcdef");
  });
});

describe("the runfile", () => {
  test("round-trips and is written 0600", () => {
    const dir = tempHarness();
    const runfile = sampleRunfile();
    writeRunfile(dir, runfile);
    expect(readRunfile(dir)).toEqual(runfile);
    const mode = statSync(join(runDir(dir), RUNFILE_NAME)).mode & 0o777;
    // HM-188: Windows has no POSIX mode bits — `stat` reports 0666 for any
    // writable file and 0444 for a read-only one, and `chmod` only toggles
    // that one attribute. The 0600 claim is a POSIX claim; on Windows the
    // file inherits the directory's ACL, which this suite does not model.
    // What is still assertable there is owner read+write, and that the write
    // path ran at all.
    if (process.platform === "win32") expect(mode & 0o600).toBe(0o600);
    else expect(mode).toBe(0o600);
  });

  test("a corrupt or shape-invalid runfile reads as absent, never throws", () => {
    const dir = tempHarness();
    expect(readRunfile(dir)).toBeUndefined();
    ensureRunDir(dir);
    writeFileSync(join(runDir(dir), RUNFILE_NAME), "{not json");
    expect(readRunfile(dir)).toBeUndefined();
    writeFileSync(join(runDir(dir), RUNFILE_NAME), JSON.stringify({ pid: "nope" }));
    expect(readRunfile(dir)).toBeUndefined();
  });

  test("a version-less runfile from an older manager migrates on read", () => {
    const dir = tempHarness();
    ensureRunDir(dir);
    writeFileSync(
      join(runDir(dir), RUNFILE_NAME),
      JSON.stringify({ pid: 7, pidStartTimeMs: 1, argvFingerprint: "abc" }),
    );
    const read = readRunfile(dir);
    expect(read?.v).toBe(RUNFILE_VERSION);
    expect(read?.pid).toBe(7);
    expect(read?.entry).toBe("");
  });

  test("clearing is idempotent", () => {
    const dir = tempHarness();
    writeRunfile(dir, sampleRunfile());
    clearRunfile(dir);
    clearRunfile(dir);
    expect(readRunfile(dir)).toBeUndefined();
  });

  test("runfileExists answers without parsing", () => {
    const dir = tempHarness();
    expect(runfileExists(dir)).toBe(false);
    writeRunfile(dir, sampleRunfile());
    expect(runfileExists(dir)).toBe(true);
    // Even a corrupt one exists — the caller decides what to do about it.
    writeFileSync(join(runDir(dir), RUNFILE_NAME), "{not json");
    expect(runfileExists(dir)).toBe(true);
    expect(readRunfile(dir)).toBeUndefined();
  });
});

describe("the start lock", () => {
  const probe = (alive: readonly number[], startTimes: Record<number, number> = {}) => ({
    isAlive: (pid: number) => alive.includes(pid),
    startTimeMs: (pid: number) => startTimes[pid],
  });

  test("an unanswered liveness probe does NOT free the lock", () => {
    // The lock exists so that two managers cannot start the same harness. A
    // probe that did not answer — on Windows, powershell failing to start in
    // time — is not evidence the holder is gone, and treating it as such hands
    // the slot to a second manager while the first is still running. This is
    // the same reasoning the start-time comparison below already applied; the
    // liveness check used to be the one place that did not.
    const held = { pid: 100, pidStartTimeMs: 5_000, at: 1_000 };
    const unknown = {
      isAlive: (): boolean | undefined => undefined,
      startTimeMs: (): number | undefined => undefined,
    };
    expect(startLockIsStale(held, unknown, 2_000)).toBe(false);
    // ...while an OBSERVED death still frees it, so a manager killed
    // mid-preflight cannot wedge the harness shut.
    const dead = {
      isAlive: (): boolean | undefined => false,
      startTimeMs: (): number | undefined => undefined,
    };
    expect(startLockIsStale(held, dead, 2_000)).toBe(true);
  });

  test("only one starter can hold it — O_EXCL, not last-writer-wins", () => {
    const dir = tempHarness();
    expect(acquireStartLock(dir, { pid: 100, pidStartTimeMs: 5, at: 1_000 })).toBe(true);
    // The second manager loses. This is the window the runfile could never
    // cover: it is not written until AFTER the spawn, so preflight used to
    // run with the slot unclaimed and both managers spawned a daemon.
    expect(acquireStartLock(dir, { pid: 200, pidStartTimeMs: 6, at: 1_001 })).toBe(false);
    expect(readStartLock(dir)).toEqual({ pid: 100, pidStartTimeMs: 5, at: 1_000 });
    releaseStartLock(dir);
    expect(acquireStartLock(dir, { pid: 200, pidStartTimeMs: 6, at: 1_001 })).toBe(true);
  });

  test("releasing and reading are forgiving", () => {
    const dir = tempHarness();
    expect(readStartLock(dir)).toBeUndefined();
    releaseStartLock(dir);
    ensureRunDir(dir);
    writeFileSync(startLockPath(dir), "{not json");
    expect(readStartLock(dir)).toBeUndefined();
  });

  test("a lock is stale when its holder is gone, recycled, or simply too old", () => {
    const held = { pid: 100, pidStartTimeMs: 5_000, at: 1_000 };
    // Holder alive with the recorded start time: HELD.
    expect(startLockIsStale(held, probe([100], { 100: 5_000 }), 2_000)).toBe(false);
    // Holder gone: breakable — a manager killed mid-preflight must not wedge
    // the harness shut.
    expect(startLockIsStale(held, probe([], {}), 2_000)).toBe(true);
    // Pid recycled by an unrelated process: breakable.
    expect(startLockIsStale(held, probe([100], { 100: 900_000 }), 2_000)).toBe(true);
    // Older than any start can take: breakable even with the pid alive.
    expect(
      startLockIsStale(held, probe([100], { 100: 5_000 }), 1_000 + START_LOCK_MAX_AGE_MS + 1),
    ).toBe(true);
    // No lock at all is trivially breakable.
    expect(startLockIsStale(undefined, probe([100]), 2_000)).toBe(true);
    // An unknown start time errs toward HELD: stealing the slot from a
    // manager that is really there is the worse mistake.
    expect(startLockIsStale(held, probe([100], {}), 2_000)).toBe(false);
  });
});

describe("the run ledger", () => {
  test("a close patch folds onto the open record", () => {
    const dir = tempHarness();
    appendRunLedger(dir, {
      runId: "run_a",
      kind: "daemon",
      argv: ["bun", "dist/daemon.ts"],
      startedAt: "t0",
      logFile: "logs/run_a.log",
    });
    patchRunLedger(dir, { runId: "run_a", endedAt: "t1", exitCode: 31, failureClass: "billing" });
    const entries = readRunLedger(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      runId: "run_a",
      kind: "daemon",
      argv: ["bun", "dist/daemon.ts"],
      startedAt: "t0",
      endedAt: "t1",
      exitCode: 31,
      failureClass: "billing",
    });
  });

  test("a torn final line (a manager killed mid-append) never hides the history", () => {
    const dir = tempHarness();
    appendRunLedger(dir, {
      runId: "run_a",
      kind: "job",
      argv: ["bun", "dist/agent.ts"],
      startedAt: "t0",
      logFile: "logs/run_a.log",
    });
    appendFileSync(join(runDir(dir), "runs.jsonl"), '{"runId":"run_b","kind":"jo');
    const entries = readRunLedger(dir);
    expect(entries.map((e) => e.runId)).toEqual(["run_a"]);
  });

  test("order is first-appearance and recentRuns takes the tail", () => {
    const dir = tempHarness();
    for (const id of ["run_1", "run_2", "run_3"]) {
      appendRunLedger(dir, {
        runId: id,
        kind: "job",
        argv: ["bun"],
        startedAt: "t",
        logFile: `logs/${id}.log`,
      });
    }
    patchRunLedger(dir, { runId: "run_1", exitCode: 0 });
    expect(readRunLedger(dir).map((e) => e.runId)).toEqual(["run_1", "run_2", "run_3"]);
    expect(recentRuns(dir, 2).map((e) => e.runId)).toEqual(["run_2", "run_3"]);
  });

  test("a missing ledger reads as empty", () => {
    expect(readRunLedger(tempHarness())).toEqual([]);
  });
});

describe("retention", () => {
  function makeRun(dir: string, id: string, bytes: number): void {
    ensureRunDir(dir);
    appendRunLedger(dir, {
      runId: id,
      kind: "daemon",
      argv: ["bun"],
      startedAt: "t",
      logFile: `logs/${id}.log`,
    });
    writeFileSync(runLogPath(dir, id), "x".repeat(bytes));
    writeFileSync(join(logsDir(dir), `${id}.events.jsonl`), "{}\n");
    writeFileSync(join(logsDir(dir), `${id}.cursor`), "{}\n");
  }

  test("keeps the newest N runs and removes the whole artifact set", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 6 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    const result = pruneRuns(dir, { runs: 3, bytes: DEFAULT_RETENTION.bytes });
    expect(result.removedRuns).toEqual(ids.slice(0, 3));
    for (const id of ids.slice(0, 3)) {
      expect(() => statSync(runLogPath(dir, id))).toThrow();
      expect(() => statSync(join(logsDir(dir), `${id}.events.jsonl`))).toThrow();
      expect(() => statSync(join(logsDir(dir), `${id}.cursor`))).toThrow();
    }
    expect(statSync(runLogPath(dir, ids[5] as string)).size).toBe(10);
  });

  test("the byte cap evicts further runs from the oldest end", () => {
    const dir = tempHarness();
    const ids = ["run_a", "run_b", "run_c"].map((s) => `run_${s.slice(4).repeat(16).slice(0, 16)}`);
    for (const id of ids) makeRun(dir, id, 1_000);
    const result = pruneRuns(dir, { runs: 10, bytes: 1_500 });
    expect(result.removedRuns.length).toBeGreaterThanOrEqual(2);
    expect(result.removedRuns[0]).toBe(ids[0] as string);
    expect(statSync(runLogPath(dir, ids[2] as string)).size).toBe(1_000);
  });

  test("a live run is protected from a prune triggered by its siblings", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 4 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    const live = ids[0] as string;
    const result = pruneRuns(dir, { runs: 1, bytes: DEFAULT_RETENTION.bytes }, [live]);
    expect(result.removedRuns).not.toContain(live);
    expect(statSync(runLogPath(dir, live)).size).toBe(10);
  });

  test("the ledger is compacted once it far outgrows the retained window", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 8 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    const result = pruneRuns(dir, { runs: 2, bytes: DEFAULT_RETENTION.bytes });
    expect(result.compactedLedger).toBe(true);
    expect(readRunLedger(dir).map((e) => e.runId)).toEqual(ids.slice(6));
    // The compaction is an atomic rewrite — the file is still valid JSONL.
    const text = readFileSync(join(runDir(dir), "runs.jsonl"), "utf8");
    for (const line of text.split("\n").filter((l) => l !== "")) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("pruning an empty harness is a no-op", () => {
    const dir = tempHarness();
    expect(pruneRuns(dir)).toEqual({ removedRuns: [], removedBytes: 0, compactedLedger: false });
  });

  test("what is removed is on record before the first file goes, stamped by the clock given", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 3 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    const seen: string[] = [];
    _setPruneSeamsForTest({
      beforeUnlink: () => {
        if (seen.length === 0) seen.push(readFileSync(prunedRunsPath(dir), "utf8"));
      },
    });
    try {
      const at = Date.parse("2026-11-14T00:00:00.000Z");
      const result = pruneRuns(dir, { runs: 1, bytes: DEFAULT_RETENTION.bytes }, [], () => at);
      expect(result.removedRuns).toEqual(ids.slice(0, 2));
      expect(seen.map((text) => JSON.parse(text))).toEqual([
        { v: 1, at: "2026-11-14T00:00:00.000Z", runs: ids.slice(0, 2) },
      ]);
      expect([...readPrunedRuns(dir)]).toEqual(ids.slice(0, 2));
      if (process.platform !== "win32") {
        expect(statSync(prunedRunsPath(dir)).mode & 0o777).toBe(0o600);
      }
    } finally {
      _setPruneSeamsForTest(undefined);
    }
  });

  test("a marker that cannot be written removes nothing", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 3 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    mkdirSync(prunedRunsPath(dir));
    const result = pruneRuns(dir, { runs: 1, bytes: DEFAULT_RETENTION.bytes });
    expect(result).toEqual({ removedRuns: [], removedBytes: 0, compactedLedger: false });
    for (const id of ids) expect(statSync(runLogPath(dir, id)).size).toBe(10);
  });

  test("a run's pump lease goes with it only when its holder is gone", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 3 }, (_, i) => `run_${String(i).padStart(16, "0")}`);
    for (const id of ids) makeRun(dir, id, 10);
    const lease = (pid: number) =>
      JSON.stringify({ v: 1, pid, host: hostname(), at: "2020-01-01T00:00:00.000Z", pump: "p" });
    writeFileSync(runPumpLockPath(dir, ids[0] as string), lease(100));
    writeFileSync(runPumpLockPath(dir, ids[1] as string), lease(200));
    const probe = { isAlive: (pid: number) => pid === 200, startTimeMs: () => undefined };
    pruneRuns(dir, { runs: 1, bytes: DEFAULT_RETENTION.bytes }, [], Date.now, probe);
    expect(() => statSync(runPumpLockPath(dir, ids[0] as string))).toThrow();
    expect(statSync(runPumpLockPath(dir, ids[1] as string)).isFile()).toBe(true);
  });
});

describe("the prune record and the pump lease are read without following or waiting", () => {
  const ids = Array.from({ length: 3 }, (_, i) => `run_${String(i).padStart(16, "0")}`);

  test("a linked prune record is not on record; a prune older than the lines read is not either", () => {
    const dir = tempHarness();
    ensureRunDir(dir);
    const outside = join(tempHarness(), "elsewhere.jsonl");
    writeFileSync(outside, `${JSON.stringify({ v: 1, at: "t", runs: [ids[0]] })}\n`);
    symlinkSync(outside, prunedRunsPath(dir));
    expect([...readPrunedRuns(dir)]).toEqual([]);
    rmSync(prunedRunsPath(dir));
    const filler = `${JSON.stringify({ v: 1, at: "t", runs: [] })}\n`.repeat(3);
    writeFileSync(
      prunedRunsPath(dir),
      `${JSON.stringify({ v: 1, at: "t", runs: [ids[0]] })}\n${filler}`,
    );
    expect([...readPrunedRuns(dir, 3)]).toEqual([]);
    expect([...readPrunedRuns(dir, 4)]).toEqual([ids[0]]);
  });

  // A FIFO with no writer would hold a blocking open forever, so each call runs in a
  // child with a deadline: a call that waits is killed and fails the test.
  test.skipIf(process.platform === "win32")(
    "a FIFO at the prune record or the lease answers at once, refused",
    () => {
      const dir = tempHarness();
      for (const id of ids) {
        ensureRunDir(dir);
        appendRunLedger(dir, {
          runId: id,
          kind: "daemon",
          argv: ["bun"],
          startedAt: "t",
          logFile: `logs/${id}.log`,
        });
        writeFileSync(runLogPath(dir, id), "x".repeat(10));
      }
      const lease = runPumpLockPath(dir, ids[2] as string);
      for (const fifo of [prunedRunsPath(dir), lease]) {
        const made = Bun.spawnSync({ cmd: ["mkfifo", fifo], env: { ...process.env } });
        expect(made.exitCode).toBe(0);
      }
      const script = join(tempHarness(), "probe.ts");
      writeFileSync(
        script,
        [
          `import { pruneRuns, readPrunedRuns } from ${JSON.stringify(join(import.meta.dir, "runfiles.ts"))};`,
          `import { readPumpLease } from ${JSON.stringify(join(import.meta.dir, "trace-pump.ts"))};`,
          `const dir = ${JSON.stringify(dir)};`,
          "const pruned = readPrunedRuns(dir).size;",
          "const removed = pruneRuns(dir, { runs: 1, bytes: 1e12 }).removedRuns.length;",
          `const lease = readPumpLease(${JSON.stringify(lease)}) === undefined;`,
          "console.log(JSON.stringify({ pruned, removed, lease }));",
        ].join("\n"),
      );
      const child = Bun.spawnSync({
        cmd: [process.execPath, script],
        env: { ...process.env },
        timeout: 10_000,
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString().trim())).toEqual({
        pruned: 0,
        removed: 0,
        lease: true,
      });
      // Nothing was removed: the record of what would be could not be written.
      for (const id of ids) expect(statSync(runLogPath(dir, id)).size).toBe(10);
    },
    20_000, // a child process, with a deadline that only a waiting call reaches
  );
});

describe("readRetentionPolicy", () => {
  test("defaults to 20 runs / 50 MB", () => {
    expect(readRetentionPolicy(tempHarness())).toEqual(DEFAULT_RETENTION);
  });

  test("reads manager.logRetention from .crewhaus/settings.json", () => {
    const dir = tempHarness();
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { logRetention: { runs: 3, bytes: 1024 } } }),
    );
    expect(readRetentionPolicy(dir)).toEqual({ runs: 3, bytes: 1024 });
  });

  test("a garbage settings file degrades to the defaults", () => {
    const dir = tempHarness();
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "settings.json"), "{{{");
    expect(readRetentionPolicy(dir)).toEqual(DEFAULT_RETENTION);
  });
});

describe("the run records are read only as regular files inside the harness", () => {
  test.skipIf(process.platform === "win32")(
    "a link out of the harness reads as no runfile and no run records",
    () => {
      const dir = tempHarness();
      const outside = tempHarness();
      ensureRunDir(dir);
      writeFileSync(join(outside, "daemon.json"), `${JSON.stringify(sampleRunfile())}\n`);
      writeFileSync(
        join(outside, "runs.jsonl"),
        `${JSON.stringify({ runId: "run_0123456789abcdef", kind: "daemon", argv: [], startedAt: "x" })}\n`,
      );
      symlinkSync(join(outside, "daemon.json"), join(runDir(dir), RUNFILE_NAME));
      symlinkSync(join(outside, "runs.jsonl"), join(runDir(dir), "runs.jsonl"));
      expect(readRunfile(dir)).toBeUndefined();
      expect(readRunLedger(dir)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a ledger that links elsewhere inside the harness is read",
    () => {
      const dir = tempHarness();
      ensureRunDir(dir);
      const kept = join(dir, "kept-runs.jsonl");
      const line = { runId: "run_0123456789abcdef", kind: "daemon", argv: ["a"], startedAt: "x" };
      writeFileSync(kept, `${JSON.stringify(line)}\n`);
      symlinkSync(kept, join(runDir(dir), "runs.jsonl"));
      expect(readRunLedger(dir).map((e) => e.runId)).toEqual(["run_0123456789abcdef"]);
    },
  );

  test("a ledger larger than one read is read whole, its torn last line skipped", () => {
    const dir = tempHarness();
    const ids = Array.from({ length: 2000 }, (_, i) => `run_${i.toString(16).padStart(16, "0")}`);
    for (const runId of ids) {
      appendRunLedger(dir, {
        runId,
        kind: "daemon",
        argv: ["crewhaus", "run", "x".repeat(40)],
        startedAt: "2026-08-04T00:00:00.000Z",
        logFile: `logs/${runId}.log`,
      });
    }
    appendFileSync(join(runDir(dir), "runs.jsonl"), '{"runId":"run_torn');
    expect(statSync(join(runDir(dir), "runs.jsonl")).size).toBeGreaterThan(64 * 1024);
    expect(readRunLedger(dir).map((e) => e.runId)).toEqual(ids);
  });

  test.skipIf(process.platform === "win32")(
    "a named pipe reads as no runfile, no run records and the default retention",
    () => {
      const dir = tempHarness();
      ensureRunDir(dir);
      mkdirSync(join(dir, ".crewhaus"), { recursive: true });
      for (const path of [
        join(runDir(dir), RUNFILE_NAME),
        join(runDir(dir), "runs.jsonl"),
        join(dir, ".crewhaus", "settings.json"),
      ]) {
        expect(Bun.spawnSync({ cmd: ["mkfifo", path], env: { ...process.env } }).exitCode).toBe(0);
      }
      const script = join(tempHarness(), "probe.ts");
      writeFileSync(
        script,
        [
          `import { readRetentionPolicy, readRunLedger, readRunfile } from ${JSON.stringify(join(import.meta.dir, "runfiles.ts"))};`,
          `import { readManagerSettings } from ${JSON.stringify(join(import.meta.dir, "manager-settings.ts"))};`,
          `const dir = ${JSON.stringify(dir)};`,
          "console.log(JSON.stringify({",
          "  runfile: readRunfile(dir) === undefined,",
          "  ledger: readRunLedger(dir).length,",
          "  retention: readRetentionPolicy(dir),",
          "  envFiles: readManagerSettings(dir).envFiles.length,",
          "}));",
        ].join("\n"),
      );
      const child = Bun.spawnSync({
        cmd: [process.execPath, script],
        env: { ...process.env },
        timeout: 10_000,
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString().trim())).toEqual({
        runfile: true,
        ledger: 0,
        retention: DEFAULT_RETENTION,
        envFiles: 0,
      });
    },
    20_000, // a child process, with a deadline that only a waiting call reaches
  );
});
