import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import { type Bundle, type IrWorkflowV0, renderBundleReadme } from "@crewhaus/ir";
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
 * Emit a Cloudflare Worker bundle for a WORKFLOW-target IR. Workflow sibling
 * of `@crewhaus/target-cf-worker-cli`'s `emitCfWorkerCli`: same self-contained
 * Worker shape and `/chat` SSE protocol, but instead of a single agent it runs
 * the IR's steps sequentially server-side. Each step is one single-turn LLM
 * call; the prior step's terminal assistant text is threaded into the next
 * step's user message (mirrors `@crewhaus/target-workflow`'s local runtime).
 *
 * Like the cli emitter, the worker is fully self-contained — it inlines a
 * minimal Anthropic streaming-SSE client so the studio PWA can upload the
 * bundle directly via the Cloudflare API without a build step on the user's
 * device.
 *
 * Bundle contents:
 *   - `worker.js`        — entrypoint, runs as an ES module Worker
 *   - `wrangler.toml`    — deploy descriptor for users who do prefer CLI
 *   - `package.json`     — declares the runtime version stamp
 *
 * M2 emits a tools-free Worker (the cli sibling does the same). Tools,
 * sub-agents, MCP, hooks, and the security fabric port over when we point the
 * emitter at a shared worker runtime instead of inlining the client.
 */
export function emitCfWorkerWorkflow(ir: IrWorkflowV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "workflow") {
    throw new TargetEmitError(
      `emitCfWorkerWorkflow requires target "workflow", got "${ir.target}"`,
    );
  }
  for (const step of ir.steps) {
    // Provider gate — the emitted worker inlines an api.anthropic.com client
    // and POSTs each step's model verbatim, so a non-Anthropic model string
    // would compile cleanly and 502 at runtime. Fail at compile time instead.
    assertAnthropicModel(step.model, `step "${step.name}"`);
    if (step.tools.length > 0) {
      throw new TargetEmitError(
        `cf-worker-workflow does not yet support tools (step "${step.name}"); use the local workflow target`,
      );
    }
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
  // run snippet keys on ir.target ("workflow" → `bun agent.ts`), which is
  // wrong for a Worker bundle, so substitute the wrangler flow.
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

function renderWorker(ir: IrWorkflowV0, allowedOrigins: readonly string[]): string {
  // escapeJsonString === JSON.stringify: each of these is a COMPLETE,
  // quoted JS/JSON string literal already. Do NOT wrap them in extra quotes
  // in the template below, or the output becomes `name: ""my-workflow""` — a
  // syntax error Cloudflare rejects at upload time.
  const name = escapeJsonString(ir.name);
  // Build the steps array literal by hand so each field is escaped exactly
  // once. Same fixed-bug discipline as the cli emitter: escapeJsonString
  // already returns a quoted literal, so the surrounding object literal just
  // interpolates it directly.
  const steps = ir.steps
    .map((step) => {
      const stepName = escapeJsonString(step.name);
      const stepModel = escapeJsonString(step.model);
      const stepInstructions = escapeJsonString(step.instructions);
      return `    { name: ${stepName}, model: ${stepModel}, instructions: ${stepInstructions} }`;
    })
    .join(",\n");
  const allowed = JSON.stringify(allowedOrigins);
  // Loop contract 0.4 (Batch C, item 3) — the /chat SSE gains `trace` events in
  // the TraceEvent JSON vocabulary. `observability.trace: off` suppresses them
  // entirely; every other level (the default "ring", "pretty", "json") emits.
  // Baked as a literal boolean so the generated worker carries no config parse.
  //
  // NOTE: IrWorkflowV0 does not (yet) carry an `observability` field — the Batch
  // C keystone added it only to the agent-loop shapes (IrV0/cli, IrChannelV0,
  // IrManagedV0, IrCrewV0). The structural read below keeps the gate
  // forward-compatible: it defaults to trace-ON today and honours an explicit
  // `trace: off` the moment the IR + workflow lowering carry it (flagged as a
  // cross-package need). See the emitter's return notes.
  const traceEnabled =
    ((ir as { observability?: { trace?: { level?: string } } }).observability?.trace?.level ??
      "ring") !== "off";

  // Item 23 — surface the ignored failure_taxonomy as a generated comment
  // (mirror of target-workflow's mcp_servers note); the Worker calls the
  // Anthropic API with raw fetch, so the recovery engine never runs here.
  const taxonomyWarning =
    ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0
      ? "// note: failure_taxonomy configured but target-cf-worker-workflow does not yet wire it up — it is ignored\n"
      : "";
  return `// Generated by @crewhaus/target-cf-worker-workflow. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-workflow\`.
${taxonomyWarning}
const CONFIG = {
  name: ${name},
  steps: [
${steps}
  ],
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

  // The workflow's initial input is the user's latest message text. Anthropic
  // rejects empty user content with a 400, so fall back to "begin" (matches
  // the local workflow target's stdin-empty placeholder).
  let initialInput = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { initialInput = messages[i].content; break; }
  }
  if (!initialInput) initialInput = "begin";

  // Run steps 1..N-1 as non-streaming calls server-side, threading each
  // step's terminal assistant text into the next. The FINAL step streams via
  // the inlined SSE translator so the chat panel renders tokens live.
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const emit = (event, data) => {
        controller.enqueue(enc.encode(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`));
      };
      // Loop contract 0.4 (Batch C, item 3) — trace frames are gated on
      // CONFIG.trace (observability.trace !== "off"). Each step brackets a
      // step_start/step_end pair and reports its real token usage + an
      // (unpriced) cost accrual; the inlined worker carries no pricing table
      // (that ports over with the shared runtime in M2+), so the studio host
      // reads tokens from model_response.usage and flags the unpriced cost.
      const emitTrace = (event) => { if (CONFIG.trace) emit("trace", event); };
      const costEvent = (model, usage) => ({ kind: "cost_accrual", provider: "anthropic", modelId: model, inputTokens: usage.input, outputTokens: usage.output, cachedReadTokens: usage.cacheRead, cacheCreationTokens: usage.cacheCreate, costUsdMicros: 0, unpriced: true });
      const total = CONFIG.steps.length;
      try {
        let priorOutput = "";
        for (let i = 0; i < total; i++) {
          const step = CONFIG.steps[i];
          const stepNum = i + 1;
          // First step gets the incoming user text; later steps get a
          // synthetic message embedding the prior step's output (mirrors the
          // local workflow target's \`## Output of previous step:\` framing).
          const userContent =
            i === 0
              ? initialInput
              : \`## Output of previous step:\\n\${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)\`;

          // Progress marker so the user sees the workflow advancing. The chat
          // panel appends text deltas, so this renders inline.
          emit("text", { text: \`\\n[step \${stepNum}/\${total}: \${step.name}]\\n\` });
          emitTrace({ kind: "step_start", name: step.name, step: stepNum, total });

          if (i < total - 1) {
            const res = await runStepNonStreaming(env, step, userContent);
            priorOutput = res.text;
            emitTrace({ kind: "model_response", model: step.model, usage: res.usage, stopReason: res.stopReason, durationMs: res.durationMs });
            emitTrace(costEvent(step.model, res.usage));
            emitTrace({ kind: "step_end", name: step.name, step: stepNum, durationMs: res.durationMs });
          } else {
            const final = await runStepStreaming(env, step, userContent, emit);
            emitTrace({ kind: "model_response", model: step.model, usage: final.usage, stopReason: final.stopReason, durationMs: final.durationMs });
            emitTrace(costEvent(step.model, final.usage));
            emitTrace({ kind: "step_end", name: step.name, step: stepNum, durationMs: final.durationMs });
            emit("done", { text: final.text, stopReason: final.stopReason });
          }
        }
        // Defensive: a zero-step workflow can't reach the streaming branch.
        // Emit a terminal done so the client doesn't hang.
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

// Normalize an Anthropic \`usage\` object to the model_response.usage shape.
function extractUsage(u) {
  u = u || {};
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
  };
}

// One non-streaming Anthropic call. Reads the full JSON response and
// concatenates the text blocks into a single string. Returns the text plus
// the real token usage, stop reason, and wall-clock duration so the caller can
// publish the step's model_response / cost_accrual trace frames.
async function runStepNonStreaming(env, step, userContent) {
  const t0 = Date.now();
  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: step.model,
      max_tokens: 4096,
      system: step.instructions,
      stream: false,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(\`upstream \${upstream.status}: \${text.slice(0, 500)}\`);
  }
  const payload = await upstream.json();
  let acc = "";
  if (payload && Array.isArray(payload.content)) {
    for (const block of payload.content) {
      if (block && block.type === "text" && typeof block.text === "string") acc += block.text;
    }
  }
  return {
    text: acc,
    usage: extractUsage(payload && payload.usage),
    stopReason: (payload && payload.stop_reason) || "end_turn",
    durationMs: Date.now() - t0,
  };
}

// One streaming Anthropic call. Translates Anthropic's SSE stream into the
// studio's simpler {text} delta vocabulary (the caller emits the terminal
// \`done\`). Buffers across chunks because events can split mid-line. Returns
// the accumulated text + stop reason for the \`done\` event.
async function runStepStreaming(env, step, userContent, emit) {
  const t0 = Date.now();
  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: step.model,
      max_tokens: 4096,
      system: step.instructions,
      stream: true,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    throw new Error(\`upstream \${upstream.status}: \${text.slice(0, 500)}\`);
  }

  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";
  let acc = "";
  let stopReason = "end_turn";
  // Real token usage from Anthropic's own SSE: message_start seeds the input/
  // cache counts, message_delta carries the final output tally.
  let usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
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
        usage = extractUsage(payload.message.usage);
      } else if (eventName === "content_block_delta" && payload.delta && payload.delta.type === "text_delta") {
        acc += payload.delta.text;
        emit("text", { text: payload.delta.text });
      } else if (eventName === "message_delta") {
        if (payload.delta && payload.delta.stop_reason) stopReason = payload.delta.stop_reason;
        if (payload.usage && typeof payload.usage.output_tokens === "number") usage.output = payload.usage.output_tokens;
      }
    }
  }
  return { text: acc, stopReason, usage, durationMs: Date.now() - t0 };
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

# ANTHROPIC_API_KEY is set as a Worker Secret (never committed):
#   wrangler secret put ANTHROPIC_API_KEY
# The studio PWA sets this automatically via the Deploy flow.

[observability]
enabled = true
`;
}

function renderPackageJson(ir: IrWorkflowV0): string {
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
