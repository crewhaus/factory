import { describe, expect, test } from "bun:test";
import {
  buildChannelEnvChecks,
  buildCredentialChecks,
  extractSpecModel,
  selectedProvider,
} from "./doctor-checks";

const yamlFor = (model: string): string =>
  `name: t\ntarget: cli\nagent:\n  model: ${model}\n  instructions: hi\n`;

describe("extractSpecModel", () => {
  test("extracts agent.model from a valid spec", () => {
    expect(extractSpecModel(yamlFor("openai/gpt-4o-mini"))).toBe("openai/gpt-4o-mini");
  });

  test("returns undefined for an unparseable spec (doctor must not crash)", () => {
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

describe("buildCredentialChecks — model-aware", () => {
  test("openai spec + OPENAI_API_KEY passes; missing Anthropic creds do NOT fail", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", { OPENAI_API_KEY: "sk-x" });
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
    const missing = buildCredentialChecks("gemini/gemini-2.5-flash", {});
    expect(missing[0]?.pass).toBe(false);
  });

  test("bedrock spec is INFORMATIONAL — never fails even with no AWS env (SDK chain is authoritative)", () => {
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

  test("non-selected providers with env set surface as informational warn lines, not failures", () => {
    const checks = buildCredentialChecks("openai/gpt-4o-mini", {
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant",
    });
    const anthropicLine = checks.find((c) => c.label.includes("Anthropic"));
    expect(anthropicLine?.pass).toBe(true);
    expect(anthropicLine?.warn).toBe(true);
    expect(anthropicLine?.label).toContain("not required");
  });
});

describe("buildCredentialChecks — no spec model (legacy fallback)", () => {
  test("Anthropic creds present → plain pass (unchanged behaviour)", () => {
    const checks = buildCredentialChecks(undefined, { ANTHROPIC_API_KEY: "sk-ant" });
    expect(checks).toEqual([{ label: "Anthropic credentials", pass: true }]);
  });

  test("no creds at all → hard fail (unchanged behaviour)", () => {
    const checks = buildCredentialChecks(undefined, {});
    expect(checks[0]?.pass).toBe(false);
    expect(checks[0]?.reason).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("missing Anthropic creds downgrade to informational when another provider env is clearly set", () => {
    const checks = buildCredentialChecks(undefined, { OPENAI_API_KEY: "sk-x" });
    expect(checks[0]?.pass).toBe(true);
    expect(checks[0]?.warn).toBe(true);
    expect(checks[0]?.reason).toContain("OpenAI");
  });
});

// Item 61 — channel-target env checks (buildChannelEnvChecks lowers the cwd
// spec and only contributes checks when it is a channel IR).
const CHANNEL_YAML = `
name: support-bot
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: Answer briefly.
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: inline-literal-secret
routing:
  sessionKey: channel
`;

describe("buildChannelEnvChecks (item 61)", () => {
  test("non-channel specs and unparseable text contribute no checks", () => {
    expect(buildChannelEnvChecks(yamlFor("claude-sonnet-4-6"), {})).toEqual([]);
    expect(buildChannelEnvChecks(":::not yaml at all", {})).toEqual([]);
  });

  test("one check per configured platform; env-refs asserted, literals exempt", () => {
    const checks = buildChannelEnvChecks(CHANNEL_YAML, {
      SLACK_BOT_TOKEN: "xoxb-x",
      SLACK_SIGNING_SECRET: "s",
      TELEGRAM_BOT_TOKEN: "123:t",
    });
    expect(checks).toHaveLength(2);
    expect(checks[0]?.label).toContain("Slack channel env");
    expect(checks[0]?.pass).toBe(true);
    // secretToken is an inline literal — only the botToken env-ref is listed.
    expect(checks[1]?.label).toBe("Telegram channel env (TELEGRAM_BOT_TOKEN)");
    expect(checks[1]?.pass).toBe(true);
  });

  test("missing env-refs fail with the unset names and the channel-verify pointer", () => {
    const checks = buildChannelEnvChecks(CHANNEL_YAML, { SLACK_BOT_TOKEN: "xoxb-x" });
    const slack = checks.find((c) => c.label.includes("Slack"));
    expect(slack?.pass).toBe(false);
    expect(slack?.reason).toContain("$SLACK_SIGNING_SECRET");
    expect(slack?.reason).toContain("crewhaus channel verify");
  });
});
