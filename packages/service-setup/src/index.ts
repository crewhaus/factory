/**
 * `@crewhaus/service-setup` — provisioning for the external services a
 * harness cannot bring up on its own.
 *
 * A harness spec says *that* it wants a Slack channel, a public URL and a
 * hosted wiki. Turning that into a Slack app with the right scopes, a tunnel
 * hostname that resolves, and a wiki space the key can write to has always
 * been a click-path in three consoles. This package is that click-path as
 * code, driven entirely off the spec so nothing about any particular fleet's
 * conventions is baked in.
 *
 * Read `plan.ts` for the step order and why it is what it is, and
 * `responder.ts` for the one genuinely subtle piece — how the Slack Request
 * URL gets verified before the daemon that would answer it can boot.
 */

export type {
  AppliedChange,
  PlannedChange,
  ProvisioningCredential,
  ServiceDeps,
  ServiceId,
  SetupScope,
} from "./types";
export {
  PROVISIONING_CREDENTIALS,
  REDACTED,
  SERVICE_IDS,
  SERVICE_TITLE,
  ServiceSetupError,
} from "./types";

export type { AgentMailAuth, AgentMailDeps, Inbox, InboxApiKey, InboxInput } from "./agentmail";
export {
  AGENTMAIL_API_BASE,
  AGENTMAIL_CONSOLE_URL,
  createInboxApiKey,
  ensureInbox,
  inboxClientId,
  listInboxes,
} from "./agentmail";

export type { JsonRequest, JsonResponse } from "./http";
export { DEFAULT_TIMEOUT_MS, asRecord, readString, requestJson } from "./http";

export type {
  AgentMailTarget,
  CredentialSlot,
  ReadTargetOptions,
  SetupTarget,
  SlackTarget,
  ThredzTarget,
} from "./target";
export {
  DEFAULT_EVENTS_PORT,
  SLACK_ACTIONS_PATH,
  SLACK_EVENTS_PATH,
  hostnameLabel,
  publicHostname,
  readSetupTarget,
  slotEnvName,
} from "./target";

export type { EnvFileView, EnvWriteHow, EnvWriteResult } from "./env-file";
export { ENV_KEY_RE, readEnvFile, upsertEnvVar } from "./env-file";

export type { SpecEditResult } from "./spec-edit";
export { previewThredzSpace, setThredzSpace } from "./spec-edit";

export type {
  CloudflareAuth,
  CloudflareDeps,
  DnsUpsertResult,
  IngressRule,
  TunnelConfiguration,
  TunnelSummary,
} from "./cloudflare";
export {
  CLOUDFLARE_API_BASE,
  connectorInstallHint,
  createTunnel,
  ensureTunnel,
  findTunnelByName,
  findZone,
  getTunnelConfiguration,
  getTunnelToken,
  localOrigin,
  mergeIngress,
  needsConnector,
  putTunnelConfiguration,
  upsertDnsCname,
  verifyToken,
} from "./cloudflare";

export type {
  CreatedApp,
  InstalledBot,
  ManifestInput,
  SlackAuth,
  SlackDeps,
  SlackManifest,
} from "./slack";
export {
  SLACK_API_BASE,
  authTest,
  buildAuthorizeUrl,
  buildManifest,
  createApp,
  exchangeOauthCode,
  exportManifest,
  missingScopes,
  rotateConfigToken,
  updateApp,
  validateManifest,
} from "./slack";

export type { SpaceInventory, SpaceType, ThredzAuth, ThredzDeps, WikiSpace } from "./thredz";
export {
  THREDZ_API_BASE,
  createSpace,
  ensureSpace,
  listSpaces,
  slugifySpaceName,
  verifyKey,
} from "./thredz";

export type { Responder, ResponderEvent, ResponderOptions } from "./responder";
export { portInUse, readChallenge, startResponder } from "./responder";

export type {
  AgentMailOutcome,
  CloudflareOutcome,
  SetupContext,
  SetupCredentials,
  SetupDeps,
  SetupIo,
  SetupOptions,
  SlackOutcome,
  ThredzOutcome,
} from "./plan";
export {
  applyAgentMail,
  applyCloudflare,
  applySlack,
  applyThredz,
  defaultHostname,
  renderChanges,
  renderPlan,
  resolveCredentials,
  selectedServices,
  slackBotEvents,
  slackEnvNames,
  slackScopes,
} from "./plan";
