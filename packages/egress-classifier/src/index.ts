/**
 * Pillar 3 sink-side chokepoint — `egress-classifier`.
 *
 * `boundary-classifier` shipped the source half of the fabric: every cross-
 * trust-domain ingress (MCP / sub-agent / channel / federation / skill /
 * compaction / tool / chain) flows through `classifyBoundary(content, …)`,
 * which tags the verdict with a `TrustOrigin` so downstream readers know
 * *where* the content came from.
 *
 * That stops a malicious string from being silently absorbed into the
 * model's context. It does **not** stop the agent from later transmitting
 * that string to an external sink — a URL fetched, a channel message sent,
 * a federation outbound payload, an MCP tool invocation. OpenAI's "Designing
 * AI agents to resist prompt injection" (2026-05-08) and SACR's "Runtime
 * Security for AI Agents" (2026) converge on the same conclusion:
 * classification at the source is necessary but not sufficient. An attacker
 * who controls a source AND an accessible sink can lateral-move across the
 * agent's permissions even when every individual permission check passes.
 *
 * The egress classifier is the symmetric companion. Every external tool
 * call (any tool with `scope: "external"` in the tool-catalog) routes its
 * payload through `classifyEgress(payload, ctx, opts)` before invocation.
 * The classifier looks up the run-context's `dataLineage` map (populated
 * by `tagContent(ctx, content, origin)` at every boundary site) and checks
 * whether the outbound payload contains substrings from non-`"user"`
 * origins. A hit produces an `EgressVerdict`:
 *
 *   - `"pass"`   → no tagged content found OR origin policy is permissive
 *   - `"warn"`   → tagged content found; log + emit audit event but proceed
 *   - `"block"`  → tagged content found AND origin policy is strict; deny
 *
 * The default policy is **defense-in-depth, not defense-in-perimeter**:
 * `"user"`-origin content always passes (the user can do whatever they want
 * with their own data); content tagged from any other origin defaults to
 * `"warn"` for sinks the user explicitly configured, and `"block"` for
 * sinks reached through dynamic discovery (e.g., an MCP server the agent
 * loaded mid-session, a federation peer it joined at runtime).
 *
 * Single-chokepoint design parity with `boundary-classifier`: the fabric
 * only holds if every external-tool site uses the *same* classifier with
 * the *same* policy. A new external tool that re-implements egress checks
 * inline (or skips them for "performance") is a security regression, not
 * a perf optimisation.
 *
 * Catalog layer: R8 (extension of §18 safety primitives, symmetric to
 * `boundary-classifier`). Recipe: demos/recipes/51-egress-fabric.md.
 */
import { createHash } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";
import type { RunContext, TrustOrigin } from "@crewhaus/run-context";

export class EgressClassifierError extends CrewhausError {
  override readonly name = "EgressClassifierError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * The classifier's three possible verdicts. Callers (runtime-core's
 * pre-tool-call hook) inspect `action` and decide whether to block the
 * call, log + proceed, or proceed silently.
 */
export type EgressVerdict = "pass" | "warn" | "block";

/**
 * Where the egress is going. `"external-configured"` means a sink the user
 * explicitly wired in their spec (e.g. `tools: [fetch]` listed at compile
 * time). `"external-dynamic"` means a sink discovered at runtime (e.g. an
 * MCP server an agent registered mid-session, a federation peer that
 * joined the swarm). Dynamic sinks default to stricter policy because the
 * user never explicitly trusted them.
 */
export type SinkScope = "external-configured" | "external-dynamic";

export type EgressResult = {
  readonly verdict: EgressVerdict;
  /** Origins of tagged content found in the payload, deduped. Empty when no hits. */
  readonly originsFound: ReadonlyArray<TrustOrigin>;
  /** Number of distinct tagged strings that matched. */
  readonly matchCount: number;
  /** Was this verdict served from cache? */
  readonly fromCache: boolean;
  /** Sink the egress was destined for; passed through for audit logging. */
  readonly sinkId: string;
  readonly sinkScope: SinkScope;
};

/**
 * Per-origin default severity at egress time. `"user"` content is always
 * pass — the user can do whatever they want with their own data. Every
 * other origin defaults to `"warn"` on configured sinks (the user wired
 * the sink in deliberately, but we still log + flag the audit trail) and
 * `"block"` on dynamic sinks (the agent reached the sink without explicit
 * spec authorisation; combining that with cross-origin data is too close
 * to the social-engineering exfil pattern).
 *
 * Adding a new origin? Update both rows. The §41 `crewhaus doctor`
 * philosophy-alignment check catches drift.
 */
type SeverityMatrix = Record<TrustOrigin, Record<SinkScope, EgressVerdict>>;

const ORIGIN_DEFAULT_POLICY: SeverityMatrix = {
  user: { "external-configured": "pass", "external-dynamic": "pass" },
  mcp: { "external-configured": "warn", "external-dynamic": "block" },
  subagent: { "external-configured": "warn", "external-dynamic": "block" },
  channel: { "external-configured": "warn", "external-dynamic": "block" },
  federation: { "external-configured": "warn", "external-dynamic": "block" },
  skill: { "external-configured": "warn", "external-dynamic": "block" },
  compaction: { "external-configured": "warn", "external-dynamic": "block" },
  tool: { "external-configured": "warn", "external-dynamic": "block" },
  chain: { "external-configured": "warn", "external-dynamic": "block" },
};

/**
 * Minimum length for a tagged-content match to count. Short common
 * strings (whitespace, single words, IDs ≤8 chars) produce too many
 * false positives. 16 chars is the floor that empirically lets through
 * benign overlap (`"the"`, `"https"`, short identifiers) while still
 * catching meaningful exfil (URLs, tokens, sentences).
 */
export const MIN_MATCH_LENGTH = 16;

export type EgressPolicyOverride = Partial<Record<TrustOrigin, EgressVerdict>>;

export type ClassifyEgressOptions = {
  /**
   * Stable identifier for the sink — usually `tool.name` (e.g. `"fetch"`,
   * `"mcp:slack:send_message"`). Goes into the audit-log record so an
   * incident investigator can trace which sink the egress was destined
   * for without needing to reconstruct the call path.
   */
  readonly sinkId: string;
  readonly sinkScope: SinkScope;
  /**
   * Per-origin severity override for this sink. Highest-precedence: a
   * tool descriptor can carry `egressOverride: { subagent: "block" }` to
   * tighten policy beyond defaults. Origins not listed fall back to
   * `ORIGIN_DEFAULT_POLICY[origin][sinkScope]`.
   */
  readonly override?: EgressPolicyOverride;
  /**
   * Per-call cache bypass. Default false — production callers should
   * leave caching on. Tests use `true` to assert classification fires.
   */
  readonly bypassCache?: boolean;
  /**
   * Minimum match length override. Tests and recipe demos use a smaller
   * value to keep fixture payloads short. Production callers should not
   * supply this.
   */
  readonly minMatchLength?: number;
};

/**
 * In-process LRU cache. Key = `sha256(sinkScope || sinkId || payload)`.
 * Same cap as `boundary-classifier` so the two chokepoints have parallel
 * memory budgets.
 */
const DEFAULT_CACHE_CAP = 1024;

class LruCache<V> {
  private readonly map: Map<string, V> = new Map();
  constructor(private readonly cap: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

type CachedVerdict = {
  readonly verdict: EgressVerdict;
  readonly originsFound: ReadonlyArray<TrustOrigin>;
  readonly matchCount: number;
};

const cache = new LruCache<CachedVerdict>(DEFAULT_CACHE_CAP);

function cacheKey(payload: string, sinkScope: SinkScope, sinkId: string): string {
  const h = createHash("sha256")
    .update(sinkScope)
    .update("|")
    .update(sinkId)
    .update("|")
    .update(payload, "utf8")
    .digest("hex");
  return h;
}

/**
 * Resolve the most-severe verdict for a set of origins under the given
 * policy. `"block"` > `"warn"` > `"pass"`. Used to fold a list of origins
 * (one per matched tagged-content hit) into a single decision.
 */
function foldVerdict(verdicts: ReadonlyArray<EgressVerdict>): EgressVerdict {
  if (verdicts.some((v) => v === "block")) return "block";
  if (verdicts.some((v) => v === "warn")) return "warn";
  return "pass";
}

function originVerdict(
  origin: TrustOrigin,
  sinkScope: SinkScope,
  override?: EgressPolicyOverride,
): EgressVerdict {
  const o = override?.[origin];
  if (o !== undefined) return o;
  return ORIGIN_DEFAULT_POLICY[origin][sinkScope];
}

/**
 * The single chokepoint. Inspect `payload` for substring matches against
 * any tagged content carried in `ctx.dataLineage`. For each match, look
 * up the origin's policy under `sinkScope`. The folded verdict is the
 * most-severe outcome across all hits.
 *
 * The classifier ALWAYS runs the scan. Override only controls what to do
 * with the verdict. This means the audit trail records every non-pass
 * outcome regardless of policy — honest audit even under permissive
 * policy.
 */
export async function classifyEgress(
  payload: string,
  ctx: RunContext,
  opts: ClassifyEgressOptions,
): Promise<EgressResult> {
  if (typeof payload !== "string") {
    throw new EgressClassifierError(
      `classifyEgress expected a string payload, got ${typeof payload}`,
    );
  }

  const lineage = ctx.dataLineage;
  // No lineage tagging at all means nothing crossed a boundary yet — pass.
  if (lineage === undefined || lineage.size === 0) {
    return {
      verdict: "pass",
      originsFound: [],
      matchCount: 0,
      fromCache: false,
      sinkId: opts.sinkId,
      sinkScope: opts.sinkScope,
    };
  }

  const key = cacheKey(payload, opts.sinkScope, opts.sinkId);
  if (opts.bypassCache !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Re-evaluate the verdict under the *current* override (cache stores
      // raw hits; the policy decision is cheap to recompute).
      const verdicts = hit.originsFound.map((o) => originVerdict(o, opts.sinkScope, opts.override));
      return {
        verdict: foldVerdict(verdicts),
        originsFound: hit.originsFound,
        matchCount: hit.matchCount,
        fromCache: true,
        sinkId: opts.sinkId,
        sinkScope: opts.sinkScope,
      };
    }
  }

  const floor = opts.minMatchLength ?? MIN_MATCH_LENGTH;
  const seen = new Set<TrustOrigin>();
  let matchCount = 0;

  for (const [tagged, origin] of lineage.entries()) {
    if (tagged.length < floor) continue;
    if (payload.includes(tagged)) {
      seen.add(origin);
      matchCount += 1;
    }
  }

  const originsFound: ReadonlyArray<TrustOrigin> = [...seen];
  const cached: CachedVerdict = { verdict: "pass", originsFound, matchCount };
  if (opts.bypassCache !== true) {
    cache.set(key, cached);
  }

  if (originsFound.length === 0) {
    return {
      verdict: "pass",
      originsFound,
      matchCount,
      fromCache: false,
      sinkId: opts.sinkId,
      sinkScope: opts.sinkScope,
    };
  }

  const verdicts = originsFound.map((o) => originVerdict(o, opts.sinkScope, opts.override));
  return {
    verdict: foldVerdict(verdicts),
    originsFound,
    matchCount,
    fromCache: false,
    sinkId: opts.sinkId,
    sinkScope: opts.sinkScope,
  };
}

/**
 * Build a redaction string for the audit log payload — the actual content
 * is sensitive and should never be re-logged verbatim. Callers stamp this
 * into the `payload_summary` field instead of the raw payload.
 */
export function summarizeEgress(result: EgressResult): string {
  if (result.originsFound.length === 0) {
    return `clean (sink=${result.sinkId} scope=${result.sinkScope})`;
  }
  return `${result.verdict}: ${result.matchCount} match(es) from [${result.originsFound.join(",")}] (sink=${result.sinkId} scope=${result.sinkScope})`;
}

/** Test/diagnostics only — clear the LRU between tests. */
export function _clearEgressCache(): void {
  cache.clear();
}

/** Test/diagnostics only — inspect cache size. */
export function _cacheSize(): number {
  return cache.size();
}
