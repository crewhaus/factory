/**
 * `crewhaus route` — inspect and reset the adaptive-model-routing scoreboard
 * (the durable per-`(routeKey, model)` reward store behind `agent.model_pool`).
 *
 *   route status [--dir <root>]   show the learned arms, best-per-bucket first
 *   route reset  [--dir <root>]   wipe the scoreboard (kill switch)
 *
 * `--dir` points at the `.crewhaus` root (default `.crewhaus`); the store lives
 * at `<root>/routing/arms.jsonl`. Live per-turn `model_route` decisions are
 * already visible in a run's structured trace; this command surfaces the
 * ACCUMULATED learning that a `learned` policy exploits.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ArmStats, openScoreboard } from "@crewhaus/routing-store";

export type RouteArgs = {
  readonly sub: "status" | "reset";
  readonly dir: string;
};

const DEFAULT_ROOT = ".crewhaus";

/** Parse `route <sub> [--dir <root>]` argv (everything after `route`). */
export function parseRouteArgs(argv: readonly string[]): RouteArgs {
  let dir = DEFAULT_ROOT;
  let sub: RouteArgs["sub"] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route: --dir requires a path");
      dir = v;
      i++;
    } else if (a === "status" || a === "reset") {
      sub = a;
    } else {
      throw new Error(`route: unknown argument "${a}" (expected: status | reset [--dir <root>])`);
    }
  }
  if (sub === undefined) throw new Error("route: expected a subcommand (status | reset)");
  return { sub, dir };
}

/** Snapshot the scoreboard arms (sorted routeKey then model). */
export function loadArms(rootDir: string): ArmStats[] {
  return openScoreboard(rootDir).snapshot();
}

/**
 * Render the scoreboard as a human table: grouped by routeKey, best mean-reward
 * arm first within each bucket and starred (the arm a `learned` policy would
 * exploit once every arm clears its sample floor).
 */
export function formatRouteStatus(arms: readonly ArmStats[]): string {
  if (arms.length === 0) {
    return "No routing data yet. Run a harness whose spec declares `agent.model_pool` to accumulate arms.";
  }
  const byKey = new Map<string, ArmStats[]>();
  for (const a of arms) {
    const g = byKey.get(a.routeKey) ?? [];
    g.push(a);
    byKey.set(a.routeKey, g);
  }
  const lines: string[] = [];
  lines.push(
    `${"routeKey".padEnd(9)} ${"model".padEnd(28)} ${"n".padStart(5)} ${"reward".padStart(7)} ${"latency".padStart(9)} ${"cost".padStart(10)}`,
  );
  for (const key of [...byKey.keys()].sort()) {
    const group = (byKey.get(key) ?? []).slice().sort((x, y) => y.meanReward - x.meanReward);
    group.forEach((a, i) => {
      const star = i === 0 && a.n > 0 ? " *" : "";
      const latency = `${a.meanLatencyMs.toFixed(0)}ms`;
      const cost = a.meanCostUsd > 0 ? `$${a.meanCostUsd.toFixed(5)}` : "-";
      lines.push(
        `${key.padEnd(9)} ${a.model.padEnd(28)} ${String(a.n).padStart(5)} ${a.meanReward.toFixed(3).padStart(7)} ${latency.padStart(9)} ${cost.padStart(10)}${star}`,
      );
    });
  }
  lines.push("");
  lines.push(
    "* = current best arm in its bucket (what a `learned` policy exploits once every arm clears its sample floor).",
  );
  return lines.join("\n");
}

/** Wipe the whole scoreboard. Returns the number of arms removed. */
export function resetRouting(rootDir: string): number {
  const removed = loadArms(rootDir).length;
  const path = join(rootDir, "routing", "arms.jsonl");
  if (existsSync(path)) rmSync(path, { force: true });
  return removed;
}

/** Run `crewhaus route …`, returning the text to print. */
export function runRoute(argv: readonly string[]): string {
  const args = parseRouteArgs(argv);
  if (args.sub === "status") return formatRouteStatus(loadArms(args.dir));
  const removed = resetRouting(args.dir);
  return `Reset routing scoreboard at ${join(args.dir, "routing", "arms.jsonl")} (${removed} arm${removed === 1 ? "" : "s"} removed).`;
}
