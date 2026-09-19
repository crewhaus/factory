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
      "diffParse",
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

  flow: {
    title:
      "Control flow: branching, decision tables, error classification, deadlines, consensus, stall detection and rule scoring",
    tools: [
      "branch",
      "consensusVote",
      "deadlineCheck",
      "decisionTable",
      "errorClassify",
      "ruleScore",
      "stallDetect",
    ],
  },

  packaging: {
    title:
      "Packages, lockfiles and releases: semver resolution, dependency diffs, license rollups, tarball inspection and publish preflight",
    tools: [
      "licenseAggregate",
      "lockfileDiff",
      "packagePublishPreflight",
      "packageTarballInspect",
      "semverResolve",
    ],
  },

  money: {
    title:
      "Money arithmetic and the controls around it: tax, refunds, matching, cost basis, spend limits and statement parsing",
    tools: [
      "costBasisCompute",
      "glCodeSuggest",
      "paymentIdentifierValidate",
      "purchaseOrderMatch",
      "refundAbuseCheck",
      "refundAmountCompute",
      "spendLimitCheck",
      "statementParse",
      "taxCalculate",
      "webhookSignatureVerify",
    ],
  },

  onchain: {
    title:
      "Onchain arithmetic, offline: ABI encoding and decoding, address checksums, EIP-712 digests, unit conversion and fixed-point DeFi maths",
    tools: [
      "abiDecode",
      "abiEncodeCall",
      "addressCheck",
      "defiMath",
      "functionSelector",
      "typedDataHash",
      "tokenUnits",
    ],
  },

  html: {
    title:
      "Reading HTML without a browser: CSS selection, tables, links, forms, structured data, readable text and declarative scraping",
    tools: [
      "htmlForms",
      "htmlLinks",
      "htmlQuery",
      "htmlRecords",
      "htmlStructuredData",
      "htmlTable",
      "htmlText",
    ],
  },

  verify: {
    title:
      "Verification gates: golden comparison, checksum manifests, acceptance checks, Markdown link checking and citation linting",
    tools: [
      "acceptanceCheck",
      "checksumVerify",
      "citationLint",
      "goldenCompare",
      "goldenUpdate",
      "markdownLinkCheck",
    ],
  },

  tabular: {
    title:
      "Tabular intake: profiling, keyed reconciliation, record linkage, contact normalization, reshaping, sharding and fixed-width parsing",
    tools: [
      "contactNormalize",
      "fixedWidthParse",
      "recordLinkage",
      "tableDiff",
      "tableProfile",
      "tableReshape",
      "tableShard",
      "dataDriftCheck",
    ],
  },

  changeset: {
    title:
      "Decide everything you can about a change set from the diff alone, before it becomes a PR",
    tools: ["diffLint", "docsSymbolCheck"],
  },

  buildperf: {
    title: "Measure this build against its baseline: bundle size, benchmark timings and flakiness",
    tools: ["bundleSizeCheck", "benchmarkCompare", "flakyTestDetect"],
  },

  registry: {
    title:
      "Ask the public package registries what exists and what is newest, and write it back into a manifest",
    tools: ["registryPackageInfo", "registrySearch", "registryOutdated", "manifestDependencySet"],
  },

  supplychain: {
    title: "Known vulnerabilities from a lockfile, and supply-chain hygiene in a CI workflow",
    tools: ["dependencyAudit", "ciWorkflowAudit"],
  },

  containers: {
    title:
      "Resolve image tags to digests and list tags over the OCI distribution API, with no daemon and no pull",
    tools: ["containerImageInspect", "containerImageTags"],
  },

  chainread: {
    title:
      "Read what an EVM chain recorded: blocks, transactions, receipts, logs, nonces and endpoint health",
    tools: [
      "evmGetBlock",
      "evmBlockAtTimestamp",
      "evmRpcHealth",
      "evmNonceStatus",
      "evmWaitForReceipt",
      "evmTransactionSummary",
      "evmEventScan",
    ],
  },

  chaincall: {
    title:
      "Ask an EVM contract what it knows and what a call would cost: batched reads, introspection, gas and simulation",
    tools: ["evmMulticall", "contractInspect", "evmSimulateBundle", "gasMarketRead"],
  },

  token: {
    title: "Resolve tokens and read balances, with ambiguity refused and impostors flagged",
    tools: ["tokenResolve", "erc20Balance", "erc721TokenInfo"],
  },

  defi: {
    title: "Value what you hold, with provenance and an explicit unpriced bucket",
    tools: ["priceQuote", "oraclePriceRead", "defiPositionRead", "portfolioValuation"],
  },

  ledger: {
    title: "A hash-chained double-entry ledger, with queries, reconciliation and invoice rendering",
    tools: ["ledgerPost", "ledgerQuery", "ledgerReconcile", "invoiceRender"],
  },

  einvoice: {
    title:
      "Fixed-format financial files banks and tax authorities parse byte-exactly: e-invoice XML and payment batches",
    tools: ["eInvoiceBuild", "eInvoiceParse", "paymentFileBuild"],
  },

  kyc: {
    title:
      "Counterparty checks against public registries and sanctions lists, reporting signals and evidence rather than a verdict",
    tools: ["vatIdValidate", "entityRegistryLookup", "sanctionsScreen"],
  },

  objectstore: {
    title: "Object-store URL signing: time-limited SigV4 GET and PUT computed offline",
    tools: ["objectPresign"],
  },

  host: {
    title:
      "Read-only facts about the machine a harness is running on: system, network and listening ports",
    tools: ["systemInfo", "networkInfo", "portInspect"],
  },

  secrets: {
    title:
      "Resolve secret references and maintain .env files, reporting presence and provenance rather than values",
    tools: ["secretLookup", "envFileUpsert", "secretRotate"],
  },

  hostfs: {
    title:
      "Host filesystem beyond read and write: watching a path, recoverable deletion and the OS file index",
    tools: ["watchPath", "trashPath", "osIndexSearch"],
  },

  cron: {
    title:
      "Inspect and remove entries in the host's own scheduler: crontab, launchd and systemd timers",
    tools: ["cronList", "cronDelete"],
  },

  distribution: {
    title:
      "Render the package manifests for a released binary, and verify a published one points at assets that exist and hash correctly",
    tools: ["packageManifestGenerate", "packageManifestVerify"],
  },

  pkgmgr: {
    title:
      "Ask the system package manager what is installed and available, and install from it without acquiring privilege",
    tools: ["packageQuery", "packageInstall"],
  },

  desktop: {
    title:
      "The operator's actual desktop: clipboard, notifications, opening a document, printing, windows, presence and sleep — failing closed on a headless host",
    tools: [
      "clipboardRead",
      "clipboardWrite",
      "desktopNotify",
      "openExternal",
      "printDocument",
      "windowList",
      "userPresence",
      "powerAssertion",
    ],
  },

  specops: {
    title:
      "Change a harness spec safely: CST-preserving patches, migrations, advisory findings and mechanical repairs",
    tools: ["specPatchApply", "specUpgrade", "specAdvise", "doctorFix"],
  },

  evalops: {
    title: "Recompute, trend, pin and sanity-check eval results without running an eval",
    tools: ["evalHistory", "evalAggregate", "evalBaselinePin", "evalCoverage", "graderMetaTest"],
  },

  dataset: {
    title: "Version, inspect, validate and grow eval datasets",
    tools: ["datasetPut", "datasetInspect", "datasetLint", "datasetMine"],
  },

  approvals: {
    title:
      "Read what is parked waiting for a human, and propose the permission rules that would stop the asking",
    tools: ["approvalStatus", "approvalsInbox", "permissionsSuggest"],
  },

  lifecycle: {
    title:
      "Harness lifecycle: retirement, store migration, retention enforcement and knowledge sync",
    tools: ["harnessRetire", "storeMigrate", "retentionEnforce", "knowledgeSync"],
  },

  fleet: {
    title: "Register, recompile, version-pin and inspect the harnesses on this machine",
    tools: ["harnessRegister", "harnessJobStatus", "compileBundle", "cliVersionPin", "hooksManage"],
  },

  deploy: {
    title:
      "Move a spec version between environments in the local registry, and report what is pinned where",
    tools: ["specPin", "deployRollback", "deployInspect"],
  },

  routing: {
    title: "Read and steer model routing, experiments and observational learning",
    tools: ["routeControl", "experimentLedger", "flywheelStatus", "watchmeReport"],
  },

  discovery: {
    title: "Search the local template marketplace and enumerate reachable federation peers",
    tools: ["marketplaceSearch", "federationDiscover"],
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
      "packaging",
      "changeset",
      "buildperf",
      "registry",
      "supplychain",
      "containers",
      "distribution",
    ],
  },
  filesystem: {
    title: "Everything that touches files: the core five plus trees, hashes, copies and archives",
    includes: ["fs", "fsx", "hostfs"],
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
    includes: ["secure", "verify", "secrets", "approvals"],
  },
  outreach: {
    title: "Everything that puts something in front of a person outside the harness",
    includes: ["notify"],
  },
  operations: {
    title: "Running and supervising harnesses: telemetry, cost, incidents, specs and fleets",
    includes: [
      "obs",
      "crewhaus",
      "money",
      "ledger",
      "einvoice",
      "kyc",
      "objectstore",
      "host",
      "cron",
      "pkgmgr",
      "desktop",
      "specops",
      "evalops",
      "dataset",
      "lifecycle",
      "fleet",
      "deploy",
      "routing",
      "discovery",
    ],
  },
  chain: {
    title: "Everything that touches a blockchain, offline arithmetic and live reads alike",
    // `onchain` is the pure half — ABI coding, EIP-712 digests, checksums — and the other three
    // read a node. They are grouped here because "what can this harness do with a chain" is a
    // question people actually ask, and answering it with four separate selectors is worse.
    // Nothing in any of them signs or submits; that is asserted per package, not assumed.
    includes: ["onchain", "chainread", "chaincall", "token", "defi"],
  },
  network: {
    title: "Everything that reaches the network",
    // A leaf may sit in more than one roll-up — `text` is in both `compute`
    // and `content`. These three are listed under `code` because that is what
    // they are FOR, and here because of what they DO: a registry read, an OSV
    // query and an OCI manifest fetch all leave the machine, and a roll-up
    // that claims "everything that reaches the network" has to mean it.
    includes: [
      "web",
      "http",
      "registry",
      "supplychain",
      "containers",
      "chainread",
      "chaincall",
      "token",
      "defi",
    ],
  },
  compute: {
    title: "Everything a harness can do with no I/O at all — pure, in-process, zero tokens",
    includes: ["text", "data", "encode", "datetime", "schema", "math", "flow", "onchain"],
  },
  content: {
    title: "Everything that reads or produces documents and images",
    includes: ["ingest", "documents", "media", "text", "html"],
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
