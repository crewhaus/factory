/**
 * 0.7.1 — every builtin that can change something, or reaches outside the
 * process, says which of its arguments decides WHERE it acts.
 *
 * `operativeArgs` is what a scoped permission rule (`Write(src/**)`,
 * `HttpRequest(https://api.example.com/**)`) is checked against, what
 * `crewhaus permissions suggest` scopes a proposal on, and what tells the
 * egress fabric a tool sends to a destination the model picked. A tool that
 * declares nothing falls back to matching every string in its input, which
 * is safe for a deny but makes a scoped allow almost impossible to write and
 * leaves the egress fabric guessing.
 *
 * The scope of this guard is read from the code, never a list of names:
 * every tool `BUILTIN_TOOL_MAP` compiles in, loaded the way a bundle loads
 * it, plus every `export const …: RegisteredTool` in a `packages/tool-*`
 * package — the tools other targets emit (`SendMessage`,
 * `EvmSendTransaction`) are builtins too. The one list here is the EXPECTED
 * set of tools that declare `[]` ("no argument decides where this acts"):
 * declaring nothing is allowed, but it has to be a decision somebody wrote
 * down, so a new `[]` fails until it is added with its reason.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { loadAllBuiltinTools } from "./builtin-tools-for-tests";

let builtins: ReadonlyArray<RegisteredTool>;
let fromMap = 0;
let fromPackages = 0;
beforeAll(async () => {
  const loaded = await loadAllBuiltinTools();
  builtins = loaded.tools;
  fromMap = loaded.fromMap;
  fromPackages = loaded.fromPackages;
}, 60_000);

/** The tools this guard covers: anything not read-only, and anything external. */
function inScope(): RegisteredTool[] {
  return builtins.filter((t) => !t.readOnly || t.scope === "external");
}

type FieldSchema = { isOptional?: () => boolean };

/**
 * The object shape of a tool's input schema, looking through the wrappers a
 * schema is built with (`.refine`/`.superRefine`/`.transform`, `.pipe`,
 * `.default`, `.optional`). `undefined` only for a schema that is not an
 * object underneath; the sweeps below assert no tool is skipped that way.
 */
function shapeOf(schema: unknown): Record<string, FieldSchema> | undefined {
  let current = schema as { shape?: unknown; _def?: Record<string, unknown> } | undefined;
  for (let depth = 0; depth < 16 && current !== undefined; depth++) {
    if (current.shape !== undefined && typeof current.shape === "object") {
      return current.shape as Record<string, FieldSchema>;
    }
    const def = current._def;
    const inner = def?.["schema"] ?? def?.["innerType"] ?? def?.["in"];
    current = inner as typeof current;
  }
  return undefined;
}

/**
 * The builtins that declare `[]`, each with the reason no argument scopes
 * it. Adding a tool here is the review step; the test below fails until
 * this matches the registry exactly.
 */
const NO_SCOPING_ARGUMENT: Readonly<Record<string, string>> = {
  AlertList: "queries the configured alerting backend; the filter selects alerts, not a place",
  BashOutput: "reads a shell this session started, by a handle only this session has",
  ClipboardRead: "the clipboard is the only place it reads",
  ClipboardWrite: "the clipboard is the only place it writes",
  CronList: "lists the machine's schedulers; nothing selects a place",
  DesktopNotify: "the local notification centre is the only destination",
  EntityRegistryLookup: "asks fixed public registries; the identifiers select a record",
  ImageGenerate: "sends a prompt to the configured image provider",
  KillShell: "stops a shell this session started, by a handle only this session has",
  LogsQuery: "queries the configured log backend",
  MetricsQuery: "queries the configured metrics backend",
  NetworkInfo: "reads this machine's network configuration",
  PortInspect: "reads this machine's listening sockets",
  PowerAssertion: "holds or releases this machine's sleep assertion",
  PriceQuote: "asks fixed public price providers",
  ProcessOutput: "reads a process this session started, by a handle only this session has",
  ProcessStop: "stops a process this session started, by a handle only this session has",
  RateLimitStatus: "reads the configured code host's own rate limit",
  RegistrySearch: "searches a fixed public package registry",
  Retrieve: "sends the query to the configured embedder and vector store",
  SystemInfo: "reads this machine's hardware and OS facts",
  TodoWrite: "writes this session's own task list",
  UserPresence: "reads this machine's idle time",
  VatIdValidate: "asks the fixed VIES service",
  WindowList: "lists this machine's windows",
};

describe("every non-read-only or external builtin declares operativeArgs", () => {
  test("the sweep reads the real registry", () => {
    // The guard's own hit count: a sweep that finds nothing passes.
    expect(fromMap).toBeGreaterThanOrEqual(500);
    expect(fromPackages).toBeGreaterThanOrEqual(fromMap);
    expect(builtins.length).toBeGreaterThan(fromMap);
    expect(inScope().length).toBeGreaterThanOrEqual(220);
    const names = new Set(inScope().map((t) => t.name));
    for (const known of [
      "Write",
      "HttpRequest",
      "RunCommand",
      "GitCommit",
      "HttpPaginate",
      // Emitted by other targets, not by BUILTIN_TOOL_MAP.
      "SendMessage",
      "EvmSendTransaction",
    ]) {
      expect(names.has(known)).toBe(true);
    }
  });

  test("none leaves operativeArgs out", () => {
    const undeclared = inScope()
      .filter((t) => t.operativeArgs === undefined)
      .map((t) => t.name)
      .sort();
    expect(undeclared).toEqual([]);
  });

  test("the tools that declare no scoping argument are exactly the reviewed ones", () => {
    const empty = inScope()
      .filter((t) => t.operativeArgs !== undefined && t.operativeArgs.length === 0)
      .map((t) => t.name)
      .sort();
    expect(empty).toEqual(Object.keys(NO_SCOPING_ARGUMENT).sort());
  });

  test("a tool that writes files names at least one path", () => {
    // `destructive` + a declared path is how a rule reaches a file write; a
    // destructive tool whose only declared field is not a path would leave
    // `Write(src/**)`-style rules nothing to read. Derived, not listed: every
    // destructive internal tool with a string field named like a path.
    const pathish = /(^|\.)(path|paths|file|out|output|outFile|destination|database|dbPath)$/;
    const offenders: string[] = [];
    let checked = 0;
    for (const tool of inScope()) {
      if (!tool.destructive || tool.scope === "external") continue;
      const declared = tool.operativeArgs ?? [];
      const fields = Object.keys(shapeOf(tool.inputSchema) ?? {});
      if (!fields.some((f) => pathish.test(f))) continue;
      checked++;
      if (!declared.some((a) => a.kind === "path")) offenders.push(tool.name);
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    expect(offenders).toEqual([]);
  });
});

/**
 * C004 — a field the call may leave out, whose value the tool then fills in
 * `execute`, has to say so with a `default`. Otherwise a deny on the place
 * the tool uses by default — `alwaysDeny KvDelete(.crewhaus/state/**)` — is
 * dodged by leaving the field out, while the tool acts there anyway.
 *
 * Every optional operative field either declares its `default` or is listed
 * here with what an omitted value means, and why no default applies. The
 * test fails for a new optional field until it is one or the other.
 */
const OMITTED_MEANS: Readonly<Record<string, string>> = {
  "ApprovalsInbox.harnesses": "the harnesses are found by walking root, which declares a default",
  "BarcodeEncode.path": "only a PNG is written; an SVG comes back inline and nothing is written",
  "BundleFreshness.dirs": "the harnesses are found by walking root, which declares a default",
  "BundleSizeCheck.baselineFile": "no baseline, or one passed inline; nothing is read",
  "BundleSizeCheck.directory": "the schema requires files or directory; whichever is given is read",
  "BundleSizeCheck.files": "the schema requires files or directory; whichever is given is read",
  "ChartRender.path": "the SVG comes back inline; nothing is written",
  "ChatPost.channel":
    "required in API mode; an incoming webhook posts to the channel the operator bound it to, and webhookUrlEnv names that webhook",
  "ChatPost.webhookUrlEnv": "an API-mode call names its channel, on the API apiBaseUrl names",
  "ChatUpdate.channel":
    "required in API mode; an incoming webhook posts to the channel the operator bound it to",
  "ChecksumVerify.manifest": "the manifest comes back inline; nothing is read or written",
  "CliVersionPin.dirs":
    "the harnesses in this machine's registry, which the operator keeps; it writes nothing",
  "CronDelete.fingerprint": "a guard on the entry id or match names, never a target of its own",
  "CronDelete.id": "the schema requires id or match; whichever is given is read",
  "CronDelete.match": "the schema requires id or match; whichever is given is read",
  "DatasetLint.dataset":
    "the samples are read from path or passed inline; no registry dataset is read",
  "DatasetLint.leakScanPaths":
    "no file is scanned for canary phrases, and the result says the check did not run",
  "DatasetLint.path": "the samples come from the registry (dataset) or inline; no file is read",
  "DatasetMine.dedupeAgainst": "no dedupe and no registry dataset is read, and the result says so",
  "DatasetPut.path": "the samples are passed inline; no file is read",
  "DiagramRender.path": "the SVG comes back inline; nothing is written",
  "DocsSymbolCheck.docs":
    "the document is passed inline as docsText; its source tree declares a default",
  "EInvoiceBuild.outFile": "the document comes back inline; nothing is written",
  "EmailSend.attachments.path": "no attachments; no file is read",
  "EmailSend.bcc.address": "no Bcc recipients; nothing is sent without one recipient somewhere",
  "EmailSend.cc.address": "no Cc recipients; nothing is sent without one recipient somewhere",
  "EmailSend.to.address": "no To recipients; nothing is sent without one recipient somewhere",
  "EmitTraceEvent.sessionId":
    "the session this call runs in, from the run context; its directory declares a default",
  "Erc721TokenInfo.ipfsGateway": "ipfs URIs are skipped; nothing is fetched through a gateway",
  "EvalAggregate.run":
    "the run is looked up by runId in the index under evalsDir, which declares a default",
  "EvmRpcHealth.compareWith": "nothing to compare with; only the main endpoint is probed",
  "ExperimentLedger.name":
    "only `list` omits it, and it names every experiment; the directories declare defaults",
  "FeedParse.url": "the feed is passed inline; nothing is fetched",
  "FlywheelStatus.specDir": "the spec directory is the harness dir, which declares a default",
  "Format.command":
    "the formatter the project declares, detected at run time; the paths it formats declare a default",
  "GoldenCompare.actualFile": "the output is passed inline as actual; the golden is declared",
  "HarnessJobStatus.dir":
    "every harness's jobs in the manager's ledger, whose location the operator sets; the directory only filters it",
  "HarnessRegister.dir":
    "register and relocate refuse without it; the registry file is fixed, never a caller's path",
  "HarnessRegister.from": "the entry is named by id instead; list names none",
  "HarnessRegister.id": "the entry is named by from instead; list names none",
  "HarnessRetire.registryDir": "the registry under the harness dir, which declares a default",
  "HooksManage.command": "only `set` carries a command, and refuses without one",
  "ImportJson.file": "the records are passed inline; nothing is read from disk",
  "InvoiceRender.outDir": "the rendered text comes back inline; nothing is written",
  "InvoiceRender.templateFile": "the built-in template, or one passed inline; no file is read",
  "MarketplaceSearch.registryDir":
    "the built-in first-party gallery is searched; nothing on disk is read",
  "OraclePriceRead.address": "the feed is a pinned one named by feed, which is declared",
  "OraclePriceRead.feed": "the feed is named by chainId and address, which are declared",
  "PackageManifestVerify.paths": "the manifests are passed inline, as manifests.text",
  "PaymentFileBuild.outFile": "the file comes back inline; nothing is written",
  "PortfolioValuation.wallet": "the amounts are passed inline; no balance is read",
  "QrEncode.path": "only a PNG is written; an SVG comes back inline and nothing is written",
  "RunBuild.command":
    "the build the project declares, detected at run time; its directory declares a default",
  "RunTests.command":
    "the test command the project declares, detected at run time; its directory declares a default",
  "RunTests.paths":
    "every test the runner finds under cwd: a runner runs the project's own code, which no path rule confines; a deny naming a test file fires when the call names it",
  "SecretScan.path": "the text is passed inline; nothing is read",
  "SeoLint.corpus": "the near-duplicate check is reported NOT CHECKED; nothing is read",
  "SeoLint.file": "the page is passed inline as html; nothing is read",
  "SecretRotate.newValueFrom": "the new value is generated here; nothing is read",
  "SitemapParse.url": "the sitemap is passed inline; nothing is fetched",
  "SpecAdvise.path":
    "the spec is passed inline, or not at all; the log directories declare defaults",
  "SpecPatchApply.path":
    "the spec is passed inline and patched text comes back; nothing is written",
  "SpecPin.env": "the version is registered and no pin moves",
  "SplitFile.outputDir":
    "the parts are written beside the source, in the directory of path, which is declared",
  "StatusPagePost.incidentId": "a new incident on the operator's configured status page",
  "SubtitleWrite.path": "the document comes back inline; nothing is written",
  "TlsInspect.servername": "the host, which is declared, is the name sent",
  "WebhookPost.url":
    "the URL is read from an operator-listed environment variable, which urlEnv names",
  "WebhookPost.urlEnv": "the URL is passed in url",
};

describe("an optional operative field says what leaving it out means (C004)", () => {
  /** `Tool.field` for every declared field the schema lets a call leave out, with no default. */
  function optionalWithoutDefault(): string[] {
    const out: string[] = [];
    for (const tool of builtins) {
      const shape = shapeOf(tool.inputSchema);
      if (shape === undefined) continue;
      for (const arg of tool.operativeArgs ?? []) {
        if (arg.default !== undefined) continue;
        const top = shape[arg.field.split(".")[0] as string];
        if (top?.isOptional?.() === true) out.push(`${tool.name}.${arg.field}`);
      }
    }
    return out.sort();
  }

  test("every one declares a default or is a reviewed omission", () => {
    const found = optionalWithoutDefault();
    // The sweep's hit count: a scan that could not read the schemas finds nothing.
    expect(found.length).toBeGreaterThanOrEqual(50);
    expect(found).toEqual(Object.keys(OMITTED_MEANS).sort());
  });

  test("no tool that declares operativeArgs is skipped for a schema the sweep cannot read", () => {
    // A `.superRefine` or `.pipe` around the object used to hide its fields,
    // so an optional operative field there was never checked.
    const unread = builtins
      .filter((t) => t.operativeArgs !== undefined && shapeOf(t.inputSchema) === undefined)
      .map((t) => t.name);
    expect(unread).toEqual([]);
    const wrapped = builtins.filter(
      (t) =>
        t.operativeArgs !== undefined &&
        (t.inputSchema as { shape?: unknown }).shape === undefined &&
        shapeOf(t.inputSchema) !== undefined,
    );
    // The wrapped schemas are really in the sweep: SplitFile's is a
    // `.refine`, OraclePriceRead's a `.superRefine`.
    const names = wrapped.map((t) => t.name);
    expect(names).toContain("OraclePriceRead");
    expect(names).toContain("SplitFile");
  });

  test("every optional store or harness directory a tool reads or writes is declared", () => {
    // C004 — a reader that fills its store in `execute` without declaring it
    // let `alwaysDeny *(.crewhaus/state/**)` be dodged by leaving `stateDir`
    // out: KvGet returned the key the deny was meant to keep. Read from the
    // schemas, never a list of tools: any optional field named like a store
    // directory, on any builtin — read-only and internal ones included.
    const STORE =
      /^(dir|stateDir|registryDir|evalsDir|sessionsDir|auditDir|specDir|experimentsDir)$/;
    const undeclared: string[] = [];
    let checked = 0;
    for (const tool of builtins) {
      const shape = shapeOf(tool.inputSchema);
      if (shape === undefined) continue;
      const declared = new Set((tool.operativeArgs ?? []).map((a) => a.field.split(".")[0]));
      for (const [field, schema] of Object.entries(shape)) {
        if (!STORE.test(field) || schema.isOptional?.() !== true) continue;
        checked++;
        if (!declared.has(field)) undeclared.push(`${tool.name}.${field}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(60);
    expect(undeclared.sort()).toEqual([]);
  });

  test("the store directories a tool fills in declare where", () => {
    // Relocating beside a record, or — for a reader that names no record,
    // such as StateExport — the tool's own place, read by every rule.
    const declared = new Map<string, string | undefined>();
    for (const tool of builtins) {
      for (const arg of tool.operativeArgs ?? []) {
        if (arg.default !== undefined) declared.set(`${tool.name}.${arg.field}`, arg.default);
      }
    }
    // The audit's list, each with the place its execute falls back to.
    for (const [field, place] of [
      ["KvSet.stateDir", ".crewhaus/state"],
      ["KvDelete.stateDir", ".crewhaus/state"],
      ["NoteWrite.stateDir", ".crewhaus/state"],
      ["CounterIncrement.stateDir", ".crewhaus/state"],
      ["BlackboardPost.stateDir", ".crewhaus/state"],
      ["JournalAppend.stateDir", ".crewhaus/state"],
      ["CheckpointSave.stateDir", ".crewhaus/state"],
      ["DedupeMark.stateDir", ".crewhaus/state"],
      ["IndexBuild.stateDir", ".crewhaus/state"],
      ["EmitTraceEvent.dir", ".crewhaus/sessions"],
      ["DeployRollback.registryDir", ".crewhaus/specs"],
      ["SpecPin.registryDir", ".crewhaus/specs"],
      ["DatasetPut.registryDir", ".crewhaus/datasets"],
      ["EvalBaselinePin.evalsDir", ".crewhaus/evals"],
      ["ExperimentLedger.experimentsDir", ".crewhaus/experiments"],
      ["GitBranchDelete.cwd", "."],
      ["DependencyAudit.endpoint", "https://api.osv.dev"],
      // The readers beside them (the reviewers' re-attack).
      ["KvGet.stateDir", ".crewhaus/state"],
      ["StateExport.stateDir", ".crewhaus/state"],
      ["EventQuery.dir", ".crewhaus/sessions"],
      ["TraceQuery.dir", ".crewhaus/sessions"],
      ["IncidentBundle.dir", ".crewhaus/sessions"],
      ["AuditVerify.dir", ".crewhaus/audit"],
      ["SpecAdvise.auditDir", ".crewhaus/audit"],
      ["EvalHistory.evalsDir", ".crewhaus/evals"],
      ["DeployInspect.registryDir", ".crewhaus/specs"],
      ["DatasetInspect.registryDir", ".crewhaus/datasets"],
      // The directory a build or test run starts in (0.7.0's
      // `alwaysAllow RunBuild(npm run build)` covers the ordinary call).
      ["RunBuild.cwd", "."],
      ["RunTests.cwd", "."],
    ] as const) {
      expect({ field, place: declared.get(field) }).toEqual({ field, place });
    }
    expect(declared.size).toBeGreaterThanOrEqual(50);
  });

  test("a process tool's working directory only moves the run, so an allow on the command covers the ordinary call", () => {
    // A command's directory is either folded into the command (`within`, as
    // RunCommand declares it) or declared beside it as a relocating field.
    // As a plain default it is one more value every allow must match, and
    // `alwaysAllow RunBuild(npm run build)` never fires on a call that
    // leaves it out. Read from the declarations, never a list of tools.
    const plain: string[] = [];
    let checked = 0;
    for (const tool of builtins) {
      const args = tool.operativeArgs ?? [];
      if (!args.some((a) => a.kind === "command")) continue;
      for (const arg of args) {
        if (arg.field !== "cwd" || arg.default === undefined) continue;
        checked++;
        if (arg.relocates !== true) plain.push(`${tool.name}.${arg.field}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(plain.sort()).toEqual([]);
  });
});

/**
 * Final review (0.7.1): a path naming a directory was one point to a deny
 * and a whole subtree to the tool, so `alwaysDeny RemovePath(src/prod/**)`
 * missed `RemovePath src` and `alwaysDeny Grep(secrets/**)` missed a Grep
 * of the whole workspace. A path field on a tool that walks a directory it
 * is given — reads, lists, writes, moves or deletes what is inside —
 * declares `beneath`, and the runtime reads it with everything under it.
 *
 * Every path field a builtin declares is classified here, so a new one fails
 * until somebody says which it is. A relocating field (a store or the
 * repository the tool works in) is left out only BESIDE a record the call
 * names (KvGet's key): a rule is about that record. Critic8: the exemption
 * used to cover every relocating field, so StateExport — whose `stateDir` is
 * the only place it names, and which dumps every file under it — slipped
 * through, and `{stateDir: "."}` returned secrets/prod.env under
 * `alwaysDeny StateExport(secrets/**)`.
 */
/**
 * `Tool.field` → the harness's own records the tool opens inside the
 * directory the field names, which it declares with `opens`. Critic9: these
 * were classified "fixed files in it" and declared nothing more, so a deny
 * naming the file never fired — PermissionsSuggest mined every session log,
 * and ApprovalStatus read the approvals ledger, under
 * `alwaysDeny *(.crewhaus/sessions/**)`, while EventQuery under the same
 * rule was denied.
 */
const OPENS_ITS_RECORDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "ApprovalsInbox.harnesses": [".crewhaus/sessions/approvals.jsonl"],
  "ApprovalStatus.dir": [".crewhaus/sessions/approvals.jsonl"],
  "EvalHistory.evalsDir": ["index.jsonl", "baselines.json"],
  "HooksManage.dir": [".crewhaus/settings.json"],
  "PermissionsSuggest.dir": [".crewhaus/sessions/**", ".crewhaus/settings.json"],
  "RouteControl.dir": [".crewhaus/routing/**"],
  "WatchmeReport.dir": [".crewhaus/watchme/**", ".crewhaus/routing/arms.jsonl"],
};

/**
 * `Tool.field` → the fixed files the tool opens there, left undeclared and
 * why: project manifests and a harness's own spec, bundle and registry
 * entry, read by name. A deny naming one of them does not fire on these
 * (a 0.7.1 known limitation); a new entry is one more such decision.
 */
const FIXED_FILES_UNDECLARED: Readonly<Record<string, string>> = {
  "BundleFreshness.dirs": "each named harness's spec and bundle",
  "CliVersionPin.dirs": "each named harness's spec, bundle and CLI package.json",
  "DependencyAudit.cwd": "the project's lockfiles",
  "DependencyList.cwd": "the project's manifests and lockfiles",
  "DependencyOutdated.cwd": "the project's manifests and lockfiles",
  "DoctorFix.crewhausDir": "the subdirectories it scaffolds there, by name",
  "EvalAggregate.run": "the run's results.json",
  "FlywheelStatus.specDir": "the harness's spec",
  "HarnessJobStatus.dir": "a filter on the manager's ledger, whose place the operator sets",
  "HarnessRegister.dir": "the harness's spec, and the registry entry it writes",
  "HarnessRegister.from": "the spec it copies",
  "HarnessRetire.registryDir": "the registry entry it removes",
  "LicenseAggregate.directory": "each installed package's package.json",
  "PackagePublishPreflight.directory":
    "the package's package.json, and whether the files it names exist",
  "PackageScripts.cwd": "the manifest and lockfile at or above it",
  "PreflightRun.harnessDir": "the harness's spec and bundle",
  "RegistryOutdated.manifest": "the project's manifest",
};

describe("every path a builtin walks is read with what lies beneath it", () => {
  /** `Tool.field` → why the field names one place, not a tree the tool walks. */
  const ONE_PLACE: Readonly<Record<string, string>> = {
    // A file: a directory there is refused or is an error.
    ...Object.fromEntries(
      [
        "ArchiveCreate.output",
        "ArchiveExtract.archive",
        "BarcodeEncode.path",
        "BundleSizeCheck.baselineFile",
        "BundleSizeCheck.files",
        "ChartRender.path",
        "ChecksumVerify.manifest",
        "ConcatFiles.destination",
        "ConcatFiles.paths",
        // `file` from `cwd`; left out, the report names CoverageSummary knows.
        "CoverageSummary.file",
        "DatabaseBackup.database",
        "DatabaseBackup.out",
        "DatasetLint.leakScanPaths",
        "DatasetLint.path",
        // The samples a new version is copied from.
        "DatasetPut.path",
        "DiagramRender.path",
        "DoctorFix.envPath",
        "DoctorFix.specPath",
        "DocxWrite.path",
        "DownloadFile.path",
        "EInvoiceBuild.outFile",
        "Edit.path",
        // A file sent with the message.
        "EmailSend.attachments.path",
        "EnvFileUpsert.path",
        "EvalCoverage.dataset",
        "ExifStrip.output",
        "ExifStrip.path",
        "ExportCsv.database",
        "ExportCsv.out",
        "ExportJson.database",
        "ExportJson.out",
        "FrontmatterWrite.path",
        "GitBlame.path",
        "GoldenUpdate.golden",
        "IcsWrite.path",
        "ImageCrop.output",
        "ImageCrop.path",
        "ImageResize.output",
        "ImageResize.path",
        "ImportCsv.database",
        "ImportCsv.file",
        "ImportJson.database",
        "ImportJson.file",
        "IncidentBundle.out",
        // The files whose text the index holds; a directory there is skipped.
        "IndexBuild.paths",
        "InvoiceRender.dbPath",
        "InvoiceRender.templateFile",
        "LedgerPost.dbPath",
        "ManifestDependencySet.manifest",
        "MediaProbe.path",
        "MigrationApply.database",
        "MigrationStatus.database",
        "NotebookEdit.path",
        "PackageManifestVerify.paths",
        "PaymentFileBuild.outFile",
        "PdfMerge.inputs.path",
        "PdfMerge.output",
        "PdfSplit.output",
        "PdfSplit.path",
        "PngWrite.path",
        "PrintDocument.path",
        "QrEncode.path",
        "Read.path",
        "SpecAdvise.path",
        "SpecPatchApply.path",
        "SeoLint.file",
        "SpecPin.specFile",
        "SplitFile.path",
        "SqlExec.database",
        "SqlTransaction.database",
        "SubtitleWrite.path",
        "Write.path",
        "XlsxWrite.path",
      ].map((k) => [k, "a file"]),
    ),
    // A directory whose fixed, named files the tool reads or writes. The
    // harness's own records there are declared (`opens`), so a deny naming
    // one fires on the call that reads it; the test below holds that.
    ...Object.fromEntries(Object.keys(OPENS_ITS_RECORDS).map((k) => [k, "fixed files in it"])),
    // Project and fleet files by name, not declared: see FIXED_FILES_UNDECLARED.
    ...Object.fromEntries(
      Object.keys(FIXED_FILES_UNDECLARED).map((k) => [k, "fixed files in it, undeclared"]),
    ),
    // The tool creates this entry, or a named one in it, and touches nothing
    // already beneath it.
    ...Object.fromEntries(
      ["GitWorktreeAdd.path", "MakeDirectory.path", "TempDir.base", "TouchFile.path"].map((k) => [
        k,
        "created",
      ]),
    ),
    // Where git runs. These act on the repository's refs, or on its whole
    // working tree as a commit or a stash names it, which no path argument
    // bounds: gate the tool itself (documented 0.7.1 limit).
    ...Object.fromEntries(
      [
        "GitBranchList.cwd",
        "GitCherryPick.cwd",
        "GitConflicts.cwd",
        "GitMergeBase.cwd",
        "GitRemoteList.cwd",
        "GitRevParse.cwd",
        "GitStashList.cwd",
        "GitStashPop.cwd",
        "GitStatus.cwd",
        "GitTagList.cwd",
        "GitWorktreeList.cwd",
      ].map((k) => [k, "a repository"]),
    ),
  };

  /** Does the tool name a record beside its relocating fields? */
  const namesARecord = (t: RegisteredTool): boolean =>
    (t.operativeArgs ?? []).some((a) => a.relocates !== true);

  /** Every declared path field, but a relocating store or repository beside a record. */
  const pathFields = () =>
    builtins.flatMap((t) =>
      (t.operativeArgs ?? [])
        .filter((a) => a.kind === "path" && !(a.relocates === true && namesARecord(t)))
        .map((a) => ({ key: `${t.name}.${a.field}`, arg: a })),
    );

  /**
   * `Tool.field` → why a relocating store beside a record is not walked: the
   * record the call names decides what the tool reads or writes there. A
   * store the tool reads whole whatever the record says declares `beneath`
   * instead (DatasetMine's sessions and audit directories).
   */
  const RECORD_STORE: Readonly<Record<string, string>> = {
    ...Object.fromEntries(
      [
        "BlackboardPost.stateDir",
        "BlackboardRead.stateDir",
        "CheckpointList.stateDir",
        "CheckpointLoad.stateDir",
        "CheckpointSave.stateDir",
        "CounterGet.stateDir",
        "CounterIncrement.stateDir",
        "DedupeMark.stateDir",
        "IndexBuild.stateDir",
        "IndexSearch.stateDir",
        "JournalAppend.stateDir",
        "JournalRead.stateDir",
        "KvDelete.stateDir",
        "KvGet.stateDir",
        "KvList.stateDir",
        "KvSet.stateDir",
        "NoteWrite.stateDir",
      ].map((k) => [k, "the state record the call names (a left-out name lists them all)"]),
    ),
    ...Object.fromEntries(
      [
        "DatasetInspect.registryDir",
        "DatasetLint.registryDir",
        "DatasetMine.registryDir",
        "DatasetPut.registryDir",
      ].map((k) => [k, "the dataset the call names (a left-out one lists them all)"]),
    ),
    ...Object.fromEntries(
      ["DeployInspect.registryDir", "DeployRollback.registryDir", "SpecPin.registryDir"].map(
        (k) => [k, "the environment the call names"],
      ),
    ),
    "EmitTraceEvent.dir": "the session log the call names",
    ...Object.fromEntries(
      ["EvalAggregate.evalsDir", "EvalBaselinePin.evalsDir", "EvalCoverage.evalsDir"].map((k) => [
        k,
        "the eval index and baselines files, and the run they name",
      ]),
    ),
    ...Object.fromEntries(
      ["ExperimentLedger.dir", "ExperimentLedger.experimentsDir"].map((k) => [
        k,
        "the experiment the call names (a listing reads each ledger's tallies)",
      ]),
    ),
    "FlywheelStatus.dir": "fixed files: the flywheel state and workflow directories",
    ...Object.fromEntries(
      ["GitBranchCreate.cwd", "GitBranchDelete.cwd", "GitSwitch.cwd", "GitTagCreate.cwd"].map(
        (k) => [k, "the ref the call names, in the repository"],
      ),
    ),
    ...Object.fromEntries(
      ["RunBuild.cwd", "RunTests.cwd"].map((k) => [k, "where the command the call names runs"]),
    ),
  };

  test("a relocating field is left out only beside a record the call names", () => {
    const relocating = builtins.flatMap((t) =>
      (t.operativeArgs ?? [])
        .filter((a) => a.kind === "path" && a.relocates === true)
        .map((a) => ({
          key: `${t.name}.${a.field}`,
          beside: namesARecord(t),
          walked: a.beneath !== undefined,
        })),
    );
    // The sweep's hit count: the store tools and the git branch tools.
    expect(relocating.length).toBeGreaterThanOrEqual(40);
    // A store that is the only place its tool names is where the tool acts:
    // buildTool refuses `relocates` there, and this sweep would classify it.
    expect(relocating.filter((r) => !r.beside).map((r) => r.key)).toEqual([]);
    // Beside a record, a store is read whole (beneath) or the record decides
    // what is read in it; a new one fails until somebody says which.
    const walkedStores = relocating.filter((r) => r.walked).map((r) => r.key);
    expect(walkedStores.sort()).toEqual(
      [
        "DatasetMine.auditDir",
        "DatasetMine.sessionsDir",
        "EvalCoverage.sessionsDir",
        "IncidentBundle.dir",
        "SpecAdvise.auditDir",
        "SpecAdvise.sessionsDir",
      ].sort(),
    );
    const unreviewed = relocating
      .filter((r) => !r.walked && RECORD_STORE[r.key] === undefined)
      .map((r) => r.key);
    expect(unreviewed).toEqual([]);
    const known = new Set(relocating.filter((r) => !r.walked).map((r) => r.key));
    expect(Object.keys(RECORD_STORE).filter((k) => !known.has(k))).toEqual([]);
    // The readers that name no record are classified like any other path.
    const keys = new Set(pathFields().map((f) => f.key));
    for (const key of [
      "StateExport.stateDir",
      "NoteSearch.stateDir",
      "EventQuery.dir",
      "TraceQuery.dir",
      "AuditVerify.dir",
      "EvalHistory.evalsDir",
      "ApprovalStatus.dir",
    ]) {
      expect({ key, classified: keys.has(key) }).toEqual({ key, classified: true });
    }
  });

  test("each path field is declared beneath or is a reviewed single place", () => {
    const fields = pathFields();
    // The sweep's hit count, so an empty load cannot pass.
    expect(fields.length).toBeGreaterThanOrEqual(130);
    const walked = fields.filter((f) => f.arg.beneath !== undefined).map((f) => f.key);
    // A pattern stands for every path it lists (`glob`): Glob's, and only it.
    const patterns = fields.filter((f) => f.arg.glob === true).map((f) => f.key);
    expect(patterns).toEqual(["Glob.pattern"]);
    const single = fields
      .filter((f) => f.arg.beneath === undefined && f.arg.glob !== true)
      .map((f) => f.key);
    expect(single.filter((k) => ONE_PLACE[k] === undefined).sort()).toEqual([]);
    // A reviewed entry that now declares beneath, or no longer exists, is stale.
    const known = new Set(fields.map((f) => f.key));
    expect(Object.keys(ONE_PLACE).filter((k) => !known.has(k) || walked.includes(k))).toEqual([]);
    expect(walked.length).toBe(76);
    expect(walked).toContain("Grep.path");
    // Critic8: the store dump and the readers of every log in a directory.
    expect(walked).toContain("StateExport.stateDir");
    expect(walked).toContain("EventQuery.dir");
    // The read-only walkers that declared nothing (0.7.1's known limitation).
    for (const key of ["Tree.path", "FindFiles.path", "DiskUsage.path", "TodoScan.cwd"]) {
      expect(walked).toContain(key);
    }
    expect(walked).toContain("RemovePath.path");
    expect(walked).toContain("GitDiff.paths");
  });

  test("a directory whose own records the tool opens declares each of them (opens)", () => {
    const fields = pathFields();
    const declared = fields
      .filter((f) => f.arg.opens !== undefined)
      .map((f) => [
        f.key,
        (f.arg.opens ?? []).map((o) => (o.beneath !== undefined ? `${o.path}/**` : o.path)),
      ]);
    expect(Object.fromEntries(declared)).toEqual(OPENS_ITS_RECORDS);
    // Each is classified as fixed files in a directory, and not walked whole.
    for (const key of Object.keys(OPENS_ITS_RECORDS)) {
      expect({ key, as: ONE_PLACE[key] }).toEqual({ key, as: "fixed files in it" });
    }
    // The undeclared ones are the reviewed list, and declare nothing.
    const undeclared = Object.entries(ONE_PLACE)
      .filter(([, why]) => why === "fixed files in it, undeclared")
      .map(([k]) => k);
    expect(undeclared.sort()).toEqual(Object.keys(FIXED_FILES_UNDECLARED).sort());
  });

  test("the walks that skip hidden entries are exactly the reviewed ones", () => {
    const visible = pathFields().filter((f) => f.arg.beneath === "visible");
    expect(visible.map((f) => f.key).sort()).toEqual(
      [
        "AstQuery.cwd",
        "DeadFileScan.cwd",
        "FindFiles.path",
        "FindReferences.cwd",
        "Grep.path",
        "ImportGraph.cwd",
        "MarkdownLinkCheck.path",
        "SecretScan.path",
        "SeoLint.corpus",
        "TodoScan.cwd",
        "Tree.path",
        "WorkspacePackages.cwd",
      ].sort(),
    );
    // A call can switch these into hidden names, and is then read as `all`.
    const switched = visible.filter((f) => f.arg.hiddenWhen !== undefined);
    expect(switched.map((f) => `${f.key}:${f.arg.hiddenWhen}`).sort()).toEqual([
      "FindFiles.path:includeHidden",
      "SecretScan.path:includeHidden",
      "Tree.path:includeHidden",
    ]);
  });

  test("a git command given no path is read as the whole repository", () => {
    // Without pathspecs these act on the whole repository wherever they run
    // (the index, every change, the commit's whole patch), so the default
    // they leave out is the workspace root, not the `cwd` they run in.
    const atRoot = pathFields()
      .filter((f) => f.arg.defaultAtRoot === true)
      .map((f) => f.key)
      .sort();
    expect(atRoot).toEqual(
      [
        "DiffLint.paths",
        "GitCommit.paths",
        "GitDiff.paths",
        "GitLog.paths",
        "GitShow.path",
        "GitStashPush.paths",
      ].sort(),
    );
  });
});

/**
 * Critic8: a tool that declares nothing is matched on the text of its call,
 * so a deny on a directory never stopped a Tree, FindFiles or DiskUsage of
 * the whole workspace (0.7.1's known limitation), and a tool that declares
 * some fields but not its directory hides that directory from every rule.
 * Every input field that names a directory — by its name (`cwd`, `dir`,
 * `root`, `directory`, `…Dir`), or a path or file field whose description
 * says it may be one — is declared, as the field or as the `within`
 * directory of one, read from the schemas of every builtin, read-only ones
 * included. The guard above then classifies each as walked or not.
 */
describe("a field that names a directory is a place a rule reads", () => {
  /** `Tool.field` → why the directory is not a place a rule reads. */
  const NOT_A_PLACE: Readonly<Record<string, string>> = {
    "GitWorktreeAdd.cwd":
      "where git runs; the worktree it creates is `path`, read from the workspace root",
    "GitWorktreeRemove.cwd":
      "where git runs; the worktree it removes is `path`, read from the workspace root",
  };
  const NAMES_A_DIRECTORY = /^(cwd|dir|dirs|directory|directories|root|roots|folder|[a-z]+Dirs?)$/;
  const PATH_LIKE = /path|file|source|docs|corpus|target|input|output/i;
  const SAYS_DIRECTORY = /(?<!working )\bdirector(y|ies)\b/i;

  type Described = { description?: string; _def?: Record<string, unknown> };
  /** A field's zod type and description, looking through optional and the like. */
  function leaf(schema: unknown): { typeName?: string; item?: string; description: string } {
    let current = schema as Described | undefined;
    let description = "";
    for (let depth = 0; depth < 16 && current !== undefined; depth++) {
      if (description === "" && typeof current.description === "string") {
        description = current.description;
      }
      const def = current._def ?? {};
      const typeName = def["typeName"] as string | undefined;
      const inner = def["innerType"] ?? def["schema"];
      if (inner !== undefined && typeName !== "ZodArray") {
        current = inner as Described;
        continue;
      }
      const item =
        typeName === "ZodArray"
          ? (((def["type"] as Described | undefined)?._def?.["typeName"] as string) ?? undefined)
          : undefined;
      return {
        ...(typeName !== undefined ? { typeName } : {}),
        ...(item ? { item } : {}),
        description,
      };
    }
    return { description };
  }

  test("each is declared, or is a reviewed exception", () => {
    const found: string[] = [];
    const undeclared: string[] = [];
    for (const tool of builtins) {
      const shape = shapeOf(tool.inputSchema);
      if (shape === undefined) continue;
      const declared = new Set<string>();
      for (const arg of tool.operativeArgs ?? []) {
        declared.add(arg.field.split(".")[0] as string);
        if (arg.within !== undefined) declared.add(arg.within);
      }
      for (const [field, schema] of Object.entries(shape)) {
        const { typeName, item, description } = leaf(schema);
        const holdsText =
          typeName === "ZodString" || (typeName === "ZodArray" && item === "ZodString");
        if (!holdsText) continue;
        const named = NAMES_A_DIRECTORY.test(field);
        const described = PATH_LIKE.test(field) && SAYS_DIRECTORY.test(description);
        if (!named && !described) continue;
        const key = `${tool.name}.${field}`;
        found.push(key);
        if (!declared.has(field)) undeclared.push(key);
      }
    }
    // The sweep's hit count: a scan that could not read the schemas finds nothing.
    expect(found.length).toBeGreaterThanOrEqual(140);
    for (const key of ["Tree.path", "DiskUsage.path", "TodoScan.cwd", "StateExport.stateDir"]) {
      expect(found).toContain(key);
    }
    expect(undeclared.sort()).toEqual(Object.keys(NOT_A_PLACE).sort());
  });
});

/**
 * Critic9: a tool that declares where it acts but not a field naming a file
 * it takes content from hides that file from every rule — a tool that
 * declares some fields does not get the text fallback. IndexBuild's `paths`,
 * DatasetPut's `path` and EmailSend's attachments were read by no rule, so
 * under `alwaysDeny *(secrets/**)` IndexBuild indexed secrets/prod.env,
 * DatasetPut copied it into the registry and EmailSend attached it. The
 * class EnvFileUpsert's `valueFrom` was fixed for in critic8.
 *
 * Every string field, nested ones included, of a builtin that declares
 * operativeArgs, that is named as a path or file (`path`, `paths`, `file`,
 * `…Path`, `…File`) or described as one in the workspace, is declared — as a
 * field, or as the `within` directory of one — or is a reviewed exception.
 */
describe("a field that names a workspace file is a place a rule reads", () => {
  /** `Tool.field` → why the field names no file the tool opens. */
  const NOT_A_FILE: Readonly<Record<string, string>> = {
    "BundleSizeCheck.baseline.entries.path":
      "an artifact's name in a baseline passed inline; it is compared, never opened",
    "EventCounts.where.path": "a dotted path inside an event's payload",
    "EventQuery.where.path": "a dotted path inside an event's payload",
    "GitWorktreeAdd.cwd":
      "where git runs; the worktree it creates is `path`, read from the workspace root",
    "GitWorktreeRemove.cwd":
      "where git runs; the worktree it removes is `path`, read from the workspace root",
    "HttpPaginate.cursorPath": "a dotted path into the response body",
    "HttpPaginate.itemsPath": "a dotted path into the response body",
    "HttpWaitFor.expectJson.path": "a dotted path into the response body",
    "SpecPatchApply.patches.path": "a key chain inside the spec",
    "StateImport.document.files.path":
      "an entry inside stateDir, which is read with everything beneath it",
    "ToolCallStats.where.path": "a dotted path inside an event's payload",
  };
  const NAMES_A_FILE = /^(path|paths|file|files)$|(Path|File|Paths|Files)$/;
  const SAYS_WORKSPACE_FILE =
    /workspace-relative|relative to the working directory|inside the workspace/i;

  type Node = { description?: string; _def?: Record<string, unknown>; shape?: unknown };
  /** Each string leaf under `schema`, by dotted field, with its description. */
  function stringLeaves(schema: unknown, at: string, out: Map<string, string>, depth = 0): void {
    if (depth > 12) return;
    let node = schema as Node | undefined;
    let description = "";
    for (let i = 0; i < 16 && node !== undefined; i++) {
      if (description === "" && typeof node.description === "string") {
        description = node.description;
      }
      const def = node._def ?? {};
      const inner = def["innerType"] ?? def["schema"] ?? def["in"];
      if (inner === undefined) break;
      node = inner as Node;
    }
    const def = node?._def ?? {};
    switch (def["typeName"]) {
      case "ZodString":
        out.set(at, out.get(at) || description);
        return;
      case "ZodArray":
        stringLeaves(def["type"], at, out, depth + 1);
        if (out.has(at) && out.get(at) === "") out.set(at, description);
        return;
      case "ZodUnion":
      case "ZodDiscriminatedUnion":
        for (const option of def["options"] as unknown[]) stringLeaves(option, at, out, depth + 1);
        return;
      case "ZodObject": {
        const shape = (def["shape"] as () => Record<string, unknown>)();
        for (const [key, field] of Object.entries(shape)) {
          stringLeaves(field, at === "" ? key : `${at}.${key}`, out, depth + 1);
        }
        return;
      }
      default:
        return;
    }
  }

  test("each is declared, or is a reviewed exception", () => {
    const found: string[] = [];
    const undeclared: string[] = [];
    let tools = 0;
    for (const tool of builtins) {
      const args = tool.operativeArgs ?? [];
      if (args.length === 0) continue;
      tools++;
      const declared = new Set<string>();
      for (const arg of args) {
        declared.add(arg.field);
        if (arg.within !== undefined) declared.add(arg.within);
      }
      const leaves = new Map<string, string>();
      stringLeaves(tool.inputSchema, "", leaves);
      for (const [field, description] of leaves) {
        const leaf = field.split(".").pop() ?? field;
        if (!NAMES_A_FILE.test(leaf) && !SAYS_WORKSPACE_FILE.test(description)) continue;
        const key = `${tool.name}.${field}`;
        found.push(key);
        if (!declared.has(field)) undeclared.push(key);
      }
    }
    // The sweep's hit counts: a scan that could not read the schemas finds nothing.
    expect(tools).toBeGreaterThanOrEqual(250);
    expect(found.length).toBeGreaterThanOrEqual(150);
    for (const key of [
      "Read.path",
      "IndexBuild.paths",
      "DatasetPut.path",
      "EmailSend.attachments.path",
      "InvoiceRender.templateFile",
      "RunTests.paths",
    ]) {
      expect(found).toContain(key);
    }
    expect(undeclared.sort()).toEqual(Object.keys(NOT_A_FILE).sort());
  });
});

/**
 * Every builtin with a `command` operative argument, and whether a shell
 * parses it. `shell: true` makes a scoped rule read each simple command of
 * the line (an allow must match every one, a deny or ask fires on any), so
 * `alwaysAllow Bash(git *)` does not grant `git status && rm -rf build`. A
 * command held as an argv is handed to its program with no shell and is
 * never split; a deny still reads the line an argv hands to `sh -c`. Adding
 * a tool here is the review step: a new command tool fails until it is
 * listed with the reason it is, or is not, a shell line.
 */
const COMMAND_TOOLS: Readonly<Record<string, string>> = {
  Bash: "shell: `sh -c` runs `command`",
  Shell: "shell: `sh -c` runs `code` in the sandbox",
  Format: "an argv array, spawned with no shell",
  HooksManage: "one program name or an argv array; the supervisor never runs a shell",
  JavaScript: "JavaScript source for `node -e`, not a shell line",
  ProcessStart: "an argv array, spawned with no shell",
  Python: "Python source for `python3 -c`, not a shell line",
  Retry: "an argv array, spawned with no shell",
  RunBuild: "an argv array, spawned with no shell",
  RunCommand: "an argv array, spawned with no shell",
  RunPipeline: "each step an argv array, spawned with no shell",
  RunTests: "an argv array, spawned with no shell",
};

describe("every command a shell parses is read as the commands it runs", () => {
  const commandTools = (): RegisteredTool[] =>
    builtins.filter((t) => (t.operativeArgs ?? []).some((a) => a.kind === "command"));

  test("the builtins with a command argument are exactly the reviewed ones", () => {
    const names = [...new Set(commandTools().map((t) => t.name))].sort();
    expect(names).toEqual(Object.keys(COMMAND_TOOLS).sort());
    expect(names.length).toBe(12);
  });

  test("the shell lines, and only they, are declared shell", () => {
    const declared = [
      ...new Set(
        commandTools()
          .filter((t) => (t.operativeArgs ?? []).some((a) => a.shell === true))
          .map((t) => t.name),
      ),
    ].sort();
    const reviewed = Object.entries(COMMAND_TOOLS)
      .filter(([, why]) => why.startsWith("shell:"))
      .map(([name]) => name)
      .sort();
    expect(declared).toEqual(reviewed);
    expect(declared).toEqual(["Bash", "Shell"]);
  });
});
