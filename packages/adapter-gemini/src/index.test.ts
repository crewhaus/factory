import { describe, expect, test } from "bun:test";
import * as api from "./index.js";

describe("@crewhaus/adapter-gemini public surface", () => {
  test("re-exports the adapter, factory, and translation helpers", () => {
    expect(typeof api.GeminiAdapter).toBe("function");
    expect(typeof api.createGeminiAdapter).toBe("function");
    expect(typeof api.translateGeminiStream).toBe("function");
    expect(typeof api.toGeminiParams).toBe("function");
  });

  test("createGeminiAdapter produces a GeminiAdapter instance", () => {
    const adapter = api.createGeminiAdapter({ GEMINI_API_KEY: "k" });
    expect(adapter).toBeInstanceOf(api.GeminiAdapter);
  });
});
