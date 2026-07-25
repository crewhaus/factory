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

// ---------------------------------------------------------------------------
// Table-driven coverage of EVERY glob shape the grammar admits.
//
// Regression home for issue #17: a bare `**` arg-glob compiled to
// `^(?:/.*)?$` — it matched only the empty string or a string starting with
// `/`, so the catch-all `alwaysAsk Bash(**)` that two starters ship was dead.
// The `/**`-at-end branch stripped the last character of the accumulated regex
// assuming a leading `/` had been emitted; for a bare `**` (and for a `**`
// following another `**` group) there was nothing to strip.
// ---------------------------------------------------------------------------

type GlobRow = {
  /** The glob under test (used as both a tool-glob and an arg-glob). */
  readonly glob: string;
  /** Values the glob MUST match. */
  readonly matches: readonly string[];
  /** Values the glob MUST NOT match. */
  readonly rejects: readonly string[];
  /** Optional note explaining a non-obvious expectation. */
  readonly note?: string;
};

/** Match `value` against `glob` through the arg-glob path (`Read(<glob>)`). */
function argMatches(glob: string, value: string): boolean {
  return matchesPattern(compilePattern(`Read(${glob})`), "Read", { file_path: value });
}

const GLOB_TABLE: readonly GlobRow[] = [
  // -- literals ------------------------------------------------------------
  { glob: "foo/bar.ts", matches: ["foo/bar.ts"], rejects: ["foo/bar_ts", "foo/bar.tsx", ""] },

  // -- single `*` (one segment, never crosses `/`) --------------------------
  { glob: "*", matches: ["", "abc", "a b", "a\nb"], rejects: ["a/b", "/a"] },
  { glob: "*.ts", matches: ["index.ts", ".ts"], rejects: ["src/index.ts", "index.tsx"] },
  { glob: "a/*", matches: ["a/b", "a/"], rejects: ["a", "a/b/c"] },
  { glob: "git *", matches: ["git status", "git commit -m msg"], rejects: ["ls -la", "git"] },
  {
    glob: "git *",
    matches: ["git log --oneline"],
    rejects: ["git add src/x.ts"],
    note: "`*` deliberately stops at `/` — even for Bash commands. Use `**` to cross one.",
  },

  // -- `?` (exactly one non-separator char) --------------------------------
  { glob: "?", matches: ["a", "1", " "], rejects: ["", "ab", "/"] },
  { glob: "a?c", matches: ["abc", "a c"], rejects: ["ac", "abbc", "a/c"] },

  // -- bare `**` — issue #17 -----------------------------------------------
  {
    glob: "**",
    matches: ["", "echo hi", "/bin/ls", "a/b/c", "rm -rf /\necho done"],
    rejects: [],
    note: "issue #17 — a catch-all must match everything, not just '' and /…",
  },

  // -- `**` at a segment boundary ------------------------------------------
  { glob: "**/*.ts", matches: ["index.ts", "src/index.ts", "a/b/c.ts"], rejects: ["index.js"] },
  { glob: "**/foo", matches: ["foo", "a/foo", "a/b/foo"], rejects: ["foobar", "foo/bar"] },
  { glob: "src/**", matches: ["src", "src/a", "src/a/b"], rejects: ["srcx", "other/src/a"] },
  { glob: "/tmp/**", matches: ["/tmp", "/tmp/x", "/tmp/x/y"], rejects: ["/tmpfile", "tmp/x"] },
  { glob: "src/**/*.ts", matches: ["src/a.ts", "src/a/b.ts"], rejects: ["src.ts", "other/a.ts"] },
  { glob: "/a/**/b", matches: ["/a/b", "/a/x/b", "/a/x/y/b"], rejects: ["/ab", "/a/b/c"] },
  {
    glob: "**/src/**",
    matches: ["src", "src/index.ts", "/foo/src/bar.ts"],
    rejects: ["/etc/hosts"],
  },
  {
    glob: "/**",
    matches: ["", "/", "/a/b"],
    rejects: ["a", "a/b"],
    note: "`x/**` also matches `x`; with x empty that admits the empty string.",
  },

  // -- `**` glued to non-separators (plain 'any run') ----------------------
  { glob: "a**b", matches: ["ab", "axb", "a/x/b"], rejects: ["axc", "xab"] },
  { glob: "rm**", matches: ["rm", "rm -rf /", "rm -rf /\necho done"], rejects: ["grm", "ls"] },
  { glob: "**foo", matches: ["foo", "xfoo", "a/b/foo"], rejects: ["foobar"] },
  { glob: "foo**", matches: ["foo", "foobar", "foo/bar"], rejects: ["afoo"] },

  // -- adjacent `**` groups (the second slice-guess victim) -----------------
  { glob: "**/**", matches: ["", "a", "a/b", "a/b/c"], rejects: [] },
  { glob: "**/**/x", matches: ["x", "a/x", "a/b/x"], rejects: ["y", "x/y"] },
  { glob: "a/**/**/b", matches: ["a/b", "a/x/b", "a/x/y/b"], rejects: ["ab", "a/b/c"] },

  // -- backslash escapes ----------------------------------------------------
  { glob: String.raw`a\*b`, matches: ["a*b"], rejects: ["aXb", "ab"] },
  { glob: String.raw`a\?b`, matches: ["a?b"], rejects: ["aXb"] },
  { glob: String.raw`a\\b`, matches: ["a\\b"], rejects: ["ab"] },
  { glob: "a\\", matches: ["a\\"], rejects: ["a"], note: "a trailing backslash is a literal" },
  {
    glob: String.raw`\/**`,
    matches: ["", "/", "/a/b"],
    rejects: ["a"],
    note: "an escaped separator still folds into a following `**`",
  },

  // -- regex metacharacters are literals ------------------------------------
  { glob: "a.b", matches: ["a.b"], rejects: ["axb"] },
  { glob: "a+b", matches: ["a+b"], rejects: ["aab"] },
  { glob: "(a)", matches: ["(a)"], rejects: ["a"] },
  { glob: "[a]", matches: ["[a]"], rejects: ["a"] },
  { glob: "a|b", matches: ["a|b"], rejects: ["a", "b"] },
  { glob: "a$b", matches: ["a$b"], rejects: ["ab"] },
  { glob: "^a", matches: ["^a"], rejects: ["a"] },
  { glob: "a{2}", matches: ["a{2}"], rejects: ["aa"] },
];

describe("globToRegex — glob shape table (arg-glob)", () => {
  for (const row of GLOB_TABLE) {
    const suffix = row.note ? ` — ${row.note}` : "";
    for (const value of row.matches) {
      test(`${JSON.stringify(row.glob)} matches ${JSON.stringify(value)}${suffix}`, () => {
        expect(argMatches(row.glob, value)).toBe(true);
      });
    }
    for (const value of row.rejects) {
      test(`${JSON.stringify(row.glob)} rejects ${JSON.stringify(value)}${suffix}`, () => {
        expect(argMatches(row.glob, value)).toBe(false);
      });
    }
  }
});

describe("globToRegex — glob shape table (tool-glob)", () => {
  // The same compiler drives the tool-name half of a pattern, so every row
  // must behave identically there (no-arg form → the arg check is skipped).
  // `(` is reserved by the pattern grammar as the arg-glob opener, so rows
  // containing a paren cannot be expressed as a bare tool glob.
  for (const row of GLOB_TABLE.filter((r) => !r.glob.includes("(") && !r.glob.includes(")"))) {
    test(`${JSON.stringify(row.glob)} behaves the same as a tool glob`, () => {
      const p = compilePattern(row.glob);
      for (const value of row.matches) expect(p._toolRe.test(value)).toBe(true);
      for (const value of row.rejects) expect(p._toolRe.test(value)).toBe(false);
    });
  }
});

describe("globToRegex — `**` invariants", () => {
  test("issue #17 — a catch-all Bash(**) matches a real command", () => {
    const p = compilePattern("Bash(**)");
    expect(matchesPattern(p, "Bash", { command: "echo hi" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "git push --force" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "/bin/ls" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "" })).toBe(true);
  });

  test("issue #17 — a catch-all tool glob `**` matches every tool name", () => {
    const p = compilePattern("**");
    for (const name of ["Bash", "Read", "mcp__srv__tool", "a/b"]) {
      expect(matchesPattern(p, name, {})).toBe(true);
    }
  });

  test("`**` is a strict superset of `*` for every table value", () => {
    // `**` widens `*`; it must never match LESS. (Before the dotAll fix `*`
    // matched a newline via [^/]* and `**` did not, via `.*`.)
    const values = new Set(GLOB_TABLE.flatMap((r) => [...r.matches, ...r.rejects]));
    for (const value of values) {
      if (argMatches("*", value)) expect(argMatches("**", value)).toBe(true);
      if (argMatches("a/*", value)) expect(argMatches("a/**", value)).toBe(true);
    }
  });

  test("a `**` guard fires on a multi-line command", () => {
    // The builtin safety floor is `Bash(rm**)`; a newline must not slip past it.
    const p = compilePattern("Bash(rm**)");
    expect(matchesPattern(p, "Bash", { command: "rm -rf /\necho done" })).toBe(true);
    expect(matchesPattern(p, "Bash", { command: "rm\n-rf\n/" })).toBe(true);
  });
});

describe("OPERATIVE_ARG_FIELDS (exported single source of truth)", () => {
  test("covers the arg-constrained built-in tools", () => {
    for (const t of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Fetch", "WebFetch"]) {
      expect(OPERATIVE_ARG_FIELDS[t]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
