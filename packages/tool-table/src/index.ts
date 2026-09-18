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
import { DriftError, compareDrift } from "./lib/drift";
import { type TableProfile, profileTable } from "./lib/profile";
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
  /** A stored profile is a summary; anything this big is the data by mistake. */
  profileBytes: 64 * 1024 * 1024,
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
  // Every tool in this package answers a question about the WHOLE file — the
  // profile, the diff, the drift verdict. `parseCsv` stops at `maxRows` and
  // reports it; ignoring that flag would answer about the first two million
  // rows while claiming to answer about the file, and on the date-sorted
  // export that is most of them the prefix is a different month's data.
  if (parsed.truncated) {
    throw new Error(
      `${at.rel} has more than ${LIMITS.rows} rows, so it was only read that far. Every one of these tools answers about the whole file, and an answer about its first ${LIMITS.rows} rows is an answer about different data — split the file and compare the parts`,
    );
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

/**
 * What a drift capture records. Shared by the tool that writes one
 * (`TableProfile`) and the tool that can be asked to take one on the fly
 * (`DataDriftCheck` with a reference FILE), so the two cannot offer different
 * knobs for the same capture.
 */
const driftCaptureSchema = z
  .object({
    bins: z
      .number()
      .int()
      .min(2)
      .max(100)
      .optional()
      .describe("quantile bins over the reference; default 10, which the PSI bands assume"),
    maxCategories: z
      .number()
      .int()
      .min(2)
      .max(10_000)
      .optional()
      .describe("cap on a column's stored category list; default 128"),
    sampleSize: z
      .number()
      .int()
      .min(0)
      .max(50_000)
      .optional()
      .describe("values kept per numeric column for the rank test; default 500"),
    seed: z
      .number()
      .int()
      .optional()
      .describe("seeds the value sample so the same file gives the same profile; default 1337"),
  })
  .strict();

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
      driftProfile: driftCaptureSchema
        .optional()
        .describe(
          "also capture the bin edges, category counts and value sample DataDriftCheck needs; pass {} for the defaults",
        ),
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
      drift: input.driftProfile,
    });
    return json({ file: rel, bytes, ...profile });
  },
});

/**
 * Read a stored profile back, or say what is wrong with it.
 *
 * A baseline is a file somebody wrote weeks ago and may have edited since, so
 * this checks the parts the comparison actually indexes into rather than
 * trusting the shape. Returning a string for a bad one — instead of throwing
 * or, worse, letting an undefined through — is what turns "my drift check
 * crashed" into "your baseline has no bin edges, re-run it like this".
 */
function loadReferenceProfile(file: string): { profile: TableProfile; rel: string } | string {
  const at = resolveSafe("DataDriftCheck", file);
  const bytes = statSync(at.real).size;
  if (bytes > LIMITS.profileBytes) {
    return `${at.rel} is ${bytes} bytes, far larger than any profile — this is probably not a stored TableProfile`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(at.real, "utf-8"));
  } catch (err) {
    return `${at.rel} is not JSON: ${(err as Error).message}. referenceProfile takes a stored TableProfile result; for raw data use referenceFile`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `${at.rel} does not hold a TableProfile object`;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["rows"] !== "number" || !Array.isArray(candidate["columns"])) {
    return `${at.rel} has no "rows" count and "columns" array, so it is not a TableProfile result`;
  }
  const capture = candidate["driftCapture"];
  if (typeof capture !== "object" || capture === null) {
    return `${at.rel} is a TableProfile result but carries no drift capture, so it has no bin edges. A PSI computed against edges derived fresh from today's data compares each side to its own quantiles and reads near zero however far the data moved — so this is refused rather than answered. Re-profile the baseline with driftProfile, or pass the baseline data as referenceFile`;
  }
  const header = capture as Record<string, unknown>;
  if (header["version"] !== 1) {
    return `${at.rel} carries a drift capture of version ${String(header["version"])}; this build reads version 1`;
  }
  if (!Array.isArray(header["nullTokens"]) || typeof header["sampleSize"] !== "number") {
    return `${at.rel} has a drift capture with no nullTokens list or sampleSize; it has been edited by hand and cannot be used as a baseline`;
  }
  for (const column of candidate["columns"] as ReadonlyArray<unknown>) {
    const bad = columnProblem(column);
    if (bad !== null) return `${at.rel} has an unusable column: ${bad}`;
  }
  return { profile: parsed as TableProfile, rel: at.rel };
}

/** `null` when the column is shaped like a profiled column, else what is wrong. */
function columnProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "a column entry is not an object";
  const column = value as Record<string, unknown>;
  if (typeof column["name"] !== "string") return "a column has no name";
  const label = JSON.stringify(column["name"]);
  if (typeof column["nullFraction"] !== "number" || typeof column["distinct"] !== "number") {
    return `${label} has no nullFraction or distinct count`;
  }
  const drift = column["drift"];
  if (drift === undefined) return null;
  if (typeof drift !== "object" || drift === null) return `${label} has a non-object drift capture`;
  const capture = drift as Record<string, unknown>;
  if (capture["kind"] === "numeric") {
    // The edges are the one field the whole comparison rests on, so they are
    // checked for the property `binCounts` will assert anyway — strictly
    // increasing — here, where the message can name the column.
    const edges = capture["edges"];
    if (!Array.isArray(edges)) return `${label} has a numeric capture with no edges array`;
    for (let i = 0; i < edges.length; i++) {
      if (typeof edges[i] !== "number" || !Number.isFinite(edges[i])) {
        return `${label} has a non-finite bin edge at position ${i}`;
      }
      if (i > 0 && (edges[i] as number) <= (edges[i - 1] as number)) {
        return `${label} has bin edges that are not strictly increasing at position ${i}`;
      }
    }
    if (edges.length > 0 && !Array.isArray(capture["counts"])) {
      return `${label} has bin edges but no counts`;
    }
    if (!Array.isArray(capture["sample"])) return `${label} has a numeric capture with no sample`;
    return null;
  }
  if (capture["kind"] === "categorical") {
    const counts = capture["valueCounts"];
    if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
      return `${label} has a categorical capture with no valueCounts map`;
    }
    return null;
  }
  return `${label} has a drift capture of unknown kind ${JSON.stringify(capture["kind"])}`;
}

/** The reference's bin edges, keyed by column — what today's data must be binned against. */
function edgesFromReference(profile: TableProfile): Record<string, ReadonlyArray<number>> {
  // Null prototype: the keys are COLUMN NAMES out of a CSV header. On a plain
  // object `edges["__proto__"] = [...]` sets the map's prototype instead of an
  // entry, and every other column name then resolves through that array.
  const edges: Record<string, ReadonlyArray<number>> = Object.create(null);
  for (const column of profile.columns) {
    const drift = column.drift;
    if (drift?.kind === "numeric" && drift.edges.length >= 2) edges[column.name] = drift.edges;
  }
  return edges;
}

/** Narrow a profile to the named columns, for the `columns` input. */
function narrowProfile(profile: TableProfile, wanted: ReadonlyArray<string>): TableProfile {
  return { ...profile, columns: profile.columns.filter((c) => wanted.includes(c.name)) };
}

export const dataDriftCheck: RegisteredTool = buildTool({
  name: "DataDriftCheck",
  description:
    "Compare today's data file against a stored TableProfile baseline and report what moved: columns added, removed or retyped, distribution shift per column (PSI plus a Mann-Whitney rank test for numbers, a chi-square for labels), null-rate and cardinality jumps, categories that are new today, and the row-count ratio. Use it as the gate between an upstream feed and everything downstream of it. Today's numbers are binned against the BASELINE's stored bin edges, never freshly derived ones — a PSI over two independently binned samples reads near zero however far the data moved — and a column whose two sides were not binned identically comes back with the reason instead of a number. The epsilon that stands in for an empty bin is a required input, because at 1e-3, 1e-2 and 0.05 the same data reads significant, moderate and stable.",
  inputSchema: z
    .object({
      file: z.string().min(1).describe("today's data: a workspace-relative CSV or TSV"),
      referenceProfile: z
        .string()
        .min(1)
        .optional()
        .describe("a stored TableProfile result, taken with driftProfile"),
      referenceFile: z
        .string()
        .min(1)
        .optional()
        .describe("baseline data to profile now, instead of a stored profile"),
      epsilon: z
        .number()
        .gt(0)
        .lt(1)
        .describe(
          "REQUIRED share substituted for a bin empty on one side; it decides the verdict, so it is never defaulted. 1e-3 is strict, 1e-2 usual",
        ),
      delimiter: z.string().length(1).optional(),
      noHeader: z.boolean().optional(),
      nullTokens: z
        .array(z.string())
        .max(64)
        .optional()
        .describe("referenceFile only; a stored profile dictates its own, so both sides match"),
      capture: driftCaptureSchema
        .optional()
        .describe("referenceFile only; a stored profile dictates its own capture settings"),
      columns: z
        .array(z.string())
        .max(LIMITS.columns)
        .optional()
        .describe("compare only these columns; the schema report then covers only them too"),
      includeBins: z
        .boolean()
        .optional()
        .describe("return every PSI bin rather than the three that moved the index most"),
      failOn: z
        .object({
          psi: z.number().positive().optional().describe("0.25 is the usual significant line"),
          pValue: z.number().gt(0).lt(1).optional().describe("only a VALID p can trip this"),
          nullRateIncrease: z.number().gt(0).max(1).optional().describe("absolute, e.g. 0.05"),
          cardinalityRatio: z.number().min(1).optional().describe("fails outside [1/r, r]"),
          rowCountRatio: z.number().min(1).optional().describe("fails outside [1/r, r]"),
          newCategories: z.number().int().nonnegative().optional(),
          schemaDrift: z.boolean().optional(),
        })
        .strict()
        .optional()
        .describe("without this nothing is gated and gate.ok says only that nothing was checked"),
    })
    .strict()
    .refine((v) => (v.referenceProfile === undefined) !== (v.referenceFile === undefined), {
      message:
        "give exactly one of referenceProfile (a stored TableProfile) or referenceFile (baseline data to profile now)",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    let reference: TableProfile;
    let referenceRel: string;
    if (input.referenceProfile !== undefined) {
      const loaded = loadReferenceProfile(input.referenceProfile);
      if (typeof loaded === "string") return loaded;
      reference = loaded.profile;
      referenceRel = loaded.rel;
    } else {
      const source = readTable("DataDriftCheck", input.referenceFile as string, input);
      referenceRel = source.rel;
      reference = profileTable(source.headers, source.rows, {
        nullTokens: input.nullTokens,
        drift: input.capture ?? {},
      });
    }
    const capture = reference.driftCapture;
    if (capture === undefined) {
      return "the reference carries no drift capture, so it has no bin edges to compare against";
    }
    if (input.referenceProfile !== undefined && input.nullTokens !== undefined) {
      // Two null-token lists make the null-rate comparison a comparison of the
      // lists. The stored profile already records the list it was taken under,
      // so the current side simply reuses it and there is nothing to override.
      return `nullTokens applies only to referenceFile: the stored profile was taken with [${capture.nullTokens.join(", ")}] and today's data is read with that same list, so the null rates compare`;
    }
    if (input.referenceProfile !== undefined && input.capture !== undefined) {
      return "capture applies only to referenceFile: a stored profile already fixes its bins, category cap, sample size and seed, and today's data is captured with those";
    }

    const today = readTable("DataDriftCheck", input.file, input);
    let current = profileTable(today.headers, today.rows, {
      nullTokens: capture.nullTokens,
      drift: {
        bins: capture.binsRequested,
        maxCategories: capture.maxCategories,
        sampleSize: capture.sampleSize,
        seed: capture.seed,
        // The one line this tool exists for.
        edges: edgesFromReference(reference),
      },
    });

    const wanted = input.columns;
    const extras: string[] = [];
    if (wanted !== undefined) {
      const known = new Set([
        ...reference.columns.map((c) => c.name),
        ...current.columns.map((c) => c.name),
      ]);
      const missing = wanted.filter((c) => !known.has(c));
      if (missing.length > 0) {
        return `these columns are in neither the reference nor ${today.rel}: ${missing.join(", ")}`;
      }
      reference = narrowProfile(reference, wanted);
      current = narrowProfile(current, wanted);
      extras.push(
        `only ${wanted.length} column(s) were compared, so the schema report covers only those`,
      );
    }

    try {
      const report = compareDrift(reference, current, {
        epsilon: input.epsilon,
        thresholds: input.failOn,
        includeBins: input.includeBins,
      });
      return json({
        reference: referenceRel,
        file: today.rel,
        ...report,
        notes: [...report.notes, ...extras],
      });
    } catch (err) {
      // A refusal from the comparison or the statistics kernel is an answer,
      // not a crash: the caller gets the reason instead of a stack. Anything
      // else is a bug here and is re-thrown.
      //
      // The kernel's `StatsError` is matched by NAME on purpose: it is not on
      // `@crewhaus/tool-math`'s public surface, and reaching past the package
      // entrypoint to import the class would be a second import path into
      // another package's internals for the sake of one `instanceof`.
      if (err instanceof DriftError) return err.message;
      if (err instanceof Error && err.name === "StatsError") return err.message;
      throw err;
    }
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
  dataDriftCheck,
  fixedWidthParse,
  recordLinkage,
  tableDiff,
  tableProfile,
  tableReshape,
  tableShard,
]);
