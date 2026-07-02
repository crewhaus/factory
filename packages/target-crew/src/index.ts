/**
 * Catalog F2 `target-crew` — Section 22.
 *
 * Codegen for the CRW target shape. Mirrors the multi-file pattern from
 * `target-channel-bot`:
 *   - `daemon.ts`     — entrypoint that loads hooks/skills/commands,
 *                       constructs the runnable crew, and serves stdin or
 *                       a webhook.
 *   - `orchestrator.ts` — wires the `Crew` builder to the spec roles +
 *                         entry + routing.
 *   - `agent_<role>.ts` — per-role config wrapper exporting a
 *                         `RoleDefinition` instance for the orchestrator
 *                         to register.
 *
 * The emitted daemon reads input from stdin (one prompt per line) and
 * pipes events to stdout as JSON-per-line so the smoke harness (and any
 * future shell pipeline consumer) can parse them deterministically.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrCrewRole,
  type IrCrewV0,
  renderBundleReadme,
} from "@crewhaus/ir";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Built-in tool name → package + export. Mirrors target-channel-bot's
 * map but excluded `sendMessage` (the channel-bot variant) since CRW
 * roles use `a2a-protocol`'s `SendMessage` automatically wired by the
 * orchestrator.
 */
type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  readImage: { package: "@crewhaus/tool-image", export: "readImage" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
  // §47 read-only EVM tools (slice 0).
  evmCall: { package: "@crewhaus/tool-evm", export: "evmCall" },
  evmGetLogs: { package: "@crewhaus/tool-evm", export: "evmGetLogs" },
  evmGetTransaction: { package: "@crewhaus/tool-evm", export: "evmGetTransaction" },
  evmGetTransactionReceipt: {
    package: "@crewhaus/tool-evm",
    export: "evmGetTransactionReceipt",
  },
  evmGetBalance: { package: "@crewhaus/tool-evm", export: "evmGetBalance" },
  evmBlockNumber: { package: "@crewhaus/tool-evm", export: "evmBlockNumber" },
  // §47 destructive EVM tools (slice 1) — gated by permission-engine
  // (destructive: true) and wallet-engine (two-gate model).
  evmSendTransaction: { package: "@crewhaus/tool-evm-tx", export: "evmSendTransaction" },
  evmSimulate: { package: "@crewhaus/tool-evm-tx", export: "evmSimulate" },
  // Pillar 2 — AST-aware code intelligence (recipe 54).
  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },
  codegraphCallers: { package: "@crewhaus/tool-codegraph", export: "codegraphCallers" },
  codegraphCallees: { package: "@crewhaus/tool-codegraph", export: "codegraphCallees" },
  codegraphImpact: { package: "@crewhaus/tool-codegraph", export: "codegraphImpact" },
};

export function emitCrew(ir: IrCrewV0, opts: EmitReadmeOptions = {}): Bundle {
  if (ir.roles.length === 0) {
    throw new TargetEmitError("crew target requires at least one role");
  }
  const entryRole = ir.roles.find((r) => r.name === ir.entry);
  if (entryRole === undefined) {
    throw new TargetEmitError(
      `crew entry "${ir.entry}" does not match any defined role (got: ${ir.roles
        .map((r) => r.name)
        .join(", ")})`,
    );
  }

  const files = [
    { path: "orchestrator.ts", content: renderOrchestrator(ir) },
    { path: "daemon.ts", content: renderDaemon(ir) },
  ];
  for (const role of ir.roles) {
    files.push({ path: `agent_${safeFileName(role.name)}.ts`, content: renderRoleAgent(ir, role) });
  }
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

function safeFileName(role: string): string {
  // Conservative: keep alnum + underscore so generated paths are clean.
  return role.replace(/[^a-zA-Z0-9_]/g, "_");
}

function resolveTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): {
  imports: string[];
  inits: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };
  const byPackage = new Map<string, Set<string>>();
  const registrations: string[] = [];
  const inits: string[] = [];
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const set = byPackage.get(entry.package) ?? new Set<string>();
    set.add(entry.export);
    byPackage.set(entry.package, set);
    if (entry.initSymbol !== undefined) {
      const cfg = toolConfigs[name];
      if (cfg !== undefined) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
      }
    }
    registrations.push(entry.export);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

function renderPermissionsField(ir: IrCrewV0): string {
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

// ---------------------------------------------------------------------------
// File: agent_<role>.ts — exports the role's RoleDefinition.
// ---------------------------------------------------------------------------

function renderRoleAgent(ir: IrCrewV0, role: IrCrewRole): string {
  const { imports, inits, registrations } = resolveTools(role.tools, role.toolConfigs);
  const importBlock = imports.length > 0 ? `${imports.join("\n")}\n` : "";
  const initLines = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const toolsArrayLiteral = registrations.length > 0 ? `[${registrations.join(", ")}]` : "[]";
  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, role: ${escapeJsonString(role.name)})
${importBlock}import type { RoleDefinition } from "@crewhaus/crew-orchestrator";

${initLines}
export const role: { name: string; def: RoleDefinition } = {
  name: ${escapeJsonString(role.name)},
  def: {
    model: ${escapeJsonString(role.model)},
    instructions: ${escapeJsonString(role.instructions)},
    tools: ${toolsArrayLiteral},
  },
};
`;
}

// ---------------------------------------------------------------------------
// File: orchestrator.ts — composes Crew() from roles + entry + routing.
// ---------------------------------------------------------------------------

function renderOrchestrator(ir: IrCrewV0): string {
  const roleImports = ir.roles
    .map((r) => `import { role as ${roleVar(r.name)} } from "./agent_${safeFileName(r.name)}.js";`)
    .join("\n");
  const adds = ir.roles
    .map((r) => `    .addRole(${roleVar(r.name)}.name, ${roleVar(r.name)}.def)`)
    .join("\n");

  let routerBlock = "";
  if (ir.routing && ir.routing.kind === "match" && ir.routing.match !== undefined) {
    const tableLit = JSON.stringify(ir.routing.match, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    routerBlock = `
  const __routingTable: Record<string, ReadonlyArray<{ contains: string; to: string }>> =
${tableLit};
  builder.setRouting(({ input, lastRole }) => {
    if (lastRole === undefined) return ${escapeJsonString(ir.entry)};
    const rules = __routingTable[lastRole] ?? [];
    for (const r of rules) {
      if (input.includes(r.contains)) return r.to;
    }
    return lastRole;
  });`;
  }

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: orchestrator.ts)
import { Crew, type RunnableCrew } from "@crewhaus/crew-orchestrator";
${roleImports}

export function buildCrew(): RunnableCrew {
  const builder = Crew()
    .setName(${escapeJsonString(ir.name)})
${adds}
    .setEntry(${escapeJsonString(ir.entry)});${routerBlock}
  return builder.compile();
}
`;
}

function roleVar(name: string): string {
  return `__role_${safeFileName(name)}`;
}

// ---------------------------------------------------------------------------
// File: daemon.ts — entrypoint. Reads stdin, drives the crew, prints events.
// ---------------------------------------------------------------------------

function renderDaemon(ir: IrCrewV0): string {
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: daemon.ts)
${permImport}import { buildCrew } from "./orchestrator.js";

async function main(): Promise<void> {
  const crew = buildCrew();
  const input = await readAllStdin();
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    process.stderr.write("[crew] no input on stdin\\n");
    process.exit(2);
  }
  const opts: Parameters<typeof crew.run>[1] = {${permField}
  };
  let lastFinalOutput = "";
  try {
    for await (const ev of crew.run(trimmed, opts)) {
      process.stdout.write(\`\${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "crew_done") lastFinalOutput = ev.finalOutput;
    }
  } catch (err) {
    process.stderr.write(\`[crew] error: \${(err as Error).message}\\n\`);
    process.exit(1);
  }
  if (lastFinalOutput.length > 0) {
    const PREVIEW_LIMIT = 200;
    const preview =
      lastFinalOutput.length > PREVIEW_LIMIT
        ? \`\${lastFinalOutput.slice(0, PREVIEW_LIMIT)}… [preview truncated; full output (\${lastFinalOutput.length} chars) is on stdout in the crew_done event]\`
        : lastFinalOutput;
    process.stderr.write(\`[crew] final: \${preview}\\n\`);
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

main().catch((err) => {
  process.stderr.write(\`[crew] fatal: \${(err as Error).message}\\n\`);
  process.exit(1);
});
`;
}
