/**
 * The `evaluation:` judge in a budgeted run reserves its call on the run's
 * spend meter and settles it there, beside the run's own calls, so the run's
 * cap and the harness's period count it before it is sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop, spendMeterOf } from "@crewhaus/runtime-core";
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
