/**
 * @crewhaus/tool-text — deterministic text tools.
 *
 * Every tool here is pure: no filesystem, no network, no clock, no
 * randomness. Same input, same bytes, every time. That is what lets a
 * harness call them freely — and, once `kind: tool` steps land, call them
 * with no model turn at all.
 *
 * Each tool is a thin wrapper over a function in `./lib`, which is where the
 * behaviour is tested. Tools return compact JSON (or plain text where that
 * is what the caller wants to paste onward), because every byte returned is
 * a byte in somebody's context window.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { diffLines, diffStats, renderUnified } from "./lib/diff";
import { ENTITY_KINDS, extractEntities as extractEntitiesFn } from "./lib/entities";
import { escapeFor, truncateToChars, wrapText as wrapTextFn } from "./lib/format";
import { estimateTokens, tokenize } from "./lib/locate";
import { compactLogLines } from "./lib/log";
import {
  codeBlocks,
  markdownTable as markdownTableFn,
  parseHeadings,
  renderOutline,
  sectionBody,
} from "./lib/markdown";
import {
  glossaryReplace as glossaryReplaceFn,
  normalizeText as normalizeTextFn,
  sortLines as sortLinesFn,
} from "./lib/normalize";
import { regexExtractAll } from "./lib/regex";
import { extractKeywords as extractKeywordsFn, fuzzyRank, similarity } from "./lib/similarity";
import { classifyByRules, renderTemplateString } from "./lib/template";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * Guard for every tool that accepts a large string. Keeps one pathological
 * input from filling a context window or, for the O(n*m) diff, exhausting
 * memory. Callers hitting it should narrow the input rather than raise it.
 */
const MAX_INPUT_CHARS = 2_000_000;

function assertSize(text: string, field: string): void {
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(
      `${field} is ${text.length} characters, over the ${MAX_INPUT_CHARS} limit — narrow the input first`,
    );
  }
}

// ---------------------------------------------------------------------------

export const regexExtract: RegisteredTool = buildTool({
  name: "RegexExtract",
  description:
    "Extract every regex match from text, with named capture groups, character offsets and line numbers. Use to pull ids, versions, paths or fields out of logs and documents without reading the whole thing into context.",
  inputSchema: z.object({
    text: z.string().describe("the text to search"),
    pattern: z.string().min(1).describe("a JavaScript regular expression source"),
    flags: z.string().optional().describe("regex flags; 'g' is always applied"),
    maxMatches: z.number().int().positive().max(10_000).optional(),
    valuesOnly: z
      .boolean()
      .optional()
      .describe("return just the matched strings, dropping offsets and groups"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    let result: ReturnType<typeof regexExtractAll>;
    try {
      result = regexExtractAll(
        input.text,
        input.pattern,
        input.flags ?? "",
        input.maxMatches ?? 500,
      );
    } catch (err) {
      // An invalid pattern is a caller mistake, not a crash: say which part.
      return `invalid regex /${input.pattern}/${input.flags ?? ""}: ${(err as Error).message}`;
    }
    if (input.valuesOnly) {
      return json({
        count: result.matches.length,
        truncated: result.truncated,
        values: result.matches.map((m) => m.match),
      });
    }
    return json({
      count: result.matches.length,
      truncated: result.truncated,
      matches: result.matches,
    });
  },
});

export const textDiff: RegisteredTool = buildTool({
  name: "TextDiff",
  description:
    "Diff two texts and return a unified diff plus added/removed counts. Use to verify an edit did exactly what was intended, or to compare two config files or drafts.",
  inputSchema: z.object({
    a: z.string().describe("the original text"),
    b: z.string().describe("the changed text"),
    aLabel: z.string().optional(),
    bLabel: z.string().optional(),
    context: z.number().int().min(0).max(20).optional(),
    ignoreWhitespace: z.boolean().optional(),
    statsOnly: z.boolean().optional().describe("return only the counts, not the diff body"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.a, "a");
    assertSize(input.b, "b");
    const prep = (t: string): string[] => {
      const lines = t.split("\n");
      return input.ignoreWhitespace === true ? lines.map((l) => l.trim()) : lines;
    };
    const aLines = prep(input.a);
    const bLines = prep(input.b);
    // The LCS table is O(n*m) cells; refuse rather than exhaust memory.
    const cells = (aLines.length + 1) * (bLines.length + 1);
    if (cells > 25_000_000) {
      return `inputs too large to diff (${aLines.length} x ${bLines.length} lines) — diff a narrower region`;
    }
    const ops = diffLines(aLines, bLines);
    const stats = diffStats(ops);
    if (input.statsOnly === true || stats.added + stats.removed === 0) {
      return json({ ...stats, identical: stats.added + stats.removed === 0 });
    }
    return json({
      ...stats,
      identical: false,
      diff: renderUnified(ops, input.aLabel ?? "a", input.bLabel ?? "b", input.context ?? 3),
    });
  },
});

export const truncateToBudget: RegisteredTool = buildTool({
  name: "TruncateToBudget",
  description:
    "Cut text down to a character or estimated-token budget, keeping the head, the tail, or both ends. Use before putting a large file or log into context so the size is chosen rather than discovered.",
  inputSchema: z
    .object({
      text: z.string(),
      maxChars: z.number().int().positive().optional(),
      maxTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("estimated tokens, at roughly four characters each"),
      strategy: z.enum(["head", "tail", "middle"]).optional(),
      marker: z.string().optional(),
    })
    .refine((v) => v.maxChars !== undefined || v.maxTokens !== undefined, {
      message: "set maxChars or maxTokens",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const maxChars = input.maxChars ?? (input.maxTokens as number) * 4;
    const out = truncateToChars(
      input.text,
      maxChars,
      input.strategy ?? "head",
      input.marker ?? "\n...[truncated]...\n",
    );
    return json({
      text: out.text,
      truncated: out.truncated,
      droppedChars: out.droppedChars,
      originalChars: input.text.length,
      estimatedTokens: estimateTokens(out.text),
    });
  },
});

export const compactLog: RegisteredTool = buildTool({
  name: "CompactLog",
  description:
    "Collapse a long log into its distinct lines, with repeat counts, failures first. Use to turn a huge CI, test or daemon log into the few lines that carry the signal.",
  inputSchema: z.object({
    text: z.string(),
    maxLines: z.number().int().positive().max(5000).optional(),
    dedupe: z.boolean().optional(),
    errorsFirst: z.boolean().optional(),
    stripTimestamps: z
      .boolean()
      .optional()
      .describe("so lines differing only by time collapse together"),
    stripAnsi: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    const out = compactLogLines(input.text, {
      dedupe: input.dedupe ?? true,
      stripTimestamps: input.stripTimestamps ?? true,
      stripAnsiCodes: input.stripAnsi ?? true,
      errorsFirst: input.errorsFirst ?? true,
      maxLines: input.maxLines ?? 200,
    });
    return json({
      totalLines: out.totalLines,
      distinctLines: out.distinctLines,
      shown: out.lines.length,
      truncated: out.truncated,
      errorCount: out.lines.filter((l) => l.isError).length,
      lines: out.lines.map((l) => (l.count > 1 ? `x${l.count} ${l.line}` : l.line)),
    });
  },
});

export const markdownOutline: RegisteredTool = buildTool({
  name: "MarkdownOutline",
  description:
    "List a markdown document's headings, or return one section's body by title or slug. Use to navigate a long README, spec or wiki page without reading all of it.",
  inputSchema: z.object({
    text: z.string(),
    section: z
      .string()
      .optional()
      .describe("when set, return this section's body instead of the outline"),
    maxDepth: z.number().int().min(1).max(6).optional(),
    codeBlocksOnly: z.boolean().optional().describe("return every fenced code block instead"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    if (input.codeBlocksOnly === true) {
      return json({ blocks: codeBlocks(input.text) });
    }
    if (input.section !== undefined) {
      const body = sectionBody(input.text, input.section);
      if (body === undefined) {
        const available = parseHeadings(input.text).map((h) => h.title);
        return json({ found: false, section: input.section, available });
      }
      return json({ found: true, section: input.section, body });
    }
    const headings = parseHeadings(input.text);
    return json({
      count: headings.length,
      outline: renderOutline(headings, input.maxDepth ?? 6),
      headings: headings.filter((h) => h.depth <= (input.maxDepth ?? 6)),
    });
  },
});

export const renderTemplate: RegisteredTool = buildTool({
  name: "RenderTemplate",
  description:
    "Fill {{placeholders}} in a template from structured data, producing byte-identical output for the same input. Use for release notes, PR bodies, status posts and notification text instead of having a model write them.",
  inputSchema: z.object({
    template: z.string(),
    data: z.record(z.unknown()).describe("the values to interpolate; dotted paths are supported"),
    strict: z
      .boolean()
      .optional()
      .describe("fail when the template references something the data lacks"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      const out = renderTemplateString(input.template, input.data, input.strict ?? true);
      return json({ text: out.text, missing: out.missing });
    } catch (err) {
      return `${(err as Error).message}`;
    }
  },
});

export const ruleClassify: RegisteredTool = buildTool({
  name: "RuleClassify",
  description:
    "Label text against operator-written phrase and regex rules, returning the winning label with its score. Use to route tickets, messages and alerts by rules rather than spending a model turn on each one.",
  inputSchema: z.object({
    text: z.string(),
    rules: z
      .array(
        z.object({
          label: z.string().min(1),
          patterns: z.array(z.string().min(1)).min(1),
          weight: z.number().positive().optional(),
          regex: z.boolean().optional(),
        }),
      )
      .min(1),
    threshold: z.number().min(0).optional(),
    defaultLabel: z.string().nullable().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      return json(
        classifyByRules(
          input.text,
          input.rules.map((r) => ({ ...r, weight: r.weight ?? 1, regex: r.regex ?? false })),
          input.threshold ?? 1,
          input.defaultLabel ?? null,
        ),
      );
    } catch (err) {
      return `invalid rule pattern: ${(err as Error).message}`;
    }
  },
});

export const normalizeText: RegisteredTool = buildTool({
  name: "NormalizeText",
  description:
    "Canonicalize text: line endings, trailing whitespace, blank runs, tabs, Unicode form, ANSI codes and invisible characters. Use before hashing, diffing or de-duplicating so cosmetic differences stop counting as changes.",
  inputSchema: z.object({
    text: z.string(),
    eol: z.enum(["lf", "crlf"]).optional(),
    trimTrailingWhitespace: z.boolean().optional(),
    collapseBlankLines: z.boolean().optional(),
    tabsToSpaces: z.number().int().min(1).max(16).optional(),
    stripAnsi: z.boolean().optional(),
    stripInvisible: z.boolean().optional(),
    unicode: z.enum(["NFC", "NFD", "NFKC", "NFKD"]).optional(),
    ensureFinalNewline: z.boolean().optional(),
    lowercase: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    const out = normalizeTextFn(input.text, {
      eol: input.eol ?? "lf",
      trimTrailingWhitespace: input.trimTrailingWhitespace ?? true,
      collapseBlankLines: input.collapseBlankLines ?? false,
      ...(input.tabsToSpaces !== undefined ? { tabsToSpaces: input.tabsToSpaces } : {}),
      stripAnsiCodes: input.stripAnsi ?? false,
      stripInvisible: input.stripInvisible ?? false,
      ...(input.unicode !== undefined ? { unicode: input.unicode } : {}),
      ensureFinalNewline: input.ensureFinalNewline ?? false,
      lowercase: input.lowercase ?? false,
    });
    return json({ text: out, changed: out !== input.text, chars: out.length });
  },
});

export const sortLines: RegisteredTool = buildTool({
  name: "SortLines",
  description:
    "Sort, de-duplicate and optionally key lines by a delimited field. Use to tidy dependency lists, URL sets and delimited records without a shell pipeline.",
  inputSchema: z.object({
    text: z.string(),
    order: z.enum(["asc", "desc"]).optional(),
    unique: z.boolean().optional(),
    numeric: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
    field: z.number().int().min(0).optional().describe("0-based field index to sort on"),
    delimiter: z.string().optional(),
    keepEmpty: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    const before = input.text.split("\n").filter((l) => l.trim() !== "").length;
    const lines = sortLinesFn(input.text, {
      order: input.order ?? "asc",
      unique: input.unique ?? false,
      numeric: input.numeric ?? false,
      ignoreCase: input.ignoreCase ?? false,
      ...(input.field !== undefined ? { field: input.field } : {}),
      delimiter: input.delimiter ?? "\t",
      keepEmpty: input.keepEmpty ?? false,
    });
    return json({ count: lines.length, removed: before - lines.length, text: lines.join("\n") });
  },
});

export const countTokens: RegisteredTool = buildTool({
  name: "CountTokens",
  description:
    "Measure text size: characters, words, lines and an estimated token count. Use to decide whether something fits a budget before sending it to a model.",
  inputSchema: z.object({ text: z.string() }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const lines = input.text === "" ? 0 : input.text.split("\n").length;
    return json({
      chars: input.text.length,
      words: tokenize(input.text).length,
      lines,
      estimatedTokens: estimateTokens(input.text),
      note: "token estimate is characters/4; measure with the provider's counter when exactness matters",
    });
  },
});

export const extractEntities: RegisteredTool = buildTool({
  name: "ExtractEntities",
  description: `Pull syntactically-recognizable values out of text: ${ENTITY_KINDS.join(", ")}. Regex only, not named-entity recognition. Use to harvest URLs, ids, versions and amounts without reading the document into context.`,
  inputSchema: z.object({
    text: z.string(),
    kinds: z.array(z.enum(ENTITY_KINDS as [string, ...string[]])).min(1),
    unique: z.boolean().optional(),
    withOffsets: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    const found = extractEntitiesFn(input.text, input.kinds, input.unique ?? true);
    if (input.withOffsets === true) return json(found);
    const flat: Record<string, string[]> = {};
    for (const [kind, hits] of Object.entries(found)) flat[kind] = hits.map((h) => h.value);
    return json(flat);
  },
});

export const fuzzyMatch: RegisteredTool = buildTool({
  name: "FuzzyMatch",
  description:
    "Rank candidate strings against a query by edit distance, Jaro-Winkler, trigram or token overlap. Use to map a typed name onto a canonical id, or to reconcile two lists, without asking a model to guess.",
  inputSchema: z.object({
    query: z.string(),
    candidates: z.array(z.string()).min(1).max(10_000),
    method: z.enum(["levenshtein", "jaro", "trigram", "tokenJaccard"]).optional(),
    minScore: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json({
      hits: fuzzyRank(
        input.query,
        input.candidates,
        input.method ?? "jaro",
        input.minScore ?? 0.5,
        input.limit ?? 10,
      ),
    }),
});

export const textSimilarity: RegisteredTool = buildTool({
  name: "TextSimilarity",
  description:
    "Score how similar two texts are, from 0 to 1, by edit distance, Jaro-Winkler, trigram or token overlap. Lexical only, no embeddings. Use to detect near-duplicates or check a rewrite stayed close to its source.",
  inputSchema: z.object({
    a: z.string(),
    b: z.string(),
    method: z.enum(["levenshtein", "jaro", "trigram", "tokenJaccard"]).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.a, "a");
    assertSize(input.b, "b");
    return json({
      score: Number(similarity(input.a, input.b, input.method ?? "trigram").toFixed(6)),
      method: input.method ?? "trigram",
    });
  },
});

export const extractKeywords: RegisteredTool = buildTool({
  name: "ExtractKeywords",
  description:
    "Rank a document's most significant terms by frequency, excluding stop words. Use to tag a document or to build a search query for WebSearch or Retrieve.",
  inputSchema: z.object({
    text: z.string(),
    limit: z.number().int().positive().max(200).optional(),
    minLength: z.number().int().min(1).max(20).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    return json({
      keywords: extractKeywordsFn(input.text, input.limit ?? 20, input.minLength ?? 3),
    });
  },
});

export const wrapText: RegisteredTool = buildTool({
  name: "WrapText",
  description:
    "Hard-wrap text at a column width, with an optional per-line prefix and hanging indent. Use for commit bodies at 72 columns, quoted replies and comment blocks.",
  inputSchema: z.object({
    text: z.string(),
    width: z.number().int().min(20).max(500).optional(),
    prefix: z.string().optional().describe("prepended to every line, e.g. '> ' to quote"),
    hangingIndent: z.string().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    wrapTextFn(input.text, input.width ?? 72, input.prefix ?? "", input.hangingIndent ?? ""),
});

export const escapeString: RegisteredTool = buildTool({
  name: "EscapeString",
  description:
    "Quote text for safe embedding in another syntax: regex, shell word, JSON, URL, HTML, markdown, CSV cell or SQL LIKE pattern. Use before interpolating untrusted or scraped text into anything the harness will run or send.",
  inputSchema: z.object({
    text: z.string(),
    target: z.enum([
      "regex",
      "shellSingle",
      "shellDouble",
      "json",
      "url",
      "urlComponent",
      "html",
      "markdown",
      "csv",
      "sqlLike",
    ]),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => escapeFor(input.text, input.target),
});

export const glossaryReplace: RegisteredTool = buildTool({
  name: "GlossaryReplace",
  description:
    "Apply a term mapping to text, longest term first, whole-word by default, reporting what was replaced. Use to enforce product naming or apply a localization dictionary without a model rewrite.",
  inputSchema: z.object({
    text: z.string(),
    mapping: z.record(z.string()).describe("term to replacement"),
    wholeWord: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    assertSize(input.text, "text");
    const out = glossaryReplaceFn(
      input.text,
      input.mapping,
      input.wholeWord ?? true,
      input.caseSensitive ?? false,
    );
    return json({ text: out.text, replacements: out.replacements });
  },
});

export const markdownTable: RegisteredTool = buildTool({
  name: "MarkdownTable",
  description:
    "Render an array of records as an aligned GitHub-flavoured markdown table. Use to turn query or tool results into a report table without a model formatting them.",
  inputSchema: z.object({
    rows: z.array(z.record(z.unknown())).min(1),
    columns: z
      .array(z.string())
      .optional()
      .describe("column order; defaults to keys as first seen"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => markdownTableFn(input.rows, input.columns),
});

/** Every tool this package registers, in the order a catalog should list them. */
export const TEXT_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  compactLog,
  countTokens,
  escapeString,
  extractEntities,
  extractKeywords,
  fuzzyMatch,
  glossaryReplace,
  markdownOutline,
  markdownTable,
  normalizeText,
  regexExtract,
  renderTemplate,
  ruleClassify,
  sortLines,
  textDiff,
  textSimilarity,
  truncateToBudget,
  wrapText,
]);
