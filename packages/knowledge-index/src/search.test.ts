import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  HRN,
  NOW,
  OTHER_SESS,
  marker,
  memories,
  now,
  removeTempDirs,
  seedHarness,
  seedTenant,
  tempDir,
  wiki,
  write,
  writeJson,
} from "./__test__/fixtures";
import { _resetSearchProvidersForTest, registerSearchProvider, searchProviders } from "./providers";
import { STILL_BUILDING, type SearchOptions, search } from "./search";
import { _setShardTapForTest, buildShard } from "./shard";

afterAll(removeTempDirs);
afterEach(() => {
  _setShardTapForTest(undefined);
  _resetSearchProvidersForTest();
});

const B = "hrn_00000000000000b2";
const all = () => true;
const none = () => false;

/** Two harnesses with an index each, and one Home. Harness B says its marker everywhere. */
async function fleet() {
  const home = tempDir();
  const a = tempDir();
  const b = tempDir();
  const idsA = await seedHarness(a);
  const planted = marker("secondharness");
  const facts = memories(b);
  for (let i = 0; i < 30; i++) {
    await facts.remember(`Refunds ${planted} number ${i} need a manager`, [planted]);
  }
  write(b, "crewhaus.yaml", `name: ${planted}\ntarget: cli\n`);
  writeJson(b, join(".crewhaus", "sessions", `${OTHER_SESS}.json`), {
    id: OTHER_SESS,
    name: `refunds ${planted}`,
    target: planted,
    updatedAt: NOW.toISOString(),
  });
  for (const [hrn, harnessDir] of [
    [HRN, a],
    [B, b],
  ] as const) {
    const built = await buildShard({ hangarRoot: home, hrn, harnessDir, now });
    if (!built.ok) throw new Error(built.reason);
  }
  const harnesses = [
    { hrn: HRN, dir: a, name: "support" },
    { hrn: B, dir: b, name: planted },
  ];
  const find = (q: string, over: Partial<SearchOptions> = {}) =>
    search({
      q,
      harnesses,
      hangarRoot: home,
      canRead: all,
      canReadContent: all,
      now,
      limit: 100,
      ...over,
    });
  return { home, a, b, idsA, planted, harnesses, find };
}

describe("a reader gets only what they may read", () => {
  test("a harness they may not read adds nothing: no hit, count, facet, snippet, name or page", async () => {
    const { find, planted, home, harnesses } = await fleet();
    const alone = await search({
      q: "refunds manager",
      harnesses: harnesses.slice(0, 1),
      hangarRoot: home,
      canRead: all,
      canReadContent: all,
      now,
      limit: 100,
    });
    for (const q of [
      "refunds manager",
      planted,
      "",
      "type:fact",
      `in:${planted} refunds`,
      `#${planted}`,
    ]) {
      const answer = await find(q, { canRead: (hrn) => hrn === HRN });
      const text = JSON.stringify(answer);
      expect(`${q}: ${text.includes(planted) || text.includes(B)}`).toBe(`${q}: false`);
      expect(answer.total).toBe(answer.items.length);
      expect(Object.keys(answer.facets.harness)).toEqual(answer.total === 0 ? [] : [HRN]);
    }
    // The answer is the one a Home without that harness would give, its order included.
    expect(await find("refunds manager", { canRead: (hrn) => hrn === HRN })).toEqual(alone);
    expect(alone.total).toBeGreaterThan(0);
    // With access to both, both answer.
    const both = await find("refunds manager");
    expect(Object.keys(both.facets.harness).sort()).toEqual([HRN, B].sort());
    expect(both.total).toBeGreaterThan(alone.total);
  });

  test("a hidden harness answers only when asked for", async () => {
    const { find, harnesses, planted } = await fleet();
    const hidden = harnesses.map((h) => (h.hrn === B ? { ...h, hidden: true } : h));
    const answer = await find("refunds manager", { harnesses: hidden });
    expect(JSON.stringify(answer)).not.toContain(planted);
    expect(answer.facets.harness[B]).toBeUndefined();
    for (const over of [{ includeHidden: true }, {}]) {
      const q = over.includeHidden === true ? "refunds manager" : `in:${planted} refunds manager`;
      const asked = await find(q, { harnesses: hidden, ...over });
      expect(asked.facets.harness[B]).toBeGreaterThan(0);
    }
    // Asking for it by name is not permission to read it.
    const refused = await find(`in:${planted} refunds`, { harnesses: hidden, canRead: none });
    expect([refused.items, refused.total, refused.empty?.reason]).toEqual([[], 0, "no-access"]);
  });

  test("without content permission, a fact is in no answer and other hits show a name and no text", async () => {
    const { find, idsA } = await fleet();
    const permitted = await find("refunds refund");
    expect(permitted.items.some((hit) => hit.kind === "facts")).toBe(true);
    expect(permitted.items.some((hit) => hit.snippet !== undefined)).toBe(true);
    for (const q of ["refund", "manager", "", "type:fact", "thirty forty days", "granted"]) {
      const answer = await find(q, { canReadContent: none });
      const text = JSON.stringify(answer);
      for (const said of ["need a manager", "forty days", "was granted", idsA.refunds]) {
        expect(`${q}: ${text.includes(said)}`).toBe(`${q}: false`);
      }
      expect(answer.items.some((hit) => hit.snippet !== undefined)).toBe(false);
      expect(answer.facets.kind["facts"]).toBeUndefined();
      expect(answer.total).toBe(answer.items.length);
    }
    // What an article says does not decide whether its name is found: only its name does.
    expect((await find("forty days", { canReadContent: none })).total).toBe(0);
    expect((await find("forty days", { canReadContent: all })).total).toBe(1);
    const named = await find("billing", { canReadContent: none });
    expect(named.items.map((hit) => [hit.kind, hit.title])).toContainEqual(["wiki", "Billing FAQ"]);
  });

  test("content permission is asked harness by harness", async () => {
    const { find, planted } = await fleet();
    const answer = await find("need a manager", { canReadContent: (hrn) => hrn === HRN });
    expect(answer.facets.harness).toEqual({ [HRN]: answer.total });
    expect(answer.total).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain(`Refunds ${planted}`);
  });

  test("a customer's memory answers only a search of that one harness, by a reader of its content", async () => {
    const dir = tempDir();
    const home = tempDir();
    await seedHarness(dir);
    await seedTenant(dir);
    await buildShard({ hangarRoot: home, hrn: HRN, harnessDir: dir, now });
    const planted = marker("tenant");
    const find = (scope: "fleet" | "harness", content: boolean, q = planted) =>
      search({
        q,
        harnesses: [{ hrn: HRN, dir, name: "bot" }],
        hangarRoot: home,
        canRead: all,
        canReadContent: () => content,
        scope,
        now,
        limit: 100,
      });
    for (const [scope, content] of [
      ["fleet", true],
      ["fleet", false],
      ["harness", false],
    ] as const) {
      for (const q of [planted, "", "type:fact", "account"]) {
        const answer = await find(scope, content, q);
        const text = JSON.stringify(answer);
        expect(`${scope} ${content} ${q}: ${/t\.acme/.test(text) || text.includes(planted)}`).toBe(
          `${scope} ${content} ${q}: false`,
        );
      }
      expect((await find(scope, content)).total).toBe(0);
    }
    const own = await find("harness", true);
    expect(own.items.map((hit) => hit.kind).sort()).toEqual(["facts", "focus", "wiki"]);
    expect(own.items.every((hit) => hit.ref.includes("~t.acme~"))).toBe(true);
  });

  test("what a reader may not get moves nothing they get: a customer's titles leave the fleet's order alone", async () => {
    const order = async (customers: number, content: boolean): Promise<string[]> => {
      const dir = tempDir();
      const home = tempDir();
      const articles = wiki(dir);
      await articles.write({ slug: "a-page", title: "zebra notes", body: "One." });
      await articles.write({ slug: "b-page", title: "yak notes", body: "Two." });
      const theirs = wiki(dir, "bot", join(".crewhaus", "tenants", "acme"));
      for (let i = 0; i < customers; i++) {
        await theirs.write({ slug: `account-${i}`, title: `zebra account ${i}`, body: "Three." });
      }
      const built = await buildShard({ hangarRoot: home, hrn: HRN, harnessDir: dir, now });
      if (!built.ok) throw new Error(built.reason);
      const answer = await search({
        q: "zebra yak",
        harnesses: [{ hrn: HRN, dir, name: "bot" }],
        hangarRoot: home,
        canRead: all,
        canReadContent: () => content,
        now,
      });
      return answer.items.map((hit) => hit.title);
    };
    for (const content of [true, false]) {
      const alone = await order(0, content);
      expect(alone).toEqual(["zebra notes", "yak notes"]);
      expect(await order(6, content)).toEqual(alone);
    }
  });

  test("facts a reader without content permission may not get leave the order of names alone", async () => {
    const order = async (facts: number): Promise<string[]> => {
      const dir = tempDir();
      const home = tempDir();
      const articles = wiki(dir);
      await articles.write({ slug: "a-page", title: "zebra", body: "One." });
      await articles.write({
        slug: "b-page",
        title: "yak yak yak yak notes",
        body: "Two.",
      });
      const store = memories(dir);
      for (let i = 0; i < facts; i++) await store.remember(`fact number ${i}`);
      const built = await buildShard({ hangarRoot: home, hrn: HRN, harnessDir: dir, now });
      if (!built.ok) throw new Error(built.reason);
      const answer = await search({
        q: "zebra yak",
        harnesses: [{ hrn: HRN, dir, name: "bot" }],
        hangarRoot: home,
        canRead: all,
        canReadContent: none,
        now,
      });
      return answer.items.map((hit) => hit.title);
    };
    const alone = await order(0);
    expect(alone.length).toBe(2);
    expect(await order(40)).toEqual(alone);
  }, 20_000); // forty facts are written and indexed

  test("no harness readable is no access, and no other reason", async () => {
    const { find } = await fleet();
    const answer = await find("refunds", { canRead: none });
    expect(answer).toEqual({
      items: [],
      total: 0,
      facets: { kind: {}, harness: {}, status: {} },
      coverage: { kinds: [], namesOnly: [], thredz: "off" },
      empty: { reason: "no-access", remedy: "Ask an owner for access to a harness." },
    });
  });
});

describe("work items and criteria", () => {
  test("a work item shows its id, state and kind; its title and goal need content permission", async () => {
    const { find, idsA } = await fleet();
    const title = marker("worktitle");
    const named = (await find(`type:work ${idsA.work}`, { canReadContent: none })).items;
    expect(named.map((hit) => hit.title)).toEqual([`${idsA.work} (fix, open)`]);
    expect(JSON.stringify(named)).not.toContain(title);
    expect((await find(title, { canReadContent: none })).total).toBe(0);
    expect((await find("parse", { canReadContent: none })).total).toBe(0);
    const [read] = (await find("type:work parse")).items;
    expect(read?.title).toBe(`Fix the ${title} import`);
    expect(read?.snippet?.text).toBe("Dates parse.");
    expect(read?.ref).toBe(`${HRN}/work/${idsA.work}`);
    expect((await find("type:work status:open", { canReadContent: none })).total).toBe(1);
  });

  test("a criterion shows its id, severity, whether it is protected and what it asks, to any reader", async () => {
    const { find } = await fleet();
    const [hit] = (await find("local way", { canReadContent: none })).items;
    expect(hit?.kind).toBe("criterion");
    expect(hit?.ref).toBe(`${HRN}/criterion/dates-local`);
    for (const shown of ["dates-local", "high", "protected", "Dates are written the local way"]) {
      expect(hit?.title).toContain(shown);
    }
    expect((await find("type:criterion status:high")).total).toBe(1);
    expect((await find("type:grader exact", { canReadContent: none })).items[0]?.title).toBe(
      "exact",
    );
  });

  test("a criterion with only an id shows only that", async () => {
    const dir = tempDir();
    write(
      dir,
      join("eval", "graders.yaml"),
      "graders:\n  - name: exact\n    type: exact_match\ncriteria:\n  - id: terse\n    measured_by: [exact]\n",
    );
    const answer = await search({
      q: "type:criterion",
      harnesses: [{ hrn: HRN, dir, name: "bot" }],
      canRead: all,
      canReadContent: none,
      foldMissing: true,
      now,
    });
    expect(answer.items.map((hit) => [hit.title, hit.ref])).toEqual([
      ["terse", `${HRN}/criterion/terse`],
    ]);
  });
});

describe("an answer", () => {
  test("names where each hit is from, what it is and when it was read", async () => {
    const { find, idsA } = await fleet();
    const [hit] = (await find("manager type:fact in:support")).items;
    expect(hit).toEqual({
      kind: "facts",
      ref: `${HRN}/knowledge/facts~bot~-~${idsA.refunds}`,
      title: "Refunds over 500 need a manager",
      source: { harness: HRN, harnessName: "support", store: "facts", backend: "local" },
      updatedAt: NOW.toISOString(),
      freshness: { asOf: NOW.toISOString(), stale: false },
      owner: hit?.owner,
      href: `/#/i/${HRN}/knowledge/facts~bot~-~${idsA.refunds}`,
      ...(hit?.snippet !== undefined ? { snippet: hit.snippet } : {}),
    });
  });

  test("a snippet marks the words asked for", async () => {
    const { find } = await fleet();
    const hit = (await find("forty refund type:wiki")).items.find((h) => h.title === "Billing FAQ");
    const { text, highlights } = hit?.snippet ?? { text: "", highlights: [] };
    expect(text).toBe("Refund windows are forty days long.");
    expect(highlights.map(([from, to]) => text.slice(from, to))).toEqual(["Refund", "forty"]);
  });

  test("filters keep, count and facet alike", async () => {
    const { find } = await fleet();
    const answer = await find("type:wiki");
    expect(answer.facets).toEqual({
      kind: { wiki: 2 },
      harness: { [HRN]: 2 },
      status: { published: 1, archived: 1 },
    });
    // A word the store uses, and what it comes to.
    for (const q of ["type:wiki status:published", "type:wiki status:live"]) {
      expect((await find(q)).items.map((h) => h.title)).toEqual(["Billing FAQ"]);
    }
    expect((await find("type:work status:live")).total).toBe(0);
    expect((await find("type:wiki status:archived")).items.map((h) => h.title)).toEqual([
      "Old news",
    ]);
    expect((await find("#billing type:wiki")).total).toBe(1);
    expect((await find("status:corrected")).items.length).toBeGreaterThan(0);
    const filtered = await find("type:wiki status:retired");
    expect([filtered.total, filtered.empty?.reason]).toEqual([0, "filtered"]);
    expect((await find("zzzunsaid")).empty).toEqual({ reason: "no-data" });
  });

  test("pages follow one another without a hole or a repeat, and an index built again starts over", async () => {
    const { find, home, a } = await fleet();
    const whole = (await find("refunds")).items.map((hit) => hit.ref);
    expect(whole.length).toBeGreaterThan(7);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const page = await find("refunds", { limit: 7, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.items.map((hit) => hit.ref));
      expect(page.total).toBe(whole.length);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(whole);
    const first = await find("refunds", { limit: 7 });
    await memories(a).remember("Refunds in cash are never made");
    await buildShard({ hangarRoot: home, hrn: HRN, harnessDir: a, now });
    const again = await find("refunds", { limit: 7, cursor: first.next as string });
    expect(again.items).toEqual((await find("refunds", { limit: 7 })).items);
    for (const bad of ["", "not a cursor", Buffer.from('{"at":-1}').toString("base64url")]) {
      expect((await find("refunds", { limit: 7, cursor: bad })).items.length).toBe(7);
    }
  });

  test("a limit is never above 100 and never below 1", async () => {
    const { find } = await fleet();
    expect((await find("refunds", { limit: 0 })).items.length).toBe(1);
    expect((await find("", { limit: 5_000 })).items.length).toBeLessThanOrEqual(100);
  });
});

describe("a harness without an index", () => {
  test("is searched by its names, opens no store, and the answer says so", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    const opts = {
      harnesses: [{ hrn: HRN, dir, name: "support desk" }],
      canRead: all,
      canReadContent: all,
      now,
    };
    const named = await search({ q: "support", ...opts });
    expect(named.items.map((hit) => hit.kind).sort()).toEqual(["harness", "session"]);
    expect(named.coverage).toEqual({
      kinds: ["harness", "session"],
      namesOnly: [HRN],
      thredz: "off",
    });
    const missed = await search({ q: "manager", ...opts });
    expect([missed.total, missed.empty]).toEqual([
      0,
      { reason: "not-indexed", remedy: STILL_BUILDING },
    ]);
    expect(STILL_BUILDING).toBe("Search is still being built. Names are searchable now.");
    // One harness asked about on its own is folded in memory instead.
    const folded = await search({ q: "manager type:fact", ...opts, foldMissing: true });
    expect(folded.items.map((hit) => hit.title)).toContain("Refunds over 500 need a manager");
    expect(folded.coverage.namesOnly).toEqual([]);
  });

  test("beside one that has an index, both answer", async () => {
    const { find, home, harnesses, b } = await fleet();
    const unbuilt = "hrn_00000000000000d4";
    const answer = await find("refunds", {
      harnesses: [...harnesses, { hrn: unbuilt, dir: b, name: "refunds desk" }],
      hangarRoot: home,
    });
    expect(answer.coverage.namesOnly).toEqual([unbuilt]);
    expect(
      answer.items
        .filter((hit) => hit.source.harness === unbuilt)
        .map((h) => h.kind)
        .sort(),
    ).toEqual(["harness", "session"]);
  });
});

describe("search providers", () => {
  test("an area adds its own kind, and one that fails empties no other answer", async () => {
    const dir = tempDir();
    await seedHarness(dir);
    registerSearchProvider({
      kind: "run",
      async list(read) {
        return [{ kind: "run", ref: `${read.hrn}/run/r1`, title: "the run of refunds" }];
      },
    });
    registerSearchProvider({
      kind: "decision",
      async list() {
        throw new Error("no such log");
      },
    });
    expect(searchProviders().map((provider) => provider.kind)).toEqual([
      "criterion",
      "decision",
      "grader",
      "harness",
      "run",
      "session",
      "work",
    ]);
    const answer = await search({
      q: "refunds",
      harnesses: [{ hrn: HRN, dir, name: "bot" }],
      canRead: all,
      canReadContent: all,
      foldMissing: true,
      now,
      limit: 100,
    });
    expect(answer.items.map((hit) => hit.kind)).toContain("run");
    expect(answer.items.map((hit) => hit.kind)).toContain("facts");
    expect(answer.items.some((hit) => hit.kind === "decision")).toBe(false);
  });

  test("without content permission the work provider opens no revision", async () => {
    const dir = tempDir();
    const ids = await seedHarness(dir);
    const provider = searchProviders().find((p) => p.kind === "work");
    const { HarnessRead } = await import("./context");
    const rows = await provider?.list(new HarnessRead({ harnessDir: dir, hrn: HRN, now }), {
      canReadContent: false,
    });
    expect(rows).toEqual([
      {
        kind: "work",
        ref: `${HRN}/work/${ids.work}`,
        title: `${ids.work} (fix, open)`,
        words: ["fix", "open"],
        status: "open",
        updatedAt: NOW.toISOString(),
        owner: { kind: "agent" },
      },
    ]);
  });
});
