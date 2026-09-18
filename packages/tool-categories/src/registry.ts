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
  ingest: {
    title: "Pull a file's text in through the pluggable ingest parsers",
    tools: ["ingestDocument"],
  },
  media: {
    title: "Inspect and produce images, codes, charts and diagrams, and probe audio and video",
    tools: [
      "readImage",
      "imageGenerate",
      "imageInfo",
      "imageKind",
      "pngRead",
      "pngWrite",
      "imageResize",
      "imageCrop",
      "imageDiff",
      "exifRead",
      "exifStrip",
      "qrEncode",
      "barcodeEncode",
      "chartRender",
      "sparklineRender",
      "diagramRender",
      "colorConvert",
      "colorContrast",
      "subtitleParse",
      "subtitleWrite",
      "mediaProbe",
    ],
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
    title: "HTTP: a single fetch, plus pagination, GraphQL, downloads, webhooks, DNS and TLS",
    tools: [
      "fetch",
      "httpRequest",
      "httpPaginate",
      "graphqlQuery",
      "httpBatch",
      "downloadFile",
      "headRequest",
      "urlReachable",
      "linkCheck",
      "httpWaitFor",
      "sseRead",
      "webhookSign",
      "webhookVerify",
      "dnsLookup",
      "tlsInspect",
      "robotsCheck",
      "sitemapParse",
      "feedParse",
    ],
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
      "base64Encode",
      "base64Decode",
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

  git: {
    title:
      "Read and change a git repository: status, diffs, history, blame, branches, commits, stashes and worktrees",
    tools: [
      "gitStatus",
      "gitDiff",
      "gitLog",
      "gitShow",
      "gitBlame",
      "gitBranchList",
      "gitTagList",
      "gitRemoteList",
      "gitMergeBase",
      "gitRevParse",
      "gitFileHistory",
      "gitStashList",
      "gitConflicts",
      "gitWorktreeList",
      "gitAdd",
      "gitCommit",
      "gitSwitch",
      "gitBranchCreate",
      "gitBranchDelete",
      "gitStashPush",
      "gitStashPop",
      "gitTagCreate",
      "gitApplyPatch",
      "gitCherryPick",
      "gitResetPaths",
      "gitWorktreeAdd",
      "gitWorktreeRemove",
    ],
  },

  fsx: {
    title:
      "Filesystem beyond read and write: trees, stats, hashes, copies, archives, frontmatter and notebooks",
    tools: [
      "stat",
      "fileHash",
      "tree",
      "diskUsage",
      "findFiles",
      "readLines",
      "tailFile",
      "makeDirectory",
      "touchFile",
      "tempDir",
      "copyPath",
      "movePath",
      "removePath",
      "splitFile",
      "concatFiles",
      "archiveList",
      "archiveCreate",
      "archiveExtract",
      "frontmatterRead",
      "frontmatterWrite",
      "notebookRead",
      "notebookEdit",
    ],
  },

  proc: {
    title: "Run commands safely, manage background processes, and wait on ports, files and output",
    tools: [
      "runCommand",
      "runPipeline",
      "retry",
      "processStart",
      "processStatus",
      "processOutput",
      "processStop",
      "processList",
      "waitForPort",
      "waitForFile",
      "waitForOutput",
      "commandExists",
      "envInspect",
    ],
  },

  state: {
    title:
      "Durable harness state: key-value, counters, checkpoints, journals, notes and lexical search",
    tools: [
      "kvSet",
      "kvGet",
      "kvDelete",
      "kvList",
      "counterIncrement",
      "counterGet",
      "checkpointSave",
      "checkpointLoad",
      "checkpointList",
      "journalAppend",
      "journalRead",
      "blackboardPost",
      "blackboardRead",
      "noteWrite",
      "noteSearch",
      "indexBuild",
      "indexSearch",
      "stateExport",
      "stateImport",
      "dedupeMark",
    ],
  },

  crewhaus: {
    title:
      "Supervise CrewHaus harnesses: validate specs, check compiles, preflight, audit and compare eval runs",
    tools: [
      "specValidate",
      "specCompileCheck",
      "specSummarize",
      "specDiff",
      "toolInventory",
      "permissionAudit",
      "preflightRun",
      "harnessInventory",
      "bundleFreshness",
      "auditVerify",
      "evalBaselineCompare",
      "sessionSummarize",
      "traceQuery",
      "costSummarize",
    ],
  },

  codehost: {
    title: "GitHub and GitLab: pull requests, issues, reviews, checks, CI runs and releases",
    tools: [
      "prList",
      "prGet",
      "prFiles",
      "prComments",
      "prReviews",
      "issueList",
      "issueGet",
      "checkRuns",
      "workflowRuns",
      "workflowRunLogs",
      "releaseList",
      "releaseGet",
      "repoGet",
      "compareRefs",
      "searchCode",
      "searchIssues",
      "rateLimitStatus",
      "prCreate",
      "prUpdate",
      "prComment",
      "prReviewSubmit",
      "issueCreate",
      "issueUpdate",
      "issueComment",
      "releaseCreate",
      "workflowRunRerun",
    ],
  },

  sql: {
    title:
      "SQLite: queries with bound parameters, schema introspection, migrations, import and export",
    tools: [
      "sqlQuery",
      "sqlExec",
      "sqlTransaction",
      "sqlExplain",
      "schemaList",
      "schemaDescribe",
      "dbSchemaDiff",
      "tableStats",
      "integrityCheck",
      "importCsv",
      "importJson",
      "exportCsv",
      "exportJson",
      "databaseBackup",
      "migrationStatus",
      "migrationApply",
    ],
  },

  toolchain: {
    title: "Drive a project's own toolchain and turn its output into structured findings",
    tools: [
      "runTests",
      "testFailureSummary",
      "runBuild",
      "typecheck",
      "lint",
      "format",
      "formatCheck",
      "diagnostics",
      "astQuery",
      "symbolOutline",
      "findReferences",
      "importGraph",
      "deadFileScan",
      "todoScan",
      "dependencyList",
      "dependencyOutdated",
      "packageScripts",
      "workspacePackages",
      "coverageSummary",
      "stackTraceParse",
    ],
  },

  documents: {
    title:
      "Read and write real document formats: Word, Excel, PowerPoint, PDF, email, calendar and contacts",
    tools: [
      "docxRead",
      "docxWrite",
      "xlsxRead",
      "xlsxWrite",
      "pptxRead",
      "pdfInfo",
      "pdfText",
      "pdfSplit",
      "pdfMerge",
      "emlParse",
      "mboxSplit",
      "icsParse",
      "icsWrite",
      "vcardParse",
      "documentText",
      "documentDiff",
    ],
  },

  secure: {
    title:
      "Find and remove sensitive content, check policy, and sign evidence — every detector a stated heuristic",
    tools: [
      "piiScan",
      "piiRedact",
      "pseudonymize",
      "depseudonymize",
      "secretScan",
      "entropyScore",
      "promptInjectionScan",
      "invisibleCharScan",
      "homoglyphNormalize",
      "urlSafetyCheck",
      "allowlistCheck",
      "contentPolicyCheck",
      "hashChainVerify",
      "signPayload",
      "verifyPayload",
      "redactForExport",
    ],
  },

  math: {
    title: "Arithmetic, statistics, exact money, units, and financial and geospatial formulas",
    tools: [
      "evaluate",
      "statistics",
      "percentile",
      "correlation",
      "linearRegression",
      "histogram",
      "outliers",
      "moneyAdd",
      "moneyMultiply",
      "moneyAllocate",
      "currencyConvert",
      "unitConvert",
      "round",
      "numberFormat",
      "numberParse",
      "percent",
      "amortize",
      "npv",
      "irr",
      "geoDistance",
      "geoBoundingBox",
      "geoPointInPolygon",
    ],
  },

  notify: {
    title:
      "Reach people: chat, email, webhooks, SMS and push, with digests, quiet hours and templates",
    tools: [
      "chatPost",
      "chatUpdate",
      "chatDelete",
      "chatReact",
      "emailCompose",
      "emailSend",
      "webhookPost",
      "smsSend",
      "pushNotify",
      "deliveryCheck",
      "notifyDigest",
      "quietHours",
      "rateLimitGate",
      "messageTemplate",
    ],
  },

  obs: {
    title:
      "See what a harness did and what it cost: events, tool stats, errors, budgets, service levels and incidents",
    tools: [
      "eventQuery",
      "eventCounts",
      "toolCallStats",
      "errorCluster",
      "runTimeline",
      "costReport",
      "budgetCheck",
      "sloEvaluate",
      "incidentBundle",
      "metricsQuery",
      "logsQuery",
      "alertList",
      "alertAck",
      "statusPagePost",
      "healthProbe",
    ],
  },

  // ---- roll-ups ----
  code: {
    title: "Everything for working in a codebase",
    includes: [
      "fs",
      "codegraph",
      "process",
      "code-exec",
      "git",
      "fsx",
      "proc",
      "codehost",
      "toolchain",
    ],
  },
  filesystem: {
    title: "Everything that touches files: the core five plus trees, hashes, copies and archives",
    includes: ["fs", "fsx"],
  },
  memory: {
    title: "Everything a harness remembers between turns and between runs",
    includes: ["todo", "state"],
  },
  "data-stores": {
    title: "Durable stores a harness reads and writes: SQL databases and harness state",
    includes: ["sql", "state"],
  },
  safety: {
    title: "Finding and removing what must not leave the system, and proving what did not change",
    includes: ["secure"],
  },
  outreach: {
    title: "Everything that puts something in front of a person outside the harness",
    includes: ["notify"],
  },
  operations: {
    title: "Running and supervising harnesses: telemetry, cost, incidents, specs and fleets",
    includes: ["obs", "crewhaus"],
  },
  network: {
    title: "Everything that reaches the network",
    includes: ["web", "http"],
  },
  compute: {
    title: "Everything a harness can do with no I/O at all — pure, in-process, zero tokens",
    includes: ["text", "data", "encode", "datetime", "schema", "math"],
  },
  content: {
    title: "Everything that reads or produces documents and images",
    includes: ["ingest", "documents", "media", "text"],
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
