/**
 * 0.6.0 PR 6 (spec surface) — the compiler's interim guards for the three
 * spec additions whose lowering lands with the IR widening (PR 7): the
 * `models:` registry (and with it every `$profile` reference, which the spec
 * rejects without a registry), `model_pool.policy: classifier` and
 * `evaluation.on_fail: escalate`. Each is a LOUD `CompilerError` today rather
 * than a silently dropped key or a literal `$fast` reaching the model-router
 * grammar. Absent config keeps lowering byte-identical (the existing
 * `index.test.ts` pins cover that; this file pins only the guards).
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import { parseSpec } from "@crewhaus/spec";
import { compile, lower } from "./index";

const POOLED = [
  "name: hello",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-6",
  "  instructions: be helpful",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-5, tags: [strong] }",
];

describe("0.6.0 interim compiler guards (spec accepted, lowering pending)", () => {
  test("a models: registry is a CompilerError naming the pending lowering", () => {
    const yaml = [
      "name: hello",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5 }",
      "agent:",
      "  model: $fast",
      "  instructions: be helpful",
    ].join("\n");
    // The spec accepts it …
    expect(parseSpec(yaml).models).toBeDefined();
    // … and the compiler refuses to lower it for now.
    expect(() => lower(parseSpec(yaml))).toThrow(CompilerError);
    expect(() => compile(yaml)).toThrow(/models: .* not yet lowered/);
  });

  test("model_pool.policy: classifier is a CompilerError", () => {
    const yaml = [
      ...POOLED,
      "    policy: classifier",
      "    classifier: { model: claude-haiku-4-5, labels: { cheap: simple, strong: hard } }",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(CompilerError);
    expect(() => compile(yaml)).toThrow(/policy: classifier .* not yet lowered/);
  });

  test("evaluation.on_fail: escalate is a CompilerError", () => {
    const yaml = [
      ...POOLED,
      "evaluation:",
      "  grader: { type: llm_judge, criteria: helpful }",
      "  on_fail: escalate",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(CompilerError);
    expect(() => compile(yaml)).toThrow(/on_fail: escalate .* not yet lowered/);
  });

  test("the same pool without the pending keys still compiles (byte-identical path untouched)", () => {
    const bundle = compile(POOLED.join("\n"));
    expect(bundle.files.length).toBeGreaterThan(0);
  });
});
