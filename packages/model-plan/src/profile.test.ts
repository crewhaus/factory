/**
 * Profile references (§4.1, §4.3): the `$` sigil, name validation, did-you-mean,
 * and the field-by-field precedence with tags replacing.
 */
import { describe, expect, test } from "bun:test";
import {
  ModelPlanError,
  PROFILE_NAME_RE,
  applyProfileDefaults,
  invalidProfileNames,
  isProfileRef,
  profileRefName,
  resolveProfileRef,
} from "./profile";
import type { ModelProfile, ProfileRegistry } from "./types";

const REGISTRY: ProfileRegistry = {
  fast: {
    model: "claude-haiku-4-5",
    tags: ["cheap"],
    maxTokens: 4096,
    thinking: { effort: "low" },
  },
  strong: { model: "claude-opus-5", tags: ["strong"], thinking: { effort: "high" } },
  checker: { model: "claude-sonnet-5", temperature: 0, tools: [] },
};
const FAST: ModelProfile = { ...(REGISTRY["fast"] as ModelProfile), profile: "fast" };

describe("resolveProfileRef", () => {
  test("a grammar string passes through untouched", () => {
    expect(resolveProfileRef("openai/gpt-4o-mini", REGISTRY)).toEqual({
      model: "openai/gpt-4o-mini",
    });
    expect(resolveProfileRef("cheapest", REGISTRY)).toEqual({ model: "cheapest" });
  });

  test("a $ref resolves to the profile's model, name and settings", () => {
    const r = resolveProfileRef("$fast", REGISTRY, "agent.model");
    expect(r.model).toBe("claude-haiku-4-5");
    expect(r.profile).toBe("fast");
    expect(r.settings?.maxTokens).toBe(4096);
    expect(r.settings?.profile).toBe("fast");
  });

  test("unknown ref throws with a did-you-mean naming the nearest profile", () => {
    let caught: unknown;
    try {
      resolveProfileRef("$fats", REGISTRY, "agent.model");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelPlanError);
    const msg = (caught as Error).message;
    expect(msg).toContain("agent.model");
    expect(msg).toContain('did you mean "$fast"');
    expect(msg).toContain("$strong");
  });

  test("unknown ref with no registry says so", () => {
    expect(() => resolveProfileRef("$fast", undefined)).toThrow(/declares no models: block/);
  });

  test("an env-ref-shaped name is rejected by the name rule, not resolved", () => {
    // `$UPPER_SNAKE` is the env-ref convention; profile names are lowercase-first.
    expect(() => resolveProfileRef("$FAST", REGISTRY)).toThrow(/not a valid profile reference/);
    expect(PROFILE_NAME_RE.test("FAST")).toBe(false);
    expect(PROFILE_NAME_RE.test("fast-2")).toBe(true);
    expect(PROFILE_NAME_RE.test("a".repeat(64))).toBe(true);
    expect(PROFILE_NAME_RE.test("a".repeat(65))).toBe(false);
  });

  test("isProfileRef / profileRefName", () => {
    expect(isProfileRef("$fast")).toBe(true);
    expect(isProfileRef("fast")).toBe(false);
    expect(profileRefName("$fast")).toBe("fast");
    expect(profileRefName("claude-opus-5")).toBeUndefined();
  });

  test("invalidProfileNames lists offenders only", () => {
    expect(invalidProfileNames({ ...REGISTRY, Bad: { model: "x" }, "9x": { model: "y" } })).toEqual(
      ["Bad", "9x"],
    );
    expect(invalidProfileNames(REGISTRY)).toEqual([]);
  });
});

describe("applyProfileDefaults", () => {
  test("profile supplies defaults, slot-local overrides field-by-field", () => {
    const merged = applyProfileDefaults({ maxTokens: 1024, temperature: 0.3 }, FAST);
    expect(merged.model).toBe("claude-haiku-4-5");
    expect(merged.maxTokens).toBe(1024);
    expect(merged.temperature).toBe(0.3);
    expect(merged.thinking).toEqual({ effort: "low" });
    expect(merged.tags).toEqual(["cheap"]);
    expect(merged.profile).toBe("fast");
  });

  test("tags REPLACE, never accumulate", () => {
    const merged = applyProfileDefaults({ tags: ["draft"] }, FAST);
    expect(merged.tags).toEqual(["draft"]);
  });

  test("undefined local fields do not clobber profile values", () => {
    const merged = applyProfileDefaults({ maxTokens: undefined }, FAST);
    expect(merged.maxTokens).toBe(4096);
  });
});
