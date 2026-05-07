/**
 * v0 IR — runtime-agnostic representation, target-tagged.
 * In the slice, IR shape mirrors the spec; later passes (ir-passes module)
 * will perform optimization and target-specific lowering.
 */
export type IrPermissionRule = {
  readonly type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk";
  readonly pattern: string;
};

/**
 * Permissions config carried through to codegen. The mode here cannot be
 * "bypass" — that's enforced by the spec parser. Bypass enters via CLI flag.
 */
export type IrPermissions = {
  readonly mode?: "default" | "plan" | "auto";
  readonly rules: readonly IrPermissionRule[];
};

/**
 * MCP server configs carried through to codegen (Section 9). Lower-time
 * normalisation: optional spec fields become required IR fields with
 * empty defaults, so target codegen doesn't need `?? []` guards.
 */
export type IrMcpStdioConfig = {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

export type IrMcpSseConfig = {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type IrMcpServerConfig = IrMcpStdioConfig | IrMcpSseConfig;
export type IrMcpServers = Readonly<Record<string, IrMcpServerConfig>>;

export type IrV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "cli";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
  };
  readonly tools: readonly string[];
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
};

/**
 * One step in a workflow IR. `model` is resolved at lower-time
 * (`step.model ?? workflow.model`) so codegen can read it directly.
 */
export type IrWorkflowStep = {
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly tools: readonly string[];
};

/**
 * Workflow IR — a sequence of steps. Each step runs as one user→assistant
 * turn; the prior step's terminal assistant text is threaded into the next
 * step's user message by the generated runtime (target-workflow).
 */
export type IrWorkflowV0 = {
  readonly version: 0;
  readonly name: string;
  readonly target: "workflow";
  readonly steps: readonly IrWorkflowStep[];
  readonly mcp_servers: IrMcpServers;
  readonly permissions: IrPermissions;
};

/** Discriminated union over every supported target IR. */
export type IrNode = IrV0 | IrWorkflowV0;

/**
 * The output of compilation: a set of files to be written to disk by the
 * bundle-packager (slice: written directly by the CLI app).
 */
export type Bundle = {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
};
