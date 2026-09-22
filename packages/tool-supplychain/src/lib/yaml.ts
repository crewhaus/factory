/**
 * The workflow-YAML reader.
 *
 * This is a DELIBERATE SUBSET of YAML 1.2, not a general parser, and it is
 * here rather than as a `yaml` dependency for one reason: adding a
 * third-party dep to this package would rewrite the workspace lockfile, which
 * several packages are being built against concurrently. The subset is the
 * one a GitHub Actions workflow is actually written in — block mappings,
 * block sequences, plain and quoted scalars, literal and folded block
 * scalars, and flow collections — and every construct outside it produces a
 * WARNING the caller surfaces, because a security rule that silently skipped
 * half a file would report "no findings" on the file it could not read.
 *
 * Two traps this parser exists to avoid, both of which a general parser gets
 * wrong for this job:
 *
 *   1. `on:` stays the string "on". A YAML 1.1 parser resolves the bare word
 *      to the boolean `true`, which is why round-tripped workflows sometimes
 *      show up with a literal `true:` key. Keys here are never type-resolved,
 *      so `on` is `on`; `true` is accepted as a spelling of it by the rules,
 *      not by this file.
 *   2. Every scalar carries the SOURCE LINES it came from. A finding inside a
 *      twenty-line `run:` block has to name the line the interpolation is on,
 *      not the line the `run:` key is on, and that mapping survives neither
 *      folding nor chomping — so the raw lines are kept alongside the folded
 *      value rather than reconstructed from it afterwards.
 *
 * Pure: text in, nodes and warnings out.
 */

/** A source line, kept so a finding can name the line it is actually on. */
export type SourceLine = { readonly line: number; readonly text: string };

export type ScalarStyle = "plain" | "single" | "double" | "literal" | "folded" | "flow";

export type YamlScalar = {
  readonly kind: "scalar";
  /** The resolved text. Always a string — nothing here is type-resolved. */
  readonly value: string;
  /** 1-based line the value starts on (first CONTENT line of a block scalar). */
  readonly line: number;
  readonly style: ScalarStyle;
  /** The raw lines the value was read from, in order. */
  readonly sourceLines: ReadonlyArray<SourceLine>;
};

export type YamlNull = { readonly kind: "null"; readonly line: number };

export type YamlEntry = {
  readonly key: string;
  /** 1-based line the key is written on. */
  readonly line: number;
  readonly value: YamlNode;
};

export type YamlMap = {
  readonly kind: "map";
  readonly line: number;
  readonly entries: ReadonlyArray<YamlEntry>;
};

export type YamlSeq = {
  readonly kind: "seq";
  readonly line: number;
  readonly items: ReadonlyArray<YamlNode>;
};

export type YamlNode = YamlScalar | YamlNull | YamlMap | YamlSeq;

export type YamlWarning = {
  /** A stable id so a caller can count or suppress a class of them. */
  readonly code:
    | "tab-indent"
    | "anchor-unsupported"
    | "alias-unsupported"
    | "merge-key-unsupported"
    | "multiple-documents"
    | "unterminated-quote"
    | "unterminated-flow"
    | "duplicate-key"
    | "depth-limit"
    | "too-large"
    | "unparsed-line"
    | "warning-limit";
  readonly line: number;
  readonly message: string;
};

export type YamlParse = {
  /** The first document, or `undefined` for a file that could not be read. */
  readonly doc: YamlNode | undefined;
  readonly warnings: ReadonlyArray<YamlWarning>;
};

/** Refuse a file no workflow is, rather than walk a million lines of it. */
const MAX_LINES = 50_000;
const MAX_CHARS = 4_000_000;
/** Nesting deeper than any real workflow; a guard against a crafted file. */
const MAX_DEPTH = 100;
/**
 * Warnings kept. A file of five thousand duplicate keys produces five
 * thousand warnings, every one of them true and none of them worth the
 * context window — and de-duplicating by scanning a growing array made that
 * file quadratic. Capped, with the cap itself reported.
 */
const MAX_WARNINGS = 200;

// ---------------------------------------------------------------------------
// accessors — every rule reads the tree through these, never by hand

/** The value of `key` in a mapping, or `undefined` for anything else. */
export function mapGet(node: YamlNode | undefined, key: string): YamlNode | undefined {
  if (node === undefined || node.kind !== "map") return undefined;
  for (const entry of node.entries) {
    if (entry.key === key) return entry.value;
  }
  return undefined;
}

/** The entry for `key`, for a finding that must name the KEY's own line. */
export function mapEntry(node: YamlNode | undefined, key: string): YamlEntry | undefined {
  if (node === undefined || node.kind !== "map") return undefined;
  return node.entries.find((entry) => entry.key === key);
}

export function mapKeys(node: YamlNode | undefined): string[] {
  if (node === undefined || node.kind !== "map") return [];
  return node.entries.map((entry) => entry.key);
}

/** The text of a scalar, or `undefined` when the node is not one. */
export function asString(node: YamlNode | undefined): string | undefined {
  return node !== undefined && node.kind === "scalar" ? node.value : undefined;
}

/**
 * A node read as a list.
 *
 * A workflow field that takes a list takes a bare scalar just as often
 * (`runs-on: ubuntu-latest` against `runs-on: [self-hosted, linux]`, `on:
 * push` against `on: [push, pull_request]`), and a rule that handled only the
 * sequence form would miss exactly the single-value case. A MAPPING answers
 * with its values, so `on: {pull_request_target: {...}}` reaches the same
 * rule as the other two spellings.
 */
export function asList(node: YamlNode | undefined): YamlNode[] {
  if (node === undefined) return [];
  if (node.kind === "seq") return [...node.items];
  if (node.kind === "map") return node.entries.map((entry) => entry.value);
  if (node.kind === "null") return [];
  return [node];
}

/** Every source line of a node, for a rule that scans raw text. */
export function sourceLinesOf(node: YamlNode | undefined): ReadonlyArray<SourceLine> {
  return node !== undefined && node.kind === "scalar" ? node.sourceLines : [];
}

/**
 * The lines the RUNNER would interpolate into, which is not the same set as
 * the lines the value was written on.
 *
 * Inside a `|` or `>` block every line is content — a `#` there is a shell
 * comment that the Actions runner still substitutes `${{ }}` into — so the
 * raw lines are the right thing to scan, and only they carry per-line
 * attribution worth keeping. A PLAIN scalar is the opposite case: YAML ends
 * it at the first ` #`, so `run: make # ${{ github.event.issue.title }}` has
 * a value of `make` and the expression never reaches the script. Scanning its
 * raw line reports a critical injection on a comment, which is the false
 * positive this rule set is built to avoid — so the parsed VALUE is scanned
 * instead, attributed to the line the scalar starts on.
 */
export function interpolatedLinesOf(node: YamlNode | undefined): ReadonlyArray<SourceLine> {
  if (node === undefined || node.kind !== "scalar") return [];
  if (node.style === "literal" || node.style === "folded") return node.sourceLines;
  return [{ line: node.line, text: node.value }];
}

// ---------------------------------------------------------------------------
// the parser

type Ctx = {
  readonly lines: ReadonlyArray<string>;
  i: number;
  readonly warnings: YamlWarning[];
  /** `code:line` of everything already reported — the de-duplication key. */
  readonly seen: Set<string>;
};

const warn = (ctx: Ctx, code: YamlWarning["code"], line: number, message: string): void => {
  // One warning per (code, line): a malformed construct inside a loop would
  // otherwise produce a warning list longer than the file it describes.
  const key = `${code}:${line}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  if (ctx.warnings.length > MAX_WARNINGS) return;
  if (ctx.warnings.length === MAX_WARNINGS) {
    ctx.warnings.push({
      code: "warning-limit",
      line,
      message: `more than ${MAX_WARNINGS} distinct problems were found in this file; the rest were not listed, and a file in this state was almost certainly not audited meaningfully`,
    });
    return;
  }
  ctx.warnings.push({ code, line, message });
};

/** Leading spaces, or -1 for a line holding nothing but blanks or a comment. */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && raw[n] === " ") n += 1;
  if (n === raw.length) return -1;
  if (raw[n] === "#") return -1;
  return n;
}

/** Advance past blank lines and whole-line comments. */
function skipIgnorable(ctx: Ctx): void {
  while (ctx.i < ctx.lines.length && indentOf(ctx.lines[ctx.i] as string) === -1) ctx.i += 1;
}

/** `- ` or a bare `-`: a block sequence entry. */
const SEQ_ITEM = /^-(\s+|$)/;

/**
 * `key:` at the head of a line's content, with YAML's rule that the colon
 * must be followed by a space or end the line.
 *
 * That rule is what keeps `run: docker run -p 8080:80` from being read as a
 * key named `run: docker run -p 8080` — the `8080:80` has no space after its
 * colon, so it stays in the value, which is what the shell would see.
 */
function splitKey(content: string): { key: string; rest: string } | undefined {
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content[0] as string;
    const end = findClosingQuote(content, quote);
    if (end === -1) return undefined;
    const after = content.slice(end + 1);
    if (!after.startsWith(":")) return undefined;
    const rest = after.slice(1);
    if (rest !== "" && !rest.startsWith(" ")) return undefined;
    return { key: unquote(content.slice(0, end + 1), quote), rest: rest.trim() };
  }
  for (let n = 0; n < content.length; n += 1) {
    if (content[n] !== ":") continue;
    const next = content[n + 1];
    if (next !== undefined && next !== " ") continue;
    const key = content.slice(0, n).trim();
    if (key === "") return undefined;
    // An explicit key (`? foo`) spans lines and has no shape these rules read.
    if (key.startsWith("?")) return undefined;
    return { key, rest: content.slice(n + 1).trim() };
  }
  return undefined;
}

/** Index of the closing quote of a scalar starting at offset 0, or -1. */
function findClosingQuote(text: string, quote: string): number {
  if (quote === "'") {
    let n = 1;
    while (n < text.length) {
      if (text[n] === "'") {
        // `''` is how a single-quoted scalar escapes its own quote.
        if (text[n + 1] === "'") {
          n += 2;
          continue;
        }
        return n;
      }
      n += 1;
    }
    return -1;
  }
  let n = 1;
  while (n < text.length) {
    if (text[n] === "\\") {
      n += 2;
      continue;
    }
    if (text[n] === '"') return n;
    n += 1;
  }
  return -1;
}

/** Undo one level of quoting, including the escapes each style defines. */
function unquote(raw: string, quote: string): string {
  const body = raw.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_all, esc: string) => {
    if (esc.startsWith("u") || esc.startsWith("x")) {
      return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    }
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "/":
        return "/";
      default:
        return esc;
    }
  });
}

/**
 * Strip a trailing comment from a PLAIN scalar.
 *
 * YAML opens a comment at a `#` preceded by whitespace, and a plain scalar
 * has no quoting of its own — so `run: echo hi # note` really is `echo hi`,
 * exactly as the shell would see it. Quoted and block scalars never come
 * through here, which is why a `run: |` body keeps its `#` comments.
 */
function stripPlainComment(text: string): string {
  const at = text.search(/(^|\s)#/);
  if (at === -1) return text.trimEnd();
  return text.slice(0, at).trimEnd();
}

/** A leading `&anchor` / `*alias` / `!tag` — warned about and stepped over. */
function stripNodeProperties(ctx: Ctx, text: string, line: number): string {
  let rest = text;
  for (;;) {
    const m = /^([&*])(\S+)(\s+|$)/.exec(rest);
    if (m === null) break;
    if (m[1] === "&") {
      warn(
        ctx,
        "anchor-unsupported",
        line,
        `anchor "&${m[2]}" is not resolved here — GitHub Actions does not support YAML anchors in workflow files either, so a workflow relying on one does not run as written`,
      );
    } else {
      warn(
        ctx,
        "alias-unsupported",
        line,
        `alias "*${m[2]}" is not resolved here, so whatever it would have supplied was not audited`,
      );
    }
    rest = rest.slice(m[0].length);
  }
  const tag = /^!\S*(\s+|$)/.exec(rest);
  return tag === null ? rest : rest.slice(tag[0].length);
}

export function parseYamlSubset(text: string): YamlParse {
  const warnings: YamlWarning[] = [];
  if (text.length > MAX_CHARS) {
    return {
      doc: undefined,
      warnings: [
        {
          code: "too-large",
          line: 1,
          message: `file is ${text.length} characters, over the ${MAX_CHARS} limit — no workflow is this size`,
        },
      ],
    };
  }
  const rawLines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  // A trailing newline TERMINATES the last line; it does not add an empty one.
  // Keeping the artifact would give `|+` (keep-chomping) one newline more than
  // the file actually holds, which is the one case where it is observable.
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length > MAX_LINES) {
    return {
      doc: undefined,
      warnings: [
        {
          code: "too-large",
          line: 1,
          message: `file is ${rawLines.length} lines, over the ${MAX_LINES} limit`,
        },
      ],
    };
  }
  const ctx: Ctx = { lines: rawLines, i: 0, warnings, seen: new Set() };

  // A tab in the indentation is not a style question: YAML forbids it, so the
  // runner rejects the file outright. Reporting it beats reporting the
  // findings of a structure that is not the one GitHub would see.
  for (let n = 0; n < rawLines.length; n += 1) {
    const lead = /^[ \t]*/.exec(rawLines[n] as string)?.[0] ?? "";
    if (lead.includes("\t")) {
      warn(
        ctx,
        "tab-indent",
        n + 1,
        "a tab is used for indentation; YAML forbids that and GitHub will refuse the file, so this line's structure was read on a best-effort basis",
      );
    }
  }

  skipIgnorable(ctx);
  if (ctx.i < rawLines.length && (rawLines[ctx.i] as string).trimEnd() === "---") ctx.i += 1;
  const doc = parseNode(ctx, 0, 0);
  skipIgnorable(ctx);
  if (ctx.i < rawLines.length) {
    const rest = (rawLines[ctx.i] as string).trimEnd();
    if (rest === "---" || rest.startsWith("--- ")) {
      warn(
        ctx,
        "multiple-documents",
        ctx.i + 1,
        "the file holds more than one YAML document; only the first was read and audited",
      );
    } else {
      warn(
        ctx,
        "unparsed-line",
        ctx.i + 1,
        `line ${ctx.i + 1} could not be attached to the document, so it and everything after it were not audited`,
      );
    }
  }
  return { doc, warnings };
}

function parseNode(ctx: Ctx, minIndent: number, depth: number): YamlNode {
  skipIgnorable(ctx);
  const line = ctx.i + 1;
  if (depth > MAX_DEPTH) {
    warn(ctx, "depth-limit", line, `nesting deeper than ${MAX_DEPTH} levels was not read`);
    // Consume the over-deep block, or the caller loops on it forever.
    while (ctx.i < ctx.lines.length) {
      const ind = indentOf(ctx.lines[ctx.i] as string);
      if (ind !== -1 && ind < minIndent) break;
      ctx.i += 1;
    }
    return { kind: "null", line };
  }
  if (ctx.i >= ctx.lines.length) return { kind: "null", line };
  const raw = ctx.lines[ctx.i] as string;
  const ind = indentOf(raw);
  if (ind === -1 || ind < minIndent) return { kind: "null", line };
  const content = raw.slice(ind);
  if (content.trimEnd() === "---") return { kind: "null", line };
  if (SEQ_ITEM.test(content)) return parseSeq(ctx, ind, depth);
  if (splitKey(content) !== undefined) return parseMap(ctx, ind, depth);
  return parsePlainBlock(ctx, ind);
}

function parseMap(ctx: Ctx, indent: number, depth: number): YamlMap {
  const startLine = ctx.i + 1;
  const entries: YamlEntry[] = [];
  const seen = new Set<string>();
  while (ctx.i < ctx.lines.length) {
    skipIgnorable(ctx);
    if (ctx.i >= ctx.lines.length) break;
    const raw = ctx.lines[ctx.i] as string;
    const ind = indentOf(raw);
    if (ind === -1 || ind < indent) break;
    if (ind > indent) {
      // More-indented content with no key above it belongs to nothing this
      // parser can attach it to. Say so and step over it rather than drop it.
      warn(
        ctx,
        "unparsed-line",
        ctx.i + 1,
        `line ${ctx.i + 1} is indented under no key and was not audited`,
      );
      ctx.i += 1;
      continue;
    }
    const content = raw.slice(ind);
    if (content.trimEnd() === "---") break;
    const split = splitKey(content);
    if (split === undefined) break;
    const keyLine = ctx.i + 1;
    if (split.key === "<<") {
      warn(
        ctx,
        "merge-key-unsupported",
        keyLine,
        "a `<<` merge key was not expanded, so the keys it would have supplied were not audited",
      );
    }
    if (seen.has(split.key)) {
      warn(
        ctx,
        "duplicate-key",
        keyLine,
        `key "${split.key}" appears twice in this mapping; the LAST one wins, which is what a loader does and is worth reading twice`,
      );
    }
    seen.add(split.key);
    ctx.i += 1;
    const value = parseValue(ctx, split.rest, indent, keyLine, depth);
    // Last-wins, matching a real loader, so a rule reads the value the runner
    // would actually use rather than the one written first.
    const at = entries.findIndex((e) => e.key === split.key);
    if (at === -1) entries.push({ key: split.key, line: keyLine, value });
    else entries[at] = { key: split.key, line: keyLine, value };
  }
  return { kind: "map", line: startLine, entries };
}

function parseSeq(ctx: Ctx, indent: number, depth: number): YamlSeq {
  const startLine = ctx.i + 1;
  const items: YamlNode[] = [];
  while (ctx.i < ctx.lines.length) {
    skipIgnorable(ctx);
    if (ctx.i >= ctx.lines.length) break;
    const raw = ctx.lines[ctx.i] as string;
    const ind = indentOf(raw);
    if (ind === -1 || ind < indent) break;
    if (ind > indent) break;
    const content = raw.slice(ind);
    if (!SEQ_ITEM.test(content)) break;
    const itemLine = ctx.i + 1;
    const afterDash = content.slice(1);
    const rest = afterDash.replace(/^\s+/, "");
    // The column `rest` starts at: `- uses: x` opens a mapping whose indent is
    // where `uses` sits, so its sibling keys on later lines line up with it.
    const restColumn = ind + 1 + (afterDash.length - rest.length);
    ctx.i += 1;
    if (rest === "") {
      items.push(parseNode(ctx, indent + 1, depth + 1));
      continue;
    }
    // A flow collection has to be recognised BEFORE `splitKey` looks at it:
    // `- {uses: x, with: {ref: y}}` contains `uses: ` and would otherwise be
    // read as a block mapping whose key is the literal text `{uses`, leaving
    // the step with no `uses` and no `run` for any rule to see — a silent
    // clean audit on a valid workflow, with no warning to say so.
    if (rest.startsWith("{") || rest.startsWith("[")) {
      items.push(parseValue(ctx, rest, restColumn - 1, itemLine, depth + 1));
      continue;
    }
    const inline = splitKey(rest);
    if (inline !== undefined) {
      items.push(parseInlineMap(ctx, restColumn, itemLine, inline, depth + 1));
      continue;
    }
    if (SEQ_ITEM.test(rest)) {
      // `- - x` opens a nested sequence on the same line. No workflow is
      // written this way, and reading it as the scalar "- x" would be a
      // silent mis-parse, so it is reported rather than guessed at.
      warn(
        ctx,
        "unparsed-line",
        itemLine,
        `line ${itemLine} opens a nested sequence on the same line as its parent item; that shape is not read here and its contents were not audited`,
      );
    }
    items.push(parseValue(ctx, rest, restColumn - 1, itemLine, depth + 1));
  }
  return { kind: "seq", line: startLine, items };
}

/** The mapping a `- key: value` item opens, continuing on the lines below. */
function parseInlineMap(
  ctx: Ctx,
  indent: number,
  keyLine: number,
  first: { key: string; rest: string },
  depth: number,
): YamlMap {
  const value = parseValue(ctx, first.rest, indent, keyLine, depth);
  const entries: YamlEntry[] = [{ key: first.key, line: keyLine, value }];
  const seen = new Set<string>([first.key]);
  while (ctx.i < ctx.lines.length) {
    skipIgnorable(ctx);
    if (ctx.i >= ctx.lines.length) break;
    const raw = ctx.lines[ctx.i] as string;
    const ind = indentOf(raw);
    if (ind !== indent) break;
    const content = raw.slice(ind);
    if (SEQ_ITEM.test(content)) break;
    const split = splitKey(content);
    if (split === undefined) break;
    const line = ctx.i + 1;
    if (seen.has(split.key)) {
      warn(
        ctx,
        "duplicate-key",
        line,
        `key "${split.key}" appears twice in this mapping; the LAST one wins`,
      );
    }
    seen.add(split.key);
    ctx.i += 1;
    const v = parseValue(ctx, split.rest, indent, line, depth);
    const at = entries.findIndex((e) => e.key === split.key);
    if (at === -1) entries.push({ key: split.key, line, value: v });
    else entries[at] = { key: split.key, line, value: v };
  }
  return { kind: "map", line: keyLine, entries };
}

/**
 * The smallest indent a `key:`'s block value may sit at.
 *
 * A block SEQUENCE is allowed to share its key's column — `steps:` on one
 * line and `- uses: …` at the same indent on the next is standard YAML and
 * the spelling half of GitHub's own starter workflows use. Requiring
 * `keyIndent + 1` unconditionally made that file parse as a mapping whose
 * key is the literal text `- uses`, so the job kept its line but lost every
 * step, and the audit reported no findings on a workflow it had not read.
 * A MAPPING at the key's own column is a SIBLING key, not a value, so the
 * relaxation is granted only to a `- ` item.
 */
function blockValueIndent(ctx: Ctx, keyIndent: number): number {
  const at = ctx.i;
  skipIgnorable(ctx);
  const raw = ctx.i < ctx.lines.length ? (ctx.lines[ctx.i] as string) : undefined;
  ctx.i = at;
  if (raw === undefined) return keyIndent + 1;
  const ind = indentOf(raw);
  if (ind !== keyIndent) return keyIndent + 1;
  return SEQ_ITEM.test(raw.slice(ind)) ? keyIndent : keyIndent + 1;
}

/** Everything that can follow a `key:` — on the line, or in the block below. */
function parseValue(
  ctx: Ctx,
  rest: string,
  keyIndent: number,
  keyLine: number,
  depth: number,
): YamlNode {
  const after = stripNodeProperties(ctx, rest, keyLine);
  if (after === "") return parseNode(ctx, blockValueIndent(ctx, keyIndent), depth + 1);
  // A block-scalar header: `|`, `>`, either with a chomping indicator and an
  // explicit indentation indicator, in either order, and a comment after.
  const block = /^([|>])(?:([1-9])([-+])?|([-+])([1-9])?)?[ \t]*(#.*)?$/.exec(after);
  if (block !== null) {
    const explicitRaw = block[2] ?? block[5];
    return parseBlockScalar(
      ctx,
      keyIndent,
      block[1] === ">",
      block[3] ?? block[4] ?? "",
      explicitRaw === undefined ? undefined : Number(explicitRaw),
    );
  }
  if (after.startsWith("[") || after.startsWith("{")) return parseFlow(ctx, after, keyLine);
  if (after.startsWith('"') || after.startsWith("'")) return parseQuoted(ctx, after, keyLine);
  return parsePlainInline(ctx, after, keyIndent, keyLine);
}

/** `|` / `>` — the body of nearly every `run:` step. */
function parseBlockScalar(
  ctx: Ctx,
  keyIndent: number,
  folded: boolean,
  chomp: string,
  explicitIndent: number | undefined,
): YamlScalar {
  const collected: SourceLine[] = [];
  const start = ctx.i;
  let contentIndent = explicitIndent === undefined ? -1 : keyIndent + explicitIndent;
  while (ctx.i < ctx.lines.length) {
    const raw = ctx.lines[ctx.i] as string;
    const blank = raw.trim() === "";
    if (!blank) {
      const ind = (/^ */.exec(raw)?.[0] ?? "").length;
      if (contentIndent === -1) {
        if (ind <= keyIndent) break;
        contentIndent = ind;
      } else if (ind < contentIndent) {
        break;
      }
    }
    collected.push({ line: ctx.i + 1, text: raw });
    ctx.i += 1;
  }
  // Trailing blank lines STAY: they are content that the chomping indicator
  // decides the fate of, and `|+` keeps them. Dropping them here would make
  // keep-chomping indistinguishable from clip.
  const indent = contentIndent === -1 ? keyIndent + 2 : contentIndent;
  const stripped = collected.map((l) => (l.text.length >= indent ? l.text.slice(indent) : ""));
  let value: string;
  if (!folded) {
    value = stripped.join("\n");
  } else {
    // Folding joins a run of ordinary lines with spaces. n BLANK lines fold to
    // n newlines, not n+1 — the break that ends the last text line is the one
    // that was folded away — and a MORE-indented line keeps its own break,
    // which is why a folded block can still carry an indented here-doc.
    let out = "";
    let started = false;
    let blanks = 0;
    let prevMoreIndented = false;
    for (const cur of stripped) {
      if (cur.trim() === "") {
        blanks += 1;
        continue;
      }
      const moreIndented = cur.startsWith(" ");
      if (!started) {
        out = cur;
        started = true;
      } else if (blanks > 0) {
        out += "\n".repeat(blanks) + cur;
      } else {
        out += (moreIndented || prevMoreIndented ? "\n" : " ") + cur;
      }
      blanks = 0;
      prevMoreIndented = moreIndented;
    }
    value = out;
  }
  if (chomp === "-") value = value.replace(/\n+$/, "");
  else if (chomp === "+") value = `${value}\n`;
  else value = value === "" ? "" : `${value.replace(/\n+$/, "")}\n`;
  return {
    kind: "scalar",
    value,
    line: collected.length > 0 ? (collected[0] as SourceLine).line : start + 1,
    style: folded ? "folded" : "literal",
    sourceLines: collected,
  };
}

/** A quoted scalar, which may run past the end of its line. */
function parseQuoted(ctx: Ctx, first: string, keyLine: number): YamlScalar {
  const quote = first[0] as string;
  const lines: SourceLine[] = [{ line: keyLine, text: first }];
  let buffer = first;
  let end = findClosingQuote(buffer, quote);
  while (end === -1 && ctx.i < ctx.lines.length) {
    const raw = ctx.lines[ctx.i] as string;
    lines.push({ line: ctx.i + 1, text: raw });
    // A line break inside a quoted scalar folds to a single space.
    buffer = `${buffer} ${raw.trim()}`;
    ctx.i += 1;
    end = findClosingQuote(buffer, quote);
  }
  const style: ScalarStyle = quote === "'" ? "single" : "double";
  if (end === -1) {
    warn(
      ctx,
      "unterminated-quote",
      keyLine,
      `a ${style}-quoted value starting on line ${keyLine} is never closed; it was read to end of file`,
    );
    return { kind: "scalar", value: buffer.slice(1), line: keyLine, style, sourceLines: lines };
  }
  return {
    kind: "scalar",
    value: unquote(buffer.slice(0, end + 1), quote),
    line: keyLine,
    style,
    sourceLines: lines,
  };
}

/** `[a, b]` / `{a: b}` — joined across lines until the brackets balance. */
function parseFlow(ctx: Ctx, first: string, keyLine: number): YamlNode {
  const lines: SourceLine[] = [{ line: keyLine, text: first }];
  let buffer = first;
  while (!flowBalanced(buffer) && ctx.i < ctx.lines.length) {
    const raw = ctx.lines[ctx.i] as string;
    lines.push({ line: ctx.i + 1, text: raw });
    buffer = `${buffer} ${raw.trim()}`;
    ctx.i += 1;
  }
  if (!flowBalanced(buffer)) {
    warn(
      ctx,
      "unterminated-flow",
      keyLine,
      `a flow collection starting on line ${keyLine} is never closed; its contents were not audited`,
    );
    return { kind: "null", line: keyLine };
  }
  return buildFlow(buffer.trim(), keyLine, lines);
}

function flowBalanced(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let n = 0; n < text.length; n += 1) {
    const ch = text[n] as string;
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') n += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && quote === undefined;
}

/** Split a flow collection's body on the commas that are not nested or quoted. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let n = 0; n < body.length; n += 1) {
    const ch = body[n] as string;
    if (quote !== undefined) {
      if (ch === "\\" && quote === '"') n += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, n));
      start = n + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function buildFlow(text: string, line: number, lines: ReadonlyArray<SourceLine>): YamlNode {
  if (text.startsWith("[") && text.endsWith("]")) {
    return {
      kind: "seq",
      line,
      items: splitFlow(text.slice(1, -1)).map((part) => buildFlow(part, line, lines)),
    };
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const entries: YamlEntry[] = [];
    for (const part of splitFlow(text.slice(1, -1))) {
      const split = splitKey(part);
      if (split === undefined) {
        // A flow mapping key with no value (`{a, b}`) is still a declared key,
        // and `permissions: {actions}` is exactly the shape a rule must see.
        entries.push({ key: flowScalarText(part), line, value: { kind: "null", line } });
        continue;
      }
      entries.push({ key: split.key, line, value: buildFlow(split.rest, line, lines) });
    }
    return { kind: "map", line, entries };
  }
  if (text === "") return { kind: "null", line };
  return { kind: "scalar", value: flowScalarText(text), line, style: "flow", sourceLines: lines };
}

function flowScalarText(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return unquote(text, '"');
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return unquote(text, "'");
  return text;
}

/**
 * A plain scalar that began on the key's line and may continue below.
 *
 * A continuation line is one MORE indented than the key that is not itself a
 * key or a sequence item — the shape a long `if:` condition takes when it is
 * wrapped. Erring the other way would be worse: reading the next key as a
 * continuation swallows it, and a swallowed `run:` is an unaudited `run:`.
 */
function parsePlainInline(ctx: Ctx, first: string, keyIndent: number, keyLine: number): YamlScalar {
  const lines: SourceLine[] = [{ line: keyLine, text: first }];
  const parts = [stripPlainComment(first)];
  while (ctx.i < ctx.lines.length) {
    const raw = ctx.lines[ctx.i] as string;
    const ind = indentOf(raw);
    if (ind === -1 || ind <= keyIndent) break;
    const content = raw.slice(ind);
    if (SEQ_ITEM.test(content) || splitKey(content) !== undefined) break;
    lines.push({ line: ctx.i + 1, text: raw });
    parts.push(stripPlainComment(content));
    ctx.i += 1;
  }
  return {
    kind: "scalar",
    value: parts.join(" ").trim(),
    line: keyLine,
    style: "plain",
    sourceLines: lines,
  };
}

/** A plain scalar standing alone as a whole block (a bare document). */
function parsePlainBlock(ctx: Ctx, indent: number): YamlScalar {
  const line = ctx.i + 1;
  const lines: SourceLine[] = [];
  const parts: string[] = [];
  while (ctx.i < ctx.lines.length) {
    const raw = ctx.lines[ctx.i] as string;
    const ind = indentOf(raw);
    if (ind === -1 || ind < indent) break;
    const content = raw.slice(ind);
    if (SEQ_ITEM.test(content) || splitKey(content) !== undefined) break;
    lines.push({ line: ctx.i + 1, text: raw });
    parts.push(stripPlainComment(content));
    ctx.i += 1;
  }
  return {
    kind: "scalar",
    value: parts.join(" ").trim(),
    line,
    style: "plain",
    sourceLines: lines,
  };
}
