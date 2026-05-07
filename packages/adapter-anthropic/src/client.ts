/**
 * Anthropic SDK client construction. Moved from
 * `runtime-core/src/index.ts:122-207` (Section 17 refactor).
 *
 * Honours `ANTHROPIC_BASE_URL` for test/mock servers. OAuth tokens get
 * the beta + identity headers required to route through subscription
 * billing instead of the API workspace.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ProviderAuthError } from "@crewhaus/errors";
import type { ResolvedAuth } from "./auth.js";

/**
 * Beta headers Anthropic expects when authenticating with a Claude
 * subscription OAuth token (issued by `claude setup-token`). Without
 * these the request routes through the API workspace instead of the
 * user's subscription.
 */
export const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

/** Identity headers paired with the OAuth token for subscription-billing routing. */
export const CLAUDE_CODE_HEADERS = {
  accept: "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "x-app": "cli",
} as const;

/** System-prompt prefix expected for subscription-billed OAuth requests. */
export const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export function createAnthropicClient(
  auth: ResolvedAuth,
  env: NodeJS.ProcessEnv = process.env,
): {
  client: Anthropic;
  isOAuth: boolean;
} {
  if (auth.mode === "none") {
    throw new ProviderAuthError(
      "anthropic",
      "no Anthropic credentials found: set ANTHROPIC_AUTH_TOKEN (Claude subscription, recommended) or ANTHROPIC_API_KEY (pay-per-token) — see .env.example",
    );
  }
  const baseURL = env["ANTHROPIC_BASE_URL"];
  const baseURLOption = baseURL !== undefined && baseURL !== "" ? { baseURL } : {};
  if (auth.mode === "oauth") {
    return {
      isOAuth: true,
      client: new Anthropic({
        authToken: auth.token,
        apiKey: null,
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          "anthropic-beta": OAUTH_BETAS.join(","),
          ...CLAUDE_CODE_HEADERS,
        },
        ...baseURLOption,
      }),
    };
  }
  return {
    isOAuth: false,
    client: new Anthropic({ apiKey: auth.token, authToken: null, ...baseURLOption }),
  };
}
