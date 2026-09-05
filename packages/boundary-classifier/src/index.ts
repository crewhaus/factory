/**
 * Pillar 3 chokepoint — `boundary-classifier`.
 *
 * The §18 production safety floor shipped `prompt-injection-detector` and
 * wired it into exactly one site (the post-tool path in `runtime-core`).
 * That stops a malicious string from a *trusted* tool's output, but it
 * misses every *lateral* attack vector: an MCP server returning crafted
 * ND-JSON, a sub-agent's `finalMessage` carrying a sleeper jailbreak, a
 * Telegram inbound message that bypasses the perimeter because it's not
 * a tool result, a federation peer payload that mTLS authenticated but
 * the content was malicious, a skill body planted on disk, a compaction
 * summary that absorbed earlier attacker text.
 *
 * The fabric model: every cross-trust-domain transition routes through
 * `classifyBoundary(content, { origin })`, which:
 *
 *   1. Re-uses §18's `classifyText` so the detection rules stay in one
 *      place (Layer 1 regex + Layer 2 structural + Layer 3 optional LLM).
 *   2. Tags the verdict with a `TrustOrigin` so trace events and audit
 *      logs record *where* the content came from, not just *what* it
 *      contained.
 *   3. Caches verdicts by sha256(content)+origin so a compaction loop or
 *      a repeated channel message doesn't burn through classification
 *      budget. The cache is in-process; cross-process callers should
 *      share the same `BoundaryClassifier` instance.
 *   4. Applies an origin-specific severity policy. Defaults:
 *        - malicious  → block (substitute redaction notice)
 *        - suspicious → warn  (keep content, emit trace event)
 *        - clean      → pass  (verbatim)
 *
 * Single-chokepoint design is deliberate: the fabric only holds if every
 * boundary site uses the *same* classifier with the *same* policy. A new
 * boundary that re-implements classification inline (or skips it for
 * "performance") is a security regression, not a perf optimisation.
 *
 * Catalog layer: R8 (extension of §18 safety primitives). Brief: 277.
 */
import { createHash } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";
import {
  type ClassifyOptions as PiClassifyOptions,
  type PromptInjectionClassification,
  type PromptInjectionResult,
  buildRedactionNotice,
  classifyText,
} from "@crewhaus/prompt-injection-detector";

export { buildRedactionNotice };
export type { PromptInjectionClassification, PromptInjectionResult };

export class BoundaryClassifierError extends CrewhausError {
  override readonly name = "BoundaryClassifierError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Where the content originated. Use the strongest applicable label.
 *
 * Adding a new origin is a SIX-site change that lands in one PR (0.6.0
 * design §10.1; the `memory` and `consult` precedents prove the count):
 *   1. this union;
 *   2. `ORIGIN_DEFAULT_POLICY` below (a `Record<TrustOrigin, …>`, so omission
 *      is a compile error — but the tier is a real decision);
 *   3. the deliberately MIRRORED union in `@crewhaus/run-context` (it carries
 *      the metadata and must not depend on this package) — the
 *      `origin-mirror.test.ts` bridge fails `tsc -b` when the two drift;
 *   4. `@crewhaus/egress-classifier`'s sink-side severity matrix;
 *   5. the §41 `crewhaus doctor --philosophy-alignment` boundary-site list
 *      (and a drift-signal row) in `apps/cli`;
 *   6. factory's own `AGENTS.md` (the verbatim union + the source-site
 *      table). The test arrays derive from {@link TRUST_ORIGINS}, so they
 *      never need a hand edit.
 */
export type TrustOrigin =
  | "user"
  | "mcp"
  | "subagent"
  | "channel"
  | "federation"
  | "skill"
  | "compaction"
  | "tool"
  | "chain"
  | "memory"
  | "consult";

export type BoundarySeverity = "block" | "warn" | "pass";

export type BoundaryAction = "pass" | "warn" | "redact";

/**
 * Per-origin default severity overrides. Origins receiving content from
 * developer-trusted sources (`"user"` — direct CLI input) use a looser
 * policy than origins receiving content from network-untrusted sources
 * (`"mcp"`, `"federation"`). The `"user"` origin is the most relaxed
 * because the user IS the developer in a CLI context. For SaaS / multi-
 * tenant uses, the channel adapters at §33 already classify with
 * `origin: "channel"` so user-typed text from an inbound webhook goes
 * through the strict path.
 */
const ORIGIN_DEFAULT_POLICY: Record<TrustOrigin, BoundarySeverity> = {
  user: "pass", // CLI user is the developer; opt-in classification only
  mcp: "block",
  subagent: "block",
  channel: "block",
  federation: "block",
  skill: "block",
  compaction: "block",
  tool: "block",
  // Chain content: RPC responses, decoded event logs, peer-signed claims.
  // Authenticated transport (mTLS, JWT) verifies *who* served it; classification
  // verifies *what* it contains. An attacker who controls a node, an indexer,
  // or an event-emitting contract can plant malicious strings in event payloads
  // that get decoded and injected into the model's context. Block by default.
  chain: "block",
  // Memory content (0.3.0 design §7.4): recalled wiki articles, recalled
  // facts, and dream-synthesis output. A wiki article written in an earlier
  // session may have absorbed attacker text (a poisoned web page STUDYed
  // into an article, a malicious MCP response captured as a fact) — recall
  // re-injects it across a session boundary, so it must be re-verified at
  // read time. Block by default, same tier as "skill" (both are
  // disk-persisted instructions-adjacent content).
  memory: "block",
  // Consult content (0.6.0 design §7.5, §10.1): the reply of a nested
  // single-turn side call on a roster sibling (`Consult`), and the `<guide>`
  // text a plan-execute strategy injects. The sibling is a model the spec
  // trusts to SERVE, not content the run may trust to READ: its reply was
  // shaped by whatever the question carried (tool output, channel text) and
  // re-enters the parent's context verbatim, so it is classified exactly
  // once, here, at the tool. Block by default, the "skill" / "memory" tier.
  consult: "block",
};

/**
 * Every declared origin, in declaration order — derived from the policy
 * table so it can never disagree with the union. Test arrays and the
 * run-context mirror bridge read this instead of hand-listing origins.
 */
export const TRUST_ORIGINS: ReadonlyArray<TrustOrigin> = Object.keys(
  ORIGIN_DEFAULT_POLICY,
) as TrustOrigin[];

/**
 * The origin's default source-side severity — what `classifyBoundary`
 * applies when the caller passes no `severity` override. Exposed read-only
 * so tests and `doctor` can assert the tier of each origin without
 * re-deriving the table.
 */
export function defaultBoundarySeverity(origin: TrustOrigin): BoundarySeverity {
  return ORIGIN_DEFAULT_POLICY[origin];
}

export type ClassifyBoundaryOptions = {
  /** Required: where the content came from. Drives the default policy. */
  readonly origin: TrustOrigin;
  /**
   * Override the origin's default severity. `"block"` substitutes the
   * redaction notice on malicious; `"warn"` keeps the content but emits
   * a trace event on every non-clean verdict; `"pass"` never modifies
   * the content. The classifier still RUNS — the policy controls what
   * to do with the verdict.
   */
  readonly severity?: BoundarySeverity;
  /**
   * Optional LLM classifier callback. Forwarded to `classifyText`. When
   * `CREWHAUS_PI_CLASSIFIER_MODEL` is unset the layer is a no-op even
   * if a callback is supplied; the runtime should gate the wiring via
   * `llmClassifierEnabled(process.env)`.
   */
  readonly llmClassifier?: PiClassifyOptions["llmClassifier"];
  /**
   * Per-call cache bypass. Default false — production callers should
   * leave caching on. Tests use `true` to assert classification fires.
   */
  readonly bypassCache?: boolean;
};

export type BoundaryResult = {
  /** What the caller should do with `redacted` (or `original` if pass). */
  readonly action: BoundaryAction;
  /** Always the input verbatim. */
  readonly original: string;
  /** Set when action is `"redact"` — a safe substitute string. */
  readonly redacted?: string;
  readonly origin: TrustOrigin;
  readonly verdict: PromptInjectionResult;
  /** Was this verdict served from cache? */
  readonly fromCache: boolean;
};

/**
 * In-process LRU cache over `(sha256(content), origin)` → result. The
 * cap is sized to handle the largest realistic working set (a long
 * compaction history of ~200 messages × 8 origins = 1 600 entries).
 * Bun's Map preserves insertion order so we can evict the oldest by
 * deleting the first key when full.
 */
const DEFAULT_CACHE_CAP = 1024;

class LruCache<V> {
  private readonly map: Map<string, V> = new Map();
  constructor(private readonly cap: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Promote to most-recent by re-inserting.
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
  /** Test/diagnostics only. */
  size(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
}

const cache = new LruCache<{ verdict: PromptInjectionResult; origin: TrustOrigin }>(
  DEFAULT_CACHE_CAP,
);

function cacheKey(text: string, origin: TrustOrigin): string {
  const h = createHash("sha256").update(text, "utf8").digest("hex");
  return `${origin}:${h}`;
}

/**
 * Process-wide default LLM classifier (Layer 3) for boundary classification.
 *
 * Boundary call sites — MCP / sub-agent / channel / federation / skill /
 * compaction / chain / orchestrator — almost never thread an `llmClassifier`
 * through their `classifyBoundary` call, so without a default the source-side
 * fabric runs regex/structural only and the model-backed third tier the design
 * documents is dead at every boundary. The runtime registers this ONCE at
 * startup (gated on `llmClassifierEnabled`) so Layer 3 reaches every boundary
 * without threading a callback through each of the 13 call sites.
 *
 * Opt-in: unset → boundaries stay regex/structural-only (the prior behaviour).
 * A per-call `opts.llmClassifier` still takes precedence over this default.
 */
let defaultLlmClassifier: PiClassifyOptions["llmClassifier"];

/**
 * Register (or clear, with `undefined`) the process-wide Layer-3 classifier
 * used by every `classifyBoundary` call that doesn't pass its own. Idempotent:
 * re-registering the same function is a no-op. Changing or clearing it flushes
 * the verdict cache, since cached verdicts may have been computed under the
 * previous classifier (or none).
 */
export function setDefaultBoundaryLlmClassifier(
  fn: PiClassifyOptions["llmClassifier"] | undefined,
): void {
  if (fn === defaultLlmClassifier) return;
  defaultLlmClassifier = fn;
  cache.clear();
}

/**
 * The single chokepoint. Classify content at a trust boundary, applying
 * the origin's default severity policy unless overridden.
 *
 * Returns `BoundaryResult` — callers inspect `action`:
 *   - `"pass"`   → use `original` verbatim
 *   - `"warn"`   → use `original` but log the verdict
 *   - `"redact"` → substitute `redacted` for `original` before letting
 *                  the content reach the model's context or a downstream
 *                  tool's input
 *
 * The classifier itself ALWAYS runs. Severity only controls what the
 * caller does with the verdict. This means the trace bus records every
 * non-clean verdict regardless of policy — the audit trail is honest
 * even if the policy is permissive.
 */
export async function classifyBoundary(
  text: string,
  opts: ClassifyBoundaryOptions,
): Promise<BoundaryResult> {
  if (typeof text !== "string") {
    throw new BoundaryClassifierError(`classifyBoundary expected a string, got ${typeof text}`);
  }

  const origin = opts.origin;
  const severity = opts.severity ?? ORIGIN_DEFAULT_POLICY[origin];

  // Empty strings are always clean — short-circuit to skip the work.
  if (text.length === 0) {
    return {
      action: "pass",
      original: text,
      origin,
      verdict: { classification: "clean", score: 0, hits: [] },
      fromCache: false,
    };
  }

  const key = cacheKey(text, origin);
  if (opts.bypassCache !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      return makeResult(text, origin, severity, hit.verdict, true);
    }
  }

  // Per-call classifier wins; otherwise fall back to the process-wide default
  // the runtime registers at startup (Layer 3 — model-backed tier).
  const llmClassifier = opts.llmClassifier ?? defaultLlmClassifier;
  const verdict = await classifyText(text, llmClassifier !== undefined ? { llmClassifier } : {});

  if (opts.bypassCache !== true) {
    cache.set(key, { verdict, origin });
  }

  return makeResult(text, origin, severity, verdict, false);
}

function makeResult(
  text: string,
  origin: TrustOrigin,
  severity: BoundarySeverity,
  verdict: PromptInjectionResult,
  fromCache: boolean,
): BoundaryResult {
  // Pass-severity NEVER mutates content; warn-severity logs but keeps;
  // block-severity redacts on malicious + warns on suspicious.
  if (severity === "pass") {
    return { action: "pass", original: text, origin, verdict, fromCache };
  }
  if (severity === "warn") {
    if (verdict.classification === "clean") {
      return { action: "pass", original: text, origin, verdict, fromCache };
    }
    return { action: "warn", original: text, origin, verdict, fromCache };
  }
  // severity === "block"
  if (verdict.classification === "malicious") {
    return {
      action: "redact",
      original: text,
      redacted: buildRedactionNotice(verdict.hits),
      origin,
      verdict,
      fromCache,
    };
  }
  if (verdict.classification === "suspicious") {
    return { action: "warn", original: text, origin, verdict, fromCache };
  }
  return { action: "pass", original: text, origin, verdict, fromCache };
}

/**
 * Drop the in-process cache. Test-only — production callers should
 * never need this. The orchestrator may need it during deterministic
 * replay (when the cache would mask real classification calls).
 */
export function clearBoundaryCache(): void {
  cache.clear();
}

/**
 * Diagnostics — current cache size, for the `crewhaus doctor` and
 * `--philosophy-alignment` health checks.
 */
export function boundaryCacheSize(): number {
  return cache.size();
}

/**
 * Convenience for callers that want the verdict but not the policy
 * application. The runtime-core post-tool path uses this when it wants
 * to apply its own redaction-notice branding (already does — see §18).
 */
export async function classifyBoundaryRaw(
  text: string,
  opts: Pick<ClassifyBoundaryOptions, "origin" | "llmClassifier" | "bypassCache">,
): Promise<{ verdict: PromptInjectionResult; origin: TrustOrigin; fromCache: boolean }> {
  const res = await classifyBoundary(text, { ...opts, severity: "warn" });
  return { verdict: res.verdict, origin: res.origin, fromCache: res.fromCache };
}
