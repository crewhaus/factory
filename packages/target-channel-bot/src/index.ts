import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrChannelV0, IrSecretRef, IrSubAgentDefinition } from "@crewhaus/ir";

/**
 * Emit a self-contained channel-bot bundle for a channel-target IR.
 *
 * First codegen target that produces multiple files: a daemon entrypoint,
 * a channel-generic gateway, a session router (resumes per-thread sessions
 * and runs one runChatLoop turn per inbound message), and an agent config
 * wrapper.
 *
 * Secret handling: when a secret field in the spec was an env-reference
 * (`$VAR_NAME`), the IR carries `{ kind: "env", name }` and codegen emits
 * `process.env.VAR_NAME`. Plus a startup-time check exits non-zero if any
 * required env-ref is unset, so the daemon never accepts webhooks signed
 * with an empty secret.
 */
export function emitChannelBot(ir: IrChannelV0): Bundle {
  if (
    ir.channels.slack === undefined &&
    ir.channels.telegram === undefined &&
    ir.channels.discord === undefined &&
    ir.channels.whatsapp === undefined
  ) {
    throw new TargetEmitError(
      "channel target requires at least one configured channel — none found",
    );
  }
  return {
    files: [
      { path: "agent.ts", content: renderAgent(ir) },
      { path: "session-router.ts", content: renderSessionRouter(ir) },
      { path: "gateway.ts", content: renderGateway() },
      { path: "daemon.ts", content: renderDaemon(ir) },
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
 * Built-in tool name → package + export. Mirror of the target-cli /
 * target-workflow maps, plus `sendMessage` (the channel-target's
 * cross-channel addressing tool from Section 12).
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
  sendMessage: { package: "@crewhaus/tool-message-channel", export: "sendMessage" },
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
};

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
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

/**
 * Render a single secret reference as a JS expression. Env-refs become
 * `process.env.NAME`; literals become escaped string literals.
 */
function renderSecretExpr(ref: IrSecretRef): string {
  if (ref.kind === "env") return `process.env[${escapeJsonString(ref.name)}]`;
  return escapeJsonString(ref.value);
}

/**
 * Render the env-name list referenced by all required Slack secret fields.
 * The daemon's startup-check exits non-zero if any is unset.
 */
function requiredEnvNames(ir: IrChannelV0): string[] {
  const names: string[] = [];
  const slack = ir.channels.slack;
  if (slack !== undefined) {
    if (slack.botToken.kind === "env") names.push(slack.botToken.name);
    if (slack.signingSecret.kind === "env") names.push(slack.signingSecret.name);
    // appToken is optional — we don't enforce it at startup.
  }
  const telegram = ir.channels.telegram;
  if (telegram !== undefined) {
    if (telegram.botToken.kind === "env") names.push(telegram.botToken.name);
    if (telegram.secretToken.kind === "env") names.push(telegram.secretToken.name);
  }
  const discord = ir.channels.discord;
  if (discord !== undefined) {
    if (discord.applicationId.kind === "env") names.push(discord.applicationId.name);
    if (discord.botToken.kind === "env") names.push(discord.botToken.name);
    if (discord.publicKeyHex.kind === "env") names.push(discord.publicKeyHex.name);
  }
  const whatsapp = ir.channels.whatsapp;
  if (whatsapp !== undefined) {
    if (whatsapp.phoneNumberId.kind === "env") names.push(whatsapp.phoneNumberId.name);
    if (whatsapp.accessToken.kind === "env") names.push(whatsapp.accessToken.name);
    if (whatsapp.appSecret.kind === "env") names.push(whatsapp.appSecret.name);
  }
  return names;
}

function renderPermissionsField(ir: IrChannelV0): string {
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

/** Render one IrSubAgentDefinition as a TS object literal — mirrors target-cli. */
function renderSubAgentDef(d: IrSubAgentDefinition): string {
  const lines: string[] = [];
  lines.push(`name: ${escapeJsonString(d.name)}`);
  lines.push(`description: ${escapeJsonString(d.description)}`);
  lines.push(`instructions: ${escapeJsonString(d.instructions)}`);
  lines.push(`tools: ${JSON.stringify(d.tools)}`);
  if (d.model !== undefined) lines.push(`model: ${escapeJsonString(d.model)}`);
  if (typeof d.permissions === "string") {
    lines.push(`permissions: ${escapeJsonString(d.permissions)}`);
  } else {
    lines.push(
      `permissions: { allow: ${JSON.stringify(d.permissions.allow)}, deny: ${JSON.stringify(d.permissions.deny)} }`,
    );
  }
  lines.push(`inherit_bypass: ${d.inheritBypass}`);
  return `{ ${lines.join(", ")} }`;
}

function renderSubAgents(ir: IrChannelV0): {
  imports: string[];
  registryBlock: string;
  registerBlock: string;
  hasAny: boolean;
} {
  if (ir.subAgents.length === 0) {
    return { imports: [], registryBlock: "", registerBlock: "", hasAny: false };
  }
  const imports = [
    `import { createTaskTool } from "@crewhaus/tool-task";`,
    `import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";`,
    `import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";`,
  ];
  const entries = ir.subAgents
    .map((d) => `    [${escapeJsonString(d.name)}, ${renderSubAgentDef(d)}],`)
    .join("\n");
  const registryBlock = `  const __subAgents: ReadonlyMap<string, SubAgentDefinition> = new Map<string, SubAgentDefinition>([\n${entries}\n  ]);`;
  const registerBlock = "  defaultCatalog.register(createTaskTool({ subAgents: __subAgents }));";
  return { imports, registryBlock, registerBlock, hasAny: true };
}

function renderMcpServers(ir: IrChannelV0): {
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

// ---------------------------------------------------------------------------
// File 1: agent.ts — runChatLoop config wrapper.
// ---------------------------------------------------------------------------

function renderAgent(ir: IrChannelV0): string {
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);
  const hasSubAgents = ir.subAgents.length > 0;
  const subAgentTypeImport = hasSubAgents
    ? `import type { SubAgentDefinition, SpawnSubAgentFn } from "@crewhaus/agent-context-isolation";\n`
    : "";
  const subAgentConfigFields = hasSubAgents
    ? "  subAgents: ReadonlyMap<string, SubAgentDefinition>;\n  spawnSubAgent: SpawnSubAgentFn;\n"
    : "";
  const subAgentRunFields = hasSubAgents
    ? "\n        subAgents: config.subAgents,\n        spawnSubAgent: config.spawnSubAgent,"
    : "";

  return `// Generated by crewhaus-factory. DO NOT EDIT.
// Source spec: ${ir.name} (target: channel, ir version: ${ir.version}, file: agent.ts)
import { runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
${permImport}${subAgentTypeImport}import type { HookDef } from "@crewhaus/hooks-engine";
import type { SkillRef } from "@crewhaus/skills-registry";
import type { SlashCommand } from "@crewhaus/slash-commands";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

export type AgentConfig = {
  hooks: ReadonlyArray<HookDef>;
  skills: ReadonlyArray<SkillRef>;
  slashCommands: ReadonlyMap<string, SlashCommand>;
  tools: ReadonlyArray<RegisteredTool>;
  sessionRootDir?: string;
${subAgentConfigFields}};

export type RunTurnArgs = {
  sessionId: string;
  isNew: boolean;
  message: string;
};

export type Agent = {
  runTurn(args: RunTurnArgs): Promise<string>;
};

export function createAgent(config: AgentConfig): Agent {
  return {
    async runTurn(args: RunTurnArgs): Promise<string> {
      const runContext = createRunContext({ sessionId: args.sessionId });
      return await runChatLoop({
        model: ${escapeJsonString(ir.agent.model)},
        instructions: ${escapeJsonString(ir.agent.instructions)},
        sessionName: ${escapeJsonString(ir.name)},
        sessionTarget: "channel",
        ...(config.sessionRootDir !== undefined ? { sessionRootDir: config.sessionRootDir } : {}),
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: args.message }],
        ...(args.isNew ? {} : { resume: { sessionId: args.sessionId } }),
        tools: config.tools,
        hooks: config.hooks,
        skills: config.skills,
        slashCommands: config.slashCommands,${permField}${subAgentRunFields}
      });
    },
  };
}
`;
}

// ---------------------------------------------------------------------------
// File 2: session-router.ts — routes inbound events to per-session turns.
// ---------------------------------------------------------------------------

function renderSessionRouter(ir: IrChannelV0): string {
  const sessionKey = ir.routing.sessionKey;
  // Build the routing-key expression based on the configured strategy.
  const routingKeyExpr =
    sessionKey === "thread"
      ? "`${adapter.id}:${event.workspaceId}:${event.channelId}:${event.threadTs ?? event.ts}`"
      : sessionKey === "user"
        ? "`${adapter.id}:${event.workspaceId}:${event.userId}`"
        : "`${adapter.id}:${event.workspaceId}:${event.channelId}`";

  return `// Generated by crewhaus-factory. DO NOT EDIT.
// Source spec: ${ir.name} (target: channel, ir version: ${ir.version}, file: session-router.ts)
import { createHash } from "node:crypto";
import { createSessionStore } from "@crewhaus/session-store";
import type { ChannelAdapter, InboundEvent } from "@crewhaus/channel-adapter-slack";
import type { Agent } from "./agent.js";

export type SessionRouterConfig = {
  agent: Agent;
  sessionRootDir?: string;
};

export type SessionRouter = {
  handle(event: InboundEvent, adapter: ChannelAdapter): Promise<void>;
};

/**
 * Derive a deterministic sess_<16hex> id from a routing key. sha256 →
 * hex → first 16 chars → prefix with sess_. Keeps the channel session
 * id stable across daemon restarts for the same thread/user/channel.
 */
function deriveSessionId(routingKey: string): string {
  return "sess_" + createHash("sha256").update(routingKey).digest("hex").slice(0, 16);
}

export function createSessionRouter(config: SessionRouterConfig): SessionRouter {
  const sessionStore = createSessionStore(
    config.sessionRootDir !== undefined ? { rootDir: config.sessionRootDir } : {},
  );
  return {
    async handle(event: InboundEvent, adapter: ChannelAdapter): Promise<void> {
      const routingKey = ${routingKeyExpr};
      const sessionId = deriveSessionId(routingKey);
      const existing = await sessionStore.get(sessionId);
      const isNew = existing === null;
      if (isNew) {
        await sessionStore.create({
          id: sessionId,
          name: routingKey,
          target: "channel",
          model: ${escapeJsonString(ir.agent.model)},
        });
      }
      const reply = await config.agent.runTurn({ sessionId, isNew, message: event.text });
      if (reply.length > 0) {
        await adapter.sendReply({ event, text: reply });
      }
    },
  };
}
`;
}

// ---------------------------------------------------------------------------
// File 3: gateway.ts — channel-generic HTTP request handler.
// ---------------------------------------------------------------------------

function renderGateway(): string {
  return `// Generated by crewhaus-factory. DO NOT EDIT.
// Channel-generic gateway: dispatches signed webhooks to the matching adapter.
import type { ChannelAdapter } from "@crewhaus/channel-adapter-slack";
import type { SessionRouter } from "./session-router.js";

export type GatewayConfig = {
  adapters: ReadonlyMap<string, ChannelAdapter>;
  sessionRouter: SessionRouter;
  /** Maximum number of inbound idempotency keys remembered before LRU eviction. */
  dedupCapacity?: number;
};

export type Gateway = {
  handle(req: Request): Promise<Response>;
};

export function createGateway(config: GatewayConfig): Gateway {
  const dedupCapacity = config.dedupCapacity ?? 10_000;
  // Bounded LRU set keyed by adapter-supplied idempotency keys (Slack
  // event_id; future channels supply their own). Re-insertion bumps to
  // most-recent. Avoids unbounded memory under sustained load.
  const dedup: Set<string> = new Set();
  function remember(key: string): boolean {
    if (dedup.has(key)) return true;
    dedup.add(key);
    if (dedup.size > dedupCapacity) {
      const oldest = dedup.values().next().value as string | undefined;
      if (oldest !== undefined) dedup.delete(oldest);
    }
    return false;
  }

  return {
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // Match adapter by path prefix: /slack/events → "slack".
      const match = url.pathname.match(/^\\/([^/]+)\\/events$/);
      if (!match || match[1] === undefined) return new Response("not found", { status: 404 });
      const adapter = config.adapters.get(match[1]);
      if (!adapter) return new Response("unknown channel", { status: 404 });

      const body = await req.text();
      const rawReq = { headers: req.headers, body };
      if (!adapter.verify(rawReq)) {
        return new Response("invalid signature", { status: 401 });
      }
      const parsed = adapter.parseInbound({ body });
      if (parsed.kind === "challenge") {
        return new Response(parsed.challenge, {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (parsed.kind === "skip") {
        return new Response("ok", { status: 200 });
      }
      // event
      const seen = remember(parsed.event.idempotencyKey);
      if (seen) return new Response("duplicate", { status: 200 });
      // Fire-and-await: respond after handling so Slack records success.
      try {
        await config.sessionRouter.handle(parsed.event, adapter);
      } catch (err) {
        process.stderr.write(\`[gateway] handler error: \${(err as Error).message}\\n\`);
        return new Response("handler error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    },
  };
}
`;
}

// ---------------------------------------------------------------------------
// File 4: daemon.ts — entrypoint. Boots everything and serves HTTP.
// ---------------------------------------------------------------------------

function renderDaemon(ir: IrChannelV0): string {
  const slack = ir.channels.slack;
  const telegram = ir.channels.telegram;
  const discord = ir.channels.discord;
  const whatsapp = ir.channels.whatsapp;
  if (
    slack === undefined &&
    telegram === undefined &&
    discord === undefined &&
    whatsapp === undefined
  ) {
    throw new TargetEmitError("channel target requires at least one channel configured");
  }
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const mcp = renderMcpServers(ir);
  const subAgents = renderSubAgents(ir);
  const envNames = requiredEnvNames(ir);

  const startupEnvCheck =
    envNames.length > 0
      ? `const __requiredEnv = ${JSON.stringify(envNames)};
const __missing = __requiredEnv.filter((n) => !process.env[n]);
if (__missing.length > 0) {
  process.stderr.write(\`[daemon] missing required env vars: \${__missing.join(", ")}\\n\`);
  process.exit(2);
}
`
      : "";

  const adapterImports: string[] = [];
  const adapterConstructs: string[] = [];
  const adapterMapEntries: string[] = [];

  if (slack !== undefined) {
    const slackBotToken = renderSecretExpr(slack.botToken);
    const slackSigningSecret = renderSecretExpr(slack.signingSecret);
    const slackAppToken =
      slack.appToken !== undefined ? renderSecretExpr(slack.appToken) : undefined;
    adapterImports.push(`import { createSlackAdapter } from "@crewhaus/channel-adapter-slack";`);
    adapterConstructs.push(`const slackAdapter = createSlackAdapter({
  botToken: ${slackBotToken} ?? "",
  signingSecret: ${slackSigningSecret} ?? "",${
    slackAppToken !== undefined ? `\n  appToken: ${slackAppToken},` : ""
  }
});
registerChannelAdapter("slack", slackAdapter);`);
    adapterMapEntries.push(`["slack", slackAdapter]`);
  }

  if (telegram !== undefined) {
    const tgBotToken = renderSecretExpr(telegram.botToken);
    const tgSecretToken = renderSecretExpr(telegram.secretToken);
    adapterImports.push(
      `import { createTelegramAdapter } from "@crewhaus/channel-adapter-telegram";`,
    );
    adapterConstructs.push(`const telegramAdapter = createTelegramAdapter({
  botToken: ${tgBotToken} ?? "",
  secretToken: ${tgSecretToken} ?? "",
});
registerChannelAdapter("telegram", telegramAdapter);`);
    adapterMapEntries.push(`["telegram", telegramAdapter]`);
  }

  if (discord !== undefined) {
    const dcAppId = renderSecretExpr(discord.applicationId);
    const dcBotToken = renderSecretExpr(discord.botToken);
    const dcPubKey = renderSecretExpr(discord.publicKeyHex);
    adapterImports.push(
      `import { createDiscordAdapter } from "@crewhaus/channel-adapter-discord";`,
    );
    adapterConstructs.push(`const discordAdapter = createDiscordAdapter({
  applicationId: ${dcAppId} ?? "",
  botToken: ${dcBotToken} ?? "",
  publicKeyHex: ${dcPubKey} ?? "",
});
registerChannelAdapter("discord", discordAdapter);`);
    adapterMapEntries.push(`["discord", discordAdapter]`);
  }

  if (whatsapp !== undefined) {
    const waPhoneId = renderSecretExpr(whatsapp.phoneNumberId);
    const waAccessToken = renderSecretExpr(whatsapp.accessToken);
    const waAppSecret = renderSecretExpr(whatsapp.appSecret);
    adapterImports.push(
      `import { createWhatsAppAdapter } from "@crewhaus/channel-adapter-whatsapp";`,
    );
    adapterConstructs.push(`const whatsappAdapter = createWhatsAppAdapter({
  phoneNumberId: ${waPhoneId} ?? "",
  accessToken: ${waAccessToken} ?? "",
  appSecret: ${waAppSecret} ?? "",
});
registerChannelAdapter("whatsapp", whatsappAdapter);`);
    adapterMapEntries.push(`["whatsapp", whatsappAdapter]`);
  }

  const adapterConstructBlock = adapterConstructs.join("\n\n");
  const adapterMapLiteral = `new Map([${adapterMapEntries.join(", ")}])`;

  const builtinImportBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const initLines = inits.length > 0 ? `  ${inits.join("\n  ")}\n` : "";
  const registerBlock =
    registrations.length > 0
      ? `\n  // Built-in tools (from spec.agent.tools)\n${initLines}  ${registrations.join("\n  ")}\n`
      : "";

  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";
  const mcpBoot = mcp.hasAny
    ? `\n  // MCP servers\n  ${mcp.bootBlock.split("\n").join("\n  ")}\n`
    : "";
  const mcpCleanup = mcp.hasAny ? `\n    ${mcp.cleanupBlock}` : "";

  const subAgentImportBlock =
    subAgents.imports.length > 0 ? `${subAgents.imports.join("\n")}\n` : "";
  const subAgentBoot = subAgents.hasAny
    ? `\n  // Sub-agents (Section 13)\n${subAgents.registryBlock}\n${subAgents.registerBlock}\n`
    : "";
  const subAgentCreateAgentFields = subAgents.hasAny
    ? "\n    subAgents: __subAgents,\n    spawnSubAgent,"
    : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus-factory. DO NOT EDIT.
// Source spec: ${ir.name} (target: channel, ir version: ${ir.version}, file: daemon.ts)
import { loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${adapterImports.join("\n")}
import { registerChannelAdapter } from "@crewhaus/tool-message-channel";
${builtinImportBlock}${mcpImportBlock}${subAgentImportBlock}import { createAgent } from "./agent.js";
import { createSessionRouter } from "./session-router.js";
import { createGateway } from "./gateway.js";

${startupEnvCheck}
${adapterConstructBlock}

async function main(): Promise<void> {
  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);
  if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));
${registerBlock}${mcpBoot}${subAgentBoot}
  const agent = createAgent({
    hooks: __hooks,
    skills: __skills,
    slashCommands: __slashCommands,
    tools: defaultCatalog.list(),${subAgentCreateAgentFields}
  });
  const sessionRouter = createSessionRouter({ agent });
  const gateway = createGateway({
    adapters: ${adapterMapLiteral},
    sessionRouter,
  });

  const port = Number(process.env["PORT"] ?? 3000);
  const server = Bun.serve({ port, fetch: (req) => gateway.handle(req) });
  process.stdout.write(\`[daemon] listening on http://localhost:\${server.port}\\n\`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(\`[daemon] received \${signal}, shutting down...\\n\`);
    try {
      await server.stop(true);${mcpCleanup}
    } catch (err) {
      process.stderr.write(\`[daemon] shutdown error: \${(err as Error).message}\\n\`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(\`[daemon] fatal: \${(err as Error).message}\\n\`);
  process.exit(1);
});
`;
}
