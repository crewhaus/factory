/**
 * `/model` directives (§7.2.1): parsed only at the start of the typed input,
 * allow-list validated against the roster, `/model auto` clears.
 */
import { describe, expect, test } from "bun:test";
import { type DirectiveRosterArm, parseModelDirective, resolveDirectiveTarget } from "./directive";

const ROSTER: DirectiveRosterArm[] = [
  { armId: "fast", model: "claude-haiku-4-5", tags: ["cheap"] },
  { armId: "strong", model: "claude-opus-5", tags: ["strong"] },
  { armId: "openai/gpt-4o-mini", tags: [] },
];

describe("parseModelDirective", () => {
  test("no directive → undefined, including /model in the middle of prose", () => {
    expect(parseModelDirective("hello", ROSTER)).toBeUndefined();
    expect(parseModelDirective("please /model fast this", ROSTER)).toBeUndefined();
    expect(parseModelDirective("/models fast", ROSTER)).toBeUndefined();
  });

  test("$profile, bare name, tag and model string all resolve to the arm id", () => {
    expect(parseModelDirective("/model $fast go", ROSTER)).toEqual({
      kind: "pin",
      requested: "$fast",
      resolved: "fast",
      accepted: true,
      rest: "go",
    });
    expect(parseModelDirective("  /model strong", ROSTER)?.kind).toBe("pin");
    expect(resolveDirectiveTarget("cheap", ROSTER)).toBe("fast");
    expect(resolveDirectiveTarget("claude-opus-5", ROSTER)).toBe("strong");
    expect(resolveDirectiveTarget("openai/gpt-4o-mini", ROSTER)).toBe("openai/gpt-4o-mini");
  });

  test("/model auto clears the pin", () => {
    expect(parseModelDirective("/model auto", ROSTER)).toEqual({
      kind: "clear",
      requested: "auto",
      accepted: true,
      rest: "",
    });
  });

  test("a target outside the roster is refused with the roster listed", () => {
    const d = parseModelDirective("/model gpt-5 do it", ROSTER);
    expect(d?.kind).toBe("pin");
    expect(d?.accepted).toBe(false);
    if (d?.kind === "pin") {
      expect(d.resolved).toBeUndefined();
      expect(d.reason).toContain('"fast" [cheap]');
      expect(d.reason).toContain('"strong" [strong]');
      expect(d.rest).toBe("do it");
    }
  });

  test("a bare /model with no target is refused, not treated as a clear", () => {
    const d = parseModelDirective("/model", ROSTER);
    expect(d?.accepted).toBe(false);
    if (d?.kind === "pin") expect(d.reason).toContain('"auto"');
  });

  test("an empty roster refuses every target", () => {
    const d = parseModelDirective("/model fast", []);
    expect(d?.accepted).toBe(false);
    if (d?.kind === "pin") expect(d.reason).toContain("no roster");
  });
});
