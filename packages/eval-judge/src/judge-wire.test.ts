import { afterAll, describe, expect, test } from "bun:test";
import { makeNaiveStubClient } from "./__test__/stub-client";
import { judge } from "./judge";
import type { Rubric } from "./rubric";

/**
 * Cross-provider wire-model regression tests.
 *
 * The bug: `judge()` resolved the adapter via `resolveModel(model)` but
 * passed the FULL prefixed router string (e.g. "openai/gpt-4o-mini") as
 * `req.model`, so every non-Anthropic judge died with model-not-found at
 * the provider. The fix mirrors the planner: use the resolution's
 * stripped `modelId` as the wire model, and keep the model as-is only
 * when the caller injects an adapter.
 *
 * Strategy (no module mocks — they leak across Bun test files):
 *   - Spin a local OpenAI-shaped capture server with `Bun.serve` and
 *     point a `local/<model>@<url>` router string at it. The router
 *     resolves a REAL `@crewhaus/adapter-openai` (no API key needed for
 *     local baseURLs), so the captured request body is exactly what a
 *     non-Anthropic provider would receive on the wire.
 *   - Assert the body's `model` is the STRIPPED id, not the prefixed
 *     router string.
 */

const RUBRIC: Rubric = {
  criteria: [{ name: "quality", anchors: { 1: "bad", 5: "good" } }],
  passing_score: 3,
} as unknown as Rubric;

const SAMPLE = { id: "s1", input: "What is 2+2?", expected_output: "4" };

const captured: Array<{ model?: string }> = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    captured.push((await req.json()) as { model?: string });
    // 400 (not 5xx) so the OpenAI SDK fails fast without retries.
    return new Response(JSON.stringify({ error: { message: "capture-only endpoint" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  },
});

afterAll(() => {
  server.stop(true);
});

describe("judge wire model (cross-provider)", () => {
  test("a router-resolved non-Anthropic judge sends the STRIPPED modelId on the wire", async () => {
    captured.length = 0;
    const routerString = `local/test-judge-model@http://127.0.0.1:${server.port}/v1`;
    // The capture server rejects the call, so judge() must throw — the
    // assertion under test is what reached the wire first.
    await expect(
      judge({
        rubric: RUBRIC,
        sample: SAMPLE,
        agentOutput: "4",
        model: routerString,
      }),
    ).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.model).toBe("test-judge-model");
    // Regression anchor: the full prefixed router string must NOT leak.
    expect(captured[0]?.model).not.toContain("local/");
    expect(captured[0]?.model).not.toContain("@");
  });

  test("an injected adapter keeps the model as-is (test seam unchanged)", async () => {
    let seenModel: string | undefined;
    const adapter = makeNaiveStubClient(() => ({
      score: 4 as const,
      rationale: "fine",
      criterion_scores: { quality: 4 },
    }));
    const baseStream = adapter.stream.bind(adapter);
    const spyAdapter = {
      ...adapter,
      stream: (req: Parameters<typeof baseStream>[0]) => {
        seenModel = req.model;
        return baseStream(req);
      },
    };
    const result = await judge({
      rubric: RUBRIC,
      sample: SAMPLE,
      agentOutput: "4",
      adapter: spyAdapter,
      model: "synthetic-id-the-stub-ignores",
    });
    expect(result.score).toBe(4);
    expect(seenModel).toBe("synthetic-id-the-stub-ignores");
  });
});
