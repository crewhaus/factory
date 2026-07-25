/**
 * A1 — pairwise (battle) judging: prompt structure (fresh sentinels
 * wrapping BOTH outputs each call), strict verdict schema, pinned
 * decoding, and the order-swap bookkeeping — a verdict that flips with the
 * presentation order is position bias and must consolidate to a tie,
 * never a win.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { makePairwiseStubClient } from "./__test__/stub-client";
import { JudgeError, buildPairwisePrompt, judgePair, judgePairwise } from "./index";

/** Wrap an adapter to record every ProviderRequest (order preserved). */
function withCapture(adapter: ProviderAdapter): {
  adapter: ProviderAdapter;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const baseStream = adapter.stream.bind(adapter);
  return {
    requests,
    adapter: {
      ...adapter,
      stream: (req: ProviderRequest) => {
        requests.push(req);
        return baseStream(req);
      },
    },
  };
}

function userTextOf(req: ProviderRequest): string {
  const msg = req.messages.find((m) => m.role === "user");
  return typeof msg?.content === "string"
    ? msg.content
    : (msg?.content
        ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n") ?? "");
}

describe("buildPairwisePrompt (A1)", () => {
  test("wraps input, expected output, and BOTH candidate outputs in the per-call sentinel", () => {
    const p = buildPairwisePrompt({
      input: "What is 2+2?",
      expectedOutput: "4",
      outputA: "It is 4.",
      outputB: "Probably 5?",
    });
    expect(p.sentinel).toMatch(/^[0-9a-f]{12}$/);
    const open = `<<<UNTRUSTED_${p.sentinel}>>>`;
    const close = `<<<END_${p.sentinel}>>>`;
    // One sentinel-wrapped block per untrusted field: input, expected, A, B.
    expect(p.user.split(open)).toHaveLength(5);
    expect(p.user.split(close)).toHaveLength(5);
    expect(p.user).toContain("Response A");
    expect(p.user).toContain("Response B");
    expect(p.user).toContain("It is 4.");
    expect(p.user).toContain("Probably 5?");
    // System prompt classifies untrusted content and counters position bias.
    expect(p.system).toContain("DATA");
    expect(p.system).toContain("ARBITRARY");
    expect(p.system).toContain("submit_comparison");
  });

  test("omits the expected section when no expected output is supplied", () => {
    const p = buildPairwisePrompt({ input: "q", outputA: "a", outputB: "b" });
    expect(p.user).toContain("no expected output supplied");
  });

  test("two calls mint different sentinels", () => {
    const args = { input: "q", outputA: "a", outputB: "b" };
    expect(buildPairwisePrompt(args).sentinel).not.toBe(buildPairwisePrompt(args).sentinel);
  });
});

describe("judgePair (A1)", () => {
  test("returns the stub's verdict and pins temperature 0 by default", async () => {
    const { adapter, requests } = withCapture(
      makePairwiseStubClient(() => ({ winner: "a", rationale: "A is sharper" })),
    );
    const verdict = await judgePair({
      input: "q",
      outputA: "alpha",
      outputB: "beta",
      adapter,
    });
    expect(verdict.winner).toBe("a");
    expect(verdict.rationale).toBe("A is sharper");
    expect(verdict.sentinel).toMatch(/^[0-9a-f]{12}$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.toolChoice).toEqual({ type: "tool", name: "submit_comparison" });
  });

  test("rejects a winner outside the strict enum", async () => {
    const adapter = makePairwiseStubClient(() => ({ winner: "c", rationale: "x" }) as never);
    await expect(judgePair({ input: "q", outputA: "a", outputB: "b", adapter })).rejects.toThrow(
      JudgeError,
    );
  });

  test("rejects when the judge never calls submit_comparison", async () => {
    const adapter: ProviderAdapter = {
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
        (async function* () {
          yield { kind: "message_start" } as const;
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "I decline" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield { kind: "message_delta", stopReason: "end_turn" } as const;
          yield { kind: "message_stop" } as const;
        })(),
    };
    await expect(judgePair({ input: "q", outputA: "a", outputB: "b", adapter })).rejects.toThrow(
      /did not call submit_comparison/,
    );
  });
});

describe("judgePairwise — order-swap bookkeeping (A1)", () => {
  test("a content-consistent winner takes both orders and the verdict", async () => {
    // The stub prefers whichever response contains EXCELLENT — order-stable.
    const adapter = makePairwiseStubClient((userText) => {
      const aBlock = userText.slice(userText.indexOf("Response A"), userText.indexOf("Response B"));
      return aBlock.includes("EXCELLENT")
        ? { winner: "a", rationale: "A is excellent" }
        : { winner: "b", rationale: "B is excellent" };
    });
    const cmp = await judgePairwise({
      input: "q",
      prevOutput: "meh answer",
      newOutput: "EXCELLENT answer",
      adapter,
    });
    expect(cmp.prevFirst.winner).toBe("new");
    expect(cmp.newFirst.winner).toBe("new");
    expect(cmp.agreed).toBe(true);
    expect(cmp.verdict).toBe("new");
  });

  test("a position-biased judge (always A) disagrees across orders → tie, never a win", async () => {
    const adapter = makePairwiseStubClient(() => ({ winner: "a", rationale: "first looks best" }));
    const cmp = await judgePairwise({
      input: "q",
      prevOutput: "old",
      newOutput: "new",
      adapter,
    });
    // Order 1 (prev=A) names prev; order 2 (new=A) names new: pure position bias.
    expect(cmp.prevFirst.winner).toBe("prev");
    expect(cmp.newFirst.winner).toBe("new");
    expect(cmp.agreed).toBe(false);
    // The consolidated verdict MUST be a tie — a tie is never counted a win.
    expect(cmp.verdict).toBe("tie");
  });

  test("agreed ties stay ties", async () => {
    const adapter = makePairwiseStubClient(() => ({ winner: "tie", rationale: "comparable" }));
    const cmp = await judgePairwise({
      input: "q",
      prevOutput: "x",
      newOutput: "y",
      adapter,
    });
    expect(cmp.agreed).toBe(true);
    expect(cmp.verdict).toBe("tie");
  });

  test("each of the two calls gets fresh sentinels and the swapped order", async () => {
    const { adapter, requests } = withCapture(
      makePairwiseStubClient(() => ({ winner: "tie", rationale: "even" })),
    );
    await judgePairwise({
      input: "the question",
      prevOutput: "PREV_OUTPUT",
      newOutput: "NEW_OUTPUT",
      adapter,
    });
    expect(requests).toHaveLength(2);
    const [first, second] = requests.map((r) => userTextOf(r));
    // Call 1: prev is Response A; call 2: new is Response A (order swapped).
    expect((first as string).indexOf("PREV_OUTPUT")).toBeLessThan(
      (first as string).indexOf("NEW_OUTPUT"),
    );
    expect((second as string).indexOf("NEW_OUTPUT")).toBeLessThan(
      (second as string).indexOf("PREV_OUTPUT"),
    );
    // Fresh sentinel per call — the two prompts carry different markers.
    const sentinelOf = (text: string): string =>
      text.match(/<<<UNTRUSTED_([0-9a-f]{12})>>>/)?.[1] ?? "";
    expect(sentinelOf(first as string)).toMatch(/^[0-9a-f]{12}$/);
    expect(sentinelOf(first as string)).not.toBe(sentinelOf(second as string));
  });
});
