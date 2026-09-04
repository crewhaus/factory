import { SpecParseError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

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
    /**
     * Loop contract 0.4 (Batch C, G11) — what a tool permission that resolves
     * to `ask` does on a NON-interactive surface (single-turn / daemon /
     * gateway, anywhere without a synchronous human prompt). `"pause"`
     * (DEFAULT — the safe direction) parks the turn: the runtime persists a
     * `PendingApproval`, publishes an `approval_requested` trace event, and
     * ends the turn with the `approval_pending` failure class + resume token
     * so a later `grant`/`deny` decision re-runs the tool call pre-resolved.
     * `"deny"` is the pre-0.4 collapse behaviour — an ask on a non-interactive
     * surface becomes a denial in place. The REPL always keeps its
     * synchronous prompt regardless of this key.
     *
     * Deliberately OMITTED from `OPTIMIZABLE_PATHS`: this is a safety /
     * human-in-the-loop control, not a quality knob. Letting an optimizer
     * flip a pending-approval `pause` to `deny` (or vice-versa) would let the
     * search loop silently rewrite the approval posture of a deployment — the
     * same reason the intent-gate grader and other safety surfaces stay out
     * of the optimizer's reach.
     */
    ask_mode: z.enum(["pause", "deny"]).optional(),
  })
  .strict()
  .optional();

// MCP servers block (Section 9). Discriminated on `transport` so unknown
// configs surface as a clear "Invalid literal value" error rather than a
// confusing union-of-rejections.
/**
 * #406 — `required: false` marks a server this harness can run WITHOUT.
 *
 * Default (absent or true) keeps the fail-fast contract: a peer that cannot
 * connect at boot exits the daemon, because an agent whose instructions
 * assume a tool behaves worse when it silently vanishes than when it refuses
 * to start. `required: false` is the opt-out for genuinely optional peers —
 * an A2A neighbour that may boot after us, a nice-to-have enrichment server:
 * a failed initial connect warns, the daemon serves, and the connection
 * retries in the background, registering the peer's tools when it lands.
 */
const mcpRequiredField = z.boolean().optional();

const stdioMcpConfig = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    required: mcpRequiredField,
  })
  .strict();

const sseMcpConfig = z
  .object({
    transport: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    required: mcpRequiredField,
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
    /**
     * Item 2 (G31 — A2A federation) — wire this sub-agent to a REMOTE peer
     * instead of spawning it locally. `url` is the peer deployment's base
     * URL; the spawner routes the Task call through `@crewhaus/federation-
     * router` to the peer's inbound A2A handler (whose Agent Card lives at
     * `<url>/.well-known/agent-card.json`), mapping the federation envelope
     * onto A2A message/task semantics. Present ⇒ the entry is a federated
     * peer reference; `description`/`instructions` still describe it to the
     * parent's Task tool (the remote peer owns its own prompt).
     */
    federation: z.object({ url: z.string().url() }).strict().optional(),
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
 * The declared ORDER is honoured verbatim — it is a TRUST ordering ("what do
 * I run when my primary is down"), and the runtime never reorders it (a
 * 2026-07 design review deliberately retired the cost-ranking idea; see the
 * `rankFallbacks` docstring in model-router's failover.ts). Want cheaper
 * models preferred? Order the list yourself — or use `agent.model_pool`,
 * which is the cost/quality routing surface.
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
    /** Loop contract 0.4 (Batch A) — context-window fill fraction that
     *  triggers autocompaction (e.g. 0.85 = compact at 85% full). Bounded
     *  to 0.5–0.99: below half the window a compaction pass costs more
     *  than it saves, and 1.0 would only ever fire after an overflow.
     *  OPTIMIZABLE (`["compaction","threshold"]` in spec-patch). When
     *  omitted the runtime default applies. */
    threshold: z.number().gte(0.5).lte(0.99).optional(),
    /** Loop contract 0.4 (Batch A) — messages preserved verbatim at the
     *  HEAD of the transcript by `compaction-snip` before summarising the
     *  middle. When omitted the snip package's default applies. */
    snip_keep_head: z.number().int().positive().optional(),
    /** Loop contract 0.4 (Batch A) — messages preserved verbatim at the
     *  TAIL of the transcript by `compaction-snip`. When omitted the snip
     *  package's default applies. */
    snip_keep_tail: z.number().int().positive().optional(),
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
 *   - `{ action: "stop" }`      — end the run. 0.6.0 (§7.12): the cap is
 *     checked before EVERY model call, tool iterations included, so a
 *     runaway tool loop stops at the cap with a classified
 *     `crewhaus_budget` failure (the REPL's pre-turn check still ends an
 *     idle run cleanly before the next turn opens).
 *   - `{ action: "degrade", model }` — re-resolve the primary model to the
 *     cheaper `model` (one rung) and continue: the rung serves every
 *     remaining model call of the turn in which the degrade fired (a
 *     mid-turn degrade finishes its tool loop; a single-turn host gets one
 *     complete degraded reply), and the run ends cleanly at the next turn
 *     boundary. Under a `model_pool` the rung does not
 *     swap the adapter: it becomes the FORCED pool candidate (`model_route`
 *     policy `forced`, reason `budget_degrade`). A `model` outside the pool
 *     roster is a compile WARNING (`budget-degrade-outside-pool`) plus an
 *     extra always-eligible rung — never a parse error.
 * `scope` (0.6.0, default `run`) decides what the cap bounds: `run` meters
 * this process's spend only; `session` also seeds the meter on `--resume`
 * (and the channel/managed resume-per-message pattern) from the
 * `cost_accrual` lines the session log already persists, so the cap bounds
 * the whole conversation rather than one inbound message. Carried on the
 * same interactive shapes as the failover chain (cli, channel, managed)
 * plus the single-turn shapes. `on_exceed.model` follows the agent.model
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
    // 0.6.0 — optional, NO zod default: an absent key stays absent on the
    // parsed spec and the IR, so pre-0.6.0 specs lower byte-identically.
    scope: z.enum(["run", "session"]).optional(),
  })
  .strict()
  .optional();

/**
 * Loop contract 0.4 (Batch B, G02) — the top-level `evaluation:` block:
 * in-loop output evaluation on the interactive shapes (cli, channel,
 * managed). After each completed assistant turn the runtime scores the
 * final text with `grader`; a score below `threshold` triggers the
 * `on_fail` behaviour:
 *
 *   - `retry` (default) — re-prompt the model with the judge's rationale
 *     appended as a system nudge, at most `max_retries` times.
 *   - `halt`  — abort the turn with a classified `evaluation` failure.
 *   - `note`  — emit an `eval_graded` trace event only.
 *
 * Graders:
 *   - `{ type: llm_judge, criteria, model? }` — a model scores the reply
 *     in [0,1] against `criteria`; `model` defaults to the shape's primary
 *     model (the `cheapest` sentinel resolves like `compaction.model`).
 *     Judge calls are METERED into the run budget.
 *   - `{ type: contains, value }` / `{ type: regex, value }` —
 *     deterministic pass/fail text checks (no threshold; no model spend).
 *
 * `threshold` (0..1, default 0.7) applies to `llm_judge` only — declaring
 * it with a deterministic grader is a parse error. `.strict()` throughout
 * so a typo'd sub-key fails the build.
 */
const evaluationGraderSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("llm_judge"),
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "judge model id; defaults to the shape's primary model (the cheapest sentinel resolves at compile time)",
        ),
      criteria: z
        .string()
        .min(1)
        .describe(
          "what a passing reply must satisfy — the judge scores the final text against this",
        ),
    })
    .strict()
    .describe("model-scored grader: an LLM judges the final text in [0,1] against criteria"),
  z
    .object({
      type: z.literal("contains"),
      value: z.string().min(1).describe("substring the final text must contain (case-sensitive)"),
    })
    .strict()
    .describe("deterministic grader: pass iff the final text contains value"),
  z
    .object({
      type: z.literal("regex"),
      value: z.string().min(1).describe("JavaScript regular expression the final text must match"),
    })
    .strict()
    .describe("deterministic grader: pass iff the final text matches the regex"),
]);

const evaluationBlock = z
  .object({
    grader: evaluationGraderSchema,
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("passing score in 0..1 (default 0.7); llm_judge grader only"),
    on_fail: z
      .enum(["retry", "halt", "note"])
      .optional()
      .describe(
        "below-threshold behaviour: retry re-prompts with the judge rationale (default), halt aborts the turn classified, note emits a trace event only",
      ),
    max_retries: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("hard cap on evaluation-triggered retries per turn (default 1)"),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.threshold !== undefined && e.grader.type !== "llm_judge") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["threshold"],
        message: `evaluation.threshold applies to the llm_judge grader only — the "${e.grader.type}" grader is deterministic pass/fail`,
      });
    }
    if (e.grader.type === "regex") {
      try {
        new RegExp(e.grader.value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["grader", "value"],
          message: `evaluation.grader.value is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  })
  .describe(
    "in-loop output evaluation: score each completed assistant turn and retry/halt/note below threshold",
  )
  .optional();

/**
 * Loop contract 0.4 (Batch B, G02) — the `judge:` gate declared by
 * `kind: "judge"` workflow steps and graph nodes. A judge step/node runs no
 * agent turn of its own: it scores the PREVIOUS step's (workflow) /
 * upstream node's (graph) final output in [0,1] against `criteria` and,
 * below `threshold` (default 0.7), applies `on_fail`:
 *
 *   - `retry_previous` (default) — re-run the gated step/node with the
 *     judge rationale appended as a system nudge, at most `max_retries`
 *     times.
 *   - `halt`     — abort the run with a classified `evaluation` failure.
 *   - `continue` — record the `judge_verdict` trace event and proceed.
 *
 * `model` defaults to the shape's top-level `model` (the `cheapest`
 * sentinel resolves like `compaction.model`). Judge calls are METERED into
 * the run budget.
 */
const judgeGateBlock = z
  .object({
    criteria: z
      .string()
      .min(1)
      .describe("what a passing upstream output must satisfy — the judge scores against this"),
    model: z
      .string()
      .min(1)
      .optional()
      .describe("judge model id; defaults to the shape's top-level model"),
    threshold: z.number().min(0).max(1).optional().describe("passing score in 0..1 (default 0.7)"),
    on_fail: z
      .enum(["retry_previous", "halt", "continue"])
      .optional()
      .describe(
        "below-threshold behaviour: retry_previous re-runs the gated step/node (default), halt aborts classified, continue records the verdict and proceeds",
      ),
    max_retries: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("hard cap on judge-triggered re-runs of the gated step/node (default 1)"),
  })
  .strict()
  .describe("judge gate config for kind: judge workflow steps and graph nodes");

/**
 * Loop contract 0.4 (Batch A) — extended-thinking selector, carried on the
 * agent blocks of the interactive shapes (cli, channel, managed) and at
 * step/node/role granularity on workflow steps, graph nodes, and crew roles.
 * Exactly ONE of the two forms must be declared (enforced by superRefine):
 *
 *   - `{ budget_tokens: n }` — an explicit thinking-token budget (>= 1024,
 *     the provider floor), passed through to the provider verbatim.
 *   - `{ effort: low|medium|high }` — a portable effort preset the adapter
 *     layer converts to a provider-appropriate budget
 *     (`EFFORT_THINKING_BUDGET_TOKENS` in `@crewhaus/adapter-anthropic`).
 *
 * `.strict()` so a typo'd sub-key fails the build.
 */
const thinkingBlock = z
  .object({
    budget_tokens: z.number().int().min(1024).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const forms = (t.budget_tokens !== undefined ? 1 : 0) + (t.effort !== undefined ? 1 : 0);
    if (forms !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "thinking requires exactly one of budget_tokens (explicit token budget >= 1024) or effort (low|medium|high preset)",
      });
    }
  })
  .optional();

/**
 * Loop contract 0.4 (Batch A) — runaway-loop detection tuning inside the
 * `limits:` block. `window` is the trailing tool-call window inspected;
 * `threshold` (>1 — a single repeat is normal) is how many identical calls
 * inside the window count as a loop; `escalation` picks the response:
 * `warn` (trace event only), `justify` (demand a justification string via
 * the intent gate), `abort` (end the run). Runtime owns per-knob defaults.
 */
const loopDetectionBlock = z
  .object({
    window: z.number().int().positive().optional(),
    threshold: z.number().int().min(2).optional(),
    escalation: z.enum(["warn", "justify", "abort"]).optional(),
  })
  .strict();

/**
 * Loop contract 0.4 (Batch A) — the top-level `limits:` block: hard runtime
 * ceilings for one agent loop. Carried on the loop-running shapes (cli,
 * channel, managed, workflow, graph, crew, research, batch, browser); the
 * strict union rejects it loudly elsewhere. Every field optional — declare
 * only the ceilings you want; the runtime owns per-knob defaults.
 *
 *   - `max_tool_iterations` — cap on tool-use round-trips per turn
 *     (OPTIMIZABLE, `["limits","max_tool_iterations"]` in spec-patch).
 *   - `max_concurrent_tools` — parallel tool-execution ceiling per block.
 *   - `context_limit` — hard context-token ceiling (overrides the model's).
 *   - `deadline_ms` — wall-clock ceiling for the whole run.
 *   - `turn_timeout_ms` — wall-clock ceiling for one turn.
 *   - `model_call_timeout_ms` — wall-clock ceiling for one model call.
 *   - `loop_detection` — see {@link loopDetectionBlock}.
 *
 * The crew shape additionally accepts a `crew:` sub-block (see
 * {@link crewLimitsBlock}) for orchestration-level ceilings.
 */
const limitsObject = z
  .object({
    max_tool_iterations: z.number().int().positive().optional(),
    max_concurrent_tools: z.number().int().positive().optional(),
    context_limit: z.number().int().positive().optional(),
    deadline_ms: z.number().int().positive().optional(),
    turn_timeout_ms: z.number().int().positive().optional(),
    model_call_timeout_ms: z.number().int().positive().optional(),
    loop_detection: loopDetectionBlock.optional(),
  })
  .strict();

const limitsBlock = limitsObject.optional();

/**
 * Loop contract 0.4 (Batch A) — crew-only orchestration ceilings nested
 * under `limits.crew`. `max_activations` caps total role activations per
 * run; `refusal_depth` (>= 0 — 0 means "never refuse") caps how many times
 * a role may bounce a handoff back; `max_a2a_depth` caps agent-to-agent
 * delegation depth. Accepted ONLY on the crew shape — the base
 * {@link limitsObject} everywhere else rejects the `crew` key.
 */
const crewLimitsBlock = limitsObject
  .extend({
    crew: z
      .object({
        max_activations: z.number().int().positive().optional(),
        refusal_depth: z.number().int().nonnegative().optional(),
        max_a2a_depth: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

/**
 * Loop contract 0.4 (Batch A) — the hook-event names accepted in a spec's
 * `hooks:` block. DUPLICATED from `HOOK_EVENTS` in `@crewhaus/hooks-engine`
 * (the runtime source of truth) because the spec package stays
 * dependency-light — it must not import runtime packages. A cross-check
 * test in `packages/hooks-engine` imports this const and asserts equality
 * with `HOOK_EVENTS`, so the two lists cannot drift silently. Keep in sync.
 */
export const SPEC_HOOK_EVENTS = [
  "session-start",
  "stop",
  "pre-tool",
  "post-tool",
  "pre-model",
  "post-model",
  "pre-compact",
  "post-compact",
  "pre-slash",
  "alert",
] as const;

/**
 * Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks, the in-spec
 * equivalent of `.crewhaus/settings.json` `hooks` entries (same shape as
 * hooks-engine's `HookDef`, snake_case per spec convention: `timeout_ms` ↔
 * `timeoutMs`). Carried on the same shapes as `limits:`. Each entry spawns
 * `command` at the named lifecycle `event` (optionally filtered by the
 * `matcher` glob against the payload's `name`).
 */
const hookSchema = z
  .object({
    event: z.enum(SPEC_HOOK_EVENTS),
    matcher: z.string().min(1).optional(),
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const hooksBlock = z.array(hookSchema).optional();

/**
 * Loop contract 0.4 (Batch A) — per-tool rate limits on the agent blocks of
 * the interactive shapes (cli, channel, managed). Keys are tool names (or
 * `"*"` for the catch-all bucket); `rpm` is the sustained requests-per-
 * minute ceiling, `burst` the optional short-burst allowance on top.
 */
const rateLimitsBlock = z
  .record(
    z.string().min(1),
    z
      .object({
        rpm: z.number().int().positive(),
        burst: z.number().int().positive().optional(),
      })
      .strict(),
  )
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
 * v0.3.0 §3.1/§9 — the `memory.wiki` sub-block: the update-in-place semantic
 * tier over `@crewhaus/wiki-store` (`.crewhaus/wiki/<spec>/`). Presence (with
 * `enabled` not `false`) registers the ten thredz-vocabulary `wiki_*` tools.
 * `recallK` caps wiki hits fused into auto-recall (OPTIMIZABLE, PR 20);
 * `embedder` is the `@crewhaus/embedder` factory grammar enabling hybrid
 * recall on BOTH the wiki and the fact store; `autoRecall` fuses wiki recall
 * into the session-start memory bundle; `requireSources` is the learning-mode
 * write governance (`wiki_write` rejects bodies without a `## Sources`
 * heading — the `learning:` lowering sets it in PR 17).
 * `.strict()` so a typo'd sub-key fails the build.
 */
const memoryWikiBlock = z
  .object({
    enabled: z.boolean().optional(),
    recallK: z.number().int().positive().max(50).optional(),
    embedder: z.string().min(1).optional(),
    autoRecall: z.boolean().optional(),
    requireSources: z.boolean().optional(),
  })
  .strict();

/**
 * The shared duration-string grammar (Phase 3 §3.1 heartbeat, v0.3.0
 * `memory.ttl` and `memory.dream.every`). Extended with `d` (days) in
 * 0.3.0. Parsed to milliseconds at lower time by the compiler's
 * `parseDurationToMs`.
 */
const DURATION_REGEX = /^\d+(?:ms|s|m|h|d)$/;

/**
 * v0.3.0 Goal 5 (§6/§9) — the `memory.dream` sub-block: scheduled memory
 * consolidation. Nested under `memory:` because it consolidates the memory
 * fabric (facts + wiki + continuity's spec-scoped agenda) — one shared zod
 * object, minimal union churn.
 *
 *   - `every` (required): the consolidation cadence in the shared duration
 *     grammar (`"24h"`, `"1d"`). Must be >= 5m (enforced at lower time) —
 *     consolidation is a maintenance pass, not a per-turn hook.
 *   - `mode`: `full` (default — deterministic phase + ONE bounded model
 *     synthesis session) | `deterministic` (no model, ever).
 *   - `budget_usd`: the model phase's item-27 spend cap (OPTIMIZABLE,
 *     PR 20). `0` — or omitting it — means deterministic only, regardless
 *     of `mode`; unattended model spend must be opted into by number.
 *   - `instructions`: optional playbook override; the default is the
 *     builtin `dream` skill body.
 * `.strict()` so a typo'd sub-key fails the build.
 */
const memoryDreamBlock = z
  .object({
    every: z
      .string()
      .regex(
        DURATION_REGEX,
        'memory.dream.every must be a duration like "24h", "1d", "30m", or "300s"',
      ),
    mode: z.enum(["deterministic", "full"]).optional(),
    budget_usd: z.number().nonnegative().optional(),
    instructions: z.string().min(1).optional(),
  })
  .strict();

/**
 * Feature #53 — cross-session memory block. Its mere presence wires the
 * Remember/Recall tools into the harness (no hand-editing). The auto-*
 * switches layer on top: `autoCapture` summarizes the session's durable
 * outcomes into `.crewhaus/memories/<name>.jsonl` at run teardown;
 * `autoRecall` injects the top-`recallK` relevant memories into the system
 * prompt at session start (mirrors project-memory auto-load). Carried on the
 * agent-loop shapes (cli, channel, managed, research, crew).
 *
 * Loop contract 0.4 (Batch E, G46) — DEFAULT CHANGE (mildly breaking): when
 * the `memory:` block is PRESENT, `autoRecall` now defaults to `true`
 * (`"session-start"`) and `autoCapture` defaults to `true` (behind the
 * existing `autoCaptureThreshold` gate) — both previously defaulted to
 * `false`. The resolved booleans are stamped into the IR at lower time, so
 * declaring `memory:` at all opts into recall+capture. Opt back out with
 * `autoRecall: false` / `autoCapture: false`.
 *
 * EMBEDDER RESOLUTION ORDER (Batch E, G76) — coherent across the three
 * embedder knobs, applied by the runtime/emitters (the IR carries the raw
 * declared strings):
 *   - fact-store recall + the compaction curator: `memory.embedder` →
 *     `memory.wiki.embedder` → (none ⇒ BM25-only lexical);
 *   - the wiki semantic tier: `memory.wiki.embedder` → `memory.embedder` →
 *     (none ⇒ BM25-only);
 *   - agent-shape RAG (the `knowledge:` block): `knowledge.embedder` →
 *     `memory.embedder` → `memory.wiki.embedder` (a vector store needs
 *     embeddings, so with all three absent the target falls back to its
 *     default embedder model rather than BM25).
 *
 * v0.3.0 (§9) extensions — all optional so pre-0.3.0 specs parse (and lower)
 * unchanged:
 *   - `backend`: `file` (the default when absent) | `thredz` (reserved — the
 *     store flip ships with the `thredz:` block, PR 16). Deliberately NOT
 *     zod-defaulted: only declared fields are carried into the IR, keeping
 *     existing memory bundles byte-identical.
 *   - `ttl`: explicit forgetting for auto-captured facts, as a duration
 *     string in the heartbeat grammar extended with `d` (days) — e.g. "90d".
 *     Must be >= 1h (enforced at lower time); omit to keep facts forever.
 *   - `wiki`: the semantic tier (see {@link memoryWikiBlock}).
 *   - `dream`: scheduled consolidation (see {@link memoryDreamBlock}, §6).
 * `.strict()` so a typo'd sub-key fails the build.
 */
const memoryBlock = z
  .object({
    enabled: z.boolean().optional(),
    backend: z.enum(["file", "thredz"]).optional(),
    /** Loop contract 0.4 (Batch A) — top-level embedder for the FACT store
     *  (same `@crewhaus/embedder` factory grammar as `wiki.embedder`).
     *  Runtime fallback order: `embedder` → `wiki.embedder` — declaring
     *  only the wiki one keeps prior behaviour; the top-level knob lets a
     *  spec enable hybrid fact recall without enabling the wiki tier. */
    embedder: z.string().min(1).optional(),
    ttl: z
      .string()
      .regex(
        DURATION_REGEX,
        'memory.ttl must be a duration like "90d", "12h", "30m", "60s", or "500ms"',
      )
      .optional(),
    autoCapture: z.boolean().optional(),
    autoCaptureThreshold: z.number().int().positive().optional(),
    /** Loop contract 0.4 (Batch E, G21) — WHEN auto-recall runs. The boolean
     *  form is the pre-0.4 on/off switch (`true` ≡ `"session-start"`); the
     *  string form picks the cadence: `"session-start"` injects the recalled
     *  block ONCE at boot (the default when memory is present, G46), while
     *  `"per-turn"` re-runs the recall closure against the latest user message
     *  every turn (or every `refreshEvery` turns) and swaps the volatile
     *  recalled tail block WITHOUT re-injecting into the frozen cache prefix. */
    autoRecall: z.union([z.boolean(), z.enum(["session-start", "per-turn"])]).optional(),
    /** Loop contract 0.4 (Batch E, G21) — turns between per-turn recall
     *  refreshes (int > 0). Declaring it implies `autoRecall: "per-turn"`
     *  (it IS the "every N turns" cadence knob); `"per-turn"` without it
     *  refreshes every turn. OPTIMIZABLE (`["memory","refreshEvery"]`). It is
     *  a contradiction alongside `autoRecall: false` (rejected at lower time).*/
    refreshEvery: z.number().int().positive().optional(),
    recallK: z.number().int().positive().max(50).optional(),
    /** Loop contract 0.4 (Batch E, G77) — fold session summaries in as a
     *  third RRF ranker in the recall fusion (over the existing
     *  sessions-index), beside the fact-store and wiki rankers. Default
     *  false; opting in surfaces "what we concluded last time" without a
     *  dedicated tool call. */
    sessionRecall: z.boolean().optional(),
    wiki: memoryWikiBlock.optional(),
    dream: memoryDreamBlock.optional(),
  })
  .strict()
  .optional();

// Vector-store backend ids accepted in specs. Mirrors `VectorBackendId`
// from @crewhaus/vector-store (and `IrVectorBackend`) — the canonical set
// of implemented backends — kept inline so the spec stays dependency-light.
// Keep in sync when a backend is added or removed. (Declared here, above the
// first consumer — the `knowledge:` block — so the cli/channel/managed
// schemas can reference it; the pipeline/research retrieve blocks below reuse
// the same const.)
const VECTOR_BACKENDS = ["in-memory", "lance", "qdrant", "pinecone", "weaviate"] as const;

// The HTTP backends construct only with a `url` + `collection` (the
// vector-store factory throws otherwise); parseSpec requires both so a
// spec that selects one without them fails at compile, not at runtime.
const HTTP_VECTOR_BACKENDS = new Set(["qdrant", "pinecone", "weaviate"]);

/**
 * Loop contract 0.4 (Batch E, G22) — a single knowledge source: exactly ONE
 * of `path` (a file/dir on disk), `glob` (a shell glob) or `url` (a remote
 * document) per entry. The exactly-one rule is a self-contained superRefine
 * so the error is path-bearing at the offending source.
 */
const knowledgeSourceSchema = z
  .object({
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const set = [s.path, s.glob, s.url].filter((v) => v !== undefined).length;
    if (set !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "each knowledge source needs exactly one of path/glob/url",
        path: [],
      });
    }
  });

/**
 * Loop contract 0.4 (Batch E, G22) — the agent-shape RAG block. Presence
 * registers the EXISTING `@crewhaus/tool-retrieve` (chunker → embedder →
 * vector-store) as a `Retrieve` tool with citations, ingesting `sources` at
 * build/boot. It REUSES target-pipeline's retrieve lowering + engine (not a
 * fork), so the sub-keys mirror the pipeline shape:
 *   - `embedder`: the `@crewhaus/embedder` factory grammar for the retrieve
 *     tier. Optional; resolution order `knowledge.embedder → memory.embedder
 *     → memory.wiki.embedder → the target's default embedder model` (a vector
 *     store needs embeddings — see the memory block's EMBEDDER RESOLUTION
 *     ORDER note).
 *   - `vector_backend`: the SAME enum as pipeline `retrieve.vectorBackend`
 *     (default `in-memory`).
 *   - `sources` (required, >= 1): the corpus to ingest (see
 *     {@link knowledgeSourceSchema}).
 *   - `chunk.size` / `chunk.overlap`: chunker tuning (OPTIMIZABLE); default
 *     to pipeline's 400 / 0 at lower time.
 *   - `default_k`: hits returned per Retrieve call (int 1..50, default 5,
 *     OPTIMIZABLE).
 * `.strict()` so a typo'd sub-key fails the build. Carried on cli/channel/
 * managed (the interactive agent-loop shapes); the pipeline shape keeps its
 * dedicated first-class `retrieve:`/`indexing:` blocks.
 */
const knowledgeBlock = z
  .object({
    embedder: z.string().min(1).optional(),
    vector_backend: z.enum(VECTOR_BACKENDS).optional(),
    sources: z.array(knowledgeSourceSchema).min(1),
    chunk: z
      .object({
        size: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    default_k: z.number().int().positive().max(50).optional(),
  })
  .strict()
  .optional();

/**
 * v0.3.0 Goal 1 (§2.1) — the top-level `continuity:` block: focus, plans,
 * goals, the proof-of-action ladder, the requirements ledger, and teardown
 * handoff. THE release's one sanctioned default-on behavior change
 * (ROADMAP.md:9): on the emit-wired agent-loop shapes (cli, channel, managed,
 * research, crew) an ABSENT key lowers to the default-on config —
 * `continuity: false` is the opt-out that restores prior bundle bytes
 * exactly (byte-diff-pinned).
 *
 * Forms: boolean shorthand (`continuity: true|false`) or the strict object:
 *   - `enabled`: `false` disables (same as the `false` shorthand).
 *   - `plan`: plan/goal persistence + the Plan and Goal tool families
 *     (default true; `false` keeps only FocusRead/FocusWrite + MemoryClear).
 *   - `proof`: `ladder` (default — claimed is free, proven is machine-checked)
 *     | `require` (refuse plan completion below proven; `init` templates)
 *     | `off` (no verification). See §2.4.
 *   - `ledger`: the verbatim requirements ledger (§2.3; default true).
 *   - `handoff`: deterministic teardown handoff.md (§2.8; default true).
 *   - `scope`: `auto` (default) | `spec` | `session` — §2.7/§14.5: `auto`
 *     resolves at lower time to `spec` on cli/research/crew/managed (managed
 *     additionally tenant-fenced at boot) and `session` (per-conversation)
 *     on channel; explicit `session` is only accepted on shapes with session
 *     routing (channel).
 *   - `focusMaxChars`: hard cap on the mutable tail block (default 4096;
 *     OPTIMIZABLE, PR 20).
 *
 * Also carried (spec-parsed, compiled with an ignored-note comment) on
 * workflow, batch, voice, browser; deliberately NOT on graph/pipeline/eval/
 * onchain/onchain-game — the strict union rejects it loudly there, which
 * beats silent dead config.
 */
const continuityObject = z
  .object({
    enabled: z.boolean().optional(),
    plan: z.boolean().optional(),
    proof: z.enum(["ladder", "require", "off"]).optional(),
    ledger: z.boolean().optional(),
    handoff: z.boolean().optional(),
    scope: z.enum(["auto", "spec", "session"]).optional(),
    focusMaxChars: z.number().int().positive().optional(),
  })
  .strict();

const continuityBlock = z.union([z.boolean(), continuityObject]).optional();

/**
 * v0.3.0 Goal 3 (§4.1) — the top-level `thredz:` block: ONE knob that flips
 * the memory fabric's wiki backend to a hosted Thredz wiki over the published
 * `thredz-mcp` stdio server (npm, v0.3.0 — 27 tools incl. `goal_*`/`task_*`
 * and the `wiki_space_*` pair).
 *
 * Forms:
 *   - boolean shorthand: `thredz: true` ≡ `{ api_key: "$THREDZ_API_KEY" }`
 *     (`false` ≡ absent — the explicit opt-out).
 *   - string shorthand: `thredz: $THREDZ_API_KEY` — THE one argument.
 *   - the strict object:
 *       · `api_key` (required): credential-lowered to an `IrSecretRef`
 *         (`lowerCredential` — fail-fast on a malformed `$…` env ref).
 *       · `base_url`: self-hosted / local Thredz API base
 *         (`THREDZ_API_BASE` in the synthesized server env).
 *       · `visibility`: `private` (DEFAULT — overrides Thredz's
 *         shared-by-default foot-gun) | `shared`; becomes the synthesized
 *         server's `THREDZ_DEFAULT_VISIBILITY`.
 *       · `goals`: mirror continuity goal writes to Thredz `goal_write`/
 *         `goal_update` (spec-scoped ONLY, §14.5 decision 5). Default: on
 *         when continuity goals are on.
 *       · `agents`: register an addressable agent handle at boot
 *         (idempotent `agent_register`). `true` derives the handle from the
 *         spec name; a string names it explicitly. Default off.
 *
 * Carried on the five memory shapes (cli, channel, managed, research, crew);
 * the strict unions reject it loudly elsewhere. Emit-wiring in this release
 * is the cli shape (compiled bundle + `crewhaus run`); the other four carry
 * the block with the 0.2.3-convention ignored-note comment.
 */
const THREDZ_HANDLE_RE = /^[a-z][a-z0-9-]{2,31}$/;

const thredzObject = z
  .object({
    api_key: z.string().min(1),
    base_url: z.string().url().optional(),
    visibility: z.enum(["private", "shared"]).optional(),
    /**
     * 0.5.0 — a Thredz **wiki space** (Pro/Scale) to scope this agent's memory
     * to; becomes the synthesized server's `THREDZ_DEFAULT_SPACE`. A `shared`
     * space is readable by every wiki-enabled key on the account; an
     * `individual` space only by the key that owns it.
     *
     * The space TYPE is chosen when the space is created (over the API, or via
     * the model-callable `wiki_space_create`), not here — so this cannot be
     * validated at compile time and `visibility` is not cross-checked against
     * it. Inside a space the space's type decides visibility outright.
     *
     * ONE individual space per API KEY is a hard Thredz limit, so per-agent
     * private memory means a per-agent `api_key`. That is one `thredz:` block
     * per spec today; a crew gives each role its own (see the role-keyed form).
     */
    space: z.string().min(1).optional(),
    goals: z.boolean().optional(),
    agents: z
      .union([
        z.boolean(),
        z
          .string()
          .regex(
            THREDZ_HANDLE_RE,
            "thredz.agents must be a lowercase handle matching ^[a-z][a-z0-9-]{2,31}$ (or true to derive one from the spec name)",
          ),
      ])
      .optional(),
    /**
     * Item 5 (G44) — enable the nine Thredz messaging tools (`message_send`
     * / `inbox_poll` / `message_ack` / `thread_get` / `agent_*`). DEFAULT
     * false: the send-side tools are destructive + justification-gated, so
     * they stay off unless the author asks. The Thredz server side is already
     * live (thredz-api) — this flips their registration on.
     */
    messaging: z.boolean().optional(),
  })
  .strict();

const thredzBlock = z.union([z.boolean(), z.string().min(1), thredzObject]).optional();

/**
 * 0.5.0 — the CREW-ONLY superset of {@link thredzObject}. `roles` fans the
 * block out per role so each role can carry its OWN `api_key` and its own
 * `space`; every other field at this level is the DEFAULT a role inherits and
 * may override.
 *
 * WHY THE MAP LIVES HERE, under `thredz.roles.<role>`, and NOT on the role as
 * `roles.<role>.thredz` — this is load-bearing, not taste. Two security
 * surfaces prefix-match on `["thredz"]`:
 *
 *   - `@crewhaus/spec-patch`'s `OPTIMIZABLE_PATHS.crew` allows `["roles"]`
 *     (whole-role replacement) and matches by PREFIX. Under `roles.*`, a
 *     role's `api_key` would become optimizer-reachable and
 *     `optimize --write-back` could rewrite a credential.
 *   - the hangar's spec editor denies the `["thredz"]` prefix outright
 *     ("thredz crosses the harness boundary to a hosted wiki"). Under
 *     `roles.*`, `api_key` would be editable from a browser.
 *
 * Keeping the fan-out under `thredz.` inherits both protections with zero
 * code change. The `^thredz:` header/badge regexes keep matching too.
 *
 * `api_key` is optional ONLY here: a pure fan-out crew gives every role its
 * own key and needs no crew-wide one. The refinement below enforces that at
 * least one of the two exists.
 */
const crewThredzObject = thredzObject
  .extend({
    api_key: z.string().min(1).optional(),
    roles: z.record(safeName, thredzObject.partial({ api_key: true })).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const fanOut = t.roles !== undefined && Object.keys(t.roles).length > 0;
    if (!fanOut && t.api_key === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "thredz.api_key is required unless thredz.roles gives each role its own key (one individual wiki space per API key is a hard Thredz limit, so per-role private memory needs per-role keys)",
      });
    }
  });

/** The crew mount: the shorthands still work, plus the role-keyed superset. */
const crewThredzBlock = z.union([z.boolean(), z.string().min(1), crewThredzObject]).optional();

/**
 * v0.3.0 Goal 2 (§3.3, PR 17) — the top-level `learning:` block: continual
 * learning as a first-class capability. Presence (with `enabled` not `false`)
 * registers the builtin `learning-loop` skill with `domain`/`curriculum`/
 * `sources` substituted at compile time, gates in the `/study` `/reflect`
 * (and, with `exam`, `/exam`) slash commands, and enforces Sources-required
 * wiki writes deterministically.
 *
 * Learning NEEDS a wiki — the knowledge lives there, not in the prompt — so
 * the compiler REQUIRES `memory.wiki` (local files) or `thredz:` (hosted)
 * alongside this block (cross-field CompilerError otherwise).
 *
 *   - `domain` (required): one sentence naming the field of expertise —
 *     substituted into the learning-loop skill body.
 *   - `curriculum`: spec-relative path to an agent-editable checkbox-ladder
 *     file (e.g. `curriculum.md`). Optional; without it the skill keeps the
 *     ladder in the wiki. Whether the file EXISTS is a runtime concern.
 *   - `sources`: source-allowlist hints (domains/patterns) woven into the
 *     skill's STUDY gathering rules. Deliberately NOT optimizable — an
 *     allowlist is a security surface (§7.5).
 *   - `exam`: spec-relative `dataset` (jsonl) + `graders` (yaml) paths for
 *     the first-class competency exam: `/exam` drives a programmatic
 *     eval-runner invocation (the `run_exam` tool — no Bash shell-out), and
 *     every failed sample is logged as a knowledge gap automatically.
 *   - `study`: unattended-study toggles, both default ON —
 *       · `on_heartbeat`: prepend the study-rotation preamble (gaps first,
 *         ~3:1 study:reflect, bounded per tick) to channel heartbeat
 *         instructions;
 *       · `on_dream`: seed the dream model phase's findings with the top
 *         open knowledge gaps + the next unmastered curriculum rung.
 *
 * Carried on the five memory shapes (cli, channel, managed, research, crew);
 * the strict unions reject it loudly elsewhere. `.strict()` throughout so a
 * typo'd sub-key fails the build.
 */
const learningBlock = z
  .object({
    enabled: z.boolean().optional(),
    domain: z.string().min(1),
    curriculum: z.string().min(1).optional(),
    sources: z.array(z.string().min(1)).optional(),
    exam: z
      .object({
        dataset: z.string().min(1),
        graders: z.string().min(1),
      })
      .strict()
      .optional(),
    study: z
      .object({
        on_heartbeat: z.boolean().optional(),
        on_dream: z.boolean().optional(),
      })
      .strict()
      .optional(),
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

/**
 * Loop contract 0.4 (Batch C, G26) — the observability control sub-blocks.
 * These declare which of the runtime's observability subscribers the emitted
 * bundle wires and how it stamps their env / subscriber options.
 *
 * DEFAULTS SEMANTICS (critical — mirrored in `@crewhaus/ir` + the lowering):
 * cost tracking and the trace ring buffer are DEFAULT ON even when the whole
 * `observability:` block is absent — spec ABSENCE is NOT `off`. An EXPLICIT
 * opt-out (`cost: { enabled: false }` / `trace: { level: off }`) wins. So the
 * lowering carries only what the spec declares (absent sub-block ⇒ absent IR
 * key ⇒ the emitter applies the default), and the presence of an explicit
 * `enabled: false` / `level: off` is what turns a subscriber off.
 *
 *   - `trace.level`: `off` (no ring buffer, no printer) | `ring` (ring buffer
 *     only, the DEFAULT) | `pretty` (ring + colorised stderr printer) | `json`
 *     (ring + JSON-Lines printer). Absent ⇒ `ring`.
 *   - `metrics.enabled`: attach the metrics-collector subscriber. Opt-IN —
 *     absent ⇒ off.
 *   - `cost.enabled`: attach the cost-tracker subscriber. DEFAULT ON — absent
 *     ⇒ on; set `false` to suppress cost accrual entirely.
 *   - `alerts.enabled`: arm the alert watchdog. Opt-IN — absent ⇒ off.
 *   - `incidents.enabled`: arm incident capture. Opt-IN — absent ⇒ off.
 *   - `otel.endpoint`: OTLP exporter endpoint (e.g. `http://localhost:4318`).
 *     Absent ⇒ no OTel export. Carried verbatim (a `$VAR` value is the
 *     emitter's to resolve).
 *
 * Every feature toggle carries a `.default(true)` on `enabled` so a bare
 * `metrics: {}` reads as "on"; the ABSENT-block default (opt-in features off,
 * cost/ring on) is applied downstream, not here. `.strict()` so a typo'd
 * sub-key fails the build.
 */
const observabilityToggle = z.object({ enabled: z.boolean().default(true) }).strict();

const observabilityTraceBlock = z
  .object({ level: z.enum(["off", "ring", "pretty", "json"]).default("ring") })
  .strict();

const observabilityOtelBlock = z.object({ endpoint: z.string().min(1).optional() }).strict();

const observabilityBlock = z
  .object({
    slo: sloBlock.optional(),
    // Loop contract 0.4 (Batch C, G26) — subscriber/exporter controls.
    trace: observabilityTraceBlock.optional(),
    metrics: observabilityToggle.optional(),
    cost: observabilityToggle.optional(),
    alerts: observabilityToggle.optional(),
    incidents: observabilityToggle.optional(),
    otel: observabilityOtelBlock.optional(),
  })
  .strict()
  .optional();

/**
 * "Watch me" — the sampled phase-2 judge pass of `crewhaus watchme report`,
 * the ONE model-spending analysis phase. Absent ⇒ deterministic-only reports
 * (the field defaults below still resolve at lower time, so a budgeted judge
 * always names a model).
 */
const watchmeJudgeBlock = z
  .object({
    /** Judge model for the sampled phase-2 quality pass. Refused at runtime
     *  if unpriced (dream-engine pattern) — the budget cap must be
     *  enforceable. */
    model: z.string().min(1).default("claude-haiku-4-5"),
    /** Fraction of ungraded turns escalated to the judge. */
    sample_rate: z.number().min(0).max(1).default(0.15),
    /** Per-report spend cap. 0 (default) = deterministic-only reports. */
    budget_usd: z.number().min(0).default(0),
  })
  .strict();

/**
 * "Watch me" — observe this harness's interactions and learn from them
 * (design/watch-me.md). Presence turns on the live capture tap; `crewhaus
 * watchme report` distills the watched sessions post-hoc. Carried on the
 * three interactive-loop shapes (cli, channel, managed); the strict unions
 * reject the key loudly elsewhere (research/crew are a named deferral,
 * design/watch-me.md §13.1).
 *
 * Deliberately a SIBLING of `observability:`, not a sub-key of it:
 * observability controls the generic telemetry subscribers (ring buffer,
 * printers, metrics, cost, alerts, otel) while watchme is a learning feature
 * with its own durable store and spec-synthesis outputs. Capture is
 * INDEPENDENT of `observability.trace.level` — that knob controls the ring
 * buffer + printers only, never the watchme tap.
 *
 * Every knob defaults, so a bare `watchme: {}` is a complete declaration.
 * NO `watchme.*` path is optimizer-tunable — see the exclusion note beside
 * OPTIMIZABLE_PATHS in `@crewhaus/spec-patch`.
 */
const watchmeBlock = z
  .object({
    enabled: z.boolean().default(true),
    /** "full" = write the .events.jsonl trace sibling; "mirrors" = rely on the
     *  default-on advisor mirrors only (retro-analysis grade, no extra file). */
    capture: z.enum(["full", "mirrors"]).default("full"),
    judge: watchmeJudgeBlock.optional(),
    /** "user" additionally registers this harness in the global registry at run time. */
    scope: z.enum(["harness", "user"]).default("harness"),
    /** Publish redacted distilled findings to the wiki/Thredz at report time. */
    share: z.boolean().default(false),
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
 * BOTH cli surfaces print this banner on cold start — the compiled
 * bundle and `crewhaus run` (which used to ignore the block entirely,
 * making an authored banner invisible to anyone who ran the spec
 * directly). Suppressed under `--resume` / `--continue` so resumed
 * sessions don't re-banner, and under `CREWHAUS_RESUMED=1` for a
 * wrapper re-invoking a compiled bundle. Static mode picks the first
 * tagline; random mode picks one uniformly per startup.
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
     * Phase 2 M2.2 — TUI mode. `"basic"` is the readline-driven REPL and the
     * only mode. Loop contract 0.4 (Batch F, G81) DROPS the never-implemented
     * `"rich"` (Ink-based) placeholder: it compiled identically to `"basic"`,
     * so it only ever advertised a capability that did not exist. Declaring
     * it now fails the compile with a migration note; a future rich TUI would
     * reintroduce the value when it actually ships.
     */
    tui: z
      .literal("basic", {
        errorMap: () => ({
          message:
            'cli.tui "rich" was never implemented and is dropped in loop-contract 0.4 — remove the `tui:` key (the basic readline REPL is the only mode).',
        }),
      })
      .default("basic"),
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
const heartbeatBlock = z
  .object({
    every: z
      .string()
      .regex(
        DURATION_REGEX,
        'heartbeat.every must be a duration like "1d", "2h", "30m", "60s", or "500ms"',
      ),
    instructions: z.string().min(1),
  })
  .strict()
  .optional();

/**
 * Loop contract 0.4 (Batch F, temporal contract / G84 schedule half) — a
 * `schedule:` block on the daemon-able shapes (channel / managed / batch): a
 * cron OR interval wake trigger, lowered into the emitted daemon's wake loop
 * by the temporal downstream. `jitter` (a duration) spreads a random +/- delay
 * across the trigger so a fleet of identical daemons doesn't stampede on the
 * boundary; `instructions` is the synthetic prompt each wake runs (the
 * heartbeat contract, generalised past the fixed interval to a cron). Exactly
 * one of the two `kind`s — the discriminated union makes the required field
 * per kind (`cron` vs `every`) a type error to omit.
 *
 * Unlike `heartbeat` (channel-only, interval-only), `schedule` is the general
 * temporal surface: it accepts a cron expression AND rides the `runs resume`
 * rehydration path, so an interrupted scheduled run resumes exactly-once.
 */
// A 5- or 6-field cron expression (minute-granularity, optional seconds/year).
// Field validity beyond the char class is the daemon's cron parser's job.
const CRON_REGEX = /^[0-9*\/,\-?LW#]+(?:\s+[0-9*\/,\-?LW#]+){4,5}$/;

const scheduleJitter = z
  .string()
  .regex(DURATION_REGEX, 'schedule.jitter must be a duration like "30s", "5m", or "500ms"');

const scheduleCronBlock = z
  .object({
    kind: z.literal("cron"),
    cron: z
      .string()
      .regex(
        CRON_REGEX,
        'schedule.cron must be a 5- or 6-field cron expression, e.g. "0 */6 * * *"',
      ),
    /** IANA tz name the cron is evaluated in (e.g. "America/New_York"). */
    timezone: z.string().min(1).optional(),
    jitter: scheduleJitter.optional(),
    instructions: z.string().min(1).optional(),
  })
  .strict();

const scheduleIntervalBlock = z
  .object({
    kind: z.literal("interval"),
    every: z
      .string()
      .regex(DURATION_REGEX, 'schedule.every must be a duration like "6h", "30m", or "60s"'),
    jitter: scheduleJitter.optional(),
    instructions: z.string().min(1).optional(),
  })
  .strict();

const scheduleBlock = z
  .discriminatedUnion("kind", [scheduleCronBlock, scheduleIntervalBlock])
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

/**
 * Item 1 (G30) — the `expose:` block: project THIS compiled bundle's turn
 * function as an MCP server so Claude Code / IDEs / other CrewHaus runtimes
 * can call the whole agent as a tool. Carried on the serving shapes
 * (cli/channel/managed).
 *
 *   - `mcp.transport`: `stdio` (a spawned stdio MCP server — the
 *     `crewhaus serve --mcp` path) or `sse` (an HTTP+SSE endpoint; SSE-backed
 *     exposure rides the gateway-server tenancy/budgets where the shape has
 *     them).
 *   - `mcp.tools`: `chat` (DEFAULT — one primary invoke tool taking
 *     `{ message }` and returning the final assistant text) or `per-subagent`
 *     (that primary tool PLUS one tool per declared sub-agent). `per-subagent`
 *     needs sub-agents to project — enforced cross-field in `parseSpec`.
 *
 * Omitted entirely → the bundle is not exposed as an MCP server (the default).
 */
const exposeBlock = z
  .object({
    mcp: z
      .object({
        transport: z.enum(["stdio", "sse"]),
        tools: z.enum(["chat", "per-subagent"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

/**
 * Item 3 (G32) — the `plugins:` list: names of installed marketplace plugins
 * whose contributions (tools / channels / models / graders / emitters, plus
 * skill dirs) this bundle loads at boot. Each entry is a plugin NAME resolved
 * against the pinned `plugin-registry` (the Ed25519 supply chain guards
 * install; this wires the previously-missing load path). Order is honoured
 * (load order). The `crewhaus run --plugins` flag overrides the list. Carried
 * on the codegen-serving shapes whose boot path reads the registry (cli +
 * channel).
 */
const pluginsBlock = z.array(z.string().min(1)).optional();

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
        // Loop contract 0.4 (Batch A) — extended-thinking selector.
        thinking: thinkingBlock,
        // Loop contract 0.4 (Batch A) — stream partial output tokens.
        // Optional; absent means false (the cli-shape default).
        streaming: z.boolean().optional(),
        // Loop contract 0.4 (Batch A) — per-tool rate limits.
        rate_limits: rateLimitsBlock,
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
    limits: limitsBlock,
    hooks: hooksBlock,
    // Batch G — expose the bundle as an MCP server (G30) + load marketplace
    // plugins at boot (G32).
    expose: exposeBlock,
    plugins: pluginsBlock,
    // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
    evaluation: evaluationBlock,
    feedback: feedbackBlock,
    memory: memoryBlock,
    // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
    knowledge: knowledgeBlock,
    continuity: continuityBlock,
    thredz: thredzBlock,
    learning: learningBlock,
    observability: observabilityBlock,
    // "Watch me" — observe-and-learn (sibling of observability, see watchmeBlock).
    watchme: watchmeBlock,
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
    // Model max OUTPUT tokens for this step's turn (mirrors cli
    // `agent.max_tokens`). Optional; runtime default when omitted.
    max_tokens: z.number().int().positive().optional(),
    // Loop contract 0.4 (Batch A) — per-step extended-thinking selector.
    thinking: thinkingBlock,
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    // Item 9 (G37) — per-step model routing, adopting the cli agent block's
    // pooled pattern verbatim: ordered failover + breaker tuning + two-tier
    // router + N-candidate pool, sharing the one mutual-exclusion rule via
    // `refineModelSelection`. A PolicyRouter decides per step against the
    // shared routing-store scoreboard. Omitted → the step's single
    // (`step.model ?? workflow.model`) model, byte-identical bundles.
    model_fallbacks: modelFallbacksBlock,
    circuit_breaker: circuitBreakerBlock,
    model_tiers: modelTiersBlock,
    model_pool: modelPoolBlock,
  })
  .strict()
  .superRefine(refineModelSelection);

/**
 * Loop contract 0.4 (Batch B, G02) — the `kind: "judge"` workflow-step
 * variant: a gate over the PREVIOUS step's output (see
 * {@link judgeGateBlock}). Judge steps run no agent turn of their own, so
 * they carry no instructions/tools — only the gate config. A judge step
 * cannot be the first step (there is no previous output to gate; enforced
 * in `parseSpec`). Regular steps stay exactly as before (no `kind` key).
 */
const workflowJudgeStepSchema = z
  .object({
    name: safeName,
    kind: z.literal("judge"),
    judge: judgeGateBlock,
  })
  .strict()
  .describe("judge gate step: scores the previous step's output instead of running an agent turn");

const workflowAnyStepSchema = z.union([workflowStepSchema, workflowJudgeStepSchema]);

const workflowSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("workflow"),
    model: z.string().min(1),
    steps: z.array(workflowAnyStepSchema).min(1),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    limits: limitsBlock,
    hooks: hooksBlock,
    // v0.3.0 — carried but not emit-wired in 0.3.0 (ignored-note comment in
    // the generated bundle; NOT default-on here).
    continuity: continuityBlock,
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
    // The token Meta presents on the GET callback-URL verification handshake
    // (`hub.verify_token`). Optional: a daemon serving an already-verified
    // subscription does not need it, and without it the handshake fails
    // closed rather than echoing an unauthenticated challenge.
    verifyToken: z
      .string()
      .min(1)
      .optional()
      .describe(
        "shared token echoed back on Meta's GET callback-URL verification handshake; required to verify a new webhook subscription",
      ),
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
    // Model max OUTPUT tokens for one turn (mirrors cli `agent.max_tokens`).
    // Optional; runtime default when omitted.
    max_tokens: z.number().int().positive().optional(),
    // Loop contract 0.4 (Batch A) — extended-thinking selector.
    thinking: thinkingBlock,
    // Loop contract 0.4 (Batch A) — per-tool rate limits.
    rate_limits: rateLimitsBlock,
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
    limits: limitsBlock,
    hooks: hooksBlock,
    // Batch G — expose the daemon's turn as an MCP server (G30) + load
    // marketplace plugins at boot (G32).
    expose: exposeBlock,
    plugins: pluginsBlock,
    // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
    evaluation: evaluationBlock,
    feedback: feedbackBlock,
    memory: memoryBlock,
    // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
    knowledge: knowledgeBlock,
    continuity: continuityBlock,
    thredz: thredzBlock,
    learning: learningBlock,
    observability: observabilityBlock,
    // "Watch me" — observe-and-learn (sibling of observability, see watchmeBlock).
    watchme: watchmeBlock,
    heartbeat: heartbeatBlock,
    // Loop contract 0.4 (Batch F) — cron/interval wake trigger (the general
    // temporal surface beside the interval-only `heartbeat`).
    schedule: scheduleBlock,
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
    // Model max OUTPUT tokens for this node's turn (mirrors cli
    // `agent.max_tokens`). Optional; runtime default when omitted.
    max_tokens: z.number().int().positive().optional(),
    // Loop contract 0.4 (Batch A) — per-node extended-thinking selector.
    thinking: thinkingBlock,
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    /**
     * A human approval gate on this node, and a PRE-condition: the node
     * calls `ctx.requestApproval(prompt)` BEFORE its model turn, so the
     * prompt is answered against the UPSTREAM state (which the `hitl_pause`
     * event and the bundle's pause report both print) and no tokens are
     * spent until the human answers. The engine pauses, persists a
     * checkpoint, and waits for `resume(checkpointId, decision)` from the
     * operator/CLI; the resumed run replays this node from the top and
     * makes its FIRST model call.
     *
     * The decision string is recorded at `state["<node>_decision"]`, which
     * every downstream node reads as part of the upstream state. (NOTE:
     * `edges[].when.key` cannot name it yet — that key must name a declared
     * node; see the `graphEdgeWhenSchema` note below.) A rejecting decision
     * — `reject`, `no`, `deny`, `decline`, `abort`, `cancel`, `stop`, `veto`
     * (trimmed, case-insensitive) — cancels this node's turn entirely, so
     * the node records only its decision and no output; any other string,
     * including free text, approves it. To halt the run on a rejection,
     * guard the node's outgoing edge with `when: { key: <node>, exists:
     * true }` — a cancelled node records no output, so no edge matches.
     *
     * To have a human approve a node's OWN output, put the gate on the
     * DOWNSTREAM node: its upstream state is exactly that output.
     */
    hitl: z
      .object({
        prompt: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Loop contract 0.4 (Batch B, G02) — the `kind: "judge"` graph-node
 * variant: a gate over the node's UPSTREAM output (see
 * {@link judgeGateBlock}). Judge nodes run no agent turn of their own, so
 * they carry no instructions/tools — only the gate config. The graph entry
 * cannot be a judge node (there is no upstream output to gate; enforced in
 * `parseSpec`). Regular nodes stay exactly as before (no `kind` key).
 */
const graphJudgeNodeSchema = z
  .object({
    kind: z.literal("judge"),
    judge: judgeGateBlock,
  })
  .strict()
  .describe("judge gate node: scores the upstream node's output instead of running an agent turn");

const graphAnyNodeSchema = z.union([graphNodeSchema, graphJudgeNodeSchema]);

/**
 * Loop contract 0.4 (Batch A) — declarative edge predicate over the graph's
 * shared state. The generated graph state is a plain record where each node
 * writes its reply under its own name (`state["<nodeName>"]`), so `key`
 * names the upstream NODE whose recorded output the predicate reads
 * (cross-validated against `nodes` in `parseSpec`). Exactly ONE test form
 * must be declared (enforced by superRefine):
 *
 *   - `equals` — take the edge when `state[key] === equals` (string/number/
 *     boolean strict equality).
 *   - `exists: true` — take the edge when `state[key] !== undefined` (the
 *     node has produced output — which, for a `hitl:` node, is FALSE when
 *     the operator rejected the gate, since a rejected node records only
 *     `state["<node>_decision"]`).
 *
 * GAP (unchanged by the pre-condition HITL fix): `key` may not yet name a
 * hitl node's `<node>_decision` record — the cross-check below pins it to a
 * declared node name, so a rejection can be observed via `exists` on the
 * node itself but not matched on the decision string. Widening it means
 * touching the three mirrored checks (this one, ir-passes' graph
 * wellformedness, target-graph's validateGraph).
 *
 * Lowered to `IrGraphEdge.when` and emitted as a graph-engine
 * `EdgeCondition` (`(state) => state[key] === equals` / `!== undefined`).
 * The engine evaluates edges in declaration order and takes the first
 * match; an edge without `when` matches unconditionally.
 */
const graphEdgeWhenSchema = z
  .object({
    key: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    exists: z.literal(true).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const forms = (w.equals !== undefined ? 1 : 0) + (w.exists !== undefined ? 1 : 0);
    if (forms !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edge when requires exactly one of equals (value test) or exists: true",
      });
    }
  });

const graphEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    when: graphEdgeWhenSchema.optional(),
  })
  .strict();

const graphSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("graph"),
    model: z.string().min(1),
    entry: z.string().min(1),
    nodes: z.record(safeName, graphAnyNodeSchema),
    edges: z.array(graphEdgeSchema).default([]),
    /**
     * Loop contract 0.4 (Batch A) — parallel barrier groups, lowered onto
     * graph-engine's `addParallel`. Each group is >= 2 node names (the
     * engine rejects smaller groups) that execute concurrently when the
     * cursor reaches the group's FIRST member; execution continues from the
     * LAST member's outgoing edge. Node names are cross-validated against
     * `nodes` in `parseSpec`.
     */
    parallel: z.array(z.array(z.string().min(1)).min(2)).optional(),
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    limits: limitsBlock,
    hooks: hooksBlock,
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
    // Model max OUTPUT tokens for one turn (mirrors cli `agent.max_tokens`).
    // Optional; runtime default when omitted.
    max_tokens: z.number().int().positive().optional(),
    // Loop contract 0.4 (Batch A) — extended-thinking selector.
    thinking: thinkingBlock,
    // Loop contract 0.4 (Batch A) — per-tool rate limits.
    rate_limits: rateLimitsBlock,
    // Item 22 — provider failover chain (see modelFallbacksBlock docs).
    model_fallbacks: modelFallbacksBlock,
    circuit_breaker: circuitBreakerBlock,
    // Item 26 — opt-in two-tier turn-difficulty router.
    model_tiers: modelTiersBlock,
    // Adaptive model routing — N-candidate pool with a selection policy.
    model_pool: modelPoolBlock,
    // Loop contract 0.4 (Batch F, G81) — the managed daemon gets a tool
    // catalog + per-tenant tool_config overlays (applied at runtime through
    // the policy-engine's tenant context). Mirrors the channel agent block.
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
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
    limits: limitsBlock,
    hooks: hooksBlock,
    // Batch G — expose the managed daemon as an MCP server (G30). SSE-backed
    // exposure rides this shape's gateway-server tenancy/budgets. No
    // `plugins:` here: item 3's boot-path wiring covers cli + channel-bot
    // codegen, not the managed daemon.
    expose: exposeBlock,
    // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation.
    evaluation: evaluationBlock,
    // NEW-inloop-coverage — human-rating capture on the GATEWAY shape.
    //
    // WHAT MANAGED SUPPORTS: the daemon serves a `feedback.submit` JSON-RPC
    // method (params = the user-supplied FeedbackRecord subset) that appends
    // a standard record to `.crewhaus/feedback/<tenant>.jsonl` — the exact
    // sink `crewhaus distill` / `optimize --ratings` / `judge calibrate`
    // already read; and `autoDistill: true` registers the janitor step that
    // turns those ratings into versioned `<name>-ratings` registry datasets
    // on the daemon's own clock (D39), because a gateway daemon never runs a
    // `crewhaus run` teardown.
    //
    // WHAT IT CANNOT SUPPORT: `exitPrompt` is meaningless here (there is no
    // REPL to exit — the compiler warns when it is set), and
    // `channelReactions` is the channel shape's own inbound-reaction gate
    // (also warned). Both parse for schema uniformity across shapes rather
    // than being silently honoured.
    feedback: feedbackBlock,
    memory: memoryBlock,
    // Loop contract 0.4 (Batch E, G22) — agent-shape RAG over doc sources.
    knowledge: knowledgeBlock,
    continuity: continuityBlock,
    thredz: thredzBlock,
    learning: learningBlock,
    observability: observabilityBlock,
    // "Watch me" — observe-and-learn (sibling of observability, see watchmeBlock).
    // Parse + lower ONLY on this shape in v1: compile() warns accepted-but-unwired.
    watchme: watchmeBlock,
    // Loop contract 0.4 (Batch F) — cron/interval wake trigger.
    schedule: scheduleBlock,
  })
  .strict();

// Pipeline / RAG target (Section 21). Carries the embedder + vector-store
// config, an indexing pipeline, and a chat agent that uses Retrieve.
// (`VECTOR_BACKENDS` / `HTTP_VECTOR_BACKENDS` are declared above, beside the
// `knowledge:` block that first consumes them.)
const pipelineDocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Adaptive model routing — the minimal single-agent block on the pipeline
 * shape, carrying the opt-in `model_pool`. Its emitted runtime calls
 * `runChatLoop` with a single primary (exactly the cli shape's execution
 * model), so the pool routes there with zero runtime changes. The
 * superRefine is trivially satisfied today (the shape carries no
 * `model_tiers`/`model_fallbacks`) but keeps the mutual-exclusion rule
 * uniform if it ever gains them. NOT used by onchain/onchain-game: their
 * emitted bundles are callable modules whose agent-loop wiring is still
 * deferred (see target-onchain slice-2 notes), so a `model_pool` there
 * would be an inert spec field.
 */
const pooledSingleAgentObject = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
    // Adaptive model routing — N-candidate pool with a selection policy.
    model_pool: modelPoolBlock,
  })
  .strict();

const pooledSingleAgentSchema = pooledSingleAgentObject.superRefine(refineModelSelection);

/**
 * Loop contract 0.4 (Batch A) — the research/batch/browser variant of the
 * pooled single-agent block: pipeline's shape plus `max_tokens` (model max
 * OUTPUT tokens for one turn, mirroring the cli docblock — optional; when
 * omitted the runtime default applies; raise it for turns that emit large
 * outputs so the model isn't cut off mid-`tool_use`).
 */
const pooledSingleAgentWithMaxTokensSchema = pooledSingleAgentObject
  .extend({
    max_tokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine(refineModelSelection);

const pipelineSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("pipeline"),
    agent: pooledSingleAgentSchema,
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
    // Model max OUTPUT tokens for this role's turns (mirrors cli
    // `agent.max_tokens`). Optional; runtime default when omitted.
    max_tokens: z.number().int().positive().optional(),
    // Loop contract 0.4 (Batch A) — per-role extended-thinking selector.
    thinking: thinkingBlock,
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
    // Item 9 (G37) — per-role model routing, adopting the cli agent block's
    // pooled pattern verbatim: ordered failover + breaker tuning + two-tier
    // router + N-candidate pool, sharing the one mutual-exclusion rule via
    // `refineModelSelection`. A PolicyRouter decides per role against the
    // shared routing-store scoreboard. Omitted → the role's single
    // (`role.model ?? crew.model`) model, byte-identical bundles.
    model_fallbacks: modelFallbacksBlock,
    circuit_breaker: circuitBreakerBlock,
    model_tiers: modelTiersBlock,
    model_pool: modelPoolBlock,
  })
  .strict()
  .superRefine(refineModelSelection);

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
    budget: budgetBlock,
    // Loop contract 0.4 (Batch A) — crew is the ONE shape whose limits block
    // additionally accepts the `crew:` orchestration sub-block.
    limits: crewLimitsBlock,
    hooks: hooksBlock,
    // v0.3.0 — crew joins the memory-carrying shapes (§9: emit-wired; the
    // roles share the spec-scoped stores — the plan IS the coordination
    // surface, §2.7).
    memory: memoryBlock,
    continuity: continuityBlock,
    thredz: crewThredzBlock,
    learning: learningBlock,
    // Loop contract 0.4 (Batch C, G26) — crew joins the observability-carrying
    // shapes (cli/channel/managed): the orchestrator's cost/trace/metrics/
    // alert/incident/otel subscribers are spec-controllable per the shared
    // block's defaults semantics.
    observability: observabilityBlock,
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
    agent: pooledSingleAgentWithMaxTokensSchema,
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
    budget: budgetBlock,
    limits: limitsBlock,
    hooks: hooksBlock,
    memory: memoryBlock,
    continuity: continuityBlock,
    thredz: thredzBlock,
    learning: learningBlock,
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
    agent: pooledSingleAgentWithMaxTokensSchema,
    queue: batchQueueSchema,
    concurrency: z.number().int().min(1).max(64).default(4),
    idempotencyWindowMs: z.number().int().positive().default(60_000),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    limits: limitsBlock,
    hooks: hooksBlock,
    // v0.3.0 — carried but not emit-wired in 0.3.0 (ignored-note comment in
    // the generated bundle; NOT default-on here).
    continuity: continuityBlock,
    // Loop contract 0.4 (Batch F) — cron/interval wake trigger for the queue
    // worker daemon.
    schedule: scheduleBlock,
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
    // v0.3.0 — carried but not emit-wired in 0.3.0 (ignored-note comment in
    // the generated bundle; NOT default-on here).
    continuity: continuityBlock,
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
    /**
     * SECURITY — opt in to private/loopback navigation targets. Default false:
     * the Navigate tool refuses private/loopback/link-local/metadata hosts
     * before `driver.goto`, and the chromium backend routes every request
     * through a DNS-pinning proxy that refuses the same floor at the
     * connection layer. Together they stop a prompt-injected page from
     * reaching the host's own services.
     *
     * Set true ONLY when the browser legitimately must reach a private target
     * the operator controls AND the page content is trusted — an intranet app
     * under test, or a locally-served fixture page (what the browser runtime
     * smoke does). It relaxes BOTH layers for this spec, so it stays a
     * per-spec reviewed decision and never a global switch. The http/https
     * scheme allowlist is NOT waived.
     */
    allowPrivateTargets: z.boolean().default(false),
  })
  .strict();

const browserSchema = z
  .object({
    name: safeName,
    version: versionField,
    target: z.literal("browser"),
    agent: pooledSingleAgentWithMaxTokensSchema,
    driver: browserDriverSchema.default({}),
    /** Vision-grounding model. Defaults to the agent's primary model. */
    groundingModel: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
    failure_taxonomy: failureTaxonomyBlock,
    budget: budgetBlock,
    limits: limitsBlock,
    hooks: hooksBlock,
    // v0.3.0 — carried but not emit-wired in 0.3.0 (ignored-note comment in
    // the generated bundle; NOT default-on here).
    continuity: continuityBlock,
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
/** Item 1 (G30) — the `expose:` block (MCP-server projection of the bundle). */
export type SpecExposeBlock = z.infer<typeof exposeBlock>;
/** Item 3 (G32) — the `plugins:` list (marketplace plugin names loaded at boot). */
export type SpecPluginsBlock = z.infer<typeof pluginsBlock>;
export type SpecBudgetBlock = z.infer<typeof budgetBlock>;
/** Ops item 37 + Loop contract 0.4 (Batch C, G26) — the cross-cutting
 *  `observability:` block (slo + trace/metrics/cost/alerts/incidents/otel). */
export type SpecObservabilityBlock = z.infer<typeof observabilityBlock>;
/** "Watch me" — the observe-and-learn `watchme:` block, carried on
 *  cli/channel/managed (design/watch-me.md §4.1). */
export type SpecWatchmeBlock = z.infer<typeof watchmeBlock>;
export type SpecSecurityBlock = z.infer<typeof securityBlock>;
export type SpecFeedbackBlock = z.infer<typeof feedbackBlock>;
export type SpecMemoryBlock = z.infer<typeof memoryBlock>;
export type SpecMemoryWikiBlock = z.infer<typeof memoryWikiBlock>;
/** Loop contract 0.4 (Batch E, G22) — the agent-shape RAG (`knowledge:`)
 *  block, carried on cli/channel/managed. */
export type SpecKnowledgeBlock = z.infer<typeof knowledgeBlock>;
/** Loop contract 0.4 (Batch E, G22) — one `knowledge.sources[]` entry
 *  (exactly one of path/glob/url). */
export type SpecKnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
/** The `memory.dream` scheduled-consolidation sub-block (v0.3.0 §6). */
export type SpecMemoryDreamBlock = z.infer<typeof memoryDreamBlock>;
/** The `continuity:` object form (v0.3.0 §2.1). */
export type SpecContinuityObject = z.infer<typeof continuityObject>;
/** The full `continuity:` surface: boolean shorthand or the object form. */
export type SpecContinuityBlock = z.infer<typeof continuityBlock>;
/** The `thredz:` object form (v0.3.0 §4.1). */
export type SpecThredzObject = z.infer<typeof thredzObject>;
/** The full `thredz:` surface: boolean/string shorthand or the object form. */
export type SpecThredzBlock = z.infer<typeof thredzBlock>;
/** The `learning:` block (v0.3.0 §3.3, PR 17). */
export type SpecLearningBlock = z.infer<typeof learningBlock>;
export type SpecFailureTaxonomyEntry = z.infer<typeof failureTaxonomyEntrySchema>;
export type SpecFailureTaxonomy = z.infer<typeof failureTaxonomyBlock>;
/** Loop contract 0.4 (Batch A) — the extended-thinking selector (exactly one
 *  of `budget_tokens` / `effort`). */
export type SpecThinkingBlock = z.infer<typeof thinkingBlock>;
/** Loop contract 0.4 (Batch A) — the base `limits:` block (non-crew shapes). */
export type SpecLimitsBlock = z.infer<typeof limitsBlock>;
/** Loop contract 0.4 (Batch A) — the crew `limits:` block (base + `crew:`). */
export type SpecCrewLimitsBlock = z.infer<typeof crewLimitsBlock>;
/** Loop contract 0.4 (Batch A) — one spec-declared lifecycle hook. */
export type SpecHook = z.infer<typeof hookSchema>;
/** Loop contract 0.4 (Batch A) — the hook-event name union (see
 *  {@link SPEC_HOOK_EVENTS}). */
export type SpecHookEvent = (typeof SPEC_HOOK_EVENTS)[number];
/** Loop contract 0.4 (Batch A) — the per-tool rate-limits map. */
export type SpecRateLimitsBlock = z.infer<typeof rateLimitsBlock>;
/** Loop contract 0.4 (Batch A) — the declarative graph-edge predicate. */
export type SpecGraphEdgeWhen = z.infer<typeof graphEdgeWhenSchema>;
/** Loop contract 0.4 (Batch B, G02) — the `evaluation:` block
 *  (cli/channel/managed in-loop output evaluation). */
export type SpecEvaluationBlock = z.infer<typeof evaluationBlock>;
/** Loop contract 0.4 (Batch B, G02) — the evaluation grader union
 *  (llm_judge | contains | regex). */
export type SpecEvaluationGrader = z.infer<typeof evaluationGraderSchema>;
/** Loop contract 0.4 (Batch B, G02) — the judge gate config shared by
 *  `kind: "judge"` workflow steps and graph nodes. */
export type SpecJudgeGate = z.infer<typeof judgeGateBlock>;
/** Loop contract 0.4 (Batch B, G02) — a `kind: "judge"` workflow step. */
export type SpecWorkflowJudgeStep = z.infer<typeof workflowJudgeStepSchema>;
/** Loop contract 0.4 (Batch B, G02) — one workflow step: a regular agent
 *  step ({@link SpecWorkflowStep}) or a judge gate. */
export type SpecWorkflowAnyStep = z.infer<typeof workflowAnyStepSchema>;
/** Loop contract 0.4 (Batch B, G02) — a `kind: "judge"` graph node. */
export type SpecGraphJudgeNode = z.infer<typeof graphJudgeNodeSchema>;
/** Loop contract 0.4 (Batch B, G02) — one graph node: a regular LLM node
 *  ({@link SpecGraphNode}) or a judge gate. */
export type SpecGraphAnyNode = z.infer<typeof graphAnyNodeSchema>;

export { SpecParseError };

/**
 * Loop contract 0.4 (Batch B, G04) — one structured spec diagnostic.
 * `path` locates the problem in the parsed document (`[]` for
 * whole-document problems such as YAML syntax errors); `code` is a stable
 * machine key — zod's issue codes (`"invalid_type"`, `"unrecognized_keys"`,
 * `"custom"`, …) for schema failures, `"yaml_syntax"` for YAML parse
 * failures (line/column ride in the message), and `"custom"` for the
 * cross-field invariants enforced beyond the schema.
 */
export type SpecIssue = {
  path: (string | number)[];
  message: string;
  code: string;
};

/**
 * Friendly early-rejection for `permissions.mode: bypass` so the error
 * names the actual security policy rather than a Zod enum mismatch. The
 * Zod schema also excludes "bypass" from its enum (defense in depth).
 */
function bypassModeIssue(raw: unknown): SpecIssue | undefined {
  if (typeof raw === "object" && raw !== null && "permissions" in raw) {
    const perms = (raw as { permissions?: unknown }).permissions;
    if (typeof perms === "object" && perms !== null && "mode" in perms) {
      const mode = (perms as { mode?: unknown }).mode;
      if (mode === "bypass") {
        return {
          path: ["permissions", "mode"],
          code: "custom",
          message:
            "permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file",
        };
      }
    }
  }
  return undefined;
}

/**
 * The cross-field invariants `parseSpec` enforces beyond the zod schema,
 * as a structured issue list (empty = all invariants hold). Kept as data
 * checks rather than `.refine()`s so every discriminated-union member
 * stays a plain ZodObject (Zod's discriminatedUnion rejects ZodEffects).
 * `parseSpec` throws the FIRST issue's message (its historical behaviour);
 * `parseSpecIssues` returns them all. Check order is load-bearing for
 * `parseSpec`'s error messages — append, don't reorder.
 */
function crossFieldIssues(data: Spec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const custom = (path: (string | number)[], message: string): void => {
    issues.push({ path, message, code: "custom" });
  };
  // Section 22 — crew cross-field invariants.
  if (data.target === "crew") {
    const roleNames = Object.keys(data.roles);
    if (roleNames.length === 0) {
      custom(["roles"], "crew target requires at least one role");
    }
    if (roleNames.length > 0 && !roleNames.includes(data.entry)) {
      custom(
        ["entry"],
        `crew.entry "${data.entry}" must name one of crew.roles (got: ${roleNames.join(", ")})`,
      );
    }
    // 0.5.0 — the role-keyed thredz fan-out. Both checks are cross-field, so
    // they cannot live in the schema: `thredz.roles` and `roles` are siblings.
    const crewThredz = data.thredz;
    if (typeof crewThredz === "object" && crewThredz !== null && "roles" in crewThredz) {
      const fanOut = (crewThredz as { roles?: Record<string, { api_key?: string }> }).roles;
      const inheritedKey = (crewThredz as { api_key?: string }).api_key;
      if (fanOut !== undefined) {
        for (const name of Object.keys(fanOut)) {
          if (!roleNames.includes(name)) {
            custom(
              ["thredz", "roles", name],
              `thredz.roles["${name}"]: no such role — crew.roles declares ${roleNames.join(", ")}`,
            );
          }
        }
        // Every role must resolve to a key: its own, or the inherited one. A
        // role with neither would silently get NO hosted wiki while its
        // siblings got one, which is the kind of gap you find in production.
        if (inheritedKey === undefined) {
          for (const name of roleNames) {
            if (fanOut[name]?.api_key === undefined) {
              custom(
                ["thredz", "roles", name],
                `role "${name}" has no Thredz api_key and thredz.api_key is not set — give it one, or set a crew-wide thredz.api_key for the roles that share a wiki`,
              );
            }
          }
        }
        // Two role names that slugify to the same MCP server name would make
        // one silently overwrite the other's server entry.
        const slugs = new Map<string, string>();
        for (const name of Object.keys(fanOut)) {
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
          if (slug === "") {
            custom(
              ["thredz", "roles", name],
              `thredz.roles["${name}"]: the role name has no characters usable in an MCP server name — rename the role`,
            );
            continue;
          }
          const clash = slugs.get(slug);
          if (clash !== undefined) {
            custom(
              ["thredz", "roles", name],
              `thredz.roles["${name}"] and thredz.roles["${clash}"] both reduce to the MCP server name "thredz-${slug}" — rename one`,
            );
          }
          slugs.set(slug, name);
        }
      }
    }
    if (data.routing !== undefined && data.routing.kind === "match" && data.routing.match) {
      for (const [from, rules] of Object.entries(data.routing.match)) {
        if (!roleNames.includes(from)) {
          custom(
            ["routing", "match", from],
            `crew.routing.match["${from}"]: source role not in crew.roles`,
          );
        }
        for (const [ri, rule] of rules.entries()) {
          if (!roleNames.includes(rule.to)) {
            custom(
              ["routing", "match", from, ri, "to"],
              `crew.routing.match["${from}"].to = "${rule.to}" — target role not in crew.roles`,
            );
          }
        }
      }
    }
  }
  // Loop contract 0.4 (Batch B, G02) — a judge step gates the PREVIOUS
  // step's output, so the first step can never be one.
  if (data.target === "workflow") {
    const first = data.steps[0];
    if (first !== undefined && "kind" in first && first.kind === "judge") {
      custom(
        ["steps", 0],
        `workflow steps[0] "${first.name}" cannot be a judge step — a judge gates the previous step's output and no step precedes it`,
      );
    }
  }
  // Loop contract 0.4 (Batch A) — graph cross-field invariants:
  //   - every `edges[].when.key` must name a declared node — the generated
  //     graph state records each node's reply under its own name, so a key
  //     that names nothing can never match;
  //   - every `parallel` group member must name a declared node (mirrors
  //     graph-engine's own compile-time check, surfaced at parse time);
  //   - (Batch B) the entry cannot be a judge node — a judge gates its
  //     upstream node's output and the entry has none.
  if (data.target === "graph") {
    const nodeNames = Object.keys(data.nodes);
    for (const [i, edge] of data.edges.entries()) {
      if (edge.when !== undefined && !nodeNames.includes(edge.when.key)) {
        custom(
          ["edges", i, "when", "key"],
          `graph.edges[${i}].when.key "${edge.when.key}" must name a declared node — the shared state records each node's output under its name (nodes: ${nodeNames.join(", ")})`,
        );
      }
    }
    if (data.parallel !== undefined) {
      for (const [gi, group] of data.parallel.entries()) {
        for (const nodeName of group) {
          if (!nodeNames.includes(nodeName)) {
            custom(
              ["parallel", gi],
              `graph.parallel[${gi}] references "${nodeName}" which is not a declared node (nodes: ${nodeNames.join(", ")})`,
            );
          }
        }
      }
    }
    const entryNode = data.nodes[data.entry];
    if (entryNode !== undefined && "kind" in entryNode && entryNode.kind === "judge") {
      custom(
        ["entry"],
        `graph entry "${data.entry}" cannot be a judge node — a judge gates its upstream node's output and the entry has none`,
      );
    }
  }
  // Item 1 (G30) — `expose.mcp.tools: "per-subagent"` projects EACH declared
  // sub-agent as its own MCP tool, so it needs sub-agents to project. cli and
  // channel carry `agent.sub_agents`; the managed shape has none at all, so
  // per-subagent is always a mistake there. Load-bearing: no ir-pass mirrors
  // this, and the emitter would otherwise ship an MCP server exposing only the
  // primary tool while the author expected per-sub-agent ones.
  if (data.target === "cli" || data.target === "channel" || data.target === "managed") {
    const exposeTools = data.expose?.mcp?.tools;
    if (exposeTools === "per-subagent") {
      const subAgents =
        data.target === "managed"
          ? undefined
          : (data.agent as { sub_agents?: Record<string, unknown> }).sub_agents;
      const count = subAgents === undefined ? 0 : Object.keys(subAgents).length;
      if (count === 0) {
        custom(
          ["expose", "mcp", "tools"],
          `expose.mcp.tools: "per-subagent" projects each sub-agent as its own MCP tool, but the ${data.target} shape declares no sub_agents — use tools: "chat" (the default), or add sub_agents`,
        );
      }
    }
  }
  // Section 21 — pipeline HTTP-backend invariants. qdrant/pinecone/weaviate
  // throw at construction without a url + collection, so selecting one
  // without both would emit an unrunnable bundle.
  if (data.target === "pipeline" && HTTP_VECTOR_BACKENDS.has(data.retrieve.vectorBackend)) {
    const { vectorBackend, url, collection } = data.retrieve;
    if (!url) {
      custom(
        ["retrieve", "url"],
        `pipeline retrieve.vectorBackend "${vectorBackend}" requires retrieve.url (the remote service base URL)`,
      );
    }
    if (!collection) {
      custom(
        ["retrieve", "collection"],
        `pipeline retrieve.vectorBackend "${vectorBackend}" requires retrieve.collection`,
      );
    }
  }
  // "Watch me" (design/watch-me.md §4.2) — `watchme.share: true` publishes
  // co-learning articles, so it conflicts with a thredz OBJECT that declares
  // an EXPLICIT `visibility: "private"`. The boolean/string shorthands
  // (default-private) get NO issue in v1 — publishing then lands
  // private-visibility articles, legal single-agent behaviour — and an
  // absent `thredz:` block is fine (publish degrades to the local wiki
  // store, a feature not an error).
  if (data.target === "cli" || data.target === "channel" || data.target === "managed") {
    const thredz = data.thredz;
    if (
      data.watchme?.share === true &&
      typeof thredz === "object" &&
      thredz.visibility === "private"
    ) {
      custom(
        ["watchme", "share"],
        "watchme.share publishes co-learning articles; thredz.visibility: private blocks cross-agent sharing — set visibility: shared or drop watchme.share",
      );
    }
  }
  return issues;
}

export function parseSpec(yamlText: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new SpecParseError("invalid YAML", err);
  }

  const bypass = bypassModeIssue(raw);
  if (bypass !== undefined) {
    throw new SpecParseError(bypass.message);
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
  const issues = crossFieldIssues(result.data);
  const firstIssue = issues[0];
  if (firstIssue !== undefined) {
    throw new SpecParseError(firstIssue.message);
  }
  return result.data;
}

/** yaml's parse errors carry 1-indexed line/column in `linePos`. */
function yamlSyntaxIssue(err: unknown): SpecIssue {
  const linePos = (err as { linePos?: ReadonlyArray<{ line: number; col: number }> }).linePos;
  const pos = Array.isArray(linePos) && linePos[0] !== undefined ? linePos[0] : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  // yaml's message embeds a multi-line code frame; keep the first line and
  // move its trailing position marker into a uniform suffix.
  const firstLine = (raw.split("\n")[0] ?? raw).trim();
  const cleaned =
    pos !== undefined ? firstLine.replace(/ at line \d+, column \d+:?$/, "") : firstLine;
  const where = pos !== undefined ? ` (line ${pos.line}, column ${pos.col})` : "";
  return { path: [], code: "yaml_syntax", message: `invalid YAML: ${cleaned}${where}` };
}

/**
 * Flatten zod issues to `SpecIssue`s. `invalid_union` issues (the workflow
 * step / graph node / continuity / thredz unions) are replaced by the most
 * plausible branch's issues — the branch that failed with the FEWEST
 * problems, ties broken by the fewest unrecognized KEYS (so a step that
 * declares `kind: judge` with a typo inside `judge:` reports the judge
 * branch's problem, not the regular branch's "unrecognized 'kind'") — so a
 * malformed union member reports its actual problem instead of an opaque
 * "Invalid input". Union sub-issues carry document-absolute paths in zod
 * v3, so no re-prefixing is needed.
 */
function unrecognizedKeyCount(err: z.ZodError): number {
  let count = 0;
  for (const issue of err.issues) {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) count += issue.keys.length;
  }
  return count;
}

function zodIssuesToSpecIssues(zodIssues: ReadonlyArray<z.ZodIssue>): SpecIssue[] {
  const out: SpecIssue[] = [];
  for (const issue of zodIssues) {
    if (issue.code === z.ZodIssueCode.invalid_union && issue.unionErrors.length > 0) {
      const best = [...issue.unionErrors].sort(
        (a, b) =>
          a.issues.length - b.issues.length || unrecognizedKeyCount(a) - unrecognizedKeyCount(b),
      )[0];
      if (best !== undefined && best.issues.length > 0) {
        out.push(...zodIssuesToSpecIssues(best.issues));
        continue;
      }
    }
    out.push({ path: [...issue.path], message: issue.message, code: issue.code });
  }
  return out;
}

/**
 * Loop contract 0.4 (Batch B, G04) — the non-throwing sibling of
 * {@link parseSpec}: parse `yamlText` and return EVERY diagnostic as a
 * structured issue list (`[]` when the spec is valid). Built on the same
 * internals as `parseSpec` — which keeps its throw behaviour — so the two
 * can never disagree about validity:
 *
 *   - YAML syntax errors → one issue, `path: []`, `code: "yaml_syntax"`,
 *     line/column in the message.
 *   - schema failures    → one issue per zod issue (zod's own `code`s),
 *     with `invalid_union` flattened to the most plausible branch.
 *   - cross-field checks → `code: "custom"` with a best-effort path.
 */
export function parseSpecIssues(yamlText: string): SpecIssue[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    return [yamlSyntaxIssue(err)];
  }
  const bypass = bypassModeIssue(raw);
  if (bypass !== undefined) return [bypass];
  const result = Spec.safeParse(raw);
  if (!result.success) return zodIssuesToSpecIssues(result.error.issues);
  return crossFieldIssues(result.data);
}

/**
 * Loop contract 0.4 (Batch B, G03) — the whole Spec union as a JSON-Schema
 * document. The document root is a `$ref` to `#/definitions/CrewhausSpec`
 * (the target-discriminated union); every target shape additionally gets
 * its own named definition (`#/definitions/cli`, `#/definitions/workflow`,
 * …) so tooling (editors, the compiler-worker `GET /schema` endpoint, the
 * studio) can link straight to one shape. Zod `.describe()` annotations
 * surface as JSON-Schema `description` keys. Pure function of this module
 * — no I/O, deterministic output.
 */
export function specJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(Spec, {
    name: "CrewhausSpec",
    definitions: {
      cli: cliSchema,
      workflow: workflowSchema,
      channel: channelSchema,
      graph: graphSchema,
      managed: managedSchema,
      pipeline: pipelineSchema,
      crew: crewSchema,
      research: researchSchema,
      batch: batchSchema,
      voice: voiceSchema,
      browser: browserSchema,
      eval: evalSchema,
      onchain: onchainSchema,
      "onchain-game": onchainGameSchema,
    },
  }) as Record<string, unknown>;
}
