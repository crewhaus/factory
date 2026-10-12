/**
 * The text extractors' hand-written scans are linear, and give what the
 * regexes they replace gave (C090's tool-docs sibling).
 *
 * 0.7.0's stripHtml ran `/<(script|style)[\s\S]*?<\/\1>/gi`, `/<[^>]*>/g` and
 * `/[ \t]+\n/g`; each is quadratic on text without the closer it looks for.
 * DocumentText (on .html) and EmlParse (on an HTML-only message) are
 * readOnly, so plan and auto mode ran them unasked: 336 KB of `<style` took
 * 17 s, and 200 000 spaces then an "x" took 28 s. The same shapes sat in the
 * PDF text layer's ToUnicode parser and line tidying, and in the mail
 * address parser.
 *
 * Each old regex is kept here as an ORACLE and run on small inputs only, so
 * the equivalence is checked without ever pinning a core; the hostile inputs
 * run through the new code alone. Their work is counted, and a hang backstop
 * at the end of this file runs them again at full size, uncounted, for the
 * work the counts cannot see.
 */
import { describe, expect, test } from "bun:test";
import { type RegexWork, regexWork, regexWorkAsync } from "./__test__/regex-work";
import { type ScanWork, scanWork, scanWorkAsync } from "./__test__/scan-work";
import { emlParse } from "./index";
import { tidyLines } from "./lib/lines";
import { parseAddressList, parseMailDate, replaceComments, stripHtml } from "./lib/mail";
import { parseToUnicodeCMap } from "./lib/pdf-text";

/**
 * The linear-time tests count a parse's work instead of timing it: every
 * pattern's backtracking steps (__test__/regex-work.ts), and the characters
 * the scans search, read and copy (__test__/scan-work.ts). On the hostile
 * inputs here the parsers take at most 13 steps and 12 characters of
 * scanning a character of input, at any size. Each 0.7.0 regex rescanned
 * the rest of its input from every `<`, `(` or blank, so its count grows
 * with the input's length: these inputs are about the sizes that took it a
 * second to half a minute, where it takes 600 to 1 900 times the bound. A
 * count past its bound stops the parse there and reads as Infinity, so a
 * parse that rereads its input through a regex or a counted string method
 * fails at once, however fast or slow the machine.
 *
 * The counts see nothing else. A scan that looks for its closer with
 * indexed reads (`text[j]`), or with a method scan-work.ts does not wrap
 * (`startsWith`, `trim`, `join`, an array's `indexOf`), is charged nothing
 * however often it rereads its input, and passes them. The hang backstop
 * at the end of this file is what catches it.
 */
const STEPS_PER_CHARACTER = 64;
const SCAN_PER_CHARACTER = 32;

/** Whether a pattern's source refers back to a group, which the step model cannot count. */
function hasBackReference(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\\") continue;
    const next = source[i + 1] ?? "";
    if ((next >= "1" && next <= "9") || (next === "k" && source[i + 2] === "<")) return true;
    i += 1;
  }
  return false;
}

/**
 * `body`, with every pattern the step model cannot count refused before it
 * runs. 0.7.0's script and style pass, `/<(script|style)[\s\S]*?<\/\1>/gi`,
 * refers back to its group: regex-work.ts would list it and run it
 * uncounted, for minutes on these inputs. Refused, it fails the test at once.
 */
function countable<T>(body: () => T): T {
  const counted = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, input: string): RegExpExecArray | null {
    if (hasBackReference(this.source)) {
      throw new Error(
        `/${this.source}/${this.flags} refers back to a group: the step model cannot count it`,
      );
    }
    return counted.call(this, input);
  };
  const restore = (): void => {
    RegExp.prototype.exec = counted;
  };
  let out: T;
  try {
    out = body();
  } catch (err) {
    restore();
    throw err;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

/** `run`'s result, once its work on `size` characters of `input` is shown linear. */
function linear<T>(input: string, size: number, run: () => T): T {
  return linearIn(
    input,
    size,
    regexWork(STEPS_PER_CHARACTER * size, () =>
      countable(() => scanWork(SCAN_PER_CHARACTER * size, run)),
    ),
  );
}

async function linearAsync<T>(input: string, size: number, run: () => Promise<T>): Promise<T> {
  return linearIn(
    input,
    size,
    await regexWorkAsync(STEPS_PER_CHARACTER * size, () =>
      countable(() => scanWorkAsync(SCAN_PER_CHARACTER * size, run)),
    ),
  );
}

function linearIn<T>(input: string, size: number, counted: RegexWork<ScanWork<T>>): T {
  const scan = counted.value;
  // A count within its bound reads "linear"; one past it, Infinity. A parse
  // the step count stopped never finished its scan.
  expect({
    input,
    unmodelled: counted.unmodelled,
    steps: counted.steps <= STEPS_PER_CHARACTER * size ? "linear" : counted.steps,
    scanned:
      scan === undefined
        ? "stopped"
        : scan.work <= SCAN_PER_CHARACTER * size
          ? "linear"
          : scan.work,
  }).toEqual({ input, unmodelled: [], steps: "linear", scanned: "linear" });
  return scan?.value as T;
}

/** 0.7.0's stripHtml, verbatim. Small inputs only. */
function oldStripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos|nbsp);/g, (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      const map: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      return map[body] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A deterministic PRNG, so a failure names a reproducible input. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random HTML, malformed on purpose: stray `<` and `>`, unclosed elements. */
function randomHtml(next: () => number, pieces: number): string {
  const atoms = [
    "<p>",
    "</p>",
    "<DIV class='x'>",
    "</div>",
    "</Tr>",
    "</li>",
    "</h3>",
    "</h7>",
    "<br>",
    "<BR/>",
    "<br  />",
    "<br x>",
    "<script>var a = '<b>';</script>",
    "<SCRIPT type='t'>x</ScRiPt>",
    "<style>p{}</style>",
    "<style>",
    "<script>",
    "</style>",
    "</script >",
    "<scriptless>",
    "&amp;",
    "&lt;b&gt;",
    "&#65;",
    "&#x42;",
    "&#1f;",
    "&nbsp;",
    "&bogus;",
    "&#99999999;",
    "text",
    " ",
    "  \t",
    "\n",
    "\n\n\n",
    "İ",
    "a > b",
    "<",
    "<a href='u'>",
    "</a>",
    "<!-- c -->",
    "<<",
    ">",
    "price < 5 ",
    "</p",
    "</STYLE>",
    "<br\n/>",
  ];
  let out = "";
  for (let i = 0; i < pieces; i++) out += atoms[Math.floor(next() * atoms.length)];
  return out;
}

describe("stripHtml", () => {
  test("gives 0.7.0's text, exactly, on well-formed and malformed HTML", () => {
    const next = rng(20260929);
    let compared = 0;
    for (let i = 0; i < 5_000; i++) {
      const html = randomHtml(next, 1 + Math.floor(next() * 30));
      expect({ html, text: stripHtml(html) }).toEqual({ html, text: oldStripHtml(html) });
      compared += 1;
    }
    expect(compared).toBe(5_000);
    // Slow by construction: 5 000 comparisons took up to 436 ms on CI.
  }, 20_000);

  test("keeps the documented cases", () => {
    expect(stripHtml("<p>one</p><p>two &amp; three</p>")).toBe("one\ntwo & three");
    expect(stripHtml("a<script>x</script>b<style>y</STYLE>c")).toBe("abc");
    expect(stripHtml("a <b")).toBe("a <b");
    expect(stripHtml("<style>never closed <p>x</p>")).toBe("never closed x");
    expect(stripHtml("price < 5 <br> ok")).toBe("price < 5\n ok");
    expect(stripHtml("x<br>y<BR />z")).toBe("x\ny\nz");
    // U+0130 lower-cases to two code units; nothing here lower-cases the text.
    expect(stripHtml("İİİ<script>1</script>after")).toBe("İİİafter");
  });

  test("is linear on input with no closer: '<', '<style', '<script' and blank runs", () => {
    // 0.7.0: '<style' x 56 000 (336 KB) took 17 s, '<' x 40 000 0.8 s, and
    // 200 000 spaces then "x" 28 s — each quadratic. Each input is counted
    // on its own, against its own length.
    const inputs: Array<[string, string]> = [
      ["'<'", "<".repeat(40_000)],
      ["'<style'", "<style".repeat(20_000)],
      ["'<SCRIPT'", "<SCRIPT".repeat(20_000)],
      ["spaces then x", `${" ".repeat(80_000)}x`],
      ["tabs and spaces then x", `${"\t ".repeat(40_000)}x\n`],
      ["'</'", "</".repeat(40_000)],
      ["'</styl' in a style", `<style>${"</styl".repeat(15_000)}`],
    ];
    for (const [input, text] of inputs) linear(input, text.length, () => stripHtml(text));
    expect(stripHtml("<style".repeat(1_000))).toBe("<style".repeat(1_000));
    expect(stripHtml(`${" ".repeat(1_000)}x`)).toBe("x");
    // Slow by construction: the step model walks all seven inputs, about
    // 0.1 s here, and this package's tests ran up to 27 times slower on CI.
  }, 20_000);

  test("EmlParse on an HTML-only message is linear", async () => {
    const message = [
      "From: a@x.test",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<style".repeat(10_000),
    ].join("\r\n");
    const out = String(
      await linearAsync("an HTML-only message", message.length, () =>
        emlParse.execute({ content: message, asText: true }, {} as never),
      ),
    );
    // No `>` anywhere, so no tag: the text is the text.
    expect(out.startsWith("<style<style")).toBe(true);
  }, 20_000);
});

describe("tidyLines", () => {
  test("is the three regexes it replaces", () => {
    const next = rng(7);
    const atoms = [" ", "\t", "\n", "a", "\r", " ", "  \n", "\n\n\n\n"];
    for (let i = 0; i < 5_000; i++) {
      let text = "";
      const length = Math.floor(next() * 25);
      for (let j = 0; j < length; j++) text += atoms[Math.floor(next() * atoms.length)];
      const old = text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      expect({ text, out: tidyLines(text) }).toEqual({ text, out: old });
    }
  });
});

describe("parseAddressList", () => {
  test("reads Name <addr> as the regex did", () => {
    const notes = new Set<string>();
    expect(parseAddressList("Jane <jane@x.test>", notes)).toEqual([
      { name: "Jane", address: "jane@x.test" },
    ]);
    expect(parseAddressList("<a@x.test>  ", notes)).toEqual([{ address: "a@x.test" }]);
    expect(parseAddressList("x <y> <z@x.test>", notes)).toEqual([
      { name: "x <y>", address: "z@x.test" },
    ]);
    // A `>` after the last `<` that is not the end: not an angle address.
    expect(parseAddressList("a <b> c", notes)).toEqual([{ address: "a <b> c" }]);
  });

  test("is linear on a piece of many '<' and no '>'", () => {
    // 0.7.0: 40 000 '<' took 0.9 s (quadratic).
    const piece = "<".repeat(40_000);
    const out = linear("'<'", piece.length, () => parseAddressList(piece, new Set()));
    expect(out).toEqual([{ address: piece }]);
  }, 20_000);
});

describe("parseMailDate's comment strip (bounds review)", () => {
  test("is the regex it replaces", () => {
    const next = rng(11);
    const atoms = ["(", ")", "a", " ", "((", "))", "(x)", "Mon"];
    for (let i = 0; i < 5_000; i++) {
      let text = "";
      const length = Math.floor(next() * 20);
      for (let j = 0; j < length; j++) text += atoms[Math.floor(next() * atoms.length)];
      expect({ text, out: replaceComments(text) }).toEqual({
        text,
        out: text.replace(/\([^)]*\)/g, " "),
      });
    }
    expect(parseMailDate("Tue, 1 Jul 2003 10:52:37 +0200 (CEST)")).toBe("2003-07-01T08:52:37.000Z");
  });

  test("is linear on a Date of many '(' and no ')'", async () => {
    // 0.7.0 and 0.7.1's first cut: 80 000 '(' took 3.6 s, four times as
    // long per doubling.
    const date = "(".repeat(80_000);
    expect(linear("a Date", date.length, () => parseMailDate(date))).toBeUndefined();
    const message = `From: a@x.test\r\nDate: ${"(".repeat(40_000)}\r\n\r\nbody\r\n`;
    const out = JSON.parse(
      String(
        await linearAsync("a message's Date", message.length, () =>
          emlParse.execute({ content: message }, {} as never),
        ),
      ),
    );
    expect(out.date).toBeUndefined();
  }, 20_000);
});

describe("parseToUnicodeCMap", () => {
  test("reads bfchar and bfrange sections as before", () => {
    const map = parseToUnicodeCMap(
      [
        "beginbfchar <01> <0041> <02> /B endbfchar",
        "beginbfrange <0010> <0012> <0061> <0020> <0021> [<0058> <0059>] endbfrange",
        "beginbfchar <03> <0043>",
      ].join("\n"),
    );
    expect(map.get(0x01)).toBe("A");
    expect(map.get(0x02)).toBe("B");
    expect([map.get(0x10), map.get(0x11), map.get(0x12)]).toEqual(["a", "b", "c"]);
    expect([map.get(0x20), map.get(0x21)]).toEqual(["X", "Y"]);
    // A section with no end is not read, as the lazy regex did not read it.
    expect(map.has(0x03)).toBe(false);
  });

  test("is linear on sections with no end, and on '[' lists with no ']'", () => {
    // 0.7.0: 40 000 unclosed sections took 8-9 s each way (quadratic).
    const inputs: Array<[string, string]> = [
      ["unclosed bfchar sections", "beginbfchar ".repeat(40_000)],
      ["unclosed bfrange sections", "beginbfrange ".repeat(40_000)],
      ["'[' lists with no ']'", `beginbfrange ${"<1> <2> [".repeat(20_000)} endbfrange`],
    ];
    for (const [input, text] of inputs) {
      expect(linear(input, text.length, () => parseToUnicodeCMap(text).size)).toBe(0);
    }
  }, 20_000);

  test("refuses ranges that expand past sixteen 2-byte code spaces", () => {
    // 8 KB of full-width ranges was 0.8 s of map writes; 1 MB was minutes.
    const lines = "<0000> <FFFF> <0041>\n".repeat(17);
    expect(() => parseToUnicodeCMap(`beginbfrange\n${lines}endbfrange`)).toThrow(
      /cover more than 1048576 codes/,
    );
    const sixteen = "<0000> <FFFF> <0041>\n".repeat(16);
    expect(parseToUnicodeCMap(`beginbfrange\n${sixteen}endbfrange`).size).toBe(65_536);
    // Slow by construction: the cap is sixteen full code spaces, so each
    // call writes 1 048 576 map entries before it answers. That is about
    // 75 ms here and took up to 2.9 s on CI, over half bun's 5 s default.
  }, 20_000);
});

/**
 * The hang backstop: each hostile input again, at full size and uncounted,
 * must finish inside HANG_MS. It catches a quadratic scan however it is
 * written, the ones the counts cannot see included. It is a pure hang
 * detector, with one bound for each input. The scans take at most about
 * 20 ms an input here, after the counted tests, and this package's tests
 * have run up to 27 times slower on CI, so the bound is more than 20 times
 * any input's passing time there. A scan that looks for its closer again
 * after every opener, by indexed reads, takes a minute and a half to many
 * minutes here on each of these inputs, and longer on a slower runner.
 */
const HANG_MS = 15_000;

/** `run` finishes on `input` inside HANG_MS. */
async function finishes(input: string, run: () => unknown): Promise<void> {
  const started = performance.now();
  await run();
  const hung = performance.now() - started >= HANG_MS;
  expect({ input, hung }).toEqual({ input, hung: false });
}

describe("the hang backstop: every hostile input finishes at full size", () => {
  test("stripHtml", async () => {
    const inputs: Array<[string, string]> = [
      ["'<'", "<".repeat(400_000)],
      ["'<style'", "<style".repeat(200_000)],
      ["'<SCRIPT'", "<SCRIPT".repeat(200_000)],
      ["spaces then x", `${" ".repeat(800_000)}x`],
      ["tabs and spaces then x", `${"\t ".repeat(400_000)}x\n`],
      ["'</'", "</".repeat(400_000)],
      ["'</styl' in a style", `<style>${"</styl".repeat(150_000)}`],
    ];
    for (const [input, text] of inputs) await finishes(input, () => stripHtml(text));
  }, 20_000);

  test("EmlParse on an HTML-only message", async () => {
    // A body part is cut to maxBodyChars before it is stripped, so this asks
    // for the most a caller may, and the HTML stripped is 1 MB.
    const message = [
      "From: a@x.test",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<style".repeat(200_000),
    ].join("\r\n");
    await finishes("an HTML-only message", () =>
      emlParse.execute({ content: message, asText: true, maxBodyChars: 1_000_000 }, {} as never),
    );
  }, 20_000);

  test("parseAddressList", async () => {
    const piece = "<".repeat(400_000);
    await finishes("'<'", () => parseAddressList(piece, new Set()));
  }, 20_000);

  test("parseMailDate, in a message and alone", async () => {
    const message = `From: a@x.test\r\nDate: ${"(".repeat(400_000)}\r\n\r\nbody\r\n`;
    await finishes("a message's Date", () => emlParse.execute({ content: message }, {} as never));
    const date = "(".repeat(800_000);
    await finishes("a Date", () => parseMailDate(date));
  }, 20_000);

  test("parseToUnicodeCMap", async () => {
    const inputs: Array<[string, string]> = [
      ["unclosed bfchar sections", "beginbfchar ".repeat(400_000)],
      ["unclosed bfrange sections", "beginbfrange ".repeat(400_000)],
      ["'[' lists with no ']'", `beginbfrange ${"<1> <2> [".repeat(200_000)} endbfrange`],
    ];
    for (const [input, text] of inputs) await finishes(input, () => parseToUnicodeCMap(text));
  }, 20_000);
});
