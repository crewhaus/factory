/**
 * @crewhaus/worker-runtime — the permission decision made before every tool
 * call on a worker.
 *
 * A Cloudflare Worker has nobody to ask: no terminal, no approvals store and
 * no operator watching the run. So a tool runs there only when an
 * `alwaysAllow` rule covers the call. Every other call is refused, with a
 * reason that names the tool and the rule type and never the rule's pattern,
 * since the reason reaches the caller in the tool result and the trace.
 *
 * The rules are the spec's `permissions.rules` and nothing else: a worker has
 * no settings file, flag or hook source, and no builtin allows. Each rule is
 * matched as `@crewhaus/permission-engine` matches it, with
 * `@crewhaus/tool-permission-matcher`'s `compilePattern` and
 * `matchesPattern`: an allow needs every operative value of the call to match
 * its argument glob, a deny or an ask fires when any one does, and a pattern
 * that does not compile counts as a match for a deny or an ask and is skipped
 * for an allow. The order:
 *
 *   1. `mode: plan` is plan mode; every other mode, and none, is default
 *      (`auto` reads as `default`).
 *   2. A tool that needs a sandbox is denied: a worker has none.
 *   3. The first `alwaysDeny` or `alwaysAsk` rule, in declared order, that
 *      matches decides: a deny denies, and an ask asks, or denies in plan
 *      mode.
 *   4. In plan mode a tool that is not read-only is denied.
 *   5. A tool that needs the intent gate is denied: a worker runs none.
 *   6. The first `alwaysAllow` rule, in declared order, that matches allows.
 *   7. Any other call asks.
 *
 * Deny and ask rules are read before allow rules, so a matching deny or ask
 * wins over any allow, wherever each is listed. Pure and node-free.
 */
import {
  type CompiledPattern,
  type OperativeValue,
  compilePattern,
  matchesPattern,
} from "@crewhaus/tool-permission-matcher";

/** One rule, as the spec's `permissions.rules` declares it. */
export type WorkerPermissionRule = {
  readonly type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk";
  readonly pattern: string;
};

/** The spec's `permissions` block, as a worker reads it. */
export type WorkerPermissions = {
  readonly mode?: "default" | "plan" | "auto";
  readonly rules: ReadonlyArray<WorkerPermissionRule>;
};

/**
 * The decision for one call, with the mode it was made in (`auto` reads as
 * `default`). Only `allow` runs the tool; `deny` and `ask` are refused, since
 * a worker has nobody to give an approval. `reason` is set on every refusal.
 */
export type WorkerToolDecision = {
  readonly decision: "allow" | "deny" | "ask";
  readonly mode: "default" | "plan";
  readonly reason?: string;
};

/** The call a decision is made for: the tool's flags and its schema-parsed input. */
export type WorkerToolCall = {
  readonly toolName: string;
  /** The input as the tool's schema parsed it: what the tool would run on. */
  readonly input: unknown;
  /** The canonical values of the tool's `operativeArgs`; absent when it declares none. */
  readonly operativeValues?: ReadonlyArray<OperativeValue>;
  readonly readOnly: boolean;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
};

/** Each rule's compiled pattern, or `null` for one that does not compile. */
const compiled = new WeakMap<WorkerPermissionRule, CompiledPattern | null>();

function compiledPattern(rule: WorkerPermissionRule): CompiledPattern | null {
  const known = compiled.get(rule);
  if (known !== undefined) return known;
  let pattern: CompiledPattern | null;
  try {
    pattern = compilePattern(rule.pattern);
  } catch {
    pattern = null;
  }
  compiled.set(rule, pattern);
  return pattern;
}

/**
 * Whether `rule` matches `call`, with the rule's own polarity. A pattern that
 * does not compile, or a match that throws, is a match for a deny or an ask
 * and no match for an allow: a broken guard still guards, and a broken grant
 * grants nothing.
 */
function ruleMatches(rule: WorkerPermissionRule, call: WorkerToolCall): boolean {
  const restricts = rule.type !== "alwaysAllow";
  const pattern = compiledPattern(rule);
  if (pattern === null) return restricts;
  try {
    return matchesPattern(pattern, call.toolName, call.input, {
      polarity: restricts ? "restrict" : "allow",
      ...(call.operativeValues !== undefined ? { operativeValues: call.operativeValues } : {}),
    });
  } catch {
    return restricts;
  }
}

/** Decide one tool call on a worker. Pure; see the module docblock for the order. */
export function decideWorkerToolCall(
  call: WorkerToolCall,
  permissions: WorkerPermissions,
): WorkerToolDecision {
  const mode = permissions.mode === "plan" ? "plan" : "default";
  const tool = `\`${call.toolName}\``;
  if (call.requiresSandbox) {
    return { decision: "deny", mode, reason: `${tool} needs a sandbox, and a worker has none` };
  }
  const guard = permissions.rules.find(
    (rule) => rule.type !== "alwaysAllow" && ruleMatches(rule, call),
  );
  if (guard?.type === "alwaysDeny") {
    return {
      decision: "deny",
      mode,
      reason: `an alwaysDeny rule in this worker's permissions denies ${tool}`,
    };
  }
  if (guard !== undefined) {
    return {
      decision: mode === "plan" ? "deny" : "ask",
      mode,
      reason: `an alwaysAsk rule needs a person to approve ${tool}, and this worker has nobody to give that approval`,
    };
  }
  if (mode === "plan" && !call.readOnly) {
    return {
      decision: "deny",
      mode,
      reason: `plan mode runs only read-only tools, and ${tool} is not read-only`,
    };
  }
  if (call.requireJustification) {
    return {
      decision: "deny",
      mode,
      reason: `${tool} needs the intent gate, which a worker does not run`,
    };
  }
  if (permissions.rules.some((rule) => rule.type === "alwaysAllow" && ruleMatches(rule, call))) {
    return { decision: "allow", mode };
  }
  return {
    decision: "ask",
    mode,
    reason: `${tool} needs approval, and this worker has nobody to give it. A tool runs on a worker only when an alwaysAllow rule covers the call: add { type: alwaysAllow, pattern: ${call.toolName} } to permissions.rules`,
  };
}
