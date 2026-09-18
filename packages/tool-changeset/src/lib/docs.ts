/**
 * Stale-documentation detection, as pure functions over text.
 *
 * The whole design follows from one asymmetry: a MISSED stale symbol costs a
 * reader one confusing minute, and a WRONG "this symbol is gone" costs the
 * tool its reputation — people stop reading its output, and then it catches
 * nothing at all. So every decision here is taken in the direction of saying
 * less.
 *
 * Three consequences, each load-bearing:
 *
 *  1. What counts as a symbol reference is narrow (see `extractDocRefs`).
 *     Prose is not searched for identifiers; a reference has to be marked up
 *     as code by the person who wrote the document.
 *  2. What counts as "still exists" is wide (see `buildTokenIndex`). The
 *     question asked of the source tree is "does this identifier appear
 *     anywhere at all" — in code, in a comment, in a string, in a config
 *     file. A symbol that survives only as a string key is not reported.
 *     This is why the module does not parse the source: a parser answers a
 *     narrower question ("is it declared") and every narrowing is a new way
 *     to be wrong out loud. `SymbolOutline` and `AstQuery` in
 *     `@crewhaus/tool-code` are the tools for the declaration question.
 *  3. A document whose references mostly do not resolve is treated as the
 *     wrong document, not as thirty findings (see `checkRefs`).
 */

/** How a reference was written, which is how much it is trusted. */
export type Evidence = "import" | "backtick";

export type DocRef = {
  /** The reference exactly as the document wrote it, e.g. `Foo.bar` or `run()`. */
  readonly symbol: string;
  /** The identifier actually looked up: the head of a member path, call parens stripped. */
  readonly base: string;
  readonly doc: string;
  /** 1-based line in the document. */
  readonly line: number;
  readonly evidence: Evidence;
  readonly context: string;
};

export type ExtractOptions = {
  /** Which reference kinds to collect; default both. */
  readonly include?: "imports" | "backticks" | "both";
  /**
   * Module specifier prefixes that mean "this project". A fenced import from
   * anywhere else is ignored: `react`'s exports are not this tree's problem.
   * Relative specifiers always count.
   */
  readonly localPrefixes?: ReadonlyArray<string>;
  /** Shortest identifier considered; default 4. `id` and `fn` are noise. */
  readonly minLength?: number;
  /**
   * Require a backticked identifier to LOOK like an API name — an interior
   * capital, an underscore, a `$`, a member path or call parens. Default on;
   * without it `build`, `run` and `format` flood the output.
   */
  readonly requireDistinctive?: boolean;
  /** Symbols to never report, on top of `DEFAULT_IGNORED`. */
  readonly ignore?: ReadonlyArray<string>;
};

const MAX_CONTEXT_CHARS = 160;

/**
 * Words that are shaped like identifiers and are not this tree's symbols.
 *
 * Every one of these has been seen inside backticks in ordinary
 * documentation. The list is short on purpose: the distinctive-shape rule
 * does most of the filtering, and a stoplist that tries to enumerate the
 * world's vocabulary is a maintenance burden that still misses.
 */
export const DEFAULT_IGNORED: ReadonlySet<string> = new Set([
  "JavaScript",
  "TypeScript",
  "JSON",
  "YAML",
  "TOML",
  "HTML",
  "HTTP",
  "HTTPS",
  "GitHub",
  "GitLab",
  "README",
  "CHANGELOG",
  "LICENSE",
  "NOTICE",
  "MacOS",
  "macOS",
  "iOS",
  "npm",
  "npx",
  "bun",
  "bunx",
  "pnpm",
  "yarn",
  "git",
  "curl",
  "sudo",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "void",
  "async",
  "await",
  "const",
  "class",
  "function",
  "import",
  "export",
  "return",
  "default",
  "package.json",
  "tsconfig.json",
]);

/** A bare identifier: what a symbol reference has to reduce to. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** `Foo.bar.baz` — a member path whose head is what we can actually check. */
const MEMBER_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/**
 * Reduce a backticked span to the identifier to look up, or nothing.
 *
 * Nothing is the common case and that is intended: a span holding a command,
 * a path, a flag, a type expression or a sentence is not a symbol reference
 * this tool can check, and guessing at one is how false findings are born.
 */
export function referenceOf(span: string): { symbol: string; base: string } | undefined {
  const trimmed = span.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return undefined;
  // `run()` and `run(...)` are unambiguous symbol references; the arguments
  // are not part of the name.
  const call = /^([A-Za-z_$][A-Za-z0-9_$.]*)\((?:\.{3}|)\)$/.exec(trimmed);
  const bare = call === null ? trimmed : (call[1] as string);
  if (IDENT.test(bare)) return { symbol: trimmed, base: bare };
  if (MEMBER_PATH.test(bare)) {
    // Only the HEAD is checked. If `Foo` exists but `Foo.bar` does not, this
    // module cannot tell a removed method from a method it cannot see
    // lexically, so it says nothing rather than guessing.
    return { symbol: trimmed, base: bare.slice(0, bare.indexOf(".")) };
  }
  return undefined;
}

/** An identifier shaped like an API name rather than like an English word. */
export function isDistinctive(name: string): boolean {
  if (/[_$]/.test(name)) return true;
  if (/^[a-z]+[A-Z]/.test(name)) return true; // camelCase
  if (/^[A-Z]/.test(name) && /[a-z]/.test(name) && /[A-Z]/.test(name.slice(1))) return true; // PascalCase
  return /^[A-Z][A-Z0-9]+$/.test(name) && name.length > 2; // SCREAMING_CASE without the underscore
}

type FenceState = { open: boolean; marker: string; info: string };

const BACKTICK = 96;

/**
 * The inline code spans on one line, scanned by hand rather than by regex.
 *
 * The obvious pattern is `/(`+)([^`]+?)\1/g`, and it is quadratic: on a run of
 * backticks that nothing closes, the engine re-walks the whole run from every
 * offset inside it. A document is allowed to be four megabytes, and four
 * megabytes of backticks never comes back — the tool hangs rather than
 * answers, which is the one failure a deterministic tool cannot recover from.
 * One pass over the line costs O(n) and reads the same spans the regex did,
 * closing run included: an opening run of three closed by a run of one
 * consumes one backtick and leaves the rest to open the next span.
 */
export function codeSpans(line: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) !== BACKTICK) {
      i++;
      continue;
    }
    const openStart = i;
    while (i < line.length && line.charCodeAt(i) === BACKTICK) i++;
    const openLength = i - openStart;
    let close = i;
    while (close < line.length && line.charCodeAt(close) !== BACKTICK) close++;
    if (close === line.length) break; // nothing on this line closes the run
    let closeLength = 0;
    while (close + closeLength < line.length && line.charCodeAt(close + closeLength) === BACKTICK) {
      closeLength++;
    }
    spans.push(line.slice(i, close));
    i = close + Math.min(openLength, closeLength);
  }
  return spans;
}

/** Named imports from a project-local module inside a fenced block. */
function importedNames(line: string, localPrefixes: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const isLocal = (spec: string): boolean =>
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    localPrefixes.some((prefix) => spec === prefix || spec.startsWith(prefix));

  for (const m of line.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*(['"])([^'"]+)\5\s*\)/g,
  )) {
    const body = m[1] ?? m[4] ?? "";
    const spec = m[3] ?? m[6] ?? "";
    if (!isLocal(spec)) continue;
    for (const piece of body.split(",")) {
      const cleaned = piece.replace(/\btype\s+/g, "").trim();
      if (cleaned === "") continue;
      // `a as b`: `a` is the name that has to exist in the source; `b` is a
      // local alias the document invented and nothing can check.
      const name = (cleaned.split(/\s+as\s+/)[0] as string).trim();
      if (IDENT.test(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Every symbol reference in one markdown document.
 *
 * Two forms are recognised, and deliberately only two:
 *
 *   - A NAMED IMPORT inside a fenced code block, from a project-local module.
 *     This is the strongest evidence a document can carry: the writer named
 *     the module and the export together, so there is nothing to infer.
 *   - A BACKTICKED IDENTIFIER in prose, when it survives the shape filters.
 *     `parseUnifiedDiff` is a symbol reference; `npm install`, `--force`,
 *     `src/index.ts` and `the plan` are not, and never become one.
 *
 * Everything else inside a fence is ignored. A fence usually holds shell
 * commands, sample output or JSON, and mining it for identifiers produces
 * exactly the noise this tool exists not to produce.
 */
export function extractDocRefs(text: string, doc: string, options: ExtractOptions = {}): DocRef[] {
  const include = options.include ?? "both";
  const minLength = options.minLength ?? 4;
  const requireDistinctive = options.requireDistinctive ?? true;
  const ignore = new Set<string>([...DEFAULT_IGNORED, ...(options.ignore ?? [])]);
  const localPrefixes = options.localPrefixes ?? [];
  const refs: DocRef[] = [];
  const fence: FenceState = { open: false, marker: "", info: "" };
  const seen = new Set<string>();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, "");
    const context = raw.trim().slice(0, MAX_CONTEXT_CHARS);
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] as string;
      if (!fence.open) {
        fence.open = true;
        fence.marker = marker[0] as string;
        fence.info = (fenceMatch[2] ?? "").trim();
      } else if (marker.startsWith(fence.marker)) {
        // A closing fence must use the same character; a ``` inside a ~~~
        // block is content, not the end of the block.
        fence.open = false;
        fence.info = "";
      }
      continue;
    }

    if (fence.open) {
      if (include === "backticks") continue;
      for (const name of importedNames(raw, localPrefixes)) {
        if (ignore.has(name)) continue;
        const key = `import:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ symbol: name, base: name, doc, line: i + 1, evidence: "import", context });
      }
      continue;
    }

    if (include === "imports") continue;
    for (const span of codeSpans(raw)) {
      const reference = referenceOf(span);
      if (reference === undefined) continue;
      if (reference.base.length < minLength) continue;
      if (ignore.has(reference.base) || ignore.has(reference.symbol)) continue;
      if (requireDistinctive && !isDistinctive(reference.base) && !reference.symbol.endsWith(")")) {
        continue;
      }
      const key = `backtick:${reference.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        symbol: reference.symbol,
        base: reference.base,
        doc,
        line: i + 1,
        evidence: "backtick",
        context,
      });
    }
  }
  return refs;
}

/**
 * Every identifier-shaped token in a source file, added to `into`.
 *
 * Comments and string literals are NOT masked, and that is the point: the
 * question is "could this name still mean something here", and a name that
 * survives only in a doc comment or as a string key is not a name that has
 * been removed. Masking would make the index smaller and the findings
 * bolder, which is the wrong direction for this tool.
 */
export function buildTokenIndex(text: string, into: Set<string>): Set<string> {
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) into.add(m[0]);
  return into;
}

export type DocCoverage = {
  readonly doc: string;
  readonly references: number;
  readonly resolved: number;
  /** Set when this document's unresolved references were withheld. */
  readonly suppressed?: string;
};

export type CheckResult = {
  readonly missing: ReadonlyArray<DocRef>;
  readonly coverage: ReadonlyArray<DocCoverage>;
  readonly references: number;
  readonly resolved: number;
  /** Findings withheld by the unmatched-document guard. */
  readonly withheld: number;
  /**
   * True when `maxFindings` cut the list.
   *
   * Without it the cap is indistinguishable from a clean tail: `missing` is
   * the only place a dropped finding would have shown, `coverage` counts the
   * whole document either way, and a reader who fixes all 200 has no way to
   * learn there were 900.
   */
  readonly truncated: boolean;
};

export type CheckOptions = {
  /**
   * A document must resolve at least this share of its references before any
   * of its misses are reported; default 0.25.
   *
   * This is the guard against the most expensive failure this tool has: being
   * pointed at the wrong source tree, or at a document about a different
   * project, and confidently reporting every symbol in it as deleted. A
   * document that really documents this tree resolves most of what it names.
   */
  readonly minResolvedRatio?: number;
  /** Turn the guard off and report every miss; default false. */
  readonly reportUnmatchedDocs?: boolean;
  readonly maxFindings?: number;
};

/**
 * Compare references against the token index, per document.
 *
 * Ordering is document order then line order, so two runs over the same
 * inputs return the same bytes.
 */
export function checkRefs(
  refs: ReadonlyArray<DocRef>,
  index: ReadonlySet<string>,
  options: CheckOptions = {},
): CheckResult {
  const minRatio = options.minResolvedRatio ?? 0.25;
  const maxFindings = options.maxFindings ?? 200;
  const byDoc = new Map<string, DocRef[]>();
  for (const ref of refs) {
    const list = byDoc.get(ref.doc);
    if (list === undefined) byDoc.set(ref.doc, [ref]);
    else list.push(ref);
  }

  const missing: DocRef[] = [];
  const coverage: DocCoverage[] = [];
  let references = 0;
  let resolved = 0;
  let withheld = 0;
  let dropped = 0;

  for (const [doc, list] of byDoc) {
    const gone = list.filter((ref) => !index.has(ref.base));
    const docResolved = list.length - gone.length;
    references += list.length;
    resolved += docResolved;
    const ratio = list.length === 0 ? 1 : docResolved / list.length;
    const unmatched = gone.length > 0 && ratio < minRatio;
    if (unmatched && options.reportUnmatchedDocs !== true) {
      withheld += gone.length;
      coverage.push({
        doc,
        references: list.length,
        resolved: docResolved,
        suppressed: `only ${docResolved} of ${list.length} references resolve against the scanned sources — this document probably does not describe this tree, so its ${gone.length} unresolved reference${gone.length === 1 ? "" : "s"} are withheld. Point \`source\` at the right tree, or pass reportUnmatchedDocs.`,
      });
      continue;
    }
    coverage.push({ doc, references: list.length, resolved: docResolved });
    for (const ref of gone) {
      if (missing.length >= maxFindings) {
        dropped++;
        continue;
      }
      missing.push(ref);
    }
  }

  return { missing, coverage, references, resolved, withheld, truncated: dropped > 0 };
}
