/**
 * Every command a source file spells out: the string and template literals
 * that start with `crewhaus ` (or `cd … && crewhaus …`), and every backtick
 * span `` `crewhaus …` `` inside a literal, which is how a note names a
 * command.
 *
 * Comments go first, through `Bun.Transpiler`, so a command a comment
 * mentions is not mistaken for one a screen shows. A `${…}` in a template
 * becomes the placeholder `<value>`, so `--session ${id}` reads as
 * `--session <value>` and is checked like any other placeholder.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const VALUE = "<value>";

/** What ends an expression: after one of these, a `/` divides; otherwise it opens a regex. */
const ENDS_EXPRESSION = /[\w$)\]}'"`]$/;
const KEYWORDS_BEFORE_REGEX =
  /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|throw|delete|new)$/;

function cookEscape(source: string, at: number): { readonly text: string; readonly next: number } {
  const e = source[at + 1] ?? "";
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  if (e in simple) return { text: simple[e] as string, next: at + 2 };
  if (e === "u") {
    if (source[at + 2] === "{") {
      const close = source.indexOf("}", at + 3);
      return {
        text: String.fromCodePoint(Number.parseInt(source.slice(at + 3, close), 16)),
        next: close + 1,
      };
    }
    return {
      text: String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16)),
      next: at + 6,
    };
  }
  if (e === "x") {
    return {
      text: String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 4), 16)),
      next: at + 4,
    };
  }
  if (e === "\n") return { text: "", next: at + 2 };
  return { text: e, next: at + 2 };
}

/**
 * The cooked text of every string and template literal in comment-free
 * JavaScript, `${…}` replaced by {@link VALUE}.
 */
export function stringLiterals(js: string): string[] {
  const out: string[] = [];
  let i = 0;

  const skipRegex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < js.length) {
      const c = js[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) break;
      else if (c === "\n") return start + 1; // not a regex after all
      j += 1;
    }
    j += 1;
    while (j < js.length && /[a-z]/.test(js[j] as string)) j += 1;
    return j;
  };

  /** Read a quoted string starting at `start`; returns the index after it. */
  const readQuoted = (start: number, quote: string, collect: boolean): number => {
    let j = start + 1;
    let text = "";
    while (j < js.length && js[j] !== quote) {
      if (js[j] === "\\") {
        const cooked = cookEscape(js, j);
        text += cooked.text;
        j = cooked.next;
        continue;
      }
      text += js[j];
      j += 1;
    }
    if (collect) out.push(text);
    return j + 1;
  };

  /** Read a template starting at `start` (the backtick); returns the index after it. */
  const readTemplate = (start: number): number => {
    let j = start + 1;
    let text = "";
    while (j < js.length && js[j] !== "`") {
      if (js[j] === "\\") {
        const cooked = cookEscape(js, j);
        text += cooked.text;
        j = cooked.next;
        continue;
      }
      if (js[j] === "$" && js[j + 1] === "{") {
        j = skipExpression(j + 2);
        text += VALUE;
        continue;
      }
      text += js[j];
      j += 1;
    }
    out.push(text);
    return j + 1;
  };

  /** Skip a `${…}` body, collecting the literals inside it; returns the index after `}`. */
  const skipExpression = (start: number): number => {
    let depth = 1;
    let j = start;
    while (j < js.length) {
      const c = js[j] as string;
      if (c === "'" || c === '"') {
        j = readQuoted(j, c, true);
        continue;
      }
      if (c === "`") {
        j = readTemplate(j);
        continue;
      }
      if (c === "{") depth += 1;
      if (c === "}") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return j;
  };

  while (i < js.length) {
    const c = js[i] as string;
    if (c === "'" || c === '"') {
      i = readQuoted(i, c, true);
      continue;
    }
    if (c === "`") {
      i = readTemplate(i);
      continue;
    }
    if (c === "/") {
      const before = js.slice(Math.max(0, i - 40), i).trimEnd();
      if (!ENDS_EXPRESSION.test(before) || KEYWORDS_BEFORE_REGEX.test(before)) {
        i = skipRegex(i);
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** The commands a literal's text spells: the text itself, and its backtick spans. */
export function commandsIn(text: string): string[] {
  const found: string[] = [];
  const trimmed = text.trim();
  if (
    trimmed.startsWith("crewhaus ") ||
    (trimmed.startsWith("cd ") && trimmed.includes("&& crewhaus "))
  ) {
    found.push(trimmed);
  }
  for (const m of text.matchAll(/`((?:cd [^`]*&& )?crewhaus [^`]*)`/g)) found.push(m[1] as string);
  return found;
}

/** Comment-free JavaScript for one source file. */
export function stripComments(source: string, loader: "js" | "ts"): string {
  return new Bun.Transpiler({ loader, deadCodeElimination: false }).transformSync(source);
}

export type FoundCommand = { readonly file: string; readonly command: string };

/** Every command spelled in the files under `root` that `keep` selects. */
export function commandsUnder(
  root: string,
  loader: "js" | "ts",
  keep: (rel: string) => boolean,
): FoundCommand[] {
  const out: FoundCommand[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && keep(`${rel}/`)) walk(path);
        continue;
      }
      if (!keep(rel)) continue;
      const js = stripComments(readFileSync(path, "utf8"), loader);
      for (const literal of stringLiterals(js)) {
        for (const command of commandsIn(literal)) out.push({ file: rel, command });
      }
    }
  };
  walk(root);
  return out;
}
