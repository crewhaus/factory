/**
 * Archiving compaction: every line `compact()` removes from the live file is
 * kept in `archive/<spec>/`, and a line written while it runs survives, whether
 * the writer took the fact lock or went round it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setCompactSeamsForTest, createMemoryStore } from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-compact-"));
});

afterEach(() => {
  _setCompactSeamsForTest(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function liveLines(path: string): string[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l !== "");
}

describe("compaction under concurrency", () => {
  test("a remember made after the snapshot, before the lock, survives", async () => {
    const store = createMemoryStore({ specName: "race", rootDir: tmp });
    const dead = await store.remember("stale fact");
    await store.forget(dead.id);
    let late: string | undefined;
    _setCompactSeamsForTest({
      afterSnapshot: async () => {
        late = (await store.remember("remembered during compaction")).id;
      },
    });
    const result = await store.compact();
    expect(result.dropped).toBe(2);
    const raw = readFileSync(store.path(), "utf-8");
    expect(raw).toContain("remembered during compaction");
    expect(raw).not.toContain("stale fact");
    expect((await store.list()).map((i) => i.entry.id)).toEqual([late as string]);
  });

  test("a raw append that went round the lock, made before the last stat, survives", async () => {
    const store = createMemoryStore({ specName: "bypass", rootDir: tmp });
    const keep = await store.remember("kept fact");
    const dead = await store.remember("dead fact");
    await store.forget(dead.id);
    const rogue = JSON.stringify({
      id: "mem_00000000000000ee",
      text: "written without the lock",
      tags: [],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    _setCompactSeamsForTest({
      beforeFinalStat: () => appendFileSync(store.path(), `${rogue}\n`),
    });
    await store.compact();
    const lines = liveLines(store.path());
    expect(lines).toContain(rogue);
    expect(lines.some((l) => l.includes(keep.id))).toBe(true);
    expect(lines.some((l) => l.includes("dead fact"))).toBe(false);
    expect((await store.list()).map((i) => i.entry.text).sort()).toEqual([
      "kept fact",
      "written without the lock",
    ]);
  });

  test("a partial final line at the snapshot is re-read whole under the lock", async () => {
    const store = createMemoryStore({ specName: "frag", rootDir: tmp });
    const dead = await store.remember("gone");
    await store.forget(dead.id);
    const entry = JSON.stringify({
      id: "mem_00000000000000ef",
      text: "half then whole",
      tags: [],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    appendFileSync(store.path(), entry.slice(0, 20));
    _setCompactSeamsForTest({
      afterSnapshot: () => appendFileSync(store.path(), `${entry.slice(20)}\n`),
    });
    await store.compact();
    expect(liveLines(store.path())).toEqual([entry]);
  });
});

describe("the archive", () => {
  test("two compactions roll a second segment, and every dropped line is there once", async () => {
    const store = createMemoryStore({ specName: "roll", rootDir: tmp });
    const droppedTexts: string[] = [];
    for (const round of [1, 2]) {
      for (let i = 0; i < 12; i++) {
        const text = `round ${round} fact ${i} ${"x".repeat(60)}`;
        const e = await store.remember(text);
        droppedTexts.push(text);
        await store.forget(e.id, { reason: `cleanup ${round}.${i}` });
      }
      await store.remember(`survivor ${round}`);
      await store.compact();
      if (round === 1) {
        // control-records rolls a segment once it is past 8 MiB. A sparse tail
        // takes the first one past it without writing 8 MiB of lines; history()
        // skips the tail as the unparseable line it is.
        const first = join(tmp, "archive", "roll", "000001.jsonl");
        truncateSync(first, statSync(first).size + 8 * 1024 * 1024);
      }
    }
    const segs = readdirSync(join(tmp, "archive", "roll")).filter((n) => /^\d{6}\.jsonl$/.test(n));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    const history = await store.history();
    // 24 entries and their 24 tombstones.
    expect(history).toHaveLength(48);
    const entryTexts = history
      .map((h) => (h.line as { text?: unknown }).text)
      .filter((t): t is string => typeof t === "string");
    expect(entryTexts.sort()).toEqual([...droppedTexts].sort());
    // Each one exactly once across the segments, by raw content.
    const rawAll = segs.map((s) => readFileSync(join(tmp, "archive", "roll", s), "utf-8")).join("");
    for (const text of droppedTexts) {
      expect(rawAll.split(text).length - 1).toBe(1);
    }
    expect(liveLines(store.path()).map((l) => JSON.parse(l).text)).toEqual([
      "survivor 1",
      "survivor 2",
    ]);
    // Reads an 8 MiB segment back: slow by construction on a loaded runner.
  }, 20_000);

  test("a line archived twice (a crash before the rename) is read once", async () => {
    const store = createMemoryStore({ specName: "dup", rootDir: tmp });
    const e = await store.remember("duplicated in the archive");
    await store.forget(e.id);
    await store.compact();
    const seg = join(tmp, "archive", "dup", "000001.jsonl");
    const text = readFileSync(seg, "utf-8");
    // The same lines again, as a second archive pass before the rename leaves them,
    // with a later archivedAt.
    writeFileSync(
      seg,
      text + text.replaceAll(/"archivedAt":"[^"]*"/g, '"archivedAt":"2099-01-01T00:00:00.000Z"'),
    );
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(await store.history()).toHaveLength(2);
  });

  test("the forget reason survives in the archive", async () => {
    const store = createMemoryStore({ specName: "why", rootDir: tmp });
    const e = await store.remember("the wifi password is on the fridge");
    await store.forget(e.id, { reason: "a person asked to drop it" });
    await store.compact();
    expect(readFileSync(store.path(), "utf-8")).toBe("");
    const tombstone = (await store.history())
      .map((h) => h.line as Record<string, unknown>)
      .find((l) => l["tombstone"] === "superseded");
    expect(tombstone?.["reason"]).toBe("a person asked to drop it");
  });

  test("recall, list and size never read the archive", async () => {
    const store = createMemoryStore({ specName: "quiet", rootDir: tmp });
    const e = await store.remember("archived banana");
    await store.forget(e.id);
    await store.compact();
    expect(await store.recall("banana", 5)).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.size()).toBe(0);
  });
});
