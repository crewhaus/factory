import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type BundleReadmeSection,
  type IrGraphNode,
  type IrGraphV0,
  type IrLimits,
  type IrPermissions,
  renderBundleReadme,
} from "@crewhaus/ir";
import { parseModelString } from "@crewhaus/model-router";
import { readmeToolFacts, resolveBuiltinTools } from "@crewhaus/tool-categories";
import { partitionEdgeTools } from "@crewhaus/worker-runtime/tool-policy";
import pkg from "../package.json" with { type: "json" };

export type EmitOptions = {
  /**
   * Origins the generated Worker should accept on `/chat`. Defaults to the
   * production studio + local dev. Threading this through compile-time
   * lets the studio PWA bake its own origin in so users can host the PWA
   * anywhere (pages.dev, ngrok, LAN IP) without editing the emitter.
   */
  readonly allowedOrigins?: readonly string[];
  /** Item 42 — emit a generated README.md into the bundle. Default true. */
  readonly readme?: boolean;
};

const DEFAULT_ALLOWED_ORIGINS = ["https://studio.crewhaus.ai", "http://localhost:4322"];

/**
 * Emit a Cloudflare Worker bundle for a `target: "graph"` IR. Graph sibling of
 * `@crewhaus/target-cf-worker-cli` — executes a chain of single-turn LLM nodes
 * instead of a single agent.
 *
 * Loop contract 0.4 (Batch F, G12/G83) — each node runs the SHARED
 * `runWorkerLoop` from `@crewhaus/worker-runtime` over a stateless
 * {@link WorkerPlatform}. Through the shared runtime the worker carries real
 * edge-safe tools decided by the spec's permission rules, the `limits:` keys
 * the edge enforces, the `CHAT_TOKEN` bearer on `/chat`, and the trace
 * frames. A tool runs only when an `alwaysAllow` rule covers the call, since
 * a worker has nobody to approve one. Host tools are rejected at compile
 * time; a node that overflows its context ends the run with a classified
 * error frame (no compaction on the edge). `/chat` streams the
 * `text`/`done`/`error` SSE vocabulary.
 *
 * M2 SCOPE — LINEAR, NON-HITL only. A stateless single Worker cannot persist
 * checkpoints across requests, so HITL pause/resume, branching, and time-travel
 * are out of scope: the graph is validated and reduced to a single linear path
 * from `ir.entry`; anything that is not a single path, any HITL node, any
 * `kind: judge` node and any edge with a `when` condition is rejected with
 * `TargetEmitError`. Use the local `@crewhaus/target-graph` for branching,
 * HITL, judge gates and conditional edges.
 */
export function emitCfWorkerGraph(ir: IrGraphV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "graph") {
    throw new TargetEmitError(`emitCfWorkerGraph requires target "graph", got "${ir.target}"`);
  }
  const order = linearOrder(ir);
  // Loop contract 0.4 (Batch F, G12/G83) — the edge-safety tool gate replaces
  // the old blanket "does not support tools" rejection, per node.
  const wiring = resolveGraphTools(order);
  const publicChat = ir.cfWorker?.publicChat === true;

  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? [...opts.allowedOrigins]
      : DEFAULT_ALLOWED_ORIGINS;
  const files = [
    { path: "worker.js", content: renderWorker(ir, order, wiring, allowedOrigins) },
    { path: "wrangler.toml", content: renderWrangler(ir, publicChat) },
    { path: "package.json", content: renderPackageJson(ir, wiring) },
  ];
  if (opts.readme !== false) {
    files.push({
      path: "README.md",
      content: renderBundleReadme(ir, {
        ...cfWorkerReadmeOpts(
          publicChat,
          wiring.nodeTools.some((tools) => tools !== "[]"),
        ),
        unwiredTools: { names: new Set(wiring.unwired), note: CF_WORKER_UNWIRED_NOTE },
        toolFacts: readmeToolFacts(
          ir.nodes.map((n) => ({ tools: n.tools, toolConfigs: n.toolConfigs })),
        ),
      }),
    });
  }
  return { files };
}

/** The README note for a tool the worker leaves out. */
const CF_WORKER_UNWIRED_NOTE =
  "left out of this worker — the edge runtime does not run it (see the compile warning)";

/**
 * The README's Deploy steps and the sections that say how the worker is
 * called and which tool calls it runs. `publicChat` is the spec's
 * `cf_worker.public_chat`; `hasTools` says some node wires a tool.
 */
function cfWorkerReadmeOpts(
  publicChat: boolean,
  hasTools: boolean,
): {
  readonly usage: BundleReadmeSection;
  readonly includeWorkspaceNote: false;
  readonly extraSections: readonly BundleReadmeSection[];
} {
  const deploy = [
    "```sh",
    "npm install                              # resolve the crewhaus runtime + tools",
    "wrangler secret put ANTHROPIC_API_KEY    # one-time Worker secret",
    ...(publicChat
      ? []
      : ["wrangler secret put CHAT_TOKEN           # the bearer token POST /chat requires"]),
    "wrangler deploy                          # bundles worker.js + its imports",
    "```",
    ...(publicChat
      ? []
      : [
          "",
          "Pick a long random `CHAT_TOKEN` (for example `openssl rand -base64 32`) and give it only to the clients that call this worker; for `wrangler dev`, put it in `.dev.vars`.",
        ]),
  ];
  const curl = [
    "```sh",
    "curl -N https://<your-worker>.workers.dev/chat \\",
    ...(publicChat ? [] : ['  -H "Authorization: Bearer $CHAT_TOKEN" \\']),
    '  -H "Content-Type: application/json" \\',
    `  -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
    "```",
  ];
  const calling = publicChat
    ? [
        "`POST /chat` answers without a token (`cf_worker.public_chat: true`): anyone with this worker's URL can run it on your `ANTHROPIC_API_KEY` and its tools. Put Cloudflare Access or a rate-limiting rule in front of it.",
        "",
        ...curl,
        "",
        '`GET /health` answers `{"ok":true}`.',
      ]
    : [
        "Send the bearer token with every `POST /chat` request:",
        "",
        ...curl,
        "",
        'A missing or wrong token is answered with 401, and every `/chat` request is answered with 503 and the code `NO_CHAT_TOKEN` until `CHAT_TOKEN` is set. `GET /health` answers `{"ok":true}` without a token.',
        "",
        "A token written into a web page can be read by everyone who opens it: call the worker from a backend, or put Cloudflare Access in front of it.",
      ];
  return {
    usage: { heading: "Deploy", body: deploy.join("\n") },
    // A deployed Worker has no local `.crewhaus/` workspace.
    includeWorkspaceNote: false,
    extraSections: [
      {
        heading: "Calling the worker",
        body: [
          ...calling,
          "",
          "This worker keeps no spend meter: set a spending limit on the Anthropic account its key belongs to.",
        ].join("\n"),
      },
      ...(hasTools ? [{ heading: "Tools on this worker", body: CF_WORKER_TOOLS_NOTE }] : []),
    ],
  };
}

/** The README's word on which tool calls the worker runs. */
const CF_WORKER_TOOLS_NOTE =
  "A tool runs on this worker only when an `alwaysAllow` rule in `permissions.rules` covers the call: `WebFetch`, or `WebFetch(https://api.example.com/**)` for one site. A matching `alwaysDeny` or `alwaysAsk` rule wins over any `alwaysAllow`. `mode: auto` reads as `default`, and `mode: plan` runs only read-only tools. Any other call returns an error to the model, because a worker has nobody to approve it.";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Reject any model string the router would dispatch to a non-Anthropic
 * provider — the edge adapter only speaks the Anthropic Messages API.
 */
function assertAnthropicModel(model: string, where: string): void {
  let providerId: string;
  try {
    providerId = parseModelString(model).providerId;
  } catch (err) {
    throw new TargetEmitError(`${where} model "${model}": ${(err as Error).message}`, err);
  }
  if (providerId !== "anthropic") {
    throw new TargetEmitError(
      `${where} model "${model}" routes to provider "${providerId}" — cf-worker targets currently support claude-* models only — use the cli target for other providers`,
    );
  }
}

/**
 * Validate the graph (entry declared; every edge from/to references a declared
 * node), reject the features a stateless Worker cannot honour (HITL, judge
 * gates, conditional edges), and reduce
 * the graph to a single deterministic linear execution order by walking from
 * `ir.entry`. Tools are NOT rejected here — they go through the edge-safety gate
 * (`resolveGraphTools`). Throws `TargetEmitError` if the graph is not reducible
 * to a single linear path.
 */
function linearOrder(ir: IrGraphV0): readonly IrGraphNode[] {
  const byName = new Map(ir.nodes.map((n) => [n.name, n] as const));

  if (!byName.has(ir.entry)) {
    throw new TargetEmitError(
      `entry node "${ir.entry}" is not declared in nodes (${[...byName.keys()].join(", ")})`,
    );
  }
  for (const e of ir.edges) {
    if (!byName.has(e.from)) {
      throw new TargetEmitError(`edge references unknown node "${e.from}" (from)`);
    }
    if (!byName.has(e.to)) {
      throw new TargetEmitError(`edge references unknown node "${e.to}" (to)`);
    }
  }

  // Feature gating — a stateless single Worker can't honour these.
  for (const n of ir.nodes) {
    assertAnthropicModel(n.model, `node "${n.name}"`);
    if (n.hitlPrompt !== undefined) {
      throw new TargetEmitError(
        `cf-worker-graph does not support HITL in M2 (node "${n.name}" has hitlPrompt); use the local graph target for HITL`,
      );
    }
    if (n.kind === "judge") {
      throw new TargetEmitError(
        `cf-worker-graph does not run judge gates (node "${n.name}" is kind: judge); use the local graph target for a gated graph`,
      );
    }
  }
  // The worker walks one fixed path and evaluates no edge condition, so an
  // edge that carries one is refused.
  for (const e of ir.edges) {
    if (e.when !== undefined) {
      throw new TargetEmitError(
        `cf-worker-graph does not evaluate edge conditions (edge "${e.from}" → "${e.to}" has when); use the local graph target for a conditional graph`,
      );
    }
  }

  // Outgoing-edge fan-out: at most one edge out of any node (linear).
  const next = new Map<string, string>();
  for (const e of ir.edges) {
    if (next.has(e.from)) {
      const outgoing = ir.edges.filter((x) => x.from === e.from).length;
      throw new TargetEmitError(
        `cf-worker-graph supports only linear single-path graphs in M2 (node "${e.from}" has ${outgoing} outgoing edges); use the local graph target for branching/HITL`,
      );
    }
    next.set(e.from, e.to);
  }

  // Walk the single path from entry; a revisit means a cycle.
  const order: IrGraphNode[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = ir.entry;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw new TargetEmitError(
        `cf-worker-graph supports only linear single-path graphs in M2 (cycle detected at node "${cursor}"); use the local graph target for branching/HITL`,
      );
    }
    seen.add(cursor);
    const node = byName.get(cursor);
    if (node === undefined) {
      throw new TargetEmitError(`edge references unknown node "${cursor}"`);
    }
    order.push(node);
    cursor = next.get(cursor);
  }

  // Every declared node must be on the single path (no unreachable nodes).
  if (seen.size !== ir.nodes.length) {
    const unreachable = ir.nodes.filter((n) => !seen.has(n.name)).map((n) => n.name);
    throw new TargetEmitError(
      `cf-worker-graph supports only linear single-path graphs in M2 (unreachable nodes: ${unreachable.join(", ")}); use the local graph target for branching/HITL`,
    );
  }

  return order;
}

// --------------------------------------------------------------------------
// Edge-safe tool wiring (Batch F, G12/G83)
// --------------------------------------------------------------------------

export type EdgeToolWiring = {
  readonly imports: string;
  readonly inits: string;
  /** One `TOOLS` array expression per node, in linear order. */
  readonly nodeTools: readonly string[];
  readonly packages: readonly string[];
  readonly unwired: readonly string[];
};

/**
 * Resolve edge-safe tool wiring across every node: ONE import block (deduped
 * across nodes) + per-node `TOOLS` arrays. Host tools in any node hard-fail the
 * compile. `mcp__*`/custom tools are permitted but left unwired.
 */
export function resolveGraphTools(order: readonly IrGraphNode[]): EdgeToolWiring {
  const { rejected } = partitionEdgeTools(order.flatMap((unit) => unit.tools));
  if (rejected.length > 0) {
    const detail = rejected.map((r) => r.reason).join("; ");
    throw new TargetEmitError(
      `cf-worker target cannot run ${rejected.length} host tool(s): ${detail}. These need a host (process/filesystem/sandbox/device) the edge does not provide — use the cli target for them, or remove them.`,
    );
  }
  // The one shared resolver, over every unit at once: ONE import block, the
  // first configured unit's registrar call, and a per-unit TOOLS array.
  const resolved = resolveBuiltinTools(
    "cf-worker",
    order.map((unit) => ({ tools: unit.tools, toolConfigs: unit.toolConfigs })),
  );
  return {
    imports: resolved.imports.join("\n"),
    inits: resolved.inits.join("\n"),
    nodeTools: resolved.sites.map((ids) => `[${ids.join(", ")}]`),
    packages: [...resolved.packages],
    unwired: [...resolved.unwired],
  };
}

/** The refusal for a `justify` escalation, which needs the intent gate. */
const JUSTIFY_REFUSAL =
  "limits.loop_detection.escalation: justify needs the intent gate, which a worker does not run — use warn or abort";

/** Map the IR's `limits:` block to the runWorkerLoop `limits` the edge
 *  enforces; each node's loop gets the same ceilings, as a local graph's
 *  nodes do. A `justify` escalation needs the intent gate, which a worker
 *  does not run, so it is refused with a `TargetEmitError`. */
function renderLimits(limits: IrLimits | undefined): string {
  if (limits === undefined) return "undefined";
  const out: Record<string, unknown> = {};
  if (limits.maxToolIterations !== undefined) out["maxToolIterations"] = limits.maxToolIterations;
  if (limits.contextLimit !== undefined) out["contextLimit"] = limits.contextLimit;
  if (limits.deadlineMs !== undefined) out["deadlineMs"] = limits.deadlineMs;
  if (limits.loopDetection !== undefined) {
    const ld: Record<string, unknown> = {};
    if (limits.loopDetection.window !== undefined) ld["window"] = limits.loopDetection.window;
    if (limits.loopDetection.threshold !== undefined)
      ld["threshold"] = limits.loopDetection.threshold;
    if (limits.loopDetection.escalation === "justify") throw new TargetEmitError(JUSTIFY_REFUSAL);
    if (limits.loopDetection.escalation !== undefined) {
      ld["escalation"] = limits.loopDetection.escalation;
    }
    if (Object.keys(ld).length > 0) out["loopDetection"] = ld;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "undefined";
}

/** The worker's `permissions`: the spec's mode, only when set, and its rules
 *  in declared order. `askMode` is not carried: every ask is refused on a
 *  worker, whatever it says. */
function renderPermissions(permissions: IrPermissions): string {
  return JSON.stringify({
    ...(permissions.mode !== undefined ? { mode: permissions.mode } : {}),
    rules: permissions.rules.map((rule) => ({ type: rule.type, pattern: rule.pattern })),
  });
}

function edgeToolNote(unwired: readonly string[]): string {
  if (unwired.length === 0) return "";
  return `// note: ${unwired.length} tool(s) permitted but not wired on this edge worker (${unwired.join(", ")}) — custom tools cannot be verified fetch/KV-only offline, and mcp__* tools arrive from mcp_servers (unwired on cf-worker); they are omitted from the model's tool set\n`;
}

// --------------------------------------------------------------------------
// worker.js
// --------------------------------------------------------------------------

function renderWorker(
  ir: IrGraphV0,
  order: readonly IrGraphNode[],
  wiring: EdgeToolWiring,
  allowedOrigins: readonly string[],
): string {
  const name = escapeJsonString(ir.name);
  const allowed = JSON.stringify(allowedOrigins);
  const limits = renderLimits(ir.limits);
  const permissions = renderPermissions(ir.permissions);
  const publicChat = ir.cfWorker?.publicChat === true;
  const traceEnabled =
    ((ir as { observability?: { trace?: { level?: string } } }).observability?.trace?.level ??
      "ring") !== "off";
  const nodes = order
    .map((n) => {
      const maxTokens = n.maxTokens ?? 4096;
      const thinking = n.thinking !== undefined ? JSON.stringify(n.thinking) : "undefined";
      return `    { name: ${escapeJsonString(n.name)}, model: ${escapeJsonString(n.model)}, instructions: ${escapeJsonString(n.instructions)}, maxTokens: ${maxTokens}, thinking: ${thinking} },`;
    })
    .join("\n");

  const taxonomyWarning =
    ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? "// note: failure_taxonomy configured but target-cf-worker-graph does not wire it up on the edge — it is ignored\n"
      : "";
  const toolNote = edgeToolNote(wiring.unwired);
  const toolImports = wiring.imports.length > 0 ? `${wiring.imports}\n` : "";
  const toolInits = wiring.inits.length > 0 ? `\n${wiring.inits}\n` : "";
  const nodeTools = `[${wiring.nodeTools.join(", ")}]`;

  return `// Generated by @crewhaus/target-cf-worker-graph. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-graph\`.
${taxonomyWarning}${toolNote}import { runWorkerLoop, createEdgeAnthropicAdapter, chatAuthRefusal } from "@crewhaus/worker-runtime";
${toolImports}${toolInits}
const CONFIG = {
  name: ${name},
  nodes: [
${nodes}
  ],
  allowedOrigins: ${allowed},
  trace: ${traceEnabled},
  limits: ${limits},
  permissions: ${permissions},
  publicChat: ${publicChat},
};

// One real edge-safe RegisteredTool array per node, in linear order.
const NODE_TOOLS = ${nodeTools};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const cors = buildCors(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true }, 200, cors);
    }
    if (request.method === "POST" && url.pathname === "/chat") {
      // The CHAT_TOKEN bearer is checked first: a request without it is
      // answered before its body is read or the model key is looked up.
      if (!CONFIG.publicChat) {
        const refusal = await chatAuthRefusal(request.headers.get("authorization"), env.CHAT_TOKEN);
        if (refusal) {
          const headers = refusal.status === 401 ? { ...cors, "WWW-Authenticate": "Bearer" } : cors;
          return json({ error: { code: refusal.code, message: refusal.message } }, refusal.status, headers);
        }
      }
      return handleChat(request, env, cors);
    }
    return json({ error: { code: "NOT_FOUND" } }, 404, cors);
  },
};

async function handleChat(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { code: "NO_KEY", message: "ANTHROPIC_API_KEY not configured" } }, 500, cors);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: "BAD_JSON" } }, 400, cors);
  }
  const messages = normalizeMessages(body && body.messages);
  if (!messages) {
    return json({ error: { code: "BAD_REQUEST", message: "messages must be an array of {role,content}" } }, 400, cors);
  }

  // Graph semantics: seed state from the user's latest message, then run each
  // node single-turn in the baked linear order. Each node's reply text is
  // stored under state[node.name]. All nodes but the last run "silently"
  // (their text threads into downstream state); the last node streams live.
  const lastText = lastUserText(messages);
  let state = { input: lastText };
  const nodes = CONFIG.nodes;

  // A stateless WorkerPlatform: clock + id resolved at the request boundary,
  // the platform fetch, and no KV binding.
  const platform = {
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    fetch: (input, init) => fetch(input, init),
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (event, data) => {
        controller.enqueue(enc.encode(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`));
      };
      const emitTrace = (event) => { if (CONFIG.trace) emit("trace", event); };
      const base = createEdgeAnthropicAdapter(platform, { apiKey: env.ANTHROPIC_API_KEY });

      try {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const isLast = i === nodes.length - 1;
          emit("text", { text: \`\\n[node \${i + 1}/\${nodes.length}: \${node.name}]\\n\` });
          emitTrace({ kind: "node_start", name: node.name, node: i + 1, total: nodes.length });

          const userMessage =
            "Upstream state:\\n\`\`\`json\\n" + JSON.stringify(state, null, 2) + "\\n\`\`\`";

          // Only the last node streams text to the client.
          let acc = "";
          let lastStop = "end_turn";
          const adapter = isLast
            ? {
                ...base,
                async *stream(req) {
                  for await (const ev of base.stream(req)) {
                    if (ev.kind === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
                      acc += ev.delta.text;
                      emit("text", { text: ev.delta.text });
                    }
                    yield ev;
                  }
                },
              }
            : base;
          const trace = (event) => {
            if (event.kind === "model_response" && typeof event.stopReason === "string") {
              lastStop = event.stopReason;
            }
            emitTrace(event);
          };

          const startedAt = platform.now();
          const result = await runWorkerLoop({
            platform,
            adapter,
            model: node.model,
            instructions: node.instructions,
            messages: [{ role: "user", content: userMessage }],
            tools: NODE_TOOLS[i],
            maxTokens: node.maxTokens,
            ...(node.thinking ? { thinking: node.thinking } : {}),
            ...(CONFIG.limits ? { limits: CONFIG.limits } : {}),
            permissions: CONFIG.permissions,
            emitTrace: trace,
          });
          if (result.failure) {
            emit("error", { message: \`node "\${node.name}": \${result.failure.title}: \${result.failure.detail}\` });
            return;
          }
          const text = isLast ? acc || result.text : result.text;
          state = { ...state, [node.name]: text };
          emitTrace({ kind: "node_end", name: node.name, node: i + 1, durationMs: platform.now() - startedAt });

          if (isLast) emit("done", { text, stopReason: lastStop });
        }
      } catch (err) {
        emit("error", { message: err && err.message ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...cors,
    },
  });
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    if (item.role !== "user" && item.role !== "assistant") return null;
    if (typeof item.content !== "string") return null;
    out.push({ role: item.role, content: item.content });
  }
  return out;
}

function buildCors(origin) {
  const allow = origin && CONFIG.allowedOrigins.includes(origin) ? origin : CONFIG.allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
`;
}

function renderWrangler(ir: IrGraphV0, publicChat: boolean): string {
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `name = "${safeName}"
main = "worker.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# worker.js imports @crewhaus/worker-runtime and the edge-safe tool packages;
# \`wrangler deploy\` bundles them (run \`npm install\` first). Its secrets are
# Worker Secrets (never committed):
#   wrangler secret put ANTHROPIC_API_KEY
${chatTokenLine(publicChat)}
# The studio PWA sets ANTHROPIC_API_KEY through its Deploy flow.

[observability]
enabled = true
`;
}

/** The wrangler.toml line that names the `/chat` bearer, or says there is none. */
function chatTokenLine(publicChat: boolean): string {
  return publicChat
    ? "# cf_worker.public_chat: POST /chat answers without a token"
    : "#   wrangler secret put CHAT_TOKEN   # the bearer every POST /chat must send";
}

/**
 * The version every @crewhaus package the generated worker imports is pinned
 * to: this emitter's own. The release train stamps every @crewhaus package with
 * one version (release-prep, lockstep), so it is exactly the runtime and tool
 * packages this emitter was released with, as the other shapes' manifests pin
 * the CLI's version. It was a literal "^0.3.0" until 0.7.1: npm has no
 * @crewhaus/worker-runtime in that range, so `npm install` in an emitted worker
 * failed, and the tool packages resolved to 0.3.x without any later edge fix.
 * A static import, so a compiled binary carries the version it was built from.
 */
const RUNTIME_DEP_VERSION: string = pkg.version;

function renderPackageJson(ir: IrGraphV0, wiring: EdgeToolWiring): string {
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const deps: Record<string, string> = { "@crewhaus/worker-runtime": RUNTIME_DEP_VERSION };
  for (const pkg of wiring.packages) deps[pkg] = RUNTIME_DEP_VERSION;
  return `${JSON.stringify(
    {
      name: safeName,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { deploy: "wrangler deploy", dev: "wrangler dev --local" },
      dependencies: deps,
    },
    null,
    2,
  )}\n`;
}
