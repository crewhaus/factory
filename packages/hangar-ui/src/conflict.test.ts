import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { CONFLICT_MESSAGE, conflictModel } from "../assets/js/ui/conflict.js";

describe("conflictModel", () => {
  test("keeps the server's revision and diff, the draft, and all three ways forward", () => {
    const m = conflictModel({ rev: "r2", diff: "-a\n+b\n" }, '{"path":"x"}');
    expect(m.message).toBe(CONFLICT_MESSAGE);
    expect(m.rev).toBe("r2");
    expect(m.diff).toBe("-a\n+b\n");
    expect(m.draft).toBe('{"path":"x"}');
    expect(m.actions.map((a: { id: string }) => a.id)).toEqual(["reapply", "use-disk", "download"]);
  });

  test("the draft falls back to the server's copy, and is never dropped", () => {
    expect(conflictModel({ draft: "kept" }, undefined).draft).toBe("kept");
    expect(conflictModel({}, "mine").draft).toBe("mine");
    expect(conflictModel(null, "mine").draft).toBe("mine");
  });

  test("a diff carrying markup stays a string", () => {
    const diff = '+<img src=x onerror="alert(1)">';
    const m = conflictModel({ rev: 3, diff }, "");
    expect(typeof m.diff).toBe("string");
    expect(m.diff).toBe(diff);
    expect(m.rev).toBe("3");
  });

  test("anything else in the answer is ignored", () => {
    const m = conflictModel({ rev: { evil: true }, diff: 42 }, 7);
    expect(m.rev).toBeNull();
    expect(m.diff).toBe("");
    expect(m.draft).toBe("");
  });
});
