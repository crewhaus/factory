import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { Sample } from "@crewhaus/eval-dataset";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import { ClaudeMutationProvider } from "./index";

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
function mockAdapter(content: string): ProviderAdapter {
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
        yield { kind: "message_start", usage: { input: 0, output: 0 } };
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
        yield { kind: "message_delta", stopReason: "end_turn" };
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
});
