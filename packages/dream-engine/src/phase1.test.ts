/**
 * Phase-1 determinism (design §6.2): same inputs → same counts, and a
 * second run against the mutated stores is a no-op (zero new mutations).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContinuityStore, moveToTrash } from "@crewhaus/continuity-store";
import { createMemoryStore } from "@crewhaus/memory-store";
import { createWikiStore } from "@crewhaus/wiki-store";
import {
  STALE_FACT_AFTER_MS,
  STALE_WIKI_UNVERIFIED_AFTER_MS,
  normalizeFactText,
  runDreamPhase1,
} from "./phase1";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-13T19:04:12.000Z");
const fixedNow = (): Date => NOW;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

let tmp: string; // the .crewhaus dir

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dream-phase1-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SESS_A = "sess_00000000000000aa";
const SESS_B = "sess_00000000000000bb";

function writeSessionLog(id: string, events: ReadonlyArray<Record<string, unknown>>): void {
  const dir = join(tmp, "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e, i) =>
    JSON.stringify({ ts: NOW.getTime() - 1000 + i, version: 1, ...e }),
  );
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function seedSessions(): void {
  writeSessionLog(SESS_A, [
    { kind: "user_message", payload: { content: "how do csv exports work?" } },
    {
      kind: "tool_use",
      payload: { id: "tu_aaaaaaaa", name: "wiki_get", input: { slug: "csv-exports" } },
    },
    {
      kind: "tool_result",
      payload: { toolUseId: "tu_aaaaaaaa", content: "semicolons in EU locales", isError: false },
    },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "EU locales use semicolons." }] },
    },
  ]);
  writeSessionLog(SESS_B, [
    { kind: "user_message", payload: { content: "deploy time?" } },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "The deploy runs at 9am." }] },
    },
  ]);
}

/** Build the full deterministic fixture; returns the current-clock stores. */
async function seedFixture() {
  seedSessions();

  // Facts: one expired (TTL swept), one stale (>90d), a duplicate pair
  // corroborated across two sessions, and one fresh unique fact.
  const memoriesDir = join(tmp, "memories");
  const past = createMemoryStore({
    specName: "bot",
    rootDir: memoriesDir,
    now: () => daysAgo(100),
  });
  await past.remember("ancient config note", ["cfg"]); // stale (>90d)
  await past.remember("short-lived token", [], { ttlMs: 5 * DAY }); // expired long ago
  const recent = createMemoryStore({
    specName: "bot",
    rootDir: memoriesDir,
    now: () => daysAgo(5),
  });
  await recent.remember("The deploy runs at 9am", [], {
    provenance: { sessionId: SESS_A },
  });
  const memoryStore = createMemoryStore({ specName: "bot", rootDir: memoriesDir, now: fixedNow });
  const fresh = createMemoryStore({
    specName: "bot",
    rootDir: memoriesDir,
    now: () => daysAgo(1),
  });
  await fresh.remember("the deploy runs at 9am!", [], {
    provenance: { sessionId: SESS_B },
  }); // near-duplicate, newer — the keeper
  await fresh.remember("support rota rotates on Mondays");

  // Wiki: one unverified article stale (>30d), one fresh.
  const wikiDir = join(tmp, "wiki");
  const oldWiki = createWikiStore({ specName: "bot", rootDir: wikiDir, now: () => daysAgo(40) });
  await oldWiki.write({ slug: "csv-exports", title: "CSV exports", body: "semicolons in EU" });
  const newWiki = createWikiStore({ specName: "bot", rootDir: wikiDir, now: () => daysAgo(2) });
  await newWiki.write({ slug: "deploys", title: "Deploys", body: "9am daily" });
  const wikiStore = createWikiStore({ specName: "bot", rootDir: wikiDir, now: fixedNow });

  // Continuity: a plan with one proven step (proof against SESS_A's log)
  // and one open step.
  const continuityStore = createContinuityStore({
    specName: "bot",
    rootDir: join(tmp, "state"),
    sessionRootDir: join(tmp, "sessions"),
    now: fixedNow,
  });
  const plan = await continuityStore.createPlan({
    title: "Ship the CSV fix",
    steps: ["verify the delimiter behavior", "write the regression test"],
  });
  await continuityStore.proveStep(plan.id, 1, [{ toolUseId: "tu_aaaaaaaa", sessionId: SESS_A }]);
  // Drop the pins proveStep just wrote so the dream's pin refresh has work.
  rmSync(join(tmp, "retention.json"), { force: true });

  // Trash: one snapshot past the 7-day window, one inside it.
  const oldFile = join(tmp, "state", "bot", "junk-old.md");
  writeFileSync(oldFile, "old");
  await moveToTrash([oldFile], tmp, { now: () => daysAgo(8) });
  const newFile = join(tmp, "state", "bot", "junk-new.md");
  writeFileSync(newFile, "new");
  await moveToTrash([newFile], tmp, { now: () => daysAgo(1) });

  return { memoryStore, wikiStore, continuityStore };
}

const EXPECTED_FIRST_RUN = {
  sessionsIndexed: 2,
  factsBefore: 4, // expired one already swept out of the live set
  factsAfter: 3,
  factsSwept: 1,
  factsSuperseded: 1,
  factsStale: 1,
  wikiStale: 1,
  proofsChecked: 1,
  proofsUnverifiable: 0,
  sessionsPinned: 1,
  openPlans: 1,
  trashPurged: 1,
};

describe("runDreamPhase1 — determinism", () => {
  test("first run produces the exact expected counts", async () => {
    const stores = await seedFixture();
    const report = await runDreamPhase1({
      specName: "bot",
      crewhausDir: tmp,
      ...stores,
      now: fixedNow,
    });
    expect(report.counts).toEqual(EXPECTED_FIRST_RUN);
    // No step failures leaked into the findings.
    expect(report.findings.filter((f) => f.startsWith("(step"))).toEqual([]);
    // The corroborated duplicate surfaced as a promotion candidate.
    expect(report.findings.some((f) => f.startsWith("promotion candidate:"))).toBe(true);
    // Handoff was refreshed deterministically from the open plan.
    expect(existsSync(join(tmp, "state", "bot", "handoff.md"))).toBe(true);
    // The proof's session got pinned before its transcript can be TTL'd.
    const retention = JSON.parse(readFileSync(join(tmp, "retention.json"), "utf8")) as {
      pins?: string[];
    };
    expect(retention.pins).toContain(SESS_A);
  });

  test("same inputs in a fresh dir → same counts (determinism)", async () => {
    const stores1 = await seedFixture();
    const report1 = await runDreamPhase1({
      specName: "bot",
      crewhausDir: tmp,
      ...stores1,
      now: fixedNow,
    });
    const tmp2 = mkdtempSync(join(tmpdir(), "dream-phase1-b-"));
    const keep = tmp;
    try {
      tmp = tmp2;
      const stores2 = await seedFixture();
      const report2 = await runDreamPhase1({
        specName: "bot",
        crewhausDir: tmp2,
        ...stores2,
        now: fixedNow,
      });
      expect(report2.counts).toEqual(report1.counts);
      // Entry ids are random per store; the finding TEXTS must match once
      // ids are normalized out.
      const anonymize = (lines: readonly string[]): string[] =>
        lines.map((l) => l.replace(/mem_[0-9a-f]{16}/g, "mem_<id>"));
      expect(anonymize(report2.findings)).toEqual(anonymize(report1.findings));
    } finally {
      tmp = keep;
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  test("second run against the mutated stores is a no-op (zero new mutations)", async () => {
    const stores = await seedFixture();
    await runDreamPhase1({ specName: "bot", crewhausDir: tmp, ...stores, now: fixedNow });
    const second = await runDreamPhase1({
      specName: "bot",
      crewhausDir: tmp,
      ...stores,
      now: fixedNow,
    });
    expect(second.counts).toEqual({
      ...EXPECTED_FIRST_RUN,
      sessionsIndexed: 0, // index entries newer than the logs
      factsBefore: 3, // dedupe already collapsed the pair
      factsSuperseded: 0,
      factsSwept: 0, // sweep is idempotent
      sessionsPinned: 0, // pins already present
      trashPurged: 0, // the old snapshot is gone
    });
  });

  test("runs clean against an empty .crewhaus dir (all zeros)", async () => {
    const report = await runDreamPhase1({ specName: "bot", crewhausDir: tmp, now: fixedNow });
    expect(Object.values(report.counts).every((v) => v === 0)).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

describe("phase-1 staleness constants + normalization", () => {
  test("exported windows match the design (§6.2: 90d facts, 30d wiki)", () => {
    expect(STALE_FACT_AFTER_MS).toBe(90 * DAY);
    expect(STALE_WIKI_UNVERIFIED_AFTER_MS).toBe(30 * DAY);
  });

  test("normalizeFactText is case/whitespace/punctuation-insensitive", () => {
    expect(normalizeFactText("The deploy runs at 9am!")).toBe(
      normalizeFactText("  the DEPLOY runs at 9am  "),
    );
    expect(normalizeFactText("a")).not.toBe(normalizeFactText("b"));
  });

  test("a verified wiki article is never flagged stale", async () => {
    const wikiDir = join(tmp, "wiki");
    const oldWiki = createWikiStore({ specName: "bot", rootDir: wikiDir, now: () => daysAgo(60) });
    await oldWiki.write({ slug: "settled", title: "Settled", body: "checked" });
    await oldWiki.setSignals("settled", { verified: true });
    const wikiStore = createWikiStore({ specName: "bot", rootDir: wikiDir, now: fixedNow });
    const report = await runDreamPhase1({
      specName: "bot",
      crewhausDir: tmp,
      wikiStore,
      now: fixedNow,
    });
    expect(report.counts.wikiStale).toBe(0);
  });
});
