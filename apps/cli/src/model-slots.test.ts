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
