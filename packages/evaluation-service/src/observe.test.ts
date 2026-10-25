/**
 * `observeProofBundles` — one run's observer composed onto the shared gate
 * (design §5.4: the managed gateway returns the bundle of THAT run's final
 * turn). Pinned: identity when there is nothing to compose, both observers
 * see every bundle in order, a throwing gate observer does not blind the
 * run's, and the composed gate run through `runChatLoop` hands the run the
 * standing pass of a retried turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ProofBundle } from "@crewhaus/provability";
import { type RunProvability, runChatLoop } from "@crewhaus/runtime-core";
import { config, tempDirs } from "./__fixtures__/helpers";
import { observeProofBundles } from "./observe";
import { buildRunProvability } from "./provability";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const bundle = (verdict: ProofBundle["verdict"], retryIndex: number): ProofBundle =>
  ({ version: 1, verdict, retryIndex, bundleHash: `h${retryIndex}` }) as unknown as ProofBundle;

const gate = (onBundle?: RunProvability["onBundle"]): RunProvability => ({
  level: "cited",
  onFail: "retry",
  maxRetries: 1,
  threshold: 1,
  render: "none",
  verify: async () => bundle("pass", 0),
  nudge: () => "cite it",
  ...(onBundle !== undefined ? { onBundle } : {}),
});

describe("observeProofBundles", () => {
  test("identity without an observer, and without a gate", () => {
    const shared = gate();
    expect(observeProofBundles(shared, undefined)).toBe(shared);
    expect(observeProofBundles(undefined, () => {})).toBeUndefined();
  });

  test("the gate's own observer runs first, then the run's, with the bundle and its path", () => {
    const seen: string[] = [];
    const composed = observeProofBundles(
      gate((b, path) => seen.push(`gate:${b.bundleHash}:${path}`)),
      (b, path) => seen.push(`run:${b.bundleHash}:${path}`),
    );
    composed?.onBundle?.(bundle("fail", 0), "/p/turn-1.json");
    composed?.onBundle?.(bundle("pass", 1), undefined);
    expect(seen).toEqual([
      "gate:h0:/p/turn-1.json",
      "run:h0:/p/turn-1.json",
      "gate:h1:undefined",
      "run:h1:undefined",
    ]);
  });

  test("a gate without an onBundle: the run's observer alone", () => {
    const seen: string[] = [];
    const composed = observeProofBundles(gate(), (b) => seen.push(b.bundleHash));
    composed?.onBundle?.(bundle("pass", 0));
    expect(seen).toEqual(["h0"]);
  });

  test("a throwing gate observer still lets the run see the bundle, then rethrows", () => {
    const seen: string[] = [];
    const composed = observeProofBundles(
      gate(() => {
        throw new Error("gate observer broke");
      }),
      (b) => seen.push(b.bundleHash),
    );
    expect(() => composed?.onBundle?.(bundle("pass", 0))).toThrow("gate observer broke");
    expect(seen).toEqual(["h0"]);
  });

  test("everything else on the gate is the shared gate's (one wiring, many runs)", () => {
    const shared = gate();
    const composed = observeProofBundles(shared, () => {});
    expect(composed?.verify).toBe(shared.verify);
    expect(composed?.nudge).toBe(shared.nudge);
    expect([composed?.level, composed?.onFail, composed?.maxRetries]).toEqual([
      "cited",
      "retry",
      1,
    ]);
    // The shared gate itself is untouched.
    expect(shared.onBundle).toBeUndefined();
  });

  test("through runChatLoop: a retried turn hands the run every pass, the standing one last", async () => {
    const shared = buildRunProvability(config("cited", { onFail: "retry", render: "none" }), {
      specName: "bot",
      cwd: dirs.make(),
    });
    // Two observed passes: the uncited answer fails, the retry cites.
    const answers = [
      "Refunds take 14 days to settle on most cards.",
      "Refunds take 14 days to settle on most cards [1].\n\n[1]: https://acme.example/refunds",
    ];
    let call = 0;
    const seen: ProofBundle[] = [];
    const reply = await runChatLoop({
      model: "test-model",
      instructions: "answer",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "how long do refunds take?" }],
      installSigintHandler: false,
      persistSession: false,
      stdout: () => {},
      provability: observeProofBundles(shared, (b) => seen.push(b)),
      _adapter: {
        providerId: "anthropic",
        features: {
          caching: "explicit",
          tool_use: true,
          vision: true,
          thinking: true,
          web_search: true,
        },
        estimateTokens: () => 0,
        stream: () => {
          const text = answers[Math.min(call++, answers.length - 1)] as string;
          return (async function* () {
            yield { kind: "message_start" } as const;
            yield {
              kind: "content_block_start",
              index: 0,
              block: { type: "text", text: "" },
            } as const;
            yield {
              kind: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            } as const;
            yield { kind: "content_block_stop", index: 0 } as const;
            yield { kind: "message_delta", stopReason: "end_turn" } as const;
            yield { kind: "message_stop" } as const;
          })();
        },
      } as unknown as NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>,
    });
    expect(reply).toBe(answers[1] as string);
    expect(seen.map((b) => [b.verdict, b.retryIndex])).toEqual([
      ["fail", 0],
      ["pass", 1],
    ]);
  });
});
