/**
 * Canonical ↔ Google Gemini translation.
 *
 * Gemini's shape diverges from Anthropic's in three ways:
 *
 * - **Roles**: Gemini uses `"user"` and `"model"` (not `"assistant"`).
 *   Tool results are encoded as user-role parts with `functionResponse`.
 *   System prompt lives in `config.systemInstruction`, not in
 *   `contents`.
 *
 * - **Tool calls**: Each canonical `tool_use` block becomes a model-role
 *   `Part` with a `functionCall: { name, args }`. The full `args`
 *   object arrives in one part — no incremental streaming of args
 *   (unlike OpenAI). We surface this in the stream translation as a
 *   single `input_json_delta` carrying the JSON-stringified args.
 *
 * - **Tools**: Gemini takes `tools: [{ functionDeclarations: [...] }]`
 *   where each declaration has `name`, `description`, `parameters`.
 *   `toolConfig.functionCallingConfig.mode = "ANY"` with
 *   `allowedFunctionNames` is the analogue of Anthropic's
 *   `tool_choice: { type: "tool", name }`.
 *
 * Two more wrinkles handled here:
 *
 * - **Thought signatures**: canonical thinking blocks round-trip as
 *   `{ text, thought: true, thoughtSignature }` parts — newer Gemini
 *   models require the opaque signature echoed back on
 *   function-calling turns.
 *
 * - **Gemma**: Gemma models on the Gemini API reject
 *   `systemInstruction` (400 "Developer instruction is not enabled")
 *   and `functionDeclarations`. For `gemma-*` model ids the collapsed
 *   system text is inlined as a leading `[System]`-prefixed user turn,
 *   and a non-empty `req.tools` raises a `ConfigError`.
 */

import {
  type CanonicalMessage,
  type CanonicalTextBlockParam,
  type CanonicalTool,
  type CanonicalToolResultContent,
  EFFORT_THINKING_BUDGET_TOKENS,
  type ProviderRequest,
  type ToolChoice,
} from "@crewhaus/adapter-anthropic";
import { ConfigError } from "@crewhaus/errors";
import { sanitizeGeminiSchema } from "@crewhaus/tool-schema-sanitizer";
import {
  type Content,
  FunctionCallingConfigMode,
  type Tool as GeminiTool,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Part,
} from "@google/genai";

export function toGeminiParams(req: ProviderRequest): GenerateContentParameters {
  const config: GenerateContentConfig = {
    maxOutputTokens: req.maxTokens,
  };

  // Gemma models reject systemInstruction and functionDeclarations on
  // the Gemini API — see the module header.
  const isGemma = req.model.startsWith("gemma-");

  const systemText = collapseSystem(req.system);
  if (systemText.length > 0 && !isGemma) {
    config.systemInstruction = systemText;
  }

  if (req.tools !== undefined && req.tools.length > 0) {
    if (isGemma) {
      throw new ConfigError(
        `Gemma models do not support function calling on the Gemini API — remove tools or use a gemini-* model (got "${req.model}")`,
      );
    }
    config.tools = [{ functionDeclarations: req.tools.map(toGeminiFunctionDecl) }];
  }
  if (req.toolChoice !== undefined) {
    config.toolConfig = toGeminiToolConfig(req.toolChoice);
  }

  if (req.thinking !== undefined) {
    config.thinkingConfig = {
      thinkingBudget: req.thinking.budgetTokens,
      includeThoughts: true,
    };
  } else if (req.reasoningEffort !== undefined) {
    // Loop contract 0.4 (Batch A) — the portable effort preset converts
    // to Gemini's token-budget control via the shared preset table. Only
    // consulted when `thinking` is not explicitly set: an explicit
    // budget always wins over the preset.
    config.thinkingConfig = {
      thinkingBudget: EFFORT_THINKING_BUDGET_TOKENS[req.reasoningEffort],
      includeThoughts: true,
    };
  }

  // NEW-HUNT-2 — map the sampling temperature (the judge pin) onto
  // Gemini's native generation-config control.
  if (req.temperature !== undefined) {
    config.temperature = req.temperature;
  }

  if (req.signal !== undefined) {
    config.abortSignal = req.signal;
  }

  const toolNameById = collectToolUseNames(req.messages);
  const contents = req.messages.map((m) => toGeminiContent(m, toolNameById));
  if (isGemma && systemText.length > 0) {
    // No systemInstruction slot on Gemma — inline the system text as a
    // leading user turn instead.
    contents.unshift({ role: "user", parts: [{ text: `[System]\n${systemText}` }] });
  }

  return {
    model: req.model,
    contents,
    config,
  };
}

function collapseSystem(system: ReadonlyArray<CanonicalTextBlockParam>): string {
  return system
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function toGeminiFunctionDecl(
  t: CanonicalTool,
): NonNullable<GeminiTool["functionDeclarations"]>[number] {
  return {
    name: t.name,
    description: t.description,
    // Project the tool schema onto Gemini's OpenAPI-3.0 Schema subset —
    // inline $refs, drop keywords Gemini rejects (additionalProperties,
    // unsupported formats, …), flatten unions. An unsanitised MCP schema
    // with `$ref`/`$defs` reaches the API as an unknown node and 400s.
    parameters: sanitizeGeminiSchema(t.input_schema) as NonNullable<
      GeminiTool["functionDeclarations"]
    >[number]["parameters"],
  };
}

function toGeminiToolConfig(choice: ToolChoice): GenerateContentConfig["toolConfig"] {
  switch (choice.type) {
    case "auto":
      return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
    case "any":
      return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
    case "tool":
      return {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: [choice.name],
        },
      };
  }
}

/**
 * Index canonical `tool_use` ids → declared function names across the
 * assistant turns of a conversation. Gemini's contract is that
 * `functionResponse.name` matches `FunctionCall.name` (the declared
 * function name), but the canonical `tool_result.tool_use_id` carries
 * our synthetic correlator (`gemini_<fn>_<idx>` from stream.ts) — this
 * map lets `toGeminiContent` resolve the real name.
 */
function collectToolUseNames(messages: ReadonlyArray<CanonicalMessage>): Map<string, string> {
  const byId = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use") byId.set(block.id, block.name);
    }
  }
  return byId;
}

const SYNTHETIC_TOOL_USE_ID = /^gemini_(.+)_\d+$/;

/**
 * Fallback for tool_use ids whose originating `tool_use` block is no
 * longer in the message window (e.g. after compaction): recover the
 * function name by stripping the synthetic `gemini_<name>_<idx>` shape.
 * Non-synthetic ids pass through unchanged.
 */
function stripSyntheticToolUseId(id: string): string {
  const match = SYNTHETIC_TOOL_USE_ID.exec(id);
  return match?.[1] ?? id;
}

function toGeminiContent(m: CanonicalMessage, toolNameById: ReadonlyMap<string, string>): Content {
  const role = m.role === "assistant" ? "model" : "user";
  if (typeof m.content === "string") {
    return { role, parts: [{ text: m.content }] };
  }
  const parts: Part[] = [];
  for (const block of m.content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    } else if (block.type === "image") {
      if (block.source.type === "base64") {
        parts.push({
          inlineData: { mimeType: block.source.media_type, data: block.source.data },
        });
      } else {
        // URL form: not directly supported as a Part on most Gemini
        // models. Fall back to a text reference.
        parts.push({ text: `[image: ${block.source.url}]` });
      }
    } else if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: block.name,
          args: (block.input as Record<string, unknown> | undefined) ?? {},
        },
      });
    } else if (block.type === "tool_result") {
      parts.push({
        functionResponse: {
          // Gemini's contract: `name` must be the declared function
          // name, not our synthetic correlator id — that travels in
          // `id` instead.
          name: toolNameById.get(block.tool_use_id) ?? stripSyntheticToolUseId(block.tool_use_id),
          id: block.tool_use_id,
          response: stringifyToolResultToObj(block.content),
        },
      });
    } else if (block.type === "thinking") {
      parts.push({
        text: block.thinking,
        thought: true,
        ...(block.signature !== undefined ? { thoughtSignature: block.signature } : {}),
      });
    }
  }
  return { role, parts };
}

function stringifyToolResultToObj(
  content: CanonicalToolResultContent | undefined,
): Record<string, unknown> {
  if (content === undefined) return { result: "" };
  if (typeof content === "string") return { result: content };
  const text = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { result: text };
}
