/**
 * `@crewhaus/control-contract`: the one description of the control plane every
 * surface shares. Types, data, minters and a few pure functions. This entry opens
 * no file, makes no network call and imports no package; zod is in `./schemas`.
 */
export { CORE_MODULE } from "./areas/core.js";
export { AREA_MODULES } from "./areas/index.js";
export type {
  AreaModule,
  CommandKindDecl,
  EventFamilyDecl,
  HttpMethod,
  IdGrammar,
  IdGrammarDecl,
  IdempotencyMode,
  MachineDef,
  ReceiptMode,
  RefIdDecl,
  RefKindDecl,
  RefScopeRule,
} from "./areas/types.js";
export { CROCKFORD, decodeBase32, encodeBase32 } from "./base32.js";
export { canonicalJson } from "./canonical-json.js";
export {
  CAPABILITY_NAMES,
  type CapabilityDescriptor,
  type CapabilityName,
} from "./capabilities.js";
export {
  COMMAND_KINDS,
  type CommandKindId,
  type CommandReceipt,
  type ReceiptEffect,
  type ReceiptExecutor,
  type ReceiptRetry,
} from "./commands.js";
export {
  CURSOR_MAX_LENGTH,
  CURSOR_SOURCES,
  type Cursor,
  type CursorDecodeFailure,
  type CursorDecodeResult,
  type CursorPosition,
  type CursorSource,
  type CursorSources,
  type FleetCursor,
  type PageCursor,
  type VectorCursor,
  decodeCursor,
  encodeCursor,
  isCursor,
} from "./cursor.js";
export {
  type ApproverProjection,
  DECISION_CLASSES,
  DECISION_LOG_REASONS,
  type DecisionBinding,
  type DecisionClass,
  type DecisionEscalation,
  type DecisionOverlays,
  type DecisionPlace,
  type DecisionRecordView,
  type DecisionSensitivity,
  type DecisionSupersedes,
  type EffectiveDecisionState,
  IF_UNANSWERED,
  type IfUnanswered,
  VERIFY_REASONS,
  type VerifyApprovers,
  type VerifyConsumer,
  type VerifyDecisionInput,
  type VerifyReason,
  type VerifyVerdict,
  classAllows,
  effectiveDecisionState,
  verifyDecision,
} from "./decisions.js";
export {
  ERROR_CODES,
  type ErrorBody,
  type ErrorCode,
  type ErrorEnvelope,
  isErrorCode,
} from "./errors.js";
export {
  EVENT_TAXONOMY,
  EVENT_TAXONOMY_VERSION,
  EVENT_TYPES,
  type EventEnvelope,
  type EventFrame,
  type EventSensitivity,
  type EventType,
  isEventType,
} from "./events.js";
export {
  APPROVAL_ID_PATTERN,
  APPROVAL_ID_RE,
  CANONICAL_RUN_ID_RE,
  EXECUTION_RUN_ID_RE,
  GRAPH_RUN_ID_RE,
  HARNESS_ID_RE,
  ID_GRAMMARS,
  ISSUED_SECRET_RES,
  type IdPrefix,
  type ParsedId,
  SESSION_ID_PATTERN,
  SESSION_ID_RE,
  ULID_PREFIXES,
  type UlidPrefix,
  formatId,
  isId,
  mintId,
  mintRunId,
  parseId,
} from "./ids.js";
export {
  EMPTY_REASONS,
  type EmptyReason,
  type ListEmpty,
  type ListEnvelope,
  type ListQuery,
  type ListTruncated,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  type StreamQuery,
} from "./lists.js";
export {
  type CommandState,
  type DecisionState,
  type DeploymentState,
  HARNESS_DISPLAY_STATES,
  type HarnessDisplay,
  type HarnessDisplayState,
  type HarnessEnforcement,
  MACHINES,
  type MachineName,
  type RunState,
  canTransition,
} from "./machines.js";
export {
  type CliTwin,
  type ModelBoundDecl,
  OPERATIONS,
  type OperationId,
  type OperationRow,
  QUALIFIERS,
  type Qualifier,
} from "./operations/index.js";
export { PATH_PARAMS, type PathParam, isPathParam, pathParamSpans } from "./operations/params.js";
export {
  PERMISSIONS,
  PERMISSION_DECLS,
  PERMISSION_SCOPE,
  type Permission,
  type PermissionDecl,
  ROLES,
  ROLE_PERMISSIONS,
  type Role,
  isPermission,
} from "./permissions.js";
export {
  API_PREFIX,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_VALUE_RE,
  IDEMPOTENT_REPLAYED_HEADER,
  PROTOCOL_HEADER,
  PROTOCOL_ID,
} from "./protocol.js";
export {
  type ActorForm,
  LINK_PROVIDERS,
  LOCAL_ACTOR_RE,
  type LinkProvider,
  RECEIPT_VIA,
  REF_KINDS,
  REF_MAX_LENGTH,
  RUN_CAUSE_KINDS,
  type ReceiptVia,
  type Ref,
  type RefError,
  type RefKind,
  type ResumeScope,
  type RunCause,
  STORED_LOCAL_ACTOR_RE,
  SYSTEM_ACTORS,
  TRIGGER_KINDS,
  type Trigger,
  type TriggerKind,
  formatRef,
  formatResumeScope,
  isGrantScope,
  isLaneId,
  isRef,
  isStoredActor,
  parseActor,
  parseLinkSubject,
  parseRef,
  parseResumeScope,
} from "./refs.js";
export { type RunIdClass, type RunIdFamily, classifyRunId } from "./run-ids.js";
export {
  type EffectiveRunInput,
  type EffectiveRunState,
  type RunStateRecord,
  effectiveRunState,
} from "./runs.js";
export type * from "./shapes.js";
export {
  CLI_VERBS,
  type RenderedTwin,
  TWIN_PLACEHOLDERS,
  type TwinParams,
  parseTwin,
  renderTwin,
} from "./twins.js";
export { type MintUlidOptions, ULID_LENGTH, mintUlid } from "./ulid.js";

/** The scoped browser token's closed actions, composed from the modules. */
export { SCOPED_ACTS, type ScopedAct } from "./scoped-acts.js";
