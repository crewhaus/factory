/**
 * The builtin tool table — the ONE place a builtin tool's wiring is written.
 *
 * Every consumer derives from this table: the compiler's per-shape check,
 * every target emitter (through `resolveBuiltinTools`), `crewhaus run`'s tool
 * loader, the eval runner, `crewhaus lint` and the `crewhaus tools` commands.
 * Before 0.7.1 each of those kept its own copy, eight of them eight to
 * twenty-three entries long, so a tool added to the cli shape's copy compiled
 * on the cli shape and nowhere else.
 *
 * DATA ONLY, like `./registry.ts`. Nothing here imports a tool package: the
 * compiler reads this table, and codegen has to stay offline. That also means
 * this file cannot prove its own `name` / `io` / `sandbox` facts —
 * `apps/cli/src/tool-registry.test.ts`, which can import every tool, re-reads
 * them from the real `RegisteredTool`s on every run.
 *
 * Do not add rows by hand: `bun run scripts/wire-tool-package.ts
 * <manifest.json>` writes them (and the category, the keyword table and the
 * build references) from one declaration.
 */
import type { ToolShape } from "./shapes";

/** One builtin tool, keyed in {@link BUILTIN_TOOLS} by the camelCase spec key. */
export type BuiltinToolEntry = {
  /** The package that exports the tool. */
  readonly package: string;
  /** The package export — the spec key, unless the natural name collides. */
  readonly export: string;
  /** The `RegisteredTool.name`: what session logs record and permission rules match. */
  readonly name: string;
  /**
   * The registrar that receives this tool's `tool_config` block at boot — a
   * key of {@link TOOL_BOOT_REGISTRARS}. Every tool of a configurable package
   * names it, so the package's documented block (`tool_config.http`) and a
   * tool's own key (`tool_config.httpRequest`) reach the same place.
   */
  readonly initSymbol?: string;
  /**
   * The registrar that binds what this tool reads a chain through, from the
   * spec's `chains` / `wallets` / `contracts` / `transaction_policy` blocks —
   * a key of {@link TOOL_BOOT_REGISTRARS}. Without a `chains` block the tool
   * compiles with a `tool-unwired` warning and refuses every call.
   */
  readonly chainSymbol?: string;
  /** Mirrors `RegisteredTool.ioCapability`: the tool crosses this boundary. */
  readonly io?: "process" | "network";
  /** Mirrors `RegisteredTool.requiresSandbox`: runs model-written code. */
  readonly sandbox?: true;
  /** Mirrors `RegisteredTool.requireJustification`: every call carries a reason. */
  readonly justify?: true;
  /** Wired on the Cloudflare Worker edge runtime (fetch and KV only). */
  readonly edge?: true;
  /**
   * Only these shapes carry the tool. Absent means every shape that runs a
   * tool catalog. A shape-specific tool is in no category, so `all-<category>`
   * never reaches it.
   */
  readonly shapes?: ReadonlyArray<ToolShape>;
  /**
   * The tool compiles on its shapes, but nothing binds what it needs, so every
   * call returns an error. The compiler warns (an error under `--strict`).
   */
  readonly inert?: string;
  /** No shape can run the tool in this release; the compiler refuses it. */
  readonly withheld?: string;
};

/**
 * A boot registrar: an exported function a bundle calls once, before any tool
 * is registered, and `crewhaus run` and `crewhaus eval` call the same way.
 *
 * `source` says where its argument comes from:
 *  - `tool_config` — the spec's block for the package. It may be written
 *    under any of `keys` (the package's documented key comes first), or under
 *    the own key or registered name of a tool that names this registrar.
 *  - `chains` — the spec's `chains`, `wallets`, `contracts` and
 *    `transaction_policy` blocks, as a {@link ChainBootConfig}.
 *
 * `binds` lists the package's other boot seams this registrar sets. The
 * guard in `apps/cli/src/boot-seams.test.ts` reads the registrar's source
 * and fails if it does not call each one, and fails for any boot seam in a
 * tool package that no registrar, host or `OPTIONAL_BOOT_SEAMS` row covers.
 */
export type BootRegistrar = {
  readonly package: string;
  readonly source: "tool_config" | "chains";
  /** Words for messages: "the http tools", "code execution". */
  readonly label: string;
  /** `tool_config` only: the package-level keys, the documented one first. */
  readonly keys?: ReadonlyArray<string>;
  readonly binds?: ReadonlyArray<string>;
  /**
   * What the registrar refuses that compile can already see, so `compile`
   * and `lint` report it with the key and the fix instead of the harness
   * stopping at start. `apps/cli/src/tool-config-checks.test.ts` runs every
   * registrar over probes and fails when it and these checks disagree.
   */
  readonly checks?: RegistrarChecks;
};

/** The data-only half of a registrar's validation. See {@link BootRegistrar.checks}. */
export type RegistrarChecks = {
  /** Keys a spec may not set at all, and the sentence that says why and what to write. */
  readonly refused?: { readonly keys: ReadonlyArray<string>; readonly fix: string };
  /**
   * A list of origins. `keys` are its spellings in the order the registrar
   * reads them (the first one set wins). `onlyOne`: setting two is refused,
   * and the value must be a list (a registrar without it iterates the value,
   * so it takes "" as empty). `httpsOnly`: plain http is refused.
   */
  readonly origins?: {
    readonly keys: ReadonlyArray<string>;
    readonly onlyOne?: true;
    readonly httpsOnly?: true;
  };
};

/** The allow-list the fetch, http, codehost, notify and obs tools read: camelCase wins. */
const ORIGINS_CAMEL_FIRST: RegistrarChecks = {
  origins: { keys: ["allowedOrigins", "allowed_origins"] },
};

const NO_PRIVATE_HOSTS = (list: string): RegistrarChecks => ({
  refused: {
    keys: ["allow_private_hosts", "allowPrivateHosts"],
    fix: `a spec cannot open loopback or private addresses. Remove it, and list the ${list} under allowed_origins`,
  },
  origins: { keys: ["allowed_origins", "allowedOrigins"], onlyOne: true },
});

export const TOOL_BOOT_REGISTRARS: Readonly<Record<string, BootRegistrar>> = Object.freeze({
  registerFetchConfig: {
    package: "@crewhaus/tool-fetch",
    source: "tool_config",
    label: "Fetch (and DependencyAudit's OSV mirror)",
    keys: ["fetch"],
    checks: ORIGINS_CAMEL_FIRST,
  },
  registerWebFetchConfig: {
    package: "@crewhaus/tool-web",
    source: "tool_config",
    label: "WebFetch",
    keys: ["webFetch"],
  },
  registerCodeExecutionConfig: {
    package: "@crewhaus/tool-code-execution",
    source: "tool_config",
    label: "code execution (python, javascript, shell)",
    keys: ["codeExecution", "code_execution"],
  },
  registerImageGenerationConfig: {
    package: "@crewhaus/tool-image-generation",
    source: "tool_config",
    label: "ImageGenerate",
    keys: ["imageGenerate"],
  },
  registerHttpConfig: {
    package: "@crewhaus/tool-http",
    source: "tool_config",
    label: "the http tools",
    keys: ["http"],
    checks: ORIGINS_CAMEL_FIRST,
  },
  registerCodehostConfig: {
    package: "@crewhaus/tool-codehost",
    source: "tool_config",
    label: "the codehost tools",
    keys: ["codehost"],
    checks: ORIGINS_CAMEL_FIRST,
  },
  registerNotifyConfig: {
    package: "@crewhaus/tool-notify",
    source: "tool_config",
    label: "the notify tools",
    keys: ["notify"],
    checks: ORIGINS_CAMEL_FIRST,
  },
  registerObsConfig: {
    package: "@crewhaus/tool-obs",
    source: "tool_config",
    label: "the obs tools",
    keys: ["obs"],
    checks: ORIGINS_CAMEL_FIRST,
  },
  registerDefiConfig: {
    package: "@crewhaus/tool-defi",
    source: "tool_config",
    label: "the defi tools",
    keys: ["defi"],
  },
  registerChainreadConfig: {
    package: "@crewhaus/tool-chainread",
    source: "tool_config",
    label: "the chainread tools",
    keys: ["chainread"],
    binds: ["setRpcEndpointPolicy"],
    checks: NO_PRIVATE_HOSTS("public RPC origins"),
  },
  registerDiscoveryConfig: {
    package: "@crewhaus/tool-discovery",
    source: "tool_config",
    label: "FederationDiscover",
    keys: ["federationDiscover"],
    binds: ["setPeerPolicy"],
    checks: NO_PRIVATE_HOSTS("peer origins"),
  },
  registerVectorDeleteConfig: {
    package: "@crewhaus/tool-state",
    source: "tool_config",
    label: "VectorDelete",
    keys: ["vectorDelete"],
    binds: ["registerVectorTarget"],
  },
  registerTokenConfig: {
    package: "@crewhaus/tool-token",
    source: "tool_config",
    label: "the token tools",
    keys: ["token"],
    binds: ["_setMetadataFetch"],
    checks: {
      origins: { keys: ["metadata_origins", "metadataOrigins"], onlyOne: true, httpsOnly: true },
    },
  },
  bindTokenChains: {
    package: "@crewhaus/tool-token",
    source: "chains",
    label: "the token tools",
    binds: ["_setChainReader"],
  },
  bindChainCallChains: {
    package: "@crewhaus/tool-chaincall",
    source: "chains",
    label: "the chaincall tools",
    binds: ["setChainRpcResolver"],
  },
  bindEvmChains: {
    package: "@crewhaus/tool-evm",
    source: "chains",
    label: "the evm tools",
    binds: ["setEvmAdapterResolver"],
  },
  bindEvmTxChains: {
    package: "@crewhaus/tool-evm-tx",
    source: "chains",
    label: "EvmSimulate and EvmSendTransaction",
    binds: ["setWalletResolver", "setTransactionPolicyResolver", "setWalletEngineResolver"],
  },
});

/**
 * Boot seams a host binds from a spec block of its own rather than from a
 * tool row. `callers` are repo paths that must call the seam; the guard reads
 * each one, so a row cannot outlive its binding.
 */
export const HOST_BOOT_SEAMS: Readonly<
  Record<
    string,
    { readonly package: string; readonly by: string; readonly callers: ReadonlyArray<string> }
  >
> = Object.freeze({
  registerRetrieveConfig: {
    package: "@crewhaus/tool-retrieve",
    by: "the pipeline shape's retrieve block, and the knowledge block",
    callers: ["packages/target-pipeline/src/index.ts", "apps/cli/src/knowledge-ingest.ts"],
  },
  registerMcpServer: {
    package: "@crewhaus/tool-mcp",
    by: "the mcp_servers block",
    callers: [
      "packages/target-cli/src/index.ts",
      "apps/cli/src/index.ts",
      "packages/eval-runner/src/wire-once.ts",
    ],
  },
  registerOptionalMcpServer: {
    package: "@crewhaus/tool-mcp",
    by: "the mcp_servers block, for a server marked optional",
    callers: [
      "packages/target-cli/src/index.ts",
      "apps/cli/src/index.ts",
      "packages/eval-runner/src/wire-once.ts",
    ],
  },
  registerMcpToolAliases: {
    package: "@crewhaus/tool-mcp",
    by: "the thredz block",
    callers: ["packages/memory-service/src/thredz.ts"],
  },
  registerChannelAdapter: {
    package: "@crewhaus/tool-message-channel",
    by: "the channel shape's channels block",
    callers: ["packages/target-channel-bot/src/index.ts"],
  },
  registerToolConfigs: {
    package: "@crewhaus/tool-categories",
    by: "tool_config and the chain blocks, in the hosts that run a spec without compiling it",
    callers: ["apps/cli/src/index.ts", "packages/eval-runner/src/wire-once.ts"],
  },
});

/**
 * Boot seams nothing binds on purpose, each with the reason its unbound state
 * is a correct answer rather than a broken tool.
 */
export const OPTIONAL_BOOT_SEAMS: Readonly<
  Record<string, { readonly package: string; readonly why: string }>
> = Object.freeze({
  setMarketplaceTrustRoot: {
    package: "@crewhaus/tool-discovery",
    why: "unbound, MarketplaceSearch reports a signed manifest's verdict as unknown, never as trusted; a trust root a spec could supply would vouch for its own templates",
  },
  registerDocumentParser: {
    package: "@crewhaus/tool-document-ingest",
    why: "DocumentIngest reads text, tabular and structured files itself; a binary format such as .pdf needs a parser library this release does not ship, and without one that format is refused by name",
  },
});

/**
 * What a `chains`-sourced registrar receives: the spec's chain blocks, with
 * every `$VAR` reference already read from the environment. A wallet's
 * `keyRef` is left out — nothing in this release signs.
 */
export type ChainBootConfig = {
  readonly chains: ReadonlyArray<{
    readonly chainId: string;
    readonly rpcUrls: ReadonlyArray<string>;
    readonly rpcPolicy: "single" | "quorum" | "fallback";
    readonly finality:
      | { readonly kind: "confirmations"; readonly count: number }
      | { readonly kind: "finalized" }
      | { readonly kind: "safe" };
    readonly reorgTolerant: boolean;
  }>;
  readonly wallets?: ReadonlyArray<{
    readonly id: string;
    readonly chainId: string;
    readonly custody: "user-controlled" | "kms" | "hsm" | "local";
    readonly signingPolicy: "explicit-user-approval" | "policy-gated" | "automated";
  }>;
  readonly contracts?: ReadonlyArray<{ readonly id: string; readonly address: string }>;
  readonly transactionPolicy?: {
    readonly defaultWriteApproval: "required" | "policy" | "none";
    readonly maxValueUsd?: number;
    readonly maxValueWei?: string;
    readonly allowedContracts: ReadonlyArray<string>;
    readonly simulationRequired: boolean;
  };
};

const EVM_WALLET_UNBOUND =
  "no custody provider that can sign ships in this release, so every call would fail. EvmSimulate runs the same transaction without signing";

export const BUILTIN_TOOLS: Readonly<Record<string, BuiltinToolEntry>> = Object.freeze({
  read: { package: "@crewhaus/tool-fs", export: "read", name: "Read" },
  write: { package: "@crewhaus/tool-fs", export: "write", name: "Write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit", name: "Edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob", name: "Glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep", name: "Grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash", name: "Bash", io: "process" },
  bashOutput: { package: "@crewhaus/tool-bash", export: "bashOutput", name: "BashOutput" },
  killShell: { package: "@crewhaus/tool-bash", export: "killShell", name: "KillShell" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite", name: "TodoWrite", edge: true },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    name: "WebFetch",
    initSymbol: "registerWebFetchConfig",
    io: "network",
    edge: true,
  },
  webSearch: {
    package: "@crewhaus/tool-web",
    export: "webSearch",
    name: "WebSearch",
    io: "network",
    edge: true,
  },
  readImage: { package: "@crewhaus/tool-image", export: "readImage", name: "ReadImage" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    name: "Fetch",
    initSymbol: "registerFetchConfig",
    io: "network",
    edge: true,
  },
  python: {
    package: "@crewhaus/tool-code-execution",
    export: "python",
    name: "Python",
    initSymbol: "registerCodeExecutionConfig",
    sandbox: true,
  },
  javascript: {
    package: "@crewhaus/tool-code-execution",
    export: "javascript",
    name: "JavaScript",
    initSymbol: "registerCodeExecutionConfig",
    sandbox: true,
  },
  shell: {
    package: "@crewhaus/tool-code-execution",
    export: "shell",
    name: "Shell",
    initSymbol: "registerCodeExecutionConfig",
    sandbox: true,
  },
  imageGenerate: {
    package: "@crewhaus/tool-image-generation",
    export: "imageGenerate",
    name: "ImageGenerate",
    initSymbol: "registerImageGenerationConfig",
    io: "network",
    edge: true,
  },
  ingestDocument: {
    package: "@crewhaus/tool-document-ingest",
    export: "ingestDocument",
    name: "IngestDocument",
  },
  compactLog: { package: "@crewhaus/tool-text", export: "compactLog", name: "CompactLog" },
  countTokens: { package: "@crewhaus/tool-text", export: "countTokens", name: "CountTokens" },
  escapeString: { package: "@crewhaus/tool-text", export: "escapeString", name: "EscapeString" },
  extractEntities: {
    package: "@crewhaus/tool-text",
    export: "extractEntities",
    name: "ExtractEntities",
  },
  extractKeywords: {
    package: "@crewhaus/tool-text",
    export: "extractKeywords",
    name: "ExtractKeywords",
  },
  fuzzyMatch: { package: "@crewhaus/tool-text", export: "fuzzyMatch", name: "FuzzyMatch" },
  glossaryReplace: {
    package: "@crewhaus/tool-text",
    export: "glossaryReplace",
    name: "GlossaryReplace",
  },
  markdownOutline: {
    package: "@crewhaus/tool-text",
    export: "markdownOutline",
    name: "MarkdownOutline",
  },
  markdownTable: { package: "@crewhaus/tool-text", export: "markdownTable", name: "MarkdownTable" },
  normalizeText: { package: "@crewhaus/tool-text", export: "normalizeText", name: "NormalizeText" },
  regexExtract: { package: "@crewhaus/tool-text", export: "regexExtract", name: "RegexExtract" },
  renderTemplate: {
    package: "@crewhaus/tool-text",
    export: "renderTemplate",
    name: "RenderTemplate",
  },
  ruleClassify: { package: "@crewhaus/tool-text", export: "ruleClassify", name: "RuleClassify" },
  sortLines: { package: "@crewhaus/tool-text", export: "sortLines", name: "SortLines" },
  textDiff: { package: "@crewhaus/tool-text", export: "textDiff", name: "TextDiff" },
  textSimilarity: {
    package: "@crewhaus/tool-text",
    export: "textSimilarity",
    name: "TextSimilarity",
  },
  truncateToBudget: {
    package: "@crewhaus/tool-text",
    export: "truncateToBudget",
    name: "TruncateToBudget",
  },
  wrapText: { package: "@crewhaus/tool-text", export: "wrapText", name: "WrapText" },
  jsonQuery: { package: "@crewhaus/tool-data", export: "jsonQuery", name: "JsonQuery" },
  jsonPatch: { package: "@crewhaus/tool-data", export: "jsonPatch", name: "JsonPatch" },
  jsonMergePatch: {
    package: "@crewhaus/tool-data",
    export: "jsonMergePatch",
    name: "JsonMergePatch",
  },
  jsonFormat: { package: "@crewhaus/tool-data", export: "jsonFormat", name: "JsonFormat" },
  dataDiff: { package: "@crewhaus/tool-data", export: "dataDiff", name: "DataDiff" },
  dataConvert: { package: "@crewhaus/tool-data", export: "dataConvert", name: "DataConvert" },
  csvParse: { package: "@crewhaus/tool-data", export: "csvParse", name: "CsvParse" },
  csvWrite: { package: "@crewhaus/tool-data", export: "csvWrite", name: "CsvWrite" },
  tableQuery: { package: "@crewhaus/tool-data", export: "tableQuery", name: "TableQuery" },
  tableAggregate: {
    package: "@crewhaus/tool-data",
    export: "tableAggregate",
    name: "TableAggregate",
  },
  tableJoin: { package: "@crewhaus/tool-data", export: "tableJoin", name: "TableJoin" },
  recordsToColumns: {
    package: "@crewhaus/tool-data",
    export: "recordsToColumns",
    name: "RecordsToColumns",
  },
  columnsToRecords: {
    package: "@crewhaus/tool-data",
    export: "columnsToRecords",
    name: "ColumnsToRecords",
  },
  flattenObject: { package: "@crewhaus/tool-data", export: "flattenObject", name: "FlattenObject" },
  unflattenObject: {
    package: "@crewhaus/tool-data",
    export: "unflattenObject",
    name: "UnflattenObject",
  },
  jsonlParse: { package: "@crewhaus/tool-data", export: "jsonlParse", name: "JsonlParse" },
  jsonlWrite: { package: "@crewhaus/tool-data", export: "jsonlWrite", name: "JsonlWrite" },
  xmlParse: { package: "@crewhaus/tool-data", export: "xmlParse", name: "XmlParse" },
  sortRecords: { package: "@crewhaus/tool-data", export: "sortRecords", name: "SortRecords" },
  dedupeRecords: { package: "@crewhaus/tool-data", export: "dedupeRecords", name: "DedupeRecords" },
  sampleRecords: { package: "@crewhaus/tool-data", export: "sampleRecords", name: "SampleRecords" },
  dataShape: { package: "@crewhaus/tool-data", export: "dataShape", name: "DataShape" },
  jsonSortKeys: { package: "@crewhaus/tool-data", export: "jsonSortKeys", name: "JsonSortKeys" },
  hash: { package: "@crewhaus/tool-encode", export: "hash", name: "Hash" },
  hmac: { package: "@crewhaus/tool-encode", export: "hmac", name: "Hmac" },
  checksum: { package: "@crewhaus/tool-encode", export: "checksum", name: "Checksum" },
  hexEncode: { package: "@crewhaus/tool-encode", export: "hexEncode", name: "HexEncode" },
  hexDecode: { package: "@crewhaus/tool-encode", export: "hexDecode", name: "HexDecode" },
  urlEncode: { package: "@crewhaus/tool-encode", export: "urlEncode", name: "UrlEncode" },
  urlDecode: { package: "@crewhaus/tool-encode", export: "urlDecode", name: "UrlDecode" },
  urlParse: { package: "@crewhaus/tool-encode", export: "urlParse", name: "UrlParse" },
  urlBuild: { package: "@crewhaus/tool-encode", export: "urlBuild", name: "UrlBuild" },
  urlNormalize: { package: "@crewhaus/tool-encode", export: "urlNormalize", name: "UrlNormalize" },
  uuid: { package: "@crewhaus/tool-encode", export: "uuid", name: "Uuid" },
  ulid: { package: "@crewhaus/tool-encode", export: "ulid", name: "Ulid" },
  nanoId: { package: "@crewhaus/tool-encode", export: "nanoId", name: "NanoId" },
  slugify: { package: "@crewhaus/tool-encode", export: "slugify", name: "Slugify" },
  jwtDecode: { package: "@crewhaus/tool-encode", export: "jwtDecode", name: "JwtDecode" },
  jwtVerify: { package: "@crewhaus/tool-encode", export: "jwtVerify", name: "JwtVerify" },
  dateParse: { package: "@crewhaus/tool-datetime", export: "dateParse", name: "DateParse" },
  dateFormat: { package: "@crewhaus/tool-datetime", export: "dateFormat", name: "DateFormat" },
  dateConvertTimezone: {
    package: "@crewhaus/tool-datetime",
    export: "dateConvertTimezone",
    name: "DateConvertTimezone",
  },
  dateAdd: { package: "@crewhaus/tool-datetime", export: "dateAdd", name: "DateAdd" },
  dateDiff: { package: "@crewhaus/tool-datetime", export: "dateDiff", name: "DateDiff" },
  durationParse: {
    package: "@crewhaus/tool-datetime",
    export: "durationParse",
    name: "DurationParse",
  },
  durationFormat: {
    package: "@crewhaus/tool-datetime",
    export: "durationFormat",
    name: "DurationFormat",
  },
  businessDays: {
    package: "@crewhaus/tool-datetime",
    export: "businessDays",
    name: "BusinessDays",
  },
  dateRange: { package: "@crewhaus/tool-datetime", export: "dateRange", name: "DateRange" },
  cronNext: { package: "@crewhaus/tool-datetime", export: "cronNext", name: "CronNext" },
  cronDescribe: {
    package: "@crewhaus/tool-datetime",
    export: "cronDescribe",
    name: "CronDescribe",
  },
  recurrenceExpand: {
    package: "@crewhaus/tool-datetime",
    export: "recurrenceExpand",
    name: "RecurrenceExpand",
  },
  weekOfYear: { package: "@crewhaus/tool-datetime", export: "weekOfYear", name: "WeekOfYear" },
  dayOfYear: { package: "@crewhaus/tool-datetime", export: "dayOfYear", name: "DayOfYear" },
  isLeapYear: { package: "@crewhaus/tool-datetime", export: "isLeapYear", name: "IsLeapYear" },
  quarterOf: { package: "@crewhaus/tool-datetime", export: "quarterOf", name: "QuarterOf" },
  timestampConvert: {
    package: "@crewhaus/tool-datetime",
    export: "timestampConvert",
    name: "TimestampConvert",
  },
  jsonSchemaValidate: {
    package: "@crewhaus/tool-schema",
    export: "jsonSchemaValidate",
    name: "JsonSchemaValidate",
  },
  jsonSchemaInfer: {
    package: "@crewhaus/tool-schema",
    export: "jsonSchemaInfer",
    name: "JsonSchemaInfer",
  },
  validateRecords: {
    package: "@crewhaus/tool-schema",
    export: "validateRecords",
    name: "ValidateRecords",
  },
  assert: { package: "@crewhaus/tool-schema", export: "assert", name: "Assert" },
  compareGolden: {
    package: "@crewhaus/tool-schema",
    export: "compareGolden",
    name: "CompareGolden",
  },
  deepEqual: { package: "@crewhaus/tool-schema", export: "deepEqual", name: "DeepEqual" },
  matchSubset: { package: "@crewhaus/tool-schema", export: "matchSubset", name: "MatchSubset" },
  checkRequiredFields: {
    package: "@crewhaus/tool-schema",
    export: "checkRequiredFields",
    name: "CheckRequiredFields",
  },
  validateEnum: { package: "@crewhaus/tool-schema", export: "validateEnum", name: "ValidateEnum" },
  validateFormat: {
    package: "@crewhaus/tool-schema",
    export: "validateFormat",
    name: "ValidateFormat",
  },
  validateUniqueKeys: {
    package: "@crewhaus/tool-schema",
    export: "validateUniqueKeys",
    name: "ValidateUniqueKeys",
  },
  validateReferences: {
    package: "@crewhaus/tool-schema",
    export: "validateReferences",
    name: "ValidateReferences",
  },
  schemaDiff: { package: "@crewhaus/tool-schema", export: "schemaDiff", name: "SchemaDiff" },
  schemaSummarize: {
    package: "@crewhaus/tool-schema",
    export: "schemaSummarize",
    name: "SchemaSummarize",
  },
  gitStatus: {
    package: "@crewhaus/tool-git",
    export: "gitStatus",
    name: "GitStatus",
    io: "process",
  },
  gitDiff: { package: "@crewhaus/tool-git", export: "gitDiff", name: "GitDiff", io: "process" },
  gitLog: { package: "@crewhaus/tool-git", export: "gitLog", name: "GitLog", io: "process" },
  gitShow: { package: "@crewhaus/tool-git", export: "gitShow", name: "GitShow", io: "process" },
  gitBlame: { package: "@crewhaus/tool-git", export: "gitBlame", name: "GitBlame", io: "process" },
  gitBranchList: {
    package: "@crewhaus/tool-git",
    export: "gitBranchList",
    name: "GitBranchList",
    io: "process",
  },
  gitTagList: {
    package: "@crewhaus/tool-git",
    export: "gitTagList",
    name: "GitTagList",
    io: "process",
  },
  gitRemoteList: {
    package: "@crewhaus/tool-git",
    export: "gitRemoteList",
    name: "GitRemoteList",
    io: "process",
  },
  gitMergeBase: {
    package: "@crewhaus/tool-git",
    export: "gitMergeBase",
    name: "GitMergeBase",
    io: "process",
  },
  gitRevParse: {
    package: "@crewhaus/tool-git",
    export: "gitRevParse",
    name: "GitRevParse",
    io: "process",
  },
  gitFileHistory: {
    package: "@crewhaus/tool-git",
    export: "gitFileHistory",
    name: "GitFileHistory",
    io: "process",
  },
  gitStashList: {
    package: "@crewhaus/tool-git",
    export: "gitStashList",
    name: "GitStashList",
    io: "process",
  },
  gitConflicts: {
    package: "@crewhaus/tool-git",
    export: "gitConflicts",
    name: "GitConflicts",
    io: "process",
  },
  gitWorktreeList: {
    package: "@crewhaus/tool-git",
    export: "gitWorktreeList",
    name: "GitWorktreeList",
    io: "process",
  },
  gitAdd: { package: "@crewhaus/tool-git", export: "gitAdd", name: "GitAdd", io: "process" },
  gitCommit: {
    package: "@crewhaus/tool-git",
    export: "gitCommit",
    name: "GitCommit",
    io: "process",
  },
  gitSwitch: {
    package: "@crewhaus/tool-git",
    export: "gitSwitch",
    name: "GitSwitch",
    io: "process",
  },
  gitBranchCreate: {
    package: "@crewhaus/tool-git",
    export: "gitBranchCreate",
    name: "GitBranchCreate",
    io: "process",
  },
  gitBranchDelete: {
    package: "@crewhaus/tool-git",
    export: "gitBranchDelete",
    name: "GitBranchDelete",
    io: "process",
  },
  gitStashPush: {
    package: "@crewhaus/tool-git",
    export: "gitStashPush",
    name: "GitStashPush",
    io: "process",
  },
  gitStashPop: {
    package: "@crewhaus/tool-git",
    export: "gitStashPop",
    name: "GitStashPop",
    io: "process",
  },
  gitTagCreate: {
    package: "@crewhaus/tool-git",
    export: "gitTagCreate",
    name: "GitTagCreate",
    io: "process",
  },
  gitApplyPatch: {
    package: "@crewhaus/tool-git",
    export: "gitApplyPatch",
    name: "GitApplyPatch",
    io: "process",
  },
  gitCherryPick: {
    package: "@crewhaus/tool-git",
    export: "gitCherryPick",
    name: "GitCherryPick",
    io: "process",
  },
  gitResetPaths: {
    package: "@crewhaus/tool-git",
    export: "gitResetPaths",
    name: "GitResetPaths",
    io: "process",
  },
  gitWorktreeAdd: {
    package: "@crewhaus/tool-git",
    export: "gitWorktreeAdd",
    name: "GitWorktreeAdd",
    io: "process",
  },
  gitWorktreeRemove: {
    package: "@crewhaus/tool-git",
    export: "gitWorktreeRemove",
    name: "GitWorktreeRemove",
    io: "process",
  },
  stat: { package: "@crewhaus/tool-fsx", export: "stat", name: "Stat" },
  fileHash: { package: "@crewhaus/tool-fsx", export: "fileHash", name: "FileHash" },
  tree: { package: "@crewhaus/tool-fsx", export: "tree", name: "Tree" },
  diskUsage: { package: "@crewhaus/tool-fsx", export: "diskUsage", name: "DiskUsage" },
  findFiles: { package: "@crewhaus/tool-fsx", export: "findFiles", name: "FindFiles" },
  readLines: { package: "@crewhaus/tool-fsx", export: "readLines", name: "ReadLines" },
  tailFile: { package: "@crewhaus/tool-fsx", export: "tailFile", name: "TailFile" },
  makeDirectory: { package: "@crewhaus/tool-fsx", export: "makeDirectory", name: "MakeDirectory" },
  touchFile: { package: "@crewhaus/tool-fsx", export: "touchFile", name: "TouchFile" },
  tempDir: { package: "@crewhaus/tool-fsx", export: "tempDir", name: "TempDir" },
  copyPath: { package: "@crewhaus/tool-fsx", export: "copyPath", name: "CopyPath" },
  movePath: { package: "@crewhaus/tool-fsx", export: "movePath", name: "MovePath" },
  removePath: { package: "@crewhaus/tool-fsx", export: "removePath", name: "RemovePath" },
  splitFile: { package: "@crewhaus/tool-fsx", export: "splitFile", name: "SplitFile" },
  concatFiles: { package: "@crewhaus/tool-fsx", export: "concatFiles", name: "ConcatFiles" },
  archiveList: { package: "@crewhaus/tool-fsx", export: "archiveList", name: "ArchiveList" },
  archiveCreate: {
    package: "@crewhaus/tool-fsx",
    export: "archiveCreate",
    name: "ArchiveCreate",
    io: "process",
  },
  archiveExtract: {
    package: "@crewhaus/tool-fsx",
    export: "archiveExtract",
    name: "ArchiveExtract",
    io: "process",
  },
  frontmatterRead: {
    package: "@crewhaus/tool-fsx",
    export: "frontmatterRead",
    name: "FrontmatterRead",
  },
  frontmatterWrite: {
    package: "@crewhaus/tool-fsx",
    export: "frontmatterWrite",
    name: "FrontmatterWrite",
  },
  notebookRead: { package: "@crewhaus/tool-fsx", export: "notebookRead", name: "NotebookRead" },
  notebookEdit: { package: "@crewhaus/tool-fsx", export: "notebookEdit", name: "NotebookEdit" },
  runCommand: {
    package: "@crewhaus/tool-proc",
    export: "runCommand",
    name: "RunCommand",
    io: "process",
  },
  runPipeline: {
    package: "@crewhaus/tool-proc",
    export: "runPipeline",
    name: "RunPipeline",
    io: "process",
  },
  retry: { package: "@crewhaus/tool-proc", export: "retry", name: "Retry", io: "process" },
  processStart: {
    package: "@crewhaus/tool-proc",
    export: "processStart",
    name: "ProcessStart",
    io: "process",
  },
  processStatus: { package: "@crewhaus/tool-proc", export: "processStatus", name: "ProcessStatus" },
  processOutput: { package: "@crewhaus/tool-proc", export: "processOutput", name: "ProcessOutput" },
  processStop: {
    package: "@crewhaus/tool-proc",
    export: "processStop",
    name: "ProcessStop",
    io: "process",
  },
  processList: { package: "@crewhaus/tool-proc", export: "processList", name: "ProcessList" },
  waitForPort: {
    package: "@crewhaus/tool-proc",
    export: "waitForPort",
    name: "WaitForPort",
    io: "network",
  },
  waitForFile: { package: "@crewhaus/tool-proc", export: "waitForFile", name: "WaitForFile" },
  waitForOutput: { package: "@crewhaus/tool-proc", export: "waitForOutput", name: "WaitForOutput" },
  commandExists: { package: "@crewhaus/tool-proc", export: "commandExists", name: "CommandExists" },
  envInspect: { package: "@crewhaus/tool-proc", export: "envInspect", name: "EnvInspect" },
  base64Encode: { package: "@crewhaus/tool-encode", export: "base64Encode", name: "Base64Encode" },
  base64Decode: { package: "@crewhaus/tool-encode", export: "base64Decode", name: "Base64Decode" },
  httpRequest: {
    package: "@crewhaus/tool-http",
    export: "httpRequest",
    name: "HttpRequest",
    initSymbol: "registerHttpConfig",
    io: "network",
    justify: true,
  },
  httpPaginate: {
    package: "@crewhaus/tool-http",
    export: "httpPaginate",
    name: "HttpPaginate",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  graphqlQuery: {
    package: "@crewhaus/tool-http",
    export: "graphqlQuery",
    name: "GraphqlQuery",
    initSymbol: "registerHttpConfig",
    io: "network",
    justify: true,
  },
  httpBatch: {
    package: "@crewhaus/tool-http",
    export: "httpBatch",
    name: "HttpBatch",
    initSymbol: "registerHttpConfig",
    io: "network",
    justify: true,
  },
  downloadFile: {
    package: "@crewhaus/tool-http",
    export: "downloadFile",
    name: "DownloadFile",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  headRequest: {
    package: "@crewhaus/tool-http",
    export: "headRequest",
    name: "HeadRequest",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  urlReachable: {
    package: "@crewhaus/tool-http",
    export: "urlReachable",
    name: "UrlReachable",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  linkCheck: {
    package: "@crewhaus/tool-http",
    export: "linkCheck",
    name: "LinkCheck",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  httpWaitFor: {
    package: "@crewhaus/tool-http",
    export: "httpWaitFor",
    name: "HttpWaitFor",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  sseRead: {
    package: "@crewhaus/tool-http",
    export: "sseRead",
    name: "SseRead",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  webhookSign: {
    package: "@crewhaus/tool-http",
    export: "webhookSign",
    name: "WebhookSign",
    initSymbol: "registerHttpConfig",
  },
  webhookVerify: {
    package: "@crewhaus/tool-http",
    export: "webhookVerify",
    name: "WebhookVerify",
    initSymbol: "registerHttpConfig",
  },
  dnsLookup: {
    package: "@crewhaus/tool-http",
    export: "dnsLookup",
    name: "DnsLookup",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  tlsInspect: {
    package: "@crewhaus/tool-http",
    export: "tlsInspect",
    name: "TlsInspect",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  robotsCheck: {
    package: "@crewhaus/tool-http",
    export: "robotsCheck",
    name: "RobotsCheck",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  sitemapParse: {
    package: "@crewhaus/tool-http",
    export: "sitemapParse",
    name: "SitemapParse",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  feedParse: {
    package: "@crewhaus/tool-http",
    export: "feedParse",
    name: "FeedParse",
    initSymbol: "registerHttpConfig",
    io: "network",
  },
  kvSet: { package: "@crewhaus/tool-state", export: "kvSet", name: "KvSet" },
  kvGet: { package: "@crewhaus/tool-state", export: "kvGet", name: "KvGet" },
  kvDelete: { package: "@crewhaus/tool-state", export: "kvDelete", name: "KvDelete" },
  kvList: { package: "@crewhaus/tool-state", export: "kvList", name: "KvList" },
  counterIncrement: {
    package: "@crewhaus/tool-state",
    export: "counterIncrement",
    name: "CounterIncrement",
  },
  counterGet: { package: "@crewhaus/tool-state", export: "counterGet", name: "CounterGet" },
  checkpointSave: {
    package: "@crewhaus/tool-state",
    export: "checkpointSave",
    name: "CheckpointSave",
  },
  checkpointLoad: {
    package: "@crewhaus/tool-state",
    export: "checkpointLoad",
    name: "CheckpointLoad",
  },
  checkpointList: {
    package: "@crewhaus/tool-state",
    export: "checkpointList",
    name: "CheckpointList",
  },
  journalAppend: {
    package: "@crewhaus/tool-state",
    export: "journalAppend",
    name: "JournalAppend",
  },
  journalRead: { package: "@crewhaus/tool-state", export: "journalRead", name: "JournalRead" },
  blackboardPost: {
    package: "@crewhaus/tool-state",
    export: "blackboardPost",
    name: "BlackboardPost",
  },
  blackboardRead: {
    package: "@crewhaus/tool-state",
    export: "blackboardRead",
    name: "BlackboardRead",
  },
  noteWrite: { package: "@crewhaus/tool-state", export: "noteWrite", name: "NoteWrite" },
  noteSearch: { package: "@crewhaus/tool-state", export: "noteSearch", name: "NoteSearch" },
  indexBuild: { package: "@crewhaus/tool-state", export: "indexBuild", name: "IndexBuild" },
  indexSearch: { package: "@crewhaus/tool-state", export: "indexSearch", name: "IndexSearch" },
  stateExport: { package: "@crewhaus/tool-state", export: "stateExport", name: "StateExport" },
  stateImport: { package: "@crewhaus/tool-state", export: "stateImport", name: "StateImport" },
  dedupeMark: { package: "@crewhaus/tool-state", export: "dedupeMark", name: "DedupeMark" },
  specValidate: {
    package: "@crewhaus/tool-crewhaus",
    export: "specValidate",
    name: "SpecValidate",
  },
  specCompileCheck: {
    package: "@crewhaus/tool-crewhaus",
    export: "specCompileCheck",
    name: "SpecCompileCheck",
  },
  specSummarize: {
    package: "@crewhaus/tool-crewhaus",
    export: "specSummarize",
    name: "SpecSummarize",
  },
  specDiff: { package: "@crewhaus/tool-crewhaus", export: "specDiff", name: "SpecDiff" },
  toolInventory: {
    package: "@crewhaus/tool-crewhaus",
    export: "toolInventory",
    name: "ToolInventory",
  },
  permissionAudit: {
    package: "@crewhaus/tool-crewhaus",
    export: "permissionAudit",
    name: "PermissionAudit",
  },
  preflightRun: {
    package: "@crewhaus/tool-crewhaus",
    export: "preflightRun",
    name: "PreflightRun",
    io: "network",
  },
  harnessInventory: {
    package: "@crewhaus/tool-crewhaus",
    export: "harnessInventory",
    name: "HarnessInventory",
  },
  bundleFreshness: {
    package: "@crewhaus/tool-crewhaus",
    export: "bundleFreshness",
    name: "BundleFreshness",
  },
  auditVerify: { package: "@crewhaus/tool-crewhaus", export: "auditVerify", name: "AuditVerify" },
  evalBaselineCompare: {
    package: "@crewhaus/tool-crewhaus",
    export: "evalBaselineCompare",
    name: "EvalBaselineCompare",
  },
  sessionSummarize: {
    package: "@crewhaus/tool-crewhaus",
    export: "sessionSummarize",
    name: "SessionSummarize",
  },
  traceQuery: { package: "@crewhaus/tool-crewhaus", export: "traceQuery", name: "TraceQuery" },
  costSummarize: {
    package: "@crewhaus/tool-crewhaus",
    export: "costSummarize",
    name: "CostSummarize",
  },
  runTests: { package: "@crewhaus/tool-code", export: "runTests", name: "RunTests", io: "process" },
  testFailureSummary: {
    package: "@crewhaus/tool-code",
    export: "testFailureSummary",
    name: "TestFailureSummary",
  },
  runBuild: { package: "@crewhaus/tool-code", export: "runBuild", name: "RunBuild", io: "process" },
  typecheck: {
    package: "@crewhaus/tool-code",
    export: "typecheck",
    name: "Typecheck",
    io: "process",
  },
  lint: { package: "@crewhaus/tool-code", export: "lint", name: "Lint", io: "process" },
  format: { package: "@crewhaus/tool-code", export: "format", name: "Format", io: "process" },
  formatCheck: {
    package: "@crewhaus/tool-code",
    export: "formatCheck",
    name: "FormatCheck",
    io: "process",
  },
  diagnostics: {
    package: "@crewhaus/tool-code",
    export: "diagnostics",
    name: "Diagnostics",
    io: "process",
  },
  astQuery: { package: "@crewhaus/tool-code", export: "astQuery", name: "AstQuery" },
  symbolOutline: { package: "@crewhaus/tool-code", export: "symbolOutline", name: "SymbolOutline" },
  findReferences: {
    package: "@crewhaus/tool-code",
    export: "findReferences",
    name: "FindReferences",
  },
  importGraph: { package: "@crewhaus/tool-code", export: "importGraph", name: "ImportGraph" },
  deadFileScan: { package: "@crewhaus/tool-code", export: "deadFileScan", name: "DeadFileScan" },
  todoScan: { package: "@crewhaus/tool-code", export: "todoScan", name: "TodoScan" },
  dependencyList: {
    package: "@crewhaus/tool-code",
    export: "dependencyList",
    name: "DependencyList",
  },
  dependencyOutdated: {
    package: "@crewhaus/tool-code",
    export: "dependencyOutdated",
    name: "DependencyOutdated",
  },
  packageScripts: {
    package: "@crewhaus/tool-code",
    export: "packageScripts",
    name: "PackageScripts",
  },
  workspacePackages: {
    package: "@crewhaus/tool-code",
    export: "workspacePackages",
    name: "WorkspacePackages",
  },
  coverageSummary: {
    package: "@crewhaus/tool-code",
    export: "coverageSummary",
    name: "CoverageSummary",
  },
  stackTraceParse: {
    package: "@crewhaus/tool-code",
    export: "stackTraceParse",
    name: "StackTraceParse",
  },
  prList: {
    package: "@crewhaus/tool-codehost",
    export: "prList",
    name: "PrList",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  prGet: {
    package: "@crewhaus/tool-codehost",
    export: "prGet",
    name: "PrGet",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  prFiles: {
    package: "@crewhaus/tool-codehost",
    export: "prFiles",
    name: "PrFiles",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  prComments: {
    package: "@crewhaus/tool-codehost",
    export: "prComments",
    name: "PrComments",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  prReviews: {
    package: "@crewhaus/tool-codehost",
    export: "prReviews",
    name: "PrReviews",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  issueList: {
    package: "@crewhaus/tool-codehost",
    export: "issueList",
    name: "IssueList",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  issueGet: {
    package: "@crewhaus/tool-codehost",
    export: "issueGet",
    name: "IssueGet",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  checkRuns: {
    package: "@crewhaus/tool-codehost",
    export: "checkRuns",
    name: "CheckRuns",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  workflowRuns: {
    package: "@crewhaus/tool-codehost",
    export: "workflowRuns",
    name: "WorkflowRuns",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  workflowRunLogs: {
    package: "@crewhaus/tool-codehost",
    export: "workflowRunLogs",
    name: "WorkflowRunLogs",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  releaseList: {
    package: "@crewhaus/tool-codehost",
    export: "releaseList",
    name: "ReleaseList",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  releaseGet: {
    package: "@crewhaus/tool-codehost",
    export: "releaseGet",
    name: "ReleaseGet",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  repoGet: {
    package: "@crewhaus/tool-codehost",
    export: "repoGet",
    name: "RepoGet",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  compareRefs: {
    package: "@crewhaus/tool-codehost",
    export: "compareRefs",
    name: "CompareRefs",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  searchCode: {
    package: "@crewhaus/tool-codehost",
    export: "searchCode",
    name: "SearchCode",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  searchIssues: {
    package: "@crewhaus/tool-codehost",
    export: "searchIssues",
    name: "SearchIssues",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  rateLimitStatus: {
    package: "@crewhaus/tool-codehost",
    export: "rateLimitStatus",
    name: "RateLimitStatus",
    initSymbol: "registerCodehostConfig",
    io: "network",
  },
  prCreate: {
    package: "@crewhaus/tool-codehost",
    export: "prCreate",
    name: "PrCreate",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  prUpdate: {
    package: "@crewhaus/tool-codehost",
    export: "prUpdate",
    name: "PrUpdate",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  prComment: {
    package: "@crewhaus/tool-codehost",
    export: "prComment",
    name: "PrComment",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  prReviewSubmit: {
    package: "@crewhaus/tool-codehost",
    export: "prReviewSubmit",
    name: "PrReviewSubmit",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  issueCreate: {
    package: "@crewhaus/tool-codehost",
    export: "issueCreate",
    name: "IssueCreate",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  issueUpdate: {
    package: "@crewhaus/tool-codehost",
    export: "issueUpdate",
    name: "IssueUpdate",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  issueComment: {
    package: "@crewhaus/tool-codehost",
    export: "issueComment",
    name: "IssueComment",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  releaseCreate: {
    package: "@crewhaus/tool-codehost",
    export: "releaseCreate",
    name: "ReleaseCreate",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  workflowRunRerun: {
    package: "@crewhaus/tool-codehost",
    export: "workflowRunRerun",
    name: "WorkflowRunRerun",
    initSymbol: "registerCodehostConfig",
    io: "network",
    justify: true,
  },
  sqlQuery: { package: "@crewhaus/tool-sql", export: "sqlQuery", name: "SqlQuery" },
  sqlExec: { package: "@crewhaus/tool-sql", export: "sqlExec", name: "SqlExec" },
  sqlTransaction: {
    package: "@crewhaus/tool-sql",
    export: "sqlTransaction",
    name: "SqlTransaction",
  },
  sqlExplain: { package: "@crewhaus/tool-sql", export: "sqlExplain", name: "SqlExplain" },
  schemaList: { package: "@crewhaus/tool-sql", export: "schemaList", name: "SchemaList" },
  schemaDescribe: {
    package: "@crewhaus/tool-sql",
    export: "schemaDescribe",
    name: "SchemaDescribe",
  },
  dbSchemaDiff: { package: "@crewhaus/tool-sql", export: "dbSchemaDiff", name: "DbSchemaDiff" },
  tableStats: { package: "@crewhaus/tool-sql", export: "tableStats", name: "TableStats" },
  integrityCheck: {
    package: "@crewhaus/tool-sql",
    export: "integrityCheck",
    name: "IntegrityCheck",
  },
  importCsv: { package: "@crewhaus/tool-sql", export: "importCsv", name: "ImportCsv" },
  importJson: { package: "@crewhaus/tool-sql", export: "importJson", name: "ImportJson" },
  exportCsv: { package: "@crewhaus/tool-sql", export: "exportCsv", name: "ExportCsv" },
  exportJson: { package: "@crewhaus/tool-sql", export: "exportJson", name: "ExportJson" },
  databaseBackup: {
    package: "@crewhaus/tool-sql",
    export: "databaseBackup",
    name: "DatabaseBackup",
  },
  migrationStatus: {
    package: "@crewhaus/tool-sql",
    export: "migrationStatus",
    name: "MigrationStatus",
  },
  migrationApply: {
    package: "@crewhaus/tool-sql",
    export: "migrationApply",
    name: "MigrationApply",
  },
  docxRead: { package: "@crewhaus/tool-docs", export: "docxRead", name: "DocxRead" },
  docxWrite: { package: "@crewhaus/tool-docs", export: "docxWrite", name: "DocxWrite" },
  xlsxRead: { package: "@crewhaus/tool-docs", export: "xlsxRead", name: "XlsxRead" },
  xlsxWrite: { package: "@crewhaus/tool-docs", export: "xlsxWrite", name: "XlsxWrite" },
  pptxRead: { package: "@crewhaus/tool-docs", export: "pptxRead", name: "PptxRead" },
  pdfInfo: { package: "@crewhaus/tool-docs", export: "pdfInfo", name: "PdfInfo" },
  pdfText: { package: "@crewhaus/tool-docs", export: "pdfText", name: "PdfText" },
  pdfSplit: { package: "@crewhaus/tool-docs", export: "pdfSplit", name: "PdfSplit" },
  pdfMerge: { package: "@crewhaus/tool-docs", export: "pdfMerge", name: "PdfMerge" },
  emlParse: { package: "@crewhaus/tool-docs", export: "emlParse", name: "EmlParse" },
  mboxSplit: { package: "@crewhaus/tool-docs", export: "mboxSplit", name: "MboxSplit" },
  icsParse: { package: "@crewhaus/tool-docs", export: "icsParse", name: "IcsParse" },
  icsWrite: { package: "@crewhaus/tool-docs", export: "icsWrite", name: "IcsWrite" },
  vcardParse: { package: "@crewhaus/tool-docs", export: "vcardParse", name: "VcardParse" },
  documentText: {
    package: "@crewhaus/tool-docs",
    export: "documentTextTool",
    name: "DocumentText",
  },
  documentDiff: { package: "@crewhaus/tool-docs", export: "documentDiff", name: "DocumentDiff" },
  piiScan: { package: "@crewhaus/tool-secure", export: "piiScan", name: "PiiScan" },
  piiRedact: { package: "@crewhaus/tool-secure", export: "piiRedact", name: "PiiRedact" },
  pseudonymize: { package: "@crewhaus/tool-secure", export: "pseudonymize", name: "Pseudonymize" },
  depseudonymize: {
    package: "@crewhaus/tool-secure",
    export: "depseudonymize",
    name: "Depseudonymize",
  },
  secretScan: { package: "@crewhaus/tool-secure", export: "secretScan", name: "SecretScan" },
  entropyScore: { package: "@crewhaus/tool-secure", export: "entropyScore", name: "EntropyScore" },
  promptInjectionScan: {
    package: "@crewhaus/tool-secure",
    export: "promptInjectionScan",
    name: "PromptInjectionScan",
  },
  invisibleCharScan: {
    package: "@crewhaus/tool-secure",
    export: "invisibleCharScan",
    name: "InvisibleCharScan",
  },
  homoglyphNormalize: {
    package: "@crewhaus/tool-secure",
    export: "homoglyphNormalize",
    name: "HomoglyphNormalize",
  },
  urlSafetyCheck: {
    package: "@crewhaus/tool-secure",
    export: "urlSafetyCheck",
    name: "UrlSafetyCheck",
  },
  allowlistCheck: {
    package: "@crewhaus/tool-secure",
    export: "allowlistCheck",
    name: "AllowlistCheck",
  },
  contentPolicyCheck: {
    package: "@crewhaus/tool-secure",
    export: "contentPolicyCheck",
    name: "ContentPolicyCheck",
  },
  hashChainVerify: {
    package: "@crewhaus/tool-secure",
    export: "hashChainVerify",
    name: "HashChainVerify",
  },
  signPayload: { package: "@crewhaus/tool-secure", export: "signPayload", name: "SignPayload" },
  verifyPayload: {
    package: "@crewhaus/tool-secure",
    export: "verifyPayload",
    name: "VerifyPayload",
  },
  redactForExport: {
    package: "@crewhaus/tool-secure",
    export: "redactForExport",
    name: "RedactForExport",
  },
  evaluate: { package: "@crewhaus/tool-math", export: "evaluate", name: "Evaluate" },
  statistics: { package: "@crewhaus/tool-math", export: "statistics", name: "Statistics" },
  percentile: { package: "@crewhaus/tool-math", export: "percentile", name: "Percentile" },
  correlation: { package: "@crewhaus/tool-math", export: "correlation", name: "Correlation" },
  linearRegression: {
    package: "@crewhaus/tool-math",
    export: "linearRegressionTool",
    name: "LinearRegression",
  },
  histogram: { package: "@crewhaus/tool-math", export: "histogram", name: "Histogram" },
  outliers: { package: "@crewhaus/tool-math", export: "outliers", name: "Outliers" },
  moneyAdd: { package: "@crewhaus/tool-math", export: "moneyAdd", name: "MoneyAdd" },
  moneyMultiply: {
    package: "@crewhaus/tool-math",
    export: "moneyMultiplyTool",
    name: "MoneyMultiply",
  },
  moneyAllocate: {
    package: "@crewhaus/tool-math",
    export: "moneyAllocateTool",
    name: "MoneyAllocate",
  },
  currencyConvert: {
    package: "@crewhaus/tool-math",
    export: "currencyConvert",
    name: "CurrencyConvert",
  },
  unitConvert: { package: "@crewhaus/tool-math", export: "unitConvert", name: "UnitConvert" },
  round: { package: "@crewhaus/tool-math", export: "round", name: "Round" },
  numberFormat: { package: "@crewhaus/tool-math", export: "numberFormat", name: "NumberFormat" },
  numberParse: { package: "@crewhaus/tool-math", export: "numberParse", name: "NumberParse" },
  percent: { package: "@crewhaus/tool-math", export: "percent", name: "Percent" },
  amortize: { package: "@crewhaus/tool-math", export: "amortize", name: "Amortize" },
  npv: { package: "@crewhaus/tool-math", export: "npv", name: "Npv" },
  irr: { package: "@crewhaus/tool-math", export: "irr", name: "Irr" },
  geoDistance: { package: "@crewhaus/tool-math", export: "geoDistance", name: "GeoDistance" },
  geoBoundingBox: {
    package: "@crewhaus/tool-math",
    export: "geoBoundingBox",
    name: "GeoBoundingBox",
  },
  geoPointInPolygon: {
    package: "@crewhaus/tool-math",
    export: "geoPointInPolygon",
    name: "GeoPointInPolygon",
  },
  chatPost: {
    package: "@crewhaus/tool-notify",
    export: "chatPost",
    name: "ChatPost",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  chatUpdate: {
    package: "@crewhaus/tool-notify",
    export: "chatUpdate",
    name: "ChatUpdate",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  chatDelete: {
    package: "@crewhaus/tool-notify",
    export: "chatDelete",
    name: "ChatDelete",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  chatReact: {
    package: "@crewhaus/tool-notify",
    export: "chatReact",
    name: "ChatReact",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  emailCompose: {
    package: "@crewhaus/tool-notify",
    export: "emailCompose",
    name: "EmailCompose",
    initSymbol: "registerNotifyConfig",
  },
  emailSend: {
    package: "@crewhaus/tool-notify",
    export: "emailSend",
    name: "EmailSend",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  webhookPost: {
    package: "@crewhaus/tool-notify",
    export: "webhookPost",
    name: "WebhookPost",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  smsSend: {
    package: "@crewhaus/tool-notify",
    export: "smsSend",
    name: "SmsSend",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  pushNotify: {
    package: "@crewhaus/tool-notify",
    export: "pushNotify",
    name: "PushNotify",
    initSymbol: "registerNotifyConfig",
    io: "network",
    justify: true,
  },
  deliveryCheck: {
    package: "@crewhaus/tool-notify",
    export: "deliveryCheck",
    name: "DeliveryCheck",
    initSymbol: "registerNotifyConfig",
    io: "network",
  },
  notifyDigest: {
    package: "@crewhaus/tool-notify",
    export: "notifyDigest",
    name: "NotifyDigest",
    initSymbol: "registerNotifyConfig",
  },
  quietHours: {
    package: "@crewhaus/tool-notify",
    export: "quietHours",
    name: "QuietHours",
    initSymbol: "registerNotifyConfig",
  },
  rateLimitGate: {
    package: "@crewhaus/tool-notify",
    export: "rateLimitGate",
    name: "RateLimitGate",
    initSymbol: "registerNotifyConfig",
  },
  messageTemplate: {
    package: "@crewhaus/tool-notify",
    export: "messageTemplate",
    name: "MessageTemplate",
    initSymbol: "registerNotifyConfig",
  },
  eventQuery: {
    package: "@crewhaus/tool-obs",
    export: "eventQuery",
    name: "EventQuery",
    initSymbol: "registerObsConfig",
  },
  eventCounts: {
    package: "@crewhaus/tool-obs",
    export: "eventCounts",
    name: "EventCounts",
    initSymbol: "registerObsConfig",
  },
  toolCallStats: {
    package: "@crewhaus/tool-obs",
    export: "toolCallStats",
    name: "ToolCallStats",
    initSymbol: "registerObsConfig",
  },
  errorCluster: {
    package: "@crewhaus/tool-obs",
    export: "errorCluster",
    name: "ErrorCluster",
    initSymbol: "registerObsConfig",
  },
  runTimeline: {
    package: "@crewhaus/tool-obs",
    export: "runTimeline",
    name: "RunTimeline",
    initSymbol: "registerObsConfig",
  },
  costReport: {
    package: "@crewhaus/tool-obs",
    export: "costReport",
    name: "CostReport",
    initSymbol: "registerObsConfig",
  },
  budgetCheck: {
    package: "@crewhaus/tool-obs",
    export: "budgetCheck",
    name: "BudgetCheck",
    initSymbol: "registerObsConfig",
  },
  sloEvaluate: {
    package: "@crewhaus/tool-obs",
    export: "sloEvaluate",
    name: "SloEvaluate",
    initSymbol: "registerObsConfig",
  },
  incidentBundle: {
    package: "@crewhaus/tool-obs",
    export: "incidentBundle",
    name: "IncidentBundle",
    initSymbol: "registerObsConfig",
  },
  metricsQuery: {
    package: "@crewhaus/tool-obs",
    export: "metricsQuery",
    name: "MetricsQuery",
    initSymbol: "registerObsConfig",
    io: "network",
  },
  logsQuery: {
    package: "@crewhaus/tool-obs",
    export: "logsQuery",
    name: "LogsQuery",
    initSymbol: "registerObsConfig",
    io: "network",
  },
  alertList: {
    package: "@crewhaus/tool-obs",
    export: "alertList",
    name: "AlertList",
    initSymbol: "registerObsConfig",
    io: "network",
  },
  alertAck: {
    package: "@crewhaus/tool-obs",
    export: "alertAck",
    name: "AlertAck",
    initSymbol: "registerObsConfig",
    io: "network",
    justify: true,
  },
  statusPagePost: {
    package: "@crewhaus/tool-obs",
    export: "statusPagePost",
    name: "StatusPagePost",
    initSymbol: "registerObsConfig",
    io: "network",
    justify: true,
  },
  healthProbe: {
    package: "@crewhaus/tool-obs",
    export: "healthProbe",
    name: "HealthProbe",
    initSymbol: "registerObsConfig",
    io: "network",
  },
  imageInfo: { package: "@crewhaus/tool-media", export: "imageInfo", name: "ImageInfo" },
  imageKind: { package: "@crewhaus/tool-media", export: "imageKind", name: "ImageKind" },
  pngRead: { package: "@crewhaus/tool-media", export: "pngRead", name: "PngRead" },
  pngWrite: { package: "@crewhaus/tool-media", export: "pngWrite", name: "PngWrite" },
  imageResize: { package: "@crewhaus/tool-media", export: "imageResize", name: "ImageResize" },
  imageCrop: { package: "@crewhaus/tool-media", export: "imageCrop", name: "ImageCrop" },
  imageDiff: { package: "@crewhaus/tool-media", export: "imageDiff", name: "ImageDiff" },
  exifRead: { package: "@crewhaus/tool-media", export: "exifRead", name: "ExifRead" },
  exifStrip: { package: "@crewhaus/tool-media", export: "exifStrip", name: "ExifStrip" },
  qrEncode: { package: "@crewhaus/tool-media", export: "qrEncode", name: "QrEncode" },
  barcodeEncode: {
    package: "@crewhaus/tool-media",
    export: "barcodeEncode",
    name: "BarcodeEncode",
  },
  chartRender: { package: "@crewhaus/tool-media", export: "chartRender", name: "ChartRender" },
  sparklineRender: {
    package: "@crewhaus/tool-media",
    export: "sparklineRender",
    name: "SparklineRender",
  },
  diagramRender: {
    package: "@crewhaus/tool-media",
    export: "diagramRender",
    name: "DiagramRender",
  },
  colorConvert: { package: "@crewhaus/tool-media", export: "colorConvert", name: "ColorConvert" },
  colorContrast: {
    package: "@crewhaus/tool-media",
    export: "colorContrast",
    name: "ColorContrast",
  },
  subtitleParse: {
    package: "@crewhaus/tool-media",
    export: "subtitleParse",
    name: "SubtitleParse",
  },
  subtitleWrite: {
    package: "@crewhaus/tool-media",
    export: "subtitleWrite",
    name: "SubtitleWrite",
  },
  mediaProbe: {
    package: "@crewhaus/tool-media",
    export: "mediaProbe",
    name: "MediaProbe",
    io: "process",
  },
  branch: { package: "@crewhaus/tool-flow", export: "branch", name: "Branch" },
  consensusVote: { package: "@crewhaus/tool-flow", export: "consensusVote", name: "ConsensusVote" },
  deadlineCheck: { package: "@crewhaus/tool-flow", export: "deadlineCheck", name: "DeadlineCheck" },
  decisionTable: { package: "@crewhaus/tool-flow", export: "decisionTable", name: "DecisionTable" },
  errorClassify: { package: "@crewhaus/tool-flow", export: "errorClassify", name: "ErrorClassify" },
  ruleScore: { package: "@crewhaus/tool-flow", export: "ruleScore", name: "RuleScore" },
  stallDetect: { package: "@crewhaus/tool-flow", export: "stallDetect", name: "StallDetect" },
  licenseAggregate: {
    package: "@crewhaus/tool-pkg",
    export: "licenseAggregate",
    name: "LicenseAggregate",
  },
  lockfileDiff: { package: "@crewhaus/tool-pkg", export: "lockfileDiff", name: "LockfileDiff" },
  packagePublishPreflight: {
    package: "@crewhaus/tool-pkg",
    export: "packagePublishPreflight",
    name: "PackagePublishPreflight",
  },
  packageTarballInspect: {
    package: "@crewhaus/tool-pkg",
    export: "packageTarballInspect",
    name: "PackageTarballInspect",
  },
  semverResolve: { package: "@crewhaus/tool-pkg", export: "semverResolve", name: "SemverResolve" },
  costBasisCompute: {
    package: "@crewhaus/tool-money",
    export: "costBasisCompute",
    name: "CostBasisCompute",
  },
  glCodeSuggest: {
    package: "@crewhaus/tool-money",
    export: "glCodeSuggest",
    name: "GlCodeSuggest",
  },
  paymentIdentifierValidate: {
    package: "@crewhaus/tool-money",
    export: "paymentIdentifierValidate",
    name: "PaymentIdentifierValidate",
  },
  purchaseOrderMatch: {
    package: "@crewhaus/tool-money",
    export: "purchaseOrderMatch",
    name: "PurchaseOrderMatch",
  },
  refundAbuseCheck: {
    package: "@crewhaus/tool-money",
    export: "refundAbuseCheck",
    name: "RefundAbuseCheck",
  },
  refundAmountCompute: {
    package: "@crewhaus/tool-money",
    export: "refundAmountCompute",
    name: "RefundAmountCompute",
  },
  spendLimitCheck: {
    package: "@crewhaus/tool-money",
    export: "spendLimitCheck",
    name: "SpendLimitCheck",
  },
  statementParse: {
    package: "@crewhaus/tool-money",
    export: "statementParse",
    name: "StatementParse",
  },
  taxCalculate: { package: "@crewhaus/tool-money", export: "taxCalculate", name: "TaxCalculate" },
  webhookSignatureVerify: {
    package: "@crewhaus/tool-money",
    export: "webhookSignatureVerify",
    name: "WebhookSignatureVerify",
  },
  abiDecode: { package: "@crewhaus/tool-onchain", export: "abiDecode", name: "AbiDecode" },
  abiEncodeCall: {
    package: "@crewhaus/tool-onchain",
    export: "abiEncodeCall",
    name: "AbiEncodeCall",
  },
  addressCheck: { package: "@crewhaus/tool-onchain", export: "addressCheck", name: "AddressCheck" },
  defiMath: { package: "@crewhaus/tool-onchain", export: "defiMath", name: "DefiMath" },
  functionSelector: {
    package: "@crewhaus/tool-onchain",
    export: "functionSelector",
    name: "FunctionSelector",
  },
  typedDataHash: {
    package: "@crewhaus/tool-onchain",
    export: "typedDataHash",
    name: "TypedDataHash",
  },
  tokenUnits: { package: "@crewhaus/tool-onchain", export: "tokenUnits", name: "TokenUnits" },
  htmlForms: { package: "@crewhaus/tool-html", export: "htmlForms", name: "HtmlForms" },
  htmlLinks: { package: "@crewhaus/tool-html", export: "htmlLinks", name: "HtmlLinks" },
  htmlQuery: { package: "@crewhaus/tool-html", export: "htmlQuery", name: "HtmlQuery" },
  htmlRecords: { package: "@crewhaus/tool-html", export: "htmlRecords", name: "HtmlRecords" },
  htmlStructuredData: {
    package: "@crewhaus/tool-html",
    export: "htmlStructuredData",
    name: "HtmlStructuredData",
  },
  htmlTable: { package: "@crewhaus/tool-html", export: "htmlTable", name: "HtmlTable" },
  htmlText: { package: "@crewhaus/tool-html", export: "htmlText", name: "HtmlText" },
  acceptanceCheck: {
    package: "@crewhaus/tool-verify",
    export: "acceptanceCheck",
    name: "AcceptanceCheck",
  },
  checksumVerify: {
    package: "@crewhaus/tool-verify",
    export: "checksumVerify",
    name: "ChecksumVerify",
  },
  citationLint: { package: "@crewhaus/tool-verify", export: "citationLint", name: "CitationLint" },
  goldenCompare: {
    package: "@crewhaus/tool-verify",
    export: "goldenCompare",
    name: "GoldenCompare",
  },
  goldenUpdate: {
    package: "@crewhaus/tool-verify",
    export: "goldenUpdate",
    name: "GoldenUpdate",
    justify: true,
  },
  markdownLinkCheck: {
    package: "@crewhaus/tool-verify",
    export: "markdownLinkCheck",
    name: "MarkdownLinkCheck",
  },
  contactNormalize: {
    package: "@crewhaus/tool-table",
    export: "contactNormalize",
    name: "ContactNormalize",
  },
  fixedWidthParse: {
    package: "@crewhaus/tool-table",
    export: "fixedWidthParse",
    name: "FixedWidthParse",
  },
  recordLinkage: {
    package: "@crewhaus/tool-table",
    export: "recordLinkage",
    name: "RecordLinkage",
  },
  tableDiff: { package: "@crewhaus/tool-table", export: "tableDiff", name: "TableDiff" },
  tableProfile: { package: "@crewhaus/tool-table", export: "tableProfile", name: "TableProfile" },
  tableReshape: { package: "@crewhaus/tool-table", export: "tableReshape", name: "TableReshape" },
  tableShard: { package: "@crewhaus/tool-table", export: "tableShard", name: "TableShard" },
  diffParse: { package: "@crewhaus/tool-text", export: "diffParse", name: "DiffParse" },
  diffLint: {
    package: "@crewhaus/tool-changeset",
    export: "diffLint",
    name: "DiffLint",
    io: "process",
  },
  docsSymbolCheck: {
    package: "@crewhaus/tool-changeset",
    export: "docsSymbolCheck",
    name: "DocsSymbolCheck",
  },
  bundleSizeCheck: {
    package: "@crewhaus/tool-buildperf",
    export: "bundleSizeCheck",
    name: "BundleSizeCheck",
  },
  benchmarkCompare: {
    package: "@crewhaus/tool-buildperf",
    export: "benchmarkCompare",
    name: "BenchmarkCompare",
  },
  flakyTestDetect: {
    package: "@crewhaus/tool-buildperf",
    export: "flakyTestDetect",
    name: "FlakyTestDetect",
  },
  registryPackageInfo: {
    package: "@crewhaus/tool-registry",
    export: "registryPackageInfo",
    name: "RegistryPackageInfo",
    io: "network",
  },
  registrySearch: {
    package: "@crewhaus/tool-registry",
    export: "registrySearch",
    name: "RegistrySearch",
    io: "network",
  },
  registryOutdated: {
    package: "@crewhaus/tool-registry",
    export: "registryOutdated",
    name: "RegistryOutdated",
    io: "network",
  },
  manifestDependencySet: {
    package: "@crewhaus/tool-registry",
    export: "manifestDependencySet",
    name: "ManifestDependencySet",
    justify: true,
  },
  dependencyAudit: {
    package: "@crewhaus/tool-supplychain",
    export: "dependencyAudit",
    name: "DependencyAudit",
    initSymbol: "registerFetchConfig",
    io: "network",
  },
  ciWorkflowAudit: {
    package: "@crewhaus/tool-supplychain",
    export: "ciWorkflowAudit",
    name: "CiWorkflowAudit",
  },
  containerImageInspect: {
    package: "@crewhaus/tool-containers",
    export: "containerImageInspect",
    name: "ContainerImageInspect",
    io: "network",
  },
  containerImageTags: {
    package: "@crewhaus/tool-containers",
    export: "containerImageTags",
    name: "ContainerImageTags",
    io: "network",
  },
  dataDriftCheck: {
    package: "@crewhaus/tool-table",
    export: "dataDriftCheck",
    name: "DataDriftCheck",
  },
  evmGetBlock: {
    package: "@crewhaus/tool-chainread",
    export: "evmGetBlock",
    name: "EvmGetBlock",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmBlockAtTimestamp: {
    package: "@crewhaus/tool-chainread",
    export: "evmBlockAtTimestamp",
    name: "EvmBlockAtTimestamp",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmRpcHealth: {
    package: "@crewhaus/tool-chainread",
    export: "evmRpcHealth",
    name: "EvmRpcHealth",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmNonceStatus: {
    package: "@crewhaus/tool-chainread",
    export: "evmNonceStatus",
    name: "EvmNonceStatus",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmWaitForReceipt: {
    package: "@crewhaus/tool-chainread",
    export: "evmWaitForReceipt",
    name: "EvmWaitForReceipt",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmTransactionSummary: {
    package: "@crewhaus/tool-chainread",
    export: "evmTransactionSummary",
    name: "EvmTransactionSummary",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmEventScan: {
    package: "@crewhaus/tool-chainread",
    export: "evmEventScan",
    name: "EvmEventScan",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  evmMulticall: {
    package: "@crewhaus/tool-chaincall",
    export: "evmMulticall",
    name: "EvmMulticall",
    chainSymbol: "bindChainCallChains",
    io: "network",
  },
  contractInspect: {
    package: "@crewhaus/tool-chaincall",
    export: "contractInspect",
    name: "ContractInspect",
    chainSymbol: "bindChainCallChains",
    io: "network",
  },
  evmSimulateBundle: {
    package: "@crewhaus/tool-chaincall",
    export: "evmSimulateBundle",
    name: "EvmSimulateBundle",
    chainSymbol: "bindChainCallChains",
    io: "network",
  },
  gasMarketRead: {
    package: "@crewhaus/tool-chaincall",
    export: "gasMarketRead",
    name: "GasMarketRead",
    chainSymbol: "bindChainCallChains",
    io: "network",
  },
  tokenResolve: {
    package: "@crewhaus/tool-token",
    export: "tokenResolve",
    name: "TokenResolve",
    initSymbol: "registerTokenConfig",
    chainSymbol: "bindTokenChains",
    io: "network",
  },
  erc20Balance: {
    package: "@crewhaus/tool-token",
    export: "erc20Balance",
    name: "Erc20Balance",
    initSymbol: "registerTokenConfig",
    chainSymbol: "bindTokenChains",
    io: "network",
  },
  erc721TokenInfo: {
    package: "@crewhaus/tool-token",
    export: "erc721TokenInfo",
    name: "Erc721TokenInfo",
    initSymbol: "registerTokenConfig",
    chainSymbol: "bindTokenChains",
    io: "network",
  },
  priceQuote: {
    package: "@crewhaus/tool-defi",
    export: "priceQuote",
    name: "PriceQuote",
    initSymbol: "registerDefiConfig",
    io: "network",
  },
  oraclePriceRead: {
    package: "@crewhaus/tool-defi",
    export: "oraclePriceRead",
    name: "OraclePriceRead",
    initSymbol: "registerDefiConfig",
    io: "network",
  },
  defiPositionRead: {
    package: "@crewhaus/tool-defi",
    export: "defiPositionRead",
    name: "DefiPositionRead",
    initSymbol: "registerDefiConfig",
    io: "network",
  },
  portfolioValuation: {
    package: "@crewhaus/tool-defi",
    export: "portfolioValuation",
    name: "PortfolioValuation",
    initSymbol: "registerDefiConfig",
    io: "network",
  },
  ledgerPost: { package: "@crewhaus/tool-ledger", export: "ledgerPost", name: "LedgerPost" },
  ledgerQuery: { package: "@crewhaus/tool-ledger", export: "ledgerQuery", name: "LedgerQuery" },
  ledgerReconcile: {
    package: "@crewhaus/tool-ledger",
    export: "ledgerReconcile",
    name: "LedgerReconcile",
  },
  invoiceRender: {
    package: "@crewhaus/tool-ledger",
    export: "invoiceRender",
    name: "InvoiceRender",
  },
  eInvoiceBuild: {
    package: "@crewhaus/tool-einvoice",
    export: "eInvoiceBuild",
    name: "EInvoiceBuild",
  },
  eInvoiceParse: {
    package: "@crewhaus/tool-einvoice",
    export: "eInvoiceParse",
    name: "EInvoiceParse",
  },
  paymentFileBuild: {
    package: "@crewhaus/tool-einvoice",
    export: "paymentFileBuild",
    name: "PaymentFileBuild",
  },
  vatIdValidate: {
    package: "@crewhaus/tool-kyc",
    export: "vatIdValidate",
    name: "VatIdValidate",
    io: "network",
  },
  entityRegistryLookup: {
    package: "@crewhaus/tool-kyc",
    export: "entityRegistryLookup",
    name: "EntityRegistryLookup",
    io: "network",
  },
  sanctionsScreen: {
    package: "@crewhaus/tool-kyc",
    export: "sanctionsScreen",
    name: "SanctionsScreen",
  },
  objectPresign: {
    package: "@crewhaus/tool-objectstore",
    export: "objectPresign",
    name: "ObjectPresign",
  },
  systemInfo: {
    package: "@crewhaus/tool-host",
    export: "systemInfo",
    name: "SystemInfo",
    io: "process",
  },
  networkInfo: {
    package: "@crewhaus/tool-host",
    export: "networkInfo",
    name: "NetworkInfo",
    io: "process",
  },
  portInspect: {
    package: "@crewhaus/tool-host",
    export: "portInspect",
    name: "PortInspect",
    io: "process",
  },
  secretLookup: {
    package: "@crewhaus/tool-secrets",
    export: "secretLookup",
    name: "SecretLookup",
    io: "process",
  },
  envFileUpsert: {
    package: "@crewhaus/tool-secrets",
    export: "envFileUpsert",
    name: "EnvFileUpsert",
    io: "process",
  },
  secretRotate: {
    package: "@crewhaus/tool-secrets",
    export: "secretRotate",
    name: "SecretRotate",
    io: "process",
    justify: true,
  },
  watchPath: { package: "@crewhaus/tool-hostfs", export: "watchPath", name: "WatchPath" },
  trashPath: { package: "@crewhaus/tool-hostfs", export: "trashPath", name: "TrashPath" },
  osIndexSearch: {
    package: "@crewhaus/tool-hostfs",
    export: "osIndexSearch",
    name: "OsIndexSearch",
    io: "process",
  },
  cronList: { package: "@crewhaus/tool-cron", export: "cronList", name: "CronList", io: "process" },
  cronDelete: {
    package: "@crewhaus/tool-cron",
    export: "cronDelete",
    name: "CronDelete",
    io: "process",
    justify: true,
  },
  packageManifestGenerate: {
    package: "@crewhaus/tool-distribution",
    export: "packageManifestGenerate",
    name: "PackageManifestGenerate",
  },
  packageManifestVerify: {
    package: "@crewhaus/tool-distribution",
    export: "packageManifestVerify",
    name: "PackageManifestVerify",
    io: "network",
  },
  packageQuery: {
    package: "@crewhaus/tool-pkgmgr",
    export: "packageQuery",
    name: "PackageQuery",
    io: "process",
  },
  packageInstall: {
    package: "@crewhaus/tool-pkgmgr",
    export: "packageInstall",
    name: "PackageInstall",
    io: "process",
    justify: true,
  },
  clipboardRead: {
    package: "@crewhaus/tool-desktop",
    export: "clipboardRead",
    name: "ClipboardRead",
    io: "process",
    justify: true,
  },
  clipboardWrite: {
    package: "@crewhaus/tool-desktop",
    export: "clipboardWrite",
    name: "ClipboardWrite",
    io: "process",
  },
  desktopNotify: {
    package: "@crewhaus/tool-desktop",
    export: "desktopNotify",
    name: "DesktopNotify",
    io: "process",
  },
  openExternal: {
    package: "@crewhaus/tool-desktop",
    export: "openExternal",
    name: "OpenExternal",
    io: "process",
  },
  printDocument: {
    package: "@crewhaus/tool-desktop",
    export: "printDocument",
    name: "PrintDocument",
    io: "process",
    justify: true,
  },
  windowList: {
    package: "@crewhaus/tool-desktop",
    export: "windowList",
    name: "WindowList",
    io: "process",
  },
  userPresence: {
    package: "@crewhaus/tool-desktop",
    export: "userPresence",
    name: "UserPresence",
    io: "process",
  },
  powerAssertion: {
    package: "@crewhaus/tool-desktop",
    export: "powerAssertion",
    name: "PowerAssertion",
    io: "process",
  },
  specPatchApply: {
    package: "@crewhaus/tool-specops",
    export: "specPatchApply",
    name: "SpecPatchApply",
  },
  specUpgrade: { package: "@crewhaus/tool-specops", export: "specUpgrade", name: "SpecUpgrade" },
  specAdvise: { package: "@crewhaus/tool-specops", export: "specAdvise", name: "SpecAdvise" },
  doctorFix: { package: "@crewhaus/tool-specops", export: "doctorFix", name: "DoctorFix" },
  evalHistory: { package: "@crewhaus/tool-evalops", export: "evalHistory", name: "EvalHistory" },
  evalAggregate: {
    package: "@crewhaus/tool-evalops",
    export: "evalAggregate",
    name: "EvalAggregate",
  },
  evalBaselinePin: {
    package: "@crewhaus/tool-evalops",
    export: "evalBaselinePin",
    name: "EvalBaselinePin",
  },
  evalCoverage: { package: "@crewhaus/tool-evalops", export: "evalCoverage", name: "EvalCoverage" },
  graderMetaTest: {
    package: "@crewhaus/tool-evalops",
    export: "graderMetaTest",
    name: "GraderMetaTest",
  },
  datasetPut: { package: "@crewhaus/tool-dataset", export: "datasetPut", name: "DatasetPut" },
  datasetInspect: {
    package: "@crewhaus/tool-dataset",
    export: "datasetInspect",
    name: "DatasetInspect",
  },
  datasetLint: { package: "@crewhaus/tool-dataset", export: "datasetLint", name: "DatasetLint" },
  datasetMine: { package: "@crewhaus/tool-dataset", export: "datasetMine", name: "DatasetMine" },
  approvalStatus: {
    package: "@crewhaus/tool-approvals",
    export: "approvalStatus",
    name: "ApprovalStatus",
  },
  approvalsInbox: {
    package: "@crewhaus/tool-approvals",
    export: "approvalsInbox",
    name: "ApprovalsInbox",
  },
  permissionsSuggest: {
    package: "@crewhaus/tool-approvals",
    export: "permissionsSuggest",
    name: "PermissionsSuggest",
  },
  harnessRetire: {
    package: "@crewhaus/tool-lifecycle",
    export: "harnessRetire",
    name: "HarnessRetire",
    justify: true,
  },
  storeMigrate: {
    package: "@crewhaus/tool-lifecycle",
    export: "storeMigrate",
    name: "StoreMigrate",
    justify: true,
  },
  retentionEnforce: {
    package: "@crewhaus/tool-lifecycle",
    export: "retentionEnforce",
    name: "RetentionEnforce",
    justify: true,
  },
  knowledgeSync: {
    package: "@crewhaus/tool-lifecycle",
    export: "knowledgeSync",
    name: "KnowledgeSync",
    justify: true,
  },
  harnessRegister: {
    package: "@crewhaus/tool-fleet",
    export: "harnessRegister",
    name: "HarnessRegister",
  },
  harnessJobStatus: {
    package: "@crewhaus/tool-fleet",
    export: "harnessJobStatus",
    name: "HarnessJobStatus",
  },
  compileBundle: {
    package: "@crewhaus/tool-fleet",
    export: "compileBundle",
    name: "CompileBundle",
    io: "process",
  },
  cliVersionPin: {
    package: "@crewhaus/tool-fleet",
    export: "cliVersionPin",
    name: "CliVersionPin",
    io: "process",
  },
  hooksManage: { package: "@crewhaus/tool-fleet", export: "hooksManage", name: "HooksManage" },
  specPin: {
    package: "@crewhaus/tool-deploy",
    export: "specPin",
    name: "SpecPin",
    justify: true,
  },
  deployRollback: {
    package: "@crewhaus/tool-deploy",
    export: "deployRollback",
    name: "DeployRollback",
    justify: true,
  },
  deployInspect: {
    package: "@crewhaus/tool-deploy",
    export: "deployInspect",
    name: "DeployInspect",
  },
  routeControl: {
    package: "@crewhaus/tool-routing",
    export: "routeControl",
    name: "RouteControl",
    justify: true,
  },
  experimentLedger: {
    package: "@crewhaus/tool-routing",
    export: "experimentLedger",
    name: "ExperimentLedger",
    justify: true,
  },
  flywheelStatus: {
    package: "@crewhaus/tool-routing",
    export: "flywheelStatus",
    name: "FlywheelStatus",
  },
  watchmeReport: {
    package: "@crewhaus/tool-routing",
    export: "watchmeReport",
    name: "WatchmeReport",
  },
  marketplaceSearch: {
    package: "@crewhaus/tool-discovery",
    export: "marketplaceSearch",
    name: "MarketplaceSearch",
  },
  federationDiscover: {
    package: "@crewhaus/tool-discovery",
    export: "federationDiscover",
    name: "FederationDiscover",
    initSymbol: "registerDiscoveryConfig",
    io: "network",
  },
  factCrossCheck: {
    package: "@crewhaus/tool-verify",
    export: "factCrossCheck",
    name: "FactCrossCheck",
  },
  vectorDelete: {
    package: "@crewhaus/tool-state",
    export: "vectorDelete",
    name: "VectorDelete",
    initSymbol: "registerVectorDeleteConfig",
    io: "network",
    justify: true,
  },
  emailSendPreflight: {
    package: "@crewhaus/tool-notify",
    export: "emailSendPreflight",
    name: "EmailSendPreflight",
    initSymbol: "registerNotifyConfig",
  },
  deliverabilityCheck: {
    package: "@crewhaus/tool-notify",
    export: "deliverabilityCheck",
    name: "DeliverabilityCheck",
    initSymbol: "registerNotifyConfig",
    io: "network",
  },
  emitTraceEvent: {
    package: "@crewhaus/tool-obs",
    export: "emitTraceEvent",
    name: "EmitTraceEvent",
    initSymbol: "registerObsConfig",
  },
  localTime: { package: "@crewhaus/tool-datetime", export: "localTime", name: "LocalTime" },
  leadAssign: { package: "@crewhaus/tool-flow", export: "leadAssign", name: "LeadAssign" },
  sequenceRun: { package: "@crewhaus/tool-flow", export: "sequenceRun", name: "SequenceRun" },
  onchainTransactionsSync: {
    package: "@crewhaus/tool-chainread",
    export: "onchainTransactionsSync",
    name: "OnchainTransactionsSync",
    initSymbol: "registerChainreadConfig",
    io: "network",
  },
  seoLint: { package: "@crewhaus/tool-verify", export: "seoLint", name: "SeoLint" },
  toolRegistry: {
    package: "@crewhaus/tool-capability",
    export: "toolRegistry",
    name: "ToolRegistry",
  },
  codegraphSearch: {
    package: "@crewhaus/tool-codegraph",
    export: "codegraphSearch",
    name: "CodeGraphSearch",
  },
  codegraphCallers: {
    package: "@crewhaus/tool-codegraph",
    export: "codegraphCallers",
    name: "CodeGraphCallers",
  },
  codegraphCallees: {
    package: "@crewhaus/tool-codegraph",
    export: "codegraphCallees",
    name: "CodeGraphCallees",
  },
  codegraphImpact: {
    package: "@crewhaus/tool-codegraph",
    export: "codegraphImpact",
    name: "CodeGraphImpact",
  },
  // ---- scripts/wire-tool-package.ts inserts new builtins above this line ----

  // Shape-specific builtins. None of these is in a category or in the cli
  // shape's set; each names the shapes that carry it.
  sendMessage: {
    package: "@crewhaus/tool-message-channel",
    export: "sendMessage",
    name: "SendMessage",
    io: "network",
    justify: true,
    edge: true,
    shapes: ["channel"],
  },
  evmCall: {
    package: "@crewhaus/tool-evm",
    export: "evmCall",
    name: "EvmCall",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmGetLogs: {
    package: "@crewhaus/tool-evm",
    export: "evmGetLogs",
    name: "EvmGetLogs",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmGetTransaction: {
    package: "@crewhaus/tool-evm",
    export: "evmGetTransaction",
    name: "EvmGetTransaction",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmGetTransactionReceipt: {
    package: "@crewhaus/tool-evm",
    export: "evmGetTransactionReceipt",
    name: "EvmGetTransactionReceipt",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmGetBalance: {
    package: "@crewhaus/tool-evm",
    export: "evmGetBalance",
    name: "EvmGetBalance",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmBlockNumber: {
    package: "@crewhaus/tool-evm",
    export: "evmBlockNumber",
    name: "EvmBlockNumber",
    chainSymbol: "bindEvmChains",
    shapes: ["graph", "workflow", "crew"],
  },
  evmSendTransaction: {
    package: "@crewhaus/tool-evm-tx",
    export: "evmSendTransaction",
    name: "EvmSendTransaction",
    chainSymbol: "bindEvmTxChains",
    io: "network",
    justify: true,
    shapes: ["graph", "workflow", "crew"],
    withheld: EVM_WALLET_UNBOUND,
  },
  evmSimulate: {
    package: "@crewhaus/tool-evm-tx",
    export: "evmSimulate",
    name: "EvmSimulate",
    chainSymbol: "bindEvmTxChains",
    shapes: ["graph", "workflow", "crew"],
  },
});
