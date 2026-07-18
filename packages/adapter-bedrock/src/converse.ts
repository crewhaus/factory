/**
 * Converse-on-Bedrock marshalling — the single canonical→Converse
 * request builder and ConverseStream→canonical event decoder shared by
 * every non-anthropic family (llama, mistral, nova, deepseek, cohere,
 * ai21, qwen, gpt-oss, titan, writer).
 *
 * Converse is Bedrock's model-agnostic chat API: one request shape and
 * one stream vocabulary regardless of vendor, with first-class tool use
 * and reasoning support. Anthropic-on-Bedrock deliberately stays on the
 * native InvokeModelWithResponseStream path (families/anthropic.ts)
 * because Converse cannot express explicit cache_control markers or the
 * thinking budget — every other family routes through here.
 *
 * Canonical blocks with no Converse counterpart degrade gracefully
 * rather than throw: URL-sourced images (Converse only takes bytes),
 * images with media types outside Converse's gif/jpeg/png/webp set, and
 * request-side thinking blocks (providers on Converse don't require
 * reasoning passback) are dropped. The reasoning controls
 * (`req.thinking` / `req.reasoningEffort`) are likewise ignored —
 * Converse has no cross-vendor field for a thinking budget or effort
 * preset (the Anthropic family honours both on its native path).
 */

import type {
  ContentBlock,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  ToolChoice as ConverseToolChoice,
  ImageBlock,
  ImageFormat,
  Message,
  SystemContentBlock,
  Tool,
  ToolConfiguration,
  ToolResultBlock,
  ToolResultContentBlock,
  ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  CanonicalImageBlockParam,
  CanonicalMessage,
  CanonicalToolResultBlockParam,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
  ToolChoice,
} from "@crewhaus/adapter-anthropic";
import { sanitizeBedrockSchema } from "@crewhaus/tool-schema-sanitizer";

/** The Smithy JSON-document type, recovered without a @smithy/types dep. */
type ConverseDocument = NonNullable<ToolUseBlock["input"]>;

// ---------- canonical → Converse request ---------- //

/**
 * Build a complete `ConverseStreamCommand` input from a canonical
 * request. `toolConfig` is only attached when the request carries at
 * least one tool — Converse rejects an empty/toolless toolConfig.
 */
export function buildConverseRequest(req: ProviderRequest): ConverseStreamCommandInput {
  // Mutable scratch object — we attach optional fields conditionally.
  const input: {
    modelId: string;
    messages: Message[];
    inferenceConfig: { maxTokens: number };
    system?: SystemContentBlock[];
    toolConfig?: ToolConfiguration;
  } = {
    modelId: req.model,
    messages: req.messages.map(toConverseMessage),
    inferenceConfig: { maxTokens: req.maxTokens },
  };

  const system = req.system
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .map((text) => ({ text }));
  if (system.length > 0) input.system = system;

  if (req.tools !== undefined && req.tools.length > 0) {
    const tools: Tool[] = req.tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        // Inline $refs and strip the structural metadata Converse models
        // reject (additionalProperties, $schema/$id, …) before handing
        // the schema to the model-agnostic tool spec.
        inputSchema: { json: sanitizeBedrockSchema(t.input_schema) as ConverseDocument },
      },
    }));
    input.toolConfig =
      req.toolChoice !== undefined
        ? { tools, toolChoice: toConverseToolChoice(req.toolChoice) }
        : { tools };
  }

  return input;
}

function toConverseToolChoice(tc: ToolChoice): ConverseToolChoice {
  switch (tc.type) {
    case "auto":
      return { auto: {} };
    case "any":
      return { any: {} };
    case "tool":
      return { tool: { name: tc.name } };
  }
}

function toConverseMessage(m: CanonicalMessage): Message {
  if (typeof m.content === "string") {
    return { role: m.role, content: [{ text: m.content }] };
  }
  const content: ContentBlock[] = [];
  for (const block of m.content) {
    switch (block.type) {
      case "text":
        content.push({ text: block.text });
        break;
      case "image": {
        const image = toConverseImage(block);
        if (image !== undefined) content.push({ image });
        break;
      }
      case "tool_use":
        content.push({
          toolUse: {
            toolUseId: block.id,
            name: block.name,
            input: (block.input ?? {}) as ConverseDocument,
          },
        });
        break;
      case "tool_result":
        content.push({ toolResult: toConverseToolResult(block) });
        break;
      case "thinking":
        // No request-side mapping: Converse families don't require
        // reasoning passback, and unknown blocks would be rejected.
        break;
    }
  }
  return { role: m.role, content };
}

const IMAGE_FORMAT_BY_MEDIA_TYPE: Readonly<Record<string, ImageFormat>> = {
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

function toConverseImage(block: CanonicalImageBlockParam): ImageBlock | undefined {
  // Converse images are raw bytes only — URL sources have no mapping.
  if (block.source.type !== "base64") return undefined;
  const format = IMAGE_FORMAT_BY_MEDIA_TYPE[block.source.media_type];
  if (format === undefined) return undefined;
  return { format, source: { bytes: Buffer.from(block.source.data, "base64") } };
}

function toConverseToolResult(block: CanonicalToolResultBlockParam): ToolResultBlock {
  const content: ToolResultContentBlock[] = [];
  if (typeof block.content === "string") {
    content.push({ text: block.content });
  } else if (block.content !== undefined) {
    for (const inner of block.content) {
      if (inner.type === "text") {
        content.push({ text: inner.text });
      } else {
        const image = toConverseImage(inner);
        if (image !== undefined) content.push({ image });
      }
    }
  }
  return {
    toolUseId: block.tool_use_id,
    content,
    // Converse's status vocabulary is success|error; omitting means
    // success, so only error is marked explicitly.
    ...(block.is_error === true ? { status: "error" as const } : {}),
  };
}

// ---------- ConverseStream → canonical events ---------- //

/**
 * Translate a ConverseStream event stream into canonical `StreamEvent`s.
 *
 * Converse emits `contentBlockStart` only for tool-use blocks; text and
 * reasoning blocks open implicitly with their first delta, so the
 * decoder opens the canonical block lazily per `contentBlockIndex`.
 * `messageStop` (stopReason) arrives BEFORE `metadata` (usage), so both
 * are buffered and folded into one closing `message_delta` +
 * `message_stop` pair — mirroring how the other adapters terminate. A
 * stream that ends without them still terminates canonically
 * (stopReason `end_turn`, no usage).
 *
 * In-band exception members (throttling, validation, model-stream, ...)
 * are thrown so the adapter's `normaliseBedrockError` maps them onto
 * the Anthropic-shaped taxonomy recovery-engine reads.
 */
export async function* translateConverseStream(
  stream: AsyncIterable<ConverseStreamOutput>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let stopReason: string | undefined;
  let usage: TokenUsage | undefined;
  const openBlocks = new Set<number>();

  for await (const ev of stream) {
    if (!started) {
      yield { kind: "message_start" };
      started = true;
    }

    if (ev.messageStart !== undefined) {
      continue; // canonical message_start already emitted above
    }

    if (ev.contentBlockStart !== undefined) {
      const index = ev.contentBlockStart.contentBlockIndex ?? 0;
      const toolUse = ev.contentBlockStart.start?.toolUse;
      if (toolUse !== undefined) {
        openBlocks.add(index);
        yield {
          kind: "content_block_start",
          index,
          block: {
            type: "tool_use",
            id: toolUse.toolUseId ?? "",
            name: toolUse.name ?? "",
            input: {},
          },
        };
      }
      // Other start members (toolResult/image) have no canonical shape.
      continue;
    }

    if (ev.contentBlockDelta !== undefined) {
      const index = ev.contentBlockDelta.contentBlockIndex ?? 0;
      const delta = ev.contentBlockDelta.delta;
      if (delta === undefined) continue;
      if (delta.text !== undefined) {
        if (!openBlocks.has(index)) {
          openBlocks.add(index);
          yield { kind: "content_block_start", index, block: { type: "text", text: "" } };
        }
        yield {
          kind: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta.text },
        };
      } else if (delta.toolUse !== undefined) {
        yield {
          kind: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: delta.toolUse.input ?? "" },
        };
      } else if (delta.reasoningContent !== undefined) {
        const reasoning = delta.reasoningContent;
        if (reasoning.text !== undefined || reasoning.signature !== undefined) {
          if (!openBlocks.has(index)) {
            openBlocks.add(index);
            yield {
              kind: "content_block_start",
              index,
              block: { type: "thinking", thinking: "" },
            };
          }
          if (reasoning.text !== undefined) {
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: reasoning.text },
            };
          }
          if (reasoning.signature !== undefined) {
            yield {
              kind: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: reasoning.signature },
            };
          }
        }
        // redactedContent has no canonical mapping → dropped.
      }
      continue;
    }

    if (ev.contentBlockStop !== undefined) {
      const index = ev.contentBlockStop.contentBlockIndex ?? 0;
      if (openBlocks.delete(index)) {
        yield { kind: "content_block_stop", index };
      }
      continue;
    }

    if (ev.messageStop !== undefined) {
      // Converse's stop vocabulary (end_turn | tool_use | max_tokens |
      // stop_sequence | ...) matches the canonical one on every overlap;
      // the rest (content_filtered, guardrail_intervened, ...) pass
      // through verbatim like the other decoders.
      stopReason = ev.messageStop.stopReason;
      continue;
    }

    if (ev.metadata !== undefined) {
      const u = ev.metadata.usage;
      if (u !== undefined) {
        usage = {
          input: u.inputTokens ?? 0,
          output: u.outputTokens ?? 0,
          ...(u.cacheReadInputTokens !== undefined ? { cacheRead: u.cacheReadInputTokens } : {}),
          ...(u.cacheWriteInputTokens !== undefined
            ? { cacheCreate: u.cacheWriteInputTokens }
            : {}),
        };
      }
      continue;
    }

    const inBandError =
      ev.internalServerException ??
      ev.modelStreamErrorException ??
      ev.validationException ??
      ev.throttlingException ??
      ev.serviceUnavailableException;
    if (inBandError !== undefined) throw inBandError;
  }

  if (!started) yield { kind: "message_start" };
  for (const index of openBlocks) {
    yield { kind: "content_block_stop", index };
  }
  yield {
    kind: "message_delta",
    stopReason: stopReason ?? "end_turn",
    ...(usage !== undefined ? { usage } : {}),
  };
  yield { kind: "message_stop" };
}
