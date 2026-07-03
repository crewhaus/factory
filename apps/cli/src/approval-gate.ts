/**
 * Item 59 (half 1) — approval-gated promotion. `crewhaus deploy promote
 * --require-approval` must not flip a PROTECTED environment's pin until an
 * approval quorum is satisfied: a recorded set of approval tokens AND/OR a
 * green PR check. The gate is a side-effect-free decision layer that runs
 * BEFORE the deployment-controller's `promote` — the controller stays a dumb
 * pin-flipper; policy lives here (and is testable without a registry).
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Mirrors `retention.ts` / `audit-verify.ts`: pure config + decision, plus a
 * thin recorded-approvals reader over `.crewhaus/approvals`.
 *
 * WHAT IS PROTECTED — `.crewhaus/environments.json` declares which
 * environments require approval and how many:
 *
 *   { "environments": {
 *       "prod":    { "requireApproval": true,  "minApprovals": 2 },
 *       "staging": { "requireApproval": false }
 *   } }
 *
 * A missing file / missing entry means the env is UNPROTECTED (the pre-item-59
 * behavior — `promote` runs unconditionally). `--require-approval` is opt-in
 * per invocation; an env can also be marked protected in the config so a
 * plain `promote` to it is refused with a pointer to `--require-approval`.
 *
 * WHAT SATISFIES THE GATE — two independent, OR-combined witnesses:
 *   1. Recorded approvals: `.crewhaus/approvals/<spec>__<env>.json` holds an
 *      array of `{ approver, ts, version? }`. Distinct approvers count toward
 *      `minApprovals`; an approval pinned to a DIFFERENT candidate version
 *      than the one being promoted does not count (you approved v2, not v3).
 *   2. A green PR check: an injected `PrCheckReader` resolves the merge/CI
 *      state of the proposal PR for this change. A `success` conclusion
 *      counts as one collective approval witness (a reviewed+green PR is the
 *      team's sign-off) — enough on its own only when `minApprovals <= 1`,
 *      otherwise it ADDS to the recorded-approval count.
 *
 * The gate NEVER approves itself: with no witnesses it refuses, and the
 * refusal is as audit-worthy as the approval — both produce a
 * `governance_approval` record so a scheduled promotion that was blocked is
 * evidenced too.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Thrown for malformed config / approvals files. The CLI routes the message
 *  through `die()`; tests assert on `.message`. */
export class ApprovalGateError extends Error {
  override readonly name = "ApprovalGateError";
}

export const ENVIRONMENTS_CONFIG_RELPATH = ".crewhaus/environments.json";
export const APPROVALS_RELDIR = ".crewhaus/approvals";

// ---------------------------------------------------------------------------
// environments.json
// ---------------------------------------------------------------------------

export type EnvironmentPolicy = {
  readonly requireApproval: boolean;
  /** Distinct approvals required to flip this env. Defaults to 1 when
   *  requireApproval is true and unset. */
  readonly minApprovals: number;
};

export type EnvironmentsConfig = {
  readonly environments: Readonly<Record<string, EnvironmentPolicy>>;
  /** true when a real config file was found (vs the all-unprotected default). */
  readonly fromFile: boolean;
};

/**
 * Load `.crewhaus/environments.json` from a harness root. A missing file
 * yields the all-unprotected default (`fromFile: false`). A present-but-
 * malformed file throws — a protected-env policy that silently degraded to
 * "unprotected" would be the worst possible failure mode.
 */
export function loadEnvironmentsConfig(rootDir: string): EnvironmentsConfig {
  const path = join(rootDir, ENVIRONMENTS_CONFIG_RELPATH);
  if (!existsSync(path)) return { environments: {}, fromFile: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new ApprovalGateError(
      `${ENVIRONMENTS_CONFIG_RELPATH} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ApprovalGateError(`${ENVIRONMENTS_CONFIG_RELPATH} must be a JSON object`);
  }
  const envsRaw = (parsed as Record<string, unknown>)["environments"];
  if (typeof envsRaw !== "object" || envsRaw === null) {
    throw new ApprovalGateError(
      `${ENVIRONMENTS_CONFIG_RELPATH} must carry an "environments" object`,
    );
  }
  const environments: Record<string, EnvironmentPolicy> = {};
  for (const [env, v] of Object.entries(envsRaw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) {
      throw new ApprovalGateError(`environments.${env} must be an object`);
    }
    const rec = v as Record<string, unknown>;
    const requireApproval = rec["requireApproval"] === true;
    let minApprovals = 1;
    if (rec["minApprovals"] !== undefined) {
      const n = rec["minApprovals"];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
        throw new ApprovalGateError(`environments.${env}.minApprovals must be a positive integer`);
      }
      minApprovals = n;
    }
    environments[env] = { requireApproval, minApprovals };
  }
  return { environments, fromFile: true };
}

/** The policy for `env`, or an unprotected default. */
export function policyForEnv(config: EnvironmentsConfig, env: string): EnvironmentPolicy {
  return config.environments[env] ?? { requireApproval: false, minApprovals: 1 };
}

// ---------------------------------------------------------------------------
// recorded approvals
// ---------------------------------------------------------------------------

export type ApprovalRecord = {
  readonly approver: string;
  readonly ts: string;
  /** Candidate version this approval is FOR; when set it must match the
   *  version being promoted to count. */
  readonly version?: string;
  readonly comment?: string;
};

/** Approvals file name for a (spec, env) pair. `/` is not possible in a spec
 *  registry name, so `__` is a safe joiner. */
export function approvalsFileName(specName: string, env: string): string {
  return `${specName}__${env}.json`;
}

/**
 * Read recorded approvals for a (spec, env) from
 * `.crewhaus/approvals/<spec>__<env>.json`. Missing file → []. A malformed
 * file throws (a dropped approval could silently under-count the quorum).
 */
export function readApprovals(rootDir: string, specName: string, env: string): ApprovalRecord[] {
  const path = join(rootDir, APPROVALS_RELDIR, approvalsFileName(specName, env));
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new ApprovalGateError(
      `approvals file ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ApprovalGateError(`approvals file ${path} must be a JSON array of { approver, ts }`);
  }
  const out: ApprovalRecord[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["approver"] !== "string" || typeof rec["ts"] !== "string") continue;
    out.push({
      approver: rec["approver"],
      ts: rec["ts"],
      ...(typeof rec["version"] === "string" ? { version: rec["version"] } : {}),
      ...(typeof rec["comment"] === "string" ? { comment: rec["comment"] } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PR-check witness (injected)
// ---------------------------------------------------------------------------

export type PrCheckState = {
  /** "success" | "pending" | "failure" | "none" (no PR found for the change). */
  readonly conclusion: "success" | "pending" | "failure" | "none";
  readonly prNumber?: number;
  readonly url?: string;
};

/** Reader seam: resolve the PR-check state for a (spec, env, version) change.
 *  Production drives `gh`; tests inject a fixed state. */
export type PrCheckReader = (args: {
  readonly specName: string;
  readonly env: string;
  readonly version: string;
}) => Promise<PrCheckState>;

// ---------------------------------------------------------------------------
// the gate decision
// ---------------------------------------------------------------------------

export type ApprovalDecisionInput = {
  readonly specName: string;
  readonly toEnv: string;
  /** The candidate version the promotion would pin to. */
  readonly toVersion: string;
  readonly policy: EnvironmentPolicy;
  readonly approvals: ReadonlyArray<ApprovalRecord>;
  /** Present only when a PR-check witness was consulted. */
  readonly prCheck?: PrCheckState;
};

export type ApprovalDecision = {
  readonly satisfied: boolean;
  /** Distinct approvers whose approval is valid for this candidate version. */
  readonly countedApprovers: ReadonlyArray<string>;
  /** True when a green PR check contributed a witness. */
  readonly prWitness: boolean;
  readonly required: number;
  readonly reason: string;
};

/**
 * Decide whether the gate is satisfied. Counts DISTINCT approvers whose
 * approval either carries no version pin or matches `toVersion`, plus one
 * collective witness for a green PR check. Satisfied when
 * `witnesses >= required`.
 */
export function decideApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const required = input.policy.minApprovals;
  const counted = new Set<string>();
  for (const a of input.approvals) {
    if (a.version !== undefined && a.version !== input.toVersion) continue;
    counted.add(a.approver);
  }
  const prWitness = input.prCheck?.conclusion === "success";
  const witnesses = counted.size + (prWitness ? 1 : 0);
  const satisfied = witnesses >= required;

  let reason: string;
  if (satisfied) {
    const parts: string[] = [];
    if (counted.size > 0)
      parts.push(`${counted.size} recorded approval(s): ${[...counted].sort().join(", ")}`);
    if (prWitness) parts.push(`green PR check (#${input.prCheck?.prNumber ?? "?"})`);
    reason = `quorum met (${witnesses}/${required}) — ${parts.join("; ")}`;
  } else {
    const missing = required - witnesses;
    const detail: string[] = [];
    detail.push(`have ${witnesses} witness(es), need ${required}`);
    if (counted.size > 0) detail.push(`approvers: ${[...counted].sort().join(", ")}`);
    if (input.prCheck !== undefined && !prWitness) {
      detail.push(`PR check: ${input.prCheck.conclusion}`);
    }
    reason = `quorum NOT met — ${detail.join("; ")} (${missing} more needed; record approvals in ${APPROVALS_RELDIR}/${approvalsFileName(input.specName, input.toEnv)} or land a green proposal PR)`;
  }
  return { satisfied, countedApprovers: [...counted].sort(), prWitness, required, reason };
}

/** The `governance_approval` audit payload for a gate evaluation. Recorded
 *  whether or not the gate was satisfied. */
export type GovernanceApprovalPayload = {
  readonly name: string;
  readonly toEnv: string;
  readonly toVersion: string;
  readonly required: number;
  readonly satisfied: boolean;
  readonly countedApprovers: ReadonlyArray<string>;
  readonly prWitness: boolean;
  readonly prNumber?: number;
  readonly actor?: string;
  readonly ts: number;
};

export function buildGovernancePayload(
  input: ApprovalDecisionInput,
  decision: ApprovalDecision,
  opts: { readonly actor?: string; readonly now: () => number },
): GovernanceApprovalPayload {
  return {
    name: input.specName,
    toEnv: input.toEnv,
    toVersion: input.toVersion,
    required: decision.required,
    satisfied: decision.satisfied,
    countedApprovers: decision.countedApprovers,
    prWitness: decision.prWitness,
    ...(input.prCheck?.prNumber !== undefined ? { prNumber: input.prCheck.prNumber } : {}),
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    ts: opts.now(),
  };
}
