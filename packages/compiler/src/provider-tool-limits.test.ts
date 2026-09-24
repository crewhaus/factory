/**
 * provider-limits#0 — a tool list longer than the model's provider accepts
 * on one request fails at compile, not on every call.
 *
 * On 0.7.0 `tools: [all-code]` on an OpenAI model compiled cleanly (even
 * under --strict) and then every request came back as a provider 400
 * ("array too long … maximum length 128"); enabling every roll-up did the
 * same on Gemini (512).
 */
import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import { rollUpCategories } from "@crewhaus/tool-categories";
import { checkProviderToolLimits, compile, lower } from "./index";

const cli = (model: string, tools: string, agentExtra = ""): string =>
  `name: c\ntarget: cli\nagent:\n  model: ${model}\n  instructions: i\n${agentExtra}tools: ${tools}\n`;

/** How many builtin tools a cli spec's `tools:` expands to. */
const expanded = (tools: string): number =>
  (lower(parseSpec(cli("claude-sonnet-4-6", tools))) as { tools: ReadonlyArray<string> }).tools
    .length;

describe("a site no model can serve is a compile error", () => {
  test("OpenAI with all-code: the count, the 128 limit, who enforces it, and the fix", () => {
    const n = expanded("[all-code]");
    expect(n).toBeGreaterThan(128);
    expect(() => compile(cli("openai/gpt-5", "[all-code]"))).toThrow(
      `tools: ${n} tools (from tools:) exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused. The site has no other model to run on. Narrow tools:`,
    );
  });

  test("Azure OpenAI and Groq serve the same API and have the same limit", () => {
    for (const model of ["azure/my-deployment", "groq/llama-3.3-70b-versatile"]) {
      expect(() => compile(cli(model, "[all-compute]"))).toThrow(/exceed the 128-tool limit/);
    }
  });

  test("Gemini with every roll-up: over 512", () => {
    const all = `[${rollUpCategories()
      .map((c) => `all-${c}`)
      .join(", ")}]`;
    const n = expanded(all);
    expect(n).toBeGreaterThan(512);
    expect(() => compile(cli("gemini/gemini-2.5-pro", all))).toThrow(
      `${n} tools (from tools:) exceed the 512-tool limit Gemini puts on one request`,
    );
  });

  test("a workflow step names its own path", () => {
    const yaml = [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: gather",
      "    instructions: gather",
      "    model: openai/gpt-5",
      "    tools: [all-compute]",
      "  - name: write",
      "    instructions: write",
      "",
    ].join("\n");
    expect(() => compile(yaml)).toThrow(/^steps\[0\]\.tools: \d+ tools \(from tools:\) exceed/);
  });

  test("a model_pool whose every candidate is over its limit", () => {
    const pool = [
      "  model_pool:",
      "    candidates:",
      "      - { model: openai/gpt-5, tags: [strong] }",
      "      - { model: openai/gpt-5-mini, tags: [cheap] }",
      "",
    ].join("\n");
    expect(() => compile(cli("openai/gpt-5", "[all-code]", pool))).toThrow(
      "None of its models accepts that many.",
    );
  });
});

describe("controls: what must still compile", () => {
  test("the same list on Anthropic, a local server and an unlisted host", () => {
    for (const model of [
      "claude-sonnet-4-6",
      "local/llama3.2",
      "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
    ]) {
      expect(() => compile(cli(model, "[all-code]"))).not.toThrow();
    }
  });

  test("a list within the limit on OpenAI", () => {
    const n = expanded("[all-math]");
    expect(n).toBeLessThanOrEqual(128);
    const result = compile(cli("openai/gpt-5", "[all-math]"));
    expect(result.warnings.filter((w) => w.code === "provider-tool-cap")).toEqual([]);
  });

  test("exactly at the limit passes; one over fails", () => {
    const keys = (
      lower(parseSpec(cli("claude-sonnet-4-6", "[all-code]"))) as {
        tools: ReadonlyArray<string>;
      }
    ).tools;
    const list = (count: number): string => `[${keys.slice(0, count).join(", ")}]`;
    expect(() => compile(cli("openai/gpt-5", list(128)))).not.toThrow();
    expect(() => compile(cli("openai/gpt-5", list(129)))).toThrow(/129 tools/);
  });
});

describe("a model over its limit beside one within it is a warning", () => {
  test("a fallback over the limit: the spec runs on the primary, the fallback is named", () => {
    const result = compile(
      cli("claude-sonnet-4-6", "[all-code]", "  model_fallbacks: [openai/gpt-4o]\n"),
    );
    const caps = result.warnings.filter((w) => w.code === "provider-tool-cap");
    expect(caps.map((w) => w.path)).toEqual(["agent.model_fallbacks[0]"]);
    expect(caps[0]?.message).toContain(
      'exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-4o" is refused',
    );
  });

  test("the primary over the limit with a fallback within it still compiles, with the warning", () => {
    const result = compile(
      cli("openai/gpt-5", "[all-code]", "  model_fallbacks: [claude-sonnet-4-6]\n"),
    );
    expect(
      result.warnings.filter((w) => w.code === "provider-tool-cap").map((w) => w.path),
    ).toEqual(["agent.model"]);
  });

  test("a pool candidate whose profile narrows its tools is counted by its own subset", () => {
    const pool = [
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-sonnet-4-6, tags: [strong] }",
      "      - { model: openai/gpt-5-mini, tags: [cheap], tools: [read, grep] }",
      "      - { model: openai/gpt-5, tags: [wide] }",
      "",
    ].join("\n");
    const result = compile(cli("claude-sonnet-4-6", "[all-code, read, grep]", pool));
    // Only the un-narrowed OpenAI candidate is over; the narrowed one sends two tools.
    expect(
      result.warnings.filter((w) => w.code === "provider-tool-cap").map((w) => w.path),
    ).toEqual(["agent.model_pool.candidates[2]"]);
  });
});

describe("checkProviderToolLimits", () => {
  test("its hit count over a mixed spec: one error per unservable site, one warning per model", () => {
    const yaml = [
      "name: w",
      "target: workflow",
      "model: claude-sonnet-4-6",
      "steps:",
      "  - name: a",
      "    instructions: a",
      "    model: openai/gpt-5",
      "    tools: [all-code]",
      "  - name: b",
      "    instructions: b",
      "    model: claude-sonnet-4-6",
      "    model_fallbacks: [openai/gpt-5, groq/llama-3.3-70b-versatile]",
      "    tools: [all-code]",
      "  - name: c",
      "    instructions: c",
      "    model: openai/gpt-5",
      "    tools: [all-math]",
      "",
    ].join("\n");
    const { errors, warnings } = checkProviderToolLimits(lower(parseSpec(yaml)));
    expect(errors.map((e) => e.path)).toEqual(["steps[0].tools"]);
    expect(warnings.map((w) => w.path)).toEqual([
      "steps[1].model_fallbacks[0]",
      "steps[1].model_fallbacks[1]",
    ]);
  });
});
