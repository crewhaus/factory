/**
 * 0.6.0 §6.2 (PR 13b) — the IN-LOOP judge panel.
 *
 * Before this PR every in-loop judge site made a single-model `judge()`
 * call, so `evaluation.grader.judges` / `repeats` / `temperature` / `target`
 * (and a `kind: judge` gate's identical four) lowered into the IR and did
 * nothing. These tests pin the wiring end to end over a stub adapter and a
 * real `TraceEventBus`: how many calls a declared panel makes, which model
 * each one names, how the median / strict-majority fold decides the verdict,
 * that `temperature` / `target` / a profile's pinned `params` reach the
 * provider request, and that EVERY call is metered with `role: "judge"`.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { gradeWithJudgePanel, inLoopRunResult } from "./in-loop";
import { loadRubric } from "./rubric";

const RUBRIC = loadRubric(`
criteria:
  - name: correctness
    description: The answer matches what was expected.
    anchors:
      "1": wrong
      "2": partial
      "3": ok
      "4": correct
      "5": correct and concise
passing_score: 4
`);

const SAMPLE = { id: "in-loop-evaluation", input: "" };

/** A stub judge whose verdict is chosen per WIRE MODEL, recording every request. */
function panelStub(scores: Record<string, number>): {
  adapter: ProviderAdapter;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
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
    stream(req: ProviderRequest) {
      requests.push(req);
      const score = scores[req.model];
      if (score === undefined) throw new Error(`stub has no verdict for ${req.model}`);
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { kind: "message_start", usage: { input: 10, output: 0 } };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "tool_use", id: "tu", name: "submit_score", input: {} },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              score,
              rationale: `verdict from ${req.model}`,
              criterion_scores: { correctness: score },
            }),
          },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "tool_use", usage: { input: 10, output: 5 } };
        yield { kind: "message_stop" };
      })();
    },
  };
  return { adapter, requests };
}

describe("gradeWithJudgePanel — a declared panel fans out (§6.2)", () => {
  test("one call per panelist; the median score and the strict-majority pass decide the verdict", async () => {
    const { adapter, requests } = panelStub({ "judge-a": 5, "judge-b": 4, "judge-c": 2 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "the answer" }),
      adapter,
      judges: ["judge-a", "judge-b", "judge-c"],
    });
    // N calls for N panelists, each naming its OWN model.
    expect(requests.map((r) => r.model)).toEqual(["judge-a", "judge-b", "judge-c"]);
    expect(verdict.calls).toBe(3);
    // Median of 5/4/2 is 4 → (4 − 1) / 4; votes 2/3 pass (passing_score 4).
    expect(verdict.score).toBeCloseTo(0.75);
    expect(verdict.passed).toBe(true);
    expect(verdict.panel?.panelists.map((p) => p.model)).toEqual(["judge-a", "judge-b", "judge-c"]);
    // The instrument identity names the whole panel — two panels are two
    // instruments, so a per-arm quality lineage keyed on it re-baselines.
    expect(verdict.judgeModel).toBe("judge-a+judge-b+judge-c");
  });

  test("a minority-pass panel fails even when the median clears the bar for one member", async () => {
    const { adapter } = panelStub({ "judge-a": 5, "judge-b": 2, "judge-c": 2 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      judges: ["judge-a", "judge-b", "judge-c"],
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.calls).toBe(3);
  });

  test("`repeats` makes an odd number of calls on ONE model", async () => {
    const { adapter, requests } = panelStub({ "solo-judge": 4 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: "solo-judge",
      repeats: 3,
    });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.model))).toEqual(new Set(["solo-judge"]));
    expect(verdict.calls).toBe(3);
    expect(verdict.judgeModel).toBe("solo-judge");
    expect(verdict.rationale).toContain("median of 3 repeats");
  });

  test("panel × repeats is k × m calls", async () => {
    const { adapter, requests } = panelStub({ "judge-a": 4, "judge-b": 4 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      judges: ["judge-a", "judge-b"],
      repeats: 3,
    });
    expect(requests).toHaveLength(6);
    expect(verdict.calls).toBe(6);
  });

  test("with no panel knobs it is ONE call on the declared model", async () => {
    const { adapter, requests } = panelStub({ "solo-judge": 5 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: "solo-judge",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.temperature).toBe(0);
    expect(requests[0]?.maxTokens).toBe(1024);
    expect(requests[0]?.thinking).toBeUndefined();
    expect(verdict.passed).toBe(true);
    expect(verdict.panel).toBeUndefined();
  });
});

describe("gradeWithJudgePanel — temperature / target / params reach the request", () => {
  test("`temperature` overrides the pinned 0 on every panel call", async () => {
    const { adapter, requests } = panelStub({ "judge-a": 4, "judge-b": 4 });
    await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      judges: ["judge-a", "judge-b"],
      temperature: 0.4,
    });
    expect(requests.map((r) => r.temperature)).toEqual([0.4, 0.4]);
  });

  test("`target: transcript` judges the projected trajectory, not the final text", async () => {
    const { adapter, requests } = panelStub({ "solo-judge": 4 });
    await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({
        finalText: "the final answer",
        messages: [
          { role: "user", content: "please read the file" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "reading it now" },
              { type: "tool_use", name: "Read", input: { path: "a.txt" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", content: "file body" }] },
          { role: "assistant", content: [{ type: "text", text: "the final answer" }] },
        ],
      }),
      adapter,
      model: "solo-judge",
      target: "transcript",
    });
    const userText = requests[0]?.messages[0]?.content;
    const text = typeof userText === "string" ? userText : JSON.stringify(userText);
    // The trajectory reached the judge — tool step and all.
    expect(text).toContain("Agent transcript");
    expect(text).toContain("[tool_use] Read");
    expect(text).toContain("please read the file");
    expect(text).not.toContain("(no transcript recorded)");
  });

  test("a judge slot's PROFILE params reach the request (max_tokens / thinking / temperature)", async () => {
    const { adapter, requests } = panelStub({ "solo-judge": 4 });
    await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: "solo-judge",
      params: { maxTokens: 4096, thinking: { effort: "low" } },
    });
    const req = requests[0];
    // The effort form sets BOTH controls (budget-style and native-effort
    // providers each read the one they support), and the ceiling is lifted
    // so the budget cannot crowd the verdict out.
    expect(req?.reasoningEffort).toBe("low");
    expect(req?.thinking?.type).toBe("enabled");
    expect(req?.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(req?.maxTokens).toBeGreaterThan(req?.thinking?.budgetTokens ?? 0);
  });

  test("a profile temperature overrides the judge's pin", async () => {
    const { adapter, requests } = panelStub({ "solo-judge": 4 });
    await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: "solo-judge",
      params: { temperature: 0.7 },
    });
    expect(requests[0]?.temperature).toBe(0.7);
  });
});

describe("gradeWithJudgePanel — metering (§6.2)", () => {
  test("every panelist and every repeat publishes its OWN role-judge request/response pair", async () => {
    const { adapter } = panelStub({ "judge-a": 4, "judge-b": 4 });
    const bus = new TraceEventBus({ runId: "run_panel", sessionId: "sess_panel" });
    const seen: TraceEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      judges: ["judge-a", "judge-b"],
      repeats: 3,
      bus,
    });
    const requests = seen.filter((e) => e.kind === "model_request");
    const responses = seen.filter((e) => e.kind === "model_response");
    expect(requests).toHaveLength(6);
    expect(responses).toHaveLength(6);
    // Every one of them is attributed to the judge role — that is what puts
    // the whole panel inside `budget.judge_share` rather than beside it.
    expect(requests.every((e) => (e as { role?: string }).role === "judge")).toBe(true);
    expect(responses.every((e) => (e as { role?: string }).role === "judge")).toBe(true);
    // …and each reports the model it actually called.
    const byModel = new Map<string, number>();
    for (const e of requests) {
      const m = (e as { model: string }).model;
      byModel.set(m, (byModel.get(m) ?? 0) + 1);
    }
    expect(byModel.get("judge-a")).toBe(3);
    expect(byModel.get("judge-b")).toBe(3);
  });

  test("cost is the SUM over the panel, and unknown when any member is unpriced", async () => {
    // The stub's models are not in the pricing table, so no call is priced —
    // an unpriced panel reads as "unknown", never as free.
    const { adapter } = panelStub({ "judge-a": 4, "judge-b": 4 });
    const verdict = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      judges: ["judge-a", "judge-b"],
    });
    expect(verdict.costUsdMicros).toBeUndefined();
  });

  test("a priced panel sums every member's spend", async () => {
    const priced = "claude-haiku-4-5";
    const { adapter } = panelStub({ [priced]: 4 });
    const one = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: priced,
    });
    const three = await gradeWithJudgePanel({
      rubric: RUBRIC,
      sample: SAMPLE,
      run: inLoopRunResult({ finalText: "x" }),
      adapter,
      model: priced,
      repeats: 3,
    });
    expect(one.costUsdMicros).toBeGreaterThan(0);
    expect(three.costUsdMicros).toBe((one.costUsdMicros as number) * 3);
  });
});

describe("inLoopRunResult", () => {
  test("with no messages the digest degrades honestly to the final output", () => {
    const run = inLoopRunResult({ finalText: "answer" });
    expect(run.agentOutput).toBe("answer");
    expect(run.transcript).toEqual([]);
  });

  test("projects message blocks into event-log events, in block order", () => {
    const run = inLoopRunResult({
      finalText: "done",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
            { type: "text", text: "after the tool" },
          ],
        },
      ],
    });
    expect(run.transcript.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_message",
      "tool_use",
      "assistant_message",
    ]);
  });

  test("skips block shapes the digest has no rendering for", () => {
    const run = inLoopRunResult({
      finalText: "done",
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }],
    });
    expect(run.transcript).toEqual([]);
  });
});
