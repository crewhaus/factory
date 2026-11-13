/** One minimal valid value per schema id, built from the real minters. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type CommandReceipt, type Decision, encodeCursor, mintId, mintRunId } from "../index.js";

export const HRN = "hrn_0123456789abcdef";
export const SESS = "sess_0123456789abcdef";
export const APPR = "appr_0123456789abcdef";
export const AT = "2026-11-07T00:00:00.000Z";
export const CURSOR = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 });

const COORDINATE = "A".repeat(43);
export const SEAL = { kty: "EC", crv: "P-256", x: COORDINATE, y: COORDINATE } as const;
const ISSUED = { alg: "ECDH-ES+A256GCM", epk: "04ab", iv: "00ff", ct: "abcd" } as const;

export const RECEIPT: CommandReceipt = {
  id: mintId("cmd"),
  v: 1,
  kind: "controls.pause",
  target: `home/harness/${HRN}`,
  actor: mintId("prn"),
  via: "home",
  fingerprint: "ab",
  state: "accepted",
  acceptedAt: AT,
  effects: [],
  retry: { retryable: false, safety: "never" },
};

const RUN = { id: mintRunId(), state: "queued", trigger: { kind: "api" } } as const;
const DECISION: Decision = { id: APPR, createdAt: AT, state: "pending" };
const OVERVIEW = {
  id: HRN,
  slug: "support",
  display: { state: "running", enforcement: "enforced" },
} as const;
const DEPLOYMENT = {
  id: mintId("dep"),
  harness: HRN,
  state: "prepared",
  artifact: { digest: "d", specHash: "s", compiledWith: "0.9.0", shape: "cli", entry: "dist/a.ts" },
} as const;
const MEMBER = { id: mintId("prn"), kind: "member" } as const;
const GRANT = {
  id: mintId("grt"),
  principal: mintId("prn"),
  role: "viewer",
  scope: "home",
  grantedBy: mintId("prn"),
} as const;
const INVITE = {
  id: mintId("inv"),
  role: "viewer",
  scope: "home",
  createdBy: mintId("prn"),
  expiresAt: AT,
} as const;
const TOKEN_ROW = { id: mintId("crd"), principal: mintId("prn"), kind: "personal" } as const;
const LINK = {
  id: mintId("lnk"),
  principal: mintId("prn"),
  provider: "slack",
  subjectRef: "a".repeat(64),
  verifiedVia: "owner",
  at: AT,
} as const;
const DEVICE = { id: mintId("dev"), principal: mintId("prn"), createdAt: AT } as const;
const RULE = {
  id: mintId("rule"),
  tool: "Bash",
  pattern: "Bash(ls)",
  createdBy: mintId("prn"),
  reason: "other",
  expiresAt: AT,
} as const;
const OPERATION = {
  id: "me.get",
  method: "GET",
  path: "/api/v1/me",
  permission: "authenticated",
  receipt: "none",
  request: "noBody",
  response: "me",
  cliTwin: null,
  qualifiers: [],
  idempotency: "none",
} as const;
const ENVELOPE = {
  v: 1,
  id: CURSOR,
  type: "run.queued",
  at: AT,
  ingestedAt: AT,
  sensitivity: "internal",
} as const;

const list = (item: unknown) => ({ items: [item], snapshotAt: CURSOR });

export const EXAMPLES: Readonly<Record<string, unknown>> = {
  canonicalRunId: mintRunId(),
  commandId: mintId("cmd"),
  credentialId: mintId("crd"),
  cursorString: CURSOR,
  decisionId: APPR,
  deploymentId: mintId("dep"),
  deviceId: mintId("dev"),
  grantId: mintId("grt"),
  harnessId: HRN,
  inviteId: mintId("inv"),
  linkId: mintId("lnk"),
  principalId: mintId("prn"),
  refString: `home/harness/${HRN}`,
  ruleId: mintId("rule"),
  runRowId: "run_abcd1234",
  sessionId: SESS,
  storedActor: "sys:runtime",
  workItemId: mintId("wi"),
  approverProjection: {
    v: 1,
    epoch: 1,
    generatedAt: AT,
    harness: HRN,
    owner: mintId("prn"),
    governedSince: AT,
    members: [{ principal: mintId("prn"), decide: "operator" }],
    links: [{ external: "slack:T1:U1", principal: mintId("prn") }],
  },
  authAcceptInviteRequest: { code: "c", displayName: "Sam", deviceJwk: SEAL, seal: SEAL },
  authChallenge: { nonce: "n", expiresAt: AT },
  authExchangeRequest: { code: "c", deviceJwk: SEAL, seal: SEAL },
  authRefreshRequest: { seal: SEAL },
  authSessionRequest: { device: mintId("dev"), nonce: "n", signature: "s", seal: SEAL },
  capabilityDescriptor: { supported: true },
  commandAccepted: { receipt: RECEIPT },
  commandList: list(RECEIPT),
  commandReceipt: RECEIPT,
  decision: DECISION,
  decisionBinding: {
    runId: mintRunId(),
    resumeScope: `session:${SESS}`,
    sessionId: SESS,
    placesDigest: "p",
    resourceRevisionBound: false,
  },
  decisionList: list(DECISION),
  decisionOverlays: {},
  decisionResolveRequest: { choice: "grant" },
  decisionResolved: { decision: DECISION, receipt: RECEIPT },
  decisionSupersedeRequest: { reason: "other" },
  deployment: DEPLOYMENT,
  deploymentActivateRequest: { deployment: mintId("dep") },
  deploymentList: list(DEPLOYMENT),
  device: DEVICE,
  deviceJwk: SEAL,
  deviceList: list(DEVICE),
  discovery: { protocol: "crewhaus.hangar.v1", signIn: { methods: [] } },
  discoveryOperation: OPERATION,
  emptyRequest: {},
  errorEnvelope: { error: { code: "internal", message: "m", retryable: false } },
  eventEnvelope: ENVELOPE,
  eventFrame: { id: CURSOR, event: "run.queued", data: ENVELOPE },
  grant: GRANT,
  grantCreateRequest: { principal: mintId("prn"), role: "viewer", scope: "home" },
  grantList: list(GRANT),
  harnessCapabilities: { harness: HRN, capabilities: {} },
  harnessDisplay: { state: "running", enforcement: "enforced" },
  harnessHealth: { harness: HRN },
  harnessList: list(OVERVIEW),
  harnessOverview: OVERVIEW,
  invite: INVITE,
  inviteCreateRequest: { role: "viewer", scope: "home", seal: SEAL },
  inviteIssued: { invite: INVITE, issued: ISSUED, receipt: RECEIPT },
  inviteList: list(INVITE),
  issued: ISSUED,
  link: LINK,
  linkCreateRequest: { subject: "github:123", principal: mintId("prn") },
  linkList: list(LINK),
  listEnvelope: list("anything"),
  listQuery: {},
  me: { principal: MEMBER, grants: [], can: {} },
  member: MEMBER,
  memberList: list(MEMBER),
  noBody: undefined,
  pauseRequest: {},
  refResolved: { kind: "harness", href: "/#/i/x", summary: "s" },
  retireRequest: {},
  retireResponse: { dryRun: true, steps: [] },
  ruleCreateRequest: { tool: "Bash", pattern: "Bash(ls)", reason: "other" },
  ruleList: list(RULE),
  run: RUN,
  runCause: { kind: "tool", ref: "Bash" },
  runCost: { usdMicros: null, unpriced: 1 },
  runCreateRequest: { input: "hello" },
  runCreated: { run: RUN, receipt: RECEIPT },
  runList: list(RUN),
  runResult: { run: mintRunId(), state: "succeeded" },
  scopedTokenMintRequest: {
    refs: [`${HRN}/run/${mintRunId()}`],
    acts: ["run.events.read"],
    seal: SEAL,
  },
  seal: SEAL,
  sessionIssued: { issued: ISSUED },
  inviteAccepted: { tabOnly: true, expiresAt: AT },
  signedOut: { signedOut: true },
  standingRule: RULE,
  streamQuery: {},
  tokenIssued: { issued: ISSUED },
  tokenList: list(TOKEN_ROW),
  tokenMintRequest: { principal: mintId("prn"), seal: SEAL },
  tokenRow: TOKEN_ROW,
  trigger: { kind: "api" },
};

/** An area's examples live in its own `__test__/<area>.examples.ts`, exporting `EXAMPLES`. */
const areaExamples: readonly { readonly EXAMPLES: Readonly<Record<string, unknown>> }[] =
  await Promise.all(
    readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".examples.ts"))
      .map((name) => import(join(import.meta.dir, name))),
  );

/** The core's examples and every area's. */
export const ALL_EXAMPLES: Readonly<Record<string, unknown>> = Object.assign(
  {},
  EXAMPLES,
  ...areaExamples.map((module) => module.EXAMPLES),
);
