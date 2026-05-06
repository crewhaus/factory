import * as readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { autoCompact } from "@crewhaus/compaction-autocompact";
import { snip } from "@crewhaus/compaction-snip";
import { RuntimeError } from "@crewhaus/errors";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { TokenBudget, estimateTokens } from "@crewhaus/token-budget";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  type ToolUseBlock as TsmToolUseBlock,
  type TurnState,
  initialState,
  transition,
} from "@crewhaus/turn-state-machine";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Slice-scope runtime: a multi-turn streaming chat loop with prompt
 * caching, tool execution, and pre-turn context compaction. Maps to
 * catalog R1 runtime-orchestrator (state-machine-driven inner loop)
 * and R2 model-adapter (Anthropic only).
 *
 * Auth resolution: ANTHROPIC_AUTH_TOKEN (Claude Pro/Max OAuth) takes
 * precedence over ANTHROPIC_API_KEY (pay-per-token API key). OAuth tokens
 * are detected by the `sk-ant-oat` prefix and given the beta + identity
 * headers required to route through subscription billing.
 *
 * Tool support (Section 2): when `tools` is provided, the loop forwards
 * the tool definitions (Zod → JSON Schema) to the model and, after each
 * streaming response, executes any tool_use blocks via @crewhaus/tool-executor
 * before re-calling the model. The state machine reaches Done(no_tools)
 * when the assistant returns no further tool_use blocks for a turn.
 *
 * Compaction (Section 4): at the start of each user turn, estimate the
 * conversation's token count against `contextLimit` (default 200_000).
 * When usage crosses `compactionThreshold` (default 0.85), apply the
 * cheap snip first (drop middle messages, insert a marker). If the
 * trimmed history is still over threshold, fall back to autocompact
 * (model-summarized replacement).
 *
 * Future expansion: reactive compaction (NeedCompaction state from a
 * 413), recovery taxonomy (NeedRecovery state from max-tokens etc.),
 * permission, hooks, multi-provider model adapters, keychain refresh
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

const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_COMPACTION_THRESHOLD = 0.85;
const DEFAULT_SNIP_KEEP_HEAD = 4;
const DEFAULT_SNIP_KEEP_TAIL = 20;

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
  /** Per-run identity, abort signal, and logger. Defaults to a fresh `createRunContext()`. */
  runContext?: RunContext;
  /** Context-window limit in tokens. Defaults to 200_000 (Claude opus/sonnet 4.x). */
  contextLimit?: number;
  /** Fraction of `contextLimit` at which compaction kicks in. Defaults to 0.85. */
  compactionThreshold?: number;
  /** Number of head messages to keep when snipping. Defaults to 4. */
  snipKeepHead?: number;
  /** Number of tail messages to keep when snipping. Defaults to 20. */
  snipKeepTail?: number;
  /**
   * Pre-loaded conversation history. In `singleTurn` mode this is the
   * entire input; the last entry must be `role: "user"`.
   */
  seedMessages?: ReadonlyArray<Anthropic.MessageParam>;
  /**
   * Single-shot mode: run exactly one user→assistant turn (with the tool
   * inner-loop until Done) using `seedMessages`, then return the terminal
   * assistant text. Skips the stdin REPL entirely. Used by the workflow
   * target to run each step as a discrete turn.
   */
  singleTurn?: boolean;
};

/**
 * Runs the streaming chat loop and returns the terminal assistant text.
 *
 * - REPL mode (default): reads stdin in a loop, prints assistant turns to
 *   stdout, returns `""` when the loop exits.
 * - Single-turn mode (`singleTurn: true`): runs one turn from the seeded
 *   message history and returns the concatenated text content of the final
 *   assistant message. Does not touch stdin.
 */
export async function runChatLoop(opts: RunChatLoopOptions): Promise<string> {
  const resolved = opts.client
    ? { client: opts.client, isOAuth: opts.isOAuth ?? false }
    : createAnthropicClient(resolveAuth());
  const { client, isOAuth } = resolved;
  const maxTokens = opts.maxTokens ?? 4096;
  const runContext = opts.runContext ?? createRunContext();
  const contextLimit = opts.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const compactionThreshold = opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const snipKeepHead = opts.snipKeepHead ?? DEFAULT_SNIP_KEEP_HEAD;
  const snipKeepTail = opts.snipKeepTail ?? DEFAULT_SNIP_KEEP_TAIL;

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

  /**
   * Run one user→assistant turn through the state machine. Mutates
   * `messages` in place (pushes the assistant turn and any tool_results).
   * Returns the final assistant content blocks so callers can extract
   * text. Closes over client/model/maxTokens/etc.
   */
  async function runOneTurn(
    messages: Anthropic.MessageParam[],
  ): Promise<{ terminalContent: Anthropic.ContentBlock[] }> {
    let state: TurnState = initialState;
    let terminalContent: Anthropic.ContentBlock[] = [];

    while (state.kind !== "Done") {
      if (runContext.abortSignal.aborted) {
        state = transition(state, { kind: "Aborted" });
        continue;
      }

      switch (state.kind) {
        case "NeedModel": {
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

          // Persist the assistant turn with the FULL content-block array;
          // tool_use blocks must survive into history so subsequent
          // tool_result references resolve.
          messages.push({
            role: "assistant",
            content: final.content as Anthropic.MessageParam["content"],
          });
          terminalContent = final.content;

          const toolUses = final.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
          );
          if (toolUses.length === 0) {
            state = transition(state, { kind: "ModelReturnedText" });
          } else {
            const tsmBlocks: TsmToolUseBlock[] = toolUses.map((t) => ({
              id: t.id,
              name: t.name,
              input: t.input,
            }));
            state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
          }
          break;
        }
        case "NeedTools": {
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of state.toolUses) {
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
          state = transition(state, { kind: "ToolsExecuted" });
          break;
        }
        case "NeedCompaction":
          state = transition(state, { kind: "CompactionDone" });
          break;
        case "NeedRecovery":
          state = transition(state, { kind: "RecoveryDone" });
          break;
      }
    }

    return { terminalContent };
  }

  // Single-shot path used by the workflow target. One turn, returns the
  // terminal assistant text, never reads stdin.
  if (opts.singleTurn) {
    const seed = opts.seedMessages ?? [];
    const last = seed[seed.length - 1];
    if (!last || last.role !== "user") {
      throw new RuntimeError(
        'runChatLoop({ singleTurn: true }) requires `seedMessages` to end with a `role: "user"` entry',
      );
    }
    let messages: Anthropic.MessageParam[] = [...seed];
    runContext.turnNumber += 1;
    runContext.logger.debug("turn start (single)", {
      turn: runContext.turnNumber,
      messages: messages.length,
    });

    messages = await maybeCompact({
      messages,
      client,
      model: opts.model,
      contextLimit,
      compactionThreshold,
      snipKeepHead,
      snipKeepTail,
      logger: runContext.logger,
    });

    const { terminalContent } = await runOneTurn(messages);
    return terminalContent
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  // REPL mode (existing behavior).
  let messages: Anthropic.MessageParam[] = opts.seedMessages ? [...opts.seedMessages] : [];

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
      if (runContext.abortSignal.aborted) break;

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
      runContext.turnNumber += 1;
      runContext.logger.debug("turn start", {
        turn: runContext.turnNumber,
        messages: messages.length,
      });

      // Pre-turn budget check: snip first (free), then autocompact if still over.
      messages = await maybeCompact({
        messages,
        client,
        model: opts.model,
        contextLimit,
        compactionThreshold,
        snipKeepHead,
        snipKeepTail,
        logger: runContext.logger,
      });

      await runOneTurn(messages);

      runContext.logger.debug("turn end", {
        turn: runContext.turnNumber,
      });
    }
  } finally {
    rl.close();
  }

  return "";
}

type CompactArgs = {
  messages: Anthropic.MessageParam[];
  client: Anthropic;
  model: string;
  contextLimit: number;
  compactionThreshold: number;
  snipKeepHead: number;
  snipKeepTail: number;
  logger: RunContext["logger"];
};

/**
 * Pre-turn compaction ladder: estimate → snip → re-estimate → autocompact.
 * Returns the (possibly replaced) messages array. Pure with respect to
 * the input array; callers reassign.
 */
async function maybeCompact(args: CompactArgs): Promise<Anthropic.MessageParam[]> {
  const {
    messages,
    client,
    model,
    contextLimit,
    compactionThreshold,
    snipKeepHead,
    snipKeepTail,
    logger,
  } = args;

  const initialBudget = new TokenBudget(contextLimit);
  initialBudget.add(estimateTokens(messages), 0);
  if (!initialBudget.isApproachingLimit(compactionThreshold)) {
    return messages;
  }

  const snipped = snip(messages, snipKeepHead, snipKeepTail);
  logger.info("snip applied", { before: messages.length, after: snipped.length });

  const postSnipBudget = new TokenBudget(contextLimit);
  postSnipBudget.add(estimateTokens(snipped), 0);
  if (!postSnipBudget.isApproachingLimit(compactionThreshold)) {
    return snipped;
  }

  logger.info("autocompact triggered", { tokensAfterSnip: postSnipBudget.used });
  return await autoCompact(snipped, client, model);
}
