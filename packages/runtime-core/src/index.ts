import * as readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { RuntimeError } from "@crewhaus/errors";

/**
 * Slice-scope runtime: a multi-turn streaming chat loop with prompt
 * caching for the system prompt. Maps to catalog R1 runtime-orchestrator
 * (single-turn-cycle slice) and R2 model-adapter (Anthropic only).
 *
 * Auth resolution: ANTHROPIC_AUTH_TOKEN (Claude Pro/Max OAuth) takes
 * precedence over ANTHROPIC_API_KEY (pay-per-token API key). OAuth tokens
 * are detected by the `sk-ant-oat` prefix and given the beta + identity
 * headers required to route through subscription billing.
 *
 * Future expansion: tool execution, compaction, permission, hooks,
 * multi-provider model adapters, abort handling, recovery, keychain refresh
 * for OAuth — see docs/MODULE-CATALOG.md PART B Layers R1–R2.
 */

/**
 * Beta headers Anthropic expects when authenticating with a Claude subscription
 * OAuth token (issued by `claude setup-token`). Without these the request
 * routes through the API workspace instead of the user's subscription.
 */
const OAUTH_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

/** Identity headers paired with the OAuth token for subscription-billing routing. */
const CLAUDE_CODE_HEADERS = {
  accept: "application/json",
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": "claude-cli/2.1.2 (external, cli)",
  "x-app": "cli",
} as const;

/** System-prompt prefix expected for subscription-billed OAuth requests. */
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

export type ResolvedAuth =
  | { readonly mode: "oauth"; readonly token: string }
  | { readonly mode: "api-key"; readonly token: string }
  | { readonly mode: "none" };

/**
 * Resolve Anthropic credentials from env. ANTHROPIC_AUTH_TOKEN takes
 * precedence; tokens prefixed with `sk-ant-oat` are treated as OAuth, all
 * others fall through to API-key handling.
 */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): ResolvedAuth {
  const authToken = env["ANTHROPIC_AUTH_TOKEN"];
  if (authToken) {
    return authToken.startsWith("sk-ant-oat")
      ? { mode: "oauth", token: authToken }
      : { mode: "api-key", token: authToken };
  }
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey) return { mode: "api-key", token: apiKey };
  return { mode: "none" };
}

/**
 * Build an Anthropic SDK client for the resolved auth. Throws RuntimeError
 * with mode="none" so the caller surfaces a clear setup hint.
 */
export function createAnthropicClient(auth: ResolvedAuth): {
  client: Anthropic;
  isOAuth: boolean;
} {
  if (auth.mode === "none") {
    throw new RuntimeError(
      "no Anthropic credentials found: set ANTHROPIC_AUTH_TOKEN (Claude subscription, recommended) or ANTHROPIC_API_KEY (pay-per-token) — see .env.example",
    );
  }
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
      }),
    };
  }
  return {
    isOAuth: false,
    client: new Anthropic({ apiKey: auth.token, authToken: null }),
  };
}

export type RunChatLoopOptions = {
  model: string;
  instructions: string;
  maxTokens?: number;
  /** Override the SDK client (testing, alternate auth flows). */
  client?: Anthropic;
  /** When supplying a custom client, force OAuth-style system prefix. */
  isOAuth?: boolean;
};

export async function runChatLoop(opts: RunChatLoopOptions): Promise<void> {
  const resolved = opts.client
    ? { client: opts.client, isOAuth: opts.isOAuth ?? false }
    : createAnthropicClient(resolveAuth());
  const { client, isOAuth } = resolved;
  const maxTokens = opts.maxTokens ?? 4096;
  const messages: Anthropic.MessageParam[] = [];

  const userInstructions: Anthropic.TextBlockParam = {
    type: "text",
    text: opts.instructions,
    cache_control: { type: "ephemeral" },
  };
  const systemBlocks: Anthropic.TextBlockParam[] = isOAuth
    ? [{ type: "text", text: CLAUDE_CODE_SYSTEM_PREFIX }, userInstructions]
    : [userInstructions];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const authNote = isOAuth ? " [oauth]" : "";
  process.stdout.write(`agent ready (model: ${opts.model})${authNote}. type "exit" to quit.\n`);

  try {
    while (true) {
      const userInput = (await rl.question("\nyou> ")).trim();
      if (userInput === "") continue;
      if (userInput === "exit" || userInput === "quit") break;

      messages.push({ role: "user", content: userInput });

      process.stdout.write("agent> ");
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: maxTokens,
        system: systemBlocks,
        messages,
      });

      stream.on("text", (chunk) => {
        process.stdout.write(chunk);
      });

      const final = await stream.finalMessage();
      process.stdout.write("\n");

      const assistantText = final.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      messages.push({ role: "assistant", content: assistantText });
    }
  } finally {
    rl.close();
  }
}
