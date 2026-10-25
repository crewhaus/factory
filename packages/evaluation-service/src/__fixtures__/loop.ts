/**
 * Fixtures for the tests that drive the composition root's gates through the
 * LIVE `runChatLoop` (loop.test.ts, acceptance.test.ts): a scripted model
 * adapter, the support-bot page and a WebFetch stand-in that serves it, and
 * one completed turn run the way a compiled bundle or `crewhaus run` runs it.
 * Kept under `__fixtures__/` so the build excludes it and the runtime
 * tool-name scan never reads its fake tools (scripts/test-only.ts).
 */
import { createLogger } from "@crewhaus/logging";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { mergeGateTools } from "../tools";
import type { wireEvaluation } from "../wire";

export type Adapter = NonNullable<Parameters<typeof runChatLoop>[0]["_adapter"]>;
export type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

/**
 * One scripted model reply: fixed content, or content computed from the
 * request's messages (serialized), so a reply can cite an id an earlier tool
 * result minted.
 */
export type Script = ReadonlyArray<Block> | ((messages: string) => ReadonlyArray<Block>);

export type ScriptedModel = Adapter & {
  /** The tool names each request advertised, in call order. */
  readonly toolNames: string[][];
  /** Each request's messages, serialized, in call order. */
  readonly requests: string[];
  calls(): number;
};

/** A model that answers each call with the next scripted content (the last repeats). */
export function scriptedModel(scripts: ReadonlyArray<Script>): ScriptedModel {
  let i = 0;
  const toolNames: string[][] = [];
  const requests: string[] = [];
  const adapter = {
    toolNames,
    requests,
    calls: () => i,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req: { tools?: ReadonlyArray<{ name: string }>; messages?: unknown }) {
      toolNames.push((req.tools ?? []).map((t) => t.name));
      const messages = JSON.stringify(req.messages ?? []);
      requests.push(messages);
      const script = scripts[Math.min(i, scripts.length - 1)] ?? [];
      const content = typeof script === "function" ? script(messages) : script;
      i += 1;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" };
        for (let idx = 0; idx < content.length; idx += 1) {
          const block = content[idx] as Block;
          if (block.type === "text") {
            yield { kind: "content_block_start", index: idx, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            };
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
            };
          }
          yield { kind: "content_block_stop", index: idx };
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
  return adapter as unknown as ScriptedModel;
}

export const URL_A = "https://acme.example/policy";
export const PAGE = `URL: ${URL_A}\nStatus: 200\nContent-Type: text/html\n\nThe refund window is 14 days from the date of purchase.`;

/** A WebFetch stand-in: the builtin reader's name and input, a fixed page, no network. */
export const webFetch: RegisteredTool = buildTool({
  name: "WebFetch",
  description: "fetch a page",
  inputSchema: z.object({ url: z.string() }).strict(),
  readOnly: true,
  concurrencySafe: true,
  execute: async () => PAGE,
});

export async function runTurn(opts: {
  readonly model: Adapter;
  readonly tools: ReadonlyArray<RegisteredTool>;
  readonly gates: Awaited<ReturnType<typeof wireEvaluation>>;
  readonly sessionRootDir: string;
  /** Default `bypass`; `default` runs the bundles' own permission floor (builtin rules only). */
  readonly permissionMode?: "bypass" | "default";
  readonly extra?: Partial<Parameters<typeof runChatLoop>[0]>;
  /**
   * The process's working directory for the run — where everything the
   * runtime roots at the cwd lands (the tool-result spill store). Restored
   * after; absent ⇒ unchanged.
   */
  readonly cwd?: string;
  /** The session to run in; with `resume`, the run continues it (a channel thread's next message). */
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly seed?: string;
  /**
   * Every trace event, as it is published: any egress screen's verdicts,
   * permission decisions and HEADs land here too, and so do a halted run's
   * events, which never reach the returned value.
   */
  readonly onEvent?: (event: TraceEvent) => void;
  /** Every chunk the run writes to its output, as it is written — a halted run's included. */
  readonly onStdout?: (chunk: string) => void;
}) {
  const runContext = createRunContext({
    logger: createLogger({ level: "error", format: "json", sink: () => {} }),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((event) => {
    events.push(event);
    opts.onEvent?.(event);
  });
  const stdout: string[] = [];
  const home = process.cwd();
  if (opts.cwd !== undefined) process.chdir(opts.cwd);
  const result = await runChatLoop({
    model: "test-model",
    instructions: "cite everything",
    runContext,
    sessionRootDir: opts.sessionRootDir,
    singleTurn: true,
    seedMessages: [{ role: "user", content: opts.seed ?? "what is the refund window?" }],
    ...(opts.resume === true ? { resume: { sessionId: runContext.sessionId } } : {}),
    permissionMode: opts.permissionMode ?? "bypass",
    spinner: false,
    stdout: (s) => {
      stdout.push(s);
      opts.onStdout?.(s);
    },
    _adapter: opts.model,
    tools: mergeGateTools(opts.tools, opts.gates),
    ...(opts.gates.evaluation !== undefined ? { evaluation: opts.gates.evaluation } : {}),
    ...(opts.gates.provability !== undefined ? { provability: opts.gates.provability } : {}),
    ...opts.extra,
  }).finally(() => {
    if (opts.cwd !== undefined) process.chdir(home);
  });
  const graded = events.filter((e) => e.kind === "provability_graded") as Array<
    TraceEvent & { verdict: string; retryIndex: number }
  >;
  const decisions = events.filter((e) => e.kind === "permission_decision") as Array<
    TraceEvent & { toolName: string; decision: string; outcome?: string }
  >;
  return {
    result,
    sessionId: runContext.sessionId,
    runId: runContext.runId,
    graded,
    decisions,
    stdout: stdout.join(""),
  };
}
