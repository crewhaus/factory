import { describe, expect, test } from "bun:test";
import { CompilerError, ConfigError, CrewhausError, RuntimeError, SpecParseError } from "./index";

describe("CrewhausError", () => {
  test("extends Error and exposes a code", () => {
    const err = new CrewhausError("config", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("config");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("CrewhausError");
  });

  test("toJSON serializes message and code", () => {
    const err = new CrewhausError("runtime", "oops");
    expect(err.toJSON()).toEqual({
      name: "CrewhausError",
      code: "runtime",
      message: "oops",
      cause: undefined,
    });
  });

  test("preserves cause via Error.cause", () => {
    const root = new Error("root");
    const err = new CompilerError("could not lower", root);
    expect(err.cause).toBe(root);
  });

  test("toJSON serializes a plain Error cause", () => {
    const root = new Error("root");
    const err = new CompilerError("compile failed", root);
    expect(err.toJSON().cause).toEqual({ name: "Error", message: "root" });
  });

  test("toJSON recursively serializes a CrewhausError cause", () => {
    const inner = new SpecParseError("bad yaml");
    const outer = new CompilerError("compile failed", inner);
    expect(outer.toJSON().cause).toEqual({
      name: "SpecParseError",
      code: "spec_parse",
      message: "bad yaml",
      cause: undefined,
    });
  });

  test("toJSON stringifies non-Error causes", () => {
    const err = new RuntimeError("x", "string-cause");
    expect(err.toJSON().cause).toEqual({ message: "string-cause" });
  });
});

describe("subclasses", () => {
  test("each subclass tags itself with the right code", () => {
    expect(new SpecParseError("x").code).toBe("spec_parse");
    expect(new CompilerError("x").code).toBe("compiler");
    expect(new RuntimeError("x").code).toBe("runtime");
    expect(new ConfigError("x").code).toBe("config");
  });

  test("each subclass has a stable name (for instanceof / log filtering)", () => {
    expect(new SpecParseError("x").name).toBe("SpecParseError");
    expect(new CompilerError("x").name).toBe("CompilerError");
    expect(new RuntimeError("x").name).toBe("RuntimeError");
    expect(new ConfigError("x").name).toBe("ConfigError");
  });

  test("subclasses are instanceof their parent", () => {
    expect(new SpecParseError("x")).toBeInstanceOf(CrewhausError);
    expect(new CompilerError("x")).toBeInstanceOf(CrewhausError);
    expect(new RuntimeError("x")).toBeInstanceOf(CrewhausError);
    expect(new ConfigError("x")).toBeInstanceOf(CrewhausError);
  });
});
