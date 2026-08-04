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
 *   - AUTH: every `/api` route requires `Authorization: Bearer <token>`
 *     (constant-time compare). `/healthz` and the static UI shell (which
 *     carries no harness data and must load before the browser has stored
 *     the fragment token) are the only unauthenticated surfaces. No cookies
 *     anywhere ⇒ no CSRF surface. `noAuth` disables the check with a logged
 *     warning, for trusted localhost dev only.
 *   - PATH SAFETY: `:id` params must match their format regexes before any
 *     filesystem work, and every harness-relative read realpath-contains
 *     inside that harness's registered dir (the registry is the allowlist).
 *     Arbitrary absolute dirs enter ONLY via `POST /api/harnesses` bodies.
 *   - READS NEVER MUTATE: session browsing is raw dir scans + tolerant
 *     JSONL parsing (never `SessionStore.list()`, whose TTL eviction
 *     deletes transcripts); memory views are fold-only. The approvals inbox
 *     folds `approvals.jsonl` for the same reason — `PendingApprovalStore
 *     .list()` COMPACTS, and a polled inbox must not rewrite a ledger.
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
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
} from "@crewhaus/harness-registry";
import {
  type GateDecision,
  SpawnPlanError,
  type StopResult,
  cliTwin,
  isUnforceable,
  readRunfile,
  resolveBundle,
  runClassFor,
} from "@crewhaus/harness-supervisor";
import { runPreflight } from "@crewhaus/preflight";
import { currentBaselines, pinBaseline, pinSession, readPins } from "./actions";
import {
  type ActivityHarness,
  DEFAULT_ACTIVITY_WINDOW_MS,
  activityDigest,
  parseSince,
} from "./activity";
import {
  type ApprovalHarness,
  approvalsInbox,
  isApprovalId,
  pendingApprovalCount,
  resolveApproval,
} from "./approvals";
import { type TokenSetup, createBootTickets, ensureToken, isAuthorized } from "./auth";
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
} from "./control-client";
import { foldHarnessCosts } from "./costs";
import { deploymentsView } from "./deployments";
import { mergedSpawnEnv } from "./env-file";
import { evalHealth, evalRunView, evalSampleView, evalsView, isRunId } from "./evals";
import {
  type HealthPreflightItem,
  type HealthResult,
  cadenceToMs,
  computeHealth,
  declaredBudgetUsd,
  dreamOverdue,
} from "./health";
import { HttpError, errResponse, json } from "./http";
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
  type HarnessSignal,
  type NotificationCentre,
  type NotificationSinks,
  createNotificationCentre,
  defaultNotificationSinks,
  deriveEvents,
} from "./notifications";
import { OMNI_LIMIT, type OmniIndex, createOmniIndex } from "./omnibox";
import {
  DEMOS_DIR_ENV,
  StarterInstallError,
  demoAvailability,
  installStarter,
  onboardingView,
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
  type ProcessLayer,
  createProcessLayer,
  isJobKind,
  jobArgv,
} from "./process";
import { type ReviewHarness, adjudicateReview, isReviewVerdict, reviewInbox } from "./review";
import { type HarnessRollup, openRollupCache } from "./rollups";
import {
  isLiveFeedState,
  isSupervisorRunId,
  runDetail,
  runEventStream,
  runsView,
  safeSpawnEnvScrubber,
} from "./runs";
import { resolveInside } from "./safety";
import { buildSchedulersView, declaredCadences, dreamStates, readSpecYaml } from "./schedulers";
import {
  isSessionId,
  listSessions,
  readTranscript,
  readTranscriptRaw,
  resolveSessionRoot,
} from "./sessions";
import {
  READ_ONLY_EXEMPT,
  type SettingsStore,
  isReadOnlyRefused,
  openSettingsStore,
  readOnlyRefusal,
} from "./settings";
import { BADGE_KEYS, capabilityBadges, specView } from "./spec-view";

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
  /** Explicit bearer token; otherwise loaded/minted at `<root>/token`. */
  readonly token?: string;
  /** Disable auth entirely (logged warning; trusted localhost dev only). */
  readonly noAuth?: boolean;
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
};

export type HangarServer = {
  readonly url: string;
  readonly port: number;
  readonly hostname: string;
  readonly hangarRoot: string;
  readonly registryPath: string;
  /** Undefined when `noAuth` is set. */
  readonly token?: string;
  /** Where the minted token lives; undefined when supplied via options. */
  readonly tokenPath?: string;
  /** A single-use `/boot/<nonce>` path that redirects to the fragment form.
   *  The launcher opens THIS, so the token never enters a command line.
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
  /**
   * Resolves once the boot sequence has run: port ledger open → `adopt()`
   * per registered harness → `jobQueue.restore()`. `Bun.serve` binds
   * synchronously, so the socket is live before this settles; awaiting it
   * is how a caller knows the process picture is accurate.
   */
  readonly ready: Promise<{
    readonly adopted: number;
    readonly lost: number;
    readonly jobs: number;
  }>;
  stop(): Promise<void>;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;

/** Start the manager server. Synchronous — `Bun.serve` binds immediately. */
export function startHangarServer(opts: HangarServerOptions = {}): HangarServer {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));
  const hangarRoot =
    opts.root !== undefined ? resolve(opts.root) : join(homedir(), ".crewhaus", "hangar");
  const noAuth = opts.noAuth === true;
  let tokenSetup: TokenSetup | undefined;
  if (noAuth) {
    onWarn(
      "hangar-server: AUTH DISABLED (noAuth) — every local process can read this fleet's state",
    );
  } else {
    tokenSetup = ensureToken(hangarRoot, opts.token);
  }
  const bootTickets = createBootTickets();

  const registry: HangarRegistry = openHangarRegistry({
    ...(opts.registryRoot !== undefined ? { root: opts.registryRoot } : {}),
    env,
    now,
    onWarn,
  });
  const cache = openRollupCache(hangarRoot);
  const version = opts.version ?? HANGAR_SERVER_VERSION;
  const hostname = opts.hostname ?? "127.0.0.1";
  const operator = opts.operator ?? "hangar";

  const processes: ProcessLayer =
    opts.processLayer ??
    createProcessLayer({
      registry,
      env,
      now,
      onWarn,
      hangarRoot,
      managerVersion: version,
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
    const scrubbers = liveHarnesses().map((h) => harnessScrub(h.dir));
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
    const rows = registry.list().map((entry) => {
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
        : evalHealth(join(entry.dir, ".crewhaus", "evals"), header.name ?? entry.specName).healthy;
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
    const health = await buildHarnessHealth(inventory, (evalsDir, specName) =>
      evalHealth(evalsDir, specName),
    );
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
    const facts = factsView(dir, now()).files.reduce((n, f) => n + f.live, 0);
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
    for (const entry of registry.list()) {
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
    let evals: { healthy: boolean; note: string } | null = null;
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
    registry
      .list()
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
          evalHealthy: evalHealth(join(dir, ".crewhaus", "evals"), view.specName).healthy,
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

  /** GET /api/notifications — rules + the badge, evaluated at poll time. */
  const notificationsView = (): unknown => {
    const current = settings.get().notifications;
    const events = deriveEvents(fleetSignals());
    const result = notifications.poll(
      {
        rules: current.rules,
        quietHours: current.quietHours,
        mutedGroups: current.mutedGroups,
        events,
        nowMs: now(),
      },
      current.webhookUrl,
    );
    const inApp = notifications.inApp();
    return {
      rules: current.rules,
      quietHours: current.quietHours,
      mutedGroups: current.mutedGroups,
      webhookUrl: current.webhookUrl,
      /** What this manager can actually deliver on, and why not — so a sink
       *  that cannot fire here is visibly unusable rather than a checkbox
       *  the operator ticks into silence. */
      sinkAvailability: notifications.availability(current.webhookUrl),
      /** Fired on THIS poll — the toast list. Each delivery's `sinks` names
       *  the sinks that actually carried it, never the ones asked for. */
      delivered: result.deliveries,
      /** Events that did not notify, with the reason — a silent rule is
       *  always explainable from the screen. */
      suppressed: result.suppressed,
      /** The badge queue, newest first. */
      inApp,
      badge: inApp.length,
      cliTwin: "crewhaus harness list --json  # the same signals, unfiltered",
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
    registry
      .list()
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
    registry
      .list()
      .filter((e) => e.missingSince === null && existsSync(e.dir))
      .map((e) => ({ id: e.id, dir: e.dir, specName: e.specName }));

  /**
   * The supervision handle for a harness, RE-ATTACHED to a daemon this
   * manager did not spawn.
   *
   * Adoption at boot only sees the daemons that existed at that instant. A
   * daemon started from a terminal, by a launchd unit, or for a harness
   * registered after boot is otherwise invisible: the supervisor holds no
   * pid, so `/proc` reports `stopped` while the same payload's runfile
   * carries a live one, and stop/drain would return "stopped" having sent no
   * signal and made no control call. `adoptIfRunfile()` is the cheap guard
   * for that — it returns immediately unless a runfile exists AND this
   * supervisor holds no pid — so it belongs on the request path, which is
   * exactly what `crewhaus daemon stop` already does before every signal.
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

  const procView = (entry: HangarHarnessEntry, handle: HarnessProcess): Record<string, unknown> => {
    const dir = handle.harnessDir;
    const snapshot = handle.snapshot();
    const runfile = readRunfile(dir) ?? null;
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
      state: snapshot.state,
      runId: snapshot.runId ?? null,
      pid: snapshot.pid ?? null,
      startedAt: snapshot.startedAt ?? null,
      sessionId: snapshot.sessionId ?? null,
      adopted: snapshot.adopted === true,
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
      });
    }
    switch (result.reason) {
      case "already-running":
        return json(
          {
            ok: false,
            reason: "already-running",
            message: "a daemon is already running for this harness (the runfile is the lock)",
            runfile: result.runfile ?? null,
          },
          409,
        );
      case "preflight-blocked":
        // 409, not 400: the request was well-formed and the refusal is a
        // fact about the harness that `force`/`acknowledge` may clear.
        return json(gateRefusalBody(result.gate), 409);
      case "plan-failed":
        return json(
          {
            ok: false,
            reason: "plan-failed",
            message: result.error.message,
            // The UI turns a remedy into a button, not an error toast.
            remedy: result.error instanceof SpawnPlanError ? result.error.remedy : null,
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

  const controlTarget = (
    handle: HarnessProcess,
  ): {
    harnessDir: string;
    controlPort: number | undefined;
  } => ({ harnessDir: handle.harnessDir, controlPort: handle.controlPort() });

  const schedulersFor = async (handle: HarnessProcess): Promise<unknown> => {
    const status = await control.status(controlTarget(handle));
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
    const context: M3Context = {
      entry,
      harnessDir,
      params,
      query: url.searchParams,
      body,
      // Harness `.env` layered over the manager's env — the same picture
      // preflight and spawns see. Values, because a handler may need to sign
      // a synthetic inbound server-side; never serialize one.
      env: dir === null ? env : mergedSpawnEnv(env, dir).env,
      now,
      operator,
      contain: (segments) => {
        if (dir === null) throw new HttpError(400, "not a per-harness route");
        // Per FILE, never per directory: a listed name can be a symlink.
        const resolved = resolveInside(dir, segments);
        if (resolved === undefined) throw new HttpError(400, "path escapes the harness directory");
        return resolved;
      },
      harnesses: (): readonly M3Harness[] => liveHarnesses(),
      process: async () => {
        if (entry === null) throw new HttpError(400, "not a per-harness route");
        return await processFor(entry);
      },
      control,
      jobs: processes.jobs,
      submitJob: (kind, argv) =>
        processes.jobs.submit({
          harnessDir: dir ?? "",
          ...(entry !== null ? { harnessId: entry.id } : {}),
          kind,
          argv,
        }),
      warn: onWarn,
    };
    const result = await route.handler(context);
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
      const body = await readBody(req);
      const newDir = requireAbsoluteDir(body["newDir"], "newDir");
      if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
        throw new HttpError(400, "newDir does not exist");
      }
      try {
        return jsonMasked({ entry: registry.relocate(entry.id, newDir) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }

    if (method === "PUT" && tail.length === 0) {
      const body = await readBody(req);
      if (head === "groups") {
        const groups = asStringArray(body["groups"]);
        if (groups === undefined) throw new HttpError(400, 'missing "groups" string array');
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
      if (head === "notes") {
        if (typeof body["notes"] !== "string") throw new HttpError(400, 'missing "notes" string');
        return jsonMasked({ entry: registry.setNotes(entry.id, body["notes"]) });
      }
      throw new HttpError(404, "not found");
    }

    // ---- M2 writes: process control, control.v1, inboxes, action faces ----
    if (method === "POST") {
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
            throw new HttpError(400, 'missing "lane" — one of: heartbeat, schedule');
          }
          const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
          return jsonMasked(
            controlEnvelope(
              await control.wake(controlTarget(handle), {
                lane,
                ...(reason !== undefined ? { reason } : {}),
                by: operator,
              }),
            ),
          );
        }
        if (tail[0] === "drain") {
          const outcome = await control.drain(controlTarget(handle));
          // ONLY after the daemon accepted it. A refusal (`no_control_port`,
          // say) told the daemon nothing, and marking anyway would both
          // suppress a restart the daemon still needs and disable every
          // process verb in the console with "this daemon is draining".
          if (outcome.ok) handle.markDraining();
          return jsonMasked(controlEnvelope(outcome));
        }
        throw new HttpError(404, "not found");
      }

      if (head === "approvals" && tail.length === 2) {
        const apprId = tail[0] as string;
        const verb = tail[1];
        if (!isApprovalId(apprId)) throw new HttpError(400, "invalid approval id");
        if (verb !== "grant" && verb !== "deny") throw new HttpError(404, "not found");
        const body = await readBody(req);
        const by = typeof body["by"] === "string" && body["by"] !== "" ? body["by"] : operator;
        const result = await resolveApproval({
          harnessDir: liveDirOr404(entry),
          approvalId: apprId,
          decision: verb === "grant" ? "grant" : "deny",
          by,
          now: () => new Date(now()),
        });
        if (result.outcome === "not-found") throw new HttpError(404, "no such approval");
        if (result.outcome === "unreachable") throw new HttpError(409, result.reason);
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
          by: operator,
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
        let argv: string[];
        try {
          argv = jobArgv(kind, {
            ...(typeof body["dataset"] === "string" ? { dataset: body["dataset"] } : {}),
            ...(typeof body["graders"] === "string" ? { graders: body["graders"] } : {}),
          });
        } catch (err) {
          if (err instanceof JobArgumentError) throw new HttpError(400, err.message);
          throw err;
        }
        const record = processes.jobs.submit({ harnessDir: dir, harnessId: entry.id, kind, argv });
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
        const result = pinBaseline({
          harnessDir: liveDirOr404(entry),
          runId,
          nowIso: new Date(now()).toISOString(),
        });
        if (result.outcome === "rejected") throw new HttpError(409, result.reason);
        return jsonMasked({ ok: true, baseline: result.baseline });
      }

      throw new HttpError(404, "not found");
    }

    if (method !== "GET") throw new HttpError(405, "method not allowed");

    if (head === "proc" && tail.length === 0) {
      const handle = await processFor(entry);
      // maskDeep on the way out: the runfile and the plan preview carry
      // operator-supplied strings (env overrides, a bundle path, a control
      // token PATH) that no route should be trusted to have pre-filtered.
      return jsonMasked(procView(entry, handle));
    }
    if (head === "runs" && tail.length === 0) {
      return jsonMasked(runsView(liveDirOr404(entry)));
    }
    if (head === "runs" && tail.length >= 1 && tail.length <= 2) {
      const runId = tail[0] as string;
      if (!isSupervisorRunId(runId)) throw new HttpError(400, "invalid run id");
      const dir = liveDirOr404(entry);
      const handle = await processFor(entry);
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
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
    }
    if (head === "control" && tail.length === 1 && tail[0] === "status") {
      return jsonMasked(
        controlEnvelope(await control.status(controlTarget(await processFor(entry)))),
      );
    }
    if (head === "schedulers" && tail.length === 0) {
      return jsonMasked(await schedulersFor(await processFor(entry)));
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
    const m3 = matchM3(method, ["api", ...segs]);
    if (m3 !== undefined) return await runM3(req, url, m3);

    if (head === "version" && rest.length === 0 && method === "GET") {
      return json({ hangar: version, protocolV: PROTOCOL_V });
    }

    // Mint a fresh single-use browser handoff. Bearer-authed: `crewhaus
    // hangar open` reads the token file (it already has filesystem access to
    // it) and trades it for a path safe to put on a command line.
    if (head === "boot-ticket" && rest.length === 0 && method === "POST") {
      if (tokenSetup === undefined) throw new HttpError(409, "auth is disabled; open / directly");
      return json({ bootPath: bootTickets.mint(now()) });
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
      if (method === "GET") return json({ groups: registry.listGroups() });
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

    if (head === "registry" && rest[0] === "scan-roots" && rest.length === 1) {
      if (method === "GET") return json({ scanRoots: registry.listScanRoots() });
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
      for (const entry of registry.list()) {
        if (entry.missingSince !== null || !existsSync(entry.dir)) continue;
        rows.push({ id: entry.id, specName: entry.specName, health: await healthFor(entry) });
      }
      return json(maskDeep({ harnesses: rows }, fleetScrub()));
    }

    if (head === "onboarding" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        onboardingView({
          harnessCount: registry.list().length,
          scanRootCount: registry.listScanRoots().length,
          suggestions: suggestScanRoots(env, homedir(), cwd),
          demo: demoAvailability(env, demosDir),
          completedAt: settings.get().onboarding.completedAt,
        }),
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
        try {
          settings.update({ notifications: body });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
        return json(maskDeep(notificationsView(), fleetScrub()));
      }
      throw new HttpError(405, "method not allowed");
    }

    if (head === "notifications" && rest[0] === "clear" && rest.length === 1) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      notifications.clear();
      return json({ ok: true, badge: 0 });
    }

    if (head === "read-only" && rest.length === 0) {
      if (method === "GET") {
        return json({
          enabled: readOnlyNow(),
          locked: readOnlyLocked,
          exempt: [...READ_ONLY_EXEMPT].sort(),
          note: "read-only mode prevents accidents during a demo or screen-share; the bearer token, not this toggle, is the security boundary",
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
      return json(doc);
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
          }),
          fleetScrub(),
        ),
      );
    }

    if (head === "activity" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const since = parseSince(url.searchParams.get("since"), now(), DEFAULT_ACTIVITY_WINDOW_MS);
      return json(maskDeep(activityDigest(liveHarnesses(), since), fleetScrub()));
    }

    if (head === "jobs" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      // `recent` folds terminal jobs from the persisted ledger. Without it a
      // job vanishes the instant it finishes and `interrupted` — the state
      // restore() assigns to work a dead manager abandoned — is never
      // visible to the operator it exists to inform.
      const limitRaw = url.searchParams.get("recent");
      const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
      return json({
        pending: processes.jobs.pending(),
        running: processes.jobs.running(),
        recent: processes.jobs.recent(
          limit !== undefined && Number.isFinite(limit) ? limit : undefined,
        ),
      });
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
      "GET  /api/version",
      "GET  /api/harnesses[?hydrate=1]   POST /api/harnesses {dir}",
      "GET|POST|PUT|DELETE /api/registry/groups",
      "GET|POST|DELETE /api/registry/scan-roots",
      "POST /api/scan",
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
    const html = `<!doctype html><meta charset="utf-8"><title>Hangar</title><h1>Hangar manager API</h1><p>No UI assets embedded in this build. Every <code>/api</code> route requires <code>Authorization: Bearer &lt;token&gt;</code>.</p><ul>${items}</ul>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };

  const serveStatic = (req: Request, pathname: string): Response => {
    if (req.method !== "GET") return errResponse(405, "method not allowed");
    const assets = opts.assets;
    if (assets !== undefined) {
      const asset = assets[pathname] ?? (pathname === "/" ? assets["/index.html"] : undefined);
      if (asset !== undefined) {
        return new Response(asset.body, {
          headers: {
            "content-type": asset.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }
    if (pathname === "/") return builtinIndex();
    return errResponse(404, "not found");
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (pathname === "/healthz") return json({ ok: true });

    // Unauthenticated by necessity — the caller is a fresh browser that has
    // no token yet. Security rests on the nonce being unguessable and
    // single-use, not on the request being authorized.
    if (pathname.startsWith("/boot/")) {
      if (req.method !== "GET") return errResponse(405, "method not allowed");
      if (tokenSetup === undefined) return errResponse(404, "not found");
      const nonce = pathname.slice("/boot/".length);
      if (bootTickets.consume(nonce, now()) === undefined) {
        return errResponse(404, "boot ticket already used or expired");
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: `/#t=${encodeURIComponent(tokenSetup.token)}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      if (!noAuth) {
        if (tokenSetup === undefined || !isAuthorized(req, tokenSetup.token)) {
          return errResponse(401, "missing or invalid bearer token");
        }
      }
      // HM-187 — read-only mode, enforced HERE, ahead of every handler.
      // Placed after auth and before dispatch so it covers the M1/M2 chain
      // and the M3 table identically, and so a route added next month is
      // covered by construction rather than by remembering to be.
      if (readOnlyNow() && isReadOnlyRefused(req.method, pathname)) {
        return json(readOnlyRefusal(req.method, pathname, readOnlyLocked), 403);
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
      try {
        return await api(req, url, segs.slice(1));
      } catch (err) {
        if (err instanceof HttpError) return errResponse(err.status, err.message);
        onWarn(
          `hangar-server: unhandled route error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return errResponse(500, "internal error");
      }
    }

    return serveStatic(req, pathname);
  };

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
    fetch: handle,
  });

  const boundPort = server.port ?? 0;
  // Boot the process picture: the port ledger is already open (the layer
  // owns it), every registered harness with a runfile is adopted, and only
  // THEN the job queue restores — so work that was running when the previous
  // manager died is closed as `interrupted` against an accurate picture.
  // Bun.serve binds synchronously, so the socket is live either way; a
  // caller that needs the picture awaits `ready`.
  const ready = processes.boot().catch((err) => {
    onWarn(
      `hangar-server: process boot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { adopted: 0, lost: 0, jobs: 0 };
  });

  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    hostname,
    hangarRoot,
    registryPath: registry.path,
    ...(tokenSetup !== undefined ? { token: tokenSetup.token } : {}),
    ...(tokenSetup?.tokenPath !== undefined ? { tokenPath: tokenSetup.tokenPath } : {}),
    ...(tokenSetup !== undefined ? { bootPath: bootTickets.mint(now()) } : {}),
    noAuth,
    idleTimeoutSeconds: SSE_IDLE_TIMEOUT_SECONDS,
    processes,
    readOnly: readOnlyNow,
    ready,
    stop: async () => {
      // Release timers and subscriptions; the CHILDREN are deliberately left
      // alone. A detached daemon outliving its manager is the whole point of
      // the runfile — the next boot adopts it.
      processes.close();
      await server.stop(true);
    },
  };
}
