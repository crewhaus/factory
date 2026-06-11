/**
 * Canonical ↔ OpenAI Chat Completions translation.
 *
 * The canonical shape mirrors Anthropic's; OpenAI is structurally
 * different in several ways:
 *
 * - System message: OpenAI takes a leading `system` (or `developer` for
 *   o-series) message in the `messages` array, not a separate field.
 *   We collapse the canonical `system` array (joined by `\n\n`) into a
 *   single leading system message.
 * - Tool calls: OpenAI splits assistant `tool_calls` (out) and `tool`
 *   role messages with `tool_call_id` (in) — the canonical shape uses
 *   inline `tool_use` and `tool_result` blocks. We unfold those.
 * - Tool inputs: OpenAI delivers `arguments` as a string (JSON-encoded);
 *   the SDK accumulates incremental deltas during streaming.
 * - Cache markers: OpenAI auto-caches at the API layer — we silently
 *   drop `cache_control` markers (surfaced via `features.caching =
 *   "automatic"`).
 * - Token cap: reasoning models (o-series, gpt-5 family) reject
 *   `max_tokens` with a 400 and require `max_completion_tokens`;
 *   OpenAI-compatible servers (Ollama, vLLM, llama.cpp, …) only
 *   understand `max_tokens`. We branch on the model id.
 * - Tool-result images: OpenAI `tool` role messages accept only
 *   strings, so images inside `tool_result` blocks are re-emitted as a
 *   follow-up `user` message (each image preceded by a text part naming
 *   the originating tool call) so vision models still see them.
 */

import type {
  CanonicalImageBlockParam,
  CanonicalMessage,
  CanonicalTextBlockParam,
  CanonicalTool,
  CanonicalToolResultContent,
  ProviderRequest,
  ToolChoice,
} from "@crewhaus/adapter-anthropic";
import type OpenAI from "openai";

type ChatRole = "system" | "user" | "assistant" | "tool";

export type OpenAIChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Build the OpenAI Chat Completions request payload from a canonical
 * `ProviderRequest`.
 */
export function toOpenAIChatParams(
  req: ProviderRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const messages: OpenAIChatMessage[] = [];

  // System message — collapse canonical system array into one block.
  const systemText = collapseSystem(req.system);
  if (systemText.length > 0) {
    messages.push({ role: "system", content: systemText });
  }

  for (const m of req.messages) {
    pushCanonicalMessage(messages, m);
  }

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: req.model,
    messages,
    // Reasoning models 400 on `max_tokens`; compat servers only
    // understand `max_tokens`. Branch on the model id.
    ...(usesMaxCompletionTokens(req.model)
      ? { max_completion_tokens: req.maxTokens }
      : { max_tokens: req.maxTokens }),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (req.tools !== undefined && req.tools.length > 0) {
    params.tools = req.tools.map(toOpenAITool);
  }
  if (req.toolChoice !== undefined) {
    params.tool_choice = toOpenAIToolChoice(req.toolChoice);
  }

  return params;
}

/**
 * OpenAI's reasoning models (o1/o3/o4-mini, gpt-5 family) reject
 * `max_tokens` with a 400 and require `max_completion_tokens` instead.
 * Everything else — including the long tail of OpenAI-compatible
 * servers routed through this adapter via baseURL — keeps `max_tokens`.
 */
function usesMaxCompletionTokens(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

function collapseSystem(system: ReadonlyArray<CanonicalTextBlockParam>): string {
  return system
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
}

function toOpenAITool(t: CanonicalTool): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  };
}

function toOpenAIToolChoice(
  choice: ToolChoice,
): OpenAI.Chat.Completions.ChatCompletionToolChoiceOption {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

function pushCanonicalMessage(messages: OpenAIChatMessage[], m: CanonicalMessage): void {
  if (m.role === "user") {
    pushUserMessage(messages, m.content);
    return;
  }
  // role === "assistant"
  pushAssistantMessage(messages, m.content);
}

function pushUserMessage(
  messages: OpenAIChatMessage[],
  content: CanonicalMessage["content"],
): void {
  if (typeof content === "string") {
    messages.push({ role: "user", content });
    return;
  }

  // Walk blocks: text/image → user message parts; tool_result → split
  // into a separate `tool` role message per result (OpenAI's shape).
  // Images inside tool_results can't ride on the `tool` message (OpenAI
  // only accepts strings there), so they're queued as follow-up user
  // parts — emitted after the contiguous run of tool messages so tool
  // responses stay adjacent to their assistant tool_calls message.
  const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const imageFollowUps: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      userParts.push(...imageFollowUps.splice(0));
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      userParts.push(...imageFollowUps.splice(0));
      userParts.push(toImageUrlPart(block));
    } else if (block.type === "tool_result") {
      // Flush accumulated user parts before emitting the tool message
      // so order is preserved.
      if (userParts.length > 0) {
        messages.push({ role: "user", content: [...userParts] });
        userParts.length = 0;
      }
      messages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: stringifyToolResultContent(block.content),
      });
      // Queue any images from this result, each labelled with the tool
      // call it came from so the model can correlate.
      if (typeof block.content !== "string" && block.content !== undefined) {
        for (const part of block.content) {
          if (part.type === "image") {
            imageFollowUps.push({
              type: "text",
              text: `[Image output of tool call ${block.tool_use_id}]`,
            });
            imageFollowUps.push(toImageUrlPart(part));
          }
        }
      }
    }
  }
  userParts.push(...imageFollowUps.splice(0));
  if (userParts.length > 0) {
    messages.push({ role: "user", content: userParts });
  }
}

function toImageUrlPart(
  block: CanonicalImageBlockParam,
): OpenAI.Chat.Completions.ChatCompletionContentPartImage {
  const url =
    block.source.type === "base64"
      ? `data:${block.source.media_type};base64,${block.source.data}`
      : block.source.url;
  return { type: "image_url", image_url: { url } };
}

function pushAssistantMessage(
  messages: OpenAIChatMessage[],
  content: CanonicalMessage["content"],
): void {
  if (typeof content === "string") {
    messages.push({ role: "assistant", content });
    return;
  }

  let text = "";
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const block of content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // image/thinking on assistant turns are dropped — OpenAI Chat
    // doesn't accept them as input. Translation is best-effort.
  }

  const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: "assistant",
    ...(text.length > 0 ? { content: text } : { content: null }),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  messages.push(assistantMsg);
}

function stringifyToolResultContent(content: CanonicalToolResultContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  // Array of text/image blocks: text concatenated. Images can't appear
  // here (Chat tool messages don't accept image parts) — they're
  // re-emitted as a follow-up user message by `pushUserMessage`.
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
