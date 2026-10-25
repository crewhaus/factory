import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedSourceKey, sampleProvabilityOf } from "./metadata";

const read = (provability: unknown) =>
  sampleProvabilityOf({
    metadata: provability === undefined ? {} : { provability },
  });

describe("sampleProvabilityOf", () => {
  test("absent metadata (or absent key) reads as no override", () => {
    expect(sampleProvabilityOf({})).toEqual({ ok: true, value: {} });
    expect(read(undefined)).toEqual({ ok: true, value: {} });
  });

  test("a rung name is shorthand for { level }", () => {
    expect(read("checked")).toEqual({ ok: true, value: { level: "checked" } });
  });

  test("the object form carries level and expected_sources", () => {
    expect(read({ level: "grounded", expected_sources: ["https://a.example/x"] })).toEqual({
      ok: true,
      value: { level: "grounded", expectedSources: ["https://a.example/x"] },
    });
    expect(read({ expected_sources: ["docs/a.md"] })).toEqual({
      ok: true,
      value: { expectedSources: ["docs/a.md"] },
    });
  });

  test("`off` and unknown rungs are refused, naming the vocabulary", () => {
    for (const bad of ["off", "proved", { level: "off" }]) {
      const got = read(bad);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.error).toContain("cited | grounded | checked | proven");
    }
  });

  test("unknown keys, a non-list expected_sources and blank entries are refused", () => {
    const unknown = read({ level: "cited", sources: [] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('"sources"');
    expect(read({ expected_sources: "https://a.example" }).ok).toBe(false);
    expect(read({ expected_sources: ["https://a.example", " "] }).ok).toBe(false);
    expect(read({ expected_sources: [1] }).ok).toBe(false);
  });

  test("non-object, non-string values are refused", () => {
    for (const bad of [3, true, null, ["grounded"]]) expect(read(bad).ok).toBe(false);
  });
});

describe("expectedSourceKey — the origin normalization the bundle used", () => {
  test("URLs normalize like a binding origin (case, trailing slash, fragment)", () => {
    expect(expectedSourceKey("https://ACME.example/policy/#refunds")).toBe(
      "https://acme.example/policy",
    );
  });

  test("a doi: ref is its resolver URL", () => {
    expect(expectedSourceKey("doi:10.1000/ABC")).toBe("https://doi.org/10.1000/abc");
  });

  test("a workspace path is workspace-relative POSIX", () => {
    const root = mkdtempSync(join(tmpdir(), "grader-prov-meta-"));
    try {
      expect(expectedSourceKey("./docs/pricing.md", root)).toBe("docs/pricing.md");
      expect(expectedSourceKey(join(root, "docs", "pricing.md"), root)).toBe("docs/pricing.md");
      // Outside the workspace: kept as written (minus ./), so it can only
      // match an origin spelled exactly that way.
      expect(expectedSourceKey("/elsewhere/x.md", root)).toBe("/elsewhere/x.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
