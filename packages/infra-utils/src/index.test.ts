import { describe, expect, it } from "bun:test";
import { ArgParseError, assertNever, escapeJsonString, parseArgs } from "./index";

describe("escapeJsonString", () => {
  it("wraps plain strings in double quotes", () => {
    expect(escapeJsonString("hello")).toBe('"hello"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(escapeJsonString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
  });

  it("escapes newlines and tabs", () => {
    expect(escapeJsonString("line1\nline2\t.")).toBe('"line1\\nline2\\t."');
  });

  it("encodes control characters", () => {
    expect(escapeJsonString("ab")).toBe('"a\\u0001b"');
  });

  it("preserves unicode", () => {
    expect(escapeJsonString("héllo 世界 🌍")).toBe('"héllo 世界 🌍"');
  });

  it("produces output that round-trips through JSON.parse", () => {
    const input = 'tricky: "quote", \nnewline, \\backslash,  ctrl';
    expect(JSON.parse(escapeJsonString(input))).toBe(input);
  });
});

describe("assertNever", () => {
  it("throws with a message including the unexpected value", () => {
    expect(() => assertNever("oops" as never)).toThrow('unreachable: "oops"');
  });

  it("typechecks when every union case is handled (compile-time check)", () => {
    type T = "a" | "b";
    function describe_(t: T): string {
      switch (t) {
        case "a":
          return "alpha";
        case "b":
          return "beta";
        default:
          return assertNever(t);
      }
    }
    expect(describe_("a")).toBe("alpha");
    expect(describe_("b")).toBe("beta");
  });
});

describe("parseArgs", () => {
  const schema = {
    flags: [
      { name: "out", short: "o", takesValue: true },
      { name: "help", short: "h" },
      { name: "verbose" },
    ],
  } as const;

  it("collects positionals", () => {
    const result = parseArgs(["compile", "spec.yaml"], schema);
    expect(result.positional).toEqual(["compile", "spec.yaml"]);
    expect(result.flags).toEqual({});
  });

  it("parses long-form value flags", () => {
    const result = parseArgs(["--out", "build"], schema);
    expect(result.flags).toEqual({ out: "build" });
    expect(result.positional).toEqual([]);
  });

  it("parses short-form value flags", () => {
    const result = parseArgs(["-o", "build"], schema);
    expect(result.flags).toEqual({ out: "build" });
  });

  it("parses boolean flags as true", () => {
    const result = parseArgs(["-h", "--verbose"], schema);
    expect(result.flags).toEqual({ help: true, verbose: true });
  });

  it("mixes positionals and flags", () => {
    const result = parseArgs(["compile", "-o", "out", "spec.yaml"], schema);
    expect(result.positional).toEqual(["compile", "spec.yaml"]);
    expect(result.flags).toEqual({ out: "out" });
  });

  it("throws ArgParseError when a value flag is missing its value", () => {
    expect(() => parseArgs(["-o"], schema)).toThrow(ArgParseError);
  });

  it("throws ArgParseError on unknown flag", () => {
    expect(() => parseArgs(["--bogus"], schema)).toThrow(/unknown flag: --bogus/);
  });

  it("treats single dash as a positional", () => {
    const result = parseArgs(["-"], schema);
    expect(result.positional).toEqual(["-"]);
  });

  it("uses -- as end-of-flags sentinel", () => {
    const result = parseArgs(["compile", "--", "--not-a-flag", "-x"], schema);
    expect(result.positional).toEqual(["compile", "--not-a-flag", "-x"]);
    expect(result.flags).toEqual({});
  });
});
