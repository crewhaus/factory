import * as readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { RuntimeError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { zodToJsonSchema } from "zod-to-json-schema";

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
 * Tool support (Section 2): when `tools` is provided, the loop forwards
 * the tool definitions (Zod → JSON Schema) to the model and, after each
 * streaming response, executes any tool_use blocks via @crewhaus/tool-executor
 * before re-calling the model. The inner loop terminates when the assistant
 * returns no further tool_use blocks for that user turn.
 *
 * Future expansion: compaction, permission, hooks, multi-provider model
 * adapters, abort handling, recovery, keychain refresh for OAuth — see
 * docs/MODULE-CATALOG.md PART B Layers R1–R2.
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
  /** Override the input stream (testing). Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Tools the model may invoke. When empty/undefined, tools are not advertised. */
  tools?: ReadonlyArray<RegisteredTool>;
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

  const tools = opts.tools ?? [];
  const anthropicTools: Anthropic.Tool[] | undefined =
    tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: zodToJsonSchema(t.inputSchema, {
            $refStrategy: "none",
          }) as Anthropic.Tool.InputSchema,
        }))
      : undefined;
  const toolByName = new Map(tools.map((t) => [t.name, t]));

  const rl = readline.createInterface({
    input: opts.input ?? process.stdin,
    output: process.stdout,
  });

  // EOF on stdin (e.g. when input is piped in non-interactively) auto-closes
  // the readline interface. The next `rl.question` call would then crash with
  // ERR_USE_AFTER_CLOSE, so race each prompt against the close event and
  // also catch the post-close throw — close can fire either before we issue
  // the next prompt or while we're already awaiting one.
  const STDIN_CLOSED = Symbol("stdin-closed");
  const closedSignal = new Promise<typeof STDIN_CLOSED>((resolve) => {
    rl.once("close", () => resolve(STDIN_CLOSED));
  });

  const authNote = isOAuth ? " [oauth]" : "";
  process.stdout.write(`agent ready (model: ${opts.model})${authNote}. type "exit" to quit.\n`);

  try {
    while (true) {
      let userInput: string;
      try {
        const result = await Promise.race([rl.question("\nyou> "), closedSignal]);
        if (result === STDIN_CLOSED) break;
        userInput = result.trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") break;
        throw err;
      }
      if (userInput === "") continue;
      if (userInput === "exit" || userInput === "quit") break;

      messages.push({ role: "user", content: userInput });

      // Inner tool loop: keep calling the model until it stops requesting tools.
      while (true) {
        process.stdout.write("agent> ");
        const stream = client.messages.stream({
          model: opts.model,
          max_tokens: maxTokens,
          system: systemBlocks,
          messages,
          ...(anthropicTools ? { tools: anthropicTools } : {}),
        });

        stream.on("text", (chunk) => {
          process.stdout.write(chunk);
        });

        const final = await stream.finalMessage();
        process.stdout.write("\n");

        // Persist the assistant turn with the FULL content-block array; tool_use
        // blocks must survive into history so subsequent tool_result references
        // resolve, and Anthropic rejects orphan tool_result ids.
        messages.push({
          role: "assistant",
          content: final.content as Anthropic.MessageParam["content"],
        });

        const toolUses = final.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) break;

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          process.stdout.write(`[tool: ${tu.name}]\n`);
          const tool = toolByName.get(tu.name);
          if (!tool) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `unknown tool "${tu.name}"`,
              is_error: true,
            });
            continue;
          }
          const result = await executeTool(tool, tu.input, { toolUseId: tu.id });
          toolResults.push({
            type: "tool_result",
            tool_use_id: result.toolUseId,
            content: result.content,
            is_error: result.isError,
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
    }
  } finally {
    rl.close();
  }
}
