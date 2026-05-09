/**
 * @crewhaus/crewhaus-playground — Section 35
 *
 * Browser-based REPL for the CrewHaus meta-harness. Public surface:
 *
 *   - `createPlayground(opts)` — returns the in-process server harness
 *     (Bun.serve under the hood) that production deployments mount
 *     behind §20 gateway-server.
 *   - `playgroundIndexHtml(opts)` — renders the SPA shell with the
 *     embedded Monaco editor + trace timeline. Templates from §26
 *     scaffold-templates seed the "new spec" picker.
 *   - `enforceQuota({sessionId, tier, used})` — pure function the
 *     server uses to decide whether an anonymous tab can run another
 *     spec. Anonymous quota is small; OAuth-signed-in users get a
 *     larger one.
 *   - `tenantIsolation` — pure helpers that gate per-session lookups
 *     so two anonymous browsers can't see each other's runs.
 */
export {
  type GatewayClient,
  type PlaygroundConfig,
  type PlaygroundServer,
  type PlaygroundServerInstance,
  createPlayground,
} from "./server";

export {
  type RenderIndexOptions,
  playgroundIndexHtml,
} from "./render-html";

export {
  type Tier,
  type QuotaState,
  type QuotaDecision,
  type QuotaConfig,
  DEFAULT_QUOTA,
  enforceQuota,
} from "./quota";

export {
  type SessionScope,
  scopeRunId,
  parseRunIdScope,
  isolatedRunStore,
} from "./tenant-isolation";

export { templateMenuEntries } from "./templates";
