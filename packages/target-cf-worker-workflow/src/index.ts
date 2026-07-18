import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type IrLimits,
  type IrWorkflowStep,
  type IrWorkflowV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import { parseModelString } from "@crewhaus/model-router";
import { partitionEdgeTools } from "@crewhaus/worker-runtime/tool-policy";

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
 * Emit a Cloudflare Worker bundle for a WORKFLOW-target IR. Workflow sibling
 * of `@crewhaus/target-cf-worker-cli`'s `emitCfWorkerCli`: same `/chat` SSE
 * protocol, but instead of a single agent it runs the IR's steps sequentially
 * server-side, threading each step's terminal assistant text into the next.
 *
 * Loop contract 0.4 (Batch F, G12/G83) — each step now runs the SHARED
 * `runWorkerLoop` from `@crewhaus/worker-runtime` over a stateless
 * {@link WorkerPlatform}, so a step gains REAL tools (the edge-safe set),
 * budget, limits, and the Batch C trace frames THROUGH the shared runtime.
 * Host tools are rejected at compile time; a step that overflows its context
 * ends the run with a classified error frame (no compaction on the edge). The
 * `/chat` `text`/`done`/`error` vocabulary is byte-compatible.
 */
export function emitCfWorkerWorkflow(ir: IrWorkflowV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "workflow") {
    throw new TargetEmitError(
      `emitCfWorkerWorkflow requires target "workflow", got "${ir.target}"`,
    );
  }
  for (const step of ir.steps) {
    // Provider gate — the shared runtime's edge adapter POSTs each step's model
    // verbatim, so a non-Anthropic model string would 502 at runtime.
    assertAnthropicModel(step.model, `step "${step.name}"`);
  }
  // Loop contract 0.4 (Batch F, G12/G83) — the edge-safety tool gate replaces
  // the old blanket "does not support tools" rejection, per step.
  const wiring = resolveWorkflowTools(ir.steps);

  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? [...opts.allowedOrigins]
      : DEFAULT_ALLOWED_ORIGINS;
  const files = [
    { path: "worker.js", content: renderWorker(ir, wiring, allowedOrigins) },
    { path: "wrangler.toml", content: renderWrangler(ir) },
    { path: "package.json", content: renderPackageJson(ir, wiring) },
  ];
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir, CF_WORKER_README_OPTS) });
  }
  return { files };
}

const CF_WORKER_README_OPTS = {
  usage: {
    heading: "Deploy",
    body: [
      "```sh",
      "npm install                              # resolve the crewhaus runtime + tools",
      "wrangler secret put ANTHROPIC_API_KEY    # one-time Worker secret",
      "wrangler deploy                          # bundles worker.js + its imports",
      "```",
    ].join("\n"),
  },
  includeWorkspaceNote: false,
} as const;

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

// --------------------------------------------------------------------------
// Edge-safe tool wiring (Batch F, G12/G83)
// --------------------------------------------------------------------------

type EdgeToolImport = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};
const EDGE_TOOL_IMPORTS: Readonly<Record<string, EdgeToolImport>> = {
  fetch: { package: "@crewhaus/tool-fetch", export: "fetch", initSymbol: "registerFetchConfig" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  sendMessage: { package: "@crewhaus/tool-message-channel", export: "sendMessage" },
  imageGenerate: {
    package: "@crewhaus/tool-image-generation",
    export: "imageGenerate",
    initSymbol: "registerImageGenerationConfig",
  },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
};

export type EdgeToolWiring = {
  readonly imports: string;
  readonly inits: string;
  /** One `TOOLS` array expression per step, in step order. */
  readonly stepTools: readonly string[];
  readonly packages: readonly string[];
  readonly unwired: readonly string[];
};

/** Classify one unit's tools: THROW on host tools, return the wireable
 *  edge-safe builtins (order-preserving, deduped) + the permitted-but-unwired
 *  names (custom + MCP). */
function classifyUnitTools(names: readonly string[]): { wired: string[]; unwired: string[] } {
  const { rejected, warned, allowed } = partitionEdgeTools(names);
  if (rejected.length > 0) {
    const detail = rejected.map((r) => r.reason).join("; ");
    throw new TargetEmitError(
      `cf-worker target cannot run ${rejected.length} host tool(s): ${detail}. These need a host (process/filesystem/sandbox/device) the edge does not provide — use the cli target for them, or remove them.`,
    );
  }
  const seen = new Set<string>();
  const wired: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (EDGE_TOOL_IMPORTS[name] !== undefined) wired.push(name);
  }
  const unwired = [
    ...allowed.filter((n) => EDGE_TOOL_IMPORTS[n] === undefined),
    ...warned.map((w) => w.name),
  ];
  return { wired, unwired };
}

/**
 * Resolve edge-safe tool wiring across every step: ONE import block (deduped
 * across steps) + per-step `TOOLS` arrays. Host tools in any step hard-fail the
 * compile. `justify`/MCP/custom tools are permitted but left unwired.
 */
export function resolveWorkflowTools(steps: readonly IrWorkflowStep[]): EdgeToolWiring {
  const stepWired: string[][] = [];
  const allUnwired = new Set<string>();
  // Global import grouping + first-config-wins init calls.
  const byPackage = new Map<string, { specs: Set<string>; extras: Set<string> }>();
  const initEmitted = new Set<string>();
  const inits: string[] = [];

  for (const step of steps) {
    const { wired, unwired } = classifyUnitTools(step.tools);
    stepWired.push(wired);
    for (const u of unwired) allUnwired.add(u);
    for (const name of wired) {
      const entry = EDGE_TOOL_IMPORTS[name];
      if (entry === undefined) continue;
      const group = byPackage.get(entry.package) ?? {
        specs: new Set<string>(),
        extras: new Set<string>(),
      };
      group.specs.add(`${entry.export} as __t_${name}`);
      if (entry.initSymbol !== undefined) {
        const cfg = step.toolConfigs[name];
        if (cfg !== undefined && !initEmitted.has(entry.initSymbol)) {
          group.extras.add(entry.initSymbol);
          inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
          initEmitted.add(entry.initSymbol);
        }
      }
      byPackage.set(entry.package, group);
    }
  }

  const importLines: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const group = byPackage.get(pkg);
    if (group === undefined) continue;
    const symbols = [...[...group.specs].sort(), ...[...group.extras].sort()].join(", ");
    importLines.push(`import { ${symbols} } from "${pkg}";`);
  }

  return {
    imports: importLines.join("\n"),
    inits: inits.join("\n"),
    stepTools: stepWired.map((w) => `[${w.map((n) => `__t_${n}`).join(", ")}]`),
    packages: [...byPackage.keys()].sort(),
    unwired: [...allUnwired],
  };
}

/** Map the IR's `limits:` block to the runWorkerLoop `limits` subset the edge
 *  honours (justify escalation degrades to warn). */
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
    if (limits.loopDetection.escalation !== undefined) {
      ld["escalation"] =
        limits.loopDetection.escalation === "justify" ? "warn" : limits.loopDetection.escalation;
    }
    if (Object.keys(ld).length > 0) out["loopDetection"] = ld;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "undefined";
}

function edgeToolNote(unwired: readonly string[]): string {
  if (unwired.length === 0) return "";
  return `// note: ${unwired.length} tool(s) permitted but not wired on this edge worker (${unwired.join(", ")}) — custom tools cannot be verified fetch/KV-only offline, and mcp__* tools arrive from mcp_servers (unwired on cf-worker); they are omitted from the model's tool set\n`;
}

// --------------------------------------------------------------------------
// worker.js
// --------------------------------------------------------------------------

function renderWorker(
  ir: IrWorkflowV0,
  wiring: EdgeToolWiring,
  allowedOrigins: readonly string[],
): string {
  const name = escapeJsonString(ir.name);
  const steps = ir.steps
    .map((step) => {
      const stepName = escapeJsonString(step.name);
      const stepModel = escapeJsonString(step.model);
      const stepInstructions = escapeJsonString(step.instructions);
      const maxTokens = step.maxTokens ?? 4096;
      const thinking = step.thinking !== undefined ? JSON.stringify(step.thinking) : "undefined";
      return `    { name: ${stepName}, model: ${stepModel}, instructions: ${stepInstructions}, maxTokens: ${maxTokens}, thinking: ${thinking} }`;
    })
    .join(",\n");
  const allowed = JSON.stringify(allowedOrigins);
  const limits = renderLimits(ir.limits);
  // Loop contract 0.4 (Batch C, item 3). IrWorkflowV0 does not carry an
  // `observability` field today; the structural read keeps the gate
  // forward-compatible (defaults to trace-ON, honours an explicit off).
  const traceEnabled =
    ((ir as { observability?: { trace?: { level?: string } } }).observability?.trace?.level ??
      "ring") !== "off";

  const taxonomyWarning =
    ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? "// note: failure_taxonomy configured but target-cf-worker-workflow does not wire it up on the edge — it is ignored\n"
      : "";
  const toolNote = edgeToolNote(wiring.unwired);
  const toolImports = wiring.imports.length > 0 ? `${wiring.imports}\n` : "";
  const toolInits = wiring.inits.length > 0 ? `\n${wiring.inits}\n` : "";
  const stepTools = `[${wiring.stepTools.join(", ")}]`;

  return `// Generated by @crewhaus/target-cf-worker-workflow. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-workflow\`.
${taxonomyWarning}${toolNote}import { runWorkerLoop, createEdgeAnthropicAdapter } from "@crewhaus/worker-runtime";
${toolImports}${toolInits}
const CONFIG = {
  name: ${name},
  steps: [
${steps}
  ],
  allowedOrigins: ${allowed},
  trace: ${traceEnabled},
  limits: ${limits},
};

// One real edge-safe RegisteredTool array per step, in step order.
const STEP_TOOLS = ${stepTools};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const cors = buildCors(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, harness: CONFIG.name }, 200, cors);
    }
    if (request.method === "POST" && url.pathname === "/chat") {
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

  // The workflow's initial input is the user's latest message text. Anthropic
  // rejects empty user content, so fall back to "begin".
  let initialInput = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { initialInput = messages[i].content; break; }
  }
  if (!initialInput) initialInput = "begin";

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
      const total = CONFIG.steps.length;

      try {
        let priorOutput = "";
        for (let i = 0; i < total; i++) {
          const step = CONFIG.steps[i];
          const stepNum = i + 1;
          const isLast = i === total - 1;
          // First step gets the user text; later steps get a synthetic message
          // embedding the prior step's output.
          const userContent =
            i === 0
              ? initialInput
              : \`## Output of previous step:\\n\${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)\`;

          emit("text", { text: \`\\n[step \${stepNum}/\${total}: \${step.name}]\\n\` });
          emitTrace({ kind: "step_start", name: step.name, step: stepNum, total });

          // Only the final step streams text to the client; intermediate steps
          // thread their terminal text into the next step.
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
            model: step.model,
            instructions: step.instructions,
            messages: [{ role: "user", content: userContent }],
            tools: STEP_TOOLS[i],
            maxTokens: step.maxTokens,
            ...(step.thinking ? { thinking: step.thinking } : {}),
            ...(CONFIG.limits ? { limits: CONFIG.limits } : {}),
            emitTrace: trace,
          });
          if (result.failure) {
            emit("error", { message: \`step "\${step.name}": \${result.failure.title}: \${result.failure.detail}\` });
            return;
          }
          emitTrace({ kind: "step_end", name: step.name, step: stepNum, durationMs: platform.now() - startedAt });

          if (isLast) {
            emit("done", { text: acc || result.text, stopReason: lastStop });
          } else {
            priorOutput = result.text;
          }
        }
        // A zero-step workflow can't reach the streaming branch; terminate.
        if (total === 0) emit("done", { text: "", stopReason: "end_turn" });
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
    "Access-Control-Allow-Headers": "Content-Type",
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

function renderWrangler(ir: IrWorkflowV0): string {
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `name = "${safeName}"
main = "worker.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# worker.js imports @crewhaus/worker-runtime and the edge-safe tool packages;
# \`wrangler deploy\` bundles them (run \`npm install\` first). ANTHROPIC_API_KEY
# is a Worker Secret (never committed):
#   wrangler secret put ANTHROPIC_API_KEY
# The studio PWA sets this automatically via the Deploy flow.

[observability]
enabled = true
`;
}

const RUNTIME_DEP_RANGE = "^0.3.0";

function renderPackageJson(ir: IrWorkflowV0, wiring: EdgeToolWiring): string {
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const deps: Record<string, string> = { "@crewhaus/worker-runtime": RUNTIME_DEP_RANGE };
  for (const pkg of wiring.packages) deps[pkg] = RUNTIME_DEP_RANGE;
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
