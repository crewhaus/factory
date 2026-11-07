/**
 * The memory screens against what the stores really write.
 *
 * Every live layout here is seeded by the real store (`createWikiStore`,
 * `createContinuityStore`), not a hand-written file, so a format change fails
 * in this file rather than on someone's harness. Driven over HTTP where the
 * dispatch-site masker and the route guards are part of what is under test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { createWikiStore, parseArticle } from "@crewhaus/wiki-store";
// @ts-expect-error — hand-written browser JS: the exact file the browser loads
import { editorGate } from "../../hangar-ui/assets/js/views/memory-fabric.js";
import { harnessActivity } from "./activity";
import { MAX_FACT_FILE_BYTES, MAX_MEMORY_ITEMS, MAX_TEXT_BYTES } from "./constants";
import { makeFixtureHarness } from "./fixture";
import type { M3Context } from "./m3";
import { foldFactsFile, stateView, wikiArticle, wikiView } from "./memory";
import { foldFacts, memoryFacts, memorySweep } from "./memory-ops";
import { type OmniEntry, harnessIndexToken } from "./omnibox";
import { resolveInside } from "./safety";
import { liveStore, readHarnessSpec, wikiAuthorityOf } from "./store-layout";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const THREDZ_REFUSAL = "This harness keeps its wiki in Thredz. Edit it there.";
const THREDZ_NOTE = "This harness keeps its wiki in Thredz.";
const UNKNOWN_REFUSAL = "Can't read this harness's spec, so its wiki can't be changed from here.";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

function wikiStore(dir: string, specName: string) {
  return createWikiStore({
    rootDir: join(dir, ".crewhaus", "wiki"),
    specName,
    now: () => new Date(NOW),
  });
}

function continuityStore(dir: string, specName: string) {
  return createContinuityStore({
    specName,
    rootDir: join(dir, ".crewhaus", "state"),
    sessionRootDir: join(dir, ".crewhaus", "sessions"),
    now: () => new Date(NOW),
  });
}

/** Every file under `.crewhaus` with its bytes, so any write shows. */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        out[`${prefix}${name}/`] = "";
        walk(path, `${prefix}${name}/`);
      } else {
        out[`${prefix}${name}`] = readFileSync(path, "base64");
      }
    }
  };
  walk(root, "");
  return out;
}

/** A fact line in the store's own shape. */
function fact(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `mem_${n.toString(16).padStart(16, "0")}`,
    text: `fact number ${n}`,
    tags: [],
    createdAt: iso(NOW - DAY),
    ...extra,
  };
}

function writeFacts(path: string, lines: readonly unknown[]): void {
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function factsDir(dir: string): string {
  const memories = join(dir, ".crewhaus", "memories");
  mkdirSync(memories, { recursive: true });
  return memories;
}

/** A file past the fold's cap that costs no disk. A read past the stat would
 *  surface its NUL bytes as a torn line. */
function sparseTooLarge(path: string): void {
  writeFileSync(path, "");
  truncateSync(path, MAX_FACT_FILE_BYTES + 1);
}

/** The context a route would hand a handler, for a name the router refuses. */
function handlerContext(dir: string, spec: string): M3Context {
  return {
    harnessDir: dir,
    params: { spec },
    body: { dryRun: true },
    now: () => NOW,
    contain: (segments: readonly string[]) => {
      const path = resolveInside(dir, segments);
      if (path === undefined) throw new Error("escapes");
      return path;
    },
  } as unknown as M3Context;
}

describe("spec-scoped reads", () => {
  test("every older read shows what the stores wrote", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "live"), { specName: "live" });
    await wikiStore(dir, "live").write({
      slug: "how-to-deploy",
      title: "How to deploy",
      body: "Run the release workflow.",
    });
    const continuity = continuityStore(dir, "live");
    await continuity.writeFocus("ship the memory screens");
    await continuity.createPlan({ title: "land it", steps: ["read", "write"] });
    await continuity.writeGoal({ title: "honest screens" });
    const id = await register(t, dir);

    const wiki = (await t.api(`/api/h/${id}/memory/wiki`)).body;
    expect(wiki["articles"]).toEqual(["how-to-deploy"]);
    const index = wiki["index"] as Record<string, { title: string }>;
    expect(index["how-to-deploy"]?.title).toBe("How to deploy");

    const state = (await t.api(`/api/h/${id}/memory/state`)).body;
    expect(String(state["focus"])).toContain("ship the memory screens");
    expect(String(state["goals"])).toContain("honest screens");
    const plans = state["plans"] as Array<{ file: string; text: string }>;
    expect(plans.length).toBe(1);
    expect(plans[0]?.text).toContain("land it");

    const detail = (await t.api(`/api/h/${id}`)).body;
    expect((detail["memory"] as { articles: number }).articles).toBe(1);

    const search = (await t.api("/api/search?q=deploy")).body["entries"] as OmniEntry[];
    expect(search.filter((e) => e.kind === "wiki").map((e) => e.id)).toEqual(["how-to-deploy"]);
  });

  test("a flat tree still reads", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "flat"), {
      specName: "flat",
      wikiIndex: { "old-article": { title: "Old article" } },
      wikiArticles: { "old-article": "# Old\nstill here\n" },
      focus: "older focus\n",
    });
    const id = await register(t, dir);

    const wiki = (await t.api(`/api/h/${id}/memory/wiki`)).body;
    expect(wiki["articles"]).toEqual(["old-article"]);
    expect((wiki["index"] as Record<string, { title: string }>)["old-article"]?.title).toBe(
      "Old article",
    );
    const article = (await t.api(`/api/h/${id}/memory/wiki/old-article`)).body;
    expect(article["body"]).toBe("# Old\nstill here\n");
    expect(article["title"]).toBe("old-article");
    expect(article["version"]).toBeNull();
    expect((await t.api(`/api/h/${id}/memory/state`)).body["focus"]).toBe("older focus\n");
    const search = (await t.api("/api/search?q=old")).body["entries"] as OmniEntry[];
    expect(search.some((e) => e.kind === "wiki")).toBe(true);
  });

  test("an unparseable index is null, and a directory named like an article is absent", () => {
    const root = bootTempDir();
    const dir = makeFixtureHarness(join(root, "odd"), { specName: "odd" });
    const store = join(dir, ".crewhaus", "wiki", "odd");
    mkdirSync(join(store, "articles", "folder.md"), { recursive: true });
    writeFileSync(join(store, "index.json"), "{ not json");
    expect(wikiView(dir).index).toBeNull();
    // Reading it as empty would hand the editor a blank body to save.
    expect(wikiArticle(dir, "folder")).toBeUndefined();
  });
});

function bootTempDir(): string {
  const t = boot();
  return t.harnessesRoot;
}

describe("the editor round trip", () => {
  test("GET gives the body alone, and a save does not nest frontmatter", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "editor"), { specName: "editor" });
    const store = wikiStore(dir, "editor");
    await store.write({ slug: "runbook", title: "Runbook", body: "first draft" });
    await store.write({
      slug: "runbook",
      title: "Runbook",
      body: "second draft\n\nwith a paragraph\n",
      expectedVersion: 1,
    });
    const id = await register(t, dir);

    const read = await t.api(`/api/h/${id}/memory/wiki/runbook`);
    expect(read.status).toBe(200);
    // The store trims the end of a body.
    expect(read.body["body"]).toBe("second draft\n\nwith a paragraph");
    expect(String(read.body["body"])).not.toContain("---");
    expect(read.body["title"]).toBe("Runbook");
    expect(read.body["version"]).toBe(2);
    expect(read.body["slug"]).toBe("runbook");

    const edited = `${String(read.body["body"])}\n\nand an edit`;
    const saved = await t.api(`/api/h/${id}/memory/wiki/runbook`, {
      method: "PUT",
      body: JSON.stringify({ body: edited, expectedVersion: read.body["version"] }),
    });
    expect(saved.body["ok"]).toBe(true);
    expect(saved.body["version"]).toBe(3);

    const onDisk = parseArticle(
      readFileSync(join(dir, ".crewhaus", "wiki", "editor", "articles", "runbook.md"), "utf8"),
    );
    expect(onDisk.body).toBe(edited);
    expect(onDisk.body).not.toContain("slug: runbook");
  });

  test("a served body is masked", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "masked"), { specName: "masked" });
    const secret = `sk-${"z".repeat(24)}`;
    await wikiStore(dir, "masked").write({ slug: "leak", title: "Leak", body: `key ${secret}` });
    const id = await register(t, dir);
    const read = await t.api(`/api/h/${id}/memory/wiki/leak`);
    expect(String(read.body["body"])).not.toContain(secret);
    expect(String(read.body["body"])).toContain("***");
  });

  // The value has no credential shape, so only the env scrubber touches it. The
  // editor's gate is run on what the route served, so the scrubber's form and
  // the gate's pattern cannot drift apart.
  const plainValue = ["plain", "opaque", "value", "1234"].join("");

  async function articleHoldingEnvValue(t: TestServer) {
    const dir = makeFixtureHarness(join(t.harnessesRoot, "scrubbed"), {
      specName: "scrubbed",
      envLines: [`BOT_TOKEN=${plainValue}`],
    });
    await wikiStore(dir, "scrubbed").write({
      slug: "held",
      title: "Held",
      body: `The current value is ${plainValue} until Friday.`,
    });
    return { dir, id: await register(t, dir) };
  }

  test("an env value is served as its name, and the editor will not save that", async () => {
    const t = boot();
    const { id } = await articleHoldingEnvValue(t);
    const read = await t.api(`/api/h/${id}/memory/wiki/held`);
    expect(read.body["body"]).toBe("The current value is «BOT_TOKEN» until Friday.");
    const gate = editorGate({ existing: true, article: read.body });
    expect(gate.canSave).toBe(false);
    expect(gate.status).toBe("hidden text");
  });

  test("so is the current article a stale save answers with", async () => {
    const t = boot();
    const { id } = await articleHoldingEnvValue(t);
    const stale = await t.api(`/api/h/${id}/memory/wiki/held`, {
      method: "PUT",
      body: JSON.stringify({ body: "my draft", title: "Held", expectedVersion: 99 }),
    });
    expect(stale.body["code"]).toBe("stale_article_version");
    const current = stale.body["current"] as Record<string, unknown>;
    expect(current["body"]).toBe("The current value is «BOT_TOKEN» until Friday.");
    expect(editorGate({ existing: true, article: current }).canSave).toBe(false);
  });

  test("a body the scrubber did not touch can be saved", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "clean"), {
      specName: "clean",
      envLines: [`BOT_TOKEN=${plainValue}`],
    });
    await wikiStore(dir, "clean").write({ slug: "fine", title: "Fine", body: "Nothing hidden." });
    const id = await register(t, dir);
    const read = await t.api(`/api/h/${id}/memory/wiki/fine`);
    expect(editorGate({ existing: true, article: read.body }).canSave).toBe(true);
  });
});

describe("a tree holding both layouts", () => {
  test("the flat-only slug is not served, because a save would not touch it", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "mixed"), {
      specName: "mixed",
      wikiArticles: { "flat-only": "# Flat\nolder file\n" },
    });
    await wikiStore(dir, "mixed").write({ slug: "scoped", title: "Scoped", body: "the live one" });
    const id = await register(t, dir);

    expect((await t.api(`/api/h/${id}/memory/wiki/flat-only`)).status).toBe(404);
    expect((await t.api(`/api/h/${id}/memory/wiki/scoped`)).status).toBe(200);
    expect((await t.api(`/api/h/${id}/memory/wiki`)).body["articles"]).toEqual(["scoped"]);
  });
});

describe("the search token and the activity feed", () => {
  test("both see a store write in the live directory", async () => {
    const root = bootTempDir();
    const dir = makeFixtureHarness(join(root, "token"), { specName: "token" });
    const store = wikiStore(dir, "token");
    await store.write({ slug: "one", title: "One", body: "first" });
    const articles = join(dir, ".crewhaus", "wiki", "token", "articles");
    utimesSync(articles, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
    const before = harnessIndexToken(dir);

    await store.write({ slug: "two", title: "Two", body: "second" });
    utimesSync(articles, new Date(NOW - DAY), new Date(NOW - DAY));
    expect(harnessIndexToken(dir)).not.toBe(before);

    const { items } = harnessActivity({ id: "hrn_x", dir, specName: "token" }, 0);
    expect(
      items
        .filter((i) => i.kind === "wiki")
        .map((i) => i.ref)
        .sort(),
    ).toEqual(["one", "two"]);
  });
});

describe("containment", () => {
  test("a symlinked article is not read, and its real sibling is", async () => {
    const root = bootTempDir();
    const outside = join(root, "outside.md");
    writeFileSync(outside, "PLANTED-OUTSIDE-MARKER");
    const dir = makeFixtureHarness(join(root, "linked"), { specName: "linked" });
    await wikiStore(dir, "linked").write({ slug: "real", title: "Real", body: "real body" });
    symlinkSync(outside, join(dir, ".crewhaus", "wiki", "linked", "articles", "escapee.md"));

    expect(wikiArticle(dir, "real")?.body).toBe("real body");
    expect(wikiArticle(dir, "escapee")).toBeUndefined();
    const view = wikiView(dir);
    expect(view.articles).toEqual(["real"]);
    expect(JSON.stringify(view)).not.toContain("PLANTED-OUTSIDE-MARKER");
  });

  test("a symlinked store directory falls to the flat store", async () => {
    const root = bootTempDir();
    const outside = join(root, "outside-store");
    mkdirSync(join(outside, "articles"), { recursive: true });
    writeFileSync(join(outside, "articles", "planted.md"), "PLANTED-OUTSIDE-MARKER");
    writeFileSync(join(outside, "focus.md"), "PLANTED-OUTSIDE-MARKER");
    const dir = makeFixtureHarness(join(root, "storelink"), {
      specName: "storelink",
      wikiArticles: { "flat-real": "# Flat\nflat body\n" },
      focus: "flat focus\n",
    });
    symlinkSync(outside, join(dir, ".crewhaus", "wiki", "storelink"));
    symlinkSync(outside, join(dir, ".crewhaus", "state", "storelink"));

    expect(wikiView(dir).articles).toEqual(["flat-real"]);
    expect(wikiArticle(dir, "flat-real")?.body).toContain("flat body");
    expect(wikiArticle(dir, "planted")).toBeUndefined();
    expect(stateView(dir).focus).toBe("flat focus\n");
  });

  test("a spec name that is not a path segment is not used as one", () => {
    const root = bootTempDir();
    const dir = makeFixtureHarness(join(root, "traversal"), {
      specName: "../../x",
      wikiArticles: { "flat-real": "# Flat\nflat body\n" },
    });
    // Where `.crewhaus/wiki/../../x` lands, if it were ever joined.
    const planted = join(dir, "x", "articles");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "planted.md"), "PLANTED-OUTSIDE-MARKER");

    expect(liveStore(dir, "wiki", "../../x", ["articles"])?.layout).toBe("flat");
    expect(wikiView(dir).articles).toEqual(["flat-real"]);
    expect(wikiArticle(dir, "planted")).toBeUndefined();
    expect(JSON.stringify(wikiView(dir))).not.toContain("PLANTED-OUTSIDE-MARKER");
  });

  test("a spec file symlinked out of the harness is unreadable, not skipped", () => {
    const root = bootTempDir();
    const outside = join(root, "outside.yaml");
    writeFileSync(outside, "name: planted\ntarget: cli\n");
    const dir = makeFixtureHarness(join(root, "speclink"), { noSpec: true });
    symlinkSync(outside, join(dir, "crewhaus.yaml"));
    writeFileSync(join(dir, "crewhaus.yml"), "name: other\ntarget: cli\n");
    expect(readHarnessSpec(dir)).toBeUndefined();
    expect(wikiAuthorityOf(dir)).toBe("unknown");
  });
});

describe("reads do not mutate", () => {
  test("no read rebuilds the index or touches a store file", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "still"), { specName: "still" });
    await wikiStore(dir, "still").write({ slug: "kept", title: "Kept", body: "kept body" });
    await continuityStore(dir, "still").writeFocus("kept focus");
    writeFacts(join(factsDir(dir), "still.jsonl"), [fact(1)]);
    // Gone first, so a rebuild would show.
    rmSync(join(dir, ".crewhaus", "wiki", "still", "index.json"));
    const id = await register(t, dir);
    const crewhaus = join(dir, ".crewhaus");
    const before = treeOf(crewhaus);

    const article = await t.api(`/api/h/${id}/memory/wiki/kept`);
    expect(article.body["body"]).toBe("kept body");
    const wiki = (await t.api(`/api/h/${id}/memory/wiki`)).body;
    expect(wiki["articles"]).toEqual(["kept"]);
    expect(wiki["index"]).toBeNull();
    expect(String((await t.api(`/api/h/${id}/memory/state`)).body["focus"])).toContain("kept");
    expect((await t.api(`/api/h/${id}/memory/facts`)).body["files"] as unknown[]).toHaveLength(1);
    expect(((await t.api(`/api/h/${id}`)).body["memory"] as { articles: number }).articles).toBe(1);
    const search = (await t.api("/api/search?q=kept")).body["entries"] as OmniEntry[];
    expect(search.some((e) => e.kind === "wiki")).toBe(true);
    expect((await t.api(`/api/h/${id}/memory/reflect`)).body["total"]).toBe(1);
    harnessActivity({ id, dir, specName: "still" }, 0);

    expect(treeOf(crewhaus)).toEqual(before);
    expect(Object.keys(treeOf(crewhaus))).not.toContain("wiki/still/index.json");
  });
});

describe("the whole file decides a fact's status", () => {
  test("a tombstone on the last line reaches a fact at the head", () => {
    const root = bootTempDir();
    const path = join(root, "long.jsonl");
    const entries = Array.from({ length: 5999 }, (_, i) => fact(i + 1));
    writeFacts(path, [
      ...entries,
      { tombstone: "superseded", target: fact(7)["id"], at: iso(NOW), reason: "replaced" },
    ]);

    const folded = foldFacts(path, NOW);
    expect(folded.counts).toEqual({ live: 5998, superseded: 1, expired: 0, total: 5999 });
    expect(folded.items.length).toBe(MAX_MEMORY_ITEMS);
    expect(folded.items[folded.items.length - 1]?.id).toBe(fact(5999)["id"] as string);
    expect(folded.items[0]?.id).toBe(fact(5999 - MAX_MEMORY_ITEMS + 1)["id"] as string);
    expect(folded.truncated).toBe(true);
    expect(folded.tooLarge).toBe(false);

    const file = foldFactsFile(path, "long", NOW);
    expect(file.superseded).toBe(1);
    expect(file.live).toBe(5998);
    expect(file.items.length).toBe(MAX_MEMORY_ITEMS);
    expect(file.items[file.items.length - 1]?.id).toBe(fact(5999)["id"] as string);
    expect(file.truncated).toBe(true);

    const newest = fact(5900)["id"] as string;
    writeFacts(path, [
      ...entries,
      { tombstone: "superseded", target: fact(7)["id"], at: iso(NOW), reason: "replaced" },
      { tombstone: "superseded", target: newest, at: iso(NOW), reason: "also replaced" },
    ]);
    const again = foldFacts(path, NOW);
    const row = again.items.find((i) => i.id === newest);
    expect(row?.status).toBe("superseded");
    expect(row?.supersedeReason).toBe("also replaced");
    expect(again.counts?.superseded).toBe(2);
  }, 20_000); // 6,000 lines parsed several times: slow on a loaded CI runner.

  test("a store with room for every row leaves none out", () => {
    const root = bootTempDir();
    const path = join(root, "short.jsonl");
    writeFacts(path, [fact(1), fact(2), null, 7, { id: 3 }]);
    const folded = foldFacts(path, NOW);
    expect(folded.items.map((i) => i.id)).toEqual([fact(1)["id"], fact(2)["id"]] as string[]);
    expect(folded.truncated).toBe(false);
    expect(folded.counts?.total).toBe(2);
  });
});

describe("an expiry no date can hold", () => {
  // Written by hand: `1e400` only exists as JSON text, and parses as Infinity.
  const badLines = ["1e30", "-1e30", "1e400"].map(
    (raw, i) => `{"id":"bad_${i}","text":"bad ${i}","expiresAt":${raw}}`,
  );
  const seed = (path: string): void => {
    const good = `${JSON.stringify(fact(1))}\n`;
    writeFileSync(path, `${badLines.join("\n")}\n${good}`);
  };

  test("is no expiry: the fold neither throws nor calls it expired", () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "dates"), { specName: "dates" });
    mkdirSync(factsDir(dir), { recursive: true });
    const path = join(factsDir(dir), "dates.jsonl");
    seed(path);
    const folded = foldFacts(path, NOW);
    expect(folded.counts).toEqual({ live: 4, superseded: 0, expired: 0, total: 4 });
    expect(folded.sweepable.total).toBe(0);
    const bad = folded.items.filter((row) => row.id.startsWith("bad_"));
    expect(bad.length).toBe(3);
    for (const row of bad) {
      expect(row.status).toBe("live");
      expect(row.expiresAt).toBe(null);
      expect(row.expiresInMs).toBe(null);
    }
    expect(foldFactsFile(path, "dates", NOW).live).toBe(4);
  });

  test("the edge of the range is still a date", () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "edge"), { specName: "edge" });
    mkdirSync(factsDir(dir), { recursive: true });
    const path = join(factsDir(dir), "edge.jsonl");
    writeFileSync(path, `{"id":"far","text":"far","expiresAt":8.64e15}\n`);
    expect(foldFacts(path, NOW).items[0]?.expiresAt).toBe(new Date(8.64e15).toISOString());
  });

  test("the harness page and both fact routes still answer", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "pages"), { specName: "pages" });
    mkdirSync(factsDir(dir), { recursive: true });
    seed(join(factsDir(dir), "pages.jsonl"));
    const id = await register(t, dir);
    for (const route of [
      `/api/h/${id}`,
      `/api/h/${id}/memory/facts`,
      `/api/h/${id}/memory/facts/pages`,
    ]) {
      expect((await t.api(route)).status).toBe(200);
    }
    const detail = await t.api(`/api/h/${id}`);
    expect((detail.body["memory"] as Record<string, unknown>)["facts"]).toBe(4);
  });
});

describe("the fold's cap", () => {
  test("a file at the cap folds, and one byte over is refused without a read", () => {
    const root = bootTempDir();
    const atCap = join(root, "at-cap.jsonl");
    writeFacts(atCap, [fact(1)]);
    const size = statSync(atCap).size;
    const folded = foldFacts(atCap, NOW, size);
    expect(folded.tooLarge).toBe(false);
    expect(folded.counts?.live).toBe(1);

    const over = join(root, "over.jsonl");
    writeFileSync(over, "x".repeat(size + 1));
    const refused = foldFacts(over, NOW, size);
    expect(refused.tooLarge).toBe(true);
    expect(refused.counts).toBeNull();
    expect(refused.items).toEqual([]);
    expect(refused.truncated).toBe(true);
    // Garbage on every line: a read past the stat would count them.
    expect(refused.torn).toBe(0);
    // The same file under a larger cap is read, so the assertion above can fail.
    expect(foldFacts(over, NOW, size + 1).torn).toBe(1);
  });

  test("an absent file is empty, not too large", () => {
    const root = bootTempDir();
    const folded = foldFacts(join(root, "absent.jsonl"), NOW, 1);
    expect(folded.tooLarge).toBe(false);
    expect(folded.counts).toEqual({ live: 0, superseded: 0, expired: 0, total: 0 });
  });

  test("the route says so and names a command that lists it", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "huge"), { specName: "huge" });
    const memories = factsDir(dir);
    sparseTooLarge(join(memories, "huge.jsonl"));
    const id = await register(t, dir);

    const { body } = await t.api(`/api/h/${id}/memory/facts/huge`);
    expect(body["present"]).toBe(true);
    expect(body["reason"]).toBe("unsupported");
    expect(body["tooLarge"]).toBe(true);
    expect(body["note"]).toBe("This fact store is too large to browse here.");
    expect(body["verb"]).toBe("crewhaus memory list --spec huge");
    expect(body["counts"]).toBeNull();
    expect(body["items"]).toEqual([]);
    expect(body["torn"]).toBe(0);
    expect((body["specs"] as string[]).includes("huge")).toBe(true);

    // The router refuses this name; the handler's own check is the second lock.
    expect((await t.api(`/api/h/${id}/memory/facts/a%20b`)).status).toBe(404);
    sparseTooLarge(join(memories, "a b.jsonl"));
    const spaced = (await memoryFacts(handlerContext(dir, "a b"))) as Record<string, unknown>;
    expect(spaced["tooLarge"]).toBe(true);
    expect(spaced["verb"]).toBe("crewhaus memory list");
  }, 20_000);

  test("a long store's note says the counts are whole", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "long"), { specName: "long" });
    writeFacts(
      join(factsDir(dir), "long.jsonl"),
      Array.from({ length: MAX_MEMORY_ITEMS + 1 }, (_, i) => fact(i + 1)),
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/memory/facts/long`);
    expect(body["note"]).toBe("Showing the newest facts. The counts cover all of them.");
    expect(body["verb"]).toBeNull();
    expect(body["truncated"]).toBe(true);
  });
});

describe("the Overview count", () => {
  test("a store too large to count makes the total unknown, not a partial sum", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "partial"), { specName: "partial" });
    const memories = factsDir(dir);
    writeFacts(join(memories, "partial.jsonl"), [fact(1), fact(2)]);
    sparseTooLarge(join(memories, "other.jsonl"));
    const id = await register(t, dir);

    const detail = (await t.api(`/api/h/${id}`)).body;
    expect((detail["memory"] as { facts: number | null }).facts).toBeNull();
    const files = (await t.api(`/api/h/${id}/memory/facts`)).body["files"] as Array<
      Record<string, unknown>
    >;
    const other = files.find((f) => f["specName"] === "other");
    expect(other?.["tooLarge"]).toBe(true);
    expect(other?.["live"]).toBeNull();
    expect(files.find((f) => f["specName"] === "partial")?.["live"]).toBe(2);

    rmSync(join(memories, "other.jsonl"));
    const clean = (await t.api(`/api/h/${id}`)).body;
    expect((clean["memory"] as { facts: number | null }).facts).toBe(2);
  }, 20_000);
});

describe("the sweep preview", () => {
  const sweep = async (
    t: TestServer,
    id: string,
    spec: string,
    dryRun: boolean,
  ): Promise<Record<string, unknown>> =>
    (
      await t.api(`/api/h/${id}/memory/facts/${spec}/sweep`, {
        method: "POST",
        body: JSON.stringify({ dryRun }),
      })
    ).body;

  test("finds the oldest fact, skips a superseded one, and agrees with the store", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "sweepy"), { specName: "sweepy" });
    const pastTtl = NOW - DAY;
    const oldest = fact(1, { expiresAt: pastTtl });
    const supersededByField = fact(2, { expiresAt: pastTtl, supersededBy: fact(3)["id"] });
    const supersededByTombstone = fact(4, { expiresAt: pastTtl });
    writeFacts(join(factsDir(dir), "sweepy.jsonl"), [
      oldest,
      supersededByField,
      supersededByTombstone,
      ...Array.from({ length: 600 }, (_, i) => fact(i + 10)),
      { tombstone: "superseded", target: supersededByTombstone["id"], at: iso(NOW) },
    ]);
    const id = await register(t, dir);

    const preview = await sweep(t, id, "sweepy", true);
    expect(preview["planTotal"]).toBe(1);
    expect((preview["plan"] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      oldest["id"] as string,
    ]);
    expect(String(preview["note"])).toContain("1 fact(s)");
    expect((preview["plan"] as Array<{ expiresAt: string }>)[0]?.expiresAt).toBe(iso(pastTtl));

    const real = await sweep(t, id, "sweepy", false);
    expect(real["swept"]).toBe(1);

    const after = await sweep(t, id, "sweepy", true);
    expect(after["planTotal"]).toBe(0);
    expect(after["plan"]).toEqual([]);
  });

  test("the plan is capped and the note counts them all", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "many"), { specName: "many" });
    const total = MAX_MEMORY_ITEMS + 3;
    writeFacts(
      join(factsDir(dir), "many.jsonl"),
      Array.from({ length: total }, (_, i) => fact(i + 1, { expiresAt: NOW - DAY })),
    );
    const id = await register(t, dir);
    const preview = await sweep(t, id, "many", true);
    expect(preview["planTotal"]).toBe(total);
    const plan = preview["plan"] as Array<{ id: string }>;
    expect(plan.length).toBe(MAX_MEMORY_ITEMS);
    expect(plan[0]?.id).toBe(fact(1)["id"] as string);
    expect(String(preview["note"])).toContain(`${total} fact(s)`);
  });

  test("a store too large to read has no preview, and names the command", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "bigsweep"), { specName: "bigsweep" });
    const memories = factsDir(dir);
    sparseTooLarge(join(memories, "bigsweep.jsonl"));
    sparseTooLarge(join(memories, "a b.jsonl"));
    const id = await register(t, dir);

    const preview = await sweep(t, id, "bigsweep", true);
    expect(preview["plan"]).toEqual([]);
    expect(preview["planTotal"]).toBeNull();
    expect(preview["live"]).toBeNull();
    expect(String(preview["note"])).toContain("crewhaus memory sweep --spec bigsweep");

    const spaced = (await memorySweep(handlerContext(dir, "a b"))) as Record<string, unknown>;
    expect(String(spaced["note"])).toContain("crewhaus memory sweep");
    expect(String(spaced["note"])).not.toContain("--spec");
  }, 20_000);
});

describe("archiving a long article", () => {
  test("is refused, because the write would cut the body at the read cap", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "longart"), { specName: "longart" });
    await wikiStore(dir, "longart").write({
      slug: "tome",
      title: "Tome",
      body: "line of the tome\n".repeat(Math.ceil(MAX_TEXT_BYTES / 16)),
    });
    const path = join(dir, ".crewhaus", "wiki", "longart", "articles", "tome.md");
    const before = readFileSync(path, "utf8");
    const id = await register(t, dir);

    const res = await t.api(`/api/h/${id}/memory/wiki/tome/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true, confirm: true }),
    });
    expect(res.status).toBe(409);
    expect(String(res.body["error"])).toContain("too long to archive");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(join(dir, ".crewhaus", "wiki", "longart", "versions", "tome"))).toBe(false);
  });
});

describe("a Thredz-backed wiki is edited in Thredz", () => {
  const put = (t: TestServer, id: string, slug: string) =>
    t.api(`/api/h/${id}/memory/wiki/${slug}`, {
      method: "PUT",
      body: JSON.stringify({ body: "an edit", expectedVersion: 1 }),
    });
  const archive = (t: TestServer, id: string, slug: string) =>
    t.api(`/api/h/${id}/memory/wiki/${slug}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true, confirm: true }),
    });
  const signals = (t: TestServer, id: string, slug: string) =>
    t.api(`/api/h/${id}/memory/wiki/${slug}/signals`, {
      method: "POST",
      body: JSON.stringify({ verified: true }),
    });
  const writes = [put, archive, signals];

  for (const target of ["cli", "channel", "managed", "crew"]) {
    test(`${target}: every local write is refused, with no key set`, async () => {
      const t = boot();
      const name = `tz-${target}`;
      const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
        specName: name,
        target,
        specExtra: "thredz: true",
      });
      await wikiStore(dir, name).write({ slug: "kept", title: "Kept", body: "kept body" });
      const crewhaus = join(dir, ".crewhaus");
      const before = treeOf(crewhaus);
      const id = await register(t, dir);

      for (const write of writes) {
        const res = await write(t, id, "kept");
        expect(res.status).toBe(409);
        expect(res.body["error"]).toBe(THREDZ_REFUSAL);
      }
      // Ahead of body validation: this is not a 400.
      const noBody = await t.api(`/api/h/${id}/memory/wiki/kept`, {
        method: "PUT",
        body: JSON.stringify({}),
      });
      expect(noBody.status).toBe(409);
      expect(noBody.body["error"]).toBe(THREDZ_REFUSAL);
      expect(treeOf(crewhaus)).toEqual(before);
    });
  }

  const localSpecs: ReadonlyArray<readonly [string, { target?: string; specExtra?: string }]> = [
    ["research ignores the block", { target: "research", specExtra: "thredz: true" }],
    ["thredz: false", { specExtra: "thredz: false" }],
    ["no block", {}],
  ];
  for (const [label, opts] of localSpecs) {
    test(`${label}: the local wiki writes`, async () => {
      const t = boot();
      const dir = makeFixtureHarness(join(t.harnessesRoot, "plain"), {
        specName: "plain",
        ...opts,
      });
      await wikiStore(dir, "plain").write({ slug: "kept", title: "Kept", body: "kept body" });
      const id = await register(t, dir);
      const saved = await put(t, id, "kept");
      expect(saved.status).toBe(200);
      expect(saved.body["ok"]).toBe(true);
      expect(saved.body["version"]).toBe(2);
      expect((await signals(t, id, "kept")).body["ok"]).toBe(true);
      expect((await archive(t, id, "kept")).body["ok"]).toBe(true);
    });
  }

  test("a local harness whose spec is crewhaus.yml writes", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "yml"), { specName: "yml" });
    await wikiStore(dir, "yml").write({ slug: "kept", title: "Kept", body: "kept body" });
    const id = await register(t, dir);
    renameSync(join(dir, "crewhaus.yaml"), join(dir, "crewhaus.yml"));
    expect(wikiAuthorityOf(dir)).toBe("local");
    const res = await put(t, id, "kept");
    expect(res.status).toBe(200);
    expect(res.body["version"]).toBe(2);
  });

  test("a crewhaus.yml spec is read for the sources gate and the stale threshold", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "ymlgate"), {
      specName: "ymlgate",
      specExtra: "memory:\n  wiki:\n    requireSources: true\n  dream:\n    every: 7d\n",
    });
    await wikiStore(dir, "ymlgate").write({ slug: "kept", title: "Kept", body: "kept body" });
    const id = await register(t, dir);
    const yaml = await t.api(`/api/h/${id}/memory/wiki/kept`, {
      method: "PUT",
      body: JSON.stringify({ body: "no sources here", title: "Kept", expectedVersion: 1 }),
    });
    expect(yaml.body["code"]).toBe("missing_sources");

    renameSync(join(dir, "crewhaus.yaml"), join(dir, "crewhaus.yml"));
    const yml = await t.api(`/api/h/${id}/memory/wiki/kept`, {
      method: "PUT",
      body: JSON.stringify({ body: "no sources here", title: "Kept", expectedVersion: 1 }),
    });
    expect(yml.body["code"]).toBe("missing_sources");
    const onDisk = join(dir, ".crewhaus", "wiki", "ymlgate", "articles", "kept.md");
    expect(parseArticle(readFileSync(onDisk, "utf8")).body).toBe("kept body");
    const reflectOnYml = await t.api(`/api/h/${id}/memory/reflect`);
    expect(reflectOnYml.body["sourcesGate"]).toBe(true);
    expect(reflectOnYml.body["thresholdSource"]).toBe("memory.dream.every");
    expect(reflectOnYml.body["thresholdMs"]).toBe(7 * DAY);
  });

  test("no spec: refused with its own message, on a harness holding a store", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "nospec"), { noSpec: true });
    await wikiStore(dir, "nospec").write({ slug: "kept", title: "Kept", body: "kept body" });
    const crewhaus = join(dir, ".crewhaus");
    const before = treeOf(crewhaus);
    const id = await register(t, dir);
    for (const write of writes) {
      const res = await write(t, id, "kept");
      expect(res.status).toBe(409);
      expect(res.body["error"]).toBe(UNKNOWN_REFUSAL);
    }
    expect(treeOf(crewhaus)).toEqual(before);
  });

  test("the answer table", () => {
    const root = bootTempDir();
    const specAt = (name: string, text: string): string => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "crewhaus.yaml"), text);
      return dir;
    };
    expect(wikiAuthorityOf(join(root, "absent"))).toBe("unknown");
    expect(wikiAuthorityOf(specAt("a", "name: a\ntarget: cli\n"))).toBe("local");
    expect(wikiAuthorityOf(specAt("b", "name: b\ntarget: cli\nthredz: false\n"))).toBe("local");
    for (const target of ["cli", "channel", "managed", "crew"]) {
      expect(wikiAuthorityOf(specAt(target, `name: x\ntarget: ${target}\nthredz: true\n`))).toBe(
        "thredz",
      );
    }
    expect(wikiAuthorityOf(specAt("r", "name: r\ntarget: research\nthredz: true\n"))).toBe("local");
    expect(wikiAuthorityOf(specAt("w", "name: w\ntarget: workflow\nthredz: true\n"))).toBe(
      "unknown",
    );
    expect(wikiAuthorityOf(specAt("n", "name: n\nthredz: true\n"))).toBe("unknown");
    // A variable and the object form are both a declared block.
    expect(wikiAuthorityOf(specAt("v", "name: v\ntarget: cli\nthredz: $KEY\n"))).toBe("thredz");
    expect(wikiAuthorityOf(specAt("o", "name: o\ntarget: cli\nthredz:\n  api_key: $KEY\n"))).toBe(
      "thredz",
    );
  });
});

describe("reads say who answered", () => {
  test("a Thredz-backed harness with no local rows", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "tzempty"), {
      specName: "tzempty",
      specExtra: "thredz: true",
    });
    const id = await register(t, dir);

    for (const url of [
      `/api/h/${id}/memory/reflect`,
      `/api/h/${id}/memory/wiki/none/versions`,
      `/api/h/${id}/memory/wiki/none/versions/1`,
    ]) {
      const { body } = await t.api(url);
      expect(`${url} ${String(body["backend"])}`).toBe(`${url} local`);
      expect(`${url} ${String(body["authority"])}`).toBe(`${url} thredz`);
      expect(body["present"]).toBe(false);
      expect(body["reason"]).toBe("unsupported");
      expect(body["note"]).toBe(THREDZ_NOTE);
    }
    expect((await t.api(`/api/h/${id}/memory/wiki`)).body["authority"]).toBe("thredz");
  });

  test("a run that fell back: the rows stay and the note says where the wiki lives", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "tzfall"), {
      specName: "tzfall",
      specExtra: "thredz: true",
    });
    const store = wikiStore(dir, "tzfall");
    await store.write({ slug: "kept", title: "Kept", body: "first" });
    await store.write({ slug: "kept", title: "Kept", body: "second", expectedVersion: 1 });
    const id = await register(t, dir);

    const reflect = (await t.api(`/api/h/${id}/memory/reflect`)).body;
    expect(reflect["present"]).toBe(true);
    expect(reflect["note"]).toBe(THREDZ_NOTE);
    expect((reflect["articles"] as unknown[]).length).toBe(1);
    expect(reflect["authority"]).toBe("thredz");

    const versions = (await t.api(`/api/h/${id}/memory/wiki/kept/versions`)).body;
    expect(versions["present"]).toBe(true);
    expect(versions["note"]).toBe(THREDZ_NOTE);
    expect((versions["versions"] as unknown[]).length).toBe(1);

    const version = (await t.api(`/api/h/${id}/memory/wiki/kept/versions/1`)).body;
    expect(version["present"]).toBe(true);
    expect(version["note"]).toBe(THREDZ_NOTE);
    expect(version["authority"]).toBe("thredz");
  });

  test("a local harness says local", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "localread"), { specName: "localread" });
    const id = await register(t, dir);
    const reflect = (await t.api(`/api/h/${id}/memory/reflect`)).body;
    expect(reflect["backend"]).toBe("local");
    expect(reflect["authority"]).toBe("local");
    expect(reflect["reason"]).toBe("no-data");
    expect(String(reflect["note"])).toContain("add one here");
    const versions = (await t.api(`/api/h/${id}/memory/wiki/none/versions`)).body;
    expect(versions["authority"]).toBe("local");
    expect(versions["reason"]).toBe("no-data");
    expect((await t.api(`/api/h/${id}/memory/wiki`)).body["authority"]).toBe("local");
  });
});

describe("reads carry a reason", () => {
  test("no-data, for an empty store", async () => {
    const t = boot();
    const id = await register(
      t,
      makeFixtureHarness(join(t.harnessesRoot, "reasons"), { specName: "reasons" }),
    );
    const { body } = await t.api(`/api/h/${id}/memory/facts/reasons`);
    expect(body["present"]).toBe(false);
    expect(body["reason"]).toBe("no-data");
    expect(body["note"]).toBe(
      "No facts yet. Facts appear when the harness remembers something while it works.",
    );
    expect((await t.api(`/api/h/${id}/memory/continuity`)).body["note"]).toBe(
      "No focus, plans or goals yet. They appear when the harness works on them.",
    );
    expect((await t.api(`/api/h/${id}/memory/continuity/trash`)).body["note"]).toBe(
      "Nothing has been cleared yet.",
    );
  });

  test("no-access, for a store that resolves outside the harness", async () => {
    const t = boot();
    const outside = join(t.harnessesRoot, "outside.jsonl");
    writeFacts(outside, [fact(1)]);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "escape"), { specName: "escape" });
    symlinkSync(outside, join(factsDir(dir), "escapee.jsonl"));
    const id = await register(t, dir);
    expect((await t.api(`/api/h/${id}/memory/facts/escapee`)).body["reason"]).toBe("no-access");
  });

  test("unsupported, for a store too large to read", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "toolarge"), { specName: "toolarge" });
    sparseTooLarge(join(factsDir(dir), "toolarge.jsonl"));
    const id = await register(t, dir);
    expect((await t.api(`/api/h/${id}/memory/facts/toolarge`)).body["reason"]).toBe("unsupported");
  }, 20_000);

  test("filtered, when a filter hid every row", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "filter"), { specName: "filter" });
    await wikiStore(dir, "filter").write({ slug: "kept", title: "Kept", body: "body" });
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/memory/reflect?q=nothing-matches`);
    expect(body["reason"]).toBe("filtered");
    expect(body["present"]).toBe(true);
    expect(body["note"]).toBe("no article matches these filters");
  });

  test("null, when there is something to show", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "shown"), { specName: "shown" });
    await wikiStore(dir, "shown").write({ slug: "kept", title: "Kept", body: "body" });
    writeFacts(join(factsDir(dir), "shown.jsonl"), [fact(1)]);
    const id = await register(t, dir);
    expect((await t.api(`/api/h/${id}/memory/reflect`)).body["reason"]).toBeNull();
    expect((await t.api(`/api/h/${id}/memory/facts/shown`)).body["reason"]).toBeNull();
  });
});
