/**
 * Item 18 — `crewhaus tools` namespace: builtin discovery + usage audit.
 * The pure, side-effect-free half of the tool advisor. Three sub-commands:
 *
 *   list          — every builtin's name/description/scope/ioCapability/
 *                   readOnly/destructive, from the RegisteredTool metadata
 *                   the runtime already carries.
 *   suggest <spec> — rank builtins against `agent.instructions` by a
 *                   deterministic keyword match (no model — the tool
 *                   implication is the same shape scaffold-evals uses).
 *   audit         — mine `tool_stats` + `tool_use` events across sessions
 *                   to propose (a) removing tools never called, (b) flagging
 *                   chronically failing tools, (c) learned read-only
 *                   candidates (many clean calls). ADVICE-ONLY: `tools:` is
 *                   not in OPTIMIZABLE_PATHS, so every edit is a human-review
 *                   suggestion, never an eval-gated auto-apply.
 *
 * Everything here is pure so it is unit-testable; all filesystem access
 * (loadToolMap, session reads, spec reads) lives in `apps/cli/src/index.ts`,
 * mirroring `advise-rules.ts`.
 *
 * Casing bridge (load-bearing): a spec's `tools:` list uses the camelCase
 * BUILTIN_TOOL_MAP keys (`read`, `webFetch`), but a session log's
 * `tool_stats.toolName` / `tool_use.name` carry the RegisteredTool's
 * PascalCase `.name` (`Read`, `WebFetch`). The audit correlates the two
 * through the tool map (spec key → `.name`), so a tool named in the spec is
 * matched to its runtime call stats regardless of the two casings.
 */
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { SessionEvents } from "./advise-rules";
import { payloadOf } from "./advise-rules";

// -------- tools list --------

/** One row of `tools list`, projected from a RegisteredTool. */
export type ToolListRow = {
  /** The camelCase spec/map key (what a user writes in `tools:`). */
  readonly key: string;
  /** The RegisteredTool's PascalCase `.name` (what session logs record). */
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
};

/** Project a tool map (key → RegisteredTool) into sorted list rows. */
export function buildToolList(toolMap: Readonly<Record<string, RegisteredTool>>): ToolListRow[] {
  return Object.entries(toolMap)
    .map(([key, t]) => ({
      key,
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
      destructive: t.destructive,
      scope: t.scope,
      ...(t.ioCapability !== undefined ? { ioCapability: t.ioCapability } : {}),
      requiresSandbox: t.requiresSandbox,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** One line per tool for the CLI's text mode. */
export function formatToolListLines(rows: ReadonlyArray<ToolListRow>): string[] {
  const lines: string[] = [];
  for (const r of rows) {
    const flags = [
      r.readOnly ? "read-only" : undefined,
      r.destructive ? "destructive" : undefined,
      r.scope === "external" ? "external" : undefined,
      r.ioCapability !== undefined ? `io:${r.ioCapability}` : undefined,
      r.requiresSandbox ? "sandbox" : undefined,
    ].filter((f): f is string => f !== undefined);
    const tags = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`${r.key} (${r.name})${tags}`);
    lines.push(`  ${r.description}`);
  }
  return lines;
}

// -------- tools suggest --------

/**
 * Deterministic keyword → tool implication. Each tool key maps to the
 * lowercased keywords whose presence in an agent's instructions implies the
 * tool is likely wanted. Kept intentionally small and obvious (no model, no
 * fuzzy match) — the same posture scaffold-evals uses when it derives
 * `expected_tools` from a task. Unknown/custom tools never appear here (only
 * builtins are suggestible).
 *
 * EVERY builtin key must appear here: a builtin with no keywords can never be
 * suggested no matter what the instructions say, which silently shrinks the
 * catalogue this command claims to rank. `tools-cli.test.ts` asserts the key
 * set covers `CLI_RUNTIME_TOOL_KEYS` — add keywords when you add a builtin.
 */
export const TOOL_KEYWORDS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  read: ["read", "open file", "file contents", "inspect file", "cat "],
  write: ["write file", "create file", "save to", "write to disk", "generate a file"],
  edit: ["edit", "modify file", "patch", "replace in", "change the file"],
  glob: ["glob", "find files", "list files", "match files", "file pattern"],
  grep: ["grep", "search for", "search the", "find in files", "look for", "search code"],
  bash: ["bash", "shell", "run command", "execute command", "terminal", "run a script"],
  bashOutput: [
    "background command",
    "background job",
    "long-running command",
    "poll the output",
    "stream the output",
  ],
  killShell: [
    "kill the shell",
    "kill the command",
    "terminate the command",
    "stop the command",
    "cancel the command",
  ],
  todoWrite: ["todo", "task list", "track tasks", "checklist"],
  abiDecode: ["abi", "decode", "calldata", "eth_call result", "revert data"],
  abiEncodeCall: ["abi", "encode", "calldata", "contract call", "selector"],
  addressCheck: ["address", "eip-55", "checksum", "ethereum address", "0x"],
  defiMath: ["slippage", "minout", "price impact", "health factor", "basis points", "defi"],
  functionSelector: ["selector", "event topic", "keccak", "4byte", "signature"],
  typedDataHash: ["eip-712", "typed data", "eip-191", "personal_sign", "digest"],
  tokenUnits: ["wei", "gwei", "ether", "decimals", "base units", "parseunits"],
  costBasisCompute: ["cost basis", "fifo", "lifo", "capital gains", "lots", "realized gain"],
  glCodeSuggest: ["gl code", "general ledger", "chart of accounts", "coding", "cost center"],
  paymentIdentifierValidate: [
    "iban",
    "bic",
    "swift",
    "routing number",
    "sort code",
    "card number",
    "luhn",
  ],
  purchaseOrderMatch: [
    "three-way match",
    "purchase order",
    "accounts payable",
    "invoice match",
    "goods receipt",
  ],
  refundAbuseCheck: ["refund abuse", "return fraud", "chargeback", "refund ratio"],
  refundAmountCompute: ["refund", "return", "partial refund", "restocking", "proration"],
  spendLimitCheck: ["spend limit", "velocity", "budget guard", "payment cap", "quiet hours"],
  statementParse: [
    "bank statement",
    "ofx",
    "qfx",
    "transactions",
    "reconciliation",
    "csv statement",
  ],
  taxCalculate: ["vat", "gst", "sales tax", "tax", "reverse charge"],
  webhookSignatureVerify: ["webhook", "signature", "hmac", "stripe signature", "replay"],
  licenseAggregate: ["license", "licenses", "spdx", "compliance", "copyleft", "gpl"],
  lockfileDiff: [
    "lockfile",
    "lock diff",
    "dependency bump",
    "upgrade review",
    "package-lock",
    "bun.lock",
  ],
  packagePublishPreflight: ["publish", "preflight", "release check", "npm publish", "prepublish"],
  packageTarballInspect: ["tarball", "tgz", "npm pack", "artifact", "published files"],
  semverResolve: ["semver", "version range", "resolve version", "caret", "tilde"],
  branch: ["branch", "if", "switch", "route", "conditional", "control flow"],
  consensusVote: ["consensus", "vote", "agreement", "plurality", "quorum", "dissent"],
  deadlineCheck: ["deadline", "budget", "time left", "timeout", "sla", "clock"],
  decisionTable: ["decision table", "policy", "rules", "hit policy", "matrix"],
  errorClassify: ["error", "classify", "retry", "retryable", "backoff", "retry-after", "exit code"],
  ruleScore: ["score", "scoring", "lead score", "grade", "band", "qualify"],
  stallDetect: ["stall", "stuck", "loop", "oscillation", "progress", "no progress"],
  imageInfo: ["image dimensions", "how big is the image", "what size is it"],
  imageKind: ["what kind of file", "is it really a png", "identify the image"],
  pngRead: ["decode the png", "read the pixels"],
  pngWrite: ["write a png", "save the image"],
  imageResize: ["resize the image", "make it smaller", "thumbnail"],
  imageCrop: ["crop the image", "cut out a region"],
  imageDiff: ["did the screenshot change", "compare the images", "visual regression"],
  exifRead: ["photo metadata", "when was it taken", "does it have gps"],
  exifStrip: ["strip the metadata", "remove exif", "safe to publish the photo"],
  qrEncode: ["make a qr code", "qr"],
  barcodeEncode: ["barcode", "ean", "code128"],
  chartRender: ["draw a chart", "plot the data", "bar chart", "graph it"],
  sparklineRender: ["sparkline", "tiny chart", "inline trend"],
  diagramRender: ["draw a diagram", "boxes and arrows", "architecture picture"],
  colorConvert: ["hex to rgb", "convert the colour", "hsl"],
  colorContrast: ["is the contrast accessible", "wcag contrast", "readable colour"],
  subtitleParse: ["read the subtitles", "srt", "vtt captions"],
  subtitleWrite: ["write subtitles", "shift the captions", "make an srt"],
  mediaProbe: ["how long is the video", "media duration", "what codec", "ffprobe"],
  eventQuery: ["what happened", "search the events", "filter the log"],
  eventCounts: ["how many events", "tally by kind", "activity summary"],
  toolCallStats: ["which tool is failing", "tool usage", "how slow is the tool"],
  errorCluster: ["group the errors", "what keeps failing", "common errors"],
  runTimeline: ["where did the time go", "run timeline", "what happened in the run"],
  costReport: ["what did it cost", "token spend", "cost by model", "spend by day"],
  budgetCheck: ["how much budget left", "am i over budget", "spend remaining"],
  sloEvaluate: ["are we meeting the target", "error budget", "service level"],
  incidentBundle: ["package up the failure", "incident report", "hand this to a human"],
  metricsQuery: ["query prometheus", "metrics", "graph the series"],
  logsQuery: ["search the logs", "query the log platform"],
  alertList: ["what alerts are firing", "open alerts"],
  alertAck: ["acknowledge the alert", "ack the page"],
  statusPagePost: ["post a status update", "status page", "tell customers"],
  healthProbe: ["are the services up", "health check", "probe the endpoints"],
  chatPost: [
    "post to slack",
    "send a message to the channel",
    "notify the team",
    "discord",
    "teams",
  ],
  chatUpdate: ["edit the message", "update what i posted"],
  chatDelete: ["delete the message", "remove the post"],
  chatReact: ["react to the message", "add an emoji"],
  emailCompose: ["draft an email", "build the message", "compose without sending"],
  emailSend: ["send an email", "email them", "mail the report"],
  webhookPost: ["post to the webhook", "call the hook", "trigger the integration"],
  smsSend: ["send a text", "sms them"],
  pushNotify: ["push notification", "notify the phone"],
  deliveryCheck: ["was it delivered", "delivery status", "did the message arrive"],
  notifyDigest: ["one summary instead of many", "digest the alerts", "batch the notifications"],
  quietHours: ["is it too late to send", "quiet hours", "do not disturb", "out of hours"],
  rateLimitGate: ["have i already told them", "do not spam", "notification throttle"],
  messageTemplate: ["render the message", "message template", "standard wording"],
  evaluate: ["calculate", "work out", "compute the expression", "what is"],
  statistics: ["average", "mean median", "standard deviation", "summarize the numbers"],
  percentile: ["percentile", "p95", "median of"],
  correlation: ["correlated", "relationship between", "correlation"],
  linearRegression: ["trend", "regression", "line of best fit", "predict from"],
  histogram: ["distribution", "histogram", "bucket the values"],
  outliers: ["outliers", "anomalies", "unusual values"],
  moneyAdd: ["add the amounts", "total the money", "sum the invoice"],
  moneyMultiply: ["multiply the price", "quantity times price", "line total"],
  moneyAllocate: ["split the bill", "allocate the amount", "divide the payment", "apportion"],
  currencyConvert: ["convert currency", "in dollars", "exchange rate"],
  unitConvert: ["convert units", "in kilometres", "celsius to fahrenheit", "how many pounds"],
  round: ["round", "to two decimal places", "nearest"],
  numberFormat: ["format the number", "thousands separator", "display the amount"],
  numberParse: ["parse the number", "read the amount", "string to number"],
  percent: ["percentage", "percent change", "margin", "markup"],
  amortize: ["loan schedule", "repayments", "amortization", "monthly payment"],
  npv: ["net present value", "npv", "discounted cash flow"],
  irr: ["internal rate of return", "irr", "return on the investment"],
  geoDistance: ["how far between", "distance between coordinates", "kilometres apart"],
  geoBoundingBox: ["bounding box", "area around a point"],
  geoPointInPolygon: ["is it inside the area", "point in polygon", "within the region"],
  piiScan: ["is there personal data", "find pii", "scan for personal information"],
  piiRedact: ["redact", "remove personal data", "anonymize the text"],
  pseudonymize: ["pseudonymize", "de-identify", "replace with tokens"],
  depseudonymize: ["restore the real values", "reverse the tokens"],
  secretScan: ["any secrets", "leaked credentials", "scan for api keys", "did i commit a key"],
  entropyScore: ["entropy", "is this random", "does this look like a key"],
  promptInjectionScan: ["prompt injection", "is this content hostile", "instruction override"],
  invisibleCharScan: ["hidden characters", "zero width", "is something hidden in this text"],
  homoglyphNormalize: ["lookalike characters", "homoglyph", "confusable letters"],
  urlSafetyCheck: ["is this link safe", "suspicious url", "check the link"],
  allowlistCheck: ["is it allowed", "allow-list", "permitted domain"],
  contentPolicyCheck: [
    "policy check",
    "required disclaimer",
    "forbidden phrase",
    "compliance check",
  ],
  hashChainVerify: ["verify the chain", "was it tampered", "hash chain"],
  signPayload: ["sign the record", "prove it was not altered"],
  verifyPayload: ["verify the signature", "is this record genuine"],
  redactForExport: ["safe to send", "clean before sharing", "redact for export"],
  docxRead: ["read the word document", "docx", "what does the document say"],
  docxWrite: ["write a word document", "produce a docx", "generate a report document"],
  xlsxRead: ["read the spreadsheet", "xlsx", "excel data", "what is in the sheet"],
  xlsxWrite: ["write a spreadsheet", "export to excel", "produce an xlsx"],
  pptxRead: ["read the slides", "powerpoint", "deck contents"],
  pdfInfo: ["how many pages", "pdf metadata", "is the pdf a scan", "is it encrypted"],
  pdfText: ["read the pdf", "extract the text", "what does the pdf say"],
  pdfSplit: ["split the pdf", "extract pages", "just these pages"],
  pdfMerge: ["merge pdfs", "combine the documents", "join the pdfs"],
  emlParse: ["read the email", "parse the message", "eml", "email headers"],
  mboxSplit: ["mbox", "split the mailbox", "email archive"],
  icsParse: ["read the calendar", "ics", "what events", "calendar invite"],
  icsWrite: ["write a calendar", "create an invite", "produce an ics"],
  vcardParse: ["read the contacts", "vcard", "vcf"],
  documentText: ["read the document", "get the text", "what does this file say"],
  documentDiff: ["what changed in the document", "compare the documents", "document diff"],
  sqlQuery: ["query the database", "select from", "how many rows", "look it up in the db"],
  sqlExec: ["insert into", "update the row", "write to the database"],
  sqlTransaction: ["all or nothing", "transaction", "atomically"],
  sqlExplain: ["query plan", "why is it slow", "explain the query", "missing index"],
  schemaList: ["what tables", "list the schema", "database structure"],
  schemaDescribe: ["describe the table", "what columns", "table structure"],
  tableStats: ["how big is the table", "row counts", "table sizes"],
  integrityCheck: ["is the database ok", "integrity check", "corrupt database"],
  importCsv: ["load the csv", "import into the table", "csv to database"],
  importJson: ["load the json", "import records"],
  exportCsv: ["export to csv", "dump the query to csv"],
  exportJson: ["export to json", "dump the table"],
  databaseBackup: ["back up the database", "snapshot the db"],
  migrationStatus: ["which migrations ran", "pending migrations"],
  migrationApply: ["run the migrations", "apply migrations", "migrate the database"],
  prList: ["open pull requests", "list prs", "what prs"],
  prGet: ["this pr", "pr details", "is the pr mergeable"],
  prFiles: ["what files does the pr change", "pr diff"],
  prComments: ["pr comments", "review feedback", "what did reviewers say"],
  prReviews: ["pr reviews", "who approved", "review state"],
  issueList: ["open issues", "list issues", "bug reports"],
  issueGet: ["this issue", "issue details"],
  checkRuns: ["are the checks passing", "check runs", "ci status"],
  workflowRuns: ["ci runs", "workflow runs", "did the build pass"],
  workflowRunLogs: ["why did ci fail", "ci logs", "build logs"],
  releaseList: ["releases", "what versions shipped"],
  releaseGet: ["this release", "release notes", "release assets"],
  repoGet: ["repo info", "default branch", "is it public"],
  compareRefs: ["what is between these versions", "compare branches", "commits since"],
  searchCode: ["search the code on github", "find code in the org"],
  searchIssues: ["search issues", "has this been reported"],
  rateLimitStatus: ["api quota", "rate limit", "how many calls left"],
  prCreate: ["open a pr", "create a pull request", "raise a pr"],
  prUpdate: ["update the pr", "retitle the pr", "add a reviewer", "label the pr"],
  prComment: ["comment on the pr", "reply on the pr"],
  prReviewSubmit: ["approve the pr", "request changes", "submit a review"],
  issueCreate: ["file an issue", "open a bug", "create an issue"],
  issueUpdate: ["close the issue", "update the issue", "assign the issue"],
  issueComment: ["comment on the issue", "reply to the issue"],
  releaseCreate: ["cut a release", "publish a release"],
  workflowRunRerun: ["rerun ci", "retry the build", "rerun the failed jobs"],
  runTests: ["run the tests", "do the tests pass", "test suite", "is it green"],
  testFailureSummary: ["which tests failed", "summarize the failures", "test output"],
  runBuild: ["build it", "does it compile", "run the build"],
  typecheck: ["typecheck", "type errors", "tsc", "does it type"],
  lint: ["lint", "linter", "code style problems"],
  format: ["format the code", "run prettier", "fix formatting"],
  formatCheck: ["is it formatted", "format check", "formatting gate"],
  diagnostics: ["what is wrong with the code", "all the problems", "health of the code"],
  astQuery: ["find the function", "where is the class", "declarations", "find the symbol"],
  symbolOutline: ["what is in this file", "outline the file", "file structure"],
  findReferences: ["where is this used", "references to", "callers of", "usages"],
  importGraph: ["import graph", "what imports what", "circular imports", "module graph"],
  deadFileScan: ["unused files", "dead code", "nothing imports"],
  todoScan: ["todos", "fixme", "outstanding work in the code"],
  dependencyList: ["dependencies", "what packages", "requirements"],
  dependencyOutdated: ["outdated dependencies", "lockfile drift", "version mismatch"],
  packageScripts: ["what scripts", "how do i run", "npm scripts"],
  workspacePackages: ["monorepo packages", "workspace members"],
  coverageSummary: ["coverage", "how much is tested", "uncovered files"],
  stackTraceParse: ["parse the stack trace", "where did it throw", "which line failed"],
  specValidate: ["is the spec valid", "validate the spec", "check crewhaus.yaml"],
  specCompileCheck: ["will it compile", "check the build", "compile check"],
  specSummarize: ["what does this harness do", "summarize the spec", "harness shape"],
  specDiff: ["what changed in the spec", "compare specs", "did permissions widen"],
  toolInventory: ["what tools does it have", "tool list for the harness"],
  permissionAudit: ["what can this harness do", "permission audit", "ungated tools"],
  preflightRun: ["will it boot", "preflight", "missing credentials", "before deploying"],
  harnessInventory: ["what harnesses", "list the fleet", "find the harnesses"],
  bundleFreshness: ["is the bundle stale", "needs recompiling", "out of date build"],
  auditVerify: ["verify the audit log", "was it tampered", "hash chain"],
  evalBaselineCompare: ["did it regress", "compare eval runs", "release gate", "baseline"],
  sessionSummarize: ["what happened in the run", "session summary", "run report"],
  traceQuery: ["query the trace", "what tools were called", "find the error"],
  costSummarize: ["how much did it cost", "token spend", "cost by model"],
  kvSet: ["remember this", "store the value", "save state", "set a key"],
  kvGet: ["what did i store", "read the value", "get a key", "last run"],
  kvDelete: ["forget", "delete the key", "clear the value"],
  kvList: ["what keys", "list the state", "everything stored"],
  counterIncrement: ["count it", "increment", "how many times", "tally"],
  counterGet: ["read the counter", "how many so far", "current count"],
  checkpointSave: ["save progress", "checkpoint", "so it can resume"],
  checkpointLoad: ["resume", "restore progress", "where was i"],
  checkpointList: ["what checkpoints", "list the saves"],
  journalAppend: ["log this", "record what happened", "append to the journal"],
  journalRead: ["what happened", "read the journal", "history of actions"],
  blackboardPost: ["leave a note for", "share with the crew", "post to the board"],
  blackboardRead: ["what did the others find", "read the board", "crew notes"],
  noteWrite: ["write a note", "save what i learned", "keep this"],
  noteSearch: ["search my notes", "did i note", "find in notes"],
  indexBuild: ["index the files", "build a search index"],
  indexSearch: ["search the files", "which file mentions", "find the document"],
  stateExport: ["back up the state", "export everything"],
  stateImport: ["restore the state", "import the backup"],
  dedupeMark: ["already handled", "seen before", "idempotency", "do not repeat"],
  httpRequest: ["call the api", "http request", "post to", "hit the endpoint"],
  httpPaginate: ["all the pages", "paginate", "fetch every result", "next page"],
  graphqlQuery: ["graphql", "query the graph", "gql"],
  httpBatch: ["several requests", "batch the calls", "fan out requests"],
  downloadFile: ["download", "save the file from", "fetch the artifact"],
  headRequest: ["does the url exist", "how big is the download", "check the headers"],
  urlReachable: ["is it up", "is the site reachable", "ping the url"],
  linkCheck: ["broken links", "check the links", "dead urls"],
  httpWaitFor: ["wait for the deploy", "poll until healthy", "wait for the endpoint"],
  sseRead: ["server sent events", "event stream", "sse"],
  webhookSign: ["sign the webhook", "webhook signature"],
  webhookVerify: ["verify the webhook", "is this webhook genuine", "check the signature"],
  dnsLookup: ["dns", "what does this resolve to", "mx records", "txt record"],
  tlsInspect: ["certificate", "when does the cert expire", "tls", "ssl"],
  robotsCheck: ["robots.txt", "am i allowed to crawl", "crawl policy"],
  sitemapParse: ["sitemap", "site urls"],
  feedParse: ["rss", "atom feed", "parse the feed", "subscribe"],
  base64Encode: ["base64", "encode as base64", "to base64"],
  base64Decode: ["decode base64", "from base64"],
  runCommand: ["run a command", "execute", "run the build", "invoke the binary"],
  runPipeline: ["run these in order", "chain commands", "sequence of commands"],
  retry: ["retry", "try again", "flaky command", "backoff"],
  processStart: ["start a server", "run in the background", "background process"],
  processStatus: ["is it still running", "process status", "did it exit"],
  processOutput: ["read the output", "what has it printed", "process logs"],
  processStop: ["stop the process", "kill the server", "shut it down"],
  processList: ["what is running", "list background processes"],
  waitForPort: ["wait for the server", "is the port open", "wait until listening"],
  waitForFile: ["wait for the file", "wait until it exists", "wait for the build output"],
  waitForOutput: ["wait for the log line", "wait until ready", "watch the output"],
  commandExists: ["is it installed", "is the binary available", "which"],
  envInspect: ["environment variable", "is the env set", "check the config"],
  stat: ["file info", "how big is the file", "when was it modified", "does it exist"],
  fileHash: ["hash the file", "checksum the file", "has the file changed"],
  tree: ["directory tree", "what is in this folder", "project layout", "list the directory"],
  diskUsage: ["disk usage", "what is taking space", "largest directories"],
  findFiles: ["find files", "locate files", "files modified since", "files larger than"],
  readLines: ["read a line range", "lines from the file", "page through"],
  tailFile: ["tail the file", "last lines", "end of the log"],
  makeDirectory: ["make a directory", "create a folder", "mkdir"],
  touchFile: ["touch", "create an empty file"],
  tempDir: ["temp directory", "scratch space", "working directory"],
  copyPath: ["copy the file", "duplicate", "cp"],
  movePath: ["move the file", "rename the file", "mv"],
  removePath: ["delete the file", "remove the directory", "clean up"],
  splitFile: ["split the file", "chunk the file"],
  concatFiles: ["concatenate", "join the files", "combine files"],
  archiveList: ["what is in the archive", "list the zip", "tar contents"],
  archiveCreate: ["make an archive", "zip it up", "create a tarball"],
  archiveExtract: ["extract the archive", "unzip", "untar"],
  frontmatterRead: ["read the frontmatter", "post metadata", "yaml header"],
  frontmatterWrite: ["update the frontmatter", "set the metadata"],
  notebookRead: ["read the notebook", "jupyter cells", "ipynb"],
  notebookEdit: ["edit the notebook", "change a cell"],
  gitStatus: ["git status", "what changed", "working tree", "uncommitted"],
  gitDiff: ["git diff", "show the changes", "what did i change", "review the diff"],
  gitLog: ["git log", "commit history", "recent commits", "who changed"],
  gitShow: ["show the commit", "file at a revision", "contents at a ref"],
  gitBlame: ["git blame", "who wrote this line", "last touched"],
  gitBranchList: ["list branches", "what branches", "branch list"],
  gitTagList: ["list tags", "releases", "what tags"],
  gitRemoteList: ["remotes", "origin url", "where does this push"],
  gitMergeBase: ["merge base", "fork point", "common ancestor", "branched from"],
  gitRevParse: ["resolve the ref", "what sha is", "repo root"],
  gitFileHistory: ["history of this file", "when did this file change", "follow renames"],
  gitStashList: ["list stashes", "what is stashed"],
  gitConflicts: ["merge conflicts", "conflicted files", "resolve conflicts"],
  gitWorktreeList: ["list worktrees", "linked checkouts"],
  gitAdd: ["git add", "stage the changes", "stage files"],
  gitCommit: ["git commit", "commit the changes", "make a commit"],
  gitSwitch: ["switch branch", "checkout a branch", "change branch"],
  gitBranchCreate: ["create a branch", "new branch"],
  gitBranchDelete: ["delete a branch", "remove the branch"],
  gitStashPush: ["stash the changes", "set work aside"],
  gitStashPop: ["pop the stash", "restore stashed work"],
  gitTagCreate: ["tag the release", "create a tag"],
  gitApplyPatch: ["apply a patch", "apply the diff"],
  gitCherryPick: ["cherry pick", "bring that commit over"],
  gitResetPaths: ["unstage", "reset the file", "undo staging"],
  gitWorktreeAdd: ["add a worktree", "second checkout"],
  gitWorktreeRemove: ["remove a worktree"],
  jsonSchemaValidate: ["validate against the schema", "json schema", "is it valid"],
  jsonSchemaInfer: ["infer a schema", "derive the schema", "schema from examples"],
  validateRecords: ["validate the rows", "data quality", "check every record"],
  assert: ["assert", "check that", "verify the result", "gate on"],
  compareGolden: ["golden file", "snapshot", "expected output", "regression check"],
  deepEqual: ["are these equal", "deep equal", "same value"],
  matchSubset: ["contains the fields", "partial match", "subset"],
  checkRequiredFields: ["required fields", "missing fields", "completeness"],
  validateEnum: ["allowed values", "one of", "valid option"],
  validateFormat: ["is it an email", "valid url", "check the format"],
  validateUniqueKeys: ["duplicate keys", "unique constraint", "duplicates"],
  validateReferences: ["referential integrity", "dangling reference", "foreign key"],
  schemaDiff: ["schema changed", "breaking change", "compare schemas"],
  dbSchemaDiff: ["database schema changed", "compare databases", "migration needed"],
  schemaSummarize: ["summarize the schema", "what does the schema require"],
  dateParse: ["parse the date", "read the timestamp", "what date is"],
  dateFormat: ["format the date", "render the timestamp", "display the date"],
  dateConvertTimezone: ["timezone", "convert to utc", "local time"],
  dateAdd: ["add days", "subtract days", "date arithmetic", "days from now"],
  dateDiff: ["how long between", "days between", "date difference", "age"],
  durationParse: ["parse the duration", "how long is", "iso duration"],
  durationFormat: ["format the duration", "human readable time", "elapsed"],
  businessDays: ["business days", "working days", "sla deadline", "weekdays"],
  dateRange: ["date range", "every day between", "list the dates"],
  cronNext: ["next run", "cron schedule", "when does it fire"],
  cronDescribe: ["explain the cron", "what does this schedule mean"],
  recurrenceExpand: ["recurring", "rrule", "repeat every", "expand the series"],
  weekOfYear: ["week number", "iso week"],
  dayOfYear: ["day of the year", "ordinal date"],
  isLeapYear: ["leap year"],
  quarterOf: ["which quarter", "fiscal quarter"],
  timestampConvert: ["unix timestamp", "epoch", "millis to date"],
  hash: ["hash", "sha256", "checksum of the text", "digest"],
  hmac: ["hmac", "sign the payload", "verify the signature"],
  checksum: ["crc32", "adler", "checksum"],
  hexEncode: ["to hex", "hex encode"],
  hexDecode: ["from hex", "hex decode"],
  urlEncode: ["url encode", "percent encode", "escape for a url"],
  urlDecode: ["url decode", "percent decode"],
  urlParse: ["parse the url", "query parameters", "split the url"],
  urlBuild: ["build a url", "add query parameters"],
  urlNormalize: ["normalize the url", "canonical url", "compare urls"],
  uuid: ["uuid", "generate an id", "guid"],
  ulid: ["ulid", "sortable id"],
  nanoId: ["nanoid", "short id"],
  slugify: ["slug", "url safe name", "slugify"],
  jwtDecode: ["decode the jwt", "read the token", "token claims"],
  jwtVerify: ["verify the jwt", "check the token signature"],
  jsonQuery: ["query the json", "jsonpath", "pull a field", "select from json"],
  jsonPatch: ["json patch", "apply a patch", "rfc 6902"],
  jsonMergePatch: ["merge patch", "rfc 7386", "merge json"],
  jsonFormat: ["format json", "pretty print json", "minify json"],
  dataDiff: ["diff the json", "what changed", "compare two documents"],
  dataConvert: ["convert to yaml", "json to csv", "toml", "change format"],
  csvParse: ["parse the csv", "read a csv", "csv to json"],
  csvWrite: ["write a csv", "export to csv", "json to csv"],
  tableQuery: ["filter the records", "select rows", "query the table"],
  tableAggregate: ["group by", "sum the", "count by", "aggregate"],
  tableJoin: ["join two lists", "match records", "left join"],
  recordsToColumns: ["to columns", "column oriented"],
  columnsToRecords: ["to records", "row oriented"],
  flattenObject: ["flatten", "dotted keys"],
  unflattenObject: ["unflatten", "rebuild nesting"],
  jsonlParse: ["jsonl", "line delimited json", "ndjson"],
  jsonlWrite: ["write jsonl", "ndjson output"],
  xmlParse: ["parse the xml", "xml to json", "read html fragment"],
  sortRecords: ["sort the records", "order the rows"],
  dedupeRecords: ["dedupe", "remove duplicates", "unique records"],
  sampleRecords: ["sample the data", "first n rows", "head of the data"],
  dataShape: ["what shape is", "describe the data", "fields present"],
  jsonSortKeys: ["sort the keys", "stable json", "canonical json"],
  compactLog: ["compact the log", "summarize the log", "log noise", "ci log", "dedupe lines"],
  countTokens: ["count tokens", "how big is", "token count", "size of the text", "fits in context"],
  escapeString: ["escape", "quote safely", "sanitize for", "inject safely", "shell-quote"],
  extractEntities: [
    "extract urls",
    "find emails",
    "pull out ids",
    "extract entities",
    "harvest links",
  ],
  extractKeywords: ["keywords", "key terms", "tag the document", "top terms"],
  fuzzyMatch: ["fuzzy match", "closest match", "did you mean", "reconcile names", "nearest name"],
  glossaryReplace: ["glossary", "terminology", "rename terms", "house style", "replace terms"],
  markdownOutline: ["outline", "table of contents", "headings", "one section", "navigate the doc"],
  markdownTable: ["markdown table", "render a table", "format as a table", "report table"],
  normalizeText: [
    "normalize",
    "canonicalize",
    "line endings",
    "strip whitespace",
    "clean the text",
  ],
  regexExtract: [
    "regex",
    "extract with a pattern",
    "capture groups",
    "pattern match",
    "pull matches",
  ],
  renderTemplate: ["template", "fill in the placeholders", "render the message", "mail merge"],
  ruleClassify: ["classify by rules", "label the ticket", "route the message", "rule-based label"],
  sortLines: ["sort lines", "uniq", "dedupe the list", "sort the file"],
  textDiff: ["diff", "compare two", "what changed", "unified diff"],
  textSimilarity: ["similarity", "how similar", "near duplicate", "compare strings"],
  truncateToBudget: ["truncate", "fit the budget", "shorten to", "trim to size"],
  wrapText: ["wrap text", "72 columns", "quote the reply", "hard wrap"],
  webFetch: ["fetch url", "fetch a url", "webpage", "web page", "http get", "download page"],
  webSearch: ["web search", "search the web", "search online", "look up online", "google"],
  readImage: ["image", "screenshot", "read an image", "vision", "picture"],
  fetch: ["fetch", "api call", "rest api", "http request", "call an endpoint"],
  python: ["python", "run python", "data analysis", "numpy", "pandas"],
  javascript: ["javascript", "run javascript", "node script", "eval js"],
  shell: ["shell command", "sh -c", "posix shell"],
  imageGenerate: ["generate image", "create image", "dall-e", "image generation", "draw"],
  ingestDocument: ["ingest", "parse document", "read document", "pdf", "docx", "extract text"],
  codegraphSearch: ["codegraph", "code search", "symbol search", "find symbol"],
  codegraphCallers: ["callers of", "who calls", "find callers"],
  codegraphCallees: ["callees", "what does it call", "find callees"],
  codegraphImpact: ["impact analysis", "blast radius", "affected by"],
});

/**
 * Tools that only make sense beside a parent tool. Granting `bashOutput`
 * without `bash` is the anomaly; granting it WITH `bash` is the normal trio,
 * so flagging it as an over-grant just because the prose never said
 * "background command" is noise.
 */
export const TOOL_COMPANIONS: Readonly<Record<string, string>> = Object.freeze({
  bashOutput: "bash",
  killShell: "bash",
});

/**
 * Phrases that make the clause they appear in a REFUSAL rather than a
 * capability. "…say so if the user asks for image generation" must not read as
 * "this agent needs imageGenerate" — that false positive is worse than a
 * missed suggestion, because it is the first line of the report and the user
 * would act on it by granting a tool the instructions forbid.
 *
 * Scoping is per clause, so a keyword sharing a clause with a cue ("never
 * guess a path — read the file") is dropped too. That direction of error is
 * the cheap one: `tools suggest` under-reports instead of recommending a tool
 * the prose forbids, and any other clause asking for the tool still counts.
 */
const NEGATION_CUES: ReadonlyArray<string> = Object.freeze([
  "do not",
  "does not",
  "don't",
  "don’t",
  "doesn't",
  "doesn’t",
  "never",
  "refuse",
  "refusal",
  "decline",
  "avoid",
  "must not",
  "cannot",
  "can't",
  "can’t",
  "won't",
  "won’t",
  "should not",
  "shouldn't",
  "shouldn’t",
  "no need to",
  "without",
  "unrelated",
  "not allowed",
  "not permitted",
  "out of scope",
  "off-limits",
]);

/**
 * Word-boundary matcher for one keyword, with the common English inflections
 * so "reads"/"reading" still count. A plain `includes()` matched "read" inside
 * "already"/"spreadsheet" and "edit" inside "credit", which put tools in the
 * report that the instructions never mentioned.
 */
function keywordRegex(keyword: string): RegExp {
  const kw = keyword.trim();
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^[\w]/.test(kw) ? "\\b" : "";
  const right = /[\w]$/.test(kw) ? "(?:s|es|ed|ing)?\\b" : "";
  return new RegExp(`${left}${escaped}${right}`);
}

/**
 * Naming a tool outright is the strongest possible implication, so a
 * camelCase builtin identifier counts as its own keyword — instructions that
 * say "record the plan with `todoWrite`" or "run `codegraphImpact`" imply
 * those tools even when no prose keyword fires. Restricted to multi-word
 * identifiers: bare `write`/`fetch`/`shell` are ordinary English and would
 * re-introduce the false positives the curated lists avoid.
 */
function identityKeywords(key: string, runtimeName: string | undefined): string[] {
  if (!/[a-z][A-Z]/.test(key)) return [];
  // Reported verbatim (matching is case-insensitive) so the evidence line
  // reads "matched: codegraphImpact", the spelling the user wrote.
  const ids = [key];
  if (runtimeName !== undefined && runtimeName.toLowerCase() !== key.toLowerCase()) {
    ids.push(runtimeName);
  }
  return ids;
}

const KEYWORD_REGEX_CACHE = new Map<string, RegExp>();
/** Case-insensitive: clauses arrive lowercased, so lowercase the needle too. */
function matchesKeyword(clause: string, keyword: string): boolean {
  let re = KEYWORD_REGEX_CACHE.get(keyword);
  if (re === undefined) {
    re = keywordRegex(keyword.toLowerCase());
    KEYWORD_REGEX_CACHE.set(keyword, re);
  }
  return re.test(clause);
}

/**
 * Split instructions into clauses so a negation cue is scoped to the text it
 * negates. Instructions are usually YAML block scalars — hard-wrapped prose
 * mixed with bullet lists — so splitting on raw newlines would tear
 * "…something unrelated to the codebase (open-domain chat, image generation…"
 * in half and strand the cue in a different clause from the keyword. Unwrap
 * continuation lines first (blank lines, headings and list markers start a new
 * item), then cut on sentence ends. Exported for tests.
 */
export function splitInstructionClauses(text: string): string[] {
  const items: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      items.push(""); // hard break — the next line starts a new item
      continue;
    }
    const startsItem = /^([-*•]|\d+[.)]|#{1,6}\s)/.test(line);
    const prev = items.length > 0 ? items[items.length - 1] : undefined;
    if (startsItem || prev === undefined || prev === "") items.push(line);
    else items[items.length - 1] = `${prev} ${line}`;
  }
  const clauses: string[] = [];
  for (const item of items) {
    for (const part of item.split(/(?<=[.!?;])\s+/)) {
      const clause = part.trim();
      if (clause !== "") clauses.push(clause);
    }
  }
  return clauses;
}

function isNegated(clause: string): boolean {
  return NEGATION_CUES.some((cue) => clause.includes(cue));
}

export type ToolSuggestion = {
  readonly key: string;
  readonly name: string;
  /** The instruction keywords that implied this tool. */
  readonly matchedKeywords: ReadonlyArray<string>;
  /** True when the spec already lists this tool (already-satisfied). */
  readonly alreadyPresent: boolean;
};

export type ToolSuggestResult = {
  /** Implied-but-missing tools, ranked by keyword-hit count then key. */
  readonly missing: ReadonlyArray<ToolSuggestion>;
  /** Implied tools already in the spec (reported for confidence). */
  readonly present: ReadonlyArray<ToolSuggestion>;
  /** Tools in the spec that no keyword implied (candidate over-grants). */
  readonly unimplied: ReadonlyArray<string>;
  /**
   * Tools whose ONLY keyword hits sat in a refusal/negation clause. Reported
   * as evidence (an instruction that forbids a capability is a reason to drop
   * the tool, never to add it) but never suggested.
   */
  readonly negated: ReadonlyArray<ToolSuggestion>;
};

/**
 * Rank builtins against an agent's instructions. `specTools` is the spec's
 * current `tools:` list (camelCase keys, possibly empty); `toolKeys` is the
 * set of resolvable builtin keys (so a suggestion never names a tool the
 * runtime can't load). Pure and deterministic.
 *
 * Matching is literal and clause-scoped: word-boundary keyword hits, with hits
 * inside a refusal clause routed to `negated` instead of `missing`.
 */
export function suggestTools(
  instructions: string,
  specTools: ReadonlyArray<string>,
  toolKeys: ReadonlyArray<string>,
  toolMap: Readonly<Record<string, RegisteredTool>>,
): ToolSuggestResult {
  const clauses = splitInstructionClauses(instructions.toLowerCase());
  const affirmative = clauses.filter((c) => !isNegated(c));
  const refusing = clauses.filter((c) => isNegated(c));
  const present = new Set(specTools);
  const known = new Set(toolKeys);
  const missing: ToolSuggestion[] = [];
  const alreadyPresent: ToolSuggestion[] = [];
  const negated: ToolSuggestion[] = [];

  for (const [key, curated] of Object.entries(TOOL_KEYWORDS)) {
    if (!known.has(key)) continue; // never suggest an unresolvable tool
    const keywords = [...curated, ...identityKeywords(key, toolMap[key]?.name)];
    const matched = keywords.filter((kw) => affirmative.some((c) => matchesKeyword(c, kw)));
    const build = (kws: ReadonlyArray<string>): ToolSuggestion => ({
      key,
      name: toolMap[key]?.name ?? key,
      matchedKeywords: kws,
      alreadyPresent: present.has(key),
    });
    if (matched.length > 0) {
      const suggestion = build(matched);
      (suggestion.alreadyPresent ? alreadyPresent : missing).push(suggestion);
      continue;
    }
    const refused = keywords.filter((kw) => refusing.some((c) => matchesKeyword(c, kw)));
    if (refused.length > 0) negated.push(build(refused));
  }

  const rank = (a: ToolSuggestion, b: ToolSuggestion): number => {
    const diff = b.matchedKeywords.length - a.matchedKeywords.length;
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  };
  missing.sort(rank);
  alreadyPresent.sort(rank);
  negated.sort(rank);

  // Spec tools no keyword implied — possible over-grants worth reviewing. A
  // companion of a granted parent (bashOutput beside bash) is expected, not an
  // over-grant; a tool whose only mention was a refusal stays flagged, because
  // "refuse image generation" IS the argument for dropping imageGenerate.
  const impliedKeys = new Set([...missing, ...alreadyPresent].map((s) => s.key));
  const unimplied = specTools
    .filter((t) => !impliedKeys.has(t))
    .filter((t) => {
      const parent = TOOL_COMPANIONS[t];
      return parent === undefined || !present.has(parent);
    })
    .sort();

  return { missing, present: alreadyPresent, unimplied, negated };
}

export function formatSuggestLines(result: ToolSuggestResult): string[] {
  const lines: string[] = [];
  if (result.missing.length === 0) {
    lines.push("no additional builtins implied by the instructions");
  } else {
    lines.push("implied but not in tools:");
    for (const s of result.missing) {
      lines.push(`  + ${s.key} (${s.name}) — matched: ${s.matchedKeywords.join(", ")}`);
    }
  }
  if (result.present.length > 0) {
    lines.push("implied and already present:");
    for (const s of result.present) {
      lines.push(`  · ${s.key} — matched: ${s.matchedKeywords.join(", ")}`);
    }
  }
  if (result.negated.length > 0) {
    lines.push("mentioned only in a refusal (NOT suggested):");
    for (const s of result.negated) {
      lines.push(
        `  − ${s.key} (${s.name}) — matched: ${s.matchedKeywords.join(", ")}${s.alreadyPresent ? " — granted in tools: though the instructions refuse it" : ""}`,
      );
    }
  }
  if (result.unimplied.length > 0) {
    lines.push(
      `in tools: but not implied by instructions (review — possible over-grant): ${result.unimplied.join(", ")}`,
    );
  }
  lines.push(
    "heuristic: literal keyword match over agent.instructions, not a model — wording it doesn't recognize won't be suggested; `crewhaus tools list` shows every builtin",
  );
  return lines;
}

// -------- tools audit --------

/** Per-tool aggregate over a session set's `tool_stats` lines, keyed by the
 *  PascalCase runtime `.name`. */
export type ToolUsageStats = {
  calls: number;
  errors: number;
  totalDurationMs: number;
};

/**
 * Fold session events into per-tool usage stats. Reads `tool_stats` lines
 * (the durable per-call mirror); tolerant of old-vintage logs (no such
 * lines → empty map). Keyed by `toolName` exactly as recorded (PascalCase).
 */
export function buildToolUsage(
  sessions: ReadonlyArray<SessionEvents>,
): ReadonlyMap<string, ToolUsageStats> {
  const usage = new Map<string, ToolUsageStats>();
  for (const session of sessions) {
    for (const obj of session.objects) {
      const stats = payloadOf(obj, "tool_stats");
      if (stats === undefined || typeof stats["toolName"] !== "string") continue;
      const s = usage.get(stats["toolName"]) ?? { calls: 0, errors: 0, totalDurationMs: 0 };
      s.calls += 1;
      if (stats["isError"] === true) s.errors += 1;
      if (typeof stats["durationMs"] === "number") s.totalDurationMs += stats["durationMs"];
      usage.set(stats["toolName"], s);
    }
  }
  return usage;
}

export type AuditThresholds = {
  /** Tools with ≥ this many calls whose error rate crosses `failRate` are flagged. */
  readonly failMinCalls: number;
  readonly failRate: number;
  /** Clean (error-free) calls at/above which a non-readOnly tool is a
   *  learned-readOnly candidate. */
  readonly readOnlyMinCleanCalls: number;
};

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = Object.freeze({
  failMinCalls: 5,
  failRate: 0.5,
  readOnlyMinCleanCalls: 10,
});

export type ToolAuditFinding =
  /** A tool granted in the spec but never called across the mined sessions. */
  | { readonly kind: "unused"; readonly key: string; readonly name: string }
  /** A granted tool whose error rate crosses the threshold. */
  | {
      readonly kind: "failing";
      readonly key: string;
      readonly name: string;
      readonly calls: number;
      readonly errors: number;
      readonly rate: number;
    }
  /** A non-readOnly tool with many clean calls — candidate readOnly reclassify. */
  | {
      readonly kind: "learned-read-only";
      readonly key: string;
      readonly name: string;
      readonly calls: number;
    };

export type ToolAuditResult = {
  readonly sessionIds: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<ToolAuditFinding>;
};

/**
 * Audit a spec's granted tools against observed usage. Pure.
 *
 *   - `specTools`: the spec's `tools:` list (camelCase keys). When the spec
 *     grants NO explicit list (empty), the "unused" check is skipped — an
 *     agent with the default toolset shouldn't be told to remove tools it
 *     never declared.
 *   - `usage`: `buildToolUsage` output (PascalCase-keyed).
 *   - `toolMap`: resolves a spec key → RegisteredTool (for `.name` +
 *     `readOnly`), bridging the two casings.
 *
 * Findings are advice-only (`tools:` is not optimizer-whitelisted).
 */
export function auditTools(opts: {
  readonly sessions: ReadonlyArray<SessionEvents>;
  readonly specTools: ReadonlyArray<string>;
  readonly usage: ReadonlyMap<string, ToolUsageStats>;
  readonly toolMap: Readonly<Record<string, RegisteredTool>>;
  readonly hasExplicitToolList: boolean;
  readonly thresholds?: Partial<AuditThresholds>;
}): ToolAuditResult {
  const t: AuditThresholds = { ...DEFAULT_AUDIT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const findings: ToolAuditFinding[] = [];

  // Index usage by the RegisteredTool `.name` (already the usage key) and
  // build a spec-key → name resolver.
  const nameFor = (key: string): string => opts.toolMap[key]?.name ?? key;

  // (a) unused grants — only when the spec declared an explicit list.
  if (opts.hasExplicitToolList) {
    for (const key of opts.specTools) {
      const name = nameFor(key);
      const stats = opts.usage.get(name);
      if (stats === undefined || stats.calls === 0) {
        findings.push({ kind: "unused", key, name });
      }
    }
  }

  // (b) chronically failing tools — over ALL observed tools, mapped back to a
  //     spec key when we can (falls back to the runtime name otherwise).
  const nameToKey = new Map<string, string>();
  for (const [key, tool] of Object.entries(opts.toolMap)) nameToKey.set(tool.name, key);
  for (const [name, stats] of opts.usage) {
    if (stats.calls < t.failMinCalls) continue;
    const rate = stats.errors / stats.calls;
    if (rate < t.failRate) continue;
    findings.push({
      kind: "failing",
      key: nameToKey.get(name) ?? name,
      name,
      calls: stats.calls,
      errors: stats.errors,
      rate,
    });
  }

  // (c) learned read-only candidates — a tool NOT declared readOnly that has
  //     many error-free calls. Signals it may be safe to reclassify (which
  //     would let the permission engine auto-allow it in auto mode).
  for (const [name, stats] of opts.usage) {
    if (stats.errors > 0) continue;
    if (stats.calls < t.readOnlyMinCleanCalls) continue;
    const key = nameToKey.get(name);
    if (key === undefined) continue; // an unmapped runtime name — can't propose a spec-key edit
    const tool = opts.toolMap[key];
    if (tool === undefined || tool.readOnly) continue; // already read-only → nothing to learn
    findings.push({ kind: "learned-read-only", key, name, calls: stats.calls });
  }

  // Deterministic order: unused, then failing (worst rate first), then
  // learned-read-only, each alphabetized within its group.
  const groupRank = (f: ToolAuditFinding): number =>
    f.kind === "unused" ? 0 : f.kind === "failing" ? 1 : 2;
  findings.sort((a, b) => {
    const g = groupRank(a) - groupRank(b);
    if (g !== 0) return g;
    if (a.kind === "failing" && b.kind === "failing") {
      const d = b.rate - a.rate;
      if (d !== 0) return d;
    }
    return a.key.localeCompare(b.key);
  });

  return { sessionIds: opts.sessions.map((s) => s.sessionId), findings };
}

export function formatAuditLines(result: ToolAuditResult): string[] {
  const lines: string[] = [];
  if (result.findings.length === 0) {
    lines.push("no tool-usage findings — grants look well-matched to observed calls");
    return lines;
  }
  for (const f of result.findings) {
    switch (f.kind) {
      case "unused":
        lines.push(
          `[remove?] ${f.key} (${f.name}) — granted but never called in the mined sessions; drop it from tools: unless it's for a path these sessions didn't exercise`,
        );
        break;
      case "failing":
        lines.push(
          `[failing] ${f.key} (${f.name}) — ${f.errors}/${f.calls} calls errored (${(f.rate * 100).toFixed(0)}%); investigate inputs/backend or swap the tool`,
        );
        break;
      case "learned-read-only":
        lines.push(
          `[read-only?] ${f.key} (${f.name}) — ${f.calls} clean calls, 0 errors; if it never mutates, mark it readOnly so auto mode can auto-allow it`,
        );
        break;
    }
  }
  return lines;
}

// -------- map-sync guard --------

/**
 * The canonical set of built-in tool KEYS the CLI runtime can resolve at
 * `crewhaus run` time — the exact key set of `loadToolMap()` in
 * `apps/cli/src/index.ts`. It MUST equal `BUILTIN_TOOL_MAP`'s keys in
 * `packages/target-cli/src/index.ts`: that map decides which `tools:` names
 * COMPILE, this one decides which RUN, and a name in one but not the other is
 * a latent break (compiles then crashes, or runs a name the emitter rejects).
 * The sync test in `tools-cli.test.ts` asserts the two are equal; `loadToolMap`
 * is built to cover exactly these keys.
 */
export const CLI_RUNTIME_TOOL_KEYS: ReadonlyArray<string> = Object.freeze([
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "bashOutput",
  "killShell",
  "todoWrite",
  "webFetch",
  "webSearch",
  "readImage",
  "fetch",
  "python",
  "javascript",
  "shell",
  "imageGenerate",
  "ingestDocument",
  "codegraphSearch",
  "codegraphCallers",
  "codegraphCallees",
  "codegraphImpact",
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
  "base64Encode",
  "base64Decode",
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
  "sqlQuery",
  "sqlExec",
  "sqlTransaction",
  "sqlExplain",
  "dbSchemaDiff",
  "schemaList",
  "schemaDescribe",
  "tableStats",
  "integrityCheck",
  "importCsv",
  "importJson",
  "exportCsv",
  "exportJson",
  "databaseBackup",
  "migrationStatus",
  "migrationApply",
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
  "branch",
  "consensusVote",
  "deadlineCheck",
  "decisionTable",
  "errorClassify",
  "ruleScore",
  "stallDetect",
  "licenseAggregate",
  "lockfileDiff",
  "packagePublishPreflight",
  "packageTarballInspect",
  "semverResolve",
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
  "abiDecode",
  "abiEncodeCall",
  "addressCheck",
  "defiMath",
  "functionSelector",
  "typedDataHash",
  "tokenUnits",
]);

/**
 * Compare two tool-name key sets. Returns the symmetric difference so the
 * sync test can report exactly which names drifted. Empty arrays ⇒ in sync.
 */
export function diffToolMapKeys(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): { readonly onlyInA: ReadonlyArray<string>; readonly onlyInB: ReadonlyArray<string> } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: [...setA].filter((k) => !setB.has(k)).sort(),
    onlyInB: [...setB].filter((k) => !setA.has(k)).sort(),
  };
}

// -------- tools categories / show / search (navigation) --------

/**
 * Navigation over the builtin catalogue. `tools list` answers "what exists";
 * these answer the three questions that follow it — how is it grouped, what
 * exactly does this one do, and which one do I want.
 *
 * All pure: the caller supplies the resolved tool map, so every function here
 * is unit-testable without touching the filesystem or importing a tool.
 */

/** One row of `tools categories`. */
export type CategoryRow = {
  readonly name: string;
  /** The selector an operator writes in a spec: `all-<name>`. */
  readonly selector: string;
  readonly title: string;
  /** Leaf categories own tools; roll-ups own other categories. */
  readonly kind: "leaf" | "roll-up";
  /** Tool keys, resolved transitively for a roll-up. */
  readonly tools: ReadonlyArray<string>;
  /** For a roll-up, the categories it rolls up. */
  readonly includes?: ReadonlyArray<string>;
};

/**
 * Build the category table. `resolve` is `toolsInCategory` from
 * `@crewhaus/tool-categories`, injected so this module stays dependency-free
 * and the test can drive a fixture registry.
 */
export function buildCategoryRows(
  categories: Readonly<
    Record<
      string,
      { title: string; tools?: ReadonlyArray<string>; includes?: ReadonlyArray<string> }
    >
  >,
  resolve: (name: string) => ReadonlyArray<string>,
): CategoryRow[] {
  return Object.entries(categories)
    .map(([name, def]) => ({
      name,
      selector: `all-${name}`,
      title: def.title,
      kind: (def.tools !== undefined ? "leaf" : "roll-up") as "leaf" | "roll-up",
      tools: resolve(name),
      ...(def.includes !== undefined ? { includes: [...def.includes] } : {}),
    }))
    .sort((a, b) => {
      // Leaves first, then roll-ups: an operator scanning for "what can I
      // turn on" wants the concrete groups before the bundles of groups.
      if (a.kind !== b.kind) return a.kind === "leaf" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Render the category table for the terminal. */
export function formatCategoryLines(rows: ReadonlyArray<CategoryRow>): string[] {
  const lines: string[] = [];
  const leaves = rows.filter((r) => r.kind === "leaf");
  const rollUps = rows.filter((r) => r.kind === "roll-up");
  if (leaves.length > 0) {
    lines.push("categories:");
    for (const r of leaves) {
      lines.push(`  ${r.selector}  (${r.tools.length})  ${r.title}`);
      lines.push(`    ${r.tools.join(", ")}`);
    }
  }
  if (rollUps.length > 0) {
    lines.push("");
    lines.push("roll-ups:");
    for (const r of rollUps) {
      lines.push(`  ${r.selector}  (${r.tools.length})  ${r.title}`);
      lines.push(`    = ${(r.includes ?? []).map((c) => `all-${c}`).join(" + ")}`);
    }
  }
  lines.push("");
  lines.push("use in a spec:  tools: [all-fs, -write]   # a category, minus one tool");
  return lines;
}

/** Full detail for one tool — the `tools show` payload. */
export type ToolDetail = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly categories: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly concurrencySafe: boolean;
  /** Top-level input field names, derived from the tool's own JSON Schema. */
  readonly inputFields: ReadonlyArray<string>;
};

/**
 * Project one tool into its detail record. `key` is the camelCase spec key;
 * `categoriesFor` is `categoriesForTool`, injected for the same reason as
 * above. Returns undefined when the key names no builtin, so the caller can
 * offer suggestions rather than printing an empty record.
 */
export function buildToolDetail(
  key: string,
  toolMap: Readonly<Record<string, ToolLike>>,
  categoriesFor: (key: string) => ReadonlyArray<string>,
): ToolDetail | undefined {
  const tool = toolMap[key];
  if (tool === undefined) return undefined;
  return {
    key,
    name: tool.name,
    description: tool.description,
    categories: categoriesFor(key),
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    scope: tool.scope,
    ...(tool.ioCapability !== undefined ? { ioCapability: tool.ioCapability } : {}),
    requiresSandbox: tool.requiresSandbox,
    requireJustification: tool.requireJustification ?? false,
    concurrencySafe: tool.concurrencySafe ?? false,
    inputFields: inputFieldNames(tool),
  };
}

/**
 * The structural subset of RegisteredTool this module reads. Declared
 * locally so `tools-cli` keeps its "pure, no tool imports" property.
 */
export type ToolLike = {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification?: boolean;
  readonly concurrencySafe?: boolean;
  readonly inputSchema?: unknown;
  readonly jsonSchema?: unknown;
};

/**
 * Pull top-level input field names off a tool. Prefers the authoritative
 * `jsonSchema` when the tool carries one (MCP tools do); otherwise reads the
 * Zod schema's own `shape`, which is public API on a ZodObject. Returns an
 * empty list rather than throwing when the schema is neither — `tools show`
 * degrading to "no fields listed" beats it crashing on an exotic schema.
 */
export function inputFieldNames(tool: ToolLike): ReadonlyArray<string> {
  const fromJson = (tool.jsonSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (fromJson !== undefined && typeof fromJson === "object") {
    return Object.keys(fromJson).sort();
  }
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  if (shape !== undefined && typeof shape === "object") {
    return Object.keys(shape).sort();
  }
  return [];
}

/** Render `tools show` for the terminal. */
export function formatToolDetailLines(d: ToolDetail): string[] {
  const flags = [
    d.readOnly ? "read-only" : "mutating",
    d.destructive ? "destructive" : undefined,
    d.scope === "external" ? "external" : "internal",
    d.ioCapability !== undefined ? `io:${d.ioCapability}` : undefined,
    d.requiresSandbox ? "sandbox-required" : undefined,
    d.requireJustification ? "justification-gated" : undefined,
    d.concurrencySafe ? "concurrency-safe" : undefined,
  ].filter((f): f is string => f !== undefined);
  return [
    `${d.key}  (${d.name})`,
    `  ${d.description}`,
    "",
    `  flags       ${flags.join(", ")}`,
    `  categories  ${d.categories.length > 0 ? d.categories.map((c) => `all-${c}`).join(", ") : "(uncategorized)"}`,
    `  input       ${d.inputFields.length > 0 ? d.inputFields.join(", ") : "(no declared fields)"}`,
    "",
    `  enable with  tools: [${d.key}]`,
  ];
}

/** One `tools search` hit, most relevant first. */
export type SearchHit = {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Higher is better. Exposed so the test can pin the ranking. */
  readonly score: number;
  /** Which field matched, for the "why did this match" column. */
  readonly matchedOn: ReadonlyArray<string>;
};

/**
 * Rank builtins against a free-text query by exact/prefix/substring match on
 * the key, the PascalCase name, the description, and the tool's categories.
 * Deterministic and lexical — no model, no embeddings, same posture as
 * `tools suggest`.
 */
export function searchTools(
  query: string,
  toolMap: Readonly<Record<string, ToolLike>>,
  categoriesFor: (key: string) => ReadonlyArray<string>,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const hits: SearchHit[] = [];
  for (const [key, tool] of Object.entries(toolMap)) {
    const keyL = key.toLowerCase();
    const nameL = tool.name.toLowerCase();
    const descL = tool.description.toLowerCase();
    const cats = categoriesFor(key).map((c) => c.toLowerCase());
    let score = 0;
    const matchedOn: string[] = [];
    if (keyL === q || nameL === q) {
      score += 100;
      matchedOn.push("name");
    } else if (keyL.startsWith(q) || nameL.startsWith(q)) {
      score += 50;
      matchedOn.push("name");
    } else if (keyL.includes(q) || nameL.includes(q)) {
      score += 25;
      matchedOn.push("name");
    }
    if (cats.some((c) => c === q)) {
      score += 30;
      matchedOn.push("category");
    }
    if (descL.includes(q)) {
      score += 10;
      matchedOn.push("description");
    }
    if (score > 0)
      hits.push({ key, name: tool.name, description: tool.description, score, matchedOn });
  }
  return hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Render `tools search` for the terminal. */
export function formatSearchLines(query: string, hits: ReadonlyArray<SearchHit>): string[] {
  if (hits.length === 0) {
    return [`no builtin tool matches "${query}" — try \`crewhaus tools categories\``];
  }
  const lines = [`${hits.length} match(es) for "${query}":`];
  for (const h of hits) {
    lines.push(`  ${h.key} (${h.name})  [${h.matchedOn.join("+")}]`);
    lines.push(`    ${h.description}`);
  }
  return lines;
}

/**
 * Suggest near-miss keys for an unknown `tools show` argument, so a typo
 * gets a pointer instead of a bare "not found".
 */
export function nearestToolKeys(
  key: string,
  known: ReadonlyArray<string>,
  limit = 3,
): ReadonlyArray<string> {
  const k = key.toLowerCase();
  return known
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.includes(k) || k.includes(c) || c.startsWith(k.slice(0, 3));
    })
    .slice(0, limit);
}
