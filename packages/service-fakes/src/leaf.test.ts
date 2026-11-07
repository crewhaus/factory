import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  name: string;
  private: boolean;
  version: string;
  publishConfig?: unknown;
  files?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

test("the package is a leaf: no dependency of any kind", () => {
  for (const block of [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ]) {
    expect(block ?? {}).toEqual({});
  }
});

test("the manifest is private, at 0.0.0, with nothing that would publish it", () => {
  expect(manifest.name).toBe("service-fakes");
  expect(manifest.private).toBe(true);
  expect(manifest.version).toBe("0.0.0");
  expect(manifest.publishConfig).toBeUndefined();
  expect(manifest.files).toBeUndefined();
});
