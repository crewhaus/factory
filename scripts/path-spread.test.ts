/**
 * No shipped code passes a variable number of arguments to `path.join` or
 * `path.resolve`.
 *
 * Bun (1.3.14, the floor) keeps only (argument count mod 65,536) of the
 * arguments to `path.join` and `path.resolve`, `posix` and `win32` alike, and
 * says nothing: `path.join("/r", ...names)` with 65,535 names is ".", with
 * 65,536 it is "/r", with 65,537 it is "/r/a". 0.7.1's permission gate
 * (runtime-core path-canonical.ts) and the 40 other copies of
 * `resolveLocation` (the tool packages and crawler) joined the names below a
 * path's deepest existing ancestor that way, one argument per name, so a path
 * 65,536 names below an existing file came back as that file. StateImport's
 * `statePath` and tool-deploy's `_tenants` probe did the same with a count
 * the caller chose. Each now joins the names into one string first.
 *
 * The guard reads every non-test source with TypeScript's parser and fails on
 * a spread (or `.apply`, or `Reflect.apply`) into a path join or resolve,
 * whatever it is called locally, and on a spread into any `.join(...)` or
 * `.resolve(...)` whose receiver it cannot see (a seam holding `path.join`,
 * say). A spread of an array literal of fixed length passes, and so does each
 * constant list below, whose declaration is checked to be a literal tuple.
 *
 * The rewrites are held to the spread they replaced: one string joined with
 * the separator gives the same path, on every list below the boundary, under
 * the condition each site meets (see "the rewrites" below).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { isTestOnly } from "./test-only";

const ROOT = path.dirname(import.meta.dir);

/**
 * Constant segment lists a spread may name, and the module that declares
 * each. The declaration must be `export const NAME = ["…", …] as const`.
 */
const CONSTANT_SEGMENT_LISTS: Readonly<Record<string, string>> = {
  MANAGER_SETTINGS_SEGMENTS: "packages/harness-supervisor/src/manager-settings.ts",
  RUN_DIR_SEGMENTS: "packages/harness-supervisor/src/types.ts",
  WORKFLOWS_DIR_SEGMENTS: "packages/hangar-server/src/scaffolded-workflows.ts",
};

const PATH_MODULES = new Set([
  "node:path",
  "path",
  "node:path/posix",
  "path/posix",
  "node:path/win32",
  "path/win32",
]);
const VARIADIC = new Set(["join", "resolve"]);

type Site = { readonly line: number; readonly call: string; readonly spread: string };
type Scan = {
  /** Calls recognised as a path join or resolve, spread or not. */
  readonly pathCalls: number;
  /** Spreads into one that no rule admits. */
  readonly refused: Site[];
  /** Spreads of a listed constant, by name. */
  readonly constants: string[];
};

/** `require("node:path")`, `import("node:path")`, or either awaited. */
function isPathRequire(e: ts.Expression): boolean {
  const call = ts.isAwaitExpression(e) ? e.expression : e;
  return (
    ts.isCallExpression(call) &&
    ((ts.isIdentifier(call.expression) && call.expression.text === "require") ||
      call.expression.kind === ts.SyntaxKind.ImportKeyword) &&
    call.arguments.length === 1 &&
    ts.isStringLiteralLike(call.arguments[0] as ts.Expression) &&
    PATH_MODULES.has((call.arguments[0] as ts.StringLiteralLike).text)
  );
}

function memberName(e: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  return undefined;
}

function receiver(e: ts.Expression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)
    ? e.expression
    : undefined;
}

/** The spreads into path joins and resolves in one source file. */
function scanSpreads(fileName: string, text: string): Scan {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const modules = new Set<string>(); // names bound to node:path, or its posix / win32
  const fns = new Set<string>(); // names bound to its join or resolve

  const isModule = (e: ts.Expression): boolean => {
    if (ts.isIdentifier(e)) return modules.has(e.text);
    if (isPathRequire(e)) return true;
    const name = memberName(e);
    const of = receiver(e);
    return (name === "posix" || name === "win32") && of !== undefined && isModule(of);
  };
  const isPathFn = (e: ts.Expression): boolean => {
    if (ts.isIdentifier(e)) return fns.has(e.text);
    const name = memberName(e);
    const of = receiver(e);
    return name !== undefined && VARIADIC.has(name) && of !== undefined && isModule(of);
  };

  // Bindings: imports, then aliases to a fixed point (`const p = path.posix`).
  for (const st of sf.statements) {
    if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteral(st.moduleReference.expression) &&
      PATH_MODULES.has(st.moduleReference.expression.text)
    ) {
      modules.add(st.name.text); // import path = require("node:path")
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (!PATH_MODULES.has(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (clause?.name !== undefined) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (VARIADIC.has(imported)) fns.add(el.name.text);
        if (imported === "posix" || imported === "win32" || imported === "default") {
          modules.add(el.name.text);
        }
      }
    }
  }
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer !== undefined) declarations.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (let grew = true; grew; ) {
    const before = modules.size + fns.size;
    for (const d of declarations) {
      const init = d.initializer as ts.Expression;
      if (ts.isIdentifier(d.name)) {
        if (isModule(init)) modules.add(d.name.text);
        if (isPathFn(init)) fns.add(d.name.text);
      } else if (ts.isObjectBindingPattern(d.name) && isModule(init)) {
        for (const el of d.name.elements) {
          const key = el.propertyName ?? el.name;
          if (!ts.isIdentifier(key) || !ts.isIdentifier(el.name)) continue;
          if (VARIADIC.has(key.text)) fns.add(el.name.text);
          if (key.text === "posix" || key.text === "win32") modules.add(el.name.text);
        }
      }
    }
    grew = modules.size + fns.size > before;
  }

  /** A spread whose length is fixed in the source. */
  const fixed = (e: ts.Expression, constants: string[]): boolean => {
    if (ts.isArrayLiteralExpression(e)) return !e.elements.some(ts.isSpreadElement);
    if (ts.isIdentifier(e) && Object.hasOwn(CONSTANT_SEGMENT_LISTS, e.text)) {
      constants.push(e.text);
      return true;
    }
    return false;
  };

  let pathCalls = 0;
  const refused: Site[] = [];
  const constants: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const refuse = (call: ts.CallExpression, spread: ts.Expression) =>
    refused.push({
      line: line(call),
      call: call.expression.getText(sf),
      spread: spread.getText(sf).replace(/\s+/g, " "),
    });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = memberName(callee);
      const of = receiver(callee);
      if (isPathFn(callee) || (name !== undefined && VARIADIC.has(name))) {
        // A path join or resolve, or a `.join`/`.resolve` on a receiver this
        // cannot see: every spread argument must have a fixed length.
        if (isPathFn(callee)) pathCalls += 1;
        for (const arg of n.arguments) {
          if (ts.isSpreadElement(arg) && !fixed(arg.expression, constants)) {
            refuse(n, arg.expression);
          }
        }
      } else if (name === "apply" && of !== undefined && isPathFn(of)) {
        pathCalls += 1;
        const list = n.arguments[1];
        if (list !== undefined && !fixed(list, constants)) refuse(n, list);
      } else if (name === "call" && of !== undefined && isPathFn(of)) {
        pathCalls += 1;
        for (const arg of n.arguments) {
          if (ts.isSpreadElement(arg) && !fixed(arg.expression, constants)) {
            refuse(n, arg.expression);
          }
        }
      } else if (
        name === "apply" &&
        of !== undefined &&
        ts.isIdentifier(of) &&
        of.text === "Reflect" &&
        n.arguments[0] !== undefined &&
        isPathFn(n.arguments[0])
      ) {
        pathCalls += 1;
        const list = n.arguments[2];
        if (list !== undefined && !fixed(list, constants)) refuse(n, list);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { pathCalls, refused, constants };
}

/** Shipped sources: every non-test module under a package's or app's src/. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(abs);
      } else if (/\.(tsx?|mts|cts|mjs|cjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        if (!isTestOnly(path.relative(ROOT, abs))) out.push(abs);
      }
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(path.join(ROOT, group)).sort()) {
      const src = path.join(ROOT, group, name, "src");
      if (existsSync(src)) walk(src);
    }
  }
  return out;
}

describe("no shipped source spreads a list into path.join or path.resolve", () => {
  // Read ONCE and shared: every source, a couple of seconds here and many
  // times that on a CI runner, so each test declares a budget (house rule).
  let memo:
    | { files: number; pathCalls: number; refused: string[]; constants: Map<string, number> }
    | undefined;
  const sweep = () => {
    if (memo !== undefined) return memo;
    const files = shippedSources();
    let pathCalls = 0;
    const refused: string[] = [];
    const constants = new Map<string, number>();
    for (const file of files) {
      const scan = scanSpreads(file, readFileSync(file, "utf8"));
      pathCalls += scan.pathCalls;
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      for (const s of scan.refused) refused.push(`${rel}:${s.line} ${s.call}(…${s.spread})`);
      for (const name of scan.constants) constants.set(name, (constants.get(name) ?? 0) + 1);
    }
    memo = { files: files.length, pathCalls, refused, constants };
    return memo;
  };

  test("the sweep reads what it is meant to guard", () => {
    // Over a thousand sources and well over a thousand path joins and
    // resolves: a sweep that found a handful would be reading the wrong
    // directory or failing to recognise the calls.
    const { files, pathCalls } = sweep();
    expect(files).toBeGreaterThan(1000);
    expect(pathCalls).toBeGreaterThan(1000);
  }, 60_000);

  test("no spread of a list whose length is not fixed in the source", () => {
    expect(sweep().refused).toEqual([]);
  }, 60_000);

  test("each listed constant is spread somewhere, and is declared a literal tuple", () => {
    expect([...sweep().constants.keys()].sort()).toEqual(
      Object.keys(CONSTANT_SEGMENT_LISTS).sort(),
    );
    for (const [name, file] of Object.entries(CONSTANT_SEGMENT_LISTS)) {
      const sf = ts.createSourceFile(
        file,
        readFileSync(path.join(ROOT, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      let literal: string[] | undefined;
      const find = (n: ts.Node): void => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === name &&
          n.initializer !== undefined &&
          ts.isAsExpression(n.initializer) &&
          n.initializer.type.getText(sf) === "const" &&
          ts.isArrayLiteralExpression(n.initializer.expression) &&
          n.initializer.expression.elements.every(ts.isStringLiteral) &&
          (n.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
          literal = n.initializer.expression.elements.map((e) => (e as ts.StringLiteral).text);
        }
        ts.forEachChild(n, find);
      };
      find(sf);
      expect({ name, literal: literal !== undefined && literal.length > 0 }).toEqual({
        name,
        literal: true,
      });
    }
  }, 60_000);
});

describe("the guard sees every way of spelling the call", () => {
  const refusedIn = (text: string) => scanSpreads("fixture.ts", text).refused.map((s) => s.line);

  test("each import, alias and call form is recognised", () => {
    const text = [
      'import * as path from "node:path";', // 1
      'import p2 from "path";', // 2
      'import { join as joinPath, resolve, posix, win32 as w } from "node:path";', // 3
      'const req = require("node:path");', // 4
      'const { join: j2 } = require("path");', // 5
      "const j3 = path.join;", // 6
      "const { resolve: r2 } = p2;", // 7
      "const px = path.posix;", // 8
      "path.join(a, ...xs);", // 9
      "p2.resolve(...xs);", // 10
      "joinPath(a, ...xs);", // 11
      "resolve(...xs);", // 12
      "posix.join(a, ...xs);", // 13
      "w.resolve(a, ...xs);", // 14
      "path.win32.join(a, ...xs);", // 15
      "req.join(a, ...xs);", // 16
      "j2(a, ...xs);", // 17
      "j3(a, ...xs);", // 18
      "r2(a, ...xs);", // 19
      "px.join(a, ...xs);", // 20
      'path["join"](a, ...xs);', // 21
      "path.join.apply(null, xs);", // 22
      "path.join.call(null, a, ...xs);", // 23
      "Reflect.apply(path.resolve, null, xs);", // 24
      "ops.join(cur, ...tail);", // 25: a seam holding path.join
      "function under(root: string, ...parts: string[]) { return path.join(root, ...parts); }", // 26
      'path.join(a, ...rel.split("/"));', // 27
      'import p3 = require("node:path");', // 28
      "const { resolve: r3 } = p3; r3(a, ...xs);", // 29: only the binding says it is path's
      'const p4 = await import("node:path");', // 30
      "p4.resolve(a, ...xs);", // 31
      'const { join: j4 } = await import("path");', // 32
      "j4(a, ...xs);", // 33
    ].join("\n");
    expect(refusedIn(text)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 31, 33,
    ]);
  });

  test("a fixed-length spread, a joined string and an unrelated spread pass", () => {
    const text = [
      'import * as path from "node:path";',
      'path.join(a, ...["x", "y"], b);',
      "path.join(a, ...RUN_DIR_SEGMENTS);",
      "path.join(a, tail.join(path.sep));",
      'path.join.apply(null, ["a", "b"]);',
      "Math.max(...xs);",
      'const s = [...xs].join("/");',
      "list.push(...xs);",
      "function join(...xs: string[]) { return xs.length; }",
    ].join("\n");
    const scan = scanSpreads("fixture.ts", text);
    expect(scan.refused).toEqual([]);
    expect(scan.constants).toEqual(["RUN_DIR_SEGMENTS"]);
    // An array literal that itself spreads a list has no fixed length.
    expect(refusedIn('import * as path from "node:path";\npath.join(a, ...[...xs]);')).toEqual([2]);
  });

  test("a spread into a local function named like one is not mistaken for path's", () => {
    // `resolve` here is a promise's; it takes one argument, and it is not
    // node:path's, so the call is not a path call.
    expect(refusedIn("new Promise((resolve) => resolve(...xs));")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the rewrites
// ---------------------------------------------------------------------------

/**
 * What each site now does, next to the spread it replaced, for posix and
 * win32, on seeded lists below the boundary. Every base is non-empty, as at
 * every site (win32's UNC handling looks at the first non-empty argument).
 *
 * - ONE STRING (`resolveLocation`'s walk, plugin-export, the `_tenants`
 *   probe): `join(b, list.join(sep))`. The concatenation `join` normalises is
 *   the same apart from runs of separators where an empty name was, which
 *   normalising collapses, except at the very end: a trailing empty name
 *   leaves a trailing separator. So the list may not end in "" unless it is
 *   all there is. A walk's last name is the target's basename, never empty.
 * - FILTERED (`statePath`, whose segments are the caller's): empty names
 *   dropped first, as `join` drops them. No condition.
 * - WHOLE (`...rel.split("/")` sites): `join(b, rel)`, `rel` not ending in
 *   "/". Each such `rel` ends in a file or directory name.
 */
describe("the rewrites give what the spread gave", () => {
  // mulberry32: seeded, so a failure names a case that can be replayed.
  const rng = (seed: number) => {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const NAMES = [
    "a",
    "bc",
    "x.y",
    "...",
    "~",
    "-",
    " ",
    "a b",
    "ü",
    "e\u0301",
    "日本語",
    "😀",
    "",
    "",
    ".",
    "..",
    "/",
    "//",
    "a/",
    "/a",
    "a/b",
    "./a",
    "a/..",
    "../a",
    "\\",
    "a\\b",
    "\\a",
    "a\\",
    "C:",
    "C:\\x",
    "C:/x",
    "\\\\srv\\share",
    "//srv/share",
    "a:b",
  ];
  const PLATFORMS = [
    { impl: path.posix, bases: ["/r", "/r/", "/", "/r/s", "r", "./r", "../r", "/r/日本", "/r//s"] },
    {
      impl: path.win32,
      bases: [
        "C:\\r",
        "C:\\",
        "C:/r",
        "c:\\r\\",
        "\\\\srv\\share\\r",
        "\\\\srv\\share",
        "r",
        "C:r",
        "\\r",
      ],
    },
  ] as const;
  type Impl = (typeof PLATFORMS)[number]["impl"];

  const lists = function* (seed: number, count: number) {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T;
    for (let i = 0; i < count; i++) {
      const length = next() < 0.9 ? Math.floor(next() * 9) : Math.floor(next() * 400);
      yield Array.from({ length }, () => pick(NAMES));
    }
  };
  // Long lists, still below the boundary: the base is the 65,535th argument.
  const LONG = [1_000, 10_000, 65_533, 65_534];

  test.each(PLATFORMS.map((p) => [p.impl === path.posix ? "posix" : "win32", p] as const))(
    "%s: one string, filtered, whole",
    (_label, { impl, bases }) => {
      const spread = (b: string, list: readonly string[]) => (impl as Impl).join(b, ...list);
      let oneString = 0;
      let filtered = 0;
      let whole = 0;
      let mismatched = 0;
      const shown: unknown[] = [];
      const differ = (detail: Record<string, unknown>) => {
        mismatched += 1;
        if (shown.length < 5) shown.push(detail);
      };
      const check = (rule: string, b: string, list: readonly string[], got: string) => {
        const want = spread(b, list);
        if (got !== want) differ({ rule, b, list, got, want });
      };
      for (const [k, b] of bases.entries()) {
        for (const list of lists(7919 * (k + 1) + impl.sep.charCodeAt(0), 4_000)) {
          const filteredJoin = impl.join(b, list.filter((s) => s !== "").join(impl.sep));
          check("filtered", b, list, filteredJoin);
          filtered += 1;
          if (list.length <= 1 || list[list.length - 1] !== "") {
            check("one string", b, list, impl.join(b, list.join(impl.sep)));
            oneString += 1;
          }
          const rel = list.join("/");
          if (!rel.endsWith("/")) {
            const want = impl.join(b, ...rel.split("/"));
            const got = impl.join(b, rel);
            if (got !== want) differ({ rule: "whole", b, rel, got, want });
            whole += 1;
          }
        }
        for (const n of LONG) {
          // n names, the last one not empty.
          const list = Array.from({ length: n }, (_, i) =>
            i === n - 1 ? "z" : (NAMES[i % NAMES.length] as string),
          );
          check("one string", b, list, impl.join(b, list.join(impl.sep)));
          check("filtered", b, list, impl.join(b, list.filter((s) => s !== "").join(impl.sep)));
          oneString += 1;
          filtered += 1;
        }
      }
      expect({ mismatched, shown }).toEqual({ mismatched: 0, shown: [] });
      // Enough of each, so none of the three passes for want of cases.
      expect(Math.min(oneString, filtered, whole)).toBeGreaterThan(20_000);
    },
    60_000,
  );

  test("why the condition matters: a trailing empty name is a trailing separator", () => {
    expect(path.posix.join("/r", "a", "")).toBe("/r/a");
    expect(path.posix.join("/r", ["a", ""].join("/"))).toBe("/r/a/");
    expect(path.posix.join("/r", ["a", ""].filter((s) => s !== "").join("/"))).toBe("/r/a");
  });

  test("at and past the boundary the one-string join keeps every name", () => {
    for (const n of [65_535, 65_536, 65_537]) {
      const names = Array.from({ length: n }, () => "a");
      const want = `/r/${names.join("/")}`;
      const oneString = path.posix.join("/r", names.join(path.posix.sep));
      const filtered = path.posix.join("/r", names.filter((s) => s !== "").join(path.posix.sep));
      const whole = path.posix.join("/r", names.join("/"));
      expect({ n, lengths: [oneString.length, filtered.length, whole.length] }).toEqual({
        n,
        lengths: [want.length, want.length, want.length],
      });
      expect([oneString, filtered, whole].every((s) => s === want)).toBe(true);
    }
  });
});
