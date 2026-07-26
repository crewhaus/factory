import { describe, expect, it } from "bun:test";
import { ArgParseError, ArgSchemaError, assertNever, escapeJsonString, parseArgs } from "./index";

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

describe("ArgParseError", () => {
  it("is an Error subclass that preserves its message and stable name", () => {
    const err = new ArgParseError("bad flag");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArgParseError);
    expect(err.message).toBe("bad flag");
    expect(err.name).toBe("ArgParseError");
  });
});

describe("ArgSchemaError", () => {
  it("is an Error subclass that preserves its message and stable name", () => {
    const err = new ArgSchemaError("bad schema");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ArgSchemaError);
    expect(err.message).toBe("bad schema");
    expect(err.name).toBe("ArgSchemaError");
  });

  it("is NOT an ArgParseError, so apps/cli's parseFor rethrows instead of die()-ing", () => {
    // apps/cli/src/index.ts parseFor: `if (err instanceof ArgParseError) die(err.message)`.
    // Making this an ArgParseError subclass would report a schema bug to the
    // user as a mistyped flag.
    expect(new ArgSchemaError("bad schema")).not.toBeInstanceOf(ArgParseError);
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

  const dupLong = { flags: [{ name: "out", takesValue: true }, { name: "out" }] } as const;

  it("throws ArgSchemaError on a duplicate long name", () => {
    expect(() => parseArgs([], dupLong)).toThrow(ArgSchemaError);
    expect(() => parseArgs([], dupLong)).toThrow(/--out/);
  });

  it("names both flags when two long names claim the same short alias", () => {
    const s = {
      flags: [
        { name: "out", short: "o" },
        { name: "output", short: "o" },
      ],
    } as const;
    // The token alone can't identify either offender, so the message must
    // carry both names — this is what forces .get() over .has().
    expect(() => parseArgs([], s)).toThrow(/-o/);
    expect(() => parseArgs([], s)).toThrow(/out/);
    expect(() => parseArgs([], s)).toThrow(/output/);
  });

  it("throws when duplicate entries disagree on takesValue", () => {
    const s = { flags: [{ name: "json", takesValue: true }, { name: "json" }] } as const;
    expect(() => parseArgs(["--json", "x"], s)).toThrow(ArgSchemaError);
  });

  it("throws even when the duplicate entries are structurally identical", () => {
    const s = {
      flags: [
        { name: "help", short: "h" },
        { name: "help", short: "h" },
      ],
    } as const;
    expect(() => parseArgs([], s)).toThrow(ArgSchemaError);
  });

  it("throws when a short alias with a leading dash collides with a long name", () => {
    const s = { flags: [{ name: "x" }, { name: "other", short: "-x" }] } as const;
    expect(() => parseArgs([], s)).toThrow(/--x/);
  });

  it("rejects a malformed schema even when argv is empty", () => {
    expect(() => parseArgs([], dupLong)).toThrow(ArgSchemaError);
  });

  it("rejects a malformed schema even when the duplicated flag is never passed", () => {
    expect(() => parseArgs(["build"], dupLong)).toThrow(ArgSchemaError);
  });

  it("reports the schema bug before any user-input error", () => {
    let caught: unknown;
    try {
      parseArgs(["--bogus"], dupLong);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ArgSchemaError);
    expect(caught).not.toBeInstanceOf(ArgParseError);
  });

  it("throws on every call, not just the first", () => {
    expect(() => parseArgs([], dupLong)).toThrow(ArgSchemaError);
    expect(() => parseArgs([], dupLong)).toThrow(ArgSchemaError);
  });

  it("throws on an empty flag name", () => {
    expect(() => parseArgs([], { flags: [{ name: "" }] })).toThrow(/empty name/);
  });

  it("throws on an empty short alias", () => {
    expect(() => parseArgs([], { flags: [{ name: "out", short: "" }] })).toThrow(
      /empty short alias/,
    );
  });

  it("accepts a long name and an unrelated short alias sharing a letter", () => {
    // `--o` and `-o` are distinct tokens; keying on bare names would reject this.
    const s = { flags: [{ name: "o" }, { name: "other", short: "o" }] } as const;
    expect(() => parseArgs(["-o"], s)).not.toThrow();
  });

  it("accepts an empty flag list", () => {
    expect(() => parseArgs(["build"], { flags: [] })).not.toThrow();
  });

  it("does not share token state across schemas", () => {
    // Every real CLI schema declares -h; a cross-call registry would break them all.
    const a = { flags: [{ name: "help", short: "h" }] } as const;
    const b = { flags: [{ name: "help", short: "h" }] } as const;
    expect(() => parseArgs(["-h"], a)).not.toThrow();
    expect(() => parseArgs(["-h"], b)).not.toThrow();
  });
});
