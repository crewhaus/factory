/**
 * model-reply-text.ts replaces patterns that rescanned a run of a model's
 * reply from every position in it. Each helper must answer exactly what its
 * pattern answered, and reading a long run must not run a pattern over it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import { readExperienceStore } from "@crewhaus/meta-harness-optimizer";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import { extractReqMappingLines } from "./init-conversation";
import { createMetaHarnessProposer } from "./meta-harness-mutator";
import { firstObjectSpan, mapsARequirement } from "./model-reply-text";
import { parseRedteamVariants } from "./redteam";
import { parseModelSampleInputs } from "./scaffold-evals";

const OBJECT = /\{[\s\S]*\}/;
const MAPPING = /REQ-\d+.*(?:→|->)/;

/** Every concatenation of up to `depth` of `pieces`, `visit`ed; returns how many. */
function everyText(pieces: readonly string[], depth: number, visit: (t: string) => void): number {
  let count = 0;
  const walk = (text: string, d: number): void => {
    visit(text);
    count++;
    if (d === depth) return;
    for (const p of pieces) walk(text + p, d + 1);
  };
  walk("", 0);
  return count;
}

/** `n` seeded pseudo-random concatenations of 1 to `maxPieces` of `pieces`. */
function randomTexts(pieces: readonly string[], n: number, maxPieces: number): string[] {
  let seed = 0x9e3779b9;
  const next = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % bound;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    const length = 1 + next(maxPieces);
    for (let k = 0; k < length; k++) text += pieces[next(pieces.length)];
    out.push(text);
  }
  return out;
}

/**
 * Runs `body` with every regular expression run over a text holding `run`
 * refused on the spot and recorded. Replacing `RegExp.prototype.exec` routes
 * every String and RegExp method that runs a pattern through it (the controls
 * below check that for `String#match` and `RegExp#test`); restored after.
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

function replying(text: string): ProviderAdapter {
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
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { kind: "message_start", usage: { input: 1, output: 0 } } as StreamEvent;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as StreamEvent;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        } as StreamEvent;
        yield { kind: "content_block_stop", index: 0 } as StreamEvent;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 1, output: 1 },
        } as StreamEvent;
        yield { kind: "message_stop" } as StreamEvent;
      })(),
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("each helper answers what its pattern answered", () => {
  test("firstObjectSpan", () => {
    const differ: string[] = [];
    const checked = everyText(["{", "}", "a", "\n"], 8, (t) => {
      if (firstObjectSpan(t) !== (t.match(OBJECT)?.[0] ?? null)) differ.push(t);
    });
    expect(differ).toEqual([]);
    expect(checked).toBe((4 ** 9 - 1) / 3);
  }, 20_000);

  test("mapsARequirement", () => {
    const pieces = ["REQ-", "1", "→", "-", ">", "->", "\n", "\r", "\u2028", "x", " "];
    const differ: string[] = [];
    const visit = (t: string): void => {
      if (mapsARequirement(t) !== MAPPING.test(t)) differ.push(t);
    };
    const checked = everyText(pieces, 5, visit);
    for (const t of randomTexts(pieces, 20_000, 16)) visit(t);
    for (const t of [
      "REQ-001 → agent.instructions",
      "- REQ-002 -> tools.Read",
      "REQ-1->x",
      "REQ-x → nothing",
      "→ REQ-3",
      "REQ-REQ-4 →",
      "REQ-5\n→",
      "REQ-6\u2029->",
      "REQ-7 - > split",
    ]) {
      visit(t);
    }
    expect(differ).toEqual([]);
    expect(checked).toBe((11 ** 6 - 1) / 10);
  }, 20_000);
});

// Counted, not timed: the only place quadratic work could hide in reading a
// reply is a pattern run over it, so each one is refused and recorded.
describe("a reply holding a long run", () => {
  test("a run of { is not a JSON object, and no pattern reads it", async () => {
    const run = "{".repeat(10_000);
    const reply = "{".repeat(1_000_000);
    // Control: the hook sees the pattern String#match runs.
    expect((await patternsOver(run, () => reply.match(OBJECT))).refused).toEqual([
      `/${OBJECT.source}/`,
    ]);
    const samples = await patternsOver(run, () => parseModelSampleInputs(reply, 5));
    expect(samples.refused).toEqual([]);
    expect(samples.outcome).toEqual([]);
    const variants = await patternsOver(run, () => parseRedteamVariants(reply, 5));
    expect(variants.refused).toEqual([]);
    expect(variants.outcome).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "model-reply-text-"));
    tempDirs.push(dir);
    const state: OptimizerState = {
      iteration: 1,
      best: { id: "candidate-0", prompt: "BASE PROMPT", mutations: [], score: 0.4 },
      trajectory: [],
      trainSet: [],
      devSet: [],
    };
    const proposer = createMetaHarnessProposer({ adapter: replying(reply), modelId: "m" });
    const proposed = await patternsOver(run, () => proposer(readExperienceStore(dir), state));
    expect(proposed.refused).toEqual([]);
    expect(proposed.outcome).toMatchObject({
      bundleSource: "BASE PROMPT",
      rationale: "proposer returned no JSON object",
    });
  });

  test("a line of requirement ids, or one id with a long number, is read without a pattern", async () => {
    const reqs = "REQ-1".repeat(2_000);
    // Control: the hook sees the pattern RegExp#test runs.
    expect((await patternsOver(reqs, () => MAPPING.test(reqs))).refused).toEqual([
      `/${MAPPING.source}/`,
    ]);
    const message = (text: string): string =>
      JSON.stringify({ kind: "assistant_message", payload: { content: text } });
    const repeated = await patternsOver(reqs, () =>
      extractReqMappingLines(message(`${"REQ-1".repeat(200_000)}\nREQ-2 → tools.Read`)),
    );
    expect(repeated.refused).toEqual([]);
    expect(repeated.outcome).toEqual(["REQ-2 → tools.Read"]);
    const digits = "1".repeat(10_000);
    const long = await patternsOver(digits, () =>
      extractReqMappingLines(message(`REQ-${"1".repeat(1_000_000)}x`)),
    );
    expect(long.refused).toEqual([]);
    expect(long.outcome).toEqual([]);
  });
});
