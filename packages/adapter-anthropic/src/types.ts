/**
 * Canonical, provider-agnostic shapes used across every adapter.
 *
 * The canonical message/content shapes are deliberately *isomorphic* to
 * the Anthropic SDK's `MessageParam` / `ContentBlockParam` so the existing
 * JSONL transcript on disk stays wire-compatible after the multi-provider
 * refactor. Other adapters translate to/from this shape; runtime-core,
 * event-log, and streaming-tool-executor consume it directly.
 *
 * Why mirror Anthropic specifically: at the time of this refactor the
 * persistence layer (`@crewhaus/event-log`) embeds `MessageParam.content`
 * blocks verbatim in `.jsonl` transcripts. Picking a different canonical
 * shape would force a transcript migration. Any provider whose native
 * shape differs (OpenAI's `messages` array, Gemini's `contents` parts,
 * Bedrock per-family bodies) translates inside its own adapter.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "bedrock";

export type TokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheCreate?: number;
};

export type ProviderFeatures = {
  readonly caching: "explicit" | "automatic" | false;
  readonly tool_use: boolean;
  readonly vision: boolean;
  readonly thinking: boolean;
  readonly web_search: boolean;
};

// ---------- Canonical message / content shapes ---------- //

/**
 * `cache_control` mirrors Anthropic's wire shape: an explicit `null`
 * is allowed and equivalent to "no caching" so existing JSONL
 * transcripts (and Anthropic SDK type usage) continue to satisfy the
 * canonical types.
 */
export type CanonicalCacheControl = { readonly type: "ephemeral" } | null;

export type CanonicalTextBlockParam = {
  readonly type: "text";
  readonly text: string;
  readonly cache_control?: CanonicalCacheControl;
};

export type CanonicalImageSource =
  | { readonly type: "base64"; readonly media_type: string; readonly data: string }
  | { readonly type: "url"; readonly url: string };

export type CanonicalImageBlockParam = {
  readonly type: "image";
  readonly source: CanonicalImageSource;
  readonly cache_control?: CanonicalCacheControl;
};

export type CanonicalToolUseBlockParam = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly cache_control?: CanonicalCacheControl;
};

export type CanonicalToolResultContent =
  | string
  | ReadonlyArray<CanonicalTextBlockParam | CanonicalImageBlockParam>;

export type CanonicalToolResultBlockParam = {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content?: CanonicalToolResultContent;
  readonly is_error?: boolean;
  readonly cache_control?: CanonicalCacheControl;
};

export type CanonicalThinkingBlockParam = {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string;
};

export type CanonicalContentBlockParam =
  | CanonicalTextBlockParam
  | CanonicalImageBlockParam
  | CanonicalToolUseBlockParam
  | CanonicalToolResultBlockParam
  | CanonicalThinkingBlockParam;

export type CanonicalMessage = {
  readonly role: "user" | "assistant";
  readonly content: string | ReadonlyArray<CanonicalContentBlockParam>;
};

export type CanonicalTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

// ---------- Stream events (content-block-keyed canonical form) ---------- //

export type CanonicalContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature?: string };

export type CanonicalContentDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string };

/**
 * Provider-agnostic stream event. Mirrors Anthropic's `RawMessageStreamEvent`
 * with field renames for clarity (`content_block` → `block`). Each adapter
 * MUST yield events of this shape regardless of how its native stream looks.
 */
export type StreamEvent =
  | { readonly kind: "message_start"; readonly usage?: TokenUsage }
  | {
      readonly kind: "content_block_start";
      readonly index: number;
      readonly block: CanonicalContentBlock;
    }
  | {
      readonly kind: "content_block_delta";
      readonly index: number;
      readonly delta: CanonicalContentDelta;
    }
  | { readonly kind: "content_block_stop"; readonly index: number }
  | {
      readonly kind: "message_delta";
      readonly stopReason?: string;
      readonly usage?: TokenUsage;
    }
  | { readonly kind: "message_stop" }
  | { readonly kind: "error"; readonly error: { readonly type: string; readonly message: string } };

// ---------- Request + final-message shapes ---------- //

export type ToolChoice =
  | { readonly type: "auto" }
  | { readonly type: "any" }
  | { readonly type: "tool"; readonly name: string };

/**
 * Loop contract 0.4 (Batch A) — portable reasoning-effort preset. The
 * spec's `thinking: { effort }` form lowers to this; adapters convert it
 * to their provider's native reasoning control (see
 * {@link EFFORT_THINKING_BUDGET_TOKENS}).
 */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Loop contract 0.4 (Batch A) — the effort→thinking-budget preset table for
 * providers whose reasoning control is a TOKEN BUDGET rather than a named
 * effort level:
 *
 *   - **anthropic** — `thinking.budget_tokens` (this adapter's translate
 *     maps `reasoningEffort` through this table when `thinking` is not
 *     explicitly set).
 *   - **bedrock** (Anthropic families) — the same `budget_tokens` field on
 *     the InvokeModel body; adapter-bedrock converts through this table.
 *   - **gemini** — `thinkingConfig.thinkingBudget` (a token count);
 *     adapter-gemini converts through this table.
 *
 * Providers with a NATIVE effort string (OpenAI's `reasoning_effort`) pass
 * the preset through verbatim and ignore this table. The numbers step
 * roughly 4x per level: `low` (2048) covers quick sanity reasoning above
 * the 1024 provider floor, `medium` (8192) is the balanced default, `high`
 * (24576) approaches the ceiling recommended for hard multi-step work.
 * An EXPLICIT `thinking.budget_tokens` in the spec always wins over the
 * preset — the table is only consulted when the spec chose the effort form.
 */
export const EFFORT_THINKING_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  low: 2048,
  medium: 8192,
  high: 24576,
};

export type ProviderRequest = {
  readonly model: string;
  /**
   * System message as an ordered text-block array. Adapters that take a
   * single string collapse with `\n\n`. Cache markers preserved per block;
   * adapters whose `features.caching !== "explicit"` ignore them.
   */
  readonly system: ReadonlyArray<CanonicalTextBlockParam>;
  readonly messages: ReadonlyArray<CanonicalMessage>;
  readonly tools?: ReadonlyArray<CanonicalTool>;
  readonly toolChoice?: ToolChoice;
  readonly maxTokens: number;
  readonly thinking?: { readonly type: "enabled"; readonly budgetTokens: number };
  /**
   * Loop contract 0.4 (Batch A) — portable effort preset, set when the spec
   * declared `thinking: { effort }`. Ignored when `thinking` is also set
   * (an explicit budget always wins). Adapters without a native effort
   * control convert it via {@link EFFORT_THINKING_BUDGET_TOKENS}.
   */
  readonly reasoningEffort?: ReasoningEffort;
  /**
   * Evals hardening NEW-HUNT-2 — sampling temperature. Additive SPI field:
   * adapters with a native control map it, others ignore it (capability-
   * dependent, like `thinking`). `eval-judge` pins `0` here so judge
   * verdicts are as deterministic as the provider allows. Adapters must
   * drop it when extended thinking is enabled — Anthropic requires the
   * default temperature alongside `thinking`.
   */
  readonly temperature?: number;
  readonly signal?: AbortSignal;
};

export type CanonicalToolWithOptionalDescription = Omit<CanonicalTool, "description"> & {
  readonly description?: string;
};

/**
 * The final accumulated message after a stream finishes — what
 * `collectFinalMessage()` returns and what `compaction-autocompact` /
 * `eval-judge` consume in place of their previous `messages.create()` calls.
 */
export type ProviderMessage = {
  readonly content: ReadonlyArray<CanonicalContentBlock>;
  readonly stopReason: string;
  readonly usage: TokenUsage;
};

// ---------- Effective-parameter echo (0.6.0 §8.1) ---------- //

/**
 * A request parameter the adapter accepted on the `ProviderRequest` but did
 * NOT send to the provider — the silent drops every marshaller performs
 * (Claude 5 rejects `temperature`; OpenAI reasoning models reject it too;
 * Bedrock Converse has no cross-vendor thinking control). Surfaced so the
 * drop is visible on `model_request.effectiveParams` and in `models audit`
 * instead of disappearing inside the adapter.
 */
export type DroppedRequestParam = "temperature" | "thinking" | "reasoningEffort";

/**
 * 0.6.0 §8.1 — what the adapter will actually send for a request: the
 * projection of its own pure marshaller onto the params a route decision can
 * differ on. `dropped` lists every `ProviderRequest` param the marshaller
 * accepted but omitted from the wire body; `notes` explains conversions that
 * are NOT drops (an effort preset lowered to a token budget, a budget mapped
 * to the nearest effort bucket), so a consumer can tell "honoured
 * differently" from "ignored".
 *
 * `thinking` / `reasoningEffort` / `temperature` are present only when the
 * marshaller sends that native control. A budget-style provider that
 * converts `reasoningEffort` therefore reports `thinking` and no
 * `reasoningEffort`; a native-effort provider reports the inverse.
 */
export type EffectiveParams = {
  readonly model: string;
  readonly maxTokens: number;
  readonly thinking?: { readonly type: "enabled"; readonly budgetTokens: number };
  readonly reasoningEffort?: ReasoningEffort;
  readonly temperature?: number;
  readonly dropped: ReadonlyArray<DroppedRequestParam>;
  readonly notes?: ReadonlyArray<string>;
};

// ---------- The interface every adapter implements ---------- //

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly features: ProviderFeatures;
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number;
  /**
   * 0.6.0 §8.1 — OPTIONAL: predict the parameters `stream(req)` will put on
   * the wire, by projecting the adapter's own pure marshaller (never by
   * re-deriving the gate elsewhere — `usesMaxCompletionTokens` is private to
   * adapter-openai for exactly this reason). Pure and network-free; safe to
   * call offline (`models audit`) and before `model_request` is published.
   *
   * Wrappers forward it: the circuit breaker delegates to the wrapped
   * adapter and a `FailoverChain` predicts against the candidate `plan()`
   * names. Returns `undefined` when the serving adapter cannot project
   * (a wrapper around an adapter that lacks the method) — consumers set the
   * echoed field only when a value comes back. Absent on adapters that do
   * not implement it; every in-tree adapter does.
   */
  effectiveParams?(req: ProviderRequest): EffectiveParams | undefined;
}
