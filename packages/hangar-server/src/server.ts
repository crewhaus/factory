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
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readRunIndex } from "@crewhaus/eval-report";
import {
  type BuildInventoryDeps,
  buildHarnessHealth,
  buildHarnessInventory,
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
import { maskDeep } from "./mask";
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
  type HarnessProcess,
  JobArgumentError,
  type ProcessLayer,
  createProcessLayer,
  isJobKind,
  jobArgv,
} from "./process";
import { type ReviewHarness, adjudicateReview, isReviewVerdict, reviewInbox } from "./review";
import { type HarnessRollup, openRollupCache } from "./rollups";
import { isLiveFeedState, isSupervisorRunId, runDetail, runEventStream, runsView } from "./runs";
import { resolveInside } from "./safety";
import { buildSchedulersView, readSpecYaml } from "./schedulers";
import {
  isSessionId,
  listSessions,
  readTranscript,
  readTranscriptRaw,
  resolveSessionRoot,
} from "./sessions";
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

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function errResponse(status: number, message: string): Response {
  const headers: Record<string, string> = status === 401 ? { "www-authenticate": "Bearer" } : {};
  return json({ error: message }, status, headers);
}

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

  const handleHarnessSub = async (
    req: Request,
    url: URL,
    entry: HangarHarnessEntry,
    rest: readonly string[],
  ): Promise<Response> => {
    const method = req.method;
    const [head, ...tail] = rest;

    if (head === "relocate" && method === "POST" && tail.length === 0) {
      const body = await readBody(req);
      const newDir = requireAbsoluteDir(body["newDir"], "newDir");
      if (!existsSync(newDir) || !statSync(newDir).isDirectory()) {
        throw new HttpError(400, "newDir does not exist");
      }
      try {
        return json({ entry: registry.relocate(entry.id, newDir) });
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }

    if (method === "PUT" && tail.length === 0) {
      const body = await readBody(req);
      if (head === "groups") {
        const groups = asStringArray(body["groups"]);
        if (groups === undefined) throw new HttpError(400, 'missing "groups" string array');
        return json({ entry: registry.setGroups(entry.id, groups) });
      }
      if (head === "tags") {
        const tags = asStringArray(body["tags"]);
        if (tags === undefined) throw new HttpError(400, 'missing "tags" string array');
        return json({ entry: registry.setTags(entry.id, tags) });
      }
      if (head === "pin") {
        if (typeof body["pinned"] !== "boolean")
          throw new HttpError(400, 'missing "pinned" boolean');
        return json({ entry: registry.setPinned(entry.id, body["pinned"]) });
      }
      if (head === "notes") {
        if (typeof body["notes"] !== "string") throw new HttpError(400, 'missing "notes" string');
        return json({ entry: registry.setNotes(entry.id, body["notes"]) });
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
          return json({ ok: true, stopped: result.stopped, forced: result.forced });
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
            return json({
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
          return json(
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
          return json(controlEnvelope(outcome));
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
        return json({ ok: true, approval: maskDeep(result.approval) });
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
          return json({ ok: true, alreadyResolved: true, entry: result.entry });
        }
        return json({
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
        return json({ ok: true, job: record }, 202);
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
        return json({
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
        return json({ ok: true, baseline: result.baseline });
      }

      throw new HttpError(404, "not found");
    }

    if (method !== "GET") throw new HttpError(405, "method not allowed");

    if (head === "proc" && tail.length === 0) {
      const handle = await processFor(entry);
      // maskDeep on the way out: the runfile and the plan preview carry
      // operator-supplied strings (env overrides, a bundle path, a control
      // token PATH) that no route should be trusted to have pre-filtered.
      return json(maskDeep(procView(entry, handle)));
    }
    if (head === "runs" && tail.length === 0) {
      return json(runsView(liveDirOr404(entry)));
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
      if (tail.length === 1) return json(maskDeep(detail));
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
        ...(live ? { subscribe: handle.supervisor.subscribe } : {}),
        ...(opts.sseHeartbeatMs !== undefined ? { heartbeatMs: opts.sseHeartbeatMs } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
    }
    if (head === "control" && tail.length === 1 && tail[0] === "status") {
      return json(controlEnvelope(await control.status(controlTarget(await processFor(entry)))));
    }
    if (head === "schedulers" && tail.length === 0) {
      return json(maskDeep(await schedulersFor(await processFor(entry))));
    }
    if (head === "deployments" && tail.length === 0) {
      return json(deploymentsView(liveDirOr404(entry)));
    }

    if (head === "spec" && tail.length === 0) {
      return json(specView(liveDirOr404(entry), env));
    }
    if (head === "preflight" && tail.length === 0) {
      const dir = liveDirOr404(entry);
      const merged = mergedSpawnEnv(env, dir);
      const report = await runPreflight({ harnessDir: dir, env: merged.env });
      // maskDeep: a preflight lint may quote a literal it found in the spec
      // (e.g. the pasted-credential MCP lint) — mask before serializing.
      return json(maskDeep({ report, envFiles: merged.envFiles }));
    }
    if (head === "sessions" && tail.length === 0) {
      const dir = liveDirOr404(entry);
      // `pins` rides along so the list can badge protected transcripts and
      // the pin action face has a visible effect on re-read.
      return json({ ...listSessions(dir, now()), pins: readPins(dir) });
    }
    if (head === "sessions" && tail.length === 1) {
      const sess = tail[0] as string;
      if (!isSessionId(sess)) throw new HttpError(400, "invalid session id");
      const dir = liveDirOr404(entry);
      const rootInfo = resolveSessionRoot(dir);
      if (url.searchParams.get("raw") !== null) {
        const raw = readTranscriptRaw(rootInfo.root, sess);
        if (raw === undefined) throw new HttpError(404, "no transcript recorded yet");
        return json(raw);
      }
      const view = readTranscript(rootInfo.root, sess);
      if (view !== undefined) return json(view);
      // Fall through to the durable index for evicted sessions. Resolved
      // from the HARNESS dir (an overridden session root's parent is not
      // ours), containment-checked, and masked like every other payload.
      const indexPath = resolveInside(dir, [".crewhaus", "sessions-index", `${sess}.json`]);
      if (indexPath === undefined) throw new HttpError(404, "no session recorded yet");
      try {
        const summary: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
        return json({ id: sess, evicted: true, summary: maskDeep(summary) });
      } catch {
        throw new HttpError(404, "no session recorded yet");
      }
    }
    if (head === "evals" && tail.length === 0) {
      return json(evalsView(liveDirOr404(entry)));
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
        return json(maskDeep(view));
      }
      const sampleId = tail[1] as string;
      if (!SAFE_SEGMENT_RE.test(sampleId)) throw new HttpError(400, "invalid sample id");
      const view = evalSampleView(dir, runId, sampleId);
      if (view === undefined) throw new HttpError(404, "no such sample");
      return json(maskDeep(view));
    }
    if (head === "memory" && tail.length >= 1 && tail.length <= 2) {
      const area = tail[0] as string;
      const dir = liveDirOr404(entry);
      if (tail.length === 2) {
        if (area !== "wiki") throw new HttpError(404, "not found");
        const article = wikiArticle(dir, tail[1] as string);
        if (article === undefined) throw new HttpError(404, "no such article");
        return json(article);
      }
      if (!isMemoryArea(area)) throw new HttpError(404, "not found");
      switch (area) {
        case "facts":
          return json(factsView(dir, now()));
        case "wiki":
          return json(wikiView(dir));
        case "state":
          return json(stateView(dir));
        case "dream":
          return json(dreamView(dir));
        case "watchme":
          return json(watchmeView(dir));
      }
    }
    if (head === "costs" && tail.length === 0) {
      return json({ id: entry.id, costs: foldHarnessCosts(liveDirOr404(entry), now()) });
    }
    throw new HttpError(404, "not found");
  };

  const api = async (req: Request, url: URL, segs: readonly string[]): Promise<Response> => {
    const method = req.method;
    const [head, ...rest] = segs;

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
        return json(harnessRows(url.searchParams.get("hydrate") !== null));
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

    // ---- M2 fleet inboxes ---------------------------------------------
    if (head === "approvals" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        approvalsInbox(liveHarnesses(), {
          includeSettled: url.searchParams.get("all") !== null,
        }),
      );
    }

    if (head === "review" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return json(
        reviewInbox(liveHarnesses(), {
          includeResolved: url.searchParams.get("all") !== null,
        }),
      );
    }

    if (head === "activity" && rest.length === 0) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      const since = parseSince(url.searchParams.get("since"), now(), DEFAULT_ACTIVITY_WINDOW_MS);
      return json(activityDigest(liveHarnesses(), since));
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
        if (method === "GET") return json(await detailView(entry));
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
