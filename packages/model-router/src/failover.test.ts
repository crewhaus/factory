/**
 * Item 22 — failover-chain tests:
 *  - construction (candidate order, dedupe, primary fail-fast)
 *  - breaker-open → next candidate, with `model_failover` events
 *  - half-open probe restore back to the primary (breaker semantics reused)
 *  - all-candidates-open → FailoverExhaustedError naming every candidate
 *  - missing-credential fallback: boot warning + skip-on-try (candidate_error)
 *  - per-candidate request rewrite (wire model id) + cache-marker stripping
 */
import { describe, expect, test } from "bun:test";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { type ModelFailoverEvent, type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { FailoverExhaustedError, createFailoverChain } from "./failover";

const FEATURES_EXPLICIT: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

/** Scripted adapter: fails while `failing()` is true, records every request. */
function scriptedAdapter(opts: {
  providerId?: ProviderId;
  caching?: ProviderFeatures["caching"];
  failing?: () => boolean;
  text?: string;
}): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: opts.providerId ?? "anthropic",
    features: { ...FEATURES_EXPLICIT, caching: opts.caching ?? "explicit" },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        if (opts.failing?.()) throw new Error("scripted upstream failure");
        yield { kind: "message_start", usage: { input: 1, output: 0 } } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: opts.text ?? "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const REQ: ProviderRequest = {
  model: "claude-opus-4-7",
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    },
  ],
  maxTokens: 64,
};

async function drain(stream: AsyncIterable<StreamEvent>): Promise<{ ok: boolean; text: string }> {
  let text = "";
  try {
    for await (const e of stream) {
      if (e.kind === "content_block_delta" && e.delta.type === "text_delta") {
        text += e.delta.text;
      }
    }
    return { ok: true, text };
  } catch {
    return { ok: false, text };
  }
}

function makeBus(): { bus: TraceEventBus; failovers: ModelFailoverEvent[] } {
  const bus = new TraceEventBus({ runId: "run_failover", sessionId: "sess_failover" });
  const failovers: ModelFailoverEvent[] = [];
  bus.subscribe((e: TraceEvent) => {
    if (e.kind === "model_failover") failovers.push(e);
  });
  return { bus, failovers };
}

describe("createFailoverChain — construction", () => {
  test("orders candidates primary-first and dedupes repeats + primary echoes", async () => {
    const primary = scriptedAdapter({});
    const fallback = scriptedAdapter({ providerId: "openai" });
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini", "claude-opus-4-7", "openai/gpt-4o-mini"],
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    expect(chain.candidates().map((c) => c.modelString)).toEqual([
      "claude-opus-4-7",
      "openai/gpt-4o-mini",
    ]);
    expect(chain.providerId).toBe("anthropic");
    expect(chain.warnings()).toEqual([]);
    // plan() and lastServed() both start on the primary.
    expect(chain.plan().modelId).toBe("claude-opus-4-7");
    expect(chain.lastServed().modelString).toBe("claude-opus-4-7");
  });

  test("primary resolution failure throws (fail-fast, unchanged behaviour)", async () => {
    await expect(
      createFailoverChain({
        model: "groq/llama-3.3-70b",
        fallbacks: [],
        env: {},
      }),
    ).rejects.toThrow(/GROQ_API_KEY/);
  });

  test("fallback resolution failure warns instead of failing boot", async () => {
    const primary = scriptedAdapter({});
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["groq/llama-3.3-70b"],
      env: {},
      adapters: new Map([["claude-opus-4-7", primary]]),
    });
    expect(chain.warnings()).toHaveLength(1);
    expect(chain.warnings()[0]).toContain('fallback "groq/llama-3.3-70b" is unavailable');
    expect(chain.warnings()[0]).toContain("GROQ_API_KEY");
    const snap = chain.candidates()[1];
    expect(snap?.unavailableReason).toContain("GROQ_API_KEY");
  });
});

describe("createFailoverChain — routing", () => {
  test("healthy primary serves; request model is rewritten to the wire id", async () => {
    const primary = scriptedAdapter({ text: "primary" });
    const fallback = scriptedAdapter({ providerId: "openai", text: "fallback" });
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    const result = await drain(chain.stream(REQ));
    expect(result).toEqual({ ok: true, text: "primary" });
    expect(primary.requests[0]?.model).toBe("claude-opus-4-7");
    expect(fallback.requests).toHaveLength(0);
  });

  test("breaker open → next candidate, with breaker_open failover event", async () => {
    const primary = scriptedAdapter({ failing: () => true });
    const fallback = scriptedAdapter({ providerId: "openai", text: "fallback" });
    const { bus, failovers } = makeBus();
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 2, cooldownMs: 60_000 },
      getBus: () => bus,
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });

    // Two failures trip the primary's breaker; errors propagate upstream
    // (recovery-engine territory), the chain does not swallow them.
    expect((await drain(chain.stream(REQ))).ok).toBe(false);
    expect((await drain(chain.stream(REQ))).ok).toBe(false);
    expect(failovers).toHaveLength(0);

    // Third call routes to the fallback.
    const third = await drain(chain.stream(REQ));
    expect(third).toEqual({ ok: true, text: "fallback" });
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    });
    // The fallback saw ITS wire model id, not the primary's.
    expect(fallback.requests[0]?.model).toBe("gpt-4o-mini");
    expect(chain.lastServed()).toMatchObject({
      modelString: "openai/gpt-4o-mini",
      modelId: "gpt-4o-mini",
      providerId: "openai",
    });
    // Steady state on the fallback: no repeat events while the primary stays open.
    await drain(chain.stream(REQ));
    expect(failovers).toHaveLength(1);
  });

  test("half-open probe restores the primary after cooldown (probe_restore)", async () => {
    let now = 0;
    let primaryDown = true;
    const primary = scriptedAdapter({ failing: () => primaryDown, text: "primary" });
    const fallback = scriptedAdapter({ providerId: "openai", text: "fallback" });
    const { bus, failovers } = makeBus();
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 1, cooldownMs: 1_000 },
      getBus: () => bus,
      now: () => now,
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });

    expect((await drain(chain.stream(REQ))).ok).toBe(false); // trips (threshold 1)
    expect((await drain(chain.stream(REQ))).text).toBe("fallback");

    // Cooldown elapses; the primary recovers. The next call routes back up
    // as the half-open probe and its success closes the breaker.
    now = 2_000;
    primaryDown = false;
    expect(chain.plan().modelString).toBe("claude-opus-4-7");
    const probe = await drain(chain.stream(REQ));
    expect(probe).toEqual({ ok: true, text: "primary" });
    expect(failovers.map((e) => e.reason)).toEqual(["breaker_open", "probe_restore"]);
    expect(failovers[1]).toMatchObject({
      from: "openai/gpt-4o-mini",
      to: "claude-opus-4-7",
    });
    expect(chain.candidates()[0]?.breakerState).toBe("closed");
    // Traffic stays home afterwards, no further events.
    expect((await drain(chain.stream(REQ))).text).toBe("primary");
    expect(failovers).toHaveLength(2);
  });

  test("failed probe re-opens and the next call falls back again", async () => {
    let now = 0;
    const primary = scriptedAdapter({ failing: () => true });
    const fallback = scriptedAdapter({ providerId: "openai", text: "fallback" });
    const { bus, failovers } = makeBus();
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 1, cooldownMs: 1_000 },
      getBus: () => bus,
      now: () => now,
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    await drain(chain.stream(REQ)); // trip
    await drain(chain.stream(REQ)); // fallback serves
    now = 5_000;
    const probe = await drain(chain.stream(REQ)); // probe_restore, probe fails
    expect(probe.ok).toBe(false);
    const after = await drain(chain.stream(REQ)); // breaker_open again
    expect(after.text).toBe("fallback");
    expect(failovers.map((e) => e.reason)).toEqual([
      "breaker_open",
      "probe_restore",
      "breaker_open",
    ]);
  });

  test("all candidates open → FailoverExhaustedError naming every candidate + states", async () => {
    const primary = scriptedAdapter({ failing: () => true });
    const fallback = scriptedAdapter({ providerId: "openai", failing: () => true });
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    await drain(chain.stream(REQ)); // primary trips
    await drain(chain.stream(REQ)); // fallback trips
    // Exhaustion throws BEFORE the first yield — iterate directly so the
    // error object itself is inspectable (drain() maps throws to ok:false).
    let thrown: unknown;
    try {
      for await (const _ of chain.stream(REQ)) {
        // no events expected — exhaustion throws pre-yield
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FailoverExhaustedError);
    const message = (thrown as Error).message;
    expect(message).toContain('"claude-opus-4-7" (breaker open)');
    expect(message).toContain('"openai/gpt-4o-mini" (breaker open)');
  });

  test("unresolvable fallback skips with candidate_error and routes onward", async () => {
    const primary = scriptedAdapter({ failing: () => true });
    const last = scriptedAdapter({ providerId: "openai", text: "last" });
    const { bus, failovers } = makeBus();
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      // The middle candidate has no GROQ_API_KEY in this env — boot warns,
      // routing re-tries it when reached and hops onward.
      fallbacks: ["groq/llama-3.3-70b", "openai/gpt-4o-mini"],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
      env: {},
      getBus: () => bus,
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", last],
      ]),
    });
    expect(chain.warnings()).toHaveLength(1);

    await drain(chain.stream(REQ)); // primary trips
    const served = await drain(chain.stream(REQ));
    expect(served).toEqual({ ok: true, text: "last" });
    expect(failovers.map((e) => ({ from: e.from, to: e.to, reason: e.reason }))).toEqual([
      { from: "claude-opus-4-7", to: "groq/llama-3.3-70b", reason: "breaker_open" },
      { from: "groq/llama-3.3-70b", to: "openai/gpt-4o-mini", reason: "candidate_error" },
    ]);
  });
});

describe("createFailoverChain — tripActive (item 23 switch-model)", () => {
  test("tripActive() opens the served candidate so the next call reroutes onward", async () => {
    const primary = scriptedAdapter({ text: "primary" }); // healthy, but we abandon it
    const fallback = scriptedAdapter({ providerId: "openai", text: "fallback" });
    const { bus, failovers } = makeBus();
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 5, cooldownMs: 60_000 },
      getBus: () => bus,
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    // First call serves the healthy primary (creates its breaker).
    expect((await drain(chain.stream(REQ))).text).toBe("primary");
    expect(chain.lastServed().modelString).toBe("claude-opus-4-7");

    // switch-model: abandon the active candidate for this turn.
    const tripped = chain.tripActive("switch-model recovery");
    expect(tripped).toBe("claude-opus-4-7");
    expect(chain.candidates()[0]?.breakerState).toBe("open");

    // Next call reroutes to the fallback with a breaker_open failover event.
    expect((await drain(chain.stream(REQ))).text).toBe("fallback");
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    });
  });

  test("tripActive() returns undefined before any stream has run (no active breaker)", async () => {
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", scriptedAdapter({})],
        ["openai/gpt-4o-mini", scriptedAdapter({ providerId: "openai" })],
      ]),
    });
    expect(chain.tripActive()).toBeUndefined();
  });
});

describe("createFailoverChain — prompt-cache continuity", () => {
  test("explicit-caching candidate keeps cache_control markers verbatim", async () => {
    const primary = scriptedAdapter({ caching: "explicit" });
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", scriptedAdapter({ providerId: "openai" })],
      ]),
    });
    await drain(chain.stream(REQ));
    expect(primary.requests[0]?.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("cross-provider switch strips cache markers for non-explicit caching", async () => {
    const primary = scriptedAdapter({ failing: () => true });
    const fallback = scriptedAdapter({ providerId: "openai", caching: "automatic" });
    const chain = await createFailoverChain({
      model: "claude-opus-4-7",
      fallbacks: ["openai/gpt-4o-mini"],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
      adapters: new Map<string, ProviderAdapter>([
        ["claude-opus-4-7", primary],
        ["openai/gpt-4o-mini", fallback],
      ]),
    });
    await drain(chain.stream(REQ)); // trip primary
    await drain(chain.stream(REQ)); // fallback serves
    const req = fallback.requests[0];
    expect(req?.system[0]).toEqual({ type: "text", text: "sys" });
    const content = req?.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as ReadonlyArray<unknown>)[0]).toEqual({ type: "text", text: "hi" });
    // The original request object was not mutated.
    expect(REQ.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
