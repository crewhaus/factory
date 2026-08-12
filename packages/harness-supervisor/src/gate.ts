/**
 * The preflight gate: preflight runs before EVERY spawn, and a blocking
 * finding refuses the spawn with the typed report instead of relaying the
 * stack trace the spawn would otherwise die with.
 *
 * Two rules make the gate usable rather than annoying:
 *
 *   - every blocking item is INDIVIDUALLY acknowledgeable by id ("start
 *     anyway"), because an operator often knows better than an offline
 *     check — a port that a sibling is about to release, a credential the
 *     process will pick up from a keychain;
 *   - **except missing channel secrets**, which are not a judgement call:
 *     the compiled channel daemon's own boot gate exits 2 on exactly that
 *     set, so "start anyway" would spawn a process guaranteed to die. The
 *     gate refuses those no matter what is acknowledged or forced.
 *
 * The env the gate checks MUST be the env the spawn receives — pass the
 * merged spawn env, not `process.env`.
 */
import type { HookDisclosure, PreflightItem, PreflightReport } from "@crewhaus/preflight";
import { runPreflight } from "@crewhaus/preflight";
import type { PortRequest } from "@crewhaus/preflight";
import { MANAGER_HOOK_NAMES, readManagerSettings } from "./manager-settings";
import { readHookRunLog } from "./prepare";
import { recentRuns } from "./runfiles";
import { type EnvFileRef, loadEnvChain } from "./spawn-contracts";

/**
 * What preflight should say about this harness's operator hooks.
 *
 * "Never ran, but the harness HAS run" is the one that earns a warning: it
 * is the shape of a fleet whose operator believes prep is happening and
 * whose daemon has never had it — the failure the hook contract replaced a
 * `prep.sh` convention to prevent.
 */
export function harnessHookDisclosures(harnessDir: string): HookDisclosure[] {
  const hooks = readManagerSettings(harnessDir).hooks;
  const declared = MANAGER_HOOK_NAMES.filter((name) => hooks[name] !== undefined);
  if (declared.length === 0) return [];
  const runs = readHookRunLog(harnessDir);
  const harnessHasRun = recentRuns(harnessDir, 1).length > 0;
  return declared.map((name) => {
    const record = runs[name];
    return {
      name,
      declaredAs: hooks[name]?.declaredAs ?? "",
      ...(record !== undefined
        ? { lastRunAt: record.at, lastRunOk: record.ok }
        : harnessHasRun
          ? { neverRanDespiteRuns: true }
          : {}),
    };
  });
}

/** Blocking items in these areas can never be waved through. */
export const UNFORCEABLE_AREAS: ReadonlySet<string> = new Set(["channels"]);

/** True for a finding no acknowledgement may override. */
export function isUnforceable(item: PreflightItem): boolean {
  return item.level === "blocking" && UNFORCEABLE_AREAS.has(item.area);
}

export type GateDecision = {
  readonly allowed: boolean;
  readonly report: PreflightReport;
  /** Blocking items still standing in the way. */
  readonly refused: readonly PreflightItem[];
  /** The subset of `refused` that no force flag can clear. */
  readonly unforceable: readonly PreflightItem[];
  /** Blocking items the operator explicitly waved through. */
  readonly acknowledged: readonly PreflightItem[];
};

export type GateOptions = {
  /** Acknowledge every forceable blocking item. */
  readonly force?: boolean;
  /** Acknowledge specific items by their stable `id`. */
  readonly acknowledge?: readonly string[];
};

/** Apply the acknowledgement rules to an existing report. Pure. */
export function evaluateGate(report: PreflightReport, options: GateOptions = {}): GateDecision {
  const acked = new Set(options.acknowledge ?? []);
  const acknowledged: PreflightItem[] = [];
  const refused: PreflightItem[] = [];
  for (const item of report.blocking) {
    if (isUnforceable(item)) {
      refused.push(item);
      continue;
    }
    if (options.force === true || acked.has(item.id)) {
      acknowledged.push(item);
      continue;
    }
    refused.push(item);
  }
  return {
    allowed: refused.length === 0,
    report,
    refused,
    unforceable: refused.filter(isUnforceable),
    acknowledged,
  };
}

export type RunGateOptions = GateOptions & {
  readonly harnessDir: string;
  /** The MERGED env the spawn will receive. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The chain `env` was merged from. Defaults to reading the harness's own
   *  chain — including the shared files `manager.envFiles` declares — so the
   *  report NAMES the files behind the env it just checked. */
  readonly envFiles?: readonly EnvFileRef[];
  /** Operator hooks this spawn will run. Defaults to reading the harness's
   *  own `manager.hooks` + its last-run record, so the report DISCLOSES the
   *  commands a start is about to run from `.crewhaus/settings.json`. */
  readonly hooks?: readonly HookDisclosure[];
  readonly compileWarnings?: readonly string[];
  readonly ports?: readonly PortRequest[];
  /** Seam for tests and for managers with their own preflight composition. */
  readonly preflight?: typeof runPreflight;
};

/** Run preflight against the spawn env and apply the gate. */
export async function runPreflightGate(options: RunGateOptions): Promise<GateDecision> {
  const run = options.preflight ?? runPreflight;
  const report = await run({
    harnessDir: options.harnessDir,
    env: options.env,
    envFiles: options.envFiles ?? loadEnvChain(options.harnessDir).refs,
    hooks: options.hooks ?? harnessHookDisclosures(options.harnessDir),
    ...(options.compileWarnings !== undefined ? { compileWarnings: options.compileWarnings } : {}),
    ...(options.ports !== undefined ? { ports: options.ports } : {}),
  });
  return evaluateGate(report, {
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.acknowledge !== undefined ? { acknowledge: options.acknowledge } : {}),
  });
}

/** Operator-facing lines for a refusal — the "will not boot: X" report a
 *  manager shows in place of a stack trace. */
export function formatGateRefusal(decision: GateDecision): string[] {
  const lines: string[] = ["preflight refused the spawn:"];
  for (const item of decision.refused) {
    lines.push(`  ✗ ${item.message}`);
    if (item.remediation !== undefined) lines.push(`      ${item.remediation}`);
    if (isUnforceable(item)) {
      lines.push("      (cannot be overridden — the compiled daemon exits 2 on this)");
    }
  }
  if (decision.acknowledged.length > 0) {
    lines.push(`  ~ ${decision.acknowledged.length} blocking item(s) acknowledged by the operator`);
  }
  return lines;
}
