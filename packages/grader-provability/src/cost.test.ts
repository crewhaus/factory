import { describe, expect, test } from "bun:test";
import { accrual, ev, pass, response } from "./__test__/fixtures";
import { gateSpendOf } from "./cost";

describe("gateSpendOf", () => {
  test("no events, no bundle: nothing spent", () => {
    expect(gateSpendOf([])).toEqual({
      rerunUsdMicros: 0,
      judgeUsdMicros: 0,
      totalUsdMicros: 0,
      reruns: 0,
      rerunTokens: 0,
      unpricedTokens: 0,
      unpriced: false,
      checks: 0,
      checkerMs: 0,
    });
  });

  test("only the window after a FAILING pass counts; a window after a pass does not", () => {
    const spend = gateSpendOf([
      pass("fail", 0),
      accrual(1_000), // gate-caused retry
      pass("pass", 1),
      accrual(2_000), // after the standing pass
      // a second pass after a PASS (an evaluation-triggered re-run, say)
      pass("pass", 2),
    ]);
    expect(spend.rerunUsdMicros).toBe(1_000);
    expect(spend.reruns).toBe(2);
  });

  test("two failing passes open two windows", () => {
    const spend = gateSpendOf([
      pass("fail", 0),
      accrual(1_000),
      pass("fail", 1),
      accrual(3_000),
      pass("pass", 2),
    ]);
    expect(spend.rerunUsdMicros).toBe(4_000);
    expect(spend.totalUsdMicros).toBe(4_000);
  });

  test("a final failing pass with nothing after it opens no window", () => {
    const spend = gateSpendOf([pass("fail", 0), accrual(9_000)]);
    expect(spend.rerunUsdMicros).toBe(0);
  });

  test("judge-role accruals in a window are excluded; the gate's judgeCost is counted once", () => {
    const spend = gateSpendOf([
      pass("fail", 0, { judgeCostUsdMicros: 100 }),
      accrual(500, { role: "judge" }),
      accrual(1_000, { role: "escalation" }),
      pass("pass", 1, { judgeCostUsdMicros: 500 }),
    ]);
    expect(spend.judgeUsdMicros).toBe(600);
    expect(spend.rerunUsdMicros).toBe(1_000);
    expect(spend.totalUsdMicros).toBe(1_600);
  });

  test("a bundle's own spend is used only when there are no pass events", () => {
    expect(gateSpendOf([], { spentUsdMicros: 700 }).judgeUsdMicros).toBe(700);
    expect(gateSpendOf([pass("pass", 0)], { spentUsdMicros: 700 }).judgeUsdMicros).toBe(0);
  });

  test("re-run tokens are counted; unpriced when no priced accrual exists in a window", () => {
    const unpricedRun = gateSpendOf([pass("fail", 0), response(10, 5), pass("pass", 1)]);
    expect(unpricedRun).toMatchObject({ rerunTokens: 15, unpriced: true });
    const flagged = gateSpendOf([
      pass("fail", 0),
      response(10, 5),
      accrual(0, { unpriced: true }),
      pass("pass", 1),
    ]);
    expect(flagged.unpriced).toBe(true);
    const priced = gateSpendOf([pass("fail", 0), response(10, 5), accrual(40), pass("pass", 1)]);
    expect(priced.unpriced).toBe(false);
    // A judge's response is not a re-run token.
    const judged = gateSpendOf([
      pass("fail", 0),
      response(10, 5, { role: "judge" }),
      pass("pass", 1),
    ]);
    expect(judged.rerunTokens).toBe(0);
  });

  test("a METERED run prices from its accruals: an unpriced accrual's tokens are unpriced even beside a priced one", () => {
    const spend = gateSpendOf([
      accrual(10_000), // the original answer (metered: the tracker is attached)
      pass("fail", 0),
      response(100, 50),
      accrual(40),
      response(100, 50),
      accrual(0, { unpriced: true, inputTokens: 300, outputTokens: 20 }),
      pass("pass", 1),
    ]);
    expect(spend).toMatchObject({
      rerunUsdMicros: 40,
      rerunTokens: 300,
      unpricedTokens: 320,
      unpriced: true,
    });
  });

  test("an UNMETERED run prices its window's responses through the seam (spec model first)", () => {
    const models: string[] = [];
    const pricing = (model: string, t: { input: number; output: number }) => {
      models.push(model);
      return model === "unknown" ? undefined : t.input + 2 * t.output;
    };
    const spend = gateSpendOf(
      [
        response(1_000, 1_000), // before any pass: not the gate's
        pass("fail", 0),
        response(100, 50, { specModel: "anthropic/claude-haiku-4-5" }),
        response(10, 5, { model: "unknown" }),
        pass("pass", 1),
      ],
      undefined,
      { pricing },
    );
    expect(models).toEqual(["anthropic/claude-haiku-4-5", "unknown"]);
    expect(spend).toMatchObject({
      rerunUsdMicros: 200,
      rerunTokens: 165,
      unpricedTokens: 15,
      unpriced: true,
    });
  });

  test("a Task child's roled summary accrual in a window counts; the role-less optimizer total never does", () => {
    const spend = gateSpendOf([
      pass("fail", 0),
      accrual(700, { summary: true, role: "subagent" }),
      accrual(9_999, { summary: true }),
      pass("pass", 1),
    ]);
    expect(spend.rerunUsdMicros).toBe(700);
  });

  test("proof_checked time is summed; non-finite fields read as 0", () => {
    const spend = gateSpendOf([
      ev({
        kind: "proof_checked",
        checker: "builtin",
        ok: true,
        artifactId: "a",
        durationMs: 12,
        axioms: [],
      }),
      ev({
        kind: "proof_checked",
        checker: "builtin",
        ok: true,
        artifactId: "b",
        durationMs: Number.NaN,
        axioms: [],
      }),
      pass("fail", 0, { judgeCostUsdMicros: Number.POSITIVE_INFINITY }),
    ]);
    expect(spend).toMatchObject({ checks: 2, checkerMs: 12, judgeUsdMicros: 0 });
  });
});
