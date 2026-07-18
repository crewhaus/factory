import type {
  CanonicalContentBlock,
  CanonicalContentDelta,
  CanonicalMessage,
  ProviderAdapter,
  ProviderFeatures,
  ProviderRequest,
  ReasoningEffort,
  StreamEvent,
  TokenUsage,
} from "@crewhaus/adapter-anthropic";
/**
 * @crewhaus/worker-runtime — the built-in, edge-safe Anthropic adapter.
 *
 * A concrete {@link ProviderAdapter} (the SAME interface the Node
 * `@crewhaus/adapter-anthropic` implements) that talks to the Anthropic
 * Messages API over an INJECTED `fetch` and parses the SSE stream into
 * canonical {@link StreamEvent}s. It is the formalisation of the "minimal
 * inlined SSE client" the three cf-worker emitters carry today — except it
 * yields the full canonical stream (text AND tool_use AND thinking), so the
 * loop above it gains real tools/budget/limits/trace.
 *
 * Node-free by construction: the only host capability it uses is
 * `platform.fetch`. It `import type`s the canonical wire shapes from
 * `@crewhaus/adapter-anthropic` (erased at build) and reuses
 * `@crewhaus/token-budget` for estimation, so the estimate matches the Node
 * path byte-for-byte.
 */
import { estimateTokens as estimateAnthropicTokens } from "@crewhaus/token-budget";
import type { WorkerPlatform } from "./platform";

/**
 * Effort→budget preset, mirroring `@crewhaus/adapter-anthropic`'s
 * `EFFORT_THINKING_BUDGET_TOKENS`. Re-declared (not imported as a value) so
 * this module pulls ZERO runtime code from the Node adapter — an explicit
 * cross-package golden test keeps the two tables identical.
 */
export const EDGE_EFFORT_THINKING_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  low: 2048,
  medium: 8192,
  high: 24576,
};

const ANTHROPIC_FEATURES: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: false,
};

export type EdgeAnthropicAdapterOptions = {
  /** Anthropic API key (`x-api-key`). Required for a real call. */
  readonly apiKey: string;
  /** Override the endpoint (default `https://api.anthropic.com/v1/messages`). */
  readonly baseUrl?: string;
  /** `anthropic-version` header (default `2023-06-01`). */
  readonly anthropicVersion?: string;
  /** Extra `anthropic-beta` feature flags, comma-joined into the header. */
  readonly betaHeaders?: readonly string[];
};

const DEFAULT_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_VERSION = "2023-06-01";

/**
 * Build the {@link ProviderAdapter} the loop streams through. `platform.fetch`
 * is captured here so the returned adapter carries no ambient global.
 */
export function createEdgeAnthropicAdapter(
  platform: WorkerPlatform,
  options: EdgeAnthropicAdapterOptions,
): ProviderAdapter {
  const url = options.baseUrl ?? DEFAULT_URL;
  const version = options.anthropicVersion ?? DEFAULT_VERSION;
  return {
    providerId: "anthropic",
    features: ANTHROPIC_FEATURES,
    estimateTokens(messages: ReadonlyArray<CanonicalMessage>): number {
      // token-budget's estimator is typed against the Anthropic SDK's
      // `MessageParam`, to which `CanonicalMessage` is isomorphic by design.
      return estimateAnthropicTokens(
        messages as unknown as Parameters<typeof estimateAnthropicTokens>[0],
      );
    },
    async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": version,
      };
      if (options.betaHeaders !== undefined && options.betaHeaders.length > 0) {
        headers["anthropic-beta"] = options.betaHeaders.join(",");
      }
      const body = buildRequestBody(req);
      const response = await platform.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      if (!response.ok || response.body === null) {
        const detail = await response.text().catch(() => "");
        yield {
          kind: "error",
          error: {
            type: `http_${response.status}`,
            message: detail.slice(0, 1000) || `Anthropic request failed (${response.status})`,
          },
        };
        return;
      }
      yield* parseSse(response.body);
    },
  };
}

/** Serialise a canonical {@link ProviderRequest} into the Anthropic wire body. */
function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    stream: true,
  };
  if (req.tools !== undefined && req.tools.length > 0) {
    body["tools"] = req.tools;
    if (req.toolChoice !== undefined) body["tool_choice"] = req.toolChoice;
  }
  // Extended thinking: an explicit budget wins; otherwise map the portable
  // effort preset onto Anthropic's token-budget control.
  if (req.thinking !== undefined) {
    body["thinking"] = { type: "enabled", budget_tokens: req.thinking.budgetTokens };
  } else if (req.reasoningEffort !== undefined) {
    body["thinking"] = {
      type: "enabled",
      budget_tokens: EDGE_EFFORT_THINKING_BUDGET_TOKENS[req.reasoningEffort],
    };
  }
  return body;
}

/**
 * Parse an Anthropic `text/event-stream` body into canonical
 * {@link StreamEvent}s. Buffers across chunk boundaries (an SSE frame can
 * split mid-line) and tolerates `ping`/unknown frames by skipping them.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseFrame(frame);
        if (event !== undefined) yield event;
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Translate one raw SSE frame (`event: …\ndata: …`) into a canonical event. */
function parseFrame(frame: string): StreamEvent | undefined {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (data === "" || data === "[DONE]") return undefined;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = payload["type"];
  switch (type) {
    case "message_start": {
      const message = payload["message"] as { usage?: RawUsage } | undefined;
      const usage = message?.usage;
      return usage !== undefined
        ? { kind: "message_start", usage: mapUsage(usage) }
        : { kind: "message_start" };
    }
    case "content_block_start": {
      const index = numberAt(payload, "index");
      const block = mapContentBlock(payload["content_block"]);
      return block !== undefined ? { kind: "content_block_start", index, block } : undefined;
    }
    case "content_block_delta": {
      const index = numberAt(payload, "index");
      const delta = mapContentDelta(payload["delta"]);
      return delta !== undefined ? { kind: "content_block_delta", index, delta } : undefined;
    }
    case "content_block_stop":
      return { kind: "content_block_stop", index: numberAt(payload, "index") };
    case "message_delta": {
      const delta = payload["delta"] as { stop_reason?: string } | undefined;
      const usage = payload["usage"] as RawUsage | undefined;
      return {
        kind: "message_delta",
        ...(delta?.stop_reason != null ? { stopReason: delta.stop_reason } : {}),
        ...(usage !== undefined ? { usage: mapUsage(usage) } : {}),
      };
    }
    case "message_stop":
      return { kind: "message_stop" };
    case "error": {
      const error = payload["error"] as { type?: string; message?: string } | undefined;
      return {
        kind: "error",
        error: { type: error?.type ?? "error", message: error?.message ?? "unknown error" },
      };
    }
    default:
      // `ping` and any future frame kinds are safely ignored.
      return undefined;
  }
}

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function mapUsage(u: RawUsage): TokenUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ...(u.cache_read_input_tokens != null ? { cacheRead: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens != null
      ? { cacheCreate: u.cache_creation_input_tokens }
      : {}),
  };
}

function mapContentBlock(raw: unknown): CanonicalContentBlock | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const block = raw as Record<string, unknown>;
  switch (block["type"]) {
    case "text":
      return { type: "text", text: typeof block["text"] === "string" ? block["text"] : "" };
    case "tool_use":
      return {
        type: "tool_use",
        id: String(block["id"] ?? ""),
        name: String(block["name"] ?? ""),
        input: block["input"] ?? {},
      };
    case "thinking":
      return {
        type: "thinking",
        thinking: typeof block["thinking"] === "string" ? block["thinking"] : "",
      };
    default:
      return undefined;
  }
}

function mapContentDelta(raw: unknown): CanonicalContentDelta | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const delta = raw as Record<string, unknown>;
  switch (delta["type"]) {
    case "text_delta":
      return { type: "text_delta", text: String(delta["text"] ?? "") };
    case "input_json_delta":
      return { type: "input_json_delta", partial_json: String(delta["partial_json"] ?? "") };
    case "thinking_delta":
      return { type: "thinking_delta", thinking: String(delta["thinking"] ?? "") };
    case "signature_delta":
      return { type: "signature_delta", signature: String(delta["signature"] ?? "") };
    default:
      return undefined;
  }
}

function numberAt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" ? value : 0;
}
