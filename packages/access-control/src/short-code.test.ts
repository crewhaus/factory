import { describe, expect, test } from "bun:test";
import { SHORT_CODE_ALPHABET, mintShortCode, normalizeShortCode } from "./short-code";

describe("short codes", () => {
  test("eight consonants, shown XXXX-XXXX, no vowel and no look-alike", () => {
    expect(SHORT_CODE_ALPHABET).toHaveLength(20);
    for (const letter of "AEIOUY01") expect(SHORT_CODE_ALPHABET).not.toContain(letter);
    for (let i = 0; i < 200; i++) {
      const code = mintShortCode();
      expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
      for (const letter of code.replace("-", "")) expect(SHORT_CODE_ALPHABET).toContain(letter);
    }
  });

  test("case, the hyphen and spaces do not matter; anything else is not a code", () => {
    expect(normalizeShortCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeShortCode("bcdfghjk")).toBe("BCDF-GHJK");
    expect(normalizeShortCode(" BCDF GHJK ")).toBe("BCDF-GHJK");
    for (const bad of ["BCDF-GHJ", "BCDF-GHJKL", "ABCD-EFGH", "BCDF-GHJ1", "", 12345678]) {
      expect(normalizeShortCode(bad)).toBeUndefined();
    }
  });
});
