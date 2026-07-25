/**
 * Unit tests for the item-1 exit rating prompt. Moved here from
 * apps/cli/src/autodistill.test.ts when the prompt moved into the runtime so
 * COMPILED bundles get it too (the cli emitter used to drop the spec's
 * `feedback:` block entirely), plus the cases the move introduced: the
 * clean-exit gate and the injected-IO `runExitRating` orchestration.
 */
import { describe, expect, test } from "bun:test";
import type { ExitRatingFeedback, ExitRatingRecord } from "./exit-rating";
import {
  NO_EXIT_RATING_ENV,
  buildExitRatingRecord,
  parseExitRatingKey,
  runExitRating,
  shouldPromptExitRating,
} from "./exit-rating";

describe("shouldPromptExitRating", () => {
  const base = {
    stdinIsTTY: true,
    env: {} as Record<string, string | undefined>,
    feedback: {} as ExitRatingFeedback,
    assistantTurns: 2,
    cleanExit: true,
  };

  test("prompts when the block is present, TTY, and the session has answers", () => {
    expect(shouldPromptExitRating(base).prompt).toBe(true);
  });

  test("never prompts without a feedback block (presence opts in)", () => {
    expect(shouldPromptExitRating({ ...base, feedback: undefined }).prompt).toBe(false);
  });

  test("never prompts in non-TTY / piped mode", () => {
    expect(shouldPromptExitRating({ ...base, stdinIsTTY: false }).prompt).toBe(false);
  });

  test("CREWHAUS_NO_EXIT_RATING opts out (any truthy value)", () => {
    expect(shouldPromptExitRating({ ...base, env: { [NO_EXIT_RATING_ENV]: "1" } }).prompt).toBe(
      false,
    );
    expect(shouldPromptExitRating({ ...base, env: { [NO_EXIT_RATING_ENV]: "true" } }).prompt).toBe(
      false,
    );
    // Explicit zero/empty do not opt out.
    expect(shouldPromptExitRating({ ...base, env: { [NO_EXIT_RATING_ENV]: "0" } }).prompt).toBe(
      true,
    );
    expect(shouldPromptExitRating({ ...base, env: { [NO_EXIT_RATING_ENV]: "" } }).prompt).toBe(
      true,
    );
  });

  test("spec-level opt-outs: exitPrompt false / enabled false", () => {
    expect(shouldPromptExitRating({ ...base, feedback: { exitPrompt: false } }).prompt).toBe(false);
    expect(shouldPromptExitRating({ ...base, feedback: { enabled: false } }).prompt).toBe(false);
  });

  test("requires at least one assistant turn", () => {
    expect(shouldPromptExitRating({ ...base, assistantTurns: 0 }).prompt).toBe(false);
  });

  test("an aborted or crashed run is never offered for rating", () => {
    const decision = shouldPromptExitRating({ ...base, cleanExit: false });
    expect(decision.prompt).toBe(false);
    expect(decision.reason).toContain("cleanly");
  });
});

describe("parseExitRatingKey", () => {
  test("g/G → up, b/B → down", () => {
    expect(parseExitRatingKey("g")).toBe("up");
    expect(parseExitRatingKey("G")).toBe("up");
    expect(parseExitRatingKey("b")).toBe("down");
    expect(parseExitRatingKey("B")).toBe("down");
  });
  test("enter / timeout / anything else skips", () => {
    expect(parseExitRatingKey("\r")).toBe("skip");
    expect(parseExitRatingKey("\n")).toBe("skip");
    expect(parseExitRatingKey(undefined)).toBe("skip"); // timeout
    expect(parseExitRatingKey("")).toBe("skip");
    expect(parseExitRatingKey("x")).toBe("skip");
    expect(parseExitRatingKey("")).toBe("skip"); // Ctrl-C in raw mode
    expect(parseExitRatingKey("")).toBe("skip"); // Ctrl-D in raw mode
  });
});

describe("buildExitRatingRecord", () => {
  test("is the same user_feedback shape `crewhaus rate --thumbs` writes", () => {
    const record = buildExitRatingRecord({
      sessionId: "sess_0123456789abcdef",
      turnNumber: 3,
      thumbs: "up",
      id: "fb_deadbeef",
      ts: "2026-07-25T00:00:00.000Z",
    });
    expect(record).toEqual({
      schemaVersion: 1,
      id: "fb_deadbeef",
      sessionId: "sess_0123456789abcdef",
      turnNumber: 3,
      modality: "binary",
      rating: { thumbs: "up" },
      source: "cli",
      ts: "2026-07-25T00:00:00.000Z",
    });
  });

  test("mints an fb_-prefixed id and an ISO timestamp by default", () => {
    const record = buildExitRatingRecord({ sessionId: "sess_a", turnNumber: 1, thumbs: "down" });
    expect(record.id).toMatch(/^fb_[0-9a-f]{12}$/);
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.rating).toEqual({ thumbs: "down" });
  });
});

describe("runExitRating", () => {
  function harness(overrides: Partial<Parameters<typeof runExitRating>[0]> = {}) {
    const appended: ExitRatingRecord[] = [];
    const lines: string[] = [];
    const opts = {
      feedback: {} as ExitRatingFeedback,
      stdinIsTTY: true,
      env: {} as Record<string, string | undefined>,
      assistantTurns: 1,
      cleanExit: true,
      sessionId: "sess_0123456789abcdef",
      turnNumber: 4,
      readKey: async () => "g",
      append: async (r: ExitRatingRecord) => {
        appended.push(r);
      },
      write: (line: string) => {
        lines.push(line);
      },
      ...overrides,
    };
    return { opts, appended, lines };
  }

  test("a `g` keystroke appends a thumbs-up on the LAST turn and confirms", async () => {
    const { opts, appended, lines } = harness();
    expect(await runExitRating(opts)).toBe("up");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.rating).toEqual({ thumbs: "up" });
    expect(appended[0]?.turnNumber).toBe(4);
    expect(appended[0]?.sessionId).toBe("sess_0123456789abcdef");
    expect(lines.join("")).toContain("[feedback] recorded good on sess_0123456789abcdef turn 4");
  });

  test("a `b` keystroke appends a thumbs-down", async () => {
    const { opts, appended, lines } = harness({ readKey: async () => "b" });
    expect(await runExitRating(opts)).toBe("down");
    expect(appended[0]?.rating).toEqual({ thumbs: "down" });
    expect(lines.join("")).toContain("recorded bad");
  });

  test("skipping (enter/timeout) records nothing and prints nothing", async () => {
    const { opts, appended, lines } = harness({ readKey: async () => undefined });
    expect(await runExitRating(opts)).toBe("skip");
    expect(appended).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  test("a declined gate never reads a key", async () => {
    let reads = 0;
    const { opts, appended } = harness({
      feedback: undefined,
      readKey: async () => {
        reads += 1;
        return "g";
      },
    });
    expect(await runExitRating(opts)).toBeUndefined();
    expect(reads).toBe(0);
    expect(appended).toHaveLength(0);
  });

  test("an append failure is reported, not thrown (a rating never fails a run)", async () => {
    const errors: unknown[] = [];
    const { opts } = harness({
      append: async () => {
        throw new Error("event log closed");
      },
      onError: (err: unknown) => errors.push(err),
    });
    expect(await runExitRating(opts)).toBeUndefined();
    expect((errors[0] as Error).message).toBe("event log closed");
  });
});
