/**
 * The rewrite's JSON is taken from the first `{` to the last `}` with
 * `indexOf`/`lastIndexOf`, not `/\{[\s\S]*\}/`, which scanned the rest of the
 * reply from every `{` and so took time quadratic in a run of them.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import { ClaudeMutationProvider } from "./index";
import { firstObjectSpan } from "./json-span";

/** What the pattern matched, the way `String#match` reported it. */
const byPattern = (text: string): string | null => text.match(/\{[\s\S]*\}/)?.[0] ?? null;

/**
 * Runs `body` with every regular expression run over a text holding `run`
 * refused on the spot and recorded. Replacing `RegExp.prototype.exec` routes
 * every String and RegExp method that runs a pattern through it (the control
 * below checks that for `String#match`); restored after.
 */
async function patternsOver<T>(
  run: string,
  body: () => T | Promise<T>,
): Promise<{ refused: string[]; outcome: T | Error }> {
  const refused: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run)) {
      refused.push(`/${this.source}/`);
      throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { refused, outcome: await body() };
  } catch (err) {
    return { refused, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** An adapter that answers with one text block holding `content`. */
function replying(content: string): ProviderAdapter {
  return {
    id: "mock",
    features: { caching: "none", thinking: false, multimodal: { input: false, output: false } },
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    stream(_params: any): AsyncIterable<any> {
      return (async function* () {
        yield { kind: "message_start", usage: { input: 0, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: content },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output: 0 } };
        yield { kind: "message_stop" };
      })();
    },
  } as unknown as ProviderAdapter;
}

const STATE: OptimizerState = {
  iteration: 1,
  best: { id: "candidate-0", prompt: "You are a helpful assistant.", mutations: [], score: 0.4 },
  trajectory: [],
  trainSet: [{ id: "t1", input: "What is 2+2?", expected_output: "4" }],
  devSet: [{ id: "d1", input: "What is 3+3?", expected_output: "6" }],
};

describe("firstObjectSpan", () => {
  test("takes what the pattern took", () => {
    const cases = [
      "",
      "no braces",
      "{}",
      '{"a":1}',
      'Here you go:\n```json\n{"a": {"b": 2}}\n```\nDone.',
      "{",
      "}",
      "}{",
      "} {a}",
      "{a} {b}",
      "{{{",
      "}}}",
      "{{a}",
      "{a}}",
      "{\n}",
      "x{é😀}y",
      `${"{".repeat(50)}x`,
      `${"{".repeat(50)}}`,
    ];
    for (const text of cases) {
      expect(`${JSON.stringify(text)} → ${firstObjectSpan(text)}`).toBe(
        `${JSON.stringify(text)} → ${byPattern(text)}`,
      );
    }
  });

  test("agrees with the pattern on every text of up to eight characters from {, }, a and a newline", () => {
    const alphabet = ["{", "}", "a", "\n"];
    let checked = 0;
    const differ: string[] = [];
    const visit = (text: string): void => {
      if (firstObjectSpan(text) !== byPattern(text)) differ.push(text);
      checked++;
      if (text.length === 8) return;
      for (const c of alphabet) visit(text + c);
    };
    visit("");
    expect(differ).toEqual([]);
    expect(checked).toBe((4 ** 9 - 1) / 3);
  }, 20_000);
});

// Counted, not timed: the only place quadratic work could hide in reading
// the reply is a pattern run over it, so each one is refused and recorded.
describe("a reply that is a long run of {", () => {
  test("falls back to the current best without a pattern over the reply", async () => {
    const run = "{".repeat(10_000);
    const reply = "{".repeat(1_000_000);
    // Control: the hook sees the pattern String#match runs.
    expect((await patternsOver(run, () => byPattern(reply))).refused).toEqual([
      "/\\{[\\s\\S]*\\}/",
    ]);
    const provider = new ClaudeMutationProvider({ adapter: replying(reply), model: "m" });
    const next = await patternsOver(run, () => provider.next(STATE));
    expect(next.refused).toEqual([]);
    expect(next.outcome).toMatchObject({ prompt: STATE.best.prompt, mutations: [] });
    expect((next.outcome as { rationale: string }).rationale).toBe(
      "claude-fallback: model response did not contain a JSON object",
    );
  });
});
