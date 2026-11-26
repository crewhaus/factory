import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isKnowledgeStore, parseKnowledgeId } from "@crewhaus/control-contract/knowledge";
import { isMemoryEntryId } from "@crewhaus/memory-store";
import {
  GONE_SESS,
  HRN,
  NOW,
  OTHER_SESS,
  SESS,
  marker,
  memories,
  now,
  removeTempDirs,
  row,
  seedHarness,
  seedTenant,
  state,
  tempDir,
  wiki,
  write,
  writeJson,
} from "./__test__/fixtures";
import {
  ADAPTERS,
  adapterOf,
  changedAdapters,
  currentItems,
  foldItems,
  sourceMarks,
} from "./adapters";
import { HarnessRead, type ThredzSource } from "./context";
import { readHistory, readItem } from "./items";

afterAll(removeTempDirs);

const readOf = (dir: string, over: Partial<ConstructorParameters<typeof HarnessRead>[0]> = {}) =>
  new HarnessRead({ harnessDir: dir, hrn: HRN, now, ...over });

async function rows(dir: string, adapter: string, names: Readonly<Record<string, string>> = {}) {
  const found = ADAPTERS.find((a) => a.name === adapter);
  if (found === undefined) throw new Error(`no adapter ${adapter}`);
  const items = await found.list(readOf(dir));
  return items.map(({ item }) => row(item, names)).sort();
}

describe("one golden per adapter", () => {
  test("facts: live, replaced, forgotten, archived, expiring, with their authors; and the legacy shared file", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const { refunds, wrong, right, old, loose, passing } = ids;
    const facts = await rows(dir, "facts", { refunds, wrong, right, old, loose, passing });
    expect(facts.map((r) => r.replace(/~h[0-9a-f]{16} /, "~<hash> ")).sort()).toEqual(
      [
        "facts~bot~-~<refunds> | live | - | spec | agent | conversation | available | Refunds over 500 need a manager",
        "facts~bot~-~<wrong> | superseded | in the archive | spec | extractor | tool-result | available | The office opens at 8",
        "facts~bot~-~<right> | live | - | spec | operator | operator | not-recorded | The office opens at 9",
        "facts~bot~-~<old> | superseded | in the archive | spec | extractor | conversation | evicted | The old printer is on floor 2",
        "facts~bot~-~<loose> | live | - | spec | unknown | unknown | not-recorded | Nobody knows where this came from",
        "facts~bot~-~<passing> | live | - | spec | unknown | unknown | not-recorded | The fair is on this week",
        "shared~-~-~<hash> | live | - | shared | sync | sync | not-recorded | Invoices go out on Mondays",
      ].sort(),
    );
  });

  test("facts: what each links to, and when its evidence goes", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const read = async (id: string) =>
      (await readItem({ harnessDir: dir, hrn: HRN, now }, `facts~bot~-~${id}`))?.item;
    expect(await read(ids.right)).toMatchObject({
      correctionOf: `facts~bot~-~${ids.wrong}`,
      supersedes: `facts~bot~-~${ids.wrong}`,
      author: { kind: "operator", via: "cli" },
    });
    expect(await read(ids.wrong)).toMatchObject({
      supersededBy: `facts~bot~-~${ids.right}`,
      origin: { kind: "tool-result", session: SESS, toolUseIds: ["tu_1"] },
      evidence: { status: "available", evictsAt: "2026-11-19T00:00:00.000Z" },
    });
    expect(await read(ids.refunds)).toMatchObject({
      author: { kind: "agent", via: "remember", session: SESS },
    });
    expect(await read(ids.old)).toMatchObject({ evidence: { status: "evicted" } });
    // Its own time passed: a reader is told so, whatever the files said when folded.
    expect((await read(ids.passing))?.lifecycle).toBe("live");
    const later = await readItem(
      { harnessDir: dir, hrn: HRN, now: () => new Date(NOW.getTime() + 2000) },
      `facts~bot~-~${ids.passing}`,
    );
    expect(later?.item.lifecycle).toBe("expired");
  });

  test("facts: the retention policy and a pin decide when a conversation goes", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const evidence = async () =>
      (await readItem({ harnessDir: dir, hrn: HRN, now }, `facts~bot~-~${ids.refunds}`))?.item
        .evidence;
    writeJson(dir, join(".crewhaus", "retention.json"), { sessions: { maxAgeDays: 7 } });
    expect(await evidence()).toEqual({ status: "available", evictsAt: "2026-10-27T00:00:00.000Z" });
    writeJson(dir, join(".crewhaus", "retention.json"), { pins: [SESS] });
    expect(await evidence()).toEqual({ status: "available" });
  });

  test("wiki: articles, versions, status and who wrote the current one", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    expect(await rows(dir, "wiki")).toEqual([
      "wiki~bot~-~billing-faq | live | published | spec | operator | document | not-recorded | Billing FAQ",
      "wiki~bot~-~old-news | archived | archived | spec | unknown | unknown | not-recorded | Old news",
    ]);
    const item = (await readItem({ harnessDir: dir, hrn: HRN, now }, "wiki~bot~-~billing-faq"))
      ?.item;
    expect(item).toMatchObject({
      version: 2,
      versions: 2,
      confidence: 0.5,
      verified: false,
      tags: ["billing"],
      origin: { sources: ["https://example.com/policy"] },
    });
  });

  test("working memory: the spec's, a conversation's, and what can be put back from the trash", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    expect(await rows(dir, "working", { plan: ids.plan })).toEqual([
      "focus~bot~-~focus | live | - | spec | agent | unknown | not-recorded | Focus",
      expect.stringMatching(
        new RegExp(
          `^focus~bot~s\\.${SESS}~focus@[0-9a-f]{12} \\| deleted-restorable \\| - \\| session \\| unknown \\| unknown \\| not-recorded \\| Cleared focus$`,
        ),
      ),
      `focus~bot~s.${OTHER_SESS}~focus | live | - | session | agent | unknown | not-recorded | Focus`,
      "goals~bot~-~goal-0001 | live | open | spec | agent | unknown | not-recorded | Report sent",
      "plans~bot~-~<plan> | live | 0 of 2 proven | spec | agent | unknown | not-recorded | Migrate invoices",
      "requirements~bot~-~REQ-001 | live | open | spec | extractor | conversation | available | send it every Friday",
    ] as string[]);
    const trashed = (await foldItems(readOf(dir))).items.find(
      ({ item }) => item.lifecycle === "deleted-restorable",
    );
    expect(trashed?.item.expiresAt).toBe("2026-11-08T00:00:00.000Z");
    expect(trashed?.item.operations).toEqual([
      { op: "restore", supported: true, cliTwin: `crewhaus state restore --trash ${ids.trash}` },
    ]);
  });

  test("sessions, lessons, suggestions, documents and datasets", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    expect(await rows(dir, "sessions")).toEqual([
      `sessions~-~-~${SESS} | live | - | spec | extractor | conversation | available | Conversation of 2026-10-20`,
    ]);
    expect(
      (await rows(dir, "lessons")).map((r) => r.replace(/l[0-9a-f]{16}/, "<l>")).sort(),
    ).toEqual(
      [
        "lessons~-~-~<l> | live | active | spec | extractor | feedback | available | Confirm the currency before quoting",
        "lessons~-~-~<l> | live | active | spec | extractor | tool-result | not-recorded | Watch out: the mail tool times out.",
        "lessons~-~-~<l> | retired | retired | spec | extractor | feedback | not-recorded | Retired lesson",
      ].sort(),
    );
    expect(
      (await rows(dir, "suggestions")).map((r) => r.replace(/d\.[0-9a-f]{16}/, "<d>")),
    ).toEqual([
      "suggestions~-~-~w.support-draft | live | proposal | spec | extractor | conversation | not-recorded | Drafted spec: support-draft",
      'suggestions~bot~-~<d> | live | proposal | spec | extractor | conversation | not-recorded | promotion candidate: "Refunds over 500 need a manager" corroborated across 2 se…',
    ]);
    expect(await rows(dir, "documents")).toEqual([
      "documents~-~-~a1b2c3d4e5f6 | live | indexed | spec | operator | document | not-recorded | docs/billing.md",
    ]);
    expect(await rows(dir, "datasets")).toEqual([
      "datasets~-~-~golden | live | v10 | spec | unknown | unknown | not-recorded | golden",
    ]);
    const { notes } = await foldItems(readOf(dir));
    expect(notes).toEqual([
      {
        code: "document-source-failed",
        store: "documents",
        count: 1,
        message: "A document source could not be read.",
      },
    ]);
    expect(ids.plan).toBe("plan-0001");
  });

  test("a customer's stores are theirs: their partition, and in no fleet answer", async () => {
    const dir = tempDir();
    const fact = await seedTenant(dir);
    const { items } = await foldItems(readOf(dir));
    expect(items.map(({ item }) => row(item, { fact }))).toEqual([
      `facts~bot~t.acme~<fact> | live | - | tenant | unknown | unknown | not-recorded | ${marker("tenant")} pays by invoice`,
      "focus~bot~t.acme~focus | live | - | tenant | agent | unknown | not-recorded | Focus",
      `wiki~bot~t.acme~account | live | published | tenant | unknown | unknown | not-recorded | Account of ${marker("tenant")}`,
    ]);
    expect(items.every(({ fleet }) => !fleet)).toBe(true);
    expect(items.flatMap(({ item }) => item.operations).some((op) => op.supported)).toBe(false);
  });

  test("a customer's session summaries and consolidation findings are theirs too", async () => {
    const dir = tempDir();
    const fact = await seedTenant(dir);
    const base = join(".crewhaus", "tenants", "acme");
    writeJson(dir, join(base, "sessions-index", `${OTHER_SESS}.json`), {
      schemaVersion: 1,
      sessionId: OTHER_SESS,
      outcome: `${marker("tenant")} renewed.`,
      summarizedAt: "2026-10-21T00:00:00.000Z",
    });
    writeJson(dir, join(base, "dream", "bot", "idempotency.json"), {
      version: 1,
      records: {
        newest: {
          completedAt: "2026-10-22T00:00:00.000Z",
          result: {
            phase1: { findings: [`promotion candidate: "pays by invoice" corroborated (${fact})`] },
          },
        },
      },
    });
    const sessions = await foldItems(readOf(dir));
    const theirs = sessions.items.filter(({ item }) =>
      ["sessions", "suggestions"].includes(item.ref.store),
    );
    expect(theirs.map(({ item }) => row(item).replace(/d\.[0-9a-f]{16}/, "<d>")).sort()).toEqual([
      `sessions~-~t.acme~${OTHER_SESS} | live | - | tenant | extractor | conversation | evicted | Conversation of 2026-10-21`,
      `suggestions~bot~t.acme~<d> | live | proposal | tenant | extractor | conversation | not-recorded | promotion candidate: "pays by invoice" corroborated (${fact})`,
    ]);
    expect(theirs.every(({ fleet, record }) => !fleet && record === undefined)).toBe(true);
    // Marked personal, the customer's fact takes its finding with it.
    await memories(dir, "bot", base).annotate(fact, { category: "person" });
    const after = await foldItems(readOf(dir));
    expect(after.items.some(({ item }) => item.ref.store === "suggestions")).toBe(false);
  });

  test("a customer's conversation keeps working memory of its own: it is not listed, and the list says so", async () => {
    const dir = tempDir();
    await seedTenant(dir);
    const base = join(".crewhaus", "tenants", "acme");
    await state(dir, { base, session: OTHER_SESS }).writeFocus("their own focus");
    const fold = await foldItems(readOf(dir));
    expect(fold.items.some(({ item }) => item.title.includes("their own"))).toBe(false);
    expect(fold.notes).toEqual([
      {
        code: "not-listed",
        store: "plans",
        count: 1,
        message:
          "A customer's conversation keeps working memory of its own, which isn't listed here.",
      },
    ]);
  });

  test("an older tree with no spec directory is read, and left out where a spec has one", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    const flat = tempDir();
    mkdirSync(join(flat, ".crewhaus"), { recursive: true });
    renameSync(join(dir, ".crewhaus", "wiki", "bot"), join(flat, ".crewhaus", "wiki"));
    renameSync(join(dir, ".crewhaus", "state", "bot"), join(flat, ".crewhaus", "state"));
    const { items } = await foldItems(readOf(flat));
    expect(items.map(({ item }) => item.id)).toEqual([
      "focus~-~-~focus",
      `focus~-~s.${OTHER_SESS}~focus`,
      "goals~-~-~goal-0001",
      "plans~-~-~plan-0001",
      "requirements~-~-~REQ-001",
      "wiki~-~-~billing-faq",
      "wiki~-~-~old-news",
    ]);
    await wiki(flat).write({ slug: "new", title: "New", body: "x" });
    const ids = (await foldItems(readOf(flat))).items.map(({ item }) => item.id);
    expect(ids.filter((id) => id.startsWith("wiki~"))).toEqual(["wiki~bot~-~new"]);
  });

  test("Thredz rows come through the client, each in its own identity and space", async () => {
    const dir = tempDir();
    const thredz: ThredzSource = {
      state: "live",
      list: async () => ({
        wiki: [{ id: "665f1c2e9b1d4a0012abcdef", title: "Pricing", space: "sales", version: 3 }],
        records: [{ id: "665f1c2e9b1d4a0012abcde0", title: "Acme", role: "writer" }],
        tasks: [{ id: "665f1c2e9b1d4a0012abcde1", title: "Call back" }],
      }),
    };
    const { items } = await foldItems(readOf(dir, { thredz }));
    expect(items.map(({ item }) => `${item.id} ${item.ref.backend} ${item.author.kind}`)).toEqual([
      "records~-~r.writer~665f1c2e9b1d4a0012abcde0 thredz upstream",
      "tasks~-~c~665f1c2e9b1d4a0012abcde1 thredz upstream",
      "wiki~-~c.sales~665f1c2e9b1d4a0012abcdef thredz upstream",
    ]);
    const broken: ThredzSource = {
      state: "live",
      list: async () => Promise.reject(new Error("x")),
    };
    const down = await foldItems(readOf(dir, { thredz: broken }));
    expect(down.items).toEqual([]);
    expect(down.notes.map((n) => n.code)).toEqual(["unreadable"]);
  });
});

describe("a list says what it could not list", () => {
  test("a name too long to address is counted, never silently dropped", async () => {
    const dir = tempDir();
    const spec = "s".repeat(120);
    await wiki(dir, spec).write({ slug: "a".repeat(100), title: "Long", body: "x" });
    await wiki(dir, spec).write({ slug: "short", title: "Short", body: "x" });
    const fold = await foldItems(readOf(dir));
    expect(fold.items.map(({ item }) => item.ref.localId)).toEqual(["short"]);
    expect(fold.notes).toEqual([
      {
        code: "unaddressable",
        store: "wiki",
        count: 1,
        message: "An item here has a name too long to address, so it is left out.",
      },
    ]);
  });

  test("customers kept outside the harness are reported, not read", async () => {
    const dir = tempDir();
    const outside = tempDir();
    await seedTenant(outside);
    const away = readOf(dir, { tenantsRoot: join(outside, ".crewhaus", "tenants") });
    const fold = await foldItems(away);
    expect(fold.items).toEqual([]);
    expect(fold.notes.some((n) => n.code === "customers-outside")).toBe(true);
  });

  test("a store that leads out of the harness is not read, per file or per directory", async () => {
    const dir = tempDir();
    const outside = tempDir();
    await seedHarness(outside);
    mkdirSync(join(dir, ".crewhaus", "memories"), { recursive: true });
    symlinkSync(
      join(outside, ".crewhaus", "memories", "bot.jsonl"),
      join(dir, ".crewhaus", "memories", "bot.jsonl"),
    );
    for (const name of ["wiki", "state", "sessions-index", "datasets", "lessons"]) {
      symlinkSync(join(outside, ".crewhaus", name), join(dir, ".crewhaus", name));
    }
    symlinkSync(join(outside, "LESSONS.md"), join(dir, "LESSONS.md"));
    const fold = await foldItems(readOf(dir));
    expect(fold.items).toEqual([]);
    expect(fold.notes.map((n) => n.code)).toContain("outside-harness");
  });

  test("a link at a file's name is not followed, even to a file inside the harness", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    for (const rel of [
      "LESSONS.md",
      join(".crewhaus", "run", "knowledge", "corpus.json"),
      join(".crewhaus", "sessions-index", `${SESS}.json`),
      join(".crewhaus", "memories", "bot.jsonl"),
    ]) {
      renameSync(join(dir, rel), join(dir, `${rel}.moved`));
      symlinkSync(join(dir, `${rel}.moved`), join(dir, rel));
    }
    const fold = await foldItems(readOf(dir));
    const stores = new Set(fold.items.map(({ item }) => item.ref.store));
    for (const store of ["documents", "sessions"] as const) {
      expect(`${store}: ${stores.has(store)}`).toBe(`${store}: false`);
    }
    const text = JSON.stringify(fold.items.filter(({ item }) => item.ref.store !== "suggestions"));
    for (const said of ["Refunds over 500", "Confirm the currency"]) {
      expect(`${said}: ${text.includes(said)}`).toBe(`${said}: false`);
    }
    expect(stores.has("wiki")).toBe(true);
    // What the link points at is not read, so a change there is no change to the store.
    const before = sourceMarks(readOf(dir));
    write(dir, "LESSONS.md.moved", "# LESSONS\n");
    write(dir, join(".crewhaus", "run", "knowledge", "corpus.json.moved"), "{}\n");
    expect(sourceMarks(readOf(dir))).toEqual(before);
  });

  test("a document row that is not one is passed over, and the rows beside it are listed", async () => {
    const dir = tempDir();
    writeJson(dir, join(".crewhaus", "run", "knowledge", "corpus.json"), {
      v: 1,
      sources: [
        { label: "docs/a.md", status: "included", docs: [null, 7, { source: "a1b2c3d4e5f6" }] },
      ],
    });
    expect(await rows(dir, "documents")).toEqual([
      "documents~-~-~a1b2c3d4e5f6 | live | indexed | spec | operator | document | not-recorded | docs/a.md",
    ]);
  });

  test("one unreadable store never empties the rest", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    write(dir, join(".crewhaus", "state", "bot", "goals.yaml"), "goals: [unclosed");
    write(dir, join(".crewhaus", "wiki", "bot", "articles", "broken.md"), "no frontmatter");
    const fold = await foldItems(readOf(dir));
    const stores = new Set(fold.items.map(({ item }) => item.ref.store));
    expect(stores.has("goals")).toBe(false);
    for (const store of ["facts", "wiki", "plans", "lessons"] as const) {
      expect(stores.has(store)).toBe(true);
    }
    expect(
      fold.notes
        .filter((n) => n.code === "unreadable")
        .map((n) => n.store)
        .sort(),
    ).toEqual(["goals", "wiki"]);
  });
});

describe("every item", () => {
  test("has an id that parses back to where it is, unique, and is read by its own adapter", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    await seedTenant(dir);
    const { items } = await foldItems(readOf(dir));
    expect(items.length).toBeGreaterThan(20);
    expect(new Set(items.map(({ item }) => item.id)).size).toBe(items.length);
    for (const { item } of items) {
      const parts = parseKnowledgeId(item.id);
      if (parts === undefined) throw new Error(item.id);
      expect(isKnowledgeStore(parts.store)).toBe(true);
      expect(parts.localId).toBe(item.ref.localId);
      expect(adapterOf(parts)?.stores).toContain(item.ref.store);
    }
    const current = await currentItems(
      readOf(dir),
      items.map(({ item }) => item.id),
    );
    expect([...current.keys()].sort()).toEqual(items.map(({ item }) => item.id).sort());
    for (const { item } of items) expect(current.get(item.id)?.item).toEqual(item);
  });

  test("masks what looks like a credential in its title, preview and tags", async () => {
    const dir = tempDir();
    const leaked = ["sk", "live", "a1B2".repeat(6)].join("_");
    await memories(dir).remember(`the key is ${leaked}`, [leaked]);
    const [first] = (await foldItems(readOf(dir))).items;
    expect(JSON.stringify(first?.item)).not.toContain(leaked);
    expect(first?.item.title).toContain("***");
    expect(first?.item.title.length).toBeLessThanOrEqual(80);
    expect(isMemoryEntryId(first?.item.ref.localId ?? "")).toBe(true);
  });

  test("a preview is at most 280 characters and a title 80", async () => {
    const dir = tempDir();
    await wiki(dir).write({ slug: "long", title: "t".repeat(200), body: "word ".repeat(400) });
    const [first] = (await foldItems(readOf(dir))).items;
    expect([...(first?.item.preview ?? "")].length).toBeLessThanOrEqual(280);
    expect([...(first?.item.title ?? "")].length).toBeLessThanOrEqual(80);
  });
});

describe("history", () => {
  test("a fact's chain, oldest first, with what was said, when it was replaced and when it was archived", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const history = await readHistory(
      { harnessDir: dir, hrn: HRN, now },
      `facts~bot~-~${ids.right}`,
    );
    expect(history.map((h) => [h.what, h.id, h.body ?? h.reason ?? ""])).toEqual([
      ["created", `facts~bot~-~${ids.wrong}`, "The office opens at 8"],
      ["superseded", `facts~bot~-~${ids.wrong}`, "checked the door"],
      ["archived", `facts~bot~-~${ids.wrong}`, ""],
      ["corrected", `facts~bot~-~${ids.right}`, "The office opens at 9"],
    ]);
  });

  test("an article's versions, with their authors", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    const history = await readHistory({ harnessDir: dir, hrn: HRN, now }, "wiki~bot~-~billing-faq");
    expect(history.map((h) => [h.version, h.author?.kind, h.body])).toEqual([
      [1, "agent", "Refund windows are thirty days long."],
      [2, "operator", "Refund windows are forty days long."],
    ]);
  });

  test("a store that keeps none answers none", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    for (const id of ["goals~bot~-~goal-0001", `sessions~-~-~${SESS}`, "not an id"]) {
      expect(await readHistory({ harnessDir: dir, hrn: HRN, now }, id)).toEqual([]);
    }
  });
});

describe("a changed store is noticed by its own adapter alone", () => {
  const edits: readonly (readonly [
    string,
    (dir: string, ids: Awaited<ReturnType<typeof seedHarness>>) => Promise<unknown> | unknown,
  ])[] = [
    ["facts", (dir) => memories(dir).remember("one more")],
    ["wiki", (dir) => wiki(dir).setSignals("old-news", { verified: true })],
    ["working", (dir) => state(dir).writeGoal({ title: "another" })],
    ["working", (dir) => state(dir, { session: OTHER_SESS }).writeFocus("changed")],
    [
      "sessions",
      (dir) => writeJson(dir, join(".crewhaus", "sessions-index", `${GONE_SESS}.json`), {}),
    ],
    ["lessons", (dir) => write(dir, "LESSONS.md", "# changed\n")],
    [
      "suggestions",
      (dir) => write(dir, join(".crewhaus", "watchme", "synthesized", "b.yaml"), "x"),
    ],
    [
      "documents",
      (dir) => writeJson(dir, join(".crewhaus", "run", "knowledge", "corpus.json"), {}),
    ],
    ["datasets", (dir) => writeJson(dir, join(".crewhaus", "datasets", "golden", "v11.json"), {})],
  ];
  for (const [adapter, edit] of edits) {
    test(adapter, async () => {
      const dir = tempDir();
      const ids = await seedHarness(dir);
      const before = sourceMarks(readOf(dir));
      expect([...changedAdapters(before, readOf(dir))]).toEqual([]);
      await edit(dir, ids);
      expect([...changedAdapters(before, readOf(dir))]).toEqual([adapter]);
    });
  }
});
