import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrV0 } from "@crewhaus/ir";

/**
 * Emit a self-contained CLI agent bundle for a CLI-target IR.
 * Slice scope: a single agent.ts that imports @crewhaus/runtime-core and
 * runs a streaming chat loop with the configured model and instructions.
 *
 * Tool support (Section 2): when ir.tools is non-empty, the emitted agent
 * imports each tool from its built-in package, registers them on the default
 * catalog, and threads catalog.list() into runChatLoop. Unknown tool names
 * fail at compile time via TargetEmitError.
 *
 * Future expansion (per catalog F2 target-cli-bundle): hooks, MCP config,
 * settings.json, multi-file output, bundling for distribution.
 */
export function emitCli(ir: IrV0): Bundle {
  return {
    files: [
      {
        path: "agent.ts",
        content: renderAgent(ir),
      },
    ],
  };
}

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Built-in tool name → package + export. Section 2 seeds this with every
 * Section-3 tool so the convention is documented; the actual packages ship
 * incrementally (currently none — generated agents that reference these
 * names will fail at install time until Section 3 lands).
 *
 * Mirror: `loadToolMap()` in apps/cli/src/index.ts maps the same names to
 * RegisteredTool instances for `crewhaus run`. Keep both maps in sync.
 */
const BUILTIN_TOOL_MAP: Record<string, { package: string; export: string }> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
};

function resolveTools(toolNames: readonly string[]): {
  imports: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], registrations: [] };

  // Group exports by package for one grouped import per package.
  const byPackage = new Map<string, string[]>();
  const registrations: string[] = [];
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const list = byPackage.get(entry.package) ?? [];
    list.push(entry.export);
    byPackage.set(entry.package, list);
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }

  const imports: string[] = [`import { defaultCatalog } from "@crewhaus/tool-catalog";`];
  for (const pkg of [...byPackage.keys()].sort()) {
    const exports = (byPackage.get(pkg) ?? []).slice().sort();
    imports.push(`import { ${exports.join(", ")} } from "${pkg}";`);
  }
  return { imports, registrations };
}

function renderPermissionsField(ir: IrV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`  permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `      { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "  permissionRules: {",
        "    flag: [],",
        "    settings: [],",
        "    yaml: [",
        ruleLits,
        "    ],",
        "    hooks: [],",
        "    builtin: BUILTIN_DEFAULT_RULES,",
        "  },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/**
 * Section 9 — emit `McpHost` boot block when the IR carries mcp_servers.
 * Returns three optional pieces: imports (added to the top of the file),
 * a boot block that constructs the host + registers each server (placed
 * before runChatLoop), and a cleanup statement (run inside a finally).
 *
 * Empty `mcp_servers` returns empty strings so spec files without MCP get
 * the original bare `await runChatLoop(...)` shape (regression guard for
 * the hello-cli example).
 */
function renderMcpServers(ir: IrV0): {
  imports: string[];
  bootBlock: string;
  cleanupBlock: string;
  hasAny: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", cleanupBlock: "", hasAny: false };
  }
  const imports = [
    `import { McpHost } from "@crewhaus/mcp-host";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(([name, cfg]) => `mcpHost.addServer(${escapeJsonString(name)}, ${JSON.stringify(cfg)});`)
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `  registerMcpServer(mcpHost, ${escapeJsonString(name)}, defaultCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = [
    "const mcpHost = new McpHost();",
    addLines,
    "await Promise.all([",
    registerLines,
    "]);",
  ].join("\n");
  return {
    imports,
    bootBlock,
    cleanupBlock: "await mcpHost.disconnectAll();",
    hasAny: true,
  };
}

function renderAgent(ir: IrV0): string {
  const { imports: builtinImports, registrations } = resolveTools(ir.tools);
  const mcp = renderMcpServers(ir);
  // The catalog import is needed when either built-in tools OR MCP servers
  // are in play. resolveTools() already prepends it for the built-in case;
  // we add it explicitly when MCP is the only consumer.
  const needsCatalogImport = ir.tools.length === 0 && mcp.hasAny;
  const catalogImport = needsCatalogImport
    ? `import { defaultCatalog } from "@crewhaus/tool-catalog";\n`
    : "";
  const importBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";
  const registerBlock = registrations.length > 0 ? `\n${registrations.join("\n")}\n` : "";
  // tools: defaultCatalog.list() is needed when EITHER built-ins or MCP
  // tools land in the catalog at boot.
  const advertiseTools = ir.tools.length > 0 || mcp.hasAny;
  const toolsField = advertiseTools ? "\n  tools: defaultCatalog.list()," : "";

  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);

  const mcpBoot = mcp.hasAny ? `${mcp.bootBlock}\n\n` : "";
  const runChatLoopCall = `await runChatLoop({
  model: ${escapeJsonString(ir.agent.model)},
  instructions: ${escapeJsonString(ir.agent.instructions)},${toolsField}${permField}
});`;
  const wrapped = mcp.hasAny
    ? `try {
  ${runChatLoopCall.split("\n").join("\n  ")}
} finally {
  ${mcp.cleanupBlock}
}`
    : runChatLoopCall;

  return `#!/usr/bin/env bun
// Generated by crewhaus-factory. DO NOT EDIT.
// Source spec: ${ir.name} (target: cli, ir version: ${ir.version})
import { runChatLoop } from "@crewhaus/runtime-core";
${permImport}${importBlock}${catalogImport}${mcpImportBlock}${registerBlock}
${mcpBoot}${wrapped}
`;
}
