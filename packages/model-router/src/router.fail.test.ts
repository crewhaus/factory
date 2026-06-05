/**
 * Failure-path coverage for `loadAdapter`: each optional provider adapter is
 * loaded via a dynamic `import()`, wrapped in a try/catch that re-throws a
 * `ConfigError` with a "not installed" hint when the import fails (the
 * optionalDependency is absent on the host).
 *
 * We can't actually uninstall the workspace adapters, so we drive the
 * `__adapterImporters` seam: each test swaps in a loader that rejects exactly
 * as a missing module would, then `__resetAdapterImporters()` restores the
 * real dynamic imports in afterEach. This is entirely in-process (no module
 * registry mutation), so nothing leaks into the real-adapter suite in
 * router.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError } from "@crewhaus/errors";
import {
  __adapterImporters,
  __resetAdapterImporters,
  clearAdapterCache,
  resolveModel,
} from "./router.js";

const ENV = { OPENAI_API_KEY: "sk-fake", GEMINI_API_KEY: "fake" };

describe("loadAdapter — missing optional adapter surfaces ConfigError", () => {
  beforeEach(() => clearAdapterCache());
  afterEach(() => {
    __resetAdapterImporters();
    clearAdapterCache();
  });

  test("openai/* — adapter-openai import failure wraps the cause", async () => {
    const cause = new Error("simulated: @crewhaus/adapter-openai not installed");
    __adapterImporters.openai = () => Promise.reject(cause);

    let thrown: unknown;
    try {
      await resolveModel("openai/gpt-4o-mini", ENV);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("@crewhaus/adapter-openai is not installed");
    expect((thrown as ConfigError).message).toContain("openai/*");
    // The original import error is preserved as the cause.
    expect((thrown as { cause?: unknown }).cause).toBe(cause);
  });

  test("local/* — also routes through the openai loader and fails loud", async () => {
    __adapterImporters.openai = () => Promise.reject(new Error("simulated missing openai adapter"));
    await expect(
      resolveModel("local/llama-3.1-8b@http://localhost:11434", ENV),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("gemini/* — adapter-gemini import failure wraps the cause", async () => {
    const cause = new Error("simulated: @crewhaus/adapter-gemini not installed");
    __adapterImporters.gemini = () => Promise.reject(cause);

    let thrown: unknown;
    try {
      await resolveModel("gemini/gemini-2.5-flash", ENV);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("@crewhaus/adapter-gemini is not installed");
    expect((thrown as ConfigError).message).toContain("gemini/*");
    expect((thrown as { cause?: unknown }).cause).toBe(cause);
  });

  test("bedrock/* — adapter-bedrock import failure wraps the cause", async () => {
    const cause = new Error("simulated: @crewhaus/adapter-bedrock not installed");
    __adapterImporters.bedrock = () => Promise.reject(cause);

    let thrown: unknown;
    try {
      await resolveModel("bedrock/anthropic.claude-sonnet-4-v1:0", ENV);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("@crewhaus/adapter-bedrock is not installed");
    expect((thrown as ConfigError).message).toContain("bedrock/*");
    expect((thrown as { cause?: unknown }).cause).toBe(cause);
  });

  test("__resetAdapterImporters restores the real loaders", async () => {
    // Break openai, then reset — the real adapter should load again.
    __adapterImporters.openai = () => Promise.reject(new Error("broken"));
    __resetAdapterImporters();
    clearAdapterCache();
    const r = await resolveModel("openai/gpt-4o-mini", ENV);
    expect(r.providerId).toBe("openai");
    expect(r.adapter.providerId).toBe("openai");
  });

  test("the default importers each resolve a real adapter module", async () => {
    // Directly invoke every default importer arrow so each closure body is
    // exercised (they back the optionalDependency lazy-loads).
    __resetAdapterImporters();
    const openai = await __adapterImporters.openai();
    const gemini = await __adapterImporters.gemini();
    const bedrock = await __adapterImporters.bedrock();
    expect(typeof openai.createOpenAIAdapter).toBe("function");
    expect(typeof gemini.createGeminiAdapter).toBe("function");
    expect(typeof bedrock.createBedrockAdapter).toBe("function");
  });
});
