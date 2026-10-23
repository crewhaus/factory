/**
 * @crewhaus/evaluation-service — the composition root for in-loop gates
 * (design/0.8.0-provability-release.md §4.4).
 *
 * `wireEvaluation(fragment, deps)` builds the `evaluation:` judge, the
 * `provability:` gate and the proof tools from the lowered IR; every emitter
 * renders one call to it (`renderEvaluationWiring`) and the `crewhaus run` /
 * `serve` interpreter calls it directly, so the gates are built in exactly
 * one place. runtime-core receives the closures and stays dependency-free.
 */
export { type ChildSkillSource, provabilitySkillText } from "./child-skill";
export { buildRunEvaluation, type EvaluationGateOptions } from "./evaluation";
export {
  type GateEvidenceInput,
  currentTurnMessages,
  gateEvidence,
  startsTurnMessage,
} from "./evidence";
export {
  type EvaluationFragment,
  type EvaluationIrSlice,
  evaluationFragmentFromIr,
} from "./fragment";
export {
  HEAD_CACHE_ENTRIES,
  type HeadCache,
  type HeadDecision,
  type HeadResolver,
  RESOLVE_SINK_ID,
  SHARED_HEAD_CACHE,
  createHeadResolver,
  hopPolicy,
  sourceHostPolicy,
} from "./head";
export {
  WAIVER_NOT_SUPPORTED,
  WAIVER_RUBRIC,
  WAIVER_SUPPORTED,
  type WaiverJudgeOptions,
  createWaiverJudge,
} from "./judge";
export { type ProofBundle, type ProofBundleObserver, observeProofBundles } from "./observe";
export { type ProvabilityGateOptions, buildRunProvability, displayPath } from "./provability";
export {
  type EvaluationWiring,
  type EvaluationWiringOptions,
  GATES_VAR,
  renderEvaluationWiring,
} from "./render";
export {
  type CatalogReplayOptions,
  type GateCatalog,
  REPLAY_RECHECK_MS,
  REPLAY_TIMEOUT_MS,
  catalogReplay,
  lookupTool,
  resultText,
} from "./replay";
export {
  activeTenant,
  fencedDir,
  gateProofsRoot,
  gateSessionRoot,
  proofsDirName,
} from "./roots";
export {
  type GateSkillsWiring,
  PROVABILITY_SKILL_NAME,
  type ProvabilitySkillConfig,
  type ProvabilitySkillSource,
  provabilitySkillSubstitutions,
  provabilitySkills,
  renderGateSkills,
} from "./skills";
export {
  DEFAULT_FORMAL_CHECKERS,
  type GateProofTools,
  type GateToolsOptions,
  gateTools,
  mergeGateTools,
  registerGateTools,
  wantsProofCheckTools,
} from "./tools";
export {
  EvaluationServiceError,
  type WireEvaluationDeps,
  type WiredGates,
  wireEvaluation,
} from "./wire";
