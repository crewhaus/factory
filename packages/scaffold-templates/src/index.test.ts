import { describe, expect, test } from "bun:test";
import { TEMPLATES, getTemplate, listTemplates } from "./index.js";

describe("scaffold-templates (T1)", () => {
  test("ships one template per target shape (10 total)", () => {
    const targets = TEMPLATES.map((t) => t.target).sort();
    expect(targets).toEqual([
      "batch",
      "browser",
      "channel",
      "cli",
      "crew",
      "graph",
      "managed",
      "pipeline",
      "research",
      "voice",
    ]);
  });

  test("getTemplate returns the matching template by id", () => {
    const t = getTemplate("cli-coding-agent");
    expect(t?.target).toBe("cli");
    expect(t?.yaml).toContain("target: cli");
  });

  test("listTemplates returns the metadata fields only (no yaml body)", () => {
    const list = listTemplates();
    expect(list[0]?.id).toBeDefined();
    expect(list[0]?.title).toBeDefined();
    // No yaml in the list response
    expect((list[0] as unknown as { yaml?: string }).yaml).toBeUndefined();
  });

  test("every template's yaml has a `name:` and `target:` line (T9 well-formedness)", () => {
    for (const t of TEMPLATES) {
      expect(t.yaml).toMatch(/^name:\s+.+$/m);
      expect(t.yaml).toMatch(new RegExp(`^target:\\s+${t.target}$`, "m"));
    }
  });

  test("template ids are unique", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
