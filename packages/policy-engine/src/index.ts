/**
 * Catalog R8 `policy-engine` — side-effect classification + audit hooks.
 *
 * Composes with `permission-engine` (Section 7): permission grants
 * "should this user be allowed to invoke this tool?" and policy grants
 * "should the platform allow this side-effect class right now?". The
 * gateway runs permission first, then policy; both must `allow` (or
 * `audit-and-allow`) for the call to proceed.
 *
 * Side-effect classes:
 *   "none"        — pure compute (e.g. ReadImage decoded in-process)
 *   "filesystem"  — reads/writes inside the workspace
 *   "network"     — makes external HTTP / SMTP / DNS calls
 *   "external"    — any other observable side effect (default for
 *                   tools without explicit flag — fail-closed)
 *   "messaging"   — posts to a chat / email / external user surface
 *
 * Decision shape:
 *   "allow"           — proceed
 *   "audit-and-allow" — proceed AND emit an audit-log record
 *   "deny"            — refuse with reason
 *
 * Layer R8. Pairs with `permission-engine` (R8) and `audit-log` (R17).
 */

import type { AppendInput, AuditLog } from "@crewhaus/audit-log";
import { CrewhausError } from "@crewhaus/errors";

export type SideEffect = "none" | "filesystem" | "network" | "external" | "messaging";

export type PolicyDecision = "allow" | "audit-and-allow" | "deny";

export type PolicyMode = "permissive" | "audit" | "strict";

export type PolicyRule = {
  /** Glob over tool name; "*" matches every tool. */
  readonly toolPattern: string;
  /** Side-effect classes the rule applies to; ["*"] for any. */
  readonly sideEffects: ReadonlyArray<SideEffect | "*">;
  readonly action: PolicyDecision;
  /** Free-text reason returned to the gateway. */
  readonly reason?: string;
};

export type ToolCallContext = {
  readonly toolName: string;
  /**
   * The runtime infers `sideEffect` from the tool's flags:
   *   readOnly + filesystem-only path     → "filesystem"
   *   makes outbound network calls         → "network"
   *   posts user-visible messages          → "messaging"
   *   pure in-process compute              → "none"
   *   anything else / unset                → "external"
   *
   * The gateway forwards this hint via the call site; tools that
   * declare `sideEffect` explicitly override the heuristic.
   */
  readonly sideEffect?: SideEffect;
  readonly input: unknown;
  readonly tenantId?: string;
};

export type EvaluatePolicyResult = {
  readonly decision: PolicyDecision;
  readonly reason?: string;
  readonly matchedRule?: number;
};

export class PolicyEngineError extends CrewhausError {
  override readonly name = "PolicyEngineError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const DEFAULT_RULES: ReadonlyArray<PolicyRule> = [
  // Allow read-only / pure compute everywhere.
  { toolPattern: "*", sideEffects: ["none"], action: "allow" },
  // Audit filesystem reads — they're the easy data-leak vector.
  {
    toolPattern: "*",
    sideEffects: ["filesystem"],
    action: "audit-and-allow",
    reason: "filesystem side-effect",
  },
  // Audit network calls — same reasoning.
  {
    toolPattern: "*",
    sideEffects: ["network"],
    action: "audit-and-allow",
    reason: "network side-effect",
  },
  {
    toolPattern: "*",
    sideEffects: ["messaging"],
    action: "audit-and-allow",
    reason: "messaging side-effect",
  },
  // Default for unclassified ("external") — deny in strict, audit elsewhere.
  // This rule is only consulted in strict mode (we apply mode-specific
  // overrides below). Keeping it last ensures explicit rules take precedence.
  {
    toolPattern: "*",
    sideEffects: ["external"],
    action: "audit-and-allow",
    reason: "external side-effect",
  },
];

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;
  // Prefix wildcard: "Bash*" → starts with "Bash".
  if (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

function ruleMatches(rule: PolicyRule, toolName: string, effect: SideEffect): boolean {
  if (!patternMatches(rule.toolPattern, toolName)) return false;
  for (const e of rule.sideEffects) {
    if (e === "*" || e === effect) return true;
  }
  return false;
}

function applyMode(decision: PolicyDecision, mode: PolicyMode): PolicyDecision {
  if (mode === "permissive" && decision === "deny") return "audit-and-allow";
  if (mode === "strict" && decision === "audit-and-allow") return "deny";
  return decision;
}

export type EvaluatePolicyOptions = {
  readonly mode?: PolicyMode;
  readonly rules?: ReadonlyArray<PolicyRule>;
  readonly tenantPolicy?: ReadonlyArray<PolicyRule>;
};

/**
 * Decide policy for one tool call. Pure with respect to `call`,
 * `mode`, and the rules. The `audit-and-allow` decision SHOULD be
 * paired with `auditPolicyDecision(...)` to actually write the
 * record — keeping I/O out of the pure decider keeps tests trivial.
 */
export function evaluatePolicy(
  call: ToolCallContext,
  opts: EvaluatePolicyOptions = {},
): EvaluatePolicyResult {
  const mode = opts.mode ?? "audit";
  // Section 18 fail-closed default: tools without a sideEffect declaration
  // are treated as "external" (the most-restrictive default class).
  const effect: SideEffect = call.sideEffect ?? "external";

  // Tenant rules win over global rules.
  const ruleSets: ReadonlyArray<ReadonlyArray<PolicyRule>> = [
    opts.tenantPolicy ?? [],
    opts.rules ?? DEFAULT_RULES,
  ];
  let idx = 0;
  for (const set of ruleSets) {
    for (const rule of set) {
      if (ruleMatches(rule, call.toolName, effect)) {
        const decision = applyMode(rule.action, mode);
        return {
          decision,
          ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
          matchedRule: idx,
        };
      }
      idx += 1;
    }
  }
  // Fail-closed: no rule matched.
  return {
    decision: applyMode("deny", mode),
    reason: `no policy rule matched ${call.toolName} (sideEffect=${effect})`,
  };
}

/**
 * Append a `policy_decision` audit record. Callers should invoke this
 * AFTER `evaluatePolicy` whenever the decision is `audit-and-allow` or
 * `deny`. `allow` outcomes don't generate an audit row by default to
 * keep the chain readable; pass `auditAll: true` to override.
 */
export async function auditPolicyDecision(
  log: AuditLog,
  call: ToolCallContext,
  result: EvaluatePolicyResult,
  opts: { readonly auditAll?: boolean } = {},
): Promise<void> {
  if (result.decision === "allow" && opts.auditAll !== true) return;
  const payload: AppendInput["payload"] = {
    toolName: call.toolName,
    sideEffect: call.sideEffect ?? "external",
    decision: result.decision,
    reason: result.reason,
    tenantId: call.tenantId,
    matchedRule: result.matchedRule,
  };
  await log.append({ kind: "policy_decision", payload });
}

export const DEFAULT_POLICY_RULES = DEFAULT_RULES;
