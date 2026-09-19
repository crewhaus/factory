/**
 * Plan a declared sequence of steps. Nothing here runs one.
 *
 * A sequence is the other half of {@link ./branch}: a branch answers "which
 * way", a sequence answers "what next, and what is it still waiting on". The
 * answer is a plan — the steps whose prerequisites are met, whose gate time
 * has passed and whose conditions hold, each carrying the parameters the
 * caller should execute it with.
 *
 * It stops there on purpose. Invoking a tool needs the executor, which no
 * tool package has, and a "runner" that quietly returned the steps it would
 * have run is the shape of lie a caller only discovers in production. So
 * this returns the plan and the caller — or the harness, which does have the
 * executor — acts on it.
 *
 * Progress is an argument, not a memory. `completed` and `failed` come in
 * the way {@link ./stall} takes its history, so the same inputs give the
 * same plan in a test, in a replay and in production.
 *
 * Three distinctions carry the weight here, and each one is a different
 * answer a caller has to be able to tell apart:
 *
 * - **waiting** — a prerequisite has not run yet, or the step is not due
 *   yet. It can still happen.
 * - **unreachable** — a prerequisite failed or was skipped, so this step can
 *   never happen. Reporting that as "waiting" is how a flow hangs forever on
 *   a step that died three turns ago.
 * - **skipped** — the step's own conditions did not hold. A settled no.
 */
import { type Check, runChecks } from "@crewhaus/tool-schema";
import type { MatchMode } from "./branch";

/**
 * Where a flow stands.
 *
 * `finished` and `halted` are kept apart on purpose. Both mean there is
 * nothing left to run, and a caller that reads one boolean for both reports
 * a cadence that died on its second step as a cadence that completed.
 */
export const PLAN_STATES = ["ready", "blocked", "finished", "halted"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export type SequenceStep = {
  readonly id: string;
  /**
   * The step's own gate. Optional, unlike a branch arm's: arms are
   * alternatives, so a condition-less arm swallows the ones after it, while
   * sequence steps are not alternatives and an unconditional step is the
   * ordinary case. An explicitly empty list is still rejected, because it
   * says "gated" and means nothing.
   */
  readonly when?: ReadonlyArray<Check>;
  readonly match?: MatchMode;
  /** Ids that must be completed first. */
  readonly needs?: ReadonlyArray<string>;
  /** Handed back verbatim in the plan. Any JSON value. */
  readonly params?: unknown;
  /** Not due before this instant, as epoch ms. */
  readonly afterMs?: number;
};

export type SequenceSpec = {
  /** Echoed into the plan, so a change of flow is attributable. */
  readonly version?: string;
  readonly steps: ReadonlyArray<SequenceStep>;
};

export type SequenceState = {
  readonly nowMs: number;
  readonly completed?: ReadonlyArray<string>;
  readonly failed?: ReadonlyArray<string>;
};

/** A step the caller should execute now. */
export type PlannedStep = {
  readonly id: string;
  /** Position in the declared steps. */
  readonly index: number;
  readonly params?: unknown;
};

/** A step that is not in the plan, and why. */
export type HeldStep = {
  readonly id: string;
  readonly reason: string;
  /** Only on a step held by its `after` gate: how long until it is due. */
  readonly dueInMs?: number;
};

export type SequencePlan = {
  /** Where the flow stands, as a label a branch can switch on. */
  readonly state: PlanState;
  /** The plan, in declared order. Executing these is the caller's job. */
  readonly ready: ReadonlyArray<PlannedStep>;
  /** `ready[0]`, for the caller that only wants the next one. */
  readonly next: PlannedStep | null;
  readonly waiting: ReadonlyArray<HeldStep>;
  readonly unreachable: ReadonlyArray<HeldStep>;
  readonly skipped: ReadonlyArray<HeldStep>;
  readonly completed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly version: string | null;
  readonly total: number;
};

type StepState = "done" | "failed" | "ready" | "waiting" | "unreachable" | "skipped";

/**
 * Work out what to run next.
 *
 * Structural problems throw rather than being reported, the way a duplicate
 * row id does elsewhere in this package: a cycle, a `needs` naming a step
 * that does not exist, or progress naming a step that does not exist are all
 * bugs in the spec or in the caller's bookkeeping, not answers about this
 * particular record. In particular an unknown id in `completed` — a typo, or
 * a leftover from an older revision of the flow — would silently re-run a
 * step the caller believes is finished.
 */
export function planSequence(
  value: unknown,
  spec: SequenceSpec,
  state: SequenceState,
): SequencePlan {
  const steps = spec.steps;
  if (steps.length === 0) throw new Error("the sequence has no steps");

  const byId = new Map<string, SequenceStep>();
  for (const step of steps) {
    if (step.when && step.when.length === 0) {
      throw new Error(
        `step "${step.id}" has an empty condition list — omit "when" for a step that is always due`,
      );
    }
    if (byId.has(step.id)) throw new Error(`two steps share the id "${step.id}"`);
    byId.set(step.id, step);
  }
  for (const step of steps) {
    for (const need of step.needs ?? []) {
      if (need === step.id) throw new Error(`step "${step.id}" needs itself`);
      if (!byId.has(need)) {
        throw new Error(`step "${step.id}" needs "${need}", which is not a step in this sequence`);
      }
    }
  }

  const completed = new Set(state.completed ?? []);
  const failed = new Set(state.failed ?? []);
  for (const [label, ids] of [
    ["completed", completed],
    ["failed", failed],
  ] as const) {
    for (const id of ids) {
      if (!byId.has(id)) {
        throw new Error(`${label} names "${id}", which is not a step in this sequence`);
      }
    }
  }
  for (const id of completed) {
    if (failed.has(id)) throw new Error(`step "${id}" is listed as both completed and failed`);
  }

  // Kahn's algorithm, which both orders the walk and finds the cycle. Every
  // step's prerequisites are decided before the step itself, so a chain of
  // unreachability propagates in one pass instead of needing a fixpoint.
  const order = topologicalOrder(steps, byId);

  const states = new Map<string, StepState>();
  const reasons = new Map<string, HeldStep>();

  for (const step of order) {
    if (failed.has(step.id)) {
      states.set(step.id, "failed");
      continue;
    }
    if (completed.has(step.id)) {
      states.set(step.id, "done");
      continue;
    }

    const dead = (step.needs ?? []).find((need) => {
      const s = states.get(need);
      return s === "failed" || s === "skipped" || s === "unreachable";
    });
    if (dead !== undefined) {
      states.set(step.id, "unreachable");
      reasons.set(step.id, {
        id: step.id,
        reason: `needs "${dead}", which is ${states.get(dead)}`,
      });
      continue;
    }
    const pending = (step.needs ?? []).find((need) => states.get(need) !== "done");
    if (pending !== undefined) {
      states.set(step.id, "waiting");
      reasons.set(step.id, { id: step.id, reason: `needs "${pending}", which has not run` });
      continue;
    }

    // The `after` gate is read before the step's own conditions, and the
    // conditions are read only once the prerequisites are done. Both orders
    // are deliberate: a gate usually reads something an earlier step
    // produced, so evaluating it out of turn would report a settled `skipped`
    // about a context that does not exist yet.
    if (step.afterMs !== undefined && step.afterMs > state.nowMs) {
      states.set(step.id, "waiting");
      reasons.set(step.id, {
        id: step.id,
        reason: `not due until ${new Date(step.afterMs).toISOString()}`,
        dueInMs: step.afterMs - state.nowMs,
      });
      continue;
    }

    // The shared evaluator reports a check it could not evaluate — a regex
    // that will not compile, a malformed path — as a check that did not hold,
    // with the reason as its text and no flag to tell the two apart. That is
    // `Branch` and `RuleScore`'s behaviour too, and inventing a different one
    // here would mean two answers to the same question. It bites harder in a
    // sequence, because the skip cascades into `unreachable` dependents, so
    // the reason travels with every one of them.
    if (step.when && step.when.length > 0) {
      const report = runChecks(value, step.when as Check[]);
      const holds = (step.match ?? "all") === "all" ? report.ok : report.passed > 0;
      if (!holds) {
        states.set(step.id, "skipped");
        reasons.set(step.id, {
          id: step.id,
          reason: report.failures[0]?.reason ?? "no condition held",
        });
        continue;
      }
    }

    states.set(step.id, "ready");
  }

  // Emitted in declared order, not in the topological order the walk used:
  // the caller wrote the sequence down in the order they think about it, and
  // a plan that came back reshuffled would read as a reordering.
  const ready: PlannedStep[] = [];
  const waiting: HeldStep[] = [];
  const unreachable: HeldStep[] = [];
  const skipped: HeldStep[] = [];
  const doneIds: string[] = [];
  const failedIds: string[] = [];

  for (const [index, step] of steps.entries()) {
    const held = reasons.get(step.id) ?? { id: step.id, reason: "" };
    switch (states.get(step.id)) {
      case "ready":
        ready.push(
          step.params === undefined
            ? { id: step.id, index }
            : { id: step.id, index, params: step.params },
        );
        break;
      case "waiting":
        waiting.push(held);
        break;
      case "unreachable":
        unreachable.push(held);
        break;
      case "skipped":
        skipped.push(held);
        break;
      case "done":
        doneIds.push(step.id);
        break;
      case "failed":
        failedIds.push(step.id);
        break;
    }
  }

  const planState: PlanState =
    ready.length > 0
      ? "ready"
      : waiting.length > 0
        ? "blocked"
        : failedIds.length > 0 || unreachable.length > 0
          ? "halted"
          : "finished";

  return {
    state: planState,
    ready,
    next: ready[0] ?? null,
    waiting,
    unreachable,
    skipped,
    completed: doneIds,
    failed: failedIds,
    version: spec.version ?? null,
    total: steps.length,
  };
}

/** Steps ordered so that every step follows the steps it needs. */
function topologicalOrder(
  steps: ReadonlyArray<SequenceStep>,
  byId: ReadonlyMap<string, SequenceStep>,
): SequenceStep[] {
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of steps) {
    const needs = new Set(step.needs ?? []);
    remaining.set(step.id, needs.size);
    for (const need of needs) {
      const list = dependents.get(need);
      if (list) list.push(step.id);
      else dependents.set(need, [step.id]);
    }
  }

  // Seeded in declared order so the walk is stable, though only the
  // dependency order it guarantees is relied on downstream.
  const queue = steps.filter((s) => remaining.get(s.id) === 0).map((s) => s.id);
  const ordered: SequenceStep[] = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    ordered.push(byId.get(id) as SequenceStep);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (remaining.get(dependent) as number) - 1;
      remaining.set(dependent, left);
      if (left === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== steps.length) {
    const stuck = steps.filter((s) => !ordered.includes(s)).map((s) => `"${s.id}"`);
    throw new Error(`steps ${stuck.join(", ")} depend on each other in a cycle`);
  }
  return ordered;
}
