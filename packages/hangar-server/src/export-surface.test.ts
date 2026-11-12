/**
 * The package's export surface, pinned as a literal.
 *
 * crewhaus/factory#507's step 03 moves helpers this package owned down into
 * the packages that own their concern, and every moved name stays exported
 * from here for one release. A re-export that is dropped or renamed breaks an
 * importer only when it runs, so the list below was captured from the entry
 * points BEFORE anything moved and is compared with the live module, name for
 * name. A list taken from the tree under test would prove nothing.
 *
 * Values only: `Object.keys` cannot see a type. Every type name `src/index.ts`
 * lists is checked by `tsc -b` instead, which fails if one stops resolving.
 *
 * A moved name must also be the SAME binding as at its new home, never a
 * copy: `server.ts` catches `JobArgumentError` with `instanceof`, and a
 * second copy of any helper is how two readers drift apart. The identity
 * table below holds every value this entry reaches that now lives lower.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as accessControlHome from "@crewhaus/access-control";
import { CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME } from "@crewhaus/gateway-protocol/control";
import * as controlClientHome from "@crewhaus/gateway-protocol/control-client";
import * as supervisorHome from "@crewhaus/harness-supervisor";
import * as jobKindsHome from "@crewhaus/harness-supervisor/job-kinds";
import * as runDetailHome from "@crewhaus/harness-supervisor/run-detail";
import * as authModule from "./auth";
import * as controlClientModule from "./control-client";
import * as credsOpsModule from "./creds-ops";
import * as envFileModule from "./env-file";
import * as entry from "./index";
import * as processModule from "./process";
import * as runsModule from "./runs";
import * as safetyModule from "./safety";
import * as scaffolded from "./scaffolded-workflows";

/** `Object.keys(await import("./index")).sort()`, captured before the move. */
const INDEX_VALUES: readonly string[] = [
  "ACTIVITY_KINDS",
  "BADGE_KEYS",
  "BUNDLE_MANIFEST_NAME",
  "BUNDLE_STAMP_KEY",
  "CONTROL_LANES",
  "CONTROL_LISTENING_RE",
  "DEFAULT_ACTIVITY_WINDOW_MS",
  "DEFAULT_COST_ROLE",
  "DEFAULT_HANGAR_PORT",
  "DEFAULT_QUIET_HOURS",
  "DEFAULT_RULES",
  "DEFAULT_SETTINGS",
  "DEFERRED_EXTENSION_POINTS",
  "DEMOS_DIR_ENV",
  "GUTTER_KINDS",
  "HANGAR_SERVER_VERSION",
  "HEALTH_SCREENS",
  "HEALTH_WEIGHTS",
  "HttpError",
  "INSPECT_STORES",
  "JOB_KINDS",
  "JSON_HEADERS",
  "JobArgumentError",
  "KIND_LABELS",
  "LIVE_FEED_STATES",
  "M3_GROUPS",
  "M3_JOB_ARG_RE",
  "M3_ROUTES",
  "MANAGED_TENANTS_ROOT_DEFAULT",
  "MAX_DEMO_BYTES",
  "MAX_DEMO_FILES",
  "MAX_ENTRIES_PER_HARNESS",
  "MAX_INAPP_DELIVERIES",
  "MAX_JSONL_BYTES",
  "MAX_JSONL_LINES",
  "MAX_MEMORY_ITEMS",
  "MAX_PANE_BYTES",
  "MAX_RAW_LINES",
  "MAX_SESSIONS_INDEXED",
  "MAX_TAIL_LINES",
  "MAX_TEXT_BYTES",
  "MEMORY_AREAS",
  "NOTIFICATION_KINDS",
  "NOTIFICATION_SINKS",
  "NO_PROFILE",
  "OMNI_KINDS",
  "OMNI_LIMIT",
  "OS_NOTIFICATION_TITLE",
  "PANE_SANDBOX",
  "PARAM_GUARDS",
  "PREFLIGHT_BUDGET_ITEM",
  "PROTOCOL_V",
  "READ_ONLY_EXEMPT",
  "REVIEW_VERDICTS",
  "ROUTING_EVENT_KINDS",
  "RUN_ID_RE",
  "SAFE_SEGMENT_RE",
  "SCAFFOLDED_WORKFLOWS",
  "SCAFFOLDED_WORKFLOW_FILENAMES",
  "SCHEDULER_LANES",
  "SESSION_DIR_ENV",
  "SESSION_ID_RE",
  "SETTINGS_FILENAME",
  "SSE_EVENTS",
  "SSE_HEARTBEAT_MS",
  "SSE_IDLE_TIMEOUT_SECONDS",
  "StarterInstallError",
  "TOKEN_FILENAME",
  "WEBHOOK_TIMEOUT_MS",
  "WIRED_EXTENSION_POINTS",
  "WORKFLOWS_DIR_SEGMENTS",
  "actionCliTwins",
  "activityDigest",
  "adjudicateReview",
  "approvalsInbox",
  "buildHarnessEntries",
  "buildLeaderboard",
  "buildSchedulersView",
  "bundleFreshness",
  "cadenceToMs",
  "capabilityBadges",
  "classifyExtensionPoints",
  "collectEnvRefs",
  "computeHealth",
  "computeRollup",
  "computeRollupDigest",
  "createControlClient",
  "createNotificationCentre",
  "createOmniIndex",
  "createProcessLayer",
  "currentBaselines",
  "declaredBudgetUsd",
  "declaredCadences",
  "defaultNotificationSinks",
  "defaultPluginsDir",
  "demoAvailability",
  "deploymentsView",
  "deriveEvents",
  "dirExists",
  "dreamOverdue",
  "dreamStates",
  "dreamView",
  "ensureToken",
  "errResponse",
  "evalHealth",
  "evalRunView",
  "evalSampleView",
  "evalsView",
  "evaluateNotifications",
  "factsView",
  "feedbackRecord",
  "foldApprovals",
  "foldFactsFile",
  "foldHarnessCosts",
  "foldRouteStats",
  "harnessActivity",
  "harnessIndexToken",
  "harnessScrubber",
  "hashSpecSource",
  "inQuietHours",
  "installStarter",
  "isApprovalId",
  "isAuthorized",
  "isControlLane",
  "isDryRun",
  "isInspectStore",
  "isJobKind",
  "isLiveFeedState",
  "isMemoryArea",
  "isProofRunId",
  "isProofSpecDir",
  "isReadOnlyRefused",
  "isReviewVerdict",
  "isRunId",
  "isSafePathSegment",
  "isScaffoldedWorkflow",
  "isSessionId",
  "isSupervisorRunId",
  "jobArg",
  "jobArgv",
  "json",
  "knownControlPort",
  "listSessions",
  "logLine",
  "makeFixtureHarness",
  "maskDeep",
  "maskSpecYaml",
  "matchActions",
  "matchM3",
  "mergedSpawnEnv",
  "normalizeQuietHours",
  "normalizeRules",
  "normalizeWebhookUrl",
  "notImplemented",
  "onboardingView",
  "openRollupCache",
  "openSettingsStore",
  "osNotifierArgv",
  "panePolicy",
  "panesForHarness",
  "paramOk",
  "parseControlPort",
  "parseEnvText",
  "parseSince",
  "pendingApprovalCount",
  "pinBaseline",
  "pinSession",
  "pluginMayFetch",
  "pluginSeesHarness",
  "proofCliTwin",
  "proofTenants",
  "proofView",
  "rankEntries",
  "readArms",
  "readHarnessEnvFiles",
  "readJsonlCapped",
  "readModelRegistry",
  "readOnlyRefusal",
  "readPaneDecls",
  "readPaneDocument",
  "readPinServeStates",
  "readPins",
  "readPluginInventory",
  "readPoolView",
  "readPoolViews",
  "readRouteTimeline",
  "readSpecYaml",
  "readTextCapped",
  "readTranscript",
  "readTranscriptRaw",
  "requireBoolean",
  "requireString",
  "requireTypedConfirm",
  "resolveApproval",
  "resolveContained",
  "resolveInside",
  "resolveSessionRoot",
  "reviewInbox",
  "rosterModels",
  "rosterSunsets",
  "runDetail",
  "runEventStream",
  "runLogFile",
  "runsView",
  "scaffoldedWorkflowPath",
  "scoreMatch",
  "spawnEnvScrubber",
  "specView",
  "splitModelString",
  "startHangarServer",
  "stateView",
  "suggestScanRoots",
  "toastBody",
  "tokenEquals",
  "traceObservers",
  "watchmeView",
  "webhookPayload",
  "wikiArticle",
  "wikiView",
];

/**
 * Values added since, each on purpose: signing in (the choke point's adapter, the Host
 * allowlist, the page policy, the sockets and the sign-in routes) and the owner's
 * settings blocks.
 */
const SIGN_IN_VALUES: readonly string[] = [
  "HOME_CSP",
  "HOME_SOCKET",
  "MISDIRECTED_TEXT",
  "PROXY_SOCKET",
  "SIGN_IN_ROUTES",
  "allowedHosts",
  "checkAccess",
  "hostAllowed",
  "hostNameOf",
  "isLoopbackHostname",
  "isV1Path",
  "misdirected",
  "refusalResponse",
  "serveSignIn",
];

/** `Object.keys(await import("./scaffolded-workflows")).sort()`, captured
 *  before the move. The CLI imports this subpath for its workflow names. */
const SCAFFOLDED_VALUES: readonly string[] = [
  "SCAFFOLDED_WORKFLOWS",
  "SCAFFOLDED_WORKFLOW_FILENAMES",
  "WORKFLOWS_DIR_SEGMENTS",
  "isScaffoldedWorkflow",
  "scaffoldedWorkflowPath",
];

describe("the export surface", () => {
  test("the root entry exports exactly the values it exported before the move, and the ones added since", () => {
    // The count first, so a failure says how far off the surface is before
    // the diff says where.
    expect(INDEX_VALUES).toHaveLength(219);
    expect(SIGN_IN_VALUES).toHaveLength(14);
    const live = Object.keys(entry).sort();
    expect(live).toHaveLength(219 + 14);
    expect(live).toEqual([...INDEX_VALUES, ...SIGN_IN_VALUES].sort());
  });

  test("./scaffolded-workflows exports exactly its five values", () => {
    expect(SCAFFOLDED_VALUES).toHaveLength(5);
    const live = Object.keys(scaffolded).sort();
    expect(live).toHaveLength(5);
    expect(live).toEqual([...SCAFFOLDED_VALUES]);
  });
});

type Namespace = Readonly<Record<string, unknown>>;

/**
 * Every value `./index` reaches that now lives in a lower package, with that
 * home. `parseEnvText` already lived in harness-supervisor before the move.
 */
const MOVED: ReadonlyArray<readonly [name: string, home: Namespace]> = [
  ["createControlClient", controlClientHome],
  ["isControlLane", controlClientHome],
  ["knownControlPort", controlClientHome],
  ["parseControlPort", controlClientHome],
  ["CONTROL_LANES", controlClientHome],
  ["CONTROL_LISTENING_RE", controlClientHome],
  ["mergedSpawnEnv", supervisorHome],
  ["readHarnessEnvFiles", supervisorHome],
  ["parseEnvText", supervisorHome],
  ["harnessScrubber", supervisorHome],
  ["spawnEnvScrubber", supervisorHome],
  ["isSupervisorRunId", runDetailHome],
  ["runsView", runDetailHome],
  ["runLogFile", runDetailHome],
  ["isSafePathSegment", supervisorHome],
  ["resolveContained", supervisorHome],
  ["resolveInside", supervisorHome],
  ["jobArgv", jobKindsHome],
  ["isJobKind", jobKindsHome],
  ["JOB_KINDS", jobKindsHome],
  ["JobArgumentError", jobKindsHome],
  // Home's own key moved to the package that decides who signs in.
  ["ensureToken", accessControlHome],
  ["tokenEquals", accessControlHome],
  ["TOKEN_FILENAME", accessControlHome],
  ["SETTINGS_FILENAME", accessControlHome],
  ["HOME_SOCKET", accessControlHome],
  ["PROXY_SOCKET", accessControlHome],
];

/** The same, module by module: the re-export modules keep every value they
 *  defined, and the modules that keep code re-export the rest. */
const MODULE_MOVES: ReadonlyArray<
  readonly [module: string, ns: Namespace, name: string, home: Namespace]
> = [
  ["control-client", controlClientModule, "DEFAULT_CONTROL_TIMEOUT_MS", controlClientHome],
  ["runs", runsModule, "MAX_LEDGER_ROWS", runDetailHome],
  ["creds-ops", credsOpsModule, "ENV_KEY_RE", supervisorHome],
  ["auth", authModule, "createBootTickets", accessControlHome],
  ["auth", authModule, "BOOT_TICKET_TTL_MS", accessControlHome],
];

/** Pure re-export modules: exactly the values each defined before the move. */
const REEXPORT_MODULES: ReadonlyArray<
  readonly [module: string, ns: Namespace, values: readonly string[]]
> = [
  [
    "control-client",
    controlClientModule,
    [
      "CONTROL_LANES",
      "CONTROL_LISTENING_RE",
      "DEFAULT_CONTROL_TIMEOUT_MS",
      "createControlClient",
      "isControlLane",
      "knownControlPort",
      "parseControlPort",
    ],
  ],
  ["env-file", envFileModule, ["mergedSpawnEnv", "parseEnvText", "readHarnessEnvFiles"]],
  ["safety", safetyModule, ["isSafePathSegment", "resolveContained", "resolveInside"]],
];

describe("moved names are re-exported, not copied", () => {
  test("each of the 27 is the same binding as at its new home", () => {
    expect(MOVED).toHaveLength(27);
    for (const [name, home] of MOVED) {
      // The name must exist at the home: two undefineds would compare equal.
      expect(`${name}:${home[name] !== undefined}`).toBe(`${name}:true`);
      expect(`${name}:${(entry as Namespace)[name] === home[name]}`).toBe(`${name}:true`);
    }
  });

  test("the module-level re-exports are the same bindings too", () => {
    for (const [module, ns, name, home] of MODULE_MOVES) {
      expect(`${module}.${name}:${home[name] !== undefined}`).toBe(`${module}.${name}:true`);
      expect(`${module}.${name}:${ns[name] === home[name]}`).toBe(`${module}.${name}:true`);
    }
    // The process layer re-exports the job vocabulary it used to define.
    for (const name of ["jobArgv", "isJobKind", "JOB_KINDS", "JobArgumentError"]) {
      expect(
        `process.${name}:${(processModule as Namespace)[name] === (jobKindsHome as Namespace)[name]}`,
      ).toBe(`process.${name}:true`);
    }
  });

  test("the re-export modules keep exactly the values they defined", () => {
    for (const [module, ns, values] of REEXPORT_MODULES) {
      expect(`${module}:${JSON.stringify(Object.keys(ns).sort())}`).toBe(
        `${module}:${JSON.stringify(values)}`,
      );
    }
  });

  test("a job-argument refusal thrown below is still caught by the class the server checks", () => {
    let caught: unknown;
    try {
      jobKindsHome.jobArgv("eval", { dataset: "../outside" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(entry.JobArgumentError);
    expect(caught).toBeInstanceOf(processModule.JobArgumentError);
  });

  test("the control client reads the token from the path the supervisor records", () => {
    // The client builds the path from the protocol's own constants (the ones
    // the daemon writes it with); the supervisor's `controlTokenPath` is what
    // a runfile records. If they ever diverge, every wake and drain answers
    // `no_control_token` against a daemon that minted one.
    const dir = join("some", "harness");
    expect(join(dir, CONTROL_RUN_DIR, CONTROL_TOKEN_FILENAME)).toBe(
      supervisorHome.controlTokenPath(dir),
    );
  });
});
