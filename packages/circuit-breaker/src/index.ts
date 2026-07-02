/**
 * Section 27 — `circuit-breaker`. Wraps a `ProviderAdapter` so a chain of
 * upstream failures trips the breaker and short-circuits subsequent calls
 * without ever touching the network. Three states:
 *
 *   closed → open       (after `failureThreshold` consecutive failures inside `windowMs`)
 *   open   → half_open  (after `cooldownMs`)
 *   half_open → closed  (probe call succeeded)
 *   half_open → open    (probe call failed)
 *
 * Composes with `model-router` for TypeScript-level failover: callers
 * hold one breaker per resolved model and route to the next candidate
 * when a breaker is open. That composition is built (item 22):
 * `model-router`'s `createFailoverChain` wraps each candidate of the
 * spec's `agent.model` + `agent.model_fallbacks` in its own breaker and
 * routes per call, with `agent.circuit_breaker` carrying this package's
 * tuning knobs. The wrapper does not own the fallback policy itself — it
 * just refuses to stream when open. Downstream `recovery-engine` is
 * upstream of the breaker; it should never retry into a tripped breaker.
 *
 * Optionally takes a `TraceEventBus` so state changes surface as
 * `circuit_state_changed` TraceEvents (audit-log, OTel, structured
 * printer). Without a bus, state changes are silent except for the
 * exposed `state()` getter.
 */
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";
import type { CircuitStateChangedEvent, TraceEventBus } from "@crewhaus/trace-event-bus";

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitBreakerOpenError extends CrewhausError {
  override readonly name = "CircuitBreakerOpenError";
  constructor(adapter: string, cause?: unknown) {
    super("config", `circuit breaker open for adapter ${adapter}`, cause);
  }
}

export type CircuitBreakerOptions = {
  /** Identifier surfaced on `circuit_state_changed`. Default: adapter.providerId. */
  readonly adapterName?: string;
  /** Trip threshold. Default: 5 consecutive failures. */
  readonly failureThreshold?: number;
  /** Window for counting consecutive failures. Default: 60s. */
  readonly windowMs?: number;
  /** How long to stay open before allowing a probe. Default: 30s. */
  readonly cooldownMs?: number;
  /** Optional bus for state-change events. */
  readonly bus?: TraceEventBus;
  /** Override `now()` for tests. Default: `Date.now()`. */
  readonly now?: () => number;
  /**
   * Predicate for which errors count toward the failure threshold. Default:
   * any thrown / caught error. Override to ignore expected errors (e.g.
   * 4xx schema-failure responses).
   */
  readonly isFailure?: (err: unknown) => boolean;
};

export interface WrappedAdapter extends ProviderAdapter {
  /** Current state. */
  state(): CircuitState;
  /** Reset the breaker to closed. */
  reset(): void;
  /** Diagnostic counters. */
  stats(): {
    state: CircuitState;
    consecutiveFailures: number;
    transitions: number;
    lastTrippedAt: number | undefined;
  };
}

export function wrap(adapter: ProviderAdapter, opts: CircuitBreakerOptions = {}): WrappedAdapter {
  const adapterName = opts.adapterName ?? adapter.providerId;
  const failureThreshold = opts.failureThreshold ?? 5;
  const windowMs = opts.windowMs ?? 60_000;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const isFailure = opts.isFailure ?? ((): boolean => true);
  const now = opts.now ?? ((): number => Date.now());

  let state: CircuitState = "closed";
  let consecutiveFailures = 0;
  let firstFailureMs = 0;
  let lastTrippedAt: number | undefined = undefined;
  let transitions = 0;

  function publishStateChange(from: CircuitState, to: CircuitState, reason?: string): void {
    transitions++;
    if (!opts.bus) return;
    const event: CircuitStateChangedEvent = {
      ...opts.bus.envelope(),
      kind: "circuit_state_changed",
      adapter: adapterName,
      fromState: from,
      toState: to,
      ...(reason !== undefined ? { reason } : {}),
    };
    opts.bus.publish(event);
  }

  function transitionTo(to: CircuitState, reason?: string): void {
    if (state === to) return;
    const from = state;
    state = to;
    if (to === "open") {
      lastTrippedAt = now();
    }
    publishStateChange(from, to, reason);
  }

  function checkCooldown(): void {
    if (state !== "open") return;
    if (lastTrippedAt === undefined) return;
    if (now() - lastTrippedAt >= cooldownMs) {
      transitionTo("half_open", `cooldown ${cooldownMs}ms elapsed`);
    }
  }

  function recordSuccess(): void {
    if (state === "half_open") {
      transitionTo("closed", "probe succeeded");
    }
    consecutiveFailures = 0;
    firstFailureMs = 0;
  }

  function recordFailure(err: unknown): void {
    if (!isFailure(err)) return;
    if (state === "half_open") {
      transitionTo("open", "probe failed");
      consecutiveFailures = 0;
      return;
    }
    const t = now();
    if (consecutiveFailures === 0 || t - firstFailureMs > windowMs) {
      firstFailureMs = t;
      consecutiveFailures = 1;
    } else {
      consecutiveFailures++;
    }
    if (consecutiveFailures >= failureThreshold) {
      transitionTo("open", `${consecutiveFailures} failures in ${t - firstFailureMs}ms`);
      consecutiveFailures = 0;
    }
  }

  return {
    providerId: adapter.providerId,
    features: adapter.features,
    estimateTokens: adapter.estimateTokens.bind(adapter),

    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      checkCooldown();
      if (state === "open") {
        const err = new CircuitBreakerOpenError(adapterName);
        return errorStream(err);
      }
      const upstream = adapter.stream(req);
      return wrapStream(upstream, recordSuccess, recordFailure);
    },

    state(): CircuitState {
      checkCooldown();
      return state;
    },

    reset(): void {
      const from = state;
      state = "closed";
      consecutiveFailures = 0;
      firstFailureMs = 0;
      lastTrippedAt = undefined;
      if (from !== "closed") {
        publishStateChange(from, "closed", "manual reset");
      }
    },

    stats(): {
      state: CircuitState;
      consecutiveFailures: number;
      transitions: number;
      lastTrippedAt: number | undefined;
    } {
      checkCooldown();
      return {
        state,
        consecutiveFailures,
        transitions,
        lastTrippedAt,
      };
    },
  };
}

async function* errorStream(err: Error): AsyncIterable<StreamEvent> {
  yield { kind: "error", error: { type: err.name, message: err.message } };
  throw err;
}

async function* wrapStream(
  upstream: AsyncIterable<StreamEvent>,
  recordSuccess: () => void,
  recordFailure: (err: unknown) => void,
): AsyncIterable<StreamEvent> {
  try {
    let sawMessageStop = false;
    let sawError = false;
    for await (const event of upstream) {
      if (event.kind === "error") sawError = true;
      if (event.kind === "message_stop") sawMessageStop = true;
      yield event;
    }
    if (sawError) {
      // Stream ended on an `error` event — count toward failures.
      recordFailure(new Error("upstream error event"));
    } else if (sawMessageStop) {
      recordSuccess();
    } else {
      // No clear terminal — treat as failure (likely truncated stream).
      recordFailure(new Error("stream ended without message_stop"));
    }
  } catch (err) {
    recordFailure(err);
    throw err;
  }
}
