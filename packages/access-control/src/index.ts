/**
 * `@crewhaus/access-control`: who may operate a harness (#507, #513). Members and service
 * principals, roles granted on the whole Home, a registry group or one harness, hashed
 * credentials, invites, links from outside identities, the pure `authorize()` check and
 * the approver projection each governed harness reads. Every record lives under
 * `<hangarRoot>/access/`; no record holds a secret, a name or a readable link subject.
 *
 * Files and WebCrypto only: it spawns no process, opens no socket and reads no file of its
 * own package at runtime. Each export's docblock names its first consumer.
 */
export {
  type AccessHandle,
  type BootstrapOutcome,
  type Done,
  type GrantInput,
  type GrantResult,
  INVITE_TTL_MS,
  type InviteInput,
  type InviteResult,
  type LinkInput,
  type LinkResult,
  type MintInput,
  type MintResult,
  type OpenAccessOptions,
  type RedeemAnswer,
  type RedeemOptions,
  type RedeemRefusalCode,
  type Refusal,
  type RemoveResult,
  type RevokeResult,
  SERVICE_TOKEN_TTL_MS,
  type SetUpInput,
  type SetUpResult,
  type SyncResult,
  ensureAccessSetUp,
  openAccess,
  redeemInvite,
} from "./access";
export {
  type AccessActor,
  type AccessTarget,
  type AuthorizeOptions,
  type AuthorizeVerdict,
  type DomainChecker,
  type DomainRequest,
  authorize,
  effectiveRole,
} from "./authorize";
export { type LocalIdentity, localActorOf } from "./local-actor";
export type { RefusalCode } from "./mutate";
export type { AccessHarness, ProjectionFailure, ProjectionReport } from "./projection";
export type {
  CredentialRow,
  GovernedRow,
  GrantRow,
  InviteRow,
  LinkRow,
  PrincipalKind,
  PrincipalRow,
} from "./records";
export { type IssuedSecretKind, mintIssuedSecret } from "./secrets";
export {
  type AccessSnapshot,
  type AccessSnapshotRead,
  loadAccessSnapshot,
  localPrincipalOf,
} from "./snapshot";
export {
  type GrantView,
  type InviteView,
  type LinkView,
  type MemberView,
  type TokenView,
  listInvites,
  listMembers,
  listTokens,
} from "./views";
