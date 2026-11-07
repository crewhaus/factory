/**
 * A run's state as readers see it. Pure: a read only computes what a writer will
 * record later, and bad input answers `failed`, never a throw.
 */
import { type DecisionRecordView, effectiveDecisionState } from "./decisions.js";
import { MACHINES, type RunState } from "./machines.js";

export type EffectiveRunState = {
  readonly state: RunState;
  readonly failureClass?: string;
  readonly continuedIn?: string;
  /** `true` when this is computed, not what the run's rows say. */
  readonly computed: boolean;
};

export type EffectiveRunInput = {
  /** The decision a parked run waits on. */
  readonly decision?: DecisionRecordView;
  /** The run that `continues` this one, when one does. */
  readonly continuation?: {
    readonly id: string;
    readonly state: string;
    readonly failureClass?: string;
  };
  readonly now: number;
};

export type RunStateRecord = {
  readonly state: string;
  readonly failureClass?: string;
  readonly continuedIn?: string;
};

function isTerminal(state: string): boolean {
  return (MACHINES.run.terminal as readonly string[]).includes(state);
}

/**
 * - A terminal row stands.
 * - When run B continues parked run A, A takes B's terminal state with
 *   `continuedIn: B`; while B is still going, A reads as it is and names B.
 * - A waiting run whose decision has effectively expired reads
 *   `failed`/`approval_expired`.
 */
export function effectiveRunState(
  run: RunStateRecord,
  input: EffectiveRunInput,
): EffectiveRunState {
  const state = run?.state;
  if (!(MACHINES.run.states as readonly string[]).includes(state)) {
    return { state: "failed", failureClass: "unreadable_run_record", computed: true };
  }
  const stored: EffectiveRunState = {
    state: state as RunState,
    ...(run.failureClass === undefined ? {} : { failureClass: run.failureClass }),
    ...(run.continuedIn === undefined ? {} : { continuedIn: run.continuedIn }),
    computed: false,
  };
  if (state !== "waiting-for-approval") return stored;

  const continuation = input?.continuation;
  if (continuation !== undefined) {
    if (isTerminal(continuation.state)) {
      return {
        state: continuation.state as RunState,
        ...(continuation.failureClass === undefined
          ? {}
          : { failureClass: continuation.failureClass }),
        continuedIn: continuation.id,
        computed: true,
      };
    }
    return { ...stored, continuedIn: continuation.id };
  }

  const decision = input?.decision;
  if (decision !== undefined) {
    const effective = effectiveDecisionState(decision, undefined, input.now);
    if (effective.state === "expired") {
      return { state: "failed", failureClass: "approval_expired", computed: true };
    }
  }
  return stored;
}
