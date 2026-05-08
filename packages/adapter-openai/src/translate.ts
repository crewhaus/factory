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
 */

import type {
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
    max_tokens: req.maxTokens,
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
  const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      userParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const url =
        block.source.type === "base64"
          ? `data:${block.source.media_type};base64,${block.source.data}`
          : block.source.url;
      userParts.push({ type: "image_url", image_url: { url } });
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
    }
  }
  if (userParts.length > 0) {
    messages.push({ role: "user", content: userParts });
  }
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
  // Array of text/image blocks: text concatenated; images dropped (Chat
  // tool messages don't accept image parts).
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
