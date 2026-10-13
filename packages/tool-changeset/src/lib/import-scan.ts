import { isRegExpSpace } from "./scan-text";

/** Where the run of `\s` starting at `at` ends. */
function blanksEnd(line: string, at: number): number {
  let i = at;
  while (i < line.length && isRegExpSpace(line.charCodeAt(i))) i++;
  return i;
}

const isQuote = (c: number): boolean => c === 0x22 || c === 0x27;

/**
 * `(['"])([^'"]+)\N` at `at`: a quote, one or more characters that are not
 * quotes, and the same quote again. The module and the index after it, or
 * null.
 */
function quotedAt(line: string, at: number): { spec: string; end: number } | null {
  const open = line.charCodeAt(at);
  if (!isQuote(open)) return null;
  let i = at + 1;
  while (i < line.length && !isQuote(line.charCodeAt(i))) i++;
  if (i === at + 1 || line.charCodeAt(i) !== open) return null;
  return { spec: line.slice(at + 1, i), end: i + 1 };
}

/** `import\s+(?:type\s+)?\{` at `at`: the index of its `{`, or -1. */
function importOpen(line: string, at: number): number {
  if (!line.startsWith("import", at)) return -1;
  let i = blanksEnd(line, at + 6);
  if (i === at + 6) return -1;
  if (line.charCodeAt(i) === 0x7b) return i;
  if (!line.startsWith("type", i)) return -1;
  const afterType = blanksEnd(line, i + 4);
  if (afterType === i + 4) return -1;
  i = afterType;
  return line.charCodeAt(i) === 0x7b ? i : -1;
}

/** `(?:const|let|var)\s*\{` at `at`: the index of its `{`, or -1. */
function requireOpen(line: string, at: number): number {
  const word = line.startsWith("const", at)
    ? 5
    : line.startsWith("let", at) || line.startsWith("var", at)
      ? 3
      : 0;
  if (word === 0) return -1;
  const i = blanksEnd(line, at + word);
  return line.charCodeAt(i) === 0x7b ? i : -1;
}

/** `\s*from\s*(['"])([^'"]+)\2` at `at`. */
function fromTail(line: string, at: number): { spec: string; end: number } | null {
  const i = blanksEnd(line, at);
  if (!line.startsWith("from", i)) return null;
  return quotedAt(line, blanksEnd(line, i + 4));
}

/** `\s*=\s*require\(\s*(['"])([^'"]+)\5\s*\)` at `at`. */
function requireTail(line: string, at: number): { spec: string; end: number } | null {
  let i = blanksEnd(line, at);
  if (line.charCodeAt(i) !== 0x3d) return null;
  i = blanksEnd(line, i + 1);
  if (!line.startsWith("require(", i)) return null;
  const quoted = quotedAt(line, blanksEnd(line, i + 8));
  if (quoted === null) return null;
  const close = blanksEnd(line, quoted.end);
  return line.charCodeAt(close) === 0x29 ? { spec: quoted.spec, end: close + 1 } : null;
}

/**
 * The braced names and the module of each named import or destructured
 * require on `line`, in order: what
 * `/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\5\s*\)/g`
 * matched, its `{…}` and its module.
 *
 * As a global search, each `import {` or `let {` read on to the first `}`,
 * so a line of them with none, or with the `}` far away and no `from`
 * after it, was read again from every one: quadratic in the line, on
 * documents of up to 4 MiB from the workspace. Every part of the pattern is
 * fixed by the one before it (the blanks are taken whole, `[^}]*` runs to
 * the first `}`, `[^'"]+` to the first quote), so it is read here by hand,
 * in one pass: every opener with a `{` after it shares the first `}` after
 * that `{` with the openers before it, and every opener sharing that `}`
 * shares what follows it, so the `}` is searched for once and what follows
 * it read once.
 */
export function namedImports(line: string): Array<{ body: string; spec: string }> {
  const out: Array<{ body: string; spec: string }> = [];
  let close = -2;
  let fromAt = -1;
  let fromFound: { spec: string; end: number } | null = null;
  let requireAt = -1;
  let requireFound: { spec: string; end: number } | null = null;
  let at = 0;
  while (at < line.length) {
    const c = line.charCodeAt(at);
    const isImport = c === 0x69;
    const open = isImport
      ? importOpen(line, at)
      : c === 0x63 || c === 0x6c || c === 0x76
        ? requireOpen(line, at)
        : -1;
    if (open === -1) {
      at++;
      continue;
    }
    if (close !== -1 && close <= open) close = line.indexOf("}", open + 1);
    if (close === -1) {
      at++;
      continue;
    }
    let tail: { spec: string; end: number } | null;
    if (isImport) {
      if (fromAt !== close) {
        fromAt = close;
        fromFound = fromTail(line, close + 1);
      }
      tail = fromFound;
    } else {
      if (requireAt !== close) {
        requireAt = close;
        requireFound = requireTail(line, close + 1);
      }
      tail = requireFound;
    }
    if (tail === null) {
      at++;
      continue;
    }
    out.push({ body: line.slice(open + 1, close), spec: tail.spec });
    at = tail.end;
  }
  return out;
}
