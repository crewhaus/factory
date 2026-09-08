import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScoreboard, readRouteFreeze, routeFreezePath } from "@crewhaus/routing-store";
import {
  formatRouteExplain,
  formatRouteFreeze,
  formatRouteStatus,
  loadArms,
  loadRouteFreeze,
  parseRouteArgs,
  readRouteDecisions,
  readRouteTimeline,
  resetRouting,
  routeExplainJson,
  routeStatusJson,
  runRoute,
} from "./route";

const TMP: string[] = [];
function seededRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-cli-"));
  TMP.push(dir);
  const sb = openScoreboard(dir, { now: () => 1_700_000_000_000 });
  sb.record("hard", "claude-opus-4-8", 0.82, { success: true, latencyMs: 1800, costUsd: 0.04 });
  sb.record("hard", "claude-haiku-4-5", 0.4, { success: true, latencyMs: 400, costUsd: 0.002 });
  sb.record("easy", "claude-haiku-4-5", 0.91, { success: true, latencyMs: 350, costUsd: 0.002 });
  return dir;
}
afterAll(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

describe("route — arg parsing", () => {
  test("parses subcommand and --dir", () => {
    expect(parseRouteArgs(["status"])).toEqual({ sub: "status", dir: ".crewhaus" });
    expect(parseRouteArgs(["reset", "--dir", "/tmp/x"])).toEqual({ sub: "reset", dir: "/tmp/x" });
    expect(parseRouteArgs(["--dir", "/tmp/x", "status"])).toEqual({ sub: "status", dir: "/tmp/x" });
  });
  test("rejects a missing subcommand, unknown args, and a dangling --dir", () => {
    expect(() => parseRouteArgs([])).toThrow(/subcommand/);
    expect(() => parseRouteArgs(["bogus"])).toThrow(/unknown argument/); // not a subcommand
    expect(() => parseRouteArgs(["--bogus"])).toThrow(/unknown argument/); // unknown flag
    expect(() => parseRouteArgs(["status", "extra"])).toThrow(/unknown argument/); // status takes no positional
    expect(() => parseRouteArgs(["status", "--dir"])).toThrow(/requires a path/);
  });

  test("a subcommand keyword after `explain` is a session id, not a re-dispatch", () => {
    // `route explain status` explains a session literally named "status" —
    // it must NOT silently run `route status`.
    expect(parseRouteArgs(["explain", "status"])).toEqual({
      sub: "explain",
      dir: ".crewhaus",
      session: "status",
    });
    // `route status explain` — status takes no positional → error, not a swap.
    expect(() => parseRouteArgs(["status", "explain"])).toThrow(/unknown argument/);
  });
});

describe("route status", () => {
  test("renders arms grouped by bucket, best-reward-first and starred", () => {
    const out = formatRouteStatus(loadArms(seededRoot()));
    expect(out).toContain("routeKey");
    // In the hard bucket, opus (0.82) outranks haiku (0.40) → opus starred.
    const hardOpus = out
      .split("\n")
      .find((l) => l.includes("hard") && l.includes("claude-opus-4-8"));
    expect(hardOpus).toContain("*");
    const hardHaiku = out
      .split("\n")
      .find((l) => l.includes("hard") && l.includes("claude-haiku-4-5"));
    expect(hardHaiku).not.toContain("*");
    expect(out).toContain("0.820");
  });

  test("empty scoreboard prints a helpful hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-empty-"));
    TMP.push(dir);
    expect(formatRouteStatus(loadArms(dir))).toContain("No routing data yet");
  });

  test("runRoute('status') returns the formatted table", () => {
    const out = runRoute(["status", "--dir", seededRoot()]);
    expect(out).toContain("claude-opus-4-8");
    expect(out).toContain("easy");
  });
});

describe("route reset", () => {
  test("wipes the scoreboard and reports the removed arm count", () => {
    const dir = seededRoot();
    expect(loadArms(dir).length).toBe(3);
    const msg = runRoute(["reset", "--dir", dir]);
    expect(msg).toContain("3 arms removed");
    expect(existsSync(join(dir, "routing", "arms.jsonl"))).toBe(false);
    expect(loadArms(dir).length).toBe(0);
  });

  test("resetRouting on an empty store removes nothing and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-reset-empty-"));
    TMP.push(dir);
    expect(resetRouting(dir)).toBe(0);
  });
});

/** Write a session JSONL with the given model_route + noise events. */
function sessionWith(dir: string, sessionId: string, lines: object[]): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "sessions", `${sessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

describe("route explain — arg parsing", () => {
  test("requires a session id", () => {
    expect(() => parseRouteArgs(["explain"])).toThrow(/session.*required/i);
    expect(parseRouteArgs(["explain", "sess_1"])).toEqual({
      sub: "explain",
      dir: ".crewhaus",
      session: "sess_1",
    });
    expect(parseRouteArgs(["explain", "sess_1", "--dir", "/tmp/x"])).toEqual({
      sub: "explain",
      dir: "/tmp/x",
      session: "sess_1",
    });
    expect(parseRouteArgs(["--dir", "/tmp/x", "explain", "sess_1"])).toEqual({
      sub: "explain",
      dir: "/tmp/x",
      session: "sess_1",
    });
  });
});

describe("route explain", () => {
  test("reads model_route events in turn order, skipping noise + malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-explain-"));
    TMP.push(dir);
    sessionWith(dir, "sess_abc", [
      { ts: 1, version: 1, kind: "user_message", payload: { content: "hi" } },
      {
        ts: 2,
        version: 1,
        kind: "model_route",
        payload: {
          turnNumber: 1,
          routeKey: "hard",
          model: "claude-opus-4-8",
          policy: "learned",
          reason: "first turn",
          explored: false,
        },
      },
      { ts: 3, version: 1, kind: "model_meta", payload: { stopReason: "end_turn", model: "x" } },
      {
        ts: 4,
        version: 1,
        kind: "model_route",
        payload: {
          turnNumber: 2,
          routeKey: "easy",
          model: "claude-haiku-4-5",
          policy: "learned",
          reason: "ε-greedy explore",
          explored: true,
        },
      },
    ]);
    const decisions = readRouteDecisions(dir, "sess_abc");
    expect(decisions.map((d) => d.turnNumber)).toEqual([1, 2]);
    expect(decisions[1]).toMatchObject({
      routeKey: "easy",
      model: "claude-haiku-4-5",
      explored: true,
    });

    const out = runRoute(["explain", "sess_abc", "--dir", dir]);
    expect(out).toContain("2 routing decision(s)");
    expect(out).toContain("claude-opus-4-8");
    expect(out).toContain("explore"); // the ε-greedy turn's pick column
    expect(out).toContain("exploit"); // the first-turn exploit
  });

  test("a missing session log yields a helpful empty message, not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-explain-empty-"));
    TMP.push(dir);
    expect(readRouteDecisions(dir, "sess_nope")).toEqual([]);
    expect(runRoute(["explain", "sess_nope", "--dir", dir])).toContain("No model_route decisions");
  });

  test("rejects a path-traversal session id (no reading outside the sessions dir)", () => {
    expect(() => readRouteDecisions(".crewhaus", "../../../../etc/passwd")).toThrow(
      /invalid session/,
    );
    expect(() => readRouteDecisions(".crewhaus", "a/b")).toThrow(/invalid session/);
    expect(() => readRouteDecisions(".crewhaus", "")).toThrow(/invalid session/);
  });
});

describe("route freeze — the learned policy's kill switch (0.6.0 §6.3 / §10.1)", () => {
  test("arg parsing: a policyVersion positional, --reason, --clear; never both, never neither", () => {
    expect(parseRouteArgs(["freeze", "pool-abc"])).toEqual({
      sub: "freeze",
      dir: ".crewhaus",
      policyVersion: "pool-abc",
    });
    expect(
      parseRouteArgs(["freeze", "pool-abc", "--reason", "incident 42", "--dir", "/tmp/x"]),
    ).toEqual({ sub: "freeze", dir: "/tmp/x", policyVersion: "pool-abc", reason: "incident 42" });
    expect(parseRouteArgs(["freeze", "--clear"])).toEqual({
      sub: "freeze",
      dir: ".crewhaus",
      clear: true,
    });
    expect(() => parseRouteArgs(["freeze"])).toThrow(/policyVersion.*required/);
    expect(() => parseRouteArgs(["freeze", "pool-abc", "--clear"])).toThrow(/not both/);
    expect(() => parseRouteArgs(["freeze", "pool-abc", "--reason"])).toThrow(/requires a text/);
    expect(() => parseRouteArgs(["freeze", "a", "b"])).toThrow(/unknown argument/);
    // `status` still takes no positional, `--clear` is freeze-only.
    expect(() => parseRouteArgs(["status", "--clear"])).toThrow(/unknown argument/);
  });

  test("freeze writes the marker the runtime reads, status shows it, --clear lifts it", () => {
    const dir = seededRoot();
    const msg = runRoute(["freeze", "pool-1234", "--reason", "roster audit", "--dir", dir]);
    expect(msg).toContain("Froze routing at policyVersion pool-1234");
    expect(msg).toContain(routeFreezePath(dir));
    expect(readRouteFreeze(dir)).toMatchObject({
      version: 1,
      policyVersion: "pool-1234",
      reason: "roster audit",
    });
    expect(loadRouteFreeze(dir)?.policyVersion).toBe("pool-1234");

    const status = runRoute(["status", "--dir", dir]);
    expect(status.split("\n")[0]).toContain("FROZEN at policyVersion pool-1234");
    expect(status).toContain("roster audit");
    expect(status).toContain("claude-opus-4-8"); // the table still renders below the banner

    expect(runRoute(["freeze", "--clear", "--dir", dir])).toContain("Lifted the routing freeze");
    expect(readRouteFreeze(dir)).toBeUndefined();
    expect(runRoute(["freeze", "--clear", "--dir", dir])).toContain("nothing to lift");
    expect(runRoute(["status", "--dir", dir])).not.toContain("FROZEN");
  });

  test("route reset removes the freeze marker along with the arms", () => {
    const dir = seededRoot();
    runRoute(["freeze", "pool-1234", "--dir", dir]);
    expect(existsSync(routeFreezePath(dir))).toBe(true);
    runRoute(["reset", "--dir", dir]);
    expect(existsSync(routeFreezePath(dir))).toBe(false);
    expect(loadArms(dir)).toEqual([]);
  });

  test("formatRouteFreeze renders nothing when unfrozen", () => {
    expect(formatRouteFreeze(undefined)).toBe("");
    expect(
      formatRouteFreeze({
        version: 1,
        policyVersion: "pool-9",
        frozenAt: "2026-09-05T00:00:00.000Z",
      }),
    ).toContain("since 2026-09-05T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §8.2 — the v2 surfaces: `explain --json` (the whole timeline),
// `status --by profile|scope` and `status --shadow`.
// ---------------------------------------------------------------------------

/** A session log carrying one routed turn plus its directive and stage lines. */
function seededSession(): { dir: string; session: string } {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-timeline-"));
  TMP.push(dir);
  const sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  const lines = [
    {
      kind: "model_directive",
      payload: {
        turnNumber: 1,
        source: "repl",
        requested: "strong",
        resolved: "strong",
        accepted: true,
      },
    },
    {
      kind: "model_route",
      payload: {
        turnNumber: 1,
        routeKey: "hard",
        model: "claude-opus-5-20260101",
        specModel: "claude-opus-5",
        profile: "strong",
        policy: "directive",
        reason: "user directive",
        explored: false,
        policyVersion: "pf_abc",
        scope: "step-a",
        toolsetFingerprint: "ts_1",
        ruleId: "code-goes-strong",
        classifierVerdict: "strong",
        eligible: ["fast", "strong"],
        hint: { source: "directive", forcedArm: "strong" },
        signals: { contextTokens: 1200, toolsInPlay: true, turnIndex: 0, hasImages: true },
        floor: { arm: "strong", outcome: "ok" },
        backedOffTo: "hard",
      },
    },
    {
      kind: "model_stage",
      payload: {
        turnNumber: 1,
        stage: "escalate",
        strategy: "cascade",
        role: "escalation",
        model: "claude-opus-5-20260101",
        profile: "strong",
        outcome: "done",
        costUsdMicros: 4200,
      },
    },
    // A refused directive on a turn that never routed — it must still replay.
    {
      kind: "model_directive",
      payload: {
        turnNumber: 2,
        source: "repl",
        requested: "nope",
        accepted: false,
        reason: "unknown arm",
      },
    },
  ];
  writeFileSync(
    join(sessions, "sess_t1.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  return { dir, session: "sess_t1" };
}

describe("route explain v2", () => {
  test("readRouteTimeline carries every durable field and derives the arm id", () => {
    const { dir, session } = seededSession();
    const t = readRouteTimeline(dir, session);
    expect(t.decisions).toHaveLength(1);
    const d = t.decisions[0] as NonNullable<(typeof t.decisions)[number]>;
    // The arm id is `profile ?? specModel ?? wire` — the identity
    // `recordPoolOutcome` keys on, derived rather than persisted so the two
    // halves can never disagree.
    expect(d.armId).toBe("strong");
    expect(d.specModel).toBe("claude-opus-5");
    expect(d.scope).toBe("step-a");
    expect(d.toolsetFingerprint).toBe("ts_1");
    expect(d.ruleId).toBe("code-goes-strong");
    expect(d.classifierVerdict).toBe("strong");
    expect(d.eligible).toEqual(["fast", "strong"]);
    expect(d.hint).toEqual({ source: "directive", forcedArm: "strong" });
    expect(d.hasImages).toBe(true);
    expect(d.floor).toEqual({ arm: "strong", outcome: "ok" });
    expect(d.backedOffTo).toBe("hard");
    expect(d.policy).toBe("directive");
    expect(t.directives).toHaveLength(2);
    expect(t.stages).toHaveLength(1);
  });

  test("a decision-less arm id falls back to the wire model", () => {
    const { dir } = seededSession();
    const sessions = join(dir, "sessions");
    writeFileSync(
      join(sessions, "sess_bare.jsonl"),
      `${JSON.stringify({
        kind: "model_route",
        payload: {
          turnNumber: 1,
          routeKey: "easy",
          model: "claude-haiku-4-5",
          policy: "static",
          reason: "only",
        },
      })}\n`,
    );
    expect(readRouteTimeline(dir, "sess_bare").decisions[0]?.armId).toBe("claude-haiku-4-5");
  });

  test("the human table interleaves directives and stages under their turn", () => {
    const { dir, session } = seededSession();
    const text = formatRouteExplain(session, readRouteTimeline(dir, session));
    expect(text).toContain("code-goes-strong");
    expect(text).toContain("/model strong → strong [repl] accepted");
    expect(text).toContain("cascade/escalate escalation");
    // The stage carries the turn's priced spend — the decision row cannot
    // (the route is chosen before the call is made).
    expect(text).toContain("$0.00420");
    // The refused directive on the un-routed turn is NOT dropped.
    expect(text).toContain("/model nope [repl] REFUSED: unknown arm");
  });

  test("--json renders the timeline verbatim", () => {
    const { dir, session } = seededSession();
    const payload = routeExplainJson(session, readRouteTimeline(dir, session));
    expect(payload.session).toBe(session);
    expect(payload.decisions[0]?.armId).toBe("strong");
    expect(payload.stages[0]?.outcome).toBe("done");
    const printed = runRoute(["explain", session, "--dir", dir, "--json"]);
    expect(JSON.parse(printed).decisions[0].ruleId).toBe("code-goes-strong");
  });

  test("readRouteDecisions still returns just the decisions", () => {
    const { dir, session } = seededSession();
    expect(readRouteDecisions(dir, session)).toHaveLength(1);
  });
});

describe("route status v2", () => {
  function laneRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-lane-"));
    TMP.push(dir);
    const sb = openScoreboard(dir, { now: () => 1_700_000_000_000 });
    sb.record("step-a/hard", "strong", 0.9, { success: true, latencyMs: 900, costUsd: 0.03 });
    sb.record("step-a/easy", "fast", 0.7, { success: true, latencyMs: 200, costUsd: 0.001 });
    sb.record("shadow:hard", "candidate-x", 0.95, { success: true, latencyMs: 800, costUsd: 0.02 });
    return dir;
  }

  test("observe-only lanes are HIDDEN by default and revealed by --shadow", () => {
    const dir = laneRoot();
    const plain = formatRouteStatus(loadArms(dir));
    expect(plain).not.toContain("candidate-x");
    expect(plain).toContain("observe-only lane arm(s) hidden");
    const withShadow = formatRouteStatus(loadArms(dir), { shadow: true });
    expect(withShadow).toContain("candidate-x");
    expect(withShadow).toContain("OBSERVE-ONLY");
  });

  test("--by profile groups by arm id; --by scope groups by the routeKey's scope", () => {
    const dir = laneRoot();
    const byProfile = formatRouteStatus(loadArms(dir), { by: "profile" });
    expect(byProfile.split("\n")[0]).toContain("arm");
    expect(byProfile).toContain("strong");
    const byScope = formatRouteStatus(loadArms(dir), { by: "scope" });
    expect(byScope.split("\n")[0]).toContain("scope");
    expect(byScope).toContain("step-a");
  });

  test("--json labels each row's lane and scope", () => {
    const dir = laneRoot();
    const payload = routeStatusJson(loadArms(dir), undefined, { shadow: true, by: "profile" });
    expect(payload.by).toBe("profile");
    const lane = payload.arms.find((a) => a.model === "candidate-x");
    expect(lane?.lane).toBe("observe-only");
    expect(payload.arms.find((a) => a.model === "strong")?.scope).toBe("step-a");
  });

  test("a root with ONLY lane arms says so rather than reporting emptiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-route-lane-only-"));
    TMP.push(dir);
    openScoreboard(dir, { now: () => 1 }).record("shadow:hard", "cand", 0.5, {
      success: true,
      latencyMs: 1,
    });
    expect(formatRouteStatus(loadArms(dir))).toContain("No LIVE routing arms yet");
  });
});

describe("route propose — arg parsing", () => {
  test("accepts -o and --json", () => {
    expect(parseRouteArgs(["propose", "--json", "-o", "/tmp/p"])).toEqual({
      sub: "propose",
      dir: ".crewhaus",
      json: true,
      out: "/tmp/p",
    });
  });
  test("runRoute refuses it — propose reads the spec, so it is the command entry's job", () => {
    expect(() => runRoute(["propose"])).toThrow(/runRouteCommand/);
  });
});
