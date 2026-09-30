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
 * the equivalence is checked without ever pinning a core; the large inputs
 * run through the new code alone, with a limit the old code misses by
 * orders of magnitude.
 */
import { describe, expect, test } from "bun:test";
import { emlParse } from "./index";
import { tidyLines } from "./lib/lines";
import { parseAddressList, parseMailDate, replaceComments, stripHtml } from "./lib/mail";
import { parseToUnicodeCMap } from "./lib/pdf-text";

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
  });

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
    // 200 000 spaces then "x" 28 s — each quadratic. These are 4-12x those
    // sizes, so the old code would take minutes to hours.
    const inputs = [
      "<".repeat(400_000),
      "<style".repeat(200_000),
      "<SCRIPT".repeat(200_000),
      `${" ".repeat(800_000)}x`,
      `${"\t ".repeat(400_000)}x\n`,
      "</".repeat(400_000),
      `<style>${"</styl".repeat(150_000)}`,
    ];
    const started = performance.now();
    for (const input of inputs) stripHtml(input);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(stripHtml("<style".repeat(1_000))).toBe("<style".repeat(1_000));
    expect(stripHtml(`${" ".repeat(1_000)}x`)).toBe("x");
  });

  test("EmlParse on an HTML-only message is linear", async () => {
    const message = [
      "From: a@x.test",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<style".repeat(100_000),
    ].join("\r\n");
    const started = performance.now();
    const out = String(await emlParse.execute({ content: message, asText: true }, {} as never));
    expect(performance.now() - started).toBeLessThan(5_000);
    // No `>` anywhere, so no tag: the text is the text.
    expect(out.startsWith("<style<style")).toBe(true);
  });
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
    // 0.7.0: 40 000 '<' took 0.9 s (quadratic); this is 10x that.
    const started = performance.now();
    parseAddressList("<".repeat(400_000), new Set());
    expect(performance.now() - started).toBeLessThan(5_000);
  });
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
    // long per doubling. This is ten times that.
    const started = performance.now();
    expect(parseMailDate("(".repeat(800_000))).toBeUndefined();
    const message = `From: a@x.test\r\nDate: ${"(".repeat(400_000)}\r\n\r\nbody\r\n`;
    const out = JSON.parse(String(await emlParse.execute({ content: message }, {} as never)));
    expect(out.date).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5_000);
  });
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
    const started = performance.now();
    parseToUnicodeCMap("beginbfchar ".repeat(400_000));
    parseToUnicodeCMap("beginbfrange ".repeat(400_000));
    parseToUnicodeCMap(`beginbfrange ${"<1> <2> [".repeat(200_000)} endbfrange`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("refuses ranges that expand past sixteen 2-byte code spaces", () => {
    // 8 KB of full-width ranges was 0.8 s of map writes; 1 MB was minutes.
    const lines = "<0000> <FFFF> <0041>\n".repeat(17);
    expect(() => parseToUnicodeCMap(`beginbfrange\n${lines}endbfrange`)).toThrow(
      /cover more than 1048576 codes/,
    );
    const sixteen = "<0000> <FFFF> <0041>\n".repeat(16);
    expect(parseToUnicodeCMap(`beginbfrange\n${sixteen}endbfrange`).size).toBe(65_536);
  });
});
