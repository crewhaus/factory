import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrChannelV0,
  type IrKnowledge,
  type IrSchedule,
  type IrSecretRef,
  type IrSubAgentDefinition,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr, renderStudyRotationPreamble } from "@crewhaus/memory-service";
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
/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitChannelBot` options.
 * `evalEntry: true` (set only by `crewhaus compile --with-eval-harness`)
 * additionally emits an `eval-entry.ts` file exporting
 * `runForEval(input, opts)`: a LOOPBACK delivery of one inbound message
 * through the bot's REAL `createAgent().runTurn` path — inbound
 * classification, session resume machinery, the in-loop evaluation block,
 * taxonomy/budget/limits all run exactly as deployed; the adapter/gateway
 * webhook layer is the only part stubbed out. Sample `history` pre-seeds the
 * session transcript so the real resume path replays it (no model calls for
 * history turns). Purely ADDITIVE: the existing agent/session-router/gateway/
 * daemon files stay byte-identical with or without the option.
 */
export type EmitChannelBotOptions = EmitReadmeOptions & { readonly evalEntry?: boolean };

export function emitChannelBot(ir: IrChannelV0, opts: EmitChannelBotOptions = {}): Bundle {
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
  if (opts.evalEntry === true) {
    files.push({ path: "eval-entry.ts", content: renderEvalEntry(ir) });
  }
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
    // verifyToken is optional in spec, but once declared it is load-bearing
    // (Meta's callback-URL handshake fails closed without it), so an unset
    // env var is a boot-time misconfiguration like any other.
    if (whatsapp.verifyToken?.kind === "env") names.push(whatsapp.verifyToken.name);
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

/**
 * Item 22 — render the failover-chain runChatLoop fields from the IR agent
 * block, indented for the generated `createAgent` body. Empty when the spec
 * declared neither field so existing bundles stay byte-identical. NOTE: the
 * startup env check (`providerEnvGroups`) intentionally covers ONLY the
 * primary model — fallback credentials resolve lazily and a missing one
 * warns at boot instead of failing it. Mirror: target-cli + target-managed
 * render the same fields — keep the three in sync.
 */
function renderModelFailoverFields(ir: IrChannelV0): string {
  const pieces: string[] = [];
  const fallbacks = ir.agent.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(
      `\n        modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`,
    );
  }
  if (ir.agent.circuitBreaker !== undefined) {
    pieces.push(`\n        circuitBreaker: ${JSON.stringify(ir.agent.circuitBreaker)},`);
  }
  // Item 26 — two-tier router (mirror of target-cli). Absent when unset.
  if (ir.agent.modelTiers !== undefined) {
    pieces.push(`\n        modelTiers: ${JSON.stringify(ir.agent.modelTiers)},`);
  }
  // Adaptive model routing — the N-candidate pool (mirror of target-cli).
  if (ir.agent.modelPool !== undefined) {
    pieces.push(`\n        modelPool: ${JSON.stringify(ir.agent.modelPool)},`);
  }
  return pieces.join("");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field,
 * indented for the generated `createAgent` body. Empty when the spec omits
 * the block. Mirror: target-cli + target-managed render the same field.
 */
function renderFailureTaxonomyField(ir: IrChannelV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n        failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 — render the `budget` runChatLoop field, indented for the
 * generated `createAgent` body. Empty when the spec omits it. Mirror:
 * target-cli + target-managed render the same field.
 */
function renderBudgetField(ir: IrChannelV0): string {
  if (ir.budget === undefined) return "";
  return `\n        budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Thread `compaction.model` so a channel bot's auto-compaction summarizes on
 * the spec's chosen model instead of the primary. The compiler already
 * resolved the `cheapest` sentinel to a concrete id. Loop contract 0.4
 * (Batch A) adds the tuning knobs alongside it: `compaction.threshold` →
 * `compactionThreshold` (context-fill fraction that triggers autocompact)
 * and `snip_keep_head`/`snip_keep_tail` → `snipKeepHead`/`snipKeepTail`
 * (messages preserved verbatim by `compaction-snip`). Each field is emitted
 * only when the spec declared it — the runtime owns every default — so
 * existing bundles stay byte-identical. Mirror: target-cli renders the same
 * fields.
 */
function renderCompactionFields(ir: IrChannelV0): string {
  const pieces: string[] = [];
  if (ir.compaction.model !== undefined) {
    pieces.push(`\n        compactionModel: ${escapeJsonString(ir.compaction.model)},`);
  }
  if (ir.compaction.threshold !== undefined) {
    pieces.push(`\n        compactionThreshold: ${ir.compaction.threshold},`);
  }
  if (ir.compaction.snipKeepHead !== undefined) {
    pieces.push(`\n        snipKeepHead: ${ir.compaction.snipKeepHead},`);
  }
  if (ir.compaction.snipKeepTail !== undefined) {
    pieces.push(`\n        snipKeepTail: ${ir.compaction.snipKeepTail},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — thread the agent-level tuning knobs into the
 * generated interactive `runChatLoop` call, camelCase-mirroring the IR 1:1:
 * `agent.max_tokens` → `maxTokens` (model max OUTPUT tokens per turn),
 * `agent.thinking` → `thinking` (extended-thinking selector; exactly one of
 * `{ budgetTokens }` / `{ effort }` by spec construction), and
 * `agent.rate_limits` → `rateLimits` (per-tool rpm/burst buckets, `"*"` the
 * catch-all). Each field is emitted only when the spec declared it so
 * existing bundles stay byte-identical. The dream path is deliberately NOT
 * tuned by these — its bounded fresh session keeps memory-service's own
 * DREAM_MAX_TOOL_ITERATIONS / budget seam inputs. Mirror: target-cli +
 * target-managed render the same fields.
 */
function renderAgentTuningFields(ir: IrChannelV0): string {
  const pieces: string[] = [];
  if (ir.agent.maxTokens !== undefined) {
    pieces.push(`\n        maxTokens: ${ir.agent.maxTokens},`);
  }
  if (ir.agent.thinking !== undefined) {
    pieces.push(`\n        thinking: ${JSON.stringify(ir.agent.thinking)},`);
  }
  if (ir.agent.rateLimits !== undefined) {
    pieces.push(`\n        rateLimits: ${JSON.stringify(ir.agent.rateLimits)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — thread the top-level `limits:` ceilings into
 * the generated interactive `runChatLoop` call as the runtime's individual
 * top-level knobs (`maxToolIterations` / `maxConcurrentTools` /
 * `contextLimit` are pre-existing options; `deadlineMs` / `turnTimeoutMs` /
 * `modelCallTimeoutMs` / `loopDetection` are the 0.4 additions, camelCase-
 * mirroring the IR 1:1). Every knob is emitted only when declared — the
 * runtime owns every default — so existing bundles stay byte-identical.
 * `limits.crew` never reaches this shape (crew-only; the spec rejects it
 * everywhere else). The daemon's dream path keeps its own bounded
 * `input.maxToolIterations` (DREAM_MAX_TOOL_ITERATIONS) regardless of these.
 * Mirror: target-cli + target-managed render the same fields.
 */
function renderLimitsFields(ir: IrChannelV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n        maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n        maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n        contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n        deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n        turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n        modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n        loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch B, G02) — render the in-loop `evaluation:` wiring
 * for the interactive turn. The bundle constructs the evaluate fn from the
 * RESOLVED IR grader at module scope in agent.ts and threads it — together
 * with the resolved gate knobs — into the interactive `runChatLoop` call's
 * `evaluation` option; the runtime scores each completed assistant turn,
 * compares against `threshold`, applies `onFail` (retry ≤ `maxRetries` with
 * the rationale appended as a system nudge / halt as a classified
 * `evaluation` failure / note as an `eval_graded` trace event only) and
 * emits one `eval_graded` event per grading pass.
 *
 *   - `llm_judge` rides `@crewhaus/eval-judge`'s `judge()` (the offline
 *     eval-judge scoring path: single-criterion rubric from `criteria`, 1–5
 *     score mapped to [0,1] via (n-1)/4, prompt-injection-hardened
 *     sentinels). The judge model resolves through the SAME model-router
 *     adapter wiring the bundle's primary model uses, so judge spend is
 *     metered exactly like every other model call; the model defaults to
 *     the shape's primary model when the spec omitted `grader.model`
 *     (`cheapest` already resolved at lower time). `threshold` was resolved
 *     at lower time (default 0.7) — the `?? 0.7` is a defensive floor for
 *     hand-built IR. A3 — an abstaining judge scores 0 with a `judge
 *     abstained: …` rationale (its nominal best-estimate score is a guess
 *     and must never pass the threshold), so `onFail` applies exactly as
 *     for a failed grade.
 *   - `contains` / `regex` are emitted as pure fns (score 1 on pass, 0 on
 *     fail; no model spend, no import). `lastIndex` is reset per call so a
 *     global/sticky flag can never flip-flop verdicts across turns.
 *
 * The dream path deliberately carries NO evaluation — its bounded fresh
 * session is a consolidation pass, not a served answer. The emitted literal
 * is annotated `RunEvaluation` (runtime-core's seam type), so a compiled
 * bundle typechecks against the exact runtime contract:
 * `graderType`/`threshold` are stamped verbatim onto every `eval_graded`
 * event (deterministic graders carry the documented threshold 1 — score is
 * 0|1 and `score >= threshold` is the pass rule). Empty pieces when the
 * spec omits the block, keeping pre-existing bundles byte-identical.
 * Mirror: target-cli + target-managed render the same wiring — keep the
 * three in sync.
 */
function renderEvaluation(ir: IrChannelV0): {
  imports: string[];
  bootBlock: string;
  field: string;
} {
  const ev = ir.evaluation;
  if (ev === undefined) return { imports: [], bootBlock: "", field: "" };
  const field = "\n        evaluation: __evaluation,";
  const typeImport = `import type { RunEvaluation } from "@crewhaus/runtime-core";`;
  const onFail = escapeJsonString(ev.onFail);
  if (ev.grader.type === "llm_judge") {
    const criteria = escapeJsonString(ev.grader.criteria);
    const model = escapeJsonString(ev.grader.model ?? ir.agent.model);
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "llm_judge",
  threshold: ${ev.threshold ?? 0.7},
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    const __verdict = await judge({
      rubric: {
        criteria: [
          {
            name: "criteria",
            description: ${criteria},
            anchors: {
              "1": "fails the criteria entirely",
              "2": "mostly fails the criteria",
              "3": "partially meets the criteria",
              "4": "meets the criteria with minor gaps",
              "5": "fully meets the criteria",
            },
          },
        ],
        passing_score: 3,
      },
      sample: { id: "in-loop-evaluation", input: "" },
      agentOutput: finalText,
      model: ${model},
    });
    if (__verdict.abstain) {
      return { score: 0, rationale: "judge abstained: " + __verdict.rationale };
    }
    return { score: (__verdict.score - 1) / 4, rationale: __verdict.rationale };
  },
};`;
    return {
      imports: [typeImport, `import { judge } from "@crewhaus/eval-judge";`],
      bootBlock,
      field,
    };
  }
  const value = ev.grader.value;
  const valueLit = escapeJsonString(value);
  if (ev.grader.type === "contains") {
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "contains",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) =>
    finalText.includes(${valueLit})
      ? { score: 1, rationale: ${escapeJsonString(`output contains "${value}"`)} }
      : { score: 0, rationale: ${escapeJsonString(`output missing "${value}"`)} },
};`;
    return { imports: [typeImport], bootBlock, field };
  }
  const bootBlock = `const __evalRegex = new RegExp(${valueLit});
const __evaluation: RunEvaluation = {
  graderType: "regex",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    __evalRegex.lastIndex = 0;
    return __evalRegex.test(finalText)
      ? { score: 1, rationale: ${escapeJsonString(`output matches /${value}/`)} }
      : { score: 0, rationale: ${escapeJsonString(`output does not match /${value}/`)} };
  },
};`;
  return { imports: [typeImport], bootBlock, field };
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

/**
 * Loop contract 0.4 (Batch E, G22) — agent-shape RAG (`knowledge:`). Mirror of
 * target-cli's renderKnowledge (keep in sync): the daemon ingests the declared
 * sources at boot through `@crewhaus/tool-retrieve`'s `knowledgeRetrieve` and
 * registers the returned `Retrieve` tool on defaultCatalog, so it rides
 * `defaultCatalog.list()` into createAgent. The G76 embedder order is deferred
 * to `resolveKnowledgeEmbedder`. Empty when the spec omits the block.
 */
function renderKnowledge(ir: IrChannelV0): { imports: string[]; bootBlock: string } {
  const k = ir.knowledge;
  if (k === undefined) return { imports: [], bootBlock: "" };
  const memOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const embInputs: string[] = [];
  if (k.embedder !== undefined)
    embInputs.push(`knowledgeEmbedder: ${escapeJsonString(k.embedder)}`);
  const memEmb = memOn ? ir.memory?.embedder : undefined;
  if (memEmb !== undefined) embInputs.push(`memoryEmbedder: ${escapeJsonString(memEmb)}`);
  const wikiEmb = memOn ? ir.memory?.wiki?.embedder : undefined;
  if (wikiEmb !== undefined) embInputs.push(`wikiEmbedder: ${escapeJsonString(wikiEmb)}`);
  const embedderExpr = `resolveKnowledgeEmbedder({ ${embInputs.join(", ")} })`;
  const bootBlock = `const __knowledgeTool = await knowledgeRetrieve({
  sources: ${JSON.stringify(k.sources)},
  embedderModel: ${embedderExpr},
  vectorBackend: ${escapeJsonString(k.vectorBackend)},
  defaultK: ${k.defaultK},
  chunkSize: ${k.chunkSize},
  chunkOverlap: ${k.chunkOverlap},
  log: (line) => process.stdout.write(line),
});
defaultCatalog.register(__knowledgeTool);`;
  return {
    imports: [
      `import { knowledgeRetrieve, resolveKnowledgeEmbedder } from "@crewhaus/tool-retrieve";`,
    ],
    bootBlock,
  };
}

/**
 * Item 3 (G32) — plugin activation for the channel daemon. Mirror of target-cli's
 * renderPlugins (keep in sync): when the spec declares `plugins:`, `daemon.ts`
 * activates the named plugins at boot via `@crewhaus/plugin-loader` (registry
 * read → Ed25519 signature + entrypoint-digest verify → import) and registers
 * the contributed tools on the shared `defaultCatalog`, so they ride
 * `defaultCatalog.list()` into `createAgent`.
 *
 * Split so ordering is safe inside `main()`:
 *   - `activateBoot` runs EARLY (before skill discovery) so `__plugins.skillDirs`
 *     feeds `discoverSkills({ pluginDirs })`.
 *   - `registerBoot` runs AFTER the built-in + skill tools are on the catalog and
 *     skips any name already registered — first-party wins, and a plugin tool
 *     named after a built-in never trips `defaultCatalog.register`'s
 *     duplicate-name throw and bricks the daemon.
 * Both blocks are indented two spaces for the `main()` body. Empty when the spec
 * omits `plugins:`, keeping bundles byte-identical.
 */
function renderPlugins(ir: IrChannelV0): {
  imports: string[];
  activateBoot: string;
  registerBoot: string;
  hasAny: boolean;
} {
  const names = ir.plugins ?? [];
  if (names.length === 0) {
    return { imports: [], activateBoot: "", registerBoot: "", hasAny: false };
  }
  return {
    hasAny: true,
    imports: [
      `import { activatePlugins, createDefaultPluginRuntime } from "@crewhaus/plugin-loader";`,
    ],
    activateBoot: `  const __plugins = await activatePlugins({
    names: ${JSON.stringify(names)},
    ...createDefaultPluginRuntime({ allowUnsigned: process.env.CREWHAUS_PLUGIN_ALLOW_UNSIGNED === "1" }),
  });`,
    registerBoot: `  for (const __t of __plugins.tools) {
    if (defaultCatalog.get(__t.name) !== undefined) {
      process.stderr.write(\`[plugins] tool "\${__t.name}" already registered — plugin contribution skipped\\n\`);
      continue;
    }
    defaultCatalog.register(__t);
  }`,
  };
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
  // Loop contract 0.4 (Batch E, G23) — the synthesized `thredz` server (from
  // the compiler's `lowerThredzWired`, or the user's own vendored entry) boots
  // through `connectThredz` (ported from the cli emitter): its wiki+goals
  // tools land on the catalog under BARE names (one vocabulary across
  // backends) and a boot failure DEGRADES (`__thredz` = null → wireMemory
  // falls back to local files with a warning) instead of failing the daemon.
  // Mirror of target-cli's renderMcpServers; keep the two in sync.
  const thredzOn = ir.thredz !== undefined;
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    ...(thredzOn ? [`import { connectThredz } from "@crewhaus/memory-service";`] : []),
    ...(entries.some(([name]) => !(thredzOn && name === "thredz"))
      ? [`import { registerMcpServer } from "@crewhaus/tool-mcp";`]
      : []),
  ];
  // 0.3.0 — embed the UNRESOLVED IrSecretRef-valued config and resolve at
  // daemon boot (mirror of target-cli's renderMcpServers; keep in sync).
  const addLines = entries
    .map(([name, cfg]) => {
      const add = `mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`;
      // §4.4 — a missing THREDZ_API_KEY is a CONFIG failure: render the one
      // structured report and exit with the config code (21) instead of an
      // unhandled ConfigError stack (this add runs before the daemon's own
      // main().catch wrapper).
      if (thredzOn && name === "thredz") {
        return `try {\n  ${add}\n} catch (__err) {\n  const __report = toFailureReport(__err);\n  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[daemon]" })}\\n\`);\n  process.exit(__report.exitCode);\n}`;
      }
      return add;
    })
    .join("\n");
  const namespacedEntries = entries.filter(([name]) => !(thredzOn && name === "thredz"));
  const registerLines = namespacedEntries
    .map(
      ([name]) =>
        `  registerMcpServer(mcpHost, ${escapeJsonString(name)}, defaultCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  // The thredz alias vocabulary must land on the catalog BEFORE any namespaced
  // MCP server registers (the collision guard wants an empty slot), so
  // connectThredz runs between the addServer calls and the Promise.all.
  const thredzBoot = thredzOn
    ? `const __thredz = await connectThredz(mcpHost, defaultCatalog, { log: (line) => process.stdout.write(line)${
        ir.thredz?.agentName !== undefined
          ? `, agentName: ${escapeJsonString(ir.thredz.agentName)}`
          : ""
      } });`
    : undefined;
  const bootBlock = [
    "const mcpHost = new McpHost();",
    addLines,
    ...(thredzBoot !== undefined ? [thredzBoot] : []),
    ...(namespacedEntries.length > 0 ? ["await Promise.all([", registerLines, "]);"] : []),
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

/**
 * v0.3.0 PR 11 — the channel shape's memory-fabric wiring state. `wired`
 * when the IR carries an enabled `memory` block and/or a `continuity` block
 * (DEFAULT-ON in 0.3.0 — only `continuity: false` removes it); the fragment
 * is the serialized `wireMemory` input. Both codegen sites (agent.ts runTurn
 * + daemon boot) gate on this so an opted-out spec stays byte-identical.
 */
function memoryFabric(ir: IrChannelV0): {
  wired: boolean;
  continuityOn: boolean;
  fragmentJson: string;
} {
  const memoryOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const learningOn = ir.learning !== undefined;
  const wired = memoryOn || continuityOn;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: ir.memory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment so every
          // turn's wireMemory renders the learning-loop skill and gates in
          // /study /reflect. The exam runner is cli-shape wiring in this
          // release (no examRunner dep here), so /exam stays gated out.
          ...(learningOn ? { learning: ir.learning } : {}),
          // Loop contract 0.4 (Batch E, G23) — thredz rides the fragment so
          // wireMemory flips the wiki backend; the LIVE connection (`__thredz`
          // from the daemon's connectThredz boot) is threaded separately as
          // the `thredz` dep on the per-turn wireMemory call.
          ...(ir.thredz !== undefined ? { thredz: ir.thredz } : {}),
        }),
      )
    : "";
  return { wired, continuityOn, fragmentJson };
}

/** v0.3.0 PR 14 — dream is configured when the enabled memory block carries
 *  a dream schedule. Gates the janitor-step + model-phase codegen in BOTH
 *  agent.ts and daemon.ts, so dream-less specs stay byte-identical. */
function dreamConfigured(ir: IrChannelV0): boolean {
  return ir.memory !== undefined && ir.memory.enabled !== false && ir.memory.dream !== undefined;
}

/**
 * D39 — the daemon-side auto-distill step is emitted when the spec opted in
 * (`feedback.autoDistill: true`, block not disabled). Gates the janitor-step
 * codegen in daemon.ts, so every spec without it stays byte-identical.
 *
 * WHY the channel shape: this is the shape that actually PRODUCES ratings
 * (the 👍/👎 reaction join), and its ratings previously accumulated in
 * `.crewhaus/feedback` until somebody happened to run `crewhaus run` against
 * the harness. The daemon runs with credentials and base distill is offline,
 * so the credential-stripped-hooks rationale that keeps auto-distill out of
 * the cli bundle does not apply here.
 */
function daemonDistillConfigured(ir: IrChannelV0): boolean {
  return (
    ir.feedback !== undefined && ir.feedback.enabled !== false && ir.feedback.autoDistill === true
  );
}

/** D39 — the distill janitor step's boot + registration, shared by the
 *  channel daemon (and mirrored by the managed daemon). Empty when the spec
 *  did not opt in. */
function renderDistillStepBoot(
  specName: string,
  feedback: { enabled?: boolean } | undefined,
): {
  readonly imports: string;
  readonly boot: string;
  readonly stepExpr: string;
} {
  const carried: { enabled?: boolean; autoDistill: true } = { autoDistill: true };
  if (feedback?.enabled !== undefined) carried.enabled = feedback.enabled;
  return {
    imports:
      'import { createDistillJanitorStep } from "@crewhaus/feedback-distill";\n' +
      'import { createFileBackedRegistry } from "@crewhaus/dataset-registry";\n',
    boot: `
  // D39 — accumulated ratings (channel reactions + the web-UI/gateway sink)
  // distill into a new version of the \`${specName}-ratings\` registry dataset
  // on the janitor's own clock, instead of waiting for a \`crewhaus run\`
  // teardown that may never happen for a daemon. Shares the
  // .crewhaus/feedback/.distill-state.json watermark with the CLI consumer,
  // so once cron / \`crewhaus distill\` / this daemon lands a batch, the
  // others see nothing unprocessed (a shared watermark, not a lock — two
  // OVERLAPPING runs can each register a version of the same ratings).
  // The transcript root is resolved the way the RUNTIME resolves it
  // (CREWHAUS_SESSION_DIR, else <cwd>/.crewhaus/sessions) — this daemon
  // leaves createAgent's sessionRootDir unset, so those are the same bytes.
  // Split rater verdicts (B19) go to .crewhaus/review/queue.jsonl —
  // \`crewhaus review next\`. CREWHAUS_AUTODISTILL=0 disables;
  // CREWHAUS_AUTODISTILL_THRESHOLD overrides the ">= 5 unprocessed" trigger.
  const __distillStep = createDistillJanitorStep({
    specName: ${escapeJsonString(specName)},
    feedback: ${JSON.stringify(carried)},
    registry: createFileBackedRegistry({
      rootDir: process.env["CREWHAUS_DATASETS_DIR"] ?? join(__cwd, ".crewhaus", "datasets"),
    }),
    cwd: __cwd,
  });
`,
    stepExpr: "__distillStep !== null ? [__distillStep] : []",
  };
}

/** The dream's serialized fragment: SPEC-scoped continuity (§14.5 — the
 *  dream consolidates the daemon's own agenda, never a per-conversation
 *  store), regardless of the interactive scope the channel runs with. */
function dreamFragmentJson(ir: IrChannelV0): string {
  return JSON.stringify(
    memoryFragmentFromIr({
      name: ir.name,
      memory: ir.memory,
      ...(ir.continuity !== undefined
        ? { continuity: { ...ir.continuity, scope: "spec" as const } }
        : {}),
      // v0.3.0 Goal 2 (PR 17) — with learning on (and study.on_dream not
      // opted out), wireDream seeds the model phase's findings with the top
      // open knowledge gaps + the next unmastered curriculum rung.
      ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
    }),
  );
}

function renderAgent(ir: IrChannelV0): string {
  // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation for the
  // interactive turn. Empty pieces when the spec omits the block.
  const evaluation = renderEvaluation(ir);
  const evalImport = evaluation.imports.length > 0 ? `${evaluation.imports.join("\n")}\n` : "";
  const evaluationBlock = evaluation.bootBlock ? `\n${evaluation.bootBlock}\n` : "";
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

  // v0.3.0 — memory fabric (facts + continuity), wired PER TURN through the
  // one stable composition-root call so session-scoped continuity closes
  // over THIS conversation's sessionId. The heartbeat override (`spec`
  // scope) only exists when both continuity and a heartbeat are configured.
  const fabric = memoryFabric(ir);
  const hbScopeOverride = fabric.continuityOn && ir.heartbeat !== undefined;
  const dreamOn = dreamConfigured(ir);
  // Loop contract 0.4 (Batch E, G23) — the live Thredz connection threads from
  // the daemon's connectThredz boot into every per-turn wireMemory call as the
  // `thredz` dep (the wiki-backend flip needs the live client). Only relevant
  // when the memory fabric actually wires (wireMemory is the sole consumer).
  const thredzOn = ir.thredz !== undefined && fabric.wired;
  // Loop contract 0.4 (Batch A) — top-level `memory.embedder`. Only
  // meaningful when the fact store actually wires (an enabled memory block);
  // threaded as the structural `deps.embedder` on every wireMemory /
  // dream-janitor call so it beats the fragment's `wiki.embedder` factory
  // string — the documented fallback order `embedder` → `wiki.embedder`.
  const memEmbedderModel =
    ir.memory !== undefined && ir.memory.enabled !== false ? ir.memory.embedder : undefined;
  const memImport = fabric.wired
    ? `${memEmbedderModel !== undefined ? `import { createEmbedder } from "@crewhaus/embedder";\n` : ""}import { wireMemory${fabric.continuityOn || dreamOn ? ", type MemoryWiringFragment" : ""}${dreamOn ? ", createDreamJanitorStep, type DreamJanitorStep" : ""}${thredzOn ? ", type ThredzConnection" : ""} } from "@crewhaus/memory-service";\n${fabric.continuityOn ? `import { createSkillTool } from "@crewhaus/skills-registry";\n` : ""}${dreamOn ? `import { createCostTracker } from "@crewhaus/cost-tracker";\n` : ""}`
    : "";
  const memEmbedderBlock =
    memEmbedderModel === undefined
      ? ""
      : `
/** Loop contract 0.4 (Batch A) — top-level \`memory.embedder\`: hybrid recall
 *  on the fact store (and the wiki), resolved ONCE at boot from the
 *  \`@crewhaus/embedder\` factory grammar. Threaded as the structural
 *  \`deps.embedder\`, which beats the fragment's \`wiki.embedder\` factory
 *  string (fallback order \`embedder\` → \`wiki.embedder\`). */
const __memEmbedder = createEmbedder({ model: ${escapeJsonString(memEmbedderModel)} });
`;
  const memEmbedderDep = memEmbedderModel !== undefined ? "\n        embedder: __memEmbedder," : "";
  const fragmentBlock = !fabric.wired
    ? ""
    : fabric.continuityOn
      ? `\nconst __FRAGMENT: MemoryWiringFragment = ${fabric.fragmentJson};\n${
          hbScopeOverride
            ? `
/** Heartbeat ticks read the daemon's own agenda: \`spec\`-scoped continuity
 *  (§2.7/§14.5) instead of a throwaway per-tick session store. */
function __memFragment(scope?: "spec" | "session"): MemoryWiringFragment {
  if (scope === undefined || __FRAGMENT.continuity === undefined) return __FRAGMENT;
  return { ...__FRAGMENT, continuity: { ...__FRAGMENT.continuity, scope } };
}
`
            : ""
        }`
      : "";
  const runTurnArgsScopeField = hbScopeOverride
    ? `\n  /** v0.3.0 — continuity scope override; heartbeat ticks pass "spec". */\n  continuityScope?: "spec" | "session";`
    : "";
  const fragmentExpr = hbScopeOverride
    ? "__memFragment(args.continuityScope)"
    : fabric.continuityOn
      ? "__FRAGMENT"
      : fabric.fragmentJson;
  const memTurnBlock = !fabric.wired
    ? ""
    : `
      // v0.3.0 — the memory fabric, wired per turn through the ONE stable
      // composition-root call (design §1 principle 1).${
        fabric.continuityOn
          ? ` Continuity scope
      // "session" nests per-conversation state under this turn's sessionId
      // (the session router's routing-key digest) via the sessionScope dep.`
          : ""
      }
      const __memTools: RegisteredTool[] = [];
      const __memWired = await wireMemory(${fragmentExpr}, {
        catalog: { register: (t: RegisteredTool) => { __memTools.push(t); } },
        cwd: config.fabricRoot ?? process.cwd(),${memEmbedderDep}${thredzOn ? "\n        thredz: config.thredz," : ""}
        sessionScope: args.sessionId,
      });${
        fabric.continuityOn
          ? `
      const __skills = __memWired.options.skills ?? config.skills;
      const __tools = [...config.tools, ...__memTools];
      if (__skills.length > 0) __tools.push(createSkillTool(__skills));`
          : ""
      }`;
  const toolsExpr = !fabric.wired
    ? "config.tools"
    : fabric.continuityOn
      ? "__tools"
      : "[...config.tools, ...__memTools]";
  const skillsExpr = fabric.continuityOn ? "__skills" : "config.skills";
  const slashCommandsExpr = fabric.continuityOn
    ? "__memWired.options.slashCommands ?? config.slashCommands"
    : "config.slashCommands";
  const memRunField = fabric.wired ? "\n        ...__memWired.options," : "";

  // v0.3.0 PR 14 (§6.3) — the dream janitor step, exported for daemon.ts to
  // register into createJanitor({ steps }). The model phase is ONE bounded
  // fresh session built on the SAME runChatLoop this file already imports:
  // sessionTarget "dream", singleTurn, capped tool loop, the item-27 budget
  // option carrying memory.dream.budget_usd — and only the memory-fabric
  // tools (spec-scoped), so every synthesis action rides the normal
  // justification/audit path.
  const dreamStepBlock = !dreamOn
    ? ""
    : `
/** v0.3.0 §6.3 — the dream consolidation step for the daemon janitor.
 *  Due-checked against .crewhaus/dream/<spec>/state.json by the step
 *  itself; CREWHAUS_DREAM=0 disables, CREWHAUS_DREAM_INTERVAL_MS overrides
 *  the cadence. The dream always reads the SPEC-scoped stores — the
 *  daemon's own agenda — never a per-conversation session store. */
const __DREAM_FRAGMENT: MemoryWiringFragment = ${dreamFragmentJson(ir)};

export function createDreamStep(): DreamJanitorStep | null {
  return createDreamJanitorStep(__DREAM_FRAGMENT, {
    cwd: process.cwd(),${memEmbedderModel !== undefined ? "\n    embedder: __memEmbedder," : ""}
    modelPhase: {
      model: ${escapeJsonString(ir.agent.model)},
      run: async (input) => {
        // The dream session sees ONLY the memory-fabric tools (§6.2) —
        // wired fresh, spec scope, into a local list.
        const __tools: RegisteredTool[] = [];
        await wireMemory(__DREAM_FRAGMENT, {
          catalog: { register: (t: RegisteredTool) => { __tools.push(t); } },
          cwd: process.cwd(),${memEmbedderModel !== undefined ? "\n          embedder: __memEmbedder," : ""}
        });
        const runContext = createRunContext();
        const tracker = createCostTracker(runContext.eventBus, { suppressEvents: true });
        try {
          const summary = await runChatLoop({
            model: ${escapeJsonString(ir.agent.model)},
            instructions: input.playbook,
            runContext,
            singleTurn: true,
            seedMessages: [{ role: "user", content: input.prompt }],
            sessionName: ${escapeJsonString(ir.name)},
            sessionTarget: "dream",
            tools: __tools,
            hooks: [],
            maxToolIterations: input.maxToolIterations,
            budget: {
              usdMicros: Math.round(input.budgetUsd * 1_000_000),
              onExceed: { kind: "stop" },
            },
            spinner: false,
          });
          return {
            sessionId: runContext.sessionId,
            spentUsd: tracker.getRunCost(runContext.runId).totalUsdMicros / 1_000_000,
            summary,
          };
        } finally {
          tracker.unsubscribe();
        }
      },
    },
  });
}
`;

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: agent.ts)
import { runChatLoop } from "@crewhaus/runtime-core";
import type { EgressAuditSink, JustificationAuditSink } from "@crewhaus/runtime-core";
import { createRunContext } from "@crewhaus/run-context";
import { classifyInbound } from "@crewhaus/channel-adapter-base";
${permImport}${subAgentTypeImport}${memImport}${evalImport}import type { HookDef } from "@crewhaus/hooks-engine";
import type { SkillRef } from "@crewhaus/skills-registry";
import type { SlashCommand } from "@crewhaus/slash-commands";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { PromptCacheRotationStore } from "@crewhaus/prompt-cache-manager";
${fragmentBlock}${memEmbedderBlock}${evaluationBlock}
export type AgentConfig = {
  hooks: ReadonlyArray<HookDef>;
  skills: ReadonlyArray<SkillRef>;
  slashCommands: ReadonlyMap<string, SlashCommand>;
  tools: ReadonlyArray<RegisteredTool>;
  sessionRootDir?: string;
  // Cluster S (D36/NEW-shape-1) — the per-turn memory/continuity fabric root.
  // The daemon leaves it unset (process.cwd(), the deployed posture); the eval
  // bridge entry pins it to the runner's per-sample directory so a bridged
  // eval keeps the Pillar-2 isolation invariant (no fact/plan/handoff leak
  // between samples, nothing written into the operator's working tree).
  fabricRoot?: string;
  // Cluster S — scripted-provider test seam (the same \`_adapter\` the other
  // bridged entries expose), so bridge smoke tests drive the REAL runTurn
  // credential-free. Never set by the daemon.
  _adapter?: Parameters<typeof runChatLoop>[0]["_adapter"];
  // Loop contract 0.4 (Batch E, G78) — cross-run prompt-cache rotation
  // persistence (§2.5): a long-running channel daemon reads the last rotation
  // stamp before each turn (so a still-fresh cache prefix is REUSED instead of
  // cold-started) and persists a fresh stamp when the runtime rotates.
  promptCacheStore: PromptCacheRotationStore;
  // G48 — durable, hash-chained security audit sink (the Pillar 3 justification
  // + egress gates append here). The daemon opens one @crewhaus/audit-log
  // instance rooted at <cwd>/.crewhaus/audit and passes it to BOTH fields, so
  // the intent-gate + egress records land on one gapless chain.
  justificationAuditSink?: JustificationAuditSink;
  egressAuditSink?: EgressAuditSink;
${thredzOn ? "  // Loop contract 0.4 (Batch E, G23) — the live Thredz connection from the\n  // daemon's connectThredz boot (null when the backend degraded to local\n  // files), threaded into every per-turn wireMemory call as the backend flip.\n  thredz: ThredzConnection | null;\n" : ""}${subAgentConfigFields}};

export type RunTurnArgs = {
  sessionId: string;
  isNew: boolean;
  message: string;${runTurnArgsScopeField}
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
      const __inbound = await classifyInbound(args.message, runContext, { origin: "channel" });${memTurnBlock}
      return await runChatLoop({
        model: ${escapeJsonString(ir.agent.model)},
        instructions: ${escapeJsonString(ir.agent.instructions)},${renderAgentTuningFields(ir)}${renderModelFailoverFields(ir)}${renderFailureTaxonomyField(ir)}${renderBudgetField(ir)}${evaluation.field}${renderLimitsFields(ir)}${renderCompactionFields(ir)}
        sessionName: ${escapeJsonString(ir.name)},
        sessionTarget: "channel",
        ...(config.sessionRootDir !== undefined ? { sessionRootDir: config.sessionRootDir } : {}),
        // Loop contract 0.4 (Batch E, G78) — thread the persisted rotation
        // stamp in (undefined force-refreshes, the safe direction) and persist
        // a fresh stamp out when the runtime rotates the cache markers (§2.5).
        promptCacheLastRotatedAt: await config.promptCacheStore.read(),
        onPromptCacheRotated: (rotatedAt) => config.promptCacheStore.write(rotatedAt),
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: __inbound }],
        ...(args.isNew ? {} : { resume: { sessionId: args.sessionId } }),
        tools: ${toolsExpr},
        hooks: config.hooks,
        skills: ${skillsExpr},
        slashCommands: ${slashCommandsExpr},${permField}${subAgentRunFields}${memRunField}
        ...(config.justificationAuditSink !== undefined
          ? { justificationAuditSink: config.justificationAuditSink }
          : {}),
        ...(config.egressAuditSink !== undefined
          ? { egressAuditSink: config.egressAuditSink }
          : {}),
        ...(config._adapter !== undefined ? { _adapter: config._adapter } : {}),
      });
    },
  };
}
${dreamStepBlock}`;
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
  // root (item.ts is the bot reply's ts), so exact attribution rides the
  // outbound-ts → (sessionId, turnNumber) join store the router appends on
  // every posted reply (D40): handleReaction resolves the reacted-to ts
  // through the join for EVERY sessionKey — thread included — and lands the
  // feedback on the exact turn (a reaction on an older reply is no longer
  // pinned to the newest turn). On a join miss (a reply posted before the
  // join accumulated, or an adapter whose sendReply returns no receipt)
  // channel/user keys fall back to last-turn attribution under the routing
  // key — the pre-join behavior — while thread drops the reaction (its
  // routing key is unrecoverable from the reaction event alone).
  const feedbackReactions = ir.feedback?.channelReactions === true;
  const reactionRoutingKeyExpr =
    sessionKey === "user"
      ? "`${adapter.id}:${reaction.workspaceId}:${reaction.userId}`"
      : "`${adapter.id}:${reaction.workspaceId}:${reaction.channelId}`";
  const reactionImports = feedbackReactions
    ? '\nimport { appendFile, mkdir, readFile } from "node:fs/promises";\nimport { dirname, join } from "node:path";\nimport { openEventLog } from "@crewhaus/event-log";\nimport type { InboundReaction } from "@crewhaus/channel-adapter-slack";'
    : "";
  const reactionTypeMember = feedbackReactions
    ? "\n  handleReaction(reaction: InboundReaction, adapter: ChannelAdapter): Promise<void>;"
    : "";
  // Module-scope join store: append on post, scan on reaction. Lives beside
  // the ratings sink (`.crewhaus/feedback/`) in a `joins/` subdirectory so
  // the CLI's bare-record feedback readers (which glob `*.jsonl` files, not
  // directories) never parse it as FeedbackRecords.
  const reactionJoinBlock = !feedbackReactions
    ? ""
    : `
/**
 * D40 — outbound-ts → (sessionId, turnNumber) join store. Every assistant
 * reply this daemon posts appends one record here, so a reaction on that
 * message (Slack's reaction_added carries only channel + message ts, never
 * the thread root) attributes to the EXACT turn it reacted to — for every
 * routing.sessionKey, thread included. Append-only JSONL beside the ratings
 * sink (.crewhaus/feedback/), scanned in full per reaction (reactions are
 * rare; the last matching record wins). Replies posted before this build's
 * join began accumulating miss and take the per-key fallback in
 * handleReaction.
 */
const REACTION_JOIN_FILE = join(process.cwd(), ".crewhaus", "feedback", "joins", "channel.jsonl");

type ReactionJoin = {
  schemaVersion: number;
  adapterId: string;
  workspaceId: string;
  channelId: string;
  outboundTs: string;
  sessionId: string;
  turnNumber: number;
  ts: string;
};

async function appendReactionJoin(record: ReactionJoin): Promise<void> {
  await mkdir(dirname(REACTION_JOIN_FILE), { recursive: true });
  await appendFile(REACTION_JOIN_FILE, JSON.stringify(record) + "\\n", "utf-8");
}

async function resolveReactionJoin(
  reaction: InboundReaction,
  adapterId: string,
): Promise<{ sessionId: string; turnNumber: number } | null> {
  let raw: string;
  try {
    raw = await readFile(REACTION_JOIN_FILE, "utf-8");
  } catch {
    return null; // no join file yet — nothing posted since the store landed
  }
  let match: { sessionId: string; turnNumber: number } | null = null;
  for (const line of raw.split("\\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn append — skip the line, keep scanning
    }
    const r = parsed as Partial<ReactionJoin>;
    if (
      r.adapterId === adapterId &&
      r.workspaceId === reaction.workspaceId &&
      r.channelId === reaction.channelId &&
      r.outboundTs === reaction.messageTs &&
      typeof r.sessionId === "string" &&
      typeof r.turnNumber === "number"
    ) {
      match = { sessionId: r.sessionId, turnNumber: r.turnNumber };
    }
  }
  return match;
}
`;
  // Closure-scope post helper: needs sessionStore for the turn number. The
  // receipt cast tolerates adapters whose sendReply predates the message-ts
  // receipt (they resolve void): no receipt ⇒ no join line ⇒ reactions on
  // that reply take handleReaction's per-key fallback.
  const sendReplyJoinHelper = !feedbackReactions
    ? ""
    : `
  // D40 — post the assistant reply, then append the outbound-ts join record
  // so a later reaction on this exact message attributes to this turn. A
  // join append failure never fails the turn — the reply is already
  // delivered.
  const sendReplyWithJoin = async (
    adapter: ChannelAdapter,
    event: InboundEvent,
    sessionId: string,
    text: string,
  ): Promise<void> => {
    const receipt = (await adapter.sendReply({ event, text })) as unknown as
      | { messageTs?: string }
      | undefined;
    const outboundTs = receipt?.messageTs;
    if (outboundTs === undefined) return;
    const session = await sessionStore.get(sessionId);
    if (session === null || session.lastTurnIndex < 1) return;
    try {
      await appendReactionJoin({
        schemaVersion: 1,
        adapterId: adapter.id,
        workspaceId: event.workspaceId,
        channelId: event.channelId,
        outboundTs,
        sessionId,
        turnNumber: session.lastTurnIndex,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      process.stderr.write(
        "[session-router] reaction-join append error: " + (err as Error).message + "\\n",
      );
    }
  };
`;
  // Both attribution paths (join hit + per-key fallback) append the SAME
  // user_feedback record — fb_ idempotency-key hashing included — so a
  // platform redelivery collapses to one id regardless of which path ran.
  const reactionFeedbackAppend = `const log = await openEventLog(
        joined.sessionId,
        config.sessionRootDir !== undefined ? { rootDir: config.sessionRootDir } : {},
      );
      await log.append({
        kind: "user_feedback",
        payload: {
          schemaVersion: 1,
          id: "fb_" + createHash("sha256").update(reaction.idempotencyKey).digest("hex").slice(0, 16),
          sessionId: joined.sessionId,
          turnNumber: joined.turnNumber,
          modality: "binary",
          rating: { thumbs: reaction.vote },
          source: "channel",
          ts: new Date().toISOString(),
        },
      });`;
  const reactionMethod = !feedbackReactions
    ? ""
    : sessionKey === "thread"
      ? `
    async handleReaction(reaction: InboundReaction, adapter: ChannelAdapter): Promise<void> {
      // D40 — the join store resolves the reacted-to ts to the exact turn
      // that posted the message, so thread-keyed sessions get reaction
      // feedback too (the reaction event never carries the thread root).
      const joined = await resolveReactionJoin(reaction, adapter.id);
      if (joined === null) {
        // Join miss under sessionKey "thread": item.ts is the bot reply's ts,
        // not the thread root, so the routing key — and with it the session —
        // is unrecoverable. The reaction is dropped; only replies posted
        // since this build's join began accumulating can be attributed.
        return;
      }
      ${reactionFeedbackAppend}
    },`
      : `
    async handleReaction(reaction: InboundReaction, adapter: ChannelAdapter): Promise<void> {
      // D40 — resolve through the join store first so the feedback lands on
      // the EXACT reacted-to turn (a reaction on an older reply must not be
      // pinned to the newest turn).
      let joined = await resolveReactionJoin(reaction, adapter.id);
      if (joined === null) {
        // Join miss (a reply posted before this build's join began
        // accumulating): fall back to last-turn attribution under the
        // session's routing key — the pre-join behavior.
        const routingKey = ${reactionRoutingKeyExpr};
        const sessionId = deriveSessionId(routingKey);
        const session = await sessionStore.get(sessionId);
        if (session === null || session.lastTurnIndex < 1) return;
        joined = { sessionId, turnNumber: session.lastTurnIndex };
      }
      ${reactionFeedbackAppend}
    },`;
  // The reply-post call sites (inbound handle + approval resume) switch to
  // the join-appending helper only when reactions are on, so every other
  // bundle stays byte-identical. (The approval-prompt `sendText` fallback in
  // approvalsCatch below is a THIRD outbound post site that deliberately
  // does not join — see the D40 exemption note there.)
  const replyPost = feedbackReactions
    ? "await sendReplyWithJoin(adapter, event, sessionId, reply);"
    : "await adapter.sendReply({ event, text: reply });";
  const approvalReplyPost = feedbackReactions
    ? "await sendReplyWithJoin(adapter, event, approval.sessionId, reply);"
    : "await adapter.sendReply({ event, text: reply });";

  // Gateway status counters — the /status endpoint (daemon.ts) reports a
  // turnCount, so the router signals each completed agent turn back to the
  // daemon via an optional onTurnComplete callback. Gated on `gateway:` so a
  // gateway-less channel bundle stays byte-identical (no field, no call).
  const countersOn = ir.gateway !== undefined;
  const countersConfigField = countersOn ? "\n  onTurnComplete?: () => void;" : "";
  // Emitted after each successful runTurn (inbound handle + approval resume).
  const turnCompleteCall = countersOn ? "\n        config.onTurnComplete?.();" : "";

  // G11 — when `permissions.ask_mode` is "pause" (the default; only "deny"
  // opts out) a tool ask on this non-interactive surface PARKS a pending
  // approval instead of collapsing to a deny. The session-router surfaces the
  // Approve/Deny prompt on park and re-drives the turn on grant.
  const approvalsOn = ir.permissions.askMode !== "deny";
  const approvalsImports = approvalsOn
    ? '\nimport { postApprovalPrompt } from "@crewhaus/channel-adapter-base";\nimport type { ApprovalStore, PendingApproval } from "@crewhaus/channel-adapter-base";\nimport { isRunFailedError } from "@crewhaus/errors";'
    : "";
  const approvalsConfigField = approvalsOn ? "\n  approvals?: ApprovalStore;" : "";
  const approvalsResumeTypeMember = approvalsOn
    ? "\n  resumeApproval(approval: PendingApproval, adapter: ChannelAdapter): Promise<void>;"
    : "";
  const approvalsResumeState = approvalsOn
    ? "\n  // G11 — approvalId → the inbound event that parked it, so a granted\n  // approval re-drives that turn and replies in the right thread.\n  const __resumeContexts = new Map<string, InboundEvent>();"
    : "";
  // D40 join exemption — the approval-prompt text fallback (`sendText:` in
  // the catch below) posts via plain adapter.sendReply, NEVER
  // sendReplyWithJoin: the parked turn is incomplete (lastTurnIndex still
  // names the PREVIOUS turn), so appending a join line for the prompt would
  // attribute a reaction on it to that previous turn. Prompt reactions
  // instead take handleReaction's per-key miss fallback (last-turn for
  // channel/user, drop for thread) — the least-bad option for an in-flight
  // turn. Do not "fix" this by switching the fallback to the join helper.
  const approvalsCatch = approvalsOn
    ? `      } catch (err) {
        if (
          config.approvals !== undefined &&
          isRunFailedError(err) &&
          err.report.class === "approval_pending"
        ) {
          // G11 — the run parked a pending approval instead of failing. Surface
          // the Approve/Deny prompt (Slack buttons, or a text fallback for
          // adapters without interactive buttons) and return; the turn resumes
          // out-of-band once the approval is granted (or is dropped on deny).
          const __pending = await config.approvals.list({ status: "pending", sessionId });
          const __postApproval = adapter.postApproval;
          for (const __appr of __pending) {
            __resumeContexts.set(__appr.id, event);
            await postApprovalPrompt({
              pending: __appr,
              sendText: (text) => adapter.sendReply({ event, text }),
              ...(__postApproval !== undefined
                ? { postInteractive: (approval) => __postApproval({ event, approval }) }
                : {}),
            });
          }
          await tryReact("warning");
          return;
        }
        await tryReact("warning");
        throw err;
      }`
    : `      } catch (err) {
        await tryReact("warning");
        throw err;
      }`;
  const approvalsResumeMethod = approvalsOn
    ? `
    async resumeApproval(approval: PendingApproval, adapter: ChannelAdapter): Promise<void> {
      const event = __resumeContexts.get(approval.id);
      __resumeContexts.delete(approval.id);
      // Only a granted approval re-drives the turn; a denial's in-thread ACK
      // already recorded the outcome, and a resume with no captured event
      // (resolved by the CLI verb, or after a restart) waits for the next
      // inbound message.
      if (approval.status !== "grant" || event === undefined) return;
      try {
        const reply = await config.agent.runTurn({
          sessionId: approval.sessionId,
          isNew: false,
          message: event.text,
        });
        if (reply.length > 0) {
          ${approvalReplyPost}
        }
        if (adapter.react) {
          try {
            await adapter.react({ event, emoji: "white_check_mark" });
          } catch {
            // non-fatal
          }
        }${turnCompleteCall}
      } catch (err) {
        process.stderr.write(
          "[session-router] approval resume error (" + approval.id + "): " + (err as Error).message + "\\n",
        );
      }
    },`
    : "";

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: session-router.ts)
import { createHash } from "node:crypto";
import { createSessionStore } from "@crewhaus/session-store";
import type { ChannelAdapter, InboundEvent } from "@crewhaus/channel-adapter-slack";${reactionImports}${approvalsImports}
import type { Agent } from "./agent.js";

export type SessionRouterConfig = {
  agent: Agent;
  sessionRootDir?: string;${approvalsConfigField}${countersConfigField}
};

export type SessionRouter = {
  handle(event: InboundEvent, adapter: ChannelAdapter): Promise<void>;${reactionTypeMember}${approvalsResumeTypeMember}
};

/**
 * Derive a deterministic sess_<16hex> id from a routing key. sha256 →
 * hex → first 16 chars → prefix with sess_. Keeps the channel session
 * id stable across daemon restarts for the same thread/user/channel.
 */
function deriveSessionId(routingKey: string): string {
  return "sess_" + createHash("sha256").update(routingKey).digest("hex").slice(0, 16);
}
${reactionJoinBlock}
export function createSessionRouter(config: SessionRouterConfig): SessionRouter {
  const sessionStore = createSessionStore(
    config.sessionRootDir !== undefined ? { rootDir: config.sessionRootDir } : {},
  );${approvalsResumeState}${sendReplyJoinHelper}
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
          ${replyPost}
        }
        await tryReact("white_check_mark");${turnCompleteCall}
${approvalsCatch}
    },${reactionMethod}${approvalsResumeMethod}
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

  // G11 — the interactivity (button-click) route + shared approval store, wired
  // whenever `permissions.ask_mode` is not "deny".
  const approvalsOn = ir.permissions.askMode !== "deny";
  const gatewayApprovalImports = approvalsOn
    ? '\nimport { resolveApproval } from "@crewhaus/channel-adapter-base";\nimport type { ApprovalStore, ApprovalAuditSink } from "@crewhaus/channel-adapter-base";'
    : "";
  const gatewayApprovalConfig = approvalsOn
    ? `
  /**
   * G11 — the shared pending-approval store. The \`/<adapter>/actions\` route
   * resolves a parked approval here on a button click; the parked turn (in the
   * session-router) awaits the same store. Absent ⇒ the actions route ACKs and
   * ignores (no approval surface).
   */
  approvals?: ApprovalStore;
  /** G48 — durable audit sink; an approval resolution appends one record. */
  auditSink?: ApprovalAuditSink;`
    : "";
  const gatewayActionsBlock = approvalsOn
    ? `      // G11 — interactivity webhook (an Approve/Deny button click), verified
      // with the SAME signing machinery as an events webhook and resolved via
      // the shared store. Path: /<adapter>/actions.
      const actionMatch = url.pathname.match(/^\\/([^/]+)\\/actions$/);
      if (actionMatch && actionMatch[1] !== undefined) {
        const actionAdapter = config.adapters.get(actionMatch[1]);
        if (!actionAdapter || !actionAdapter.parseInteraction) {
          return new Response("unknown channel", { status: 404 });
        }
        const actionBody = await req.text();
        const actionReq = { headers: req.headers, body: actionBody };
        if (!actionAdapter.verify(actionReq)) {
          return new Response("invalid signature", { status: 401 });
        }
        const interaction = actionAdapter.parseInteraction(actionReq);
        if (interaction.kind !== "approval_action" || config.approvals === undefined) {
          return new Response("ok", { status: 200 });
        }
        const by = actionAdapter.id + ":" + interaction.userId;
        const resolved = await resolveApproval({
          store: config.approvals,
          approvalId: interaction.approvalId,
          decision: interaction.decision,
          by,
          ...(config.auditSink !== undefined ? { auditSink: config.auditSink } : {}),
        });
        if (resolved === null) return new Response("unknown approval", { status: 200 });
        const ackApproval = actionAdapter.ackApproval;
        if (ackApproval !== undefined) {
          try {
            await ackApproval({ interaction, decision: interaction.decision, by, toolName: resolved.toolName });
          } catch (err) {
            process.stderr.write("[gateway] approval ack error: " + (err as Error).message + "\\n");
          }
        }
        // Resume runs off the ACK path so a slow re-drive can't stall the 3s
        // interactivity response; the parked turn re-executes pre-resolved.
        queueMicrotask(() => {
          config.sessionRouter.resumeApproval(resolved, actionAdapter).catch((err) => {
            process.stderr.write("[gateway] approval resume error: " + (err as Error).message + "\\n");
          });
        });
        return new Response("ok", { status: 200 });
      }
`
    : "";

  return `// Generated by crewhaus. DO NOT EDIT.
// Channel-generic gateway: dispatches signed webhooks to the matching adapter.
import { InMemoryDedupStore, type DedupStore } from "@crewhaus/durable-state";
import type { ChannelAdapter } from "@crewhaus/channel-adapter-slack";${gatewayApprovalImports}
import type { SessionRouter } from "./session-router.js";

export type GatewayConfig = {
  adapters: ReadonlyMap<string, ChannelAdapter>;
  sessionRouter: SessionRouter;${gatewayApprovalConfig}
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
${gatewayActionsBlock}      // Match adapter by path prefix: /slack/events → "slack".
      const match = url.pathname.match(/^\\/([^/]+)\\/events$/);
      if (!match || match[1] === undefined) return new Response("not found", { status: 404 });
      const adapter = config.adapters.get(match[1]);
      if (!adapter) return new Response("unknown channel", { status: 404 });

      // Subscription handshake (Meta/WhatsApp \`hub.challenge\`): an unsigned
      // GET with no body, so it cannot go through verify()/parseInbound() —
      // the adapter authenticates it against its own shared verify token and
      // we echo the challenge only on its say-so. Adapters whose platform has
      // no such handshake leave \`handshake\` undefined and fall through to the
      // signed path below unchanged.
      if (req.method === "GET" && adapter.handshake !== undefined) {
        const handshake = adapter.handshake({ headers: req.headers, url });
        if (handshake.kind === "challenge") {
          return new Response(handshake.challenge, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        return new Response("verification failed", { status: 403 });
      }

      const body = await req.text();
      const rawReq = { headers: req.headers, body };
      if (!adapter.verify(rawReq)) {
        return new Response("invalid signature", { status: 401 });
      }
      const parsed = adapter.parseInbound(rawReq);
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

/**
 * Loop contract 0.4 (Batch C, G26) — lower the `observability` block to the
 * env stamps the runtime's env-gated subscribers read (`attachDefaultSubscribers`
 * takes only `process.env`). Emitted at daemon module scope with `??=` so an
 * operator's own deploy-time env always wins. DEFAULTS (spec absence != off):
 * cost tracking + the low-overhead trace ring are default-ON; the pretty/json
 * printer, metrics, alerts, incidents, and OTel export stay opt-in. An explicit
 * `cost: { enabled: false }` / `metrics: { enabled: true }` reaches the IR
 * verbatim and is honoured.
 */
function renderObservabilityEnvStamp(ir: IrChannelV0): string {
  const obs = ir.observability;
  const lines: string[] = [];
  // cost — default ON: low-overhead microdollar accrual (cost_accrual events).
  if ((obs?.cost?.enabled ?? true) === true) {
    lines.push('process.env["CREWHAUS_COST_TRACKING"] ??= "1";');
  }
  // trace — default "ring" (bus ring buffer only, no printer). pretty/json
  // attach the structured-event-printer; "off" and "ring" attach no printer
  // (the ring buffer is bus-internal and not env-disable-able here).
  const traceLevel = obs?.trace?.level ?? "ring";
  if (traceLevel === "pretty" || traceLevel === "json") {
    lines.push(`process.env["CREWHAUS_TRACE"] ??= ${escapeJsonString(traceLevel)};`);
  }
  // metrics / alerts / incidents — opt-in OFF; stamp only when enabled.
  if (obs?.metrics?.enabled === true) {
    lines.push('process.env["CREWHAUS_METRICS"] ??= "stdout";');
  }
  if (obs?.alerts?.enabled === true) {
    lines.push('process.env["CREWHAUS_ALERTS"] ??= "1";');
  }
  if (obs?.incidents?.enabled === true) {
    lines.push('process.env["CREWHAUS_INCIDENTS"] ??= "1";');
  }
  // otel — keyed on an endpoint; a `$VAR` value resolves to that env var.
  const endpoint = obs?.otel?.endpoint;
  if (endpoint !== undefined && endpoint.length > 0) {
    const expr = endpoint.startsWith("$")
      ? `process.env[${escapeJsonString(endpoint.slice(1))}]`
      : escapeJsonString(endpoint);
    lines.push(`process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= ${expr};`);
  }
  // "Watch me" (watch-me §6.3) — the live-capture gate runtime-core's
  // attachWatchmeCapture reads, stamped only when the spec opted into full
  // capture. `watchme:` is a SIBLING of `observability:` but shares this
  // emitter so `??=` precedence stays in one place per path. Mirror:
  // `crewhaus run`'s applyRunObservabilityEnv (via resolveWatchmeEnv) and
  // target-cli's bundle preamble stamp the same env — keep the three in sync.
  if (ir.watchme?.enabled === true && ir.watchme.capture === "full") {
    lines.push('process.env["CREWHAUS_WATCHME"] ??= "1";');
  }
  if (lines.length === 0) return "";
  return `\n// G26 — observability lowered to env stamps (\`??=\` so an operator's own env\n// still wins). cost tracking + the trace ring are default-on; printers,\n// metrics, alerts, incidents, and OTel export stay opt-in.\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// File 4: daemon.ts — entrypoint. Boots everything and serves HTTP.
// ---------------------------------------------------------------------------

/**
 * Loop contract 0.4 (Batch F) — render the `IrSchedule` as a
 * durable-execution `WakeSchedule` object literal (the IR MINUS
 * `instructions`, which the daemon threads into `onWake` separately). Numeric
 * fields are already ms-normalized at lower time, so JSON.stringify yields
 * valid, byte-stable JS. Shared verbatim with target-batch-worker — keep in
 * sync.
 */
function wakeScheduleLiteral(schedule: IrSchedule): string {
  const literal =
    schedule.kind === "cron"
      ? {
          kind: "cron" as const,
          cron: schedule.cron,
          ...(schedule.timezone !== undefined ? { timezone: schedule.timezone } : {}),
          ...(schedule.jitterMs !== undefined ? { jitterMs: schedule.jitterMs } : {}),
        }
      : {
          kind: "interval" as const,
          everyMs: schedule.everyMs,
          ...(schedule.jitterMs !== undefined ? { jitterMs: schedule.jitterMs } : {}),
        };
  return JSON.stringify(literal);
}

/** A one-line human description of a schedule for the daemon's [schedule]
 *  boot log. Shared verbatim with target-batch-worker — keep in sync. */
function describeSchedule(schedule: IrSchedule): string {
  const base =
    schedule.kind === "cron"
      ? `cron "${schedule.cron}"${schedule.timezone !== undefined ? ` ${schedule.timezone}` : " UTC"}`
      : `every ${schedule.everyMs}ms`;
  return schedule.jitterMs !== undefined ? `${base} +/-${schedule.jitterMs}ms jitter` : base;
}

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
  const knowledge = renderKnowledge(ir);
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
    const waVerifyToken =
      whatsapp.verifyToken !== undefined
        ? `\n  verifyToken: ${renderSecretExpr(whatsapp.verifyToken)} ?? "",`
        : "";
    adapterConstructs.push(`const whatsappAdapter = createWhatsAppAdapter({
  phoneNumberId: ${waPhoneId} ?? "",
  accessToken: ${waAccessToken} ?? "",
  appSecret: ${waAppSecret} ?? "",${waVerifyToken}
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

  // Adapter construction lives INSIDE main() (indented one level), not at
  // module scope: some adapters refuse to boot by throwing from their factory
  // — iMessage rejects a non-macOS host or a missing
  // CREWHAUS_IMESSAGE_HOST_ENABLED=1 opt-in, and every adapter's config
  // validation can throw. At module scope those throws escape `main().catch`,
  // so an operator saw a raw Bun stack trace instead of the v0.3.0 formatted
  // failure report every other daemon failure produces.
  const adapterConstructBlock = adapterConstructs
    .join("\n\n")
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
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

  // Loop contract 0.4 (Batch E, G22) — the RAG corpus ingests at daemon boot
  // (async) and registers the Retrieve tool on defaultCatalog before
  // createAgent snapshots `defaultCatalog.list()`.
  const knowledgeImportBlock =
    knowledge.imports.length > 0 ? `${knowledge.imports.join("\n")}\n` : "";
  const knowledgeBoot = knowledge.bootBlock
    ? `\n  // Knowledge RAG (Batch E)\n  ${knowledge.bootBlock.split("\n").join("\n  ")}\n`
    : "";

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
  // v0.3.0 — with continuity on, heartbeat ticks read the daemon's own
  // agenda: `spec`-scoped continuity instead of a throwaway per-tick
  // session store (§2.7/§14.5).
  const hbScopeField = ir.continuity !== undefined ? `\n        continuityScope: "spec",` : "";
  // v0.3.0 Goal 2 (§3.3 study.on_heartbeat, PR 17) — with learning on (and
  // the toggle not opted out), every heartbeat tick doubles as an unattended
  // study tick: the study-rotation preamble (gaps first, ~3:1 study:reflect,
  // bounded per tick — the expert demo's HEARTBEAT.md policy, productized)
  // is baked ahead of the operator's own heartbeat instructions at CODEGEN
  // time, so the emitted daemon carries the resolved text.
  const hbInstructions =
    ir.heartbeat === undefined
      ? ""
      : ir.learning?.study.onHeartbeat
        ? `${renderStudyRotationPreamble(ir.learning)}\n${ir.heartbeat.instructions}`
        : ir.heartbeat.instructions;
  const heartbeatBoot = ir.heartbeat
    ? `
  // Phase 3 §3.1 — heartbeat scheduled wake
  const __heartbeatInstructions = ${escapeJsonString(hbInstructions)};
  let __heartbeatTick = 0;
  const __heartbeatTimer = setInterval(async () => {
    __heartbeatTick++;${ir.gateway ? "\n    __heartbeatCount++; // gateway /status wake counter (heartbeat + schedule)" : ""}
    const __sessionId = \`sess_\${__hbRandomBytes(8).toString("hex")}\`;
    process.stdout.write(\`[heartbeat] tick #\${__heartbeatTick} (session \${__sessionId})\\n\`);
    try {
      const __out = await agent.runTurn({
        sessionId: __sessionId,
        isNew: true,
        message: __heartbeatInstructions,${hbScopeField}
      });
      const __preview = __out.length > 200 ? __out.slice(0, 200) + "…" : __out;
      process.stdout.write(\`[heartbeat] → \${__preview}\\n\`);
    } catch (__err) {
      // v0.3.0 Goal 6 — a classified terminal failure (billing/auth/…)
      // renders its full structured report; anything else keeps the bare
      // line. Either way the daemon keeps running — a failed tick must
      // not kill the scheduler.
      if (isRunFailedError(__err)) {
        process.stderr.write(\`\${formatRunFailure(__err.report, { prefix: "[heartbeat]" })}\\n\`);
      } else {
        process.stderr.write(\`[heartbeat] error: \${(__err as Error).message}\\n\`);
      }
    }
  }, ${ir.heartbeat.everyMs});
  process.stdout.write(\`[heartbeat] enabled every ${ir.heartbeat.everyMs}ms\\n\`);
`
    : "";
  const heartbeatShutdown = ir.heartbeat ? "\n      clearInterval(__heartbeatTimer);" : "";

  // Loop contract 0.4 (Batch F, temporal contract / G84) — the `schedule:`
  // wake loop. When the IR carries a schedule, the daemon arms
  // durable-execution's `armSchedule` (all cron/interval + jitter arithmetic
  // lives there — one tested place). Each wake runs a fresh-session turn with
  // the synthetic wake prompt, exactly like the heartbeat's "wake, decide,
  // act, sleep" pattern; a failed wake is classified and logged but never
  // crashes the daemon. Absent `schedule:` emits NOTHING, so unscheduled
  // channel bundles stay byte-identical.
  const scheduleImport = ir.schedule
    ? `import { armSchedule } from "@crewhaus/durable-execution";\nimport { randomBytes as __schedRandomBytes } from "node:crypto";\n`
    : "";
  const schedScopeField =
    ir.schedule && ir.continuity !== undefined ? `\n          continuityScope: "spec",` : "";
  const scheduleBoot = ir.schedule
    ? `
  // Loop contract 0.4 (Batch F) — schedule: wake loop (cron|interval + jitter)
  const __scheduleInstructions = ${escapeJsonString(ir.schedule.instructions ?? "[scheduled wake] proceed with your standing instructions.")};
  let __scheduleTick = 0;
  const __schedule = armSchedule(${wakeScheduleLiteral(ir.schedule)}, {
    onWake: async () => {
      __scheduleTick++;${ir.gateway ? "\n      __heartbeatCount++; // gateway /status wake counter (heartbeat + schedule)" : ""}
      const __sessionId = \`sess_\${__schedRandomBytes(8).toString("hex")}\`;
      process.stdout.write(\`[schedule] wake #\${__scheduleTick} (session \${__sessionId})\\n\`);
      const __out = await agent.runTurn({
        sessionId: __sessionId,
        isNew: true,
        message: __scheduleInstructions,${schedScopeField}
      });
      const __preview = __out.length > 200 ? __out.slice(0, 200) + "…" : __out;
      process.stdout.write(\`[schedule] → \${__preview}\\n\`);
    },
    onError: (__err) => {
      // A classified terminal failure renders its full report; anything else
      // keeps the bare line. Either way the daemon keeps serving.
      if (isRunFailedError(__err)) {
        process.stderr.write(\`\${formatRunFailure(__err.report, { prefix: "[schedule]" })}\\n\`);
      } else {
        process.stderr.write(\`[schedule] error: \${(__err as Error).message}\\n\`);
      }
    },
  });
  process.stdout.write(${escapeJsonString(`[schedule] armed (${describeSchedule(ir.schedule)})\n`)});
`
    : "";
  const scheduleShutdown = ir.schedule ? "\n      __schedule.cancel();" : "";

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
  // __turnCount / __heartbeatCount are declared earlier (before
  // createSessionRouter) so the router callback + heartbeat/schedule ticks
  // can bump them; this endpoint only reads them.
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
          \`<!doctype html><html><head><meta charset="utf-8"><title>\${${escapeJsonString(ir.name)}}</title><style>body{font-family:system-ui;padding:2rem;max-width:48rem;margin:auto;color:#333}h1{margin-bottom:0.25rem}pre{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}</style></head><body><h1>\${${escapeJsonString(ir.name)}}</h1><p>channel daemon · <a href="/status">/status</a></p><pre id="s">loading…</pre><script>fetch("/status").then(r=>r.json()).then(d=>{document.getElementById("s").textContent=JSON.stringify(d,null,2)})</script></body></html>\`,
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

  // v0.3.0 — with continuity on, skills + slash commands come from the
  // memory fabric per turn (wireMemory merges the builtin `continuity`
  // skill and commands at lowest precedence with ~/.crewhaus + project
  // entries); the daemon's own discovery would strand the builtin skill
  // (advertised in the prompt with no Skill tool able to load it).
  const continuityOn = ir.continuity !== undefined;

  // v0.3.0 PR 14 (§6.3) — register the dream consolidation step into the
  // existing boot+hourly janitor tick. The step itself (agent.ts) due-checks
  // .crewhaus/dream/<spec>/state.json and honors CREWHAUS_DREAM=0 /
  // CREWHAUS_DREAM_INTERVAL_MS; a null step (no dream schedule) registers
  // nothing.
  const dreamOn = dreamConfigured(ir);
  const dreamBoot = dreamOn
    ? `
  // v0.3.0 §6.3 — scheduled memory consolidation (dream), hosted by the
  // janitor: due-checked each tick against .crewhaus/dream/<spec>/state.json.
  const __dreamStep = createDreamStep();
`
    : "";
  // D39 — the distill janitor step, registered BESIDE the dream step through
  // the same `createJanitor({ steps })` seam.
  const distillOn = daemonDistillConfigured(ir);
  const distill = distillOn
    ? renderDistillStepBoot(ir.name, ir.feedback)
    : { imports: "", boot: "", stepExpr: "" };
  // A dream-only spec keeps its historical single-expression form byte for
  // byte; the spread form only appears once a second step is registered.
  const dreamStepsField = !distillOn
    ? dreamOn
      ? "\n    steps: __dreamStep !== null ? [__dreamStep] : [],"
      : ""
    : `\n    steps: [${[
        ...(dreamOn ? ["...(__dreamStep !== null ? [__dreamStep] : [])"] : []),
        `...(${distill.stepExpr})`,
      ].join(", ")}],`;
  // Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks (`hooks:`).
  // IrHook is HookDef-shaped by contract (the spec ↔ hooks-engine
  // cross-check test pins the event list), so codegen embeds them as a
  // literal LAYERED BELOW the settings.json-discovered ones — spec entries
  // first, then loadHooks()' user → project entries (aggregateDecisions'
  // later-wins mutate merge keeps the settings layers authoritative — the
  // permission RuleSet's settings-over-yaml precedence; mirror: target-cli
  // and the `crewhaus run` interpreter). Declaration order within the
  // spec is preserved (hooks run in registration order) and all hooks
  // still RUN (any deny wins regardless of layer). Absent/empty leaves
  // bundles byte-identical.
  const specHooks = ir.hooks !== undefined && ir.hooks.length > 0 ? ir.hooks : undefined;
  const hooksEngineImport = `import { loadHooks${specHooks !== undefined ? ", type HookDef" : ""} } from "@crewhaus/hooks-engine";`;
  const specHooksBoot =
    specHooks !== undefined
      ? `\n  // Loop contract 0.4 — spec-declared lifecycle hooks, layered below the\n  // settings.json-discovered ones (spec first; user → project later-wins).\n  const __specHooks: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`
      : "";
  const agentHooksExpr = specHooks !== undefined ? "[...__specHooks, ...__hooks]" : "__hooks";
  const extensionImports = continuityOn
    ? `${hooksEngineImport}
import { defaultCatalog } from "@crewhaus/tool-catalog";`
    : `${hooksEngineImport}
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { defaultCatalog } from "@crewhaus/tool-catalog";`;
  const extensionBoot = continuityOn
    ? `  const __cwd = process.cwd();
  const __hooks = await loadHooks({ cwd: __cwd });`
    : `  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);
  if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));`;
  const agentSkillsFields = continuityOn
    ? `    skills: [],
    slashCommands: new Map(),`
    : `    skills: __skills,
    slashCommands: __slashCommands,`;

  // Loop contract 0.4 (Batch E, G23) — thredz is now emit-WIRED on channel:
  // the daemon's connectThredz boot flips the wiki backend, so the live
  // connection threads into createAgent as the `thredz` config field (only
  // meaningful when the memory fabric wires — wireMemory is the sole
  // consumer of the live connection).
  const thredzOn = ir.thredz !== undefined && memoryFabric(ir).wired;
  const thredzCreateAgentField = thredzOn ? "\n    thredz: __thredz," : "";

  // Loop contract 0.4 (Batch C) — observability env stamps (G26), the durable
  // security audit sink (G48), and the pending-approval surface (G11).
  const observabilityEnvStamp = renderObservabilityEnvStamp(ir);
  const approvalsOn = ir.permissions.askMode !== "deny";
  const approvalsImport = approvalsOn
    ? 'import { InMemoryApprovalStore } from "@crewhaus/channel-adapter-base";\n'
    : "";
  const auditApprovalsBoot = `
  // G48 — durable, hash-chained security audit sink rooted at
  // <cwd>/.crewhaus/audit. The Pillar 3 justification + egress gates append
  // here so an unattended daemon's security decisions are tamper-evidenced.
  // Opt out with CREWHAUS_SECURITY_AUDIT=0.
  const __securityAudit =
    process.env["CREWHAUS_SECURITY_AUDIT"] === "0"
      ? undefined
      : await openAuditLog({ rootDir: join(__cwd, ".crewhaus", "audit") });
${
  approvalsOn
    ? "  // G11 — the shared pending-approval store: the parked turn (session-router)\n  // and the /<adapter>/actions webhook rendezvous here. In-memory default —\n  // volatile, so a restart forgets parked approvals; a durable/cross-process\n  // backend (shared with the `crewhaus approvals` CLI verbs) is a follow-up.\n  const __approvals = new InMemoryApprovalStore();\n"
    : ""
}`;
  const agentAuditFields =
    "\n    ...(__securityAudit !== undefined\n      ? { justificationAuditSink: __securityAudit, egressAuditSink: __securityAudit }\n      : {}),";
  const sessionRouterApprovalsField = approvalsOn ? ", approvals: __approvals" : "";
  const gatewayApprovalsFields = approvalsOn
    ? "\n    approvals: __approvals,\n    auditSink: __securityAudit,"
    : "";
  // Gateway status counters. Declared here (before createSessionRouter) so the
  // router's onTurnComplete callback and the heartbeat/schedule boot blocks
  // can all close over the same __turnCount / __heartbeatCount. The /status
  // endpoint (gatewayBoot) is their only reader, so both are gated on
  // `gateway:` — a gateway-less bundle declares nothing and stays unchanged.
  const gatewayCounters = ir.gateway ? "  let __turnCount = 0;\n  let __heartbeatCount = 0;\n" : "";
  const sessionRouterCountersField = ir.gateway ? ", onTurnComplete: () => { __turnCount++; }" : "";
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: daemon.ts)
import { formatRunFailure, ${ir.heartbeat || ir.schedule ? "isRunFailedError, " : ""}toFailureReport } from "@crewhaus/errors";
${extensionImports}
${adapterImports.join("\n")}
import { registerChannelAdapter } from "@crewhaus/tool-message-channel";
${heartbeatImport}${scheduleImport}${builtinImportBlock}${mcpImportBlock}${knowledgeImportBlock}${subAgentImportBlock}import { createAgent${dreamOn ? ", createDreamStep" : ""} } from "./agent.js";
import { createSessionRouter } from "./session-router.js";
import { createGateway } from "./gateway.js";
import { loadRetentionConfig } from "@crewhaus/data-retention-engine";
import { createDedupStore } from "@crewhaus/durable-state";
import { createJanitor } from "@crewhaus/runtime-core";
${distill.imports}import { openAuditLog } from "@crewhaus/audit-log";
import { createPromptCacheRotationStore } from "@crewhaus/prompt-cache-manager";
${approvalsImport}import { join } from "node:path";

${startupEnvCheck}${observabilityEnvStamp}
async function main(): Promise<void> {
  // Channel adapters construct here, inside main(), so an adapter that
  // refuses to boot (the iMessage host opt-in / macOS gate, a bad chat.db
  // path, ...) is reported through the formatted failure handler below
  // instead of escaping as a raw stack trace at module load.
${adapterConstructBlock}

${extensionBoot}${specHooksBoot}${auditApprovalsBoot}
${registerBlock}${mcpBoot}${subAgentBoot}${knowledgeBoot}
  // Loop contract 0.4 (Batch E, G78) — per-spec cross-run prompt-cache
  // rotation store (§2.5). One small JSON record under
  // .crewhaus/prompt-cache/<spec>.json survives restarts so the daemon reuses
  // a still-fresh cache prefix instead of cold-starting it every boot.
  const __promptCacheStore = createPromptCacheRotationStore({ specName: ${escapeJsonString(ir.name)} });
  const agent = createAgent({
    hooks: ${agentHooksExpr},
${agentSkillsFields}
    tools: defaultCatalog.list(),${subAgentCreateAgentFields}${agentAuditFields}${thredzCreateAgentField}
    promptCacheStore: __promptCacheStore,
  });
${gatewayCounters}  const sessionRouter = createSessionRouter({ agent${sessionRouterApprovalsField}${sessionRouterCountersField} });
  // SECURITY (audit R3) — replay-dedup backend. Default in-memory; set
  // CREWHAUS_DEDUP_STORE=sqlite:<path> so seen webhook ids survive restarts
  // and are shared by every daemon process on this host.
  const __dedupStore = createDedupStore(process.env["CREWHAUS_DEDUP_STORE"] ?? "memory");
  const gateway = createGateway({
    adapters: ${adapterMapLiteral},
    sessionRouter,${gatewayApprovalsFields}
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
${dreamBoot}${distill.boot}  const __janitor = createJanitor({
    sessionTtlDays: __retentionTtlDays,
    pinnedSessionIds: __retentionPins,${dreamStepsField}
  });
  if (process.env["CREWHAUS_JANITOR"] !== "0") {
    const __janitorReport = await __janitor.runOnce();
    process.stdout.write(\`[janitor] \${JSON.stringify(__janitorReport.steps)}\\n\`);
    __janitor.start(Number(process.env["CREWHAUS_JANITOR_INTERVAL_MS"] ?? 3_600_000));
  }

  const port = Number(process.env["PORT"] ?? 3000);
  const server = Bun.serve({ port, fetch: (req) => gateway.handle(req) });
  process.stdout.write(\`[daemon] listening on http://localhost:\${server.port}\\n\`);
${gatewayBoot}${heartbeatBoot}${scheduleBoot}
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(\`[daemon] received \${signal}, shutting down...\\n\`);
    __janitor.stop();
    try {
      await server.stop(true);${gatewayShutdown}${heartbeatShutdown}${scheduleShutdown}${mcpCleanup}
    } catch (err) {
      process.stderr.write(\`[daemon] shutdown error: \${(err as Error).message}\\n\`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // v0.3.0 Goal 6 — render the one structured failure report instead of
  // the old bare fatal one-liner, and exit with the report's coded status.
  const __report = toFailureReport(err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[daemon]" })}\\n\`);
  process.exit(__report.exitCode);
});
`;
}

// ---------------------------------------------------------------------------
// File (cluster S, D36/NEW-shape-1): eval-entry.ts — the eval bridge's
// runtime entry. Emitted ONLY under `emitChannelBot(ir, { evalEntry: true })`.
// ---------------------------------------------------------------------------

/**
 * Render `eval-entry.ts`: the channel-resume-turn loopback. Each eval sample
 * is delivered as ONE fresh inbound message through the compiled bot's real
 * `createAgent().runTurn` — the channel boundary classifier, session resume
 * machinery, in-loop evaluation block, taxonomy/budget/limits and the
 * per-turn memory-fabric wiring all run exactly as deployed; only the
 * adapter/gateway webhook layer (which needs live channel credentials) is
 * stubbed out. A sample's `history` is pre-seeded into the session
 * transcript (`user_message`/`assistant_message` events — the exact payload
 * shape runtime-core replays) and the turn runs with `isNew: false`, so the
 * REAL resume path replays it with no model calls for history turns.
 *
 * v0 honesty notes: `mcp_servers` / `knowledge:` / `plugins:` boots are
 * daemon concerns not yet mirrored here (a generated note surfaces each);
 * `runTurn` mints its own RunContext, so trace-bus events stay internal —
 * the session transcript in the caller's `sessionRootDir` is the captured
 * artifact.
 */
function renderEvalEntry(ir: IrChannelV0): string {
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const fabric = memoryFabric(ir);
  const continuityOn = fabric.continuityOn;
  const thredzOn = ir.thredz !== undefined && fabric.wired;
  const subAgents = renderSubAgents(ir);
  const specHooks = ir.hooks !== undefined && ir.hooks.length > 0 ? ir.hooks : undefined;

  const notes = [
    ...(Object.keys(ir.mcp_servers).length > 0
      ? [
          "// note: mcp_servers declared but not booted by the eval bridge entry in this slice — MCP tools are absent from bridged channel evals (the daemon boots them at startup)",
        ]
      : []),
    ...(ir.knowledge !== undefined
      ? [
          "// note: knowledge: declared but not ingested by the eval bridge entry in this slice — the Retrieve tool is absent from bridged channel evals",
        ]
      : []),
    ...(thredzOn
      ? [
          "// note: thredz declared — the eval bridge entry passes thredz: null (wireMemory degrades to local files), so bridged evals never write to a live Thredz backend",
        ]
      : []),
  ];
  const notesBlock = notes.length > 0 ? `${notes.join("\n")}\n` : "";

  const builtinImportBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const subAgentImportBlock =
    subAgents.imports.length > 0 ? `${subAgents.imports.join("\n")}\n` : "";
  const skillsImports = continuityOn
    ? ""
    : `import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
`;
  const hooksEngineImport = `import { loadHooks${specHooks !== undefined ? ", type HookDef" : ""} } from "@crewhaus/hooks-engine";`;

  const initLines = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const registerLines = registrations.length > 0 ? `${registrations.join("\n")}\n` : "";
  const subAgentBoot = subAgents.hasAny
    ? `const __subAgents: ReadonlyMap<string, SubAgentDefinition> = new Map<string, SubAgentDefinition>([
${ir.subAgents.map((d) => `  [${escapeJsonString(d.name)}, ${renderSubAgentDef(d)}],`).join("\n")}
]);
defaultCatalog.register(createTaskTool({ subAgents: __subAgents }));
`
    : "";
  const toolBoot =
    initLines.length > 0 || registerLines.length > 0 || subAgentBoot.length > 0
      ? `\n// Built-in tools (from spec.agent.tools) — the same catalog the daemon\n// snapshots into createAgent.\n${initLines}${registerLines}${subAgentBoot}`
      : "";

  const specHooksBoot =
    specHooks !== undefined
      ? `\n  const __specHooks: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`
      : "";
  const hooksExpr = specHooks !== undefined ? "[...__specHooks, ...__hooks]" : "__hooks";
  const extensionBoot = continuityOn
    ? `  const __cwd = process.cwd();
  const __hooks = await loadHooks({ cwd: __cwd });${specHooksBoot}`
    : `  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);${specHooksBoot}
  if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));`;
  const skillsFields = continuityOn
    ? `    skills: [],
    slashCommands: new Map(),`
    : `    skills: __skills,
    slashCommands: __slashCommands,`;
  const thredzField = thredzOn ? "\n    thredz: null," : "";
  const subAgentFields = subAgents.hasAny
    ? "\n    subAgents: __subAgents,\n    spawnSubAgent,"
    : "";

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: channel, ir version: ${ir.version}, file: eval-entry.ts — the compile --with-eval-harness bridge entry)
${notesBlock}import { randomBytes } from "node:crypto";
import { openEventLog } from "@crewhaus/event-log";
import { createSessionStore } from "@crewhaus/session-store";
${hooksEngineImport}
${skillsImports}import { defaultCatalog } from "@crewhaus/tool-catalog";
${builtinImportBlock}${subAgentImportBlock}import { createAgent, type AgentConfig } from "./agent.ts";
${toolBoot}
/**
 * Eval bridge (cluster S, D36/NEW-shape-1) — deliver ONE inbound message
 * through the compiled bot's real runTurn (loopback: no adapter/webhook).
 * \`history\` pre-seeds the session transcript so the real resume path
 * replays it; \`sessionRootDir\` re-roots the session log (the caller's
 * per-sample artifact directory); the returned string is the bot's reply.
 */
export async function runForEval(
  input: string,
  __evalOpts: {
    sessionId?: string;
    sessionRootDir?: string;
    history?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    _adapter?: AgentConfig["_adapter"];
  } = {},
): Promise<string> {
${extensionBoot}
  const agent = createAgent({
    hooks: ${hooksExpr},
${skillsFields}
    tools: defaultCatalog.list(),
    ...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),
    // Pillar-2 per-sample isolation: the memory/continuity fabric roots at the
    // caller's sample directory when supplied, so sample N's facts/plan/
    // handoff can never leak into sample N+1 (nor into the operator's cwd).
    ...(__evalOpts.sessionRootDir !== undefined ? { fabricRoot: __evalOpts.sessionRootDir } : {}),
    // One-shot eval turns never benefit from a persisted prompt-cache stamp.
    promptCacheStore: { read: async () => undefined, write: async () => {} },${thredzField}${subAgentFields}
    ...(__evalOpts._adapter !== undefined ? { _adapter: __evalOpts._adapter } : {}),
  });
  const __sessionId = __evalOpts.sessionId ?? \`sess_\${randomBytes(8).toString("hex")}\`;
  const __history = __evalOpts.history ?? [];
  if (__history.length > 0) {
    // B14 semantics through the REAL session machinery: seeded turns land in
    // the transcript verbatim and the resumed turn replays them with no
    // model calls for history turns.
    //
    // The resume path reads the session RECORD (\`<root>/<id>.json\`) before it
    // replays the log, so the record must exist alongside the seeded events —
    // an event log alone makes runChatLoop throw "session not found".
    const __store = createSessionStore(
      __evalOpts.sessionRootDir !== undefined ? { rootDir: __evalOpts.sessionRootDir } : {},
    );
    if ((await __store.get(__sessionId)) === null) {
      await __store.create({
        id: __sessionId,
        name: ${escapeJsonString(ir.name)},
        target: "channel",
        model: ${escapeJsonString(ir.agent.model)},
      });
    }
    const __log = await openEventLog(
      __sessionId,
      __evalOpts.sessionRootDir !== undefined ? { rootDir: __evalOpts.sessionRootDir } : {},
    );
    for (const __m of __history) {
      await __log.append({
        kind: __m.role === "user" ? "user_message" : "assistant_message",
        payload: { content: __m.content },
      });
    }
    await __log.close();
  }
  return agent.runTurn({
    sessionId: __sessionId,
    isNew: __history.length === 0,
    message: input,
  });
}
`;
}
