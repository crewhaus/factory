/**
 * provider-limits#0 — a tool list longer than the model's provider accepts
 * on one request fails at compile, not on every call.
 *
 * On 0.7.0 `tools: [all-code]` on an OpenAI model compiled cleanly (even
 * under --strict) and then every request came back as a provider 400
 * ("array too long … maximum length 128"); enabling every roll-up did the
 * same on Gemini (512).
 *
 * The `openai/` route is the exception at compile time: OPENAI_BASE_URL sends
 * it to any OpenAI-compatible server (a vLLM or LiteLLM gateway, the
 * documented way to reach one), which sets its own limit, so the compiler
 * cannot know the 128 applies. It says so (`provider-tool-cap-unverified`)
 * and the run checks it at start, where it can see the endpoint.
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
  test("Azure OpenAI with all-code: the count, the 128 limit, who enforces it, and the fix", () => {
    const n = expanded("[all-code]");
    expect(n).toBeGreaterThan(128);
    expect(() => compile(cli("azure/my-deployment", "[all-code]"))).toThrow(
      `tools: ${n} tools (from tools:) exceed the 128-tool limit Azure OpenAI puts on one request, so every call to model "azure/my-deployment" is refused. The site has no other model to run on. Narrow tools:`,
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
      "    model: groq/llama-3.3-70b-versatile",
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
      "      - { model: azure/big, tags: [strong] }",
      "      - { model: groq/llama-3.3-70b-versatile, tags: [cheap] }",
      "",
    ].join("\n");
    expect(() => compile(cli("azure/big", "[all-code]", pool))).toThrow(
      "None of its models accepts that many.",
    );
  });
});

describe("an openai/ model over OpenAI's limit is unverified, not refused", () => {
  test("alone: it compiles, and the warning names OPENAI_BASE_URL and the start-up check", () => {
    const result = compile(cli("openai/gpt-5", "[all-code]"));
    const caps = result.warnings.filter((w) => w.code.startsWith("provider-tool-cap"));
    expect(caps.map((w) => [w.code, w.path])).toEqual([
      ["provider-tool-cap-unverified", "agent.model"],
    ]);
    expect(caps[0]?.message).toContain(
      'exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused by api.openai.com. It runs only if OPENAI_BASE_URL sends the model to an OpenAI-compatible server that takes more; the run checks this when it starts',
    );
  });

  test("beside a fixed-endpoint model that is also over: no error, a warning for each", () => {
    const result = compile(
      cli(
        "openai/meta-llama/Llama-3.3-70B-Instruct",
        "[all-code]",
        "  model_fallbacks: [azure/big]\n",
      ),
    );
    expect(
      result.warnings
        .filter((w) => w.code.startsWith("provider-tool-cap"))
        .map((w) => [w.code, w.path]),
    ).toEqual([
      ["provider-tool-cap-unverified", "agent.model"],
      ["provider-tool-cap", "agent.model_fallbacks[0]"],
    ]);
  });

  test("a pool of openai/ candidates alone compiles, one unverified warning each", () => {
    const pool = [
      "  model_pool:",
      "    candidates:",
      "      - { model: openai/gpt-5, tags: [strong] }",
      "      - { model: openai/gpt-5-mini, tags: [cheap] }",
      "",
    ].join("\n");
    const result = compile(cli("openai/gpt-5", "[all-code]", pool));
    expect(
      result.warnings.filter((w) => w.code === "provider-tool-cap-unverified").map((w) => w.path),
    ).toEqual(["agent.model_pool.candidates[0]", "agent.model_pool.candidates[1]"]);
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

  test("a list within the limit on OpenAI says nothing", () => {
    const n = expanded("[all-math]");
    expect(n).toBeLessThanOrEqual(128);
    const result = compile(cli("openai/gpt-5", "[all-math]"));
    expect(result.warnings.filter((w) => w.code.startsWith("provider-tool-cap"))).toEqual([]);
  });

  test("exactly at the limit passes; one over fails", () => {
    const keys = (
      lower(parseSpec(cli("claude-sonnet-4-6", "[all-code]"))) as {
        tools: ReadonlyArray<string>;
      }
    ).tools;
    const list = (count: number): string => `[${keys.slice(0, count).join(", ")}]`;
    expect(() => compile(cli("azure/big", list(128)))).not.toThrow();
    expect(() => compile(cli("azure/big", list(129)))).toThrow(/129 tools/);
    const openai = (count: number) =>
      compile(cli("openai/gpt-5", list(count))).warnings.filter(
        (w) => w.code === "provider-tool-cap-unverified",
      ).length;
    expect([openai(128), openai(129)]).toEqual([0, 1]);
  });
});

describe("a model over its limit beside one within it is a warning", () => {
  test("a fallback over the limit: the spec runs on the primary, the fallback is named", () => {
    const result = compile(
      cli("claude-sonnet-4-6", "[all-code]", "  model_fallbacks: [azure/gpt4o-deploy]\n"),
    );
    const caps = result.warnings.filter((w) => w.code === "provider-tool-cap");
    expect(caps.map((w) => w.path)).toEqual(["agent.model_fallbacks[0]"]);
    expect(caps[0]?.message).toContain(
      'exceed the 128-tool limit Azure OpenAI puts on one request, so every call to model "azure/gpt4o-deploy" is refused; the spec runs while another model serves.',
    );
  });

  test("the primary over the limit with a fallback within it still compiles, with the warning", () => {
    const result = compile(
      cli("groq/llama-3.3-70b-versatile", "[all-code]", "  model_fallbacks: [claude-sonnet-4-6]\n"),
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
      "      - { model: azure/mini, tags: [cheap], tools: [read, grep] }",
      "      - { model: azure/big, tags: [wide] }",
      "",
    ].join("\n");
    const result = compile(cli("claude-sonnet-4-6", "[all-code, read, grep]", pool));
    // Only the un-narrowed Azure candidate is over; the narrowed one sends two tools.
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
      "    model: azure/big",
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
      "  - name: d",
      "    instructions: d",
      "    model: openai/gpt-5",
      "    tools: [all-code]",
      "",
    ].join("\n");
    const { errors, warnings } = checkProviderToolLimits(lower(parseSpec(yaml)));
    expect(errors.map((e) => e.path)).toEqual(["steps[0].tools"]);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["provider-tool-cap-unverified", "steps[1].model_fallbacks[0]"],
      ["provider-tool-cap", "steps[1].model_fallbacks[1]"],
      ["provider-tool-cap-unverified", "steps[3].model"],
    ]);
  });
});
