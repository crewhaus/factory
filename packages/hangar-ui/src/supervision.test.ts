/**
 * Unit tests for the M2 view logic. Everything a supervision screen decides
 * — which action is live and why it is not, whether a control renders
 * disabled-with-reason or retries, what an SSE frame becomes, which key
 * moves which row — is a pure function in `supervision.js`, so it is proven
 * here rather than in a browser. The exact file the browser loads is the
 * file under test.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as sup from "../assets/js/supervision.js";

const NOW = Date.parse("2026-08-03T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("supervision state → pill", () => {
  test("every state in the machine has dot + text (color is never alone)", () => {
    const states = [
      "stopped",
      "preflight",
      "starting",
      "running",
      "draining",
      "crashed",
      "parked",
      "terminal",
      "crash-looping",
    ];
    for (const state of states) {
      const pill = sup.procStatePill(state);
      expect(`${state}:${pill.label !== ""}`).toBe(`${state}:true`);
      expect(["ok", "warn", "bad", "off", "unknown"]).toContain(pill.dot);
    }
  });

  test("parked is a warning, not a failure; terminal and crash-looping are bad", () => {
    expect(sup.procStatePill("parked").dot).toBe("warn");
    expect(sup.procStatePill("parked").note).toContain("not a failure");
    expect(sup.procStatePill("terminal").dot).toBe("bad");
    expect(sup.procStatePill("crash-looping").dot).toBe("bad");
  });

  test("an unknown state degrades rather than throwing", () => {
    expect(sup.procStatePill("teleporting").dot).toBe("unknown");
    expect(sup.procStatePill(undefined).state).toBe("unknown");
  });
});

describe("durations + countdowns", () => {
  test("duration tiers", () => {
    expect(sup.fmtDurationMs(42_000)).toBe("42s");
    expect(sup.fmtDurationMs(7 * MINUTE + 3000)).toBe("7m 3s");
    expect(sup.fmtDurationMs(5 * HOUR + 12 * MINUTE)).toBe("5h 12m");
    expect(sup.fmtDurationMs(3 * 24 * HOUR + 4 * HOUR)).toBe("3d 4h");
    expect(sup.fmtDurationMs(null)).toBe("—");
  });

  test("uptime is measured from the ISO start time; absent reads as em dash", () => {
    expect(sup.uptimeLabel(iso(-90 * MINUTE), NOW)).toBe("1h 30m");
    expect(sup.uptimeLabel(null, NOW)).toBe("—");
  });

  test("the restart countdown is null unless a restart is scheduled", () => {
    expect(sup.restartCountdown(undefined, NOW)).toBeNull();
    expect(sup.restartCountdown(NOW + 12_000, NOW)).toMatchObject({
      due: false,
      label: "restart in 12s",
    });
    expect(sup.restartCountdown(NOW - 1, NOW).label).toBe("restarting now");
  });
});

describe("bundle freshness — the exact/approximate distinction", () => {
  test("a hash-compared verdict says so", () => {
    const badge = sup.bundleBadge({
      present: true,
      freshness: {
        state: "stale",
        exact: true,
        label: "stale — the spec changed",
        compiledWith: "0.5.0",
      },
    });
    expect(badge.exact).toBe(true);
    expect(badge.dot).toBe("warn");
    expect(badge.precision).toContain("spec hash");
    expect(badge.compiledWith).toBe("0.5.0");
  });

  test("an mtime guess is never dressed up as a verdict", () => {
    const badge = sup.bundleBadge({
      present: true,
      freshness: { state: "approximate-fresh", exact: false, label: "probably current" },
    });
    expect(badge.exact).toBe(false);
    expect(badge.dot).toBe("unknown");
    expect(badge.precision).toContain("file times");
  });

  test("no bundle at all is an absence, not a stale verdict", () => {
    const badge = sup.bundleBadge({
      present: false,
      freshness: { state: "unknown", exact: false },
    });
    expect(badge.dot).toBe("off");
    expect(badge.label).toBe("no compiled bundle");
    // …and there is no verdict to qualify as exact or approximate.
    expect(badge.precision).toBe("nothing has been compiled here yet");
  });
});

describe("control availability + exit classification", () => {
  test("no control port reports the server's reason, not an error", () => {
    const control = sup.controlAvailability({
      port: null,
      available: false,
      reason: "no control port recorded — the daemon is not running",
    });
    expect(control.dot).toBe("off");
    expect(control.label).toBe("no control plane");
    expect(control.reason).toContain("not running");
  });

  test("an exit carries its class label and a next step", () => {
    const banner = sup.exitBanner({
      disposition: "terminal",
      failureClass: "billing",
      title: "provider account out of funding",
      exitCode: 31,
      restartable: false,
      unexpectedClean: false,
    });
    expect(banner.dot).toBe("bad");
    expect(banner.classLabel).toBe("provider funding");
    expect(banner.remediation).toContain("top it up");
  });

  test("with no live snapshot the ledger answers, and says it did", () => {
    const row = sup.procRow(
      {
        state: "stopped",
        recentRuns: [
          { runId: "run_2", kind: "daemon", startedAt: iso(-HOUR) },
          { runId: "run_1", kind: "daemon", exitCode: 31, failureClass: "billing" },
        ],
      },
      NOW,
    );
    expect(row.lastExit.fromLedger).toBe(true);
    expect(row.lastExit.disposition).toBe("terminal");
    expect(row.lastExit.classLabel).toBe("provider funding");
    // A live classification always wins over the ledger.
    expect(
      sup.procRow(
        { state: "crashed", lastExit: { disposition: "crash", title: "died" }, recentRuns: [] },
        NOW,
      ).lastExit.fromLedger,
    ).toBe(false);
    expect(sup.ledgerExit([{ runId: "r", exitCode: 0 }]).disposition).toBe("clean");
    expect(sup.ledgerExit([])).toBeNull();
  });

  test("a clean exit nobody asked for is a warning, not a success", () => {
    expect(sup.exitBanner({ disposition: "clean", unexpectedClean: true }).dot).toBe("warn");
    expect(sup.exitBanner({ disposition: "clean", unexpectedClean: false }).dot).toBe("off");
    expect(sup.exitBanner(null)).toBeNull();
  });
});

describe("procActions — every disabled control says why", () => {
  const plan = { mode: "compiled", cliTwin: "cd /h && bun dist/agent.ts", error: null };

  test("running: start refuses, stop/drain are live", () => {
    const actions = sup.procActions({ state: "running", launch: plan });
    expect(actions.start).toEqual({ enabled: false, reason: "already running" });
    expect(actions.stop.enabled).toBe(true);
    expect(actions.drain.enabled).toBe(true);
  });

  test("stopped: start is live, stop/drain refuse with the state", () => {
    const actions = sup.procActions({ state: "stopped", launch: plan });
    expect(actions.start.enabled).toBe(true);
    expect(actions.stop).toEqual({ enabled: false, reason: "nothing is running (stopped)" });
    expect(actions.drain.enabled).toBe(false);
  });

  test("a draining daemon refuses restart — it is going away", () => {
    const actions = sup.procActions({ state: "draining", draining: true, launch: plan });
    expect(actions.restart.enabled).toBe(false);
    expect(actions.restart.reason).toContain("draining");
    expect(actions.drain.reason).toBe("already draining");
  });

  test("an unbuildable plan disables start with the plan's own message", () => {
    const actions = sup.procActions({
      state: "stopped",
      launch: {
        mode: null,
        cliTwin: null,
        error: { message: "no compiled bundle", remedy: "compile" },
      },
    });
    expect(actions.start.enabled).toBe(false);
    expect(actions.start.reason).toBe("no compiled bundle");
  });

  test("procRow tolerates a null payload (a cold board row)", () => {
    const row = sup.procRow(null, NOW);
    expect(row.pill.state).toBe("unknown");
    expect(row.restartsInWindow).toBe(0);
    expect(row.lastExit).toBeNull();
    expect(row.launch.cliTwin).toBeNull();
  });
});

describe("procWriteOutcome — a refusal never reads as a stop", () => {
  test("a real stop says nothing; the board reload is the whole report", () => {
    const out = sup.procWriteOutcome(
      { ok: true, status: 200, body: { ok: true, stopped: true, forced: false } },
      "Stop",
    );
    expect(out.ok).toBe(true);
    expect(out.message).toBeNull();
  });

  test("a SIGTERM fallback is an honest degradation, not a failure", () => {
    const out = sup.procWriteOutcome(
      { ok: true, status: 200, body: { ok: true, stopped: true, viaSignal: true } },
      "Drain",
    );
    expect(out.ok).toBe(true);
    expect(out.tone).toBe("info");
    expect(out.message).toContain("SIGTERM");
  });

  test("a 409 not-adopted is reported as nothing-was-signalled", () => {
    // The supervisor held no pid while a live runfile existed: a daemon IS
    // running, this console just never adopted it. Rendered as success, an
    // operator walks away believing a live channel bot is down.
    const out = sup.procWriteOutcome(
      {
        ok: false,
        status: 409,
        body: { ok: false, reason: "not-adopted", message: "a daemon is running (pid 4242)" },
      },
      "Stop",
    );
    expect(out.ok).toBe(false);
    expect(out.notAdopted).toBe(true);
    expect(out.tone).toBe("error");
    expect(out.message).toContain("Stop did nothing");
    expect(out.message).toContain("pid 4242");
    // …and what to do next, which the server's sentence never carries.
    expect(out.message).toContain("adopts it off the runfile");
  });

  test("a 200 that admits `stopped: false` is not a stop either", () => {
    const out = sup.procWriteOutcome(
      { ok: true, status: 200, body: { ok: true, stopped: false, reason: "not-adopted" } },
      "Drain",
    );
    expect(out.ok).toBe(false);
    expect(out.notAdopted).toBe(true);
    expect(out.message).toContain("this console does not hold it");
  });

  test("an unrecognized refusal still says something, never silence", () => {
    const out = sup.procWriteOutcome({ ok: false, status: 500, body: null }, "Stop");
    expect(out.ok).toBe(false);
    expect(out.code).toBe("http-500");
    expect(out.message).toContain("Stop did nothing");
  });
});

describe("failureBoard — three red rows become one incident", () => {
  test("groups by failure class with a countable label", () => {
    const billing = {
      disposition: "terminal",
      failureClass: "billing",
      title: "provider account out of funding",
      exitCode: 31,
    };
    const groups = sup.failureBoard([
      { id: "a", name: "alpha", lastExit: billing },
      { id: "b", name: "beta", lastExit: billing },
      { id: "c", name: "gamma", lastExit: billing },
      {
        id: "d",
        name: "delta",
        lastExit: {
          disposition: "crash",
          failureClass: "tool",
          title: "tool crashed",
          exitCode: 1,
        },
      },
      {
        id: "e",
        name: "eps",
        lastExit: { disposition: "clean", title: "stopped by the operator" },
      },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe("3 harnesses exited 31 — provider funding");
    expect(groups[0].harnesses.map((h: { name: string }) => h.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(groups[1].label).toBe("1 harness exited 1 — tool");
  });

  test("an operator stop is not news; a daemon that 'finished' on its own is", () => {
    expect(
      sup.failureBoard([
        {
          id: "a",
          name: "alpha",
          lastExit: { disposition: "clean", title: "stopped by the operator" },
        },
      ]),
    ).toEqual([]);
    const surprise = sup.failureBoard([
      {
        id: "b",
        name: "beta",
        lastExit: {
          disposition: "clean",
          title: "exited cleanly (unexpected)",
          exitCode: 0,
          unexpectedClean: true,
        },
      },
    ]);
    expect(surprise).toHaveLength(1);
    expect(surprise[0].label).toBe("1 harness exited 0 — exited cleanly (unexpected)");
  });

  test("nothing failing yields no groups", () => {
    expect(sup.failureBoard([{ id: "a", lastExit: null }])).toEqual([]);
    expect(sup.failureBoard(null)).toEqual([]);
  });
});

describe("refusalModel — Start anyway is hidden, not merely disabled", () => {
  const forceable = {
    id: "env.MISSING_KEY",
    area: "env",
    level: "blocking",
    message: "MISSING_KEY is not set",
    remediation: "add it to .env",
    acknowledgeable: true,
  };
  const unforceable = {
    id: "channel.slack.secret",
    area: "channel",
    level: "blocking",
    message: "SLACK_BOT_TOKEN is not set",
    remediation: "add the channel secret",
    acknowledgeable: false,
  };

  test("all-acknowledgeable ⇒ forceable, and the ack list names every id", () => {
    const model = sup.refusalModel({
      ok: false,
      reason: "preflight-blocked",
      refused: [forceable],
      unforceable: [],
    });
    expect(model.kind).toBe("preflight");
    expect(model.canForce).toBe(true);
    expect(model.acknowledge).toEqual(["env.MISSING_KEY"]);
    expect(model.forceHint).toContain("acknowledges every finding");
  });

  test("one unforceable finding removes the force affordance entirely", () => {
    const model = sup.refusalModel({
      ok: false,
      reason: "preflight-blocked",
      refused: [forceable, unforceable],
      unforceable: ["channel.slack.secret"],
    });
    expect(model.canForce).toBe(false);
    expect(model.forceHint).toContain("exits 2");
    expect(
      model.items.filter((i: { acknowledgeable: boolean }) => !i.acknowledgeable),
    ).toHaveLength(1);
  });

  test("plan-failed carries its remedy as a button model", () => {
    const model = sup.refusalModel({
      ok: false,
      reason: "plan-failed",
      message: "no compiled bundle for channel",
      remedy: "compile",
    });
    expect(model.kind).toBe("plan-failed");
    expect(model.action).toMatchObject({ label: "Compile now", jobKind: "compile" });
    expect(model.canForce).toBe(false);
  });

  test("a remedy with no runnable job is a hint, not a button", () => {
    expect(sup.remedyAction("add-spec").jobKind).toBeNull();
    expect(sup.remedyAction("install-cli").jobKind).toBeNull();
    expect(sup.remedyAction("nonsense")).toBeNull();
  });

  test("already-running and unknown refusals still render", () => {
    expect(sup.refusalModel({ reason: "already-running" }).kind).toBe("already-running");
    expect(sup.refusalModel({ reason: "who-knows", message: "x" }).kind).toBe("error");
    expect(sup.refusalModel(null).kind).toBe("error");
  });
});

describe("controlOutcome — expected refusals disable, they never error", () => {
  const cases: Array<[string, boolean, boolean, string, boolean]> = [
    // code, expected, retryable, tone, disabled
    ["no_control_port", true, false, "expected", true],
    ["lane_not_armed", true, false, "expected", true],
    ["draining", true, false, "expected", true],
    ["tick_in_flight", false, true, "retry", false],
    ["unauthorized", false, false, "error", false],
    ["unreachable", false, false, "error", false],
    ["error", false, false, "error", false],
  ];

  for (const [code, expected, retryable, tone, disabled] of cases) {
    test(`${code} ⇒ tone ${tone}, disabled ${disabled}`, () => {
      const outcome = sup.controlOutcome({
        ok: false,
        code,
        reason: `${code} happened`,
        expected,
        retryable,
        upstreamStatus: 409,
      });
      expect(outcome.tone).toBe(tone);
      expect(outcome.disabled).toBe(disabled);
      expect(outcome.retryable).toBe(retryable);
      // A refusal always renders its sentence — never a bare code.
      expect(outcome.reason).toBe(`${code} happened`);
    });
  }

  test("only tick_in_flight is retryable of the two 409s", () => {
    expect(
      sup.controlOutcome({ ok: false, code: "tick_in_flight", retryable: true }).retryable,
    ).toBe(true);
    expect(sup.controlOutcome({ ok: false, code: "draining", expected: true }).retryable).toBe(
      false,
    );
  });

  test("a success is a success", () => {
    const outcome = sup.controlOutcome({ ok: true, upstreamStatus: 202, sessionId: "sess_1" });
    expect(outcome.ok).toBe(true);
    expect(outcome.disabled).toBe(false);
  });
});

describe("laneModel — cadence is offline, phase is not", () => {
  const view = {
    lanes: [],
    controlReachable: false,
    controlReason: "no control port recorded — recompile with 0.5.0 to enable phase",
    draining: false,
  };

  test("no control plane ⇒ 'cadence only' plus the honest reason", () => {
    const lane = sup.laneModel(
      {
        lane: "heartbeat",
        armed: true,
        cadence: "every 60s",
        cadenceSource: "spec",
        lastFiredAt: null,
        lastOutcome: null,
        nextDueAt: null,
        pokeable: false,
        pokeReason: "the daemon's control plane is not reachable",
      },
      view,
      NOW,
    );
    expect(lane.nextDueLabel).toBe("cadence only");
    expect(lane.phaseNote).toContain("recompile with 0.5.0");
    expect(lane.label).toBe("declared — phase unknown");
    expect(lane.dot).toBe("unknown");
    expect(lane.pokeable).toBe(false);
  });

  test("control answered ⇒ the phase columns are real", () => {
    const lane = sup.laneModel(
      {
        lane: "schedule",
        armed: true,
        cadence: 'cron "0 */6 * * *" UTC',
        cadenceSource: "spec",
        lastFiredAt: iso(-2 * HOUR),
        lastOutcome: "ok",
        nextDueAt: iso(4 * HOUR),
        pokeable: true,
        pokeReason: null,
      },
      { ...view, controlReachable: true, controlReason: null },
      NOW,
    );
    expect(lane.nextDueLabel).toBe("in 4h");
    expect(lane.phaseNote).toBeNull();
    expect(lane.lastFiredLabel).toBe("2h ago");
    expect(lane.dot).toBe("ok");
  });

  test("an undeclared lane is absent, not broken", () => {
    const lane = sup.laneModel({ lane: "dream", armed: false, pokeable: false }, view, NOW);
    expect(lane.dot).toBe("off");
    expect(lane.label).toBe("not declared");
  });

  test("laneModels keeps the server's four-lane order", () => {
    const lanes = sup.laneModels(
      {
        lanes: [
          { lane: "heartbeat", armed: true },
          { lane: "schedule", armed: false },
          { lane: "dream", armed: true },
          { lane: "janitor", armed: true },
        ],
        controlReachable: true,
      },
      NOW,
    );
    expect(lanes.map((l: { lane: string }) => l.lane)).toEqual([
      "heartbeat",
      "schedule",
      "dream",
      "janitor",
    ]);
    expect(sup.POKEABLE_LANES).toEqual(["heartbeat", "schedule"]);
  });
});

describe("SSE parsing + the run feed", () => {
  test("frames split across chunks reassemble", () => {
    const parser = sup.createSseParser();
    expect(parser.push('event: state\ndata: {"snapsh')).toEqual([]);
    const frames = parser.push(
      'ot":{"state":"running"}}\n\nevent: done\ndata: {"reason":"exit"}\n\n',
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: "state", data: { snapshot: { state: "running" } } });
    expect(frames[1]).toEqual({ event: "done", data: { reason: "exit" } });
    expect(parser.rest()).toBe("");
  });

  test("a keep-alive comment carries no data and yields no frame", () => {
    expect(sup.createSseParser().push(": keep-alive\n\n")).toEqual([]);
  });

  test("a torn JSON payload is skipped, never fatal", () => {
    const frames = sup.createSseParser().push("event: output\ndata: {not json\n\n");
    expect(frames).toEqual([{ event: "output", data: null }]);
  });

  test("replay opens the feed with history and the log tail", () => {
    const items = sup.sseFrameToFeed("replay", {
      runId: "run_1",
      live: false,
      events: [
        { kind: "turn_start", turn: 1, timestamp: iso(-HOUR) },
        { kind: "tool_call_end", toolName: "search", isError: false, durationMs: 1200 },
      ],
      eventsTruncated: false,
      proseTail: ["booting", "", "listening"],
    });
    expect(items[0]).toMatchObject({ type: "marker", title: "replayed 2 recorded events" });
    expect(items[1]).toMatchObject({ type: "event", kind: "turn_start" });
    expect(items[3]).toEqual({ type: "prose", lines: ["booting", "listening"] });
  });

  test("a replayed CLOSED run still gets its exit banner (the exit frame is live-only)", () => {
    const items = sup.sseFrameToFeed("replay", {
      runId: "run_1",
      entry: { runId: "run_1", exitCode: 31, failureClass: "billing", endedAt: iso(-HOUR) },
      live: false,
      events: [],
      proseTail: [],
    });
    const exit = items.find((i: { type: string }) => i.type === "exit");
    expect(exit.banner.classLabel).toBe("provider funding");
    expect(exit.banner.fromLedger).toBe(true);
    // A still-running replay has nothing to close with.
    expect(
      sup
        .sseFrameToFeed("replay", { entry: { runId: "run_1" }, events: [], proseTail: [] })
        .find((i: { type: string }) => i.type === "exit"),
    ).toBeUndefined();
  });

  test("output, state, exit and done each become their own item", () => {
    expect(sup.sseFrameToFeed("output", { prose: "hello\n", events: [] })).toEqual([
      { type: "prose", lines: ["hello"] },
    ]);
    expect(sup.sseFrameToFeed("state", { snapshot: { state: "draining" } })[0]).toMatchObject({
      type: "state",
      dot: "warn",
    });
    const exit = sup.sseFrameToFeed("exit", {
      classification: {
        disposition: "crash",
        failureClass: "tool",
        title: "tool crashed",
        exitCode: 1,
      },
    })[0];
    expect(exit.type).toBe("exit");
    expect(exit.banner.classLabel).toBe("tool");
    expect(sup.sseFrameToFeed("done", { reason: "closed" })[0]).toMatchObject({ type: "done" });
    expect(sup.sseFrameToFeed("nonsense", {})).toEqual([]);
  });

  test("an unknown trace kind still renders (tolerant reader)", () => {
    const card = sup.traceCard({ kind: "brand_new_kind", payload: { a: 1 } });
    expect(card.title).toBe("brand_new_kind");
    expect(card.type).toBe("event");
  });

  test("a failed tool call and run_failed carry bad dots", () => {
    expect(sup.traceCard({ kind: "tool_call_end", toolName: "x", isError: true }).dot).toBe("bad");
    expect(
      sup.traceCard({ kind: "run_failed", class: "billing", message: "no funds" }),
    ).toMatchObject({ dot: "bad", title: "run failed — billing" });
  });

  test("the HUD folds turns, tools, tokens and cost out of the feed", () => {
    const items = [
      ...sup.sseFrameToFeed("replay", {
        events: [
          { kind: "turn_start", turn: 1 },
          { kind: "tool_call_end", toolName: "a", isError: false },
          { kind: "tool_call_end", toolName: "b", isError: true },
          { kind: "cost_accrual", costUsdMicros: 1_500_000, inputTokens: 10, outputTokens: 5 },
        ],
        proseTail: [],
      }),
      ...sup.sseFrameToFeed("done", { reason: "closed" }),
    ];
    const hud = sup.runHud(items);
    expect(hud).toMatchObject({
      turns: 1,
      tools: 2,
      toolErrors: 1,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(hud.costUsd).toBeCloseTo(1.5, 6);
  });

  test("run ledger rows read open vs closed honestly", () => {
    const open = sup.runLedgerRow(
      { runId: "run_1", kind: "daemon", startedAt: iso(-30 * MINUTE), logFile: "logs/run_1.log" },
      NOW,
    );
    expect(open.open).toBe(true);
    expect(open.exitLabel).toBe("still running");
    expect(open.duration).toBe("30m 0s");
    const closed = sup.runLedgerRow(
      {
        runId: "run_2",
        kind: "job",
        startedAt: iso(-2 * MINUTE),
        endedAt: iso(-MINUTE),
        exitCode: 31,
        failureClass: "billing",
      },
      NOW,
    );
    expect(closed.dot).toBe("bad");
    expect(closed.exitLabel).toBe("exit 31 — provider funding");
  });
});

describe("triage keyboard reducer", () => {
  const start = { index: 0, count: 3, menuOpen: false, helpOpen: false };

  test("j and k move and clamp at both ends", () => {
    let state = start;
    ({ state } = sup.triageKey(state, "j"));
    expect(state.index).toBe(1);
    ({ state } = sup.triageKey(state, "j"));
    ({ state } = sup.triageKey(state, "j"));
    expect(state.index).toBe(2); // clamped at count - 1
    ({ state } = sup.triageKey(state, "k"));
    expect(state.index).toBe(1);
    // …and at the top, where k on row 0 stays on row 0.
    expect(sup.triageKey({ ...start, index: 0 }, "k").state.index).toBe(0);
  });

  test("arrow keys are aliases for j/k", () => {
    expect(sup.triageKey(start, "ArrowDown").state.index).toBe(1);
    expect(sup.triageKey({ ...start, index: 2 }, "ArrowUp").state.index).toBe(1);
  });

  test("g and d emit grant/deny effects for the selected row", () => {
    const moved = sup.triageKey(start, "j").state;
    expect(sup.triageKey(moved, "g").effect).toEqual({ action: "grant", index: 1 });
    expect(sup.triageKey(moved, "d").effect).toEqual({ action: "deny", index: 1 });
  });

  test("the review map rebinds the same reducer to its own verdicts", () => {
    const keyed = (key: string) => sup.triageKey(start, key, sup.REVIEW_KEYS).effect;
    expect(keyed("u")).toEqual({ action: "up", index: 0 });
    expect(keyed("d")).toEqual({ action: "down", index: 0 });
    expect(keyed("p")).toEqual({ action: "pass", index: 0 });
    expect(keyed("f")).toEqual({ action: "fail", index: 0 });
    expect(keyed("g")).toBeNull(); // grant is not a review verdict
  });

  test(". toggles the row menu, ? the bindings, Escape closes both", () => {
    let state = sup.triageKey(start, ".").state;
    expect(state.menuOpen).toBe(true);
    state = sup.triageKey(state, "?").state;
    expect(state.helpOpen).toBe(true);
    state = sup.triageKey(state, "Escape").state;
    expect(state).toMatchObject({ menuOpen: false, helpOpen: false });
  });

  test("moving closes an open row menu", () => {
    const open = sup.triageKey(start, ".").state;
    expect(sup.triageKey(open, "j").state.menuOpen).toBe(false);
  });

  test("an empty inbox emits no effect and never leaves index 0", () => {
    const empty = { index: 0, count: 0, menuOpen: false, helpOpen: false };
    expect(sup.triageKey(empty, "g").effect).toBeNull();
    expect(sup.triageKey(empty, "j").state.index).toBe(0);
  });

  test("unbound keys fall through to the browser", () => {
    expect(sup.triageKey(start, "f").effect).toBeNull();
    expect(sup.isTriageKey("f")).toBe(false);
    expect(sup.isTriageKey("f", sup.REVIEW_KEYS)).toBe(true);
    for (const key of ["j", "k", "ArrowUp", "ArrowDown", ".", "?", "Escape", "g", "d"]) {
      expect(`${key}:${sup.isTriageKey(key)}`).toBe(`${key}:true`);
    }
  });

  test("the help sheet lists movement, the actions, and the meta keys", () => {
    const help = sup.keyHelp(sup.APPROVAL_KEYS).map((b: { key: string }) => b.key);
    expect(help).toContain("j / ↓");
    expect(help).toContain("g");
    expect(help).toContain("?");
  });
});

describe("inbox rows", () => {
  test("an approval keeps its verbatim input and names the resume", () => {
    const row = sup.approvalRow(
      {
        id: "appr_1",
        harnessId: "hrn_1",
        specName: "ops",
        toolName: "SendMessage",
        input: { channel: "ops", text: "ship it" },
        inputHash: "h1",
        surface: "daemon",
        createdAt: iso(-3 * HOUR),
        status: "pending",
        decidedBy: null,
        parkedRun: { harnessId: "hrn_1", runId: "run_1", sessionId: "sess_1" },
      },
      NOW,
    );
    expect(row.input).toEqual({ channel: "ops", text: "ship it" });
    expect(row.pending).toBe(true);
    expect(row.dot).toBe("warn");
    expect(row.age).toBe("3h ago");
    expect(row.resumeNote).toContain("resumes the parked run");
  });

  test("a settled approval is not pending", () => {
    expect(sup.approvalRow({ status: "granted" }, NOW).pending).toBe(false);
    expect(sup.approvalRow({ status: "denied" }, NOW).dot).toBe("bad");
  });

  test("thumbs are offered only where they can land", () => {
    const adjudicable = sup.reviewRow(
      {
        id: "rev_1",
        kind: "rater_disagreement",
        status: "open",
        ts: iso(-HOUR),
        sourceRef: { sessionId: "sess_1", turn: 3 },
        adjudicable: true,
      },
      NOW,
    );
    expect(adjudicable.verdicts).toEqual(["up", "down", "pass", "fail"]);
    expect(adjudicable.sessionId).toBe("sess_1");
    const itemOnly = sup.reviewRow(
      { id: "rev_2", kind: "quarantine", status: "open", sourceRef: { dataset: "smoke" } },
      NOW,
    );
    expect(itemOnly.verdicts).toEqual(["pass", "fail"]);
    expect(itemOnly.verdictNote).toContain("no session turn");
  });
});

describe("activity digest", () => {
  const items = [
    {
      kind: "run",
      harnessId: "hrn_1",
      specName: "ops",
      at: iso(-HOUR),
      label: "daemon run ended",
      ref: "run_1",
    },
    {
      kind: "session",
      harnessId: "hrn_1",
      specName: "ops",
      at: iso(-2 * HOUR),
      label: "session activity",
      ref: "sess_1",
    },
    {
      kind: "wiki",
      harnessId: "hrn_1",
      specName: "ops",
      at: iso(-3 * HOUR),
      label: "wiki article x",
      ref: "x",
    },
  ];

  test("groups render in display order with their counts", () => {
    const groups = sup.activityGroups(items, null);
    expect(groups.map((g: { kind: string }) => g.kind)).toEqual(["run", "session", "wiki"]);
    expect(groups.every((g: { shown: boolean }) => g.shown)).toBe(true);
  });

  test("a filtered-out kind keeps its count so nothing hides silently", () => {
    const groups = sup.activityGroups(items, new Set(["run"]));
    const wiki = groups.find((g: { kind: string }) => g.kind === "wiki");
    expect(wiki.shown).toBe(false);
    expect(wiki.count).toBe(1);
  });

  test("every kind deep-links into the screen that owns it", () => {
    expect(sup.activityHref(items[0])).toBe("#/h/hrn_1/runs/run_1");
    expect(sup.activityHref(items[1])).toBe("#/h/hrn_1/sessions/sess_1");
    expect(sup.activityHref(items[2])).toBe("#/h/hrn_1/memory/wiki/x");
    expect(sup.activityHref({ kind: "eval", harnessId: "h", ref: "run_9" })).toBe(
      "#/h/h/evals/run_9",
    );
    expect(sup.activityHref({ kind: "spec", harnessId: "h" })).toBe("#/h/h/spec");
    expect(sup.activityHref({ kind: "deploy", harnessId: "h" })).toBe("#/h/h/deploy");
    expect(sup.activityHref({ kind: "approval", harnessId: "h" })).toBe("#/approvals");
    expect(sup.activityHref({ kind: "run" })).toBeNull();
  });
});

describe("jobs + deployments", () => {
  test("the queue splits running, pending and interrupted", () => {
    const model = sup.jobQueueModel({
      running: [
        { jobId: "job_1", state: "running", kind: "eval" },
        { jobId: "job_2", state: "interrupted", kind: "compile" },
      ],
      pending: [{ jobId: "job_3", state: "pending", kind: "doctor" }],
    });
    expect(model.running).toHaveLength(1);
    expect(model.pending).toHaveLength(1);
    expect(model.interrupted).toHaveLength(1);
    expect(model.total).toBe(3);
    expect(sup.jobQueueModel(null).total).toBe(0);
  });

  test("an interrupted job is folded out of `recent` — the only list it can reach us in", () => {
    // The shape the SERVER actually emits after a manager dies mid-compile:
    // `restore()` closes the job in the ledger rather than returning it to
    // the queue, so `pending`/`running` are empty and `recent` carries it.
    const model = sup.jobQueueModel({
      pending: [],
      running: [],
      recent: [
        { jobId: "job_9", state: "interrupted", kind: "compile", mutating: true },
        { jobId: "job_8", state: "done", kind: "doctor" },
      ],
    });
    expect(model.interrupted.map((j: { jobId: string }) => j.jobId)).toEqual(["job_9"]);
    // Non-zero total is what keeps the panel off "No jobs queued" — the
    // abandoned mutating compile is the one fact the group exists to report.
    expect(model.total).toBe(1);
  });

  test("a job listed twice across the restore is counted once", () => {
    const job = { jobId: "job_9", state: "interrupted", kind: "eval" };
    const model = sup.jobQueueModel({ running: [job], pending: [], recent: [{ ...job }] });
    expect(model.interrupted).toHaveLength(1);
    expect(model.total).toBe(1);
  });

  test("a job row carries its argv and state dot", () => {
    const row = sup.jobRow(
      {
        jobId: "job_1",
        kind: "compile",
        harnessDir: "/h",
        argv: ["compile", "crewhaus.yaml", "-o", "dist"],
        state: "running",
        mutating: true,
        enqueuedAt: iso(-MINUTE),
      },
      NOW,
    );
    expect(row.dot).toBe("ok");
    expect(row.argv.join(" ")).toBe("compile crewhaus.yaml -o dist");
    expect(row.mutating).toBe(true);
  });

  test("deployment class is inferred from the provider", () => {
    expect(sup.deploymentRow({ provider: "fly", env: "prod", health: "ok" }, NOW).klass).toBe(
      "PaaS",
    );
    expect(sup.deploymentRow({ provider: "cloudflare" }, NOW).klass).toBe("cf-worker");
    expect(sup.deploymentRow({ provider: "docker-compose" }, NOW).klass).toBe("local");
    expect(sup.deploymentRow({}, NOW).klass).toBe("unknown");
  });

  test("unrecorded health is unknown, never a green light", () => {
    expect(sup.deploymentRow({ provider: "fly" }, NOW).dot).toBe("unknown");
    expect(sup.deploymentRow({ provider: "fly", health: "ok" }, NOW).dot).toBe("ok");
    expect(sup.deploymentRow({ provider: "fly", health: "degraded" }, NOW).dot).toBe("bad");
  });
});

describe("CLI twins", () => {
  test("every process verb has the daemon command an operator can paste", () => {
    const dir = "/harnesses/ops";
    expect(sup.cliTwinFor("start", { dir })).toBe("cd /harnesses/ops && crewhaus daemon start");
    expect(sup.cliTwinFor("stop", { dir })).toBe("cd /harnesses/ops && crewhaus daemon stop");
    expect(sup.cliTwinFor("restart", { dir })).toBe("cd /harnesses/ops && crewhaus daemon restart");
    expect(sup.cliTwinFor("drain", { dir })).toBe("cd /harnesses/ops && crewhaus daemon drain");
    expect(sup.cliTwinFor("wake", { dir, lane: "heartbeat" })).toBe(
      "cd /harnesses/ops && crewhaus daemon wake --lane heartbeat",
    );
  });

  test("a forced start names --force and the acknowledged ids", () => {
    expect(sup.cliTwinFor("start", { dir: "/h", force: true, acknowledge: ["a", "b"] })).toBe(
      "cd /h && crewhaus daemon start --force --ack a,b",
    );
  });

  test("paths with spaces are quoted exactly as the supervisor's twin does", () => {
    expect(sup.cliTwinFor("stop", { dir: "/my harnesses/ops" })).toBe(
      'cd "/my harnesses/ops" && crewhaus daemon stop',
    );
  });

  test("inbox and eval verbs match the CLI's real subcommands", () => {
    expect(sup.cliTwinFor("grant", { id: "appr_1" })).toBe("crewhaus approvals grant appr_1");
    expect(sup.cliTwinFor("deny", { id: "appr_1" })).toBe("crewhaus approvals deny appr_1");
    expect(sup.cliTwinFor("review", { id: "rev_1" })).toBe("crewhaus review resolve rev_1");
    expect(sup.cliTwinFor("adjudicate", { sessionId: "sess_1", turn: 3, verdict: "up" })).toBe(
      "crewhaus rate --session sess_1 --turn 3 --thumbs up --adjudicate",
    );
    expect(sup.cliTwinFor("baseline", { runId: "run_1" })).toBe(
      "crewhaus eval-report baseline set run_1",
    );
  });

  test("job twins mirror the server's own jobArgv vocabulary", () => {
    expect(sup.JOB_COMMANDS).toEqual({
      doctor: "crewhaus doctor",
      compile: "crewhaus compile crewhaus.yaml -o dist",
      eval: "crewhaus eval crewhaus.yaml",
      "dream-run": "crewhaus dream run crewhaus.yaml",
    });
    expect(sup.cliTwinFor("job", { dir: "/h", kind: "eval" })).toBe(
      "cd /h && crewhaus eval crewhaus.yaml",
    );
    expect(sup.cliTwinFor("job", { kind: "nope" })).toBeNull();
  });

  test("an action with no CLI verb says so instead of inventing one", () => {
    expect(sup.cliTwinFor("pin-session", { dir: "/h" })).toBeNull();
    expect(sup.NO_TWIN_NOTES["pin-session"]).toContain("retention.json");
  });
});
