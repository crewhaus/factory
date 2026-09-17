/**
 * @crewhaus/tool-schema — deterministic validation, assertion and comparison
 * tools.
 *
 * Every tool here is pure: no filesystem, no network, no clock, no
 * randomness. Same input, same bytes, every time.
 *
 * These are the tools a harness reaches for when it needs a *verdict* rather
 * than an opinion. Does this payload match the contract; did this batch of
 * rows arrive clean; is this response still what it was last week; is the new
 * schema safe to ship. A model asked those questions gives a plausible
 * answer. These give the same answer twice.
 *
 * Each tool is a thin wrapper over a function in `./lib`, which is where the
 * behaviour is tested and where each algorithm's exact supported subset is
 * documented — in particular `./lib/jsonschema`, which states precisely which
 * Draft-07 keywords are enforced and which are not.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { ASSERT_OPS, type Check, checkRequired, runChecks } from "./lib/assert";
import { compareValues, firstDifference } from "./lib/compare";
import { FORMAT_NAMES, type FormatName, checkFormat, matchingFormats } from "./lib/formats";
import { inferSchema } from "./lib/infer";
import { type Schema, checkSchemaShape, validateValue } from "./lib/jsonschema";
import {
  checkReferences,
  collectFieldValues,
  findDuplicates,
  validateRecords as validateRecordsFn,
} from "./lib/records";
import { diffSchemas } from "./lib/schemadiff";
import { closestMatch } from "./lib/suggest";
import { renderFieldTable, summarizeSchema } from "./lib/summarize";
import { canonicalize, preview } from "./lib/value";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * A schema is a keyword object or a boolean, and nothing else. Declaring it
 * this way means a caller who passes a string gets a schema rejection naming
 * the field, not a confusing validation failure.
 */
const schemaInput = z.union([z.boolean(), z.record(z.unknown())]);

/** Ceilings that keep one pathological call from filling a context window. */
const LIMITS = {
  records: 20_000,
  samples: 2_000,
  checks: 500,
  values: 20_000,
  paths: 500,
};

/**
 * Zod treats a field declared `z.unknown()` as optional, so a caller who
 * forgets one would silently be comparing against `undefined`. These tools
 * take a value as their subject, so an absent field is a mistake worth
 * naming: this asserts the key is actually there.
 */
const present =
  (...keys: string[]) =>
  (value: unknown): boolean =>
    keys.every((key) => Object.hasOwn(value as object, key));

/**
 * A schema with a structural mistake in it (a misspelled type, a `required`
 * that is not an array) would otherwise report every value as invalid, which
 * sends the caller looking in the wrong place. Validation is refused instead.
 */
function schemaProblemReport(schema: Schema): string | null {
  const problems = checkSchemaShape(schema);
  if (problems.length === 0) return null;
  return json({
    schemaValid: false,
    problems,
    note: "the schema itself is malformed, so nothing was validated against it",
  });
}

// ---------------------------------------------------------------------------

export const jsonSchemaValidate: RegisteredTool = buildTool({
  name: "JsonSchemaValidate",
  description:
    "Validate a value against a JSON Schema (a documented Draft-07 subset) and return every failure with a JSON Pointer path and a readable message. Use to check a payload, config or model output against its contract before acting on it, and to get the exact list of what is wrong rather than a yes/no.",
  inputSchema: z
    .object({
      value: z.unknown().describe("the value to validate; may be any JSON value, including null"),
      schema: schemaInput.describe("a JSON Schema; see the package README for the enforced subset"),
      assertFormat: z
        .boolean()
        .optional()
        .describe(
          "enforce `format` instead of treating it as an annotation, as Draft-07 defaults to",
        ),
      maxErrors: z.number().int().positive().max(1000).optional(),
    })
    .refine(present("value"), { message: "value is required, even when it is null" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const problems = schemaProblemReport(input.schema);
    if (problems !== null) return problems;
    const result = validateValue(input.value, input.schema, {
      assertFormat: input.assertFormat ?? false,
      maxErrors: input.maxErrors ?? 100,
    });
    return json({
      valid: result.valid,
      errorCount: result.errors.length,
      truncated: result.truncated,
      errors: result.errors,
      ...(result.unsupportedKeywords.length > 0
        ? {
            unsupportedKeywords: result.unsupportedKeywords,
            note: "those keywords were present but not enforced — this pass does not cover them",
          }
        : {}),
    });
  },
});

export const jsonSchemaInfer: RegisteredTool = buildTool({
  name: "JsonSchemaInfer",
  description:
    "Infer a JSON Schema that describes one or more example values, with types, structure and optional formats. Use to bootstrap a contract from a sample API response or a few rows of data, then tighten it by hand — it describes the samples, and infers no numeric ranges or string lengths from them.",
  inputSchema: z.object({
    samples: z
      .array(z.unknown())
      .min(1)
      .max(LIMITS.samples)
      .describe("one or more example values; more samples make the result more accurate"),
    requireAll: z
      .boolean()
      .optional()
      .describe("mark a property required when every sample had it (default true)"),
    detectFormats: z
      .boolean()
      .optional()
      .describe("label strings with a format when all match one"),
    detectEnums: z
      .boolean()
      .optional()
      .describe("turn a small closed set of string values into an enum (default false)"),
    enumThreshold: z.number().int().min(2).max(100).optional(),
    closed: z.boolean().optional().describe("emit additionalProperties:false on every object"),
    maxDepth: z.number().int().min(1).max(20).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const schema = inferSchema(input.samples, {
      requireAll: input.requireAll ?? true,
      detectFormats: input.detectFormats ?? true,
      detectEnums: input.detectEnums ?? false,
      enumThreshold: input.enumThreshold ?? 12,
      closed: input.closed ?? false,
      maxDepth: input.maxDepth ?? 12,
    });
    return json(schema);
  },
});

export const validateRecords: RegisteredTool = buildTool({
  name: "ValidateRecords",
  description:
    "Validate an array of records against one schema and return a pass/fail summary, per-row errors and the failures grouped by what went wrong. Use as a data-quality gate on a batch, feed or export, where the useful answer is how many rows failed and on which field, not a wall of errors.",
  inputSchema: z.object({
    records: z.array(z.unknown()).max(LIMITS.records).describe("the rows to validate"),
    schema: schemaInput,
    assertFormat: z.boolean().optional(),
    idField: z
      .string()
      .optional()
      .describe("a dotted path whose value names each row in the report, e.g. 'id'"),
    maxErrorsPerRow: z.number().int().positive().max(100).optional(),
    maxFailedRows: z.number().int().positive().max(1000).optional(),
    summaryOnly: z.boolean().optional().describe("return the counts and top issues, not the rows"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const problems = schemaProblemReport(input.schema);
    if (problems !== null) return problems;
    const report = validateRecordsFn(input.records, input.schema, {
      assertFormat: input.assertFormat ?? false,
      maxErrorsPerRow: input.maxErrorsPerRow ?? 10,
      maxFailedRows: input.maxFailedRows ?? 50,
      idField: input.idField ?? null,
    });
    const head = {
      ok: report.ok,
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      topIssues: report.topIssues.slice(0, 20),
      ...(report.unsupportedKeywords.length > 0
        ? { unsupportedKeywords: report.unsupportedKeywords }
        : {}),
    };
    if (input.summaryOnly === true) return json(head);
    return json({ ...head, truncated: report.truncated, failures: report.failures });
  },
});

export const assert: RegisteredTool = buildTool({
  name: "Assert",
  description: `Evaluate a list of declarative checks (${ASSERT_OPS.slice(0, 8).join(", ")} and more) against a value and report which passed, which failed, and what was found instead. Use as the gate that decides whether a step can proceed or must escalate — the condition lives in data the operator wrote, so the same input always reaches the same verdict.`,
  inputSchema: z
    .object({
      value: z.unknown().describe("the value the checks run against"),
      checks: z
        .array(
          z.object({
            path: z
              .string()
              .optional()
              .describe(
                "dotted path into the value, e.g. 'order.items[0].sku'; omit for the value itself",
              ),
            op: z.enum(ASSERT_OPS),
            expected: z.unknown().describe("the operand; its meaning depends on the op"),
            flags: z.string().optional().describe("regex flags for matches/notMatches"),
            message: z
              .string()
              .optional()
              .describe("replaces the generated reason when this check fails"),
          }),
        )
        .min(1)
        .max(LIMITS.checks),
      failuresOnly: z.boolean().optional().describe("return only the checks that failed"),
    })
    .refine(present("value"), { message: "value is required, even when it is null" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const report = runChecks(input.value, input.checks as Check[]);
    if (input.failuresOnly === true) {
      return json({
        ok: report.ok,
        passed: report.passed,
        failed: report.failed,
        failures: report.failures,
      });
    }
    return json({
      ok: report.ok,
      passed: report.passed,
      failed: report.failed,
      results: report.results,
    });
  },
});

export const compareGolden: RegisteredTool = buildTool({
  name: "CompareGolden",
  description:
    "Compare a value against an expected value, optionally ignoring given paths, ignoring array order and tolerating a numeric epsilon, and report every difference by JSON Pointer. Use as the snapshot check on a response or artifact, where ids, timestamps and result order legitimately move but nothing else may.",
  inputSchema: z
    .object({
      actual: z.unknown(),
      expected: z.unknown(),
      ignorePaths: z
        .array(z.string())
        .max(LIMITS.paths)
        .optional()
        .describe(
          "JSON Pointer patterns to skip; a '*' segment matches any one segment and a trailing '**' matches everything below",
        ),
      ignoreArrayOrder: z.boolean().optional().describe("compare arrays as multisets"),
      epsilon: z.number().min(0).optional().describe("numbers within this distance count as equal"),
      maxDifferences: z.number().int().positive().max(1000).optional(),
    })
    .refine(present("actual", "expected"), { message: "both actual and expected are required" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = compareValues(input.actual, input.expected, {
      ignorePaths: input.ignorePaths ?? [],
      ignoreArrayOrder: input.ignoreArrayOrder ?? false,
      epsilon: input.epsilon ?? 0,
      maxDifferences: input.maxDifferences ?? 50,
    });
    return json({
      equal: result.equal,
      differenceCount: result.differences.length,
      truncated: result.truncated,
      differences: result.differences.map((d) => ({
        path: d.path,
        kind: d.kind,
        message: d.message,
        expected: preview(d.expected, 80),
        actual: preview(d.actual, 80),
      })),
      ...(result.ignored.length > 0 ? { ignored: result.ignored } : {}),
      ...(result.orderedFallbacks.length > 0
        ? {
            orderedFallbacks: result.orderedFallbacks,
            note: "those arrays were too long to match unordered and were compared by position",
          }
        : {}),
    });
  },
});

export const deepEqual: RegisteredTool = buildTool({
  name: "DeepEqual",
  description:
    "Test two values for strict structural equality and, when they differ, report the first difference with its JSON Pointer path. Use for an exact equality gate where any drift matters — and read the one-line path instead of eyeballing two blobs.",
  inputSchema: z
    .object({
      a: z.unknown(),
      b: z.unknown(),
    })
    .refine(present("a", "b"), { message: "both a and b are required" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const difference = firstDifference(input.a, input.b);
    if (difference === null) return json({ equal: true });
    return json({
      equal: false,
      difference: {
        path: difference.path,
        kind: difference.kind,
        message: difference.message,
        expected: preview(difference.expected, 80),
        actual: preview(difference.actual, 80),
      },
    });
  },
});

export const matchSubset: RegisteredTool = buildTool({
  name: "MatchSubset",
  description:
    "Check that a value contains everything an expected partial value specifies, allowing any extra properties, and report what is missing or wrong. Use to assert the parts of an API response you care about without pinning the fields you do not.",
  inputSchema: z
    .object({
      actual: z.unknown(),
      expected: z.unknown().describe("the partial value that must be present inside actual"),
      ignorePaths: z.array(z.string()).max(LIMITS.paths).optional(),
      ignoreArrayOrder: z.boolean().optional(),
      epsilon: z.number().min(0).optional(),
      maxDifferences: z.number().int().positive().max(1000).optional(),
    })
    .refine(present("actual", "expected"), { message: "both actual and expected are required" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = compareValues(input.actual, input.expected, {
      subset: true,
      ignorePaths: input.ignorePaths ?? [],
      ignoreArrayOrder: input.ignoreArrayOrder ?? false,
      epsilon: input.epsilon ?? 0,
      maxDifferences: input.maxDifferences ?? 50,
    });
    return json({
      matches: result.equal,
      differenceCount: result.differences.length,
      truncated: result.truncated,
      differences: result.differences.map((d) => ({
        path: d.path,
        kind: d.kind,
        message: d.message,
        expected: preview(d.expected, 80),
        actual: preview(d.actual, 80),
      })),
      note: "arrays are still compared in full — only object properties may be extra",
    });
  },
});

export const checkRequiredFields: RegisteredTool = buildTool({
  name: "CheckRequiredFields",
  description:
    "Verify that a set of dotted paths are present and non-empty in a value, or in every row of an array, and report which are missing and why. Use as the cheap first gate before work that needs those fields, so a null slips out here rather than three steps later.",
  inputSchema: z
    .object({
      value: z.unknown().describe("an object, or an array of objects with eachRecord set"),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(LIMITS.paths)
        .describe("dotted paths, e.g. ['id', 'customer.email', 'items[0].sku']"),
      allowEmpty: z
        .boolean()
        .optional()
        .describe("count null, '', [] and {} as present (default false, so they count as missing)"),
      eachRecord: z
        .boolean()
        .optional()
        .describe("treat value as an array of rows and check each one"),
      maxFailedRows: z.number().int().positive().max(1000).optional(),
    })
    .refine(present("value"), { message: "value is required" }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const allowEmpty = input.allowEmpty ?? false;
    if (input.eachRecord === true) {
      if (!Array.isArray(input.value)) {
        return "eachRecord was set but value is not an array — pass an array of rows, or drop eachRecord";
      }
      if (input.value.length > LIMITS.records) {
        return `${input.value.length} rows, over the ${LIMITS.records} limit — split the batch`;
      }
      const maxRows = input.maxFailedRows ?? 50;
      const failures: Array<{ row: number; missing: Array<{ path: string; reason: string }> }> = [];
      let failed = 0;
      input.value.forEach((row, index) => {
        const result = checkRequired(row, input.paths, allowEmpty);
        if (result.ok) return;
        failed += 1;
        if (failures.length < maxRows) failures.push({ row: index, missing: result.missing });
      });
      return json({
        ok: failed === 0,
        total: input.value.length,
        passed: input.value.length - failed,
        failed,
        truncated: failed > failures.length,
        failures,
      });
    }
    const result = checkRequired(input.value, input.paths, allowEmpty);
    return json({
      ok: result.ok,
      presentCount: result.present.length,
      missingCount: result.missing.length,
      present: result.present,
      missing: result.missing,
    });
  },
});

export const validateEnum: RegisteredTool = buildTool({
  name: "ValidateEnum",
  description:
    "Check values against an allowed set and report every one that is not a member, with the closest allowed value as a suggestion. Use to gate a status, category or code field, and to catch the near-miss typo that a plain membership test only tells you is wrong.",
  inputSchema: z.object({
    values: z
      .array(z.unknown())
      .min(1)
      .max(LIMITS.values)
      .describe("the values to check; may be strings, numbers, or any JSON value"),
    allowed: z.array(z.unknown()).min(1).max(LIMITS.values).describe("the permitted values"),
    caseInsensitive: z
      .boolean()
      .optional()
      .describe("compare strings ignoring case (non-strings are unaffected)"),
    maxReported: z.number().int().positive().max(1000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const fold = (value: unknown): unknown =>
      input.caseInsensitive === true && typeof value === "string" ? value.toLowerCase() : value;
    const allowedKeys = new Set(input.allowed.map((v) => canonicalize(fold(v))));
    const allowedStrings = input.allowed.filter((v): v is string => typeof v === "string");
    const maxReported = input.maxReported ?? 100;
    const invalid: Array<{ index: number; value: string; suggestion?: string }> = [];
    let invalidCount = 0;
    input.values.forEach((value, index) => {
      if (allowedKeys.has(canonicalize(fold(value)))) return;
      invalidCount += 1;
      if (invalid.length >= maxReported) return;
      const suggestion = typeof value === "string" ? closestMatch(value, allowedStrings) : null;
      invalid.push({
        index,
        value: preview(value, 60),
        ...(suggestion !== null ? { suggestion } : {}),
      });
    });
    return json({
      ok: invalidCount === 0,
      total: input.values.length,
      valid: input.values.length - invalidCount,
      invalidCount,
      truncated: invalidCount > invalid.length,
      invalid,
    });
  },
});

export const validateFormat: RegisteredTool = buildTool({
  name: "ValidateFormat",
  description: `Check strings against a format implemented in this package (${FORMAT_NAMES.join(", ")}) and report each failure with the reason it failed. Use to validate emails, URLs, addresses, ids and timestamps without a regex you have to trust — each format's exact accepted subset is documented in the README.`,
  inputSchema: z.object({
    values: z.array(z.string()).min(1).max(LIMITS.values).describe("the strings to check"),
    format: z.enum(FORMAT_NAMES),
    maxReported: z.number().int().positive().max(1000).optional(),
    suggestFormats: z
      .boolean()
      .optional()
      .describe("for each failure, also report which formats the value does match"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const maxReported = input.maxReported ?? 100;
    const invalid: Array<{ index: number; value: string; reason: string; matches?: FormatName[] }> =
      [];
    let invalidCount = 0;
    input.values.forEach((value, index) => {
      const result = checkFormat(value, input.format);
      if (result.valid) return;
      invalidCount += 1;
      if (invalid.length >= maxReported) return;
      const matches = input.suggestFormats === true ? matchingFormats(value) : undefined;
      invalid.push({
        index,
        value: preview(value, 80),
        reason: result.reason ?? "invalid",
        ...(matches !== undefined && matches.length > 0 ? { matches } : {}),
      });
    });
    return json({
      ok: invalidCount === 0,
      format: input.format,
      total: input.values.length,
      valid: input.values.length - invalidCount,
      invalidCount,
      truncated: invalidCount > invalid.length,
      invalid,
    });
  },
});

export const validateUniqueKeys: RegisteredTool = buildTool({
  name: "ValidateUniqueKeys",
  description:
    "Find rows that share a key, where the key may be several fields together, and report each colliding group with its row indices. Use to enforce a uniqueness constraint before an import or an upsert, when a duplicate would otherwise overwrite good data.",
  inputSchema: z.object({
    records: z.array(z.unknown()).max(LIMITS.records),
    keyFields: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe("dotted paths making up the key; several fields form a composite key"),
    caseInsensitive: z.boolean().optional().describe("lowercase string values before comparing"),
    maxGroups: z.number().int().positive().max(1000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const report = findDuplicates(input.records, input.keyFields, {
      caseInsensitive: input.caseInsensitive ?? false,
      maxGroups: input.maxGroups ?? 50,
    });
    return json({
      ok: report.ok,
      total: report.total,
      distinctKeys: report.distinctKeys,
      duplicateGroups: report.duplicates.length,
      truncated: report.truncated,
      duplicates: report.duplicates,
      ...(report.unkeyed.length > 0 ? { unkeyed: report.unkeyed.slice(0, 50) } : {}),
    });
  },
});

export const validateReferences: RegisteredTool = buildTool({
  name: "ValidateReferences",
  description:
    "Check that every row's reference field points at a value that exists, either in a list you give or in a field of a parent array, and report the dangling ones. Use as the referential-integrity gate on joined data before writing it anywhere.",
  inputSchema: z
    .object({
      records: z.array(z.unknown()).max(LIMITS.records).describe("the rows carrying the reference"),
      field: z.string().min(1).describe("dotted path to the reference, e.g. 'customerId'"),
      allowed: z
        .array(z.unknown())
        .max(LIMITS.records)
        .optional()
        .describe("the permitted values; give this or parentRecords"),
      parentRecords: z
        .array(z.unknown())
        .max(LIMITS.records)
        .optional()
        .describe("the parent rows to draw allowed values from"),
      parentField: z.string().min(1).optional().describe("dotted path to the key in parentRecords"),
      allowMissing: z
        .boolean()
        .optional()
        .describe("treat an absent or null reference as acceptable"),
      reportUnreferenced: z
        .boolean()
        .optional()
        .describe("also list allowed values that no row referred to"),
      maxDangling: z.number().int().positive().max(1000).optional(),
    })
    .refine(
      (v) =>
        v.allowed !== undefined || (v.parentRecords !== undefined && v.parentField !== undefined),
      {
        message: "give allowed, or both parentRecords and parentField",
      },
    ),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const allowed =
      input.allowed ?? collectFieldValues(input.parentRecords ?? [], input.parentField ?? "");
    const report = checkReferences(input.records, input.field, allowed, {
      allowMissing: input.allowMissing ?? false,
      reportUnreferenced: input.reportUnreferenced ?? false,
      maxDangling: input.maxDangling ?? 50,
    });
    return json({
      ok: report.ok,
      total: report.total,
      checked: report.checked,
      allowedCount: allowed.length,
      danglingCount: report.dangling.length,
      truncated: report.truncated,
      dangling: report.dangling,
      ...(report.unreferenced.length > 0
        ? {
            unreferencedCount: report.unreferenced.length,
            unreferenced: report.unreferenced.slice(0, 50),
          }
        : {}),
    });
  },
});

export const schemaDiff: RegisteredTool = buildTool({
  name: "SchemaDiff",
  description:
    "Diff two JSON Schemas and classify every change as compatible, breaking or undecidable for a reader of the data. Use before shipping a contract change, to answer whether existing payloads still validate — an undecidable change is reported as such, never rounded to safe.",
  inputSchema: z.object({
    before: schemaInput.describe("the schema in production"),
    after: schemaInput.describe("the proposed schema"),
    breakingOnly: z
      .boolean()
      .optional()
      .describe("return only the breaking and undecidable changes"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = diffSchemas(input.before, input.after);
    const changes =
      input.breakingOnly === true
        ? result.changes.filter((c) => c.compat !== "compatible")
        : result.changes;
    return json({
      identical: result.identical,
      verdict: result.verdict,
      backwardCompatible: result.backwardCompatible,
      counts: result.counts,
      changes,
      note: "backward compatible means every value valid under `before` is still valid under `after`",
    });
  },
});

export const schemaSummarize: RegisteredTool = buildTool({
  name: "SchemaSummarize",
  description:
    "Flatten a JSON Schema into one row per field — path, type, required, constraints — as a markdown table or as JSON. Use to put a large schema in front of a person or a model compactly, or to generate the field table in a document from the schema itself.",
  inputSchema: z.object({
    schema: schemaInput,
    format: z.enum(["table", "json"]).optional().describe("markdown table (default) or JSON rows"),
    maxRows: z.number().int().positive().max(2000).optional(),
    maxDepth: z.number().int().min(1).max(20).optional(),
    requiredOnly: z.boolean().optional().describe("list only the required fields"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = summarizeSchema(input.schema, {
      maxRows: input.maxRows ?? 300,
      maxDepth: input.maxDepth ?? 8,
    });
    const rows = input.requiredOnly === true ? result.rows.filter((r) => r.required) : result.rows;
    if (input.format === "json") {
      return json({
        title: result.title,
        rootType: result.rootType,
        fieldCount: rows.length,
        truncated: result.truncated,
        fields: rows,
      });
    }
    if (rows.length === 0) {
      return `${result.title === "" ? "schema" : result.title}: ${result.rootType} with no described fields`;
    }
    const header = `${result.title === "" ? "Schema" : result.title} (${result.rootType}, ${rows.length} fields)`;
    const footer = result.truncated ? "\n\n(truncated — raise maxRows to see the rest)" : "";
    return `${header}\n\n${renderFieldTable(rows)}${footer}`;
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const SCHEMA_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  assert,
  checkRequiredFields,
  compareGolden,
  deepEqual,
  jsonSchemaInfer,
  jsonSchemaValidate,
  matchSubset,
  schemaDiff,
  schemaSummarize,
  validateEnum,
  validateFormat,
  validateRecords,
  validateReferences,
  validateUniqueKeys,
]);
