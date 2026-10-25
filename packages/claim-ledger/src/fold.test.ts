import { describe, expect, test } from "bun:test";
import { foldText } from "./fold";

// Spelled by code point, so what each test means is visible.
const at = (...points: number[]): string => String.fromCodePoint(...points);
const ZWSP = at(0x200b);

describe("foldText — what a reader cannot tell apart is one spelling (design §1, §6.2)", () => {
  test("a digit of any script is its ASCII digit", () => {
    expect(foldText(`refund window ${at(0xff13, 0xff10)} days`)).toBe("refund window 30 days");
    expect(foldText(at(0x0663, 0x0660))).toBe("30"); // Arabic-Indic
    expect(foldText(at(0x06f3, 0x06f0))).toBe("30"); // Extended Arabic-Indic (Persian)
    expect(foldText(at(0x0969, 0x0966))).toBe("30"); // Devanagari
    expect(foldText(`${at(0x0669, 0x0669, 0x0669, 0x066b, 0x0669, 0x0669)}`)).toBe("999.99");
    expect(foldText(at(0x0661, 0x066c, 0x0662, 0x0668, 0x0664))).toBe("1,284");
  });

  test("an astral digit or letter keeps its length, its second unit moved past the word", () => {
    // Mathematical bold 3 and 0: two code units each.
    expect(foldText(`${at(0x1d7d1, 0x1d7ce)} days`)).toBe(`30${ZWSP}${ZWSP} days`);
    // Mathematical sans-serif bold n, o, t.
    expect(foldText(at(0x1d5fb, 0x1d5fc, 0x1d601))).toBe(`not${ZWSP}${ZWSP}${ZWSP}`);
  });

  test("fullwidth ASCII is ASCII", () => {
    expect(foldText(at(0xff4e, 0xff4f, 0xff54))).toBe("not");
    expect(foldText(`${at(0xff04)}45`)).toBe("$45");
  });

  test("an ignorable character hidden in a word is moved out of it", () => {
    for (const hidden of [0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff]) {
      expect(foldText(`n${at(hidden)}ot accepted`)).toBe(`not${at(hidden)} accepted`);
    }
    expect(foldText(`3${ZWSP}0 days`)).toBe(`30${ZWSP} days`);
  });

  test("a lookalike letter is read as Latin only inside a word that mixes scripts", () => {
    // Cyrillic о inside a Latin word; Greek ο likewise.
    expect(foldText(`n${at(0x043e)}t`)).toBe("not");
    expect(foldText(`n${at(0x03bf)}ne`)).toBe("none");
    // A letter drawn as a digit, beside a digit: Cyrillic Ze is 3.
    expect(foldText(`${at(0x0417)}0 days`)).toBe("30 days");
    // One after the digits is a suffix: the Greek ordinal "10th" stays 10.
    expect(foldText(`10${at(0x03bf, 0x03c2)}`)).toBe(`10${at(0x03bf, 0x03c2)}`);
    // A word wholly Cyrillic or Greek is that word.
    const russian = `${at(0x043d, 0x043e)} ${at(0x0434, 0x043e, 0x043c)}`;
    expect(foldText(russian)).toBe(russian);
  });

  test("a superscript run that stands alone is digits; one glued to a number or a word is not", () => {
    expect(foldText(`${at(0x00b3, 0x2070)} days`)).toBe("30 days");
    expect(foldText(`10${at(0x2076)} users`)).toBe(`10${at(0x2076)} users`);
    expect(foldText(`rose${at(0x00b9)}`)).toBe(`rose${at(0x00b9)}`);
    // A footnote mark after punctuation, a closing bracket or a word and a
    // space, with nothing after it, is left as written: read as digits it
    // was a figure the source had to hold.
    for (const mark of [
      `of purchase.${at(0x00b9)}`,
      `of purchase ${at(0x00b9)}`,
      `(see ${at(0x00b2)}).`,
      `of purchase ${at(0x00b9)} [1].`,
    ]) {
      expect(foldText(mark)).toBe(mark);
    }
    // One that stands where a number would, on its line, is a number.
    expect(foldText(`is ${at(0x00b3, 0x2070)}\ndays`)).toBe("is 30\ndays");
  });

  test("curly quotes fold to straight ones, as the locate kernel always did", () => {
    expect(foldText(`${at(0x201c)}quoted${at(0x201d)} ${at(0x2019)}s`)).toBe(`"quoted" 's`);
  });

  test("one character for one, and folding twice is folding once", () => {
    const samples = [
      `Refunds are n${ZWSP}ot accepted within ${at(0xff11, 0xff14)} days`,
      `${at(0x1d7d1, 0x1d7ce)} ${at(0x1d5fb, 0x1d5fc, 0x1d601)} ${at(0x0663, 0x0660)}`,
      `n${at(0x043e)}t ${at(0x0417)}0 ${at(0x00b3, 0x2070)} ${at(0x201c)}x${at(0x201d)}`,
      "plain ASCII is returned as it came",
    ];
    for (const text of samples) {
      const once = foldText(text);
      expect(once.length).toBe(text.length);
      expect(foldText(once)).toBe(once);
    }
    const ascii = "plain ASCII is returned as it came";
    expect(foldText(ascii)).toBe(ascii);
  });

  test("linear in the text", () => {
    // One fold of a shape at 16n against sixteen folds of it at n back to
    // back, the least of three of each, interleaved, from a collected heap,
    // so load and garbage only ever add to a run. Linear is the same work
    // both ways, quadratic sixteen times as much at 16n; the bound is four
    // times, plus 100 ms for a busy runner to hold a run up once. Equal work,
    // because a loaded runner stretches a run by the time it waits for a
    // core, and a short run can finish between two waits that a longer one
    // sits through. Never against a text of another shape, whose cost need
    // not scale alike on another machine. Each size is one where moving,
    // replacing or reading each character again from the word's start would
    // cost far more than reading it once.
    const linear = (make: (k: number) => string, n: number): string => {
      const small = make(n);
      const large = make(16 * n);
      let sixteen = Number.POSITIVE_INFINITY;
      let once = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        Bun.gc(true);
        let start = performance.now();
        for (let k = 0; k < 16; k++) foldText(small);
        sixteen = Math.min(sixteen, performance.now() - start);
        Bun.gc(true);
        start = performance.now();
        foldText(large);
        once = Math.min(once, performance.now() - start);
      }
      return once < sixteen * 4 + 100
        ? "linear"
        : `${sixteen.toFixed(1)} ms for 16 at n, ${once.toFixed(1)} ms for 1 at 16n`;
    };
    const shapes: Array<[string, (k: number) => string, number]> = [
      ["ignorables in a word", (k) => `${`n${ZWSP}`.repeat(k)}t`, 1_500],
      ["Arabic-Indic digits", (k) => at(0x0663).repeat(k), 375],
      ["lookalikes in a word", (k) => `${`n${at(0x043e)}`.repeat(k)}t`, 320],
      ["astral digits", (k) => at(0x1d7d1).repeat(k), 1_500],
      ["superscript digits", (k) => at(0x00b3).repeat(k), 500],
    ];
    for (const [shape, make, n] of shapes) {
      expect(`${shape}: ${linear(make, n)}`).toBe(`${shape}: linear`);
    }
  }, 30_000);
});
