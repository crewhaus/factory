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

// ---------- The interface every adapter implements ---------- //

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly features: ProviderFeatures;
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
  estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number;
}
