import { describe, expect, test } from "bun:test";
import { MAX_REMEMBERED, geminiCallIdFor, rememberGeminiCallId } from "./call-ids.js";

describe("the Gemini call ids a process keeps", () => {
  test("are bounded: past the limit the oldest is forgotten, and answers fall back", () => {
    const tag = `bound_${Date.now()}`;
    for (let i = 0; i <= MAX_REMEMBERED; i++) rememberGeminiCallId(`${tag}_${i}`, `fc_${i}`);
    expect(geminiCallIdFor(`${tag}_0`)).toBeUndefined();
    expect(geminiCallIdFor(`${tag}_1`)).toBe("fc_1");
    expect(geminiCallIdFor(`${tag}_${MAX_REMEMBERED}`)).toBe(`fc_${MAX_REMEMBERED}`);
  });
});
