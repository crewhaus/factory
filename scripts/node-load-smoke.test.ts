/**
 * scripts/node-load-smoke.ts against planted trees: a Node package with prebuilt
 * dist that loads and type-checks, a broken twin whose dist keeps an extensionless
 * relative import, and a tree with no Node package at all. It needs the real
 * `node` and `npm` (CI's ubuntu image has both); the install is `--offline`, from
 * the planted tarballs only, so nothing is fetched.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closureOf, exportSpecifiers, main, workspacePackages } from "./node-load-smoke";

const ROOT = dirname(import.meta.dir);
const HAVE_NODE = Bun.which("node") !== null && Bun.which("npm") !== null;
// Skipped on a machine without them, never in CI: there a missing node fails.
const withNode = test.skipIf(!HAVE_NODE && !process.env["CI"]);

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Plant = {
  readonly dir: string;
  readonly name: string;
  readonly node?: boolean;
  readonly deps?: Record<string, string>;
  /** dist file → contents */
  readonly dist: Record<string, string>;
  readonly exports?: Record<string, unknown>;
};

/** A built, stamped tree: dist/*.js and .d.ts in place, entrypoints on dist. */
function tree(plants: readonly Plant[]): string {
  const root = mkdtempSync(join(tmpdir(), "node-load-smoke-tree-"));
  temps.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  for (const p of plants) {
    const dir = join(root, "packages", p.dir);
    mkdirSync(join(dir, "dist"), { recursive: true });
    for (const [file, text] of Object.entries(p.dist)) writeFileSync(join(dir, "dist", file), text);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: p.name,
        version: "0.0.0-test",
        type: "module",
        engines: p.node === false ? { bun: ">=1.3.14" } : { node: ">=18", bun: ">=1.3.14" },
        exports: p.exports ?? {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
            default: "./dist/index.js",
          },
        },
        files: ["dist"],
        ...(p.deps ? { dependencies: p.deps } : {}),
      }),
    );
  }
  return root;
}

const LEAF: Plant = {
  dir: "zz-leaf",
  name: "@crewhaus/zz-leaf",
  dist: {
    "index.js": 'export { leaf } from "./leaf.js";\n',
    "leaf.js": "export const leaf = 1;\n",
    "index.d.ts": 'export { leaf } from "./leaf.js";\n',
    "leaf.d.ts": "export declare const leaf = 1;\n",
  },
};

const GOOD: Plant = {
  dir: "zz-good",
  name: "@crewhaus/zz-good",
  deps: { "@crewhaus/zz-leaf": "0.0.0-test" },
  dist: {
    "index.js":
      'import { leaf } from "@crewhaus/zz-leaf";\nexport { a } from "./other.js";\nexport const total = leaf + 1;\n',
    "other.js": "export const a = 2;\n",
    "extra.js": "export const extra = true;\n",
    "index.d.ts": 'export { a } from "./other.js";\nexport declare const total: number;\n',
    "other.d.ts": "export declare const a = 2;\n",
    "extra.d.ts": "export declare const extra = true;\n",
  },
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
    "./extra": {
      types: "./dist/extra.d.ts",
      import: "./dist/extra.js",
      default: "./dist/extra.js",
    },
    "./package.json": "./package.json",
  },
};

describe("the smoke over planted trees", () => {
  withNode(
    "a Node package and its closure load and type-check from their tarballs",
    () => {
      const root = tree([
        LEAF,
        GOOD,
        { dir: "zz-bun", name: "@crewhaus/zz-bun", node: false, dist: {} },
      ]);
      const lines: string[] = [];
      const code = main(["--root", root, "--offline"], (l) => lines.push(l));
      expect({ code, lines }).toEqual({ code: 0, lines: expect.any(Array) });
      expect(lines.find((l) => l.startsWith("✓ @crewhaus/zz-good"))).toContain(
        "(2 entry point(s)) and type-checks",
      );
      expect(lines.find((l) => l.startsWith("✓ @crewhaus/zz-leaf"))).toContain(
        "(1 entry point(s))",
      );
      // The Bun-only package is not one of them.
      expect(lines.some((l) => l.includes("zz-bun"))).toBe(false);
      expect(lines.at(-1)).toBe(
        "Node load smoke: 2 of 2 package(s) load and type-check on plain Node.",
      );
    },
    60_000, // npm pack and an install per package
  );

  withNode(
    "a broken twin whose dist keeps an extensionless import fails, naming the step",
    () => {
      const broken: Plant = {
        dir: "zz-broken",
        name: "@crewhaus/zz-broken",
        dist: {
          "index.js": 'export { a } from "./other";\n',
          "other.js": "export const a = 2;\n",
          "index.d.ts": 'export { a } from "./other.js";\n',
          "other.d.ts": "export declare const a = 2;\n",
        },
      };
      const lines: string[] = [];
      const code = main(["--root", tree([broken]), "--offline"], (l) => lines.push(l));
      expect(code).toBe(1);
      const line = lines.find((l) => l.startsWith("✗ @crewhaus/zz-broken"));
      expect(line).toContain("import @crewhaus/zz-broken failed");
      expect(line).toContain("ERR_MODULE_NOT_FOUND");
      expect(lines.at(-1)).toBe(
        "Node load smoke: 0 of 1 package(s) load and type-check on plain Node.",
      );
    },
    60_000,
  );

  withNode(
    "declarations that do not resolve under NodeNext fail the type-check, even when the import loads",
    () => {
      const typesOnly: Plant = {
        dir: "zz-types",
        name: "@crewhaus/zz-types",
        dist: {
          "index.js": 'export { a } from "./other.js";\n',
          "other.js": "export const a = 2;\n",
          "index.d.ts": 'export { a } from "./other";\n',
          "other.d.ts": "export declare const a = 2;\n",
        },
      };
      const lines: string[] = [];
      const code = main(["--root", tree([typesOnly]), "--offline"], (l) => lines.push(l));
      expect(code).toBe(1);
      expect(lines.find((l) => l.startsWith("✗ @crewhaus/zz-types"))).toContain(
        "type-check failed",
      );
    },
    60_000,
  );

  test("a tree with no Node package says so and passes", () => {
    const lines: string[] = [];
    const root = tree([{ dir: "zz-bun", name: "@crewhaus/zz-bun", node: false, dist: {} }]);
    expect(main(["--root", root], (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(["No package declares engines.node yet; nothing to load."]);
  });

  test("the real tree: none yet, so the CI step loads nothing (the first Node package changes this)", () => {
    const lines: string[] = [];
    expect(main(["--root", ROOT], (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(["No package declares engines.node yet; nothing to load."]);
    expect(workspacePackages(ROOT).length).toBeGreaterThanOrEqual(300);
  });
});

describe("helpers", () => {
  test("exportSpecifiers: every subpath, `.` as the name, patterns and package.json left out", () => {
    expect(
      exportSpecifiers("@crewhaus/x", {
        ".": "./dist/index.js",
        "./a": "./dist/a.js",
        "./b/*": "./dist/b/*.js",
        "./package.json": "./package.json",
      }),
    ).toEqual(["@crewhaus/x", "@crewhaus/x/a"]);
    expect(exportSpecifiers("@crewhaus/x", { import: "./dist/index.js" })).toEqual(["@crewhaus/x"]);
    expect(exportSpecifiers("@crewhaus/x", undefined)).toEqual(["@crewhaus/x"]);
  });

  test("closureOf follows shipping dependencies inside the workspace only, once each", () => {
    const pkg = (name: string, deps: Record<string, string> = {}) => ({
      name,
      dir: `/x/${name}`,
      manifest: { name, dependencies: deps },
    });
    const a = pkg("@crewhaus/a", { "@crewhaus/b": "1", zod: "^3" });
    const b = pkg("@crewhaus/b", { "@crewhaus/c": "1", "@crewhaus/a": "1" });
    const c = pkg("@crewhaus/c");
    const byName = new Map([a, b, c].map((p) => [p.name, p]));
    expect(closureOf(a, byName).map((p) => p.name)).toEqual([
      "@crewhaus/a",
      "@crewhaus/b",
      "@crewhaus/c",
    ]);
  });
});
