import { SpecParseError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// SECURITY (codegen-injection backstop, #147/#148): spec/role/node/step names
// flow verbatim into generated source across ~14 emitters — `//` and `/* */`
// comments, template literals, JSON `package.json` manifests, YAML frontmatter,
// and on-disk file paths (`skills/<name>/SKILL.md`). A raw newline, `*/`, quote,
// backtick or `/` lets a crafted name break out of those contexts (RCE on
// build/run, dependency injection, path traversal). The emitters escape per-site
// as defense-in-depth, but this is the systemic floor: restrict names to a
// single-line safe charset so the breakout characters can never enter the IR.
const safeName = z
  .string()
  .min(1)
  .regex(
    /^[\w .:-]+$/,
    "name may contain only letters, digits, spaces, and '_ . - :' (no newlines, quotes, slashes, or comment/template delimiters)",
  );

/**
 * v0 spec schema — a discriminated union over `target`.
 *
 * - `cli`: a single streaming-chat agent (Section 1–5).
 * - `workflow`: a sequence of named steps run in order, threading the prior
 *   step's final assistant text into the next step's user message (Section 6).
 * - `channel`: a long-running daemon that listens for inbound channel events
 *   (Slack today, more channels later) and runs one agent turn per inbound
 *   message, threaded by the routing key. Section 12.
 *
 * Will grow into the full catalog spec (eval, deploy) — see
 * docs/MODULE-CATALOG.md PART A Layer F1.
 */

/**
 * Section 28 (#43) — OPTIONAL spec-schema version stamp. Every target schema is
 * `.strict()`, so before this field a migration that stamped `version: 1` on a
 * spec's YAML produced a document `parseSpec` REJECTED ("Unrecognized key(s)").
 * This additive optional field gives migrations somewhere to stamp:
 *
 *   - ABSENT  → the spec is current/unversioned (the pre-#43 world). Fully
 *     back-compat: every existing spec keeps parsing unchanged.
 *   - PRESENT → a non-negative integer the migration-engine reads as the spec's
 *     schema version (`spec.version ?? 0` in migration-engine/migration-runner).
 *
 * It is a spec-schema knob, NOT the IR `version` (which stays `0` — the IR's
 * own contract version). `lower()` does not thread this field into the IR; it
 * exists purely so the versioned-migration chain has a home. Added to EVERY
 * member of the discriminated union because the union is `.strict()` — a field
 * absent from a member would still be rejected on that target.
 */
const versionField = z.number().int().nonnegative().optional();

// Permissions block (Section 7). SECURITY: `mode: "bypass"` is intentionally
// absent from the enum — bypass can only enter the system via the CLI flag.
// Defense in depth: parse-time and runtime checks both reject it.
const permissionRuleSchema = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();

const permissionsBlock = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(),
    rules: z.array(permissionRuleSchema).optional(),
  })
  .strict()
  .optional();

// MCP servers block (Section 9). Discriminated on `transport` so unknown
// configs surface as a clear "Invalid literal value" error rather than a
// confusing union-of-rejections.
const stdioMcpConfig = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const sseMcpConfig = z
  .object({
    transport: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const mcpServerConfigSchema = z.discriminatedUnion("transport", [stdioMcpConfig, sseMcpConfig]);

const mcpServersBlock = z.record(z.string().min(1), mcpServerConfigSchema).optional();

// Section 13 — sub-agent definitions. Inline on the agent block (cli +
// channel today; workflow has no agent block). The map's key is the
// `subagent_type` users pass to the Task tool. Permissions field mirrors
// the runtime's resolution shape.
const subAgentDefinitionSchema = z
  .object({
    description: z.string().min(1),
    instructions: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    permissions: z
      .union([
        z.enum(["inherit", "scoped"]),
        z
          .object({
            allow: z.array(z.string().min(1)),
            deny: z.array(z.string().min(1)),
          })
          .strict(),
      ])
      .optional(),
    inherit_bypass: z.boolean().optional(),
  })
  .strict();

const subAgentsBlock = z.record(safeName, subAgentDefinitionSchema).optional();

/**
 * Section 14 — per-tool runtime config map. Tool-specific schemas live
 * inside each tool package; the spec layer treats every value as opaque
 * `unknown` and forwards it verbatim to the IR. The codegen layer emits
 * an init call (e.g. `registerFetchConfig({ ... })`) for tools whose
 * BUILTIN_TOOL_MAP entry declares an `initSymbol`.
 *
 * SECURITY (sandbox-override hardening): the code-execution config is the
 * one exception to "opaque `unknown`". Its blob is compiled verbatim into
 * `registerCodeExecutionConfig(...)` in the generated bundle, and the
 * @crewhaus/sandbox boundary validates images/mounts against THIS same
 * blob's allowlist (`allowedImages`, `mountWhitelist`). If a spec could set
 * those — or `backend` (e.g. force `noop`, which is no isolation at all),
 * `images`, or `mounts` — an untrusted marketplace/template spec would be
 * supplying its own sandbox allowlist, making the controls self-defeating.
 * The sandbox boundary must come only from trusted operator config (the CLI
 * / `CREWHAUS_SANDBOX*` env vars), never from a spec file. So the
 * code-execution config is constrained to a strict allowlist of non-security
 * knobs; any sandbox-override key is rejected at parse time (defense in
 * depth, mirroring `permissions.mode: bypass`).
 *
 * The code-execution config can arrive under any of the keys whose
 * BUILTIN_TOOL_MAP entry maps to `registerCodeExecutionConfig` — the
 * `codeExecution`/`code_execution` aliases AND the per-tool keys
 * `python`/`javascript`/`shell` (target-cli `resolveTools` reads the
 * per-tool key first, then the aliases). All of them must be constrained,
 * or the guard is trivially bypassed by nesting the blob under `python`.
 */
const SANDBOX_OVERRIDE_KEYS = [
  "sandbox",
  "backend",
  "allowedImages",
  "allowed_images",
  "mountWhitelist",
  "mount_whitelist",
  "images",
  "mounts",
] as const;

const CODE_EXECUTION_CONFIG_KEYS = [
  "codeExecution",
  "code_execution",
  "python",
  "javascript",
  "shell",
] as const;

const codeExecutionConfigSchema = z
  .object({
    // Non-security knobs only. The sandbox boundary (backend, image
    // allowlist, mount whitelist, per-language images, mounts) is owned by
    // trusted operator config and is intentionally NOT settable from a spec.
    defaultTimeoutMs: z.number().int().positive().optional(),
    default_timeout_ms: z.number().int().positive().optional(),
    warmPoolSize: z.number().int().nonnegative().optional(),
    warm_pool_size: z.number().int().nonnegative().optional(),
  })
  .strict(
    `code-execution config may only set non-security knobs (defaultTimeoutMs, warmPoolSize); sandbox-boundary keys (${SANDBOX_OVERRIDE_KEYS.join(", ")}) are owned by trusted operator config and rejected from specs`,
  );

const toolConfigBlock = z
  .record(z.string().min(1), z.unknown())
  .superRefine((cfg, ctx) => {
    for (const key of CODE_EXECUTION_CONFIG_KEYS) {
      const value = cfg[key];
      if (value === undefined) continue;
      const parsed = codeExecutionConfigSchema.safeParse(value);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  })
  .optional();

/**
 * Item 22 — spec-declared provider failover chain, on the agent blocks of
 * the shapes whose emitted runtime calls `runChatLoop` with a single
 * primary model (cli, channel, managed today).
 *
 * `model_fallbacks` is an ordered list of model strings tried when the
 * primary's circuit breaker is open — each entry follows the SAME
 * model-string grammar as `agent.model` (`claude-*`, `openai/*`,
 * `bedrock/*`, `groq/*`, …; validated like `agent.model` at parse time,
 * with the full grammar enforced by the model-router when resolved).
 * Cross-provider fallbacks resolve their own credentials lazily via the
 * normal model-router path — a fallback with a missing key warns at boot
 * and is skipped when tried, never hard-failing the run.
 *
 * `circuit_breaker` tunes the per-candidate breakers. Field names mirror
 * `CircuitBreakerOptions` in `@crewhaus/circuit-breaker` exactly
 * (failureThreshold / windowMs / cooldownMs); package defaults (5 failures
 * / 60s window / 30s cooldown) apply per field when omitted. Declaring
 * `circuit_breaker` WITHOUT `model_fallbacks` is valid: the primary
 * adapter alone gets breaker-wrapped (fail-fast on a degraded provider
 * instead of hammering it).
 */
const modelFallbacksBlock = z.array(z.string().min(1)).min(1).optional();

const circuitBreakerBlock = z
  .object({
    /** Consecutive failures inside windowMs that trip the breaker. */
    failureThreshold: z.number().int().positive().optional(),
    /** Window for counting consecutive failures (ms). */
    windowMs: z.number().int().positive().optional(),
    /** How long the breaker stays open before allowing a probe (ms). */
    cooldownMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

/**
 * Item 26 — opt-in two-tier turn-difficulty router. When present, the runtime
 * picks a model tier PER TURN from deterministic signals (estimated context
 * tokens, whether tools are in play, turn index, prior-turn tool_use density):
 * the cheap `fast` model for easy turns, the `default` model for hard ones. A
 * fast-tier turn that FAILS re-runs on `default` (misroute recovery). Both are
 * full model-router grammar strings. `routing` tunes the escalation thresholds
 * (all optional — sensible defaults apply). Omitted entirely → single-model
 * behaviour, byte-identical bundles.
 */
const modelTiersBlock = z
  .object({
    fast: z.string().min(1),
    default: z.string().min(1),
    routing: z
      .object({
        contextTokenThreshold: z.number().int().positive().optional(),
        toolsToDefault: z.boolean().optional(),
        firstTurnToDefault: z.boolean().optional(),
        priorToolDensityThreshold: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

/**
 * Adaptive model routing — an opt-in `model_pool` of user-declared candidate
 * models the runtime selects among PER TURN, with a selection `policy` that can
 * improve the more the harness runs. The N-candidate generalisation of
 * `model_tiers` (which is the two-candidate special case), so the two are
 * mutually exclusive on an agent block (enforced by a refine on each shape).
 *
 * The user always declares the SET; the runtime only ever picks WITHIN it —
 * `agent.model` (and the optimizer's model-path exclusion) is untouched, so
 * learning tunes selection policy, never the candidate roster.
 *
 *   - `candidates` — ≥2 model-router grammar strings, each with free-form
 *     `tags` (e.g. `cheap`, `strong`) the heuristic routes on. Declare
 *     cheapest→strongest; tags override that order.
 *   - `policy` — `static` (first candidate), `heuristic` (deterministic
 *     difficulty routing, the default), or `learned` (reward-scoreboard arm
 *     selection that improves with usage).
 *   - `objective` — weights for the learned reward (quality / cost / latency);
 *     defaults to quality-dominant (0.7 / 0.2 / 0.1).
 *   - `routing` — difficulty thresholds (shared with `model_tiers`) plus the
 *     `strongTag`/`cheapTag` the heuristic prefers.
 *   - `learning` — read only for `policy: learned`: the per-arm exploration
 *     floor and the cost/latency reward references.
 *
 * Omitted entirely → single-model behaviour, byte-identical bundles.
 */
const modelPoolBlock = z
  .object({
    candidates: z
      .array(
        z
          .object({
            model: z.string().min(1),
            tags: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(2),
    policy: z.enum(["static", "heuristic", "learned"]).default("heuristic"),
    objective: z
      .object({
        quality: z.number().min(0).optional(),
        cost: z.number().min(0).optional(),
        latency: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    routing: z
      .object({
        contextTokenThreshold: z.number().int().positive().optional(),
        toolsToDefault: z.boolean().optional(),
        firstTurnToDefault: z.boolean().optional(),
        priorToolDensityThreshold: z.number().int().positive().optional(),
        strongTag: z.string().min(1).optional(),
        cheapTag: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    learning: z
      .object({
        minSamplesPerArm: z.number().int().positive().optional(),
        costRefUsd: z.number().positive().optional(),
        latencyRefMs: z.number().int().positive().optional(),
        // ε for ε-greedy online exploration once every arm clears the sample
        // floor (fraction of exploit-phase turns that try a non-best model).
        // Default 0 → deterministic explore-then-exploit, no RNG.
        explorationRate: z.number().min(0).max(1).optional(),
        // Fixed exploration seed for reproducible-across-runs behaviour (e.g.
        // tests). Omitted → the runtime seeds from the sessionId, so each run
        // explores differently while still replaying from its own transcript.
        seed: z.string().min(1).optional(),
        // Exploit-phase exploration strategy. "epsilon-greedy" (default) uses
        // explorationRate; "thompson" draws each arm from its reward posterior
        // and self-balances (explorationRate is then ignored).
        bandit: z.enum(["epsilon-greedy", "thompson"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

/**
 * Mutual-exclusion refine shared by every agent block that carries model
 * routing: `model_pool` is the superset of both the two-tier router and the
 * ordered failover chain, so declaring it alongside either is an error rather
 * than an ambiguous double-route. (Per-candidate failover chains compose in a
 * later release; this release keeps precedence unambiguous.)
 */
function refineModelSelection(
  agent: {
    model_pool?: unknown;
    model_tiers?: unknown;
    model_fallbacks?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (agent.model_pool === undefined) return;
  if (agent.model_tiers !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "agent.model_pool and agent.model_tiers are mutually exclusive — model_pool is the N-candidate generalisation of the two-tier router",
      path: ["model_tiers"],
    });
  }
  if (agent.model_fallbacks !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "agent.model_pool and agent.model_fallbacks are mutually exclusive in this release — per-candidate failover chains are a future addition",
      path: ["model_fallbacks"],
    });
  }
}

/**
 * Section 17 — optional override for the model used by
 * `compaction-autocompact` when summarising long conversations. Defaults
 * to the agent's primary model when omitted, but you can target a
 * cheaper/faster model (or a different provider) for compaction.
 */
const compactionBlock = z
  .object({
    model: z.string().min(1).optional(),
    /** Pillar 2 — opt in to the pre-compaction curator pass. Defaults
     *  to `false` when omitted; the IR carries the user's choice
     *  verbatim so target emitters can wire `@crewhaus/compaction-curator`
     *  on the runtime path. See docs/MODULE-CATALOG.md R6 + recipe 52. */
    curate: z.boolean().optional(),
    /** Cosine-similarity threshold above which two items are considered
     *  duplicates by the curator. Defaults to 0.92 in the curator
     *  itself; spec-level override targets per-corpus tuning. Must be
     *  in (0, 1] — values outside that range can't be cosine outputs. */
    dedupeThreshold: z.number().gt(0).lte(1).optional(),
    /** Max items the curator keeps after the relevance reorder. When
     *  omitted, the curator only reorders (no top-K trim). Spec-level
     *  override is the natural knob for RAG pipelines that want a hard
     *  cap on retrieved chunks per turn. */
    relevanceTopK: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

/**
 * Pillar 3 (FR-004) — per-target security fabric block. Today it carries
 * the intent-gate's judge selection; the optimizable path
 * `["security", "justification"]` is already registered in
 * `spec-patch`'s `OPTIMIZABLE_PATHS`, so this block MUST be named
 * `security` with a `justification` sub-field to honour it.
 *
 * `justification.judge` selects which `JustificationJudge` the cli run
 * path wires: `"rule-based"` (the deterministic default for tests/offline
 * runs) or `"claude"` (the model-backed `@crewhaus/justification-judge-claude`,
 * the documented production recommendation). `model` is the judge model
 * id for the claude judge; the consumer defaults it to a haiku-class
 * model when omitted.
 *
 * NOTE: `egressPolicy` is reserved — `OPTIMIZABLE_PATHS` also lists
 * `["security", "egressPolicy"]`, owned by the egress-fabric FRs
 * (FR-002/006). Do NOT add `egressPolicy` here; that would clobber their
 * sub-field. FR-004 added `justification`; FR-006 added `egressMatcher`
 * (the substring/semantic selector) alongside it — both are independent
 * optional sub-fields of this same block.
 */
const securityBlock = z
  .object({
    justification: z
      .object({
        judge: z.enum(["rule-based", "claude"]).default("rule-based"),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    /**
     * Pillar 3 sink-side fabric (FR-006) — select the egress-matching
     * strategy. `"substring"` (the default when omitted) is the
     * behavior-preserving `SubstringEgressMatcher` with `MIN_MATCH_LENGTH`.
     * `"semantic"` selects the optional embedding-backed
     * `@crewhaus/egress-matcher-semantic`, which scores outbound payloads
     * against tagged data-lineage by cosine similarity. Switching the
     * matcher changes *how* lineage matches are detected; the per-origin/
     * per-sink policy and the three audit outcomes are unaffected.
     *
     * This field is lowered to `IrSecurity.egressMatcher` (FR-006) and
     * honoured by the `crewhaus run` path, which resolves the selector and
     * threads the matcher into `runChatLoop({ egressMatcher })` — exactly
     * how `security.justification.judge` selects the intent-gate judge on
     * the same path. `"semantic"` constructs the optional
     * `@crewhaus/egress-matcher-semantic` (with an injected embedder; see
     * `--egress-embedder`). The runtime SEAM
     * (`RunChatLoopOptions.egressMatcher`) underlies both.
     *
     * The *generated cli bundle* also honours this field: `@crewhaus/target-cli`
     * emits the matcher construction (the semantic one with an injected
     * `@crewhaus/embedder` embedder) into the bundle's
     * `runChatLoop({ egressMatcher })`, so a compiled standalone artifact uses
     * `semantic` WITHOUT the `crewhaus run` path. The substring default emits
     * nothing, keeping the bundle free of any embedding dependency.
     */
    egressMatcher: z.enum(["substring", "semantic"]).optional(),
  })
  .strict()
  .optional();

/**
 * Section 55 (Track A) — named failure taxonomy. Cross-cutting block
 * available on every target shape. Each entry names a failure class and
 * tells the recovery engine which `RecoveryAction` to take when the
 * pattern matches an error's `message`. Optional `hint` is surfaced to
 * the model as a one-shot system message on `continue`/`retry` recovery.
 *
 * Source: Natural-Language Agent Harnesses (arxiv 2603.25723, Tsinghua,
 * March 2026) names failure_taxonomy as one of the six components a
 * portable harness must expose. Cited paper: NLAH (arxiv 2603.25723).
 */
const failureTaxonomyEntrySchema = z
  .object({
    class: z.string().min(1),
    pattern: z.string().min(1),
    // Item 23 — `switch-model` routes the same turn onto the next provider
    // failover candidate (pairs with `agent.model_fallbacks`; a no-op
    // re-issue when no chain is declared). See recovery-engine +
    // AUTOMATION-OPPORTUNITIES.md item 23.
    recovery: z.enum(["retry", "compact", "continue", "tombstone", "switch-model", "fail"]),
    hint: z.string().min(1).optional(),
  })
  .strict();

const failureTaxonomyBlock = z.array(failureTaxonomyEntrySchema).optional();

/**
 * Item 27 — run-level spend cap with a degradation ladder. Generalizes the
 * optimizer's `--budget-usd` to normal runs. `usd` is the dollar ceiling;
 * when the run's accrued spend reaches it, `on_exceed` decides:
 *   - `{ action: "stop" }`      — end the run cleanly before the next turn.
 *   - `{ action: "degrade", model }` — re-resolve the primary model to the
 *     cheaper `model` (one rung) and continue; a later breach on the
 *     degraded model stops the run.
 * The check is PRE-TURN (beside compaction), so an in-flight turn always
 * completes. Carried on the same interactive shapes as the failover chain
 * (cli, channel, managed). `on_exceed.model` follows the agent.model
 * grammar. Defaults to `{ action: "stop" }` when `on_exceed` is omitted.
 */
const budgetBlock = z
  .object({
    usd: z.number().positive(),
    on_exceed: z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("stop") }).strict(),
        z.object({ action: z.literal("degrade"), model: z.string().min(1) }).strict(),
      ])
      .default({ action: "stop" }),
  })
  .strict()
  .optional();

/**
 * Response-feedback block — declares that a harness collects human ratings on
 * agent responses (thumbs/stars/scale/comment) which `crewhaus distill` turns
 * into eval datasets + graders. Cross-cutting like security: carried on the
 * interactive shapes that consume it (cli, channel). `channelReactions` gates
 * codegen of Slack 👍/👎 → feedback in the channel target; `modality`/`storage`
 * configure the capture surfaces; `autoDistill` turns accumulated ratings into
 * versioned `<name>-ratings` registry datasets at CLI run teardown (item 1);
 * `exitPrompt` gates the one-keystroke REPL exit rating prompt (default on
 * when the block is present; set `false` to keep capture surfaces without the
 * prompt). `.strict()` so a typo'd sub-key fails the build.
 */
const feedbackBlock = z
  .object({
    enabled: z.boolean().optional(),
    modality: z.enum(["binary", "stars", "scale", "comment"]).default("binary"),
    scale: z.object({ min: z.number().int(), max: z.number().int() }).strict().optional(),
    storage: z.object({ location: safeName }).strict().optional(),
    autoDistill: z.boolean().optional(),
    exitPrompt: z.boolean().optional(),
    channelReactions: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Feature #53 — cross-session memory block. Its mere presence wires the
 * Remember/Recall tools into the harness (no hand-editing). The auto-*
 * switches layer on top: `autoCapture` summarizes the session's durable
 * outcomes into `.crewhaus/memories/<name>.jsonl` at run teardown;
 * `autoRecall` injects the top-`recallK` relevant memories into the system
 * prompt at session start (mirrors project-memory auto-load). Carried on the
 * interactive shapes that run a chat loop (cli, channel, managed, research).
 * `.strict()` so a typo'd sub-key fails the build.
 */
const memoryBlock = z
  .object({
    enabled: z.boolean().optional(),
    autoCapture: z.boolean().optional(),
    autoCaptureThreshold: z.number().int().positive().optional(),
    autoRecall: z.boolean().optional(),
    recallK: z.number().int().positive().max(50).optional(),
  })
  .strict()
  .optional();

/**
 * Ops item 37 — cross-cutting `observability` block. Today it carries one
 * sub-block, `slo`, that declares production Service-Level Objectives + the
 * mitigation ladder the runtime SLO monitor walks on a SUSTAINED breach.
 *
 * The monitor (runtime-core, env/spec-gated) folds bus events into rolling
 * windows (reusing the alert-watchdog's accumulator + the metrics-collector's
 * TTFT histogram) and, when a target is breached for `windowSeconds`, executes
 * the ladder rungs in the declared order: `alert` (webhook/hook), `pause-intake`
 * (gateway/managed 429 `budget_exceeded` path), `rollback` (auto-rollback the
 * env pin via deployment-controller). Every rung is audit-logged.
 *
 * Targets are all OPTIONAL — declare only the SLOs you care about; an omitted
 * target is never evaluated. `mitigation` defaults to `["alert"]` (observe-only
 * is safe) so a spec that lists thresholds without a ladder still warns. Higher
 * rungs are opt-in because they touch traffic/deploys — a spec must ask for them
 * explicitly. `.strict()` so a typo'd sub-key fails the build.
 *
 * NOTE `egress_block_rate` derives from the `permission_decision` egress
 * outcomes (no dedicated egress TraceEvent exists); `ttft_ms`/`p95_latency_ms`
 * derive from the same per-turn/TTFT samples the alert-watchdog accumulates.
 */
const sloBlock = z
  .object({
    /** Fractional error rate ceiling (unrecovered errors / model calls), e.g. 0.05. */
    error_rate: z.number().min(0).max(1).optional(),
    /** p95 per-turn latency ceiling, milliseconds. */
    p95_latency_ms: z.number().positive().optional(),
    /** p95 time-to-first-token ceiling, milliseconds. */
    ttft_ms: z.number().positive().optional(),
    /** Cost burn ceiling, USD per hour of wall-clock. */
    cost_per_hour_usd: z.number().positive().optional(),
    /** Fractional egress-block rate ceiling (egress-blocked / external calls), e.g. 0.1. */
    egress_block_rate: z.number().min(0).max(1).optional(),
    /**
     * Rolling window (seconds) a breach must persist before the ladder fires.
     * A single blip never mitigates — the monitor only acts on a SUSTAINED
     * breach across this window. Default 300s (5 min).
     */
    window_seconds: z.number().int().positive().optional(),
    /**
     * Mitigation ladder, walked in declared order on a sustained breach. Each
     * rung is executed at most once per session. `alert` is always safe;
     * `pause-intake` / `rollback` touch traffic + deploys so they are opt-in.
     */
    mitigation: z
      .array(z.enum(["alert", "pause-intake", "rollback"]))
      .nonempty()
      .optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.error_rate !== undefined ||
      s.p95_latency_ms !== undefined ||
      s.ttft_ms !== undefined ||
      s.cost_per_hour_usd !== undefined ||
      s.egress_block_rate !== undefined,
    { message: "observability.slo must declare at least one target threshold" },
  );

const observabilityBlock = z
  .object({
    slo: sloBlock.optional(),
  })
  .strict()
  .optional();

/**
 * Section 47 — blockchain subsystem blocks (cross-cutting). Any shape may
 * declare any subset of `chains` / `wallets` / `contracts` /
 * `transaction_policy`. Authoring rules:
 *   - `chains[]`: at least one when other blocks are present.
 *   - `wallets[]`: every entry references a declared `chains[].id`.
 *   - `contracts[]`: every entry references a declared `chains[].id`.
 *   - `transaction_policy`: enforced by §47 IR pass at compile time;
 *     entries in `allowed_contracts` must reference declared `contracts[].id`.
 * Per-field semantics mirror the IR variants in `@crewhaus/ir`.
 */
const chainFinalitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirmations"),
      count: z.number().int().min(0).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("finalized") }).strict(),
  z.object({ kind: z.literal("safe") }).strict(),
]);

const chainBindingSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("evm"),
    rpcUrls: z.array(z.string().min(1)).min(1),
    rpcPolicy: z.enum(["single", "quorum", "fallback"]).default("single"),
    finality: chainFinalitySchema,
    reorgTolerant: z.boolean().default(true),
  })
  .strict();

const walletBindingSchema = z
  .object({
    id: z.string().min(1),
    chainId: z.string().min(1),
    custody: z.enum(["user-controlled", "kms", "hsm", "local"]),
    signingPolicy: z
      .enum(["explicit-user-approval", "policy-gated", "automated"])
      .default("explicit-user-approval"),
    keyRef: z.string().min(1).optional(),
  })
  .strict();

const contractBindingSchema = z
  .object({
    id: z.string().min(1),
    chainId: z.string().min(1),
    address: z.string().min(1),
    abiRef: z.string().min(1),
  })
  .strict();

const transactionPolicySchema = z
  .object({
    defaultWriteApproval: z.enum(["required", "policy", "none"]).default("required"),
    maxValueUsd: z.number().positive().optional(),
    // Oracle-free native-token spend ceiling (wei). This is the ONLY value cap
    // wallet-engine can actually enforce — maxValueUsd hard-throws without a
    // price oracle. Decimal or 0x-hex string (parsed via BigInt downstream).
    maxValueWei: z
      .string()
      .regex(
        /^(0x[0-9a-fA-F]+|[0-9]+)$/,
        "maxValueWei must be a wei amount as a decimal or 0x-hex string",
      )
      .optional(),
    allowedContracts: z.array(z.string().min(1)).default([]),
    simulationRequired: z.boolean().default(true),
  })
  .strict();

const chainsBlock = z.array(chainBindingSchema).optional();
const walletsBlock = z.array(walletBindingSchema).optional();
const contractsBlock = z.array(contractBindingSchema).optional();
const transactionPolicyBlock = transactionPolicySchema.optional();

/**
 * Phase 3 §3.3 — CLI banner with optional tagline rotation. When set,
 * the compiled cli-target bundle prints this banner on cold start
 * (suppressed under `--resume` / `--continue` so resumed sessions
 * don't re-banner). Static mode picks the first tagline; random mode
 * picks one uniformly per startup.
 */
const cliBannerBlock = z
  .object({
    taglineMode: z.enum(["static", "random"]).default("static"),
    taglines: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .optional();

const cliOptionsBlock = z
  .object({
    banner: cliBannerBlock,
    /**
     * Phase 2 M2.2 — TUI polish gate. "basic" is the current readline-
     * driven REPL; "rich" is reserved for future Ink-based output
     * (status line, multi-line input, ESC interrupt). Today both modes
     * compile identically; the field is forward-compatible.
     */
    tui: z.enum(["basic", "rich"]).default("basic"),
  })
  .strict()
  .optional();

/**
 * Phase 3 §3.1 — heartbeat scheduled wake for channel daemons. When
 * present, target-channel-bot emits a setInterval loop that
 * synthesises a heartbeat turn at the configured interval. The
 * `every` field accepts a duration string (e.g. "2h", "30m", "60s").
 * `instructions` is what the runtime sends as the synthetic user
 * message at each tick; pair with HEARTBEAT.md in cwd for richer
 * playbook reads.
 */
const HEARTBEAT_DURATION_REGEX = /^\d+(?:ms|s|m|h)$/;

const heartbeatBlock = z
  .object({
    every: z
      .string()
      .regex(
        HEARTBEAT_DURATION_REGEX,
        'heartbeat.every must be a duration like "2h", "30m", "60s", or "500ms"',
      ),
    instructions: z.string().min(1),
  })
  .strict()
  .optional();

/**
 * Phase 3 §3.4 — channel daemon control-UI gateway. When set, the
 * compiled daemon spawns a second HTTP listener on `port` that serves
 * a status endpoint (and, when `ui: true`, a minimal dashboard).
 * Mirrors OpenClaw's Gateway control plane in concept; ours starts
 * minimal and is intended to host packaged Studio UI in a follow-up.
 */
const channelGatewayBlock = z
  .object({
    port: z.number().int().min(1).max(65535),
    ui: z.boolean().default(false),
  })
  .strict()
  .optional();

const cliSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("cli"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
        // Model max OUTPUT tokens for one turn. Optional; when omitted the
        // runtime default applies. Raise it for turns that emit large
        // multi-file edits so the model isn't cut off mid-`tool_use`.
        max_tokens: z.number().int().positive().optional(),
        // Item 22 — provider failover chain (see modelFallbacksBlock docs).
        model_fallbacks: modelFallbacksBlock,
        circuit_breaker: circuitBreakerBlock,
        // Item 26 — opt-in two-tier turn-difficulty router.
        model_tiers: modelTiersBlock,
        // Adaptive model routing — N-candidate pool with a selection policy.
        model_pool: modelPoolBlock,
        sub_agents: subAgentsBlock,
      })
      .strict()
      .superRefine(refineModelSelection),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    security: securityBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    feedback: feedbackBlock,
    memory: memoryBlock,
    observability: observabilityBlock,
    cli: cliOptionsBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

const workflowStepSchema = z
  .object({
    name: safeName,
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
  })
  .strict();

const workflowSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("workflow"),
    model: z.string().min(1),
    steps: z.array(workflowStepSchema).min(1),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Channel target (Section 12). Secret fields (botToken/signingSecret/appToken)
// are kept as plain strings here; the compiler's `lower()` rewrites strings
// matching `$VAR_NAME` into env-var references in the IR so the compiled
// bundle reads `process.env.VAR_NAME` at runtime instead of embedding secrets.
const slackChannelSchema = z
  .object({
    botToken: z.string().min(1),
    signingSecret: z.string().min(1),
    // Reserved for a future Socket Mode listener. The v0 webhook daemon parses
    // and carries this field but does not use it, so it is documented as
    // reserved rather than implying an unimplemented requirement.
    appToken: z
      .string()
      .min(1)
      .optional()
      .describe(
        "reserved for a future Socket Mode path; parsed but unused by the v0 webhook daemon",
      ),
  })
  .strict();

const telegramChannelSchema = z
  .object({
    botToken: z.string().min(1),
    secretToken: z.string().min(1),
  })
  .strict();

const discordChannelSchema = z
  .object({
    applicationId: z.string().min(1),
    botToken: z.string().min(1),
    publicKeyHex: z.string().min(1),
  })
  .strict();

const whatsappChannelSchema = z
  .object({
    phoneNumberId: z.string().min(1),
    accessToken: z.string().min(1),
    appSecret: z.string().min(1),
  })
  .strict();

const imessageChannelSchema = z
  .object({
    chatDbPath: z.string().min(1).optional(),
    cursorPath: z.string().min(1).optional(),
  })
  .strict();

const channelsBlock = z
  .object({
    slack: slackChannelSchema.optional(),
    telegram: telegramChannelSchema.optional(),
    discord: discordChannelSchema.optional(),
    whatsapp: whatsappChannelSchema.optional(),
    imessage: imessageChannelSchema.optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.slack !== undefined ||
      c.telegram !== undefined ||
      c.discord !== undefined ||
      c.whatsapp !== undefined ||
      c.imessage !== undefined,
    {
      message:
        "channels block requires at least one channel (slack | telegram | discord | whatsapp | imessage)",
    },
  );

const routingBlock = z
  .object({
    sessionKey: z.enum(["thread", "user", "channel"]),
  })
  .strict();

const channelAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
    // Item 22 — provider failover chain (see modelFallbacksBlock docs).
    model_fallbacks: modelFallbacksBlock,
    circuit_breaker: circuitBreakerBlock,
    // Item 26 — opt-in two-tier turn-difficulty router.
    model_tiers: modelTiersBlock,
    // Adaptive model routing — N-candidate pool with a selection policy.
    model_pool: modelPoolBlock,
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict()
  .superRefine(refineModelSelection);

const channelSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("channel"),
    agent: channelAgentSchema,
    channels: channelsBlock,
    routing: routingBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    feedback: feedbackBlock,
    memory: memoryBlock,
    observability: observabilityBlock,
    heartbeat: heartbeatBlock,
    gateway: channelGatewayBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Graph target (Section 19) — stateful DAG runtime. Nodes are LLM-backed
// invocations; edges link nodes; HITL pauses interrupt the run on
// `requestApproval()`. Each node may have its own model + tools.
const graphNodeSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    /**
     * When true, the node calls `ctx.requestApproval(prompt)` before
     * returning. The engine pauses, persists a checkpoint, and waits for
     * `resume(checkpointId, decision)` from the operator/CLI.
     */
    hitl: z
      .object({
        prompt: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const graphEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const graphSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("graph"),
    model: z.string().min(1),
    entry: z.string().min(1),
    nodes: z.record(safeName, graphNodeSchema),
    edges: z.array(graphEdgeSchema).default([]),
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Managed daemon target (Section 20). Multi-tenant gateway with
// per-tenant budgets + policy overrides; emitted bundle is daemon.ts +
// agent.ts. Authentication is HS256 JWT — the signing secret enters
// via env at boot, not via the spec.
const managedTenantSchema = z
  .object({
    id: z.string().min(1),
    budget: z
      .object({
        maxInputTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const managedAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
    // Item 22 — provider failover chain (see modelFallbacksBlock docs).
    model_fallbacks: modelFallbacksBlock,
    circuit_breaker: circuitBreakerBlock,
    // Item 26 — opt-in two-tier turn-difficulty router.
    model_tiers: modelTiersBlock,
    // Adaptive model routing — N-candidate pool with a selection policy.
    model_pool: modelPoolBlock,
  })
  .strict()
  .superRefine(refineModelSelection);

const managedSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("managed"),
    agent: managedAgentSchema,
    tenants: z.array(managedTenantSchema).min(1),
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    memory: memoryBlock,
    observability: observabilityBlock,
  })
  .strict();

// Vector-store backend ids accepted in specs. Mirrors `VectorBackendId`
// from @crewhaus/vector-store (and `IrVectorBackend`) — the canonical set
// of implemented backends — kept inline so the spec stays dependency-light.
// Keep in sync when a backend is added or removed.
const VECTOR_BACKENDS = ["in-memory", "lance", "qdrant", "pinecone", "weaviate"] as const;

// The HTTP backends construct only with a `url` + `collection` (the
// vector-store factory throws otherwise); parseSpec requires both so a
// spec that selects one without them fails at compile, not at runtime.
const HTTP_VECTOR_BACKENDS = new Set(["qdrant", "pinecone", "weaviate"]);

// Pipeline / RAG target (Section 21). Carries the embedder + vector-store
// config, an indexing pipeline, and a chat agent that uses Retrieve.
const pipelineDocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("pipeline"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    retrieve: z
      .object({
        embedderModel: z.string().min(1),
        vectorBackend: z.enum(VECTOR_BACKENDS).default("in-memory"),
        defaultK: z.number().int().positive().max(50).default(5),
        // Remote (qdrant/pinecone/weaviate) + file (lance) backend config.
        // `url` is the service base URL (or, for lance, the on-disk index
        // path); `apiKey` accepts a `$ENV_REF` so the secret resolves from
        // `process.env` in the bundle rather than being baked into it. The
        // HTTP backends require `url` + `collection` (enforced in parseSpec).
        url: z.string().min(1).optional(),
        collection: z.string().min(1).optional(),
        apiKey: z.string().min(1).optional(),
      })
      .strict(),
    indexing: z
      .object({
        chunkStrategy: z.enum(["fixed", "semantic", "markdown"]).default("fixed"),
        chunkSize: z.number().int().positive().default(400),
        chunkOverlap: z.number().int().nonnegative().default(0),
        documents: z.array(pipelineDocumentSchema).min(1),
      })
      .strict(),
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

// Crew target (Section 22). Multi-role agent runtime; each role is an
// `agent`-shaped block (model + instructions + tools); `entry` names the
// first-active role; optional `routing` block carries either `match`
// rules or `llm` directive (lower-time placeholder for an LLM-backed
// router; runtime falls back to "no router" when the target shape lands
// on the codegen path).
const crewRoleSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict();

const crewRoutingMatchEntrySchema = z
  .object({
    contains: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const crewRoutingSchema = z
  .object({
    kind: z.enum(["match", "llm"]),
    match: z.record(z.string().min(1), z.array(crewRoutingMatchEntrySchema).min(1)).optional(),
  })
  .strict();

const crewSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("crew"),
    /** Crew-wide model fallback used by any role that omits `role.model`. */
    model: z.string().min(1),
    entry: z.string().min(1),
    roles: z.record(safeName, crewRoleSchema),
    routing: crewRoutingSchema.optional(),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();
// `.refine()` on a discriminatedUnion member would change the type from
// ZodObject to ZodEffects (incompatible with the union); the
// "entry-in-roles" + "non-empty roles" cross-field checks live in
// `parseSpec` below as a post-parse pass.

// Research target (Section 23 RES). The compiled daemon decomposes
// `goal` into `branchingFactor` sub-questions, runs one agent loop per
// branch, and writes a numbered-citation report under
// `.crewhaus/research/<runId>/`.
const researchRetrieveSchema = z
  .object({
    allowedOrigins: z.array(z.string().min(1)).default([]),
    allowedFileRoots: z.array(z.string().min(1)).default([]),
    vectorBackend: z.enum(VECTOR_BACKENDS).optional(),
  })
  .strict();

const researchSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("research"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    goal: z.string().min(1),
    branchingFactor: z.number().int().min(1).max(8).default(3),
    maxDurationMs: z.number().int().positive().default(300_000),
    retrieve: researchRetrieveSchema.default({}),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    memory: memoryBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Batch target (Section 23 BATCH). Queue-worker daemon: pulls jobs
// from `queue`, runs the agent on each input, dedups via idempotency
// keys. v0 ships an in-memory adapter for tests + smoke; SQS / Redis
// Streams / Postgres adapters land in follow-up PRs.
const batchQueueSchema = z
  .object({
    adapter: z.enum(["in-memory", "sqs", "redis-streams", "postgres"]),
    visibilityTimeoutMs: z.number().int().positive().default(30_000),
    visibilityRenewIntervalMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(1).max(10).default(3),
    seedJobs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const batchSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("batch"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    queue: batchQueueSchema,
    concurrency: z.number().int().min(1).max(64).default(4),
    idempotencyWindowMs: z.number().int().positive().default(60_000),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    chains: chainsBlock,
    wallets: walletsBlock,
    contracts: contractsBlock,
    transaction_policy: transactionPolicyBlock,
  })
  .strict();

// Voice target (Section 24 VOICE). Realtime audio agent.
const voiceBlockSchema = z
  .object({
    provider: z.enum(["openai", "vapi"]),
    voiceId: z.string().min(1).default("alloy"),
    vad: z.enum(["server", "none"]).default("server"),
    bargeInTriggerFrames: z.number().int().min(1).max(20).default(4),
    bargeInWindowMs: z.number().int().min(60).max(2000).default(200),
  })
  .strict();

const voiceTelephonySchema = z
  .object({
    provider: z.enum(["twilio", "livekit-sip", "in-memory"]),
  })
  .strict();

const voiceSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("voice"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    voice: voiceBlockSchema,
    telephony: voiceTelephonySchema.optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

// Browser target (Section 25 BROW). Computer-use / browser-driver agent.
const browserDriverSchema = z
  .object({
    backend: z.enum(["host", "chromium", "remote"]).default("chromium"),
    viewport: z
      .object({
        width: z.number().int().positive().default(1280),
        height: z.number().int().positive().default(720),
      })
      .strict()
      .default({ width: 1280, height: 720 }),
    startUrl: z.string().url().optional(),
  })
  .strict();

const browserSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("browser"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    driver: browserDriverSchema.default({}),
    /** Vision-grounding model. Defaults to the agent's primary model. */
    groundingModel: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

/**
 * Section 29 — `target: "eval"` — the EVAL target shape. A spec carries an
 * agent definition, a dataset reference (resolved via §29 dataset-registry),
 * a list of grader names (resolved via §29 grader-registry), concurrency
 * and seed knobs. The compiled bundle boots dataset-registry +
 * grader-registry + eval-runner and writes results to
 * `.crewhaus/evals/<runId>/`.
 */
const evalSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("eval"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
        tools: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    dataset: z
      .object({
        name: safeName,
        version: z.string().min(1),
        split: z.enum(["train", "dev", "test"]).default("dev"),
      })
      .strict(),
    graders: z
      .array(
        z
          .object({
            name: safeName,
            opts: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1),
    concurrency: z.number().int().min(1).default(4),
    seed: z.number().int().optional(),
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

/**
 * Section 47 — `onchain` target. Long-running event-driven daemon.
 * Triggers fire on contract events / block scans / address watches;
 * each trigger runs one agent turn with the decoded payload as the
 * user message. Wallets + transaction_policy let the agent respond
 * with signed transactions (escrow release, treasury rebalance, etc).
 */
const onchainTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      chainId: z.string().min(1),
      contract: z.string().min(1),
      event: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      chainId: z.string().min(1),
      scanIntervalMs: z.number().int().min(1000).max(3_600_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("address"),
      chainId: z.string().min(1),
      address: z.string().min(1),
      direction: z.enum(["in", "out", "both"]).default("both"),
    })
    .strict(),
]);

const onchainSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("onchain"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    chains: z.array(chainBindingSchema).min(1),
    wallets: z.array(walletBindingSchema).default([]),
    contracts: z.array(contractBindingSchema).default([]),
    transaction_policy: transactionPolicySchema.default({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    }),
    triggers: z.array(onchainTriggerSchema).min(1),
    idempotencyWindowMs: z.number().int().positive().default(60_000),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

/**
 * Section 47 — `onchain-game` target. Perceive-act-perceive loop
 * against a game contract: read state via `stateReader`, ask the model
 * for a move, broadcast it as a transaction, await confirmation,
 * re-read state. Single chain, single wallet.
 */
const onchainGameSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("onchain-game"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    chain: chainBindingSchema,
    wallet: walletBindingSchema,
    game: z
      .object({
        contract: contractBindingSchema,
        stateReader: z.string().min(1),
        actionsContract: z.string().min(1).optional(),
        turnSemantics: z.enum(["turn-based", "real-time", "async"]).default("turn-based"),
        moveTimeoutMs: z.number().int().positive().optional(),
        objective: z.string().min(1).optional(),
      })
      .strict(),
    transaction_policy: transactionPolicySchema.default({
      defaultWriteApproval: "required",
      allowedContracts: [],
      simulationRequired: true,
    }),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
  })
  .strict();

export const Spec = z.discriminatedUnion("target", [
  cliSchema,
  workflowSchema,
  channelSchema,
  graphSchema,
  managedSchema,
  pipelineSchema,
  crewSchema,
  researchSchema,
  batchSchema,
  voiceSchema,
  browserSchema,
  evalSchema,
  onchainSchema,
  onchainGameSchema,
]);

export type Spec = z.infer<typeof Spec>;
export type SpecCli = z.infer<typeof cliSchema>;
export type SpecWorkflow = z.infer<typeof workflowSchema>;
export type SpecWorkflowStep = z.infer<typeof workflowStepSchema>;
export type SpecChannel = z.infer<typeof channelSchema>;
export type SpecChannelAgent = z.infer<typeof channelAgentSchema>;
export type SpecSlackChannel = z.infer<typeof slackChannelSchema>;
export type SpecTelegramChannel = z.infer<typeof telegramChannelSchema>;
export type SpecDiscordChannel = z.infer<typeof discordChannelSchema>;
export type SpecWhatsAppChannel = z.infer<typeof whatsappChannelSchema>;
export type SpecIMessageChannel = z.infer<typeof imessageChannelSchema>;
export type SpecGraph = z.infer<typeof graphSchema>;
export type SpecGraphNode = z.infer<typeof graphNodeSchema>;
export type SpecGraphEdge = z.infer<typeof graphEdgeSchema>;
export type SpecManaged = z.infer<typeof managedSchema>;
export type SpecManagedTenant = z.infer<typeof managedTenantSchema>;
export type SpecPipeline = z.infer<typeof pipelineSchema>;
export type SpecPipelineDocument = z.infer<typeof pipelineDocumentSchema>;
export type SpecCrew = z.infer<typeof crewSchema>;
export type SpecCrewRole = z.infer<typeof crewRoleSchema>;
export type SpecCrewRouting = z.infer<typeof crewRoutingSchema>;
export type SpecResearch = z.infer<typeof researchSchema>;
export type SpecResearchRetrieve = z.infer<typeof researchRetrieveSchema>;
export type SpecBatch = z.infer<typeof batchSchema>;
export type SpecBatchQueue = z.infer<typeof batchQueueSchema>;
export type SpecOnchain = z.infer<typeof onchainSchema>;
export type SpecOnchainGame = z.infer<typeof onchainGameSchema>;
export type SpecChainTrigger = z.infer<typeof onchainTriggerSchema>;
export type SpecVoice = z.infer<typeof voiceSchema>;
export type SpecVoiceBlock = z.infer<typeof voiceBlockSchema>;
export type SpecVoiceTelephony = z.infer<typeof voiceTelephonySchema>;
export type SpecBrowser = z.infer<typeof browserSchema>;
export type SpecBrowserDriver = z.infer<typeof browserDriverSchema>;
export type SpecEval = z.infer<typeof evalSchema>;
export type SpecMcpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type SpecSubAgentDefinition = z.infer<typeof subAgentDefinitionSchema>;
export type SpecCompactionBlock = z.infer<typeof compactionBlock>;
export type SpecModelFallbacks = z.infer<typeof modelFallbacksBlock>;
export type SpecCircuitBreakerBlock = z.infer<typeof circuitBreakerBlock>;
export type SpecModelTiersBlock = z.infer<typeof modelTiersBlock>;
export type SpecModelPoolBlock = z.infer<typeof modelPoolBlock>;
export type SpecBudgetBlock = z.infer<typeof budgetBlock>;
export type SpecSecurityBlock = z.infer<typeof securityBlock>;
export type SpecFeedbackBlock = z.infer<typeof feedbackBlock>;
export type SpecMemoryBlock = z.infer<typeof memoryBlock>;
export type SpecFailureTaxonomyEntry = z.infer<typeof failureTaxonomyEntrySchema>;
export type SpecFailureTaxonomy = z.infer<typeof failureTaxonomyBlock>;

export { SpecParseError };

export function parseSpec(yamlText: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new SpecParseError("invalid YAML", err);
  }

  // Friendly early-rejection for `permissions.mode: bypass` so the error
  // message names the actual security policy rather than a Zod enum mismatch.
  // The Zod schema also excludes "bypass" from its enum (defense in depth).
  if (typeof raw === "object" && raw !== null && "permissions" in raw) {
    const perms = (raw as { permissions?: unknown }).permissions;
    if (typeof perms === "object" && perms !== null && "mode" in perms) {
      const mode = (perms as { mode?: unknown }).mode;
      if (mode === "bypass") {
        throw new SpecParseError(
          "permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file",
        );
      }
    }
  }

  const result = Spec.safeParse(raw);
  if (!result.success) {
    throw new SpecParseError(
      `spec validation failed:\n${result.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      result.error,
    );
  }
  // Section 22 — crew cross-field invariants. Kept here rather than as
  // `.refine()`s on the schema so the discriminated-union member stays
  // a plain ZodObject (Zod's discriminatedUnion rejects ZodEffects).
  const data = result.data;
  if (data.target === "crew") {
    const roleNames = Object.keys(data.roles);
    if (roleNames.length === 0) {
      throw new SpecParseError("crew target requires at least one role");
    }
    if (!roleNames.includes(data.entry)) {
      throw new SpecParseError(
        `crew.entry "${data.entry}" must name one of crew.roles (got: ${roleNames.join(", ")})`,
      );
    }
    if (data.routing !== undefined && data.routing.kind === "match" && data.routing.match) {
      for (const [from, rules] of Object.entries(data.routing.match)) {
        if (!roleNames.includes(from)) {
          throw new SpecParseError(`crew.routing.match["${from}"]: source role not in crew.roles`);
        }
        for (const rule of rules) {
          if (!roleNames.includes(rule.to)) {
            throw new SpecParseError(
              `crew.routing.match["${from}"].to = "${rule.to}" — target role not in crew.roles`,
            );
          }
        }
      }
    }
  }
  // Section 21 — pipeline HTTP-backend invariants. qdrant/pinecone/weaviate
  // throw at construction without a url + collection, so selecting one
  // without both would emit an unrunnable bundle. Reject at parse time with
  // a message naming the missing field (kept here, not as a `.refine()`, so
  // the discriminated-union member stays a plain ZodObject).
  if (data.target === "pipeline" && HTTP_VECTOR_BACKENDS.has(data.retrieve.vectorBackend)) {
    const { vectorBackend, url, collection } = data.retrieve;
    if (!url) {
      throw new SpecParseError(
        `pipeline retrieve.vectorBackend "${vectorBackend}" requires retrieve.url (the remote service base URL)`,
      );
    }
    if (!collection) {
      throw new SpecParseError(
        `pipeline retrieve.vectorBackend "${vectorBackend}" requires retrieve.collection`,
      );
    }
  }
  return data;
}
