/**
 * v0.3.0 Goal 6 — `crewhaus doctor --probe` unit tests: plan building from
 * spec model + configured env (pure), and the ~1-token live probe against a
 * mocked adapter (no network) with recovery-engine classification of the
 * failures the probe exists to catch (billing / auth).
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import {
  DEFAULT_PROBE_MODELS,
  buildProbePlan,
  probeProvider,
  probeResultsToChecks,
  runProviderProbes,
} from "./doctor-probe";

// ---------- plan building (pure) ----------

describe("buildProbePlan", () => {
  test("spec model is probed verbatim for its provider", () => {
    const plan = buildProbePlan("claude-sonnet-4-6", {});
    expect(plan).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", reason: "spec-model" },
    ]);
  });

  test("other configured providers are probed on their cheap default model", () => {
    const plan = buildProbePlan("claude-sonnet-4-6", {
      OPENAI_API_KEY: "sk-x",
      GEMINI_API_KEY: "g-x",
    });
    expect(plan).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", reason: "spec-model" },
      { provider: "openai", model: DEFAULT_PROBE_MODELS.openai, reason: "configured-env" },
      { provider: "gemini", model: DEFAULT_PROBE_MODELS.gemini, reason: "configured-env" },
    ]);
  });

  test("the spec's provider is not double-probed via its default model", () => {
    const plan = buildProbePlan("openai/gpt-5-mini", { OPENAI_API_KEY: "sk-x" });
    expect(plan).toEqual([
      { provider: "openai", model: "openai/gpt-5-mini", reason: "spec-model" },
    ]);
  });

  test("no spec model + no env → empty plan", () => {
    expect(buildProbePlan(undefined, {})).toEqual([]);
  });

  test("bedrock is only probed when the spec selects it (no default model id)", () => {
    const plan = buildProbePlan("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", {
      AWS_REGION: "us-east-1",
    });
    expect(plan).toEqual([
      {
        provider: "bedrock",
        model: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        reason: "spec-model",
      },
    ]);
    // …and never via env alone.
    expect(buildProbePlan(undefined, { AWS_REGION: "us-east-1" })).toEqual([]);
  });
});

// ---------- probing (mocked adapter, no network) ----------

function mockAdapter(behaviour: "ok" | { throws: unknown }): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: (_req: ProviderRequest) =>
      (async function* () {
        if (behaviour !== "ok") throw behaviour.throws;
        yield { kind: "message_start", usage: { input: 3, output: 0 } } as const;
        yield {
          kind: "message_delta",
          stopReason: "max_tokens",
          usage: { input: 3, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

const target = { provider: "anthropic", model: "claude-haiku-4-5", reason: "spec-model" } as const;

describe("probeProvider", () => {
  test("a live 1-token exchange passes, with the duration in the detail", async () => {
    let t = 1000;
    const result = await probeProvider(target, {
      resolve: async () => ({ adapter: mockAdapter("ok"), modelId: "claude-haiku-4-5" }),
      now: () => {
        t += 150;
        return t;
      },
    });
    expect(result.pass).toBe(true);
    expect(result.detail).toBe("live call ok (150ms)");
    expect(result.failureClass).toBeUndefined();
  });

  test("the probe request is genuinely cheap: maxTokens 1, two-char prompt", async () => {
    let seen: ProviderRequest | undefined;
    const adapter: ProviderAdapter = {
      ...mockAdapter("ok"),
      stream: (req) => {
        seen = req;
        return mockAdapter("ok").stream(req);
      },
    };
    await probeProvider(target, {
      resolve: async () => ({ adapter, modelId: "claude-haiku-4-5" }),
    });
    expect(seen?.maxTokens).toBe(1);
    expect(seen?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(seen?.system).toEqual([]);
  });

  test("an unfunded account classifies as billing (the exact pre-run catch --probe exists for)", async () => {
    const billingErr = Object.assign(
      new Error("400 Your credit balance is too low to access the Anthropic API."),
      {
        providerId: "anthropic",
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      },
    );
    const result = await probeProvider(target, {
      resolve: async () => ({ adapter: mockAdapter({ throws: billingErr }), modelId: "m" }),
    });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("billing");
    expect(result.detail).toStartWith("billing — ");
    expect(result.detail).toContain("credit balance is too low");
  });

  test("an invalid key classifies as auth", async () => {
    const authErr = Object.assign(new Error("401 invalid x-api-key"), {
      providerId: "anthropic",
      status: 401,
      error: { type: "authentication_error", message: "invalid x-api-key" },
    });
    const result = await probeProvider(target, {
      resolve: async () => ({ adapter: mockAdapter({ throws: authErr }), modelId: "m" }),
    });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("auth");
    expect(result.detail).toStartWith("auth — ");
  });

  test("an unresolvable model (missing provider package / bad string) fails without a class prefix", async () => {
    const result = await probeProvider(target, {
      resolve: async () => {
        throw new Error("could not load @crewhaus/adapter-openai");
      },
    });
    expect(result.pass).toBe(false);
    expect(result.failureClass).toBe("unknown");
    expect(result.detail).toBe("could not load @crewhaus/adapter-openai");
  });
});

describe("runProviderProbes + probeResultsToChecks", () => {
  test("probes run in plan order and fold into doctor's ✓/✗ check shape", async () => {
    const authErr = Object.assign(new Error("401 nope"), { status: 401 });
    const byModel: Record<string, ProviderAdapter> = {
      "claude-haiku-4-5": mockAdapter("ok"),
      "openai/gpt-4o-mini": mockAdapter({ throws: authErr }),
    };
    const results = await runProviderProbes(
      [
        { provider: "anthropic", model: "claude-haiku-4-5", reason: "spec-model" },
        { provider: "openai", model: "openai/gpt-4o-mini", reason: "configured-env" },
      ],
      {
        resolve: async (m) => {
          const adapter = byModel[m];
          if (adapter === undefined) throw new Error(`no adapter for ${m}`);
          return { adapter, modelId: m };
        },
      },
    );
    expect(results.map((r) => r.pass)).toEqual([true, false]);
    const checks = probeResultsToChecks(results);
    expect(checks[0]?.pass).toBe(true);
    expect(checks[0]?.label).toStartWith("live probe: anthropic (claude-haiku-4-5) — live call ok");
    expect(checks[0]?.reason).toBeUndefined();
    expect(checks[1]).toEqual({
      label: "live probe: openai (openai/gpt-4o-mini)",
      pass: false,
      reason: "auth — 401 nope",
    });
  });
});
