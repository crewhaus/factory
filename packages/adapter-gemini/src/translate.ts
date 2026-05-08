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
 */

import type {
  CanonicalMessage,
  CanonicalTextBlockParam,
  CanonicalTool,
  CanonicalToolResultContent,
  ProviderRequest,
  ToolChoice,
} from "@crewhaus/adapter-anthropic";
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

  const systemText = collapseSystem(req.system);
  if (systemText.length > 0) {
    config.systemInstruction = systemText;
  }

  if (req.tools !== undefined && req.tools.length > 0) {
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
  }

  if (req.signal !== undefined) {
    config.abortSignal = req.signal;
  }

  return {
    model: req.model,
    contents: req.messages.map(toGeminiContent),
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
    parameters: t.input_schema as NonNullable<
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

function toGeminiContent(m: CanonicalMessage): Content {
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
          name: block.tool_use_id, // Gemini uses name as the correlator
          response: stringifyToolResultToObj(block.content),
        },
      });
    } else if (block.type === "thinking") {
      parts.push({ text: block.thinking, thought: true });
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
