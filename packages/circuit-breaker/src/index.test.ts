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
import { CircuitBreakerOpenError, wrap } from "./index";

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
