/**
 * Wave 3 (B20) — persistent review queue: store semantics (append-only JSONL,
 * idempotent enqueue, later-line-wins resolution), the four feeder entry
 * builders (eval abstained + needs_review, distill rater ties, mine
 * quarantine pointers), formatters, and the `crewhaus review` CLI verbs
 * (including the never-hang non-TTY `next` contract and the eval, distill,
 * and mine feeders end-to-end).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ReviewQueueEntry,
  enqueueReviewEntries,
  entriesFromEvalRun,
  entriesFromQuarantine,
  entriesFromRaterTies,
  formatReviewItem,
  formatReviewList,
  isReviewQueueEntry,
  nextOpenEntry,
  readReviewQueue,
  resolveReviewEntry,
  reviewEntryId,
  reviewQueuePath,
} from "./review-queue";

const TS = "2026-07-25T00:00:00.000Z";
const SESSION = "sess_0123456789abcdef";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-queue-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(id: string, overrides: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry {
  return {
    schemaVersion: 1,
    id,
    kind: "abstained",
    sourceRef: { runId: "run_1", sampleId: id },
    ts: TS,
    status: "open",
    ...overrides,
  };
}

describe("reviewEntryId", () => {
  test("is deterministic from (kind, sourceRef) and sanitizes odd characters", () => {
    const a = reviewEntryId("abstained", { runId: "run_1", sampleId: "s/1 x" });
    expect(a).toBe(reviewEntryId("abstained", { runId: "run_1", sampleId: "s/1 x" }));
    expect(a).toBe("rev_abstained_run_1_s_1_x");
    expect(reviewEntryId("rater_disagreement", { sessionId: SESSION, turn: 3 })).toBe(
      `rev_rater_disagreement_${SESSION}_t3`,
    );
    expect(reviewEntryId("quarantine", { dataset: "spec-hardcases", sampleId: "mine_x_t1" })).toBe(
      "rev_quarantine_spec-hardcases_mine_x_t1",
    );
  });
});

describe("queue store", () => {
  test("enqueue is idempotent by id — re-enqueueing the same batch adds nothing", () => {
    const batch = [entry("rev_a"), entry("rev_b")];
    expect(enqueueReviewEntries(root, batch)).toEqual({ added: 2, skipped: 0 });
    expect(enqueueReviewEntries(root, batch)).toEqual({ added: 0, skipped: 2 });
    // duplicate ids WITHIN one batch collapse too
    expect(enqueueReviewEntries(root, [entry("rev_c"), entry("rev_c")])).toEqual({
      added: 1,
      skipped: 1,
    });
    expect(readReviewQueue(root).map((e) => e.id)).toEqual(["rev_a", "rev_b", "rev_c"]);
  });

  test("a resolved id stays settled — re-enqueueing it is skipped, status stays resolved", () => {
    enqueueReviewEntries(root, [entry("rev_a")]);
    expect(resolveReviewEntry(root, "rev_a", "pass", TS).outcome).toBe("resolved");
    expect(enqueueReviewEntries(root, [entry("rev_a")])).toEqual({ added: 0, skipped: 1 });
    const [e] = readReviewQueue(root);
    expect(e?.status).toBe("resolved");
    expect(e?.resolution).toBe("pass");
  });

  test("resolve appends (audit trail intact), later line wins, not-found/already-resolved report", () => {
    enqueueReviewEntries(root, [entry("rev_a"), entry("rev_b")]);
    const r = resolveReviewEntry(root, "rev_a", "fail", "2026-07-25T01:00:00.000Z");
    expect(r.outcome).toBe("resolved");
    // append-only: the open line is still in the file
    expect(readFileSync(reviewQueuePath(root), "utf-8").split("\n").filter(Boolean)).toHaveLength(
      3,
    );
    // reduced view: one entry per id, first-enqueued order, resolution folded in
    const entries = readReviewQueue(root);
    expect(entries.map((e) => [e.id, e.status])).toEqual([
      ["rev_a", "resolved"],
      ["rev_b", "open"],
    ]);
    expect(entries[0]?.resolvedTs).toBe("2026-07-25T01:00:00.000Z");
    expect(resolveReviewEntry(root, "rev_a", "x", TS).outcome).toBe("already-resolved");
    expect(resolveReviewEntry(root, "rev_nope", "x", TS).outcome).toBe("not-found");
  });

  test("tolerates torn/foreign lines and a missing file", () => {
    expect(readReviewQueue(root)).toEqual([]);
    mkdirSync(join(root, ".crewhaus", "review"), { recursive: true });
    writeFileSync(
      reviewQueuePath(root),
      `${JSON.stringify(entry("rev_ok"))}\n{"torn": tr\nnot json\n{"kind":"other"}\n`,
    );
    expect(readReviewQueue(root).map((e) => e.id)).toEqual(["rev_ok"]);
  });

  test("nextOpenEntry picks the oldest open item and honours the kind filter", () => {
    const entries = [
      entry("rev_new", { ts: "2026-07-25T02:00:00.000Z" }),
      entry("rev_old", { ts: "2026-07-24T00:00:00.000Z" }),
      entry("rev_done", { ts: "2026-07-23T00:00:00.000Z", status: "resolved" }),
      entry("rev_q", { ts: "2026-07-22T00:00:00.000Z", kind: "quarantine" }),
    ];
    expect(nextOpenEntry(entries)?.id).toBe("rev_q");
    expect(nextOpenEntry(entries, "abstained")?.id).toBe("rev_old");
    expect(nextOpenEntry(entries, "rater_disagreement")).toBeUndefined();
    expect(nextOpenEntry([])).toBeUndefined();
  });
});

describe("feeder entry builders", () => {
  test("eval feeder: abstained + needs_review entries keyed on (runId, sampleId), with context", () => {
    const entries = entriesFromEvalRun({
      runId: "run_9",
      needsHumanSampleIds: ["s1", "s2"],
      needsReviewSampleIds: ["s3"],
      contextForSample: (id) => (id === "s1" ? "what is 2+2?" : undefined),
      ts: TS,
    });
    expect(entries.map((e) => [e.kind, e.id, e.status])).toEqual([
      ["abstained", "rev_abstained_run_9_s1", "open"],
      ["abstained", "rev_abstained_run_9_s2", "open"],
      ["needs_review", "rev_needs_review_run_9_s3", "open"],
    ]);
    expect(entries[0]?.context).toBe("what is 2+2?");
    expect(entries[1]?.context).toBeUndefined();
    expect(entries[2]?.sourceRef).toEqual({ runId: "run_9", sampleId: "s3" });
    expect(entries.every(isReviewQueueEntry)).toBe(true);
    // absent buckets → no entries (abstention-free runs feed nothing)
    expect(entriesFromEvalRun({ runId: "run_9", ts: TS })).toEqual([]);
  });

  test("distill feeder: rater ties keyed on (sessionId, turn) with the vote split as context", () => {
    const [e] = entriesFromRaterTies(
      [
        {
          sessionId: SESSION,
          turnNumber: 2,
          votes: [
            { rater: "alice", score: 1, thumbs: "up" },
            { rater: "", score: 0, thumbs: "down" },
          ],
        },
      ],
      { ts: TS },
    );
    expect(e?.id).toBe(`rev_rater_disagreement_${SESSION}_t2`);
    expect(e?.kind).toBe("rater_disagreement");
    expect(e?.sourceRef).toEqual({ sessionId: SESSION, turn: 2 });
    expect(e?.context).toBe("split verdict — alice: up, (unattributed): down");
    expect(isReviewQueueEntry(e)).toBe(true);
  });

  test("mine feeder: quarantine POINTERS keyed on (dataset, sampleId) — no payload duplication", () => {
    const [e] = entriesFromQuarantine(
      [
        {
          id: "mine_error_sess_abc_t3",
          input: "x".repeat(100),
          metadata: { signal: "error", sessionId: SESSION },
        },
      ],
      { dataset: "spec-hardcases", ts: TS },
    );
    expect(e?.id).toBe("rev_quarantine_spec-hardcases_mine_error_sess_abc_t3");
    expect(e?.kind).toBe("quarantine");
    expect(e?.sourceRef).toEqual({ dataset: "spec-hardcases", sampleId: "mine_error_sess_abc_t3" });
    expect(e?.context).toBe(`[error] ${"x".repeat(80)}…`); // clipped excerpt, signal-tagged
    expect(isReviewQueueEntry(e)).toBe(true);
  });
});

describe("formatting", () => {
  test("empty list is friendly; populated list shows status/kind/source/context/resolution", () => {
    expect(formatReviewList([])).toContain("review queue is empty");
    const text = formatReviewList([
      entry("rev_a", { context: "what is 2+2?" }),
      entry("rev_b", { status: "resolved", resolution: "pass" }),
    ]);
    expect(text).toContain("2 review item(s) (1 open)");
    expect(text).toContain("[open] rev_a");
    expect(text).toContain("what is 2+2?");
    expect(text).toContain("[resolved] rev_b");
    expect(text).toContain("(pass)");
  });

  test("item detail names kind, source, and context", () => {
    const text = formatReviewItem(
      entry("rev_x", {
        kind: "rater_disagreement",
        sourceRef: { sessionId: SESSION, turn: 4 },
        context: "split verdict — a: up, b: down",
      }),
    );
    expect(text).toContain("review item rev_x");
    expect(text).toContain("rater_disagreement");
    expect(text).toContain(`${SESSION} turn 4`);
    expect(text).toContain("split verdict");
  });
});

// ---------- CLI integration ----------

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "review-cli-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore", // never a TTY — exercises the non-interactive contract
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("crewhaus review (CLI)", () => {
  test("bare `review` and --help print usage; unknown action dies", async () => {
    const bare = await runCli(["review"]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain("usage: crewhaus review");
    const help = await runCli(["review", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("usage: crewhaus review");
    const bad = await runCli(["review", "frobnicate"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("review action must be one of");
  });

  test("list is friendly on an empty queue and renders seeded items; --kind filters; resolve closes", async () => {
    const empty = await runCli(["review", "list"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("review queue is empty");

    enqueueReviewEntries(cwd, [
      entry("rev_abstained_run_1_s1", { context: "what is 2+2?" }),
      entry("rev_q_1", { kind: "quarantine", sourceRef: { dataset: "d", sampleId: "m1" } }),
    ]);
    const listed = await runCli(["review", "list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("rev_abstained_run_1_s1");
    expect(listed.stdout).toContain("rev_q_1");

    const filtered = await runCli(["review", "list", "--kind", "quarantine"]);
    expect(filtered.stdout).toContain("rev_q_1");
    expect(filtered.stdout).not.toContain("rev_abstained_run_1_s1");

    const badKind = await runCli(["review", "list", "--kind", "nope"]);
    expect(badKind.exitCode).not.toBe(0);
    expect(badKind.stderr).toContain('invalid --kind "nope"');

    const resolved = await runCli(["review", "resolve", "rev_q_1", "--note", "bad candidate"]);
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout).toContain("resolved rev_q_1");
    const after = await runCli(["review", "list"]);
    expect(after.stdout).not.toContain("rev_q_1"); // default view is open-only
    const all = await runCli(["review", "list", "--all"]);
    expect(all.stdout).toContain("rev_q_1");
    expect(all.stdout).toContain("(bad candidate)");

    const missing = await runCli(["review", "resolve", "rev_nope"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('no review item "rev_nope"');
  });

  test("non-TTY `next` prints the oldest open item and exits without hanging", async () => {
    enqueueReviewEntries(cwd, [
      entry("rev_rater_disagreement_x_t2", {
        kind: "rater_disagreement",
        sourceRef: { sessionId: SESSION, turn: 2 },
        context: "split verdict — alice: up, bob: down",
      }),
    ]);
    const next = await runCli(["review", "next"]);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain("review item rev_rater_disagreement_x_t2");
    expect(next.stdout).toContain("split verdict");
    expect(next.stdout).toContain("(non-interactive)");
    expect(next.stdout).toContain("--adjudicate"); // session-turn items point at the rate path
    // the item stays OPEN — non-TTY next never records a verdict
    expect(readReviewQueue(cwd)[0]?.status).toBe("open");

    const clear = await runCli(["review", "resolve", "rev_rater_disagreement_x_t2"]);
    expect(clear.exitCode).toBe(0);
    const done = await runCli(["review", "next"]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("review queue is clear");
  });

  test("distill feeder end-to-end: a 2-rater split enqueues a rater_disagreement item", async () => {
    // A session with two turns: turn 1 rated up by one rater (distills), turn
    // 2 split up/down by two raters (withheld → review queue).
    const sessionsDir = join(cwd, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const fb = (id: string, turnNumber: number, rater: string, thumbs: "up" | "down") => ({
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id,
        sessionId: SESSION,
        turnNumber,
        modality: "binary",
        rating: { thumbs },
        source: "cli",
        rater,
        ts: `2026-07-25T00:00:0${turnNumber}.000Z`,
      },
    });
    const lines = [
      { kind: "user_message", payload: { content: "q1" } },
      { kind: "assistant_message", payload: { content: "good answer one" } },
      { kind: "user_message", payload: { content: "q2" } },
      { kind: "assistant_message", payload: { content: "contested answer" } },
      fb("fb_1", 1, "alice", "up"),
      fb("fb_2", 2, "alice", "up"),
      fb("fb_3", 2, "bob", "down"),
    ];
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const out = await runCli(["distill", "--session", SESSION, "-o", "out.jsonl"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Cohen's kappa");
    expect(out.stdout).toContain("rater disagreement(s) withheld → review queue (1 new)");
    const queued = readReviewQueue(cwd);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("rater_disagreement");
    expect(queued[0]?.sourceRef).toEqual({ sessionId: SESSION, turn: 2 });
    expect(queued[0]?.status).toBe("open");
    // the tie turn was NOT distilled; the clean turn was
    const samples = readFileSync(join(cwd, "out.jsonl"), "utf-8").trim().split("\n");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain(`${SESSION}_t1`);
    expect(existsSync(reviewQueuePath(cwd))).toBe(true);

    // idempotent: re-running distill adds nothing
    const again = await runCli(["distill", "--session", SESSION, "-o", "out.jsonl"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("(0 new)");
    expect(readReviewQueue(cwd)).toHaveLength(1);
  });

  test("rate --adjudicate end-to-end: the flag reaches the record and distill closes the split", async () => {
    // B19 flagship loop through the REAL CLI: a 2-rater split, then
    // `crewhaus rate --adjudicate` settles it — the logged record must carry
    // adjudication:true (schema flag → captureFeedback → buildFeedbackRecord)
    // and a subsequent distill must resolve the turn instead of enqueueing a
    // tie.
    const sessionsDir = join(cwd, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const fb = (id: string, rater: string, thumbs: "up" | "down", second: number) => ({
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id,
        sessionId: SESSION,
        turnNumber: 1,
        modality: "binary",
        rating: { thumbs },
        source: "cli",
        rater,
        ts: `2026-07-25T00:00:0${second}.000Z`,
      },
    });
    const lines = [
      { kind: "user_message", payload: { content: "q1" } },
      { kind: "assistant_message", payload: { content: "contested answer" } },
      fb("fb_1", "alice", "up", 1),
      fb("fb_2", "bob", "down", 2),
    ];
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const rated = await runCli([
      "rate",
      "--session",
      SESSION,
      "--turn",
      "1",
      "--thumbs",
      "up",
      "--rater",
      "lead",
      "--adjudicate",
    ]);
    expect(rated.exitCode).toBe(0);
    // The flag survived the three-point wiring: the durable record is stamped.
    const logged = readFileSync(join(sessionsDir, `${SESSION}.jsonl`), "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { kind?: string; payload?: { adjudication?: boolean } });
    const adjudicated = logged.filter(
      (l) => l.kind === "user_feedback" && l.payload?.adjudication === true,
    );
    expect(adjudicated).toHaveLength(1);

    const out = await runCli(["distill", "--session", SESSION, "-o", "out.jsonl"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("adjudicated");
    expect(out.stdout).not.toContain("withheld");
    // The split resolved — the turn distilled and NO tie reached the queue.
    const samples = readFileSync(join(cwd, "out.jsonl"), "utf-8").trim().split("\n");
    expect(samples).toHaveLength(1);
    expect(samples[0]).toContain('"adjudicated":true');
    expect(readReviewQueue(cwd)).toHaveLength(0);
  });

  test("a verdict-less --adjudicate dies at capture (comment alone settles nothing)", async () => {
    const sessionsDir = join(cwd, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const lines = [
      { kind: "user_message", payload: { content: "q1" } },
      { kind: "assistant_message", payload: { content: "a1" } },
    ];
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const out = await runCli([
      "feedback",
      "--session",
      SESSION,
      "--text",
      "discussed offline",
      "--adjudicate",
    ]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("--adjudicate needs a verdict");
    // …but with a correction the adjudication is accepted.
    const withCorrection = await runCli([
      "feedback",
      "--session",
      SESSION,
      "--correction",
      "the better answer",
      "--adjudicate",
    ]);
    expect(withCorrection.exitCode).toBe(0);
  });

  test("mine feeder end-to-end: quarantined candidates become pointer entries, idempotently", async () => {
    const sessionsDir = join(cwd, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const lines = [
      { kind: "user_message", payload: { content: "please do the thing" } },
      { kind: "error", payload: { name: "ProviderError", message: "boom" } },
    ];
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const out = await runCli(["dataset", "mine"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("1 candidate(s) quarantined");
    expect(out.stdout).toContain("review queue: 1 pointer(s)");
    const queued = readReviewQueue(cwd);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe("quarantine");
    expect(queued[0]?.sourceRef.dataset).toBe("harness-hardcases"); // no cwd spec → "harness"
    expect(queued[0]?.sourceRef.sampleId).toContain("mine_error_");
    expect(queued[0]?.context).toContain("please do the thing");

    // pointer, not payload: the queue entry does not carry sample metadata,
    // and a re-mine adds no duplicate
    const again = await runCli(["dataset", "mine"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain("review queue:");
    expect(readReviewQueue(cwd)).toHaveLength(1);
  });

  test("eval feeder end-to-end: an abstaining judge enqueues abstained items with clipped-input context", async () => {
    // Offline `crewhaus eval`: the agent model AND the judge model are
    // `local/<m>@<url>` router strings pointed at an in-test
    // OpenAI-compatible SSE stub (the advice-pipeline-e2e / judge-wire
    // pattern), so the REAL eval path runs — spec compile → agent loop →
    // llm_judge → aggregate → the B20 queue feeder in the eval tail — with
    // zero credentials. Judge calls are recognized by their forced
    // `submit_score` tool and answered with `abstain: true`, so every
    // sample lands in the needs-human bucket and MUST flow into the review
    // queue keyed on (runId, sampleId). This is the wiring test the pure
    // `entriesFromEvalRun` unit test above cannot provide: a refactor of
    // the eval tail that drops the feeder call fails here.
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const base = {
      id: "chatcmpl-stub",
      object: "chat.completion.chunk",
      created: 1,
      model: "stub",
    };
    const usageChunk = sse({
      ...base,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const textBody = [
      sse({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "PONG" }, finish_reason: null }],
      }),
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      usageChunk,
      "data: [DONE]\n\n",
    ].join("");
    const judgeArgs = JSON.stringify({
      score: 3,
      rationale: "insufficient evidence — abstaining",
      criterion_scores: { quality: 3 },
      abstain: true,
    });
    const judgeBody = [
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "submit_score", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: judgeArgs } }] },
            finish_reason: null,
          },
        ],
      }),
      sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      usageChunk,
      "data: [DONE]\n\n",
    ].join("");
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname.endsWith("/chat/completions")) {
          const body = (await req.json()) as { tools?: Array<{ function?: { name?: string } }> };
          const isJudge = (body.tools ?? []).some((t) => t.function?.name === "submit_score");
          return new Response(isJudge ? judgeBody : textBody, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const model = `local/stub@http://127.0.0.1:${stub.port}/v1`;
      writeFileSync(
        join(cwd, "crewhaus.yaml"),
        [
          "name: hello",
          "target: cli",
          "agent:",
          `  model: ${model}`,
          "  instructions: reply PONG",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(cwd, "dataset.jsonl"),
        `${JSON.stringify({ id: "q1", input: "what is 2+2?" })}\n${JSON.stringify({ id: "q2", input: "what is 3+3?" })}\n`,
      );
      writeFileSync(
        join(cwd, "graders.yaml"),
        [
          "graders:",
          "  - name: quality",
          "    type: llm_judge",
          `    model: ${model}`,
          "    rubric:",
          "      passing_score: 3",
          "      criteria:",
          "        - name: quality",
          "          description: Is the answer correct?",
          "          anchors:",
          '            "1": wrong',
          '            "2": mostly wrong',
          '            "3": adequate',
          '            "4": good',
          '            "5": excellent',
          "",
        ].join("\n"),
      );

      const out = await runCli([
        "eval",
        "crewhaus.yaml",
        "--dataset",
        "dataset.jsonl",
        "--graders",
        "graders.yaml",
        "--concurrency",
        "1",
        "-o",
        "out",
      ]);
      expect(out.exitCode).toBe(0);
      const results = JSON.parse(readFileSync(join(cwd, "out", "results.json"), "utf-8")) as {
        runId: string;
        aggregates: { needsHuman?: number; needsHumanSampleIds?: ReadonlyArray<string> };
      };
      expect(results.aggregates.needsHuman).toBe(2);
      expect([...(results.aggregates.needsHumanSampleIds ?? [])].sort()).toEqual(["q1", "q2"]);

      // the eval tail fed the queue: one abstained item per sample, keyed on
      // (runId, sampleId), carrying the clipped sample input as context
      const queued = readReviewQueue(cwd);
      expect(queued).toHaveLength(2);
      expect(queued.map((e) => e.id).sort()).toEqual([
        `rev_abstained_${results.runId}_q1`,
        `rev_abstained_${results.runId}_q2`,
      ]);
      const q1 = queued.find((e) => e.sourceRef.sampleId === "q1");
      expect(q1?.kind).toBe("abstained");
      expect(q1?.status).toBe("open");
      expect(q1?.sourceRef).toEqual({ runId: results.runId, sampleId: "q1" });
      expect(q1?.context).toBe("what is 2+2?");
      expect(out.stdout).toContain("review queue: 2 item(s) enqueued");
    } finally {
      stub.stop(true);
    }
  }, 120_000);
});
