/**
 * 0.6.0 (design §8.4) — the spec → watchdog seam for the three
 * hybrid-routing SLO targets. PR 18 taught the runtime `SloTargets` and the
 * SLO monitor `escalation_rate` / `judge_fail_rate` / `floor_block_rate`; PR 19
 * adds the spec keys and lowers them into `IrSlo`. `crewhaus run` passes the
 * lowered block through as `sloTargets` with no field mapping
 * (`sloTargets = sloIr`), so the two shapes MUST agree key-for-key — this
 * test pins that a spec declaring the three keys produces breaches on
 * exactly those three metrics when the monitor evaluates a window above the
 * declared ceilings.
 */
import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import {
  MIN_SLO_SAMPLES,
  type SloTargets,
  type SloWindowMetrics,
  detectSloBreaches,
} from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";

const SPEC = `
name: routed
target: cli
agent:
  model: claude-opus-4-6
  instructions: i
observability:
  slo:
    escalation_rate: 0.3
    judge_fail_rate: 0.5
    floor_block_rate: 0.2
`;

/** A window with every routing rate above its ceiling and enough samples to count. */
const HOT_WINDOW: SloWindowMetrics = {
  turnP95Ms: 100,
  turnSamples: MIN_SLO_SAMPLES,
  ttftP95Ms: 50,
  ttftSamples: MIN_SLO_SAMPLES,
  errorRate: 0,
  modelCalls: MIN_SLO_SAMPLES,
  costPerHourUsd: 0,
  costSamples: 0,
  windowElapsedMs: 60_000,
  egressBlockRate: 0,
  externalCalls: 0,
  escalationRate: 0.6,
  escalations: 3,
  judgeFailRate: 0.8,
  judgeVerdicts: MIN_SLO_SAMPLES,
  floorBlockRate: 0.5,
  routeDecisions: MIN_SLO_SAMPLES,
};

describe("observability.slo routing targets reach the SLO watchdog", () => {
  test("a spec declaring the three keys breaches exactly those three metrics", () => {
    const ir = lower(parseSpec(SPEC));
    if (ir.target !== "cli") throw new Error("unexpected target");
    // The same pass-through `crewhaus run` performs (no mapping layer).
    const targets = ir.observability?.slo as SloTargets | undefined;
    expect(targets).toBeDefined();
    const breaches = detectSloBreaches(HOT_WINDOW, targets as SloTargets);
    expect(breaches.map((b) => b.metric).sort()).toEqual([
      "escalation_rate",
      "floor_block_rate",
      "judge_fail_rate",
    ]);
    expect(breaches.find((b) => b.metric === "escalation_rate")?.target).toBe(0.3);
    expect(breaches.find((b) => b.metric === "judge_fail_rate")?.target).toBe(0.5);
    expect(breaches.find((b) => b.metric === "floor_block_rate")?.target).toBe(0.2);
  });

  test("a spec without the keys never evaluates them, however hot the window", () => {
    const ir = lower(
      parseSpec(
        SPEC.replace(/ {4}(escalation_rate|judge_fail_rate|floor_block_rate):.*\n/g, "").concat(
          "    error_rate: 0.5\n",
        ),
      ),
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    const targets = ir.observability?.slo as SloTargets;
    expect(detectSloBreaches(HOT_WINDOW, targets)).toEqual([]);
  });
});
