/**
 * Scans for the detector patterns the regex engine runs in quadratic time.
 *
 * Each pattern here rescans the text from every place it could start: every
 * `[INST]` reads on to the end looking for `[/INST]`, every `nohup` and every
 * `now do this` to the end of its line looking for a command, every `<iframe`
 * to its `>` (and over a run of spaces after it twice over), every `http://`
 * to the end of its URL and then 80 characters more for every character of
 * it. On 64 KiB of tool output that is seconds per rule, and over a minute
 * for the URL pair; the classifier now reads texts of up to 4 MiB whole
 * (MAX_SCAN_CHARS), so every rule must stay linear. Each scan returns the
 * match its pattern returns, found by reading each character a bounded
 * number of times;
 * linear-rules.test.ts and linear-auto-execute.test.ts check every one
 * against its pattern.
 *
 * The rule patterns stay RegExp objects with their own source and flags
 * (`ScannedPattern`), so the rule table reads as before and every
 * `exec`/`test`/`match` on them takes the scan.
 */

type Found = { readonly index: number; readonly end: number } | null;

/**
 * A pattern whose `exec` is a scan with the same result. Only for patterns
 * with no capture groups and neither `g` nor `y`, which is all `exec` then
 * has to report: where the match starts and what it covers.
 */
class ScannedPattern extends RegExp {
  readonly #find: (text: string) => Found;

  constructor(pattern: RegExp, find: (text: string) => Found) {
    super(pattern.source, pattern.flags);
    this.#find = find;
  }

  /** Derived patterns (`split`, `matchAll`) are plain ones. */
  static override get [Symbol.species](): RegExpConstructor {
    return RegExp;
  }

  override exec(text: string): RegExpExecArray | null {
    const input = String(text);
    const found = this.#find(input);
    if (found === null) return null;
    const match = [input.slice(found.index, found.end)] as unknown as RegExpExecArray;
    match.index = found.index;
    match.input = input;
    match.groups = undefined;
    return match;
  }
}

const isWordChar = (code: number): boolean =>
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x5f;

/** `\s`: ECMAScript WhiteSpace and LineTerminator. */
const isSpace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/** What `.` does not match. */
const isLineTerminator = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

/**
 * Whether `word` (lowercase ASCII) is at `at`, ignoring ASCII case as the
 * `i` flag does without `u`: a non-ASCII letter never folds to an ASCII one.
 */
function hasFolded(text: string, at: number, word: string): boolean {
  if (at < 0 || at + word.length > text.length) return false;
  for (let k = 0; k < word.length; k++) {
    const want = word.charCodeAt(k);
    const got = text.charCodeAt(at + k);
    if (got !== want && !(want >= 0x61 && want <= 0x7a && got === want - 0x20)) return false;
  }
  return true;
}

/** The first `at` in [from, before) with `word` there, ignoring ASCII case, or -1. */
function indexOfFolded(text: string, word: string, from: number, before = text.length): number {
  for (let at = from; at < before && at + word.length <= text.length; at++) {
    if (hasFolded(text, at, word)) return at;
  }
  return -1;
}

/** `\b` before a word character at `at`. */
const startsWord = (text: string, at: number): boolean =>
  at === 0 || !isWordChar(text.charCodeAt(at - 1));

/** `\b` after a word character ending at `at`. */
const endsWord = (text: string, at: number): boolean =>
  at === text.length || !isWordChar(text.charCodeAt(at));

/**
 * `/<\|im_start\|>\s*system|<\|system\|>|\[INST\][\s\S]*?\[\/INST\]/`.
 *
 * The three alternatives start with different text, so the match is the
 * leftmost of each one's first match. `[INST]` matches only if a `[/INST]`
 * follows it, and when one follows a later `[INST]` it follows the first:
 * the first `[INST]` and the first `[/INST]` after it decide that one.
 */
export function findRoleMarker(text: string): Found {
  let found: Found = null;
  const inst = text.indexOf("[INST]");
  if (inst !== -1) {
    const close = text.indexOf("[/INST]", inst + 6);
    if (close !== -1) found = { index: inst, end: close + 7 };
  }
  const system = text.indexOf("<|system|>");
  if (system !== -1 && (found === null || system < found.index)) {
    found = { index: system, end: system + 10 };
  }
  for (
    let at = text.indexOf("<|im_start|>");
    at !== -1 && (found === null || at < found.index);
    at = text.indexOf("<|im_start|>", at + 12)
  ) {
    let p = at + 12;
    while (p < text.length && isSpace(text.charCodeAt(p))) p++;
    if (text.startsWith("system", p)) {
      found = { index: at, end: p + 6 };
      break;
    }
  }
  return found;
}

const DAEMONIZERS = ["nohup", "setsid", "disown"] as const;
const COMMANDS = ["rm", "curl", "wget", "nc", "bash"] as const;

/**
 * `/\b(?:nohup|setsid|disown).*?(?:rm|curl|wget|nc|bash)\b/i`.
 *
 * From a daemonizer the match runs to the first command after it on the same
 * line. When there is none before the line ends, every later daemonizer on
 * that line reads a part of the same text and finds none either, so the
 * search resumes on the next line.
 */
export function findBackgroundCommand(text: string): Found {
  let from = 0;
  for (;;) {
    let start = -1;
    let body = -1;
    for (let at = from; at < text.length && start === -1; at++) {
      if (!startsWord(text, at)) continue;
      for (const word of DAEMONIZERS) {
        if (hasFolded(text, at, word)) {
          start = at;
          body = at + word.length;
          break;
        }
      }
    }
    if (start === -1) return null;
    let at = body;
    for (; at < text.length; at++) {
      for (const command of COMMANDS) {
        if (hasFolded(text, at, command) && endsWord(text, at + command.length)) {
          return { index: start, end: at + command.length };
        }
      }
      if (isLineTerminator(text.charCodeAt(at))) break;
    }
    if (at >= text.length) return null;
    from = at + 1;
  }
}

/** Where `\bsrc\s*=\s*["'](?:javascript:|data:text\/html)` (any case) ends at `at`, or -1. */
function scriptSourceEnd(text: string, at: number): number {
  if (!startsWord(text, at) || !hasFolded(text, at, "src")) return -1;
  let p = at + 3;
  while (p < text.length && isSpace(text.charCodeAt(p))) p++;
  if (text.charCodeAt(p) !== 0x3d /* = */) return -1;
  p++;
  while (p < text.length && isSpace(text.charCodeAt(p))) p++;
  const quote = text.charCodeAt(p);
  if (quote !== 0x22 && quote !== 0x27) return -1;
  p++;
  if (hasFolded(text, p, "javascript:")) return p + 11;
  if (hasFolded(text, p, "data:text/html")) return p + 14;
  return -1;
}

/**
 * `/<iframe\s+[^>]*\bsrc\s*=\s*["'](?:javascript:|data:text\/html)/i`.
 *
 * After `<iframe` and a space the tag runs to the first `>`, and the greedy
 * `[^>]*` makes the match end at the last script `src` before it. Every
 * `<iframe` before that `>` sees the same end, so when the first finds no
 * script source none of them does, and the search resumes after the `>`.
 */
export function findScriptIframe(text: string): Found {
  let from = 0;
  for (;;) {
    const open = indexOfFolded(text, "<iframe", from);
    if (open === -1) return null;
    if (!isSpace(text.charCodeAt(open + 7))) {
      from = open + 1;
      continue;
    }
    const gt = text.indexOf(">", open + 8);
    const tagEnd = gt === -1 ? text.length : gt;
    let end = -1;
    for (let at = indexOfFolded(text, "src", open + 8, tagEnd); at !== -1; ) {
      const found = scriptSourceEnd(text, at);
      if (found !== -1) end = found;
      at = indexOfFolded(text, "src", at + 1, tagEnd);
    }
    if (end !== -1) return { index: open, end };
    if (gt === -1) return null;
    from = gt + 1;
  }
}

/** Where `\b(?:token|secret|api[_\s-]?key|cookie|session)\b` (any case) ends at `at`, or -1. */
function credentialWordEnd(text: string, at: number): number {
  if (!startsWord(text, at)) return -1;
  for (const word of ["token", "secret"]) {
    if (hasFolded(text, at, word) && endsWord(text, at + word.length)) return at + word.length;
  }
  if (hasFolded(text, at, "api")) {
    const sep = text.charCodeAt(at + 3);
    const joined = sep === 0x5f /* _ */ || sep === 0x2d /* - */ || isSpace(sep);
    if (joined && hasFolded(text, at + 4, "key") && endsWord(text, at + 7)) return at + 7;
    if (hasFolded(text, at + 3, "key") && endsWord(text, at + 6)) return at + 6;
  }
  for (const word of ["cookie", "session"]) {
    if (hasFolded(text, at, word) && endsWord(text, at + word.length)) return at + word.length;
  }
  return -1;
}

/**
 * `/(?:https?:\/\/[^\s)]+)[^\n]{0,80}\b(?:token|secret|api[_\s-]?key|cookie|session)\b/i`.
 *
 * The URL runs to the first space or `)`. Backtracking tries the whole URL
 * first, with the 80 characters after it from the far end, then gives the URL
 * back a character at a time; so the match ends at the last credential word
 * starting within 80 characters after the URL (before a newline), or else at
 * the last one starting inside the URL past its first character. Every
 * `http://` inside the same URL sees the same two places, so when the first
 * fails they all do, and the search resumes after the URL.
 */
export function findUrlCredentialPair(text: string): Found {
  let from = 0;
  for (;;) {
    let start = -1;
    let scheme = 0;
    for (
      let at = indexOfFolded(text, "http", from);
      at !== -1;
      at = indexOfFolded(text, "http", at + 1)
    ) {
      if (text.startsWith("://", at + 4)) scheme = 7;
      else if (hasFolded(text, at + 4, "s") && text.startsWith("://", at + 5)) scheme = 8;
      else continue;
      start = at;
      break;
    }
    if (start === -1) return null;
    const host = start + scheme;
    let urlEnd = host;
    while (urlEnd < text.length) {
      const code = text.charCodeAt(urlEnd);
      if (isSpace(code) || code === 0x29 /* ) */) break;
      urlEnd++;
    }
    if (urlEnd === host) {
      from = start + 1;
      continue;
    }
    // The window ends 80 characters on, or at a newline before that. Read to
    // whichever comes first: a search for the newline with no bound read on
    // to the end of the text for every URL on a line, quadratic in a line
    // of short URLs.
    const limit = Math.min(urlEnd + 80, text.length);
    let last = urlEnd;
    while (last < limit && text.charCodeAt(last) !== 0x0a /* \n */) last++;
    for (let at = last; at >= urlEnd; at--) {
      const end = credentialWordEnd(text, at);
      if (end !== -1) return { index: start, end };
    }
    for (let at = urlEnd - 1; at > host; at--) {
      const end = credentialWordEnd(text, at);
      if (end !== -1) return { index: start, end };
    }
    from = urlEnd;
  }
}

const LEADS = ["then", "next", "after that", "finally", "now"] as const;
const VERBS = ["run", "execute", "do"] as const;
const OBJECTS = ["the following", "this", "these"] as const;
const DANGEROUS = ["rm", "curl", "wget", "chmod", "chown", "sudo", "nc", "ncat"] as const;

/** Where the first of `words` at `at` (ignoring ASCII case) ends, or -1. */
function wordEnd(text: string, at: number, words: readonly string[]): number {
  for (const word of words) if (hasFolded(text, at, word)) return at + word.length;
  return -1;
}

/** Where the run of `\s` from `at` ends. */
function blanksEnd(text: string, at: number): number {
  let p = at;
  while (p < text.length && isSpace(text.charCodeAt(p))) p++;
  return p;
}

/**
 * Where `\b(?:then|next|after that|finally|now)\s+(?:run|execute|do)\s+(?:the following|this|these)\b`
 * (any case) ends at `at`, or -1. No word in a group starts another, and a
 * `\s+` gives back nothing a letter can follow, so there is one way to match.
 */
function autoExecuteHeadEnd(text: string, at: number): number {
  if (!startsWord(text, at)) return -1;
  const lead = wordEnd(text, at, LEADS);
  if (lead === -1) return -1;
  const verbAt = blanksEnd(text, lead);
  if (verbAt === lead) return -1;
  const verb = wordEnd(text, verbAt, VERBS);
  if (verb === -1) return -1;
  const objectAt = blanksEnd(text, verb);
  if (objectAt === verb) return -1;
  const object = wordEnd(text, objectAt, OBJECTS);
  return object !== -1 && endsWord(text, object) ? object : -1;
}

/** Where `\b(?:rm|curl|wget|chmod|chown|sudo|nc|ncat)\b` (any case) ends at `at`, or -1. */
function dangerousCommandEnd(text: string, at: number): number {
  if (!startsWord(text, at)) return -1;
  for (const command of DANGEROUS) {
    if (hasFolded(text, at, command) && endsWord(text, at + command.length)) {
      return at + command.length;
    }
  }
  return -1;
}

/**
 * `/\b(?:then|next|after that|finally|now)\s+(?:run|execute|do)\s+(?:the following|this|these)\b[^\n]*\b(?:rm|curl|wget|chmod|chown|sudo|nc|ncat)\b/i`.
 *
 * After its head the match runs to the end of the line and gives it back to
 * the last command on it. When the line has none, every later head that ends
 * on the same line searches a part of the same stretch and finds none either,
 * so that stretch is searched once. A head can still run on past the newline
 * (its blanks may hold one), so later heads are tried, not skipped; one that
 * ends past the stretch searches its own.
 */
export function findAutoExecute(text: string): Found {
  let clearFrom = -1;
  let clearTo = -1;
  for (let at = 0; at < text.length; at++) {
    const head = autoExecuteHeadEnd(text, at);
    if (head === -1 || (head >= clearFrom && head <= clearTo)) continue;
    let lineEnd = text.indexOf("\n", head);
    if (lineEnd === -1) lineEnd = text.length;
    let end = -1;
    for (let q = head + 1; q < lineEnd; q++) {
      const found = dangerousCommandEnd(text, q);
      if (found !== -1) end = found;
    }
    if (end !== -1) return { index: at, end };
    clearFrom = head;
    clearTo = lineEnd;
  }
  return null;
}

/** The rule pattern `pattern`, matched by `find` instead of the regex engine. */
export function scanned(pattern: RegExp, find: (text: string) => Found): RegExp {
  return new ScannedPattern(pattern, find);
}
