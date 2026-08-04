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
import type { PreflightItem, PreflightReport } from "@crewhaus/preflight";
import { runPreflight } from "@crewhaus/preflight";
import type { PortRequest } from "@crewhaus/preflight";

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
