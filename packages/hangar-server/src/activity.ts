/**
 * The fleet activity digest — "what has this fleet been doing since X".
 *
 * CHEAP BY CONSTRUCTION. A digest is polled, across the whole fleet, so
 * every source here is either a `stat` or a small bounded read:
 *
 *   | signal        | source                                   | cost   |
 *   |---------------|------------------------------------------|--------|
 *   | session       | `sess_*.json` mtimes at the RESOLVED root | stat   |
 *   | eval          | `.crewhaus/evals/index.jsonl` `ts` fields  | capped |
 *   | spec change   | `.crewhaus/specs/<spec>/CHANGELOG.md` mtime | stat |
 *   | dream         | `.crewhaus/dream/<spec>/state.json`        | small  |
 *   | wiki          | `.crewhaus/wiki/articles/*.md` mtimes      | stat   |
 *   | incident      | `.crewhaus/incidents/<dir>` mtimes         | stat   |
 *   | deploy        | `.crewhaus/deployments.json` mtime         | stat   |
 *   | approval      | folded `approvals.jsonl` timestamps        | capped |
 *   | run           | `.crewhaus/run/runs.jsonl` (folded ledger) | capped |
 *
 * NO TRANSCRIPT IS EVER OPENED. The session signal is a file mtime, not a
 * parse — the same discipline the rollup digest uses, for the same reason:
 * a hundred harnesses × a thousand sessions must not become a hundred
 * thousand JSONL reads on a poll.
 *
 * Every item is a POINTER (harness + kind + a short label), never a payload
 * copy; the UI joins to the detail routes for the rest.
 */
import { readdirSync, statSync } from "node:fs";
import { readRunLedger } from "@crewhaus/harness-supervisor";
import { foldApprovals } from "./approvals";
import { SESSION_JSON_RE } from "./constants";
import { readJsonlCapped } from "./jsonl";
import { maskText } from "./mask";
import { resolveContained, resolveInside } from "./safety";
import { resolveSessionRoot } from "./sessions";

/** The activity kinds a digest emits. */
export const ACTIVITY_KINDS = [
  "session",
  "run",
  "eval",
  "spec",
  "dream",
  "wiki",
  "incident",
  "deploy",
  "approval",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityItem = {
  readonly kind: ActivityKind;
  readonly harnessId: string;
  readonly specName: string;
  /** ISO-8601. Every item has one; the digest sorts on it. */
  readonly at: string;
  /** One short line, already masked. */
  readonly label: string;
  /** Pointer for the UI to link with (`sess_…`, `run_…`, a slug, …). */
  readonly ref: string | null;
};

export type ActivityDigest = {
  readonly since: string;
  readonly items: readonly ActivityItem[];
  /** True when the per-harness item cap cut the digest short. */
  readonly truncated: boolean;
};

export type ActivityHarness = {
  readonly id: string;
  readonly dir: string;
  readonly specName: string;
};

/** Cap per harness, so one busy harness cannot drown the fleet digest. */
export const MAX_ACTIVITY_PER_HARNESS = 50;
/** Cap on the merged digest. */
export const MAX_ACTIVITY_ITEMS = 300;

const iso = (ms: number): string => new Date(ms).toISOString();

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** One harness's activity since `sinceMs`, newest first, capped. */
export function harnessActivity(
  harness: ActivityHarness,
  sinceMs: number,
): { readonly items: ActivityItem[]; readonly truncated: boolean } {
  const items: ActivityItem[] = [];
  const push = (kind: ActivityKind, atMs: number, label: string, ref: string | null): void => {
    if (!Number.isFinite(atMs) || atMs < sinceMs) return;
    items.push({
      kind,
      harnessId: harness.id,
      specName: harness.specName,
      at: iso(atMs),
      label: maskText(label),
      ref,
    });
  };
  const dir = harness.dir;

  // sessions — mtimes only, never a transcript read
  const { root } = resolveSessionRoot(dir);
  for (const name of listSafe(root)) {
    if (!SESSION_JSON_RE.test(name)) continue;
    const path = resolveContained(root, name);
    if (path === undefined) continue;
    const at = mtimeOf(path);
    if (at === undefined) continue;
    push("session", at, "session activity", name.slice(0, -".json".length));
  }

  // runs — the supervisor's folded ledger
  try {
    for (const entry of readRunLedger(dir)) {
      const closed = entry.endedAt !== undefined ? Date.parse(entry.endedAt) : Number.NaN;
      const opened = Date.parse(entry.startedAt);
      if (Number.isFinite(closed)) {
        push(
          "run",
          closed,
          `${entry.kind} run ended${entry.exitCode !== undefined ? ` (exit ${entry.exitCode})` : ""}${
            entry.failureClass !== undefined ? ` — ${entry.failureClass}` : ""
          }`,
          entry.runId,
        );
      } else if (Number.isFinite(opened)) {
        push("run", opened, `${entry.kind} run started`, entry.runId);
      }
    }
  } catch {
    // unreadable ledger — absence, not error
  }

  // evals — the run index's own timestamps
  const evalIndex = resolveInside(dir, [".crewhaus", "evals", "index.jsonl"]);
  if (evalIndex !== undefined) {
    for (const obj of readJsonlCapped(evalIndex).objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const row = obj as Record<string, unknown>;
      const ts = typeof row["ts"] === "string" ? Date.parse(row["ts"]) : Number.NaN;
      const pass = typeof row["passRate"] === "number" ? row["passRate"] : undefined;
      push(
        "eval",
        ts,
        `eval ${typeof row["datasetName"] === "string" ? row["datasetName"] : "run"}${
          pass !== undefined ? ` — ${(pass * 100).toFixed(1)}% pass` : ""
        }`,
        typeof row["runId"] === "string" ? row["runId"] : null,
      );
    }
  }

  // spec changelogs — the registry's per-spec CHANGELOG.md mtime
  const specsDir = resolveInside(dir, [".crewhaus", "specs"]);
  if (specsDir !== undefined) {
    for (const specName of listSafe(specsDir)) {
      const changelog = resolveInside(dir, [".crewhaus", "specs", specName, "CHANGELOG.md"]);
      if (changelog === undefined) continue;
      const at = mtimeOf(changelog);
      if (at !== undefined) push("spec", at, `spec ${specName} changelog updated`, specName);
    }
  }

  // dream — the consolidation scheduler's durable state
  const dreamDir = resolveInside(dir, [".crewhaus", "dream"]);
  if (dreamDir !== undefined) {
    for (const specName of listSafe(dreamDir)) {
      const state = resolveInside(dir, [".crewhaus", "dream", specName, "state.json"]);
      if (state === undefined) continue;
      const at = mtimeOf(state);
      if (at !== undefined) push("dream", at, `dream consolidation ran (${specName})`, specName);
    }
  }

  // wiki — article mtimes
  const articlesDir = resolveInside(dir, [".crewhaus", "wiki", "articles"]);
  if (articlesDir !== undefined) {
    for (const name of listSafe(articlesDir)) {
      if (!name.endsWith(".md")) continue;
      const path = resolveContained(articlesDir, name);
      if (path === undefined) continue;
      const at = mtimeOf(path);
      if (at !== undefined)
        push("wiki", at, `wiki article ${name.slice(0, -3)}`, name.slice(0, -3));
    }
  }

  // incidents — one dir per incident
  const incidentsDir = resolveInside(dir, [".crewhaus", "incidents"]);
  if (incidentsDir !== undefined) {
    for (const name of listSafe(incidentsDir)) {
      const path = resolveContained(incidentsDir, name);
      if (path === undefined) continue;
      const at = mtimeOf(path);
      if (at !== undefined) push("incident", at, `incident ${name}`, name);
    }
  }

  // deploys — the F-6 record file's mtime (contents are the route's job)
  const deployments = resolveInside(dir, [".crewhaus", "deployments.json"]);
  if (deployments !== undefined) {
    const at = mtimeOf(deployments);
    if (at !== undefined) push("deploy", at, "deployment record updated", null);
  }

  // approvals — folded (never listed: list() compacts)
  for (const approval of foldApprovals(dir).approvals) {
    const decidedAt =
      approval.decidedAt !== undefined ? Date.parse(approval.decidedAt) : Number.NaN;
    if (Number.isFinite(decidedAt)) {
      push(
        "approval",
        decidedAt,
        `approval ${approval.decision} — ${approval.toolName}`,
        approval.id,
      );
    } else {
      push(
        "approval",
        Date.parse(approval.createdAt),
        `approval parked — ${approval.toolName}`,
        approval.id,
      );
    }
  }

  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const truncated = items.length > MAX_ACTIVITY_PER_HARNESS;
  return { items: items.slice(0, MAX_ACTIVITY_PER_HARNESS), truncated };
}

/** The fleet digest since `sinceMs`, newest first. */
export function activityDigest(
  harnesses: readonly ActivityHarness[],
  sinceMs: number,
): ActivityDigest {
  const all: ActivityItem[] = [];
  let truncated = false;
  for (const harness of harnesses) {
    const one = harnessActivity(harness, sinceMs);
    if (one.truncated) truncated = true;
    all.push(...one.items);
  }
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (all.length > MAX_ACTIVITY_ITEMS) truncated = true;
  return { since: iso(sinceMs), items: all.slice(0, MAX_ACTIVITY_ITEMS), truncated };
}

/** Parse a `?since=` value: an ISO timestamp, epoch ms, or `<N>d`/`<N>h`.
 *  Anything unparseable falls back to `defaultMs` — a digest must render. */
export function parseSince(raw: string | null, nowMs: number, defaultWindowMs: number): number {
  if (raw === null || raw.trim() === "") return nowMs - defaultWindowMs;
  const value = raw.trim();
  const rel = value.match(/^(\d{1,6})([dhm])$/);
  if (rel !== null) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return nowMs - n * ms;
  }
  if (/^\d{1,15}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : nowMs - defaultWindowMs;
}

/** Default digest window when `?since=` is absent: 7 days. */
export const DEFAULT_ACTIVITY_WINDOW_MS = 7 * 86_400_000;
