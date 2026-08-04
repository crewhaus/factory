/**
 * The memory fabric's server half: facts, recall, continuity + trash, the
 * wiki editor, watchme, learning and knowledge sync.
 *
 * What these tests are really guarding is one sentence: NOTHING IN THIS AREA
 * DELETES. So the assertions that matter most are the ones that read the
 * file back after a "destructive" verb and prove the original bytes are
 * still there — a forgotten fact's line, a cleared focus file's snapshot, an
 * archived article's versions. A handler that started calling `compact()`,
 * `rm`, or the store's own `list()` (which evicts) would fail here rather
 * than in someone's harness.
 *
 * Everything is driven through the real HTTP surface against a fixture
 * harness, because the guards under test (containment, masking, the confirm
 * ladder) live at the dispatch site — a direct handler call would skip them.
 * No test here spawns a process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContinuityStore } from "@crewhaus/continuity-store";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

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

/** A credential-shaped token built from PARTS — never a literal in a
 *  fixture (the repo's push protection rejects those, and rightly). */
const FAKE_TOKEN = `sk-${"z".repeat(24)}`;

/**
 * The area's canonical harness: facts with a tombstone, a TTL entry and a
 * torn line; a spec-scoped wiki; watchme observations with a priced and an
 * UNPRICED model; a dream state a day stale; a learning block.
 */
function fabricHarness(t: TestServer, name = "fabric", opts: { learning?: boolean } = {}): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    memories: {
      [name]: [
        {
          id: "mem_0000000000000001",
          text: "deploys go through the release workflow",
          tags: ["ops"],
          createdAt: iso(NOW - DAY),
          schemaVersion: 2,
          provenance: { sessionId: "sess_00000000000000aa", evidence: ["tu_1", "tu_2"] },
        },
        {
          id: "mem_0000000000000002",
          text: "an older claim",
          tags: [],
          createdAt: iso(NOW - 3 * DAY),
        },
        {
          tombstone: "superseded",
          target: "mem_0000000000000002",
          at: iso(NOW - DAY),
          reason: "restated after the release",
          supersededBy: "mem_0000000000000001",
          schemaVersion: 2,
        },
        {
          id: "mem_0000000000000003",
          text: "a short-lived note",
          tags: [],
          createdAt: iso(NOW - 2 * DAY),
          expiresAt: NOW - DAY,
        },
        {
          id: "mem_0000000000000004",
          text: `the staging key is ${FAKE_TOKEN}`,
          tags: [],
          createdAt: iso(NOW - DAY),
        },
        '{"id":"mem_torn', // a torn tail line must not hide the rest
      ],
    },
    dreamState: { [name]: { lastRunAt: iso(NOW - 2 * DAY), lastOutcome: "consolidated" } },
    watchmeState: { schemaVersion: 1, watching: true },
    watchmeObservations: [
      {
        v: 1,
        sessionId: "sess_00000000000000aa",
        specName: name,
        target: "cli",
        ts: NOW - DAY,
        turnCount: 4,
        joinConfidence: "exact",
        models: [
          {
            wire: "claude-sonnet-4",
            provider: "anthropic",
            turns: 3,
            usage: { in: 100, out: 40, cacheRead: 0, cacheCreate: 0 },
            costUsdMicros: 1500,
          },
          {
            wire: "local/experiment",
            provider: "local",
            turns: 1,
            usage: { in: 10, out: 5, cacheRead: 0, cacheCreate: 0 },
            unpriced: true,
          },
        ],
        toolStats: [
          { name: "Fetch", calls: 4, errors: 1 },
          { name: "Bash", calls: 2, errors: 0 },
        ],
        intentKeys: ["deploy-help", "status-check"],
        feedback: { up: 2, down: 1 },
        quality: { ratings: 3, meanRating: 0.8, judged: 2, meanJudge: 0.7 },
        factuality: { claims: 10, grounded: 8 },
      },
      {
        v: 1,
        sessionId: "sess_00000000000000bb",
        specName: name,
        target: "cli",
        ts: NOW - 2 * DAY,
        turnCount: 2,
        joinConfidence: "ordered",
        models: [],
        toolStats: [{ name: "Fetch", calls: 1, errors: 1 }],
        intentKeys: ["deploy-help"],
      },
      // Same session, re-analyzed after it grew: last writer wins, so the
      // fold must count ONE session, not two.
      {
        v: 1,
        sessionId: "sess_00000000000000bb",
        specName: name,
        target: "cli",
        ts: NOW - DAY,
        turnCount: 5,
        joinConfidence: "ordered",
        models: [],
        toolStats: [{ name: "Fetch", calls: 3, errors: 1 }],
        intentKeys: ["deploy-help"],
      },
    ],
    evalIndex: [
      {
        runId: "run_00000000000000aa",
        specName: name,
        datasetName: "exam",
        passRate: 0.75,
        meanScore: 0.8,
        sampleCount: 4,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
    ],
  });
  // A spec that actually PARSES — the toggle and the synthesize-apply paths
  // write through `applySpecEdits`, which re-validates, so a fixture spec
  // that fails validation would only ever exercise their refusal branch.
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    [
      `name: ${name}`,
      "target: cli",
      "agent:",
      "  model: anthropic/claude-sonnet-4",
      "  instructions: |",
      "    You are a fixture. Answer briefly.",
      "memory:",
      "  enabled: true",
      "  wiki:",
      "    enabled: true",
      "  dream:",
      "    every: 24h",
      "    mode: full",
      "    budget_usd: 2",
      ...(opts.learning === false
        ? []
        : [
            "learning:",
            "  domain: deploying things safely",
            "  curriculum: curriculum.md",
            "  exam:",
            "    dataset: eval/exam.jsonl",
            "    graders: eval/graders.yaml",
            "  study:",
            "    on_heartbeat: false",
          ]),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "curriculum.md"),
    "# Ladder\n- [x] read the release workflow\n- [ ] run a canary\n",
  );
  // The judge's own store — deliberately NOT the human feedback channel.
  writeFileSync(
    join(dir, ".crewhaus", "watchme", "judgments.jsonl"),
    `${JSON.stringify({
      v: 1,
      sessionId: "sess_00000000000000aa",
      turnNumber: 1,
      model: "anthropic/claude-sonnet-4",
      judgeModel: "anthropic/claude-haiku-4",
      score: 0.6,
      rationale: "answered, but skipped the canary step",
      ts: NOW - DAY,
    })}\n`,
  );
  return dir;
}

/** Write a spec-scoped wiki article the store's own way. */
function writeArticle(
  dir: string,
  spec: string,
  slug: string,
  fields: {
    title: string;
    body: string;
    version: number;
    tags?: string[];
    status?: string;
    verified?: boolean;
    updatedAt?: string;
  },
): void {
  const articles = join(dir, ".crewhaus", "wiki", spec, "articles");
  mkdirSync(articles, { recursive: true });
  const front = [
    "---",
    `slug: ${slug}`,
    `title: ${fields.title}`,
    `tags: [${(fields.tags ?? []).join(", ")}]`,
    "confidence: 0.5",
    `verified: ${fields.verified === true}`,
    `version: ${fields.version}`,
    "sources: []",
    `status: ${fields.status ?? "published"}`,
    `createdAt: ${iso(NOW - 5 * DAY)}`,
    `updatedAt: ${fields.updatedAt ?? iso(NOW - DAY)}`,
    "---",
    "",
    fields.body,
    "",
  ].join("\n");
  writeFileSync(join(articles, `${slug}.md`), front);
}

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------

describe("facts browser", () => {
  test("folds tombstones, TTL countdowns, provenance and masks the text", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/memory/facts/fabric`);
    expect(status).toBe(200);
    expect(body["present"]).toBe(true);
    expect(body["specs"]).toEqual(["fabric"]);
    expect(body["counts"]).toEqual({ live: 2, superseded: 1, expired: 1, total: 4 });

    const items = body["items"] as Array<Record<string, unknown>>;
    const live = items.find((i) => i["id"] === "mem_0000000000000001") as Record<string, unknown>;
    expect(live["status"]).toBe("live");
    expect(live["provenance"]).toEqual({
      sessionId: "sess_00000000000000aa",
      evidence: ["tu_1", "tu_2"],
    });

    // The supersede tombstone's RECORDED REASON is what makes a forget
    // auditable — folded onto the row it retired.
    const gone = items.find((i) => i["id"] === "mem_0000000000000002") as Record<string, unknown>;
    expect(gone["status"]).toBe("superseded");
    expect(gone["supersedeReason"]).toBe("restated after the release");
    expect(gone["supersededBy"]).toBe("mem_0000000000000001");

    const ttl = items.find((i) => i["id"] === "mem_0000000000000003") as Record<string, unknown>;
    expect(ttl["status"]).toBe("expired");
    expect(ttl["expiresInMs"]).toBe(-DAY);

    // Fact bodies are agent prose: value-shape masked, never served raw.
    const leaky = items.find((i) => i["id"] === "mem_0000000000000004") as Record<string, unknown>;
    expect(String(leaky["text"]).includes(FAKE_TOKEN)).toBe(false);
    expect(String(leaky["text"])).toContain("***");
  });

  test("a missing store is an empty state naming the verb, never an error", async () => {
    const t = boot();
    const id = await register(t, makeFixtureHarness(join(t.harnessesRoot, "bare"), {}));
    const { status, body } = await t.api(`/api/h/${id}/memory/facts/nothing`);
    expect(status).toBe(200);
    expect(body["present"]).toBe(false);
    expect(body["items"]).toEqual([]);
    expect(body["verb"]).toBe("crewhaus memory remember");
  });
});

describe("forget = supersede tombstone", () => {
  test("records the reason, keeps the original line, and needs a confirm", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const id = await register(t, dir);
    const file = join(dir, ".crewhaus", "memories", "fabric.jsonl");
    const before = readFileSync(file, "utf8");

    const noConfirm = await t.api(`/api/h/${id}/memory/facts/fabric/forget`, {
      method: "POST",
      body: JSON.stringify({ factId: "mem_0000000000000001", reason: "stale" }),
    });
    expect(noConfirm.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);

    // Text-matching forget is a CLI-only affordance: an id-shaped argument
    // is required so one typo can never retire an unbounded set of facts.
    const byText = await t.api(`/api/h/${id}/memory/facts/fabric/forget`, {
      method: "POST",
      body: JSON.stringify({ factId: "deploys", reason: "stale", confirm: true }),
    });
    expect(byText.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);

    const { status, body } = await t.api(`/api/h/${id}/memory/facts/fabric/forget`, {
      method: "POST",
      body: JSON.stringify({
        factId: "mem_0000000000000001",
        reason: "superseded by the new runbook",
        confirm: true,
      }),
    });
    expect(status).toBe(200);
    expect(body["ok"]).toBe(true);
    expect((body["forgotten"] as unknown[]).length).toBe(1);

    const after = readFileSync(file, "utf8");
    // NO HARD DELETE: the original entry line is still byte-for-byte there,
    // and a tombstone carrying the reason was APPENDED after it.
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('"tombstone":"superseded"');
    expect(after).toContain("superseded by the new runbook");

    const reread = await t.api(`/api/h/${id}/memory/facts/fabric`);
    const items = reread.body["items"] as Array<Record<string, unknown>>;
    expect(items.find((i) => i["id"] === "mem_0000000000000001")?.["status"]).toBe("superseded");
    expect((reread.body["counts"] as Record<string, number>)["total"]).toBe(4);
  });

  test("forgetting an absent id is a reported no-op, not a failure", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/memory/facts/fabric/forget`, {
      method: "POST",
      body: JSON.stringify({ factId: "mem_00000000000000ff", reason: "gone", confirm: true }),
    });
    expect(status).toBe(200);
    expect(body["forgotten"]).toEqual([]);
    expect(String(body["note"])).toContain("no-op");
  });
});

describe("sweep", () => {
  test("defaults to a dry run that writes nothing, then tombstones (never compacts)", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const id = await register(t, dir);
    const file = join(dir, ".crewhaus", "memories", "fabric.jsonl");
    const before = readFileSync(file, "utf8");

    const dry = await t.api(`/api/h/${id}/memory/facts/fabric/sweep`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(dry.status).toBe(200);
    expect(dry.body["dryRun"]).toBe(true);
    expect((dry.body["plan"] as unknown[]).length).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);

    const real = await t.api(`/api/h/${id}/memory/facts/fabric/sweep`, {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });
    expect(real.status).toBe(200);
    expect(real.body["swept"]).toBe(1);
    const after = readFileSync(file, "utf8");
    // Append-only: the sweep adds an `expired` tombstone and drops nothing.
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('"tombstone":"expired"');
  });
});

describe("recall playground", () => {
  test("ranks live facts and never touches the file", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const id = await register(t, dir);
    const file = join(dir, ".crewhaus", "memories", "fabric.jsonl");
    const before = statSync(file);

    const { status, body } = await t.api(`/api/h/${id}/memory/recall`, {
      method: "POST",
      body: JSON.stringify({ query: "release workflow", k: 3 }),
    });
    expect(status).toBe(200);
    const results = body["results"] as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.["id"]).toBe("mem_0000000000000001");
    expect(body["ranking"]).toBe("bm25");
    // A read is a read: same bytes, same mtime.
    const after = statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("schema migration", () => {
  test("dry-runs through the job queue and sweeps the fleet's meta stamps", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const id = await register(t, dir);
    writeFileSync(
      join(dir, ".crewhaus", "meta.json"),
      `${JSON.stringify({ memorySchemaVersion: 1 })}\n`,
    );
    const { status, body } = await t.api(`/api/h/${id}/memory/migrate`, {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    expect(status).toBe(200);
    expect((body["job"] as { argv: string[] }).argv).toEqual(["migrate", "memories", "--dry-run"]);
    const fleet = body["fleet"] as Array<Record<string, unknown>>;
    expect(fleet.find((h) => h["id"] === id)).toMatchObject({ schemaVersion: 1, behind: true });
  });

  test("the real backfill is typed-confirm", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const refused = await t.api(`/api/h/${id}/memory/migrate`, {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });
    expect(refused.status).toBe(409);
    const ok = await t.api(`/api/h/${id}/memory/migrate`, {
      method: "POST",
      body: JSON.stringify({ dryRun: false, confirmName: "fabric" }),
    });
    expect(ok.status).toBe(200);
    expect((ok.body["job"] as { argv: string[] }).argv).toEqual(["migrate", "memories"]);
  });
});

// ---------------------------------------------------------------------------
// continuity
// ---------------------------------------------------------------------------

describe("continuity panel", () => {
  test("reads the spec-scoped store: REQ ledger, proof ladder, goals", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const store = createContinuityStore({
      specName: "fabric",
      rootDir: join(dir, ".crewhaus", "state"),
      sessionRootDir: join(dir, ".crewhaus", "sessions"),
      now: () => new Date(NOW),
    });
    await store.writeFocus("ship the memory fabric");
    await store.appendRequirement({
      text: "never delete a memory",
      source: { sessionId: "sess_00000000000000aa", turn: 1 },
    });
    const plan = await store.createPlan({ title: "land M3", steps: ["read", "write"] });
    await store.setStepStatus(plan.id, 1, "claimed");
    await store.writeGoal({ title: "[gap] canary rollouts" });
    const id = await register(t, dir);

    const { status, body } = await t.api(`/api/h/${id}/memory/continuity`);
    expect(status).toBe(200);
    expect(body["layout"]).toBe("spec-scoped");
    const focus = body["focus"] as Record<string, unknown>;
    expect(focus["managed"]).toBe(true);
    expect(String(focus["body"])).toContain("ship the memory fabric");
    const reqs = focus["requirements"] as Array<Record<string, unknown>>;
    expect(reqs[0]).toMatchObject({ status: "open", sessionId: "sess_00000000000000aa", turn: 1 });
    const plans = body["plans"] as Array<Record<string, unknown>>;
    const steps = plans[0]?.["steps"] as Array<Record<string, unknown>>;
    expect(steps.map((s) => s["status"])).toEqual(["claimed", "open"]);
    expect((body["goals"] as unknown[]).length).toBe(1);
  });

  test("an older flat tree degrades to documents instead of an empty panel", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "flat"), {
      specName: "flat",
      focus: "just some notes\n",
      goals: "- id: g1\n  title: ship\n",
    });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/memory/continuity`);
    expect(status).toBe(200);
    expect(body["layout"]).toBe("flat");
    expect(String((body["focus"] as Record<string, unknown>)["body"])).toContain("just some notes");
    // An unmarked focus.md is a HUMAN's file — never parsed as managed state.
    expect((body["focus"] as Record<string, unknown>)["managed"]).toBe(false);
    expect(String(body["degraded"])).toContain("spec-scoped");
  });
});

describe("continuity trash", () => {
  test("clear fills the trash, the browser lists it, restore puts it back", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const store = createContinuityStore({
      specName: "fabric",
      rootDir: join(dir, ".crewhaus", "state"),
      sessionRootDir: join(dir, ".crewhaus", "sessions"),
      now: () => new Date(NOW),
    });
    await store.writeFocus("something worth not losing");
    const cleared = await store.clear("focus");
    const id = await register(t, dir);

    const listed = await t.api(`/api/h/${id}/memory/continuity/trash`);
    expect(listed.status).toBe(200);
    const snapshots = listed.body["snapshots"] as Array<Record<string, unknown>>;
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]?.["ts"]).toBe(cleared.ts);
    expect(snapshots[0]?.["restorable"]).toBe(true);
    expect(listed.body["purgeAfterDays"]).toBe(7);

    const restored = await t.api(`/api/h/${id}/memory/continuity/restore`, {
      method: "POST",
      body: JSON.stringify({ stamp: cleared.ts, confirm: true }),
    });
    expect(restored.status).toBe(200);
    expect(restored.body["ok"]).toBe(true);
    expect(readFileSync(join(dir, ".crewhaus", "state", "fabric", "focus.md"), "utf8")).toContain(
      "something worth not losing",
    );
  });

  test("restore needs a confirm and reports an unknown stamp as a state", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const noConfirm = await t.api(`/api/h/${id}/memory/continuity/restore`, {
      method: "POST",
      body: JSON.stringify({ stamp: "2026-08-01T00-00-00" }),
    });
    expect(noConfirm.status).toBe(400);

    const missing = await t.api(`/api/h/${id}/memory/continuity/restore`, {
      method: "POST",
      body: JSON.stringify({ stamp: "2026-08-01T00-00-00", confirm: true }),
    });
    expect(missing.status).toBe(200);
    expect(missing.body["code"]).toBe("no_such_snapshot");
  });
});

// ---------------------------------------------------------------------------
// learning, knowledge, dream
// ---------------------------------------------------------------------------

describe("learning panel", () => {
  test("reads the spec block, the curriculum ladder, the exam run and the gaps", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const store = createContinuityStore({
      specName: "fabric",
      rootDir: join(dir, ".crewhaus", "state"),
      sessionRootDir: join(dir, ".crewhaus", "sessions"),
      now: () => new Date(NOW),
    });
    await store.writeGoal({ title: "[gap] canary rollouts" });
    await store.writeGoal({ title: "ship the thing" });
    const id = await register(t, dir);

    const { status, body } = await t.api(`/api/h/${id}/memory/learning`);
    expect(status).toBe(200);
    expect(body["declared"]).toBe(true);
    expect(body["domain"]).toBe("deploying things safely");
    expect(body["curriculum"]).toMatchObject({ present: true, done: 1, total: 2 });
    expect(body["exam"]).toMatchObject({ dataset: "eval/exam.jsonl" });
    expect((body["exam"] as Record<string, unknown>)["lastRun"]).toMatchObject({ passRate: 0.75 });
    // `study.on_heartbeat: false` is declared; `on_dream` defaults ON.
    expect(body["study"]).toEqual({ onHeartbeat: false, onDream: true });
    const gaps = body["gaps"] as Record<string, unknown>;
    expect(gaps["total"]).toBe(1);
    expect((gaps["goals"] as Array<Record<string, unknown>>)[0]?.["title"]).toContain("[gap]");
  });

  test("a spec with no learning block says so instead of drawing an empty panel", async () => {
    const t = boot();
    const id = await register(t, makeFixtureHarness(join(t.harnessesRoot, "plain"), {}));
    const { body } = await t.api(`/api/h/${id}/memory/learning`);
    expect(body["present"]).toBe(false);
    expect(body["declared"]).toBe(false);
    expect(String(body["note"])).toContain("learning:");
  });
});

describe("knowledge sync", () => {
  test("reports the opt-in marker, the shared store and its manifest", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeFileSync(join(dir, ".crewhaus", "knowledge.json"), `${JSON.stringify({ share: true })}\n`);
    const shared = join(dir, ".crewhaus-shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      join(shared, "memories.jsonl"),
      `${JSON.stringify({ contentHash: "h1", text: "shared fact", tags: [] })}\n`,
    );
    writeFileSync(
      join(shared, "manifest.jsonl"),
      `${JSON.stringify({ harness: dir, contentHash: "h1", at: iso(NOW - DAY) })}\n`,
    );
    const id = await register(t, dir);

    const { status, body } = await t.api(`/api/h/${id}/memory/knowledge`);
    expect(status).toBe(200);
    expect(body["share"]).toBe(true);
    expect(body["present"]).toBe(true);
    expect((body["counts"] as Record<string, number>)["memories"]).toBe(1);
    expect(body["pushedByThisHarness"]).toBe(1);
  });

  test("a push previews what redaction would mask, and the real push is typed-confirm", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const dry = await t.api(`/api/h/${id}/memory/knowledge/sync`, {
      method: "POST",
      body: JSON.stringify({ direction: "push", dryRun: true }),
    });
    expect(dry.status).toBe(200);
    expect((dry.body["job"] as { argv: string[] }).argv).toEqual([
      "knowledge",
      "sync",
      "--push",
      "--dry-run",
    ]);
    const preview = dry.body["preview"] as Record<string, unknown>;
    const wouldRedact = preview["wouldRedact"] as Array<Record<string, unknown>>;
    expect(wouldRedact.length).toBe(1);
    expect(String(wouldRedact[0]?.["text"]).includes(FAKE_TOKEN)).toBe(false);

    const refused = await t.api(`/api/h/${id}/memory/knowledge/sync`, {
      method: "POST",
      body: JSON.stringify({ direction: "push", dryRun: false }),
    });
    expect(refused.status).toBe(409);

    // A pull cannot leak, so it needs no typed confirmation.
    const pull = await t.api(`/api/h/${id}/memory/knowledge/sync`, {
      method: "POST",
      body: JSON.stringify({ direction: "pull", dryRun: false }),
    });
    expect(pull.status).toBe(200);
    expect((pull.body["job"] as { argv: string[] }).argv).toEqual(["knowledge", "sync", "--pull"]);
    expect(pull.body["preview"]).toBe(null);
  });
});

describe("dream panel", () => {
  test("cadence from the spec, outcomes from state.json, and the overdue verdict", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/memory/dream/scaffold`);
    expect(status).toBe(200);
    expect(body["cadence"]).toBe("24h");
    expect(body["everyMs"]).toBe(DAY);
    expect(body["modelPhase"]).toBe(true);
    // lastRunAt is two days old against a 24h cadence.
    expect(body["overdue"]).toBe(true);
    const specs = body["specs"] as Array<Record<string, unknown>>;
    expect(specs[0]).toMatchObject({ specName: "fabric", lastOutcome: "consolidated" });
    // Print-only: the scaffold is text, and nothing was written.
    expect(body["cron"]).toBe("19 4 * * *");
    expect(String(body["workflow"])).toContain("crewhaus dream run");
    expect(body["workflowPath"]).toBe(".github/workflows/crewhaus-dream.yml");
  });
});

// ---------------------------------------------------------------------------
// wiki
// ---------------------------------------------------------------------------

describe("wiki editor", () => {
  test("creates, versions, and answers a stale write with the state to retry from", async () => {
    const t = boot();
    const dir = fabricHarness(t, "fabric", { learning: false });
    const id = await register(t, dir);

    const created = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy`, {
      method: "PUT",
      body: JSON.stringify({ body: "# Deploy\nrun the workflow\n", title: "How to deploy" }),
    });
    expect(created.status).toBe(200);
    expect(created.body["ok"]).toBe(true);
    expect(created.body["version"]).toBe(1);

    const updated = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy`, {
      method: "PUT",
      body: JSON.stringify({
        body: "# Deploy\nrun the workflow, then canary\n",
        expectedVersion: 1,
      }),
    });
    expect(updated.body["version"]).toBe(2);
    expect(String(updated.body["diff"])).toContain("+run the workflow, then canary");

    // The outgoing version is FROZEN, never overwritten.
    expect(
      readFileSync(
        join(dir, ".crewhaus", "wiki", "fabric", "versions", "how-to-deploy", "1.md"),
        "utf8",
      ),
    ).toContain("run the workflow");

    // Optimistic concurrency: a stale write is a STATE, carrying the current
    // version and the article to re-read — not a bare failure.
    const stale = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy`, {
      method: "PUT",
      body: JSON.stringify({ body: "# Deploy\nsomething else\n", expectedVersion: 1 }),
    });
    expect(stale.status).toBe(200);
    expect(stale.body["ok"]).toBe(false);
    expect(stale.body["code"]).toBe("stale_article_version");
    expect(stale.body["currentVersion"]).toBe(2);
    expect((stale.body["current"] as Record<string, unknown>)["version"]).toBe(2);

    // …and the retry with the version it reported succeeds.
    const retried = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy`, {
      method: "PUT",
      body: JSON.stringify({ body: "# Deploy\nsomething else\n", expectedVersion: 2 }),
    });
    expect(retried.body["ok"]).toBe(true);
    expect(retried.body["version"]).toBe(3);
  });

  test("the `## Sources` gate is enforced where the spec asks for it, badged local", async () => {
    const t = boot();
    // The fabric spec carries `learning:`, whose lowering requires sources.
    const id = await register(t, fabricHarness(t));
    const refused = await t.api(`/api/h/${id}/memory/wiki/sourceless`, {
      method: "PUT",
      body: JSON.stringify({ body: "# Claim\nno citation\n" }),
    });
    expect(refused.body["ok"]).toBe(false);
    expect(refused.body["code"]).toBe("missing_sources");
    expect(refused.body["backend"]).toBe("local");

    const accepted = await t.api(`/api/h/${id}/memory/wiki/sourceless`, {
      method: "PUT",
      body: JSON.stringify({ body: "# Claim\ncited\n\n## Sources\n- the runbook\n" }),
    });
    expect(accepted.body["ok"]).toBe(true);
  });

  test("versions, one version's diff, and the link graph", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "how-to-deploy", {
      title: "How to deploy",
      body: "# Deploy\nsee [[runbook]]\n",
      version: 2,
      tags: ["ops"],
    });
    writeArticle(dir, "fabric", "runbook", {
      title: "Runbook",
      body: "# Runbook\nback to [[how-to-deploy]]\n",
      version: 1,
      updatedAt: iso(NOW - 90 * DAY),
    });
    mkdirSync(join(dir, ".crewhaus", "wiki", "fabric", "versions", "how-to-deploy"), {
      recursive: true,
    });
    writeFileSync(
      join(dir, ".crewhaus", "wiki", "fabric", "versions", "how-to-deploy", "1.md"),
      "---\nslug: how-to-deploy\ntitle: How to deploy\nversion: 1\nstatus: published\n---\n\n# Deploy\nold text\n",
    );
    const id = await register(t, dir);

    const versions = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body["currentVersion"]).toBe(2);
    expect((versions.body["versions"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      version: 1,
      author: "operator",
    });

    const one = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/versions/1`);
    expect(one.body["present"]).toBe(true);
    expect(String(one.body["body"])).toContain("old text");
    expect(String(one.body["diff"])).toContain("+see [[runbook]]");

    // A non-integer version is a "nothing here", never a 404 or a 500.
    const bogus = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/versions/1.0.0`);
    expect(bogus.status).toBe(200);
    expect(bogus.body["present"]).toBe(false);

    const links = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/links`);
    const edges = links.body["links"] as Array<Record<string, unknown>>;
    expect(edges).toContainEqual(
      expect.objectContaining({ slug: "runbook", direction: "out", exists: true }),
    );
    expect(edges).toContainEqual(expect.objectContaining({ slug: "runbook", direction: "in" }));
    // index.json is a cache: it is absent here and the graph is rebuilt.
    expect(links.body["indexStale"]).toBe(true);
  });

  test("the REFLECT queue is stale-first and filters server-side", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "fresh", {
      title: "Fresh",
      body: "# Fresh\n",
      version: 1,
      tags: ["ops"],
      updatedAt: iso(NOW - DAY),
    });
    writeArticle(dir, "fabric", "ancient", {
      title: "Ancient",
      body: "# Ancient\n",
      version: 1,
      tags: ["ops", "legacy"],
      updatedAt: iso(NOW - 120 * DAY),
    });
    const id = await register(t, dir);

    const all = await t.api(`/api/h/${id}/memory/reflect`);
    expect(all.status).toBe(200);
    const articles = all.body["articles"] as Array<Record<string, unknown>>;
    expect(articles.map((a) => a["slug"])).toEqual(["ancient", "fresh"]);
    expect(articles[0]?.["stale"]).toBe(true);
    expect(all.body["stale"]).toBe(1);
    expect(all.body["thresholdSource"]).toBe("memory.dream.every");

    const filtered = await t.api(`/api/h/${id}/memory/reflect?tags=legacy`);
    expect((filtered.body["articles"] as unknown[]).length).toBe(1);
    const byStatus = await t.api(`/api/h/${id}/memory/reflect?status=archived`);
    expect(byStatus.body["articles"]).toEqual([]);
    expect(byStatus.body["total"]).toBe(2);
  });

  test("signals are metadata only and refuse a body carrying content", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "how-to-deploy", {
      title: "How to deploy",
      body: "# Deploy\nsteps\n",
      version: 3,
    });
    const id = await register(t, dir);

    const refused = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/signals`, {
      method: "POST",
      body: JSON.stringify({ verified: true, body: "sneaky rewrite" }),
    });
    expect(refused.status).toBe(400);

    const { status, body } = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/signals`, {
      method: "POST",
      body: JSON.stringify({ verified: true, confidence: 0.9 }),
    });
    expect(status).toBe(200);
    expect(body["verified"]).toBe(true);
    // Metadata only: no version bump, and the body is untouched.
    expect(body["version"]).toBe(3);
    expect(
      readFileSync(
        join(dir, ".crewhaus", "wiki", "fabric", "articles", "how-to-deploy.md"),
        "utf8",
      ),
    ).toContain("steps");
  });

  test("archive is reversible, keeps every version, and preserves `verified`", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "how-to-deploy", {
      title: "How to deploy",
      body: "# Deploy\nsteps\n",
      version: 1,
      verified: true,
    });
    const id = await register(t, dir);

    const noConfirm = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true }),
    });
    expect(noConfirm.status).toBe(400);

    const archived = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true, confirm: true }),
    });
    expect(archived.body["ok"]).toBe(true);
    const file = join(dir, ".crewhaus", "wiki", "fabric", "articles", "how-to-deploy.md");
    expect(readFileSync(file, "utf8")).toContain("status: archived");
    // A content write resets `verified`; archiving must not un-verify.
    expect(readFileSync(file, "utf8")).toContain("verified: true");
    expect(
      readFileSync(
        join(dir, ".crewhaus", "wiki", "fabric", "versions", "how-to-deploy", "1.md"),
        "utf8",
      ),
    ).toContain("steps");

    const back = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: false, confirm: true }),
    });
    expect(back.body["ok"]).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("status: published");
  });

  test("archiving never persists the mask over what it hid", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "leaky", {
      title: "Leaky",
      body: `# Leaky\nthe deploy key is ${FAKE_TOKEN}\n`,
      version: 1,
    });
    const id = await register(t, dir);
    const file = join(dir, ".crewhaus", "wiki", "fabric", "articles", "leaky.md");

    // Served masked…
    const listed = await t.api(`/api/h/${id}/memory/reflect`);
    const rows = listed.body["articles"] as Array<Record<string, unknown>>;
    expect(rows.some((r) => r["slug"] === "leaky")).toBe(true);
    const version = await t.api(`/api/h/${id}/memory/wiki/leaky/versions`);
    expect(JSON.stringify(version.body).includes(FAKE_TOKEN)).toBe(false);

    // …but the archive round-trip writes the ORIGINAL bytes back. Persisting
    // a masked span would replace what it hid — data loss wearing safety's
    // clothes.
    const archived = await t.api(`/api/h/${id}/memory/wiki/leaky/archive`, {
      method: "POST",
      body: JSON.stringify({ archived: true, confirm: true }),
    });
    expect(archived.body["ok"]).toBe(true);
    const after = readFileSync(file, "utf8");
    expect(after).toContain(FAKE_TOKEN);
    expect(after).toContain("status: archived");
  });

  test("a frontmatter-less article renders as a document instead of blanking the wiki", async () => {
    const t = boot();
    const dir = makeFixtureHarness(join(t.harnessesRoot, "legacy"), {
      specName: "legacy",
      wikiIndex: { "how-to-deploy": { title: "How to deploy" } },
      wikiArticles: { "how-to-deploy": "# Deploy\nhand-written, no frontmatter\n" },
    });
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/memory/reflect`);
    const articles = body["articles"] as Array<Record<string, unknown>>;
    expect(articles.length).toBe(1);
    expect(articles[0]).toMatchObject({ slug: "how-to-deploy", malformed: true });
    expect(body["layout"]).toBe("flat");
  });
});

// ---------------------------------------------------------------------------
// watchme
// ---------------------------------------------------------------------------

describe("watchme analytics", () => {
  test("keeps unpriced cost, judge verdicts and human feedback in separate buckets", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/memory/watchme/analytics`);
    expect(status).toBe(200);
    expect(body["watching"]).toBe(true);
    // Two DISTINCT sessions: the re-analyzed digest supersedes, never doubles.
    expect(body["sessions"]).toBe(2);
    expect((body["turns"] as Record<string, number>)["total"]).toBe(9);

    const models = body["models"] as Array<Record<string, unknown>>;
    expect(models.map((m) => m["wire"])).toEqual(["claude-sonnet-4"]);
    expect(body["costUsdMicros"]).toBe(1500);
    const unpriced = body["unpriced"] as Record<string, unknown>;
    expect((unpriced["models"] as Array<Record<string, unknown>>)[0]?.["wire"]).toBe(
      "local/experiment",
    );
    expect(unpriced["turns"]).toBe(1);
    expect(String(unpriced["note"])).toContain("UNKNOWN");

    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "Fetch", calls: 7, errors: 2 });
    expect(tools[0]?.["errorRate"]).toBeCloseTo(2 / 7, 5);

    // Judgments and human feedback are separate stores, rendered separately.
    expect(body["judgments"]).toMatchObject({ count: 1, meanScore: 0.6 });
    expect(body["observedFeedback"]).toMatchObject({ up: 2, down: 1 });
    expect(body["asOf"]).toBe(iso(NOW - DAY));
  });
});

describe("watchme reports + intents", () => {
  test("browses reports newest-first and serves one masked", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    for (const stamp of ["20260801T000000Z", "20260802T000000Z"]) {
      const reportDir = join(dir, ".crewhaus", "watchme", "reports", stamp);
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        join(reportDir, "report.md"),
        `# Watchme report\n\n4 sessions analyzed; the deploy key ${FAKE_TOKEN} appeared in a tool result.\n`,
      );
      writeFileSync(join(reportDir, "report.json"), `${JSON.stringify({ sessions: 4 })}\n`);
    }
    const id = await register(t, dir);

    const index = await t.api(`/api/h/${id}/memory/watchme/reports`);
    const reports = index.body["reports"] as Array<Record<string, unknown>>;
    expect(reports.map((r) => r["stamp"])).toEqual(["20260802T000000Z", "20260801T000000Z"]);
    expect(String(reports[0]?.["summary"])).toContain("4 sessions analyzed");

    const one = await t.api(`/api/h/${id}/memory/watchme/reports/20260802T000000Z`);
    expect(one.body["present"]).toBe(true);
    // A report is prose — masked on the way out, not just key-redacted.
    expect(String(one.body["body"]).includes(FAKE_TOKEN)).toBe(false);
    expect(one.body["files"]).toEqual(["report.json", "report.md"]);

    const missing = await t.api(`/api/h/${id}/memory/watchme/reports/20260101T000000Z`);
    expect(missing.status).toBe(200);
    expect(missing.body["present"]).toBe(false);
  });

  test("ranks intent clusters with their representative sessions", async () => {
    const t = boot();
    const id = await register(t, fabricHarness(t));
    const { body } = await t.api(`/api/h/${id}/memory/watchme/intents`);
    const intents = body["intents"] as Array<Record<string, unknown>>;
    expect(intents[0]).toMatchObject({ cluster: "deploy-help", count: 2 });
    expect(intents[0]?.["sessions"]).toEqual(["sess_00000000000000aa", "sess_00000000000000bb"]);
  });
});

describe("watchme toggle", () => {
  test("proposes without a typed confirm and never writes state.json", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const id = await register(t, dir);
    const specBefore = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    const stateBefore = readFileSync(join(dir, ".crewhaus", "watchme", "state.json"), "utf8");

    const proposed = await t.api(`/api/h/${id}/memory/watchme/toggle`, {
      method: "POST",
      body: JSON.stringify({ watching: false, confirm: true }),
    });
    expect(proposed.status).toBe(200);
    expect(proposed.body["applied"]).toBe(false);
    expect(proposed.body["code"]).toBe("needs_typed_confirm");
    expect((proposed.body["diff"] as unknown[]).length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(specBefore);

    const applied = await t.api(`/api/h/${id}/memory/watchme/toggle`, {
      method: "POST",
      body: JSON.stringify({ watching: false, confirm: true, confirmName: "fabric" }),
    });
    expect(applied.body["applied"]).toBe(true);
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toContain("watchme:");
    // The runtime's own state file is owned by `crewhaus watchme start/stop`.
    expect(readFileSync(join(dir, ".crewhaus", "watchme", "state.json"), "utf8")).toBe(stateBefore);
  });
});

describe("watchme synthesize", () => {
  test("renders a proposal as classified edits and applies nothing on its own", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    const synth = join(dir, ".crewhaus", "watchme", "synthesized");
    mkdirSync(synth, { recursive: true });
    writeFileSync(
      join(synth, "20260803T000000Z.yaml"),
      [
        "name: fabric-mimic",
        "target: cli",
        "agent:",
        // The model roster is human-owned; instructions are auto-tunable —
        // one proposal carrying both tiers is what the review UI must split.
        "  model: anthropic/claude-opus-4",
        "  instructions: |",
        "    You are a fixture. Answer briefly, and always mention the canary step.",
        "",
      ].join("\n"),
    );
    const id = await register(t, dir);
    const specBefore = readFileSync(join(dir, "crewhaus.yaml"), "utf8");

    const listed = await t.api(`/api/h/${id}/memory/watchme/synthesized`);
    expect(listed.status).toBe(200);
    expect(listed.body["advisory"]).toBe(true);
    const proposals = listed.body["proposals"] as Array<Record<string, unknown>>;
    expect(proposals.length).toBe(1);
    const edits = proposals[0]?.["edits"] as Array<Record<string, unknown>>;
    const tierOf = (path: string): unknown => edits.find((e) => e["path"] === path)?.["tier"];
    // The split the review UI shows: what applying would actually cost.
    expect(tierOf("agent.instructions")).toBe("auto-tunable");
    expect(tierOf("agent.model")).toBe("human-owned");
    // Reading is not applying.
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(specBefore);

    const nothing = await t.api(`/api/h/${id}/memory/watchme/synthesized/20260803T000000Z/apply`, {
      method: "POST",
      body: JSON.stringify({ edits: [], confirm: true }),
    });
    expect(nothing.status).toBe(200);
    expect(nothing.body["code"]).toBe("no_edits_selected");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(specBefore);

    // A human-owned path picked WITHOUT the typed confirmation comes back as
    // a proposal — the diff it would write, and no write.
    const proposedOnly = await t.api(
      `/api/h/${id}/memory/watchme/synthesized/20260803T000000Z/apply`,
      { method: "POST", body: JSON.stringify({ edits: ["agent.model"], confirm: true }) },
    );
    expect(proposedOnly.body["applied"]).toBe(false);
    expect(proposedOnly.body["code"]).toBe("needs_typed_confirm");
    expect(readFileSync(join(dir, "crewhaus.yaml"), "utf8")).toBe(specBefore);

    // An auto-tunable path needs only the confirm already given.
    const applied = await t.api(`/api/h/${id}/memory/watchme/synthesized/20260803T000000Z/apply`, {
      method: "POST",
      body: JSON.stringify({ edits: ["agent.instructions"], confirm: true }),
    });
    expect(applied.body["applied"]).toBe(true);
    expect(applied.body["tier"]).toBe("auto-tunable");
    const afterApply = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    expect(afterApply).toContain("canary step");
    // …and applying one edit never drags the human-owned one along.
    expect(afterApply).toContain("model: anthropic/claude-sonnet-4");
  });

  test("publish previews the articles it would upsert before it can run", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    writeArticle(dir, "fabric", "watchme-intents", {
      title: "Watchme intents",
      body: "# Intents\n",
      version: 1,
    });
    const id = await register(t, dir);

    const dry = await t.api(`/api/h/${id}/memory/watchme/publish`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(dry.status).toBe(200);
    expect(dry.body["dryRun"]).toBe(true);
    expect(dry.body["targets"]).toEqual([
      { slug: "watchme-intents", action: "update" },
      { slug: "watchme-model-fit", action: "create" },
      { slug: "watchme-pitfalls", action: "create" },
    ]);
    expect((dry.body["job"] as { argv: string[] }).argv).toEqual([
      "watchme",
      "publish",
      "--dry-run",
    ]);

    const refused = await t.api(`/api/h/${id}/memory/watchme/publish`, {
      method: "POST",
      body: JSON.stringify({ dryRun: false }),
    });
    expect(refused.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// containment + the whole-area sweep
// ---------------------------------------------------------------------------

describe("the memory fabric as a whole", () => {
  test("every route answers, and a symlinked-out article is skipped per file", async () => {
    const t = boot();
    const dir = fabricHarness(t);
    // A planted symlink inside the wiki: the NAME lists, the read must not
    // follow it out of the harness.
    const articles = join(dir, ".crewhaus", "wiki", "fabric", "articles");
    mkdirSync(articles, { recursive: true });
    const outside = join(t.workspace, "outside.md");
    writeFileSync(outside, "---\nslug: escaped\ntitle: Escaped\nversion: 1\n---\n\nsecret\n");
    symlinkSync(outside, join(articles, "escaped.md"));
    writeArticle(dir, "fabric", "kept", { title: "Kept", body: "# Kept\n", version: 1 });
    const id = await register(t, dir);

    const reflect = await t.api(`/api/h/${id}/memory/reflect`);
    const slugs = (reflect.body["articles"] as Array<Record<string, unknown>>).map(
      (a) => a["slug"],
    );
    expect(slugs).toEqual(["kept"]);

    // The whole area, driven: no 404 (drift), no 500 (a guard threw), no 501.
    const reads = [
      "memory/facts/fabric",
      "memory/continuity",
      "memory/continuity/trash",
      "memory/learning",
      "memory/knowledge",
      "memory/dream/scaffold",
      "memory/wiki/kept/versions",
      "memory/wiki/kept/versions/1",
      "memory/wiki/kept/links",
      "memory/reflect",
      "memory/watchme/analytics",
      "memory/watchme/reports",
      "memory/watchme/reports/20260803T000000Z",
      "memory/watchme/intents",
      "memory/watchme/synthesized",
    ];
    for (const path of reads) {
      const { status, body } = await t.api(`/api/h/${id}/${path}`);
      expect(`${path}:${status}`).toBe(`${path}:200`);
      expect(`${path}:${typeof body["present"]}`).toBe(`${path}:boolean`);
      expect(`${path}:${"verb" in body}`).toBe(`${path}:true`);
    }
  });
});
