import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErasureGrant } from "@crewhaus/control-contract/knowledge";
import { _setPurgeSeamsForTest, purge, purgeWhere } from "./erasure";
import { _setCompactSeamsForTest, createMemoryStore } from "./index";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "memory-erasure-")));
});
afterEach(() => {
  _setPurgeSeamsForTest(undefined);
  _setCompactSeamsForTest(undefined);
  rmSync(root, { recursive: true, force: true });
});

const SPEC = "bot";
const SESS = "sess_0123456789abcdef";
// Markers built from parts, so no test file holds one whole.
const MARKER = ["PLANTED", "person", "4411"].join("-");
const store = () => createMemoryStore({ specName: SPEC, rootDir: root });
const at = () => ({ rootDir: root, specName: SPEC });
const grantFor = (
  targets: readonly string[],
  over: Partial<ErasureGrant["scopes"][number]> = {},
): ErasureGrant => ({
  nonce: "n",
  digest: "d",
  scopes: [{ store: "memory", root, spec: SPEC, targets, ...over }],
});
const live = (): string => readFileSync(join(root, `${SPEC}.jsonl`), "utf8");

/** Every byte under the store, by path: what a purge may leave behind. */
function bytes(dir = root): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? bytes(path) : `${path}\n${readFileSync(path, "utf8")}`;
    })
    .join("\n");
}

/** Names, sizes and times of everything under the store. */
function snapshot(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    const stats = lstatSync(path);
    return [
      `${path} ${stats.size} ${stats.mtimeMs}`,
      ...(entry.isDirectory() ? snapshot(path) : []),
    ];
  });
}

describe("purge", () => {
  test("removes the fact, its chain, its tombstones and its marks, live and archived, and nothing else", async () => {
    const s = store();
    const keep = await s.remember("refunds over 500 need a manager", ["billing"]);
    const first = await s.remember(`${MARKER} likes calls at noon`, [MARKER]);
    await s.annotate(first.id, { category: "person" });
    const { successor } = await s.supersede(first.id, `${MARKER} likes calls at two`, {
      reason: `${MARKER} said so`,
    });
    await s.compact(); // the first fact and its lines move to the archive
    await s.annotate(successor.id, { category: "person" });
    const { successor: last } = await s.supersede(successor.id, `${MARKER} likes mail`, {
      reason: "again",
    });
    expect(bytes()).toContain(MARKER);
    expect(live()).not.toContain(`"id":"${first.id}"`);
    const ids = [first.id, successor.id, last.id];
    const done = await purge(at(), ids, grantFor(ids));
    // Live: two entries, one tombstone, one mark. Archived: an entry, a tombstone, a mark.
    expect(done).toEqual({ live: 4, archived: 3 });
    expect(bytes()).not.toContain(MARKER);
    for (const id of ids) expect(bytes()).not.toContain(id);
    expect((await s.list()).map((i) => [i.entry.id, i.status])).toEqual([[keep.id, "live"]]);
    expect(await s.history()).toEqual([]);
  });

  test("a re-run, and a purge of what is not there, change nothing", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    const grant = grantFor([id]);
    await purge(at(), [id], grant);
    const before = snapshot();
    expect(await purge(at(), [id], grant)).toEqual({ live: 0, archived: 0 });
    expect(snapshot()).toEqual(before);
    const empty = join(root, "elsewhere");
    mkdirSync(empty);
    expect(
      await purge({ rootDir: empty, specName: SPEC }, [id], grantFor([id], { root: empty })),
    ).toEqual({ live: 0, archived: 0 });
    expect(readdirSync(empty)).toEqual([]);
  });

  test("lines of a kind it does not know go with a fact they are about, and stay otherwise", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    const other = await s.remember("keep me");
    appendFileSync(
      join(root, `${SPEC}.jsonl`),
      [
        JSON.stringify({ kind: "future", target: id, note: MARKER }),
        JSON.stringify({ kind: "future", target: other.id, note: "kept" }),
        `{"id":"${id}","text":"${MARKER} torn`,
        "not json at all",
        "",
      ].join("\n"),
    );
    await purge(at(), [id], grantFor([id]));
    expect(live()).not.toContain(MARKER);
    expect(live()).toContain('"note":"kept"');
    expect(live()).toContain("not json at all");
    expect((await s.list()).map((i) => i.entry.id)).toEqual([other.id]);
  });

  test("an archived line that could not be parsed when it was archived is read too", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    appendFileSync(join(root, `${SPEC}.jsonl`), `{"id":"${id}","text":"${MARKER} torn\n`);
    await s.forget(id);
    await s.compact();
    expect(bytes()).toContain(MARKER);
    await purge(at(), [id], grantFor([id]));
    expect(bytes()).not.toContain(MARKER);
  });

  test("permission bits are kept", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    await s.remember("keep me");
    await purge(at(), [id], grantFor([id]));
    expect(lstatSync(join(root, `${SPEC}.jsonl`)).mode & 0o777).toBe(0o600);
  });
});

describe("purgeWhere", () => {
  test("removes what the predicate picks, live and archived, when the grant names it", async () => {
    const s = store();
    const a = await s.remember(`${MARKER} one`, [], { provenance: { sessionId: SESS } });
    const b = await s.remember(`${MARKER} two`, [], { provenance: { sessionId: SESS } });
    const keep = await s.remember("keep me");
    await s.forget(b.id);
    await s.compact();
    const done = await purgeWhere(
      at(),
      (entry) => entry.provenance?.sessionId === SESS,
      grantFor([a.id, b.id]),
    );
    expect(done).toEqual({ live: 1, archived: 2 });
    expect(bytes()).not.toContain(MARKER);
    expect((await s.list()).map((i) => i.entry.id)).toEqual([keep.id]);
  });

  test("a fact the grant does not name refuses the whole of it", async () => {
    const s = store();
    const a = await s.remember(MARKER, [], { provenance: { sessionId: SESS } });
    await s.remember("another", [], { provenance: { sessionId: SESS } });
    const before = live();
    await expect(purgeWhere(at(), () => true, grantFor([a.id]))).rejects.toThrow(
      "does not name every fact",
    );
    expect(live()).toBe(before);
  });
});

describe("a purge acts only on its own grant", () => {
  test("another root, spec or store, or an id the grant does not name, is refused and changes nothing", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    const before = snapshot();
    const other = realpathSync(mkdtempSync(join(tmpdir(), "memory-erasure-other-")));
    try {
      for (const grant of [
        grantFor([id], { root: other }),
        grantFor([id], { spec: "other" }),
        grantFor([id], { store: "wiki" }),
        { nonce: "n", digest: "d", scopes: [] },
      ]) {
        await expect(purge(at(), [id], grant)).rejects.toThrow("does not cover");
      }
      await expect(purge(at(), [id], grantFor(["mem_ffffffffffffffff"]))).rejects.toThrow(
        "does not name every fact",
      );
      for (const specName of ["../bot", "a/b", ""]) {
        await expect(
          purge({ rootDir: root, specName }, [id], grantFor([id], { spec: specName })),
        ).rejects.toThrow("invalid specName");
      }
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("the store's root by another name is the same store", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    try {
      expect(await purge(at(), [id], grantFor([id], { root: alias }))).toEqual({
        live: 1,
        archived: 0,
      });
    } finally {
      rmSync(alias);
    }
  });

  test("a link planted at the live file or an archive segment is refused, and what it names is untouched", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "memory-erasure-outside-")));
    try {
      const s = store();
      const { id } = await s.remember(MARKER);
      const theirs = join(outside, "theirs.jsonl");
      writeFileSync(theirs, live());
      rmSync(join(root, `${SPEC}.jsonl`));
      symlinkSync(theirs, join(root, `${SPEC}.jsonl`));
      await expect(purge(at(), [id], grantFor([id]))).rejects.toThrow("refusing to read");
      expect(readFileSync(theirs, "utf8")).toContain(MARKER);
      rmSync(join(root, `${SPEC}.jsonl`));
      // An archive directory that leads out is refused as well.
      mkdirSync(join(root, "archive"));
      writeFileSync(
        join(outside, "000001.jsonl"),
        `${JSON.stringify({ v: 1, archivedAt: "t", cause: "compaction", line: { id, text: MARKER, tags: [], createdAt: "t" } })}\n`,
      );
      symlinkSync(outside, join(root, "archive", SPEC));
      await expect(purge(at(), [id], grantFor([id]))).rejects.toThrow("refusing to read");
      expect(readFileSync(join(outside, "000001.jsonl"), "utf8")).toContain(MARKER);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a purge holds the store's locks", () => {
  test("a Remember that races it waits, and its line is there afterwards", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    let racing: Promise<unknown> | undefined;
    let landed = false;
    _setPurgeSeamsForTest({
      beforeFinalRead: async () => {
        racing = s.remember("said while it ran").then(() => {
          landed = true;
        });
        await new Promise<void>((done) => setImmediate(done));
        expect(landed).toBe(false);
      },
    });
    await purge(at(), [id], grantFor([id]));
    await racing;
    expect((await s.list()).map((i) => i.entry.text)).toEqual(["said while it ran"]);
    expect(bytes()).not.toContain(MARKER);
  });

  test("a line a writer appended round the lock is kept", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    const line = JSON.stringify({
      id: "mem_00000000000000aa",
      text: "went round",
      tags: [],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    _setPurgeSeamsForTest({
      beforeFinalRead: () => appendFileSync(join(root, `${SPEC}.jsonl`), `${line}\n`),
    });
    await purge(at(), [id], grantFor([id]));
    expect(live()).toBe(`${line}\n`);
  });

  test("a live file swapped under it is left as it is", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    _setPurgeSeamsForTest({
      beforeFinalRead: () => {
        rmSync(join(root, `${SPEC}.jsonl`));
        writeFileSync(join(root, `${SPEC}.jsonl`), "theirs\n");
      },
    });
    await expect(purge(at(), [id], grantFor([id]))).rejects.toThrow("was replaced while");
    expect(live()).toBe("theirs\n");
  });

  test("a live file rewritten in place under it, keeping its inode, is left as it is", async () => {
    const s = store();
    const { id } = await s.remember(MARKER);
    _setPurgeSeamsForTest({
      beforeFinalRead: () => writeFileSync(join(root, `${SPEC}.jsonl`), "theirs\n"),
    });
    await expect(purge(at(), [id], grantFor([id]))).rejects.toThrow("was replaced while");
    expect(live()).toBe("theirs\n");
  });

  test("a compaction that read the file before a purge does not bring the fact back", async () => {
    const s = store();
    const keep = await s.remember("keep me");
    const { id } = await s.remember(MARKER);
    await s.forget(id);
    _setCompactSeamsForTest({
      afterSnapshot: async () => {
        await purge(at(), [id], grantFor([id]));
      },
    });
    const result = await s.compact();
    expect(result.archived).toBe(0);
    expect(bytes()).not.toContain(MARKER);
    expect((await s.list()).map((i) => i.entry.id)).toEqual([keep.id]);
    expect(existsSync(join(root, "archive", SPEC, "000001.jsonl"))).toBe(false);
  });
});
