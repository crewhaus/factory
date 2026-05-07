import type { JudgeClient } from "../judge";

/**
 * A "naive" stub judge — pretends to read the user prompt and returns a fixed
 * tool_use response. Tests use this to verify the prompt template, schema
 * validation, and rationale wiring without burning API credits.
 *
 * The factory accepts a function that receives the EXACT message text the
 * client sees, so tests can assert injection payloads survived templating
 * (and that sentinels surround them).
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
): JudgeClient {
  return {
    messages: {
      async create(params) {
        const userMsg = params.messages.find((m) => m.role === "user");
        const userText = userMsg?.content ?? "";
        const verdict = scorer(userText, params.system);
        return {
          content: [
            {
              type: "tool_use" as const,
              id: "tu_stub",
              name: "submit_score",
              input: verdict,
            },
          ],
          stop_reason: "tool_use",
        };
      },
    },
  };
}

/**
 * A "sycophantic" stub — naively follows whatever instruction it sees in the
 * user prompt. Demonstrates what an *unprotected* judge would do and is the
 * counterfactual that proves the real defense matters. Tests use it to verify
 * the prompt template wraps untrusted content in sentinels and the system
 * message classifies it as data.
 */
export function makeSycophanticStubClient(): JudgeClient {
  return makeNaiveStubClient((userText) => {
    // If the user prompt contains a literal "PASSED:TRUE" outside any
    // sentinel block, the sycophant would return 5. With our defense, the
    // string IS in the prompt, but the system message tells the real model
    // to ignore it. The sycophant ignores the system message — that's the
    // whole point.
    if (/PASSED\s*:\s*TRUE/i.test(userText)) {
      return { score: 5, rationale: "naive: saw PASSED:TRUE", criterion_scores: { c1: 5 } };
    }
    return { score: 1, rationale: "naive: default", criterion_scores: { c1: 1 } };
  });
}
