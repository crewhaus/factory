/**
 * Reads of a spec's TEXT (crewhaus.yaml) without the regex engine.
 *
 * A model writes this text too: `crewhaus init` writes the model's spec as
 * it came, and an optimizer write-back with a model mutator rewrites
 * `agent.instructions`, where the YAML writer keeps a raw U+2028 and runs of
 * blank lines inside the block scalar. Each pattern below rescanned a run on
 * such text: a `(.*)$` gave back a run of spaces one character at a time
 * when the rest of the line held a U+2028 or a lone `\r`, which `.` does not
 * match; a multiline `^\s+` read every blank line after each line start; and
 * the provenance fields' `[A-Za-z][A-Za-z0-9_]*=` read a long word with no
 * `=` from every letter in it. A 40 000-space line took one to two seconds
 * per reader, and some of these run for every API response. Each function
 * returns what its pattern returned, reading each character a bounded number
 * of times; spec-lines.test.ts compares them.
 */
import { isLineTerminator, isSpace, restIsOneLine, skipSpace } from "./line-parts";

/** `[A-Za-z0-9_]`. */
const isWordChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** `[A-Za-z0-9_.-]`: a key character after the first. */
const isKeyChar = (code: number): boolean => isWordChar(code) || code === 0x2e || code === 0x2d;

const isLetter = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);

const COLON = 0x3a;

/**
 * `line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`))?.[1]` for a `key` that
 * is a plain name: the text after `key:`, or undefined. Each `\s*` takes its
 * whole run (a name and `:` are not whitespace), and `(.*)$` the rest of the
 * line when it holds no line terminator; giving whitespace back cannot help.
 */
export function keyedScalar(line: string, key: string): string | undefined {
  const at = skipSpace(line, 0);
  if (!line.startsWith(key, at)) return undefined;
  const colon = skipSpace(line, at + key.length);
  if (line.charCodeAt(colon) !== COLON) return undefined;
  const value = skipSpace(line, colon + 1);
  return restIsOneLine(line, value) ? line.slice(value) : undefined;
}

/** The end of the key `[A-Za-z0-9_][A-Za-z0-9_.-]*` starting at `at`, or -1. */
function keyEnd(line: string, at: number): number {
  if (!isWordChar(line.charCodeAt(at))) return -1;
  let end = at + 1;
  while (end < line.length && isKeyChar(line.charCodeAt(end))) end++;
  return end;
}

/**
 * `line.match(/^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/)` as
 * `[indent, key, value]`, or null. The key runs to its last key character,
 * which `:` must follow. Then either `\s+` and the rest of the line (no line
 * terminator in it), or the end of the line right after the `:`, where the
 * value is undefined.
 */
export function keyLineParts(line: string): [string, string, string | undefined] | null {
  const at = skipSpace(line, 0);
  const end = keyEnd(line, at);
  if (end === -1 || line.charCodeAt(end) !== COLON) return null;
  const indent = line.slice(0, at);
  const key = line.slice(at, end);
  if (end + 1 === line.length) return [indent, key, undefined];
  const value = skipSpace(line, end + 1);
  if (value === end + 1 || !restIsOneLine(line, value)) return null;
  return [indent, key, line.slice(value)];
}

/**
 * `line.match(/^(\s*)([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/)` as
 * `[indent, key, value]`, or null.
 */
export function keyValueParts(line: string): [string, string, string] | null {
  const at = skipSpace(line, 0);
  const end = keyEnd(line, at);
  if (end === -1) return null;
  const colon = skipSpace(line, end);
  if (line.charCodeAt(colon) !== COLON) return null;
  const value = skipSpace(line, colon + 1);
  if (!restIsOneLine(line, value)) return null;
  return [line.slice(0, at), line.slice(at, end), line.slice(value)];
}

/**
 * `line.replace(/#.*$/, "")`: the line without its first `#` and what
 * follows, when no line terminator follows it. A `#` with one after it
 * cannot reach the end, so the match is the first `#` after the last line
 * terminator in the line.
 */
export function withoutTrailingComment(line: string): string {
  let last = -1;
  for (let at = 0; at < line.length; at++) {
    if (isLineTerminator(line.charCodeAt(at))) last = at;
  }
  const hash = line.indexOf("#", last + 1);
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * `new RegExp(`^\\s+${key}\\s*:`, "m").test(text)` for a `key` that is a plain
 * name: whether `key:` follows whitespace that starts at the start of a line.
 *
 * `\s+` takes the whole run of whitespace from a line start (the name is not
 * whitespace), and line terminators are whitespace, so a line start inside a
 * run is one right after a terminator in it. The run qualifies when it starts
 * the text, or holds a terminator before its last character; then the name,
 * any whitespace and a `:` must follow it. Each run is read once, where the
 * pattern read the rest of a run of blank lines from every line start in it.
 */
export function hasIndentedKey(text: string, key: string): boolean {
  let at = 0;
  while (at < text.length) {
    if (!isSpace(text.charCodeAt(at))) {
      at++;
      continue;
    }
    const start = at;
    let terminator = -1;
    while (at < text.length && isSpace(text.charCodeAt(at))) {
      if (terminator === -1 && isLineTerminator(text.charCodeAt(at))) terminator = at;
      at++;
    }
    const startsALine = start === 0 || (terminator !== -1 && terminator < at - 1);
    if (startsALine && text.startsWith(key, at)) {
      if (text.charCodeAt(skipSpace(text, at + key.length)) === COLON) return true;
    }
  }
  return false;
}

/**
 * The `[name, value]` pairs `/([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|\S+)/g` finds
 * in `text`, in order.
 *
 * A name starts at the first letter of a run of `[A-Za-z0-9_]` and runs to
 * its end, which `=` must follow; every start in the run reaches that end,
 * so when the first fails they all do, and the search resumes after the
 * run. The value is a quoted string when a closing `"` follows, else the run
 * of non-space characters (which needs one). Each run, and each quoted value,
 * is read once; a search for a closing `"` that finds none is the last one
 * that can start, since any `"` after it would have closed it.
 */
export function namedValues(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let from = 0;
  while (from < text.length) {
    if (!isWordChar(text.charCodeAt(from))) {
      from++;
      continue;
    }
    let start = from;
    let end = from;
    while (end < text.length && isWordChar(text.charCodeAt(end))) end++;
    while (start < end && !isLetter(text.charCodeAt(start))) start++;
    if (start === end || text.charCodeAt(end) !== 0x3d /* = */) {
      from = end;
      continue;
    }
    const value = end + 1;
    const close = text.charCodeAt(value) === 0x22 /* " */ ? text.indexOf('"', value + 1) : -1;
    let valueEnd: number;
    if (close !== -1) {
      valueEnd = close + 1;
    } else {
      valueEnd = value;
      while (valueEnd < text.length && !isSpace(text.charCodeAt(valueEnd))) valueEnd++;
      if (valueEnd === value) {
        from = value;
        continue;
      }
    }
    out.push([text.slice(start, end), text.slice(value, valueEnd)]);
    from = valueEnd;
  }
  return out;
}
