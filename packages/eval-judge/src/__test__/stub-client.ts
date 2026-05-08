import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";

/**
 * A "naive" stub judge — pretends to read the user prompt and returns
 * a fixed tool_use response. Tests use this to verify the prompt
 * template, schema validation, and rationale wiring without burning
 * API credits.
 *
 * The factory accepts a function that receives the EXACT message text
 * the adapter sees, so tests can assert injection payloads survived
 * templating (and that sentinels surround them).
 *
 * Section 17: this used to be a `JudgeClient` (custom shape with
 * `messages.create`). It is now a fully synthetic `ProviderAdapter`
 * yielding `StreamEvent`s — same coverage, multi-provider compatible.
 */
export function makeNaiveStubClient(
  scorer: (
    userText: string,
    systemText: string,
  ) => {
    score: 1 | 2 | 3 | 4 | 5;
    rationale: string;
    criterion_scores: Record<string, number>;
  },
): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream(req) {
      const userMsg = req.messages.find((m) => m.role === "user");
      const userText =
        typeof userMsg?.content === "string"
          ? userMsg.content
          : (userMsg?.content
              ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n") ?? "");
      const systemText = req.system.map((b) => b.text).join("\n\n");
      const verdict = scorer(userText, systemText);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu_stub", name: "submit_score", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(verdict) },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use" };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/**
 * A "sycophantic" stub — naively follows whatever instruction it sees
 * in the user prompt. Demonstrates what an *unprotected* judge would
 * do and is the counterfactual that proves the real defense matters.
 * Tests use it to verify the prompt template wraps untrusted content
 * in sentinels and the system message classifies it as data.
 */
export function makeSycophanticStubClient(): ProviderAdapter {
  return makeNaiveStubClient((userText) => {
    if (/PASSED\s*:\s*TRUE/i.test(userText)) {
      return { score: 5, rationale: "naive: saw PASSED:TRUE", criterion_scores: { c1: 5 } };
    }
    return { score: 1, rationale: "naive: default", criterion_scores: { c1: 1 } };
  });
}
