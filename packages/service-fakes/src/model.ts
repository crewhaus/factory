/**
 * `fakeModel`: the Anthropic Messages API on loopback, for a harness pointed at
 * it through `ANTHROPIC_BASE_URL`.
 *
 * Every reply is scripted against a digest of the prompt, or comes from a
 * `defaultReply` the test declared. A prompt with neither gets a 400 that names
 * its digest, so a journey can never pass on a reply nobody wrote, and the
 * failure says exactly what to script.
 */
import { createHash } from "node:crypto";
import { type RecordedRequest, recordRequest } from "./record";
import { type FakeService, jsonResponse, serveLoopback } from "./serve";

export type FakeTextBlock = { readonly type: "text"; readonly text: string };
export type FakeToolUseBlock = {
  readonly type: "tool_use";
  readonly name: string;
  readonly input: unknown;
  readonly id?: string;
};
export type FakeContentBlock = FakeTextBlock | FakeToolUseBlock;

/** A reply: plain text, or the full list of content blocks. */
export type FakeModelReply =
  | string
  | {
      readonly content: readonly FakeContentBlock[];
      readonly stopReason?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };

/** A scripted failure, in the API's own error shape. */
export type FakeModelFault = {
  readonly status: 401 | 429 | 529;
  /** How many requests it answers before it is spent. */
  readonly times: number;
  /** Seconds, sent as `retry-after`. */
  readonly retryAfter?: number;
  readonly message?: string;
};

/** A declared price, per million tokens; `"unpriced"` is a model with none. */
export type FakeModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
};

export type FakeModelOptions = {
  readonly defaultReply?: FakeModelReply;
  readonly faults?: readonly FakeModelFault[];
  /** When supplied, an id outside the table answers 404 `not_found_error`. */
  readonly models?: Readonly<Record<string, FakeModelPrice | "unpriced">>;
};

export type FakeModel = FakeService & {
  /** Answer the prompt with this digest with this reply. */
  script(digest: string, reply: FakeModelReply): void;
  /** Requests received, on any path. */
  count(): number;
  /** Every request, with credentials masked. */
  requests(): readonly RecordedRequest[];
  /** The declared prices, for assertions. They never go on the wire. */
  readonly prices: Readonly<Record<string, FakeModelPrice | "unpriced">>;
};

const FAULT_TYPE: Readonly<Record<FakeModelFault["status"], string>> = {
  401: "authentication_error",
  429: "rate_limit_error",
  529: "overloaded_error",
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The sha256 of a request's canonical `{system, messages}`. */
export function promptDigest(body: {
  readonly system?: unknown;
  readonly messages?: unknown;
}): string {
  const text = canonical({ system: body.system ?? null, messages: body.messages ?? [] });
  return createHash("sha256").update(text).digest("hex");
}

function apiError(status: number, type: string, message: string, headers = {}): Response {
  return jsonResponse(status, { type: "error", error: { type, message } }, headers);
}

type ResolvedBlock =
  | FakeTextBlock
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; input: unknown };

type ResolvedReply = {
  readonly content: readonly ResolvedBlock[];
  readonly stopReason: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

function resolveReply(reply: FakeModelReply, requestNumber: number): ResolvedReply {
  const blocks: readonly FakeContentBlock[] =
    typeof reply === "string" ? [{ type: "text", text: reply }] : reply.content;
  const content = blocks.map((block, index): ResolvedBlock => {
    if (block.type === "text") return block;
    return {
      type: "tool_use",
      id: block.id ?? `toolu_fake_${requestNumber}_${index}`,
      name: block.name,
      input: block.input,
    };
  });
  const hasTool = content.some((block) => block.type === "tool_use");
  const options = typeof reply === "string" ? undefined : reply;
  return {
    content,
    stopReason: options?.stopReason ?? (hasTool ? "tool_use" : "end_turn"),
    inputTokens: options?.inputTokens ?? 10,
    outputTokens: options?.outputTokens ?? 5,
  };
}

function splitInTwo(text: string): readonly string[] {
  if (text.length < 2) return [text];
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

/** The full streaming event sequence for one reply, in the API's framing. */
function sseFrames(reply: ResolvedReply, model: string, messageId: string): string {
  const events: Array<{ readonly type: string; readonly [key: string]: unknown }> = [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: reply.inputTokens, output_tokens: 1 },
      },
    },
    { type: "ping" },
  ];
  reply.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      for (const text of splitInTwo(block.text)) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        });
      }
    } else {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      for (const partial_json of splitInTwo(JSON.stringify(block.input))) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json },
        });
      }
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: reply.stopReason, stop_sequence: null },
    usage: { output_tokens: reply.outputTokens },
  });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** Start a fake Messages API. */
export function fakeModel(opts: FakeModelOptions = {}): FakeModel {
  const scripted = new Map<string, FakeModelReply>();
  const recorded: RecordedRequest[] = [];
  const faults = (opts.faults ?? []).map((fault) => ({ ...fault, left: fault.times }));

  const server = serveLoopback(async (req) => {
    const { recorded: entry, parsed } = await recordRequest(req);
    recorded.push(entry);
    const requestNumber = recorded.length;

    const fault = faults.find((f) => f.left > 0);
    if (fault !== undefined) {
      fault.left -= 1;
      return apiError(
        fault.status,
        FAULT_TYPE[fault.status],
        fault.message ?? `scripted ${fault.status}`,
        fault.retryAfter !== undefined ? { "retry-after": String(fault.retryAfter) } : {},
      );
    }

    if (req.method !== "POST" || entry.path !== "/v1/messages") {
      return apiError(404, "not_found_error", `${req.method} ${entry.path} is not served here`);
    }
    if (req.headers.get("x-api-key") === null && req.headers.get("authorization") === null) {
      return apiError(401, "authentication_error", "x-api-key header is required");
    }
    if (parsed === null || typeof parsed !== "object") {
      return apiError(400, "invalid_request_error", "the request body is not JSON");
    }
    const body = parsed as {
      readonly model?: unknown;
      readonly stream?: unknown;
      readonly system?: unknown;
      readonly messages?: unknown;
    };
    const model = typeof body.model === "string" ? body.model : "";
    if (opts.models !== undefined && !Object.hasOwn(opts.models, model)) {
      return apiError(404, "not_found_error", `model: ${model}`);
    }

    const digest = promptDigest(body);
    const reply = scripted.get(digest) ?? opts.defaultReply;
    if (reply === undefined) {
      return apiError(400, "invalid_request_error", `no reply is scripted for prompt ${digest}`);
    }
    const resolved = resolveReply(reply, requestNumber);
    const messageId = `msg_fake_${requestNumber}`;
    if (body.stream === true) {
      return new Response(sseFrames(resolved, model, messageId), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return jsonResponse(200, {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: resolved.content,
      stop_reason: resolved.stopReason,
      stop_sequence: null,
      usage: { input_tokens: resolved.inputTokens, output_tokens: resolved.outputTokens },
    });
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port as number,
    prices: { ...(opts.models ?? {}) },
    script: (digest, reply) => {
      scripted.set(digest, reply);
    },
    count: () => recorded.length,
    requests: () => [...recorded],
    stop: async () => {
      await server.stop();
    },
  };
}
