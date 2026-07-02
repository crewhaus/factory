/**
 * Item 22 — spec-declared provider failover chain: the breaker-driven
 * meta-adapter the `circuit-breaker` package header always promised
 * ("callers hold one breaker per resolved model and route to the next
 * candidate when a breaker is open").
 *
 * A `FailoverChain` is itself a `ProviderAdapter` wrapping an ordered list
 * of candidates — the spec's `agent.model` first, then each entry of
 * `agent.model_fallbacks`. Every candidate gets its own
 * `@crewhaus/circuit-breaker` wrapper (same tuning, per-candidate state);
 * each `stream()` call routes to the FIRST candidate whose breaker is
 * closed or half-open:
 *
 *   - When a candidate's breaker trips open (its consecutive failures
 *     crossed `failureThreshold`), the next call routes onward to the next
 *     candidate — reason `breaker_open` on the `model_failover` trace event.
 *   - When a higher-priority candidate's cooldown elapses, its breaker
 *     reports half-open and the next call routes back UP to it as the
 *     probe — reason `probe_restore`. Probe success closes the breaker
 *     (traffic stays); probe failure re-opens it and the following call
 *     falls back again. This is the breaker package's own state machine,
 *     reused — the chain never re-implements the transition rules.
 *   - A candidate that cannot be constructed when actually tried (missing
 *     credential, uninstalled optional provider package) routes onward with
 *     reason `candidate_error`.
 *
 * Credentials resolve through the normal `resolveModel` path. Fallback
 * resolution failures NEVER hard-fail boot: `createFailoverChain` preflights
 * each fallback and folds failures into `warnings()` (surfaced
 * doctor-style on stderr by the runtime), keeps the candidate in the chain,
 * and re-attempts resolution whenever routing actually reaches it. Only the
 * PRIMARY resolves fail-fast — exactly the pre-chain behaviour.
 *
 * Mid-stream errors are NOT rerouted: once a candidate has started
 * yielding, partial output re-issued through another provider would
 * duplicate content. Errors propagate to the recovery-engine (upstream of
 * the breaker, as documented in `@crewhaus/circuit-breaker`); its retries
 * re-enter `stream()`, and once the failing candidate's breaker opens the
 * next attempt routes onward.
 *
 * Prompt-cache continuity: cache markers in the request are Anthropic-shaped
 * `cache_control` hints managed for the PRIMARY adapter. When the serving
 * candidate's `features.caching !== "explicit"` the chain strips every
 * `cache_control` marker from the system blocks and message content before
 * the request leaves the process — a cross-provider switch must not send
 * another provider's cache markers. Candidates WITH explicit caching keep
 * the markers verbatim: they are position hints (re-deriving them yields the
 * same blocks), and a cold cache on the fallback provider simply accrues
 * `cacheCreationTokens` on that provider's own `model_response` usage.
 */
import type {
  CanonicalMessage,
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { type CircuitState, type WrappedAdapter, wrap } from "@crewhaus/circuit-breaker";
import { CrewhausError } from "@crewhaus/errors";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";
import { parseModelString } from "./parse.js";
import { type ModelResolution, resolveModel } from "./router.js";

/**
 * Breaker tuning shared by every candidate in the chain. Mirrors the
 * spec's `agent.circuit_breaker` block, which mirrors the actual
 * `CircuitBreakerOptions` names — see `@crewhaus/circuit-breaker`.
 */
export type FailoverBreakerTuning = {
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
};

export type CreateFailoverChainOptions = {
  /** Primary spec model string (`agent.model`). Resolution failures throw. */
  readonly model: string;
  /** Ordered fallback spec model strings (`agent.model_fallbacks`). */
  readonly fallbacks: readonly string[];
  /** Per-candidate breaker tuning. Package defaults apply when omitted. */
  readonly breaker?: FailoverBreakerTuning;
  /**
   * Late-bound trace bus. Called at publish/wrap time rather than captured at
   * construction so a runtime that mints its bus AFTER adapter resolution
   * (runChatLoop) still surfaces `model_failover` + `circuit_state_changed`.
   */
  readonly getBus?: () => TraceEventBus | undefined;
  /** Env for credential resolution. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Clock override threaded into every candidate breaker (tests). */
  readonly now?: () => number;
  /**
   * Injection seam: pre-resolved adapters keyed by spec model string. A
   * candidate found here skips `resolveModel` entirely (its wire model id is
   * derived by best-effort parse, verbatim for synthetic test ids). Used by
   * runtime-core's `_adapter` / `_failoverAdapters` test seams and by chain
   * unit tests; production callers omit it.
   */
  readonly adapters?: ReadonlyMap<string, ProviderAdapter>;
};

/** The (spec string, wire id, provider) triple identifying one candidate. */
export type FailoverActiveInfo = {
  readonly modelString: string;
  readonly modelId: string;
  readonly providerId: ProviderId;
};

/** Diagnostic snapshot of one candidate's routing state. */
export type FailoverCandidateSnapshot = {
  readonly modelString: string;
  readonly modelId?: string;
  readonly providerId?: ProviderId;
  /** Absent until the candidate's breaker exists (first routing pass). */
  readonly breakerState?: CircuitState;
  /** Set when the candidate's last resolution attempt failed. */
  readonly unavailableReason?: string;
};

export interface FailoverChain extends ProviderAdapter {
  /**
   * Best-effort prediction of the candidate the next `stream()` call will
   * try first — what runtime-core stamps on `model_request`. Exact except
   * when a previously-unresolvable candidate resolves on the actual pass
   * (`lastServed()` after the call is always exact).
   */
  plan(): FailoverActiveInfo;
  /** The candidate that served (or is serving) the most recent stream. */
  lastServed(): FailoverActiveInfo;
  /**
   * Item 23 — force the LAST-SERVED candidate's breaker open so the next
   * `stream()` reroutes to the next candidate down the chain. Used by the
   * `switch-model` recovery action: on a matched provider error the
   * orchestrator abandons the active candidate for this turn instead of
   * burning backoff retries against it. Returns the model string of the
   * candidate that was tripped, or `undefined` when nothing could be
   * tripped (no stream has run, so the active candidate has no breaker
   * yet). The breaker's own cooldown/half-open probe still governs when the
   * tripped candidate is retried, so a transient blip auto-restores.
   */
  tripActive(reason?: string): string | undefined;
  /** Routing-state snapshot for every candidate, primary first. */
  candidates(): readonly FailoverCandidateSnapshot[];
  /**
   * Boot-time doctor-style warnings: one line per fallback whose preflight
   * resolution failed (missing credential / uninstalled provider package).
   * The candidate stays in the chain and is re-tried when routing reaches
   * it — these warn, they never hard-fail boot.
   */
  warnings(): readonly string[];
}

/**
 * Every candidate in the chain is open or unconstructible. Names each
 * candidate and its breaker state so the operator can see the whole chain's
 * health from the one error line.
 */
export class FailoverExhaustedError extends CrewhausError {
  override readonly name = "FailoverExhaustedError";
  constructor(candidates: readonly FailoverCandidateSnapshot[]) {
    const detail = candidates
      .map((c) =>
        c.unavailableReason !== undefined
          ? `"${c.modelString}" (unavailable: ${c.unavailableReason})`
          : `"${c.modelString}" (breaker ${c.breakerState ?? "closed"})`,
      )
      .join(", ");
    super("adapter", `model failover: every candidate is unavailable — ${detail}`);
  }
}

/** Wire model id for injected adapters: parse when possible, verbatim for
 *  synthetic test ids ("primary-model") the grammar rejects. Mirrors
 *  runtime-core's `bestEffortWireModelId`. */
function bestEffortModelId(modelString: string): string {
  try {
    return parseModelString(modelString).modelId;
  } catch {
    return modelString;
  }
}

type CandidateState = {
  readonly modelString: string;
  resolution: ModelResolution | undefined;
  breaker: WrappedAdapter | undefined;
  unavailableReason: string | undefined;
};

type RoutingSkip = {
  readonly index: number;
  readonly reason: "breaker_open" | "candidate_error";
};

export async function createFailoverChain(
  opts: CreateFailoverChainOptions,
): Promise<FailoverChain> {
  const env = opts.env ?? process.env;
  const breakerTuning = opts.breaker ?? {};

  const resolveCandidate = async (modelString: string): Promise<ModelResolution> => {
    const injected = opts.adapters?.get(modelString);
    if (injected !== undefined) {
      return {
        adapter: injected,
        modelId: bestEffortModelId(modelString),
        providerId: injected.providerId,
      };
    }
    return await resolveModel(modelString, env);
  };

  // Dedupe: a fallback equal to the primary (or to an earlier fallback)
  // would share breaker state anyway — keep the first occurrence only.
  const fallbackStrings: string[] = [];
  for (const m of opts.fallbacks) {
    if (m !== opts.model && !fallbackStrings.includes(m)) fallbackStrings.push(m);
  }

  // Primary resolves fail-fast — identical to the chain-less behaviour.
  const primaryResolution = await resolveCandidate(opts.model);
  const candidates: CandidateState[] = [
    {
      modelString: opts.model,
      resolution: primaryResolution,
      breaker: undefined,
      unavailableReason: undefined,
    },
  ];

  // Fallbacks preflight tolerantly: a failure becomes a doctor-style
  // warning (and a re-triable candidate), never a boot error.
  const warnings: string[] = [];
  for (const modelString of fallbackStrings) {
    const candidate: CandidateState = {
      modelString,
      resolution: undefined,
      breaker: undefined,
      unavailableReason: undefined,
    };
    try {
      candidate.resolution = await resolveCandidate(modelString);
    } catch (err) {
      candidate.unavailableReason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `fallback "${modelString}" is unavailable and will be skipped: ${candidate.unavailableReason}`,
      );
    }
    candidates.push(candidate);
  }

  let activeIndex = 0;
  let lastServedInfo: FailoverActiveInfo = infoFor(candidates[0] as CandidateState);

  function infoFor(c: CandidateState): FailoverActiveInfo {
    // Only called for resolved candidates (primary always; others once
    // routing reached them or preflight succeeded).
    const r = c.resolution as ModelResolution;
    return { modelString: c.modelString, modelId: r.modelId, providerId: r.providerId };
  }

  /** Resolve (or re-resolve) + breaker-wrap a candidate. False on failure. */
  async function ensureReady(c: CandidateState): Promise<boolean> {
    if (c.resolution === undefined) {
      try {
        c.resolution = await resolveCandidate(c.modelString);
        c.unavailableReason = undefined;
      } catch (err) {
        c.unavailableReason = err instanceof Error ? err.message : String(err);
        return false;
      }
    }
    if (c.breaker === undefined) {
      // Wrap lazily (first routing pass) so the late-bound bus is already
      // pointing at the run's real bus when circuit_state_changed events fire.
      const bus = opts.getBus?.();
      c.breaker = wrap(c.resolution.adapter, {
        ...breakerTuning,
        adapterName: `${c.resolution.providerId}/${c.resolution.modelId}`,
        ...(bus !== undefined ? { bus } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
    }
    return true;
  }

  function snapshot(): FailoverCandidateSnapshot[] {
    return candidates.map((c) => ({
      modelString: c.modelString,
      ...(c.resolution !== undefined
        ? { modelId: c.resolution.modelId, providerId: c.resolution.providerId }
        : {}),
      ...(c.breaker !== undefined ? { breakerState: c.breaker.state() } : {}),
      ...(c.unavailableReason !== undefined ? { unavailableReason: c.unavailableReason } : {}),
    }));
  }

  function publishFailover(
    from: CandidateState,
    to: CandidateState,
    reason: "breaker_open" | "probe_restore" | "candidate_error",
  ): void {
    const bus = opts.getBus?.();
    if (bus === undefined) return;
    bus.publish({
      ...bus.envelope(),
      kind: "model_failover",
      from: from.modelString,
      to: to.modelString,
      reason,
    });
  }

  /**
   * One routing pass: first candidate whose breaker admits traffic. Emits
   * `model_failover` events describing how the serving candidate changed
   * relative to the previous pass — one hop event per skipped candidate on
   * the way down, one `probe_restore` event on the way back up.
   */
  async function selectCandidate(): Promise<{ index: number; breaker: WrappedAdapter }> {
    const skips: RoutingSkip[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i] as CandidateState;
      if (!(await ensureReady(c))) {
        skips.push({ index: i, reason: "candidate_error" });
        continue;
      }
      const breaker = c.breaker as WrappedAdapter;
      if (breaker.state() === "open") {
        skips.push({ index: i, reason: "breaker_open" });
        continue;
      }
      // Selected. Emit transition events against the previous active.
      if (i < activeIndex) {
        publishFailover(candidates[activeIndex] as CandidateState, c, "probe_restore");
      } else if (i > activeIndex) {
        const hops = skips.filter((s) => s.index >= activeIndex);
        const path = [...hops.map((s) => s.index), i];
        for (let j = 0; j + 1 < path.length; j++) {
          publishFailover(
            candidates[path[j] as number] as CandidateState,
            candidates[path[j + 1] as number] as CandidateState,
            (hops[j] as RoutingSkip).reason,
          );
        }
      }
      activeIndex = i;
      lastServedInfo = infoFor(c);
      return { index: i, breaker };
    }
    throw new FailoverExhaustedError(snapshot());
  }

  /**
   * Build the candidate-specific request: rewrite `model` to the candidate's
   * wire id and strip cache markers when the candidate does not speak
   * explicit caching (see the module header's continuity contract).
   */
  function requestFor(req: ProviderRequest, c: CandidateState): ProviderRequest {
    const r = c.resolution as ModelResolution;
    const base: ProviderRequest = { ...req, model: r.modelId };
    if (r.adapter.features.caching === "explicit") return base;
    return {
      ...base,
      system: req.system.map((b) => stripCacheControl(b)),
      messages: req.messages.map((m) =>
        typeof m.content === "string"
          ? m
          : { ...m, content: m.content.map((b) => stripCacheControl(b)) },
      ),
    };
  }

  async function* routeStream(req: ProviderRequest): AsyncIterable<StreamEvent> {
    const selected = await selectCandidate();
    const candidate = candidates[selected.index] as CandidateState;
    yield* selected.breaker.stream(requestFor(req, candidate));
  }

  return {
    // The chain advertises the PRIMARY's identity/features: the spec's
    // declared model defines the capability envelope (tool_use gate, cache
    // manager activation); per-candidate divergence is handled per call.
    providerId: primaryResolution.providerId,
    features: primaryResolution.adapter.features,
    estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
      return primaryResolution.adapter.estimateTokens(messages);
    },
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      return routeStream(req);
    },
    plan(): FailoverActiveInfo {
      for (const c of candidates) {
        // A candidate that failed its last resolution attempt is not
        // planned on (stream() still re-tries it — see `lastServed`).
        if (c.resolution === undefined) continue;
        if (c.unavailableReason !== undefined) continue;
        if (c.breaker !== undefined && c.breaker.state() === "open") continue;
        return infoFor(c);
      }
      // Exhausted — the next stream() will throw; report the primary.
      return infoFor(candidates[0] as CandidateState);
    },
    lastServed(): FailoverActiveInfo {
      return lastServedInfo;
    },
    tripActive(reason?: string): string | undefined {
      const active = candidates[activeIndex] as CandidateState;
      if (active.breaker === undefined) return undefined;
      active.breaker.trip(reason);
      return active.modelString;
    },
    candidates(): readonly FailoverCandidateSnapshot[] {
      return snapshot();
    },
    warnings(): readonly string[] {
      return warnings;
    },
  };
}

/** Drop a `cache_control` marker from a canonical block, preserving type. */
function stripCacheControl<T extends object>(block: T): T {
  if (!("cache_control" in block)) return block;
  const { cache_control: _drop, ...rest } = block as T & { cache_control?: unknown };
  return rest as T;
}
