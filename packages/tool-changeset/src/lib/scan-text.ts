/**
 * Line reads that used to be regular expressions, and rescanned a run.
 *
 * Each pattern below tried every start inside a run of whitespace (or of
 * fence or comment characters) and, when what follows the run was not what
 * it needed, rescanned the rest of the run from each before giving the start
 * up: quadratic in the run's length. A diff and a document are whatever the
 * workspace or the model hands over, so each is a scan that gives the same
 * answer.
 */

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
export function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** A code unit `.` does not match without the `s` flag. */
function isLineBreak(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

/** `text` before its first ` as `: what `text.split(/\s+as\s+/)[0]` returned. */
export function beforeAs(text: string): string {
  let i = 0;
  while (i < text.length) {
    if (!isRegExpSpace(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const runStart = i;
    while (i < text.length && isRegExpSpace(text.charCodeAt(i))) i++;
    if (
      text.charCodeAt(i) === 0x61 &&
      text.charCodeAt(i + 1) === 0x73 &&
      i + 2 < text.length &&
      isRegExpSpace(text.charCodeAt(i + 2))
    ) {
      return text.slice(0, runStart);
    }
  }
  return text;
}

/**
 * A fence line's marker and info string: what
 * `/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)` captured, or `null`. Up to three
 * whitespace characters, a run of three or more of one fence character, and a
 * rest holding no line break.
 */
export function fenceOpening(line: string): { marker: string; info: string } | null {
  let start = 0;
  while (start < 3 && start < line.length && isRegExpSpace(line.charCodeAt(start))) start++;
  const ch = line.charCodeAt(start);
  if (ch !== 0x60 && ch !== 0x7e) return null;
  let end = start;
  while (end < line.length && line.charCodeAt(end) === ch) end++;
  if (end - start < 3) return null;
  for (let i = end; i < line.length; i++) if (isLineBreak(line.charCodeAt(i))) return null;
  return { marker: line.slice(start, end), info: line.slice(end) };
}

/** A code unit `[\s\-*>]` matches. */
const isCommentFill = (c: number): boolean =>
  isRegExpSpace(c) || c === 0x2d || c === 0x2a || c === 0x3e;

function allCommentFill(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) if (!isCommentFill(text.charCodeAt(i))) return false;
  return true;
}

/**
 * Whether `text` is only a comment opener and filler: what
 * `/^(?:\/\/+|\/\*+|#+|\*+|--|<!--)?[\s\-*>]*$/.test(text)` answered. An
 * opener of `*`, `--` or `/*` needs no case of its own past its first
 * character, because `*` and `-` are filler too.
 */
export function onlyCommentOpener(text: string): boolean {
  if (allCommentFill(text, 0)) return true;
  if (text.startsWith("//")) {
    let i = 2;
    while (text.charCodeAt(i) === 0x2f) i++;
    return allCommentFill(text, i);
  }
  if (text.startsWith("/*")) return allCommentFill(text, 1);
  if (text.startsWith("#")) {
    let i = 1;
    while (text.charCodeAt(i) === 0x23) i++;
    return allCommentFill(text, i);
  }
  if (text.startsWith("<!--")) return allCommentFill(text, 4);
  return false;
}
