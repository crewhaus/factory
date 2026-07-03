import { describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import {
  GLOB_METACHARS,
  OPERATIVE_ARG_FIELDS,
  PatternParseError,
  compilePattern,
  escapeGlobLiteral,
  matchesPattern,
} from "./index";

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

  // Regression — issue #145 (CWE-863). A decoy field must not satisfy an allow
  // rule meant for the tool's operative argument.
  test("a decoy field cannot authorize a malicious Bash command (#145)", () => {
    const p = compilePattern("Bash(git *)");
    // `command` is operative; `description` is a decoy that matches the glob.
    expect(matchesPattern(p, "Bash", { command: "rm -rf /", description: "git push" })).toBe(false);
  });

  test("Write content cannot satisfy a path glob (#145)", () => {
    const p = compilePattern("Write(**/src/**)");
    // `file_path` is operative; `content` is a decoy mentioning src/.
    expect(
      matchesPattern(p, "Write", { file_path: "/etc/passwd", content: "edit src/app.ts" }),
    ).toBe(false);
  });

  test("a legit operative field still authorizes despite non-matching extras (#145)", () => {
    const p = compilePattern("Write(**/src/**)");
    expect(matchesPattern(p, "Write", { file_path: "src/app.ts", content: "anything here" })).toBe(
      true,
    );
  });

  test("unknown tool requires every string to match (conservative fallback)", () => {
    const p = compilePattern("CustomTool(safe*)");
    expect(matchesPattern(p, "CustomTool", { op: "danger", note: "safe" })).toBe(false);
    expect(matchesPattern(p, "CustomTool", { op: "safe-op", note: "safe-note" })).toBe(true);
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

describe("escapeGlobLiteral (glob-metachar neutralisation)", () => {
  test("escapes `*` so it matches only the literal asterisk", () => {
    const p = compilePattern(`Bash(npm run test:${escapeGlobLiteral("*")})`);
    // globToRegex must treat the escaped `*` as a literal, not a wildcard.
    expect(matchesPattern(p, "Bash", { command: "npm run test:*" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "npm run test:DELETE" })).toBe(false);
  });

  test("escapes `?` so it matches only the literal question mark", () => {
    const p = compilePattern(`Read(${escapeGlobLiteral("/a?b")})`);
    expect(matchesPattern(p, "Read", { file_path: "/a?b" })).toBe(true);
    expect(matchesPattern(p, "Read", { file_path: "/aXb" })).toBe(false);
  });

  test("escapes a backslash so it round-trips as a literal", () => {
    const raw = "a\\b*c";
    const p = compilePattern(`Bash(${escapeGlobLiteral(raw)})`);
    expect(matchesPattern(p, "Bash", { command: raw })).toBe(true);
    // The `*` must not widen.
    expect(matchesPattern(p, "Bash", { command: "a\\bZZZc" })).toBe(false);
  });

  test("leaves plain values untouched", () => {
    expect(escapeGlobLiteral("git status")).toBe("git status");
  });

  test("GLOB_METACHARS lists exactly the widening chars the grammar treats specially", () => {
    expect([...GLOB_METACHARS].sort()).toEqual(["*", "?", "\\"].sort());
  });
});

describe("globToRegex — backslash escape (additive, back-compat)", () => {
  test("a bare `\\` with no following char is a literal backslash (no crash)", () => {
    // Trailing backslash: no escape target → matched literally.
    const p = compilePattern("Bash(a\\)");
    expect(matchesPattern(p, "Bash", { command: "a\\" })).toBe(true);
  });

  test("unescaped `*` still widens (grammar unchanged for existing patterns)", () => {
    const p = compilePattern("Bash(git *)");
    expect(matchesPattern(p, "Bash", { command: "git status" })).toBe(true);
  });
});

describe("OPERATIVE_ARG_FIELDS (exported single source of truth)", () => {
  test("covers the arg-constrained built-in tools", () => {
    for (const t of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Fetch", "WebFetch"]) {
      expect(OPERATIVE_ARG_FIELDS[t]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
