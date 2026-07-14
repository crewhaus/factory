import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUDGETS,
  BUILTIN_FAILURE_CLASSES,
  type NamedFailureClass,
  type RecoveryAction,
  RecoveryEngineError,
  advanceState,
  backoffMs,
  buildFailureReport,
  classify,
  initialRecoveryState,
  matchNamedFailure,
  recover,
  retryAfterMs,
} from "./index";

// Real provider error shapes, pinned. Sources: Anthropic SDK BadRequestError /
// AuthenticationError envelopes; OpenAI SDK RateLimitError with
// code "insufficient_quota" (the out-of-funds signal, distinct from a
// genuine rate limit).
const ANTHROPIC_CREDIT_BALANCE_400 = {
  name: "BadRequestError",
  status: 400,
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  message:
    "400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
} as const;

const OPENAI_INSUFFICIENT_QUOTA_429 = {
  name: "RateLimitError",
  status: 429,
  code: "insufficient_quota",
  error: {
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
  message: "429 You exceeded your current quota, please check your plan and billing details.",
} as const;

const ANTHROPIC_401 = {
  name: "AuthenticationError",
  status: 401,
  error: { type: "authentication_error", message: "invalid x-api-key" },
  message: "401 invalid x-api-key",
} as const;

const ANTHROPIC_403 = {
  name: "PermissionDeniedError",
  status: 403,
  error: {
    type: "permission_error",
    message: "Your API key does not have permission to use the specified resource.",
  },
  message: "403 Forbidden",
} as const;

const ANTHROPIC_RATE_LIMIT_429 = {
  name: "RateLimitError",
  status: 429,
  error: {
    type: "rate_limit_error",
    message: "Number of request tokens has exceeded your per-minute rate limit.",
  },
  message: "429 rate_limit_error",
} as const;

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
    // NOTE: 401 used to land here ("unknown"); since v0.3.0 Goal 6 it
    // classifies as "auth" (covered in the Goal 6 describe blocks below).
    expect(classify({ status: 418, message: "teapot" })).toBe("unknown");
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

  test("switch-model increments switchModelCount (item 23)", () => {
    const a = advanceState(initialRecoveryState, { kind: "switch-model" });
    expect(a.switchModelCount).toBe(1);
    expect(a.retryCount).toBe(0);
    expect(a.tombstoneCount).toBe(0);
  });

  test("fail leaves state unchanged", () => {
    const after = advanceState(initialRecoveryState, { kind: "fail", reason: "boom" });
    expect(after).toEqual(initialRecoveryState);
  });
});

// Item 23 — the opt-in `switch-model` recovery action. Only reachable via a
// declared failure_taxonomy entry (never a built-in classify() verdict).
describe("Item 23 — switch-model recovery action", () => {
  const taxonomy: NamedFailureClass[] = [
    { class: "provider_overloaded", pattern: "/(429|529|overloaded)/i", recovery: "switch-model" },
  ];

  test("a matched entry returns a switch-model action", () => {
    const action = recover(
      { message: "Error 529: overloaded_error" },
      initialRecoveryState,
      taxonomy,
    );
    expect(action.kind).toBe("switch-model");
  });

  test("built-in classify never produces switch-model (default runs unchanged)", () => {
    // 529 classifies as overloaded_or_5xx → retry when NO taxonomy is given.
    const action = recover({ status: 529, message: "overloaded" }, initialRecoveryState);
    expect(action.kind).toBe("retry");
  });

  test("switch-model respects its per-turn budget then fails", () => {
    const exhausted = {
      ...initialRecoveryState,
      switchModelCount: BUDGETS.MAX_SWITCH_MODELS,
    };
    const action = recover({ message: "429 rate limited" }, exhausted, taxonomy);
    expect(action.kind).toBe("fail");
    if (action.kind === "fail") {
      expect(action.reason).toContain("switch-model budget exhausted");
      expect(action.reason).toContain("provider_overloaded");
    }
  });

  test("walking the chain: budget permits MAX_SWITCH_MODELS hops", () => {
    let state = initialRecoveryState;
    for (let i = 0; i < BUDGETS.MAX_SWITCH_MODELS; i++) {
      const action = recover({ message: "overloaded" }, state, taxonomy);
      expect(action.kind).toBe("switch-model");
      state = advanceState(state, action);
    }
    // One past the budget → fail.
    expect(recover({ message: "overloaded" }, state, taxonomy).kind).toBe("fail");
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

// ===========================================================================
// v0.3.0 Goal 6 — billing / auth / rate_limit classes, halt action, builtin
// failure classes, and the finally-consumed `hint` field.
// ===========================================================================

describe("Goal 6 — classify: billing / auth / rate_limit", () => {
  test("Anthropic out-of-credit 400 → billing (not invalid_request)", () => {
    expect(classify(ANTHROPIC_CREDIT_BALANCE_400)).toBe("billing");
  });

  test("OpenAI 429 + code insufficient_quota → billing (not rate_limit)", () => {
    expect(classify(OPENAI_INSUFFICIENT_QUOTA_429)).toBe("billing");
  });

  test("insufficient_quota is detected on the nested error.code too", () => {
    expect(
      classify({
        status: 429,
        error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota" },
        message: "429 quota",
      }),
    ).toBe("billing");
  });

  test("a top-level code string does not shadow the envelope's insufficient_quota (PR 2)", () => {
    // The AdapterError wrapper shape: CrewhausError's ErrorCode occupies the
    // top-level `code` slot ("adapter"); the provider code rides error.code.
    expect(
      classify({
        name: "AdapterError",
        code: "adapter",
        status: 429,
        error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota" },
        message: "429 quota",
      }),
    ).toBe("billing");
  });

  test("HTTP 402 anywhere → billing", () => {
    expect(classify({ status: 402, message: "402 Payment Required" })).toBe("billing");
  });

  test("Bedrock ServiceQuotaExceededException (by name) → billing", () => {
    expect(
      classify({
        name: "ServiceQuotaExceededException",
        message: "You have reached the maximum number of requests for this account.",
      }),
    ).toBe("billing");
  });

  test("401 and 403 at runtime → auth", () => {
    expect(classify(ANTHROPIC_401)).toBe("auth");
    expect(classify(ANTHROPIC_403)).toBe("auth");
  });

  test("genuine 429 (not insufficient_quota) → rate_limit", () => {
    expect(classify(ANTHROPIC_RATE_LIMIT_429)).toBe("rate_limit");
    expect(classify({ status: 429, message: "429 slow down" })).toBe("rate_limit");
  });

  test("inner type rate_limit_error → rate_limit even without a status", () => {
    expect(
      classify({ error: { type: "rate_limit_error", message: "rate limited" }, message: "x" }),
    ).toBe("rate_limit");
  });
});

describe("Goal 6 — recover: billing and auth halt immediately", () => {
  test("Anthropic credit-balance 400 → halt with the billing report (exit 31)", () => {
    const action = recover(ANTHROPIC_CREDIT_BALANCE_400, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.title).toBe(BUILTIN_FAILURE_CLASSES.billing_exhausted.title);
    expect(action.report.exitCode).toBe(31);
    expect(action.report.detail).toContain("Your credit balance is too low");
  });

  test("OpenAI insufficient_quota 429 → halt on the FIRST call (never retried)", () => {
    // The old behavior burned 5 backoff retries before failing; the halt
    // must come from a fresh state, proving no retry is ever chosen.
    const action = recover(OPENAI_INSUFFICIENT_QUOTA_429, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.exitCode).toBe(31);
  });

  test("401 → halt with the auth report (exit 30)", () => {
    const action = recover(ANTHROPIC_401, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("auth");
    expect(action.report.exitCode).toBe(30);
    expect(action.report.detail).toContain("invalid x-api-key");
  });

  test("403 → halt with the auth report (exit 30)", () => {
    const action = recover(ANTHROPIC_403, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("auth");
    expect(action.report.exitCode).toBe(30);
  });

  test("halt leaves recovery state unchanged (terminal, like fail)", () => {
    const action = recover(ANTHROPIC_401, initialRecoveryState);
    expect(advanceState(initialRecoveryState, action)).toEqual(initialRecoveryState);
  });
});

describe("Goal 6 — recover: rate_limit retries honor Retry-After, then halt", () => {
  test("429 with retry-after header → retry with exactly that delay", () => {
    const err = { ...ANTHROPIC_RATE_LIMIT_429, headers: { "retry-after": "7" } };
    const action = recover(err, initialRecoveryState);
    expect(action.kind).toBe("retry");
    if (action.kind !== "retry") return;
    expect(action.delayMs).toBe(7_000);
    expect(action.attempt).toBe(1);
  });

  test("429 without retry-after → retry with the normal backoff window", () => {
    const action = recover(ANTHROPIC_RATE_LIMIT_429, initialRecoveryState);
    expect(action.kind).toBe("retry");
    if (action.kind !== "retry") return;
    expect(action.delayMs).toBeGreaterThanOrEqual(1_000);
    expect(action.delayMs).toBeLessThanOrEqual(1_250);
  });

  test("retry budget exhaustion → halt with the rate_limited report (exit 32)", () => {
    const exhausted = { ...initialRecoveryState, retryCount: BUDGETS.MAX_RETRIES };
    const action = recover(ANTHROPIC_RATE_LIMIT_429, exhausted);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("rate_limit");
    expect(action.report.exitCode).toBe(32);
  });

  test("walking the budget: MAX_RETRIES retries, then halt", () => {
    let state = initialRecoveryState;
    for (let i = 0; i < BUDGETS.MAX_RETRIES; i++) {
      const action = recover(ANTHROPIC_RATE_LIMIT_429, state);
      expect(action.kind).toBe("retry");
      state = advanceState(state, action);
    }
    expect(recover(ANTHROPIC_RATE_LIMIT_429, state).kind).toBe("halt");
  });
});

describe("Goal 6 — retryAfterMs", () => {
  test("reads delta-seconds from a plain headers object", () => {
    expect(retryAfterMs({ headers: { "retry-after": "30" } })).toBe(30_000);
    expect(retryAfterMs({ headers: { "Retry-After": "2" } })).toBe(2_000);
  });

  test("reads from a Headers instance (get())", () => {
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "5" }) })).toBe(5_000);
  });

  test("reads an HTTP-date form relative to now", () => {
    const now = Date.parse("2026-07-13T00:00:00Z");
    const ms = retryAfterMs(
      { headers: { "retry-after": "Mon, 13 Jul 2026 00:00:10 GMT" } },
      () => now,
    );
    expect(ms).toBe(10_000);
  });

  test("reads direct retryAfterMs / retryAfter fields", () => {
    expect(retryAfterMs({ retryAfterMs: 1_500 })).toBe(1_500);
    expect(retryAfterMs({ retryAfter: 3 })).toBe(3_000);
  });

  test("clamps into [0, RETRY_AFTER_CAP_MS]", () => {
    expect(retryAfterMs({ retryAfter: 86_400 })).toBe(BUDGETS.RETRY_AFTER_CAP_MS);
    const now = Date.parse("2026-07-13T00:00:10Z");
    // A date in the past clamps to 0, not a negative delay.
    expect(
      retryAfterMs({ headers: { "retry-after": "Mon, 13 Jul 2026 00:00:00 GMT" } }, () => now),
    ).toBe(0);
  });

  test("absent / malformed values → undefined", () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs({ headers: {} })).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": "soonish" } })).toBeUndefined();
  });
});

describe("Goal 6 — buildFailureReport provider attribution", () => {
  test("an AdapterError-shaped error attributes the provider in detail", () => {
    const report = buildFailureReport("billing_exhausted", {
      ...ANTHROPIC_CREDIT_BALANCE_400,
      providerId: "anthropic",
    });
    expect(report.detail).toBe(
      'Anthropic said: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."',
    );
    expect(report.remediation).toBe(
      "add credits at https://console.anthropic.com/settings/billing, then rerun.",
    );
  });

  test("without a providerId the raw text stands alone with the generic fix", () => {
    const report = buildFailureReport("billing_exhausted", ANTHROPIC_CREDIT_BALANCE_400);
    expect(report.detail).toBe(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    );
    expect(report.remediation).toBe(BUILTIN_FAILURE_CLASSES.billing_exhausted.remediation);
  });

  test("an unknown providerId is used verbatim", () => {
    const report = buildFailureReport("auth_invalid", {
      providerId: "acme",
      status: 401,
      message: "401 nope",
    });
    expect(report.detail).toBe('acme said: "401 nope"');
    expect(report.remediation).toBe(BUILTIN_FAILURE_CLASSES.auth_invalid.remediation);
  });

  test("every builtin entry carries a class, title, remediation, and exit code", () => {
    for (const entry of Object.values(BUILTIN_FAILURE_CLASSES)) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.remediation.length).toBeGreaterThan(0);
      expect(entry.exitCode).toBeGreaterThan(0);
    }
    expect(BUILTIN_FAILURE_CLASSES.billing_exhausted.exitCode).toBe(31);
    expect(BUILTIN_FAILURE_CLASSES.auth_invalid.exitCode).toBe(30);
    expect(BUILTIN_FAILURE_CLASSES.rate_limited.exitCode).toBe(32);
    expect(BUILTIN_FAILURE_CLASSES.crewhaus_budget.exitCode).toBe(33);
    expect(BUILTIN_FAILURE_CLASSES.mcp_boot_failure.exitCode).toBe(40);
  });
});

describe("Goal 6 — user failure_taxonomy overrides and the hint field", () => {
  test("a user entry beats the builtin billing halt (user overrides win)", () => {
    const taxonomy: NamedFailureClass[] = [
      { class: "billing_retry_anyway", pattern: "credit balance", recovery: "retry" },
    ];
    const action = recover(ANTHROPIC_CREDIT_BALANCE_400, initialRecoveryState, taxonomy);
    expect(action.kind).toBe("retry");
  });

  test("a matched fail entry WITH a hint → halt carrying the hint as remediation", () => {
    const taxonomy: NamedFailureClass[] = [
      {
        class: "credits_gone",
        pattern: "credit balance",
        recovery: "fail",
        hint: "top up the shared team account before rerunning.",
      },
    ];
    const action = recover(ANTHROPIC_CREDIT_BALANCE_400, initialRecoveryState, taxonomy);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.remediation).toBe("top up the shared team account before rerunning.");
    expect(action.report.title).toBe("failure_taxonomy: credits_gone");
    expect(action.report.detail).toContain("Your credit balance is too low");
    expect(action.report.exitCode).toBe(1);
  });

  test("budget exhaustion on a hinted entry also halts with the hint", () => {
    const taxonomy: NamedFailureClass[] = [
      {
        class: "flaky_tool",
        pattern: "ETIMEDOUT",
        recovery: "retry",
        hint: "the fetch tool times out on the corp proxy; set HTTPS_PROXY.",
      },
    ];
    const exhausted = { ...initialRecoveryState, retryCount: BUDGETS.MAX_RETRIES };
    const action = recover({ message: "ETIMEDOUT after 30s" }, exhausted, taxonomy);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.remediation).toBe(
      "the fetch tool times out on the corp proxy; set HTTPS_PROXY.",
    );
    expect(action.report.title).toContain("retry budget exhausted");
  });

  test("a matched fail entry WITHOUT a hint keeps the pre-0.3.0 fail action", () => {
    const taxonomy: NamedFailureClass[] = [
      { class: "hard_stop", pattern: "credit balance", recovery: "fail" },
    ];
    const action = recover(ANTHROPIC_CREDIT_BALANCE_400, initialRecoveryState, taxonomy);
    expect(action).toEqual({ kind: "fail", reason: "failure_taxonomy: hard_stop" });
  });
});

describe("Goal 6 — regression: everything else behaves exactly as before", () => {
  test("a plain 500 still retries then fails generically (no halt)", () => {
    const err = {
      name: "APIError",
      status: 500,
      error: { type: "api_error", message: "Internal server error" },
      message: "500 Internal Server Error",
    };
    expect(recover(err, initialRecoveryState).kind).toBe("retry");
    const exhausted = { ...initialRecoveryState, retryCount: BUDGETS.MAX_RETRIES };
    const action = recover(err, exhausted);
    expect(action).toEqual({
      kind: "fail",
      reason: "retry budget exhausted: 500 Internal Server Error",
    });
  });

  test("an overloaded_error still retries then fails generically (no halt)", () => {
    const err = {
      name: "APIError",
      status: 529,
      error: { type: "overloaded_error", message: "Overloaded" },
      message: "529 Overloaded",
    };
    expect(recover(err, initialRecoveryState).kind).toBe("retry");
    const exhausted = { ...initialRecoveryState, retryCount: BUDGETS.MAX_RETRIES };
    expect(recover(err, exhausted).kind).toBe("fail");
  });

  test("a generic 400 still tombstones (billing needs the credit-balance text)", () => {
    const err = {
      name: "BadRequestError",
      status: 400,
      error: { type: "invalid_request_error", message: "messages.0: invalid block" },
      message: "400 Bad Request",
    };
    expect(recover(err, initialRecoveryState)).toEqual({ kind: "tombstone" });
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
