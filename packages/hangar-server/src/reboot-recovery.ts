/**
 * What Home does at boot after command recovery, and the report it leaves.
 *
 * The installed service (`resident`) starts again each harness a person last started and
 * nobody stopped since (`rebootVerdict`: active, `autostart`, `desired: running`, not
 * disabled, no live daemon, the kept restart window not full, the last exit not one a
 * restart cannot fix), through the supervisor's automatic start, which runs only the
 * active build. Home in a window (`foreground`) restarts nothing: it never starts a
 * daemon it did not start.
 *
 * Both modes write `<hangarRoot>/service/recovery.json` at every boot (0600, written
 * whole): harness ids, counts and reason codes, never a path or an argument.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoverCounts } from "@crewhaus/control-service";
import type { HangarHarnessEntry } from "@crewhaus/harness-registry";
import { type ProcessOps, type RebootReason, rebootVerdict } from "@crewhaus/harness-supervisor";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import type { ProcessLayer } from "./process";
import { resolveInside } from "./safety";

/** Where the last boot's report lives, under the Hangar root. */
export const RECOVERY_FILE = join("service", "recovery.json");

export type HomeMode = "foreground" | "resident";

export type RecoveryReport = {
  readonly v: 1;
  readonly at: string;
  readonly mode: HomeMode;
  readonly hostBootedAt: string;
  readonly adopted: number;
  readonly lost: number;
  readonly jobs: number;
  readonly commands: RecoverCounts;
  readonly restarted: ReadonlyArray<{ readonly harness: string; readonly runId: string }>;
  readonly skipped: ReadonlyArray<{ readonly harness: string; readonly reason: RebootReason }>;
  readonly failed: ReadonlyArray<{ readonly harness: string; readonly message: string }>;
};

export type RestartOutcome = Pick<RecoveryReport, "restarted" | "skipped" | "failed">;

/** A start's refusal, in one fixed phrase per reason: never the process's own words. */
function refusalWords(reason: string): string {
  switch (reason) {
    case "disabled":
      return "disabled by its operator";
    case "already-running":
      return "already running";
    case "build-not-active":
      return "the build on disk is not the active deployment's";
    case "preflight-blocked":
      return "a check before it starts did not pass";
    default:
      return "it could not be started";
  }
}

/**
 * Start again what a person last started, for the installed service. Each live
 * registered harness is judged once; a start that throws or refuses is a `failed` row.
 */
export async function restartAfterReboot(deps: {
  readonly entries: readonly HangarHarnessEntry[];
  readonly processes: ProcessLayer;
  readonly ops: ProcessOps;
  readonly now: () => number;
}): Promise<RestartOutcome> {
  const restarted: Array<{ harness: string; runId: string }> = [];
  const skipped: Array<{ harness: string; reason: RebootReason }> = [];
  const failed: Array<{ harness: string; message: string }> = [];
  for (const entry of deps.entries) {
    const verdict = rebootVerdict(entry.dir, { ops: deps.ops, now: deps.now() });
    if (!verdict.restart) {
      skipped.push({ harness: entry.id, reason: verdict.reason });
      continue;
    }
    try {
      const started = await deps.processes.get(entry).supervisor.startAfterReboot();
      if (started.ok) restarted.push({ harness: entry.id, runId: started.runId });
      else failed.push({ harness: entry.id, message: refusalWords(started.reason) });
    } catch {
      failed.push({ harness: entry.id, message: "it could not be started" });
    }
  }
  return { restarted, skipped, failed };
}

/**
 * Write the report whole (a temporary file of its own, then a rename), contained to the
 * Hangar root: a link that would carry it out is refused (thrown).
 */
export function writeRecoveryReport(hangarRoot: string, report: RecoveryReport): void {
  mkdirSync(hangarRoot, { recursive: true, mode: 0o700 });
  const dir = ensureDirContained(hangarRoot, "service", { mode: 0o700 });
  if (!dir.ok) throw new Error(dir.reason);
  const written = writeFileSafe(hangarRoot, RECOVERY_FILE, `${JSON.stringify(report, null, 2)}\n`, {
    overwrite: true,
    mode: 0o600,
  });
  if (!written.ok) throw new Error(written.reason);
}

/** The last boot's report, or `undefined` when there is none Home can read. */
export function readRecoveryReport(hangarRoot: string): RecoveryReport | undefined {
  const path = resolveInside(hangarRoot, ["service", "recovery.json"]);
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const report = parsed as Partial<RecoveryReport>;
    if (
      report.v !== 1 ||
      typeof report.at !== "string" ||
      !Array.isArray(report.restarted) ||
      !Array.isArray(report.skipped) ||
      !Array.isArray(report.failed)
    ) {
      return undefined;
    }
    return report as RecoveryReport;
  } catch {
    return undefined;
  }
}
