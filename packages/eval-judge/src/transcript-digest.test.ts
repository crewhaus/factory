/**
 * NEW-graders-3 — transcript digest rendering (bounded,
 * most-recent-turns-win) and the `target: transcript` judge path: the
 * judge reads the digest in a sentinel-wrapped "Agent transcript" block.
 */
import { describe, expect, test } from "bun:test";
import type { Sample } from "@crewhaus/eval-dataset";
import type { RunResult } from "@crewhaus/eval-grader";
import { makeNaiveStubClient } from "./__test__/stub-client";
import {
  TRANSCRIPT_EVENT_MAX_CHARS,
  buildJudgePrompt,
  createJudgeGrader,
  judge,
  loadRubric,
  renderTranscriptDigest,
} from "./index";

type TranscriptEvent = RunResult["transcript"][number];

function ev(kind: string, payload: unknown): TranscriptEvent {
  return { ts: 1, version: 1, kind, payload } as TranscriptEvent;
}

function runWith(transcript: TranscriptEvent[], agentOutput = "final answer"): RunResult {
  return { agentOutput, events: [], transcript, toolCalls: [], turns: 1, latencyMs: 5 };
}

const RUBRIC = loadRubric(`
criteria:
  - name: process
    description: sensible tool use
    anchors: { "1": bad, "2": meh, "3": ok, "4": good, "5": great }
passing_score: 3
`);

const SAMPLE: Sample = { id: "t1", input: "do the thing" };

describe("renderTranscriptDigest (NEW-graders-3)", () => {
  test("renders turns, tool calls, and errors in order with markers", () => {
    const digest = renderTranscriptDigest(
      runWith([
        ev("user_message", { content: "do the thing" }),
        ev("tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
        ev("tool_result", { toolUseId: "tu1", content: "file.txt", isError: false }),
        ev("error", { name: "APIError", message: "rate limited" }),
        ev("tool_result", { toolUseId: "tu2", content: "boom", isError: true }),
        ev("assistant_message", { content: "done" }),
      ]),
    );
    const lines = digest.split("\n");
    expect(lines[0]).toBe("[user] do the thing");
    expect(lines[1]).toBe('[tool_use] bash {"command":"ls"}');
    expect(lines[2]).toBe("[tool_result] file.txt");
    expect(lines[3]).toBe("[error] APIError: rate limited");
    expect(lines[4]).toBe("[tool_result ERROR] boom");
    expect(lines[5]).toBe("[assistant] done");
  });

  test("skips synthetic messages and non-conversational kinds", () => {
    const digest = renderTranscriptDigest(
      runWith([
        ev("user_message", { content: "hidden", synthetic: true }),
        ev("compaction", { kind: "snip", before: 10, after: 2 }),
        ev("cost_accrual", { usdMicros: 12 }),
        ev("assistant_message", { content: "visible" }),
      ]),
    );
    expect(digest).toBe("[assistant] visible");
  });

  test("empty transcript degrades to the final output behind a marker", () => {
    const digest = renderTranscriptDigest(runWith([], "the only evidence"));
    expect(digest).toContain("(no transcript recorded)");
    expect(digest).toContain("[final output] the only evidence");
  });

  test("truncation drops OLDEST events first and announces the cut", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      ev("assistant_message", { content: `turn-${i} ${"x".repeat(50)}` }),
    );
    const digest = renderTranscriptDigest(runWith(events), { maxChars: 300 });
    expect(digest).toMatch(/^\[transcript truncated: showing the most recent \d+ of 20 events\]\n/);
    // The newest event always survives; the oldest is gone.
    expect(digest).toContain("turn-19");
    expect(digest).not.toContain("turn-0 ");
    // Body respects the budget (header excluded from the event budget).
    const body = digest.split("\n").slice(1).join("\n");
    expect(body.length).toBeLessThanOrEqual(300);
  });

  test("no truncation header when everything fits", () => {
    const digest = renderTranscriptDigest(runWith([ev("assistant_message", { content: "short" })]));
    expect(digest).toBe("[assistant] short");
  });

  test("a single event over the whole budget is tail-clipped, newest-wins", () => {
    const digest = renderTranscriptDigest(
      runWith([ev("assistant_message", { content: `START ${"y".repeat(500)} END` })]),
      { maxChars: 120 },
    );
    expect(digest.length).toBeLessThanOrEqual(120);
    expect(digest).toContain("[…clipped]");
    expect(digest).toContain("END"); // the tail (most recent content) survives
    expect(digest).not.toContain("START");
  });

  test("one enormous tool result is per-event clipped, sparing the rest", () => {
    const digest = renderTranscriptDigest(
      runWith([
        ev("user_message", { content: "q" }),
        ev("tool_result", { toolUseId: "t", content: "z".repeat(10_000), isError: false }),
        ev("assistant_message", { content: "a" }),
      ]),
    );
    expect(digest).toContain("[user] q");
    expect(digest).toContain("[assistant] a");
    expect(digest).toContain("[…clipped]");
    for (const line of digest.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(TRANSCRIPT_EVENT_MAX_CHARS);
    }
  });
});

describe("target: transcript judging (NEW-graders-3)", () => {
  test("buildJudgePrompt default stays byte-identical (no trajectory framing)", () => {
    const { system, user } = buildJudgePrompt({
      rubric: RUBRIC,
      input: "i",
      expectedOutput: undefined,
      agentOutput: "o",
    });
    expect(system).not.toContain("RUN TRANSCRIPT");
    expect(user).toContain("Agent output <<<UNTRUSTED_");
  });

  test("judge() with target transcript relabels the block and frames trajectory", async () => {
    let seenUser = "";
    let seenSystem = "";
    const adapter = makeNaiveStubClient((userText, systemText) => {
      seenUser = userText;
      seenSystem = systemText;
      return { score: 4, rationale: "ok", criterion_scores: { process: 4 } };
    });
    await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "[assistant] digest line",
      adapter,
      model: "stub",
      target: "transcript",
    });
    expect(seenUser).toContain("Agent transcript <<<UNTRUSTED_");
    expect(seenUser).toContain("[assistant] digest line");
    expect(seenSystem).toContain("RUN TRANSCRIPT");
  });

  test("createJudgeGrader target: transcript feeds the judge the digest, sentinel-wrapped", async () => {
    let seenUser = "";
    const adapter = makeNaiveStubClient((userText) => {
      seenUser = userText;
      return { score: 5, rationale: "clean run", criterion_scores: { process: 5 } };
    });
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub", target: "transcript" });
    const grade = await grader(
      SAMPLE,
      runWith(
        [
          ev("user_message", { content: "do the thing" }),
          ev("tool_use", { id: "tu1", name: "bash", input: { command: "ls" } }),
          ev("assistant_message", { content: "done" }),
        ],
        "done",
      ),
    );
    expect(grade.passed).toBe(true);
    // The digest — not the bare final output — sits inside the sentinel block.
    expect(seenUser).toContain('[tool_use] bash {"command":"ls"}');
    expect(seenUser).toContain("[user] do the thing");
    expect(seenUser).toMatch(
      /Agent transcript <<<UNTRUSTED_[0-9a-f]{12}>>>\n\[user\] do the thing/,
    );
  });

  test("createJudgeGrader default target still judges the final output only", async () => {
    let seenUser = "";
    const adapter = makeNaiveStubClient((userText) => {
      seenUser = userText;
      return { score: 5, rationale: "ok", criterion_scores: { process: 5 } };
    });
    const grader = createJudgeGrader(RUBRIC, { adapter, model: "stub" });
    await grader(
      SAMPLE,
      runWith([ev("tool_use", { id: "t", name: "bash", input: {} })], "just the answer"),
    );
    expect(seenUser).toContain("Agent output <<<UNTRUSTED_");
    expect(seenUser).toContain("just the answer");
    expect(seenUser).not.toContain("[tool_use]");
  });
});
