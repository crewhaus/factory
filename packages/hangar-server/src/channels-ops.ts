/**
 * M3 · CHANNELS — the channels panel, provisioning, verification, the two
 * testing tiers, and the gateway panel.
 *
 * STUBS. Owned by the Creds+Channels+Security implementer.
 *
 * ---------------------------------------------------------------------------
 * THE TWO TESTING TIERS (and why tier 2 is not a credential leak)
 * ---------------------------------------------------------------------------
 * tier 1 — LIVENESS. An UNSIGNED POST to the daemon's webhook endpoint,
 *   expecting a 401. Cheap, safe, and honest about what it proves: the
 *   endpoint is up and rejecting unsigned traffic. Label it as such; it is
 *   not an end-to-end test.
 *
 * tier 2 — SIGNED SYNTHETIC INBOUND. Opt-in. The SERVER reads the harness's
 *   own symmetric signing secret (from its `.env`, server-side, at request
 *   time), signs a real synthetic event, posts it, and shows the full turn.
 *   The session is marked `{ synthetic: true, reason, by }`. The value is
 *   never rendered, never returned, never logged. This is the one place the
 *   manager touches a secret's VALUE, and it is resolved by keeping the
 *   whole operation server-side.
 *
 *   Slack / Telegram / WhatsApp only. DISCORD IS TIER-1 ONLY, by design and
 *   not by omission: Discord verification is asymmetric Ed25519 and the
 *   harness holds only `publicKeyHex`, so only Discord's private key can
 *   sign a valid event — a forged inbound is impossible. Render the button
 *   disabled WITH that reason. iMessage is a poller with no inbound webhook
 *   at all, so neither tier applies.
 *
 * The routing display carries a trap worth naming on screen: reaction
 * feedback (Slack 👍/👎) requires a `channel` or `user` `sessionKey`. A
 * `thread` sessionKey routes correctly and collects no reactions.
 *
 * Channel status has two sources and one honest empty state: the gateway's
 * `/status` `channels[]` when a gateway exists, and "no status endpoint"
 * otherwise. Never synthesize a green light from spec configuration alone.
 *
 * Provisioning is PRINT-FIRST: the Slack manifest, the Telegram
 * `setWebhook` call, the Discord endpoint + invite are shown before anything
 * is executed, and iMessage's macOS / Full-Disk-Access prerequisites are
 * checklist items, not silent failures.
 *
 * Implementation reuses `@crewhaus/preflight` (`channelEnvChecks`) and
 * `@crewhaus/gateway-protocol` — both already dependencies.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/channels` — the channels panel.
 *
 * Per channel: the spec's config (sessionKey routing with the reactions
 * caveat, webhook URL, signing state as a PRESENCE boolean, heartbeat
 * config), the env-check results, and live connectivity from the gateway's
 * `/status` `channels[]` when one is reachable.
 */
export const channels: M3Handler = () => notImplemented("channels panel");

/**
 * `POST /api/h/:id/channels/verify` — `channel verify --offline`.
 *
 * The per-variable scope doctor that is also the pre-boot gate (the same
 * checks preflight runs). Offline by default: it answers from configuration
 * and environment, not by calling a provider.
 */
export const channelVerify: M3Handler = () => notImplemented("channel verify");

/**
 * `GET /api/h/:id/channels/:channel/provision` — the provisioning PLAN.
 *
 * What `channel provision` would do, rendered: the Slack app manifest, the
 * Telegram `setWebhook` request, the Discord endpoint + invite, or
 * iMessage's macOS permission checklist. Print-only — no call is made.
 */
export const channelProvision: M3Handler = () => notImplemented("channel provision plan");

/**
 * `POST /api/h/:id/channels/:channel/provision` — execute the plan.
 *
 * Body: `{ confirm }`. Runs the provisioning verb through the job queue
 * after the operator has seen the plan above.
 */
export const channelProvisionRun: M3Handler = () => notImplemented("channel provision");

/**
 * `POST /api/h/:id/channels/:channel/probe` — tier-1 liveness.
 *
 * An unsigned POST to the daemon's webhook endpoint expecting a 401. Report
 * exactly that: "the endpoint is up and rejecting unsigned traffic".
 */
export const channelProbe: M3Handler = () => notImplemented("channel liveness probe");

/**
 * `POST /api/h/:id/channels/:channel/synthetic` — tier-2 signed synthetic
 * inbound.
 *
 * Body: `{ text?, confirm }`. Opt-in. Reads the harness's symmetric signing
 * secret SERVER-SIDE, signs a real event, posts it, and returns the
 * resulting turn — the session marked `synthetic: true`. Refuse for Discord
 * (asymmetric Ed25519: the harness holds only the public key) and for
 * iMessage (a poller with no inbound webhook), each with its reason. The
 * secret value never enters a response, a log, or manager state.
 */
export const channelSynthetic: M3Handler = () => notImplemented("synthetic inbound");

/**
 * `GET /api/h/:id/gateway` — the gateway panel.
 *
 * For channel daemons with a `gateway:` block: the `/status` poll
 * (turnCount, heartbeatCount, channels[]) and a link to the daemon's own
 * mini dashboard when `ui: true`. When the block is ABSENT, the honest
 * answer is an "add a gateway block" affordance that goes through the spec
 * write path — not an error.
 */
export const gateway: M3Handler = () => notImplemented("gateway panel");
