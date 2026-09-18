/**
 * The parser, the selector engine and the extractors, tested directly.
 *
 * The markup here is the markup pages actually serve: unclosed tags,
 * unquoted attributes, entities, spans, script bodies containing things that
 * look like tags. A parser tested only on well-formed HTML is a parser for
 * documents nobody serves.
 */
import { describe, expect, test } from "bun:test";
import {
  extractForms,
  extractLinks,
  extractRecords,
  extractStructuredData,
  extractTable,
  outline,
  readableText,
} from "./lib/extract";
import { decodeEntities, normalizeText, parseHtml, textOf, walk } from "./lib/parse";
import { queryAll, queryFirst } from "./lib/select";

const first = (html: string, selector: string) => queryFirst(parseHtml(html), selector);

describe("the parser recovers the way a browser does", () => {
  test("list items close each other", () => {
    // Without implicit closing, ten items nest ten levels deep.
    const root = parseHtml("<ul><li>a<li>b<li>c</ul>");
    expect(queryAll(root, "li")).toHaveLength(3);
    expect(queryAll(root, "li li")).toHaveLength(0);
  });

  test("table cells and rows close each other", () => {
    const root = parseHtml("<table><tr><td>1<td>2<tr><td>3<td>4</table>");
    expect(queryAll(root, "tr")).toHaveLength(2);
    expect(queryAll(root, "td")).toHaveLength(4);
  });

  test("paragraphs close each other", () => {
    expect(queryAll(parseHtml("<p>one<p>two<p>three"), "p")).toHaveLength(3);
  });

  test("void elements never contain anything", () => {
    const root = parseHtml("<div><img src=a.png><br><input name=q>text</div>");
    expect(queryAll(root, "img *")).toHaveLength(0);
    expect(normalizeText(textOf(queryFirst(root, "div") as never))).toBe("text");
  });

  test("attributes parse quoted, single-quoted, unquoted and bare", () => {
    const node = first("<input id=q class='a b' value=\"x y\" required disabled>", "input");
    expect(node?.attrs).toEqual({
      id: "q",
      class: "a b",
      value: "x y",
      required: "",
      disabled: "",
    });
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    const node = first('<a title="a > b" href="/x">t</a>', "a");
    expect(node?.attrs["title"]).toBe("a > b");
    expect(node?.attrs["href"]).toBe("/x");
  });

  test("script content is text, not markup", () => {
    // Otherwise a string in a script becomes elements in the tree.
    const root = parseHtml('<script>var x = "<div id=fake>";</script><p>real</p>');
    expect(queryAll(root, "#fake")).toHaveLength(0);
    expect(queryAll(root, "p")).toHaveLength(1);
  });

  test("a stray close tag does not unwind the document", () => {
    const root = parseHtml("<div><p>a</span></p><p>b</p></div>");
    expect(queryAll(root, "div p")).toHaveLength(2);
  });

  test("a bare < is text rather than a tag", () => {
    expect(normalizeText(textOf(parseHtml("<p>5 < 6</p>")))).toBe("5 < 6");
  });

  test("comments and doctypes carry nothing", () => {
    const root = parseHtml("<!doctype html><!-- <p>hidden</p> --><p>shown</p>");
    expect(queryAll(root, "p")).toHaveLength(1);
  });

  test("entities decode, including numeric and hex", () => {
    expect(decodeEntities("a &amp; b &pound;1 &#65; &#x42; &nosuch;")).toBe(
      "a & b £1 A B &nosuch;",
    );
  });

  test("a lone surrogate reference is left alone rather than emitted", () => {
    // Emitting one produces a string that cannot be encoded back to UTF-8.
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
  });

  test("a document past the size cap is refused", () => {
    expect(() => parseHtml("<p>x</p>", { maxChars: 4 })).toThrow(/over the 4 limit/);
  });

  test("deep nesting is bounded rather than overflowing the stack", () => {
    const deep = "<div>".repeat(3_000);
    expect(() => parseHtml(deep, { maxDepth: 50 })).not.toThrow();
  });
});

describe("the selector engine", () => {
  const html = `<div id=main class="a b"><ul class=nav><li><a href=/1 rel=next>one</a></li>
    <li class=sel><a href=/2>two</a></li><li><a href=/3>three</a></li></ul>
    <p>x</p><span>y</span><p>z</p></div>`;

  test("tag, id, class and compound selectors", () => {
    expect(queryAll(parseHtml(html), "li")).toHaveLength(3);
    expect(queryFirst(parseHtml(html), "#main")?.tag).toBe("div");
    expect(queryFirst(parseHtml(html), "div.a.b")?.attrs["id"]).toBe("main");
    expect(queryAll(parseHtml(html), "li.sel")).toHaveLength(1);
  });

  test("descendant, child and sibling combinators", () => {
    const root = parseHtml(html);
    expect(queryAll(root, "#main a")).toHaveLength(3);
    expect(queryAll(root, "ul > li")).toHaveLength(3);
    expect(queryAll(root, "ul > a")).toHaveLength(0);
    expect(queryAll(root, "p + span")).toHaveLength(1);
    expect(queryAll(root, "p ~ p")).toHaveLength(1);
  });

  test("attribute operators", () => {
    const root = parseHtml(html);
    expect(queryAll(root, "[rel]")).toHaveLength(1);
    expect(queryAll(root, '[href="/2"]')).toHaveLength(1);
    expect(queryAll(root, '[href^="/"]')).toHaveLength(3);
    expect(queryAll(root, '[href$="3"]')).toHaveLength(1);
    expect(queryAll(root, '[href*="2"]')).toHaveLength(1);
    expect(queryAll(root, '[class~="b"]')).toHaveLength(1);
  });

  test("positional pseudo-classes", () => {
    const root = parseHtml(html);
    expect(normalizeText(textOf(queryFirst(root, "li:first-child") as never))).toBe("one");
    expect(normalizeText(textOf(queryFirst(root, "li:last-child") as never))).toBe("three");
    expect(normalizeText(textOf(queryFirst(root, "li:nth-child(2)") as never))).toBe("two");
    expect(queryAll(root, "p:nth-of-type(2)")).toHaveLength(1);
    expect(queryAll(root, "li:not(.sel)")).toHaveLength(2);
  });

  test("comma groups match either side", () => {
    expect(queryAll(parseHtml(html), "span, li.sel")).toHaveLength(2);
  });

  test("an unsupported construct is an error, not silently dropped", () => {
    // An engine that ignores what it cannot parse returns elements that
    // merely look right, which is worse than refusing.
    expect(() => queryAll(parseHtml(html), "p:hover")).toThrow(/not supported/);
    expect(() => queryAll(parseHtml(html), "")).toThrow(/matches nothing/);
  });

  test("an nth formula is refused rather than read as its first number", () => {
    // `Number.parseInt("2n+1")` is 2, so a lenient check would silently turn
    // this into :nth-child(2).
    expect(() => queryAll(parseHtml(html), "li:nth-child(2n+1)")).toThrow(/positive whole number/);
    expect(() => queryAll(parseHtml(html), "li:nth-child(0)")).toThrow(/positive whole number/);
  });
});

describe("tables", () => {
  test("headers and rows come out separated", () => {
    const table = first("<table><tr><th>A<th>B<tr><td>1<td>2</table>", "table");
    expect(extractTable(table as never)).toMatchObject({
      headers: ["A", "B"],
      rows: [["1", "2"]],
      rowCount: 1,
      columnCount: 2,
    });
  });

  test("colspan and rowspan are expanded, so columns stay aligned", () => {
    // Left ragged, every column after a span is off by one in every row —
    // invisible in the output and wrong throughout.
    const table = first(
      `<table><caption>Q3</caption>
       <tr><th>Region<th colspan=2>Sales</tr>
       <tr><td rowspan=2>North<td>Jan<td>10</tr>
       <tr><td>Feb<td>20</tr></table>`,
      "table",
    );
    const lifted = extractTable(table as never);
    expect(lifted.caption).toBe("Q3");
    expect(lifted.headers).toEqual(["Region", "Sales", "Sales"]);
    expect(lifted.rows).toEqual([
      ["North", "Jan", "10"],
      ["North", "Feb", "20"],
    ]);
  });

  test("a table with no header row keeps every row as data", () => {
    const table = first("<table><tr><td>1<td>2<tr><td>3<td>4</table>", "table");
    const lifted = extractTable(table as never);
    expect(lifted.headers).toEqual([]);
    expect(lifted.rowCount).toBe(2);
  });

  test("a row mixing th and td is data, not a header", () => {
    const table = first("<table><tr><th>Label<td>Value</table>", "table");
    expect(extractTable(table as never).headers).toEqual([]);
  });

  test("an empty table is empty rather than an error", () => {
    const table = first("<table></table>", "table");
    expect(extractTable(table as never)).toMatchObject({ rowCount: 0, columnCount: 0 });
  });
});

describe("links", () => {
  const html = `<base href="https://site.test/shop/"><a href=rel>R</a>
    <a href=/abs>A</a><a href="https://other.test/x">O</a>
    <a href="#frag">F</a><a href="mailto:a@b.test">M</a><a>none</a>`;

  test("relative hrefs resolve and origins are classified", () => {
    const links = extractLinks(parseHtml(html));
    expect(links.map((l) => l.href)).toEqual([
      "https://site.test/shop/rel",
      "https://site.test/abs",
      "https://other.test/x",
      "mailto:a@b.test",
    ]);
    expect(links.find((l) => l.text === "O")?.external).toBe(true);
    expect(links.find((l) => l.text === "A")?.external).toBe(false);
  });

  test("fragments and hrefless anchors are skipped", () => {
    expect(extractLinks(parseHtml(html)).some((l) => l.text === "F" || l.text === "none")).toBe(
      false,
    );
  });

  test("the page's own base wins over the supplied one", () => {
    const links = extractLinks(parseHtml(html), "https://supplied.test/");
    expect(links[0]?.href).toBe("https://site.test/shop/rel");
  });

  test("with no base at all the href is reported as written", () => {
    expect(extractLinks(parseHtml("<a href=/x>X</a>"))[0]?.href).toBe("/x");
  });

  test("identical link and text pairs are reported once", () => {
    const links = extractLinks(parseHtml("<a href=/x>X</a><a href=/x>X</a><a href=/x>Y</a>"));
    expect(links).toHaveLength(2);
  });
});

describe("forms", () => {
  const html = `<form id=f action=/search method=POST>
    <label for=q>Query</label><input id=q name=q required>
    <label>Wrapped<input name=w></label>
    <input type=hidden name=csrf value=tok>
    <select name=size><option value=s>Small<option value=l selected>Large</select>
    <textarea name=notes>hi</textarea><button name=go>Go</button></form>`;

  test("action, method and every field are described", () => {
    const [form] = extractForms(parseHtml(html));
    expect(form).toMatchObject({ action: "/search", method: "post", id: "f" });
    expect(form?.fields.map((f) => f.name)).toEqual(["q", "w", "csrf", "size", "notes", "go"]);
  });

  test("hidden fields are included, because a form without them cannot be submitted", () => {
    const [form] = extractForms(parseHtml(html));
    expect(form?.fields.find((f) => f.name === "csrf")).toMatchObject({
      type: "hidden",
      value: "tok",
    });
  });

  test("labels resolve from for=, from a wrapping label, and from aria", () => {
    const [form] = extractForms(parseHtml(html));
    expect(form?.fields.find((f) => f.name === "q")?.label).toBe("Query");
    expect(form?.fields.find((f) => f.name === "w")?.label).toContain("Wrapped");
    const aria = extractForms(parseHtml('<form><input name=a aria-label="Aria"></form>'));
    expect(aria[0]?.fields[0]?.label).toBe("Aria");
  });

  test("select options carry their values and which is selected", () => {
    const [form] = extractForms(parseHtml(html));
    expect(form?.fields.find((f) => f.name === "size")?.options).toEqual([
      { value: "s", label: "Small", selected: false },
      { value: "l", label: "Large", selected: true },
    ]);
  });

  test("required is reported, and a textarea's value is its text", () => {
    const [form] = extractForms(parseHtml(html));
    expect(form?.fields.find((f) => f.name === "q")?.required).toBe(true);
    expect(form?.fields.find((f) => f.name === "notes")?.value).toBe("hi");
  });
});

describe("structured data", () => {
  const html = `<title>T</title><link rel=canonical href="https://x.test/p">
    <meta property="og:title" content="W"><meta name="twitter:card" content="summary">
    <meta name=description content=d>
    <script type="application/ld+json">{"@type":"Product","name":"Bolt"}</script>
    <script type="application/ld+json">{not json}</script>`;

  test("each layer is reported separately", () => {
    const data = extractStructuredData(parseHtml(html));
    expect(data.jsonLd).toEqual([{ "@type": "Product", name: "Bolt" }]);
    expect(data.openGraph).toEqual({ title: "W" });
    expect(data.twitter).toEqual({ card: "summary" });
    expect(data.meta).toEqual({ description: "d" });
    expect(data.title).toBe("T");
    expect(data.canonical).toBe("https://x.test/p");
  });

  test("broken JSON-LD is reported, not dropped", () => {
    // A page with broken structured data looks identical to one carrying
    // none, and those need different action.
    expect(extractStructuredData(parseHtml(html)).invalid).toHaveLength(1);
  });

  test("a page with nothing reports empties rather than failing", () => {
    const data = extractStructuredData(parseHtml("<p>x</p>"));
    expect(data).toMatchObject({ jsonLd: [], title: "", canonical: "", invalid: [] });
  });
});

describe("records", () => {
  const html = `<div class=p><span class=n>A</span><a class=l href=/1>go</a></div>
    <div class=p><span class=n>B</span></div>`;

  test("a container and field selectors produce rows", () => {
    const result = extractRecords(parseHtml(html), {
      container: ".p",
      fields: { name: ".n", url: "a.l@href" },
    });
    expect(result.records).toEqual([
      { name: "A", url: "/1" },
      { name: "B", url: "" },
    ]);
  });

  test("empty fields are counted, so a stale recipe is visible", () => {
    // Rows of blanks look like data; a count does not.
    const result = extractRecords(parseHtml(html), {
      container: ".p",
      fields: { url: "a.l@href", missing: ".nope" },
    });
    expect(result.missing).toEqual({ url: 1, missing: 2 });
  });

  test("an empty field selector takes the container itself", () => {
    const result = extractRecords(parseHtml(html), { container: ".n", fields: { v: "" } });
    expect(result.records).toEqual([{ v: "A" }, { v: "B" }]);
  });
});

describe("readable text", () => {
  const html = `<html><head><title>T</title><script>var a=1;</script></head>
    <body><nav><a href=/n>Nav</a></nav><main><h1>H</h1><p>Prose.</p></main>
    <style>.a{}</style><footer>Foot</footer></body></html>`;

  test("script, style and head content never appear", () => {
    // An earlier version returned a page's inline JavaScript as body text,
    // which is both wrong and usually the largest thing on the page.
    const text = readableText(parseHtml(html), false);
    expect(text).not.toContain("var a=1");
    expect(text).not.toContain(".a{}");
    expect(text).not.toContain("T");
    expect(text).toContain("Prose.");
  });

  test("boilerplate is dropped only when asked for", () => {
    expect(readableText(parseHtml(html), false)).toContain("Nav");
    const clean = readableText(parseHtml(html), true);
    expect(clean).not.toContain("Nav");
    expect(clean).not.toContain("Foot");
    expect(clean).toContain("Prose.");
  });

  test("block elements become line breaks and whitespace collapses", () => {
    // Two paragraphs are separated by a blank line, as they render.
    expect(readableText(parseHtml("<p>a</p><p>b</p>"), false)).toBe("a\n\nb");
    expect(readableText(parseHtml("<div>a</div><div>b</div>"), false)).toBe("a\n\nb");
    expect(readableText(parseHtml("<span>a</span><span>b</span>"), false)).toBe("ab");
    expect(normalizeText("  a   \n\n\n\n  b  ")).toBe("a\n\nb");
  });

  test("the outline lists headings with their levels", () => {
    expect(outline(parseHtml("<h1 id=a>A</h1><h3>C</h3><h2>B</h2>"))).toEqual([
      { level: 1, text: "A", id: "a" },
      { level: 3, text: "C", id: "" },
      { level: 2, text: "B", id: "" },
    ]);
  });

  test("walk reaches every element once", () => {
    expect([...walk(parseHtml("<div><p><b>x</b></p></div>"))].map((n) => n.tag)).toEqual([
      "div",
      "p",
      "b",
    ]);
  });
});
