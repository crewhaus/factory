/**
 * @crewhaus/tool-data — deterministic structured-data tools.
 *
 * Every tool here is pure: no filesystem, no network, no clock, no
 * randomness. The same input always produces the same bytes. That is what
 * lets a harness call them freely, and what makes their output safe to
 * cache, retry and diff between runs.
 *
 * Two input conventions, applied consistently:
 *
 * - A whole *document* (JSON, YAML, TOML, CSV, XML, JSONL) arrives as text,
 *   because that is how it comes off disk or off the wire.
 * - A *record array* arrives as a real array of objects, because that is how
 *   it comes out of the previous tool in the chain.
 *
 * Each tool is a thin wrapper over a function in `./lib`, which is where the
 * behaviour is tested. Tools return compact JSON, or the document text when
 * the caller will paste it onward, because every byte returned is a byte in
 * somebody's context window.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  CsvError,
  type CsvParseOptions,
  type CsvWriteOptions,
  cellToString,
  normalizeHeader,
  parseCsv,
  rowsToRecords,
  unionKeys,
  writeCsvRows,
} from "./lib/csv";
import { deepDiff } from "./lib/diff";
import { canonicalStringify, isPlainObject, parseJson, sortKeysDeep, stableHash } from "./lib/json";
import { parseJsonl, writeJsonl } from "./lib/jsonl";
import { PathError, parsePath, queryPath } from "./lib/jsonpath";
import {
  PatchError,
  type PatchOp,
  applyJsonPatch,
  applyMergePatch,
  diffMergePatch,
  resolvePointer,
} from "./lib/patch";
import {
  type Aggregation,
  type JoinKind,
  PredicateError,
  type Record_,
  type SortKey,
  aggregate,
  columnsToRecords as columnsToRecordsFn,
  dedupeRecords as dedupeRecordsFn,
  flattenObject as flattenObjectFn,
  joinRecords,
  omitFields,
  recordsToColumns as recordsToColumnsFn,
  sampleRecords as sampleRecordsFn,
  selectFields,
  sortRecords as sortRecordsFn,
  testPredicate,
  unflattenObject as unflattenObjectFn,
} from "./lib/table";
import { TomlError, parseToml, stringifyToml } from "./lib/toml";
import { XmlError, parseXml, toCompact } from "./lib/xml";
import { YamlError, parseYaml, stringifyYaml } from "./lib/yaml";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * Guard for every tool that accepts a whole document. Keeps one pathological
 * input from filling a context window or exhausting memory. Callers hitting
 * it should narrow the input rather than raise it.
 */
const MAX_INPUT_CHARS = 4_000_000;

function tooLarge(text: string, field: string): string | null {
  if (text.length <= MAX_INPUT_CHARS) return null;
  return `${field} is ${text.length} characters, over the ${MAX_INPUT_CHARS} limit — narrow the input first`;
}

/**
 * Read a document in any of the formats this package understands. Returns a
 * readable message rather than throwing, because a malformed file is a
 * caller's mistake and belongs in the result, not in a stack trace.
 */
function readDocument(
  text: string,
  format: "json" | "yaml" | "toml" | "csv" | "jsonl",
  csv: { delimiter: string; header: boolean; inferTypes: boolean },
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    switch (format) {
      case "json": {
        const parsed = parseJson(text);
        return parsed.ok
          ? { ok: true, value: parsed.value }
          : { ok: false, error: `invalid JSON: ${parsed.error}` };
      }
      case "yaml":
        return { ok: true, value: parseYaml(text) };
      case "toml":
        return { ok: true, value: parseToml(text) };
      case "jsonl": {
        const out = parseJsonl(text, 100_000, true);
        if (out.failures.length > 0) {
          const first = out.failures[0] as { line: number; error: string };
          return { ok: false, error: `invalid JSONL on line ${first.line}: ${first.error}` };
        }
        return { ok: true, value: out.records.map((r) => r.value) };
      }
      default: {
        const options: CsvParseOptions = {
          delimiter: csv.delimiter,
          quote: '"',
          skipEmptyLines: true,
          trim: false,
          maxRows: 100_000,
        };
        const parsed = parseCsv(text, options);
        if (parsed.rows.length === 0) return { ok: true, value: [] };
        if (!csv.header) return { ok: true, value: parsed.rows };
        const header = normalizeHeader(parsed.rows[0] as string[]);
        const { records } = rowsToRecords(parsed.rows.slice(1), header, csv.inferTypes, []);
        return { ok: true, value: records };
      }
    }
  } catch (err) {
    if (err instanceof YamlError)
      return { ok: false, error: `invalid YAML on line ${err.line}: ${err.message}` };
    if (err instanceof TomlError)
      return { ok: false, error: `invalid TOML on line ${err.line}: ${err.message}` };
    if (err instanceof CsvError)
      return { ok: false, error: `invalid CSV on line ${err.line}: ${err.message}` };
    return { ok: false, error: (err as Error).message };
  }
}

/** Parse a JSON document argument, returning a message on failure. */
function readJson(
  text: string,
  field: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const size = tooLarge(text, field);
  if (size !== null) return { ok: false, error: size };
  const parsed = parseJson(text);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, error: `${field} is not valid JSON: ${parsed.error}` };
}

const FORMATS = ["json", "yaml", "toml", "csv", "jsonl"] as const;

// ---------------------------------------------------------------------------

export const jsonQuery: RegisteredTool = buildTool({
  name: "JsonQuery",
  description:
    "Select values out of a JSON document with a JSONPath-like expression supporting dotted and bracketed keys, array indexes and slices, wildcards, recursive descent and a single-comparison filter. Use to pull the two fields you need out of a large API response instead of reading the whole thing into context.",
  inputSchema: z.object({
    json: z.string().describe("the document, as JSON text"),
    path: z
      .string()
      .min(1)
      .describe(
        "e.g. $.items[0].id, $.users[*].email, $..name, $.rows[2:8], $.users[?(@.age >= 30)]",
      ),
    maxResults: z.number().int().positive().max(10_000).optional(),
    valuesOnly: z.boolean().optional().describe("return just the values, dropping their paths"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    const limit = input.maxResults ?? 200;
    try {
      const steps = parsePath(input.path);
      const result = queryPath(doc.value, steps, limit);
      return json({
        count: result.matches.length,
        truncated: result.truncated,
        ...(input.valuesOnly === true
          ? { values: result.matches.map((m) => m.value) }
          : { matches: result.matches }),
      });
    } catch (err) {
      if (err instanceof PathError) return `invalid path: ${err.message}`;
      throw err;
    }
  },
});

export const jsonPatch: RegisteredTool = buildTool({
  name: "JsonPatch",
  description:
    "Apply an RFC 6902 JSON Patch (add, remove, replace, move, copy, test) to a JSON document, all-or-nothing. Use to make a precise, reviewable edit to config or state without a model rewriting the whole file and changing something it did not mean to.",
  inputSchema: z.object({
    json: z.string().describe("the document to patch, as JSON text"),
    patch: z
      .array(
        z.object({
          op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
          path: z.string().describe("a JSON Pointer, e.g. /users/0/name"),
          from: z.string().optional().describe("source pointer, for move and copy"),
          value: z.unknown().describe("the new value, for add, replace and test"),
        }),
      )
      .min(1)
      .max(1000),
    indent: z.number().int().min(0).max(8).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    for (const [i, op] of input.patch.entries()) {
      if ((op.op === "move" || op.op === "copy") && op.from === undefined) {
        return `operation ${i} (${op.op}) needs a "from" pointer`;
      }
      if ((op.op === "add" || op.op === "replace" || op.op === "test") && !("value" in op)) {
        return `operation ${i} (${op.op}) needs a "value"`;
      }
    }
    try {
      const patched = applyJsonPatch(doc.value, input.patch as unknown as PatchOp[]);
      return JSON.stringify(patched, null, input.indent ?? 0);
    } catch (err) {
      if (err instanceof PatchError) {
        return `patch failed at operation ${err.opIndex}: ${err.message} — the document is unchanged`;
      }
      throw err;
    }
  },
});

export const jsonMergePatch: RegisteredTool = buildTool({
  name: "JsonMergePatch",
  description:
    "Apply an RFC 7386 JSON Merge Patch, where an object merges key by key and a null deletes a key, or derive the merge patch between two documents. Use for a shallow config override, or to describe what changed between two states in the smallest form that reproduces it.",
  inputSchema: z.object({
    json: z.string().describe("the target document, as JSON text"),
    patch: z
      .string()
      .optional()
      .describe("the merge patch, as JSON text; required unless deriving"),
    against: z
      .string()
      .optional()
      .describe("a second document; supplying it derives the patch that turns json into it"),
    indent: z.number().int().min(0).max(8).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    const indent = input.indent ?? 0;
    if (input.against !== undefined) {
      const other = readJson(input.against, "against");
      if (!other.ok) return other.error;
      return JSON.stringify(diffMergePatch(doc.value, other.value), null, indent);
    }
    if (input.patch === undefined) return "supply either patch (to apply) or against (to derive)";
    const patch = readJson(input.patch, "patch");
    if (!patch.ok) return patch.error;
    return JSON.stringify(applyMergePatch(doc.value, patch.value), null, indent);
  },
});

export const jsonFormat: RegisteredTool = buildTool({
  name: "JsonFormat",
  description:
    "Re-serialize JSON with a chosen indentation and, optionally, every object's keys sorted, plus a stable content hash of the value. Use to make two documents byte-comparable before diffing them, or to minify a payload before it goes into a prompt.",
  inputSchema: z.object({
    json: z.string().describe("the document, as JSON text"),
    indent: z
      .number()
      .int()
      .min(0)
      .max(8)
      .optional()
      .describe("0 minifies; 2 is the usual pretty form"),
    sortKeys: z.boolean().optional().describe("sort object keys at every depth, for stable output"),
    pointer: z.string().optional().describe("a JSON Pointer; format only the value it addresses"),
    withHash: z.boolean().optional().describe("also return a stable 64-bit content hash"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    let value = doc.value;
    if (input.pointer !== undefined && input.pointer !== "") {
      const found = resolvePointer(value, input.pointer);
      if (!found.found) return `pointer "${input.pointer}" does not resolve: ${found.reason}`;
      value = found.value;
    }
    const indent = input.indent ?? 2;
    const text =
      input.sortKeys === true
        ? canonicalStringify(value, indent)
        : JSON.stringify(value, null, indent);
    if (input.withHash !== true) return text ?? "undefined";
    return json({ text, hash: stableHash(value), bytes: (text ?? "").length });
  },
});

export const dataDiff: RegisteredTool = buildTool({
  name: "DataDiff",
  description:
    "Compare two JSON documents structurally and report every added, removed and changed path with both values. Use to tell exactly what an edit, a migration or a deploy changed, instead of eyeballing two files side by side.",
  inputSchema: z.object({
    before: z.string().describe("the original document, as JSON text"),
    after: z.string().describe("the changed document, as JSON text"),
    keyArraysBy: z
      .string()
      .optional()
      .describe("match array elements by this field instead of by position — use for record lists"),
    maxDepth: z.number().int().positive().max(64).optional(),
    maxEntries: z.number().int().positive().max(5000).optional(),
    countsOnly: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const before = readJson(input.before, "before");
    if (!before.ok) return before.error;
    const after = readJson(input.after, "after");
    if (!after.ok) return after.error;
    const result = deepDiff(before.value, after.value, {
      keyArraysBy: input.keyArraysBy,
      maxDepth: input.maxDepth ?? 32,
      maxEntries: input.maxEntries ?? 500,
    });
    const identical = result.entries.length === 0 && !result.truncated;
    if (input.countsOnly === true || identical) {
      return json({ identical, ...result.counts, truncated: result.truncated });
    }
    return json({
      identical: false,
      ...result.counts,
      truncated: result.truncated,
      entries: result.entries,
    });
  },
});

export const dataConvert: RegisteredTool = buildTool({
  name: "DataConvert",
  description:
    "Convert a document between JSON, YAML, TOML, CSV and JSONL using this package's own hand-written readers and writers. Use to normalize whatever format a file arrived in before querying it — but read the README first, because each format supports a documented subset, not the whole specification.",
  inputSchema: z.object({
    text: z.string().describe("the document to convert"),
    from: z.enum(FORMATS),
    to: z.enum(FORMATS),
    indent: z.number().int().min(0).max(8).optional().describe("for JSON output"),
    delimiter: z.string().length(1).optional().describe("for CSV, on either side; default ,"),
    header: z
      .boolean()
      .optional()
      .describe("for CSV, treat the first row as a header; default true"),
    inferTypes: z
      .boolean()
      .optional()
      .describe("for CSV input, read numbers and booleans as such rather than strings"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const size = tooLarge(input.text, "text");
    if (size !== null) return size;
    const delimiter = input.delimiter ?? ",";
    const header = input.header ?? true;
    const doc = readDocument(input.text, input.from, {
      delimiter,
      header,
      inferTypes: input.inferTypes ?? true,
    });
    if (!doc.ok) return doc.error;
    return writeDocument(doc.value, input.to, {
      indent: input.indent ?? 2,
      delimiter,
      header,
    });
  },
});

function writeDocument(
  value: unknown,
  format: (typeof FORMATS)[number],
  options: { indent: number; delimiter: string; header: boolean },
): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, options.indent) ?? "null";
    case "yaml":
      return stringifyYaml(value);
    case "toml": {
      if (!isPlainObject(value)) {
        return "cannot write TOML: a TOML document must be an object at the top level, and this value is not";
      }
      const out = stringifyToml(value);
      return out.skipped.length === 0
        ? out.text
        : `${out.text}\n\n# dropped (TOML has no null): ${out.skipped.join(", ")}`;
    }
    case "jsonl": {
      if (!Array.isArray(value)) return "cannot write JSONL: the value is not an array";
      return writeJsonl(value, true).text;
    }
    default: {
      if (!Array.isArray(value)) return "cannot write CSV: the value is not an array of records";
      if (value.length === 0) return "";
      if (value.every((r) => Array.isArray(r))) {
        return writeCsvRows(value as unknown[][], {
          delimiter: options.delimiter,
          quote: '"',
          newline: "\n",
          quoteAll: false,
          header: null,
        });
      }
      if (!value.every(isPlainObject)) {
        return "cannot write CSV: every element must be an object (a record) or an array (a row)";
      }
      const records = value as Record_[];
      const columns = unionKeys(records);
      const writeOptions: CsvWriteOptions = {
        delimiter: options.delimiter,
        quote: '"',
        newline: "\n",
        quoteAll: false,
        header: options.header ? columns : null,
      };
      return writeCsvRows(
        records.map((r) => columns.map((c) => r[c])),
        writeOptions,
      );
    }
  }
}

export const csvParse: RegisteredTool = buildTool({
  name: "CsvParse",
  description:
    "Parse RFC 4180 CSV into records or rows, handling quoted fields, embedded commas, newlines and doubled quotes, with a custom delimiter and optional type inference. Use to read a spreadsheet export correctly instead of splitting on commas and corrupting every quoted address.",
  inputSchema: z.object({
    text: z.string().describe("the CSV document"),
    delimiter: z.string().length(1).optional().describe("default ,  — use \\t for TSV"),
    quote: z.string().length(1).optional().describe('default "'),
    header: z.boolean().optional().describe("treat the first row as a header; default true"),
    inferTypes: z
      .boolean()
      .optional()
      .describe("read numbers, booleans and blanks as such; leading zeros stay strings"),
    trim: z.boolean().optional().describe("trim unquoted fields; quoted fields are never trimmed"),
    nullTokens: z
      .array(z.string())
      .optional()
      .describe("extra cell values to read as null, e.g. NA, NULL, -"),
    maxRows: z.number().int().positive().max(200_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const size = tooLarge(input.text, "text");
    if (size !== null) return size;
    const options: CsvParseOptions = {
      delimiter: input.delimiter ?? ",",
      quote: input.quote ?? '"',
      skipEmptyLines: true,
      trim: input.trim ?? false,
      maxRows: input.maxRows ?? 50_000,
    };
    let parsed: ReturnType<typeof parseCsv>;
    try {
      parsed = parseCsv(input.text, options);
    } catch (err) {
      if (err instanceof CsvError) return `invalid CSV on line ${err.line}: ${err.message}`;
      throw err;
    }
    if (parsed.rows.length === 0) {
      return json({ rowCount: 0, columns: [], records: [], truncated: parsed.truncated });
    }
    if (input.header === false) {
      return json({ rowCount: parsed.rows.length, rows: parsed.rows, truncated: parsed.truncated });
    }
    const columns = normalizeHeader(parsed.rows[0] as string[]);
    const { records, ragged } = rowsToRecords(
      parsed.rows.slice(1),
      columns,
      input.inferTypes ?? false,
      input.nullTokens ?? [],
    );
    return json({
      rowCount: records.length,
      columns,
      truncated: parsed.truncated,
      ...(ragged.length > 0 ? { raggedRows: ragged.slice(0, 50) } : {}),
      records,
    });
  },
});

export const csvWrite: RegisteredTool = buildTool({
  name: "CsvWrite",
  description:
    "Render records or rows as RFC 4180 CSV, quoting any field that contains the delimiter, a quote or a newline. Use to hand a spreadsheet, a ticketing import or a colleague a file that will not break on the first address field.",
  inputSchema: z.object({
    records: z
      .array(z.union([z.record(z.unknown()), z.array(z.unknown())]))
      .max(200_000)
      .describe("objects (a header is derived from their keys) or arrays (written as raw rows)"),
    columns: z
      .array(z.string())
      .optional()
      .describe("column order; defaults to keys as first seen"),
    delimiter: z.string().length(1).optional(),
    header: z.boolean().optional().describe("write a header row; default true for records"),
    quoteAll: z.boolean().optional(),
    crlf: z.boolean().optional().describe("use CRLF line endings, as RFC 4180 specifies"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    if (input.records.length === 0) return "";
    const rowMode = input.records.every((r) => Array.isArray(r));
    const options: CsvWriteOptions = {
      delimiter: input.delimiter ?? ",",
      quote: '"',
      newline: input.crlf === true ? "\r\n" : "\n",
      quoteAll: input.quoteAll ?? false,
      header: null,
    };
    if (rowMode) {
      return writeCsvRows(input.records as unknown[][], {
        ...options,
        header: input.columns ?? null,
      });
    }
    if (!input.records.every(isPlainObject)) {
      return "mix of records and rows — every element must be an object, or every element an array";
    }
    const records = input.records as Record_[];
    const columns = input.columns ?? unionKeys(records);
    return writeCsvRows(
      records.map((r) => columns.map((c) => cellToString(r[c] ?? null))),
      { ...options, header: input.header === false ? null : columns },
    );
  },
});

const conditionSchema = z.object({
  field: z.string().describe("a dotted path, e.g. user.email"),
  op: z.enum([
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "startsWith",
    "endsWith",
    "in",
    "matches",
    "exists",
    "empty",
  ]),
  value: z.unknown().describe("the value to compare against; omitted for exists and empty"),
});

export const tableQuery: RegisteredTool = buildTool({
  name: "TableQuery",
  description:
    "Filter, project, sort and page an array of records with a small declarative predicate over dotted field paths. Use to narrow a large result set to the rows and columns that matter before any of it reaches a model.",
  inputSchema: z.object({
    records: z.array(z.record(z.unknown())).max(200_000),
    where: z
      .object({
        all: z.array(conditionSchema).optional().describe("every condition must hold"),
        any: z.array(conditionSchema).optional().describe("at least one must hold"),
        none: z.array(conditionSchema).optional().describe("none may hold"),
      })
      .optional(),
    select: z.array(z.string()).optional().describe("keep only these fields"),
    omit: z.array(z.string()).optional().describe("drop these fields"),
    sort: z
      .array(
        z.object({
          field: z.string(),
          direction: z.enum(["asc", "desc"]).optional(),
          caseInsensitive: z.boolean().optional(),
          nulls: z.enum(["first", "last"]).optional(),
        }),
      )
      .optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(100_000).optional(),
    countOnly: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    let rows: Record_[] = input.records as Record_[];
    if (input.where !== undefined) {
      try {
        rows = rows.filter((r) => testPredicate(r, input.where ?? {}));
      } catch (err) {
        if (err instanceof PredicateError) return `invalid filter: ${err.message}`;
        throw err;
      }
    }
    const matched = rows.length;
    if (input.sort !== undefined && input.sort.length > 0) {
      rows = sortRecordsFn(rows, input.sort as SortKey[]);
    }
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 1000;
    rows = rows.slice(offset, offset + limit);
    if (input.countOnly === true) return json({ matched, returned: 0 });
    if (input.select !== undefined && input.select.length > 0) {
      const fields = input.select;
      rows = rows.map((r) => selectFields(r, fields));
    }
    if (input.omit !== undefined && input.omit.length > 0) {
      const fields = input.omit;
      rows = rows.map((r) => omitFields(r, fields));
    }
    return json({ matched, returned: rows.length, records: rows });
  },
});

export const tableAggregate: RegisteredTool = buildTool({
  name: "TableAggregate",
  description:
    "Group records by one or more fields and reduce each group with count, sum, min, max, avg, first, last or distinct. Use to turn thousands of rows into the handful of numbers a decision actually rests on, without a model doing arithmetic.",
  inputSchema: z.object({
    records: z.array(z.record(z.unknown())).max(200_000),
    groupBy: z
      .array(z.string())
      .max(8)
      .describe("dotted field paths; an empty list aggregates the whole set"),
    aggregations: z
      .array(
        z.object({
          as: z.string().min(1).describe("the output field name"),
          fn: z.enum(["count", "sum", "min", "max", "avg", "first", "last", "distinct"]),
          field: z.string().optional().describe("the field to reduce; omit for a plain count"),
        }),
      )
      .max(32)
      .optional(),
    sort: z
      .array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() }))
      .optional(),
    limit: z.number().int().positive().max(50_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = aggregate(
      input.records as Record_[],
      input.groupBy,
      (input.aggregations ?? []) as Aggregation[],
    );
    let groups = result.groups;
    if (input.sort !== undefined && input.sort.length > 0) {
      groups = sortRecordsFn(groups, input.sort as SortKey[]);
    }
    const limit = input.limit ?? 1000;
    return json({
      groupCount: result.groups.length,
      ...(result.skipped > 0 ? { nonNumericSkipped: result.skipped } : {}),
      truncated: result.groups.length > limit,
      groups: groups.slice(0, limit),
    });
  },
});

export const tableJoin: RegisteredTool = buildTool({
  name: "TableJoin",
  description:
    "Join two record arrays on a key with inner, left, right or full semantics, reporting how many rows on each side found no match. Use to stitch two API results together without a model pairing them up by eye and quietly dropping the ones that did not line up.",
  inputSchema: z.object({
    left: z.array(z.record(z.unknown())).max(100_000),
    right: z.array(z.record(z.unknown())).max(100_000),
    leftKey: z.string().min(1).describe("dotted path to the join key on the left"),
    rightKey: z
      .string()
      .min(1)
      .optional()
      .describe("dotted path on the right; defaults to leftKey"),
    kind: z.enum(["inner", "left", "right", "full"]).optional().describe("default inner"),
    rightPrefix: z
      .string()
      .optional()
      .describe("prefix for right-hand fields that collide with a left one; default right_"),
    maxRows: z.number().int().positive().max(200_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = joinRecords(input.left as Record_[], input.right as Record_[], {
      kind: (input.kind ?? "inner") as JoinKind,
      leftKey: input.leftKey,
      rightKey: input.rightKey ?? input.leftKey,
      rightPrefix: input.rightPrefix ?? "right_",
      maxRows: input.maxRows ?? 10_000,
    });
    return json({
      rowCount: result.rows.length,
      truncated: result.truncated,
      unmatchedLeft: result.unmatchedLeft,
      unmatchedRight: result.unmatchedRight,
      rows: result.rows,
    });
  },
});

export const recordsToColumns: RegisteredTool = buildTool({
  name: "RecordsToColumns",
  description:
    "Turn an array of records into a column-oriented object, one array per field, with missing values filled as null. Use to feed a plotting or statistics step that wants columns, or to shrink a repetitive payload before it goes into context.",
  inputSchema: z.object({
    records: z.array(z.record(z.unknown())).max(200_000),
    columns: z.array(z.string()).optional().describe("restrict and order the output columns"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const all = recordsToColumnsFn(input.records as Record_[]);
    if (input.columns === undefined || input.columns.length === 0) {
      return json({ rowCount: input.records.length, columns: all });
    }
    const picked: Record<string, unknown[]> = {};
    for (const c of input.columns) picked[c] = all[c] ?? input.records.map(() => null);
    return json({ rowCount: input.records.length, columns: picked });
  },
});

export const columnsToRecords: RegisteredTool = buildTool({
  name: "ColumnsToRecords",
  description:
    "Turn a column-oriented object back into an array of records, padding short columns with null and naming any that were short. Use to convert a columnar API response into the row shape every other table tool here expects.",
  inputSchema: z.object({
    columns: z.record(z.array(z.unknown())).describe("field name to array of values"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = columnsToRecordsFn(input.columns);
    return json({
      rowCount: result.records.length,
      ...(result.ragged.length > 0 ? { paddedColumns: result.ragged } : {}),
      records: result.records,
    });
  },
});

export const flattenObject: RegisteredTool = buildTool({
  name: "FlattenObject",
  description:
    "Flatten a nested JSON value into a single-level object keyed by dotted paths, optionally expanding array elements by index. Use to make a deep config greppable, comparable line by line, or writable as a flat CSV row.",
  inputSchema: z.object({
    json: z.string().describe("the value to flatten, as JSON text"),
    separator: z.string().min(1).max(4).optional().describe("default ."),
    expandArrays: z.boolean().optional().describe("index into arrays too; default true"),
    maxDepth: z.number().int().positive().max(64).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    const flat = flattenObjectFn(
      doc.value,
      input.separator ?? ".",
      input.expandArrays ?? true,
      input.maxDepth ?? 32,
    );
    return json(flat);
  },
});

export const unflattenObject: RegisteredTool = buildTool({
  name: "UnflattenObject",
  description:
    "Rebuild a nested JSON value from an object of dotted-path keys, turning a contiguous run of numeric keys back into an array. Use to reverse FlattenObject, or to build a config object from flat environment-style settings.",
  inputSchema: z.object({
    flat: z.record(z.unknown()).describe("dotted key to value"),
    separator: z.string().min(1).max(4).optional().describe("default ."),
    arraysFromNumericKeys: z
      .boolean()
      .optional()
      .describe("rebuild arrays where numeric keys run 0..n-1; default true"),
    indent: z.number().int().min(0).max(8).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const value = unflattenObjectFn(
      input.flat,
      input.separator ?? ".",
      input.arraysFromNumericKeys ?? true,
    );
    return JSON.stringify(value, null, input.indent ?? 0);
  },
});

export const jsonlParse: RegisteredTool = buildTool({
  name: "JsonlParse",
  description:
    "Parse line-delimited JSON into an array, tolerating blank lines, CRLF and a trailing newline, and reporting the line number and message for any record that does not parse. Use to read a log or dataset file without one malformed line silently costing you records.",
  inputSchema: z.object({
    text: z.string().describe("the JSONL document"),
    maxRecords: z.number().int().positive().max(200_000).optional(),
    stopOnError: z
      .boolean()
      .optional()
      .describe("stop at the first bad line rather than skipping it"),
    withLineNumbers: z
      .boolean()
      .optional()
      .describe("wrap each record as {line, value} so a bad row can be traced back"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const size = tooLarge(input.text, "text");
    if (size !== null) return size;
    const result = parseJsonl(input.text, input.maxRecords ?? 50_000, input.stopOnError ?? false);
    return json({
      count: result.records.length,
      truncated: result.truncated,
      ...(result.failures.length > 0 ? { failures: result.failures.slice(0, 50) } : {}),
      records: input.withLineNumbers === true ? result.records : result.records.map((r) => r.value),
    });
  },
});

export const jsonlWrite: RegisteredTool = buildTool({
  name: "JsonlWrite",
  description:
    "Serialize an array of values as line-delimited JSON, one compact record per line. Use to append to a dataset, an audit file or an eval fixture in the format the rest of the toolchain reads.",
  inputSchema: z.object({
    values: z.array(z.unknown()).max(200_000).describe("one value per output line"),
    trailingNewline: z
      .boolean()
      .optional()
      .describe("end the document with a newline; default true"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = writeJsonl(input.values, input.trailingNewline ?? true);
    return result.text;
  },
});

export const xmlParse: RegisteredTool = buildTool({
  name: "XmlParse",
  description:
    "Parse an XML document or HTML fragment into a JSON tree of elements, attributes, text and CDATA, in either an explicit or a compact shape. Use to read a feed, an SVG or a config file with a real parser instead of a regex — but read the README, because this handles well-formed markup, not the whole XML specification.",
  inputSchema: z.object({
    text: z.string().describe("the XML or HTML fragment"),
    mode: z
      .enum(["xml", "html"])
      .optional()
      .describe("html tolerates void elements, bare attributes and mismatched close tags"),
    shape: z
      .enum(["compact", "tree"])
      .optional()
      .describe("compact puts attributes under @name and text under #text; default compact"),
    trimWhitespace: z
      .boolean()
      .optional()
      .describe("drop whitespace-only text nodes; default true"),
    maxDepth: z.number().int().positive().max(256).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const size = tooLarge(input.text, "text");
    if (size !== null) return size;
    try {
      const nodes = parseXml(input.text, {
        mode: input.mode ?? "xml",
        trimWhitespace: input.trimWhitespace ?? true,
        maxDepth: input.maxDepth ?? 128,
      });
      return json(input.shape === "tree" ? nodes : toCompact(nodes));
    } catch (err) {
      if (err instanceof XmlError) return `invalid markup on line ${err.line}: ${err.message}`;
      throw err;
    }
  },
});

export const sortRecords: RegisteredTool = buildTool({
  name: "SortRecords",
  description:
    "Sort an array of records by one or more dotted field paths, with per-key direction, case folding and null placement. The order is stable and total, so equal rows keep their original order and mixed types never sort arbitrarily. Use to put a result set in a defined order before paging, diffing or displaying it.",
  inputSchema: z.object({
    records: z.array(z.unknown()).max(200_000),
    keys: z
      .array(
        z.object({
          field: z.string().describe("a dotted path; the empty string sorts by the value itself"),
          direction: z.enum(["asc", "desc"]).optional(),
          caseInsensitive: z.boolean().optional(),
          nulls: z.enum(["first", "last"]).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => json(sortRecordsFn(input.records, input.keys as SortKey[])),
});

export const dedupeRecords: RegisteredTool = buildTool({
  name: "DedupeRecords",
  description:
    "Remove duplicate records, either by one or more key fields or by the whole value in canonical key-sorted form, keeping the first or the last occurrence. Use to clean a merged result set before counting it, so a row that arrived twice is not counted twice.",
  inputSchema: z.object({
    records: z.array(z.unknown()).max(200_000),
    keyFields: z
      .array(z.string())
      .optional()
      .describe("dotted paths forming the identity; omit to compare whole values"),
    keep: z.enum(["first", "last"]).optional().describe("default first"),
    countOnly: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = dedupeRecordsFn(input.records, input.keyFields ?? [], input.keep ?? "first");
    if (input.countOnly === true) {
      return json({ kept: result.records.length, removed: result.removed });
    }
    return json({ kept: result.records.length, removed: result.removed, records: result.records });
  },
});

export const sampleRecords: RegisteredTool = buildTool({
  name: "SampleRecords",
  description:
    "Take a deterministic sample of an array: the head, the tail, every nth element, or a set spread evenly across the whole range. There is no random mode, so the same input always yields the same sample. Use to show a model a representative slice of a large dataset at a bounded cost.",
  inputSchema: z.object({
    records: z.array(z.unknown()).max(500_000),
    mode: z.enum(["head", "tail", "everyNth", "evenly"]).optional().describe("default head"),
    count: z.number().int().positive().max(10_000).optional().describe("default 10"),
    step: z.number().int().positive().max(100_000).optional().describe("for everyNth; default 10"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const sample = sampleRecordsFn(
      input.records,
      input.mode ?? "head",
      input.count ?? 10,
      input.step ?? 10,
    );
    return json({ total: input.records.length, returned: sample.length, records: sample });
  },
});

export const dataShape: RegisteredTool = buildTool({
  name: "DataShape",
  description:
    "Describe the structure of a JSON value: every field's dotted path, the types seen there, how often it is present and populated, and a few example values. Use to learn what an unfamiliar API response or dataset actually contains before writing a query against it.",
  inputSchema: z.object({
    json: z.string().describe("the value to describe, as JSON text"),
    maxFields: z.number().int().positive().max(2000).optional(),
    examples: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("example values per field; default 2"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    const root = doc.value;
    const rows = Array.isArray(root) ? root : [root];
    const fields = new Map<
      string,
      { types: Set<string>; present: number; nonNull: number; examples: unknown[] }
    >();
    const exampleCount = input.examples ?? 2;
    const maxFields = input.maxFields ?? 200;
    let truncated = false;

    for (const row of rows) {
      const flat = flattenObjectFn(row, ".", false, 12);
      for (const key of Object.keys(flat)) {
        const value = flat[key];
        let entry = fields.get(key);
        if (entry === undefined) {
          if (fields.size >= maxFields) {
            truncated = true;
            continue;
          }
          entry = { types: new Set(), present: 0, nonNull: 0, examples: [] };
          fields.set(key, entry);
        }
        entry.present += 1;
        entry.types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
        if (value !== null) entry.nonNull += 1;
        if (
          entry.examples.length < exampleCount &&
          value !== null &&
          !entry.examples.some((e) => e === value)
        ) {
          entry.examples.push(value);
        }
      }
    }
    return json({
      rootType: Array.isArray(root) ? "array" : root === null ? "null" : typeof root,
      rowCount: rows.length,
      fieldCount: fields.size,
      truncated,
      fields: [...fields.entries()].map(([path, e]) => ({
        path,
        types: [...e.types].sort(),
        present: e.present,
        nonNull: e.nonNull,
        ...(e.examples.length > 0 ? { examples: e.examples } : {}),
      })),
    });
  },
});

export const jsonSortKeys: RegisteredTool = buildTool({
  name: "JsonSortKeys",
  description:
    "Return a JSON value with every object's keys sorted at every depth, leaving array order untouched. Use before storing or committing generated JSON so that re-running the generator produces no spurious diff.",
  inputSchema: z.object({
    json: z.string().describe("the document, as JSON text"),
    indent: z.number().int().min(0).max(8).optional().describe("default 2"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const doc = readJson(input.json, "json");
    if (!doc.ok) return doc.error;
    return JSON.stringify(sortKeysDeep(doc.value), null, input.indent ?? 2) ?? "null";
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const DATA_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  columnsToRecords,
  csvParse,
  csvWrite,
  dataConvert,
  dataDiff,
  dataShape,
  dedupeRecords,
  flattenObject,
  jsonFormat,
  jsonMergePatch,
  jsonPatch,
  jsonQuery,
  jsonSortKeys,
  jsonlParse,
  jsonlWrite,
  recordsToColumns,
  sampleRecords,
  sortRecords,
  tableAggregate,
  tableJoin,
  tableQuery,
  unflattenObject,
  xmlParse,
]);
