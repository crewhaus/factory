/**
 * 0.7.1 — the two runtime writers under `.crewhaus/` that 0.7.0 left on
 * `appendFileSync` never write through a link a model planted:
 *
 *   - the watch-me capture sidecar, `.crewhaus/sessions/<id>.events.jsonl`
 *     (CREWHAUS_WATCHME=1), the sibling of the event log;
 *   - the alert watchdog's history, `.crewhaus/metrics/sessions.jsonl`
 *     (CREWHAUS_ALERTS=1), whose path is fixed, and its trim, which wrote the
 *     pid-derived `sessions.jsonl.tmp-<pid>-<ms>` and renamed it into place.
 *
 * A model with GitApplyPatch can create a symlink from a patch. 0.7.0 then
 * appended every trace event of the next watched run, or the session's
 * metrics, to the file the link named. Each case asserts the property (the
 * outside file is untouched, nothing is created outside) and the reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunContext } from "@crewhaus/run-context";
import { type TraceEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  MAX_METRICS_HISTORY_LINES,
  METRICS_FILENAME,
  type SessionMetricsSnapshot,
  appendMetricsSnapshot,
  readMetricsHistory,
} from "./alert-watchdog";
import { IDENTITY_FILENAME, loadOrCreateAgentIdentity } from "./identity";
import { attachIncidentCollector } from "./incident-collector";
import { attachAlertWatchdog, attachWatchmeCapture } from "./observability";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const VICTIM_TEXT = "ORIGINAL-AUTHORIZED-KEYS\n";
const SID = "sess_0123456789abcdef";

/** A workspace `.crewhaus`, and a victim file in a directory outside it. */
function layout(): { crewhaus: string; outside: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "runtime-links-"));
  ROOTS.push(base);
  const crewhaus = join(base, "ws", ".crewhaus");
  const outside = join(base, "outside");
  mkdirSync(crewhaus, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const victim = join(outside, "victim");
  writeFileSync(victim, VICTIM_TEXT);
  return { crewhaus, outside, victim };
}

function modelResponse(bus: TraceEventBus): TraceEvent {
  return {
    ...bus.envelope(),
    kind: "model_response",
    model: "m",
    inputTokens: 1,
    outputTokens: 1,
    note: "$(touch /tmp/pwned)",
  } as unknown as TraceEvent;
}

function snap(sessionId: string): SessionMetricsSnapshot {
  return {
    sessionId,
    ts: "2026-09-29T00:00:00.000Z",
    turns: 1,
    modelCalls: 1,
    unrecoveredErrors: 0,
    errorRate: 0,
    turnP95Seconds: 1,
    ttftP95Seconds: 1,
    costUsdMicros: 0,
    costBurnUsdPerMin: 0,
    pricingMisses: 0,
    circuitOpens: 0,
    egressBlocked: 0,
    permissionDenials: 0,
  };
}

describe("watch-me capture sidecar (0.7.1)", () => {
  test("a link planted at <id>.events.jsonl is never appended through, and the refusal is reported once", () => {
    const { crewhaus, victim } = layout();
    const sessions = join(crewhaus, "sessions");
    mkdirSync(sessions);
    symlinkSync(victim, join(sessions, `${SID}.events.jsonl`));
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const reports: string[] = [];
    const cap = attachWatchmeCapture(bus, sessions, SID, { CREWHAUS_WATCHME: "1" }, (m) =>
      reports.push(m),
    );
    expect(cap).toBeDefined();
    bus.publish(modelResponse(bus));
    bus.publish(modelResponse(bus));
    cap?.unsubscribe();
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(lstatSync(join(sessions, `${SID}.events.jsonl`)).isSymbolicLink()).toBe(true);
    // Once, naming the file and why.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(`${SID}.events.jsonl`);
    expect(reports[0]).toContain("code is-symlink");
  });

  test("a dangling link at <id>.events.jsonl creates nothing where it points", () => {
    const { crewhaus, outside } = layout();
    const sessions = join(crewhaus, "sessions");
    mkdirSync(sessions);
    const planted = join(outside, "planted.sh");
    symlinkSync(planted, join(sessions, `${SID}.events.jsonl`));
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const cap = attachWatchmeCapture(bus, sessions, SID, { CREWHAUS_WATCHME: "1" }, () => {});
    bus.publish(modelResponse(bus));
    cap?.unsubscribe();
    expect(existsSync(planted)).toBe(false);
  });

  test("an ordinary capture still appends one line per event", () => {
    const { crewhaus } = layout();
    const sessions = join(crewhaus, "sessions");
    mkdirSync(sessions);
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const reports: string[] = [];
    const cap = attachWatchmeCapture(bus, sessions, SID, { CREWHAUS_WATCHME: "1" }, (m) =>
      reports.push(m),
    );
    bus.publish(modelResponse(bus));
    bus.publish(modelResponse(bus));
    cap?.unsubscribe();
    const lines = readFileSync(join(sessions, `${SID}.events.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(reports).toEqual([]);
  });
});

describe("alert-watchdog metrics history (0.7.1)", () => {
  test("a link planted at metrics/sessions.jsonl is refused, never appended through", () => {
    const { crewhaus, victim } = layout();
    const metrics = join(crewhaus, "metrics");
    mkdirSync(metrics);
    symlinkSync(victim, join(metrics, METRICS_FILENAME));
    expect(() => appendMetricsSnapshot(snap(SID), metrics)).toThrow(/code is-symlink/);
    expect(() => readMetricsHistory(metrics)).toThrow(/code is-symlink/);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("a directory link planted at .crewhaus/metrics is refused: nothing lands outside", () => {
    const { crewhaus, outside } = layout();
    const metrics = join(crewhaus, "metrics");
    symlinkSync(outside, metrics);
    expect(() => appendMetricsSnapshot(snap(SID), metrics)).toThrow(/code escapes-root/);
    expect(readdirSync(outside)).toEqual(["victim"]);
  });

  test("the trim never writes through a link planted at a pid-derived temp name", () => {
    const { crewhaus, outside, victim } = layout();
    const metrics = join(crewhaus, "metrics");
    mkdirSync(metrics);
    // Past the line cap, so this append trims.
    const line = `${JSON.stringify(snap("s-old"))}\n`;
    writeFileSync(join(metrics, METRICS_FILENAME), line.repeat(MAX_METRICS_HISTORY_LINES + 5));
    // 0.7.0's temp was `<file>.tmp-<pid>-<ms>`; plant a link at every name a
    // pid-derived temp in this second could take.
    const now = Date.now();
    for (let ms = now; ms < now + 1500; ms += 1) {
      symlinkSync(victim, join(metrics, `${METRICS_FILENAME}.tmp-${process.pid}-${ms}`));
    }
    appendMetricsSnapshot(snap(SID), metrics);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
    expect(readdirSync(outside)).toEqual(["victim"]);
    const history = readMetricsHistory(metrics);
    expect(history.at(-1)?.sessionId).toBe(SID);
    expect(lstatSync(join(metrics, METRICS_FILENAME)).isFile()).toBe(true);
  });

  test("the watchdog still grades the session when its history is refused, and reports why", async () => {
    const { crewhaus, victim } = layout();
    const metrics = join(crewhaus, "metrics");
    mkdirSync(metrics);
    symlinkSync(victim, join(metrics, METRICS_FILENAME));
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const alerts: TraceEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "alert_raised") alerts.push(e);
    });
    const wd = attachAlertWatchdog(
      bus,
      createRunContext(),
      { CREWHAUS_ALERTS: "1" },
      { metricsDir: metrics },
    );
    // A wildly slow turn breaches the bootstrap threshold.
    bus.publish({
      ...bus.envelope(),
      kind: "turn_end",
      turn: 1,
      durationMs: 3_600_000,
    } as TraceEvent);
    await expect(wd?.finalize() ?? Promise.resolve()).rejects.toThrow(/code is-symlink/);
    expect(alerts.length).toBeGreaterThan(0);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });
});

describe("incident capture (0.7.1)", () => {
  test("a directory link planted at .crewhaus/incidents is refused: the capture lands nowhere outside", () => {
    const { crewhaus, outside } = layout();
    symlinkSync(outside, join(crewhaus, "incidents"));
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const errors: string[] = [];
    const ctx = createRunContext();
    const logger = ctx.logger;
    const spy = {
      ...ctx,
      logger: {
        ...logger,
        error: (m: string, f?: unknown) => errors.push(`${m} ${JSON.stringify(f)}`),
      },
    };
    const collector = attachIncidentCollector(
      bus,
      spy as never,
      { CREWHAUS_INCIDENTS: "1" },
      {
        incidentsDir: join(crewhaus, "incidents"),
      },
    );
    bus.publish({
      ...bus.envelope(),
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
      reason: "$(touch /tmp/pwned)",
    } as TraceEvent);
    collector?.unsubscribe();
    expect(readdirSync(outside)).toEqual(["victim"]);
    expect(errors.join("\n")).toContain("code escapes-root");
  });

  test("control: an ordinary capture still lands under .crewhaus/incidents", () => {
    const { crewhaus } = layout();
    const bus = new TraceEventBus({ runId: "run_1", sessionId: SID });
    const collector = attachIncidentCollector(
      bus,
      createRunContext(),
      { CREWHAUS_INCIDENTS: "1" },
      {
        incidentsDir: join(crewhaus, "incidents"),
      },
    );
    bus.publish({
      ...bus.envelope(),
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
      reason: "5 consecutive 429s",
    } as TraceEvent);
    collector?.unsubscribe();
    const [dir] = readdirSync(join(crewhaus, "incidents"));
    expect(readdirSync(join(crewhaus, "incidents", dir ?? "")).sort()).toEqual([
      "events.jsonl",
      "incident.json",
    ]);
  });
});

describe("agent identity (0.7.1)", () => {
  test("a link planted at identity.json is refused: the new keypair is never written through it", () => {
    const { crewhaus, victim } = layout();
    symlinkSync(victim, join(crewhaus, IDENTITY_FILENAME));
    expect(() => loadOrCreateAgentIdentity(crewhaus)).toThrow(
      /identity\.json: .*\(code is-symlink\)/,
    );
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_TEXT);
  });

  test("control: first boot mints, a later boot reads the same identity", () => {
    const { crewhaus } = layout();
    const first = loadOrCreateAgentIdentity(crewhaus);
    expect(loadOrCreateAgentIdentity(crewhaus).agentId).toBe(first.agentId);
    expect(lstatSync(join(crewhaus, IDENTITY_FILENAME)).isFile()).toBe(true);
  });
});
