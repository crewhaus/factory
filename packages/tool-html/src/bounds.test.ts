/**
 * The parser and the selector engine do work in proportion to their input.
 *
 * Both run synchronously on the harness's one thread, on markup a fetched
 * page controls, so a super-linear path stalls every session in the process.
 * 0.7.0 had three: the selector matcher re-ran the rest of a selector for
 * every qualifying ancestor or earlier sibling (exponential in the step
 * count), the parser lowercased the whole document once per `<title>`,
 * `<script>`, `<style>` or `<textarea>` (quadratic), and every stray close
 * tag walked the open-element chain (maxDepth per close).
 *
 * These tests count work rather than time it: a count holds on a CI runner
 * twenty times slower, and on the old code each one fails in well under a
 * second instead of hanging. The differential tests pin the new code's
 * answers to the old algorithms, kept here as oracles.
 */
import { describe, expect, test } from "bun:test";
import { htmlForms, htmlLinks, htmlQuery, htmlRecords, htmlTable, htmlText } from "./index";
import { extractForms, extractRecords, extractTable } from "./lib/extract";
import { type Element, boundedText, normalizeText, parseHtml, textOf, walk } from "./lib/parse";
import {
  MATCH_WORK_LIMIT,
  MAX_COMPOUND_TESTS,
  MAX_SELECTOR_CHARS,
  MAX_SELECTOR_GROUP,
  MAX_SELECTOR_STEPS,
  createMatchContext,
  firstMatchIn,
  matches,
  parseSelectorGroup,
  queryAll,
} from "./lib/select";

/** Give every element a counting `attrs`, and return the counter. */
function countClassReads(root: Element): { reads: number; nodes: number } {
  const counter = { reads: 0, nodes: 0 };
  for (const el of walk(root)) {
    counter.nodes++;
    const attrs = el.attrs;
    (el as { attrs: unknown }).attrs = new Proxy(attrs, {
      get(target, key) {
        if (key === "class") counter.reads++;
        return Reflect.get(target, key);
      },
    });
  }
  return counter;
}

describe("the selector engine answers each (element, step) question once", () => {
  test("descendant chains: work is proportional to elements x steps", () => {
    // 0.7.0: 5,985,197 class reads for this, exponential in the steps.
    const root = parseHtml(`${'<div class="d">'.repeat(60)}x${"</div>".repeat(60)}`);
    const counter = countClassReads(root);
    expect(queryAll(root, ".s .d .d .d .d")).toEqual([]);
    expect(counter.nodes).toBe(60);
    expect(counter.reads).toBeLessThanOrEqual(counter.nodes * 5 * 2);
  });

  test("the parser's full depth with a six-step selector that fails at its first step", () => {
    const root = parseHtml(`${'<div class="d">'.repeat(512)}x`);
    const counter = countClassReads(root);
    expect(queryAll(root, ".s .d .d .d .d .d")).toEqual([]);
    expect(counter.nodes).toBe(512);
    expect(counter.reads).toBeLessThanOrEqual(counter.nodes * 6 * 2);
  });

  test("general-sibling chains: work is proportional to elements x steps", () => {
    const root = parseHtml(`<div>${'<p class="d"></p>'.repeat(200)}</div>`);
    const counter = countClassReads(root);
    expect(queryAll(root, ".s ~ .d ~ .d ~ .d")).toEqual([]);
    expect(counter.reads).toBeLessThanOrEqual(counter.nodes * 4 * 2);
  });

  test("a long sibling list does not overflow the stack", () => {
    const root = parseHtml(`<div><h1></h1>${"<p></p>".repeat(100_000)}</div>`);
    expect(queryAll(root, "h1 ~ p ~ p")).toHaveLength(99_999);
    expect(queryAll(root, "h2 ~ p")).toEqual([]);
  }, 20_000);

  test("positional pseudo-classes index a parent's children once, not once per child", () => {
    const root = parseHtml(`<div>${"<p></p>".repeat(5_000)}</div>`);
    const div = root.children[0] as Element;
    const children = div.children;
    let reads = 0;
    Object.defineProperty(div, "children", {
      get() {
        reads++;
        return children;
      },
    });
    expect(queryAll(root, "p:last-child")).toHaveLength(1);
    expect(queryAll(root, "p:nth-of-type(4999) + p")).toHaveLength(1);
    // One read by the tree walk and one by the index, per query.
    expect(reads).toBeLessThanOrEqual(4);
  });

  test("a selector longer than the step cap is refused, naming the cap", () => {
    const root = parseHtml("<div></div>");
    expect(MAX_SELECTOR_STEPS).toBe(32);
    expect(() => queryAll(root, Array(33).fill("div").join(" "))).toThrow(/at most 32/);
    expect(queryAll(root, Array(32).fill("div").join(" "))).toEqual([]);
    expect(() =>
      queryAll(
        root,
        Array(MAX_SELECTOR_GROUP + 1)
          .fill("div")
          .join(", "),
      ),
    ).toThrow(/33 selectors; at most 32/);
  });

  test("a compound making more tests than the cap is refused, naming the cap", () => {
    // 0.7.1's first matcher took 47 s on `div` + 800 `:not(.q)` against a
    // 3.2 MB page: the tests in one compound had no bound.
    const root = parseHtml("<div class=x></div>");
    expect(MAX_COMPOUND_TESTS).toBe(32);
    // `div` is 1 test and each `:not(.q)` is 2, so 15 of them make 31.
    expect(queryAll(root, `div${":not(.q)".repeat(15)}`)).toHaveLength(1);
    expect(() => queryAll(root, `div${":not(.q)".repeat(16)}`)).toThrow(
      /makes 33 tests on one element; at most 32/,
    );
    expect(() => queryAll(root, `.a${".b".repeat(32)}`)).toThrow(/at most 32/);
    expect(() => queryAll(root, `div[x]${":not([y])".repeat(16)}`)).toThrow(/at most 32/);
  });

  test("a selector longer than the character cap is refused before it is parsed", () => {
    const root = parseHtml("<div></div>");
    expect(MAX_SELECTOR_CHARS).toBe(8_192);
    const long = `div${" ".repeat(MAX_SELECTOR_CHARS)}`;
    expect(() => queryAll(root, long)).toThrow(/8195 characters; at most 8192/);
    expect(queryAll(root, `div${" ".repeat(MAX_SELECTOR_CHARS - 3)}`)).toHaveLength(1);
  });

  test("an element's class list is split once per query, however many class tests it meets", () => {
    const root = parseHtml(`<section>${'<div class="a b c d e"></div>'.repeat(300)}</section>`);
    const counter = countClassReads(root);
    // Eleven class tests on each div, across two selectors of the group.
    const selector = "div.a.b:not(.q):not(.r):not(.s), section > div.c.d:not(.t):not(.u).e";
    expect(queryAll(root, selector)).toHaveLength(300);
    expect(counter.nodes).toBe(301);
    // 0.7.1's first matcher split it once per test: 11 reads per div.
    expect(counter.reads).toBeLessThanOrEqual(counter.nodes);
  });

  test("the queries of one context keep nothing per element", () => {
    // 0.7.1's first matcher memoised a row per element per selector in the
    // context, and HtmlRecords kept one context for all its fields: a 64 KB
    // page with 64 fields of 32 selectors took 2.7 GB. What a context holds
    // after the same queries must not grow with the page.
    const retained = (elements: number): number => {
      const root = parseHtml(`<body>${"<b><i></i></b>".repeat(elements)}</body>`);
      const ctx = createMatchContext();
      for (let f = 0; f < 8; f++) {
        const group = Array.from({ length: 8 }, (_, i) => `q${f}x${i} > b, b > i${i}`).join(", ");
        queryAll(root, group, Number.POSITIVE_INFINITY, ctx);
        firstMatchIn(root, queryAll(root, "b", 50, ctx), group, ctx);
      }
      const seen = new Set<unknown>();
      let entries = 0;
      const count = (value: unknown): void => {
        if (value === null || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (value instanceof Map) {
          entries += value.size;
          for (const [k, v] of value) {
            count(k);
            count(v);
          }
        } else if (Array.isArray(value)) {
          entries += value.length;
          for (const v of value) count(v);
        } else if (ArrayBuffer.isView(value)) {
          entries += (value as unknown as { length: number }).length;
        } else if (value instanceof WeakMap || value instanceof WeakSet) {
          entries += 1_000_000; // opaque, and per-element by nature
        } else {
          for (const v of Object.values(value)) count(v);
        }
      };
      count(ctx);
      return entries;
    };
    const small = retained(100);
    expect(small).toBeGreaterThan(0);
    expect(retained(5_000)).toBe(small);
  }, 20_000);

  test("work past the context's budget is refused with the selector named, not run", () => {
    expect(MATCH_WORK_LIMIT).toBe(200_000_000);
    const root = parseHtml(`<div>${"<p></p>".repeat(2_000)}</div>`);
    const ctx = createMatchContext(5_000);
    expect(() => queryAll(root, "div p ~ p", Number.POSITIVE_INFINITY, ctx)).toThrow(
      /matching "div p ~ p" on this page needs more than the 5000 units of work one call may spend/,
    );
    // The budget is spent, not merely checked per query: a second query in
    // the same context is refused too.
    expect(() => queryAll(root, "p", 1, ctx)).toThrow(/units of work/);
    // The same query with room to spare answers.
    const roomy = createMatchContext(100_000);
    expect(queryAll(root, "div p ~ p", Number.POSITIVE_INFINITY, roomy)).toHaveLength(1_999);
    expect(roomy.limit - roomy.work).toBeGreaterThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// The 0.7.0 matcher, unchanged, as the oracle.

type Simple = ReturnType<typeof parseSelectorGroup>[number][number]["simple"];
type Selector = ReturnType<typeof parseSelectorGroup>[number];

function naiveChildren(node: Element | null): Element[] {
  if (node === null) return [];
  return node.children.filter((c): c is Element => c.type === "element");
}

function naiveSimple(node: Element, simple: Simple): boolean {
  if (simple.tag !== null && node.tag !== simple.tag) return false;
  if (simple.id !== null && node.attrs["id"] !== simple.id) return false;
  const have = (node.attrs["class"] ?? "").split(/\s+/).filter((c) => c !== "");
  if (!simple.classes.every((c) => have.includes(c))) return false;
  for (const attr of simple.attrs) {
    const raw = node.attrs[attr.name];
    if (raw === undefined) return false;
    if (attr.op === "=" && raw !== attr.value) return false;
  }
  for (const pseudo of simple.pseudos) {
    const siblings = naiveChildren(node.parent);
    switch (pseudo.kind) {
      case "first-child":
        if (siblings[0] !== node) return false;
        break;
      case "last-child":
        if (siblings[siblings.length - 1] !== node) return false;
        break;
      case "nth-child":
        if (siblings[pseudo.index - 1] !== node) return false;
        break;
      case "nth-of-type":
        if (siblings.filter((s) => s.tag === node.tag)[pseudo.index - 1] !== node) return false;
        break;
      default:
        if (naiveSimple(node, pseudo.simple)) return false;
    }
  }
  return true;
}

function naiveFrom(node: Element, selector: Selector, index: number): boolean {
  if (index === 0) return true;
  const step = selector[index] as Selector[number];
  const previous = selector[index - 1] as Selector[number];
  if (step.combinator === ">") {
    const parent = node.parent;
    if (parent === null || !naiveSimple(parent, previous.simple)) return false;
    return naiveFrom(parent, selector, index - 1);
  }
  if (step.combinator === "+" || step.combinator === "~") {
    const siblings = naiveChildren(node.parent);
    const at = siblings.indexOf(node);
    if (at <= 0) return false;
    const candidates =
      step.combinator === "+" ? [siblings[at - 1]] : siblings.slice(0, at).reverse();
    return candidates.some(
      (c) =>
        c !== undefined && naiveSimple(c, previous.simple) && naiveFrom(c, selector, index - 1),
    );
  }
  for (let a = node.parent; a !== null; a = a.parent) {
    if (naiveSimple(a, previous.simple) && naiveFrom(a, selector, index - 1)) return true;
  }
  return false;
}

function naiveQueryAll(root: Element, source: string): Element[] {
  const group = parseSelectorGroup(source);
  return [...walk(root)].filter((node) =>
    group.some((sel) => {
      const last = sel[sel.length - 1];
      return (
        last !== undefined && naiveSimple(node, last.simple) && naiveFrom(node, sel, sel.length - 1)
      );
    }),
  );
}

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTree(rand: () => number, depth: number): string {
  const tags = ["div", "p", "span"];
  const classes = ["a", "b", ""];
  const count = Math.floor(rand() * 5);
  let out = "";
  for (let i = 0; i < count; i++) {
    const tag = tags[Math.floor(rand() * tags.length)] as string;
    const cls = classes[Math.floor(rand() * classes.length)] as string;
    const inner = depth > 0 ? randomTree(rand, depth - 1) : "";
    // `<p>` closes an open `<p>`; that is part of what is being compared.
    out += `<${tag}${cls === "" ? "" : ` class=${cls}`}>${inner}</${tag}>`;
  }
  return out;
}

function randomSelector(rand: () => number): string {
  const simples = ["div", "p", "span", ".a", ".b", "*", "div.a", ":first-child", "p:last-child"];
  const extra = [":nth-child(2)", ":nth-of-type(1)", ":not(.a)", ""];
  const combinators = [" ", " > ", " + ", " ~ "];
  const steps = 1 + Math.floor(rand() * 4);
  let out = "";
  for (let i = 0; i < steps; i++) {
    if (i > 0) out += combinators[Math.floor(rand() * combinators.length)];
    out += simples[Math.floor(rand() * simples.length)];
    out += extra[Math.floor(rand() * extra.length)];
  }
  return rand() < 0.2 ? `${out}, ${simples[Math.floor(rand() * simples.length)]}` : out;
}

describe("the matcher gives the 0.7.0 matcher's answers", () => {
  test("random trees and selectors over all four combinators and the pseudo-classes", () => {
    let compared = 0;
    let nonEmpty = 0;
    let underContainer = 0;
    let containerHits = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rand = prng(seed);
      const root = parseHtml(randomTree(rand, 4));
      const elements = [...walk(root)];
      for (let k = 0; k < 5; k++) {
        const selector = randomSelector(rand);
        const expected = naiveQueryAll(root, selector);
        const got = queryAll(root, selector);
        expect({ seed, selector, got }).toEqual({ seed, selector, got: expected });
        compared++;
        if (expected.length > 0) nonEmpty++;
        // The same selector under containers, where ancestors and siblings
        // outside the container count, and every container at once.
        const containers = elements.filter(() => rand() < 0.3);
        const first = firstMatchIn(root, containers, selector);
        containers.forEach((container, i) => {
          const want = naiveQueryAll(container, selector);
          expect({ seed, selector, i, got: queryAll(container, selector) }).toEqual({
            seed,
            selector,
            i,
            got: want,
          });
          expect({ seed, selector, i, first: first[i] }).toEqual({
            seed,
            selector,
            i,
            first: want[0],
          });
          underContainer++;
          if (want.length > 0) containerHits++;
        });
        for (const node of elements) {
          const group = parseSelectorGroup(selector);
          const want = group.some((sel) => {
            const last = sel[sel.length - 1];
            return (
              last !== undefined &&
              naiveSimple(node, last.simple) &&
              naiveFrom(node, sel, sel.length - 1)
            );
          });
          expect({ seed, selector, got: group.some((sel) => matches(node, sel)) }).toEqual({
            seed,
            selector,
            got: want,
          });
        }
      }
    }
    expect(compared).toBe(2_000);
    // The comparison has to exercise matches, not only empty answers.
    expect(nonEmpty).toBeGreaterThan(500);
    expect(underContainer).toBeGreaterThan(2_000);
    expect(containerHits).toBeGreaterThan(300);
  }, 30_000);

  test("an ancestor or sibling outside the queried container still counts", () => {
    const root = parseHtml(
      "<section class=a><div id=box><p class=b>1</p></div></section><h1></h1><div id=next><p>2</p></div>",
    );
    const box = queryAll(root, "#box")[0] as Element;
    expect(queryAll(box, ".a .b")).toHaveLength(1);
    expect(queryAll(box, "section > div > p")).toHaveLength(1);
    const next = queryAll(root, "#next")[0] as Element;
    expect(queryAll(next, "h1 + div p")).toHaveLength(1);
    expect(queryAll(next, "section ~ div > p")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The parser.

describe("the parser does linear work", () => {
  test("raw-text elements do not lowercase the document once each", () => {
    const source = "<title>x</title>".repeat(4_096);
    const original = String.prototype.toLowerCase;
    let lowered = 0;
    String.prototype.toLowerCase = function (this: string): string {
      lowered += this.length;
      return original.call(this);
    };
    let root: Element;
    try {
      root = parseHtml(source);
    } finally {
      String.prototype.toLowerCase = original;
    }
    // 0.7.0 lowercased 4,096 x 64 KiB here.
    expect(lowered).toBeLessThanOrEqual(source.length);
    expect(root.children).toHaveLength(4_096);
  });

  test("a megabyte of <title> elements parses", () => {
    const root = parseHtml("<title>x</title>".repeat(65_536));
    expect(root.children).toHaveLength(65_536);
    expect(textOf(root.children[65_535] as Element)).toBe("x");
  }, 20_000);

  test("a stray close tag does not walk the open-element chain", () => {
    // Counted through the barrier check the walk makes at every step: 0.7.0
    // made 512 of them per `</x>` here.
    const source = `${"<div>".repeat(512)}${"</x>".repeat(20_000)}<i>end</i>`;
    const original = Set.prototype.has;
    let checks = 0;
    Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
      checks++;
      return original.call(this, value);
    };
    let root: Element;
    try {
      root = parseHtml(source);
    } finally {
      Set.prototype.has = original;
    }
    expect(checks).toBeLessThanOrEqual(10 * (512 + 1));
    let deepest = root;
    for (let d = 0; d < 512; d++) deepest = deepest.children[0] as Element;
    expect(deepest.tag).toBe("div");
    expect(queryAll(root, "i")).toHaveLength(1);
    expect((queryAll(root, "i")[0] as Element).parent).toBe(deepest);
  });
});

describe("the parser's offsets are in the source, whatever lowercases longer", () => {
  test("a character whose lowercase is longer does not move a raw-text element's end", () => {
    const root = parseHtml("İ<title>abc</title><p>after</p>");
    expect(textOf(queryAll(root, "title")[0] as Element)).toBe("abc");
    expect(textOf(queryAll(root, "p")[0] as Element).trim()).toBe("after");
  });

  test("a script after Turkish text keeps exactly its own body", () => {
    const root = parseHtml(
      `<p>${"İ".repeat(20)}</p><script>var x=1;</script><div id=a>visible</div>`,
    );
    expect(textOf(queryAll(root, "script")[0] as Element, false)).toBe("var x=1;");
    const div = queryAll(root, "#a")[0] as Element;
    expect(textOf(div)).toContain("visible");
    expect(textOf(parseHtml("<title>İstanbul</title>").children[0] as Element)).toBe("İstanbul");
  });

  test("a tag name with such a character keeps its content", () => {
    expect(textOf(parseHtml("<aİ>hello</aİ>"))).toContain("hello");
  });

  test("close tags fold ASCII case only", () => {
    const root = parseHtml("<SCRIPT>a</ScRiPt><p>b</p>");
    expect(textOf(queryAll(root, "script")[0] as Element, false)).toBe("a");
    expect(textOf(queryAll(root, "p")[0] as Element).trim()).toBe("b");
    // U+017F uppercases to S, but a browser's tag match is ASCII-only.
    const long = parseHtml("<script>a</ſcript>b</script>");
    expect(textOf(queryAll(long, "script")[0] as Element, false)).toBe("a</ſcript>b");
  });

  test("an element named like an Object.prototype member parses", () => {
    const root = parseHtml("<constructor><p>x</p></constructor>");
    expect(queryAll(root, "constructor > p")).toHaveLength(1);
  });
});

// The 0.7.0 close-tag handling, as an oracle for the counted version, over
// tag-only markup (no attributes, comments or non-ASCII, where nothing else
// changed).
const O_VOID = new Set(["br"]);
const O_RAW = new Set(["title"]);
const O_BARRIER = new Set(["table", "body"]);
const O_IMPLICIT: Record<string, string[]> = {
  li: ["li"],
  p: ["p"],
  td: ["td", "th"],
  tr: ["td", "th", "tr"],
};

type OracleNode = { tag: string; children: OracleNode[]; parent: OracleNode | null } | string;

function oracleParse(source: string, maxDepth: number): OracleNode {
  const root = { tag: "#root", children: [] as OracleNode[], parent: null as never };
  let current: { tag: string; children: OracleNode[]; parent: typeof current | null } = root;
  let depth = 0;
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      current.children.push(source.slice(i));
      break;
    }
    if (lt > i) current.children.push(source.slice(i, lt));
    const isClose = source.startsWith("</", lt);
    const gt = source.indexOf(">", lt);
    const tag = source.slice(lt + (isClose ? 2 : 1), gt);
    i = gt + 1;
    if (isClose) {
      let node: typeof current | null = current;
      let unwound = 0;
      while (node !== null && node !== root) {
        if (node.tag === tag) {
          current = node.parent ?? root;
          depth = Math.max(0, depth - unwound - 1);
          break;
        }
        if (O_BARRIER.has(node.tag)) break;
        node = node.parent;
        unwound++;
      }
      continue;
    }
    for (const closable of O_IMPLICIT[tag] ?? []) {
      if (current.tag === closable) {
        current = current.parent ?? root;
        depth = Math.max(0, depth - 1);
      }
    }
    const node = { tag, children: [] as OracleNode[], parent: current };
    current.children.push(node);
    if (O_VOID.has(tag)) continue;
    if (O_RAW.has(tag)) {
      const closeAt = source.indexOf(`</${tag}`, i);
      const end = closeAt === -1 ? source.length : closeAt;
      if (end > i) node.children.push(source.slice(i, end));
      const close = closeAt === -1 ? -1 : source.indexOf(">", closeAt);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    if (depth < maxDepth) {
      current = node;
      depth++;
    }
  }
  return root;
}

function shape(node: OracleNode | Element["children"][number]): unknown {
  if (typeof node === "string") return node;
  if ("type" in node && node.type === "text") return node.value;
  const el = node as { tag: string; children: Array<OracleNode | Element["children"][number]> };
  return [el.tag, el.children.map(shape)];
}

describe("the counted stray-close check changes no tree", () => {
  test("random tag soup parses to the tree the 0.7.0 walk built", () => {
    const tags = ["div", "span", "li", "p", "td", "tr", "table", "body", "br", "title", "x"];
    let differentFromNoClose = 0;
    for (let seed = 1; seed <= 1_500; seed++) {
      const rand = prng(seed);
      let source = "";
      const length = 5 + Math.floor(rand() * 40);
      for (let k = 0; k < length; k++) {
        const tag = tags[Math.floor(rand() * tags.length)] as string;
        const r = rand();
        if (r < 0.45) source += `</${tag}>`;
        else if (r < 0.9) source += `<${tag}>`;
        else source += "t";
      }
      const maxDepth = 1 + Math.floor(rand() * 8);
      const got = shape(parseHtml(source, { maxDepth }));
      expect({ seed, source, got }).toEqual({
        seed,
        source,
        got: shape(oracleParse(source, maxDepth)),
      });
      if (source.includes("</")) differentFromNoClose++;
    }
    expect(differentFromNoClose).toBeGreaterThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// HtmlTable's span expansion.

/** The 0.7.0 expansion, kept as the oracle for tables no limit touches. */
function expandTable070(table: Element): {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
} {
  const cellText = (node: Element): string => normalizeText(textOf(node));
  const rows = queryAll(table, "tr");
  const grid: string[][] = [];
  const carry = new Map<number, { text: string; remaining: number }>();
  for (const [rowIndex, row] of rows.entries()) {
    const out: string[] = [];
    let column = 0;
    const drainCarried = (): void => {
      while (carry.has(column)) {
        const held = carry.get(column) as { text: string; remaining: number };
        out[column] = held.text;
        if (held.remaining <= 1) carry.delete(column);
        else carry.set(column, { text: held.text, remaining: held.remaining - 1 });
        column++;
      }
    };
    for (const cell of row.children) {
      if (cell.type !== "element" || (cell.tag !== "td" && cell.tag !== "th")) continue;
      const text = cellText(cell);
      const colspan = Math.max(
        1,
        Math.min(1000, Number.parseInt(cell.attrs["colspan"] ?? "1", 10) || 1),
      );
      const rowspan = Math.max(
        1,
        Math.min(1000, Number.parseInt(cell.attrs["rowspan"] ?? "1", 10) || 1),
      );
      for (let c = 0; c < colspan; c++) {
        drainCarried();
        const at = column;
        out[column] = text;
        column++;
        if (rowspan > 1) carry.set(at, { text, remaining: rowspan - 1 });
      }
    }
    drainCarried();
    grid[rowIndex] = Array.from(out, (v) => v ?? "");
  }
  const firstRow = rows[0];
  const cellsIn = (node: Element | undefined, tags: ReadonlyArray<string>): number =>
    node === undefined
      ? 0
      : node.children.filter((c) => c.type === "element" && tags.includes(c.tag)).length;
  const headerCount = cellsIn(firstRow, ["th"]);
  const hasHeader = headerCount > 0 && headerCount === cellsIn(firstRow, ["td", "th"]);
  const body = hasHeader ? grid.slice(1) : grid;
  return {
    headers: hasHeader ? (grid[0] ?? []) : [],
    rows: body,
    rowCount: body.length,
    columnCount: grid.length === 0 ? 0 : Math.max(...grid.map((r) => r.length)),
  };
}

function randomTable(rand: () => number): string {
  const rowCount = 1 + Math.floor(rand() * 6);
  let html = "<table>";
  for (let r = 0; r < rowCount; r++) {
    html += "<tr>";
    const cells = Math.floor(rand() * 5);
    for (let c = 0; c < cells; c++) {
      const tag = r === 0 && rand() < 0.6 ? "th" : "td";
      const colspan = rand() < 0.3 ? ` colspan=${1 + Math.floor(rand() * 4)}` : "";
      const rowspan = rand() < 0.3 ? ` rowspan=${1 + Math.floor(rand() * 5)}` : "";
      html += `<${tag}${colspan}${rowspan}>${String.fromCharCode(97 + Math.floor(rand() * 26))}${r}${c}`;
    }
  }
  return `${html}</table>`;
}

describe("HtmlTable builds a bounded grid", () => {
  const lift = (html: string, limits: Parameters<typeof extractTable>[1]) =>
    extractTable(queryAll(parseHtml(html), "table")[0] as Element, limits);
  const tool = async (input: Record<string, unknown>): Promise<string> =>
    htmlTable.execute(htmlTable.inputSchema.parse(input), {} as never) as Promise<string>;

  test("a rowspan bomb stops at maxRows and the column cap, and still reports the true row count", () => {
    // Five cells of colspan=1000 rowspan=1000 over 1,000 rows: five million
    // cells on 0.7.0, all built before maxRows sliced them.
    const html = `<table><tr>${"<td colspan=1000 rowspan=1000>x</td>".repeat(5)}</tr>${"<tr>".repeat(999)}</table>`;
    const lifted = lift(html, { maxRows: 1, maxColumns: 1000 });
    expect({
      rows: lifted.rows.length,
      width: lifted.rows[0]?.length,
      rowCount: lifted.rowCount,
      truncatedBy: lifted.truncatedBy,
    }).toEqual({ rows: 1, width: 1000, rowCount: 1000, truncatedBy: ["rows", "columns"] });
  }, 20_000);

  test("the same bomb at the default maxRows stays within the character budget", async () => {
    const html = `<table><tr>${"<td colspan=1000 rowspan=1000>x</td>".repeat(5)}</tr>${"<tr>".repeat(999)}</table>`;
    const raw = await tool({ html });
    // 0.7.0 returned 10 MB here with truncated: true only for the row cut.
    expect(raw.length).toBeLessThan(2_100_000);
    const table = JSON.parse(raw).tables[0];
    expect(table.truncated).toBe(true);
    expect(table.rowCount).toBe(1000);
    for (const row of table.rows as string[][]) expect(row.length).toBe(1000);
  }, 20_000);

  test("colspan fan-out is cut at the column cap and says so", async () => {
    // 58 KB of markup; 0.7.0 answered 10,000,232 characters with truncated: false.
    const html = `<table>${`<tr>${"<td colspan=1000>x</td>".repeat(50)}</tr>`.repeat(50)}</table>`;
    const raw = await tool({ html });
    expect(raw.length).toBeLessThan(250_000);
    const table = JSON.parse(raw).tables[0];
    expect({ rows: table.rows.length, truncatedBy: table.truncatedBy }).toEqual({
      rows: 50,
      truncatedBy: ["columns"],
    });
  }, 20_000);

  test("one long cell spanned 1,000 times is stopped by the budget, not copied 1,000 times", async () => {
    const html = `<table><tr><td colspan=1000>${"A".repeat(10_000)}</td></tr></table>`;
    const raw = await tool({ html });
    // 0.7.0: 10,003,132 characters, truncated: false. A row the budget cut is
    // dropped whole rather than returned short.
    expect(raw.length).toBeLessThan(2_100_000);
    const table = JSON.parse(raw).tables[0];
    expect({
      rows: table.rows.length,
      rowCount: table.rowCount,
      truncatedBy: table.truncatedBy,
    }).toEqual({
      rows: 0,
      rowCount: 1,
      truncatedBy: ["chars"],
    });
  });

  test("many tables share one budget, and the ones it could not reach are counted", async () => {
    // Ten tables of 101 rows x 1,000 one-character cells: 404 K each, so the
    // fifth runs out part-way.
    const one = `<table>${"<tr><td colspan=1000>x</td></tr>".repeat(101)}</table>`;
    const raw = await tool({ html: one.repeat(10) });
    expect(raw.length).toBeLessThan(2_100_000);
    const out = JSON.parse(raw);
    expect(out.tableCount).toBe(10);
    expect(out.tables.length + out.tablesOmitted).toBe(10);
    expect({ returned: out.tables.length, omitted: out.tablesOmitted }).toEqual({
      returned: 5,
      omitted: 5,
    });
    expect(out.note).toContain("budget");
    expect(out.tables[3].truncated).toBe(false);
    expect(out.tables[4].truncatedBy).toEqual(["chars"]);
  }, 20_000);

  test("a table no limit touches is lifted exactly as 0.7.0 lifted it", () => {
    let compared = 0;
    let spanned = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const html = randomTable(prng(seed));
      const table = queryAll(parseHtml(html), "table")[0] as Element;
      const want = expandTable070(table);
      const got = extractTable(table, { maxRows: 100, maxColumns: 1000, budget: { chars: 1e6 } });
      expect({
        seed,
        headers: got.headers,
        rows: got.rows,
        rowCount: got.rowCount,
        columnCount: got.columnCount,
        truncated: got.truncated,
      }).toEqual({ seed, ...want, truncated: false });
      compared += 1;
      if (/span=/.test(html)) spanned += 1;
    }
    expect(compared).toBe(500);
    expect(spanned).toBeGreaterThan(300);
  }, 20_000);
});

describe("element text is budgeted per call", () => {
  const run = async (
    tool: typeof htmlQuery,
    input: Record<string, unknown>,
  ): Promise<{ raw: string; out: Record<string, unknown> }> => {
    const raw = (await tool.execute(tool.inputSchema.parse(input), {} as never)) as string;
    return { raw, out: JSON.parse(raw) };
  };
  // Each level's text holds every deeper level's, so N nested elements of
  // T characters carry about N^2 T / 2 characters of text between them.
  const nested = (open: string, levels: number, chars: number): string =>
    `${open}${"x".repeat(chars)} `.repeat(levels);

  test("boundedText is textOf when it fits, and a cut prefix when it does not", () => {
    for (const html of [
      "<p>a <b>b</b>\n\n\n c</p><div> d <script>no</script><span>e</span></div>",
      "<ul><li>one<li>two</ul>  <table><tr><td>x<td>y</table>",
      nested("<div>", 20, 3),
    ]) {
      const root = parseHtml(html);
      const whole = normalizeText(textOf(root));
      const work = { units: 1_000_000 };
      expect(boundedText(root, whole.length, work)).toEqual({ text: whole, complete: true });
      const cut = boundedText(root, 5, { units: 1_000_000 });
      expect(cut).toEqual({ text: whole.slice(0, 5), complete: false });
    }
    // Work runs out: the walk stops and says so, having read no more than it was given.
    const work = { units: 50 };
    const root = parseHtml(nested("<div>", 200, 10));
    const got = boundedText(root, 1_000_000, work);
    expect(got.complete).toBe(false);
    expect(work.units).toBeLessThanOrEqual(0);
    expect(work.units).toBeGreaterThanOrEqual(-1);
  });

  test("HtmlQuery: nested matches stop at the text budget and say so", async () => {
    // 0.7.1's first cut answered 501,518,109 characters for this 1 MB page.
    const html = nested("<div>", 500, 2_000);
    const { raw, out } = await run(htmlQuery, { html, selector: "div", limit: 500 });
    expect(raw.length).toBeLessThan(2_100_000);
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toEqual(["chars"]);
    expect(String(out.note)).toContain("1000000-character text budget");
    const values = out.values as string[];
    expect(values.length).toBeLessThan(500);
    expect((out.matches as unknown[]).length).toBe(values.length);
    // A page no budget touches answers as 0.7.0 did, with no new fields.
    const small = await run(htmlQuery, { html: "<p>a</p><p>b</p>", selector: "p" });
    expect(small.out).toEqual({
      from: "inline",
      sourceChars: 16,
      selector: "p",
      count: 2,
      truncated: false,
      values: ["a", "b"],
      matches: [
        { tag: "p", text: "a", attrs: {} },
        { tag: "p", text: "b", attrs: {} },
      ],
    });
  });

  test("HtmlRecords: nested containers stop at the text budget and say so", async () => {
    const html = nested('<div class="c">', 400, 2_000);
    const { raw, out } = await run(htmlRecords, {
      html,
      container: ".c",
      fields: { all: "", inner: ".c" },
      limit: 400,
    });
    expect(raw.length).toBeLessThan(2_200_000);
    expect(out.truncated).toBe(true);
    expect(String(out.note)).toContain("text budget");
    expect((out.records as unknown[]).length).toBeLessThan(400);
    expect(out.containers).toBe(400);
  });

  test("HtmlRecords: a recipe finding no container never parses its field selectors", async () => {
    // 0.7.0 ran a field selector only inside a container, so a bad one with
    // no containers answered an empty table; the one-pass rewrite keeps that.
    const { out } = await run(htmlRecords, {
      html: "<p>x</p>",
      container: ".none",
      fields: { a: "a:hover" },
    });
    expect(out).toEqual({ from: "inline", containers: 0, count: 0, missing: {}, records: [] });
  });

  test("HtmlLinks: nested anchors stop at the text budget", async () => {
    const html = nested('<a href="/x">', 1_200, 2_000);
    const { raw, out } = await run(htmlLinks, { html, limit: 2_000 });
    expect(raw.length).toBeLessThan(2_300_000);
    expect(out.truncated).toBe(true);
    expect(out.truncatedBy).toEqual(["chars"]);
  });

  test("HtmlForms: one wrapping label is read within the budget for every control", async () => {
    // Each control inside a label takes the whole label's text as its label.
    const html = `<form><label>${"x".repeat(20_000)}${"<input name=a>".repeat(300)}</label></form>`;
    const { raw, out } = await run(htmlForms, { html });
    expect(raw.length).toBeLessThan(2_300_000);
    expect(out.truncated).toBe(true);
    expect(String(out.note)).toContain("text budget");
  });

  test("HtmlForms: a for= label is found from one index, not one page walk per control", () => {
    const html = `<form>${Array.from({ length: 200 }, (_, i) => `<label for=f${i}>L${i}</label><input id=f${i}>`).join("")}</form>`;
    const root = parseHtml(html);
    let reads = 0;
    for (const el of walk(root)) {
      const attrs = el.attrs;
      (el as { attrs: unknown }).attrs = new Proxy(attrs, {
        get(target, key) {
          if (key === "for") reads++;
          return Reflect.get(target, key);
        },
      });
    }
    const fields = extractForms(root)[0]?.fields ?? [];
    expect(fields).toHaveLength(200);
    expect(fields[7]?.label).toBe("L7");
    // 0.7.0 read every label's for= once per control: 40,000 reads.
    expect(reads).toBeLessThanOrEqual(2 * 200);
  });

  test("HtmlText: nested headings stop the outline at the text budget", async () => {
    const html = nested("<h2>", 500, 2_000);
    const { raw, out } = await run(htmlText, { html, outline: true, maxChars: 10 });
    expect(raw.length).toBeLessThan(2_200_000);
    expect(out.outlineTruncated).toBe(true);
    expect((out.outline as unknown[]).length).toBeLessThan(500);
  });

  test("HtmlTable: captions are charged to the budget and cut", async () => {
    // 0.7.1's first cut answered 50,306,845 characters for this 503 KB page,
    // with nothing marked truncated.
    const html = nested("<table><caption>", 200, 2_500);
    const { raw, out } = await run(htmlTable, { html });
    expect(raw.length).toBeLessThan(2_100_000);
    const tables = out.tables as Array<{ truncated: boolean; truncatedBy?: string[] }>;
    expect(tables.some((t) => t.truncatedBy?.includes("chars"))).toBe(true);
    expect((out.tablesOmitted as number) + tables.length).toBe(200);
  });

  test("HtmlTable: nested tables read no more text than the call's work budget", () => {
    // Every <tr> under a table is one of its rows, so each level re-reads
    // the levels below it: 450 KB of nested tables took 38.9 s.
    const html = `<table><tr><td>${"<b></b>".repeat(50)}`.repeat(40);
    const root = parseHtml(html);
    const work = { units: 20_000 };
    const budget = { chars: 2_000_000, work };
    const lifted = queryAll(root, "table").map((table) => extractTable(table, { budget }));
    expect(work.units).toBeLessThanOrEqual(0);
    expect(work.units).toBeGreaterThan(-100);
    expect(lifted.some((t) => t.truncatedBy.includes("chars"))).toBe(true);
    // With room to read, the same page lifts whole.
    const roomy = { chars: 2_000_000, work: { units: 10_000_000 } };
    const whole = queryAll(root, "table").map((table) => extractTable(table, { budget: roomy }));
    expect(whole.every((t) => !t.truncated)).toBe(true);
  });

  test("extractRecords answers what one query per container answered", () => {
    const html =
      "<ul class=l><li class=r><a href=/1>one</a><span>1</span></li><li class=r><span>2</span><li class=r><a href=/3>three</a><ul><li class=r><a href=/4>four</a></ul></ul>";
    const root = parseHtml(html);
    const got = extractRecords(root, {
      container: ".r",
      fields: { href: "a@href", n: "span", t: "a" },
    });
    const containers = queryAll(root, ".r");
    const want = containers.map((c) => ({
      href: queryAll(c, "a", 1)[0]?.attrs.href ?? "",
      n: normalizeText(textOf(queryAll(c, "span", 1)[0] ?? parseHtml(""))),
      t: normalizeText(textOf(queryAll(c, "a", 1)[0] ?? parseHtml(""))),
    }));
    expect(got.records.map((r) => ({ ...r }))).toEqual(want);
    expect({ ...got.missing }).toEqual({ n: 2, href: 1, t: 1 });
    expect(got.truncated).toBe(false);
  });
});
