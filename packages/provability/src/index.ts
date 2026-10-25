/**
 * @crewhaus/provability — the provability ladder (design/0.8.0-provability-release.md).
 *
 * Four rungs — `cited`, `grounded`, `checked`, `proven` — checked by one
 * deterministic verifier (`verifyDocument`) over an answer and the evidence
 * index of the run that wrote it, with the result as one proof bundle every
 * surface renders. The package makes no model call and imports no model
 * adapter: the one model-backed step, the opt-in paraphrase waiver, is a
 * callback its caller injects.
 */
export * from "./types";
export { isProvabilityLevel, levelRank, maxRung, meetsFloor, rungOfRank } from "./levels";
export {
  type PathRoots,
  doiUrl,
  hasUserinfo,
  hostMatches,
  hostOf,
  isPrivateHost,
  normalizePath,
  normalizeUrl,
  originKey,
  registrableDomain,
} from "./origin";
export {
  type EvidenceIndexOptions,
  type EvidenceMessage,
  type EvidenceOptions,
  type InputSchemaLookup,
  type SessionLogEvidenceOptions,
  type ToolCall,
  ProvabilityError,
  buildEvidenceIndex,
  evidenceFromMessages,
  evidenceFromSessionLog,
  groundingBody,
  recordFromCall,
  restrictToTurns,
  servedFrom,
  servesPage,
  sha256Of,
  spilledOutput,
} from "./evidence";
export { PROOF_ID_REGEX, isProofArtifact, isProofId, newProofId } from "./artifact";
export {
  HEAD_CONCURRENCY,
  HEAD_DEADLINE_MS,
  MAX_GROUNDING_TOKENS,
  MAX_HEAD_REQUESTS,
  bundleHash,
  claimReasons,
  independenceKey,
  isToolAllowed,
  statementMismatch,
  unverifiedBundle,
  verifyDocument,
} from "./verify";
export {
  type FooterOptions,
  renderBundleJson,
  renderFooter,
  renderMarkdownSection,
  renderNudge,
} from "./render";
export { summarizeBundle } from "./summary";
/** claim-ledger's, re-exported: what a definition line shows beyond what it names. */
export { definitionGloss } from "@crewhaus/claim-ledger";
export {
  type BundleListing,
  type BundleStore,
  NO_SESSION,
  createBundleStore,
  createFileArtifactStore,
  proofsRoot,
} from "./store";
export { isPureTool } from "./purity";
