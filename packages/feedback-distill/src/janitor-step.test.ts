/**
 * D39 — the daemon-side auto-distill janitor step: opt-in gating, the
 * ≥N-unprocessed threshold, watermark idempotency (one distill per batch of
 * ratings — a second tick with no new ratings must be a no-op), registration
 * ordering, and the unattended-redaction guarantee.
 *
 * Every filesystem artifact is sandboxed into a mkdtemp root; the corpus is
 * injected through the `collect` seam except in the one test that exercises
 * the real on-disk collector.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { collectFeedbackFromDisk } from "./collect";
import type { FeedbackRecord, SessionTurn } from "./feedback";
import {
  DISTILL_STEP_NAME,
  type DistillRegistry,
  NO_DAEMON_DISTILL_ENV,
  createDistillJanitorStep,
} from "./janitor-step";
import { readReviewQueue } from "./review-queue";
import { DISTILL_STATE_RELPATH } from "./watermark";

const ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "feedback-distill-"));
  ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of ROOTS) rmSync(d, { recursive: true, force: true });
});

const SESSION = "sess_00000000000000aa";

function turn(n: number): SessionTurn {
  return {
    sessionId: SESSION,
    turnNumber: n,
    input: `question number ${n} about the refund policy`,
    output: `answer number ${n}`,
    toolNames: [],
  };
}

function rating(n: number, ts: string): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `fb_${n}`,
    sessionId: SESSION,
    turnNumber: n,
    modality: "binary",
    rating: { thumbs: "up" },
    source: "channel",
    ts,
  };
}

/** In-memory registry implementing the structural subset the step needs. */
function fakeRegistry(): DistillRegistry & {
  readonly puts: Array<{ name: string; version: string; samples: Sample[] }>;
  fail: boolean;
} {
  const puts: Array<{ name: string; version: string; samples: Sample[] }> = [];
  return {
    puts,
    fail: false,
    async list(name: string) {
      return puts.filter((p) => p.name === name).map((p) => p.version);
    },
    async put(input) {
      if (this.fail) throw new Error("registry offline");
      puts.push({
        name: input.name,
        version: input.version,
        samples: [...input.splits.train, ...input.splits.dev, ...(input.splits.test ?? [])],
      });
      return { name: input.name, version: input.version };
    },
  };
}

const CORPUS = {
  turns: [turn(1), turn(2), turn(3), turn(4), turn(5), turn(6)],
  records: [
    rating(1, "2026-07-01T00:00:01.000Z"),
    rating(2, "2026-07-01T00:00:02.000Z"),
    rating(3, "2026-07-01T00:00:03.000Z"),
    rating(4, "2026-07-01T00:00:04.000Z"),
    rating(5, "2026-07-01T00:00:05.000Z"),
  ],
};

describe("createDistillJanitorStep — opt-in gating", () => {
  const registry = fakeRegistry();
  test("returns null without a feedback block", () => {
    expect(
      createDistillJanitorStep({ specName: "helper", feedback: undefined, registry }),
    ).toBeNull();
  });
  test("returns null when autoDistill is not enabled", () => {
    expect(createDistillJanitorStep({ specName: "helper", feedback: {}, registry })).toBeNull();
  });
  test("returns null when the block is disabled outright", () => {
    expect(
      createDistillJanitorStep({
        specName: "helper",
        feedback: { enabled: false, autoDistill: true },
        registry,
      }),
    ).toBeNull();
  });
  test("returns a named step when opted in", () => {
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
    });
    expect(step?.name).toBe(DISTILL_STEP_NAME);
  });
});

describe("createDistillJanitorStep — threshold + watermark", () => {
  function build(root: string, registry: DistillRegistry, corpus = CORPUS, env = {}) {
    return createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env,
      collect: () => corpus,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });
  }

  test("skips below the ≥5 threshold and writes no watermark", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = build(root, registry, {
      turns: CORPUS.turns,
      records: CORPUS.records.slice(0, 4),
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("skipped");
    expect(out.detail).toContain("4 unprocessed");
    expect(registry.puts).toHaveLength(0);
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(false);
  });

  test("distills at the threshold, registers v1, and advances the watermark", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = build(root, registry);
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
    expect(registry.puts[0]?.name).toBe("helper-ratings");
    expect(registry.puts[0]?.version).toBe("v1");
    expect(registry.puts[0]?.samples.length).toBe(5);
    expect(out.detail).toContain("registry:helper-ratings@v1");

    const state = JSON.parse(readFileSync(join(root, DISTILL_STATE_RELPATH), "utf-8"));
    expect(state.schemaVersion).toBe(1);
    expect(state.lastProcessedTs).toBe("2026-07-01T00:00:05.000Z");
    expect(state.lastRegistered.version).toBe("v1");
  });

  test("is IDEMPOTENT: a second tick with no new ratings registers nothing", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = build(root, registry) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;
    expect((await step.run()).status).toBe("ok");
    const second = await step.run();
    expect(second.status).toBe("skipped");
    expect(second.detail).toContain("0 unprocessed");
    expect(registry.puts).toHaveLength(1);
  });

  test("a fresh batch of ratings re-triggers and bumps to v2", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    expect(
      (
        await (
          build(root, registry) as NonNullable<ReturnType<typeof createDistillJanitorStep>>
        ).run()
      ).status,
    ).toBe("ok");
    const more = {
      turns: CORPUS.turns,
      records: [
        ...CORPUS.records,
        rating(6, "2026-07-03T00:00:01.000Z"),
        rating(6, "2026-07-03T00:00:02.000Z"),
        rating(6, "2026-07-03T00:00:03.000Z"),
        rating(6, "2026-07-03T00:00:04.000Z"),
        rating(6, "2026-07-03T00:00:05.000Z"),
      ],
    };
    const out = await (
      build(root, registry, more) as NonNullable<ReturnType<typeof createDistillJanitorStep>>
    ).run();
    expect(out.status).toBe("ok");
    expect(registry.puts.map((p) => p.version)).toEqual(["v1", "v2"]);
  });

  test("a failed registration leaves the watermark untouched so the next tick retries", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    registry.fail = true;
    const step = build(root, registry) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;
    await expect(step.run()).rejects.toThrow("registry offline");
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(false);
    registry.fail = false;
    expect((await step.run()).status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
  });

  test("unmatchable ratings advance the watermark instead of re-triggering forever", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const out = await (
      build(root, registry, { turns: [], records: CORPUS.records }) as NonNullable<
        ReturnType<typeof createDistillJanitorStep>
      >
    ).run();
    expect(out.status).toBe("ok");
    expect(out.count).toBe(0);
    expect(registry.puts).toHaveLength(0);
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(true);
  });

  test(`${NO_DAEMON_DISTILL_ENV}=0 disables the tick`, async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = build(root, registry, CORPUS, { [NO_DAEMON_DISTILL_ENV]: "0" });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("skipped");
    expect(registry.puts).toHaveLength(0);
  });

  test("honours the CREWHAUS_AUTODISTILL_THRESHOLD override", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = build(
      root,
      registry,
      { turns: CORPUS.turns, records: CORPUS.records.slice(0, 2) },
      { CREWHAUS_AUTODISTILL_THRESHOLD: "2" },
    );
    expect((await (step as NonNullable<typeof step>).run()).status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
  });

  test("a registry-unsafe spec name skips cleanly", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "not a slug!",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
      collect: () => CORPUS,
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("skipped");
    expect(out.detail).toContain("registry dataset name");
  });
});

describe("createDistillJanitorStep — unattended redaction + real disk collector", () => {
  test("reads both sinks off disk and redacts before anything is registered", async () => {
    const root = newRoot();
    const sessionsDir = join(root, ".crewhaus", "sessions");
    const feedbackDir = join(root, ".crewhaus", "feedback");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(feedbackDir, { recursive: true });

    // One transcript with 5 rated turns; the answers carry an email address.
    const lines: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      lines.push(JSON.stringify({ kind: "user_message", payload: { content: `question ${n}` } }));
      lines.push(
        JSON.stringify({
          kind: "assistant_message",
          payload: {
            content: [{ type: "text", text: `reply ${n}; contact ada@example.com for more` }],
          },
        }),
      );
    }
    writeFileSync(join(sessionsDir, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
    // The web-UI/gateway sink supplies the ratings.
    writeFileSync(
      join(feedbackDir, "ui.jsonl"),
      `${CORPUS.records.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );

    const collected = collectFeedbackFromDisk(root, { env: {} });
    expect(collected.sessionCount).toBe(1);
    expect(collected.turns.length).toBe(5);
    expect(collected.records.length).toBe(5);

    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("ok");
    const golds = registry.puts[0]?.samples.map((s) => s.expected_output ?? "") ?? [];
    expect(golds.length).toBe(5);
    expect(golds.join("\n")).not.toContain("ada@example.com");
    expect(golds.join("\n")).toContain("[REDACTED:");
  });
});

// ---------------------------------------------------------------------------
// Session-root resolution. These are the cases where reading the WRONG root
// used to look exactly like "these ratings are unmatchable" — and the
// watermark then marked every submitted rating processed forever.
// ---------------------------------------------------------------------------

/** Write a 5-turn transcript for SESSION under `sessionsDir`. */
function writeTranscript(sessionsDir: string, sessionId = SESSION): void {
  mkdirSync(sessionsDir, { recursive: true });
  const lines: string[] = [];
  for (let n = 1; n <= 5; n += 1) {
    lines.push(JSON.stringify({ kind: "user_message", payload: { content: `question ${n}` } }));
    lines.push(
      JSON.stringify({
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: `reply ${n}` }] },
      }),
    );
  }
  writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

/** Write the 5 CORPUS ratings into `<root>/.crewhaus/feedback/ui.jsonl`. */
function writeRatings(root: string): void {
  const feedbackDir = join(root, ".crewhaus", "feedback");
  mkdirSync(feedbackDir, { recursive: true });
  writeFileSync(
    join(feedbackDir, "ui.jsonl"),
    `${CORPUS.records.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

describe("createDistillJanitorStep — session-root resolution", () => {
  test("tenantsRootDir: a MANAGED daemon's per-tenant transcripts distill", async () => {
    // The managed daemon runs every turn inside withTenant(), so transcripts
    // land in <TENANTS_ROOT>/<tenantId>/sessions — never <cwd>/.crewhaus/
    // sessions. Without this threading the step distilled 0 samples and burned
    // every gateway rating.
    const root = newRoot();
    const tenantsRoot = join(root, "tenants");
    writeTranscript(join(tenantsRoot, "tenant-a", "sessions"));
    writeRatings(root);

    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      tenantsRootDir: tenantsRoot,
      env: {},
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
    expect(registry.puts[0]?.name).toBe("helper-ratings");
    expect(registry.puts[0]?.samples.length).toBe(5);
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(true);
  });

  test("tenantsRootDir is re-enumerated: a tenant created after boot is swept", async () => {
    const root = newRoot();
    const tenantsRoot = join(root, "tenants");
    mkdirSync(tenantsRoot, { recursive: true });
    writeRatings(root);
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      tenantsRootDir: tenantsRoot,
      env: {},
    }) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;

    // Tick 1: no tenant directory yet ⇒ nothing readable ⇒ NOT burned.
    const first = await step.run();
    expect(first.status).toBe("skipped");
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(false);

    // Tick 2: the tenant authenticated and wrote its transcript.
    writeTranscript(join(tenantsRoot, "tenant-late", "sessions"));
    const second = await step.run();
    expect(second.status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
  });

  test("CREWHAUS_SESSION_DIR relocates the transcript root (the runtime honors it)", async () => {
    const root = newRoot();
    const elsewhere = join(root, "elsewhere", "sessions");
    writeTranscript(elsewhere);
    writeRatings(root);
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: { CREWHAUS_SESSION_DIR: elsewhere },
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("ok");
    expect(registry.puts[0]?.samples.length).toBe(5);
  });

  test("explicit sessionsDirs win, and one session is never double-counted", async () => {
    const root = newRoot();
    const a = join(root, "a", "sessions");
    writeTranscript(a);
    writeRatings(root);
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      sessionsDirs: [a, a, join(root, "missing", "sessions")],
      env: {},
    });
    expect((await (step as NonNullable<typeof step>).run()).status).toBe("ok");
    expect(registry.puts[0]?.samples.length).toBe(5);
  });

  test("NO readable transcript anywhere ⇒ skipped, watermark NOT advanced", async () => {
    // The destructive case: a misconfigured root is indistinguishable from
    // "the sessions were purged", so the safe reading wins — a distill is
    // offline and costs nothing to retry, whereas a burned watermark is
    // permanent.
    const root = newRoot();
    writeRatings(root);
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
    });
    const out = await (step as NonNullable<typeof step>).run();
    expect(out.status).toBe("skipped");
    expect(out.detail).toContain("no readable transcript");
    expect(registry.puts).toHaveLength(0);
    expect(existsSync(join(root, DISTILL_STATE_RELPATH))).toBe(false);

    // …and it recovers on the very next tick once the root is right.
    writeTranscript(join(root, ".crewhaus", "sessions"));
    expect((await (step as NonNullable<typeof step>).run()).status).toBe("ok");
    expect(registry.puts).toHaveLength(1);
  });
});

describe("createDistillJanitorStep — B19 ties reach the review queue", () => {
  const TIE_TURN = 1;
  function tieCorpus(): { turns: SessionTurn[]; records: FeedbackRecord[]; sessionCount: number } {
    const split: FeedbackRecord[] = [
      { ...rating(TIE_TURN, "2026-07-01T00:00:01.000Z"), id: "fb_a", rater: "ann" },
      {
        ...rating(TIE_TURN, "2026-07-01T00:00:02.000Z"),
        id: "fb_b",
        rater: "bob",
        rating: { thumbs: "down" },
      },
    ];
    return {
      turns: [turn(TIE_TURN), turn(2), turn(3), turn(4), turn(5), turn(6)],
      records: [...split, ...CORPUS.records.slice(1)],
      sessionCount: 1,
    };
  }

  test("a split verdict is enqueued as rater_disagreement, not silently dropped", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
      collect: () => tieCorpus(),
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    }) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;

    const out = await step.run();
    expect(out.status).toBe("ok");
    expect(out.detail).toContain("review queue");

    const queued = readReviewQueue(root);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("rater_disagreement");
    expect(queued[0]?.sourceRef.sessionId).toBe(SESSION);
    expect(queued[0]?.sourceRef.turn).toBe(TIE_TURN);
    expect(queued[0]?.status).toBe("open");
    // The tie turn itself is withheld from the dataset (B19).
    expect(registry.puts[0]?.samples.some((s) => s.input.includes("number 1"))).toBe(false);
  });

  test("an ALL-ties corpus still queues even though nothing registers", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const allTies = {
      turns: [turn(1), turn(2), turn(3), turn(4), turn(5)],
      records: [1, 2, 3, 4, 5].flatMap((n) => [
        { ...rating(n, `2026-07-01T00:00:0${n}.000Z`), id: `fb_${n}a`, rater: "ann" },
        {
          ...rating(n, `2026-07-01T00:00:0${n}.500Z`),
          id: `fb_${n}b`,
          rater: "bob",
          rating: { thumbs: "down" as const },
        },
      ]),
      sessionCount: 1,
    };
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
      collect: () => allTies,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    }) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;

    const out = await step.run();
    expect(out.count).toBe(0);
    expect(registry.puts).toHaveLength(0);
    expect(readReviewQueue(root)).toHaveLength(5);
  });

  test("a review-queue failure never fails the tick or blocks registration", async () => {
    const root = newRoot();
    const registry = fakeRegistry();
    const step = createDistillJanitorStep({
      specName: "helper",
      feedback: { autoDistill: true },
      registry,
      cwd: root,
      env: {},
      collect: () => tieCorpus(),
      enqueueReview: () => {
        throw new Error("queue offline");
      },
    }) as NonNullable<ReturnType<typeof createDistillJanitorStep>>;
    const out = await step.run();
    expect(out.status).toBe("ok");
    expect(out.detail).toContain("queue offline");
    expect(registry.puts).toHaveLength(1);
  });
});
