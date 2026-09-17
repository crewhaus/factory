/**
 * A lexical scanner for JavaScript and TypeScript source.
 *
 * It is a SCANNER, not a parser. There is no AST, no type information and no
 * scope analysis — this package declares no parser dependency, and a wrong
 * answer from a real parser costs a dependency, a build step and a version
 * skew that a harness cannot debug. What it does have is a proper lexer: the
 * first pass classifies every character as code, comment or string, so
 * everything downstream (declaration finding, reference finding, TODO
 * scanning) is looking at code rather than at the word "class" inside a
 * sentence in a docstring.
 *
 * What it does NOT handle, stated plainly because a tool that overstates its
 * coverage is worse than one that is narrow and says so:
 *
 *   - JSX/TSX element bodies are treated as ordinary code, so text inside a
 *     JSX child that happens to look like a declaration can be misread, and
 *     a `<` is never read as the start of an element.
 *   - Destructuring declarations (`const { a, b } = x`) are recorded with the
 *     pattern elided rather than one entry per bound name.
 *   - Only one level of class body is walked; a class declared inside a
 *     function, and members of a class expression assigned to a variable, are
 *     not reported as members.
 *   - TypeScript overload signatures appear as separate declarations, and
 *     computed member names (`[Symbol.iterator]`) are skipped.
 *   - `declare module "x" { … }` blocks, decorators and `using` declarations
 *     are not given their own entries.
 *   - Regex-versus-division is decided by the preceding significant token, the
 *     standard heuristic; a division written directly after `)` that a real
 *     parser would resolve by grammar is assumed to be division.
 *
 * Everything here is pure: same text in, same bytes out.
 */

/** Character classification produced by `maskSource`. */
export const KIND_CODE = 0;
export const KIND_COMMENT = 1;
export const KIND_STRING = 2;

export type Masked = {
  /** Same length as the input, with comment and string BODIES blanked. */
  readonly code: string;
  /** Per-character `KIND_*` classification of the ORIGINAL text. */
  readonly kind: Uint8Array;
};

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * True when a `/` at this point starts a regular expression rather than a
 * division. Decided by the last significant character, which is what every
 * lexer without a grammar does: after a value (`)`, `]`, identifier, number)
 * a slash divides; after an operator, a keyword or the start of input it
 * begins a literal.
 */
function regexAllowed(prev: string, prevWord: string): boolean {
  if (prev === "") return true;
  if (/[=(,:[!&|?{};+\-*%~^<>]/.test(prev)) return true;
  if (prev === "\n") return true;
  return [
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "case",
    "do",
    "else",
    "yield",
    "await",
    "delete",
    "void",
    "new",
  ].includes(prevWord);
}

/**
 * Classify every character of `src` as code, comment or string, and return a
 * copy of the text with comment and string bodies replaced by spaces.
 *
 * Quote and comment DELIMITERS are preserved in `code` so a pattern like
 * `from "…"` still matches on the masked text and the original can be sliced
 * at the same offsets. Lengths and newlines are preserved exactly, so an
 * offset into the mask is an offset into the original.
 */
export function maskSource(src: string): Masked {
  const n = src.length;
  const kind = new Uint8Array(n);
  const out = new Array<string>(n);
  // A stack so `${…}` inside a template returns to template mode afterwards.
  const stack: Array<{ mode: "code" | "template"; depth: number }> = [{ mode: "code", depth: 0 }];
  let prevSignificant = "";
  let prevWord = "";
  let i = 0;

  const blank = (from: number, to: number, k: number): void => {
    for (let j = from; j < to && j < n; j++) {
      kind[j] = k;
      out[j] = src[j] === "\n" ? "\n" : " ";
    }
  };
  const keep = (at: number, k: number): void => {
    kind[at] = k;
    out[at] = src[at] as string;
  };

  while (i < n) {
    const top = stack[stack.length - 1] as { mode: "code" | "template"; depth: number };
    const c = src[i] as string;

    if (top.mode === "template") {
      if (c === "\\") {
        blank(i, i + 2, KIND_STRING);
        i += 2;
        continue;
      }
      if (c === "`") {
        keep(i, KIND_STRING);
        stack.pop();
        prevSignificant = "`";
        prevWord = "";
        i += 1;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        keep(i, KIND_CODE);
        keep(i + 1, KIND_CODE);
        stack.push({ mode: "code", depth: 0 });
        prevSignificant = "{";
        prevWord = "";
        i += 2;
        continue;
      }
      blank(i, i + 1, KIND_STRING);
      i += 1;
      continue;
    }

    // --- code mode ---
    if (c === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      keep(i, KIND_COMMENT);
      keep(i + 1, KIND_COMMENT);
      blank(i + 2, j, KIND_COMMENT);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      const end = Math.min(j + 2, n);
      keep(i, KIND_COMMENT);
      keep(i + 1, KIND_COMMENT);
      blank(i + 2, end, KIND_COMMENT);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const d = src[j] as string;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === c || d === "\n") break;
        j += 1;
      }
      keep(i, KIND_STRING);
      blank(i + 1, j, KIND_STRING);
      if (j < n && src[j] === c) keep(j, KIND_STRING);
      i = j < n && src[j] === c ? j + 1 : j;
      prevSignificant = '"';
      prevWord = "";
      continue;
    }
    if (c === "`") {
      keep(i, KIND_STRING);
      stack.push({ mode: "template", depth: 0 });
      i += 1;
      continue;
    }
    if (c === "/" && regexAllowed(prevSignificant, prevWord)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j] as string;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        keep(i, KIND_STRING);
        blank(i + 1, j, KIND_STRING);
        keep(j, KIND_STRING);
        let k = j + 1;
        while (k < n && /[a-z]/.test(src[k] as string)) k++;
        blank(j + 1, k, KIND_STRING);
        i = k;
        prevSignificant = "/";
        prevWord = "";
        continue;
      }
      // Unterminated on this line: treat as ordinary division after all.
    }
    if (c === "{") top.depth += 1;
    else if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        keep(i, KIND_CODE);
        stack.pop();
        i += 1;
        prevSignificant = "}";
        prevWord = "";
        continue;
      }
      top.depth = Math.max(0, top.depth - 1);
    }
    keep(i, KIND_CODE);
    if (!/\s/.test(c)) {
      prevSignificant = c;
      if (IDENT_CHAR.test(c)) {
        let s = i;
        while (s > 0 && IDENT_CHAR.test(src[s - 1] as string)) s--;
        prevWord = src.slice(s, i + 1);
      } else {
        prevWord = "";
      }
    } else if (c === "\n") {
      // A newline is significant for the regex heuristic (statement start)
      // but must not clear the last word, which may end the previous line.
      prevSignificant = prevSignificant === "" ? "\n" : prevSignificant;
    }
    i += 1;
  }

  return { code: out.join(""), kind };
}

// ---------------------------------------------------------------------------
// offsets and lines

/** Offsets at which each line begins; index 0 is line 1. */
export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for an offset, by binary search over `lineStarts`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Brace depth BEFORE each character, computed over masked code. */
function braceDepths(code: string): Int32Array {
  const depths = new Int32Array(code.length);
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    depths[i] = depth;
    const c = code[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth = Math.max(0, depth - 1);
  }
  return depths;
}

/**
 * Where the statement beginning at `from` ends.
 *
 * A brace body wins: the first `{` outside parentheses is matched to its
 * partner. Otherwise the statement ends at the first `;`, or at a newline
 * that does not look like a continuation (the previous non-space character
 * is not an operator that demands more input).
 */
function statementEnd(code: string, from: number): number {
  let parens = 0;
  let i = from;
  let lastSignificant = "";
  while (i < code.length) {
    const c = code[i] as string;
    if (c === "(" || c === "[") parens += 1;
    else if (c === ")" || c === "]") parens = Math.max(0, parens - 1);
    else if (c === "{" && parens === 0) {
      let depth = 0;
      for (let j = i; j < code.length; j++) {
        if (code[j] === "{") depth += 1;
        else if (code[j] === "}") {
          depth -= 1;
          if (depth === 0) return j;
        }
      }
      return code.length - 1;
    } else if (c === ";" && parens === 0) return i;
    else if (c === "\n" && parens === 0) {
      // A statement continues when the line ends on an operator, and also
      // when the NEXT line begins with one — the fluent-builder shape
      // (`const x = z` then `.string()`) ends on a bare identifier, which
      // would otherwise look like the end of the statement.
      let j = i + 1;
      while (j < code.length && /\s/.test(code[j] as string)) j++;
      const next = j < code.length ? (code[j] as string) : "";
      const continues =
        (lastSignificant !== "" && /[=,+\-*/&|?:<>({[]/.test(lastSignificant)) ||
        /[.)\]},:?+\-*/&|=<>]/.test(next);
      if (!continues) return i - 1;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return code.length - 1;
}

// ---------------------------------------------------------------------------
// declarations

export type DeclarationKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable"
  | "method"
  | "property"
  | "accessor";

export type Declaration = {
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly exported: boolean;
  readonly isDefaultExport: boolean;
  /** Set for class members: the class they belong to. */
  readonly parent?: string;
  /** Collapsed source of the declaration head, capped. */
  readonly signature: string;
  readonly modifiers: readonly string[];
};

const MAX_SIGNATURE_CHARS = 200;

function signatureOf(src: string, from: number, to: number): string {
  const head = src.slice(from, Math.min(to + 1, src.length));
  const stop = head.indexOf("{");
  const text = (stop === -1 ? head : head.slice(0, stop)).replace(/\s+/g, " ").trim();
  const capped =
    text.length > MAX_SIGNATURE_CHARS ? `${text.slice(0, MAX_SIGNATURE_CHARS)}…` : text;
  return capped;
}

const TOP_PATTERNS: ReadonlyArray<{
  kind: DeclarationKind;
  re: RegExp;
  nameGroup: number;
}> = [
  {
    kind: "function",
    re: /^(?<mods>(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?)function(?<gen>\s*\*)?\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 3,
  },
  {
    kind: "class",
    re: /^(?<mods>(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?)class\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "interface",
    re: /^(?<mods>(?:export\s+)?(?:declare\s+)?)interface\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "enum",
    re: /^(?<mods>(?:export\s+)?(?:declare\s+)?(?:const\s+)?)enum\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "type",
    re: /^(?<mods>(?:export\s+)?(?:declare\s+)?)type\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "namespace",
    re: /^(?<mods>(?:export\s+)?(?:declare\s+)?)(?:namespace|module)\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "variable",
    re: /^(?<mods>(?:export\s+)?(?:declare\s+)?)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
];

const MEMBER_RE =
  /^(?<mods>(?:(?:public|private|protected|readonly|static|abstract|override|declare|async)\s+)*)(?<acc>(?:get|set)\s+)?(?<gen>\*\s*)?(?<name>#?[A-Za-z_$][\w$]*)\s*(?<after>[(<:=?!])/;

/**
 * Every declaration in a file, in source order.
 *
 * Top-level declarations are found at brace depth 0; class members are found
 * one level inside a class body. Both carry the line span of the whole
 * declaration, which is what makes a "read lines 40-95" follow-up possible
 * without reading the file whole.
 */
export function scanDeclarations(src: string): Declaration[] {
  const { code } = maskSource(src);
  const depths = braceDepths(code);
  const starts = lineStarts(code);
  const out: Declaration[] = [];

  const classBodies: Array<{ name: string; from: number; to: number }> = [];

  for (let li = 0; li < starts.length; li++) {
    const lineStart = starts[li] as number;
    const lineEnd = li + 1 < starts.length ? (starts[li + 1] as number) - 1 : code.length;
    if (depths[lineStart] !== 0) continue;
    const raw = code.slice(lineStart, lineEnd);
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trimStart();
    if (text === "") continue;
    const at = lineStart + indent;

    for (const pattern of TOP_PATTERNS) {
      const m = pattern.re.exec(text);
      if (m === null) continue;
      const name = m[pattern.nameGroup];
      if (name === undefined) break;
      const mods = (m.groups?.["mods"] ?? "").trim();
      const end = statementEnd(code, at);
      const decl: Declaration = {
        kind: pattern.kind,
        name,
        startLine: lineAt(starts, at),
        endLine: lineAt(starts, end),
        exported: mods.startsWith("export"),
        isDefaultExport: /\bdefault\b/.test(mods),
        signature: signatureOf(src, at, end),
        modifiers: mods === "" ? [] : mods.split(/\s+/),
      };
      out.push(decl);
      if (pattern.kind === "class") {
        const bodyStart = code.indexOf("{", at);
        if (bodyStart !== -1 && bodyStart <= end) {
          classBodies.push({ name, from: bodyStart, to: end });
        }
      }
      break;
    }
  }

  for (const body of classBodies) {
    const inner = (depths[body.from] as number) + 1;
    for (let li = 0; li < starts.length; li++) {
      const lineStart = starts[li] as number;
      if (lineStart <= body.from || lineStart >= body.to) continue;
      if (depths[lineStart] !== inner) continue;
      const lineEnd = li + 1 < starts.length ? (starts[li + 1] as number) - 1 : code.length;
      const raw = code.slice(lineStart, lineEnd);
      const indent = raw.length - raw.trimStart().length;
      const text = raw.trimStart();
      const m = MEMBER_RE.exec(text);
      if (m === null) continue;
      const name = m.groups?.["name"];
      const after = m.groups?.["after"];
      if (name === undefined || after === undefined) continue;
      if (["if", "for", "while", "switch", "catch", "return", "new", "typeof"].includes(name)) {
        continue;
      }
      const mods = (m.groups?.["mods"] ?? "").trim();
      const accessor = (m.groups?.["acc"] ?? "").trim();
      const at = lineStart + indent;
      const end = statementEnd(code, at);
      const kind: DeclarationKind =
        accessor !== "" ? "accessor" : after === "(" || after === "<" ? "method" : "property";
      out.push({
        kind,
        name,
        startLine: lineAt(starts, at),
        endLine: lineAt(starts, end),
        exported: false,
        isDefaultExport: false,
        parent: body.name,
        signature: signatureOf(src, at, end),
        modifiers: [
          ...(mods === "" ? [] : mods.split(/\s+/)),
          ...(accessor === "" ? [] : [accessor]),
        ],
      });
    }
  }

  return out.sort(
    (a, b) => a.startLine - b.startLine || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// imports and exports

export type ImportRecord = {
  readonly specifier: string;
  readonly line: number;
  readonly kind: "import" | "export-from" | "dynamic" | "require";
  readonly typeOnly: boolean;
  /** Imported binding names, `*` for a namespace import, empty for side effects. */
  readonly names: readonly string[];
};

const STATIC_IMPORT_RE =
  /\bimport\s+(?<type>type\s+)?(?<clause>[^;'"]*?)\s*from\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const BARE_IMPORT_RE = /\bimport\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const EXPORT_FROM_RE =
  /\bexport\s+(?<type>type\s+)?(?<clause>\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const REQUIRE_RE = /\brequire\s*\(\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;

function clauseNames(clause: string): string[] {
  const text = clause.trim();
  if (text === "") return [];
  if (text.startsWith("*")) return ["*"];
  const names: string[] = [];
  const braced = /\{([^}]*)\}/.exec(text);
  const beforeBrace = braced === null ? text : text.slice(0, braced.index);
  const defaultName = beforeBrace.replace(/,/g, " ").trim().split(/\s+/)[0];
  if (defaultName !== undefined && defaultName !== "" && /^[\w$]+$/.test(defaultName)) {
    names.push(defaultName);
  }
  if (braced !== null) {
    for (const part of (braced[1] as string).split(",")) {
      const piece = part.replace(/\btype\s+/g, "").trim();
      if (piece === "") continue;
      const asMatch = /\s+as\s+([\w$]+)$/.exec(piece);
      names.push(asMatch !== null ? (asMatch[1] as string) : (piece.split(/\s+/)[0] as string));
    }
  }
  return names;
}

/**
 * Every module specifier this file pulls in.
 *
 * Matching runs against the MASKED text so an `import` written inside a
 * comment or a string is not counted, and the specifier itself is sliced out
 * of the original at the same offset, which is why blanking preserves length.
 */
export function scanImports(src: string): ImportRecord[] {
  const { code } = maskSource(src);
  const starts = lineStarts(code);
  const out: ImportRecord[] = [];
  const seen = new Set<string>();

  const push = (
    index: number,
    specStart: number,
    specLength: number,
    kind: ImportRecord["kind"],
    typeOnly: boolean,
    names: string[],
  ): void => {
    const specifier = src.slice(specStart, specStart + specLength);
    const line = lineAt(starts, index);
    const key = `${line}:${kind}:${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ specifier, line, kind, typeOnly, names });
  };

  for (const m of code.matchAll(STATIC_IMPORT_RE)) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    push(
      m.index as number,
      specStart,
      spec.length,
      "import",
      (m.groups?.["type"] ?? "") !== "",
      clauseNames(m.groups?.["clause"] ?? ""),
    );
  }
  for (const m of code.matchAll(EXPORT_FROM_RE)) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    push(
      m.index as number,
      specStart,
      spec.length,
      "export-from",
      (m.groups?.["type"] ?? "") !== "",
      clauseNames(m.groups?.["clause"] ?? ""),
    );
  }
  for (const m of code.matchAll(DYNAMIC_IMPORT_RE)) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    push(m.index as number, specStart, spec.length, "dynamic", false, []);
  }
  for (const m of code.matchAll(REQUIRE_RE)) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    push(m.index as number, specStart, spec.length, "require", false, []);
  }
  for (const m of code.matchAll(BARE_IMPORT_RE)) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    const line = lineAt(starts, m.index as number);
    // A bare `import "x"` only counts when no clause form already claimed
    // this line, since `import x from "y"` matches this pattern too.
    if (out.some((r) => r.line === line && r.specifier === spec)) continue;
    push(m.index as number, specStart, spec.length, "import", false, []);
  }

  return out.sort((a, b) => a.line - b.line || (a.specifier < b.specifier ? -1 : 1));
}

export type ExportRecord = {
  readonly name: string;
  readonly line: number;
  readonly kind: "declaration" | "named" | "default" | "star";
  /** Set when the export re-exports from another module. */
  readonly from?: string;
};

/** Every name this file exports, as far as a lexical read can tell. */
export function scanExports(src: string): ExportRecord[] {
  const { code } = maskSource(src);
  const starts = lineStarts(code);
  const out: ExportRecord[] = [];

  for (const decl of scanDeclarations(src)) {
    if (decl.exported && decl.parent === undefined) {
      out.push({
        name: decl.name,
        line: decl.startLine,
        kind: decl.isDefaultExport ? "default" : "declaration",
      });
    }
  }
  for (const m of code.matchAll(
    /\bexport\s+(?<type>type\s+)?\{(?<body>[^}]*)\}(?<tail>\s*from\s*['"][^'"\n]*['"])?/g,
  )) {
    const line = lineAt(starts, m.index as number);
    const tail = m.groups?.["tail"];
    let from: string | undefined;
    if (tail !== undefined) {
      const specStart = (m.index as number) + m[0].length - 1;
      let s = specStart - 1;
      while (s > 0 && code[s] !== '"' && code[s] !== "'") s--;
      from = src.slice(s + 1, specStart);
    }
    for (const part of (m.groups?.["body"] ?? "").split(",")) {
      const piece = part.replace(/\btype\s+/g, "").trim();
      if (piece === "") continue;
      const asMatch = /\s+as\s+([\w$]+)$/.exec(piece);
      const name = asMatch !== null ? (asMatch[1] as string) : (piece.split(/\s+/)[0] as string);
      out.push({ name, line, kind: "named", ...(from === undefined ? {} : { from }) });
    }
  }
  for (const m of code.matchAll(
    /\bexport\s+\*(?:\s+as\s+(?<ns>[\w$]+))?\s*from\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g,
  )) {
    const spec = m.groups?.["spec"] ?? "";
    const specStart = (m.index as number) + m[0].length - 1 - spec.length;
    out.push({
      name: m.groups?.["ns"] ?? "*",
      line: lineAt(starts, m.index as number),
      kind: "star",
      from: src.slice(specStart, specStart + spec.length),
    });
  }
  for (const m of code.matchAll(/\bexport\s+default\s+(?![\s{])/g)) {
    const line = lineAt(starts, m.index as number);
    if (out.some((e) => e.line === line && e.kind === "default")) continue;
    out.push({ name: "default", line, kind: "default" });
  }

  return out.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------------------
// identifiers and comments

export type Occurrence = {
  readonly line: number;
  readonly column: number;
  readonly text: string;
};

/**
 * Every occurrence of `name` in CODE — comments and string literals excluded.
 *
 * This is lexical: it finds the characters, not the binding. A local variable
 * that shadows an imported one, a property with the same name on an unrelated
 * object, and a name reached through a namespace alias are all indistinguishable
 * here. That is the honest limit of a scanner without scope analysis.
 */
export function findOccurrences(src: string, name: string, maxLineChars = 300): Occurrence[] {
  if (name === "") return [];
  const { kind } = maskSource(src);
  const starts = lineStarts(src);
  const out: Occurrence[] = [];
  let from = 0;
  while (true) {
    const idx = src.indexOf(name, from);
    if (idx === -1) break;
    from = idx + name.length;
    const before = idx > 0 ? (src[idx - 1] as string) : "";
    const after = idx + name.length < src.length ? (src[idx + name.length] as string) : "";
    if (before !== "" && IDENT_CHAR.test(before)) continue;
    if (after !== "" && IDENT_CHAR.test(after)) continue;
    if (kind[idx] !== KIND_CODE) continue;
    const line = lineAt(starts, idx);
    const lineStart = starts[line - 1] as number;
    const lineEnd = line < starts.length ? (starts[line] as number) - 1 : src.length;
    const text = src.slice(lineStart, lineEnd).trim();
    out.push({
      line,
      column: idx - lineStart + 1,
      text: text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…` : text,
    });
  }
  return out;
}

export type TodoRecord = {
  readonly marker: string;
  readonly author?: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
};

/** Markers `scanTodos` recognises when the caller names none. */
export const DEFAULT_TODO_MARKERS: readonly string[] = ["TODO", "FIXME", "HACK", "XXX"];

/**
 * TODO-style markers found in COMMENTS only.
 *
 * A marker inside a string literal is not a note to a maintainer, it is data —
 * usually this very tool's own test fixture — so the mask decides. An author
 * is read from the two conventional forms, `TODO(dave):` and `TODO @dave:`.
 */
export function scanTodos(
  src: string,
  markers: readonly string[] = DEFAULT_TODO_MARKERS,
  maxTextChars = 200,
): TodoRecord[] {
  const { kind } = maskSource(src);
  const starts = lineStarts(src);
  const out: TodoRecord[] = [];
  for (const marker of markers) {
    let from = 0;
    while (true) {
      const idx = src.indexOf(marker, from);
      if (idx === -1) break;
      from = idx + marker.length;
      if (kind[idx] !== KIND_COMMENT) continue;
      const before = idx > 0 ? (src[idx - 1] as string) : "";
      if (before !== "" && IDENT_CHAR.test(before)) continue;
      const line = lineAt(starts, idx);
      const lineStart = starts[line - 1] as number;
      const lineEnd = line < starts.length ? (starts[line] as number) - 1 : src.length;
      const rest = src.slice(idx + marker.length, lineEnd);
      const authorMatch = /^\s*(?:\(\s*@?([\w.@-]+)\s*\)|@([\w.-]+))/.exec(rest);
      const author = authorMatch?.[1] ?? authorMatch?.[2];
      const body = rest
        .slice(authorMatch === null ? 0 : authorMatch[0].length)
        .replace(/^\s*[:\-–]\s*/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      out.push({
        marker,
        ...(author === undefined ? {} : { author }),
        line,
        column: idx - lineStart + 1,
        text: body.length > maxTextChars ? `${body.slice(0, maxTextChars)}…` : body,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

// ---------------------------------------------------------------------------
// caller-supplied patterns

/**
 * True when `pattern` contains a repetition nested inside a repetition, the
 * shape that makes a JavaScript regular expression backtrack exponentially.
 *
 * `AstQuery` compiles a pattern the caller wrote and runs it against every
 * declaration name in a tree, and a JavaScript regex cannot be interrupted
 * once it is running: `^(a|a|aa)+$` against a twenty-six-character identifier
 * measured at six hundred milliseconds HERE, so a few thousand names is a
 * harness that never comes back. There is no timeout to reach for, so the
 * pattern is refused before it is compiled.
 *
 * The test is the classic star-height one, done with a scanner rather than a
 * pattern of its own: a group with an unbounded quantifier (`*`, `+`, `{n,}`)
 * on it whose body itself contains an unbounded quantifier or an alternation.
 * That rejects `(a+)+`, `(a*)*` and `(a|a)+`, and leaves the patterns a caller
 * actually writes over declaration names — `^get[A-Z]\w*`, `^(get|set)Foo$`,
 * `Service$` — alone, because in those the quantifier and the group are not
 * nested in each other.
 */
export function hasNestedRepetition(pattern: string): boolean {
  const opens: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      opens.push(i);
      continue;
    }
    if (c !== ")") continue;
    const start = opens.pop();
    if (start === undefined) continue;
    if (!unboundedQuantifierAt(pattern, i + 1)) continue;
    if (repeatsOrBranches(pattern.slice(start + 1, i))) return true;
  }
  return false;
}

/** `*`, `+` or an open-ended `{n,}` at this offset. */
function unboundedQuantifierAt(pattern: string, at: number): boolean {
  const c = pattern[at];
  if (c === "*" || c === "+") return true;
  if (c !== "{") return false;
  const close = pattern.indexOf("}", at);
  if (close === -1) return false;
  return /^\{\d*,\s*\}$/.test(pattern.slice(at, close + 1));
}

/** True when a group body has an unbounded quantifier or a top-level `|`. */
function repeatsOrBranches(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "|") return true;
    if (c === "*" || c === "+") return true;
    if (c === "{" && unboundedQuantifierAt(body, i)) return true;
  }
  return false;
}
