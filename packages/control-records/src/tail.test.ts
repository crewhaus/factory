import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _setIoTapForTest } from "./io";
import { append } from "./ledger";
import { CHUNK_BYTES } from "./lines";
import { dropSegmentsBefore } from "./retention";
import { _setRollBytesForTest } from "./segments";
import { readPage, readTail } from "./tail";
import {
  deploymentsLedger,
  jsonLine,
  plant,
  removeTempDirs,
  runsLedger,
  segmentPath,
  tempDir,
} from "./test-helpers";

const CAPS = { maxLines: 100, maxBytes: 1024 * 1024 };

afterEach(() => {
  _setIoTapForTest(undefined);
  _setRollBytesForTest(undefined);
});
afterAll(removeTempDirs);

describe("readTail", () => {
  test("brief 324: a torn final line waits: two records, torn, and the third is not returned", () => {
    const root = tempDir();
    plant(join(root, "log"), `${jsonLine({ n: 1 })}${jsonLine({ n: 2 })}{"n":3`);
    const read = readTail(root, "log", CAPS);
    expect(read).toEqual({
      state: "read",
      records: [{ n: 1 }, { n: 2 }],
      truncated: false,
      gaps: [],
      torn: true,
    });
  });

  test("brief 324: a malformed middle line is one gap at its offset, and reading goes on", () => {
    const root = tempDir();
    const first = jsonLine({ n: 1 });
    plant(join(root, "log"), `${first}garbage\n${jsonLine({ n: 3 })}`);
    const read = readTail(root, "log", CAPS);
    expect(read).toEqual({
      state: "read",
      records: [{ n: 1 }, { n: 3 }],
      truncated: false,
      gaps: [{ off: first.length, bytes: "garbage\n".length, reason: "unreadable" }],
      torn: false,
    });
  });

  test("records come back in file order, so a last-wins fold works", () => {
    const root = tempDir();
    plant(join(root, "log"), `${jsonLine({ id: "x", v: 1 })}${jsonLine({ id: "x", v: 2 })}`);
    const read = readTail(root, "log", CAPS);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records.map((r) => r["v"])).toEqual([1, 2]);
  });

  test("a line that parses to something other than an object is malformed", () => {
    const root = tempDir();
    plant(join(root, "log"), `[1]\n"text"\nnull\n7\n${jsonLine({ n: 1 })}`);
    const read = readTail(root, "log", CAPS);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toEqual([{ n: 1 }]);
    expect(read.gaps.map((g) => g.off)).toEqual([0, 4, 11, 16]);
  });

  test("a line that is not UTF-8 is malformed, not silently repaired", () => {
    const root = tempDir();
    writeFileSync(
      join(root, "log"),
      Buffer.concat([
        Buffer.from(jsonLine({ n: 1 })),
        Buffer.from('{"t":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
        Buffer.from(jsonLine({ n: 3 })),
      ]),
    );
    const read = readTail(root, "log", CAPS);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toEqual([{ n: 1 }, { n: 3 }]);
    expect(read.gaps).toHaveLength(1);
  });

  test("blank lines are skipped, and neither counted nor reported", () => {
    const root = tempDir();
    plant(join(root, "log"), `\n${jsonLine({ n: 1 })}\n   \n${jsonLine({ n: 2 })}\n`);
    const read = readTail(root, "log", { maxLines: 2, maxBytes: 1024 });
    expect(read).toEqual({
      state: "read",
      records: [{ n: 1 }, { n: 2 }],
      truncated: false,
      gaps: [],
      torn: false,
    });
  });

  test("the line cap keeps the newest lines and reports older data", () => {
    const root = tempDir();
    plant(join(root, "log"), [1, 2, 3].map((n) => jsonLine({ n })).join(""));
    const read = readTail(root, "log", { maxLines: 2, maxBytes: 1024 });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toEqual([{ n: 2 }, { n: 3 }]);
    expect(read.truncated).toBe(true);
  });

  test("the byte cap keeps the newest lines and reports older data", () => {
    const root = tempDir();
    const line = jsonLine({ n: 1 });
    plant(join(root, "log"), line.repeat(4));
    const read = readTail(root, "log", { maxLines: 100, maxBytes: line.length * 2 });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toHaveLength(2);
    expect(read.truncated).toBe(true);
  });

  test("a file that fits both caps exactly is not truncated", () => {
    const root = tempDir();
    const line = jsonLine({ n: 1 });
    plant(join(root, "log"), line.repeat(3));
    const read = readTail(root, "log", { maxLines: 3, maxBytes: line.length * 3 });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toHaveLength(3);
    expect(read.truncated).toBe(false);
  });

  test("a line longer than maxBytes ends the read with truncated", () => {
    const root = tempDir();
    plant(join(root, "log"), `${jsonLine({ n: 1 })}${jsonLine({ text: "x".repeat(100) })}`);
    const read = readTail(root, "log", { maxLines: 100, maxBytes: 20 });
    expect(read).toEqual({ state: "read", records: [], truncated: true, gaps: [], torn: false });
  });

  test("a read costs at most maxBytes plus one chunk, counted", () => {
    const root = tempDir();
    const line = jsonLine({ text: "x".repeat(4000) });
    plant(join(root, "log"), line.repeat(1000));
    const maxBytes = 100_000;
    let bytes = 0;
    _setIoTapForTest({
      read: (_position, length) => {
        bytes += length;
      },
    });
    const read = readTail(root, "log", { maxLines: 1_000_000, maxBytes });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.truncated).toBe(true);
    expect(read.records.length).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(maxBytes + CHUNK_BYTES);
  });

  test("a line that starts exactly at the byte window is inside it, even on a chunk boundary", () => {
    const root = tempDir();
    // `{"t":"` and `"}` and the newline are nine bytes: three lines of half a chunk each.
    const line = jsonLine({ t: "x".repeat(CHUNK_BYTES / 2 - 9) });
    plant(join(root, "log"), line.repeat(3));
    const read = readTail(root, "log", { maxLines: 100, maxBytes: CHUNK_BYTES });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toHaveLength(2);
    expect(read.truncated).toBe(true);
  });

  test("a line spanning chunks reads back whole", () => {
    const root = tempDir();
    const big = { text: "é".repeat(CHUNK_BYTES) };
    plant(join(root, "log"), `${jsonLine({ n: 1 })}${jsonLine(big)}${jsonLine({ n: 3 })}`);
    const read = readTail(root, "log", { maxLines: 100, maxBytes: 4 * CHUNK_BYTES });
    if (read.state !== "read") throw new Error(read.state);
    expect(read.records).toEqual([{ n: 1 }, big, { n: 3 }]);
    expect(read.truncated).toBe(false);
  });

  test("an absent file and a refused open answer differently, and neither throws", () => {
    const root = tempDir();
    const outside = tempDir();
    plant(join(outside, "secret"), "nope\n");
    symlinkSync(join(outside, "secret"), join(root, "log"));
    mkdirSync(join(root, "dir"));
    expect(readTail(root, "missing", CAPS)).toEqual({ state: "absent" });
    const refused = readTail(root, "log", CAPS);
    expect(refused.state).toBe("refused");
    if (refused.state !== "refused") throw new Error(refused.state);
    expect(refused.code).toBe("is-symlink");
    expect(refused.reason).not.toContain(outside);
    const followed = readTail(root, "log", { ...CAPS, followLeafSymlink: true });
    expect(followed.state === "refused" && followed.code).toBe("escapes-root");
    const directory = readTail(root, "dir", CAPS);
    expect(directory.state === "refused" && directory.code).toBe("not-regular-file");
  });

  test("a link at the leaf is refused by default and followed inside the root only on request", () => {
    const root = tempDir();
    plant(join(root, "real"), jsonLine({ n: 1 }));
    symlinkSync(join(root, "real"), join(root, "log"));
    const refused = readTail(root, "log", CAPS);
    expect(refused.state === "refused" && refused.code).toBe("is-symlink");
    const followed = readTail(root, "log", { ...CAPS, followLeafSymlink: true });
    expect(followed.state === "read" && followed.records).toEqual([{ n: 1 }]);
  });

  test("a file with no newline at all is torn, with nothing to return", () => {
    const root = tempDir();
    plant(join(root, "log"), '{"n":1');
    expect(readTail(root, "log", CAPS)).toEqual({
      state: "read",
      records: [],
      truncated: false,
      gaps: [],
      torn: true,
    });
  });

  test("a torn tail longer than a chunk still ends at the last complete line", () => {
    const root = tempDir();
    plant(join(root, "log"), `${jsonLine({ n: 1 })}{"t":"${"x".repeat(3 * CHUNK_BYTES)}`);
    expect(readTail(root, "log", CAPS)).toEqual({
      state: "read",
      records: [{ n: 1 }],
      truncated: false,
      gaps: [],
      torn: true,
    });
  });

  test("a torn tail longer than the cap is reported, and so is what lies past it", () => {
    const root = tempDir();
    plant(join(root, "log"), `${jsonLine({ n: 1 })}{"t":"${"x".repeat(3 * CHUNK_BYTES)}`);
    expect(readTail(root, "log", { maxLines: 10, maxBytes: 100 })).toEqual({
      state: "read",
      records: [],
      truncated: true,
      gaps: [],
      torn: true,
    });
  });

  test("an empty file reads as empty", () => {
    const root = tempDir();
    plant(join(root, "log"), "");
    expect(readTail(root, "log", CAPS)).toEqual({
      state: "read",
      records: [],
      truncated: false,
      gaps: [],
      torn: false,
    });
  });

  test("a cap that is not a number is a programming error", () => {
    const root = tempDir();
    expect(() => readTail(root, "log", { maxLines: Number.NaN, maxBytes: 1 })).toThrow(RangeError);
    expect(() => readTail(root, "log", { maxLines: 1, maxBytes: -1 })).toThrow(RangeError);
  });
});

describe("readPage", () => {
  test("newest first across segments, with the position of each line", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2, 3]) expect(append(ledger, { n }).ok).toBe(true);
    const page = readPage(ledger, { limit: 10 });
    expect(page.items.map((i) => i.record["n"])).toEqual([3, 2, 1]);
    expect(page.items.map((i) => i.at.seg)).toEqual([3, 2, 1]);
    expect(page.items.every((i) => i.at.off === 0 && i.at.tail === "")).toBe(true);
    expect(page.next).toBeUndefined();
    expect(page.gaps).toEqual([]);
  });

  test("a page ends at its limit, and `next` reads what is older with nothing repeated", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2, 3, 4, 5]) append(ledger, { n });
    const first = readPage(ledger, { limit: 2 });
    expect(first.items.map((i) => i.record["n"])).toEqual([5, 4]);
    expect(first.next).toEqual(first.items[1]?.at);
    const second = readPage(ledger, { limit: 2, before: first.next });
    expect(second.items.map((i) => i.record["n"])).toEqual([3, 2]);
    const third = readPage(ledger, { limit: 2, before: second.next });
    expect(third.items.map((i) => i.record["n"])).toEqual([1]);
    expect(third.next).toBeUndefined();
  });

  test("`next` is absent when the limit lands exactly on the oldest line", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2]) append(ledger, { n });
    expect(readPage(ledger, { limit: 2 }).next).toBeUndefined();
  });

  test("paging crosses a segment boundary", () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2]) append(ledger, { n });
    const first = readPage(ledger, { limit: 1 });
    const second = readPage(ledger, { limit: 1, before: first.next });
    expect(second.items.map((i) => i.record["n"])).toEqual([1]);
    expect(second.next).toBeUndefined();
  });

  test("a torn final line waits, and a malformed line is a gap with its bytes", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    const first = jsonLine({ n: 1 });
    plant(segmentPath(ledger, 1), `${first}garbage\n${jsonLine({ n: 3 })}{"n":4`);
    const page = readPage(ledger, { limit: 10 });
    expect(page.items.map((i) => i.record["n"])).toEqual([3, 1]);
    expect(page.gaps).toEqual([
      { seg: 1, off: first.length, reason: "unreadable", bytes: "garbage\n".length },
    ]);
  });

  test("a single-file ledger pages at segment 0", () => {
    const root = tempDir();
    const ledger = deploymentsLedger(root);
    for (const n of [1, 2]) append(ledger, { n });
    const page = readPage(ledger, { limit: 1 });
    expect(page.items[0]?.at.seg).toBe(0);
    expect(page.snapshotAt.map((p) => p.seg)).toEqual([0]);
    const older = readPage(ledger, { limit: 1, before: page.next });
    expect(older.items.map((i) => i.record["n"])).toEqual([1]);
  });

  test("an absent ledger is an empty page with its first position", () => {
    const root = tempDir();
    expect(readPage(runsLedger(root), { limit: 5 })).toEqual({
      items: [],
      snapshotAt: [{ seg: 1, off: 0, tail: "" }],
      gaps: [],
    });
  });

  test("a `before` below the watermark answers no items and one evicted gap", async () => {
    _setRollBytesForTest(1);
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2, 3]) append(ledger, { n });
    const position = { seg: 1, off: 0, tail: "" };
    expect(await dropSegmentsBefore(ledger, 2)).toMatchObject({ ok: true, watermark: 2 });
    const page = readPage(ledger, { limit: 5, before: position });
    expect(page.items).toEqual([]);
    expect(page.gaps).toEqual([{ seg: 1, off: 0, reason: "evicted" }]);
  });

  test("a `before` that no longer fits its file is diverged, and never throws", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    for (const n of [1, 2, 3]) append(ledger, { n });
    const page = readPage(ledger, { limit: 1 });
    const at = page.items[0]?.at;
    if (at === undefined) throw new Error("no item");
    for (const before of [
      { ...at, tail: "00000000" },
      { ...at, off: at.off + 1 },
      { ...at, seg: 9 },
    ]) {
      const answer = readPage(ledger, { limit: 5, before });
      expect(answer.items).toEqual([]);
      expect(answer.gaps[0]).toMatchObject({ reason: "diverged" });
    }
    const bad = readPage(ledger, { limit: 5, before: { seg: -1, off: "x" } as never });
    expect(bad.gaps).toEqual([{ seg: 0, off: 0, reason: "diverged" }]);
  });

  test("a limit below one is a programming error", () => {
    expect(() => readPage(runsLedger(tempDir()), { limit: 0 })).toThrow(RangeError);
  });

  test("a line that is too long to hold reads as a gap and the page continues", () => {
    const root = tempDir();
    const ledger = runsLedger(root);
    plant(segmentPath(ledger, 1), `${jsonLine({ n: 1 })}${"x".repeat(8 * 1024 * 1024 + 1)}\n`);
    const page = readPage(ledger, { limit: 5 });
    expect(page.items.map((i) => i.record["n"])).toEqual([1]);
    expect(page.gaps).toHaveLength(1);
    expect(page.gaps[0]).toMatchObject({ reason: "unreadable", bytes: 8 * 1024 * 1024 + 2 });
  }, 20_000); // writes and scans an over-long line on purpose
});
