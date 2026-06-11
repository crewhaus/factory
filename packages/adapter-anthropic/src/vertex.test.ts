import { describe, expect, test } from "bun:test";
import { ProviderAuthError } from "@crewhaus/errors";
import { AnthropicAdapter } from "./adapter.js";
import { createAnthropicVertexAdapter } from "./vertex.js";

describe("createAnthropicVertexAdapter", () => {
  test("builds an AnthropicAdapter from ANTHROPIC_VERTEX_PROJECT_ID", async () => {
    const a = await createAnthropicVertexAdapter({
      ANTHROPIC_VERTEX_PROJECT_ID: "fake-project",
    } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(AnthropicAdapter);
    expect(a.providerId).toBe("anthropic");
  });

  test("falls back to GOOGLE_CLOUD_PROJECT for the project id", async () => {
    const a = await createAnthropicVertexAdapter({
      GOOGLE_CLOUD_PROJECT: "fake-project",
      GOOGLE_CLOUD_LOCATION: "europe-west1",
    } as NodeJS.ProcessEnv);
    expect(a).toBeInstanceOf(AnthropicAdapter);
  });

  test("no project id → ProviderAuthError naming the env vars", async () => {
    await expect(createAnthropicVertexAdapter({} as NodeJS.ProcessEnv)).rejects.toThrow(
      /ANTHROPIC_VERTEX_PROJECT_ID/,
    );
    await expect(createAnthropicVertexAdapter({} as NodeJS.ProcessEnv)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });
});
