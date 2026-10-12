/**
 * Anchor text's trailing decoration is read one code point at a time, as
 * ECMAScript's `u` flag specifies: a surrogate pair is one code point, and
 * any other code unit, a lone surrogate included, is one on its own.
 *
 * The strip this replaced, `/[^\p{L}\p{N}]+$/u`, ran in JavaScriptCore, which
 * in Bun 1.3.14 departs from that. Its `u` matcher reads a unit in
 * U+D800-U+DBFF or U+F800-U+FBFF followed by one in U+DC00-U+DFFF or
 * U+FC00-U+FFFF as one supplementary code point, as if it tested the pair
 * with a 0xDC00 mask where 0xFC00 is needed. Two ordinary characters (an
 * Arabic presentation form or a CJK compatibility ideograph, then a fullwidth
 * form, an Arabic presentation form B or a variation selector) then read as
 * one unassigned code point, so the old strip removed both even when both
 * are letters; and such a letter before a lone trail surrogate kept the
 * surrogate. V8 answers as the specification does, and so does the helper.
 *
 * Every expected value is written out rather than asked of the engine, so
 * these tests hold whatever a later engine does. The table test walks a few
 * hundred thousand generated inputs and declares a 20 s budget, as the house
 * does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { isUninformativeAnchor, withoutTrailingDecoration } from "./lib/seo";

describe("trailing decoration is read by code point, as the u flag specifies", () => {
  test("two letters JavaScriptCore read as one unassigned code point both stay", () => {
    // ARABIC LETTER PEH ISOLATED FORM, ARABIC LETTER ALEF FINAL FORM
    expect(withoutTrailingDecoration("ﭖﺎ")).toBe("ﭖﺎ");
    // CJK COMPATIBILITY IDEOGRAPH-F900, FULLWIDTH LATIN SMALL LETTER A
    expect(withoutTrailingDecoration("豈ａ")).toBe("豈ａ");
    // ARABIC LIGATURE TEH WITH JEEM ISOLATED FORM after a lone lead surrogate
    expect(withoutTrailingDecoration("x\uD800ﰌ")).toBe("x\uD800ﰌ");
  });

  test("decoration after such a letter goes and the letter stays", () => {
    // FULLWIDTH EXCLAMATION MARK after the ideograph
    expect(withoutTrailingDecoration("read more 豈！")).toBe("read more 豈");
    // VARIATION SELECTOR-16 after LATIN SMALL LIGATURE FI
    expect(withoutTrailingDecoration("ﬁ️")).toBe("ﬁ");
    // a lone trail surrogate after the ideograph
    expect(withoutTrailingDecoration("豈\uDC00")).toBe("豈");
    // a private-use character and a lone trail surrogate: neither is a letter
    expect(withoutTrailingDecoration("here\uDC00")).toBe("here");
  });

  test("a real surrogate pair is still one code point", () => {
    expect(withoutTrailingDecoration("a😀")).toBe("a");
    // MATHEMATICAL BOLD DIGIT ZERO is a number
    expect(withoutTrailingDecoration("𝟎")).toBe("𝟎");
    // a lone lead surrogate at the end is decoration
    expect(withoutTrailingDecoration("a\uD83D")).toBe("a");
  });

  test("the anchor verdicts follow", () => {
    expect(isUninformativeAnchor("Here\uDC00")).toBe(true);
    expect(isUninformativeAnchor("More 豈ﰌ")).toBe(false);
    expect(isUninformativeAnchor("more 豈！")).toBe(false);
  });

  test("across every unit JavaScriptCore pairs wrongly, the helper agrees with the string iterator", () => {
    // `[...s]` walks code points as the specification does (in JavaScriptCore
    // too), and one code point tested alone cannot be misread as a pair.
    const letterOrNumber = /^[\p{L}\p{N}]$/u;
    const reference = (s: string): string => {
      const points = [...s];
      while (points.length > 0 && !letterOrNumber.test(points[points.length - 1] as string)) {
        points.pop();
      }
      return points.join("");
    };
    const inputs: string[] = [];
    const after: number[] = [];
    for (let t = 0xdc00; t <= 0xdfff; t += 16) after.push(t);
    for (let t = 0xfc00; t <= 0xffff; t += 16) after.push(t);
    for (let a = 0xf800; a <= 0xfbff; a++) {
      for (const t of after) {
        const pair = String.fromCharCode(a, t);
        inputs.push(`x${pair}`, `${pair}!`);
      }
    }
    for (let a = 0xd800; a <= 0xdbff; a += 16) {
      for (let t = 0xfc00; t <= 0xffff; t += 16) inputs.push(`x${String.fromCharCode(a, t)}`);
    }
    const wrong = inputs.filter((s) => withoutTrailingDecoration(s) !== reference(s));
    expect(wrong).toEqual([]);
    expect(inputs.length).toBeGreaterThan(250_000);
  }, 20_000);
});
