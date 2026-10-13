/**
 * The grounding reply's fenced block is found with two searches.
 *
 * `/```(?:json)?\s*([\s\S]*?)\s*```/` tried every end of its lazy body and
 * rescanned the whitespace after each, from every start, in a reply that
 * opened a fence and never closed it: cubic in a run of whitespace, in a
 * reply from a model that read an untrusted page. Now the first fence and
 * the next one after it are each one `indexOf`.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { Driver } from "@crewhaus/computer-use-driver";
import { fencedBody } from "./fence";
import { createFindElementTool } from "./index.js";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. Counted, not timed: the machine's speed
 * decides nothing.
 */
async function regexRunsOver<T>(
  run: string,
  body: () => Promise<T>,
  allowed: ReadonlyArray<string> = [],
): Promise<{ runs: string[]; outcome: T | Error }> {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run)) {
      const seen = `/${this.source}/`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: await body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    out.push(...layer);
  }
  return out;
}

/** `[input, output]` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

// The pattern as it was.
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)\s*```/;

test("fencedBody finds what the pattern captured", () => {
  const inputs = [
    ...allJoins(["```", "`", "json", "js", " ", "\n", "x", "{}"], 5),
    '```json\n{"bbox":{}}\n```',
    "text ```  a b  ``` more ```c```",
    "````x```",
    "``````",
  ];
  // Every code unit, in each place the pattern reads.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    inputs.push(
      `\`\`\`${ch}x\`\`\``,
      `\`\`\`json${ch}\`\`\``,
      `\`\`\` x${ch}\`\`\``,
      `${ch}\`\`\`\`\``,
    );
  }
  expect(answers(inputs, fencedBody)).toEqual(answers(inputs, (s) => FENCE_RE.exec(s)?.[1]));
}, 30_000);

describe("no pattern rescans a run in a grounding reply", () => {
  const run = " ".repeat(100_000);
  const driver: Driver = {
    backend: "chromium",
    async connect() {},
    async goto() {},
    async screenshot() {
      return new Uint8Array([0x89]);
    },
    async click() {},
    async type() {},
    async key() {},
    async scroll() {},
    async getViewport() {
      return { width: 800, height: 600, devicePixelRatio: 1 };
    },
    async disconnect() {},
  };
  const replying = (reply: string): ProviderAdapter => ({
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
  });
  const find = (reply: string) =>
    createFindElementTool({ driver, model: "stub", _adapter: replying(reply) }).execute(
      { description: "the Submit button" },
      {},
    );

  test("the old pattern did", async () => {
    // Control: the hook sees the old pattern run over the run.
    const reply = `\`\`\`${run}`;
    expect((await regexRunsOver(run, async () => FENCE_RE.exec(reply))).runs).toEqual([
      `/${FENCE_RE.source}/`,
    ]);
  });

  test("a fence opened before a run and never closed", async () => {
    const box = '{"bbox":{"x":1,"y":2,"width":3,"height":4},"confidence":"high"}';
    // With a JSON object after the run, the reply is read as raw JSON.
    const found = await regexRunsOver(run, () => find(`\`\`\`json${run}${box}`));
    expect(found.runs).toEqual([]);
    expect(JSON.parse(String(found.outcome)).bbox).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    // With nothing after it, the reply has no JSON block, as before.
    const missing = await regexRunsOver(run, () => find(`\`\`\`${run}`));
    expect(missing.runs).toEqual([]);
    expect(String(missing.outcome)).toContain("had no JSON block");
  });
});
