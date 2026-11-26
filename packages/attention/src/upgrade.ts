/**
 * A saved read model of an earlier shape, brought to this one in memory. The projector
 * keeps a model's state as it was saved and never looks at its version, so the fold does:
 * what people did about items starts empty (their ledger is read from its start, since the
 * saved position does not hold it), and every fact kept from before is held to the same
 * grammars a fresh read holds it to. Pure.
 */
import { closedApprovalFact } from "./adapters/approvals";
import { closedDecisionFact } from "./adapters/decisions";
import { closedRunFact } from "./adapters/runs";
import type { AttentionModel } from "./types";

/** The model with every part this shape has; itself when it already is one. */
export function upgraded(state: AttentionModel): AttentionModel {
  if (state.v === 2 && state.overlays !== undefined && state.checkpoints !== undefined) {
    return state;
  }
  const decisions: AttentionModel["decisions"] = {};
  for (const fact of Object.values(state.decisions ?? {})) {
    const closed = closedDecisionFact(fact);
    if (closed !== undefined) decisions[closed.id] = closed;
  }
  const runs: AttentionModel["runs"] = {};
  for (const fact of Object.values(state.runs ?? {})) {
    const closed = closedRunFact(fact);
    if (closed !== undefined) runs[closed.id] = closed;
  }
  return {
    ...state,
    v: 2,
    decisions,
    runs,
    approvals: {
      ...state.approvals,
      facts: state.approvals.facts.flatMap((fact) => {
        const closed = closedApprovalFact(fact);
        return closed === undefined ? [] : [closed];
      }),
    },
    checkpoints: state.checkpoints ?? { stamp: "", facts: [] },
    overlays: state.overlays ?? {},
  };
}
