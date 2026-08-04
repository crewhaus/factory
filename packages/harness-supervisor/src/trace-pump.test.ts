import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvScrubber } from "./scrub";
import {
  LOG_TAIL_LINES,
  completeUtf8Length,
  createLogPump,
  drain,
  looksLikeEvent,
  readCursor,
  readLogTail,
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
    const first = createLogPump(files);
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
    const first = createLogPump(files);
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
