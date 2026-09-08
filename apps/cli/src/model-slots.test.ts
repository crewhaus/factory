/**
 * 0.6.0 §8.2 — `enumerateModelSlots`. The point of the shared walk is that
 * every surface sees the SAME slots, so the tests assert what the three old
 * hand-rolled lists each missed: pool candidates, tiers, fallback chains, the
 * classifier, the strategy model slots and per-step / per-node / per-role
 * models.
 */
import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import { humanOwnedReason } from "@crewhaus/spec-patch";
import { auxModelsFor, enumerateModelSlots, primarySlot } from "./model-slots";

function walk(yaml: string) {
  return enumerateModelSlots(lower(parseSpec(yaml)));
}

const POOLED = `
name: pooled
target: cli
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    max_tokens: 4096
    requires: { tool_use: true }
  strong:
    model: claude-opus-5
    tags: [strong]
agent:
  model: $fast
  instructions: hi
  model_pool:
    candidates:
      - { model: $fast,   tags: [cheap] }
      - { model: $strong, tags: [strong] }
    policy: heuristic
compaction:
  model: claude-haiku-4-5
`;

describe("enumerateModelSlots", () => {
  test("walks the primary, every pool candidate and the aux blocks", () => {
    const slots = walk(POOLED);
    const labels = slots.map((s) => s.label);
    expect(labels).toContain("agent.model");
    expect(labels).toContain("agent.model_pool.candidates[0]");
    expect(labels).toContain("agent.model_pool.candidates[1]");
    expect(labels).toContain("compaction.model");
  });

  test("carries the resolved profile and its `requires` onto the slot", () => {
    const primary = primarySlot(walk(POOLED));
    expect(primary?.model).toBe("claude-haiku-4-5");
    expect(primary?.profile).toBe("fast");
    expect(primary?.requires).toEqual({ tool_use: true });
    expect(primary?.maxTokens).toBe(4096);
  });

  test("roster membership enumerates but is NOT swappable — the roster is human-owned", () => {
    const slots = walk(POOLED);
    for (const s of slots) {
      if (s.kind === "candidate" || s.kind === "tier" || s.kind === "fallback") {
        expect(s.swappable).toBe(false);
        expect(s.path).toBeUndefined();
      }
    }
    expect(primarySlot(slots)?.swappable).toBe(true);
    expect(slots.find((s) => s.label === "compaction.model")?.swappable).toBe(true);
  });

  test("tiers and per-profile fallback chains are visible (the old lists saw neither)", () => {
    const slots = walk(`
name: tiered
target: cli
models:
  fast:
    model: claude-haiku-4-5
    fallbacks: [claude-sonnet-4-5]
agent:
  model: claude-opus-5
  instructions: hi
  model_tiers: { fast: claude-haiku-4-5, default: claude-opus-5 }
`);
    const labels = slots.map((s) => s.label);
    expect(labels).toContain("agent.model_tiers.fast");
    expect(labels).toContain("agent.model_tiers.default");
  });

  test("a workflow's per-step models each get their own slot and patch path", () => {
    const slots = walk(`
name: wf
target: workflow
model: claude-opus-5
steps:
  - { name: a, instructions: one }
  - { name: b, model: claude-haiku-4-5, instructions: two }
`);
    const b = slots.find((s) => s.label === "steps[1].model");
    expect(b?.model).toBe("claude-haiku-4-5");
    expect(b?.path).toEqual(["steps", "1", "model"]);
    expect(b?.swappable).toBe(true);
  });

  test("auxModelsFor gives `doctor --models` its {slot, model} list minus the primary", () => {
    const aux = auxModelsFor(walk(POOLED));
    expect(aux.some((a) => a.slot === "agent.model")).toBe(false);
    expect(aux).toContainEqual({ slot: "compaction.model", model: "claude-haiku-4-5" });
    expect(aux.some((a) => a.slot === "agent.model_pool.candidates[1]")).toBe(true);
  });

  test("a bare single-model spec walks to exactly one slot", () => {
    const slots = walk(`
name: bare
target: cli
agent:
  model: claude-opus-5
  instructions: hi
`);
    expect(slots.map((s) => s.label)).toEqual(["agent.model"]);
    expect(slots[0]?.profile).toBeUndefined();
  });
});

/**
 * §9.3 / §10.3 — what a downshift search is allowed to see. `swappable` is
 * the ONLY gate `model right-size` reads, so a slot the plan classifies as
 * human-owned must never carry it: an automated cost-minimising loop with
 * `--write` would otherwise rewrite the judge that measures it.
 */
describe("swappable never covers a human-owned identity slot", () => {
  const JUDGED = `
name: judged
target: cli
agent:
  model: claude-opus-5
  instructions: hi
evaluation:
  grader: { type: llm_judge, criteria: is it good?, model: claude-opus-5 }
  threshold: 0.7
security:
  justification:
    judge: claude
    model: claude-opus-5
`;

  test("the judge slots enumerate, with their patch path, but are NOT swappable", () => {
    const slots = walk(JUDGED);
    const grader = slots.find((s) => s.label === "evaluation.grader.model");
    expect(grader?.kind).toBe("judge");
    expect(grader?.path).toEqual(["evaluation", "grader", "model"]);
    expect(grader?.swappable).toBe(false);
    const justification = slots.find((s) => s.label === "security.justification.model");
    expect(justification?.swappable).toBe(false);
  });

  test("no judge-kind slot of any shape is swappable", () => {
    for (const yaml of [JUDGED, POOLED]) {
      for (const s of walk(yaml)) {
        if (s.kind === "judge") expect(s.swappable).toBe(false);
      }
    }
  });

  test("the crew router's model enumerates but is not swappable (§10.3)", () => {
    const slots = walk(`
name: crew
target: crew
model: claude-opus-5
entry: writer
roles:
  writer: { instructions: write }
  editor: { instructions: edit, model: claude-haiku-4-5 }
routing: { kind: llm, model: claude-opus-5 }
`);
    const routing = slots.find((s) => s.label === "routing.model");
    expect(routing?.model).toBe("claude-opus-5");
    expect(routing?.swappable).toBe(false);
  });

  test("every swappable path is one the repo does not call judge identity", () => {
    for (const yaml of [JUDGED, POOLED]) {
      for (const s of walk(yaml)) {
        if (!s.swappable || s.path === undefined) continue;
        expect(humanOwnedReason(s.path)).not.toBe("judge identity");
      }
    }
  });
});
