/**
 * The wiki reader's minimal safe markdown subset: headings, bold, inline
 * code, lists, fenced code — and, critically, NO raw-HTML passthrough.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { parseInline, parseMarkdown } from "../assets/js/markdown.js";

describe("parseInline", () => {
  test("plain text is one span", () => {
    expect(parseInline("hello world")).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("bold and code split out", () => {
    expect(parseInline("a **b** and `c`")).toEqual([
      { type: "text", text: "a " },
      { type: "bold", text: "b" },
      { type: "text", text: " and " },
      { type: "code", text: "c" },
    ]);
  });

  test("unterminated markers stay literal", () => {
    expect(parseInline("a **b and `c")).toEqual([{ type: "text", text: "a **b and `c" }]);
  });
});

describe("parseMarkdown", () => {
  test("headings clamp to h1..h6 and carry spans", () => {
    const blocks = parseMarkdown("# Title\n\n### Sub **bold**");
    expect(blocks[0]).toEqual({
      type: "heading",
      level: 1,
      spans: [{ type: "text", text: "Title" }],
    });
    expect(blocks[1].level).toBe(3);
    expect(blocks[1].spans[1]).toEqual({ type: "bold", text: "bold" });
  });

  test("paragraph lines join; blank lines split", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].spans[0].text).toBe("one two");
    expect(blocks[1].spans[0].text).toBe("three");
  });

  test("unordered and ordered lists, kept separate", () => {
    const blocks = parseMarkdown("- a\n- b\n1. x\n2. y");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].ordered).toBe(false);
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].items[1][0].text).toBe("y");
  });

  test("fenced code keeps its body verbatim (no inline parsing inside)", () => {
    const blocks = parseMarkdown("```\nconst x = **not bold**;\n```");
    expect(blocks).toEqual([{ type: "code", text: "const x = **not bold**;" }]);
  });

  test("an unclosed fence swallows to EOF instead of throwing", () => {
    const blocks = parseMarkdown("```\nabc");
    expect(blocks).toEqual([{ type: "code", text: "abc" }]);
  });

  test("raw HTML is NEVER a block or tag — it stays literal text", () => {
    const blocks = parseMarkdown('<script>alert("x")</script>\n\n<b>bold?</b>');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("para");
    expect(blocks[0].spans[0].text).toContain("<script>");
    expect(blocks[1].spans[0].text).toBe("<b>bold?</b>");
  });

  test("empty/nullish input yields no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
  });
});
