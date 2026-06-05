/**
 * Tests for the unified-diff renderer used by the Edit tool's result.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderEditDiff } from "./diff";

// Snapshot + restore the two env knobs `envInt` reads so these tests never
// leak process.env state into sibling tests.
const ENV_CONTEXT = "CREWHAUS_EDIT_DIFF_CONTEXT";
const ENV_MAX = "CREWHAUS_EDIT_DIFF_MAX";
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of [ENV_CONTEXT, ENV_MAX]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
});
function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

describe("renderEditDiff", () => {
  test("renders a basic single-line change with context", () => {
    const original = "line one\nline two\nline three\nline four\nline five\n";
    const diff = renderEditDiff({
      path: "a.txt",
      original,
      oldString: "line three",
      newString: "LINE THREE",
    });
    expect(diff).toContain("--- a/a.txt");
    expect(diff).toContain("+++ b/a.txt");
    expect(diff).toContain("-line three");
    expect(diff).toContain("+LINE THREE");
    // Context lines should appear unprefixed (with leading space).
    expect(diff).toContain(" line two");
    expect(diff).toContain(" line four");
  });

  test("multi-line oldString → multi-line newString", () => {
    const original = "a\nb\nc\nd\ne\n";
    const diff = renderEditDiff({
      path: "x.md",
      original,
      oldString: "b\nc",
      newString: "B\nC\nC2",
    });
    expect(diff).toContain("-b");
    expect(diff).toContain("-c");
    expect(diff).toContain("+B");
    expect(diff).toContain("+C");
    expect(diff).toContain("+C2");
  });

  test("change at the start of file (no leading context)", () => {
    const original = "first line\nsecond line\nthird line\n";
    const diff = renderEditDiff({
      path: "f.txt",
      original,
      oldString: "first line",
      newString: "FIRST LINE",
    });
    expect(diff).toContain("-first line");
    expect(diff).toContain("+FIRST LINE");
    expect(diff).toContain(" second line");
  });

  test("change at the end of file (no trailing context)", () => {
    const original = "first\nsecond\nLAST";
    const diff = renderEditDiff({
      path: "f.txt",
      original,
      oldString: "LAST",
      newString: "FINAL",
    });
    expect(diff).toContain("-LAST");
    expect(diff).toContain("+FINAL");
    expect(diff).toContain(" first");
    expect(diff).toContain(" second");
  });

  test("returns empty string when oldString not in original (defensive)", () => {
    const diff = renderEditDiff({
      path: "x.txt",
      original: "abc\ndef\n",
      oldString: "not present",
      newString: "y",
    });
    expect(diff).toBe("");
  });

  test("truncates very long diffs with a notice", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const diff = renderEditDiff({
      path: "huge.txt",
      original: big,
      oldString: "line 0\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8",
      newString: Array.from({ length: 100 }, (_, i) => `replaced ${i}`).join("\n"),
    });
    expect(diff).toContain("@@ truncated:");
    expect(diff.split("\n").length).toBeLessThanOrEqual(82);
  });

  test("contextLines override controls the surrounding window", () => {
    const original = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const diff = renderEditDiff(
      { path: "x.txt", original, oldString: "d", newString: "D" },
      { contextLines: 1 },
    );
    // With ctx=1, we should see only ONE line before and one after.
    const stripped = diff.split("\n").filter((l) => l.startsWith(" "));
    expect(stripped.length).toBe(2);
  });

  test("emits a @@ hunk header in unified-diff format", () => {
    const diff = renderEditDiff({
      path: "x.txt",
      original: "a\nb\nc\n",
      oldString: "b",
      newString: "B",
    });
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  test("honors CREWHAUS_EDIT_DIFF_CONTEXT when no contextLines opt is passed", () => {
    // A valid positive integer env value drives the parse branch in envInt.
    setEnv(ENV_CONTEXT, "1");
    const original = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const diff = renderEditDiff({ path: "x.txt", original, oldString: "d", newString: "D" });
    // ctx=1 → exactly one context line above and below the change.
    const stripped = diff.split("\n").filter((l) => l.startsWith(" "));
    expect(stripped.length).toBe(2);
  });

  test("honors CREWHAUS_EDIT_DIFF_MAX when no maxLines opt is passed", () => {
    setEnv(ENV_MAX, "5");
    const big = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const diff = renderEditDiff({
      path: "huge.txt",
      original: big,
      oldString: "line 0\nline 1\nline 2\nline 3\nline 4",
      newString: Array.from({ length: 30 }, (_, i) => `r ${i}`).join("\n"),
    });
    expect(diff).toContain("@@ truncated:");
    // 5 kept lines + the truncation notice line.
    expect(diff.split("\n").length).toBe(6);
  });

  test("falls back to defaults when env values are non-numeric or non-positive", () => {
    // Non-numeric → Number.parseInt yields NaN → Number.isFinite false → default.
    setEnv(ENV_CONTEXT, "not-a-number");
    // Non-positive → n > 0 false → default.
    setEnv(ENV_MAX, "0");
    const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n");
    const diff = renderEditDiff({ path: "x.txt", original, oldString: "e", newString: "E" });
    // Default context is 3 → three lines before + three after.
    const stripped = diff.split("\n").filter((l) => l.startsWith(" "));
    expect(stripped.length).toBe(6);
    // Default max is 80 → this small diff is not truncated.
    expect(diff).not.toContain("@@ truncated:");
  });
});
