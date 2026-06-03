import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import type { Bundle, IrGraphNode, IrGraphV0 } from "@crewhaus/ir";

export type EmitOptions = {
  /**
   * Origins the generated Worker should accept on `/chat`. Defaults to the
   * production studio + local dev. Threading this through compile-time
   * lets the studio PWA bake its own origin in so users can host the PWA
   * anywhere (pages.dev, ngrok, LAN IP) without editing the emitter.
   */
  readonly allowedOrigins?: readonly string[];
};

const DEFAULT_ALLOWED_ORIGINS = ["https://studio.crewhaus.dev", "http://localhost:4322"];

/**
 * Emit a Cloudflare Worker bundle for a `target: "graph"` IR. Graph sibling
 * of `@crewhaus/target-cf-worker-cli` — same self-contained, build-step-free
 * Worker contract, but it executes a chain of single-turn LLM nodes instead
 * of a single agent. The emitted worker inlines a minimal Anthropic
 * streaming-SSE client so the studio PWA can upload the bundle directly via
 * the Cloudflare API without a build step on the user's device.
 *
 * Bundle contents:
 *   - `worker.js`        — entrypoint, runs as an ES module Worker
 *   - `wrangler.toml`    — deploy descriptor for users who do prefer CLI
 *   - `package.json`     — declares the runtime version stamp
 *
 * M2 SCOPE — LINEAR, NON-HITL only. A stateless single Worker cannot persist
 * checkpoints across requests, so the full graph-engine's HITL pause/resume,
 * branching, and time-travel are out of scope here. At emit time we validate
 * the graph (entry + edge refs) and reduce it to a single deterministic
 * linear path by walking from `ir.entry`; anything that is not a single path
 * (a node with >1 outgoing edge, a cycle, or unreachable nodes), any HITL
 * node, and any node with tools are rejected with `TargetEmitError`. Use the
 * local `@crewhaus/target-graph` for branching / HITL.
 */
export function emitCfWorkerGraph(ir: IrGraphV0, opts: EmitOptions = {}): Bundle {
  if (ir.target !== "graph") {
    throw new TargetEmitError(`emitCfWorkerGraph requires target "graph", got "${ir.target}"`);
  }
  const order = linearOrder(ir);
  const allowedOrigins =
    opts.allowedOrigins && opts.allowedOrigins.length > 0
      ? [...opts.allowedOrigins]
      : DEFAULT_ALLOWED_ORIGINS;
  return {
    files: [
      { path: "worker.js", content: renderWorker(ir, order, allowedOrigins) },
      { path: "wrangler.toml", content: renderWrangler(ir) },
      { path: "package.json", content: renderPackageJson(ir) },
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
 * Validate the graph the same way `@crewhaus/target-graph`'s `validateGraph`
 * does (entry must be declared; every edge from/to must reference a declared
 * node), reject the features a stateless Worker cannot honour (HITL, tools),
 * and reduce the graph to a single deterministic linear execution order by
 * walking from `ir.entry` following edges. Throws `TargetEmitError` if the
 * graph is not reducible to a single linear path (a node with >1 outgoing
 * edge, a cycle, or unreachable nodes).
 */
function linearOrder(ir: IrGraphV0): readonly IrGraphNode[] {
  const byName = new Map(ir.nodes.map((n) => [n.name, n] as const));

  // 1. Structural validation (mirrors target-graph's validateGraph).
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

  // 2. Feature gating — a stateless single Worker can't honour these.
  for (const n of ir.nodes) {
    if (n.hitlPrompt !== undefined) {
      throw new TargetEmitError(
        `cf-worker-graph does not support HITL in M2 (node "${n.name}" has hitlPrompt); use the local graph target for HITL`,
      );
    }
    if (n.tools.length > 0) {
      throw new TargetEmitError(
        `cf-worker-graph target does not yet support tools (node "${n.name}": ${n.tools.join(", ")}). Use the local graph target until tools land.`,
      );
    }
  }

  // 3. Outgoing-edge fan-out: at most one edge out of any node (linear).
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

  // 4. Walk the single path from entry; a revisit means a cycle.
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
    // byName.has check above guarantees presence, but keep the type narrow.
    if (node === undefined) {
      throw new TargetEmitError(`edge references unknown node "${cursor}"`);
    }
    order.push(node);
    cursor = next.get(cursor);
  }

  // 5. Every declared node must be on the single path (no unreachable nodes).
  if (seen.size !== ir.nodes.length) {
    const unreachable = ir.nodes.filter((n) => !seen.has(n.name)).map((n) => n.name);
    throw new TargetEmitError(
      `cf-worker-graph supports only linear single-path graphs in M2 (unreachable nodes: ${unreachable.join(", ")}); use the local graph target for branching/HITL`,
    );
  }

  return order;
}

function renderWorker(
  ir: IrGraphV0,
  order: readonly IrGraphNode[],
  allowedOrigins: readonly string[],
): string {
  // escapeJsonString === JSON.stringify: each of these is a COMPLETE,
  // quoted JS/JSON string literal already. Do NOT wrap them in extra quotes
  // in the template below, or the output becomes `name: ""hello-graph""` — a
  // syntax error Cloudflare rejects at upload time.
  const name = escapeJsonString(ir.name);
  const allowed = JSON.stringify(allowedOrigins);
  const nodes = order
    .map(
      (n) =>
        `    { name: ${escapeJsonString(n.name)}, model: ${escapeJsonString(n.model)}, instructions: ${escapeJsonString(n.instructions)} },`,
    )
    .join("\n");

  return `// Generated by @crewhaus/target-cf-worker-graph. Do not edit by hand.
// Regenerate via the studio PWA or \`crewhaus compile --target cf-worker-graph\`.

const CONFIG = {
  name: ${name},
  nodes: [
${nodes}
  ],
  allowedOrigins: ${allowed},
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

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

  // Graph semantics: seed state from the user's latest message, then run each
  // node single-turn in the baked linear order. Each node's system prompt is
  // its instructions; the user turn carries the accumulated state as JSON. The
  // reply text is stored under state[node.name]. All nodes but the last run
  // non-streaming; the last node streams so tokens render live.
  const lastText = lastUserText(messages);
  let state = { input: lastText };
  const nodes = CONFIG.nodes;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      const emit = (event, data) => {
        controller.enqueue(enc.encode(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`));
      };
      try {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const isLast = i === nodes.length - 1;
          emit("text", { text: \`\\n[node \${i + 1}/\${nodes.length}: \${node.name}]\\n\` });
          const userMessage =
            "Upstream state:\\n\`\`\`json\\n" + JSON.stringify(state, null, 2) + "\\n\`\`\`";
          const reqBody = {
            model: node.model,
            max_tokens: MAX_TOKENS,
            system: node.instructions,
            stream: isLast,
            messages: [{ role: "user", content: userMessage }],
          };
          const upstream = await fetch(ANTHROPIC_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": env.ANTHROPIC_API_KEY,
              "anthropic-version": ANTHROPIC_VERSION,
            },
            body: JSON.stringify(reqBody),
          });

          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text().catch(() => "");
            emit("error", {
              message: \`node "\${node.name}" upstream \${upstream.status}: \${text.slice(0, 500)}\`,
            });
            controller.close();
            return;
          }

          if (!isLast) {
            // Non-streaming intermediate node: read full JSON, join text blocks.
            const payload = await upstream.json();
            const text = joinTextBlocks(payload);
            state = { ...state, [node.name]: text };
            continue;
          }

          // Last node: translate Anthropic's SSE into the studio's simpler
          // {text, done, error} vocabulary. Buffers across chunks because
          // events can split mid-line.
          const reader = upstream.body.getReader();
          let buffer = "";
          let acc = "";
          let stopReason = "end_turn";
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
              let p;
              try { p = JSON.parse(data); } catch { continue; }
              if (eventName === "content_block_delta" && p.delta && p.delta.type === "text_delta") {
                acc += p.delta.text;
                emit("text", { text: p.delta.text });
              } else if (eventName === "message_delta" && p.delta && p.delta.stop_reason) {
                stopReason = p.delta.stop_reason;
              }
            }
          }
          state = { ...state, [node.name]: acc };
          emit("done", { text: acc, stopReason });
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

function joinTextBlocks(payload) {
  if (!payload || !Array.isArray(payload.content)) return "";
  let out = "";
  for (const block of payload.content) {
    if (block && block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
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

function renderWrangler(ir: IrGraphV0): string {
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

function renderPackageJson(ir: IrGraphV0): string {
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
