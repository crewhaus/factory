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
 * `boundary-classifier`). Recipe: demos/walkthroughs/55-egress-fabric.md.
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
 * Minimum length for a tagged-content match to count. This is a BACKSTOP
 * against pathological lineage entries, not the primary false-positive
 * control: insertion discipline lives in run-context's `tagContent`, which
 * only admits whole blobs / lines >= 16 chars and credential-shaped tokens
 * >= 8 chars (audit follow-up R2 — see `MIN_TOKEN_TAG_LENGTH` and
 * `isCredentialShaped` there). 8 matches the token floor so vetted short
 * secrets (sk-..., hex runs, key=value secrets) can actually match at
 * egress; anything shorter is indistinguishable from prose. Keep in sync
 * with run-context's `MIN_TOKEN_TAG_LENGTH`.
 */
export const MIN_MATCH_LENGTH = 8;

/**
 * FR-006 — the matching step factored behind a strategy interface. The
 * matcher decides *which* tagged lineage entries the outbound payload
 * "contains"; it never decides pass/warn/block. The verdict fold (origin
 * policy + `block > warn > pass` precedence) stays in `classifyEgress`, so
 * the three audit outcomes and their precedence are structurally
 * matcher-independent.
 *
 * The default `SubstringEgressMatcher` is behavior-preserving: it is the
 * verbatim substring scan that lived inline before the seam existed,
 * including the `MIN_MATCH_LENGTH` floor. An optional embedding-backed
 * matcher ships separately as `@crewhaus/egress-matcher-semantic`; the
 * default egress path never imports it (no new hard dependency).
 *
 * NOTE: the FR sketch wrote `match(payload, lineage, opts)` with
 * `DataLineage` / `EgressOpts` types. Those names do not exist in the
 * codebase (lineage is `Map<string, TrustOrigin>` on `RunContext`; there
 * is no `DataLineage` type). This implementation uses a single
 * `EgressMatchInput` bag — idiomatic with this codebase's option-bag style
 * — and keeps the matcher returning only raw hits, which strictly
 * strengthens the matcher-independence guarantee.
 */
export type EgressMatchInput = {
  /** The serialized outbound payload to inspect. */
  readonly payload: string;
  /** The run-context data-lineage map: tagged content → its trust origin. */
  readonly lineage: ReadonlyMap<string, TrustOrigin>;
  /** Floor below which a tagged entry is too short to count as a match. */
  readonly minMatchLength: number;
};

/**
 * Raw lineage hits — origins whose tagged content the matcher considers
 * present in the payload, plus a count of distinct matched tagged strings.
 * Deliberately verdict-free: `classifyEgress` folds policy over
 * `originsFound`, the matcher does not.
 */
export type EgressMatchResult = {
  readonly originsFound: ReadonlyArray<TrustOrigin>;
  readonly matchCount: number;
};

/**
 * A pluggable egress-matching strategy. `name` namespaces audit/trace
 * records and the verdict cache key (so a semantic-matcher verdict never
 * serves a substring-matcher hit from cache). `match` may be sync or
 * async; `classifyEgress` awaits it either way.
 */
export interface EgressMatcher {
  readonly name: string;
  match(input: EgressMatchInput): EgressMatchResult | Promise<EgressMatchResult>;
}

/**
 * Decode-aware normalization so a tagged secret that was *re-encoded* before
 * egress is still detected. A pure verbatim `payload.includes(tagged)` scan is
 * trivially bypassed by a prompt-injectable model two ways:
 *
 *   1. JSON-escaping — runtime-core builds the egress payload as
 *      `JSON.stringify(toolInput)`, which escapes the newlines/quotes/
 *      backslashes that tagged MCP/sub-agent/channel content almost always
 *      contains, so the raw tagged string is no longer a substring.
 *   2. base64/hex/percent re-encoding — the model emits `base64(secret)`
 *      instead of the plaintext.
 *
 * `buildScanViews` returns the payload plus normalized views (JSON-decoded
 * string values, and base64/hex/percent-decoded blobs found in either form),
 * and the matcher tests each tagged entry against ALL of them. The decoders
 * mirror `@crewhaus/prompt-injection-detector` (replicated, not imported, to
 * keep egress-classifier dependency-free; keep the copies in sync) and are
 * bounded (match count + recursion depth) so this is not itself a DoS vector.
 */
function isMostlyPrintable(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  return printable / s.length > 0.85;
}

function tryDecodeBase64(blob: string): string | undefined {
  if (blob.length < 16 || blob.length % 4 === 1) return undefined;
  try {
    const decoded = Buffer.from(blob, "base64").toString("utf8");
    return isMostlyPrintable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodeHex(blob: string): string | undefined {
  if (blob.length < 16 || blob.length % 2 !== 0) return undefined;
  try {
    const decoded = Buffer.from(blob, "hex").toString("utf8");
    return isMostlyPrintable(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodePercent(text: string): string | undefined {
  try {
    const decoded = decodeURIComponent(text);
    return decoded !== text ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Recursively decode base64/hex/percent blobs. Bounded for DoS-safety. */
function decodedVariants(text: string, depth = 2): string[] {
  if (depth <= 0 || text.length === 0) return [];
  const out: string[] = [];
  const push = (s: string | undefined): void => {
    if (s !== undefined && s.length > 0) out.push(s, ...decodedVariants(s, depth - 1));
  };
  for (const m of [...text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].slice(0, 8)) {
    push(tryDecodeBase64(m[0]));
  }
  for (const m of [...text.matchAll(/(?:[0-9A-Fa-f]{2}){8,}/g)].slice(0, 8)) {
    push(tryDecodeHex(m[0]));
  }
  if (/%[0-9A-Fa-f]{2}/.test(text)) push(tryDecodePercent(text));
  return out.slice(0, 16);
}

/** Collect every string leaf of a parsed JSON value (bounded by JSON size). */
function collectJsonStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectJsonStrings(v, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectJsonStrings(v, out);
  }
}

/**
 * The set of strings to scan a tagged entry against: the raw payload, the
 * JSON-decoded string values (recovers content the `JSON.stringify` egress
 * encoding escaped), and base64/hex/percent decodings of both.
 */
function buildScanViews(payload: string): string[] {
  const views: string[] = [payload];
  let jsonView: string | undefined;
  try {
    const parsed = JSON.parse(payload);
    const strings: string[] = [];
    collectJsonStrings(parsed, strings);
    if (strings.length > 0) jsonView = strings.join("\n");
  } catch {
    // Not JSON — only the raw payload + its decodings are scanned.
  }
  if (jsonView !== undefined) views.push(jsonView);
  const decodeSources = jsonView !== undefined ? [payload, jsonView] : [payload];
  for (const src of decodeSources) {
    for (const v of decodedVariants(src)) views.push(v);
  }
  return views;
}

/**
 * The default egress matcher. A tagged entry counts when it is at least
 * `minMatchLength` chars and appears in the payload OR in any of its
 * normalized views (see `buildScanViews`) — so JSON-escaping and
 * base64/hex/percent re-encoding can no longer slip a tagged secret past the
 * sink-side fabric. The raw payload is always scanned first, so every match
 * the old verbatim scan caught is still caught. `originsFound` is deduped;
 * `matchCount` counts distinct matched tagged strings.
 */
export class SubstringEgressMatcher implements EgressMatcher {
  // Assigned in the constructor rather than as an inline field initializer:
  // bun's coverage instruments a class-field initializer as its own function
  // and (as of bun 1.3.x) cannot mark it covered, leaving an unreachable-by-
  // tests gap in the function-coverage count. A plain constructor assignment
  // is equivalent at runtime and is counted normally.
  readonly name: string;
  constructor() {
    this.name = "substring";
  }
  match(input: EgressMatchInput): EgressMatchResult {
    const views = buildScanViews(input.payload);
    const seen = new Set<TrustOrigin>();
    let matchCount = 0;
    for (const [tagged, origin] of input.lineage.entries()) {
      if (tagged.length < input.minMatchLength) continue;
      if (views.some((view) => view.includes(tagged))) {
        seen.add(origin);
        matchCount += 1;
      }
    }
    return { originsFound: [...seen], matchCount };
  }
}

/** Shared default-matcher singleton — the built-in egress detection. */
export const substringMatcher: EgressMatcher = new SubstringEgressMatcher();

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
  /**
   * FR-006 — pluggable matching strategy. Defaults to `substringMatcher`
   * (behavior-preserving). Supply an alternate matcher (e.g. the optional
   * `@crewhaus/egress-matcher-semantic`) to swap *how* lineage matches are
   * detected; the per-origin/per-sink policy and the three audit outcomes
   * are unaffected. The cache key namespaces by `matcher.name`, so
   * switching matchers mid-run never cross-serves a stale verdict.
   */
  readonly matcher?: EgressMatcher;
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

function cacheKey(
  payload: string,
  sinkScope: SinkScope,
  sinkId: string,
  matcherName: string,
  lineageDigest: string,
): string {
  // Length-prefix every field before hashing so the component boundaries are
  // unambiguous. A bare `"|"` delimiter is not injective when a field can
  // contain `"|"`: (sinkId="tool|", payload="x") and (sinkId="tool",
  // payload="|x") would otherwise hash identically and cross-serve a cached
  // verdict for a *different* payload — a cache-poisoning / egress-scan-bypass
  // vector when sinkId carries attacker influence (e.g. a dynamically
  // discovered MCP tool name). `<byteLength>:` framing makes each field
  // self-delimiting regardless of its contents.
  const h = createHash("sha256");
  for (const field of [matcherName, sinkScope, sinkId, payload, lineageDigest]) {
    h.update(String(Buffer.byteLength(field, "utf8")));
    h.update(":");
    h.update(field, "utf8");
  }
  return h.digest("hex");
}

/**
 * Stable digest of the lineage map's CONTENT (keys + origins, sorted), used
 * as a cache-key component. Without it the cache serves stale verdicts: the
 * lineage map GROWS during a run (every boundary crossing tags more
 * content), so the same (payload, sink) pair legitimately classifies
 * differently once a secret contained in the payload gets tagged. A verdict
 * cached before that tag would otherwise be served forever — an egress-scan
 * bypass. Sorting makes the digest insensitive to recency-refresh reordering
 * (delete + re-insert on re-tag), which changes Map iteration order without
 * changing content.
 */
function lineageDigestOf(lineage: ReadonlyMap<string, TrustOrigin>): string {
  const h = createHash("sha256");
  const keys = [...lineage.keys()].sort();
  for (const k of keys) {
    h.update(String(Buffer.byteLength(k, "utf8")));
    h.update(":");
    h.update(k, "utf8");
    h.update(lineage.get(k) as string, "utf8");
  }
  return h.digest("hex");
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

  const floor = opts.minMatchLength ?? MIN_MATCH_LENGTH;
  const matcher = opts.matcher ?? substringMatcher;

  // Namespace the cache by matcher name so a verdict produced by one
  // matcher (e.g. semantic) is never served to a call using another
  // (e.g. substring) over the same (sinkScope, sinkId, payload) — and by a
  // digest of the lineage content so a verdict computed against an OLDER,
  // smaller lineage is never served after new tags land (see
  // `lineageDigestOf`).
  const key = cacheKey(
    payload,
    opts.sinkScope,
    opts.sinkId,
    matcher.name,
    lineageDigestOf(lineage),
  );
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

  // The matcher decides *which* lineage entries the payload contains; the
  // policy fold below is matcher-independent. `match` may be sync or async.
  const { originsFound, matchCount } = await matcher.match({
    payload,
    lineage,
    minMatchLength: floor,
  });
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
