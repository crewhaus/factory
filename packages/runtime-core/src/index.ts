import * as readline from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { type AbortTree, createAbortTree } from "@crewhaus/abort-controller";
import { autoCompact } from "@crewhaus/compaction-autocompact";
import { snip } from "@crewhaus/compaction-snip";
import { RuntimeError } from "@crewhaus/errors";
import {
  BUILTIN_DEFAULT_RULES,
  type PermissionMode,
  type RuleSet,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import {
  type RecoveryState,
  advanceState,
  initialRecoveryState,
  recover,
} from "@crewhaus/recovery-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { executeStreaming } from "@crewhaus/streaming-tool-executor";
import { TokenBudget, estimateTokens } from "@crewhaus/token-budget";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { type LoopDetection, detectLoop } from "@crewhaus/tool-loop-detection";
import { partitionToolCalls } from "@crewhaus/tool-orchestrator";
import { storeAndPreview } from "@crewhaus/tool-result-store";
import {
  type ToolUseBlock as TsmToolUseBlock,
  type TurnState,
  initialState,
  transition,
} from "@crewhaus/turn-state-machine";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Slice-scope runtime: a multi-turn streaming chat loop with prompt
 * caching, tool execution, pre-turn context compaction, recovery taxonomy,
 * permission gating, cooperative cancellation, and a partitioned/streaming
 * tool layer. Maps to catalog R1 runtime-orchestrator + R1 recovery-engine
 * + R8 permission-engine + R1 abort-controller + R3 tool-orchestrator /
 * tool-loop-detection / tool-result-store / streaming-tool-executor, plus
 * R2 model-adapter (Anthropic only).
 *
 * Auth resolution: ANTHROPIC_AUTH_TOKEN (Claude Pro/Max OAuth) takes
 * precedence over ANTHROPIC_API_KEY (pay-per-token API key). OAuth tokens
 * are detected by the `sk-ant-oat` prefix and given the beta + identity
 * headers required to route through subscription billing.
 *
 * Tool support: when `tools` is provided, the loop forwards the tool
 * definitions (Zod → JSON Schema) to the model, runs each tool through
 * the permission engine, then executes via @crewhaus/tool-executor before
 * re-calling the model. The state machine reaches Done(no_tools) when the
 * assistant returns no further tool_use blocks for a turn.
 *
 * Tool layer enrichment (Section 8): tool execution is partitioned via
 * `@crewhaus/tool-orchestrator` so concurrency-safe read-only calls run
 * via `Promise.all` while destructive calls run serially. After each
 * batch, `@crewhaus/tool-loop-detection` scans the per-run history; on a
 * hit, a synthetic warning user message is appended (deduped per
 * signature) so the model can self-correct. Every tool result flows
 * through `@crewhaus/tool-result-store` — outputs over 10 KB are
 * persisted to `.crewhaus/tool-results/<runId>/<toolUseId>.txt` and the
 * model sees a preview pointing at the full file. Behind a
 * `streaming: true` option, the loop swaps to
 * `@crewhaus/streaming-tool-executor`, which dispatches tools mid-stream
 * via the SDK's `contentBlock` event.
 *
 * Compaction: at the start of each user turn, estimate the conversation's
 * token count against `contextLimit` (default 200_000). When usage crosses
 * `compactionThreshold` (default 0.85), apply the cheap snip first, then
 * fall back to autocompact if still over. Reactive compaction is also
 * triggered in-turn when the recovery engine returns a `compact` action.
 *
 * Recovery: every model call is wrapped in try/catch. Errors flow through
 * the `recovery-engine` taxonomy: prompt_too_long → reactive compact;
 * max_output_tokens → continue; overloaded/5xx → exponential-backoff
 * retry; invalid_request → tombstone. Budgets enforced per turn.
 *
 * Permissions: every tool_use is evaluated by `permission-engine`. In
 * default and auto modes, an `ask` decision prompts the user via stdin in
 * REPL mode (single-turn mode treats `ask` as deny — non-interactive).
 *
 * Cancellation: the `runContext.abortSignal` becomes the root of an abort
 * tree; each turn gets a child, each tool call gets a grandchild. First
 * SIGINT cancels the current turn; second SIGINT exits the process.
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
 *
 * Honors `ANTHROPIC_BASE_URL` from env so smoke/integration tests can point
 * at a local mock-Anthropic server without touching production endpoints.
 */
export function createAnthropicClient(
  auth: ResolvedAuth,
  env: NodeJS.ProcessEnv = process.env,
): {
  client: Anthropic;
  isOAuth: boolean;
} {
  if (auth.mode === "none") {
    throw new RuntimeError(
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
  /**
   * Permission mode. Defaults to "default" (ask for tools without an
   * explicit allow rule). The `bypass` mode is only legal when supplied
   * directly by the runtime caller (the CLI flag parser); the spec/config
   * loaders reject bypass at parse time.
   */
  permissionMode?: PermissionMode;
  /** Layered rule sources. Defaults to `{ ..., builtin: BUILTIN_DEFAULT_RULES }`. */
  permissionRules?: RuleSet;
  /**
   * Install a SIGINT handler that aborts the current turn on first press
   * and exits on the second. Defaults to true in REPL mode when stdin is
   * a TTY; defaults to false otherwise (singleTurn, piped input, tests).
   */
  installSigintHandler?: boolean;
  /**
   * When true, drive the model stream with `@crewhaus/streaming-tool-executor`
   * so tool execution starts as soon as each `tool_use` block completes
   * (mid-stream) rather than waiting for the full response. Default: false.
   */
  streaming?: boolean;
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
  const permissionMode: PermissionMode = opts.permissionMode ?? "default";
  const permissionRules: RuleSet = opts.permissionRules ?? {
    ...emptyRuleSet,
    builtin: BUILTIN_DEFAULT_RULES,
  };

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

  // Root abort tree for the whole run; each turn gets a child.
  const runAbort = createAbortTree(runContext.abortSignal);
  // Per-turn abort tree, replaced at the start of each turn so a SIGINT
  // during turn N doesn't leave turn N+1 born-aborted.
  let turnAbort: AbortTree = runAbort.child();
  // Latest error captured from a model call, fed to recover() on entry to NeedRecovery.
  let lastErrorForRecovery: unknown = undefined;

  // Permission-ask prompter. Set in REPL mode after the readline interface
  // exists; remains undefined in single-turn mode (where ask collapses to deny).
  // The initial assignment makes the second assignment legal under biome's
  // `useConst` rule (which fires on exactly-one-assignment lets).
  let askApproval: ((toolName: string, input: unknown) => Promise<boolean>) | undefined = undefined;

  // Per-run state for tool-loop detection and warning de-dup. Both span
  // turns within a single `runChatLoop` invocation so cross-turn loops
  // (e.g. "keep running date") get caught and warned at most once per
  // signature.
  const toolUseHistory: TsmToolUseBlock[] = [];
  const warnedLoopSignatures = new Set<string>();

  /**
   * Execute one tool_use block end-to-end: permission gate → executeTool
   * with the per-tool abort signal → wrap large output through
   * `tool-result-store`. Returns a fully-formed `ToolResultBlockParam`
   * suitable for appending to message history.
   *
   * Used by both the partitioned (post-stream) path and the streaming
   * path so the permission/abort/store contract is uniform.
   */
  async function executeOneToolUse(tu: TsmToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    process.stdout.write(`[tool: ${tu.name}]\n`);
    const tool = toolByName.get(tu.name);
    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: `unknown tool "${tu.name}"`,
        is_error: true,
      };
    }

    const decision = evaluate(
      {
        toolName: tu.name,
        input: tu.input,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
      },
      permissionMode,
      permissionRules,
    );
    let approved = decision === "allow";
    let denialMessage: string | undefined;
    if (decision === "deny") {
      denialMessage = "tool denied by permission policy";
    } else if (decision === "ask") {
      if (askApproval !== undefined) {
        approved = await askApproval(tu.name, tu.input);
        if (!approved) denialMessage = "tool denied by user";
      } else {
        denialMessage = "tool denied (single-turn mode: cannot prompt for interactive approval)";
      }
    }
    if (!approved) {
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: denialMessage ?? "tool denied",
        is_error: true,
      };
    }

    const toolAbort = turnAbort.child();
    const raw = await executeTool(tool, tu.input, {
      toolUseId: tu.id,
      signal: toolAbort.signal,
    });
    const stored = await storeAndPreview(
      { toolUseId: raw.toolUseId, content: raw.content, isError: raw.isError },
      { runId: runContext.runId, toolUseId: tu.id },
    );
    if (stored.persisted) {
      runContext.logger.info("tool result persisted", {
        toolUseId: tu.id,
        toolName: tu.name,
        fullPath: stored.fullPath,
      });
    }
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: stored.previewContent,
      is_error: raw.isError,
    };
  }

  /**
   * Run a list of tool calls honouring the orchestrator's partition:
   * concurrent-safe batches via `Promise.all`, then serial calls one at
   * a time. Results are returned in the original `toolUses` order so
   * they line up with the assistant turn's tool_use blocks.
   */
  async function runToolBatch(
    toolUses: ReadonlyArray<TsmToolUseBlock>,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    const partition = partitionToolCalls(toolUses, (n) => toolByName.get(n));
    runContext.logger.debug("tool partition", {
      concurrent: partition.concurrent.map((b) => b.length),
      serial: partition.serial.length,
    });
    const byId = new Map<string, Anthropic.ToolResultBlockParam>();
    for (const batch of partition.concurrent) {
      const settled = await Promise.all(batch.map((tu) => executeOneToolUse(tu)));
      for (const r of settled) byId.set(r.tool_use_id, r);
    }
    for (const tu of partition.serial) {
      const r = await executeOneToolUse(tu);
      byId.set(r.tool_use_id, r);
    }
    return toolUses.map((tu) => {
      const r = byId.get(tu.id);
      if (r === undefined) {
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: "internal error: missing tool result",
          is_error: true,
        };
      }
      return r;
    });
  }

  /**
   * Convert a freshly-detected loop into a synthetic user message that
   * nudges the model to break the cycle. Returns `null` if no loop is
   * currently detected, or if this signature has already produced a
   * warning earlier in the run.
   */
  function maybeBuildLoopWarning(): Anthropic.MessageParam | null {
    const detection: LoopDetection | null = detectLoop(toolUseHistory);
    if (detection === null) return null;
    if (warnedLoopSignatures.has(detection.signature)) return null;
    warnedLoopSignatures.add(detection.signature);
    runContext.logger.warn("tool loop detected", {
      signature: detection.signature,
      toolName: detection.toolName,
      count: detection.count,
    });
    return {
      role: "user",
      content: `[runtime] possible loop detected: tool "${detection.toolName}" has been called ${detection.count} times with the same input within the last ${detection.windowSize} calls. Reconsider before repeating; respond with a different approach or final text.`,
    };
  }

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
    let recovery: RecoveryState = initialRecoveryState;

    while (state.kind !== "Done") {
      if (turnAbort.signal.aborted) {
        state = transition(state, { kind: "Aborted" });
        continue;
      }

      switch (state.kind) {
        case "NeedModel": {
          process.stdout.write("agent> ");
          try {
            const stream = client.messages.stream(
              {
                model: opts.model,
                max_tokens: maxTokens,
                system: systemBlocks,
                messages,
                ...(anthropicTools ? { tools: anthropicTools } : {}),
              },
              { signal: turnAbort.signal },
            );

            stream.on("text", (chunk) => {
              process.stdout.write(chunk);
            });

            if (opts.streaming) {
              // Streaming path: dispatch tools mid-stream so they start
              // running as soon as their args are complete-and-valid. We
              // pass `executeOneToolUse` as the `runTool` so permissions,
              // per-tool abort, and result-store wrapping all flow
              // through the same helper as the non-streaming path.
              const { finalContent, toolResults } = await executeStreaming(stream, {
                toolByName,
                abortSignal: turnAbort.signal,
                runTool: (block) =>
                  executeOneToolUse({
                    id: block.id,
                    name: block.name,
                    input: block.input,
                  }),
                onEvent: (e) => {
                  runContext.logger.debug("streaming-tool", { ...e });
                },
              });
              process.stdout.write("\n");

              messages.push({
                role: "assistant",
                content: finalContent as Anthropic.MessageParam["content"],
              });
              terminalContent = [...finalContent];

              const toolUses = finalContent.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
              );
              if (toolUses.length === 0) {
                state = transition(state, { kind: "ModelReturnedText" });
                break;
              }

              for (const tu of toolUses) {
                toolUseHistory.push({ id: tu.id, name: tu.name, input: tu.input });
              }
              messages.push({ role: "user", content: [...toolResults] });
              const warning = maybeBuildLoopWarning();
              if (warning !== null) messages.push(warning);

              // Synthesize the two transitions the state machine expects:
              // tools have already executed during the stream so we
              // collapse ModelReturnedToolUse → ToolsExecuted into a
              // single hop back to NeedModel.
              const tsmBlocks: TsmToolUseBlock[] = toolUses.map((t) => ({
                id: t.id,
                name: t.name,
                input: t.input,
              }));
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
              state = transition(state, { kind: "ToolsExecuted" });
              break;
            }

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

            // Synthetic max_output_tokens recovery: stop_reason "max_tokens"
            // means the model was cut off mid-reply. Route through the
            // recovery state machine so we ask it to continue.
            if (final.stop_reason === "max_tokens") {
              lastErrorForRecovery = {
                name: "MaxTokensError",
                error: { type: "max_output_tokens" },
                message: "stop_reason: max_tokens",
              };
              state = transition(state, {
                kind: "RecoverableError",
                error: { name: "MaxTokensError", message: "stop_reason: max_tokens" },
              });
              break;
            }

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
              for (const tu of tsmBlocks) toolUseHistory.push(tu);
              state = transition(state, { kind: "ModelReturnedToolUse", toolUses: tsmBlocks });
            }
          } catch (err) {
            if (isAbortError(err)) {
              state = transition(state, { kind: "Aborted" });
              break;
            }
            lastErrorForRecovery = err;
            const errObj = err as { name?: unknown; message?: unknown };
            state = transition(state, {
              kind: "RecoverableError",
              error: {
                name: typeof errObj.name === "string" ? errObj.name : "Error",
                message: typeof errObj.message === "string" ? errObj.message : String(err),
              },
            });
          }
          break;
        }

        case "NeedTools": {
          const toolResults = await runToolBatch(state.toolUses);
          messages.push({ role: "user", content: toolResults });
          const warning = maybeBuildLoopWarning();
          if (warning !== null) messages.push(warning);
          state = transition(state, { kind: "ToolsExecuted" });
          break;
        }

        case "NeedCompaction":
          // Reserved: pre-turn compaction is run outside the state machine;
          // the recovery branch handles in-turn reactive compaction inline.
          state = transition(state, { kind: "CompactionDone" });
          break;

        case "NeedRecovery": {
          const action = recover(lastErrorForRecovery, recovery);
          recovery = advanceState(recovery, action);
          runContext.logger.info("recovery.action", {
            kind: action.kind,
            errorName: state.error.name,
            recoveryDepth: recovery.retryCount + recovery.compactCount + recovery.continueCount,
          });
          switch (action.kind) {
            case "compact": {
              const compacted = await forceCompact({
                messages,
                client,
                model: opts.model,
                snipKeepHead,
                snipKeepTail,
                logger: runContext.logger,
              });
              messages.length = 0;
              messages.push(...compacted);
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "retry":
              await new Promise((resolve) => setTimeout(resolve, action.delayMs));
              state = transition(state, { kind: "RecoveryDone" });
              break;
            case "continue":
              messages.push({ role: "user", content: "Please continue from where you left off." });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            case "tombstone": {
              const lastIdx = messages.length - 1;
              if (lastIdx >= 0 && messages[lastIdx]?.role === "assistant") {
                messages.pop();
              }
              messages.push({
                role: "user",
                content: "[previous assistant turn was rejected as invalid; please retry]",
              });
              state = transition(state, { kind: "RecoveryDone" });
              break;
            }
            case "fail":
              throw new RuntimeError(`recovery failed: ${action.reason}`);
          }
          break;
        }
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

  // Wire the permission-ask prompter once the readline interface exists.
  // Treats a closed stdin as "deny" so a piped non-interactive input does
  // not stall on the approval prompt.
  askApproval = async (toolName: string, input: unknown): Promise<boolean> => {
    const inputPreview = JSON.stringify(input).slice(0, 200);
    try {
      const result = await Promise.race([
        rl.question(`approve ${toolName} ${inputPreview} [y/N] > `),
        closedSignal,
      ]);
      if (result === STDIN_CLOSED) return false;
      const normalized = result.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return false;
      throw err;
    }
  };

  const authNote = isOAuth ? " [oauth]" : "";
  process.stdout.write(`agent ready (model: ${opts.model})${authNote}. type "exit" to quit.\n`);

  // SIGINT handler: first press during a turn aborts the turn; second
  // press exits. Counter resets at the start of each new turn. Default-on
  // whenever the runtime owns process.stdin (i.e. the test option
  // `opts.input` is unset). Tests that supply their own input stream skip
  // installation so they don't interfere with the test runner's signals.
  const shouldInstallSigint = opts.installSigintHandler ?? opts.input === undefined;
  let sigintPresses = 0;
  const sigintHandler = (): void => {
    sigintPresses += 1;
    if (sigintPresses === 1) {
      process.stdout.write("\n[turn aborted; press Ctrl-C again to exit]\n");
      turnAbort.abort();
    } else {
      process.stdout.write("\n[exiting]\n");
      process.exit(130);
    }
  };
  if (shouldInstallSigint) {
    process.on("SIGINT", sigintHandler);
  }

  try {
    while (true) {
      if (runAbort.signal.aborted) break;

      // Fresh turn-abort tree so a previous turn's abort doesn't bleed in.
      turnAbort = runAbort.child();
      sigintPresses = 0;

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

      try {
        await runOneTurn(messages);
      } catch (err) {
        if (isAbortError(err)) {
          // Already-handled abort; loop back to the prompt.
          process.stdout.write("\n[turn aborted]\n");
        } else {
          throw err;
        }
      }

      runContext.logger.debug("turn end", {
        turn: runContext.turnNumber,
      });
    }
  } finally {
    if (shouldInstallSigint) {
      process.removeListener("SIGINT", sigintHandler);
    }
    rl.close();
  }

  return "";
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" && (name === "AbortError" || name === "APIUserAbortError");
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

type ForceCompactArgs = {
  messages: Anthropic.MessageParam[];
  client: Anthropic;
  model: string;
  snipKeepHead: number;
  snipKeepTail: number;
  logger: RunContext["logger"];
};

/**
 * Reactive compaction triggered by the recovery engine on a prompt_too_long
 * error. Unlike pre-turn `maybeCompact`, this one runs unconditionally:
 * snip first, then autocompact (whose model summary reliably trims the
 * largest blob).
 */
async function forceCompact(args: ForceCompactArgs): Promise<Anthropic.MessageParam[]> {
  const { messages, client, model, snipKeepHead, snipKeepTail, logger } = args;
  const snipped = snip(messages, snipKeepHead, snipKeepTail);
  logger.info("reactive snip applied", { before: messages.length, after: snipped.length });
  return await autoCompact(snipped, client, model);
}
