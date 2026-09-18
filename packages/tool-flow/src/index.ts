/**
 * @crewhaus/tool-flow — deterministic control flow.
 *
 * These are the decisions a harness makes constantly and should almost never
 * pay a model to make: which arm to take, whether an error is worth
 * retrying, whether the loop is still moving, whether there is time left,
 * which band a score falls in, whether N answers actually agreed.
 *
 * Every library under `./lib` is pure — the clock is a parameter, never a
 * call — so the same inputs give the same answer in a test, in a replay and
 * in production. Two of the tool wrappers do read the real clock, because
 * their whole job is to know what time it is: `DeadlineCheck` always, and
 * `ErrorClassify` only to resolve a `Retry-After` given as a date. Both take
 * an explicit `now` that overrides it, and that is the only impurity in the
 * package.
 *
 * The condition vocabulary is `@crewhaus/tool-schema`'s: `Branch`,
 * `DecisionTable` and `RuleScore` all evaluate the same `checks` the
 * `Assert` tool does, through the same evaluator. An operator learns one
 * grammar.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { ASSERT_OPS, type Check } from "@crewhaus/tool-schema";
import { z } from "zod";
import { type BranchRule, evaluateBranches } from "./lib/branch";
import { type ConsensusOptions, VOTE_MODES, type Vote, tallyVotes } from "./lib/consensus";
import { checkDeadline } from "./lib/deadline";
import { type DecisionTable, HIT_POLICIES, evaluateTable } from "./lib/decision";
import { ERROR_CLASSES, type ErrorRule, NEXT_ACTIONS, classifyError } from "./lib/errors";
import { type ScoreModel, scoreValue } from "./lib/score";
import { type Snapshot, detectStall } from "./lib/stall";

/** Compact JSON — the reader is a model, and every byte is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Ceilings that keep one pathological table from becoming a hang. */
const LIMITS = {
  checks: 64,
  arms: 64,
  rows: 512,
  rules: 256,
  votes: 512,
  history: 512,
  signals: 64,
} as const;

const checkSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("dotted path into the value, e.g. 'order.items[0].sku'; omit for the value itself"),
  op: z.enum(ASSERT_OPS),
  expected: z.unknown().describe("the operand; its meaning depends on the op"),
  flags: z.string().optional().describe("regex flags for matches/notMatches"),
  message: z.string().optional().describe("replaces the generated reason when this check fails"),
});

const checksField = z.array(checkSchema).min(1).max(LIMITS.checks);
const matchField = z
  .enum(["all", "any"])
  .optional()
  .describe("whether every check must hold, or any one of them; default all");

/**
 * An instant, as epoch milliseconds or an ISO-8601 string.
 *
 * A string without an offset is rejected rather than guessed at. Per
 * ECMAScript, `Date.parse("2026-01-01T00:00:00")` is *local* time while the
 * date-only form is UTC, so the same spec would mean different instants on
 * two machines — the exact class of bug this package exists to remove.
 */
function parseInstant(value: string | number, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${field} is not a finite epoch-millisecond value`);
    return value;
  }
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    throw new Error(
      `${field} ("${text}") has no UTC offset — write it as e.g. 2026-01-01T00:00:00Z, because an offset-less string means local time and would differ between machines`,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`${field} ("${text}") is not a valid ISO-8601 instant`);
  return parsed;
}

const instantField = z.union([z.string(), z.number()]);

// ---------------------------------------------------------------------------

export const branch: RegisteredTool = buildTool({
  name: "Branch",
  description:
    "Take the first arm whose conditions hold, and hand back that arm's name and its declared result. Use it to route on a tool result — exit code, status, a field of a JSON response — without spending a model turn deciding which way to go. Conditions use the same vocabulary as Assert. An arm with no conditions is rejected, because it would silently swallow every later arm; a catch-all is spelled 'otherwise'.",
  inputSchema: z.object({
    value: z.unknown().describe("the value the arms are tested against"),
    arms: z
      .array(
        z.object({
          name: z.string().min(1).describe("what the caller routes on; must be unique"),
          when: checksField,
          match: matchField,
          result: z.unknown().describe("returned verbatim when this arm wins"),
        }),
      )
      .min(1)
      .max(LIMITS.arms),
    otherwise: z
      .object({ name: z.string().min(1), result: z.unknown() })
      .optional()
      .describe("used when no arm matches; without it a miss returns matched:false"),
    verbose: z
      .boolean()
      .optional()
      .describe("include the per-arm report of why earlier arms did not match"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const outcome = evaluateBranches(input.value, input.arms as ReadonlyArray<BranchRule>, {
      otherwise: input.otherwise,
    });
    const body = {
      matched: outcome.matched,
      name: outcome.name,
      index: outcome.index,
      fallback: outcome.fallback,
      result: outcome.result,
      ...(input.verbose ? { evaluated: outcome.evaluated } : {}),
    };
    return json(body);
  },
});

export const decisionTable: RegisteredTool = buildTool({
  name: "DecisionTable",
  description:
    "Answer an operator's policy table — severity by tier to priority and owner, error class by attempt to action — returning the matched row ids, the outputs, and a digest of the table that produced them. Four hit policies: first match, exactly one match, highest priority, or collect them all. Use it to keep a policy in versioned data instead of in a prompt, and to get an audit trail for free.",
  inputSchema: z.object({
    value: z.unknown().describe("the value the rows are tested against"),
    policy: z.enum(HIT_POLICIES).describe("first | unique | priority | collect"),
    version: z.string().optional().describe("echoed into the answer, so it is attributable"),
    rows: z
      .array(
        z.object({
          id: z.string().min(1).describe("the audit trail; must be unique"),
          when: checksField,
          match: matchField,
          priority: z.number().optional().describe("used by the priority policy; higher wins"),
          outputs: z.record(z.unknown()).describe("what this row decides"),
        }),
      )
      .min(1)
      .max(LIMITS.rows),
    otherwise: z.record(z.unknown()).optional().describe("outputs when no row matches"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => json(evaluateTable(input.value, input as unknown as DecisionTable)),
});

export const errorClassify: RegisteredTool = buildTool({
  name: "ErrorClassify",
  description: `Turn an error's signals — HTTP status, exit code, signal, errno or provider code, message text, Retry-After — into one of ${ERROR_CLASSES.length} stable classes and one of ${NEXT_ACTIONS.length} next actions, with the wait the server itself asked for. Use it instead of asking a model whether something is worth retrying: a 429 with Retry-After is not a judgement call, and neither is exit 127. Attempt and maxAttempts downgrade a retry to an escalation once the attempts run out.`,
  inputSchema: z.object({
    status: z.number().int().optional().describe("HTTP status code"),
    exitCode: z.number().int().optional().describe("process exit code; 128+N is read as signal N"),
    signal: z.string().optional().describe("POSIX signal name, e.g. SIGKILL"),
    code: z
      .string()
      .optional()
      .describe("errno (ECONNRESET) or provider code (insufficient_quota)"),
    message: z.string().optional().describe("the error message, or the tail of stderr"),
    retryAfter: z
      .string()
      .optional()
      .describe("the raw Retry-After header: seconds or an HTTP-date"),
    attempt: z.number().int().positive().optional().describe("1-based attempt number"),
    maxAttempts: z.number().int().positive().optional(),
    now: instantField
      .optional()
      .describe("reference instant for a date-form Retry-After; defaults to the real clock"),
    rules: z
      .array(
        z.object({
          id: z.string().min(1),
          contains: z.string().optional().describe("case-insensitive substring of message or code"),
          matches: z.string().optional().describe("regex source, matched case-insensitively"),
          status: z.number().int().optional(),
          exitCode: z.number().int().optional(),
          class: z.enum(ERROR_CLASSES),
          action: z.enum(NEXT_ACTIONS),
          waitMs: z.number().int().nonnegative().optional(),
        }),
      )
      .max(LIMITS.rules)
      .optional()
      .describe("caller rules, tried in order before every builtin pack"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const nowMs = input.now === undefined ? Date.now() : parseInstant(input.now, "now");
    return json(
      classifyError(input, { rules: input.rules as ReadonlyArray<ErrorRule> | undefined, nowMs }),
    );
  },
});

export const deadlineCheck: RegisteredTool = buildTool({
  name: "DeadlineCheck",
  description:
    "Report how much of a time budget is left, as milliseconds, a fraction, and a phase (ample, tight, critical, expired) a branch can switch on — and, given the cost of one more step, whether that step still fits. Use it because a model does not know what time it is: this is the authoritative clock for 'stop polling', 'skip the optional enrichment', 'take the fast path'.",
  inputSchema: z
    .object({
      deadline: instantField.optional().describe("absolute end, ISO-8601 with offset or epoch ms"),
      budgetMs: z.number().int().nonnegative().optional().describe("duration from startedAt"),
      startedAt: instantField.optional().describe("when the budget started; defaults to now"),
      now: instantField.optional().describe("overrides the real clock, for tests and replays"),
      stepCostMs: z.number().int().positive().optional().describe("cost of one more unit of work"),
      tightAt: z.number().min(0).max(1).optional().describe("fraction at or below which: tight"),
      criticalAt: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("...and critical; must be <= tightAt"),
    })
    .refine((v) => v.deadline !== undefined || v.budgetMs !== undefined, {
      message: "give either deadline or budgetMs",
    }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const nowMs = input.now === undefined ? Date.now() : parseInstant(input.now, "now");
    return json(
      checkDeadline({
        nowMs,
        deadlineMs:
          input.deadline === undefined ? undefined : parseInstant(input.deadline, "deadline"),
        budgetMs: input.budgetMs,
        startedAtMs:
          input.startedAt === undefined ? undefined : parseInstant(input.startedAt, "startedAt"),
        stepCostMs: input.stepCostMs,
        tightAt: input.tightAt,
        criticalAt: input.criticalAt,
      }),
    );
  },
});

export const consensusVote: RegisteredTool = buildTool({
  name: "ConsensusVote",
  description:
    "Settle several answers into one by weighted plurality, and report how much they actually agreed. Compares exactly, numerically within a tolerance, or as sets by Jaccard overlap, after optional normalization. Use it to decide when N crew members or N samples agree enough to act, and when the disagreement means a judge or a human should look — the agreement fraction and the dissenters are the output that matters, not just the winner.",
  inputSchema: z.object({
    votes: z
      .array(
        z.object({
          value: z.unknown().describe("the answer cast"),
          weight: z.number().nonnegative().optional().describe("default 1"),
          voter: z.string().optional().describe("named in the dissent report"),
        }),
      )
      .min(1)
      .max(LIMITS.votes),
    mode: z.enum(VOTE_MODES).optional().describe("exact | numeric | set; default exact"),
    tolerance: z.number().nonnegative().optional().describe("numeric mode: absolute distance"),
    overlap: z.number().min(0).max(1).optional().describe("set mode: minimum Jaccard similarity"),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("support needed to be decided; default 0.5"),
    normalize: z
      .object({
        trim: z.boolean().optional().describe("default true"),
        lowercase: z.boolean().optional(),
        collapseWhitespace: z.boolean().optional(),
        stripPunctuation: z.boolean().optional(),
      })
      .optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(tallyVotes(input.votes as ReadonlyArray<Vote>, input as ConsensusOptions)),
});

export const stallDetect: RegisteredTool = buildTool({
  name: "StallDetect",
  description:
    "Given the last N turns of named progress signals — a failing-test fingerprint, a workspace diff hash, the last error, the tool call being made — say whether the loop is still moving, repeating itself, or oscillating between states. Use it to stop a fix-test-fail loop that has stopped making progress, which from inside any single turn is indistinguishable from one about to succeed. Also names the signals that have never changed.",
  inputSchema: z.object({
    history: z
      .array(z.record(z.string()))
      .min(1)
      .max(LIMITS.history)
      .describe("oldest first; each entry maps signal name to an opaque fingerprint"),
    window: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe("identical snapshots to call it stalled; default 3"),
    maxCycle: z
      .number()
      .int()
      .positive()
      .max(16)
      .optional()
      .describe("longest cycle to look for; default 3"),
    signals: z
      .array(z.string())
      .max(LIMITS.signals)
      .optional()
      .describe("consider only these signals"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    json(
      detectStall(input.history as ReadonlyArray<Snapshot>, {
        window: input.window,
        maxCycle: input.maxCycle,
        signals: input.signals,
      }),
    ),
});

export const ruleScore: RegisteredTool = buildTool({
  name: "RuleScore",
  description:
    "Score a record against versioned additive rules and report the band it lands in, together with every rule that fired and what it contributed. Use it for lead qualification, risk, or triage priority: unlike a score a model produced, this one can be explained to the person it affects, re-run identically next quarter, and attributed to a rule version.",
  inputSchema: z.object({
    value: z.unknown().describe("the record being scored"),
    version: z.string().optional().describe("echoed into the result, so a change is attributable"),
    rules: z
      .array(
        z.object({
          id: z.string().min(1),
          when: checksField,
          points: z.number().describe("may be negative"),
          label: z.string().optional().describe("the reason that goes on the record"),
        }),
      )
      .min(1)
      .max(LIMITS.rules),
    bands: z
      .array(z.object({ name: z.string().min(1), min: z.number() }))
      .max(LIMITS.rules)
      .optional()
      .describe("highest band whose min is met wins, whatever order they are declared in"),
    min: z.number().optional().describe("clamp the total"),
    max: z.number().optional(),
    includeMissed: z.boolean().optional().describe("also list the rules that did not fire"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const result = scoreValue(input.value, input as unknown as ScoreModel);
    if (input.includeMissed) return json(result);
    const { missed: _missed, ...rest } = result;
    return json(rest);
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const FLOW_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  branch,
  consensusVote,
  deadlineCheck,
  decisionTable,
  errorClassify,
  ruleScore,
  stallDetect,
]);

export type { Check };
