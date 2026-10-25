import { describe, expect, test } from "bun:test";
import { blockMeter, commonMarkFences, fencedSpans, readBlocks } from "./markdown";

const blocks = (text: string): string[] =>
  commonMarkFences(text).map(([start, end]) => text.slice(start, end));

describe("commonMarkFences — the claim extractor's code reader", () => {
  test("a fence opens and closes with the same character, indented up to three spaces", () => {
    expect(blocks("a\n   ```ts\ncode\n  ```\nb")).toEqual(["   ```ts\ncode\n  ```"]);
    expect(blocks("~~~\ncode\n~~~")).toEqual(["~~~\ncode\n~~~"]);
    // Four spaces is indented code, not a fence.
    expect(blocks("    ```\ncode\n    ```")).toEqual([]);
  });

  test("a closing fence is at least as long, of the same character, with nothing after it", () => {
    expect(blocks("````\n```\n~~~~\n``` x\n````\nprose")).toEqual(["````\n```\n~~~~\n``` x\n````"]);
  });

  test("a backtick fence's info string has no backtick; a tilde fence's may", () => {
    expect(blocks("```x`\nprose\n")).toEqual([]);
    expect(blocks("~~~ a`b\ncode\n~~~")).toEqual(["~~~ a`b\ncode\n~~~"]);
  });

  test("lines break at \\n, \\r\\n and \\r only, never at U+2028", () => {
    expect(blocks("a. ```\nprose")).toEqual([]);
    expect(blocks("a\r\n```\r\ncode\r\n```\r\nb")).toEqual(["```\r\ncode\r\n```"]);
    expect(blocks("a\r```\rcode\r```\rb")).toEqual(["```\rcode\r```"]);
  });

  test("an unclosed fence runs to the end", () => {
    expect(blocks("prose\n```\ncode")).toEqual(["```\ncode"]);
  });

  test("a fence on a list item's marker line opens there, and its indented closer closes it", () => {
    // Read from column 0 the bullet hid the opener and the closer opened a
    // fence of its own that ran to the end of the answer.
    expect(blocks("1. ```bash\n   ls\n   ```\n\nThe refund window is 30 days [1].")).toEqual([
      "1. ```bash\n   ls\n   ```",
    ]);
    expect(blocks("- ```js\n  const x = 1;\n  ```\n\nRefunds are accepted.")).toEqual([
      "- ```js\n  const x = 1;\n  ```",
    ]);
    // Nested markers on one line, and a tab after the bullet.
    expect(blocks("- 1. ```\n     code\n     ```\nprose")).toEqual([
      "- 1. ```\n     code\n     ```",
    ]);
    expect(blocks("-\t```\n    code\n    ```\nprose")).toEqual(["-\t```\n    code\n    ```"]);
  });

  test("inside a list item, indentation is counted from the item's content", () => {
    // Four spaces under "- " is two into the item: a fence, not indented code.
    expect(blocks("- item\n\n    ```\n    code\n    ```\nprose")).toEqual([
      "    ```\n    code\n    ```",
    ]);
    // Six is four into it: indented code, so nothing opens.
    expect(blocks("- item\n\n      ```\n      code\n\nprose")).toEqual([]);
    // A paragraph line under an item is lazy; a fence at column 0 is the item's end.
    expect(blocks("- item\ntext\n```\ncode\n```\nprose")).toEqual(["```\ncode\n```"]);
  });

  test("a fence left open in a list item ends where the item does", () => {
    const text =
      "- Item one is here.\n\n  ```\n  code here\n\nRefunds are accepted within 30 days [1].";
    expect(blocks(text)).toEqual(["  ```\n  code here\n"]);
    // A closer at column 0 under "- ```js" is outside the item: the item's
    // fence ends before it, and it opens a fence of its own (CommonMark).
    expect(blocks("- ```js\n  code\n```\nprose")).toEqual(["- ```js\n  code", "```\nprose"]);
    // Blank lines inside the item's fence do not end it.
    expect(blocks("- ```\n  a\n\n  b\n  ```\nprose")).toEqual(["- ```\n  a\n\n  b\n  ```"]);
  });

  test("only an item that may interrupt a paragraph opens one there", () => {
    // "2." cannot interrupt a paragraph, so its backticks are text, and the
    // fence at column 0 below runs to the end.
    expect(blocks("Some text\n2. ```js\ncode\n```\nprose")).toEqual(["```\nprose"]);
    expect(blocks("Some text\n1. ```js\ncode\n```\nprose")).toEqual(["1. ```js", "```\nprose"]);
    // A thematic break is not a bullet.
    expect(blocks("* * *\n```\ncode\n```")).toEqual(["```\ncode\n```"]);
  });

  test("the citation grammar's reader is left as loose as it was (pinned)", () => {
    // CitationLint and FactCrossCheck read code through fencedSpans; their
    // output must not move, so the two readers are allowed to differ.
    const text = "```\ncode\n  ```\nRefunds take 30 days [1].";
    expect(fencedSpans(text)).toEqual([[0, text.length]]);
    expect(commonMarkFences(text)).toEqual([[0, "```\ncode\n  ```".length]]);
  });
});

describe("readBlocks — list items", () => {
  const items = (text: string): number[] => [...readBlocks(text).item];

  test("a line indented to an item's content cannot open an empty item, or one not numbered 1", () => {
    // It reaches the item's paragraph, so CommonMark's interruption rule
    // holds there as at the top level: these are the paragraph going on.
    expect(items("- Approval for refunds usually takes\n  1.\n")).toEqual([1, 0, 0]);
    expect(items("1. The refund window was cut to\n   14. Customers were told.")).toEqual([1, 0]);
    // With content and numbered 1, or a bullet, it may interrupt.
    expect(items("1. Steps to follow\n   1. Install the package")).toEqual([1, 1]);
    expect(items("- Steps to follow\n  - Install the package")).toEqual([1, 1]);
  });

  test("a marker indented less than the item's content leaves it, whatever its number", () => {
    expect(items("- Setup steps\n  - Install it\n2.")).toEqual([1, 1, 1]);
    expect(items("1. Refunds take 30 days.\n   - Approval is manual.\n2.")).toEqual([1, 1, 1]);
  });

  test("a fence after such a line stays in the item, and ends with it", () => {
    // Read as an empty item, "14." put the lazy line under it at the top
    // level, and the fence after that at column 0, where nothing closed it.
    const text =
      "- Refunds need a manager.\n   14.\nMost are approved.\n  ```\n- Refunds take 30 days.";
    expect(blocks(text)).toEqual(["  ```"]);
    expect(items(text)).toEqual([1, 0, 0, 0, 1]);
  });
});

describe("readBlocks — linear in the document", () => {
  // Counted, not timed (`blockMeter`): what the lookups read for a document
  // and for one four times its size. Read once, that is at most five times
  // as much — the open items are found by a binary search, two probes more
  // per line at four times the depth — and read again per bullet or per
  // line, sixteen times. No clock, so no machine is too slow for it.
  const reads = (text: string): number => {
    const before = blockMeter.reads;
    readBlocks(text);
    return blockMeter.reads - before;
  };
  const n = 5_000;

  test("bullets nested deep on one line", () => {
    // Asking for a thematic break at every bullet rescanned to the line's
    // end: 14 s for 80 KB of them.
    const nested = (k: number): string => `${"- ".repeat(k)}x`;
    expect(readBlocks(nested(n)).item[0]).toBe(1);
    expect(reads(nested(n))).toBeGreaterThan(0);
    expect(reads(nested(4 * n))).toBeLessThanOrEqual(5 * reads(nested(n)));
  });

  test("bullets nested deep, then many lazy lines under them", () => {
    // Finding the item a lazy line is indented into scanned the open items
    // from the innermost: 1.3 s for 50,000 lines under 50,000 bullets.
    const nested = (k: number): string => `${"- ".repeat(k)}x\n${"y\n".repeat(k)}`;
    expect(readBlocks(nested(n)).contained[n]).toBe(1);
    expect(reads(nested(n))).toBeGreaterThan(n);
    expect(reads(nested(4 * n))).toBeLessThanOrEqual(5 * reads(nested(n)));
  });
});
