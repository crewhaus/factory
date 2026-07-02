import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrChannelV0,
  type IrSecretRef,
  type IrSubAgentDefinition,
  renderBundleReadme,
} from "@crewhaus/ir";
import { type ParsedModelString, parseModelString } from "@crewhaus/model-router";

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
export function emitChannelBot(ir: IrChannelV0, opts: EmitReadmeOptions = {}): Bundle {
  if (
    ir.channels.slack === undefined &&
    ir.channels.telegram === undefined &&
    ir.channels.discord === undefined &&
    ir.channels.whatsapp === undefined &&
    ir.channels.imessage === undefined
  ) {
    throw new TargetEmitError(
      "channel target requires at least one configured channel — none found",
    );
  }
  const files = [
    { path: "agent.ts", content: renderAgent(ir) },
    { path: "session-router.ts", content: renderSessionRouter(ir) },
    { path: "gateway.ts", content: renderGateway(ir) },
    { path: "daemon.ts", content: renderDaemon(ir) },
  ];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
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
  const imessage = ir.channels.imessage;
  if (imessage !== undefined) {
    if (imessage.chatDbPath?.kind === "env") names.push(imessage.chatDbPath.name);
    if (imessage.cursorPath?.kind === "env") names.push(imessage.cursorPath.name);
  }
  return names;
}

/**
 * Provider credential env GROUPS derived from `ir.agent.model` at emit
 * time. Each inner array is an EITHER-OR group: the daemon's startup
 * check requires at least one name per group to be set — distinct from
 * `requiredEnvNames` where every name is individually required.
 *
 *   anthropic → ANTHROPIC_AUTH_TOKEN | ANTHROPIC_API_KEY
 *   openai    → OPENAI_API_KEY | OPENAI_BASE_URL
 *   gemini    → GEMINI_API_KEY | GOOGLE_API_KEY
 *   bedrock   → none (the AWS SDK's default credential chain is
 *               authoritative; env vars are only one of its sources)
 *   local/…   → none (the baseUrl is baked in; no credentials)
 *
 * A model string outside the router grammar contributes NO group — the
 * spec layer does not enforce the grammar here, and runtime-core's
 * `resolveModel` raises the authoritative ConfigError at run time.
 */
function providerEnvGroups(model: string): string[][] {
  let parsed: ParsedModelString;
  try {
    parsed = parseModelString(model);
  } catch {
    return [];
  }
  switch (parsed.providerId) {
    case "anthropic":
      return [["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]];
    case "openai":
      // local/<m>@<url> parses to openai WITH a baked baseUrl — the local
      // endpoint needs no env credentials.
      return parsed.baseUrl !== undefined ? [] : [["OPENAI_API_KEY", "OPENAI_BASE_URL"]];
    case "gemini":
      return [["GEMINI_API_KEY", "GOOGLE_API_KEY"]];
    case "bedrock":
      return [];
  }
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

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: agent.ts)
import { runChatLoop } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { classifyInbound } from "@crewhaus/channel-adapter-base";
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
      // Pillar 3 channel boundary — classify the inbound message at
      // TrustOrigin "channel" BEFORE it seeds a model turn. The gateway
      // already verified the webhook signature (who); this verifies what
      // the text contains. Malicious inbound is replaced by a redaction
      // notice; pass/warn content is tagged into runContext.dataLineage so
      // the egress fabric sees the channel origin on later external calls.
      const __inbound = await classifyInbound(args.message, runContext, { origin: "channel" });
      return await runChatLoop({
        model: ${escapeJsonString(ir.agent.model)},
        instructions: ${escapeJsonString(ir.agent.instructions)},
        sessionName: ${escapeJsonString(ir.name)},
        sessionTarget: "channel",
        ...(config.sessionRootDir !== undefined ? { sessionRootDir: config.sessionRootDir } : {}),
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: __inbound }],
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

  // Inbound 👍/👎 reaction feedback (opt-in via spec `feedback.channelReactions`).
  // A reaction event carries the reacting user + channel but NOT the thread
  // root (item.ts is the bot reply's ts), so the session is recoverable only
  // for channel/user session keys; thread mode no-ops (it would need an
  // outbound-ts→session join store).
  const feedbackReactions = ir.feedback?.channelReactions === true;
  const reactionRoutingKeyExpr =
    sessionKey === "user"
      ? "`${adapter.id}:${reaction.workspaceId}:${reaction.userId}`"
      : "`${adapter.id}:${reaction.workspaceId}:${reaction.channelId}`";
  const reactionImports = feedbackReactions
    ? '\nimport { openEventLog } from "@crewhaus/event-log";\nimport type { InboundReaction } from "@crewhaus/channel-adapter-slack";'
    : "";
  const reactionTypeMember = feedbackReactions
    ? "\n  handleReaction(reaction: InboundReaction, adapter: ChannelAdapter): Promise<void>;"
    : "";
  const reactionMethod = !feedbackReactions
    ? ""
    : sessionKey === "thread"
      ? `
    async handleReaction(_reaction: InboundReaction, _adapter: ChannelAdapter): Promise<void> {
      // sessionKey "thread" can't attribute a reaction to a session: item.ts is
      // the bot reply's ts, not the thread root, and no outbound-ts→session
      // join store exists. Reactions are ignored here — use sessionKey channel
      // or user for reaction feedback.
    },`
      : `
    async handleReaction(reaction: InboundReaction, adapter: ChannelAdapter): Promise<void> {
      const routingKey = ${reactionRoutingKeyExpr};
      const sessionId = deriveSessionId(routingKey);
      const session = await sessionStore.get(sessionId);
      if (session === null || session.lastTurnIndex < 1) return;
      const log = await openEventLog(
        sessionId,
        config.sessionRootDir !== undefined ? { rootDir: config.sessionRootDir } : {},
      );
      await log.append({
        kind: "user_feedback",
        payload: {
          schemaVersion: 1,
          id: "fb_" + createHash("sha256").update(reaction.idempotencyKey).digest("hex").slice(0, 16),
          sessionId,
          turnNumber: session.lastTurnIndex,
          modality: "binary",
          rating: { thumbs: reaction.vote },
          source: "channel",
          ts: new Date().toISOString(),
        },
      });
    },`;

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: session-router.ts)
import { createHash } from "node:crypto";
import { createSessionStore } from "@crewhaus/session-store";
import type { ChannelAdapter, InboundEvent } from "@crewhaus/channel-adapter-slack";${reactionImports}
import type { Agent } from "./agent.js";

export type SessionRouterConfig = {
  agent: Agent;
  sessionRootDir?: string;
};

export type SessionRouter = {
  handle(event: InboundEvent, adapter: ChannelAdapter): Promise<void>;${reactionTypeMember}
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
      // Phase 3 §3.2 — emoji status reactions. Best-effort: a reaction
      // API failure should not block the model turn. Slack, Telegram, and
      // WhatsApp implement react(); Discord (interaction-based, no message to
      // react to) and iMessage (no scriptable reaction API) leave it
      // undefined and the hook silently skips.
      const tryReact = async (emoji: string): Promise<void> => {
        if (!adapter.react) return;
        try {
          await adapter.react({ event, emoji });
        } catch {
          // ignore — reaction failures are non-fatal
        }
      };
      await tryReact("eyes");
      try {
        const reply = await config.agent.runTurn({ sessionId, isNew, message: event.text });
        if (reply.length > 0) {
          await adapter.sendReply({ event, text: reply });
        }
        await tryReact("white_check_mark");
      } catch (err) {
        await tryReact("warning");
        throw err;
      }
    },${reactionMethod}
  };
}
`;
}

// ---------------------------------------------------------------------------
// File 3: gateway.ts — channel-generic HTTP request handler.
// ---------------------------------------------------------------------------

function renderGateway(ir: IrChannelV0): string {
  const feedbackReactions = ir.feedback?.channelReactions === true;
  // A reaction always parses to `{ kind: "reaction" }` in the adapter; the
  // gateway must handle it (at least to skip) so the trailing `parsed.event`
  // access stays type-safe. When channelReactions is on, dedup + dispatch to
  // handleReaction; otherwise acknowledge and ignore.
  const reactionBranch = feedbackReactions
    ? [
        '      if (parsed.kind === "reaction") {',
        "        const seen = await dedup.remember(parsed.reaction.idempotencyKey);",
        '        if (seen) return new Response("duplicate", { status: 200 });',
        "        queueMicrotask(() => {",
        "          config.sessionRouter.handleReaction(parsed.reaction, adapter).catch((err) => {",
        '            process.stderr.write("[gateway] reaction handler error: " + (err as Error).message + "\\n");',
        "          });",
        "        });",
        '        return new Response("ok", { status: 200 });',
        "      }",
      ].join("\n")
    : [
        '      if (parsed.kind === "reaction") {',
        '        return new Response("ok", { status: 200 });',
        "      }",
      ].join("\n");
  return `// Generated by crewhaus. DO NOT EDIT.
// Channel-generic gateway: dispatches signed webhooks to the matching adapter.
import { InMemoryDedupStore, type DedupStore } from "@crewhaus/durable-state";
import type { ChannelAdapter } from "@crewhaus/channel-adapter-slack";
import type { SessionRouter } from "./session-router.js";

export type GatewayConfig = {
  adapters: ReadonlyMap<string, ChannelAdapter>;
  sessionRouter: SessionRouter;
  /** Maximum number of inbound idempotency keys remembered before LRU eviction (in-memory store only). */
  dedupCapacity?: number;
  /**
   * SECURITY (audit R3) — replay-dedup store keyed by adapter-supplied
   * idempotency keys (Slack event_id, Discord interaction id, WhatsApp
   * message id, ...). Default: in-memory bounded LRU — volatile, so a
   * daemon restart forgets seen keys and a captured webhook can be replayed
   * inside its signature window. Multi-process or restart-safe deployments
   * pass a durable store (the daemon wires CREWHAUS_DEDUP_STORE=sqlite:<path>
   * through createDedupStore).
   */
  dedupStore?: DedupStore;
};

export type Gateway = {
  handle(req: Request): Promise<Response>;
};

export function createGateway(config: GatewayConfig): Gateway {
  const dedup: DedupStore =
    config.dedupStore ?? new InMemoryDedupStore({ capacity: config.dedupCapacity ?? 10_000 });

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
${reactionBranch}
      // event — atomic check-and-record so concurrent deliveries of the
      // same key (platform retries, multi-process daemons on a durable
      // store) collapse to exactly one handled event.
      const seen = await dedup.remember(parsed.event.idempotencyKey);
      if (seen) return new Response("duplicate", { status: 200 });
      // Slack expects an ACK within 3 s (and Telegram/Discord/WhatsApp have
      // similar tight inbound windows). Drive the model turn asynchronously
      // so the model's inner-loop latency — and any transient API error —
      // can't bubble into the webhook response. The channel adapter's own
      // outbound (chat.postMessage, sendMessage, etc.) delivers the reply
      // when the turn finishes. Errors are surfaced via stderr; the
      // operator's observability stack catches them there.
      queueMicrotask(() => {
        config.sessionRouter.handle(parsed.event, adapter).catch((err) => {
          process.stderr.write(
            \`[gateway] handler error (\${parsed.event.idempotencyKey}): \${(err as Error).message}\\n\`,
          );
        });
      });
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
  const imessage = ir.channels.imessage;
  if (
    slack === undefined &&
    telegram === undefined &&
    discord === undefined &&
    whatsapp === undefined &&
    imessage === undefined
  ) {
    throw new TargetEmitError("channel target requires at least one channel configured");
  }
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const mcp = renderMcpServers(ir);
  const subAgents = renderSubAgents(ir);
  const envNames = requiredEnvNames(ir);
  // Provider credential groups (either-or) derived from agent.model at
  // emit time — a daemon on an openai/gemini model must not demand
  // Anthropic credentials, and vice versa.
  const envGroups = providerEnvGroups(ir.agent.model);

  const startupEnvCheckLines: string[] = [];
  if (envNames.length > 0) {
    startupEnvCheckLines.push(`const __requiredEnv = ${JSON.stringify(envNames)};`);
  }
  if (envGroups.length > 0) {
    startupEnvCheckLines.push(
      "// Provider credentials for the agent model — ANY one name per group suffices.",
      `const __providerEnvAnyOf: string[][] = ${JSON.stringify(envGroups)};`,
    );
  }
  if (envNames.length > 0 || envGroups.length > 0) {
    startupEnvCheckLines.push(
      "const __missingEnv: string[] = [",
      ...(envNames.length > 0 ? ["  ...__requiredEnv.filter((n) => !process.env[n]),"] : []),
      ...(envGroups.length > 0
        ? [
            "  ...__providerEnvAnyOf",
            "    .filter((g) => !g.some((n) => process.env[n]))",
            '    .map((g) => g.join(" or ")),',
          ]
        : []),
      "];",
      "if (__missingEnv.length > 0) {",
      '  process.stderr.write(`[daemon] missing required env vars: ${__missingEnv.join(", ")}\\n`);',
      "  process.exit(2);",
      "}",
    );
  }
  const startupEnvCheck =
    startupEnvCheckLines.length > 0 ? `${startupEnvCheckLines.join("\n")}\n` : "";

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

  if (imessage !== undefined) {
    const chatDbPath =
      imessage.chatDbPath !== undefined ? renderSecretExpr(imessage.chatDbPath) : "undefined";
    const cursorPath =
      imessage.cursorPath !== undefined ? renderSecretExpr(imessage.cursorPath) : "undefined";
    adapterImports.push(
      `import { createIMessageAdapter } from "@crewhaus/channel-adapter-imessage";`,
    );
    adapterConstructs.push(`const imessageAdapter = createIMessageAdapter({${
      imessage.chatDbPath !== undefined ? `\n  chatDbPath: ${chatDbPath},` : ""
    }${imessage.cursorPath !== undefined ? `\n  cursorPath: ${cursorPath},` : ""}
});
registerChannelAdapter("imessage", imessageAdapter);`);
    adapterMapEntries.push(`["imessage", imessageAdapter]`);
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

  // Phase 3 §3.1 — heartbeat scheduled wake. When the IR carries a
  // heartbeat block, the daemon spawns a setInterval that synthesizes
  // an agent turn per tick. Each tick runs in a fresh session so the
  // heartbeat history doesn't accumulate (the "wake, decide, act, sleep"
  // pattern). Errors are logged but don't crash the daemon.
  const heartbeatImport = ir.heartbeat
    ? `import { randomBytes as __hbRandomBytes } from "node:crypto";\n`
    : "";
  const heartbeatBoot = ir.heartbeat
    ? `
  // Phase 3 §3.1 — heartbeat scheduled wake
  const __heartbeatInstructions = ${escapeJsonString(ir.heartbeat.instructions)};
  let __heartbeatTick = 0;
  const __heartbeatTimer = setInterval(async () => {
    __heartbeatTick++;
    const __sessionId = \`sess_\${__hbRandomBytes(8).toString("hex")}\`;
    process.stdout.write(\`[heartbeat] tick #\${__heartbeatTick} (session \${__sessionId})\\n\`);
    try {
      const __out = await agent.runTurn({
        sessionId: __sessionId,
        isNew: true,
        message: __heartbeatInstructions,
      });
      const __preview = __out.length > 200 ? __out.slice(0, 200) + "…" : __out;
      process.stdout.write(\`[heartbeat] → \${__preview}\\n\`);
    } catch (__err) {
      process.stderr.write(\`[heartbeat] error: \${(__err as Error).message}\\n\`);
    }
  }, ${ir.heartbeat.everyMs});
  process.stdout.write(\`[heartbeat] enabled every ${ir.heartbeat.everyMs}ms\\n\`);
`
    : "";
  const heartbeatShutdown = ir.heartbeat ? "\n      clearInterval(__heartbeatTimer);" : "";

  // Phase 3 §3.4 — gateway control-UI. When set, spawn a second
  // Bun.serve on the configured port serving a minimal status JSON
  // endpoint at /status. Full Studio-UI hosting is a follow-up; this
  // first slice gives operators visibility into the daemon's state.
  const gatewayBoot = ir.gateway
    ? `
  // Phase 3 §3.4 — control-UI gateway (status endpoint)
  const __gatewayPort = ${ir.gateway.port};
  const __gatewayUiEnabled = ${ir.gateway.ui};
  const __daemonStartedAt = new Date().toISOString();
  let __turnCount = 0;
  let __heartbeatCount = 0;
  const __gatewayServer = Bun.serve({
    port: __gatewayPort,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/status") {
        return new Response(
          JSON.stringify({
            name: ${escapeJsonString(ir.name)},
            target: "channel",
            startedAt: __daemonStartedAt,
            channels: ${JSON.stringify(Object.keys(ir.channels).filter((k) => (ir.channels as Record<string, unknown>)[k] !== undefined))},
            turnCount: __turnCount,
            heartbeatCount: __heartbeatCount,
            heartbeatEnabled: ${ir.heartbeat ? "true" : "false"},
            uiEnabled: __gatewayUiEnabled,
          }, null, 2),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (__gatewayUiEnabled && (url.pathname === "/" || url.pathname === "/index.html")) {
        // Minimal dashboard; Studio-UI integration is a follow-up.
        return new Response(
          \`<!doctype html><html><head><meta charset="utf-8"><title>\${${escapeJsonString(ir.name)}}}</title><style>body{font-family:system-ui;padding:2rem;max-width:48rem;margin:auto;color:#333}h1{margin-bottom:0.25rem}pre{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}</style></head><body><h1>\${${escapeJsonString(ir.name)}}}</h1><p>channel daemon · <a href="/status">/status</a></p><pre id="s">loading…</pre><script>fetch("/status").then(r=>r.json()).then(d=>{document.getElementById("s").textContent=JSON.stringify(d,null,2)})</script></body></html>\`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.stdout.write(\`[gateway] listening on http://localhost:\${__gatewayServer.port}\${__gatewayUiEnabled ? " (UI enabled)" : ""}\\n\`);
`
    : "";
  const gatewayShutdown = ir.gateway ? "\n      await __gatewayServer.stop(true);" : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: daemon.ts)
import { loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { defaultCatalog } from "@crewhaus/tool-catalog";
${adapterImports.join("\n")}
import { registerChannelAdapter } from "@crewhaus/tool-message-channel";
${heartbeatImport}${builtinImportBlock}${mcpImportBlock}${subAgentImportBlock}import { createAgent } from "./agent.js";
import { createSessionRouter } from "./session-router.js";
import { createGateway } from "./gateway.js";
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { createDedupStore } from "@crewhaus/durable-state";
import { createJanitor } from "@crewhaus/runtime-core";

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
  // SECURITY (audit R3) — replay-dedup backend. Default in-memory; set
  // CREWHAUS_DEDUP_STORE=sqlite:<path> so seen webhook ids survive restarts
  // and are shared by every daemon process on this host.
  const __dedupStore = createDedupStore(process.env["CREWHAUS_DEDUP_STORE"] ?? "memory");
  const gateway = createGateway({
    adapters: ${adapterMapLiteral},
    sessionRouter,
    dedupStore: __dedupStore,
  });

  // Boot-time self-heal janitor (ops item 36): evicts expired sessions on a
  // schedule (TTL eviction otherwise only fires as a list() side-effect the
  // daemon never triggers while idle) and reports orphaned tool_use entries
  // in recent transcripts (report-only — resume already reconciles orphans
  // in memory). Eviction honors .crewhaus/retention.json (ops item 35) —
  // the SAME pins + sessions.maxAgeDays the \`crewhaus retention\` CLI
  // enforces; a malformed config fails safe (eviction disabled, daemon
  // keeps serving). CREWHAUS_JANITOR=0 disables entirely;
  // CREWHAUS_JANITOR_INTERVAL_MS overrides the hourly re-run (0 keeps only
  // the boot run).
  let __retentionTtlDays: number;
  let __retentionPins: readonly string[] = [];
  try {
    const __retention = await loadRetentionConfig(__cwd);
    __retentionTtlDays = __retention.sessionMaxAgeDays;
    __retentionPins = __retention.pins;
  } catch (err) {
    process.stderr.write(
      \`[daemon] .crewhaus/retention.json unreadable — janitor session eviction disabled: \${(err as Error).message}\\n\`,
    );
    __retentionTtlDays = Number.POSITIVE_INFINITY; // fail-safe: evict nothing
  }
  const __janitor = createJanitor({
    sessionTtlDays: __retentionTtlDays,
    pinnedSessionIds: __retentionPins,
  });
  if (process.env["CREWHAUS_JANITOR"] !== "0") {
    const __janitorReport = await __janitor.runOnce();
    process.stdout.write(\`[janitor] \${JSON.stringify(__janitorReport.steps)}\\n\`);
    __janitor.start(Number(process.env["CREWHAUS_JANITOR_INTERVAL_MS"] ?? 3_600_000));
  }

  const port = Number(process.env["PORT"] ?? 3000);
  const server = Bun.serve({ port, fetch: (req) => gateway.handle(req) });
  process.stdout.write(\`[daemon] listening on http://localhost:\${server.port}\\n\`);
${gatewayBoot}${heartbeatBoot}
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(\`[daemon] received \${signal}, shutting down...\\n\`);
    __janitor.stop();
    try {
      await server.stop(true);${gatewayShutdown}${heartbeatShutdown}${mcpCleanup}
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
