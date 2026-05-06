/**
 * Catalog R1 `turn-state-machine` — pure finite state machine for one
 * turn cycle of the agent loop. No I/O. The runtime-core orchestrator
 * advances state by feeding events; this module owns the transition
 * rules and rejects invalid (state, event) pairs at runtime.
 *
 * Reference: claude-code/query.ts `State`/`Continue` pattern (loop-local
 * mutable state with explicit transition reasons).
 */
import { CrewhausError } from "@crewhaus/errors";

export type ToolUseBlock = {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

export type CompactionReason = "approaching_limit" | "prompt_too_long";

export type TurnError = {
  readonly name: string;
  readonly message: string;
};

export type TurnState =
  | { readonly kind: "NeedModel" }
  | { readonly kind: "NeedTools"; readonly toolUses: readonly ToolUseBlock[] }
  | { readonly kind: "NeedCompaction"; readonly reason: CompactionReason }
  | { readonly kind: "NeedRecovery"; readonly error: TurnError }
  | { readonly kind: "Done"; readonly reason: "no_tools" | "aborted" };

export type TurnEvent =
  | { readonly kind: "ModelReturnedText" }
  | { readonly kind: "ModelReturnedToolUse"; readonly toolUses: readonly ToolUseBlock[] }
  | { readonly kind: "ToolsExecuted" }
  | { readonly kind: "BudgetExceeded"; readonly reason: CompactionReason }
  | { readonly kind: "CompactionDone" }
  | { readonly kind: "RecoverableError"; readonly error: TurnError }
  | { readonly kind: "RecoveryDone" }
  | { readonly kind: "Aborted" };

export class TurnTransitionError extends CrewhausError {
  override readonly name = "TurnTransitionError";
  constructor(stateKind: TurnState["kind"], eventKind: TurnEvent["kind"]) {
    super("runtime", `invalid transition: ${stateKind} cannot accept event ${eventKind}`);
  }
}

export const initialState: TurnState = { kind: "NeedModel" };

/**
 * Compute the next state. Throws `TurnTransitionError` for any
 * (state, event) pair not in the valid transition table — invalid
 * transitions are programmer errors, not recoverable conditions.
 */
export function transition(state: TurnState, event: TurnEvent): TurnState {
  switch (state.kind) {
    case "NeedModel":
      switch (event.kind) {
        case "ModelReturnedText":
          return { kind: "Done", reason: "no_tools" };
        case "ModelReturnedToolUse":
          return { kind: "NeedTools", toolUses: event.toolUses };
        case "BudgetExceeded":
          return { kind: "NeedCompaction", reason: event.reason };
        case "RecoverableError":
          return { kind: "NeedRecovery", error: event.error };
        case "Aborted":
          return { kind: "Done", reason: "aborted" };
        default:
          throw new TurnTransitionError(state.kind, event.kind);
      }
    case "NeedTools":
      switch (event.kind) {
        case "ToolsExecuted":
          return { kind: "NeedModel" };
        case "Aborted":
          return { kind: "Done", reason: "aborted" };
        default:
          throw new TurnTransitionError(state.kind, event.kind);
      }
    case "NeedCompaction":
      switch (event.kind) {
        case "CompactionDone":
          return { kind: "NeedModel" };
        case "Aborted":
          return { kind: "Done", reason: "aborted" };
        default:
          throw new TurnTransitionError(state.kind, event.kind);
      }
    case "NeedRecovery":
      switch (event.kind) {
        case "RecoveryDone":
          return { kind: "NeedModel" };
        case "Aborted":
          return { kind: "Done", reason: "aborted" };
        default:
          throw new TurnTransitionError(state.kind, event.kind);
      }
    case "Done":
      throw new TurnTransitionError(state.kind, event.kind);
  }
}
