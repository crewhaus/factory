import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import {
  _setRollBytesForTest,
  append,
  controlPaths,
  ensureDigestKey,
  harnessLedger,
  runsLedger,
} from "@crewhaus/control-records";
import { runRetentionSweep } from "@crewhaus/harness-lifecycle";
import {
  HRN,
  NOW,
  SESS,
  holding,
  memories,
  now,
  removeTempDirs,
  seedHarness,
  seedTenant,
  snapshot,
  tempDir,
  wiki,
  write,
} from "./__test__/fixtures";
import { foldItems } from "./adapters";
import { HarnessRead } from "./context";
import { readItems } from "./items";
import type { RecordRef } from "./model";
import { buildShard } from "./shard";
import { KNOWLEDGE_ITEM_LABEL, foldUsage, itemDigest } from "./usage";

afterAll(removeTempDirs);
afterEach(() => _setRollBytesForTest(undefined));

/** The runtime's recorder. Loaded from its file: the runtime is not a dependency of this package. */
const RECORDER = new URL("../../runtime-core/src/knowledge-usage.ts", import.meta.url).pathname;
const recorder = async () =>
  (await import(RECORDER)) as {
    readonly KNOWLEDGE_ITEM_LABEL: string;
    readonly KNOWLEDGE_USAGE_DIR: string;
    knowledgeItemDigest(key: CryptoKey, ref: RecordRef): Promise<string>;
    createKnowledgeUsage(args: object): {
      noteRecall(note: object): Promise<void>;
    };
  };

const at = (daysAgo: number): string =>
  new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const ledger = (dir: string) => harnessLedger(dir, { dir: controlPaths(dir).knowledgeUsageDir });
async function keyOf(dir: string): Promise<CryptoKey> {
  const key = await ensureDigestKey(dir);
  if (key.state !== "present") throw new Error(key.reason);
  return key.hmac;
}
const fact = (localId: string): RecordRef => ({
  store: "fact",
  backend: "local",
  spec: "bot",
  localId,
});
const article = (version: number): RecordRef => ({
  store: "wiki",
  backend: "local",
  spec: "bot",
  localId: "billing-faq",
  version,
});
/** One use, as the runtime writes it. */
async function use(
  dir: string,
  run: string,
  ref: RecordRef,
  over: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const written = append(ledger(dir), {
    v: 1,
    at: at(1),
    run,
    session: SESS,
    item: await itemDigest(await keyOf(dir), ref),
    store: ref.store,
    backend: ref.backend,
    ...(ref.version !== undefined ? { version: ref.version } : {}),
    via: "recall",
    status: "included",
    ...over,
  });
  if (!written.ok) throw new Error(written.reason);
}
const items = async (dir: string) =>
  (await foldItems(new HarnessRead({ harnessDir: dir, hrn: HRN, now }))).items;
const named = async (dir: string, localId: string) => {
  const found = (await items(dir)).find(({ item }) => item.ref.localId === localId);
  if (found === undefined) throw new Error(`no ${localId}`);
  return found;
};
const list = (dir: string, hangarRoot?: string) =>
  readItems({
    harnessDir: dir,
    hrn: HRN,
    now,
    canReadContent: true,
    limit: 500,
    ...(hangarRoot !== undefined ? { hangarRoot } : {}),
  });

describe("the fold joins what the runtime writes", () => {
  test("an item's digest is the one a usage line names it by, for every store a run records", async () => {
    const runtime = await recorder();
    const key = await keyOf(tempDir());
    expect(KNOWLEDGE_ITEM_LABEL).toBe(runtime.KNOWLEDGE_ITEM_LABEL);
    expect(runtime.KNOWLEDGE_USAGE_DIR).toBe(controlPaths("").knowledgeUsageDir);
    const refs: RecordRef[] = [
      fact("mem_0123456789abcdef"),
      { ...fact("mem_0123456789abcdef"), backend: "thredz" },
      article(2),
      { store: "plan", backend: "local", spec: "bot", partition: "-", localId: "plan-0001" },
      { store: "goal", backend: "local", spec: "bot", partition: "t.acme", localId: "goal-0001" },
      { store: "focus", backend: "local", spec: "bot", partition: `s.${SESS}`, localId: "focus" },
      { store: "session", backend: "local", localId: SESS },
      { store: "document", backend: "local", localId: "a1b2c3d4e5f6" },
    ];
    const digests = new Set<string>();
    for (const ref of refs) {
      const digest = await itemDigest(key, ref);
      expect(digest).toBe(await runtime.knowledgeItemDigest(key, ref));
      expect(digest).toMatch(/^[0-9a-f]{32}$/);
      digests.add(digest);
    }
    expect(digests.size).toBe(refs.length);
  });

  test("a use the runtime's own recorder writes is joined to its item", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const runtime = await recorder();
    const key = await keyOf(dir);
    const recording = runtime.createKnowledgeUsage({
      runContext: { runId: "run_a", logger: { warn() {} } },
      records: true,
      write: async () => {},
      usageRoot: dir,
      digestKey: async () => key,
      sessionId: SESS,
      execution: () => undefined,
    });
    await recording.noteRecall({
      items: [{ ref: fact(ids.refunds) }, { ref: article(1) }],
      outcomes: [{ status: "included" }, { status: "warned" }],
    });
    const fold = await foldUsage(dir);
    const used = await fold.usageOf(await named(dir, ids.refunds));
    expect(used).toMatchObject({ runs: 1, recorded: true, olderRuns: [] });
    expect(used.uses).toMatchObject([{ run: "run_a", via: "recall", status: "included" }]);
    const faq = await fold.usageOf(await named(dir, "billing-faq"));
    expect(faq.uses).toMatchObject([{ run: "run_a", status: "warned", version: 1 }]);
    // An article corrected since: the run used the version before.
    expect(faq.olderRuns).toEqual(["run_a"]);
  });

  test("a usage line's version is the version an item carries, in every store that has one", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    for (const { item, record } of await items(dir)) {
      if (record?.version === undefined) continue;
      expect(`${item.id} ${record.version === item.version}`).toBe(`${item.id} true`);
    }
  });
});

describe("how an item was used", () => {
  test("runs are counted once, the last use is the newest, whatever order the lines are in", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_b", fact(ids.refunds), { at: at(3), via: "tool", tool: "Recall" });
    await use(dir, "run_a", fact(ids.refunds), { at: at(9) });
    await use(dir, "run_b", fact(ids.refunds), { at: at(2) });
    await use(dir, "run_c", fact(ids.loose), { at: at(1) });
    const fold = await foldUsage(dir);
    const used = await fold.usageOf(await named(dir, ids.refunds));
    expect(used.runs).toBe(2);
    expect(used.lastUsedAt).toBe(at(2));
    expect(used.uses.map((u) => [u.run, u.at, u.via, u.tool])).toEqual([
      ["run_b", at(2), "recall", undefined],
      ["run_b", at(3), "tool", "Recall"],
      ["run_a", at(9), "recall", undefined],
    ]);
    expect(await fold.usageOf(await named(dir, ids.right))).toEqual({
      runs: 0,
      recorded: true,
      uses: [],
      olderRuns: [],
    });
  });

  test("used after it was corrected: a run that recorded an older version", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    await use(dir, "run_old", article(1));
    await use(dir, "run_new", article(2));
    const faq = await (await foldUsage(dir)).usageOf(await named(dir, "billing-faq"));
    expect([faq.runs, faq.olderRuns]).toEqual([2, ["run_old"]]);
    await wiki(dir).write({
      slug: "billing-faq",
      title: "Billing FAQ",
      body: "Refund windows are fifty days long.",
      expectedVersion: 2,
    });
    const after = await (await foldUsage(dir)).usageOf(await named(dir, "billing-faq"));
    expect(after.olderRuns).toEqual(["run_new", "run_old"]);
  });

  test("a list carries the counts, from the stores and from an index", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds), { at: at(4) });
    await buildShard({ harnessDir: dir, hrn: HRN, now, hangarRoot: home });
    for (const read of [await list(dir), await list(dir, home)]) {
      expect(read.usageRecorded).toBe(true);
      const of = (localId: string) => read.items.find((i) => i.ref.localId === localId)?.usage;
      expect(of(ids.refunds)).toEqual({ runs: 1, lastUsedAt: at(4), recorded: true });
      expect(of(ids.loose)).toEqual({ runs: 0, recorded: true });
    }
  });

  test("a row of personal data never says no run used it", async () => {
    const dir = tempDir();
    const home = tempDir();
    const ids = await seedHarness(dir);
    await memories(dir).annotate(ids.refunds, { category: "person" });
    await use(dir, "run_a", fact(ids.refunds));
    await buildShard({ harnessDir: dir, hrn: HRN, now, hangarRoot: home });
    for (const read of [await list(dir), await list(dir, home)]) {
      const row = read.items.find((i) => i.ref.localId === ids.refunds);
      expect([row?.category, row?.usage]).toEqual(["person", { runs: 0, recorded: false }]);
    }
    // The index holds no use of it, only the row that offers to erase it.
    expect(holding(home, ids.refunds).map((path) => basename(path))).toEqual(["items.jsonl"]);
    // Asked about on its own, it is joined.
    const fold = await foldUsage(dir);
    expect((await fold.usageOf(await named(dir, ids.refunds))).runs).toBe(1);
  });

  test("a store no run records, what is in the trash, and a customer's item are not recorded", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await seedTenant(dir);
    await use(dir, "run_a", fact(ids.refunds));
    const fold = await foldUsage(dir);
    for (const folded of await items(dir)) {
      const { item } = folded;
      const expected =
        item.scope.kind !== "tenant" &&
        item.lifecycle !== "deleted-restorable" &&
        ["facts", "wiki", "plans", "goals", "focus", "sessions", "documents"].includes(
          item.ref.store,
        );
      const usage = await fold.usageOf(folded);
      expect(`${item.id} ${usage.recorded}`).toBe(`${item.id} ${expected}`);
    }
    // A list says the same of each.
    const folded = new Map((await items(dir)).map((one) => [one.item.id, one]));
    for (const item of (await list(dir)).items) {
      const one = folded.get(item.id);
      if (one === undefined) throw new Error(item.id);
      const { recorded } = await fold.usageOf(one);
      expect(`${item.id} ${item.usage.recorded}`).toBe(`${item.id} ${recorded}`);
    }
  });
});

describe("what is not on record is said so", () => {
  test("a harness with no usage log: every item is not recorded, every run says why", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    await keyOf(dir);
    append(runsLedger(dir), { v: 1, at: at(1), id: "run_a" });
    const fold = await foldUsage(dir);
    expect(fold.recorded).toBe(false);
    expect(fold.runUsage("run_a")).toEqual({ state: "not-recorded", reason: "no-usage-log" });
    for (const folded of await items(dir)) {
      expect(await fold.usageOf(folded)).toEqual({
        runs: 0,
        recorded: false,
        uses: [],
        olderRuns: [],
      });
    }
    const read = await list(dir);
    expect(read.usageRecorded).toBe(false);
    expect(read.items.every((item) => item.usage.recorded === false)).toBe(true);
  });

  test("a run the log does not name", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds));
    append(runsLedger(dir), { v: 1, at: at(0), id: "run_b" });
    const fold = await foldUsage(dir);
    for (const run of ["run_b", "run_unheard_of"]) {
      expect(fold.runUsage(run)).toEqual({ state: "not-recorded", reason: "none-seen" });
    }
  });

  test("no key, or one that cannot be read: nothing is joined, and no item reads unused", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds));
    write(dir, controlPaths(dir).digestKeyFile, "not a key\n");
    const fold = await foldUsage(dir);
    expect(fold.recorded).toBe(false);
    expect((await fold.usageOf(await named(dir, ids.refunds))).recorded).toBe(false);
    // A run's own lines need no key.
    expect(fold.runUsage("run_a")).toMatchObject({ state: "used" });
    expect(await fold.digests(await items(dir))).toEqual(new Map());
  });

  test("a state is never `used` without an item", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds));
    const fold = await foldUsage(dir);
    for (const run of ["run_a", "run_b", ""]) {
      const usage = fold.runUsage(run);
      if (usage.state === "used") expect(usage.items.length).toBeGreaterThan(0);
      else expect(usage.reason).toBeDefined();
    }
  });
});

describe("after the sweep", () => {
  test("a segment past the window is gone; the rest still counts, and a run in it is `evicted`", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    _setRollBytesForTest(1); // a segment for each line
    append(runsLedger(dir), { v: 1, at: at(500), id: "run_old" });
    append(runsLedger(dir), { v: 1, at: at(5), id: "run_new" });
    append(runsLedger(dir), { v: 1, at: at(4), id: "run_silent" });
    await use(dir, "run_old", fact(ids.refunds), { at: at(500) });
    await use(dir, "run_new", fact(ids.refunds), { at: at(5) });
    const before = await foldUsage(dir);
    expect(before.runUsage("run_old").state).toBe("used");
    expect((await before.usageOf(await named(dir, ids.refunds))).runs).toBe(2);
    const report = await runRetentionSweep({
      rootDir: dir,
      dryRun: false,
      now: () => NOW.getTime(),
    });
    expect(report.knowledge?.usageSegments).toEqual([1]);
    const fold = await foldUsage(dir);
    const used = await fold.usageOf(await named(dir, ids.refunds));
    expect([used.runs, used.recorded, used.lastUsedAt]).toEqual([1, true, at(5)]);
    expect(fold.runUsage("run_old")).toEqual({ state: "not-recorded", reason: "evicted" });
    expect(fold.runUsage("run_silent")).toEqual({ state: "not-recorded", reason: "none-seen" });
    expect(fold.runUsage("run_new").state).toBe("used");
  });

  test("the oldest line kept is the oldest by time, whatever order processes appended in", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    _setRollBytesForTest(1);
    append(runsLedger(dir), { v: 1, at: at(500), id: "run_gone" });
    append(runsLedger(dir), { v: 1, at: at(20), id: "run_quiet" });
    await use(dir, "run_gone", fact(ids.refunds), { at: at(500) });
    // Two processes: the later line landed first.
    await use(dir, "run_late", fact(ids.refunds), { at: at(5) });
    await use(dir, "run_early", fact(ids.refunds), { at: at(30) });
    await runRetentionSweep({ rootDir: dir, dryRun: false, now: () => NOW.getTime() });
    const fold = await foldUsage(dir);
    expect(fold.runUsage("run_gone")).toEqual({ state: "not-recorded", reason: "evicted" });
    // Started after the oldest line kept: the log would name it, so it used nothing on record.
    expect(fold.runUsage("run_quiet")).toEqual({ state: "not-recorded", reason: "none-seen" });
  });
});

describe("what a run used", () => {
  test("every use, named by the items still known", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds), { at: at(3) });
    await use(dir, "run_a", fact("mem_ffffffffffffffff"), { at: at(2), status: "redacted" });
    const fold = await foldUsage(dir);
    const usage = fold.runUsage("run_a", await fold.digests(await items(dir)));
    if (usage.state !== "used") throw new Error(usage.state);
    expect(usage.items.map((u) => [u.id, u.status])).toEqual([
      [`facts~bot~-~${ids.refunds}`, "included"],
      [undefined, "redacted"],
    ]);
  });

  test("a line that is not one of the runtime's is left out, and reading writes nothing", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    await use(dir, "run_a", fact(ids.refunds));
    const digest = await itemDigest(await keyOf(dir), fact(ids.refunds));
    for (const over of [
      { v: 2 },
      { at: "soon" },
      { item: "mem_0123" },
      { item: digest.toUpperCase() },
      { store: "preferences" },
      { backend: "elsewhere" },
      { via: "hearsay" },
      { status: "fine" },
      { run: 4 },
    ]) {
      await use(dir, "run_x", fact(ids.refunds), over);
    }
    append(ledger(dir), ["not", "a", "record"] as unknown as Record<string, unknown>);
    const before = snapshot(dir);
    const fold = await foldUsage(dir);
    expect((await fold.usageOf(await named(dir, ids.refunds))).runs).toBe(1);
    expect(fold.runUsage("run_x")).toEqual({ state: "not-recorded", reason: "none-seen" });
    expect(snapshot(dir)).toEqual(before);
  });

  test("the decisions made in the runs that used it, newest first", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    const decision = (n: number, over: object) => ({
      v: 1,
      at: at(10 - n),
      event: "decide",
      decision: `appr_${String(n).padStart(16, "0")}`,
      sessionId: SESS,
      tool: "Write",
      inputDigest: "a".repeat(64),
      placesDigest: "b".repeat(64),
      surface: "single-turn",
      ...over,
    });
    const lines = [
      decision(1, { runId: "run_a" }),
      decision(2, { runId: "run_b" }),
      decision(3, { runId: "run_a", event: "park" }),
      decision(4, {}),
      decision(5, { runId: "run_a" }),
    ];
    write(
      dir,
      join(".crewhaus", "sessions", "approvals.d", "decisions", "000001.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const fold = await foldUsage(dir);
    expect(fold.decisionsIn(["run_a"]).map((d) => [d.decision, d.run, d.tool])).toEqual([
      ["appr_0000000000000005", "run_a", "Write"],
      ["appr_0000000000000001", "run_a", "Write"],
    ]);
    expect(fold.decisionsIn([])).toEqual([]);
  });
});

test("a fact written after the log began is not used, and says so", async () => {
  const dir = tempDir();
  const ids = await seedHarness(dir);
  await use(dir, "run_a", fact(ids.refunds));
  const { id } = await memories(dir).remember("new since");
  expect(await (await foldUsage(dir)).usageOf(await named(dir, id))).toEqual({
    runs: 0,
    recorded: true,
    uses: [],
    olderRuns: [],
  });
});
