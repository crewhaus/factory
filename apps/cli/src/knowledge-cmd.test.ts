import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { append, controlPaths, ensureDigestKey, harnessLedger } from "@crewhaus/control-records";
import { memoryContentHash } from "@crewhaus/harness-lifecycle/knowledge-sync";
import { HARNESS_IDENTITY_REL, openHangarRegistry } from "@crewhaus/harness-registry";
import { parseArgs } from "@crewhaus/infra-utils";
import {
  HarnessRead,
  Shard,
  UNREGISTERED_HRN,
  foldItems,
  itemDigest,
  lessonIdOf,
  parseLessons,
} from "@crewhaus/knowledge-index";
import { createMemoryStore } from "@crewhaus/memory-store";
import { createWikiStore } from "@crewhaus/wiki-store";
import { checkLine, realInventory } from "./__test__/twin-check";
import {
  KNOWLEDGE_ACTIONS,
  KNOWLEDGE_SCHEMAS,
  type KnowledgeAction,
  KnowledgeCmdError,
  type KnowledgeCmdIo,
  runKnowledgeCmd,
} from "./knowledge-cmd";
import { lessonId } from "./knowledge-edit-cmd";
import { parseLessonsMd } from "./lessons";
import { ownerCheck } from "./owner-check";
import { LEGACY_VERBS } from "./verbs";

const NOW = new Date("2026-11-01T00:00:00.000Z");
const HRN = "hrn_00000000000000a1";
const SESS = "sess_00000000000000aa";
/** Built from parts, so no test file holds it whole. */
const PERSON = ["PLANTED", "person", "4411"].join("");

let root: string;
let dir: string;
let out: string[];
let env: Record<string, string>;
let owner: KnowledgeCmdIo["owner"];
/** Where a verb runs, when that is not the harness `dir`. */
let cwd: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-knowledge-cmd-")));
  dir = join(root, "support");
  mkdirSync(dir);
  out = [];
  env = {
    CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
    CREWHAUS_HANGAR_ROOT: join(root, "hangar"),
  };
  owner = () => ({ ok: true });
  cwd = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const io = (): KnowledgeCmdIo => ({
  cwd: cwd ?? dir,
  env,
  stdout: (line) => out.push(line),
  now: () => NOW,
  owner,
});
const text = (): string => out.join("\n");
async function run(line: string | readonly string[], code = 0): Promise<string> {
  out = [];
  const [action, ...argv] = typeof line === "string" ? line.split(" ") : line;
  const args = parseArgs(argv, KNOWLEDGE_SCHEMAS[action as KnowledgeAction]);
  expect(await runKnowledgeCmd(action as KnowledgeAction, args, io())).toBe(code);
  return text();
}
const json = async (line: string | readonly string[], code = 0): Promise<Record<string, unknown>> =>
  JSON.parse(
    await run([...(typeof line === "string" ? line.split(" ") : line), "--json"], code),
  ) as Record<string, unknown>;
async function refused(line: string | readonly string[]): Promise<string> {
  out = [];
  const [action, ...argv] = typeof line === "string" ? line.split(" ") : line;
  const args = parseArgs(argv, KNOWLEDGE_SCHEMAS[action as KnowledgeAction]);
  const err = await runKnowledgeCmd(action as KnowledgeAction, args, io()).catch((e) => e);
  expect(err).toBeInstanceOf(KnowledgeCmdError);
  return (err as Error).message;
}

const write = (rel: string, content: string, at = dir): void => {
  mkdirSync(dirname(join(at, rel)), { recursive: true });
  writeFileSync(join(at, rel), content);
};
const facts = (at = dir) =>
  createMemoryStore({
    specName: "bot",
    rootDir: join(at, ".crewhaus", "memories"),
    now: () => NOW,
  });

/** A harness with a fact, a corrected fact marked personal, an article, a plan and a lesson. */
async function seed(): Promise<{
  readonly refunds: string;
  readonly person: string;
  readonly first: string;
}> {
  write("crewhaus.yaml", "name: bot\ntarget: cli\n");
  write(join(".crewhaus", "sessions", `${SESS}.jsonl`), "{}\n");
  write(
    join(".crewhaus", "sessions", `${SESS}.json`),
    `${JSON.stringify({ id: SESS, name: "a call", target: "cli", updatedAt: NOW.toISOString() })}\n`,
  );
  const store = facts();
  const { id: refunds } = await store.remember("Refunds over 500 need a manager", ["billing"], {
    provenance: { sessionId: SESS, author: { kind: "agent", via: "remember" } },
  });
  const { id: first } = await store.remember(`${PERSON} likes mornings`, [], {
    provenance: { sessionId: SESS },
  });
  const { successor } = await store.supersede(first, `${PERSON} likes evenings`, {
    reason: "asked",
    author: { kind: "operator", via: "cli" },
  });
  await store.annotate(successor.id, { category: "person" });
  const wiki = createWikiStore({
    specName: "bot",
    rootDir: join(dir, ".crewhaus", "wiki"),
    now: () => NOW,
  });
  for (const [body, expectedVersion] of [
    ["Refund windows are thirty days long.", undefined],
    ["Refund windows are forty days long.", 1],
  ] as const) {
    await wiki.write({
      slug: "billing-faq",
      title: "Billing FAQ",
      body,
      createdBy: { sessionId: SESS },
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
  }
  const state = createContinuityStore({
    specName: "bot",
    rootDir: join(dir, ".crewhaus", "state"),
    now: () => NOW,
  });
  await state.createPlan({ title: "Migrate invoices", steps: ["draft the map"] });
  write(
    "LESSONS.md",
    "# LESSONS\n\n- mine\n\n<!-- crewhaus:lessons -->\n\n## Corrections & preferences\n\n- Confirm the currency before quoting\n- confirm  the CURRENCY before quoting\n\n## Known failure patterns\n\n- Watch out: the mail tool times out.\n",
  );
  return { refunds, person: successor.id, first };
}
/** A harness.json naming `hrn`, and the registry row that names this folder by it. */
function identity(at = dir, hrn = HRN): void {
  write(HARNESS_IDENTITY_REL, `${JSON.stringify({ v: 1, id: hrn })}\n`, at);
  expect(register(at)).toBe(hrn);
}
function register(at = dir): string {
  return openHangarRegistry({ env }).upsert({ dir: at, specName: "bot", target: "cli" }).id;
}
async function used(run: string, localId: string, over: object = {}): Promise<void> {
  const key = await ensureDigestKey(dir);
  if (key.state !== "present") throw new Error(key.reason);
  append(harnessLedger(dir, { dir: controlPaths(dir).knowledgeUsageDir }), {
    v: 1,
    at: "2026-10-30T10:00:00.000Z",
    run,
    session: SESS,
    item: await itemDigest(key.hmac, { store: "fact", backend: "local", spec: "bot", localId }),
    store: "fact",
    backend: "local",
    via: "recall",
    status: "included",
    ...over,
  });
}
/** Every file under the test's root: its size, time, mode and bytes. */
function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const stats = lstatSync(full);
      files.set(
        full,
        `${stats.size} ${stats.mtimeMs} ${stats.mode} ${entry.isFile() ? readFileSync(full, "utf8") : ""}`,
      );
      if (entry.isDirectory()) visit(full);
    }
  };
  visit(root);
  return files;
}
const holding = (word: string): string[] =>
  [...snapshot()].flatMap(([path, value]) =>
    value.includes(word)
      ? [
          path
            .slice(root.length + 1)
            .split("\\")
            .join("/"),
        ]
      : [],
  );

describe("the verbs", () => {
  test("are these eight, beside sync, and each has help a newcomer can read", async () => {
    expect([...KNOWLEDGE_ACTIONS]).toEqual([
      "status",
      "list",
      "show",
      "why",
      "usage",
      "search",
      "reindex",
      "erase",
    ]);
    // The dispatch sends each of these here, and the inventory lists each beside sync.
    const row = LEGACY_VERBS.find((entry) => entry.verb === "knowledge");
    expect(Object.keys(row?.sub ?? {})).toEqual(["", "sync", ...KNOWLEDGE_ACTIONS]);
    for (const action of KNOWLEDGE_ACTIONS) {
      const help = await run(`${action} --help`);
      expect(help).toStartWith(`crewhaus knowledge ${action} — `);
      expect(help).toContain(`usage: crewhaus knowledge ${action}`);
    }
    expect(await run("erase --help")).toContain(
      "crewhaus knowledge erase — delete data marked personal, everywhere this harness kept it. Shows what it will remove first.",
    );
  });

  test("every command an item names is one the CLI runs", async () => {
    await seed();
    const inventory = await realInventory();
    const { items } = await foldItems(
      new HarnessRead({ harnessDir: dir, hrn: UNREGISTERED_HRN, now: () => NOW }),
    );
    const twins = items.flatMap(({ item }) =>
      item.operations.flatMap((op) => (op.cliTwin !== null ? [op.cliTwin] : [])),
    );
    expect(twins.length).toBeGreaterThan(8);
    for (const twin of twins)
      expect(`${twin}: ${checkLine(inventory, twin)}`).toBe(`${twin}: null`);
    // And so is every command these verbs print or name in a refusal.
    for (const line of [
      "crewhaus knowledge reindex",
      "crewhaus knowledge list --type fact",
      "crewhaus knowledge usage <item>",
      "crewhaus knowledge erase <item> --include-sources --yes --confirm bot",
      "crewhaus memory mark <mem> --personal",
      "crewhaus harness list",
      "crewhaus harness adopt .",
    ]) {
      expect(`${line}: ${checkLine(inventory, line)}`).toBe(`${line}: null`);
    }
  });
});

describe("status", () => {
  test("counts what is known and says what isn't built or recorded yet", async () => {
    await seed();
    const shown = await run("status");
    expect(shown).toContain("bot: what it knows");
    expect(shown).toMatch(/facts +3/);
    expect(shown).toMatch(/wiki +1/);
    expect(shown).toContain("Search isn't built yet: crewhaus knowledge reindex");
    expect(shown).toContain("Usage isn't recorded here yet");
    expect(await json("status")).toMatchObject({
      harness: { hrn: null, name: "bot" },
      stores: { facts: 3, wiki: 1, plans: 1 },
      usageRecorded: false,
      thredz: "off",
      index: { built: false },
      notes: [],
    });
  });

  test("an empty harness says when something will appear", async () => {
    expect(await run("status")).toContain(
      "Nothing yet. Facts appear when the harness remembers something while it works.",
    );
    expect(await json("status")).toMatchObject({ total: 0, stores: {} });
  });

  test("says when the search index was built, and when what it holds changed", async () => {
    await seed();
    identity();
    await run("reindex");
    expect(await run("status")).toContain("Search was built on 2026-11-01");
    expect(await json("status")).toMatchObject({
      harness: { hrn: HRN },
      index: { built: true, asOf: NOW.toISOString(), current: true },
    });
    await facts().remember("something new");
    expect(await run("status")).toContain("some of it changed since: crewhaus knowledge reindex");
    expect(await json("status")).toMatchObject({ index: { current: false } });
  });
});

describe("list", () => {
  test("names each item by its id, and narrows by kind, status and scope", async () => {
    const { refunds, first } = await seed();
    const all = await run("list");
    expect(all).toContain(`facts~bot~-~${refunds}  live  Refunds over 500 need a manager`);
    expect(all).toContain("Billing FAQ");
    // A fact marked personal is listed, so its owner can delete it, and shows no text.
    expect(all).toContain("live, personal  Personal data");
    expect(all).not.toContain(PERSON);
    expect(await run("list --type wiki")).toBe("wiki~bot~-~billing-faq  published  Billing FAQ");
    for (const word of ["corrected", "replaced", "superseded"]) {
      const listed = await run(`list --type fact --status ${word}`);
      expect(listed).toContain(first);
      expect(listed.split("\n").length).toBe(1);
    }
    expect(await run("list --scope tenant")).toBe(
      "Nothing matches. Remove a filter to see everything.",
    );
    const read = await json("list --type fact");
    expect(read).toMatchObject({
      total: 3,
      freshness: { from: "direct-fold" },
      usageRecorded: false,
    });
    expect((read["items"] as { id: string }[]).map((item) => item.id)).toContain(
      `facts~bot~-~${refunds}`,
    );
  });

  test("a kind or a scope that isn't one is refused, naming what it takes", async () => {
    expect(await refused("list --type wishes")).toContain("fact, wiki, plan");
    expect(await refused("list --type work")).toContain('--type "work" names nothing to list');
    expect(await refused("list --scope world")).toBe(
      "knowledge list: --scope is one of spec, session, tenant, shared",
    );
  });

  test("an index that was built is read, and says so", async () => {
    await seed();
    identity();
    await run("reindex");
    expect(await json("list")).toMatchObject({
      freshness: { from: "index", asOf: NOW.toISOString() },
    });
  });
});

describe("show and why", () => {
  test("one item by its id, its qualified id or a fact's own id", async () => {
    const { refunds } = await seed();
    const id = `facts~bot~-~${refunds}`;
    const shown = await run(`show ${id}`);
    expect(shown).toContain("Refunds over 500 need a manager");
    expect(shown).toContain(`  ${id}`);
    expect(shown).toContain("live · tags: billing");
    for (const given of [refunds, `${HRN}/knowledge/${id}`]) {
      expect(await run(`show ${given}`)).toBe(shown);
    }
    expect(await json(`show ${refunds}`)).toMatchObject({
      item: { id, lifecycle: "live", author: { kind: "agent", via: "remember" } },
      body: "Refunds over 500 need a manager",
    });
  });

  test("--history adds what it was before, oldest first", async () => {
    const { person } = await seed();
    const shown = await run(`show ${person} --history`);
    expect(shown.indexOf("likes evenings")).toBeGreaterThan(-1);
    expect(shown).toContain("asked");
    const read = await json("show wiki~bot~-~billing-faq --history");
    const history = read["history"] as { version?: number; body?: string }[];
    expect(history.map((entry) => entry.version)).toEqual([1, 2]);
    expect(history[0]?.body).toContain("thirty days");
    expect(await run("show plans~bot~-~plan-0001 --history")).toContain(
      "No earlier versions are kept.",
    );
  });

  test("what looks like a credential is masked", async () => {
    await seed();
    const leaked = ["sk", "live", "a1B2".repeat(6)].join("_");
    const { id } = await facts().remember(`the key is ${leaked} ok`);
    for (const line of [`show ${id}`, `show ${id} --json`, "list", "list --json"]) {
      expect(await run(line)).not.toContain(leaked);
    }
  });

  test("what a harness wrote cannot drive the terminal: no control character is printed", async () => {
    await seed();
    // An escape sequence, a bell and a C1 control, built from their codes.
    const [esc, bell, csi] = [27, 7, 0x9b].map((code) => String.fromCharCode(code));
    const { id } = await facts().remember(`colour ${esc}[31mred${bell} and ${csi}2J gone`);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
    const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
    for (const line of [`show ${id}`, "list", `why ${id}`, "search colour --harness ."]) {
      const printed = await run(line);
      expect(printed).toContain("colour");
      expect(`${line}: ${controls.test(printed)}`).toBe(`${line}: false`);
    }
    // In JSON every one is escaped, and the text reads back as it was written.
    const shown = await run(`show ${id} --json`);
    expect(controls.test(shown)).toBe(false);
    const body = (JSON.parse(shown) as { body: string }).body;
    expect(body).toBe(`colour ${esc}[31mred${bell} and ${csi}2J gone`);
  });

  test("why says where it came from and whether that is still there", async () => {
    const { refunds, person } = await seed();
    expect(await run(`why ${refunds}`)).toContain(`From a conversation (${SESS}), kept until 20`);
    expect(await run(`why ${person}`)).toContain("Written by a person.");
    const { id } = await facts().remember("nobody knows");
    expect(await run(`why ${id}`)).toContain("No recorded source.");
    rmSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
    expect(await run(`why ${refunds}`)).toContain(
      `From a conversation (${SESS}) that was removed.`,
    );
    expect(await json(`why ${refunds}`)).toMatchObject({
      id: `facts~bot~-~${refunds}`,
      author: { kind: "agent" },
      evidence: { status: "evicted" },
    });
  });

  test("an item that isn't here, or isn't an item, is refused in words that help", async () => {
    await seed();
    expect(await refused("show")).toBe("usage: crewhaus knowledge show <item>");
    expect(await refused("show nonsense")).toContain("crewhaus knowledge list names each item");
    expect(await refused("show mem_ffffffffffffffff")).toContain(
      "crewhaus knowledge list --type fact names them",
    );
    expect(await refused("why facts~bot~-~mem_ffffffffffffffff")).toBe(
      "There is no such item here.",
    );
    expect(await refused("show ../../etc/passwd")).toContain("is not an item");
  });
});

describe("usage", () => {
  test("a harness that recorded none says so, of an item and of a run", async () => {
    const { refunds } = await seed();
    expect(await run(`usage ${refunds}`)).toContain(
      "Usage isn't recorded for this, so nothing is known about which runs used it.",
    );
    expect(await json(`usage ${refunds}`)).toMatchObject({ recorded: false, runs: 0, uses: [] });
    expect(await run("usage run_a")).toBe(
      "This harness has no usage log, so what this run used isn't recorded.",
    );
    expect(await json("usage run_a")).toEqual({
      run: "run_a",
      state: "not-recorded",
      reason: "no-usage-log",
    });
  });

  test("the runs that used an item, and what a run used", async () => {
    const { refunds, person } = await seed();
    await used("run_a", refunds);
    await used("run_b", refunds, { at: "2026-10-31T10:00:00.000Z", status: "redacted" });
    await used("run_a", "mem_ffffffffffffffff");
    const shown = await run(`usage ${refunds}`);
    expect(shown).toContain("Used in 2 runs, last on 2026-10-31.");
    expect(shown).toContain("run_b  recalled at the start, hidden for safety");
    expect(await json(`usage ${refunds}`)).toMatchObject({
      id: `facts~bot~-~${refunds}`,
      recorded: true,
      runs: 2,
      decisions: [],
    });
    expect(await run(`usage ${person}`)).toContain("No recorded run used it.");
    const ran = await run("usage run_a");
    expect(ran).toContain("Refunds over 500 need a manager  (recalled at the start)");
    expect(ran).toContain("something in facts that isn't here any more");
    expect(ran).toContain("not why a decision was made");
    expect(await run("usage run_zzz")).toBe(
      "No line names this run, so what it used isn't recorded.",
    );
  });
});

describe("search", () => {
  test("every registered harness and this one; one with --harness; never what is marked personal", async () => {
    const { refunds } = await seed();
    const hrn = register();
    const other = join(root, "sales");
    mkdirSync(other);
    write("crewhaus.yaml", "name: sales\ntarget: cli\n", other);
    await facts(other).remember("Refunds are paid on Fridays");
    const otherHrn = register(other);
    expect(await run("search refunds")).toContain("Names are searchable now");
    const answer = await json("search refunds --harness .");
    expect(answer).toMatchObject({ coverage: { namesOnly: [] } });
    const hits = answer["items"] as { ref: string; source: { harness: string } }[];
    expect(hits.map((hit) => hit.ref)).toContain(`${hrn}/knowledge/facts~bot~-~${refunds}`);
    expect(hits.every((hit) => hit.source.harness === hrn)).toBe(true);
    for (const named of [otherHrn, other]) {
      const there = await json(["search", "refunds", "--harness", named]);
      expect((there["items"] as { title: string }[]).map((hit) => hit.title)).toEqual([
        "Refunds are paid on Fridays",
      ]);
    }
    expect(await run(`search ${PERSON.toLowerCase()} --harness .`)).toContain(
      "Nothing here matches.",
    );
    expect(await json(`search ${PERSON}`)).toMatchObject({ total: 0 });
    expect(await refused("search refunds --harness nowhere")).toContain(
      "crewhaus harness list names them",
    );
    expect(await refused("search")).toBe("usage: crewhaus knowledge search <words>");
  });

  test("a built index answers whole, words and filters together", async () => {
    await seed();
    identity();
    await run("reindex");
    const shown = await run("search forty days type:wiki");
    expect(shown).toContain("Billing FAQ  (wiki · bot)");
    expect(shown).toContain("Refund windows are forty days long.");
    expect(shown).not.toContain("Names are searchable now");
  });
});

describe("reindex", () => {
  test("builds this harness's index under Home, and nowhere else", async () => {
    await seed();
    identity();
    const before = new Set(snapshot().keys());
    expect(await run("reindex")).toMatch(/^Search is built for bot: \d+ items\.$/);
    const added = [...snapshot().keys()].filter((path) => !before.has(path));
    expect(added.length).toBeGreaterThan(6);
    for (const path of added) expect(path).toStartWith(join(root, "hangar"));
    expect(Shard.open(join(root, "hangar"), HRN, dir)?.meta.asOf).toBe(NOW.toISOString());
    expect(await json("reindex")).toMatchObject({
      hrn: HRN,
      truncated: false,
      notes: [],
      asOf: NOW.toISOString(),
    });
  });

  test("a folder with no harness id is refused, naming what gives it one", async () => {
    await seed();
    expect(await refused("reindex")).toContain("crewhaus harness adopt . registers it");
    // A harness.json alone is not a registration.
    write(HARNESS_IDENTITY_REL, `${JSON.stringify({ v: 1, id: HRN })}\n`);
    expect(await refused("reindex")).toContain("crewhaus harness adopt . registers it");
    expect(existsSync(join(root, "hangar"))).toBe(false);
  });

  test("a command an agent's tool started is refused, and writes nothing", async () => {
    await seed();
    identity();
    const before = snapshot();
    env = { ...env, CREWHAUS_AGENT_TOOL: "Bash" };
    expect(await refused("reindex")).toBe(
      "knowledge reindex: this command was started by an agent's tool; a person does this",
    );
    expect(snapshot()).toEqual(before);
  });

  test("a copy carrying another harness's id keeps its index, and its content, out of that one", async () => {
    await seed();
    identity();
    await run("reindex");
    const home = join(root, "hangar");
    const original = snapshot();
    const shardOf = (): string[] =>
      [...original.keys()].filter((path) => path.startsWith(join(home, "cache")));
    expect(shardOf().length).toBeGreaterThan(0);
    // The copy keeps the original's harness.json; the registry gives it an id of its own.
    const copy = join(root, "copy");
    mkdirSync(copy);
    write("crewhaus.yaml", "name: bot\ntarget: cli\n", copy);
    write(HARNESS_IDENTITY_REL, `${JSON.stringify({ v: 1, id: HRN })}\n`, copy);
    expect(register(copy)).not.toBe(HRN);
    const only = ["COPYONLY", "MARKER"].join("");
    await facts(copy).remember(`${only} is in the copy`);
    const inShard = (): Map<string, string> =>
      new Map([...snapshot()].filter(([path]) => path.startsWith(join(home, "cache"))));
    const shard = inShard();
    cwd = copy;
    expect(await refused("reindex")).toContain("crewhaus harness adopt . sets it right");
    // Read in memory, from its own folder.
    expect(await run("list")).toContain(only);
    const marked = (await facts(copy).list())[0]?.entry.id ?? "";
    await facts(copy).annotate(marked, { category: "person" });
    await run(`erase ${marked} --yes --confirm bot`);
    expect(inShard()).toEqual(shard);
    cwd = undefined;
    expect(await run("list")).not.toContain(only);
    expect(await json("status")).toMatchObject({ index: { built: true, current: true } });
  });
});

describe("erase", () => {
  test("shows what it will remove, and writes nothing until it is told twice", async () => {
    const { person } = await seed();
    identity();
    await run("reindex");
    const before = snapshot();
    const shown = await run(`erase ${person}`);
    expect(shown).toContain("Will delete:");
    expect(shown).toContain("lines about it in the fact file");
    expect(shown).toContain("1 search index");
    expect(shown).toContain("Can't delete:");
    expect(shown).toContain(
      "Nothing was deleted. This can't be undone; to delete it, add: --yes --confirm bot",
    );
    expect(shown).not.toContain(PERSON);
    const plan = await json(`erase ${person} --include-sources`);
    expect(plan).toMatchObject({ dryRun: true, refusals: [] });
    expect((plan["targets"] as { store: string }[]).map((t) => t.store)).toContain("wiki-versions");
    expect(await refused(`erase ${person} --yes`)).toBe(
      "Type the harness's name (bot) to confirm. Nothing was deleted.",
    );
    expect(await refused(`erase ${person} --yes --confirm support`)).toContain(
      "Nothing was deleted",
    );
    expect(snapshot()).toEqual(before);
  });

  test("deletes it everywhere, says what remains, and keeps a record without the content", async () => {
    const { person, first, refunds } = await seed();
    identity();
    await run("reindex");
    const shown = await run(`erase ${person} --yes --confirm bot`);
    expect(shown).toContain("Deleted:");
    expect(shown).toContain("Still there:");
    expect(shown).toContain("A record that something was deleted is kept, without the content.");
    expect(holding(PERSON)).toEqual([]);
    expect(holding(person)).toEqual([]);
    expect(holding(first)).toEqual([]);
    expect((await facts().list()).map((item) => item.entry.id)).toEqual([refunds]);
    // It had an index, so it has one again, and that one is current.
    expect(await json("status")).toMatchObject({ index: { built: true, current: true } });
    expect(await refused(`erase ${person} --yes --confirm bot`)).toContain(
      "crewhaus knowledge list --type fact names them",
    );
  });

  test("a harness without an index is given none", async () => {
    const { person } = await seed();
    identity();
    const done = await json(`erase ${person} --yes --confirm bot`);
    expect(done).toMatchObject({ dryRun: false, failed: [] });
    const receipt = done["receipt"] as { by: string; effects: { kind: string; status: string }[] };
    expect(receipt.effects.at(-1)).toMatchObject({ kind: "index", status: "unknown" });
    expect(receipt.by).toMatch(/^local:#[0-9a-f]{64}$/);
    expect(Shard.open(join(root, "hangar"), HRN, dir)).toBeUndefined();
  });

  test("with its sources, what the conversation left behind goes too", async () => {
    const { person } = await seed();
    await run(`erase ${person} --include-sources --yes --confirm bot`);
    // Everything here came from that one conversation.
    expect(await facts().list()).toEqual([]);
    expect(await run("list --type wiki")).toContain("Nothing matches");
    expect(await run("list --type plan")).toContain("Migrate invoices");
  });

  test("a flag it does not read is refused, and nothing is deleted", async () => {
    const { person } = await seed();
    const before = snapshot();
    expect(() =>
      parseArgs([person, "--yes", "--confirm", "bot", "--dry-run"], KNOWLEDGE_SCHEMAS.erase),
    ).toThrow("--dry-run");
    expect(snapshot()).toEqual(before);
    // No verb takes a flag only sync or another verb reads.
    const foreign: Readonly<Record<string, readonly string[]>> = {
      "--dry-run": [],
      "--pull": [],
      "--push": [],
      "--no-redact": [],
      "--root": ["x"],
      "--shared": ["x"],
      "--yes": [],
      "--history": [],
      "--harness": ["x"],
    };
    const reads: Readonly<Record<KnowledgeAction, readonly string[]>> = {
      status: [],
      list: [],
      show: ["--history"],
      why: [],
      usage: [],
      search: ["--harness"],
      reindex: [],
      erase: ["--shared", "--yes"],
    };
    for (const action of KNOWLEDGE_ACTIONS) {
      for (const [name, value] of Object.entries(foreign)) {
        if (reads[action].includes(name)) continue;
        expect(
          `${action} ${name}: ${(() => {
            try {
              parseArgs(["x", name, ...value], KNOWLEDGE_SCHEMAS[action]);
              return "accepted";
            } catch {
              return "refused";
            }
          })()}`,
        ).toBe(`${action} ${name}: refused`);
      }
    }
  });

  test("--shared names a shared store kept somewhere else, by its real path", async () => {
    const { person } = await seed();
    const elsewhere = join(root, "fleet-store");
    mkdirSync(elsewhere);
    const text = `${PERSON} likes evenings`;
    write(
      "memories.jsonl",
      `${JSON.stringify({ contentHash: memoryContentHash(text, []), text, tags: [] })}\n`,
      elsewhere,
    );
    const plan = await json(["erase", person, "--shared", elsewhere]);
    expect(plan["targets"]).toContainEqual({
      store: "shared-store",
      copies: 1,
      dir: realpathSync(elsewhere),
    });
    expect(await run(["erase", person, "--shared", elsewhere])).toContain(
      `1 copy in the shared store (at ${realpathSync(elsewhere)})`,
    );
    await run(["erase", person, "--shared", elsewhere, "--yes", "--confirm", "bot"]);
    expect(readFileSync(join(elsewhere, "memories.jsonl"), "utf8")).toBe("");
  });

  test("anything not marked personal is refused, and one refusal refuses the rest", async () => {
    const { refunds, person } = await seed();
    const before = snapshot();
    const shown = await run(`erase ${refunds}`, 1);
    expect(shown).toBe(
      `Refused: facts~bot~-~${refunds} — This isn't marked as personal data. Forget or archive it instead.`,
    );
    expect(await refused(`erase ${person} ${refunds} --yes --confirm bot`)).toBe(
      "This isn't marked as personal data. Forget or archive it instead.",
    );
    expect(await refused("erase")).toBe("usage: crewhaus knowledge erase <item>…");
    expect(snapshot()).toEqual(before);
  });

  test("only the owner may, and a command an agent's tool started may not", async () => {
    const { person } = await seed();
    const before = snapshot();
    owner = () => ({ ok: false, reason: "the local user is not this harness's owner" });
    expect(await refused(`erase ${person} --yes --confirm bot`)).toBe(
      "Nothing was deleted: the local user is not this harness's owner",
    );
    owner = (at) => ownerCheck(at, undefined, { CREWHAUS_AGENT_TOOL: "Bash" });
    expect(await refused(`erase ${person} --yes --confirm bot`)).toBe(
      "Nothing was deleted: this command was started by an agent's tool; a person makes this change",
    );
    expect(snapshot()).toEqual(before);
    // The owner of every harness it reaches: a copy in one they don't own refuses it all.
    owner = (at) => (at === dir ? { ok: true } : { ok: false, reason: "not theirs" });
    expect((await json(`erase ${person}`))["dryRun"]).toBe(true);
  });

  test("an owner who is a principal is recorded as one", async () => {
    const { person } = await seed();
    owner = () => ({ ok: true, principal: "prn_0123456789abcdef" });
    const done = await json(`erase ${person} --yes --confirm bot`);
    expect(done).toMatchObject({ receipt: { by: "prn_0123456789abcdef" } });
  });
});

describe("the reads write nothing", () => {
  test("every verb but reindex and a confirmed erase leaves every file as it was", async () => {
    const { refunds, person } = await seed();
    identity();
    register();
    const lines = [
      "status",
      "list",
      "list --type fact --status live",
      `show ${refunds} --history`,
      `show ${person}`,
      `why ${refunds}`,
      `usage ${refunds}`,
      "usage run_a",
      "search refunds",
      "search refunds --harness .",
      `erase ${person}`,
      `erase ${person} --include-sources`,
    ];
    const reads = async (): Promise<void> => {
      for (const line of lines) {
        await run(line);
        await run(`${line} --json`);
      }
    };
    let before = snapshot();
    await reads();
    expect(snapshot()).toEqual(before);
    await used("run_a", refunds);
    await run("reindex");
    before = snapshot();
    await reads();
    expect(snapshot()).toEqual(before);
  });
});

describe("the entry file", () => {
  /** The CLI itself, as a terminal runs it. */
  const cli = (argv: readonly string[], extra: Record<string, string> = {}) => {
    const entry = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");
    const child = Bun.spawnSync([process.execPath, entry, ...argv], {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "", HOME: root, ...env, ...extra },
    });
    return {
      code: child.exitCode,
      out: child.stdout.toString(),
      err: child.stderr.toString(),
    };
  };

  // Five processes of the whole CLI.
  test("routes each verb here, prints a refusal and exits 1, and refuses what isn't a verb", async () => {
    const { person, refunds } = await seed();
    const status = cli(["knowledge", "status", "--json"]);
    expect([status.code, JSON.parse(status.out)]).toMatchObject([0, { stores: { facts: 3 } }]);
    const missing = cli(["knowledge", "show", "mem_ffffffffffffffff"]);
    expect([missing.code, missing.err]).toEqual([
      1,
      expect.stringContaining(
        "crewhaus knowledge list --type fact names them",
      ) as unknown as string,
    ]);
    expect(cli(["knowledge", "erase", refunds]).code).toBe(1);
    const unread = cli(["knowledge", "erase", person, "--yes", "--confirm", "bot", "--dry-run"]);
    expect([unread.code, unread.err]).toEqual([
      1,
      expect.stringContaining("--dry-run") as unknown as string,
    ]);
    const tool = cli(["knowledge", "erase", person, "--yes", "--confirm", "bot"], {
      CREWHAUS_AGENT_TOOL: "Bash",
    });
    expect(tool.code).toBe(1);
    expect(tool.err).toContain("Nothing was deleted: this command was started by an agent's tool");
    expect(holding(PERSON).length).toBeGreaterThan(0);
    const unknown = cli(["knowledge", "wish"]);
    expect([unknown.code, unknown.err]).toEqual([
      1,
      expect.stringContaining(
        'knowledge action must be one of: sync, status, list, show, why, usage, search, reindex, erase (got "wish")',
      ) as unknown as string,
    ]);
  }, 20_000);
});

describe("lessons have one id", () => {
  test("the index reads LESSONS.md and names each lesson as the CLI does", async () => {
    await seed();
    const content = readFileSync(join(dir, "LESSONS.md"), "utf8");
    const cli = parseLessonsMd(content).lessons;
    expect(cli.length).toBeGreaterThanOrEqual(2);
    const parsed = parseLessons(content);
    expect(parsed.map((lesson) => lesson.text)).toEqual(cli.map((lesson) => lesson.text));
    expect(parsed.map((lesson) => lessonIdOf(lesson.text))).toEqual(cli.map(lessonId));
    const { items } = await foldItems(
      new HarnessRead({ harnessDir: dir, hrn: UNREGISTERED_HRN, now: () => NOW }),
    );
    const listed = items.filter(({ item }) => item.ref.store === "lessons");
    expect(listed.map(({ item }) => item.ref.localId).sort()).toEqual(
      [...new Set(cli.map(lessonId))].sort(),
    );
    // No marker, no lessons: what a person wrote is theirs.
    const human = "# Notes\n\n- mine\n";
    expect(parseLessons(human)).toEqual([]);
    expect(parseLessonsMd(human).lessons).toEqual([]);
  });
});
