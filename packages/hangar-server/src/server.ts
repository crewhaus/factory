/**
 * `startHangarServer` — the manager server: one `Bun.serve` on loopback over
 * the machine-wide harness registry.
 *
 * M1 was read-only over harness state (registry CRUD was the only write).
 * M2 makes it a DRIVER, and every new surface is a composition of a layer
 * that already exists rather than a second implementation of it:
 *
 *   - process control ⇒ `@crewhaus/harness-supervisor` through `process.ts`
 *     (one supervisor per harness; preflight gates every spawn);
 *   - wake/drain/status ⇒ `crewhaus.control.v1` through `control-client.ts`
 *     (the bearer is read server-side and NEVER returned to the client);
 *   - approvals ⇒ `@crewhaus/session-store`'s `PendingApprovalStore`;
 *   - review ⇒ `@crewhaus/feedback-distill`'s review queue + the same
 *     adjudicating `FeedbackRecord` path `crewhaus rate --adjudicate` uses;
 *   - baselines ⇒ `@crewhaus/eval-report`'s `setBaseline`.
 *
 * Safety model enforced here:
 *   - HOST: before anything but `/healthz`, a `Host` this Home does not know
 *     answers 421 (`host-allowlist.ts`), so a page that rebinds its own name
 *     to loopback is turned away before it can spend a boot link.
 *   - AUTH: every `/api` route passes `authenticate()` from
 *     `@crewhaus/access-control` at one place (`access.ts`), then matches exactly
 *     one route-table row (none answers 404, for everyone) and is authorized for
 *     that row's permission, on the harness its `:id` names, before any handler
 *     runs. A member, a service token, a scoped token and a tab-only session act
 *     within what they hold; fleet folds count and quote only the harnesses the
 *     caller may read. A browser holds
 *     a session sealed to it, signed in through a single-use boot link or its
 *     own device key (`sign-in-routes.ts`); Home's own key (the bootstrap,
 *     `<hangarRoot>/token`) is the owner only on `<hangarRoot>/home.sock` or
 *     from a direct loopback peer with no forwarding headers, and never
 *     reaches a browser. `/healthz`, the static UI shell and the sign-in
 *     routes are the only unauthenticated surfaces. No cookies anywhere ⇒ no
 *     CSRF surface. Every page carries a strict Content-Security-Policy
 *     (`csp.ts`). `noAuth` disables the check with a logged warning, for
 *     trusted localhost dev only.
 *   - PATH SAFETY: `:id` params must match their format regexes before any
 *     filesystem work, and every harness-relative read realpath-contains
 *     inside that harness's registered dir (the registry is the allowlist).
 *     Arbitrary absolute dirs enter ONLY via `POST /api/harnesses` bodies.
 *   - READS NEVER MUTATE: session browsing is raw dir scans + tolerant
 *     JSONL parsing (never `SessionStore.list()`, whose TTL eviction
 *     deletes transcripts); memory views are fold-only. The approvals inbox
 *     folds `approvals.jsonl` with the store's own fold, which writes
 *     nothing: a polled inbox must not rewrite a ledger.
 *   - CREDENTIALS NEVER RENDER: env routes return KEY presence booleans;
 *     spec/transcript routes pass the spec-patch maskers; captured daemon
 *     output is served only through the supervisor's scrubbed paths, never
 *     by reading `logs/<runId>.log` (raw, unscrubbed by construction).
 *
 * M3 is the detail surface — the spec's write side, the memory fabric's
 * write side, the eval/dataset/feedback loops, credentials + channels +
 * security, Thredz, and the raw inspectors. It is far too many routes to
 * hand-branch, so it dispatches from ONE table (`m3-routes.ts`) through one
 * function (`runM3` below) that applies every guard above uniformly; the
 * per-area handler modules receive an already-validated `M3Context` and can
 * only be about their own subject. The handlers ship as 501 stubs whose
 * docblocks carry the write covenant each must honour.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname as osHostname, uptime, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  type AccessSnapshotRead,
  type Authenticated,
  type DomainChecker,
  type Peer,
  type SignInHandle,
  type TokenSetup,
  ensureToken,
  loadAccessSnapshot,
  localActorOf,
  noAuthRefusal,
  openDeviceRequests,
  openSignIn,
  queuedActorHolds,
  readOwnerSettings,
} from "@crewhaus/access-control";
import { DEPLOYMENT_ID_RE, PROTOCOL_ID, parseRef } from "@crewhaus/control-contract";
import {
  AREA_RUNTIMES,
  type RecoverCounts,
  activateDeployment,
  activationGates,
  currentLocalIdentity,
  isServiceActor,
  wireControl,
  withOwnStartTime,
} from "@crewhaus/control-service";
import { readRunIndex } from "@crewhaus/eval-report";
import {
  type BuildInventoryDeps,
  buildHarnessHealth,
  buildHarnessInventory,
  countOpenIncidents,
  discoverHarnesses,
  readSpecHeader,
} from "@crewhaus/harness-inventory";
import {
  HARNESS_ID_RE,
  type HangarHarnessEntry,
  type HangarRegistry,
  openHangarRegistry,
  runsOwnCode,
} from "@crewhaus/harness-registry";
import {
  type GateDecision,
  type RunfileObservation,
  SpawnPlanError,
  type StartResult,
  type StopResult,
  cliTwin,
  createProcessOps,
  isUnforceable,
  observeRunfile,
  readRunfile,
  resolveBundle,
  runClassFor,
  runfileExists,
  shellQuote,
} from "@crewhaus/harness-supervisor";
import { runPreflight } from "@crewhaus/preflight";
import {
  type AccessView,
  type Caller,
  type HomeAccess,
  type RequestAccess,
  TAB_ONLY_MESSAGE,
  authorizeCaller,
  authorizeRequest,
  bootstrapKeyMismatch,
  callerOf,
  checkAccess,
  contentVisibleToRequest,
  currentRequestAccess,
  harnessTarget,
  isOwnerCaller,
  permissionRefusal,
  refusalOf,
  refusalResponse,
  registerHomeDomain,
  requestAccessFor,
  requestAllows,
  systemAccess,
  visibleToRequest,
  withRequestAccess,
  withholdPeople,
} from "./access";
import { currentBaselines, pinBaseline, pinSession, readPins } from "./actions";
import {
  type ActivityHarness,
  DEFAULT_ACTIVITY_WINDOW_MS,
  activityDigest,
  parseSince,
  recoveryItems,
} from "./activity";
import {
  type ApprovalHarness,
  approvalsInbox,
  isApprovalId,
  pendingApprovalCount,
  refusedDecisionMessage,
  resolveApproval,
} from "./approvals";
import { bundleFreshness } from "./bundle-freshness";
import {
  DEFAULT_HANGAR_PORT,
  HANGAR_SERVER_VERSION,
  PROTOCOL_V,
  SAFE_SEGMENT_RE,
  SSE_IDLE_TIMEOUT_SECONDS,
} from "./constants";
import {
  type ControlClient,
  type ControlRefusal,
  type ControlResult,
  createControlClient,
  isControlLane,
  knownControlPort,
} from "./control-client";
import { foldHarnessCosts } from "./costs";
import { SHELL_HEADERS } from "./csp";
import { deploymentsView } from "./deployments";
import { mergedSpawnEnv } from "./env-file";
import { evalJobOptions, launchOffers } from "./eval-inputs";
import {
  type EvalHealth,
  evalHealth,
  evalHealthyFlag,
  evalRunView,
  evalSampleView,
  evalsView,
  isRunId,
} from "./evals";
import {
  GROUP_VERBS,
  type GroupPlan,
  type GroupPlanMember,
  groupPlan,
  isGroupVerb,
  runGroup,
} from "./group-ops";
import { harnessPathOf, isWithin, realOr } from "./harness-paths";
import {
  type HealthPreflightItem,
  type HealthResult,
  cadenceToMs,
  computeHealth,
  declaredBudgetUsd,
  dreamOverdue,
} from "./health";
import { allowedHosts, hostAllowed, misdirected } from "./host-allowlist";
import { HttpError, errResponse, json } from "./http";
import { createIngress } from "./ingress";
import {
  HOME_SOCKET,
  PROXY_SOCKET,
  bindSocket,
  isLoopbackHostname,
  isWildcardHostname,
  socketPath as socketPathOf,
  socketsSupported,
  unlinkSocket,
} from "./listeners";
import { type M3Context, type M3Harness, requireBoolean, requireString } from "./m3";
import { type M3Match, matchM3 } from "./m3-routes";
import { type TextScrubber, maskDeep } from "./mask";
import {
  dreamView,
  factsView,
  isMemoryArea,
  stateView,
  watchmeView,
  wikiArticle,
  wikiView,
} from "./memory";
import {
  type Delivery,
  type HarnessSignal,
  MAX_INAPP_DELIVERIES,
  type NotificationCentre,
  type NotificationSinks,
  type SuppressedEvent,
  createNotificationCentre,
  defaultNotificationSinks,
  deriveEvents,
} from "./notifications";
import { OMNI_LIMIT, type OmniIndex, createOmniIndex } from "./omnibox";
import {
  DEMOS_DIR_ENV,
  REGISTRY_MANAGE,
  StarterInstallError,
  demoAvailability,
  gateOnboarding,
  gateScanRoots,
  installStarter,
  suggestScanRoots,
} from "./onboarding";
import {
  defaultPluginsDir,
  panesForHarness,
  readPaneDocument,
  readPluginInventory,
  traceObservers,
} from "./plugins";
import {
  type HarnessProcess,
  JobArgumentError,
  JobRefusedError,
  type ProcessLayer,
  createProcessLayer,
  isJobKind,
  jobArgv,
} from "./process";
import { isProofRunId, proofTenants, proofView } from "./proofs";
import {
  type HomeMode,
  type RecoveryReport,
  readRecoveryReport,
  restartAfterReboot,
  writeRecoveryReport,
} from "./reboot-recovery";
import { commandFields, createReceipts, currentCommand } from "./receipts";
import { type ReviewHarness, adjudicateReview, isReviewVerdict, reviewInbox } from "./review";
import { type HarnessRollup, openRollupCache } from "./rollups";
import { type RequestMatch, matchRequest } from "./route-match";
import type { RouteRow } from "./route-table";
import {
  isLiveFeedState,
  isSupervisorRunId,
  runDetail,
  runEventStream,
  runsView,
  safeSpawnEnvScrubber,
} from "./runs";
import { resolveInside } from "./safety";
import { type SchedulerTimers, type TickReport, createSchedulerHost } from "./scheduler-host";
import { buildSchedulersView, declaredCadences, dreamStates, readSpecYaml } from "./schedulers";
import {
  isSessionId,
  listSessions,
  readTranscript,
  readTranscriptRaw,
  resolveSessionRoot,
} from "./sessions";
import {
  type SettingsStore,
  isReadOnlyRefused,
  openSettingsStore,
  readOnlyExempt,
  readOnlyRefusal,
} from "./settings";
import { SIGN_IN_ROUTES, isSignInPath, serveSignIn } from "./sign-in-routes";
import { BADGE_KEYS, capabilityBadges, specView } from "./spec-view";
import { assetResponse } from "./static-cache";
import type { HomePorts } from "./sweeps";
import {
  HOME_AREAS,
  type HomeAreaRuntime,
  V1_NOT_SERVED,
  homeCompositionProblems,
  receiversOf,
  sweepsOf,
} from "./v1/areas";
import { createV1Router, daemonStateOf } from "./v1/router";

export type StaticAsset = {
  readonly body: string | Uint8Array;
  readonly contentType: string;
};

export type HangarServerOptions = {
  /** TCP port; default {@link DEFAULT_HANGAR_PORT}; 0 = OS-assigned. */
  readonly port?: number;
  /** Bind host; default `127.0.0.1` (loopback-only is the M1 posture). */
  readonly hostname?: string;
  /** Hangar root (token + rollup cache); default `~/.crewhaus/hangar`. */
  readonly root?: string;
  /** Registry root passed to `openHangarRegistry` (the DIRECTORY holding
   *  `harnesses.json`); default `CREWHAUS_REGISTRY_ROOT` or `~/.crewhaus`. */
  readonly registryRoot?: string;
  /** More names this Home answers to (`--allow-host`), beside the ones it always does. */
  readonly allowHosts?: readonly string[];
  /** Disable auth entirely (logged warning; trusted localhost dev only). */
  readonly noAuth?: boolean;
  /**
   * The address `--lan` bound: invites accepted on a page served over plain HTTP make a
   * tab-only session that counts only on this address. Absent, no tab-only session is made.
   */
  readonly lanHost?: string;
  /**
   * Domain checkers for Home's domain table, by domain name: a permission `<name>.…` goes
   * to its checker, with the route's object ref. Registered under the domain rules; a
   * broken one refuses boot.
   */
  readonly domains?: Readonly<Record<string, DomainChecker>>;
  /** Prebuilt UI assets served at `/` and exact asset paths. Absent → a
   *  minimal built-in index page listing the API routes. */
  readonly assets?: Readonly<Record<string, StaticAsset>>;
  /** Base environment; defaults to `process.env`. Harness `.env` files are
   *  layered ON TOP of this for preflight/env-presence evaluation. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms); injected so tests are deterministic. */
  readonly now?: () => number;
  /** Warning sink; defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
  /** Version string for `/api/version`; default the package version. */
  readonly version?: string;
  /** The M2 process layer. Supply one (built with injected `ProcessOps` +
   *  clock) to drive supervision in tests without spawning anything;
   *  omitted, the server builds a real one. */
  readonly processLayer?: ProcessLayer;
  /** The argv that runs this Home's own `crewhaus`, for the process layer the server builds
   *  (`ProcessLayerOptions.homeCrewhaus`). */
  readonly homeCrewhaus?: readonly string[];
  /** control.v1 client; injected in tests to point at a stub daemon. */
  readonly controlClient?: ControlClient;
  /** Identity recorded on approvals/review decisions made through the API. */
  readonly operator?: string;
  /** Keep-alive cadence for live run streams; default
   *  {@link SSE_HEARTBEAT_MS}. Tests shorten it to prove the frame exists
   *  without waiting out the real interval. */
  readonly sseHeartbeatMs?: number;
  /** M4 (HM-187): start in read-only mode. Persisted settings still apply —
   *  this only forces the mode ON at boot. */
  readonly readOnly?: boolean;
  /** M4 (HM-187): refuse the un-toggle too, so a screen-shared manager
   *  cannot be made writable over the wire. Implies `readOnly`. */
  readonly readOnlyLocked?: boolean;
  /** M4 (HM-12): the demos checkout demo mode copies starters from.
   *  Defaults to `CREWHAUS_DEMOS_DIR` in `env`. */
  readonly demosDir?: string;
  /** M4 (HM-12): the directory shown as "where you started the manager" in
   *  the scan-root picker. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** M4 (HM-179): installed-plugin root; default `~/.crewhaus/plugins`. */
  readonly pluginsDir?: string;
  /** M4 (HM-183): notification sinks. Defaults to the REAL ones
   *  ({@link defaultNotificationSinks}: an argv-vector OS notifier and a
   *  `fetch` webhook POST); overridden in tests so the suite neither spawns
   *  `osascript` nor opens a socket. */
  readonly notificationSinks?: NotificationSinks;
  /**
   * Home in a window (`foreground`, the default) or as the installed service
   * (`resident`, `crewhaus hangar serve --resident`). Only the service starts again,
   * after the machine starts, the harnesses a person last started.
   */
  readonly mode?: HomeMode;
  /** Whether the service is installed on this computer; the CLI knows, the server asks. */
  readonly residentUnit?: () => "absent" | "installed";
  /**
   * A second loopback listener for the receivers the composition holds (`/hooks/…`). It
   * binds only when this is set and at least one receiver is composed.
   */
  readonly ingress?: { readonly port: number };
  /** The areas Home composes: its sweeps and receivers. Defaults to the shipped ones. */
  readonly areas?: readonly HomeAreaRuntime[];
  /** The timers Home's tick arms; injected in tests, which drive `scheduler.tick()`. */
  readonly schedulerTimers?: SchedulerTimers;
  /** When the machine last booted, epoch ms; injected in tests. */
  readonly hostBootedAt?: () => number;
};

export type HangarServer = {
  readonly url: string;
  /** `http://127.0.0.1:<port>` when Home is bound beyond loopback and also answers there:
   *  the address a browser on this computer signs in from. */
  readonly loopbackUrl?: string;
  /** `<hangarRoot>/home.sock`, when Home listens on it (never on Windows). */
  readonly socketPath?: string;
  readonly port: number;
  readonly hostname: string;
  readonly hangarRoot: string;
  readonly registryPath: string;
  /** Home's own key, as read at boot; undefined when `noAuth` is set. It
   *  stays in this process and its file: no route ever sends it. */
  readonly token?: string;
  /** Where Home's own key lives (`<hangarRoot>/token`). */
  readonly tokenPath?: string;
  /** A single-use `/boot/<nonce>` path that redirects to a one-time sign-in
   *  code. The launcher opens THIS, so nothing secret enters a command line.
   *  Undefined when `noAuth` is set (there is nothing to hand over). */
  readonly bootPath?: string;
  readonly noAuth: boolean;
  /** The socket idle timeout this server bound with, in seconds. Exposed
   *  because it is a CORRECTNESS setting for the live run console, not a
   *  tuning knob: Bun's 10 s default severs any SSE stream whose daemon has
   *  been quiet for that long. */
  readonly idleTimeoutSeconds: number;
  /** The process layer this server drives — exposed so `crewhaus hangar`
   *  can shut supervision down cleanly and so tests can assert on it. */
  readonly processes: ProcessLayer;
  /** True while read-only mode refuses mutating requests (HM-187). */
  readOnly(): boolean;
  /** Run the session check now: every live run stream whose session has
   *  expired or ended closes with `auth.expired` or `auth.revoked`, and, when
   *  the access records have moved, every stream whose caller has lost
   *  access to it closes with `revoked`. Home runs it every 30 seconds on its own. */
  checkSessions(): void;
  /** How many open run streams each session check authorizes again. A stream's check
   *  ends with the stream, whatever closed it. */
  openStreamChecks(): number;
  /**
   * Resolves once the boot sequence has run: port ledger open → `adopt()`
   * per registered harness → `jobQueue.restore()` → command recovery → (the
   * installed service only) the restarts after a reboot. It resolves with the
   * report Home writes to `service/recovery.json`. `Bun.serve` binds
   * synchronously, so the socket is live before this settles; awaiting it
   * is how a caller knows the process picture is accurate. Home's tick starts
   * once it settles.
   */
  readonly ready: Promise<RecoveryReport>;
  /** The control service this server writes command receipts through. */
  readonly controlService: ReturnType<typeof wireControl>;
  /** Home's tick: `tick()` runs every sweep that is due now, as the timer does; `idle()`
   *  resolves once no sweep is running. */
  readonly scheduler: { tick(): Promise<TickReport>; idle(): Promise<void> };
  /** The ingress listener, when one is bound: loopback only. */
  readonly ingress?: { readonly url: string; readonly hostname: string; readonly port: number };
  stop(): Promise<void>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

/** A plugin pane's single-use address lives this long, and at most this many at once. */
const PANE_LINK_TTL_MS = 60_000;
const PANE_LINK_CAP = 256;

/**
 * Why a harness may not move to `newDir`, or null when it may: never onto, into or around
 * Home's own records, and never onto or around another registered harness.
 *
 * First consumer: `POST /api/h/:id/relocate`.
 */
export function relocationRefusal(
  newDir: string,
  hangarRoot: string,
  otherDirs: readonly string[],
): string | null {
  const target = realOr(newDir);
  const home = realOr(hangarRoot);
  if (isWithin(home, target) || isWithin(target, home)) {
    return "newDir holds Home's own records; choose the directory the harness's files are in";
  }
  for (const dir of otherDirs) {
    if (isWithin(target, realOr(dir))) {
      return "newDir holds another registered harness; choose the directory this harness's files are in";
    }
  }
  return null;
}

/** The notification settings: one block of Home's settings, shared by everyone. */
const HOME_NOTIFICATION_FIELDS = ["rules", "quietHours", "mutedGroups", "webhookUrl"] as const;
/** How often live run streams check that their session still holds. */
const SESSION_CHECK_MS = 30_000;

/** The permission each job kind needs: the one its own route needs. */
const JOB_KIND_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  doctor: "h.eval.run",
  compile: "h.deploy",
  eval: "h.eval.run",
  "dream-run": "h.memory.write",
});

/** The OS user running Home, for the access records' local actor. */
function osIdentity(env: Readonly<Record<string, string | undefined>>): {
  username: string;
  hostname: string;
} {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = env["USER"] ?? env["USERNAME"] ?? "";
  }
  let host = "";
  try {
    host = osHostname();
  } catch {
    host = "";
  }
  return { username, hostname: host };
}

/** Start the manager server. Synchronous — `Bun.serve` binds immediately. */
export function startHangarServer(opts: HangarServerOptions = {}): HangarServer {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));
  const hangarRoot =
    opts.root !== undefined ? resolve(opts.root) : join(homedir(), ".crewhaus", "hangar");
  const noAuth = opts.noAuth === true;
  // Turning sign-in off makes every local process the owner: never while Home answers to
  // anyone else. Decided before anything is read, written or bound.
  const noAuthRefused = noAuth ? noAuthRefusal(hangarRoot) : undefined;
  if (noAuthRefused !== undefined) throw new Error(`hangar-server: ${noAuthRefused}`);
  const hostname = opts.hostname ?? "127.0.0.1";
  // Sign-in off answers on this computer only: never on another address, nor beside a LAN one.
  if (noAuth && (!isLoopbackHostname(hostname) || opts.lanHost !== undefined)) {
    throw new Error(
      `hangar-server: sign-in off (--no-auth) answers on this computer only, and listening on ${opts.lanHost ?? hostname} exposes the console beyond loopback and REQUIRES auth — bind a loopback address, or start with sign-in on`,
    );
  }

  // The installed service is always signed in, whatever a caller passes.
  const homeMode: HomeMode = opts.mode === "resident" ? "resident" : "foreground";
  if (homeMode === "resident" && noAuth) {
    throw new Error("hangar-server: the installed service always runs with sign-in on");
  }
  // What the areas compose, checked before anything is written or bound.
  const areas = opts.areas ?? HOME_AREAS;
  const compositionRefused = homeCompositionProblems(areas);
  if (compositionRefused.length > 0) {
    throw new Error(
      `hangar-server: Home's composition is refused:\n  ${compositionRefused.join("\n  ")}`,
    );
  }
  const hostBootedAt = opts.hostBootedAt ?? (() => Date.now() - uptime() * 1000);

  // ---- signing in: the owner's settings, the sign-in handle, the Host allowlist ----
  // The owner's `access` and `links` blocks are read once, here; a block that is not
  // right refuses boot, because guessing at who Home may trust is worse than not starting.
  const ownerRead = readOwnerSettings(hangarRoot);
  if (!ownerRead.ok) throw new Error(`hangar-server: ${ownerRead.reason}`);
  for (const warning of ownerRead.warnings) onWarn(`hangar-server: ${warning}`);
  const ownerSettings = ownerRead.settings;
  const trustedProxy = ownerSettings.trustedProxy;
  if (trustedProxy !== undefined) {
    if (!isLoopbackHostname(hostname)) {
      throw new Error(
        `hangar-server: a trusted proxy is set in ${join(hangarRoot, "settings.json")}, so Home listens on this computer only — drop --lan and --host, or remove the proxy with \`crewhaus access proxy --off\``,
      );
    }
    if (trustedProxy.socket === true && !socketsSupported()) {
      throw new Error(
        "hangar-server: access.trustedProxy.socket needs a unix socket, which Home does not create on Windows — use a proxy secret instead (`crewhaus access proxy` without --socket)",
      );
    }
  }
  if (!noAuth && !socketsSupported()) {
    const access = loadAccessSnapshot(hangarRoot);
    const socketOnly =
      access.state === "present" &&
      access.snapshot.tokens.some(
        (row) => row.kind === "bootstrap" && row.state === "active" && row.socketOnly === true,
      );
    if (socketOnly) {
      throw new Error(
        "hangar-server: Home's own key is socket-only, and Home does not create its socket on Windows — run `crewhaus hangar rotate-token --tcp`",
      );
    }
  }
  let tokenSetup: TokenSetup | undefined;
  if (noAuth) {
    onWarn(
      "hangar-server: AUTH DISABLED (noAuth) — every local process can read this fleet's state",
    );
  } else {
    tokenSetup = ensureToken(hangarRoot);
    const mismatch = bootstrapKeyMismatch(hangarRoot, tokenSetup.token);
    if (mismatch !== undefined) throw new Error(mismatch);
  }
  const registry: HangarRegistry = openHangarRegistry({
    ...(opts.registryRoot !== undefined ? { root: opts.registryRoot } : {}),
    env,
    now,
    onWarn,
  });
  const signIn: SignInHandle = openSignIn(hangarRoot, {
    now,
    localActor: localActorOf(osIdentity(env)),
    // A grant an invite gives reaches the registered harnesses' approver lists at once.
    harnesses: () => registry.list().map((e) => ({ id: e.id, dir: e.dir, groups: e.groups })),
  });
  const homeAccess: HomeAccess = {
    signIn,
    config: {
      ...(trustedProxy !== undefined ? { trustedProxy } : {}),
      ...(opts.lanHost !== undefined ? { lanHost: opts.lanHost } : {}),
    },
    bootToken: tokenSetup?.token,
    now,
    domains: new Map(),
    onWarn,
  };
  for (const [name, checker] of Object.entries(opts.domains ?? {})) {
    registerHomeDomain(homeAccess, name, checker);
  }
  const cache = openRollupCache(hangarRoot);
  const version = opts.version ?? HANGAR_SERVER_VERSION;
  const operator = opts.operator ?? "hangar";

  // Every command is persisted before it is acknowledged. The supervisor and the drain
  // call are lent lazily, so the job store below can be wrapped without a cycle.
  const controlService = wireControl(
    {
      hangarRoot,
      harnessDirOf: (hrn) => {
        const entry = registry.get(hrn);
        return entry !== undefined && entry.missingSince === null && existsSync(entry.dir)
          ? entry.dir
          : undefined;
      },
      harnessDirs: () => liveHarnesses().map((h) => h.dir),
      supervisorFor: (dir) => {
        const entry = registry.list().find((e) => e.dir === dir);
        return entry === undefined ? undefined : processes.get(entry).supervisor;
      },
      drainRequest: (dir) => async () => {
        const outcome = await control.drain({
          harnessDir: dir,
          controlPort: processes.peek(dir)?.controlPort(),
        });
        if (!outcome.ok) throw new Error(outcome.reason);
      },
      identity: currentLocalIdentity(),
      now,
      probe: withOwnStartTime(createProcessOps()),
      hostBootedAt,
      onWarn,
      // A command dispatched from its receipt, when it is submitted or recovered, runs only
      // while the credential that submitted it, or for a receipt without one its actor, may
      // still do it.
      authorizeActor: (actor, permission, target, credentialRef) => {
        const read = loadAccessSnapshot(hangarRoot);
        if (read.state !== "present") return undefined;
        const parsed = parseRef(target);
        const harness =
          "error" in parsed
            ? undefined
            : parsed.kind === "harness"
              ? parsed.id
              : parsed.scope !== "home"
                ? parsed.scope
                : undefined;
        const at =
          harness === undefined
            ? ({ scope: "home" } as const)
            : {
                scope: "harness" as const,
                harness,
                groups: registry.get(harness)?.groups ?? [],
              };
        return queuedActorHolds(
          read.snapshot,
          credentialRef !== undefined ? { actor, credentialRef } : { actor },
          permission,
          at,
          { now: now(), domains: homeAccess.domains },
        );
      },
    },
    { mode: homeMode === "resident" ? "resident" : "server" },
  );

  /** Who each `/api` request authenticated as, for the routes that care which credential. */
  const callers = new WeakMap<Request, Authenticated>();
  /** The row, params and caller each `/api` request was authorized as, for its stream. */
  const authorized = new WeakMap<Request, RequestMatch & { readonly caller: Caller }>();
  /** Every open run stream's re-check: whether its caller may still read it. */
  const streamChecks = new Set<() => void>();
  let streamEpoch: string | undefined;
  /** Single-use pane documents (`/pane/<nonce>`), minted inside the authenticated pane read. */
  const paneDocs = new Map<
    string,
    { readonly doc: string; readonly csp: string; readonly expiry: number }
  >();
  /**
   * The abort signal for a live run stream: the client going away, or, for a stream
   * opened with a session, that session ending. The reason names the closing event.
   * `dispose` ends the stream's re-check and its session listener; the stream calls it
   * when it finishes, for every reason, and calling it again does nothing.
   */
  const streamSignal = (
    req: Request,
  ): { readonly signal: AbortSignal | undefined; readonly dispose: () => void } => {
    const who = callers.get(req);
    const sessionRef = who?.kind === "principal" ? who.sessionRef : undefined;
    const decided = authorized.get(req);
    if (sessionRef === undefined && decided === undefined) {
      return { signal: req.signal, dispose: () => undefined };
    }
    const ended = new AbortController();
    const stops: Array<() => void> = [];
    if (sessionRef !== undefined) {
      stops.push(
        signIn.onEnd(sessionRef, (end) =>
          ended.abort(end === "expired" ? "auth.expired" : "auth.revoked"),
        ),
      );
    }
    if (decided !== undefined) {
      // Whoever opened it, a session, a token or Home's own key: when the access records
      // move, the stream is authorized again, and closes with `revoked` once it is not.
      const recheck = (): void => {
        if (ended.signal.aborted) return;
        const verdict = authorizeRequest({
          ...decided,
          view: accessView(signIn.snapshot()),
        });
        if (!verdict.allow) ended.abort("revoked");
      };
      streamChecks.add(recheck);
      stops.push(() => streamChecks.delete(recheck));
    }
    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const s of stops) s();
    };
    ended.signal.addEventListener("abort", dispose, { once: true });
    req.signal?.addEventListener("abort", dispose, { once: true });
    return {
      signal: req.signal === undefined ? ended.signal : AbortSignal.any([req.signal, ended.signal]),
      dispose,
    };
  };

  /**
   * The periodic check: sessions that ended close their streams, and every open stream is
   * authorized again, whether or not the access records moved: a scoped token's end, a
   * grant's and a service token's expiry pass with the clock alone.
   */
  const checkStreams = (): void => {
    signIn.checkSessions();
    const read = signIn.snapshot();
    streamEpoch = read.state === "present" ? String(read.snapshot.epoch) : read.state;
    for (const recheck of [...streamChecks]) recheck();
  };

  /** Authorize every open stream again, once per move of the access revision. */
  const recheckStreams = (read: AccessSnapshotRead): void => {
    if (streamChecks.size === 0) return;
    const epoch = read.state === "present" ? String(read.snapshot.epoch) : read.state;
    if (epoch === streamEpoch) return;
    streamEpoch = epoch;
    for (const recheck of [...streamChecks]) recheck();
  };

  const processes: ProcessLayer =
    opts.processLayer ??
    createProcessLayer({
      registry,
      env,
      now,
      onWarn,
      hangarRoot,
      managerVersion: version,
      wrapJobStore: controlService.jobs.wrapStore,
      ...(opts.homeCrewhaus !== undefined ? { homeCrewhaus: opts.homeCrewhaus } : {}),
    });
  const control: ControlClient = opts.controlClient ?? createControlClient();

  // ---- M4: settings, notifications, the lazy omnibox index, plugins -------
  const settings: SettingsStore = openSettingsStore(hangarRoot, { onWarn });
  const readOnlyLocked = opts.readOnlyLocked === true;
  /**
   * The mode for THIS process, when a boot flag set it. Deliberately NOT
   * persisted: `--read-only` is a posture for one demo, and an operator who
   * restarts normally afterwards must get a writable console back rather
   * than a mystery. The PERSISTED setting is what a flagless boot uses, and
   * an explicit toggle through the API writes both.
   */
  let sessionReadOnly: boolean | undefined =
    opts.readOnly === true || readOnlyLocked ? true : undefined;
  const readOnlyNow = (): boolean => sessionReadOnly ?? settings.get().readOnly;
  // The sinks the operator ticks in Settings have to be the sinks that
  // actually fire: an `os`/`webhook` checkbox wired to `{}` is a persisted,
  // validated alerting path that silently does nothing. Real by default,
  // injectable for tests.
  const notifications: NotificationCentre = createNotificationCentre(
    opts.notificationSinks ?? defaultNotificationSinks({ onWarn }),
  );
  // Allocated, not built: the first ⌘K query pays for the harnesses it
  // needs, so boot does no indexing work at all (HM-189).
  const omni: OmniIndex = createOmniIndex();
  const pluginsDir = opts.pluginsDir ?? defaultPluginsDir(homedir());
  const demosDir = opts.demosDir ?? env[DEMOS_DIR_ENV];
  const cwd = opts.cwd ?? process.cwd();

  // ---- authorization -------------------------------------------------------

  /** The access records and the registry, as one request's authorization sees them. */
  const accessView = (read: AccessSnapshotRead): AccessView => ({
    read,
    now: now(),
    domains: homeAccess.domains,
    groupsOf: (id) => (HARNESS_ID_RE.test(id) ? registry.get(id)?.groups : undefined),
    harnessIds: () => registry.list().map((entry) => entry.id),
  });

  /** The registry rows this request may read: every enumeration a fleet fold makes. */
  const visibleEntries = (): HangarHarnessEntry[] =>
    registry.list().filter((entry) => visibleToRequest(entry.id));

  /** This request's caller, for the handlers that record who acted. */
  const requestCaller = (): Caller =>
    currentRequestAccess()?.caller ?? {
      principal: loadOwnerOr(operator),
      actor: null,
      via: noAuth ? "no-auth" : "bootstrap",
    };
  const loadOwnerOr = (label: string): string => {
    const read = signIn.snapshot();
    return read.state === "present" ? (read.snapshot.owner ?? label) : label;
  };

  /** The registry groups this request may see: those with a member it may read; none
   *  outside a request. */
  const visibleGroups = (): ReturnType<HangarRegistry["listGroups"]> => {
    const access = currentRequestAccess();
    if (access === undefined) return [];
    const groups = registry.listGroups();
    if (isOwnerCaller(access.caller, signIn.snapshot())) return groups;
    return groups.filter((group) =>
      registry.groupMembers(group.name).some((entry) => visibleToRequest(entry.id)),
    );
  };

  /**
   * A group walk narrowed to this request: members it may not read are left out, and a
   * member it may read but not control is skipped as `forbidden`, never acted on.
   */
  const narrowPlan = (plan: GroupPlan, _acting: boolean): GroupPlan => {
    const members = plan.members
      .filter((member) => visibleToRequest(member.id))
      .map((member, index): GroupPlanMember => {
        const position = index + 1;
        if (requestAllows("h.control", member.id)) return { ...member, position };
        return {
          ...member,
          position,
          skip: "forbidden — ask the owner for operator access to this harness",
          skipCode: "forbidden",
        };
      });
    return {
      ...plan,
      members,
      actionable: members.filter((m) => m.skip === null).length,
      skipped: members.filter((m) => m.skip !== null).length,
    };
  };

  /** A refusal for a permission this request's caller does not hold on one harness. */
  const forbiddenOn = (permission: string, harness?: string): HttpError => {
    const access = currentRequestAccess();
    const verdict = access?.authorize(permission, harness !== undefined ? { harness } : undefined);
    if (verdict !== undefined && !verdict.allow && "reason" in verdict) {
      return new HttpError(403, TAB_ONLY_MESSAGE, {
        code: "forbidden",
        reason: verdict.reason,
        needs: permission,
        role: null,
      });
    }
    const refusal = permissionRefusal(
      access?.caller ?? requestCaller(),
      permission,
      verdict !== undefined && !verdict.allow ? verdict.role : null,
      harness !== undefined ? "harness" : "home",
    );
    return new HttpError(403, refusal.message, {
      code: refusal.code,
      reason: refusal.reason,
      needs: permission,
      role: refusal.role ?? null,
    });
  };

  // ---- shared lookups -----------------------------------------------------

  const entryOr404 = (id: string): HangarHarnessEntry => {
    if (!HARNESS_ID_RE.test(id)) throw new HttpError(400, "invalid harness id");
    const entry = registry.get(id);
    if (entry === undefined) throw new HttpError(404, "no such harness");
    return entry;
  };

  const liveDirOr404 = (entry: HangarHarnessEntry): string => {
    if (entry.missingSince !== null || !existsSync(entry.dir)) {
      throw new HttpError(404, "harness dir missing — relocate or remove the entry");
    }
    return entry.dir;
  };

  /**
   * The THIRD masking layer, for one harness: its `.env` chain under the
   * manager's own environment — the same record the supervisor's pump scrubs
   * live output with.
   *
   * `maskDeep` redacts by key NAME and by value SHAPE. A credential whose
   * value this manager demonstrably holds, but which has neither — an opaque
   * string under `body`, `note`, `tags[]`, `justification`, `patch`, or in
   * prose — survives both, and did: twenty routes echoed one back verbatim.
   * The scrubber is the only layer that can catch it, so it is applied at the
   * seams where payloads are serialized rather than remembered per handler.
   */
  const harnessScrub = (dir: string): TextScrubber => safeSpawnEnvScrubber(dir, env);

  /**
   * The same, folded over every live harness — for the FLEET payloads
   * (`/api/approvals`, `/api/review`, `/api/activity`, the M3 fleet routes),
   * which quote content from harnesses the request never names. A value from
   * harness A rendered on a fleet screen is the same leak wherever it came
   * from.
   */
  const fleetScrub = (): TextScrubber => {
    // Every live harness's values, not only the ones this request may read: a value from a
    // harness the caller cannot see is still one this manager holds.
    const scrubbers = registry
      .list()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((e) => harnessScrub(e.dir));
    if (scrubbers.length === 0) return (text) => text;
    if (scrubbers.length === 1) return scrubbers[0] as TextScrubber;
    return (text) => scrubbers.reduce((acc, s) => s(acc), text);
  };

  const readYamlSafe = (dir: string): string => {
    try {
      return readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    } catch {
      return "";
    }
  };

  const readHeaderSafe = (dir: string): { name?: string; target?: string; model?: string } => {
    try {
      return readSpecHeader(readYamlSafe(dir));
    } catch {
      return {};
    }
  };

  const inventoryDeps: BuildInventoryDeps = {
    readManifest: (specName, registryRoot) => {
      if (!SAFE_SEGMENT_RE.test(specName)) return Promise.resolve(undefined);
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(join(registryRoot, specName, "manifest.json"), "utf8"),
        );
        if (isRecord(parsed) && Array.isArray(parsed["versions"]) && isRecord(parsed["pins"])) {
          return Promise.resolve(parsed as { versions: string[]; pins: Record<string, string> });
        }
      } catch {
        // unregistered spec — absence, not error
      }
      return Promise.resolve(undefined);
    },
    readEvalIndex: (evalsDir) => {
      try {
        return readRunIndex(evalsDir);
      } catch {
        return [];
      }
    },
  };

  // ---- route bodies -------------------------------------------------------

  const harnessRows = (hydrate: boolean): unknown => {
    const rows = visibleEntries().map((entry) => {
      const missing = entry.missingSince !== null;
      const yamlText = missing ? "" : readYamlSafe(entry.dir);
      let header: { name?: string; target?: string; model?: string } = {};
      try {
        header = readSpecHeader(yamlText);
      } catch {
        header = {};
      }
      let rollup: HarnessRollup | null = null;
      let rollupStaleCachedAt: string | undefined;
      if (!missing) {
        if (hydrate) {
          rollup = cache.get(entry.id, entry.dir, now());
        } else {
          const peeked = cache.peek(entry.id, entry.dir);
          rollup = peeked.rollup;
          rollupStaleCachedAt = peeked.staleCachedAt;
        }
      }
      // Flattened alongside the nested rollup: the row-level fields the
      // Library table cannot derive client-side — capability badges (lenient
      // spec scan), eval health vs the pinned baseline, and the honest
      // as-of time for whichever rollup figures (fresh or stale) exist.
      const badges = capabilityBadges(yamlText);
      const capabilities = BADGE_KEYS.filter((k) => badges[k]);
      const evalHealthy = missing
        ? null
        : evalHealthyFlag(
            evalHealth(join(entry.dir, ".crewhaus", "evals"), header.name ?? entry.specName),
          );
      return {
        id: entry.id,
        dir: entry.dir,
        specName: header.name ?? entry.specName,
        target: header.target ?? entry.target,
        model: header.model ?? null,
        origin: entry.origin,
        groups: entry.groups,
        tags: entry.tags,
        pinned: entry.pinned,
        // Curation, not removal: the Library folds hidden rows out of the
        // default view; everything else about the entry keeps flowing.
        hidden: entry.hidden === true,
        notes: entry.notes,
        kind: entry.kind,
        registeredAt: entry.registeredAt,
        lastSeen: entry.lastSeen,
        missingSince: entry.missingSince,
        capabilities,
        evalHealthy,
        // M2 fleet columns: is it supervised right now, and is anything
        // parked on a human? Both are cheap (a runfile stat, a folded
        // approvals log) — no transcript is opened for a fleet row.
        supervision: missing ? null : (processes.peek(entry.dir)?.snapshot().state ?? null),
        pendingApprovals: missing ? 0 : pendingApprovalCount(entry.dir),
        cachedAt: rollup?.cachedAt ?? rollupStaleCachedAt ?? null,
        rollup,
        ...(rollupStaleCachedAt !== undefined ? { rollupStaleCachedAt } : {}),
      };
    });
    return { harnesses: rows };
  };

  const detailView = async (entry: HangarHarnessEntry): Promise<unknown> => {
    if (entry.missingSince !== null || !existsSync(entry.dir)) {
      return { entry, missing: true };
    }
    const dir = entry.dir;
    const inventory = await buildHarnessInventory(
      { dir, specPath: join(dir, "crewhaus.yaml") },
      inventoryDeps,
    );
    const health = await buildHarnessHealth(inventory, (evalsDir, specName) => {
      const { state, note } = evalHealth(evalsDir, specName);
      return { healthy: state !== "regressed", note, state };
    });
    const merged = mergedSpawnEnv(env, dir);
    const report = await runPreflight({ harnessDir: dir, env: merged.env });
    const counts = { blocking: 0, warn: 0, info: 0 };
    for (const item of report.items) counts[item.level] += 1;
    let yamlText = "";
    try {
      yamlText = readFileSync(join(dir, "crewhaus.yaml"), "utf8");
    } catch {
      yamlText = "";
    }
    // Small memory-fabric counts for the Overview mini-cards: live facts +
    // wiki articles on disk. Counts only — the full views stay on their own
    // /memory/* routes.
    // A file too large to read has an unknown count, and a sum over it would
    // be a floor printed as a total.
    const factFiles = factsView(dir, now()).files;
    const facts = factFiles.some((f) => f.live === null)
      ? null
      : factFiles.reduce((n, f) => n + (f.live ?? 0), 0);
    const articles = wikiView(dir).articles.length;
    return {
      entry,
      missing: false,
      inventory,
      health,
      preflight: { ok: report.ok, ...counts },
      badges: capabilityBadges(yamlText),
      envFiles: merged.envFiles,
      memory: { facts, articles },
      rollup: cache.get(entry.id, dir, now()),
    };
  };

  /**
   * Discovery WITHOUT registration: walk the scan roots and report the
   * harnesses that are NOT yet registered, each one an add away. This is the
   * "find harnesses on this machine" flow — the operator picks which to add,
   * so a big checkout does not flood the Library the way a blanket scan
   * (which registers everything it finds) would.
   */
  const discoverView = (): unknown => {
    const registered = new Set(registry.list().map((e) => e.dir));
    const roots = registry.listScanRoots();
    const errors: string[] = [];
    const seen = new Set<string>();
    const candidates: Array<{ dir: string; specName: string; target: string }> = [];
    let alreadyRegistered = 0;
    for (const scanRoot of roots) {
      let found: ReturnType<typeof discoverHarnesses>;
      try {
        found = discoverHarnesses(scanRoot.dir);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const h of found) {
        if (seen.has(h.dir)) continue;
        seen.add(h.dir);
        if (registered.has(h.dir)) {
          alreadyRegistered += 1;
          continue;
        }
        const header = readHeaderSafe(h.dir);
        candidates.push({
          dir: h.dir,
          specName: header.name ?? basename(h.dir),
          target: header.target ?? "unknown",
        });
      }
    }
    candidates.sort((a, b) => a.dir.localeCompare(b.dir));
    return {
      roots: roots.length,
      candidates,
      alreadyRegistered,
      errors,
      note:
        roots.length === 0
          ? "no scan roots configured — add one and discovery can search this machine"
          : candidates.length === 0
            ? "every harness under the scan roots is already registered"
            : null,
    };
  };

  const scanAll = (): unknown => {
    const errors: string[] = [];
    let roots = 0;
    let discovered = 0;
    let added = 0;
    let refreshed = 0;
    for (const scanRoot of registry.listScanRoots()) {
      roots += 1;
      let found: ReturnType<typeof discoverHarnesses>;
      try {
        found = discoverHarnesses(scanRoot.dir);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      for (const h of found) {
        discovered += 1;
        const header = readHeaderSafe(h.dir);
        const existing = registry.get(h.dir);
        registry.upsert({
          dir: h.dir,
          ...(header.name !== undefined ? { specName: header.name } : {}),
          ...(header.target !== undefined ? { target: header.target } : {}),
          origin: "scan",
          originDetail: "scan",
        });
        if (existing === undefined) added += 1;
        else refreshed += 1;
      }
      registry.updateScanRoot(scanRoot.dir, { lastScanAt: new Date(now()).toISOString() });
    }
    return { roots, discovered, added, refreshed, errors };
  };

  const fleetCosts = (): unknown => {
    const rows: unknown[] = [];
    let totalUsdMicros = 0;
    let spend7dUsdMicros = 0;
    let calls = 0;
    for (const entry of visibleEntries()) {
      if (entry.missingSince !== null) continue;
      const rollup = cache.get(entry.id, entry.dir, now());
      const costs = rollup.costBreakdown;
      totalUsdMicros += costs.totalUsdMicros;
      spend7dUsdMicros += costs.spend7dUsdMicros;
      calls += costs.calls;
      rows.push({ id: entry.id, specName: entry.specName, costs });
    }
    return { harnesses: rows, fleet: { totalUsdMicros, spend7dUsdMicros, calls } };
  };

  // ---- M4: health, signals, onboarding, search, plugins -------------------

  /**
   * One harness's health score (HM-11).
   *
   * Every input is a panel that already exists — preflight (the Start
   * gate), eval health (the Library column), incidents and the spec lint
   * (Security and Spec), supervision state (Runs), the capability badges
   * (the fleet row) and the dream states (Schedulers). The score is folded
   * from them here so the number and the screens can never disagree.
   */
  const healthFor = async (entry: HangarHarnessEntry): Promise<HealthResult> => {
    const dir = liveDirOr404(entry);
    const yamlText = readYamlSafe(dir);
    const view = specView(dir, env);
    let preflight: { items: readonly HealthPreflightItem[] } | null = null;
    try {
      const merged = mergedSpawnEnv(env, dir);
      const report = await runPreflight({ harnessDir: dir, env: merged.env });
      preflight = { items: report.items };
    } catch (err) {
      onWarn(
        `hangar-server: preflight failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let evals: EvalHealth | null = null;
    try {
      evals = evalHealth(join(dir, ".crewhaus", "evals"), view.specName);
    } catch {
      evals = null;
    }
    const cadence = cadenceToMs(declaredCadences(yamlText).dream ?? null);
    const dreams = dreamStates(dir).map((row) => ({
      specName: row.specName,
      ...dreamOverdue(
        cadence,
        (row.state ?? null) as { lastRunAt?: unknown; lastOutcome?: unknown } | null,
        now(),
      ),
    }));
    // NOTE the inputs that are NOT here: `view.envRefs` and the budget
    // badge. Both are spec-TEXT derivations, and the score is the one place
    // they must not be used — `envRefs` counts `$VAR` tokens found in
    // comments and prompt prose, and cannot see an either-or credential
    // group at all. Every credential and spend signal comes from the
    // preflight report above, which is the same gate Start runs.
    return computeHealth({
      preflight,
      evalHealth: evals,
      openIncidents: countOpenIncidents(dir),
      procState: processes.peek(dir)?.snapshot().state ?? null,
      specIssues: view.issues,
      specUnreadable: view.specUnreadable,
      dreams,
    });
  };

  /**
   * The notification snapshot (HM-183). Cheap by construction — the same
   * folds the Library row already does, plus the run ledger's recent
   * terminal exits. No transcript is opened and no preflight is run here:
   * the credential-probe signal comes from the CHEAP half (a spec `$VAR`
   * the merged env does not hold), because a fleet-wide preflight on every
   * badge poll would be the most expensive thing this manager does.
   */
  const fleetSignals = (): readonly HarnessSignal[] =>
    visibleEntries()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((entry) => {
        const dir = entry.dir;
        const yamlText = readYamlSafe(dir);
        const view = specView(dir, env);
        const cadence = cadenceToMs(declaredCadences(yamlText).dream ?? null);
        const overdueDreams = dreamStates(dir)
          .map((row) => ({
            specName: row.specName,
            ...dreamOverdue(
              cadence,
              (row.state ?? null) as { lastRunAt?: unknown; lastOutcome?: unknown } | null,
              now(),
            ),
          }))
          .filter((d) => d.neverRan || (d.windows !== null && d.windows > 2))
          .map((d) => d.specName);
        const budgetUsd = declaredBudgetUsd(yamlText);
        // The CACHED rollup, not a fresh fold: this runs on every badge poll
        // across the whole fleet, and re-reading every session log for a
        // number the Library already caches would make the cheapest screen
        // the most expensive request.
        const spentUsd = cache.get(entry.id, dir, now()).costBreakdown.totalUsdMicros / 1_000_000;
        return {
          harnessId: entry.id,
          specName: view.specName,
          groups: entry.groups,
          pendingApprovals: pendingApprovalCount(dir),
          procState: processes.peek(dir)?.snapshot().state ?? null,
          evalHealthy: evalHealthyFlag(evalHealth(join(dir, ".crewhaus", "evals"), view.specName)),
          openIncidents: countOpenIncidents(dir),
          overdueDreams,
          recentExits: runsView(dir, 20)
            .runs.filter((r) => typeof r.exitCode === "number")
            .map((r) => ({
              runId: r.runId,
              exitCode: r.exitCode as number,
              endedAt: r.endedAt ?? null,
            })),
          budgetUsedRatio: budgetUsd === null ? null : spentUsd / budgetUsd,
          credentialProbeFailed: view.envRefs.some((r) => !r.set),
        } satisfies HarnessSignal;
      });

  /** How long a delivery stays in `delivered`: two of the console's polls. */
  const DELIVERED_KEPT_MS = 60_000;
  /** The deliveries of recent ticks, newest first, and the last tick's suppressions. */
  let recentDeliveries: Delivery[] = [];
  let lastSuppressed: readonly SuppressedEvent[] = [];

  /**
   * One notifications tick: evaluate the rules over the fleet and deliver what is due, on
   * the sinks people turned on. Runs on Home's tick, under the `notifications` sweep's
   * own system principal, and after a write to the rules; never on a read.
   */
  const notificationsTick = (): void => {
    const current = settings.get().notifications;
    const result = notifications.poll(
      {
        rules: current.rules,
        quietHours: current.quietHours,
        mutedGroups: current.mutedGroups,
        events: deriveEvents(fleetSignals()),
        nowMs: now(),
      },
      current.webhookUrl,
    );
    const keptFrom = now() - DELIVERED_KEPT_MS;
    recentDeliveries = [...result.deliveries, ...recentDeliveries]
      .filter((d) => Date.parse(d.at) >= keptFrom)
      .slice(0, MAX_INAPP_DELIVERIES);
    lastSuppressed = result.suppressed;
  };

  /** Whether Home keeps delivering with this window closed: the installed service's state. */
  const serviceView = (): {
    readonly present: boolean;
    readonly state: "running" | "installed" | "absent";
    readonly note: string;
    readonly verb: string | null;
  } => {
    if (homeMode === "resident") {
      return {
        present: true,
        state: "running",
        note: "Home is running as a service: notifications arrive while this window is closed",
        verb: null,
      };
    }
    let unit: "absent" | "installed" = "absent";
    try {
      unit = opts.residentUnit?.() ?? "absent";
    } catch {
      unit = "absent";
    }
    return unit === "installed"
      ? {
          present: true,
          state: "installed",
          note: "The service is installed but not running here: notifications stop when this window closes",
          verb: "crewhaus hangar status",
        }
      : {
          present: false,
          state: "absent",
          note: "Install the service to get notifications while this window is closed",
          verb: "crewhaus hangar install",
        };
  };

  /** GET /api/notifications — the rules, the badge and what Home's tick delivered. A read. */
  const notificationsView = (): unknown => {
    const current = settings.get().notifications;
    // The queue is Home's: each reader sees the entries about harnesses it may read.
    const inApp = notifications.inApp().filter((d) => visibleToRequest(d.harnessId));
    const keptFrom = now() - DELIVERED_KEPT_MS;
    return {
      rules: current.rules,
      quietHours: current.quietHours,
      mutedGroups: current.mutedGroups,
      webhookUrl: current.webhookUrl,
      /** What this manager can actually deliver on, and why not — so a sink
       *  that cannot fire here is visibly unusable rather than a checkbox
       *  the operator ticks into silence. */
      sinkAvailability: notifications.availability(current.webhookUrl),
      /** What Home's recent ticks delivered, newest first, each with its tick's `at`: the
       *  toast list. Each delivery's `sinks` names the sinks that actually carried it. */
      delivered: recentDeliveries.filter(
        (d) => Date.parse(d.at) >= keptFrom && visibleToRequest(d.harnessId),
      ),
      /** What the last tick did not deliver, with the reason — a silent rule is
       *  always explainable from the screen. */
      suppressed: lastSuppressed.filter((d) => visibleToRequest(d.harnessId)),
      /** The badge queue, newest first. */
      inApp,
      badge: inApp.length,
      /** Whether delivery goes on with this window closed. */
      service: serviceView(),
      /** No CLI verb shows the same thing yet; said as `null`, never a near-miss. */
      cliTwin: null,
    };
  };

  /** The registry rows the omnibox indexes over. */
  const indexHarnesses = (): ReadonlyArray<{
    id: string;
    specName: string;
    dir: string;
    groups: readonly string[];
    tags: readonly string[];
  }> =>
    visibleEntries()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((e) => ({
        id: e.id,
        specName: e.specName,
        dir: e.dir,
        groups: e.groups,
        tags: e.tags,
      }));

  // ---- M2: process, control, and the fleet inboxes -------------------------

  /** Every live registered harness, as the inbox folders want it. */
  const liveHarnesses = (): Array<ApprovalHarness & ReviewHarness & ActivityHarness> =>
    visibleEntries()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((e) => ({ id: e.id, dir: e.dir, specName: e.specName }));

  /**
   * The supervision handle for a harness, RE-ATTACHED to a daemon this
   * manager did not spawn: adopt-before-act, for every path that changes a
   * process. A daemon started from a terminal, by a launchd unit, or for a
   * harness registered after boot is attached here before Home signals it,
   * exactly as `crewhaus daemon stop` does. `adoptIfRunfile()` returns at once
   * unless a runfile exists AND this supervisor holds no pid. Reads use
   * {@link observedFor}; Home's tick attaches what reads only observe.
   */
  const processFor = async (entry: HangarHarnessEntry): Promise<HarnessProcess> => {
    liveDirOr404(entry);
    const handle = processes.get(entry);
    try {
      await handle.supervisor.adoptIfRunfile();
    } catch (err) {
      // A failed adoption must not fail the read: the honest answer is the
      // un-adopted picture plus a warning, never a 500.
      onWarn(
        `hangar-server: adopt failed for ${handle.harnessDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return handle;
  };

  /**
   * The supervision handle for a read: never adopts, clears or patches anything. What
   * the runfile says is observed (`observeRunfile`, the check adoption makes) and shown
   * beside the supervisor's own picture; the next tick attaches a live one.
   */
  const observedFor = (
    entry: HangarHarnessEntry,
  ): { readonly handle: HarnessProcess; readonly observed: RunfileObservation } => {
    liveDirOr404(entry);
    const handle = processes.get(entry);
    let observed: RunfileObservation = { state: "none" };
    try {
      observed = observeRunfile(handle.harnessDir, processes.ops);
    } catch {
      observed = { state: "none" };
    }
    return { handle, observed };
  };

  /**
   * The typed preflight refusal, with the acknowledgeable/unforceable split
   * kept explicit. An operator often knows better than an offline check —
   * except about missing channel secrets, which the compiled daemon's own
   * boot gate exits 2 on, so "start anyway" there would spawn a process
   * guaranteed to die.
   */
  const gateRefusalBody = (gate: GateDecision): Record<string, unknown> => ({
    ok: false,
    reason: "preflight-blocked",
    refused: gate.refused.map((item) => ({
      id: item.id,
      area: item.area,
      level: item.level,
      message: item.message,
      remediation: item.remediation ?? null,
      // The distinction the Start-anyway button must respect.
      acknowledgeable: !isUnforceable(item),
    })),
    unforceable: gate.unforceable.map((item) => item.id),
    acknowledged: gate.acknowledged.map((item) => item.id),
    report: { ok: gate.report.ok },
  });

  /** A job refused before it was enqueued, in the same shape: acknowledging the item, for
   *  this one job, lets it through. */
  const jobRefusalBody = (err: JobRefusedError): Record<string, unknown> => ({
    ok: false,
    reason: "preflight-blocked",
    refused: [
      {
        id: err.item.id,
        area: err.item.area,
        level: err.item.level,
        message: err.item.message,
        remediation: err.item.remediation ?? null,
        acknowledgeable: !isUnforceable(err.item),
      },
    ],
    unforceable: isUnforceable(err.item) ? [err.item.id] : [],
    acknowledged: [],
    report: { ok: false },
  });

  /** control.v1 answers are ALWAYS a 200 envelope: the UI needs the reason
   *  text in the disabled/refused cases just as much as in the happy one,
   *  and a non-2xx would make the client's `api.js` throw instead of
   *  rendering it. */
  const controlEnvelope = (result: ControlResult<unknown>): Record<string, unknown> => {
    if (result.ok) return { ok: true, upstreamStatus: result.status, ...(result.body as object) };
    const refusal: ControlRefusal = result;
    return {
      ok: false,
      code: refusal.code,
      reason: refusal.reason,
      upstreamStatus: refusal.status,
      retryable: refusal.retryable,
      // True ⇒ a fact about this bundle, not a fault: render the control
      // disabled-with-reason rather than an error.
      expected: refusal.expected,
      ...(refusal.lane !== undefined ? { lane: refusal.lane } : {}),
    };
  };

  const procView = (
    entry: HangarHarnessEntry,
    handle: HarnessProcess,
    observed?: RunfileObservation,
  ): Record<string, unknown> => {
    const dir = handle.harnessDir;
    const snapshot = handle.snapshot();
    const runfile = readRunfile(dir) ?? null;
    // Whether this Home holds the process. A live runfile it does not hold yet is shown
    // running, from the runfile, until the next tick attaches it.
    const attached = snapshot.pid !== undefined;
    const seen = !attached && observed?.state === "live" ? observed.runfile : undefined;
    const bundle = resolveBundle(dir, handle.target);
    const controlPort = handle.controlPort() ?? null;
    // Plan-building is a filesystem probe, not a spawn. `cliTwin` is the
    // command an operator could paste — deliberately WITHOUT the env, which
    // carries the control token.
    const preview = handle.planPreview();
    const launch =
      "plan" in preview
        ? {
            mode: preview.plan.launchMode,
            canResume: preview.plan.canResume,
            cliTwin: cliTwin(preview.plan),
            detached: preview.plan.detached,
            supervised: preview.plan.supervised,
            envFiles: preview.plan.envFiles,
            overrides: preview.plan.overrides,
            error: null,
          }
        : {
            mode: null,
            canResume: false,
            cliTwin: null,
            detached: false,
            supervised: false,
            envFiles: [],
            overrides: [],
            error: {
              message: preview.error.message,
              remedy: preview.error instanceof SpawnPlanError ? preview.error.remedy : null,
            },
          };
    const specYaml = readSpecYaml(dir);
    return {
      id: entry.id,
      target: handle.target,
      runClass: runClassFor(handle.target),
      state: seen !== undefined ? "running" : snapshot.state,
      runId: seen?.runId ?? snapshot.runId ?? null,
      pid: seen?.pid ?? snapshot.pid ?? null,
      startedAt: seen?.startedAt ?? snapshot.startedAt ?? null,
      sessionId: snapshot.sessionId ?? null,
      adopted: snapshot.adopted === true,
      attached,
      note: seen !== undefined ? "running (not attached): Home attaches on its next check" : null,
      draining: handle.isDraining(),
      restartsInWindow: snapshot.restartsInWindow,
      nextRestartAtMs: snapshot.nextRestartAtMs ?? null,
      lastExit: snapshot.lastExit ?? null,
      forensics: snapshot.forensics ?? null,
      runfile,
      control: {
        port: controlPort,
        available: controlPort !== null,
        reason:
          controlPort !== null
            ? null
            : "no control port recorded — the daemon is not running, or its bundle predates crewhaus.control.v1",
      },
      bundle: {
        present: bundle !== undefined,
        dir: bundle?.bundleDir ?? null,
        entry: bundle?.entry ?? null,
        freshness: bundleFreshness({
          specYaml,
          specPath: join(dir, "crewhaus.yaml"),
          outDir: bundle?.bundleDir ?? join(dir, "dist"),
          entryPath: bundle?.entryPath ?? join(dir, "dist", "agent.ts"),
        }),
      },
      launch,
      recentRuns: runsView(dir, 10).runs,
    };
  };

  /**
   * Activate a prepared build: the activation gates, then the records. A failed gate
   * answers 409 with the deployment as it stands.
   */
  const activateRoute = async (
    entry: HangarHarnessEntry,
    dep: string,
    body: Record<string, unknown>,
  ): Promise<{ readonly body: unknown; readonly status: number }> => {
    if (!DEPLOYMENT_ID_RE.test(dep)) throw new HttpError(400, "not a deployment id");
    const environment = body["environment"];
    if (environment !== undefined && typeof environment !== "string") {
      throw new HttpError(400, '"environment" must be a string');
    }
    const command = currentCommand();
    const actor = command?.by ?? "sys:executor";
    const answer = await activateDeployment({
      harnessDir: liveDirOr404(entry),
      dep,
      actor,
      actorIsService: isServiceActor(hangarRoot, actor),
      cmd: command?.commandId ?? dep,
      gates: activationGates(AREA_RUNTIMES),
      ...(typeof environment === "string" && environment !== "" ? { environment } : {}),
      ...(body["autostart"] === false ? { autostart: false } : {}),
      registryId: entry.id,
      now: opts.now ?? (() => Date.now()),
    });
    if (answer.ok) {
      return {
        status: 200,
        body: { ok: true, deployment: answer.record, superseded: answer.superseded },
      };
    }
    const status =
      answer.code === "not_found"
        ? 404
        : answer.code === "forbidden"
          ? 403
          : answer.code === "unavailable"
            ? 503
            : 409;
    return {
      status,
      body: {
        ok: false,
        code: answer.code,
        message: answer.message,
        current: answer.current ?? null,
        verb: answer.verb ?? null,
      },
    };
  };

  /** One member's refusal, as one line — the same vocabulary the per-harness
   *  routes use, flattened so a sweep's summary reads as a list. */
  function groupRefusalMessage(result: StartResult & { readonly ok: false }): string {
    switch (result.reason) {
      case "disabled":
        return result.message;
      case "already-running":
        return "already running (the runfile is the lock)";
      case "preflight-blocked":
        return `preflight refused: ${result.gate.refused.map((i) => i.message).join("; ")}`;
      case "prepare-refused":
        return result.refusal.message;
      case "build-not-active":
        return result.message;
      case "plan-failed":
        return result.error.message;
    }
  }

  const startProc = async (
    entry: HangarHarnessEntry,
    body: Record<string, unknown>,
    restart: boolean,
  ): Promise<Response> => {
    const handle = await processFor(entry);
    const acknowledge = asStringArray(body["acknowledge"]);
    const gateOptions = {
      ...(body["force"] === true ? { force: true } : {}),
      ...(acknowledge !== undefined ? { acknowledge } : {}),
    };
    const result = restart
      ? await handle.supervisor.restart(gateOptions)
      : await handle.supervisor.start(gateOptions);
    if (result.ok) {
      // A daemon that just started is not draining, whatever a previous
      // drain left latched — the supervisor clears its own operator-stop
      // latch on a successful start, and the display flag must follow.
      handle.clearDraining();
      return json({
        ok: true,
        runId: result.runId,
        pid: result.pid ?? null,
        state: handle.snapshot().state,
        // "recompiled dist/", "postCompile hook ok" — the console says what
        // it did on the way in rather than leaving a recompile invisible.
        prepared: result.prepared ?? [],
      });
    }
    // A restart refused before it stopped anything says the daemon keeps running.
    const kept = result.kept === true ? { running: true } : {};
    switch (result.reason) {
      case "disabled":
        // 409: the operator disabled this harness (or its operator record cannot be read);
        // enabling it clears it.
        return json(
          {
            ok: false,
            reason: "disabled",
            message: result.message,
            verb: "crewhaus daemon enable",
            ...kept,
          },
          409,
        );
      case "prepare-refused":
        // 409 like the gate: well-formed request, refused by a fact about
        // the harness. The step's own output is what makes it actionable.
        return json(
          {
            ok: false,
            reason: "prepare-refused",
            stage: result.refusal.stage,
            message: result.refusal.message,
            exitCode: result.refusal.exitCode ?? null,
            // Already scrubbed at the capture (`runPrepareCommand`).
            output: result.refusal.output,
            ...kept,
          },
          409,
        );
      case "already-running":
        return json(
          {
            ok: false,
            reason: "already-running",
            message: "a daemon is already running for this harness (the runfile is the lock)",
            runfile: result.runfile ?? null,
            ...kept,
          },
          409,
        );
      case "preflight-blocked":
        // 409, not 400: the request was well-formed and the refusal is a
        // fact about the harness that `force`/`acknowledge` may clear.
        return json({ ...gateRefusalBody(result.gate), ...kept }, 409);
      case "build-not-active":
        // 409: the build on disk is not the active deployment's. Activating it, or
        // restoring the active build, clears it.
        return json(
          {
            ok: false,
            reason: "build-not-active",
            message: result.message,
            verb: "crewhaus deploy activate",
            ...kept,
          },
          409,
        );
      case "plan-failed":
        return json(
          {
            ok: false,
            reason: "plan-failed",
            message: result.error.message,
            // The UI turns a remedy into a button, not an error toast.
            remedy: result.error instanceof SpawnPlanError ? result.error.remedy : null,
            ...kept,
          },
          409,
        );
    }
  };

  /**
   * A stop/drain that held no pid while a live runfile says a daemon IS
   * running. The supervisor reports this rather than claiming `stopped`,
   * because "I signalled nothing and the daemon is still there" and "the
   * daemon is gone" are opposite facts that the console renders identically.
   */
  const notAdopted = (result: StopResult): boolean =>
    !result.stopped && result.reason === "not-adopted";

  const notAdoptedResponse = (verb: string, result: StopResult): Response =>
    json(
      {
        ok: false,
        reason: "not-adopted",
        message: `${verb} reached no daemon: a runfile says one is running, but this manager could not adopt it (a foreign pid, a runfile from another machine, or a process it may not signal). Nothing was signalled.`,
        runfile: result.runfile ?? null,
      },
      409,
    );

  /** True while the supervisor is on its way out — the states in which a
   *  `draining` flag is still telling the truth. */
  const isGoingAway = (handle: HarnessProcess): boolean => {
    const state = handle.snapshot().state;
    return state === "running" || state === "draining";
  };

  /**
   * Where a control call reaches the daemon: the port this Home holds for it, or, for a
   * read of a daemon it has not attached yet, the port its live runfile records.
   */
  const controlTarget = (
    handle: HarnessProcess,
    observed?: RunfileObservation,
  ): {
    harnessDir: string;
    controlPort: number | undefined;
  } => {
    const seen =
      observed?.state === "live" && handle.snapshot().pid === undefined
        ? knownControlPort(observed.runfile.controlPort)
        : undefined;
    return { harnessDir: handle.harnessDir, controlPort: seen ?? handle.controlPort() };
  };

  const schedulersFor = async (
    handle: HarnessProcess,
    observed?: RunfileObservation,
  ): Promise<unknown> => {
    const status = await control.status(controlTarget(handle, observed));
    return buildSchedulersView({
      harnessDir: handle.harnessDir,
      specYaml: readSpecYaml(handle.harnessDir),
      target: handle.target,
      // Cadence is offline-knowable; PHASE is only knowable inside the
      // process that armed the timer, so it appears only when control does.
      ...(status.ok ? { control: status.body } : { controlReason: status.reason }),
    });
  };

  // ---- dispatch -----------------------------------------------------------

  const readBody = async (req: Request): Promise<Record<string, unknown>> => {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      throw new HttpError(400, "invalid JSON body");
    }
    if (!isRecord(parsed)) throw new HttpError(400, "body must be a JSON object");
    return parsed;
  };

  const requireAbsoluteDir = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new HttpError(400, `missing "${field}"`);
    }
    if (!isAbsolute(value)) throw new HttpError(400, `"${field}" must be an absolute path`);
    return resolve(value);
  };

  /**
   * The M3 detail surface — ~180 routes across eleven groups — dispatched
   * from one place.
   *
   * Every guard the M1/M2 branches apply by hand is applied HERE, once, for
   * every M3 route: the `:id` is shape-checked and resolved against the
   * registry (the allowlist), a vanished directory 404s before any handler
   * runs, remaining params were guarded during matching, POST/PUT bodies are
   * proven to be JSON objects, harness-relative reads go through a
   * containment closure, and whatever comes back is masked on the way out.
   *
   * That uniformity is the point: six people are filling these handlers in
   * parallel, and not one of them should be re-deriving path safety.
   */
  const runM3 = async (req: Request, url: URL, match: M3Match): Promise<Response> => {
    const { route, params } = match;
    const perHarness = params["id"] !== undefined;
    let entry: HangarHarnessEntry | null = null;
    let harnessDir: string | null = null;
    if (perHarness) {
      entry = entryOr404(params["id"] as string);
      harnessDir = liveDirOr404(entry);
    }
    const body =
      route.method === "POST" || route.method === "PUT" ? await readBody(req) : ({} as const);
    const dir = harnessDir;
    /** The registered harnesses inside this one, real dirs resolved once per request. */
    let nested: Array<{ readonly id: string; readonly real: string }> | undefined;
    const context: M3Context = {
      entry,
      harnessDir,
      // Only a harness adopted here with `crewhaus harness adopt` (its row carries `home`) has its own code check its spec.
      adopted: entry !== null && runsOwnCode(entry),
      params,
      query: url.searchParams,
      body,
      // Harness `.env` layered over the manager's env — the same picture
      // preflight and spawns see. Values, because a handler may need to sign
      // a synthetic inbound server-side; never serialize one.
      env: dir === null ? env : mergedSpawnEnv(env, dir).env,
      now,
      operator,
      principal: requestCaller().principal,
      authorize: (permission, target) => {
        const access = currentRequestAccess();
        const at = target ?? (entry !== null ? { harness: entry.id } : undefined);
        if (access !== undefined) return access.authorize(permission, at);
        // Outside a request nothing is authorized.
        return { allow: false, needs: permission, role: null };
      },
      contain: (segments) => {
        if (dir === null) throw new HttpError(400, "not a per-harness route");
        // Per FILE, never per directory: a listed name can be a symlink. Home's own
        // records are never read or written through a harness, wherever it is.
        const found = harnessPathOf(dir, hangarRoot, segments);
        if (found.ok) return found.path;
        throw found.reason === "escapes"
          ? new HttpError(400, "path escapes the harness directory")
          : new HttpError(403, "this path holds Home's own records and is not served here");
      },
      harnesses: (): readonly M3Harness[] => liveHarnesses(),
      // Every registered row, not only those this request may read: a harness the caller
      // cannot see is still never read through the one that holds it.
      nestedHarnessAt: (real) => {
        if (dir === null) return undefined;
        nested ??= (() => {
          const own = realOr(dir);
          return registry
            .list()
            .map((row) => ({ id: row.id, real: realOr(row.dir) }))
            .filter((row) => row.real !== own && isWithin(own, row.real));
        })();
        const hit = nested.find((row) => isWithin(row.real, real));
        if (hit === undefined) return undefined;
        return { id: hit.id, visible: context.authorize("h.read", { harness: hit.id }).allow };
      },
      process: async () => {
        if (entry === null) throw new HttpError(400, "not a per-harness route");
        // A read never attaches: only a route that acts adopts before it acts.
        if (req.method === "GET" || req.method === "HEAD") return observedFor(entry).handle;
        return await processFor(entry);
      },
      control,
      jobs: processes.jobs,
      // Each job is checked where it runs (a fleet route's job runs in the server's own
      // directory); `acknowledge` in the request covers this one job and is not kept.
      submitJob: (kind, argv) => {
        const acknowledge = asStringArray(body["acknowledge"]);
        return processes.jobs.submit({
          harnessDir: dir ?? "",
          ...(entry !== null ? { harnessId: entry.id } : {}),
          kind,
          argv,
          ...(acknowledge !== undefined ? { acknowledge } : {}),
          ...commandFields(),
        });
      },
      checkJob: () => {
        const acknowledge = asStringArray(body["acknowledge"]);
        processes.jobs.check({
          harnessDir: dir ?? "",
          ...(acknowledge !== undefined ? { acknowledge } : {}),
        });
      },
      warn: onWarn,
    };
    let result: unknown;
    try {
      result = await route.handler(context);
    } catch (err) {
      // A job refused before it was enqueued answers like `/proc/start`'s gate.
      if (err instanceof JobRefusedError) {
        return json(
          maskDeep(
            { error: err.message, ...jobRefusalBody(err) },
            dir === null ? fleetScrub() : harnessScrub(dir),
          ),
          409,
        );
      }
      // A refusal that carries fields beside its message (a 412's `current`,
      // a 409's `needs`) is masked and scrubbed like any answer.
      if (err instanceof HttpError && err.body !== undefined) {
        return json(
          maskDeep(
            { error: err.message, ...err.body },
            dir === null ? fleetScrub() : harnessScrub(dir),
          ),
          err.status,
        );
      }
      throw err;
    }
    if (result instanceof Response) return result;
    // Masked AND SCRUBBED unconditionally, in one place, so a handler written
    // next month inherits both layers without knowing they exist. Defense in
    // depth, not permission: a handler that reads free text still masks it
    // itself, because key-based redaction cannot see into prose — and the
    // scrubber is the only layer that catches a credential with no shape
    // under an innocent key, which is what leaked from twenty routes.
    return json(maskDeep(result, dir === null ? fleetScrub() : harnessScrub(dir)));
  };

  const handleHarnessSub = async (
    req: Request,
    url: URL,
    entry: HangarHarnessEntry,
    rest: readonly string[],
  ): Promise<Response> => {
    const method = req.method;
    const [head, ...tail] = rest;

    /**
     * ONE EXIT for every M1/M2 per-harness payload — the same guarantee
     * `runM3` gives the detail surface.
     *
     * These branches each called `json()` directly, some with `maskDeep` and
     * some without, which is how the transcript, session-list, spec, eval and
     * run routes ended up echoing an opaque `.env`-held credential while the
     * routes beside them did not. Masking is idempotent, so wrapping a
     * payload a handler already masked costs nothing and the wrapper cannot
     * be forgotten.
     *
     * Built lazily and once per request: a harness whose directory has
     * vanished 404s in the branch, and only then, rather than here.
     */
    let scrubMemo: TextScrubber | undefined;
    const scrubOf = (): TextScrubber => {
      if (scrubMemo === undefined) {
        scrubMemo =
          entry.missingSince === null && existsSync(entry.dir)
            ? harnessScrub(entry.dir)
            : (text) => text;
      }
      return scrubMemo;
    };
    const jsonMasked = (value: unknown, status?: number): Response =>
      json(maskDeep(value, scrubOf()), status);

    if (head === "relocate" && method === "POST" && tail.length === 0) {
      // Moving a harness decides which directory every route on it reads and writes: a
      // person who manages the whole Home's registry does it, never a token.
      const via = requestCaller().via;
      if (via === "service" || via === "scoped" || !requestAllows("home.registry.manage")) {
        throw forbiddenOn("home.registry.manage");
      }
      const body = await readBody(req);
      const newDir = requireAbsoluteDir(body["newDir"], "newDir");
      if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
        throw new HttpError(400, "newDir does not exist");
      }
      const refused = relocationRefusal(
        newDir,
        hangarRoot,
        registry
          .list()
          .filter((other) => other.id !== entry.id)
          .map((other) => other.dir),
      );
      if (refused !== null) throw new HttpError(409, refused);
      try {
        return jsonMasked({ entry: registry.relocate(entry.id, newDir) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }

    if (method === "PUT" && tail.length === 0) {
      const body = await readBody(req);
      if (head === "groups") {
        // `{group, order}` sets this member's BOOT position inside one
        // group — distinct from `{groups}`, which sets membership. Both on
        // one route because they are the same field's two halves, and a
        // caller that sends neither gets told which it meant to send.
        const groupName = body["group"];
        if (typeof groupName === "string" && groupName !== "") {
          const raw = body["order"];
          if (raw !== null && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)) {
            throw new HttpError(400, '"order" must be a positive integer, or null to clear it');
          }
          return jsonMasked({
            entry: registry.setGroupOrder(entry.id, groupName, raw === null ? undefined : raw),
          });
        }
        const groups = asStringArray(body["groups"]);
        if (groups === undefined) {
          throw new HttpError(400, 'missing "groups" string array (or {group, order})');
        }
        return jsonMasked({ entry: registry.setGroups(entry.id, groups) });
      }
      if (head === "tags") {
        const tags = asStringArray(body["tags"]);
        if (tags === undefined) throw new HttpError(400, 'missing "tags" string array');
        return jsonMasked({ entry: registry.setTags(entry.id, tags) });
      }
      if (head === "pin") {
        if (typeof body["pinned"] !== "boolean")
          throw new HttpError(400, 'missing "pinned" boolean');
        return jsonMasked({ entry: registry.setPinned(entry.id, body["pinned"]) });
      }
      if (head === "visibility") {
        // Hide from (or return to) the Library's default view. The entry
        // stays registered with all its state — "don't show all harnesses
        // unless added" is curation, and curation must be reversible.
        if (typeof body["hidden"] !== "boolean")
          throw new HttpError(400, 'missing "hidden" boolean');
        return jsonMasked({ entry: registry.setHidden(entry.id, body["hidden"]) });
      }
      if (head === "notes") {
        if (typeof body["notes"] !== "string") throw new HttpError(400, 'missing "notes" string');
        return jsonMasked({ entry: registry.setNotes(entry.id, body["notes"]) });
      }
      throw new HttpError(404, "not found");
    }

    // ---- M2 writes: process control, control.v1, inboxes, action faces ----
    if (method === "POST") {
      if (head === "deployments" && tail.length === 2 && tail[1] === "activate") {
        const answer = await activateRoute(entry, tail[0] as string, await readBody(req));
        return jsonMasked(answer.body, answer.status);
      }
      if (head === "proc" && tail.length === 1) {
        const verb = tail[0];
        const handle = await processFor(entry);
        if (verb === "start" || verb === "restart") {
          return await startProc(entry, await readBody(req), verb === "restart");
        }
        if (verb === "stop") {
          const result = await handle.supervisor.stop();
          if (notAdopted(result)) return notAdoptedResponse("stop", result);
          return jsonMasked({ ok: true, stopped: result.stopped, forced: result.forced });
        }
        if (verb === "drain") {
          // The supervisor drives the state and awaits the exit; the control
          // call itself is ours. `markDraining` is what makes the imminent
          // exit-0 read as an OPERATOR STOP instead of "exited cleanly
          // (unexpected)" — which would restart what we just shut down.
          // Only when there is a pid to drain, though: with none the drain
          // is either a no-op or a `not-adopted` refusal, and marking either
          // would latch an operator stop no daemon was ever told about.
          if (handle.snapshot().pid !== undefined) handle.markDraining();
          let outcome: ControlResult<unknown> | undefined;
          try {
            const result = await handle.supervisor.drain(async () => {
              outcome = await control.drain(controlTarget(handle));
              if (!outcome.ok) throw new Error(outcome.reason);
            });
            if (notAdopted(result)) return notAdoptedResponse("drain", result);
            return jsonMasked({
              ok: true,
              stopped: result.stopped,
              // True when control.v1 was unavailable and the supervisor fell
              // back to SIGTERM — an honest degradation, not a failure.
              viaSignal: outcome === undefined || !outcome.ok,
              control: outcome === undefined ? null : controlEnvelope(outcome),
            });
          } finally {
            // A drain that did not actually take the daemon away must not
            // leave the flag latched: nothing else ever clears it (only an
            // `exit` event does) and every process verb in the console reads
            // it. A real drain has already cleared it via that exit.
            if (!isGoingAway(handle)) handle.clearDraining();
          }
        }
        throw new HttpError(404, "not found");
      }

      if (head === "control" && tail.length === 1) {
        const handle = await processFor(entry);
        if (tail[0] === "wake") {
          const body = await readBody(req);
          const lane = body["lane"];
          if (typeof lane !== "string" || !isControlLane(lane)) {
            throw new HttpError(400, 'missing "lane": heartbeat, schedule or schedule:<name>');
          }
          const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
          return jsonMasked(
            controlEnvelope(
              await control.wake(controlTarget(handle), {
                lane,
                ...(reason !== undefined ? { reason } : {}),
                by: requestCaller().principal,
              }),
            ),
          );
        }
        if (tail[0] === "drain") {
          // Through the supervisor, as `/proc/drain` is: the control call is ours, and
          // when it is refused the supervisor stops the daemon by signal, so a drain from
          // Home always ends with the daemon stopped. The answer stays the control call's
          // envelope, plus `stopped`, and `viaSignal` when the signal stopped it.
          if (handle.snapshot().pid !== undefined) handle.markDraining();
          let outcome: ControlResult<unknown> | undefined;
          try {
            const result = await handle.supervisor.drain(async () => {
              outcome = await control.drain(controlTarget(handle));
              if (!outcome.ok) throw new Error(outcome.reason);
            });
            if (notAdopted(result)) return notAdoptedResponse("drain", result);
            const envelope =
              outcome !== undefined
                ? controlEnvelope(outcome)
                : controlEnvelope({
                    ok: false,
                    code: "no_control_port",
                    status: 0,
                    reason: "the daemon is not running",
                    retryable: false,
                    expected: true,
                  });
            const viaSignal = outcome !== undefined && !outcome.ok && result.stopped;
            return jsonMasked({
              ...envelope,
              stopped: result.stopped,
              ...(viaSignal ? { viaSignal: true } : {}),
            });
          } finally {
            // As `/proc/drain`: a drain that did not take the daemon away must not leave
            // the display flag latched.
            if (!isGoingAway(handle)) handle.clearDraining();
          }
        }
        throw new HttpError(404, "not found");
      }

      if (head === "approvals" && tail.length === 2) {
        const apprId = tail[0] as string;
        const verb = tail[1];
        if (!isApprovalId(apprId)) throw new HttpError(400, "invalid approval id");
        if (verb !== "grant" && verb !== "deny") throw new HttpError(404, "not found");
        await readBody(req);
        // The decision counts as the signed-in principal, decided by their class, and names
        // them; Home's own key and a Home with sign-in off are shown with Home's label. A
        // `by` in the body is not who decided.
        const caller = requestCaller();
        const actor: Parameters<typeof resolveApproval>[0]["actor"] = {
          kind: "principal",
          principal: caller.principal,
          ...(caller.via === "service" ? { service: true as const } : {}),
          display: caller.actor === null ? operator : caller.principal,
        };
        const result = await resolveApproval({
          decisions: controlService.decisions,
          harnessDir: liveDirOr404(entry),
          approvalId: apprId,
          decision: verb === "grant" ? "grant" : "deny",
          actor,
        });
        if (result.outcome === "not-found") throw new HttpError(404, "no such approval");
        if (result.outcome === "unreachable") throw new HttpError(409, result.reason);
        if (result.outcome === "forbidden") throw new HttpError(403, result.reason);
        if (result.outcome === "invalid") throw new HttpError(400, result.reason);
        if (result.outcome !== "resolved") {
          // The first decision stands: say what state it left, never who made it.
          throw new HttpError(409, refusedDecisionMessage(result.outcome, result.approval));
        }
        return jsonMasked({ ok: true, approval: result.approval });
      }

      if (head === "review" && tail.length === 1) {
        const itemId = tail[0] as string;
        if (!SAFE_SEGMENT_RE.test(itemId)) throw new HttpError(400, "invalid review item id");
        const body = await readBody(req);
        const verdict = body["verdict"];
        if (typeof verdict !== "string" || !isReviewVerdict(verdict)) {
          throw new HttpError(400, 'missing "verdict" — one of: up, down, pass, fail');
        }
        const note = typeof body["note"] === "string" ? body["note"] : undefined;
        const result = await adjudicateReview({
          harnessDir: liveDirOr404(entry),
          itemId,
          verdict,
          ...(note !== undefined ? { note } : {}),
          by: requestCaller().principal,
          nowIso: new Date(now()).toISOString(),
        });
        if (result.outcome === "not-found") throw new HttpError(404, "no such review item");
        if (result.outcome === "rejected") throw new HttpError(409, result.reason);
        if (result.outcome === "already-resolved") {
          return jsonMasked({ ok: true, alreadyResolved: true, entry: result.entry });
        }
        return jsonMasked({
          ok: true,
          alreadyResolved: false,
          entry: result.entry,
          adjudicated: result.adjudicated,
        });
      }

      if (head === "jobs" && tail.length === 0) {
        const dir = liveDirOr404(entry);
        const body = await readBody(req);
        const kind = body["kind"];
        if (typeof kind !== "string" || !isJobKind(kind)) {
          throw new HttpError(400, 'missing "kind" — one of: doctor, compile, eval, dream-run');
        }
        // Each kind needs the permission its own route needs.
        const needed = JOB_KIND_PERMISSIONS[kind] ?? "h.job.run";
        if (!requestAllows(needed, entry.id)) throw forbiddenOn(needed, entry.id);
        let argv: string[];
        try {
          argv = jobArgv(
            kind,
            kind === "eval"
              ? evalJobOptions(body, launchOffers(dir, entry.target))
              : {
                  ...(typeof body["dataset"] === "string" ? { dataset: body["dataset"] } : {}),
                  ...(typeof body["graders"] === "string" ? { graders: body["graders"] } : {}),
                },
          );
        } catch (err) {
          if (err instanceof JobArgumentError) throw new HttpError(400, err.message);
          throw err;
        }
        // Acknowledged for this one job: the record carries no trace of it.
        const acknowledge = asStringArray(body["acknowledge"]);
        let record: ReturnType<ProcessLayer["jobs"]["submit"]>;
        try {
          record = processes.jobs.submit({
            harnessDir: dir,
            harnessId: entry.id,
            kind,
            argv,
            ...(acknowledge !== undefined ? { acknowledge } : {}),
            ...commandFields(),
          });
        } catch (err) {
          if (err instanceof JobRefusedError) return json(jobRefusalBody(err), 409);
          throw err;
        }
        return jsonMasked({ ok: true, job: record }, 202);
      }

      if (head === "sessions" && tail.length === 2 && tail[1] === "pin") {
        const sess = tail[0] as string;
        if (!isSessionId(sess)) throw new HttpError(400, "invalid session id");
        const body = await readBody(req);
        if (typeof body["pinned"] !== "boolean")
          throw new HttpError(400, 'missing "pinned" boolean');
        const result = await pinSession({
          harnessDir: liveDirOr404(entry),
          sessionId: sess,
          pinned: body["pinned"],
          now,
        });
        if (result.outcome === "rejected") throw new HttpError(409, result.reason);
        return jsonMasked({
          ok: true,
          pinned: result.pinned,
          pins: result.pins,
          changed: result.changed,
        });
      }

      if (head === "evals" && tail.length === 1 && tail[0] === "baseline") {
        const body = await readBody(req);
        const runId = body["runId"];
        if (typeof runId !== "string" || !isRunId(runId)) {
          throw new HttpError(400, 'missing "runId" (run_<16 hex>)');
        }
        const confirmName = body["confirmName"];
        const result = pinBaseline({
          harnessDir: liveDirOr404(entry),
          runId,
          nowIso: new Date(now()).toISOString(),
          ...(typeof confirmName === "string" ? { confirmName } : {}),
        });
        if (result.outcome === "rejected") throw new HttpError(409, result.reason);
        if (result.outcome === "needs_owner") {
          // The owner's escalation, as a protected criterion's loosening asks:
          // answered, not thrown, so its fields reach the caller.
          return jsonMasked(
            {
              error: result.reason,
              needs: "h.spec.edit.security",
              confirmName: result.confirmName,
            },
            409,
          );
        }
        return jsonMasked({ ok: true, baseline: result.baseline });
      }

      throw new HttpError(404, "not found");
    }

    if (method !== "GET") throw new HttpError(405, "method not allowed");

    if (head === "proc" && tail.length === 0) {
      // A read: it observes the runfile and attaches nothing.
      const { handle, observed } = observedFor(entry);
      // maskDeep on the way out: the runfile and the plan preview carry
      // operator-supplied strings (env overrides, a bundle path, a control
      // token PATH) that no route should be trusted to have pre-filtered.
      return jsonMasked(procView(entry, handle, observed));
    }
    if (head === "runs" && tail.length === 0) {
      return jsonMasked(runsView(liveDirOr404(entry)));
    }
    if (head === "runs" && tail.length >= 1 && tail.length <= 2) {
      const runId = tail[0] as string;
      if (!isSupervisorRunId(runId)) throw new HttpError(400, "invalid run id");
      const dir = liveDirOr404(entry);
      const { handle } = observedFor(entry);
      const snapshot = handle.snapshot();
      // Every state the pump still serves, not just `running`: a drain can
      // take ~30 s, and "watch the live run" is what the operator clicks the
      // moment they start one.
      const live = snapshot.runId === runId && isLiveFeedState(snapshot.state);
      const detail = runDetail(dir, runId, { live, env });
      if (detail === undefined) throw new HttpError(404, "no such run");
      // maskDeep: `proseTail` is built from the RAW capture file, so the env
      // scrubber is only half the story — a credential with no env entry at
      // all is caught by shape or not at all.
      if (tail.length === 1) return jsonMasked(detail);
      if (tail[1] !== "events") throw new HttpError(404, "not found");
      // SSE. `replay` first (durable history), `done` always last — a
      // terminal frame is what lets a client tell "finished" from "the
      // connection dropped", and it is what makes this testable with no
      // live process.
      const stream = streamSignal(req);
      return runEventStream({
        harnessDir: dir,
        runId,
        replay: detail,
        live,
        // The SSE body bypasses `jsonMasked`, so the third layer has to be
        // handed to the stream explicitly — the `replay` frame is the same
        // object `GET /runs/:runId` serves, and the two must not disagree.
        scrub: harnessScrub(dir),
        ...(live ? { subscribe: handle.supervisor.subscribe } : {}),
        ...(opts.sseHeartbeatMs !== undefined ? { heartbeatMs: opts.sseHeartbeatMs } : {}),
        ...(stream.signal !== undefined ? { signal: stream.signal } : {}),
        dispose: stream.dispose,
      });
    }
    if (head === "control" && tail.length === 1 && tail[0] === "status") {
      const { handle, observed } = observedFor(entry);
      return jsonMasked(controlEnvelope(await control.status(controlTarget(handle, observed))));
    }
    if (head === "schedulers" && tail.length === 0) {
      const { handle, observed } = observedFor(entry);
      return jsonMasked(await schedulersFor(handle, observed));
    }
    if (head === "deployments" && tail.length === 0) {
      return jsonMasked(deploymentsView(liveDirOr404(entry)));
    }

    if (head === "spec" && tail.length === 0) {
      const view = specView(liveDirOr404(entry), env);
      // A SCOPED ALLOWLIST, which is the pattern `mask.ts` prescribes for a
      // field that must keep a credential-shaped name. `envRefs[].key` is an
      // env variable NAME and `key` is an exact credential-key match, so the
      // generic masker redacts the one thing the env panel exists to show —
      // while no VALUE is in that field at all (`set` is a boolean, and the
      // whole point of `envRefs` is that values never leave the server). The
      // names ride around the masker; the spec TEXT still goes through it,
      // which is where an inline credential would actually be.
      const masked = maskDeep({ ...view, envRefs: [] }, scrubOf()) as Record<string, unknown>;
      return json({ ...masked, envRefs: view.envRefs });
    }
    if (head === "preflight" && tail.length === 0) {
      const dir = liveDirOr404(entry);
      const merged = mergedSpawnEnv(env, dir);
      const report = await runPreflight({ harnessDir: dir, env: merged.env });
      // maskDeep: a preflight lint may quote a literal it found in the spec
      // (e.g. the pasted-credential MCP lint) — mask before serializing.
      return jsonMasked({ report, envFiles: merged.envFiles });
    }
    if (head === "sessions" && tail.length === 0) {
      const dir = liveDirOr404(entry);
      // `pins` rides along so the list can badge protected transcripts and
      // the pin action face has a visible effect on re-read.
      return jsonMasked({ ...listSessions(dir, now()), pins: readPins(dir) });
    }
    if (head === "sessions" && tail.length === 1) {
      const sess = tail[0] as string;
      if (!isSessionId(sess)) throw new HttpError(400, "invalid session id");
      const dir = liveDirOr404(entry);
      const rootInfo = resolveSessionRoot(dir);
      if (url.searchParams.get("raw") !== null) {
        // The raw lines are the run's record as written: its owner's to read.
        if (!requestAllows("h.files.raw", entry.id)) throw forbiddenOn("h.files.raw", entry.id);
        const raw = readTranscriptRaw(rootInfo.root, sess);
        if (raw === undefined) throw new HttpError(404, "no transcript recorded yet");
        return jsonMasked(raw);
      }
      const view = readTranscript(rootInfo.root, sess);
      if (view !== undefined) return jsonMasked(view);
      // Fall through to the durable index for evicted sessions. Resolved
      // from the HARNESS dir (an overridden session root's parent is not
      // ours), containment-checked, and masked like every other payload.
      const indexPath = resolveInside(dir, [".crewhaus", "sessions-index", `${sess}.json`]);
      if (indexPath === undefined) throw new HttpError(404, "no session recorded yet");
      try {
        const summary: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
        return jsonMasked({ id: sess, evicted: true, summary });
      } catch {
        throw new HttpError(404, "no session recorded yet");
      }
    }
    if (head === "evals" && tail.length === 0) {
      return jsonMasked(evalsView(liveDirOr404(entry)));
    }
    if (head === "evals" && tail.length >= 1 && tail.length <= 2) {
      const runId = tail[0] as string;
      if (!isRunId(runId)) throw new HttpError(400, "invalid run id");
      const dir = liveDirOr404(entry);
      if (tail.length === 1) {
        const view = evalRunView(dir, runId);
        if (view === undefined) throw new HttpError(404, "no such eval run");
        // maskDeep: eval artifacts embed agent transcripts — mask token
        // shapes before serializing (defense in depth).
        return jsonMasked(view);
      }
      const sampleId = tail[1] as string;
      if (!SAFE_SEGMENT_RE.test(sampleId)) throw new HttpError(400, "invalid sample id");
      const view = evalSampleView(dir, runId, sampleId);
      if (view === undefined) throw new HttpError(404, "no such sample");
      return jsonMasked(view);
    }
    if (head === "memory" && tail.length >= 1 && tail.length <= 2) {
      const area = tail[0] as string;
      const dir = liveDirOr404(entry);
      if (tail.length === 2) {
        if (area !== "wiki") throw new HttpError(404, "not found");
        const article = wikiArticle(dir, tail[1] as string);
        if (article === undefined) throw new HttpError(404, "no such article");
        return jsonMasked(article);
      }
      if (!isMemoryArea(area)) throw new HttpError(404, "not found");
      switch (area) {
        case "facts":
          return jsonMasked(factsView(dir, now()));
        case "wiki":
          return jsonMasked(wikiView(dir));
        case "state":
          return jsonMasked(stateView(dir));
        case "dream":
          return jsonMasked(dreamView(dir));
        case "watchme":
          return jsonMasked(watchmeView(dir));
      }
    }
    if (head === "costs" && tail.length === 0) {
      return jsonMasked({ id: entry.id, costs: foldHarnessCosts(liveDirOr404(entry), now()) });
    }
    // ---- M4 -------------------------------------------------------------
    if (head === "health" && tail.length === 0 && method === "GET") {
      return jsonMasked({ id: entry.id, health: await healthFor(entry) });
    }
    if (head === "panes" && tail.length === 0 && method === "GET") {
      const dir = liveDirOr404(entry);
      const inventory = readPluginInventory(pluginsDir);
      return jsonMasked({
        id: entry.id,
        // Both extension points, evaluated against the SAME fail-closed
        // filesystem permission: a plugin that may not read this harness
        // neither draws a tab on it nor sees its trace events.
        panes: panesForHarness(inventory.plugins, dir).map((row) => ({
          plugin: row.plugin,
          id: row.pane.id,
          title: row.pane.title,
          sandbox: row.sandbox,
        })),
        traceObservers: traceObservers(inventory.plugins, dir),
        deferred: inventory.deferred,
      });
    }
    throw new HttpError(404, "not found");
  };

  const api = async (req: Request, url: URL, segs: readonly string[]): Promise<Response> => {
    const method = req.method;
    const [head, ...rest] = segs;

    // M3 first, and literal-first inside it: a template whose segments are
    // all literals beats one with a param, so `GET …/evals/matrix` matches
    // the M3 route while `GET …/evals/run_…` falls through to the M2 branch
    // below untouched. A param that fails its shape guard does not match at
    // all, so a malformed id still meets the M1/M2 chain's own 400.
    if (head === "v1") return await v1Router.handle(req, url, segs);

    const m3 = matchM3(method, ["api", ...segs]);
    if (m3 !== undefined) return await runM3(req, url, m3);

    if (head === "version" && rest.length === 0 && method === "GET") {
      return json({ hangar: version, protocolV: PROTOCOL_V, api: [PROTOCOL_ID] });
    }

    // Mint a fresh single-use browser handoff. `crewhaus hangar open` reads
    // Home's own key from disk (it already has filesystem access to it) and
    // trades it, over `home.sock`, for a path safe to put on a command line.
    if (head === "boot-ticket" && rest.length === 0 && method === "POST") {
      if (tokenSetup === undefined) throw new HttpError(409, "auth is disabled; open / directly");
      // Home's own key only: a browser session, even the owner's, cannot mint sign-in
      // links for other browsers.
      const caller = callers.get(req);
      if (caller?.kind !== "principal" || caller.via !== "bootstrap") {
        return json(
          {
            error: "Only Home's own key, on this computer, can make a sign-in link.",
            code: "authorization_unavailable",
            reason: "owner_only",
          },
          403,
        );
      }
      return json({ bootPath: signIn.mintBootTicket() });
    }

    if (head === "harnesses" && rest.length === 0) {
      if (method === "GET") {
        return json(maskDeep(harnessRows(url.searchParams.get("hydrate") !== null), fleetScrub()));
      }
      if (method === "POST") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new HttpError(400, "dir does not exist");
        }
        const warnings: string[] = [];
        const specPath = join(dir, "crewhaus.yaml");
        let header: { name?: string; target?: string } = {};
        if (!existsSync(specPath)) {
          warnings.push("no crewhaus.yaml in dir — registered anyway (spec unreadable)");
        } else {
          header = readHeaderSafe(dir);
          if (header.name === undefined && header.target === undefined) {
            warnings.push("crewhaus.yaml present but no name/target could be read");
          }
        }
        const entry = registry.upsert({
          dir,
          ...(header.name !== undefined ? { specName: header.name } : {}),
          ...(header.target !== undefined ? { target: header.target } : {}),
          origin: "manual",
          originDetail: "api",
        });
        return json({ entry, warnings }, 201);
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "registry" && rest[0] === "groups" && rest.length === 1) {
      if (method === "GET") return json({ groups: visibleGroups() });
      if (method === "POST") {
        const body = await readBody(req);
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name"');
        }
        const color = typeof body["color"] === "string" ? body["color"] : undefined;
        return json(
          { group: registry.addGroup({ name, ...(color !== undefined ? { color } : {}) }) },
          201,
        );
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const order = asStringArray(body["order"]);
        if (order !== undefined) return json({ groups: registry.reorderGroups(order) });
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name" (or "order" array)');
        }
        const rename = typeof body["rename"] === "string" ? body["rename"] : undefined;
        const color = typeof body["color"] === "string" ? body["color"] : undefined;
        try {
          const group = registry.updateGroup(name, {
            ...(rename !== undefined ? { name: rename } : {}),
            ...(color !== undefined ? { color } : {}),
          });
          if (group === undefined) throw new HttpError(404, "no such group");
          return json({ group });
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(409, err instanceof Error ? err.message : String(err));
        }
      }
      if (method === "DELETE") {
        const body = await readBody(req);
        const name = body["name"];
        if (typeof name !== "string" || name.length === 0) {
          throw new HttpError(400, 'missing "name"');
        }
        return json({ removed: registry.removeGroup(name) });
      }
      throw new HttpError(405, "method not allowed");
    }

    // GET  /api/registry/groups/:name/proc/:verb  — the PLAN, in walk order
    // POST /api/registry/groups/:name/proc/:verb  — do it
    //
    // Plan-then-act on purpose: a fleet sweep is the one lifecycle action an
    // operator should be able to READ before authorizing, and the plan is
    // the same object the walk consumes, so what is shown is what runs.
    if (head === "registry" && rest[0] === "groups" && rest[2] === "proc" && rest.length === 4) {
      const groupName = rest[1] as string;
      const verb = rest[3] as string;
      if (!isGroupVerb(verb)) {
        throw new HttpError(
          400,
          `unknown group verb "${verb}" (expected: ${GROUP_VERBS.join(" | ")})`,
        );
      }
      if (visibleGroups().every((g) => g.name !== groupName)) {
        throw new HttpError(404, `no group "${groupName}"`);
      }
      const plan = narrowPlan(
        groupPlan(registry, groupName, verb, { live: (dir) => existsSync(dir) }),
        method === "POST",
      );
      if (method === "GET") return json({ plan });
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      if (plan.members.length === 0) {
        throw new HttpError(409, `group "${groupName}" has no members`);
      }
      const body = await readBody(req);
      const acknowledge = asStringArray(body["acknowledge"]);
      const gateOptions = {
        ...(body["force"] === true ? { force: true } : {}),
        ...(acknowledge !== undefined ? { acknowledge } : {}),
      };
      const result = await runGroup(
        plan,
        async (member) => {
          const entry = registry.get(member.id);
          if (entry === undefined) return { ok: false, message: "no longer registered" };
          const handle = await processFor(entry);
          if (verb === "stop") {
            const stopped = await handle.supervisor.stop();
            handle.clearDraining();
            return stopped.stopped
              ? { ok: true, message: `stopped${stopped.forced ? " (SIGKILL)" : ""}` }
              : {
                  ok: false,
                  message:
                    "NOT stopped — a live daemon holds the runfile but was not adopted; nothing was signalled",
                  reason: "not-adopted",
                };
          }
          const started =
            verb === "restart"
              ? await handle.supervisor.restart(gateOptions)
              : await handle.supervisor.start(gateOptions);
          if (started.ok) {
            handle.clearDraining();
            return { ok: true, message: `${verb}ed ${started.runId}`, runId: started.runId };
          }
          return {
            ok: false,
            message: groupRefusalMessage(started),
            reason: started.reason,
            // A restart refused before it stopped anything: the member keeps running.
            ...(started.kept === true ? { running: true } : {}),
          };
        },
        { parallel: body["parallel"] === true },
      );
      // 207: some members succeeded and some did not, which is the normal
      // outcome of a sweep and must not read as a total failure.
      return json({ result }, result.failed === 0 ? 200 : 207);
    }

    if (head === "registry" && rest[0] === "scan-roots" && rest.length === 1) {
      if (method === "GET") {
        return json(gateScanRoots(() => registry.listScanRoots(), requestAllows(REGISTRY_MANAGE)));
      }
      if (method === "POST") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        const fields = {
          dir,
          ...(typeof body["depth"] === "number" ? { depth: body["depth"] } : {}),
          ...(typeof body["auto"] === "boolean" ? { auto: body["auto"] } : {}),
          ...(typeof body["rescanIntervalMin"] === "number"
            ? { rescanIntervalMin: body["rescanIntervalMin"] }
            : {}),
        };
        return json({ scanRoot: registry.addScanRoot(fields) }, 201);
      }
      if (method === "DELETE") {
        const body = await readBody(req);
        const dir = requireAbsoluteDir(body["dir"], "dir");
        return json({ removed: registry.removeScanRoot(dir) });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "registry" && rest[0] === "discover" && rest.length === 1) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(discoverView());
    }

    if (head === "scan" && rest.length === 0) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return json(scanAll());
    }

    if (head === "costs" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(fleetCosts());
    }

    // ---- M4: the fleet health board, onboarding, ⌘K, notifications ------
    // `/api/health` runs a preflight per harness, so it is the "needs
    // attention" board an operator opens — never the first paint. The
    // Library's own row keeps using the cached rollup.
    if (head === "health" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const rows: unknown[] = [];
      for (const entry of visibleEntries()) {
        if (entry.missingSince !== null || !existsSync(entry.dir)) continue;
        rows.push({ id: entry.id, specName: entry.specName, health: await healthFor(entry) });
      }
      return json(maskDeep({ harnesses: rows }, fleetScrub()));
    }

    if (head === "onboarding" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        gateOnboarding(
          {
            harnessCount: visibleEntries().length,
            completedAt: settings.get().onboarding.completedAt,
            scanRootCount: () => registry.listScanRoots().length,
            suggestions: () => suggestScanRoots(env, homedir(), cwd),
            demo: () => demoAvailability(env, demosDir),
          },
          requestAllows(REGISTRY_MANAGE),
        ),
      );
    }

    if (head === "onboarding" && rest[0] === "demo" && rest.length === 1) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await readBody(req);
      const availability = demoAvailability(env, demosDir);
      if (!availability.available || availability.source === null) {
        // 409, not 500: nothing is broken — a checkout is missing, and the
        // answer names the repo, the variable and the CLI verb.
        return json(
          {
            ok: false,
            reason: "no-demos-checkout",
            message: availability.reason,
            remedy: availability.remedy,
          },
          409,
        );
      }
      const starter = requireString(body, "starter");
      const destDir = requireAbsoluteDir(body["dir"], "dir");
      let install: ReturnType<typeof installStarter>;
      try {
        install = installStarter({ demosDir: availability.source, starter, destDir });
      } catch (err) {
        if (err instanceof StarterInstallError) {
          return json(
            { ok: false, reason: "refused", message: err.message, remedy: err.remedy },
            409,
          );
        }
        throw err;
      }
      const header = readHeaderSafe(install.dir);
      const entry = registry.upsert({
        dir: install.dir,
        ...(header.name !== undefined ? { specName: header.name } : {}),
        ...(header.target !== undefined ? { target: header.target } : {}),
        origin: "manual",
        originDetail: "demo",
      });
      settings.update({ onboarding: { completedAt: new Date(now()).toISOString() } });
      return json({ ok: true, entry, install }, 201);
    }

    if (head === "search" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const q = url.searchParams.get("q") ?? "";
      const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : OMNI_LIMIT;
      return json(maskDeep(omni.search(q, indexHarnesses(), limit), fleetScrub()));
    }

    if (head === "notifications" && rest.length === 0) {
      if (method === "GET") return json(maskDeep(notificationsView(), fleetScrub()));
      if (method === "PUT") {
        const body = await readBody(req);
        // Every field here is Home's, one block shared by everyone (the rules, quiet hours,
        // muted groups and the webhook): changing any of them is managing Home's settings.
        const current = settings.get().notifications as Readonly<Record<string, unknown>>;
        const changes = HOME_NOTIFICATION_FIELDS.some(
          (field) =>
            Object.hasOwn(body, field) &&
            JSON.stringify(body[field]) !== JSON.stringify(current[field]),
        );
        if (changes && !requestAllows("home.settings.manage")) {
          throw forbiddenOn("home.settings.manage");
        }
        try {
          settings.update({ notifications: body });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        // A write to the rules: one notifications tick runs before the answer, so the
        // screen shows what the rules just saved deliver.
        await scheduler.runNow("notifications");
        return json(maskDeep(notificationsView(), fleetScrub()));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "notifications" && rest[0] === "clear" && rest.length === 1) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      // The queue is Home's: a caller clears the entries it may read, and the rest stay.
      notifications.clearWhere((d) => visibleToRequest(d.harnessId));
      return json({ ok: true, badge: 0 });
    }

    if (head === "read-only" && rest.length === 0) {
      if (method === "GET") {
        return json({
          enabled: readOnlyNow(),
          locked: readOnlyLocked,
          exempt: readOnlyExempt(),
          note: "read-only mode prevents accidents during a demo or screen-share; who may do what is decided per route, not by this toggle",
        });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const enabled = requireBoolean(body, "enabled");
        if (readOnlyLocked && !enabled) {
          return json(
            {
              ok: false,
              reason: "locked",
              message:
                "this manager was started with read-only LOCKED — the mode cannot be lifted over the wire",
              remedy: "restart the manager without --read-only",
            },
            409,
          );
        }
        // Both, so the change takes effect now AND is what the next boot
        // starts from — an explicit toggle is a preference, unlike a flag.
        sessionReadOnly = enabled;
        settings.update({ readOnly: enabled });
        return json({ ok: true, enabled: readOnlyNow(), locked: readOnlyLocked });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "plugins" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(maskDeep(readPluginInventory(pluginsDir), fleetScrub()));
    }

    if (head === "plugins" && rest.length === 3 && rest[1] === "panes") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const name = rest[0] as string;
      const paneId = rest[2] as string;
      if (!SAFE_SEGMENT_RE.test(name) || !SAFE_SEGMENT_RE.test(paneId)) {
        throw new HttpError(400, "invalid plugin or pane id");
      }
      const plugin = readPluginInventory(pluginsDir).plugins.find((p) => p.name === name);
      if (plugin === undefined) throw new HttpError(404, "no such plugin");
      const doc = readPaneDocument(plugin, paneId);
      if (doc === undefined) throw new HttpError(404, "no such pane");
      // NOT masked: the pane document is the plugin's own markup, and
      // maskDeep would rewrite its text. It is contained by the sandbox and
      // the CSP that travel with it, which is the containment that matters.
      // The frame loads it from a single-use address that serves it with that
      // CSP and sandbox as headers: a `srcdoc` frame would inherit the
      // console's own policy, which runs no inline script.
      const at = now();
      for (const [key, entry] of paneDocs) if (entry.expiry <= at) paneDocs.delete(key);
      while (paneDocs.size >= PANE_LINK_CAP) {
        const oldest = paneDocs.keys().next();
        if (oldest.done === true) break;
        paneDocs.delete(oldest.value);
      }
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
      paneDocs.set(nonce, { doc: doc.doc, csp: doc.csp, expiry: at + PANE_LINK_TTL_MS });
      return json({ ...doc, src: `/pane/${nonce}` });
    }

    // ---- M2 fleet inboxes ---------------------------------------------
    // Every fleet fold quotes free text out of harnesses this request never
    // names — a tool input a policy parked for approval, a quarantined
    // sample, an activity label — so all three carry the fleet scrubber as
    // well as the masker.
    if (head === "approvals" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        maskDeep(
          approvalsInbox(liveHarnesses(), {
            includeSettled: url.searchParams.get("all") !== null,
            showsContent: contentVisibleToRequest,
          }),
          fleetScrub(),
        ),
      );
    }

    if (head === "review" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        maskDeep(
          reviewInbox(liveHarnesses(), {
            includeResolved: url.searchParams.get("all") !== null,
            showsContent: contentVisibleToRequest,
          }),
          fleetScrub(),
        ),
      );
    }

    if (head === "activity" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const since = parseSince(url.searchParams.get("since"), now(), DEFAULT_ACTIVITY_WINDOW_MS);
      const harnesses = liveHarnesses();
      const recovered = recoveryItems(readRecoveryReport(hangarRoot), harnesses, since);
      return json(maskDeep(activityDigest(harnesses, since, recovered), fleetScrub()));
    }

    if (head === "jobs" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      // `recent` folds terminal jobs from the persisted ledger. Without it a
      // job vanishes the instant it finishes and `interrupted` — the state
      // restore() assigns to work a dead manager abandoned — is never
      // visible to the operator it exists to inform.
      const limitRaw = url.searchParams.get("recent");
      const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
      // Only the jobs of harnesses this caller may read.
      const mine = <T extends { readonly harnessId?: string }>(jobs: readonly T[]): T[] =>
        jobs.filter((job) => job.harnessId === undefined || visibleToRequest(job.harnessId));
      return json({
        pending: mine(processes.jobs.pending()),
        running: mine(processes.jobs.running()),
        recent: mine(
          processes.jobs.recent(limit !== undefined && Number.isFinite(limit) ? limit : undefined),
        ),
      });
    }

    // 0.8.0 (design §12 item 5) — the proof bundles a run's provability gate
    // persisted, keyed by the session id a gateway run answers with (or, for
    // a research run, its run id: the report bundle beside report.md). Fleet-
    // wide (a session id names its harness only implicitly); `?harness=`
    // narrows it to one registry row. Each harness's bundles are masked with
    // that harness's OWN scrubber — claim text is model prose and an excerpt
    // is a fetched body's words — and the whole payload once more on the way
    // out. 404 when the run persisted none.
    if (head === "runs" && rest.length === 2 && rest[1] === "proof") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const runId = rest[0] as string;
      if (!isProofRunId(runId)) {
        throw new HttpError(
          400,
          "invalid run id — expected the run's session id (sess_<16 hex>) or a research run's id (run_<16 hex>)",
        );
      }
      const scope = url.searchParams.get("harness");
      const entries =
        scope === null
          ? visibleEntries().filter(
              (e) => e.missingSince === null && existsSync(e.dir) && contentVisibleToRequest(e.id),
            )
          : (() => {
              const entry = entryOr404(scope);
              liveDirOr404(entry);
              return [entry];
            })();
      // A managed harness's turns run under a tenant, and its gate files
      // bundles under that tenant's root, not `.crewhaus/proofs`.
      const harnesses = entries.map((e) => {
        const tenants = proofTenants(e.dir, e.target);
        return {
          id: e.id,
          dir: e.dir,
          specName: e.specName,
          ...(tenants !== undefined ? { tenants } : {}),
        };
      });
      const view = proofView(harnesses, runId);
      if (view.bundles.length === 0 && view.skipped.length === 0) {
        const roots = [...new Set((view.tenantRootsNotRead ?? []).map((o) => o.root))];
        const [onlyRoot] = roots;
        const rootFlag =
          onlyRoot !== undefined && roots.length === 1 ? shellQuote(onlyRoot) : "<root>";
        throw new HttpError(
          404,
          roots.length === 0
            ? `no proof bundle persisted for ${runId}`
            : `no proof bundle persisted for ${runId} under a harness directory — a managed harness files its bundles under its tenants root (${roots.join(
                ", ",
              )}), outside the harness directory, which Hangar does not read: run \`crewhaus provability show --session ${shellQuote(runId)} --tenants-root ${rootFlag}\` from the harness directory`,
        );
      }
      // One scrubber per harness (each reads that harness's `.env` chain),
      // not one per bundle row.
      const scrubs = new Map<string, TextScrubber>();
      const scrubFor = (id: string): TextScrubber => {
        let scrub = scrubs.get(id);
        if (scrub === undefined) {
          const dir = harnesses.find((h) => h.id === id)?.dir;
          scrub = dir !== undefined ? harnessScrub(dir) : (text: string): string => text;
          scrubs.set(id, scrub);
        }
        return scrub;
      };
      const masked = {
        ...view,
        bundles: view.bundles.map((row) => maskDeep(row, scrubFor(row.harnessId))),
      };
      return json(maskDeep(masked, fleetScrub()));
    }

    if (head === "h" && rest.length >= 1) {
      const entry = entryOr404(rest[0] as string);
      if (rest.length === 1) {
        if (method === "GET") {
          return json(
            maskDeep(
              await detailView(entry),
              entry.missingSince === null && existsSync(entry.dir)
                ? harnessScrub(entry.dir)
                : undefined,
            ),
          );
        }
        if (method === "DELETE") return json({ removed: registry.remove(entry.id) });
        throw new HttpError(405, "method not allowed");
      }
      return handleHarnessSub(req, url, entry, rest.slice(1));
    }

    throw new HttpError(404, "not found");
  };

  // ---- static shell -------------------------------------------------------

  const builtinIndex = (): Response => {
    const routes = [
      "GET  /healthz",
      "GET  /boot/:nonce   (a single-use sign-in link)",
      ...SIGN_IN_ROUTES.map((r) => `${r.method.padEnd(4)} ${r.path}`),
      "POST /api/boot-ticket   (Home's own key only)",
      "GET  /api/version",
      "GET  /api/harnesses[?hydrate=1]   POST /api/harnesses {dir}",
      "GET|POST|PUT|DELETE /api/registry/groups",
      "GET|POST /api/registry/groups/:name/proc/{start,stop,restart}",
      "GET|POST|DELETE /api/registry/scan-roots",
      "GET  /api/registry/discover",
      "POST /api/scan",
      "PUT  /api/h/:id/visibility",
      "GET  /api/advisor    GET|POST /api/h/:id/advisor/…",
      "GET  /api/costs",
      "GET|DELETE /api/h/:id    POST /api/h/:id/relocate",
      "PUT  /api/h/:id/{groups,tags,pin,notes}",
      "GET  /api/h/:id/{spec,preflight,costs}",
      "GET  /api/h/:id/sessions[/:sess[?raw=1]]   POST /api/h/:id/sessions/:sess/pin",
      "GET  /api/h/:id/evals[/:runId[/:sampleId]] POST /api/h/:id/evals/baseline",
      "GET  /api/h/:id/memory/{facts,wiki[/:slug],state,dream,watchme}",
      "GET  /api/h/:id/proc   POST /api/h/:id/proc/{start,stop,restart,drain}",
      "GET  /api/h/:id/runs[/:runId[/events (SSE)]]",
      "GET  /api/h/:id/control/status   POST /api/h/:id/control/{wake,drain}",
      "GET  /api/h/:id/{schedulers,deployments}",
      "GET  /api/approvals   POST /api/h/:id/approvals/:apprId/{grant,deny}",
      "GET  /api/review      POST /api/h/:id/review/:itemId",
      "GET  /api/activity[?since=]",
      "GET  /api/jobs        POST /api/h/:id/jobs {kind}",
      "GET  /api/runs/:sessionId/proof[?harness=:id]   (0.8.0 provability bundles)",
      "--- M4 ---",
      "GET  /api/health      GET  /api/h/:id/health",
      "GET  /api/onboarding  POST /api/onboarding/demo {starter,dir}",
      "GET  /api/search?q=",
      "GET|PUT /api/notifications   POST /api/notifications/clear",
      "GET|PUT /api/read-only",
      "GET  /api/plugins     GET /api/plugins/:name/panes/:paneId   GET /api/h/:id/panes",
      "--- M3 (handlers are stubs: every route below answers 501) ---",
      "PUT  /api/h/:id/spec  POST /api/h/:id/spec/{patch,diff,pin,rollback,propose}",
      "GET  /api/h/:id/spec/{schema,trust,versions[/:version[/diff]]}",
      "GET|POST /api/builders/…   GET|POST|DELETE /api/h/:id/builders/{graders,dataset,mcp}",
      "GET|POST /api/h/:id/memory/{facts/:spec,recall,continuity,learning,knowledge,reflect}",
      "PUT|GET|POST /api/h/:id/memory/wiki/:slug/…   GET|POST /api/h/:id/memory/watchme/…",
      "GET|POST /api/h/:id/evals/{run,matrix,suites,trends,judge,graders,redteam,coverage,…}",
      "GET|POST /api/h/:id/data/…   GET|POST /api/h/:id/feedback/…   GET /api/feedback",
      "GET|POST|DELETE /api/h/:id/env[/:key]   GET|POST /api/credentials[/set]",
      "GET|POST /api/h/:id/{doctor,secrets,mcp/lint,channels/…,gateway,audit,slo}",
      "GET|POST /api/h/:id/security/{egress,pii,justification,corpus,sandbox,onchain,…}",
      "GET|PUT|POST|DELETE /api/h/:id/thredz/…   GET /api/thredz",
      "GET  /api/h/:id/inspect[/:store[/:name]]   PUT /api/h/:id/inspect/settings",
      "GET|POST /api/h/:id/{mcp-servers,dev}/…",
    ];
    const items = routes.map((r) => `<li><code>${r}</code></li>`).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>Hangar</title><h1>Hangar manager API</h1><p>No UI assets embedded in this build. Every <code>/api</code> route requires <code>Authorization: Bearer &lt;session&gt;</code>.</p><ul>${items}</ul>`;
    return new Response(html, {
      headers: { ...SHELL_HEADERS, "content-type": "text/html; charset=utf-8" },
    });
  };

  const serveStatic = (req: Request, pathname: string): Response => {
    if (req.method !== "GET") return errResponse(405, "method not allowed");
    const assets = opts.assets;
    if (assets !== undefined) {
      const asset = assets[pathname] ?? (pathname === "/" ? assets["/index.html"] : undefined);
      if (asset !== undefined) return assetResponse(req, pathname, asset);
    }
    if (pathname === "/") return builtinIndex();
    return errResponse(404, "not found");
  };

  // The versioned API: its operations are its routes, behind the same choke point.
  const deviceRequests = openDeviceRequests(hangarRoot, { now });
  const v1Router = createV1Router({
    hangarRoot,
    registry,
    control: controlService,
    home: homeAccess,
    devices: deviceRequests,
    now,
    onWarn,
    version,
    ...(ownerSettings.baseUrl !== undefined ? { baseUrl: ownerSettings.baseUrl } : {}),
    harnessScrub,
    fleetScrub,
    daemonState: async (entry) => daemonStateOf((await processFor(entry)).snapshot().state),
    daemonStatus: async (entry) => {
      const status = await control.status(controlTarget(await processFor(entry)));
      return status.ok
        ? { ok: true, body: status.body as unknown as Record<string, unknown> }
        : { ok: false, reason: status.reason };
    },
    stopDaemon: async (entry) => {
      const handle = await processFor(entry);
      const stopped = await handle.supervisor.stop();
      return stopped.stopped
        ? { ok: true, detail: `stopped${stopped.forced ? " (forced)" : ""}` }
        : { ok: false, detail: "a live daemon holds the runfile but was not adopted" };
    },
  });

  const withReceipt = createReceipts({
    control: controlService,
    harness: (id) => registry.get(id),
    scrubFor: (dir) => (dir === undefined ? fleetScrub() : harnessScrub(dir)),
    // The receipt's actor is the signed-in principal; Home's own key and a Home with
    // sign-in turned off leave it to the head's own user, which is the owner.
    actorOf: () => {
      const caller = currentRequestAccess()?.caller;
      return caller !== undefined && caller.actor !== null ? caller.principal : undefined;
    },
    // The credential the signed-in principal used, when it used one: a command dispatched
    // from its receipt is checked against exactly that credential.
    credentialOf: () => {
      const actor = currentRequestAccess()?.caller?.actor;
      return actor !== undefined && actor !== null && "credential" in actor
        ? actor.credential
        : undefined;
    },
    onWarn,
  });

  /** The origins Home answers on: a scoped token is refused from any other page. */
  const ownOrigin = (origin: string): boolean => {
    const port = server.port ?? 0;
    const own = new Set([
      `http://${hostname}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(ownerSettings.baseUrl !== undefined ? [new URL(ownerSettings.baseUrl).origin] : []),
    ]);
    return own.has(origin);
  };

  /** The harness that holds a run's proof bundles, resolved before authorizing for it. */
  const proofOwner = (runId: string | undefined, url: URL): string | null => {
    if (runId === undefined || !isProofRunId(runId)) return null;
    const scope = url.searchParams.get("harness");
    if (scope !== null) {
      return HARNESS_ID_RE.test(scope) && registry.get(scope) !== undefined ? scope : null;
    }
    const harnesses = registry
      .list()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((e) => {
        const tenants = proofTenants(e.dir, e.target);
        return {
          id: e.id,
          dir: e.dir,
          specName: e.specName,
          ...(tenants !== undefined ? { tenants } : {}),
        };
      });
    return proofView(harnesses, runId).bundles[0]?.harnessId ?? null;
  };

  /** The one predicate at a filtered fold's exit: items about people are withheld. */
  const peopleExit = async (response: Response, access: RequestAccess): Promise<Response> => {
    if (response.status !== 200) return response;
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return response;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.clone().text());
    } catch {
      return response;
    }
    const exited = withholdPeople(parsed, access.peopleAllowed);
    if (exited === parsed) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(`${JSON.stringify(exited)}\n`, { status: response.status, headers });
  };

  const hosts = allowedHosts({
    bound: [hostname],
    ...(trustedProxy !== undefined ? { trustedProxyHosts: trustedProxy.hosts } : {}),
    allowedHosts: ownerSettings.allowedHosts,
    ...(ownerSettings.baseUrl !== undefined
      ? { baseUrlHost: new URL(ownerSettings.baseUrl).hostname }
      : {}),
    ...(opts.allowHosts !== undefined ? { allowHosts: opts.allowHosts } : {}),
  });

  const handle = async (incoming: Request, peer: Peer): Promise<Response> => {
    let req = incoming;
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (pathname === "/healthz") return json({ ok: true });
    // Receivers answer on the ingress listener only, never here.
    if (pathname === "/hooks" || pathname.startsWith("/hooks/"))
      return errResponse(404, "not found");

    // Before everything else, a boot link and a static file included: a name this Home
    // does not answer to is a page that rebound its own name to this address.
    if (!hostAllowed(req.headers.get("host"), hosts)) return misdirected();

    // Unauthenticated by necessity — the caller is a fresh browser that has
    // nothing yet. Security rests on the nonce being unguessable and
    // single-use, not on the request being authorized. It answers a one-time
    // code, which the browser trades with its own new key for a session.
    if (pathname.startsWith("/boot/")) {
      if (req.method !== "GET") return errResponse(405, "method not allowed");
      if (tokenSetup === undefined) return errResponse(404, "not found");
      const code = signIn.mintExchangeCode(pathname.slice("/boot/".length));
      if (code === undefined) return errResponse(404, "boot ticket already used or expired");
      return new Response(null, {
        status: 302,
        headers: {
          location: `/#x=${code}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // A plugin pane's document, once, with the plugin's own policy and sandbox.
    if (pathname.startsWith("/pane/")) {
      if (req.method !== "GET") return errResponse(405, "method not allowed");
      const nonce = pathname.slice("/pane/".length);
      const entry = paneDocs.get(nonce);
      paneDocs.delete(nonce);
      if (entry === undefined || entry.expiry <= now()) return errResponse(404, "not found");
      return new Response(entry.doc, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": `${entry.csp}; sandbox allow-scripts`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    }

    // An invite link (`/invite#c=…`) opens the console, which reads the code itself.
    if (pathname === "/invite") return serveStatic(req, "/");

    if (isSignInPath(pathname)) {
      if (noAuth) return errResponse(404, "not found");
      return await serveSignIn(homeAccess, req, peer, pathname, {
        devices: deviceRequests,
        ...(ownerSettings.baseUrl !== undefined ? { baseUrl: ownerSettings.baseUrl } : {}),
        onInviteAccepted: async ({ principal }) => {
          // Joining is on record, as the member who joined.
          const answer = await controlService.commands.submit(
            { kind: "auth.acceptInvite", actor: principal, ledger: "workspace", via: "home" },
            async () => ({ settle: { state: "succeeded" }, value: undefined }),
          );
          if (!answer.ok)
            onWarn(`hangar-server: a join was not recorded: ${answer.refusal.message}`);
          return answer.ok ? answer.receipt : undefined;
        },
      });
    }

    // Discovery is answered before the gate for a caller with no credential at all, so a
    // client learns how to sign in; a credential that is refused hears that refusal.
    if (pathname === "/api/v1" && req.method === "GET" && !noAuth) {
      const checked = await checkAccess(homeAccess, req, peer);
      if (checked.answer.kind === "anonymous") return v1Router.discoverAnonymous();
      const refused = refusalOf(checked.answer);
      if (refused !== undefined) return refusalResponse(pathname, refused);
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      let answer: Authenticated | undefined;
      if (!noAuth) {
        const checked = await checkAccess(homeAccess, req, peer);
        const refused = refusalOf(checked.answer);
        if (refused !== undefined) return refusalResponse(pathname, refused);
        req = checked.request;
        answer = checked.answer;
        callers.set(req, checked.answer);
      }
      let segs: string[];
      try {
        segs = pathname
          .split("/")
          .filter((s) => s !== "")
          .map((s) => decodeURIComponent(s));
      } catch {
        return errResponse(400, "malformed path encoding");
      }
      // Undeclared means unreachable: a method and path no row names answers 404 for
      // everyone, the owner and Home's own key included, and no handler runs.
      const matched = matchRequest(req.method, segs);
      if (matched === undefined) return errResponse(404, "not found");
      const read = signIn.snapshot();
      // A request that sees the access records move re-checks the open streams too.
      recheckStreams(read);
      const caller = callerOf(answer, read, operator);
      if (caller === undefined) return errResponse(401, "missing or invalid bearer token");
      const view = accessView(read);
      // An operation this Home does not serve yet says so to anyone signed in, before any
      // permission is asked: there is nothing it would do.
      const notServedYet =
        matched.row.v1 === true &&
        caller.scoped === undefined &&
        Object.hasOwn(V1_NOT_SERVED, matched.row.key);
      const decided = notServedYet
        ? ({ allow: true } as const)
        : authorizeRequest({
            row: matched.row,
            params: matched.params,
            caller,
            view,
            ...(matched.row.key === "runProof"
              ? { runProofHarness: proofOwner(matched.params["sessionId"], url) }
              : {}),
            ...(matched.row.v1 === true ? v1Router.targetOf(matched, url, caller) : {}),
            origin: req.headers.get("origin"),
            ownOrigin,
          });
      if (!decided.allow) return refusalResponse(pathname, decided.refusal);
      // HM-187 — read-only mode, after authorization (a caller who may not do something
      // hears that first) and ahead of every handler. It decides by the matched row: a
      // row that writes a receipt changes something, and is refused.
      if (readOnlyNow() && isReadOnlyRefused(matched.row)) {
        return json(readOnlyRefusal(req.method, pathname, readOnlyLocked), 403);
      }
      authorized.set(req, { ...matched, caller });
      const access = requestAccessFor(caller, view);
      return await withRequestAccess(access, async () => {
        try {
          const response = await withReceipt(req, segs, () => api(req, url, segs.slice(1)));
          return matched.row.qualifiers.includes("filtered")
            ? await peopleExit(response, access)
            : response;
        } catch (err) {
          if (err instanceof HttpError) {
            return err.body === undefined
              ? errResponse(err.status, err.message)
              : json(maskDeep({ error: err.message, ...err.body }, fleetScrub()), err.status);
          }
          onWarn(
            `hangar-server: unhandled route error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return errResponse(500, "internal error");
        }
      });
    }

    return serveStatic(req, pathname);
  };

  // ---- Home's tick: the composed sweeps, while Home runs --------------------
  const homePorts: HomePorts = {
    hangarRoot,
    liveHarnesses: () => liveHarnesses().map((h) => ({ id: h.id, dir: h.dir })),
    accessHarnesses: () =>
      registry.list().map((entry) => ({ id: entry.id, dir: entry.dir, groups: entry.groups })),
    adoptIfRunfile: async (dir) => {
      // Only a harness with a runfile can have anything to attach.
      if (!runfileExists(dir)) return;
      const entry = registry.list().find((row) => row.dir === dir);
      if (entry === undefined) return;
      await processes.get(entry).supervisor.adoptIfRunfile();
    },
    control: {
      recover: (scope) => controlService.commands.recover(scope),
      reconcile: (scope) => controlService.commands.reconcile(scope),
    },
    notificationsTick,
  };
  const scheduler = createSchedulerHost<HomePorts>({
    now,
    home: homePorts,
    jobs: processes.jobs,
    onWarn,
    ...(opts.schedulerTimers !== undefined ? { timers: opts.schedulerTimers } : {}),
  });
  for (const sweep of sweepsOf(areas)) scheduler.register(sweep);

  const tcpPeer = (
    req: Request,
    srv: { requestIP(r: Request): { address: string } | null },
  ): Peer => ({
    address: srv.requestIP(req)?.address ?? null,
    listener: "tcp",
  });
  const server = Bun.serve({
    port: opts.port ?? DEFAULT_HANGAR_PORT,
    hostname,
    development: false,
    // NOT a tuning knob. Bun severs an idle socket after 10 s by default,
    // and a live run stream is idle by nature — a `heartbeat: every 60s`
    // daemon says nothing in between. The console has no reconnect, so the
    // default turns "quietly working" into "connection dropped" every ~12 s.
    // The keep-alive comment frame (SSE_HEARTBEAT_MS) is the other half:
    // this raises the ceiling, the ping keeps the socket under it.
    idleTimeout: SSE_IDLE_TIMEOUT_SECONDS,
    fetch: (req, srv) => handle(req, tcpPeer(req, srv)),
  });

  const boundPort = server.port ?? 0;

  // A LAN or named-host bind also answers on loopback at the same port, so a browser
  // on this computer has a secure context to sign in from. A wildcard bind already does.
  type Stoppable = { stop(closeActive?: boolean): unknown };
  const extra: Stoppable[] = [];
  let loopbackUrl: string | undefined;
  if (!isLoopbackHostname(hostname)) {
    loopbackUrl = `http://127.0.0.1:${boundPort}`;
    if (!isWildcardHostname(hostname)) {
      try {
        extra.push(
          Bun.serve({
            port: boundPort,
            hostname: "127.0.0.1",
            development: false,
            idleTimeout: SSE_IDLE_TIMEOUT_SECONDS,
            fetch: (req, srv) => handle(req, tcpPeer(req, srv)),
          }),
        );
      } catch (err) {
        loopbackUrl = undefined;
        onWarn(
          `hangar-server: could not also listen on 127.0.0.1:${boundPort} (${err instanceof Error ? err.message : String(err)}) — signing in from this computer is unavailable on this run`,
        );
      }
    }
  }
  // Home's own socket, and the proxy's when the owner chose one. Each passes the same
  // `handle`, told which socket it came in on.
  const sockets: string[] = [];
  const serveSocket = (name: string, listener: Peer["listener"]): string | undefined => {
    if (!socketsSupported()) return undefined;
    const path = socketPathOf(hangarRoot, name);
    const bound = bindSocket(
      path,
      (unix) =>
        // A unix-socket server takes no idle timeout of its own; Bun keeps the
        // socket open while the stream writes, and the heartbeat keeps it writing.
        Bun.serve({
          unix,
          development: false,
          fetch: (req) => handle(req, { address: null, listener }),
        }),
      onWarn,
    );
    if (bound === undefined) return undefined;
    extra.push(bound);
    sockets.push(path);
    return path;
  };
  const homeSocket = noAuth ? undefined : serveSocket(HOME_SOCKET, "home.sock");
  if (trustedProxy?.socket === true && serveSocket(PROXY_SOCKET, "proxy.sock") === undefined) {
    onWarn(
      "hangar-server: the trusted proxy's socket could not be created — the proxy cannot reach Home",
    );
  }
  // ---- receivers: a loopback listener of their own, never the console's -----
  const receivers = receiversOf(areas);
  const ingressPort = opts.ingress?.port;
  const ingress =
    ingressPort !== undefined && receivers.length > 0
      ? createIngress({ hangarRoot, receivers, control: controlService, now, onWarn })
      : undefined;
  const ingressServer =
    ingress === undefined
      ? undefined
      : Bun.serve({
          port: ingressPort,
          hostname: "127.0.0.1",
          development: false,
          fetch: (req) => withRequestAccess(systemAccess("ingress"), () => ingress.fetch(req)),
        });

  // Live run streams opened with a session close when it ends.
  let stopped = false;
  const sessionTimer = setInterval(checkStreams, SESSION_CHECK_MS);
  (sessionTimer as { unref?: () => void }).unref?.();
  // Boot the process picture: the port ledger is already open (the layer
  // owns it), every registered harness with a runfile is adopted, and only
  // THEN the job queue restores — so work that was running when the previous
  // manager died is closed as `interrupted` against an accurate picture.
  // Bun.serve binds synchronously, so the socket is live either way; a
  // caller that needs the picture awaits `ready`.
  const ready = processes
    .boot()
    .catch((err) => {
      onWarn(
        `hangar-server: process boot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { adopted: 0, lost: 0, jobs: 0 };
    })
    // Command recovery last: after adoption and the job restore, so it judges an accurate
    // process picture and the receipts the restore already moved.
    .then(async (booted) => ({
      ...booted,
      // Outside any request: recovery reads every harness's ledger under its own name, and
      // what it runs again is authorized as the actor who asked for it.
      commands: await withRequestAccess(systemAccess("command-recovery"), () =>
        controlService.commands.recover("all"),
      ).catch((err) => {
        onWarn(
          `hangar-server: command recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { redispatched: 0, reconciled: 0, unknown: 0 };
      }),
    }))
    // Then, in the installed service only, what a person last started comes back; and
    // both modes leave the report.
    .then(async (booted): Promise<RecoveryReport> => {
      const none = { restarted: [], skipped: [], failed: [] };
      const outcome =
        homeMode === "resident"
          ? await withRequestAccess(systemAccess("reboot-recovery"), () =>
              restartAfterReboot({
                entries: registry
                  .list()
                  .filter((entry) => entry.missingSince === null && existsSync(entry.dir)),
                processes,
                ops: processes.ops,
                now,
              }),
            ).catch((err) => {
              onWarn(
                `hangar-server: reboot recovery failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return none;
            })
          : none;
      const report: RecoveryReport = {
        v: 1,
        at: new Date(now()).toISOString(),
        mode: homeMode,
        hostBootedAt: new Date(hostBootedAt()).toISOString(),
        adopted: booted.adopted,
        lost: booted.lost,
        jobs: booted.jobs,
        commands: booted.commands,
        ...outcome,
      };
      try {
        writeRecoveryReport(hangarRoot, report);
      } catch (err) {
        onWarn(
          `hangar-server: the recovery report could not be written: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return report;
    });
  // Home's tick starts once the boot sequence has settled, in both modes.
  void ready.then(() => {
    if (!stopped) scheduler.start();
  });

  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    hostname,
    hangarRoot,
    registryPath: registry.path,
    ...(tokenSetup !== undefined ? { token: tokenSetup.token } : {}),
    ...(tokenSetup?.tokenPath !== undefined ? { tokenPath: tokenSetup.tokenPath } : {}),
    ...(tokenSetup !== undefined ? { bootPath: signIn.mintBootTicket() } : {}),
    ...(loopbackUrl !== undefined ? { loopbackUrl } : {}),
    ...(homeSocket !== undefined ? { socketPath: homeSocket } : {}),
    noAuth,
    idleTimeoutSeconds: SSE_IDLE_TIMEOUT_SECONDS,
    processes,
    controlService,
    readOnly: readOnlyNow,
    checkSessions: checkStreams,
    openStreamChecks: () => streamChecks.size,
    ready,
    scheduler: { tick: () => scheduler.tick(), idle: () => scheduler.idle() },
    // Read back from the bound socket, never restated: the address callers are told is the
    // one the listener holds.
    ...(ingressServer !== undefined
      ? {
          ingress: {
            url: `http://${ingressServer.hostname ?? ""}:${ingressServer.port ?? 0}`,
            hostname: ingressServer.hostname ?? "",
            port: ingressServer.port ?? 0,
          },
        }
      : {}),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // The tick first, before any listener or supervisor goes: a sweep in flight ends.
      scheduler.stop();
      await scheduler.idle();
      await ingressServer?.stop(true);
      await ingress?.idle();
      // Release timers and subscriptions; the CHILDREN are deliberately left
      // alone. A detached daemon outliving its manager is the whole point of
      // the runfile — the next boot adopts it.
      processes.close();
      clearInterval(sessionTimer);
      for (const listener of extra) await listener.stop(true);
      for (const path of sockets) unlinkSocket(path);
      await server.stop(true);
    },
  };
}
