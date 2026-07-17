import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import { type Bundle, type IrV0, renderBundleReadme } from "@crewhaus/ir";
import { parseModelString } from "@crewhaus/model-router";

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
 * `@crewhaus/target-cli`'s `emitCli`: same IR shape in, different
 * generated artifacts out. The emitted worker is fully self-contained —
 * it inlines a minimal Anthropic streaming-SSE client so the studio PWA
 * can upload the bundle directly via the Cloudflare API without a build
 * step on the user's device.
 *
 * Bundle contents:
 *   - `worker.js`        — entrypoint, runs as an ES module Worker
 *   - `wrangler.toml`    — deploy descriptor for users who do prefer CLI
 *   - `package.json`     — declares the runtime version stamp
 *
 * M0 emits a tools-free Worker. Tools, sub-agents, MCP, hooks, and the
 * security fabric port over in M2+ when we point the emitter at a shared
 * worker runtime instead of inlining the minimal client.
 */
export function emitCfWorkerCli(ir: IrV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "cli") {
    throw new TargetEmitError(`emitCfWorkerCli requires target "cli", got "${ir.target}"`);
  }
  // Provider gate — the emitted worker inlines an api.anthropic.com client
  // and POSTs CONFIG.model verbatim, so a non-Anthropic model string would
  // compile cleanly and 502 at runtime. Fail at compile time instead.
  assertAnthropicModel(ir.agent.model, "agent");
  if (ir.tools.length > 0) {
    throw new TargetEmitError(
      `cf-worker-cli target does not yet support tools (got: ${ir.tools.join(", ")}). Use the local cli target until M2.`,
    );
  }
  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? [...opts.allowedOrigins]
      : DEFAULT_ALLOWED_ORIGINS;
  const files = [
    { path: "worker.js", content: renderWorker(ir, allowedOrigins) },
    { path: "wrangler.toml", content: renderWrangler(ir) },
    { path: "package.json", content: renderPackageJson(ir) },
  ];
  // Item 42 — generated bundle README; default ON. The default per-target
  // run snippet keys on ir.target ("cli" → `bun agent.ts`), which is wrong
  // for a Worker bundle, so substitute the wrangler flow.
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
      "wrangler secret put ANTHROPIC_API_KEY   # one-time Worker secret",
      "wrangler deploy",
      "```",
    ].join("\n"),
  },
  // A deployed Worker has no local `.crewhaus/` workspace.
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
 * provider (openai/, gemini/, bedrock/, local/…) — the inlined worker
 * client only speaks the Anthropic Messages API.
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

function renderWorker(ir: IrV0, allowedOrigins: readonly string[]): string {
  // escapeJsonString === JSON.stringify: each of these is a COMPLETE,
  // quoted JS/JSON string literal already. Do NOT wrap them in extra quotes
  // in the template below, or the output becomes `name: ""hello-cli""` — a
  // syntax error Cloudflare rejects at upload time.
  const name = escapeJsonString(ir.name);
  const model = escapeJsonString(ir.agent.model);
  const instructions = escapeJsonString(ir.agent.instructions);
  const allowed = JSON.stringify(allowedOrigins);
  // Loop contract 0.4 (Batch C, item 3) — the /chat SSE gains `trace` events in
  // the TraceEvent JSON vocabulary. `observability.trace: off` suppresses them
  // entirely; every other level (the default "ring", "pretty", "json") emits.
  // Baked as a literal boolean so the generated worker carries no config parse.
  const traceEnabled = (ir.observability?.trace?.level ?? "ring") !== "off";

  // Item 23 — surface the ignored failure_taxonomy as a generated comment
  // (mirror of target-workflow's mcp_servers note); the Worker calls the
  // Anthropic API with raw fetch, so the recovery engine never runs here.
  const taxonomyWarning =
    ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? "// note: failure_taxonomy configured but target-cf-worker-cli does not yet wire it up — it is ignored\n"
      : "";
  return `// Generated by @crewhaus/target-cf-worker-cli. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-cli\`.
${taxonomyWarning}
const CONFIG = {
  name: ${name},
  model: ${model},
  instructions: ${instructions},
  allowedOrigins: ${allowed},
  trace: ${traceEnabled},
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

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

  const t0 = Date.now();
  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: CONFIG.model,
      max_tokens: 4096,
      system: CONFIG.instructions,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return json({ error: { code: "UPSTREAM", status: upstream.status, message: text.slice(0, 500) } }, 502, cors);
  }

  // Translate Anthropic's SSE stream into the studio's simpler
  // {text, done, error} event vocabulary. Buffers across chunks because
  // events can split mid-line.
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const emit = (event, data) => {
        controller.enqueue(enc.encode(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`));
      };
      // Loop contract 0.4 (Batch C, item 3) — trace frames are gated on
      // CONFIG.trace (observability.trace !== "off"). No-op when disabled.
      const emitTrace = (event) => { if (CONFIG.trace) emit("trace", event); };
      const reader = upstream.body.getReader();
      let buffer = "";
      let acc = "";
      let stopReason = "end_turn";
      // Real token usage, harvested from Anthropic's own SSE: message_start
      // seeds the input/cache counts, message_delta carries the final output.
      let usageIn = 0, usageOut = 0, cacheRead = 0, cacheCreate = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf("\\n\\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = "message";
            let data = "";
            for (const line of raw.split("\\n")) {
              if (line.startsWith("event: ")) eventName = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (!data || data === "[DONE]") continue;
            let payload;
            try { payload = JSON.parse(data); } catch { continue; }
            if (eventName === "message_start" && payload.message && payload.message.usage) {
              const u = payload.message.usage;
              usageIn = u.input_tokens || 0;
              usageOut = u.output_tokens || 0;
              cacheRead = u.cache_read_input_tokens || 0;
              cacheCreate = u.cache_creation_input_tokens || 0;
            } else if (eventName === "content_block_delta" && payload.delta && payload.delta.type === "text_delta") {
              acc += payload.delta.text;
              emit("text", { text: payload.delta.text });
            } else if (eventName === "message_delta") {
              if (payload.delta && payload.delta.stop_reason) stopReason = payload.delta.stop_reason;
              if (payload.usage && typeof payload.usage.output_tokens === "number") usageOut = payload.usage.output_tokens;
            }
          }
        }
        // usage + cost, emitted on done. Tokens are real; the inlined worker
        // carries no pricing table (that ports over with the shared runtime in
        // M2+), so cost_accrual is published \`unpriced\` — the studio host reads
        // tokens from model_response.usage and flags the unpriced cost.
        emitTrace({ kind: "model_response", model: CONFIG.model, usage: { input: usageIn, output: usageOut, cacheRead, cacheCreate }, stopReason, durationMs: Date.now() - t0 });
        emitTrace({ kind: "cost_accrual", provider: "anthropic", modelId: CONFIG.model, inputTokens: usageIn, outputTokens: usageOut, cachedReadTokens: cacheRead, cacheCreationTokens: cacheCreate, costUsdMicros: 0, unpriced: true });
        emit("done", { text: acc, stopReason });
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

function renderWrangler(ir: IrV0): string {
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `name = "${safeName}"
main = "worker.js"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# ANTHROPIC_API_KEY is set as a Worker Secret (never committed):
#   wrangler secret put ANTHROPIC_API_KEY
# The studio PWA sets this automatically via the Deploy flow.

[observability]
enabled = true
`;
}

function renderPackageJson(ir: IrV0): string {
  // Sanitize like the wrangler name. A raw ir.name breaks out of the JSON
  // string (this manifest is reachable from the hosted compiler-worker HTTP
  // endpoint), allowing dependency/script injection into package.json (#148).
  const safeName = ir.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `{
  "name": "${safeName}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev --local"
  }
}
`;
}
