/**
 * Anthropic SDK client construction. Moved from
 * `runtime-core/src/index.ts:122-207` (Section 17 refactor).
 *
 * Honours `ANTHROPIC_BASE_URL` for test/mock servers. OAuth tokens get
 * the beta + identity headers required to route through subscription
 * billing instead of the API workspace.
 */

import { execFileSync } from "node:child_process";
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

/**
 * Fallback when the local `claude` binary isn't on PATH. Bump this when you
 * pull a fresh CLI so the spoofed user-agent doesn't drift far from what
 * Anthropic's anti-abuse system expects. (OAuth tokens used outside the
 * official CLI are unsupported and the user-agent staleness is one of the
 * signals Anthropic uses to 429 them.)
 */
const FALLBACK_CLAUDE_CLI_VERSION = "2.1.92";

let warnedAboutCliFallback = false;

/**
 * Indirection over `child_process.execFileSync` so the detection logic can
 * be unit-tested without spawning a real process. Only the success/throw
 * behaviour and the returned string matter to the caller.
 */
export type ClaudeVersionProbe = (file: string, args: readonly string[]) => string;

const defaultVersionProbe: ClaudeVersionProbe = (file, args) =>
  execFileSync(file, [...args], {
    encoding: "utf-8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * Probe the locally installed `claude` CLI for its version string so the
 * spoofed OAuth user-agent stays close to what Anthropic's anti-abuse
 * system expects. Falls back to {@link FALLBACK_CLAUDE_CLI_VERSION} (warning
 * once) when the binary is absent, not on PATH, or times out.
 *
 * `probe` is injectable for unit testing; production callers use the
 * module-level {@link CLAUDE_CODE_HEADERS} computed at import.
 */
export function detectClaudeCliVersion(probe: ClaudeVersionProbe = defaultVersionProbe): string {
  try {
    const raw = probe("claude", ["--version"]);
    const match = /(\d+\.\d+\.\d+)/.exec(raw);
    if (match?.[1]) return match[1];
  } catch {
    // claude not installed, not on PATH, or timed out — fall through.
  }
  if (!warnedAboutCliFallback) {
    warnedAboutCliFallback = true;
    console.warn(
      `[adapter-anthropic] could not detect installed claude CLI version; using fallback claude-cli/${FALLBACK_CLAUDE_CLI_VERSION} for OAuth identity headers`,
    );
  }
  return FALLBACK_CLAUDE_CLI_VERSION;
}

const DETECTED_CLAUDE_CLI_VERSION = detectClaudeCliVersion();

/** Identity headers paired with the OAuth token for subscription-billing routing. */
export const CLAUDE_CODE_HEADERS = {
  accept: "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": `claude-cli/${DETECTED_CLAUDE_CLI_VERSION} (external, cli)`,
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
