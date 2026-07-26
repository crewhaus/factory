import { describe, expect, it } from "bun:test";
import { SampleSchema } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { auditSamples, redactDatasetText } from "./dataset-audit";
import {
  type FeedbackRecord,
  type LoggedEvent,
  MAX_FEEDBACK_TEXT,
  type SessionTurn,
  buildFeedbackRecord,
  buildJudgeRubricGrader,
  clipFeedbackText,
  cohenKappa,
  deriveTurns,
  distill,
  extractFeedbackRecords,
  formatAgreementLines,
  gradersConfigToYaml,
  isFeedbackRecord,
  mergeFeedback,
  normalizeRating,
  resolveFeedback,
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

  it("stamps adjudication:true from the adjudicate flag (B19)", () => {
    expect(buildFeedbackRecord({ ...base, thumbs: "up", adjudicate: true }).adjudication).toBe(
      true,
    );
    // a correction IS a verdict, so it may adjudicate on its own
    expect(
      buildFeedbackRecord({ ...base, correction: "better", adjudicate: true }).adjudication,
    ).toBe(true);
    // absent flag → field omitted entirely (pre-B19 records stay byte-identical)
    expect("adjudication" in buildFeedbackRecord({ ...base, thumbs: "up" })).toBe(false);
    expect(
      "adjudication" in buildFeedbackRecord({ ...base, thumbs: "up", adjudicate: false }),
    ).toBe(false);
  });

  it("rejects a verdict-less adjudication (comment alone cannot settle a split)", () => {
    expect(() =>
      buildFeedbackRecord({ ...base, comment: "discussed offline", adjudicate: true }),
    ).toThrow(/verdict/);
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

  it("accepts a bare machine-judgment record with source watchme", () => {
    // The `watchme report --emit-feedback` bridge writes bare records with
    // source "watchme" to .crewhaus/feedback/watchme.jsonl — readers must
    // accept them like any other source.
    const r = record({
      source: "watchme",
      modality: "scale",
      rating: { scale: { value: 0.7, min: 0, max: 1 } },
    });
    expect(isFeedbackRecord(r)).toBe(true);
    expect(normalizeRating(r)).toBeCloseTo(0.7);
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

  it("stamps the B22 taxonomy: source production_log, channel in feedback_source", () => {
    const up = record({ turnNumber: 1, rating: { thumbs: "up" } });
    const r = distill(turns, [up], { minScore: 0.7 });
    const gold = r.samples.find((s) => s.id === `${SESSION}_t1`);
    // Distilled samples come from real sessions → canonical provenance is
    // "production_log"; the rating CHANNEL (what `source` used to carry)
    // moves to `feedback_source` so no information is lost.
    expect(gold?.metadata?.["source"]).toBe("production_log");
    expect(gold?.metadata?.["feedback_source"]).toBe("cli");
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

describe("distill redaction (B23)", () => {
  // A marker stub keeps the tests independent of the detector corpus — the
  // threading, not the regexes, is under test here (the real redactor's
  // equivalence is pinned in dataset-audit.test.ts).
  const redact = (t: string): string => t.replaceAll("PII", "[R]");
  const piiTurns: SessionTurn[] = [
    {
      sessionId: SESSION,
      turnNumber: 1,
      input: "question with PII",
      output: "answer with PII",
      toolNames: [],
    },
  ];

  it("redacts input, gold output, and free-text metadata before samples form", () => {
    const fb = record({ turnNumber: 1, rating: { thumbs: "up" }, comment: "note PII" });
    const r = distill(piiTurns, [fb], { minScore: 0.7, redact });
    const s = r.samples[0];
    expect(s?.input).toBe("question with [R]");
    expect(s?.expected_output).toBe("answer with [R]");
    expect(s?.metadata?.["comment"]).toBe("note [R]");
  });

  it("redacts a correction wherever it lands (gold + metadata) and the judge rubric", () => {
    const fb = record({
      turnNumber: 1,
      modality: "comment",
      rating: {},
      correction: "better PII answer",
      comment: "liked the PII part",
    });
    const r = distill(piiTurns, [fb], { minScore: 0.7, redact, judge: true });
    expect(r.samples[0]?.expected_output).toBe("better [R] answer");
    expect(r.samples[0]?.metadata?.["correction"]).toBe("better [R] answer");
    const judge = r.graders.graders[0];
    if (judge?.type !== "llm_judge") throw new Error("expected an llm_judge grader");
    const description = judge.rubric.criteria[0]?.description ?? "";
    expect(description).toContain("[R]");
    expect(description).not.toContain("PII");
  });

  it("without redact, text flows verbatim (byte-identical legacy behavior)", () => {
    const fb = record({ turnNumber: 1, rating: { thumbs: "up" }, comment: "note PII" });
    const r = distill(piiTurns, [fb], { minScore: 0.7 });
    expect(r.samples[0]?.input).toBe("question with PII");
    expect(r.samples[0]?.expected_output).toBe("answer with PII");
    expect(r.samples[0]?.metadata?.["comment"]).toBe("note PII");
  });

  it("redacts the rater identity (metadata.rater can be an email/chat handle)", () => {
    const fb = record({ turnNumber: 1, rating: { thumbs: "up" }, rater: "rater PII" });
    const r = distill(piiTurns, [fb], { minScore: 0.7, redact });
    expect(r.samples[0]?.metadata?.["rater"]).toBe("rater [R]");
  });

  it("output distilled with the REAL default redactor audits clean (round-trip)", () => {
    // Synthetic PII assembled from parts (push protection — no real-shaped
    // literal in source). rater is deliberately an email: the default
    // pipeline's own output must pass `dataset audit --strict`.
    const email = ["rater", "example.com"].join("@");
    const ssn = ["219", "09", "9999"].join("-");
    const turns: SessionTurn[] = [
      {
        sessionId: SESSION,
        turnNumber: 1,
        input: `my ssn is ${ssn}`,
        output: `wrote to ${email} as asked`,
        toolNames: [],
      },
    ];
    const fb = record({
      turnNumber: 1,
      rating: { thumbs: "up" },
      comment: `mail ${email} again`,
      rater: email,
    });
    const r = distill(turns, [fb], { minScore: 0.7, redact: redactDatasetText });
    expect(auditSamples(r.samples).totalHits).toBe(0);
    expect(r.samples[0]?.metadata?.["rater"]).toBe("[REDACTED:email]");
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

  it("never derives the phrase from redaction markers (B23) — real tokens win", () => {
    // Both outputs carry the redactor's marker; "redacted"/"email" would
    // otherwise tie the ranking and win alphabetically. The real shared
    // behavior tokens must be preferred instead.
    const g = synthesizeGraders([
      {
        turnNumber: 1,
        input: "",
        output: "your ticket [REDACTED:email] was refunded successfully",
        toolNames: [],
      },
      {
        turnNumber: 2,
        input: "",
        output: "the ticket [HASHED:email:0123456789abcdef] refunded is confirmed",
        toolNames: [],
      },
    ]);
    expect(g.graders[0]?.type).toBe("contains");
    const substring = (g.graders[0] as { substring: string }).substring;
    expect(["redacted", "hashed", "email"]).not.toContain(substring);
    expect(["ticket", "refunded"]).toContain(substring);
  });

  it("falls to the floor grader when markers are the only shared content (B23)", () => {
    const g = synthesizeGraders([
      { turnNumber: 1, input: "", output: "[REDACTED:credit_card]", toolNames: [] },
      { turnNumber: 2, input: "", output: "[REDACTED:credit_card] ok", toolNames: [] },
    ]);
    // Never a `contains: "redacted"` grader that live output could not pass.
    expect(g.graders[0]).toMatchObject({ type: "regex", pattern: "\\S" });
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

// ---------- B19 — multi-rater resolution ----------

describe("resolveFeedback (B19)", () => {
  const T = { threshold: 0.7 };
  const vote = (
    rater: string,
    turnNumber: number,
    fields: Partial<FeedbackRecord> = {},
  ): FeedbackRecord =>
    record({
      id: `fb_${rater}_${turnNumber}`,
      rater,
      turnNumber,
      ts: `2026-07-0${turnNumber}T00:00:00.000Z`,
      ...fields,
    });

  it("single-rater turns fold byte-identically to mergeFeedback (also no-rater records)", () => {
    const records = [
      record({ turnNumber: 1, rating: { thumbs: "up" }, ts: "2026-01-01T00:00:00Z" }),
      record({
        turnNumber: 1,
        modality: "comment",
        rating: {},
        comment: "nice",
        ts: "2026-02-01T00:00:00Z",
      }),
      record({ id: "fb_b", turnNumber: 2, rating: { thumbs: "down" } }),
    ];
    const r = resolveFeedback(records, T);
    expect(r.resolved).toEqual(mergeFeedback(records));
    expect(r.agreement).toEqual([]);
    expect(r.ties).toEqual([]);
    expect(r.kappa).toBeUndefined();
  });

  it("all-thumbs multi-rater turns resolve by majority (2 up / 1 down → up)", () => {
    const r = resolveFeedback(
      [
        vote("alice", 1),
        vote("bob", 1, { rating: { thumbs: "down" }, modality: "binary" }),
        vote("carol", 1),
      ],
      T,
    );
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.rating).toEqual({ thumbs: "up" });
    expect(r.resolved[0]?.modality).toBe("binary");
    expect(r.agreement).toHaveLength(1);
    expect(r.agreement[0]?.resolution).toBe("majority");
    expect(r.agreement[0]?.unanimous).toBe(false);
    expect(r.ties).toEqual([]);
  });

  it("stars/scale (or mixed) votes resolve to the mean normalized score", () => {
    const r = resolveFeedback(
      [
        vote("alice", 1, { modality: "stars", rating: { stars: 3 } }), // 0.5
        vote("bob", 1, { modality: "stars", rating: { stars: 5 } }), // 1.0
      ],
      T,
    );
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.modality).toBe("scale");
    expect(r.resolved[0]?.rating.scale).toEqual({ value: 0.75, min: 0, max: 1 });
    expect(r.agreement[0]?.resolution).toBe("mean");
    expect(r.ties).toEqual([]);
  });

  it("a split thumbs vote with no adjudication is a TIE — withheld, not resolved", () => {
    const r = resolveFeedback(
      [vote("alice", 1), vote("bob", 1, { rating: { thumbs: "down" }, modality: "binary" })],
      T,
    );
    expect(r.resolved).toEqual([]);
    expect(r.ties).toHaveLength(1);
    expect(r.ties[0]?.resolution).toBe("tie");
    expect(r.agreement).toHaveLength(1); // ties still count as multi-rater turns
  });

  it("an adjudication always wins — even against the majority — and closes the turn", () => {
    const r = resolveFeedback(
      [
        vote("alice", 1),
        vote("bob", 1),
        vote("lead", 1, {
          rating: { thumbs: "down" },
          modality: "binary",
          adjudication: true,
          comment: "hallucinated the citation",
          ts: "2026-07-01T01:00:00.000Z",
        }),
      ],
      T,
    );
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.rating.thumbs).toBe("down"); // minority adjudication wins
    expect(r.resolved[0]?.comment).toBe("hallucinated the citation");
    expect(r.agreement[0]?.resolution).toBe("adjudicated");
    expect(r.ties).toEqual([]);
  });

  it("an adjudication settles a split thumbs vote (no tie enqueued)", () => {
    const r = resolveFeedback(
      [
        vote("alice", 1),
        vote("bob", 1, { rating: { thumbs: "down" }, modality: "binary" }),
        vote("lead", 1, {
          rating: { thumbs: "up" },
          modality: "binary",
          adjudication: true,
          ts: "2026-07-01T02:00:00.000Z",
        }),
      ],
      T,
    );
    expect(r.ties).toEqual([]);
    expect(r.resolved[0]?.rating.thumbs).toBe("up");
    expect(r.agreement[0]?.resolution).toBe("adjudicated");
  });

  it("a rating-less, correction-less adjudication does NOT settle a split — still a tie", () => {
    // Pre-guard pathology: folding the comment-only adjudication last kept
    // whichever disputing rater voted LAST (bob-down here) and stamped the
    // turn "adjudicated" — the label flipped if alice/bob swapped timestamps.
    const r = resolveFeedback(
      [
        vote("alice", 1),
        vote("bob", 1, {
          rating: { thumbs: "down" },
          modality: "binary",
          ts: "2026-07-01T01:00:00.000Z",
        }),
        vote("lead", 1, {
          modality: "comment",
          rating: {},
          comment: "discussed offline",
          adjudication: true,
          ts: "2026-07-01T02:00:00.000Z",
        }),
      ],
      T,
    );
    expect(r.resolved).toEqual([]);
    expect(r.ties).toHaveLength(1);
    expect(r.ties[0]?.resolution).toBe("tie");
    expect(r.agreement[0]?.resolution).toBe("tie");
  });

  it("a correction-only adjudication settles the split (the correction is the verdict)", () => {
    const r = resolveFeedback(
      [
        vote("alice", 1),
        vote("bob", 1, {
          rating: { thumbs: "down" },
          modality: "binary",
          ts: "2026-07-01T01:00:00.000Z",
        }),
        vote("lead", 1, {
          modality: "comment",
          rating: {},
          correction: "the better answer",
          adjudication: true,
          ts: "2026-07-01T02:00:00.000Z",
        }),
      ],
      T,
    );
    expect(r.ties).toEqual([]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]?.correction).toBe("the better answer");
    expect(r.agreement[0]?.resolution).toBe("adjudicated");
  });

  it("computes the hand-checked overall Cohen's kappa (agree 3/4 → κ = 0.5)", () => {
    // Rater A: up up down up; rater B: up up down down over turns 1–4.
    // po = 3/4; marginals A(pos)=3/4 A(neg)=1/4, B(pos)=1/2 B(neg)=1/2 →
    // pe = 3/8 + 1/8 = 1/2 → κ = (0.75 − 0.5)/(1 − 0.5) = 0.5.
    const a = (n: number, thumbs: "up" | "down") =>
      vote("a", n, { rating: { thumbs }, modality: "binary" });
    const b = (n: number, thumbs: "up" | "down") =>
      vote("b", n, { rating: { thumbs }, modality: "binary", ts: `2026-07-0${n}T01:00:00.000Z` });
    const r = resolveFeedback(
      [
        a(1, "up"),
        b(1, "up"),
        a(2, "up"),
        b(2, "up"),
        a(3, "down"),
        b(3, "down"),
        a(4, "up"),
        b(4, "down"),
      ],
      T,
    );
    expect(r.kappa).toBeCloseTo(0.5, 10);
    expect(r.resolved).toHaveLength(3); // turn 4 is a tie
    expect(r.ties).toHaveLength(1);
    expect(r.ties[0]?.turnNumber).toBe(4);
  });
});

describe("cohenKappa", () => {
  it("matches the hand computation on a 4-item binary case", () => {
    const k = cohenKappa([
      ["pos", "pos"],
      ["pos", "pos"],
      ["neg", "neg"],
      ["pos", "neg"],
    ]);
    expect(k).toBeCloseTo(0.5, 10);
  });

  it("is undefined on empty input, 1 on trivially perfect agreement, 0 on opposed constants", () => {
    expect(cohenKappa([])).toBeUndefined();
    expect(
      cohenKappa([
        ["pos", "pos"],
        ["pos", "pos"],
      ]),
    ).toBe(1);
    expect(
      cohenKappa([
        ["pos", "neg"],
        ["pos", "neg"],
      ]),
    ).toBe(0);
  });
});

describe("distill multi-rater (B19)", () => {
  const turns: SessionTurn[] = [
    { sessionId: SESSION, turnNumber: 1, input: "q1", output: "good answer", toolNames: [] },
    { sessionId: SESSION, turnNumber: 2, input: "q2", output: "meh answer", toolNames: [] },
  ];
  const vote = (
    rater: string,
    turnNumber: number,
    thumbs: "up" | "down",
    extra: Partial<FeedbackRecord> = {},
  ): FeedbackRecord =>
    record({ id: `fb_${rater}_${turnNumber}`, rater, turnNumber, rating: { thumbs }, ...extra });

  it("records every rater's verdict in metadata.ratings on multi-rater turns only", () => {
    const r = distill(
      turns,
      [vote("alice", 1, "up"), vote("bob", 1, "up"), vote("alice", 2, "down")],
      { minScore: 0.7 },
    );
    const multi = r.samples.find((s) => s.id === `${SESSION}_t1`);
    const single = r.samples.find((s) => s.id === `${SESSION}_t2`);
    expect(multi?.metadata?.["ratings"]).toEqual([
      { rater: "alice", score: 1 },
      { rater: "bob", score: 1 },
    ]);
    expect(multi?.expected_output).toBe("good answer");
    expect(single?.metadata?.["ratings"]).toBeUndefined(); // single-rater unchanged
    expect(r.agreement?.perTurn).toHaveLength(1);
    expect(r.agreement?.kappa).toBe(1);
  });

  it("withholds tie turns from the samples, reports + warns, and keeps totalFeedback honest", () => {
    const r = distill(turns, [vote("alice", 1, "up"), vote("bob", 1, "down")], { minScore: 0.7 });
    expect(r.samples).toHaveLength(0);
    expect(r.ties).toHaveLength(1);
    expect(r.ties?.[0]?.sessionId).toBe(SESSION);
    expect(r.stats.totalFeedback).toBe(1); // the tie turn still counts as rated
    expect(r.warnings.join()).toContain("rater disagreement");
  });

  it("stamps metadata.adjudicated when an adjudication closed the turn", () => {
    const r = distill(
      turns,
      [
        vote("alice", 1, "up"),
        vote("bob", 1, "down"),
        vote("lead", 1, "up", { adjudication: true, ts: "2026-07-02T00:00:00.000Z" }),
      ],
      { minScore: 0.7 },
    );
    const s = r.samples.find((x) => x.id === `${SESSION}_t1`);
    expect(s?.metadata?.["adjudicated"]).toBe(true);
    expect(s?.expected_output).toBe("good answer");
    expect(r.ties).toBeUndefined();
  });

  it("keeps the single-rater result shape byte-identical (no agreement/ties fields)", () => {
    const r = distill(turns, [vote("alice", 1, "up")], { minScore: 0.7 });
    expect("agreement" in r).toBe(false);
    expect("ties" in r).toBe(false);
  });
});

describe("formatAgreementLines (B19)", () => {
  it("prints the kappa header plus one line per turn incl. the TIE marker", () => {
    const lines = formatAgreementLines({
      perTurn: [
        {
          sessionId: SESSION,
          turnNumber: 1,
          votes: [
            { rater: "alice", score: 1, thumbs: "up" },
            { rater: "bob", score: 0, thumbs: "down" },
          ],
          resolution: "tie",
          unanimous: false,
        },
        {
          sessionId: SESSION,
          turnNumber: 2,
          votes: [
            { rater: "alice", score: 0.5 },
            { rater: "", score: 1 },
          ],
          resolution: "mean",
          unanimous: false,
        },
      ],
      kappa: -0.25,
    });
    expect(lines[0]).toContain("Cohen's kappa -0.25");
    expect(lines[1]).toContain("alice up / bob down");
    expect(lines[1]).toContain("TIE");
    expect(lines[2]).toContain("(unattributed) 1.00");
    expect(lines[2]).toContain("mean 0.75");
  });
});
