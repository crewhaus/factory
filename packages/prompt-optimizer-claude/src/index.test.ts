import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import {
  ClaudeMutationProvider,
  ClaudeMutationProviderError,
  createClaudeMutationProvider,
} from "./index";

const SAMPLE_TRAIN: ReadonlyArray<Sample> = [
  { id: "t1", input: "What is 2+2?", expected_output: "4" },
  { id: "t2", input: "Capital of France?", expected_output: "Paris" },
];

const SAMPLE_DEV: ReadonlyArray<Sample> = [
  { id: "d1", input: "What is 3+3?", expected_output: "6" },
  { id: "d2", input: "Capital of Germany?", expected_output: "Berlin" },
];

/**
 * Build a mock provider adapter whose `.stream()` yields the StreamEvent
 * sequence that produces a single text message with the given content.
 * Matches the canonical event protocol consumed by
 * `consumeStream`/`collectFinalMessage`.
 */
function mockAdapter(
  content: string,
  usage: { input: number; output: number; cacheRead?: number } = { input: 0, output: 0 },
): ProviderAdapter {
  return {
    id: "mock",
    features: {
      caching: "none",
      thinking: false,
      multimodal: { input: false, output: false },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    stream(_params: any): AsyncIterable<any> {
      return (async function* () {
        // message_start carries input (+ cache) counts; message_delta
        // carries the running output count — matches the real protocol.
        yield {
          kind: "message_start",
          usage: {
            input: usage.input,
            output: 0,
            ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
          },
        };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: content },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: usage.input, output: usage.output },
        };
        yield { kind: "message_stop" };
      })();
    },
  } as unknown as ProviderAdapter;
}

const baseState: OptimizerState = {
  iteration: 1,
  best: {
    id: "candidate-0",
    prompt: "You are a helpful assistant.",
    mutations: [],
    score: 0.4,
  },
  trajectory: [],
  trainSet: SAMPLE_TRAIN,
  devSet: SAMPLE_DEV,
};

describe("ClaudeMutationProvider", () => {
  test("exposes the adapter's providerId for the FR-003 cost-gate (provider-agnostic pricing)", () => {
    const adapter = {
      ...mockAdapter("{}"),
      providerId: "openai",
    } as unknown as ProviderAdapter;
    const provider = new ClaudeMutationProvider({ adapter, model: "gpt-4o-mini" });
    expect(provider.providerId).toBe("openai");
    expect(provider.modelId).toBe("gpt-4o-mini");
  });

  test("parses a clean JSON response and returns it as the rewrite", async () => {
    const adapter = mockAdapter(
      `{"rewrite": "Think step by step before answering. Be concise.", "rationale": "Adds explicit chain-of-thought scaffolding which helps on multi-step problems."}`,
    );
    const provider = new ClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
    });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe("Think step by step before answering. Be concise.");
    expect(result.rationale).toContain("chain-of-thought");
    expect(result.mutations).toHaveLength(1);
  });

  test("tolerates code-fence wrapping around the JSON", async () => {
    const adapter = mockAdapter(
      "```json\n" +
        `{"rewrite": "Be precise and direct.", "rationale": "Removes ambiguity."}` +
        "\n```",
    );
    const provider = new ClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
    });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe("Be precise and direct.");
  });

  test("falls back to current best on malformed JSON (no abort)", async () => {
    const adapter = mockAdapter("not actually json");
    const provider = new ClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
    });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe(baseState.best.prompt);
    expect(result.rationale).toContain("claude-fallback");
  });

  test("falls back when the model errors out", async () => {
    const adapter = {
      id: "mock",
      features: {
        caching: "none",
        thinking: false,
        multimodal: { input: false, output: false },
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      stream(_params: any): AsyncIterable<any> {
        return (async function* () {
          throw new Error("model unavailable");
          // biome-ignore lint/correctness/noUnreachable: keep typed as async generator
          yield;
        })();
      },
    } as unknown as ProviderAdapter;
    const provider = new ClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
    });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe(baseState.best.prompt);
    expect(result.rationale).toContain("claude-fallback");
    expect(result.rationale).toContain("model unavailable");
  });

  test("rejects responses missing required schema fields", async () => {
    const adapter = mockAdapter(`{"rewrite": "Only rewrite, no rationale"}`);
    const provider = new ClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
    });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe(baseState.best.prompt);
    expect(result.rationale).toContain("claude-fallback");
  });

  test("name is 'claude' for trajectory logging", () => {
    const provider = new ClaudeMutationProvider({
      adapter: mockAdapter(""),
      model: "claude-sonnet-4-5",
    });
    expect(provider.name).toBe("claude");
  });

  // FR-003 — the provider surfaces per-call usage + exposes pricing getters.
  test("returns per-call usage from the response on the success path", async () => {
    const adapter = mockAdapter(`{"rewrite": "Be concise.", "rationale": "Removes ambiguity."}`, {
      input: 1234,
      output: 567,
      cacheRead: 89,
    });
    const provider = new ClaudeMutationProvider({ adapter, model: "claude-sonnet-4-5" });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe("Be concise.");
    expect(result.usage).toEqual({ input: 1234, output: 567, cacheRead: 89 });
  });

  test("forwards consumed usage even when the response is unusable (JSON miss)", async () => {
    const adapter = mockAdapter("not actually json", { input: 100, output: 20 });
    const provider = new ClaudeMutationProvider({ adapter, model: "claude-sonnet-4-5" });
    const result = await provider.next(baseState);
    // Fell back to current best, but the spend the model DID incur is reported.
    expect(result.prompt).toBe(baseState.best.prompt);
    expect(result.rationale).toContain("claude-fallback");
    expect(result.usage).toEqual({ input: 100, output: 20 });
  });

  test("omits usage when the model call never completes (stream error)", async () => {
    const adapter = {
      id: "mock",
      features: { caching: "none", thinking: false, multimodal: { input: false, output: false } },
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      stream(_params: any): AsyncIterable<any> {
        return (async function* () {
          throw new Error("model unavailable");
          // biome-ignore lint/correctness/noUnreachable: keep typed as async generator
          yield;
        })();
      },
    } as unknown as ProviderAdapter;
    const provider = new ClaudeMutationProvider({ adapter, model: "claude-sonnet-4-5" });
    const result = await provider.next(baseState);
    expect(result.prompt).toBe(baseState.best.prompt);
    expect(result.usage).toBeUndefined();
  });

  test("exposes modelId + maxOutputTokens getters for the cost-gate", () => {
    const provider = new ClaudeMutationProvider({
      adapter: mockAdapter(""),
      model: "claude-opus-4-7",
      maxTokens: 4096,
    });
    expect(provider.modelId).toBe("claude-opus-4-7");
    expect(provider.maxOutputTokens).toBe(4096);
  });

  test("maxOutputTokens getter defaults to 2048", () => {
    const provider = new ClaudeMutationProvider({
      adapter: mockAdapter(""),
      model: "claude-sonnet-4-5",
    });
    expect(provider.maxOutputTokens).toBe(2048);
  });

  // FR-003 (input-estimate gap) — estimateInputChars must count the FULL
  // serialized input (system block + rendered dev-set failure block), not
  // just the candidate prompt, so the orchestrator's cost-gate cannot
  // under-count input for a wide dev window.
  test("estimateInputChars counts the system block + rendered failure block", () => {
    const provider = new ClaudeMutationProvider({
      adapter: mockAdapter(""),
      model: "claude-sonnet-4-5",
    });
    const est = provider.estimateInputChars(baseState);
    // Strictly greater than the prompt length alone — the deficit the naive
    // `best.prompt.length` estimate would have missed.
    expect(est).toBeGreaterThan(baseState.best.prompt.length);
    // The estimate covers the rendered failure block: it exceeds the prompt
    // length PLUS the combined dev-set input + expected_output text that
    // next() serializes — exactly the content the naive `best.prompt.length`
    // heuristic ignored.
    const devTextChars = SAMPLE_DEV.reduce(
      (acc, s) => acc + s.input.length + (s.expected_output?.length ?? 0),
      0,
    );
    expect(est).toBeGreaterThan(baseState.best.prompt.length + devTextChars);
  });

  test("createClaudeMutationProvider factory yields an equivalent provider", async () => {
    const adapter = mockAdapter(
      `{"rewrite": "Be concise and exact.", "rationale": "Tightens the instruction."}`,
    );
    const provider = createClaudeMutationProvider({
      adapter,
      model: "claude-sonnet-4-5",
      maxTokens: 1024,
    });
    expect(provider).toBeInstanceOf(ClaudeMutationProvider);
    expect(provider.name).toBe("claude");
    expect(provider.modelId).toBe("claude-sonnet-4-5");
    expect(provider.maxOutputTokens).toBe(1024);
    // Behaves like the directly-constructed provider end-to-end.
    const result = await provider.next(baseState);
    expect(result.prompt).toBe("Be concise and exact.");
  });

  test("estimateInputChars grows with the dev-set failure window", () => {
    const wideDev: ReadonlyArray<Sample> = [
      ...SAMPLE_DEV,
      { id: "d3", input: "x".repeat(5_000), expected_output: "y".repeat(5_000) },
      { id: "d4", input: "z".repeat(5_000), expected_output: "w".repeat(5_000) },
    ];
    const provider = new ClaudeMutationProvider({
      adapter: mockAdapter(""),
      model: "claude-sonnet-4-5",
      maxFailuresInPrompt: 4,
    });
    const narrow = provider.estimateInputChars(baseState);
    const wide = provider.estimateInputChars({ ...baseState, devSet: wideDev });
    // A larger window serializes more failure text → a larger input estimate,
    // exactly the case the original prompt-only heuristic under-counted.
    expect(wide).toBeGreaterThan(narrow + 18_000);
  });
});

describe("ClaudeMutationProviderError", () => {
  test("carries the adapter code, stable name, and cause chain", () => {
    const cause = new Error("stream aborted");
    const err = new ClaudeMutationProviderError("mutation provider failed", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClaudeMutationProviderError");
    expect(err.code).toBe("adapter");
    expect(err.message).toBe("mutation provider failed");
    expect(err.cause).toBe(cause);
    expect(err.toJSON()).toMatchObject({
      name: "ClaudeMutationProviderError",
      code: "adapter",
      message: "mutation provider failed",
      cause: { name: "Error", message: "stream aborted" },
    });
  });

  test("constructs without a cause", () => {
    const err = new ClaudeMutationProviderError("no cause");
    expect(err.cause).toBeUndefined();
  });
});
