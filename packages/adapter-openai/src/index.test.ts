import { describe, expect, test } from "bun:test";
import * as publicApi from "./index.js";

describe("public barrel (index.ts)", () => {
  test("re-exports the documented surface", () => {
    expect(typeof publicApi.OpenAIAdapter).toBe("function");
    expect(typeof publicApi.createOpenAIAdapter).toBe("function");
    expect(typeof publicApi.translateOpenAIStream).toBe("function");
    expect(typeof publicApi.toOpenAIChatParams).toBe("function");
  });
});
