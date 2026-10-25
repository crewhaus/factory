import { describe, expect, test } from "bun:test";
import { recordingBus, scriptedJudge } from "./__fixtures__/helpers";
import { WAIVER_RUBRIC, WAIVER_SUPPORTED, createWaiverJudge } from "./judge";

const INPUT = {
  claim: "Unused items can be refunded within fourteen days.",
  excerpt: "Refunds are accepted within 14 days of purchase for unused items.",
  source: "https://acme.example/policy",
};

describe("createWaiverJudge", () => {
  test("a 'supported' label waives; the wire model and priced spend come back", async () => {
    const { adapter } = scriptedJudge(() => ({ label: "supported", rationale: "same facts" }));
    const waive = createWaiverJudge({ judge: { model: "claude-haiku-4-5" }, adapter });
    const verdict = await waive(INPUT);
    expect(verdict.supported).toBe(true);
    expect(verdict.model).toBe("claude-haiku-4-5");
    expect(typeof verdict.costUsdMicros).toBe("number");
  });

  test("'not_supported' and an abstention are both a no", async () => {
    for (const answer of [
      { label: "not_supported", rationale: "differs" },
      { label: "supported", rationale: "unsure", abstain: true },
    ]) {
      const { adapter } = scriptedJudge(() => answer);
      expect((await createWaiverJudge({ judge: { model: "m" }, adapter })(INPUT)).supported).toBe(
        false,
      );
    }
  });

  test("a label outside the vocabulary is a judge failure (thrown — the verifier reads it as no waiver)", async () => {
    const { adapter } = scriptedJudge(() => ({ label: "probably", rationale: "x" }));
    await expect(createWaiverJudge({ judge: { model: "m" }, adapter })(INPUT)).rejects.toThrow();
  });

  test("temperature is pinned to 0 over a profile's own; the other params apply", async () => {
    const { adapter, requests } = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    await createWaiverJudge({
      judge: { model: "m", params: { temperature: 0.7, maxTokens: 256 } },
      adapter,
    })(INPUT);
    expect(requests[0]).toMatchObject({ temperature: 0, maxTokens: 256, tool: "submit_label" });
    const plain = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    await createWaiverJudge({
      judge: { model: "m", params: { temperature: 0.7 } },
      adapter: plain.adapter,
    })(INPUT);
    expect(plain.requests[0]?.temperature).toBe(0);
  });

  test("publishes on the bus as role judge; claim and passage ride the sentinel-wrapped blocks", async () => {
    const { adapter, requests } = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    const { bus, events } = recordingBus();
    await createWaiverJudge({ judge: { model: "claude-haiku-4-5" }, adapter, bus })(INPUT);
    expect(events.map((e) => [e.kind, (e as { role?: string }).role])).toEqual([
      ["model_request", "judge"],
      ["model_response", "judge"],
    ]);
    const prompt = requests[0]?.user ?? "";
    const sentinel = /<<<UNTRUSTED_([0-9a-f]+)>>>/.exec(prompt)?.[1] as string;
    const inside = (marker: string) => {
      const start = prompt.indexOf(`${marker} <<<UNTRUSTED_${sentinel}>>>`);
      const end = prompt.indexOf(`<<<END_${sentinel}>>>`, start);
      return prompt.slice(start, end);
    };
    expect(inside("Sample input")).toContain(INPUT.excerpt);
    expect(inside("Sample input")).toContain(INPUT.source);
    expect(inside("Agent output")).toContain(INPUT.claim);
    // The judge classifies; it is never shown which label passes.
    expect(requests[0]?.system).not.toContain("passing");
  });

  test("past the judge share: no call, a no — and a share read that throws cannot say it is spent", async () => {
    const { adapter, requests } = scriptedJudge(() => ({ label: "supported", rationale: "x" }));
    const { bus, events } = recordingBus();
    const skipped = await createWaiverJudge({
      judge: { model: "m" },
      adapter,
      bus,
      exhausted: () => true,
    })(INPUT);
    expect(skipped).toEqual({ supported: false });
    expect(requests).toEqual([]);
    expect(events).toEqual([]);
    const asked = await createWaiverJudge({
      judge: { model: "m" },
      adapter,
      exhausted: () => {
        throw new Error("meter gone");
      },
    })(INPUT);
    expect(asked.supported).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("the rubric is a valid two-label categorical rubric with one passing label", () => {
    expect(WAIVER_RUBRIC.labels.map((l) => l.name)).toEqual([WAIVER_SUPPORTED, "not_supported"]);
    expect(WAIVER_RUBRIC.passing_labels).toEqual([WAIVER_SUPPORTED]);
  });
});
