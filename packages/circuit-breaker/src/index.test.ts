/**
 * Section 27 — `circuit-breaker` tests:
 *  - T1 state-machine per closed → open → half_open → closed transitions
 *  - T3 against a flaky stub adapter (10 failures → trip; cooldown elapsed → probe → success → close)
 *  - T9 property test on consecutive-failure window invariants
 */
import { describe, expect, test } from "bun:test";
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { type CircuitStateChangedEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { CircuitBreakerOpenError, isBillingError, wrap } from "./index";

function makeBus() {
  return new TraceEventBus({ runId: "run_test", sessionId: "sess_test" });
}

/** Stub adapter: yields a successful message_stop or throws on demand. */
function stubAdapter(opts: {
  shouldFail?: () => boolean;
  failError?: Error;
}): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: false,
      thinking: false,
      web_search: false,
    },
    estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
      return messages.length;
    },
    async *stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      if (opts.shouldFail?.()) {
        throw opts.failError ?? new Error("stub failure");
      }
      yield { kind: "message_start", usage: { input: 1, output: 1 } };
      yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
      yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } };
      yield { kind: "content_block_stop", index: 0 };
      yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
      yield { kind: "message_stop" };
    },
  };
}

const REQ: ProviderRequest = {
  model: "claude-opus-4-7",
  system: [],
  messages: [],
  maxTokens: 100,
};

async function drain(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ ok: boolean; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  try {
    for await (const e of stream) events.push(e);
    return { ok: true, events };
  } catch {
    return { ok: false, events };
  }
}

describe("circuit-breaker — T1 state machine", () => {
  test("starts in closed state", () => {
    const breaker = wrap(stubAdapter({}));
    expect(breaker.state()).toBe("closed");
  });

  test("trips to open after threshold consecutive failures", async () => {
    let n = 0;
    const adapter = stubAdapter({
      shouldFail: (): boolean => {
        n++;
        return true;
      },
    });
    const breaker = wrap(adapter, { failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      const result = await drain(breaker.stream(REQ));
      expect(result.ok).toBe(false);
    }
    expect(breaker.state()).toBe("open");
  });

  test("rejects immediately when open without touching adapter", async () => {
    let invocations = 0;
    const adapter = stubAdapter({
      shouldFail: (): boolean => {
        invocations++;
        return true;
      },
    });
    const breaker = wrap(adapter, { failureThreshold: 2, cooldownMs: 60_000 });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    const baseline = invocations;
    const events: StreamEvent[] = [];
    try {
      for await (const e of breaker.stream(REQ)) events.push(e);
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    }
    // The adapter should NOT have been invoked again.
    expect(invocations).toBe(baseline);
  });

  test("cooldown transition: open → half_open after cooldownMs", async () => {
    let nowMs = 1_000_000;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    nowMs += 5_001;
    expect(breaker.state()).toBe("half_open");
  });

  test("half_open + success → closed", async () => {
    let nowMs = 1_000_000;
    let mode: "fail" | "success" = "fail";
    const adapter = stubAdapter({
      shouldFail: (): boolean => mode === "fail",
    });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    nowMs += 5_001;
    expect(breaker.state()).toBe("half_open");
    mode = "success";
    const probe = await drain(breaker.stream(REQ));
    expect(probe.ok).toBe(true);
    expect(breaker.state()).toBe("closed");
  });

  test("half_open + failure → open", async () => {
    let nowMs = 1_000_000;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    nowMs += 5_001;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
  });

  test("reset() forces back to closed", async () => {
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, { failureThreshold: 2 });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    breaker.reset();
    expect(breaker.state()).toBe("closed");
  });
});

describe("circuit-breaker — T3 flaky-stub integration", () => {
  test("10 failures → trip; cooldown elapsed → probe → success → close", async () => {
    let nowMs = 0;
    let failureCount = 0;
    let mode: "fail" | "success" = "fail";
    const adapter = stubAdapter({
      shouldFail: (): boolean => {
        if (mode === "fail") {
          failureCount++;
          return true;
        }
        return false;
      },
    });
    const breaker = wrap(adapter, {
      failureThreshold: 10,
      windowMs: 60_000,
      cooldownMs: 30_000,
      now: (): number => nowMs,
    });
    for (let i = 0; i < 10; i++) {
      nowMs += 100;
      await drain(breaker.stream(REQ));
    }
    expect(failureCount).toBe(10);
    expect(breaker.state()).toBe("open");
    nowMs += 30_001;
    expect(breaker.state()).toBe("half_open");
    mode = "success";
    const r = await drain(breaker.stream(REQ));
    expect(r.ok).toBe(true);
    expect(breaker.state()).toBe("closed");
  });

  test("emits circuit_state_changed events when bus is provided", async () => {
    const bus = makeBus();
    const events: CircuitStateChangedEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "circuit_state_changed") events.push(e);
    });
    let nowMs = 0;
    let mode: "fail" | "success" = "fail";
    const adapter = stubAdapter({
      shouldFail: (): boolean => mode === "fail",
    });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 1000,
      bus,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    nowMs += 1001;
    expect(breaker.state()).toBe("half_open");
    mode = "success";
    await drain(breaker.stream(REQ));
    const transitions = events.map((e) => `${e.fromState}→${e.toState}`);
    expect(transitions).toEqual(["closed→open", "open→half_open", "half_open→closed"]);
  });

  test("pass-through: estimateTokens forwards to underlying adapter", () => {
    const adapter = stubAdapter({});
    const breaker = wrap(adapter);
    expect(breaker.estimateTokens([{ role: "user", content: "hi" }])).toBe(1);
    expect(breaker.providerId).toBe("anthropic");
    expect(breaker.features.caching).toBe("explicit");
  });
});

describe("circuit-breaker — T9 window invariants", () => {
  test("failures outside windowMs reset the consecutive count", async () => {
    let nowMs = 0;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 5,
      windowMs: 1000,
      cooldownMs: 60_000,
      now: (): number => nowMs,
    });
    // Two failures in window
    await drain(breaker.stream(REQ));
    nowMs += 100;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("closed");
    // Move past the window
    nowMs += 5_000;
    // A new failure starts a fresh count, so 4 more (not 3) needed to trip.
    for (let i = 0; i < 4; i++) {
      await drain(breaker.stream(REQ));
      expect(breaker.state()).toBe("closed");
    }
    nowMs += 100;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
  });

  test("isFailure predicate filters which errors count", async () => {
    let nowMs = 0;
    const adapter = stubAdapter({
      shouldFail: (): boolean => true,
      failError: new Error("4xx schema"),
    });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      isFailure: (err): boolean => {
        const msg = err instanceof Error ? err.message : String(err);
        return !msg.startsWith("4xx");
      },
      now: (): number => nowMs,
    });
    for (let i = 0; i < 5; i++) {
      nowMs += 100;
      await drain(breaker.stream(REQ));
    }
    // None of the 4xx errors counted, so still closed.
    expect(breaker.state()).toBe("closed");
  });
});

/** Adapter that yields a fixed sequence of events then returns (never throws). */
function scriptedAdapter(events: ReadonlyArray<StreamEvent>): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: false,
      thinking: false,
      web_search: false,
    },
    estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
      return messages.length;
    },
    async *stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      for (const e of events) yield e;
    },
  };
}

describe("circuit-breaker — stats() diagnostics", () => {
  test("reports closed/zeroed counters before any traffic", () => {
    const breaker = wrap(stubAdapter({}));
    expect(breaker.stats()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      transitions: 0,
      lastTrippedAt: undefined,
    });
  });

  test("tracks consecutiveFailures below the threshold", async () => {
    let nowMs = 0;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 5,
      windowMs: 60_000,
      cooldownMs: 60_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    nowMs += 10;
    await drain(breaker.stream(REQ));
    const s = breaker.stats();
    expect(s.state).toBe("closed");
    expect(s.consecutiveFailures).toBe(2);
    expect(s.transitions).toBe(0);
    expect(s.lastTrippedAt).toBeUndefined();
  });

  test("records transitions count and lastTrippedAt once tripped", async () => {
    let nowMs = 1_000;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 60_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    nowMs = 1_500;
    await drain(breaker.stream(REQ));
    const s = breaker.stats();
    expect(s.state).toBe("open");
    // Counter is reset to 0 on trip.
    expect(s.consecutiveFailures).toBe(0);
    // closed → open is a single transition.
    expect(s.transitions).toBe(1);
    expect(s.lastTrippedAt).toBe(1_500);
  });

  test("stats() drives the cooldown transition (open → half_open) as a side effect", async () => {
    let nowMs = 1_000;
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.stats().state).toBe("open");
    nowMs += 5_001;
    // Reading stats after cooldown elapses should observe half_open.
    const s = breaker.stats();
    expect(s.state).toBe("half_open");
    expect(s.transitions).toBe(2);
  });

  test("reset() zeroes stats and clears lastTrippedAt", async () => {
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, { failureThreshold: 2 });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.stats().lastTrippedAt).not.toBeUndefined();
    breaker.reset();
    expect(breaker.stats()).toEqual({
      state: "closed",
      consecutiveFailures: 0,
      // closed → open then the manual reset → 2 transitions total.
      transitions: 2,
      lastTrippedAt: undefined,
    });
  });

  test("reset() while already closed publishes no transition", () => {
    const breaker = wrap(stubAdapter({}));
    breaker.reset();
    expect(breaker.stats().transitions).toBe(0);
    expect(breaker.state()).toBe("closed");
  });
});

describe("circuit-breaker — stream terminal classification", () => {
  test("a terminal `error` event counts as a failure", async () => {
    const events: StreamEvent[] = [
      { kind: "message_start", usage: { input: 1, output: 1 } },
      { kind: "error", error: { type: "overloaded_error", message: "boom" } },
    ];
    const adapter = scriptedAdapter(events);
    const breaker = wrap(adapter, { failureThreshold: 2, cooldownMs: 60_000 });
    // The error event is yielded (not thrown), so draining "succeeds".
    const r1 = await drain(breaker.stream(REQ));
    expect(r1.ok).toBe(true);
    expect(r1.events.some((e) => e.kind === "error")).toBe(true);
    expect(breaker.state()).toBe("closed");
    // Second error event trips the breaker.
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    expect(breaker.stats().consecutiveFailures).toBe(0);
  });

  test("a stream that ends without message_stop counts as a failure", async () => {
    // Truncated stream: starts, emits a block, but never a message_stop.
    const events: StreamEvent[] = [
      { kind: "message_start", usage: { input: 1, output: 1 } },
      { kind: "content_block_start", index: 0, block: { type: "text", text: "" } },
    ];
    const adapter = scriptedAdapter(events);
    const breaker = wrap(adapter, { failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      const r = await drain(breaker.stream(REQ));
      // Truncated streams still drain cleanly (no throw).
      expect(r.ok).toBe(true);
    }
    expect(breaker.state()).toBe("open");
  });

  test("a clean message_stop records success and clears prior failures", async () => {
    let mode: "fail" | "ok" = "fail";
    const adapter = stubAdapter({ shouldFail: (): boolean => mode === "fail" });
    const breaker = wrap(adapter, { failureThreshold: 5, cooldownMs: 60_000 });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.stats().consecutiveFailures).toBe(2);
    mode = "ok";
    const r = await drain(breaker.stream(REQ));
    expect(r.ok).toBe(true);
    expect(breaker.stats().consecutiveFailures).toBe(0);
  });
});

describe("circuit-breaker — errorStream behaviour when open", () => {
  test("yields an `error` StreamEvent then throws CircuitBreakerOpenError", async () => {
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, { failureThreshold: 2, cooldownMs: 60_000 });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");

    const seen: StreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of breaker.stream(REQ)) seen.push(e);
    } catch (err) {
      thrown = err;
    }
    // Exactly one error event is emitted before the throw.
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first?.kind).toBe("error");
    const errorEvent = first as Extract<StreamEvent, { kind: "error" }>;
    expect(errorEvent).toEqual({
      kind: "error",
      error: { type: "CircuitBreakerOpenError", message: errorEvent.error.message },
    });
    expect(thrown).toBeInstanceOf(CircuitBreakerOpenError);
    expect((thrown as CircuitBreakerOpenError).name).toBe("CircuitBreakerOpenError");
    expect((thrown as CircuitBreakerOpenError).code).toBe("config");
    expect((thrown as Error).message).toContain("anthropic");
  });

  test("adapterName override surfaces in the open-circuit error", async () => {
    const adapter = stubAdapter({ shouldFail: (): boolean => true });
    const breaker = wrap(adapter, {
      adapterName: "anthropic/claude-opus",
      failureThreshold: 1,
      cooldownMs: 60_000,
    });
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    const r = await drain(breaker.stream(REQ));
    expect(r.ok).toBe(false);
    const errEvent = r.events.find((e) => e.kind === "error");
    expect(errEvent?.kind === "error" && errEvent.error.message).toContain("anthropic/claude-opus");
  });
});

describe("circuit-breaker — throw-based failures and isFailure on caught errors", () => {
  test("isFailure(false) on a thrown error keeps the breaker closed but still rethrows", async () => {
    const adapter = stubAdapter({
      shouldFail: (): boolean => true,
      failError: new Error("ignore-me"),
    });
    const breaker = wrap(adapter, {
      failureThreshold: 1,
      isFailure: (): boolean => false,
    });
    // The thrown error must still propagate to the caller...
    const r = await drain(breaker.stream(REQ));
    expect(r.ok).toBe(false);
    // ...but it must not count toward tripping.
    expect(breaker.state()).toBe("closed");
    expect(breaker.stats().consecutiveFailures).toBe(0);
  });
});

describe("circuit-breaker — trip() forced open (item 23)", () => {
  test("trip() forces a closed breaker open and blocks the next stream", async () => {
    const events: CircuitStateChangedEvent[] = [];
    const bus = makeBus();
    bus.subscribe((e) => {
      if (e.kind === "circuit_state_changed") events.push(e as CircuitStateChangedEvent);
    });
    const breaker = wrap(stubAdapter({}), { cooldownMs: 60_000, bus });
    expect(breaker.state()).toBe("closed");
    breaker.trip("switch-model recovery");
    expect(breaker.state()).toBe("open");
    // The forced-open transition published a circuit_state_changed event.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromState: "closed",
      toState: "open",
      reason: "switch-model recovery",
    });
    // A stream while open rejects without touching the adapter.
    const result = await drain(breaker.stream(REQ));
    expect(result.ok).toBe(false);
  });

  test("trip() default reason names switch-model", () => {
    const events: CircuitStateChangedEvent[] = [];
    const bus = makeBus();
    bus.subscribe((e) => {
      if (e.kind === "circuit_state_changed") events.push(e as CircuitStateChangedEvent);
    });
    const breaker = wrap(stubAdapter({}), { bus });
    breaker.trip();
    expect(events[0]?.reason).toContain("switch-model");
  });

  test("a tripped breaker still recovers via the normal cooldown → half_open path", async () => {
    let nowMs = 1_000;
    const breaker = wrap(stubAdapter({}), { cooldownMs: 5_000, now: (): number => nowMs });
    breaker.trip();
    expect(breaker.state()).toBe("open");
    nowMs += 5_001;
    // Cooldown elapsed — the breaker offers a half-open probe just like a
    // threshold-driven trip, so a transient blip auto-restores.
    expect(breaker.state()).toBe("half_open");
    const result = await drain(breaker.stream(REQ));
    expect(result.ok).toBe(true);
    expect(breaker.state()).toBe("closed");
  });

  test("trip() on an already-open breaker is a no-op (no duplicate event)", async () => {
    const events: CircuitStateChangedEvent[] = [];
    const bus = makeBus();
    bus.subscribe((e) => {
      if (e.kind === "circuit_state_changed") events.push(e as CircuitStateChangedEvent);
    });
    const breaker = wrap(stubAdapter({ shouldFail: (): boolean => true }), {
      failureThreshold: 1,
      cooldownMs: 60_000,
      bus,
    });
    await drain(breaker.stream(REQ)); // threshold trip → open
    expect(breaker.state()).toBe("open");
    const before = events.length;
    breaker.trip(); // already open — no transition
    expect(events.length).toBe(before);
  });
});

// ===========================================================================
// v0.3.0 Goal 6 (PR 2) — billing-class errors trip the breaker IMMEDIATELY
// (fail-fast) instead of accruing toward failureThreshold. The shapes below
// are the adapter-normalised wrappers the breaker actually sees.
// ===========================================================================

/** Adapter-normalised billing shapes, one per provider signal. */
const BILLING_SHAPES: ReadonlyArray<{ label: string; err: Error }> = [
  {
    label: "OpenAI 429 insufficient_quota (top-level code)",
    err: Object.assign(new Error("429 You exceeded your current quota"), {
      status: 429,
      code: "insufficient_quota",
    }),
  },
  {
    label: "insufficient_quota on the error envelope only",
    err: Object.assign(new Error("quota"), {
      status: 429,
      error: { code: "insufficient_quota", message: "You exceeded your current quota" },
    }),
  },
  {
    label: "Anthropic credit-balance 400",
    err: Object.assign(new Error("400 Bad Request"), {
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    }),
  },
  {
    label: "HTTP 402 payment required",
    err: Object.assign(new Error("402 Payment Required"), { status: 402 }),
  },
  {
    label: "Bedrock ServiceQuotaExceededException (by name)",
    err: Object.assign(new Error("maximum number of requests reached"), {
      name: "ServiceQuotaExceededException",
      status: 400,
    }),
  },
  {
    // The shape the breaker actually sees at runtime: an AdapterError
    // wrapper whose top-level `code` is CrewhausError's ErrorCode
    // ("adapter") — the provider code lives on the error envelope and must
    // not be shadowed.
    label: "AdapterError-wrapped insufficient_quota (top-level code occupied)",
    err: Object.assign(new Error("429 quota"), {
      code: "adapter",
      status: 429,
      error: { code: "insufficient_quota", message: "You exceeded your current quota" },
    }),
  },
];

describe("Goal 6 — isBillingError structural check", () => {
  for (const { label, err } of BILLING_SHAPES) {
    test(`${label} → true`, () => {
      expect(isBillingError(err)).toBe(true);
    });
  }

  test("non-billing shapes → false", () => {
    expect(isBillingError(Object.assign(new Error("boom"), { status: 500 }))).toBe(false);
    expect(isBillingError(Object.assign(new Error("slow down"), { status: 429 }))).toBe(false);
    expect(
      isBillingError(Object.assign(new Error("429"), { status: 429, code: "rate_limit_exceeded" })),
    ).toBe(false);
    expect(isBillingError(Object.assign(new Error("nope"), { status: 401 }))).toBe(false);
    // A credit-balance message WITHOUT the 400 status does not match.
    expect(isBillingError(new Error("Your credit balance is too low"))).toBe(false);
    expect(isBillingError(null)).toBe(false);
    expect(isBillingError("string")).toBe(false);
  });
});

describe("Goal 6 — fail-fast: billing errors trip the breaker immediately", () => {
  for (const { label, err } of BILLING_SHAPES) {
    test(`${label} → open after ONE failure (threshold 5 untouched)`, async () => {
      const adapter = stubAdapter({ shouldFail: (): boolean => true, failError: err });
      const breaker = wrap(adapter, { failureThreshold: 5, cooldownMs: 60_000 });
      const r = await drain(breaker.stream(REQ));
      // The error still propagates to the caller…
      expect(r.ok).toBe(false);
      // …and the breaker is open after a single failure.
      expect(breaker.state()).toBe("open");
      expect(breaker.stats().consecutiveFailures).toBe(0);
    });
  }

  test("the fail-fast trip publishes circuit_state_changed with a fail-fast reason", async () => {
    const events: CircuitStateChangedEvent[] = [];
    const bus = makeBus();
    bus.subscribe((e) => {
      if (e.kind === "circuit_state_changed") events.push(e as CircuitStateChangedEvent);
    });
    const billing = BILLING_SHAPES[0];
    if (billing === undefined) throw new Error("fixture missing");
    const adapter = stubAdapter({ shouldFail: (): boolean => true, failError: billing.err });
    const breaker = wrap(adapter, { failureThreshold: 5, bus });
    await drain(breaker.stream(REQ));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromState: "closed", toState: "open" });
    expect(events[0]?.reason).toContain("fail-fast");
  });

  test("regression: generic errors (plain 500) still accrue to the 5-failure threshold", async () => {
    let nowMs = 0;
    const adapter = stubAdapter({
      shouldFail: (): boolean => true,
      failError: Object.assign(new Error("500 internal"), { status: 500 }),
    });
    const breaker = wrap(adapter, { cooldownMs: 60_000, now: (): number => nowMs });
    for (let i = 0; i < 4; i++) {
      nowMs += 100;
      await drain(breaker.stream(REQ));
      expect(breaker.state()).toBe("closed");
    }
    nowMs += 100;
    await drain(breaker.stream(REQ));
    // Default threshold (5) reached only now.
    expect(breaker.state()).toBe("open");
  });

  test("a billing failure during the half_open probe reopens the breaker", async () => {
    let nowMs = 1_000;
    let failWith: Error = Object.assign(new Error("500"), { status: 500 });
    const adapter = stubAdapter({
      shouldFail: (): boolean => true,
      get failError(): Error {
        return failWith;
      },
    });
    const breaker = wrap(adapter, {
      failureThreshold: 2,
      cooldownMs: 5_000,
      now: (): number => nowMs,
    });
    await drain(breaker.stream(REQ));
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
    nowMs += 5_001;
    expect(breaker.state()).toBe("half_open");
    // The probe hits the (now out-of-funds) provider.
    failWith = Object.assign(new Error("402"), { status: 402 });
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
  });

  test("isFatal override (() => false) restores pure threshold behaviour", async () => {
    const billing = BILLING_SHAPES[0];
    if (billing === undefined) throw new Error("fixture missing");
    let nowMs = 0;
    const adapter = stubAdapter({ shouldFail: (): boolean => true, failError: billing.err });
    const breaker = wrap(adapter, {
      failureThreshold: 3,
      isFatal: (): boolean => false,
      now: (): number => nowMs,
    });
    nowMs += 100;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("closed");
    nowMs += 100;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("closed");
    nowMs += 100;
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
  });

  test("isFailure veto wins: a vetoed billing error neither counts nor fail-fasts", async () => {
    const billing = BILLING_SHAPES[0];
    if (billing === undefined) throw new Error("fixture missing");
    const adapter = stubAdapter({ shouldFail: (): boolean => true, failError: billing.err });
    const breaker = wrap(adapter, {
      failureThreshold: 1,
      isFailure: (): boolean => false,
    });
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("closed");
    expect(breaker.stats().consecutiveFailures).toBe(0);
  });

  test("a custom isFatal can widen fail-fast beyond billing", async () => {
    const adapter = stubAdapter({
      shouldFail: (): boolean => true,
      failError: Object.assign(new Error("model decommissioned"), { status: 410 }),
    });
    const breaker = wrap(adapter, {
      failureThreshold: 5,
      isFatal: (err): boolean => (err as { status?: number }).status === 410,
    });
    await drain(breaker.stream(REQ));
    expect(breaker.state()).toBe("open");
  });
});
