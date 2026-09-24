/**
 * What a permission rule is checked against, for one tool call.
 *
 * A rule used to be matched against the raw input the model sent, while the
 * tool ran on that input AFTER its schema had parsed it — unknown keys
 * stripped, defaults filled in. The two could disagree, and every
 * disagreement was a way past a rule: a decoy key the tool never reads, an
 * extra argument that stopped a deny from matching, a left-out field the tool
 * then filled with the very value a deny named. And a path was matched as a
 * string, so `build/../src` passed `build/**` and a symlinked directory led
 * somewhere no rule had looked.
 *
 * So a call is described the way the tool will see it:
 *
 * 1. The input is parsed with the tool's own schema. A call that does not
 *    parse cannot run, and is refused before any rule is read.
 * 2. When the tool declares `operativeArgs`, the values of those fields are
 *    read from the PARSED input (a declared `default` stands in for an
 *    omitted field) and canonicalised by kind:
 *    - a `path` is resolved against the workspace root, `..` collapsed, and
 *      its directories followed through symlinks (the deepest one that
 *      exists is realpath'd) — so it names the place the tool will actually
 *      touch — then written relative to the workspace. When the last
 *      component is itself a symlink, its target is a second value. A path
 *      that ends up outside the workspace, or whose destination cannot be
 *      worked out, is flagged, and the matcher never lets it satisfy an allow
 *      rule and always lets it satisfy a deny.
 *    - a `url` is parsed (WHATWG) and matched as its `href`.
 *    - a `command` held as an array (an argv) is joined with spaces.
 *
 * The matcher itself stays pure; everything that touches the filesystem is
 * here.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { OperativeArg, OperativeArgKind, RegisteredTool } from "@crewhaus/tool-catalog";
import type { OperativeValue, OperativeValueKind } from "@crewhaus/tool-permission-matcher";
import { validateToolInput } from "@crewhaus/tool-validate";

// The declaration kinds (tool-catalog) and the value kinds (matcher) are two
// spellings of one union; this fails to compile the day they drift apart.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: SameUnion<OperativeArgKind, OperativeValueKind> = true;
void kindsAgree;

export type PermissionSubject =
  | {
      readonly ok: true;
      /** The schema-parsed input: what the tool's `execute` will receive. */
      readonly input: unknown;
      /** Canonical values of the tool's `operativeArgs`; absent when the tool declares none. */
      readonly operativeValues?: ReadonlyArray<OperativeValue>;
    }
  | {
      readonly ok: false;
      /** The schema's validation message, naming what is wrong with the input. */
      readonly reason: string;
    };

export type PermissionSubjectOptions = {
  /** The directory a relative path is resolved against. Default: `process.cwd()`, the root every workspace tool resolves against. */
  readonly workspaceRoot?: string;
};

/**
 * Parse `rawInput` with the tool's schema and read its operative values. The
 * input passed here must be exactly the one that will be handed to
 * `executeTool`, so the rule and the tool see the same call.
 */
export function preparePermissionSubject(
  tool: RegisteredTool,
  rawInput: unknown,
  opts: PermissionSubjectOptions = {},
): PermissionSubject {
  const validation = validateToolInput(tool, rawInput);
  if (!validation.ok) return { ok: false, reason: validation.error.message };
  const operativeValues = operativeValuesFor(tool, validation.value, opts);
  return {
    ok: true,
    input: validation.value,
    ...(operativeValues !== undefined ? { operativeValues } : {}),
  };
}

/**
 * The canonical operative values of an ALREADY PARSED input, or `undefined`
 * when the tool declares no `operativeArgs` (the matcher then falls back to
 * the input's string values).
 */
export function operativeValuesFor(
  tool: RegisteredTool,
  parsedInput: unknown,
  opts: PermissionSubjectOptions = {},
): ReadonlyArray<OperativeValue> | undefined {
  if (tool.operativeArgs === undefined) return undefined;
  const root = opts.workspaceRoot ?? process.cwd();
  const values: OperativeValue[] = [];
  for (const arg of tool.operativeArgs) {
    for (const raw of readOperativeField(parsedInput, arg)) {
      values.push(...canonicalValues(arg.kind, raw, root));
    }
  }
  return values;
}

/**
 * Every value of one declared field. Dots descend into objects; an array
 * anywhere on the way is walked element by element — except a `command`
 * field that IS an array of strings, which is one argv and is joined.
 */
export function readOperativeField(input: unknown, arg: OperativeArg): string[] {
  const segments = arg.field.split(".");
  const out: string[] = [];
  const walk = (value: unknown, i: number, depth: number): void => {
    if (depth > 64) return;
    if (Array.isArray(value)) {
      if (
        i === segments.length &&
        arg.kind === "command" &&
        value.length > 0 &&
        value.every((v) => typeof v === "string")
      ) {
        out.push(value.join(" "));
        return;
      }
      for (const element of value) walk(element, i, depth + 1);
      return;
    }
    if (i === segments.length) {
      if (typeof value === "string") out.push(value);
      else if (arg.kind === "id" && typeof value === "number" && Number.isFinite(value)) {
        out.push(String(value));
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    const key = segments[i] as string;
    if (!Object.hasOwn(value, key)) return;
    walk((value as Record<string, unknown>)[key], i + 1, depth + 1);
  };
  walk(input, 0, 0);
  if (out.length === 0 && arg.default !== undefined) out.push(arg.default);
  return out;
}

function canonicalValues(kind: OperativeArgKind, raw: string, root: string): OperativeValue[] {
  switch (kind) {
    case "path":
      return canonicalPath(raw, root);
    case "url":
      return [canonicalUrl(raw)];
    default:
      return [{ kind, canonical: [raw] }];
  }
}

function toPosix(p: string): string {
  return path.sep === "\\" ? p.split(path.sep).join("/") : p;
}

/** A relative path that leaves its base: `..`, `../x`, or another drive. */
function climbsOut(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** True when the NAME exists, whether or not a symlink there leads anywhere. */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `target` would land with every symlink on the way followed — the
 * deepest ancestor that exists is resolved, a dangling link is followed a hop
 * by hand (a missing target is still a door), and the parts that do not exist
 * yet are appended. Mirrors `resolveLocation` in `@crewhaus/tool-fs`, which is
 * what the file tools check containment against. Throws when the chain
 * cannot be resolved; the caller treats that as "cannot tell where it lands".
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const link = readlinkSync(probe);
    real = resolveLocation(path.resolve(realpathSync(path.dirname(probe)), link), depth + 1);
  }
  return tail.length > 0 ? path.join(real, ...tail) : real;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The value(s) a path names. Parent directories are followed through
 * symlinks — `build/link/app.ts` with `build/link → ../src` IS `src/app.ts`
 * for every tool. The last component is kept as written, because a tool that
 * replaces or deletes it acts on the link itself; but when that last
 * component is a symlink, a tool that opens it acts on the target instead, so
 * the target is a second value. An allow then has to cover both, and a deny
 * fires on either.
 */
function canonicalPath(raw: string, root: string): OperativeValue[] {
  const rootAbs = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  // Lexical: `..` collapsed, symlinks untouched.
  const lexicalAbs = path.resolve(rootAbs, raw);
  const lexicalRel = path.relative(rootAbs, lexicalAbs);
  const spellings = [raw, toPosix(lexicalRel === "" ? "." : lexicalRel), toPosix(lexicalAbs)];
  const outside: OperativeValue = {
    kind: "path",
    canonical: [],
    spellings,
    outsideWorkspace: true,
  };
  const located = (real: string): OperativeValue => {
    const rel = path.relative(rootReal, real);
    if (climbsOut(rel)) return outside;
    const relPosix = rel === "" ? "." : toPosix(rel);
    return {
      kind: "path",
      canonical:
        relPosix === "." ? [".", toPosix(real)] : [relPosix, `./${relPosix}`, toPosix(real)],
      spellings,
    };
  };
  if (climbsOut(lexicalRel)) return [outside];
  let at: string;
  try {
    at =
      lexicalAbs === rootAbs
        ? rootReal
        : path.join(resolveLocation(path.dirname(lexicalAbs)), path.basename(lexicalAbs));
  } catch {
    // Where it lands cannot be worked out: an allow must not guess.
    return [outside];
  }
  const values = [located(at)];
  if (isSymlink(at)) {
    let target: string;
    try {
      target = resolveLocation(at);
    } catch {
      return [...values, outside];
    }
    if (target !== at) values.push(located(target));
  }
  return values;
}

function canonicalUrl(raw: string): OperativeValue {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL the tool could fetch. Nothing canonical to grant against; a
    // deny still reads what was written.
    return { kind: "url", canonical: [], spellings: [raw] };
  }
  const href = url.href;
  const canonical = [href];
  // `https://example.com` parses to `https://example.com/`. Both spell the
  // same request, so a rule written either way matches.
  if (url.pathname === "/" && url.search === "" && url.hash === "" && href.endsWith("/")) {
    canonical.push(href.slice(0, -1));
  }
  return { kind: "url", canonical, spellings: [raw] };
}
