import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type BundleReadmeSection,
  type IrLimits,
  type IrPermissions,
  type IrV0,
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
 * Emit a Cloudflare Worker bundle for a CLI-target IR. Sibling of
 * `@crewhaus/target-cli`'s `emitCli`: same IR shape in, different generated
 * artifacts out.
 *
 * Loop contract 0.4 (Batch F, G12/G83) — the emitted worker imports
 * `@crewhaus/worker-runtime` and runs the SHARED `runWorkerLoop` over a
 * stateless {@link WorkerPlatform} (injected clock, `crypto.randomUUID`, the
 * platform `fetch`; storage absent). Through the shared runtime the worker
 * carries real edge-safe tools decided by the spec's permission rules, the
 * `limits:` keys the edge enforces, the `CHAT_TOKEN` bearer on `/chat`, and
 * the trace frames — the payoff of the G12 node-free guarantee. A tool runs
 * only when an `alwaysAllow` rule covers the call, since a worker has nobody
 * to approve one. Host tools are rejected at compile time; a run that
 * outgrows its context window ends with a classified error frame (no
 * compaction on the edge). `/chat` streams the `text`/`done`/`error` SSE
 * vocabulary, with `trace` frames beside it.
 *
 * Bundle contents:
 *   - `worker.js`        — entrypoint (ES module Worker) that imports the
 *                          shared runtime + edge-safe tool factories; deploy
 *                          bundles it (`wrangler deploy` / studio server-side)
 *   - `wrangler.toml`    — deploy descriptor
 *   - `package.json`     — declares the runtime + tool dependencies
 */
export function emitCfWorkerCli(ir: IrV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "cli") {
    throw new TargetEmitError(`emitCfWorkerCli requires target "cli", got "${ir.target}"`);
  }
  // Provider gate — the shared runtime's edge adapter POSTs CONFIG.model to
  // api.anthropic.com verbatim, so a non-Anthropic model string would compile
  // cleanly and 502 at runtime. Fail at compile time instead.
  assertAnthropicModel(ir.agent.model, "agent");
  // Loop contract 0.4 (Batch F, G12/G83) — the cf-worker edge-safety tool
  // gate replaces the old blanket "does not support tools" rejection. Host
  // tools (bash/fs/code-exec/device) hard-fail; unrecognised custom tools are
  // permitted with a warning surfaced in the generated worker.
  const wiring = resolveEdgeTools(ir.tools, ir.toolConfigs);
  const publicChat = ir.cfWorker?.publicChat === true;

  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? [...opts.allowedOrigins]
      : DEFAULT_ALLOWED_ORIGINS;
  const files = [
    { path: "worker.js", content: renderWorker(ir, wiring, allowedOrigins) },
    { path: "wrangler.toml", content: renderWrangler(ir, publicChat) },
    { path: "package.json", content: renderPackageJson(ir, wiring) },
  ];
  // Item 42 — generated bundle README; default ON. The default per-target
  // run snippet keys on ir.target ("cli" → `bun agent.ts`), which is wrong
  // for a Worker bundle, so substitute the wrangler flow.
  if (opts.readme !== false) {
    files.push({
      path: "README.md",
      content: renderBundleReadme(ir, {
        ...cfWorkerReadmeOpts(publicChat, wiring.toolsExpr !== "[]"),
        unwiredTools: { names: new Set(wiring.unwired), note: CF_WORKER_UNWIRED_NOTE },
        toolFacts: readmeToolFacts([{ tools: ir.tools, toolConfigs: ir.toolConfigs }]),
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
 * `cf_worker.public_chat`; `hasTools` says the worker wires a tool.
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
 * provider (openai/, gemini/, bedrock/, local/…) — the edge adapter only
 * speaks the Anthropic Messages API.
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

// --------------------------------------------------------------------------
// Edge-safe tool wiring (Batch F, G12/G83)
// --------------------------------------------------------------------------

/** The generated tool wiring for one IR: the import block, per-tool init
 *  calls, the `TOOLS` array expression, the npm packages to declare, and the
 *  names permitted-but-not-wired (warned custom + MCP) for the note comment. */
export type EdgeToolWiring = {
  readonly imports: string;
  readonly inits: string;
  readonly toolsExpr: string;
  readonly packages: readonly string[];
  readonly unwired: readonly string[];
};

/**
 * Partition a tool list through the single-source-of-truth edge policy
 * (`partitionEdgeTools`), THROW on any host tool (the old blanket rejection is
 * gone), and render the import/registration wiring for the edge-safe builtins.
 * Unrecognised custom tools and `mcp__*` tools are permitted but not wired
 * (the generated worker notes them); a host tool hard-fails the compile.
 */
export function resolveEdgeTools(
  names: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): EdgeToolWiring {
  const { rejected } = partitionEdgeTools(names);
  if (rejected.length > 0) {
    const detail = rejected.map((r) => r.reason).join("; ");
    throw new TargetEmitError(
      `cf-worker target cannot run ${rejected.length} host tool(s): ${detail}. These need a host (process/filesystem/sandbox/device) the edge does not provide — use the cli target for them, or remove them.`,
    );
  }
  // The builtins the edge wires come from the one shared table (its `edge`
  // column); everything else — a builtin the worker does not run, a custom
  // name, an `mcp__*` name — is returned unwired, in first-seen order. Each
  // wired export is aliased `__t_<name>` so it never collides with a global
  // (`fetch`!) or another package's export.
  const resolved = resolveBuiltinTools("cf-worker", [{ tools: names, toolConfigs }], undefined, {
    edgeImportsInSpecOrder: true,
  });
  return {
    imports: resolved.imports.join("\n"),
    inits: resolved.inits.join("\n"),
    toolsExpr: `[${(resolved.sites[0] ?? []).join(", ")}]`,
    packages: [...resolved.packages],
    unwired: [...resolved.unwired],
  };
}

/** The refusal for a `justify` escalation, which needs the intent gate. */
const JUSTIFY_REFUSAL =
  "limits.loop_detection.escalation: justify needs the intent gate, which a worker does not run — use warn or abort";

/** Render the worker's `limits` argument to `runWorkerLoop` from the IR's
 *  `limits:` block: the keys the edge enforces. A `justify` escalation needs
 *  the intent gate, which a worker does not run, so it is refused with a
 *  `TargetEmitError`. */
function renderLimits(limits: IrLimits | undefined): string {
  if (limits === undefined) return "undefined";
  const out: Record<string, unknown> = {};
  if (limits.maxToolIterations !== undefined) out["maxToolIterations"] = limits.maxToolIterations;
  if (limits.contextLimit !== undefined) out["contextLimit"] = limits.contextLimit;
  if (limits.deadlineMs !== undefined) out["deadlineMs"] = limits.deadlineMs;
  if (limits.loopDetection !== undefined) {
    const ld: Record<string, unknown> = {};
    if (limits.loopDetection.window !== undefined) ld["window"] = limits.loopDetection.window;
    if (limits.loopDetection.threshold !== undefined) {
      ld["threshold"] = limits.loopDetection.threshold;
    }
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

/** The generated `edge-unsafe-tool` note comment for permitted-but-unwired
 *  tools (custom + MCP), mirroring the failure_taxonomy ignored-note pattern. */
function edgeToolNote(unwired: readonly string[]): string {
  if (unwired.length === 0) return "";
  return `// note: ${unwired.length} tool(s) permitted but not wired on this edge worker (${unwired.join(", ")}) — custom tools cannot be verified fetch/KV-only offline, and mcp__* tools arrive from mcp_servers (unwired on cf-worker); they are omitted from the model's tool set\n`;
}

// --------------------------------------------------------------------------
// worker.js
// --------------------------------------------------------------------------

function renderWorker(ir: IrV0, wiring: EdgeToolWiring, allowedOrigins: readonly string[]): string {
  // escapeJsonString === JSON.stringify: each of these is a COMPLETE, quoted
  // JS/JSON string literal already. Do NOT wrap them in extra quotes below.
  const name = escapeJsonString(ir.name);
  const model = escapeJsonString(ir.agent.model);
  const instructions = escapeJsonString(ir.agent.instructions);
  const allowed = JSON.stringify(allowedOrigins);
  const maxTokens = ir.agent.maxTokens ?? 4096;
  const thinking =
    ir.agent.thinking !== undefined ? JSON.stringify(ir.agent.thinking) : "undefined";
  const limits = renderLimits(ir.limits);
  const permissions = renderPermissions(ir.permissions);
  const publicChat = ir.cfWorker?.publicChat === true;
  // Loop contract 0.4 (Batch C, item 3) — the /chat SSE carries `trace` events
  // in the TraceEvent vocabulary. `observability.trace: off` suppresses them;
  // every other level (default "ring", "pretty", "json") emits. Baked as a
  // literal boolean so the generated worker carries no config parse.
  const traceEnabled = (ir.observability?.trace?.level ?? "ring") !== "off";

  // Item 23 — failure_taxonomy is a Node-recovery-engine concern the edge loop
  // does not run; surface the ignored config as a generated comment.
  const taxonomyWarning =
    ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? "// note: failure_taxonomy configured but target-cf-worker-cli does not wire it up on the edge — it is ignored\n"
      : "";
  const toolNote = edgeToolNote(wiring.unwired);
  const toolImports = wiring.imports.length > 0 ? `${wiring.imports}\n` : "";
  const toolInits = wiring.inits.length > 0 ? `\n${wiring.inits}\n` : "";

  return `// Generated by @crewhaus/target-cf-worker-cli. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-cli\`.
${taxonomyWarning}${toolNote}import { runWorkerLoop, createEdgeAnthropicAdapter, chatAuthRefusal } from "@crewhaus/worker-runtime";
${toolImports}${toolInits}
const CONFIG = {
  name: ${name},
  model: ${model},
  instructions: ${instructions},
  allowedOrigins: ${allowed},
  trace: ${traceEnabled},
  maxTokens: ${maxTokens},
  thinking: ${thinking},
  limits: ${limits},
  permissions: ${permissions},
  publicChat: ${publicChat},
};

// The edge-safe tool set the shared loop runs (empty when the spec declares no
// wireable tools). Each entry is a real RegisteredTool executed by the runtime.
const TOOLS = ${wiring.toolsExpr};

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

  // A stateless WorkerPlatform: the clock + id generator are resolved here at
  // the request boundary (never inside the loop), fetch is the platform fetch,
  // and there is no KV binding (no parking / idempotency on the edge).
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
      // Loop contract 0.4 (Batch C, item 3) — trace frames gated on CONFIG.trace.
      const emitTrace = (event) => { if (CONFIG.trace) emit("trace", event); };

      // Live token streaming: wrap the edge adapter so text deltas fan out as
      // \`text\` frames (byte-compatible with the inlined client) while the loop
      // still collects the full message. \`acc\` is what the client rendered;
      // \`lastStop\` tracks the Anthropic stop_reason for the terminal \`done\`.
      let acc = "";
      let lastStop = "end_turn";
      const base = createEdgeAnthropicAdapter(platform, { apiKey: env.ANTHROPIC_API_KEY });
      const adapter = {
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
      };
      const trace = (event) => {
        if (event.kind === "model_response" && typeof event.stopReason === "string") {
          lastStop = event.stopReason;
        }
        emitTrace(event);
      };

      try {
        const result = await runWorkerLoop({
          platform,
          adapter,
          model: CONFIG.model,
          instructions: CONFIG.instructions,
          messages,
          tools: TOOLS,
          maxTokens: CONFIG.maxTokens,
          ...(CONFIG.thinking ? { thinking: CONFIG.thinking } : {}),
          ...(CONFIG.limits ? { limits: CONFIG.limits } : {}),
          permissions: CONFIG.permissions,
          emitTrace: trace,
        });
        // A failing stop (context_overflow / timeout / provider error) resolves
        // a classified failure rather than throwing — surface it as a terminal
        // \`error\` frame (no compaction/recovery on the edge). Bounded stops
        // (done / max_iterations) keep their terminal text.
        if (result.failure) {
          emit("error", { message: \`\${result.failure.title}: \${result.failure.detail}\` });
        } else {
          emit("done", { text: acc || result.text, stopReason: lastStop });
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

function renderWrangler(ir: IrV0, publicChat: boolean): string {
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

function renderPackageJson(ir: IrV0, wiring: EdgeToolWiring): string {
  // Sanitize like the wrangler name. A raw ir.name breaks out of the JSON
  // string (this manifest is reachable from the hosted compiler-worker HTTP
  // endpoint), allowing dependency/script injection into package.json (#148).
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
