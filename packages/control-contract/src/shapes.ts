/**
 * The wire shapes of `crewhaus.hangar.v1` that have no other home. Types only.
 * `./schemas` holds a zod schema for each, and `schemas/type-checks.ts` fails the
 * build when the two disagree on a field.
 *
 * Field names survive Hangar's masker, which redacts by key name: `environment`,
 * `dedupeRef`, `credentialRef`, `prefixHint`, `signIn` and `deviceJwk`, never `env`,
 * `…Key`, `…Token`, `auth` or `publicKey`.
 *
 * Actor fields hold bare stored actors: a `prn_`, `local:#<digest>` or `sys:` id,
 * never a raw `local:`.
 */
import type {
  CliTwin,
  HttpMethod,
  IdempotencyMode,
  ModelBoundDecl,
  Qualifier,
  ReceiptMode,
  Role,
} from "./areas/types.js";
import type { CapabilityDescriptor } from "./capabilities.js";
import type { CommandReceipt } from "./commands.js";
import type { DecisionRecordView, IfUnanswered, OperatorSupersedeReason } from "./decisions.js";
import type { ListEnvelope } from "./lists.js";
import type { DecisionState, DeploymentState, HarnessDisplay, RunState } from "./machines.js";
import type { Permission } from "./permissions.js";
import type { PROTOCOL_ID } from "./protocol.js";
import type { LinkProvider, RunCause, Trigger } from "./refs.js";
import type { ScopedAct } from "./scoped-acts.js";

// ---------------------------------------------------------------------------
// Issuing a secret: sealed, never in the clear
// ---------------------------------------------------------------------------

/** An ephemeral ECDH public key the client generated for one issued secret. */
export type Seal = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};

/** A device's public signing key. */
export type DeviceJwk = {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
};

/** A secret encrypted to a `seal`; every value is hex, which the masker passes. */
export type Issued = {
  readonly alg: "ECDH-ES+A256GCM";
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
};

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type EmptyRequest = Readonly<Record<string, never>>;

export type PauseRequest = {
  readonly quiet?: boolean;
};

export type RetireRequest = {
  /** Defaults to `true`: nothing happens until a caller says otherwise. */
  readonly dryRun?: boolean;
  readonly confirmName?: string;
  readonly nonce?: string;
  /** Defaults to `false`. */
  readonly stop?: boolean;
};

export type DeploymentActivateRequest = {
  readonly deployment: string;
};

export type RunCreateRequest = {
  readonly input: string;
  readonly subject?: string;
  /** Defaults to `reject`. */
  readonly admission?: "reject" | "queue";
  readonly work?: string;
};

export type DecisionResolveRequest = {
  readonly choice: "grant" | "deny";
  /** The revision or binding digest the caller read. */
  readonly expect?: string;
  readonly note?: string;
};

/** A code an operator may give, from a closed list. The system's own reasons are not among them. */
export type DecisionSupersedeRequest = {
  readonly reason: OperatorSupersedeReason;
};

export type RuleCreateRequest = {
  readonly tool: string;
  readonly pattern: string;
  readonly derivedFrom?: string;
  readonly reason: string;
  readonly expiresAt?: string;
};

export type InviteCreateRequest = {
  readonly role: Role;
  readonly scope: string;
  readonly expiresAt?: string;
  readonly seal: Seal;
};

export type GrantCreateRequest = {
  readonly principal: string;
  readonly role: Role;
  readonly scope: string;
  readonly expiresAt?: string;
};

export type TokenMintRequest = {
  readonly principal: string;
  readonly permissions?: readonly Permission[];
  readonly harnesses?: readonly string[];
  readonly contentRead?: boolean;
  readonly subjectAssert?: boolean;
  readonly expiresAt?: string;
  readonly seal: Seal;
};

export type LinkCreateRequest = {
  readonly subject: string;
  readonly principal: string;
};

export type ScopedTokenMintRequest = {
  readonly subject?: string;
  readonly refs: readonly string[];
  readonly acts: readonly ScopedAct[];
  readonly ttlSeconds?: number;
  readonly seal: Seal;
};

export type AuthSessionRequest = {
  readonly device: string;
  readonly nonce: string;
  readonly signature: string;
  readonly seal: Seal;
};

export type AuthExchangeRequest = {
  readonly code: string;
  readonly deviceJwk: DeviceJwk;
  readonly seal: Seal;
};

export type AuthAcceptInviteRequest = {
  readonly code: string;
  readonly displayName: string;
  readonly deviceJwk: DeviceJwk;
  readonly seal: Seal;
};

export type AuthRefreshRequest = {
  readonly seal: Seal;
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Never `$0` for something unpriced: `usdMicros` is `null` when the total is unknown. */
export type RunCost = {
  readonly usdMicros: number | null;
  /** How many calls had no price. */
  readonly unpriced: number;
};

export type Run = {
  readonly id: string;
  readonly harness?: string;
  readonly state: RunState;
  readonly trigger: Trigger;
  readonly at?: string;
  readonly execution?: string;
  readonly deployment?: string;
  readonly session?: string;
  readonly parent?: string;
  readonly continues?: string;
  readonly continuedIn?: string;
  readonly attemptOf?: string;
  readonly resumeScope?: string;
  readonly mode?: string;
  /** A keyed digest of the subject: a run row is append-only and never holds the person. */
  readonly subjectRef?: string;
  readonly decision?: string;
  readonly failureClass?: string;
  readonly cost?: RunCost;
  readonly workItem?: string;
  /** The session log's byte length at loop start, so a reader seeks to this run. */
  readonly sessionAt?: number;
  readonly cause?: RunCause;
  /** Who created a queued run. */
  readonly by?: string;
};

export type RunCreated = {
  readonly run: Run;
  readonly receipt: CommandReceipt;
};

export type RunResult = {
  readonly run: string;
  readonly state: RunState;
  readonly outputRef?: string;
  readonly evidenceRefs?: readonly string[];
  readonly evaluationRefs?: readonly string[];
  readonly cost?: RunCost;
  readonly inspectionUrl?: string;
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** A decision record with what a read computed from it. */
export type Decision = DecisionRecordView & {
  readonly state: DecisionState;
  readonly overdue?: boolean;
  readonly fallback?: IfUnanswered;
  readonly assignedTo?: string;
  readonly harness?: string;
  readonly choices?: readonly string[];
  readonly evidenceRefs?: readonly string[];
};

export type DecisionResolved = {
  readonly decision: Decision;
  readonly receipt: CommandReceipt;
};

/** A standing rule's metadata; enforcement stays a plain settings entry. */
export type StandingRule = {
  readonly id: string;
  readonly tool: string;
  readonly pattern: string;
  readonly derivedFrom?: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly policyRevision?: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
};

// ---------------------------------------------------------------------------
// Harnesses and deployments
// ---------------------------------------------------------------------------

export type HarnessOverview = {
  readonly id: string;
  readonly slug: string;
  readonly owner?: string;
  readonly createdAt?: string;
  readonly display: HarnessDisplay;
  readonly savedSpecHash?: string;
  readonly deployedSpecHash?: string;
  readonly activeDeployment?: string;
  readonly openDecisions?: number;
  readonly lastVerifiedContactAt?: string;
  readonly asOf?: string;
  readonly stale?: boolean;
  /** How this read was served: a saved projection, or a bounded fold on the spot. */
  readonly freshness?: "projection" | "direct-fold";
};

export type HarnessCapabilities = {
  readonly harness: string;
  readonly capabilities: Readonly<Record<string, CapabilityDescriptor>>;
};

/** A probe that could not answer leaves its field out: absent is not `false`. */
export type HarnessHealth = {
  readonly harness: string;
  readonly heartbeatAgeMs?: number;
  readonly controlReachable?: boolean;
  readonly backlog?: number;
  readonly recovery?: string;
};

export type DeploymentArtifact = {
  readonly digest: string;
  readonly specHash: string;
  readonly compiledWith: string;
  readonly shape: string;
  readonly entry: string;
};

export type Deployment = {
  readonly id: string;
  readonly harness: string;
  readonly state: DeploymentState;
  readonly artifact: DeploymentArtifact;
  readonly host?: string;
  readonly environment?: string;
  readonly policyRevision?: string;
  readonly tenantsRoot?: string;
  readonly autostart?: boolean;
  readonly activatedBy?: string;
  readonly cmd?: string;
};

export type RetireStep = {
  readonly kind: string;
  readonly status: "planned" | "done" | "skipped" | "failed" | "manual";
  readonly note?: string;
};

export type RetireResponse = {
  readonly dryRun: boolean;
  readonly steps: readonly RetireStep[];
  /** A dry run's nonce, which the real run repeats. */
  readonly nonce?: string;
  readonly receipt?: CommandReceipt;
};

export type CommandAccepted = {
  readonly receipt: CommandReceipt;
};

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export type Member = {
  readonly id: string;
  readonly kind: "member" | "service";
  readonly displayName?: string;
  readonly createdAt?: string;
};

export type Grant = {
  readonly id: string;
  readonly principal: string;
  readonly role: Role;
  /** `home`, `group:<name>` or `harness:<hrn>`. */
  readonly scope: string;
  readonly grantedBy: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
};

export type Invite = {
  readonly id: string;
  readonly role: Role;
  readonly scope: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly revokedAt?: string;
};

/** A credential as a list shows it: never the secret. */
export type TokenRow = {
  readonly id: string;
  readonly principal: string;
  readonly kind: "bootstrap" | "personal" | "service";
  readonly prefixHint?: string;
  readonly permissions?: readonly Permission[];
  readonly harnesses?: readonly string[];
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
};

/** `subjectRef` is a keyed digest; a readable subject lives only in rewritable files. */
export type Link = {
  readonly id: string;
  readonly principal: string;
  readonly provider: LinkProvider;
  readonly subjectRef: string;
  readonly verifiedVia: string;
  readonly at: string;
  readonly revokedAt?: string;
};

export type Device = {
  readonly id: string;
  readonly principal: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
};

export type InviteIssued = {
  readonly invite: Invite;
  readonly issued: Issued;
  readonly receipt: CommandReceipt;
};

export type TokenIssued = {
  readonly issued: Issued;
  readonly credentialRef?: string;
  readonly prefixHint?: string;
  readonly expiresAt?: string;
  readonly receipt?: CommandReceipt;
};

export type SessionIssued = {
  readonly issued: Issued;
  readonly expiresAt?: string;
  readonly principal?: string;
  readonly receipt?: CommandReceipt;
};

export type SignedOut = {
  readonly signedOut: true;
};

export type AuthChallenge = {
  readonly nonce: string;
  readonly expiresAt: string;
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DiscoveryOperation = {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly permission: string;
  readonly receipt: ReceiptMode;
  readonly request: string;
  readonly response: string;
  readonly cliTwin: CliTwin | null;
  readonly qualifiers: readonly Qualifier[];
  readonly idempotency: IdempotencyMode;
  readonly noReceiptReason?: string;
  readonly noTwinReason?: string;
  readonly stream?: "sse";
  readonly secretFields?: readonly string[];
  readonly modelBound?: Readonly<Record<string, ModelBoundDecl>>;
};

export type DiscoveryLimits = {
  readonly pageLimitDefault: number;
  readonly pageLimitMax: number;
  readonly cursorMaxLength: number;
};

/** What an unauthenticated caller gets is `protocol` and `signIn`, and nothing more. */
export type Discovery = {
  readonly protocol: typeof PROTOCOL_ID;
  readonly signIn: {
    readonly methods: readonly string[];
  };
  readonly operations?: readonly DiscoveryOperation[];
  readonly capabilities?: readonly string[];
  readonly limits?: DiscoveryLimits;
};

export type Me = {
  readonly principal: Member;
  readonly grants: readonly Grant[];
  /** Which permissions this caller holds, so a client can disable a control and say why. */
  readonly can: Readonly<Record<string, boolean>>;
};

export type RefResolved = {
  readonly kind: string;
  readonly href: string;
  readonly summary: string;
};

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export type HarnessList = ListEnvelope<HarnessOverview>;
export type DeploymentList = ListEnvelope<Deployment>;
export type RunList = ListEnvelope<Run>;
export type DecisionList = ListEnvelope<Decision>;
export type RuleList = ListEnvelope<StandingRule>;
export type CommandList = ListEnvelope<CommandReceipt>;
export type MemberList = ListEnvelope<Member>;
export type InviteList = ListEnvelope<Invite>;
export type GrantList = ListEnvelope<Grant>;
export type TokenList = ListEnvelope<TokenRow>;
export type LinkList = ListEnvelope<Link>;
export type DeviceList = ListEnvelope<Device>;
