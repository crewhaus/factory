/**
 * Shared vocabulary for `crewhaus services setup` — the operator-tier
 * provisioner for the three external services a harness cannot bring up on
 * its own: a Slack app, a Cloudflare named tunnel, and a Thredz wiki space.
 *
 * WHY THIS IS A SEPARATE TIER FROM THE RUNTIME. `channel provision` is
 * deliberately emit-and-instruct for Slack (see the header of
 * `apps/cli/src/channel-provision.ts`): the spec carries only the credentials
 * the *daemon* uses — the `xoxb` bot token and the signing secret — and none
 * of those can call Slack's manifest API, so inventing a runtime env var for
 * an app-configuration token was rightly ruled out. This package does not
 * reverse that decision; it sits above it. The operator running setup holds
 * short-lived *provisioning* credentials (a Slack app-configuration token, a
 * Cloudflare API token, a Thredz key) that are read once, used once, and
 * never written into a spec. What lands in the harness is only ever what the
 * daemon itself needs.
 *
 * Everything here is pure data. Network access is always an injected
 * `fetchImpl`, and the environment is always an injected map — no module in
 * this package reads `process.env` or calls global `fetch` implicitly, so the
 * whole surface is unit-testable without credentials.
 */

/** Injected seams shared by every service client. */
export type ServiceDeps = {
  /** Injected `fetch`. Defaults to the global at the call site, never here. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 30_000. */
  readonly timeoutMs?: number;
};

/** The three services this package provisions. */
export const SERVICE_IDS = ["cloudflare", "slack", "thredz"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** Human titles, for plan and result rendering. */
export const SERVICE_TITLE: Record<ServiceId, string> = {
  cloudflare: "Cloudflare tunnel",
  slack: "Slack app",
  thredz: "Thredz wiki space",
};

/**
 * What a failure is *about*. The three services, plus `"harness"` for the
 * local half of setup — reading the spec, writing `.env`, editing the YAML.
 * Those failures classify and render exactly like a provider's, so the CLI
 * has one error path rather than two.
 */
export type SetupScope = ServiceId | "harness";

/**
 * A provisioning credential the operator supplies — never a credential the
 * harness runs with. `envName` is where the tool looks for it before asking,
 * so a `.env` or an exported shell var removes every prompt.
 */
export type ProvisioningCredential = {
  readonly id: "cloudflareApiToken" | "slackConfigToken" | "slackRefreshToken" | "thredzApiKey";
  readonly envName: string;
  readonly service: ServiceId;
  /** Shown when prompting; says where to mint it. */
  readonly prompt: string;
  /** Whether setup can proceed without it (a refresh token is optional). */
  readonly optional: boolean;
};

/** The provisioning credentials, in the order setup needs them. */
export const PROVISIONING_CREDENTIALS: readonly ProvisioningCredential[] = [
  {
    id: "cloudflareApiToken",
    envName: "CLOUDFLARE_API_TOKEN",
    service: "cloudflare",
    prompt:
      "Cloudflare API token (dash.cloudflare.com/profile/api-tokens → Create Token → " +
      "Account · Cloudflare Tunnel · Edit + Zone · DNS · Edit + Zone · Zone · Read)",
    optional: false,
  },
  {
    id: "slackConfigToken",
    envName: "SLACK_CONFIG_TOKEN",
    service: "slack",
    prompt:
      "Slack app-configuration token (api.slack.com/apps → Your App Configuration Tokens → " +
      "Generate Token; short-lived, and never stored in the harness)",
    optional: false,
  },
  {
    id: "slackRefreshToken",
    envName: "SLACK_CONFIG_REFRESH_TOKEN",
    service: "slack",
    prompt: "Slack app-configuration REFRESH token (shown beside the token above)",
    optional: true,
  },
  {
    id: "thredzApiKey",
    envName: "THREDZ_API_KEY",
    service: "thredz",
    prompt:
      "Thredz API key with a wiki read-write grant (thredz.crewhaus.ai → API keys). " +
      "Keys cannot be minted over the API — one per agent, since an individual " +
      "wiki space belongs to exactly one key",
    optional: false,
  },
];

/**
 * One planned change, rendered before anything is applied. `detail` never
 * contains a secret value — credentials render as their `$NAME` ref or as a
 * redaction placeholder, matching the convention in `channel-provision.ts`.
 */
export type PlannedChange = {
  readonly service: ServiceId;
  /** Imperative one-liner: "create tunnel \"crewhaus-crew\"". */
  readonly summary: string;
  /** Extra context lines, indented under the summary. */
  readonly detail?: readonly string[];
  /** True when the live state already matches — applying is a no-op. */
  readonly satisfied: boolean;
};

/** What actually happened to one planned change. */
export type AppliedChange = {
  readonly service: ServiceId;
  readonly summary: string;
  readonly outcome: "created" | "updated" | "unchanged" | "skipped" | "failed";
  readonly detail?: readonly string[];
  /** Present when `outcome` is "failed". */
  readonly error?: string;
};

/** Placeholder for a secret in any printable output. */
export const REDACTED = "[redacted]";

/**
 * Base error for every service client. Carries the wire status so the CLI can
 * map it onto the shared `EXIT_CODES` classes (auth 30, billing 31,
 * rate_limit 32) instead of printing a raw body.
 */
export class ServiceSetupError extends Error {
  override readonly name: string = "ServiceSetupError";
  constructor(
    readonly service: SetupScope,
    message: string,
    readonly options: {
      /** HTTP status, when the failure came off the wire. */
      readonly status?: number;
      /** Provider error identifier (`space_quota_exceeded`, `invalid_auth`). */
      readonly code?: string;
      /** One-line remediation, printed as `Fix: …`. */
      readonly fix?: string;
    } = {},
  ) {
    super(message);
  }

  /** Coarse class the CLI turns into an exit code. */
  get failureClass(): "auth" | "billing" | "rate_limit" | "config" | "network" {
    const { status, code } = this.options;
    if (status === 401 || status === 403 || code === "invalid_auth" || code === "not_authed") {
      return "auth";
    }
    if (status === 402 || code === "upgrade_required" || code?.endsWith("_quota_exceeded")) {
      return "billing";
    }
    if (status === 429 || code === "ratelimited" || code === "rate_limited") return "rate_limit";
    if (status !== undefined && status >= 500) return "network";
    return "config";
  }
}
