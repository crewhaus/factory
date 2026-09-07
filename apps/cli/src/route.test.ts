import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScoreboard, readRouteFreeze, routeFreezePath } from "@crewhaus/routing-store";
import {
  formatRouteFreeze,
  formatRouteStatus,
  loadArms,
  loadRouteFreeze,
  parseRouteArgs,
  readRouteDecisions,
  resetRouting,
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
