/**
 * config-delivery#1: a spec's `openaiBaseUrl` decided where OPENAI_API_KEY
 * went — plain http, loopback or any host. Now the key goes to
 * api.openai.com unless the operator approves another origin outside the
 * spec (OPENAI_BASE_URL), and never over plain http off loopback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ImageGenerationError,
  imageGenerate,
  registerImageGenerationConfig,
  resolveOpenAIBaseUrl,
} from "./index";

const KEY = "sk-canary-OPENAI-1234567890";

describe("resolveOpenAIBaseUrl", () => {
  test("the default, and api.openai.com under any path, need no approval", () => {
    expect(resolveOpenAIBaseUrl({}, {})).toBe("https://api.openai.com/v1");
    expect(resolveOpenAIBaseUrl({ openaiBaseUrl: "https://api.openai.com/v1/" }, {})).toBe(
      "https://api.openai.com/v1",
    );
  });

  test("another https origin is refused until the operator approves it", () => {
    const cfg = { openaiBaseUrl: "https://proxy.example/v1" };
    expect(() => resolveOpenAIBaseUrl(cfg, {})).toThrow(
      "tool_config.imageGenerate.openaiBaseUrl would send OPENAI_API_KEY to https://proxy.example. A spec cannot choose where the key goes; to approve this endpoint, set OPENAI_BASE_URL=https://proxy.example/v1 in the environment the harness starts in.",
    );
    expect(() =>
      resolveOpenAIBaseUrl(cfg, { OPENAI_BASE_URL: "https://other.example/v1" }),
    ).toThrow(ImageGenerationError);
    expect(resolveOpenAIBaseUrl(cfg, { OPENAI_BASE_URL: "https://proxy.example/v1" })).toBe(
      "https://proxy.example/v1",
    );
  });

  test("plain http is refused off loopback even when approved, and on loopback unless approved", () => {
    expect(() =>
      resolveOpenAIBaseUrl(
        { openaiBaseUrl: "http://proxy.example/v1" },
        { OPENAI_BASE_URL: "http://proxy.example/v1" },
      ),
    ).toThrow("is plain http, which would send OPENAI_API_KEY unencrypted");
    expect(() => resolveOpenAIBaseUrl({ openaiBaseUrl: "http://127.0.0.1:18081/v1" }, {})).toThrow(
      "set OPENAI_BASE_URL=http://127.0.0.1:18081/v1",
    );
    expect(
      resolveOpenAIBaseUrl(
        { openaiBaseUrl: "http://127.0.0.1:18081/v1" },
        { OPENAI_BASE_URL: "http://127.0.0.1:18081/v1" },
      ),
    ).toBe("http://127.0.0.1:18081/v1");
  });

  test("userinfo in the URL is refused", () => {
    expect(() =>
      resolveOpenAIBaseUrl({ openaiBaseUrl: "https://u:p@api.openai.com/v1" }, {}),
    ).toThrow("carries user:password@");
  });
});

describe("the key never leaves for an unapproved host", () => {
  const saved = { key: process.env["OPENAI_API_KEY"], base: process.env["OPENAI_BASE_URL"] };
  afterEach(() => {
    if (saved.key === undefined) Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    else process.env["OPENAI_API_KEY"] = saved.key;
    if (saved.base === undefined) Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    else process.env["OPENAI_BASE_URL"] = saved.base;
    registerImageGenerationConfig({});
  });

  test("a spec block pointing at plain-http loopback fails at boot", () => {
    Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    expect(() =>
      registerImageGenerationConfig({
        provider: "openai",
        openaiBaseUrl: "http://127.0.0.1:18081/v1",
      }),
    ).toThrow("is plain http");
  });

  test("a per-call block pointing elsewhere is refused before anything is sent", async () => {
    process.env["OPENAI_API_KEY"] = KEY;
    Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    const sent: string[] = [];
    const fetchSpy = (async (url: string, init?: RequestInit) => {
      sent.push(`${url} ${JSON.stringify(init?.headers)}`);
      return Response.json({ data: [{ url: "https://img.example/1.png" }] });
    }) as unknown as typeof fetch;
    registerImageGenerationConfig({ provider: "openai", fetch: fetchSpy });
    await expect(
      imageGenerate.execute({ prompt: "a cat" }, {
        toolConfig: {
          provider: "openai",
          openaiBaseUrl: "https://attacker.example/v1",
          fetch: fetchSpy,
        },
      } as never),
    ).rejects.toThrow("would send OPENAI_API_KEY to https://attacker.example");
    expect(sent).toEqual([]);
  });

  test("a spec that sets fetch is refused, not called", () => {
    expect(() => registerImageGenerationConfig({ fetch: "x" } as never)).toThrow(
      "tool_config.imageGenerate.fetch is not a setting a spec can write",
    );
  });
});
