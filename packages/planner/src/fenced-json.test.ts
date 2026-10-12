/**
 * The planner reads its fenced JSON with `indexOf`, not
 * `/```(?:json)?\s*([\s\S]*?)\s*```/`, which was cubic in a run of whitespace
 * after an unclosed fence.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { fencedJson } from "./fenced-json";
import { PlannerError, decompose } from "./index.js";

/** What the planner took from the pattern: the capture, trimmed, when it was not empty. */
const byPattern = (text: string): string | undefined => {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m?.[1] ? m[1].trim() : undefined;
};

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

function replying(reply: string): ProviderAdapter {
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
    stream: () =>
      (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start" };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn" };
        yield { kind: "message_stop" };
      })(),
  };
}

describe("fencedJson", () => {
  test("reads what the pattern read", () => {
    const cases = [
      "",
      "no fence",
      '```json\n{"subQuestions":["a"]}\n```',
      '```\n{"a":1}\n```',
      'prose first\n```json\n  {"a":1}  \n```\nprose after',
      "```json```",
      "```json \n ```",
      "``````",
      "```",
      "````",
      "`````",
      "```js```",
      "```jsonx```",
      "````json\n{}\n```",
      "```json\n{}\n```\n```json\n[]\n```",
      "```\u00a0x\u3000```",
      "```é😀```",
      `\`\`\`${" ".repeat(50)}x`,
      `\`\`\`json${"\n".repeat(50)}\`\``,
    ];
    for (const text of cases) {
      expect(`${JSON.stringify(text)} → ${JSON.stringify(fencedJson(text) || undefined)}`).toBe(
        `${JSON.stringify(text)} → ${JSON.stringify(byPattern(text))}`,
      );
    }
  });

  test("agrees with the pattern on every text of up to seven pieces from `, a space, a newline, x and json", () => {
    const pieces = ["`", " ", "\n", "x", "json"];
    let checked = 0;
    const differ: string[] = [];
    const visit = (text: string, depth: number): void => {
      if ((fencedJson(text) || undefined) !== byPattern(text)) differ.push(text);
      checked++;
      if (depth === 7) return;
      for (const p of pieces) visit(text + p, depth + 1);
    };
    visit("", 0);
    expect(differ).toEqual([]);
    expect(checked).toBe((5 ** 8 - 1) / 4);
  }, 20_000);
});

// Counted, not timed: the only place super-linear work could hide in reading
// the reply is a pattern run over it, so each one is refused and recorded.
describe("a reply with an unclosed fence and a long run of whitespace", () => {
  test("is refused without a pattern over the reply", async () => {
    const run = " ".repeat(10_000);
    const reply = `\`\`\`json${" ".repeat(1_000_000)}x`;
    // Control: the hook sees the pattern String#match runs.
    expect((await patternsOver(run, () => byPattern(reply))).refused).toEqual([
      "/```(?:json)?\\s*([\\s\\S]*?)\\s*```/",
    ]);
    const planned = await patternsOver(run, () =>
      decompose("a goal", { model: "m", _adapter: replying(reply) }),
    );
    expect(planned.refused).toEqual([]);
    expect(planned.outcome).toBeInstanceOf(PlannerError);
    expect((planned.outcome as Error).message).toContain("could not locate JSON block");
  });
});
