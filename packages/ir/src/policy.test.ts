import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POLICY_KEYS,
  bundleDigest,
  bundleManifestText,
  canonicalJson,
  intentDigest,
  policyMaterialOf,
  policyRevision,
  specRevision,
} from "./policy";

describe("specRevision", () => {
  test("is a sha256 of the source with line endings and one trailing newline normalized", () => {
    const lf = specRevision("name: a\ntarget: cli\n");
    expect(lf).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(specRevision("name: a\r\ntarget: cli\r\n")).toBe(lf);
    expect(specRevision("name: a\ntarget: cli")).toBe(lf);
    expect(specRevision("name: a\ntarget: cli\n\n")).not.toBe(lf);
    expect(specRevision("name: a\ntarget:  cli\n")).not.toBe(lf);
  });
});

describe("intentDigest", () => {
  test("is undefined for an absent block and stable across key order", () => {
    expect(intentDigest(undefined)).toBeUndefined();
    const a = intentDigest({ outcome: "x", measures: ["a", "b"] });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(intentDigest({ measures: ["a", "b"], outcome: "x" })).toBe(a as string);
    expect(intentDigest({ outcome: "y", measures: ["a", "b"] })).not.toBe(a as string);
  });
});

describe("policyMaterialOf", () => {
  test("reads every POLICY_KEYS entry and nothing else", () => {
    const ir: Record<string, unknown> = { model: "m", instructions: "i" };
    for (const key of POLICY_KEYS) ir[key] = { marker: key };
    const material = JSON.parse(policyMaterialOf(ir)) as Record<string, unknown>;
    expect(Object.keys(material).sort()).toEqual([...POLICY_KEYS].sort());
  });

  test("an IR with no policy key has one fixed material and revision", () => {
    expect(policyMaterialOf({ target: "cli", model: "a" })).toBe("{}");
    expect(policyRevision({ target: "cli", model: "a" })).toBe(
      policyRevision({ target: "cli", model: "b" }),
    );
  });

  test("changes with the permission rules and not with the model", () => {
    const base = { model: "a", permissions: { rules: [{ type: "alwaysAllow", pattern: "read" }] } };
    const other = { ...base, permissions: { rules: [{ type: "alwaysDeny", pattern: "read" }] } };
    expect(policyMaterialOf(other)).not.toBe(policyMaterialOf(base));
    expect(policyMaterialOf({ ...base, model: "b" })).toBe(policyMaterialOf(base));
  });

  test("drops undefined fields, sorts keys", () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [2, { y: 1, x: 2 }] })).toBe(
      '{"b":1,"c":[2,{"x":2,"y":1}]}',
    );
  });
});

describe("bundleManifestText", () => {
  test("sorts by path whatever the input order, and prints absent and link lines", () => {
    const files = [
      { path: "dist/z.ts", sha256: "bb" },
      { path: "tsconfig.json", sha256: null },
      { path: "dist/a.ts", sha256: "aa" },
      { path: "dist/link.ts", sha256: null, link: "../elsewhere.ts" },
    ];
    const text = bundleManifestText(files);
    expect(text).toBe(
      "aa  dist/a.ts\nlink:../elsewhere.ts  dist/link.ts\nbb  dist/z.ts\nabsent  tsconfig.json\n",
    );
    expect(bundleManifestText([...files].reverse())).toBe(text);
    expect(bundleDigest(files)).toBe(bundleDigest([...files].reverse()));
    expect(bundleDigest(files)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundleDigest(files.slice(1))).not.toBe(bundleDigest(files));
  });
});

describe("the IR's main entry", () => {
  test("imports no node: module and does not re-export ./policy", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/["']\.\/policy["']/);
  });
});
