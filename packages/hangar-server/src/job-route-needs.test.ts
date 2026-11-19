/**
 * Every job route carries what it checked into the job's start-time check.
 *
 * A route whose handler queues a job (`dispatch: "job"`) is authorized twice: at the
 * choke point for its row's permission, and again where the job starts, for the
 * permissions the request noted (`noteNeed`, which `requirePermission` calls when no
 * target is named). This guard reads each job handler's source and every function it
 * reaches, in its own module and in the sibling modules it imports, and holds each one to
 * that rule:
 *
 * - a permission is checked with `requirePermission(ctx, P)` and no target, or, when it is
 *   checked on an explicit target, that target is the route's own harness and `noteNeed(P)`
 *   follows in the same function;
 * - a bare `ctx.authorize(P)` is followed by `noteNeed(P)` in the same function;
 * - every check comes before the function queues its job;
 * - a check the guard cannot read is a failure, never a pass: options that are not an inline
 *   literal of known keys, `authorize` reached any way but `ctx.authorize(…)`,
 *   `requirePermission` under another name, and a call into a relative import it cannot read.
 *
 * The rows come from the route table, the handlers from the M3 table, and the modules from
 * every non-test source under `src`, subdirectories included: nothing here is a hand-kept
 * list of routes. Planted handlers prove the checker can fail.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { M3_ROUTES } from "./m3-routes";
import { ROUTE_TABLE } from "./route-table";

const SRC = import.meta.dir;

// ---------------------------------------------------------------------------
// Reading TypeScript without a parser
// ---------------------------------------------------------------------------

const REGEX_PREFIX_WORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/**
 * The source with every comment, string, template text and regular expression body blanked
 * to spaces (newlines kept), so braces, parentheses and identifiers can be read by position.
 * A template's `${…}` stays code. Offsets are the source's own.
 */
function maskSource(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  // Each frame is code (with its own brace depth) or a template's text.
  const stack: ({ kind: "code"; depth: number } | { kind: "template" })[] = [
    { kind: "code", depth: 0 },
  ];
  let lastSignificant = "";
  let lastWord = "";
  let i = 0;
  while (i < src.length) {
    const frame = stack[stack.length - 1] as (typeof stack)[number];
    const c = src[i] as string;
    if (frame.kind === "template") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        lastSignificant = "`";
        lastWord = "";
        i += 1;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        stack.push({ kind: "code", depth: 0 });
        lastSignificant = "{";
        lastWord = "";
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastSignificant = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "template" });
      i += 1;
      continue;
    }
    if (c === "/") {
      const regex =
        lastSignificant === "" ||
        "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) ||
        REGEX_PREFIX_WORDS.has(lastWord);
      if (regex) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length && src[j] !== "\n") {
          const d = src[j];
          if (d === "\\") {
            j += 2;
            continue;
          }
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          j += 1;
        }
        blank(i + 1, j);
        i = j + 1;
        while (i < src.length && /[a-z]/.test(src[i] as string)) i += 1;
        lastSignificant = "/";
        lastWord = "";
        continue;
      }
    }
    if (c === "{") frame.depth += 1;
    if (c === "}") {
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop();
        lastSignificant = "}";
        lastWord = "";
        i += 1;
        continue;
      }
      frame.depth -= 1;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j] as string)) j += 1;
      lastWord = src.slice(i, j);
      lastSignificant = "a";
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      lastSignificant = c;
      lastWord = "";
    }
    i += 1;
  }
  return out.join("");
}

/** The offset of the `)` that closes the `(` at `open`, in masked text. */
function closeParen(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k += 1) {
    const c = masked[k];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return masked.length;
}

/**
 * The spans of the comma-separated parts between `from` and `to` (exclusive), split at
 * top-level commas of the masked text, each trimmed, empty parts dropped.
 */
function partSpans(src: string, masked: string, from: number, to: number): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = from;
  const push = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(src[a] as string)) a += 1;
    while (b > a && /\s/.test(src[b - 1] as string)) b -= 1;
    if (b > a) spans.push([a, b]);
  };
  for (let k = from; k < to; k += 1) {
    const c = masked[k];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      push(k);
      start = k + 1;
    }
  }
  push(to);
  return spans;
}

/** A call's argument spans, split at its top-level commas. */
function argSpans(src: string, masked: string, open: number): [number, number][] {
  return partSpans(src, masked, open + 1, closeParen(masked, open));
}

/** A call's arguments, as source text, split at its top-level commas. */
function argsAt(src: string, masked: string, open: number): string[] {
  return argSpans(src, masked, open).map(([a, b]) => src.slice(a, b));
}

/** The option keys `requirePermission` takes that name no target. */
const NON_TARGET_OPTIONS = new Set(["paths", "message"]);

/**
 * What a `requirePermission` options argument says, read only when it is an inline object
 * literal of plain `key: value` / shorthand properties. Anything else (a variable, a call, a
 * spread, a computed or quoted key, a shorthand `target`, a key the guard does not know) is
 * options the guard cannot read, and so cannot clear.
 */
type Options =
  | { readonly readable: true; readonly target: string | undefined }
  | { readonly readable: false; readonly why: string };

function readOptions(src: string, masked: string, [from, to]: [number, number]): Options {
  const text = src.slice(from, to);
  if (masked[from] !== "{" || closeBrace(masked, from) !== to - 1) {
    return { readable: false, why: `options it builds elsewhere (${text})` };
  }
  let target: string | undefined;
  for (const [a, b] of partSpans(src, masked, from + 1, to - 1)) {
    const part = src.slice(a, b);
    const keyed = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(part);
    const shorthand = /^[A-Za-z_$][\w$]*$/.test(part);
    const key = keyed !== null ? (keyed[1] as string) : shorthand ? part : undefined;
    if (key === undefined) return { readable: false, why: `options it cannot read (${part})` };
    if (key === "target") {
      if (keyed === null) return { readable: false, why: "a target it names by variable" };
      target = (keyed[2] as string).replace(/\s+/g, " ").trim();
      continue;
    }
    if (!NON_TARGET_OPTIONS.has(key)) {
      return { readable: false, why: `an option it does not know (${key})` };
    }
  }
  return { readable: true, target };
}

/** The offset of the `}` that closes the `{` at `open`, in masked text. */
function closeBrace(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k += 1) {
    const c = masked[k];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return masked.length;
}

type Unit = {
  readonly module: string;
  readonly name: string;
  /** Offsets of the unit's span in its module. */
  readonly from: number;
  readonly to: number;
};

type Module = {
  readonly name: string;
  readonly src: string;
  readonly masked: string;
  readonly units: ReadonlyMap<string, Unit>;
  /**
   * Local name → [module path, its exported name], for every named import (or re-export)
   * from a relative specifier. The path is resolved against this module's directory, relative
   * to `src`, without an extension; it may name no module the walk can read.
   */
  readonly imports: ReadonlyMap<string, readonly [string, string]>;
  /** Local names bound by a default or namespace import from a relative specifier. */
  readonly opaque: ReadonlyMap<string, string>;
};

/** A relative specifier, resolved against the importing module's directory. */
function resolveSpecifier(module: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(module), spec)).replace(/\.(?:ts|js)$/, "");
}

const DECLARATION_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/;

/**
 * A module's top-level functions and constants. The files are formatted, so a top-level
 * statement starts at column 0 and runs to the next one: a declaration's span holds its
 * whole body, `const x: M3Handler = async (ctx) => {…}` arrows included.
 */
function readModule(name: string, src: string): Module {
  const masked = maskSource(src);
  const lines = masked.split("\n");
  const starts: { name: string | undefined; at: number }[] = [];
  let at = 0;
  for (const line of lines) {
    if (/^[A-Za-z@]/.test(line)) {
      const m = DECLARATION_RE.exec(line);
      starts.push({ name: m?.[1] ?? m?.[2], at });
    }
    at += line.length + 1;
  }
  const units = new Map<string, Unit>();
  starts.forEach((s, k) => {
    if (s.name === undefined) return;
    const to = (starts[k + 1]?.at ?? masked.length) as number;
    units.set(s.name, { module: name, name: s.name, from: s.at, to });
  });
  const imports = new Map<string, readonly [string, string]>();
  const IMPORT_RE =
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*"(\.{1,2}\/[^"]+)"/g;
  for (const m of src.matchAll(IMPORT_RE)) {
    const from = resolveSpecifier(name, m[2] as string);
    for (const part of (m[1] as string).split(",")) {
      const spec = part.trim().replace(/^type\s+/, "");
      if (spec === "") continue;
      const [orig, local] = spec.split(/\s+as\s+/) as [string, string | undefined];
      imports.set((local ?? orig).trim(), [from, orig.trim()]);
    }
  }
  const opaque = new Map<string, string>();
  const OPAQUE_RE =
    /(?:^|\n)\s*import\s+(?!type\s)(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))[^"]*?from\s*"(\.{1,2}\/[^"]+)"/g;
  for (const m of src.matchAll(OPAQUE_RE)) {
    opaque.set((m[1] ?? m[2]) as string, resolveSpecifier(name, m[3] as string));
  }
  return { name, src, masked, units, imports, opaque };
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

/** Functions the walk treats as primitives, never as bodies to read. */
const PRIMITIVES = new Set(["requirePermission", "noteNeed", "commandFields"]);
const NOT_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "await",
  "new",
  "super",
  "import",
]);

/** The expressions that name the route's own harness. */
const OWN_HARNESS_RE = /^\{\s*harness\s*:\s*ctx\.(?:entry\??\.id|params\.id|params\["id"\])\s*\}$/;

type Site = {
  readonly kind: "check" | "submit" | "call";
  readonly at: number;
  readonly text: string;
  readonly callee?: Unit;
};

type Facts = {
  readonly unit: Unit;
  readonly sites: readonly Site[];
  /** Rule breaks in this function's own body. */
  readonly problems: readonly string[];
};

type Violation = { readonly route: string; readonly handler: string; readonly why: string };

/** What a local name a function calls resolves to. */
type Resolved = Unit | { readonly unreadable: string } | undefined;

/**
 * Every `authorize` in masked text that is not a member call (`x.authorize(` or
 * `x.authorize?.(`): a destructuring, an alias, a bare call, `.call`/`.bind`, a property
 * that is assigned. Offsets are the text's own.
 */
function authorizeOutsideMemberCalls(masked: string, from = 0, to = masked.length): number[] {
  const out: number[] = [];
  const text = masked.slice(from, to);
  for (const m of text.matchAll(/\bauthorize\b/g)) {
    const at = m.index as number;
    const before = text.slice(0, at);
    const after = text.slice(at + "authorize".length);
    const member = /(?:\?\.|\.)\s*$/.test(before) && /^\s*(?:\?\.\s*)?\(/.test(after);
    if (!member) out.push(from + at);
  }
  return out;
}

/** Every `requirePermission` in masked text that is not called directly by that name. */
function requirePermissionNotCalled(masked: string, from = 0, to = masked.length): number[] {
  const out: number[] = [];
  const text = masked.slice(from, to);
  for (const m of text.matchAll(/\brequirePermission\b/g)) {
    const at = m.index as number;
    const before = text.slice(0, at);
    const after = text.slice(at + "requirePermission".length);
    const called = !/[.?]\s*$/.test(before) && /^\s*\(/.test(after);
    const declared = /\bfunction\s+$/.test(before);
    if (!called && !declared) out.push(from + at);
  }
  return out;
}

function unitFacts(mod: Module, unit: Unit, resolve: (local: string) => Resolved): Facts {
  const { src, masked } = mod;
  const body = masked.slice(unit.from, unit.to);
  const sites: Site[] = [];
  const problems: string[] = [];
  const lineOf = (at: number) => src.slice(0, at).split("\n").length;
  const where = (at: number) => `${unit.module}.ts:${lineOf(at)}`;
  const noteNeedsAfter = (at: number, permission: string): boolean => {
    for (const m of body.slice(at - unit.from).matchAll(/\bnoteNeed\s*\(/g)) {
      const open = at + (m.index as number) + m[0].length - 1;
      if (argsAt(src, masked, open)[0] === permission) return true;
    }
    return false;
  };
  // `authorize` reached any way but a member call, and `requirePermission` used any way but
  // a direct call, are checks the guard cannot follow: one problem per function.
  const loose = authorizeOutsideMemberCalls(masked, unit.from, unit.to);
  if (loose.length > 0) {
    problems.push(
      `${unit.module}.ts:${loose.map(lineOf).join(",")} uses authorize other than as ctx.authorize(…)`,
    );
  }
  const aliased = requirePermissionNotCalled(masked, unit.from, unit.to);
  if (aliased.length > 0) {
    problems.push(
      `${unit.module}.ts:${aliased.map(lineOf).join(",")} uses requirePermission other than by calling it`,
    );
  }
  // A default or namespace import from a sibling module is a body the walk cannot read by name.
  for (const [local, path] of mod.opaque) {
    if (new RegExp(`(?<![\\w$.])${local.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) {
      problems.push(
        `${unit.module}.${unit.name} uses ${local} from ${path}, which the guard cannot read`,
      );
    }
  }
  // Every identifier followed by `(` or `?.(`: a call, a check or a job submission.
  for (const m of body.matchAll(/([.?]*)\b([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(/g)) {
    const name = m[2] as string;
    const member = (m[1] as string).includes(".");
    const at = unit.from + (m.index as number) + (m[1] as string).length;
    const open = unit.from + (m.index as number) + m[0].length - 1;
    if (NOT_CALLS.has(name)) continue;
    if (
      name === "submitJob" ||
      (member && name === "submit" && /jobs\??\.$/.test(body.slice(0, at - unit.from)))
    ) {
      sites.push({ kind: "submit", at, text: name });
      continue;
    }
    if (name === "authorize") {
      const args = argsAt(src, masked, open);
      const permission = args[0] ?? "";
      sites.push({ kind: "check", at, text: `authorize(${permission})` });
      // A non-member call is already a problem above.
      if (!member) continue;
      if (args.length >= 2) {
        const target = (args[1] as string).replace(/\s+/g, " ").trim();
        if (!OWN_HARNESS_RE.test(target) || !noteNeedsAfter(at, permission)) {
          problems.push(`${where(at)} checks ${permission} on ${target}`);
        }
      } else if (!noteNeedsAfter(at, permission)) {
        problems.push(`${where(at)} checks ${permission} and never carries it into the job`);
      }
      continue;
    }
    if (member) continue;
    if (name === "requirePermission") {
      const spans = argSpans(src, masked, open);
      const permission = spans[1] !== undefined ? src.slice(...spans[1]) : "";
      sites.push({ kind: "check", at, text: `requirePermission(${permission})` });
      if (spans.length > 3) {
        problems.push(`${where(at)} checks ${permission} with arguments it cannot read`);
      } else if (spans[2] !== undefined) {
        const options = readOptions(src, masked, spans[2]);
        if (!options.readable) {
          problems.push(`${where(at)} checks ${permission} with ${options.why}`);
        } else if (options.target !== undefined) {
          if (!OWN_HARNESS_RE.test(options.target) || !noteNeedsAfter(at, permission)) {
            problems.push(`${where(at)} checks ${permission} on ${options.target}`);
          }
        }
      }
      continue;
    }
    if (name === "noteNeed") {
      sites.push({ kind: "check", at, text: "noteNeed" });
      continue;
    }
    if (PRIMITIVES.has(name)) continue;
    const callee = resolve(name);
    if (callee !== undefined && "unreadable" in callee) {
      problems.push(
        `${where(at)} calls ${name} from ${callee.unreadable}, which the guard cannot read`,
      );
      continue;
    }
    if (callee !== undefined && !(callee.module === unit.module && callee.name === unit.name)) {
      sites.push({ kind: "call", at, text: name, callee });
    }
  }
  return { unit, sites, problems };
}

/**
 * Check every job handler against the rule. `modules` maps a module's name (no `.ts`) to its
 * source; `handlers` names each job route's handler and the module that defines it.
 */
function checkJobHandlers(
  modules: ReadonlyMap<string, string>,
  handlers: readonly { readonly route: string; readonly module: string; readonly fn: string }[],
): { readonly violations: readonly Violation[]; readonly reached: ReadonlySet<string> } {
  const read = new Map<string, Module>();
  const moduleOf = (name: string): Module | undefined => {
    const hit = read.get(name);
    if (hit !== undefined) return hit;
    const src = modules.get(name);
    if (src === undefined) return undefined;
    const mod = readModule(name, src);
    read.set(name, mod);
    return mod;
  };
  /** A module path as written, or its `index` when it names a directory. */
  const located = (path: string): string | undefined =>
    modules.has(path) ? path : modules.has(`${path}/index`) ? `${path}/index` : undefined;
  const unitOf = (module: string, name: string, seen = new Set<string>()): Resolved => {
    const mod = moduleOf(module);
    if (mod === undefined || seen.has(`${module}.${name}`)) return undefined;
    seen.add(`${module}.${name}`);
    const own = mod.units.get(name);
    if (own !== undefined) return own;
    const imported = mod.imports.get(name);
    if (imported === undefined) return undefined;
    const target = located(imported[0]);
    if (target === undefined) return { unreadable: imported[0] };
    return unitOf(target, imported[1], seen);
  };
  const facts = new Map<string, Facts>();
  const factsOf = (unit: Unit): Facts => {
    const key = `${unit.module}.${unit.name}`;
    const hit = facts.get(key);
    if (hit !== undefined) return hit;
    const mod = moduleOf(unit.module) as Module;
    const made = unitFacts(mod, unit, (local) => unitOf(unit.module, local));
    facts.set(key, made);
    return made;
  };
  // Whether a function, or anything it reaches, queues a job / checks a permission.
  const reachMemo = new Map<string, { submits: boolean; checks: boolean }>();
  const reach = (unit: Unit, stack = new Set<string>()): { submits: boolean; checks: boolean } => {
    const key = `${unit.module}.${unit.name}`;
    const memo = reachMemo.get(key);
    if (memo !== undefined) return memo;
    if (stack.has(key)) return { submits: false, checks: false };
    stack.add(key);
    let submits = false;
    let checks = false;
    for (const site of factsOf(unit).sites) {
      if (site.kind === "submit") submits = true;
      if (site.kind === "check") checks = true;
      if (site.kind === "call" && site.callee !== undefined) {
        const r = reach(site.callee, stack);
        submits ||= r.submits;
        checks ||= r.checks;
      }
    }
    stack.delete(key);
    const answer = { submits, checks };
    reachMemo.set(key, answer);
    return answer;
  };
  const violations: Violation[] = [];
  const reached = new Set<string>();
  for (const h of handlers) {
    const root = unitOf(h.module, h.fn);
    if (root === undefined || "unreadable" in root) {
      violations.push({ route: h.route, handler: h.fn, why: `no ${h.fn} in ${h.module}.ts` });
      continue;
    }
    const todo = [root];
    const seen = new Set<string>();
    while (todo.length > 0) {
      const unit = todo.pop() as Unit;
      const key = `${unit.module}.${unit.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reached.add(key);
      const f = factsOf(unit);
      for (const why of f.problems) violations.push({ route: h.route, handler: h.fn, why });
      // Every check comes before the first job this function queues, directly or through a
      // function it calls.
      const firstSubmit = f.sites.find(
        (s) =>
          s.kind === "submit" ||
          (s.kind === "call" && s.callee !== undefined && reach(s.callee).submits),
      );
      if (firstSubmit !== undefined) {
        for (const s of f.sites) {
          if (s.at <= firstSubmit.at) continue;
          const late =
            s.kind === "check" ||
            (s.kind === "call" && s.callee !== undefined && reach(s.callee).checks);
          if (late) {
            violations.push({
              route: h.route,
              handler: h.fn,
              why: `${unit.module}.${unit.name} checks ${s.text} after it queues a job (${firstSubmit.text})`,
            });
          }
        }
      }
      for (const s of f.sites) if (s.kind === "call" && s.callee !== undefined) todo.push(s.callee);
    }
  }
  return { violations, reached };
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

/**
 * Every non-test source under `src`, subdirectories included (test helpers under
 * `__test__/` are not served code), keyed by its path relative to `src` with `/` separators
 * and no extension: the names relative imports resolve to.
 */
const SOURCE_FILES = (readdirSync(SRC, { recursive: true }) as string[])
  .map((name) => name.split(sep).join("/"))
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.split("/").includes("__test__"),
  );
const MODULES = new Map(
  SOURCE_FILES.map((name) => [name.replace(/\.ts$/, ""), readFileSync(join(SRC, name), "utf8")]),
);

const JOB_ROWS = ROUTE_TABLE.filter((row) => row.dispatch === "job");
const M3_BY_KEY = new Map(M3_ROUTES.map((route) => [route.key, route]));
const ROUTES_MODULE = readModule("m3-routes", MODULES.get("m3-routes") as string);

/** Each job row's handler, and the module the M3 table imports it from. */
function jobHandlers() {
  return JOB_ROWS.flatMap((row) => {
    const route = M3_BY_KEY.get(row.key);
    if (route === undefined) return [];
    const fn = route.handler.name;
    const from = ROUTES_MODULE.imports.get(fn);
    return [{ route: row.key, module: from?.[0] ?? "(not imported)", fn }];
  });
}

/** The function a source offset sits in, or `(top level)`. */
function unitAt(mod: Module, at: number): string {
  const unit = [...mod.units.values()].find((u) => u.from <= at && at < u.to);
  return `${mod.name}.ts ${unit?.name ?? "(top level)"}`;
}

/**
 * Every call in non-test sources matching `re` (which ends at the call's `(`), as
 * `<file> <function>`. A function's own declaration is not a call.
 */
function hits(re: RegExp, keep: (src: string, masked: string, open: number) => boolean): string[] {
  const out: string[] = [];
  for (const [name, src] of MODULES) {
    const mod = readModule(name, src);
    for (const m of mod.masked.matchAll(re)) {
      if (/\bfunction\s+$/.test(mod.masked.slice(0, m.index as number))) continue;
      const open = (m.index as number) + m[0].length - 1;
      if (!keep(src, mod.masked, open)) continue;
      out.push(unitAt(mod, m.index as number));
    }
  }
  return out.sort();
}

/** Every place `find` reports in a non-test source, as `<file> <function>`. */
function places(find: (masked: string) => number[]): string[] {
  const out: string[] = [];
  for (const [name, src] of MODULES) {
    const mod = readModule(name, src);
    for (const at of find(mod.masked)) out.push(unitAt(mod, at));
  }
  return out.sort();
}

/** A `requirePermission` call whose options the guard cannot clear as naming no target. */
const namesOrHidesATarget = (src: string, masked: string, open: number): boolean => {
  const spans = argSpans(src, masked, open);
  if (spans.length > 3) return true;
  if (spans[2] === undefined) return false;
  const options = readOptions(src, masked, spans[2]);
  return !options.readable || options.target !== undefined;
};

describe("every job route carries what it checked into the job's start-time check", () => {
  test("the job rows come from the route table, and every one but the jobs route is an M3 handler", () => {
    expect(JOB_ROWS).toHaveLength(36);
    const handlers = jobHandlers();
    expect(handlers).toHaveLength(35);
    // A job route outside the M3 table fails here until this guard learns how to read it.
    expect(JOB_ROWS.filter((row) => !M3_BY_KEY.has(row.key)).map((row) => row.key)).toEqual([
      "submitJob",
    ]);
    // Each handler is found where the M3 table imports it from.
    for (const h of handlers) {
      expect(`${h.route}: ${MODULES.has(h.module)}`).toBe(`${h.route}: true`);
      expect(
        `${h.route}: ${readModule(h.module, MODULES.get(h.module) as string).units.has(h.fn)}`,
      ).toBe(`${h.route}: true`);
    }
    expect([...new Set(handlers.map((h) => h.module))].sort()).toEqual(
      [
        "advisor",
        "channels-ops",
        "creds-ops",
        "data-ops",
        "evals-ops",
        "feedback-ops",
        "memory-ops",
        "runtime-ops",
        "security-ops",
        "spec-edit",
        "watchme-ops",
      ].sort(),
    );
  });

  test("no job handler checks a permission on another target, or after it queues its job", () => {
    const { violations, reached } = checkJobHandlers(MODULES, jobHandlers());
    expect(violations).toEqual([]);
    // The walk reads past each handler, into the sibling modules it imports.
    expect(reached.size).toBeGreaterThan(jobHandlers().length);
    const modulesReached = new Set([...reached].map((key) => key.split(".")[0]));
    expect(modulesReached.has("m3")).toBe(true);
  });

  test("the jobs route checks its kind's permission and carries it into the job, before queueing it", () => {
    // The source as written: the block is found by its string literal, which masking blanks.
    const server = MODULES.get("server") as string;
    const block = server.indexOf('if (head === "jobs" && tail.length === 0)');
    expect(block).toBeGreaterThan(-1);
    const allows = server.indexOf("requestAllows(needed, entry.id)", block);
    const noted = server.indexOf("noteNeed(needed)", block);
    const queued = server.indexOf(".jobs.submit(", block);
    expect(allows).toBeGreaterThan(block);
    expect(noted).toBeGreaterThan(allows);
    expect(queued).toBeGreaterThan(noted);
  });

  test("the checks that name a target, or skip noting the need, are the reviewed ones, and no job handler reaches them", () => {
    // `requirePermission` with a target option: one, a workspace write that queues nothing.
    // Every call is counted whose third argument is anything but an inline literal of
    // non-target options (a variable, a spread, a call, or a target in any form).
    expect(hits(/\brequirePermission\s*\(/g, namesOrHidesATarget)).toEqual([
      "creds-ops.ts credentialsSetAcross",
    ]);
    // The calls with options the guard reads and clears: spec paths and a message only.
    expect(
      hits(
        /\brequirePermission\s*\(/g,
        (src, masked, open) =>
          argSpans(src, masked, open)[2] !== undefined && !namesOrHidesATarget(src, masked, open),
      ),
    ).toEqual([
      "builders.ts graderWrite",
      "inspect.ts settingsWrite",
      "spec-edit.ts requireSpecEditAuthority",
    ]);
    // `requirePermission` used any way but a direct call (an alias, a value passed on):
    // none outside its own import lines.
    expect(
      places(requirePermissionNotCalled).filter((place) => !place.endsWith("(top level)")),
    ).toEqual([]);
    expect(
      JOB_ROWS.some((row) => M3_BY_KEY.get(row.key)?.handler.name === "credentialsSetAcross"),
    ).toBe(false);
    // `ctx.authorize` with a second argument: only inside `requirePermission` itself.
    expect(
      hits(
        /\bctx\.authorize\s*(?:\?\.\s*)?\(/g,
        (src, masked, open) => argSpans(src, masked, open).length >= 2,
      ),
    ).toEqual(["m3.ts requirePermission"]);
    // `authorize` anywhere but a member call `x.authorize(…)` (destructured, aliased, called
    // bare, through `.call`/`.bind`, or defined): the reviewed places only. Each is the access
    // library's own import and call, a type's member, or a context that defines `authorize`
    // for the code it calls (the server's request context, the advisor sweep's deny-all
    // context, Home's access views). The walk fails any job route that reaches one.
    expect(places(authorizeOutsideMemberCalls)).toEqual([
      "access.ts (top level)",
      "access.ts (top level)",
      "access.ts authorizeCaller",
      "access.ts requestAccessFor",
      "access.ts systemAccess",
      "actions.ts pinBaseline",
      "advisor.ts advisorSweepItems",
      "m3.ts (top level)",
      "server.ts startHangarServer",
      "server.ts startHangarServer",
    ]);
    // The server's own access plumbing (the choke point, the request context and the
    // per-harness visibility probe) and the v1 operations, which are not job rows, authorize
    // by other names, outside any M3 handler.
    expect(
      [...new Set(hits(/\b(?:access\??|context)\.authorize\s*(?:\?\.\s*)?\(/g, () => true))].sort(),
    ).toEqual(
      [
        "access.ts requestAllows",
        "server.ts startHangarServer",
        "v1/access-ops.ts manages",
        "v1/budget.ts get",
        "v1/decisions.ts decisionCommand",
        "v1/delegations.ts list",
        "v1/home.ts seesHostPaths",
        "v1/meta.ts me",
        "v1/meta.ts resolvePrincipal",
        "v1/runs.ts create",
      ].sort(),
    );
    // A bare `ctx.authorize(P)` that does not note the need: two, both in the spec editor's
    // commit path, which only inline routes reach.
    const bare = hits(
      /\bctx\.authorize\s*(?:\?\.\s*)?\(/g,
      (src, masked, open) => argSpans(src, masked, open).length === 1,
    );
    expect(bare).toEqual(["spec-edit.ts commitHomeEdits", "spec-edit.ts homeCommitFailure"]);
    const { reached } = checkJobHandlers(MODULES, jobHandlers());
    expect(reached.has("spec-edit.commitHomeEdits")).toBe(false);
    expect(reached.has("spec-edit.homeCommitFailure")).toBe(false);
  });
});

describe("the checker can fail", () => {
  const PLANTED = (body: string) =>
    [
      'import { requirePermission, type M3Handler } from "./m3";',
      'import { noteNeed } from "./command-context";',
      "",
      "/** Planted. */",
      "export const plantedRun: M3Handler = (ctx) => {",
      '  const other = String(ctx.body["other"]);',
      body,
      '  const job = ctx.submitJob("doctor", ["doctor"]);',
      "  return { job };",
      "};",
      "",
    ].join("\n");
  const check = (source: string) =>
    checkJobHandlers(new Map([...MODULES, ["planted", source]]), [
      { route: "plantedRow", module: "planted", fn: "plantedRun" },
    ]).violations;

  test("a check on another harness is one violation naming the handler", () => {
    const found = check(
      PLANTED('  requirePermission(ctx, "h.secrets.write", { target: { harness: other } });'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.handler).toBe("plantedRun");
    expect(found[0]?.why).toContain('"h.secrets.write"');
  });

  test("no target, or the route's own harness with the need noted, is none", () => {
    expect(check(PLANTED('  requirePermission(ctx, "h.secrets.write");'))).toEqual([]);
    expect(
      check(
        PLANTED(
          [
            '  requirePermission(ctx, "h.secrets.write", { target: { harness: ctx.entry.id } });',
            '  noteNeed("h.secrets.write");',
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  test("the route's own harness without the need noted is a violation", () => {
    const found = check(
      PLANTED(
        '  requirePermission(ctx, "h.secrets.write", { target: { harness: ctx.entry.id } });',
      ),
    );
    expect(found).toHaveLength(1);
  });

  test("a bare authorize that never notes the need, and one with a target, are violations", () => {
    expect(
      check(PLANTED('  if (!ctx.authorize("h.secrets.write").allow) throw new Error("no");')),
    ).toHaveLength(1);
    expect(
      check(
        PLANTED(
          '  if (!ctx.authorize("h.secrets.write", { harness: other }).allow) throw new Error("no");',
        ),
      ),
    ).toHaveLength(1);
    expect(
      check(
        PLANTED(
          [
            '  if (!ctx.authorize("h.secrets.write").allow) throw new Error("no");',
            '  noteNeed("h.secrets.write");',
          ].join("\n"),
        ),
      ),
    ).toEqual([]);
  });

  test("a check after the job is queued is a violation, also through a helper", () => {
    const late = [
      'import { requirePermission, type M3Handler } from "./m3";',
      "",
      "function queue(ctx: Parameters<M3Handler>[0]) {",
      '  return ctx.submitJob("doctor", ["doctor"]);',
      "}",
      "",
      "function guard(ctx: Parameters<M3Handler>[0]) {",
      '  requirePermission(ctx, "h.secrets.write");',
      "}",
      "",
      "export const plantedRun: M3Handler = (ctx) => {",
      "  const job = queue(ctx);",
      "  guard(ctx);",
      "  return { job };",
      "};",
      "",
    ].join("\n");
    const found = check(late);
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toContain("after it queues a job");
    const inOrder = late.replace(
      "  const job = queue(ctx);\n  guard(ctx);",
      "  guard(ctx);\n  const job = queue(ctx);",
    );
    expect(inOrder).not.toBe(late);
    expect(check(inOrder)).toEqual([]);
  });

  test("a check on another harness in a sibling module the handler calls is found", () => {
    const helper = [
      'import { requirePermission, type M3Handler } from "./m3";',
      "",
      "export function writeAcross(ctx: Parameters<M3Handler>[0], other: string): void {",
      '  requirePermission(ctx, "h.secrets.write", { target: { harness: other } });',
      "}",
      "",
    ].join("\n");
    const handler = [
      'import type { M3Handler } from "./m3";',
      'import { writeAcross } from "./planted-helper";',
      "",
      "export const plantedRun: M3Handler = (ctx) => {",
      '  writeAcross(ctx, String(ctx.body["other"]));',
      '  return { job: ctx.submitJob("doctor", ["doctor"]) };',
      "};",
      "",
    ].join("\n");
    const found = checkJobHandlers(
      new Map([...MODULES, ["planted", handler], ["planted-helper", helper]]),
      [{ route: "plantedRow", module: "planted", fn: "plantedRun" }],
    ).violations;
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toContain("planted-helper.ts");
  });

  test("options the guard cannot read as naming no target are one violation each", () => {
    const shapes = {
      "an options variable": [
        "  const opts = { target: { harness: other } };",
        '  requirePermission(ctx, "h.secrets.write", opts);',
      ],
      "a target held in a variable": [
        "  const t = { harness: other };",
        '  requirePermission(ctx, "h.secrets.write", { target: t });',
      ],
      "a spread": [
        "  const o = { target: { harness: other } };",
        '  requirePermission(ctx, "h.secrets.write", { ...o });',
      ],
      "a target a call makes": [
        '  requirePermission(ctx, "h.secrets.write", { target: targetOf(other) });',
      ],
      "a shorthand target": [
        "  const target = { harness: other };",
        '  requirePermission(ctx, "h.secrets.write", { target });',
      ],
      "a quoted target key": [
        '  requirePermission(ctx, "h.secrets.write", { "target": { harness: other } });',
      ],
      "an option the guard does not know": [
        '  requirePermission(ctx, "h.secrets.write", { scope: other });',
      ],
      "requirePermission under another name": [
        "  const check = requirePermission;",
        '  check(ctx, "h.secrets.write");',
      ],
    };
    for (const [shape, lines] of Object.entries(shapes)) {
      const found = check(PLANTED(lines.join("\n")));
      expect(`${shape}: ${found.length}`).toBe(`${shape}: 1`);
      expect(found[0]?.handler).toBe("plantedRun");
    }
    // Spec paths and a message are read and cleared.
    expect(
      check(
        PLANTED('  requirePermission(ctx, "h.secrets.write", { paths: ["a"], message: "no" });'),
      ),
    ).toEqual([]);
  });

  test("authorize reached any way but ctx.authorize(…) is one violation each", () => {
    const shapes = {
      "a destructured authorize": [
        "  const { authorize } = ctx;",
        '  if (!authorize("h.secrets.write", { harness: other }).allow) throw new Error("no");',
      ],
      "an aliased authorize": [
        "  const may = ctx.authorize;",
        '  if (!may("h.secrets.write", { harness: other }).allow) throw new Error("no");',
      ],
      "authorize through .call": [
        '  if (!ctx.authorize.call(ctx, "h.secrets.write", { harness: other }).allow) throw new Error("no");',
      ],
      "an optional call with a target": [
        '  if (!ctx.authorize?.("h.secrets.write", { harness: other }).allow) throw new Error("no");',
      ],
    };
    for (const [shape, lines] of Object.entries(shapes)) {
      const found = check(PLANTED(lines.join("\n")));
      expect(`${shape}: ${found.length}`).toBe(`${shape}: 1`);
    }
  });

  test("a check in a helper under a subdirectory, or behind an import it cannot read, is found", () => {
    const helper = [
      'import { requirePermission, type M3Handler } from "../m3";',
      "",
      "export function writeAcross(ctx: Parameters<M3Handler>[0], other: string): void {",
      '  requirePermission(ctx, "h.secrets.write", { target: { harness: other } });',
      "}",
      "",
    ].join("\n");
    const handler = (from: string) =>
      [
        'import type { M3Handler } from "./m3";',
        `import { writeAcross } from "${from}";`,
        "",
        "export const plantedRun: M3Handler = (ctx) => {",
        '  writeAcross(ctx, String(ctx.body["other"]));',
        '  return { job: ctx.submitJob("doctor", ["doctor"]) };',
        "};",
        "",
      ].join("\n");
    const run = (from: string) =>
      checkJobHandlers(
        new Map([...MODULES, ["planted", handler(from)], ["v1/zz-across", helper]]),
        [{ route: "plantedRow", module: "planted", fn: "plantedRun" }],
      ).violations;
    const nested = run("./v1/zz-across");
    expect(nested).toHaveLength(1);
    expect(nested[0]?.why).toContain("v1/zz-across.ts");
    const unreadable = run("./v1/nowhere");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.why).toContain("cannot read");
    // A namespace import is a body the walk cannot read by name.
    const namespaced = checkJobHandlers(
      new Map([
        ...MODULES,
        [
          "planted",
          [
            'import type { M3Handler } from "./m3";',
            'import * as across from "./v1/zz-across";',
            "",
            "export const plantedRun: M3Handler = (ctx) => {",
            '  across.writeAcross(ctx, String(ctx.body["other"]));',
            '  return { job: ctx.submitJob("doctor", ["doctor"]) };',
            "};",
            "",
          ].join("\n"),
        ],
        ["v1/zz-across", helper],
      ]),
      [{ route: "plantedRow", module: "planted", fn: "plantedRun" }],
    ).violations;
    expect(namespaced).toHaveLength(1);
    expect(namespaced[0]?.why).toContain("cannot read");
  });

  test("the masker keeps code and blanks what is not", () => {
    const src = [
      'const a = /\\(/; // requirePermission(ctx, "x", { target })',
      'const b = "requirePermission(";',
      'const c = `${f("{")} requirePermission(`;',
      "function f(x: string) { return x; }",
    ].join("\n");
    const masked = maskSource(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.includes("requirePermission")).toBe(false);
    expect(masked.includes("f(")).toBe(true);
    const mod = readModule("m", src);
    expect([...mod.units.keys()]).toEqual(["a", "b", "c", "f"]);
  });
});
