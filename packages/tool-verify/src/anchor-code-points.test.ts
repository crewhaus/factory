/**
 * Anchor text's trailing decoration is read one code point at a time, as
 * ECMAScript's `u` flag specifies: a surrogate pair is one code point, and
 * any other code unit, a lone surrogate included, is one on its own.
 *
 * The strip this replaced, `/[^\p{L}\p{N}]+$/u`, departs from that where
 * JavaScriptCore's regex JIT runs it (Bun 1.3.14; its interpreter and V8
 * follow the specification). The JIT reads a unit in U+D800-U+DBFF or
 * U+F800-U+FBFF followed by one in U+DC00-U+DFFF or U+FC00-U+FFFF as one
 * supplementary code point, as if it tested the pair with a 0xDC00 mask
 * where 0xFC00 is needed. So the old strip removed real letters: two that
 * read as one unassigned code point (an Arabic presentation form or a CJK
 * compatibility ideograph, then a fullwidth form, an Arabic presentation
 * form B or a variation selector), and such a letter before a lone trail
 * surrogate. It also kept decoration that reads, paired, as a letter: a
 * lone lead surrogate or a private-use character before such a unit (U+F800
 * then a lone U+DC00 reads as U+10000, a Linear B syllable). The helper
 * answers as the specification does.
 *
 * So the old code fails these tests only where the pattern is JIT-compiled;
 * with the JIT off (`BUN_JSC_useRegExpJIT=0`) it passes them. Every expected
 * value is written out rather than asked of the engine, so these tests hold
 * whatever a later engine does. The table test walks a few hundred thousand
 * generated inputs and declares a 20 s budget, as the house does for a test
 * that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { isUninformativeAnchor, withoutTrailingDecoration } from "./lib/seo";

describe("trailing decoration is read by code point, as the u flag specifies", () => {
  test("two letters the JIT read as one unassigned code point both stay", () => {
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
  });

  test("decoration the JIT read as a letter goes", () => {
    // a private-use character and a lone trail surrogate: neither is a letter
    expect(withoutTrailingDecoration("here\uDC00")).toBe("here");
    // a lone lead surrogate and FULLWIDTH EXCLAMATION MARK
    expect(withoutTrailingDecoration("x\uD800！")).toBe("x");
  });

  test("a real surrogate pair is still one code point", () => {
    expect(withoutTrailingDecoration("a\u{1F600}")).toBe("a");
    // MATHEMATICAL BOLD DIGIT ZERO is a number
    expect(withoutTrailingDecoration("\u{1D7CE}")).toBe("\u{1D7CE}");
    // a lone lead surrogate at the end is decoration
    expect(withoutTrailingDecoration("a\uD83D")).toBe("a");
    // a lone trail surrogate after a pair goes, and the pair stays: the trail
    // before it ends a pair, so it does not start one with the lone trail
    // (U+10000 is LINEAR B SYLLABLE B008 A)
    expect(withoutTrailingDecoration("\u{10000}\uDC00")).toBe("\u{10000}");
    expect(withoutTrailingDecoration("a\u{1D7CE}\uDC00")).toBe("a\u{1D7CE}");
  });

  test("the anchor verdicts follow", () => {
    expect(isUninformativeAnchor("Here\uDC00")).toBe(true);
    expect(isUninformativeAnchor("More 豈ﰌ")).toBe(false);
    expect(isUninformativeAnchor("more 豈！")).toBe(false);
  });

  test("on a sample of the pairs the JIT misreads, and of real pairs before a lone trail, the helper agrees with the string iterator", () => {
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
    // Every unit in U+F800-U+FBFF, before every 16th unit it can be misread
    // with.
    const after: number[] = [];
    for (let t = 0xdc00; t <= 0xdfff; t += 16) after.push(t);
    for (let t = 0xfc00; t <= 0xffff; t += 16) after.push(t);
    for (let a = 0xf800; a <= 0xfbff; a++) {
      for (const t of after) {
        const pair = String.fromCharCode(a, t);
        inputs.push(`x${pair}`, `${pair}!`);
      }
    }
    // Every 16th lead surrogate: before every 16th unit in U+FC00-U+FFFF,
    // and in a real pair with every 16th trail, the pair then followed by a
    // lone trail.
    for (let a = 0xd800; a <= 0xdbff; a += 16) {
      for (let t = 0xfc00; t <= 0xffff; t += 16) inputs.push(`x${String.fromCharCode(a, t)}`);
      for (let t = 0xdc00; t <= 0xdfff; t += 16) {
        inputs.push(`${String.fromCharCode(a, t)}\uDC00`, `x${String.fromCharCode(a, t, t)}`);
      }
    }
    const wrong = inputs.filter((s) => withoutTrailingDecoration(s) !== reference(s));
    expect(wrong).toEqual([]);
    expect(inputs.length).toBeGreaterThan(250_000);
  }, 20_000);
});
