import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScoreboard } from "@crewhaus/routing-store";
import { formatRouteStatus, loadArms, parseRouteArgs, resetRouting, runRoute } from "./route";

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
    expect(() => parseRouteArgs(["bogus"])).toThrow(/unknown argument/);
    expect(() => parseRouteArgs(["status", "--dir"])).toThrow(/requires a path/);
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
