/**
 * `@crewhaus/adapter-anthropic` — Anthropic provider adapter and shared
 * `ProviderAdapter` interface (Section 17).
 *
 * Public surface:
 * - The `ProviderAdapter` contract every adapter implements.
 * - `AnthropicAdapter` + `createAnthropicAdapter()` factory.
 * - `resolveAuth` / `createAnthropicClient` re-exported for compat with
 *   the runtime-core API the rest of the workspace depended on before
 *   this refactor.
 * - `collectFinalMessage` / `consumeStream` / `extractFirstText` /
 *   `extractToolUse` helpers — used by `compaction-autocompact` and
 *   `eval-judge` to replace their `messages.create()` calls, and by
 *   runtime-core to drive its stream consumer in a single pass.
 */

export type {
  CanonicalCacheControl,
  CanonicalContentBlock,
  CanonicalContentBlockParam,
  CanonicalContentDelta,
  CanonicalImageBlockParam,
  CanonicalImageSource,
  CanonicalMessage,
  CanonicalTextBlockParam,
  CanonicalThinkingBlockParam,
  CanonicalTool,
  CanonicalToolResultBlockParam,
  CanonicalToolResultContent,
  CanonicalToolUseBlockParam,
  DroppedRequestParam,
  EffectiveParams,
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  ReasoningEffort,
  StreamEvent,
  TokenUsage,
  ToolChoice,
} from "./types.js";

// Loop contract 0.4 (Batch A) — the effort→thinking-budget preset table
// shared by the budget-token providers (anthropic/gemini/bedrock).
export { EFFORT_THINKING_BUDGET_TOKENS } from "./types.js";

export { AnthropicAdapter, createAnthropicAdapter } from "./adapter.js";
export { createAnthropicVertexAdapter } from "./vertex.js";
export type { AnthropicAdapterOptions } from "./adapter.js";

export { resolveAuth } from "./auth.js";
export type { ResolvedAuth } from "./auth.js";

export {
  CLAUDE_CODE_HEADERS,
  CLAUDE_CODE_SYSTEM_PREFIX,
  OAUTH_BETAS,
  createAnthropicClient,
} from "./client.js";

/**
 * Re-exports of `@anthropic-ai/sdk` so workspace consumers can import
 * the Anthropic class, error types, and message types from a single
 * canonical instance. Without this, packages with their own direct dep
 * on `@anthropic-ai/sdk` install a second copy of the SDK, and runtime
 * `instanceof` checks against error classes fall through (because each
 * copy defines its own classes). Always import from this package, not
 * from `@anthropic-ai/sdk` directly.
 */
export { default as Anthropic } from "@anthropic-ai/sdk";
export {
  AnthropicError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
export type {
  Message,
  MessageParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";

export {
  collectFinalMessage,
  consumeStream,
  extractFirstText,
  extractToolUse,
} from "./helpers.js";
export type { ConsumeStreamCallbacks } from "./helpers.js";

export {
  anthropicEffectiveParams,
  claudeRejectsTemperature,
  rawEventToCanonical,
  toAnthropicMessages,
  toAnthropicParams,
  toAnthropicSystem,
} from "./translate.js";
