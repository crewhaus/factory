/**
 * Tests for tool-image-generation. The mock provider gives us
 * deterministic test coverage; the openai provider is exercised via
 * an injected fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ImageGenerationError,
  imageGenerate,
  registerImageGenerationConfig,
} from "./index";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env["OPENAI_API_KEY"];
  registerImageGenerationConfig({});
});

afterEach(() => {
  process.env = savedEnv;
  registerImageGenerationConfig({});
});

describe("imageGenerate — schema + flags", () => {
  test("is non-destructive", () => {
    expect(imageGenerate.destructive).toBe(false);
  });

  test("name is 'ImageGenerate'", () => {
    expect(imageGenerate.name).toBe("ImageGenerate");
  });

  test("schema requires non-empty prompt", () => {
    expect(() => imageGenerate.inputSchema.parse({ prompt: "" })).toThrow();
    expect(() => imageGenerate.inputSchema.parse({ prompt: "ok" })).not.toThrow();
  });

  test("schema rejects unknown size", () => {
    expect(() => imageGenerate.inputSchema.parse({ prompt: "x", size: "999x999" })).toThrow();
  });
});

describe("imageGenerate — mock provider", () => {
  test("returns a deterministic stub", async () => {
    registerImageGenerationConfig({ provider: "mock" });
    const out = await imageGenerate.execute({ prompt: "a lobster on a beach" });
    expect(out).toContain("mock image generated");
    expect(out).toContain("a lobster on a beach");
  });
});

describe("imageGenerate — openai provider", () => {
  test("throws ImageGenerationError when OPENAI_API_KEY is unset", async () => {
    registerImageGenerationConfig({ provider: "openai" });
    await expect(imageGenerate.execute({ prompt: "x" })).rejects.toThrow(ImageGenerationError);
  });

  test("calls the openai endpoint with the configured model", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    let capturedUrl = "";
    let capturedBody = "";
    const mockFetch: typeof globalThis.fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ data: [{ url: "https://example.com/img.png" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    registerImageGenerationConfig({ provider: "openai", fetch: mockFetch });

    const out = await imageGenerate.execute({ prompt: "lobster" });
    expect(out).toContain("https://example.com/img.png");
    expect(capturedUrl).toBe("https://api.openai.com/v1/images/generations");
    const body = JSON.parse(capturedBody) as { model: string; prompt: string; size: string };
    expect(body.model).toBe("dall-e-3");
    expect(body.prompt).toBe("lobster");
    expect(body.size).toBe("1024x1024");
  });

  test("honors size + style overrides", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    let capturedBody = "";
    const mockFetch: typeof globalThis.fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ data: [{ url: "https://example.com/x.png" }] }),
        { status: 200 },
      );
    };
    registerImageGenerationConfig({ provider: "openai", fetch: mockFetch });
    await imageGenerate.execute({ prompt: "x", size: "1792x1024", style: "natural" });
    const body = JSON.parse(capturedBody) as { size: string; style: string };
    expect(body.size).toBe("1792x1024");
    expect(body.style).toBe("natural");
  });

  test("surfaces upstream errors", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    registerImageGenerationConfig({ provider: "openai", fetch: mockFetch });
    await expect(imageGenerate.execute({ prompt: "x" })).rejects.toThrow(ImageGenerationError);
  });

  test("b64_json response format returns a data URI preview", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    const longB64 = "A".repeat(500);
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: longB64 }] }), { status: 200 });
    registerImageGenerationConfig({ provider: "openai", fetch: mockFetch });
    const out = await imageGenerate.execute({ prompt: "x", responseFormat: "b64_json" });
    expect(out).toContain("data:image/png;base64,");
    expect(out).toContain("[truncated 500 bytes total]");
  });
});
