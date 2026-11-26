/**
 * A declared price names one model in the lowered harness too: the lowering
 * refuses a price that a step, node, role, pool candidate or the agent itself
 * would also be priced by under another family (a local model beside
 * `openai/`, Vertex beside a direct Claude or `gemini/` string), which the
 * parse check cannot see, and a spec whose prices name only their own models
 * keeps the table's price for every other model.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PRICING,
  declaredPricingKey,
  mergeDeclaredPricing,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import { CompilerError } from "@crewhaus/errors";
import type { IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
// The router is not a compiler dependency; the test reads its parse by path.
import { parseModelString } from "../../model-router/src/parse";
import { compile, lower, lowerWithWarnings } from "./index";

const LOCAL = "http://127.0.0.1:11434/v1";
const FREE = "{input_per_1m: 0, output_per_1m: 0}";

/** The refusal a lowering throws, or "" when it lowers. */
function loweringRefusal(yaml: string): string {
  const spec = parseSpec(yaml);
  try {
    lower(spec);
    return "";
  } catch (err) {
    expect(err).toBeInstanceOf(CompilerError);
    return (err as Error).message;
  }
}

describe("a declared price names one model, in the lowered harness", () => {
  test("a free local model with a key of its own leaves openai gpt-4o at the table's price", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      `  free: {model: "local/qwen3@${LOCAL}", price: ${FREE}}`,
      "agent:",
      "  model: openai/gpt-4o",
      "  instructions: Help.",
      "  model_pool:",
      "    candidates:",
      "      - {model: openai/gpt-4o, tags: [strong]}",
      "      - {model: $free, tags: [cheap]}",
      "",
    ].join("\n");
    const ir = lower(parseSpec(yaml)) as IrV0;
    const table = mergeDeclaredPricing(DEFAULT_PRICING, ir.agent.declaredPricing);
    expect(Object.keys(ir.agent.declaredPricing ?? {})).toEqual([`local/qwen3@${LOCAL}`]);
    expect(resolvePricing(table, "openai", "gpt-4o")).toMatchObject({
      inputPer1M: 2.5,
      outputPer1M: 10,
    });
    expect(resolvePricing(table, "openai", "qwen3")).toMatchObject({
      inputPer1M: 0,
      outputPer1M: 0,
    });
  });

  test("a free local gpt-4o beside a real openai gpt-4o is refused before anything is built", () => {
    const yaml = `name: a\ntarget: cli\nmodels:\n  free: {model: "local/gpt-4o@${LOCAL}", price: ${FREE}}\nagent: {model: openai/gpt-4o, instructions: Help.}\n`;
    expect(() => compile(yaml)).toThrow(
      "models.free.price: local/gpt-4o@… is priced as openai gpt-4o, which the pricing table already prices",
    );
  });

  test("an inline workflow step on another family's string with the declared key is refused, naming the step", () => {
    const yaml = [
      "name: wf",
      "target: workflow",
      "model: claude-opus-4-7",
      "models:",
      `  mine: {model: "local/my-model@${LOCAL}", price: {input_per_1m: 1, output_per_1m: 1}}`,
      "steps:",
      "  - name: draft",
      "    instructions: Write.",
      "    model: openai/my-model",
      "",
    ].join("\n");
    expect(loweringRefusal(yaml)).toBe(
      "models.mine.price: local/my-model@… is priced as openai my-model, and so is steps[0].model (openai/my-model); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    );
  });

  test("an inline pool candidate is refused the same way", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      `  mine: {model: "local/my-model@${LOCAL}", price: {input_per_1m: 1, output_per_1m: 1}}`,
      "agent:",
      "  model: $mine",
      "  instructions: Help.",
      "  model_pool:",
      "    candidates:",
      "      - {model: $mine, tags: [cheap]}",
      "      - {model: together/my-model, tags: [strong]}",
      "",
    ].join("\n");
    expect(loweringRefusal(yaml)).toContain(
      "and so is agent.model_pool.candidates[1] (together/my-model)",
    );
  });

  test("a free Vertex Claude price beside a direct Claude agent is refused before anything is built", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      `  p: {model: vertex/claude-sonnet-4-5, price: ${FREE}}`,
      "agent:",
      "  model: claude-sonnet-4-5",
      "  instructions: Help.",
      "",
    ].join("\n");
    expect(loweringRefusal(yaml)).toBe(
      "models.p.price: vertex/claude-sonnet-4-5 is priced as anthropic claude-sonnet-4-5, and so is agent.model (claude-sonnet-4-5); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    );
    expect(() => compile(yaml)).toThrow("and so is agent.model (claude-sonnet-4-5)");
  });

  test("a Vertex Gemini price beside an inline gemini/ step with its key is refused, naming the step", () => {
    const yaml = [
      "name: wf",
      "target: workflow",
      "model: claude-opus-4-7",
      "models:",
      `  v: {model: vertex/gemini-2.5-pro, price: ${FREE}}`,
      "steps:",
      "  - name: draft",
      "    instructions: Write.",
      "    model: gemini/gemini-2.5-pro",
      "",
    ].join("\n");
    expect(loweringRefusal(yaml)).toBe(
      "models.v.price: vertex/gemini-2.5-pro is priced as gemini gemini-2.5-pro, and so is steps[0].model (gemini/gemini-2.5-pro); a declared price would also price its calls. Remove the price, or keep only one of the two models.",
    );
  });

  test("a Vertex price used only by Vertex compiles, with the notice that it replaces the table's", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      "  p: {model: vertex/claude-sonnet-4-5, price: {input_per_1m: 1, output_per_1m: 1}}",
      "agent:",
      "  model: $p",
      "  instructions: Help.",
      "",
    ].join("\n");
    const { warnings } = lowerWithWarnings(parseSpec(yaml));
    expect(warnings.filter((w) => w.path === "models.p.price").map((w) => w.code)).toEqual([
      "model-price-overrides-table",
    ]);
  });

  test("two endpoints of one local model share the declared price", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      `  mine: {model: "local/qwen3@http://host-a:11434/v1", price: ${FREE}}`,
      "agent:",
      "  model: local/qwen3@http://host-b:11434/v1",
      "  instructions: Help.",
      "",
    ].join("\n");
    expect(loweringRefusal(yaml)).toBe("");
  });

  test("a Bedrock price over the table still compiles, with the notice that says so", () => {
    const yaml = [
      "name: a",
      "target: cli",
      "models:",
      "  b: {model: bedrock/us.anthropic.claude-sonnet-4-5-v1:0, price: {input_per_1m: 1, output_per_1m: 1}}",
      "agent:",
      "  model: $b",
      "  instructions: Help.",
      "",
    ].join("\n");
    const { warnings } = lowerWithWarnings(parseSpec(yaml));
    expect(warnings.filter((w) => w.path === "models.b.price").map((w) => w.code)).toEqual([
      "model-price-overrides-table",
    ]);
  });

  test("a spec that declares no price is not read", () => {
    const yaml = `name: a\ntarget: cli\nagent: {model: openai/gpt-4o, instructions: Help.}\nmodels:\n  local: {model: "local/gpt-4o@${LOCAL}"}\n`;
    expect(loweringRefusal(yaml)).toBe("");
  });
});

describe("a model string names a known host exactly", () => {
  test.each(["constructor", "__proto__", "toString"])(
    "a %s/ prefix is no host: the router refuses it, or the lowering refuses the price on its key",
    (prefix) => {
      const used = `${prefix}/my-model`;
      let routed: string | undefined;
      let reason = "";
      try {
        routed = parseModelString(used).providerId;
      } catch (err) {
        reason = (err as Error).message;
      }
      const yaml = [
        "name: a",
        "target: cli",
        "models:",
        `  mine: {model: "local/my-model@${LOCAL}", price: ${FREE}}`,
        "agent:",
        `  model: ${used}`,
        "  instructions: Help.",
        "",
      ].join("\n");
      const refusal = loweringRefusal(yaml);
      // A string the router would send somewhere is one the price check reads.
      expect(routed === undefined || refusal.includes("models.mine.price"), used).toBe(true);
      expect(routed).toBeUndefined();
      expect(reason).toContain(`model "${used}": unrecognised model string`);
      // The pricing twin reads the same set of hosts.
      expect(declaredPricingKey(used)).toBeUndefined();
    },
  );
});
