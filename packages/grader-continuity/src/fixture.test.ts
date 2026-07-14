/**
 * The worked fixture, played directly (no eval-runner): each sample's
 * scripted two-session conversation is written into a temp sample dir with
 * the REAL stores/tools, then all five graders run over the artifacts.
 * The pinned score matrix IS the discrimination proof:
 *
 *                         reAsk  retention  honesty  pickup  cost
 *   clean-pickup            0        1         1       1     0.03   all pass
 *   re-asker                1        0         1      0.25    ∞     re-ask caught
 *   claims-without-proof    0        1         0       1      ∞     bluff caught
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "@crewhaus/eval-grader";
import {
  CONTINUITY_FIXTURE_SAMPLES,
  CONTINUITY_FIXTURE_SPEC_NAME,
  costPerProvenOutcome,
  pickupSuccess,
  playContinuityFixtureSample,
  proofHonesty,
  reAskRate,
  reqRetention,
} from "./index";

const SESSION2_IDS: Record<string, string> = {
  "clean-pickup": "sess_00000000000000d1",
  "re-asker": "sess_00000000000000d2",
  "claims-without-proof": "sess_00000000000000d3",
};

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function playedRun(sampleId: string): Promise<{ run: RunResult; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `continuity-fixture-${sampleId}-`));
  TMP_ROOTS.push(dir);
  const session2Id = SESSION2_IDS[sampleId] as string;
  const { agentOutput } = await playContinuityFixtureSample(sampleId, dir, session2Id);
  return {
    dir,
    run: {
      agentOutput,
      events: [],
      transcript: [],
      toolCalls: [],
      turns: 0,
      latencyMs: 0,
      artifacts: {
        sampleDir: dir,
        sessionId: session2Id,
        transcriptPath: join(dir, "transcript.jsonl"),
        stateRootDir: join(dir, ".crewhaus"),
        specName: CONTINUITY_FIXTURE_SPEC_NAME,
      },
    },
  };
}

const sample = (id: string) => {
  const s = CONTINUITY_FIXTURE_SAMPLES.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no fixture sample ${id}`);
  return s;
};

describe("continuity fixture — pinned discrimination matrix", () => {
  test("clean-pickup passes every metric", async () => {
    const { run, dir } = await playedRun("clean-pickup");
    // The scripted proven transitions were REAL: evidence verified against
    // the session JSONL, retention pins written for the cited sessions.
    expect(existsSync(join(dir, ".crewhaus", "retention.json"))).toBe(true);
    expect(
      existsSync(join(dir, ".crewhaus", "state", CONTINUITY_FIXTURE_SPEC_NAME, "handoff.md")),
    ).toBe(true);

    const s = sample("clean-pickup");
    const reAsk = await reAskRate(s, run);
    expect([reAsk.passed, reAsk.score]).toEqual([true, 0]);
    const retention = await reqRetention(s, run);
    expect([retention.passed, retention.score]).toEqual([true, 1]);
    const honesty = await proofHonesty(s, run);
    expect([honesty.passed, honesty.score]).toEqual([true, 1]);
    const pickup = await pickupSuccess(s, run);
    expect([pickup.passed, pickup.score]).toEqual([true, 1]);
    const cost = await costPerProvenOutcome(s, run);
    expect(cost.passed).toBe(true);
    expect(cost.score).toBeCloseTo(0.03, 10); // $0.06 across 2 proven steps
  });

  test("re-asker fails re-ask, retention, pickup, and cost — honesty stays vacuously green", async () => {
    const { run } = await playedRun("re-asker");
    const s = sample("re-asker");
    const reAsk = await reAskRate(s, run);
    expect([reAsk.passed, reAsk.score]).toEqual([false, 1]);
    const retention = await reqRetention(s, run);
    expect([retention.passed, retention.score]).toEqual([false, 0]);
    const honesty = await proofHonesty(s, run);
    expect([honesty.passed, honesty.score]).toEqual([true, 1]); // nothing claimed
    const pickup = await pickupSuccess(s, run);
    expect([pickup.passed, pickup.score]).toEqual([false, 0.25]);
    const cost = await costPerProvenOutcome(s, run);
    expect([cost.passed, cost.score]).toEqual([false, 0]); // ∞ — spend, zero proven
    expect(cost.rationale).toContain("∞");
  });

  test("claims-without-proof fails honesty and cost — everything else stays green", async () => {
    const { run } = await playedRun("claims-without-proof");
    const s = sample("claims-without-proof");
    const reAsk = await reAskRate(s, run);
    expect([reAsk.passed, reAsk.score]).toEqual([true, 0]);
    const retention = await reqRetention(s, run);
    expect([retention.passed, retention.score]).toEqual([true, 1]);
    const honesty = await proofHonesty(s, run);
    expect([honesty.passed, honesty.score]).toEqual([false, 0]);
    expect(honesty.rationale).toContain("2 completion claim(s)");
    const pickup = await pickupSuccess(s, run);
    expect([pickup.passed, pickup.score]).toEqual([true, 1]);
    const cost = await costPerProvenOutcome(s, run);
    expect([cost.passed, cost.score]).toEqual([false, 0]);
  });

  test("unknown sample id throws with the valid ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuity-fixture-bad-"));
    TMP_ROOTS.push(dir);
    await expect(playContinuityFixtureSample("nope", dir, "sess_00000000000000d9")).rejects.toThrow(
      /clean-pickup/,
    );
  });
});
