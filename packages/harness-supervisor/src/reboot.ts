/**
 * Reboot recovery's one question about a harness: should the installed Home service start
 * it again now that the machine has started? Only what a person last started comes back:
 *
 * | Found | Verdict |
 * |---|---|
 * | a live daemon on its runfile (one already attached counts) | `live` |
 * | deployment records, the operator record or the kept restart window that cannot be read | `unreadable` |
 * | no active deployment | `no-active` |
 * | an active deployment not marked to start on its own | `not-autostart` |
 * | disabled by its operator | `disabled` |
 * | a person's last word was stop (or there is none) | `not-desired` |
 * | the kept restart window is full | `crash-loop` |
 * | the newest run ended with an exit no restart fixes | `terminal-exit` |
 * | none of these | restart |
 *
 * A pure read: it writes nothing, clears no runfile and spawns nothing.
 */
import { readDeployments, readOperatorRecord } from "@crewhaus/control-records";
import { observeRunfile } from "./adoption";
import { MAX_RESTARTS_PER_WINDOW, RESTART_WINDOW_MS, TERMINAL_EXIT_CODES } from "./policy";
import type { ProcessOps } from "./process-ops";
import { readRunLedger, readSupervisionRecord } from "./runfiles";

export type RebootReason =
  | "live"
  | "no-active"
  | "not-autostart"
  | "not-desired"
  | "disabled"
  | "crash-loop"
  | "terminal-exit"
  | "unreadable";

export type RebootVerdict =
  | { readonly restart: true }
  | { readonly restart: false; readonly reason: RebootReason };

/**
 * Whether reboot recovery starts this harness again ({@link RebootReason} says why not).
 *
 * First consumer: Home's boot in the installed service.
 */
export function rebootVerdict(
  harnessDir: string,
  options: {
    readonly ops: ProcessOps;
    readonly now: number;
    readonly maxRestarts?: number;
    readonly windowMs?: number;
  },
): RebootVerdict {
  const no = (reason: RebootReason): RebootVerdict => ({ restart: false, reason });
  if (observeRunfile(harnessDir, options.ops).state === "live") return no("live");

  const deployments = readDeployments(harnessDir);
  if (deployments.state === "unreadable") return no("unreadable");
  if (deployments.state === "absent" || deployments.active === undefined) return no("no-active");
  if (deployments.active["autostart"] !== true) return no("not-autostart");

  const operator = readOperatorRecord.refresh(harnessDir);
  if (operator.state === "unreadable") return no("unreadable");
  if (operator.state === "present" && operator.record.deployment?.disabled === true) {
    return no("disabled");
  }
  if (operator.state !== "present" || operator.record.desired !== "running") {
    return no("not-desired");
  }

  const window = readSupervisionRecord(harnessDir);
  if (window.state === "unreadable") return no("unreadable");
  if (window.state === "present") {
    const since = options.now - (options.windowMs ?? RESTART_WINDOW_MS);
    const recent = window.record.restarts.filter((at) => at > since).length;
    if (recent >= (options.maxRestarts ?? MAX_RESTARTS_PER_WINDOW)) return no("crash-loop");
  }

  let newest: { readonly at: number; readonly exitCode: number | undefined } | undefined;
  for (const entry of readRunLedger(harnessDir)) {
    const at = Date.parse(entry.startedAt);
    if (!Number.isFinite(at)) continue;
    if (newest === undefined || at >= newest.at) newest = { at, exitCode: entry.exitCode };
  }
  if (newest?.exitCode !== undefined && TERMINAL_EXIT_CODES.includes(newest.exitCode)) {
    return no("terminal-exit");
  }
  return { restart: true };
}
