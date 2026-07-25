import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { createRunContext } from "@crewhaus/run-context";
import type { TestVerdictEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { runSample } from "./run-sample";
import type { AgentInvoker, GraderEntry } from "./types";

/**
 * Loop contract 0.4 (Batch C, G59) — runSample publishes one `test_verdict`
 * event from the grader outcome onto the run's TraceEventBus. When a caller
 * threads a shared RunContext, the verdict lands on that bus (the seam a run
 * loop uses to route verdicts to an OTel exporter).
 */

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-verdict-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: Sample = { id: "s1", input: "hi", expected_output: "ok" };

const EXACT: GraderEntry[] = (() => {
  const { compiled } = parseGradersConfig("graders:\n  - name: m\n    type: exact_match\n");
  return compiled.map((g) => ({ name: g.name, grader: g.grader }));
})();

function verdictsOn(rc: ReturnType<typeof createRunContext>): TestVerdictEvent[] {
  const seen: TestVerdictEvent[] = [];
  rc.eventBus.subscribe((e: TraceEvent) => {
    if (e.kind === "test_verdict") seen.push(e as TestVerdictEvent);
  });
  return seen;
}

describe("runSample — test_verdict publication", () => {
  test("a passing grade publishes verdict pass on the shared bus", async () => {
    const runContext = createRunContext();
    const seen = verdictsOn(runContext);
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", events: [] });
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir: newTempRoot(),
      model: "claude-test",
      runContext,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toBe("pass");
    expect(seen[0]?.testId).toBe("s1");
    expect(typeof seen[0]?.durationMs).toBe("number");
  });

  test("a failing grade publishes verdict fail", async () => {
    const runContext = createRunContext();
    const seen = verdictsOn(runContext);
    const invoker: AgentInvoker = async () => ({ agentOutput: "WRONG", events: [] });
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir: newTempRoot(),
      model: "claude-test",
      runContext,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toBe("fail");
  });

  test("an A3 abstained sample publishes verdict skip, not fail", async () => {
    const runContext = createRunContext();
    const seen = verdictsOn(runContext);
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", events: [] });
    // Abstaining judge + passing exact_match → sample outcome `abstained`
    // (A3), which must reach bus consumers as "skip" so they stay consistent
    // with the aggregates (abstained samples leave the pass-rate denominator).
    const abstainingJudge: GraderEntry = {
      name: "judge",
      grader: async () => ({
        passed: false,
        score: 0,
        rationale: "judge abstained: evidence insufficient",
        abstained: true,
      }),
    };
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: [...EXACT, abstainingJudge],
      outDir: newTempRoot(),
      model: "claude-test",
      runContext,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toBe("skip");
  });

  test("an invoker error publishes verdict error", async () => {
    const runContext = createRunContext();
    const seen = verdictsOn(runContext);
    const invoker: AgentInvoker = async () => {
      throw new Error("boom");
    };
    await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir: newTempRoot(),
      model: "claude-test",
      runContext,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.verdict).toBe("error");
  });

  test("without a shared runContext the run still completes (fresh per-sample bus)", async () => {
    const invoker: AgentInvoker = async () => ({ agentOutput: "ok", events: [] });
    const result = await runSample({
      sample: SAMPLE,
      invoker,
      graders: EXACT,
      outDir: newTempRoot(),
      model: "claude-test",
    });
    expect(result.grades.overall.passed).toBe(true);
  });
});
