/**
 * Claude on Google Vertex AI — builds an `AnthropicAdapter` backed by
 * `@anthropic-ai/vertex-sdk`'s `AnthropicVertex` client.
 *
 * The Vertex SDK is an optionalDependency, loaded lazily here so the
 * dominant Anthropic-direct path never touches it on disk. A missing
 * install fails with an actionable ConfigError at resolution time, not
 * a bare module error mid-run.
 *
 * Env:
 *   - ANTHROPIC_VERTEX_PROJECT_ID  (or GOOGLE_CLOUD_PROJECT) — required
 *   - CLOUD_ML_REGION              (or GOOGLE_CLOUD_LOCATION) — defaults
 *                                  to "us-east5", the widest Claude
 *                                  availability on Vertex
 *
 * Auth flows through Application Default Credentials / the ambient
 * service account — no API key. OAuth subscription billing does not
 * apply on Vertex, so the adapter always runs in non-OAuth mode.
 *
 * `AnthropicVertex` shares the core SDK's `messages` surface; the
 * adapter only calls `client.messages.create(..., { stream: true })`, so
 * the structural cast below is sound even though the two classes have
 * distinct types.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { ConfigError, ProviderAuthError } from "@crewhaus/errors";
import { AnthropicAdapter } from "./adapter.js";

export async function createAnthropicVertexAdapter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnthropicAdapter> {
  let mod: typeof import("@anthropic-ai/vertex-sdk");
  try {
    mod = await import("@anthropic-ai/vertex-sdk");
  } catch (err) {
    throw new ConfigError(
      "adapter-anthropic: @anthropic-ai/vertex-sdk is not installed — required for vertex/claude-* model strings (bun add @anthropic-ai/vertex-sdk)",
      err,
    );
  }
  const projectId = env["ANTHROPIC_VERTEX_PROJECT_ID"] ?? env["GOOGLE_CLOUD_PROJECT"];
  if (projectId === undefined || projectId.length === 0) {
    throw new ProviderAuthError(
      "anthropic",
      "vertex/claude-* model strings require ANTHROPIC_VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT); auth flows through Application Default Credentials",
    );
  }
  const region = env["CLOUD_ML_REGION"] ?? env["GOOGLE_CLOUD_LOCATION"] ?? "us-east5";
  const client = new mod.AnthropicVertex({ projectId, region });
  // AnthropicVertex eagerly starts ADC discovery at construction and
  // stores the promise unawaited. Without ambient credentials that
  // rejection would surface as a process-level unhandled rejection
  // before any request is made — subscribe a no-op handler so the SDK's
  // own `await` reports it at first request instead.
  (client as unknown as { _authClientPromise?: Promise<unknown> })._authClientPromise?.catch(
    () => {},
  );
  return new AnthropicAdapter({ client: client as unknown as Anthropic, isOAuth: false });
}
