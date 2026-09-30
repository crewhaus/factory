/**
 * Every package a published package imports is one it DECLARES.
 *
 * The publish step drops devDependencies from the tarball. Inside the
 * workspace every package resolves anyway, and after an install a
 * devDependency usually still resolves because some other package pulled it
 * in and the installer hoisted it — so an undeclared import passes every
 * local gate and breaks only where the layout differs: a strict (isolated)
 * install, or a consumer whose own top-level copy is a different major. The
 * bare `crewhaus` CLI shipped `zod` that way: in a project with zod@4 its
 * schemas silently reached the model with no parameters (C110). The CLI's
 * own guard (apps/cli/src/manifest.test.ts) and runtime-core's cover those
 * two packages; this covers every publishable one.
 *
 * Two surfaces, read by parsers rather than regexes (a regex matches prose in
 * comments and the import statements the target-* packages emit as strings):
 *
 *   - RUNTIME: `Bun.Transpiler#scan`, which drops `import type` — what Bun
 *     loads when the package runs. Must be declared, no exceptions.
 *   - TYPES: TypeScript's `preProcessFile`, which sees `import type` too.
 *     These packages publish TypeScript SOURCE as their `types` entry, so a
 *     consumer's compiler resolves every import in it, type-only or not. The
 *     known gaps are listed below, each with its owner; the list is checked
 *     in both directions, so a fixed gap must leave it and a new one fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");

type Manifest = {
  readonly name?: string;
  readonly private?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

type Pkg = { readonly dir: string; readonly manifest: Manifest & { name: string } };

/** Type-only imports of an undeclared package, known and owned elsewhere. */
const KNOWN_TYPE_GAPS: ReadonlyArray<string> = [
  // `import type { ProviderAdapter }` in src/index.ts; adapter-anthropic is a
  // devDependency. Owner: crew-orchestrator (declare it, or re-home the type).
  "@crewhaus/crew-orchestrator: @crewhaus/adapter-anthropic",
  // `import type { ModelProfile, RouteRule }` in src/index.ts; model-plan is a
  // devDependency. Owner: compiler.
  "@crewhaus/compiler: @crewhaus/model-plan",
];

function publishable(): Pkg[] {
  const out: Pkg[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group)).sort()) {
      const dir = join(ROOT, group, entry);
      const file = join(dir, "package.json");
      if (!existsSync(file) || !existsSync(join(dir, "src"))) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      if (manifest.private === true || typeof manifest.name !== "string") continue;
      out.push({ dir, manifest: manifest as Manifest & { name: string } });
    }
  }
  return out;
}

/** Non-test sources under src/, fixtures excluded. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.includes("fixtures")) continue;
      out.push(...sources(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

const BUILTINS = new Set(builtinModules);

/** The package a bare specifier names, or undefined for a relative/builtin one. */
function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (/^(node|bun):/.test(specifier) || specifier === "bun" || BUILTINS.has(specifier)) {
    return undefined;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const tsScanner = new Bun.Transpiler({ loader: "ts" });
const tsxScanner = new Bun.Transpiler({ loader: "tsx" });

/** `<package>: <undeclared import>` for one package, per surface. */
function undeclaredImports(
  pkg: Pkg,
  surface: "runtime" | "types",
): { gaps: string[]; scanned: number } {
  const declared = new Set([
    pkg.manifest.name,
    ...Object.keys(pkg.manifest.dependencies ?? {}),
    ...Object.keys(pkg.manifest.peerDependencies ?? {}),
    ...Object.keys(pkg.manifest.optionalDependencies ?? {}),
  ]);
  const gaps = new Set<string>();
  let scanned = 0;
  for (const file of sources(join(pkg.dir, "src"))) {
    const text = readFileSync(file, "utf8");
    const specifiers =
      surface === "runtime"
        ? (file.endsWith(".tsx") ? tsxScanner : tsScanner).scan(text).imports.map((i) => i.path)
        : ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
    for (const specifier of specifiers) {
      const name = packageOf(specifier);
      if (name === undefined) continue;
      scanned += 1;
      if (!declared.has(name)) gaps.add(`${pkg.manifest.name}: ${name}`);
    }
  }
  return { gaps: [...gaps].sort(), scanned };
}

describe("every published package declares what it imports", () => {
  const pkgs = publishable();
  // Each surface is scanned ONCE and shared: a full scan reads a couple of
  // thousand files, which takes about a second here and many times that on a
  // CI runner, so every test below declares a budget (house rule: a test
  // that is slow by construction says so rather than racing the default).
  const memo = new Map<"runtime" | "types", { gaps: string[]; scanned: number }>();
  const scan = (surface: "runtime" | "types") => {
    const hit = memo.get(surface);
    if (hit !== undefined) return hit;
    const all = pkgs.map((p) => undeclaredImports(p, surface));
    const result = {
      gaps: all.flatMap((r) => r.gaps).sort(),
      scanned: all.reduce((n, r) => n + r.scanned, 0),
    };
    memo.set(surface, result);
    return result;
  };

  test("the sweep reads what it is meant to guard", () => {
    // Hit counts: well over two hundred packages, and between them
    // thousands of bare imports on each surface. A sweep that found a
    // handful would be reading the wrong directory or the wrong syntax.
    expect(pkgs.length).toBeGreaterThan(200);
    expect(pkgs.some((p) => p.manifest.name === "crewhaus")).toBe(true);
    expect(scan("runtime").scanned).toBeGreaterThan(1000);
    expect(scan("types").scanned).toBeGreaterThan(scan("runtime").scanned);
  }, 60_000);

  test("every runtime import is a declared dependency", () => {
    expect(scan("runtime").gaps).toEqual([]);
  }, 60_000);

  test("every type-level import is declared, except the listed gaps — which must still exist", () => {
    expect(scan("types").gaps).toEqual([...KNOWN_TYPE_GAPS].sort());
  }, 60_000);
});

describe("the scanners read imports, not text that looks like one", () => {
  const made: string[] = [];
  const fixture = (files: Record<string, string>, manifest: Manifest = {}): Pkg => {
    const dir = mkdtempSync(join(tmpdir(), "declared-imports-"));
    made.push(dir);
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, "src", rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return { dir, manifest: { name: "fixture", ...manifest } };
  };
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  test("an undeclared runtime import is found; a devDependency does not count", () => {
    const pkg = fixture(
      { "index.ts": 'import { z } from "zod";\nexport const s = z.string();\n' },
      { devDependencies: { zod: "^3" } } as Manifest,
    );
    expect(undeclaredImports(pkg, "runtime").gaps).toEqual(["fixture: zod"]);
  });

  test("a type-only import is a TYPE gap, not a runtime one", () => {
    const pkg = fixture({
      "index.ts":
        'import type { Sample } from "@crewhaus/eval-dataset";\nexport type S = Sample;\n',
    });
    expect(undeclaredImports(pkg, "runtime").gaps).toEqual([]);
    expect(undeclaredImports(pkg, "types").gaps).toEqual(["fixture: @crewhaus/eval-dataset"]);
  });

  test("an import inside a template string (emitted code) or a comment is not an import", () => {
    const pkg = fixture({
      "emit.ts":
        'export const code = `import type { T } from "@crewhaus/foo";\\nimport "bar";`;\n// import { x } from "baz";\n',
    });
    expect(undeclaredImports(pkg, "runtime").gaps).toEqual([]);
    expect(undeclaredImports(pkg, "types").gaps).toEqual([]);
  });

  test("relative, node:, bun: and builtin specifiers are not packages", () => {
    expect(["./x", "../y", "node:fs", "bun:test", "bun", "fs", "path"].map(packageOf)).toEqual(
      Array(7).fill(undefined),
    );
    expect(packageOf("@scope/name/sub")).toBe("@scope/name");
    expect(packageOf("zod/lib")).toBe("zod");
  });
});
