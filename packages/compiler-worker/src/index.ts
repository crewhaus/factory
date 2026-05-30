import { type Bundle, SpecParseError, compile, lower, parseSpec } from "@crewhaus/compiler";
import { emitCfWorkerCli } from "@crewhaus/target-cf-worker-cli";
import { emitCfWorkerGraph } from "@crewhaus/target-cf-worker-graph";
import { emitCfWorkerWorkflow } from "@crewhaus/target-cf-worker-workflow";
import { handleProviderProxy } from "./proxy";

/**
 * compiler-worker — stateless CF Worker that exposes the CrewHaus compiler
 * pipeline over HTTP so the studio PWA can compile specs without a local
 * Bun runtime.
 *
 * Surface:
 *   POST /compile  { yaml: string, applyIrPasses?: boolean }
 *      → 200 { bundle: Bundle }
 *      → 400 { error: { code: "PARSE" | "COMPILE", message, path? } }
 *
 *   POST /validate { yaml: string }
 *      → 200 { ok: true }
 *      → 200 { ok: false, errors: [{ message, path? }] }
 *
 *   GET  /health   → 200 { ok: true, version }
 *
 *   ALL  /cf/*     → reverse-proxy to api.cloudflare.com. The CF API sends
 *      no CORS headers, so the studio PWA can't call it from the browser;
 *      this Worker (running on the user's own CF account) relays the call
 *      server-side. The caller's CF token rides in the Authorization header.
 *
 *   ALL  /proxy    → host-allowlisted reverse-proxy to {render,fly,railway,
 *      heroku} APIs (host allowlist in proxy.ts; not an open proxy). Same
 *      CORS rationale as /cf — those provider APIs aren't browser-callable.
 *
 * No state, no auth — CORS-locked to the studio origin. Compile time is
 * bounded by CF Worker CPU limit; we benchmark large specs in M0 to
 * ensure they fit comfortably.
 */

type Env = {
  readonly ALLOWED_ORIGINS: string;
  readonly MAX_BODY_BYTES?: string;
};

const VERSION = "0.0.0";
const DEFAULT_MAX_BODY = 262144; // 256 KB

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const cors = buildCorsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, version: VERSION }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/compile") {
        return await handleCompile(request, env, cors);
      }
      if (request.method === "POST" && url.pathname === "/validate") {
        return await handleValidate(request, env, cors);
      }
      if (url.pathname === "/cf" || url.pathname.startsWith("/cf/")) {
        return await handleCfProxy(request, cors, url);
      }
      if (url.pathname === "/proxy") {
        return await handleProviderProxy(request, cors, url);
      }
      return jsonResponse({ error: { code: "NOT_FOUND", message: "no route" } }, 404, cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(
        { error: { code: "INTERNAL", message: redactSecrets(message) } },
        500,
        cors,
      );
    }
  },
};

type CompileBody = {
  readonly yaml?: unknown;
  readonly applyIrPasses?: unknown;
  readonly emitAs?: unknown;
  readonly allowedOrigins?: unknown;
};

async function handleCompile(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body = await readJsonBody<CompileBody>(request, env);
  if (typeof body.yaml !== "string") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "body.yaml must be a string" } },
      400,
      cors,
    );
  }
  const applyIrPasses = body.applyIrPasses === true;
  const emitAs: "local" | "cf-worker" = body.emitAs === "cf-worker" ? "cf-worker" : "local";

  try {
    let bundle: Bundle;
    if (emitAs === "cf-worker") {
      const spec = parseSpec(body.yaml);
      const ir = lower(spec);
      const allowedOrigins = Array.isArray(body.allowedOrigins)
        ? body.allowedOrigins.filter((o): o is string => typeof o === "string")
        : undefined;
      const opts = allowedOrigins ? { allowedOrigins } : {};
      // `ir` is the IrNode union; the per-case narrowing on the `target`
      // discriminant hands each emitter its typed variant (Pillar 1: new
      // target shapes are driven from the IR, not re-derived in the target).
      switch (ir.target) {
        case "cli":
          bundle = emitCfWorkerCli(ir, opts);
          break;
        case "workflow":
          bundle = emitCfWorkerWorkflow(ir, opts);
          break;
        case "graph":
          bundle = emitCfWorkerGraph(ir, opts);
          break;
        default:
          return jsonResponse(
            {
              error: {
                code: "UNSUPPORTED_TARGET",
                message: `cf-worker emit supports target=cli|workflow|graph, got ${ir.target}`,
              },
            },
            400,
            cors,
          );
      }
    } else {
      bundle = compile(body.yaml, { applyIrPasses });
    }
    return jsonResponse({ bundle }, 200, cors);
  } catch (err) {
    if (err instanceof SpecParseError) {
      return jsonResponse(
        { error: { code: "PARSE", message: redactSecrets(err.message) } },
        400,
        cors,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: { code: "COMPILE", message: redactSecrets(message) } }, 400, cors);
  }
}

/**
 * Reverse-proxy for the Cloudflare API. The studio PWA cannot call
 * api.cloudflare.com directly: that API returns no CORS headers, so the
 * browser blocks the request (unlike api.github.com, which is CORS-enabled,
 * and so the GitHub PAT flow needs no proxy). This Worker runs on the user's
 * own Cloudflare account, so it relays the call server-side — where CORS
 * does not apply — and echoes the studio's CORS headers back to the browser.
 *
 * The user's CF API token rides in the Authorization header and is forwarded
 * verbatim to Cloudflare; it is never stored. The upstream base is hardcoded
 * to api.cloudflare.com, so this cannot be used as an open proxy (no SSRF).
 */
async function handleCfProxy(request: Request, cors: HeadersInit, url: URL): Promise<Response> {
  const upstreamPath = url.pathname.slice("/cf".length); // "/accounts/…"
  const upstreamUrl = `https://api.cloudflare.com/client/v4${upstreamPath}${url.search}`;

  const headers = new Headers();
  const auth = request.headers.get("Authorization");
  if (auth) headers.set("Authorization", auth);
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const upstream = await fetch(upstreamUrl, { method: request.method, headers, body });
  const respBody = await upstream.arrayBuffer();
  return new Response(respBody, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      ...cors,
    },
  });
}

type ValidateBody = { readonly yaml?: unknown };

async function handleValidate(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body = await readJsonBody<ValidateBody>(request, env);
  if (typeof body.yaml !== "string") {
    return jsonResponse(
      { error: { code: "BAD_REQUEST", message: "body.yaml must be a string" } },
      400,
      cors,
    );
  }
  try {
    parseSpec(body.yaml);
    return jsonResponse({ ok: true }, 200, cors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, errors: [{ message: redactSecrets(message) }] }, 200, cors);
  }
}

async function readJsonBody<T>(request: Request, env: Env): Promise<T> {
  const max = Number(env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > max) {
    throw new Error(`request body exceeds max ${max} bytes`);
  }
  const text = await request.text();
  if (text.length > max) {
    throw new Error(`request body exceeds max ${max} bytes`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

function buildCorsHeaders(origin: string | null, allowed: string): HeadersInit {
  const allowedList = allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = origin !== null && allowedList.includes(origin) ? origin : (allowedList[0] ?? "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    // `Accept` is needed because the Heroku provider client sends a versioned
    // `Accept: application/vnd.heroku+json; version=3` header on preflighted
    // requests through /proxy; without it the browser blocks the call.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors,
    },
  });
}

/**
 * Redact patterns that look like API keys before reflecting an error message
 * to the client. The compiler shouldn't see real keys (they're env refs in
 * IR), but defense-in-depth.
 */
function redactSecrets(message: string): string {
  return message
    .replace(/sk-ant-[A-Za-z0-9_\-]{20,}/g, "sk-ant-REDACTED")
    .replace(/sk-[A-Za-z0-9_\-]{20,}/g, "sk-REDACTED")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_REDACTED")
    .replace(/gho_[A-Za-z0-9]{20,}/g, "gho_REDACTED");
}
