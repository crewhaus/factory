/**
 * The tool category registry — the single source of truth for which builtin
 * tool keys belong to which category, and which categories roll up into
 * which broader ones.
 *
 * DATA ONLY. This package must never import a tool package: the compiler
 * expands `all-<category>` selectors at lower() time and codegen must stay
 * offline, so pulling a tool implementation in here would drag Bun/network/
 * sandbox dependencies into the compile path.
 *
 * Keeping it honest: `packages/tool-categories` cannot itself prove that a
 * key here resolves to a real tool. `apps/cli/src/tool-registry.test.ts` —
 * which CAN import every builtin — asserts both directions:
 *   (1) every key listed here exists in the emitter's BUILTIN_TOOL_MAP, and
 *   (2) every key in BUILTIN_TOOL_MAP is listed in exactly one leaf category.
 * Add a builtin without categorizing it and that test fails.
 */

/** A leaf category owns tool keys; a roll-up category owns other categories. */
export type CategoryDef = {
  /** One-line human summary, shown by `crewhaus tools categories`. */
  readonly title: string;
  /** camelCase spec keys owned directly by this category. */
  readonly tools?: ReadonlyArray<string>;
  /** Other category names this one rolls up. Expanded transitively. */
  readonly includes?: ReadonlyArray<string>;
};

/**
 * Leaf categories map 1:1 onto the `@crewhaus/tool-*` package that
 * implements them, so `all-git` means "every tool `@crewhaus/tool-git`
 * exports". Roll-ups exist so an operator can say `all-code` without
 * naming the seven code categories underneath it.
 */
export const CATEGORIES: Readonly<Record<string, CategoryDef>> = Object.freeze({
  // ---- leaf categories: filesystem and content ----
  fs: {
    title: "Read, write, edit, and search files in the workspace",
    tools: ["read", "write", "edit", "glob", "grep"],
  },
  docs: {
    title: "Ingest documents into text the harness can work with",
    tools: ["ingestDocument"],
  },
  media: {
    title: "Read and generate images",
    tools: ["readImage", "imageGenerate"],
  },

  text: {
    title: "Transform, measure, diff and classify text without a model call",
    tools: [
      "compactLog",
      "countTokens",
      "escapeString",
      "extractEntities",
      "extractKeywords",
      "fuzzyMatch",
      "glossaryReplace",
      "markdownOutline",
      "markdownTable",
      "normalizeText",
      "regexExtract",
      "renderTemplate",
      "ruleClassify",
      "sortLines",
      "textDiff",
      "textSimilarity",
      "truncateToBudget",
      "wrapText",
    ],
  },

  // ---- leaf categories: execution ----
  process: {
    title: "Run shell commands and manage background processes",
    tools: ["bash", "bashOutput", "killShell"],
  },
  "code-exec": {
    title: "Run Python, JavaScript, or shell inside the sandbox",
    tools: ["python", "javascript", "shell"],
  },

  // ---- leaf categories: network ----
  web: {
    title: "Fetch and search the public web",
    tools: ["webFetch", "webSearch"],
  },
  http: {
    title: "Make arbitrary HTTP requests against allow-listed origins",
    tools: ["fetch"],
  },

  // ---- leaf categories: code intelligence ----
  codegraph: {
    title: "Ask the code graph for callers, callees, and impact radius",
    tools: ["codegraphSearch", "codegraphCallers", "codegraphCallees", "codegraphImpact"],
  },

  // ---- leaf categories: harness state ----
  todo: {
    title: "Track the working todo list",
    tools: ["todoWrite"],
  },

  data: {
    title: "Parse, query, reshape and convert JSON, YAML, TOML, CSV and XML",
    tools: [
      "jsonQuery",
      "jsonPatch",
      "jsonMergePatch",
      "jsonFormat",
      "dataDiff",
      "dataConvert",
      "csvParse",
      "csvWrite",
      "tableQuery",
      "tableAggregate",
      "tableJoin",
      "recordsToColumns",
      "columnsToRecords",
      "flattenObject",
      "unflattenObject",
      "jsonlParse",
      "jsonlWrite",
      "xmlParse",
      "sortRecords",
      "dedupeRecords",
      "sampleRecords",
      "dataShape",
      "jsonSortKeys",
    ],
  },

  encode: {
    title: "Hash, sign, encode and mint identifiers",
    tools: [
      "hash",
      "hmac",
      "checksum",
      "hexEncode",
      "hexDecode",
      "urlEncode",
      "urlDecode",
      "urlParse",
      "urlBuild",
      "urlNormalize",
      "uuid",
      "ulid",
      "nanoId",
      "slugify",
      "jwtDecode",
      "jwtVerify",
    ],
  },

  datetime: {
    title: "Parse, format and compute with dates, times, durations and schedules",
    tools: [
      "dateParse",
      "dateFormat",
      "dateConvertTimezone",
      "dateAdd",
      "dateDiff",
      "durationParse",
      "durationFormat",
      "businessDays",
      "dateRange",
      "cronNext",
      "cronDescribe",
      "recurrenceExpand",
      "weekOfYear",
      "dayOfYear",
      "isLeapYear",
      "quarterOf",
      "timestampConvert",
    ],
  },

  schema: {
    title: "Validate, assert and compare structured values against a contract",
    tools: [
      "jsonSchemaValidate",
      "jsonSchemaInfer",
      "validateRecords",
      "assert",
      "compareGolden",
      "deepEqual",
      "matchSubset",
      "checkRequiredFields",
      "validateEnum",
      "validateFormat",
      "validateUniqueKeys",
      "validateReferences",
      "schemaDiff",
      "schemaSummarize",
    ],
  },

  // ---- roll-ups ----
  code: {
    title: "Everything for working in a codebase",
    includes: ["fs", "codegraph", "process", "code-exec"],
  },
  network: {
    title: "Everything that reaches the network",
    includes: ["web", "http"],
  },
  compute: {
    title: "Everything a harness can do with no I/O at all — pure, in-process, zero tokens",
    includes: ["text", "data", "encode", "datetime", "schema"],
  },
  content: {
    title: "Everything that reads or produces documents and images",
    includes: ["docs", "media", "text"],
  },
});

/** Category names that own tool keys directly. */
export function leafCategories(): ReadonlyArray<string> {
  return Object.keys(CATEGORIES)
    .filter((name) => CATEGORIES[name]?.tools !== undefined)
    .sort();
}

/** Category names that roll up other categories. */
export function rollUpCategories(): ReadonlyArray<string> {
  return Object.keys(CATEGORIES)
    .filter((name) => CATEGORIES[name]?.includes !== undefined)
    .sort();
}
