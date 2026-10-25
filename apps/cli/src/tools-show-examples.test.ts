/**
 * 0.7.1 — every example rule `crewhaus tools show` prints is one that works.
 *
 * `tools show <tool>` ends with an example rule to copy into
 * `permissions.rules`. An example that matches no call the tool runs is
 * worse than none: an operator who copies an allow gets an ask on every
 * call. An earlier build printed `ChatDelete(C0123/*)`, which no call
 * ChatDelete sends ever meets: it reaches an API only when the call names
 * one, so the channel is always read with that API's origin in front. It
 * printed `SmsSend(*@example.com)` for a tool that sends only to a phone
 * number, and `EvmBlockNumber(nightly-*)` for a chain id.
 *
 * So for EVERY builtin that declares `operativeArgs`, the example `tools
 * show` prints is run through the real gate — `runChatLoop`, with the
 * tool's own schema, declaration and flags — on a real call of that tool,
 * written in {@link CALLS}:
 *
 *  - an allow example must let the call run;
 *  - a deny example must stop it, while a bare allow alone lets it run;
 *  - a tool that declares no scoping argument prints a bare allow, which
 *    must let it run.
 *
 * Only `execute` is swapped for a counter, so nothing is written, spawned or
 * sent; the hit count is asserted, so the sweep cannot pass by skipping.
 *
 * A call here must be one the tool acts on, not one it refuses. The schema
 * is the first check (the gate parses with it, and a call it rejects never
 * reaches a rule). The rest is the tool's own: a tool with no API of its
 * own (the Chat tools) acts only on a call that names one, which the sweep
 * holds structurally, and the Chat, SMS and push examples are also run
 * against the real tools below, which send the request (to a scripted
 * transport) and report it sent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createLogger } from "@crewhaus/logging";
import { type PermissionRule, type RuleSet, emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { BUILTIN_TOOLS } from "@crewhaus/tool-categories";
import {
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  _setDnsLookup,
  _setRawFetch,
  registerNotifyConfig,
} from "@crewhaus/tool-notify";
import { NON_CLI_TOOL_FLAGS } from "@crewhaus/tool-registry-manifest/flags";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";
import { loadBuiltinTools } from "./tool-packages";
import { CLI_RUNTIME_TOOL_KEYS, type RuleScope, toolsShowRuleScope } from "./tools-cli";

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** A Slack bot call in API mode: the only mode ChatUpdate, ChatDelete and ChatReact have. */
const SLACK_API = {
  platform: "slack",
  apiBaseUrl: "https://slack.com/api",
  tokenEnv: "SLACK_BOT_TOKEN",
} as const;
const URL_ = "https://api.example.com/v1/status";
const RPC = "https://api.example.com/rpc";
const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const HOLDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX = `0x${"ab".repeat(32)}`;
const REPO = { owner: "acme", repo: "app" } as const;
const SLACK_TS = "1712345678.000100";

/**
 * One real call of each builtin that declares `operativeArgs`, by registered
 * name: what an agent would send to do the tool's job inside what the
 * printed example covers. A new tool fails the sweep until it has one.
 */
const CALLS: Readonly<Record<string, Record<string, unknown>>> = {
  AlertAck: { alertId: "nightly-backup-failed", acknowledgedBy: "ops", justification: "on task" },
  AlertList: {},
  ApprovalStatus: { dir: "src/bot" },
  ApprovalsInbox: { root: "src", harnesses: ["src/bot"] },
  ArchiveCreate: { source: "src/assets", output: "src/assets.tar.gz" },
  ArchiveExtract: { archive: "src/assets.tar.gz", destination: "src/assets" },
  AstQuery: { cwd: "src/app" },
  AuditVerify: {},
  BarcodeEncode: { symbology: "code128", value: "ABC-123", path: "src/barcode.png" },
  Bash: { command: "git status" },
  BashOutput: { bash_id: "bash_1" },
  BlackboardPost: { topic: "nightly-build", author: "builder", text: "green" },
  BlackboardRead: { topic: "nightly-build" },
  BundleFreshness: { dirs: ["src/bot"], root: "src" },
  BundleSizeCheck: { files: ["src/dist/app.js"] },
  ChartRender: {
    type: "bar",
    categories: ["mon"],
    series: [{ name: "builds", values: [3] }],
    path: "src/chart.png",
  },
  ChatDelete: { ...SLACK_API, channel: "C0123", messageId: SLACK_TS },
  ChatPost: { ...SLACK_API, channel: "password-resets", text: "rotated" },
  ChatReact: { ...SLACK_API, channel: "C0123", messageId: SLACK_TS, emoji: "white_check_mark" },
  ChatUpdate: { ...SLACK_API, channel: "C0123", messageId: SLACK_TS, text: "done" },
  CheckRuns: { ...REPO, ref: "main" },
  CheckpointList: { name: "nightly-build" },
  CheckpointLoad: { name: "nightly-build" },
  CheckpointSave: { name: "nightly-build", data: { step: 3 } },
  ChecksumVerify: { directory: "src/dist", manifest: "src/dist/SHA256SUMS" },
  CiWorkflowAudit: {},
  CliVersionPin: { dirs: ["src/bot"] },
  ClipboardRead: {},
  ClipboardWrite: { text: "hello" },
  CompareRefs: { ...REPO, base: "main", head: "feature" },
  CompileBundle: { dir: "src/bot" },
  ConcatFiles: { paths: ["src/a.md", "src/b.md"], destination: "src/all.md" },
  ContainerImageInspect: { image: "ghcr.io/acme/app:1.2.0" },
  ContainerImageTags: { image: "ghcr.io/acme/app" },
  ContractInspect: { chainId: "1", address: ADDRESS },
  CopyPath: { source: "src/a.ts", destination: "src/b.ts" },
  CostReport: {},
  CostSummarize: {},
  CounterGet: { name: "nightly-runs" },
  CounterIncrement: { name: "nightly-runs" },
  CoverageSummary: { cwd: "src", file: "coverage/lcov.info" },
  CronDelete: { source: "crontab", id: "rotate-password-nightly" },
  CronList: {},
  DatabaseBackup: { database: "src/app.db", out: "src/app.db.bak" },
  DatasetInspect: { dataset: "nightly-regressions" },
  DatasetLint: { path: "secrets/dataset.jsonl" },
  DatasetMine: { dedupeAgainst: "nightly-regressions" },
  DatasetPut: { name: "nightly-regressions", samples: [{ input: "hi" }] },
  DeadFileScan: { cwd: "src/app" },
  DedupeMark: { scope: "nightly-digest", id: "item-1" },
  DefiPositionRead: { protocol: "aave-v3", chainId: "1", contract: ADDRESS, account: HOLDER },
  DeliverabilityCheck: { domain: "mail.example.com" },
  DeliveryCheck: { provider: "prod", messageId: "SM123" },
  DependencyAudit: { cwd: "src/app" },
  DependencyList: { cwd: "src/app" },
  DependencyOutdated: { cwd: "src/app" },
  DeployInspect: { name: "billing", env: "staging" },
  DeployRollback: { name: "billing", env: "staging", toVersion: "v1" },
  DesktopNotify: { title: "Build done", body: "green" },
  Diagnostics: { cwd: "src/app" },
  DiagramRender: { nodes: [{ id: "a" }], edges: [], path: "src/diagram.svg" },
  DiffLint: { paths: ["src/a.ts"] },
  DiskUsage: { path: "src/assets" },
  DnsLookup: { name: "api.example.com" },
  DocsSymbolCheck: { docs: ["src/docs"], source: "src/lib" },
  DoctorFix: {
    fixes: ["env-stubs"],
    specPath: "src/bot/crewhaus.yaml",
    crewhausDir: "src/bot/.crewhaus",
    envPath: "src/bot/.env",
  },
  DocxWrite: { path: "src/report.docx", blocks: [{ type: "paragraph", text: "hi" }] },
  DownloadFile: { url: "https://api.example.com/key.pem", path: "secrets/key.pem" },
  EInvoiceBuild: {
    syntax: "ubl",
    invoice: {
      invoiceNumber: "INV-1",
      issueDate: "2026-10-12",
      currency: "EUR",
      seller: { name: "Acme" },
      buyer: { name: "Buyer" },
      lines: [
        {
          id: "1",
          name: "Work",
          quantity: "1",
          unitCode: "C62",
          unitPriceMinor: 1000,
          vat: { categoryCode: "S", ratePercent: "19" },
        },
      ],
    },
    outFile: "src/invoice.xml",
  },
  Edit: { path: "src/a.ts", oldString: "a", newString: "b" },
  EmailSend: {
    from: { address: "bot@example.com" },
    to: [{ address: "ops@example.com" }],
    subject: "Nightly",
    text: "green",
    date: "2026-10-12T00:00:00Z",
    host: "smtp.example.com",
  },
  EmitTraceEvent: { name: "checkpoint", sessionId: "nightly-2026-10-12" },
  EntityRegistryLookup: { name: "Acme Corp" },
  EnvFileUpsert: { path: "src/.env", entries: [{ key: "PORT", value: "8080" }] },
  Erc20Balance: { chainId: 1, token: ADDRESS, accounts: [HOLDER] },
  Erc721TokenInfo: {
    chainId: 1,
    contract: ADDRESS,
    tokenId: "1",
    ipfsGateway: "https://internal.example.com/ipfs/",
  },
  ErrorCluster: {},
  EvalAggregate: { run: "src/evals/run-1.json" },
  EvalBaselinePin: { action: "show", spec: "billing", dataset: "regressions" },
  EvalCoverage: { dataset: "src/evals/dataset.jsonl" },
  EvalHistory: { evalsDir: "src/bot/.crewhaus/evals" },
  EventCounts: {},
  EventQuery: {},
  EvmBlockAtTimestamp: { rpcUrl: RPC, timestamp: 1_700_000_000 },
  EvmBlockNumber: { chainId: "1" },
  EvmCall: { chainId: "1", to: ADDRESS, data: "0x18160ddd" },
  EvmEventScan: { rpcUrl: RPC, fromBlock: 1 },
  EvmGetBalance: { chainId: "1", address: ADDRESS },
  EvmGetBlock: { rpcUrl: RPC },
  EvmGetLogs: { chainId: "1", address: ADDRESS, fromBlock: "0x1", toBlock: "0x2" },
  EvmGetTransaction: { chainId: "1", txHash: TX },
  EvmGetTransactionReceipt: { chainId: "1", txHash: TX },
  EvmMulticall: { chainId: "1", calls: [{ target: ADDRESS, data: "0x18160ddd" }] },
  EvmNonceStatus: { rpcUrl: RPC, address: ADDRESS },
  EvmRpcHealth: { rpcUrl: RPC },
  EvmSendTransaction: { walletId: "treasury", to: ADDRESS, data: "0x" },
  EvmSimulate: { walletId: "treasury", to: ADDRESS, data: "0x" },
  EvmSimulateBundle: { chainId: "1", calls: [{ to: ADDRESS, data: "0x" }] },
  EvmTransactionSummary: { rpcUrl: RPC, txHash: TX },
  EvmWaitForReceipt: { rpcUrl: RPC, txHash: TX },
  ExifStrip: { path: "src/photo.jpg", output: "src/photo-clean.jpg" },
  ExperimentLedger: { action: "tally", name: "nightly-prompt" },
  ExportCsv: { database: "src/app.db", sql: "select 1", out: "src/out.csv" },
  ExportJson: { database: "src/app.db", sql: "select 1", out: "src/out.json" },
  FederationDiscover: { peers: ["deployment-b.example.com"] },
  FeedParse: { url: "https://api.example.com/feed.xml" },
  Fetch: { url: URL_ },
  FindFiles: { path: "src/app" },
  FindReferences: { name: "main", cwd: "src/app" },
  FlywheelStatus: { specDir: "src/bot" },
  Format: { paths: ["secrets/a.ts"] },
  FormatCheck: { cwd: "src/app" },
  FrontmatterWrite: { path: "src/post.md", data: { title: "Hello" } },
  GasMarketRead: { chainId: "1" },
  GitAdd: { paths: ["src/a.ts"] },
  GitApplyPatch: { cwd: "src/app", patch: "diff --git a/x b/x\n" },
  GitBlame: { path: "src/a.ts" },
  GitBranchCreate: { name: "nightly-2026-10-12" },
  GitBranchDelete: { name: "nightly-2026-10-12" },
  GitBranchList: { cwd: "src/app" },
  GitCherryPick: { cwd: "src/app", refs: ["abc1234"] },
  GitCommit: { message: "update", paths: ["src/a.ts"] },
  GitConflicts: { cwd: "src/app" },
  GitDiff: { paths: ["src/a.ts"] },
  GitFileHistory: { path: "src/a.ts" },
  GitLog: { paths: ["src/a.ts"] },
  GitMergeBase: { cwd: "src/app", a: "main" },
  GitRemoteList: { cwd: "src/app" },
  GitResetPaths: { paths: ["src/a.ts"] },
  GitRevParse: { cwd: "src/app" },
  GitShow: { path: "src/a.ts" },
  GitStashList: { cwd: "src/app" },
  GitStashPop: { cwd: "src/app" },
  GitStashPush: { paths: ["src/a.ts"] },
  GitStatus: { cwd: "src/app" },
  GitSwitch: { branch: "nightly-2026-10-12" },
  GitTagCreate: { name: "nightly-2026-10-12" },
  GitTagList: { cwd: "src/app" },
  GitWorktreeAdd: { path: "src/wt" },
  GitWorktreeList: { cwd: "src/app" },
  GitWorktreeRemove: { path: "src/wt" },
  Glob: { pattern: "src/**/*.ts" },
  GoldenCompare: { actualFile: "src/out.txt", golden: "src/golden.txt" },
  GoldenUpdate: { actual: "x", golden: "src/golden.txt" },
  GraphqlQuery: { url: "https://api.example.com/graphql", query: "{ viewer { id } }" },
  Grep: { pattern: "key", path: "secrets/prod" },
  HarnessInventory: { root: "src/harnesses" },
  HarnessJobStatus: { dir: "src/bot" },
  HarnessRegister: { action: "register", dir: "secrets/bot" },
  HarnessRetire: { spec: "bot", archiveDir: "src/archive", dir: "src/bot" },
  HeadRequest: { url: URL_ },
  HealthProbe: { urls: [URL_], deadlineMs: 1000 },
  HooksManage: { action: "list", dir: "secrets/bot" },
  HttpBatch: { requests: [{ url: URL_ }] },
  HttpPaginate: { url: URL_, style: "link", maxPages: 2, timeoutMs: 1000 },
  HttpRequest: { url: URL_ },
  HttpWaitFor: { url: URL_, timeoutMs: 1000 },
  IcsWrite: {
    path: "src/cal.ics",
    stamp: "20261012T000000Z",
    events: [{ uid: "1", summary: "Standup", start: "20261012T090000Z" }],
  },
  ImageCrop: { path: "src/a.png", output: "src/b.png", x: 0, y: 0, width: 1, height: 1 },
  ImageGenerate: { prompt: "a lighthouse" },
  ImageResize: { path: "src/a.png", output: "src/b.png", width: 10 },
  ImportCsv: { database: "src/app.db", file: "src/data.csv", table: "t" },
  ImportGraph: { cwd: "src/app" },
  ImportJson: { database: "src/app.db", file: "src/data.json", table: "t" },
  IncidentBundle: { out: "src/incident.json" },
  IndexBuild: { name: "nightly-docs", paths: ["docs"] },
  IndexSearch: { name: "nightly-docs", query: "deploy" },
  InvoiceRender: {
    dbPath: "src/ledger.sqlite",
    outDir: "src/invoices",
    kind: "invoice",
    idempotencyKey: "inv-1",
    seller: { name: "Acme" },
    buyer: { name: "Buyer" },
    lines: [{ description: "Work", unitAmount: "10.00" }],
    currency: "USD",
    issueDate: "2026-10-12",
    outputs: ["html"],
  },
  IssueComment: { ...REPO, number: 1, body: "thanks" },
  IssueCreate: { ...REPO, title: "Nightly failed" },
  IssueGet: { ...REPO, number: 1 },
  IssueList: { ...REPO },
  IssueUpdate: { ...REPO, number: 1, state: "closed" },
  JavaScript: { code: "require('subprocess')" },
  JournalAppend: { stream: "nightly-log", entry: { ok: true } },
  JournalRead: { stream: "nightly-log" },
  KillShell: { bash_id: "bash_1" },
  KnowledgeSync: { direction: "push", dir: "src/bot", sharedDir: "src/shared" },
  KvDelete: { namespace: "scratch", key: "draft" },
  KvGet: { namespace: "scratch", key: "draft" },
  KvList: { namespace: "scratch", prefix: "dr" },
  KvSet: { namespace: "scratch", key: "draft", value: 1 },
  LedgerPost: {
    dbPath: "src/ledger.sqlite",
    idempotencyKey: "entry-1",
    entries: [
      {
        date: "2026-10-12",
        memo: "Sale",
        lines: [
          { account: "cash", debit: "10.00" },
          { account: "sales", credit: "10.00" },
        ],
      },
    ],
    autoCreateAccounts: true,
  },
  LicenseAggregate: { directory: "src/app" },
  LinkCheck: { urls: [URL_], timeoutMs: 1000 },
  Lint: { paths: ["src/a.ts"] },
  LogsQuery: { query: "error" },
  MakeDirectory: { path: "src/new" },
  ManifestDependencySet: {
    manifest: "src/app/package.json",
    edits: [{ name: "zod", spec: "^3.23.8" }],
  },
  MarkdownLinkCheck: { path: "src/docs" },
  MarketplaceSearch: { registryDir: "src/registry" },
  MediaProbe: { path: "src/clip.mp4" },
  MetricsQuery: { query: "up" },
  MigrationApply: { database: "src/app.db", directory: "src/migrations" },
  MigrationStatus: { database: "src/app.db", directory: "src/migrations" },
  MovePath: { source: "src/a.ts", destination: "src/b.ts" },
  NetworkInfo: {},
  NoteSearch: { query: "deploy" },
  NoteWrite: { id: "nightly-summary", text: "green" },
  NotebookEdit: { path: "src/a.ipynb", mode: "delete", index: 0 },
  OnchainTransactionsSync: { rpcUrl: RPC, address: ADDRESS, fromBlock: 1 },
  OpenExternal: { target: "https://api.example.com/docs" },
  OraclePriceRead: { feed: "eth-usd" },
  OsIndexSearch: { query: "invoice", roots: ["src/app"] },
  PackageInstall: { name: "nightly-tools" },
  PackageManifestVerify: { paths: ["src/pkg/app.rb"] },
  PackagePublishPreflight: { directory: "src/app" },
  PackageQuery: { name: "nightly-tools" },
  PackageScripts: { cwd: "src/app" },
  PaymentFileBuild: {
    format: "sepa-pain001",
    payments: [
      {
        id: "p1",
        amountMinor: 1000,
        name: "Supplier",
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
      },
    ],
    sepa: {
      messageId: "m1",
      creationDateTime: "2026-10-12T00:00:00",
      paymentInformationId: "pi1",
      requestedExecutionDate: "2026-10-13",
      debtorName: "Acme",
      debtorIban: "DE89370400440532013000",
    },
    outFile: "src/payments.xml",
  },
  PdfMerge: { inputs: [{ path: "src/a.pdf" }, { path: "src/b.pdf" }], output: "src/all.pdf" },
  PdfSplit: { path: "src/a.pdf", pages: "1", output: "src/p1.pdf" },
  PermissionsSuggest: { dir: "src/bot" },
  PngWrite: { path: "src/a.png", width: 1, height: 1, pixels: "ff0000ff" },
  PortInspect: {},
  PortfolioValuation: {
    quoteCurrency: "USD",
    holdings: [{ asset: "ETH", amount: "1", price: "2000" }],
    chainId: "1",
    wallet: HOLDER,
  },
  PowerAssertion: { action: "status" },
  PrComment: { ...REPO, number: 1, body: "lgtm" },
  PrComments: { ...REPO, number: 1 },
  PrCreate: { ...REPO, title: "Fix", sourceBranch: "fix", targetBranch: "main" },
  PrFiles: { ...REPO, number: 1 },
  PrGet: { ...REPO, number: 1 },
  PrList: { ...REPO },
  PrReviewSubmit: { ...REPO, number: 1, event: "approve" },
  PrReviews: { ...REPO, number: 1 },
  PrUpdate: { ...REPO, number: 1, title: "Fix" },
  PreflightRun: { harnessDir: "src/bot", env: {} },
  PriceQuote: { base: "EUR", quote: "USD" },
  PrintDocument: { path: "src/a.pdf" },
  ProcessOutput: { id: "p1" },
  ProcessStart: { argv: ["git", "status"] },
  ProcessStop: { id: "p1" },
  ProofCheck: { checker: "builtin", claim: "2 + 2 is 4.", statement: "2 + 2 = 4", proof: "eval" },
  PushNotify: { provider: "gateway", to: "topic:ops-alerts", body: "deploy done" },
  Python: { code: "import subprocess" },
  QrEncode: { text: "https://example.com", path: "src/qr.png" },
  // The API it reports on: a self-hosted one the call names.
  RateLimitStatus: { baseUrl: "https://api.example.com/api/v3" },
  Read: { path: "src/a.ts" },
  RegistryOutdated: { manifest: "src/app/package.json" },
  RegistryPackageInfo: { ecosystem: "npm", name: "nightly-tools" },
  RegistrySearch: { ecosystem: "npm", query: "yaml" },
  ReleaseCreate: { ...REPO, tag: "v1.0.0" },
  ReleaseGet: { ...REPO },
  ReleaseList: { ...REPO },
  RemovePath: { path: "src/old.ts" },
  RepoGet: { ...REPO },
  RetentionEnforce: { action: "sweep", dir: "src/bot" },
  Retry: { argv: ["git", "status"], maxAttempts: 2, backoff: { kind: "fixed", delayMs: 0 } },
  RobotsCheck: { url: URL_ },
  RouteControl: { action: "status", dir: "src/bot" },
  RunBuild: { command: ["git", "status"] },
  RunCommand: { argv: ["git", "status"] },
  RunPipeline: { steps: [{ argv: ["git", "status"] }] },
  RunTests: { command: ["git", "status"] },
  RunTimeline: {},
  SearchCode: { ...REPO, query: "deploy" },
  SearchIssues: { ...REPO, query: "flaky" },
  SecretLookup: { refs: ["envfile:.env#DEPLOY_TOKEN"] },
  SecretRotate: { ref: "envfile:.env#DEPLOY_TOKEN", generate: { bytes: 32, encoding: "hex" } },
  SecretScan: { path: "src/app" },
  SendMessage: { channel: "slack:T0123:C0123:1700000000.1", text: "hi" },
  SeoLint: { file: "src/index.html" },
  SessionSummarize: {},
  Shell: { code: "python3 -c 'import subprocess'" },
  SitemapParse: { url: "https://api.example.com/sitemap.xml" },
  SmsSend: { provider: "gateway", to: "+15550100000", body: "deploy done" },
  SpecAdvise: { path: "src/bot/crewhaus.yaml" },
  SpecPatchApply: {
    path: "src/bot/crewhaus.yaml",
    patches: [{ path: ["agent", "instructions"], op: "replace", value: "Be brief." }],
  },
  SpecPin: { name: "billing", specFile: "secrets/crewhaus.yaml", env: "prod" },
  SplitFile: { path: "src/big.txt", maxLines: 1000, outputDir: "src/parts" },
  SqlExec: { database: "src/app.db", sql: "select 1" },
  SqlTransaction: { database: "src/app.db", statements: [{ sql: "select 1" }] },
  SseRead: { url: URL_, timeoutMs: 1000 },
  StateExport: {},
  StateImport: { document: { version: 1, files: [] } },
  StatusPagePost: {
    title: "Degraded",
    body: "Investigating",
    status: "investigating",
    incidentId: "nightly-outage",
    justification: "on task",
  },
  StoreMigrate: { to: "src/store-v2", dir: "src/bot" },
  SubtitleWrite: {
    cues: [{ startMs: 0, endMs: 1000, text: "hi" }],
    format: "srt",
    path: "src/a.srt",
  },
  SystemInfo: {},
  TempDir: { name: "scratch" },
  TlsInspect: { host: "api.example.com" },
  TodoScan: { cwd: "src/app" },
  TodoWrite: { todos: [] },
  TokenResolve: { chainId: 1, query: "password-token" },
  ToolCallStats: {},
  TouchFile: { path: "src/a.ts" },
  TraceQuery: {},
  TrashPath: { paths: ["src/old.ts"] },
  Tree: { path: "src/app" },
  Typecheck: { cwd: "src/app" },
  UrlReachable: { url: URL_ },
  UserPresence: {},
  VatIdValidate: { vatId: "DE123456789" },
  VectorDelete: { ids: ["nightly-chunk-1"] },
  WaitForPort: { port: 443, timeoutMs: 1000, host: "api.example.com" },
  WatchPath: { path: "src/app", timeoutMs: 1000 },
  WatchmeReport: { dir: "src/bot" },
  WebFetch: { url: URL_ },
  WebSearch: { query: "admin password reset" },
  WebhookPost: { url: "https://internal.example.com/hook", payload: { ok: true } },
  WindowList: {},
  WorkflowRunLogs: { ...REPO, runId: 1 },
  WorkflowRunRerun: { ...REPO, runId: 1 },
  WorkflowRuns: { ...REPO },
  WorkspacePackages: { cwd: "src/app" },
  Write: { path: "src/a.ts", content: "export {};\n" },
  XlsxWrite: { path: "src/a.xlsx", sheets: [{ name: "Sheet1", rows: [["a", 1]] }] },
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * A provider that asks for one tool call, then ends the turn, handing
 * `onResult` the tool result the model was given back.
 */
function adapterFor(
  name: string,
  input: unknown,
  onResult: (text: string) => void,
): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req) => {
      const first = i === 0;
      i++;
      if (!first) {
        for (const m of req.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const block of m.content as Array<{ type?: string; content?: unknown }>) {
            if (block.type !== "tool_result") continue;
            onResult(
              typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            );
          }
        }
      }
      return (async function* () {
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: first
            ? { type: "tool_use", id: "tu_1", name, input: {} }
            : { type: "text", text: "" },
        } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: first
            ? { type: "input_json_delta", partial_json: JSON.stringify(input) }
            : { type: "text_delta", text: "done" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "tool_use" : "end_turn",
          usage: { input: 1, output: 1 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const rules = (...list: Array<[PermissionRule["type"], string]>): RuleSet => ({
  ...emptyRuleSet,
  yaml: list.map(([type, pattern]) => ({ type, pattern, source: "yaml" as const })),
});

let ws: string;
let state: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  ws = realpathSync(mkdtempSync(join(tmpdir(), "tools-show-ws-")));
  state = mkdtempSync(join(tmpdir(), "tools-show-state-"));
  mkdirSync(join(ws, "src", "app"), { recursive: true });
  process.chdir(ws);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(ws, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

type Outcome = {
  /** The gate's first decision on the call. */
  readonly decision: string | undefined;
  /** Why, when the engine words a reason. */
  readonly reason: string | undefined;
  /** The tool result the model was handed: the tool's output, or why it did not run. */
  readonly result: string | undefined;
};

/**
 * Run one model turn that calls `tool` with `input` under `ruleSet`, through
 * `runChatLoop` in default mode: the gate parses the call with the tool's
 * schema, reads its operative values and decides. A justification-gated
 * tool's intent check is passed, so a call the rules allow runs.
 */
async function gate(tool: RegisteredTool, input: unknown, ruleSet: RuleSet): Promise<Outcome> {
  // The tools resolve a relative path against process.cwd(); never run one
  // against anything but this test's own workspace.
  const where = relative(ws, process.cwd());
  if (where.startsWith("..") || isAbsolute(where)) {
    throw new Error(`gate(${tool.name}) outside its workspace: ${process.cwd()}`);
  }
  const runContext = createRunContext({ logger: createLogger({ sink: () => undefined }) });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  let result: string | undefined;
  await runChatLoop({
    model: "test-model",
    instructions: "tools show examples",
    runContext,
    sessionRootDir: mkdtempSync(join(state, "sess-")),
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
    permissionMode: "default",
    permissionRules: ruleSet,
    tools: [tool],
    // The loop's human-facing lines (`[tool: X]`, `agent> `) are not the
    // subject: three hundred calls of them would bury a failure.
    stdout: () => undefined,
    sandboxAvailable: true,
    justificationJudge: () => ({ allow: true, reason: "on task", judgeModel: "test" }),
    _adapter: adapterFor(tool.name, input, (text) => {
      result = text;
    }),
  });
  const first = events.find((e) => e.kind === "permission_decision");
  return {
    decision: first?.kind === "permission_decision" ? first.decision : undefined,
    reason: first?.kind === "permission_decision" ? first.reason : undefined,
    result,
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

type Row = {
  readonly key: string;
  readonly name: string;
  /** The tool as the gate sees it: everything real but `execute`. */
  readonly tool: RegisteredTool;
  /** The live tool, for what the sweep reads off it. */
  readonly live: RegisteredTool;
  /** What `tools show` prints for it. */
  readonly scope: RuleScope;
  /** Every input `execute` was handed. */
  readonly ran: unknown[];
};

let rows: Row[];
beforeAll(async () => {
  // The two sources `crewhaus tools show` reads: the tools the CLI loads,
  // and the manifest's flags for the builtins only other shapes carry.
  const cliTools = await loadBuiltinTools(CLI_RUNTIME_TOOL_KEYS);
  const { tools } = await loadAllBuiltinTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  rows = [];
  for (const [key, entry] of Object.entries(BUILTIN_TOOLS)) {
    const scope = toolsShowRuleScope(key, entry.name, cliTools, NON_CLI_TOOL_FLAGS);
    if (scope.kind === "undeclared") continue;
    const live = byName.get(entry.name);
    if (live === undefined) throw new Error(`no loaded tool registered as ${entry.name}`);
    const ran: unknown[] = [];
    const tool: RegisteredTool = {
      ...live,
      execute: async (input) => {
        ran.push(input);
        return "ran";
      },
    };
    rows.push({ key, name: entry.name, tool, live, scope, ran });
  }
}, 60_000);

describe("every example `crewhaus tools show` prints matches a real call of its tool", () => {
  test("every builtin that declares operativeArgs has a call written here, and nothing else does", () => {
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(CALLS).sort());
    // The sweep's own floor: the registry was read, not an empty map.
    expect(rows.length).toBeGreaterThan(300);
  });

  test("a tool with no API of its own is called with one, as it must be to act", () => {
    // A value on a `service` the tool has no default for is read with the
    // origin of the API the call names; a call that names none is one such
    // a tool refuses (ChatDelete: "set both apiBaseUrl and tokenEnv"), so an
    // example that matches it matches nothing that runs.
    let checked = 0;
    for (const row of rows) {
      if (row.live.serviceDefaults !== undefined) continue;
      for (const arg of row.live.operativeArgs ?? []) {
        if (arg.service === undefined) continue;
        const call = CALLS[row.name] ?? {};
        // Unless the call is in the mode that ignores the value (ChatPost
        // through a webhook).
        if (arg.ignoredWhen !== undefined && call[arg.ignoredWhen] !== undefined) continue;
        expect({ tool: row.name, names: String(call[arg.service]) }).toEqual({
          tool: row.name,
          names: expect.stringMatching(/^https:\/\/[^/]+\//),
        });
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  test("a builtin only other shapes carry is read off the manifest, which has no serviceDefaults: none of them needs one", () => {
    const cliKeys = new Set(CLI_RUNTIME_TOOL_KEYS);
    const shapeOnly = rows.filter((r) => !cliKeys.has(r.key));
    expect(shapeOnly.length).toBeGreaterThan(5);
    for (const row of shapeOnly) {
      const serves = (row.live.operativeArgs ?? []).some((a) => a.service !== undefined);
      expect({ tool: row.name, serves, defaults: row.live.serviceDefaults !== undefined }).toEqual({
        tool: row.name,
        serves,
        defaults: false,
      });
    }
  });

  test("each example decides the call through the real gate: an allow runs it, a deny stops it", async () => {
    const misses: unknown[] = [];
    let allows = 0;
    let denies = 0;
    let bare = 0;
    for (const row of rows) {
      const call = CALLS[row.name];
      const { example } = row.scope;
      if (call === undefined) {
        misses.push({ tool: row.name, example: example.pattern, call: "none written" });
        continue;
      }
      row.ran.length = 0;
      if (example.type === "alwaysAllow") {
        const got = await gate(row.tool, call, rules(["alwaysAllow", example.pattern]));
        const ran = row.ran.length;
        if (got.decision !== "allow" || ran !== 1) {
          misses.push({ tool: row.name, example: example.pattern, ...got, ran });
          continue;
        }
        if (row.scope.kind === "args") allows += 1;
        else bare += 1;
        continue;
      }
      // A deny: it stops the call a bare allow alone lets run.
      const denied = await gate(
        row.tool,
        call,
        rules(["alwaysDeny", example.pattern], ["alwaysAllow", row.name]),
      );
      const ranUnderDeny = row.ran.length;
      const allowed = await gate(row.tool, call, rules(["alwaysAllow", row.name]));
      const ranUnderAllow = row.ran.length - ranUnderDeny;
      if (
        denied.decision !== "deny" ||
        ranUnderDeny !== 0 ||
        allowed.decision !== "allow" ||
        ranUnderAllow !== 1
      ) {
        misses.push({
          tool: row.name,
          example: example.pattern,
          denied,
          ranUnderDeny,
          allowed,
          ranUnderAllow,
        });
        continue;
      }
      denies += 1;
    }
    expect(misses).toEqual([]);
    // The hit count: every row decided as its example says, none skipped.
    expect(allows + denies + bare).toBe(rows.length);
    expect(allows).toBeGreaterThan(250);
    expect(denies).toBeGreaterThan(10);
    expect(bare).toBeGreaterThan(20);
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The real tools: the call an example grants is one the tool sends
// ---------------------------------------------------------------------------

describe("the Chat, SMS and push examples grant a call the real tool sends", () => {
  const TOKEN_VAR = "SLACK_BOT_TOKEN";
  const sent: Array<{ readonly method: string; readonly url: string }> = [];
  let tokenBefore: string | undefined;
  beforeEach(() => {
    sent.length = 0;
    tokenBefore = process.env[TOKEN_VAR];
    process.env[TOKEN_VAR] = "xoxb-test-token-value";
    registerNotifyConfig({
      allowed_origins: ["https://slack.com", "https://sms.example.com"],
      allowed_secret_envs: [TOKEN_VAR],
      allowed_sms_recipients: ["+1555*"],
      allowed_push_targets: ["topic:ops-*"],
      providers: {
        gateway: { endpoint: "https://sms.example.com/send", fields: { to: "To", body: "Body" } },
      },
    });
    // Nothing leaves the process: the name resolves to a documentation
    // address, and the request is answered by this script, which records it.
    _setDnsLookup(async () => ({ address: "203.0.113.10", family: 4 }));
    _setRawFetch(async (req) => {
      sent.push({ method: req.method, url: req.url });
      return new Response(JSON.stringify({ ok: true, ts: SLACK_TS }), {
        headers: { "content-type": "application/json" },
      });
    });
  });
  afterEach(() => {
    _setRawFetch(undefined);
    _setDnsLookup(undefined);
    _resetNotifyConfig();
    _resetIdempotencyLedger();
    if (tokenBefore === undefined) delete process.env[TOKEN_VAR];
    else process.env[TOKEN_VAR] = tokenBefore;
  });

  function row(name: string): Row {
    const found = rows.find((r) => r.name === name);
    if (found === undefined) throw new Error(`no row for ${name}`);
    return found;
  }

  // [tool, the request it sends, the outcome it reports]
  const allows: ReadonlyArray<readonly [string, string, string]> = [
    ["ChatUpdate", "POST https://slack.com/api/chat.update", "updated"],
    ["ChatDelete", "POST https://slack.com/api/chat.delete", "deleted"],
    ["ChatReact", "POST https://slack.com/api/reactions.add", "reacted"],
    ["SmsSend", "POST https://sms.example.com/send", "sent"],
    ["PushNotify", "POST https://sms.example.com/send", "sent"],
  ];
  for (const [name, request, outcome] of allows) {
    test(`${name}: the printed allow lets the call run, and the tool sends it`, async () => {
      const { scope, live } = row(name);
      expect(scope.example.type).toBe("alwaysAllow");
      const got = await gate(live, CALLS[name], rules(["alwaysAllow", scope.example.pattern]));
      expect({ decision: got.decision, sent: sent.map((s) => `${s.method} ${s.url}`) }).toEqual({
        decision: "allow",
        sent: [request],
      });
      expect(JSON.parse(got.result ?? "{}")[outcome]).toBe(true);
    }, 30_000);
  }

  test("the Chat examples name the API's origin; without it an allow meets no call these tools send", async () => {
    expect(row("ChatUpdate").scope.example.pattern).toBe("ChatUpdate(https://slack.com/C0123)");
    expect(row("ChatDelete").scope.example.pattern).toBe("ChatDelete(https://slack.com/C0123/*)");
    expect(row("ChatReact").scope.example.pattern).toBe("ChatReact(https://slack.com/C0123/*)");
    // What an earlier build printed: each asks on the call the tool sends.
    for (const [name, pattern] of [
      ["ChatUpdate", "ChatUpdate(C0123)"],
      ["ChatDelete", "ChatDelete(C0123/*)"],
      ["ChatReact", "ChatReact(C0123/*)"],
    ] as const) {
      const got = await gate(row(name).live, CALLS[name], rules(["alwaysAllow", pattern]));
      expect({ name, decision: got.decision }).toEqual({ name, decision: "ask" });
    }
    expect(sent).toEqual([]);
    // And the only call they meet is one the tool refuses: without an API
    // it sends nothing, whatever the rules say.
    const { apiBaseUrl: _api, tokenEnv: _token, ...noApi } = CALLS["ChatDelete"] ?? {};
    const refused = await gate(row("ChatDelete").live, noApi, rules(["alwaysAllow", "ChatDelete"]));
    expect(refused.decision).toBe("allow");
    expect(refused.result).toContain("set both apiBaseUrl and tokenEnv");
    expect(sent).toEqual([]);
  }, 30_000);

  test("SmsSend and the EVM tools: an allow matches the spelling it is written in, as `tools show` says; a deny meets every one", async () => {
    // Critic11: `SmsSend(+1555*)` asks on `+1 (555) 010-0000`, which the
    // tool's own allow-list admits and sends, and an address allowed in its
    // checksum case asks in lower case. That is the matcher's choice (an
    // allow compares as written), so `tools show` says so beside the example.
    for (const name of ["SmsSend", "EvmSimulate", "EvmSendTransaction"]) {
      const { scope } = row(name);
      expect({ name, asWritten: scope.kind === "args" ? scope.asWritten : undefined }).toEqual({
        name,
        asWritten: expect.stringContaining("an allow matches a"),
      });
    }
    const sms = row("SmsSend");
    expect(sms.scope.kind === "args" ? sms.scope.asWritten : "").toBe(
      "an allow matches a recipient only as the call writes it; a deny or ask also matches it in another letter case or spelling",
    );
    const spelled = { ...CALLS["SmsSend"], to: "+1 (555) 010-0000" };
    const printed = rules(["alwaysAllow", sms.scope.example.pattern]);
    expect((await gate(sms.live, CALLS["SmsSend"], printed)).decision).toBe("allow");
    expect(sent.length).toBe(1);
    expect((await gate(sms.live, spelled, printed)).decision).toBe("ask");
    const denied = rules(["alwaysDeny", sms.scope.example.pattern], ["alwaysAllow", "SmsSend"]);
    expect((await gate(sms.live, spelled, denied)).decision).toBe("deny");
    expect(sent.length).toBe(1);
    // The tool sends that spelling: only the allow's reading kept it back.
    const bare = await gate(sms.live, spelled, rules(["alwaysAllow", "SmsSend"]));
    expect({ decision: bare.decision, sent: sent.length }).toEqual({ decision: "allow", sent: 2 });
    for (const name of ["EvmSimulate", "EvmSendTransaction"]) {
      const evm = row(name);
      const lower = { ...CALLS[name], to: ADDRESS.toLowerCase() };
      evm.ran.length = 0;
      const allow = rules(["alwaysAllow", evm.scope.example.pattern]);
      const deny = rules(["alwaysDeny", evm.scope.example.pattern], ["alwaysAllow", name]);
      expect({
        name,
        written: (await gate(evm.tool, CALLS[name], allow)).decision,
        lower: (await gate(evm.tool, lower, allow)).decision,
        denied: (await gate(evm.tool, lower, deny)).decision,
        ran: evm.ran.length,
      }).toEqual({ name, written: "allow", lower: "ask", denied: "deny", ran: 1 });
    }
  }, 30_000);

  test("ChatPost: the printed deny stops the API call, which a bare allow lets the tool send", async () => {
    const { scope, live } = row("ChatPost");
    expect(scope.example).toEqual({ type: "alwaysDeny", pattern: "ChatPost(*password*)" });
    const denied = await gate(
      live,
      CALLS["ChatPost"],
      rules(["alwaysDeny", scope.example.pattern], ["alwaysAllow", "ChatPost"]),
    );
    expect({ decision: denied.decision, sent: sent.length }).toEqual({ decision: "deny", sent: 0 });
    const allowed = await gate(live, CALLS["ChatPost"], rules(["alwaysAllow", "ChatPost"]));
    expect(allowed.decision).toBe("allow");
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST https://slack.com/api/chat.postMessage",
    ]);
    expect(JSON.parse(allowed.result ?? "{}").sent).toBe(true);
  }, 30_000);
});
