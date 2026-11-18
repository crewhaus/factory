/**
 * The worker's decision held against the local engine's.
 *
 * `decideWorkerToolCall` is new code over `@crewhaus/tool-permission-matcher`'s
 * primitives, since `@crewhaus/permission-engine` cannot run on a worker. This
 * table pins the two together over every combination of tools, modes, rule
 * lists of up to two rules in both orders, inputs and malformed patterns:
 *
 *   1. the worker is never wider: whatever it allows, the local engine allows
 *      in the declared mode and the declared rule order;
 *   2. the worker decides as the local engine decides when deny and ask rules
 *      are listed before allow rules, in the mode the worker reads (`auto` as
 *      `default`), except a plan-mode read-only call no allow covers and a
 *      tool that needs the intent gate, which only the worker refuses;
 *   3. every call the worker refuses and the local engine allows is one of:
 *      an allow listed above a matching deny or ask, mode `auto`, a plan-mode
 *      read-only call no allow covers, or a tool that needs the intent gate.
 *
 * Each class of difference is counted, and each count must be above zero, so
 * a table that stopped reaching one of them fails.
 */
import { describe, expect, test } from "bun:test";
import {
  type PermissionRule,
  type ToolCallContext,
  emptyRuleSet,
  evaluateWithReason,
} from "@crewhaus/permission-engine";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { preparePermissionSubject } from "@crewhaus/tool-executor";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { z } from "zod";
import {
  type WorkerPermissionRule,
  type WorkerPermissions,
  type WorkerToolCall,
  decideWorkerToolCall,
} from "./permissions";

function tool(
  name: string,
  flags: {
    readonly readOnly: boolean;
    readonly destructive?: boolean;
    readonly requiresSandbox?: boolean;
    readonly requireJustification?: boolean;
  },
): RegisteredTool {
  return {
    name,
    description: name,
    inputSchema: z.object({ url: z.string() }),
    execute: async () => "ran",
    concurrencySafe: false,
    readOnly: flags.readOnly,
    destructive: flags.destructive ?? false,
    requiresSandbox: flags.requiresSandbox ?? false,
    classifyOutput: false,
    scope: "external",
    requireJustification: flags.requireJustification ?? false,
    operativeArgs: [{ field: "url", kind: "url" }],
  };
}

const TOOLS = [
  tool("WebFetch", { readOnly: true }),
  tool("Fetch", { readOnly: false }),
  tool("Purge", { readOnly: false, destructive: true }),
  tool("Sandboxed", { readOnly: true, requiresSandbox: true }),
  tool("Justified", { readOnly: false, destructive: true, requireJustification: true }),
];
const MODES: ReadonlyArray<WorkerPermissions["mode"]> = [undefined, "default", "plan", "auto"];
const INPUTS = ["https://a.example/docs/x", "https://b.example/y"];

const RULE_POOL: ReadonlyArray<WorkerPermissionRule> = [
  { type: "alwaysAllow", pattern: "WebFetch" },
  { type: "alwaysDeny", pattern: "WebFetch" },
  { type: "alwaysAsk", pattern: "WebFetch" },
  { type: "alwaysAllow", pattern: "*" },
  { type: "alwaysDeny", pattern: "*" },
  { type: "alwaysAsk", pattern: "*" },
  { type: "alwaysAllow", pattern: "WebFetch(https://a.example/**)" },
  { type: "alwaysDeny", pattern: "WebFetch(https://a.example/**)" },
  { type: "alwaysAsk", pattern: "Fetch(https://b.example/**)" },
  { type: "alwaysAllow", pattern: "Fetch" },
  { type: "alwaysAllow", pattern: "Purge" },
  { type: "alwaysAllow", pattern: "Sandboxed" },
  { type: "alwaysAllow", pattern: "Justified" },
  // Malformed: an unmatched parenthesis does not compile.
  { type: "alwaysAllow", pattern: "WebFetch(" },
  { type: "alwaysDeny", pattern: "Fetch(" },
  { type: "alwaysAsk", pattern: "Purge(" },
];

/** Every list of zero, one or two rules from the pool, each pair in both orders. */
function ruleLists(): ReadonlyArray<ReadonlyArray<WorkerPermissionRule>> {
  const lists: WorkerPermissionRule[][] = [[]];
  for (const a of RULE_POOL) lists.push([a]);
  for (const a of RULE_POOL) for (const b of RULE_POOL) if (a !== b) lists.push([a, b]);
  return lists;
}

const asLocal = (rules: ReadonlyArray<WorkerPermissionRule>): PermissionRule[] =>
  rules.map((rule) => ({ type: rule.type, pattern: rule.pattern, source: "yaml" }));

const denyFirst = (rules: ReadonlyArray<WorkerPermissionRule>): WorkerPermissionRule[] => [
  ...rules.filter((rule) => rule.type !== "alwaysAllow"),
  ...rules.filter((rule) => rule.type === "alwaysAllow"),
];

/** The local decision, with no floors and the spec's rules as the only source. */
function local(
  call: ToolCallContext,
  mode: "default" | "plan" | "auto",
  rules: ReadonlyArray<WorkerPermissionRule>,
): string {
  return evaluateWithReason(call, mode, { ...emptyRuleSet, yaml: asLocal(rules) }, {}).decision;
}

/** Whether `rule` fires on the call, as a rule of its own polarity (a malformed restrict fires). */
function fires(rule: WorkerPermissionRule, call: WorkerToolCall): boolean {
  const restricts = rule.type !== "alwaysAllow";
  try {
    return matchesPattern(compilePattern(rule.pattern), call.toolName, call.input, {
      polarity: restricts ? "restrict" : "allow",
      ...(call.operativeValues !== undefined ? { operativeValues: call.operativeValues } : {}),
    });
  } catch {
    return restricts;
  }
}

/** An allow listed above a deny or ask that both fire on the call. */
function allowAboveGuard(
  rules: ReadonlyArray<WorkerPermissionRule>,
  call: WorkerToolCall,
): boolean {
  return rules.some(
    (upper, i) =>
      upper.type === "alwaysAllow" &&
      fires(upper, call) &&
      rules.slice(i + 1).some((lower) => lower.type !== "alwaysAllow" && fires(lower, call)),
  );
}

describe("the worker's decision against the local engine's", () => {
  test("never wider; equal to deny-first local decisions; every difference has a named cause", () => {
    const counts = {
      cases: 0,
      claim2PlanReadOnly: 0,
      claim2Justification: 0,
      allowAboveGuard: 0,
      auto: 0,
      planReadOnly: 0,
      justification: 0,
    };
    const unexplained: string[] = [];
    for (const t of TOOLS) {
      for (const url of INPUTS) {
        const subject = preparePermissionSubject(t, { url });
        if (!subject.ok) throw new Error(subject.reason);
        const call: WorkerToolCall = {
          toolName: t.name,
          input: subject.input,
          ...(subject.operativeValues !== undefined
            ? { operativeValues: subject.operativeValues }
            : {}),
          readOnly: t.readOnly,
          requiresSandbox: t.requiresSandbox,
          requireJustification: t.requireJustification,
        };
        const localCall: ToolCallContext = {
          toolName: t.name,
          input: subject.input,
          ...(subject.operativeValues !== undefined
            ? { operativeValues: subject.operativeValues }
            : {}),
          readOnly: t.readOnly,
          destructive: t.destructive,
          requiresSandbox: t.requiresSandbox,
        };
        for (const mode of MODES) {
          for (const rules of ruleLists()) {
            counts.cases += 1;
            const edge = decideWorkerToolCall(call, {
              ...(mode !== undefined ? { mode } : {}),
              rules,
            });
            const declared = local(localCall, mode ?? "default", rules);
            const label = `${t.name} ${url} mode=${mode ?? "-"} rules=${JSON.stringify(rules)}`;
            // 1. Never wider.
            if (edge.decision === "allow" && declared !== "allow") {
              unexplained.push(`wider: ${label} edge=allow local=${declared}`);
            }
            // 2. Equal to the deny-first local decision in the mode the worker reads.
            const ordered = local(localCall, edge.mode, denyFirst(rules));
            if (edge.decision !== ordered) {
              if (t.requireJustification) counts.claim2Justification += 1;
              else if (
                edge.mode === "plan" &&
                t.readOnly &&
                edge.decision === "ask" &&
                ordered === "allow"
              ) {
                counts.claim2PlanReadOnly += 1;
              } else {
                unexplained.push(`order: ${label} edge=${edge.decision} local=${ordered}`);
              }
            }
            // 3. Every refusal the local engine would have allowed has a cause.
            if (edge.decision !== "allow" && declared === "allow") {
              const causes = {
                allowAboveGuard: allowAboveGuard(rules, call),
                auto: mode === "auto",
                planReadOnly:
                  mode === "plan" &&
                  t.readOnly &&
                  !rules.some((rule) => rule.type === "alwaysAllow" && fires(rule, call)),
                justification: t.requireJustification,
              };
              for (const [cause, holds] of Object.entries(causes)) {
                if (holds) counts[cause as keyof typeof causes] += 1;
              }
              if (!Object.values(causes).some(Boolean)) {
                unexplained.push(`refused: ${label} edge=${edge.decision} local=allow`);
              }
            }
          }
        }
      }
    }
    expect(unexplained).toEqual([]);
    // The table reached every class it claims to cover.
    expect(counts.cases).toBe(TOOLS.length * INPUTS.length * MODES.length * ruleLists().length);
    expect(counts.claim2PlanReadOnly).toBeGreaterThan(0);
    expect(counts.claim2Justification).toBeGreaterThan(0);
    expect(counts.allowAboveGuard).toBeGreaterThan(0);
    expect(counts.auto).toBeGreaterThan(0);
    expect(counts.planReadOnly).toBeGreaterThan(0);
    expect(counts.justification).toBeGreaterThan(0);
  }, 20_000); // about ten thousand decisions on each engine; slow on a loaded CI runner
});
