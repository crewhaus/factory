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
      const fields = Object.keys(
        ((tool.inputSchema as { shape?: Record<string, unknown> }).shape ?? {}) as object,
      );
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
  "BarcodeEncode.path": "only a PNG is written; an SVG comes back inline and nothing is written",
  "ChartRender.path": "the SVG comes back inline; nothing is written",
  "ChatPost.channel":
    "required in API mode; an incoming webhook posts to the channel the operator bound it to",
  "ChatUpdate.channel":
    "required in API mode; an incoming webhook posts to the channel the operator bound it to",
  "CliVersionPin.dirs":
    "the harnesses in this machine's registry, which the operator keeps; it writes nothing",
  "CronDelete.fingerprint": "a guard on the entry id or match names, never a target of its own",
  "CronDelete.id": "the schema requires id or match; whichever is given is read",
  "CronDelete.match": "the schema requires id or match; whichever is given is read",
  "DiagramRender.path": "the SVG comes back inline; nothing is written",
  "EInvoiceBuild.outFile": "the document comes back inline; nothing is written",
  "EmailSend.bcc.address": "no Bcc recipients; nothing is sent without one recipient somewhere",
  "EmailSend.cc.address": "no Cc recipients; nothing is sent without one recipient somewhere",
  "EmailSend.to.address": "no To recipients; nothing is sent without one recipient somewhere",
  "EmitTraceEvent.sessionId":
    "the session this call runs in, from the run context; its directory declares a default",
  "Erc721TokenInfo.ipfsGateway": "ipfs URIs are skipped; nothing is fetched through a gateway",
  "EvmRpcHealth.compareWith": "nothing to compare with; only the main endpoint is probed",
  "ExperimentLedger.name":
    "only `list` omits it, and it names every experiment; the directories declare defaults",
  "FeedParse.url": "the feed is passed inline; nothing is fetched",
  "Format.command":
    "the formatter the project declares, detected at run time; the paths it formats declare a default",
  "HarnessRegister.dir":
    "register and relocate refuse without it; the registry file is fixed, never a caller's path",
  "HarnessRegister.from": "the entry is named by id instead; list names none",
  "HarnessRegister.id": "the entry is named by from instead; list names none",
  "HooksManage.command": "only `set` carries a command, and refuses without one",
  "ImportJson.file": "the records are passed inline; nothing is read from disk",
  "InvoiceRender.outDir": "the rendered text comes back inline; nothing is written",
  "PackageManifestVerify.manifests.text": "the manifests are read from paths instead",
  "PackageManifestVerify.paths": "the manifests are passed inline, as manifests.text",
  "PaymentFileBuild.outFile": "the file comes back inline; nothing is written",
  "PortfolioValuation.wallet": "the amounts are passed inline; no balance is read",
  "QrEncode.path": "only a PNG is written; an SVG comes back inline and nothing is written",
  "RunBuild.command":
    "the build the project declares, detected at run time; its directory declares a default",
  "RunTests.command":
    "the test command the project declares, detected at run time; its directory declares a default",
  "SitemapParse.url": "the sitemap is passed inline; nothing is fetched",
  "SpecPatchApply.path":
    "the spec is passed inline and patched text comes back; nothing is written",
  "SpecPin.env": "the version is registered and no pin moves",
  "StatusPagePost.incidentId": "a new incident on the operator's configured status page",
  "SubtitleWrite.path": "the document comes back inline; nothing is written",
  "TlsInspect.servername": "the host, which is declared, is the name sent",
  "WebhookPost.url":
    "the URL is read from an operator-listed environment variable named in urlEnv; a deny on every call still reads the call's strings",
};

describe("an optional operative field says what leaving it out means (C004)", () => {
  /** `Tool.field` for every declared field the schema lets a call leave out, with no default. */
  function optionalWithoutDefault(): string[] {
    const out: string[] = [];
    for (const tool of builtins) {
      const shape = (tool.inputSchema as { shape?: Record<string, { isOptional?: () => boolean }> })
        .shape;
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
    expect(found.length).toBeGreaterThanOrEqual(30);
    expect(found).toEqual(Object.keys(OMITTED_MEANS).sort());
  });

  test("the store directories a tool fills in declare where", () => {
    const declared = new Map<string, string | undefined>();
    for (const tool of builtins) {
      for (const arg of tool.operativeArgs ?? []) {
        if (arg.relocates === true) declared.set(`${tool.name}.${arg.field}`, arg.default);
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
    ] as const) {
      expect({ field, place: declared.get(field) }).toEqual({ field, place });
    }
    expect(declared.size).toBeGreaterThanOrEqual(20);
  });
});
