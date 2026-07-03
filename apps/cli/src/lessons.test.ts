import { describe, expect, test } from "bun:test";
import { createPiiRedactor } from "@crewhaus/pii-redactor";
import { SYNTHESIZE_PII_DETECTORS } from "./dataset-mine";
import type { FeedbackRecord, SessionTurn } from "./feedback";
import {
  type Lesson,
  mergeLessons,
  mineLessons,
  minePreferences,
  parseLessonsMd,
  renderLessonsMd,
  renderPreferencesMd,
} from "./lessons";

function turn(sessionId: string, turnNumber: number, input: string, output: string): SessionTurn {
  return { sessionId, turnNumber, input, output, toolNames: [] };
}

function fb(
  sessionId: string,
  turnNumber: number,
  fields: Partial<FeedbackRecord>,
): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: `${sessionId}_${turnNumber}`,
    sessionId,
    turnNumber,
    modality: "comment",
    rating: {},
    source: "user",
    ts: `2026-07-01T00:00:0${turnNumber}.000Z`,
    ...fields,
  } as FeedbackRecord;
}

const S1 = "sess_00000000000000e1";

describe("mineLessons (#56)", () => {
  test("turns corrections + low-rated comments + failures into lessons", async () => {
    const turns = [turn(S1, 1, "how do I deploy?", "wrong")];
    const feedback = [
      fb(S1, 1, { correction: "use crewhaus deploy" }),
      fb(S1, 2, {
        modality: "binary",
        rating: { thumbs: "down" },
        comment: "too verbose",
        turnNumber: 2,
      }),
    ];
    const lessons = await mineLessons(turns, feedback, [
      { input: "list files", reason: "2 consecutive tool errors in this turn" },
    ]);
    const texts = lessons.map((l) => l.text.toLowerCase());
    expect(texts.some((t) => t.includes("crewhaus deploy"))).toBe(true);
    expect(texts.some((t) => t.includes("too verbose"))).toBe(true);
    expect(texts.some((t) => t.includes("tool errors"))).toBe(true);
    // corrections sort before failure-fixes
    expect(lessons[lessons.length - 1]?.kind).toBe("failure-fix");
  });

  test("dedupes identical lessons; deterministic across runs", async () => {
    const turns = [turn(S1, 1, "q", "a")];
    const feedback = [fb(S1, 1, { correction: "do X" })];
    const sig = [
      { input: "q", reason: "runtime error: boom" },
      { input: "q", reason: "runtime error: boom" },
    ];
    const first = await mineLessons(turns, feedback, sig);
    const second = await mineLessons(turns, feedback, sig);
    expect(first.map((l) => l.key)).toEqual(second.map((l) => l.key));
    // "runtime error: boom" appears once despite two signals
    expect(first.filter((l) => l.text.includes("boom"))).toHaveLength(1);
  });

  test("redacts a pasted credential from a correction lesson", async () => {
    const secret = ["sk", "-", "A".repeat(40)].join("");
    const turns = [turn(S1, 1, "give a key", "no")];
    const feedback = [fb(S1, 1, { correction: `the key is ${secret}` })];
    const redactor = createPiiRedactor({ regexDetectors: SYNTHESIZE_PII_DETECTORS });
    const lessons = await mineLessons(turns, feedback, [], {
      redact: async (t) => (await redactor.redact(t)).text,
    });
    expect(lessons.some((l) => l.text.includes(secret))).toBe(false);
  });
});

describe("renderLessonsMd + parseLessonsMd idempotency (#56)", () => {
  // Keys are text-derived (normalized) — exactly what mineLessons produces —
  // so parse → merge round-trips without key drift.
  const lessons: Lesson[] = [
    { key: "avoid — x", text: "avoid — X", kind: "correction" },
    { key: "watch out: y.", text: "Watch out: Y.", kind: "failure-fix" },
  ];

  test("round-trips through render → parse → merge without duplicating", () => {
    const md = renderLessonsMd(lessons);
    const { preamble, lessons: parsed } = parseLessonsMd(md);
    expect(parsed.map((l) => l.key).sort()).toEqual(["avoid — x", "watch out: y."]);
    // re-merge with the same lessons yields no growth (keys match)
    const merged = mergeLessons(parsed, lessons);
    expect(merged).toHaveLength(2);
    // re-render is byte-identical (idempotent)
    expect(renderLessonsMd(merged, preamble)).toBe(md);
  });

  test("preserves a human-authored preamble above the marker", () => {
    const md = renderLessonsMd(
      lessons,
      "# LESSONS\n\nHand-written intro.\n\n<!-- crewhaus:lessons -->",
    );
    const { preamble } = parseLessonsMd(md);
    expect(preamble).toContain("Hand-written intro.");
    // a file with no marker is treated as all-preamble (never clobbered)
    const human = "# My lessons\n- do not touch\n";
    expect(parseLessonsMd(human)).toEqual({ preamble: human, lessons: [] });
  });
});

describe("minePreferences (#56)", () => {
  test("folds per-rater comments/corrections into deduped prefs", async () => {
    const feedback = [
      fb(S1, 1, { rater: "max", comment: "be concise" }),
      fb(S1, 2, { rater: "max", comment: "be concise", turnNumber: 2 }),
      fb(S1, 3, { rater: "alex", correction: "cite sources", turnNumber: 3 }),
    ];
    const prefs = await minePreferences(feedback);
    expect(prefs.map((p) => p.rater)).toEqual(["alex", "max"]);
    const max = prefs.find((p) => p.rater === "max");
    expect(max?.notes).toEqual(["be concise"]); // deduped
    const md = renderPreferencesMd(max as { rater: string; notes: string[] });
    expect(md).toContain("Preferences — max");
    expect(md).toContain("be concise");
  });

  test("ignores feedback with no rater identity", async () => {
    const prefs = await minePreferences([fb(S1, 1, { comment: "no rater" })]);
    expect(prefs).toHaveLength(0);
  });
});
