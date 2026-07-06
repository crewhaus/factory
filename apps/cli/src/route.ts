/**
 * `crewhaus route` — inspect, explain, and reset adaptive model routing
 * (the `agent.model_pool` reward scoreboard + per-turn routing decisions).
 *
 *   route status  [--dir <root>]        show the learned arms, best-per-bucket first
 *   route explain <session> [--dir …]   replay a run's per-turn model_route decisions
 *   route reset   [--dir <root>]         wipe the scoreboard (kill switch)
 *
 * `--dir` points at the `.crewhaus` root (default `.crewhaus`); the scoreboard
 * lives at `<root>/routing/arms.jsonl` and session logs at
 * `<root>/sessions/<id>.jsonl`. `status` surfaces the ACCUMULATED learning a
 * `learned` policy exploits; `explain` shows WHY each turn of one run picked
 * the model it did (including ε-greedy exploration draws).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ArmStats, openScoreboard } from "@crewhaus/routing-store";

export type RouteArgs = {
  readonly sub: "status" | "reset" | "explain";
  readonly dir: string;
  /** Session id — required for `explain`. */
  readonly session?: string;
};

const DEFAULT_ROOT = ".crewhaus";

/** Parse `route <sub> [<session>] [--dir <root>]` argv (everything after `route`). */
export function parseRouteArgs(argv: readonly string[]): RouteArgs {
  let dir = DEFAULT_ROOT;
  let sub: RouteArgs["sub"] | undefined;
  let session: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--dir") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("route: --dir requires a path");
      dir = v;
      i++;
    } else if (sub === undefined && (a === "status" || a === "reset" || a === "explain")) {
      // A subcommand keyword is only the subcommand when it comes FIRST; after
      // that the same word is a plain positional (so `route explain status`
      // explains a session literally named "status", not runs `status`).
      sub = a;
    } else if (sub === "explain" && session === undefined && !a.startsWith("--")) {
      session = a; // the session id positional (only `explain` takes one)
    } else {
      throw new Error(
        `route: unknown argument "${a}" (expected: status | reset | explain <session> [--dir <root>])`,
      );
    }
  }
  if (sub === undefined) {
    throw new Error("route: expected a subcommand (status | explain <session> | reset)");
  }
  if (sub === "explain" && session === undefined) {
    throw new Error("route explain: a <session> id is required");
  }
  return { sub, dir, ...(session !== undefined ? { session } : {}) };
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

/** One persisted `model_route` decision from a session log. */
export type RouteDecision = {
  readonly turnNumber?: number;
  readonly routeKey: string;
  readonly model: string;
  readonly policy: string;
  readonly reason: string;
  readonly explored?: boolean;
  readonly policyVersion?: string;
};

/**
 * Read the `model_route` decisions persisted in a session's event log at
 * `<rootDir>/sessions/<sessionId>.jsonl`, in turn order. A missing log yields
 * `[]`; a malformed line is skipped (the log is best-effort observability).
 */
export function readRouteDecisions(rootDir: string, sessionId: string): RouteDecision[] {
  // Guard against a hostile session id escaping the sessions dir (e.g.
  // `../../etc/passwd`). Real ids are `sess_<hex>`; anything with a path
  // separator or `..` is rejected outright.
  if (/[/\\]/.test(sessionId) || sessionId.includes("..") || sessionId.length === 0) {
    throw new Error(`route explain: invalid session id "${sessionId}"`);
  }
  const path = join(rootDir, "sessions", `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const out: RouteDecision[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec: { kind?: unknown; payload?: unknown };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.kind !== "model_route" || typeof rec.payload !== "object" || rec.payload === null) {
      continue;
    }
    const p = rec.payload as Record<string, unknown>;
    if (typeof p["routeKey"] !== "string" || typeof p["model"] !== "string") continue;
    out.push({
      ...(typeof p["turnNumber"] === "number" ? { turnNumber: p["turnNumber"] } : {}),
      routeKey: p["routeKey"],
      model: p["model"],
      policy: typeof p["policy"] === "string" ? p["policy"] : "?",
      reason: typeof p["reason"] === "string" ? p["reason"] : "",
      ...(typeof p["explored"] === "boolean" ? { explored: p["explored"] } : {}),
      ...(typeof p["policyVersion"] === "string" ? { policyVersion: p["policyVersion"] } : {}),
    });
  }
  return out;
}

/** Render a run's per-turn routing decisions as a table (turn order). */
export function formatRouteExplain(sessionId: string, decisions: readonly RouteDecision[]): string {
  if (decisions.length === 0) {
    return `No model_route decisions recorded for session ${sessionId}. (Only runs whose spec declares \`agent.model_pool\` persist routing decisions.)`;
  }
  const lines: string[] = [`session ${sessionId} — ${decisions.length} routing decision(s):`, ""];
  lines.push(
    `${"turn".padStart(4)} ${"band".padEnd(5)} ${"model".padEnd(28)} ${"policy".padEnd(10)} ${"pick".padEnd(9)} reason`,
  );
  for (const d of decisions) {
    const turn = d.turnNumber !== undefined ? String(d.turnNumber) : "-";
    const pick = d.explored ? "explore" : "exploit";
    lines.push(
      `${turn.padStart(4)} ${d.routeKey.padEnd(5)} ${d.model.padEnd(28)} ${d.policy.padEnd(10)} ${pick.padEnd(9)} ${d.reason}`,
    );
  }
  return lines.join("\n");
}

/** Run `crewhaus route …`, returning the text to print. */
export function runRoute(argv: readonly string[]): string {
  const args = parseRouteArgs(argv);
  if (args.sub === "status") return formatRouteStatus(loadArms(args.dir));
  if (args.sub === "explain") {
    const session = args.session as string; // parseRouteArgs guarantees it for explain
    return formatRouteExplain(session, readRouteDecisions(args.dir, session));
  }
  const removed = resetRouting(args.dir);
  return `Reset routing scoreboard at ${join(args.dir, "routing", "arms.jsonl")} (${removed} arm${removed === 1 ? "" : "s"} removed).`;
}
