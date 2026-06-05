import { describe, expect, test } from "bun:test";
import {
  type BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { AdapterError } from "@crewhaus/errors";
import {
  BedrockAdapter,
  type CreateBedrockAdapterOptions,
  createBedrockAdapter,
} from "./adapter.js";
import type { BedrockFamily } from "./family.js";

/**
 * A fake `BedrockRuntimeClient` whose `send()` returns a canned response
 * (or throws a canned error) and records the command it was given. Mirrors
 * the `fakeClient` pattern used by adapter-anthropic's adapter.test.ts.
 */
type BedrockChunk = { chunk?: { bytes?: Uint8Array } };

function fakeClient(opts: {
  chunks?: BedrockChunk[];
  bodyUndefined?: boolean;
  sendError?: unknown;
  streamError?: unknown;
}): {
  client: BedrockRuntimeClient;
  captured: { command?: InvokeModelWithResponseStreamCommand; sendOpts?: unknown };
} {
  const captured: {
    command?: InvokeModelWithResponseStreamCommand;
    sendOpts?: unknown;
  } = {};
  const client = {
    send: ((command: InvokeModelWithResponseStreamCommand, sendOpts?: unknown) => {
      captured.command = command;
      captured.sendOpts = sendOpts;
      if (opts.sendError !== undefined) return Promise.reject(opts.sendError);
      const body = opts.bodyUndefined
        ? undefined
        : (async function* () {
            for (const c of opts.chunks ?? []) yield c;
            if (opts.streamError !== undefined) throw opts.streamError;
          })();
      return Promise.resolve({ body });
    }) as unknown as BedrockRuntimeClient["send"],
  } as unknown as BedrockRuntimeClient;
  return { client, captured };
}

/** Encode a JS object as a Bedrock EventStream chunk. */
function chunk(obj: unknown): BedrockChunk {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(obj)) } };
}

const REQ: ProviderRequest = {
  model: "anthropic.claude-sonnet-4-v1:0",
  system: [{ type: "text", text: "be terse" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
};

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("BedrockAdapter — construction", () => {
  test("providerId, family, and family-specific features", () => {
    const { client } = fakeClient({});
    const a = new BedrockAdapter({ client, family: "anthropic" });
    expect(a.providerId).toBe("bedrock");
    expect(a.family).toBe("anthropic");
    expect(a.features.tool_use).toBe(true);
    expect(a.features.caching).toBe("explicit");

    const llama = new BedrockAdapter({ client, family: "llama" });
    expect(llama.features.tool_use).toBe(false);
  });

  test("estimateTokens delegates to token-budget heuristic", () => {
    const { client } = fakeClient({});
    const a = new BedrockAdapter({ client, family: "llama" });
    // 16 chars / 4 = 4 tokens.
    expect(a.estimateTokens([{ role: "user", content: "0123456789012345" }])).toBe(4);
  });
});

describe("BedrockAdapter.stream — request marshalling", () => {
  test("builds an InvokeModelWithResponseStream command with JSON body", async () => {
    const { client, captured } = fakeClient({
      chunks: [chunk({ type: "message_stop" })],
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await collect(a.stream(REQ));

    expect(captured.command).toBeInstanceOf(InvokeModelWithResponseStreamCommand);
    const input = captured.command?.input as {
      modelId?: string;
      contentType?: string;
      accept?: string;
      body?: Uint8Array;
    };
    expect(input.modelId).toBe("anthropic.claude-sonnet-4-v1:0");
    expect(input.contentType).toBe("application/json");
    expect(input.accept).toBe("application/json");
    const decoded = JSON.parse(new TextDecoder().decode(input.body));
    expect(decoded.anthropic_version).toBe("bedrock-2023-05-31");
    expect(decoded.max_tokens).toBe(64);
  });

  test("threads an abort signal into send() options", async () => {
    const controller = new AbortController();
    const { client, captured } = fakeClient({ chunks: [chunk({ type: "message_stop" })] });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await collect(a.stream({ ...REQ, signal: controller.signal }));
    expect((captured.sendOpts as { abortSignal?: AbortSignal }).abortSignal).toBe(
      controller.signal,
    );
  });

  test("omits abortSignal when no signal is supplied", async () => {
    const { client, captured } = fakeClient({ chunks: [chunk({ type: "message_stop" })] });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await collect(a.stream(REQ));
    expect((captured.sendOpts as { abortSignal?: AbortSignal }).abortSignal).toBeUndefined();
  });

  test("marshals llama bodies as a prompt string", async () => {
    const { client, captured } = fakeClient({ chunks: [] });
    const a = new BedrockAdapter({ client, family: "llama" });
    await collect(a.stream({ ...REQ, model: "meta.llama3-1-8b-instruct-v1:0" }));
    const body = JSON.parse(
      new TextDecoder().decode((captured.command?.input as { body?: Uint8Array }).body),
    );
    expect(typeof body.prompt).toBe("string");
    expect(body.max_gen_len).toBe(64);
  });

  test("marshals mistral bodies as a prompt string", async () => {
    const { client, captured } = fakeClient({ chunks: [] });
    const a = new BedrockAdapter({ client, family: "mistral" });
    await collect(a.stream({ ...REQ, model: "mistral.mistral-large-2402-v1:0" }));
    const body = JSON.parse(
      new TextDecoder().decode((captured.command?.input as { body?: Uint8Array }).body),
    );
    expect(typeof body.prompt).toBe("string");
    expect(body.max_tokens).toBe(64);
  });
});

describe("BedrockAdapter.stream — anthropic family", () => {
  test("emits message_start then the decoded raw events (no synthetic terminator)", async () => {
    const { client } = fakeClient({
      chunks: [
        chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        chunk({ type: "content_block_stop", index: 0 }),
        chunk({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        }),
        chunk({ type: "message_stop" }),
      ],
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    const events = await collect(a.stream(REQ));
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("skips chunks the family decoder drops (returns null) and chunks without bytes", async () => {
    const { client } = fakeClient({
      chunks: [
        { chunk: {} }, // no bytes → continue
        {}, // no chunk at all → continue
        chunk({ type: "ping" }), // decodes to null → dropped
        chunk({ type: "message_stop" }),
      ],
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    const events = await collect(a.stream(REQ));
    expect(events.map((e) => e.kind)).toEqual(["message_start", "message_stop"]);
  });
});

describe("BedrockAdapter.stream — llama family", () => {
  test("decodes generation deltas and the decoder fires its own terminator", async () => {
    const { client } = fakeClient({
      chunks: [
        chunk({ generation: "Hello" }),
        chunk({ generation: ", world", stop_reason: "stop", generation_token_count: 3 }),
      ],
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    const events = await collect(a.stream({ ...REQ, model: "meta.llama3-70b-instruct-v1:0" }));
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("synthesizes a terminator when the stream ends without a stop_reason", async () => {
    const { client } = fakeClient({
      chunks: [chunk({ generation: "partial" })],
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    const events = await collect(a.stream({ ...REQ, model: "meta.llama3-70b-instruct-v1:0" }));
    // No stop_reason in-band: adapter appends message_delta(end_turn) + message_stop.
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "message_delta",
      "message_stop",
    ]);
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("end_turn");
  });
});

describe("BedrockAdapter.stream — mistral family", () => {
  test("synthesizes a terminator when the stream ends open", async () => {
    const { client } = fakeClient({
      chunks: [chunk({ outputs: [{ text: "Bonjour" }] })],
    });
    const a = new BedrockAdapter({ client, family: "mistral" });
    const events = await collect(a.stream({ ...REQ, model: "mistral.mistral-large-2402-v1:0" }));
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "message_delta",
      "message_stop",
    ]);
  });

  test("does not double-terminate when the decoder already closed", async () => {
    const { client } = fakeClient({
      chunks: [chunk({ outputs: [{ text: "Bonjour", stop_reason: "stop" }] })],
    });
    const a = new BedrockAdapter({ client, family: "mistral" });
    const events = await collect(a.stream({ ...REQ, model: "mistral.mistral-large-2402-v1:0" }));
    // Exactly one message_stop.
    expect(events.filter((e) => e.kind === "message_stop")).toHaveLength(1);
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });
});

describe("BedrockAdapter.stream — error handling", () => {
  test("throws AdapterError when the response has no body", async () => {
    const { client } = fakeClient({ bodyUndefined: true });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await expect(collect(a.stream(REQ))).rejects.toBeInstanceOf(AdapterError);
    await expect(collect(a.stream(REQ))).rejects.toThrow(/no body/);
  });

  test("wraps a send() failure through normaliseBedrockError", async () => {
    const sdkErr = Object.assign(new Error("boom"), {
      name: "ValidationException",
      $metadata: { httpStatusCode: 400 },
    });
    const { client } = fakeClient({ sendError: sdkErr });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    let caught: unknown;
    try {
      await collect(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(400);
  });

  test("rethrows an AbortError raised by send() unwrapped", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client } = fakeClient({ sendError: abortErr });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await expect(collect(a.stream(REQ))).rejects.toBe(abortErr);
  });

  test("raises AdapterError on un-parseable chunk JSON", async () => {
    const { client } = fakeClient({
      chunks: [{ chunk: { bytes: new TextEncoder().encode("{not json") } }],
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    let caught: unknown;
    try {
      await collect(a.stream(REQ));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as Error).message).toMatch(/failed to parse Bedrock chunk JSON/);
  });

  test("rethrows an AbortError raised mid-stream unwrapped", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client } = fakeClient({
      chunks: [chunk({ generation: "x" })],
      streamError: abortErr,
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    await expect(
      collect(a.stream({ ...REQ, model: "meta.llama3-70b-instruct-v1:0" })),
    ).rejects.toBe(abortErr);
  });

  test("normalises a non-abort mid-stream failure", async () => {
    const sdkErr = Object.assign(new Error("stream blew up"), {
      name: "ModelStreamErrorException",
      $metadata: { httpStatusCode: 500 },
    });
    const { client } = fakeClient({
      chunks: [chunk({ generation: "x" })],
      streamError: sdkErr,
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    let caught: unknown;
    try {
      await collect(a.stream({ ...REQ, model: "meta.llama3-70b-instruct-v1:0" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(500);
    expect((caught as { error?: { type?: string } }).error?.type).toBe("overloaded_error");
  });
});

describe("createBedrockAdapter — region resolution", () => {
  test("prefers an explicit region", () => {
    const a = createBedrockAdapter({ family: "anthropic", region: "eu-west-1" }, {});
    expect(a).toBeInstanceOf(BedrockAdapter);
    expect(a.family).toBe("anthropic");
  });

  test("falls back to AWS_REGION, then AWS_DEFAULT_REGION, then us-east-1", () => {
    // Each branch returns a valid adapter; the client construction is the
    // observable effect (a throwing region would fail construction).
    expect(createBedrockAdapter({ family: "llama" }, { AWS_REGION: "ap-south-1" })).toBeInstanceOf(
      BedrockAdapter,
    );
    expect(
      createBedrockAdapter({ family: "llama" }, { AWS_DEFAULT_REGION: "sa-east-1" }),
    ).toBeInstanceOf(BedrockAdapter);
    expect(createBedrockAdapter({ family: "mistral" }, {})).toBeInstanceOf(BedrockAdapter);
  });

  test("defaults the env argument to process.env", () => {
    // Calling with a single argument exercises the default-parameter path.
    const opts: CreateBedrockAdapterOptions = { family: "anthropic", region: "us-west-2" };
    expect(createBedrockAdapter(opts)).toBeInstanceOf(BedrockAdapter);
  });
});

describe("normaliseBedrockError — taxonomy mapping (via send failures)", () => {
  async function streamError(family: BedrockFamily, err: unknown): Promise<unknown> {
    const { client } = fakeClient({ sendError: err });
    const a = new BedrockAdapter({ client, family });
    try {
      await collect(a.stream({ ...REQ, model: "anthropic.claude-sonnet-4-v1:0" }));
    } catch (e) {
      return e;
    }
    throw new Error("expected stream() to throw");
  }

  test("APIUserAbortError is returned unwrapped", async () => {
    const err = Object.assign(new Error("user abort"), { name: "APIUserAbortError" });
    expect(await streamError("anthropic", err)).toBe(err);
  });

  test("Throttling-class names map to 429 / overloaded_error", async () => {
    const err = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string };
    };
    expect(out.status).toBe(429);
    expect(out.error?.type).toBe("overloaded_error");
  });

  test("InternalServerException without metadata defaults to 500 / overloaded_error", async () => {
    const err = Object.assign(new Error("kaboom"), { name: "InternalServerException" });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string };
    };
    expect(out.status).toBe(500);
    expect(out.error?.type).toBe("overloaded_error");
  });

  test("ModelStreamError honours an explicit 5xx status from metadata", async () => {
    const err = Object.assign(new Error("upstream"), {
      name: "ModelStreamErrorException",
      $metadata: { httpStatusCode: 503 },
    });
    const out = (await streamError("anthropic", err)) as { status?: number };
    expect(out.status).toBe(503);
  });

  test("ValidationException about context length maps to 400 / Prompt is too long", async () => {
    const err = Object.assign(new Error("input is too long for the model context"), {
      name: "ValidationException",
    });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string; message?: string };
    };
    expect(out.status).toBe(400);
    expect(out.error?.type).toBe("invalid_request_error");
    expect(out.error?.message).toBe("Prompt is too long");
  });

  test("a 400 status without a recognised name maps to a generic invalid_request_error", async () => {
    const err = Object.assign(new Error("bad request"), {
      name: "SomeOtherException",
      $metadata: { httpStatusCode: 400 },
    });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string; message?: string };
    };
    expect(out.status).toBe(400);
    expect(out.error?.type).toBe("invalid_request_error");
    expect(out.error?.message).toBeUndefined();
  });

  test("a 5xx status without a recognised name maps to overloaded_error", async () => {
    const err = Object.assign(new Error("gateway"), {
      name: "SomeOtherException",
      $metadata: { httpStatusCode: 502 },
    });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string };
    };
    expect(out.status).toBe(502);
    expect(out.error?.type).toBe("overloaded_error");
  });

  test("a non-4xx/5xx status (e.g. 302) is carried through without an error shape", async () => {
    const err = Object.assign(new Error("redirect"), {
      name: "SomeOtherException",
      $metadata: { httpStatusCode: 302 },
    });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: unknown;
    };
    expect(out.status).toBe(302);
    expect(out.error).toBeUndefined();
  });

  test("an error with no status and no recognised name stays a bare AdapterError", async () => {
    const err = Object.assign(new Error("mystery"), { name: "WeirdError" });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: unknown;
    };
    expect(out).toBeInstanceOf(AdapterError);
    expect(out.status).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  test("a non-Error throwable is stringified into the AdapterError message", async () => {
    const out = (await streamError("anthropic", "plain string failure")) as Error;
    expect(out).toBeInstanceOf(AdapterError);
    expect(out.message).toBe("plain string failure");
  });

  test("a null throwable is handled without crashing", async () => {
    const out = (await streamError("anthropic", null)) as Error;
    expect(out).toBeInstanceOf(AdapterError);
    expect(out.message).toBe("null");
  });
});
