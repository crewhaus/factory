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

/**
 * Runs `body` with every regular expression run over a text that contains
 * `run` refused on the spot and recorded. Replacing `RegExp.prototype.exec`
 * routes every String and RegExp method that runs a pattern through it
 * (the test's control checks that for `String#replace`); restored after.
 */
function regexRunsOver<T>(run: string, body: () => T): { runs: string[]; outcome: T | Error } {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (typeof input === "string" && input.includes(run)) {
      runs.push(`/${this.source}/ over ${input.length} characters`);
      throw new Error(`/${this.source}/ ran over the run of slashes`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

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

  test("a query or fragment in the base URL is refused, and not echoed", () => {
    const token = ["sk", "proxy", "token", "9f2c"].join("-");
    for (const openaiBaseUrl of [
      `https://api.openai.com/v1?api_key=${token}`,
      `https://api.openai.com/v1#${token}`,
    ]) {
      let message = "";
      try {
        resolveOpenAIBaseUrl({ openaiBaseUrl }, {});
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("has a query or fragment");
      expect(message).not.toContain(token);
    }
  });

  // Attacker review (C008 residual): the parse-failure message quoted the
  // whole value, so a base URL that did not parse (a bad port) echoed a
  // credential in its query; a model-pool block reaches this per call.
  test("a base URL that does not parse is refused without quoting any of it", () => {
    const token = ["sk", "proj", "SECRET", "123"].join("-");
    for (const openaiBaseUrl of [
      `https://proxy.example.com:99999/v1?api_key=${token}`,
      `https://user:${token}@exa mple.com/v1`,
      `${token}`,
      `https://[${token}]/v1`,
    ]) {
      let message = "";
      try {
        resolveOpenAIBaseUrl({ openaiBaseUrl }, {});
      } catch (err) {
        message = (err as Error).message;
      }
      expect(`${openaiBaseUrl}: ${message.includes("is not an absolute URL")}`).toBe(
        `${openaiBaseUrl}: true`,
      );
      expect(message).not.toContain(token);
      expect(message).not.toContain("SECRET");
    }
  });

  // Attacker review: `/\/+$/` rescanned a run of slashes from every start,
  // quadratic in its length (about 5 s a scan for 100k slashes, 80 s for
  // 400k, at boot). Counted, not timed: URL parsing is native and linear,
  // so the only place that work can hide is a regular expression run over
  // the slashes. Each such run is refused on the spot and counted, so a
  // quadratic pattern fails at once instead of being waited out; the fix
  // strips with a loop from the end, and runs none.
  test("trailing slashes are stripped in linear time", () => {
    expect(resolveOpenAIBaseUrl({ openaiBaseUrl: "https://api.openai.com/v1///" }, {})).toBe(
      "https://api.openai.com/v1",
    );
    const slashes = "/".repeat(100_000);
    // Control: the count sees a pattern String#replace runs over the slashes.
    expect(regexRunsOver(slashes, () => `x${slashes}v1`.replace(/\/+$/, "")).runs).toEqual([
      `/\\/+$/ over ${slashes.length + 3} characters`,
    ]);
    const accepted = regexRunsOver(slashes, () =>
      resolveOpenAIBaseUrl({ openaiBaseUrl: `https://api.openai.com/${slashes}v1` }, {}),
    );
    expect(accepted.runs).toEqual([]);
    expect(String(accepted.outcome).endsWith(`${slashes}v1`)).toBe(true);
    // The refusal builds its approval hint from the parsed path: no pattern
    // runs over that either.
    const refused = regexRunsOver(slashes, () =>
      resolveOpenAIBaseUrl({ openaiBaseUrl: `https://proxy.example/${slashes}v1` }, {}),
    );
    expect(refused.runs).toEqual([]);
    expect(refused.outcome).toBeInstanceOf(ImageGenerationError);
    expect((refused.outcome as Error).message).toContain(
      "set OPENAI_BASE_URL=https://proxy.example/",
    );
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

  test("a per-call block that sets fetch is refused, not called as a function", async () => {
    process.env["OPENAI_API_KEY"] = KEY;
    Reflect.deleteProperty(process.env, "OPENAI_BASE_URL");
    await expect(
      imageGenerate.execute({ prompt: "a cat" }, {
        toolConfig: { provider: "openai", fetch: "http://attacker.example/" },
      } as never),
    ).rejects.toThrow("tool_config.imageGenerate.fetch is not a setting a spec can write");
  });

  test("a spec that sets fetch is refused, not called", () => {
    expect(() => registerImageGenerationConfig({ fetch: "x" } as never)).toThrow(
      "tool_config.imageGenerate.fetch is not a setting a spec can write",
    );
  });
});
