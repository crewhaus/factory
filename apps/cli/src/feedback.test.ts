import { describe, expect, it } from "bun:test";
import { SampleSchema } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import {
  type FeedbackRecord,
  type LoggedEvent,
  MAX_FEEDBACK_TEXT,
  type SessionTurn,
  buildFeedbackRecord,
  buildJudgeRubricGrader,
  clipFeedbackText,
  deriveTurns,
  distill,
  extractFeedbackRecords,
  gradersConfigToYaml,
  isFeedbackRecord,
  mergeFeedback,
  normalizeRating,
  samplesToJsonl,
  synthesizeGraders,
} from "./feedback";

const SESSION = "sess_0123456789abcdef";

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: "fb_x",
    sessionId: SESSION,
    turnNumber: 1,
    modality: "binary",
    rating: { thumbs: "up" },
    source: "cli",
    ts: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildFeedbackRecord", () => {
  const base = { id: "fb_1", sessionId: SESSION, turnNumber: 2, ts: "t", source: "cli" as const };

  it("infers binary from thumbs", () => {
    const r = buildFeedbackRecord({ ...base, thumbs: "down" });
    expect(r.modality).toBe("binary");
    expect(r.rating.thumbs).toBe("down");
    expect(r.turnNumber).toBe(2);
  });

  it("infers stars and rejects out-of-range", () => {
    expect(buildFeedbackRecord({ ...base, stars: 4 }).modality).toBe("stars");
    expect(() => buildFeedbackRecord({ ...base, stars: 0 })).toThrow();
    expect(() => buildFeedbackRecord({ ...base, stars: 6 })).toThrow();
    expect(() => buildFeedbackRecord({ ...base, stars: 2.5 })).toThrow();
  });

  it("infers scale from score and rejects out-of-range", () => {
    const r = buildFeedbackRecord({ ...base, score: 0.25 });
    expect(r.modality).toBe("scale");
    expect(r.rating.scale).toEqual({ value: 0.25, min: 0, max: 1 });
    expect(() => buildFeedbackRecord({ ...base, score: 1.5 })).toThrow();
    expect(() => buildFeedbackRecord({ ...base, score: -0.1 })).toThrow();
  });

  it("infers comment modality from text/correction and rejects an empty record", () => {
    expect(buildFeedbackRecord({ ...base, comment: "meh" }).modality).toBe("comment");
    expect(buildFeedbackRecord({ ...base, correction: "better" }).modality).toBe("comment");
    expect(() => buildFeedbackRecord({ ...base })).toThrow();
  });

  it("omits undefined optional fields", () => {
    const r = buildFeedbackRecord({ ...base, thumbs: "up" });
    expect("comment" in r).toBe(false);
    expect("correction" in r).toBe(false);
    expect("rater" in r).toBe(false);
  });
});

describe("normalizeRating", () => {
  it("maps thumbs to 0/1", () => {
    expect(normalizeRating(record({ rating: { thumbs: "up" } }))).toBe(1);
    expect(normalizeRating(record({ rating: { thumbs: "down" } }))).toBe(0);
  });
  it("maps 1-5 stars via (n-1)/4", () => {
    expect(normalizeRating(record({ modality: "stars", rating: { stars: 1 } }))).toBe(0);
    expect(normalizeRating(record({ modality: "stars", rating: { stars: 3 } }))).toBe(0.5);
    expect(normalizeRating(record({ modality: "stars", rating: { stars: 5 } }))).toBe(1);
  });
  it("maps a scale to [0,1] and clamps; span<=0 → undefined", () => {
    expect(
      normalizeRating(
        record({ modality: "scale", rating: { scale: { value: 5, min: 0, max: 10 } } }),
      ),
    ).toBe(0.5);
    expect(
      normalizeRating(
        record({ modality: "scale", rating: { scale: { value: 99, min: 0, max: 10 } } }),
      ),
    ).toBe(1);
    expect(
      normalizeRating(
        record({ modality: "scale", rating: { scale: { value: 1, min: 1, max: 1 } } }),
      ),
    ).toBeUndefined();
  });
  it("returns undefined for a comment-only record", () => {
    expect(normalizeRating(record({ modality: "comment", rating: {} }))).toBeUndefined();
  });
});

describe("isFeedbackRecord", () => {
  it("accepts a valid record and rejects malformed ones", () => {
    expect(isFeedbackRecord(record())).toBe(true);
    expect(isFeedbackRecord({ ...record(), sessionId: "nope" })).toBe(false);
    expect(isFeedbackRecord({ ...record(), schemaVersion: 2 })).toBe(false);
    expect(isFeedbackRecord({ ...record(), modality: "bogus" })).toBe(false);
    expect(isFeedbackRecord(null)).toBe(false);
    expect(isFeedbackRecord({})).toBe(false);
  });

  it("rejects records with a malformed rating so no NaN/coerced score leaks", () => {
    expect(isFeedbackRecord({ ...record(), rating: { stars: "999" } })).toBe(false);
    expect(isFeedbackRecord({ ...record(), rating: { stars: 6 } })).toBe(false);
    expect(isFeedbackRecord({ ...record(), rating: { stars: 2.5 } })).toBe(false);
    expect(isFeedbackRecord({ ...record(), rating: { thumbs: "sideways" } })).toBe(false);
    expect(isFeedbackRecord({ ...record(), rating: { scale: { value: 1, min: 0 } } })).toBe(false);
    expect(isFeedbackRecord({ ...record(), rating: { scale: { value: 1, min: 0, max: 2 } } })).toBe(
      true,
    );
  });
});

describe("clipFeedbackText", () => {
  it("strips control chars (keeping tab/newline/CR) and bounds the length", () => {
    expect(clipFeedbackText("a\x00b\x07c")).toBe("abc");
    expect(clipFeedbackText("line1\nline2\tok\r")).toBe("line1\nline2\tok\r");
    const long = "x".repeat(MAX_FEEDBACK_TEXT + 500);
    expect(clipFeedbackText(long).length).toBe(MAX_FEEDBACK_TEXT);
  });

  it("is applied to comment/correction at CLI capture", () => {
    const r = buildFeedbackRecord({
      id: "fb_1",
      sessionId: SESSION,
      turnNumber: 1,
      ts: "t",
      source: "cli",
      comment: "clean\x00text",
      correction: "y".repeat(MAX_FEEDBACK_TEXT + 10),
    });
    expect(r.comment).toBe("cleantext");
    expect((r.correction ?? "").length).toBe(MAX_FEEDBACK_TEXT);
  });
});

// A realistic single-turn transcript: user text → assistant (text + tool_use)
// → tool_result echo (array user_message) → assistant final text.
function toolTurnEvents(input: string, answer: string, tool: string): LoggedEvent[] {
  return [
    { kind: "user_message", payload: { content: input } },
    {
      kind: "assistant_message",
      payload: {
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", name: tool },
        ],
      },
    },
    { kind: "tool_use", payload: { name: tool } },
    { kind: "tool_result", payload: { toolUseId: "t1" } },
    {
      kind: "user_message",
      payload: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    },
    { kind: "assistant_message", payload: { content: [{ type: "text", text: answer }] } },
  ];
}

describe("deriveTurns", () => {
  it("pairs a user-text turn with the final assistant answer and its tools", () => {
    const turns = deriveTurns(toolTurnEvents("q1", "the answer", "Fetch"));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      turnNumber: 1,
      input: "q1",
      output: "the answer",
      toolNames: ["Fetch"],
    });
  });

  it("does not open a turn on a tool-result-only user_message", () => {
    const events: LoggedEvent[] = [
      { kind: "user_message", payload: { content: "real question" } },
      { kind: "user_message", payload: { content: [{ type: "tool_result", content: "x" }] } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "answer" }] } },
    ];
    const turns = deriveTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.turnNumber).toBe(1);
  });

  it("numbers multiple user-text turns 1..N", () => {
    const events = [
      ...toolTurnEvents("q1", "a1", "Fetch"),
      ...toolTurnEvents("q2", "a2", "WebSearch"),
    ];
    const turns = deriveTurns(events);
    expect(turns.map((t) => [t.turnNumber, t.input, t.output])).toEqual([
      [1, "q1", "a1"],
      [2, "q2", "a2"],
    ]);
  });

  it("yields an empty output for a turn that errored before answering", () => {
    const turns = deriveTurns([
      { kind: "user_message", payload: { content: "q" } },
      { kind: "error", payload: { name: "ProviderError" } },
    ]);
    expect(turns).toEqual([{ turnNumber: 1, input: "q", output: "", toolNames: [] }]);
  });

  it("does NOT count runtime-synthetic user_message nudges as turns (turn alignment)", () => {
    // A loop-warning / continue / tombstone nudge is logged as a string-content
    // user_message with synthetic:true and must not shift the turn ordinal, so
    // distill stays aligned with the runtime + web UI.
    const events: LoggedEvent[] = [
      { kind: "user_message", payload: { content: "first question" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "a1" }] } },
      {
        kind: "user_message",
        payload: { content: "[runtime] possible loop detected: …", synthetic: true },
      },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "recovered" }] } },
      {
        kind: "user_message",
        payload: { content: "Please continue from where you left off.", synthetic: true },
      },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "more" }] } },
      { kind: "user_message", payload: { content: "second question" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "a2" }] } },
    ];
    const turns = deriveTurns(events);
    expect(turns.map((t) => [t.turnNumber, t.input])).toEqual([
      [1, "first question"],
      [2, "second question"],
    ]);
  });

  it("ignores the advisor event kinds (recovery, tool_stats, permission, model_meta)", () => {
    // Item-14 groundwork persists advisory lines into the same session JSONL.
    // They are non-conversational — interleaving them must not perturb the
    // derived turns of any reader (deriveTurns backs both distill and rate).
    const events: LoggedEvent[] = [
      { kind: "user_message", payload: { content: "q" } },
      { kind: "model_meta", payload: { stopReason: "end_turn", model: "m" } },
      { kind: "tool_stats", payload: { toolName: "Fetch", durationMs: 12, isError: false } },
      { kind: "permission", payload: { toolName: "Fetch", decision: "allow", askOutcome: null } },
      { kind: "recovery", payload: { errorName: "MaxTokensError", action: "continue", depth: 1 } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "a" }] } },
    ];
    expect(deriveTurns(events)).toEqual([
      { turnNumber: 1, input: "q", output: "a", toolNames: [] },
    ]);
  });
});

describe("extractFeedbackRecords + mergeFeedback", () => {
  it("reads both event-log envelopes and bare records, skipping others", () => {
    const objs = [
      { kind: "user_feedback", payload: record({ turnNumber: 1 }) },
      record({ turnNumber: 2 }),
      { kind: "assistant_message", payload: { content: "x" } },
      { kind: "user_feedback", payload: { junk: true } },
    ];
    const out = extractFeedbackRecords(objs);
    expect(out.map((r) => r.turnNumber).sort()).toEqual([1, 2]);
  });

  it("dedupes by (session,turn) keeping the newest ts", () => {
    const older = record({ turnNumber: 1, rating: { thumbs: "down" }, ts: "2026-01-01T00:00:00Z" });
    const newer = record({ turnNumber: 1, rating: { thumbs: "up" }, ts: "2026-02-01T00:00:00Z" });
    const merged = mergeFeedback([older, newer]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.rating.thumbs).toBe("up");
  });

  it("merges fields: a later comment-only record keeps the earlier rating", () => {
    const rated = record({
      turnNumber: 1,
      modality: "binary",
      rating: { thumbs: "up" },
      ts: "2026-01-01T00:00:00Z",
    });
    const commented = record({
      turnNumber: 1,
      modality: "comment",
      rating: {},
      comment: "nice, cited a source",
      ts: "2026-02-01T00:00:00Z",
    });
    const merged = mergeFeedback([rated, commented]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.rating.thumbs).toBe("up"); // rating preserved
    expect(merged[0]?.modality).toBe("binary");
    expect(merged[0]?.comment).toBe("nice, cited a source"); // comment folded in
  });
});

describe("distill (tag-all)", () => {
  const turns: SessionTurn[] = [
    {
      sessionId: SESSION,
      turnNumber: 1,
      input: "q1",
      output: "cited answer v0.1.6",
      toolNames: ["Fetch"],
    },
    { sessionId: SESSION, turnNumber: 2, input: "q2", output: "bad answer", toolNames: [] },
  ];

  it("makes positives gold and low-rated no-gold, and counts stats", () => {
    const up = record({ turnNumber: 1, rating: { thumbs: "up" } });
    const down = record({ id: "fb_d", turnNumber: 2, rating: { thumbs: "down" } });
    const r = distill(turns, [up, down], { minScore: 0.7 });
    expect(r.stats).toMatchObject({
      matchedTurns: 2,
      positives: 1,
      negatives: 1,
      unmatchedFeedback: 0,
    });
    const gold = r.samples.find((s) => s.id === `${SESSION}_t1`);
    const low = r.samples.find((s) => s.id === `${SESSION}_t2`);
    expect(gold?.expected_output).toBe("cited answer v0.1.6");
    expect(gold?.expected_tools).toEqual(["Fetch"]);
    expect(low?.expected_output).toBeUndefined();
    expect(low?.metadata?.["user_rating"]).toBe(0);
  });

  it("uses a correction as the gold output regardless of thumbs", () => {
    const fb = record({
      turnNumber: 2,
      modality: "comment",
      rating: {},
      correction: "the fixed answer",
    });
    const r = distill(turns, [fb], { minScore: 0.7 });
    expect(r.samples[0]?.expected_output).toBe("the fixed answer");
  });

  it("omits an empty gold output for an errored positive turn", () => {
    const errored: SessionTurn[] = [
      { sessionId: SESSION, turnNumber: 1, input: "q", output: "", toolNames: [] },
    ];
    const r = distill(errored, [record({ turnNumber: 1, rating: { thumbs: "up" } })], {
      minScore: 0.7,
    });
    expect(r.samples[0]?.expected_output).toBeUndefined();
  });

  it("warns and counts feedback whose turn is missing from the transcript", () => {
    const r = distill(turns, [record({ turnNumber: 99 })], { minScore: 0.7 });
    expect(r.stats.unmatchedFeedback).toBe(1);
    expect(r.samples).toHaveLength(0);
    expect(r.warnings.join()).toContain("no matching turn");
  });

  it("emits exactly one grader (never stacks)", () => {
    const r = distill(turns, [record({ turnNumber: 1, rating: { thumbs: "up" } })], {
      minScore: 0.7,
    });
    expect(r.graders.graders).toHaveLength(1);
  });
});

describe("synthesizeGraders", () => {
  it("prefers tools shared by every tool-using positive turn", () => {
    const g = synthesizeGraders([
      { turnNumber: 1, input: "", output: "a", toolNames: ["Fetch", "WebSearch"] },
      { turnNumber: 2, input: "", output: "b", toolNames: ["Fetch"] },
    ]);
    expect(g.graders[0]).toMatchObject({
      type: "tool_call_sequence",
      expected: ["Fetch"],
      mode: "set",
    });
  });

  it("falls back to a common distinctive phrase when no tools were used", () => {
    const g = synthesizeGraders([
      { turnNumber: 1, input: "", output: "always cite the source clearly", toolNames: [] },
      { turnNumber: 2, input: "", output: "please cite the source", toolNames: [] },
    ]);
    expect(g.graders[0]?.type).toBe("contains");
    expect((g.graders[0] as { substring: string }).substring).toBe("cite");
  });

  it("emits a non-empty floor + warning when there is no signal", () => {
    const warnings: string[] = [];
    const g = synthesizeGraders(
      [{ turnNumber: 1, input: "", output: "", toolNames: [] }],
      warnings,
    );
    expect(g.graders[0]).toMatchObject({ type: "regex", pattern: "\\S" });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("serialization round-trips through the real eval contracts", () => {
  it("samplesToJsonl produces SampleSchema-valid rows", () => {
    const turns: SessionTurn[] = [
      { sessionId: SESSION, turnNumber: 1, input: "q", output: "a", toolNames: ["Fetch"] },
    ];
    const { samples } = distill(turns, [record({ turnNumber: 1, rating: { thumbs: "up" } })], {
      minScore: 0.7,
    });
    const jsonl = samplesToJsonl(samples);
    for (const line of jsonl.split("\n").filter(Boolean)) {
      expect(SampleSchema.safeParse(JSON.parse(line)).success).toBe(true);
    }
  });

  it("gradersConfigToYaml parses back through parseGradersConfig for every grader kind", () => {
    for (const cfg of [
      {
        graders: [
          { name: "t", type: "tool_call_sequence", expected: ["Fetch", "WebSearch"], mode: "set" },
        ],
      },
      {
        graders: [
          {
            name: "c",
            type: "contains",
            substring: 'has "quotes" and: colons',
            case_insensitive: true,
          },
        ],
      },
      { graders: [{ name: "r", type: "regex", pattern: "\\S" }] },
    ] as const) {
      const { compiled } = parseGradersConfig(gradersConfigToYaml(cfg));
      expect(compiled).toHaveLength(1);
      expect(compiled[0]?.name).toBe(cfg.graders[0].name);
    }
  });
});

describe("distill --judge (llm_judge rubric seeded from comments)", () => {
  it("emits a single llm_judge grader whose YAML validates + carries a judgeSpec", () => {
    const grader = buildJudgeRubricGrader(["clear and cited a source"], ["too vague; no link"]);
    const yaml = gradersConfigToYaml({ graders: [grader] });
    const { compiled } = parseGradersConfig(yaml);
    expect(compiled).toHaveLength(1); // one grader — never hard-ANDed
    expect(compiled[0]?.judgeSpec).toBeDefined();
    const rubric = compiled[0]?.judgeSpec?.rubric;
    expect(rubric?.criteria).toHaveLength(1);
    expect(rubric?.criteria[0]?.name).toBe("user_preference");
    // comment themes are folded into the description as quoted data.
    expect(rubric?.criteria[0]?.description).toContain("cited a source");
    expect(rubric?.criteria[0]?.description).toContain("too vague");
    for (const k of ["1", "2", "3", "4", "5"] as const) {
      expect((rubric?.criteria[0]?.anchors as Record<string, string>)[k].length).toBeGreaterThan(0);
    }
  });

  it("distill(opts.judge) replaces the deterministic grader with the judge", () => {
    const turns: SessionTurn[] = [
      { sessionId: SESSION, turnNumber: 1, input: "q", output: "a", toolNames: ["Fetch"] },
    ];
    const res = distill(turns, [record({ turnNumber: 1, rating: { thumbs: "up" } })], {
      minScore: 0.7,
      judge: true,
    });
    expect(res.graders.graders).toHaveLength(1);
    expect(res.graders.graders[0]?.type).toBe("llm_judge");
  });

  it("produces a valid rubric even with no comments (generic anchors)", () => {
    const yaml = gradersConfigToYaml({ graders: [buildJudgeRubricGrader([], [])] });
    const { compiled } = parseGradersConfig(yaml);
    expect(compiled[0]?.judgeSpec?.rubric.criteria).toHaveLength(1);
  });
});
