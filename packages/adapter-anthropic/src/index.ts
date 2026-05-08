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
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
  ToolChoice,
} from "./types.js";

export { AnthropicAdapter, createAnthropicAdapter } from "./adapter.js";
export type { AnthropicAdapterOptions } from "./adapter.js";

export { resolveAuth } from "./auth.js";
export type { ResolvedAuth } from "./auth.js";

export {
  CLAUDE_CODE_HEADERS,
  CLAUDE_CODE_SYSTEM_PREFIX,
  OAUTH_BETAS,
  createAnthropicClient,
} from "./client.js";

export {
  collectFinalMessage,
  consumeStream,
  extractFirstText,
  extractToolUse,
} from "./helpers.js";
export type { ConsumeStreamCallbacks } from "./helpers.js";

export {
  rawEventToCanonical,
  toAnthropicMessages,
  toAnthropicParams,
  toAnthropicSystem,
} from "./translate.js";
