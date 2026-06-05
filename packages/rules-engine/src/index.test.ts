import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesEngineError, loadRules, renderRules, resolveProfile } from "./index";

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

describe("RulesEngineError", () => {
  test("carries the 'config' code and the RulesEngineError name", () => {
    const err = new RulesEngineError("nope");
    expect(err).toBeInstanceOf(RulesEngineError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RulesEngineError");
    expect(err.code).toBe("config");
    expect(err.message).toBe("nope");
  });
});

describe("loadRules read-failure path", () => {
  // The bucket/file enumeration runs against the real seeded temp dir; only
  // readFileSync is forced to throw so loadRules' catch -> RulesEngineError
  // branch executes (covering the constructor) without any real read failure.
  afterEach(() => {
    spyOn(nodeFs, "readFileSync").mockRestore();
  });

  test("wraps a readFileSync failure in a RulesEngineError naming the rule", () => {
    seed("common", "broken.md", "body");
    const spy = spyOn(nodeFs, "readFileSync").mockImplementation(() => {
      throw new Error("EIO simulated read error");
    });
    expect(() => loadRules({ projectRoot })).toThrow(RulesEngineError);
    try {
      loadRules({ projectRoot });
      throw new Error("expected loadRules to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RulesEngineError);
      expect((err as RulesEngineError).message).toContain("common/broken.md");
      expect((err as RulesEngineError).message).toContain("EIO simulated read error");
    }
    expect(spy).toHaveBeenCalled();
  });
});

// Guard: ensure no mock.module leaked from this file affects sibling suites.
afterEach(() => {
  mock.restore();
});
