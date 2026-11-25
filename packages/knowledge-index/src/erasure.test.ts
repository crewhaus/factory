import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { moveToTrash } from "@crewhaus/continuity-store";
import {
  append,
  controlPaths,
  ensureDigestKey,
  harnessLedger,
  storedLocalActor,
  takeNudgeMarkers,
} from "@crewhaus/control-records";
import {
  SHARED_DIR_DEFAULT,
  type SharedMemory,
  applyPull,
  memoryContentHash,
  planPull,
  readRetractions,
} from "@crewhaus/harness-lifecycle/knowledge-sync";
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
  session,
  snapshot,
  state,
  tempDir,
  wiki,
  write,
  writeJson,
} from "./__test__/fixtures";
import { INDEX_PENDING } from "./effect";
import {
  type ErasureGrant,
  type ErasurePlan,
  type ErasureRequest,
  authorizeErasure,
  executeErasure,
  factItemId,
  planErasure,
} from "./erasure";
import { readItem, readItems } from "./items";
import { KNOWLEDGE_PROJECTION, Shard, buildShard } from "./shard";
import { itemDigest } from "./usage";

const closed: string[] = [];
afterEach(() => {
  for (const dir of closed.splice(0)) chmodSync(dir, 0o700);
});
afterAll(removeTempDirs);

const OTHER_HRN = "hrn_00000000000000b2";
const TALK = "sess_00000000000000dd";
const PERSON = marker("person");
const CAPTURED = marker("captured");

/**
 * A harness that knows a person: a corrected fact about them, live and in the kept history,
 * with everything their conversation left behind, a copy in the shared store and the copies
 * another harness pulled.
 */
async function scene() {
  const home = tempDir();
  const root = tempDir();
  const dir = join(root, "support");
  const other = join(root, "sales");
  const sharedDir = join(root, SHARED_DIR_DEFAULT);
  for (const path of [dir, other, sharedDir]) mkdirSync(path);
  const ids = await seedHarness(dir);
  const base = join(dir, ".crewhaus");

  session(dir, TALK);
  appendFileSync(join(base, "sessions", `${TALK}.jsonl`), `{"text":"${PERSON} said so"}\n`);
  writeJson(dir, join(".crewhaus", "sessions-index", `${TALK}.json`), {
    schemaVersion: 1,
    sessionId: TALK,
    outcome: `${PERSON} was helped.`,
    keyFacts: [PERSON],
  });
  const facts = memories(dir);
  const first = await facts.remember(`${PERSON} likes mornings`, ["crm"], {
    provenance: { sessionId: TALK, evidence: ["tu_9"] },
  });
  const { successor: second } = await facts.supersede(first.id, `${PERSON} likes evenings`, {
    reason: `${PERSON} changed their mind`,
  });
  await facts.compact(); // the first moves to the kept history
  await facts.annotate(second.id, { category: "person" });
  const captured = await facts.remember(`${CAPTURED} was mentioned`, [], {
    provenance: { sessionId: TALK, evidence: ["tu_10"] },
  });

  const articles = wiki(dir);
  await articles.write({ slug: "regulars", title: "Regulars", body: "We have regulars." });
  await articles.write({
    slug: "regulars",
    title: "Regulars",
    body: `${PERSON} is one.`,
    expectedVersion: 1,
    createdBy: { sessionId: TALK },
  });
  await articles.write({
    slug: "about-them",
    title: `About ${PERSON}`,
    body: `${PERSON} and evenings.`,
    tags: [PERSON],
    createdBy: { sessionId: TALK },
  });
  await state(dir, { session: TALK }).writeFocus(`answer ${PERSON}`);
  await state(dir).appendRequirement({
    text: `call ${PERSON} back`,
    source: { sessionId: TALK, turn: 1 },
  });
  const { ts } = await moveToTrash(
    [join(base, "state", "bot", "sessions", TALK, "focus.md")],
    base,
    { now },
  );
  await state(dir, { session: TALK }).writeFocus(`answer ${PERSON} again`);

  const line: SharedMemory = {
    contentHash: memoryContentHash(`${PERSON} likes mornings`, ["crm"]),
    text: `${PERSON} likes mornings`,
    tags: ["crm"],
    provenance: { harness: "support", pushedAt: "2026-10-01T00:00:00.000Z" },
    origin: { harness: "support", fact: first.id },
  };
  const unrelated: SharedMemory = {
    contentHash: memoryContentHash("Invoices go out on Mondays", []),
    text: "Invoices go out on Mondays",
    tags: [],
    provenance: { harness: "support", pushedAt: "2026-10-01T00:00:00.000Z" },
  };
  writeFileSync(
    join(sharedDir, "memories.jsonl"),
    `${JSON.stringify(line)}\n${JSON.stringify(unrelated)}\n`,
    { mode: 0o600 },
  );
  const pulled = await applyPull(
    other,
    planPull({
      sharedMemories: [line, unrelated],
      sharedFragments: [],
      harnessMemoryHashes: new Set(),
      harnessFragmentHashes: new Set(),
    }),
    now,
    { specName: "seller" },
  );
  writeJson(other, join(".crewhaus", "memories", "shared.jsonl"), {
    id: "mem_shared_7",
    text: line.text,
    tags: ["crm", "shared:support"],
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const request: ErasureRequest = {
    harnessDir: dir,
    hrn: HRN,
    harnessName: "bot",
    hangarRoot: home,
    items: [`facts~bot~-~${second.id}`],
    includeSources: true,
    basis: { kind: "marked" },
    harnesses: [
      { dir, hrn: HRN, name: "bot" },
      { dir: other, hrn: OTHER_HRN, name: "sales" },
    ],
    now,
  };
  const build = async (): Promise<void> => {
    for (const [harnessDir, hrn] of [
      [dir, HRN],
      [other, OTHER_HRN],
    ] as const) {
      await buildShard({ harnessDir, hrn, hangarRoot: home, now });
    }
  };
  return {
    home,
    root,
    dir,
    other,
    sharedDir,
    ids,
    request,
    build,
    first: first.id,
    second: second.id,
    captured: captured.id,
    pulledId: pulled.added[0] as string,
    trash: ts,
    hash: line.contentHash,
  };
}

const allowed = { mayManage: () => true, confirmName: "bot", harnessName: "bot" };
function grantOf(plan: ErasurePlan): ErasureGrant {
  const answer = authorizeErasure(plan, allowed);
  if (!answer.ok) throw new Error(answer.reason);
  return answer.grant;
}
const run = async (request: ErasureRequest, opts = {}) => {
  const answer = await executeErasure(grantOf(await planErasure(request)), opts);
  if (!answer.ok) throw new Error(answer.reason);
  return answer;
};
const receipts = (dir: string): Record<string, unknown>[] => {
  const at = join(dir, controlPaths(dir).knowledgeErasuresDir);
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(at, name), "utf8").split("\n"))
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Record<string, unknown>);
};

describe("what may be erased", () => {
  test("an item that isn't marked as personal data is refused, in these words", async () => {
    const { request, ids, dir } = await scene();
    const before = snapshot(dir);
    for (const item of [
      `facts~bot~-~${ids.refunds}`,
      "wiki~bot~-~billing-faq",
      "goals~bot~-~goal-0001",
      `sessions~-~-~${SESS}`,
    ]) {
      const plan = await planErasure({ ...request, items: [item] });
      expect(plan.refusals).toEqual([
        { item, reason: "This isn't marked as personal data. Forget or archive it instead." },
      ]);
      expect(plan.targets).toEqual([]);
      const answer = authorizeErasure(plan, allowed);
      expect(answer).toMatchObject({ ok: false, code: "refused-items" });
    }
    expect(snapshot(dir)).toEqual(before);
  });

  test("one refused item refuses the rest, and an item that isn't here is said to be missing", async () => {
    const { request, ids, second } = await scene();
    const plan = await planErasure({
      ...request,
      items: [`facts~bot~-~${second}`, `facts~bot~-~${ids.refunds}`],
    });
    expect(authorizeErasure(plan, allowed)).toMatchObject({ ok: false, code: "refused-items" });
    for (const item of [
      "facts~bot~-~mem_ffffffffffffffff",
      `facts~elsewhere~-~${second}`,
      `facts~bot~t.acme~${second}`,
      "not an item",
      "",
    ]) {
      const missing = await planErasure({ ...request, items: [item] });
      expect(missing.refusals).toEqual([{ item, reason: "There is no such item here." }]);
    }
    const nothing = await planErasure({ ...request, items: [] });
    expect(authorizeErasure(nothing, allowed)).toMatchObject({ ok: false, code: "nothing" });
  });

  test("the mark covers the whole correction chain, whichever end carries it", async () => {
    const { request, first, second, captured } = await scene();
    const plan = await planErasure({
      ...request,
      includeSources: false,
      items: [`facts~bot~-~${first}`],
    });
    expect(plan.refusals).toEqual([]);
    const scope = plan.scopes.find((s) => s.store === "memory");
    expect([...(scope?.targets ?? [])].sort()).toEqual([first, second].sort());
    expect(JSON.stringify(plan.scopes)).not.toContain(captured);
  });
});

describe("a dry run", () => {
  test("lists every copy by where it is, and what would stay", async () => {
    const { request, build, home, dir } = await scene();
    await ensureDigestKey(dir);
    append(harnessLedger(dir, { dir: controlPaths(dir).knowledgeUsageDir }), { v: 1 });
    await build();
    const plan = await planErasure(request);
    expect(plan.refusals).toEqual([]);
    expect(plan.targets).toEqual([
      { store: "session-summaries", copies: 1 },
      { store: "wiki-versions", copies: 2 },
      { store: "working-memory", copies: 2 },
      { store: "trash", copies: 1 },
      { store: "shared-store", copies: 1 },
      // The live line, its mark and the fact captured beside it.
      { store: "facts", copies: 3 },
      // The corrected line, and the line that corrected it.
      { store: "fact-archive", copies: 2 },
      // One in its own file, one in the file an older sync pulled into.
      { store: "pulled-copies", copies: 2, harness: "sales" },
      { store: "search-index", copies: 1 },
      { store: "search-index", copies: 1, harness: "sales" },
    ]);
    expect(plan.residue).toEqual([
      { code: "session-logs", until: expect.any(String) as unknown as string },
      { code: "usage-lines" },
      { code: "backups" },
      { code: "shared-retraction" },
    ]);
    expect(plan.harnesses).toEqual([dir, request.harnesses?.[1]?.dir as string]);
    expect(Shard.open(home, HRN)).toBeDefined();
  });

  test("without the sources, only the fact and its copies", async () => {
    const { request } = await scene();
    const plan = await planErasure({ ...request, includeSources: false });
    expect(plan.targets.map((t) => t.store)).toEqual([
      "shared-store",
      "facts",
      "fact-archive",
      "pulled-copies",
    ]);
  });

  test("writes nothing: not in the harness, the other harnesses, the shared store or Home", async () => {
    const { request, build, root, home } = await scene();
    await build();
    const before = [snapshot(root), snapshot(home)];
    const plan = await planErasure(request);
    authorizeErasure(plan, { ...allowed, confirmName: "wrong" });
    authorizeErasure(plan, allowed);
    expect([snapshot(root), snapshot(home)]).toEqual(before);
  });

  test("names what it can't reach: Thredz, the harness that shared it, notes that quote it", async () => {
    const { other, request, dir, pulledId } = await scene();
    write(dir, "crewhaus.yaml", "name: bot\ntarget: cli\nthredz:\n  url: x\n");
    writeJson(dir, join(".crewhaus", "dream", "bot", "idempotency.json"), {
      records: { a: { result: `near-duplicate: "${PERSON} likes evenings"` } },
    });
    const plan = await planErasure(request);
    expect(plan.residue.map((r) => r.code)).toEqual([
      "session-logs",
      "backups",
      "thredz",
      "shared-retraction",
      "dream-reports",
    ]);
    // From the harness that pulled it: the one that shared it keeps its own.
    await memories(other, "seller").annotate(pulledId, { category: "person" });
    const there = await planErasure({
      ...request,
      harnessDir: other,
      hrn: OTHER_HRN,
      harnessName: "sales",
      items: [`facts~seller~-~${pulledId}`],
    });
    expect(there.refusals).toEqual([]);
    expect(there.residue.map((r) => r.code)).toContain("origin-harness");
  });

  test("names a place a copy may be that it could not read, and a customer's own notes", async () => {
    const s = await scene();
    const codes = async (request: ErasureRequest) =>
      (await planErasure(request)).residue.map((r) => r.code);
    expect(await codes(s.request)).not.toContain("unread-stores");
    // A shared store that is there and cannot be read whole.
    const blocked = tempDir();
    mkdirSync(join(blocked, "memories.jsonl"));
    expect(await codes({ ...s.request, sharedDirs: [s.sharedDir, blocked] })).toContain(
      "unread-stores",
    );
    // A registered harness whose folder is not there.
    const gone = { dir: join(s.root, "retired-harness"), hrn: OTHER_HRN, name: "retired" };
    expect(
      await codes({ ...s.request, harnesses: [...(s.request.harnesses ?? []), gone] }),
    ).toContain("unread-stores");
    // A registered harness whose fact store cannot be read.
    write(s.other, join(".crewhaus", "memories", "broken.jsonl"), "");
    chmodSync(join(s.other, ".crewhaus", "memories", "broken.jsonl"), 0o000);
    try {
      expect(await codes(s.request)).toContain("unread-stores");
    } finally {
      chmodSync(join(s.other, ".crewhaus", "memories", "broken.jsonl"), 0o600);
    }
    // A customer's fact is quoted in the customer's own consolidation notes.
    const base = join(".crewhaus", "tenants", "acme");
    const store = memories(s.dir, "bot", base);
    const { id } = await store.remember(`${CAPTURED} pays late`);
    await store.annotate(id, { category: "person" });
    const request = { ...s.request, items: [`facts~bot~t.acme~${id}`] };
    expect(await codes(request)).not.toContain("dream-reports");
    writeJson(s.dir, join(base, "dream", "bot", "idempotency.json"), {
      records: { a: { result: `near-duplicate: "${CAPTURED} pays late"` } },
    });
    expect(await codes(request)).toContain("dream-reports");
  });
});

describe("who may", () => {
  test("one harness they may not manage refuses the whole call, and nothing is written", async () => {
    const { request, dir, other, root, home } = await scene();
    const before = [snapshot(root), snapshot(home)];
    const plan = await planErasure(request);
    for (const refused of [dir, other]) {
      const asked: string[] = [];
      const answer = authorizeErasure(plan, {
        ...allowed,
        mayManage: (harnessDir) => {
          asked.push(harnessDir);
          return harnessDir !== refused;
        },
      });
      expect(answer).toMatchObject({ ok: false, code: "not-allowed" });
      expect(asked).toContain(refused);
      expect(answer).not.toHaveProperty("grant");
    }
    expect([snapshot(root), snapshot(home)]).toEqual(before);
  });

  test("the typed name is the harness's, exactly", async () => {
    const { request } = await scene();
    const plan = await planErasure(request);
    for (const confirmName of ["", "Bot", "bot ", "sales", "yes"]) {
      expect(authorizeErasure(plan, { ...allowed, confirmName })).toMatchObject({
        ok: false,
        code: "wrong-name",
      });
    }
    expect(authorizeErasure(plan, allowed).ok).toBe(true);
  });

  test("a plan or a grant that was not made here is refused", async () => {
    const { request, root } = await scene();
    const before = snapshot(root);
    const plan = await planErasure(request);
    expect(authorizeErasure({ ...plan }, allowed)).toMatchObject({
      ok: false,
      code: "unknown-plan",
    });
    const grant = grantOf(plan);
    for (const copied of [{ ...grant }, structuredClone(grant)]) {
      expect(await executeErasure(copied)).toMatchObject({ ok: false, code: "unknown-grant" });
    }
    expect(snapshot(root)).toEqual(before);
  });

  test("a grant runs once", async () => {
    const { request } = await scene();
    const grant = grantOf(await planErasure(request));
    expect((await executeErasure(grant)).ok).toBe(true);
    expect(await executeErasure(grant)).toMatchObject({ ok: false, code: "unknown-grant" });
  });
});

describe("a store that changed since the dry run", () => {
  const changes: readonly (readonly [
    string,
    (s: Awaited<ReturnType<typeof scene>>) => Promise<void>,
  ])[] = [
    [
      "another correction of the fact",
      async (s) => {
        await memories(s.dir).supersede(s.second, "they like noon", { reason: "asked" });
      },
    ],
    [
      "the mark taken off",
      async (s) => {
        await memories(s.dir).annotate(s.second, { category: null });
      },
    ],
    [
      "another fact captured in the conversation",
      async (s) => {
        await memories(s.dir).remember("one more", [], { provenance: { sessionId: TALK } });
      },
    ],
    [
      "another article version written in it",
      async (s) => {
        await wiki(s.dir).write({
          slug: "new",
          title: "New",
          body: "b",
          createdBy: { sessionId: TALK },
        });
      },
    ],
    [
      "a pulled copy forgotten in the other harness",
      async (s) => {
        await memories(s.other, "seller").forget(s.pulledId);
      },
    ],
    [
      "another shared copy",
      async (s) => {
        const line = readFileSync(join(s.sharedDir, "memories.jsonl"), "utf8").split("\n")[0];
        appendFileSync(join(s.sharedDir, "memories.jsonl"), `${line}\n`);
      },
    ],
  ];
  for (const [what, change] of changes) {
    test(`refuses: ${what}`, async () => {
      const s = await scene();
      const grant = grantOf(await planErasure(s.request));
      await change(s);
      const before = snapshot(s.root);
      expect(await executeErasure(grant)).toEqual({
        ok: false,
        code: "changed",
        reason: "This changed since the dry run. Review it again.",
      });
      expect(snapshot(s.root)).toEqual(before);
      expect(receipts(s.dir)).toEqual([]);
      // Reviewed again, it runs; where the mark is gone there is nothing to run.
      const again = await planErasure(s.request);
      expect(authorizeErasure(again, allowed).ok).toBe(what !== "the mark taken off");
    });
  }

  test("a change that has nothing to do with it does not stop it", async () => {
    const s = await scene();
    const grant = grantOf(await planErasure(s.request));
    await memories(s.dir).remember("Lunch is at one");
    await wiki(s.dir).write({ slug: "lunch", title: "Lunch", body: "At one." });
    expect((await executeErasure(grant)).ok).toBe(true);
    expect((await memories(s.dir).list()).map((i) => i.entry.text)).toContain("Lunch is at one");
  });
});

describe("after it ran", () => {
  test("the text is nowhere but in what the dry run said would stay", async () => {
    const s = await scene();
    await ensureDigestKey(s.dir);
    append(harnessLedger(s.dir, { dir: controlPaths(s.dir).knowledgeUsageDir }), {
      v: 1,
      at: NOW.toISOString(),
      run: "run_a",
    });
    await s.build();
    expect(holding(s.root, PERSON).length).toBeGreaterThan(8);
    await run(s.request, {
      refreshIndex: async ({ dir, hrn }: { dir: string; hrn: string }) => {
        await buildShard({ harnessDir: dir, hrn, hangarRoot: s.home, now });
      },
    });
    expect(holding(s.root, PERSON)).toEqual([`support/.crewhaus/sessions/${TALK}.jsonl`]);
    expect(holding(s.root, CAPTURED)).toEqual([]);
    for (const planted of [PERSON, CAPTURED, PERSON.toLowerCase(), CAPTURED.toLowerCase()]) {
      expect(holding(s.home, planted)).toEqual([]);
    }
    // Their ids are in no file either.
    for (const id of [s.first, s.second, s.captured, s.pulledId]) {
      const kept = holding(s.root, id).concat(holding(s.home, id));
      expect(`${id}: ${kept.join()}`).toBe(`${id}: `);
    }
    // The conversation is, with its log: what it left behind is gone.
    expect(holding(s.root, TALK).every((f) => f.startsWith("support/.crewhaus/sessions/"))).toBe(
      true,
    );
    // The shared store keeps the note that withdraws the copies, by content hash.
    expect(readRetractions(s.sharedDir).map((r) => [r.reason, r.contentHash])).toEqual([
      ["erased", s.hash],
    ]);
  });

  test("everything else is as it was", async () => {
    const s = await scene();
    await run(s.request);
    const facts = (await memories(s.dir).list()).map((i) => i.entry.id);
    for (const id of [s.ids.refunds, s.ids.right, s.ids.loose, s.ids.passing]) {
      expect(facts).toContain(id);
    }
    const regulars = await wiki(s.dir).get("regulars");
    expect([regulars?.version, regulars?.body]).toEqual([1, "We have regulars."]);
    expect((await wiki(s.dir).get("billing-faq"))?.version).toBe(2);
    expect(await wiki(s.dir).get("about-them")).toBeNull();
    const focus = await state(s.dir).readFocus();
    expect(focus?.body).toBe("ship the quarterly report");
    expect(focus?.requirements.map((r) => r.text)).toEqual(["send it every Friday"]);
    expect((await memories(s.other, "seller").list()).map((i) => i.entry.text)).toEqual([
      "Invoices go out on Mondays",
    ]);
    expect(readFileSync(join(s.sharedDir, "memories.jsonl"), "utf8")).toContain("Invoices go out");
    expect(existsSync(join(s.dir, ".crewhaus", "sessions-index", `${SESS}.json`))).toBe(true);
    expect(existsSync(join(s.dir, ".crewhaus", "sessions-index", `${TALK}.json`))).toBe(false);
    expect(existsSync(join(s.dir, ".crewhaus", "trash", s.trash))).toBe(false);
  });

  test("a second run has nothing to erase, and says so", async () => {
    const s = await scene();
    await run(s.request);
    const again = await planErasure(s.request);
    expect(again.refusals).toEqual([
      { item: s.request.items[0] as string, reason: "There is no such item here." },
    ]);
  });

  test("a pull from the shared store brings no copy back", async () => {
    const s = await scene();
    await run(s.request);
    const line: SharedMemory = {
      contentHash: s.hash,
      text: `${PERSON} likes mornings`,
      tags: ["crm"],
      provenance: { harness: "support", pushedAt: "2026-10-01T00:00:00.000Z" },
    };
    const outcome = await applyPull(
      s.other,
      { memories: [line], fragments: [], skippedDuplicates: 0 },
      now,
      { specName: "seller", retractions: readRetractions(s.sharedDir) },
    );
    expect(outcome.added).toEqual([]);
  });

  test("the conversation's facts in a customer's place are not this one's to erase", async () => {
    const s = await scene();
    const base = join(".crewhaus", "tenants", "acme");
    const theirs = await memories(s.dir, "bot", base).remember("kept for acme", [], {
      provenance: { sessionId: TALK },
    });
    await run(s.request);
    expect((await memories(s.dir, "bot", base).list()).map((i) => i.entry.id)).toEqual([theirs.id]);
  });

  test("a customer's own fact, marked, is erased in its place", async () => {
    const s = await scene();
    const base = join(".crewhaus", "tenants", "acme");
    const store = memories(s.dir, "bot", base);
    const { id } = await store.remember(`${CAPTURED} of acme`);
    await store.annotate(id, { category: "person" });
    await run({ ...s.request, items: [`facts~bot~t.acme~${id}`] });
    expect((await store.list()).length).toBe(0);
    expect((await memories(s.dir).list()).map((i) => i.entry.id)).toContain(s.second);
  });
});

describe("the receipt", () => {
  test("holds counts and codes: no id, slug, hash, name or text", async () => {
    const s = await scene();
    const plan = await planErasure(s.request);
    const actor = ["local:someone", "somewhere"].join("@");
    const { receipt } = await run(s.request, { actor: { local: actor } });
    expect(receipts(s.dir)).toEqual([
      JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>,
    ]);
    expect(receipt).toMatchObject({
      v: 1,
      at: NOW.toISOString(),
      counts: {
        "session-summaries": 1,
        "wiki-versions": 2,
        "working-memory": 2,
        trash: 1,
        "shared-store": 1,
        facts: 5,
        "pulled-copies": 2,
      },
      residue: plan.residue,
    });
    expect(receipt.id).toMatch(/^erasure_[0-9a-f]{32}$/);
    const text = JSON.stringify(receipt);
    for (const planted of [
      PERSON,
      CAPTURED,
      "regulars",
      "about-them",
      "mem_",
      TALK,
      s.hash,
      s.hash.slice(0, 16),
      s.trash,
      "someone",
      "somewhere",
      createHash("sha256").update(actor).digest("hex").slice(0, 16),
      plan.digest,
      s.dir,
    ]) {
      expect(`${planted}: ${text.includes(planted)}`).toBe(`${planted}: false`);
    }
    // Every key and string in it is one of a closed set, or an id, a time, a code or a digest.
    expect(Object.keys(receipt).sort()).toEqual([
      "at",
      "by",
      "counts",
      "effects",
      "id",
      "residue",
      "v",
    ]);
    const key = await ensureDigestKey(s.dir);
    if (key.state !== "present") throw new Error(key.reason);
    expect(receipt.by).toBe(await storedLocalActor(key.hmac, actor));
  });

  test("a principal is named as it is, and nobody is nobody", async () => {
    const named = await scene();
    expect(
      (await run(named.request, { actor: { principal: "prn_x", local: "local:y" } })).receipt.by,
    ).toBe("prn_x");
    const unnamed = await scene();
    expect("by" in (await run(unnamed.request)).receipt).toBe(false);
  });

  test("is 0600 in 0700 directories", async () => {
    const s = await scene();
    await run(s.request);
    const at = join(s.dir, controlPaths(s.dir).knowledgeErasuresDir);
    expect(statSync(at).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(at)) expect(statSync(join(at, name)).mode & 0o777).toBe(0o600);
  });

  test("one effect per store, and the index effect: done when the pass ran, pending until it does", async () => {
    const built = await scene();
    await built.build();
    const done = await run(built.request, {
      refreshIndex: async ({ dir, hrn }: { dir: string; hrn: string }) => {
        await buildShard({ harnessDir: dir, hrn, hangarRoot: built.home, now });
      },
    });
    const kinds = done.receipt.effects.map((effect) => effect.kind);
    expect(kinds).toEqual([
      "session-summaries",
      "wiki-versions",
      "working-memory",
      "trash",
      "shared-store",
      "facts",
      "pulled-copies",
      "index",
    ]);
    expect(done.receipt.effects.at(-1)).toEqual({
      kind: "index",
      status: "done",
      observed: NOW.toISOString(),
    });
    expect(done.receipt.counts["search-index"]).toBe(2);

    const pending = await scene();
    await pending.build();
    const left = await run(pending.request);
    expect(left.receipt.effects.at(-1)).toEqual({
      kind: "index",
      status: "unknown",
      note: INDEX_PENDING,
    });
    expect(takeNudgeMarkers(pending.home, [KNOWLEDGE_PROJECTION]).sort()).toEqual(
      [HRN, OTHER_HRN].sort(),
    );
    for (const hrn of [HRN, OTHER_HRN]) expect(Shard.open(pending.home, hrn)).toBeUndefined();
  });

  test("a pass that fails leaves the effect pending and the erasure done", async () => {
    const s = await scene();
    await s.build();
    const done = await run(s.request, {
      refreshIndex: async () => {
        throw new Error("no room");
      },
    });
    expect(done.receipt.effects.at(-1)?.status).toBe("unknown");
    expect(holding(s.home, PERSON)).toEqual([]);
  });

  test("a harness with no id has no index to speak of", async () => {
    const s = await scene();
    const { hrn: _hrn, ...request } = s.request;
    const { receipt } = await run({ ...request, harnesses: [] });
    expect(receipt.effects.at(-1)).toMatchObject({ kind: "index", status: "skipped" });
  });

  // Root ignores the directory's mode.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a store that could not be erased is said to have failed, and the others are done",
    async () => {
      const s = await scene();
      const grant = grantOf(await planErasure(s.request));
      const locked = join(s.dir, ".crewhaus", "sessions-index");
      chmodSync(locked, 0o500);
      closed.push(locked);
      const answer = await executeErasure(grant);
      if (!answer.ok) throw new Error(answer.reason);
      expect(answer.failed).toEqual(["session-summaries"]);
      expect(answer.receipt.effects[0]).toEqual({
        kind: "session-summaries",
        status: "failed",
        note: "could not be deleted; run it again",
      });
      expect((await memories(s.dir).list()).map((i) => i.entry.id)).not.toContain(s.second);
    },
  );
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "one place of a store that failed is not made up for by the next place that did not",
  async () => {
    const s = await scene();
    const third = join(s.root, "zeta");
    await memories(third, "seller").importSynced(
      (await memories(s.other, "seller").list()).map((item) => item.entry),
    );
    const request = {
      ...s.request,
      harnesses: [...(s.request.harnesses ?? []), { dir: third, name: "zeta" }],
    };
    const grant = grantOf(await planErasure(request));
    const locked = join(s.other, ".crewhaus", "memories");
    chmodSync(locked, 0o500);
    closed.push(locked);
    const answer = await executeErasure(grant);
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.failed).toEqual(["pulled-copies"]);
    expect(answer.receipt.effects.find((e) => e.kind === "pulled-copies")?.status).toBe("failed");
    expect(holding(third, PERSON)).toEqual([]);
  },
);

describe("a grant names what each store may erase", () => {
  test("every scope is one store, its real root, and the ids the plan found", async () => {
    const s = await scene();
    const plan = await planErasure(s.request);
    const grant = grantOf(plan);
    expect(grant.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(grant.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.scopes.map((scope) => scope.store).sort()).toEqual([
      "continuity",
      "memory",
      "memory",
      "memory",
      "shared",
      "summaries",
      "trash",
      "wiki",
    ]);
    const own = grant.scopes.find((scope) => scope.store === "memory" && scope.spec === "bot");
    expect([...(own?.targets ?? [])].sort()).toEqual([s.first, s.second, s.captured].sort());
    expect(JSON.stringify(grant)).not.toContain(PERSON);
  });

  test("two plans of one request share a digest and never a nonce", async () => {
    const s = await scene();
    const [a, b] = [await planErasure(s.request), await planErasure(s.request)];
    expect(a.digest).toBe(b.digest);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("the rest of the door", () => {
  test("a fact id names its item where one store holds it, and nothing where two do", async () => {
    const s = await scene();
    expect(await factItemId({ dir: s.dir }, s.first)).toBe(`facts~bot~-~${s.first}`);
    expect(await factItemId({ dir: s.dir }, "mem_ffffffffffffffff")).toBeUndefined();
  });

  test("usage lines stay, and name no one: a keyed digest of where the item was", async () => {
    const s = await scene();
    const key = await ensureDigestKey(s.dir);
    if (key.state !== "present") throw new Error(key.reason);
    const digest = await itemDigest(key.hmac, {
      store: "fact",
      backend: "local",
      spec: "bot",
      localId: s.second,
    });
    append(harnessLedger(s.dir, { dir: controlPaths(s.dir).knowledgeUsageDir }), {
      v: 1,
      at: NOW.toISOString(),
      run: "run_a",
      session: SESS,
      item: digest,
      store: "fact",
      backend: "local",
      via: "recall",
      status: "included",
    });
    const plan = await planErasure(s.request);
    expect(plan.residue.map((r) => r.code)).toContain("usage-lines");
    await run(s.request);
    expect(holding(s.dir, digest)).toEqual([
      `${controlPaths(s.dir).knowledgeUsageDir}/000001.jsonl`,
    ]);
  });

  test("a shared store given by name is the one erased from", async () => {
    const s = await scene();
    const elsewhere = tempDir();
    writeFileSync(
      join(elsewhere, "memories.jsonl"),
      readFileSync(join(s.sharedDir, "memories.jsonl")),
    );
    await run({ ...s.request, sharedDirs: [elsewhere] });
    expect(holding(elsewhere, PERSON)).toEqual([]);
    expect(holding(s.sharedDir, PERSON)).toEqual(["memories.jsonl"]);
  });

  test("an index built after the erasure lists none of it", async () => {
    const s = await scene();
    await s.build();
    await run(s.request);
    rmSync(s.home, { recursive: true, force: true });
    mkdirSync(s.home);
    await s.build();
    const list = await readItems({
      harnessDir: s.dir,
      hrn: HRN,
      hangarRoot: s.home,
      canReadContent: true,
      limit: 500,
      now,
    });
    expect(list.items.some((item) => item.category === "person")).toBe(false);
    expect(
      await readItem({ harnessDir: s.dir, hrn: HRN, now }, `facts~bot~-~${s.second}`),
    ).toBeUndefined();
  });
});
