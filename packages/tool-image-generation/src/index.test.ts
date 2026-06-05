/**
 * Tests for tool-image-generation. The mock provider gives us
 * deterministic test coverage; the openai provider is exercised via
 * an injected fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageGenerationError, imageGenerate, registerImageGenerationConfig } from "./index";

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env["OPENAI_API_KEY"] = undefined;
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
      return new Response(JSON.stringify({ data: [{ url: "https://example.com/img.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
      return new Response(JSON.stringify({ data: [{ url: "https://example.com/x.png" }] }), {
        status: 200,
      });
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

  test("error body read failure is swallowed by .catch(() => '')", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test";
    // A non-ok response whose .text() itself rejects exercises the
    // `.catch(() => "")` fallback on the error path (line ~145).
    const badResponse = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => {
        throw new Error("stream already consumed");
      },
    } as unknown as Response;
    const mockFetch: typeof globalThis.fetch = async () => badResponse;
    registerImageGenerationConfig({ provider: "openai", fetch: mockFetch });
    await expect(imageGenerate.execute({ prompt: "x" })).rejects.toThrow(
      /OpenAI image-generation request failed \(500/,
    );
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

describe("imageGenerate — defaultProvider env routing (no explicit provider)", () => {
  test("OPENAI_API_KEY present → routes to openai (uses injected fetch)", async () => {
    // No `provider` in config forces execute() through defaultProvider(env).
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["CREWHAUS_IMAGE_PROVIDER"] = undefined;
    let called = false;
    const mockFetch: typeof globalThis.fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ data: [{ url: "https://example.com/auto.png" }] }), {
        status: 200,
      });
    };
    registerImageGenerationConfig({ fetch: mockFetch });
    const out = await imageGenerate.execute({ prompt: "auto-routed" });
    expect(called).toBe(true);
    expect(out).toContain("https://example.com/auto.png");
  });

  test("no API key but CREWHAUS_IMAGE_PROVIDER=mock → routes to mock", async () => {
    process.env["OPENAI_API_KEY"] = undefined;
    process.env["CREWHAUS_IMAGE_PROVIDER"] = "mock";
    registerImageGenerationConfig({});
    const out = await imageGenerate.execute({ prompt: "offline lobster" });
    expect(out).toContain("mock image generated");
    expect(out).toContain("offline lobster");
  });

  test("neither env var set → falls through to openai, surfacing missing-key error", async () => {
    process.env["OPENAI_API_KEY"] = undefined;
    process.env["CREWHAUS_IMAGE_PROVIDER"] = undefined;
    registerImageGenerationConfig({});
    // defaultProvider returns "openai" (the documented fall-through); execute
    // then throws the clear missing-key error from generateOpenAI.
    await expect(imageGenerate.execute({ prompt: "x" })).rejects.toThrow(ImageGenerationError);
  });
});
