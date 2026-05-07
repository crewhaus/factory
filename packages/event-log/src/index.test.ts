import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, openEventLog } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-event-log-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TEST_ID = "sess_0123456789abcdef";

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("event-log — round-trip", () => {
  test("append + read returns events in insertion order with version 1", async () => {
    const rootDir = newTempRoot();
    let clock = 1_700_000_000_000;
    const log = await openEventLog(TEST_ID, { rootDir, now: () => clock++ });
    await log.append({ kind: "user_message", payload: { content: "hello" } });
    await log.append({
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "hi" }] },
    });
    await log.append({
      kind: "tool_use",
      payload: { id: "tu_1", name: "Read", input: { path: "x" } },
    });
    await log.append({
      kind: "tool_result",
      payload: { toolUseId: "tu_1", content: "ok", isError: false },
    });
    await log.append({ kind: "error", payload: { name: "E", message: "boom" } });
    await log.append({ kind: "compaction", payload: { kind: "snip", before: 100, after: 30 } });
    await log.close();

    const all = await collect(log.read());
    expect(all.length).toBe(6);
    expect(all.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_use",
      "tool_result",
      "error",
      "compaction",
    ]);
    for (const ev of all) {
      expect(ev.version).toBe(1);
      expect(typeof ev.ts).toBe("number");
    }
    // ts values should be strictly increasing because of clock++
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const curr = all[i];
      if (prev === undefined || curr === undefined) throw new Error("unreachable");
      expect(curr.ts).toBeGreaterThan(prev.ts);
    }
    expect(all[0]?.payload).toEqual({ content: "hello" });
  });

  test("read filters by since and until", async () => {
    const rootDir = newTempRoot();
    let clock = 100;
    const log = await openEventLog(TEST_ID, { rootDir, now: () => clock });
    for (let i = 0; i < 5; i++) {
      clock = 100 + i * 10;
      await log.append({ kind: "user_message", payload: { i } });
    }
    await log.close();

    const all = await collect(log.read());
    expect(all.length).toBe(5);
    expect(all.map((e) => e.ts)).toEqual([100, 110, 120, 130, 140]);

    const sinceOnly = await collect(log.read({ since: 120 }));
    expect(sinceOnly.map((e) => e.ts)).toEqual([120, 130, 140]);

    const untilOnly = await collect(log.read({ until: 120 }));
    expect(untilOnly.map((e) => e.ts)).toEqual([100, 110, 120]);

    const both = await collect(log.read({ since: 110, until: 130 }));
    expect(both.map((e) => e.ts)).toEqual([110, 120, 130]);
  });

  test("read of a never-written log yields zero events", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    const all = await collect(log.read());
    expect(all).toEqual([]);
  });

  test("malformed line throws RuntimeError carrying the line number", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { i: 1 } });
    // Manually corrupt the file with a bogus trailing line.
    writeFileSync(
      join(rootDir, `${TEST_ID}.jsonl`),
      `{"ts":1,"version":1,"kind":"user_message","payload":{"i":1}}\nNOT JSON\n`,
    );
    await expect(collect(log.read())).rejects.toThrow(/malformed JSON on line 2/);
  });

  test("ignores blank lines without bumping the line counter visibly", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: {} });
    // Append a blank line + a real event manually.
    writeFileSync(
      join(rootDir, `${TEST_ID}.jsonl`),
      `{"ts":1,"version":1,"kind":"user_message","payload":{}}\n\n{"ts":2,"version":1,"kind":"user_message","payload":{}}\n`,
    );
    const all = await collect(log.read());
    expect(all.length).toBe(2);
  });

  test("rejects an invalid session id", async () => {
    const rootDir = newTempRoot();
    await expect(openEventLog("../escape", { rootDir })).rejects.toThrow(/invalid sessionId/);
    await expect(openEventLog("sess_short", { rootDir })).rejects.toThrow(/invalid sessionId/);
  });

  test("creates the root directory if it does not exist", async () => {
    const rootDir = join(newTempRoot(), "deep", "nested", "dir");
    const log = await openEventLog(TEST_ID, { rootDir });
    await log.append({ kind: "user_message", payload: { ok: true } });
    const all = await collect(log.read());
    expect(all.length).toBe(1);
  });
});

describe("event-log — T7 load", () => {
  test("10 000 appends round-trip cleanly", async () => {
    const rootDir = newTempRoot();
    const log = await openEventLog(TEST_ID, { rootDir });

    const COUNT = 10_000;
    const start = performance.now();
    for (let i = 0; i < COUNT; i++) {
      await log.append({ kind: "user_message", payload: { i, padding: "x".repeat(20) } });
    }
    const appendMs = performance.now() - start;
    expect(appendMs).toBeLessThan(15_000);

    const fullPath = join(rootDir, `${TEST_ID}.jsonl`);
    expect(statSync(fullPath).size).toBeGreaterThan(COUNT * 60);

    const readStart = performance.now();
    const all = await collect(log.read());
    const readMs = performance.now() - readStart;
    expect(all.length).toBe(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const ev = all[i];
      if (ev === undefined) throw new Error("unreachable");
      expect((ev.payload as { i: number }).i).toBe(i);
    }
    // Read should be substantially faster than the append loop.
    expect(readMs).toBeLessThan(5_000);
  }, 30_000);
});
