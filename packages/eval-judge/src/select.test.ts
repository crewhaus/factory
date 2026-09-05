/**
 * 0.6.0 §7.6 — N-way selection judging for the committee: positional labels
 * (ids never reach the judge), fresh sentinels around every untrusted block,
 * pinned decoding, and the order-reversal control — a pick that flips with
 * the presentation order is position bias and yields NO winner.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { makeSelectStubClient } from "./__test__/stub-client";
import { JudgeError, buildSelectPrompt, judgeSelect } from "./index";

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

const CANDIDATES = [
  { id: "cheap", output: "The answer is 4." },
  { id: "mid", output: "It might be 5." },
  { id: "strong", output: "2 + 2 = 4, because addition of two pairs yields four." },
];

/** Pick the response whose block contains `needle`, by positional number. */
function pickContaining(
  needle: string,
): (userText: string) => { winner: string; rationale: string } {
  return (userText) => {
    const m = [
      ...userText.matchAll(/Response (\d+) <<<UNTRUSTED_[0-9a-f]+>>>\n([\s\S]*?)\n<<<END_/g),
    ];
    const hit = m.find((x) => (x[2] ?? "").includes(needle));
    return { winner: hit?.[1] ?? "1", rationale: `picked the one with ${needle}` };
  };
}

describe("buildSelectPrompt", () => {
  test("wraps input, expected output and every candidate in the per-call sentinel with positional labels", () => {
    const p = buildSelectPrompt({
      input: "What is 2+2?",
      expectedOutput: "4",
      outputs: CANDIDATES.map((c) => c.output),
    });
    expect(p.labels).toEqual(["1", "2", "3"]);
    const open = `<<<UNTRUSTED_${p.sentinel}>>>`;
    // input + expected + three candidates = five wrapped blocks.
    expect(p.user.split(open)).toHaveLength(6);
    expect(p.user).toContain("Response 1");
    expect(p.user).toContain("Response 3");
    expect(p.user).not.toContain("cheap");
    expect(p.system).toContain("DATA");
    expect(p.system).toContain("ARBITRARY");
    expect(p.system).toContain("submit_selection");
  });

  test("refuses fewer than two candidates", () => {
    expect(() => buildSelectPrompt({ input: "q", outputs: ["only"] })).toThrow(JudgeError);
  });
});

describe("judgeSelect", () => {
  test("a content-aware judge agrees across both orders and names the winner by id; two metered calls", async () => {
    const { adapter, requests } = withCapture(makeSelectStubClient(pickContaining("because")));
    const bus = new TraceEventBus({ runId: "run_00000001", sessionId: "sess_0000000000000001" });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    const v = await judgeSelect({
      input: "What is 2+2?",
      candidates: CANDIDATES,
      adapter,
      model: "claude-opus-4-1",
      bus,
      role: "judge",
      stage: "committee",
    });
    expect(v.agreed).toBe(true);
    expect(v.winner).toBe("strong");
    expect(v.forward.order).toEqual(["cheap", "mid", "strong"]);
    expect(v.reversed.order).toEqual(["strong", "mid", "cheap"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.toolChoice).toEqual({ type: "tool", name: "submit_selection" });
    // The enum on the forced tool is the positional label set.
    const schema = requests[0]?.tools?.[0]?.input_schema as {
      properties?: { winner?: { enum?: string[] } };
    };
    expect(schema.properties?.winner?.enum).toEqual(["1", "2", "3"]);
    // Two sentinels, both fresh.
    const s1 = /UNTRUSTED_([0-9a-f]{12})/.exec(requests[0]?.system[0]?.text ?? "")?.[1];
    const s2 = /UNTRUSTED_([0-9a-f]{12})/.exec(requests[1]?.system[0]?.text ?? "")?.[1];
    expect(s1).toBeDefined();
    expect(s1).not.toBe(s2);
    // Metered on the bus: one model_request + model_response per order, role judge, stage committee.
    const responses = seen.filter((e) => e.kind === "model_response");
    expect(responses).toHaveLength(2);
    expect((responses[0] as { role?: string }).role).toBe("judge");
    expect((responses[0] as { stage?: string }).stage).toBe("committee");
    expect(v.usage).toHaveLength(2);
    expect(v.usage[0]?.output).toBe(5);
  });

  test("a position-biased judge (always response 1) disagrees across orders — no winner", async () => {
    const adapter = makeSelectStubClient(() => ({ winner: "1", rationale: "first is best" }));
    const v = await judgeSelect({ input: "q", candidates: CANDIDATES, adapter, model: "m" });
    expect(v.agreed).toBe(false);
    expect(v.winner).toBeUndefined();
    expect(v.forward.winner).toBe("cheap");
    expect(v.reversed.winner).toBe("strong");
  });

  test("rejects an out-of-range or malformed verdict and duplicate ids", async () => {
    const bad = makeSelectStubClient(() => ({ winner: "9", rationale: "?" }));
    await expect(
      judgeSelect({ input: "q", candidates: CANDIDATES, adapter: bad, model: "m" }),
    ).rejects.toThrow(JudgeError);
    const first = CANDIDATES[0] as (typeof CANDIDATES)[number];
    await expect(
      judgeSelect({
        input: "q",
        candidates: [first, first],
        adapter: makeSelectStubClient(() => ({ winner: "1", rationale: "r" })),
        model: "m",
      }),
    ).rejects.toThrow(/unique/);
  });
});
