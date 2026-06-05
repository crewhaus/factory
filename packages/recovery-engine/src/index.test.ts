import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGETS,
  type NamedFailureClass,
  type RecoveryAction,
  RecoveryEngineError,
  advanceState,
  backoffMs,
  classify,
  initialRecoveryState,
  matchNamedFailure,
  recover,
} from "./index";

describe("classify", () => {
  test("531/529/500 → overloaded_or_5xx", () => {
    expect(classify({ status: 503, message: "x" })).toBe("overloaded_or_5xx");
    expect(classify({ status: 529, message: "x" })).toBe("overloaded_or_5xx");
    expect(classify({ status: 500, message: "x" })).toBe("overloaded_or_5xx");
  });

  test("type: overloaded_error wins regardless of status", () => {
    expect(classify({ status: 200, error: { type: "overloaded_error" }, message: "x" })).toBe(
      "overloaded_or_5xx",
    );
  });

  test("400 invalid_request → invalid_request", () => {
    expect(
      classify({
        status: 400,
        error: { type: "invalid_request_error", message: "bad" },
        message: "bad",
      }),
    ).toBe("invalid_request");
  });

  test('"Prompt is too long" inside a 400 → prompt_too_long, not invalid_request', () => {
    expect(
      classify({
        status: 400,
        error: { type: "invalid_request_error", message: "Prompt is too long: 220k > 200k" },
        message: "Prompt is too long",
      }),
    ).toBe("prompt_too_long");
  });

  test("synthetic max_output_tokens → max_output_tokens", () => {
    expect(classify({ error: { type: "max_output_tokens" }, message: "stopped" })).toBe(
      "max_output_tokens",
    );
  });

  test("APIUserAbortError / AbortError → user_aborted", () => {
    expect(classify({ name: "APIUserAbortError", message: "aborted" })).toBe("user_aborted");
    expect(classify({ name: "AbortError", message: "aborted" })).toBe("user_aborted");
  });

  test("unknown shapes → unknown", () => {
    expect(classify(null)).toBe("unknown");
    expect(classify(undefined)).toBe("unknown");
    expect(classify({})).toBe("unknown");
    expect(classify({ status: 401, message: "auth" })).toBe("unknown");
  });
});

describe("recover — happy paths", () => {
  test("prompt_too_long → compact", () => {
    const action = recover(
      {
        status: 400,
        error: { type: "invalid_request_error", message: "Prompt is too long" },
        message: "Prompt is too long",
      },
      initialRecoveryState,
    );
    expect(action).toEqual({ kind: "compact" });
  });

  test("max_output_tokens → continue", () => {
    const action = recover(
      { error: { type: "max_output_tokens" }, message: "stopped" },
      initialRecoveryState,
    );
    expect(action).toEqual({ kind: "continue" });
  });

  test("5xx → retry with first-attempt backoff in [1000, 1250]", () => {
    const action = recover({ status: 503, message: "boom" }, initialRecoveryState);
    expect(action.kind).toBe("retry");
    if (action.kind !== "retry") return;
    expect(action.attempt).toBe(1);
    expect(action.delayMs).toBeGreaterThanOrEqual(1000);
    expect(action.delayMs).toBeLessThanOrEqual(1250);
  });

  test("invalid_request → tombstone", () => {
    const action = recover(
      {
        status: 400,
        error: { type: "invalid_request_error", message: "bad block" },
        message: "bad block",
      },
      initialRecoveryState,
    );
    expect(action).toEqual({ kind: "tombstone" });
  });

  test("user_aborted → fail with reason 'user_aborted'", () => {
    const action = recover({ name: "APIUserAbortError", message: "aborted" }, initialRecoveryState);
    expect(action).toEqual({ kind: "fail", reason: "user_aborted" });
  });

  test("unknown → fail with the original message", () => {
    const action = recover({ name: "TypeError", message: "boom" }, initialRecoveryState);
    expect(action).toEqual({ kind: "fail", reason: "boom" });
  });
});

describe("recover — budget exhaustion", () => {
  test("retry exhausts after MAX_RETRIES", () => {
    const state = { ...initialRecoveryState, retryCount: BUDGETS.MAX_RETRIES };
    const action = recover({ status: 503, message: "boom" }, state);
    expect(action.kind).toBe("fail");
  });

  test("compact exhausts after MAX_COMPACTS", () => {
    const state = { ...initialRecoveryState, compactCount: BUDGETS.MAX_COMPACTS };
    const action = recover(
      {
        status: 400,
        error: { type: "invalid_request_error", message: "Prompt is too long" },
        message: "Prompt is too long",
      },
      state,
    );
    expect(action.kind).toBe("fail");
  });

  test("continue exhausts after MAX_CONTINUES", () => {
    const state = { ...initialRecoveryState, continueCount: BUDGETS.MAX_CONTINUES };
    const action = recover({ error: { type: "max_output_tokens" }, message: "x" }, state);
    expect(action.kind).toBe("fail");
  });

  test("tombstone exhausts after MAX_TOMBSTONES", () => {
    const state = { ...initialRecoveryState, tombstoneCount: BUDGETS.MAX_TOMBSTONES };
    const action = recover(
      {
        status: 400,
        error: { type: "invalid_request_error", message: "bad" },
        message: "bad",
      },
      state,
    );
    expect(action.kind).toBe("fail");
  });
});

describe("backoffMs", () => {
  test("monotonic non-decreasing across attempts (with jitter=0)", () => {
    const zero = () => 0;
    const a0 = backoffMs(0, zero);
    const a1 = backoffMs(1, zero);
    const a2 = backoffMs(2, zero);
    const a3 = backoffMs(3, zero);
    expect(a0).toBeLessThanOrEqual(a1);
    expect(a1).toBeLessThanOrEqual(a2);
    expect(a2).toBeLessThanOrEqual(a3);
  });

  test("jitter stays within [0, 250]", () => {
    for (let i = 0; i < 100; i++) {
      const ms = backoffMs(0); // attempt 0 → exp = 1000
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(1250);
    }
  });

  test("caps at MAX_BACKOFF_MS + jitter", () => {
    const ms = backoffMs(20, () => 1); // 1000 * 2^20 → capped to 30_000, plus jitter 250
    expect(ms).toBeLessThanOrEqual(BUDGETS.MAX_BACKOFF_MS + BUDGETS.MAX_JITTER_MS);
  });
});

describe("advanceState", () => {
  test("retry increments retryCount", () => {
    const after = advanceState(initialRecoveryState, {
      kind: "retry",
      delayMs: 1000,
      attempt: 1,
    });
    expect(after.retryCount).toBe(1);
  });

  test("compact/continue/tombstone increment their respective counters", () => {
    const a = advanceState(initialRecoveryState, { kind: "compact" });
    expect(a.compactCount).toBe(1);
    const b = advanceState(initialRecoveryState, { kind: "continue" });
    expect(b.continueCount).toBe(1);
    const c = advanceState(initialRecoveryState, { kind: "tombstone" });
    expect(c.tombstoneCount).toBe(1);
  });

  test("fail leaves state unchanged", () => {
    const after = advanceState(initialRecoveryState, { kind: "fail", reason: "boom" });
    expect(after).toEqual(initialRecoveryState);
  });
});

// T4: replay over fixture file. Each entry has an expected action kind; we
// confirm classify() + recover() agree against an initial state.
describe("T4 — fixture replay", () => {
  type Fixture = {
    label: string;
    shape: unknown;
    expectedKind: RecoveryAction["kind"];
  };
  // `tsc -b` also compiles this file into `dist/`; resolve fixtures from the
  // source tree so both the src and dist test copies find errors.json.
  const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
  const fixturesPath = join(SRC_DIR, "__fixtures__", "errors.json");
  const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8")) as Fixture[];

  for (const f of fixtures) {
    test(`${f.label} → action.kind === "${f.expectedKind}"`, () => {
      const action = recover(f.shape, initialRecoveryState);
      expect(action.kind).toBe(f.expectedKind);
    });
  }
});

// Section 55 (Track A) — named failure taxonomy. The recovery engine
// consults user-declared classes before falling back to the built-in
// taxonomy. Source: NLAH (arxiv 2603.25723).
describe("Track A — named failure taxonomy", () => {
  const taxonomy: NamedFailureClass[] = [
    { class: "missing_artifact", pattern: "ENOENT", recovery: "tombstone" },
    { class: "verifier_failure", pattern: "verification failed", recovery: "continue" },
    { class: "rate_limit_429", pattern: "/^429\\b/", recovery: "retry" },
  ];

  test("substring pattern matches a named class", () => {
    const matched = matchNamedFailure({ message: "ENOENT: no such file or directory" }, taxonomy);
    expect(matched?.class).toBe("missing_artifact");
  });

  test("regex pattern matches a named class", () => {
    const matched = matchNamedFailure({ message: "429 too many requests" }, taxonomy);
    expect(matched?.class).toBe("rate_limit_429");
  });

  test("case-insensitive substring match", () => {
    const matched = matchNamedFailure({ message: "Verification Failed: bad output" }, taxonomy);
    expect(matched?.class).toBe("verifier_failure");
  });

  test("returns undefined when no entry matches", () => {
    expect(matchNamedFailure({ message: "completely unrelated" }, taxonomy)).toBeUndefined();
  });

  test("recover() uses named-class recovery when matched", () => {
    const action = recover({ message: "ENOENT bad path" }, initialRecoveryState, taxonomy);
    expect(action.kind).toBe("tombstone");
  });

  test("recover() falls through to built-in classify when no named match", () => {
    const action = recover({ status: 503, message: "overloaded" }, initialRecoveryState, taxonomy);
    expect(action.kind).toBe("retry");
  });

  test("named-class recovery respects per-turn budgets", () => {
    const exhausted = { ...initialRecoveryState, tombstoneCount: BUDGETS.MAX_TOMBSTONES };
    const action = recover({ message: "ENOENT bad path" }, exhausted, taxonomy);
    expect(action.kind).toBe("fail");
    if (action.kind === "fail") {
      expect(action.reason).toContain("missing_artifact");
    }
  });

  test("malformed regex pattern is skipped without throwing", () => {
    const badTaxonomy: NamedFailureClass[] = [
      { class: "bad", pattern: "/[unclosed/", recovery: "fail" },
    ];
    expect(() => matchNamedFailure({ message: "anything" }, badTaxonomy)).not.toThrow();
    expect(matchNamedFailure({ message: "anything" }, badTaxonomy)).toBeUndefined();
  });
});

describe("RecoveryEngineError", () => {
  test("carries the 'runtime' code and the RecoveryEngineError name", () => {
    const err = new RecoveryEngineError("boom");
    expect(err).toBeInstanceOf(RecoveryEngineError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RecoveryEngineError");
    expect(err.code).toBe("runtime");
    expect(err.message).toBe("boom");
  });

  test("preserves the underlying cause chain", () => {
    const cause = new Error("upstream");
    const err = new RecoveryEngineError("wrapped", cause);
    expect(err.cause).toBe(cause);
    // toJSON (inherited from CrewhausError) serializes the cause for logging.
    expect(err.toJSON()).toEqual({
      name: "RecoveryEngineError",
      code: "runtime",
      message: "wrapped",
      cause: { name: "Error", message: "upstream" },
    });
  });
});
