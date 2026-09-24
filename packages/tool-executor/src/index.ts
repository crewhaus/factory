import { CrewhausError, isRunFailedError } from "@crewhaus/errors";
import type { RegisteredTool, ToolExecuteModel, ToolExecuteResult } from "@crewhaus/tool-catalog";
import { compilePattern, matchesPattern } from "@crewhaus/tool-permission-matcher";
import { validateToolInput } from "@crewhaus/tool-validate";
import { type PathCanonicalizer, operativeValuesFor } from "./permission-subject";

export {
  type PathCanonicalizer,
  type PermissionSubject,
  type PermissionSubjectOptions,
  lexicalPathValues,
  operativeValuesFor,
  preparePermissionSubject,
  readOperativeField,
} from "./permission-subject";

/**
 * Section 14 — `content` widened from `string` to `string | ToolResultContent`
 * so tools like `ReadImage` can return Anthropic image content blocks. Error
 * paths still produce a string (validation message, permission refusal,
 * thrown-error.message) — the union is only meaningful on the success path.
 */
export type ToolResult = {
  readonly toolUseId: string;
  readonly content: ToolExecuteResult;
  readonly isError: boolean;
};

export type ExecutionContext = {
  readonly toolUseId: string;
  /**
   * When present, the tool call must match at least one pattern, read as an
   * allow rule: every operative value of the PARSED input must match its
   * argument glob. Absent = allow all.
   */
  readonly allowedPatterns?: ReadonlyArray<string>;
  /**
   * How a path-kind operative value is canonicalised for `allowedPatterns`.
   * Default: {@link lexicalPathValues}, which needs no filesystem. A Node
   * caller that has a workspace passes one that also follows symlinks.
   */
  readonly canonicalizePath?: PathCanonicalizer;
  /** Optional cooperative-cancellation signal forwarded to the tool. */
  readonly signal?: AbortSignal;
  /**
   * Section 13 — opaque runtime bridge forwarded into the tool's
   * `ToolExecuteContext.bridge`. Framework-aware tools (the Task tool) cast
   * it; ordinary tools ignore it.
   */
  readonly bridge?: unknown;
  /**
   * Section 18 — runtime-core supplies this so streaming tools
   * (`tool-code-execution`) can forward stdout/stderr chunks to the trace
   * bus as `tool_stream_chunk` events.
   */
  readonly onStreamChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * 0.6.0 §4.4 — the serving model (pool runs only) and this tool's
   * per-candidate `tool_config` override, forwarded verbatim into the tool's
   * `ToolExecuteContext.model` / `.toolConfig`. Both presence-gated: a call
   * without them hands the tool the exact pre-0.6.0 context.
   */
  readonly model?: ToolExecuteModel;
  readonly toolConfig?: unknown;
};

export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  constructor(toolName: string) {
    super("tool", `tool "${toolName}" is not permitted by the current permission set`);
    this.toolName = toolName;
  }
}

export async function executeTool(
  tool: RegisteredTool,
  rawInput: unknown,
  context: ExecutionContext,
): Promise<ToolResult> {
  const { toolUseId, allowedPatterns } = context;

  const validation = validateToolInput(tool, rawInput);
  if (!validation.ok) {
    return { toolUseId, content: validation.error.message, isError: true };
  }

  if (allowedPatterns !== undefined) {
    // Match what the tool will run on — the parsed input, with its operative
    // values canonicalised — never the raw input, which can carry a decoy key
    // the schema strips (#145, security-1#0).
    const compiled = allowedPatterns.map(compilePattern);
    const operativeValues = operativeValuesFor(
      tool,
      validation.value,
      context.canonicalizePath !== undefined ? { canonicalizePath: context.canonicalizePath } : {},
    );
    const permitted = compiled.some((p) =>
      matchesPattern(p, tool.name, validation.value, {
        polarity: "allow",
        ...(operativeValues !== undefined ? { operativeValues } : {}),
      }),
    );
    if (!permitted) {
      return {
        toolUseId,
        content: new ToolPermissionError(tool.name).message,
        isError: true,
      };
    }
  }

  try {
    const content = await tool.execute(validation.value, {
      signal: context.signal,
      ...(context.bridge !== undefined ? { bridge: context.bridge } : {}),
      ...(context.onStreamChunk !== undefined ? { onStreamChunk: context.onStreamChunk } : {}),
      ...(context.model !== undefined ? { model: context.model } : {}),
      ...(context.toolConfig !== undefined ? { toolConfig: context.toolConfig } : {}),
    });
    return { toolUseId, content, isError: false };
  } catch (err) {
    // v0.3.0 §7.1 — a RunFailedError is a terminal RUN verdict (e.g. a
    // sub-agent's billing/auth failure escalated by the spawner), not a
    // tool error: let it propagate so the run halts with its classified
    // report instead of dissolving into an is_error string the model
    // would try to talk its way past.
    if (isRunFailedError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { toolUseId, content: msg, isError: true };
  }
}
