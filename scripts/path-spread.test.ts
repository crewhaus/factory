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
 * The guard parses every non-test source, one file at a time, and fails on a
 * spread (or `.apply`, `.call` or `Reflect.apply`) into node:path's join or
 * resolve. Within the file it follows them from the import, `require`,
 * `import()`, `createRequire` or `getBuiltinModule` of a literal module name,
 * through `posix` and `win32`, through aliases made by declaration, default
 * value, assignment or destructuring (nested too), with each name looked up in
 * its scope, through `.bind`, and through parentheses, the comma operator,
 * `as`, `satisfies`, `!`, `?:`, `||`, `??` and `&&`. An object that holds one
 * under its own name (a seam: `{ join: path.join }`) is followed like
 * node:path itself. A path function or module that goes anywhere else (into
 * an object or array, a call's argument, a return, a class field, a property,
 * an export, `export … from "node:path"` among them) fails where it goes, so
 * none leaves the file it was taken in unseen, and a file that imports a
 * `join` from the workspace imports one that is not node:path's. What the
 * guard cannot see, it judges by name: a spread into any `.join(...)` or
 * `.resolve(...)` fails, and so does one into a `join` or `resolve` taken from
 * an object it cannot see (destructured or aliased) or imported from a package
 * outside the workspace.
 *
 * A spread of an array literal of fixed length passes, and so does each
 * constant list below where the name is its listed declaration (checked to be
 * a literal tuple) or an import that leads there.
 *
 * Not covered: a module named by a string the code computes (`require(name)`),
 * and a `join` known only by name that is handed on under another name
 * (`[ops.join]`).
 *
 * The rewrites are held to the spread they replaced: one string joined with
 * the separator gives the same path, on every list below the boundary, under
 * the condition each site meets (see "the rewrites" below).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
/** node:path's members that are node:path again. */
const SUBMODULES = new Set(["posix", "win32", "default"]);
/** The key of `...rest` in a destructuring. */
const REST = "...";

// What an expression may hold, as flags.
const MODULE = 1; // node:path, or its posix or win32
const PATH_FN = 2; // node:path's join or resolve
const NAMED = 4; // a `join` or `resolve` of something the guard cannot see
const REQUIRE = 8; // `require`, or what `createRequire` made

const K = ts.SyntaxKind;
const LOGICAL = new Set([K.BarBarToken, K.QuestionQuestionToken, K.AmpersandAmpersandToken]);
const ASSIGNING = new Set([
  K.EqualsToken,
  K.BarBarEqualsToken,
  K.QuestionQuestionEqualsToken,
  K.AmpersandAmpersandEqualsToken,
]);
/** Operators that read a value without passing it on. */
const COMPARING = new Set([
  K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsEqualsToken,
  K.EqualsEqualsToken,
  K.ExclamationEqualsToken,
  K.InstanceOfKeyword,
  K.InKeyword,
]);

/** Where a path function or module can go that the guard does not follow, by the parent's kind. */
const PLACES: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [K.CallExpression, "an argument"],
  [K.NewExpression, "an argument"],
  [K.ArrayLiteralExpression, "an array"],
  [K.PropertyAssignment, "an object"],
  [K.ShorthandPropertyAssignment, "an object"],
  [K.SpreadAssignment, "an object"],
  [K.SpreadElement, "a spread"],
  [K.ReturnStatement, "a return"],
  [K.ArrowFunction, "a return"],
  [K.PropertyDeclaration, "a class field"],
  [K.ExportAssignment, "an export"],
  [K.JsxExpression, "a JSX attribute"],
  [K.YieldExpression, "a yield"],
  [K.ForOfStatement, "a loop"],
  [K.ForInStatement, "a loop"],
  [K.TemplateSpan, "a template"],
]);

type Site = { readonly line: number; readonly what: string };
type Scan = {
  /** Calls recognised as node:path's join or resolve, spread or not. */
  readonly pathCalls: number;
  /** Spreads no rule admits, and path functions and modules gone where the guard cannot follow. */
  readonly refused: Site[];
  /** Spreads of a listed constant, by name. */
  readonly constants: string[];
};
/**
 * The ROOT-relative module that declares `name`, imported through
 * `specifier` by the module `from`, following re-exports; undefined when it
 * cannot tell.
 */
type Origin = (from: string, specifier: string, name: string) => string | undefined;

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression;
const isAccess = (n: ts.Node): n is Access =>
  ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);

/** The member an access names, or undefined when the key is computed. */
function memberName(e: Access): string | undefined {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  const key = e.argumentExpression;
  return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  }
  return name.text;
}

/** What a wrapper stands for: parentheses, `as`, `satisfies`, `<T>`, `!`, `await`, a comma's right. */
function inner(e: ts.Expression): ts.Expression {
  let at = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(at) ||
      ts.isAsExpression(at) ||
      ts.isSatisfiesExpression(at) ||
      ts.isTypeAssertionExpression(at) ||
      ts.isNonNullExpression(at) ||
      ts.isAwaitExpression(at)
    ) {
      at = at.expression;
    } else if (ts.isBinaryExpression(at) && at.operatorToken.kind === K.CommaToken) {
      at = at.right;
    } else {
      return at;
    }
  }
}

/** Each value an expression may take: both arms of `?:`, `||`, `??`, `&&`, an assignment's right. */
function outcomes(e: ts.Expression): ts.Expression[] {
  const at = inner(e);
  if (ts.isConditionalExpression(at)) return [...outcomes(at.whenTrue), ...outcomes(at.whenFalse)];
  if (ts.isBinaryExpression(at)) {
    const op = at.operatorToken.kind;
    if (op === K.EqualsToken) return outcomes(at.right);
    if (LOGICAL.has(op) || ASSIGNING.has(op)) return [...outcomes(at.left), ...outcomes(at.right)];
  }
  return [at];
}

/** What `x[key]` may hold when `x` may hold `of`; an undefined key is a computed one. */
function member(of: number, key: string | undefined): number {
  let flags = 0;
  if ((of & MODULE) !== 0) {
    if (key === undefined) flags |= MODULE | PATH_FN;
    else if (key === REST || SUBMODULES.has(key)) flags |= MODULE;
    else if (VARIADIC.has(key)) flags |= PATH_FN;
  }
  if (key !== undefined && VARIADIC.has(key) && (flags & PATH_FN) === 0) flags |= NAMED;
  return flags;
}

/** The strings of `const NAME = ["…", …] as const`, or undefined for any other declaration. */
function literalTuple(d: ts.VariableDeclaration): string[] | undefined {
  const init = d.initializer;
  if (
    init === undefined ||
    !ts.isIdentifier(d.name) ||
    !ts.isVariableDeclarationList(d.parent) ||
    (d.parent.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isAsExpression(init) ||
    !ts.isTypeReferenceNode(init.type) ||
    !ts.isIdentifier(init.type.typeName) ||
    init.type.typeName.text !== "const" ||
    !ts.isArrayLiteralExpression(init.expression) ||
    init.expression.elements.length === 0 ||
    !init.expression.elements.every(ts.isStringLiteral)
  ) {
    return undefined;
  }
  return init.expression.elements.map((e) => (e as ts.StringLiteral).text);
}

/** The spreads into path joins and resolves in one source file, `fileName` ROOT-relative. */
function scanSpreads(fileName: string, text: string, origin: Origin = () => undefined): Scan {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // Scopes: each declared name, filed under the node whose scope holds it.
  const scopes = new Map<ts.Node, Map<string, ts.Identifier>>();
  const fileUnder = (scope: ts.Node, name: ts.BindingName | undefined): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      const names = scopes.get(scope) ?? new Map<string, ts.Identifier>();
      scopes.set(scope, names);
      if (!names.has(name.text)) names.set(name.text, name);
      return;
    }
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) fileUnder(scope, el.name);
  };
  const functionScope = (n: ts.Node): ts.Node => {
    let at = n.parent;
    while (
      !ts.isSourceFile(at) &&
      !ts.isFunctionLike(at) &&
      !ts.isClassStaticBlockDeclaration(at)
    ) {
      at = at.parent;
    }
    return at;
  };
  const blockScope = (statement: ts.Node): ts.Node => {
    const p = statement.parent;
    return ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.parent : p;
  };
  /** The declaration a name refers to where it is used; undefined for a global. */
  const declOf = (id: ts.Identifier): ts.Identifier | undefined => {
    for (let at: ts.Node | undefined = id.parent; at !== undefined; at = at.parent) {
      const d = scopes.get(at)?.get(id.text);
      if (d !== undefined) return d;
    }
    return undefined;
  };

  // Bindings that may carry a value from one name to another.
  type Binding = { target: ts.Node; value: ts.Expression | undefined; declared: boolean };
  const bindings: Binding[] = [];
  const index = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      const list = n.parent;
      let scope: ts.Node = list.parent; // a for, for-in or for-of
      if (ts.isCatchClause(list)) scope = list;
      else if ((list.flags & ts.NodeFlags.BlockScoped) === 0) scope = functionScope(list);
      else if (ts.isVariableStatement(list.parent)) scope = blockScope(list.parent);
      fileUnder(scope, n.name);
    } else if (ts.isParameter(n)) {
      fileUnder(n.parent, n.name);
    } else if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n)) {
      fileUnder(blockScope(n), n.name);
    } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) {
      fileUnder(blockScope(n), n.name);
    } else if (ts.isFunctionExpression(n) || ts.isClassExpression(n)) {
      fileUnder(n, n.name);
    } else if (ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isImportSpecifier(n)) {
      fileUnder(sf, n.name);
    } else if (ts.isImportEqualsDeclaration(n)) {
      fileUnder(sf, n.name);
    }
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
      n.initializer !== undefined
    ) {
      bindings.push({ target: n.name, value: n.initializer, declared: true });
    } else if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && !ts.isIdentifier(n.name)) {
      // A pattern with no value in sight (a parameter, a for-of): its
      // `join` and `resolve` are still judged by name.
      bindings.push({ target: n.name, value: undefined, declared: true });
    } else if (ts.isBinaryExpression(n) && ASSIGNING.has(n.operatorToken.kind)) {
      bindings.push({ target: n.left, value: n.right, declared: false });
    } else if (ts.isShorthandPropertyAssignment(n) && n.objectAssignmentInitializer !== undefined) {
      bindings.push({ target: n.name, value: n.objectAssignmentInitializer, declared: false });
    }
    ts.forEachChild(n, index);
  };
  index(sf);

  const modules = new Set<ts.Identifier>();
  const fns = new Set<ts.Identifier>();
  const named = new Set<ts.Identifier>();
  const requirers = new Set<ts.Identifier>();
  const names = new Set<string>(); // every name in the four, to pass over the rest quickly
  const add = (d: ts.Identifier, flags: number): void => {
    if ((flags & MODULE) !== 0) modules.add(d);
    if ((flags & PATH_FN) !== 0) fns.add(d);
    if ((flags & NAMED) !== 0) named.add(d);
    if ((flags & REQUIRE) !== 0) requirers.add(d);
    if (flags !== 0) names.add(d.text);
  };
  const isGlobal = (e: ts.Expression, name: string): boolean => {
    const at = inner(e);
    return ts.isIdentifier(at) && at.text === name && declOf(at) === undefined;
  };

  /** What one expression, wrappers removed, may hold. */
  const holds = (e: ts.Expression): number => {
    if (ts.isIdentifier(e)) {
      if (!names.has(e.text)) return e.text === "require" && declOf(e) === undefined ? REQUIRE : 0;
      const d = declOf(e);
      if (d === undefined) return e.text === "require" ? REQUIRE : 0;
      return (
        (modules.has(d) ? MODULE : 0) |
        (fns.has(d) ? PATH_FN : 0) |
        (named.has(d) ? NAMED : 0) |
        (requirers.has(d) ? REQUIRE : 0)
      );
    }
    if (isAccess(e)) return member(flagsOf(e.expression), memberName(e));
    if (ts.isObjectLiteralExpression(e)) return holdsOwn(e) ? MODULE : 0;
    if (!ts.isCallExpression(e)) return 0;
    const callee = inner(e.expression);
    const [arg, ...more] = e.arguments;
    if (
      arg !== undefined &&
      more.length === 0 &&
      ts.isStringLiteralLike(arg) &&
      PATH_MODULES.has(arg.text) &&
      (callee.kind === K.ImportKeyword ||
        (isAccess(callee) && ["getBuiltinModule", "require"].includes(memberName(callee) ?? "")) ||
        (flagsOf(callee) & REQUIRE) !== 0)
    ) {
      return MODULE;
    }
    const name = isAccess(callee) ? memberName(callee) : ts.isIdentifier(callee) ? callee.text : "";
    if (name === "createRequire") return REQUIRE;
    if (name === "bind" && isAccess(callee)) return flagsOf(callee.expression) & (PATH_FN | NAMED);
    return 0;
  };
  const flagsOf = (e: ts.Expression | undefined): number => {
    if (e === undefined) return 0;
    let flags = 0;
    for (const at of outcomes(e)) flags |= holds(at);
    return flags;
  };
  /**
   * An object holding node:path's join or resolve under that same name (a
   * seam: `{ join: path.join, dirname: path.dirname }`) is followed like
   * node:path itself: what is called through it, and where it goes.
   */
  const holdsOwn = (o: ts.ObjectLiteralExpression): boolean =>
    o.properties.some((p) =>
      ts.isPropertyAssignment(p)
        ? VARIADIC.has(propertyKey(p.name) ?? "") && (flagsOf(p.initializer) & PATH_FN) !== 0
        : ts.isShorthandPropertyAssignment(p) &&
          VARIADIC.has(p.name.text) &&
          (holds(p.name) & PATH_FN) !== 0,
    );

  // A path function or module bound somewhere bind() does not follow.
  const lost = new Map<ts.Node, string>();
  const bind = (target: ts.Node, flags: number, declared: boolean): void => {
    if (ts.isIdentifier(target)) {
      const d = declared ? target : declOf(target);
      if (d !== undefined) add(d, flags);
      else if ((flags & (MODULE | PATH_FN)) !== 0) lost.set(target, "a global");
    } else if (ts.isObjectBindingPattern(target)) {
      for (const el of target.elements) {
        const key =
          el.dotDotDotToken !== undefined
            ? REST
            : el.propertyName !== undefined
              ? propertyKey(el.propertyName)
              : ts.isIdentifier(el.name)
                ? el.name.text
                : undefined;
        bind(el.name, member(flags, key), true);
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const p of target.properties) {
        if (ts.isShorthandPropertyAssignment(p)) {
          bind(p.name, member(flags, p.name.text), false);
        } else if (ts.isPropertyAssignment(p)) {
          // `{ key: target = fallback }`: the fallback is a binding of its own.
          const to =
            ts.isBinaryExpression(p.initializer) &&
            p.initializer.operatorToken.kind === K.EqualsToken
              ? p.initializer.left
              : p.initializer;
          bind(to, member(flags, propertyKey(p.name)), false);
        } else if (ts.isSpreadAssignment(p)) {
          bind(p.expression, member(flags, REST), false);
        }
      }
    } else if (ts.isParenthesizedExpression(target)) {
      bind(target.expression, flags, false);
    } else if (isAccess(target) && (flags & (MODULE | PATH_FN)) !== 0) {
      // Into a seam under its own name is followed; anywhere else is not.
      const own = VARIADIC.has(memberName(target) ?? "") && (flags & MODULE) === 0;
      if (!own || (flagsOf(target.expression) & MODULE) === 0) lost.set(target, "a property");
    }
  };

  // Imports first, then every binding, to a fixed point.
  for (const st of sf.statements) {
    if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteral(st.moduleReference.expression) &&
      PATH_MODULES.has(st.moduleReference.expression.text)
    ) {
      add(st.name, MODULE); // import path = require("node:path")
    }
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const isPath = PATH_MODULES.has(from);
    // A package from outside the workspace may hand on node:path's own functions.
    const outside = !isPath && !from.startsWith(".") && !from.startsWith("@crewhaus/");
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (isPath && clause.name !== undefined) add(clause.name, MODULE);
    const bound = clause.namedBindings;
    if (isPath && bound !== undefined && ts.isNamespaceImport(bound)) add(bound.name, MODULE);
    if (bound !== undefined && ts.isNamedImports(bound) && (isPath || outside)) {
      for (const el of bound.elements) {
        if (el.isTypeOnly) continue;
        add(el.name, member(isPath ? MODULE : 0, (el.propertyName ?? el.name).text));
      }
    }
  }
  const total = () => modules.size + fns.size + named.size + requirers.size;
  for (let grew = true; grew; ) {
    const before = total();
    for (const b of bindings) bind(b.target, flagsOf(b.value), b.declared);
    grew = total() > before;
  }
  // What was lost is judged once every binding is known.
  lost.clear();
  for (const b of bindings) bind(b.target, flagsOf(b.value), b.declared);

  /** A pattern being assigned to, or a name inside one: written, not read. */
  const isTarget = (n: ts.Node): boolean => {
    let at = n;
    for (;;) {
      const p = at.parent;
      if (ts.isPropertyAssignment(p) && p.initializer === at) at = p.parent;
      else if (ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) at = p.parent;
      else if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) at = p;
      else if (ts.isParenthesizedExpression(p)) at = p;
      else if (ts.isBinaryExpression(p) && p.left === at && ASSIGNING.has(p.operatorToken.kind)) {
        return true;
      } else {
        return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === at;
      }
    }
  };
  /** A name used as a value here, rather than declared, written or named in a type. */
  const isReference = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if (ts.isPropertyAccessExpression(p)) return p.expression === id;
    if (ts.isShorthandPropertyAssignment(p)) return !isTarget(p.parent);
    if ("name" in p && p.name === id) return false; // a declaration's or a property's own name
    if ("propertyName" in p && p.propertyName === id) return false;
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isQualifiedName(p)) {
      return false;
    }
    if (isTarget(id)) return false;
    for (let at: ts.Node = p; !ts.isSourceFile(at); at = at.parent) {
      if (ts.isTypeNode(at)) return false;
    }
    return true;
  };
  /** The call that `n`, wrappers removed, is the callee of. */
  const calledAs = (n: ts.Node): boolean => {
    let at = n;
    while (transparent(at.parent, at)) at = at.parent;
    return ts.isCallExpression(at.parent) && at.parent.expression === at;
  };
  /** A parent that passes its child's value straight on as its own. */
  const transparent = (p: ts.Node, at: ts.Node): boolean => {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAwaitExpression(p)
    ) {
      return true;
    }
    if (ts.isConditionalExpression(p)) return p.condition !== at;
    if (!ts.isBinaryExpression(p)) return false;
    const op = p.operatorToken.kind;
    return LOGICAL.has(op) || (p.right === at && (op === K.CommaToken || ASSIGNING.has(op)));
  };
  /**
   * Where a path module or function goes when the guard cannot follow it
   * there; undefined when it can, or when the use only reads it.
   */
  const goesTo = (value: ts.Expression, flags: number): string | undefined => {
    let at: ts.Node = value;
    while (transparent(at.parent, at)) at = at.parent;
    const p = at.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === at) return undefined;
    if (ts.isTaggedTemplateExpression(p) && p.tag === at) return undefined;
    if (isAccess(p) && p.expression === at) {
      // `path.join`, `path.posix`: followed in turn. `.call`, `.apply` and
      // `.bind` are followed when called. Any other member is a read.
      if ((holds(p) & (MODULE | PATH_FN)) !== 0) return undefined;
      const name = memberName(p);
      const forwards = name === "call" || name === "apply" || name === "bind";
      return (flags & PATH_FN) !== 0 && forwards && !calledAs(p) ? `.${name}` : undefined;
    }
    if (
      (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) &&
      p.initializer === at
    ) {
      return undefined; // bound to a name, which is followed (an exported one fails below)
    }
    if (ts.isShorthandPropertyAssignment(p) && p.objectAssignmentInitializer === at) {
      return undefined;
    }
    // Into a seam under its own name: the object is followed in turn.
    const own = (key: string | undefined) => VARIADIC.has(key ?? "") && flags === PATH_FN;
    if (ts.isPropertyAssignment(p) && p.initializer === at && own(propertyKey(p.name))) {
      return undefined;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name === at && own(p.name.text)) return undefined;
    if (ts.isCallExpression(p) && p.arguments[0] === at) {
      const callee = inner(p.expression);
      const name = isAccess(callee) ? memberName(callee) : undefined;
      if (name === "apply" && isAccess(callee) && isGlobal(callee.expression, "Reflect")) {
        return undefined; // Reflect.apply(path.join, …): checked as a call
      }
      const forwards = name === "call" || name === "apply" || name === "bind";
      if (flags === MODULE && forwards && isAccess(callee)) {
        if ((flagsOf(callee.expression) & (PATH_FN | NAMED)) !== 0) return undefined; // `this`
      }
    }
    if (
      ts.isExpressionStatement(p) ||
      ts.isTypeOfExpression(p) ||
      ts.isVoidExpression(p) ||
      ts.isDeleteExpression(p) ||
      ts.isConditionalExpression(p) || // its condition
      ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) &&
        p.expression === at)
    ) {
      return undefined;
    }
    if (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken) return undefined;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (COMPARING.has(op) || op === K.CommaToken) return undefined; // compared, or discarded
      if (ASSIGNING.has(op) && p.left === at) return undefined; // assigned to
    }
    return PLACES.get(p.kind) ?? ts.SyntaxKind[p.kind];
  };

  /** A spread whose length is fixed in the source. */
  const fixed = (e: ts.Expression): boolean => {
    const at = inner(e);
    if (ts.isArrayLiteralExpression(at)) return !at.elements.some(ts.isSpreadElement);
    if (!ts.isIdentifier(at) || !Object.hasOwn(CONSTANT_SEGMENT_LISTS, at.text)) return false;
    const home = CONSTANT_SEGMENT_LISTS[at.text];
    const d = declOf(at);
    const p = d?.parent;
    let listed = false;
    if (p !== undefined && ts.isImportSpecifier(p)) {
      // `import { NAME } from "…"`, NAME under its own name, from a module that leads to it.
      const decl = p.parent.parent.parent;
      listed =
        !p.isTypeOnly &&
        decl.importClause?.isTypeOnly !== true &&
        (p.propertyName ?? p.name).text === at.text &&
        ts.isStringLiteral(decl.moduleSpecifier) &&
        origin(fileName, decl.moduleSpecifier.text, at.text) === home;
    } else if (p !== undefined && ts.isVariableDeclaration(p)) {
      // The listed declaration itself, at the top of its own module.
      listed =
        fileName === home &&
        literalTuple(p) !== undefined &&
        ts.isVariableStatement(p.parent.parent) &&
        ts.isSourceFile(p.parent.parent.parent);
    }
    if (listed) constants.push(at.text);
    return listed;
  };

  let pathCalls = 0;
  const refused: Site[] = [];
  const constants: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const show = (n: ts.Node) => {
    const text = n.getText(sf).replace(/\s+/g, " ");
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  const refuse = (at: ts.Node, what: string) => refused.push({ line: line(at), what });
  const spreads = (call: ts.CallExpression | ts.NewExpression): void => {
    for (const arg of call.arguments ?? []) {
      if (ts.isSpreadElement(arg) && !fixed(arg.expression)) {
        refuse(call, `${show(call.expression)}(…${show(arg.expression)})`);
      }
    }
  };
  const list = (call: ts.CallExpression, at: number): void => {
    const arg = call.arguments[at];
    if (arg !== undefined && !ts.isSpreadElement(arg) && !fixed(arg)) {
      refuse(call, `${show(call.expression)}(…${show(arg)})`);
    }
  };
  const checkCall = (call: ts.CallExpression | ts.NewExpression): void => {
    const callee = flagsOf(call.expression);
    if ((callee & (PATH_FN | NAMED)) !== 0) {
      // node:path's join or resolve, or a `join`/`resolve` this cannot see:
      // every spread argument must have a fixed length.
      if ((callee & PATH_FN) !== 0) pathCalls += 1;
      spreads(call);
      return;
    }
    if (!ts.isCallExpression(call)) return;
    for (const at of outcomes(call.expression)) {
      if (!isAccess(at)) continue;
      const name = memberName(at);
      if (name !== "call" && name !== "apply") continue;
      const fn = flagsOf(at.expression);
      if ((fn & (PATH_FN | NAMED)) !== 0) {
        // join.call(this, ...args), join.apply(this, args)
        if ((fn & PATH_FN) !== 0) pathCalls += 1;
        spreads(call);
        if (name === "apply") list(call, 1);
      } else if (name === "apply" && isGlobal(at.expression, "Reflect")) {
        const target = call.arguments[0];
        const of = target === undefined ? 0 : flagsOf(target);
        if ((of & (PATH_FN | NAMED)) === 0) continue;
        if ((of & PATH_FN) !== 0) pathCalls += 1; // Reflect.apply(join, this, args)
        spreads(call);
        list(call, 2);
      }
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) checkCall(n);
    if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
      if (n.moduleSpecifier !== undefined) {
        const from = n.moduleSpecifier;
        if (ts.isStringLiteral(from) && PATH_MODULES.has(from.text)) {
          refuse(n, `${show(n)} hands node:path on`);
        }
      } else if (n.exportClause !== undefined && ts.isNamedExports(n.exportClause)) {
        for (const el of n.exportClause.elements) {
          const local = el.propertyName ?? el.name;
          const d = ts.isIdentifier(local) ? scopes.get(sf)?.get(local.text) : undefined;
          if (d !== undefined && (modules.has(d) || fns.has(d))) {
            refuse(el, `${show(el)} is exported`);
          }
        }
      }
    }
    const value =
      (ts.isIdentifier(n) && names.has(n.text) && isReference(n)) ||
      isAccess(n) ||
      ts.isCallExpression(n) ||
      ts.isObjectLiteralExpression(n);
    if (value) {
      const flags = holds(n as ts.Expression) & (MODULE | PATH_FN);
      const to = flags === 0 ? undefined : goesTo(n as ts.Expression, flags);
      if (to !== undefined) refuse(n, `${show(n)} goes into ${to}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const [at, to] of lost) refuse(at, `${show(at)} is ${to} the guard cannot follow`);
  for (const d of [...modules, ...fns]) {
    // An exported binding (through a destructuring too) hands it to other files.
    if ((ts.getCombinedModifierFlags(d.parent as ts.Declaration) & ts.ModifierFlags.Export) !== 0) {
      refuse(d, `${d.text} is exported`);
    }
  }
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

// Import resolution for the sweep, read once: the workspace's packages by
// name (directory and entry points), and each module parsed on first use.
const workspace = {
  packages: undefined as Map<string, { dir: string; exports: Record<string, unknown> }> | undefined,
  parsed: new Map<string, ts.SourceFile>(),
};
function workspacePackages() {
  if (workspace.packages !== undefined) return workspace.packages;
  const packages = new Map<string, { dir: string; exports: Record<string, unknown> }>();
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(path.join(ROOT, group)).sort()) {
      const file = path.join(ROOT, group, name, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      const exports =
        typeof manifest.exports === "string" || manifest.exports === undefined
          ? { ".": manifest.exports ?? manifest.main }
          : manifest.exports;
      packages.set(manifest.name, { dir: `${group}/${name}`, exports });
    }
  }
  workspace.packages = packages;
  return packages;
}

/** The ROOT-relative module a specifier names from `from`, or undefined outside the workspace. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.posix.join(path.posix.dirname(from), specifier);
  } else {
    const parts = specifier.split("/");
    const at = specifier.startsWith("@") ? 2 : 1;
    const pkg = workspacePackages().get(parts.slice(0, at).join("/"));
    const entry = pkg?.exports[[".", ...parts.slice(at)].join("/")];
    if (pkg === undefined || typeof entry !== "string") return undefined;
    base = path.posix.join(pkg.dir, entry);
  }
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`]) {
    const abs = path.join(ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return undefined;
}

/** Where `name`, imported through `specifier` by `from`, is declared: re-exports followed. */
function originOf(from: string, specifier: string, name: string, depth = 0): string | undefined {
  const file = resolveSpecifier(from, specifier);
  if (file === undefined || depth > 8) return undefined;
  let sf = workspace.parsed.get(file);
  if (sf === undefined) {
    sf = ts.createSourceFile(
      file,
      readFileSync(path.join(ROOT, file), "utf8"),
      ts.ScriptTarget.Latest,
    );
    workspace.parsed.set(file, sf);
  }
  for (const st of sf.statements) {
    if (
      ts.isVariableStatement(st) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)
    ) {
      return file;
    }
    if (!ts.isExportDeclaration(st) || st.isTypeOnly || st.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const next = st.moduleSpecifier.text;
    if (st.exportClause === undefined) {
      const found = originOf(file, next, name, depth + 1); // export * from "…"
      if (found !== undefined) return found;
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.isTypeOnly || el.name.text !== name) continue;
        return originOf(file, next, (el.propertyName ?? el.name).text, depth + 1);
      }
    }
  }
  return undefined;
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
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const scan = scanSpreads(rel, readFileSync(file, "utf8"), originOf);
      pathCalls += scan.pathCalls;
      for (const s of scan.refused) refused.push(`${rel}:${s.line} ${s.what}`);
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
  }, 120_000);

  test("no spread of a list whose length is not fixed in the source", () => {
    expect(sweep().refused).toEqual([]);
  }, 120_000);

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
      const literal = sf.statements
        .filter(ts.isVariableStatement)
        .flatMap((st) => st.declarationList.declarations)
        .filter((d) => ts.isIdentifier(d.name) && d.name.text === name)
        .map(literalTuple);
      expect({ name, literal: literal.length === 1 && literal[0] !== undefined }).toEqual({
        name,
        literal: true,
      });
    }
  }, 120_000);

  test("an import of a listed constant is followed to where it is declared", () => {
    // Through a package's entry and its re-export, through a subpath export,
    // and relative; a name the module does not export leads nowhere.
    expect([
      originOf(
        "packages/tool-fleet/src/lib/settings.ts",
        "@crewhaus/harness-supervisor",
        "MANAGER_SETTINGS_SEGMENTS",
      ),
      originOf(
        "apps/cli/src/flywheel.ts",
        "@crewhaus/hangar-server/scaffolded-workflows",
        "WORKFLOWS_DIR_SEGMENTS",
      ),
      originOf("packages/harness-supervisor/src/runfiles.ts", "./types", "RUN_DIR_SEGMENTS"),
      originOf("packages/tool-fleet/src/lib/settings.ts", "@crewhaus/harness-supervisor", "NOPE"),
      originOf("packages/tool-fleet/src/lib/settings.ts", "@crewhaus/no-such-package", "X"),
    ]).toEqual([
      CONSTANT_SEGMENT_LISTS["MANAGER_SETTINGS_SEGMENTS"],
      CONSTANT_SEGMENT_LISTS["WORKFLOWS_DIR_SEGMENTS"],
      CONSTANT_SEGMENT_LISTS["RUN_DIR_SEGMENTS"],
      undefined,
      undefined,
    ]);
  }, 30_000);
});

describe("the guard sees every way of spelling the call", () => {
  const TYPES = "packages/harness-supervisor/src/types.ts";
  // The sweep follows imports through the workspace (see originOf); here one
  // stub route stands in for it.
  const origin: Origin = (_from, specifier, name) =>
    specifier === "@crewhaus/harness-supervisor" && name === "RUN_DIR_SEGMENTS" ? TYPES : undefined;
  const refusedIn = (text: string, fileName = "fixture.ts") =>
    [...new Set(scanSpreads(fileName, text, origin).refused.map((s) => s.line))].sort(
      (a, b) => a - b,
    );

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
      "(path.join)(a, ...xs);", // 34
      "(0, path.join)(a, ...xs);", // 35: the comma form compilers emit
      "path.join.bind(path)(a, ...xs);", // 36
      "const jb = path.join.bind(path); jb(a, ...xs);", // 37
      "const { posix: { join: pj } } = path; pj(a, ...xs);", // 38
      "let ja; ja = path.join; ja(a, ...xs);", // 39
      "function dj(jd = path.join) { return jd(a, ...xs); }", // 40
      "const js = path.join satisfies (...p: string[]) => string; js(a, ...xs);", // 41
      "const jc = c ? path.join : path.resolve; jc(a, ...xs);", // 42
      "(c ? path.join : other)(a, ...xs);", // 43
      "const jn = o?.j ?? path.join; jn(a, ...xs);", // 44
      "(path as typeof import('node:path')).join(a, ...xs);", // 45
      "path!.join(a, ...xs);", // 46
      "path?.join(a, ...xs);", // 47
      "path.join?.(a, ...xs);", // 48
      "path[`join`](a, ...xs);", // 49
      'const pr = createRequire(import.meta.url)("node:path"); pr.join(a, ...xs);', // 50
      'const { join: gj } = process.getBuiltinModule("node:path"); gj(a, ...xs);', // 51
      "const { resolve: rr } = ops; rr(a, ...xs);", // 52: by name, from what it cannot see
      "const oj = ops.join; oj(a, ...xs);", // 53
      "ops.join.apply(null, xs);", // 54
      "Reflect.apply(ops.resolve, null, xs);", // 55
      "path.join.apply(null, [a, ...xs]);", // 56
      "path.join(a, ...(c ? xs : ys));", // 57
      "new path.join(a, ...xs);", // 58
      "path[k](a, ...xs);", // 59: a computed member of node:path
      "const seam = { join: path.join }; seam.join(a, ...xs);", // 60
      "const { join: sj } = seam; sj(a, ...xs);", // 61
      'import { join as uj } from "upath"; uj(a, ...xs);', // 62: a package outside the workspace
      "const pf = ({ join: pj3 }: Ops) => pj3(a, ...xs);", // 63
      "for (const { resolve: fr } of seams) fr(a, ...xs);", // 64
    ].join("\n");
    const scan = scanSpreads("fixture.ts", text, origin);
    expect([...new Set(scan.refused.map((s) => s.line))]).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 29, 31, 33, 34, 35,
      36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
      59, 60, 61, 62, 63, 64,
    ]);
    // Each is node:path's own, not merely named like it, except 25, 52 to 55
    // and 62 to 64 (what the guard cannot see).
    expect(scan.pathCalls).toBe(45);
  });

  test("a path function or module that leaves where the guard follows it fails there", () => {
    const text = [
      'import * as path from "node:path";', // 1
      'import { join } from "node:path";', // 2
      "const ops1 = { j: path.join };", // 3
      "const seam = { join: path.join, dirname: path.dirname };", // 4: followed, so passes
      "const fns = [path.join];", // 5
      "use(path.join);", // 6
      "use(path);", // 7
      "const all = { ...path };", // 8
      "function get() { return path.resolve; }", // 9
      "const get2 = () => join;", // 10
      "export const ej = path.join;", // 11
      "export { join };", // 12
      "export default path;", // 13
      'export { join as j } from "node:path";', // 14
      'export * from "path";', // 15
      "class C { j = path.join; }", // 16
      "Function.prototype.apply.call(path.join, null, xs);", // 17
      "holder.j = path.join;", // 18
      "({ join: holder.k } = path);", // 19
      'use(require("node:path"));', // 20
      'use(process.getBuiltinModule("node:path"));', // 21
      'use(createRequire(import.meta.url)("path"));', // 22
      "const pc = path.join.call;", // 23
      "export const { resolve: er } = path;", // 24
      "for (const f of [path.resolve]) f(a);", // 25
      "const { posix: { join: pj } } = path; keep({ pj });", // 26
      "let ja; ja = c ? path.resolve : join; keep(ja);", // 27
      "const ol = { p: (0, path).posix };", // 28
      "use(seam);", // 29: a seam goes nowhere either
      "const fx = [seam.join];", // 30
      "seam.dirname = path.join;", // 31: into a seam under another name
      "export const seam2 = { resolve: path.resolve };", // 32
      "use({ join });", // 33
      "const { join: sj } = seam; keep(sj);", // 34
      "use(c ? path.join : other);", // 35
      "use((path.resolve as Fn)!);", // 36
    ].join("\n");
    expect(refusedIn(text)).toEqual([
      3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
      29, 30, 31, 32, 33, 34, 35, 36,
    ]);
  });

  test("a fixed-length spread, a joined string and an unrelated spread pass", () => {
    const text = [
      'import * as path from "node:path";',
      'import { RUN_DIR_SEGMENTS } from "@crewhaus/harness-supervisor";',
      'path.join(a, ...["x", "y"], b);',
      "path.join(a, ...RUN_DIR_SEGMENTS);",
      "path.join(a, tail.join(path.sep));",
      'path.join.apply(null, ["a", "b"]);',
      "Math.max(...xs);",
      'const s = [...xs].join("/");',
      "list.push(...xs);",
      "function join(...xs: string[]) { return xs.length; }",
    ].join("\n");
    const scan = scanSpreads("fixture.ts", text, origin);
    expect(scan.refused).toEqual([]);
    expect(scan.constants).toEqual(["RUN_DIR_SEGMENTS"]);
    // An array literal that itself spreads a list has no fixed length.
    expect(refusedIn('import * as path from "node:path";\npath.join(a, ...[...xs]);')).toEqual([2]);
  });

  test("a listed constant passes only as its own declaration or an import of it", () => {
    const spread = (...lines: string[]) =>
      ['import * as path from "node:path";', ...lines, "path.join(a, ...RUN_DIR_SEGMENTS);"].join(
        "\n",
      );
    const imported = 'import { RUN_DIR_SEGMENTS } from "@crewhaus/harness-supervisor";';
    const declared = 'export const RUN_DIR_SEGMENTS = [".crewhaus", "run"] as const;';
    expect({
      imported: refusedIn(spread(imported)),
      declaredInItsModule: refusedIn(spread(declared), TYPES),
      // A list of the same name anywhere else is not the constant.
      local: refusedIn(spread('const RUN_DIR_SEGMENTS = input.split("/");')),
      declaredElsewhere: refusedIn(spread(declared)),
      notLiteralInItsModule: refusedIn(
        spread('export const RUN_DIR_SEGMENTS = input.split("/");'),
        TYPES,
      ),
      fromElsewhere: refusedIn(spread('import { RUN_DIR_SEGMENTS } from "./elsewhere";')),
      renamed: refusedIn(
        spread('import { OTHER as RUN_DIR_SEGMENTS } from "@crewhaus/harness-supervisor";'),
      ),
      undeclared: refusedIn(spread()),
      shadowed: refusedIn(
        [
          'import * as path from "node:path";',
          imported,
          "function f(RUN_DIR_SEGMENTS: string[]) { return path.join(a, ...RUN_DIR_SEGMENTS); }",
        ].join("\n"),
      ),
    }).toEqual({
      imported: [],
      declaredInItsModule: [],
      local: [3],
      declaredElsewhere: [3],
      notLiteralInItsModule: [3],
      fromElsewhere: [3],
      renamed: [3],
      undeclared: [2],
      shadowed: [3],
    });
  });

  test("names that only look like path's, and uses that only read it, pass", () => {
    const text = [
      'import * as path from "node:path";',
      'import { resolve, join } from "node:path";',
      // A promise's resolve, a parameter, shadows the import.
      "new Promise<void>((resolve) => setTimeout(resolve, 1));",
      "new Promise((resolve) => resolve(...xs));",
      "function g(join: (...p: string[]) => number) { return keep(join); }",
      "const n = path.sep.length;",
      'if (typeof path.join === "function" && path.join !== path.resolve) keep(path.basename(a));',
      "keep(path.join.length, path.join(a, b), path.resolve(...[a, b]));",
      "path.join.call(path, a, b);", // the module as `this`
      "const { sep, basename } = path;",
      "xs.map((x) => path.join(root, x));",
      "type P = typeof path; type J = typeof path.join;",
      "let lj = path.join; lj ||= path.resolve; lj(a, b);",
      "({ join: lj } = path);",
      "const pj2 = (path.join as Fn); pj2(a, b);",
      "let px2; ({ posix: px2 } = path); px2.join(a, b);",
      "const seam = { join: path.join, dirname: path.dirname };",
      "seam.join = next?.join ?? path.join;",
      "seam.join(a, b); seam.dirname(a);",
      'import { join as upJoin } from "@crewhaus/some-package";',
      "upJoin(a, ...xs);", // a workspace module: one that took node:path's would fail there
    ].join("\n");
    const scan = scanSpreads("fixture.ts", text, origin);
    expect(scan.refused).toEqual([]);
    expect(scan.pathCalls).toBe(8);
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
