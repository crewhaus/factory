/**
 * Holds each schema to its type in the main entry, at compile time: `tsc -b` fails
 * when one side has a field the other lacks, narrows one, or makes one optional.
 *
 * A plain equality is false for every `.passthrough()` schema, whose inferred type
 * carries an index signature, and for any `readonly` field, so both sides are
 * normalized first. `Norm` erases a pure `Record<string, V>`, so `z.record` value
 * types are not compared here: the minimal examples the tests hold pin those.
 *
 * Requests with a default compare on `z.input`, the form a client sends.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./core.js";

type Equals<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
  ? true
  : false;

type Norm<V> = V extends readonly (infer E)[]
  ? Norm<E>[]
  : V extends object
    ? {
        -readonly [K in keyof V as string extends K ? never : number extends K ? never : K]: Norm<
          V[K]
        >;
      }
    : V;

type Same<A, B> = Equals<Norm<A>, Norm<B>>;

type Expect<Check extends true> = Check;

// @ts-expect-error The helper must refuse an extra field, or none of these checks bites.
export type HelperBites = Expect<Same<{ a: string; extra: number }, { a: string }>>;

export type SchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.canonicalRunId>, string>>,
  Expect<Same<z.infer<typeof S.commandId>, string>>,
  Expect<Same<z.infer<typeof S.credentialId>, string>>,
  Expect<Same<z.infer<typeof S.cursorString>, string>>,
  Expect<Same<z.infer<typeof S.decisionId>, string>>,
  Expect<Same<z.infer<typeof S.deploymentId>, string>>,
  Expect<Same<z.infer<typeof S.deviceId>, string>>,
  Expect<Same<z.infer<typeof S.grantId>, string>>,
  Expect<Same<z.infer<typeof S.harnessId>, string>>,
  Expect<Same<z.infer<typeof S.inviteId>, string>>,
  Expect<Same<z.infer<typeof S.linkId>, string>>,
  Expect<Same<z.infer<typeof S.principalId>, string>>,
  Expect<Same<z.infer<typeof S.refString>, string>>,
  Expect<Same<z.infer<typeof S.ruleId>, string>>,
  Expect<Same<z.infer<typeof S.runRowId>, string>>,
  Expect<Same<z.infer<typeof S.sessionId>, string>>,
  Expect<Same<z.infer<typeof S.storedActor>, string>>,
  Expect<Same<z.infer<typeof S.workItemId>, string>>,
  Expect<Same<z.infer<typeof S.approverProjection>, T.ApproverProjection>>,
  Expect<Same<z.infer<typeof S.authAcceptInviteRequest>, T.AuthAcceptInviteRequest>>,
  Expect<Same<z.infer<typeof S.authChallenge>, T.AuthChallenge>>,
  Expect<Same<z.infer<typeof S.authExchangeRequest>, T.AuthExchangeRequest>>,
  Expect<Same<z.infer<typeof S.authRefreshRequest>, T.AuthRefreshRequest>>,
  Expect<Same<z.infer<typeof S.authSessionRequest>, T.AuthSessionRequest>>,
  Expect<Same<z.infer<typeof S.capabilityDescriptor>, T.CapabilityDescriptor>>,
  Expect<Same<z.infer<typeof S.commandAccepted>, T.CommandAccepted>>,
  Expect<Same<z.infer<typeof S.commandList>, T.CommandList>>,
  Expect<Same<z.infer<typeof S.commandReceipt>, T.CommandReceipt>>,
  Expect<Same<z.infer<typeof S.decision>, T.Decision>>,
  Expect<Same<z.infer<typeof S.decisionBinding>, T.DecisionBinding>>,
  Expect<Same<z.infer<typeof S.decisionList>, T.DecisionList>>,
  Expect<Same<z.infer<typeof S.decisionOverlays>, T.DecisionOverlays>>,
  Expect<Same<z.infer<typeof S.decisionResolveRequest>, T.DecisionResolveRequest>>,
  Expect<Same<z.infer<typeof S.decisionResolved>, T.DecisionResolved>>,
  Expect<Same<z.infer<typeof S.decisionSupersedeRequest>, T.DecisionSupersedeRequest>>,
  Expect<Same<z.infer<typeof S.deployment>, T.Deployment>>,
  Expect<Same<z.infer<typeof S.deploymentActivateRequest>, T.DeploymentActivateRequest>>,
  Expect<Same<z.infer<typeof S.deploymentList>, T.DeploymentList>>,
  Expect<Same<z.infer<typeof S.device>, T.Device>>,
  Expect<Same<z.infer<typeof S.deviceJwk>, T.DeviceJwk>>,
  Expect<Same<z.infer<typeof S.deviceList>, T.DeviceList>>,
  Expect<Same<z.infer<typeof S.discovery>, T.Discovery>>,
  Expect<Same<z.infer<typeof S.discoveryOperation>, T.DiscoveryOperation>>,
  Expect<Same<z.infer<typeof S.emptyRequest>, T.EmptyRequest>>,
  Expect<Same<z.infer<typeof S.errorEnvelope>, T.ErrorEnvelope>>,
  Expect<Same<z.infer<typeof S.eventEnvelope>, T.EventEnvelope>>,
  Expect<Same<z.infer<typeof S.eventFrame>, T.EventFrame>>,
  Expect<Same<z.infer<typeof S.grant>, T.Grant>>,
  Expect<Same<z.infer<typeof S.grantCreateRequest>, T.GrantCreateRequest>>,
  Expect<Same<z.infer<typeof S.grantList>, T.GrantList>>,
  Expect<Same<z.infer<typeof S.harnessCapabilities>, T.HarnessCapabilities>>,
  Expect<Same<z.infer<typeof S.harnessDisplay>, T.HarnessDisplay>>,
  Expect<Same<z.infer<typeof S.harnessHealth>, T.HarnessHealth>>,
  Expect<Same<z.infer<typeof S.harnessList>, T.HarnessList>>,
  Expect<Same<z.infer<typeof S.harnessOverview>, T.HarnessOverview>>,
  Expect<Same<z.infer<typeof S.invite>, T.Invite>>,
  Expect<Same<z.infer<typeof S.inviteCreateRequest>, T.InviteCreateRequest>>,
  Expect<Same<z.infer<typeof S.inviteIssued>, T.InviteIssued>>,
  Expect<Same<z.infer<typeof S.inviteList>, T.InviteList>>,
  Expect<Same<z.infer<typeof S.issued>, T.Issued>>,
  Expect<Same<z.infer<typeof S.link>, T.Link>>,
  Expect<Same<z.infer<typeof S.linkCreateRequest>, T.LinkCreateRequest>>,
  Expect<Same<z.infer<typeof S.linkList>, T.LinkList>>,
  Expect<Same<z.infer<typeof S.listEnvelope>, T.ListEnvelope<unknown>>>,
  Expect<Same<z.infer<typeof S.listQuery>, T.ListQuery>>,
  Expect<Same<z.infer<typeof S.me>, T.Me>>,
  Expect<Same<z.infer<typeof S.member>, T.Member>>,
  Expect<Same<z.infer<typeof S.memberList>, T.MemberList>>,
  Expect<Same<z.infer<typeof S.noBody>, undefined>>,
  Expect<Same<z.infer<typeof S.pauseRequest>, T.PauseRequest>>,
  Expect<Same<z.infer<typeof S.refResolved>, T.RefResolved>>,
  Expect<Same<z.input<typeof S.retireRequest>, T.RetireRequest>>,
  Expect<Same<z.infer<typeof S.retireResponse>, T.RetireResponse>>,
  Expect<Same<z.infer<typeof S.ruleCreateRequest>, T.RuleCreateRequest>>,
  Expect<Same<z.infer<typeof S.ruleList>, T.RuleList>>,
  Expect<Same<z.infer<typeof S.run>, T.Run>>,
  Expect<Same<z.infer<typeof S.runCause>, T.RunCause>>,
  Expect<Same<z.infer<typeof S.runCost>, T.RunCost>>,
  Expect<Same<z.input<typeof S.runCreateRequest>, T.RunCreateRequest>>,
  Expect<Same<z.infer<typeof S.runCreated>, T.RunCreated>>,
  Expect<Same<z.infer<typeof S.runList>, T.RunList>>,
  Expect<Same<z.infer<typeof S.runResult>, T.RunResult>>,
  Expect<Same<z.infer<typeof S.scopedTokenMintRequest>, T.ScopedTokenMintRequest>>,
  Expect<Same<z.infer<typeof S.seal>, T.Seal>>,
  Expect<Same<z.infer<typeof S.sessionIssued>, T.SessionIssued>>,
  Expect<Same<z.infer<typeof S.signedOut>, T.SignedOut>>,
  Expect<Same<z.infer<typeof S.standingRule>, T.StandingRule>>,
  Expect<Same<z.infer<typeof S.streamQuery>, T.StreamQuery>>,
  Expect<Same<z.infer<typeof S.tokenIssued>, T.TokenIssued>>,
  Expect<Same<z.infer<typeof S.tokenList>, T.TokenList>>,
  Expect<Same<z.infer<typeof S.tokenMintRequest>, T.TokenMintRequest>>,
  Expect<Same<z.infer<typeof S.tokenRow>, T.TokenRow>>,
  Expect<Same<z.infer<typeof S.trigger>, T.Trigger>>,
];
