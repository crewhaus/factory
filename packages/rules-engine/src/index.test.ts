import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, renderRules, resolveProfile } from "./index";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "rules-engine-test-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function seed(bucket: string, file: string, body: string): void {
  const dir = join(projectRoot, "rules", bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}

describe("loadRules", () => {
  test("returns empty array when rules/ is missing", () => {
    expect(loadRules({ projectRoot }).length).toBe(0);
  });

  test("returns common rules when no languages requested", () => {
    seed("common", "always-be-kind.md", "Be kind.");
    seed("typescript", "no-any.md", "Avoid any.");
    const rules = loadRules({ projectRoot });
    expect(rules.length).toBe(1);
    expect(rules[0]?.id).toBe("always-be-kind");
    expect(rules[0]?.bucket).toBe("common");
  });

  test("includes language buckets in standard profile (bucket-alphabetical order)", () => {
    seed("common", "a.md", "x");
    seed("typescript", "b.md", "x");
    seed("python", "c.md", "x");
    const rules = loadRules({
      projectRoot,
      languages: ["typescript", "python"],
    });
    // Buckets sort alphabetically: common, python, typescript.
    const out = rules.map((r) => `${r.bucket}/${r.id}`);
    expect(out).toEqual(["common/a", "python/c", "typescript/b"]);
  });

  test("ignores language buckets in core profile", () => {
    seed("common", "a.md", "x");
    seed("typescript", "b.md", "x");
    const rules = loadRules({
      projectRoot,
      profile: "core",
      languages: ["typescript"],
    });
    expect(rules.length).toBe(1);
    expect(rules[0]?.bucket).toBe("common");
  });

  test("includes all present buckets in full profile", () => {
    seed("common", "a.md", "x");
    seed("typescript", "b.md", "x");
    seed("rust", "c.md", "x");
    const rules = loadRules({ projectRoot, profile: "full" });
    expect(rules.length).toBe(3);
  });

  test("orders deterministically — bucket alphabetical, then file alphabetical", () => {
    seed("python", "z.md", "x");
    seed("python", "a.md", "x");
    seed("common", "m.md", "x");
    const rules = loadRules({ projectRoot, languages: ["python"] });
    const ids = rules.map((r) => `${r.bucket}/${r.id}`);
    expect(ids).toEqual(["common/m", "python/a", "python/z"]);
  });

  test("skips files that aren't .md or .txt", () => {
    seed("common", "rule.md", "x");
    seed("common", "ignore.json", "{}");
    const rules = loadRules({ projectRoot });
    expect(rules.length).toBe(1);
  });
});

describe("renderRules", () => {
  test("returns empty string for empty input", () => {
    expect(renderRules([])).toBe("");
  });

  test("emits a section per bucket and a subsection per rule", () => {
    seed("common", "a.md", "Body A");
    seed("typescript", "b.md", "Body B");
    const rendered = renderRules(loadRules({ projectRoot, languages: ["typescript"] }));
    expect(rendered).toContain("# Project rules");
    expect(rendered).toContain("## common");
    expect(rendered).toContain("## typescript");
    expect(rendered).toContain("### a");
    expect(rendered).toContain("### b");
    expect(rendered).toContain("Body A");
    expect(rendered).toContain("Body B");
  });

  test("is byte-stable across calls (prompt-cache friendly)", () => {
    seed("common", "a.md", "Body");
    const rendered1 = renderRules(loadRules({ projectRoot }));
    const rendered2 = renderRules(loadRules({ projectRoot }));
    expect(rendered1).toBe(rendered2);
  });
});

describe("resolveProfile", () => {
  test("recognised values pass through", () => {
    expect(resolveProfile("core")).toBe("core");
    expect(resolveProfile("standard")).toBe("standard");
    expect(resolveProfile("full")).toBe("full");
  });

  test("undefined and unrecognised default to standard", () => {
    expect(resolveProfile(undefined)).toBe("standard");
    expect(resolveProfile("unknown")).toBe("standard");
    expect(resolveProfile("")).toBe("standard");
  });
});
