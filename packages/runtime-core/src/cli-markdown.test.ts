/**
 * Unit tests for the CLI markdown → ANSI streaming renderer.
 * Covers: streaming buffer + flush, headings, lists, code fences,
 * inline bold/italic/code, blockquotes, and graceful handling of
 * tokens split across chunks.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createCliMarkdownRenderer, isCliMarkdownEnabled } from "./cli-markdown";

function capture(): { write: (s: string) => void; out: () => string } {
  let buf = "";
  return {
    write: (s: string) => {
      buf += s;
    },
    out: () => buf,
  };
}

// Strip ANSI escape sequences so we can assert on plain content
// while still letting other tests verify the escape codes are present.
function strip(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection is intentional — the renderer's output IS the control sequences we want to strip.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("createCliMarkdownRenderer", () => {
  test("plain text passes through line by line", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("hello\nworld\n");
    expect(c.out()).toBe("hello\nworld\n");
  });

  test("incomplete line is buffered, flushed by end()", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("partial");
    expect(c.out()).toBe("");
    r.end();
    expect(c.out()).toBe("partial");
  });

  test("bold renders with ANSI bold", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("hello **world** done\n");
    expect(c.out()).toContain("\x1b[1m");
    expect(strip(c.out())).toBe("hello world done\n");
  });

  test("italic with single asterisks", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("the *quick* fox\n");
    expect(c.out()).toContain("\x1b[3m");
    expect(strip(c.out())).toBe("the quick fox\n");
  });

  test("inline code preserves backticks", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("use `npm install` here\n");
    expect(strip(c.out())).toBe("use `npm install` here\n");
  });

  test("headings get bold + level color", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("# H1\n## H2\n### H3\n");
    expect(c.out().split("\n").length).toBe(4);
    // Each header line starts with a bold marker.
    const lines = c.out().split("\n");
    expect(lines[0]).toContain("\x1b[1m");
    expect(lines[1]).toContain("\x1b[1m");
    expect(lines[2]).toContain("\x1b[1m");
    expect(strip(c.out())).toBe("H1\nH2\nH3\n");
  });

  test("unordered list bullets render with • marker", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("- one\n- two\n* three\n");
    const stripped = strip(c.out());
    expect(stripped).toContain("• one");
    expect(stripped).toContain("• two");
    expect(stripped).toContain("• three");
  });

  test("ordered list numbers survive with color", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("1. first\n2. second\n");
    const stripped = strip(c.out());
    expect(stripped).toContain("1. first");
    expect(stripped).toContain("2. second");
  });

  test("code fence toggles dim block, multi-line", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("```python\nprint('hi')\nx = 1\n```\nback to text\n");
    const stripped = strip(c.out());
    expect(stripped).toContain("```python");
    expect(stripped).toContain("print('hi')");
    expect(stripped).toContain("x = 1");
    expect(stripped).toContain("```");
    expect(stripped).toContain("back to text");
    // Dim marker should appear in the code-block lines.
    expect(c.out()).toContain("\x1b[2m");
  });

  test("chunk-boundary safety: bold marker split across pushes", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("hello *");
    r.push("*world*");
    r.push("* done\n");
    expect(strip(c.out())).toBe("hello world done\n");
    expect(c.out()).toContain("\x1b[1m");
  });

  test("blockquote renders with vertical-bar prefix and italic", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("> a quote here\n");
    expect(strip(c.out())).toContain("│ a quote here");
    expect(c.out()).toContain("\x1b[3m");
  });

  test("horizontal rule renders as a divider", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("---\n");
    expect(strip(c.out())).toMatch(/^─{40}/);
  });

  test("underscore bold (__x__) and underscore italic (_x_) render", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    // __bold__ exercises the __...__ replace callback; a closed _italic_ pair
    // (word-boundary guarded) exercises the _..._ replace callback. Both are
    // distinct from the asterisk variants the other tests cover.
    r.push("make __this__ and _that_ pop\n");
    expect(strip(c.out())).toBe("make this and that pop\n");
    expect(c.out()).toContain("\x1b[1m"); // bold from __this__
    expect(c.out()).toContain("\x1b[3m"); // italic from _that_
  });

  test("does not false-match snake_case identifiers as italic", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("call foo_bar_baz now\n");
    expect(strip(c.out())).toBe("call foo_bar_baz now\n");
    // No italic markers because _foo_bar_baz_ isn't a closed pair.
    expect(c.out()).not.toContain("\x1b[3m");
  });

  test("nested code-fence inside list-item not double-rendered", () => {
    const c = capture();
    const r = createCliMarkdownRenderer({ write: c.write });
    r.push("- item one\n  ```\n  code\n  ```\n- item two\n");
    const stripped = strip(c.out());
    expect(stripped).toContain("• item one");
    expect(stripped).toContain("code");
    expect(stripped).toContain("• item two");
  });

  test("defaults to process.stdout.write when no write override is supplied", () => {
    // Exercises the default sink arrow `(s) => process.stdout.write(s)` that
    // every other test bypasses by passing an explicit `write`. We spy on
    // stdout so nothing actually prints to the test console.
    const written: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const r = createCliMarkdownRenderer(); // no opts → default write
      r.push("plain line\n"); // flushes a completed line via the default sink
      r.push("tail-no-newline");
      r.end(); // flushes the buffered tail via the default sink
    } finally {
      spy.mockRestore();
    }
    const joined = strip(written.join(""));
    expect(joined).toContain("plain line");
    expect(joined).toContain("tail-no-newline");
  });
});

describe("isCliMarkdownEnabled", () => {
  test("returns false when env var is unset", () => {
    expect(isCliMarkdownEnabled({})).toBe(false);
  });

  test("returns true for '1' and 'true' (case sensitive)", () => {
    expect(isCliMarkdownEnabled({ CREWHAUS_CLI_MARKDOWN: "1" })).toBe(true);
    expect(isCliMarkdownEnabled({ CREWHAUS_CLI_MARKDOWN: "true" })).toBe(true);
  });

  test("returns false for falsy strings", () => {
    expect(isCliMarkdownEnabled({ CREWHAUS_CLI_MARKDOWN: "0" })).toBe(false);
    expect(isCliMarkdownEnabled({ CREWHAUS_CLI_MARKDOWN: "false" })).toBe(false);
    expect(isCliMarkdownEnabled({ CREWHAUS_CLI_MARKDOWN: "" })).toBe(false);
  });
});
