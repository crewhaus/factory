import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUN_ID_RE,
  START_LOCK_MAX_AGE_MS,
  acquireStartLock,
  appendRunLedger,
  clearRunfile,
  ensureRunDir,
  logsDir,
  newRunId,
  patchRunLedger,
  pruneRuns,
  readRetentionPolicy,
  readRunLedger,
  readRunfile,
  readStartLock,
  recentRuns,
  releaseStartLock,
  runDir,
  runLogPath,
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
