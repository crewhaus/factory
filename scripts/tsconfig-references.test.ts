/**
 * Every workspace package with a tsconfig.json is a reference of the root
 * tsconfig.json, and every reference is such a package.
 *
 * `bun run typecheck` and `bun run build` are `tsc -b` over the root's
 * references. A package left out of them is never type-checked and never built,
 * so its dist is missing from the published tarball, and nothing says so until
 * the pack pre-flight, the last step of CI. A reference to a directory without a
 * tsconfig.json fails `tsc -b` outright. Private packages are referenced too:
 * they are type-checked like any other.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

const ROOT = dirname(import.meta.dir);

/** `./packages/x`, `packages/x/`, `./packages/x/tsconfig.json` → `packages/x`. */
const normalize = (path: string): string =>
  path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/tsconfig\.json$/, "")
    .replace(/\/+$/, "");

/** Workspace directories (by the root package.json's globs) that have a tsconfig.json. */
function compiledWorkspaceDirs(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const out: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    const star = pattern.endsWith("/*");
    const base = star ? pattern.slice(0, -2) : pattern;
    if (!existsSync(join(root, base))) continue;
    const dirs = star ? readdirSync(join(root, base)).map((e) => `${base}/${e}`) : [base];
    for (const dir of dirs) {
      const abs = join(root, dir);
      if (statSync(abs).isDirectory() && existsSync(join(abs, "tsconfig.json")))
        out.push(normalize(dir));
    }
  }
  return out.sort();
}

/** The root tsconfig.json's reference paths, normalized. */
function rootReferences(root: string): string[] {
  const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const refs = (read.config as { references?: { path?: unknown }[] } | undefined)?.references ?? [];
  return refs.flatMap((r) => (typeof r.path === "string" ? [normalize(r.path)] : [])).sort();
}

/** What is wrong between the two lists, each problem naming the directory. */
function referenceProblems(root: string): { problems: string[]; dirs: number; refs: number } {
  const dirs = compiledWorkspaceDirs(root);
  const refs = rootReferences(root);
  const referenced = new Set(refs);
  const problems: string[] = [];
  for (const dir of dirs) {
    if (!referenced.has(dir)) {
      problems.push(
        `${dir} has a tsconfig.json but the root tsconfig.json does not reference it, so tsc -b never builds it`,
      );
    }
  }
  for (const ref of refs) {
    if (!existsSync(join(root, ref, "tsconfig.json"))) {
      problems.push(`the root tsconfig.json references ./${ref}, which has no tsconfig.json`);
    }
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) problems.push(`the root tsconfig.json references ./${ref} twice`);
    seen.add(ref);
  }
  return { problems, dirs: dirs.length, refs: refs.length };
}

test("the real tree: every compiled workspace package is referenced, and every reference resolves", () => {
  const r = referenceProblems(ROOT);
  expect(r.problems).toEqual([]);
  // Private packages included; the walk really read the tree.
  expect(r.dirs).toBeGreaterThanOrEqual(300);
  expect(r.refs).toBe(r.dirs);
});

describe("planted", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });
  function plant(packages: string[], references: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "tsconfig-references-"));
    temps.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
    );
    for (const p of packages) {
      mkdirSync(join(root, p), { recursive: true });
      writeFileSync(join(root, p, "package.json"), "{}");
      writeFileSync(join(root, p, "tsconfig.json"), "{}");
    }
    // A directory without a tsconfig is not compiled, so it needs no reference.
    mkdirSync(join(root, "packages", "assets-only"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      `// comments are fine here\n${JSON.stringify({ files: [], references: references.map((path) => ({ path })) })}`,
    );
    return root;
  }

  test("a clean root has no problems", () => {
    expect(
      referenceProblems(plant(["packages/a", "apps/cli"], ["./packages/a", "./apps/cli"])).problems,
    ).toEqual([]);
  });

  test("a package missing from the references is named", () => {
    expect(
      referenceProblems(plant(["packages/a", "packages/b"], ["./packages/a"])).problems,
    ).toEqual([
      "packages/b has a tsconfig.json but the root tsconfig.json does not reference it, so tsc -b never builds it",
    ]);
  });

  test("a dangling reference is named", () => {
    expect(
      referenceProblems(plant(["packages/a"], ["./packages/a", "./packages/gone"])).problems,
    ).toEqual(["the root tsconfig.json references ./packages/gone, which has no tsconfig.json"]);
  });
});
