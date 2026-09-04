/**
 * Pure view logic for the M2 supervision surfaces — the process board, the
 * run console, the four-lane timeline, the two inboxes, the activity digest,
 * the job queue, and the deployments panel.
 *
 * Like `util.js` this module is deliberately DOM-free and side-effect-free,
 * so the same file runs in the browser and under `bun test`: every screen's
 * hard thinking (state → row, envelope → disabled-with-reason, SSE frame →
 * feed item, refusal → modal, keystroke → next state) lives here and is
 * asserted directly, while `views/*.js` stay thin DOM builders. Anything
 * time-dependent takes an explicit `nowMs`.
 *
 * THE THREE RULES THIS MODULE ENCODES.
 *
 *   1. **`expected: true` is a fact, not a fault.** `no_control_port`,
 *      `lane_not_armed` and `draining` render the control DISABLED WITH ITS
 *      REASON — never an error toast. Only `tick_in_flight` retries.
 *   2. **Absence is not an error.** A null payload, a missing field, a
 *      404-shaped `null` all degrade to "nothing yet" models rather than
 *      throwing.
 *   3. **Say which answer you got.** Bundle freshness distinguishes the
 *      hash-exact verdict from the mtime approximation; a lane with no
 *      control plane says "cadence only" instead of implying a gap.
 */

import { hrefHarness } from "./router.js";
import { fmtRelativeTime, parseTs, usdFromMicros } from "./util.js";

// ---------------------------------------------------------------------------
// supervision state
// ---------------------------------------------------------------------------

/** The supervisor's state machine, as pill copy. Dots are ALWAYS paired with
 *  this text (color-blind-safe invariant). */
export const PROC_STATE_META = {
  stopped: { dot: "off", label: "stopped", note: "no daemon running" },
  preflight: { dot: "warn", label: "preflight", note: "checking before the spawn" },
  starting: { dot: "warn", label: "starting", note: "spawned, not yet confirmed" },
  running: { dot: "ok", label: "running", note: "" },
  draining: { dot: "warn", label: "draining", note: "finishing in-flight work, then exiting" },
  crashed: { dot: "bad", label: "crashed", note: "exited unexpectedly" },
  parked: { dot: "warn", label: "parked", note: "waiting on an approval — not a failure" },
  terminal: { dot: "bad", label: "terminal", note: "an exit class that must never auto-restart" },
  "crash-looping": {
    dot: "bad",
    label: "crash-looping",
    note: "the restart window is exhausted — start it manually",
  },
};

/** States in which something is (or is becoming) alive. */
const LIVE_STATES = new Set(["preflight", "starting", "running", "draining"]);

/** One supervision state → its dot state + label + one-line note. */
export function procStatePill(state) {
  const key = typeof state === "string" ? state : "";
  const meta = PROC_STATE_META[key];
  if (meta === undefined) {
    return { state: key === "" ? "unknown" : key, dot: "unknown", label: "unknown", note: "" };
  }
  return { state: key, ...meta };
}

/** Coarse duration: "42s", "7m 3s", "5h 12m", "3d 4h". "—" when unknown. */
export function fmtDurationMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Uptime since an ISO start time. "—" when the process is not running. */
export function uptimeLabel(startedAtIso, nowMs) {
  const ts = parseTs(startedAtIso);
  if (ts === null) return "—";
  return fmtDurationMs(nowMs - ts);
}

/**
 * The pending-restart countdown. Null when no restart is scheduled — the
 * common case; a number here is the supervisor's backoff timer, and an
 * operator staring at a crashed row deserves to see it tick.
 */
export function restartCountdown(nextRestartAtMs, nowMs) {
  if (typeof nextRestartAtMs !== "number" || !Number.isFinite(nextRestartAtMs)) return null;
  const ms = nextRestartAtMs - nowMs;
  return {
    ms,
    due: ms <= 0,
    label: ms <= 0 ? "restarting now" : `restart in ${fmtDurationMs(ms)}`,
  };
}

/** `proc.control` → availability model. Absence is a fact with a reason. */
export function controlAvailability(control) {
  const c = control && typeof control === "object" ? control : {};
  const available = c.available === true;
  const port = typeof c.port === "number" ? c.port : null;
  return {
    available,
    port,
    dot: available ? "ok" : "off",
    label: available ? `control.v1 :${port}` : "no control plane",
    reason: typeof c.reason === "string" ? c.reason : null,
  };
}

/** Freshness state → dot. `approximate-*` are honest guesses, not verdicts. */
const FRESHNESS_DOT = {
  fresh: "ok",
  stale: "warn",
  "approximate-fresh": "unknown",
  "approximate-stale": "warn",
  unstamped: "unknown",
  unknown: "unknown",
};

/**
 * `proc.bundle` → the freshness badge. `exact` is the whole point: the F-5
 * spec-hash verdict and the mtime approximation are different claims, and a
 * badge that hid the difference would nag every operator who has not
 * recompiled since upgrading.
 */
export function bundleBadge(bundle) {
  const b = bundle && typeof bundle === "object" ? bundle : {};
  const f = b.freshness && typeof b.freshness === "object" ? b.freshness : {};
  const present = b.present === true;
  const state = typeof f.state === "string" && f.state !== "" ? f.state : "unknown";
  const exact = f.exact === true;
  return {
    present,
    dir: typeof b.dir === "string" ? b.dir : null,
    entry: typeof b.entry === "string" ? b.entry : null,
    state,
    exact,
    dot: present ? (FRESHNESS_DOT[state] ?? "unknown") : "off",
    label: present
      ? typeof f.label === "string" && f.label !== ""
        ? f.label
        : state
      : "no compiled bundle",
    precision: !present
      ? "nothing has been compiled here yet"
      : exact
        ? "exact — the bundle's spec hash was compared"
        : "approximate — compared by file times, not by hash",
    compiledWith: typeof f.compiledWith === "string" ? f.compiledWith : null,
  };
}

/** Remedies a failed spawn plan can carry, as buttons rather than toasts. */
export const REMEDIES = {
  compile: {
    label: "Compile now",
    jobKind: "compile",
    hint: "there is no compiled bundle to launch",
  },
  "add-spec": {
    label: "No crewhaus.yaml here",
    jobKind: null,
    hint: "add a spec to this directory, then compile it",
  },
  "install-cli": {
    label: "crewhaus CLI not found",
    jobKind: null,
    hint: "install the CLI so the manager can spawn through it",
  },
};

/** One `launch.error.remedy` → its button model, or null. */
export function remedyAction(remedy) {
  return typeof remedy === "string" ? (REMEDIES[remedy] ?? null) : null;
}

/** `proc.launch` → the "what Start would actually run" model. */
export function launchModel(launch) {
  const l = launch && typeof launch === "object" ? launch : {};
  const err = l.error && typeof l.error === "object" ? l.error : null;
  return {
    mode: typeof l.mode === "string" ? l.mode : null,
    canResume: l.canResume === true,
    cliTwin: typeof l.cliTwin === "string" && l.cliTwin !== "" ? l.cliTwin : null,
    detached: l.detached === true,
    supervised: l.supervised === true,
    envFiles: Array.isArray(l.envFiles) ? l.envFiles.map(String) : [],
    overrides: Array.isArray(l.overrides) ? l.overrides : [],
    error:
      err === null
        ? null
        : {
            message:
              typeof err.message === "string" ? err.message : "the spawn plan could not be built",
            remedy: typeof err.remedy === "string" ? err.remedy : null,
            action: remedyAction(err.remedy),
          },
  };
}

/** Failure classes that carry an operator-actionable next step. */
const CLASS_REMEDIATION = {
  billing: "the provider account is out of funding — top it up, then start again",
  auth: "the provider rejected the credential — fix the key, then start again",
  rate_limit: "the provider quota was exhausted after retries — wait, or lower concurrency",
  crewhaus_budget: "this harness's own budget cap ended the run — raise or reset it",
  timeout: "a configured wall-clock limit ended the run",
  evaluation: "the in-loop evaluation gate halted the run",
  approval_pending: "an approval is waiting — grant or deny it in the inbox",
  mcp_boot: "an MCP server failed to boot — check its command and env",
  context_overflow: "the context window overflowed — compaction or a smaller prompt",
  spec: "the spec cannot compile — restarting would recompile the same spec",
  config: "a required key is missing — a restart leaves it missing",
  tool: "a tool crashed the run",
  unknown: null,
};

/** Human names for the failure classes the fleet board groups by. */
export const CLASS_LABELS = {
  billing: "provider funding",
  auth: "provider auth",
  rate_limit: "provider rate limit",
  crewhaus_budget: "budget cap",
  timeout: "timeout",
  evaluation: "evaluation gate",
  approval_pending: "waiting on approval",
  mcp_boot: "MCP boot",
  context_overflow: "context overflow",
  spec: "spec",
  config: "config",
  tool: "tool",
  unknown: "unclassified",
};

/** Classes the restart policy refuses to auto-restart. */
const TERMINAL_CLASSES = new Set(["spec", "config", "auth", "billing", "crewhaus_budget"]);

/**
 * The newest CLOSED run-ledger row as an exit classification.
 *
 * A manager that did not supervise the last run has no `lastExit` in its
 * live snapshot — but the harness-local ledger still records how that run
 * ended, and after a console restart that is the only honest answer
 * available. Rows built this way carry `fromLedger` so the UI can say where
 * the fact came from instead of implying this manager watched it happen.
 */
export function ledgerExit(recentRuns) {
  const runs = Array.isArray(recentRuns) ? recentRuns : [];
  const closed = runs.find(
    (r) => r !== null && typeof r === "object" && typeof r.exitCode === "number",
  );
  if (closed === undefined) return null;
  const code = closed.exitCode;
  const failureClass = typeof closed.failureClass === "string" ? closed.failureClass : undefined;
  return {
    disposition:
      code === 0
        ? "clean"
        : failureClass !== undefined && TERMINAL_CLASSES.has(failureClass)
          ? "terminal"
          : "crash",
    ...(failureClass !== undefined ? { failureClass } : {}),
    title: code === 0 ? "exited cleanly" : `exited ${code}`,
    exitCode: code,
    restartable: false,
    unexpectedClean: false,
    fromLedger: true,
  };
}

/** An `ExitClassification` → the banner model (dot + title + remediation). */
export function exitBanner(classification) {
  const c = classification && typeof classification === "object" ? classification : null;
  if (c === null) return null;
  const disposition = typeof c.disposition === "string" ? c.disposition : "crash";
  const failureClass = typeof c.failureClass === "string" ? c.failureClass : null;
  return {
    disposition,
    dot:
      disposition === "clean"
        ? c.unexpectedClean === true
          ? "warn"
          : "off"
        : disposition === "parked"
          ? "warn"
          : "bad",
    title: typeof c.title === "string" && c.title !== "" ? c.title : disposition,
    failureClass,
    classLabel: failureClass !== null ? (CLASS_LABELS[failureClass] ?? failureClass) : null,
    exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
    signal: typeof c.signal === "string" ? c.signal : null,
    restartable: c.restartable === true,
    unexpectedClean: c.unexpectedClean === true,
    // True when the fact came from the harness's own ledger rather than from
    // this manager's supervision of the run.
    fromLedger: c.fromLedger === true,
    remediation: failureClass !== null ? (CLASS_REMEDIATION[failureClass] ?? null) : null,
  };
}

/**
 * Which row actions are live, and WHY they are not. A disabled control that
 * cannot say why is indistinguishable from a broken one.
 */
export function procActions(proc) {
  const p = proc && typeof proc === "object" ? proc : {};
  const state = typeof p.state === "string" ? p.state : "stopped";
  const live = LIVE_STATES.has(state);
  const draining = p.draining === true || state === "draining";
  const launch = launchModel(p.launch);
  const planError = launch.error;
  const yes = { enabled: true, reason: null };
  const no = (reason) => ({ enabled: false, reason });
  const spawnBlocked =
    planError !== null ? no(planError.message) : draining ? no("this daemon is draining") : yes;
  return {
    start: live ? no(`already ${state}`) : spawnBlocked,
    stop: live ? yes : no(`nothing is running (${state})`),
    restart: live && draining ? no("this daemon is draining — it is going away") : spawnBlocked,
    drain:
      state === "running"
        ? yes
        : draining
          ? no("already draining")
          : no(`nothing is running (${state})`),
  };
}

/** What the supervisor says when it held no pid and a live runfile exists:
 *  a daemon is running that this manager never adopted, so nothing was
 *  signalled. It is NOT a stop, and rendering it as one is how a console
 *  tells an operator a live channel bot is down. */
const NOT_ADOPTED_SENTENCE =
  "a daemon is running for this harness but this console does not hold it — nothing was signalled";
/** …and what to do about it, which the server's own sentence never carries. */
const NOT_ADOPTED_RETRY = "Try again: the next request adopts it off the runfile.";

/**
 * `POST /proc/{stop,drain}` → what ACTUALLY happened.
 *
 * Three answers hide behind one button, and only one of them is a stop:
 *
 *   - the daemon stopped (`stopped: true`) — silence is the right report;
 *   - it drained by SIGTERM because no control plane answered
 *     (`viaSignal: true`) — an honest degradation, said out loud;
 *   - nothing was signalled at all — a 409 `not-adopted`, or a body that
 *     says `stopped: false`. This one must never read as success.
 *
 * `res` is the `{ ok, status, body }` envelope `api.procStop`/`api.procDrain`
 * return, because a refusal here is a PAYLOAD, not an exception.
 */
export function procWriteOutcome(res, label = "Stop") {
  const r = res && typeof res === "object" ? res : {};
  const body = r.body && typeof r.body === "object" ? r.body : {};
  const status = typeof r.status === "number" ? r.status : 0;
  const reason = typeof body.reason === "string" && body.reason !== "" ? body.reason : null;
  const serverMessage =
    typeof body.message === "string" && body.message !== "" ? body.message : null;
  const notAdopted = reason === "not-adopted";
  if (r.ok === true && body.stopped !== false) {
    return body.viaSignal === true
      ? {
          ok: true,
          code: "via-signal",
          notAdopted: false,
          tone: "info",
          message: "No control plane — drained with SIGTERM instead",
        }
      : { ok: true, code: "stopped", notAdopted: false, tone: "info", message: null };
  }
  if (notAdopted) {
    return {
      ok: false,
      code: "not-adopted",
      notAdopted: true,
      tone: "error",
      message: `${label} did nothing — ${(serverMessage ?? NOT_ADOPTED_SENTENCE).replace(
        /\.$/,
        "",
      )}. ${NOT_ADOPTED_RETRY}`,
    };
  }
  const code = reason ?? (status === 0 ? "error" : `http-${status}`);
  return {
    ok: false,
    code,
    notAdopted: false,
    tone: "error",
    message: `${label} did nothing — ${serverMessage ?? code}`,
  };
}

/** One `/api/h/:id/proc` payload → the board row / detail header model. */
export function procRow(proc, nowMs) {
  const p = proc && typeof proc === "object" ? proc : {};
  return {
    id: typeof p.id === "string" ? p.id : "",
    target: typeof p.target === "string" ? p.target : "",
    runClass: typeof p.runClass === "string" ? p.runClass : "",
    pill: procStatePill(p.state),
    state: typeof p.state === "string" ? p.state : "unknown",
    runId: typeof p.runId === "string" ? p.runId : null,
    pid: typeof p.pid === "number" ? p.pid : null,
    uptime: uptimeLabel(p.startedAt, nowMs),
    adopted: p.adopted === true,
    draining: p.draining === true,
    restartsInWindow: typeof p.restartsInWindow === "number" ? p.restartsInWindow : 0,
    restart: restartCountdown(p.nextRestartAtMs, nowMs),
    // The live snapshot first; after a manager restart the ledger is the only
    // record of how the last run ended, and saying nothing would read as
    // "nothing has ever gone wrong here".
    lastExit: exitBanner(p.lastExit ?? ledgerExit(p.recentRuns)),
    forensics: p.forensics && typeof p.forensics === "object" ? p.forensics : null,
    control: controlAvailability(p.control),
    bundle: bundleBadge(p.bundle),
    launch: launchModel(p.launch),
    recentRuns: Array.isArray(p.recentRuns) ? p.recentRuns : [],
    actions: procActions(p),
  };
}

/**
 * The fleet failure board: harnesses grouped by how they died, biggest group
 * first — "3 harnesses exited 31 — provider funding" reads as one incident
 * rather than three unrelated red rows.
 */
export function failureBoard(entries) {
  const groups = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = raw && typeof raw === "object" ? raw : {};
    const banner = exitBanner(entry.lastExit);
    if (banner === null) continue;
    // An operator stop is not news. A long-running shape that "finished" on
    // its own IS — it has lost its listener — so it groups like a failure.
    if (banner.disposition === "clean" && !banner.unexpectedClean) continue;
    const key =
      banner.failureClass ??
      (banner.exitCode !== null ? `exit-${banner.exitCode}` : banner.disposition);
    const group = groups.get(key) ?? {
      key,
      failureClass: banner.failureClass,
      classLabel: banner.classLabel,
      exitCode: banner.exitCode,
      title: banner.title,
      remediation: banner.remediation,
      dot: banner.dot,
      harnesses: [],
    };
    group.harnesses.push({
      id: typeof entry.id === "string" ? entry.id : "",
      name: typeof entry.name === "string" && entry.name !== "" ? entry.name : (entry.id ?? ""),
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      count: g.harnesses.length,
      // "3 harnesses exited 31 — provider funding": the count, the code an
      // operator can grep for, and the plain-English class.
      label: `${g.harnesses.length} harness${g.harnesses.length === 1 ? "" : "es"} ${
        g.exitCode !== null ? `exited ${g.exitCode}` : g.title
      }${g.classLabel !== null ? ` — ${g.classLabel}` : g.exitCode !== null ? ` — ${g.title}` : ""}`,
    }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// preflight refusal → modal
// ---------------------------------------------------------------------------

/**
 * A `POST /proc/start` 409 body → the modal model.
 *
 * `canForce` is the load-bearing field: an operator often knows better than
 * an offline check, EXCEPT about missing channel secrets, which the compiled
 * daemon's own boot gate exits 2 on. So "Start anyway" is hidden — not
 * merely disabled — whenever any refused item is unforceable.
 */
export function refusalModel(body) {
  const b = body && typeof body === "object" ? body : {};
  const reason = typeof b.reason === "string" ? b.reason : "unknown";
  if (reason === "preflight-blocked") {
    const items = (Array.isArray(b.refused) ? b.refused : []).map((raw) => {
      const item = raw && typeof raw === "object" ? raw : {};
      return {
        id: typeof item.id === "string" ? item.id : "",
        area: typeof item.area === "string" ? item.area : "",
        level: typeof item.level === "string" ? item.level : "blocking",
        message: typeof item.message === "string" ? item.message : "",
        remediation: typeof item.remediation === "string" ? item.remediation : null,
        acknowledgeable: item.acknowledgeable === true,
      };
    });
    const unforceable = Array.isArray(b.unforceable) ? b.unforceable.map(String) : [];
    const canForce = items.length > 0 && items.every((i) => i.acknowledgeable);
    return {
      kind: "preflight",
      title: "Preflight refused this start",
      message: `${items.length} blocking finding${items.length === 1 ? "" : "s"} — fix them, or wave the forceable ones through.`,
      items,
      unforceable,
      canForce,
      acknowledge: items.filter((i) => i.acknowledgeable).map((i) => i.id),
      forceHint: canForce
        ? "Start anyway acknowledges every finding above. The daemon still runs its own boot gate."
        : "Start anyway is unavailable: the compiled daemon's boot gate exits 2 on the findings marked unforceable.",
      remedy: null,
      action: null,
    };
  }
  if (reason === "plan-failed") {
    const remedy = typeof b.remedy === "string" ? b.remedy : null;
    return {
      kind: "plan-failed",
      title: "There is nothing to launch",
      message: typeof b.message === "string" ? b.message : "the spawn plan could not be built",
      items: [],
      unforceable: [],
      canForce: false,
      acknowledge: [],
      forceHint: null,
      remedy,
      action: remedyAction(remedy),
    };
  }
  if (reason === "already-running") {
    return {
      kind: "already-running",
      title: "A daemon is already running",
      message:
        typeof b.message === "string"
          ? b.message
          : "a daemon is already running for this harness (the runfile is the lock)",
      items: [],
      unforceable: [],
      canForce: false,
      acknowledge: [],
      forceHint: null,
      remedy: null,
      action: null,
      runfile: b.runfile ?? null,
    };
  }
  return {
    kind: "error",
    title: "The start was refused",
    message: typeof b.message === "string" ? b.message : reason,
    items: [],
    unforceable: [],
    canForce: false,
    acknowledge: [],
    forceHint: null,
    remedy: null,
    action: null,
  };
}

// ---------------------------------------------------------------------------
// control.v1 envelopes
// ---------------------------------------------------------------------------

/**
 * A control envelope → how to render the control that produced it.
 *
 *   - `expected: true`  ⇒ DISABLED WITH REASON (a fact about this bundle);
 *   - `tick_in_flight`  ⇒ retryable, spinner, same button;
 *   - anything else     ⇒ a real fault worth an error.
 */
export function controlOutcome(envelope) {
  const e = envelope && typeof envelope === "object" ? envelope : {};
  if (e.ok === true) {
    return {
      ok: true,
      code: null,
      reason: null,
      expected: false,
      retryable: false,
      disabled: false,
      tone: "ok",
      dot: "ok",
      body: e,
    };
  }
  const code = typeof e.code === "string" && e.code !== "" ? e.code : "error";
  const expected = e.expected === true;
  const retryable = e.retryable === true;
  return {
    ok: false,
    code,
    reason: typeof e.reason === "string" && e.reason !== "" ? e.reason : code,
    expected,
    retryable,
    // Expected refusals disable the control; a retryable one keeps it live.
    disabled: expected,
    tone: expected ? "expected" : retryable ? "retry" : "error",
    dot: expected ? "off" : retryable ? "warn" : "bad",
    upstreamStatus: typeof e.upstreamStatus === "number" ? e.upstreamStatus : null,
    body: null,
  };
}

// ---------------------------------------------------------------------------
// the four-lane timeline
// ---------------------------------------------------------------------------

/** Lanes control.v1 can actually poke; the other two are read-only rows. */
export const POKEABLE_LANES = ["heartbeat", "schedule"];

/**
 * One scheduler row + the view it came from → the lane's render model.
 *
 * The asymmetry is the whole story: cadence is declared in the spec and so is
 * knowable offline, while PHASE (last fired / next due) is knowable only
 * inside the process that armed the timer. With no control plane the honest
 * answer is "cadence only", never a blank that reads as a gap.
 */
export function laneModel(row, view, nowMs) {
  const r = row && typeof row === "object" ? row : {};
  const v = view && typeof view === "object" ? view : {};
  const reachable = v.controlReachable === true;
  const armed = r.armed === true;
  const nextDueAt = typeof r.nextDueAt === "string" ? r.nextDueAt : null;
  const lastFiredAt = typeof r.lastFiredAt === "string" ? r.lastFiredAt : null;
  const lastOutcome = typeof r.lastOutcome === "string" ? r.lastOutcome : null;
  const failed = lastOutcome === "error" || lastOutcome === "failed";
  return {
    lane: typeof r.lane === "string" ? r.lane : "",
    armed,
    cadence: typeof r.cadence === "string" ? r.cadence : null,
    cadenceSource: typeof r.cadenceSource === "string" ? r.cadenceSource : "none",
    lastFiredAt,
    lastFiredLabel: lastFiredAt !== null ? fmtRelativeTime(lastFiredAt, nowMs) : "—",
    lastOutcome,
    nextDueAt,
    nextDueLabel:
      nextDueAt !== null
        ? fmtRelativeTime(nextDueAt, nowMs)
        : reachable
          ? "no tick scheduled"
          : "cadence only",
    // Null exactly when the phase IS known; otherwise the honest reason.
    phaseNote:
      nextDueAt !== null
        ? null
        : reachable
          ? "this daemon armed no next tick for the lane"
          : typeof v.controlReason === "string" && v.controlReason !== ""
            ? v.controlReason
            : "the daemon's control plane is not reachable",
    pokeable: r.pokeable === true,
    pokeReason: typeof r.pokeReason === "string" ? r.pokeReason : null,
    detail: r.detail ?? null,
    dot: !armed ? "off" : failed ? "bad" : reachable ? "ok" : "unknown",
    label: !armed
      ? "not declared"
      : failed
        ? `last tick ${lastOutcome}`
        : reachable
          ? "armed"
          : "declared — phase unknown",
  };
}

/** Every lane of a `/schedulers` payload, in the server's display order. */
export function laneModels(view, nowMs) {
  const v = view && typeof view === "object" ? view : {};
  const lanes = Array.isArray(v.lanes) ? v.lanes : [];
  return lanes.map((lane) => laneModel(lane, v, nowMs));
}

// ---------------------------------------------------------------------------
// the live run feed
// ---------------------------------------------------------------------------

/** Trace kinds whose card leads with a bad/warn dot. */
const EVENT_DOT = {
  run_failed: "bad",
  alert_raised: "bad",
  error_recovered: "warn",
  circuit_state_changed: "warn",
  model_failover: "warn",
  compaction_fired: "warn",
  approval_requested: "warn",
};

function shortJson(value, max = 120) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `model` first, then the optional facets, then the router's reason — joined with dots. */
function routeDetail(e, parts) {
  const head = parts
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map(String);
  const reason = typeof e.reason === "string" && e.reason !== "" ? e.reason : null;
  return [...head, ...(reason ? [reason] : [])].join(" · ");
}

/**
 * One TraceEvent → its feed card. Known kinds get a written line; unknown
 * kinds still render (tolerant-reader contract) with a clipped payload
 * summary, so nothing is silently dropped from an operator's feed.
 */
export function traceCard(event) {
  const e = event && typeof event === "object" ? event : {};
  const kind = typeof e.kind === "string" && e.kind !== "" ? e.kind : "event";
  const at = typeof e.timestamp === "string" ? e.timestamp : null;
  const base = { type: "event", kind, at, dot: EVENT_DOT[kind] ?? null, payload: e };
  switch (kind) {
    case "turn_start":
      return { ...base, title: `turn ${e.turn ?? e.turnNumber ?? "?"} started`, detail: "" };
    case "turn_end":
      return {
        ...base,
        title: `turn ${e.turn ?? e.turnNumber ?? "?"} ended`,
        detail: typeof e.durationMs === "number" ? fmtDurationMs(e.durationMs) : "",
      };
    case "model_request":
      return { ...base, title: "model request", detail: String(e.model ?? e.modelId ?? "") };
    case "model_response":
      return { ...base, title: "model response", detail: String(e.model ?? e.modelId ?? "") };
    case "tool_call_start":
      return { ...base, title: `tool ${String(e.toolName ?? "?")}`, detail: "started" };
    case "tool_call_end":
      return {
        ...base,
        dot: e.isError === true ? "bad" : "ok",
        title: `tool ${String(e.toolName ?? "?")}`,
        detail: `${e.isError === true ? "failed" : "ok"}${
          typeof e.durationMs === "number" ? ` · ${fmtDurationMs(e.durationMs)}` : ""
        }`,
      };
    case "cost_accrual":
      return {
        ...base,
        title: "cost",
        detail: `${String(e.modelId ?? "")} · ${(usdFromMicros(e.costUsdMicros) ?? 0).toFixed(4)} USD`,
      };
    case "permission_decision":
      return {
        ...base,
        dot: e.decision === "deny" ? "bad" : e.decision === "ask" ? "warn" : "ok",
        title: `permission ${String(e.decision ?? "?")}`,
        detail: String(e.toolName ?? ""),
      };
    case "approval_requested":
      return { ...base, title: "approval requested", detail: String(e.toolName ?? "") };
    case "approval_resolved":
      return {
        ...base,
        title: `approval ${String(e.decision ?? "resolved")}`,
        detail: String(e.toolName ?? ""),
      };
    case "run_failed":
      return {
        ...base,
        title: `run failed — ${String(e.class ?? "unknown")}`,
        detail: String(e.message ?? ""),
        remediation: typeof e.remediation === "string" ? e.remediation : null,
      };
    case "model_route":
      // 0.6.0 (design §8.3) — the event carries `model` (wire id) and
      // `routeKey`, never `modelId`/`band`; the 0.5.x card read the latter
      // and rendered an empty detail. Profile, policy and reason follow when
      // present so a hybrid decision reads as a sentence.
      return {
        ...base,
        title: `model route${e.stage ? ` · ${String(e.stage)}` : ""}`,
        detail: routeDetail(e, [
          e.model,
          e.profile ? `profile=${String(e.profile)}` : null,
          e.routeKey ? `band=${String(e.routeKey)}` : null,
          e.policy
            ? `policy=${String(e.policy)}${e.explored === true ? " (exploring)" : ""}`
            : null,
          e.ruleId ? `rule=${String(e.ruleId)}` : null,
        ]),
      };
    case "model_tier_route":
      return {
        ...base,
        title: "model tier",
        detail: routeDetail(e, [
          e.model,
          e.tier ? `tier=${String(e.tier)}${e.escalated === true ? " (escalated)" : ""}` : null,
        ]),
      };
    case "model_failover":
      return {
        ...base,
        title: "model failover",
        detail: `${String(e.from ?? "?")} → ${String(e.to ?? "?")}${
          e.reason ? ` · ${String(e.reason)}` : ""
        }`,
      };
    case "model_stage":
      return {
        ...base,
        dot: e.outcome === "failed" ? "warn" : base.dot,
        title: `stage ${String(e.stage ?? "?")} ${String(e.outcome ?? "")}`.trim(),
        detail: [
          e.model ? String(e.model) : null,
          e.profile ? `profile=${String(e.profile)}` : null,
          e.role ? `role=${String(e.role)}` : null,
          e.strategy ? `strategy=${String(e.strategy)}` : null,
          e.cause ? `cause=${String(e.cause)}` : null,
        ]
          .filter((part) => part !== null)
          .join(" · "),
      };
    case "model_directive":
      return {
        ...base,
        dot: e.accepted === false ? "warn" : base.dot,
        title: `/model ${String(e.requested ?? "?")} ${e.accepted === false ? "refused" : "accepted"}`,
        detail: [
          e.resolved ? `→ ${String(e.resolved)}` : null,
          e.source ? `source=${String(e.source)}` : null,
          e.reason ? String(e.reason) : null,
        ]
          .filter((part) => part !== null)
          .join(" · "),
      };
    case "janitor_action":
      return { ...base, title: "janitor", detail: String(e.action ?? "") };
    default:
      return { ...base, title: kind, detail: shortJson(e.payload ?? e.detail ?? null) };
  }
}

/** Non-empty prose lines of a captured-output chunk, as one feed item. */
function proseItem(prose) {
  const lines = String(prose ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.length === 0 ? null : { type: "prose", lines };
}

/**
 * One SSE frame → the feed items it contributes.
 *
 * The grammar is fixed: `replay` (a full RunDetail) opens every stream and
 * `done` always closes it, so a closed run replays and terminates without the
 * client needing a live-vs-dead branch.
 */
export function sseFrameToFeed(eventName, data) {
  const d = data && typeof data === "object" ? data : {};
  switch (eventName) {
    case "replay": {
      const events = Array.isArray(d.events) ? d.events : [];
      const items = [
        {
          type: "marker",
          title: `replayed ${events.length} recorded event${events.length === 1 ? "" : "s"}`,
          detail: d.eventsTruncated === true ? "older events were capped" : "",
        },
        ...events.map(traceCard),
      ];
      const tail = Array.isArray(d.proseTail) ? d.proseTail.join("\n") : "";
      const prose = proseItem(tail);
      if (prose !== null) items.push(prose);
      // A run that already ended carries its outcome on the ledger row — the
      // `exit` frame only ever arrives LIVE, so a replayed run would
      // otherwise show a feed that just stops.
      const ended = exitBanner(
        ledgerExit(d.entry === null || d.entry === undefined ? [] : [d.entry]),
      );
      if (ended !== null) {
        items.push({ type: "exit", banner: ended, title: ended.title, dot: ended.dot });
      }
      return items;
    }
    case "output": {
      const items = [];
      const prose = proseItem(d.prose);
      if (prose !== null) items.push(prose);
      for (const event of Array.isArray(d.events) ? d.events : []) items.push(traceCard(event));
      return items;
    }
    case "state": {
      const snapshot = d.snapshot && typeof d.snapshot === "object" ? d.snapshot : {};
      const pill = procStatePill(snapshot.state);
      return [{ type: "state", title: `state → ${pill.label}`, dot: pill.dot, pill }];
    }
    case "exit": {
      const banner = exitBanner(d.classification);
      return [
        { type: "exit", banner, title: banner?.title ?? "exited", dot: banner?.dot ?? "bad" },
      ];
    }
    case "done":
      return [
        {
          type: "done",
          title: "stream closed",
          detail: typeof d.reason === "string" ? d.reason : "",
        },
      ];
    default:
      return [];
  }
}

/** One `event:`/`data:` block → `{ event, data }`, or null when it carries
 *  no data line (a comment/keep-alive). */
function parseSseFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.startsWith("event:")) event = clean.slice(6).trim();
    else if (clean.startsWith("data:")) dataLines.push(clean.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  let data = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = null; // a torn frame is skipped, never fatal to the stream
  }
  return { event, data };
}

/**
 * Incremental SSE parser. `push(chunk)` returns the frames completed by that
 * chunk and keeps the remainder buffered — network chunks split frames
 * anywhere, including mid-JSON.
 *
 * Hand-rolled rather than `EventSource` for one reason: the console
 * authenticates with a bearer header, and `EventSource` cannot send one (its
 * only credential channel is cookies, which this app deliberately has none
 * of — no cookies, no CSRF surface).
 */
export function createSseParser() {
  let buffer = "";
  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      const frames = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = parseSseFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (frame !== null) frames.push(frame);
        boundary = buffer.indexOf("\n\n");
      }
      return frames;
    },
    /** Whatever never terminated — a dropped connection mid-frame. */
    rest: () => buffer,
  };
}

/** Fold feed items into the stats/cost HUD. Pure; recomputed on every frame. */
export function runHud(items) {
  const hud = {
    events: 0,
    turns: 0,
    tools: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    failed: false,
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.type !== "event") continue;
    hud.events += 1;
    const p = item.payload && typeof item.payload === "object" ? item.payload : {};
    if (item.kind === "turn_start") hud.turns += 1;
    if (item.kind === "tool_call_end") {
      hud.tools += 1;
      if (p.isError === true) hud.toolErrors += 1;
    }
    if (item.kind === "cost_accrual") {
      hud.costUsd += usdFromMicros(p.costUsdMicros) ?? 0;
      if (typeof p.inputTokens === "number") hud.inputTokens += p.inputTokens;
      if (typeof p.outputTokens === "number") hud.outputTokens += p.outputTokens;
    }
    if (item.kind === "run_failed") hud.failed = true;
  }
  return hud;
}

/** One run-ledger row → the runs-table model. */
export function runLedgerRow(entry, nowMs) {
  const e = entry && typeof entry === "object" ? entry : {};
  const started = parseTs(e.startedAt);
  const ended = parseTs(e.endedAt);
  const open = ended === null;
  const exitCode = typeof e.exitCode === "number" ? e.exitCode : null;
  return {
    runId: typeof e.runId === "string" ? e.runId : "",
    kind: typeof e.kind === "string" ? e.kind : "run",
    startedAt: typeof e.startedAt === "string" ? e.startedAt : null,
    startedLabel: fmtRelativeTime(e.startedAt ?? null, nowMs),
    duration: started === null ? "—" : fmtDurationMs((ended ?? nowMs) - started),
    open,
    exitCode,
    failureClass: typeof e.failureClass === "string" ? e.failureClass : null,
    forced: e.forced === true,
    sessionId: typeof e.sessionId === "string" ? e.sessionId : null,
    logFile: typeof e.logFile === "string" ? e.logFile : null,
    dot: open ? "unknown" : exitCode === 0 ? "ok" : "bad",
    exitLabel: open
      ? "still running"
      : exitCode === null
        ? "ended"
        : `exit ${exitCode}${typeof e.failureClass === "string" ? ` — ${CLASS_LABELS[e.failureClass] ?? e.failureClass}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// the two inboxes: keyboard triage
// ---------------------------------------------------------------------------

/** Approvals-inbox action keys. */
export const APPROVAL_KEYS = { g: "grant", d: "deny" };
/** Review-queue action keys — the verdicts the server accepts. */
export const REVIEW_KEYS = { u: "up", d: "down", p: "pass", f: "fail" };

/** The bindings help sheet, rendered by `?`. */
export function keyHelp(actionKeys) {
  const keys = actionKeys && typeof actionKeys === "object" ? actionKeys : {};
  return [
    { key: "j / ↓", does: "next row" },
    { key: "k / ↑", does: "previous row" },
    ...Object.entries(keys).map(([key, action]) => ({ key, does: action })),
    { key: ".", does: "row menu" },
    { key: "?", does: "this list" },
    { key: "esc", does: "close menus" },
  ];
}

/** Navigation keys the triage reducer owns (everything else falls through
 *  to the browser — an inbox must not swallow ⌘F). */
const TRIAGE_NAV_KEYS = new Set(["j", "k", "ArrowDown", "ArrowUp", ".", "?", "Escape"]);

/** True when the reducer would act on this key — the view's "should I
 *  preventDefault?" test, kept here so it cannot drift from the reducer. */
export function isTriageKey(key, actionKeys = APPROVAL_KEYS) {
  if (TRIAGE_NAV_KEYS.has(key)) return true;
  const map = actionKeys && typeof actionKeys === "object" ? actionKeys : {};
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * The triage keyboard reducer. Pure: `(state, key) → { state, effect }`,
 * where `effect` is the action a row asked for (the view performs it). Both
 * inboxes share it; only the action-key map differs.
 */
export function triageKey(state, key, actionKeys = APPROVAL_KEYS) {
  const s = {
    index: 0,
    count: 0,
    menuOpen: false,
    helpOpen: false,
    ...(state && typeof state === "object" ? state : {}),
  };
  const clamp = (i) => (s.count <= 0 ? 0 : Math.min(Math.max(i, 0), s.count - 1));
  const next = (patch) => ({ state: { ...s, ...patch }, effect: null });
  switch (key) {
    case "j":
    case "ArrowDown":
      return next({ index: clamp(s.index + 1), menuOpen: false });
    case "k":
    case "ArrowUp":
      return next({ index: clamp(s.index - 1), menuOpen: false });
    case ".":
      return next({ menuOpen: !s.menuOpen });
    case "?":
      return next({ helpOpen: !s.helpOpen });
    case "Escape":
      return next({ menuOpen: false, helpOpen: false });
    default: {
      const map = actionKeys && typeof actionKeys === "object" ? actionKeys : {};
      const action = map[key];
      if (action === undefined || s.count <= 0) return { state: s, effect: null };
      return { state: { ...s, menuOpen: false }, effect: { action, index: clamp(s.index) } };
    }
  }
}

/** One approvals row → its inbox model. */
export function approvalRow(row, nowMs) {
  const r = row && typeof row === "object" ? row : {};
  const status = typeof r.status === "string" ? r.status : "pending";
  const parked = r.parkedRun && typeof r.parkedRun === "object" ? r.parkedRun : null;
  return {
    id: typeof r.id === "string" ? r.id : "",
    harnessId: typeof r.harnessId === "string" ? r.harnessId : "",
    specName: typeof r.specName === "string" ? r.specName : "",
    toolName: typeof r.toolName === "string" ? r.toolName : "tool",
    // Verbatim (the server already masked it) — an approver cannot judge a
    // call they cannot see.
    input: r.input ?? null,
    inputHash: typeof r.inputHash === "string" ? r.inputHash : "",
    surface: typeof r.surface === "string" ? r.surface : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
    age: fmtRelativeTime(r.createdAt ?? null, nowMs),
    status,
    pending: status === "pending",
    decidedBy: typeof r.decidedBy === "string" ? r.decidedBy : null,
    dot: status === "pending" ? "warn" : status === "denied" ? "bad" : "ok",
    parkedRun: parked,
    // A parked CLI/daemon run resumes once the approval is granted; the row
    // says so instead of leaving the operator wondering what happens next.
    resumeNote:
      parked !== null && typeof parked.runId === "string" && parked.runId !== ""
        ? "granting resumes the parked run (it re-executes pre-resolved)"
        : null,
  };
}

/** One review-queue row → its inbox model. */
export function reviewRow(row, nowMs) {
  const r = row && typeof row === "object" ? row : {};
  const sourceRef = r.sourceRef && typeof r.sourceRef === "object" ? r.sourceRef : {};
  const status = typeof r.status === "string" ? r.status : "open";
  const adjudicable = r.adjudicable === true;
  return {
    id: typeof r.id === "string" ? r.id : "",
    harnessId: typeof r.harnessId === "string" ? r.harnessId : "",
    specName: typeof r.specName === "string" ? r.specName : "",
    kind: typeof r.kind === "string" ? r.kind : "item",
    status,
    open: status === "open",
    ts: typeof r.ts === "string" ? r.ts : null,
    age: fmtRelativeTime(r.ts ?? null, nowMs),
    context: typeof r.context === "string" ? r.context : "",
    sourceRef,
    sessionId: typeof sourceRef.sessionId === "string" ? sourceRef.sessionId : null,
    turn: typeof sourceRef.turn === "number" ? sourceRef.turn : null,
    adjudicable,
    // Thumbs settle the underlying disagreement; pass/fail records a verdict
    // on the item. Offering thumbs where they cannot land would 409.
    verdicts: adjudicable ? ["up", "down", "pass", "fail"] : ["pass", "fail"],
    verdictNote: adjudicable
      ? "up/down adjudicate the rated turn itself"
      : "this item points at no session turn — pass/fail records the verdict on the item",
    dot: status === "open" ? "warn" : "ok",
  };
}

// ---------------------------------------------------------------------------
// the activity digest
// ---------------------------------------------------------------------------

/** Digest kinds in display order, with their group headings. */
export const ACTIVITY_KINDS = [
  { kind: "run", label: "Runs" },
  { kind: "session", label: "Sessions" },
  { kind: "eval", label: "Evals" },
  { kind: "approval", label: "Approvals" },
  { kind: "spec", label: "Spec changes" },
  { kind: "dream", label: "Dream" },
  { kind: "wiki", label: "Wiki" },
  { kind: "incident", label: "Incidents" },
  { kind: "deploy", label: "Deploys" },
];

/** Deep link for one digest item — every row lands on the screen that owns it. */
export function activityHref(item) {
  const i = item && typeof item === "object" ? item : {};
  const id = typeof i.harnessId === "string" ? i.harnessId : "";
  const ref = typeof i.ref === "string" && i.ref !== "" ? i.ref : null;
  if (id === "") return null;
  switch (i.kind) {
    case "session":
      return ref !== null ? hrefHarness(id, "sessions", ref) : hrefHarness(id, "sessions");
    case "run":
      return ref !== null ? hrefHarness(id, "runs", ref) : hrefHarness(id, "runs");
    case "eval":
      return ref !== null ? hrefHarness(id, "evals", ref) : hrefHarness(id, "evals");
    case "spec":
      return hrefHarness(id, "spec");
    case "dream":
    case "wiki":
      return i.kind === "wiki" && ref !== null
        ? hrefHarness(id, "memory", "wiki", ref)
        : hrefHarness(id, "memory");
    case "deploy":
      return hrefHarness(id, "deploy");
    case "approval":
      return "#/approvals";
    default:
      return hrefHarness(id);
  }
}

/**
 * Group a digest by kind, in display order. `enabled` (a Set of kinds, or
 * null for "all") filters which groups render; every group keeps its count so
 * a filtered-out kind still shows how much it is hiding.
 */
export function activityGroups(items, enabled = null) {
  const list = Array.isArray(items) ? items : [];
  return ACTIVITY_KINDS.map((meta) => {
    const matching = list.filter((i) => i && i.kind === meta.kind);
    return {
      kind: meta.kind,
      label: meta.label,
      count: matching.length,
      shown: enabled === null || enabled.has(meta.kind),
      items: matching,
    };
  }).filter((g) => g.count > 0);
}

// ---------------------------------------------------------------------------
// jobs + deployments
// ---------------------------------------------------------------------------

const JOB_DOT = {
  running: "ok",
  pending: "unknown",
  interrupted: "warn",
  failed: "bad",
  cancelled: "off",
  done: "off",
};

/**
 * `/api/jobs` → the queue panel model.
 *
 * `recent` is READ, not decoration. A job that was running when the previous
 * manager died is closed as `interrupted` at the next boot and never
 * silently re-run — and closing it is exactly what takes it OUT of the
 * queue: `restore()` appends the terminal record to the ledger rather than
 * returning the job to `pending`/`running`. So the only channel an
 * interrupted job reaches the console through is `recent`, and folding just
 * `pending` + `running` left the Interrupted group permanently empty while
 * an abandoned mutating `compile` went unreported.
 */
export function jobQueueModel(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const jobs = (v) => (Array.isArray(v) ? v : []).filter((j) => j && typeof j === "object");
  const pending = jobs(p.pending);
  const running = jobs(p.running);
  const recent = jobs(p.recent);
  // The same job can legitimately appear in two lists across a restore, so
  // the fold is de-duplicated by id rather than concatenated.
  const seen = new Set();
  const interrupted = [];
  for (const job of [...running, ...pending, ...recent]) {
    if (job.state !== "interrupted") continue;
    const key = typeof job.jobId === "string" && job.jobId !== "" ? job.jobId : null;
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    interrupted.push(job);
  }
  const runningLive = running.filter((j) => j.state !== "interrupted");
  const pendingLive = pending.filter((j) => j.state !== "interrupted");
  return {
    running: runningLive,
    pending: pendingLive,
    interrupted,
    total: runningLive.length + pendingLive.length + interrupted.length,
  };
}

/** One job record → its row model. */
export function jobRow(job, nowMs) {
  const j = job && typeof job === "object" ? job : {};
  const state = typeof j.state === "string" ? j.state : "pending";
  return {
    jobId: typeof j.jobId === "string" ? j.jobId : "",
    harnessId: typeof j.harnessId === "string" ? j.harnessId : null,
    harnessDir: typeof j.harnessDir === "string" ? j.harnessDir : "",
    kind: typeof j.kind === "string" ? j.kind : "job",
    argv: Array.isArray(j.argv) ? j.argv.map(String) : [],
    state,
    dot: JOB_DOT[state] ?? "unknown",
    mutating: j.mutating === true,
    enqueued: fmtRelativeTime(j.enqueuedAt ?? null, nowMs),
    error: typeof j.error === "string" ? j.error : null,
  };
}

/** PaaS providers the deploy adapters ship. */
const PAAS_PROVIDERS = new Set(["fly", "fly.io", "flyio", "render", "railway", "heroku"]);

/** One deployment record → its row model, with an inferred deploy class. */
export function deploymentRow(record, nowMs) {
  const r = record && typeof record === "object" ? record : {};
  const provider = String(r.provider ?? r.target ?? r.platform ?? "").toLowerCase();
  const klass = /cloudflare|cf-?worker|workers?/.test(provider)
    ? "cf-worker"
    : PAAS_PROVIDERS.has(provider)
      ? "PaaS"
      : provider === ""
        ? "unknown"
        : "local";
  const health =
    typeof r.health === "string" ? r.health : typeof r.status === "string" ? r.status : null;
  const healthy = health === null ? null : /^(ok|healthy|up|live|running|success)$/i.test(health);
  return {
    env:
      typeof r.env === "string" ? r.env : typeof r.environment === "string" ? r.environment : "—",
    version: typeof r.version === "string" ? r.version : null,
    provider: provider === "" ? null : provider,
    klass,
    url: typeof r.url === "string" ? r.url : null,
    at: typeof r.at === "string" ? r.at : typeof r.deployedAt === "string" ? r.deployedAt : null,
    when: fmtRelativeTime(r.at ?? r.deployedAt ?? null, nowMs),
    health,
    dot: healthy === null ? "unknown" : healthy ? "ok" : "bad",
    healthLabel: health ?? "health not recorded",
  };
}

// ---------------------------------------------------------------------------
// CLI twins
// ---------------------------------------------------------------------------

function quoteArg(value) {
  const s = String(value);
  return s.includes(" ") ? JSON.stringify(s) : s;
}

/** The `crewhaus` argv each job kind runs — mirrors the server's `jobArgv`. */
export const JOB_COMMANDS = {
  doctor: "crewhaus doctor",
  compile: "crewhaus compile crewhaus.yaml -o dist",
  eval: "crewhaus eval crewhaus.yaml",
  "dream-run": "crewhaus dream run crewhaus.yaml",
};

/**
 * The exact command an action's CLI twin runs. Every button in the console
 * shows one: it is the single best trust affordance in the design, because
 * an operator can verify what a click will do before clicking it — and the
 * two heads (CLI and console) drive the same state tree.
 *
 * Returns null where no CLI verb exists yet; the caller renders the honest
 * note from {@link NO_TWIN_NOTES} instead of inventing a command.
 */
export function cliTwinFor(action, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const dir = typeof a.dir === "string" && a.dir !== "" ? a.dir : null;
  const at = (command) => (dir !== null ? `cd ${quoteArg(dir)} && ${command}` : command);
  switch (action) {
    case "start": {
      const ack = Array.isArray(a.acknowledge) ? a.acknowledge.filter((x) => x !== "") : [];
      return at(
        `crewhaus daemon start${a.force === true ? " --force" : ""}${
          ack.length > 0 ? ` --ack ${ack.join(",")}` : ""
        }`,
      );
    }
    case "stop":
      return at("crewhaus daemon stop");
    case "restart":
      return at("crewhaus daemon restart");
    case "drain":
      return at("crewhaus daemon drain");
    case "wake":
      return at(`crewhaus daemon wake --lane ${quoteArg(a.lane ?? "heartbeat")}`);
    case "logs":
      return at(
        `crewhaus daemon logs${a.runId !== undefined ? ` --run ${quoteArg(a.runId)}` : ""} --follow`,
      );
    case "grant":
      return at(`crewhaus approvals grant ${quoteArg(a.id ?? "<id>")}`);
    case "deny":
      return at(`crewhaus approvals deny ${quoteArg(a.id ?? "<id>")}`);
    case "review":
      return at(`crewhaus review resolve ${quoteArg(a.id ?? "<id>")}`);
    case "adjudicate":
      return at(
        `crewhaus rate --session ${quoteArg(a.sessionId ?? "<sess>")} --turn ${a.turn ?? 0} --thumbs ${quoteArg(a.verdict ?? "up")} --adjudicate`,
      );
    case "baseline":
      return at(`crewhaus eval-report baseline set ${quoteArg(a.runId ?? "<run>")}`);
    case "job":
      return typeof a.kind === "string" && JOB_COMMANDS[a.kind] !== undefined
        ? at(JOB_COMMANDS[a.kind])
        : null;
    default:
      return null;
  }
}

/** Actions with no CLI verb yet — said out loud rather than faked. */
export const NO_TWIN_NOTES = {
  "pin-session":
    "no CLI verb yet — this writes the `pins` list in .crewhaus/retention.json, which both retention enforcers read",
};
