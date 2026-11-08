/**
 * Packages that load on plain Node: the source half of the guarantee.
 *
 * Most workspace packages run on Bun only (Bun.* calls, `bun:` imports, text
 * imports, extensionless relative specifiers that `moduleResolution: Bundler`
 * allows), and their published README says so. A package whose committed
 * package.json declares `engines.node` promises more, and is held to it here:
 *
 *   - its tsconfig compiles it as NodeNext (module and moduleResolution both;
 *     tsconfig.base.json's Bundler has to be overridden), so the dist it ships
 *     keeps the `.js` extensions Node's resolver needs;
 *   - every `exports` source entry type-checks under NodeNext with no Bun types
 *     (`types: []`, lib es2022 plus dom), which is what catches a `Bun.*` call, a
 *     `bun:` import, a text import or an extensionless relative import;
 *   - every internal `@crewhaus/*` package it depends on (dependencies,
 *     peerDependencies, optionalDependencies) declares `engines.node` too, so the
 *     whole closure loads;
 *   - nothing Bun-only ships as a dependency (`bun`, `bun-types`, `@types/bun`).
 *
 * scripts/node-load-smoke.ts is the other half: CI packs each such package after
 * the pack pre-flight and loads and type-checks it under real `node`.
 *
 * No package declares `engines.node` yet, so each rule proves itself on planted
 * packages below, and the real-tree list is pinned so the first one joins it on
 * purpose.
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
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = dirname(import.meta.dir);

type Manifest = {
  readonly name?: string;
  readonly engines?: Record<string, unknown>;
  readonly main?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

const SHIPPING_BLOCKS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const BUN_ONLY = new Set(["bun", "bun-types", "@types/bun"]);

/** The options a Node consumer's compiler reads the source with: no Bun anywhere. */
const NODE_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

/** Does this manifest declare the Node-loadable class? */
const declaresNode = (m: Manifest | undefined): boolean =>
  typeof m?.engines?.["node"] === "string" && (m.engines["node"] as string).trim() !== "";

/** Every workspace manifest under `root`, by the root manifest's `workspaces` globs. */
function workspaceManifests(root: string): { dir: string; manifest: Manifest }[] {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const out: { dir: string; manifest: Manifest }[] = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    const star = pattern.endsWith("/*");
    const base = join(root, star ? pattern.slice(0, -2) : pattern);
    if (!existsSync(base)) continue;
    const dirs = star ? readdirSync(base).map((e) => join(base, e)) : [base];
    for (const dir of dirs.sort()) {
      const file = join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      out.push({ dir, manifest: JSON.parse(readFileSync(file, "utf8")) as Manifest });
    }
  }
  return out;
}

/** The TypeScript sources an `exports` map (or, without one, `main`) points at. */
function sourceEntries(m: Manifest): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (/\.(?:m|c)?tsx?$/.test(value) && !value.endsWith(".d.ts")) out.push(value);
    } else if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v);
    }
  };
  visit(m.exports ?? m.main);
  return [...new Set(out)];
}

/**
 * Everything that keeps the package in `dir` from loading on plain Node, each
 * problem naming its rule. `workspace` maps every workspace package's name to its
 * manifest, for the closure rule.
 */
function nodePackageProblems(dir: string, workspace: ReadonlyMap<string, Manifest>): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

  // (a) the package's own compile: NodeNext, so its dist keeps the extensions.
  const tsconfig = join(dir, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    problems.push("tsconfig: there is no tsconfig.json, so nothing compiles it as NodeNext");
  } else {
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config ?? {},
      ts.sys,
      dir,
      undefined,
      tsconfig,
    );
    const { module, moduleResolution } = parsed.options;
    if (
      module !== ts.ModuleKind.NodeNext ||
      moduleResolution !== ts.ModuleResolutionKind.NodeNext
    ) {
      const name = (v: number | undefined, e: Record<number, string>) =>
        v === undefined ? "unset" : (e[v] ?? String(v));
      problems.push(
        `tsconfig: module is ${name(module, ts.ModuleKind)} and moduleResolution is ${name(moduleResolution, ts.ModuleResolutionKind)}; both must be NodeNext (override tsconfig.base.json's Bundler in the package's own compilerOptions)`,
      );
    }
  }

  // (b) every exports entry, read the way a Node consumer's compiler reads it.
  const entries = sourceEntries(manifest).map((e) => join(dir, e));
  if (entries.length === 0) {
    problems.push("types: no exports entry points at a TypeScript source to check");
  } else {
    const missing = entries.filter((e) => !existsSync(e));
    for (const e of missing)
      problems.push(`types: the exports entry ${relative(dir, e)} is not there`);
    const program = ts.createProgram(
      entries.filter((e) => existsSync(e)),
      NODE_OPTIONS,
    );
    for (const d of ts.getPreEmitDiagnostics(program)) {
      const where = d.file ? relative(dir, d.file.fileName) : "(program)";
      problems.push(`types: ${where}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  }

  for (const block of SHIPPING_BLOCKS) {
    for (const dep of Object.keys(manifest[block] ?? {})) {
      // (c) the closure: an internal dependency is a Node package too.
      if (dep.startsWith("@crewhaus/") && !declaresNode(workspace.get(dep))) {
        problems.push(
          `closure: ${block} names ${dep}, which does not declare engines.node, so plain Node cannot load it`,
        );
      }
      // (d) nothing that only Bun can use ships with it.
      if (BUN_ONLY.has(dep)) problems.push(`bun-only: ${block} names ${dep}, which only Bun uses`);
    }
  }
  return problems;
}

describe("the real tree", () => {
  const all = workspaceManifests(ROOT);
  const workspace = new Map(
    all.flatMap((p) => (p.manifest.name ? [[p.manifest.name, p.manifest]] : [])),
  );
  const nodePackages = all.filter((p) => declaresNode(p.manifest));

  test("the walk read every workspace manifest", () => {
    expect(all.length).toBeGreaterThanOrEqual(300);
    expect(workspace.size).toBe(all.length);
  });

  test("every package that declares engines.node holds all four rules", () => {
    const problems = nodePackages.flatMap((p) =>
      nodePackageProblems(p.dir, workspace).map((problem) => `${p.manifest.name}: ${problem}`),
    );
    expect(problems).toEqual([]);
  }, 60_000); // one program check per Node package

  test("which packages declare engines.node: none yet, so the first joins on purpose", () => {
    expect(nodePackages.map((p) => p.manifest.name)).toEqual([]);
  });
});

describe("each rule reports its own defect on a planted package", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-packages-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const BUN_LIB: Manifest = { name: "@crewhaus/zz-bun-lib", engines: { bun: ">=1.3.14" } };
  const NODE_LIB: Manifest = { name: "@crewhaus/zz-node-lib", engines: { node: ">=20" } };
  const workspace = new Map<string, Manifest>([
    [BUN_LIB.name as string, BUN_LIB],
    [NODE_LIB.name as string, NODE_LIB],
  ]);

  const NODENEXT = { module: "NodeNext", moduleResolution: "nodenext" };

  function plant(
    name: string,
    opts: {
      source?: string;
      compilerOptions?: Record<string, string>;
      dependencies?: Record<string, string>;
    } = {},
  ): string[] {
    const root = join(dir, name);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: `@crewhaus/zz-${name}`,
        type: "module",
        engines: { node: ">=20", bun: ">=1.3.14" },
        exports: { ".": "./src/index.ts" },
        ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
      }),
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: opts.compilerOptions ?? NODENEXT, include: ["src/**/*"] }),
    );
    writeFileSync(join(root, "src", "other.ts"), "export const a = 1;\n");
    writeFileSync(
      join(root, "src", "index.ts"),
      opts.source ?? 'export { a } from "./other.js";\n',
    );
    return nodePackageProblems(root, workspace);
  }

  test("a clean package reports nothing, so each defect below is the plant's", () => {
    expect(
      plant("clean", { dependencies: { "@crewhaus/zz-node-lib": "workspace:*", zod: "^3.0.0" } }),
    ).toEqual([]);
  }, 20_000);

  test("Bun.file", () => {
    const problems = plant("bun-api", { source: 'export const f = Bun.file("x");\n' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("types: src/index.ts: Cannot find name 'Bun'");
  }, 20_000);

  test("an extensionless relative import", () => {
    const problems = plant("extensionless", { source: 'export { a } from "./other";\n' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("types: src/index.ts:");
    expect(problems[0]).toContain("explicit file extensions");
  }, 20_000);

  test("a Bundler tsconfig", () => {
    const problems = plant("bundler", {
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
    });
    expect(problems).toEqual([
      "tsconfig: module is ESNext and moduleResolution is Bundler; both must be NodeNext (override tsconfig.base.json's Bundler in the package's own compilerOptions)",
    ]);
  }, 20_000);

  test("an internal dependency that is not a Node package", () => {
    const problems = plant("closure", { dependencies: { "@crewhaus/zz-bun-lib": "workspace:*" } });
    expect(problems).toEqual([
      "closure: dependencies names @crewhaus/zz-bun-lib, which does not declare engines.node, so plain Node cannot load it",
    ]);
  }, 20_000);

  test("a Bun-only dependency that ships", () => {
    const problems = plant("bun-types", { dependencies: { "bun-types": "^1.2.0" } });
    expect(problems).toEqual(["bun-only: dependencies names bun-types, which only Bun uses"]);
  }, 20_000);
});
