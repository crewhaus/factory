import { describe, expect, test } from "bun:test";
import {
  type BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { AdapterError } from "@crewhaus/errors";
import { classify, initialRecoveryState, recover } from "@crewhaus/recovery-engine";
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
 * Invoke commands answer with `{ body }` chunks; Converse commands answer
 * with `{ stream }` events — matching the two wire paths in adapter.ts.
 */
type BedrockChunk = { chunk?: { bytes?: Uint8Array } };

function fakeClient(opts: {
  chunks?: BedrockChunk[];
  converseEvents?: ConverseStreamOutput[];
  bodyUndefined?: boolean;
  streamUndefined?: boolean;
  sendError?: unknown;
  streamError?: unknown;
}): {
  client: BedrockRuntimeClient;
  captured: { command?: unknown; sendOpts?: unknown };
} {
  const captured: { command?: unknown; sendOpts?: unknown } = {};
  const client = {
    send: ((command: unknown, sendOpts?: unknown) => {
      captured.command = command;
      captured.sendOpts = sendOpts;
      if (opts.sendError !== undefined) return Promise.reject(opts.sendError);
      if (command instanceof ConverseStreamCommand) {
        const stream = opts.streamUndefined
          ? undefined
          : (async function* () {
              for (const ev of opts.converseEvents ?? []) yield ev;
              if (opts.streamError !== undefined) throw opts.streamError;
            })();
        return Promise.resolve({ stream });
      }
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

/** A minimal happy-path Converse event stream: one text block + terminator. */
const CONVERSE_TEXT_EVENTS: ConverseStreamOutput[] = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  {
    metadata: {
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      metrics: { latencyMs: 5 },
    },
  },
];

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

    // Converse families get genuine tool use; caching stays off.
    const llama = new BedrockAdapter({ client, family: "llama" });
    expect(llama.features.tool_use).toBe(true);
    expect(llama.features.caching).toBe(false);
  });

  test("estimateTokens delegates to token-budget heuristic", () => {
    const { client } = fakeClient({});
    const a = new BedrockAdapter({ client, family: "llama" });
    // 16 chars / 4 = 4 tokens.
    expect(a.estimateTokens([{ role: "user", content: "0123456789012345" }])).toBe(4);
  });
});

describe("BedrockAdapter.stream — anthropic request marshalling (invoke path)", () => {
  test("builds an InvokeModelWithResponseStream command with JSON body", async () => {
    const { client, captured } = fakeClient({
      chunks: [chunk({ type: "message_stop" })],
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await collect(a.stream(REQ));

    expect(captured.command).toBeInstanceOf(InvokeModelWithResponseStreamCommand);
    const input = (captured.command as InvokeModelWithResponseStreamCommand).input as {
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

describe("BedrockAdapter.stream — converse families", () => {
  test("llama routes through ConverseStreamCommand and passes tools", async () => {
    const { client, captured } = fakeClient({ converseEvents: CONVERSE_TEXT_EVENTS });
    const a = new BedrockAdapter({ client, family: "llama" });
    const events = await collect(
      a.stream({
        ...REQ,
        model: "meta.llama3-1-70b-instruct-v1:0",
        tools: [{ name: "Read", description: "x", input_schema: { type: "object" } }],
        toolChoice: { type: "auto" },
      }),
    );

    expect(captured.command).toBeInstanceOf(ConverseStreamCommand);
    const input = (captured.command as ConverseStreamCommand).input;
    expect(input.modelId).toBe("meta.llama3-1-70b-instruct-v1:0");
    expect(input.system).toEqual([{ text: "be terse" }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 64 });
    expect(input.toolConfig).toEqual({
      tools: [
        {
          toolSpec: {
            name: "Read",
            description: "x",
            inputSchema: { json: { type: "object" } },
          },
        },
      ],
      toolChoice: { auto: {} },
    });
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("mistral streams toolUse blocks through the converse decoder", async () => {
    const { client, captured } = fakeClient({
      converseEvents: [
        { messageStart: { role: "assistant" } },
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: { toolUse: { toolUseId: "tu_1", name: "Read" } },
          },
        },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } } },
        { contentBlockStop: { contentBlockIndex: 0 } },
        { messageStop: { stopReason: "tool_use" } },
        {
          metadata: {
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            metrics: { latencyMs: 5 },
          },
        },
      ],
    });
    const a = new BedrockAdapter({ client, family: "mistral" });
    const events = await collect(
      a.stream({
        ...REQ,
        model: "mistral.mistral-large-2402-v1:0",
        tools: [{ name: "Read", description: "x", input_schema: { type: "object" } }],
      }),
    );
    expect(captured.command).toBeInstanceOf(ConverseStreamCommand);
    expect(events[1]).toEqual({
      kind: "content_block_start",
      index: 0,
      block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    });
    const md = events.find(
      (e): e is Extract<StreamEvent, { kind: "message_delta" }> => e.kind === "message_delta",
    );
    expect(md?.stopReason).toBe("tool_use");
    expect(md?.usage).toEqual({ input: 5, output: 2 });
  });

  const CONVERSE_FAMILY_MODELS: ReadonlyArray<readonly [BedrockFamily, string]> = [
    ["nova", "amazon.nova-pro-v1:0"],
    ["deepseek", "deepseek.r1-v1:0"],
    ["cohere", "cohere.command-r-plus-v1:0"],
    ["qwen", "qwen.qwen3-32b-v1:0"],
    ["gpt-oss", "openai.gpt-oss-120b-1:0"],
  ];

  for (const [family, model] of CONVERSE_FAMILY_MODELS) {
    test(`${family} constructs and streams through converse`, async () => {
      const { client, captured } = fakeClient({ converseEvents: CONVERSE_TEXT_EVENTS });
      const a = new BedrockAdapter({ client, family });
      const events = await collect(a.stream({ ...REQ, model }));
      expect(captured.command).toBeInstanceOf(ConverseStreamCommand);
      expect((captured.command as ConverseStreamCommand).input.modelId).toBe(model);
      expect(events[0]?.kind).toBe("message_start");
      expect(events[events.length - 1]?.kind).toBe("message_stop");
    });
  }

  test("threads the abort signal into converse send() options", async () => {
    const controller = new AbortController();
    const { client, captured } = fakeClient({ converseEvents: CONVERSE_TEXT_EVENTS });
    const a = new BedrockAdapter({ client, family: "llama" });
    await collect(
      a.stream({ ...REQ, model: "meta.llama3-1-70b-instruct-v1:0", signal: controller.signal }),
    );
    expect((captured.sendOpts as { abortSignal?: AbortSignal }).abortSignal).toBe(
      controller.signal,
    );
  });
});

describe("BedrockAdapter.stream — error handling", () => {
  test("throws AdapterError when the invoke response has no body", async () => {
    const { client } = fakeClient({ bodyUndefined: true });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    await expect(collect(a.stream(REQ))).rejects.toBeInstanceOf(AdapterError);
    await expect(collect(a.stream(REQ))).rejects.toThrow(/no body/);
  });

  test("throws AdapterError when the converse response has no stream", async () => {
    const { client } = fakeClient({ streamUndefined: true });
    const a = new BedrockAdapter({ client, family: "llama" });
    const req = { ...REQ, model: "meta.llama3-1-70b-instruct-v1:0" };
    await expect(collect(a.stream(req))).rejects.toBeInstanceOf(AdapterError);
    await expect(collect(a.stream(req))).rejects.toThrow(/no stream/);
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

  test("wraps a converse send() failure through normaliseBedrockError", async () => {
    const sdkErr = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    const { client } = fakeClient({ sendError: sdkErr });
    const a = new BedrockAdapter({ client, family: "nova" });
    let caught: unknown;
    try {
      await collect(a.stream({ ...REQ, model: "amazon.nova-pro-v1:0" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(429);
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

  test("rethrows an AbortError raised mid-converse-stream unwrapped", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client } = fakeClient({
      converseEvents: [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } }],
      streamError: abortErr,
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    await expect(
      collect(a.stream({ ...REQ, model: "meta.llama3-1-70b-instruct-v1:0" })),
    ).rejects.toBe(abortErr);
  });

  test("normalises a non-abort mid-converse-stream failure", async () => {
    const sdkErr = Object.assign(new Error("stream blew up"), {
      name: "ModelStreamErrorException",
      $metadata: { httpStatusCode: 500 },
    });
    const { client } = fakeClient({
      converseEvents: [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } }],
      streamError: sdkErr,
    });
    const a = new BedrockAdapter({ client, family: "llama" });
    let caught: unknown;
    try {
      await collect(a.stream({ ...REQ, model: "meta.llama3-1-70b-instruct-v1:0" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(500);
    expect((caught as { error?: { type?: string } }).error?.type).toBe("overloaded_error");
  });

  test("normalises an in-band converse exception event", async () => {
    const inBand = Object.assign(new Error("throttled mid-stream"), {
      name: "ThrottlingException",
    });
    const { client } = fakeClient({
      converseEvents: [
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "x" } } },
        { throttlingException: inBand } as unknown as ConverseStreamOutput,
      ],
    });
    const a = new BedrockAdapter({ client, family: "deepseek" });
    let caught: unknown;
    try {
      await collect(a.stream({ ...REQ, model: "deepseek.r1-v1:0" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(429);
    // v0.3.0 Goal 6 — throttles are rate-limit-shaped, no longer overloaded.
    expect((caught as { error?: { type?: string } }).error?.type).toBe("rate_limit_error");
  });

  test("normalises a non-abort mid-invoke-stream failure", async () => {
    const sdkErr = Object.assign(new Error("stream blew up"), {
      name: "ModelStreamErrorException",
      $metadata: { httpStatusCode: 500 },
    });
    const { client } = fakeClient({
      chunks: [chunk({ type: "ping" })],
      streamError: sdkErr,
    });
    const a = new BedrockAdapter({ client, family: "anthropic" });
    let caught: unknown;
    try {
      await collect(a.stream(REQ));
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

  test("falls back to AWS_REGION, then AWS_DEFAULT_REGION", () => {
    // Each branch returns a valid adapter; the client construction is the
    // observable effect (a throwing region would fail construction).
    expect(createBedrockAdapter({ family: "llama" }, { AWS_REGION: "ap-south-1" })).toBeInstanceOf(
      BedrockAdapter,
    );
    expect(
      createBedrockAdapter({ family: "llama" }, { AWS_DEFAULT_REGION: "sa-east-1" }),
    ).toBeInstanceOf(BedrockAdapter);
  });

  test("no explicit region → client still constructs (SDK chain resolves later)", () => {
    // No region option/env must NOT default to us-east-1 — the client is
    // built without a region so the SDK's provider chain can consult
    // ~/.aws/config at send() time.
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

  test("Throttling-class names map to 429 / rate_limit_error (v0.3.0: rate-limit-shaped)", async () => {
    const err = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string };
    };
    expect(out.status).toBe(429);
    expect(out.error?.type).toBe("rate_limit_error");
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

  // =========================================================================
  // v0.3.0 Goal 6 (PR 2) — quota-vs-throttle discrimination, end-to-end
  // through recovery-engine. Smithy exceptions carry the discriminator in
  // the exception NAME plus `$metadata.httpStatusCode`.
  // =========================================================================

  test("TooManyRequestsException also maps to the rate-limit shape → classify() rate_limit", async () => {
    const err = Object.assign(new Error("Too many requests, please wait"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    const out = (await streamError("anthropic", err)) as {
      status?: number;
      error?: { type?: string };
    };
    expect(out.status).toBe(429);
    expect(out.error?.type).toBe("rate_limit_error");
    expect(classify(out)).toBe("rate_limit");
    expect(recover(out, initialRecoveryState).kind).toBe("retry");
  });

  test("ServiceQuotaExceededException keeps its name and real status → classify() billing", async () => {
    // Real Smithy shape: ServiceQuotaExceededException is an HTTP 400 —
    // pre-0.3.0 the adapter fabricated a 429/overloaded, burning retries on
    // a hard account quota.
    const err = Object.assign(
      new Error("You have reached the maximum number of requests for this account."),
      {
        name: "ServiceQuotaExceededException",
        $fault: "client",
        $metadata: { httpStatusCode: 400 },
      },
    );
    const out = (await streamError("anthropic", err)) as {
      name?: string;
      status?: number;
      error?: unknown;
    };
    expect(out).toBeInstanceOf(AdapterError);
    expect((out as AdapterError).providerId).toBe("bedrock");
    expect(out.name).toBe("ServiceQuotaExceededException");
    expect(out.status).toBe(400);
    // No fabricated 429/overloaded stamp — the name is the discriminator.
    expect(out.error).toBeUndefined();
    expect(classify(out)).toBe("billing");
  });

  test("ServiceQuotaExceededException → recover() halts with the billing report (exit 31, Bedrock attribution)", async () => {
    const err = Object.assign(
      new Error("You have reached the maximum number of requests for this account."),
      {
        name: "ServiceQuotaExceededException",
        $metadata: { httpStatusCode: 400 },
      },
    );
    const out = await streamError("anthropic", err);
    const action = recover(out, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.class).toBe("billing");
    expect(action.report.exitCode).toBe(31);
    expect(action.report.detail).toContain("Bedrock said:");
    expect(action.report.remediation).toContain("quota");
  });

  test("403 auth-class exceptions pass through on status → classify() auth", async () => {
    for (const name of [
      "UnrecognizedClientException",
      "AccessDeniedException",
      "ExpiredTokenException",
    ]) {
      const err = Object.assign(new Error("The security token included is invalid."), {
        name,
        $metadata: { httpStatusCode: 403 },
      });
      const out = (await streamError("anthropic", err)) as { status?: number };
      expect(out.status).toBe(403);
      expect(classify(out)).toBe("auth");
    }
  });

  test("401 passes through on status → classify() auth → halt (exit 30)", async () => {
    const err = Object.assign(new Error("Unable to locate credentials"), {
      name: "UnauthorizedException",
      $metadata: { httpStatusCode: 401 },
    });
    const out = await streamError("anthropic", err);
    expect(classify(out)).toBe("auth");
    const action = recover(out, initialRecoveryState);
    expect(action.kind).toBe("halt");
    if (action.kind !== "halt") return;
    expect(action.report.exitCode).toBe(30);
  });

  test("regression: InternalServerException / plain 5xx keep the overloaded shape and retry", async () => {
    const err = Object.assign(new Error("kaboom"), { name: "InternalServerException" });
    const out = await streamError("anthropic", err);
    expect((out as { error?: unknown }).error).toEqual({ type: "overloaded_error" });
    expect(classify(out)).toBe("overloaded_or_5xx");
    expect(recover(out, initialRecoveryState).kind).toBe("retry");
  });
});
