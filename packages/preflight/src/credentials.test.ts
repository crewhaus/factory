import { describe, expect, test } from "bun:test";
import {
  anthropicAuthMode,
  buildCredentialChecks,
  collectSpecModels,
  extractSpecModel,
  hasLiveProviderCredentials,
  modelCredentialChecks,
  modelCredentialGroups,
  modelCredentialItems,
  providerCredentialsSatisfied,
  providerEnvStubs,
  selectedProvider,
} from "./credentials";

const yamlFor = (model: string): string =>
  `name: t\ntarget: cli\nagent:\n  model: ${model}\n  instructions: hi\n`;

// Never a realistic secret shape — built from parts.
const FAKE_KEY = ["sk", "test", "not", "real"].join("-");
const FAKE_OAUTH = ["sk-ant-oat", "01", "fixture"].join("");

describe("anthropicAuthMode (resolveAuth precedence mirror)", () => {
  test("AUTH_TOKEN wins over API_KEY; oat prefix means oauth", () => {
    expect(
      anthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: FAKE_OAUTH, ANTHROPIC_API_KEY: FAKE_KEY }),
    ).toBe("oauth");
    expect(anthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: FAKE_KEY })).toBe("api-key");
    expect(anthropicAuthMode({ ANTHROPIC_API_KEY: FAKE_KEY })).toBe("api-key");
    expect(anthropicAuthMode({})).toBe("none");
    expect(anthropicAuthMode({ ANTHROPIC_AUTH_TOKEN: "" })).toBe("none");
  });
});

describe("extractSpecModel", () => {
  test("extracts agent.model from a valid spec", () => {
    expect(extractSpecModel(yamlFor("openai/gpt-4o-mini"))).toBe("openai/gpt-4o-mini");
  });

  test("returns undefined for an unparseable spec (must not crash)", () => {
    expect(extractSpecModel("name: t\ntarget: cli\n")).toBeUndefined();
    expect(extractSpecModel(":::not yaml at all")).toBeUndefined();
  });
});

describe("selectedProvider", () => {
  test("maps the full router grammar to doctor providers", () => {
    expect(selectedProvider("claude-sonnet-4-5")).toBe("anthropic");
    expect(selectedProvider("openai/gpt-4o-mini")).toBe("openai");
    expect(selectedProvider("gemini/gemini-2.5-flash")).toBe("gemini");
    expect(selectedProvider("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "bedrock",
    );
    // local/<m>@<url> parses to openai WITH a baseUrl → credential-free.
    expect(selectedProvider("local/llama3.2@http://localhost:11434/v1")).toBe("local");
  });

  test("returns undefined for unrecognised model strings", () => {
    expect(selectedProvider("gpt-4o-mini")).toBeUndefined();
  });
});

describe("buildCredentialChecks — model-aware (doctor parity)", () => {
  test("openai spec + OPENAI_API_KEY passes; missing Anthropic creds do NOT fail", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", { OPENAI_API_KEY: FAKE_KEY });
    const selected = checks[0];
    expect(selected?.label).toContain("OpenAI credentials");
    expect(selected?.pass).toBe(true);
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks.some((c) => c.label.includes("Anthropic") && !c.pass)).toBe(false);
  });

  test("openai spec accepts OPENAI_BASE_URL as the credential surface", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", {
      OPENAI_BASE_URL: "http://vllm:8000/v1",
    });
    expect(checks[0]?.pass).toBe(true);
  });

  test("openai spec without provider env FAILS the selected check", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", {});
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("OPENAI_API_KEY");
  });

  test("gemini spec: GEMINI_API_KEY, GOOGLE_API_KEY, or Vertex env all satisfy", () => {
    expect(buildCredentialChecks("gemini/gemini-2.5-flash", { GEMINI_API_KEY: "g" })[0]?.pass).toBe(
      true,
    );
    expect(buildCredentialChecks("gemini/gemini-2.5-flash", { GOOGLE_API_KEY: "g" })[0]?.pass).toBe(
      true,
    );
    expect(
      buildCredentialChecks("gemini/gemini-2.5-flash", {
        GOOGLE_GENAI_USE_VERTEXAI: "1",
        GOOGLE_CLOUD_PROJECT: "p",
      })[0]?.pass,
    ).toBe(true);
    expect(buildCredentialChecks("gemini/gemini-2.5-flash", {})[0]?.pass).toBe(false);
  });

  test("bedrock spec is INFORMATIONAL — never fails even with no AWS env", () => {
    const none = buildCredentialChecks("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", {});
    expect(none[0]?.pass).toBe(true);
    expect(none[0]?.warn).toBe(true);
    expect(none[0]?.reason).toContain("SDK default credential chain");
    const some = buildCredentialChecks("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0", {
      AWS_PROFILE: "dev",
    });
    expect(some[0]?.pass).toBe(true);
  });

  test("local spec needs no credentials", () => {
    const checks = buildCredentialChecks("local/llama3.2@http://localhost:11434/v1", {});
    expect(checks[0]?.pass).toBe(true);
    expect(checks[0]?.label).toContain("Local endpoint");
  });

  test("non-selected providers with env set surface as informational warn lines", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", {
      OPENAI_API_KEY: FAKE_KEY,
      ANTHROPIC_API_KEY: FAKE_KEY,
    });
    const anthropicLine = checks.find((c) => c.label.includes("Anthropic"));
    expect(anthropicLine?.pass).toBe(true);
    expect(anthropicLine?.warn).toBe(true);
    expect(anthropicLine?.label).toContain("not required");
  });
});

describe("buildCredentialChecks — no spec model (legacy fallback parity)", () => {
  test("Anthropic creds present → plain pass", () => {
    const checks = buildCredentialChecks(undefined, { ANTHROPIC_API_KEY: FAKE_KEY });
    expect(checks).toEqual([{ label: "Anthropic credentials", pass: true }]);
  });

  test("no creds at all → hard fail", () => {
    const checks = buildCredentialChecks(undefined, {});
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("missing Anthropic creds downgrade to informational when another provider env is set", () => {
    const checks = buildCredentialChecks(undefined, { OPENAI_API_KEY: FAKE_KEY });
    expect(checks[0]?.pass).toBe(true);
    expect(checks[0]?.warn).toBe(true);
    expect(checks[0]?.reason).toContain("OpenAI");
  });
});

describe("providerCredentialsSatisfied / providerEnvStubs", () => {
  test("matches statusFor semantics and returns false for junk", () => {
    expect(providerCredentialsSatisfied("claude-sonnet-4-5", { ANTHROPIC_API_KEY: FAKE_KEY })).toBe(
      true,
    );
    expect(providerCredentialsSatisfied("claude-sonnet-4-5", {})).toBe(false);
    expect(providerCredentialsSatisfied("not-a-model", { ANTHROPIC_API_KEY: FAKE_KEY })).toBe(
      false,
    );
  });

  test("stub tables: one representative var; bedrock/local none", () => {
    expect(providerEnvStubs("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
    expect(providerEnvStubs("bedrock")).toEqual([]);
    expect(providerEnvStubs("local")).toEqual([]);
  });
});

describe("modelCredentialGroups / modelCredentialChecks (channel boot-gate parity)", () => {
  test("groups mirror the channel emitter", () => {
    expect(modelCredentialGroups("claude-sonnet-4-5")).toEqual([
      ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    ]);
    expect(modelCredentialGroups("openai/gpt-4o-mini")).toEqual([
      ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    ]);
    expect(modelCredentialGroups("gemini/gemini-2.5-flash")).toEqual([
      ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    ]);
    expect(modelCredentialGroups("local/llama3.2@http://localhost:11434/v1")).toEqual([]);
    expect(modelCredentialGroups("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0")).toEqual([]);
    expect(modelCredentialGroups("not a model")).toEqual([]);
  });

  test("failing check names the group and the boot consequence", () => {
    const checks = modelCredentialChecks("claude-sonnet-4-5", {});
    expect(checks).toHaveLength(1);
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    expect(checks[0]?.reason).toContain("exits at boot");
  });
});

// ---------------------------------------------------------------------------
// The preflight matrix
// ---------------------------------------------------------------------------

const POOL_SPEC = {
  target: "cli",
  agent: {
    model: "claude-sonnet-4-5",
    model_fallbacks: ["openai/gpt-4o-mini", "gemini/gemini-2.5-flash"],
    model_pool: {
      candidates: [{ model: "groq/llama-3.3-70b" }, { model: "claude-sonnet-4-5" }],
    },
  },
  evaluation: { grader: { type: "llm_judge", model: "openai/gpt-4o-mini", criteria: "c" } },
  budget: { usd: 5, on_exceed: { action: "degrade", model: "local/llama3.2" } },
};

describe("collectSpecModels", () => {
  test("collects the union across agent/model routing/judge/budget, deduped", () => {
    const models = collectSpecModels(POOL_SPEC);
    const byModel = new Map(models.map((m) => [m.model, m.sources]));
    expect(byModel.get("claude-sonnet-4-5")).toEqual([
      "agent.model",
      "agent.model_pool.candidates[1]",
    ]);
    expect(byModel.get("openai/gpt-4o-mini")).toEqual([
      "agent.model_fallbacks[0]",
      "evaluation.grader.model",
    ]);
    expect(byModel.has("gemini/gemini-2.5-flash")).toBe(true);
    expect(byModel.has("groq/llama-3.3-70b")).toBe(true);
    expect(byModel.has("local/llama3.2")).toBe(true);
    expect(models).toHaveLength(5);
  });

  test("model_tiers contributes both tiers; junk input contributes nothing", () => {
    const models = collectSpecModels({
      agent: { model_tiers: { fast: "claude-haiku-4", default: "claude-sonnet-4-5" } },
    });
    expect(models.map((m) => m.model).sort()).toEqual(["claude-haiku-4", "claude-sonnet-4-5"]);
    expect(collectSpecModels(undefined)).toEqual([]);
    expect(collectSpecModels("nope")).toEqual([]);
  });
});

describe("modelCredentialItems", () => {
  test("missing creds per provider are blocking with a will-not-boot message", () => {
    const items = modelCredentialItems(collectSpecModels(POOL_SPEC), {});
    const blocking = items.filter((i) => i.level === "blocking");
    const keys = blocking.map((i) => i.id).sort();
    expect(keys).toEqual([
      "credentials.anthropic",
      "credentials.gemini",
      "credentials.host:groq",
      "credentials.openai",
    ]);
    const anthropic = blocking.find((i) => i.id === "credentials.anthropic");
    expect(anthropic?.message).toContain("will not boot");
    expect(anthropic?.message).toContain("claude-sonnet-4-5");
    expect(anthropic?.envVar).toBe("ANTHROPIC_API_KEY");
    const groq = blocking.find((i) => i.id === "credentials.host:groq");
    expect(groq?.message).toContain("GROQ_API_KEY");
    expect(groq?.envVar).toBe("GROQ_API_KEY");
    // local endpoint is info, never blocking.
    const local = items.find((i) => i.id.startsWith("credentials.local:"));
    expect(local?.level).toBe("info");
  });

  test("satisfied creds collapse to info items; one item per provider", () => {
    const env = {
      ANTHROPIC_API_KEY: FAKE_KEY,
      OPENAI_API_KEY: FAKE_KEY,
      GEMINI_API_KEY: FAKE_KEY,
      GROQ_API_KEY: FAKE_KEY,
    };
    const items = modelCredentialItems(collectSpecModels(POOL_SPEC), env);
    expect(items.filter((i) => i.level === "blocking")).toEqual([]);
    const anthropic = items.find((i) => i.id === "credentials.anthropic");
    expect(anthropic?.level).toBe("info");
    expect(anthropic?.message).toContain("api-key credentials found");
  });

  test("bedrock and vertex are informational; unparseable strings are skipped", () => {
    const items = modelCredentialItems(
      [
        { model: "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0", sources: ["agent.model"] },
        { model: "vertex/claude-sonnet-4-5", sources: ["agent.model_fallbacks[0]"] },
        { model: "cheapest", sources: ["evaluation.grader.model"] },
      ],
      {},
    );
    expect(items.every((i) => i.level === "info")).toBe(true);
    expect(items.find((i) => i.id === "credentials.bedrock")?.message).toContain(
      "SDK default credential chain",
    );
    expect(items.find((i) => i.id === "credentials.vertex-adc")?.message).toContain(
      "Application Default Credentials",
    );
    expect(items.some((i) => i.message.includes("cheapest"))).toBe(false);
  });

  test("azure requires endpoint AND key", () => {
    const models = [{ model: "azure/my-deployment", sources: ["agent.model"] }];
    expect(modelCredentialItems(models, { AZURE_OPENAI_API_KEY: FAKE_KEY })[0]?.level).toBe(
      "blocking",
    );
    expect(
      modelCredentialItems(models, {
        AZURE_OPENAI_API_KEY: FAKE_KEY,
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      })[0]?.level,
    ).toBe("info");
  });
});

describe("hasLiveProviderCredentials", () => {
  test("true only when a spendable provider's creds are visibly set", () => {
    const models = collectSpecModels(POOL_SPEC);
    expect(hasLiveProviderCredentials(models, {})).toBe(false);
    expect(hasLiveProviderCredentials(models, { ANTHROPIC_API_KEY: FAKE_KEY })).toBe(true);
    // Ambient/local providers never count.
    expect(
      hasLiveProviderCredentials([{ model: "local/llama3.2", sources: ["agent.model"] }], {
        OPENAI_API_KEY: FAKE_KEY,
      }),
    ).toBe(false);
    expect(
      hasLiveProviderCredentials(
        [{ model: "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0", sources: ["agent.model"] }],
        { AWS_PROFILE: "dev" },
      ),
    ).toBe(false);
  });
});

describe("0.6.0 §4.3 — $profile references resolve against the spec's models: block", () => {
  const registrySpec = (model: string): string =>
    [
      "name: t",
      "target: cli",
      "models:",
      "  fast: { model: openai/gpt-4o-mini }",
      "  tbd: { model: strongest }",
      "agent:",
      `  model: ${model}`,
      "  instructions: hi",
    ].join("\n");

  test("extractSpecModel follows $fast to the profile's model, so selectedProvider gets a grammar string", () => {
    expect(extractSpecModel(registrySpec("$fast"))).toBe("openai/gpt-4o-mini");
    expect(selectedProvider(extractSpecModel(registrySpec("$fast")) ?? "")).toBe("openai");
  });

  test("the tolerant contract holds: a profile whose model is a compile-time sentinel yields undefined", () => {
    expect(extractSpecModel(registrySpec("$tbd"))).toBeUndefined();
  });

  test("collectSpecModels follows $refs at every slot and lists each profile under models.<name>", () => {
    const models = collectSpecModels({
      models: { fast: { model: "openai/gpt-4o-mini" }, strong: { model: "claude-opus-4-8" } },
      agent: {
        model: "$fast",
        model_pool: { candidates: [{ model: "$strong" }, { model: "gemini/gemini-2.5-flash" }] },
      },
      evaluation: { grader: { type: "llm_judge", judges: ["$strong"], criteria: "c" } },
      budget: { on_exceed: { action: "degrade", model: "$nope" } },
    });
    const byModel = new Map(models.map((m) => [m.model, m.sources]));
    expect(byModel.get("openai/gpt-4o-mini")).toEqual(["models.fast", "agent.model"]);
    expect(byModel.get("claude-opus-4-8")).toEqual([
      "models.strong",
      "agent.model_pool.candidates[0]",
      "evaluation.grader.judges[0]",
    ]);
    expect(byModel.has("gemini/gemini-2.5-flash")).toBe(true);
    // An unresolvable ref contributes nothing (the spec layer owns that error).
    expect(models.some((m) => m.model.startsWith("$"))).toBe(false);
    expect(models).toHaveLength(3);
  });
});
