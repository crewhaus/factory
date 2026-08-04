/**
 * The two M2 action faces that write harness state through a sanctioned
 * store rather than a hand-rolled file edit.
 *
 * SESSION PIN → `.crewhaus/retention.json`. The pin list is the ONE thing
 * that stops both enforcement paths (`crewhaus retention sweep` and the
 * daemon shapes' boot janitor) from deleting a transcript, so a manager that
 * wrote it carelessly would delete an operator's evidence. Two rules:
 *
 *   1. **Validate before writing.** `loadRetentionConfig` is the parser both
 *      enforcers use; if it refuses the current file, this refuses too. A
 *      malformed policy must not be silently replaced with a well-formed one
 *      that says something different.
 *   2. **Preserve unknown keys.** The file is shared with packages this one
 *      does not know about; a rewrite that dropped `auditWindows` would
 *      quietly re-arm deletion during a compliance hold.
 *
 * BASELINE RE-PIN → `@crewhaus/eval-report`'s `setBaseline`. The baseline
 * key is `(specName, datasetName)` BY DESIGN — that is what keeps a spec
 * edit gated against the same measurement — so the run being pinned supplies
 * both, and a run that is not in this harness's index cannot be pinned.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import {
  type BaselineEntry,
  readBaselines,
  readRunIndex,
  setBaseline,
} from "@crewhaus/eval-report";
import { SESSION_ID_RE } from "./constants";
import { resolveInside } from "./safety";

// ---------------------------------------------------------------------------
// Session pinning
// ---------------------------------------------------------------------------

export type PinSessionResult =
  | {
      readonly outcome: "ok";
      readonly pinned: boolean;
      readonly pins: readonly string[];
      readonly changed: boolean;
    }
  | { readonly outcome: "rejected"; readonly reason: string };

/**
 * Add or remove one session id from `.crewhaus/retention.json`'s `pins`.
 * Written atomically (tmp + rename in the same directory) so an enforcer
 * reading concurrently never sees a half-file.
 */
export async function pinSession(args: {
  readonly harnessDir: string;
  readonly sessionId: string;
  readonly pinned: boolean;
  readonly now?: () => number;
}): Promise<PinSessionResult> {
  if (!SESSION_ID_RE.test(args.sessionId)) {
    return { outcome: "rejected", reason: "invalid session id — expected sess_<16 hex>" };
  }
  const path = resolveInside(args.harnessDir, [".crewhaus", "retention.json"]);
  if (path === undefined) {
    return { outcome: "rejected", reason: "retention.json escapes the harness dir" };
  }
  // Parse-check with the enforcers' own loader FIRST: a policy this server
  // cannot read is a policy it must not replace.
  try {
    await loadRetentionConfig(args.harnessDir, args.now ?? (() => Date.now()));
  } catch (err) {
    return {
      outcome: "rejected",
      reason: `.crewhaus/retention.json is malformed — fix it before pinning (${
        err instanceof Error ? err.message : String(err)
      })`,
    };
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // loadRetentionConfig already accepted the file, so this cannot
      // normally happen; treat it as an empty policy rather than crash.
      existing = {};
    }
  }
  const current = Array.isArray(existing["pins"])
    ? (existing["pins"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  const set = new Set(current);
  const had = set.has(args.sessionId);
  if (args.pinned) set.add(args.sessionId);
  else set.delete(args.sessionId);
  const pins = [...set].sort();
  const changed = had !== args.pinned;

  // Unknown keys ride through untouched — this file is shared.
  const next = { version: 1, ...existing, pins };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return { outcome: "ok", pinned: args.pinned, pins, changed };
}

/** The pinned session ids currently recorded, for the sessions view. */
export function readPins(harnessDir: string): string[] {
  const path = join(harnessDir, ".crewhaus", "retention.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const pins = (parsed as Record<string, unknown>)["pins"];
    if (!Array.isArray(pins)) return [];
    return pins.filter((p): p is string => typeof p === "string" && SESSION_ID_RE.test(p));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Eval baseline re-pin
// ---------------------------------------------------------------------------

export type PinBaselineResult =
  | { readonly outcome: "ok"; readonly baseline: BaselineEntry }
  | { readonly outcome: "rejected"; readonly reason: string };

/**
 * Re-pin the eval baseline to an existing run of THIS harness. The entry is
 * copied from the run index — never assembled from the request — so the
 * pinned `(specName, datasetName)` key and the dataset hash are exactly the
 * ones the run was measured under.
 */
export function pinBaseline(args: {
  readonly harnessDir: string;
  readonly runId: string;
  readonly nowIso: string;
}): PinBaselineResult {
  const evalsDir = resolveInside(args.harnessDir, [".crewhaus", "evals"]);
  if (evalsDir === undefined) {
    return { outcome: "rejected", reason: "the evals dir escapes the harness dir" };
  }
  let index: ReturnType<typeof readRunIndex>;
  try {
    index = readRunIndex(evalsDir);
  } catch (err) {
    return {
      outcome: "rejected",
      reason: `eval history unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Later lines win, so scan from the end for the newest record of this run.
  const run = [...index].reverse().find((r) => r.runId === args.runId);
  if (run === undefined) {
    return {
      outcome: "rejected",
      reason: `run ${args.runId} is not in this harness's eval index — only a recorded run can be a baseline`,
    };
  }
  const entry: BaselineEntry = {
    specName: run.specName,
    datasetName: run.datasetName,
    runId: run.runId,
    outDir: run.outDir,
    datasetHash: run.datasetHash,
    ...(run.specSource !== undefined ? { specSource: run.specSource } : {}),
    ...(run.gradersHash !== undefined ? { gradersHash: run.gradersHash } : {}),
    ...(run.judgeModel !== undefined ? { judgeModel: run.judgeModel } : {}),
    ...(run.p95LatencyMs !== undefined ? { p95LatencyMs: run.p95LatencyMs } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ts: args.nowIso,
  };
  setBaseline(entry, evalsDir);
  return { outcome: "ok", baseline: entry };
}

/** The currently pinned baselines, for the effect check after a re-pin. */
export function currentBaselines(harnessDir: string): Record<string, BaselineEntry> {
  try {
    return readBaselines(join(harnessDir, ".crewhaus", "evals"));
  } catch {
    return {};
  }
}
