/**
 * `@crewhaus/access-control`: who may operate a harness (#507, #513). Members and service
 * principals, roles granted on the whole Home, a registry group or one harness, hashed
 * credentials, invites, links from outside identities, the pure `authorize()` check and
 * the approver projection each governed harness reads. Every record lives under
 * `<hangarRoot>/access/`; no record holds a secret, a name or a readable link subject.
 *
 * Stage 2 adds signing in: Home's own key (the bootstrap) and the boot tickets, browsers'
 * device keys and sealed sessions, and `authenticate()`, the one check every request to
 * Home passes.
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
  type RefreshAnswer,
  type RefreshInput,
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
  refreshApproverProjections,
  registerDomainIn,
} from "./access";
export { cidrContains, isLoopbackAddress, parseCidr, type Cidr } from "./addresses";
export {
  type AccessActor,
  type AccessTarget,
  type AuthorizeOptions,
  type AuthorizeVerdict,
  type DomainChecker,
  type DomainRequest,
  type ObjectRef,
  authorize,
  domainOf,
  effectiveRole,
} from "./authorize";
export {
  type AuthVia,
  type Authenticated,
  type AuthenticateConfig,
  type AuthenticateState,
  BOOTSTRAP_PRINCIPAL,
  HOME_SOCKET,
  PROXY_SOCKET,
  type Identified,
  type Listener,
  PROXY_SECRET_HEADER,
  type Peer,
  type ScopedGrant,
  type TrustedProxy,
  authenticate,
  hasForwardingHeaders,
  hostNameOf,
} from "./authenticate";
export {
  BOOT_TICKET_TTL_MS,
  type BootTickets,
  type RotateInput,
  type RotateResult,
  TOKEN_FILENAME,
  type TokenSetup,
  createBootTickets,
  ensureToken,
  rotateBootstrap,
  tokenEquals,
} from "./bootstrap";
export { type LocalIdentity, localActorOf } from "./local-actor";
export { noAuthRefusal } from "./no-auth";
export {
  OWNER_BLOCKS,
  type OwnerSettings,
  type OwnerSettingsRead,
  SETTINGS_FILENAME,
  readOwnerSettings,
  writeOwnerBlock,
} from "./owner-settings";
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
export {
  SCOPED_ACT_PERMISSIONS,
  SCOPED_TOKEN_TTL_MS,
  type ScopedMintAnswer,
  type ScopedMintInput,
  type ScopedVerified,
  mintScopedToken,
  verifyScopedToken,
} from "./scoped";
export { type IssuedSecretKind, mintIssuedSecret } from "./secrets";
export type { Issued, SealedOperation } from "./sealed";
export {
  type AcceptInviteInput,
  type BearerCheck,
  type SessionEnd,
  type SessionIssue,
  SIGN_IN_LIMITS,
  type SignInHandle,
  type SignInOptions,
  type SignInRefusal,
  type SignInRefusalReason,
  type TabOnlyIssue,
  openSignIn,
} from "./sign-in";
export type { DeviceJwk, DeviceRow, SessionRow } from "./sign-in-records";
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
