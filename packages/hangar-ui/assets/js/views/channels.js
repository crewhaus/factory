/**
 * Channels — provisioning, verification, the two testing tiers, routing
 * display, per-channel status, and the gateway panel. Shape-gated: this tab
 * appears for channel daemons.
 *
 * The two test buttons must be labelled for what they actually prove:
 *   tier 1  an unsigned POST expecting a 401 — "the endpoint is up and
 *           rejecting unsigned traffic". Cheap, and not end-to-end.
 *   tier 2  a SIGNED synthetic inbound, signed server-side with the
 *           harness's own secret, showing the full turn. Slack, Telegram and
 *           WhatsApp only — Discord's verification is asymmetric Ed25519, so
 *           the harness holds only a public key and a forged event is
 *           impossible by design; iMessage is a poller with no inbound
 *           webhook. Both exclusions render disabled WITH the reason, which
 *           is more useful than hiding the button.
 *
 * The routing panel carries the reactions caveat: 👍/👎 feedback needs a
 * `channel` or `user` sessionKey, and a `thread` sessionKey silently
 * collects nothing.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderChannels(root, _ctx) {
  renderPendingSurface(root, {
    group: "channels",
    title: "Channels",
    blurb:
      "Per-channel config and live connectivity, the offline scope doctor, provisioning plans shown before they run, tier-1 liveness and tier-2 signed synthetic inbound, and the gateway status panel.",
  });
}
