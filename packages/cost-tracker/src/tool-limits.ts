/**
 * The most tools one request may carry, per model route.
 *
 * A provider refuses a request whose tool list is longer than its API
 * accepts, and it refuses every request of the run the same way: OpenAI's
 * chat-completions API (and Azure OpenAI and Groq, which serve the same API)
 * take at most 128 tools, the Gemini API at most 512 function declarations.
 * The category grammar makes it one line to cross that — `tools: [all-code]`
 * is more than 128 tools on its own — so the compiler and the runtime check
 * the count against this table instead of letting the provider answer every
 * call with a 400.
 *
 * Keyed on the ROUTE (the spec model string's prefix), not on the provider
 * id: `local/`, `azure/`, `groq/` and the other OpenAI-compatible hosts all
 * reach the "openai" adapter, but only some of them enforce the cap. Routes
 * with no row are not checked: Anthropic (direct, Vertex, Bedrock), Bedrock's
 * other families, `local/` servers (Ollama, vLLM and LM Studio have no such
 * cap), and the OpenAI-compatible hosts whose limits vary or are not
 * published (together, fireworks, openrouter, deepseek, xai, mistral,
 * cerebras). A route that gains a published cap gets a row here.
 *
 * Pure data and a pure lookup, so the offline compiler and the runtime read
 * the same numbers.
 */

/** A route's per-request tool limit, and who enforces it (for messages). */
export type ProviderToolLimit = {
  /** The most tools one request may carry. */
  readonly maxTools: number;
  /** Who refuses a longer list: "OpenAI", "Azure OpenAI", "Groq", "Gemini". */
  readonly enforcedBy: string;
};

const OPENAI_CHAT_TOOLS = 128;
const GEMINI_FUNCTION_DECLARATIONS = 512;

/** Route prefix → limit. The longest matching prefix wins. */
export const PROVIDER_TOOL_LIMITS: Readonly<Record<string, ProviderToolLimit>> = Object.freeze({
  "openai/": { maxTools: OPENAI_CHAT_TOOLS, enforcedBy: "OpenAI" },
  "azure/": { maxTools: OPENAI_CHAT_TOOLS, enforcedBy: "Azure OpenAI" },
  "groq/": { maxTools: OPENAI_CHAT_TOOLS, enforcedBy: "Groq" },
  "gemini/": { maxTools: GEMINI_FUNCTION_DECLARATIONS, enforcedBy: "Gemini" },
  "vertex/gemini-": { maxTools: GEMINI_FUNCTION_DECLARATIONS, enforcedBy: "Gemini on Vertex AI" },
  "vertex/gemma-": { maxTools: GEMINI_FUNCTION_DECLARATIONS, enforcedBy: "Gemini on Vertex AI" },
});

const PREFIXES = Object.keys(PROVIDER_TOOL_LIMITS).sort((a, b) => b.length - a.length);

/**
 * The per-request tool limit of the route `modelString` names, or
 * `undefined` when the route has no known limit (see the module comment).
 */
export function providerToolLimit(modelString: string): ProviderToolLimit | undefined {
  const prefix = PREFIXES.find((p) => modelString.startsWith(p));
  return prefix === undefined ? undefined : PROVIDER_TOOL_LIMITS[prefix];
}

/** One model's verdict: the tools it would be sent, against its route's limit. */
export type ToolLimitOverrun = {
  readonly model: string;
  readonly toolCount: number;
  readonly limit: ProviderToolLimit;
};

/**
 * The overrun when `toolCount` tools exceed `model`'s route limit, else
 * `undefined` (within the limit, or a route with no known limit).
 */
export function toolLimitOverrun(model: string, toolCount: number): ToolLimitOverrun | undefined {
  const limit = providerToolLimit(model);
  if (limit === undefined || toolCount <= limit.maxTools) return undefined;
  return { model, toolCount, limit };
}

/**
 * The words every surface uses for an overrun, so compile, lint and the
 * runtime say the same thing. `what` names the count's source ("tools:" at
 * compile time, "the run's tools" at boot).
 */
export function describeToolLimitOverrun(o: ToolLimitOverrun, what: string): string {
  return `${o.toolCount} tools (${what}) exceed the ${o.limit.maxTools}-tool limit ${o.limit.enforcedBy} puts on one request, so every call to model "${o.model}" is refused`;
}
