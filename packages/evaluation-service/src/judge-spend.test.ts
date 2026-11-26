/**
 * The `evaluation:` judge in a budgeted run reserves its call on the run's
 * spend meter and settles it there, beside the run's own calls, so the run's
 * cap and the harness's period count it before it is sent. A gate that blocks
 * (`retry`, `halt`, `escalate`) never serves an answer whose judge call the
 * budget refused: the run ends with exit 33. A judge waiting for room stops
 * waiting on the turn's stop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRunContext } from "@crewhaus/run-context";
import { openPeriodSpendMeter, runChatLoop, spendMeterOf } from "@crewhaus/runtime-core";
import { scriptedJudge, tempDirs } from "./__fixtures__/helpers";
import { scriptedModel } from "./__fixtures__/loop";
import { buildRunEvaluation } from "./evaluation";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** Every line of the harness's monthly period ledgers. */
function ledgerLines(harness: string): Array<Record<string, unknown>> {
  const budget = join(harness, ".crewhaus", "run", "control", "budget");
  const out: Array<Record<string, unknown>> = [];
  if (!existsSync(budget)) return out;
  for (const period of readdirSync(budget).filter((p) => p.startsWith("month-"))) {
    for (const seg of readdirSync(join(budget, period))) {
      for (const line of readFileSync(join(budget, period, seg), "utf8").split("\n")) {
        if (line !== "") out.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return out;
}

describe("the evaluation judge in a budgeted run", () => {
  test("reserves and settles its call on the run's spend meter and the harness's period", async () => {
    const harness = dirs.make();
    const { adapter: judge, requests } = scriptedJudge(() => ({
      score: 5,
      rationale: "good",
      criterion_scores: { criteria: 5 },
    }));
    const evaluation = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "answers the question" },
        threshold: 0.7,
        onFail: "retry",
        maxRetries: 1,
      },
      "claude-haiku-4-5",
      { judgeAdapter: judge },
    );
    const runContext = createRunContext();
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "answer",
      _adapter: scriptedModel([[{ type: "text", text: "14 days." }]]) as never,
      tools: [],
      evaluation,
      budget: {
        usdMicros: 5_000_000,
        onExceed: { kind: "stop" },
        period: { every: "month", usdMicros: 100_000_000 },
      },
      spendLedgerRoot: harness,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "how long is the refund window?" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      persistSession: false,
      runContext,
    });
    expect(requests).toHaveLength(1);
    const lines = ledgerLines(harness);
    const judgeIds = lines
      .filter((l) => l["op"] === "reserve" && String(l["id"]).startsWith("rsv_judge_"))
      .map((l) => l["id"]);
    expect(judgeIds).toHaveLength(1);
    expect(lines.find((l) => l["op"] === "reserve" && l["id"] === judgeIds[0])).toMatchObject({
      role: "judge",
      model: "claude-haiku-4-5",
    });
    expect(lines.filter((l) => l["op"] === "settle" && l["id"] === judgeIds[0])).toHaveLength(1);
    // The run's call and the judge's: 10 in + 5 out on Sonnet (105) and 1000 in + 100 out on Haiku (1500).
    expect(spendMeterOf(runContext)?.snapshot()).toMatchObject({
      spentMicros: 105 + 1_500,
      activeReservations: 0,
    });
  });
});

/** One turn answering `text` on Sonnet (10 in + 5 out: 105 micros), graded by a judge that fails it. */
async function gatedRun(opts: {
  readonly onFail: "retry" | "halt" | "escalate" | "note";
  readonly runCapMicros: number;
  readonly periodCapMicros?: number;
}): Promise<{ out?: string; err?: unknown; judgeRequests: number }> {
  const harness = dirs.make();
  const { adapter: judge, requests } = scriptedJudge(() => ({
    score: 1,
    rationale: "wrong",
    criterion_scores: { criteria: 1 },
  }));
  const evaluation = buildRunEvaluation(
    {
      grader: { type: "llm_judge", criteria: "answers the question" },
      threshold: 0.7,
      onFail: opts.onFail,
      maxRetries: 1,
    },
    "claude-haiku-4-5",
    { judgeAdapter: judge },
  );
  try {
    const out = await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "answer",
      _adapter: scriptedModel([
        [{ type: "text", text: "UNGRADED" }],
        [{ type: "text", text: "UNGRADED" }],
      ]) as never,
      tools: [],
      evaluation,
      budget: {
        usdMicros: opts.runCapMicros,
        onExceed: { kind: "stop" },
        ...(opts.periodCapMicros !== undefined
          ? { period: { every: "month" as const, usdMicros: opts.periodCapMicros } }
          : {}),
      },
      spendLedgerRoot: harness,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      persistSession: false,
      runContext: createRunContext(),
    });
    return { out, judgeRequests: requests.length };
  } catch (err) {
    return { err, judgeRequests: requests.length };
  }
}

describe("a blocking evaluation gate whose judge call the budget refuses", () => {
  for (const onFail of ["retry", "halt", "escalate"] as const) {
    for (const [label, caps] of [
      ["the run's cap", { runCapMicros: 100 }],
      ["the period's cap", { runCapMicros: 5_000_000, periodCapMicros: 105 }],
    ] as const) {
      test(`on_fail ${onFail}, ${label}: the run ends with exit 33 and the answer is not served`, async () => {
        const r = await gatedRun({ onFail, ...caps });
        expect(r.out).toBeUndefined();
        expect(r.judgeRequests).toBe(0);
        expect(r.err).toMatchObject({
          name: "RunFailedError",
          report: { class: "crewhaus_budget", exitCode: 33 },
        });
        expect(String((r.err as { report: { detail: string } }).report.detail)).toContain(
          "before the evaluation of turn 1",
        );
      });
    }
  }

  test("on_fail note leaves the turn ungraded, as for any judge error", async () => {
    const r = await gatedRun({ onFail: "note", runCapMicros: 100 });
    expect(r.err).toBeUndefined();
    expect(r.out).toBe("UNGRADED");
    expect(r.judgeRequests).toBe(0);
  });

  test("with room to spare, the judge grades and the halt gate stops the run", async () => {
    const r = await gatedRun({ onFail: "halt", runCapMicros: 5_000_000 });
    expect(r.judgeRequests).toBe(1);
    expect(r.err).toMatchObject({ report: { class: "evaluation" } });
  });
});

describe("a judge waiting for room on the period", () => {
  test("stops waiting when the turn stops, and sends nothing", async () => {
    const harness = dirs.make();
    const period = { every: "month" as const, usdMicros: 1_000_000 };
    const { adapter: judge, requests } = scriptedJudge(() => ({
      score: 5,
      rationale: "good",
      criterion_scores: { criteria: 5 },
    }));
    const evaluation = buildRunEvaluation(
      {
        grader: { type: "llm_judge", criteria: "x" },
        threshold: 0.7,
        onFail: "halt",
        maxRetries: 0,
      },
      "claude-haiku-4-5",
      { judgeAdapter: judge },
    );
    // Another holder reserves the rest of the period while the run's call
    // streams, and never settles while the run lasts.
    const other = openPeriodSpendMeter({ period, root: harness });
    const stop = new AbortController();
    const adapter = {
      providerId: "anthropic",
      features: {
        caching: false,
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      },
      estimateTokens: () => 0,
      stream() {
        return (async function* () {
          yield { kind: "message_start", usage: { input: 10, output: 0 } };
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          };
          yield { kind: "content_block_stop", index: 0 };
          await other.reserve("elsewhere", 1_000_000);
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 10, output: 5 } };
          yield { kind: "message_stop" };
        })();
      },
    };
    const runContext = createRunContext({ abortSignal: stop.signal });
    // The stop lands once the judge has asked the ledger and is waiting.
    const unsubscribe = runContext.eventBus.subscribe((e) => {
      if (e.kind === "model_response") setTimeout(() => stop.abort(), 50);
    });
    let ended = false;
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "a",
      maxTokens: 100,
      _adapter: adapter as never,
      tools: [],
      evaluation,
      budget: { usdMicros: 900_000, onExceed: { kind: "stop" }, period },
      spendLedgerRoot: harness,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "q" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      persistSession: false,
      runContext,
    }).then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    unsubscribe();
    await other.release("elsewhere");
    // A wait the stop did not end would hold the run until the other call settled.
    expect(ended).toBe(true);
    expect(requests).toHaveLength(0);
    const judgeLines = ledgerLines(harness).filter((l) => String(l["id"]).startsWith("rsv_judge_"));
    expect(judgeLines).toEqual([]);
  });
});
