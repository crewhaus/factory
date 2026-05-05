import { describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import { PatternParseError, compilePattern, matchesPattern } from "./index";

describe("compilePattern — no-arg patterns", () => {
  test("exact name matches itself", () => {
    const p = compilePattern("Read");
    expect(matchesPattern(p, "Read", {})).toBe(true);
  });

  test("exact name does not match a different tool", () => {
    const p = compilePattern("Read");
    expect(matchesPattern(p, "Write", {})).toBe(false);
  });

  test("wildcard '*' matches any tool name without a slash", () => {
    const p = compilePattern("*");
    expect(matchesPattern(p, "Bash", {})).toBe(true);
    expect(matchesPattern(p, "Read", {})).toBe(true);
    expect(matchesPattern(p, "Write", {})).toBe(true);
  });

  test("glob prefix 'tool-*' matches tool-foo but not foo", () => {
    const p = compilePattern("tool-*");
    expect(matchesPattern(p, "tool-foo", {})).toBe(true);
    expect(matchesPattern(p, "foo", {})).toBe(false);
  });
});

describe("compilePattern — arg patterns", () => {
  test("Bash(git *) matches git commands", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Bash", { command: "git status" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "git commit -m msg" })).toBe(true);
  });

  test("Bash(git *) does not match non-git commands", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Bash", { command: "ls -la" })).toBe(false);
  });

  test("Bash(git *) does not match Write tool", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Write", { command: "git status" })).toBe(false);
  });

  test("Write(**/src/**) matches paths under src/", () => {
    const p = compilePattern("Write(**/src/**)");
    expect(matchesPattern(p, "Write", { file_path: "/foo/src/bar.ts" })).toBe(true);
    expect(matchesPattern(p, "Write", { file_path: "src/index.ts" })).toBe(true);
  });

  test("Write(**/src/**) does not match paths outside src/", () => {
    const p = compilePattern("Write(**/src/**)");
    expect(matchesPattern(p, "Write", { file_path: "/etc/hosts" })).toBe(false);
    expect(matchesPattern(p, "Write", { file_path: "/usr/lib/foo.ts" })).toBe(false);
  });

  test("arg pattern matches against any string value in a nested object", () => {
    const p = compilePattern("Read(*.ts)");
    expect(matchesPattern(p, "Read", { path: "index.ts" })).toBe(true);
    expect(matchesPattern(p, "Read", { path: "index.js" })).toBe(false);
  });

  test("no-match when tool name doesn't match even if arg does", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Read", { command: "git status" })).toBe(false);
  });
});

describe("compilePattern — error cases", () => {
  test("empty string throws PatternParseError", () => {
    expect(() => compilePattern("")).toThrow(PatternParseError);
  });

  test("whitespace-only string throws PatternParseError", () => {
    expect(() => compilePattern("   ")).toThrow(PatternParseError);
  });

  test("unmatched open paren throws PatternParseError", () => {
    expect(() => compilePattern("Bash(git *")).toThrow(PatternParseError);
    expect(() => compilePattern("Bash(git *")).toThrow(/unmatched parenthesis/);
  });

  test("empty tool name in paren form throws PatternParseError", () => {
    expect(() => compilePattern("(git *)")).toThrow(PatternParseError);
    expect(() => compilePattern("(git *)")).toThrow(/tool name portion/);
  });

  test("PatternParseError is instanceof CrewhausError", () => {
    try {
      compilePattern("");
    } catch (e) {
      expect(e).toBeInstanceOf(CrewhausError);
    }
  });

  test("PatternParseError has code 'tool'", () => {
    expect(new PatternParseError("x").code).toBe("tool");
  });
});
