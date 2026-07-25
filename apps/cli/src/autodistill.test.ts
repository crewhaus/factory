/**
 * Unit tests for the item-1 feedback.autoDistill consumer (watermark +
 * threshold + registration). All filesystem access goes to temp dirs; no
 * LLM/credentials needed.
 *
 * The block's exit-rating half moved to @crewhaus/runtime-core (so compiled
 * bundles ask the prompt too); its gating/key/record tests live in
 * packages/runtime-core/src/exit-rating.test.ts. The spawned-CLI test at the
 * bottom of this file still pins the CLI surface: a piped run never prompts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRegistry, latestVersion } from "@crewhaus/dataset-registry";
import type { IrFeedback } from "@crewhaus/ir";
import {
  AUTODISTILL_THRESHOLD_ENV,
  DEFAULT_AUTODISTILL_THRESHOLD,
  DISTILL_STATE_RELPATH,
  countUnprocessed,
  maybeAutoDistill,
  newestTs,
  parseDistillState,
  ratingsDatasetName,
  readDistillState,
  resolveAutoDistillThreshold,
  shouldAutoDistill,
  writeDistillState,
} from "./autodistill";
import type { FeedbackRecord, SessionTurn } from "./feedback";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-autodistill-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// -------- fixtures --------

const SESSION_A = "sess_aaaaaaaaaaaaaaaa";
const SESSION_B = "sess_bbbbbbbbbbbbbbbb";

function makeRecord(opts: {
  sessionId?: string;
  turnNumber: number;
  ts: string;
  thumbs?: "up" | "down";
}): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `fb_${opts.ts.replace(/\D/g, "").slice(-6)}${opts.turnNumber}`,
    sessionId: opts.sessionId ?? SESSION_A,
    turnNumber: opts.turnNumber,
    modality: "binary",
    rating: { thumbs: opts.thumbs ?? "up" },
    source: "cli",
    ts: opts.ts,
  };
}

function makeTurn(opts: {
  sessionId?: string;
  turnNumber: number;
  input?: string;
  output?: string;
}): SessionTurn {
  return {
    sessionId: opts.sessionId ?? SESSION_A,
    turnNumber: opts.turnNumber,
    input: opts.input ?? `question ${opts.turnNumber}`,
    output: opts.output ?? `answer ${opts.turnNumber}`,
    toolNames: [],
  };
}

/** N up-rated records on session A turns 1..N (ts spaced a minute apart). */
function makeRatedSession(n: number): { turns: SessionTurn[]; records: FeedbackRecord[] } {
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  for (let i = 1; i <= n; i += 1) {
    turns.push(makeTurn({ turnNumber: i }));
    records.push(
      makeRecord({ turnNumber: i, ts: `2026-07-01T00:${String(i).padStart(2, "0")}:00.000Z` }),
    );
  }
  return { turns, records };
}

const FEEDBACK_ON: IrFeedback = { modality: "binary", autoDistill: true };

// -------- watermark state --------

describe("distill state (watermark)", () => {
  test("write → read round-trips", () => {
    const path = join(newTempRoot(), DISTILL_STATE_RELPATH);
    const state = {
      schemaVersion: 1 as const,
      lastProcessedTs: "2026-07-01T00:05:00.000Z",
      processedCount: 5,
      lastRegistered: { name: "hello-ratings", version: "v1", at: "2026-07-01T00:06:00.000Z" },
    };
    writeDistillState(path, state);
    expect(readDistillState(path)).toEqual(state);
  });

  test("missing file → undefined", () => {
    expect(readDistillState(join(newTempRoot(), "nope.json"))).toBeUndefined();
  });

  test("corrupt/foreign JSON degrades to undefined (everything unprocessed), never throws", () => {
    expect(parseDistillState("not json {{{")).toBeUndefined();
    expect(parseDistillState('"a string"')).toBeUndefined();
    expect(
      parseDistillState('{"schemaVersion":2,"lastProcessedTs":"x","processedCount":1}'),
    ).toBeUndefined();
    expect(parseDistillState('{"schemaVersion":1,"processedCount":1}')).toBeUndefined();
  });

  test("countUnprocessed: strict ts comparison, undefined watermark counts all", () => {
    const records = [
      makeRecord({ turnNumber: 1, ts: "2026-07-01T00:01:00.000Z" }),
      makeRecord({ turnNumber: 2, ts: "2026-07-01T00:02:00.000Z" }),
      makeRecord({ turnNumber: 3, ts: "2026-07-01T00:03:00.000Z" }),
    ];
    expect(countUnprocessed(records, undefined)).toBe(3);
    // Ties are NOT unprocessed (strictly greater).
    expect(countUnprocessed(records, "2026-07-01T00:02:00.000Z")).toBe(1);
    expect(countUnprocessed(records, "2026-07-01T00:03:00.000Z")).toBe(0);
  });

  test("newestTs picks the max ISO timestamp", () => {
    expect(newestTs([])).toBeUndefined();
    expect(
      newestTs([
        makeRecord({ turnNumber: 2, ts: "2026-07-01T00:09:00.000Z" }),
        makeRecord({ turnNumber: 1, ts: "2026-07-01T00:01:00.000Z" }),
      ]),
    ).toBe("2026-07-01T00:09:00.000Z");
  });
});

// -------- threshold + trigger --------

describe("resolveAutoDistillThreshold", () => {
  test("default 5 (the spec flag is a plain boolean)", () => {
    expect(resolveAutoDistillThreshold({})).toBe(DEFAULT_AUTODISTILL_THRESHOLD);
    expect(DEFAULT_AUTODISTILL_THRESHOLD).toBe(5);
  });
  test("env override wins; invalid/empty values fall back", () => {
    expect(resolveAutoDistillThreshold({ [AUTODISTILL_THRESHOLD_ENV]: "2" })).toBe(2);
    expect(resolveAutoDistillThreshold({ [AUTODISTILL_THRESHOLD_ENV]: "0" })).toBe(5);
    expect(resolveAutoDistillThreshold({ [AUTODISTILL_THRESHOLD_ENV]: "nope" })).toBe(5);
    expect(resolveAutoDistillThreshold({ [AUTODISTILL_THRESHOLD_ENV]: "" })).toBe(5);
  });
});

describe("shouldAutoDistill", () => {
  test("runs at/above the threshold when the spec opted in", () => {
    expect(shouldAutoDistill({ feedback: FEEDBACK_ON, unprocessed: 5, threshold: 5 }).run).toBe(
      true,
    );
    expect(shouldAutoDistill({ feedback: FEEDBACK_ON, unprocessed: 9, threshold: 5 }).run).toBe(
      true,
    );
  });
  test("below threshold → no", () => {
    const d = shouldAutoDistill({ feedback: FEEDBACK_ON, unprocessed: 4, threshold: 5 });
    expect(d.run).toBe(false);
    expect(d.reason).toContain("4");
  });
  test("no feedback block / autoDistill off / disabled block → no", () => {
    expect(shouldAutoDistill({ feedback: undefined, unprocessed: 99, threshold: 5 }).run).toBe(
      false,
    );
    expect(
      shouldAutoDistill({ feedback: { modality: "binary" }, unprocessed: 99, threshold: 5 }).run,
    ).toBe(false);
    expect(
      shouldAutoDistill({
        feedback: { modality: "binary", autoDistill: false },
        unprocessed: 99,
        threshold: 5,
      }).run,
    ).toBe(false);
    expect(
      shouldAutoDistill({
        feedback: { modality: "binary", autoDistill: true, enabled: false },
        unprocessed: 99,
        threshold: 5,
      }).run,
    ).toBe(false);
  });
});

// -------- the consumer end-to-end --------

describe("maybeAutoDistill", () => {
  function ctx() {
    const root = newTempRoot();
    return {
      root,
      registry: createFileBackedRegistry({ rootDir: join(root, ".crewhaus", "datasets") }),
      stateFilePath: join(root, DISTILL_STATE_RELPATH),
      lines: [] as string[],
    };
  }

  test("below threshold: nothing registered, no watermark written", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(3);
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(false);
    expect(await latestVersion(c.registry, "hello-ratings")).toBeUndefined();
    expect(existsSync(c.stateFilePath)).toBe(false);
    expect(c.lines).toEqual([]);
  });

  test("at threshold: registers <spec>-ratings@v1, advances the watermark, prints one line", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(5);
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(true);
    expect(result.registered).toEqual({ name: "hello-ratings", version: "v1" });
    const record = await c.registry.getRecord("hello-ratings", "v1");
    expect(
      record.splits.train.length + record.splits.dev.length + (record.splits.test?.length ?? 0),
    ).toBe(5);
    const state = readDistillState(c.stateFilePath);
    expect(state?.lastProcessedTs).toBe("2026-07-01T00:05:00.000Z");
    expect(state?.processedCount).toBe(5);
    expect(state?.lastRegistered?.version).toBe("v1");
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain("registry:hello-ratings@v1");
  });

  // B23 — the teardown consumer is unattended, so it ALWAYS redacts: raw
  // PII/secrets in turn text or corrections never reach the registry.
  test("always PII/secret-redacts the registered samples (no opt-out)", async () => {
    const c = ctx();
    const ssn = ["219", "09", "9999"].join("-");
    const email = ["jane", "example.com"].join("@");
    const { turns, records } = makeRatedSession(5);
    const leakyTurns = turns.map((t, i) =>
      i === 0 ? { ...t, input: `my ssn is ${ssn}`, output: `mail ${email}` } : t,
    );
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns: leakyTurns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(true);
    const record = await c.registry.getRecord("hello-ratings", "v1");
    const text = JSON.stringify(record);
    expect(text).not.toContain(ssn);
    expect(text).not.toContain(email);
    expect(text).toContain("[REDACTED:ssn]");
    expect(text).toContain("[REDACTED:email]");
  });

  test("re-running with the same records does NOT re-distill (watermark)", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(5);
    const opts = {
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l: string) => c.lines.push(l),
    };
    await maybeAutoDistill(opts);
    const again = await maybeAutoDistill(opts);
    expect(again.ran).toBe(false);
    expect(again.reason).toContain("0 unprocessed");
    expect(await latestVersion(c.registry, "hello-ratings")).toBe("v1");
  });

  test("enough NEW records past the watermark → v2 (full rebuild, all records included)", async () => {
    const c = ctx();
    const first = makeRatedSession(5);
    const opts = {
      specName: "hello",
      feedback: FEEDBACK_ON,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l: string) => c.lines.push(l),
    };
    await maybeAutoDistill({ ...opts, turns: first.turns, records: first.records });

    // 5 later ratings on a second session.
    const laterTurns = [1, 2, 3, 4, 5].map((i) =>
      makeTurn({ sessionId: SESSION_B, turnNumber: i }),
    );
    const laterRecords = [1, 2, 3, 4, 5].map((i) =>
      makeRecord({
        sessionId: SESSION_B,
        turnNumber: i,
        ts: `2026-07-01T01:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    const result = await maybeAutoDistill({
      ...opts,
      turns: [...first.turns, ...laterTurns],
      records: [...first.records, ...laterRecords],
    });
    expect(result.ran).toBe(true);
    expect(result.registered?.version).toBe("v2");
    const record = await c.registry.getRecord("hello-ratings", "v2");
    expect(
      record.splits.train.length + record.splits.dev.length + (record.splits.test?.length ?? 0),
    ).toBe(10);
    expect(readDistillState(c.stateFilePath)?.lastProcessedTs).toBe("2026-07-01T01:05:00.000Z");
  });

  test("threshold is env-tunable", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(2);
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: { [AUTODISTILL_THRESHOLD_ENV]: "2" },
      write: () => {},
    });
    expect(result.ran).toBe(true);
  });

  test("registry-unsafe spec name degrades to a warned no-op", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(5);
    const result = await maybeAutoDistill({
      specName: "hello world: prod",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(false);
    expect(c.lines[0]).toContain("can't form a registry dataset name");
  });

  test("ratings with no matching turns register nothing but advance the watermark", async () => {
    const c = ctx();
    const { records } = makeRatedSession(5);
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns: [], // sessions purged — nothing to join against
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(false);
    expect(await latestVersion(c.registry, "hello-ratings")).toBeUndefined();
    // Watermark advanced: the unmatchable records never re-trigger.
    expect(readDistillState(c.stateFilePath)?.lastProcessedTs).toBe("2026-07-01T00:05:00.000Z");
    const again = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns: [],
      records,
      registry: c.registry,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(again.reason).toContain("0 unprocessed");
  });

  test("a failing registry leaves the watermark untouched (retries next run)", async () => {
    const c = ctx();
    const { turns, records } = makeRatedSession(5);
    const failing = {
      ...c.registry,
      put: async () => {
        throw new Error("disk full");
      },
    };
    const result = await maybeAutoDistill({
      specName: "hello",
      feedback: FEEDBACK_ON,
      turns,
      records,
      registry: failing,
      stateFilePath: c.stateFilePath,
      env: {},
      write: (l) => c.lines.push(l),
    });
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("registry put failed");
    expect(existsSync(c.stateFilePath)).toBe(false);
    expect(c.lines[0]).toContain("will retry next run");
  });

  test("ratingsDatasetName is the item-12 shorthand target", () => {
    expect(ratingsDatasetName("concierge")).toBe("concierge-ratings");
  });
});

// -------- CLI surface (spawned): piped run never prompts --------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

describe("run teardown (CLI surface)", () => {
  test("a piped run of a feedback-enabled spec exits without prompting", async () => {
    // No model call happens: stdin closes immediately, so the REPL sees EOF
    // and runChatLoop returns; the teardown must not prompt (non-TTY) and
    // must not fail the run.
    const root = newTempRoot();
    writeFileSync(
      join(root, "crewhaus.yaml"),
      "name: hello\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\nfeedback:\n  autoDistill: true\n",
    );
    const proc = Bun.spawn([process.execPath, CLI_PATH, "run", "crewhaus.yaml"], {
      cwd: root,
      // Dummy credential: the run path checks for one up front, but the
      // immediate stdin EOF ends the REPL before any model call is made.
      env: { PATH: process.env["PATH"] ?? "", ANTHROPIC_API_KEY: "sk-ant-test-notreal" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("rate this session?");
  }, 30_000);
});
