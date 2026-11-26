/**
 * `@crewhaus/attention/act`: what a person does about an inbox item, whichever surface asks
 * (#517, #513, module brief 331). Each act is planned by reading only and then carried out
 * by the source's own sanctioned writer, and recorded once on the harness's actions ledger,
 * which is also what its event stream sends. A head lends it the decision service and its
 * own writers ({@link ActDeps}). `@crewhaus/attention` itself stays read-only.
 */
export { classReached } from "./checks";
export {
  ADVISOR_LEDGER_REL,
  type ActionLine,
  type AdvisorLedgerLine,
  appendAction,
  appendAdvisorDecision,
} from "./ledger";
export {
  acknowledgeItem,
  assignItem,
  deferItem,
  dismissItem,
  planAcknowledge,
  planAssign,
  planDefer,
  planDismiss,
  planReopen,
  planSnooze,
  planUnassign,
  planUndefer,
  reopenItem,
  snoozeItem,
  unassignItem,
  undeferItem,
} from "./overlay-acts";
export { type ResolveItemRequest, planResolve, resolveItem } from "./resolve";
export { THREADS_REL, type Thread, addMessage, listMessages, planMessage } from "./threads";
export type {
  ActAnswer,
  ActDeps,
  ActDone,
  ActPlan,
  ActRefusal,
  ActRequest,
  ReviewAnswer,
  StartAnswer,
} from "./types";
