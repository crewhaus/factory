/**
 * @crewhaus/tool-table — making a messy export usable.
 *
 * The first questions about any data file are always the same: how many
 * rows, which columns, what types, how many nulls, is the key unique, what
 * changed since yesterday, is this the same customer as that one. The usual
 * way to answer them is to read the first fifty rows into a context window
 * and guess — and fifty rows do not tell you that column nine is empty in
 * the last thousand, or that the id repeats.
 *
 * Files are read here rather than passed in. A table worth these tools is
 * one too big to paste, which is the whole saving.
 *
 * CSV parsing comes from `@crewhaus/tool-data`: two readers in one
 * repository would disagree about quoting and embedded newlines on the same
 * file, in different tools, which is the worst way to disagree.
 */
import { readFileSync, statSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { parseCsv } from "@crewhaus/tool-data";
import { z } from "zod";
import { profileTable } from "./lib/profile";
import {
  FIELD_NORMALIZERS,
  type LinkageRule,
  type Row,
  diffTables,
  linkRecords,
  normalizeContact,
} from "./lib/reconcile";
import { type FixedField, parseFixedWidth, shardRows, toLong, toWide } from "./lib/reshape";
import { resolveSafe } from "./paths";

const json = (value: unknown): string => JSON.stringify(value);

const LIMITS = {
  fileBytes: 512 * 1024 * 1024,
  rows: 2_000_000,
  columns: 4_096,
  records: 100_000,
  /** Past this, returning the shard bodies means returning the file again. */
  returnedBytes: 8 * 1024 * 1024,
} as const;

/** Read a delimited file into a header and rows of strings. */
function readTable(
  tool: string,
  file: string,
  options: { delimiter?: string; noHeader?: boolean },
): { headers: string[]; rows: string[][]; rel: string; bytes: number } {
  const at = resolveSafe(tool, file);
  const bytes = statSync(at.real).size;
  if (bytes > LIMITS.fileBytes) {
    throw new Error(`${at.rel} is ${bytes} bytes, over the ${LIMITS.fileBytes}-byte limit`);
  }
  const text = readFileSync(at.real, "utf-8");
  // `parseCsv` returns every row including the header; splitting it here
  // keeps one reader for the whole repository rather than two that disagree
  // about quoting on the same file.
  const parsed = parseCsv(text, {
    delimiter: options.delimiter ?? (at.rel.endsWith(".tsv") ? "\t" : ","),
    quote: '"',
    skipEmptyLines: true,
    trim: false,
    maxRows: LIMITS.rows,
  });
  const headers =
    options.noHeader === true
      ? Array.from({ length: parsed.rows[0]?.length ?? 0 }, (_, i) => `column${i + 1}`)
      : (parsed.rows[0] ?? []);
  const rows = options.noHeader === true ? parsed.rows : parsed.rows.slice(1);
  if (headers.length > LIMITS.columns) {
    throw new Error(`${at.rel} has ${headers.length} columns, over the ${LIMITS.columns} limit`);
  }
  return { headers, rows, rel: at.rel, bytes };
}

const asRecords = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): Row[] => rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));

const sourceFields = {
  file: z.string().min(1).describe("workspace-relative path to a CSV or TSV"),
  delimiter: z.string().length(1).optional().describe("inferred from the extension when omitted"),
  noHeader: z.boolean().optional().describe("the first row is data, not a header"),
};

// ---------------------------------------------------------------------------

export const tableProfile: RegisteredTool = buildTool({
  name: "TableProfile",
  description:
    "Answer what is actually in a data file in one call: row and column counts, each column's type, null fraction, distinct count, range and commonest values, plus candidate keys, duplicate rows and columns that are empty or constant. Use it before writing any query against an unfamiliar export. Reading the first fifty rows instead cannot tell you that a column is empty in the last thousand, or that the id you were about to join on repeats.",
  inputSchema: z
    .object({
      ...sourceFields,
      nullTokens: z
        .array(z.string())
        .max(64)
        .optional()
        .describe('default ["NULL","null","NA","N/A","-"]'),
      topValues: z.number().int().positive().max(100).optional().describe("default 5"),
      columns: z.array(z.string()).max(LIMITS.columns).optional().describe("profile only these"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { headers, rows, rel, bytes } = readTable("TableProfile", input.file, input);
    const wanted = input.columns;
    const keep = wanted === undefined ? headers : headers.filter((h) => wanted.includes(h));
    if (wanted !== undefined) {
      const missing = wanted.filter((c) => !headers.includes(c));
      if (missing.length > 0) {
        return `these columns are not in ${rel}: ${missing.join(", ")}. It has: ${headers.join(", ")}`;
      }
    }
    const indexes = keep.map((h) => headers.indexOf(h));
    const narrowed = wanted === undefined ? rows : rows.map((r) => indexes.map((i) => r[i] ?? ""));
    const profile = profileTable(keep, narrowed, {
      nullTokens: input.nullTokens,
      topValues: input.topValues,
    });
    return json({ file: rel, bytes, ...profile });
  },
});

export const tableDiff: RegisteredTool = buildTool({
  name: "TableDiff",
  description:
    "Reconcile two exports by key and report what was added, removed and changed, cell by cell. Use it for yesterday-versus-today files, an API dump against a database dump, or a before-and-after migration check. A key that appears twice on either side is REPORTED rather than resolved: with a duplicate key there is no fact about which row became which, and picking one produces a diff that looks authoritative and is arbitrary. Columns present on only one side are named too.",
  inputSchema: z
    .object({
      before: z.string().min(1),
      after: z.string().min(1),
      key: z.array(z.string().min(1)).min(1).max(16).describe("the column(s) identifying a row"),
      ignore: z.array(z.string()).max(LIMITS.columns).optional().describe("columns not to compare"),
      delimiter: z.string().length(1).optional(),
      limit: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe("cap each list; default 200"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = readTable("TableDiff", input.before, input);
    const b = readTable("TableDiff", input.after, input);
    const diff = diffTables(
      asRecords(a.headers, a.rows),
      asRecords(b.headers, b.rows),
      input.key,
      input.ignore ?? [],
    );
    const limit = input.limit ?? 200;
    return json({
      before: a.rel,
      after: b.rel,
      keyColumns: diff.keyColumns,
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
      },
      duplicateKeys: diff.duplicateKeys.slice(0, limit),
      columnsOnlyInBefore: diff.columnsOnlyInBefore,
      columnsOnlyInAfter: diff.columnsOnlyInAfter,
      added: diff.added.slice(0, limit),
      removed: diff.removed.slice(0, limit),
      changed: diff.changed.slice(0, limit),
      truncated:
        diff.added.length > limit || diff.removed.length > limit || diff.changed.length > limit,
    });
  },
});

export const recordLinkage: RegisteredTool = buildTool({
  name: "RecordLinkage",
  description:
    "Match records between two lists that share no key, using weighted exact and fuzzy field comparisons. Use it to resolve the same customer, vendor or product across two systems. Every accepted pair carries its EVIDENCE — which field matched and how closely — because 'these are the same person' is a claim somebody will have to defend and a bare score cannot be defended. Pairs above the review floor but below the accept floor come back separately rather than being guessed at, and each record is used once: a record matching two others is a question, not a match.",
  inputSchema: z
    .object({
      left: z.string().min(1).describe("workspace-relative path"),
      right: z.string().min(1),
      rules: z
        .array(
          z.object({
            field: z.string().min(1),
            compare: z.enum(["exact", "fuzzy"]),
            weight: z.number().positive(),
            threshold: z.number().min(0).max(1).optional().describe("fuzzy only; default 0.8"),
            normalize: z
              .enum(FIELD_NORMALIZERS)
              .optional()
              .describe("canonicalize first, with ContactNormalize's rules"),
          }),
        )
        .min(1)
        .max(32),
      accept: z.number().min(0).max(1).optional().describe("default 0.85"),
      review: z.number().min(0).max(1).optional().describe("default 0.6"),
      delimiter: z.string().length(1).optional(),
      limit: z.number().int().positive().max(100_000).optional().describe("default 200"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const a = readTable("RecordLinkage", input.left, input);
    const b = readTable("RecordLinkage", input.right, input);
    const leftRecords = asRecords(a.headers, a.rows);
    const rightRecords = asRecords(b.headers, b.rows);
    for (const rule of input.rules) {
      if (!a.headers.includes(rule.field) || !b.headers.includes(rule.field)) {
        return `the rule field "${rule.field}" must be a column in both files; left has ${a.headers.join(", ")} and right has ${b.headers.join(", ")}`;
      }
    }
    const result = linkRecords(
      leftRecords,
      rightRecords,
      input.rules as ReadonlyArray<LinkageRule>,
      {
        accept: input.accept,
        review: input.review,
      },
    );
    const limit = input.limit ?? 200;
    return json({
      left: a.rel,
      right: b.rel,
      comparisons: result.comparisons,
      counts: {
        matched: result.matched.length,
        review: result.review.length,
        unmatchedLeft: result.unmatchedLeft.length,
        unmatchedRight: result.unmatchedRight.length,
      },
      matched: result.matched.slice(0, limit),
      review: result.review.slice(0, limit),
      unmatchedLeft: result.unmatchedLeft.slice(0, limit),
      unmatchedRight: result.unmatchedRight.slice(0, limit),
    });
  },
});

export const contactNormalize: RegisteredTool = buildTool({
  name: "ContactNormalize",
  description:
    "Canonicalize the fields every join and dedupe depends on — email, phone, person name, company name — and return a comparison key beside the original. Use it before matching or deduplicating contacts. Gmail's dots and +tags are folded ONLY for Gmail-family domains, because they are a Gmail feature and not a rule of email: treating a.b@other.com as ab@other.com merges two different people. A phone with no country code is reported as national rather than being given one, and every fold that happened is named.",
  inputSchema: z
    .object({
      contacts: z
        .array(
          z.object({
            email: z.string().optional(),
            phone: z.string().optional(),
            name: z.string().optional(),
            company: z.string().optional(),
          }),
        )
        .min(1)
        .max(LIMITS.records),
      defaultCountryCode: z
        .string()
        .max(4)
        .optional()
        .describe("assumed for numbers with no + prefix; without it they stay national"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json({
      count: input.contacts.length,
      contacts: input.contacts.map((contact) =>
        normalizeContact({ ...contact, defaultCountryCode: input.defaultCountryCode }),
      ),
    }),
});

export const tableReshape: RegisteredTool = buildTool({
  name: "TableReshape",
  description:
    "Pivot a table between wide and long form — the transform SQL cannot express without already knowing the distinct values. Use it to turn a column-per-month export into rows, or a long event log into a matrix. Going long to wide, a repeated (identifier, variable) pair is a COLLISION and is reported: the shape does not say which value wins, and silently taking the last makes a pivot that looks complete and is wrong in a way nothing downstream can detect.",
  inputSchema: z
    .object({
      ...sourceFields,
      direction: z.enum(["long", "wide"]),
      idColumns: z.array(z.string().min(1)).min(1).max(64),
      valueColumns: z
        .array(z.string().min(1))
        .max(LIMITS.columns)
        .optional()
        .describe("wide→long: which to melt"),
      variableColumn: z.string().optional().describe("long→wide: the column holding names"),
      valueColumn: z.string().optional().describe("long→wide: the column holding values"),
      variableName: z
        .string()
        .optional()
        .describe("wide→long: output name column; default 'variable'"),
      valueName: z.string().optional().describe("wide→long: output value column; default 'value'"),
      fill: z.string().optional().describe("long→wide: value for absent cells"),
      keepEmpty: z.boolean().optional().describe("wide→long: keep empty cells as rows"),
      limit: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe("default 500 rows returned"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { headers, rows, rel } = readTable("TableReshape", input.file, input);
    const records = asRecords(headers, rows);
    const limit = input.limit ?? 500;

    if (input.direction === "long") {
      const valueColumns =
        input.valueColumns ?? headers.filter((h) => !input.idColumns.includes(h));
      const out = toLong(records, input.idColumns, valueColumns, {
        variableName: input.variableName,
        valueName: input.valueName,
        keepEmpty: input.keepEmpty,
      });
      return json({
        file: rel,
        direction: "long",
        melted: valueColumns,
        rowCount: out.length,
        rows: out.slice(0, limit),
        truncated: out.length > limit,
      });
    }

    if (input.variableColumn === undefined || input.valueColumn === undefined) {
      return "reshaping to wide needs variableColumn and valueColumn — which column holds the names, and which holds the values";
    }
    const result = toWide(records, input.idColumns, input.variableColumn, input.valueColumn, {
      fill: input.fill,
    });
    return json({
      file: rel,
      direction: "wide",
      columns: result.columns,
      rowCount: result.rows.length,
      collisions: result.collisions.slice(0, limit),
      rows: result.rows.slice(0, limit),
      truncated: result.rows.length > limit,
    });
  },
});

export const tableShard: RegisteredTool = buildTool({
  name: "TableShard",
  description:
    "Split a large delimited file into shards by row count or byte size, each carrying the header. Use it to get a file that is too big for one pass into pieces that are not. Every shard repeats the header, so each is independently readable — a split that put it only on the first piece produces one usable file and the rest needing it grafted back on, which is how a column ends up shifted. It reports the plan and the shard bodies; writing them is the caller's to do.",
  inputSchema: z
    .object({
      ...sourceFields,
      maxRows: z.number().int().positive().max(LIMITS.rows).optional(),
      maxBytes: z.number().int().positive().optional(),
      planOnly: z.boolean().optional().describe("return the shard sizes without their contents"),
    })
    .strict()
    .refine((v) => v.maxRows !== undefined || v.maxBytes !== undefined, {
      message: "give maxRows or maxBytes, or every row lands in one shard",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const { headers, rows, rel } = readTable("TableShard", input.file, input);
    const { shards, bodies } = shardRows(headers, rows, {
      maxRows: input.maxRows,
      maxBytes: input.maxBytes,
    });
    const totalBytes = shards.reduce((sum, shard) => sum + shard.bytes, 0);
    // Returning the bodies means returning the whole file as JSON. Past a
    // few megabytes that is not a result, it is the file again — so the plan
    // comes back and the caller asks for the pieces it wants.
    const tooLarge = !input.planOnly && totalBytes > LIMITS.returnedBytes;
    return json({
      file: rel,
      totalRows: rows.length,
      shardCount: shards.length,
      totalBytes,
      shards,
      ...(input.planOnly || tooLarge ? {} : { bodies }),
      ...(tooLarge
        ? {
            note: `the shards come to ${totalBytes} bytes, over the ${LIMITS.returnedBytes}-byte return limit — this is the plan; re-run with planOnly for just this, or shard smaller`,
          }
        : {}),
    });
  },
});

export const fixedWidthParse: RegisteredTool = buildTool({
  name: "FixedWidthParse",
  description:
    "Parse a fixed-width or mainframe extract from a positional layout into records. Use it for the exports that arrive as columns of padded text with no delimiter at all. Positions are 1-BASED AND INCLUSIVE, as every layout document and copybook states them — converting in your head is how a field ends up one character off down the whole file. A line shorter than the layout needs is reported rather than padded, since padding turns a truncated record into one with empty trailing fields that read as real data.",
  inputSchema: z
    .object({
      file: z.string().min(1),
      fields: z
        .array(
          z.object({
            name: z.string().min(1),
            start: z.number().int().positive().describe("1-based, inclusive"),
            length: z.number().int().positive(),
            trim: z.boolean().optional().describe("default true"),
          }),
        )
        .min(1)
        .max(LIMITS.columns),
      skipLines: z.number().int().nonnegative().max(1_000).optional(),
      limit: z.number().int().positive().max(100_000).optional().describe("default 500"),
    })
    .strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const at = resolveSafe("FixedWidthParse", input.file);
    const bytes = statSync(at.real).size;
    if (bytes > LIMITS.fileBytes) {
      throw new Error(`${at.rel} is ${bytes} bytes, over the ${LIMITS.fileBytes}-byte limit`);
    }
    const result = parseFixedWidth(
      readFileSync(at.real, "utf-8"),
      input.fields as ReadonlyArray<FixedField>,
      {
        skipLines: input.skipLines,
      },
    );
    const limit = input.limit ?? 500;
    return json({
      file: at.rel,
      rowCount: result.rows.length,
      shortLines: result.shortLines.slice(0, limit),
      rows: result.rows.slice(0, limit),
      truncated: result.rows.length > limit,
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const TABLE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  contactNormalize,
  fixedWidthParse,
  recordLinkage,
  tableDiff,
  tableProfile,
  tableReshape,
  tableShard,
]);
