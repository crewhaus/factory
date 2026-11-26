import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { _setIoTapForTest, takeNudgeMarkers, writeNudgeMarker } from "@crewhaus/control-records";
import {
  HRN,
  NOW,
  SESS,
  holding,
  marker,
  memories,
  now,
  removeTempDirs,
  seedHarness,
  seedTenant,
  snapshot,
  state,
  tempDir,
  wiki,
  write,
} from "./__test__/fixtures";
import { HarnessRead } from "./context";
import { INDEX_PENDING, knowledgeIndexEffect } from "./effect";
import { lookup, readItem, readItems } from "./items";
import { search } from "./search";
import {
  KNOWLEDGE_PROJECTION,
  REINDEX_VERB,
  Shard,
  _setShardTapForTest,
  buildShard,
  deleteShard,
  shardRel,
} from "./shard";

afterAll(removeTempDirs);
afterEach(() => {
  _setShardTapForTest(undefined);
  _setIoTapForTest(undefined);
});

const opts = (dir: string) => ({ harnessDir: dir, hrn: HRN, harnessName: "bot", now });
async function built(dir: string, hangarRoot: string, cap?: number) {
  const answer = await buildShard({
    ...opts(dir),
    hangarRoot,
    ...(cap !== undefined ? { cap } : {}),
  });
  if (!answer.ok) throw new Error(answer.reason);
  return answer;
}
const shardDir = (home: string): string => join(home, shardRel(HRN));
const files = (home: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(shardDir(home))
      .sort()
      .map((name) => [name, readFileSync(join(shardDir(home), name), "utf8")]),
  );
const own = (dir: string) => [{ hrn: HRN, dir, name: "bot" }];
const all = () => true;
const find = (dir: string, home: string, q: string, over: object = {}) =>
  search({
    q,
    harnesses: own(dir),
    hangarRoot: home,
    canRead: all,
    canReadContent: all,
    now,
    ...over,
  });

describe("an index is a function of the stores", () => {
  test("two builds are byte-identical apart from when they were made", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    await seedTenant(dir);
    const homes = [tempDir(), tempDir()];
    await built(dir, homes[0] as string);
    await buildShard({
      ...opts(dir),
      now: () => new Date(NOW.getTime() + 1_000),
      hangarRoot: homes[1] as string,
    });
    const [a, b] = homes.map((home) => files(home as string));
    const without = (text: string | undefined): string =>
      (text ?? "").replace(/"asOf":"[^"]*"/, '"asOf":""');
    expect(Object.keys(a ?? {})).toEqual([
      "docs.jsonl",
      "epoch",
      "items.jsonl",
      "meta.json",
      "postings.json",
      "usage.json",
    ]);
    for (const name of Object.keys(a ?? {})) {
      expect(`${name}: ${without(b?.[name]) === without(a?.[name])}`).toBe(`${name}: true`);
    }
    expect(a?.["meta.json"]).not.toBe(b?.["meta.json"]);
  });

  test("a deleted index builds again with the same answers", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    const before = {
      files: files(home),
      search: await find(dir, home, "refund"),
      items: await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true, limit: 500 }),
    };
    expect(deleteShard(home, HRN)).toBe(true);
    expect(deleteShard(home, HRN)).toBe(false);
    await built(dir, home);
    expect(files(home)).toEqual(before.files);
    expect(await find(dir, home, "refund")).toEqual(before.search);
    expect(
      await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true, limit: 500 }),
    ).toEqual(before.items);
    expect(before.search.total).toBeGreaterThan(0);
  });

  test("every file is 0600 in 0700 directories, and a nudge marker beside them is left alone", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    writeNudgeMarker(home, KNOWLEDGE_PROJECTION, HRN);
    await built(dir, home);
    for (const name of readdirSync(shardDir(home))) {
      expect(`${name} ${(statSync(join(shardDir(home), name)).mode & 0o777).toString(8)}`).toBe(
        `${name} 600`,
      );
    }
    expect(statSync(shardDir(home)).mode & 0o777).toBe(0o700);
    expect(takeNudgeMarkers(home, [KNOWLEDGE_PROJECTION])).toEqual([HRN]);
    expect(deleteShard(home, HRN)).toBe(true);
  });

  test("where Home has not run yet, its folder is made, 0700", async () => {
    const dir = tempDir();
    const home = join(tempDir(), "registry", "hangar");
    await seedHarness(dir);
    await built(dir, home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(Shard.open(home, HRN, dir)?.items()?.length).toBeGreaterThan(0);
  });

  test("a harness id that is not one never becomes a path, and a link at the index is not followed", async () => {
    const dir = tempDir();
    const home = tempDir();
    const outside = tempDir();
    await seedHarness(dir);
    expect(() => shardRel("../x")).toThrow(TypeError);
    await expect(buildShard({ ...opts(dir), hrn: "nope", hangarRoot: home })).rejects.toThrow(
      "not a harness id",
    );
    mkdirSync(join(home, "cache", "index"), { recursive: true });
    symlinkSync(outside, join(home, "cache", "index", "knowledge"));
    const answer = await buildShard({ ...opts(dir), hangarRoot: home });
    expect(answer.ok).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
    expect(deleteShard(home, HRN)).toBe(false);
  });
});

describe("what an index never holds", () => {
  test("a preference file reaches no item and no file of the index", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    const planted = marker("preference");
    write(dir, join(".crewhaus", "preferences", "max.md"), `# Preferences\n- ${planted}\n`);
    await built(dir, home);
    expect(holding(home, planted)).toEqual([]);
    expect((await find(dir, home, planted)).total).toBe(0);
  });

  test("a fact marked personal reaches no file of the index: not its text, its tags or its conversation", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    const [text, tag] = [marker("text"), marker("tag")];
    const session = "sess_00000000000000ee";
    const facts = memories(dir);
    const { id } = await facts.remember(`${text} likes calls at noon`, [tag], {
      provenance: { sessionId: session },
    });
    await facts.annotate(id, { category: "person" });
    const { successor } = await facts.supersede(id, `${text} likes calls at two`, {
      reason: marker("reason"),
    });
    await built(dir, home);
    for (const planted of [text, tag, session, marker("reason")]) {
      expect(`${planted}: ${holding(home, planted).join()}`).toBe(`${planted}: `);
    }
    // In no search, of the fleet or of the one harness, for anyone.
    for (const scope of ["fleet", "harness"] as const) {
      for (const q of [text, tag, "noon", "type:fact", ""]) {
        const answer = await find(dir, home, q, { scope, limit: 100 });
        expect(JSON.stringify(answer)).not.toContain(id);
        expect(JSON.stringify(answer)).not.toContain(text);
      }
    }
    // A list of the one harness still offers to erase it, and its correction with it.
    const list = await readItems({
      ...opts(dir),
      hangarRoot: home,
      canReadContent: true,
      limit: 99,
    });
    const rows = list.items.filter((item) => item.category === "person");
    expect(rows.map((item) => item.ref.localId).sort()).toEqual([id, successor.id].sort());
    for (const item of rows) {
      expect(item.title).toBe("Personal data");
      expect(item.preview).toBeUndefined();
      expect(item.tags).toEqual([]);
      expect(item.author).toEqual({ kind: "unknown" });
      expect(item.operations.find((op) => op.op === "erase")?.supported).toBe(true);
    }
    // Opened on its own it is read live, for a reader who may read content.
    const open = await readItem(opts(dir), `facts~bot~-~${id}`);
    expect(open?.body).toContain(text);
  });

  test("a fact marked after the index was built is in no answer, before the index is built again", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    const planted = marker("later");
    const { id } = await memories(dir).remember(`${planted} likes calls`);
    await built(dir, home);
    expect((await find(dir, home, planted)).total).toBe(1);
    await memories(dir).annotate(id, { category: "person" });
    const answer = await find(dir, home, planted);
    expect([answer.items, answer.total, answer.facets.kind]).toEqual([[], 0, {}]);
    expect(answer.empty?.reason).toBe("no-data");
    // A list of the harness still offers it, as the row the index will hold: no text.
    const page = await readItems({
      ...opts(dir),
      hangarRoot: home,
      canReadContent: true,
      limit: 500,
    });
    const listed = page.items.filter((item) => item.ref.localId === id);
    expect(listed.map((item) => [item.title, item.category, item.freshness.stale])).toEqual([
      ["Personal data", "person", true],
    ]);
    expect(JSON.stringify(page)).not.toContain(planted);
  });

  test("a promotion finding about a fact marked personal is left out", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    expect((await find(dir, home, "type:suggestion", { foldMissing: true })).total).toBe(2);
    await memories(dir).annotate(ids.refunds, { category: "person" });
    await built(dir, home);
    expect(holding(home, "Refunds over 500")).toEqual([]);
    expect((await find(dir, home, "type:suggestion")).items.map((h) => h.title)).toEqual([
      "Drafted spec: support-draft",
    ]);
  });

  test("a dataset's samples are never read into it", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    expect(holding(dir, marker("sample")).length).toBe(2);
    expect(holding(home, marker("sample"))).toEqual([]);
  });

  test("what looks like a credential is masked in every file of it", async () => {
    const dir = tempDir();
    const home = tempDir();
    const leaked = ["sk", "live", "a1B2".repeat(6)].join("_");
    await wiki(dir).write({ slug: "ops", title: `Ops ${leaked}`, body: `key ${leaked} here` });
    await built(dir, home);
    expect(holding(home, leaked)).toEqual([]);
    expect(holding(home, leaked.toLowerCase())).toEqual([]);
  });
});

describe("a list for a reader who may not read content", () => {
  test("holds no item whose title is its text, no preview, and counts neither", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    const { id: person } = await memories(dir).remember(`${marker("theirs")} likes calls`);
    await memories(dir).annotate(person, { category: "person" });
    await built(dir, home);
    for (const hangarRoot of [home, undefined]) {
      const read = (canReadContent: boolean) =>
        readItems({
          ...opts(dir),
          ...(hangarRoot !== undefined ? { hangarRoot } : {}),
          canReadContent,
          limit: 500,
        });
      const whole = await read(true);
      const named = await read(false);
      expect(whole.items.some((item) => item.preview !== undefined)).toBe(true);
      expect(whole.stores.facts).toBeGreaterThan(1);
      const text = JSON.stringify(named);
      for (const said of [
        "need a manager",
        "forty days",
        "currency",
        "every Friday",
        ids.refunds,
      ]) {
        expect(`${said}: ${text.includes(said)}`).toBe(`${said}: false`);
      }
      expect(named.items.some((item) => item.preview !== undefined)).toBe(false);
      // The one fact listed is the row that offers to erase it, and it says nothing.
      expect(named.stores.facts).toBe(1);
      expect(named.items.find((item) => item.ref.store === "facts")).toMatchObject({
        ref: { localId: person },
        title: "Personal data",
        category: "person",
      });
      expect(text).not.toContain(marker("theirs"));
      expect(named.total).toBe(named.items.length);
      expect(named.items.map((item) => item.title)).toContain("Billing FAQ");
    }
  });
});

describe("the cap", () => {
  test("past it, the index says it does not list everything, and names the verb", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    const { meta } = await built(dir, home, 3);
    expect([meta.truncated, meta.items]).toEqual([true, 3]);
    const list = await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true, cap: 3 });
    expect(list.total).toBe(3);
    expect(list.truncated).toEqual({
      reason: `This harness knows more than 3 things, and ${REINDEX_VERB} cannot list them all.`,
      verb: REINDEX_VERB,
    });
    const answer = await find(dir, home, "refund");
    expect(answer.truncated?.verb).toBe(REINDEX_VERB);
    // The same without an index.
    const folded = await readItems({ ...opts(dir), canReadContent: true, cap: 3 });
    expect(folded.truncated?.verb).toBe(REINDEX_VERB);
  });

  test("within it, nothing is said", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    expect(
      "truncated" in (await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true })),
    ).toBe(false);
    expect("truncated" in (await find(dir, home, "refund"))).toBe(false);
  });
});

describe("an index that does not fit is not read", () => {
  test("a half-replaced file, a foreign one and a torn one all answer as if there were none", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    for (const name of ["items.jsonl", "docs.jsonl", "postings.json", "meta.json"]) {
      const path = join(shardDir(home), name);
      const text = readFileSync(path, "utf8");
      for (const planted of [
        text.replace("Billing FAQ", "Changed!!!!"),
        text.slice(0, -20),
        "{}",
      ]) {
        if (planted === text) continue;
        writeFileSync(path, planted);
        const list = await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true });
        const answer = await find(dir, home, "billing");
        expect(`${name}: ${JSON.stringify([list.items, answer])}`).not.toContain("Changed!!!!");
        if (name === "items.jsonl" || name === "meta.json") {
          expect(list.freshness.from).toBe("direct-fold");
        }
        if (name === "docs.jsonl" || name === "postings.json") {
          expect(answer.coverage.namesOnly).toEqual([HRN]);
        }
      }
      writeFileSync(path, text);
    }
    expect((await find(dir, home, "billing")).coverage.namesOnly).toEqual([]);
  });

  test("another harness's index under this one's id is not read", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    const meta = join(shardDir(home), "meta.json");
    writeFileSync(meta, readFileSync(meta, "utf8").split(HRN).join("hrn_ffffffffffffffff"));
    expect(Shard.open(home, HRN, dir)).toBeUndefined();
  });
});

describe("reads never write", () => {
  test("every read, with and without an index, leaves the harness and the Home as they were", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    await seedTenant(dir);
    const reads = async (): Promise<void> => {
      for (const canReadContent of [true, false]) {
        await readItems({ ...opts(dir), hangarRoot: home, canReadContent, limit: 500 });
        for (const scope of ["fleet", "harness"] as const) {
          for (const q of ["refund", "", "type:work", "status:corrected since:30d"]) {
            await find(dir, home, q, { scope, canReadContent: () => canReadContent });
          }
        }
      }
      await find(dir, home, "refund", { foldMissing: true, scope: "harness" });
      await readItem(opts(dir), `facts~bot~-~${ids.refunds}`);
      await lookup({ ...opts(dir), hangarRoot: home }, [
        { store: "fact", backend: "local", spec: "bot", localId: ids.refunds },
      ]);
      knowledgeIndexEffect({ hangarRoot: home, hrn: HRN, harnessDir: dir });
    };
    const before = [snapshot(dir), snapshot(home)];
    await reads();
    expect([snapshot(dir), snapshot(home)]).toEqual(before);
    await built(dir, home);
    await memories(dir).remember("a change the index does not know");
    const after = [snapshot(dir), snapshot(home)];
    await reads();
    expect([snapshot(dir), snapshot(home)]).toEqual(after);
  });

  test("a build writes under the Home root and nowhere else", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    const before = snapshot(dir);
    await built(dir, home);
    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(home)).toEqual(["cache"]);
  });
});

describe("a read does bounded work", () => {
  test("a search opens only the index files of the harnesses it may read, and no store file", async () => {
    const home = tempDir();
    const dirs = [tempDir(), tempDir()];
    const hrns = [HRN, "hrn_00000000000000b2"];
    for (const [i, dir] of dirs.entries()) {
      await seedHarness(dir);
      const answer = await buildShard({
        harnessDir: dir,
        hrn: hrns[i] as string,
        now,
        hangarRoot: home,
      });
      expect(answer.ok).toBe(true);
    }
    const opened: string[] = [];
    const stores: string[] = [];
    _setShardTapForTest({ open: (file) => opened.push(file) });
    _setIoTapForTest({ open: (given) => stores.push(given) });
    const answer = await search({
      q: "refund",
      harnesses: dirs.map((dir, i) => ({ hrn: hrns[i] as string, dir, name: `h${i}` })),
      hangarRoot: home,
      canRead: (hrn) => hrn === HRN,
      canReadContent: all,
      now,
    });
    expect(answer.total).toBeGreaterThan(0);
    expect(opened).toEqual([`${HRN}/meta.json`, `${HRN}/docs.jsonl`, `${HRN}/postings.json`]);
    expect(stores).toEqual([]);
  });

  test("a page of items opens at most two files, whatever its size", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    for (const limit of [1, 5, 500]) {
      const opened: string[] = [];
      _setShardTapForTest({ open: (file) => opened.push(file) });
      const page = await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true, limit });
      expect(page.items.length).toBeGreaterThan(0);
      expect(opened).toEqual([`${HRN}/meta.json`, `${HRN}/items.jsonl`]);
    }
  });
});

describe("a changed store marks its hits stale and reads only them again", () => {
  test("a corrected fact: stale, its lifecycle the store's own, the rest of the page untouched", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    await built(dir, home);
    const list = () =>
      readItems({ ...opts(dir), hangarRoot: home, canReadContent: true, limit: 500 });
    const fresh = await list();
    expect(fresh.items.some((item) => item.freshness.stale)).toBe(false);
    await memories(dir).forget(ids.refunds, { reason: "over" });
    const after = await list();
    const one = after.items.find((item) => item.ref.localId === ids.refunds);
    expect([one?.lifecycle, one?.freshness.stale]).toEqual(["superseded", true]);
    for (const item of after.items) {
      expect(`${item.ref.store} ${item.freshness.stale}`).toBe(
        `${item.ref.store} ${["facts", "shared"].includes(item.ref.store)}`,
      );
    }
    // A search says the same, and a filter is judged by the store as it is now.
    const hit = (await find(dir, home, "manager type:fact")).items[0];
    expect(hit?.freshness.stale).toBe(true);
    expect((await find(dir, home, "manager status:live type:fact")).total).toBe(0);
  });

  test("an article's new version and status come from its store", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    await wiki(dir).write({
      slug: "billing-faq",
      title: "Billing FAQ",
      body: "Refund windows are fifty days long.",
      expectedVersion: 2,
    });
    const page = await readItems({
      ...opts(dir),
      hangarRoot: home,
      canReadContent: true,
      filter: { stores: ["wiki"] },
    });
    const item = page.items.find((i) => i.ref.localId === "billing-faq");
    expect([item?.version, item?.freshness.stale]).toEqual([3, true]);
  });

  test("an item that is not there any more is not live", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    rmSync(join(dir, ".crewhaus", "state", "bot", "goals.yaml"));
    await state(dir).writeFocus("changed"); // a rename the directory's time shows
    const page = await readItems({
      ...opts(dir),
      hangarRoot: home,
      canReadContent: true,
      filter: { stores: ["goals"] },
    });
    expect(page.items.map((i) => [i.lifecycle, i.freshness.stale])).toEqual([["cleared", true]]);
  });

  test("a fact past its own time reads expired from an index that says live", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    await built(dir, home);
    const later = { now: () => new Date(NOW.getTime() + 2_000) };
    const page = await readItems({
      ...opts(dir),
      ...later,
      hangarRoot: home,
      canReadContent: true,
      limit: 500,
    });
    expect(page.items.find((i) => i.ref.localId === ids.passing)?.lifecycle).toBe("expired");
    expect((await find(dir, home, "fair status:live", later)).total).toBe(0);
    expect((await find(dir, home, "fair status:expired", later)).total).toBe(1);
  });
});

describe("the index effect of a change", () => {
  test("pending until an index built from the stores as they are, and done then", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    const at = { hangarRoot: home, hrn: HRN, harnessDir: dir };
    const pending = { kind: "index", status: "unknown", note: INDEX_PENDING } as const;
    expect(INDEX_PENDING).toBe("applies when Home next runs");
    expect(knowledgeIndexEffect(at)).toEqual(pending);
    await built(dir, home);
    expect(knowledgeIndexEffect(at)).toEqual({
      kind: "index",
      status: "done",
      observed: NOW.toISOString(),
    });
    await memories(dir).supersede(ids.right, "The office opens at ten", { reason: "again" });
    expect(knowledgeIndexEffect(at)).toEqual(pending);
    await built(dir, home);
    expect(knowledgeIndexEffect(at).status).toBe("done");
    expect(JSON.stringify(knowledgeIndexEffect(at))).not.toContain("mem_");
  });
});

describe("what became of the items a run used", () => {
  const fact = (localId: string) => ({
    store: "fact" as const,
    backend: "local" as const,
    spec: "bot",
    localId,
  });

  test("from the index and from the stores, the same answers", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    const refs = [
      fact(ids.refunds),
      fact(ids.wrong),
      {
        store: "wiki" as const,
        backend: "local" as const,
        spec: "bot",
        localId: "billing-faq",
        version: 1,
      },
      {
        store: "wiki" as const,
        backend: "local" as const,
        spec: "bot",
        localId: "billing-faq",
        version: 2,
      },
      {
        store: "plan" as const,
        backend: "local" as const,
        spec: "bot",
        partition: "-",
        localId: "plan-0001",
      },
      { store: "session" as const, backend: "local" as const, localId: SESS },
      { store: "document" as const, backend: "local" as const, localId: "a1b2c3d4e5f6" },
      fact("mem_ffffffffffffffff"),
      { store: "wiki" as const, backend: "local" as const, spec: "bot", localId: "Not A Slug" },
    ];
    const expected = [
      ["found", "live", false],
      ["found", "superseded", true],
      ["found", "live", true],
      ["found", "live", false],
      ["found", "live", false],
      ["found", "live", false],
      ["found", "live", false],
      ["unknown", undefined, undefined],
      ["unknown", undefined, undefined],
    ];
    const ask = async () =>
      (await lookup({ ...opts(dir), hangarRoot: home }, refs)).map((l) => [
        l.state,
        l.lifecycle,
        l.changedSince,
      ]);
    expect(await ask()).toEqual(expected);
    await built(dir, home);
    expect(await ask()).toEqual(expected);
    // A store that changed since is asked itself.
    await memories(dir).forget(ids.refunds);
    expect((await ask())[0]).toEqual(["found", "superseded", true]);
  });

  test("an item the index does not hold is read from its store: written since, or past the cap", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await built(dir, home);
    const { id } = await memories(dir).remember("Refunds settle in two days");
    const states = async (refs: readonly ReturnType<typeof fact>[]) =>
      (await lookup({ ...opts(dir), hangarRoot: home }, refs)).map((l) => l.state);
    expect(await states([fact(id)])).toEqual(["found"]);
    expect(await states([fact("mem_ffffffffffffffff")])).toEqual(["unknown"]);

    const capped = tempDir();
    const cappedHome = tempDir();
    const store = memories(capped);
    const three: string[] = [];
    for (const text of ["one thing", "another thing", "a third thing"]) {
      three.push((await store.remember(text)).id);
    }
    const { meta } = await buildShard({
      harnessDir: capped,
      hrn: HRN,
      harnessName: "bot",
      now,
      hangarRoot: cappedHome,
      cap: 1,
    }).then((answer) => {
      if (!answer.ok) throw new Error(answer.reason);
      return answer;
    });
    expect(meta.truncated).toBe(true);
    const withIndex = await lookup(
      { harnessDir: capped, hrn: HRN, now, hangarRoot: cappedHome },
      three.map(fact),
    );
    const without = await lookup({ harnessDir: capped, hrn: HRN, now }, three.map(fact));
    expect(withIndex.map((l) => l.state)).toEqual(["found", "found", "found"]);
    expect(withIndex).toEqual(without);
  });
});

describe("an index is its own folder's", () => {
  test("an index built from another folder under this id is read by nothing here", async () => {
    const dir = tempDir();
    const copy = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await memories(copy).remember(`${marker("copy")} only here`);
    // Built from the copy, under the id of the harness in `dir`.
    await built(copy, home);
    expect(Shard.open(home, HRN, copy)).toBeDefined();
    expect(Shard.open(home, HRN, dir)).toBeUndefined();
    const list = await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true });
    expect(list.freshness.from).toBe("direct-fold");
    expect(JSON.stringify(list)).not.toContain(marker("copy"));
    const found = await search({
      q: marker("copy").toLowerCase(),
      harnesses: [{ hrn: HRN, dir, name: "bot" }],
      hangarRoot: home,
      canRead: () => true,
      canReadContent: () => true,
      now,
    });
    expect(found.total).toBe(0);
    expect(found.coverage.namesOnly).toEqual([HRN]);
    expect(knowledgeIndexEffect({ hangarRoot: home, hrn: HRN, harnessDir: dir })).toEqual({
      kind: "index",
      status: "unknown",
      note: INDEX_PENDING,
    });
  });
});

describe("an index without its harness", () => {
  test("a store kept outside is a note in the meta, and so in every list", async () => {
    const dir = tempDir();
    const home = tempDir();
    const outside = tempDir();
    await seedHarness(dir);
    mkdirSync(join(outside, "memories"));
    rmSync(join(dir, ".crewhaus", "memories"), { recursive: true });
    symlinkSync(join(outside, "memories"), join(dir, ".crewhaus", "memories"));
    const { meta } = await built(dir, home);
    expect(meta.notes.map((n) => n.code)).toContain("outside-harness");
    const list = await readItems({ ...opts(dir), hangarRoot: home, canReadContent: true });
    expect(list.notes).toEqual(meta.notes);
    expect(new HarnessRead(opts(dir)).name).toBe("bot");
  });
});
