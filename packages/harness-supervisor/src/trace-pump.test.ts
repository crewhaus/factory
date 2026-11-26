import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessOps } from "./process-ops";
import { START_LOCK_MAX_AGE_MS } from "./runfiles";
import { createEnvScrubber } from "./scrub";
import {
  LOG_TAIL_LINES,
  type LeaseProbe,
  commandArgvOf,
  completeUtf8Length,
  createLogPump,
  drain,
  looksLikeEvent,
  parseAnnouncedControlPort,
  readCursor,
  readLogTail,
  readLogTailLines,
  readPumpLease,
  replayRunEvents,
  scanBalanced,
  tailLines,
} from "./trace-pump";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-pump-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type PumpFiles = { logFile: string; eventsFile: string; cursorFile: string; dir: string };
function pumpFiles(): PumpFiles {
  const dir = tempDir();
  mkdirSync(join(dir, "logs"), { recursive: true });
  return {
    dir,
    logFile: join(dir, "logs", "run.log"),
    eventsFile: join(dir, "logs", "run.events.jsonl"),
    cursorFile: join(dir, "logs", "run.cursor"),
  };
}

/** A pid no process holds: a lease naming it is a manager that died. */
const GONE_PID = 2_147_483_000;

const EVENT = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "turn_end", runId: "run_0123456789abcdef", turn: 1, ...extra });

describe("looksLikeEvent", () => {
  test("needs a kind plus an envelope field", () => {
    expect(looksLikeEvent({ kind: "turn_end", runId: "r" })).toBe(true);
    expect(looksLikeEvent({ kind: "turn_end", timestamp: "t" })).toBe(true);
    expect(looksLikeEvent({ kind: "turn_end" })).toBe(false);
    expect(looksLikeEvent({ runId: "r" })).toBe(false);
    expect(looksLikeEvent(null)).toBe(false);
    expect(looksLikeEvent([{ kind: "turn_end", runId: "r" }])).toBe(false);
  });

  test("accepts the run-id-less crew kinds no other shape emits", () => {
    for (const kind of ["role_start", "role_end", "handoff", "crew_done", "a2a_message"]) {
      expect(looksLikeEvent({ kind })).toBe(true);
    }
    expect(looksLikeEvent({ kind: "something_else" })).toBe(false);
  });
});

describe("scanBalanced", () => {
  test("respects strings and escapes", () => {
    const s = '{"a":"}{\\"","b":{"c":1}}tail';
    expect(scanBalanced(s, 0)).toBe(s.indexOf("tail") - 1);
  });

  test("returns -1 for an incomplete object", () => {
    expect(scanBalanced('{"a":1', 0)).toBe(-1);
  });
});

describe("drain", () => {
  test("splits events from prose", () => {
    const out = drain(`hello\n${EVENT()}\nworld\n`);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.["kind"]).toBe("turn_end");
    expect(out.text).toBe("hello\n\nworld\n");
    expect(out.rest).toBe("");
  });

  test("prose containing braces never stalls the stream", () => {
    const out = drain("assistant: use { curly } braces { unbalanced\n");
    expect(out.events).toHaveLength(0);
    expect(out.text).toBe("assistant: use { curly } braces { unbalanced\n");
    expect(out.rest).toBe("");
  });

  test("a JSON object that is not an event stays prose", () => {
    const out = drain('{"just":"data"}\n');
    expect(out.events).toHaveLength(0);
    expect(out.text).toBe('{"just":"data"}\n');
  });

  test("an in-flight event is held back as rest", () => {
    const half = '{"kind":"turn_end","runId":"run_01';
    const out = drain(`before\n${half}`);
    expect(out.text).toBe("before\n");
    expect(out.events).toHaveLength(0);
    expect(out.rest).toBe(half);
  });

  test("a torn line cut inside the KEY is held back too", () => {
    // The upstream splitter only recognises a complete `{"kind"` opening;
    // a cut at `{"ki` would leak half an event into the prose channel.
    const out = drain('prose\n{"ki');
    expect(out.text).toBe("prose\n");
    expect(out.rest).toBe('{"ki');
  });

  test("a held-back partial completes on the next drain", () => {
    const first = drain('prose\n{"kind":"turn_end","runId":"');
    const second = drain(`${first.rest}run_0123456789abcdef","turn":2}\n`);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.["turn"]).toBe(2);
  });

  test("a long unbalanced brace tail is prose, not a stall", () => {
    const long = `{${"x".repeat(200)}`;
    const out = drain(long);
    expect(out.rest).toBe("");
    expect(out.text).toBe(long);
  });
});

describe("completeUtf8Length", () => {
  test("trims a split multi-byte sequence", () => {
    const full = new TextEncoder().encode("héllo"); // é is 2 bytes
    expect(completeUtf8Length(full)).toBe(full.length);
    const split = full.subarray(0, 2); // "h" + the lead byte of é
    expect(completeUtf8Length(split)).toBe(1);
  });

  test("keeps a complete 4-byte sequence", () => {
    const emoji = new TextEncoder().encode("ok🙂");
    expect(completeUtf8Length(emoji)).toBe(emoji.length);
    expect(completeUtf8Length(emoji.subarray(0, emoji.length - 1))).toBe(2);
  });
});

describe("createLogPump", () => {
  test("emits prose and events, and persists events durably", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `banner\n${EVENT()}\ntail\n`);
    const pump = createLogPump(files);
    const result = pump.pumpOnce();
    expect(result.events).toHaveLength(1);
    expect(result.prose).toBe("banner\n\ntail\n");
    expect(replayRunEvents(files.eventsFile)).toHaveLength(1);
    expect(pump.cursor().logOffset).toBe(statSize(files.logFile));
  });

  test("a second pump with no new bytes is a no-op", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, "one\n");
    const pump = createLogPump(files);
    pump.pumpOnce();
    const again = pump.pumpOnce();
    expect(again.prose).toBe("");
    expect(again.events).toHaveLength(0);
    expect(again.consumedBytes).toBe(0);
  });

  test("the cursor does NOT advance past an in-flight event", () => {
    const files = pumpFiles();
    const head = 'prose\n{"kind":"turn_end","runId":"';
    writeFileSync(files.logFile, head);
    const pump = createLogPump(files);
    pump.pumpOnce();
    expect(pump.cursor().logOffset).toBe("prose\n".length);
    appendFileSync(files.logFile, 'run_0123456789abcdef","turn":7}\n');
    const finished = pump.pumpOnce();
    expect(finished.events[0]?.["turn"]).toBe(7);
    expect(pump.cursor().logOffset).toBe(statSize(files.logFile));
  });

  test("flush releases a held-back partial as prose at end of run", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, 'prose\n{"kind":"tur');
    const pump = createLogPump(files);
    pump.pumpOnce();
    const flushed = pump.flush();
    expect(flushed.prose).toBe('{"kind":"tur');
    expect(pump.cursor().logOffset).toBe(statSize(files.logFile));
  });

  test("a manager restart resumes byte-exactly: nothing lost, nothing doubled", () => {
    const files = pumpFiles();
    const full = `start\n${EVENT({ turn: 1 })}\nmiddle\n${EVENT({ turn: 2 })}\nend\n`;
    // First manager: consumes the first half only.
    writeFileSync(files.logFile, full.slice(0, full.indexOf("middle")));
    // The first manager's process is gone by the time the second starts.
    const first = createLogPump({ ...files, pid: GONE_PID });
    const firstOut = first.pumpOnce();

    // The daemon keeps writing while the manager is dead.
    appendFileSync(files.logFile, full.slice(full.indexOf("middle")));

    // Second manager: same files, fresh pump — it reads the cursor.
    const second = createLogPump(files);
    second.reconcile();
    const secondOut = second.pumpOnce();

    expect(firstOut.prose + secondOut.prose).toBe("start\n\nmiddle\n\nend\n");
    const turns = [...firstOut.events, ...secondOut.events].map((e) => e["turn"]);
    expect(turns).toEqual([1, 2]);
    // The durable file holds each event exactly once.
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1, 2]);
  });

  test("reconcile drops events the previous manager wrote past its cursor", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
    const first = createLogPump({ ...files, pid: GONE_PID });
    first.pumpOnce();
    // Simulate a crash between appending an event and writing the cursor.
    appendFileSync(files.eventsFile, `${EVENT({ turn: 99 })}\n`);
    expect(replayRunEvents(files.eventsFile)).toHaveLength(2);

    const second = createLogPump(files);
    second.reconcile();
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1]);
  });

  test("a rotated (shrunk) log restarts from byte 0 instead of reading garbage", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, "a long first life\n");
    const pump = createLogPump(files);
    pump.pumpOnce();
    writeFileSync(files.logFile, "new\n");
    const out = pump.pumpOnce();
    expect(out.restarted).toBe(true);
    expect(out.prose).toBe("new\n");
  });

  test("scrubbing happens before anything leaves the process — prose AND events", () => {
    const secret = ["sk", "fixture", "9999888877776666"].join("-");
    const files = pumpFiles();
    writeFileSync(
      files.logFile,
      `boot: using ${secret}\n${JSON.stringify({ kind: "run_failed", runId: "run_0123456789abcdef", detail: `401 for ${secret}` })}\n`,
    );
    const pump = createLogPump({
      ...files,
      scrub: createEnvScrubber({ ANTHROPIC_API_KEY: secret }),
    });
    const out = pump.pumpOnce();
    expect(out.prose).not.toContain(secret);
    expect(out.prose).toContain("«ANTHROPIC_API_KEY»");
    expect(JSON.stringify(out.events)).not.toContain(secret);
    // The durable file is scrubbed too — the pump is the only writer.
    expect(readFileSync(files.eventsFile, "utf8")).not.toContain(secret);
  });

  test("a multi-byte character split across pumps is not corrupted", () => {
    const files = pumpFiles();
    const text = "héllo wörld\n";
    const bytes = new TextEncoder().encode(text);
    writeFileSync(files.logFile, bytes.subarray(0, 2)); // splits é
    const pump = createLogPump(files);
    const first = pump.pumpOnce();
    expect(first.prose).toBe("h");
    appendFileSync(files.logFile, bytes.subarray(2));
    const second = pump.pumpOnce();
    expect(first.prose + second.prose).toBe(text);
    expect(second.prose).not.toContain("�");
  });

  test("maxChunkBytes bounds one pump and the remainder follows", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${"a".repeat(50)}\n${"b".repeat(50)}\n`);
    const pump = createLogPump({ ...files, maxChunkBytes: 20 });
    expect(pump.pumpOnce().prose).toHaveLength(20);
    expect(pump.pumpOnce().prose).toHaveLength(20);
  });

  test("a missing log file pumps to nothing", () => {
    const files = pumpFiles();
    const pump = createLogPump(files);
    expect(pump.pumpOnce().consumedBytes).toBe(0);
  });

  test("the cursor file records both offsets", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT()}\n`);
    const pump = createLogPump(files);
    pump.pumpOnce();
    const cursor = readCursor(files.cursorFile);
    expect(cursor?.logOffset).toBe(statSize(files.logFile));
    expect(cursor?.eventsBytes).toBe(statSize(files.eventsFile));
    expect(cursor?.updatedAt).not.toBe("");
  });
});

describe("forensics helpers", () => {
  test("tailLines keeps the last non-blank lines, capped per line", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailLines(text);
    expect(tail).toHaveLength(LOG_TAIL_LINES);
    expect(tail[tail.length - 1]).toBe("line 19");
    expect(tailLines(`${"x".repeat(500)}\n`, 8, 400)[0]).toHaveLength(402); // 400 + " …"
  });

  test("readLogTail scrubs and never emits replacement characters", () => {
    const files = pumpFiles();
    const secret = ["xoxb", "fixture", "1234567890"].join("-");
    writeFileSync(files.logFile, `héllo\nboom ${secret}\n`);
    const tail = readLogTail(files.logFile, createEnvScrubber({ SLACK_BOT_TOKEN: secret }), 12);
    expect(tail.join("\n")).not.toContain(secret);
    expect(tail.join("\n")).not.toContain("�");
  });

  test("readLogTail honours a line budget instead of always capping at 8", () => {
    const files = pumpFiles();
    writeFileSync(
      files.logFile,
      `${Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")}\n`,
    );
    // The forensics default is unchanged — 8 lines, whatever the byte budget.
    expect(readLogTail(files.logFile)).toHaveLength(LOG_TAIL_LINES);
    expect(readLogTail(files.logFile, undefined, 512 * 1024)).toHaveLength(LOG_TAIL_LINES);

    // A caller that asks for 100 gets 100. This is `daemon logs --tail N`,
    // which used to print 8 lines for any N and give no sign it truncated.
    const forty = readLogTail(files.logFile, undefined, 512 * 1024, 40);
    expect(forty).toHaveLength(40);
    expect(forty[0]).toBe("line-61");
    expect(forty[39]).toBe("line-100");
    const all = readLogTail(files.logFile, undefined, { maxBytes: 512 * 1024, lines: 100 });
    expect(all).toHaveLength(100);
    expect(all[0]).toBe("line-1");

    // The byte budget still bounds the read: a bare number stays maxBytes.
    expect(readLogTail(files.logFile, undefined, 32, 100).length).toBeLessThan(10);

    // …which is exactly why `--tail N` should use the line-first helper: N in
    // the third position would otherwise silently mean N bytes.
    expect(readLogTailLines(files.logFile, undefined, 40)).toHaveLength(40);
    expect(readLogTailLines(files.logFile)).toHaveLength(LOG_TAIL_LINES);
  });

  test("parseAnnouncedControlPort reads the daemon's control.v1 boot line", () => {
    const line =
      "[control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: .crewhaus/run/control-token)";
    expect(parseAnnouncedControlPort(`booting\n${line}\nready\n`)).toBe(41234);
    expect(parseAnnouncedControlPort("[control] crewhaus.control.v1 listening on https://[::1]:80")) // not the loopback form we emit
      .toBeUndefined();
    expect(parseAnnouncedControlPort("nothing to see here")).toBeUndefined();
    // Port 0 is "kernel, pick one" — never a reachable port.
    expect(
      parseAnnouncedControlPort("[control] crewhaus.control.v1 listening on http://127.0.0.1:0"),
    ).toBeUndefined();
  });

  test("replayRunEvents skips torn lines", () => {
    const files = pumpFiles();
    writeFileSync(files.eventsFile, `${EVENT()}\n{"kind":"tor`);
    expect(replayRunEvents(files.eventsFile)).toHaveLength(1);
    expect(replayRunEvents(join(files.dir, "nope.jsonl"))).toEqual([]);
  });
});

function statSize(path: string): number {
  return readFileSync(path).length;
}

describe("the pump lease", () => {
  /** A probe that knows exactly these pids, each with its start time. */
  const probeOf = (alive: Readonly<Record<number, number>>): LeaseProbe => ({
    isAlive: (pid) => Object.hasOwn(alive, pid),
    startTimeMs: (pid) => alive[pid],
  });
  const LIVE = probeOf({ 100: 1_000, 200: 2_000 });

  test("two pumps over one log: every event lands once, and the second does not hold", () => {
    const files = pumpFiles();
    const a = createLogPump({ ...files, pid: 100, probe: LIVE });
    const b = createLogPump({ ...files, pid: 200, probe: LIVE });
    const lines: string[] = [];
    for (let turn = 1; turn <= 4; turn++) {
      appendFileSync(files.logFile, `${EVENT({ turn })}\n`);
      const first = turn % 2 === 0 ? b : a;
      const second = turn % 2 === 0 ? a : b;
      const one = first.pumpOnce();
      const two = second.pumpOnce();
      lines.push(`${one.held}/${two.held}`);
    }
    // `a` took the lease first and keeps it; `b` never consumed or wrote anything.
    expect(lines).toEqual(["true/false", "false/true", "true/false", "false/true"]);
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1, 2, 3, 4]);
    expect(readPumpLease(`${files.dir}/logs/run.pump.lock`)?.pid).toBe(100);
  });

  /** A lease file as another pump would have written it. */
  const plant = (files: PumpFiles, lease: Record<string, unknown>): string => {
    const lock = join(files.dir, "logs", "run.pump.lock");
    writeFileSync(
      lock,
      JSON.stringify({ v: 1, at: new Date().toISOString(), pump: "x", ...lease }),
    );
    return lock;
  };
  /** A probe over fake processes: each pid with its start time and its command line. */
  const fakeOps = (
    procs: Readonly<Record<number, { start?: number; line?: string }>>,
  ): LeaseProbe => ({
    isAlive: (pid) => Object.hasOwn(procs, pid),
    startTimeMs: (pid) => (Object.hasOwn(procs, pid) ? procs[pid]?.start : undefined),
    commandLine: (pid) => (Object.hasOwn(procs, pid) ? procs[pid]?.line : undefined),
  });

  test("a planted lease naming pid 1 with no start time or command line does not stop the pump", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
    plant(files, { pid: 1, host: "here" });
    // pid 1 is alive, started long ago, and runs something: still not a manager's lease.
    const probe = fakeOps({ 1: { start: 1, line: "/sbin/launchd" }, 200: { start: 2_000 } });
    const pump = createLogPump({ ...files, pid: 200, host: "here", probe });
    const first = pump.pumpOnce();
    expect(first.held).toBe(true);
    expect(first.events.map((e) => e["turn"])).toEqual([1]);
    appendFileSync(files.logFile, `${EVENT({ turn: 2 })}\n`);
    expect(pump.flush().events.map((e) => e["turn"])).toEqual([2]);
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1, 2]);
    expect(readPumpLease(join(files.dir, "logs", "run.pump.lock"))?.pid).toBe(200);
  });

  test.skipIf(process.platform === "win32")(
    "the same planted lease, judged by the real probe on this machine",
    () => {
      const files = pumpFiles();
      writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
      plant(files, { pid: 1, host: hostname() });
      const pump = createLogPump({ ...files, probe: createProcessOps() });
      expect(pump.pumpOnce()).toMatchObject({ held: true });
      expect(pump.flush().held).toBe(true);
      expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1]);
    },
  );

  test("a lease a live manager provably holds is kept, a compiled manager's included", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
    // A compiled crewhaus: `process.argv` reads bun and an embedded path, the OS shows
    // the executable's own name and the arguments after the script.
    const argv = commandArgvOf("/usr/local/bin/crewhaus", [
      "bun",
      "/$bunfs/root/crewhaus",
      "hangar",
    ]);
    expect(argv).toEqual(["crewhaus", "hangar"]);
    const holder = createLogPump({
      ...files,
      pid: 100,
      host: "here",
      argv,
      probe: fakeOps({ 100: { start: 1_000, line: "crewhaus hangar --lan" } }),
    });
    expect(holder.pumpOnce().held).toBe(true);
    const lease = readPumpLease(join(files.dir, "logs", "run.pump.lock"));
    expect(lease).toMatchObject({ pid: 100, pidStartTimeMs: 1_000, argv: ["crewhaus", "hangar"] });
    appendFileSync(files.logFile, `${EVENT({ turn: 2 })}\n`);
    const probe = fakeOps({
      100: { start: 1_000, line: "crewhaus hangar --lan" },
      200: { start: 2_000, line: "bun /src/index.ts hangar" },
    });
    const other = createLogPump({ ...files, pid: 200, host: "here", probe });
    expect(other.pumpOnce()).toMatchObject({ held: false, events: [] });
    // When the platform will not say the command line, the lease is kept too.
    const quiet = fakeOps({ 100: { start: 1_000 }, 200: { start: 2_000 } });
    expect(createLogPump({ ...files, pid: 200, host: "here", probe: quiet }).pumpOnce().held).toBe(
      false,
    );
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1]);
  });

  test("a lease is broken for another program under its pid, a moved start time, another host or a gone holder", () => {
    const old = new Date(Date.now() - 10 * START_LOCK_MAX_AGE_MS).toISOString();
    const held = { pid: 100, pidStartTimeMs: 1_000, argv: ["crewhaus", "hangar"], at: old };
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, LeaseProbe]> = [
      [
        "another program",
        { ...held, host: "here" },
        fakeOps({ 100: { start: 1_000, line: "vim notes.md" } }),
      ],
      ["a moved start time", { ...held, host: "here" }, fakeOps({ 100: { start: 50_000 } })],
      [
        "another host",
        { ...held, host: "there" },
        fakeOps({ 100: { start: 1_000, line: "crewhaus hangar" } }),
      ],
      ["a gone holder", { ...held, host: "here" }, fakeOps({})],
      [
        "no command line recorded",
        { pid: 100, pidStartTimeMs: 1_000, host: "here" },
        fakeOps({ 100: { start: 1_000 } }),
      ],
    ];
    const taken: string[] = [];
    for (const [name, lease, probe] of cases) {
      const files = pumpFiles();
      writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
      plant(files, lease);
      const pump = createLogPump({ ...files, pid: 200, host: "here", probe });
      if (pump.pumpOnce().held && replayRunEvents(files.eventsFile).length === 1) taken.push(name);
    }
    expect(taken).toEqual(cases.map(([name]) => name));
  });

  test("a pump that takes the lease after another moved the cursor reads it again", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
    const probe = probeOf({ 100: 1_000, 200: 2_000 });
    // Built while nothing was pumped: its in-memory cursor is at 0.
    const late = createLogPump({ ...files, pid: 200, probe });
    const first = createLogPump({ ...files, pid: 100, probe });
    expect(first.pumpOnce().events).toHaveLength(1);
    expect(late.pumpOnce().held).toBe(false);
    appendFileSync(files.logFile, `${EVENT({ turn: 2 })}\n`);
    first.close();
    expect(late.pumpOnce()).toMatchObject({ held: true });
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1, 2]);
  });

  test("reconcile without the lease cuts nothing; close releases it, and only its own", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\n`);
    const holder = createLogPump({ ...files, pid: 100, probe: LIVE });
    holder.pumpOnce();
    appendFileSync(files.eventsFile, `${EVENT({ turn: 99 })}\n`);
    const other = createLogPump({ ...files, pid: 200, probe: LIVE });
    other.reconcile();
    expect(replayRunEvents(files.eventsFile).map((e) => e["turn"])).toEqual([1, 99]);
    other.close();
    expect(readPumpLease(join(files.dir, "logs", "run.pump.lock"))?.pid).toBe(100);
    holder.close();
    holder.close();
    expect(readPumpLease(join(files.dir, "logs", "run.pump.lock"))).toBeUndefined();
  });

  test("every persisted line says when it was ingested, by the pump's clock", () => {
    const files = pumpFiles();
    writeFileSync(files.logFile, `${EVENT({ turn: 1 })}\nprose\n${EVENT({ turn: 2 })}\n`);
    const pump = createLogPump({ ...files, now: () => Date.parse("2026-11-14T00:00:00.000Z") });
    const out = pump.pumpOnce();
    expect(out.events.map((e) => e["ingestedAt"])).toEqual([undefined, undefined]);
    const persisted = replayRunEvents(files.eventsFile);
    expect(persisted).toHaveLength(2);
    for (const line of persisted) expect(line["ingestedAt"]).toBe("2026-11-14T00:00:00.000Z");
  });
});

describe("what the pump persists", () => {
  test("per-token stream events reach the caller but not the events file", () => {
    const files = pumpFiles();
    const tokens = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ kind: "model_stream_token", runId: "run_0123456789abcdef", index: i }),
    ).join("\n");
    const structural = [
      EVENT({ turn: 1 }),
      JSON.stringify({ kind: "tool_stream_chunk", runId: "run_0123456789abcdef", chunk: "x" }),
      EVENT({ turn: 2 }),
      EVENT({ turn: 3 }),
    ].join("\n");
    writeFileSync(files.logFile, `${tokens}\n${structural}\n`);
    const pump = createLogPump({ ...files, maxChunkBytes: 4 * 1024 * 1024 });
    const out = pump.pumpOnce();
    expect(out.events).toHaveLength(1004);
    const persisted = replayRunEvents(files.eventsFile);
    expect(persisted.map((e) => e["turn"])).toEqual([1, 2, 3]);
    expect(pump.cursor().eventsBytes).toBe(statSize(files.eventsFile));
  });
});

describe("the run index", () => {
  const ONE = `run_${"0".repeat(25)}1`;
  const TWO = `run_${"0".repeat(25)}2`;
  const EXEC = "run_00000000000000c1";
  const ev = (run: string, turn: number, pad = ""): string =>
    JSON.stringify({ kind: "turn_end", runId: run, turn, ...(pad !== "" ? { pad } : {}) });

  function harnessFiles() {
    const dir = tempDir();
    mkdirSync(join(dir, ".crewhaus", "run", "logs"), { recursive: true });
    const at = (suffix: string) => join(dir, ".crewhaus", "run", "logs", `${EXEC}${suffix}`);
    return {
      dir,
      logFile: at(".log"),
      eventsFile: at(".events.jsonl"),
      cursorFile: at(".cursor"),
      index: at(".runs.jsonl"),
    };
  }
  const indexLines = (path: string): Array<{ run: string; off: number }> =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
  const lineAt = (path: string, off: number): Record<string, unknown> => {
    const text = readFileSync(path).subarray(off).toString("utf8");
    return JSON.parse(text.slice(0, text.indexOf("\n")));
  };

  test("each canonical run's first persisted event gets one index line pointing at it", () => {
    const f = harnessFiles();
    writeFileSync(
      f.logFile,
      `${[ev(ONE, 1), "prose", ev(ONE, 2), ev(TWO, 1), EVENT({ turn: 9 }), ev(TWO, 2)].join("\n")}\n`,
    );
    const pump = createLogPump({
      logFile: f.logFile,
      eventsFile: f.eventsFile,
      cursorFile: f.cursorFile,
    });
    pump.pumpOnce();
    appendFileSync(f.logFile, `${ev(ONE, 3)}\n`);
    pump.pumpOnce();
    const index = indexLines(f.index);
    expect(index.map((e) => e.run)).toEqual([ONE, TWO]);
    for (const entry of index) {
      expect(lineAt(f.eventsFile, entry.off)).toMatchObject({ runId: entry.run, turn: 1 });
    }
  });

  test("after reconcile cuts the events file, entries past the cut are ignored and written again once", () => {
    const f = harnessFiles();
    writeFileSync(f.logFile, `${ev(ONE, 1)}\n`);
    const first = createLogPump({
      logFile: f.logFile,
      eventsFile: f.eventsFile,
      cursorFile: f.cursorFile,
    });
    first.pumpOnce();
    const cut = statSize(f.eventsFile);
    // The log goes on; a manager that died wrote events and an index line past its cursor.
    appendFileSync(f.logFile, `${ev(TWO, 1)}\n`);
    appendFileSync(f.eventsFile, `${ev(ONE, 7, "x".repeat(40))}\n`);
    const stale = statSize(f.eventsFile);
    appendFileSync(f.eventsFile, `${ev(TWO, 1)}\n`);
    appendFileSync(f.index, `${JSON.stringify({ run: TWO, off: stale, at: "t" })}\n`);
    first.close();
    const second = createLogPump({
      logFile: f.logFile,
      eventsFile: f.eventsFile,
      cursorFile: f.cursorFile,
    });
    second.reconcile();
    expect(statSize(f.eventsFile)).toBe(cut);
    second.pumpOnce();
    second.pumpOnce();
    const twos = indexLines(f.index).filter((e) => e.run === TWO);
    // The stale line and one written again, at the run's first event as it is now.
    expect(twos.map((e) => e.off)).toEqual([stale, cut]);
    expect(lineAt(f.eventsFile, cut)).toMatchObject({ runId: TWO, turn: 1 });
  });
});
